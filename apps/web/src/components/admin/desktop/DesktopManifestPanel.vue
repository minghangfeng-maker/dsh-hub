<script setup lang="ts">
import type { AuditItem, DesktopDeliveryTarget, DesktopPluginTarget } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NDataTable,
  NModal,
  NPopconfirm,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'

import {
  deliverDesktopPlugin,
  getDesktopDelivery,
  listDesktopAuditLog,
  withdrawDesktopPlugin,
} from '@/api/admin-desktop'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import DesktopTargetField from '@/components/admin/desktop/DesktopTargetField.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime } from '@/composables/useFormat'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'
import {
  DEFAULT_TARGET,
  describeDeliveryAudit,
  levelLabel,
  scopeText,
  targetOfDraft,
  targetOfScope,
  type TargetDraft,
} from '@/utils/desktop-delivery'

/**
 * 任务中心 · 桌面侧（docs/22 §1.3）：桌面**清单**的版本记录与已下发条目。
 *
 * - **清单版本记录**：每次下发都会生成一个 revision（`desktop_deliveries`），发布日志里的
 *   `desktop.deliver` 审计带着 revision 与内容摘要 —— 这里按 revision 倒序列出来，能看出
 *   「谁、什么时候、把什么推给了哪些设备」；
 * - **已下发的插件**：清单里当前的受管插件条目（原「桌面端 · 插件」的已下发清单迁过来），
 *   可以查看条目详情、改目标（先下发新目标再撤旧目标）或撤回（设备上已经装的保留现状）；
 * - 配置片段 / 版本策略 / 卸载条目的条数，链接到各自页面维护（这些内容不在任务中心编辑）。
 */
const message = useMessage()

const {
  data: delivery,
  loading,
  error,
  reload,
} = useAsyncData(() => getDesktopDelivery(), { pollMs: 20_000 })

const { data: audits, reload: reloadAudits } = useAsyncData(() => listDesktopAuditLog(50))

const auditRows = computed<AuditItem[]>(() => audits.value ?? [])

interface RevisionRow {
  revision: number
  at: string
  actor: string
  kind: string
  scope: string
  summary: string
}

/** 下发条目的大类（detail 里没有显式的 kind，按它带的字段判） */
function kindOf(item: AuditItem): string {
  const detail = item.detail ?? {}
  if (detail['action'] === 'deliver' || detail['action'] === 'withdraw') return '插件'
  if (Array.isArray(detail['entryIds'])) return '配置片段'
  if (typeof detail['channel'] === 'string') return '版本策略'
  if (Array.isArray(detail['add']) || Array.isArray(detail['remove'])) return '卸载'
  return '其它'
}

function scopeOfAudit(item: AuditItem): string {
  const detail = item.detail ?? {}
  const scope = detail['scope']
  if (scope === 'role') return detail['role'] === 'admin' ? '管理员' : '普通用户'
  if (scope === 'user') return `用户 #${String(detail['userId'] ?? '')}`
  if (scope === 'all') return '全部设备'
  return '—'
}

const revisions = computed<RevisionRow[]>(() =>
  auditRows.value
    .filter((item) => item.action === 'desktop.deliver')
    .map((item) => ({
      revision: Number(item.targetId ?? 0),
      at: item.at,
      actor: item.actorUsername ?? '系统',
      kind: kindOf(item),
      scope: scopeOfAudit(item),
      summary: describeDeliveryAudit(item),
    }))
    .sort((left, right) => right.revision - left.revision),
)

const revisionColumns = computed<DataTableColumns<RevisionRow>>(() => [
  {
    title: 'revision',
    key: 'revision',
    width: 110,
    render: (row) => h('span', { class: 'manifest__mono', 'data-testid': `manifest-revision-${row.revision}` }, `r${String(row.revision)}`),
  },
  {
    title: '时间',
    key: 'at',
    width: 150,
    render: (row) => h('span', { class: 'manifest__mono' }, formatDateTime(row.at)),
  },
  {
    title: '操作人',
    key: 'actor',
    width: 110,
    render: (row) => h('span', { class: 'manifest__nowrap' }, row.actor),
  },
  {
    title: '内容',
    key: 'kind',
    width: 100,
    render: (row) => h(MiniTag, { text: row.kind, tone: 'sky', size: 'sm' }),
  },
  {
    title: '目标',
    key: 'scope',
    width: 120,
    render: (row) => h('span', { class: 'manifest__nowrap' }, row.scope),
  },
  {
    title: '改了什么',
    key: 'summary',
    minWidth: 320,
    render: (row) => h('span', { class: 'manifest__summary-text', title: row.summary }, row.summary),
  },
])

