import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, loginAs, type TestApp, type TestSession } from './helpers.js'
import {
  ANTHROPIC_NON_STREAM_BODY,
  OPENAI_NON_STREAM_BODY,
  createChannel,
  createRelayModel,
  grantMicro,
  jsonResponse,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'
import { deviceHeaders, loginDesktop, reportBody, startLogin } from './helpers-desktop.js'

/**
 * WP25a 设备台账（D6 §4/§5）：上报的 strictObject 白名单、限流、插件清单整表替换、
 * 每设备密钥的 `client_kind='desktop'`、吊销设备 = 令牌 + 密钥一起断、级联吊销。
 */
let ctx: TestApp
let app: FastifyInstance
let user: TestSession
let admin: TestSession

const META = { ip: '127.0.0.1', userAgent: 'vitest' }
const ACTOR = { actorId: 0, ip: '127.0.0.1', userAgent: 'vitest' }

async function setup(): Promise<void> {
  ctx = await createTestApp()
  app = ctx.app
  user = loginAs(app, await createUser(app))
  admin = loginAs(app, await createUser(app, { role: 'admin' }))
}

describe('设备上报（strictObject 白名单）', () => {
  beforeEach(setup)

  it('合法上报：写 last_report_at / 应用结果 / 插件清单，响应带 reportIntervalSec 与基线 desiredRevision', async () => {
    const login = await loginDesktop(app, user)
    const response = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({
        appliedRevision: 7,
        appliedAt: '2026-10-21T00:00:00.000Z',
        applyState: 'partial',
        applyErrorCode: 'plugin_install_failed',
        errorCount: 1,
        plugins: [
          { name: '@local/dsh-hub-connector', version: '0.2.1', source: 'hub-core', state: 'enabled' },
          { name: 'dsh-email', version: '0.16.0', source: 'user', state: 'disabled' },
          { name: 'dsh-memory', version: '0.16.1', source: 'hub-default', state: 'failed', errorCode: 'disk_full' },
        ],
      }),
      headers: deviceHeaders(login.token),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      reportIntervalSec: number
      desiredRevision: number | null
      presence: string
      serverTime: string
    }
    expect(body.reportIntervalSec).toBe(60)
    expect(body.reportIntervalSec).toBeLessThanOrEqual(900)
    // WP25b：没有任何下发时是基线 revision 1（客户端拿到 1 与本地 null 不同 → 会去拉一份空清单）
    expect(body.desiredRevision).toBe(1)
    expect(body.presence).toBe('online')
    expect(body.serverTime).toBeTruthy()

    const row = ctx.app.deps.db.get<{
      last_report_at: string
      applied_revision: number
      apply_state: string
      apply_error: string
      apply_error_count: number
    }>(
      'SELECT last_report_at, applied_revision, apply_state, apply_error, apply_error_count FROM desktop_devices WHERE device_id = ?',
      login.deviceId,
    )!
    expect(row.last_report_at).toBeTruthy()
    expect(row.applied_revision).toBe(7)
    expect(row.apply_state).toBe('partial')
    expect(row.apply_error).toBe('plugin_install_failed')
    expect(row.apply_error_count).toBe(1)

    const plugins = ctx.app.deps.db.all<{ package_name: string; state: string }>(
      'SELECT package_name, state FROM desktop_device_plugins WHERE device_id = ? ORDER BY package_name',
      login.deviceId,
    )
    expect(plugins.map((plugin) => plugin.package_name)).toEqual([
      '@local/dsh-hub-connector',
      'dsh-email',
      'dsh-memory',
    ])

    // 第二次上报只带一条插件 → 整表替换（先过掉最小上报间隔）
    ctx.clock.advance(11_000)
    const second = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({
        plugins: [{ name: 'dsh-email', version: '0.16.0', source: 'user', state: 'absent' }],
      }),
      headers: deviceHeaders(login.token),
    })
    expect(second.statusCode).toBe(200)
    const after = ctx.app.deps.db.all<{ package_name: string }>(
      'SELECT package_name FROM desktop_device_plugins WHERE device_id = ?',
      login.deviceId,
    )
    expect(after.map((plugin) => plugin.package_name)).toEqual(['dsh-email'])

    // 上报不写审计（心跳写审计 = 每天几万条噪音，D6 §7.4）
    const audit = ctx.app.deps.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'desktop.%'",
    )
    expect(audit[0]!.n).toBe(1) // 只有 desktop.login
  })

  it('未知字段 → 400 且 details.fields._ 指名（隐私白名单只有一个实现点）', async () => {
    const login = await loginDesktop(app, user)
    const response = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({ hostname: 'secret-pc', workdir: 'C:\\Users\\me\\proj' }),
      headers: deviceHeaders(login.token),
    })
    expect(response.statusCode).toBe(400)
    const body = response.json() as {
      error: { code: string; details: { fields: Record<string, string> } }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.fields._).toContain('Unrecognized key')
    // 一条都没落库
    const count = ctx.app.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM desktop_devices WHERE last_report_at IS NOT NULL',
    )!.n
    expect(count).toBe(0)
  })

  it('路径形状的设备名进不了库：report 里 name 是未知键；登录描述里的路径名被 DeviceNameSchema 拒收', async () => {
    const login = await loginDesktop(app, user)
    const asUnknownKey = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({ name: 'C:\\Users\\me\\Desktop' }),
      headers: deviceHeaders(login.token),
    })
    expect(asUnknownKey.statusCode).toBe(400)
    expect(
      (asUnknownKey.json() as { error: { details: { fields: Record<string, string> } } }).error.details
        .fields._,
    ).toContain('Unrecognized key')

    const atLogin = await startLogin(app, { name: 'link:C:\\Users\\me\\dsh-plugin' })
    expect(atLogin.status).toBe(400)
    const fields = (atLogin.body.error as { details: { fields: Record<string, string> } }).details.fields
    expect(fields['device.name']).toContain('路径分隔符')
  })

  it('非法枚举 / 插件超量 / 插件名带路径 → 400', async () => {
    const login = await loginDesktop(app, user)
    const badState = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({ applyState: 'installed' }),
      headers: deviceHeaders(login.token),
    })
    expect(badState.statusCode).toBe(400)

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({
        plugins: Array.from({ length: 201 }, (_, index) => ({
          name: `plugin-${String(index)}`,
          version: '1.0.0',
          source: 'user',
          state: 'enabled',
        })),
      }),
      headers: deviceHeaders(login.token),
    })
    expect(tooMany.statusCode).toBe(400)

    const pathName = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({
        plugins: [{ name: 'link:C:\\Users\\me\\p', version: '1.0.0', source: 'user', state: 'enabled' }],
      }),
      headers: deviceHeaders(login.token),
    })
    expect(pathName.statusCode).toBe(400)
  })

  it('上报节流：10 秒内第二次 → 429 retryAfterSec；过了最小间隔就能再报', async () => {
    const login = await loginDesktop(app, user)
    const first = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody(),
      headers: deviceHeaders(login.token),
    })
    expect(first.statusCode).toBe(200)
    const tooSoon = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody(),
      headers: deviceHeaders(login.token),
    })
    expect(tooSoon.statusCode).toBe(429)
    expect((tooSoon.json() as { error: { details: { retryAfterSec: number } } }).error.details.retryAfterSec)
      .toBeGreaterThan(0)
    ctx.clock.advance(11_000)
    const later = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody(),
      headers: deviceHeaders(login.token),
    })
    expect(later.statusCode).toBe(200)
    // reportIntervalSec 跟随设置，且永远 ≤900
    const settings = app.deps.settings.set('desktop', {
      ...app.deps.settings.get('desktop'),
      reportIntervalSec: 900,
    })
    expect(settings.reportIntervalSec).toBe(900)
    ctx.clock.advance(11_000)
    const capped = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody(),
      headers: deviceHeaders(login.token),
    })
    expect((capped.json() as { reportIntervalSec: number }).reportIntervalSec).toBe(900)
  })
})

