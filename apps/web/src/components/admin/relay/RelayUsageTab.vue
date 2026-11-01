<script setup lang="ts">
import type {
  RelayChannel,
  RelayScope,
  RelayUsageBucket,
  RelayUsageClientKind,
  RelayUsageRow,
  RelayUsageSource,
  RelayUsageStatsResponse,
} from '@dsh-hub/shared'
import {
  NButton,
  NDataTable,
  NDatePicker,
  NRadioButton,
  NRadioGroup,
  NSelect,
  type DataTableColumns,
} from 'naive-ui'
import dayjs from 'dayjs'
import { computed, ref, watch } from 'vue'

import { getRelayUsage, listRelayLogs, listRelayModels, listRelayWallets } from '@/api/admin-relay'
import UsageLogTable from '@/components/relay/UsageLogTable.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { useTableQuery } from '@/composables/table-query'
import { formatCount, formatPercent } from '@/composables/useFormat'
import { formatPoints, formatTokensZh } from '@/utils/points'

/**
 * 中转站 · 用量记录（12 §10）：筛选栏（用户 / 模型 / 渠道 / 状态 / 日期区间）+ 分页表；
 * 上方是区间汇总与「按用户 / 按模型 / 按渠道」三个小表。docs/22 §1.3：桌面平台默认只筛桌面来源。
 */
/** 区间里每一天（12 §9：没有用量的日子也给 0） */
type DayBucket = RelayUsageBucket & { day: string }

/** 汇总小表的行：按用户 / 模型 / 渠道，各带一个标识字段 */
type SummaryRow = RelayUsageBucket & {
  userId?: number
  username?: string
  model?: string
  channelId?: number
  channelName?: string
}

const props = withDefaults(
  defineProps<{
    channels?: RelayChannel[]
    /** 18 §6：只看这个作用域的统计与记录；缺省 = DSH */
    scope?: RelayScope
    /** 「模型」页看全部来源：多一个「来源」筛选（对话模式页自带作用域，不需要） */
    showSource?: boolean
    /**
     * docs/22 §1.3：「用量记录在桌面下默认筛 `client_kind=desktop`」。
     * 页面切到桌面平台时由父组件传入 `desktop`；缺省 = 全部来源（云端）。
     * 口径见契约 `RelayUsageClientKindSchema`（docker / desktop / external / unknown）。
     */
    clientKind?: RelayUsageClientKind
  }>(),
  { channels: () => [], scope: 'dsh', showSource: false, clientKind: undefined },
)

/**
 * 「用量来源」筛选（WP56e1，仅「模型」页）：`relay_usage.source`。
 * `cockpit` = 管理座舱（系统账号 hub-ops）的请求 —— 它不扣任何人的积分，但 token 用量照常记账。
 */
const USAGE_SOURCE_OPTIONS = [
  { label: '全部用量来源', value: '' },
  { label: '容器', value: 'internal' },
  { label: '本机', value: 'local' },
  { label: '公网', value: 'public' },
  { label: '座舱', value: 'cockpit' },
]

/** 「来源」（作用域）筛选（仅「模型」页）：空串 = 全部来源 */
const SOURCE_OPTIONS = [
  { label: '全部来源', value: '' },
  { label: 'DSH', value: 'dsh' },
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Codex', value: 'codex' },
]

const DEFAULTS = {
  userId: 0,
  model: '',
  channelId: 0,
  status: '',
  source: '',
  usageSource: '',
  from: '',
  to: '',
  page: 1,
  pageSize: 20,
}

const { state, update, reset } = useTableQuery({ ...DEFAULTS })

const stats = ref<RelayUsageStatsResponse | null>(null)
const statsLoading = ref(false)
const logs = ref<RelayUsageRow[]>([])
const logsTotal = ref(0)
const logsLoading = ref(false)
const summaryTab = ref<'byUser' | 'byModel' | 'byChannel'>('byUser')

