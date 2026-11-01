import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  AdminPluginRow,
  DesktopManifest,
  ModelPreset,
  PluginInstallStatsResponse,
  RelayDshResponse,
} from '@dsh-hub/shared'
import { createUser, json, loginAs, type TestSession, type TestUser } from './helpers.js'
import { cleanupDirs, createWp3App, makePluginTgz, type Wp3TestApp } from './helpers-wp3.js'
import { deviceHeaders, loginDesktop, reportBody } from './helpers-desktop.js'
import { createChannel, createRelayModel } from './helpers-relay.js'
import { multipart } from './wp1-helpers.js'

/**
 * WP32a（docs/22 §2 §3）：插件库 / 版本 / 桌面清单 level / 统一下发 / 模型配置的**平台化**。
 *
 * 走真 HTTP（路由 → service → SQLite），断言每一条「两套独立」的口径：
 * 插件库与版本按平台分开、桌面清单的 level 取桌面策略、统一下发的 desktopVersionId 只动桌面、
 * 桌面模型配置与云上互不影响、安装统计的「内置」设备数。
 */

let ctx: Wp3TestApp
let app: FastifyInstance
let adminSession: TestSession
let alice: TestUser
let aliceSession: TestSession
let deviceToken: string
let deviceId: string
const tempDirs: string[] = []

const P = '@local/wp32a-plugin'

beforeEach(async () => {
  ctx = await createWp3App({
    env: { HUB_PUBLIC_ORIGIN: 'https://hub.wp32a.test', HUB_RELAY_INTERNAL_PORT: '7833' },
  })
  app = ctx.app
  // 内部监听器不真的起：直接告诉 service「已在监听」（relay.dsh-api 测试同款）
  app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7833/v1')
  const adminUser = await createUser(app, { username: 'boss', role: 'admin' })
  alice = await createUser(app, { username: 'alice' })
  adminSession = loginAs(app, adminUser)
  aliceSession = loginAs(app, alice)
  const login = await loginDesktop(app, aliceSession, { name: 'WP32a 设备' })
  deviceToken = login.token
  deviceId = login.deviceId
})

afterEach(async () => {
  await ctx.close()
  cleanupDirs(tempDirs)
  tempDirs.length = 0
})

interface InjectOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}

async function injectAs(session: TestSession, opts: InjectOpts) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    headers: { ...session.headers, ...(opts.headers ?? {}) },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  } as never)
}

/** 给会话打上「刚输过密码」的标记（不改 /api/auth/reauth 的实现） */
function markReauth(session: TestSession): void {
  app.deps.db.run(
    'UPDATE sessions SET reauth_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(),
    session.sessionId,
  )
}

async function createPlugin(
  payload: Record<string, unknown> & { packageName?: string },
): Promise<AdminPluginRow> {
  const res = await injectAs(adminSession, {
    method: 'POST',
    url: '/api/admin/plugins',
    payload: {
      packageName: payload.packageName ?? P,
      displayName: 'WP32a 插件',
      policy: 'required',
      isBundle: true,
      ...payload,
    },
  })
  expect(res.statusCode, res.body).toBe(201)
  return json<AdminPluginRow>(res)
}

async function listPlugins(platform?: 'cloud' | 'desktop'): Promise<AdminPluginRow[]> {
  const res = await injectAs(adminSession, {
    method: 'GET',
    url: `/api/admin/plugins${platform === undefined ? '' : `?platform=${platform}`}`,
  })
  expect(res.statusCode, res.body).toBe(200)
  return json<AdminPluginRow[]>(res)
}

/** 上传一个整包当版本：桌面平台 = 建桌面版本（docs/22 §2.2） */
async function uploadVersion(
  pluginId: number,
  version: string,
  platform: 'cloud' | 'desktop',
  packageName: string = P,
): Promise<{ id: number; platform?: string; version: string }> {
  const file = multipart(makePluginTgz({ name: packageName, version }), {
    filename: `plugin-${version}.tgz`,
    contentType: 'application/gzip',
  })
  const res = await injectAs(adminSession, {
    method: 'POST',
    url: `/api/admin/plugins/${String(pluginId)}/versions?platform=${platform}`,
    payload: file.payload,
    headers: file.headers,
  })
  expect(res.statusCode, res.body).toBe(201)
  return json<{ version: { id: number; platform?: string; version: string } }>(res).version
}

/** 建一个桌面版本（整包随上传一起登记） */
async function addDesktopVersion(pluginId: number, version: string): Promise<number> {
  return (await uploadVersion(pluginId, version, 'desktop')).id
}

