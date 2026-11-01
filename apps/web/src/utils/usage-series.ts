import {
  RELAY_PINNED_MODEL_SEPARATOR,
  type RelayScope,
  type RelayUsageBucket,
  type RelayUsageStatsResponse,
} from '@dsh-hub/shared'

import { formatCount } from '@/composables/useFormat'
import { formatPoints, formatTokensZh } from '@/utils/points'

/**
 * 「模型消耗」的纯计算（19 §2.2）：补 0 成连续天序列、Top-N + 「其他」、合并渠道、
 * 指标取值、y 轴刻度、颜色按模型固定、筛选状态 ↔ 查询串。
 *
 * 这里不碰 Vue / DOM，全部是可直接单测的函数；组件只负责渲染与交互。
 */

/** 图上一个格子的原始数据（`dailyByModel` 的一行） */
export type DailyModelRow = NonNullable<RelayUsageStatsResponse['dailyByModel']>[number]

/** 指标（19 §2.2）：积分 / token / 请求；token = 输入 + 缓存读 + 输出（与统计卡同口径） */
export type UsageMetric = 'cost' | 'tokens' | 'requests'
export type UsageChartType = 'line' | 'stack'

/** 未选中模型合并成的那一条（灰色，可在图例里显隐） */
export const OTHER_SERIES_NAME = '其他'

/** 类目色位数量（`--c-series-1..6`），第 7、8 个复用色位并加虚线 */
export const SERIES_SLOT_COUNT = 6

/** 最多同时选中的模型数（19 §2.2） */
export const MAX_SELECTED_MODELS = 8

/** 时间快捷档（自定义区间走 `from`/`to`） */
export type UsageRange = 7 | 30 | 90 | 'custom'

export interface UsageSeries {
  /** 展示名：模型本名，或 {@link OTHER_SERIES_NAME} */
  name: string
  /** 色位 1..6；`其他` 为 null（用 `--c-series-other`） */
  slot: number | null
  /** 复用色位（第 7 个起）→ 虚线第二编码 */
  dashed: boolean
  /** 与 `days` 等长，没有用量的天是 0 */
  values: number[]
  total: number
}

// ── 指标与格式化 ────────────────────────────────────────────────────────────

/** token 口径 = 输入 + 缓存读 + 输出（与 `RelayStatsCards` 一致） */
export function bucketTokens(bucket: RelayUsageBucket): number {
  return bucket.inputTokens + bucket.cacheReadTokens + bucket.outputTokens
}

/** 按指标取一个桶的数值 */
export function metricValue(bucket: RelayUsageBucket, metric: UsageMetric): number {
  if (metric === 'cost') return bucket.costMicro
  if (metric === 'tokens') return bucketTokens(bucket)
  return bucket.requests
}

/** 指标数值的展示文本（数字 + 单位，07 §2.8 不断行） */
export function formatMetricValue(value: number, metric: UsageMetric): string {
  if (metric === 'cost') return `${formatPoints(value)} 积分`
  if (metric === 'tokens') return `${formatTokensZh(value)} token`
  return `${formatCount(value)} 次`
}

/** 指标短名（筛选条 / 图例） */
export function metricLabel(metric: UsageMetric): string {
  return metric === 'cost' ? '积分' : metric === 'tokens' ? 'token' : '请求'
}

// ── 合并渠道与模型汇总 ──────────────────────────────────────────────────────

/** 合并渠道 = 取 `模型@渠道` 里 `@` 前的模型本名（19 §2.2） */
export function mergeChannelName(model: string): string {
  const index = model.indexOf(RELAY_PINNED_MODEL_SEPARATOR)
  return index <= 0 ? model : model.slice(0, index)
}

/** 一行的「展示用模型名」（合并渠道开关决定要不要去掉 `@slug`） */
export function displayModelName(model: string, mergeChannels: boolean): string {
  return mergeChannels ? mergeChannelName(model) : model
}

export interface ModelTotal {
  name: string
  bucket: RelayUsageBucket
}

function emptyBucket(): RelayUsageBucket {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicro: 0,
  }
}

