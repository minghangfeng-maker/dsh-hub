import { describe, expect, it } from 'vitest'

import type { CanvasItem, CockpitEvent, ProposalView } from '@/api/admin-cockpit'
import { classicPageGroups, classicPageList } from '@/components/admin/cockpit/classic-pages'
import {
  PROPOSAL_STATUS_TEXT,
  applyCockpitEvent,
  applyTurnMessage,
  buildEmphasis,
  BOARD_CARD_IDS,
  axisLabelStep,
  buildCanvasChartData,
  buildCanvasDonutData,
  buildCanvasStatsItems,
  canvasTableEmptyText,
  formatCompactNumber,
  monotoneCubicPath,
  tableBarMax,
  tableBarRatio,
  canDecideProposal,
  canvasDataBadge,
  capabilityTitle,
  defaultPlacementOf,
  dropTargetOf,
  groupForPane,
  isActionSpec,
  isAwaitingConfirmation,
  resolvePlacement,
  splitByPlacement,
  cockpitFrameUrl,
  emptyCockpitLive,
  formatCanvasCell,
  isProposalExpired,
  normalizeCockpitEvent,
  opsStatusHint,
  opsStatusMeta,
  parseCockpitMessage,
  sessionLabelOf,
  prefillForCard,
  prefillForRow,
  proposalStatusTone,
  riskMeta,
  sortCanvasItems,
  statusStatCardId,
  summarizeRow,
  turnEmphasisOf,
  type CockpitLive,
} from '@/utils/cockpit'

/**
 * 座舱纯逻辑（WP56c）：风险分级、方案状态、SSE 归约、postMessage 校验、画布格子格式化、图表取数。
 * 组件只管渲染，规则都在这里，所以也都在这里测。
 */

function canvasItem(partial: Partial<CanvasItem> & Pick<CanvasItem, 'id'>): CanvasItem {
  return {
    sessionId: 'sess-1',
    title: partial.title ?? '卡',
    spec: partial.spec ?? { kind: 'markdown', text: 'hi' },
    pinned: partial.pinned ?? false,
    order: partial.order ?? 0,
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
    origin: partial.origin ?? 'dsh',
    placement: partial.placement ?? 'left',
    size: partial.size ?? 'm',
    ...partial,
  }
}

function proposal(partial: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 12,
    sessionId: 'sess-1',
    title: '下发插件',
    rationale: '说明',
    risk: 'R2',
    steps: [
      {
        capability: 'rollouts.plugin',
        args: {},
        preview: { summary: '影响 8 人' },
      },
    ],
    status: 'pending',
    createdAt: '2026-10-29T10:00:00.000Z',
    expiresAt: '2026-10-29T10:30:00.000Z',
    ...partial,
  }
}

describe('风险分级与方案状态（docs/24 §0）', () => {
  it('四档风险各有文案与色调，未知按 R2 处理', () => {
    expect(riskMeta('R0').text).toBe('R0 只读')
    expect(riskMeta('R3').tone).toBe('danger')
    expect(riskMeta('NOPE' as 'R2').text).toBe('R2 有影响')
  })

  it('方案状态文案与色调', () => {
    expect(PROPOSAL_STATUS_TEXT.running).toBe('执行中')
    expect(proposalStatusTone('failed')).toBe('danger')
    expect(proposalStatusTone('expired')).toBe('neutral')
  })

  it('过期判定与「能否点执行」', () => {
    const now = Date.parse('2026-10-29T10:10:00.000Z')
    expect(isProposalExpired(proposal(), now)).toBe(false)
    expect(canDecideProposal(proposal(), now)).toBe(true)

    expect(isProposalExpired(proposal({ expiresAt: '2026-10-29T10:05:00.000Z' }), now)).toBe(true)
    expect(canDecideProposal(proposal({ status: 'running' }), now)).toBe(false)
    expect(canDecideProposal(proposal({ status: 'failed' }), now)).toBe(false)
  })

  it('能力 id → 中文短名（目录里没有就退回 id）', () => {
    const catalog = [
      {
        id: 'rollouts.plugin',
        area: 'rollouts' as const,
        title: '下发插件',
        description: '',
        risk: 'R2' as const,
        input: {},
      },
    ]
    expect(capabilityTitle(catalog, 'rollouts.plugin')).toBe('下发插件')
    expect(capabilityTitle(catalog, 'users.delete')).toBe('users.delete')
  })
})

