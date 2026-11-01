import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, json, type TestApp } from './helpers.js'

let ctx: TestApp
let app: FastifyInstance

/** 探针路由：原样回显收到的请求，用于观察 CSRF 钩子是否放行 */
function registerProbes(app: FastifyInstance): void {
  app.post('/api/probe', async (req) => ({ ok: true, body: req.body ?? null }))
  app.post('/api/probe-upload', async () => ({ ok: true }))
  app.put('/api/probe-put', async () => ({ ok: true }))
}

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  registerProbes(app)
})

afterEach(async () => {
  await ctx.close()
})

describe('CSRF / Origin 钩子（02 §5）', () => {
  it('JSON + 正确 Origin → 放行', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe',
      headers: { 'content-type': 'application/json', origin: ctx.config.publicOrigin },
      payload: { hello: 'world' },
    })
    expect(res.statusCode).toBe(200)
    expect(json<{ body: unknown }>(res).body).toEqual({ hello: 'world' })
  })

  it('本机调试源（Vite 5171 / localhost 任意端口）→ 放行', async () => {
    for (const origin of ['http://127.0.0.1:5171', 'http://localhost:5173', 'https://localhost:5175']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/probe',
        headers: { 'content-type': 'application/json', origin },
        payload: {},
      })
      expect(res.statusCode, origin).toBe(200)
    }
  })

  it('外来 Origin → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('FORBIDDEN')
  })

  it('没有 Origin（curl / 服务端调用）→ 放行', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe',
      headers: { 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(200)
  })

  it('非 JSON 的非 GET 请求 → 415 UNSUPPORTED_MEDIA', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ctx.config.publicOrigin },
      payload: 'a=1',
    })
    expect(res.statusCode).toBe(415)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('UNSUPPORTED_MEDIA')
  })

  it('multipart 上传必须带 X-Hub-Csrf: 1', async () => {
    const boundary = '----dshhubtest'
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n--${boundary}--\r\n`
    const missing = await app.inject({
      method: 'POST',
      url: '/api/probe-upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        origin: ctx.config.publicOrigin,
      },
      payload,
    })
    expect(missing.statusCode).toBe(403)
    expect(json<{ error: { code: string } }>(missing).error.code).toBe('FORBIDDEN')

    const ok = await app.inject({
      method: 'POST',
      url: '/api/probe-upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        origin: ctx.config.publicOrigin,
        'x-hub-csrf': '1',
      },
      payload,
    })
    expect(ok.statusCode).toBe(200)
  })

  it('GET 不受 CSRF 限制，/api 之外的路径也不检查', async () => {
    app.get('/api/probe-get', async () => ({ ok: true }))
    app.post('/not-api/probe', async () => ({ ok: true }))
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/probe-get',
          headers: { origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/not-api/probe',
          headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
          payload: 'x',
        })
      ).statusCode,
    ).toBe(200)
  })

  it('PATCH/PUT 同样受保护', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/probe-put',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})
