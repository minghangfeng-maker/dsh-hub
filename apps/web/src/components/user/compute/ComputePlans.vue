<script setup lang="ts">
import type { MyComputePlan } from '@dsh-hub/shared'
import { computed } from 'vue'

import MiniTag from '@/components/admin/MiniTag.vue'
import { planSpecText } from '@/components/user/compute/text'
import { formatPoints } from '@/utils/points'

/**
 * 规格卡片（13 §7）：「N 核 / N GB」「X 积分/小时」+ 小字「每 10 分钟 Y」，
 * 定制规格带「定制」标，选中项高亮，底部显示联系文案。
 *
 * 卡片是 `<button>`，键盘可选中；是否运行中、要不要先确认都由父组件决定。
 */
const props = withDefaults(
  defineProps<{
    plans: MyComputePlan[]
    selectedPlanId: string | null
    contactText?: string
    /** 切换请求进行中（禁用重复点击） */
    busy?: boolean
  }>(),
  { contactText: '', busy: false },
)

const emit = defineEmits<{ select: [planId: string] }>()

const hasPlans = computed(() => props.plans.length > 0)

function onSelect(plan: MyComputePlan): void {
  if (props.busy || plan.id === props.selectedPlanId) return
  emit('select', plan.id)
}
</script>

<template>
  <div class="compute-plans">
    <div v-if="hasPlans" class="compute-plans__grid" role="radiogroup" aria-label="算力规格">
      <button
        v-for="plan in plans"
        :key="plan.id"
        type="button"
        role="radio"
        class="compute-plans__card"
        :class="{ 'compute-plans__card--selected': plan.id === selectedPlanId }"
        :aria-checked="plan.id === selectedPlanId"
        :aria-label="`${plan.name}，${planSpecText(plan)}，${formatPoints(plan.pricePerHourMicro)} 积分每小时`"
        :data-testid="`compute-plan-${plan.id}`"
        :data-selected="plan.id === selectedPlanId ? 'true' : 'false'"
        :disabled="busy"
        @click="onSelect(plan)"
      >
        <span class="compute-plans__head">
          <span class="compute-plans__name">{{ plan.name }}</span>
          <MiniTag v-if="plan.custom" text="定制" tone="sakura" size="sm" />
          <span
            v-if="plan.id === selectedPlanId"
            class="i-ph-check-circle compute-plans__check"
            aria-hidden="true"
          />
        </span>
        <span class="compute-plans__spec">{{ planSpecText(plan) }}</span>
        <span class="compute-plans__price">
          <strong>{{ formatPoints(plan.pricePerHourMicro) }}</strong>
          积分/小时
        </span>
        <span class="compute-plans__block">每 10 分钟 {{ formatPoints(plan.blockPriceMicro) }}</span>
      </button>
    </div>

    <p v-else class="compute-plans__empty" data-testid="compute-plans-empty">
      管理员还没配置可用规格，请联系管理员。
    </p>

    <p v-if="contactText" class="compute-plans__contact" data-testid="compute-contact">{{ contactText }}</p>
  </div>
</template>

<style scoped>
.compute-plans__grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}

.compute-plans__card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
  color: var(--c-text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--duration-base) var(--ease-out-soft),
    background var(--duration-base) var(--ease-out-soft),
    transform var(--duration-base) var(--ease-out-soft);
}

.compute-plans__card:hover:not(:disabled) {
  border-color: var(--c-primary);
  transform: translateY(-1px);
}

.compute-plans__card:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}

.compute-plans__card:disabled {
  cursor: progress;
}

.compute-plans__card--selected {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
  box-shadow: 0 0 0 1px var(--c-primary) inset;
}

.compute-plans__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.compute-plans__name {
  overflow: hidden;
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compute-plans__check {
  margin-left: auto;
  color: var(--c-primary);
  font-size: 16px;
}

.compute-plans__spec {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.compute-plans__price {
  margin-top: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.compute-plans__price strong {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.compute-plans__block {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.compute-plans__contact {
  margin-top: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.compute-plans__empty {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}
</style>
