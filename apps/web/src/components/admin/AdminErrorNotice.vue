<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed } from 'vue'

import type { ErrorDescription } from '@/api/errors'

/**
 * 页面级错误提示条：就地说明哪里出了问题 + 「重试」。
 * 文案来自 `api/errors.ts`（服务端 message 优先），这里只负责展示与重试。
 */
const props = withDefaults(
  defineProps<{
    error: ErrorDescription | null
    /** 覆盖文案（例如「实例列表加载失败」） */
    title?: string
    compact?: boolean
  }>(),
  { title: undefined, compact: false },
)

const emit = defineEmits<{ retry: [] }>()

const message = computed(() => props.error?.message ?? '')
</script>

<template>
  <div v-if="error" class="admin-error" :class="{ 'admin-error--compact': compact }" role="alert">
    <span class="i-ph-warning-circle admin-error__icon" aria-hidden="true" />
    <div class="admin-error__body">
      <p v-if="title" class="admin-error__title">{{ title }}</p>
      <p class="admin-error__message">{{ message }}</p>
    </div>
    <NButton size="small" quaternary :disabled="error.retryable === false" @click="emit('retry')">
      重试
    </NButton>
  </div>
</template>

<style scoped>
.admin-error {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--c-danger-soft);
  border-radius: var(--radius-control);
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.admin-error--compact {
  padding: var(--space-2) var(--space-3);
}

.admin-error__icon {
  flex: none;
  font-size: 18px;
}

.admin-error__body {
  min-width: 0;
  flex: 1;
}

.admin-error__title {
  font-weight: var(--fw-semibold);
}

.admin-error__message {
  color: var(--c-text-2);
}
</style>
