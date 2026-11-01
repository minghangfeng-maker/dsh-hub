import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { clearSessionCookie, requireAdmin, requireUser, setSessionCookie } from '../src/app.js'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'

let ctx: TestApp
let app: FastifyInstance
let alice: TestUser

/** 测试专用探针：把 req.user 原样吐出来 */
function registerWhoami(app: FastifyInstance): void {
  app.get('/api/whoami', { preHandler: requireUser }, async (req) => ({
    user: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
    sessionId: req.session?.sessionId ?? null,
  }))
}

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  alice = await createUser(app, { username: 'alice', role: 'user' })
  registerWhoami(app)
})

afterEach(async () => {
  await ctx.close()
})

describe('会话解析钩子（02 §5）', () => {
  it('没有 cookie → req.user 为 null，requireUser 抛 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/whoami' })
    expect(res.statusCode).toBe(401)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('UNAUTHENTICATED')
  })

  it('有效会话 → req.user 就位', async () => {
    const session = loginAs(app, alice)
    const res = await app.inject({ method: 'GET', url: '/api/whoami', headers: session.headers })
    expect(res.statusCode).toBe(200)
    expect(json<{ user: { username: string } }>(res).user.username).toBe('alice')
    expect(json<{ sessionId: string }>(res).sessionId).toBe(session.sessionId)
  })

  it('伪造/过期/吊销/停用/软删 都当作未登录', async () => {
    const session = loginAs(app, alice)

    const forged = await app.inject({
      method: 'GET',
      url: '/api/whoami',
      headers: { cookie: 'hub_sid=not-a-real-token' },
    })
    expect(forged.statusCode).toBe(401)

    // 过期
    ctx.app.deps.db.run(
      "UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      session.sessionId,
    )
    expect(
      (await app.inject({ method: 'GET', url: '/api/whoami', headers: session.headers })).statusCode,
    ).toBe(401)

    // 吊销
    ctx.app.deps.db.run(
      "UPDATE sessions SET expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      session.sessionId,
    )
    expect(
      (await app.inject({ method: 'GET', url: '/api/whoami', headers: session.headers })).statusCode,
    ).toBe(200)
    ctx.app.deps.db.run(
      "UPDATE sessions SET revoked_at = '2026-10-12T14:00:00.000Z' WHERE id = ?",
      session.sessionId,
    )
    expect(
      (await app.inject({ method: 'GET', url: '/api/whoami', headers: session.headers })).statusCode,
    ).toBe(401)

    // 停用
    const bob = await createUser(app, { username: 'bob', status: 'disabled' })
    const bobSession = loginAs(app, bob)
    expect(
      (await app.inject({ method: 'GET', url: '/api/whoami', headers: bobSession.headers })).statusCode,
    ).toBe(401)

    // 软删除
    const carol = await createUser(app, { username: 'carol' })
    const carolSession = loginAs(app, carol)
    ctx.app.deps.db.run("UPDATE users SET deleted_at = '2026-10-12T14:00:00.000Z' WHERE id = ?", carol.id)
    expect(
      (await app.inject({ method: 'GET', url: '/api/whoami', headers: carolSession.headers })).statusCode,
    ).toBe(401)
  })

  it('last_seen_at 被节流刷新（同一分钟内只写一次）', async () => {
    const session = loginAs(app, alice)
    ctx.app.deps.db.run(
      "UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      session.sessionId,
    )
    await app.inject({ method: 'GET', url: '/api/whoami', headers: session.headers })
    const first = ctx.app.deps.db.get<{ last_seen_at: string }>(
      'SELECT last_seen_at FROM sessions WHERE id = ?',
      session.sessionId,
    )?.last_seen_at
    expect(first).toBe(ctx.clock.nowIso())

    ctx.clock.advance(10_000)
    await app.inject({ method: 'GET', url: '/api/whoami', headers: session.headers })
    const second = ctx.app.deps.db.get<{ last_seen_at: string }>(
      'SELECT last_seen_at FROM sessions WHERE id = ?',
      session.sessionId,
    )?.last_seen_at
    expect(second).toBe(first)

    ctx.clock.advance(60_000)
    await app.inject({ method: 'GET', url: '/api/whoami', headers: session.headers })
    const third = ctx.app.deps.db.get<{ last_seen_at: string }>(
      'SELECT last_seen_at FROM sessions WHERE id = ?',
      session.sessionId,
    )?.last_seen_at
    expect(third).toBe(ctx.clock.nowIso())
  })

  it('管理员角色能通过 requireAdmin 判定（路由用）', async () => {
    const admin = await createUser(app, { username: 'root-admin', role: 'admin' })
    const session = loginAs(app, admin)
    app.get('/api/admin-probe', { preHandler: requireAdmin }, async () => ({ ok: true }))
    const okRes = await app.inject({ method: 'GET', url: '/api/admin-probe', headers: session.headers })
    expect(okRes.statusCode).toBe(200)
    const userRes = await app.inject({
      method: 'GET',
      url: '/api/admin-probe',
      headers: loginAs(app, alice).headers,
    })
    expect(userRes.statusCode).toBe(403)
    const anonRes = await app.inject({ method: 'GET', url: '/api/admin-probe' })
    expect(anonRes.statusCode).toBe(401)
  })

  it('setSessionCookie / clearSessionCookie 的选项符合 02 §5', async () => {
    app.post('/api/test/set-cookie', async (req, reply) => {
      const remember = (req.body as { remember?: boolean } | undefined)?.remember ?? false
      setSessionCookie(reply, ctx.config, 'tok', {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        remember,
      })
      return { ok: true }
    })
    app.post('/api/test/clear-cookie', async (_req, reply) => {
      clearSessionCookie(reply)
      return { ok: true }
    })
    const rememberRes = await app.inject({
      method: 'POST',
      url: '/api/test/set-cookie',
      headers: { 'content-type': 'application/json' },
      payload: { remember: true },
    })
    const cookie = String(rememberRes.headers['set-cookie'])
    expect(cookie).toContain('hub_sid=tok')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=')
    // 阶段一是 http，所以不带 Secure（02 §5 的 Secure 由 HUB_COOKIE_SECURE 决定）
    expect(cookie).not.toContain('Secure')

    const sessionRes = await app.inject({
      method: 'POST',
      url: '/api/test/set-cookie',
      headers: { 'content-type': 'application/json' },
      payload: { remember: false },
    })
    expect(String(sessionRes.headers['set-cookie'])).not.toContain('Max-Age=')
    const clearRes = await app.inject({ method: 'POST', url: '/api/test/clear-cookie' })
    expect(String(clearRes.headers['set-cookie'])).toContain('hub_sid=')
  })
})