const { data: walletData } = useAsyncData(() => listRelayWallets({ pageSize: 100 }))
const { data: modelData } = useAsyncData(() => listRelayModels())

const userOptions = computed(() => [
  { label: '全部用户', value: 0 },
  ...(walletData.value?.items ?? []).map((wallet) => ({
    label: `${wallet.displayName || wallet.username}（@${wallet.username}）`,
    value: wallet.userId,
  })),
])

const modelOptions = computed(() => [
  // 16 §5：筛选按模型本名（`baseModel`），不会列出 `模型@标识` 这种请求名
  { label: '全部模型（本名）', value: '' },
  ...(modelData.value ?? []).map((model) => ({ label: model.name, value: model.name })),
])

const channelOptions = computed(() => [
  { label: '全部渠道', value: 0 },
  ...props.channels.map((channel) => ({ label: channel.slug ?? channel.name, value: channel.id })),
])

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '正常', value: 'ok' },
  { label: '已中断', value: 'aborted' },
  { label: '上游错误', value: 'upstream_error' },
  { label: '请求错误', value: 'client_error' },
]

/** NDatePicker 的值 ↔ URL 里的 `YYYY-MM-DD`（统计按 Asia/Shanghai 自然日，12 §6.5） */
const dateRange = computed<[number, number] | null>(() =>
  state.value.from && state.value.to
    ? [dayjs(state.value.from).valueOf(), dayjs(state.value.to).endOf('day').valueOf()]
    : null,
)

function onDateRange(value: [number, number] | null): void {
  void update({
    from: value ? dayjs(value[0]).format('YYYY-MM-DD') : '',
    to: value ? dayjs(value[1]).format('YYYY-MM-DD') : '',
  })
}

function tokenTotal(bucket: RelayUsageBucket): number {
  return bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
}

async function loadStats(): Promise<void> {
  statsLoading.value = true
  try {
    stats.value = await getRelayUsage({
      userId: state.value.userId > 0 ? state.value.userId : undefined,
      scope: scopeParam(),
      from: state.value.from || undefined,
      to: state.value.to || undefined,
      clientKind: props.clientKind,
      source: usageSourceParam(),
    })
  } finally {
    statsLoading.value = false
  }
}

async function loadLogs(): Promise<void> {
  logsLoading.value = true
  try {
    const result = await listRelayLogs({
      userId: state.value.userId > 0 ? state.value.userId : undefined,
      scope: scopeParam(),
      // 16 §5：下拉里是模型本名，按本名筛（带 @ 的请求也算在内）
      baseModel: state.value.model || undefined,
      channelId: state.value.channelId > 0 ? state.value.channelId : undefined,
      status: state.value.status ? (state.value.status as RelayUsageRow['status']) : undefined,
      from: state.value.from || undefined,
      to: state.value.to || undefined,
      clientKind: props.clientKind,
      source: usageSourceParam(),
      page: state.value.page,
      pageSize: state.value.pageSize,
    })
    logs.value = result.items
    logsTotal.value = result.total
  } finally {
    logsLoading.value = false
  }
}

/** `relay_usage.source` 筛选（仅「模型」页）：空串 = 全部用量来源 */
function usageSourceParam(): RelayUsageSource | undefined {
  return props.showSource && state.value.usageSource
    ? (state.value.usageSource as RelayUsageSource)
    : undefined
}

/** 对话模式页固定看自己的作用域；「模型」页看来源筛选 */
function scopeParam(): RelayScope | undefined {
  if (props.scope !== 'dsh') return props.scope
  return props.showSource && state.value.source ? (state.value.source as RelayScope) : undefined
}

watch(
  () => [
    state.value.userId,
    state.value.model,
    state.value.channelId,
    state.value.status,
    state.value.source,
    state.value.usageSource,
    state.value.from,
    state.value.to,
    props.clientKind,
  ],
  () => {
    void loadStats()
    void loadLogs()
  },
  { immediate: true },
)
watch(
  () => [state.value.page, state.value.pageSize],
  () => void loadLogs(),
)

