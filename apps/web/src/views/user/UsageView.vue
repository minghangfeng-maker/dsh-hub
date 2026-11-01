<script setup lang="ts">
import type {
  ComputeLeaseRow,
  MyRelayResponse,
  RelayKey,
  RelayScope,
  RelayUsageRow,
  RelayUsageStatsResponse,
  ToolUsageRow,
} from '@dsh-hub/shared'
import { RELAY_MAX_RANGE_DAYS } from '@dsh-hub/shared'
import { NButton } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'

import { describeError, type ErrorDescription } from '@/api/errors'
import { fetchMyCompute, listMyComputeLeases } from '@/api/compute'
import { fetchMyRelay, fetchMyRelayUsage, listMyRelayKeys, listMyRelayLogs } from '@/api/relay'
import { listMyToolUsage } from '@/api/tools'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import PageHeader from '@/components/base/PageHeader.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import AgentModeModelsSection from '@/components/user/relay/AgentModeModelsSection.vue'
import RelayAccessGuide from '@/components/user/relay/RelayAccessGuide.vue'
import RelayKeysPanel from '@/components/user/relay/RelayKeysPanel.vue'
import RelayModelsTable from '@/components/user/relay/RelayModelsTable.vue'
import RelayStatsCards from '@/components/user/relay/RelayStatsCards.vue'
import ToolsCard from '@/components/user/tools/ToolsCard.vue'
import ModelUsageSection from '@/components/user/usage/ModelUsageSection.vue'
import UsageRecordsCard, {
  type LogFilters,
  type UsageLogTab,
} from '@/components/user/usage/UsageRecordsCard.vue'
import { useRelayStatus } from '@/composables/useRelayStatus'
import { useTableQuery } from '@/composables/table-query'
import { clampDayRange, dayOffset } from '@/utils/relay-day'

/**
 * 「积分与用量」`/usage`（12 §10；**19 §1 重排为五块**）：
 * ① 积分（`RelayStatsCards`）→ ② 模型消耗（筛选 + 多模型图 + 按模型表）→ ③ 可用模型 →
 * ④ 搜索与抓取（只显示本月用量三格）→ ⑤ 使用记录（模型调用 / 搜索与抓取 / 算力租赁）。
 *
 * 19 D2：**积分流水**不渲染、不请求（接口与 `LedgerTable` 保留）。
 * 19 D3：**外接**（API 密钥、接入说明）由 {@link SHOW_EXTERNAL_ACCESS} 控制，现在是 `false`；
 * 组件与接口都保留，以后改成 `true` 即恢复原样。
 * `enabled=false`（管理端没开通或钱包被停用）时整页显示未开通空状态。
 */
const SHOW_EXTERNAL_ACCESS: boolean = false

/** 「模型调用」日期区间最长天数（与后端一致：92 × 4） */
const LOG_MAX_RANGE_DAYS = RELAY_MAX_RANGE_DAYS * 4

const { setRelaySummary } = useRelayStatus()

/** 搜索与抓取卡片（自己拉 `/api/me/tools`；页头刷新时一起刷） */
const toolsCard = ref<{ reload: () => Promise<void> } | null>(null)

const relay = ref<MyRelayResponse | null>(null)
const loading = ref(true)
const errorDesc = ref<ErrorDescription | null>(null)

/** 18 §7：对我开通的对话模式；为空时整页与开通前完全一样 */
const agentModes = computed(() => relay.value?.agentModes ?? [])

/** 19 D3：外接（API 密钥 / 接入说明）——只在这个常量打开时才请求与渲染 */
const keys = ref<RelayKey[]>([])
const keysLoading = ref(false)

async function loadKeys(): Promise<void> {
  keysLoading.value = true
  try {
    // 18 §7：非 dsh 作用域的 system 密钥（Claude Code / Codex）不给用户看
    keys.value = (await listMyRelayKeys()).filter((key) => !key.scope || key.scope === 'dsh')
  } catch (error) {
    errorDesc.value = describeError(error)
  } finally {
    keysLoading.value = false
  }
}

