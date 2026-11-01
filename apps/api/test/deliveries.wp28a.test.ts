import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DeliveryRequest } from '@dsh-hub/shared'
import { createUser, json, loginAs, type TestSession, type TestUser } from './helpers.js'
import { cleanupDirs, createWp3App, waitFor, writeProfile, type Wp3TestApp } from './helpers-wp3.js'
import { deviceHeaders, loginDesktop, reportBody } from './helpers-desktop.js'
import { buildPreview, DELIVERY_PREVIEW_MAX_ROWS } from '../src/modules/deliveries/preview.js'

/**
 * WP28a 统一下发（docs/21）：三个接口（preview / create / install-stats）的集成测试。
 *
 * 走真 HTTP（路由 → service → SQLite），假容器驱动（FakeDriver）让实例侧的 rollout 任务真的跑完。
 * 覆盖任务书交付物 1–5：目标解析（all/users/role/installed + outdatedOnly）、预览只读与 warnings、
 * 提交（每个内容项一个 job / 桌面一次一个 revision / 配置片段不被冲掉 / skippedItems / 部分失败）、
 * 安装统计（一条 SQL 的口径）、审计与二次密码。
 */

let app: FastifyInstance
let ctx: Wp3TestApp
let adminSession: TestSession
let alice: TestUser
let bob: TestUser
let aliceSession: TestSession
let bobSession: TestSession
let deviceA1: string
let deviceA2: string
let deviceB1: string
const tempDirs: string[] = []

const ALPHA = 'dsh-alpha'
const BETA = 'dsh-beta'
/** 设备 installId 必须是 UUIDv4（契约层校验）；同一台机器重登要复用同一个 */
const INSTALL_A1 = randomUUID()
const INSTALL_A2 = randomUUID()
const INSTALL_B1 = randomUUID()

interface Seeded {
  pluginId: number
  v1: number
  v2: number
  /** 桌面版本（只有 `desktopArtifact` 时才有） */
  d1?: number
  d2?: number
}

/** 一个插件 + 两个版本（`0.1.0` / `0.2.0`，可选桌面整包与 minDsh） */
function seedPluginWithVersions(
  packageName: string,
  options: { desktopArtifact?: boolean; desktopVersion?: boolean; minDsh?: string | null } = {},
): Seeded {
  const now = app.deps.clock.nowIso()
  const plugin = app.deps.db.run(
    `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                          is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, 'optional', 1, 100, '', 1, ?, ?)`,
    packageName,
    packageName,
    now,
    now,
  )
  // WP32a：插件出现在某平台的库里 ⇔ 有 plugin_platforms 行（云上总有；有桌面整包时再建桌面行）
  const insertPlatform = (platform: 'cloud' | 'desktop'): void => {
    app.deps.db.run(
      `INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
       VALUES (?, ?, 'optional', 100, '', 1, ?, ?)`,
      plugin.lastInsertRowid,
      platform,
      now,
      now,
    )
  }
  insertPlatform('cloud')
  if (options.desktopArtifact === true || options.desktopVersion === true) insertPlatform('desktop')
  const versions: number[] = []
  const desktopVersions: number[] = []
  for (const version of ['0.1.0', '0.2.0']) {
    const row = app.deps.db.run(
      `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256,
                                   min_dsh, created_at)
       VALUES (?, 'cloud', ?, 'npm', ?, ?, NULL, NULL, ?, ?)`,
      plugin.lastInsertRowid,
      version,
      `${packageName}@${version}`,
      version,
      options.minDsh ?? null,
      now,
    )
    versions.push(row.lastInsertRowid)
    if (options.desktopArtifact === true || options.desktopVersion === true) {
      // 桌面版本：桌面整包挂在它上面（迁移 123 之后的口径）
      const desktop = app.deps.db.run(
        `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256,
                                     min_dsh, created_at)
         VALUES (?, 'desktop', ?, 'npm', ?, ?, NULL, NULL, ?, ?)`,
        plugin.lastInsertRowid,
        version,
        `${packageName}@${version}`,
        version,
        options.minDsh ?? null,
        now,
      )
      desktopVersions.push(desktop.lastInsertRowid)
      if (options.desktopArtifact === true)
        app.deps.db.run(
        `INSERT INTO desktop_plugin_artifacts (version_id, plugin_id, file_name, bytes, sha256, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, 1024, ?, NULL, ?)`,
        desktop.lastInsertRowid,
        plugin.lastInsertRowid,
        `${packageName}-${version}.tgz`,
        'f'.repeat(64),
        now,
      )
    }
  }
  return {
    pluginId: plugin.lastInsertRowid,
    v1: versions[0]!,
    v2: versions[1]!,
    d1: desktopVersions[0],
    d2: desktopVersions[1],
  }
}

