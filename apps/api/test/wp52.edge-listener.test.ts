import { createServer as createNetServer, connect, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, createUser, type TestApp } from './helpers.js'
import { startEdgeListener, startTlsGateway, type ListenerHandle } from '../src/server/listeners.js'
import { createTlsManager } from '../src/server/tls.js'
import { tlsExchange } from './tls-client.js'

/**
 * WP52 边缘入口（08 §3 / §2.5）的集成测试：真的起一个监听器（临时端口），
 * 经它发 HTTP / WS，证明
 *
 * 1. `X-Real-IP` 缺失 / 多值 / 非法 → 400，边缘入口只接受 nginx 转发来的单个 IP；
 * 2. 合法时真实 IP 进审计（`auth.login.success` 的 actor_ip）；
 * 3. 边缘请求是**公网**请求：按 X-Real-IP 计数限流（即使 IP 是回环也不豁免）、会话 cookie 带 `Secure`；
 * 4. CSRF 只认本入口 origin（边缘只认 HUB_EDGE_ORIGIN，7700 只认公网入口 + 本机调试源）；
 * 5. WS 升级同样校验 X-Real-IP，合法时交给 `app.server` 的 upgrade 处理器（真实 IP 也写进去）；
 * 6. 7700 / 7443 上的 `X-Real-IP` 一律不采信（08 §3 最后一句、02 §5 不变）。
 */

const EDGE_ORIGIN = 'https://edge.example.com'
const EDGE_ASSETS = 'https://edge.example.com/downloads'
const PUBLIC_ORIGIN = 'http://127.0.0.1:7701'

