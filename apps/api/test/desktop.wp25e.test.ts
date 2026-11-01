import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  DesktopBatchRevokeResponse,
  DesktopDeliveryScope,
  DesktopDeviceDetailResponse,
  DesktopOverviewCounts,
  DesktopRenameDeviceResponse,
} from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestSession, type TestUser } from './helpers.js'
import { decideLogin, deviceHeaders, loginDesktop, queryOf, reportBody, startLogin } from './helpers-desktop.js'
import { sha256Hex } from '../src/lib/crypto.js'

/**
 * WP25e 桌面端后端收尾（任务书交付物 1–11）：
 *
 * 1 设备详情（白名单 + 无 IP / 无原始上报）· 2 改名（越权 404）· 3 批量吊销（逐台结果 + 每台审计）·
 * 4 概览 desktop 计数（与台账同一口径）· 5 审计 actionPrefix · 6 模型预设的系统预设 ·
 * 7 `DesktopDeliveryScope` 类型别名 · 8 同机重复登录复用设备行 · 9 过期令牌清理 ·
 * 11 必须改密账号的 loginCode（10 在 desktop.login.test.ts 里测限流键）。
 *
 * 每个 describe 一套全新 app；本机（非公网）回环请求不受 `auth/start` 限流约束（02 §5），
 * 所以这里可以放心多次登录。
 */

let ctx: TestApp
let app: FastifyInstance
let admin: TestUser
let adminSession: TestSession
let user: TestUser
let userSession: TestSession

const DB = (): FastifyInstance['deps']['db'] => app.deps.db

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  admin = await createUser(app, { username: 'wp25e-admin', role: 'admin' })
  adminSession = loginAs(app, admin)
  user = await createUser(app, { username: 'wp25e-user' })
  userSession = loginAs(app, user)
})

afterEach(async () => {
  await ctx.close()
})

interface InjectOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}

function injectAs(session: TestSession, opts: InjectOpts) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    headers: { ...session.headers, ...(opts.headers ?? {}) },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  } as never)
}

/** 直接给会话打上「刚二次验证过」的标记（与 models.api.test.ts 同一做法） */
function grantReauth(session: TestSession): void {
  DB().run(
    'UPDATE sessions SET reauth_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(),
    session.sessionId,
  )
}

/** 递归收集一个 JSON 结构里出现过的所有键（隐私断言用） */
function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
    return into
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.add(key)
      collectKeys(child, into)
    }
  }
  return into
}

/** 一个合法但不存在的设备标识 */
function missingDeviceId(): string {
  return `dv_${randomUUID().replace(/-/gu, '').slice(0, 32)}`
}

// ── 交付物 1：设备详情 ──────────────────────────────────────────────────────

