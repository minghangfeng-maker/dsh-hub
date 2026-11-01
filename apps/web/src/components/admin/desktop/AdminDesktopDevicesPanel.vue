<script setup lang="ts">
import type {
  DesktopBatchRevokeItem,
  DesktopDeviceAdminItem,
  DesktopPlatform,
  DesktopPresence,
} from '@dsh-hub/shared'
import { DESKTOP_BATCH_REVOKE_MAX } from '@dsh-hub/shared'
import { useDebounceFn } from '@vueuse/core'
import {
  NAlert,
  NButton,
  NDataTable,
  NInput,
  NPopconfirm,
  NSelect,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref, watch } from 'vue'

import {
  listAdminDesktopDevices,
  revokeAdminDesktopDevice,
  revokeAdminDesktopDevices,
} from '@/api/desktop'
import { describeError } from '@/api/errors'
import AdminDesktopDeviceDrawer from '@/components/admin/desktop/AdminDesktopDeviceDrawer.vue'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import UserCell from '@/components/admin/UserCell.vue'
import type { AdminTone } from '@/components/admin/tone'
import {
  applyErrorText,
  applyStateText,
  applyStateTone,
  archText,
  channelText,
  presenceText,
  presenceTone,
  revokeReasonText,
  systemText,
} from '@/components/desktop/text'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { useTableQuery } from '@/composables/table-query'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'

/**
 * 管理端「实例 → 桌面设备」（WP25c 交付物 3 + WP25f 交付物 1/2；数据来自 `GET /api/admin/desktop-devices`）。
 *
 * 为什么是**标签页**而不是与云端实例合并成一张表（D6 §6.1 曾设想分段控件）：
 * 云端实例是一人一台、整表一次拉回、前端自己算状态；桌面设备是**服务端分页 + 四个筛选维度**
 * 的台账（`q / presence / platform / appVersion`），合并后分页与「在线/离线」语义会被云端那半边污染
 * （云端没有分页，也没有离线概念）。07 §7.4 只定义了云端实例的卡片/表格两种形态，所以这里按
 * 「实例页 = 云端实例 + 桌面设备两个标签」组织，各用各自合适的控件。
 *
 * 筛选与分页同步到地址栏（`?platform=desktop&presence=online&page=2`，非表格键原样保留），
 * 便于把「某人的设备」直接发给同事；平台切换本身归 `composables/admin-platform.ts`。
 *
 * 三个交互（WP25f）：
 * - **点一行看详情**（抽屉：台账 + 插件 + 最近 20 条审计；抽屉里也能吊销）；
 * - **批量吊销**：勾选列（本页全选、已吊销不可选）→ 上限 50 → 二次确认 → `withReauth` → 逐台结果；
 *   `not_found` / `failed` 一起按「未生效」列出并可只重试这几台（WP25e 建议）；
 * - 单台吊销保留（`withReauth`：服务端一旦要求二次密码，这里自动弹框并重试原请求）。
 */
const message = useMessage()

const DEFAULTS = {
  q: '',
  presence: '',
  platform: '',
  version: '',
  page: 1,
  pageSize: 20,
}
type DesktopQuery = typeof DEFAULTS

const { state, update, reset } = useTableQuery<DesktopQuery>(DEFAULTS)

/**
 * 「状态」筛选与契约的 `presence` / `revoked` 的关系：
 * - 全部 → `revoked=active`，即「在用设备」（在线 + 离线），已吊销的是历史，不混进来；
 * - 已吊销 → `presence=revoked` + `revoked=all`（只写 active 会被两个条件互相抵消，得到空列表）。
 */
const revokedScope = computed<'active' | 'all'>(() => (state.value.presence === 'revoked' ? 'all' : 'active'))

const { data, loading, error, reload } = useAsyncData(
  () =>
    listAdminDesktopDevices({
      q: state.value.q || undefined,
      presence: (state.value.presence || undefined) as DesktopPresence | undefined,
      revoked: revokedScope.value,
      platform: (state.value.platform || undefined) as DesktopPlatform | undefined,
      appVersion: state.value.version || undefined,
      page: state.value.page,
      pageSize: state.value.pageSize,
    }),
  { pollMs: 10_000 },
)

