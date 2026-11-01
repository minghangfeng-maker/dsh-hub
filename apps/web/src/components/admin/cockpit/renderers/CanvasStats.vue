<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import type { CanvasStatsItem } from '@/api/admin-cockpit'
import { formatCount } from '@/composables/useFormat'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'
import { monotoneCubicPath } from '@/utils/cockpit'

/**
 * `stats` 卡（docs/24 §3 `CanvasSpec`）：一行指标块。
 *
 * WP56h 的视觉增强（颜色全部走 `bridge-tokens.css` 令牌）：
 * - 大号等宽数字（28px、半粗，按 tone 色微辉光）+ 小号标签；
 * - `delta` 用 ▲ / ▼ 带色；
 * - 有 `max` 画 44px 环形仪表（细轨道 + 色弧，value/max）；
 * - 有 `spark` 画 64×20 迷你面积线；
 * - 数值变化时 400ms 滚动计数（首次渲染直接落值，不做「从 0 数上去」的假动效）；
 * - `prefers-reduced-motion: reduce`：不计数、不加动画类，直接显示终态。
 *
 * 指标可以来自 DSH 内联（`items`），也可以来自 `data.source`（`CanvasSpecView` 把 Hub 重查的
 * 每一行摊成一项）——这一个组件两种都画。
 */
const props = withDefaults(
  defineProps<{
    items: CanvasStatsItem[]
    loading?: boolean
    error?: string | null
  }>(),
  { loading: false, error: null },
)

const TONE_CLASS: Record<NonNullable<CanvasStatsItem['tone']>, string> = {
  neutral: 'canvas-stat--neutral',
  good: 'canvas-stat--good',
  warn: 'canvas-stat--warn',
  bad: 'canvas-stat--bad',
}

const COUNT_MS = 400

const prefersReducedMotion = usePrefersReducedMotion()
const motionOk = computed(() => !prefersReducedMotion.value)

/** 迷你走势的渐变 id（同一页可能有好几张指标卡） */
let statsSeq = 0
const instanceId = `stats${String((statsSeq += 1))}`

// ── 数值滚动（400ms，只在「变化时」） ──────────────────────────────────────

function numericTargets(items: CanvasStatsItem[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const item of items) {
    if (typeof item.value === 'number' && Number.isFinite(item.value)) map[item.label] = item.value
  }
  return map
}

const shown = ref<Record<string, number>>(numericTargets(props.items))
let frame: number | null = null

function stopTween(): void {
  if (frame !== null) {
    cancelAnimationFrame(frame)
    frame = null
  }
}

function animateTo(targets: Record<string, number>): void {
  stopTween()
  if (!motionOk.value) {
    shown.value = { ...targets }
    return
  }
  const from = shown.value
  const startedAt = performance.now()
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / COUNT_MS)
    const eased = 1 - (1 - progress) ** 3
    const next: Record<string, number> = {}
    for (const [label, target] of Object.entries(targets)) {
      const start = from[label] ?? target
      next[label] = start + (target - start) * eased
    }
    shown.value = next
    if (progress < 1) frame = requestAnimationFrame(tick)
    else {
      shown.value = { ...targets }
      frame = null
    }
  }
  frame = requestAnimationFrame(tick)
}

watch(
  () => numericTargets(props.items),
  (next) => animateTo(next),
  { deep: true },
)

onBeforeUnmount(stopTween)

// ── 每项的派生数据 ──────────────────────────────────────────────────────────

interface StatBlock {
  key: string
  label: string
  unit?: string
  toneClass: string
  /** 显示用的数字文本（数字走插值，字符串原样） */
  valueText: string
  /** 环形仪表：0–1（没有 max 时为 null） */
  gaugeRatio: number | null
  /** 迷你走势的点（没有 spark 时为空数组） */
  sparkPath: string
  sparkArea: string
  deltaText: string | null
  deltaDir: 'up' | 'down' | null
}

function sparkGeometry(values: number[]): { line: string; area: string } {
  if (values.length === 0) return { line: '', area: '' }
  const width = 64
  const height = 20
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const points = values.map((value, index) => ({
    x: values.length === 1 ? width / 2 : (index / (values.length - 1)) * width,
    // span 为 0（全平）时画在中间，不要贴边
    y: span === 0 ? height / 2 : height - 2 - ((value - min) / span) * (height - 4),
  }))
  const line = monotoneCubicPath(points)
  const first = points[0]!
  const last = points[points.length - 1]!
  const area = line
    ? `${line} L${last.x.toFixed(1)},${String(height)} L${first.x.toFixed(1)},${String(height)} Z`
    : ''
  return { line, area }
}

