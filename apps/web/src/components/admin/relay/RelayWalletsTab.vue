<script setup lang="ts">
import type { RelayLedgerRow, RelayWalletRow } from '@dsh-hub/shared'
import { NButton, NDataTable, NInput, NSelect, type DataTableColumns } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'

import { listRelayLedger, listRelayWallets } from '@/api/admin-relay'
import LedgerTable from '@/components/relay/LedgerTable.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import WalletAdjustDialog from '@/components/admin/relay/WalletAdjustDialog.vue'
import WalletSettingsDialog from '@/components/admin/relay/WalletSettingsDialog.vue'
import UserCell from '@/components/admin/UserCell.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { useTableQuery } from '@/composables/table-query'
import { formatCount, formatDateTime, fromNow } from '@/composables/useFormat'
import { formatPoints, microToPointsInput } from '@/utils/points'

/**
 * 中转站 · 积分（12 §10）：钱包表（可按余额/本月消耗排序、搜索用户）、
 * 「加/扣积分」弹窗、「设置」弹窗（倍率 / 并发 / 日上限 / 启用）、流水表（可按用户筛选）。
 */
const props = withDefaults(defineProps<{ focusUserId?: number | null }>(), { focusUserId: null })

const WALLET_DEFAULTS = { q: '', sort: 'lastUsed', page: 1, pageSize: 20 }
const LEDGER_DEFAULTS = { userId: 0, page: 1, pageSize: 20 }

const walletQuery = useTableQuery({ ...WALLET_DEFAULTS })
const ledgerQuery = useTableQuery({ ...LEDGER_DEFAULTS })

const { data, loading, reload } = useAsyncData(() =>
  listRelayWallets({
    q: walletQuery.state.value.q,
    sort: walletQuery.state.value.sort as 'balance' | 'monthCost' | 'lastUsed' | 'username',
    page: walletQuery.state.value.page,
    pageSize: walletQuery.state.value.pageSize,
  }),
)

const wallets = computed<RelayWalletRow[]>(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)

const ledger = ref<RelayLedgerRow[]>([])
const ledgerTotal = ref(0)
const ledgerLoading = ref(false)

const search = ref(walletQuery.state.value.q)
const debouncedSearch = useDebounceFn(() => void walletQuery.update({ q: search.value }), 300)

watch(search, () => debouncedSearch())
watch(
  () => [walletQuery.state.value.q, walletQuery.state.value.sort, walletQuery.state.value.page, walletQuery.state.value.pageSize],
  () => void reload(),
)
watch(
  () => [ledgerQuery.state.value.userId, ledgerQuery.state.value.page, ledgerQuery.state.value.pageSize],
  () => void loadLedger(),
  { immediate: true },
)

// 从用户详情跳进来（?tab=wallets&userId=…）：直接把流水筛到这个人
watch(
  () => props.focusUserId,
  (id) => {
    if (id === null || id === undefined) return
    void ledgerQuery.update({ userId: id, page: 1 })
  },
  { immediate: true },
)

async function loadLedger(): Promise<void> {
  ledgerLoading.value = true
  try {
    const userId = ledgerQuery.state.value.userId
    const result = await listRelayLedger({
      userId: userId > 0 ? userId : undefined,
      page: ledgerQuery.state.value.page,
      pageSize: ledgerQuery.state.value.pageSize,
    })
    ledger.value = result.items
    ledgerTotal.value = result.total
  } finally {
    ledgerLoading.value = false
  }
}

// ── 弹窗 ──

const adjustTarget = ref<RelayWalletRow | null>(null)
const showAdjust = ref(false)
const settingsTarget = ref<RelayWalletRow | null>(null)
const showSettings = ref(false)

function openAdjust(wallet: RelayWalletRow): void {
  adjustTarget.value = wallet
  showAdjust.value = true
}

function openSettings(wallet: RelayWalletRow): void {
  settingsTarget.value = wallet
  showSettings.value = true
}

function onSaved(): void {
  void reload()
  void loadLedger()
}

const userOptions = computed(() => [
  { label: '全部用户', value: 0 },
  ...wallets.value.map((wallet) => ({
    label: `${wallet.displayName || wallet.username}（@${wallet.username}）`,
    value: wallet.userId,
  })),
])

function dailyLimitText(wallet: RelayWalletRow): string {
  return wallet.dailyLimitMicro === null ? '不限' : `${microToPointsInput(wallet.dailyLimitMicro)} 积分`
}

