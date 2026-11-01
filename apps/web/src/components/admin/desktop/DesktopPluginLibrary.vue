<script setup lang="ts">
import type { AdminPluginRow, PluginPolicy } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NCheckbox,
  NDataTable,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import {
  addPluginPlatform,
  listPlugins,
  removePluginPlatform,
  updatePluginPlatform,
  uploadDesktopVersion,
} from '@/api/admin-plugins'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import DesktopUploadProgress from '@/components/admin/desktop/DesktopUploadProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { pluginPolicyText } from '@/composables/job-meta'
import { formatBytes } from '@/composables/useFormat'
import { useAsyncData } from '@/composables/useAsyncData'
import { isReauthCanceled, sensitive, withReauth } from '@/composables/useReauth'
import {
  PLUGIN_DELIVERY_LIMIT,
  desktopPluginDeliveryLocation,
  overDeliveryLimit,
  type PluginDeliveryAction,
} from '@/utils/plugin-delivery'

/**
 * 插件 · 桌面侧的**桌面插件库**（docs/22 §2）。
 *
 * 与云端插件库是两套**独立**的东西：库里有这个插件 ⇔ 有桌面库那一行；桌面侧有自己的策略与版本号，
 * 桌面版本必须有整包。这一页负责：
 * 1. 列表（策略 / 桌面版本 / 已装设备 / 「内置」徽标）+ 勾选批量 → 统一下发（预选桌面平台）；
 * 2. 桌面策略就地改（`PATCH /plugins/:id/platforms/desktop`）；
 * 3. **上传桌面整包** = 创建桌面版本（`POST /versions?platform=desktop`，流式上传带进度）；
 * 4. **加入桌面插件库**（`POST /plugins/:id/platforms`）与**移出**（`DELETE …`，有下发目标时
 *    服务端拒绝，界面提示会连带撤销目标并要求二次密码后带 `force=1` 再来一次）。
 *
 * 云端侧的列表、批量与添加抽屉行为不变（在 `AdminPluginsView` 的云端分支里）。
 */
const router = useRouter()
const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => listPlugins('desktop'))

/** 云端库（「加入桌面插件库」的候选与上传整包时的插件下拉） */
const { data: cloudList, reload: reloadCloud } = useAsyncData(() => listPlugins())

const plugins = computed<AdminPluginRow[]>(() => data.value ?? [])
/**
 * 桌面口径的安装统计跟着每一行走（`AdminPluginRow.desktopStats`，docs/22 §2.2）：
 * 有效设备里上报了这个包的设备数 / 用户数 / 较旧（按**桌面**最新版本算）/ 内置设备数。
 */
interface DesktopStats {
  devices: number
  users: number
  outdated: number
  bundledDevices: number
}

function desktopStatsOf(row: AdminPluginRow): DesktopStats {
  const stats = row.desktopStats
  return {
    devices: stats?.devices ?? 0,
    users: stats?.users ?? 0,
    outdated: stats?.outdated ?? 0,
    bundledDevices: stats?.bundledDevices ?? 0,
  }
}

const keyword = ref('')
const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return plugins.value
  return plugins.value.filter(
    (plugin) =>
      plugin.displayName.toLowerCase().includes(q) ||
      plugin.packageName.toLowerCase().includes(q) ||
      plugin.description.toLowerCase().includes(q),
  )
})

/** 不在桌面库里的插件（= 云端库里有、`platforms.desktop` 没有） */
const addCandidates = computed(() =>
  (cloudList.value ?? []).filter((plugin) => plugin.platforms?.desktop === undefined),
)

const POLICY_OPTIONS: { label: string; value: PluginPolicy }[] = [
  { label: '必装 required', value: 'required' },
  { label: '默认 default', value: 'default' },
  { label: '可选 optional', value: 'optional' },
  { label: '下线 hidden', value: 'hidden' },
]

// ── 勾选与批量（只跳到统一下发向导，本页不提交下发）─────────────────────────

const selected = ref<number[]>([])
const selectedSet = computed(() => new Set(selected.value))

