<script setup lang="ts">
import type { InstancePhase, InstanceStats, InstanceSummary, MyComputeResponse, Quota } from '@dsh-hub/shared'
import { computeBlockPriceMicro } from '@dsh-hub/shared'
import { useMediaQuery } from '@vueuse/core'
import { NButton } from 'naive-ui'
import { computed } from 'vue'

import AvatarImg from '@/components/base/AvatarImg.vue'
import PhaseSteps from '@/components/user/PhaseSteps.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import StatusPill from '@/components/base/StatusPill.vue'
import UsageBar from '@/components/base/UsageBar.vue'
import ComputeBalanceBar from '@/components/user/compute/ComputeBalanceBar.vue'
import ComputeLeasePanel from '@/components/user/compute/ComputeLeasePanel.vue'
import { planSpecText } from '@/components/user/compute/text'
import { formatDuration, fromNow } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'

/**
 * 主卡片「我的 DSH」（07 §6.1）——整页视觉中心。
 *
 * WP19b（15 §2.1 §2.5）：左边的状态插画换成用户头像 + 状态环；卡片里新增「当前配置」行与切换入口，
 * 计费开启时余额条与当前租约也收进卡片底部（原来的「算力租赁」大卡片不再单独占一块）。
 *
 * 状态 → 按钮/文案（六种实例状态，测试覆盖运行中/已停止/启动中/停止中/异常五组）：
 * - running：打开 DSH（直接开）、停止、重启；
 * - stopped / absent：打开 DSH（先启动再自动打开）、停止/重启禁用；
 * - starting / stopping：主按钮变「正在唤醒…/停止中…」且禁用，下面出现阶段步骤条；
 * - error：主按钮变「重试启动」。
 */
const props = withDefaults(
  defineProps<{
    instance: InstanceSummary | null
    stats?: InstanceStats | null
    quota?: Quota | null
    /** SSE 推送的当前阶段 */
    phase?: InstancePhase | null
    phaseMessage?: string | null
    /** 计时基准（父组件定期更新，用来算「已运行 2 小时 13 分」） */
    now?: number
    /** 正在执行的动作 */
    busyAction?: 'start' | 'stop' | 'restart' | null
    /** 「打开 DSH」流程进行中（含等待就绪） */
    opening?: boolean
    errorText?: string | null
    errorCode?: string | null
    errorDetails?: Record<string, unknown>
    /** 成功类提示（例如「已开始启动」） */
    noticeText?: string | null
    /** 不能启动（算力租赁余额不足等；只在未运行时生效，运行中仍可打开） */
    startDisabled?: boolean
    /** 算力租赁（15 §2.1）：当前配置行 + 余额 / 租约；null = 接口还没读到或计费模块不可用 */
    compute?: MyComputeResponse | null
    /** 头像（15 §2.5：主卡片直接显示用户头像） */
    avatarUrl?: string | null
    displayName?: string
    avatarSeed?: string
  }>(),
  {
    stats: null,
    quota: null,
    phase: null,
    phaseMessage: null,
    now: () => Date.now(),
    busyAction: null,
    opening: false,
    errorText: null,
    errorCode: null,
    errorDetails: () => ({}),
    noticeText: null,
    startDisabled: false,
    compute: null,
    avatarUrl: null,
    displayName: '',
    avatarSeed: '',
  },
)

const emit = defineEmits<{
  open: []
  stop: []
  restart: []
  retry: []
  'dismiss-notice': []
  'switch-plan': []
}>()

const status = computed(() => props.instance?.status ?? 'absent')
const isRunning = computed(() => status.value === 'running')
const isStarting = computed(() => status.value === 'starting')
const isStopping = computed(() => status.value === 'stopping')
const isError = computed(() => status.value === 'error')
const anyBusy = computed(() => props.opening || props.busyAction !== null)