/** 设备上报插件清单（真 HTTP；`absent` 里的包名上报成 state=absent） */
async function reportFrom(
  token: string,
  plugins: { name: string; version: string; source: 'bundled' | 'hub-default' }[],
  opts: { absent?: string } = {},
): Promise<void> {
  const entries = plugins.map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    source: plugin.source,
    state: 'enabled' as const,
  }))
  if (opts.absent !== undefined) {
    entries.push({ name: opts.absent, version: '1.1.0', source: 'hub-default', state: 'absent' as never })
  }
  const res = await app.inject({
    method: 'POST',
    url: '/api/desktop/devices/report',
    headers: deviceHeaders(token),
    payload: reportBody({ plugins: entries }),
  })
  expect(res.statusCode, res.body).toBe(200)
}

async function manifest(): Promise<DesktopManifest> {
  const res = await app.inject({ method: 'GET', url: '/api/desktop/manifest', headers: deviceHeaders(deviceToken) })
  expect(res.statusCode, res.body).toBe(200)
  return json<DesktopManifest>(res)
}

function counter(): number {
  return (
    app.deps.db.get<{ revision: number }>('SELECT revision FROM desktop_delivery_counter WHERE id = 1')?.revision ?? 0
  )
}

describe('插件库按平台（docs/22 §2.1 §2.2）', () => {
  it('新建的云上插件不在桌面库；加入桌面库后两套策略互不影响', async () => {
    const plugin = await createPlugin({ policy: 'required' })
    expect(plugin.platform).toBe('cloud')
    expect(plugin.platforms?.cloud?.policy).toBe('required')
    expect(plugin.platforms?.desktop).toBeUndefined()

    // 桌面库是空的（云上插件不会被当成桌面的 core）
    expect(await listPlugins('desktop')).toEqual([])
    expect((await listPlugins()).map((row) => row.packageName)).toEqual([P])

    const added = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms`,
      payload: { platform: 'desktop', policy: 'default' },
    })
    expect(added.statusCode, added.body).toBe(200)
    // 只改桌面策略：云上还是 required
    const patched = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms/desktop`,
      payload: { policy: 'optional', bundleOrder: 7 },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const desktopRow = json<{ plugin: AdminPluginRow }>(patched).plugin
    expect(desktopRow.platform).toBe('desktop')
    expect(desktopRow.policy).toBe('optional')
    expect(desktopRow.bundleOrder).toBe(7)

    const cloudRow = (await listPlugins('cloud'))[0]!
    expect(cloudRow.policy).toBe('required')
    expect(cloudRow.bundleOrder).toBe(100)
    expect(cloudRow.platforms?.desktop?.policy).toBe('optional')

    // 重复加入 → 409
    const again = await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms`,
      payload: { platform: 'desktop' },
    })
    expect(again.statusCode, again.body).toBe(409)
  })

  it('同名版本号可以在两个平台各有一条（整包上传 = 创建桌面版本）', async () => {
    const plugin = await createPlugin({ packageName: P })
    const cloud = await uploadVersion(plugin.id, '1.0.0', 'cloud')
    const desktop = await uploadVersion(plugin.id, '1.0.0', 'desktop')
    expect(cloud.id).not.toBe(desktop.id)
    expect(desktop.platform).toBe('desktop')

    const list = await listPlugins('desktop')
    expect(list.map((row) => row.packageName)).toEqual([P])
    expect(list[0]!.versions.map((row) => row.platform)).toEqual(['desktop'])
    const cloudRow = (await listPlugins('cloud'))[0]!
    expect(cloudRow.versions.map((row) => row.platform)).toEqual(['cloud'])
    // 桌面版本必须有整包：上传整包后清单里就能看到它
    const artifact = app.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM desktop_plugin_artifacts WHERE version_id = ?',
      desktop.id,
    )
    expect(Number(artifact?.n ?? 0)).toBe(1)
  })

  it('移出桌面库：有目标时 409；force + 二次密码后目标被撤销', async () => {
    const plugin = await createPlugin({ packageName: P })
    const desktopVersion = await uploadVersion(plugin.id, '1.0.0', 'desktop')
    await injectAs(adminSession, {
      method: 'POST',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms`,
      payload: { platform: 'desktop', policy: 'default' },
    })
    // 直接造一条桌面目标（下发路径见下一个用例）
    markReauth(adminSession)
    const delivered = await injectAs(adminSession, {
      method: 'PUT',
      url: '/api/admin/desktop/plugins',
      payload: { pluginId: plugin.id, versionId: desktopVersion.id, target: { scope: 'all' } },
    })
    expect(delivered.statusCode, delivered.body).toBe(200)

    const blocked = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms/desktop`,
    })
    expect(blocked.statusCode, blocked.body).toBe(409)

    // force 需要二次密码
    app.deps.db.run('UPDATE sessions SET reauth_at = NULL WHERE id = ?', adminSession.sessionId)
    const noReauth = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms/desktop?force=1`,
    })
    expect(noReauth.statusCode, noReauth.body).toBe(403)

    markReauth(adminSession)
    const removed = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms/desktop?force=1`,
    })
    expect(removed.statusCode, removed.body).toBe(204)
    expect(await listPlugins('desktop')).toEqual([])
    expect(
      app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_plugin_targets')?.n,
    ).toBe(0)
  })
})

describe('桌面清单的 level 取桌面策略（docs/22 §2.1）', () => {
  it('云上 required 但没进桌面库的插件不下发；桌面设成 default 的才进清单', async () => {
    const cloudOnly = await createPlugin({ packageName: '@local/cloud-only', policy: 'required' })
    await uploadVersion(cloudOnly.id, '1.0.0', 'cloud', '@local/cloud-only')

    const both = await createPlugin({ packageName: P, policy: 'required' })
    const desktopVersion = await uploadVersion(both.id, '1.0.0', 'desktop')
    // 上传桌面整包会顺手把插件加进桌面库（策略照抄云上 = required），这里显式改成 default
    await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/plugins/${String(both.id)}/platforms/desktop`,
      payload: { policy: 'default' },
    })
    markReauth(adminSession)
    const delivered = await injectAs(adminSession, {
      method: 'PUT',
      url: '/api/admin/desktop/plugins',
      payload: { pluginId: both.id, versionId: desktopVersion.id, target: { scope: 'all' } },
    })
    expect(delivered.statusCode, delivered.body).toBe(200)

    const body = await manifest()
    expect(body.plugins.map((row) => row.name)).toEqual([P])
    // 云上 required ≠ 桌面 core：level 来自桌面策略 default
    expect(body.plugins[0]!.level).toBe('default')
    expect(body.plugins[0]!.enabled).toBe(true)
    expect(body.plugins[0]!.version).toBe('1.0.0')
  })

  it('桌面策略 hidden 的插件不进清单', async () => {
    const plugin = await createPlugin({ packageName: P, policy: 'optional' })
    const desktopVersion = await uploadVersion(plugin.id, '1.0.0', 'desktop')
    await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms/desktop`,
      payload: { policy: 'optional' },
    })
    markReauth(adminSession)
    const delivered = await injectAs(adminSession, {
      method: 'PUT',
      url: '/api/admin/desktop/plugins',
      payload: { pluginId: plugin.id, versionId: desktopVersion.id, target: { scope: 'all' } },
    })
    expect(delivered.statusCode, delivered.body).toBe(200)
    expect((await manifest()).plugins.map((row) => row.level)).toEqual(['optional'])

    await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms/desktop`,
      payload: { policy: 'hidden' },
    })
    expect((await manifest()).plugins).toEqual([])
  })
})