// ── ② 模型消耗 ──────────────────────────────────────────────────────────────

const usage = ref<RelayUsageStatsResponse | null>(null)
const usageLoading = ref(false)
/** 由 `ModelUsageSection` 给出的当前查询（只有来源 / 区间会变） */
const usageQuery = ref<{ from: string; to: string; scope: RelayScope | undefined } | null>(null)

function onUsageQuery(payload: { from: string; to: string; scope: RelayScope | undefined }): void {
  usageQuery.value = payload
  void loadUsage()
}

async function loadUsage(): Promise<void> {
  const query = usageQuery.value
  if (!relay.value?.enabled || !query) return
  usageLoading.value = true
  try {
    usage.value = await fetchMyRelayUsage({
      from: query.from,
      to: query.to,
      ...(query.scope === undefined ? {} : { scope: query.scope }),
    })
  } catch (error) {
    errorDesc.value = describeError(error)
  } finally {
    usageLoading.value = false
  }
}

// ── ⑤ 使用记录 ──────────────────────────────────────────────────────────────

const RECORD_DEFAULTS = {
  page: 1,
  pageSize: 20,
  log: 'calls',
  logFrom: '',
  logTo: '',
  logScope: '',
  logModel: '',
  logStatus: '',
}

const recordsQuery = useTableQuery({ ...RECORD_DEFAULTS })

const logs = ref<RelayUsageRow[]>([])
const logsTotal = ref(0)
const logsLoading = ref(false)

/** 搜索与抓取标签（搜索池开着才有）；总开关状态由 `ToolsCard` 上报，避免重复请求 */
const toolsEnabled = ref(false)
const toolRows = ref<ToolUsageRow[]>([])
const toolTotal = ref(0)
const toolLoading = ref(false)
const toolPage = ref(1)
const toolPageSize = ref(20)

/** 算力租赁标签：计费开着或有历史才有 */
const leases = ref<ComputeLeaseRow[]>([])
const leasesTotal = ref(0)
const leasesLoading = ref(false)
const leasePage = ref(1)
const leasePageSize = ref(20)
const computeBillingEnabled = ref(false)

const logTab = computed<UsageLogTab>(() => {
  const value = recordsQuery.state.value.log
  return value === 'tools' || value === 'compute' ? value : 'calls'
})

const showCompute = computed(() => computeBillingEnabled.value || leasesTotal.value > 0)
const showTools = computed(() => toolsEnabled.value)

/** 「模型调用」筛选（日期缺省 = 最近 30 天，最长 92 × 4 天） */
const LOG_DEFAULT_DAYS = 30

const logFilters = computed<LogFilters>(() => {
  const state = recordsQuery.state.value
  // 没选过日期 = 最近 30 天；选过之后按 92 × 4 天的上限收一次
  const range =
    state.logFrom === '' && state.logTo === ''
      ? { from: dayOffset(LOG_DEFAULT_DAYS - 1), to: dayOffset(0) }
      : clampDayRange(state.logFrom, state.logTo, LOG_MAX_RANGE_DAYS)
  return {
    from: range.from,
    to: range.to,
    scope: state.logScope,
    model: state.logModel,
    status: state.logStatus,
  }
})

/** 「模型」下拉：可用模型名 + 路由展开的 `模型@渠道`（18 §7 / 16 §4） */
const logModelOptions = computed(() => {
  const options: { label: string; value: string }[] = []
  for (const model of relay.value?.models ?? []) {
    options.push({ label: model.name, value: model.name })
    for (const route of model.routes ?? []) {
      options.push({ label: route.pinnedModel, value: route.pinnedModel })
    }
  }
  return options
})

