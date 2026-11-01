<script setup lang="ts">
import type { MyRelayModel, RelayScope, RelayUsageStatsResponse } from '@dsh-hub/shared'
import { RELAY_MAX_RANGE_DAYS } from '@dsh-hub/shared'
import {
  NDataTable,
  NDatePicker,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import ModelUsageChart from '@/components/relay/ModelUsageChart.vue'
import { formatCount } from '@/composables/useFormat'
import { clampDayRange, dayOffset, dayToTs, isDayDisabled, shanghaiToday, tsToDay } from '@/utils/relay-day'
import { formatPoints, formatTokensZh } from '@/utils/points'
import { relayScopeLabel } from '@/utils/relay-scope'
import {
  MAX_SELECTED_MODELS,
  buildUsageSeries,
  defaultSelectedModels,
  modelColorRegistry,
  modelNames as modelNamesOf,
  modelTotals,
  parseUsageQuery,
  seriesColorVar,
  toUsageQuery,
  type DailyModelRow,
  type UsageChartType,
  type UsageMetric,
  type UsageRange,
} from '@/utils/usage-series'

/**
 * 「模型消耗」整块（19 §2.2）：筛选条 + 区间合计 + 自绘多模型图 + 按模型表。
 *
 * 数据来自 `GET /api/me/relay/usage` 的 `dailyByModel`（一次拿全）：
 * **只有来源 / 区间变化才重新请求**（通过 `query` 事件交给页面），模型多选、指标、折线/堆叠、合并渠道
 * 都在前端切换。筛选状态写进查询串（刷新保持），键不与「使用记录」的 `page`/`pageSize` 冲突。
 */
const props = withDefaults(
  defineProps<{
    usage: RelayUsageStatsResponse | null
    loading?: boolean
    /** 18 §7：开通了对话模式才显示「来源」筛选 */
    showScope?: boolean
    /** 可用模型（「模型」下拉里展开 `模型@渠道` 用不到，这里只用于「模型」筛选的候选补充） */
    models?: MyRelayModel[]
  }>(),
  { loading: false, showScope: false, models: () => [] },
)

const emit = defineEmits<{
  query: [payload: { from: string; to: string; scope: RelayScope | undefined }]
}>()

const route = useRoute()
const router = useRouter()

const SOURCE_OPTIONS = [
  { label: '全部来源', value: '' },
  { label: 'DSH', value: 'dsh' },
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Codex', value: 'codex' },
]

const initial = parseUsageQuery(route.query as Record<string, unknown>)

const range = ref<UsageRange>(initial.range)
const customFrom = ref(initial.from)
const customTo = ref(initial.to)
const scope = ref<'' | RelayScope>(initial.scope)
const metric = ref<UsageMetric>(initial.metric)
const chart = ref<UsageChartType>(initial.chart)
const merge = ref(initial.merge)
/** 选中的模型（空 = 默认取积分前 5） */
const picked = ref<string[]>(initial.models)

// ── 区间计算（统计按 Asia/Shanghai 自然日，与后端一致）──────────────────────

const customRange = computed<[number, number] | null>(() =>
  customFrom.value && customTo.value ? [dayToTs(customFrom.value), dayToTs(customTo.value)] : null,
)

/** 区间（含首尾）；自定义区间不合法时收进「不晚于今天、跨度 ≤ 92 天」 */
const effective = computed<{ from: string; to: string }>(() =>
  range.value === 'custom'
    ? clampDayRange(customFrom.value, customTo.value, RELAY_MAX_RANGE_DAYS)
    : { from: dayOffset(range.value - 1), to: dayOffset(0) },
)

/** 自定义区间里不能选今天之后，也不能让跨度超过 92 天 */
function isDateDisabled(timestamp: number): boolean {
  const anchor = customRange.value
  if (!anchor) return tsToDay(timestamp) > shanghaiToday()
  const other = timestamp <= anchor[0] ? anchor[1] : anchor[0]
  return isDayDisabled(tsToDay(timestamp), tsToDay(other), RELAY_MAX_RANGE_DAYS)
}

// ── 查询串同步 ──────────────────────────────────────────────────────────────

/** 本块独占的查询串键（不与「使用记录」的 `page`/`pageSize`/`log` 冲突） */
const USAGE_KEYS = new Set(['range', 'from', 'to', 'scope', 'metric', 'chart', 'merge', 'models'])

function currentState() {
  return {
    range: range.value,
    from: range.value === 'custom' ? customFrom.value : '',
    to: range.value === 'custom' ? customTo.value : '',
    scope: scope.value,
    metric: metric.value,
    chart: chart.value,
    merge: merge.value,
    models: picked.value,
  }
}

/** 写查询串：只改自己的键，其它键（使用记录的 `page`/`log` 等）原样保留 */
function syncQuery(): void {
  const wanted = toUsageQuery(currentState())
  const others: Record<string, unknown> = {}
  const current: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (key in wanted || USAGE_KEYS.has(key)) {
      if (typeof value === 'string') current[key] = value
      continue
    }
    others[key] = value
  }
  // 键顺序不同但内容相同也算没变，避免多一次 router.replace
  const same = (a: Record<string, string>, b: Record<string, string>): boolean => {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => a[key] === b[key])
  }
  if (same(wanted, current)) return
  void router.replace({ query: { ...others, ...wanted } as never })
}