// ── 已下发的插件条目（原「桌面端 · 插件」的已下发清单）──────────────────────

const targets = computed<DesktopPluginTarget[]>(() => delivery.value?.pluginTargets ?? [])

const targetColumns = computed<DataTableColumns<DesktopPluginTarget>>(() => [
  {
    title: '插件',
    key: 'name',
    minWidth: 240,
    render: (row) =>
      h('div', { class: 'manifest__cell' }, [
        h('span', { class: 'manifest__name', 'data-testid': `manifest-target-${row.id}` }, row.displayName),
        h('span', { class: 'manifest__sub', title: row.packageName }, row.packageName),
      ]),
  },
  {
    title: '版本',
    key: 'version',
    width: 150,
    render: (row) => h('span', { class: 'manifest__mono' }, `${row.version}${row.enabled ? '' : '（禁用）'}`),
  },
  {
    title: '级别',
    key: 'level',
    width: 90,
    render: (row) =>
      h(MiniTag, {
        text: levelLabel(row.level),
        tone: row.level === 'core' ? 'primary' : row.level === 'default' ? 'sky' : 'butter',
        size: 'sm',
      }),
  },
  {
    title: '目标',
    key: 'scope',
    minWidth: 130,
    render: (row) => h('span', { class: 'manifest__nowrap' }, scopeText(row)),
  },
  {
    title: '整包',
    key: 'artifact',
    width: 96,
    render: (row) =>
      row.artifact
        ? h(MiniTag, { text: '已上传', tone: 'success', size: 'sm' })
        : h(MiniTag, { text: '缺整包', tone: 'danger', size: 'sm' }),
  },
  {
    title: '',
    key: 'actions',
    width: 200,
    render: (row) =>
      h('div', { class: 'manifest__actions' }, [
        h(
          NButton,
          { size: 'tiny', quaternary: true, 'data-testid': `manifest-view-${row.id}`, onClick: () => (detailRow.value = row) },
          { default: () => '查看' },
        ),
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            'data-testid': `manifest-retarget-${row.id}`,
            onClick: () => openRetarget(row),
          },
          { default: () => '改目标' },
        ),
        h(
          NPopconfirm,
          { onPositiveClick: () => void withdraw(row), positiveText: '撤掉', negativeText: '取消' },
          {
            trigger: () =>
              h(
                NButton,
                { size: 'tiny', quaternary: true, type: 'error', 'data-testid': `manifest-withdraw-${row.id}` },
                { default: () => '撤回' },
              ),
            default: () =>
              `撤掉 ${row.displayName} 在「${scopeText(row)}」上的受管条目？设备上已经装的会保留现状。`,
          },
        ),
      ]),
  },
])

const detailRow = ref<DesktopPluginTarget | null>(null)

const retargetRow = ref<DesktopPluginTarget | null>(null)
const retargetDraft = reactive<TargetDraft>({ ...DEFAULT_TARGET })
const retargetError = ref('')
const retargeting = ref(false)

function openRetarget(row: DesktopPluginTarget): void {
  retargetRow.value = row
  retargetDraft.scope = row.scope
  retargetDraft.role = row.role === 'admin' ? 'admin' : 'user'
  retargetDraft.userId = row.userId
  retargetError.value = ''
}