function addBucket(target: RelayUsageBucket, source: RelayUsageBucket): RelayUsageBucket {
  return {
    requests: target.requests + source.requests,
    errors: target.errors + source.errors,
    inputTokens: target.inputTokens + source.inputTokens,
    outputTokens: target.outputTokens + source.outputTokens,
    cacheReadTokens: target.cacheReadTokens + source.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + source.cacheWriteTokens,
    costMicro: target.costMicro + source.costMicro,
  }
}

/**
 * 区间内每个模型的合计，按积分降序（相同积分按名字升序，保证顺序稳定）。
 * 合并渠道时同名模型先合并再排序。
 */
export function modelTotals(rows: DailyModelRow[], mergeChannels: boolean): ModelTotal[] {
  const totals = new Map<string, RelayUsageBucket>()
  for (const row of rows) {
    const name = displayModelName(row.model, mergeChannels)
    totals.set(name, addBucket(totals.get(name) ?? emptyBucket(), row))
  }
  return [...totals.entries()]
    .map(([name, bucket]) => ({ name, bucket }))
    .sort((a, b) => b.bucket.costMicro - a.bucket.costMicro || a.name.localeCompare(b.name))
}

/** 区间内有量的模型名（按积分降序）——下拉与图例的顺序 */
export function modelNames(rows: DailyModelRow[], mergeChannels: boolean): string[] {
  return modelTotals(rows, mergeChannels).map((item) => item.name)
}

/** 默认选中：积分前 5（19 §2.2） */
export function defaultSelectedModels(names: string[]): string[] {
  return names.slice(0, Math.min(5, names.length))
}

// ── 颜色：按模型固定 ────────────────────────────────────────────────────────

export interface SeriesColor {
  /** 1..6 */
  slot: number
  /** 该色位已被别的模型用过（第 7 个起）→ 虚线 */
  dashed: boolean
}

/**
 * 模型 → 色位的**会话内缓存**（19 §2.2）：颜色跟模型走，筛掉某个模型不会让其余模型换色。
 * 只给**当前选中**的模型分色：新选中的模型取「当前选中里还没人用」的最小色位
 * （0–5 实线，6–11 = 色位 1–6 加虚线），所以选 3 个模型时不会出现两个同色。
 */
export class ModelColorRegistry {
  private readonly assigned = new Map<string, number>()

  /** 给当前选中的模型返回各自的色位（顺序同 `models`）。 */
  slotsFor(models: string[]): Map<string, SeriesColor> {
    const used = new Set<number>()
    const picked = new Map<string, number>()
    // 先保留已有色位（与本次其他模型不冲突的），再给新来的 / 冲突的分最小空位
    for (const model of models) {
      const index = this.assigned.get(model)
      if (index !== undefined && !used.has(index)) {
        used.add(index)
        picked.set(model, index)
      }
    }
    for (const model of models) {
      if (picked.has(model)) continue
      let index = 0
      while (used.has(index)) index += 1
      used.add(index)
      picked.set(model, index)
      this.assigned.set(model, index)
    }
    const result = new Map<string, SeriesColor>()
    for (const model of models) {
      const index = picked.get(model) ?? 0
      result.set(model, { slot: (index % SERIES_SLOT_COUNT) + 1, dashed: index >= SERIES_SLOT_COUNT })
    }
    return result
  }

  reset(): void {
    this.assigned.clear()
  }
}

const registry = new ModelColorRegistry()

/** 页面会话共用的色位缓存（跨筛选保持颜色不变） */
export function modelColorRegistry(): ModelColorRegistry {
  return registry
}

/** 单测用：清空会话内缓存 */
export function resetModelColorRegistry(): void {
  registry.reset()
}

/** 取 CSS 变量名：`其他` 用灰，其余按色位 */
export function seriesColorVar(series: Pick<UsageSeries, 'slot'>): string {
  return series.slot === null ? 'var(--c-series-other)' : `var(--c-series-${String(series.slot)})`
}

// ── 系列构建 ────────────────────────────────────────────────────────────────

