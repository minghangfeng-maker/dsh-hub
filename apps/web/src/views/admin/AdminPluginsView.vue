<script setup lang="ts">
import type { AdminPluginRow } from '@dsh-hub/shared'
import {
  NButton,
  NCheckbox,
  NDataTable,
  NDropdown,
  NInput,
  NPagination,
  NSelect,
  type DataTableColumns,
  type DropdownOption,
} from 'naive-ui'
import { computed, h, ref, watch, type VNodeChild } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { listPlugins } from '@/api/admin-plugins'
import { getPluginInstallStats } from '@/api/pluginInstallStats'
import AddPluginDrawer from '@/components/admin/AddPluginDrawer.vue'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import DesktopPluginLibrary from '@/components/admin/desktop/DesktopPluginLibrary.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAdminPlatform } from '@/composables/admin-platform'
import { pluginPolicyText } from '@/composables/job-meta'
import { useAsyncData } from '@/composables/useAsyncData'
import {
  PLUGIN_DELIVERY_LIMIT,
  overDeliveryLimit,
  pluginDeliveryLocation,
  type PluginDeliveryAction,
} from '@/utils/plugin-delivery'

/**
 * 插件（07 §7.5；统一下发 docs/21 §1.2；docs/22 §2 双平台）：页标题下方一个「云端 | 桌面」切换 ——
 * 云端是原来的插件库（列表 + 勾选 + 批量 → 统一下发），桌面侧是**桌面插件库**
 * （`DesktopPluginLibrary`：独立策略与版本、上传整包、加入 / 移出、内置徽标、批量预选桌面平台）。
 *
 * 云端这一侧的列表、勾选与批量行为不变。
 *
 * 勾选与批量（WP28c）：本页全选只作用于当前页，跨页 / 跨搜索 / 跨策略筛选按插件 id 保留；
 * 批量条只负责**跳到统一下发向导并预填**（`utils/plugin-delivery.ts`），预览与二次密码都在向导里，
 * 本页不提交任何下发。
 *
 * 「已安装」列（交付物 2）：一次取 `GET /api/admin/plugins/install-stats`，实例 N 人 · 桌面 M 台，
 * 有较旧版本时加「X 待升级」；取不到就整列「—」，不影响列表本身。
 */
const { platform, isDesktop } = useAdminPlatform()
const router = useRouter()

/** 每页几个（本页全选只作用于这一页） */
const PAGE_SIZE = 10

const { data, loading, error, reload } = useAsyncData(async () => {
  const list = await listPlugins()
  // 插件库为空时不请求；统计失败只让「已安装」列显示「—」，不挡列表（交付物 2）
  const stats = list.length === 0 ? null : await getPluginInstallStats().catch(() => null)
  return { list, stats }
})

const plugins = computed<AdminPluginRow[]>(() => data.value?.list ?? [])
const statMap = computed(
  () => new Map((data.value?.stats?.items ?? []).map((item) => [item.pluginId, item] as const)),
)
/** 有插件但没拿到统计（接口失败）——「已安装」列显示「—」 */
const statsFailed = computed(() => plugins.value.length > 0 && data.value?.stats === null)

// ── 筛选与翻页 ──

const keyword = ref('')
const policyFilter = ref('')
const page = ref(1)

const policyOptions = [
  { label: '全部策略', value: '' },
  { label: '必装 required', value: 'required' },
  { label: '默认 default', value: 'default' },
  { label: '可选 optional', value: 'optional' },
  { label: '下线 hidden', value: 'hidden' },
]

const POLICY_TONE: Record<string, 'primary' | 'sky' | 'butter' | 'neutral'> = {
  required: 'primary',
  default: 'sky',
  optional: 'butter',
  hidden: 'neutral',
}

