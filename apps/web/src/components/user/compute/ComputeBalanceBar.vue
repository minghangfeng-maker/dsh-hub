<script setup lang="ts">
import { computed } from 'vue'

import { formatPoints } from '@/utils/points'

/**
 * 余额条（13 §7）：余额、其中今日赠送剩余、余额不足提醒、管理员免租。
 *
 * 「今日赠送剩余」= min(daily_bonus_left, max(balance, 0))（13 §2.5）——余额被别处花到
 * 赠送额度以下时，赠送也跟着变少，显示要跟真正能花的一致。
 */
const props = withDefaults(
  defineProps<{
    balanceMicro: number
    blockPriceMicro?: number
    dailyBonusMicro?: number
    dailyBonusLeftMicro?: number
    exempt?: boolean
  }>(),
  { blockPriceMicro: 0, dailyBonusMicro: 0, dailyBonusLeftMicro: 0, exempt: false },
)

const bonusVisible = computed(() => props.dailyBonusMicro > 0)
const bonusLeftMicro = computed(() => Math.min(props.dailyBonusLeftMicro, Math.max(props.balanceMicro, 0)))
const insufficient = computed(
  () => !props.exempt && props.blockPriceMicro > 0 && props.balanceMicro < props.blockPriceMicro,
)
</script>

<template>
  <div class="compute-balance" data-testid="compute-balance">
    <p class="compute-balance__main">
      余额
      <strong class="compute-balance__value" data-testid="compute-balance-value">
        {{ formatPoints(balanceMicro) }}
      </strong>
      积分
    </p>

    <p v-if="bonusVisible" class="compute-balance__bonus" data-testid="compute-daily-bonus">
      其中今日赠送剩余 {{ formatPoints(bonusLeftMicro) }}（今日有效，不累计）
    </p>

    <p v-if="exempt" class="compute-balance__exempt" data-testid="compute-exempt">管理员账号不计费</p>

    <p
      v-else-if="insufficient"
      class="compute-balance__short"
      role="alert"
      data-testid="compute-insufficient"
    >
      余额不足，无法启动
    </p>
  </div>
</template>

<style scoped>
.compute-balance {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  font-size: var(--fs-13);
}

.compute-balance__main {
  color: var(--c-text-2);
  white-space: nowrap;
}

.compute-balance__value {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.compute-balance__bonus {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.compute-balance__exempt {
  color: var(--c-success-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.compute-balance__short {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}
</style>
