<script setup lang="ts">
import { computed } from 'vue'

/**
 * 任务进度条（07 §7.9）：成功水绿 + 失败珊瑚红叠加在浅底上，右侧 `done/total`。
 * `failed` 段从成功段之后接着画，运行中的剩余部分留白。
 */
const props = withDefaults(
  defineProps<{
    total: number
    done: number
    failed: number
    /** 是否显示右侧数字 */
    showText?: boolean
    size?: 'sm' | 'md'
  }>(),
  { showText: true, size: 'md' },
)

const safeTotal = computed(() => Math.max(props.total, 0))
const succeeded = computed(() => Math.max(0, props.done - props.failed))
const percent = (value: number): string =>
  safeTotal.value === 0 ? '0%' : `${(value / safeTotal.value) * 100}%`

const label = computed(() => (safeTotal.value === 0 ? '—' : `${props.done} / ${props.total}`))
</script>

<template>
  <div class="job-progress" :class="`job-progress--${size}`">
    <span
      class="job-progress__track"
      role="progressbar"
      :aria-valuenow="done"
      :aria-valuemin="0"
      :aria-valuemax="total"
      :aria-label="`已完成 ${done} / ${total}，失败 ${failed}`"
    >
      <span class="job-progress__ok" :style="{ width: percent(succeeded) }" />
      <span class="job-progress__fail" :style="{ width: percent(failed), left: percent(succeeded) }" />
    </span>
    <span v-if="showText" class="job-progress__text">{{ label }}</span>
  </div>
</template>

<style scoped>
.job-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.job-progress__track {
  position: relative;
  height: 8px;
  min-width: 80px;
  flex: 1;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--c-bg);
}

.job-progress--sm .job-progress__track {
  height: 6px;
}

.job-progress__ok,
.job-progress__fail {
  position: absolute;
  top: 0;
  bottom: 0;
  display: block;
  transition: width var(--duration-base) var(--ease-out-soft);
}

.job-progress__ok {
  left: 0;
  background: var(--c-success);
}

.job-progress__fail {
  background: var(--c-danger);
}

.job-progress__text {
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}
</style>