const blocks = computed<StatBlock[]>(() =>
  props.items.map((item, index) => {
    const numeric = typeof item.value === 'number' && Number.isFinite(item.value)
    const display = numeric ? (shown.value[item.label] ?? (item.value as number)) : null
    const decimals = numeric && !Number.isInteger(item.value) ? 2 : 0
    const spark = item.spark && item.spark.length > 0 ? sparkGeometry(item.spark) : null
    const delta = typeof item.delta === 'number' ? item.delta : null
    return {
      key: `${item.label}-${String(index)}`,
      label: item.label,
      unit: item.unit,
      toneClass: TONE_CLASS[item.tone ?? 'neutral'],
      valueText: display === null ? String(item.value) : formatCount(display, decimals),
      gaugeRatio:
        typeof item.max === 'number' && item.max > 0 && display !== null
          ? Math.min(1, Math.max(0, display / item.max))
          : null,
      sparkPath: spark?.line ?? '',
      sparkArea: spark?.area ?? '',
      // 环比为 0 就不显示（没有方向，画一个 ▲0% 反而误导）
      deltaText: delta === null || delta === 0 ? null : `${delta > 0 ? '+' : ''}${String(delta)}%`,
      deltaDir: delta === null || delta === 0 ? null : delta > 0 ? 'up' : 'down',
    }
  }),
)

/** 环形仪表：r=18 的圆，用 dasharray 表示比例 */
const GAUGE_RADIUS = 18
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS

function gaugeDash(ratio: number): string {
  const filled = ratio * GAUGE_CIRCUMFERENCE
  return `${filled.toFixed(2)} ${GAUGE_CIRCUMFERENCE.toFixed(2)}`
}

const isEmpty = computed(() => props.items.length === 0)

/**
 * 列数按指标个数定，不用 auto-fit（auto-fit 在舷宽 ~450px 时会排成 3+1，第四个孤零零掉下去）：
 * 窄（卡宽 < 560px）：3 个排一行，其余两列（4 个 = 2×2）；宽：一行最多 4 个。
 */
const gridVars = computed(() => {
  const n = Math.max(1, blocks.value.length)
  return {
    '--stat-cols': String(n === 3 ? 3 : Math.min(n, 2)),
    '--stat-cols-wide': String(Math.min(n, 4)),
  }
})
</script>

<template>
  <div class="canvas-stats-wrap">
    <div class="canvas-stats" :class="{ 'canvas-stats--motion': motionOk }" :style="gridVars">
      <p v-if="error" class="canvas-stats__error" role="alert">{{ error }}</p>
      <p v-else-if="isEmpty" class="canvas-stats__empty">
        {{ loading ? '正在读取…' : '暂无指标' }}
      </p>

      <template v-else>
        <div v-for="block in blocks" :key="block.key" class="canvas-stat" :class="block.toneClass">
          <div class="canvas-stat__main">
            <!-- 环形仪表（有 max 才画） -->
            <svg
              v-if="block.gaugeRatio !== null"
              class="canvas-stat__gauge"
              width="44"
              height="44"
              viewBox="0 0 44 44"
              aria-hidden="true"
            >
              <circle class="canvas-stat__gauge-track" cx="22" cy="22" :r="GAUGE_RADIUS" fill="none" />
              <circle
                class="canvas-stat__gauge-arc"
                cx="22"
                cy="22"
                :r="GAUGE_RADIUS"
                fill="none"
                :stroke-dasharray="gaugeDash(block.gaugeRatio)"
                transform="rotate(-90 22 22)"
              />
            </svg>

            <div class="canvas-stat__text">
              <p class="canvas-stat__label">{{ block.label }}</p>
              <p class="canvas-stat__value">
                <span class="canvas-stat__number">{{ block.valueText }}</span>
                <span v-if="block.unit" class="canvas-stat__unit">{{ block.unit }}</span>
              </p>
            </div>
          </div>

          <div class="canvas-stat__foot">
            <p
              v-if="block.deltaText"
              class="canvas-stat__delta"
              :class="`canvas-stat__delta--${block.deltaDir}`"
            >
              <span class="canvas-stat__arrow" aria-hidden="true">{{
                block.deltaDir === 'down' ? '▼' : '▲'
              }}</span>
              {{ block.deltaText }}
            </p>

            <!-- 迷你走势（有 spark 才画） -->
            <svg
              v-if="block.sparkPath"
              class="canvas-stat__spark"
              width="64"
              height="20"
              viewBox="0 0 64 20"
              aria-hidden="true"
            >
              <defs>
                <linearGradient :id="`${instanceId}-spark`" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="currentColor" stop-opacity="0.35" />
                  <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
                </linearGradient>
              </defs>
              <path :d="block.sparkArea" :fill="`url(#${instanceId}-spark)`" stroke="none" />
              <path class="canvas-stat__spark-line" :d="block.sparkPath" fill="none" stroke="currentColor" />
            </svg>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.canvas-stats-wrap {
  container-type: inline-size;
}