describe('SSE 事件归约（docs/24 §3.2）', () => {
  it('canvas.upsert：进对应会话；钉住的卡同时进态势板', () => {
    const state = emptyCockpitLive()
    const pinned = canvasItem({ id: 'c1', pinned: true, order: 2 })
    const next = applyCockpitEvent(state, { type: 'canvas.upsert', item: pinned })

    expect(next.canvas['sess-1']).toHaveLength(1)
    expect(next.board.map((item) => item.id)).toEqual(['c1'])
    // 原状态不变（纯函数）
    expect(state.canvas['sess-1']).toBeUndefined()

    const unpinned = canvasItem({ id: 'c1', pinned: false })
    const off = applyCockpitEvent(next, { type: 'canvas.upsert', item: unpinned })
    expect(off.board).toHaveLength(0)
    expect(off.canvas['sess-1']?.[0]?.pinned).toBe(false)
  })

  it('canvas.remove 同时从会话与态势板移除', () => {
    let state: CockpitLive = emptyCockpitLive()
    state = applyCockpitEvent(state, {
      type: 'canvas.upsert',
      item: canvasItem({ id: 'c1', pinned: true }),
    })
    state = applyCockpitEvent(state, { type: 'canvas.remove', id: 'c1', sessionId: 'sess-1' })
    expect(state.canvas['sess-1']).toHaveLength(0)
    expect(state.board).toHaveLength(0)
  })

  it('同一张卡再推一次是更新，不是重复插入；顺序按 order', () => {
    let state: CockpitLive = emptyCockpitLive()
    state = applyCockpitEvent(state, {
      type: 'canvas.upsert',
      item: canvasItem({ id: 'b', order: 2, title: '旧' }),
    })
    state = applyCockpitEvent(state, { type: 'canvas.upsert', item: canvasItem({ id: 'a', order: 1 }) })
    state = applyCockpitEvent(state, {
      type: 'canvas.upsert',
      item: canvasItem({ id: 'b', order: 2, title: '新' }),
    })

    const items = state.canvas['sess-1'] ?? []
    expect(items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(items[1]?.title).toBe('新')
  })

  it('proposal / secret / ops.status', () => {
    let state: CockpitLive = emptyCockpitLive()
    state = applyCockpitEvent(state, { type: 'proposal.upsert', proposal: proposal() })
    state = applyCockpitEvent(state, {
      type: 'proposal.upsert',
      proposal: proposal({ status: 'running' }),
    })
    expect(state.proposals).toHaveLength(1)
    expect(state.proposals[0]?.status).toBe('running')

    state = applyCockpitEvent(state, {
      type: 'secret.request',
      request: {
        id: 'sec_req_1',
        sessionId: 'sess-1',
        purpose: 'key',
        capability: 'relay.channels.upsert',
        field: 'apiKey',
        status: 'pending',
        expiresAt: '2026-10-29T10:15:00.000Z',
      },
    })
    expect(state.secrets).toHaveLength(1)

    state = applyCockpitEvent(state, {
      type: 'ops.status',
      status: { instance: 'stopped', model: null, reason: '未运行', autoExecuteR1: false },
    })
    expect(state.status?.instance).toBe('stopped')
  })

  it('sortCanvasItems 不修改入参', () => {
    const items = [canvasItem({ id: 'b', order: 2 }), canvasItem({ id: 'a', order: 1 })]
    expect(sortCanvasItems(items).map((item) => item.id)).toEqual(['a', 'b'])
    expect(items.map((item) => item.id)).toEqual(['b', 'a'])
  })
})

describe('SSE 事件归一（event 名 vs data.type 两种写法）', () => {
  const item = canvasItem({ id: 'c1' })

  it('`event: canvas.upsert` + `{item}`', () => {
    const event = normalizeCockpitEvent('canvas.upsert', { item })
    expect(event).toEqual({ type: 'canvas.upsert', item })
  })

  it('`data: {type:' + "'canvas.upsert'" + ', item}`（默认事件名 message）', () => {
    const event = normalizeCockpitEvent('message', { type: 'canvas.upsert', item })
    expect(event?.type).toBe('canvas.upsert')
  })

  it('认不出的形状返回 null（不把脏数据塞进画布）', () => {
    expect(normalizeCockpitEvent('canvas.upsert', { item: { id: 3 } })).toBeNull()
    expect(normalizeCockpitEvent('canvas.upsert', 'text')).toBeNull()
    expect(normalizeCockpitEvent('ops.status', { status: { model: 'x' } })).toBeNull()
    expect(normalizeCockpitEvent('canvas.remove', {})).toBeNull()
    expect(normalizeCockpitEvent('unknown', { item })).toBeNull()
  })

  it('ops.status / proposal.upsert / secret.request', () => {
    expect(normalizeCockpitEvent('ops.status', { status: { instance: 'running', model: 'm' } })?.type).toBe(
      'ops.status',
    )
    expect(normalizeCockpitEvent('proposal.upsert', { proposal: proposal() })?.type).toBe('proposal.upsert')
    expect(
      normalizeCockpitEvent('secret.request', {
        request: {
          id: 'sec_req_1',
          sessionId: 's',
          purpose: 'p',
          capability: 'c',
          field: 'f',
          status: 'pending',
          expiresAt: '',
        },
      })?.type,
    ).toBe('secret.request')
  })
})

describe('postMessage 协议（docs/24 §6）', () => {
  const origin = 'https://hub.example'

  it('拒绝异源消息（哪怕形状完全正确）', () => {
    expect(parseCockpitMessage('https://evil.example', origin, { type: 'cockpit.ready' })).toBeNull()
    expect(
      parseCockpitMessage('https://evil.example', origin, { type: 'cockpit.session', sessionId: 's' }),
    ).toBeNull()
    // 空 origin 也不收（防止调用方漏传 expectedOrigin）
    expect(parseCockpitMessage(origin, '', { type: 'cockpit.ready' })).toBeNull()
  })

  it('同源 + 已知形状才收', () => {
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.ready' })).toEqual({ type: 'cockpit.ready' })
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.auth-expired' })).toEqual({
      type: 'cockpit.auth-expired',
    })
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.session', sessionId: 'sess-1' })).toEqual({
      type: 'cockpit.session',
      sessionId: 'sess-1',
    })
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.session', sessionId: null })).toEqual({
      type: 'cockpit.session',
      sessionId: null,
    })
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.focus-proposal', id: 12 })).toEqual({
      type: 'cockpit.focus-proposal',
      id: 12,
    })
  })

  it('形状不对一律丢：未知类型、sessionId 是数字、id 不是数字、非对象', () => {
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.drop-database' })).toBeNull()
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.session', sessionId: 3 })).toBeNull()
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.session', sessionId: '' })).toBeNull()
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.focus-proposal', id: '12' })).toBeNull()
    expect(parseCockpitMessage(origin, origin, null)).toBeNull()
    expect(parseCockpitMessage(origin, origin, 'cockpit.ready')).toBeNull()
  })

  it('iframe 地址：码在 hash 里，带 embed=cockpit 与 theme=console', () => {
    expect(cockpitFrameUrl(null)).toBe('/m/?embed=cockpit&theme=console')
    expect(cockpitFrameUrl('abc 123')).toBe('/m/?embed=cockpit&theme=console#code=abc%20123')
    expect(cockpitFrameUrl('c', { theme: null })).toBe('/m/?embed=cockpit#code=c')
  })

  it('新的子 → 父消息：focus-canvas（字符串 id）与 turn（布尔）', () => {
    const origin = 'https://hub.example'
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.focus-canvas', id: 'card-1' })).toEqual({
      type: 'cockpit.focus-canvas',
      id: 'card-1',
    })
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.turn', running: true })).toEqual({
      type: 'cockpit.turn',
      running: true,
    })
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.focus-canvas', id: 7 })).toBeNull()
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.turn', running: 'yes' })).toBeNull()
  })
})

