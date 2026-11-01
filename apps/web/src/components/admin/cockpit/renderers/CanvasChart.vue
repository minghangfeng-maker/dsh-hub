<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { CanvasSpec } from '@/api/admin-cockpit'
import { formatCount } from '@/composables/useFormat'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'
import {
  axisLabelStep,
  formatCompactNumber,
  monotoneCubicPath,
  type CanvasChartSeries,
  type CanvasDonutSlice,
} from '@/utils/cockpit'
import { niceTicks } from '@/utils/usage-series'

/**
 * `chart` 卡（docs/24 §3）：自绘 SVG（不引图表库，与「模型消耗」图同一做法，docs/19 §2.2）。
 *
 * WP56h 的视觉增强（全部颜色/辉光/渐变走 `bridge-tokens.css` 令牌，组件里没有色值字面量）：
 * - 折线 / 面积：**单调三次曲线**（不过冲） + 纵向渐变面积（系列色 35% → 0%） + 2px 描边 + 轻辉光；
 *   首次渲染「描线」入场（`pathLength=1` + stroke-dashoffset，600ms），刷新时数值在 260ms 内插值
 *   过渡（不是整图重画），最后一个点上一个呼吸光点；
 * - 柱 / 堆叠柱：顶部 3px 圆角（基线以下 4px 用绘图区裁剪掉，所以底边是方的）、纵向渐变、
 *   悬停高亮 + 玻璃浮层；柱子 ≤12 根时柱顶标数值；入场从底部长出（500ms、错峰 30ms）；
 * - donut：14px 粗环、段间 2px 缝、中心总数 + 单位、图例带百分比，入场逐段扫出；
 * - 坐标轴：发丝虚线网格、等宽小号刻度、左上角单位标注、大数字紧凑显示（1.2M / 45.3K）；
 * - 悬停：竖向十字准线 + 玻璃质感浮层（列出各系列该点数值，等宽数字）；
 * - `prefers-reduced-motion: reduce`：所有入场动画关闭，直接显示终态。
 */
const props = withDefaults(
  defineProps<{
    chart: Extract<CanvasSpec, { kind: 'chart' }>['chart']
    labels: string[]
    series: CanvasChartSeries[]
    /** donut 的扇区（由 `buildCanvasDonutData` 算好；其它形态不用） */
    slices?: CanvasDonutSlice[]
    /** donut 中心的那行小字（缺省「合计」） */
    donutLabel?: string
    unit?: string
    loading?: boolean
    error?: string | null
  }>(),
  { slices: () => [], donutLabel: undefined, unit: undefined, loading: false, error: null },
)

const FALLBACK_WIDTH = 520
const HEIGHT = 200
const DONUT_HEIGHT = 168
const DONUT_THICKNESS = 14
const DONUT_GAP = 2
const TWEEN_MS = 260
const STAGGER_MS = 30

const PAD = { left: 44, right: 10, top: 12, bottom: 24 }

/** SVG 里的 id（渐变 / 滤镜 / 裁剪）全页唯一：同一页可能同时挂好几张图 */
let chartSeq = 0
const instanceId = `chart${String((chartSeq += 1))}`

const wrapRef = ref<HTMLElement | null>(null)
const width = ref(FALLBACK_WIDTH)
const hover = ref<number | null>(null)
const prefersReducedMotion = usePrefersReducedMotion()
/** 有动画类才算「动效开着」：reduced-motion 下连类都不加（测试查的就是这个） */
const motionOk = computed(() => !prefersReducedMotion.value)

let observer: ResizeObserver | null = null

function measure(): void {
  const next = wrapRef.value?.clientWidth ?? 0
  width.value = next > 0 ? next : FALLBACK_WIDTH
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'function' && wrapRef.value) {
    observer = new ResizeObserver(measure)
    observer.observe(wrapRef.value)
  }
})