describe('桌面库列表的桌面侧统计（desktopStats）', () => {
  it('已装设备数 / 用户数 / 较旧数 / 内置数按桌面上报算，云上视图不给它', async () => {
    const plugin = await createPlugin({ packageName: P })
    await addDesktopVersion(plugin.id, '1.0.0')
    await addDesktopVersion(plugin.id, '1.1.0')
    // 两台有效设备 + 一台已吊销（吊销的不算）
    const second = await loginDesktop(app, aliceSession, { name: 'WP32a 第二台' })
    const revoked = await loginDesktop(app, aliceSession, { name: 'WP32a 已吊销' })
    app.deps.db.run("UPDATE desktop_devices SET status = 'revoked' WHERE device_id = ?", revoked.deviceId)
    await reportFrom(deviceToken, [{ name: P, version: '1.0.0', source: 'bundled' }])
    await reportFrom(second.token, [{ name: P, version: '1.1.0', source: 'hub-default' }])

    const desktopRow = (await listPlugins('desktop')).find((row) => row.packageName === P)!
    // 两台设备都装着 P；1.0.0 是旧版（桌面最新 1.1.0）；其中一台是客户端自带
    expect(desktopRow.desktopStats).toEqual({ devices: 2, users: 1, outdated: 1, bundledDevices: 1 })
    // 云上视图不给它（stats 仍是实例侧的期望/实际状态）
    const cloudRow = (await listPlugins('cloud')).find((row) => row.packageName === P)!
    expect(cloudRow.desktopStats).toBeUndefined()

    // 上报 state=absent（已被移除）不算装了（再上报会撞上报限流，直接改库模拟下一次心跳）
    app.deps.db.run(
      "UPDATE desktop_device_plugins SET state = 'absent' WHERE device_id = ? AND package_name = ?",
      second.deviceId,
      P,
    )
    const after = (await listPlugins('desktop')).find((row) => row.packageName === P)!
    expect(after.desktopStats).toEqual({ devices: 1, users: 1, outdated: 1, bundledDevices: 1 })
  })
})

