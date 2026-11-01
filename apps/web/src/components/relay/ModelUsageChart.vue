<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { UsageChartType, UsageMetric, UsageSeries } from '@/utils/usage-series'
import {
  OTHER_SERIES_NAME,
  axisDayLabels,
  formatMetricValue,
  niceTicks,
  seriesColorVar,
} from '@/utils/usage-series'

/**
 * 「模型消耗」自绘 SVG 图（19 §2.2）：折线 / 堆叠两种形态，一条 y 轴，
 * 十字线 + 悬停浮层（浮层夹在图内）、键盘 ←/→、图例点击显隐、≤ 4 条折线在右端直接标名。
 *
 * 不引图表库（与 `DailyUsageChart` 一致）；颜色只从 `--c-series-*` 令牌取，
 * 第 7、8 个模型复用色位并加虚线（颜色不单独承载信息，图例与下面的表始终在）。
 */
const props = withDefaults(
  defineProps<{
    /** 连续天序列（含没有用量的天） */
    days: string[]
    /** 系列（含「其他」）；由 `utils/usage-series.ts` 组装 */
    series: UsageSeries[]
    metric: UsageMetric
    chartType: UsageChartType
    loading?: boolean
  }>(),
  { loading: false },
)

const FALLBACK_WIDTH = 720
const HEIGHT_WIDE = 280
const HEIGHT_NARROW = 220

const wrapRef = ref<HTMLElement | null>(null)
const plotRef = ref<HTMLElement | null>(null)
const tipRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)

const width = ref(FALLBACK_WIDTH)
const hover = ref<number | null>(null)
const tipLeft = ref('50%')
/** 图例里被点掉的系列名 */
const hidden = ref<string[]>([])

let observer: ResizeObserver | null = null

