import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTlsManager, type TlsManager } from '../src/server/tls.js'
import { sanitizeRedirectPath, startTlsGateway, type ListenerHandle } from '../src/server/listeners.js'
import { containerNameFor, FALLBACK_DSH_VERSION, imageForVersion } from '../src/modules/instances/spec.js'
import type { InternalInstanceService } from '../src/modules/instances/service.js'
import { createTestApp, createUser, loginAs, type TestApp } from './helpers.js'
import { tlsExchange, openTlsClient, parseHttpResponse, type TlsClient } from './tls-client.js'
import { generateTestCertificate } from './tls-helpers.js'

/**
 * 7443 TLS 网关集成测试（任务书「测试」节）：
 * PROXY 头 → `req.ip`、缺 PROXY 头断开、同端口明文 301 与 path 清洗、WS 升级、SSE 首帧、
 * 公网与本机分流（Origin / Secure / HSTS / 限流豁免 / x-forwarded-proto / 返回链接）、证书热更新。
 *
 * 端口用 11 §3 分配给 WP7b 的 7772（TLS）/ 7771（明文，仅作为本机地址出现在链接里，不真的监听）。
 */

const TLS_PORT = 7772
const HTTP_PORT = 7771
const PUBLIC_ORIGIN = 'https://hub.example.com:8443'
const PUBLIC_PROXY = 'PROXY TCP4 203.0.113.9 10.213.0.1 51234 7443'
/** 源地址是回环也不豁免限流（02 §5、10 §F9） */
const LOOPBACK_PROXY = 'PROXY TCP4 127.0.0.1 127.0.0.1 51234 7443'

interface GatewaySetup {
  ctx: TestApp
  manager: TlsManager
  gateway: ListenerHandle
  port: number
}

const cleanups: (() => Promise<void>)[] = []
const clients: TlsClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(extraEnv: Record<string, string> = {}): Promise<GatewaySetup> {
  const ctx = await createTestApp({
    env: {
      HUB_TLS_PORT: String(TLS_PORT),
      HUB_HTTP_PORT: String(HTTP_PORT),
      HUB_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ...extraEnv,
    },
  })
  const manager = createTlsManager({
    dataDir: ctx.dataDir,
    publicOrigin: PUBLIC_ORIGIN,
    log: ctx.app.log,
  })
  const gateway = await startTlsGateway(ctx.app, ctx.config, { tls: manager })
  if (!gateway) throw new Error('TLS 网关没有启动')
  cleanups.push(async () => {
    await gateway.close()
    await ctx.close()
  })
  return { ctx, manager, gateway, port: gateway.port }
}

function httpRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): string {
  const lines = [`${method} ${path} HTTP/1.1`, `Host: hub.example.com:8443`]
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`)
  const payload = body ?? ''
  lines.push(`Content-Length: ${String(Buffer.byteLength(payload))}`, 'Connection: close', '', payload)
  return lines.join('\r\n')
}

function rawTcpExchange(port: number, payload: string, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(payload)
    })
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      text += chunk
    })
    socket.on('close', () => {
      resolve(text)
    })
    socket.on('error', reject)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(text)
    }, timeoutMs)
    timer.unref?.()
  })
}

/** 建一个跑起来的假 DSH 实例（FakeDriver），返回 slug/username 与容器名 */
async function runningInstance(
  ctx: TestApp,
): Promise<{ slug: string; username: string; name: string; cookie: string }> {
  const user = await createUser(ctx.app)
  ctx.driver?.addImage(imageForVersion(FALLBACK_DSH_VERSION))
  const instances = ctx.app.deps.services.instances as InternalInstanceService
  await instances.provision(user.id)
  await instances.ensureRunning(user.id)
  const session = loginAs(ctx.app, user)
  return {
    slug: user.slug,
    username: user.username,
    name: containerNameFor(user.slug),
    cookie: session.cookie,
  }
}

// ── PROXY protocol 与真实 IP ────────────────────────────────────────────────

describe('TLS 网关：PROXY 头与真实 IP', () => {
  it('带 PROXY 头能握手并拿到响应；HSTS 只出现在公网响应', async () => {
    const { ctx, port } = await setup()
    const { client, response } = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest('GET', '/api/health'),
    })
    clients.push(client)
    expect(response.status).toBe(200)
    expect(response.headers['strict-transport-security']).toBe('max-age=86400')

    // 本机 7700（inject）不加 HSTS
    const local = await ctx.app.inject({ method: 'GET', url: '/api/health' })
    expect(local.headers['strict-transport-security']).toBeUndefined()
  })

  it('HUB_PROXY_PROTOCOL=false 时不需要 PROXY 头（TLS 与明文跳转都正常）', async () => {
    const { port } = await setup({ HUB_PROXY_PROTOCOL: 'false' })
    const { client, response } = await tlsExchange({
      port,
      proxy: null,
      request: httpRequest('GET', '/api/health'),
    })
    clients.push(client)
    expect(response.status).toBe(200)
    // 同端口明文跳转也不再要求 PROXY 头
    const raw = await rawTcpExchange(port, 'GET /x HTTP/1.1\r\nHost: hub.example.com\r\n\r\n')
    expect(raw).toContain('Location: https://hub.example.com:8443/x')
  })

  it('HUB_HSTS_MAX_AGE=0 → 公网响应也不发 HSTS', async () => {
    const { port } = await setup({ HUB_HSTS_MAX_AGE: '0' })
    const { client, response } = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest('GET', '/api/health'),
    })
    clients.push(client)
    expect(response.status).toBe(200)
    expect(response.headers['strict-transport-security']).toBeUndefined()
  })

  it('缺少 PROXY 头 → 直接断开（TLS 握手失败）', async () => {
    const { port } = await setup()
    await expect(openTlsClient({ port, proxy: null, timeoutMs: 3_000 })).rejects.toThrow()
  })

  it('PROXY 头里的源地址就是 req.ip（进会话记录与审计）', async () => {
    const { ctx, port } = await setup()
    const user = await createUser(ctx.app, { password: 'test-password-1' })
    const login = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest(
        'POST',
        '/api/auth/login',
        { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
        JSON.stringify({ username: user.username, password: user.password }),
      ),
    })
    clients.push(login.client)
    expect(login.response.status).toBe(200)

    const sessions = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/sessions',
      headers: loginAs(ctx.app, user).headers,
    })
    expect(sessions.statusCode).toBe(200)
    const body = JSON.parse(sessions.body) as { items: { ip: string | null }[] }
    expect(body.items.some((item) => item.ip === '203.0.113.9')).toBe(true)
  })

  it('公网登录的会话 cookie 带 Secure；本机（inject）登录不带', async () => {
    const { ctx, port } = await setup()
    const user = await createUser(ctx.app, { password: 'test-password-1' })
    const publicLogin = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest(
        'POST',
        '/api/auth/login',
        { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
        JSON.stringify({ username: user.username, password: user.password }),
      ),
    })
    clients.push(publicLogin.client)
    expect(publicLogin.response.headers['set-cookie']).toContain('Secure')

    const localLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${String(HTTP_PORT)}` },
      payload: { username: user.username, password: user.password },
    })
    expect(localLogin.statusCode).toBe(200)
    expect(String(localLogin.headers['set-cookie'])).not.toContain('Secure')
  })
})

// ── 同端口明文跳转 ──────────────────────────────────────────────────────────

describe('TLS 网关：同端口明文 301', () => {
  it('明文 HTTP 请求 → 301 到 HUB_PUBLIC_ORIGIN + 原路径', async () => {
    const { port } = await setup()
    const raw = await rawTcpExchange(
      port,
      `${PUBLIC_PROXY}\r\nGET /some/path?x=1 HTTP/1.1\r\nHost: hub.example.com:8443\r\n\r\n`,
    )
    expect(raw.startsWith('HTTP/1.1 301')).toBe(true)
    expect(raw).toContain('Location: https://hub.example.com:8443/some/path?x=1')
  })

  it('绝对形式 target 只取 path（不会变成开放重定向）', async () => {
    const { port } = await setup()
    const raw = await rawTcpExchange(
      port,
      `${PUBLIC_PROXY}\r\nGET http://evil.example/steal HTTP/1.1\r\nHost: x\r\n\r\n`,
    )
    expect(raw).toContain('Location: https://hub.example.com:8443/steal')
    expect(raw).not.toContain('evil.example/steal')
  })

  it('sanitizeRedirectPath：非路径退化成 /，控制字符（含 CRLF）被清掉', () => {
    expect(sanitizeRedirectPath('/a/b?c=1')).toBe('/a/b?c=1')
    expect(sanitizeRedirectPath('http://evil.example/x?y=1')).toBe('/x?y=1')
    expect(sanitizeRedirectPath('not-a-url')).toBe('/')
    expect(sanitizeRedirectPath('/a\r\nSet-Cookie: x=1')).toBe('/aSet-Cookie: x=1')
    expect(sanitizeRedirectPath('')).toBe('/')
  })

  it('非 TLS 也非 HTTP 的首包 → 断开', async () => {
    const { port } = await setup()
    const raw = await rawTcpExchange(port, `${PUBLIC_PROXY}\r\n\x01\x02\x03binary`, 1_000)
    expect(raw).toBe('')
  })
})

