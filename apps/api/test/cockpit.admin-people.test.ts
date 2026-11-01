import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobSummary, OpsCallResult, ProposalView } from '@dsh-hub/shared'
import { createUser, type TestApp, type TestUser } from './helpers.js'
import {
  adminInject,
  createCockpitHarness,
  jsonOf,
  opsInject,
  reauth,
  waitProposalSettled,
  type CockpitHarness,
} from './helpers-cockpit.js'

/**
 * WP56f 第一批：用户与任务两页剩下的操作（docs/24 §4 之外，覆盖率补到 ≥90%）。
 *
 * 写类统一走「出方案 → 批准 → 状态变 succeeded → 审计带 via=cockpit」，
 * 再用回调断言真正的状态变化；R0 断言返回形状。
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

const app = (): TestApp => h.ctx
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
  const approve = parsed.find((row) => row.action === 'cockpit.proposal-approve')
  expect(approve?.detail['via']).toBe('cockpit')
  expect(approve?.detail['proposalId']).toBe(proposalId)
  for (const row of parsed.filter((item) => !item.action.startsWith('cockpit.'))) {
    expect(row.detail['via'], `${row.action} 缺 via`).toBe('cockpit')
  }
}

/** 写类能力的统一验证：preview 有 summary → 批准 → succeeded → 审计带 via=cockpit */
async function expectWrite(
  capability: string,
  args: unknown,
  opts: {
    check?: (settled: ProposalView) => void | Promise<void>
    expectStatus?: 'succeeded' | 'failed'
  } = {},
): Promise<ProposalView> {
  const proposal = await callProposal(capability, args)
  const preview = proposal.steps[0]?.preview
  expect(preview?.summary.length ?? 0, `${capability} 的 preview.summary 太短`).toBeGreaterThan(4)
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

// ── 用户 ────────────────────────────────────────────────────────────────────

describe('用户页剩下的操作', () => {
  it('users.create：建出账号，临时密码在方案结果里被脱敏', async () => {
    const settled = await expectWrite(
      'users.create',
      { username: 'fresh-user', displayName: '新人', role: 'user' },
      {
        check: () => {
          const row = db().get<{ must_change_password: number }>(
            'SELECT must_change_password FROM users WHERE username = ?',
            'fresh-user',
          )
          expect(row?.must_change_password).toBe(1)
        },
      },
    )
    // 服务端确实生成了临时密码，但它在方案 outcome 里必须已经是 [已隐藏]
    const result = settled.outcome?.[0]?.result as { tempPassword?: string } | undefined
    expect(result?.tempPassword).toBe('[已隐藏]')
  })

  it('users.password.reset：R3 要密码，重置后强制改密', async () => {
    const proposal = await callProposal('users.password.reset', { userId: alice.id })
    expect(proposal.risk).toBe('R3')
    expect(proposal.steps[0]?.preview.warnings?.join(' ')).toContain('经典页面')
    await reauth(h)
    const mark = lastAuditId()
    const approved = await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)
    expect(approved.statusCode, approved.body).toBe(200)
    const settled = await waitProposalSettled(h, proposal.id)
    expect(settled.status).toBe('succeeded')
    expectCockpitAudits(mark, proposal.id)
    expect(
      db().get<{ must_change_password: number }>(
        'SELECT must_change_password FROM users WHERE id = ?',
        alice.id,
      )?.must_change_password,
    ).toBe(1)
    // 临时密码同样被脱敏
    const result = settled.outcome?.[0]?.result as { tempPassword?: string } | undefined
    expect(result?.tempPassword).toBe('[已隐藏]')
  })

  it('users.update：改昵称与角色标签（preview 给旧值 → 新值）', async () => {
    const proposal = await callProposal('users.update', {
      userId: alice.id,
      patch: { displayName: '爱丽丝二世', roleLabel: 'VIP' },
    })
    expect(proposal.steps[0]?.preview.summary).toContain('爱丽丝')
    expect(proposal.steps[0]?.preview.summary).toContain('→')
    const mark = lastAuditId()
    const approved = await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)
    expect(approved.statusCode, approved.body).toBe(200)
    const settled = await waitProposalSettled(h, proposal.id)
    expect(settled.status).toBe('succeeded')
    expectCockpitAudits(mark, proposal.id)
    const row = db().get<{ display_name: string; role_label: string }>(
      'SELECT display_name, role_label FROM users WHERE id = ?',
      alice.id,
    )
    expect(row).toMatchObject({ display_name: '爱丽丝二世', role_label: 'VIP' })
  })

  it('users.update：拒绝改系统账号', async () => {
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'users.update',
        args: { userId: h.hubOps.id, patch: { displayName: 'x' } },
        title: '改系统账号',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('系统账号')
  })

  it('users.approve：pending → active（R1 自动执行）', async () => {
    const pending = await createUser(h.app, { username: 'waiting-user' })
    db().run("UPDATE users SET status = 'pending' WHERE id = ?", pending.id)
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'users.approve',
        args: { userId: pending.id },
        title: '通过审批',
      },
    })
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('done')
    const row = db().get<{ status: string }>('SELECT status FROM users WHERE id = ?', pending.id)
    expect(row?.status).toBe('active')
  })

  it('users.revoke-sessions：会话被清掉（R1 自动执行）', async () => {
    // 先给 alice 造一个登录会话
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'alice', password: alice.password }),
      remoteAddress: '10.219.62.9',
    })
    expect(login.statusCode).toBe(200)
    const activeSessions = (): number =>
      db().get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
        alice.id,
      )?.n ?? 0
    expect(activeSessions()).toBeGreaterThan(0)
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'users.revoke-sessions',
        args: { userId: alice.id },
        title: '踢下线',
      },
    })
    expect(jsonOf<OpsCallResult>(res).kind).toBe('done')
    // 会话是**软吊销**（`revoked_at` 置位），不是删行
    expect(activeSessions()).toBe(0)
  })

  it('users.deleted.list：回收站里能看到被删的用户', async () => {
    const victim = await createUser(h.app, { username: 'trash-user' })
    await h.app.deps.services.adminUsers.deleteUser(
      victim.id,
      { purge: false },
      { actorId: h.admin.user.id, ip: null, userAgent: 'vitest' },
    )
    const data = await callData<{
      total: number
      rows: { id: number; username: string; daysLeft: number }[]
    }>('users.deleted.list')
    const row = data.rows.find((item) => item.id === victim.id)
    expect(row?.username).toBe('trash-user')
    expect(row?.daysLeft).toBeGreaterThan(0)
  })
})