const rows = computed<DesktopDeviceAdminItem[]>(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)

/** 搜索框独立于 URL 状态：输入 300ms 防抖后才写进地址栏并请求 */
const searchInput = ref(state.value.q)
watch(
  () => state.value.q,
  (value) => {
    if (value !== searchInput.value) searchInput.value = value
  },
)
const applySearch = useDebounceFn((value: string) => update({ q: value }), 300)
watch(searchInput, (value) => {
  if (value !== state.value.q) applySearch(value)
})

/** 版本号是精确匹配（服务端 `app_version = ?`），所以只在回车/失焦时提交，并先按契约校验格式 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const versionInput = ref(state.value.version)
const versionError = ref('')
watch(
  () => state.value.version,
  (value) => {
    if (value !== versionInput.value) versionInput.value = value
  },
)
function applyVersion(): void {
  const value = versionInput.value.trim()
  if (value.length > 0 && !VERSION_RE.test(value)) {
    versionError.value = '版本号格式应为 1.2.3 或 1.2.3-rc.1'
    return
  }
  versionError.value = ''
  void update({ version: value })
}

const presenceOptions = [
  { label: '全部状态', value: '' },
  { label: '在线', value: 'online' },
  { label: '离线', value: 'offline' },
  { label: '已吊销', value: 'revoked' },
]

const platformOptions = [
  { label: '全部系统', value: '' },
  { label: 'Windows', value: 'win32' },
  { label: 'macOS', value: 'darwin' },
  { label: 'Linux', value: 'linux' },
]

/** 列表里只显示 `dv_0000…0010` 这种短形；完整 id 在悬停提示里（07 §2.8：标识符单行省略） */
function shortDeviceId(deviceId: string): string {
  return deviceId.length > 12 ? `${deviceId.slice(0, 7)}…${deviceId.slice(-4)}` : deviceId
}

function tagCell(text: string, tone: AdminTone) {
  return h(MiniTag, { text, tone, size: 'sm' })
}

/** 应用状态：失败时把错误码的中文挂在 title 上（不额外占一行） */
function applyCell(row: DesktopDeviceAdminItem) {
  const { device } = row
  const text = applyStateText(device.applyState)
  const title =
    device.applyState === 'failed'
      ? applyErrorText(device.applyErrorCode)
      : `revision ${device.appliedRevision ?? '—'}`
  return h('span', { class: 'admin-desktop__apply', title }, [
    h(MiniTag, { text, tone: applyStateTone(device.applyState), size: 'sm' }),
  ])
}

// ── 详情抽屉 ────────────────────────────────────────────────────────────────

const detailShow = ref(false)
const detailId = ref<string | null>(null)

function openDetail(row: DesktopDeviceAdminItem): void {
  detailId.value = row.device.deviceId
  detailShow.value = true
}

/** 行点击打开详情；点行内按钮（吊销 / 勾选）不算（那些有自己的动作） */
function rowProps(row: DesktopDeviceAdminItem) {
  return {
    style: 'cursor: pointer',
    onClick: (event: MouseEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest('button, .n-checkbox, a')) return
      openDetail(row)
    },
  }
}

async function onDetailRevoked(): Promise<void> {
  await reload()
}

// ── 单台吊销 ────────────────────────────────────────────────────────────────

const revoking = ref<string | null>(null)

async function revoke(row: DesktopDeviceAdminItem): Promise<void> {
  revoking.value = row.device.deviceId
  try {
    await withReauth(() => revokeAdminDesktopDevice(row.device.deviceId), {
      title: '吊销设备',
      description: `吊销 ${row.device.name} 后，这台桌面端会立即退出登录，本地文件与会话不受影响。`,
      confirmText: '吊销',
      type: 'warning',
    })
    message.success(`${row.device.name} 已吊销`)
    await reload()
  } catch (error) {
    if (!isReauthCanceled(error)) message.error(describeError(error).message)
  } finally {
    revoking.value = null
  }
}