describe('画布格子与数据角标', () => {
  it('格式：数字 / 积分 / 字节 / 日期时间 / 状态 / 空值', () => {
    expect(formatCanvasCell(1234.5, 'number')).toBe('1,234.50')
    expect(formatCanvasCell(12, 'number')).toBe('12')
    expect(formatCanvasCell(3.2, 'credits')).toBe('3.20')
    expect(formatCanvasCell(1024, 'bytes')).toBe('1 KB')
    expect(formatCanvasCell('2026-10-29T10:00:00.000Z', 'datetime')).not.toBe('—')
    expect(formatCanvasCell('failed', 'status')).toBe('失败')
    expect(formatCanvasCell('running', 'status')).toBe('运行中')
    expect(formatCanvasCell(null)).toBe('—')
    expect(formatCanvasCell(undefined, 'bytes')).toBe('—')
  })

  it('source 卡标「Hub 数据」，内联卡按来源标（Hub 生成的卡也算 Hub 数据）', () => {
    const sourceSpec = {
      kind: 'table' as const,
      columns: [{ key: 'a', label: 'A' }],
      data: { source: { capability: 'users.list', args: {} } },
    }
    const inlineSpec = {
      kind: 'table' as const,
      columns: [{ key: 'a', label: 'A' }],
      data: { rows: [] },
    }
    expect(canvasDataBadge(sourceSpec, 'dsh')).toBe('hub')
    expect(canvasDataBadge(inlineSpec, 'dsh')).toBe('dsh')
    expect(canvasDataBadge(inlineSpec, 'hub')).toBe('hub')
    expect(canvasDataBadge({ kind: 'markdown', text: 'x' })).toBeNull()
  })
})

