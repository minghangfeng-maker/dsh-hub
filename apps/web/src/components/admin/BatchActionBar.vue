<script setup lang="ts">
import { NButton } from 'naive-ui'

/**
 * 批量操作条（07 §7.2）：选中若干行后在列表底部浮现，显示已选数量与操作。
 * 固定在下沿，避免长表格里滚回去点按钮。
 */
withDefaults(
  defineProps<{
    count: number
    /** 单位文案（默认「项」） */
    unit?: string
  }>(),
  { unit: '项' },
)

const emit = defineEmits<{ clear: [] }>()
</script>

<template>
  <Transition name="batch-bar">
    <div v-if="count > 0" class="batch-bar" role="region" aria-label="批量操作">
      <span class="batch-bar__count">已选 {{ count }} {{ unit }}</span>
      <div class="batch-bar__actions">
        <slot />
      </div>
      <NButton size="small" quaternary @click="emit('clear')">取消选择</NButton>
    </div>
  </Transition>
</template>

<style scoped>
.batch-bar {
  position: sticky;
  z-index: 10;
  bottom: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--c-primary-soft);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-hover);
}

.batch-bar__count {
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
}

.batch-bar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-left: auto;
}

.batch-bar-enter-active,
.batch-bar-leave-active {
  transition:
    opacity var(--duration-base) var(--ease-out-soft),
    transform var(--duration-base) var(--ease-out-soft);
}

.batch-bar-enter-from,
.batch-bar-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