describe('每设备密钥：client_kind=desktop、模式密钥、吊销即断', () => {
  let upstream: FakeUpstream

  beforeEach(async () => {
    await setup()
    upstream = await startFakeUpstream((_req, res) => {
      jsonResponse(res, 200, OPENAI_NON_STREAM_BODY)
    })
  })

  it('设备的中转站密钥调用 /v1 → 用量 client_kind=desktop 且扣积分', async () => {
    const channel = createChannel(app, {
      name: 'openai-fake',
      baseUrl: upstream.url,
      apis: ['openai-completions'],
      keys: ['up-openai-key'],
    })
    const model = await createRelayModel(app, {
      name: 'test-model',
      displayName: 'Test Model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      info: { name: 'Test Model', contextWindow: 128_000, maxTokens: 8_192 },
      routes: [{ channelId: channel.id, upstreamModel: 'upstream-model', enabled: true }],
    })
    expect(model.name).toBe('test-model')
    grantMicro(app, user.user.id, 1_000_000)

    const login = await loginDesktop(app, user)
    expect(login.relay?.secret).toMatch(/^sk-dsh-/)

    const call = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: false },
      headers: { authorization: `Bearer ${login.relay!.secret}` },
    })
    expect(call.statusCode).toBe(200)

    const usage = ctx.app.deps.db.get<{ client_kind: string; cost: number; key_id: number }>(
      'SELECT client_kind, cost, key_id FROM relay_usage ORDER BY id DESC LIMIT 1',
    )!
    expect(usage.client_kind).toBe('desktop')
    expect(usage.cost).toBeGreaterThan(0)

    const key = ctx.app.deps.db.get<{ device_id: string }>(
      'SELECT device_id FROM relay_keys WHERE id = ?',
      usage.key_id,
    )!
    expect(key.device_id).toBe(login.deviceId)

    // 用户自建密钥 → external（同一张表里的对照）
    const ownKey = app.deps.services.relay.createKey(user.user.id, { name: '自己的' }, user.user.id, META)
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: false },
      headers: { authorization: `Bearer ${ownKey.secret}` },
    })
    const kinds = ctx.app.deps.db
      .all<{ client_kind: string }>('SELECT client_kind FROM relay_usage ORDER BY id')
      .map((row) => row.client_kind)
    expect(kinds).toEqual(['desktop', 'external'])
  })

  it('模式密钥：未开通 → 403；开通后拿到 scope=claude-code 的密钥并能调 /v1/messages', async () => {
    // 先把 claude-code 作用域的渠道 + 模型建好（admin 身份）
    const channel = createChannel(app, {
      baseUrl: upstream.url,
      apis: ['anthropic-messages'],
      scope: 'claude-code',
      name: 'anthropic-fake',
      keys: ['up-claude-key'],
    })
    const model = await createRelayModel(app, {
      name: 'claude-test',
      displayName: 'Claude Test',
      scope: 'claude-code',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      info: { name: 'Claude Test', contextWindow: 200_000, maxTokens: 64_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'claude-upstream', enabled: true }],
    })
    grantMicro(app, user.user.id, 1_000_000)
    upstream.setHandler((_req, res) => jsonResponse(res, 200, ANTHROPIC_NON_STREAM_BODY))

    const login = await loginDesktop(app, user)
    const denied = await app.inject({
      method: 'POST',
      url: '/api/desktop/agent-mode-key',
      payload: { mode: 'claude-code' },
      headers: deviceHeaders(login.token),
    })
    expect(denied.statusCode).toBe(403)

    // 开通并加入 targets（走 service，等价于管理端 PUT）
    app.deps.services.agentModes.update(
      'claude-code',
      { enabled: true, defaultModelId: model.id, targets: { userIds: [user.user.id] } },
      admin.user.id,
      META,
    )

    const issued = await app.inject({
      method: 'POST',
      url: '/api/desktop/agent-mode-key',
      payload: { mode: 'claude-code' },
      headers: deviceHeaders(login.token),
    })
    expect(issued.statusCode).toBe(200)
    const key = issued.json() as { secret: string; scope: string; ref: string; keyId: number }
    expect(key.scope).toBe('claude-code')
    expect(key.ref).toBe('HUB_CLAUDE_KEY')

    // 同一设备重复索取 → 同一把（幂等，客户端重读凭据不需要换钥匙）
    const again = await app.inject({
      method: 'POST',
      url: '/api/desktop/agent-mode-key',
      payload: { mode: 'claude-code' },
      headers: deviceHeaders(login.token),
    })
    expect((again.json() as { keyId: number }).keyId).toBe(key.keyId)

    const call = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-test', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-api-key': key.secret },
    })
    expect(call.statusCode).toBe(200)
    const usage = ctx.app.deps.db.get<{ client_kind: string; scope: string }>(
      'SELECT client_kind, scope FROM relay_usage ORDER BY id DESC LIMIT 1',
    )!
    expect(usage.scope).toBe('claude-code')
    expect(usage.client_kind).toBe('desktop')

    // 吊销设备（网页会话）→ 设备令牌 / 中转站密钥 / 模式密钥全断
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      headers: user.headers,
    })
    expect(revoke.statusCode).toBe(204)

    const tokenAfter = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(login.token),
    })
    expect(tokenAfter.statusCode).toBe(401)
    expect((tokenAfter.json() as { error: { code: string } }).error.code).toBe('DEVICE_TOKEN_INVALID')

    const relayAfter = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'claude-test', messages: [], stream: false },
      headers: { authorization: `Bearer ${login.relay!.secret}` },
    })
    expect(relayAfter.statusCode).toBe(401)
    const modeAfter = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-test', max_tokens: 8, messages: [] },
      headers: { 'x-api-key': key.secret },
    })
    expect(modeAfter.statusCode).toBe(401)

    // 审计：吊销动作 + 模式密钥动作
    const actions = ctx.app.deps.db
      .all<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'desktop.%' ORDER BY id")
      .map((row) => row.action)
    expect(actions).toContain('desktop.revoke')
    expect(actions).toContain('desktop.agent-mode-key')
  })
})

