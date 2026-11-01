<script setup lang="ts">
import type { RelayUsageBucket } from '@dsh-hub/shared'
import { computed, nextTick, ref, watch } from 'vue'

import { formatCount } from '@/composables/useFormat'
import { formatPoints, formatTokensZh } from '@/utils/points'

/**
 * 每日消耗柱状图（12 §10 第 2 条）：自绘（不引图表库），只用设计令牌颜色；
 * 悬停 / 键盘聚焦显示当天的积分、请求数与 token（精确值）。
 *
 * `daily` 必须**每天都有一项**（后端保证，见 12 §9），没有用量的日子画一根很浅的底线。
 */
type DayPoint = RelayUsageBucket & { day: string }

const props = withDefaults(defineProps<{ daily: DayPoint[]; loading?: boolean }>(), { loading: false })

const hover = ref<number | null>(null)

const peak = computed(() => Math.max(0, ...props.daily.map((point) => point.costMicro)))

function heightOf(point: DayPoint): string {
  if (peak.value <= 0) return '2px'
  const ratio = point.costMicro / peak.value
  if (point.costMicro <= 0) return '2px'
  return `${Math.max(4, Math.round(ratio * 100))}%`
}

function isZero(point: DayPoint): boolean {
  return point.costMicro <= 0
}

const hovered = computed(() => (hover.value === null ? null : (props.daily[hover.value] ?? null)))

/**
 * 提示框横向位置：跟在柱子上，但左右收在图表里。
 * 浮层宽度按内容（`width: max-content`，07 §2.8），所以要量出它的宽度再夹一次，
 * 否则靠边的柱子会把浮层顶出卡片（390 下会整页横向滚动）。
 */
const plotRef = ref<HTMLElement | null>(null)
const tipRef = ref<HTMLElement | null>(null)
const tipLeft = ref('50%')

function placeTip(): void {
  const plot = plotRef.value
  const tip = tipRef.value
  const index = hover.value
  if (!plot || !tip || index === null) return

  const plotRect = plot.getBoundingClientRect()
  const tipRect = tip.getBoundingClientRect()
  const column = plot.querySelectorAll<HTMLElement>('.daily-chart__col')[index]
  if (!column) return

  const columnRect = column.getBoundingClientRect()
  const center = columnRect.left + columnRect.width / 2 - plotRect.left
  const half = tipRect.width / 2
  const min = half + 4
  const max = Math.max(min, plotRect.width - half - 4)
  tipLeft.value = `${Math.round(Math.min(Math.max(center, min), max))}px`
}

watch([hover, hovered], () => {
  if (hover.value === null) return
  void nextTick(placeTip)
})

const axisLabels = computed(() => {
  const days = props.daily.map((point) => point.day)
  if (days.length === 0) return []
  const indexes = [0, Math.floor((days.length - 1) / 2), days.length - 1]
  return [...new Set(indexes)].map((index) => days[index] ?? '')
})

function tokenTotal(point: DayPoint): number {
  return point.inputTokens + point.cacheReadTokens + point.outputTokens
}
</script>

<template>
  <div class="daily-chart">
    <div class="daily-chart__head">
      <span class="daily-chart__title">每日消耗</span>
      <span v-if="peak > 0" class="daily-chart__peak">峰值 {{ formatPoints(peak) }} 积分</span>
      <span v-else class="daily-chart__peak">这段时间还没有用量</span>
    </div>

    <div ref="plotRef" class="daily-chart__plot" :class="{ 'daily-chart__plot--loading': loading }">
      <div class="daily-chart__bars" role="list">
        <button
          v-for="(point, index) in daily"
          :key="point.day"
          type="button"
          role="listitem"
          class="daily-chart__col"
          :aria-label="`${point.day}：${formatPoints(point.costMicro)} 积分，${formatCount(point.requests)} 次请求，${formatCount(tokenTotal(point))} token`"
          :title="`${point.day} · ${formatPoints(point.costMicro)} 积分 · ${formatCount(point.requests)} 次请求`"
          @mouseenter="hover = index"
          @mouseleave="hover = null"
          @focus="hover = index"
          @blur="hover = null"
        >
          <span
            class="daily-chart__bar"
            :class="{ 'daily-chart__bar--zero': isZero(point), 'daily-chart__bar--active': hover === index }"
            :style="{ height: heightOf(point) }"
          />
        </button>
      </div>

      <div v-if="hovered" ref="tipRef" class="daily-chart__tip" :style="{ left: tipLeft }" aria-live="polite">
        <p class="daily-chart__tip-day">{{ hovered.day }}</p>
        <p class="daily-chart__tip-row">
          <span>积分</span><strong>{{ formatPoints(hovered.costMicro) }}</strong>
        </p>
        <p class="daily-chart__tip-row">
          <span>请求</span><strong>{{ formatCount(hovered.requests) }}</strong>
        </p>
        <p class="daily-chart__tip-row">
          <span>token</span>
          <strong :title="formatCount(tokenTotal(hovered))">{{ formatTokensZh(tokenTotal(hovered)) }}</strong>
        </p>
        <p v-if="hovered.errors > 0" class="daily-chart__tip-row daily-chart__tip-row--error">
          <span>失败</span><strong>{{ formatCount(hovered.errors) }}</strong>
        </p>
      </div>
    </div>

    <div class="daily-chart__axis">
      <span v-for="label in axisLabels" :key="label">{{ label }}</span>
    </div>
  </div>
</template>

<style scoped>
.daily-chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.daily-chart__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.daily-chart__title {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.daily-chart__peak {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.daily-chart__plot {
  position: relative;
  padding-top: var(--space-2);
}

.daily-chart__plot--loading {
  opacity: 0.5;
}

.daily-chart__bars {
  display: flex;
  height: 132px;
  align-items: flex-end;
  gap: 1px;
}

.daily-chart__col {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  align-items: flex-end;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.daily-chart__bar {
  display: block;
  width: 100%;
  border-radius: 4px 4px 2px 2px;
  background: var(--c-primary);
  opacity: 0.82;
  transition: opacity var(--duration-base) var(--ease-out-soft);
}

.daily-chart__bar--zero {
  border-radius: var(--radius-pill);
  background: var(--c-border);
  opacity: 1;
}

.daily-chart__bar--active {
  background: var(--c-primary-press);
  opacity: 1;
}

.daily-chart__col:focus-visible {
  outline: none;
}

.daily-chart__col:focus-visible .daily-chart__bar {
  box-shadow: var(--focus-ring);
}

.daily-chart__tip {
  position: absolute;
  bottom: calc(100% - var(--space-2));
  z-index: 3;
  /* 宽度按内容，不受柱子宽度限制（07 §2.8） */
  width: max-content;
  min-width: 132px;
  max-width: calc(100% - 8px);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
  box-shadow: var(--shadow-hover);
  transform: translateX(-50%);
  pointer-events: none;
}

.daily-chart__tip-day {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.daily-chart__tip-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.daily-chart__tip-row strong {
  margin-left: auto;
  color: var(--c-text);
  font-family: var(--font-mono);
}

.daily-chart__tip-row--error strong {
  color: var(--c-danger-ink);
}

.daily-chart__axis {
  display: flex;
  justify-content: space-between;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