describe('安装统计的「内置」设备数（docs/22 §4.2）', () => {
  it('上报 source=bundled 的设备进 bundledDevices', async () => {
    const plugin = await createPlugin({ packageName: P })
    await uploadVersion(plugin.id, '1.0.0', 'desktop')
    const report = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      headers: deviceHeaders(deviceToken),
      payload: reportBody({
        plugins: [{ name: P, version: '1.0.0', source: 'bundled', state: 'enabled' }],
      }),
    })
    expect(report.statusCode, report.body).toBe(200)

    const res = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/plugins/install-stats',
    })
    expect(res.statusCode, res.body).toBe(200)
    const stat = json<PluginInstallStatsResponse>(res).items.find((row) => row.pluginId === plugin.id)!
    expect(stat.desktop).toEqual({ devices: 1, users: 1, outdated: 0, bundledDevices: 1 })
    void deviceId
  })
})

describe('install-stats 的「旧」按各自平台的最新版本（docs/22 §2.1）', () => {
  it('桌面设备的「旧」跟桌面最新版本比，实例用户的「旧」跟云上最新版本比', async () => {
    const plugin = await createPlugin({ packageName: P, policy: 'optional' })
    const cloud1 = (await uploadVersion(plugin.id, '1.0.0', 'cloud')).id
    await uploadVersion(plugin.id, '2.0.0', 'cloud') // 云上最新 2.0.0
    await addDesktopVersion(plugin.id, '1.0.0')
    await addDesktopVersion(plugin.id, '1.1.0') // 桌面最新 1.1.0

    // 实例侧：alice 装着云上 1.0.0 → 比云上最新 2.0.0 旧
    app.deps.db.run(
      `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
       VALUES (?, ?, 'installed', ?, ?, 'synced', 'policy', NULL, ?)`,
      alice.id,
      plugin.id,
      cloud1,
      cloud1,
      app.deps.clock.nowIso(),
    )
    // 桌面侧：设备上报 1.2.0 —— 比云上最新 2.0.0 旧，但比**桌面最新 1.1.0** 新 → 不该算旧
    const report = await app.inject({
      method: 'POST',
      url: '/api/desktop/devices/report',
      headers: deviceHeaders(deviceToken),
      payload: reportBody({
        plugins: [{ name: P, version: '1.2.0', source: 'hub-default', state: 'enabled' }],
      }),
    })
    expect(report.statusCode, report.body).toBe(200)

    const statOf = async (): Promise<{
      latestVersion: string | null
      desktopLatestVersion?: string | null
      instance: { users: number; outdated: number }
      desktop: { devices: number; users: number; outdated: number }
    }> => {
      const res = await injectAs(adminSession, { method: 'GET', url: '/api/admin/plugins/install-stats' })
      expect(res.statusCode, res.body).toBe(200)
      const items = json<PluginInstallStatsResponse>(res).items
      return items.find((row) => row.pluginId === plugin.id)!
    }

    const stat = await statOf()
    expect(stat.latestVersion).toBe('2.0.0')
    expect(stat.desktopLatestVersion).toBe('1.1.0')
    expect(stat.instance).toEqual({ users: 1, outdated: 1 })
    // 关键：1.2.0 对云上最新 2.0.0 是旧的，对桌面最新 1.1.0 不是 → outdated=0
    expect(stat.desktop).toEqual({ devices: 1, users: 1, outdated: 0, bundledDevices: 0 })

    // 桌面发出 1.3.0 之后，同一个上报版本就变成旧的了
    await addDesktopVersion(plugin.id, '1.3.0')
    const after = await statOf()
    expect(after.desktopLatestVersion).toBe('1.3.0')
    expect(after.desktop).toEqual({ devices: 1, users: 1, outdated: 1, bundledDevices: 0 })
    // 实例侧口径没被带跑
    expect(after.instance).toEqual({ users: 1, outdated: 1 })
  })
})


