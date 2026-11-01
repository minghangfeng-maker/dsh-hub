import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveSession } from '../src/lib/session.js'
import { createTestApp, createUser, json, loginAs, type TestApp } from './helpers.js'

/** 真实 socket relay gate：双握手、401、hello 后 connectable、双账号隔离。 */

let test: TestApp
let port = 0
const sockets: WebSocket[] = []

function deviceRow(userId: number, deviceId: string): void {
  const now = test.clock.nowIso()
  test.app.deps.db.run(
    `INSERT INTO desktop_devices (device_id, user_id, install_key, name, platform, os_major, arch,
       app_version, app_channel, runtime_version, capabilities_json, status,
       registered_at, first_seen_at, last_auth_at, last_report_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'win32', '11', 'x64', '0.9.3', 'latest', '0.2.1', NULL, 'active', ?, ?, ?, ?, ?, ?)`,
    deviceId, userId, `dev-${deviceId.slice(3, 9)}`, now, now, now, now, now, now,
  )
}

function tokenRow(userId: number, deviceId: string, plain: string): void {
  const id = createHash('sha256').update(plain).digest('hex')
  const now = test.clock.nowIso()
  test.app.deps.db.run(
    `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at,
       ip, user_agent, app_version) VALUES (?, ?, ?, ?, ?, ?, NULL, 'vitest', '0.9.3')`,
    id, deviceId, userId, now, now, new Date(Date.now() + 86_400_000).toISOString(),
  )
}

async function upgrade(token: string): Promise<WebSocket | number> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/desktop/relay`, {
    headers: { authorization: `Bearer ${token}` },
  })
  sockets.push(socket)
  const outcome = await Promise.race([
    once(socket, 'open').then(() => 'open' as const),
    once(socket, 'unexpected-response').then(([, response]) => (response as { statusCode: number }).statusCode),
  ])
  return outcome === 'open' ? socket : outcome
}

const CAPS = {
  sessions: true, history: true, send: true, stop: true, stream: true,
  questions: true, approvals: true, create: true,
}

async function hello(socket: WebSocket, deviceId: string): Promise<void> {
  socket.send(JSON.stringify({ v: 1, type: 'hello', deviceId, hostStatus: 'running', capabilities: CAPS, clientVersion: '0.9.3' }))
  await delay(50)
}

beforeAll(async () => {
    process.env['HUB_MOBILE_RELAY_REVALIDATE_MS'] = '50'
    process.env['HUB_MOBILE_SESSION_RECHECK_MS'] = '50'
    test = await createTestApp()
    const address = test.app.server.address()
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve) => test.app.server.listen(0, '127.0.0.1', resolve))
    }
    const bound = test.app.server.address()
  port = typeof bound === 'object' && bound !== null ? bound.port : 0
})

afterAll(async () => {
  for (const socket of sockets) socket.terminate()
  await test.close()
  delete process.env['HUB_MOBILE_RELAY_REVALIDATE_MS']
  delete process.env['HUB_MOBILE_SESSION_RECHECK_MS']
})

describe('relay 真 socket', () => {
  it('401：无效令牌在 upgrade 阶段被拒', async () => {
    const result = await upgrade('bogus-token')
    expect(result).toBe(401)
  })

  it('双握手：同设备第二个 socket 在 upgrade 阶段 429，第一连接不受影响', async () => {
    const user = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, deviceId)
    tokenRow(user.id, deviceId, 'dsh_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const first = await upgrade('dsh_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(typeof first).toBe('object')
    // 关键时序：第二连接在第一个 hello **之前**就发起（复现原竞态）
    const second = await upgrade('dsh_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(second).toBe(429)
    await hello(first as WebSocket, deviceId)
    // 第一个连接仍可用：hello 后再发一次帧不报错
    ;(first as WebSocket).send(JSON.stringify({ v: 1, type: 'close', channelId: 'none', code: 'node-offline', reason: 'x' }))
    await delay(30)
  })

  it('hello 后节点列表 connectable=true；他人账号看不到该设备', async () => {
    const owner = await createUser(test.app)
    const other = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(owner.id, deviceId)
    tokenRow(owner.id, deviceId, 'dsh_dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    const socket = await upgrade('dsh_dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(typeof socket).toBe('object')
    await hello(socket as WebSocket, deviceId)
    await delay(30)
    const ownerSession = loginAs(test.app, owner)
    const ownerRes = await test.app.inject({ method: 'GET', url: '/api/mobile/nodes', headers: ownerSession.headers })
    const ownerNodes = json<{ items: Array<Record<string, unknown>> }>(ownerRes)
    const row = ownerNodes.items.find((item) => item['id'] === deviceId)
    expect(row).toMatchObject({ connectable: true, status: 'host-running' })

    const otherSession = loginAs(test.app, other)
    const otherRes = await test.app.inject({ method: 'GET', url: '/api/mobile/nodes', headers: otherSession.headers })
    expect(json<{ items: Array<Record<string, unknown>> }>(otherRes).items.map((item) => item['id'])).not.toContain(deviceId)
  })
})

describe('relay 真 socket：撤销与节点并发', () => {
  it('令牌撤销后 60s 复检（测试注入 50ms）会主动断开连接', async () => {
    const user = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, deviceId)
    const token = 'dsh_dev_cccccccccccccccccccccccccccccccccccccccc'
    tokenRow(user.id, deviceId, token)
    const socket = (await upgrade(token)) as WebSocket
    await hello(socket, deviceId)
    const closed = once(socket, 'close')
    const id = createHash('sha256').update(token).digest('hex')
    test.app.deps.db.run(`UPDATE desktop_device_tokens SET revoked_at = ? WHERE id = ?`, test.clock.nowIso(), id)
    const [code] = (await closed) as [number, Buffer]
    expect([1008, 1006]).toContain(code)
  })

  it('同一桌面节点第三条通道按契约顶掉最旧连接（不是静默拒）', async () => {
    const user = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, deviceId)
    tokenRow(user.id, deviceId, 'dsh_dev_dddddddddddddddddddddddddddddddddddddddd')
    const relay = (await upgrade('dsh_dev_dddddddddddddddddddddddddddddddddddddddd')) as WebSocket
    await hello(relay, deviceId)
    await delay(30)
    const session = loginAs(test.app, user)
    const openChannel = async (): Promise<WebSocket | number> => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/mobile/nodes/${deviceId}/channel`, {
        headers: { cookie: session.cookie },
      })
      sockets.push(socket)
      const outcome = await Promise.race([
        once(socket, 'open').then(() => 'open' as const),
        once(socket, 'unexpected-response').then(([, response]) => (response as { statusCode: number }).statusCode),
      ])
      return outcome === 'open' ? socket : outcome
    }
    const first = await openChannel()
    const second = await openChannel()
    expect(typeof first).toBe('object')
    expect(typeof second).toBe('object')
    const closed: Promise<unknown>[] = [once(first as WebSocket, 'close'), once(second as WebSocket, 'close')]
    const third = await openChannel()
    expect(typeof third).toBe('object')
    // 旧连接之一被关闭（bye rate-limited 后 close）
    await expect(Promise.race(closed)).resolves.toBeDefined()
  })
})

