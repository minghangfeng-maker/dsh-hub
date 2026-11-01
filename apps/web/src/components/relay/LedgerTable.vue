<script setup lang="ts">
import type { RelayLedgerRow, RelayLedgerType } from '@dsh-hub/shared'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import { TONE_VARS, type AdminTone } from '@/components/admin/tone'
import { formatDateTime } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'

/**
 * 积分流水表（12 §10）：增加 / 扣减 / 注册赠送，带调整后余额与操作者。
 * 用户端与管理端共用（管理端多一列「用户」）。
 */
const props = withDefaults(
  defineProps<{
    rows: RelayLedgerRow[]
    total: number
    page: number
    pageSize: number
    loading?: boolean
    scope?: 'user' | 'admin'
  }>(),
  { loading: false, scope: 'user' },
)

const emit = defineEmits<{
  'page-change': [page: number]
  'page-size-change': [pageSize: number]
}>()

const TYPE_TEXT: Record<RelayLedgerType, string> = {
  grant: '增加',
  deduct: '扣减',
  signup: '注册赠送',
  daily: '每日赠送',
  expire: '赠送作废',
  compute: '算力租赁',
}
const TYPE_TONE: Record<RelayLedgerType, AdminTone> = {
  grant: 'success',
  deduct: 'danger',
  signup: 'sky',
  daily: 'sky',
  expire: 'neutral',
  compute: 'danger',
}

const columns = computed<DataTableColumns<RelayLedgerRow>>(() => {
  const list: DataTableColumns<RelayLedgerRow> = [
    {
      title: '时间',
      key: 'createdAt',
      width: 150,
      render: (row) => h('span', { class: 'ledger__nowrap' }, formatDateTime(row.createdAt)),
    },
  ]

  if (props.scope === 'admin') {
    list.push({
      title: '用户',
      key: 'username',
      width: 140,
      render: (row) => h('span', { class: 'ledger__mono' }, row.username),
    })
  }

  list.push(
    {
      title: '类型',
      key: 'type',
      width: 110,
      render: (row) => {
        const tone = TONE_VARS[TYPE_TONE[row.type]]
        return h(
          'span',
          {
            class: 'ledger__type',
            style: { '--tag-color': tone.ink, '--tag-soft': tone.soft },
          },
          TYPE_TEXT[row.type],
        )
      },
    },
    {
      title: '金额（积分）',
      key: 'amountMicro',
      width: 130,
      align: 'right',
      render: (row) =>
        h(
          'span',
          { class: row.amountMicro < 0 ? 'ledger__amount ledger__amount--minus' : 'ledger__amount' },
          `${row.amountMicro > 0 ? '+' : ''}${formatPoints(row.amountMicro)}`,
        ),
    },
    {
      title: '调整后余额',
      key: 'balanceAfterMicro',
      width: 130,
      align: 'right',
      render: (row) => h('span', { class: 'ledger__mono' }, formatPoints(row.balanceAfterMicro)),
    },
    { title: '备注', key: 'note', minWidth: 160, render: (row) => row.note || '—' },    {
      title: '操作者',
      key: 'actor',
      width: 110,
      render: (row) => row.actor ?? '系统',
    },
  )

  return list
})
</script>

<template>
  <NDataTable
    class="ledger"
    :columns="columns"
    :data="rows"
    :loading="loading"
    :row-key="(row: RelayLedgerRow) => row.id"
    :scroll-x="scope === 'admin' ? 920 : 780"
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
:deep(.ledger__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.ledger__nowrap) {
  white-space: nowrap;
}

:deep(.ledger__amount) {
  font-family: var(--font-mono);
  font-weight: var(--fw-semibold);
  color: var(--c-success-ink);
  white-space: nowrap;
}

:deep(.ledger__amount--minus) {
  color: var(--c-danger-ink);
}

:deep(.ledger__type) {
  display: inline-flex;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--tag-soft);
  color: var(--tag-color);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
}
</style>
