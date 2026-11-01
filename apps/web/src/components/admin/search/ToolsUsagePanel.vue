<script setup lang="ts">
import type { ToolUsageRow, ToolUsageStatus } from '@dsh-hub/shared'
import { NButton, NDataTable, NSelect, type DataTableColumns } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'

import { listRelayWallets } from '@/api/admin-relay'
import { listToolUsage } from '@/api/tools'
import MiniTag from '@/components/admin/MiniTag.vue'
import type { AdminTone } from '@/components/admin/tone'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { useTableQuery } from '@/composables/table-query'
import { formatDateTime } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'
import { TOOL_KIND_TEXT } from '@/utils/tool-keys'

/**
 * 中转站 · 搜索池 · 用量（14 §3.2 §7）：分页表（可按用户 / 工具 / 状态筛选）。
 * 列：时间、用户、工具、摘要、渠道、免费/费用、上游成本、耗时、状态、错误。
 */
const DEFAULTS = { userId: 0, tool: '', status: '', page: 1, pageSize: 20 }

const { state, update, reset } = useTableQuery({ ...DEFAULTS })

const { data: walletData } = useAsyncData(() => listRelayWallets({ pageSize: 100 }))

const rows = ref<ToolUsageRow[]>([])
const total = ref(0)
const loading = ref(false)

const userOptions = computed(() => [
  { label: '全部用户', value: 0 },
  ...(walletData.value?.items ?? []).map((wallet) => ({
    label: `${wallet.displayName || wallet.username}（@${wallet.username}）`,
    value: wallet.userId,
  })),
])

const TOOL_OPTIONS = [
  { label: '全部工具', value: '' },
  { label: '搜索', value: 'search' },
  { label: '抓取', value: 'fetch' },
]

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '成功', value: 'ok' },
  { label: '请求错误', value: 'client_error' },
  { label: '上游错误', value: 'upstream_error' },
  { label: '被拒绝', value: 'rejected' },
]

const STATUS_TEXT: Record<ToolUsageStatus, string> = {
  ok: '成功',
  client_error: '请求错误',
  upstream_error: '上游错误',
  rejected: '被拒绝',
}

const STATUS_TONE: Record<ToolUsageStatus, AdminTone> = {
  ok: 'success',
  client_error: 'butter',
  upstream_error: 'danger',
  rejected: 'neutral',
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await listToolUsage({
      userId: state.value.userId > 0 ? state.value.userId : undefined,
      tool: state.value.tool ? (state.value.tool as ToolUsageRow['tool']) : undefined,
      status: state.value.status ? (state.value.status as ToolUsageStatus) : undefined,
      page: state.value.page,
      pageSize: state.value.pageSize,
    })
    rows.value = result.items
    total.value = result.total
  } finally {
    loading.value = false
  }
}

watch(
  () => [state.value.userId, state.value.tool, state.value.status],
  () => {
    if (state.value.page !== DEFAULTS.page) void update({ page: DEFAULTS.page })
    else void load()
  },
  { immediate: true },
)
watch(() => [state.value.page, state.value.pageSize], () => void load())

const columns = computed<DataTableColumns<ToolUsageRow>>(() => [
  { title: '时间', key: 'createdAt', width: 150, render: (row) => formatDateTime(row.createdAt) },
  {
    title: '用户',
    key: 'username',
    width: 130,
    render: (row) => h('span', { class: 'tools-usage__ellipsis', title: row.username }, row.username),
  },
  { title: '工具', key: 'tool', width: 80, render: (row) => TOOL_KIND_TEXT[row.tool] },
  {
    title: '摘要',
    key: 'summary',
    minWidth: 200,
    render: (row) =>
      h('span', { class: 'tools-usage__summary', title: row.summary }, row.summary || '—'),
  },
  {
    title: '渠道',
    key: 'channelName',
    width: 140,
    render: (row) => row.channelName ?? '—',
  },
  {
    title: '免费 / 费用',
    key: 'costMicro',
    width: 110,
    align: 'right',
    render: (row) =>
      row.free
        ? h(MiniTag, { text: '免费', tone: 'sky', size: 'sm' })
        : h('span', { class: 'tools-usage__mono' }, formatPoints(row.costMicro)),
  },
  {
    title: '上游成本',
    key: 'upstreamCostMicro',
    width: 100,
    align: 'right',
    render: (row) =>
      h('span', { class: 'tools-usage__mono' }, row.upstreamCostMicro === null ? '—' : formatPoints(row.upstreamCostMicro)),
  },
  {
    title: '耗时',
    key: 'durationMs',
    width: 90,
    align: 'right',
    render: (row) => h('span', { class: 'tools-usage__mono' }, `${(row.durationMs / 1000).toFixed(1)}s`),
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) => h(MiniTag, { text: STATUS_TEXT[row.status], tone: STATUS_TONE[row.status], size: 'sm' }),
  },
  {
    title: '错误',
    key: 'error',
    minWidth: 180,
    render: (row) => h('span', { class: 'tools-usage__error', title: row.error ?? '' }, row.error ?? '—'),
  },
])
</script>

<template>
  <div class="tools-usage">
    <div class="tools-usage__filters">
      <NSelect
        v-model:value="state.userId"
        size="small"
        class="tools-usage__field"
        :options="userOptions"
        @update:value="(value: number) => update({ userId: value })"
      />
      <NSelect
        v-model:value="state.tool"
        size="small"
        class="tools-usage__field tools-usage__field--narrow"
        :options="TOOL_OPTIONS"
        @update:value="(value: string) => update({ tool: value })"
      />
      <NSelect
        v-model:value="state.status"
        size="small"
        class="tools-usage__field tools-usage__field--narrow"
        :options="STATUS_OPTIONS"
        @update:value="(value: string) => update({ status: value })"
      />
      <NButton size="small" quaternary @click="reset">清空筛选</NButton>
    </div>

    <SoftCard :padded="false">
      <NDataTable
        class="tools-usage__table"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="(row: ToolUsageRow) => row.id"
        :scroll-x="1400"
        remote
        size="small"
        :pagination="{
          page: state.page,
          pageSize: state.pageSize,
          itemCount: total,
          showSizePicker: true,
          pageSizes: [20, 50, 100],
          prefix: ({ itemCount }: { itemCount?: number }) => `共 ${itemCount ?? 0} 条`,
          onUpdatePage: (next: number) => update({ page: next }),
          onUpdatePageSize: (next: number) => update({ pageSize: next, page: 1 }),
        }"
      />
    </SoftCard>
  </div>
</template>

<style scoped>
.tools-usage {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tools-usage__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.tools-usage__field {
  width: 200px;
}

.tools-usage__field--narrow {
  width: 130px;
}

.tools-usage__table {
  padding: var(--space-2) var(--space-3);
}

:deep(.tools-usage__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.tools-usage__ellipsis) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.tools-usage__summary) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.tools-usage__error) {
  display: block;
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