// ── 批量吊销（WP25f 交付物 2）────────────────────────────────────────────────

/** 勾选的设备（`row-key` = deviceId）；已吊销的行在表格层就不可勾选 */
const checked = ref<string[]>([])

/** 换页 / 换筛选后，把已经不在本页的勾选丢掉（否则「吊销所选」会带上看不见的设备） */
watch(rows, (next) => {
  if (checked.value.length === 0) return
  const live = new Set(next.filter((row) => row.device.revokedAt === null).map((row) => row.device.deviceId))
  const kept = checked.value.filter((deviceId) => live.has(deviceId))
  if (kept.length !== checked.value.length) checked.value = kept
})

interface BatchOutcomeRow {
  deviceId: string
  name: string
  outcome: DesktopBatchRevokeItem['outcome']
}

/** 一次批量吊销的结果（只存展示需要的最少信息：名称是**提交前**的快照，吊销后列表里就没有它了） */
const batchResult = ref<{ rows: BatchOutcomeRow[]; revoked: number } | null>(null)
const batching = ref(false)

/** 未生效的那些（`not_found` + `failed`）：可以只重试这几台 */
const PENDING_OUTCOMES: readonly DesktopBatchRevokeItem['outcome'][] = ['not_found', 'failed']

const pendingRows = computed<BatchOutcomeRow[]>(
  () => batchResult.value?.rows.filter((row) => PENDING_OUTCOMES.includes(row.outcome)) ?? [],
)

const outcomeText: Record<DesktopBatchRevokeItem['outcome'], string> = {
  revoked: '已吊销',
  already_revoked: '此前已吊销',
  // WP25e 建议：not_found 与 failed 一起按「未生效」说，别让管理员以为设备被吊销了
  not_found: '未生效 · 设备不存在',
  failed: '未生效 · 服务端出错',
}

const outcomeTone: Record<DesktopBatchRevokeItem['outcome'], AdminTone> = {
  revoked: 'success',
  already_revoked: 'neutral',
  not_found: 'danger',
  failed: 'danger',
}

/** 提交前给每台拍个名字快照（响应里 `not_found` 没有设备行，吊销成功后列表也会把它筛掉） */
function nameSnapshot(): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of rows.value) names.set(row.device.deviceId, row.device.name)
  return names
}

function toOutcomeRows(
  items: DesktopBatchRevokeItem[],
  names: Map<string, string>,
): BatchOutcomeRow[] {
  return items.map((item) => ({
    deviceId: item.deviceId,
    name: names.get(item.deviceId) ?? shortDeviceId(item.deviceId),
    outcome: item.outcome,
  }))
}

async function runBatch(deviceIds: string[], names: Map<string, string>): Promise<void> {
  batching.value = true
  try {
    const result = await withReauth(() => revokeAdminDesktopDevices(deviceIds), {
      title: '批量吊销设备',
      description: `将吊销所选 ${String(deviceIds.length)} 台设备：这些桌面端会立即退出登录，本地文件与会话不受影响。`,
      confirmText: '吊销',
      type: 'error',
    })
    batchResult.value = { rows: toOutcomeRows(result.items, names), revoked: result.revoked }
    checked.value = []
    const failed = result.items.length - result.revoked
    if (failed === 0) message.success(`已吊销 ${String(result.revoked)} 台设备`)
    else message.warning(`已吊销 ${String(result.revoked)} 台，另有 ${String(failed)} 台未生效`)
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    batching.value = false
  }
}

/** 「吊销所选」：上限 50（超出只提示，不发请求）→ 二次确认（写明台数与后果）→ 逐台结果 */
async function revokeSelected(): Promise<void> {
  const deviceIds = [...checked.value]
  if (deviceIds.length === 0) return
  if (deviceIds.length > DESKTOP_BATCH_REVOKE_MAX) {
    message.warning(`一次最多吊销 ${String(DESKTOP_BATCH_REVOKE_MAX)} 台，请减少勾选`)
    return
  }
  await runBatch(deviceIds, nameSnapshot())
}