describe('用量按来源筛选（docs/22 §1.3）', () => {
  function insertUsage(input: {
    clientKind: 'docker' | 'desktop' | 'external'
    model: string
    cost: number
  }): void {
    const at = app.deps.clock.nowIso()
    app.deps.db.run(
      `INSERT INTO relay_usage (request_id, created_at, user_id, model, channel_id, api, stream, source,
                                status, input_tokens, output_tokens, cost, scope, client_kind)
       VALUES (?, ?, ?, ?, NULL, 'openai-completions', 0, 'public', 'ok', 10, 5, ?, 'dsh', ?)`,
      `req-${input.clientKind}-${String(input.cost)}`,
      at,
      alice.id,
      input.model,
      input.cost,
      input.clientKind,
    )
    // 日汇总表（统计的默认数据源；它没有 client_kind，按来源筛时后端会回落到明细表）
    app.deps.db.run(
      `INSERT INTO relay_usage_daily (day, user_id, model, channel_id, requests, errors,
                                      input_tokens, output_tokens, cost, scope)
       VALUES (?, ?, ?, 0, 1, 0, 10, 5, ?, 'dsh')`,
      at.slice(0, 10),
      alice.id,
      input.model,
      input.cost,
    )
  }

  it('logs 与 stats 都按 clientKind 真过滤（桌面视图带 desktop）', async () => {
    insertUsage({ clientKind: 'desktop', model: 'm-desktop', cost: 100 })
    insertUsage({ clientKind: 'docker', model: 'm-docker', cost: 200 })
    insertUsage({ clientKind: 'external', model: 'm-external', cost: 300 })

    const logs = async (query = ''): Promise<{ total: number; items: { model: string }[] }> => {
      const res = await injectAs(adminSession, { method: 'GET', url: `/api/admin/relay/logs${query}` })
      expect(res.statusCode, res.body).toBe(200)
      return json<{ total: number; items: { model: string }[] }>(res)
    }
    const stats = async (query = ''): Promise<{
      total: { requests: number; costMicro: number }
      byModel: { model: string; requests: number }[]
    }> => {
      const res = await injectAs(adminSession, { method: 'GET', url: `/api/admin/relay/usage${query}` })
      expect(res.statusCode, res.body).toBe(200)
      return json(res)
    }

    // 不筛：三条都在
    expect((await logs()).total).toBe(3)
    expect((await stats()).total.requests).toBe(3)

    // 只筛桌面：日志与统计都只剩一条
    const desktopLogs = await logs('?clientKind=desktop')
    expect(desktopLogs.total).toBe(1)
    expect(desktopLogs.items.map((row) => row.model)).toEqual(['m-desktop'])
    const desktopStats = await stats('?clientKind=desktop')
    expect(desktopStats.total.requests).toBe(1)
    expect(desktopStats.total.costMicro).toBe(100)
    expect(desktopStats.byModel.map((row) => row.model)).toEqual(['m-desktop'])

    // 其它来源照样能筛；不存在的来源 = 空
    expect((await logs('?clientKind=docker')).items.map((row) => row.model)).toEqual(['m-docker'])
    expect((await stats('?clientKind=external')).total.costMicro).toBe(300)
    expect((await logs('?clientKind=unknown')).total).toBe(0)

    // 非法取值被契约拒绝
    const bad = await injectAs(adminSession, { method: 'GET', url: '/api/admin/relay/logs?clientKind=mobile' })
    expect(bad.statusCode, bad.body).toBe(400)
  })
})

async function seedModel(name: string): Promise<number> {
  const channel = createChannel(app, {
    name: `ch-${name}`,
    baseUrl: 'https://upstream.example/v1',
    apis: ['openai-completions'],
    keys: ['k-1'],
  })
  const model = await createRelayModel(app, {
    name,
    displayName: `显示 ${name}`,
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: `显示 ${name}`, contextWindow: 128_000, maxTokens: 8_192 },
    routes: [{ channelId: channel.id, upstreamModel: `up-${name}`, enabled: true }],
  })
  return model.id
}

function routeIdsOf(modelId: number): number[] {
  return app.deps.db
    .all<{ id: number }>('SELECT id FROM relay_routes WHERE model_id = ? ORDER BY id', modelId)
    .map((row) => row.id)
}

async function putDsh(
  platform: 'cloud' | 'desktop' | undefined,
  payload: Record<string, unknown>,
): Promise<RelayDshResponse> {
  const res = await injectAs(adminSession, {
    method: 'PUT',
    url: `/api/admin/relay/dsh${platform === undefined ? '' : `?platform=${platform}`}`,
    payload,
  })
  expect(res.statusCode, res.body).toBe(200)
  return json<RelayDshResponse>(res)
}

async function getDsh(platform?: 'cloud' | 'desktop'): Promise<RelayDshResponse> {
  const res = await injectAs(adminSession, {
    method: 'GET',
    url: `/api/admin/relay/dsh${platform === undefined ? '' : `?platform=${platform}`}`,
  })
  expect(res.statusCode, res.body).toBe(200)
  return json<RelayDshResponse>(res)
}

async function presets(platform?: 'cloud' | 'desktop'): Promise<ModelPreset[]> {
  const res = await injectAs(adminSession, {
    method: 'GET',
    url: `/api/admin/models/presets${platform === undefined ? '' : `?platform=${platform}`}`,
  })
  expect(res.statusCode, res.body).toBe(200)
  return json<ModelPreset[]>(res)
}