/** 一个 pi-ai 提供方 + 一条 hub-relay 提供方 + 默认预设（桌面 models 片段与实例「在用 Hub 路由」都要它） */
function seedModelPreset(): { presetId: number; desktopPresetId: number; routeKey: string } {
  const now = app.deps.clock.nowIso()
  const routeKey = 'hub-test'
  const provider = app.deps.db.run(
    `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                  extra_json, key_mode, api_key_enc, enabled, created_at, updated_at)
     VALUES (?, ?, 'pi-ai', 'openai-completions', 'https://upstream.test/v1', ?, NULL, NULL, 'none', NULL, 1, ?, ?)`,
    routeKey,
    'Hub 测试',
    JSON.stringify([{ id: 'test-model', name: 'Test Model', contextWindow: 128000, maxTokens: 8192 }]),
    now,
    now,
  )
  const relay = app.deps.db.run(
    `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                  extra_json, key_mode, api_key_enc, enabled, is_relay, created_at, updated_at)
     VALUES ('hub', 'Hub 中转站', 'pi-ai', 'openai-completions', 'http://127.0.0.1:1/v1', '[]', NULL, NULL,
             'per-user', NULL, 1, 1, ?, ?)`,
    now,
    now,
  )
  const preset = app.deps.db.run(
    `INSERT INTO model_presets (name, description, provider_ids_json, default_provider, default_model,
                                is_default, revision, created_at, updated_at)
     VALUES ('系统预设', '', ?, ?, 'test-model', 1, 1, ?, ?)`,
    JSON.stringify([provider.lastInsertRowid, relay.lastInsertRowid]),
    routeKey,
    now,
    now,
  )
  // docs/22 §3：桌面平台也有自己的默认预设（迁移 124 的复制逻辑，测试里手工造一份）
  const desktopPreset = app.deps.db.run(
    `INSERT INTO model_presets (platform, name, description, provider_ids_json, default_provider, default_model,
                                is_default, revision, created_at, updated_at)
     VALUES ('desktop', '系统预设（桌面）', '', ?, ?, 'test-model', 1, 1, ?, ?)`,
    JSON.stringify([provider.lastInsertRowid, relay.lastInsertRowid]),
    routeKey,
    now,
    now,
  )
  return { presetId: preset.lastInsertRowid, desktopPresetId: desktopPreset.lastInsertRowid, routeKey }
}

/** 让某个用户在实例侧「装了」某插件（`user_plugins` 的期望状态 + 实际状态） */
function seedInstalledPlugin(userId: number, pluginId: number, versionId: number): void {
  app.deps.db.run(
    `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id,
                               state, source, error, updated_at)
     VALUES (?, ?, 'installed', ?, ?, 'synced', 'admin', NULL, ?)
     ON CONFLICT(user_id, plugin_id) DO UPDATE SET
       desired = 'installed', desired_version_id = excluded.desired_version_id,
       actual_version_id = excluded.actual_version_id, state = 'synced'`,
    userId,
    pluginId,
    versionId,
    versionId,
    app.deps.clock.nowIso(),
  )
}

function insertRuntime(dshVersion: string, isDefault: boolean): number {
  const now = app.deps.clock.nowIso()
  const row = app.deps.db.run(
    `INSERT INTO runtimes (dsh_version, image, status, is_default, size_bytes, notes, created_at)
     VALUES (?, ?, 'ready', ?, 1, '', ?)`,
    dshVersion,
    `dshhub/runtime:${dshVersion}`,
    isDefault ? 1 : 0,
    now,
  )
  return row.lastInsertRowid
}

async function reportPlugins(token: string, plugins: { name: string; version: string }[]): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/desktop/devices/report',
    headers: deviceHeaders(token),
    payload: reportBody({
      plugins: plugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        source: 'hub-core',
        state: 'enabled',
      })),
    }),
  })
  expect(response.statusCode, response.body).toBe(200)
}

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

/** 给会话打上「刚输过密码」的标记（rollouts 测试同款；不依赖 /api/auth/reauth 的实现） */
function markReauth(session: TestSession): void {
  app.deps.db.run(
    'UPDATE sessions SET reauth_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(),
    session.sessionId,
  )
}

async function preview(payload: DeliveryRequest, session: TestSession = adminSession) {
  const response = await injectAs(session, {
    method: 'POST',
    url: '/api/admin/deliveries/preview',
    payload,
  })
  return { response, body: json<Record<string, unknown>>(response) }
}

async function create(payload: DeliveryRequest, session: TestSession = adminSession) {
  const response = await injectAs(session, { method: 'POST', url: '/api/admin/deliveries', payload })
  return { response, body: json<Record<string, unknown>>(response) }
}

function requestOf(partial: Partial<DeliveryRequest> & Pick<DeliveryRequest, 'items'>): DeliveryRequest {
  return {
    platforms: ['instance', 'desktop'],
    action: 'install',
    targets: { mode: 'all' },
    ...partial,
  } as DeliveryRequest
}

function counter(): number {
  const row = app.deps.db.get<{ revision: number }>('SELECT revision FROM desktop_delivery_counter WHERE id = 1')
  return Number(row?.revision ?? 0)
}

