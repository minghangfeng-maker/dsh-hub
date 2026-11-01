import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
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
import { FALLBACK_DSH_VERSION, imageForVersion } from '../src/modules/instances/spec.js'

/**
 * WP56f 第四批：桌面端下发/发布、实例重建、对话模式下发、设备详情。
 *
 * 这些都是「会改别人机器上的东西」的写操作：全部走 preview（含影响面）→ 批准 → 执行 → 审计。
 */

let h: CockpitHarness
let alice: TestUser

beforeEach(async () => {
  h = await createCockpitHarness()
  alice = await createUser(h.app, { username: 'alice', displayName: '爱丽丝' })
})

afterEach(async () => {
  await h.close()
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

function expectCockpitAudits(mark: number): void {
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
}

async function expectWrite(
  capability: string,
  args: unknown,
  opts: { check?: (settled: ProposalView) => void | Promise<void> } = {},
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
  expect(settled.status, `${capability} 执行结果：${JSON.stringify(settled.outcome)}`).toBe('succeeded')
  expectCockpitAudits(mark)
  await opts.check?.(settled)
  return settled
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

function seedDesktopPlugin(): { pluginId: number; versionId: number } {
  const pluginId = Number(
    db().run(
      `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                            is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
       VALUES ('@local/wp56f-desktop', '桌面夹具插件', '', NULL, NULL, 'optional', 0, 20, '', 0, ?, ?)`,
      now(),
      now(),
    ).lastInsertRowid,
  )
  db().run(
    `INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, 'desktop', 'optional', 20, '', 0, ?, ?)`,
    pluginId,
    now(),
    now(),
  )
  const versionId = Number(
    db().run(
      `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file,
                                    sha256, min_dsh, created_at)
       VALUES (?, 'desktop', '0.1.0', 'upload', '@local/wp56f-desktop', '{}', 'x.tgz', NULL, NULL, ?)`,
      pluginId,
      now(),
    ).lastInsertRowid,
  )
  // 桌面版本必须有整包（`desktop_plugin_artifacts`），否则下发会被拒
  db().run(
    `INSERT INTO desktop_plugin_artifacts (version_id, plugin_id, file_name, bytes, sha256, uploaded_by, uploaded_at)
     VALUES (?, ?, 'wp56f-desktop-0.1.0.tgz', 1024, ?, NULL, ?)`,
    versionId,
    pluginId,
    'a'.repeat(64),
    now(),
  )
  return { pluginId, versionId }
}

function seedRelease(target: string, channel: string, version: string): void {
  db().run(
    `INSERT INTO desktop_releases
       (target, channel, version, installer_file, installer_bytes, installer_sha512, blockmap_file,
        blockmap_bytes, blockmap_sha512, feed_file, yaml, status, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, 'setup.exe', 1, 'sha', NULL, NULL, NULL, 'latest.yml', 'version: 1', 'published', NULL, ?)`,
    target,
    channel,
    version,
    now(),
  )
}

function seedDevice(): string {
  const deviceId = `dv_${randomBytes(16).toString('hex')}`
  db().run(
    `INSERT INTO desktop_devices
       (device_id, user_id, name, platform, os_major, arch, app_version, apply_state,
        first_seen_at, last_report_at, created_at, updated_at, kind)
     VALUES (?, ?, '办公室电脑', 'win32', '11', 'x64', '0.4.0', 'unknown', ?, ?, ?, ?, 'desktop')`,
    deviceId,
    alice.id,
    now(),
    now(),
    now(),
    now(),
  )
  return deviceId
}

// ── 桌面端下发 ──────────────────────────────────────────────────────────────

describe('桌面端下发：配置 / 插件 / 卸载 / 版本策略 / 回滚', () => {
  it('desktop.config.set：替换配置片段集合', async () => {
    await expectWrite(
      'desktop.config.set',
      { target: { scope: 'all' }, fragments: [] },
      {
        check: (settled) => {
          const result = settled.outcome?.[0]?.result as { revision: number; affectedDevices: number }
          expect(result.revision).toBeGreaterThan(0)
          expect(result.affectedDevices).toBeGreaterThanOrEqual(0)
        },
      },
    )
  })

  it('desktop.plugins.set：给桌面端下发插件 → withdraw 撤掉', async () => {
    const { pluginId, versionId } = seedDesktopPlugin()
    await expectWrite(
      'desktop.plugins.set',
      { target: { scope: 'all' }, pluginId, versionId },
      {
        check: (settled) => {
          const result = settled.outcome?.[0]?.result as { revision: number }
          expect(result.revision).toBeGreaterThan(0)
          const row = db().get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM desktop_plugin_targets WHERE plugin_id = ? AND scope = 'all'",
            pluginId,
          )
          expect(row?.n).toBe(1)
        },
      },
    )
    await expectWrite(
      'desktop.plugins.withdraw',
      { target: { scope: 'all' }, pluginId },
      {
        check: () => {
          const row = db().get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM desktop_plugin_targets WHERE plugin_id = ? AND scope = 'all'",
            pluginId,
          )
          expect(row?.n).toBe(0)
        },
      },
    )
  })

  it('desktop.app.set：设置渠道版本策略（含硬地板警告）', async () => {
    const proposal = await callProposal('desktop.app.set', {
      channel: 'latest',
      targetVersion: '0.4.1',
      minVersion: '0.4.0',
      minVersionHard: true,
      rolloutPercent: 50,
    })
    expect(proposal.steps[0]?.preview.warnings?.join(' ')).toContain('硬地板')
    await expectWrite('desktop.app.set', {
      channel: 'latest',
      targetVersion: '0.4.1',
      minVersion: '0.4.0',
      minVersionHard: true,
      rolloutPercent: 50,
    })
  })

  it('desktop.uninstall：加卸载包名（R3 要密码）', async () => {
    await expectWrite('desktop.uninstall', { target: { scope: 'all' }, add: ['@local/wp56f-desktop'] })
  })

  it('desktop.releases.rollback：发布回退到上一个版本', async () => {
    seedRelease('win-x64', 'latest', '0.4.0')
    seedRelease('win-x64', 'latest', '0.4.1')
    await expectWrite(
      'desktop.releases.rollback',
      { target: 'win-x64', channel: 'latest' },
      {
        check: () => {
          const rows = db().all<{ version: string; status: string }>(
            "SELECT version, status FROM desktop_releases WHERE target = 'win-x64' AND channel = 'latest' ORDER BY version",
          )
          // 新版本被撤下（yanked），旧版本回到 published
          expect(rows.find((row) => row.version === '0.4.1')?.status).toBe('yanked')
          expect(rows.find((row) => row.version === '0.4.0')?.status).toBe('published')
        },
      },
    )
  })

  it('desktop.devices.get：设备详情（R0）', async () => {
    const deviceId = seedDevice()
    const data = await callData<{
      device: { deviceId: string; name: string }
      user: { username: string }
      rows: unknown[]
    }>('desktop.devices.get', { deviceId })
    expect(data.device).toMatchObject({ deviceId, name: '办公室电脑' })
    expect(data.user.username).toBe('alice')
    expect(Array.isArray(data.rows)).toBe(true)
  })
})

// ── 实例重建 ────────────────────────────────────────────────────────────────

describe('实例重建', () => {
  it('instances.recreate：重建后实例仍在运行', async () => {
    expect(alice.id).toBeGreaterThan(0)
    h.ctx.driver!.addImage(imageForVersion(FALLBACK_DSH_VERSION))
    await h.app.deps.services.instances.ensureRunning(alice.id)
    await expectWrite(
      'instances.recreate',
      { userId: alice.id },
      {
        check: () => {
          const row = db().get<{ status: string }>('SELECT status FROM instances WHERE user_id = ?', alice.id)
          expect(row?.status).toBe('running')
        },
      },
    )
  })
})

// ── 对话模式下发 ────────────────────────────────────────────────────────────

describe('对话模式下发', () => {
  it('agent-modes.deliver：给开放范围内的用户建下发任务（R3 要密码）', async () => {
    // 先开放给 alice（否则没有下发目标）
    await h.app.deps.services.agentModes.update(
      'claude-code',
      { enabled: true, targets: { userIds: [alice.id] } },
      1,
      { ip: null, userAgent: 'vitest' },
    )
    const proposal = await callProposal('agent-modes.deliver', {
      mode: 'claude-code',
      restart: 'next-start',
      installPlugin: false,
    })
    const preview = proposal.steps[0]?.preview
    expect(preview?.summary).toContain('Claude Code')
    expect(preview?.warnings?.join(' ')).toContain('密码')
    await expectWrite(
      'agent-modes.deliver',
      {
        mode: 'claude-code',
        restart: 'next-start',
        installPlugin: false,
      },
      {
        check: (settled) => {
          const result = settled.outcome?.[0]?.result as { jobId: number }
          expect(result.jobId).toBeGreaterThan(0)
          const job = db().get<{ type: string }>('SELECT type FROM jobs WHERE id = ?', result.jobId)
          expect(job?.type).toBe('rollout.agent-mode')
        },
      },
    )
  })
})