/** 一行状态说明：运行时长 / 上次使用 / 正在做什么 */
const statusLine = computed(() => {
  const instance = props.instance
  switch (status.value) {
    case 'running': {
      const startedAt = instance?.startedAt ? Date.parse(instance.startedAt) : null
      if (startedAt === null || Number.isNaN(startedAt)) return '正在运行'
      return `已运行 ${formatDuration(Math.max(0, props.now - startedAt))}`
    }
    case 'starting':
      return props.phaseMessage ?? '正在唤醒…'
    case 'stopping':
      return '正在停止…'
    case 'error':
      return '上次启动没有成功'
    case 'absent':
      return instance?.lastActiveAt ? `还没有创建，上次使用 ${fromNow(instance.lastActiveAt)}` : '还没有创建'
    default:
      return instance?.lastActiveAt ? `上次使用 ${fromNow(instance.lastActiveAt)}` : '已停止'
  }
})

const primaryLabel = computed(() => {
  if (props.opening || isStarting.value) return '正在唤醒…'
  if (isStopping.value) return '停止中…'
  if (isError.value) return '重试启动'
  return '打开 DSH'
})

const primaryDisabled = computed(
  () =>
    props.opening ||
    isStarting.value ||
    isStopping.value ||
    props.busyAction !== null ||
    (props.startDisabled && !isRunning.value),
)
const stopDisabled = computed(() => !isRunning.value || anyBusy.value)
const restartDisabled = computed(() => (!isRunning.value && !isError.value) || anyBusy.value)

/** `CAPACITY_FULL` 的友好说明（04 §0.2 的 details.running/max） */
const capacityFull = computed(() => props.errorCode === 'CAPACITY_FULL')
const capacityRatio = computed(() => {
  const running = Number(props.errorDetails?.['running'])
  const max = Number(props.errorDetails?.['max'])
  return Number.isFinite(running) && Number.isFinite(max) && max > 0 ? `${running}/${max}` : null
})

const hasStats = computed(() => props.stats !== null && props.stats !== undefined)
const showPhases = computed(() => isStarting.value || isStopping.value)

/** 手机宽度下头像小一号（15 §2.5：桌面 96–120px，手机适当缩小） */
const narrow = useMediaQuery('(max-width: 640px)')
const avatarSize = computed(() => (narrow.value ? 88 : 112))

/**
 * 状态环的语义色（15 §2.5）：运行中成功色、启动/停止中主色（带呼吸）、停止灰、异常危险色。
 * 具体颜色在 CSS 里用令牌，这里只给出可测试的状态类名。
 */
const avatarStatus = computed(() => {
  switch (status.value) {
    case 'running':
      return 'running'
    case 'starting':
    case 'stopping':
      return 'busy'
    case 'error':
      return 'error'
    default:
      return 'stopped'
  }
})

/**
 * 当前配置（15 §2.1）：运行中且有租约时用租约快照，否则用选中规格。
 * 按「规格 / 价格 + 每块 / 免计费」切成组，组内 `nowrap`，换行只发生在组之间（07 §2.8）。
 */
const currentPlan = computed<{ segments: string[]; canSwitch: boolean } | null>(() => {
  const compute = props.compute
  if (!compute) return null

  if (!compute.billingEnabled) {
    const quota = props.quota
    return quota ? { segments: [`当前配置 ${planSpecText(quota)} · 暂不计费`], canSwitch: false } : null
  }

  const lease = isRunning.value ? compute.lease : null
  const selected =
    compute.plans.find((plan) => plan.id === compute.selectedPlanId) ?? compute.plans[0] ?? null

  if (!lease && !selected) return { segments: ['当前配置 暂无可选规格'], canSwitch: false }

  const plan = lease ?? selected!
  const blockPrice = lease?.blockPriceMicro ?? computeBlockPriceMicro(plan.pricePerHourMicro)
  const segments = [
    `当前配置 ${planSpecText(plan)}`,
    `${formatPoints(plan.pricePerHourMicro)} 积分/小时（每 10 分钟 ${formatPoints(blockPrice)}）`,
  ]
  if (compute.exempt) segments.push('（管理员免计费）')
  return { segments, canSwitch: compute.plans.length > 0 }
})

/** 余额条里用的「一块多少钱」：运行中优先租约快照 */
const blockPriceMicro = computed(() => {
  const compute = props.compute
  if (!compute) return 0
  if (isRunning.value && compute.lease) return compute.lease.blockPriceMicro
  const plan = compute.plans.find((item) => item.id === compute.selectedPlanId) ?? compute.plans[0]
  return plan?.blockPriceMicro ?? 0
})

