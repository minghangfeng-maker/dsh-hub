import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CockpitEvent, OpsCallResult, ProposalView } from '@dsh-hub/shared'
import { createTestApp, createUser, type TestApp, type TestUser } from './helpers.js'
import {
  adminInject,
  createCockpitHarness,
  jsonOf,
  opsInject,
  waitProposalSettled,
  type CockpitHarness,
} from './helpers-cockpit.js'

/**
 * WP56e1：座舱方案的生命周期修补（docs/24 §2 I3 / §3.2）。
 *
 * - **启动清扫**（任务书第 7 项）：进程重启时还在 `running` 的方案标 `failed`，
 *   `outcome` 写明「Hub 重启中断」，并经 SSE 推 `proposal.upsert`；
 * - **SSE 补发**（WP56c 移交的第 13 项）：连上 `/events` 时除了 `ops.status` / `strip.update`，
 *   还补发 pending/running 的方案与 pending 的密钥请求 —— 刷新页面后密钥卡才拿得到用途/来源。
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

/** 出一条 R2 方案（pending），返回视图 */
async function pendingProposal(): Promise<ProposalView> {
  const res = await opsInject(h, 'POST', '/call', {
    payload: {
      sessionId: 's1',
      capability: 'instances.stop',
      args: { userId: alice.id },
      title: '停实例',
    },
  })
  const result = jsonOf<OpsCallResult>(res)
  if (result.kind !== 'proposal') throw new Error(`应该出方案，实际 ${result.kind}`)
  return result.proposal
}

/** 把方案手工改成 running（模拟「正在执行时 Hub 被重启」） */
function makeRunning(proposalId: number): void {
  db().run(
    "UPDATE cockpit_proposals SET status = 'running', decided_by = ?, decided_at = ? WHERE id = ?",
    h.admin.user.id,
    now(),
    proposalId,
  )
}

