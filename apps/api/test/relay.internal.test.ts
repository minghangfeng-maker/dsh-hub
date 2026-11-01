import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerStatic } from '../src/server/static.js'
import type { TestApp } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import {
  OPENAI_NON_STREAM_BODY,
  grantMicro,
  issueKey,
  jsonResponse,
  setupChannelAndModel,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * 内部监听器（12 §3）与 `/v1` 的钩子豁免（12 §3、§4）：
 * - 内部实例只有 `/v1/*` 与 `GET /healthz`，其它一律 404；
 * - 主应用的 `/v1/*` 不受会话/CSRF/Origin/强制改密影响，也不落到 SPA 兜底。
 */

let ctx: TestApp | undefined
let upstream: FakeUpstream | undefined
let listener: { close(): Promise<void> } | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await listener?.close()
  listener = undefined
  await ctx?.close()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(): Promise<{ app: TestApp; userId: number; key: string }> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const user = await createUser(ctx.app, { username: 'inner' })
  grantMicro(ctx.app, user.id, 10_000_000)
  const key = issueKey(ctx.app, user.id)
  return { app: ctx, userId: user.id, key }
}

async function baseUrlOf(address: { host: string; port: number }): Promise<string> {
  return `http://${address.host}:${String(address.port)}`
}

describe('内部监听器（12 §3）', () => {
  it('只响应 /v1/* 与 /healthz，其它 404；source=internal 落库', async () => {
    const { app, userId, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url })

    const { startRelayInternalListener } = await import('../src/modules/relay/internal-listener.js')
    const started = await startRelayInternalListener({
      deps: app.app.deps,
      host: '127.0.0.1',
      port: 0,
    })
    listener = started
    const address = started.address()
    expect(address).not.toBeNull()
    const base = await baseUrlOf(address!)

    expect(app.app.deps.services.relay.isInternalListening()).toBe(true)
    expect(app.app.deps.services.relay.internalBaseUrl()).toBe(`${base}/v1`)

    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect((await health.json()) as { ok: boolean }).toMatchObject({ ok: true })

    // 其它路径一律 404：没有 /api、没有管理接口、没有静态文件
    for (const path of ['/', '/api/me/relay', '/api/admin/relay/overview', '/v1', '/metrics']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(404)
    }

    const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    expect(models.status).toBe(200)

    // 带 session cookie 但没有密钥 → 401（内部实例不读 cookie）
    const withCookie = await fetch(`${base}/v1/models`, { headers: { cookie: 'hub_sid=whatever' } })
    expect(withCookie.status).toBe(401)

    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    })
    expect(chat.status).toBe(200)
    expect(await chat.text()).toBe(JSON.stringify(OPENAI_NON_STREAM_BODY))
    const row = app.app.deps.db.get<{ source: string }>(
      'SELECT source FROM relay_usage WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      userId,
    )!
    expect(row.source).toBe('internal')

    await started.close()
    listener = undefined
    expect(app.app.deps.services.relay.isInternalListening()).toBe(false)
    expect(app.app.deps.services.relay.internalBaseUrl()).toBeNull()
  })
})

describe('/v1 的钩子豁免（12 §3）', () => {
  it('不受 CSRF/Origin 影响、不认会话 cookie、未登录也能用密钥', async () => {
    const { app, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url })

    // 跨站 Origin（浏览器发起的 /api 请求会被 CSRF 钩子拒），/v1 不看 Origin
    const crossOrigin = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${key}`,
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      payload: { model: 'test-model', messages: [] },
    })
    expect(crossOrigin.statusCode).toBe(200)

    // 带一个（无效）会话 cookie 也不会被当成登录态，更不会被强制改密闸门拦
    const withCookie = await app.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { cookie: 'hub_sid=nope', authorization: `Bearer ${key}` },
    })
    expect(withCookie.statusCode).toBe(200)
  })

  it('强制改密用户的密钥照常可用（/v1 不经过 MUST_CHANGE_PASSWORD 闸门）', async () => {
    const { app } = await setup()
    const user = await createUser(app.app, { username: 'mustchange', mustChangePassword: true })
    grantMicro(app.app, user.id, 10_000_000)
    const key = issueKey(app.app, user.id)
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url })

    const session = loginAs(app.app, user)
    const viaApi = await app.app.inject({
      method: 'GET',
      url: '/api/me/relay/keys',
      headers: session.headers,
    })
    expect(viaApi.statusCode).toBe(200) // GET /api/me 放行

    const viaV1 = await app.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(viaV1.statusCode).toBe(200)
  })

  it('未知 /v1 路径回厂商格式 404，不落到 SPA 兜底', async () => {
    const { app } = await setup()
    const webDist = mkdtempSync(join(tmpdir(), 'wp10a-web-'))
    tempDirs.push(webDist)
    writeFileSync(join(webDist, 'index.html'), '<html>SPA</html>')
    await registerStatic(app.app, { config: app.config, webDistDir: webDist })

    const openai = await app.app.inject({ method: 'GET', url: '/v1/does-not-exist' })
    expect(openai.statusCode).toBe(404)
    expect(json<{ error: { code: string } }>(openai).error.code).toBe('not_found')

    const anthropic = await app.app.inject({ method: 'GET', url: '/v1/messages/does-not-exist' })
    expect(anthropic.statusCode).toBe(404)
    expect(json<{ type: string }>(anthropic).type).toBe('error')

    // 普通前端路由照样 SPA 兜底（没被我们改坏）
    const spa = await app.app.inject({ method: 'GET', url: '/usage' })
    expect(spa.statusCode).toBe(200)
    expect(spa.body).toContain('SPA')
  })
})