.canvas-stats {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(var(--stat-cols, 2), minmax(0, 1fr));
}

@container (min-width: 560px) {
  .canvas-stats {
    grid-template-columns: repeat(var(--stat-cols-wide, 4), minmax(0, 1fr));
  }
}

.canvas-stat {
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-bg);
}

.canvas-stat__main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.canvas-stat__text {
  min-width: 0;
}

.canvas-stat__label {
  overflow: hidden;
  color: var(--c-text-2);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-stat__value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 2px;
  /* 07 §2.8：数字与单位不从中间断开 */
  white-space: nowrap;
}

.canvas-stat__number {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  text-shadow: var(--b-stat-glow-neutral);
}

.canvas-stat__unit {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.canvas-stat__foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.canvas-stat__delta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--fs-12);
  /* 数值变化时，delta 跟着浮一下（reduced-motion 下没有这个类） */
  white-space: nowrap;
}

.canvas-stat__arrow {
  font-size: 9px;
}

.canvas-stat__delta--up {
  color: var(--c-success-ink);
}

.canvas-stat__delta--down {
  color: var(--c-danger-ink);
}

/* ── 环形仪表：细轨道 + 色弧 ── */
.canvas-stat__gauge {
  flex: none;
}

.canvas-stat__gauge-track {
  stroke: var(--b-gauge-track);
  stroke-width: 4;
}

.canvas-stat__gauge-arc {
  stroke: var(--c-primary);
  stroke-width: 4;
  stroke-linecap: round;
  transition: stroke-dasharray 400ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* ── 迷你走势 ── */
.canvas-stat__spark {
  flex: none;
  margin-left: auto;
  color: var(--c-sky);
  overflow: visible;
}

.canvas-stat__spark-line {
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 语义色调只影响数字 / 仪表 / 走势（文字对比度用 -ink 令牌，07 §2.1） */
.canvas-stat--good .canvas-stat__number {
  color: var(--c-success-ink);
  text-shadow: var(--b-stat-glow-good);
}

.canvas-stat--good .canvas-stat__gauge-arc {
  stroke: var(--c-success);
}

.canvas-stat--good .canvas-stat__spark {
  color: var(--c-success);
}

.canvas-stat--warn .canvas-stat__number {
  color: var(--c-butter-ink);
  text-shadow: var(--b-stat-glow-warn);
}

.canvas-stat--warn .canvas-stat__gauge-arc {
  stroke: var(--c-warning);
}

.canvas-stat--warn .canvas-stat__spark {
  color: var(--c-warning);
}

.canvas-stat--bad .canvas-stat__number {
  color: var(--c-danger-ink);
  text-shadow: var(--b-stat-glow-bad);
}

.canvas-stat--bad .canvas-stat__gauge-arc {
  stroke: var(--c-danger);
}

.canvas-stat--bad .canvas-stat__spark {
  color: var(--c-danger);
}

.canvas-stats__empty,
.canvas-stats__error {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-align: center;
}

.canvas-stats__error {
  color: var(--c-danger-ink);
}

@media (prefers-reduced-motion: reduce) {
  /* 双保险：计数在 JS 里已经直接落值，这里再关掉仪表弧的过渡 */
  .canvas-stat__gauge-arc {
    transition: none;
  }
}
</style>
