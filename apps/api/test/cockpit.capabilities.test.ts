import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { COCKPIT_REDACTION_PLACEHOLDER, type OpsCallResult, type ProposalView } from '@dsh-hub/shared'
import { createUser, type TestApp, type TestUser } from './helpers.js'
import { FALLBACK_DSH_VERSION, imageForVersion } from '../src/modules/instances/spec.js'
import {
  adminInject,
  createCockpitHarness,
  jsonOf,
  opsInject,
  reauth,
  waitProposalSettled,
  type CockpitHarness,
} from './helpers-cockpit.js'
import { createChannel, createRelayModel, systemKey } from './helpers-relay.js'

/**
 * WP56e1：补齐 docs/24 §4 里**未标 ★** 的能力（R0 / R1 / R2 / R3 共 25 个）。
 *
 * 每个能力至少一条用例，覆盖任务书要求的三件事：
 * - R0：返回形状（`{rows}`）+ 脱敏（不泄漏夹具里的凭据）；
 * - 写类：影响面由 Hub 算（`preview` 有 summary）+ 批准后真的执行 + 审计带 `detail.via='cockpit'`；
 * - R3：批准要 reauth（无 reauth → 409 REAUTH_REQUIRED）。
 *
 * 全部走真路由（`/ops/*` 在独立监听器实例上 inject、管理端走主 app），不 mock service。
 */

let h: CockpitHarness
let alice: TestUser
let bob: TestUser

beforeEach(async () => {
  h = await createCockpitHarness()
  alice = await createUser(h.app, { username: 'alice', displayName: '爱丽丝' })
  bob = await createUser(h.app, { username: 'bob', displayName: '鲍勃' })
})

afterEach(async () => {
  await h.close()
})

const app = (): TestApp => h.ctx
const db = () => h.app.deps.db
const now = (): string => h.ctx.clock.nowIso()

/** `/ops/call` 的 data 分支（R0） */
async function callData<T = Record<string, unknown>>(capability: string, args: unknown = {}): Promise<T> {
  const res = await opsInject(h, 'POST', '/call', { payload: { sessionId: 's1', capability, args } })
  expect(res.statusCode, `${capability}: ${res.body}`).toBe(200)
  const result = jsonOf<OpsCallResult>(res)
  if (result.kind !== 'data') throw new Error(`${capability} 应该是 R0 数据，实际 ${result.kind}`)
  return result.data as T
}

/** `/ops/call` 的 proposal 分支（写类） */
async function callProposal(capability: string, args: unknown, title = '测试方案'): Promise<ProposalView> {
  const res = await opsInject(h, 'POST', '/call', {
    payload: { sessionId: 's1', capability, args, title, rationale: 'WP56e1 测试' },
  })
  expect(res.statusCode, `${capability}: ${res.body}`).toBe(200)
  const result = jsonOf<OpsCallResult>(res)
  if (result.kind !== 'proposal') throw new Error(`${capability} 应该出方案，实际 ${result.kind}`)
  return result.proposal
}

/** 批准 + 等它跑完；默认断言成功 */
async function approve(
  proposal: ProposalView,
  opts: { reauth?: boolean; expectStatus?: 'succeeded' | 'failed' } = {},
): Promise<ProposalView> {
  if (opts.reauth === true) await reauth(h)
  const res = await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)
  expect(res.statusCode, res.body).toBe(200)
  const settled = await waitProposalSettled(h, proposal.id)
  expect(settled.status, JSON.stringify(settled.outcome)).toBe(opts.expectStatus ?? 'succeeded')
  return settled
}

interface AuditRow {
  id: number
  actor_id: number | null
  action: string
  target_type: string | null
  target_id: string | null
  detail_json: string | null
}

function auditsAfter(id: number): AuditRow[] {
  return db().all<AuditRow>('SELECT * FROM audit_logs WHERE id > ? ORDER BY id', id)
}

function lastAuditId(): number {
  return db().get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs')?.id ?? 0
}

/**
 * I2 的通用断言：批准一条 R2/R3 方案后，
 * ① 批准者的审计带 `via=cockpit` + `proposalId`；② 能力自身的审计也带（不是只有座舱那一条）。
 */