function onPrimary(): void {
  if (props.errorCode === 'CAPACITY_FULL' || isError.value) emit('retry')
  else emit('open')
}
</script>

<template>
  <SoftCard class="instance-card" :class="`instance-card--${status}`">
    <div class="instance-card__grid">
      <div class="instance-card__left">
        <div
          class="avatar-status"
          :class="`avatar-status--${avatarStatus}`"
          :data-testid="`avatar-status-${avatarStatus}`"
        >
          <AvatarImg
            :src="avatarUrl"
            :name="displayName"
            :seed="avatarSeed"
            :size="avatarSize"
            class="instance-card__avatar"
          />
          <span class="avatar-status__dot" aria-hidden="true" />
        </div>

        <div class="instance-card__state">
          <StatusPill :status="status" size="md" />
          <p class="instance-card__line" data-testid="instance-status-line">{{ statusLine }}</p>
          <p v-if="instance?.runtimeVersion" class="instance-card__meta">DSH {{ instance.runtimeVersion }}</p>
        </div>
      </div>

      <div class="instance-card__right">
        <h2 class="instance-card__title">我的 DSH</h2>

        <div v-if="currentPlan" class="instance-card__plan" data-testid="instance-current-plan">
          <span
            v-for="(segment, index) in currentPlan.segments"
            :key="index"
            class="instance-card__plan-text"
          >
            {{ segment }}
          </span>
          <NButton
            v-if="currentPlan.canSwitch"
            size="tiny"
            secondary
            :disabled="anyBusy"
            data-testid="instance-switch-plan"
            @click="emit('switch-plan')"
          >
            切换配置
          </NButton>
        </div>

        <div class="instance-card__actions">
          <NButton
            type="primary"
            size="large"
            :loading="opening || busyAction === 'start'"
            :disabled="primaryDisabled"
            :title="startDisabled && !isRunning ? '余额不足，无法启动' : undefined"
            data-testid="instance-primary"
            @click="onPrimary"
          >
            <template #icon>
              <span class="i-ph-rocket-launch" aria-hidden="true" />
            </template>
            {{ primaryLabel }}
          </NButton>

          <NButton
            secondary
            :disabled="stopDisabled"
            :loading="busyAction === 'stop'"
            data-testid="instance-stop"
            @click="emit('stop')"
          >
            停止
          </NButton>

          <NButton
            secondary
            :disabled="restartDisabled"
            :loading="busyAction === 'restart'"
            data-testid="instance-restart"
            @click="emit('restart')"
          >
            重启
          </NButton>
        </div>

        <!-- 配置变了要重建容器：奶油色提醒（07 §6.1） -->
        <div
          v-if="instance?.needsRecreate && isRunning"
          class="instance-card__hint instance-card__hint--butter"
          role="status"
        >
          <span class="i-ph-sparkle" aria-hidden="true" />
          <span>配置已更新，重启后生效</span>
          <NButton size="tiny" quaternary :disabled="anyBusy" @click="emit('restart')">现在重启</NButton>
        </div>

        <div v-if="noticeText" class="instance-card__hint instance-card__hint--mint" role="status">
          <span class="i-ph-info" aria-hidden="true" />
          <span>{{ noticeText }}</span>
        </div>

        <!-- CAPACITY_FULL 与启动失败：友好提示 + 重试（10 §C7） -->
        <div
          v-if="errorText"
          class="instance-card__hint instance-card__hint--danger"
          role="alert"
          data-testid="instance-error"
        >
          <span class="i-ph-warning-circle" aria-hidden="true" />
          <div class="instance-card__hint-body">
            <span>{{ errorText }}</span>
            <span v-if="capacityFull && capacityRatio" class="instance-card__hint-sub">
              现在有 {{ capacityRatio }} 个实例在跑，等别人休息一会儿就好。
            </span>
          </div>
          <NButton size="tiny" secondary data-testid="instance-retry" @click="emit('retry')">重试</NButton>
        </div>

        <PhaseSteps
          v-if="showPhases"
          data-testid="instance-phases"
          :phase="phase"
          :message="phaseMessage"
          :active="showPhases"
        />

        <div class="instance-card__resources">
          <template v-if="hasStats && stats">
            <UsageBar label="CPU" :used="stats.cpuPercent" :limit="100" unit="percent" size="sm" />
            <UsageBar
              label="内存"
              :used="stats.memoryBytes"
              :limit="stats.memoryLimitBytes"
              unit="bytes"
              size="sm"
            />
            <UsageBar
              label="磁盘"
              :used="stats.diskBytes ?? 0"
              :limit="stats.diskLimitBytes"
              unit="bytes"
              size="sm"
            />
          </template>
          <p v-else class="instance-card__resources-empty">
            {{ isRunning ? '正在读取资源占用…' : '实例启动后，这里会显示 CPU、内存和磁盘占用。' }}
          </p>
        </div>

        <!-- 15 §2.1：余额条与当前租约收进主卡片底部，紧跟资源条 -->
        <div v-if="compute?.billingEnabled" class="instance-card__compute">
          <ComputeBalanceBar
            :balance-micro="compute.balanceMicro"
            :block-price-micro="blockPriceMicro"
            :daily-bonus-micro="compute.dailyBonusMicro"
            :daily-bonus-left-micro="compute.dailyBonusLeftMicro"
            :exempt="compute.exempt"
          />
          <ComputeLeasePanel v-if="compute.lease" :lease="compute.lease" />
        </div>
      </div>
    </div>
  </SoftCard>
