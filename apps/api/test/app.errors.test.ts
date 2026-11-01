import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../src/app.js'
import { HubError } from '../src/lib/errors.js'
import { createTestApp, createUser, json, loginAs, type TestApp } from './helpers.js'

let ctx: TestApp
let app: FastifyInstance

const ProbeSchema = z.object({ username: z.string().min(3), age: z.number().int().min(18) })

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  app.get('/api/err/business', async () => {
    throw new HubError('USERNAME_TAKEN')
  })
  app.get('/api/err/business-details', async () => {
    throw new HubError('RATE_LIMITED', undefined, { retryAfterSec: 30 })
  })
  app.get('/api/err/zod', async () => {
    ProbeSchema.parse({ username: 'ab', age: 3 })
  })
  app.get('/api/err/unknown', async () => {
    throw new Error('内部实现细节：数据库密码是 hunter2')
  })
  app.get('/api/err/fastify', async () => {
    throw Object.assign(new Error('payload too large'), { statusCode: 413 })
  })
  app.get('/api/err/ok', async () => ({ ok: true }))
  app.delete('/api/err/no-content', async (_req, reply) => reply.code(204).send())
})

afterEach(async () => {
  await ctx.close()
})

describe('错误处理器（11 §5：业务错误统一 HubError）', () => {
  it('HubError → 对应状态码 + code + 中文文案', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/err/business' })
    expect(res.statusCode).toBe(409)
    expect(json(res)).toEqual({ error: { code: 'USERNAME_TAKEN', message: '用户名已被占用' } })
  })

  it('HubError 的 details 原样返回', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/err/business-details' })
    expect(res.statusCode).toBe(429)
    expect(json<{ error: { details: { retryAfterSec: number } } }>(res).error.details.retryAfterSec).toBe(30)
  })

  it('zod 校验失败 → 400 VALIDATION_FAILED + details.fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/err/zod' })
    expect(res.statusCode).toBe(400)
    const body = json<{
      error: { code: string; message: string; details: { fields: Record<string, string> } }
    }>(res)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.message).toBe('参数不合法')
    expect(Object.keys(body.error.details.fields).sort()).toEqual(['age', 'username'])
    expect(body.error.details.fields.username).toContain('3')
  })

  it('未知错误 → 500 INTERNAL，且不泄漏内部信息与堆栈', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/err/unknown' })
    expect(res.statusCode).toBe(500)
    const body = json<{ error: { code: string; message: string } }>(res)
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toBe('服务器内部错误')
    expect(res.body).not.toContain('hunter2')
    expect(res.body).not.toContain('at ')
    expect(res.body).not.toContain('stack')
  })

  it('Fastify 自带状态码错误按状态映射', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/err/fastify' })
    expect(res.statusCode).toBe(413)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('未知 /api 路径 → 404 NOT_FOUND 错误体', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(json(res)).toEqual({ error: { code: 'NOT_FOUND', message: '资源不存在' } })
  })

  it('所有 /api 响应都带 Cache-Control: no-store（含错误）', async () => {
    for (const url of ['/api/err/ok', '/api/err/business', '/api/does-not-exist']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.headers['cache-control'], url).toBe('no-store')
    }
  })

  it('带 JSON content-type 但空 body 的 POST 不报 400（04 里很多无请求体的 POST）', async () => {
    app.post('/api/err/empty-body', async (req) => ({ body: req.body ?? null }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/err/empty-body',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json<{ body: unknown }>(res).body).toBeNull()
  })

  it('非法 JSON 报 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/err/empty-body',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('VALIDATION_FAILED')
  })

  it('204 响应没有 body', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/err/no-content' })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })

  it('未登录访问受保护路由 → 401（requireUser 抛 HubError）', async () => {
    const user = await createUser(app, { username: 'probe-user' })
    const session = loginAs(app, user)
    app.get('/api/err/protected', { preHandler: requireUser }, async () => ({ ok: true }))
    expect((await app.inject({ method: 'GET', url: '/api/err/protected' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/api/err/protected', headers: session.headers })).statusCode,
    ).toBe(200)
  })
})
