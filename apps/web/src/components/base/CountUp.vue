<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'
import { formatCount } from '@/composables/useFormat'

/**
 * 数字滚动（07 §2.5）：概览统计从 0 计到目标，600ms，requestAnimationFrame。
 * 「减少动态效果」时直接落值（H2）；组件内不做缓动以外的花活。
 */
const props = withDefaults(
  defineProps<{
    value: number
    duration?: number
    decimals?: number
    prefix?: string
    suffix?: string
    /** 千分位（默认开） */
    separator?: boolean
  }>(),
  { duration: 600, decimals: 0, prefix: '', suffix: '', separator: true },
)

const prefersReducedMotion = usePrefersReducedMotion()
const current = ref(0)
let frame: number | null = null

function stop(): void {
  if (frame !== null) {
    cancelAnimationFrame(frame)
    frame = null
  }
}

function render(value: number): string {
  const text = props.separator
    ? formatCount(value, props.decimals)
    : value.toFixed(props.decimals)
  return `${props.prefix}${text}${props.suffix}`
}

function animateTo(target: number): void {
  stop()

  if (prefersReducedMotion.value || props.duration <= 0) {
    current.value = target
    return
  }

  const from = current.value
  const startedAt = performance.now()

  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / props.duration)
    // easeOutCubic：开头快、收尾稳
    const eased = 1 - (1 - progress) ** 3
    current.value = from + (target - from) * eased

    if (progress < 1) frame = requestAnimationFrame(tick)
    else {
      current.value = target
      frame = null
    }
  }

  frame = requestAnimationFrame(tick)
}

watch(
  () => props.value,
  (next) => animateTo(next),
  { immediate: true },
)

onBeforeUnmount(stop)
</script>

<template>
  <span class="count-up" :aria-label="render(value)">{{ render(current) }}</span>
</template>

<style scoped>
.count-up {
  font-variant-numeric: tabular-nums;
}
</style>