const isDonut = computed(() => props.chart === 'donut')
const isEmpty = computed(() =>
  isDonut.value ? props.slices.length === 0 : props.labels.length === 0 || props.series.length === 0,
)
const stacked = computed(() => props.chart === 'stacked-bar')

// ── 数值插值（刷新时平滑过渡，不整图重画） ──────────────────────────────────

const shown = ref<number[][]>(props.series.map((entry) => entry.values.slice()))
let frame: number | null = null

function stopTween(): void {
  if (frame !== null) {
    cancelAnimationFrame(frame)
    frame = null
  }
}

function animateTo(target: number[][]): void {
  stopTween()
  const from = shown.value
  // 首帧（或从空数据到有数据）：直接落值，入场交给「描线 / 长出」动画
  if (!motionOk.value || from.length === 0 || from.length !== target.length) {
    shown.value = target
    return
  }
  const startedAt = performance.now()
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / TWEEN_MS)
    const eased = 1 - (1 - progress) ** 3
    shown.value = target.map((row, seriesIndex) =>
      row.map((value, pointIndex) => {
        const previous = from[seriesIndex]?.[pointIndex] ?? value
        return previous + (value - previous) * eased
      }),
    )
    if (progress < 1) frame = requestAnimationFrame(tick)
    else {
      shown.value = target
      frame = null
    }
  }
  frame = requestAnimationFrame(tick)
}

watch(
  () => props.series.map((entry) => entry.values),
  (next) => animateTo(next.map((values) => values.slice())),
  { deep: true },
)

onBeforeUnmount(() => {
  stopTween()
  observer?.disconnect()
  observer = null
})

/** 第几条系列的第几个点（插值后的值）。 */
function valueAt(seriesIndex: number, pointIndex: number): number {
  return shown.value[seriesIndex]?.[pointIndex] ?? 0
}

// ── 坐标系 ──────────────────────────────────────────────────────────────────

const totals = computed(() => {
  const count = props.labels.length
  const values = new Array<number>(count).fill(0)
  for (let seriesIndex = 0; seriesIndex < props.series.length; seriesIndex += 1) {
    for (let index = 0; index < count; index += 1) {
      values[index] = (values[index] ?? 0) + valueAt(seriesIndex, index)
    }
  }
  return values
})

const scale = computed(() => {
  let peak = 0
  if (stacked.value) peak = Math.max(0, ...totals.value)
  else {
    for (let seriesIndex = 0; seriesIndex < props.series.length; seriesIndex += 1) {
      for (let index = 0; index < props.labels.length; index += 1) {
        peak = Math.max(peak, valueAt(seriesIndex, index))
      }
    }
  }
  return niceTicks(peak, 4)
})

const plot = computed(() => ({
  left: PAD.left,
  top: PAD.top,
  width: Math.max(10, width.value - PAD.left - PAD.right),
  height: HEIGHT - PAD.top - PAD.bottom,
}))

function yOf(value: number): number {
  const max = scale.value.max
  if (max <= 0) return plot.value.top + plot.value.height
  return plot.value.top + plot.value.height - (value / max) * plot.value.height
}

function xOf(index: number): number {
  const count = props.labels.length
  if (count <= 1) return plot.value.left + plot.value.width / 2
  return plot.value.left + (index / (count - 1)) * plot.value.width
}

const bandWidth = computed(() => {
  const count = Math.max(1, props.labels.length)
  return plot.value.width / count
})

/** 一根柱的最大宽度：两根柱（alice / bob）时不至于胖成两个大方块 */
function barWidth(): number {
  return Math.max(1, Math.min(bandWidth.value * 0.64, 36))
}

/** 第 index 组柱子的左边界：**整组在 band 里居中**，这样柱子和 x 轴标签对得上 */
function barGroupLeft(index: number): number {
  return plot.value.left + index * bandWidth.value + (bandWidth.value - barWidth()) / 2
}

function barX(index: number): number {
  return barGroupLeft(index)
}

