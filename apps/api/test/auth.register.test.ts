import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, json, type TestApp } from './helpers.js'
import {
  FIXED_IP,
  adminSession,
  createInvites,
  errorCode,
  nextIp,
  patchJson,
  postJson,
  register,
} from './wp1-helpers.js'

let ctx: TestApp
let app: FastifyInstance

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
})

afterEach(async () => {
  await ctx.close()
})

function setRegistration(patch: {
  mode?: 'open' | 'invite' | 'closed'
  requireApproval?: boolean
  maxUsers?: number
}): void {
  app.deps.settings.set('registration', {
    mode: 'invite',
    requireApproval: false,
    maxUsers: 50,
    ...patch,
  })
}

function inviteRow(id: number): { used_count: number; max_uses: number } | undefined {
  return app.deps.db.get<{ used_count: number; max_uses: number }>(
    'SELECT used_count, max_uses FROM invites WHERE id = ?',
    id,
  )
}

function auditActions(): string[] {
  return app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id').map((r) => r.action)
}

describe('注册（04 §2 / 10 §B1 B2）', () => {
  it('B1 mode=invite：无码/错码/过期码/停用码/用尽码都是 INVITE_INVALID，且邀请码计数不变', async () => {
    const admin = await adminSession(app)
    const [valid] = await createInvites(app, admin, { maxUses: 1 })
    const [expired] = await createInvites(app, admin, {
      maxUses: 5,
      expiresAt: '2020-01-01T00:00:00.000Z',
    })
    const [disabled] = await createInvites(app, admin, { maxUses: 5 })
    const disabledRes = await patchJson(
      app,
      `/api/admin/invites/${disabled!.id}`,
      { disabled: true },
      { headers: admin.headers },
    )
    expect(disabledRes.statusCode).toBe(200)

    const cases: [string, string | undefined][] = [
      ['no-code', undefined],
      ['wrong-code', 'AAAA2222BBBB'],
      ['expired-code', expired!.code],
      ['disabled-code', disabled!.code],
    ]
    for (const [username, code] of cases) {
      const res = await register(app, { username, inviteCode: code })
      expect(res.statusCode, `${username} → ${JSON.stringify(res.body)}`).toBe(400)
      expect(errorCode(res.body)).toBe('INVITE_INVALID')
    }

    // 用尽：第一次成功，第二次同码 INVITE_INVALID
    const first = await register(app, { username: 'used-once', inviteCode: valid!.code })
    expect(first.statusCode).toBe(201)
    const second = await register(app, { username: 'used-twice', inviteCode: valid!.code })
    expect(second.statusCode).toBe(400)
    expect(errorCode(second.body)).toBe('INVITE_INVALID')

    expect(inviteRow(valid!.id)).toEqual({ used_count: 1, max_uses: 1 })
    expect(inviteRow(expired!.id)?.used_count).toBe(0)
    expect(inviteRow(disabled!.id)?.used_count).toBe(0)
  })

  it('B2 有效码注册：201 + 自动登录 + 审计 + 使用记录可见', async () => {
    const admin = await adminSession(app)
    const [invite] = await createInvites(app, admin, { maxUses: 2, note: '给同事' })

    const res = await register(app, {
      username: 'newbie',
      displayName: '新来的',
      inviteCode: invite!.code.toLowerCase(), // 大小写不敏感
    })
    expect(res.statusCode, res.body ? JSON.stringify(res.body) : '').toBe(201)
    const body = res.body as {
      user: { id: number; slug: string; username: string; displayName: string; status: string }
      sessionStarted: boolean
    }
    expect(body.sessionStarted).toBe(true)
    expect(body.user.username).toBe('newbie')
    expect(body.user.displayName).toBe('新来的')
    expect(body.user.status).toBe('active')
    expect(body.user.slug).toMatch(/^u[a-z0-9]{7}$/)
    expect(res.setCookie).toContain('hub_sid=')

    // 会话可直接用（cookie 生效）
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: res.setCookie!.split(';')[0]! },
    })
    expect(me.statusCode).toBe(200)

    expect(auditActions()).toContain('auth.register')
    expect(inviteRow(invite!.id)?.used_count).toBe(1)
    const uses = app.deps.db.all<{ user_id: number; used_at: string }>(
      'SELECT user_id, used_at FROM invite_uses WHERE invite_id = ?',
      invite!.id,
    )
    expect(uses).toHaveLength(1)
    expect(uses[0]!.user_id).toBe(body.user.id)

    // 管理端列表里能看到使用记录
    const list = await app.inject({ method: 'GET', url: '/api/admin/invites', headers: admin.headers })
    const row = json<{ items: { id: number; uses: { username: string }[] }[] }>(list).items.find(
      (item) => item.id === invite!.id,
    )
    expect(row?.uses.map((u) => u.username)).toEqual(['newbie'])
  })

  it('同一个 max_uses=1 的码并发注册只有一个成功（10 §B1）', async () => {
    const admin = await adminSession(app)
    const [invite] = await createInvites(app, admin, { maxUses: 1 })

    const [first, second] = await Promise.all([
      register(app, { username: 'race-one', inviteCode: invite!.code, ip: nextIp() }),
      register(app, { username: 'race-two', inviteCode: invite!.code, ip: nextIp() }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([201, 400])
    expect(inviteRow(invite!.id)).toEqual({ used_count: 1, max_uses: 1 })
    expect(app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n).toBe(2) // admin + 1
  })

  it('mode=open 不需要邀请码；mode=closed 一律 REGISTRATION_CLOSED', async () => {
    setRegistration({ mode: 'open' })
    const open = await register(app, { username: 'open-user' })
    expect(open.statusCode).toBe(201)

    setRegistration({ mode: 'closed' })
    const closed = await register(app, { username: 'closed-user' })
    expect(closed.statusCode).toBe(403)
    expect(errorCode(closed.body)).toBe('REGISTRATION_CLOSED')
  })

  it('requireApproval：注册成功但不建会话，账号 pending（登录被 ACCOUNT_PENDING 挡住）', async () => {
    setRegistration({ mode: 'open', requireApproval: true })
    const res = await register(app, { username: 'wait-me' })
    expect(res.statusCode).toBe(201)
    expect((res.body as { sessionStarted: boolean }).sessionStarted).toBe(false)
    expect((res.body as { user: { status: string } }).user.status).toBe('pending')
    expect(res.setCookie).toBeUndefined()

    const login = await postJson(app, '/api/auth/login', { username: 'wait-me', password: 'Str0ng-pass-1' })
    expect(login.statusCode).toBe(403)
    expect(errorCode(json(login))).toBe('ACCOUNT_PENDING')
  })

  it('maxUsers 上限 → USER_LIMIT_REACHED', async () => {
    setRegistration({ mode: 'open', maxUsers: 2 })
    expect((await register(app, { username: 'limit-one' })).statusCode).toBe(201)
    expect((await register(app, { username: 'limit-two' })).statusCode).toBe(201)
    const third = await register(app, { username: 'limit-three' })
    expect(third.statusCode).toBe(403)
    expect(errorCode(third.body)).toBe('USER_LIMIT_REACHED')
  })

  it('B3 用户名：Admin/api → USERNAME_RESERVED；a/中文 → VALIDATION_FAILED', async () => {
    setRegistration({ mode: 'open' })
    const reserved = await register(app, { username: 'Admin' })
    expect(reserved.statusCode).toBe(400)
    expect(errorCode(reserved.body)).toBe('USERNAME_RESERVED')

    const reservedApi = await register(app, { username: 'api' })
    expect(errorCode(reservedApi.body)).toBe('USERNAME_RESERVED')

    const tooShort = await register(app, { username: 'a' })
    expect(tooShort.statusCode).toBe(400)
    expect(errorCode(tooShort.body)).toBe('VALIDATION_FAILED')
    expect(
      (tooShort.body as { error: { details?: { fields?: Record<string, string> } } }).error.details?.fields
        ?.username,
    ).toBeTruthy()

    const chinese = await register(app, { username: '中文' })
    expect(chinese.statusCode).toBe(400)
    expect(errorCode(chinese.body)).toBe('VALIDATION_FAILED')
  })

  it('用户名已占用 → USERNAME_TAKEN', async () => {
    setRegistration({ mode: 'open' })
    expect((await register(app, { username: 'occupied' })).statusCode).toBe(201)
    const again = await register(app, { username: 'occupied' })
    expect(again.statusCode).toBe(409)
    expect(errorCode(again.body)).toBe('USERNAME_TAKEN')
  })

  it('B4 弱口令 → WEAK_PASSWORD 且给出原因', async () => {
    setRegistration({ mode: 'open' })
    for (const password of ['12345678abc', 'password123']) {
      const res = await register(app, { username: `weak-${password.length}`, password })
      expect(res.statusCode, password).toBe(400)
      expect(errorCode(res.body)).toBe('WEAK_PASSWORD')
      expect((res.body as { error: { details: { reasons: string[] } } }).error.details.reasons.length).toBeGreaterThan(0)
    }
    const tooShort = await register(app, { username: 'weak-short', password: 'Ab1!x' })
    expect(errorCode(tooShort.body)).toBe('VALIDATION_FAILED')
  })

  it('注册限流：同 IP 3 次/小时、10 次/天（02 §5）', async () => {
    setRegistration({ mode: 'open' })
    let created = 0
    for (let hour = 0; hour < 4; hour += 1) {
      for (let i = 0; i < 3; i += 1) {
        const res = await register(app, { username: `rate-${hour}-${i}`, ip: FIXED_IP })
        if (created < 10) {
          expect(res.statusCode, `第 ${created + 1} 次：${JSON.stringify(res.body)}`).toBe(201)
          created += 1
        } else {
          expect(res.statusCode).toBe(429)
          expect(errorCode(res.body)).toBe('RATE_LIMITED')
          expect(
            (res.body as { error: { details: { retryAfterSec: number } } }).error.details.retryAfterSec,
          ).toBeGreaterThan(0)
        }
      }
      ctx.clock.advance(3_600_000)
    }
    expect(created).toBe(10)
  })

  it('回环地址豁免按 IP 的注册限流（02 §5），非回环照旧', async () => {
    setRegistration({ mode: 'open' })
    // 同一回环 IP 连续注册 6 个（远超 3 次/小时）都应成功
    for (let i = 0; i < 6; i += 1) {
      const res = await register(app, { username: `loopback-${i}`, ip: '127.0.0.1' })
      expect(res.statusCode, `第 ${i + 1} 次：${JSON.stringify(res.body)}`).toBe(201)
    }
    // IPv6 回环与 IPv4 映射形式同样豁免
    for (const [index, ip] of ['::1', '::ffff:127.0.0.1'].entries()) {
      const res = await register(app, { username: `loopback-v6-${index}`, ip })
      expect(res.statusCode, `${ip}：${JSON.stringify(res.body)}`).toBe(201)
    }
    // 非回环 IP 仍然受限：3 次/小时后第 4 次 429
    for (let i = 0; i < 3; i += 1) {
      expect((await register(app, { username: `public-ip-${i}`, ip: FIXED_IP })).statusCode).toBe(201)
    }
    const blocked = await register(app, { username: 'public-ip-4', ip: FIXED_IP })
    expect(blocked.statusCode).toBe(429)
    expect(errorCode(blocked.body)).toBe('RATE_LIMITED')
  })

  it('注册成功时会 provision 实例；provision 抛错不影响注册（WP2 未就绪）', async () => {
    setRegistration({ mode: 'open' })
    // 桩实现调用即抛 INTERNAL（同步抛，不返回 Promise），注册仍然成功
    let threw = false
    try {
      await app.deps.services.instances.provision(1)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const res = await register(app, { username: 'provision-fail' })
    expect(res.statusCode).toBe(201)
    expect((res.body as { user: { username: string } }).user.username).toBe('provision-fail')
  })

  it('注册后用户可被管理端列出，且 displayName 缺省用用户名', async () => {
    setRegistration({ mode: 'open' })
    await register(app, { username: 'no-display' })
    const admin = await adminSession(app)
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/users?q=no-display',
      headers: admin.headers,
    })
    const body = json<{ items: { username: string; displayName: string; instance: { status: string } }[] }>(list)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.displayName).toBe('no-display')
    // WP2 未就绪时实例摘要兜底为 absent（否则账号域接口会被实例域拖挂）
    // 注册即 provision（05 §6）：建目录、instances 行置 stopped，不建容器
    expect(body.items[0]!.instance.status).toBe('stopped')
  })
})