describe('图表取数', () => {
  const spec = {
    kind: 'chart' as const,
    chart: 'line' as const,
    x: { key: 'day', format: 'date' as const },
    series: [
      { key: 'dsh', label: 'DSH' },
      { key: 'claude', label: 'Claude Code' },
    ],
    data: { rows: [] },
  }

  it('x 轴取 date 格式（MM-DD）、系列值与颜色令牌', () => {
    const rows = [
      { day: '2026-10-27', dsh: 9.2, claude: 4.1 },
      { day: '2026-10-28', dsh: '11.4', claude: 3.2 },
    ]
    const data = buildCanvasChartData(spec, rows)
    expect(data.labels).toEqual(['10-27', '10-28'])
    expect(data.series[0]?.values).toEqual([9.2, 11.4])
    expect(data.series[0]?.color).toBe('var(--c-series-1)')
    expect(data.series[1]?.color).toBe('var(--c-series-2)')
    expect(data.max).toBe(11.4)
  })

  it('缺值与非法值按 0 处理；第 7 条起复用色位并加虚线', () => {
    const wideSpec = {
      ...spec,
      series: Array.from({ length: 7 }, (_, index) => ({
        key: `s${String(index)}`,
        label: `S${String(index)}`,
      })),
    }
    const data = buildCanvasChartData(wideSpec, [{ day: '2026-10-29', s0: 1, s1: null, s2: 'x' }])
    expect(data.series[1]?.values).toEqual([0])
    expect(data.series[2]?.values).toEqual([0])
    expect(data.series[6]?.color).toBe('var(--c-series-other)')
    expect(data.series[6]?.dashed).toBe(true)
    expect(data.series[0]?.dashed).toBe(false)
  })

  it('x 轴标签抽稀', () => {
    expect(axisLabelStep(7, 7)).toBe(1)
    expect(axisLabelStep(30, 6)).toBe(5)
    expect(axisLabelStep(0, 6)).toBe(1)
  })
})

