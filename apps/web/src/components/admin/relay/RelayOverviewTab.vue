<script setup lang="ts">
import type { RelayAlert, RelayChannel, RelayOverviewResponse } from '@dsh-hub/shared'
import { NButton, NSpin } from 'naive-ui'
import { computed } from 'vue'

import { listRelayChannels } from '@/api/admin-relay'
import MiniTag from '@/components/admin/MiniTag.vue'
import { TONE_VARS, type AdminTone } from '@/components/admin/tone'
import CopyText from '@/components/base/CopyText.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { modelDeliveryLocation, type DeliveryPlatformChoice } from '@/composables/delivery-draft'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatCount } from '@/composables/useFormat'
import { formatPoints, formatTokensZh } from '@/utils/points'

/**
 * 中转站 · 概览（12 §10）：今日 / 本月统计、内部监听器状态与地址、渠道健康、告警列表。
 *
 * 告警按 `level` 配色，点一条能跳到对应渠道（切到「渠道」Tab 并打开抽屉）。
 */
const props = withDefaults(
  defineProps<{
    overview: RelayOverviewResponse | null
    loading?: boolean
    /** docs/22：「去下发」预选哪个平台（模型页的云端 / 桌面切换） */
    deliveryPlatform?: DeliveryPlatformChoice
  }>(),
  { loading: false, deliveryPlatform: 'cloud' },
)

const emit = defineEmits<{ refresh: []; 'open-channel': [channelId: number]; 'open-unpriced': [] }>()

/**
 * 告警的「去处理」：渠道类的打开渠道抽屉，`models-unpriced` 跳「模型与价格」并打开「只看未定价」，
 * `models-changed` 跳统一下发向导（只预选当前平台 + 模型与 API 配置）；其余没有可跳的目标。
 */
function alertAction(alert: RelayAlert): { label: string; kind: 'channel' | 'unpriced' | 'rollout' } | null {
  if (alert.kind === 'models-unpriced') return { label: '去定价', kind: 'unpriced' }
  if (alert.channelId !== null) return { label: '去处理', kind: 'channel' }
  if (alert.kind === 'models-changed') return { label: '去下发', kind: 'rollout' }
  return null
}

const { data: channelList, loading: channelsLoading } = useAsyncData(() => listRelayChannels())

const channels = computed<RelayChannel[]>(() => channelList.value ?? [])

const HEALTH_TEXT: Record<RelayChannel['health'], string> = {
  ok: '正常',
  cooling: '冷却中',
  'no-key': '没有可用密钥',
  disabled: '已停用',
}

const HEALTH_TONE: Record<RelayChannel['health'], AdminTone> = {
  ok: 'success',
  cooling: 'butter',
  'no-key': 'danger',
  disabled: 'neutral',
}

interface Stat {
  label: string
  value: number
  decimals: number
  suffix?: string
  hint: string
  icon: string
  tone: AdminTone
  /** 金额类统计直接给微积分，用 `formatPoints` 显示（< 1 积分也能看清） */
  micro?: number
}

function tokenTotal(bucket: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
}

/** 统计卡上的数字：整数走千分位，小数保留固定位数（积分两位） */
function formatStatValue(stat: Stat): string {
  if (stat.decimals <= 0) return formatCount(stat.value)
  return stat.value.toLocaleString('zh-CN', {
    minimumFractionDigits: stat.decimals,
    maximumFractionDigits: stat.decimals,
  })
}