function measure(): void {
  const wrap = wrapRef.value
  const next = wrap?.clientWidth ?? 0
  width.value = next > 0 ? next : FALLBACK_WIDTH
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'function' && wrapRef.value) {
    observer = new ResizeObserver(measure)
    observer.observe(wrapRef.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

// 换了区间 / 模型之后，旧名字的显隐状态没有意义
watch(
  () => props.series.map((item) => item.name).join('|'),
  () => {
    const names = new Set(props.series.map((item) => item.name))
    hidden.value = hidden.value.filter((name) => names.has(name))
  },
)

const height = computed(() => (width.value <= 600 ? HEIGHT_NARROW : HEIGHT_WIDE))

const visibleSeries = computed(() => props.series.filter((item) => !hidden.value.includes(item.name)))

const totalOf = (item: UsageSeries): number => item.total

const isEmpty = computed(() => props.days.length === 0 || props.series.length === 0)

/** ≤ 4 条可见折线时在右端直接标模型名（19 §2.2） */
const directLabels = computed(() => props.chartType === 'line' && visibleSeries.value.length <= 4)

const padding = computed(() => ({
  left: width.value <= 600 ? 44 : 56,
  right: directLabels.value && !isEmpty.value ? 96 : 16,
  top: 12,
  bottom: 26,
}))

const plotWidth = computed(() => Math.max(40, width.value - padding.value.left - padding.value.right))
const plotHeight = computed(() => Math.max(40, height.value - padding.value.top - padding.value.bottom))

const scale = computed(() => {
  let max = 0
  for (const item of visibleSeries.value) {
    for (const value of item.values) max = Math.max(max, value)
  }
  return niceTicks(max)
})

function xOf(index: number): number {
  const count = props.days.length
  if (count <= 0) return padding.value.left
  if (props.chartType === 'stack' || count === 1) {
    const band = plotWidth.value / Math.max(1, count)
    return padding.value.left + band * (index + 0.5)
  }
  return padding.value.left + (plotWidth.value * index) / (count - 1)
}

function yOf(value: number): number {
  const max = scale.value.max
  if (max <= 0) return padding.value.top + plotHeight.value
  return padding.value.top + plotHeight.value - (Math.max(0, value) / max) * plotHeight.value
}

function linePath(item: UsageSeries): string {
  return item.values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`)
    .join(' ')
}

interface BarSegment {
  key: string
  name: string
  color: string
  x: number
  y: number
  width: number
  height: number
  topRounded: boolean
}

/** 堆叠柱：按系列顺序自下而上，段间留 2px 表面色间隙，「其他」在最上面 */
const bars = computed<BarSegment[]>(() => {
  if (props.chartType !== 'stack' || isEmpty.value) return []
  const count = props.days.length
  const band = plotWidth.value / Math.max(1, count)
  const barWidth = Math.max(2, Math.min(24, band * 0.7))
  const list: BarSegment[] = []

  for (let index = 0; index < count; index += 1) {
    let cursor = padding.value.top + plotHeight.value
    const x = xOf(index) - barWidth / 2
    let lastDrawn: BarSegment | null = null

    for (const item of visibleSeries.value) {
      const value = item.values[index] ?? 0
      if (value <= 0) continue
      const raw = yOf(0) - yOf(value)
      const gap = lastDrawn === null ? 0 : 2
      const segmentHeight = Math.max(1, raw - gap)
      cursor -= raw
      const segment: BarSegment = {
        key: `${item.name}-${String(index)}`,
        name: item.name,
        color: seriesColorVar(item),
        x,
        y: cursor + gap,
        width: barWidth,
        height: segmentHeight,
        topRounded: false,
      }
      list.push(segment)
      lastDrawn = segment
    }

    // 柱顶（最后画的那一段）圆角 4px
    if (lastDrawn) lastDrawn.topRounded = true
  }

  return list
})

function barPath(segment: BarSegment): string {
  const radius = Math.max(0, Math.min(4, segment.width / 2, segment.height))
  const { x, y, width: w, height: h } = segment
  if (radius <= 0) return `M${x},${y} h${w} v${h} h${-w} Z`
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y} L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius} L${x + w},${y + h} Z`
}

/** 悬停那天的数据点（折线）：8px 圆点 + 2px 表面色描边 */
const hoverPoints = computed(() => {
  if (hover.value === null || props.chartType !== 'line' || isEmpty.value) return []
  const index = hover.value
  return visibleSeries.value.map((item) => ({
    key: item.name,
    cx: xOf(index),
    cy: yOf(item.values[index] ?? 0),
    color: seriesColorVar(item),
  }))
})

const hoveredDay = computed(() => (hover.value === null ? null : (props.days[hover.value] ?? null)))

/** 浮层里的行：按值降序（19 §2.2） */
const tipRows = computed(() => {
  if (hover.value === null) return []
  const index = hover.value
  return visibleSeries.value
    .map((item) => ({
      key: item.name,
      name: item.name,
      color: seriesColorVar(item),
      value: item.values[index] ?? 0,
    }))
    .sort((a, b) => b.value - a.value)
})

const tipTotal = computed(() => tipRows.value.reduce((sum, row) => sum + row.value, 0))

/** 右端直接标注（≤ 4 条时）；两条标签靠太近就整体不画，避免重叠 */
const endLabels = computed(() => {
  if (!directLabels.value || isEmpty.value || props.days.length === 0) return []
  const index = props.days.length - 1
  const rows = visibleSeries.value
    .map((item) => ({
      key: item.name,
      name: item.name,
      color: seriesColorVar(item),
      x: padding.value.left + plotWidth.value + 6,
      y: yOf(item.values[index] ?? 0),
    }))
    .sort((a, b) => a.y - b.y)

  for (let i = 1; i < rows.length; i += 1) {
    if ((rows[i]?.y ?? 0) - (rows[i - 1]?.y ?? 0) < 12) return []
  }
  return rows
})

const axisLabels = computed(() =>
  axisDayLabels(props.days, width.value <= 600 ? 5 : 7).map((entry) => ({ ...entry, x: xOf(entry.index) })),
)

/** 右端直接标注的宽度有限：超长模型名截断（完整名字在 title，图例里也有），不让它顶出卡片 */
function endLabelText(name: string): string {
  const max = width.value <= 600 ? 8 : 12
  return name.length > max ? `${name.slice(0, max)}…` : name
}

const ariaLabel = computed(() => {
  const from = props.days[0] ?? ''
  const to = props.days.at(-1) ?? ''
  const total = visibleSeries.value.reduce((sum, item) => sum + totalOf(item), 0)
  return `${from} 至 ${to}，${String(visibleSeries.value.length)} 个模型，合计 ${formatMetricValue(total, props.metric)}`
})

function isHidden(name: string): boolean {
  return hidden.value.includes(name)
}

/** 图例显隐：至少保留一条可见（19 §2.2） */
function toggleSeries(name: string): void {
  if (isHidden(name)) {
    hidden.value = hidden.value.filter((item) => item !== name)
    return
  }
  if (visibleSeries.value.length <= 1) return
  hidden.value = [...hidden.value, name]
}

/**
 * 浮层横向位置：跟在当天那列上，左右收在图内。
 * 浮层宽度按内容（07 §2.8），所以要量出宽度再夹一次，否则靠边的列会把浮层顶出卡片。
 */
function placeTip(): void {
  const plot = plotRef.value
  const tip = tipRef.value
  const index = hover.value
  if (!plot || !tip || index === null) return

  const plotRect = plot.getBoundingClientRect()
  const tipRect = tip.getBoundingClientRect()
  const center = xOf(index)
  const half = tipRect.width / 2
  const min = half + 4
  const max = Math.max(min, plotRect.width - half - 4)
  tipLeft.value = `${String(Math.round(Math.min(Math.max(center, min), max)))}px`
}

watch([hover, tipRows], () => {
  if (hover.value === null) return
  void nextTick(placeTip)
})

function onKeydown(event: KeyboardEvent): void {
  if (props.days.length === 0) return
  const last = props.days.length - 1
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    hover.value = Math.max(0, (hover.value ?? last) - 1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    hover.value = Math.min(last, (hover.value ?? -1) + 1)
  } else if (event.key === 'Escape') {
    hover.value = null
  }
}

defineExpose({ toggleSeries })
</script>

<template>
  <div ref="wrapRef" class="model-chart">
    <div v-if="isEmpty" class="model-chart__empty">这段时间还没有用量</div>

    <div v-else ref="plotRef" class="model-chart__plot" :class="{ 'model-chart__plot--loading': loading }">
      <svg
        ref="svgRef"
        class="model-chart__svg"
        :width="width"
        :height="height"
        role="img"
        :aria-label="ariaLabel"
        tabindex="0"
        @keydown="onKeydown"
        @blur="hover = null"
      >
        <!-- 网格与 y 轴刻度 -->
        <g class="model-chart__grid">
          <template v-for="tick in scale.ticks" :key="`grid-${String(tick)}`">
            <line
              :x1="padding.left"
              :x2="padding.left + plotWidth"
              :y1="yOf(tick)"
              :y2="yOf(tick)"
              class="model-chart__grid-line"
            />
            <text :x="padding.left - 6" :y="yOf(tick) + 3" text-anchor="end" class="model-chart__tick">
              {{ formatMetricValue(tick, metric) }}
            </text>
          </template>
        </g>

        <!-- 堆叠柱 -->
        <template v-if="chartType === 'stack'">
          <path
            v-for="segment in bars"
            :key="segment.key"
            :d="barPath(segment)"
            :fill="segment.color"
            opacity="0.92"
          >
            <title>{{ segment.name }}</title>
          </path>
        </template>

        <!-- 折线 -->
        <template v-else>
          <path
            v-for="item in visibleSeries"
            :key="item.name"
            :d="linePath(item)"
            class="model-chart__line"
            :stroke="seriesColorVar(item)"
            :stroke-dasharray="item.dashed ? '4 3' : undefined"
          />
        </template>

        <!-- 悬停：十字线 + 数据点 -->
        <template v-if="hover !== null">
          <line
            :x1="xOf(hover)"
            :x2="xOf(hover)"
            :y1="padding.top"
            :y2="padding.top + plotHeight"
            class="model-chart__crosshair"
          />
          <circle
            v-for="point in hoverPoints"
            :key="`point-${point.key}`"
            :cx="point.cx"
            :cy="point.cy"
            r="4"
            :fill="point.color"
            class="model-chart__point"
          />
        </template>

        <!-- 右端直接标注（≤ 4 条） -->
        <template v-for="label in endLabels" :key="`end-${label.key}`">
          <text :x="label.x" :y="label.y + 3" class="model-chart__end-label">
            {{ endLabelText(label.name) }}
            <title>{{ label.name }}</title>
          </text>
        </template>

        <!-- x 轴日期 -->
        <template v-for="label in axisLabels" :key="`axis-${label.day}`">
          <text :x="label.x" :y="height - 8" text-anchor="middle" class="model-chart__tick">
            {{ label.day.slice(5) }}
          </text>
        </template>

        <!-- 整列热区（比标记宽） -->
        <rect
          v-for="(day, index) in days"
          :key="`hit-${day}`"
          class="model-chart__hit"
          :x="
            chartType === 'stack'
              ? padding.left + (plotWidth / days.length) * index
              : xOf(index) - plotWidth / days.length / 2
          "
          :y="padding.top"
          :width="plotWidth / days.length"
          :height="plotHeight"
          @mouseenter="hover = index"
          @mouseleave="hover = null"
        />
      </svg>

      <div
        v-if="hoveredDay"
        ref="tipRef"
        class="model-chart__tip"
        :style="{ left: tipLeft }"
        aria-live="polite"
      >
        <p class="model-chart__tip-day">{{ hoveredDay }}</p>
        <p v-for="row in tipRows" :key="`tip-${row.key}`" class="model-chart__tip-row">
          <span class="model-chart__swatch" :style="{ background: row.color }" />
          <span class="model-chart__tip-name" :title="row.name">{{ row.name }}</span>
          <strong>{{ formatMetricValue(row.value, metric) }}</strong>
        </p>
        <p class="model-chart__tip-row model-chart__tip-row--total">
          <span class="model-chart__tip-name">合计</span>
          <strong>{{ formatMetricValue(tipTotal, metric) }}</strong>
        </p>
      </div>
    </div>

    <div v-if="!isEmpty" class="model-chart__legend">
      <button
        v-for="item in series"
        :key="`legend-${item.name}`"
        type="button"
        class="model-chart__legend-item"
        :class="{ 'model-chart__legend-item--off': isHidden(item.name) }"
        :aria-pressed="!isHidden(item.name)"
        :title="item.name === OTHER_SERIES_NAME ? '未选中的模型合计' : item.name"
        @click="toggleSeries(item.name)"
      >
        <span
          class="model-chart__swatch"
          :style="{ background: seriesColorVar(item) }"
          :class="{ 'model-chart__swatch--dashed': item.dashed }"
        />
        <span class="model-chart__legend-name">{{ item.name }}</span>
        <span class="model-chart__legend-total">{{ formatMetricValue(item.total, metric) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.model-chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.model-chart__plot {
  position: relative;
  min-width: 0;
}

.model-chart__plot--loading {
  opacity: 0.5;
}

.model-chart__svg {
  display: block;
  max-width: 100%;
  overflow: visible;
}

.model-chart__svg:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-control);
}

.model-chart__grid-line {
  stroke: var(--c-border);
  stroke-width: 1;
}

.model-chart__tick {
  fill: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.model-chart__line {
  fill: none;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.model-chart__crosshair {
  stroke: var(--c-text-3);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.model-chart__point {
  stroke: var(--c-surface);
  stroke-width: 2;
}

.model-chart__end-label {
  fill: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: 11px;
}

.model-chart__hit {
  fill: transparent;
  cursor: crosshair;
}

.model-chart__empty {
  display: flex;
  height: 200px;
  align-items: center;
  justify-content: center;
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.model-chart__tip {
  position: absolute;
  top: var(--space-2);
  z-index: 3;
  /* 宽度按内容，不受当天列宽限制（07 §2.8） */
  width: max-content;
  min-width: 150px;
  max-width: calc(100% - 8px);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
  box-shadow: var(--shadow-hover);
  transform: translateX(-50%);
  pointer-events: none;
}

.model-chart__tip-day {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.model-chart__tip-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.model-chart__tip-row strong {
  margin-left: auto;
  color: var(--c-text);
  font-family: var(--font-mono);
}

.model-chart__tip-row--total {
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: var(--border-width) solid var(--c-border);
}

.model-chart__tip-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-chart__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 3px;
}

/* 复用色位的模型：色块加虚线边，与图上的虚线折线对应（第二编码） */
.model-chart__swatch--dashed {
  border: 1px dashed var(--c-surface);
  box-shadow: 0 0 0 1px var(--c-border);
}

.model-chart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}

.model-chart__legend-item {
  display: inline-flex;
  max-width: 260px;
  align-items: center;
  gap: var(--space-2);
  padding: 2px 6px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  font-size: var(--fs-12);
}

.model-chart__legend-item:hover {
  background: var(--c-primary-soft);
}

.model-chart__legend-item--off {
  opacity: 0.45;
}

.model-chart__legend-name {
  overflow: hidden;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-chart__legend-total {
  color: var(--c-text-3);
  white-space: nowrap;
}
</style>