describe('手机通道真 socket', () => {
  it('会话被吊销后独立复查会 bye(session-expired) 并断开', async () => {
    const user = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, deviceId)
    tokenRow(user.id, deviceId, 'dsh_dev_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    const relay = (await upgrade('dsh_dev_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')) as WebSocket
    await hello(relay, deviceId)
    await delay(30)
    const session = loginAs(test.app, user)
    const channel = new WebSocket(`ws://127.0.0.1:${String(port)}/api/mobile/nodes/${deviceId}/channel`, {
      headers: { cookie: session.cookie },
    })
    sockets.push(channel)
    await once(channel, 'open')
    const messages: string[] = []
    const closed = once(channel, 'close')
    channel.on('message', (data: Buffer) => messages.push(data.toString('utf8')))
    channel.send(JSON.stringify({ v: 1, type: 'hello', requestId: 'h', client: { name: 'm1', version: '0' } }))
    await delay(30)
    const updated = test.app.deps.db.run(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, test.clock.nowIso(), session.sessionId)
    expect(updated.changes).toBe(1)
    // 先证明会话确实失效，再等连接关闭（避免把时序问题藏在 close 上）
    expect(resolveSession(test.app.deps.db, session.token, test.clock.nowIso())).toBeNull()
    await Promise.race([closed, delay(2000).then(() => { throw new Error(JSON.stringify({ readyState: channel.readyState, messages })) })])
    expect(messages.join('')).toContain('session-expired')
  })

  it('无 cookie 401；跨站 Origin 403', async () => {
    const user = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, deviceId)
    const noCookie = new WebSocket(`ws://127.0.0.1:${String(port)}/api/mobile/nodes/${deviceId}/channel`)
    sockets.push(noCookie)
    const first = await Promise.race([
      once(noCookie, 'open').then(() => 'open' as const),
      once(noCookie, 'unexpected-response').then(([, r]) => (r as { statusCode: number }).statusCode),
    ])
    expect(first).toBe(401)
    const session = loginAs(test.app, user)
    const badOrigin = new WebSocket(`ws://127.0.0.1:${String(port)}/api/mobile/nodes/${deviceId}/channel`, {
      headers: { cookie: session.cookie, origin: 'http://evil.example' },
    })
    sockets.push(badOrigin)
    const second = await Promise.race([
      once(badOrigin, 'open').then(() => 'open' as const),
      once(badOrigin, 'unexpected-response').then(([, r]) => (r as { statusCode: number }).statusCode),
    ])
    expect(second).toBe(403)
  })
})