</template>

<style scoped>
.instance-card__grid {
  display: grid;
  gap: var(--space-6);
}

@media (min-width: 900px) {
  .instance-card__grid {
    grid-template-columns: 260px minmax(0, 1fr);
  }
}

.instance-card__left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
}

.instance-card__state {
  text-align: center;
}

.instance-card__line {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.instance-card__meta {
  margin-top: 2px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.instance-card__title {
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
}

/* ── 头像 + 状态环（15 §2.5，替代原来的状态插画） ── */
.avatar-status {
  position: relative;
  display: inline-flex;
  border-radius: 50%;
  padding: 4px;
  transition: box-shadow var(--duration-base) var(--ease-out-soft);
}

.avatar-status--running {
  box-shadow: 0 0 0 3px var(--c-success-soft);
}

.avatar-status--running .avatar-status__dot {
  background: var(--c-success);
}

.avatar-status--busy {
  box-shadow: 0 0 0 3px var(--c-primary-soft);
  animation: avatar-breathe 2.4s var(--ease-out-soft) infinite;
}

.avatar-status--busy .avatar-status__dot {
  background: var(--c-primary);
}

.avatar-status--stopped {
  box-shadow: 0 0 0 3px var(--c-border);
}

.avatar-status--stopped .avatar-status__dot {
  background: var(--c-text-3);
}

.avatar-status--error {
  box-shadow: 0 0 0 3px var(--c-danger-soft);
}

.avatar-status--error .avatar-status__dot {
  background: var(--c-danger);
}

.avatar-status__dot {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 14px;
  height: 14px;
  border: 2px solid var(--c-surface);
  border-radius: 50%;
}

@keyframes avatar-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 3px var(--c-primary-soft);
  }
  50% {
    box-shadow: 0 0 0 9px transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .avatar-status--busy {
    animation: none;
  }
}

/* 当前配置行（15 §2.1）：成对数据不断行，窄屏在按钮前换行 */
.instance-card__plan {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-bg);
}

.instance-card__plan-text {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  line-height: 1.5;
  white-space: nowrap;
}

.instance-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.instance-card__hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  font-size: var(--fs-13);
}

.instance-card__hint--butter {
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
}

.instance-card__hint--mint {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.instance-card__hint--danger {
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
}

.instance-card__hint-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.instance-card__hint-sub {
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.instance-card__resources {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-6);
  padding-top: var(--space-4);
  border-top: 1px solid var(--c-border);
}

@media (min-width: 640px) {
  .instance-card__resources {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.instance-card__resources-empty {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.instance-card__compute {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
}
</style>