const filtered = computed(() =>
  plugins.value.filter((plugin) => {
    if (policyFilter.value && plugin.policy !== policyFilter.value) return false
    const q = keyword.value.trim().toLowerCase()
    if (!q) return true
    return (
      plugin.displayName.toLowerCase().includes(q) ||
      plugin.packageName.toLowerCase().includes(q) ||
      plugin.description.toLowerCase().includes(q)
    )
  }),
)

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))

const paged = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)

// 换搜索词 / 换策略回到第一页（已选不动，交付物 4）
watch([keyword, policyFilter], () => {
  page.value = 1
})
watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})

// ── 勾选 ──

/** 已选的插件 id：不动地在翻页 / 筛选 / 刷新列表之间保留；刷新页面即丢（不落盘） */
const selected = ref<number[]>([])
const selectedSet = computed(() => new Set(selected.value))

const pageIds = computed(() => paged.value.map((plugin) => plugin.id))
const allPageSelected = computed(() => pageIds.value.length > 0 && pageIds.value.every(isSelected))
const somePageSelected = computed(() => !allPageSelected.value && pageIds.value.some(isSelected))

function isSelected(pluginId: number): boolean {
  return selectedSet.value.has(pluginId)
}

/** 单行勾选（隐藏的插件也能选：不按 policy 拦，交付物 1） */
function togglePlugin(pluginId: number, on: boolean): void {
  if (on) {
    if (!selectedSet.value.has(pluginId)) selected.value = [...selected.value, pluginId]
    return
  }
  selected.value = selected.value.filter((id) => id !== pluginId)
}

/** 本页全选 / 取消本页 */
function selectPage(on: boolean): void {
  const ids = pageIds.value
  if (on) selected.value = [...new Set([...selected.value, ...ids])]
  else selected.value = selected.value.filter((id) => !ids.includes(id))
}

function clearSelection(): void {
  selected.value = []
}

// 列表刷新后，已经不在库里的 id 自动剔除（交付物 4）
watch(plugins, (list) => {
  if (selected.value.length === 0) return
  const ids = new Set(list.map((plugin) => plugin.id))
  const next = selected.value.filter((id) => ids.has(id))
  if (next.length !== selected.value.length) selected.value = next
})

const overLimit = computed(() => overDeliveryLimit(selected.value.length))

// ── 跳向导（本页不提交任何下发，交付物 1） ──

function deliver(action: PluginDeliveryAction): void {
  if (selected.value.length === 0 || overLimit.value) return
  const { path, query } = pluginDeliveryLocation(action, selected.value)
  void router.push({ path, query })
}

/** 单行：等价于只选这一行再点批量里的同名按钮（交付物 3） */
function deliverOne(pluginId: number, action: PluginDeliveryAction): void {
  const { path, query } = pluginDeliveryLocation(action, [pluginId])
  void router.push({ path, query })
}

const showAdd = ref(false)

// ── 行菜单 ──

const ROW_MENU: DropdownOption[] = [
  { label: '详情', key: 'detail' },
  { label: '下发 / 安装', key: 'install' },
  { label: '升级已安装用户', key: 'upgrade' },
]

function onRowAction(key: string, plugin: AdminPluginRow): void {
  if (key === 'detail') {
    void router.push(`/admin/plugins/${plugin.id}`)
    return
  }
  if (key === 'install' || key === 'upgrade') deliverOne(plugin.id, key)
}

// ── 列 ──

/** 「已安装」：实例 N 人 · 桌面 M 台（+ X 待升级）；没数据就「—」 */
function renderInstalled(plugin: AdminPluginRow): VNodeChild {
  const stat = statMap.value.get(plugin.id)
  if (!stat)
    return h(
      'span',
      { class: 'plugins__dash', title: statsFailed.value ? '安装情况读取失败' : undefined },
      '—',
    )

  const outdated = stat.instance.outdated + stat.desktop.outdated
  const counts = h('span', { class: 'plugins__counts' }, [
    h('span', { class: 'plugins__nowrap' }, `实例 ${stat.instance.users} 人`),
    h('span', { class: 'plugins__sep' }, '·'),
    h('span', { class: 'plugins__nowrap' }, `桌面 ${stat.desktop.devices} 台`),
  ])
  const badge =
    outdated > 0
      ? h(MiniTag, {
          text: `${outdated} 待升级`,
          tone: 'butter',
          size: 'sm',
          title: `实例 ${stat.instance.outdated} 人、桌面 ${stat.desktop.outdated} 台版本较旧`,
        })
      : null

  return h('div', { class: 'plugins__installed' }, [counts, badge])
}

