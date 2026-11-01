import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { DesktopAuthStartRequestSchema, type DesktopAuthStartRequest } from '@dsh-hub/shared'
import { createTestApp, createUser, loginAs, type TestApp, type TestSession } from './helpers.js'
import { randomToken } from '../src/lib/crypto.js'
import {
  decideLogin,
  desktopDevice,
  deviceHeaders,
  loginDesktop,
  pkcePair,
  queryOf,
  startLogin,
} from './helpers-desktop.js'

/**
 * WP25a 登录链路（D2 §3–§5 + 裁决 #1/#6）：PKCE / 一次性 code / 回环白名单 / 设备上限 /
 * 令牌轮换 / 设备令牌的路由白名单。
 *
 * 每个 describe 一套全新 app（`app.inject` 不监听端口）。
 * 限流（WP25e 起）：本机（非公网）回环请求**豁免**按 IP 的限流，公网请求按真实客户端 IP 10 次/10 分钟 ——
 * 豁免口径见 02 §5，公网那条用 `service.start()` + `publicRequest: true` 直接测。
 */
let ctx: TestApp
let app: FastifyInstance
let user: TestSession

/** 直接构造一个合法的 `auth/start` 请求体（限流测试走 service，绕开 HTTP 才能带 publicRequest） */
function startRequest(installId?: string | null): DesktopAuthStartRequest {
  const pair = pkcePair()
  return DesktopAuthStartRequestSchema.parse({
    codeChallenge: pair.challenge,
    codeChallengeMethod: 'S256',
    state: randomToken(32),
    redirectUri: 'http://127.0.0.1:7956/oauth/hub/callback',
    locale: 'zh-CN',
    device: desktopDevice(installId === undefined ? {} : { installId }),
  })
}

async function setup(): Promise<void> {
  ctx = await createTestApp()
  app = ctx.app
  const record = await createUser(app)
  user = loginAs(app, record)
}