describe('图表几何（WP56h）', () => {
  it('单调三次曲线：端点是数据点，指令是 M + C，没有 L 折线', () => {
    const path = monotoneCubicPath([
      { x: 0, y: 100 },
      { x: 10, y: 40 },
      { x: 20, y: 60 },
      { x: 30, y: 20 },
    ])
    expect(path.startsWith('M0.0,100.0')).toBe(true)
    expect(path.endsWith('30.0,20.0')).toBe(true)
    expect(path).toContain(' C')
    expect(path).not.toContain(' L')
    // 3 个区间 = 3 段三次贝塞尔
    expect(path.match(/C/g)).toHaveLength(3)
  })

  it('单调三次曲线不过冲：控制点落在相邻两点的值域内', () => {
    // 一个尖峰（100 → 10）：如果按 Catmull-Rom 算，控制点会冲到 10 以下
    const points = [
      { x: 0, y: 10 },
      { x: 10, y: 100 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
    ]
    const path = monotoneCubicPath(points)
    const numbers = path
      .replace(/[MC]/g, ' ')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    for (const value of numbers) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(110)
    }
  })

  it('退化输入：空数组、单点、两点', () => {
    expect(monotoneCubicPath([])).toBe('')
    expect(monotoneCubicPath([{ x: 1, y: 2 }])).toBe('M1.0,2.0')
    expect(
      monotoneCubicPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe('M0.0,0.0 L10.0,10.0')
    // 非法点被过滤掉
    expect(monotoneCubicPath([{ x: Number.NaN, y: 1 }])).toBe('')
  })

  it('紧凑数字：K / M / B，小数值保留一位', () => {
    expect(formatCompactNumber(0)).toBe('0')
    expect(formatCompactNumber(42)).toBe('42')
    expect(formatCompactNumber(999)).toBe('999')
    expect(formatCompactNumber(45_300)).toBe('45.3K')
    expect(formatCompactNumber(1_200_000)).toBe('1.2M')
    expect(formatCompactNumber(1_000_000)).toBe('1M')
    expect(formatCompactNumber(2_400_000_000)).toBe('2.4B')
    expect(formatCompactNumber(Number.NaN)).toBe('—')
  })

  it('donut：一行一个扇区，x.key 分类、series[0].key 数值，色位与百分比', () => {
    const spec = {
      kind: 'chart' as const,
      chart: 'donut' as const,
      x: { key: 'username' },
      series: [{ key: 'credits', label: '积分' }],
      data: { rows: [] },
    }
    const data = buildCanvasDonutData(spec, [
      { username: 'alice', credits: 60 },
      { username: 'bob', credits: 30 },
      { username: 'carol', credits: 10 },
    ])
    expect(data.total).toBe(100)
    expect(data.seriesLabel).toBe('积分')
    expect(data.slices.map((slice) => slice.percent)).toEqual([60, 30, 10])
    expect(data.slices[0]?.color).toBe('var(--c-series-1)')
    expect(data.slices[2]?.color).toBe('var(--c-series-3)')
  })

  it('donut：负值/非数字按 0，总数为 0 时不给扇区', () => {
    const spec = {
      kind: 'chart' as const,
      chart: 'donut' as const,
      x: { key: 'username' },
      series: [{ key: 'credits', label: '积分' }],
      data: { rows: [] },
    }
    const data = buildCanvasDonutData(spec, [
      { username: 'a', credits: -5 },
      { username: 'b', credits: 'x' },
    ])
    expect(data.slices).toEqual([])
    expect(data.total).toBe(0)
  })
})

describe('stats 卡的 data.source（WP56h）', () => {
  it('每一行变成一项指标；max/spark/tone/unit 收口', () => {
    const items = buildCanvasStatsItems([
      { label: '运行实例', value: 5, max: 12 },
      { label: '今日请求', value: 421, spark: [1, 2, 3] },
      { label: '今日积分消耗', value: 3.21, unit: '积分', delta: -8, tone: 'bad' },
      { label: '缺 label 的行会被丢掉', value: 1 },
      { value: 9 },
      { label: '坏 max', value: 1, max: 0 },
      { label: '坏 spark', value: 1, spark: ['x', 2, null] },
      { label: '坏 tone', value: 1, tone: 'purple' },
      { label: '字符串值', value: '—' },
    ])
    expect(items).toHaveLength(8)
    expect(items[0]).toMatchObject({ label: '运行实例', value: 5, max: 12 })
    expect(items[1]?.spark).toEqual([1, 2, 3])
    expect(items[2]).toMatchObject({ unit: '积分', delta: -8, tone: 'bad' })
    // max 必须 >0、tone 只认四个值、spark 只收数字
    expect(items.find((item) => item.label === '坏 max')?.max).toBeUndefined()
    expect(items.find((item) => item.label === '坏 spark')?.spark).toEqual([2])
    expect(items.find((item) => item.label === '坏 tone')?.tone).toBeUndefined()
    expect(items.find((item) => item.label === '字符串值')?.value).toBe('—')
  })

  it('最多 12 项、spark 最多 60 点（多给的截掉尾巴）', () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      label: `指标 ${String(index)}`,
      value: index,
      spark: Array.from({ length: 80 }, (_, point) => point),
    }))
    const items = buildCanvasStatsItems(rows)
    expect(items).toHaveLength(12)
    expect(items[0]?.spark).toHaveLength(60)
    expect(items[0]?.spark?.at(-1)).toBe(79)
  })

  it('stats 卡挂 data 时角标是「Hub 数据」（canvasDataOf 认得 stats.data）', () => {
    const spec = {
      kind: 'stats' as const,
      items: [],
      data: { source: { capability: 'cockpit.board-vitals', args: {}, refreshSec: 15 } },
    }
    expect(canvasDataBadge(spec, 'hub')).toBe('hub')
    expect(canvasDataBadge({ kind: 'stats', items: [] }, 'dsh')).toBeNull()
  })
})