describe('设备详情 GET /api/admin/desktop-devices/:deviceId（交付物 1）', () => {
  it('返回台账 + 插件清单 + 最近审计，且没有 IP、没有原始上报 JSON', async () => {
    const login = await loginDesktop(app, userSession, { name: '书房的 Windows' })
    const reported = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody({
        appliedRevision: 3,
        applyState: 'partial',
        applyErrorCode: 'plugin_install_failed',
        errorCount: 1,
        plugins: [
          { name: 'dsh-email', version: '0.16.0', source: 'hub-default', state: 'enabled' },
          {
            name: 'dsh-memory',
            version: '0.1.2',
            source: 'user',
            state: 'failed',
            errorCode: 'plugin_install_failed',
          },
        ],
      }),
      headers: deviceHeaders(login.token),
    })
    expect(reported.statusCode, reported.body).toBe(200)
    // 令牌行里本来就有签发 IP：把它换成一个一眼能认出来的地址，证明详情不会把它漏出来
    DB().run(
      'UPDATE desktop_device_tokens SET ip = ?, user_agent = ? WHERE device_id = ?',
      '203.0.113.77',
      'Mozilla/5.0 (secret-agent)',
      login.deviceId,
    )

    const res = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/desktop-devices/${login.deviceId}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<DesktopDeviceDetailResponse>(res)

    expect(body.device.deviceId).toBe(login.deviceId)
    expect(body.device.name).toBe('书房的 Windows')
    expect(body.device.appliedRevision).toBe(3)
    expect(body.device.applyState).toBe('partial')
    expect(body.user).toMatchObject({ id: user.id, username: 'wp25e-user' })
    expect(body.user.avatarUrl).toBeNull()
    expect(body.plugins.map((plugin) => plugin.name)).toEqual(['dsh-email', 'dsh-memory'])
    expect(body.plugins[1]).toMatchObject({
      name: 'dsh-memory',
      version: '0.1.2',
      source: 'user',
      state: 'failed',
      errorCode: 'plugin_install_failed',
    })
    expect(body.plugins[1]!.updatedAt).toBeTruthy()
    expect(body.pluginCount).toBe(2)
    // 审计：登录一条（targetType/targetId 都是这台设备）
    expect(body.audit.length).toBeGreaterThan(0)
    expect(body.audit.every((item) => item.targetId === login.deviceId)).toBe(true)
    expect(body.audit.map((item) => item.action)).toContain('desktop.login')
    expect(body.audit[0]).not.toHaveProperty('actorIp')

    // 隐私边界：IP / 提交方 UA / 原始上报都不出现
    expect(res.body).not.toContain('203.0.113.77')
    expect(res.body).not.toContain('secret-agent')
    const keys = collectKeys(body)
    for (const forbidden of [
      'ip',
      'actorIp',
      'installKey',
      'install_key',
      'raw',
      'payload',
      'report',
      'deviceReport',
      'detail_json',
      'capabilitiesJson',
      'tokenId',
      'lastUsedIp',
    ]) {
      expect(keys.has(forbidden), `详情里不该出现字段 ${forbidden}`).toBe(false)
    }
  })

  it('审计最多回 20 条，按时间倒序', async () => {
    const login = await loginDesktop(app, userSession)
    for (let index = 0; index < 25; index += 1) {
      app.deps.audit.log({
        actorId: admin.id,
        action: 'desktop.admin-revoke',
        targetType: 'desktop.device',
        targetId: login.deviceId,
        detail: { index },
      })
    }
    const res = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/desktop-devices/${login.deviceId}`,
    })
    expect(res.statusCode).toBe(200)
    const body = json<DesktopDeviceDetailResponse>(res)
    expect(body.audit).toHaveLength(20)
    expect(body.audit[0]!.detail).toEqual({ index: 24 })
    expect(body.audit[19]!.detail).toEqual({ index: 5 })
    // 其它设备/对象的审计不会混进来
    expect(body.audit.every((item) => item.targetId === login.deviceId)).toBe(true)
  })

  it('设备不存在 → 404；非管理员 → 403', async () => {
    const missing = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/desktop-devices/${missingDeviceId()}`,
    })
    expect(missing.statusCode).toBe(404)
    expect(json<{ error: { code: string } }>(missing).error.code).toBe('NOT_FOUND')

    const login = await loginDesktop(app, userSession)
    const forbidden = await injectAs(userSession, {
      method: 'GET',
      url: `/api/admin/desktop-devices/${login.deviceId}`,
    })
    expect(forbidden.statusCode).toBe(403)
  })
})

// ── 交付物 2：改名 ──────────────────────────────────────────────────────────