const stats = computed<Stat[]>(() => {
  const overview = props.overview
  if (!overview) return []
  const todayTokens = tokenTotal(overview.today)
  const monthTokens = tokenTotal(overview.month)
  const errorRate = overview.today.requests > 0 ? overview.today.errors / overview.today.requests : 0

  return [
    {
      label: '今日请求',
      value: overview.today.requests,
      decimals: 0,
      hint: `本月 ${formatCount(overview.month.requests)} 次`,
      icon: 'i-ph-paper-plane-tilt',
      tone: 'primary',
    },
    {
      label: '今日 token',
      value: todayTokens,
      decimals: 0,
      hint: `本月 ${formatTokensZh(monthTokens)}`,
      icon: 'i-ph-text-aa',
      tone: 'sky',
    },
    {
      label: '今日积分',
      value: overview.today.costMicro / 1_000_000,
      decimals: 2,
      micro: overview.today.costMicro,
      suffix: '积分',
      hint: `本月 ${formatPoints(overview.month.costMicro)} 积分`,
      icon: 'i-ph-coins',
      tone: 'sakura',
    },
    {
      label: '错误率',
      value: errorRate * 100,
      decimals: 1,
      suffix: '%',
      hint: `今日 ${formatCount(overview.today.errors)} 次失败`,
      icon: 'i-ph-warning-octagon',
      tone: errorRate > 0.05 ? 'danger' : 'success',
    },
    {
      label: '进行中',
      value: overview.inFlight,
      decimals: 0,
      hint: 'Hub 重启后清零',
      icon: 'i-ph-spinner-gap',
      tone: 'sky',
    },
    {
      label: '全部余额合计',
      value: overview.totalBalanceMicro / 1_000_000,
      decimals: 2,
      micro: overview.totalBalanceMicro,
      suffix: '积分',
      hint: '所有用户钱包之和',
      icon: 'i-ph-wallet',
      tone: overview.totalBalanceMicro < 0 ? 'danger' : 'primary',
    },
    {
      label: '渠道',
      value: overview.channels.ok,
      decimals: 0,
      suffix: `/ ${overview.channels.total}`,
      hint: `${overview.channels.unhealthy} 个需要看看`,
      icon: 'i-ph-hard-drives',
      tone: overview.channels.unhealthy > 0 ? 'butter' : 'success',
    },
    {
      label: '对外模型',
      value: overview.models.enabled,
      decimals: 0,
      suffix: `/ ${overview.models.total}`,
      hint: '已启用 / 全部',
      icon: 'i-ph-cube',
      tone: 'primary',
    },
  ]
})
</script>

