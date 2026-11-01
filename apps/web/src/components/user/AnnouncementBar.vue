<script setup lang="ts">
import { computed } from 'vue'

import type { AnnouncementLevel } from '@dsh-hub/shared'

/**
 * 工作台顶部公告条（07 §6.1）：`announcementLevel` 决定配色。
 * 顶栏铃铛里也有一份公告（UserLayout），这里放的是「进页面第一眼能看到」的那条。
 */
const props = withDefaults(
  defineProps<{
    text: string
    level?: AnnouncementLevel
    /** 点了「知道了」之后回调（父组件写 localStorage） */
    dismissible?: boolean
    title?: string
  }>(),
  { level: 'info', dismissible: true, title: '站点公告' },
)

const emit = defineEmits<{ dismiss: [] }>()

/** 四种级别 → 边框/底色/图标（颜色只用令牌，CONTRIBUTING.md 的工程约定）。 */
const TONE = {
  info: { border: 'var(--c-sky)', background: 'var(--c-sky-soft)', icon: 'i-ph-info', ink: 'var(--c-sky)' },
  success: {
    border: 'var(--c-success)',
    background: 'var(--c-success-soft)',
    icon: 'i-ph-check-circle',
    ink: 'var(--c-success-ink)',
  },
  warning: {
    border: 'var(--c-warning)',
    background: 'var(--c-butter-soft)',
    icon: 'i-ph-warning',
    ink: 'var(--c-butter-ink)',
  },
  error: {
    border: 'var(--c-danger)',
    background: 'var(--c-danger-soft)',
    icon: 'i-ph-warning-circle',
    ink: 'var(--c-danger-ink)',
  },
} as const

const tone = computed(() => TONE[props.level] ?? TONE.info)
</script>

<template>
  <aside
    class="announcement"
    :style="{ borderColor: tone.border, background: tone.background, '--ink': tone.ink }"
    role="status"
    aria-live="polite"
  >
    <span :class="tone.icon" class="announcement__icon" aria-hidden="true" />

    <div class="announcement__body">
      <p class="announcement__title">{{ title }}</p>
      <p class="announcement__text">{{ text }}</p>
    </div>

    <button
      v-if="dismissible"
      type="button"
      class="announcement__close press"
      aria-label="关闭公告"
      @click="emit('dismiss')"
    >
      <span class="i-ph-x" aria-hidden="true" />
    </button>
  </aside>
</template>

<style scoped>
.announcement {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--c-sky);
  border-left-width: 3px;
  border-radius: var(--radius-card);
}

.announcement__icon {
  margin-top: 2px;
  color: var(--ink);
  font-size: 18px;
}

.announcement__body {
  min-width: 0;
  flex: 1;
}

.announcement__title {
  color: var(--ink);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.announcement__text {
  margin-top: 2px;
  color: var(--c-text);
  font-size: var(--fs-13);
  white-space: pre-wrap;
}

.announcement__close {
  flex: none;
  padding: var(--space-1);
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out-soft);
}

.announcement__close:hover {
  background: var(--c-surface);
}
</style>