describe('跨 relay 注入（真 socket）', () => {
  it('另一账号的 relay 用 owner 的 channelId 发 frame/close 一律无效，owner 仍在线', async () => {
    const owner = await createUser(test.app)
    const attacker = await createUser(test.app)
    const ownerDevice = `dv_${randomBytes(16).toString('hex')}`
    const attackerDevice = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(owner.id, ownerDevice)
    deviceRow(attacker.id, attackerDevice)
    tokenRow(owner.id, ownerDevice, 'dsh_dev_ffffffffffffffffffffffffffffffffffffffff')
    tokenRow(attacker.id, attackerDevice, 'dsh_dev_9999999999999999999999999999999999999999')

    const ownerRelay = (await upgrade('dsh_dev_ffffffffffffffffffffffffffffffffffffffff')) as WebSocket
    const ownerOpens: Array<{ channelId: string }> = []
    ownerRelay.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as { type?: string; channelId?: string }
      if (frame.type === 'open' && typeof frame.channelId === 'string') ownerOpens.push({ channelId: frame.channelId })
    })
    await hello(ownerRelay, ownerDevice)
    const session = loginAs(test.app, owner)
    const channel = new WebSocket(`ws://127.0.0.1:${String(port)}/api/mobile/nodes/${ownerDevice}/channel`, {
      headers: { cookie: session.cookie },
    })
    sockets.push(channel)
    await once(channel, 'open')
    const channelMessages: string[] = []
    channel.on('message', (data: Buffer) => channelMessages.push(data.toString('utf8')))
    channel.send(JSON.stringify({ v: 1, type: 'hello', requestId: 'h', client: { name: 'm1', version: '0' } }))
    for (let index = 0; index < 50 && ownerOpens.length === 0; index += 1) await delay(20)
    expect(ownerOpens.length).toBeGreaterThan(0)
    const channelId = ownerOpens[0]!.channelId

    const attackerRelay = (await upgrade('dsh_dev_9999999999999999999999999999999999999999')) as WebSocket
    await hello(attackerRelay, attackerDevice)
    const before = channelMessages.length
    attackerRelay.send(JSON.stringify({ v: 1, type: 'frame', channelId, payload: { v: 1, type: 'pong', t: 666 } }))
    attackerRelay.send(JSON.stringify({ v: 1, type: 'close', channelId, code: 'node-offline', reason: 'injected' }))
    await delay(120)
    expect(channelMessages.slice(before).some((text) => text.includes('666') || text.includes('injected'))).toBe(false)
    expect(channel.readyState).toBe(WebSocket.OPEN)
    expect(ownerRelay.readyState).toBe(WebSocket.OPEN)
  })
})

/**
 * WP48 / 评估 R1 方案 B：桌面节点不再「假 v2」。
 *
 * 真正的判据是**跨进程**的：中继 hello 里有没有 `relayFeatures`，决定手机收到的
 * `hello.features` 是不是空的。这里用真 socket 走一遍服务层的接线（service.ts 把
 * relay hello 的字段落到 relay 连接上 → channel.ts 按它求交/降级）。
 */