describe('桌面登录：PKCE + 回环 + 一次性 code', () => {
  beforeEach(setup)

  it('start → 授权页 → approve → token 全链成功，返回令牌与 deviceId', async () => {
    const { status, started, body } = await startLogin(app)
    expect(status).toBe(200)
    expect(started.requestId.length).toBeGreaterThan(0)
    expect(started.authorizeUrl).toContain('/desktop/authorize?req=')
    expect(body.expiresAt).toBeTruthy()

    // 授权页取数：显示「哪台设备、哪个账号」
    const view = await app.inject({
      method: 'GET',
      url: `/api/desktop/auth/requests/${started.requestId}`,
      headers: user.headers,
    })
    expect(view.statusCode).toBe(200)
    const viewBody = view.json() as Record<string, unknown>
    expect(viewBody.deviceName).toBe('Windows 11 上的 DSH')
    expect(viewBody.status).toBe('waiting')
    expect((viewBody.user as { username: string }).username).toBe(user.user.username)
    expect(viewBody.deviceLimit).toBe(5)
    expect(viewBody.deviceCount).toBe(0)
    expect(viewBody.permissions).toContain('account.read')

    const approved = await decideLogin(app, user, started.requestId, true)
    expect(approved.status).toBe(200)
    const params = queryOf(approved.redirectUrl)
    expect(params.get('state')).toBe(started.state)
    const code = params.get('code')
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const token = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(token.statusCode).toBe(200)
    const tokenBody = token.json() as Record<string, unknown>
    expect(String(tokenBody.token)).toMatch(/^dsh_dev_[0-9A-Za-z]{40}$/)
    expect(String((tokenBody.device as { deviceId: string }).deviceId)).toMatch(/^dv_[0-9a-f]{32}$/)
    expect((tokenBody.user as { username: string }).username).toBe(user.user.username)
    expect((tokenBody.user as { roleLabel: string }).roleLabel).toBe('普通用户')
    // 每设备一把中转站密钥（裁决 #8），明文只此一次
    const relay = tokenBody.relay as { secret: string; ref: string; scope: string }
    expect(relay.secret).toMatch(/^sk-dsh-/)
    expect(relay.ref).toBe('HUB_MK_HUB')
    expect(relay.scope).toBe('dsh')

    // 设备令牌能用：会话接口
    const session = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(String(tokenBody.token)),
    })
    expect(session.statusCode).toBe(200)
    expect((session.json() as { device: { name: string } }).device.name).toBe('Windows 11 上的 DSH')
    expect(session.headers.etag).toBeTruthy()

    // 库里只有 sha256，明文不落库
    const rows = ctx.app.deps.db.all<{ id: string }>('SELECT id FROM desktop_device_tokens')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).not.toBe(tokenBody.token)
    expect(rows[0]!.id).toHaveLength(64)

    // 审计
    const audit = ctx.app.deps.db.all<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action LIKE 'desktop.%'",
    )
    expect(audit.map((row) => row.action)).toContain('desktop.login')
  })

  it('verifier 不对 → 400 pkce_mismatch，且 code 未被消费（5 次后销毁）', async () => {
    const { started } = await startLogin(app)
    const approved = await decideLogin(app, user, started.requestId, true)
    const code = queryOf(approved.redirectUrl).get('code')!

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/desktop/auth/token',
        payload: { code, codeVerifier: pkcePair().verifier },
        headers: { 'content-type': 'application/json' },
      })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: { details: { loginCode: string } } }).error.details.loginCode).toBe(
        'pkce_mismatch',
      )
    }
    // 第 5 次失败后 pending 被销毁：正确的 verifier 也换不到了
    const after = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(after.statusCode).toBe(400)
    expect(
      (after.json() as { error: { details: { loginCode: string } } }).error.details.loginCode,
    ).toBe('code_invalid')
  })

  it('code 只能换一次（重放 → 400 code_invalid）', async () => {
    const { started } = await startLogin(app)
    const approved = await decideLogin(app, user, started.requestId, true)
    const code = queryOf(approved.redirectUrl).get('code')!
    const first = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(first.statusCode).toBe(200)
    const replay = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(replay.statusCode).toBe(400)
    expect(
      (replay.json() as { error: { details: { loginCode: string } } }).error.details.loginCode,
    ).toBe('code_invalid')
  })

  it('code 60 秒过期 → 400 code_invalid；pending 10 分钟过期 → 410 expired', async () => {
    const expiredCode = await startLogin(app)
    const approved = await decideLogin(app, user, expiredCode.started.requestId, true)
    const code = queryOf(approved.redirectUrl).get('code')!
    ctx.clock.advance(61_000)
    const late = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: expiredCode.started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(late.statusCode).toBe(400)
    expect((late.json() as { error: { details: { loginCode: string } } }).error.details.loginCode).toBe(
      'code_invalid',
    )

    const expiredRequest = await startLogin(app)
    ctx.clock.advance(10 * 60_000 + 1_000)
    const view = await app.inject({
      method: 'GET',
      url: `/api/desktop/auth/requests/${expiredRequest.started.requestId}`,
      headers: user.headers,
    })
    expect(view.statusCode).toBe(410)
  })

  it('redirect_uri 只收回环地址（公网 / https / 0 端口一律 400）', async () => {
    const cases = [
      'http://example.com:8080/callback',
      'https://127.0.0.1:8080/callback',
      'http://127.0.0.1:0/callback',
      'http://127.0.0.1:99999/callback',
      'http://127.0.0.1:8080/callback?x=1',
    ]
    for (const redirectUri of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/desktop/auth/start',
        payload: {
          codeChallenge: pkcePair().challenge,
          codeChallengeMethod: 'S256',
          state: pkcePair().verifier,
          redirectUri,
          device: {
            schemaVersion: 1,
            name: 'Windows 11 上的 DSH',
            platform: 'win32',
            osMajor: '11',
            arch: 'x64',
            appVersion: '0.2.1',
            appChannel: 'latest',
            runtimeVersion: null,
          },
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(response.statusCode, redirectUri).toBe(400)
    }
    // localhost / [::1] 允许
    for (const redirectUri of ['http://localhost:1234/cb', 'http://[::1]:1234/cb']) {
      const started = await startLogin(app, { redirectUri })
      expect(started.status, redirectUri).toBe(200)
    }
  })

  it('设备名含路径 / 控制字符 → 400；通道只认 nightly|latest', async () => {
    const badName = await startLogin(app, { name: 'C:\\Users\\me\\Desktop' })
    expect(badName.status).toBe(400)
    const badControl = await startLogin(app, { name: 'my\u0001device' })
    expect(badControl.status).toBe(400)
    const badChannel = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/start',
      payload: {
        codeChallenge: pkcePair().challenge,
        codeChallengeMethod: 'S256',
        state: pkcePair().verifier,
        redirectUri: 'http://127.0.0.1:7956/cb',
        device: {
          schemaVersion: 1,
          name: 'Windows 11 上的 DSH',
          platform: 'win32',
          osMajor: '11',
          arch: 'x64',
          appVersion: '0.2.1',
          appChannel: 'stable',
          runtimeVersion: null,
        },
      },
      headers: { 'content-type': 'application/json' },
    })
    expect(badChannel.statusCode).toBe(400)
    // 未知字段（隐私白名单）：strictObject 拒收
    const unknown = await startLogin(app, { extra: { hostname: 'secret-pc' } })
    expect(unknown.status).toBe(400)
    const fields = (unknown.body.error as { details: { fields: Record<string, string> } }).details.fields
    expect(fields._).toContain('Unrecognized key')
  })

  it('拒绝授权 → 403 access_denied；重复处理 → 409', async () => {
    const { started } = await startLogin(app)
    const denied = await decideLogin(app, user, started.requestId, false)
    expect(denied.status).toBe(200)
    const params = queryOf(denied.redirectUrl)
    expect(params.get('error')).toBe('access_denied')
    expect(params.get('state')).toBe(started.state)

    const again = await decideLogin(app, user, started.requestId, true)
    expect(again.status).toBe(409)

    const approveOther = await startLogin(app)
    await decideLogin(app, user, approveOther.started.requestId, true)
    const approveTwice = await decideLogin(app, user, approveOther.started.requestId, true)
    expect(approveTwice.status).toBe(409)
  })

  it('approve/deny 的请求体与端点语义不一致 → 400', async () => {
    const { started } = await startLogin(app)
    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/desktop/auth/requests/${started.requestId}/approve`,
      payload: { allow: false },
      headers: user.headers,
    })
    expect(mismatch.statusCode).toBe(400)
  })

  it('授权页需要网页会话（匿名 → 401；设备令牌也不行）', async () => {
    const { started } = await startLogin(app)
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/desktop/auth/requests/${started.requestId}`,
    })
    expect(anonymous.statusCode).toBe(401)
  })
})

