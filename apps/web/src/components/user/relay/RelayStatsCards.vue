<script setup lang="ts">
import type { RelayUsageBucket, RelayWallet } from '@dsh-hub/shared'
import { computed } from 'vue'

import CountUp from '@/components/base/CountUp.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { formatCount } from '@/composables/useFormat'
import { formatPoints, formatTokensZh, microToPoints } from '@/utils/points'

/**
 * `/usage` 顶部三张统计卡（12 §10 第 1 条）：积分余额（CountUp，负数珊瑚、少于 1 积分琥珀）、
 * 今日消耗、本月消耗（附请求数与 token 数）。
 *
 * 07 §2.7：单位与换算收进标签后的 InfoTip，卡片上只留数据本身（每天的数字 + 单位）。
 */
const props = defineProps<{
  wallet: RelayWallet
  today: RelayUsageBucket
  month: RelayUsageBucket
}>()

const balancePoints = computed(() => microToPoints(props.wallet.balanceMicro) ?? 0)
const lowBalance = computed(() => props.wallet.balanceMicro < 1_000_000)

/** 19 §2.1：今日赠送还没用掉的部分（0 或没开通就不占一行） */
const dailyBonusLeftMicro = computed(() => props.wallet.dailyBonusLeftMicro ?? 0)

function tokenTotal(bucket: RelayUsageBucket): number {
  return bucket.inputTokens + bucket.cacheReadTokens + bucket.outputTokens
}
</script>

<template>
  <div class="stats">
    <SoftCard class="stats__card">
      <p class="stats__label">
        积分余额
        <InfoTip label="积分余额说明" text="1 积分 = 1 元。用完了找管理员充值。" />
      </p>
      <p class="stats__value" :class="{ 'stats__value--danger': balancePoints < 0, 'stats__value--low': balancePoints >= 0 && lowBalance }">
        <CountUp :value="balancePoints" :decimals="2" />
        <span class="stats__unit">积分</span>
      </p>
      <!-- 余额状态提示：只在为负 / 快用完时出现（07 §2.7 第 3 条） -->
      <p v-if="balancePoints < 0" class="stats__hint stats__hint--danger">
        余额为负，新的请求会被挡住，请联系管理员充值。
      </p>
      <p v-else-if="lowBalance" class="stats__hint stats__hint--warn">积分快用完了，请联系管理员。</p>
      <!-- 19 §2.1：今日赠送剩余（数据行，> 0 才出现） -->
      <p v-if="dailyBonusLeftMicro > 0" class="stats__hint" data-testid="daily-bonus-left">
        <span class="stats__metric">今日赠送剩余 {{ formatPoints(dailyBonusLeftMicro) }} 积分</span>
      </p>
    </SoftCard>

    <SoftCard class="stats__card">
      <p class="stats__label">今日消耗</p>
      <p class="stats__value">{{ formatPoints(today.costMicro) }}<span class="stats__unit">积分</span></p>
      <!-- 今天还没有请求时不占一行（数据行，07 §2.7 第 6 条） -->
      <p v-if="today.requests > 0" class="stats__hint">
        <span class="stats__metric">{{ formatCount(today.requests) }} 次请求</span>
        <span class="stats__metric">{{ formatTokensZh(tokenTotal(today)) }} token</span>
      </p>
    </SoftCard>

    <SoftCard class="stats__card">
      <p class="stats__label">本月消耗</p>
      <p class="stats__value">{{ formatPoints(month.costMicro) }}<span class="stats__unit">积分</span></p>
      <p class="stats__hint">
        <span class="stats__metric">{{ formatCount(month.requests) }} 次请求</span>
        <span class="stats__metric">{{ formatTokensZh(tokenTotal(month)) }} token</span>
      </p>
    </SoftCard>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.stats__label {
  display: flex;
  align-items: center;
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.stats__value {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin-top: var(--space-1);
  color: var(--c-text);
  font-size: var(--fs-32);
  font-weight: var(--fw-semibold);
  line-height: 1.2;
}

.stats__value--danger {
  color: var(--c-danger-ink);
}

.stats__value--low {
  color: var(--c-butter-ink);
}

.stats__unit {
  color: var(--c-text-3);
  font-size: var(--fs-13);
  font-weight: var(--fw-normal);
}

.stats__hint {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

/* 「121.7万 token」这类「数字 + 单位」在组内不断行（07 §2.8） */
.stats__metric {
  white-space: nowrap;
}

.stats__hint--danger {
  color: var(--c-danger-ink);
}

.stats__hint--warn {
  color: var(--c-butter-ink);
}
</style>