interface EdgeSetup {
  ctx: TestApp
  edge: ListenerHandle
  base: string
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** 拿一个空闲端口：先绑 0 再放开（避免测试并发争固定端口） */
async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function setupEdge(extraEnv: Record<string, string> = {}): Promise<EdgeSetup> {
  const port = await freePort()
  const ctx = await createTestApp({
    env: {
      HUB_EDGE_PORT: String(port),
      HUB_EDGE_ORIGIN: EDGE_ORIGIN,
      HUB_EDGE_ASSETS_ORIGIN: EDGE_ASSETS,
      ...extraEnv,
    },
  })
  const edge = await startEdgeListener(ctx.app, ctx.config)
  if (!edge) throw new Error('边缘监听器没有启动')
  cleanups.push(async () => {
    await edge.close()
    await ctx.close()
  })
  return { ctx, edge, base: `http://127.0.0.1:${String(edge.port)}` }
}

function edgeHeaders(realIp: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return realIp === null ? { ...extra } : { 'x-real-ip': realIp, ...extra }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

/** 最近一条指定 action 的审计 IP */
function lastAuditIp(ctx: TestApp, action: string): string | null {
  const row = ctx.app.deps.db.get<{ actor_ip: string | null }>(
    'SELECT actor_ip FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1',
    action,
  )
  return row?.actor_ip ?? null
}

/** 从 set-cookie 头里找会话 cookie 并返回整条（断言 Secure / HttpOnly 用） */
function sessionCookieOf(response: Response): string {
  return response.headers.getSetCookie().find((line) => line.startsWith('hub_sid=')) ?? ''
}

describe('边缘入口：X-Real-IP 校验（08 §3）', () => {
  it('缺失 / 非法 / 多值 / 带端口 / 地址链 → 400 VALIDATION_FAILED', async () => {
    const { base } = await setupEdge()
    const badHeaders: Record<string, string>[] = [
      {},
      { 'x-real-ip': '' },
      { 'x-real-ip': 'not-an-ip' },
      { 'x-real-ip': '203.0.113.7, 198.51.100.1' },
      { 'x-real-ip': '203.0.113.7:443' },
      { 'x-real-ip': '[2001:db8::1]' },
    ]
    for (const headers of badHeaders) {
      const res = await fetch(`${base}/api/health`, { headers })
      expect(res.status, JSON.stringify(headers)).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('同名 X-Real-IP 出现两次（Node 解析成数组）→ 400', async () => {
    const { base } = await setupEdge()
    const headers = new Headers()
    headers.append('x-real-ip', '203.0.113.7')
    headers.append('x-real-ip', '198.51.100.1')
    const res = await fetch(`${base}/api/health`, { headers })
    expect(res.status).toBe(400)
  })

  it('合法 IPv4 / IPv6 正常放行', async () => {
    const { base } = await setupEdge()
    for (const ip of ['203.0.113.7', '2001:db8::1']) {
      const res = await fetch(`${base}/api/health`, { headers: edgeHeaders(ip) })
      expect(res.status, ip).toBe(200)
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    }
  })
})

describe('边缘入口：公网语义（cookie / 审计 / 限流）', () => {
  it('登录成功：Set-Cookie 带 Secure，审计 IP 是 X-Real-IP', async () => {
    const { ctx, base } = await setupEdge()
    await createUser(ctx.app, { username: 'edgealice', password: 'Alice-pass-1' })

    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: edgeHeaders('203.0.113.7', {
        ...JSON_HEADERS,
        origin: EDGE_ORIGIN,
      }),
      body: JSON.stringify({ username: 'edgealice', password: 'Alice-pass-1' }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const cookie = sessionCookieOf(res)
    expect(cookie).toContain('hub_sid=')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly')
    expect(lastAuditIp(ctx, 'auth.login.success')).toBe('203.0.113.7')
  })

  it('边缘响应带 HSTS（公网语义），7700 本机响应不带', async () => {
    const { ctx, base } = await setupEdge()
    const edgeRes = await fetch(`${base}/api/health`, { headers: edgeHeaders('203.0.113.7') })
    expect(edgeRes.status).toBe(200)
    // HUB_HSTS_MAX_AGE 默认 86400；只对公网（7443 / 边缘）响应发
    expect(edgeRes.headers.get('strict-transport-security')).toBe('max-age=86400')
    const local = await ctx.app.inject({ method: 'GET', url: '/api/health' })
    expect(local.headers['strict-transport-security']).toBeUndefined()
  })

  it('登录失败按 X-Real-IP 计数限流：回环 IP 也不享受豁免（02 §5 / 10 §F9）', async () => {
    const { base } = await setupEdge()
    // 即使 X-Real-IP 写成回环地址，请求本身是公网请求 → 照常限流（10 次 / 10 分钟）
    const attempt = async (ip: string, username: string): Promise<number> => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: edgeHeaders(ip, JSON_HEADERS),
        body: JSON.stringify({ username, password: 'Wrong-pass-1' }),
      })
      return res.status
    }
    for (let index = 0; index < 10; index += 1) {
      expect(await attempt('127.0.0.1', `nobody${String(index)}`)).toBe(401)
    }
    expect(await attempt('127.0.0.1', 'nobody-locked')).toBe(429)
    // 另一个 X-Real-IP 有自己的桶：不被上一个 IP 连累
    expect(await attempt('203.0.113.9', 'nobody-other')).toBe(401)
  })
})

describe('边缘入口：CSRF 只认本入口 origin（08 §3）', () => {
  it('edge + HUB_EDGE_ORIGIN 放行；edge + 公网入口 origin（https://hub.example.com:8123）403', async () => {
    // 用真实的口径：HUB_PUBLIC_ORIGIN=https://hub.example.com:8123、HUB_EDGE_ORIGIN=https://edge.example.com
    const { ctx, base } = await setupEdge({ HUB_PUBLIC_ORIGIN: 'https://hub.example.com:8123' })
    await createUser(ctx.app, { username: 'csrf1', password: 'Alice-pass-1' })
    const post = async (origin: string): Promise<number> => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: edgeHeaders('203.0.113.7', { ...JSON_HEADERS, origin }),
        body: JSON.stringify({ username: 'csrf1', password: 'Alice-pass-1' }),
      })
      await res.arrayBuffer()
      return res.status
    }
    expect(await post(EDGE_ORIGIN)).toBe(200)
    expect(await post('https://hub.example.com:8123')).toBe(403)
    expect(await post('http://localhost:5173')).toBe(403)
    expect(lastAuditIp(ctx, 'auth.login.success')).toBe('203.0.113.7')
  })

  it('7700 本机请求：Edge origin 403，公网入口 origin 放行', async () => {
    const { ctx } = await setupEdge({ HUB_PUBLIC_ORIGIN: 'https://hub.example.com:8123' })
    await createUser(ctx.app, { username: 'csrf2', password: 'Alice-pass-1' })
    const inject = async (origin: string): Promise<number> => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json', origin },
        payload: JSON.stringify({ username: 'csrf2', password: 'Alice-pass-1' }),
      })
      return res.statusCode
    }
    expect(await inject('https://hub.example.com:8123')).toBe(200)
    expect(await inject(EDGE_ORIGIN)).toBe(403)
  })
})

