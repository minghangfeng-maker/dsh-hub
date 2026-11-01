<script setup lang="ts">
import type { AdminInstanceRow, InstanceAction } from '@dsh-hub/shared'
import { useStorage } from '@vueuse/core'
import {
  NButton,
  NDataTable,
  NRadioButton,
  NRadioGroup,
  NSkeleton,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref } from 'vue'

import { instanceAction, listInstanceStats, listInstances } from '@/api/admin-instances'
import { fetchOverview } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import AdminDesktopDevicesPanel from '@/components/admin/desktop/AdminDesktopDevicesPanel.vue'
import DesktopDevicesSummary from '@/components/admin/desktop/DesktopDevicesSummary.vue'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import InstanceCard from '@/components/admin/InstanceCard.vue'
import MiniBars from '@/components/admin/MiniBars.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import { probeTextOf } from '@/components/admin/instance-probe'
import UserCell from '@/components/admin/UserCell.vue'
import { leaseTagOf } from '@/components/admin/compute/lease-tag'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import StatusPill from '@/components/base/StatusPill.vue'
import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import UsageBar from '@/components/base/UsageBar.vue'
import { useAdminPlatform } from '@/composables/admin-platform'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, formatDuration } from '@/composables/useFormat'

/**
 * 实例（07 §7.4；docs/22 §1.3 改成平台切换）：
 * - **云端**：容器列表（卡片 / 表格两种视图，10 秒自动刷新，迷你资源条，顶部「运行中 x/y」汇总与宿主资源条）；
 * - **桌面**：设备统计卡（原「桌面端 · 总览」的统计部分）+ 设备台账（WP25c，服务端分页）。
 *
 * 为什么不做成一张表：云端实例是一人一台、整表一次拉回；桌面设备要服务端分页 + `q/presence/platform/appVersion`
 * 四个筛选项（见 `AdminDesktopDevicesPanel`）。平台由 `useAdminPlatform()` 统一管理：地址栏 `?platform=` 优先、
 * 其次记忆值；旧的 `?tab=cloud|desktop` 与 `?kind=desktop` 仍然认（会规范成 `?platform=`）。
 */
const message = useMessage()

/** 平台（云端 / 桌面）：地址栏 + 记忆值，切换器在页标题下方 */
const { platform, isDesktop } = useAdminPlatform()

/** 视图偏好存本地（刷新后保持） */
const view = useStorage<'cards' | 'table'>('hub.admin.instances-view', 'cards')
/**
 * 进行中的操作按 userId 记录（同一实例同时只允许一个操作）。
 * 共用一只 `busy` 会让**所有**实例的按钮一起转圈，看起来像「点一个影响全部」（WP15 ③）。
 */
const pending = ref(new Map<number, InstanceAction>())
const now = ref(Date.now())

const {
  data: rows,
  loading,
  error,
  reload,
} = useAsyncData(
  async () => {
    const list = await listInstances()
    now.value = Date.now()
    return list
  },
  { pollMs: 10_000 },
)
const { data: overview } = useAsyncData(() => fetchOverview(), { pollMs: 30_000 })

/**
 * 资源列单独轮询（WP33，docs/22 §5.3）：列表先渲染（stats 可能是骨架），stats 接口只读缓存，
 * 10 秒一次把 CPU/内存填进来；按 userId 合并，避免整表重排版。
 */
const { data: statsRows } = useAsyncData(() => listInstanceStats(), { pollMs: 10_000 })
const statsByUser = computed(() => {
  const map = new Map<number, { stats: AdminInstanceRow['stats']; statsAt: string | null }>()
  for (const row of statsRows.value ?? []) map.set(row.userId, { stats: row.stats, statsAt: row.statsAt })
  return map
})

const list = computed<AdminInstanceRow[]>(() =>
  (rows.value ?? []).map((row) => {
    const live = statsByUser.value.get(row.user.id)
    return live ? { ...row, stats: live.stats, statsAt: live.statsAt } : row
  }),
)

const summary = computed(() => {
  const running = list.value.filter((row) => row.instance.status === 'running').length
  const starting = list.value.filter((row) => row.instance.status === 'starting').length
  const errored = list.value.filter((row) => row.instance.status === 'error').length
  return {
    running,
    starting,
    errored,
    total: list.value.length,
    max: overview.value?.instances.max ?? 0,
  }
})

