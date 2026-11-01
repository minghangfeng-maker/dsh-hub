import { createHash, createHmac, randomBytes } from 'node:crypto'
import { get, request, type IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ATTACH_COLLABORATORS, type InternalInstanceService } from '../src/modules/instances/service.js'
import { containerNameFor, imageForVersion, FALLBACK_DSH_VERSION } from '../src/modules/instances/spec.js'
import {
  createTestApp,
  createUser,
  loginAs,
  type TestApp,
  type TestSession,
  type TestUser,
} from './helpers.js'

const IMAGE = imageForVersion(FALLBACK_DSH_VERSION)

interface ProxySetup {
  ctx: TestApp
  base: string
  port: number
  owner: TestUser
  ownerSession: TestSession
  other: TestUser
  otherSession: TestSession
  instances: InternalInstanceService
  driver: NonNullable<TestApp['driver']>
  slug: string
  username: string
  name: string
}

const contexts: TestApp[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close()
})

async function setup(): Promise<ProxySetup> {
  const ctx = await createTestApp()
  contexts.push(ctx)
  const driver = ctx.driver!
  driver.addImage(IMAGE)
  const owner = await createUser(ctx.app)
  const other = await createUser(ctx.app)
  const instances = ctx.app.deps.services.instances as InternalInstanceService
  await instances.provision(owner.id)
  await instances.provision(other.id)
  await instances.ensureRunning(owner.id)
  const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' })
  const url = new URL(address)
  return {
    ctx,
    base: address,
    port: Number(url.port),
    owner,
    ownerSession: loginAs(ctx.app, owner),
    other,
    otherSession: loginAs(ctx.app, other),
    instances,
    driver,
    slug: owner.slug,
    username: owner.username,
    name: containerNameFor(owner.slug),
  }
}

// ── 极简 HTTP 客户端（不用 fetch：避免 shell 里的代理环境变量干扰） ───────────

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.end(opts.body)
    else req.end()
  })
}

/** 逐块收集 SSE：记录每个 data 事件到达的时刻，用来断言「不缓冲」 */
function collectSse(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string; dataAt: number[]; firstChunkAt: number; endAt: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let firstChunkAt = 0
    const dataAt: number[] = []
    const req = get(url, { headers }, (res) => {
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        if (firstChunkAt === 0) firstChunkAt = Date.now() - started
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          if (frame.includes('event: tick')) dataAt.push(Date.now())
          index = buffer.indexOf('\n\n')
        }
      })
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          dataAt,
          firstChunkAt,
          endAt: Date.now() - started,
        }),
      )
    })
    req.on('error', reject)
  })
}

// ── 极简 WebSocket 客户端（Node 内置 WebSocket 不能带 cookie 头） ─────────────

interface WsClient {
  send(text: string): void
  nextMessage(): Promise<string>
  close(): void
  statusCode: number
}

function wsConnect(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
  const target = new URL(url)
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const req = request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        ...headers,
      },
    })
    req.on('response', (res) => {
      // 服务端拒绝升级：把状态码交回测试
      res.resume()
      resolve({
        statusCode: res.statusCode ?? 0,
        send: () => undefined,
        nextMessage: () => Promise.reject(new Error('未升级为 WebSocket')),
        close: () => req.destroy(),
      })
    })
    req.on('upgrade', (res, socket: Socket) => {
      const messages: string[] = []
      const waiters: ((text: string) => void)[] = []
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const frame = decodeServerFrame(buffer)
          if (!frame) break
          buffer = buffer.subarray(frame.size)
          if (frame.opcode === 0x1) {
            const text = frame.payload.toString('utf8')
            const waiter = waiters.shift()
            if (waiter) waiter(text)
            else messages.push(text)
          }
        }
      })
      resolve({
        statusCode: res.statusCode ?? 101,
        send: (text: string) => socket.write(encodeClientFrame(text)),
        nextMessage: () =>
          new Promise<string>((resolveMessage, rejectMessage) => {
            const existing = messages.shift()
            if (existing !== undefined) {
              resolveMessage(existing)
              return
            }
            const timer = setTimeout(() => rejectMessage(new Error('等待 WS 消息超时')), 3000)
            waiters.push((text) => {
              clearTimeout(timer)
              resolveMessage(text)
            })
          }),
        close: () => {
          socket.write(encodeClientFrame('', 0x8))
          socket.end()
        },
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function decodeServerFrame(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null
  const opcode = (buffer[0] ?? 0) & 0x0f
  let length = (buffer[1] ?? 0) & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (buffer.length < offset + length) return null
  return { opcode, payload: buffer.subarray(offset, offset + length), size: offset + length }
}

function encodeClientFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4)
  header[0] = 0x80 | opcode
  if (payload.length < 126) header[1] = 0x80 | payload.length
  else {
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  }
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return Buffer.concat([header, mask, masked])
}

