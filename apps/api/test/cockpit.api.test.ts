import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COCKPIT_CANVAS_MAX_ITEMS,
  COCKPIT_PENDING_PROPOSALS_MAX,
  type OpsCallResult,
  type ProposalView,
} from '@dsh-hub/shared'
import { createUser, type TestUser } from './helpers.js'
import {
  adminInject,
  createCockpitHarness,
  jsonOf,
  opsInject,
  proposalRowStatus,
  reauth,
  waitProposalSettled,
  type CockpitHarness,
} from './helpers-cockpit.js'

/**
 * 座舱核心规则（docs/24 §2 不变量 I1/I2/I3/I5/I6 + 方案生命周期 + 画布 + 态势板）。
 * 全部走真路由（`/ops/*` 在独立监听器实例上 inject，管理端走主 app），不 mock service。
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

function auditRows(action?: string) {
  return h.app.deps.db.all<{
    id: number
    actor_id: number | null
    action: string
    target_type: string | null
    target_id: string | null
    detail_json: string | null
  }>(
    action
      ? 'SELECT id, actor_id, action, target_type, target_id, detail_json FROM audit_logs WHERE action = ? ORDER BY id'
      : 'SELECT id, actor_id, action, target_type, target_id, detail_json FROM audit_logs ORDER BY id',
    ...(action ? [action] : []),
  )
}

function auditDetail(action: string): Record<string, unknown>[] {
  return auditRows(action).map((row) => JSON.parse(row.detail_json ?? '{}') as Record<string, unknown>)
}

function setAutoExecuteR1(value: boolean): void {
  const current = h.app.deps.settings.get('cockpit')
  h.app.deps.settings.set('cockpit', { ...current, autoExecuteR1: value })
}

function inviteCount(): number {
  const row = h.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invites')
  return row?.n ?? 0
}

function proposalCount(): number {
  const row = h.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cockpit_proposals')
  return row?.n ?? 0
}

// ────────────────────────────────────────────────────────────────────────────

describe('I1 座舱令牌不能直接执行写操作', () => {
  it('R1：autoExecuteR1=false 时只出方案，库里没有副作用', async () => {
    setAutoExecuteR1(false)
    const res = await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'invites.create', args: { count: 2 }, title: '生成邀请码' },
    })
    expect(res.statusCode).toBe(200)
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('proposal')
    if (result.kind !== 'proposal') throw new Error('unreachable')
    expect(result.proposal.status).toBe('pending')
    expect(result.proposal.risk).toBe('R1')
    expect(result.proposal.steps[0]?.capability).toBe('invites.create')
    expect(inviteCount()).toBe(0)
    expect(auditRows('cockpit.auto-exec')).toHaveLength(0)
  })

  it('请求体里塞 autoExecuteR1 / risk / force 之类的字段不改变判定（I1）', async () => {
    setAutoExecuteR1(false)
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'invites.create',
        args: { count: 1 },
        title: '生成邀请码',
        autoExecuteR1: true,
        autoExecute: true,
        force: true,
        risk: 'R0',
      },
    })
    expect(jsonOf<OpsCallResult>(res).kind).toBe('proposal')
    expect(inviteCount()).toBe(0)
  })

  it('R2 无论设置如何都只出 pending 方案', async () => {
    setAutoExecuteR1(true)
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'instances.stop',
        args: { userId: alice.id },
        title: '停掉爱丽丝的实例',
      },
    })
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('proposal')
    if (result.kind !== 'proposal') throw new Error('unreachable')
    expect(result.proposal.status).toBe('pending')
    expect(result.proposal.risk).toBe('R2')
    expect(proposalRowStatus(h, result.proposal.id)).toBe('pending')
  })

  it('R1 自动执行：审计 actor=hub-ops + policy=autoExecuteR1，并真的建了邀请码', async () => {
    setAutoExecuteR1(true)
    const res = await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'invites.create', args: { count: 2 }, title: '生成邀请码' },
    })
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('done')
    if (result.kind !== 'done') throw new Error('unreachable')
    expect(result.auditId).toBeGreaterThan(0)
    expect(inviteCount()).toBe(2)
    const auto = auditRows('cockpit.auto-exec')
    expect(auto).toHaveLength(1)
    expect(auto[0]?.actor_id).toBe(h.hubOps.id)
    expect(auditDetail('cockpit.auto-exec')[0]).toMatchObject({
      via: 'cockpit',
      policy: 'autoExecuteR1',
      capability: 'invites.create',
    })
    // 能力自身的审计也带上了策略字段（runWithAuditContext）
    const inviteAudit = auditDetail('invite.create')
    expect(inviteAudit).toHaveLength(1)
    expect(inviteAudit[0]).toMatchObject({ via: 'cockpit', policy: 'autoExecuteR1' })
  })

  it('R1 自动执行需要 hub-ops 存在：没有系统账号时退化成方案（不静默执行）', async () => {
    setAutoExecuteR1(true)
    h.probe.opsUserId = null
    const res = await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'invites.create', args: { count: 1 }, title: '生成邀请码' },
    })
    expect(jsonOf<OpsCallResult>(res).kind).toBe('proposal')
    expect(inviteCount()).toBe(0)
  })
})

describe('I2 方案执行用批准的管理员身份', () => {
  it('批准后：审计 actor=管理员、detail.via=cockpit/proposalId/sessionId，能力自身的审计也带这些字段', async () => {
    setAutoExecuteR1(false)
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 'sess-42',
          capability: 'invites.create',
          args: { count: 1, maxUses: 3 },
          title: '给入职的同学发码',
          rationale: '新同事要注册',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const id = created.proposal.id

    const res = await adminInject(h, 'POST', `/proposals/${String(id)}/approve`)
    expect(res.statusCode).toBe(200)
    expect(jsonOf<ProposalView>(res).status).toBe('running')

    const settled = await waitProposalSettled(h, id)
    expect(settled.status).toBe('succeeded')
    expect(settled.decidedBy?.id).toBe(h.admin.user.id)
    expect(settled.outcome?.[0]).toMatchObject({ stepIndex: 0, ok: true })
    expect(inviteCount()).toBe(1)

    const approveAudit = auditRows('cockpit.proposal-approve')
    expect(approveAudit).toHaveLength(1)
    expect(approveAudit[0]?.actor_id).toBe(h.admin.user.id)
    expect(auditDetail('cockpit.proposal-approve')[0]).toMatchObject({
      via: 'cockpit',
      proposalId: id,
      sessionId: 'sess-42',
    })

    // 能力自己写的审计（invite.create）也带 via/proposalId/sessionId
    expect(auditDetail('invite.create')[0]).toMatchObject({
      via: 'cockpit',
      proposalId: id,
      sessionId: 'sess-42',
    })
    // 创建方案的审计 actor 是 hub-ops
    expect(auditRows('cockpit.proposal-create')[0]?.actor_id).toBe(h.hubOps.id)
  })
})

describe('I5 方案不能在聊天里被批准', () => {
  it('/ops 没有批准/拒绝路由（404），方案保持 pending', async () => {
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'instances.stop',
          args: { userId: alice.id },
          title: '停实例',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const id = created.proposal.id
    for (const url of [`/proposals/${String(id)}/approve`, `/proposals/${String(id)}/reject`]) {
      const res = await opsInject(h, 'POST', url, { payload: {} })
      expect(res.statusCode, url).toBe(404)
    }
    expect(proposalRowStatus(h, id)).toBe('pending')
  })

  it('批准接口要求管理员 cookie：普通用户 403、匿名 401', async () => {
    const res = await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'instances.stop', args: { userId: alice.id }, title: '停实例' },
    })
    const created = jsonOf<OpsCallResult>(res)
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const url = `/api/admin/cockpit/proposals/${String(created.proposal.id)}/approve`

    const anonymous = await h.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expect(anonymous.statusCode).toBe(401)

    const { loginAs } = await import('./helpers.js')
    const user = loginAs(h.app, alice)
    const asUser = await h.app.inject({ method: 'POST', url, headers: user.headers, payload: '{}' })

    expect(asUser.statusCode).toBe(403)
    expect(proposalRowStatus(h, created.proposal.id)).toBe('pending')
  })
})

describe('方案生命周期（§3 ProposalView）', () => {
  it('30 分钟过期：approve → CONFLICT，状态变 expired', async () => {
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'instances.stop',
          args: { userId: alice.id },
          title: '停实例',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const id = created.proposal.id
    h.ctx.clock.advance(31 * 60 * 1000)

    const res = await adminInject(h, 'POST', `/proposals/${String(id)}/approve`)
    expect(res.statusCode).toBe(409)
    expect(jsonOf<{ error: { code: string } }>(res).error.code).toBe('CONFLICT')
    expect(h.app.deps.services.cockpit.getProposal(id).status).toBe('expired')
  })

  it('并发批准只执行一次（第二次 409，能力只跑一遍）', async () => {
    setAutoExecuteR1(false)
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: { sessionId: 's1', capability: 'invites.create', args: { count: 1 }, title: '生成邀请码' },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const id = created.proposal.id
    const [first, second] = await Promise.all([
      adminInject(h, 'POST', `/proposals/${String(id)}/approve`),
      adminInject(h, 'POST', `/proposals/${String(id)}/approve`),
    ])
    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([200, 409])
    const settled = await waitProposalSettled(h, id)
    expect(settled.status).toBe('succeeded')
    expect(auditRows('invite.create')).toHaveLength(1)
    expect(inviteCount()).toBe(1)
  })

  it('多步方案中途失败即停，outcome 逐步记录（I3：资源状态在执行时已变）', async () => {
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          steps: [
            { capability: 'invites.create', args: { count: 1 } },
            { capability: 'instances.stop', args: { userId: bob.id } },
          ],
          title: '两步：发码 + 停掉鲍勃的实例',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    expect(created.proposal.risk).toBe('R2')
    expect(created.proposal.steps).toHaveLength(2)
    const id = created.proposal.id

    // 方案创建之后目标用户被删掉 → 第二步按能力自己的校验失败，不静默跳过
    h.app.deps.db.run('DELETE FROM users WHERE id = ?', bob.id)
    const res = await adminInject(h, 'POST', `/proposals/${String(id)}/approve`)
    expect(res.statusCode).toBe(200)
    const settled = await waitProposalSettled(h, id)
    expect(settled.status).toBe('failed')
    expect(settled.outcome).toHaveLength(2)
    expect(settled.outcome?.[0]).toMatchObject({ stepIndex: 0, ok: true })
    expect(settled.outcome?.[1]).toMatchObject({ stepIndex: 1, ok: false })
    expect(settled.outcome?.[1]?.error?.code).toBe('NOT_FOUND')
    expect(inviteCount()).toBe(1)
  })

  it('R3 无 reauth 被拒（REAUTH_REQUIRED），输过密码后可以批准', async () => {
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'users.delete',
          args: { userId: bob.id },
          title: '删掉鲍勃',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const id = created.proposal.id
    const denied = await adminInject(h, 'POST', `/proposals/${String(id)}/approve`)
    expect(denied.statusCode).toBe(403)
    expect(jsonOf<{ error: { code: string } }>(denied).error.code).toBe('REAUTH_REQUIRED')
    expect(proposalRowStatus(h, id)).toBe('pending')

    await reauth(h)
    const ok = await adminInject(h, 'POST', `/proposals/${String(id)}/approve`)
    expect(ok.statusCode).toBe(200)
    const settled = await waitProposalSettled(h, id)
    expect(settled.status).toBe('succeeded')
  })

  it('拒绝：状态 rejected，不执行；再批准 409', async () => {
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'instances.stop',
          args: { userId: alice.id },
          title: '停实例',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const id = created.proposal.id
    const rejected = await adminInject(h, 'POST', `/proposals/${String(id)}/reject`)
    expect(rejected.statusCode).toBe(200)
    expect(jsonOf<ProposalView>(rejected).status).toBe('rejected')
    expect(auditRows('cockpit.proposal-reject')).toHaveLength(1)
    const again = await adminInject(h, 'POST', `/proposals/${String(id)}/approve`)
    expect(again.statusCode).toBe(409)
  })

  it('待处理方案上限：第 21 个被拒（RATE_LIMITED）', async () => {
    for (let index = 0; index < COCKPIT_PENDING_PROPOSALS_MAX; index += 1) {
      const res = await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'instances.stop',
          args: { userId: alice.id },
          title: `停实例 ${String(index)}`,
        },
      })
      expect(jsonOf<OpsCallResult>(res).kind).toBe('proposal')
    }
    const overflow = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'instances.stop',
        args: { userId: alice.id },
        title: '第 21 个',
      },
    })
    expect(overflow.statusCode).toBe(429)
    expect(proposalCount()).toBe(COCKPIT_PENDING_PROPOSALS_MAX)
  })

  it('长轮询等待：批准后 /ops/proposals/:id?waitSec 返回终态', async () => {
    setAutoExecuteR1(false)
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: { sessionId: 's1', capability: 'invites.create', args: { count: 1 }, title: '生成邀请码' },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const id = created.proposal.id
    const waiting = opsInject(h, 'GET', `/proposals/${String(id)}?waitSec=5`)
    // 等它真的在执行再批准（waitSec 上限 5 秒）
    await new Promise((resolve) => setTimeout(resolve, 50))
    await adminInject(h, 'POST', `/proposals/${String(id)}/approve`)
    const view = jsonOf<ProposalView>(await waiting)
    expect(['succeeded', 'running']).toContain(view.status)
  })
})

describe('I6 座舱 DSH 不可用不影响管理台', () => {
  it('state 返回降级状态与原因；态势板五张默认卡、方案列表照常', async () => {
    h.probe.instance = 'error'
    h.probe.reason = '容器启动失败'
    // 让自动拉起也失败
    h.probe.ensureStarted = async () => {
      throw new Error('docker 不可用')
    }
    const res = await adminInject(h, 'GET', '/state')
    expect(res.statusCode).toBe(200)
    const state = jsonOf<{ status: { instance: string; reason?: string }; catalog: unknown[] }>(res)
    expect(state.status.instance).toBe('error')
    expect(state.status.reason).toContain('失败')
    expect(state.catalog.length).toBeGreaterThan(10)

    const board = await adminInject(h, 'GET', '/board')
    expect(board.statusCode).toBe(200)
    const body = jsonOf<{ pinned: unknown[]; defaults: { spec: { kind: string } }[] }>(board)
    // WP56h：默认卡全部是 Hub 数据源（stats / chart / table），不依赖模型；数量从四张变五张
    expect(body.defaults).toHaveLength(5)
    expect(body.defaults.every((item) => ['stats', 'chart', 'table'].includes(item.spec.kind))).toBe(true)

    const proposals = await adminInject(h, 'GET', '/proposals')
    expect(proposals.statusCode).toBe(200)
  })

  it('state 发现未运行会自动拉起（审计 cockpit.ops-start auto=true）', async () => {
    h.probe.instance = 'stopped'
    const res = await adminInject(h, 'GET', '/state')
    expect(jsonOf<{ status: { instance: string } }>(res).status.instance).toBe('running')
    expect(h.probe.startCalls).toBe(1)
    expect(auditDetail('cockpit.ops-start')).toContainEqual(
      expect.objectContaining({ via: 'cockpit', auto: true }),
    )
  })

  it('WP57：state?start=0 只读状态，不拉起（概览里的 AI 助手由管理员点「启动」）', async () => {
    h.probe.instance = 'stopped'
    const before = h.probe.startCalls
    const res = await adminInject(h, 'GET', '/state?start=0')
    expect(res.statusCode).toBe(200)
    expect(jsonOf<{ status: { instance: string } }>(res).status.instance).toBe('stopped')
    expect(h.probe.startCalls).toBe(before)
  })
})

describe('画布（§3 CanvasSpec）', () => {
  it('DSH 建 source 卡：R0 数据源可以，R2 能力被拒', async () => {
    const ok = await opsInject(h, 'POST', '/canvas', {
      payload: {
        sessionId: 's1',
        title: '运行中实例',
        spec: {
          kind: 'table',
          columns: [{ key: 'username', label: '用户' }],
          data: { source: { capability: 'instances.list', args: { status: 'running' } } },
        },
      },
    })
    expect(ok.statusCode).toBe(200)
    const item = jsonOf<{ id: string; origin: string; pinned: boolean }>(ok)
    expect(item.origin).toBe('dsh')
    expect(item.pinned).toBe(false)

    const bad = await opsInject(h, 'POST', '/canvas', {
      payload: {
        sessionId: 's1',
        title: '停实例',
        spec: {
          kind: 'table',
          columns: [{ key: 'x', label: 'x' }],
          data: { source: { capability: 'instances.stop', args: {} } },
        },
      },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('proposal / secret-request 卡只能由 Hub 生成', async () => {
    for (const spec of [
      { kind: 'proposal', proposalId: 1 },
      { kind: 'secret-request', requestId: 'sec_x' },
    ]) {
      const res = await opsInject(h, 'POST', '/canvas', {
        payload: { sessionId: 's1', title: 'Hub 卡', spec },
      })
      expect(res.statusCode, JSON.stringify(spec)).toBe(400)
    }
  })

  it('每会话 60 张上限：最旧的非钉住卡被移除，钉住的不动', async () => {
    const created: string[] = []
    for (let index = 0; index < COCKPIT_CANVAS_MAX_ITEMS - 2; index += 1) {
      const res = await opsInject(h, 'POST', '/canvas', {
        payload: {
          sessionId: 'cap',
          title: `卡 ${String(index)}`,
          spec: { kind: 'markdown', text: `# ${String(index)}` },
        },
      })
      created.push(jsonOf<{ id: string }>(res).id)
    }
    // 把第一张钉住，再建两张：被删的应该是最旧的**非钉住**卡（第 2、3 张）
    const pinRes = await adminInject(h, 'PATCH', `/canvas/${created[0]!}`, { pinned: true })
    expect(pinRes.statusCode).toBe(200)
    // 再建 4 张：超过 60 之后每建一张删掉最旧的非钉住卡
    for (const index of [0, 1, 2, 3]) {
      const res = await opsInject(h, 'POST', '/canvas', {
        payload: {
          sessionId: 'cap',
          title: `再建 ${String(index)}`,
          spec: { kind: 'markdown', text: 'x' },
        },
      })
      expect(res.statusCode).toBe(200)
    }
    const list = jsonOf<{ items: { id: string }[] }>(await adminInject(h, 'GET', '/canvas?sessionId=cap'))
    expect(list.items).toHaveLength(COCKPIT_CANVAS_MAX_ITEMS)
    const ids = list.items.map((item) => item.id)
    expect(ids).toContain(created[0])
    expect(ids).not.toContain(created[1])
    expect(ids).not.toContain(created[2])
  })

  it('DSH 不能改 Hub 生成的卡，也不能改别的会话的卡', async () => {
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'instances.stop',
          args: { userId: alice.id },
          title: '停实例',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const hubCards = jsonOf<{ items: { id: string; origin: string }[] }>(
      await adminInject(h, 'GET', '/canvas?sessionId=s1'),
    )
    const hubCard = hubCards.items.find((item) => item.origin === 'hub')
    expect(hubCard).toBeDefined()
    const patchHub = await opsInject(h, 'PATCH', `/canvas/${hubCard!.id}`, {
      payload: { sessionId: 's1', title: '改个名' },
    })
    expect(patchHub.statusCode).toBe(403)

    const dshCard = jsonOf<{ id: string }>(
      await opsInject(h, 'POST', '/canvas', {
        payload: { sessionId: 's1', title: '我的卡', spec: { kind: 'markdown', text: 'hi' } },
      }),
    )
    const patchOther = await opsInject(h, 'PATCH', `/canvas/${dshCard.id}`, {
      payload: { sessionId: 's2', title: '改个名' },
    })
    expect(patchOther.statusCode).toBe(403)
  })

  it('方案卡自动出现在画布上，且来源是 Hub', async () => {
    await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's9', capability: 'instances.stop', args: { userId: alice.id }, title: '停实例' },
    })
    const list = jsonOf<{ items: { origin: string; spec: { kind: string; proposalId?: number } }[] }>(
      await adminInject(h, 'GET', '/canvas?sessionId=s9'),
    )
    const card = list.items.find((item) => item.spec.kind === 'proposal')
    expect(card?.origin).toBe('hub')
    expect(card?.spec.proposalId).toBeGreaterThan(0)
  })

  it('管理员可以钉卡与关掉卡（SSE 事件同步）', async () => {
    const events: string[] = []
    const off = h.app.deps.services.cockpit.events.subscribe((event) => events.push(event.type))
    const card = jsonOf<{ id: string }>(
      await opsInject(h, 'POST', '/canvas', {
        payload: { sessionId: 's1', title: '卡', spec: { kind: 'markdown', text: 'hi' } },
      }),
    )
    const pinned = await adminInject(h, 'PATCH', `/canvas/${card.id}`, { pinned: true, order: 5 })
    expect(pinned.statusCode).toBe(200)
    expect(jsonOf<{ pinned: boolean; order: number }>(pinned)).toMatchObject({ pinned: true, order: 5 })
    expect(events).toContain('canvas.upsert')

    const removed = await adminInject(h, 'DELETE', `/canvas/${card.id}`)
    expect(removed.statusCode).toBe(204)
    expect(events).toContain('canvas.remove')
    off()
  })
})

describe('座舱自己的实例（is_system=1）不对能力开放（docs/24 §7）', () => {
  it('instances.start/stop/restart 在参数校验阶段就拒绝，提示「顶栏重启」', async () => {
    await h.app.deps.services.instances.provision(h.hubOps.id)
    for (const capability of ['instances.start', 'instances.stop', 'instances.restart']) {
      const res = await opsInject(h, 'POST', '/call', {
        payload: { sessionId: 's1', capability, args: { userId: h.hubOps.id }, title: '动座舱实例' },
      })
      expect(res.statusCode, capability).toBe(400)
      const body = jsonOf<{ error: { code: string; message: string } }>(res)
      expect(body.error.code).toBe('VALIDATION_FAILED')
      expect(body.error.message).toContain('顶栏重启')
    }
    expect(proposalCount()).toBe(0)
  })

  it('instances.list / instances.stats 不列它，instances.get 看不到它', async () => {
    await h.app.deps.services.instances.provision(h.hubOps.id)
    await h.app.deps.services.instances.provision(alice.id)
    const list = jsonOf<{ data: { rows: { userId: number; username: string }[] } }>(
      await opsInject(h, 'POST', '/call', {
        payload: { sessionId: 's1', capability: 'instances.list', args: {} },
      }),
    )
    const ids = list.data.rows.map((row) => row.userId)
    expect(ids).toContain(alice.id)
    expect(ids).not.toContain(h.hubOps.id)
    expect(list.data.rows.map((row) => row.username)).not.toContain('hub-ops')

    const stats = jsonOf<{ data: { rows: { userId: number }[] } }>(
      await opsInject(h, 'POST', '/call', {
        payload: { sessionId: 's1', capability: 'instances.stats', args: {} },
      }),
    )
    expect(stats.data.rows.map((row) => row.userId)).not.toContain(h.hubOps.id)

    const get = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'instances.get',
        args: { userId: h.hubOps.id },
      },
    })
    expect(get.statusCode).toBe(404)
  })
})

describe('舰桥投放规则（§1）：舷位与尺寸', () => {
  it('auto：数据类投左舷、行动类投右舷；显式指定时按指定来', async () => {
    const markdown = jsonOf<{ placement: string; size: string }>(
      await opsInject(h, 'POST', '/canvas', {
        payload: { sessionId: 's1', title: '说明卡', spec: { kind: 'markdown', text: 'hi' } },
      }),
    )
    expect(markdown.placement).toBe('left')
    expect(markdown.size).toBe('m')

    const table = jsonOf<{ placement: string }>(
      await opsInject(h, 'POST', '/canvas', {
        payload: {
          sessionId: 's1',
          title: '用户表',
          spec: {
            kind: 'table',
            columns: [{ key: 'username', label: '用户' }],
            data: { source: { capability: 'users.list', args: {} } },
          },
        },
      }),
    )
    expect(table.placement).toBe('left')

    const job = jsonOf<{ placement: string }>(
      await opsInject(h, 'POST', '/canvas', {
        payload: { sessionId: 's1', title: '任务进度', spec: { kind: 'job', jobId: 7 } },
      }),
    )
    expect(job.placement).toBe('right')

    const forced = jsonOf<{ placement: string; size: string }>(
      await opsInject(h, 'POST', '/canvas', {
        payload: {
          sessionId: 's1',
          title: '大号的左舷卡',
          spec: { kind: 'markdown', text: 'x' },
          placement: 'right',
          size: 'l',
        },
      }),
    )
    expect(forced.placement).toBe('right')
    expect(forced.size).toBe('l')
  })

  it('Hub 生成的方案卡 / 密钥卡一律右舷', async () => {
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'instances.stop',
          args: { userId: alice.id },
          title: '停实例',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const cards = jsonOf<{ items: { origin: string; placement: string; spec: { kind: string } }[] }>(
      await adminInject(h, 'GET', '/canvas?sessionId=s1'),
    )
    const proposalCard = cards.items.find((item) => item.spec.kind === 'proposal')
    expect(proposalCard?.origin).toBe('hub')
    expect(proposalCard?.placement).toBe('right')
  })

  it('DSH 可以 PATCH 自己的卡换舷，管理员可以拖动任意卡换舷', async () => {
    const card = jsonOf<{ id: string }>(
      await opsInject(h, 'POST', '/canvas', {
        payload: { sessionId: 's1', title: '卡', spec: { kind: 'markdown', text: 'x' } },
      }),
    )
    const moved = jsonOf<{ placement: string; size: string }>(
      await opsInject(h, 'PATCH', `/canvas/${card.id}`, {
        payload: { sessionId: 's1', placement: 'right', size: 's' },
      }),
    )
    expect(moved).toMatchObject({ placement: 'right', size: 's' })

    const adminMoved = jsonOf<{ placement: string }>(
      await adminInject(h, 'PATCH', `/canvas/${card.id}`, { placement: 'left' }),
    )
    expect(adminMoved.placement).toBe('left')
  })

  it('态势板默认卡（WP56h 图形化）：左舷舰况指标 + 两张图 + 失败任务表，右舷待处理方案', async () => {
    const board = jsonOf<{
      defaults: { id: string; placement: string; size: string; spec: { kind: string } }[]
    }>(await adminInject(h, 'GET', '/board'))
    expect(board.defaults).toHaveLength(5)
    const left = board.defaults.filter((item) => item.placement === 'left')
    const right = board.defaults.filter((item) => item.placement === 'right')
    expect(left).toHaveLength(4)
    expect(right).toHaveLength(1)
    expect(right[0]?.id).toBe('board:pending-proposals')
    // 左舷：①舰况（stats，s）②7 天用量（堆叠柱）③实例资源（柱）④失败任务（表格，s）
    expect(left.map((item) => item.id)).toEqual([
      'board:vitals',
      'board:relay-usage',
      'board:instance-resources',
      'board:failed-jobs',
    ])
    expect(left[0]?.spec.kind).toBe('stats')
    expect(left[0]?.size).toBe('s')
    expect(left[1]?.spec.kind).toBe('chart')
    expect(left[2]?.spec.kind).toBe('chart')
    // 明细表只在「必须逐行追问」的地方保留，并要求压到 s
    expect(left[3]?.spec.kind).toBe('table')
    expect(left[3]?.size).toBe('s')
    expect(right[0]?.size).toBe('s')
  })
})

describe('状态条（§1）：GET /status-strip 与 strip.update 事件', () => {
  it('返回四个数字，并在方案创建时推 strip.update', async () => {
    const events: { type: string; strip?: { pendingProposals: number } }[] = []
    const off = h.app.deps.services.cockpit.events.subscribe((event) => events.push(event))
    const res = await adminInject(h, 'GET', '/status-strip')
    expect(res.statusCode).toBe(200)
    const strip = jsonOf<{
      instancesRunning: number
      instancesTotal: number
      failedJobs: number
      pendingProposals: number
      relayTodayRequests: number
    }>(res)
    expect(strip.instancesRunning).toBeGreaterThanOrEqual(0)
    expect(strip.instancesTotal).toBeGreaterThanOrEqual(0)
    expect(strip.pendingProposals).toBe(0)

    await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'instances.stop', args: { userId: alice.id }, title: '停实例' },
    })
    expect(events.some((event) => event.type === 'strip.update')).toBe(true)
    const updated = events.filter((event) => event.type === 'strip.update').at(-1)
    expect(updated?.strip?.pendingProposals).toBe(1)
    off()
  })

  it('/state 也带上状态条（前端一次拿全）', async () => {
    const state = jsonOf<{ strip: { pendingProposals: number } }>(await adminInject(h, 'GET', '/state'))
    expect(state.strip).toBeDefined()
    expect(state.strip.pendingProposals).toBe(0)
  })
})

describe('下发插件方案（rollouts.plugin）：影响面来自 Hub preview，批准后真建任务', () => {
  function seedPlugin(): { pluginId: number; versionId: number } {
    const now = h.ctx.clock.nowIso()
    const pluginId = h.app.deps.db.run(
      `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                            is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
       VALUES ('@local/wp56a-test-plugin', '测试插件', '', NULL, NULL, 'optional', 0, 20, '', 0, ?, ?)`,
      now,
      now,
    ).lastInsertRowid
    const versionId = h.app.deps.db.run(
      `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
       VALUES (?, 'cloud', '0.1.0', 'npm', '@local/wp56a-test-plugin', '{}', NULL, NULL, NULL, ?)`,
      pluginId,
      now,
    ).lastInsertRowid
    return { pluginId, versionId }
  }

  it('方案里存的是 Hub 算的影响面；批准返回 200 并执行成功（可选字段不因脱敏变成 null）', async () => {
    const { pluginId, versionId } = seedPlugin()
    const created = jsonOf<OpsCallResult>(
      await opsInject(h, 'POST', '/call', {
        payload: {
          sessionId: 's1',
          capability: 'rollouts.plugin',
          args: {
            pluginId,
            versionId,
            action: 'install',
            targets: { userIds: [alice.id] },
            strategy: { restart: 'next-start' },
          },
          title: '下发测试插件',
          rationale: '测试',
        },
      }),
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    const preview = created.proposal.steps[0]?.preview
    expect(preview?.summary).toContain('影响 1 个用户')
    expect(preview?.affected?.length).toBe(1)
    expect(preview?.warnings).toBeUndefined()

    const approve = await adminInject(h, 'POST', `/proposals/${String(created.proposal.id)}/approve`)
    expect(approve.statusCode).toBe(200)
    const settled = await waitProposalSettled(h, created.proposal.id)
    expect(settled.status).toBe('succeeded')
    const jobId = (settled.outcome?.[0]?.result as { jobId?: number } | undefined)?.jobId
    expect(jobId).toBeGreaterThan(0)
    // 任务真的建出来了（假驱动会在后台跑，状态不在本用例断言范围内）
    if (jobId === undefined) throw new Error('方案结果里没有 jobId')
    const jobRow = h.app.deps.db.get<{ id: number; type: string }>(
      'SELECT id, type FROM jobs WHERE id = ?',
      jobId,
    )
    expect(jobRow?.type).toContain('rollout')
  })
})

describe('能力目录（/ops/catalog）', () => {
  it('目录里每个能力都有 JSON Schema 参数说明、description 与 risk', async () => {
    const res = await opsInject(h, 'GET', '/catalog')
    expect(res.statusCode).toBe(200)
    const body = jsonOf<{
      items: { id: string; input: Record<string, unknown>; description: string }[]
      total: number
    }>(res)
    expect(body.total).toBeGreaterThan(20)
    for (const item of body.items) {
      expect(Object.keys(item.input).length, `${item.id} 缺 JSON Schema`).toBeGreaterThan(0)
      expect(item.description.length).toBeGreaterThan(20)
    }
  })

  it('关键词与区域过滤', async () => {
    const byQ = jsonOf<{ items: { id: string }[] }>(
      await opsInject(h, 'GET', `/catalog?q=${encodeURIComponent('实例')}`),
    )
    expect(byQ.items.some((item) => item.id.startsWith('instances.'))).toBe(true)
    const byArea = jsonOf<{ items: { area: string }[] }>(await opsInject(h, 'GET', '/catalog?area=relay'))
    expect(byArea.items.length).toBeGreaterThan(0)
    expect(byArea.items.every((item) => item.area === 'relay')).toBe(true)
  })
})

describe('系统账号 hub-ops 不出现在用户列表与统计里（§3.5）', () => {
  it('用户列表、概览统计、注册名额都不数它', async () => {
    const list = jsonOf<{ items: { username: string }[]; total: number }>(
      await adminInject(h, 'GET', '/state').then(async () => {
        const res = await h.app.inject({
          method: 'GET',
          url: '/api/admin/users',
          headers: h.admin.headers,
        })
        return res
      }),
    )
    expect(list.items.map((item) => item.username)).not.toContain('hub-ops')
    // alice + bob + 测试用的管理员（hub-ops 不计）
    expect(list.total).toBe(3)
    const overview = jsonOf<{ users: { total: number } }>(
      await h.app.inject({ method: 'GET', url: '/api/admin/overview', headers: h.admin.headers }),
    )
    expect(overview.users.total).toBe(3)
  })
})