function expectCockpitAudits(mark: number, proposalId: number): void {
  const rows = auditsAfter(mark)
  const parsed = rows.map((row) => ({
    action: row.action,
    detail: JSON.parse(row.detail_json ?? '{}') as Record<string, unknown>,
  }))
  const approve = parsed.find((row) => row.action === 'cockpit.proposal-approve')
  expect(approve, '缺少 cockpit.proposal-approve 审计').toBeTruthy()
  expect(approve?.detail['via']).toBe('cockpit')
  expect(approve?.detail['proposalId']).toBe(proposalId)
  // 能力自己写的审计（rollout.create / relay.channel.create / …）也必须带上标注
  const inner = parsed.filter((row) => !row.action.startsWith('cockpit.'))
  for (const row of inner) expect(row.detail['via'], `${row.action} 缺 via`).toBe('cockpit')
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

function seedRuntime(version = '0.2.1-rc.2', isDefault = false): number {
  const id = db().run(
    `INSERT INTO runtimes (dsh_version, image, status, is_default, size_bytes, notes, created_at)
     VALUES (?, ?, 'ready', ?, 123456, '', ?)`,
    version,
    `dshhub/runtime:${version}`,
    isDefault ? 1 : 0,
    now(),
  ).lastInsertRowid
  return Number(id)
}

function seedPlugin(packageName = '@local/wp56e1-plugin'): number {
  return Number(
    db().run(
      `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                            is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
       VALUES (?, '测试插件', '', NULL, NULL, 'optional', 0, 20, '', 0, ?, ?)`,
      packageName,
      now(),
      now(),
    ).lastInsertRowid,
  )
}

function seedFailedJob(): { jobId: number; taskId: number } {
  const jobId = Number(
    db().run(
      `INSERT INTO jobs (type, title, status, params_json, total, done, failed, created_at, started_at)
       VALUES ('wp56e1.fixture', '夹具任务', 'failed', '{}', 1, 0, 1, ?, ?)`,
      now(),
      now(),
    ).lastInsertRowid,
  )
  const taskId = Number(
    db().run(
      `INSERT INTO job_tasks (job_id, seq, user_id, status, attempt, error, started_at, finished_at)
       VALUES (?, 1, ?, 'failed', 1, '上游超时', ?, ?)`,
      jobId,
      alice.id,
      now(),
      now(),
    ).lastInsertRowid,
  )
  return { jobId, taskId }
}

/** 直接写一行设备（桌面 / 手机共用一张表；`device_id` 必须 `dv_` + 32 hex） */
function seedDevice(userId: number, kind: 'desktop' | 'mobile', name: string): string {
  const deviceId = `dv_${randomBytes(16).toString('hex')}`
  db().run(
    `INSERT INTO desktop_devices
       (device_id, user_id, name, platform, os_major, arch, app_version, apply_state,
        first_seen_at, last_report_at, created_at, updated_at, kind, mobile_platform)
     VALUES (?, ?, ?, ?, '11', 'x64', '0.2.1', 'unknown', ?, ?, ?, ?, ?, ?)`,
    deviceId,
    userId,
    name,
    kind === 'desktop' ? 'win32' : null,
    now(),
    now(),
    now(),
    now(),
    kind,
    kind === 'mobile' ? 'android' : null,
  )
  return deviceId
}

// ── R0：只读能力 ─────────────────────────────────────────────────────────────

describe('R0 追加能力：返回形状', () => {
  it('runtimes.list：列出版本（含默认标记）', async () => {
    const runtimeId = seedRuntime('0.2.1-rc.2', true)
    const data = await callData<{
      rows: { runtimeId: number; dshVersion: string; status: string; isDefault: boolean }[]
    }>('runtimes.list')
    expect(data.rows.map((row) => row.runtimeId)).toContain(runtimeId)
    const row = data.rows.find((item) => item.runtimeId === runtimeId)
    expect(row).toMatchObject({ dshVersion: '0.2.1-rc.2', status: 'ready', isDefault: true })
  })

  it('relay.channels.list：只给密钥的计数与末四位，不给明文', async () => {
    const channel = createChannel(h.app, {
      name: '夹具渠道',
      baseUrl: 'https://upstream.example.com',
      apis: ['openai-completions'],
      keys: ['sk-test-FAKE-channel-key-0123456789'],
    })
    const data = await callData<{
      rows: {
        channelId: number
        name: string
        active: number
        total: number
        last4: string[]
        baseUrl: string
      }[]
    }>('relay.channels.list')
    const row = data.rows.find((item) => item.channelId === channel.id)
    expect(row).toBeTruthy()
    expect(row?.active).toBe(1)
    expect(row?.last4.length).toBe(1)
    // 明文密钥一个字符都不能出现（I4）
    const body = JSON.stringify(data)
    expect(body).not.toContain('sk-test-FAKE-channel-key-0123456789')
  })

  it('agent-modes.get：返回设置 + 每个用户一行（claude-code）', async () => {
    const data = await callData<{
      mode: string
      settings: { enabled: boolean; ratePermille: number; targets: unknown }
      rows: { userId: number; username: string }[]
      warnings: string[]
    }>('agent-modes.get', { mode: 'claude-code' })
    expect(data.mode).toBe('claude-code')
    expect(data.settings.ratePermille).toBeGreaterThan(0)
    expect(Array.isArray(data.rows)).toBe(true)
    expect(Array.isArray(data.warnings)).toBe(true)
  })

  it('cockpit.board-vitals：态势板「舰况」四项（value/max、spark、tone）', async () => {
    // 一个失败任务：「失败任务」那一项必须 tone=bad
    seedFailedJob()

    const data = await callData<{
      rows: {
        label: string
        value: number | string
        unit?: string
        max?: number
        spark?: number[]
        tone?: string
      }[]
      generatedAt: string
    }>('cockpit.board-vitals')

    expect(data.rows.map((row) => row.label)).toEqual(['运行实例', '今日请求', '今日积分消耗', '失败任务'])
    const [instances, requests, credits, failed] = data.rows
    // ① 运行实例：value 是运行数；有实例总数时给 max（0 时不给，免得画一个 0 上限的仪表）
    expect(typeof instances?.value).toBe('number')
    if (instances?.max !== undefined) expect(instances.max).toBeGreaterThan(0)
    // ② 今日请求：带近 7 天 spark（每天一个点；空库上是 7 个 0）
    expect(typeof requests?.value).toBe('number')
    expect(requests?.spark).toHaveLength(7)
    // ③ 今日积分消耗：单位是「积分」，也有 spark
    expect(credits?.unit).toBe('积分')
    expect(credits?.spark).toHaveLength(7)
    // ④ 失败任务：有失败就是 bad（颜色只表达状态）
    expect(failed?.value).toBeGreaterThanOrEqual(1)
    expect(failed?.tone).toBe('bad')
    expect(typeof data.generatedAt).toBe('string')
  })

  it('cockpit.board-vitals：没有失败任务时 tone=good（同一张卡两种态）', async () => {
    const data = await callData<{ rows: { label: string; value: number; tone?: string }[] }>(
      'cockpit.board-vitals',
    )
    const failed = data.rows.find((row) => row.label === '失败任务')
    expect(failed?.value).toBe(0)
    expect(failed?.tone).toBe('good')
  })

  it('instances.list：派生字段 memoryUsedMb（画「内存 MB」柱状图不用前端换算）', async () => {
    const rows = await callData<{ rows: { memoryBytes: number | null; memoryUsedMb: number | null }[] }>(
      'instances.list',
    )
    for (const row of rows.rows) {
      if (row.memoryBytes === null || row.memoryUsedMb === null) {
        expect(row.memoryUsedMb).toBeNull()
        continue
      }
      expect(row.memoryUsedMb).toBe(Math.round(row.memoryBytes / 1024 / 1024))
    }
  })

  it('search.pools：列渠道 + 本月汇总（密钥只给末四位）', async () => {
    const channel = h.app.deps.services.relay.tools.createChannel(
      {
        kind: 'tavily',
        name: '夹具搜索',
        baseUrl: 'https://api.tavily.com',
        tools: ['search'],
        priority: 10,
        weight: 1,
        timeoutMs: 10_000,
        proxyUrl: null,
        searchCostMicro: 1_000,
        fetchCostMicro: 0,
        enabled: true,
        note: '',
        searchCost: 1_000,
        fetchCost: 0,
      } as never,
      1,
      { ip: null, userAgent: 'vitest' },
    )
    const data = await callData<{
      month: string
      totals: { calls: number }
      rows: { channelId: number; name: string; active: number; total: number }[]
    }>('search.pools')
    expect(data.month).toMatch(/^\d{4}-\d{2}$/)
    const row = data.rows.find((item) => item.channelId === channel.id)
    expect(row).toBeTruthy()
    expect(row?.total).toBe(0)
  })

  it('desktop.devices.list / mobile.devices.list：按 kind 分开列', async () => {
    const desktopId = seedDevice(alice.id, 'desktop', '办公室 Windows')
    const mobileId = seedDevice(bob.id, 'mobile', '小米 15')
    const desktops = await callData<{ total: number; rows: { deviceId: string; username: string }[] }>(
      'desktop.devices.list',
    )
    expect(desktops.rows.map((row) => row.deviceId)).toContain(desktopId)
    expect(desktops.rows.map((row) => row.deviceId)).not.toContain(mobileId)
    expect(desktops.rows.find((row) => row.deviceId === desktopId)?.username).toBe('alice')

    const mobiles = await callData<{ rows: { deviceId: string; mobilePlatform: string }[] }>(
      'mobile.devices.list',
    )
    expect(mobiles.rows.map((row) => row.deviceId)).toContain(mobileId)
    expect(mobiles.rows.map((row) => row.deviceId)).not.toContain(desktopId)
    expect(mobiles.rows.find((row) => row.deviceId === mobileId)?.mobilePlatform).toBe('android')
  })

  it('models.list kind=relay：列出中转站对外模型与价格（改价格的入口）', async () => {
    const model = await createRelayModel(h.app, {
      name: 'relay-listed',
      price: { inputMicro: 2_000_000, outputMicro: 4_000_000 },
    })
    const data = await callData<{
      rows: { modelId: number; name: string; priceCreditsPerMillion: { input: number; output: number } }[]
    }>('models.list', { kind: 'relay' })
    const row = data.rows.find((item) => item.modelId === model.id)
    expect(row?.name).toBe('relay-listed')
    // 微积分 → 积分（1 积分 = 1e6 微积分）
    expect(row?.priceCreditsPerMillion).toMatchObject({ input: 2, output: 4 })
  })

  it('instances.logs：读容器日志（系统账号被拒）', async () => {
    const data = await callData<{ rows: { userId: number; text: string }[] }>('instances.logs', {
      userId: alice.id,
      tail: 10,
    })
    expect(data.rows[0]?.userId).toBe(alice.id)
    expect(typeof data.rows[0]?.text).toBe('string')
    const denied = await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'instances.logs', args: { userId: h.hubOps.id } },
    })
    // 能力自己抛 NOT_FOUND（与 instances.get 同一口径：座舱实例不在能力里看）
    expect(denied.statusCode).toBe(404)
    expect(denied.body).toContain('顶栏')
  })

  it('invites.list：分页列邀请码', async () => {
    await h.app.deps.services.system.createInvites(
      { count: 2, maxUses: 3, note: '夹具', roleLabel: '', expiresAt: null },
      { actorId: h.admin.user.id, ip: null, userAgent: 'vitest' },
    )
    const data = await callData<{ total: number; rows: { code: string; maxUses: number }[] }>('invites.list')
    expect(data.total).toBe(2)
    expect(data.rows[0]?.maxUses).toBe(3)
  })

  it('settings.get：返回设置本体（注册/容量/座舱）', async () => {
    const data = await callData<{
      settings: {
        registration: { mode: string }
        capacity: { maxRunning: number }
        cockpit: { autoExecuteR1: boolean }
      }
    }>('settings.get')
    expect(typeof data.settings.registration.mode).toBe('string')
    expect(data.settings.capacity.maxRunning).toBeGreaterThan(0)
    expect(data.settings.cockpit.autoExecuteR1).toBe(true)
  })

  it('deliveries.preview：只读预览（不建任务、不写期望状态）', async () => {
    const before = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n ?? 0
    const data = await callData<{
      summary: { instance: { willRun: number; skipped: number; users: number } }
      rows: { username: string; itemLabel: string }[]
      warnings: string[]
    }>('deliveries.preview', {
      platforms: ['instance'],
      items: [{ kind: 'models' }],
      action: 'apply-config',
      targets: { mode: 'all' },
    })
    expect(data.summary.instance.users).toBeGreaterThanOrEqual(2)
    expect(data.rows.some((row) => row.username === 'alice')).toBe(true)
    expect(Array.isArray(data.warnings)).toBe(true)
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')?.n ?? 0).toBe(before)
  })
})

