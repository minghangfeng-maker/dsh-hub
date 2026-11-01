import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OpsCallResult, ProposalView } from '@dsh-hub/shared'
import { createUser, type TestUser } from './helpers.js'
import {
  adminInject,
  createCockpitHarness,
  jsonOf,
  opsInject,
  reauth,
  waitProposalSettled,
  type CockpitHarness,
} from './helpers-cockpit.js'
import { startFakeNpmRegistry, type FakeServer } from './helpers-wp3.js'
import { jsonResponse, startFakeUpstream, type FakeUpstream } from './helpers-relay.js'

/**
 * WP56f 第二批：DSH 版本 / 插件库 / 模型配置 / 全局设置 / 安卓回滚。
 *
 * 假上游：`startFakeNpmRegistry`（npm 元数据 + tgz）、`startFakeUpstream`（`GET /models`）。
 */

const PLUGIN = '@local/wp56f-plugin'
const DSH_VERSION = '0.4.0'

let h: CockpitHarness
let alice: TestUser
let registry: FakeServer
let upstream: FakeUpstream | undefined

beforeEach(async () => {
  registry = await startFakeNpmRegistry({
    '@deepseek-ai/dsh': {
      versions: {
        '0.3.0': { name: '@deepseek-ai/dsh', version: '0.3.0' },
        [DSH_VERSION]: { name: '@deepseek-ai/dsh', version: DSH_VERSION },
      },
      distTags: { latest: DSH_VERSION, next: '0.4.1-rc.1' },
    },
    [PLUGIN]: {
      versions: {
        '0.1.0': { name: PLUGIN, version: '0.1.0' },
        '0.2.0': { name: PLUGIN, version: '0.2.0' },
      },
      distTags: { latest: '0.2.0' },
    },
  })
  h = await createCockpitHarness({ env: { HUB_NPM_REGISTRY: registry.url } })
  // 普通用户（本文件的能力都不针对某个用户，建一个只是为了夹具完整/后续扩展）
  alice = await createUser(h.app, { username: 'alice', displayName: '爱丽丝' })
  expect(alice.id).toBeGreaterThan(0)
})

afterEach(async () => {
  await h.close()
  await registry.close()
  await upstream?.close()
  upstream = undefined
})

const db = () => h.app.deps.db
const now = (): string => h.ctx.clock.nowIso()

async function callData<T = Record<string, unknown>>(capability: string, args: unknown = {}): Promise<T> {
  const res = await opsInject(h, 'POST', '/call', { payload: { sessionId: 's1', capability, args } })
  expect(res.statusCode, `${capability}: ${res.body}`).toBe(200)
  const result = jsonOf<OpsCallResult>(res)
  if (result.kind !== 'data') throw new Error(`${capability} 应该是 R0 数据，实际 ${result.kind}`)
  return result.data as T
}

async function callProposal(capability: string, args: unknown): Promise<ProposalView> {
  const res = await opsInject(h, 'POST', '/call', {
    payload: { sessionId: 's1', capability, args, title: `测试 ${capability}`, rationale: 'WP56f 测试' },
  })
  expect(res.statusCode, `${capability}: ${res.body}`).toBe(200)
  const result = jsonOf<OpsCallResult>(res)
  if (result.kind !== 'proposal') throw new Error(`${capability} 应该出方案，实际 ${result.kind}`)
  return result.proposal
}

function lastAuditId(): number {
  return db().get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs')?.id ?? 0
}

function expectCockpitAudits(mark: number, proposalId: number): void {
  const rows = db().all<{ action: string; detail_json: string | null }>(
    'SELECT action, detail_json FROM audit_logs WHERE id > ? ORDER BY id',
    mark,
  )
  const parsed = rows.map((row) => ({
    action: row.action,
    detail: JSON.parse(row.detail_json ?? '{}') as Record<string, unknown>,
  }))
  expect(parsed.find((row) => row.action === 'cockpit.proposal-approve')?.detail['via']).toBe('cockpit')
  for (const row of parsed.filter((item) => !item.action.startsWith('cockpit.'))) {
    expect(row.detail['via'], `${row.action} 缺 via`).toBe('cockpit')
  }
  expect(proposalId).toBeGreaterThan(0)
}