/** 只重试「未生效」的那几台（not_found / failed） */
async function retryPending(): Promise<void> {
  const targets = pendingRows.value.map((row) => row.deviceId)
  if (targets.length === 0) return
  await runBatch(targets, nameSnapshot())
}

const batchSummary = computed(() => {
  const current = batchResult.value
  if (!current) return null
  const failed = current.rows.length - current.revoked
  return { total: current.rows.length, revoked: current.revoked, failed, pending: pendingRows.value.length }
})

/** 结果条标题（一句话说清「成了几台、几台没生效」） */
const batchHeader = computed(() => {
  const current = batchSummary.value
  if (!current) return ''
  return current.failed > 0
    ? `已吊销 ${String(current.revoked)} / ${String(current.total)} 台，${String(current.failed)} 台未生效`
    : `已吊销 ${String(current.revoked)} / ${String(current.total)} 台`
})

// ── 表格列 ──────────────────────────────────────────────────────────────────

const columns = computed<DataTableColumns<DesktopDeviceAdminItem>>(() => {
  // 读一下 revoking / checked 建立依赖：表格只在**行渲染函数**里读它们，列本身不变时 NDataTable 不会重渲染
  void revoking.value
  void checked.value.length
  return [
    {
      // 勾选列：本页全选由表头的勾选框负责；已吊销的行禁用（吊销是幂等的，但没有再吊销一次的意义）
      type: 'selection',
      width: 34,
      fixed: 'left',
      disabled: (row: DesktopDeviceAdminItem) => row.device.revokedAt !== null,
    },
    {
      title: '用户',
      key: 'user',
      width: 150,
      fixed: 'left',
      render: (row) =>
        h('div', { class: 'admin-desktop__user', title: row.user.username }, [
          h(UserCell, { user: row.user, to: `/admin/users/${row.user.id}` }),
        ]),
    },
    {
      title: '设备',
      key: 'name',
      width: 175,
      render: (row) =>
        h('div', { class: 'admin-desktop__device' }, [
          h('span', { class: 'admin-desktop__device-name', title: row.device.name }, row.device.name),
          h(
            'span',
            { class: 'admin-desktop__device-id', title: row.device.deviceId },
            shortDeviceId(row.device.deviceId),
          ),
        ]),
    },
    {
      title: '系统',
      key: 'platform',
      width: 110,
      render: (row) =>
        h('div', { class: 'admin-desktop__stack' }, [
          h('span', { class: 'admin-desktop__strong' }, systemText(row.device.platform, row.device.osMajor)),
          h('span', { class: 'admin-desktop__muted' }, archText(row.device.arch)),
        ]),
    },
    {
      title: '客户端',
      key: 'appVersion',
      width: 100,
      render: (row) =>
        h('div', { class: 'admin-desktop__stack' }, [
          h('span', { class: 'admin-desktop__mono' }, row.device.appVersion ?? '—'),
          h('span', { class: 'admin-desktop__muted' }, channelText(row.device.appChannel)),
        ]),
    },
    {
      title: '状态',
      key: 'presence',
      width: 82,
      render: (row) => tagCell(presenceText(row.device.presence), presenceTone(row.device.presence)),
    },
    {
      title: '应用状态',
      key: 'applyState',
      width: 103,
      render: (row) => applyCell(row),
    },
    {
      // 两行：最近在线 + 登录时间（一列放下两组「时间」数据，1280 下也不用横向拖到最后一列）
      title: '最近在线',
      key: 'lastReportAt',
      width: 140,
      render: (row) => {
        const { device } = row
        const online = device.revokedAt
          ? {
              text: formatDateTime(device.revokedAt),
              title: `吊销：${revokeReasonText(device.revokeReason)}`,
            }
          : { text: fromNow(device.lastReportAt), title: formatDateTime(device.lastReportAt) }
        return h('div', { class: 'admin-desktop__stack' }, [
          h('span', { class: 'admin-desktop__time', title: online.title }, online.text),
          h(
            'span',
            { class: 'admin-desktop__muted', title: '登录时间' },
            `登录 ${formatDateTime(device.lastAuthAt)}`,
          ),
        ])
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 78,
      fixed: 'right',
      render: (row) =>
        row.device.revokedAt
          ? h('span', { class: 'admin-desktop__muted' }, '—')
          : h(
              NPopconfirm,
              { positiveText: '确认吊销', onPositiveClick: () => void revoke(row) },
              {
                trigger: () =>
                  h(
                    NButton,
                    {
                      size: 'tiny',
                      type: 'error',
                      quaternary: true,
                      loading: revoking.value === row.device.deviceId,
                      'data-testid': 'admin-desktop-revoke',
                    },
                    { default: () => '吊销' },
                  ),
                default: () => '该设备将退出登录，本地文件与会话不受影响。确定吗？',
              },
            ),
    },
  ]
})
</script>

<template>
  <div class="admin-desktop" data-testid="admin-desktop-devices">
    <AdminErrorNotice :error="error" title="桌面设备加载失败" @retry="reload" />

    <SoftCard :padded="false">
      <div class="admin-desktop__toolbar">
        <NInput
          v-model:value="searchInput"
          class="admin-desktop__search"
          size="small"
          placeholder="搜索用户名 / 设备名 / 设备编号"
          clearable
          data-testid="admin-desktop-search"
        >
          <template #prefix><span class="i-ph-magnifying-glass text-3" aria-hidden="true" /></template>
        </NInput>

        <NSelect
          v-model:value="state.presence"
          class="admin-desktop__select"
          size="small"
          :options="presenceOptions"
          aria-label="按在线状态筛选"
          data-testid="admin-desktop-presence"
        />

        <NSelect
          v-model:value="state.platform"
          class="admin-desktop__select"
          size="small"
          :options="platformOptions"
          aria-label="按系统筛选"
          data-testid="admin-desktop-platform"
        />

        <NInput
          v-model:value="versionInput"
          class="admin-desktop__version-input"
          size="small"
          placeholder="客户端版本，如 0.2.1"
          clearable
          :status="versionError ? 'error' : undefined"
          data-testid="admin-desktop-version"
          @keyup.enter="applyVersion"
          @blur="applyVersion"
        />

        <NButton size="small" quaternary :disabled="loading" @click="reset">清空筛选</NButton>

        <span class="admin-desktop__count" data-testid="admin-desktop-total">共 {{ total }} 台</span>

        <!-- 批量条：只有勾了才出现（07 §2.7 第 3 条「按状态出现」），确认框里写清台数与后果 -->
        <template v-if="checked.length > 0">
          <span class="admin-desktop__selected" data-testid="admin-desktop-selected">
            已选 {{ checked.length }} 台
          </span>
          <NPopconfirm
            positive-text="确认吊销"
            @positive-click="revokeSelected"
          >
            <template #trigger>
              <NButton
                size="small"
                type="error"
                secondary
                :loading="batching"
                data-testid="admin-desktop-batch-revoke"
              >
                吊销所选
              </NButton>
            </template>
            将吊销所选 {{ checked.length }} 台设备：这些桌面端会立即退出登录，本地文件与会话不受影响。确定吗？
          </NPopconfirm>
          <NButton size="small" quaternary :disabled="batching" @click="checked = []">取消勾选</NButton>
        </template>
      </div>

      <p v-if="versionError" class="admin-desktop__version-error" role="alert">{{ versionError }}</p>

      <!-- 批量结果：每台一个结果；not_found / failed 一起算「未生效」，只重试这几台 -->
      <NAlert
        v-if="batchResult && batchSummary"
        :type="batchSummary.failed > 0 ? 'warning' : 'success'"
        :bordered="false"
        class="admin-desktop__batch"
        data-testid="admin-desktop-batch-result"
      >
        <template #header>{{ batchHeader }}</template>
        <ul class="admin-desktop__batch-list">
          <li
            v-for="row in batchResult.rows"
            :key="row.deviceId"
            class="admin-desktop__batch-item"
            data-testid="admin-desktop-batch-item"
            :data-outcome="row.outcome"
          >
            <span class="admin-desktop__batch-name" :title="row.deviceId">{{ row.name }}</span>
            <MiniTag :text="outcomeText[row.outcome]" :tone="outcomeTone[row.outcome]" size="sm" />
          </li>
        </ul>
        <div v-if="batchSummary.pending > 0" class="admin-desktop__batch-actions">
          <NButton
            size="tiny"
            secondary
            :loading="batching"
            data-testid="admin-desktop-batch-retry"
            @click="retryPending"
          >
            重试未生效的 {{ batchSummary.pending }} 台
          </NButton>
        </div>
      </NAlert>

      <NDataTable
        class="admin-desktop__table"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="(row: DesktopDeviceAdminItem) => row.device.deviceId"
        :row-props="rowProps"
        :checked-row-keys="checked"
        :scroll-x="972"
        remote
        size="small"
        :pagination="{
          page: state.page,
          pageSize: state.pageSize,
          itemCount: total,
          showSizePicker: true,
          pageSizes: [20, 50, 100],
          prefix: ({ itemCount }: { itemCount?: number }) => `共 ${itemCount ?? 0} 条`,
          onUpdatePage: (page: number) => update({ page }),
          onUpdatePageSize: (pageSize: number) => update({ pageSize, page: 1 }),
        }"
        @update:checked-row-keys="(keys: (string | number)[]) => (checked = keys.map(String))"
      >
        <template #empty>
          <div class="admin-desktop__empty" data-testid="admin-desktop-empty">
            {{
              state.q || state.presence || state.platform || state.version
                ? '没有匹配的桌面设备'
                : '还没有用户登录桌面端'
            }}
          </div>
        </template>
      </NDataTable>
    </SoftCard>

    <AdminDesktopDeviceDrawer
      v-model:show="detailShow"
      :device-id="detailId"
      @revoked="onDetailRevoked"
    />
  </div>