<template>
  <div class="relay-overview">
    <div class="relay-overview__stats">
      <div
        v-for="stat in stats"
        :key="stat.label"
        class="relay-stat"
        :style="{ '--tone-color': TONE_VARS[stat.tone].color, '--tone-soft': TONE_VARS[stat.tone].soft }"
      >
        <span class="relay-stat__icon" :class="stat.icon" aria-hidden="true" />
        <div>
          <p class="relay-stat__label">{{ stat.label }}</p>
          <p class="relay-stat__value">
            {{ stat.micro === undefined ? formatStatValue(stat) : formatPoints(stat.micro) }}
            <span v-if="stat.suffix" class="relay-stat__suffix">{{ stat.suffix }}</span>
          </p>
          <p class="relay-stat__hint">{{ stat.hint }}</p>
        </div>
      </div>
    </div>

    <div class="relay-overview__columns">
      <SoftCard title="内部监听器">
        <template #extra>
          <NButton size="tiny" quaternary :loading="loading" @click="emit('refresh')">刷新</NButton>
        </template>

        <div v-if="!overview" class="relay-overview__empty">正在读取概览…</div>
        <template v-else>
          <p class="relay-overview__row">
            <MiniTag
              :text="overview.internalListening ? '监听中' : '未监听'"
              :tone="overview.internalListening ? 'success' : 'danger'"
            />
            <span v-if="!overview.enabled" class="relay-overview__note">中转站总开关已关闭（/v1 一律 503）</span>
          </p>
          <CopyText v-if="overview.internalBaseUrl" :text="overview.internalBaseUrl" label="内部地址" />
          <p v-else class="relay-overview__note">内部监听器关闭：用户容器里的 DSH 暂时连不上中转站。</p>
        </template>
      </SoftCard>

      <SoftCard title="渠道健康">
        <NSpin :show="channelsLoading">
          <ul v-if="channels.length > 0" class="relay-health">
            <li v-for="channel in channels" :key="channel.id" class="relay-health__item">
              <span class="relay-health__name">{{ channel.name }}</span>
              <MiniTag :text="HEALTH_TEXT[channel.health]" :tone="HEALTH_TONE[channel.health]" size="sm" />
              <span class="relay-health__meta">
                密钥 {{ channel.keys.filter((key) => key.state === 'active').length }}/{{ channel.keys.length }} · 并发
                {{ channel.inFlight }}/{{ channel.maxConcurrency || '∞' }} · 模型 {{ channel.modelCount }}
              </span>
              <NButton size="tiny" quaternary @click="emit('open-channel', channel.id)">查看</NButton>
            </li>
          </ul>
          <p v-else class="relay-overview__empty">还没有渠道，去「渠道」Tab 添加一个。</p>
        </NSpin>
      </SoftCard>
    </div>

    <SoftCard title="告警">
      <ul v-if="overview && overview.alerts.length > 0" class="relay-alerts">
        <li
          v-for="(alert, index) in overview.alerts"
          :key="`${alert.kind}-${index}`"
          class="relay-alert"
          :class="`relay-alert--${alert.level}`"
        >
          <span
            :class="alert.level === 'error' ? 'i-ph-x-circle' : 'i-ph-warning-circle'"
            class="relay-alert__icon"
            aria-hidden="true"
          />
          <div class="relay-alert__body">
            <p class="relay-alert__message">{{ alert.message }}</p>
            <p class="relay-alert__meta">
              {{ alert.kind }}<template v-if="alert.at"> · {{ alert.at.slice(0, 16).replace('T', ' ') }}</template>
            </p>
          </div>
          <NButton
            v-if="alertAction(alert)?.kind === 'channel'"
            size="tiny"
            :type="alert.level === 'error' ? 'error' : 'warning'"
            ghost
            @click="emit('open-channel', alert.channelId as number)"
          >
            {{ alertAction(alert)?.label }}
          </NButton>
          <NButton
            v-else-if="alertAction(alert)?.kind === 'unpriced'"
            size="tiny"
            type="warning"
            ghost
            data-testid="alert-unpriced"
            @click="emit('open-unpriced')"
          >
            {{ alertAction(alert)?.label }}
          </NButton>
          <RouterLink
            v-else-if="alertAction(alert)?.kind === 'rollout'"
            :to="modelDeliveryLocation(props.deliveryPlatform)"
          >
            <NButton size="tiny" type="warning" ghost>{{ alertAction(alert)?.label }}</NButton>
          </RouterLink>
        </li>
      </ul>
      <p v-else class="relay-overview__empty">没有告警，一切正常。</p>
    </SoftCard>
  </div>
</template>

<style scoped>
.relay-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.relay-overview__stats {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.relay-stat {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

.relay-stat__icon {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  background: var(--tone-soft);
  color: var(--tone-color);
  font-size: 18px;
}

.relay-stat__label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.relay-stat__value {
  color: var(--c-text);
  font-size: var(--fs-20);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-semibold);
}

.relay-stat__suffix {
  margin-left: 4px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  font-weight: var(--fw-normal);
}

.relay-stat__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.relay-overview__columns {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

.relay-overview__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.relay-overview__note {
  margin-top: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.relay-overview__empty {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.relay-health {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.relay-health__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: var(--border-width) solid var(--c-border);
  font-size: var(--fs-13);
}

.relay-health__item:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.relay-health__name {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.relay-health__meta {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.relay-alerts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.relay-alert {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-left: 3px solid var(--c-butter);
  border-radius: var(--radius-control);
  background: var(--c-butter-soft);
}

.relay-alert--error {
  border-left-color: var(--c-danger);
  background: var(--c-danger-soft);
}

.relay-alert__icon {
  flex: none;
  color: var(--c-butter-ink);
  font-size: 18px;
}

.relay-alert--error .relay-alert__icon {
  color: var(--c-danger-ink);
}

.relay-alert__body {
  min-width: 0;
  flex: 1;
}

.relay-alert__message {
  color: var(--c-text);
  font-size: var(--fs-13);
}

.relay-alert__meta {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: 11px;
}
</style>