describe('设备改名 PATCH /api/me/desktop-devices/:deviceId（交付物 2）', () => {
  it('改自己的设备名：写库 + 审计 desktop.rename；同名不重复写审计', async () => {
    const login = await loginDesktop(app, userSession, { name: '旧名字' })

    const res = await injectAs(userSession, {
      method: 'PATCH',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      payload: { name: '新名字 · 书房' },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(json<DesktopRenameDeviceResponse>(res).device.name).toBe('新名字 · 书房')
    expect(
      DB().get<{ name: string }>('SELECT name FROM desktop_devices WHERE device_id = ?', login.deviceId)!
        .name,
    ).toBe('新名字 · 书房')

    const audits = DB().all<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'desktop.rename' ORDER BY id ASC",
    )
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0]!.detail_json)).toEqual({ from: '旧名字', to: '新名字 · 书房' })

    // 改成同一个名字：不报错、不再写审计
    const again = await injectAs(userSession, {
      method: 'PATCH',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      payload: { name: '新名字 · 书房' },
    })
    expect(again.statusCode).toBe(200)
    expect(
      DB().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'desktop.rename'")!.n,
    ).toBe(1)
  })

  it('别人的设备 → 404（不是 403，避免用 deviceId 枚举别人的设备）', async () => {
    const login = await loginDesktop(app, userSession)
    const other = await createUser(app, { username: 'wp25e-other' })
    const otherSession = loginAs(app, other)

    const res = await injectAs(otherSession, {
      method: 'PATCH',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      payload: { name: '我想改别人的' },
    })
    expect(res.statusCode).toBe(404)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('NOT_FOUND')
    // 名字没被改
    expect(
      DB().get<{ name: string }>('SELECT name FROM desktop_devices WHERE device_id = ?', login.deviceId)!
        .name,
    ).toBe('Windows 11 上的 DSH')
  })

  it('非法设备名（路径分隔符 / 控制字符 / 空串）→ 400，且不改库', async () => {
    const login = await loginDesktop(app, userSession)
    for (const name of ['C:\\Users\\52914', '/etc/passwd', 'a\u0007b', '   ']) {
      const res = await injectAs(userSession, {
        method: 'PATCH',
        url: `/api/me/desktop-devices/${login.deviceId}`,
        payload: { name },
      })
      expect(res.statusCode, `name=${JSON.stringify(name)}`).toBe(400)
    }
    expect(
      DB().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'desktop.rename'")!.n,
    ).toBe(0)
  })

  it('设备令牌不能改设备名（写接口只认网页会话）', async () => {
    const login = await loginDesktop(app, userSession)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      payload: { name: '设备自己改名' },
      headers: deviceHeaders(login.token),
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── 交付物 3：批量吊销 ──────────────────────────────────────────────────────

describe('批量吊销 POST /api/admin/desktop-devices/revoke（交付物 3）', () => {
  it('逐台结果（revoked / already_revoked / not_found），部分失败不影响其余，每台一条审计', async () => {
    const first = await loginDesktop(app, userSession, { name: '机器一' })
    const second = await loginDesktop(app, userSession, { name: '机器二' })
    const third = await loginDesktop(app, userSession, { name: '机器三' })
    // 先把「机器二」单独吊销掉
    const single = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/desktop-devices/${second.deviceId}/revoke`,
    })
    expect(single.statusCode, single.body).toBe(200)
    grantReauth(adminSession)

    const missing = missingDeviceId()
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      payload: { deviceIds: [first.deviceId, second.deviceId, missing, third.deviceId] },
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<DesktopBatchRevokeResponse>(res)
    expect(body.revoked).toBe(2)
    expect(body.skipped).toBe(2)
    expect(body.items.map((item) => [item.deviceId, item.outcome])).toEqual([
      [first.deviceId, 'revoked'],
      [second.deviceId, 'already_revoked'],
      [missing, 'not_found'],
      [third.deviceId, 'revoked'],
    ])
    expect(body.items[0]!.device?.revokeReason).toBe('admin')
    expect(body.items[2]!.device).toBeNull()

    // 「部分失败」不影响其余：两台成功吊销的令牌立刻 401
    for (const login of [first, third]) {
      const session = await app.inject({
        method: 'GET',
        url: '/api/desktop/session',
        headers: deviceHeaders(login.token),
      })
      expect(session.statusCode).toBe(401)
      expect(json<{ error: { code: string } }>(session).error.code).toBe('DEVICE_TOKEN_INVALID')
    }
    // 中转站密钥也一起吊销（设备的中转站密钥行 revoked_at 非空）
    const revokedKeys = DB().all<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM relay_keys WHERE device_id IN (?, ?)',
      first.deviceId,
      third.deviceId,
    )
    expect(revokedKeys.length).toBe(2)
    expect(revokedKeys.every((row) => row.revoked_at !== null)).toBe(true)

    // 每台一条审计（批量标记 batch，逐台明细在 detail.result）
    const batchAudits = DB().all<{ target_id: string; detail_json: string }>(
      `SELECT target_id, detail_json FROM audit_logs
        WHERE action = 'desktop.admin-revoke' AND detail_json LIKE '%"batch":true%'
        ORDER BY id ASC`,
    )
    expect(batchAudits.map((row) => row.target_id)).toEqual([
      first.deviceId,
      second.deviceId,
      missing,
      third.deviceId,
    ])
    expect(batchAudits.map((row) => JSON.parse(row.detail_json).result)).toEqual([
      'revoked',
      'already_revoked',
      'not_found',
      'revoked',
    ])
  })

  it('没有二次验证 → 403 REAUTH_REQUIRED，一台都不动', async () => {
    const login = await loginDesktop(app, userSession)
    const freshAdmin = loginAs(app, await createUser(app, { username: 'wp25e-admin2', role: 'admin' }))
    const res = await injectAs(freshAdmin, {
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      payload: { deviceIds: [login.deviceId] },
    })
    expect(res.statusCode, res.body).toBe(403)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('REAUTH_REQUIRED')
    expect(
      DB().get<{ status: string }>('SELECT status FROM desktop_devices WHERE device_id = ?', login.deviceId)!
        .status,
    ).toBe('active')
  })

  it('空数组 / 超过 50 台 / 形状不对 → 400；非管理员 → 403', async () => {
    grantReauth(adminSession)
    const empty = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      payload: { deviceIds: [] },
    })
    expect(empty.statusCode).toBe(400)

    const tooMany = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      payload: { deviceIds: Array.from({ length: 51 }, () => missingDeviceId()) },
    })
    expect(tooMany.statusCode).toBe(400)

    const badShape = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      payload: { deviceIds: ['not-a-device-id'] },
    })
    expect(badShape.statusCode).toBe(400)

    const login = await loginDesktop(app, userSession)
    const forbidden = await injectAs(userSession, {
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      payload: { deviceIds: [login.deviceId] },
    })
    expect(forbidden.statusCode).toBe(403)
  })

  it('重复的 deviceId 去重后只处理一次', async () => {
    const login = await loginDesktop(app, userSession)
    grantReauth(adminSession)
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      payload: { deviceIds: [login.deviceId, login.deviceId, login.deviceId] },
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<DesktopBatchRevokeResponse>(res)
    expect(body.items).toHaveLength(1)
    expect(body.revoked).toBe(1)
  })
})

// ── 交付物 4：概览 desktop 计数 ────────────────────────────────────────────

describe('概览 desktop 计数 GET /api/admin/overview（交付物 4）', () => {
  it('total = online + stale + revoked，online 与设备台账同一判定', async () => {
    const offlineAfterSec = app.deps.settings.get('desktop').offlineAfterSec
    // ① 刚上报 → online
    const online = await loginDesktop(app, userSession, { name: '在线机' })
    const reported = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      payload: reportBody(),
      headers: deviceHeaders(online.token),
    })
    expect(reported.statusCode, reported.body).toBe(200)
    // ② 登录了但一次都没上报 → stale
    await loginDesktop(app, userSession, { name: '从没上报' })
    // ③ 吊销掉的
    const revoked = await loginDesktop(app, userSession, { name: '已吊销' })
    const gone = await injectAs(userSession, {
      method: 'DELETE',
      url: `/api/me/desktop-devices/${revoked.deviceId}`,
    })
    expect(gone.statusCode).toBe(204)

    const overview = await injectAs(adminSession, { method: 'GET', url: '/api/admin/overview' })
    expect(overview.statusCode).toBe(200)
    const counts = json<{ desktop: DesktopOverviewCounts }>(overview).desktop
    expect(counts).toEqual({ total: 3, online: 1, revoked: 1, stale: 1 })
    expect(counts.total).toBe(counts.online + counts.stale + counts.revoked)

    // 台账口径一致：presence=online 的合计 == overview.online
    const onlineList = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/desktop-devices?presence=online&pageSize=100',
    })
    expect(json<{ total: number }>(onlineList).total).toBe(counts.online)

    // 过了 offlineAfterSec：在线那台变离线 → online 0、stale 2（仍然是 3 台）
    ctx.clock.advance((offlineAfterSec + 1) * 1000)
    const later = await injectAs(adminSession, { method: 'GET', url: '/api/admin/overview' })
    expect(json<{ desktop: DesktopOverviewCounts }>(later).desktop).toEqual({
      total: 3,
      online: 0,
      revoked: 1,
      stale: 2,
    })
  })

  it('没有任何设备时是 0/0/0/0（不是缺字段）', async () => {
    const overview = await injectAs(adminSession, { method: 'GET', url: '/api/admin/overview' })
    expect(json<{ desktop: DesktopOverviewCounts }>(overview).desktop).toEqual({
      total: 0,
      online: 0,
      revoked: 0,
      stale: 0,
    })
  })
})

// ── 交付物 5：审计前缀查询 ─────────────────────────────────────────────────

describe('审计前缀查询 GET /api/admin/audit?actionPrefix=（交付物 5）', () => {
  it('actionPrefix=desktop. 一次拿到全部桌面动作；单值 action 行为不变', async () => {
    const login = await loginDesktop(app, userSession)
    await injectAs(userSession, {
      method: 'PATCH',
      url: `/api/me/desktop-devices/${login.deviceId}`,
      payload: { name: '改了名' },
    })
    grantReauth(adminSession)
    await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/desktop-devices/${login.deviceId}/revoke`,
    })
    // 混一条非桌面动作
    app.deps.audit.log({ actorId: admin.id, action: 'user.create', targetType: 'user', targetId: '99' })

    const prefixed = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/audit?actionPrefix=desktop.&pageSize=100',
    })
    expect(prefixed.statusCode, prefixed.body).toBe(200)
    const body = json<{ items: { action: string; actorIp: string | null }[]; total: number }>(prefixed)
    expect(body.items.length).toBeGreaterThanOrEqual(3)
    expect(body.items.every((item) => item.action.startsWith('desktop.'))).toBe(true)
    expect(new Set(body.items.map((item) => item.action))).toEqual(
      new Set(['desktop.login', 'desktop.rename', 'desktop.admin-revoke']),
    )
    // 完整审计视图仍然带 actorIp（与设备详情的隐私口径不同，这是管理员看的）
    expect(body.items[0]).toHaveProperty('actorIp')

    const expected = DB().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'desktop.%'",
    )!.n
    expect(body.total).toBe(expected)

    // 单值 action：仍然精确匹配一个动作（老的调用方式不变）
    const single = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/audit?action=desktop.login&pageSize=100',
    })
    const singleBody = json<{ items: { action: string }[]; total: number }>(single)
    expect(singleBody.items.every((item) => item.action === 'desktop.login')).toBe(true)
    expect(singleBody.total).toBe(
      DB().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'desktop.login'")!.n,
    )

    // 前缀里的 LIKE 通配符被转义：`%` 不会变成「匹配一切」
    const wildcard = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/audit?actionPrefix=%25',
    })
    expect(json<{ total: number }>(wildcard).total).toBe(0)
  })

  it('actionPrefix 与 action 同时给出时两者都要满足', async () => {
    const login = await loginDesktop(app, userSession)
    const res = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/audit?action=desktop.login&actionPrefix=desktop.&pageSize=100',
    })
    expect(res.statusCode).toBe(200)
    expect(json<{ items: { action: string; targetId: string }[] }>(res).items).toEqual([
      expect.objectContaining({ action: 'desktop.login', targetId: login.deviceId }),
    ])
  })
})