// ── 邀请码 ──────────────────────────────────────────────────────────────────

describe('邀请码：改与删', () => {
  async function seedInvite(): Promise<number> {
    const created = await h.app.deps.services.system.createInvites(
      { count: 1, maxUses: 1, note: '夹具', roleLabel: '', expiresAt: null },
      { actorId: h.admin.user.id, ip: null, userAgent: 'vitest' },
    )
    return created.items[0]!.id
  }

  it('invites.update：停用 + 改备注（旧值 → 新值）', async () => {
    const inviteId = await seedInvite()
    const proposal = await callProposal('invites.update', {
      inviteId,
      patch: { disabled: true, note: '停用中' },
    })
    expect(proposal.steps[0]?.preview.summary).toContain('disabled')
    await expectWrite('invites.update', { inviteId, patch: { disabled: true, note: '停用中' } })
    const row = db().get<{ disabled: number; note: string }>(
      'SELECT disabled, note FROM invites WHERE id = ?',
      inviteId,
    )
    expect(row).toMatchObject({ disabled: 1, note: '停用中' })
  })

  it('invites.delete：删掉后列表里没有它', async () => {
    const inviteId = await seedInvite()
    await expectWrite('invites.delete', { inviteId })
    expect(db().get<{ id: number }>('SELECT id FROM invites WHERE id = ?', inviteId)).toBeUndefined()
  })
})

// ── 任务 ────────────────────────────────────────────────────────────────────

describe('任务：暂停 / 继续 / 取消 / 进度', () => {
  function seedJob(status = 'running'): { jobId: number; taskIds: number[] } {
    const jobId = Number(
      db().run(
        `INSERT INTO jobs (type, title, status, params_json, total, done, failed, created_at, started_at)
         VALUES ('wp56f.fixture', '夹具任务', ?, '{}', 2, 1, 0, ?, ?)`,
        status,
        now(),
        now(),
      ).lastInsertRowid,
    )
    const taskIds = [1, 2].map((seq) =>
      Number(
        db().run(
          `INSERT INTO job_tasks (job_id, seq, user_id, status, attempt, log)
           VALUES (?, ?, ?, ?, 1, '')`,
          jobId,
          seq,
          alice.id,
          seq === 1 ? 'succeeded' : 'pending',
        ).lastInsertRowid,
      ),
    )
    return { jobId, taskIds }
  }

  it('jobs.progress：进度快照（含每一步）', async () => {
    const { jobId } = seedJob()
    const data = await callData<{
      jobId: number
      total: number
      done: number
      percent: number
      rows: unknown[]
    }>('jobs.progress', { jobId })
    expect(data).toMatchObject({ jobId, total: 2, done: 1, percent: 50 })
    expect(data.rows.length).toBe(2)
  })

  it('jobs.pause → jobs.resume：状态来回切', async () => {
    const { jobId } = seedJob()
    await expectWrite(
      'jobs.pause',
      { jobId },
      {
        check: () => {
          expect(db().get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', jobId)?.status).toBe(
            'paused',
          )
        },
      },
    )
    await expectWrite(
      'jobs.resume',
      { jobId },
      {
        check: () => {
          expect(db().get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', jobId)?.status).toBe(
            'running',
          )
        },
      },
    )
  })

  it('jobs.cancel：变成 canceled', async () => {
    const { jobId } = seedJob()
    const settled = await expectWrite('jobs.cancel', { jobId })
    const job = settled.outcome?.[0]?.result as JobSummary
    expect(job.status).toBe('canceled')
    expect(db().get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', jobId)?.status).toBe(
      'canceled',
    )
  })
})

// ── 算力租约 ────────────────────────────────────────────────────────────────

describe('算力租约', () => {
  it('compute.leases：返回分页形状（没有租约时 rows 为空）', async () => {
    const data = await callData<{ total: number; page: number; rows: unknown[] }>('compute.leases', {})
    expect(data.total).toBe(0)
    expect(data.page).toBe(1)
    expect(Array.isArray(data.rows)).toBe(true)
  })
})

void app