// ── R1：低风险可逆 ───────────────────────────────────────────────────────────

describe('R1 追加能力：默认自动执行', () => {
  it('jobs.retry：把失败步骤重置，审计带 policy=autoExecuteR1', async () => {
    const { jobId } = seedFailedJob()
    const mark = lastAuditId()
    const res = await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'jobs.retry', args: { jobId }, title: '重试任务' },
    })
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('done')
    const job = db().get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', jobId)
    expect(job?.status).toBe('running')
    const auto = auditsAfter(mark).find((row) => row.action === 'cockpit.auto-exec')
    expect(auto).toBeTruthy()
    expect(JSON.parse(auto?.detail_json ?? '{}')['policy']).toBe('autoExecuteR1')
    expect(auto?.actor_id).toBe(h.hubOps.id)
  })

  it('instances.probe：只写探针状态（不重启容器），返回被探测的实例', async () => {
    // 假驱动要登记同 tag 的镜像，否则 ensureRunning 报「运行时镜像尚未就绪」
    h.ctx.driver!.addImage(imageForVersion(FALLBACK_DSH_VERSION))
    await h.app.deps.services.instances.ensureRunning(alice.id)
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'instances.probe',
        args: { userId: alice.id },
        title: '刷新探针',
      },
    })
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('done')
    const data = (result as { result: { probed: number; rows: { userId: number }[] } }).result
    expect(data.probed).toBe(1)
    expect(data.rows[0]?.userId).toBe(alice.id)
  })
})

