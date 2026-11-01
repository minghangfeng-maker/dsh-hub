import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CanvasItem, ProposalView } from '@/api/admin-cockpit'
import { resolveMockScenario } from '@/mocks'
import { getCockpitMockState, subscribeCockpit } from '@/mocks/cockpit'
import { installMockFetch } from '@/mocks/fetch'
import { MOCK_SCENARIOS } from '@/mocks/state'

/**
 * 座舱假接口（`?mock=cockpit*`，docs/24 §3.2）：
 * 六种走查状态对应的假数据、数据源白名单、以及「批准 → 执行中 → 已完成」的时间线。
 */

const restores: (() => void)[] = []

function useMock(scenario: string): void {
  restores.push(installMockFetch(scenario as never))
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(path, init)
  const body = response.status === 204 ? null : ((await response.json()) as T)
  return { status: response.status, body: body as T }
}

/** `/board` 真后端是 `{ pinned, defaults }`（CockpitBoardResponse）；断言按一条卡片流写，钉住的在前 */
async function boardApi(): Promise<{ status: number; body: { items: CanvasItem[] } }> {
  const res = await api<{ pinned: CanvasItem[]; defaults: CanvasItem[] }>('/api/admin/cockpit/board')
  return { ...res, body: { items: [...res.body.pinned, ...res.body.defaults] } }
}

function post(body?: unknown): RequestInit {
  return { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }
}

afterEach(() => {
  for (const restore of restores) restore()
  restores.length = 0
})

