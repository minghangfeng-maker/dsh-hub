<script setup lang="ts">
import { computed } from 'vue'

/**
 * JSON 折叠展示（07 §7.10 审计详情）：原生 `<details>`，键盘可达、无额外依赖。
 * 长文本用等宽字体 + 限高滚动，避免把时间线撑开。
 */
const props = withDefaults(
  defineProps<{
    value: unknown
    label?: string
    /** 默认展开 */
    open?: boolean
    maxHeight?: number
  }>(),
  { label: '详情', open: false, maxHeight: 260 },
)

const text = computed(() => {
  if (props.value === null || props.value === undefined) return '—'
  if (typeof props.value === 'string') return props.value
  try {
    return JSON.stringify(props.value, null, 2)
  } catch {
    return String(props.value)
  }
})

const empty = computed(() => text.value === '—' || text.value === '{}' || text.value === '[]')
</script>

<template>
  <details v-if="!empty" class="json-collapse" :open="open">
    <summary class="json-collapse__summary">
      <span class="i-ph-brackets-curly" aria-hidden="true" />
      {{ label }}
    </summary>
    <pre class="json-collapse__code" :style="{ maxHeight: `${maxHeight}px` }">{{ text }}</pre>
  </details>
</template>

<style scoped>
.json-collapse {
  font-size: var(--fs-12);
}

.json-collapse__summary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: var(--radius-control);
  padding: 2px var(--space-2);
  color: var(--c-text-2);
  cursor: pointer;
  list-style: none;
}

.json-collapse__summary::-webkit-details-marker {
  display: none;
}

.json-collapse__summary:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.json-collapse__code {
  overflow: auto;
  margin-top: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