// ── R2：有影响 ───────────────────────────────────────────────────────────────

describe('R2 追加能力：出方案 → 批准执行 → 审计标 cockpit', () => {
  it('rollouts.runtime：影响面 + 真建 rollout.runtime 任务', async () => {
    const runtimeId = seedRuntime('0.3.0')
    const proposal = await callProposal(
      'rollouts.runtime',
      { runtimeId, targets: { userIds: [alice.id] } },
      '升级 DSH',
    )
    const preview = proposal.steps[0]?.preview
    expect(preview?.summary).toContain('1 个用户')
    expect(proposal.risk).toBe('R2')
    const mark = lastAuditId()
    const settled = await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const jobId = (settled.outcome?.[0]?.result as { jobId?: number } | undefined)?.jobId ?? 0
    expect(jobId).toBeGreaterThan(0)
    const job = db().get<{ type: string }>('SELECT type FROM jobs WHERE id = ?', jobId)
    expect(job?.type).toBe('rollout.runtime')
  })

  it('rollouts.model：影响面 + 真建 rollout.models 任务', async () => {
    const proposal = await callProposal('rollouts.model', { targets: { userIds: [alice.id] } }, '下发模型')
    expect(proposal.steps[0]?.preview.summary).toContain('影响 1 个用户')
    const mark = lastAuditId()
    const settled = await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const jobId = (settled.outcome?.[0]?.result as { jobId?: number } | undefined)?.jobId ?? 0
    const job = db().get<{ type: string }>('SELECT type FROM jobs WHERE id = ?', jobId)
    expect(job?.type).toBe('rollout.models')
  })

  it('deliveries.create：影响面 + 真提交统一下发', async () => {
    const proposal = await callProposal(
      'deliveries.create',
      {
        platforms: ['instance'],
        items: [{ kind: 'models' }],
        action: 'apply-config',
        targets: { mode: 'users', userIds: [alice.id] },
      },
      '统一下发',
    )
    const preview = proposal.steps[0]?.preview
    expect(preview?.summary).toContain('实例侧执行')
    const mark = lastAuditId()
    const settled = await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const created = settled.outcome?.[0]?.result as { jobs?: { id: number }[] } | undefined
    expect((created?.jobs ?? []).length).toBeGreaterThan(0)
  })

  it('users.quota.set：配额真的改到库里，并提示下次重启生效', async () => {
    const proposal = await callProposal(
      'users.quota.set',
      { userId: alice.id, quota: { cpus: 4, memoryMb: 4096 } },
      '改配额',
    )
    const preview = proposal.steps[0]?.preview
    expect(preview?.summary).toContain('CPU 2→4')
    expect(preview?.warnings?.join(' ')).toContain('下次重启')
    const mark = lastAuditId()
    await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const row = db().get<{ quota_json: string }>('SELECT quota_json FROM users WHERE id = ?', alice.id)
    const quota = JSON.parse(row?.quota_json ?? '{}') as Record<string, unknown>
    // 只改给出的字段：其余字段保留（服务端会与全局默认合并后落库）
    expect(quota).toMatchObject({ cpus: 4, memoryMb: 4096 })
  })

  it('users.wallet.grant：余额真的加上，写流水', async () => {
    const proposal = await callProposal(
      'users.wallet.grant',
      { userId: bob.id, credits: 100, note: '测试充值' },
      '充值',
    )
    expect(proposal.steps[0]?.preview.summary).toContain('余额')
    const mark = lastAuditId()
    await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    expect(h.app.deps.services.relay.getBalance(bob.id)).toBe(100_000_000)
    const ledger = db().get<{ amount: number; note: string }>(
      'SELECT amount, note FROM relay_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      bob.id,
    )
    expect(ledger).toMatchObject({ amount: 100_000_000, note: '测试充值' })
  })

  it('models.price.set：单价真的改了（旧价 → 新价）', async () => {
    const model = await createRelayModel(h.app, {
      name: 'price-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    })
    const proposal = await callProposal(
      'models.price.set',
      { modelId: model.id, price: { inputMicro: 3_000_000, outputMicro: 6_000_000 } },
      '改价',
    )
    const preview = proposal.steps[0]?.preview
    expect(preview?.summary).toContain('输入 1 → 3')
    const mark = lastAuditId()
    await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const price = h.app.deps.services.relay.listModels().find((item) => item.id === model.id)?.price
    expect(price?.inputMicro).toBe(3_000_000)
    expect(price?.outputMicro).toBe(6_000_000)
  })

  it('agent-modes.assign：开放范围真的改了', async () => {
    const proposal = await callProposal(
      'agent-modes.assign',
      { mode: 'claude-code', enabled: true, targets: { userIds: [alice.id] } },
      '开放 Claude Code',
    )
    expect(proposal.steps[0]?.preview.summary).toContain('Claude Code')
    const mark = lastAuditId()
    await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const settings = h.app.deps.services.agentModes.settings('claude-code')
    expect(settings.targets).toEqual({ userIds: [alice.id] })
  })

  it('desktop.devices.revoke：设备状态变 revoked', async () => {
    const deviceId = seedDevice(alice.id, 'desktop', '要吊销的电脑')
    const proposal = await callProposal('desktop.devices.revoke', { deviceId }, '吊销设备')
    expect(proposal.steps[0]?.preview.summary).toContain('要吊销的电脑')
    const mark = lastAuditId()
    await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const row = db().get<{ status: string }>(
      'SELECT status FROM desktop_devices WHERE device_id = ?',
      deviceId,
    )
    expect(row?.status).toBe('revoked')
  })

  it('plugins.policy.set：策略真的改了（optional → required）', async () => {
    const pluginId = seedPlugin()
    const proposal = await callProposal('plugins.policy.set', { pluginId, policy: 'required' }, '改插件策略')
    expect(proposal.steps[0]?.preview.summary).toContain('从 optional 改成 required')
    const mark = lastAuditId()
    await approve(proposal)
    expectCockpitAudits(mark, proposal.id)
    const row = db().get<{ policy: string }>('SELECT policy FROM plugins WHERE id = ?', pluginId)
    expect(row?.policy).toBe('required')
  })
})

// ── R3：敏感 ─────────────────────────────────────────────────────────────────

describe('R3 追加能力：方案的 reauth 与密钥引用', () => {
  it('relay.channels.upsert：apiKey 只收 secretRef，走密钥卡全链路建渠道', async () => {
    // 明文 → 400（§3.4：secretFields 不接受明文）
    const plain = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'relay.channels.upsert',
        args: {
          name: '新渠道',
          baseUrl: 'https://new.example.com',
          apis: ['openai-completions'],
          apiKey: 'sk-test-FAKE-plaintext-key-123456',
        },
        title: '建渠道',
      },
    })
    expect(plain.statusCode).toBe(400)
    expect(plain.body).toContain('secretRef')

    // 申请密钥卡 → 管理员填写 → 拿到 sec_ 引用
    const created = jsonOf<{ id: string }>(
      await opsInject(h, 'POST', '/secret-requests', {
        payload: {
          sessionId: 's1',
          purpose: '新渠道的 API Key',
          capability: 'relay.channels.upsert',
          field: 'apiKey',
        },
      }),
    )
    const fill = await adminInject(h, 'POST', `/secret-requests/${created.id}`, {
      value: 'sk-test-FAKE-cockpit-channel-0123456789',
    })
    expect(fill.statusCode).toBe(204)

    const proposal = await callProposal(
      'relay.channels.upsert',
      {
        name: '新渠道',
        baseUrl: 'https://new.example.com',
        apis: ['openai-completions'],
        apiKey: created.id,
      },
      '建渠道',
    )
    expect(proposal.risk).toBe('R3')
    // 方案里只出现引用号，不出现明文
    expect(JSON.stringify(proposal)).not.toContain('sk-test-FAKE-cockpit-channel')
    const mark = lastAuditId()
    const settled = await approve(proposal, { reauth: true })
    expectCockpitAudits(mark, proposal.id)
    const channelId = (settled.outcome?.[0]?.result as { id?: number }).id ?? 0
    expect(channelId).toBeGreaterThan(0)
    const row = db().get<{ name: string }>('SELECT name FROM relay_channels WHERE id = ?', channelId)
    expect(row?.name).toBe('新渠道')
    // 密钥被加密存进去了（没有明文可查，但确实有一条）
    const keys = db().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM relay_channel_keys WHERE channel_id = ?',
      channelId,
    )
    expect(keys?.n).toBe(1)
  })

  it('desktop.devices.revoke-bulk：两台一起吊销，逐台结果', async () => {
    const first = seedDevice(alice.id, 'desktop', '电脑 A')
    const second = seedDevice(bob.id, 'mobile', '手机 B')
    const proposal = await callProposal(
      'desktop.devices.revoke-bulk',
      { deviceIds: [first, second, 'dv_' + '0'.repeat(32)] },
      '批量吊销',
    )
    const preview = proposal.steps[0]?.preview
    expect(preview?.summary).toContain('3 台')
    expect(preview?.warnings?.join(' ')).toContain('密码')
    const mark = lastAuditId()
    const settled = await approve(proposal, { reauth: true })
    expectCockpitAudits(mark, proposal.id)
    const result = settled.outcome?.[0]?.result as { revoked: number; skipped: number }
    expect(result.revoked).toBe(2)
    expect(result.skipped).toBe(1)
    expect(
      db().get<{ n: number }>("SELECT COUNT(*) AS n FROM desktop_devices WHERE status = 'revoked'")?.n,
    ).toBe(2)
  })

  it('users.restore：回收站里的用户能恢复；不在回收站 → NOT_FOUND', async () => {
    const victim = await createUser(h.app, { username: 'restore-me' })
    await h.app.deps.services.adminUsers.deleteUser(
      victim.id,
      { purge: false },
      { actorId: h.admin.user.id, ip: null, userAgent: 'vitest' },
    )
    const missing = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'users.restore',
        args: { userId: victim.id + 1000 },
        title: '恢复用户',
      },
    })
    expect(missing.statusCode).toBe(404)

    const proposal = await callProposal('users.restore', { userId: victim.id }, '恢复用户')
    expect(proposal.steps[0]?.preview.summary).toContain('restore-me')
    const mark = lastAuditId()
    await approve(proposal, { reauth: true })
    expectCockpitAudits(mark, proposal.id)
    const row = db().get<{ deleted_at: string | null; username: string }>(
      'SELECT deleted_at, username FROM users WHERE id = ?',
      victim.id,
    )
    expect(row?.deleted_at).toBeNull()
    expect(row?.username).toBe('restore-me')
  })

  it('R3 方案没有 reauth 时批准被拒（REAUTH_REQUIRED）', async () => {
    const deviceId = seedDevice(alice.id, 'desktop', '没密码不许吊销')
    const proposal = await callProposal('desktop.devices.revoke-bulk', { deviceIds: [deviceId] }, '批量吊销')
    const res = await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)
    expect(res.statusCode).toBe(403)
    expect(jsonOf<{ error: { code: string } }>(res).error.code).toBe('REAUTH_REQUIRED')
    const row = db().get<{ status: string }>(
      'SELECT status FROM desktop_devices WHERE device_id = ?',
      deviceId,
    )
    expect(row?.status).toBe('active')
  })
})