async function expectWrite(
  capability: string,
  args: unknown,
  opts: {
    check?: (settled: ProposalView) => void | Promise<void>
    expectStatus?: 'succeeded' | 'failed'
  } = {},
): Promise<ProposalView> {
  const proposal = await callProposal(capability, args)
  expect(proposal.steps[0]?.preview.summary.length ?? 0, `${capability} 缺 preview.summary`).toBeGreaterThan(
    4,
  )
  if (proposal.risk === 'R3') await reauth(h)
  const mark = lastAuditId()
  const approved = await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)
  expect(approved.statusCode, `${capability} 批准失败：${approved.body}`).toBe(200)
  const settled = await waitProposalSettled(h, proposal.id)
  expect(settled.status, `${capability} 执行结果：${JSON.stringify(settled.outcome)}`).toBe(
    opts.expectStatus ?? 'succeeded',
  )
  expectCockpitAudits(mark, proposal.id)
  await opts.check?.(settled)
  return settled
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

function seedRuntime(version = '0.3.0', status = 'ready'): number {
  return Number(
    db().run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, size_bytes, notes, created_at)
       VALUES (?, ?, ?, 0, 100, '', ?)`,
      version,
      `dshhub/runtime:${version}`,
      status,
      now(),
    ).lastInsertRowid,
  )
}

function seedPlugin(packageName = PLUGIN, policy = 'optional'): number {
  const pluginId = Number(
    db().run(
      `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                            is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
       VALUES (?, '夹具插件', '', NULL, NULL, ?, 0, 20, '', 0, ?, ?)`,
      packageName,
      policy,
      now(),
      now(),
    ).lastInsertRowid,
  )
  // 插件出现在某个平台的库里 ⇔ 有该平台的行（`requirePlatformRow` 会校验）
  db().run(
    `INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, 'cloud', ?, 20, '', 0, ?, ?)`,
    pluginId,
    policy,
    now(),
    now(),
  )
  return pluginId
}

function seedPluginVersion(pluginId: number, version = '0.1.0'): number {
  return Number(
    db().run(
      `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file,
                                    sha256, min_dsh, created_at)
       VALUES (?, 'cloud', ?, 'npm', ?, '{}', NULL, NULL, NULL, ?)`,
      pluginId,
      version,
      PLUGIN,
      now(),
    ).lastInsertRowid,
  )
}

function seedProvider(routeKey = 'fixture-provider'): number {
  return Number(
    db().run(
      `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                    extra_json, key_mode, api_key_enc, enabled, created_at, updated_at)
       VALUES (?, '夹具提供方', 'pi-ai', 'openai-completions', 'https://upstream.test/v1', ?, NULL, NULL, 'none', NULL, 1, ?, ?)`,
      routeKey,
      JSON.stringify([{ id: 'fixture-model', name: 'Fixture', contextWindow: 128000, maxTokens: 8192 }]),
      now(),
      now(),
    ).lastInsertRowid,
  )
}

// ── DSH 版本 ────────────────────────────────────────────────────────────────

describe('DSH 版本页', () => {
  it('runtimes.available：拿到最新版与全部版本（假 npm 源）', async () => {
    const data = await callData<{
      latest: string | null
      next: string | null
      rows: { dshVersion: string }[]
    }>('runtimes.available')
    expect(data.latest).toBe(DSH_VERSION)
    expect(data.next).toBe('0.4.1-rc.1')
    expect(data.rows.map((row) => row.dshVersion)).toContain('0.3.0')
  })

  it('runtimes.create：建出版本行并启动构建任务', async () => {
    await expectWrite(
      'runtimes.create',
      { dshVersion: DSH_VERSION },
      {
        check: (settled) => {
          const result = settled.outcome?.[0]?.result as { runtime?: { id: number }; jobId?: number }
          expect(result.runtime?.id).toBeGreaterThan(0)
          expect(result.jobId).toBeGreaterThan(0)
          expect(
            db().get<{ n: number }>('SELECT COUNT(*) AS n FROM runtimes WHERE dsh_version = ?', DSH_VERSION)
              ?.n,
          ).toBe(1)
        },
      },
    )
  })

  it('runtimes.set-default / retire / update / delete：四个状态操作', async () => {
    const runtimeId = seedRuntime('0.3.0')
    // 先有另一个默认版本：默认版本不能下线、也不能删
    const otherId = seedRuntime('0.2.0')
    db().run('UPDATE runtimes SET is_default = 1 WHERE id = ?', otherId)
    await expectWrite(
      'runtimes.set-default',
      { runtimeId },
      {
        check: () => {
          expect(
            db().get<{ is_default: number }>('SELECT is_default FROM runtimes WHERE id = ?', runtimeId)
              ?.is_default,
          ).toBe(1)
        },
      },
    )
    // 把默认还给另一个版本，0.3.0 才能下线
    await expectWrite('runtimes.set-default', { runtimeId: otherId })
    await expectWrite(
      'runtimes.update',
      { runtimeId, notes: '这个版本留着排障' },
      {
        check: () => {
          expect(
            db().get<{ notes: string }>('SELECT notes FROM runtimes WHERE id = ?', runtimeId)?.notes,
          ).toBe('这个版本留着排障')
        },
      },
    )
    await expectWrite(
      'runtimes.retire',
      { runtimeId },
      {
        check: () => {
          expect(
            db().get<{ status: string }>('SELECT status FROM runtimes WHERE id = ?', runtimeId)?.status,
          ).toBe('retired')
        },
      },
    )
    await expectWrite(
      'runtimes.delete',
      { runtimeId },
      {
        check: () => {
          expect(db().get<{ id: number }>('SELECT id FROM runtimes WHERE id = ?', runtimeId)).toBeUndefined()
        },
      },
    )
  })
})

// ── 插件库 ──────────────────────────────────────────────────────────────────

describe('插件库剩下的操作', () => {
  it('plugins.create：上架元数据', async () => {
    await expectWrite(
      'plugins.create',
      {
        packageName: PLUGIN,
        displayName: '夹具插件',
        policy: 'optional',
        isBundle: false,
      },
      {
        check: () => {
          expect(
            db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plugins WHERE package_name = ?', PLUGIN)?.n,
          ).toBe(1)
        },
      },
    )
  })

  it('plugins.update：改显示名与配置片段', async () => {
    const pluginId = seedPlugin()
    await expectWrite(
      'plugins.update',
      { pluginId, patch: { displayName: '新名字' } },
      {
        check: () => {
          expect(
            db().get<{ display_name: string }>('SELECT display_name FROM plugins WHERE id = ?', pluginId)
              ?.display_name,
          ).toBe('新名字')
        },
      },
    )
  })

  it('plugins.delete：从库里删掉', async () => {
    const pluginId = seedPlugin()
    await expectWrite(
      'plugins.delete',
      { pluginId },
      {
        check: () => {
          expect(db().get<{ id: number }>('SELECT id FROM plugins WHERE id = ?', pluginId)).toBeUndefined()
        },
      },
    )
  })

  it('plugins.versions.add（npm 源）：版本真的入库', async () => {
    const pluginId = seedPlugin()
    await expectWrite(
      'plugins.versions.add',
      { pluginId, source: 'npm', version: '0.2.0' },
      {
        check: () => {
          const row = db().get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM plugin_versions WHERE plugin_id = ? AND version = '0.2.0'",
            pluginId,
          )
          expect(row?.n).toBe(1)
        },
      },
    )
  })

  it('plugins.versions.remove：版本被删', async () => {
    const pluginId = seedPlugin()
    const versionId = seedPluginVersion(pluginId)
    await expectWrite(
      'plugins.versions.remove',
      { pluginId, versionId },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM plugin_versions WHERE id = ?', versionId),
          ).toBeUndefined()
        },
      },
    )
  })

  it('plugins.platforms.add / remove：云上 ↔ 桌面', async () => {
    const pluginId = seedPlugin()
    await expectWrite(
      'plugins.platforms.add',
      { pluginId, platform: 'desktop' },
      {
        check: () => {
          expect(
            db().get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM plugin_platforms WHERE plugin_id = ? AND platform = 'desktop'",
              pluginId,
            )?.n,
          ).toBe(1)
        },
      },
    )
    await expectWrite(
      'plugins.platforms.remove',
      { pluginId, platform: 'desktop', force: true },
      {
        check: () => {
          expect(
            db().get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM plugin_platforms WHERE plugin_id = ? AND platform = 'desktop'",
              pluginId,
            )?.n,
          ).toBe(0)
        },
      },
    )
  })

  it('plugins.lookup：从 npm 拿到版本列表（不入库）', async () => {
    const data = await callData<{
      plugin: { packageName: string; versions: string[]; latest: string | null }
    }>('plugins.lookup', { source: 'npm', name: PLUGIN })
    expect(data.plugin.packageName).toBe(PLUGIN)
    expect(data.plugin.versions).toContain('0.2.0')
    expect(data.plugin.latest).toBe('0.2.0')
    expect(
      db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plugins WHERE package_name = ?', PLUGIN)?.n,
    ).toBe(0)
  })

  it('plugins.users / plugins.install-stats：矩阵与统计的形状', async () => {
    const pluginId = seedPlugin()
    const users = await callData<{ rows: unknown[] }>('plugins.users', { pluginId })
    expect(Array.isArray(users.rows)).toBe(true)
    const stats = await callData<{ rows: unknown[] }>('plugins.install-stats')
    expect(Array.isArray(stats.rows)).toBe(true)
  })
})

// ── 模型：提供方 / 预设 / 发现模型 ──────────────────────────────────────────

describe('模型配置页', () => {
  it('models.providers.upsert：新建 → 修改（旧值 → 新值）', async () => {
    await expectWrite(
      'models.providers.upsert',
      {
        routeKey: 'fixture-upsert',
        displayName: '夹具',
        kind: 'pi-ai',
        api: 'openai-completions',
        baseUrl: 'https://upstream.test/v1',
        keyMode: 'none',
        models: [{ id: 'm1', name: 'M1' }],
      },
      {
        check: () => {
          const row = db().get<{ id: number }>(
            "SELECT id FROM model_providers WHERE route_key = 'fixture-upsert'",
          )
          expect(row?.id).toBeGreaterThan(0)
        },
      },
    )
    const providerId = db().get<{ id: number }>(
      "SELECT id FROM model_providers WHERE route_key = 'fixture-upsert'",
    )!.id
    const proposal = await callProposal('models.providers.upsert', { providerId, displayName: '夹具二世' })
    expect(proposal.steps[0]?.preview.summary).toContain('→')
    await reauth(h)
    expect((await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)).statusCode).toBe(200)
    await waitProposalSettled(h, proposal.id)
    expect(
      db().get<{ display_name: string }>('SELECT display_name FROM model_providers WHERE id = ?', providerId)
        ?.display_name,
    ).toBe('夹具二世')
  })

  it('models.providers.delete：删掉提供方（R3 要密码）', async () => {
    const providerId = seedProvider()
    await expectWrite(
      'models.providers.delete',
      { providerId },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM model_providers WHERE id = ?', providerId),
          ).toBeUndefined()
        },
      },
    )
  })

  it('models.presets.upsert / delete：预设的建与删', async () => {
    const providerId = seedProvider()
    await expectWrite(
      'models.presets.upsert',
      {
        name: '夹具预设',
        providerIds: [providerId],
        defaultProvider: 'fixture-provider',
        defaultModel: 'fixture-model',
        isDefault: false,
      },
      {
        check: () => {
          expect(
            db().get<{ n: number }>("SELECT COUNT(*) AS n FROM model_presets WHERE name = '夹具预设'")?.n,
          ).toBe(1)
        },
      },
    )
    const presetId = db().get<{ id: number }>("SELECT id FROM model_presets WHERE name = '夹具预设'")!.id
    // 库里唯一的预设会被服务端当成默认预设（默认预设不能删）：先摘掉默认标记
    db().run('UPDATE model_presets SET is_default = 0 WHERE id = ?', presetId)
    await expectWrite(
      'models.presets.delete',
      { presetId },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM model_presets WHERE id = ?', presetId),
          ).toBeUndefined()
        },
      },
    )
  })

  it('models.discover：从上游 /models 拿到模型并与信息库匹配（R0）', async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        jsonResponse(res, 200, { data: [{ id: 'deepseek-v4.1-flash' }, { id: 'unknown-model' }] })
        return
      }
      jsonResponse(res, 404, { error: 'not found' })
    })
    const data = await callData<{
      total: number
      rows: { modelId: string; matchedId: string | null; contextWindow: number | null }[]
    }>('models.discover', {
      api: 'openai-completions',
      baseUrl: upstream.url,
    })
    expect(data.total).toBe(2)
    expect(data.rows.map((row) => row.modelId)).toContain('deepseek-v4.1-flash')
    // 命中模型信息库的会带出匹配 id
    expect(data.rows.find((row) => row.modelId === 'deepseek-v4.1-flash')?.matchedId).toBeTruthy()
  })
})

// ── 全局设置 / 算力 / DeepSeek / 安卓回滚 ──────────────────────────────────

describe('设置类：按组改 + 其它域的设置', () => {
  it('settings.update：改站点组（旧值 → 新值，R3 要密码）', async () => {
    const proposal = await callProposal('settings.update', {
      group: 'site',
      values: { name: 'DSH Hub', tagline: '新的标语', announcement: '', announcementLevel: 'info' },
    })
    expect(proposal.steps[0]?.preview.summary).toContain('站点信息')
    expect(proposal.risk).toBe('R3')
    await reauth(h)
    const mark = lastAuditId()
    const approved = await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)
    expect(approved.statusCode, approved.body).toBe(200)
    const settled = await waitProposalSettled(h, proposal.id)
    expect(settled.status).toBe('succeeded')
    expectCockpitAudits(mark, proposal.id)
    const settings = await h.app.deps.services.system.getSettings()
    expect(settings.site.tagline).toBe('新的标语')
  })

  it('settings.update：分组白名单外的组名会被拒', async () => {
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'settings.update',
        args: { group: 'relay', values: {} },
        title: '改中转站设置',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('compute.settings.update：改 billing 组（R3）', async () => {
    await expectWrite(
      'compute.settings.update',
      {
        group: 'billing',
        values: { billingEnabled: true, billAdmins: false, graceMinutes: 5 },
      },
      {
        check: () => {
          expect(h.app.deps.services.compute.getSettings()).toMatchObject({
            billingEnabled: true,
            graceMinutes: 5,
          })
        },
      },
    )
  })

  it('mobile.app.rollback：回到上一条发布', async () => {
    const insert = (versionName: string, versionCode: number, status: string): void => {
      db().run(
        `INSERT INTO mobile_app_releases (version_name, version_code, file_name, bytes, sha256, status, uploaded_at)
         VALUES (?, ?, ?, 100, ?, ?, ?)`,
        versionName,
        versionCode,
        `dsh-hub-${versionName}.apk`,
        'a'.repeat(64),
        status,
        now(),
      )
    }
    insert('0.4.1', 41, 'yanked')
    insert('0.4.2', 42, 'published')
    await expectWrite(
      'mobile.app.rollback',
      {},
      {
        check: () => {
          expect(h.app.deps.services.mobileApp.current()?.versionName).toBe('0.4.1')
        },
      },
    )
  })
})