const columns = computed<DataTableColumns<RelayWalletRow>>(() => [
  {
    title: '用户',
    key: 'username',
    minWidth: 170,
    render: (row) =>
      h(UserCell, {
        user: {
          id: row.userId,
          username: row.username,
          displayName: row.displayName,
          avatarUrl: row.avatarUrl,
        },
        to: `/admin/users/${row.userId}`,
      }),
  },
  {
    title: '余额（积分）',
    key: 'balanceMicro',
    width: 130,
    align: 'right',
    render: (row) =>
      h(
        'span',
        { class: row.balanceMicro < 0 ? 'wallets__balance wallets__balance--minus' : 'wallets__balance' },
        formatPoints(row.balanceMicro),
      ),
  },
  {
    title: '倍率',
    key: 'ratePercent',
    width: 90,
    align: 'right',
    render: (row) => `${row.ratePercent}%`,
  },
  {
    title: '并发',
    key: 'maxConcurrency',
    width: 90,
    align: 'right',
    render: (row) => (row.maxConcurrency === null ? '默认' : String(row.maxConcurrency)),
  },
  {
    title: '日上限',
    key: 'dailyLimitMicro',
    width: 120,
    align: 'right',
    render: (row) => dailyLimitText(row),
  },
  {
    title: '今日 / 本月',
    key: 'monthCostMicro',
    width: 160,
    align: 'right',
    render: (row) =>
      h('div', { class: 'wallets__cost' }, [
        h('span', null, `${formatPoints(row.todayCostMicro)} / ${formatPoints(row.monthCostMicro)}`),
        h('span', { class: 'wallets__cost-sub' }, `本月 ${formatCount(row.monthRequests)} 次请求`),
      ]),
  },
  {
    title: '最近使用',
    key: 'lastUsedAt',
    width: 130,
    render: (row) =>
      h('span', { title: row.lastUsedAt ? formatDateTime(row.lastUsedAt) : '' }, row.lastUsedAt ? fromNow(row.lastUsedAt) : '从未使用'),
  },
  {
    title: '状态',
    key: 'enabled',
    width: 90,
    render: (row) =>
      h(MiniTag, { text: row.enabled ? '启用' : '已停用', tone: row.enabled ? 'success' : 'neutral', size: 'sm' }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'wallets__actions' }, [
        h(NButton, { size: 'tiny', type: 'primary', ghost: true, onClick: () => openAdjust(row) }, { default: () => '加 / 扣积分' }),
        h(NButton, { size: 'tiny', quaternary: true, onClick: () => openSettings(row) }, { default: () => '设置' }),
      ]),
  },
])
</script>

<template>
  <div class="wallets">
    <div class="wallets__bar">
      <NInput
        v-model:value="search"
        size="small"
        clearable
        placeholder="搜索用户名 / 昵称"
        class="wallets__search"
        aria-label="搜索用户"
      />
      <NSelect
        v-model:value="walletQuery.state.value.sort"
        size="small"
        class="wallets__sort"
        :options="[
          { label: '按最近使用', value: 'lastUsed' },
          { label: '按余额', value: 'balance' },
          { label: '按本月消耗', value: 'monthCost' },
          { label: '按用户名', value: 'username' },
        ]"
        @update:value="(value: string) => walletQuery.update({ sort: value })"
      />
      <span class="wallets__count">共 {{ total }} 个用户</span>
      <NButton size="small" :loading="loading" @click="reload">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </div>

    <SoftCard :padded="false">
      <NDataTable
        class="wallets__table"
        :columns="columns"
        :data="wallets"
        :loading="loading"
        :row-key="(row: RelayWalletRow) => row.userId"
        :scroll-x="1180"
        remote
        size="small"
        :pagination="{
          page: walletQuery.state.value.page,
          pageSize: walletQuery.state.value.pageSize,
          itemCount: total,
          showSizePicker: true,
          pageSizes: [20, 50, 100],
          prefix: ({ itemCount }: { itemCount?: number }) => `共 ${itemCount ?? 0} 条`,
          onUpdatePage: (page: number) => walletQuery.update({ page }),
          onUpdatePageSize: (pageSize: number) => walletQuery.update({ pageSize, page: 1 }),
        }"
      />
    </SoftCard>

    <SoftCard title="积分流水">
      <template #extra>
        <NSelect
          v-model:value="ledgerQuery.state.value.userId"
          size="small"
          class="wallets__ledger-filter"
          :options="userOptions"
          @update:value="(value: number) => ledgerQuery.update({ userId: value, page: 1 })"
        />
      </template>
      <LedgerTable
        scope="admin"
        :rows="ledger"
        :total="ledgerTotal"
        :page="ledgerQuery.state.value.page"
        :page-size="ledgerQuery.state.value.pageSize"
        :loading="ledgerLoading"
        @page-change="(page: number) => ledgerQuery.update({ page })"
        @page-size-change="(pageSize: number) => ledgerQuery.update({ pageSize, page: 1 })"
      />
    </SoftCard>

    <WalletAdjustDialog v-model:show="showAdjust" :wallet="adjustTarget" @saved="onSaved" />
    <WalletSettingsDialog v-model:show="showSettings" :wallet="settingsTarget" @saved="onSaved" />
  </div>
</template>

<style scoped>
.wallets {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.wallets__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.wallets__search {
  width: 220px;
}

.wallets__sort {
  width: 160px;
}

.wallets__count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.wallets__ledger-filter {
  width: 200px;
}

.wallets__table {
  padding: var(--space-2) var(--space-3);
}

:deep(.wallets__balance) {
  font-family: var(--font-mono);
}

:deep(.wallets__balance--minus) {
  color: var(--c-danger-ink);
  font-weight: var(--fw-semibold);
}

:deep(.wallets__cost) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.wallets__cost-sub) {
  color: var(--c-text-3);
  font-size: 11px;
}

:deep(.wallets__actions) {
  display: flex;
  gap: 4px;
}
</style>