/** 改目标 = 先下发到新目标、再撤掉旧目标（两步各生成一条 revision） */
async function confirmRetarget(): Promise<void> {
  const row = retargetRow.value
  if (!row) return
  const next = targetOfDraft(retargetDraft)
  if (!next) {
    retargetError.value = '指定用户时先选一个用户'
    return
  }
  const previous = targetOfScope(row)
  if (
    previous.scope === next.scope &&
    (previous.scope !== 'role' || previous.role === (next as { role?: string }).role) &&
    (previous.scope !== 'user' || previous.userId === (next as { userId?: number }).userId)
  ) {
    retargetRow.value = null
    return
  }
  retargeting.value = true
  try {
    await withReauth(() => deliverDesktopPlugin({ target: next, pluginId: row.pluginId, versionId: row.versionId }))
    await withReauth(() => withdrawDesktopPlugin({ target: previous, pluginId: row.pluginId }))
    message.success('已改到新目标')
    retargetRow.value = null
    await refresh()
  } catch (cause) {
    if (!isReauthCanceled(cause)) retargetError.value = describeError(cause).message
  } finally {
    retargeting.value = false
  }
}

async function withdraw(row: DesktopPluginTarget): Promise<void> {
  const target: DesktopDeliveryTarget = targetOfScope(row)
  try {
    const result = await withReauth(() => withdrawDesktopPlugin({ target, pluginId: row.pluginId }))
    message.success(`已撤掉，新 revision r${String(result.revision)}`)
    await refresh()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

async function refresh(): Promise<void> {
  await reload()
  await reloadAudits()
}

/** 清单里其它内容的条数与维护入口（不在本页编辑） */
const summary = computed(() => ({
  fragments: delivery.value?.configFragments.length ?? 0,
  channels: delivery.value?.app.channels.length ?? 0,
  overrides: delivery.value?.app.overrides.length ?? 0,
  uninstalls: delivery.value?.uninstalls.length ?? 0,
  revision: delivery.value?.revision ?? 0,
}))
</script>

<template>
  <div class="manifest">
    <AdminErrorNotice :error="error" title="桌面清单加载失败" @retry="refresh" />

    <SoftCard compact>
      <div class="manifest__summary">
        <MiniTag :text="`当前 revision r${String(summary.revision)}`" tone="primary" icon="i-ph-git-commit" />
        <MiniTag :text="`受管插件 ${targets.length} 个`" tone="sky" icon="i-ph-puzzle-piece" />
        <MiniTag :text="`配置片段 ${summary.fragments} 条`" tone="neutral" icon="i-ph-file-code" />
        <MiniTag :text="`渠道策略 ${summary.channels} 条 / 覆盖 ${summary.overrides} 条`" tone="neutral" icon="i-ph-arrow-up-right" />
        <MiniTag :text="`要求卸载 ${summary.uninstalls} 个`" tone="neutral" icon="i-ph-trash" />
      </div>
    </SoftCard>

    <NAlert
      v-for="warning in delivery?.warnings ?? []"
      :key="warning"
      type="warning"
      :bordered="false"
      data-testid="manifest-warning"
    >
      {{ warning }}
    </NAlert>

    <SoftCard title="清单版本记录" :padded="false">
      <template #extra>
        <RouterLink class="manifest__link" :to="'/admin/jobs'" data-testid="manifest-jobs-link">
          任务中心的实例任务
        </RouterLink>
      </template>
      <NDataTable
        :columns="revisionColumns"
        :data="revisions"
        :loading="loading"
        :row-key="(row: RevisionRow) => row.revision"
        :pagination="{ pageSize: 10 }"
        :scroll-x="1000"
        size="small"
        data-testid="manifest-revisions-table"
      >
        <template #empty>
          <EmptyState title="还没有下发过桌面清单" illustration="cloud" :size="88" />
        </template>
      </NDataTable>
    </SoftCard>

    <SoftCard title="已下发的插件" :padded="false">
      <template #extra>
        <span class="manifest__count">{{ targets.length }} 个条目</span>
      </template>
      <NDataTable
        :columns="targetColumns"
        :data="targets"
        :loading="loading"
        :row-key="(row: DesktopPluginTarget) => row.id"
        :pagination="false"
        :scroll-x="960"
        size="small"
        data-testid="manifest-targets-table"
      >
        <template #empty>
          <EmptyState title="桌面清单里还没有插件" illustration="plane" :size="88" />
        </template>
      </NDataTable>
    </SoftCard>

    <SoftCard title="其它内容">
      <template #title-extra>
        <InfoTip text="清单里的配置片段、安装包与渠道策略在各自页面维护，任务中心只读。" />
      </template>
      <div class="manifest__links">
        <span class="manifest__links-label">配置片段 {{ summary.fragments }} 条</span>
        <RouterLink class="manifest__link" :to="'/admin/models?tab=dsh&platform=desktop'">模型配置</RouterLink>
        <RouterLink class="manifest__link" :to="'/admin/runtimes?platform=desktop'">其它配置片段</RouterLink>
        <span class="manifest__links-label">安装包与渠道</span>
        <RouterLink class="manifest__link" :to="'/admin/runtimes?platform=desktop'">DSH 版本 · 桌面</RouterLink>
      </div>
    </SoftCard>

    <NModal
      :show="detailRow !== null"
      preset="card"
      class="manifest__modal"
      title="受管条目"
      :bordered="false"
      @update:show="(value: boolean) => (value ? undefined : (detailRow = null))"
    >
      <dl v-if="detailRow" class="manifest__detail" data-testid="manifest-target-detail">
        <dt>插件</dt>
        <dd>{{ detailRow.displayName }} · {{ detailRow.packageName }}</dd>
        <dt>版本</dt>
        <dd class="manifest__mono">{{ detailRow.version }}</dd>
        <dt>级别</dt>
        <dd>{{ levelLabel(detailRow.level) }}</dd>
        <dt>目标</dt>
        <dd>{{ scopeText(detailRow) }}</dd>
        <dt>状态</dt>
        <dd>{{ detailRow.enabled ? '生效中' : '已禁用' }}</dd>
        <dt>整包</dt>
        <dd>
          {{ detailRow.artifact ? detailRow.artifact.fileName : '没有上传桌面整包' }}
        </dd>
        <dt>重启</dt>
        <dd>{{ detailRow.needsRestart ? '装完需要重启桌面端' : '不需要重启' }}</dd>
        <dt>最低 DSH</dt>
        <dd class="manifest__mono">{{ detailRow.minDsh ?? '不限' }}</dd>
      </dl>
      <template #footer>
        <div class="manifest__modal-footer">
          <NButton size="small" data-testid="manifest-detail-close" @click="detailRow = null">关闭</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      :show="retargetRow !== null"
      preset="card"
      class="manifest__modal"
      title="改目标"
      :bordered="false"
      @update:show="(value: boolean) => (value ? undefined : (retargetRow = null))"
    >
      <p class="manifest__modal-line">
        {{ retargetRow?.displayName }} {{ retargetRow?.version }}：{{
          retargetRow ? scopeText(retargetRow) : ''
        }}
        →
      </p>
      <DesktopTargetField
        :model-value="retargetDraft"
        @update:model-value="(value: TargetDraft) => Object.assign(retargetDraft, value)"
      />
      <div v-if="retargetError" class="manifest__error" role="alert">{{ retargetError }}</div>
      <template #footer>
        <div class="manifest__modal-footer">
          <NButton size="small" @click="retargetRow = null">取消</NButton>
          <NButton
            size="small"
            type="primary"
            :loading="retargeting"
            data-testid="manifest-retarget-confirm"
            @click="confirmRetarget"
          >
            下发到新目标
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.manifest {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.manifest__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.manifest__count {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.manifest__link {
  font-size: var(--fs-13);
  white-space: nowrap;
}

.manifest__links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.manifest__links-label {
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.manifest__mono {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.manifest__nowrap {
  white-space: nowrap;
}

:deep(.manifest__summary-text) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.manifest__cell) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

:deep(.manifest__name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.manifest__sub) {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.manifest__actions) {
  display: flex;
  gap: var(--space-1);
  white-space: nowrap;
}

.manifest__modal {
  width: 460px;
  max-width: calc(100vw - 32px);
}

.manifest__modal-line {
  margin-bottom: var(--space-3);
  color: var(--c-text-2);
  white-space: nowrap;
}

.manifest__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.manifest__detail {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  font-size: var(--fs-13);
}

.manifest__detail dt {
  color: var(--c-text-3);
  white-space: nowrap;
}

.manifest__detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.manifest__error {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}
</style>