/** 第 index 个 band 的中心（柱状图的准线 / 标签 / 悬停点都落在这里） */
function bandCenter(index: number): number {
  return plot.value.left + (index + 0.5) * bandWidth.value
}

/** 该数据点在图上的 x：折线是逐点、柱状是 band 中心 */
function markerX(index: number): number {
  return props.chart === 'bar' || props.chart === 'stacked-bar' ? bandCenter(index) : xOf(index)
}

// ── 折线 / 面积 ─────────────────────────────────────────────────────────────

function pointsOf(seriesIndex: number): { x: number; y: number }[] {
  return props.labels.map((_, index) => ({ x: xOf(index), y: yOf(valueAt(seriesIndex, index)) }))
}

/** 单调三次曲线（不过冲）；不闭合。 */
function linePath(seriesIndex: number): string {
  return monotoneCubicPath(pointsOf(seriesIndex))
}

/** 面积：曲线 + 收口到基线（渐变填充在 defs 里） */
function areaPath(seriesIndex: number): string {
  const points = pointsOf(seriesIndex)
  if (points.length === 0) return ''
  const baseY = (plot.value.top + plot.value.height).toFixed(1)
  const first = points[0]!
  const last = points[points.length - 1]!
  return `${monotoneCubicPath(points)} L${last.x.toFixed(1)},${baseY} L${first.x.toFixed(1)},${baseY} Z`
}

const lastIndex = computed(() => props.labels.length - 1)

// ── 柱 / 堆叠柱 ─────────────────────────────────────────────────────────────

interface ChartBar {
  x: number
  y: number
  width: number
  height: number
  seriesIndex: number
  /** 属于第几个 x（错峰延迟与悬停高亮按它分组） */
  xIndex: number
  /** 只有一根柱最外面那段画圆角顶；堆叠的中间段是方的（否则段间会露出接缝） */
  roundTop: boolean
}

