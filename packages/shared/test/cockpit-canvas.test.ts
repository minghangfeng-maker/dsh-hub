import { describe, expect, it } from 'vitest'
import {
  CanvasItemSchema,
  CanvasSpecSchema,
  CanvasStatsItemSchema,
  COCKPIT_TABLE_MAX_ROWS,
} from '../src/index.js'

/**
 * WP56h：画布契约的向后兼容追加（docs/24 §3）。
 *
 * 三条规则：老卡片一个字节都不用改就能 parse；新字段（donut / stats.max / stats.spark /
 * stats.data）能通过校验；越界的值仍然被拒（spark > 60 点、max <= 0、stats items > 12）。
 */
describe('chart: donut（WP56h）', () => {
  it('接受 donut：x.key 是分类名、series[0].key 是数值', () => {
    const parsed = CanvasSpecSchema.parse({
      kind: 'chart',
      chart: 'donut',
      x: { key: 'username' },
      series: [{ key: 'credits', label: '积分' }],
      unit: '积分',
      data: { source: { capability: 'relay.usage', args: { by: 'user' }, refreshSec: 120 } },
    })
    expect(parsed).toMatchObject({ kind: 'chart', chart: 'donut' })
  })

  it('老的四种 chart 仍然有效', () => {
    for (const chart of ['line', 'area', 'bar', 'stacked-bar'] as const) {
      expect(
        CanvasSpecSchema.parse({
          kind: 'chart',
          chart,
          x: { key: 'day', format: 'date' },
          series: [{ key: 'requests', label: '请求' }],
          data: { rows: [{ day: '2026-10-30', requests: 12 }] },
        }),
      ).toMatchObject({ chart })
    }
  })

  it('不认识的 chart 形态仍然被拒', () => {
    expect(() =>
      CanvasSpecSchema.parse({
        kind: 'chart',
        chart: 'pie',
        x: { key: 'day' },
        series: [{ key: 'requests', label: '请求' }],
        data: { rows: [] },
      }),
    ).toThrow()
  })
})

describe('stats: max / spark / data（WP56h）', () => {
  it('item 的可选 max 与 spark：合法值通过，收在 60 点以内', () => {
    const item = CanvasStatsItemSchema.parse({
      label: '运行实例',
      value: 5,
      max: 12,
      spark: Array.from({ length: 60 }, (_, index) => index),
    })
    expect(item.max).toBe(12)
    expect(item.spark).toHaveLength(60)

    expect(() =>
      CanvasStatsItemSchema.parse({ label: '太多点', value: 1, spark: new Array(61).fill(1) }),
    ).toThrow()
    expect(() => CanvasStatsItemSchema.parse({ label: '上限为 0', value: 1, max: 0 })).toThrow()
  })

  it('stats 卡可以没有 items、只挂 data.source（指标也能按 refreshSec 刷新）', () => {
    const parsed = CanvasSpecSchema.parse({
      kind: 'stats',
      data: { source: { capability: 'cockpit.board-vitals', args: {}, refreshSec: 15 } },
    })
    expect(parsed).toMatchObject({ kind: 'stats', items: [] })
    if (parsed.kind !== 'stats') throw new Error('应该是 stats')
    expect(parsed.data).toMatchObject({ source: { capability: 'cockpit.board-vitals' } })
  })

  it('老写法（只给 items）原样可用；items 超过 12 项仍被拒', () => {
    const parsed = CanvasSpecSchema.parse({
      kind: 'stats',
      items: [{ label: '失败', value: 3, tone: 'bad', delta: -4 }],
    })
    expect(parsed.kind === 'stats' && parsed.items).toHaveLength(1)

    expect(() =>
      CanvasSpecSchema.parse({
        kind: 'stats',
        items: Array.from({ length: 13 }, (_, index) => ({ label: `指标 ${String(index)}`, value: 1 })),
      }),
    ).toThrow()
  })

  it('stats.data 也接受 DSH 内联 rows（与表格 / 图表同一套 CanvasData）', () => {
    const parsed = CanvasSpecSchema.parse({
      kind: 'stats',
      data: { rows: [{ label: '今日请求', value: 421, spark: [1, 2, 3] }] },
    })
    expect(parsed).toMatchObject({ kind: 'stats' })
  })
})

describe('CanvasItem 里的新 spec 仍能整卡 parse', () => {
  const base = {
    id: 'board:vitals',
    sessionId: 'board',
    title: '舰况',
    pinned: false,
    order: 10,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    origin: 'hub' as const,
    placement: 'left' as const,
    size: 's' as const,
  }

  it('stats 卡（data.source）与 donut 卡都能装进 CanvasItem', () => {
    const stats = CanvasItemSchema.parse({
      ...base,
      spec: {
        kind: 'stats',
        items: [],
        data: { source: { capability: 'cockpit.board-vitals', args: {}, refreshSec: 15 } },
      },
    })
    expect(stats.spec.kind).toBe('stats')

    const donut = CanvasItemSchema.parse({
      ...base,
      spec: {
        kind: 'chart',
        chart: 'donut',
        x: { key: 'username' },
        series: [{ key: 'credits', label: '积分' }],
        data: { rows: [{ username: 'alice', credits: 1 }] },
      },
    })
    expect(donut.spec.kind).toBe('chart')
  })

  it('表格行上限常量没有变（老契约不受影响）', () => {
    expect(COCKPIT_TABLE_MAX_ROWS).toBe(2000)
  })
})