function auditEntries(action: string): { detail: Record<string, unknown> | null }[] {
  return app.deps.db
    .all<{ detail_json: string | null }>('SELECT detail_json FROM audit_logs WHERE action = ? ORDER BY id', action)
    .map((row) => ({
      detail: row.detail_json === null ? null : (JSON.parse(row.detail_json) as Record<string, unknown>),
    }))
}

beforeEach(async () => {
  ctx = await createWp3App()
  app = ctx.app
  const admin = await createUser(app, { username: 'wp28a-admin', role: 'admin' })
  adminSession = loginAs(app, admin)
  markReauth(adminSession)
  writeProfile(app, admin.slug)

  alice = await createUser(app, { username: 'wp28a-alice' })
  bob = await createUser(app, { username: 'wp28a-bob' })
  aliceSession = loginAs(app, alice)
  bobSession = loginAs(app, bob)
  writeProfile(app, alice.slug)
  writeProfile(app, bob.slug)

  const first = await loginDesktop(app, aliceSession, { name: 'Alice 的 Windows', installId: INSTALL_A1 })
  const second = await loginDesktop(app, aliceSession, { name: 'Alice 的 Mac', installId: INSTALL_A2 })
  const bobLogin = await loginDesktop(app, bobSession, { name: 'Bob 的 Windows', installId: INSTALL_B1 })
  deviceA1 = first.deviceId
  deviceA2 = second.deviceId
  deviceB1 = bobLogin.deviceId
  // 设备上报：A 的第一台与 B 的那台都装了 ALPHA 的旧版（用于「已安装」的桌面解析）
  await reportPlugins(first.token, [{ name: ALPHA, version: '0.1.0' }])
  await reportPlugins(second.token, [])
  await reportPlugins(bobLogin.token, [{ name: ALPHA, version: '0.1.0' }])
})

afterEach(async () => {
  await ctx.close()
  cleanupDirs(tempDirs)
})

interface PreviewRowLite {
  platform: string
  userId: number
  username: string
  deviceId: string | null
  deviceName: string | null
  itemLabel: string
  current: string
  after: string
  needsRestart: boolean
  skipReason: string | null
}