// 浏览器前进 / 后退：只认自己的键，值没变就不动
watch(
  () => route.query,
  (query) => {
    const next = parseUsageQuery(query as Record<string, unknown>)
    range.value = next.range
    customFrom.value = next.from
    customTo.value = next.to
    scope.value = next.scope
    metric.value = next.metric
    chart.value = next.chart
    merge.value = next.merge
    picked.value = next.models
  },
)

watch([range, customFrom, customTo, scope, metric, chart, merge, picked], () => {
  syncQuery()
})

// 只有来源 / 区间变化才重新请求（19 §2.2）
watch(
  [() => effective.value.from, () => effective.value.to, scope],
  () => {
    emit('query', {
      from: effective.value.from,
      to: effective.value.to,
      scope: scope.value === '' ? undefined : scope.value,
    })
  },
  { immediate: true },
)

/** 页面「刷新」时重新拉一次当前区间 */
function reload(): void {
  emit('query', {
    from: effective.value.from,
    to: effective.value.to,
    scope: scope.value === '' ? undefined : scope.value,
  })
}

defineExpose({ reload })

// ── 数据派生 ────────────────────────────────────────────────────────────────

const rows = computed<DailyModelRow[]>(() => props.usage?.dailyByModel ?? [])
const days = computed(() => (props.usage?.daily ?? []).map((bucket) => bucket.day))

const names = computed(() => modelNamesOf(rows.value, merge.value))
const totals = computed(() => modelTotals(rows.value, merge.value))

const selected = computed(() => {
  if (picked.value.length > 0) return picked.value.filter((name) => names.value.includes(name))
  return defaultSelectedModels(names.value)
})

const slots = computed(() => modelColorRegistry().slotsFor(selected.value))

const series = computed(() =>
  buildUsageSeries({
    days: days.value,
    rows: rows.value,
    mergeChannels: merge.value,
    metric: metric.value,
    selected: selected.value,
  }),
)

const modelOptions = computed(() =>
  names.value.map((name) => ({
    label: name,
    value: name,
    disabled: !selected.value.includes(name) && selected.value.length >= MAX_SELECTED_MODELS,
  })),
)

function toggleModel(name: string): void {
  if (selected.value.includes(name)) {
    picked.value = selected.value.filter((item) => item !== name)
    return
  }
  if (selected.value.length >= MAX_SELECTED_MODELS) return
  picked.value = [...selected.value, name]
}

// 合并渠道会改变模型名，「选中」状态跟着重算（回到默认的前 5）
watch(merge, () => {
  picked.value = []
})

const scopeTotal = computed(() => {
  const total = props.usage?.total
  if (!total) return ''
  return `${formatPoints(total.costMicro)} 积分 · ${formatCount(total.requests)} 次请求 · ${formatTokensZh(
    total.inputTokens + total.cacheReadTokens + total.outputTokens,
  )} token`
})

const scopeBreakdown = computed(() => {
  // 19 §2.2：开通了对话模式且「来源 = 全部」时，按来源的小标签跟在合计行下面
  if (!props.showScope || scope.value !== '') return []
  return (props.usage?.byScope ?? []).map((bucket) => ({
    scope: bucket.scope,
    label: relayScopeLabel(bucket.scope),
    costMicro: bucket.costMicro,
  }))
})

