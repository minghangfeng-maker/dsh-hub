import type { RelayUsageBucket } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  MAX_SELECTED_MODELS,
  ModelColorRegistry,
  OTHER_SERIES_NAME,
  axisDayLabels,
  bucketTokens,
  buildUsageSeries,
  dayRange,
  defaultSelectedModels,
  formatMetricValue,
  mergeChannelName,
  metricValue,
  modelNames,
  modelTotals,
  niceTicks,
  parseUsageQuery,
  seriesColorVar,
  toUsageQuery,
  type DailyModelRow,
  type UsageQueryState,
} from '@/utils/usage-series'
import { clampDayRange, daySpan, isDayDisabled, shanghaiToday, tsToDay } from '@/utils/relay-day'

/** 19 §2.2 / §3：模型消耗图的纯计算（补 0、Top-N + 其他、合并渠道、指标、刻度、颜色固定、查询串）。 */

function bucket(partial: Partial<RelayUsageBucket> = {}): RelayUsageBucket {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicro: 0,
    ...partial,
  }
}

function row(day: string, model: string, partial: Partial<RelayUsageBucket> = {}): DailyModelRow {
  return { day, model, ...bucket(partial) }
}

describe('指标取值与格式化（19 §2.2）', () => {
  it('token 口径 = 输入 + 缓存读 + 输出', () => {
    const value = bucket({ inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 999, outputTokens: 3 })
    expect(bucketTokens(value)).toBe(123)
    expect(metricValue(value, 'tokens')).toBe(123)
  })

  it('积分 / 请求各自取自己的字段', () => {
    const value = bucket({ costMicro: 12_500_000, requests: 7 })
    expect(metricValue(value, 'cost')).toBe(12_500_000)
    expect(metricValue(value, 'requests')).toBe(7)
  })

  it('格式化带单位（数字 + 单位不断行）', () => {
    expect(formatMetricValue(12_500_000, 'cost')).toBe('12.50 积分')
    expect(formatMetricValue(1_230_000, 'tokens')).toBe('123万 token')
    expect(formatMetricValue(421, 'requests')).toBe('421 次')
  })
})