const columns = computed<DataTableColumns<AdminPluginRow>>(() => [
  {
    // 表头勾选框 = 本页全选 / 取消本页（标题用渲染函数，naive-ui 没有 renderHeader）
    key: 'select',
    width: 44,
    align: 'center',
    fixed: 'left',
    title: () =>
      h(NCheckbox, {
        checked: allPageSelected.value,
        indeterminate: somePageSelected.value,
        'aria-label': '选择本页全部插件',
        'onUpdate:checked': (value: boolean) => selectPage(value),
      }),
    render: (row) =>
      h(NCheckbox, {
        checked: isSelected(row.id),
        'aria-label': `选择 ${row.displayName}`,
        'onUpdate:checked': (value: boolean) => togglePlugin(row.id, value),
      }),
  },
  {
    title: '插件',
    key: 'plugin',
    minWidth: 240,
    render: (row) =>
      h('div', { class: 'plugins__cell-name' }, [
        h(RouterLink, { to: `/admin/plugins/${row.id}`, class: 'plugins__name' }, {
          default: () => row.displayName,
        }),
        h('span', { class: 'plugins__pkg', title: row.packageName }, row.packageName),
      ]),
  },
  {
    title: '策略',
    key: 'policy',
    width: 104,
    render: (row) =>
      h(MiniTag, {
        text: pluginPolicyText(row.policy),
        tone: POLICY_TONE[row.policy] ?? 'neutral',
        size: 'sm',
      }),
  },
  {
    title: '最新版本',
    key: 'latestVersion',
    width: 120,
    render: (row) =>
      h(
        'span',
        { class: 'plugins__mono', title: row.latestVersion ?? undefined },
        row.latestVersion ?? '—',
      ),
  },
  {
    title: '已安装',
    key: 'installed',
    width: 248,
    render: (row) => renderInstalled(row),
  },
  {
    title: '操作',
    key: 'actions',
    width: 88,
    fixed: 'right',
    render: (row) =>
      h(
        NDropdown,
        { options: ROW_MENU, trigger: 'click', onSelect: (key: string) => onRowAction(key, row) },
        {
          default: () =>
            h(
              NButton,
              { size: 'tiny', quaternary: true, 'aria-label': `操作 ${row.displayName}` },
              { default: () => '操作' },
            ),
        },
      ),
  },
])
</script>

