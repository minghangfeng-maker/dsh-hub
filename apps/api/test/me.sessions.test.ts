import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { SESSION_TTL_DAYS } from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { errorCode, getJson, patchJson, postJson } from './wp1-helpers.js'

let ctx: TestApp
let app: FastifyInstance
let alice: TestUser

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  alice = await createUser(app, { username: 'alice', password: 'Alice-pass-1' })
})

afterEach(async () => {
  await ctx.close()
})

function sessionRow(id: string) {
  return app.deps.db.get<{ expires_at: string; last_seen_at: string; revoked_at: string | null }>(
    'SELECT expires_at, last_seen_at, revoked_at FROM sessions WHERE id = ?',
    id,
  )
}

describe('登录设备与会话（04 §3 / 10 §B6）', () => {
  it('设备列表把人话描述、IP、当前设备标出来', async () => {
    const desktop = loginAs(app, alice, {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      ip: '203.0.113.1',
    })
    loginAs(app, alice, {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ip: '203.0.113.2',
    })

    const res = await getJson(app, '/api/me/sessions', { headers: desktop.headers })
    expect(res.statusCode).toBe(200)
    const items = json<{
      items: { id: string; current: boolean; device: string; ip: string | null; userAgent: string | null }[]
    }>(res).items
    expect(items).toHaveLength(2)
    const current = items.find((item) => item.current)
    expect(current?.device).toBe('桌面 Chrome')
    expect(current?.ip).toBe('203.0.113.1')
    expect(items.find((item) => !item.current)?.device).toBe('iPhone Safari')
  })

  it('下线某个会话：只能操作自己的会话（别人的 → 404）', async () => {
    const bob = await createUser(app, { username: 'bob' })
    const bobSession = loginAs(app, bob)
    const aliceSession = loginAs(app, alice)

    const foreign = await app.inject({
      method: 'DELETE',
      url: `/api/me/sessions/${bobSession.sessionId}`,
      headers: aliceSession.headers,
    })
    expect(foreign.statusCode).toBe(404)
    expect(errorCode(json(foreign))).toBe('NOT_FOUND')

    const own = await app.inject({
      method: 'DELETE',
      url: `/api/me/sessions/${bobSession.sessionId}`,
      headers: bobSession.headers,
    })
    expect(own.statusCode).toBe(204)
    expect(sessionRow(bobSession.sessionId)?.revoked_at).toBeTruthy()
    expect((await getJson(app, '/api/me/sessions', { headers: bobSession.headers })).statusCode).toBe(401)

    const actions = app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs').map((r) => r.action)
    expect(actions).toContain('user.sessions.revoke')
  })

  it('退出其他所有设备：只留当前会话', async () => {
    const current = loginAs(app, alice, { userAgent: 'Mozilla/5.0 Chrome/141.0' })
    const other = loginAs(app, alice, { userAgent: 'Mozilla/5.0 Firefox/130.0' })

    const res = await postJson(app, '/api/me/sessions/revoke-others', {}, { headers: current.headers })
    expect(res.statusCode, res.body).toBe(200)
    expect(json<{ revoked: number }>(res).revoked).toBe(1)
    expect(sessionRow(other.sessionId)?.revoked_at).toBeTruthy()
    expect((await getJson(app, '/api/me/sessions', { headers: current.headers })).statusCode).toBe(200)
  })

  it('B6 改密后其他会话立即失效，当前会话保留', async () => {
    const current = loginAs(app, alice)
    const other = loginAs(app, alice)

    const res = await postJson(
      app,
      '/api/me/password',
      { currentPassword: 'Alice-pass-1', newPassword: 'Another-pass-2' },
      { headers: current.headers },
    )
    expect(res.statusCode, res.body).toBe(204)

    expect((await getJson(app, '/api/auth/me', { headers: other.headers })).statusCode).toBe(401)
    expect((await getJson(app, '/api/auth/me', { headers: current.headers })).statusCode).toBe(200)

    // 旧密码不能登录，新密码可以
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice', password: 'Alice-pass-1' })).statusCode,
    ).toBe(401)
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice', password: 'Another-pass-2' })).statusCode,
    ).toBe(200)
  })

  it('改密的边界：当前密码错 → WRONG_PASSWORD；新密码弱/与旧相同 → WEAK_PASSWORD', async () => {
    const session = loginAs(app, alice)
    const wrong = await postJson(
      app,
      '/api/me/password',
      { currentPassword: 'nope-nope-nope', newPassword: 'Another-pass-2' },
      { headers: session.headers },
    )
    expect(wrong.statusCode).toBe(400)
    expect(errorCode(json(wrong))).toBe('WRONG_PASSWORD')

    const weak = await postJson(
      app,
      '/api/me/password',
      { currentPassword: 'Alice-pass-1', newPassword: 'password123' },
      { headers: session.headers },
    )
    expect(weak.statusCode).toBe(400)
    expect(errorCode(json(weak))).toBe('WEAK_PASSWORD')

    const same = await postJson(
      app,
      '/api/me/password',
      { currentPassword: 'Alice-pass-1', newPassword: 'Alice-pass-1' },
      { headers: session.headers },
    )
    expect(same.statusCode).toBe(400)
    expect(errorCode(json(same))).toBe('WEAK_PASSWORD')
    expect(
      json<{ error: { details: { reasons: string[] } } }>(same).error.details.reasons.join(),
    ).toContain('当前密码')
  })

  it('滑动续期：last_seen_at 超过 1 小时才延长 expires_at（02 §5）', async () => {
    const session = loginAs(app, alice)
    const twoHoursAgo = new Date(Date.parse(ctx.clock.nowIso()) - 2 * 3_600_000).toISOString()
    const tomorrow = new Date(Date.parse(ctx.clock.nowIso()) + 86_400_000).toISOString()
    app.deps.db.run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      twoHoursAgo,
      tomorrow,
      session.sessionId,
    )
    expect((await getJson(app, '/api/auth/me', { headers: session.headers })).statusCode).toBe(200)
    const row = sessionRow(session.sessionId)!
    expect(row.last_seen_at).toBe(ctx.clock.nowIso())
    const expected = new Date(Date.parse(ctx.clock.nowIso()) + SESSION_TTL_DAYS * 86_400_000).toISOString()
    expect(row.expires_at).toBe(expected)

    // 刚刷新的会话再请求一次不会重复延长（1 小时节流）
    ctx.clock.advance(60_000)
    await getJson(app, '/api/auth/me', { headers: session.headers })
    expect(sessionRow(session.sessionId)?.expires_at).toBe(expected)
  })

  it('管理员会话有 12 小时绝对上限，滑动续期不越过它', async () => {
    const admin = await createUser(app, { username: 'boss', role: 'admin' })
    const session = loginAs(app, admin)
    const created = ctx.clock.nowIso()
    const twoHoursAgo = new Date(Date.parse(created) - 2 * 3_600_000).toISOString()
    // 会话仍然有效（created+1h），但 last_seen_at 是 2 小时前 → 触发滑动续期
    const stillValid = new Date(Date.parse(created) + 3_600_000).toISOString()
    app.deps.db.run(
      'UPDATE sessions SET created_at = ?, last_seen_at = ?, expires_at = ? WHERE id = ?',
      created,
      twoHoursAgo,
      stillValid,
      session.sessionId,
    )
    const me = await getJson(app, '/api/auth/me', { headers: session.headers })
    expect(me.statusCode).toBe(200)
    const expected = new Date(Date.parse(created) + 12 * 3_600_000).toISOString()
    expect(sessionRow(session.sessionId)?.expires_at).toBe(expected)
  })

  it('PATCH /api/me 与改密都要求登录', async () => {
    expect((await patchJson(app, '/api/me', { displayName: 'x' })).statusCode).toBe(401)
    expect(
      (
        await postJson(app, '/api/me/password', {
          currentPassword: 'Alice-pass-1',
          newPassword: 'Another-pass-2',
        })
      ).statusCode,
    ).toBe(401)
    expect((await getJson(app, '/api/me/sessions')).statusCode).toBe(401)
  })
})