describe('表格数据条（WP56h）', () => {
  it('按列最大值归一；0 与非法值不画', () => {
    const rows = [
      { username: 'alice', points: 40 },
      { username: 'bob', points: 10 },
      { username: 'carol', points: 0 },
      { username: 'dave', points: 'x' },
    ]
    expect(tableBarMax(rows, 'points')).toBe(40)
    expect(tableBarRatio(40, 40)).toBe(1)
    expect(tableBarRatio(10, 40)).toBe(0.25)
    // 最小 2%：极小但非 0 的格子也要看得见
    expect(tableBarRatio(0.1, 40)).toBe(0.02)
    expect(tableBarRatio(0, 40)).toBe(0)
    expect(tableBarRatio(Number.NaN, 40)).toBe(0)
    expect(tableBarMax(rows, 'missing')).toBe(0)
  })
})

describe('状态条读数 → 默认卡 id（WP56h）', () => {
  it('「实例」定位到舰况指标卡、「今日用量」定位到 7 天用量图、「失败任务」定位到明细表', () => {
    expect(statusStatCardId('instances')).toBe('board:vitals')
    expect(statusStatCardId('usage')).toBe('board:relay-usage')
    expect(statusStatCardId('failed-jobs')).toBe('board:failed-jobs')
    expect(statusStatCardId('pending')).toBe('board:pending-proposals')
  })

  it('五张默认卡的 id 互不相同，且用的是 Hub 后端的同一份命名（board: 前缀）', () => {
    const ids = Object.values(BOARD_CARD_IDS)
    expect(new Set(ids).size).toBe(5)
    expect(ids.every((id) => id.startsWith('board:'))).toBe(true)
  })
})

describe('表格空态文案（WP56h）', () => {
  const tableSpec = (capability: string, args: Record<string, unknown> = {}) => ({
    kind: 'table' as const,
    columns: [{ key: 'title', label: '标题' }],
    data: { source: { capability, args } },
  })

  it('失败任务 → 「一切正常」，待处理方案 → 「没有待确认的操作」', () => {
    expect(canvasTableEmptyText(tableSpec('jobs.list', { status: 'failed' }))).toBe('一切正常')
    expect(canvasTableEmptyText(tableSpec('cockpit.pending-proposals'))).toBe('没有待确认的操作')
  })

  it('别的表格 / 非表格卡不给文案（渲染器退回「没有数据」）', () => {
    expect(canvasTableEmptyText(tableSpec('jobs.list'))).toBeUndefined()
    expect(canvasTableEmptyText(tableSpec('relay.usage', { by: 'day' }))).toBeUndefined()
    expect(canvasTableEmptyText({ kind: 'stats', items: [] })).toBeUndefined()
    // 内联 rows 的表格也没有「数据源语义」可言
    expect(
      canvasTableEmptyText({ kind: 'table', columns: [{ key: 'a', label: 'A' }], data: { rows: [] } }),
    ).toBeUndefined()
  })
})