describe('座舱场景（?mock=cockpit*）', () => {
  it('五个场景都能被 URL 解析出来，也都在 MOCK_SCENARIOS 里', () => {
    for (const scenario of ['cockpit', 'cockpit-empty', 'cockpit-off', 'cockpit-r3', 'cockpit-secret']) {
      expect(resolveMockScenario(`?mock=${scenario}`, null)).toBe(scenario)
      expect(MOCK_SCENARIOS).toContain(scenario)
    }
  })

  it('`cockpit`：运行中，能力目录带数据源标记，态势板有默认卡 + 钉住的卡 + 待处理方案', async () => {
    useMock('cockpit')

    const state = await api<{
      status: { instance: string }
      pendingProposals: number
      catalog: unknown[]
      strip: { instancesRunning: number; instancesTotal: number; pendingProposals: number }
    }>('/api/admin/cockpit/state')
    expect(state.body.status.instance).toBe('running')
    expect(state.body.pendingProposals).toBe(1)
    expect(state.body.catalog.length).toBeGreaterThan(5)
    // WP56a 追加：状态条与 /status-strip 同形
    expect(state.body.strip.instancesRunning).toBe(5)
    expect(state.body.strip.instancesTotal).toBe(12)
    expect(state.body.strip.pendingProposals).toBe(1)

    const strip = await api<{ instancesRunning: number }>('/api/admin/cockpit/status-strip')
    expect(strip.body.instancesRunning).toBe(5)

    const board = await boardApi()
    // 与 WP56h `boardDefaults()` 同形：左舷「舰况」指标 + 两张图 + 失败任务表，右舷「待处理方案」
    const ids = board.body.items.map((item) => item.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'board:vitals',
        'board:relay-usage',
        'board:instance-resources',
        'board:failed-jobs',
        'board:pending-proposals',
      ]),
    )
    const pendingCard = board.body.items.find((item) => item.id === 'board:pending-proposals')
    expect(pendingCard?.placement).toBe('right')
    expect(pendingCard?.spec.kind).toBe('table')
  })

  it('画布按会话分桶；「插件升级」会话里三种方案状态都有', async () => {
    useMock('cockpit')

    const usage = await api<{ items: CanvasItem[] }>('/api/admin/cockpit/canvas?sessionId=sess_weekly_usage')
    expect(usage.body.items.map((item) => item.spec.kind)).toEqual(
      expect.arrayContaining(['stats', 'chart', 'table', 'markdown']),
    )

    const plugin = await api<{ items: CanvasItem[] }>(
      '/api/admin/cockpit/canvas?sessionId=sess_plugin_upgrade',
    )
    const kinds = plugin.body.items.map((item) => item.spec.kind)
    expect(kinds).toContain('proposal')
    expect(kinds).toContain('entity')
    expect(kinds).toContain('logs')

    const proposals = await api<{ items: ProposalView[] }>('/api/admin/cockpit/proposals')
    expect(proposals.body.items.map((item) => item.status)).toEqual(
      expect.arrayContaining(['pending', 'running', 'failed']),
    )
  })

  it('每张卡都有已解析的舷位与高度档位（docs/24 §3 CanvasItem.placement/size）', async () => {
    useMock('cockpit')

    const board = await boardApi()
    for (const item of board.body.items) {
      expect(['left', 'right']).toContain(item.placement)
      expect(['s', 'm', 'l']).toContain(item.size)
    }

    // 默认五张（WP56h）：左舷 ①舰况指标 ②7 天用量堆叠柱 ③实例资源柱 ④失败任务表，右舷「待处理方案」
    const defaults = board.body.items.filter((item) => item.sessionId === 'board')
    expect(defaults).toHaveLength(5)
    expect(defaults.filter((item) => item.placement === 'left')).toHaveLength(4)
    expect(defaults.filter((item) => item.placement === 'right')).toHaveLength(1)
    const pendingCard = board.body.items.find((item) => item.id === 'board:pending-proposals')
    expect(pendingCard?.spec.kind).toBe('table')
    expect(pendingCard?.placement).toBe('right')
  })

  it('拖动换舷：PATCH placement 会改掉假数据里的舷位', async () => {
    useMock('cockpit')

    const before = await boardApi()
    const target = before.body.items.find((item) => item.placement === 'left')
    expect(target).toBeTruthy()

    const patched = await api<CanvasItem>(`/api/admin/cockpit/canvas/${String(target?.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ placement: 'right', order: 9 }),
    })
    expect(patched.body.placement).toBe('right')
    expect(patched.body.order).toBe(9)
  })

  it('`cockpit-turn`：开局两舷为空，随后图 + 占比 + 方案依次经 SSE 投放', async () => {
    useMock('cockpit-turn')

    const empty = await boardApi()
    expect(empty.body.items).toHaveLength(0)

    const dropped: { id: string; placement: string }[] = []
    const unsubscribe = subscribeCockpit((event) => {
      if (event.type === 'canvas.upsert') {
        dropped.push({ id: event.item.id, placement: event.item.placement })
      }
    })

    await vi.waitFor(() => expect(dropped).toHaveLength(4), { timeout: 6000 })
    expect(dropped.map((item) => item.id)).toEqual([
      'turn-area',
      'turn-stacked',
      'turn-donut',
      'turn-proposal',
    ])
    expect(dropped.map((item) => item.placement)).toEqual(['left', 'left', 'left', 'right'])
    unsubscribe()
  })

  it('数据源：只允许 dataSource=true 的 R0 能力，返回 rows', async () => {
    useMock('cockpit')

    const ok = await api<{ rows: Record<string, unknown>[] }>(
      '/api/admin/cockpit/source',
      post({ capability: 'users.list', args: {} }),
    )
    expect(ok.status).toBe(200)
    expect(ok.body.rows).toHaveLength(6)
    expect(ok.body.rows[0]).toHaveProperty('username')

    const usage = await api<{ rows: Record<string, unknown>[] }>(
      '/api/admin/cockpit/source',
      post({ capability: 'relay.usage', args: {} }),
    )
    expect(usage.body.rows).toHaveLength(7)
    expect(usage.body.rows[0]).toHaveProperty('day')

    // 写类能力不能当数据源
    const denied = await api('/api/admin/cockpit/source', post({ capability: 'users.delete', args: {} }))
    expect(denied.status).toBe(403)
  })

  it('批准 → 执行中 → 已完成（SSE 推两次状态）', async () => {
    useMock('cockpit')
    const events: string[] = []
    const unsubscribe = subscribeCockpit((event) => {
      if (event.type === 'proposal.upsert') events.push(event.proposal.status)
    })

    const approved = await api<ProposalView>('/api/admin/cockpit/proposals/12/approve', post())
    expect(approved.body.status).toBe('running')
    expect(events.at(-1)).toBe('running')

    await vi.waitFor(() => expect(events.at(-1)).toBe('succeeded'), { timeout: 6000 })
    expect(getCockpitMockState().proposals.find((item) => item.id === 12)?.status).toBe('succeeded')
    unsubscribe()
  })

  it('拒绝：状态变 rejected，不再能批', async () => {
    useMock('cockpit')

    const rejected = await api<ProposalView>('/api/admin/cockpit/proposals/12/reject', post())
    expect(rejected.body.status).toBe('rejected')

    const again = await api('/api/admin/cockpit/proposals/12/approve', post())
    expect(again.status).toBe(409)
  })

  it('密钥卡：只回 204，值不出现在任何响应里；状态经 SSE 变 filled', async () => {
    useMock('cockpit-secret')
    const filled: string[] = []
    const unsubscribe = subscribeCockpit((event) => {
      if (event.type === 'secret.request') filled.push(event.request.status)
    })

    const submit = await api('/api/admin/cockpit/secret-requests/sec_req_1', post({ value: 'sk-test-value' }))
    expect(submit.status).toBe(204)
    expect(filled).toEqual(['filled'])
    expect(JSON.stringify(getCockpitMockState())).not.toContain('sk-test-value')

    const cancel = await api('/api/admin/cockpit/secret-requests/sec_req_1', { method: 'DELETE' })
    expect(cancel.status).toBe(204)
    unsubscribe()
  })

  it('`cockpit-empty`：空态势板（一张卡都没有）', async () => {
    useMock('cockpit-empty')
    const board = await boardApi()
    expect(board.body.items).toHaveLength(0)

    const canvas = await api<{ items: CanvasItem[] }>('/api/admin/cockpit/canvas?sessionId=sess_weekly_usage')
    expect(canvas.body.items).toHaveLength(0)
  })

  it('`cockpit-off`：座舱 DSH 停止 + 模型不可用，但态势板与待处理方案照常（I6）', async () => {
    useMock('cockpit-off')

    const state = await api<{ status: { instance: string; model: string | null; reason?: string } }>(
      '/api/admin/cockpit/state',
    )
    expect(state.body.status.instance).toBe('stopped')
    expect(state.body.status.model).toBeNull()
    expect(state.body.status.reason).toBeTruthy()

    const board = await boardApi()
    expect(board.body.items.length).toBeGreaterThan(0)

    const proposals = await api<{ items: ProposalView[] }>('/api/admin/cockpit/proposals?status=pending')
    expect(proposals.body.items.length).toBeGreaterThan(0)
  })

  it('`cockpit-r3`：待确认方案是 R3；方案卡在该会话的画布里，态势板用「待处理方案」表列出来', async () => {
    useMock('cockpit-r3')

    const proposals = await api<{ items: ProposalView[] }>('/api/admin/cockpit/proposals?status=pending')
    const r3 = proposals.body.items[0]
    expect(r3?.risk).toBe('R3')

    const canvas = await api<{ items: CanvasItem[] }>('/api/admin/cockpit/canvas?sessionId=sess_oncall_1029')
    expect(
      canvas.body.items.some((item) => item.spec.kind === 'proposal' && item.spec.proposalId === r3?.id),
    ).toBe(true)

    // 态势板的第四张默认卡是 source 表（能力 cockpit.pending-proposals）
    const board = await boardApi()
    const pendingCard = board.body.items.find((item) => item.id === 'board:pending-proposals')
    const spec = pendingCard?.spec
    expect(spec?.kind === 'table' && 'source' in spec.data ? spec.data.source.capability : null).toBe(
      'cockpit.pending-proposals',
    )

    const rows = await api<{ rows: Record<string, unknown>[] }>(
      '/api/admin/cockpit/source',
      post({ capability: 'cockpit.pending-proposals', args: {} }),
    )
    expect(rows.body.rows[0]).toMatchObject({ proposalId: r3?.id, risk: 'R3' })
  })

  it('重启座舱：先 starting，2 秒后回到 running（SSE 推状态）', async () => {
    useMock('cockpit-off')
    const statuses: string[] = []
    const unsubscribe = subscribeCockpit((event) => {
      if (event.type === 'ops.status') statuses.push(event.status.instance)
    })

    const started = await api<{ status: { instance: string } }>(
      '/api/admin/cockpit/ops-instance/restart',
      post(),
    )
    expect(started.body.status.instance).toBe('starting')

    await vi.waitFor(() => expect(statuses.at(-1)).toBe('running'), { timeout: 5000 })
    unsubscribe()
  })
})