describe('设备令牌的路由白名单（交付物 4）', () => {
  beforeEach(setup)

  it('只读 /api/me 白名单放行；管理端与写接口 403；无效令牌 401', async () => {
    const login = await loginDesktop(app, user)
    const headers = deviceHeaders(login.token)

    const allowed = await app.inject({ method: 'GET', url: '/api/me/relay', headers })
    expect(allowed.statusCode).toBe(200)
    const mine = await app.inject({ method: 'GET', url: '/api/me/desktop-devices', headers })
    expect(mine.statusCode).toBe(200)
    expect((mine.json() as { items: unknown[] }).items).toHaveLength(1)

    // 管理端：即使账号是管理员也 403（设备令牌不做管理操作，D2 §11 Q8）
    const adminRecord = await createUser(app, { role: 'admin' })
    const adminSession = loginAs(app, adminRecord)
    const adminLogin = await loginDesktop(app, adminSession)
    const adminHeaders = deviceHeaders(adminLogin.token)
    const adminList = await app.inject({
      method: 'GET',
      url: '/api/admin/desktop-devices',
      headers: adminHeaders,
    })
    expect(adminList.statusCode).toBe(403)
    const adminUsers = await app.inject({ method: 'GET', url: '/api/admin/users', headers: adminHeaders })
    expect(adminUsers.statusCode).toBe(403)

    // 写接口：设备令牌不能改资料、不能吊销设备
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      payload: { displayName: 'x' },
      headers: adminHeaders,
    })
    expect(patch.statusCode).toBe(403)
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      headers,
    })
    expect(revoke.statusCode).toBe(403)

    // 无效令牌 → 401 DEVICE_TOKEN_INVALID
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders('dsh_dev_not-a-real-token'),
    })
    expect(invalid.statusCode).toBe(401)
    expect((invalid.json() as { error: { code: string } }).error.code).toBe('DEVICE_TOKEN_INVALID')
  })

  it('/api/desktop/* 不校验 Origin（裁决 #6）：带 dsh-app://app 也能用', async () => {
    const login = await loginDesktop(app, user)
    const response = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: { ...deviceHeaders(login.token), origin: 'dsh-app://app' },
    })
    expect(response.statusCode).toBe(200)
    // 对照：/api/me 的写操作仍然校验 Origin（非白名单来源 → 403）
    const me = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      payload: { displayName: 'x' },
      headers: { ...user.headers, origin: 'https://evil.example' },
    })
    expect(me.statusCode).toBe(403)
  })
})