export interface BuildSeriesOptions {
  /** 连续天序列（后端 `daily` 的日期，含没有用量的天） */
  days: string[]
  rows: DailyModelRow[]
  mergeChannels: boolean
  metric: UsageMetric
  /** 选中的模型名（合并渠道后的名字）；未选中的合并成「其他」 */
  selected: string[]
  registry?: ModelColorRegistry
}

/**
 * 组装图上的系列：选中的模型（按 `selected` 顺序）+ 未选中的「其他」。
 * 「其他」总是排在最后（堆叠时放最上面）。
 */
export function buildUsageSeries(options: BuildSeriesOptions): UsageSeries[] {
  const { days, rows, mergeChannels, metric, selected } = options
  const registry = options.registry ?? modelColorRegistry()
  const names = modelNames(rows, mergeChannels)
  const wanted = selected.filter((name) => names.includes(name))
  const slots = registry.slotsFor(wanted)

  const dayIndex = new Map(days.map((day, index) => [day, index]))
  const byDay = new Map<string, Map<string, RelayUsageBucket>>()

  for (const row of rows) {
    const name = displayModelName(row.model, mergeChannels)
    let dayMap = byDay.get(name)
    if (!dayMap) {
      dayMap = new Map<string, RelayUsageBucket>()
      byDay.set(name, dayMap)
    }
    dayMap.set(row.day, addBucket(dayMap.get(row.day) ?? emptyBucket(), row))
  }

  const valuesFor = (name: string): number[] => {
    const values = new Array<number>(days.length).fill(0)
    const dayMap = byDay.get(name)
    if (!dayMap) return values
    for (const [day, bucket] of dayMap) {
      const index = dayIndex.get(day)
      if (index !== undefined) values[index] = metricValue(bucket, metric)
    }
    return values
  }

  const series: UsageSeries[] = wanted.map((name) => {
    const color = slots.get(name) ?? { slot: 1, dashed: false }
    const values = valuesFor(name)
    return {
      name,
      slot: color.slot,
      dashed: color.dashed,
      values,
      total: values.reduce((sum, value) => sum + value, 0),
    }
  })

  const rest = names.filter((name) => !wanted.includes(name))
  if (rest.length > 0) {
    const values = new Array<number>(days.length).fill(0)
    for (const name of rest) {
      const part = valuesFor(name)
      for (let index = 0; index < values.length; index += 1) values[index] = (values[index] ?? 0) + (part[index] ?? 0)
    }
    series.push({
      name: OTHER_SERIES_NAME,
      slot: null,
      dashed: false,
      values,
      total: values.reduce((sum, value) => sum + value, 0),
    })
  }

  return series
}

// ── y 轴刻度 ────────────────────────────────────────────────────────────────

export interface NiceScale {
  /** 轴顶（≥ 数据最大值，取整到好看的数） */
  max: number
  ticks: number[]
}

/**
 * 「好看」的刻度：步长取 1/2/5×10ⁿ，尽量给出 4–6 个刻度（含 0）。
 * 没有数据（max ≤ 0）时给一个 `[0]`。
 */
export function niceTicks(maxValue: number, targetCount = 5): NiceScale {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { max: 0, ticks: [0] }

  const magnitude = 10 ** Math.floor(Math.log10(maxValue))
  const factors = [1, 2, 5, 10]
  let best: NiceScale | null = null
  let bestScore = Number.POSITIVE_INFINITY

  // 步长在量级上下各试两档，挑刻度数最接近 targetCount 的
  for (const scale of [magnitude / 100, magnitude / 10, magnitude, magnitude * 10]) {
    for (const factor of factors) {
      const step = scale * factor
      if (step <= 0) continue
      const max = Math.ceil(maxValue / step) * step
      const count = Math.round(max / step) + 1
      if (count < 2 || count > 12) continue
      const score = count >= 4 && count <= 6 ? Math.abs(count - targetCount) : 100 + Math.abs(count - targetCount)
      if (score < bestScore) {
        bestScore = score
        const ticks: number[] = []
        for (let index = 0; index < count; index += 1) ticks.push(index * step)
        best = { max, ticks }
      }
    }
  }

  return best ?? { max: maxValue, ticks: [0, maxValue] }
}