function isSelected(pluginId: number): boolean {
  return selectedSet.value.has(pluginId)
}

function togglePlugin(pluginId: number, on: boolean): void {
  if (on) {
    if (!selectedSet.value.has(pluginId)) selected.value = [...selected.value, pluginId]
    return
  }
  selected.value = selected.value.filter((id) => id !== pluginId)
}

function clearSelection(): void {
  selected.value = []
}

const overLimit = computed(() => overDeliveryLimit(selected.value.length))

function deliver(action: PluginDeliveryAction): void {
  if (selected.value.length === 0 || overLimit.value) return
  const { path, query } = desktopPluginDeliveryLocation(action, selected.value)
  void router.push({ path, query })
}

// ── 桌面策略 ────────────────────────────────────────────────────────────────

const savingPolicy = ref(new Set<number>())

async function setPolicy(plugin: AdminPluginRow, policy: PluginPolicy): Promise<void> {
  if (policy === plugin.policy) return
  savingPolicy.value = new Set([...savingPolicy.value, plugin.id])
  try {
    await withReauth(() =>
      updatePluginPlatform(plugin.id, 'desktop', { policy }),
    )
    message.success(`${plugin.displayName} 的桌面策略已改为${pluginPolicyText(policy)}`)
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    const next = new Set(savingPolicy.value)
    next.delete(plugin.id)
    savingPolicy.value = next
  }
}

// ── 加入桌面插件库 ──────────────────────────────────────────────────────────

const showAdd = ref(false)
const addTarget = ref<number | null>(null)
const addPolicy = ref<PluginPolicy>('optional')
const adding = ref(false)
const addError = ref('')

const addOptions = computed(() =>
  addCandidates.value.map((plugin) => ({
    label: `${plugin.displayName} · ${plugin.packageName}`,
    value: plugin.id,
  })),
)

function openAdd(): void {
  addTarget.value = addCandidates.value[0]?.id ?? null
  addPolicy.value = 'optional'
  addError.value = ''
  showAdd.value = true
  void reloadCloud()
}

async function submitAdd(): Promise<void> {
  const id = addTarget.value
  if (id === null) {
    addError.value = '先选一个插件'
    return
  }
  adding.value = true
  addError.value = ''
  try {
    await withReauth(() => addPluginPlatform(id, { platform: 'desktop', policy: addPolicy.value }))
    message.success('已加入桌面插件库；上传整包之后才能下发给设备')
    showAdd.value = false
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) addError.value = describeError(cause).message
  } finally {
    adding.value = false
  }
}

// ── 移出桌面插件库（有目标时二次密码 + force）───────────────────────────────

const forceRow = ref<AdminPluginRow | null>(null)
const forceError = ref('')
const forceBusy = ref(false)

async function removeFromDesktop(plugin: AdminPluginRow): Promise<void> {
  try {
    await withReauth(() => removePluginPlatform(plugin.id, 'desktop'))
    message.success(`${plugin.displayName} 已移出桌面插件库`)
    await reload()
  } catch (cause) {
    if (isReauthCanceled(cause)) return
    // 还有桌面下发目标：服务端 409，界面给出后果并要求二次密码后带 force 再来一次
    if (isHubApiError(cause) && cause.code === 'CONFLICT') {
      forceError.value = ''
      forceRow.value = plugin
      return
    }
    message.error(describeError(cause).message)
  }
}

async function forceRemove(): Promise<void> {
  const plugin = forceRow.value
  if (!plugin) return
  forceBusy.value = true
  forceError.value = ''
  try {
    await sensitive(
      () => removePluginPlatform(plugin.id, 'desktop', true),
      {
        title: `把 ${plugin.displayName} 移出桌面插件库`,
        description: '这个插件还有桌面端下发目标：会一并撤销它们（设备上已经装的保留现状），并生成新的 revision。',
        confirmText: '撤销并移出',
        type: 'error',
      },
    )
    message.success(`已移出，并撤销了桌面端下发目标`)
    forceRow.value = null
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) forceError.value = describeError(cause).message
  } finally {
    forceBusy.value = false
  }
}