</template>

<style scoped>
.admin-desktop {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.admin-desktop__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: var(--border-width) solid var(--c-border);
}

.admin-desktop__search {
  width: 240px;
}

.admin-desktop__select {
  width: 130px;
}

.admin-desktop__version-input {
  width: 170px;
}

.admin-desktop__count {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.admin-desktop__selected {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.admin-desktop__version-error {
  padding: 0 var(--space-3) var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.admin-desktop__batch {
  margin: var(--space-2) var(--space-3) 0;
}

.admin-desktop__batch-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

.admin-desktop__batch-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-13);
}

.admin-desktop__batch-name {
  overflow: hidden;
  max-width: 320px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-desktop__batch-actions {
  margin-top: var(--space-2);
}

.admin-desktop__table {
  padding: var(--space-2) var(--space-3);
}

.admin-desktop__empty {
  padding: var(--space-6) 0;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

/* 行渲染函数（h()）里创建的节点拿不到 scoped 的 data-v 属性，样式必须用 :deep() 命中 */
/*
 * 宽表格的省略号（07 §2.8）：`table-layout` 由 Naive 用内联样式固定成 auto，所以靠 `max-width`
 * 压住单元格的 min-content——否则 33 位的 deviceId / 20 多字的用户名会把列撑开，整张表横向拖到 1300+。
 */
/* 宽度由这一层兜住，里面的 UserCell 自己负责省略号（它的根是 inline-flex + min-width:0） */
:deep(.admin-desktop__user) {
  display: flex;
  overflow: hidden;
  max-width: 126px;
}

:deep(.admin-desktop__device),
:deep(.admin-desktop__stack) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

:deep(.admin-desktop__device-name) {
  overflow: hidden;
  max-width: 150px;
  color: var(--c-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.admin-desktop__device-id) {
  overflow: hidden;
  max-width: 150px;
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.admin-desktop__strong) {
  overflow: hidden;
  color: var(--c-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.admin-desktop__muted) {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.admin-desktop__mono) {
  color: var(--c-text);
  font-family: var(--font-mono);
  white-space: nowrap;
}

:deep(.admin-desktop__time) {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.admin-desktop__apply) {
  white-space: nowrap;
}
</style>
