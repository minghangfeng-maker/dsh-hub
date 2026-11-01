<script setup lang="ts">
import { computed } from 'vue'

import { FLOW_STEPS, FLOW_STEP_TITLES, type FlowStep } from '@/composables/delivery-draft'

/**
 * 下发流程（WP57）顶部的五步条：内容 → 端 → 配置 → 下发 → 完成。
 *
 * - 走过的步骤显示勾和**已选的值**（如「模型配置」「桌面端」），点一下回到那一步；
 * - 进度线按当前端着色（云端蓝 / 桌面端紫），走一步线就往前长一段；
 * - 完成后整条锁住（不能再点回去改已经提交的东西）。
 */
const props = defineProps<{
  current: FlowStep
  /** 每一步已选的值（还没选的不传） */
  values: Partial<Record<FlowStep, string>>
  locked?: boolean
}>()

const emit = defineEmits<{ go: [FlowStep] }>()

const currentIndex = computed(() => FLOW_STEPS.indexOf(props.current))

/** 进度线长度：第 1 步 0%，最后一步 100% */
const progress = computed(() => `${String((currentIndex.value / (FLOW_STEPS.length - 1)) * 100)}%`)

function stateOf(index: number): 'done' | 'current' | 'todo' {
  // 走到「完成」就全部打勾
  if (index < currentIndex.value || (props.locked && index === currentIndex.value)) return 'done'
  if (index === currentIndex.value) return 'current'
  return 'todo'
}

function go(step: FlowStep, index: number): void {
  if (props.locked || index >= currentIndex.value) return
  emit('go', step)
}
</script>

<template>
  <nav class="flow-stepper" aria-label="下发步骤" data-testid="flow-stepper">
    <span class="flow-stepper__track" aria-hidden="true">
      <span class="flow-stepper__fill" :style="{ width: progress }" />
    </span>
    <ol class="flow-stepper__list">
      <li
        v-for="(step, index) in FLOW_STEPS"
        :key="step"
        class="flow-stepper__item"
        :class="`flow-stepper__item--${stateOf(index)}`"
      >
        <button
          type="button"
          class="flow-stepper__button"
          :disabled="locked || index >= currentIndex"
          :aria-current="index === currentIndex ? 'step' : undefined"
          :data-testid="`flow-step-${step}`"
          @click="go(step, index)"
        >
          <span class="flow-stepper__dot">
            <span v-if="stateOf(index) === 'done'" class="i-ph-check-bold" aria-hidden="true" />
            <template v-else>{{ index + 1 }}</template>
          </span>
          <span class="flow-stepper__text">
            <span class="flow-stepper__title">{{ FLOW_STEP_TITLES[step] }}</span>
            <span v-if="values[step] && index < currentIndex" class="flow-stepper__value">{{ values[step] }}</span>
          </span>
        </button>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.flow-stepper {
  --dot: 30px;

  position: relative;
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

/* 进度线横穿五个圆点的圆心；左右各留半个格子 */
.flow-stepper__track {
  position: absolute;
  top: calc(var(--space-4) + var(--dot) / 2 - 1px);
  right: calc(var(--space-6) + 10%);
  left: calc(var(--space-6) + 10%);
  height: 2px;
  border-radius: 2px;
  background: var(--c-border);
}

.flow-stepper__fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--plat, var(--c-primary));
  transition:
    width 420ms var(--ease-out-soft),
    background-color 320ms var(--ease-out-soft);
}

.flow-stepper__list {
  position: relative;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

.flow-stepper__button {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: default;
  font: inherit;
}

.flow-stepper__item--done .flow-stepper__button:not(:disabled) {
  cursor: pointer;
}

.flow-stepper__dot {
  display: inline-flex;
  width: var(--dot);
  height: var(--dot);
  align-items: center;
  justify-content: center;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
  transition:
    background-color 320ms var(--ease-out-soft),
    border-color 320ms var(--ease-out-soft),
    color 320ms var(--ease-out-soft),
    transform 320ms var(--ease-out-soft);
}

.flow-stepper__item--done .flow-stepper__dot {
  border-color: var(--plat, var(--c-primary));
  background: var(--plat, var(--c-primary));
  color: var(--c-plat-on);
}

.flow-stepper__item--current .flow-stepper__dot {
  border-color: var(--plat, var(--c-primary));
  color: var(--plat-ink, var(--c-primary-press));
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--plat, var(--c-primary)) 16%, transparent);
  transform: scale(1.08);
}

.flow-stepper__item--done .flow-stepper__button:not(:disabled):hover .flow-stepper__dot {
  transform: scale(1.1);
}

.flow-stepper__text {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.flow-stepper__title {
  color: var(--c-text-3);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.flow-stepper__item--current .flow-stepper__title {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.flow-stepper__item--done .flow-stepper__title {
  color: var(--c-text-2);
}

.flow-stepper__value {
  overflow: hidden;
  max-width: 100%;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--plat-soft, var(--c-primary-soft));
  color: var(--plat-ink, var(--c-primary-press));
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .flow-stepper {
    padding: var(--space-3);
  }

  .flow-stepper__track {
    right: calc(var(--space-3) + 10%);
    left: calc(var(--space-3) + 10%);
    top: calc(var(--space-3) + var(--dot) / 2 - 1px);
  }

  .flow-stepper__value {
    display: none;
  }
}
</style>