describe('桌面中继的 relayFeatures 决定手机 hello 的回显', () => {
  async function waitFor(check: () => boolean, what: string): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (check()) return
      await delay(20)
    }
    throw new Error(`等待超时：${what}`)
  }

  async function phoneHelloEcho(
    relayFeatures: string[] | undefined,
  ): Promise<{ hello: Record<string, unknown>; audit: Record<string, unknown> }> {
    const user = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    const token = `dsh_dev_${randomBytes(20).toString('hex')}`
    deviceRow(user.id, deviceId)
    tokenRow(user.id, deviceId, token)
    const relay = (await upgrade(token)) as WebSocket
    const relayFrames: Array<Record<string, unknown>> = []
    relay.on('message', (data: Buffer) => {
      relayFrames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>)
    })
    relay.send(
      JSON.stringify({
        v: 1,
        type: 'hello',
        deviceId,
        hostStatus: 'running',
        capabilities: CAPS,
        clientVersion: '0.9.3',
        ...(relayFeatures === undefined ? {} : { relayFeatures }),
      }),
    )
    await delay(60)

    const session = loginAs(test.app, user)
    const channel = new WebSocket(`ws://127.0.0.1:${String(port)}/api/mobile/nodes/${deviceId}/channel`, {
      headers: { cookie: session.cookie },
    })
    sockets.push(channel)
    await once(channel, 'open')
    const messages: string[] = []
    channel.on('message', (data: Buffer) => messages.push(data.toString('utf8')))
    channel.send(
      JSON.stringify({
        v: 1,
        type: 'hello',
        requestId: 'h1',
        client: { name: 'dsh-hub-app', version: '0.2.17' },
        features: ['models', 'files'],
      }),
    )
    await waitFor(
      () => relayFrames.some((frame) => (frame['payload'] as { type?: string } | undefined)?.type === 'hello'),
      '中继收到 hello 客户端帧',
    )
    const forwarded = relayFrames.find(
      (frame) => (frame['payload'] as { type?: string } | undefined)?.type === 'hello',
    )!
    // 桌面 adapter 确实实现了 v2：它照常回显两个特性
    relay.send(
      JSON.stringify({
        v: 1,
        type: 'frame',
        channelId: forwarded['channelId'],
        payload: {
          v: 1,
          type: 'hello',
          requestId: 'h1',
          node: { id: deviceId, kind: 'desktop', name: 'PC', status: 'host-running' },
          capabilities: CAPS,
          subscribed: [],
          serverTime: 1,
          features: ['models', 'files'],
          capabilitiesV2: { models: true, filesRead: true },
        },
      }),
    )
    await waitFor(
      () => messages.some((text) => (JSON.parse(text) as { type?: string }).type === 'hello'),
      '手机收到 hello 回显',
    )
    // P0 审计要真的落库（不是只在桩里被调用）：查真 SQLite 的最后一条 mobile.hello
    await waitFor(
      () =>
        test.app.deps.db.get<{ id: number }>(
          `SELECT id FROM audit_logs WHERE action = 'mobile.hello' AND json_extract(detail_json,'$.nodeId') = ?`,
          deviceId,
        ) !== undefined,
      'mobile.hello 审计落库',
    )
    const row = test.app.deps.db.get<{ detail_json: string }>(
      `SELECT detail_json FROM audit_logs
        WHERE action = 'mobile.hello' AND json_extract(detail_json,'$.nodeId') = ?
        ORDER BY id DESC`,
      deviceId,
    )!
    channel.close()
    relay.close()
    return {
      hello: JSON.parse(messages.find((text) => (JSON.parse(text) as { type?: string }).type === 'hello')!) as Record<
        string,
        unknown
      >,
      audit: JSON.parse(row.detail_json) as Record<string, unknown>,
    }
  }

  it('旧 connector（hello 不带 relayFeatures）→ 手机 hello 的 v2 字段整块摘掉，审计 v2=false', async () => {
    const { hello, audit } = await phoneHelloEcho(undefined)
    expect(hello).not.toHaveProperty('features')
    expect(hello).not.toHaveProperty('capabilitiesV2')
    // v1 字段一个不少（降级只摘 v2，不动 v1 形状）
    expect(hello).toMatchObject({ node: { kind: 'desktop' }, subscribed: [], serverTime: expect.any(Number) })
    // 审计记的是「该通道实际回显的集合」：声明了两个、启用为空
    expect(audit).toMatchObject({
      clientName: 'dsh-hub-app',
      clientVersion: '0.2.17',
      declared: ['models', 'files'],
      enabled: [],
      v2: false,
    })
  })

  it('新 connector（relayFeatures 只有 models）→ 只回显 models，审计 enabled=["models"]', async () => {
    const { hello, audit } = await phoneHelloEcho(['models'])
    expect(hello['features']).toEqual(['models'])
    expect(audit).toMatchObject({ declared: ['models', 'files'], enabled: ['models'], v2: true })
  })
})