// ── 上传桌面整包（= 创建桌面版本）───────────────────────────────────────────

const uploadPluginId = ref<number | null>(null)
const uploadFile = ref<File | null>(null)
const uploadFileName = ref('')
const uploading = ref(false)
const uploadProgress = ref<{ percent: number | null; loaded: number; total: number } | null>(null)
const uploadError = ref<string | null>(null)
const uploadErrorDetail = ref<string | null>(null)

/** 候选 = 桌面库 + 云端库（上传整包会顺手把插件加进桌面库，后端 docs/22 §2.2） */
const uploadOptions = computed(() => {
  const merged = new Map<number, AdminPluginRow>()
  for (const plugin of [...plugins.value, ...(cloudList.value ?? [])]) merged.set(plugin.id, plugin)
  return [...merged.values()].map((plugin) => ({
    label: `${plugin.displayName} · ${plugin.packageName}`,
    value: plugin.id,
  }))
})

const packageInput = ref<HTMLInputElement | null>(null)

/** 「选择整包」按钮 → 原生选择框（input 隐藏起来，只是把系统弹窗转出来） */
function pickPackage(): void {
  packageInput.value?.click()
}

function onPickFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  uploadError.value = null
  uploadErrorDetail.value = null
  if (file && !file.name.toLowerCase().endsWith('.tgz')) {
    uploadFile.value = null
    uploadError.value = '桌面整包必须是 .tgz'
    return
  }
  uploadFile.value = file
}

async function submitUpload(): Promise<void> {
  uploadError.value = null
  uploadErrorDetail.value = null
  if (uploadPluginId.value === null) {
    uploadError.value = '先选插件'
    return
  }
  const file = uploadFile.value
  if (!file) {
    uploadError.value = '先选一个 .tgz'
    return
  }
  uploading.value = true
  uploadFileName.value = file.name
  uploadProgress.value = { percent: null, loaded: 0, total: file.size }
  try {
    const result = await uploadDesktopVersion(uploadPluginId.value, file, {
      onProgress: (progress) => {
        uploadProgress.value = {
          percent: progress.total > 0 ? (progress.loaded / progress.total) * 100 : null,
          loaded: progress.loaded,
          total: progress.total || file.size,
        }
      },
    })
    message.success(`已上传桌面版本 ${result.version.version}`)
    uploadFile.value = null
    uploadProgress.value = null
    await reload()
  } catch (cause) {
    // VALIDATION_FAILED 时 describeError 会把 message 换成第一个字段错误；
    // 这里要看服务端那句完整的拒绝理由（裁决 #16 / Apache-2.0 的 LICENSE+NOTICE）
    const description = describeError(cause)
    uploadProgress.value = null
    uploadError.value = isHubApiError(cause) ? cause.message : description.message
    uploadErrorDetail.value = Object.values(description.fieldErrors)[0] ?? null
  } finally {
    uploading.value = false
  }
}

// ── 表格 ────────────────────────────────────────────────────────────────────

const page = ref(1)
const PAGE_SIZE = 10
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pageIds = computed(() => paged.value.map((plugin) => plugin.id))
const allPageSelected = computed(() => pageIds.value.length > 0 && pageIds.value.every(isSelected))

function detailLink(plugin: AdminPluginRow): string {
  return `/admin/plugins/${String(plugin.id)}?platform=desktop`
}