describe('预览的 skippedItems（docs/22 §2.2）', () => {
  it('整项跳过在预览里就能看到，且与提交结果一致', async () => {
    const cloudOnly = await createPlugin({ packageName: '@local/preview-cloud-only', policy: 'optional' })
    await uploadVersion(cloudOnly.id, '1.0.0', 'cloud', '@local/preview-cloud-only') // 有云上版本、没有桌面库
    const desktopOnly = await createPlugin({ packageName: P, policy: 'optional', platform: 'desktop' })
    const desktopVersion = await uploadVersion(desktopOnly.id, '1.0.0', 'desktop') // 只在桌面库 → 实例侧整项跳过

    const request = {
      platforms: ['instance', 'desktop'],
      action: 'install',
      items: [
        { kind: 'plugin', pluginId: cloudOnly.id },
        { kind: 'plugin', pluginId: desktopOnly.id, desktopVersionId: desktopVersion.id },
      ],
      targets: { mode: 'users', userIds: [alice.id] },
    }
    type Skip = { itemLabel: string; platform: string; reason: string }
    const sorted = (items: Skip[]): Skip[] =>
      [...items].sort((left, right) =>
        `${left.platform}|${left.itemLabel}` < `${right.platform}|${right.itemLabel}` ? -1 : 1,
      )

    const previewRes = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/deliveries/preview',
      payload: request,
    })
    expect(previewRes.statusCode, previewRes.body).toBe(200)
    const previewSkips = json<{ skippedItems: Skip[] }>(previewRes).skippedItems
    expect(sorted(previewSkips)).toEqual([
      {
        itemLabel: '@local/preview-cloud-only',
        platform: 'desktop',
        reason: '插件 @local/preview-cloud-only 不在桌面插件库',
      },
      { itemLabel: P, platform: 'instance', reason: `插件 ${P} 不在云上插件库` },
    ])

    // 提交时的 skippedItems 与预览一致（同形同口径）
    markReauth(adminSession)
    const created = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/deliveries',
      payload: request,
    })
    expect(created.statusCode, created.body).toBe(202)
    expect(sorted(json<{ skippedItems: Skip[] }>(created).skippedItems)).toEqual(sorted(previewSkips))
  })

  it('依赖版本的内容项：桌面有版本但没整包时预览就说明原因', async () => {
    const plugin = await createPlugin({ packageName: P, policy: 'optional' })
    // 云上版本 + 桌面库都在，但桌面版本还没上传整包（直接建版本行模拟「先建版本、后传整包」）
    await uploadVersion(plugin.id, '1.0.0', 'cloud')
    const desktop = await addDesktopVersion(plugin.id, '1.0.0')
    app.deps.db.run('DELETE FROM desktop_plugin_artifacts WHERE version_id = ?', desktop)

    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/deliveries/preview',
      payload: {
        platforms: ['desktop'],
        action: 'install',
        items: [{ kind: 'plugin', pluginId: plugin.id, desktopVersionId: desktop }],
        targets: { mode: 'users', userIds: [alice.id] },
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    const skips = json<{ skippedItems: { platform: string; reason: string }[] }>(res).skippedItems
    expect(skips).toHaveLength(1)
    expect(skips[0]!.platform).toBe('desktop')
    expect(skips[0]!.reason).toContain('还没有上传桌面整包')
  })
})

describe('桌面 lastDelivery（docs/22 §3）', () => {
  it('桌面接口给最近一次写模型片段的清单版本；云上不给这个键', async () => {
    const alpha = await seedModel('alpha-device')
    const routeIds = routeIdsOf(alpha)
    const first = await putDsh('desktop', { routeIds, defaultRouteId: routeIds[0] ?? null })
    // 第一次保存会把桌面模型基线写进清单（系统写入：by = null）
    expect(first.lastDelivery?.revision).toBe(counter())
    expect(first.lastDelivery?.by).toBeNull()
    expect((await getDsh()).lastDelivery).toBeUndefined()

    // 统一下发 models（桌面）→ lastDelivery 指到这次的 revision，by = 管理员用户名
    const before = counter()
    const presetId = (await presets('desktop')).find((row) => row.isDefault)!.id
    markReauth(adminSession)
    const created = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/deliveries',
      payload: {
        platforms: ['desktop'],
        action: 'apply-config',
        items: [{ kind: 'models', presetId }],
        targets: { mode: 'all' },
      },
    })
    expect(created.statusCode, created.body).toBe(202)
    expect(counter()).toBe(before + 1)
    const after = await getDsh('desktop')
    expect(after.lastDelivery).toEqual({
      revision: counter(),
      at: expect.any(String) as unknown as string,
      by: 'boss',
    })
  })
})

