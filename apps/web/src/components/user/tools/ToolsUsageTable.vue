<script setup lang="ts">
import type { ToolUsageRow } from '@dsh-hub/shared'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import MiniTag from '@/components/admin/MiniTag.vue'
import { formatDateTime } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'
import { TOOL_KIND_TEXT, TOOL_USAGE_STATUS_TEXT, toolUsageStatusTone } from '@/utils/tool-keys'

/**
 * 用户端「搜索与抓取」的用量表（14 §7）：时间、类型、内容摘要、免费/扣费、状态。
 * 按 14 §7 不显示渠道与上游成本（那是管理端排查用的）。remote 分页由调用方取数。
 */
const emit = defineEmits<{
  'page-change': [page: number]
  'page-size-change': [pageSize: number]
}>()

withDefaults(
  defineProps<{
    rows: ToolUsageRow[]
    total: number
    page: number
    pageSize: number
    loading?: boolean
  }>(),
  { loading: false },
)

const columns = computed<DataTableColumns<ToolUsageRow>>(() => [
  { title: '时间', key: 'createdAt', width: 150, render: (row) => formatDateTime(row.createdAt) },
  { title: '类型', key: 'tool', width: 90, render: (row) => TOOL_KIND_TEXT[row.tool] },
  {
    title: '内容摘要',
    key: 'summary',
    minWidth: 260,
    render: (row) => h('span', { class: 'tool-usage__summary', title: row.summary }, row.summary || '—'),
  },
  {
    title: '免费 / 扣费',
    key: 'costMicro',
    width: 120,
    align: 'right',
    render: (row) =>
      row.free
        ? h(MiniTag, { text: '免费', tone: 'sky', size: 'sm' })
        : h('span', { class: 'tool-usage__mono' }, `${formatPoints(row.costMicro)} 积分`),
  },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render: (row) =>
      h(
        'span',
        { class: 'tool-usage__status', title: row.error ?? undefined },
        [h(MiniTag, { text: TOOL_USAGE_STATUS_TEXT[row.status], tone: toolUsageStatusTone(row.status), size: 'sm' })],
      ),
  },
])
</script>

<template>
  <NDataTable
    class="tool-usage"
    :columns="columns"
    :data="rows"
    :loading="loading"
    :row-key="(row: ToolUsageRow) => row.id"
    :scroll-x="820"
    remote
    size="small"
    :pagination="{
      page,
      pageSize,
      itemCount: total,
      showSizePicker: true,
      pageSizes: [20, 50, 100],
      prefix: ({ itemCount }: { itemCount?: number }) => `共 ${itemCount ?? 0} 条`,
      onUpdatePage: (next: number) => emit('page-change', next),
      onUpdatePageSize: (next: number) => emit('page-size-change', next),
    }"
  />
</template>

<style scoped>
:deep(.tool-usage__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.tool-usage__summary) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.tool-usage__status) {
  display: inline-flex;
}
</style>
