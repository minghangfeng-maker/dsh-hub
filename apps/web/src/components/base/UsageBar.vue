<script setup lang="ts">
import { computed } from 'vue'

import { formatBytes, formatCount } from '@/composables/useFormat'

/**
 * 用量条（07 §6.1 底部资源条）：已用/上限 + 阈值变色。
 * 阈值：> 90% 琥珀提醒；> 100% 珊瑚红；其余主色蓝。
 */
const props = withDefaults(
  defineProps<{
    used: number
    limit: number
    /** 展示用单位：bytes 会格式化成 1.2 GB */
    unit?: 'bytes' | 'count' | 'percent'
    label?: string
    /** 只把 `label` 用于读屏，不显示在条头上（外层已有标题时用） */
    hideLabel?: boolean
    /** 隐藏右侧 `已用/上限` 文本 */
    hideText?: boolean
    size?: 'sm' | 'md'
  }>(),
  { unit: 'bytes', label: undefined, hideLabel: false, hideText: false, size: 'md' },
)

const ratio = computed(() => {
  if (!Number.isFinite(props.limit) || props.limit <= 0) return 0
  return props.used / props.limit
})

const percent = computed(() => Math.round(ratio.value * 1000) / 10)

/** 阈值：normal / warn(>90%) / over(>100%) */
const level = computed<'normal' | 'warn' | 'over'>(() => {
  if (ratio.value > 1) return 'over'
  if (ratio.value > 0.9) return 'warn'
  return 'normal'
})

const barColor = computed(() => {
  if (level.value === 'over') return 'var(--c-danger)'
  if (level.value === 'warn') return 'var(--c-warning)'
  return 'var(--c-primary)'
})

const width = computed(() => `${Math.min(100, Math.max(0, ratio.value * 100))}%`)

function formatValue(value: number): string {
  if (props.unit === 'bytes') return formatBytes(value)
  if (props.unit === 'percent') return `${Math.round(value)}%`
  return formatCount(value)
}

const usedText = computed(() => formatValue(props.used))
const limitText = computed(() => formatValue(props.limit))
</script>

<template>
  <div class="usage-bar" :class="`usage-bar--${size}`">
    <div v-if="(label && !hideLabel) || !hideText" class="usage-bar__head">
      <span v-if="label && !hideLabel" class="usage-bar__label">{{ label }}</span>
      <span v-if="!hideText" class="usage-bar__value" :class="`usage-bar__value--${level}`">
        {{ usedText }} / {{ limitText }}
      </span>
    </div>

    <div
      class="usage-bar__track"
      role="progressbar"
      :aria-valuemin="0"
      :aria-valuemax="limit"
      :aria-valuenow="used"
      :aria-label="label ?? '用量'"
    >
      <div class="usage-bar__fill" :style="{ width, background: barColor }" />
    </div>

    <span class="usage-bar__sr">{{ label ? `${label}：` : '' }}已用 {{ percent }}%</span>
  </div>
</template>

<style scoped>
.usage-bar {
  position: relative;
  width: 100%;
}

.usage-bar__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  font-size: var(--fs-12);
}

.usage-bar--md .usage-bar__head {
  font-size: var(--fs-13);
}

.usage-bar__label {
  color: var(--c-text-2);
}

.usage-bar__value {
  margin-left: auto;
  color: var(--c-text-2);
  font-family: var(--font-mono);
}

.usage-bar__value--warn {
  color: var(--c-text);
}

.usage-bar__value--over {
  color: var(--c-danger);
}

.usage-bar__track {
  height: 8px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--c-bg);
}

.usage-bar--sm .usage-bar__track {
  height: 6px;
}

.usage-bar__fill {
  height: 100%;
  border-radius: var(--radius-pill);
  transition: width var(--duration-base) var(--ease-out-soft);
}

/* 读屏可读的等价文本 */
.usage-bar__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