describe('统一下发的 desktopVersionId（docs/22 §2.2）', () => {
  it('desktopVersionId 只动桌面；versionId 只动实例', async () => {
    const plugin = await createPlugin({ packageName: P, policy: 'optional' })
    const cloudV1 = await uploadVersion(plugin.id, '1.0.0', 'cloud')
    const cloudV2 = await uploadVersion(plugin.id, '2.0.0', 'cloud')
    const desktopV1 = await uploadVersion(plugin.id, '1.0.0', 'desktop')
    const desktopV2 = await uploadVersion(plugin.id, '2.0.0', 'desktop')
    await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/plugins/${String(plugin.id)}/platforms/desktop`,
      payload: { policy: 'optional' },
    })

    markReauth(adminSession)
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/deliveries',
      payload: {
        platforms: ['instance', 'desktop'],
        action: 'install',
        items: [
          {
            kind: 'plugin',
            pluginId: plugin.id,
            versionId: cloudV2.id,
            desktopVersionId: desktopV1.id,
          },
        ],
        targets: { mode: 'users', userIds: [alice.id] },
        strategy: { concurrency: 1, canary: 0, maxFailureRatio: 0, restart: 'now' },
      },
    })
    expect(res.statusCode, res.body).toBe(202)

    const targets = app.deps.db.all<{ version_id: number }>(
      'SELECT version_id FROM desktop_plugin_targets WHERE plugin_id = ?',
      plugin.id,
    )
    // 桌面目标写的是 desktopVersionId（不是云上的 cloudV2）
    expect(targets.map((row) => row.version_id)).toEqual([desktopV1.id])
    expect(desktopV2.id).not.toBe(cloudV2.id)
    expect(cloudV1.id).not.toBe(desktopV1.id)
  })

  it('插件不在云上库 → 实例进 skippedItems；桌面照常写目标', async () => {
    // 只建桌面库的插件（platform=desktop）
    const plugin = await createPlugin({ packageName: P, platform: 'desktop', policy: 'optional' })
    const desktopV1 = await uploadVersion(plugin.id, '1.0.0', 'desktop')
    expect((await listPlugins('cloud')).map((row) => row.packageName)).not.toContain(P)

    markReauth(adminSession)
    const res = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/deliveries',
      payload: {
        platforms: ['instance', 'desktop'],
        action: 'install',
        items: [{ kind: 'plugin', pluginId: plugin.id, desktopVersionId: desktopV1.id }],
        targets: { mode: 'users', userIds: [alice.id] },
        strategy: { concurrency: 1, canary: 0, maxFailureRatio: 0, restart: 'now' },
      },
    })
    expect(res.statusCode, res.body).toBe(202)
    const body = json<{ skippedItems: { platform: string; reason: string }[] }>(res)
    expect(body.skippedItems).toHaveLength(1)
    expect(body.skippedItems[0]!.platform).toBe('instance')
    expect(body.skippedItems[0]!.reason).toContain('不在云上插件库')

    const targets = app.deps.db.all<{ version_id: number }>(
      'SELECT version_id FROM desktop_plugin_targets WHERE plugin_id = ?',
      plugin.id,
    )
    expect(targets.map((row) => row.version_id)).toEqual([desktopV1.id])
  })
})

describe('模型配置两平台独立（docs/22 §3）', () => {
  it('两套选中集合与两套系统预设互不影响；保存桌面配置不产生新 revision', async () => {
    const alpha = await seedModel('alpha-device')
    const beta = await seedModel('beta-device')
    const cloudRoutes = routeIdsOf(alpha)
    const desktopRoutes = routeIdsOf(beta)

    // 云上选 alpha
    const cloud = await putDsh(undefined, { routeIds: cloudRoutes, defaultRouteId: cloudRoutes[0] ?? null })
    expect(cloud.platform).toBe('cloud')
    expect(cloud.models.find((row) => row.id === alpha)?.selected).toBe(true)
    const cloudRevision = cloud.revision
    const revisionBefore = counter()

    // 桌面选 beta：只影响桌面
    const desktop = await putDsh('desktop', { routeIds: desktopRoutes, defaultRouteId: desktopRoutes[0] ?? null })
    expect(desktop.platform).toBe('desktop')
    expect(desktop.models.find((row) => row.id === alpha)?.selected).toBe(false)
    expect(desktop.models.find((row) => row.id === beta)?.selected).toBe(true)

    // 云上完全没变（选中集合、预设 revision）
    const cloudAgain = await getDsh()
    expect(cloudAgain.models.find((row) => row.id === alpha)?.selected).toBe(true)
    expect(cloudAgain.models.find((row) => row.id === beta)?.selected).toBe(false)
    expect(cloudAgain.revision).toBe(cloudRevision)

    // 第一次保存桌面配置 = 初始化：顺手补一次桌面模型基线（追加一条新 revision，docs/22 §3）
    expect(counter()).toBeGreaterThan(revisionBefore)
    const afterBaseline = counter()

    // 两平台的预设各一个默认，名字不同
    const cloudPresets = await presets('cloud')
    const desktopPresets = await presets('desktop')
    expect(cloudPresets.filter((row) => row.isDefault).map((row) => row.name)).toEqual(['Hub 中转站'])
    expect(desktopPresets.filter((row) => row.isDefault).map((row) => row.name)).toEqual([
      'Hub 中转站（桌面）',
    ])

    // 再保存一次桌面配置：预设 revision 不变（内容没变）+ **不改清单**（基线已经有那两条片段）
    const again = await putDsh('desktop', { routeIds: desktopRoutes, defaultRouteId: desktopRoutes[0] ?? null })
    expect(again.revision).toBe(desktop.revision)
    expect(counter()).toBe(afterBaseline)
  })

  it('桌面模型片段取桌面默认预设（与云上预设互不影响）', async () => {
    const alpha = await seedModel('alpha-device')
    const beta = await seedModel('beta-device')
    await putDsh(undefined, { routeIds: routeIdsOf(alpha), defaultRouteId: routeIdsOf(alpha)[0] ?? null })
    await putDsh('desktop', { routeIds: routeIdsOf(beta), defaultRouteId: routeIdsOf(beta)[0] ?? null })

    const res = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/desktop/config/model-preset',
    })
    expect(res.statusCode, res.body).toBe(200)
    const body = json<{ fragments: { id: string; config: Record<string, unknown> }[] }>(res)
    expect(body.fragments.map((row) => row.id)).toEqual(['llm-pi-ai', 'agent-default-model'])
    const providers = body.fragments[0]!.config['providers'] as Record<string, { models: { id: string }[] }>
    const modelIds = Object.values(providers).flatMap((provider) => provider.models.map((model) => model.id))
    // 桌面预设选的是 beta → 渲染出来只有 beta 那条路由（云上选的 alpha 不会漏进来）
    expect(modelIds.some((id) => id.includes('beta-device'))).toBe(true)
    expect(modelIds.some((id) => id.includes('alpha-device'))).toBe(false)
  })

  it('POST /models/presets 可以建到桌面平台；预设名只在平台内唯一', async () => {
    const alpha = await seedModel('alpha-device')
    // 预设要的是**提供方** id（中转站的系统路由由「下发到 DSH」建出来）
    await putDsh(undefined, { routeIds: routeIdsOf(alpha), defaultRouteId: routeIdsOf(alpha)[0] ?? null })
    const provider = app.deps.db.get<{ id: number; route_key: string }>(
      "SELECT id, route_key FROM model_providers WHERE route_key LIKE 'hub%' ORDER BY id LIMIT 1",
    )
    expect(provider).toBeDefined()
    const providerIds = [provider!.id]
    const routeKey = provider!.route_key
    const modelId = 'alpha-device@ch-alpha-device'
    const cloudPreset = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/presets',
      payload: {
        name: '同名预设',
        providerIds,
        defaultProvider: routeKey,
        defaultModel: modelId,
        isDefault: true,
      },
    })
    // 建预设的接口一直是 200（不是 201）
    expect(cloudPreset.statusCode, cloudPreset.body).toBe(200)
    expect(json<{ preset: ModelPreset }>(cloudPreset).preset.platform ?? 'cloud').toBe('cloud')
    // 同名建到桌面平台：允许（名字只在平台内唯一）
    const desktopPreset = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/presets',
      payload: {
        name: '同名预设',
        providerIds,
        defaultProvider: routeKey,
        defaultModel: modelId,
        platform: 'desktop',
      },
    })
    expect(desktopPreset.statusCode, desktopPreset.body).toBe(200)
    const created = json<{ preset: ModelPreset }>(desktopPreset).preset
    expect(created.platform).toBe('desktop')
    // 桌面平台的第一个预设自动成为桌面默认（云上的系统预设管不到桌面）
    expect(created.isDefault).toBe(true)
    // 同一平台再建同名 → 409
    const duplicate = await injectAs(adminSession, {
      method: 'POST',
      url: '/api/admin/models/presets',
      payload: {
        name: '同名预设',
        providerIds,
        defaultProvider: routeKey,
        defaultModel: modelId,
        platform: 'desktop',
      },
    })
    expect(duplicate.statusCode, duplicate.body).toBe(409)
    // 桌面默认是刚建的那条；云上的默认仍是「下发到 DSH」维护的系统预设（云上手工建的默认会被它收回）
    const desktopPresets = await presets('desktop')
    expect(desktopPresets.filter((row) => row.isDefault).map((row) => row.name)).toEqual(['同名预设'])
    const cloudPresets = await presets('cloud')
    expect(cloudPresets.filter((row) => row.isDefault).map((row) => row.name)).toEqual(['Hub 中转站'])
    expect(cloudPresets.some((row) => row.name === '同名预设')).toBe(true)
  })

  it('桌面默认预设不存在时从云上默认预设复制（幂等，不重复建）', async () => {
    const alpha = await seedModel('alpha-device')
    // 先把云上模型配置保存一次（建出云上系统预设）
    await putDsh(undefined, { routeIds: routeIdsOf(alpha), defaultRouteId: routeIdsOf(alpha)[0] ?? null })
    const cloud = await presets('cloud')
    expect(cloud).toHaveLength(1)
    expect(await presets('desktop')).toEqual([])
    // 第一次读桌面模型片段会顺手复制一份
    const res = await injectAs(adminSession, {
      method: 'GET',
      url: '/api/admin/desktop/config/model-preset',
    })
    expect(res.statusCode, res.body).toBe(200)
    const desktop = await presets('desktop')
    expect(desktop).toHaveLength(1)
    expect(desktop[0]!.isDefault).toBe(true)
    // 再读一次也不多建
    await injectAs(adminSession, { method: 'GET', url: '/api/admin/desktop/config/model-preset' })
    expect(await presets('desktop')).toHaveLength(1)
  })
})
