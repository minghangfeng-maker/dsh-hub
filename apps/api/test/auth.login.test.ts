import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { FIXED_IP, adminSession, errorCode, getJson, postJson, register } from './wp1-helpers.js'

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

function auditActions(): string[] {
  return app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id').map((r) => r.action)
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie'])
  return raw.split(';')[0]!
}

describe('登录（04 §2 / 10 §B5 B7）', () => {
  it('成功登录：返回用户、写会话 cookie、更新 last_login_*、审计', async () => {
    const res = await postJson(app, '/api/auth/login', {
      username: 'ALICE', // 用户名大小写不敏感
      password: 'Alice-pass-1',
      remember: true,
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<{ user: { username: string; mustChangePassword: boolean } }>(res)
    expect(body.user.username).toBe('alice')
    expect(String(res.headers['set-cookie'])).toContain('hub_sid=')
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=')

    const row = app.deps.db.get<{ last_login_at: string | null; last_login_ip: string | null }>(
      'SELECT last_login_at, last_login_ip FROM users WHERE id = ?',
      alice.id,
    )
    expect(row?.last_login_at).toBe(ctx.clock.nowIso())
    expect(row?.last_login_ip).toBeTruthy()
    expect(auditActions()).toContain('auth.login.success')

    // 会话真的可用
    const me = await getJson(app, '/api/auth/me', { headers: { cookie: cookieOf(res) } })
    expect(me.statusCode).toBe(200)
    expect(json<{ user: { username: string }; instance: { status: string } }>(me).user.username).toBe('alice')
  })

  it('remember=false → cookie 不带 Max-Age（04 §2）', async () => {
    const res = await postJson(app, '/api/auth/login', { username: 'alice', password: 'Alice-pass-1' })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['set-cookie'])).not.toContain('Max-Age=')
  })

  it('密码错误 → 401 INVALID_CREDENTIALS，且审计 auth.login.failure', async () => {
    const res = await postJson(app, '/api/auth/login', { username: 'alice', password: 'wrong-password' })
    expect(res.statusCode).toBe(401)
    expect(errorCode(json(res))).toBe('INVALID_CREDENTIALS')
    expect(auditActions()).toContain('auth.login.failure')
  })

  it('用户不存在时也走一次假哈希（耗时与密码错误同量级）', async () => {
    const started = Date.now()
    const res = await postJson(app, '/api/auth/login', { username: 'ghost-user', password: 'Whatever-1234' })
    const elapsed = Date.now() - started
    expect(res.statusCode).toBe(401)
    expect(errorCode(json(res))).toBe('INVALID_CREDENTIALS')
    // scrypt(N=32768) 单次约 40ms；只要没走「用户不存在直接返回」的快路径就会 > 10ms
    expect(elapsed).toBeGreaterThan(10)
  })

  it('B5 同用户名连续失败 5 次 → 第 6 次 ACCOUNT_LOCKED，15 分钟后恢复', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const res = await postJson(
        app,
        '/api/auth/login',
        { username: 'alice', password: `wrong-${i}-password` },
        { ip: FIXED_IP },
      )
      expect(res.statusCode, `第 ${i} 次`).toBe(401)
    }
    const locked = await postJson(
      app,
      '/api/auth/login',
      { username: 'alice', password: 'Alice-pass-1' }, // 即使密码正确也先被锁挡住
      { ip: FIXED_IP },
    )
    expect(locked.statusCode).toBe(423)
    expect(errorCode(json(locked))).toBe('ACCOUNT_LOCKED')
    const details = json<{ error: { details: { retryAfterSec: number } } }>(locked).error.details
    expect(details.retryAfterSec).toBeGreaterThan(0)
    expect(details.retryAfterSec).toBeLessThanOrEqual(15 * 60)

    // 15 分钟（+1s）后恢复，且失败计数清零
    ctx.clock.advance(15 * 60_000 + 1000)
    const recovered = await postJson(
      app,
      '/api/auth/login',
      { username: 'alice', password: 'Alice-pass-1' },
      { ip: FIXED_IP },
    )
    expect(recovered.statusCode, recovered.body).toBe(200)
  })

  it('停用账号 → ACCOUNT_DISABLED；软删除账号 → INVALID_CREDENTIALS', async () => {
    const disabled = await createUser(app, { username: 'disabled-one', password: 'Disabled-1x', status: 'disabled' })
    const res = await postJson(app, '/api/auth/login', {
      username: 'disabled-one',
      password: 'Disabled-1x',
    })
    expect(res.statusCode).toBe(403)
    expect(errorCode(json(res))).toBe('ACCOUNT_DISABLED')

    const deleted = await createUser(app, { username: 'deleted-one', password: 'Deleted-1xx' })
    app.deps.db.run('UPDATE users SET deleted_at = ? WHERE id = ?', ctx.clock.nowIso(), deleted.id)
    const gone = await postJson(app, '/api/auth/login', { username: 'deleted-one', password: 'Deleted-1xx' })
    expect(gone.statusCode).toBe(401)
    expect(errorCode(json(gone))).toBe('INVALID_CREDENTIALS')
    void disabled
  })

  it('B7 管理员重置后的临时密码可登录，但只能访问改密页相关接口', async () => {
    const admin = await adminSession(app)
    // 重置前先拿一个旧会话，重置后它必须失效
    const old = loginAs(app, alice)
    // 重置需要 reauth
    const noReauth = await postJson(
      app,
      `/api/admin/users/${alice.id}/reset-password`,
      {},
      { headers: admin.headers },
    )
    expect(noReauth.statusCode).toBe(403)
    expect(errorCode(json(noReauth))).toBe('REAUTH_REQUIRED')

    const reauth = await postJson(
      app,
      '/api/auth/reauth',
      { password: admin.user.password },
      { headers: admin.headers },
    )
    expect(reauth.statusCode).toBe(204)

    const reset = await postJson(
      app,
      `/api/admin/users/${alice.id}/reset-password`,
      {},
      { headers: admin.headers },
    )
    expect(reset.statusCode, reset.body).toBe(200)
    const tempPassword = json<{ tempPassword: string }>(reset).tempPassword
    expect(tempPassword).toHaveLength(14)

    // 旧会话失效
    expect((await getJson(app, '/api/auth/me', { headers: old.headers })).statusCode).toBe(401)

    // 临时密码登录成功 → mustChangePassword=true
    const login = await postJson(app, '/api/auth/login', { username: 'alice', password: tempPassword })
    expect(login.statusCode, login.body).toBe(200)
    expect(json<{ user: { mustChangePassword: boolean } }>(login).user.mustChangePassword).toBe(true)
    const headers = { cookie: cookieOf(login) }

    // 白名单外被拦
    const blocked = await getJson(app, '/api/admin/users', { headers })
    expect(blocked.statusCode).toBe(403)
    expect(errorCode(json(blocked))).toBe('MUST_CHANGE_PASSWORD')

    // 改密后恢复正常
    const changed = await postJson(
      app,
      '/api/me/password',
      { currentPassword: tempPassword, newPassword: 'Brand-new-pass-9' },
      { headers },
    )
    expect(changed.statusCode, changed.body).toBe(204)
    const after = await getJson(app, '/api/auth/me', { headers })
    expect(after.statusCode).toBe(200)
    expect(json<{ user: { mustChangePassword: boolean } }>(after).user.mustChangePassword).toBe(false)
  })

  it('登录 IP 限流：10 次/10 分钟（第 11 次 RATE_LIMITED）', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await postJson(
        app,
        '/api/auth/login',
        { username: `ghost-${i}`, password: 'Whatever-1234' }, // 换用户名，只触发 IP 维度
        { ip: FIXED_IP },
      )
      expect(res.statusCode, `第 ${i + 1} 次`).toBe(401)
    }
    const blocked = await postJson(
      app,
      '/api/auth/login',
      { username: 'ghost-final', password: 'Whatever-1234' },
      { ip: FIXED_IP },
    )
    expect(blocked.statusCode).toBe(429)
    expect(errorCode(json(blocked))).toBe('RATE_LIMITED')
    expect(
      json<{ error: { details: { retryAfterSec: number } } }>(blocked).error.details.retryAfterSec,
    ).toBeGreaterThan(0)
  })

  it('回环地址豁免按 IP 的登录限流（02 §5），但按用户名的失败锁定照旧', async () => {
    // 回环 IP 连打 12 次不同用户名（超过 10 次/10 分钟）都不会被按 IP 限流
    for (let i = 0; i < 12; i += 1) {
      const res = await postJson(
        app,
        '/api/auth/login',
        { username: `loopback-ghost-${i}`, password: 'Whatever-1234' },
        { ip: '127.0.0.1' },
      )
      expect(res.statusCode, `第 ${i + 1} 次`).toBe(401)
      expect(errorCode(json(res))).toBe('INVALID_CREDENTIALS')
    }

    // 按用户名的失败锁定与 IP 无关，回环下依然生效：5 次失败 → 第 6 次 ACCOUNT_LOCKED
    for (let i = 0; i < 5; i += 1) {
      await postJson(
        app,
        '/api/auth/login',
        { username: 'alice', password: `wrong-${i}-password` },
        { ip: '127.0.0.1' },
      )
    }
    const locked = await postJson(
      app,
      '/api/auth/login',
      { username: 'alice', password: 'Alice-pass-1' },
      { ip: '127.0.0.1' },
    )
    expect(locked.statusCode).toBe(423)
    expect(errorCode(json(locked))).toBe('ACCOUNT_LOCKED')
  })

  it('登出：吊销会话 + 清 cookie + 审计', async () => {
    const login = await postJson(app, '/api/auth/login', { username: 'alice', password: 'Alice-pass-1' })
    const headers = { cookie: cookieOf(login) }
    const out = await postJson(app, '/api/auth/logout', {}, { headers })
    expect(out.statusCode).toBe(204)
    expect(String(out.headers['set-cookie'])).toContain('hub_sid=')
    expect((await getJson(app, '/api/auth/me', { headers })).statusCode).toBe(401)
    expect(auditActions()).toContain('auth.logout')
  })

  it('reauth：密码错误 → WRONG_PASSWORD；正确 → 204 并刷新 reauth_at', async () => {
    const session = loginAs(app, alice)
    const wrong = await postJson(
      app,
      '/api/auth/reauth',
      { password: 'not-the-password' },
      { headers: session.headers },
    )
    expect(wrong.statusCode).toBe(400)
    expect(errorCode(json(wrong))).toBe('WRONG_PASSWORD')

    const ok = await postJson(
      app,
      '/api/auth/reauth',
      { password: 'Alice-pass-1' },
      { headers: session.headers },
    )
    expect(ok.statusCode).toBe(204)
    const row = app.deps.db.get<{ reauth_at: string | null }>(
      'SELECT reauth_at FROM sessions WHERE id = ?',
      session.sessionId,
    )
    expect(row?.reauth_at).toBe(ctx.clock.nowIso())
  })

  it('注册后可直接用新账号登录（端到端）', async () => {
    app.deps.settings.set('registration', { mode: 'open', requireApproval: false, maxUsers: 50 })
    expect((await register(app, { username: 'e2e-user' })).statusCode).toBe(201)
    const login = await postJson(app, '/api/auth/login', { username: 'e2e-user', password: 'Str0ng-pass-1' })
    expect(login.statusCode, login.body).toBe(200)
  })
})
