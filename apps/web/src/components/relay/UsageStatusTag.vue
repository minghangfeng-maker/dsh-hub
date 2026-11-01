<script setup lang="ts">
import type { RelayUsageStatus } from '@dsh-hub/shared'
import { computed } from 'vue'

import { TONE_VARS, type AdminTone } from '@/components/admin/tone'

/**
 * 用量状态胶囊（12 §10）：`ok` 水绿、`aborted` 琥珀、`upstream_error` 珊瑚、`client_error` 灰；
 * 费用是按字数估算时补一个「估」小标（`estimated`）。
 */
const props = withDefaults(
  defineProps<{
    status: RelayUsageStatus
    /** 上游没回 usage、按字数估算的 */
    estimated?: boolean
    /** 悬停显示的错误详情（不脱敏由后端保证） */
    error?: string | null
    size?: 'sm' | 'md'
  }>(),
  { estimated: false, error: null, size: 'md' },
)

const TONES: Record<RelayUsageStatus, AdminTone> = {
  ok: 'success',
  aborted: 'butter',
  upstream_error: 'danger',
  client_error: 'neutral',
}

const TEXTS: Record<RelayUsageStatus, string> = {
  ok: '正常',
  aborted: '已中断',
  upstream_error: '上游错误',
  client_error: '请求错误',
}

const tone = computed(() => TONE_VARS[TONES[props.status]])
const text = computed(() => TEXTS[props.status])
</script>

<template>
  <span class="usage-status">
    <span
      class="usage-status__pill"
      :class="`usage-status__pill--${size}`"
      :style="{ '--pill-color': tone.ink, '--pill-soft': tone.soft }"
      :title="error || undefined"
      role="status"
    >
      {{ text }}
    </span>
    <span v-if="estimated" class="usage-status__estimated" title="上游没回 usage，按字数估算">估</span>
  </span>
</template>

<style scoped>
.usage-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.usage-status__pill {
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-pill);
  background: var(--pill-soft);
  color: var(--pill-color);
  font-weight: var(--fw-semibold);
  line-height: 1.5;
  white-space: nowrap;
}

.usage-status__pill--md {
  padding: 2px var(--space-3);
  font-size: var(--fs-12);
}

.usage-status__pill--sm {
  padding: 0 var(--space-2);
  font-size: var(--fs-12);
}

.usage-status__estimated {
  padding: 0 4px;
  border: var(--border-width) solid var(--c-butter);
  border-radius: var(--radius-pill);
  color: var(--c-butter-ink);
  font-size: 10px;
  line-height: 1.4;
}
</style>