describe('统一下发 · 预览（交付物 1、2）', () => {
  it('预览是只读的：预览前后库里行数不变', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    seedInstalledPlugin(alice.id, alpha.pluginId, alpha.v1)
    const tables = [
      'user_plugins',
      'desktop_plugin_targets',
      'desktop_config_fragments',
      'desktop_uninstall_targets',
      'desktop_deliveries',
      'desktop_delivery_counter',
      'jobs',
      'job_tasks',
      'audit_logs',
    ]
    const countAll = (): Record<string, number> =>
      Object.fromEntries(
        tables.map((table) => {
          const row = app.deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
          return [table, Number(row?.n ?? 0)]
        }),
      )
    const before = countAll()
    const { response, body } = await preview(
      requestOf({
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 }],
        targets: { mode: 'installed', outdatedOnly: false },
      }),
    )
    expect(response.statusCode, response.body).toBe(200)
    expect((body.rows as unknown[]).length).toBeGreaterThan(0)
    expect(countAll()).toEqual(before)
  })

  it('installed：实例按 user_plugins 解析、桌面按设备上报解析（一台设备一行）', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    seedInstalledPlugin(alice.id, alpha.pluginId, alpha.v1)
    const { response, body } = await preview(
      requestOf({
        action: 'upgrade',
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 }],
        targets: { mode: 'installed', outdatedOnly: false },
      }),
    )
    expect(response.statusCode, response.body).toBe(200)
    const rows = body.rows as PreviewRowLite[]
    const instanceRows = rows.filter((row) => row.platform === 'instance')
    const desktopRows = rows.filter((row) => row.platform === 'desktop')
    expect(instanceRows.map((row) => row.userId)).toEqual([alice.id])
    expect(instanceRows[0]!.current).toBe(`${ALPHA}@0.1.0`)
    expect(instanceRows[0]!.after).toBe(`${ALPHA}@0.2.0`)
    expect(instanceRows[0]!.skipReason).toBeNull()
    expect(instanceRows[0]!.needsRestart).toBe(false) // 用户没有实例在跑 → 不会重启
    expect(instanceRows[0]!.itemLabel).toBe(`${ALPHA} 0.2.0`)
    // 只解析出「上报里有这个包」的两台设备（A 的第一台、B 的那台），一台设备一行
    expect(desktopRows.map((row) => row.deviceId).sort()).toEqual([deviceA1, deviceB1].sort())
    expect(desktopRows.map((row) => row.deviceName).sort()).toEqual(['Alice 的 Windows', 'Bob 的 Windows'])
    expect(desktopRows.every((row) => row.deviceId !== null && row.after === `${ALPHA}@0.2.0`)).toBe(true)
    expect(desktopRows.every((row) => row.needsRestart)).toBe(true)
    expect(body.summary).toEqual({
      instance: { willRun: 1, skipped: 0, users: 1 },
      desktop: { willRun: 2, skipped: 0, users: 2, devices: 2 },
    })
    expect(body.truncated).toBe(false)
  })

  it('outdatedOnly：只保留版本低于目标版本的目标；否则标「已是该版本」', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    seedInstalledPlugin(alice.id, alpha.pluginId, alpha.v1)
    // 先真正下发一次 0.1.0（桌面目标也会落到同一版本），之后同一目标的预览才是「已是该版本」
    const seeded = await create(
      requestOf({
        action: 'upgrade',
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1, desktopVersionId: alpha.d1 },
        ],
        targets: { mode: 'users', userIds: [alice.id, bob.id] },
      }),
    )
    expect(seeded.response.statusCode, seeded.response.body).toBe(202)
    // 等两个实例任务真的跑完（actual 才等于 0.1.0），否则预览会看到「待执行」
    for (const job of seeded.body.jobs as { jobId: number }[]) {
      await waitFor(
        async () => (await app.deps.services.jobs.get(job.jobId)).job.status === 'succeeded',
        { label: `seeded job ${String(job.jobId)}` },
      )
    }
    const same = await preview(
      requestOf({
        action: 'upgrade',
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1, desktopVersionId: alpha.d1 },
        ],
        targets: { mode: 'installed', outdatedOnly: false },
      }),
    )
    expect(same.response.statusCode, same.response.body).toBe(200)
    const sameRows = same.body.rows as PreviewRowLite[]
    // 上一次下发把 alice 与 bob 都装上了 0.1.0（实例两人、桌面两台设备）
    expect(sameRows).toHaveLength(4)
    expect(sameRows.every((row) => row.skipReason === '已是该版本')).toBe(true)
    expect(same.body.summary).toEqual({
      instance: { willRun: 0, skipped: 2, users: 2 },
      desktop: { willRun: 0, skipped: 2, users: 2, devices: 2 },
    })

    // 目标 = 0.2.0 + outdatedOnly：0.1.0 都算旧 → 全部保留
    const outdated = await preview(
      requestOf({
        action: 'upgrade',
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2, desktopVersionId: alpha.d2 },
        ],
        targets: { mode: 'installed', outdatedOnly: true },
      }),
    )
    expect((outdated.body.rows as unknown[]).length).toBe(4)

    // 目标 = 0.1.0 + outdatedOnly：没人「更旧」→ 0 行 + 警告
    const nothing = await preview(
      requestOf({
        action: 'upgrade',
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1, desktopVersionId: alpha.d1 },
        ],
        targets: { mode: 'installed', outdatedOnly: true },
      }),
    )
    expect((nothing.body.rows as unknown[]).length).toBe(0)
    expect((nothing.body.warnings as string[]).some((line) => line.includes('没有解析到任何'))).toBe(true)
  })

  it('设备上报的版本号解析不出来 → 按「较旧」保留并在行里写明', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    // 设备上报的 version 会过契约校验（必须是 semver），所以这里直接改库模拟「历史脏数据」
    app.deps.db.run("UPDATE desktop_device_plugins SET version = 'next' WHERE device_id = ?", deviceA1)
    const { body } = await preview(
      requestOf({
        platforms: ['desktop'],
        action: 'upgrade',
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 }],
        targets: { mode: 'installed', outdatedOnly: true },
      }),
    )
    const rows = body.rows as PreviewRowLite[]
    const target = rows.find((row) => row.deviceId === deviceA1)
    expect(target).toBeDefined()
    expect(target!.current).toBe(`${ALPHA}@next（无法解析版本，按较旧处理）`)
    expect(target!.skipReason).toBeNull()
    expect((body.warnings as string[]).some((line) => line.includes('解析不出来'))).toBe(true)
  })

  it('已吊销设备不进目标；users 目标里显式点名时标「设备已吊销」', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    app.deps.db.run("UPDATE desktop_devices SET status = 'revoked' WHERE device_id = ?", deviceB1)

    const all = await preview(
      requestOf({ items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1 }] }),
    )
    const allDesktop = (all.body.rows as PreviewRowLite[]).filter((row) => row.platform === 'desktop')
    expect(allDesktop.map((row) => row.deviceId).sort()).toEqual([deviceA1, deviceA2].sort())

    const chosen = await preview(
      requestOf({
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1 }],
        targets: { mode: 'users', userIds: [bob.id] },
      }),
    )
    const bobRows = (chosen.body.rows as PreviewRowLite[]).filter((row) => row.platform === 'desktop')
    expect(bobRows).toHaveLength(1)
    expect(bobRows[0]!.skipReason).toBe('设备已吊销')
    const summary = chosen.body.summary as {
      desktop: { willRun: number; skipped: number; users: number; devices: number }
    }
    expect(summary.desktop).toEqual({ willRun: 0, skipped: 1, users: 1, devices: 1 })
  })

  it('桌面缺整包的内容项整项跳过并给 warning，其余项照常', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    // beta 在桌面库里有版本但没上传整包 → 「还没有上传桌面整包」
    const beta = seedPluginWithVersions(BETA, { desktopVersion: true })
    const { body } = await preview(
      requestOf({
        platforms: ['desktop'],
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 },
          { kind: 'plugin', pluginId: beta.pluginId, versionId: beta.v2 },
        ],
      }),
    )
    const labels = (body.rows as PreviewRowLite[]).map((row) => row.itemLabel)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.every((label) => label.startsWith(ALPHA))).toBe(true)
    expect((body.warnings as string[]).some((line) => line.includes('还没有上传桌面整包'))).toBe(true)
  })

  it('实例用户的 DSH 版本低于插件 minDsh → 行标不兼容并给 warning', async () => {
    insertRuntime('0.2.1', true)
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true, minDsh: '>=0.5.0' })
    const { body } = await preview(
      requestOf({
        platforms: ['instance'],
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 }],
        targets: { mode: 'users', userIds: [alice.id] },
      }),
    )
    const rows = body.rows as PreviewRowLite[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.skipReason).toContain('DSH 版本不兼容')
    expect(rows[0]!.needsRestart).toBe(false)
    expect((body.warnings as string[]).some((line) => line.includes('DSH 版本'))).toBe(true)
  })

  it('runtime 选桌面：契约层拒绝「只选桌面」；两个平台都选时桌面侧给 warning 且没有桌面行', async () => {
    const runtimeId = insertRuntime('0.2.2', false)
    const onlyDesktop = await preview(requestOf({ platforms: ['desktop'], items: [{ kind: 'runtime', runtimeId }] }))
    expect(onlyDesktop.response.statusCode).toBe(400)

    const both = await preview(requestOf({ items: [{ kind: 'runtime', runtimeId }] }))
    expect(both.response.statusCode, both.response.body).toBe(200)
    const rows = both.body.rows as PreviewRowLite[]
    expect(rows.every((row) => row.platform === 'instance')).toBe(true)
    expect((both.body.warnings as string[]).some((line) => line.includes('只能下发给实例'))).toBe(true)
    expect(rows[0]!.itemLabel).toBe('DSH 0.2.2')
  })

  it('行数上限 2000（可注入上限同一条路径）+ 目标为 0 时给 warning', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const request = requestOf({
      platforms: ['instance'],
      items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1 }],
    })
    const full = await preview(request)
    expect((full.body.rows as unknown[]).length).toBe(3) // admin + alice + bob
    expect(DELIVERY_PREVIEW_MAX_ROWS).toBe(2000)

    const limited = await buildPreview(
      {
        ...app.deps,
        services: app.deps.services,
        rolloutPreview: (input, actorId) => app.deps.services.rollouts.preview(input, actorId),
      },
      request,
      { maxRows: 2 },
    )
    expect(limited.rows).toHaveLength(2)
    expect(limited.truncated).toBe(true)

    const nobody = seedPluginWithVersions(BETA, { desktopArtifact: true })
    const empty = await preview(
      requestOf({
        items: [{ kind: 'plugin', pluginId: nobody.pluginId, versionId: nobody.v1 }],
        targets: { mode: 'installed', outdatedOnly: false },
      }),
    )
    expect((empty.body.rows as unknown[]).length).toBe(0)
    expect((empty.body.warnings as string[]).some((line) => line.includes('没有解析到任何'))).toBe(true)
  })
})