const tableTotal = computed(() => totals.value.reduce((sum, item) => sum + item.bucket.costMicro, 0))

const columns = computed<DataTableColumns<{ name: string; bucket: RelayUsageStatsResponse['total'] }>>(() => [
  {
    title: '模型',
    key: 'model',
    minWidth: 240,
    render: (row) => {
      // 没选中的模型归在图里的「其他」：色块用「其他」灰，免得和选中模型撞色
      const on = selected.value.includes(row.name)
      const color = on ? (slots.value.get(row.name) ?? { slot: 1, dashed: false }) : { slot: null, dashed: false }
      return h('span', { class: 'model-usage__name' }, [
        h('span', {
          class: 'model-usage__swatch',
          style: { background: seriesColorVar(color) },
          'data-dashed': color.dashed ? '1' : undefined,
        }),
        h('span', { class: 'model-usage__model', title: row.name }, row.name),
      ])
    },
  },
  {
    title: '请求',
    key: 'requests',
    width: 100,
    align: 'right',
    render: (row) => formatCount(row.bucket.requests),
  },
  {
    title: '输入 / 缓存 / 输出',
    key: 'tokens',
    width: 200,
    render: (row) =>
      h(
        'span',
        {
          class: 'model-usage__mono',
          title: `输入 ${formatCount(row.bucket.inputTokens)} · 缓存读 ${formatCount(
            row.bucket.cacheReadTokens,
          )} · 缓存写 ${formatCount(row.bucket.cacheWriteTokens)} · 输出 ${formatCount(row.bucket.outputTokens)}`,
        },
        `${formatTokensZh(row.bucket.inputTokens)} / ${formatTokensZh(
          row.bucket.cacheReadTokens,
        )} / ${formatTokensZh(row.bucket.outputTokens)}`,
      ),
  },
  {
    title: '积分',
    key: 'costMicro',
    width: 110,
    align: 'right',
    render: (row) => h('span', { class: 'model-usage__mono' }, formatPoints(row.bucket.costMicro)),
  },
  {
    title: '占比',
    key: 'share',
    width: 120,
    render: (row) => {
      const share = tableTotal.value > 0 ? row.bucket.costMicro / tableTotal.value : 0
      const percent = share * 100
      // 小模型不足 1% 时写「<1%」，不要显示成 0%；0 的模型不画假的 2% 小条
      const text = share <= 0 ? '0%' : percent < 1 ? '<1%' : `${String(Math.round(percent))}%`
      const width = share <= 0 ? '0' : `${String(Math.max(2, Math.round(percent)))}%`
      return h('span', { class: 'model-usage__share' }, [
        h('span', { class: 'model-usage__share-text' }, text),
        h('span', { class: 'model-usage__share-track' }, [
          h('span', { class: 'model-usage__share-fill', style: { width } }),
        ]),
      ])
    },
  },
])

const tableRows = computed(() => totals.value.map((item) => ({ name: item.name, bucket: item.bucket })))
</script>