<template>
  <AdminPage title="插件" :platform="platform">
    <template #platform>
      <PlatformSwitch v-model="platform" />
    </template>

    <template #actions>
      <NButton size="small" type="primary" @click="showAdd = true">
        <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
        添加{{ isDesktop ? '桌面' : '' }}插件
      </NButton>
      <NButton v-if="!isDesktop" size="small" :loading="loading" @click="reload">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </template>

    <DesktopPluginLibrary v-if="isDesktop" />

    <template v-else>
      <AdminErrorNotice :error="error" title="插件列表加载失败" @retry="reload" />

    <SoftCard compact>
      <div class="plugins__toolbar">
        <NInput
          v-model:value="keyword"
          size="small"
          class="plugins__search"
          placeholder="搜索插件名 / 包名"
          clearable
        />
        <NSelect v-model:value="policyFilter" size="small" class="plugins__select" :options="policyOptions" />
        <span class="plugins__count">共 {{ filtered.length }} / {{ plugins.length }} 个插件</span>
      </div>
    </SoftCard>

    <EmptyState
      v-if="!loading && plugins.length === 0"
      title="还没有登记插件"
      description="从 npm、本地目录、tarball 或上传 tgz 添加第一个插件吧。"
      action-text="添加插件"
      @action="showAdd = true"
    />

    <SoftCard v-else>
      <!-- 批量操作条：选中即出现，固定在列表顶部（滚表格时还看得见） -->
      <Transition name="plugins-batch">
        <div v-if="selected.length > 0" class="plugins__batch" role="region" aria-label="批量操作">
          <span class="plugins__batch-count">已选 {{ selected.length }} 个</span>
          <div class="plugins__batch-actions">
            <NButton size="small" type="primary" :disabled="overLimit" @click="deliver('install')">
              下发 / 安装
            </NButton>
            <NButton size="small" :disabled="overLimit" @click="deliver('upgrade')">
              升级已安装用户
            </NButton>
            <NButton size="small" :disabled="overLimit" @click="deliver('uninstall')">卸载</NButton>
            <span v-if="overLimit" class="plugins__batch-warn">
              <span class="i-ph-warning-circle" aria-hidden="true" />
              一次最多 {{ PLUGIN_DELIVERY_LIMIT }} 个
            </span>
          </div>
          <NButton size="small" quaternary class="plugins__batch-clear" @click="clearSelection">
            清空
          </NButton>
        </div>
      </Transition>

      <NDataTable
        :columns="columns"
        :data="paged"
        :loading="loading"
        :row-key="(row: AdminPluginRow) => row.id"
        :scroll-x="920"
        size="small"
        :pagination="false"
      >
        <template #empty>
          <div class="plugins__empty">没有匹配的插件</div>
        </template>
      </NDataTable>

      <div v-if="pageCount > 1" class="plugins__pager">
        <NPagination v-model:page="page" :page-count="pageCount" size="small" />
      </div>
    </SoftCard>

      <AddPluginDrawer
        v-model:show="showAdd"
        :platform="platform"
        @created="reload"
        @rollout="(pluginId: number) => deliverOne(pluginId, 'install')"
      />
    </template>
  </AdminPage>
</template>

<style scoped>
.plugins__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.plugins__search {
  width: 240px;
}

.plugins__select {
  width: 160px;
}

.plugins__count {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

/* ── 批量操作条 ── */

.plugins__batch {
  position: sticky;
  z-index: 12;
  top: calc(64px + var(--space-2));
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-primary-soft);
  border-radius: var(--radius-control);
  background: var(--c-surface);
  box-shadow: var(--shadow-hover);
}

.plugins__batch-count {
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.plugins__batch-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  /* 紧跟「已选 N 个」而不是靠右：管理端容器最小 960px，窄屏时靠右会跑到可视区外 */
  margin-left: var(--space-1);
}

.plugins__batch-warn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.plugins__batch-clear {
  margin-left: auto;
  flex: none;
}

.plugins-batch-enter-active,
.plugins-batch-leave-active {
  transition:
    opacity var(--duration-base) var(--ease-out-soft),
    transform var(--duration-base) var(--ease-out-soft);
}

.plugins-batch-enter-from,
.plugins-batch-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* ── 单元格（渲染函数建的节点没有 scoped 属性，一律走 :deep） ── */

:deep(.plugins__cell-name) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

:deep(.plugins__name) {
  overflow: hidden;
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.plugins__pkg) {
  overflow: hidden;
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.plugins__mono) {
  font-family: var(--font-mono);
  white-space: nowrap;
}

:deep(.plugins__installed) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

:deep(.plugins__counts) {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.plugins__nowrap) {
  white-space: nowrap;
}

:deep(.plugins__sep) {
  margin: 0 4px;
  color: var(--c-text-3);
}

:deep(.plugins__dash) {
  color: var(--c-text-3);
}

:deep(.plugins__empty) {
  padding: var(--space-4) 0;
  color: var(--c-text-3);
}

.plugins__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-3);
}
</style>
