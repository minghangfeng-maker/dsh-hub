import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopMyDevicesResponse } from '@dsh-hub/shared'
import { MOBILE_ACCESS_TTL_MS } from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestSession, type TestUser } from './helpers.js'
import {
  bearerHeaders,
  EVIL_ORIGIN,
  MOBILE_APP_ORIGIN,
  mobileBootstrap,
  mobileLogin,
  mobileSession,
  refreshToken,
} from './helpers-mobile.js'
import { FIXED_IP, nextIp } from './wp1-helpers.js'

/** 手机 App 设备令牌（WP40a / v2 §4.1）：登录、轮换、重放、吊销、限流、Origin 与 CORS。 */

let ctx: TestApp
let alice: TestUser
let aliceSession: TestSession

beforeEach(async () => {
  ctx = await createTestApp()
  alice = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
  aliceSession = loginAs(ctx.app, alice)
})

afterEach(async () => {
  await ctx.close()
})

function deviceRows(): Array<{ device_id: string; kind: string; mobile_platform: string | null; name: string; status: string }> {
  return ctx.app.deps.db.all(
    'SELECT device_id, kind, mobile_platform, name, status FROM desktop_devices ORDER BY id',
  )
}

function tokenRows(): Array<{ id: string; revoked_at: string | null; revoked_reason: string | null }> {
  return ctx.app.deps.db.all('SELECT id, revoked_at, revoked_reason FROM desktop_device_tokens ORDER BY rowid')
}