describe('级联吊销（改密 / 停用 / 删除 / purge）', () => {
  beforeEach(setup)

  it('改密码：设备令牌与设备密钥立刻失效，设备行保留（重新登录还是同一台）', async () => {
    const login = await loginDesktop(app, user)
    const changed = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { currentPassword: user.user.password, newPassword: 'a-brand-new-password-9' },
      headers: user.headers,
    })
    expect(changed.statusCode).toBe(204)

    const token = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(login.token),
    })
    expect(token.statusCode).toBe(401)

    const keyAlive = app.deps.services.relay.authenticate(login.relay!.secret)
    expect(keyAlive).toBeNull()

    const device = ctx.app.deps.db.get<{ status: string }>(
      'SELECT status FROM desktop_devices WHERE device_id = ?',
      login.deviceId,
    )!
    expect(device.status).toBe('active')

    // 用新密码的会话再登录一次 → 复用同一台设备
    const fresh = loginAs(app, { ...user.user, password: 'a-brand-new-password-9' })
    const again = await loginDesktop(app, fresh, {
      installId: login.started.device.installId as string,
    })
    expect(again.deviceId).toBe(login.deviceId)
  })

  it('管理员停用账号：设备吊销 + 令牌失效；重新启用后设备仍是吊销态', async () => {
    const login = await loginDesktop(app, user)
    await app.deps.services.adminUsers.updateUser(
      user.user.id,
      { status: 'disabled' },
      { ...ACTOR, actorId: admin.user.id },
    )
    const token = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(login.token),
    })
    expect(token.statusCode).toBe(401)
    const device = ctx.app.deps.db.get<{ status: string; revoke_reason: string }>(
      'SELECT status, revoke_reason FROM desktop_devices WHERE device_id = ?',
      login.deviceId,
    )!
    expect(device.status).toBe('revoked')
    expect(device.revoke_reason).toBe('user-disabled')
    expect(app.deps.services.relay.authenticate(login.relay!.secret)).toBeNull()
  })

  it('删除用户（回收站）：设备与密钥吊销；purge 后设备行物理删除', async () => {
    const login = await loginDesktop(app, user)
    await app.deps.services.adminUsers.deleteUser(
      user.user.id,
      { purge: false },
      { ...ACTOR, actorId: admin.user.id },
    )
    const device = ctx.app.deps.db.get<{ status: string; revoke_reason: string }>(
      'SELECT status, revoke_reason FROM desktop_devices WHERE device_id = ?',
      login.deviceId,
    )!
    expect(device.status).toBe('revoked')
    expect(device.revoke_reason).toBe('user-deleted')
    expect(app.deps.services.relay.authenticate(login.relay!.secret)).toBeNull()

    await app.deps.services.adminUsers.purgeUser(user.user.id, { ...ACTOR, actorId: admin.user.id })
    const rows = ctx.app.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM desktop_devices WHERE device_id = ?',
      login.deviceId,
    )!.n
    expect(rows).toBe(0)
    const tokens = ctx.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_tokens')!.n
    expect(tokens).toBe(0)
  })
})