async function loadLogs(): Promise<void> {
  if (!relay.value?.enabled) return
  logsLoading.value = true
  const state = recordsQuery.state.value
  const range = logFilters.value
  try {
    const result = await listMyRelayLogs({
      from: range.from,
      to: range.to,
      ...(range.scope === '' ? {} : { scope: range.scope as RelayScope }),
      ...(range.model === '' ? {} : { model: range.model }),
      ...(range.status === '' ? {} : { status: range.status as RelayUsageRow['status'] }),
      page: state.page,
      pageSize: state.pageSize,
    })
    logs.value = result.items
    logsTotal.value = result.total
  } catch (error) {
    errorDesc.value = describeError(error)
  } finally {
    logsLoading.value = false
  }
}

async function loadToolUsage(): Promise<void> {
  if (!relay.value?.enabled || !toolsEnabled.value) return
  toolLoading.value = true
  try {
    const result = await listMyToolUsage({ page: toolPage.value, pageSize: toolPageSize.value })
    toolRows.value = result.items
    toolTotal.value = result.total
  } catch (error) {
    errorDesc.value = describeError(error)
  } finally {
    toolLoading.value = false
  }
}

/**
 * 算力租赁：先看计费开关（决定要不要显示这张表 / 标签），再拉第一页。
 * 接口读不到（例如还没上线）时静默隐藏，不影响积分与用量的其他部分。
 */
async function loadCompute(): Promise<void> {
  try {
    const summary = await fetchMyCompute()
    computeBillingEnabled.value = summary.billingEnabled
  } catch {
    computeBillingEnabled.value = false
  }
  await loadLeases()
}

async function loadLeases(): Promise<void> {
  leasesLoading.value = true
  try {
    const result = await listMyComputeLeases({ page: leasePage.value, pageSize: leasePageSize.value })
    leases.value = result.items
    leasesTotal.value = result.total
  } catch {
    // 历史表是附加信息：读不到就当没有，不打断整页
  } finally {
    leasesLoading.value = false
  }
}

function changeLeasePageSize(size: number): void {
  // 同一 tick 里改两个值，上面两个 watch 会合并成一次请求
  leasePageSize.value = size
  leasePage.value = 1
}

function changeToolPageSize(size: number): void {
  toolPageSize.value = size
  toolPage.value = 1
}

function onFiltersChange(filters: LogFilters): void {
  void recordsQuery.update({
    logFrom: filters.from,
    logTo: filters.to,
    logScope: filters.scope,
    logModel: filters.model,
    logStatus: filters.status,
  })
}

function onTabChange(tab: UsageLogTab): void {
  // 切标签不动「模型调用」的分页（19 §2.5：其他两个标签页内自管分页）
  void recordsQuery.update({ log: tab }, { resetPage: false })
}

watch(
  () => [
    recordsQuery.state.value.logFrom,
    recordsQuery.state.value.logTo,
    recordsQuery.state.value.logScope,
    recordsQuery.state.value.logModel,
    recordsQuery.state.value.logStatus,
    recordsQuery.state.value.page,
    recordsQuery.state.value.pageSize,
  ],
  () => void loadLogs(),
)

watch(
  [logTab, toolsEnabled],
  () => {
    if (logTab.value === 'tools') void loadToolUsage()
  },
  { immediate: true },
)

watch(toolPage, () => void loadToolUsage())
watch(toolPageSize, () => void loadToolUsage())
watch(leasePage, () => void loadLeases())
watch(leasePageSize, () => void loadLeases())

// ── 加载 ────────────────────────────────────────────────────────────────────

async function loadRelay(): Promise<void> {
  loading.value = true
  try {
    const data = await fetchMyRelay()
    relay.value = data
    setRelaySummary(data)
    errorDesc.value = null
    if (data.enabled) {
      await Promise.all([
        loadUsage(),
        loadLogs(),
        loadCompute(),
        SHOW_EXTERNAL_ACCESS ? loadKeys() : Promise.resolve(),
      ])
    } else {
      await loadCompute()
    }
  } catch (error) {
    errorDesc.value = describeError(error)
  } finally {
    loading.value = false
  }
}

function reloadAll(): void {
  void loadRelay()
  void loadLogs()
  void loadUsage()
  void loadCompute()
  void loadToolUsage()
  if (SHOW_EXTERNAL_ACCESS) void loadKeys()
  void toolsCard.value?.reload()
}