<template>
  <div class="model-usage">
    <div class="model-usage__filters" data-testid="usage-filters">
      <div class="model-usage__filter">
        <NRadioGroup v-model:value="range" size="small" data-testid="usage-range">
          <NRadioButton :value="7">7 天</NRadioButton>
          <NRadioButton :value="30">30 天</NRadioButton>
          <NRadioButton :value="90">90 天</NRadioButton>
          <NRadioButton value="custom">自定义</NRadioButton>
        </NRadioGroup>
        <NDatePicker
          v-if="range === 'custom'"
          :value="customRange"
          type="daterange"
          size="small"
          clearable
          class="model-usage__dates"
          :is-date-disabled="isDateDisabled"
          data-testid="usage-dates"
          @update:value="
            (value: [number, number] | null) => {
              // 首尾可能分两次给（第二端暂时是 null），不能把 null 当成 1970-01-01
              customFrom = typeof value?.[0] === 'number' ? tsToDay(value[0]) : ''
              customTo = typeof value?.[1] === 'number' ? tsToDay(value[1]) : ''
            }
          "
        />
      </div>

      <NSelect
        v-if="showScope"
        v-model:value="scope"
        size="small"
        class="model-usage__scope"
        :options="SOURCE_OPTIONS"
        data-testid="usage-scope"
      />

      <NSelect
        v-model:value="picked"
        multiple
        filterable
        clearable
        size="small"
        class="model-usage__models"
        :options="modelOptions"
        :max-tag-count="2"
        placeholder="默认积分前 5"
        data-testid="usage-models"
      />

      <NRadioGroup v-model:value="metric" size="small" data-testid="usage-metric">
        <NRadioButton value="cost">积分</NRadioButton>
        <NRadioButton value="tokens">token</NRadioButton>
        <NRadioButton value="requests">请求</NRadioButton>
      </NRadioGroup>

      <NRadioGroup v-model:value="chart" size="small" data-testid="usage-chart-type">
        <NRadioButton value="line">折线</NRadioButton>
        <NRadioButton value="stack">堆叠</NRadioButton>
      </NRadioGroup>

      <label class="model-usage__merge">
        <NSwitch v-model:value="merge" size="small" data-testid="usage-merge" />
        <span>合并渠道</span>
      </label>
    </div>

    <p class="model-usage__total" data-testid="usage-total">
      <span class="model-usage__total-label">合计</span>
      <span class="model-usage__total-value">{{ scopeTotal }}</span>
      <span v-if="(usage?.total.errors ?? 0) > 0" class="model-usage__errors">
        失败 {{ formatCount(usage?.total.errors ?? 0) }}
      </span>
    </p>

    <p v-if="scopeBreakdown.length > 0" class="model-usage__breakdown" data-testid="usage-by-scope">
      <span v-for="item in scopeBreakdown" :key="item.scope" class="model-usage__breakdown-item">
        {{ item.label }} {{ formatPoints(item.costMicro) }} 积分
      </span>
    </p>

    <ModelUsageChart :days="days" :series="series" :metric="metric" :chart-type="chart" :loading="loading" />

    <NDataTable
      class="model-usage__table"
      :columns="columns"
      :data="tableRows"
      :loading="loading"
      :row-key="(row: { name: string }) => row.name"
      :scroll-x="760"
      :pagination="false"
      :row-props="
        (row: { name: string }) => ({
          class: selected.includes(row.name) ? 'model-usage__row model-usage__row--on' : 'model-usage__row',
          onClick: () => toggleModel(row.name),
        })
      "
      size="small"
      data-testid="usage-by-model"
    />
  </div>
</template>

<style scoped>
.model-usage {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.model-usage__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.model-usage__filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

/* 控件里的文字不断行（07 §2.8） */
.model-usage__filters :deep(.n-radio-button),
.model-usage__filters :deep(.n-base-selection-label),
.model-usage__merge span {
  white-space: nowrap;
}

.model-usage__dates {
  width: 260px;
}

.model-usage__scope {
  width: 120px;
}

.model-usage__models {
  width: 200px;
}

.model-usage__merge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.model-usage__total {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2) var(--space-3);
  color: var(--c-text);
  font-size: var(--fs-13);
}

.model-usage__total-label {
  color: var(--c-text-3);
}

/* 「86.07 积分 · 421 次请求」整段不断行 */
.model-usage__total-value,
.model-usage__errors {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.model-usage__errors {
  color: var(--c-danger-ink);
}

.model-usage__breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.model-usage__breakdown-item {
  white-space: nowrap;
}

.model-usage__table {
  margin-top: var(--space-2);
}

:deep(.model-usage__row) {
  cursor: pointer;
}

/* naive-ui 的底色画在 td 上，高亮也要落到 td */
:deep(.model-usage__row--on > td) {
  background-color: var(--c-primary-soft);
}

:deep(.model-usage__name) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

:deep(.model-usage__swatch) {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 3px;
}

:deep(.model-usage__swatch[data-dashed='1']) {
  border: 1px dashed var(--c-surface);
  box-shadow: 0 0 0 1px var(--c-border);
}

/* 模型名是标识符：单行省略，完整内容在 title（07 §2.8） */
:deep(.model-usage__model) {
  display: block;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.model-usage__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.model-usage__share) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

:deep(.model-usage__share-text) {
  min-width: 34px;
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-align: right;
  white-space: nowrap;
}

:deep(.model-usage__share-track) {
  display: block;
  width: 46px;
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--c-border);
}

:deep(.model-usage__share-fill) {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--c-primary);
}
</style>