const totalTokens = computed(() => (stats.value ? tokenTotal(stats.value.total) : 0))

const dailyPeak = computed<DayBucket | null>(() => {
  const daily = stats.value?.daily ?? []
  return daily.reduce<DayBucket | null>(
    (best, day) => (best === null || day.costMicro > best.costMicro ? day : best),
    null,
  )
})

const summaryColumns = computed<DataTableColumns<SummaryRow>>(() => {
  const first: DataTableColumns<SummaryRow>[number] =
    summaryTab.value === 'byUser'
      ? { title: '用户', key: 'username', minWidth: 140, render: (row) => row.username ?? '' }
      : summaryTab.value === 'byModel'
        ? { title: '模型', key: 'model', minWidth: 180, render: (row) => row.model ?? '' }
        : { title: '渠道', key: 'channelName', minWidth: 160, render: (row) => row.channelName ?? '' }

  return [
    first,
    {
      title: '请求',
      key: 'requests',
      width: 100,
      align: 'right',
      render: (row) => formatCount(row.requests),
    },
    {
      title: 'token（输入 / 缓存 / 输出）',
      key: 'tokens',
      width: 210,
      render: (row) =>
        `${formatTokensZh(row.inputTokens)} / ${formatTokensZh(row.cacheReadTokens)} / ${formatTokensZh(row.outputTokens)}`,
    },
    {
      title: '积分',
      key: 'costMicro',
      width: 110,
      align: 'right',
      render: (row) => formatPoints(row.costMicro),
    },
    {
      title: '失败',
      key: 'errors',
      width: 90,
      align: 'right',
      render: (row) => formatCount(row.errors),
    },
  ]
})

const summaryRows = computed<SummaryRow[]>(() => {
  if (summaryTab.value === 'byUser') return stats.value?.byUser ?? []
  if (summaryTab.value === 'byModel') return stats.value?.byModel ?? []
  return stats.value?.byChannel ?? []
})
</script>

