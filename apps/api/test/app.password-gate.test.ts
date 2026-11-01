import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, loginAs, type TestApp } from './helpers.js'

let ctx: TestApp
let app: FastifyInstance

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  // 白名单内（GET /api/me*）的探针：WP1 已实现真实的 /api/me，但探针路径不冲突，保留它验证前缀匹配
  app.get('/api/me/probe', async () => ({ ok: true }))
  // 白名单外
  app.post('/api/me-not-allowed/probe', async () => ({ ok: true }))
})

afterEach(async () => {
  await ctx.close()
})

describe('MUST_CHANGE_PASSWORD 拦截（04 §0.2）', () => {
  it('强制改密用户只能访问白名单接口', async () => {
    const user = await createUser(app, { username: 'temp-pass', mustChangePassword: true })
    const session = loginAs(app, user)

    // 白名单外：POST /api/me/* （`/api/me/instance/start` 归 WP2，合并后自动落入同一规则）
    for (const [method, url] of [
      ['POST', '/api/me-not-allowed/probe'],
      ['GET', '/api/admin/users'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: session.headers,
        payload: method === 'GET' ? undefined : {},
      })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(json<{ error: { code: string } }>(res).error.code).toBe('MUST_CHANGE_PASSWORD')
    }

    // 白名单：都能进到 handler（各自业务错误不算被拦截）；logout 放最后，它会吊销当前会话
    const allowed: [
      method: 'GET' | 'PATCH' | 'POST',
      url: string,
      payload: Record<string, unknown> | undefined,
      expected: number,
    ][] = [
      ['GET', '/api/me/probe', undefined, 200],
      ['PATCH', '/api/me', {}, 200],
      ['POST', '/api/me/password', { currentPassword: 'wrong-pass', newPassword: 'Str0ng-pass-1' }, 400],
      ['POST', '/api/auth/logout', {}, 204],
    ]
    for (const [method, url, payload, expected] of allowed) {
      const res = await app.inject({ method, url, headers: session.headers, payload })
      expect(res.statusCode, `${method} ${url} → ${res.body}`).toBe(expected)
      if (res.statusCode === 403) {
        expect(json<{ error: { code: string } }>(res).error.code).not.toBe('MUST_CHANGE_PASSWORD')
      }
    }
  })

  it('普通用户与匿名请求不受影响', async () => {
    const normal = await createUser(app, { username: 'normal-user' })
    const session = loginAs(app, normal)
    // 普通用户过了改密闸门，接着被 requireAdmin 拦住（403 FORBIDDEN，而不是 MUST_CHANGE_PASSWORD）
    const asUser = await app.inject({ method: 'GET', url: '/api/admin/users', headers: session.headers })
    expect(asUser.statusCode).toBe(403)
    expect(json<{ error: { code: string } }>(asUser).error.code).toBe('FORBIDDEN')
    // 匿名：401 UNAUTHENTICATED
    expect((await app.inject({ method: 'GET', url: '/api/admin/users' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/public/site' })).statusCode).toBe(200)
  })

  it('公开接口与健康检查即使在强制改密时也放行', async () => {
    const user = await createUser(app, { username: 'temp-pass-2', mustChangePassword: true })
    const session = loginAs(app, user)
    expect(
      (await app.inject({ method: 'GET', url: '/api/public/site', headers: session.headers })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/api/health', headers: session.headers })).statusCode,
    ).toBe(200)
  })
})