describe('合并渠道（19 §2.2：按 @ 前的本名）', () => {
  it('取 @ 前的模型本名；没有 @ 的原样返回', () => {
    expect(mergeChannelName('deepseek-v4.1-flash@upstream-b')).toBe('deepseek-v4.1-flash')
    expect(mergeChannelName('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    // 只有一个 @ 时后面的渠道名丢掉；名字里本身没有 @ 的模型不受影响
    expect(mergeChannelName('m@a@b')).toBe('m')
  })

  it('modelTotals 合并同名模型，并按积分降序', () => {
    const rows = [
      row('2026-10-01', 'm@a', { costMicro: 100, requests: 1 }),
      row('2026-10-01', 'm@b', { costMicro: 200, requests: 2 }),
      row('2026-10-01', 'other', { costMicro: 50, requests: 1 }),
    ]
    expect(modelTotals(rows, false).map((item) => [item.name, item.bucket.costMicro])).toEqual([
      ['m@b', 200],
      ['m@a', 100],
      ['other', 50],
    ])
    expect(modelTotals(rows, true).map((item) => [item.name, item.bucket.costMicro, item.bucket.requests])).toEqual([
      ['m', 300, 3],
      ['other', 50, 1],
    ])
    expect(modelNames(rows, true)).toEqual(['m', 'other'])
  })

  it('默认选中 = 积分前 5', () => {
    expect(defaultSelectedModels(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(defaultSelectedModels(['a', 'b'])).toEqual(['a', 'b'])
    expect(MAX_SELECTED_MODELS).toBe(8)
  })
})

describe('补 0 成连续天序列 + Top-N 与「其他」（19 §2.2）', () => {
  const days = dayRange('2026-10-01', '2026-10-05')
  const rows = [
    row('2026-10-01', 'a', { costMicro: 100 }),
    row('2026-10-03', 'a', { costMicro: 300 }),
    row('2026-10-02', 'b', { costMicro: 200 }),
    row('2026-10-02', 'c', { costMicro: 50 }),
  ]

  it('没有用量的天补 0，长度与 days 一致', () => {
    const series = buildUsageSeries({
      days,
      rows,
      mergeChannels: false,
      metric: 'cost',
      selected: ['a'],
      registry: new ModelColorRegistry(),
    })
    expect(series).toHaveLength(2)
    expect(series[0]!.name).toBe('a')
    expect(series[0]!.values).toEqual([100, 0, 300, 0, 0])
    expect(series[0]!.total).toBe(400)
  })

  it('没选中的模型合并成「其他」，排在最后', () => {
    const series = buildUsageSeries({
      days,
      rows,
      mergeChannels: false,
      metric: 'cost',
      selected: ['a'],
      registry: new ModelColorRegistry(),
    })
    expect(series.map((item) => item.name)).toEqual(['a', OTHER_SERIES_NAME])
    const other = series[1]!
    expect(other.slot).toBeNull()
    expect(other.values).toEqual([0, 250, 0, 0, 0])
    expect(seriesColorVar(other)).toBe('var(--c-series-other)')
  })

  it('全部选中时没有「其他」；指标换 token 时取 token 口径', () => {
    const series = buildUsageSeries({
      days,
      rows,
      mergeChannels: false,
      metric: 'tokens',
      selected: ['a', 'b', 'c'],
      registry: new ModelColorRegistry(),
    })
    expect(series.map((item) => item.name)).toEqual(['a', 'b', 'c'])
    expect(series[0]!.values).toEqual([0, 0, 0, 0, 0])
  })
})

describe('颜色按模型固定（19 §2.2）', () => {
  it('色位按首次出现顺序分配，第 7 个起复用并加虚线', () => {
    const registry = new ModelColorRegistry()
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const slots = registry.slotsFor(names)
    expect([...slots.values()].map((item) => item.slot)).toEqual([1, 2, 3, 4, 5, 6, 1, 2])
    expect([...slots.values()].map((item) => item.dashed)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ])
  })

  it('筛掉一个模型后其余模型不换色', () => {
    const registry = new ModelColorRegistry()
    const before = registry.slotsFor(['a', 'b', 'c'])
    const after = registry.slotsFor(['a', 'c'])
    expect(after.get('a')).toEqual(before.get('a'))
    expect(after.get('c')).toEqual(before.get('c'))
    expect(after.get('c')!.slot).toBe(3)
  })

  it('只给选中的模型分色：新选中的取最小空位，不和已选的撞色', () => {
    const registry = new ModelColorRegistry()
    registry.slotsFor(['a', 'b', 'c', 'd', 'e', 'f'])
    // 取消 b、d，再选 g：g 取空出来的色位 2，不会和 a 同色
    const next = registry.slotsFor(['a', 'c', 'e', 'f', 'g'])
    expect(next.get('g')).toEqual({ slot: 2, dashed: false })
    expect(next.get('a')!.slot).toBe(1)
    expect(next.get('c')!.slot).toBe(3)
  })
})

describe('y 轴刻度（19 §2.2：1/2/5×10ⁿ）', () => {
  it('没有数据时只给一个 0', () => {
    expect(niceTicks(0)).toEqual({ max: 0, ticks: [0] })
  })

  it('轴顶 ≥ 数据最大值，刻度从 0 起且步长是 1/2/5×10ⁿ', () => {
    for (const value of [1, 3, 7, 42, 999, 86_070_000, 2_400_000_000]) {
      const scale = niceTicks(value)
      expect(scale.max).toBeGreaterThanOrEqual(value)
      expect(scale.ticks[0]).toBe(0)
      expect(scale.ticks.at(-1)).toBeCloseTo(scale.max, 6)
      expect(scale.ticks.length).toBeGreaterThanOrEqual(4)
      expect(scale.ticks.length).toBeLessThanOrEqual(6)
      const step = scale.ticks[1]! - scale.ticks[0]!
      const normalized = step / 10 ** Math.floor(Math.log10(step))
      expect([1, 2, 5]).toContain(Math.round(normalized))
    }
  })

  it('典型量级给到 4–6 个刻度', () => {
    expect(niceTicks(86_070_000).ticks).toEqual([0, 20_000_000, 40_000_000, 60_000_000, 80_000_000, 100_000_000])
    expect(niceTicks(42).ticks).toEqual([0, 10, 20, 30, 40, 50])
  })
})

describe('x 轴日期标签（19 §2.2：5–7 个，不重叠）', () => {
  it('按区间长度取标签，首尾一定在', () => {
    const days = dayRange('2026-09-21', '2026-10-20')
    const labels = axisDayLabels(days, 7)
    expect(labels).toHaveLength(7)
    expect(labels[0]!.day).toBe('2026-09-21')
    expect(labels.at(-1)!.day).toBe('2026-10-20')
    // 索引严格递增（不会重叠）
    const indexes = labels.map((item) => item.index)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
  })

  it('天数少于标签数时不重复', () => {
    expect(axisDayLabels(dayRange('2026-10-01', '2026-10-03'), 7)).toHaveLength(3)
  })
})

describe('查询串读写（19 §2.2）', () => {
  it('默认值不写进查询串', () => {
    const state: UsageQueryState = {
      range: 30,
      from: '',
      to: '',
      scope: '',
      metric: 'cost',
      chart: 'line',
      merge: false,
      models: [],
    }
    expect(toUsageQuery(state)).toEqual({})
  })

  it('非默认值写进查询串；自定义区间才带 from/to', () => {
    const state: UsageQueryState = {
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-20',
      scope: 'claude-code',
      metric: 'tokens',
      chart: 'stack',
      merge: true,
      models: ['a', 'b'],
    }
    expect(toUsageQuery(state)).toEqual({
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-20',
      scope: 'claude-code',
      metric: 'tokens',
      chart: 'stack',
      merge: '1',
      models: 'a,b',
    })
  })

  it('解析：非法值回落默认；models 最多 8 个', () => {
    const parsed = parseUsageQuery({
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-20',
      scope: 'nope',
      metric: 'tokens',
      chart: 'pie',
      merge: '1',
      models: 'a,b,c,d,e,f,g,h,i,j',
    })
    expect(parsed.range).toBe('custom')
    expect(parsed.scope).toBe('')
    expect(parsed.chart).toBe('line')
    expect(parsed.metric).toBe('tokens')
    expect(parsed.merge).toBe(true)
    expect(parsed.models).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  })

  it('往返：写出去再读回来是同一个状态', () => {
    const state: UsageQueryState = {
      range: 90,
      from: '',
      to: '',
      scope: 'codex',
      metric: 'requests',
      chart: 'stack',
      merge: false,
      models: ['m'],
    }
    expect(parseUsageQuery(toUsageQuery(state))).toEqual(state)
  })
})

describe('日期区间（19 §2.2 §2.5）', () => {
  it('daySpan 含首尾；clampDayRange 收进今天与最大跨度', () => {
    expect(daySpan('2026-10-01', '2026-10-03')).toBe(3)
    const clamped = clampDayRange('2020-01-01', '2030-01-01', 92)
    expect(clamped.to).toBe(shanghaiToday())
    expect(daySpan(clamped.from, clamped.to)).toBe(92)
  })

  it('超长 / 未来日期在选择器里禁用', () => {
    expect(isDayDisabled('2099-01-01', '2026-10-20', 92)).toBe(true)
    expect(isDayDisabled('2026-01-01', '2026-10-20', 92)).toBe(true)
    expect(isDayDisabled('2026-10-01', '2026-10-20', 92)).toBe(false)
  })

  it('本地时间戳与日期互转（按本地日历，不挪一天）', () => {
    const day = tsToDay(new Date(2026, 9, 20).getTime())
    expect(day).toBe('2026-10-20')
  })
})