// ── 交付物 6：模型预设的系统预设 ────────────────────────────────────────────

describe('模型预设 GET /api/admin/desktop/config/model-preset（交付物 6）', () => {
  const PROVIDER = {
    routeKey: 'wp25e-provider',
    displayName: 'WP25e 提供方',
    kind: 'pi-ai',
    api: 'openai-completions',
    models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }],
    keyMode: 'shared',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-wp25e-test-key-123456',
  } as const

  async function seedDefaultPreset(): Promise<void> {
    // 建提供方要带密钥 → 需要最近输过密码
    grantReauth(adminSession)
    const created = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/providers',
      payload: { ...PROVIDER },
    })
    expect(created.statusCode, created.body).toBe(200)
    const providerId = json<{ provider: { id: number } }>(created).provider.id
    const preset = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/presets',
      payload: {
        name: 'WP25e 系统预设',
        providerIds: [providerId],
        defaultProvider: PROVIDER.routeKey,
        defaultModel: 'gpt-4o-mini',
        isDefault: true,
      },
    })
    expect(preset.statusCode, preset.body).toBe(200)
  }

  it('不带 userId：用系统预设（默认预设的全部可下发模型），响应 userId=null', async () => {
    await seedDefaultPreset()
    const res = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/desktop/config/model-preset',
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<{
      userId: number | null
      fragments: { id: string; config: Record<string, unknown> }[]
      warnings: string[]
    }>(res)
    expect(body.userId).toBeNull()
    expect(body.fragments.map((fragment) => fragment.id)).toEqual(['llm-pi-ai', 'agent-default-model'])
    const providers = body.fragments[0]!.config['providers'] as Record<string, { models: { id: string }[] }>
    expect(providers[PROVIDER.routeKey]!.models.map((model) => model.id)).toEqual(['gpt-4o-mini'])
    expect(body.fragments[1]!.config).toMatchObject({
      provider: PROVIDER.routeKey,
      model: 'gpt-4o-mini',
    })
  })

  it('带 userId：行为不变（按该用户渲染），不存在的用户仍然 404', async () => {
    await seedDefaultPreset()
    const res = await injectAs(adminSession, {
      method: 'GET',
      url: `/api/admin/desktop/config/model-preset?userId=${String(user.id)}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<{ userId: number | null; fragments: { id: string }[] }>(res)
    expect(body.userId).toBe(user.id)
    expect(body.fragments.map((fragment) => fragment.id)).toEqual(['llm-pi-ai', 'agent-default-model'])

    const missing = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/desktop/config/model-preset?userId=999999',
    })
    expect(missing.statusCode).toBe(404)
  })

  it('没有默认预设时给出告警而不是 500', async () => {
    const res = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/desktop/config/model-preset',
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<{ fragments: unknown[]; warnings: string[] }>(res)
    expect(body.fragments).toEqual([])
    expect(body.warnings.join(' ')).toContain('默认模型预设')
  })

  it('非管理员 → 403', async () => {
    const res = await injectAs(userSession, {
      method: 'GET',
      url: '/api/admin/desktop/config/model-preset',
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── 交付物 7：DesktopDeliveryScope 类型别名 ────────────────────────────────

describe('shared 导出 DesktopDeliveryScope 类型别名（交付物 7）', () => {
  it('可以直接标注作用域对象（编译期由 typecheck 覆盖）', () => {
    const scope: DesktopDeliveryScope = { scope: 'role', role: 'user', userId: null }
    expect(scope.scope).toBe('role')
    expect(scope.userId).toBeNull()
  })
})

// ── 交付物 8：同机重复登录复用设备行 ───────────────────────────────────────

describe('同机重复登录复用设备行 POST /api/desktop/auth/token（交付物 8）', () => {
  it('同一 installId 登录两次只有一行；令牌与设备中转站密钥都轮换', async () => {
    const installId = randomUUID()
    const first = await loginDesktop(app, userSession, { installId })
    const second = await loginDesktop(app, userSession, { installId })

    expect(second.deviceId).toBe(first.deviceId)
    const rows = DB().all<{ device_id: string }>('SELECT device_id FROM desktop_devices WHERE user_id = ?', user.id)
    expect(rows).toHaveLength(1)

    // 令牌轮换：旧令牌立刻失效，新令牌可用
    const stale = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(first.token),
    })
    expect(stale.statusCode).toBe(401)
    const fresh = await app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: deviceHeaders(second.token),
    })
    expect(fresh.statusCode).toBe(200)

    // 设备中转站密钥轮换：新的一把，旧的被吊销（不是新增两把并存）
    expect(second.relay!.keyId).not.toBe(first.relay!.keyId)
    const keys = DB().all<{ id: number; revoked_at: string | null }>(
      'SELECT id, revoked_at FROM relay_keys WHERE device_id = ? ORDER BY id ASC',
      first.deviceId,
    )
    expect(keys).toHaveLength(2)
    expect(keys[0]!.id).toBe(first.relay!.keyId)
    expect(keys[0]!.revoked_at).not.toBeNull()
    expect(keys[1]!.id).toBe(second.relay!.keyId)
    expect(keys[1]!.revoked_at).toBeNull()
  })

  it('不同 installId、或同一 installId 的不同用户，照旧各建一行', async () => {
    const installId = randomUUID()
    const first = await loginDesktop(app, userSession, { installId })
    const second = await loginDesktop(app, userSession, { installId: randomUUID() })
    expect(second.deviceId).not.toBe(first.deviceId)

    const other = await createUser(app, { username: 'wp25e-user2' })
    const otherSession = loginAs(app, other)
    const otherLogin = await loginDesktop(app, otherSession, { installId })
    expect(otherLogin.deviceId).not.toBe(first.deviceId)
    expect(
      DB().get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n,
    ).toBe(3)
  })

  it('设备上限不被重复登录占满：5 台后再用第 1 台的 installId 登录仍然 200', async () => {
    const limit = app.deps.settings.get('desktop').maxDevicesPerUser
    const installIds = Array.from({ length: limit }, () => randomUUID())
    const logins = []
    for (const installId of installIds) {
      logins.push(await loginDesktop(app, userSession, { installId }))
    }
    expect(DB().get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n).toBe(limit)

    // 第 6 台新机器：409（上限仍然生效）
    const started = await startLogin(app, { installId: randomUUID() })
    const approved = await decideLogin(app, userSession, started.started.requestId, true)
    const code = queryOf(approved.redirectUrl).get('code')!
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: started.started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(blocked.statusCode).toBe(409)

    // 第 1 台机器重新登录：复用同一行，不占新名额
    const again = await loginDesktop(app, userSession, { installId: installIds[0]! })
    expect(again.deviceId).toBe(logins[0]!.deviceId)
    expect(DB().get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n).toBe(limit)
  })
})

// ── 交付物 9：过期令牌清理 ─────────────────────────────────────────────────

describe('过期令牌清理（交付物 9）', () => {
  function insertToken(seed: string, expiresAt: string): string {
    const id = sha256Hex(seed)
    const now = app.deps.clock.nowIso()
    DB().run(
      `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at)
       VALUES (?, (SELECT device_id FROM desktop_devices LIMIT 1), ?, ?, ?, ?)`,
      id,
      user.id,
      now,
      now,
      expiresAt,
    )
    return id
  }

  it('删掉「过期超过 30 天」的行，保留过期未满 30 天的；写了>0 行才写一条汇总审计', async () => {
    await loginDesktop(app, userSession)
    const day = 86_400_000
    const at = (offsetDays: number): string =>
      new Date(app.deps.clock.now().getTime() + offsetDays * day).toISOString()
    const old = insertToken('old', at(-31))
    const recent = insertToken('recent', at(-29))
    const future = insertToken('future', at(20))

    const removed = app.deps.services.desktop.cleanupExpiredTokens()
    expect(removed).toBe(1)
    const left = DB()
      .all<{ id: string }>('SELECT id FROM desktop_device_tokens ORDER BY id ASC')
      .map((row) => row.id)
    expect(left).not.toContain(old)
    expect(left).toContain(recent)
    expect(left).toContain(future)

    const audits = DB().all<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'desktop.tokens.cleanup'",
    )
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0]!.detail_json)).toMatchObject({ removed: 1, afterExpiryDays: 30 })

    // 没有可删的行：返回 0、不再写审计
    expect(app.deps.services.desktop.cleanupExpiredTokens()).toBe(0)
    expect(
      DB().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'desktop.tokens.cleanup'")!
        .n,
    ).toBe(1)
  })

  it('接在模块的 onReady 上：应用就绪时自动清一次', async () => {
    // 直接写库造设备 + 一条 40 天前过期的令牌（不经过登录，避免 inject 提前触发 ready）
    const now = app.deps.clock.nowIso()
    const deviceId = `dv_${randomUUID().replace(/-/gu, '').slice(0, 32)}`
    DB().run(
      `INSERT INTO desktop_devices (device_id, user_id, name, apply_state, first_seen_at, created_at, updated_at)
       VALUES (?, ?, '老设备', 'unknown', ?, ?, ?)`,
      deviceId,
      user.id,
      now,
      now,
      now,
    )
    const expiredAt = new Date(app.deps.clock.now().getTime() - 40 * 86_400_000).toISOString()
    DB().run(
      `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sha256Hex('onready-old'),
      deviceId,
      user.id,
      expiredAt,
      expiredAt,
      expiredAt,
    )

    await app.ready()
    expect(
      DB().get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_tokens')!.n,
    ).toBe(0)
    expect(
      DB().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'desktop.tokens.cleanup'")!
        .n,
    ).toBe(1)
  })
})

