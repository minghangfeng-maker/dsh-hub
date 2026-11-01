<script setup lang="ts">
import type { ComputeLease } from '@dsh-hub/shared'
import { useIntervalFn } from '@vueuse/core'
import { computed, ref } from 'vue'

import MiniTag from '@/components/admin/MiniTag.vue'
import { LEASE_STATE_TEXT, formatClock, leaseStateOf } from '@/components/user/compute/text'
import { formatDuration, formatCountdown } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'

/**
 * 运行中的租约（13 §7）：规格、已运行时长（每秒走表）、本次已扣、下次扣费时间；
 * 宽限中给出醒目横幅 + 倒计时；免费租约写「本次不计费」。
 *
 * 时钟：组件自己每秒跳一次；测试传 `now` 固定时间（不用假定时器也能断言倒计时）。
 */
const props = withDefaults(
  defineProps<{
    lease: ComputeLease
    /** 测试注入的时间基准（毫秒）；不传就用本机每秒走表 */
    now?: number
  }>(),
  { now: undefined },
)

const ticking = ref(Date.now())
useIntervalFn(() => {
  ticking.value = Date.now()
}, 1000)

const current = computed(() => props.now ?? ticking.value)

const state = computed(() => leaseStateOf(props.lease))
const stateText = computed(() => LEASE_STATE_TEXT[state.value])

const startedAtMs = computed(() => new Date(props.lease.startedAt).getTime())
const runningText = computed(() => {
  const elapsed = current.value - startedAtMs.value
  if (!Number.isFinite(elapsed)) return '—'
  return formatDuration(Math.max(0, elapsed), 'ms')
})

const graceSecondsLeft = computed(() => {
  if (!props.lease.graceUntil) return null
  const until = new Date(props.lease.graceUntil).getTime()
  if (!Number.isFinite(until)) return null
  return Math.max(0, Math.ceil((until - current.value) / 1000))
})

const graceStopAt = computed(() => formatClock(props.lease.graceUntil))
const graceCountdown = computed(() =>
  graceSecondsLeft.value === null ? '' : formatCountdown(graceSecondsLeft.value),
)
</script>

<template>
  <div class="compute-lease" data-testid="compute-lease">
    <div class="compute-lease__head">
      <span class="compute-lease__title">运行中的租约</span>
      <MiniTag
        :text="stateText"
        :tone="state === 'grace' ? 'danger' : state === 'free' ? 'neutral' : 'success'"
        size="sm"
        :data-testid="`compute-lease-state-${state}`"
      />
    </div>

    <dl class="compute-lease__meta">
      <div>
        <dt>规格</dt>
        <dd data-testid="compute-lease-plan">{{ lease.planName }}</dd>
      </div>
      <div>
        <dt>已运行</dt>
        <dd class="compute-lease__mono" data-testid="compute-lease-uptime">{{ runningText }}</dd>
      </div>
      <div>
        <dt>本次已扣</dt>
        <dd class="compute-lease__mono" data-testid="compute-lease-charged">
          {{ formatPoints(lease.chargedMicro) }} 积分
        </dd>
      </div>
      <div v-if="lease.billed">
        <dt>下次扣费</dt>
        <dd class="compute-lease__mono" data-testid="compute-lease-next">
          {{ lease.paidUntil ? formatClock(lease.paidUntil) : '—' }}
        </dd>
      </div>
      <div v-else>
        <dt>计费</dt>
        <dd data-testid="compute-lease-free">本次不计费</dd>
      </div>
    </dl>

    <div v-if="lease.graceUntil" class="compute-lease__grace" role="alert" data-testid="compute-grace">
      <span class="i-ph-warning-circle compute-lease__grace-icon" aria-hidden="true" />
      <div class="compute-lease__grace-body">
        <p>余额不足，将于 {{ graceStopAt }} 停止，请联系管理员充值</p>
        <p class="compute-lease__grace-sub">
          剩余
          <strong class="compute-lease__mono" data-testid="compute-grace-countdown">{{
            graceCountdown
          }}</strong>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compute-lease {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.compute-lease__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.compute-lease__title {
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.compute-lease__meta {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}

.compute-lease__meta dt {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.compute-lease__meta dd {
  color: var(--c-text);
  font-size: var(--fs-14);
}

.compute-lease__mono {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.compute-lease__grace {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-danger);
  border-radius: var(--radius-control);
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.compute-lease__grace-icon {
  margin-top: 2px;
  font-size: 16px;
}

.compute-lease__grace-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.compute-lease__grace-sub {
  font-size: var(--fs-12);
  color: var(--c-text-2);
}

.compute-lease__grace-sub strong {
  color: var(--c-danger-ink);
  font-size: var(--fs-14);
}
</style>