/** 只圆顶两角、底边平直的柱子路径（不再把矩形伸到基线下面再裁掉） */
function barPath(bar: ChartBar): string {
  const { x, y, width: w, height: h } = bar
  const r = bar.roundTop ? Math.min(3, w / 2, h) : 0
  if (r <= 0) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function stackedBars(): ChartBar[] {
  const bars: ChartBar[] = []
  const count = props.labels.length
  for (let index = 0; index < count; index += 1) {
    let offset = 0
    let lastSeries = -1
    for (let seriesIndex = 0; seriesIndex < props.series.length; seriesIndex += 1) {
      if (valueAt(seriesIndex, index) > 0) lastSeries = seriesIndex
    }
    for (let seriesIndex = 0; seriesIndex < props.series.length; seriesIndex += 1) {
      const value = valueAt(seriesIndex, index)
      if (value <= 0) continue
      const top = yOf(offset + value)
      const bottom = yOf(offset)
      bars.push({
        x: barX(index),
        y: top,
        width: barWidth(),
        // 段间留 1px 缝：堆叠柱也要看得出一层一层
        height: Math.max(0.5, bottom - top - 1),
        seriesIndex,
        xIndex: index,
        roundTop: seriesIndex === lastSeries,
      })
      offset += value
    }
  }
  return bars
}

function plainBars(): ChartBar[] {
  const bars: ChartBar[] = []
  const groups = props.series.length
  const slot = barWidth() / Math.max(1, groups)
  for (let seriesIndex = 0; seriesIndex < props.series.length; seriesIndex += 1) {
    for (let index = 0; index < props.labels.length; index += 1) {
      const bottom = yOf(0)
      const top = yOf(valueAt(seriesIndex, index))
      bars.push({
        x: barGroupLeft(index) + slot * seriesIndex,
        y: top,
        width: Math.max(1, slot - 1),
        height: Math.max(0.5, bottom - top),
        seriesIndex,
        xIndex: index,
        roundTop: true,
      })
    }
  }
  return bars
}

const bars = computed(() => (isDonut.value ? [] : stacked.value ? stackedBars() : plainBars()))

/** 柱顶数值：柱子 ≤12 根才标（多了会糊成一片）；堆叠柱标合计、单系列标各自的值。 */
const barLabels = computed(() => {
  if (props.chart !== 'bar' && props.chart !== 'stacked-bar') return []
  const count = props.labels.length
  if (count === 0 || count > 12) return []
  if (stacked.value || props.series.length === 1) {
    return props.labels.map((_, index) => {
      const value = stacked.value ? (totals.value[index] ?? 0) : valueAt(0, index)
      return {
        x: bandCenter(index),
        y: yOf(value) - 5,
        text: formatCompactNumber(value),
        xIndex: index,
      }
    })
  }
  return []
})

const labelStep = computed(() => axisLabelStep(props.labels.length, width.value <= 420 ? 4 : 6))

// ── donut ───────────────────────────────────────────────────────────────────

const donutGeometry = computed(() => {
  const radius = 58
  const circumference = 2 * Math.PI * radius
  let cursor = 0
  const arcs = props.slices.map((slice) => {
    const length = slice.value > 0 ? (slice.value / Math.max(1, donutTotal())) * circumference : 0
    const arc = {
      ...slice,
      // 段间 2px 缝；极小扇区也留一丝可见长度（0 就没有意义了）
      visible: Math.max(0, length - DONUT_GAP),
      start: cursor,
      length,
      offsetFrom: -(cursor + length),
      offsetTo: -cursor,
    }
    cursor += length
    return arc
  })
  return { radius, circumference, arcs }
})

function donutTotal(): number {
  return props.slices.reduce((sum, slice) => sum + slice.value, 0)
}

/** 每段扇区的入场动画参数（自定义属性），动效关闭时返回 undefined（不加内联样式） */
function sliceStyle(index: number): Record<string, string> | undefined {
  if (!motionOk.value) return undefined
  const arc = donutGeometry.value.arcs[index]
  if (!arc) return undefined
  return {
    '--donut-from': arc.offsetFrom.toFixed(2),
    '--donut-to': arc.offsetTo.toFixed(2),
    'animation-delay': `${String(index * 60)}ms`,
  }
}

const donutCenter = computed(() => {
  const total = donutTotal()
  return {
    total: formatCompactNumber(total),
    // 中心已经有「总数 + 单位」了，图例头再重复一次单位（积分 / 积分）就换回「合计」
    label: props.donutLabel && props.donutLabel !== props.unit ? props.donutLabel : '合计',
  }
})

// ── 悬停浮层 ────────────────────────────────────────────────────────────────

const hint = computed(() => {
  if (isDonut.value || hover.value === null) return null
  const index = hover.value
  return {
    label: props.labels[index] ?? '',
    rows: props.series.map((entry, seriesIndex) => ({
      label: entry.label,
      color: entry.color,
      value: valueAt(seriesIndex, index),
    })),
  }
})

/** 浮层靠右时往左翻，保证不超出卡片（390 宽也不产生横向滚动）。 */
const hintStyle = computed(() => {
  if (hover.value === null) return {}
  const x = markerX(hover.value)
  const flip = x > width.value * 0.6
  return flip
    ? { right: `${String(Math.max(8, width.value - x))}px` }
    : { left: `${String(Math.min(width.value - 8, x))}px` }
})

function onMove(event: MouseEvent): void {
  if (isEmpty.value || isDonut.value) return
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
  const x = event.clientX - rect.left
  const count = props.labels.length
  if (count <= 1) {
    hover.value = 0
    return
  }
  const ratio = (x - plot.value.left) / plot.value.width
  if (props.chart === 'bar' || props.chart === 'stacked-bar') {
    // 柱状图：落在哪个 band 就是哪一根
    hover.value = Math.min(count - 1, Math.max(0, Math.floor((x - plot.value.left) / bandWidth.value)))
    return
  }
  hover.value = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))))
}

function onLeave(): void {
  hover.value = null
}