<template>
  <div class="relay-usage">
    <div class="relay-usage__filters">
      <NSelect
        v-model:value="state.userId"
        size="small"
        class="relay-usage__field"
        :options="userOptions"
        @update:value="(value: number) => update({ userId: value })"
      />
      <NSelect
        v-model:value="state.model"
        size="small"
        class="relay-usage__field"
        :options="modelOptions"
        @update:value="(value: string) => update({ model: value })"
      />
      <NSelect
        v-model:value="state.channelId"
        size="small"
        class="relay-usage__field"
        :options="channelOptions"
        @update:value="(value: number) => update({ channelId: value })"
      />
      <NSelect
        v-model:value="state.status"
        size="small"
        class="relay-usage__field relay-usage__field--narrow"
        :options="STATUS_OPTIONS"
        @update:value="(value: string) => update({ status: value })"
      />
      <NSelect
        v-if="showSource && scope === 'dsh'"
        v-model:value="state.source"
        size="small"
        class="relay-usage__field relay-usage__field--narrow"
        :options="SOURCE_OPTIONS"
        data-testid="usage-source-filter"
        @update:value="(value: string) => update({ source: value })"
      />
      <NSelect
        v-if="showSource && scope === 'dsh'"
        v-model:value="state.usageSource"
        size="small"
        class="relay-usage__field relay-usage__field--narrow"
        :options="USAGE_SOURCE_OPTIONS"
        data-testid="usage-origin-filter"
        @update:value="(value: string) => update({ usageSource: value })"
      />
      <NDatePicker
        :value="dateRange"
        type="daterange"
        size="small"
        clearable
        class="relay-usage__date"
        @update:value="onDateRange"
      />
      <NButton size="small" quaternary @click="reset">清空筛选</NButton>
    </div>

    <div class="relay-usage__summary">
      <div class="relay-usage__summary-item">
        <p class="relay-usage__summary-label">区间请求</p>
        <p class="relay-usage__summary-value" data-testid="usage-requests">
          {{ formatCount(stats?.total.requests ?? 0) }}
        </p>
      </div>
      <div class="relay-usage__summary-item">
        <p class="relay-usage__summary-label">区间 token</p>
        <p class="relay-usage__summary-value">{{ formatTokensZh(totalTokens) }}</p>
      </div>
      <div class="relay-usage__summary-item">
        <p class="relay-usage__summary-label">区间积分</p>
        <p class="relay-usage__summary-value">{{ formatPoints(stats?.total.costMicro ?? 0) }}</p>
      </div>
      <div class="relay-usage__summary-item">
        <p class="relay-usage__summary-label">错误率</p>
        <p class="relay-usage__summary-value">
          {{
            formatPercent(
              stats && stats.total.requests > 0 ? stats.total.errors / stats.total.requests : 0,
              1,
            )
          }}
        </p>
      </div>
      <div class="relay-usage__summary-item">
        <p class="relay-usage__summary-label">区间</p>
        <p
          class="relay-usage__summary-value relay-usage__summary-value--small"
          :title="stats ? `${stats.from} ~ ${stats.to}` : undefined"
        >
          {{ stats ? `${stats.from} ~ ${stats.to}` : '—' }}
        </p>
      </div>
      <div v-if="dailyPeak && dailyPeak.costMicro > 0" class="relay-usage__summary-item">
        <p class="relay-usage__summary-label">最高一天</p>
        <p
          class="relay-usage__summary-value relay-usage__summary-value--small"
          :title="`${dailyPeak.day} · ${formatPoints(dailyPeak.costMicro)} 积分`"
        >
          {{ dailyPeak.day }} · {{ formatPoints(dailyPeak.costMicro) }} 积分
        </p>
      </div>
    </div>

    <SoftCard title="区间汇总">
      <template #extra>
        <NRadioGroup v-model:value="summaryTab" size="small">
          <NRadioButton value="byUser">按用户</NRadioButton>
          <NRadioButton value="byModel">按模型</NRadioButton>
          <NRadioButton value="byChannel">按渠道</NRadioButton>
        </NRadioGroup>
      </template>
      <NDataTable
        class="relay-usage__summary-table"
        :columns="summaryColumns"
        :data="summaryRows"
        :loading="statsLoading"
        :row-key="
          (row: RelayUsageBucket & Record<string, unknown>) =>
            String(row['userId'] ?? row['model'] ?? row['channelId'] ?? '')
        "
        :scroll-x="760"
        :pagination="false"
        size="small"
      >
        <template #empty>
          <span class="relay-usage__empty">这个区间还没有用量</span>
        </template>
      </NDataTable>
    </SoftCard>

    <SoftCard title="逐条用量">
      <UsageLogTable
        scope="admin"
        :show-source="showSource || scope !== 'dsh'"
        :rows="logs"
        :total="logsTotal"
        :page="state.page"
        :page-size="state.pageSize"
        :loading="logsLoading"
        @page-change="(page: number) => update({ page })"
        @page-size-change="(pageSize: number) => update({ pageSize, page: 1 })"
      />
    </SoftCard>
  </div>
</template>

<style scoped>
.relay-usage {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.relay-usage__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.relay-usage__field {
  width: 180px;
}

.relay-usage__field--narrow {
  width: 130px;
}

.relay-usage__date {
  width: 260px;
}

.relay-usage__summary {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
}

.relay-usage__summary-item {
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
}

.relay-usage__summary-label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.relay-usage__summary-value {
  color: var(--c-text);
  font-size: var(--fs-20);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-semibold);
}

.relay-usage__summary-value--small {
  /* 07 §2.8：日期区间是标识符，单行显示；窄了省略，完整内容在 title 里 */
  overflow: hidden;
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relay-usage__summary-table {
  margin-top: var(--space-3);
}

.relay-usage__empty {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}
</style>
