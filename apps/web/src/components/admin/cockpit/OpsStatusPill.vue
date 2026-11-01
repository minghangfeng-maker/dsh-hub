<script setup lang="ts">
import { NButton, NPopover } from 'naive-ui'
import { computed } from 'vue'

import type { OpsStatus } from '@/api/admin-cockpit'
import { TONE_VARS } from '@/components/admin/tone'
import { opsStatusHint, opsStatusMeta } from '@/utils/cockpit'

/**
 * 顶栏「座舱 DSH 状态胶囊」（docs/24 §1、§8 I6）：
 * 停着 / 模型不可用时也要能一眼看出来（点开看原因，并可点「重启座舱」）。
 */
const props = withDefaults(defineProps<{ status: OpsStatus | null; busy?: boolean }>(), {
  busy: false,
})

const emit = defineEmits<{ restart: [] }>()

const meta = computed(() => opsStatusMeta(props.status))
const tone = computed(() => TONE_VARS[meta.value.tone])
const hint = computed(() => opsStatusHint(props.status))
const canRestart = computed(() => props.status?.instance !== 'starting')
</script>

<template>
  <NPopover trigger="click" placement="bottom-start" :show-arrow="false" raw>
    <template #trigger>
      <button
        type="button"
        class="ops-pill press"
        :style="{ '--pill-color': tone.color, '--pill-soft': tone.soft, '--pill-ink': tone.ink }"
        :aria-label="`座舱 DSH 状态：${meta.text}`"
      >
        <span class="ops-pill__dot" :class="{ 'ops-pill__dot--spin': meta.spinning }" aria-hidden="true" />
        <span class="ops-pill__text">座舱 DSH · {{ meta.text }}</span>
        <span v-if="status?.model" class="ops-pill__model">{{ status.model }}</span>
        <span class="i-ph-caret-down ops-pill__caret" aria-hidden="true" />
      </button>
    </template>

    <div class="ops-pop">
      <p class="ops-pop__hint">{{ hint }}</p>
      <div class="ops-pop__actions">
        <NButton size="small" :disabled="busy || !canRestart" :loading="busy" @click="emit('restart')">
          重启座舱
        </NButton>
        <RouterLink to="/admin/settings" class="hub-link ops-pop__link">座舱设置</RouterLink>
      </div>
    </div>
  </NPopover>
</template>

<style scoped>
.ops-pill {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: var(--space-2);
  padding: 4px var(--space-3);
  border: var(--border-width) solid var(--pill-soft);
  border-radius: var(--radius-pill);
  background: var(--pill-soft);
  color: var(--pill-ink);
  cursor: pointer;
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  /* 07 §2.8：状态胶囊不从中间断开 */
  white-space: nowrap;
}

.ops-pill:hover {
  border-color: var(--pill-color);
}

.ops-pill__dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: var(--radius-pill);
  background: var(--pill-color);
}

.ops-pill__dot--spin {
  animation: ops-pill-pulse 1.4s var(--ease-out-soft) infinite;
}

.ops-pill__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ops-pill__model {
  max-width: 160px;
  overflow: hidden;
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-weight: var(--fw-normal);
  text-overflow: ellipsis;
}

.ops-pill__caret {
  color: var(--pill-ink);
  font-size: 12px;
  opacity: 0.7;
}

.ops-pop {
  width: 280px;
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
  box-shadow: var(--shadow-hover);
}

.ops-pop__hint {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  overflow-wrap: anywhere;
}

.ops-pop__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.ops-pop__link {
  font-size: var(--fs-12);
}

/* 窄屏：模型名先让位，胶囊只留状态（顶栏本来就被三个按钮挤） */
@media (max-width: 1099px) {
  .ops-pill__model {
    display: none;
  }
}

@keyframes ops-pill-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ops-pill__dot--spin {
    animation: none;
  }
}
</style>