onMounted(() => {
  void loadRelay()
})
</script>

<template>
  <div class="usage">
    <PageHeader title="积分与用量">
      <template #actions>
        <NButton size="small" :loading="loading" @click="reloadAll">刷新</NButton>
      </template>
    </PageHeader>

    <AdminErrorNotice :error="errorDesc" title="加载失败" @retry="reloadAll" />

    <SoftCard v-if="loading && !relay">
      <p class="text-2">正在读取中转站信息…</p>
    </SoftCard>

    <EmptyState
      v-else-if="relay && !relay.enabled"
      illustration="cloud"
      title="中转站未开通"
      description="请找管理员开通；开通后这里会显示余额、用量和你的 API 密钥。"
    />

    <template v-else-if="relay">
      <!-- ① 积分（19 §2.1）：负余额提示只在卡片内那一句，不再有页面顶部 NAlert -->
      <RelayStatsCards :wallet="relay.wallet" :today="relay.today" :month="relay.month" />

      <!-- ② 模型消耗（19 §2.2） -->
      <SoftCard title="模型消耗">
        <ModelUsageSection
          :usage="usage"
          :loading="usageLoading"
          :show-scope="agentModes.length > 0"
          :models="relay.models"
          @query="onUsageQuery"
        />
      </SoftCard>

      <!-- ③ 可用模型（19 §2.3）：原样 -->
      <SoftCard title="可用模型">
        <RelayModelsTable
          :models="relay.models"
          :loading="loading"
          :wallet-rate-percent="relay.wallet.ratePercent"
        />
        <!-- 18 §7：对我开通的 Claude Code / Codex 各一节（没开通时不渲染） -->
        <AgentModeModelsSection
          v-if="agentModes.length > 0"
          :modes="agentModes"
          :wallet-rate-percent="relay.wallet.ratePercent"
        />
      </SoftCard>

      <!-- 19 D3：外接（API 密钥 / 接入说明）先隐藏，组件与接口都保留 -->
      <template v-if="SHOW_EXTERNAL_ACCESS">
        <SoftCard title="API 密钥">
          <RelayKeysPanel :keys="keys" :loading="keysLoading" @changed="loadKeys" />
        </SoftCard>

        <SoftCard title="接入说明">
          <RelayAccessGuide :public-base-url="relay.publicBaseUrl" :dsh-attached="relay.dshAttached" />
        </SoftCard>
      </template>

      <!-- ④ 搜索与抓取（19 §2.4）：只剩三格用量 -->
      <ToolsCard ref="toolsCard" @update:enabled="toolsEnabled = $event" />

      <!-- ⑤ 使用记录（19 §2.5） -->
      <UsageRecordsCard
        :tab="logTab"
        :show-source="agentModes.length > 0"
        :calls="{
          rows: logs,
          total: logsTotal,
          loading: logsLoading,
          page: recordsQuery.state.value.page,
          pageSize: recordsQuery.state.value.pageSize,
        }"
        :tools="
          showTools
            ? {
                rows: toolRows,
                total: toolTotal,
                loading: toolLoading,
                page: toolPage,
                pageSize: toolPageSize,
              }
            : null
        "
        :compute="
          showCompute
            ? {
                rows: leases,
                total: leasesTotal,
                loading: leasesLoading,
                page: leasePage,
                pageSize: leasePageSize,
              }
            : null
        "
        :filters="logFilters"
        :model-options="logModelOptions"
        :max-range-days="LOG_MAX_RANGE_DAYS"
        @tab-change="onTabChange"
        @filters-change="onFiltersChange"
        @calls-page="(page: number) => recordsQuery.update({ page })"
        @calls-page-size="(pageSize: number) => recordsQuery.update({ pageSize, page: 1 })"
        @tools-page="(page: number) => (toolPage = page)"
        @tools-page-size="changeToolPageSize"
        @compute-page="(page: number) => (leasePage = page)"
        @compute-page-size="changeLeasePageSize"
      />
    </template>
  </div>
</template>

<style scoped>
.usage {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
