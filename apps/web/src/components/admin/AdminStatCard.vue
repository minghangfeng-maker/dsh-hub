<script setup lang="ts">
import { computed } from 'vue'

import CountUp from '@/components/base/CountUp.vue'
import { TONE_VARS, type AdminTone } from '@/components/admin/tone'

/**
 * 概览统计卡（07 §7.1 第一行）：图标 + 标签 + 计数动画 + 副标题。
 * 数字用 `<CountUp>`（600ms，减少动态效果时直接落值）。
 */
const props = withDefaults(
  defineProps<{
    label: string
    value: number
    /** 副标题（例如「今日 +3」） */
    hint?: string
    icon?: string
    tone?: AdminTone
    /** 点击跳转 */
    to?: string
    /** 值后面跟的单位（如 `/ 12`） */
    suffix?: string
  }>(),
  { hint: undefined, icon: 'i-ph-chart-line', tone: 'primary', to: undefined, suffix: '' },
)

const tone = computed(() => TONE_VARS[props.tone])
</script>

<template>
  <component
    :is="to ? 'RouterLink' : 'div'"
    :to="to"
    class="stat-card lift"
    :class="{ 'stat-card--link': Boolean(to) }"
    :style="{ '--tone-color': tone.color, '--tone-soft': tone.soft, '--tone-ink': tone.ink }"
  >
    <span class="stat-card__icon" :class="icon" aria-hidden="true" />
    <div class="stat-card__body">
      <p class="stat-card__label">{{ label }}</p>
      <p class="stat-card__value">
        <CountUp :value="value" />
        <span v-if="suffix" class="stat-card__suffix">{{ suffix }}</span>
      </p>
      <p v-if="hint" class="stat-card__hint">{{ hint }}</p>
    </div>
  </component>
</template>

<style scoped>
.stat-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

.stat-card--link {
  color: inherit;
}

.stat-card__icon {
  display: inline-flex;
  width: 40px;
  height: 40px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  background: var(--tone-soft);
  color: var(--tone-color);
  font-size: 20px;
}

.stat-card__body {
  min-width: 0;
}

.stat-card__label {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.stat-card__value {
  color: var(--c-text);
  font-size: var(--fs-24);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}

.stat-card__suffix {
  margin-left: var(--space-1);
  color: var(--c-text-3);
  font-size: var(--fs-14);
  font-weight: var(--fw-normal);
}

.stat-card__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