// ── 测试 ────────────────────────────────────────────────────────────────────

describe('规范地址 /dsh/<username>/ 的鉴权（02 §7、WP16）', () => {
  it('未登录 → 302 到 /login?next=/dsh/<username>/…（不返回任何 DSH 内容）', async () => {
    const { base, username } = await setup()
    const res = await rawRequest(`${base}/dsh/${username}/`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(`/dsh/${username}/`)}`)
    expect(res.body).toBe('')
    // 子路径与查询串原样带进 next
    const deep = await rawRequest(`${base}/dsh/${username}/api/echo?x=1`)
    expect(deep.headers.location).toBe(`/login?next=${encodeURIComponent(`/dsh/${username}/api/echo?x=1`)}`)
  })

  it('非主人 → 404，且不泄漏任何上游内容', async () => {
    const { base, username, otherSession, driver, name } = await setup()
    driver.clearRequests(name)
    const res = await rawRequest(`${base}/dsh/${username}/api/echo`, {
      headers: { cookie: otherSession.cookie },
    })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'NOT_FOUND' } })
    // 越权请求根本没有打到容器
    expect(driver.getRequests(name)).toHaveLength(0)
  })

  it('用户名不存在 → 404，且响应体与「不是主人」逐字节一致（不暴露是否存在）', async () => {
    const { base, username, ownerSession, otherSession } = await setup()
    const missing = await rawRequest(`${base}/dsh/nobodyhere/`, { headers: { cookie: ownerSession.cookie } })
    const intruder = await rawRequest(`${base}/dsh/${username}/`, {
      headers: { cookie: otherSession.cookie },
    })
    expect(missing.status).toBe(404)
    expect(intruder.status).toBe(404)
    expect(missing.body).toBe(intruder.body)
    expect(missing.headers['content-type']).toBe(intruder.headers['content-type'])
  })

  describe('管理员进入别人的实例（决定：管理员可进，必须留审计）', () => {
    async function withAdmin() {
      const env = await setup()
      const admin = await createUser(env.ctx.app, { role: 'admin' })
      return { ...env, admin, adminSession: loginAs(env.ctx.app, admin) }
    }

    function adminOpenRows(env: ProxySetup) {
      return env.ctx.app.deps.db.all<{
        actor_id: number
        target_type: string
        target_id: string
        detail_json: string
      }>(
        `SELECT actor_id, target_type, target_id, detail_json FROM audit_logs
          WHERE action = 'instance.admin.open' ORDER BY id`,
      )
    }

    it('运行中的实例：透传给管理员，用的是主人的 DSH cookie；审计只记一条（窗口内合并）', async () => {
      const env = await withAdmin()
      const { base, username, adminSession, admin, owner, driver, name } = env
      driver.clearRequests(name)
      const first = await rawRequest(`${base}/dsh/${username}/api/echo`, {
        headers: { cookie: adminSession.cookie },
      })
      const second = await rawRequest(`${base}/dsh/${username}/api/echo?again=1`, {
        headers: { cookie: adminSession.cookie },
      })
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(driver.getRequests(name)).toHaveLength(2)

      const rows = adminOpenRows(env)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        actor_id: admin.id,
        target_type: 'user',
        target_id: String(owner.id),
      })
      expect(JSON.parse(rows[0]!.detail_json)).toEqual({ username, channel: 'http' })
    })

    it('本人访问自己的实例不写这条审计；普通用户进管理员的实例仍是 404', async () => {
      const env = await withAdmin()
      const { base, username, ownerSession, admin, otherSession } = env
      const own = await rawRequest(`${base}/dsh/${username}/api/echo`, {
        headers: { cookie: ownerSession.cookie },
      })
      expect(own.status).toBe(200)
      expect(adminOpenRows(env)).toHaveLength(0)

      const intruder = await rawRequest(`${base}/dsh/${admin.username}/`, {
        headers: { cookie: otherSession.cookie },
      })
      expect(intruder.status).toBe(404)
    })

    it('用户名不存在 / 已被删除 → 管理员也是 404（不暴露存在性）', async () => {
      const env = await withAdmin()
      const { base, adminSession, other, ctx } = env
      const missing = await rawRequest(`${base}/dsh/nobodyhere/`, {
        headers: { cookie: adminSession.cookie },
      })
      expect(missing.status).toBe(404)

      ctx.app.deps.db.run(
        'UPDATE users SET deleted_at = ? WHERE id = ?',
        ctx.app.deps.clock.nowIso(),
        other.id,
      )
      const deleted = await rawRequest(`${base}/dsh/${other.username}/`, {
        headers: { cookie: adminSession.cookie },
      })
      expect(deleted.status).toBe(404)
      expect(deleted.body).toBe(missing.body)
    })

    it('实例没在跑：给管理员专用唤醒页（按目标用户启动，不碰「我的实例」，不自动启动）', async () => {
      const env = await withAdmin()
      const { base, adminSession, other, ctx } = env
      const res = await rawRequest(`${base}/dsh/${other.username}/`, {
        headers: { cookie: adminSession.cookie, accept: 'text/html' },
      })
      expect(res.status).toBe(200)
      expect(res.headers['x-hub-instance']).toBe('waking')
      expect(res.body).toContain(`/api/admin/instances/' + C.userId + '/start`)
      expect(res.body).toContain(`"userId":${String(other.id)}`)
      expect(res.body).not.toContain('/api/me/instance')
      // 页面本身不会替别人启动实例：状态仍是没启动
      expect(ctx.app.deps.services.instances.currentStatus(other.id)).not.toBe('running')
    })
  })

  it('用户名大小写/形状不合法直接 404（任务书 §4：不做 301）', async () => {
    const { base, ownerSession } = await setup()
    for (const path of ['/dsh/User1/', '/dsh/User1/x', '/dsh/ab/', '/dsh/1user/']) {
      const res = await rawRequest(`${base}${path}`, { headers: { cookie: ownerSession.cookie } })
      expect(res.status, path).toBe(404)
    }
  })

  it('GET /dsh/<username>（无斜杠）→ 301 到带斜杠的地址，保留查询串（WP0b S2）', async () => {
    const { base, username, ownerSession } = await setup()
    const res = await rawRequest(`${base}/dsh/${username}?a=1`, { headers: { cookie: ownerSession.cookie } })
    expect(res.status).toBe(301)
    expect(res.headers.location).toBe(`/dsh/${username}/?a=1`)
  })
})

describe('旧地址 /u/<slug>/ → 301 到 /dsh/<username>/（任务书 §2）', () => {
  it('主人访问根路径 → 301（无斜杠补斜杠）', async () => {
    const { base, slug, username, ownerSession } = await setup()
    const res = await rawRequest(`${base}/u/${slug}`, { headers: { cookie: ownerSession.cookie } })
    expect(res.status).toBe(301)
    expect(res.headers.location).toBe(`/dsh/${username}/`)
  })

  it('主人访问子路径 → 301，子路径与查询串都保留', async () => {
    const { base, slug, username, ownerSession } = await setup()
    const res = await rawRequest(`${base}/u/${slug}/api/echo?x=1&y=2`, {
      headers: { cookie: ownerSession.cookie },
    })
    expect(res.status).toBe(301)
    expect(res.headers.location).toBe(`/dsh/${username}/api/echo?x=1&y=2`)
    const query = await rawRequest(`${base}/u/${slug}?a=1`, { headers: { cookie: ownerSession.cookie } })
    expect(query.headers.location).toBe(`/dsh/${username}/?a=1`)
  })

  it('未登录 → 302 登录（存在与不存在的 slug 响应一致，不暴露 slug 是否存在）', async () => {
    const { base, slug } = await setup()
    const res = await rawRequest(`${base}/u/${slug}/api/echo?x=1`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(`/u/${slug}/api/echo?x=1`)}`)
    const unknown = await rawRequest(`${base}/u/u0000000/`)
    expect(unknown.status).toBe(302)
    expect(unknown.headers.location).toBe(`/login?next=${encodeURIComponent('/u/u0000000/')}`)
  })

  it('非主人 → 404（与未登录、未知 slug 同响应）', async () => {
    const { base, slug, otherSession } = await setup()
    const res = await rawRequest(`${base}/u/${slug}/api/echo`, { headers: { cookie: otherSession.cookie } })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('未知 slug（形状合法）→ 404', async () => {
    const { base, ownerSession } = await setup()
    const res = await rawRequest(`${base}/u/u0000000/`, { headers: { cookie: ownerSession.cookie } })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })
})

describe('HTTP 代理（05 §5.3 §5.6 §5.7）', () => {
  it('Host/Origin/Referer/cookie 改写 + x-forwarded-*，并注入现签 DSH cookie', async () => {
    const { base, username, ownerSession, driver, name, ctx } = await setup()
    const res = await rawRequest(`${base}/dsh/${username}/api/echo`, {
      headers: {
        cookie: ownerSession.cookie,
        host: 'hub.example',
        origin: 'https://hub.example',
        referer: `https://hub.example/dsh/${username}/chat`,
        accept: 'application/json',
      },
    })
    expect(res.status).toBe(200)
    const echoed = JSON.parse(res.body) as {
      host: string
      origin: string
      cookie: string
      referer: string
      forwardedFor: string
      forwardedProto: string
    }
    expect(echoed.host).toBe('127.0.0.1:3000')
    expect(echoed.origin).toBe('http://127.0.0.1:3000')
    expect(echoed.referer).toBe(`http://127.0.0.1:3000/dsh/${username}/chat`)
    expect(echoed.cookie).not.toContain('hub_sid')
    expect(echoed.forwardedFor).toContain('127.0.0.1')
    expect(echoed.forwardedProto).toBe('http')

    // 注入的 cookie 必须是用「容器里那把 browser-session 密钥」现签出来的
    const match = /(dsh-auth-[A-Za-z0-9_-]+)=v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/u.exec(echoed.cookie)
    expect(match).not.toBeNull()
    const [, cookieName, body, signature] = match!
    const expectedName = `dsh-auth-${createHash('sha256').update('127.0.0.1:3000').digest('base64url')}`
    expect(cookieName).toBe(expectedName)
    const secret = Buffer.from(driver.getSecret(name) ?? '', 'base64url')
    expect(signature).toBe(createHmac('sha256', secret).update(body!).digest('base64url'))
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as {
      authority: string
      version: number
    }
    expect(payload).toMatchObject({ authority: '127.0.0.1:3000', version: 1 })

    // 请求记录里也看不到 Hub 的会话 cookie
    const recorded = driver.getRequests(name).at(-1)
    expect(recorded?.cookie).not.toContain('hub_sid')
    void ctx
  })

  it('HTML 文档注入 ownsHost 与返回按钮，并把 accept-encoding 改成 identity', async () => {
    const { base, username, ownerSession, driver, name } = await setup()
    driver.clearRequests(name)
    const res = await rawRequest(`${base}/dsh/${username}/`, {
      headers: {
        cookie: ownerSession.cookie,
        accept: 'text/html,application/xhtml+xml',
        'accept-encoding': 'gzip, br',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['referrer-policy']).toBe('same-origin')
    expect(res.body).toContain('__DSH_BOOT__')
    expect(res.body).toContain('ownsHost:true')
    expect(res.body).toContain('dshhub-back')
    // 上游被要求不要压缩（否则没法注入）
    expect(driver.getRequests(name).at(-1)?.acceptEncoding).toBe('identity')
    // content-length 被重算成注入后的长度
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body))
  })

  it('非 HTML 请求不注入（JSON 原样透传）', async () => {
    const { base, username, ownerSession } = await setup()
    const res = await rawRequest(`${base}/dsh/${username}/`, {
      headers: { cookie: ownerSession.cookie, accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('__DSH_BOOT__')
    expect(res.body).not.toContain('ownsHost')
    expect(res.body).not.toContain('dshhub-back')
  })

  it('丢弃上游 dsh-auth-* 的 Set-Cookie，其它 cookie 的 Path 改到 /dsh/<username>/ 并去 Domain', async () => {
    const { base, username, ownerSession } = await setup()
    const res = await rawRequest(`${base}/dsh/${username}/api/set-cookie`, {
      headers: { cookie: ownerSession.cookie },
    })
    expect(res.status).toBe(200)
    const cookies = res.headers['set-cookie'] ?? []
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toContain('upstream_pref=1')
    expect(cookies[0]).toContain(`Path=/dsh/${username}/`)
    expect(cookies[0]).not.toContain('Domain')
    expect(cookies.join(';')).not.toContain('dsh-auth-')
  })

  it('SSE 不缓冲：3 帧逐块到达，且首块远早于结束', async () => {
    const { base, username, ownerSession } = await setup()
    const sse = await collectSse(`${base}/dsh/${username}/plugins/events`, {
      cookie: ownerSession.cookie,
      accept: 'text/event-stream',
    })
    expect(sse.status).toBe(200)
    expect(sse.contentType).toContain('text/event-stream')
    expect(sse.dataAt).toHaveLength(3)
    expect(sse.firstChunkAt).toBeLessThan(sse.endAt - 20)
    expect((sse.dataAt[2] ?? 0) - (sse.dataAt[0] ?? 0)).toBeGreaterThan(30)
  })

  it('容器未运行 → 唤醒页（代理本身不触发启动，02 §7.6）', async () => {
    const { base, slug, username, ownerSession, instances, driver, owner } = await setup()
    await instances.stop(owner.id, { reason: 'user' })
    const res = await rawRequest(`${base}/dsh/${username}/`, {
      headers: { cookie: ownerSession.cookie, accept: 'text/html' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['x-hub-instance']).toBe('waking')
    expect(res.body).toContain('唤醒')
    expect(res.body).toContain('/api/me/instance/start')
    // 兜底页的就绪跳转用规范地址里的用户名（/dsh/<username>/），不再拼 slug
    expect(res.body).toContain(`/dsh/${username}/`)
    // 依然是停止状态：代理没有偷偷拉起容器
    expect(driver.getContainer(containerNameFor(slug))?.state).toBe('exited')
    expect(instances.currentStatus(owner.id)).toBe('stopped')
  })
})

describe('WebSocket 代理（05 §5.4）', () => {
  it('回显：Host/cookie 改写后双向 pipe', async () => {
    const { base, username, ownerSession, port, driver, name } = await setup()
    const ws = await wsConnect(`ws://127.0.0.1:${port}/dsh/${username}/api/remote.mux`, {
      cookie: ownerSession.cookie,
    })
    expect(ws.statusCode).toBe(101)
    ws.send('hello-hub')
    const message = JSON.parse(await ws.nextMessage()) as { echo: string; url: string }
    expect(message).toEqual({ echo: 'hello-hub', url: '/api/remote.mux' })
    ws.close()
    void base
    expect(driver.getRequests(name).some((item) => item.url === '/api/remote.mux')).toBe(true)
  })

  it('未登录 401、非主人/用户名不存在 404', async () => {
    const { username, port, otherSession } = await setup()
    const anonymous = await wsConnect(`ws://127.0.0.1:${port}/dsh/${username}/api/remote.mux`)
    expect(anonymous.statusCode).toBe(401)
    const intruder = await wsConnect(`ws://127.0.0.1:${port}/dsh/${username}/api/remote.mux`, {
      cookie: otherSession.cookie,
    })
    expect(intruder.statusCode).toBe(404)
    const missing = await wsConnect(`ws://127.0.0.1:${port}/dsh/nobodyhere/api/remote.mux`, {
      cookie: otherSession.cookie,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('管理员可以连别人的 WS（回显 OK），审计记 channel=ws；普通用户仍 404', async () => {
    const { ctx, port, username, owner, otherSession } = await setup()
    const admin = await createUser(ctx.app, { role: 'admin' })
    const adminSession = loginAs(ctx.app, admin)
    const ws = await wsConnect(`ws://127.0.0.1:${port}/dsh/${username}/api/remote.mux`, {
      cookie: adminSession.cookie,
    })
    expect(ws.statusCode).toBe(101)
    ws.send('hi-from-admin')
    const message = JSON.parse(await ws.nextMessage()) as { echo: string }
    expect(message.echo).toBe('hi-from-admin')
    ws.close()

    const rows = ctx.app.deps.db.all<{ actor_id: number; target_id: string; detail_json: string }>(
      `SELECT actor_id, target_id, detail_json FROM audit_logs WHERE action = 'instance.admin.open'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_id: admin.id, target_id: String(owner.id) })
    expect(JSON.parse(rows[0]!.detail_json)).toEqual({ username, channel: 'ws' })

    const intruder = await wsConnect(`ws://127.0.0.1:${port}/dsh/${username}/api/remote.mux`, {
      cookie: otherSession.cookie,
    })
    expect(intruder.statusCode).toBe(404)
  })

  it('旧地址 /u/<slug>/ 的 WS 升级直接 404（WebSocket 不跟随 301）', async () => {
    const { slug, port, ownerSession } = await setup()
    const ws = await wsConnect(`ws://127.0.0.1:${port}/u/${slug}/api/remote.mux`, {
      cookie: ownerSession.cookie,
    })
    expect(ws.statusCode).toBe(404)
  })

  it('单用户 WS 并发上限 20 条（02 §7.5）：第 21 条 429，关掉一条后可以再连', async () => {
    const { port, username, ownerSession } = await setup()
    const url = `ws://127.0.0.1:${port}/dsh/${username}/api/remote.mux`
    const sockets: WsClient[] = []
    for (let index = 0; index < 20; index += 1) {
      const ws = await wsConnect(url, { cookie: ownerSession.cookie })
      expect(ws.statusCode, `第 ${String(index + 1)} 条`).toBe(101)
      sockets.push(ws)
    }
    const overflow = await wsConnect(url, { cookie: ownerSession.cookie })
    expect(overflow.statusCode).toBe(429)

    sockets[0]!.close()
    let again = await wsConnect(url, { cookie: ownerSession.cookie })
    for (let index = 0; index < 10 && again.statusCode !== 101; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      again = await wsConnect(url, { cookie: ownerSession.cookie })
    }
    expect(again.statusCode).toBe(101)

    // 收尾：把每一条（包括 429 与最后一条）都关掉，否则 app.close() 会一直等连接
    for (const ws of [...sockets, overflow, again]) ws.close()
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  it('容器未运行时 404（不会给一个永远连不上的 101）', async () => {
    const { username, port, ownerSession, instances, owner } = await setup()
    await instances.stop(owner.id, { reason: 'user' })
    const ws = await wsConnect(`ws://127.0.0.1:${port}/dsh/${username}/api/remote.mux`, {
      cookie: ownerSession.cookie,
    })
    expect(ws.statusCode).toBe(404)
  })
})

describe('代理与实例服务的协作', () => {
  it('代理命中后活跃度可由 flushActivity 批量落库（05 §5.8）', async () => {
    const { base, username, ownerSession, instances, owner, ctx } = await setup()
    await rawRequest(`${base}/dsh/${username}/api/echo`, { headers: { cookie: ownerSession.cookie } })
    instances.flushActivity()
    const row = ctx.app.deps.db.get<{ last_active_at: string | null }>(
      'SELECT last_active_at FROM instances WHERE user_id = ?',
      owner.id,
    )
    expect(row?.last_active_at).toBe(ctx.clock.nowIso())
  })

  it('bootstrap 失败（WP3 桩抛错）不影响 DSH 可用', async () => {
    const { base, username, ownerSession, instances, owner, ctx } = await setup()
    instances[ATTACH_COLLABORATORS]({
      bootstrapUser: async () => {
        throw new Error('pnpm 挂了')
      },
    })
    await instances.stop(owner.id, { reason: 'user' })
    // setup() 已经成功启动过一次（WP3 合并后 bootstrap 是真实现，会写 bootstrapped_at）；
    // 这个用例只关心「bootstrap 抛错时不影响 DSH 可用」，所以先清掉标记让它重新走一遍
    ctx.app.deps.db.run('UPDATE instances SET bootstrapped_at = NULL WHERE user_id = ?', owner.id)
    const summary = await instances.ensureRunning(owner.id)
    expect(summary.status).toBe('running')
    // 06 §2.5：bootstrap 失败不阻塞启动，且照样写 bootstrapped_at（失败的插件另有状态页入口）
    expect(
      ctx.app.deps.db.get<{ bootstrapped_at: string | null }>(
        'SELECT bootstrapped_at FROM instances WHERE user_id = ?',
        owner.id,
      )?.bootstrapped_at,
    ).toBeTruthy()
    const res = await rawRequest(`${base}/dsh/${username}/api/echo`, {
      headers: { cookie: ownerSession.cookie },
    })
    expect(res.status).toBe(200)
  })
})