// ── 交付物 11：必须改密账号的 loginCode ────────────────────────────────────

describe('必须改密的账号（交付物 11）', () => {
  it('token 交换返回 loginCode=password_change_required（与 account_blocked 分开）', async () => {
    const started = await startLogin(app)
    const approved = await decideLogin(app, userSession, started.started.requestId, true)
    expect(approved.status).toBe(200)
    const code = queryOf(approved.redirectUrl).get('code')!
    // 管理员在这中间重置了密码：设备拿着 code 来换令牌时必须得到可区分的提示
    DB().run('UPDATE users SET must_change_password = 1 WHERE id = ?', user.id)

    const res = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: started.started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(403)
    const body = json<{ error: { code: string; message: string; details: { loginCode: string } } }>(res)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details.loginCode).toBe('password_change_required')
    expect(body.error.message).toContain('网页端')
    // 没有建出任何设备
    expect(DB().get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n).toBe(0)
  })

  it('账号被停用仍然是 account_blocked（两种原因可区分）', async () => {
    const started = await startLogin(app)
    const approved = await decideLogin(app, userSession, started.started.requestId, true)
    const code = queryOf(approved.redirectUrl).get('code')!
    DB().run("UPDATE users SET status = 'disabled' WHERE id = ?", user.id)
    const res = await app.inject({
      method: 'POST',
      url: '/api/desktop/auth/token',
      payload: { code, codeVerifier: started.started.verifier },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(403)
    expect(
      json<{ error: { details: { loginCode: string } } }>(res).error.details.loginCode,
    ).toBe('account_blocked')
  })
})