describe('POST /api/mobile/auth/login', () => {
  it('成功：返回 dshm_at_/dshm_rt_、1 小时 access、60 天 refresh、user，并进设备台账（kind=mobile）', async () => {
    const result = await mobileLogin(ctx.app, alice, { deviceName: 'Pixel 8', platform: 'android' })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const tokens = result.tokens!
    expect(tokens.accessToken).toMatch(/^dshm_at_[0-9A-Za-z]{40}$/u)
    expect(tokens.refreshToken).toMatch(/^dshm_rt_[0-9A-Za-z]{40}$/u)
    expect(tokens.deviceId).toMatch(/^dv_[0-9a-f]{32}$/u)
    expect(tokens.user).toMatchObject({ id: alice.id, username: 'alice' })
    const accessMs = Date.parse(tokens.accessExpiresAt) - ctx.clock.now().getTime()
    expect(accessMs).toBe(MOBILE_ACCESS_TTL_MS)
    const refreshDays = (Date.parse(tokens.refreshExpiresAt) - ctx.clock.now().getTime()) / 86_400_000
    expect(Math.round(refreshDays)).toBe(60)

    // 库里只存 sha256：两条令牌行、都属于这台手机设备
    const tokensInDb = tokenRows()
    expect(tokensInDb).toHaveLength(2)
    expect(tokensInDb.every((row) => row.revoked_at === null)).toBe(true)
    expect(JSON.stringify(tokensInDb)).not.toContain(tokens.accessToken)

    expect(deviceRows()).toMatchObject([
      { device_id: tokens.deviceId, kind: 'mobile', mobile_platform: 'android', name: 'Pixel 8', status: 'active' },
    ])
    // 审计
    const actions = ctx.app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id').map((row) => row.action)
    expect(actions).toContain('mobile.login')
  })

  it('Bearer 能调 /bootstrap，且不需要 cookie；手机设备不进后端列表', async () => {
    const { headers, tokens } = await mobileSession(ctx.app, alice)
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.user.username).toBe('alice')
    expect(res.body.backends[0]).toMatchObject({ id: 'cloud:self', kind: 'cloud' })
    // 手机自己也在设备台账里，但它不是「后端」：backends 只有云实例（+ 用户自己的桌面节点）
    expect(res.body.backends.map((node) => node.id)).toEqual(['cloud:self'])
    expect(res.body.backends.every((node) => node.kind === 'cloud')).toBe(true)
    expect(tokens.deviceId).toMatch(/^dv_/)
  })

  it('密码错误 → 401 INVALID_CREDENTIALS，不写设备/令牌', async () => {
    const result = await mobileLogin(ctx.app, alice, { password: `wrong-${String(nextIp())}` })
    expect(result.status).toBe(401)
    expect(result.errorCode).toBe('INVALID_CREDENTIALS')
    expect(deviceRows()).toHaveLength(0)
    expect(tokenRows()).toHaveLength(0)
  })

  it('停用账号 → 403 USER_DISABLED；待审批 → 403 USER_PENDING；必须改密 → 403 MUST_CHANGE_PASSWORD', async () => {
    const disabled = await createUser(ctx.app, { username: 'bob', password: 'Bob-pass-1', status: 'disabled' })
    const pending = await createUser(ctx.app, { username: 'carol', password: 'Carol-pass-1', status: 'pending' })
    const mustChange = await createUser(ctx.app, {
      username: 'dave',
      password: 'Dave-pass-1',
      mustChangePassword: true,
    })

    const disabledResult = await mobileLogin(ctx.app, disabled, { ip: nextIp() })
    expect(disabledResult.status).toBe(403)
    expect(disabledResult.errorCode).toBe('USER_DISABLED')

    const pendingResult = await mobileLogin(ctx.app, pending, { ip: nextIp() })
    expect(pendingResult.status).toBe(403)
    expect(pendingResult.errorCode).toBe('USER_PENDING')

    const mustChangeResult = await mobileLogin(ctx.app, mustChange, { ip: '198.51.100.200' })
    expect(mustChangeResult.status).toBe(403)
    expect(mustChangeResult.errorCode).toBe('MUST_CHANGE_PASSWORD')
    expect(deviceRows()).toHaveLength(0)
  })

  it('同一用户名连输 5 次 → 第 6 次 429 RATE_LIMITED（锁定对 App 表现为限流）', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await mobileLogin(ctx.app, alice, { password: `wrong-pass-${String(i)}`, ip: '203.0.113.9' })
      expect(res.status).toBe(401)
    }
    const locked = await mobileLogin(ctx.app, alice, { password: 'wrong-pass-final', ip: '203.0.113.9' })
    expect(locked.status).toBe(429)
    expect(locked.errorCode).toBe('RATE_LIMITED')
    const details = (locked.body['error'] as { details?: { retryAfterSec?: number } }).details
    expect(details?.retryAfterSec ?? 0).toBeGreaterThan(0)
  })

  it('按 IP 限流：同一 IP 连打 10 次失败后第 11 次 429（回环豁免不适用于公网 IP）', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await mobileLogin(
        ctx.app,
        { username: `ghost-${String(i)}`, password: 'Whatever-1234' },
        { ip: FIXED_IP },
      )
      expect(res.status, `第 ${String(i + 1)} 次`).toBe(401)
    }
    const blocked = await mobileLogin(
      ctx.app,
      { username: 'ghost-final', password: 'Whatever-1234' },
      { ip: FIXED_IP },
    )
    expect(blocked.status).toBe(429)
    expect(blocked.errorCode).toBe('RATE_LIMITED')
  })

  it('回环地址豁免按 IP 的登录限流（与网页登录同一口径）', async () => {
    for (let i = 0; i < 12; i += 1) {
      const res = await mobileLogin(
        ctx.app,
        { username: `loopback-ghost-${String(i)}`, password: 'Whatever-1234' },
        { ip: '127.0.0.1' },
      )
      expect(res.status, `第 ${String(i + 1)} 次`).toBe(401)
    }
  })

  it('设备台账复用：令牌全过期后同一台手机重登复用同一 deviceId（不堆垃圾）', async () => {
    const first = await mobileSession(ctx.app, alice, { deviceName: 'Pixel 8' })
    // 60 天没打开：refresh 过期，但设备行还在（active）
    ctx.clock.advance(61 * 86_400_000)
    const second = await mobileSession(ctx.app, alice, { deviceName: 'Pixel 8' })
    expect(second.tokens.deviceId).toBe(first.tokens.deviceId)
    expect(deviceRows()).toHaveLength(1)
  })

  it('退出登录吊销的是整台设备：再登录是一台新设备（与契约「同时吊销本设备」一致）', async () => {
    const first = await mobileSession(ctx.app, alice, { deviceName: 'Pixel 8' })
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/auth/logout',
      headers: first.headers,
    })
    expect(logout.statusCode).toBe(204)
    const second = await mobileSession(ctx.app, alice, { deviceName: 'Pixel 8' })
    expect(second.tokens.deviceId).not.toBe(first.tokens.deviceId)
    expect(deviceRows()).toHaveLength(2)
    expect(deviceRows()[0]?.status).toBe('revoked')
  })

  it('两台同名手机并发登录 → 两台设备（不互相顶掉）', async () => {
    const one = await mobileSession(ctx.app, alice, { deviceName: 'Android 上的 DSH Hub' })
    const two = await mobileSession(ctx.app, alice, { deviceName: 'Android 上的 DSH Hub' })
    expect(two.tokens.deviceId).not.toBe(one.tokens.deviceId)
    expect(deviceRows()).toHaveLength(2)
    // 第一台的令牌仍然可用（没有被第二台轮换掉）
    const res = await mobileBootstrap(ctx.app, one.headers)
    expect(res.status).toBe(200)
  })
})

