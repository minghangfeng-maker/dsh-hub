import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { errorCode, getJson, patchJson } from './wp1-helpers.js'

let ctx: TestApp
let app: FastifyInstance
let alice: TestUser

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  alice = await createUser(app, { username: 'alice', displayName: '爱丽丝' })
})

afterEach(async () => {
  await ctx.close()
})

function userRow(id: number) {
  return app.deps.db.get<{ username: string; display_name: string; bio: string; username_changed_at: string | null }>(
    'SELECT username, display_name, bio, username_changed_at FROM users WHERE id = ?',
    id,
  )
}

function auditActions(): string[] {
  return app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id').map((r) => r.action)
}

describe('个人资料 PATCH /api/me（04 §3）', () => {
  it('改昵称与简介：返回新资料、落库、写审计', async () => {
    const session = loginAs(app, alice)
    const res = await patchJson(
      app,
      '/api/me',
      { displayName: '新昵称', bio: '你好，我是爱丽丝' },
      { headers: session.headers },
    )
    expect(res.statusCode, res.body).toBe(200)
    const body = json<{ user: { displayName: string; bio: string; username: string } }>(res)
    expect(body.user.displayName).toBe('新昵称')
    expect(body.user.bio).toBe('你好，我是爱丽丝')
    expect(body.user.username).toBe('alice')
    expect(userRow(alice.id)).toMatchObject({ display_name: '新昵称', bio: '你好，我是爱丽丝' })
    expect(auditActions()).toContain('user.update')
  })

  it('改用户名：写入冷却起点并写 user.username.change 审计', async () => {
    const session = loginAs(app, alice)
    const res = await patchJson(app, '/api/me', { username: 'alice-new' }, { headers: session.headers })
    expect(res.statusCode, res.body).toBe(200)
    expect(json<{ user: { username: string } }>(res).user.username).toBe('alice-new')
    const row = userRow(alice.id)
    expect(row?.username).toBe('alice-new')
    expect(row?.username_changed_at).toBe(ctx.clock.nowIso())
    expect(auditActions()).toContain('user.username.change')
  })

  it('B10 30 天内第二次改用户名 → USERNAME_CHANGE_TOO_SOON；31 天后可再改', async () => {
    const session = loginAs(app, alice)
    expect((await patchJson(app, '/api/me', { username: 'alice-2' }, { headers: session.headers })).statusCode).toBe(
      200,
    )
    const tooSoon = await patchJson(app, '/api/me', { username: 'alice-3' }, { headers: session.headers })
    expect(tooSoon.statusCode).toBe(429)
    expect(errorCode(json(tooSoon))).toBe('USERNAME_CHANGE_TOO_SOON')
    expect(
      json<{ error: { details: { retryAfterSec: number } } }>(tooSoon).error.details.retryAfterSec,
    ).toBeGreaterThan(0)

    // 时间推进 31 天后会话本身也过期了，测试里顺手续上（会话过期另有用例覆盖）
    ctx.clock.advance(31 * 86_400_000)
    app.deps.db.run(
      'UPDATE sessions SET expires_at = ? WHERE id = ?',
      new Date(Date.parse(ctx.clock.nowIso()) + 86_400_000).toISOString(),
      session.sessionId,
    )
    const later = await patchJson(app, '/api/me', { username: 'alice-3' }, { headers: session.headers })
    expect(later.statusCode, later.body).toBe(200)
  })

  it('改成保留字 → USERNAME_RESERVED；改成别人的名字 → USERNAME_TAKEN', async () => {
    await createUser(app, { username: 'bob' })
    const session = loginAs(app, alice)
    const reserved = await patchJson(app, '/api/me', { username: 'Admin' }, { headers: session.headers })
    expect(reserved.statusCode).toBe(400)
    expect(errorCode(json(reserved))).toBe('USERNAME_RESERVED')

    const taken = await patchJson(app, '/api/me', { username: 'bob' }, { headers: session.headers })
    expect(taken.statusCode).toBe(409)
    expect(errorCode(json(taken))).toBe('USERNAME_TAKEN')
  })

  it('简介超过 200 字 → VALIDATION_FAILED + details.fields.bio', async () => {
    const session = loginAs(app, alice)
    const res = await patchJson(app, '/api/me', { bio: 'x'.repeat(201) }, { headers: session.headers })
    expect(res.statusCode).toBe(400)
    expect(errorCode(json(res))).toBe('VALIDATION_FAILED')
    expect(
      json<{ error: { details: { fields: Record<string, string> } } }>(res).error.details.fields.bio,
    ).toBeTruthy()
  })

  it('未登录 → 401；空 body 是合法的 no-op', async () => {
    expect((await patchJson(app, '/api/me', { displayName: 'x' })).statusCode).toBe(401)
    const session = loginAs(app, alice)
    const res = await patchJson(app, '/api/me', {}, { headers: session.headers })
    expect(res.statusCode).toBe(200)
    expect(json<{ user: { username: string } }>(res).user.username).toBe('alice')
  })

  it('GET /api/auth/me 返回 UserPublic + 实例摘要（WP2 未就绪时 absent）', async () => {
    const session = loginAs(app, alice)
    const res = await getJson(app, '/api/auth/me', { headers: session.headers })
    expect(res.statusCode).toBe(200)
    const body = json<{
      user: { username: string; displayName: string; avatarUrl: string | null; role: string }
      instance: { status: string; openUrl: string }
    }>(res)
    expect(body.user.username).toBe('alice')
    expect(body.user.avatarUrl).toBeNull()
    expect(body.user.role).toBe('user')
    expect(body.instance.status).toBe('absent')
    expect(body.instance.openUrl).toBe(`/dsh/${alice.username}/`)
  })
})
