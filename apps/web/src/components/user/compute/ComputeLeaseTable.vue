<script setup lang="ts">
import type { ComputeLeaseRow } from '@dsh-hub/shared'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import { planSpecText, leaseEndReasonText } from '@/components/user/compute/text'
import { formatDateTime, formatDuration } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'

/**
 * 算力租赁记录表（13 §7 用户端「积分与用量」）：开始时间、规格、时长、块数、花费、结束原因。
 *
 * 进行中的租约 `endedAt` 为空：时长写「进行中」，结束原因也写「进行中」，不拿当前时间硬算
 * （页面上没有一个会走的时钟，算出来也会停在挂载那一刻）。
 */
const props = withDefaults(
  defineProps<{
    rows: ComputeLeaseRow[]
    total: number
    page: number
    pageSize: number
    loading?: boolean
  }>(),
  { loading: false },
)

const emit = defineEmits<{
  'page-change': [page: number]
  'page-size-change': [pageSize: number]
}>()

function durationOf(row: ComputeLeaseRow): string {
  if (!row.endedAt) return '进行中'
  const elapsed = new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()
  if (!Number.isFinite(elapsed) || elapsed < 0) return '—'
  return formatDuration(elapsed, 'ms')
}

const columns = computed<DataTableColumns<ComputeLeaseRow>>(() => [
  {
    title: '开始时间',
    key: 'startedAt',
    width: 150,
    render: (row) => h('span', { class: 'lease__nowrap' }, formatDateTime(row.startedAt)),
  },
  {
    title: '规格',
    key: 'planName',
    minWidth: 140,
    render: (row) =>
      h('span', { class: 'lease__plan', title: `${row.planName} · ${planSpecText(row)}` }, row.planName),
  },
  { title: '时长', key: 'duration', width: 130, render: (row) => durationOf(row) },
  {
    title: '块数',
    key: 'blocks',
    width: 80,
    align: 'right',
    render: (row) => h('span', { class: 'lease__mono' }, String(row.blocks)),
  },
  {
    title: '花费（积分）',
    key: 'chargedMicro',
    width: 120,
    align: 'right',
    render: (row) => h('span', { class: 'lease__mono' }, formatPoints(row.chargedMicro)),
  },
  {
    title: '结束原因',
    key: 'endReason',
    width: 120,
    render: (row) => leaseEndReasonText(row.endReason),
  },
])
</script>

<template>
  <NDataTable
    class="lease-table"
    :columns="columns"
    :data="props.rows"
    :loading="loading"
    :row-key="(row: ComputeLeaseRow) => row.id"
    :scroll-x="760"
    table-layout="fixed"
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
:deep(.lease__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.lease__nowrap) {
  white-space: nowrap;
}

:deep(.lease__plan) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