describe('统一下发 · 提交（交付物 3、5）', () => {
  it('没有二次密码 → 403 REAUTH_REQUIRED，且什么都不写', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const other = await createUser(app, { username: 'wp28a-admin2', role: 'admin' })
    const fresh = loginAs(app, other)
    const revisionBefore = counter()
    const { response } = await create(
      requestOf({ items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1 }] }),
      fresh,
    )
    expect(response.statusCode).toBe(403)
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('REAUTH_REQUIRED')
    expect(counter()).toBe(revisionBefore)
    const targets = app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_plugin_targets')
    expect(Number(targets?.n ?? 0)).toBe(0)
  })

  it('实例侧每个内容项一个 job，job 真的跑完（假容器）；桌面侧只 +1 个 revision', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const beta = seedPluginWithVersions(BETA, { desktopArtifact: true })
    const revisionBefore = Math.max(1, counter())
    const { response, body } = await create(
      requestOf({
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 },
          { kind: 'plugin', pluginId: beta.pluginId, versionId: beta.v2 },
        ],
        targets: { mode: 'users', userIds: [alice.id, bob.id] },
      }),
    )
    expect(response.statusCode, response.body).toBe(202)
    const jobs = body.jobs as { jobId: number; itemLabel: string }[]
    expect(jobs).toHaveLength(2)
    expect(jobs.map((job) => job.itemLabel).sort()).toEqual([`${ALPHA} 0.2.0`, `${BETA} 0.2.0`].sort())
    expect(counter()).toBe(revisionBefore + 1)
    const desktop = body.desktop as { revision: number; users: number; devices: number }
    expect(desktop.revision).toBe(revisionBefore + 1)
    expect(desktop.users).toBe(2)
    expect(desktop.devices).toBe(3)

    for (const job of jobs) {
      await waitFor(
        async () => {
          const detail = await app.deps.services.jobs.get(job.jobId)
          return detail.job.status === 'succeeded' ? detail : ''
        },
        { label: `job ${String(job.jobId)}` },
      )
    }
    const alicePlugins = app.deps.db.all<{ plugin_id: number; actual_version_id: number }>(
      'SELECT plugin_id, actual_version_id FROM user_plugins WHERE user_id = ? ORDER BY plugin_id',
      alice.id,
    )
    expect(alicePlugins.map((row) => row.actual_version_id)).toEqual([alpha.v2, beta.v2])
    const targets = app.deps.db.all<{ plugin_id: number; version_id: number; scope: string; user_id: number }>(
      'SELECT plugin_id, version_id, scope, user_id FROM desktop_plugin_targets ORDER BY plugin_id, user_id',
    )
    expect(targets).toHaveLength(4)
    expect(targets.every((row) => row.scope === 'user')).toBe(true)
    // docs/22 §2.2：桌面目标写的是**桌面版本**（同名版本号在两平台各有一条，id 不同）
    expect(targets.filter((row) => row.user_id === alice.id).map((row) => row.version_id)).toEqual([
      alpha.d2,
      beta.d2,
    ])
    // 请求没给 strategy → 用 StrategySchema 的默认值（3 / 1 / 0.2 / now）
    const strategies = app.deps.db.all<{ strategy_json: string }>('SELECT strategy_json FROM jobs ORDER BY id')
    expect(strategies.map((row) => JSON.parse(row.strategy_json))).toEqual([
      { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
      { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    ])
  })

  it('桌面 models：写 llm-pi-ai / agent-default-model，别的片段与模式都还在', async () => {
    const preset = seedModelPreset()
    const now = app.deps.clock.nowIso()
    for (const fragment of [
      {
        entryId: 'hub-connector',
        mode: 'enforce',
        config: { python: { mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple' } },
      },
      { entryId: 'llm-pi-ai', mode: 'default', config: { providers: {} } },
    ]) {
      app.deps.db.run(
        `INSERT INTO desktop_config_fragments (entry_id, mode, config_json, note, scope, role, user_id,
                                              updated_by, updated_at)
         VALUES (?, ?, ?, '原有备注', 'user', '', ?, NULL, ?)`,
        fragment.entryId,
        fragment.mode,
        JSON.stringify(fragment.config),
        alice.id,
        now,
      )
    }
    const revisionBefore = Math.max(1, counter())
    const { response, body } = await create(
      requestOf({
        platforms: ['desktop'],
        action: 'apply-config',
        // docs/22 §3：桌面侧的 presetId 必须是**桌面平台**的预设
        items: [{ kind: 'models', presetId: preset.desktopPresetId }],
        targets: { mode: 'users', userIds: [alice.id] },
      }),
    )
    expect(response.statusCode, response.body).toBe(202)
    expect((body.desktop as { revision: number }).revision).toBe(revisionBefore + 1)
    const fragments = app.deps.db.all<{ entry_id: string; mode: string; config_json: string; note: string }>(
      `SELECT entry_id, mode, config_json, note FROM desktop_config_fragments
        WHERE scope = 'user' AND user_id = ? ORDER BY entry_id`,
      alice.id,
    )
    expect(fragments.map((row) => row.entry_id)).toEqual(['agent-default-model', 'hub-connector', 'llm-pi-ai'])
    const connector = fragments.find((row) => row.entry_id === 'hub-connector')!
    expect(JSON.parse(connector.config_json)).toEqual({
      python: { mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
    })
    const llm = fragments.find((row) => row.entry_id === 'llm-pi-ai')!
    expect(llm.mode).toBe('default') // 模式保留
    expect(llm.note).toBe('原有备注')
    const parsed = JSON.parse(llm.config_json) as { providers: Record<string, unknown> }
    expect(Object.keys(parsed.providers)).toContain(preset.routeKey)
    const def = fragments.find((row) => row.entry_id === 'agent-default-model')!
    expect(JSON.parse(def.config_json)).toMatchObject({ provider: preset.routeKey, model: 'test-model' })
    expect(def.mode).toBe('enforce')
    expect(def.note).toBe('')
  })

  it('installed + 两个插件（一个有桌面整包、一个没有）→ 缺的进 skippedItems，其余照常', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const beta = seedPluginWithVersions(BETA, { desktopArtifact: false })
    seedInstalledPlugin(alice.id, alpha.pluginId, alpha.v1)
    seedInstalledPlugin(alice.id, beta.pluginId, beta.v1)
    const revisionBefore = Math.max(1, counter())
    const { response, body } = await create(
      requestOf({
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 },
          { kind: 'plugin', pluginId: beta.pluginId, versionId: beta.v2 },
        ],
        targets: { mode: 'installed', outdatedOnly: true },
      }),
    )
    expect(response.statusCode, response.body).toBe(202)
    const skipped = body.skippedItems as { itemLabel: string; platform: string; reason: string }[]
    expect(skipped.some((item) => item.platform === 'desktop' && item.itemLabel.startsWith(BETA))).toBe(true)
    expect(skipped.some((item) => item.platform === 'instance' && item.itemLabel.startsWith(ALPHA))).toBe(false)
    expect(counter()).toBe(revisionBefore + 1)
    const targets = app.deps.db.all<{ plugin_id: number; user_id: number }>(
      'SELECT plugin_id, user_id FROM desktop_plugin_targets ORDER BY user_id',
    )
    // 只写了 alpha；B 的设备也上报了这个包，所以 alice 与 bob 各一个 user 作用域目标
    expect(new Set(targets.map((row) => row.plugin_id))).toEqual(new Set([alpha.pluginId]))
    expect(targets.map((row) => row.user_id).sort((left, right) => left - right)).toEqual([alice.id, bob.id])
    expect((body.jobs as unknown[]).length).toBe(2)
  })

  it('两个平台都没有可执行项 → 400 VALIDATION_FAILED', async () => {
    const nobody = seedPluginWithVersions(BETA, { desktopArtifact: true })
    const { response, body } = await create(
      requestOf({
        items: [{ kind: 'plugin', pluginId: nobody.pluginId, versionId: nobody.v1 }],
        targets: { mode: 'installed', outdatedOnly: false },
      }),
    )
    expect(response.statusCode).toBe(400)
    expect((body.error as { code: string }).code).toBe('VALIDATION_FAILED')
    expect(counter()).toBe(0)
  })

  it('重复提交同一请求不去重：每次都生成新 job 与新 revision', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    // 让实例侧的安装失败：期望状态保持 pending/actual 不变，第二次提交仍然要建新 job
    // （这里只验证「不去重」，不验证任务成败）
    ctx.driver.setExecHandler(() => ({ exitCode: 1, output: 'boom' }))
    const payload = requestOf({
      items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 }],
      targets: { mode: 'users', userIds: [alice.id] },
    })
    const first = await create(payload)
    const second = await create(payload)
    expect(first.response.statusCode, first.response.body).toBe(202)
    expect(second.response.statusCode, second.response.body).toBe(202)
    const firstJob = (first.body.jobs as { jobId: number }[])[0]!.jobId
    const secondJob = (second.body.jobs as { jobId: number }[])[0]!.jobId
    expect(secondJob).not.toBe(firstJob)
    expect(counter()).toBe(3)
    const rows = app.deps.db.all<{ revision: number }>('SELECT revision FROM desktop_deliveries ORDER BY revision')
    expect(rows.map((row) => Number(row.revision))).toEqual([2, 3])
  })

  it('审计 delivery.create 记录平台/内容项/动作/目标与解析人数', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const { response } = await create(
      requestOf({
        action: 'upgrade',
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 }],
        targets: { mode: 'users', userIds: [alice.id, bob.id] },
      }),
    )
    expect(response.statusCode).toBe(202)
    const audit = auditEntries('delivery.create')
    expect(audit).toHaveLength(1)
    const detail = audit[0]!.detail!
    expect(detail.platforms).toEqual(['instance', 'desktop'])
    expect(detail.action).toBe('upgrade')
    expect(detail.targets).toMatchObject({ mode: 'users', count: 2, truncated: false })
    expect(detail.items).toEqual([
      {
        kind: 'plugin',
        pluginId: alpha.pluginId,
        packageName: ALPHA,
        versionId: alpha.v2,
        version: '0.2.0',
        // WP32a：桌面侧用的是桌面版本（审计里要能区分开了哪一边的版本）
        desktopVersionId: alpha.d2,
        desktopVersion: '0.2.0',
      },
    ])
    expect(detail.instance).toMatchObject({ users: { count: 2, truncated: false } })
    expect(detail.desktop).toMatchObject({ devices: 3, users: { count: 2 } })
    expect(detail.outcome).toBe('ok')
  })

  it('桌面侧事务失败：整个桌面侧回滚、不创建 revision；实例侧 job 保留且错误说明哪边失败', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    seedModelPreset()
    // 让桌面侧在写发布日志时失败（它的计数器表被拿掉）：实例侧 job 已建、桌面侧写过的东西必须全部回滚
    app.deps.db.exec('DROP TABLE desktop_delivery_counter')
    const { response, body } = await create(
      requestOf({
        items: [
          { kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 },
          { kind: 'models' },
        ],
        targets: { mode: 'users', userIds: [alice.id] },
      }),
    )
    expect(response.statusCode).toBe(500)
    const error = body.error as { code: string; message: string; details?: Record<string, unknown> }
    expect(error.message).toContain('桌面侧下发失败')
    expect(error.details?.instanceJobs).toHaveLength(2)
    const pluginTargets = app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_plugin_targets')
    expect(Number(pluginTargets?.n ?? 0)).toBe(0)
    const deliveries = app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_deliveries')
    expect(Number(deliveries?.n ?? 0)).toBe(0)
    const jobs = app.deps.db.all<{ id: number }>('SELECT id FROM jobs')
    expect(jobs).toHaveLength(2) // 插件 + models 两个内容项各一个实例任务
    // 审计里留下失败原因（下发给管理员看的那条）
    expect(auditEntries('delivery.create').some((entry) => entry.detail?.outcome === 'desktop-failed')).toBe(true)
  })

  it('role 目标：桌面按角色下发，发布日志的 scope = role', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const { response, body } = await create(
      requestOf({
        platforms: ['desktop'],
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v2 }],
        targets: { mode: 'role', role: 'user' },
      }),
    )
    expect(response.statusCode, response.body).toBe(202)
    const row = app.deps.db.get<{ scope: string; role: string; user_id: number | null }>(
      'SELECT scope, role, user_id FROM desktop_deliveries ORDER BY revision DESC LIMIT 1',
    )
    expect(row).toMatchObject({ scope: 'role', role: 'user', user_id: null })
    const target = app.deps.db.get<{ scope: string; role: string; version_id: number }>(
      'SELECT scope, role, version_id FROM desktop_plugin_targets',
    )
    expect(target).toMatchObject({ scope: 'role', role: 'user', version_id: alpha.d2 })
    expect((body.desktop as { users: number }).users).toBe(2)
  })

  it('users 目标 > 500 被契约拒绝（400）', async () => {
    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const ids = Array.from({ length: 501 }, (_value, index) => index + 1)
    const { response } = await create(
      requestOf({
        items: [{ kind: 'plugin', pluginId: alpha.pluginId, versionId: alpha.v1 }],
        targets: { mode: 'users', userIds: ids },
      }),
    )
    expect(response.statusCode).toBe(400)
  })
})

