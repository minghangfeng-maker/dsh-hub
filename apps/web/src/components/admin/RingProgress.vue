<script setup lang="ts">
import { computed } from 'vue'

import { TONE_VARS, type AdminTone } from '@/components/admin/tone'

/**
 * 环形进度（07 §7.1 宿主资源）：自绘 SVG，不引图表库（07 §1）。
 * `value` 是 0–1 的比例；> 0.9 自动转琥珀、> 1 转珊瑚红（与 UsageBar 同一套阈值）。
 */
const props = withDefaults(
  defineProps<{
    value: number
    label: string
    /** 环内文字（默认百分比） */
    text?: string
    /** 环下补充说明 */
    hint?: string
    size?: number
    tone?: AdminTone
    /** 是否套用阈值变色（< 0.9 时用 `tone`） */
    threshold?: boolean
  }>(),
  { text: undefined, hint: undefined, size: 110, tone: 'primary', threshold: true },
)

const ratio = computed(() => (Number.isFinite(props.value) ? Math.max(0, props.value) : 0))
const percent = computed(() => Math.round(ratio.value * 100))

const level = computed<'normal' | 'warn' | 'over'>(() => {
  if (!props.threshold) return 'normal'
  if (ratio.value > 1) return 'over'
  if (ratio.value > 0.9) return 'warn'
  return 'normal'
})

const color = computed(() => {
  if (level.value === 'over') return TONE_VARS.danger.color
  if (level.value === 'warn') return 'var(--c-warning)'
  return TONE_VARS[props.tone].color
})

const RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const dashOffset = computed(() => CIRCUMFERENCE * (1 - Math.min(1, ratio.value)))
const centerText = computed(() => props.text ?? `${percent.value}%`)
</script>

<template>
  <figure class="ring-progress" :style="{ '--ring-color': color, '--ring-size': `${size}px` }">
    <svg class="ring-progress__svg" viewBox="0 0 100 100" role="img" :aria-label="`${label}：${centerText}`">
      <circle class="ring-progress__track" cx="50" cy="50" :r="RADIUS" />
      <circle
        class="ring-progress__fill"
        cx="50"
        cy="50"
        :r="RADIUS"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
    <span class="ring-progress__text">{{ centerText }}</span>
    <figcaption class="ring-progress__caption">
      <span class="ring-progress__label">{{ label }}</span>
      <span v-if="hint" class="ring-progress__hint">{{ hint }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.ring-progress {
  position: relative;
  display: flex;
  width: var(--ring-size);
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.ring-progress__svg {
  width: var(--ring-size);
  height: var(--ring-size);
  transform: rotate(-90deg);
}

.ring-progress__track {
  fill: none;
  stroke: var(--c-bg);
  stroke-width: 9;
}

.ring-progress__fill {
  fill: none;
  stroke: var(--ring-color);
  stroke-linecap: round;
  stroke-width: 9;
  transition: stroke-dashoffset var(--duration-base) var(--ease-out-soft);
}

.ring-progress__text {
  position: absolute;
  top: calc(var(--ring-size) / 2);
  transform: translateY(-50%);
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}

.ring-progress__caption {
  text-align: center;
}

.ring-progress__label {
  display: block;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.ring-progress__hint {
  display: block;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