const host = computed(() => overview.value?.host ?? null)
const memUsed = computed(() => {
  const value = host.value
  return value ? Math.max(0, value.memTotal - value.memAvailable) : 0
})
const diskUsed = computed(() => {
  const value = host.value
  return value ? Math.max(0, value.diskTotal - value.diskFree) : 0
})

function uptimeOf(row: AdminInstanceRow): string {
  if (!row.instance.startedAt) return '—'
  const elapsed = now.value - new Date(row.instance.startedAt).getTime()
  return Number.isFinite(elapsed) && elapsed > 0 ? formatDuration(elapsed, 'ms') : '—'
}

/** 某个实例进行中的操作（null = 空闲）；只有它能 loading，同实例其他按钮 disabled */
function pendingAction(userId: number): InstanceAction | null {
  return pending.value.get(userId) ?? null
}

async function run(row: AdminInstanceRow, action: InstanceAction): Promise<void> {
  const userId = row.user.id
  // 同一实例的操作串行：连点/重复提交直接忽略（不同实例互不影响）
  if (pending.value.has(userId)) return
  pending.value.set(userId, action)
  try {
    await instanceAction(userId, action)
    message.success('操作已提交')
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    pending.value.delete(userId)
  }
}

function actionBar(row: AdminInstanceRow) {
  const actions: { key: InstanceAction; label: string; type: 'primary' | 'default' | 'warning' }[] = [
    { key: 'start', label: '启动', type: 'primary' },
    { key: 'stop', label: '停止', type: 'default' },
    { key: 'restart', label: '重启', type: 'default' },
    { key: 'recreate', label: '重建', type: 'warning' },
  ]
  const current = pendingAction(row.user.id)

  return h(
    'div',
    { class: 'instances__actions' },
    actions.map((action) =>
      h(
        NButton,
        {
          size: 'tiny',
          type: action.type,
          ghost: action.type !== 'primary',
          loading: current === action.key,
          disabled: current !== null && current !== action.key,
          onClick: () => void run(row, action.key),
        },
        { default: () => action.label },
      ),
    ),
  )
}

