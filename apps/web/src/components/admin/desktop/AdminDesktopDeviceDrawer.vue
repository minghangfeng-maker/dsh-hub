<script setup lang="ts">
import type {
  DesktopDeviceAuditItem,
  DesktopDeviceDetailResponse,
  DesktopDevicePlugin,
} from '@dsh-hub/shared'
import { NAlert, NButton, NDataTable, NDrawer, NDrawerContent, NPopconfirm, NSkeleton, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'

import { getAdminDesktopDevice, revokeAdminDesktopDevice } from '@/api/desktop'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import { desktopAuditText } from '@/components/admin/desktop/audit-text'
import MiniTag from '@/components/admin/MiniTag.vue'
import UserCell from '@/components/admin/UserCell.vue'
import {
  applyErrorText,
  applyStateText,
  applyStateTone,
  archText,
  channelText,
  pluginSourceText,
  pluginStateText,
  presenceText,
  presenceTone,
  revokeReasonText,
  systemText,
} from '@/components/desktop/text'
import type { AdminTone } from '@/components/admin/tone'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'

/**
 * 管理端设备详情抽屉（WP25f 交付物 1）：`GET /api/admin/desktop-devices/:deviceId`。
 *
 * 回答「这台机器现在什么样、装了什么、最近发生过什么」。三条纪律：
 * 1. **隐私**：只显示详情响应里的白名单字段 —— 不请求 `GET /api/admin/audit`（那会带回操作者 IP），
 *    也不把审计 `detail` 里的 `userAgent` 之类的原始上报内容摊出来（只看动作与少量结构化字段）；
 * 2. **错误态要说得清**：404 = 设备不存在（可能已彻底删除），403 = 不是管理员 —— 两种都就地显示，
 *    不静默空屏；
 * 3. **吊销放进抽屉**：看完插件与审计后往往正是要吊销它，入口不来回跳。
 */
const props = defineProps<{
  show: boolean
  /** 要看的设备；`null` = 抽屉还没打开 */
  deviceId: string | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  /** 抽屉里吊销成功：外层刷新台账（并关掉抽屉） */
  revoked: [deviceId: string]
}>()

const message = useMessage()

const detail = ref<DesktopDeviceDetailResponse | null>(null)
const loading = ref(false)
const revoking = ref(false)
/** 错误态：404 / 403 单独一种说法，其余走通用文案 */
const problem = ref<{ title: string; detail: string } | null>(null)

const device = computed(() => detail.value?.device ?? null)

async function load(): Promise<void> {
  const deviceId = props.deviceId
  if (!deviceId) return
  loading.value = true
  problem.value = null
  try {
    detail.value = await getAdminDesktopDevice(deviceId)
  } catch (cause) {
    detail.value = null
    if (isHubApiError(cause) && cause.code === 'NOT_FOUND') {
      problem.value = {
        title: '设备不存在',
        detail: '这台设备可能已经被彻底删除，刷新台账看看。',
      }
    } else if (isHubApiError(cause) && cause.code === 'FORBIDDEN') {
      problem.value = { title: '需要管理员权限', detail: '当前账号看不到这台设备的详情。' }
    } else {
      problem.value = { title: '设备详情加载失败', detail: describeError(cause).message }
    }
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.deviceId] as const,
  ([show]) => {
    if (!show) return
    detail.value = null
    void load()
  },
  { immediate: true },
)

function close(): void {
  emit('update:show', false)
}

async function revoke(): Promise<void> {
  const current = device.value
  if (!current) return
  revoking.value = true
  try {
    await withReauth(() => revokeAdminDesktopDevice(current.deviceId), {
      title: '吊销设备',
      description: `吊销 ${current.name} 后，这台桌面端会立即退出登录，本地文件与会话不受影响。`,
      confirmText: '吊销',
      type: 'warning',
    })
    message.success(`${current.name} 已吊销`)
    emit('revoked', current.deviceId)
    close()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    revoking.value = false
  }
}

// ── 台账 ────────────────────────────────────────────────────────────────────

interface Fact {
  label: string
  /** 纯文本值（时间、版本号、系统名…） */
  text?: string
  /** 状态胶囊（只有「应用状态」用） */
  tag?: { text: string; tone: AdminTone }
  /** 等宽（id / 版本号）；07 §2.8：单行、不从中断行 */
  mono?: boolean
}

const facts = computed<Fact[]>(() => {
  const current = device.value
  if (!current) return []
  const rows: Fact[] = [
    { label: '设备编号', text: current.deviceId, mono: true },
    { label: '系统', text: systemText(current.platform, current.osMajor) },
    { label: '架构', text: archText(current.arch) },
    { label: '客户端', text: current.appVersion ?? '—', mono: true },
    { label: '更新通道', text: channelText(current.appChannel) },
    { label: '运行时', text: current.runtimeVersion ?? '—', mono: true },
    {
      label: '已应用 revision',
      text: current.appliedRevision === null ? '—' : `r${String(current.appliedRevision)}`,
      mono: true,
    },
    {
      label: '期望 revision',
      text: current.desiredRevision === null ? '—' : `r${String(current.desiredRevision)}`,
      mono: true,
    },
    {
      label: '应用状态',
      tag: { text: applyStateText(current.applyState), tone: applyStateTone(current.applyState) },
    },
    { label: '首次出现', text: formatDateTime(current.firstSeenAt) },
    { label: '注册时间', text: formatDateTime(current.registeredAt) },
    { label: '最近上报', text: fromNow(current.lastReportAt) },
    { label: '最近登录', text: formatDateTime(current.lastAuthAt) },
  ]
  if (current.applyState === 'failed') {
    rows.push({
      label: '失败原因',
      text: `${applyErrorText(current.applyErrorCode)}${current.errorCount ? `（${String(current.errorCount)} 项）` : ''}`,
    })
  }
  const capabilities = current.capabilities
  if (capabilities) {
    const parts = [
      capabilities.claudeCode ? 'Claude Code' : null,
      capabilities.codex ? 'Codex' : null,
      capabilities.pwsh === 'none' ? null : `PowerShell ${capabilities.pwsh}`,
    ].filter((item): item is string => item !== null)
    if (parts.length > 0) rows.push({ label: '可用能力', text: parts.join(' · ') })
  }
  return rows
})

const pluginColumns: DataTableColumns<DesktopDevicePlugin> = [
  {
    title: '插件',
    key: 'name',
    minWidth: 220,
    render: (row) =>
      h('span', { class: 'drawer__mono', title: row.name }, row.name),
  },
  {
    title: '版本',
    key: 'version',
    width: 110,
    render: (row) =>
      h('span', { class: 'drawer__mono' }, row.version),
  },
  {
    title: '来源',
    key: 'source',
    width: 90,
    render: (row) => pluginSourceText(row.source),
  },
  {
    title: '状态',
    key: 'state',
    width: 90,
    render: (row) =>
      h(MiniTag, {
        text: pluginStateText(row.state),
        tone: (row.state === 'failed' ? 'danger' : row.state === 'enabled' ? 'success' : 'neutral') as AdminTone,
        size: 'sm',
      }),
  },
]

const pluginCount = computed(() => detail.value?.plugins.length ?? 0)

const auditColumns: DataTableColumns<DesktopDeviceAuditItem> = [
  {
    title: '时间',
    key: 'at',
    width: 150,
    render: (row) =>
      h('span', { class: 'drawer__time' }, formatDateTime(row.at)),
  },
  {
    title: '操作者',
    key: 'actor',
    width: 100,
    render: (row) =>
      h('span', { class: 'drawer__actor' }, row.actorUsername ?? '系统'),
  },
  {
    title: '动作',
    key: 'action',
    minWidth: 220,
    render: (row) => {
      const { text, raw } = desktopAuditText(row)
      return h(
        'span',
        { class: raw ? 'drawer__mono drawer__audit-raw' : 'drawer__audit', title: raw ? row.action : text },
        text,
      )
    },
  },
]
</script>

<template>
  <!-- 窄屏（<620）自动收成整屏宽：620 固定宽在 360 上会把左半边切掉 -->
  <NDrawer
    :show="show"
    width="min(620px, 100vw)"
    placement="right"
    @update:show="(value: boolean) => (value ? undefined : close())"
  >
    <NDrawerContent title="设备详情" closable data-testid="admin-desktop-detail">
      <div v-if="loading" class="drawer__loading" data-testid="admin-desktop-detail-loading">
        <NSkeleton text :repeat="3" />
        <NSkeleton text :repeat="4" />
      </div>

      <div v-else-if="problem" class="drawer__problem" role="alert" data-testid="admin-desktop-detail-error">
        <NAlert type="error" :bordered="false">
          <template #header>{{ problem.title }}</template>
          {{ problem.detail }}
        </NAlert>
        <NButton size="small" quaternary @click="load">重试</NButton>
      </div>

      <template v-else-if="detail && device">
        <div class="drawer__head">
          <div class="drawer__head-body">
            <p class="drawer__name" :title="device.name">{{ device.name }}</p>
            <div class="drawer__user">
              <UserCell :user="detail.user" :to="`/admin/users/${detail.user.id}`" />
            </div>
          </div>
          <div class="drawer__head-tags">
            <MiniTag :text="presenceText(device.presence)" :tone="presenceTone(device.presence)" size="sm" />
            <MiniTag v-if="device.revokedAt" :text="`吊销：${revokeReasonText(device.revokeReason)}`" tone="neutral" size="sm" />
          </div>
        </div>

        <dl class="drawer__facts">
          <div v-for="fact in facts" :key="fact.label" class="drawer__fact">
            <dt class="drawer__fact-label">{{ fact.label }}</dt>
            <dd class="drawer__fact-value" :class="{ 'drawer__mono': fact.mono }" :title="fact.text">
              <MiniTag v-if="fact.tag" :text="fact.tag.text" :tone="fact.tag.tone" size="sm" />
              <template v-else>{{ fact.text }}</template>
            </dd>
          </div>
        </dl>

        <section class="drawer__section">
          <header class="drawer__section-head">
            <h3 class="drawer__section-title">已装插件</h3>
            <span class="drawer__section-count" data-testid="admin-desktop-detail-plugin-count">{{ pluginCount }} 个</span>
          </header>
          <NDataTable
            v-if="pluginCount > 0"
            :columns="pluginColumns"
            :data="detail.plugins"
            :row-key="(row: DesktopDevicePlugin) => row.name"
            :pagination="false"
            :scroll-x="510"
            size="small"
            data-testid="admin-desktop-detail-plugins"
          />
          <p v-else class="drawer__empty" data-testid="admin-desktop-detail-no-plugins">这台设备还没上报插件</p>
        </section>

        <section class="drawer__section">
          <header class="drawer__section-head">
            <h3 class="drawer__section-title">最近操作</h3>
            <span class="drawer__section-count">最近 {{ detail.audit.length }} 条</span>
          </header>
          <NDataTable
            v-if="detail.audit.length > 0"
            :columns="auditColumns"
            :data="detail.audit"
            :row-key="(row: DesktopDeviceAuditItem) => row.id"
            :pagination="false"
            :scroll-x="470"
            size="small"
            data-testid="admin-desktop-detail-audit"
          />
          <p v-else class="drawer__empty" data-testid="admin-desktop-detail-no-audit">这台设备还没有操作记录</p>
        </section>
      </template>

      <template #footer>
        <div class="drawer__footer">
          <NButton size="small" @click="close">关闭</NButton>
          <NPopconfirm
            v-if="device && !device.revokedAt"
            positive-text="确认吊销"
            @positive-click="revoke"
          >
            <template #trigger>
              <NButton size="small" type="error" :loading="revoking" data-testid="admin-desktop-detail-revoke">
                吊销
              </NButton>
            </template>
            该设备将退出登录，本地文件与会话不受影响。确定吗？
          </NPopconfirm>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.drawer__loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.drawer__problem {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}

.drawer__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: var(--border-width) solid var(--c-border);
}

.drawer__head-body {
  min-width: 0;
}

.drawer__name {
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-18);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer__user {
  display: flex;
  margin-top: var(--space-1);
  min-width: 0;
}

.drawer__head-tags {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1);
}

.drawer__facts {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  margin-top: var(--space-3);
}

.drawer__fact {
  min-width: 0;
}

.drawer__fact-label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.drawer__fact-value {
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer__section {
  margin-top: var(--space-5);
}

.drawer__section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.drawer__section-title {
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.drawer__section-count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.drawer__empty {
  padding: var(--space-3) 0;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.drawer__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* 行渲染函数（h()）里的节点拿不到 scoped 的 data-v 属性：样式必须 :deep() 命中 */
:deep(.drawer__mono) {
  overflow: hidden;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.drawer__time) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.drawer__actor) {
  white-space: nowrap;
}

:deep(.drawer__audit),
:deep(.drawer__audit-raw) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