describe('启动清扫：上次进程留下的 running 方案（任务书第 7 项）', () => {
  it('标 failed、outcome 写「Hub 重启中断」、推 SSE、写审计', async () => {
    const proposal = await pendingProposal()
    makeRunning(proposal.id)

    const events: CockpitEvent[] = []
    const off = h.app.deps.services.cockpit.events.subscribe((event) => events.push(event))
    let fixed: number[] = []
    try {
      fixed = h.app.deps.services.cockpit.reconcileInterruptedProposals()
    } finally {
      off()
    }

    expect(fixed).toEqual([proposal.id])
    const view = h.app.deps.services.cockpit.getProposal(proposal.id)
    expect(view.status).toBe('failed')
    expect(view.outcome?.[0]?.error?.code).toBe('INTERRUPTED')
    expect(view.outcome?.[0]?.error?.message).toContain('Hub 重启中断')

    const pushed = events.filter((event) => event.type === 'proposal.upsert')
    expect(pushed.length).toBe(1)
    const first = pushed[0]
    if (first?.type !== 'proposal.upsert') throw new Error('事件类型不对')
    expect(first.proposal.status).toBe('failed')

    const audit = db().get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'cockpit.proposal-failed' ORDER BY id DESC LIMIT 1",
    )
    expect(JSON.parse(audit?.detail_json ?? '{}')).toMatchObject({
      via: 'cockpit',
      reason: 'hub-restart',
      proposalId: proposal.id,
    })
  })

  it('没有 running 方案时什么也不做（不写审计、不推事件）', () => {
    const before = db().get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs')?.id ?? 0
    const events: CockpitEvent[] = []
    const off = h.app.deps.services.cockpit.events.subscribe((event) => events.push(event))
    let fixed: number[] = []
    try {
      fixed = h.app.deps.services.cockpit.reconcileInterruptedProposals()
    } finally {
      off()
    }
    expect(fixed).toEqual([])
    expect(events).toEqual([])
    expect(db().get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs')?.id ?? 0).toBe(
      before,
    )
  })

  it('Hub 启动（onReady）时自动清扫：换一个进程打开同一个数据目录', async () => {
    // 第一个 app：造一条 running 方案，然后只关 Fastify（保留数据目录）
    const first = await createTestApp()
    const dataDir = first.dataDir
    const at = first.clock.nowIso()
    const proposalId = Number(
      first.app.deps.db.run(
        `INSERT INTO cockpit_proposals (session_id, title, rationale, risk, steps_json, status,
                                        created_at, expires_at)
         VALUES ('s1', '重启前正在跑的方案', '', 'R2', '[]', 'running', ?, ?)`,
        at,
        at,
      ).lastInsertRowid,
    )
    await first.app.close()

    let second: TestApp | undefined
    try {
      second = await createTestApp({ env: { HUB_DATA_DIR: dataDir } })
      // onReady 是懒触发的（第一次 inject / listen 才算「启动完成」）：这里显式等它跑完
      await second.app.ready()
      const row = second.app.deps.db.get<{ status: string; outcome_json: string | null }>(
        'SELECT status, outcome_json FROM cockpit_proposals WHERE id = ?',
        proposalId,
      )
      expect(row?.status).toBe('failed')
      expect(row?.outcome_json ?? '').toContain('Hub 重启中断')
    } finally {
      await second?.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('SSE 连上时补发快照（WP56c 移交的第 13 项）', () => {
  it('补发 ops.status / strip.update / pending 方案 / pending 密钥请求（带用途与来源）', async () => {
    const proposal = await pendingProposal()
    const secret = jsonOf<{ id: string; purpose: string }>(
      await opsInject(h, 'POST', '/secret-requests', {
        payload: {
          sessionId: 's1',
          purpose: '新渠道的 API Key',
          capability: 'relay.channels.upsert',
          field: 'apiKey',
        },
      }),
    )

    // SSE 走真监听器（`reply.hijack()` 的流用 inject 读不到）
    const base = await h.app.listen({ port: 0, host: '127.0.0.1' })
    const controller = new AbortController()
    try {
      const response = await fetch(`${base}/api/admin/cockpit/events`, {
        headers: { cookie: h.admin.cookie, origin: h.admin.origin },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const text = await readUntil(response, (buffered) => buffered.includes('secret.request'))
      controller.abort()

      expect(text).toContain('event: ops.status')
      expect(text).toContain('event: strip.update')
      expect(text).toContain('event: proposal.upsert')
      expect(text).toContain(`"id":${String(proposal.id)}`)
      expect(text).toContain('event: secret.request')
      // 刷新页面后密钥卡要拿到用途与来源（这就是补发的目的）
      expect(text).toContain(secret.id)
      expect(text).toContain('新渠道的 API Key')
      expect(text).toContain('relay.channels.upsert')
    } finally {
      controller.abort()
    }
  })

  it('已处理完的方案不补发（只补 pending / running）', async () => {
    const proposal = await pendingProposal()
    await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/reject`)
    expect(h.app.deps.services.cockpit.getProposal(proposal.id).status).toBe('rejected')

    const base = await h.app.listen({ port: 0, host: '127.0.0.1' })
    const controller = new AbortController()
    try {
      const response = await fetch(`${base}/api/admin/cockpit/events`, {
        headers: { cookie: h.admin.cookie, origin: h.admin.origin },
        signal: controller.signal,
      })
      const text = await readUntil(response, (buffered) => buffered.includes('strip.update'))
      controller.abort()
      expect(text).toContain('event: ops.status')
      expect(text).not.toContain('event: proposal.upsert')
    } finally {
      controller.abort()
    }
  })

  it('pendingSnapshot 与补发口径一致（服务层直接断言，不依赖时序）', async () => {
    const proposal = await pendingProposal()
    const running = await pendingProposal()
    makeRunning(running.id)
    const snapshot = h.app.deps.services.cockpit.pendingSnapshot()
    expect(snapshot.proposals.map((item) => item.id).sort()).toEqual([proposal.id, running.id].sort())
    expect(snapshot.secretRequests).toEqual([])
  })
})

/**
 * 读到满足条件为止（默认 3 秒超时）：SSE 是长连接，不能等到流结束。
 * 用 `reader.read()` 逐块累加，命中条件后由调用方 abort。
 */
async function readUntil(
  response: Response,
  predicate: (buffered: string) => boolean,
  timeoutMs = 3_000,
): Promise<string> {
  const body = response.body
  if (!body) throw new Error('SSE 响应没有 body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate(buffered)) break
    if (Date.now() > deadline) throw new Error(`SSE 超时（已收到 ${String(buffered.length)} 字节）`)
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
      ),
    ])
    if (chunk.value !== undefined) buffered += decoder.decode(chunk.value, { stream: true })
    if (chunk.done) {
      if (predicate(buffered)) break
      throw new Error(`SSE 提前结束（已收到 ${String(buffered.length)} 字节）`)
    }
  }
  return buffered
}

// 让 lint 看到 waitProposalSettled 的用途（本文件用不到「等方案跑完」的场景）
void waitProposalSettled