describe('管理端设备列表与吊销', () => {
  beforeEach(setup)

  it('筛选（presence / revoked / q / userId）+ 分页 + 吊销，审计 desktop.admin-revoke', async () => {
    const login = await loginDesktop(app, user, { name: '办公室的 Windows' })
    await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody(),
      headers: deviceHeaders(login.token),
    })
    // 第二台：从未上报 → offline
    const second = await loginDesktop(app, user, { name: '本机的 Mac', platform: 'darwin', osMajor: '14' })

    const online = await app.inject({
      method: 'GET',
      url: '/api/admin/desktop-devices?presence=online',
      headers: admin.headers,
    })
    expect(online.statusCode).toBe(200)
    const onlineBody = online.json() as { items: { device: { deviceId: string } }[]; total: number }
    expect(onlineBody.total).toBe(1)
    expect(onlineBody.items[0]!.device.deviceId).toBe(login.deviceId)

    const offline = await app.inject({
      method: 'GET',
      url: '/api/admin/desktop-devices?presence=offline',
      headers: admin.headers,
    })
    expect((offline.json() as { total: number }).total).toBe(1)

    const search = await app.inject({
      method: 'GET',
      url: `/api/admin/desktop-devices?q=${encodeURIComponent('本机的')}`,
      headers: admin.headers,
    })
    expect((search.json() as { total: number }).total).toBe(1)

    const byUser = await app.inject({
      method: 'GET',
      url: `/api/admin/desktop-devices?userId=${String(user.user.id)}&pageSize=1`,
      headers: admin.headers,
    })
    const pageBody = byUser.json() as { items: unknown[]; total: number; pageSize: number }
    expect(pageBody.total).toBe(2)
    expect(pageBody.items).toHaveLength(1)

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/admin/desktop-devices/${second.deviceId}/revoke`,
      headers: admin.headers,
    })
    expect(revoked.statusCode).toBe(200)
    expect((revoked.json() as { device: { presence: string; revokeReason: string } }).device).toMatchObject({
      presence: 'revoked',
      revokeReason: 'admin',
    })

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/admin/desktop-devices?revoked=all',
      headers: admin.headers,
    })
    expect((afterRevoke.json() as { total: number }).total).toBe(2)
    const secondToken = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(second.token),
    })
    expect(secondToken.statusCode).toBe(401)

    const actions = ctx.app.deps.db
      .all<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'desktop.%' ORDER BY id")
      .map((row) => row.action)
    expect(actions).toContain('desktop.admin-revoke')

    // 非管理员访问 → 403
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/desktop-devices',
      headers: user.headers,
    })
    expect(forbidden.statusCode).toBe(403)

    // 别人的设备删不掉（404，与其它模块一致）
    const other = loginAs(app, await createUser(app))
    const notMine = await app.inject({
      method: 'DELETE',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      headers: other.headers,
    })
    expect(notMine.statusCode).toBe(404)
  })
})