describe('POST /api/mobile/auth/refresh', () => {
  it('轮换：新 access 可用、旧 access 失效（DEVICE_TOKEN_INVALID，不是 DEVICE_REVOKED）', async () => {
    const first = await mobileSession(ctx.app, alice)
    const refreshed = await refreshToken(ctx.app, first.tokens.refreshToken)
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
    const next = refreshed.tokens!
    expect(next.deviceId).toBe(first.tokens.deviceId)
    expect(next.accessToken).not.toBe(first.tokens.accessToken)
    expect(next.refreshToken).not.toBe(first.tokens.refreshToken)

    const withNew = await mobileBootstrap(ctx.app, bearerHeaders(next.accessToken))
    expect(withNew.status).toBe(200)

    const withOld = await mobileBootstrap(ctx.app, bearerHeaders(first.tokens.accessToken))
    expect(withOld.status).toBe(401)
    expect(withOld.errorCode).toBe('DEVICE_TOKEN_INVALID')
  })

  it('旧 refresh 在 10 秒宽限期内重复使用：只回 401，不吊销设备（并发刷新不踢人）', async () => {
    const first = await mobileSession(ctx.app, alice)
    const refreshed = await refreshToken(ctx.app, first.tokens.refreshToken)
    expect(refreshed.status).toBe(200)
    // 同一时刻再拿旧 refresh 换一次（模拟 App 同时发了两枪）
    const raced = await refreshToken(ctx.app, first.tokens.refreshToken)
    expect(raced.status).toBe(401)
    expect(raced.errorCode).toBe('DEVICE_TOKEN_INVALID')
    // 设备还在：新令牌继续可用
    const still = await mobileBootstrap(ctx.app, bearerHeaders(refreshed.tokens!.accessToken))
    expect(still.status).toBe(200)
    expect(deviceRows()[0]?.status).toBe('active')
  })

  it('旧 refresh 超出宽限期被重放 → 吊销整个设备（DEVICE_REVOKED，设备行 revoked）', async () => {
    const first = await mobileSession(ctx.app, alice)
    const refreshed = await refreshToken(ctx.app, first.tokens.refreshToken)
    expect(refreshed.status).toBe(200)
    ctx.clock.advance(11_000)
    const replay = await refreshToken(ctx.app, first.tokens.refreshToken)
    expect(replay.status).toBe(401)
    expect(replay.errorCode).toBe('DEVICE_REVOKED')
    // 设备行与全部令牌都被吊销
    expect(deviceRows()[0]?.status).toBe('revoked')
    expect(tokenRows().every((row) => row.revoked_at !== null)).toBe(true)
    // 刚换到的 access token 也立刻失效
    const after = await mobileBootstrap(ctx.app, bearerHeaders(refreshed.tokens!.accessToken))
    expect(after.status).toBe(401)
    expect(after.errorCode).toBe('DEVICE_REVOKED')
    const actions = ctx.app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id').map((row) => row.action)
    expect(actions).toContain('mobile.auth.refresh-replay')
  })

  it('refresh 过期（60 天）→ 401 DEVICE_TOKEN_INVALID，设备不被吊销', async () => {
    const first = await mobileSession(ctx.app, alice)
    ctx.clock.advance(61 * 86_400_000)
    const expired = await refreshToken(ctx.app, first.tokens.refreshToken)
    expect(expired.status).toBe(401)
    expect(expired.errorCode).toBe('DEVICE_TOKEN_INVALID')
    expect(deviceRows()[0]?.status).toBe('active')
  })

  it('忘了带 refreshToken / 格式不对 → 400 VALIDATION_FAILED', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/auth/refresh',
      headers: { 'content-type': 'application/json', origin: MOBILE_APP_ORIGIN },
      payload: JSON.stringify({ refreshToken: 'nope' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('VALIDATION_FAILED')
  })
})

describe('令牌过期与吊销', () => {
  it('access 过期（1 小时）→ 401 DEVICE_TOKEN_INVALID（App 该去 refresh）', async () => {
    const { headers } = await mobileSession(ctx.app, alice)
    ctx.clock.advance(MOBILE_ACCESS_TTL_MS + 1_000)
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.status).toBe(401)
    expect(res.errorCode).toBe('DEVICE_TOKEN_INVALID')
  })

  it('网页端吊销设备 → 手机下一次请求 401 DEVICE_REVOKED；设备列表里能看到这台手机', async () => {
    const { headers, tokens } = await mobileSession(ctx.app, alice, { deviceName: 'Pixel 8', platform: 'android' })

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/desktop-devices',
      headers: aliceSession.headers,
    })
    const devices = json<DesktopMyDevicesResponse>(list)
    const mobile = devices.items.find((item) => item.deviceId === tokens.deviceId)
    expect(mobile).toMatchObject({ kind: 'mobile', mobilePlatform: 'android', name: 'Pixel 8', revokedAt: null })
    // 手机不占桌面设备的配额
    expect(devices.limit.used).toBe(0)

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/me/desktop-devices/${tokens.deviceId}`,
      headers: aliceSession.headers,
    })
    expect(revoke.statusCode).toBe(204)

    const after = await mobileBootstrap(ctx.app, headers)
    expect(after.status).toBe(401)
    expect(after.errorCode).toBe('DEVICE_REVOKED')
  })

  it('改密码（级联吊销令牌）→ 手机 401 DEVICE_REVOKED', async () => {
    const { headers } = await mobileSession(ctx.app, alice)
    ctx.app.deps.services.desktop.revokeTokensForUser(alice.id, 'password-change')
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.status).toBe(401)
    expect(res.errorCode).toBe('DEVICE_REVOKED')
  })
})

describe('POST /api/mobile/auth/logout', () => {
  it('Bearer → 204，设备与令牌全部吊销，再请求即 401 DEVICE_REVOKED', async () => {
    const { headers } = await mobileSession(ctx.app, alice)
    const res = await ctx.app.inject({ method: 'POST', url: '/api/mobile/auth/logout', headers })
    expect(res.statusCode).toBe(204)
    expect(deviceRows()[0]?.status).toBe('revoked')
    expect(tokenRows().every((row) => row.revoked_at !== null)).toBe(true)

    const after = await mobileBootstrap(ctx.app, headers)
    expect(after.status).toBe(401)
    expect(after.errorCode).toBe('DEVICE_REVOKED')
  })

  it('没有 Bearer（只有 cookie）→ 401 DEVICE_TOKEN_INVALID，不会静默假装成功', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/auth/logout',
      headers: { cookie: aliceSession.cookie, origin: MOBILE_APP_ORIGIN },
    })
    expect(res.statusCode).toBe(401)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('DEVICE_TOKEN_INVALID')
  })
})

describe('Origin / CSRF 豁免只对 Bearer 生效', () => {
  it('Bearer 带任意 Origin（含站外）→ 放行（裁决 #6 同款：没有 cookie 就没有 CSRF 面）', async () => {
    const { headers } = await mobileSession(ctx.app, alice)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/mobile/bootstrap',
      headers: { ...headers, origin: EVIL_ORIGIN },
    })
    expect(res.statusCode).toBe(200)
  })

  it('没有 Bearer 时，站外 Origin + cookie → 403（cookie 路径不能借豁免绕过）', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/instance/wake',
      headers: { cookie: aliceSession.cookie, origin: EVIL_ORIGIN, 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(403)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('FORBIDDEN')
  })

  it('免登录的 login 只接受配置里的 App 来源', async () => {
    const ok = await mobileLogin(ctx.app, alice, { origin: MOBILE_APP_ORIGIN })
    expect(ok.status).toBe(200)
    const blocked = await mobileLogin(ctx.app, alice, {
      origin: EVIL_ORIGIN,
      deviceName: 'Pixel 8',
    })
    expect(blocked.status).toBe(403)
  })

  it('手机令牌不能访问别的 API 前缀（403）', async () => {
    const { headers } = await mobileSession(ctx.app, alice)
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me', headers })
    expect(res.statusCode).toBe(403)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('FORBIDDEN')
  })
})

describe('CORS', () => {
  it('预检：App 来源 + Authorization 头 → 204 且回允许头', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/mobile/nodes',
      headers: {
        origin: MOBILE_APP_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(MOBILE_APP_ORIGIN)
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization')
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST')
  })

  it('预检：站外来源 → 403（不放行）', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/mobile/nodes',
      headers: { origin: EVIL_ORIGIN, 'access-control-request-method': 'GET' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('实际响应带 Access-Control-Allow-Origin（含错误响应）', async () => {
    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/mobile/nodes',
      headers: { cookie: aliceSession.cookie, origin: MOBILE_APP_ORIGIN },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['access-control-allow-origin']).toBe(MOBILE_APP_ORIGIN)

    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/mobile/nodes',
      headers: { origin: MOBILE_APP_ORIGIN, authorization: 'Bearer dshm_at_bogusbogusbogusbogus' },
    })
    expect(denied.statusCode).toBe(401)
    expect(denied.headers['access-control-allow-origin']).toBe(MOBILE_APP_ORIGIN)
  })
})

describe('旧 cookie 路径回归（0.2.0 APK）', () => {
  it('GET /api/mobile/nodes 用 cookie 仍然可用', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/mobile/nodes',
      headers: aliceSession.headers,
    })
    expect(res.statusCode).toBe(200)
    const body = json<{ items: Array<{ id: string }>; limits: { maxFrameBytes: number } }>(res)
    expect(body.items[0]?.id).toBe('cloud:self')
    expect(body.limits.maxFrameBytes).toBe(262_144)
  })

  it('cookie 路径不带 Origin（原生 OkHttp）也照旧工作', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/mobile/nodes',
      headers: { cookie: aliceSession.cookie },
    })
    expect(res.statusCode).toBe(200)
  })

  it('没有任何凭据 → 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/mobile/nodes' })
    expect(res.statusCode).toBe(401)
  })
})

describe('设备台账去重（0.2.9 真机反馈：一台手机显示成多条）', () => {
  function activeMobile(): Array<{ device_id: string; kind: string; name: string; status: string }> {
    return deviceRows().filter((row) => row.kind === 'mobile' && row.status === 'active')
  }

  it('同一 installId 重复登录：复用同一条设备记录，不新增台账', async () => {
    const first = await mobileLogin(ctx.app, alice, {
      deviceName: 'Android · 7SUN',
      installId: 'install-abc-123',
    })
    const second = await mobileLogin(ctx.app, alice, {
      deviceName: 'Android · 7SUN',
      installId: 'install-abc-123',
    })
    expect(second.status).toBe(200)
    expect(second.tokens!.deviceId).toBe(first.tokens!.deviceId)
    expect(activeMobile()).toHaveLength(1)
    expect(activeMobile()[0]).toMatchObject({ kind: 'mobile', name: 'Android · 7SUN' })
    // 旧令牌被轮换（同设备只留一对有效令牌）
    expect(tokenRows().filter((row) => row.revoked_at === null)).toHaveLength(2)
  })

  it('历史遗留：同名同平台的旧设备，在带 installId 登录时被合并吊销', async () => {
    // 老 App 行为：每次登录都新增一条（上一台还有有效令牌 → 不复用）
    await mobileLogin(ctx.app, alice, { deviceName: 'Android · 7SUN' })
    await mobileLogin(ctx.app, alice, { deviceName: 'Android · 7SUN' })
    expect(activeMobile()).toHaveLength(2)

    const third = await mobileLogin(ctx.app, alice, {
      deviceName: 'Android · 7SUN',
      installId: 'install-xyz-789',
    })
    const active = activeMobile()
    expect(active).toHaveLength(1)
    expect(active[0]!.device_id).toBe(third.tokens!.deviceId)
    const actions = ctx.app.deps.db
      .all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id')
      .map((row) => row.action)
    expect(actions).toContain('mobile.device.merge')
  })

  it('POST /auth/consolidate：已登录手机一键合并历史重复设备（幂等）', async () => {
    await mobileLogin(ctx.app, alice, { deviceName: 'Android · 7SUN' })
    const { tokens, headers } = await mobileSession(ctx.app, alice, { deviceName: 'Android · 7SUN' })
    expect(activeMobile()).toHaveLength(2)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/auth/consolidate',
      headers,
    })
    expect(res.statusCode).toBe(200)
    expect(json<{ removed: number }>(res as never).removed).toBe(1)
    const active = activeMobile()
    expect(active).toHaveLength(1)
    expect(active[0]!.device_id).toBe(tokens.deviceId)

    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/auth/consolidate',
      headers,
    })
    expect(json<{ removed: number }>(again as never).removed).toBe(0)
  })
})