describe('边缘入口：WS 升级（08 §3）', () => {
  function rawUpgrade(port: number, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        const lines = [
          'GET /dsh/alice/api/remote.mux HTTP/1.1',
          'Host: edge.example.com',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          '',
          '',
        ]
        socket.write(lines.join('\r\n'))
      })
      let text = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        text += chunk
      })
      socket.on('close', () => resolve(text))
      socket.on('error', (error) => reject(error))
      setTimeout(() => socket.destroy(), 3_000).unref?.()
    })
  }

  it('合法 X-Real-IP：升级请求交给 app.server 的处理器，socket 上是真实 IP', async () => {
    const { ctx, edge } = await setupEdge()
    const seen = new Promise<{ url: string | undefined; remoteAddress: string | undefined }>((resolve) => {
      ctx.app.server.once('upgrade', (req, socket) => {
        resolve({
          url: req.url,
          remoteAddress: (socket as { remoteAddress?: string }).remoteAddress,
        })
        socket.destroy()
      })
    })
    const raw = await rawUpgrade(edge.port, { 'X-Real-IP': '203.0.113.7' })
    const handled = await seen
    expect(handled.url).toBe('/dsh/alice/api/remote.mux')
    expect(handled.remoteAddress).toBe('203.0.113.7')
    // 真实的 401 由 proxy 的 upgrade 处理器给出（证明请求确实走到了 Fastify 那一侧）
    expect(raw === '' || raw.startsWith('HTTP/1.1')).toBe(true)
  })

  it('非法 X-Real-IP：升级被 400 拒绝，不交给 app.server', async () => {
    const { ctx, edge } = await setupEdge()
    let reached = false
    ctx.app.server.once('upgrade', () => {
      reached = true
    })
    const raw = await rawUpgrade(edge.port, { 'X-Real-IP': '203.0.113.7, 198.51.100.1' })
    expect(raw.startsWith('HTTP/1.1 400')).toBe(true)
    expect(reached).toBe(false)
  })
})

describe('其他入口不采信 X-Real-IP（02 §5 不变）', () => {
  it('7700 本机请求：X-Real-IP 无效，审计 IP 仍是回环', async () => {
    const { ctx } = await setupEdge()
    await createUser(ctx.app, { username: 'plain', password: 'Alice-pass-1' })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '203.0.113.7',
        origin: PUBLIC_ORIGIN,
      },
      payload: JSON.stringify({ username: 'plain', password: 'Alice-pass-1' }),
    })
    expect(res.statusCode).toBe(200)
    expect(lastAuditIp(ctx, 'auth.login.success')).not.toBe('203.0.113.7')
  })

  it('7443 TLS 网关：X-Real-IP 无效，审计 IP 是 TLS 连接的对端地址', async () => {
    const tlsPort = await freePort()
    const ctx = await createTestApp({
      env: {
        HUB_TLS_PORT: String(tlsPort),
        HUB_PROXY_PROTOCOL: 'false',
        HUB_PUBLIC_ORIGIN: 'https://hub.example.com:8443',
      },
    })
    const manager = createTlsManager({
      dataDir: ctx.dataDir,
      publicOrigin: 'https://hub.example.com:8443',
      log: ctx.app.log,
    })
    // 没有正式证书时 startTlsGateway 会现生成自签证书（客户端 rejectUnauthorized:false）
    const gateway = await startTlsGateway(ctx.app, ctx.config, { tls: manager })
    if (!gateway) throw new Error('TLS 网关没有启动')
    cleanups.push(async () => {
      await gateway.close()
      await ctx.close()
    })
    await createUser(ctx.app, { username: 'tlsonly', password: 'Alice-pass-1' })

    const body = JSON.stringify({ username: 'tlsonly', password: 'Alice-pass-1' })
    const { response } = await tlsExchange({
      port: gateway.port,
      proxy: null,
      request:
        'POST /api/auth/login HTTP/1.1\r\n' +
        'Host: hub.example.com:8443\r\n' +
        'Content-Type: application/json\r\n' +
        'X-Real-IP: 203.0.113.7\r\n' +
        `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
        'Connection: close\r\n\r\n' +
        body,
    })
    expect(response.status).toBe(200)
    expect(lastAuditIp(ctx, 'auth.login.success')).not.toBe('203.0.113.7')
  })
})