const columns = computed<DataTableColumns<AdminPluginRow>>(() => [
  {
    key: 'select',
    width: 44,
    align: 'center',
    fixed: 'left',
    title: () =>
      h(NCheckbox, {
        checked: allPageSelected.value,
        'aria-label': '选择本页全部插件',
        'onUpdate:checked': (value: boolean) => {
          if (value) selected.value = [...new Set([...selected.value, ...pageIds.value])]
          else selected.value = selected.value.filter((id) => !pageIds.value.includes(id))
        },
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
    minWidth: 260,
    render: (row) => {
      const bundled = desktopStatsOf(row).bundledDevices
      return h('div', { class: 'lib__cell' }, [
        h('div', { class: 'lib__name-row' }, [
          h(RouterLink, { to: detailLink(row), class: 'lib__name' }, { default: () => row.displayName }),
          bundled > 0
            ? h(MiniTag, {
                text: `内置 v${row.latestVersion ?? '—'}`,
                tone: 'sakura',
                size: 'sm',
                title: `桌面客户端自带：${String(bundled)} 台设备从安装器里就装好了`,
              })
            : null,
        ]),
        h('span', { class: 'lib__pkg', title: row.packageName }, row.packageName),
      ])
    },
  },
  {
    title: '桌面策略',
    key: 'policy',
    width: 160,
    render: (row) =>
      h(NSelect, {
        value: row.policy,
        size: 'tiny',
        options: POLICY_OPTIONS,
        loading: savingPolicy.value.has(row.id),
        'data-testid': `lib-policy-${row.id}`,
        'onUpdate:value': (value: PluginPolicy) => void setPolicy(row, value),
      }),
  },
  {
    title: '桌面版本',
    key: 'versions',
    width: 170,
    render: (row) =>
      h('div', { class: 'lib__cell' }, [
        h('span', { class: 'lib__mono' }, row.latestVersion ?? '—'),
        h(
          'span',
          { class: 'lib__sub' },
          row.versions.length === 0 ? '还没有整包版本' : `${String(row.versions.length)} 个版本`,
        ),
      ]),
  },
  {
    title: '已装设备',
    key: 'installed',
    width: 180,
    render: (row) => {
      if (!row.desktopStats) return h('span', { class: 'lib__sub' }, '—')
      const stat = desktopStatsOf(row)
      return h('span', { class: 'lib__installed' }, [
        h('span', {}, `设备 ${String(stat.devices)} 台`),
        stat.bundledDevices > 0
          ? h(MiniTag, { text: `内置 ${String(stat.bundledDevices)}`, tone: 'sky', size: 'sm' })
          : null,
        stat.outdated > 0
          ? h(MiniTag, { text: `${String(stat.outdated)} 待升级`, tone: 'butter', size: 'sm' })
          : null,
      ])
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'lib__actions' }, [
        h(
          NButton,
          { size: 'tiny', onClick: () => void router.push(detailLink(row)) },
          { default: () => '详情' },
        ),
        h(
          NPopconfirm,
          { onPositiveClick: () => void removeFromDesktop(row), positiveText: '移出', negativeText: '取消' },
          {
            trigger: () =>
              h(
                NButton,
                { size: 'tiny', quaternary: true, type: 'error', 'data-testid': `lib-remove-${row.id}` },
                { default: () => '移出' },
              ),
            default: () => `把 ${row.displayName} 移出桌面插件库？云端库不受影响。`,
          },
        ),
      ]),
  },
])
</script>

<template>
  <div class="lib">
    <AdminErrorNotice :error="error" title="桌面插件库加载失败" @retry="reload" />

    <SoftCard compact>
      <div class="lib__toolbar">
        <NInput v-model:value="keyword" size="small" class="lib__search" placeholder="搜索插件名 / 包名" clearable />
        <span class="lib__count">共 {{ filtered.length }} 个桌面插件</span>
        <span class="lib__spacer" />
        <NButton size="small" type="primary" secondary data-testid="lib-add-open" @click="openAdd">
          <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
          加入桌面插件库
        </NButton>
      </div>
    </SoftCard>

    <EmptyState
      v-if="!loading && plugins.length === 0"
      title="桌面插件库还是空的"
      description="把云端插件库里的插件加进来，或者直接上传桌面整包（会顺手加入）。"
      action-text="加入桌面插件库"
      @action="openAdd"
    />

    <SoftCard v-else :padded="false">
      <Transition name="lib-batch">
        <div v-if="selected.length > 0" class="lib__batch" role="region" aria-label="批量操作">
          <span class="lib__batch-count">已选 {{ selected.length }} 个</span>
          <div class="lib__batch-actions">
            <NButton size="small" type="primary" :disabled="overLimit" @click="deliver('install')">
              下发 / 安装
            </NButton>
            <NButton size="small" :disabled="overLimit" @click="deliver('upgrade')">升级已安装设备</NButton>
            <NButton size="small" :disabled="overLimit" @click="deliver('uninstall')">卸载</NButton>
            <span v-if="overLimit" class="lib__batch-warn">
              <span class="i-ph-warning-circle" aria-hidden="true" />
              一次最多 {{ PLUGIN_DELIVERY_LIMIT }} 个
            </span>
          </div>
          <NButton size="small" quaternary class="lib__batch-clear" @click="clearSelection">清空</NButton>
        </div>
      </Transition>

      <NDataTable
        :columns="columns"
        :data="paged"
        :loading="loading"
        :row-key="(row: AdminPluginRow) => row.id"
        :scroll-x="1000"
        size="small"
        :pagination="{
          page: page,
          pageSize: PAGE_SIZE,
          itemCount: filtered.length,
          showSizePicker: false,
          onUpdatePage: (value: number) => (page = value),
        }"
        data-testid="lib-table"
      >
        <template #empty>
          <div class="lib__empty">没有匹配的插件</div>
        </template>
      </NDataTable>
      <p v-if="pageCount > 1" class="lib__pager-hint">共 {{ pageCount }} 页</p>
    </SoftCard>

    <SoftCard title="桌面整包">
      <template #title-extra>
        <InfoTip
          text="上传 .tgz 会创建一个桌面版本（版本号取包内 package.json）；桌面端从 Hub 下载后按 sha256 校验再装。claude 二进制不能由 Hub 托管，codex 整包必须带 LICENSE 与 NOTICE。"
        />
      </template>

      <div class="lib__form">
        <label class="lib__field">
          <span class="lib__field-label">插件</span>
          <NSelect
            v-model:value="uploadPluginId"
            :options="uploadOptions"
            placeholder="选插件"
            filterable
            size="small"
            data-testid="lib-package-plugin"
          />
        </label>
        <div class="lib__field lib__field--file">
          <span class="lib__field-label">整包</span>
          <div class="lib__picker">
            <NButton size="small" secondary data-testid="lib-package-pick" @click="pickPackage">
              <template #icon><span class="i-ph-file-arrow-up" aria-hidden="true" /></template>
              选择整包
            </NButton>
            <span v-if="uploadFile" class="lib__picker-file" data-testid="lib-package-selected">
              {{ uploadFile.name }}（{{ formatBytes(uploadFile.size) }}）
            </span>
            <span v-else class="lib__picker-file lib__picker-file--empty" data-testid="lib-package-empty">—</span>
            <input
              ref="packageInput"
              type="file"
              accept=".tgz,application/gzip"
              class="lib__file"
              data-testid="lib-package-file"
              @change="onPickFile"
            />
          </div>
        </div>
        <NButton
          size="small"
          type="primary"
          :disabled="uploading || uploadFile === null"
          :loading="uploading"
          data-testid="lib-package-upload"
          @click="submitUpload"
        >
          上传
        </NButton>
      </div>

      <DesktopUploadProgress
        v-if="uploadProgress"
        :percent="uploadProgress.percent"
        :loaded="uploadProgress.loaded"
        :total="uploadProgress.total"
        :file-name="uploadFileName"
        :error="uploadError"
        :error-detail="uploadErrorDetail"
      />
      <div v-else-if="uploadError" class="lib__error" role="alert" data-testid="lib-package-error">
        {{ uploadError }}
        <p v-if="uploadErrorDetail" class="lib__error-detail">{{ uploadErrorDetail }}</p>
      </div>
    </SoftCard>

    <NModal
      v-model:show="showAdd"
      preset="card"
      class="lib__modal"
      title="加入桌面插件库"
      :bordered="false"
    >
      <p class="lib__modal-line">
        从云端插件库里选一个插件加入桌面库（桌面策略独立；上传整包后才能下发）。
      </p>
      <div class="lib__form lib__form--column">
        <label class="lib__field">
          <span class="lib__field-label">插件</span>
          <NSelect
            v-model:value="addTarget"
            :options="addOptions"
            placeholder="选一个还没在桌面库里的插件"
            filterable
            size="small"
            data-testid="lib-add-plugin"
          />
        </label>
        <label class="lib__field">
          <span class="lib__field-label">桌面策略</span>
          <NSelect v-model:value="addPolicy" :options="POLICY_OPTIONS" size="small" data-testid="lib-add-policy" />
        </label>
      </div>
      <NAlert v-if="addError" type="error" :bordered="false" data-testid="lib-add-error">{{ addError }}</NAlert>
      <template #footer>
        <div class="lib__modal-footer">
          <NButton size="small" @click="showAdd = false">取消</NButton>
          <NButton size="small" type="primary" :loading="adding" data-testid="lib-add-confirm" @click="submitAdd">
            加入
          </NButton>
        </div>
      </template>
    </NModal>

    <NModal
      :show="forceRow !== null"
      preset="card"
      class="lib__modal"
      title="移出桌面插件库"
      :bordered="false"
      @update:show="(value: boolean) => (value ? undefined : (forceRow = null))"
    >
      <p class="lib__modal-line">
        {{ forceRow?.displayName }} 还有桌面端下发目标：移出会一并撤销这些目标（设备上已经装的保留现状）
        并生成新 revision。需要二次密码确认。
      </p>
      <NAlert v-if="forceError" type="error" :bordered="false">{{ forceError }}</NAlert>
      <template #footer>
        <div class="lib__modal-footer">
          <NButton size="small" @click="forceRow = null">取消</NButton>
          <NButton
            size="small"
            type="error"
            :loading="forceBusy"
            data-testid="lib-force-confirm"
            @click="forceRemove"
          >
            撤销目标并移出
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.lib {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.lib__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.lib__search {
  width: 240px;
}

.lib__count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.lib__spacer {
  flex: 1;
}

.lib__batch {
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

.lib__batch-count {
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.lib__batch-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-left: var(--space-1);
}

.lib__batch-warn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.lib__batch-clear {
  margin-left: auto;
  flex: none;
}

.lib-batch-enter-active,
.lib-batch-leave-active {
  transition:
    opacity var(--duration-base) var(--ease-out-soft),
    transform var(--duration-base) var(--ease-out-soft);
}

.lib-batch-enter-from,
.lib-batch-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.lib__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}

.lib__form--column {
  flex-direction: column;
  align-items: stretch;
}

.lib__field {
  display: flex;
  min-width: 200px;
  flex: 1 1 200px;
  flex-direction: column;
  gap: var(--space-1);
}

.lib__field--file {
  flex: 1 1 240px;
}

.lib__field-label {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.lib__picker {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* 原生选择框只负责把系统弹窗转出来，界面上看到的是「选择整包」按钮 + 文件名 */
.lib__file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.lib__picker-file {
  overflow: hidden;
  color: var(--c-text-2);
  font-size: var(--fs-14);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib__picker-file--empty {
  color: var(--c-text-3);
}

.lib__error {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.lib__error-detail {
  margin-top: 2px;
  font-size: var(--fs-12);
}

.lib__pager-hint {
  padding: var(--space-2) var(--space-4);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

:deep(.lib__cell) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

:deep(.lib__name-row) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

:deep(.lib__name) {
  overflow: hidden;
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.lib__pkg) {
  overflow: hidden;
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.lib__sub) {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.lib__mono) {
  font-family: var(--font-mono);
  white-space: nowrap;
}

:deep(.lib__installed) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

:deep(.lib__actions) {
  display: flex;
  gap: var(--space-1);
  white-space: nowrap;
}

.lib__modal {
  width: 480px;
  max-width: calc(100vw - 32px);
}

.lib__modal-line {
  margin-bottom: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.lib__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.lib__empty {
  padding: var(--space-4) 0;
  color: var(--c-text-3);
}
</style>