// ── 座舱自己不是任何写能力的目标（§7） ──────────────────────────────────────

describe('系统账号不能被追加的能力当成目标', () => {
  it('users.quota.set / users.wallet.grant 都拒绝 hub-ops', async () => {
    for (const capability of ['users.quota.set', 'users.wallet.grant']) {
      const res = await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability,
          args:
            capability === 'users.quota.set'
              ? { userId: h.hubOps.id, quota: { cpus: 4 } }
              : { userId: h.hubOps.id, credits: 10 },
          title: '改系统账号',
        },
      })
      expect(res.statusCode, capability).toBe(400)
      expect(res.body).toContain('系统账号')
    }
  })

  it('instances.probe 也拒绝探测座舱自己的实例', async () => {
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'instances.probe',
        args: { userId: h.hubOps.id },
        title: '探座舱',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('顶栏')
  })
})

// ── 脱敏：新增的 R0 能力不留凭据 ────────────────────────────────────────────

describe('I4：追加的 R0 能力同样过 redact()', () => {
  it('审计夹具里的各种凭据形态不会出现在任何一个 R0 输出里', async () => {
    const secrets = {
      sk: 'sk-test-FAKE-abcdefghijklmnop',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.ZmFrZS1wYXlsb2Fk.c2lnbmF0dXJl',
      bearer: 'Bearer FAKE-token-abcdefghij',
      github: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz012345',
      aws: 'AKIAFAKE0123456789AB',
      urlUserinfo: 'https://admin:FAKEpassword123@internal.example.com/x',
      queryToken: 'https://airport.example.com/sub?token=FAKEquerytoken123',
    }
    db().run(
      `INSERT INTO audit_logs (at, actor_id, actor_ip, action, target_type, target_id, detail_json)
       VALUES (?, NULL, NULL, 'fixture.wp56e1', 'fixture', '1', ?)`,
      now(),
      JSON.stringify({
        note: `key=${secrets.sk} jwt=${secrets.jwt} git=${secrets.github} aws=${secrets.aws}`,
        header: secrets.bearer,
        endpoint: secrets.urlUserinfo,
        subscribe: secrets.queryToken,
        author: 'alice',
        authorId: 7,
      }),
    )
    const data = await callData<{ rows: { detail: Record<string, unknown> }[] }>('audit.search', {
      action: 'fixture.wp56e1',
    })
    const detail = data.rows[0]?.detail as Record<string, unknown>
    const serialized = JSON.stringify(detail)
    for (const value of Object.values(secrets)) {
      for (const piece of [value, value.replace(/^Bearer /u, '')]) {
        expect(serialized.includes(piece), `泄漏了 ${piece.slice(0, 12)}…`).toBe(false)
      }
    }
    expect(detail['note']).toContain(COCKPIT_REDACTION_PLACEHOLDER)
    // 反例：author / authorId 这类键不是凭据，必须保留
    expect(detail['author']).toBe('alice')
    expect(detail['authorId']).toBe(7)
  })

  it('channels / search 两个能力的输出里没有夹具里的凭据', async () => {
    const fakeKey = 'sk-test-FAKE-list-channel-key-9876543210'
    createChannel(h.app, {
      name: '干净渠道',
      baseUrl: 'https://upstream.example.com',
      apis: ['openai-completions'],
      keys: [fakeKey],
    })
    for (const capability of ['relay.channels.list', 'search.pools']) {
      const res = await opsInject(h, 'POST', '/call', {
        payload: { sessionId: 's1', capability, args: {} },
      })
      expect(res.statusCode, capability).toBe(200)
      expect(res.body, capability).not.toContain(fakeKey)
    }
    void systemKey
    void app
  })
})