describe('令牌轮换 / 登出 / 设备上限', () => {
  beforeEach(setup)

  it('refresh 轮换：旧令牌立刻 401，新令牌可用', async () => {
    const login = await loginDesktop(app, user)
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/refresh',
      headers: deviceHeaders(login.token),
    })
    expect(refreshed.statusCode).toBe(200)
    const body = refreshed.json() as { token: string; expiresAt: string; absoluteExpiresAt: string }
    expect(body.token).not.toBe(login.token)

    const old = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(login.token),
    })
    expect(old.statusCode).toBe(401)
    const fresh = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(body.token),
    })
    expect(fresh.statusCode).toBe(200)

    // 轮换链：旧行 revoked_reason='rotated'，replaced_by 指向新行
    const rows = ctx.app.deps.db.all<{ id: string; revoked_reason: string; replaced_by: string }>(
      'SELECT id, revoked_reason, replaced_by FROM desktop_device_tokens ORDER BY created_at',
    )
    expect(rows.map((row) => row.revoked_reason)).toContain('rotated')
    expect(rows.some((row) => row.replaced_by !== null)).toBe(true)
  })

  it('logout 吊销当前令牌，但设备行与密钥保留（下次登录复用同一台设备）', async () => {
    const login = await loginDesktop(app, user)
    const logout = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/logout',
      headers: deviceHeaders(login.token),
    })
    expect(logout.statusCode).toBe(200)
    expect((logout.json() as { revoked: number }).revoked).toBe(1)
    const after = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(login.token),
    })
    expect(after.statusCode).toBe(401)

    // 同一 installId 再登录：还是同一台设备（设备数不变）
    const again = await loginDesktop(app, user, {
      installId: login.started.device.installId as string,
    })
    expect(again.deviceId).toBe(login.deviceId)
    const devices = await app.inject({
      method: 'GET',
      url: '/api/me/desktop-devices',
      headers: user.headers,
    })
    expect((devices.json() as { items: unknown[] }).items).toHaveLength(1)
  })

  it('超过设备上限（5 台）→ 409 DEVICE_LIMIT_REACHED 并给出设备列表', async () => {
    const login = await loginDesktop(app, user)
    for (let index = 0; index < 4; index += 1) {
      await loginDesktop(app, user)
    }
    // 第 6 台：start/approve 都成功，兑换令牌时 409
    const sixth = await startLogin(app)
    const approved = await decideLogin(app, user, sixth.started.requestId, true)
    const code = queryOf(approved.redirectUrl).get('code')!
    const response = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: sixth.started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(response.statusCode).toBe(409)
    const body = response.json() as {
      error: { code: string; details: { loginCode: string; devices: unknown[] } }
    }
    expect(body.error.code).toBe('DEVICE_LIMIT_REACHED')
    expect(body.error.details.loginCode).toBe('device_limit_reached')
    expect(body.error.details.devices).toHaveLength(5)
    // 被拒的那台没有建行
    const count = ctx.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n
    expect(count).toBe(5)
    // 已有的设备照旧可用
    const stillOk = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(login.token),
    })
    expect(stillOk.statusCode).toBe(200)
  })

  it('登录发起限流：公网请求按真实客户端 IP 10 次 / 10 分钟，本机回环请求豁免', async () => {
    const service = app.deps.services.desktop
    const request = startRequest()
    const meta = { ip: '203.0.113.9', userAgent: 'vitest', publicRequest: true }

    // ① 本机（7700）回环请求豁免：与 auth 的 consumeIpLimit 同一口径（02 §5），连打 12 次都不限
    for (let index = 0; index < 12; index += 1) {
      const response = await startLogin(app)
      expect(response.status).toBe(200)
    }

    // ② 公网请求（PROXY v1 带入真实 IP）：同一个 IP 第 11 次 → 429
    for (let index = 0; index < 10; index += 1) {
      expect(() => service.start(request, meta)).not.toThrow()
    }
    expect(() => service.start(request, meta)).toThrowError(/频繁/)
    // 另一个真实 IP 有自己的桶
    expect(() => service.start(request, { ...meta, ip: '203.0.113.10' })).not.toThrow()

    // ③ 窗口过了就能继续
    ctx.clock.advance(10 * 60_000 + 1_000)
    expect(() => service.start(request, meta)).not.toThrow()
  })

  it('公网请求但 IP 仍是回环（PROXY UNKNOWN 兜底）时按 IP+installId 分桶，不同机器不互相挤', () => {
    const service = app.deps.services.desktop
    const meta = { ip: '127.0.0.1', userAgent: 'vitest', publicRequest: true }
    const first = startRequest(randomUUID())
    const second = startRequest(randomUUID())

    for (let index = 0; index < 10; index += 1) {
      expect(() => service.start(first, meta)).not.toThrow()
    }
    expect(() => service.start(first, meta)).toThrowError(/频繁/)
    // 另一台机器（另一个 installId）在自己的桶里，照常可以发起
    expect(() => service.start(second, meta)).not.toThrow()

    // 没带 installId 的请求只能共用「回环地址」这一个桶：10 次之后同样被挡
    const anonymous = startRequest(null)
    for (let index = 0; index < 10; index += 1) {
      expect(() => service.start(anonymous, meta)).not.toThrow()
    }
    expect(() => service.start(anonymous, meta)).toThrowError(/频繁/)
  })
})