describe('「问 DSH」预填（docs/24 §1）', () => {
  it('卡片级与行级', () => {
    const item = canvasItem({ id: 'c1', title: '本周消耗最多的用户' })
    expect(prefillForCard(item)).toContain('本周消耗最多的用户')
    expect(prefillForRow(item, { username: 'alice', points: 32.14 })).toBe(
      '追问「本周消耗最多的用户」里的这一行：username=alice，points=32.14。',
    )
    expect(prefillForRow(item, {})).toBe('追问「本周消耗最多的用户」里的一行。')
  })

  it('行摘要跳过空值、最多 6 个字段、超长截断', () => {
    expect(summarizeRow({ a: 1, b: null, c: '', d: 2 })).toBe('a=1，d=2')
    const long = { v: 'x'.repeat(100) }
    expect(summarizeRow(long)).toContain('…')
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${String(index)}`, index]))
    expect(summarizeRow(many).split('，')).toHaveLength(6)
  })
})

describe('顶栏胶囊（I6：停了 / 模型不可用也要说清）', () => {
  it('五种实例状态', () => {
    expect(opsStatusMeta({ instance: 'running', model: 'x', autoExecuteR1: true }).text).toBe('运行中')
    expect(opsStatusMeta({ instance: 'starting', model: null, autoExecuteR1: true }).spinning).toBe(true)
    expect(opsStatusMeta({ instance: 'stopped', model: null, autoExecuteR1: false }).tone).toBe('neutral')
    expect(opsStatusMeta({ instance: 'missing', model: null, autoExecuteR1: false }).text).toBe('未创建')
    expect(opsStatusMeta({ instance: 'error', model: null, autoExecuteR1: false }).tone).toBe('danger')
    expect(opsStatusMeta(null).text).toBe('状态未知')
  })

  it('悬浮文字包含模型、自动执行与服务端原因', () => {
    expect(opsStatusHint({ instance: 'running', model: 'deepseek-v4.1-flash', autoExecuteR1: true })).toBe(
      '模型 deepseek-v4.1-flash · R1 自动执行已开启',
    )
    expect(
      opsStatusHint({
        instance: 'stopped',
        model: null,
        reason: '座舱 DSH 未运行',
        autoExecuteR1: false,
      }),
    ).toBe('座舱 DSH 未运行')
    expect(opsStatusHint(null)).toContain('正在读取')
  })
})

describe('事件丢弃不影响现有状态', () => {
  it('未知事件类型返回原状态', () => {
    const state = emptyCockpitLive()
    expect(applyCockpitEvent(state, { type: 'nope' } as unknown as CockpitEvent)).toBe(state)
  })
})

describe('「经典页面」菜单（docs/24 §1）', () => {
  it('按 admin-nav 分组生成；「概览」指向 /admin/overview（/admin 是座舱）', () => {
    const pages = classicPageList()
    expect(pages.find((page) => page.label === '概览')?.key).toBe('/admin/overview')
    expect(pages.map((page) => page.key)).not.toContain('/admin')
    expect(pages.map((page) => page.key)).toEqual(
      expect.arrayContaining([
        '/admin/users',
        '/admin/instances',
        '/admin/models',
        '/admin/settings',
        '/admin/audit',
      ]),
    )

    const groups = classicPageGroups()
    expect(groups[0]?.title).toBe('')
    expect(groups.map((group) => group.title)).toEqual(
      expect.arrayContaining(['人与环境', '能力下发', '系统']),
    )
  })
})

describe('投放规则（docs/24 §1）', () => {
  const dataSpec = { kind: 'stats' as const, items: [{ label: 'a', value: 1 }] }
  const proposalSpec = { kind: 'proposal' as const, proposalId: 1 }
  const secretSpec = { kind: 'secret-request' as const, requestId: 'sec_req_1' }
  const jobSpec = { kind: 'job' as const, jobId: 1 }

  it('数据类默认左舷，行动类默认右舷', () => {
    expect(defaultPlacementOf(dataSpec)).toBe('left')
    expect(defaultPlacementOf(proposalSpec)).toBe('right')
    expect(defaultPlacementOf(secretSpec)).toBe('right')
    expect(defaultPlacementOf(jobSpec)).toBe('right')
    expect(isActionSpec(proposalSpec)).toBe(true)
    expect(isActionSpec(dataSpec)).toBe(false)
  })

  it('auto：目标舷放不下就投另一舷', () => {
    expect(resolvePlacement(dataSpec, 'auto', 0, 0)).toBe('left')
    expect(resolvePlacement(dataSpec, undefined, 0, 0)).toBe('left')
    expect(resolvePlacement(proposalSpec, 'auto', 0, 0)).toBe('right')
    // 左舷已经比右舷多两张：数据卡改投右舷
    expect(resolvePlacement(dataSpec, 'auto', 5, 1)).toBe('right')
    // 明确指定就照办
    expect(resolvePlacement(proposalSpec, 'left', 5, 5)).toBe('left')
  })

  it('按舷分桶并按 order 排序', () => {
    const items = [
      canvasItem({ id: 'r2', placement: 'right', order: 2 }),
      canvasItem({ id: 'l2', placement: 'left', order: 2 }),
      canvasItem({ id: 'l1', placement: 'left', order: 1 }),
    ]
    const split = splitByPlacement(items)
    expect(split.left.map((item) => item.id)).toEqual(['l1', 'l2'])
    expect(split.right.map((item) => item.id)).toEqual(['r2'])
  })

  it('右舷「待确认」区：pending 的方案 / 密钥在上，处理完沉到普通区', () => {
    const pending = proposal({ id: 12, status: 'pending', sessionId: 's' })
    const done = proposal({ id: 13, status: 'succeeded', sessionId: 's' })
    const cardPending = canvasItem({
      id: 'p12',
      placement: 'right',
      spec: { kind: 'proposal', proposalId: 12 },
    })
    const cardDone = canvasItem({
      id: 'p13',
      placement: 'right',
      order: 2,
      spec: { kind: 'proposal', proposalId: 13 },
    })
    const data = canvasItem({ id: 'd1', placement: 'right', order: 3 })

    expect(isAwaitingConfirmation(cardPending, [pending, done], [])).toBe(true)
    expect(isAwaitingConfirmation(cardDone, [pending, done], [])).toBe(false)
    expect(isAwaitingConfirmation(data, [pending, done], [])).toBe(false)

    const right = groupForPane([cardDone, cardPending, data], 'right', [pending, done], [])
    expect(right.pending.map((item) => item.id)).toEqual(['p12'])
    expect(right.normal.map((item) => item.id)).toEqual(['p13', 'd1'])

    const left = groupForPane([data], 'left', [], [])
    expect(left.pending).toHaveLength(0)
    expect(left.normal).toHaveLength(1)
  })

  it('拖动落点：舷内中值、末尾 +1、空舷从头', () => {
    const items = [
      canvasItem({ id: 'a', placement: 'left', order: 1 }),
      canvasItem({ id: 'b', placement: 'left', order: 2 }),
      canvasItem({ id: 'c', placement: 'left', order: 3 }),
    ]
    // a 放到 b 前面：取 a 与 b 之间的中值
    expect(dropTargetOf(items, 'c', 'left', 'b')).toEqual({ placement: 'left', order: 1.5 })
    // 放到末尾
    expect(dropTargetOf(items, 'a', 'left')).toEqual({ placement: 'left', order: 4 })
    // 换到空舷
    expect(dropTargetOf(items, 'a', 'right')).toEqual({ placement: 'right', order: 1 })
    // 落到最前面
    expect(dropTargetOf(items, 'c', 'left', 'a')).toEqual({ placement: 'left', order: 0 })
  })
})

describe('回合强调（docs/24 §1「实时感」）', () => {
  it('cockpit.turn：开始记时刻，结束后保留', () => {
    const idle = { running: false, startedAt: null }
    const started = applyTurnMessage(idle, true, 1000)
    expect(started).toEqual({ running: true, startedAt: 1000 })
    const ended = applyTurnMessage(started, false, 2000)
    expect(ended).toEqual({ running: false, startedAt: 1000 })
  })

  it('本回合的卡 current、更早的 past、不在回合 idle', () => {
    const start = Date.parse('2026-10-29T10:00:05.000Z')
    const turn = { running: true, startedAt: start }
    const fresh = canvasItem({ id: 'n', updatedAt: '2026-10-29T10:00:10.000Z' })
    const old = canvasItem({ id: 'o', updatedAt: '2026-10-29T09:59:00.000Z' })

    expect(turnEmphasisOf(fresh, { running: false, startedAt: null })).toBe('idle')
    expect(turnEmphasisOf(old, turn)).toBe('past')
    expect(turnEmphasisOf(fresh, turn)).toBe('current')
    // 到达时刻优先（浏览器时钟与服务端时钟可能差几秒）
    expect(turnEmphasisOf(old, turn, start + 1000)).toBe('current')
    expect(turnEmphasisOf(fresh, turn, start - 1000)).toBe('past')
  })

  it('buildEmphasis 一次算出整批', () => {
    const items = [canvasItem({ id: 'a' }), canvasItem({ id: 'b' })]
    const map = buildEmphasis(items, { running: true, startedAt: 1000 }, { a: 2000, b: 500 })
    expect(map).toEqual({ a: 'current', b: 'past' })
  })
})

describe('sessionLabelOf：两舷铭牌上的会话名', () => {
  it('有标题用标题，没有就是短 id', () => {
    expect(sessionLabelOf('session-9e3e46f4-e0f3-461b', '插件升级')).toBe('插件升级')
    expect(sessionLabelOf('session-9e3e46f4-e0f3-461b')).toBe('会话 9e3e46')
    expect(sessionLabelOf('abcdef123456', null)).toBe('会话 abcdef')
  })

  it('cockpit.session 的可选 title 会被解析（老消息不带也照常）', () => {
    const origin = 'http://hub.test'
    expect(
      parseCockpitMessage(origin, origin, { type: 'cockpit.session', sessionId: 's1', title: ' 值班 ' }),
    ).toEqual({
      type: 'cockpit.session',
      sessionId: 's1',
      title: '值班',
    })
    expect(parseCockpitMessage(origin, origin, { type: 'cockpit.session', sessionId: 's1' })).toEqual({
      type: 'cockpit.session',
      sessionId: 's1',
    })
  })
})
