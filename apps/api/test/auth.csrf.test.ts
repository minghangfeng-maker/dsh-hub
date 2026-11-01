import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, type TestApp } from './helpers.js'
import { errorCode, multipart, pngBytes } from './wp1-helpers.js'

/**
 * 10 §B8 与 04 §8 第 11 条（2026-10-12 编排者复核后两者已一致）：
 * - **有** Origin 时必须等于 `HUB_PUBLIC_ORIGIN` 或本机调试源 → 否则 403 FORBIDDEN；
 * - **没有** Origin 的请求放行（curl / 服务端调用；浏览器发起的跨站请求一定带 Origin）；
 * - 非 GET 的请求体必须是 `application/json`，否则 415 UNSUPPORTED_MEDIA（04 §0.2 错误码表）；
 * - multipart 上传（文件）例外：要求 `X-Hub-Csrf: 1`，缺了才 403。
 * 本文件用**真实接口**（登录、头像上传）验证这些行为，避免只测探针路由。
 */
let ctx: TestApp
let app: FastifyInstance

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  await createUser(app, { username: 'alice', password: 'Alice-pass-1' })
})

afterEach(async () => {
  await ctx.close()
})

function loginHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', ...extra }
}

describe('CSRF / Origin（02 §5 / 10 §B8）', () => {
  it('正确 Origin + JSON → 放行（业务正常）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: loginHeaders({ origin: ctx.config.publicOrigin }),
      payload: JSON.stringify({ username: 'alice', password: 'Alice-pass-1' }),
    })
    expect(res.statusCode).toBe(200)
  })

  it('错 Origin → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: loginHeaders({ origin: 'https://evil.example' }),
      payload: JSON.stringify({ username: 'alice', password: 'Alice-pass-1' }),
    })
    expect(res.statusCode).toBe(403)
    expect(errorCode(json(res))).toBe('FORBIDDEN')
  })

  it('无 Origin 的 POST → 放行（04 §8.11；curl/服务端调用）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: loginHeaders(),
      payload: JSON.stringify({ username: 'alice', password: 'Alice-pass-1' }),
    })
    expect(res.statusCode).toBe(200)
  })

  it('无 content-type 且 Content-Length: 0 的 POST 不算有请求体（浏览器的无 body POST）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ctx.config.publicOrigin, 'content-length': '0' },
    })
    expect(res.statusCode).not.toBe(415)
  })

  it('无 content-type 但真有请求体的 POST 仍然 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ctx.config.publicOrigin },
      payload: Buffer.from('username=alice'),
    })
    expect(res.statusCode).toBe(415)
  })

  it('text/plain 的 POST → 415 UNSUPPORTED_MEDIA', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain', origin: ctx.config.publicOrigin },
      payload: JSON.stringify({ username: 'alice', password: 'Alice-pass-1' }),
    })
    expect(res.statusCode).toBe(415)
    expect(errorCode(json(res))).toBe('UNSUPPORTED_MEDIA')
  })

  it('multipart 上传缺少 X-Hub-Csrf → 403；带上是 200', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: loginHeaders({ origin: ctx.config.publicOrigin }),
      payload: JSON.stringify({ username: 'alice', password: 'Alice-pass-1' }),
    })
    const cookie = String(login.headers['set-cookie']).split(';')[0]!
    const body = multipart(pngBytes())
    const headersWithoutCsrf: Record<string, string> = { ...body.headers, cookie, origin: ctx.config.publicOrigin }
    delete headersWithoutCsrf['x-hub-csrf']

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/me/avatar',
      headers: headersWithoutCsrf,
      payload: body.payload,
    })
    expect(blocked.statusCode).toBe(403)

    const ok = await app.inject({
      method: 'POST',
      url: '/api/me/avatar',
      headers: { ...body.headers, cookie, origin: ctx.config.publicOrigin },
      payload: body.payload,
    })
    expect(ok.statusCode, ok.body).toBe(200)
  })

  it('GET 不校验 Origin（头像读取即使是外来 Origin 也返回图片）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/public/site',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.statusCode).toBe(200)
  })
})