describe('check-username（04 §2）', () => {
  it('可用 / 保留 / 非法 / 已占用 四种结果', async () => {
    setRegistration({ mode: 'open' })
    await register(app, { username: 'taken-name' })

    const cases: [string, boolean, string | undefined][] = [
      ['fresh-name', true, undefined],
      ['Admin', false, 'reserved'],
      ['a', false, 'invalid'],
      ['taken-name', false, 'taken'],
    ]
    for (const [username, available, reason] of cases) {
      const res = await app.inject({ method: 'GET', url: `/api/auth/check-username?username=${username}` })
      expect(res.statusCode, username).toBe(200)
      const body = json<{ available: boolean; reason?: string }>(res)
      expect(body.available, username).toBe(available)
      expect(body.reason, username).toBe(reason)
    }
  })

  it('限流 30 次/分钟（第 31 次 RATE_LIMITED）', async () => {
    for (let i = 0; i < 30; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/auth/check-username?username=probe-${i}`,
        remoteAddress: FIXED_IP,
      })
      expect(res.statusCode).toBe(200)
    }
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/auth/check-username?username=probe-31',
      remoteAddress: FIXED_IP,
    })
    expect(blocked.statusCode).toBe(429)
    expect(errorCode(json(blocked))).toBe('RATE_LIMITED')

    // 回环地址不受按 IP 的限流影响（02 §5）
    const loopback = await app.inject({
      method: 'GET',
      url: '/api/auth/check-username?username=probe-loopback',
      remoteAddress: '127.0.0.1',
    })
    expect(loopback.statusCode).toBe(200)
    expect(json<{ available: boolean }>(loopback).available).toBe(true)
  })
})