describe('统一下发 · 安装统计（交付物 4）', () => {
  it('每个插件的实例/桌面安装人数、其中旧的、最新版本；插件库为空时 items=[]', async () => {
    const empty = await injectAs(adminSession, { method: 'GET', url: '/api/admin/plugins/install-stats' })
    expect(empty.statusCode, empty.body).toBe(200)
    expect(json<{ items: unknown[] }>(empty).items).toEqual([])

    const alpha = seedPluginWithVersions(ALPHA, { desktopArtifact: true })
    const beta = seedPluginWithVersions(BETA, { desktopArtifact: true })
    seedInstalledPlugin(alice.id, alpha.pluginId, alpha.v1) // A 的实例装着旧版
    seedInstalledPlugin(bob.id, alpha.pluginId, alpha.v2) // B 的实例已是最新
    // 桌面：A 的 deviceA1 与 B 的 deviceB1 都上报 0.1.0（旧），deviceA2 没有这个包
    const response = await injectAs(adminSession, { method: 'GET', url: '/api/admin/plugins/install-stats' })
    expect(response.statusCode, response.body).toBe(200)
    const items = json<{
      items: {
        pluginId: number
        instance: { users: number; outdated: number }
        desktop: { devices: number; users: number; outdated: number }
        latestVersion: string | null
      }[]
    }>(response).items
    expect(items.map((item) => item.pluginId)).toEqual([alpha.pluginId, beta.pluginId])
    const alphaStat = items[0]!
    expect(alphaStat.latestVersion).toBe('0.2.0')
    expect(alphaStat.instance).toEqual({ users: 2, outdated: 1 })
    expect(alphaStat.desktop).toEqual({ devices: 2, users: 2, outdated: 2, bundledDevices: 0 })
    const betaStat = items[1]!
    expect(betaStat.latestVersion).toBe('0.2.0')
    expect(betaStat.instance).toEqual({ users: 0, outdated: 0 })
    expect(betaStat.desktop).toEqual({ devices: 0, users: 0, outdated: 0, bundledDevices: 0 })

    // 设备更新到最新版后 outdated 归零（再上报会撞上报限流，直接改库模拟下一次心跳）
    app.deps.db.run(
      "UPDATE desktop_device_plugins SET version = '0.2.0' WHERE device_id = ? AND package_name = ?",
      deviceA1,
      ALPHA,
    )
    const updated = json<{ items: { pluginId: number; desktop: { outdated: number } }[] }>(
      await injectAs(adminSession, { method: 'GET', url: '/api/admin/plugins/install-stats' }),
    )
    expect(updated.items[0]!.desktop.outdated).toBe(1)

    // 非管理员 → 403
    const forbidden = await injectAs(aliceSession, { method: 'GET', url: '/api/admin/plugins/install-stats' })
    expect(forbidden.statusCode).toBe(403)
  })
})