const ariaLabel = computed(() => {
  if (isEmpty.value) return '画布图表：暂无数据'
  if (isDonut.value) {
    const top = props.slices[0]
    return `画布占比图：${String(props.slices.length)} 个分类，合计 ${formatCompactNumber(donutTotal())}${props.unit ?? ''}${
      top ? `，最多的是 ${top.label}（${String(top.percent)}%）` : ''
    }`
  }
  const total = totals.value.reduce((sum, value) => sum + value, 0)
  return `画布图表：${String(props.labels.length)} 个数据点，${String(props.series.length)} 个系列，合计 ${formatCount(total, 2)}${props.unit ?? ''}`
})

const valueText = (value: number): string => formatCount(value, Number.isInteger(value) ? 0 : 2)
const compact = (value: number): string => formatCompactNumber(value)
</script>

<template>
  <div ref="wrapRef" class="canvas-chart" :class="{ 'canvas-chart--motion': motionOk }">
    <p v-if="error" class="canvas-chart__error" role="alert">{{ error }}</p>
    <p v-else-if="isEmpty" class="canvas-chart__empty">
      {{ loading ? '正在读取…' : isDonut ? '没有可比较的数据' : '这段时间还没有数据' }}
    </p>

    <!-- 占比图 -->
    <div v-else-if="isDonut" class="canvas-chart__donut">
      <svg
        :width="width"
        :height="DONUT_HEIGHT"
        :viewBox="`0 0 ${width} ${DONUT_HEIGHT}`"
        role="img"
        :aria-label="ariaLabel"
        class="canvas-chart__svg canvas-chart__donut-svg"
      >
        <g :transform="`rotate(-90 ${width / 2} ${DONUT_HEIGHT / 2})`">
          <circle
            class="canvas-chart__donut-track"
            :cx="width / 2"
            :cy="DONUT_HEIGHT / 2"
            :r="donutGeometry.radius"
            fill="none"
            :stroke-width="DONUT_THICKNESS"
          />
          <circle
            v-for="(arc, index) in donutGeometry.arcs"
            :key="`slice-${String(index)}`"
            class="canvas-chart__slice"
            :class="{ 'canvas-chart__slice--sweep': motionOk }"
            :cx="width / 2"
            :cy="DONUT_HEIGHT / 2"
            :r="donutGeometry.radius"
            fill="none"
            :stroke="arc.color"
            :stroke-width="DONUT_THICKNESS"
            :stroke-dasharray="`${arc.visible.toFixed(2)} ${donutGeometry.circumference.toFixed(2)}`"
            :stroke-dashoffset="(-arc.start).toFixed(2)"
            :style="sliceStyle(index)"
          >
            <title>{{ arc.label }}：{{ compact(arc.value) }}{{ unit ?? '' }}（{{ arc.percent }}%）</title>
          </circle>
        </g>
        <text class="canvas-chart__donut-total" :x="width / 2" :y="DONUT_HEIGHT / 2 + 2" text-anchor="middle">
          {{ donutCenter.total }}{{ unit ?? '' }}
        </text>
        <text
          class="canvas-chart__donut-label"
          :x="width / 2"
          :y="DONUT_HEIGHT / 2 + 20"
          text-anchor="middle"
        >
          {{ donutCenter.label }}
        </text>
      </svg>

      <ul class="canvas-chart__legend canvas-chart__legend--donut">
        <li v-for="(slice, index) in slices" :key="`legend-${String(index)}`">
          <span class="canvas-chart__dot" :style="{ background: slice.color }" aria-hidden="true" />
          <span class="canvas-chart__legend-label" :title="slice.label">{{ slice.label }}</span>
          <span class="canvas-chart__legend-percent">{{ slice.percent }}%</span>
        </li>
      </ul>
    </div>

    <!-- 折线 / 面积 / 柱 / 堆叠柱 -->
    <template v-else>
      <svg
        :width="width"
        :height="HEIGHT"
        :viewBox="`0 0 ${width} ${HEIGHT}`"
        role="img"
        :aria-label="ariaLabel"
        class="canvas-chart__svg"
        @mousemove="onMove"
        @mouseleave="onLeave"
      >
        <defs>
          <template v-for="(entry, seriesIndex) in series" :key="`def-${String(seriesIndex)}`">
            <linearGradient :id="`${instanceId}-area-${String(seriesIndex)}`" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" :stop-color="entry.color" stop-opacity="0.35" />
              <stop offset="100%" :stop-color="entry.color" stop-opacity="0" />
            </linearGradient>
            <linearGradient :id="`${instanceId}-bar-${String(seriesIndex)}`" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" :stop-color="entry.color" stop-opacity="0.95" />
              <stop offset="100%" :stop-color="entry.color" stop-opacity="0.5" />
            </linearGradient>
            <filter
              :id="`${instanceId}-glow-${String(seriesIndex)}`"
              x="-20%"
              y="-40%"
              width="140%"
              height="180%"
            >
              <feGaussianBlur stdDeviation="2.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </template>
          <clipPath :id="`${instanceId}-plot`">
            <!-- 底边正好压在基线上：柱子向下多画的 8px 被裁掉 → 柱底是方的、柱顶是圆的 -->
            <rect :x="plot.left - 2" :y="plot.top - 8" :width="plot.width + 4" :height="plot.height + 8" />
          </clipPath>
        </defs>

        <!-- y 轴刻度与发丝虚线网格 -->
        <g class="canvas-chart__grid">
          <g v-for="tick in scale.ticks" :key="tick">
            <line :x1="plot.left" :x2="plot.left + plot.width" :y1="yOf(tick)" :y2="yOf(tick)" />
            <text :x="plot.left - 8" :y="yOf(tick) + 4" text-anchor="end">{{ compact(tick) }}</text>
          </g>
        </g>
        <text v-if="unit" class="canvas-chart__unit" :x="plot.left" :y="plot.top - 2" text-anchor="start">
          {{ unit }}
        </text>

        <!-- 折线 / 面积 -->
        <g v-if="chart === 'line' || chart === 'area'">
          <template v-if="chart === 'area'">
            <path
              v-for="(entry, seriesIndex) in series"
              :key="`${entry.label}-area`"
              class="canvas-chart__area"
              :d="areaPath(seriesIndex)"
              :fill="`url(#${instanceId}-area-${String(seriesIndex)})`"
              stroke="none"
            />
          </template>
          <path
            v-for="(entry, seriesIndex) in series"
            :key="`${entry.label}-line`"
            class="canvas-chart__line"
            :class="{ 'canvas-chart__line--draw': motionOk && !entry.dashed }"
            :d="linePath(seriesIndex)"
            :pathLength="entry.dashed ? undefined : 1"
            fill="none"
            :stroke="entry.color"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            :stroke-dasharray="entry.dashed ? '4 3' : undefined"
            :filter="`url(#${instanceId}-glow-${String(seriesIndex)})`"
          />

          <!-- 最后一个点的呼吸光点 -->
          <circle
            v-for="(entry, seriesIndex) in series"
            :key="`${entry.label}-pulse`"
            class="canvas-chart__pulse"
            :class="{ 'canvas-chart__pulse--breathe': motionOk }"
            :cx="xOf(lastIndex)"
            :cy="yOf(valueAt(seriesIndex, lastIndex))"
            r="3.5"
            :fill="entry.color"
          />

          <!-- 悬停点 -->
          <template v-if="hover !== null">
            <circle
              v-for="(entry, seriesIndex) in series"
              :key="`${entry.label}-hover`"
              class="canvas-chart__hover-dot"
              :cx="markerX(hover)"
              :cy="yOf(valueAt(seriesIndex, hover))"
              r="3"
              :fill="entry.color"
            />
          </template>
        </g>

        <!-- 柱 / 堆叠柱 -->
        <g v-else :clip-path="`url(#${instanceId}-plot)`">
          <path
            v-for="(bar, index) in bars"
            :key="`bar-${String(index)}`"
            class="canvas-chart__bar"
            :class="{
              'canvas-chart__bar--grow': motionOk,
              'canvas-chart__bar--off': hover !== null && hover !== bar.xIndex,
            }"
            :d="barPath(bar)"
            :fill="`url(#${instanceId}-bar-${String(bar.seriesIndex)})`"
            :style="motionOk ? { animationDelay: `${String(bar.xIndex * STAGGER_MS)}ms` } : undefined"
          />
        </g>

        <!-- 柱顶数值（≤12 根才标） -->
        <g v-if="barLabels.length > 0" class="canvas-chart__bar-values">
          <text
            v-for="label in barLabels"
            :key="`bar-value-${String(label.xIndex)}`"
            class="canvas-chart__bar-value"
            :class="{ 'canvas-chart__bar-value--in': motionOk }"
            :x="label.x"
            :y="label.y"
            text-anchor="middle"
          >
            {{ label.text }}
          </text>
        </g>

        <!-- x 轴标签（按宽度抽稀，不重叠） -->
        <g class="canvas-chart__axis">
          <text
            v-for="(label, index) in labels"
            v-show="index % labelStep === 0"
            :key="`x-${String(index)}`"
            :x="markerX(index)"
            :y="HEIGHT - 6"
            text-anchor="middle"
          >
            {{ label }}
          </text>
        </g>

        <!-- 悬停十字准线 -->
        <line
          v-if="hover !== null"
          class="canvas-chart__cross"
          :x1="markerX(hover)"
          :x2="markerX(hover)"
          :y1="plot.top"
          :y2="plot.top + plot.height"
        />
      </svg>

      <div v-if="hint" class="canvas-chart__tip" :style="hintStyle" role="status">
        <p class="canvas-chart__tip-title">{{ hint.label }}</p>
        <p v-for="row in hint.rows" :key="row.label" class="canvas-chart__tip-row">
          <span class="canvas-chart__dot" :style="{ background: row.color }" aria-hidden="true" />
          <span class="canvas-chart__tip-label">{{ row.label }}</span>
          <span class="canvas-chart__tip-value">{{ valueText(row.value) }}{{ unit ?? '' }}</span>
        </p>
      </div>

      <ul class="canvas-chart__legend">
        <li v-for="entry in series" :key="entry.label">
          <span class="canvas-chart__dot" :style="{ background: entry.color }" aria-hidden="true" />
          <span class="canvas-chart__legend-label" :title="entry.label">{{ entry.label }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.canvas-chart {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.canvas-chart__svg {
  display: block;
  max-width: 100%;
  overflow: visible;
}

/* 发丝虚线网格 + 等宽小号刻度 */
.canvas-chart__grid line {
  stroke: var(--c-border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.canvas-chart__grid text,
.canvas-chart__axis text,
.canvas-chart__unit {
  fill: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.canvas-chart__unit {
  fill: var(--c-sky);
  letter-spacing: 0.06em;
  opacity: 0.9;
}

.canvas-chart__cross {
  stroke: var(--b-tick);
  stroke-dasharray: 3 3;
  stroke-width: 1;
}

.canvas-chart__hover-dot {
  stroke: var(--b-panel);
  stroke-width: 1.5;
}

/* ── 柱 ── */
.canvas-chart__bar {
  transition: opacity 120ms ease-out;
}

.canvas-chart__bar--off {
  opacity: 0.45;
}

.canvas-chart__bar-value {
  fill: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

/* ── donut ── */
.canvas-chart__donut-svg {
  /* 环从中心「扫」出来，配合各段 stroke-dashoffset 的错峰动画 */
  margin: 0 auto;
}

.canvas-chart__donut-track {
  stroke: var(--b-gauge-track);
}

.canvas-chart__donut-total {
  fill: var(--c-text);
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  filter: drop-shadow(var(--b-sky-text-glow));
}

.canvas-chart__donut-label {
  fill: var(--c-text-3);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.canvas-chart__legend--donut {
  /* 占比图的图例项更紧凑：一项就是「色点 + 名字 + 百分比」，按行自然折行 */
  gap: var(--space-1) var(--space-4);
}

.canvas-chart__legend-percent {
  margin-left: 2px;
  color: var(--c-sky-ink);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-variant-numeric: tabular-nums;
}

/* ── 图例 ── */
.canvas-chart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  font-size: var(--fs-12);
}

.canvas-chart__legend li {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.canvas-chart__legend-label {
  overflow: hidden;
  color: var(--c-text-2);
  max-width: 120px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-chart__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--radius-pill);
}

/* ── 玻璃质感浮层 ── */
.canvas-chart__tip {
  position: absolute;
  top: 0;
  z-index: 2;
  display: flex;
  min-width: 120px;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--b-line-strong);
  border-radius: var(--radius-control);
  background: var(--b-glass);
  box-shadow: var(--b-glass-shadow);
  color: var(--c-text);
  font-size: var(--fs-12);
  /* 07 §2.8：浮层宽度按内容，数值永远单行 */
  width: max-content;
  max-width: 220px;
  pointer-events: none;
  backdrop-filter: var(--b-glass-blur);
}

.canvas-chart__tip-title {
  color: var(--c-text-2);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.canvas-chart__tip-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

.canvas-chart__tip-label {
  color: var(--c-text-2);
}

.canvas-chart__tip-value {
  margin-left: auto;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.canvas-chart__empty,
.canvas-chart__error {
  padding: var(--space-6) 0;
  color: var(--c-text-3);
  font-size: var(--fs-13);
  text-align: center;
}

.canvas-chart__error {
  color: var(--c-danger-ink);
}

/* ── 动效（只在「动效开着」时加类；reduced-motion 下组件里连类都没有） ── */
.canvas-chart--motion .canvas-chart__line--draw {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: chart-draw 600ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

.canvas-chart--motion .canvas-chart__bar--grow {
  transform: scaleY(0);
  transform-box: fill-box;
  transform-origin: bottom;
  animation: chart-bar-grow 500ms cubic-bezier(0.2, 0.8, 0.25, 1) both;
}

.canvas-chart--motion .canvas-chart__bar-value--in {
  opacity: 0;
  animation: chart-fade-in 240ms ease-out 460ms both;
}

.canvas-chart--motion .canvas-chart__pulse--breathe {
  animation: chart-breathe 2.4s ease-in-out infinite;
}

.canvas-chart--motion .canvas-chart__slice--sweep {
  animation: chart-donut-sweep 620ms cubic-bezier(0.3, 0.8, 0.3, 1) both;
}

@keyframes chart-draw {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes chart-bar-grow {
  from {
    transform: scaleY(0);
  }

  to {
    transform: scaleY(1);
  }
}

@keyframes chart-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes chart-breathe {
  0%,
  100% {
    opacity: 0.35;
    r: 3;
  }

  50% {
    opacity: 1;
    r: 4.5;
  }
}

@keyframes chart-donut-sweep {
  from {
    stroke-dashoffset: var(--donut-from);
  }

  to {
    stroke-dashoffset: var(--donut-to);
  }
}

/* 减少动态效果：即使父级加了 motion 类也一律关掉（双保险：类本身也不会加） */
@media (prefers-reduced-motion: reduce) {
  .canvas-chart--motion .canvas-chart__line--draw,
  .canvas-chart--motion .canvas-chart__bar--grow,
  .canvas-chart--motion .canvas-chart__bar-value--in,
  .canvas-chart--motion .canvas-chart__pulse--breathe,
  .canvas-chart--motion .canvas-chart__slice--sweep {
    animation: none;
    opacity: 1;
    transform: none;
  }
}
</style>