const columns = computed<DataTableColumns<AdminInstanceRow>>(() => {
  // 读一下 pending 建立依赖：表格在**行渲染函数**里读它，列本身不变时 NDataTable 不会重渲染，
  // 按钮的 loading/disabled 就更新不了（卡片视图天然跟着模板走，不需要这步）
  void pending.value.size
  return [
    {
      title: '用户',
      key: 'user',
      width: 200,
      fixed: 'left',
      render: (row) => h(UserCell, { user: row.user, to: `/admin/users/${row.user.id}` }),
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (row) => h(StatusPill, { status: row.instance.status, size: 'sm' }),
    },
    {
      // 会话探针（WP33，docs/22 §6.3）：进行中 N / 有人在看 / 空闲 X 分钟（Y 分钟后休眠）/ 未知
      // 宽度按最长的一档「空闲 10 分钟（20 分钟后休眠）」留够（WP32d：原来 150 会被截）
      title: '会话',
      key: 'probe',
      width: 230,
      render: (row) => {
        if (!row.probe) return '—'
        const info = probeTextOf(row.probe, now.value)
        // 判定依据放 title（悬浮可见），表格里不塞常驻小字（WP14 口径）
        return h('span', { title: info.hint }, [h(MiniTag, { text: info.label, tone: info.tone, size: 'sm' })])
      },
    },
    {
      // 已运行紧跟在会话后面：表格比可视区宽、操作列又是 fixed right，
      // 放在「规格」后面会被固定的操作列压住（WP32d：1440 下曾显示成「2 小时 1」）
      title: '已运行',
      key: 'uptime',
      width: 120,
      render: (row) => uptimeOf(row),
    },
    {
      title: 'DSH 版本',
      key: 'runtime',
      width: 120,
      render: (row) => row.instance.runtimeVersion ?? '默认',
    },
    {
      // 算力租赁（13 §7）：规格名 + 租约状态；没有租约（计费关闭 / 没在跑）时显示 —
      title: '规格',
      key: 'lease',
      width: 170,
      render: (row) => {
        const tag = leaseTagOf(row.lease)
        if (!row.lease || !tag) return '—'
        return h('div', { class: 'instances__lease' }, [
          h('span', { class: 'instances__lease-plan', title: row.lease.planName }, row.lease.planName),
          h(MiniTag, { text: tag.text, tone: tag.tone, size: 'sm' }),
        ])
      },
    },
    {
      title: '资源',
      key: 'stats',
      minWidth: 220,
      render: (row) => {
        if (row.stats) return h(MiniBars, { stats: row.stats, showDisk: false })
        // 首屏不等 stats：骨架占位，下一次 10 s 轮询填进来（docs/22 §5.4）
        if (row.instance.status === 'running') return h(NSkeleton, { text: true, height: '32px' })
        return '—'
      },
    },
    {
      title: '最近活跃',
      key: 'lastActiveAt',
      width: 150,
      render: (row) => formatDateTime(row.instance.lastActiveAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      fixed: 'right',
      render: (row) => actionBar(row),
    },
  ]
})
</script>

<template>
  <AdminPage title="实例" wide :platform="platform">
    <template #platform>
      <PlatformSwitch v-model="platform" />
    </template>

    <template #actions>
      <template v-if="!isDesktop">
        <NRadioGroup v-model:value="view" size="small">
          <NRadioButton value="cards">卡片</NRadioButton>
          <NRadioButton value="table">表格</NRadioButton>
        </NRadioGroup>
        <NButton size="small" :loading="loading" @click="reload">
          <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
          刷新
        </NButton>
      </template>
    </template>

    <div v-if="isDesktop" class="instances__pane">
      <DesktopDevicesSummary />
      <AdminDesktopDevicesPanel />
    </div>

    <div v-else class="instances__pane">
      <AdminErrorNotice :error="error" title="实例列表加载失败" @retry="reload" />

      <SoftCard>
        <div class="instances__summary">
          <div class="instances__counts">
            <MiniTag
              :text="`运行中 ${summary.running} / ${summary.max || '—'}`"
              tone="success"
              icon="i-ph-play-circle"
            />
            <MiniTag :text="`启动中 ${summary.starting}`" tone="sky" icon="i-ph-circle-notch" />
            <MiniTag
              :text="`异常 ${summary.errored}`"
              :tone="summary.errored > 0 ? 'danger' : 'neutral'"
              icon="i-ph-warning-circle"
            />
            <MiniTag :text="`共 ${summary.total} 个实例`" tone="neutral" icon="i-ph-hard-drives" />
            <MiniTag text="每 10 秒自动刷新" tone="neutral" icon="i-ph-clock" />
          </div>

          <div v-if="host" class="instances__host">
            <UsageBar label="宿主内存" :used="memUsed" :limit="host.memTotal" />
            <UsageBar label="宿主磁盘" :used="diskUsed" :limit="host.diskTotal" />
          </div>
        </div>
      </SoftCard>

      <EmptyState
        v-if="list.length === 0 && !loading"
        title="还没有任何实例"
        description="用户在「我的工作台」点开 DSH 后，这里会出现他们的容器。"
      />

      <div v-else-if="view === 'cards'" class="instances__grid">
        <InstanceCard
          v-for="row in list"
          :key="row.user.id"
          :row="row"
          :now="now"
          :busy-action="pendingAction(row.user.id)"
          @action="(action) => run(row, action)"
        />
      </div>

      <SoftCard v-else :padded="false">
        <NDataTable
          class="instances__table"
          :columns="columns"
          :data="list"
          :loading="loading"
          :row-key="(row: AdminInstanceRow) => row.user.id"
          :scroll-x="1550"
          :pagination="false"
          size="small"
        />
      </SoftCard>
    </div>
  </AdminPage>
</template>

<style scoped>
.instances__pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding-top: var(--space-4);
}

.instances__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
}

.instances__counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.instances__host {
  display: grid;
  min-width: 280px;
  flex: 1;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.instances__grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
}

.instances__table {
  padding: var(--space-2) var(--space-3);
}

:deep(.instances__actions) {
  display: flex;
  gap: 4px;
}

:deep(.instances__lease) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

:deep(.instances__lease-plan) {
  overflow: hidden;
  color: var(--c-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