// ── 公网 / 本机规则（Origin、限流） ─────────────────────────────────────────

describe('公网与本机分流', () => {
  it('公网请求带本机 Origin 的写请求 → 403；本机同样请求放行', async () => {
    const { ctx, port } = await setup()
    const bad = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest(
        'POST',
        '/api/auth/login',
        { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        '{}',
      ),
    })
    clients.push(bad.client)
    expect(bad.response.status).toBe(403)

    const local = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      payload: {},
    })
    expect(local.statusCode).not.toBe(403)
  })

  it('公网请求的回环地址不享受限流豁免：第 11 次登录被 429', async () => {
    const { port } = await setup()
    const statuses: number[] = []
    for (let index = 0; index < 11; index += 1) {
      const attempt = await tlsExchange({
        port,
        proxy: LOOPBACK_PROXY,
        request: httpRequest(
          'POST',
          '/api/auth/login',
          { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
          JSON.stringify({ username: `ghost${String(index)}`, password: 'not-a-real-password' }),
        ),
      })
      clients.push(attempt.client)
      statuses.push(attempt.response.status)
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401))
    expect(statuses[10]).toBe(429)
  })

  it('本机请求（inject，IP=127.0.0.1）不受按 IP 的登录限流影响', async () => {
    const { ctx } = await setup()
    const statuses: number[] = []
    for (let index = 0; index < 12; index += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${String(HTTP_PORT)}` },
        payload: { username: `ghost-loop-${String(index)}`, password: 'not-a-real-password' },
      })
      statuses.push(res.statusCode)
    }
    expect(statuses.every((status) => status === 401)).toBe(true)
  })
})

// ── /dsh/<username>/ 代理：HSTS、协议与返回链接、WS、SSE ────────────────────

describe('TLS 网关下的 /dsh/<username>/ 代理', () => {
  it('公网：HSTS + x-forwarded-proto=https + 返回链接用 HUB_PUBLIC_ORIGIN', async () => {
    const { ctx, port } = await setup()
    const { username, name, cookie } = await runningInstance(ctx)
    const res = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest('GET', `/dsh/${username}/`, {
        cookie,
        accept: 'text/html,application/xhtml+xml',
      }),
    })
    clients.push(res.client)
    expect(res.response.status).toBe(200)
    expect(res.response.headers['strict-transport-security']).toBe('max-age=86400')
    expect(res.response.body).toContain('ownsHost:true')
    expect(res.response.body).toContain(`${PUBLIC_ORIGIN}/`)

    // 转给用户 DSH 的协议：公网是 https（假 DSH 的 /api/echo 会回显）
    const echo = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest('GET', `/dsh/${username}/api/echo`, { cookie, accept: 'application/json' }),
    })
    clients.push(echo.client)
    expect(JSON.parse(echo.response.body)).toMatchObject({ forwardedProto: 'https' })
    void name
  })

  it('本机（inject）：没有 HSTS，转发协议与本机返回链接都是 http', async () => {
    const { ctx } = await setup()
    const { username, name, cookie } = await runningInstance(ctx)
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/dsh/${username}/`,
      headers: { cookie, accept: 'text/html' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['strict-transport-security']).toBeUndefined()
    expect(res.body).toContain(`http://127.0.0.1:${String(HTTP_PORT)}/`)

    const echo = await ctx.app.inject({
      method: 'GET',
      url: `/dsh/${username}/api/echo`,
      headers: { cookie, accept: 'application/json' },
    })
    expect(JSON.parse(echo.body)).toMatchObject({ forwardedProto: 'http' })
    void name
  })

  it('WS 经 TLS 网关升级成功（假 DSH 的 /api/remote.mux）', async () => {
    const { ctx, port } = await setup()
    const { username, cookie } = await runningInstance(ctx)
    const client = await openTlsClient({ port, proxy: PUBLIC_PROXY })
    clients.push(client)
    const key = randomBytes(16).toString('base64')
    client.write(
      [
        `GET /dsh/${username}/api/remote.mux HTTP/1.1`,
        'Host: hub.example.com:8443',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Cookie: ${cookie}`,
        '',
        '',
      ].join('\r\n'),
    )
    await client.waitFor((text) => text.includes('\r\n\r\n'))
    const response = parseHttpResponse(client.text())
    expect(response.status).toBe(101)
    expect(response.headers.upgrade?.toLowerCase()).toBe('websocket')
    expect(response.headers['sec-websocket-accept']).toBeTruthy()
  })

  it('旧地址 /u/<slug>/ 在公网 → 301 到规范地址（带 HSTS，保留子路径与查询串）', async () => {
    const { ctx, port } = await setup()
    const { slug, username, cookie } = await runningInstance(ctx)
    const res = await tlsExchange({
      port,
      proxy: PUBLIC_PROXY,
      request: httpRequest('GET', `/u/${slug}/api/echo?x=1`, { cookie }),
    })
    clients.push(res.client)
    expect(res.response.status).toBe(301)
    expect(res.response.headers.location).toBe(`/dsh/${username}/api/echo?x=1`)
    expect(res.response.headers['strict-transport-security']).toBe('max-age=86400')
  })

  it('SSE 首帧立即到达（代理不缓冲）', async () => {
    const { ctx, port } = await setup()
    const { username, cookie } = await runningInstance(ctx)
    const client = await openTlsClient({ port, proxy: PUBLIC_PROXY })
    clients.push(client)
    client.write(
      httpRequest('GET', `/dsh/${username}/plugins/events`, { cookie, accept: 'text/event-stream' }),
    )
    await client.waitFor((text) => text.includes('event: tick'), 3_000)
    expect(client.firstDataMs()).not.toBeNull()
    expect(client.firstDataMs() ?? 9_999).toBeLessThan(1_000)
    expect(client.text()).toContain('text/event-stream')
    expect(client.text()).toContain('event: tick')
  })
})

// ── 证书热更新 ──────────────────────────────────────────────────────────────

describe('TLS 网关：证书热更新', () => {
  it('替换 fullchain.pem 后 reload：新连接拿到新证书，旧连接不断', async () => {
    const { ctx, manager, gateway, port } = await setup()
    const before = await openTlsClient({ port, proxy: PUBLIC_PROXY })
    clients.push(before)
    expect(peerCn(before)).toBe('hub.example.com')

    // 模拟 acme.sh 装证书：写入正式的 fullchain/privkey
    const fresh = generateTestCertificate({
      dir: ctx.dataDir,
      name: 'fresh',
      host: 'fresh.example.com',
    })
    const tlsDir = join(ctx.dataDir, 'secrets', 'tls')
    writeFileSync(join(tlsDir, 'fullchain.pem'), fresh.cert)
    writeFileSync(join(tlsDir, 'privkey.pem'), fresh.key, { mode: 0o600 })

    const material = gateway.tls?.reload('测试热更新')
    expect(material?.source).toBe('acme')
    expect(manager.current()?.info.subject).toContain('CN=fresh.example.com')

    const after = await openTlsClient({ port, proxy: PUBLIC_PROXY })
    clients.push(after)
    expect(peerCn(after)).toBe('fresh.example.com')

    // 旧连接仍可用（没有被 setSecureContext 断开）
    before.write(httpRequest('GET', '/api/health'))
    await before.waitFor((text) => text.includes('200 OK'), 3_000)
    expect(before.text()).toContain('"ok":true')
  })

  it('key/cert 不匹配时 reload 失败并保留旧证书', async () => {
    const { ctx, gateway, port } = await setup()
    const tlsDir = join(ctx.dataDir, 'secrets', 'tls')
    const bad = generateTestCertificate({ dir: ctx.dataDir, name: 'bad', host: 'bad.example.com' })
    writeFileSync(join(tlsDir, 'fullchain.pem'), bad.cert)
    writeFileSync(
      join(tlsDir, 'privkey.pem'),
      generateTestCertificate({ dir: ctx.dataDir, name: 'other', host: 'other.example.com' }).key,
    )

    expect(gateway.tls?.reload('坏证书')).toBeNull()
    const client = await openTlsClient({ port, proxy: PUBLIC_PROXY })
    clients.push(client)
    expect(peerCn(client)).toBe('hub.example.com')
  })
})

function peerCn(client: TlsClient): string | undefined {
  const cert = client.socket.getPeerCertificate()
  const subject = cert.subject as { CN?: string } | undefined
  return subject?.CN
}