// ── 连续天序列 ──────────────────────────────────────────────────────────────

/** 闭区间 [from, to] 的日期列表（`YYYY-MM-DD`，与后端 `relayDayRange` 同口径） */
export function dayRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`)
  const end = Date.parse(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  const days: string[] = []
  for (let time = start; time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10))
  }
  return days
}

/** x 轴最多取 7 个日期标签，且不与首尾重叠 */
export function axisDayLabels(days: string[], maxLabels = 7): { day: string; index: number }[] {
  if (days.length === 0) return []
  const count = Math.min(maxLabels, days.length)
  const indexes = new Set<number>()
  for (let slot = 0; slot < count; slot += 1) {
    indexes.add(Math.round((slot * (days.length - 1)) / Math.max(1, count - 1)))
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({ day: days[index] ?? '', index }))
}

// ── 筛选状态 ↔ 查询串 ───────────────────────────────────────────────────────

export interface UsageQueryState {
  range: UsageRange
  /** 自定义区间（`range === 'custom'` 时生效） */
  from: string
  to: string
  /** 来源筛选（空 = 全部来源） */
  scope: '' | RelayScope
  metric: UsageMetric
  chart: UsageChartType
  merge: boolean
  /** 选中的模型（空 = 用默认的积分前 5） */
  models: string[]
}

export const USAGE_QUERY_DEFAULTS: UsageQueryState = {
  range: 30,
  from: '',
  to: '',
  scope: '',
  metric: 'cost',
  chart: 'line',
  merge: false,
  models: [],
}

const SCOPES: readonly string[] = ['dsh', 'claude-code', 'codex']

function firstQueryValue(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? firstQueryValue(value[0]) : null
  if (value === null || value === undefined) return null
  return String(value)
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 查询串 → 筛选状态（只认自己的键，非法值回落默认值） */
export function parseUsageQuery(query: Record<string, unknown>): UsageQueryState {
  const state: UsageQueryState = { ...USAGE_QUERY_DEFAULTS }

  const range = firstQueryValue(query['range'])
  if (range === 'custom') state.range = 'custom'
  else if (range === '7' || range === '30' || range === '90') state.range = Number(range) as UsageRange

  const from = firstQueryValue(query['from'])
  const to = firstQueryValue(query['to'])
  if (from !== null && DAY_PATTERN.test(from)) state.from = from
  if (to !== null && DAY_PATTERN.test(to)) state.to = to

  const scope = firstQueryValue(query['scope'])
  if (scope !== null && SCOPES.includes(scope)) state.scope = scope as RelayScope

  const metric = firstQueryValue(query['metric'])
  if (metric === 'cost' || metric === 'tokens' || metric === 'requests') state.metric = metric

  const chart = firstQueryValue(query['chart'])
  if (chart === 'line' || chart === 'stack') state.chart = chart

  const merge = firstQueryValue(query['merge'])
  if (merge === '1' || merge === 'true') state.merge = true

  const models = firstQueryValue(query['models'])
  if (models !== null && models !== '') {
    state.models = models
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .slice(0, MAX_SELECTED_MODELS)
  }

  return state
}

/** 筛选状态 → 查询串（与默认值相同的键不写；自定义区间才写 `from`/`to`） */
export function toUsageQuery(state: UsageQueryState): Record<string, string> {
  const query: Record<string, string> = {}
  if (state.range !== USAGE_QUERY_DEFAULTS.range) query['range'] = String(state.range)
  if (state.range === 'custom') {
    if (state.from) query['from'] = state.from
    if (state.to) query['to'] = state.to
  }
  if (state.scope !== '') query['scope'] = state.scope
  if (state.metric !== USAGE_QUERY_DEFAULTS.metric) query['metric'] = state.metric
  if (state.chart !== USAGE_QUERY_DEFAULTS.chart) query['chart'] = state.chart
  if (state.merge) query['merge'] = '1'
  if (state.models.length > 0) query['models'] = state.models.join(',')
  return query
}
