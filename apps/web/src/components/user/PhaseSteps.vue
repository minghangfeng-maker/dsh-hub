<script setup lang="ts">
import type { InstancePhase } from '@dsh-hub/shared'
import { computed } from 'vue'

/**
 * 启动阶段步骤条（07 §6.1）：`creating → booting → bootstrapping → ready`。
 *
 * 04 §3.1 的 phase 枚举比 07 多一个 `pulling`（拉镜像），它归到第一步「准备容器」里，
 * 具体动作由下面的 `message` 文案体现（「正在拉取镜像」）。
 */
const props = withDefaults(
  defineProps<{
    /** 当前阶段；`null` 表示还没开始或已经结束 */
    phase?: InstancePhase | null
    /** 具体动作文字（服务端 `message`） */
    message?: string | null
    /** 是否正在启动（决定是否渲染整条步骤条） */
    active?: boolean
  }>(),
  { phase: null, message: null, active: true },
)

const STEPS = [
  { phase: 'creating', label: '准备容器', icon: 'i-ph-package' },
  { phase: 'booting', label: '启动服务', icon: 'i-ph-power' },
  { phase: 'bootstrapping', label: '准备插件', icon: 'i-ph-puzzle-piece' },
  { phase: 'ready', label: '就绪', icon: 'i-ph-check-circle' },
] as const

/** phase → 步骤下标；`pulling` 与 `creating` 同属第一步。 */
function indexOf(phase: InstancePhase | null | undefined): number {
  if (!phase) return 0
  if (phase === 'pulling') return 0
  const index = STEPS.findIndex((step) => step.phase === phase)
  return index < 0 ? 0 : index
}

const currentIndex = computed(() => indexOf(props.phase))
const text = computed(() => props.message ?? STEPS[currentIndex.value]?.label ?? '正在准备')
</script>

<template>
  <div v-if="active" class="phase-steps" aria-live="polite">
    <ol class="phase-steps__list">
      <li
        v-for="(step, index) in STEPS"
        :key="step.phase"
        class="phase-steps__item"
        :class="{
          'phase-steps__item--done': index < currentIndex,
          'phase-steps__item--active': index === currentIndex,
        }"
        :aria-current="index === currentIndex ? 'step' : undefined"
      >
        <span class="phase-steps__dot" aria-hidden="true">
          <span v-if="index < currentIndex" class="i-ph-check" />
          <span v-else-if="index === currentIndex" class="phase-steps__ring ring-spin" />
          <span v-else :class="step.icon" class="phase-steps__icon" />
        </span>
        <span class="phase-steps__label">{{ step.label }}</span>
        <span v-if="index < STEPS.length - 1" class="phase-steps__bar" aria-hidden="true" />
      </li>
    </ol>

    <p class="phase-steps__message">{{ text }}</p>
  </div>
</template>

<style scoped>
.phase-steps {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg);
}

.phase-steps__list {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.phase-steps__item {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.phase-steps__dot {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: var(--border-width) solid var(--c-border);
  border-radius: 50%;
  background: var(--c-surface);
  font-size: 12px;
}

.phase-steps__item--active .phase-steps__dot {
  border-color: var(--c-primary);
  color: var(--c-primary-press);
}

.phase-steps__item--active {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.phase-steps__item--done .phase-steps__dot {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.phase-steps__item--done {
  color: var(--c-text-2);
}

.phase-steps__ring {
  width: 10px;
  height: 10px;
  border: 2px solid var(--c-sky);
  border-top-color: transparent;
  border-radius: 50%;
}

.phase-steps__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phase-steps__bar {
  flex: 1;
  height: 1px;
  min-width: var(--space-2);
  background: var(--c-border);
}

.phase-steps__message {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

/* 手机上把步骤条竖过来，四段横排会挤成一团（10 §H1） */
@media (max-width: 640px) {
  .phase-steps__list {
    flex-direction: column;
    align-items: flex-start;
  }

  .phase-steps__item {
    flex: none;
  }

  .phase-steps__bar {
    display: none;
  }
}
</style>
