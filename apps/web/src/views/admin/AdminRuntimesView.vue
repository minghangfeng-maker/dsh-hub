<script setup lang="ts">
import type { AdminRuntimeRow } from '@dsh-hub/shared'
import { NButton, NForm, NFormItem, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  createRuntime,
  deleteRuntime,
  listAvailableRuntimes,
  listRuntimes,
  updateRuntime,
} from '@/api/admin-runtimes'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import DesktopRuntimesPanel from '@/components/admin/desktop/DesktopRuntimesPanel.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAdminPlatform } from '@/composables/admin-platform'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatBytes, formatDateTime, fromNow } from '@/composables/useFormat'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'

/**
 * DSH 版本（07 §7.6；docs/22 §1.3 加平台切换）：
 * - **云端**：镜像版本时间线卡片 + 「构建新版本」，构建提交后直接跳任务详情实时看构建日志
 *   （06 §3 的 `runtime.build` 任务）；
 * - **桌面**：安装包与渠道、灰度、强更地板（原「桌面端 · 版本与升级」）+「其它配置片段」。
 */
const { platform, isDesktop } = useAdminPlatform()
const router = useRouter()
const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => listRuntimes())
const { data: available, reload: reloadAvailable } = useAsyncData(() => listAvailableRuntimes())

const runtimes = computed<AdminRuntimeRow[]>(() => data.value ?? [])
const busy = ref(false)

const STATUS_TONE: Record<string, 'primary' | 'sky' | 'butter' | 'danger' | 'neutral'> = {
  ready: 'primary',
  building: 'sky',
  failed: 'danger',
  retired: 'neutral',
}

const STATUS_TEXT: Record<string, string> = {
  ready: '就绪',
  building: '构建中',
  failed: '构建失败',
  retired: '已下线',
}

// ── 构建新版本 ──

const showBuild = ref(false)
const buildVersion = ref('')
const buildNotes = ref('')
const building = ref(false)

const versionOptions = computed(() => {
  const info = available.value
  if (!info) return []

  return info.versions.map((version) => {
    const suffix = version === info.latest ? ' · latest' : version === info.next ? ' · next' : ''
    return { label: `${version}${suffix}`, value: version }
  })
})

function openBuild(): void {
  const info = available.value
  buildVersion.value = info?.latest ?? info?.versions[0] ?? '0.2.0-rc.2'
  buildNotes.value = ''
  showBuild.value = true
  if (!info) void reloadAvailable()
}

async function submitBuild(): Promise<void> {
  building.value = true
  try {
    const created = await createRuntime({
      dshVersion: buildVersion.value.trim(),
      notes: buildNotes.value.trim() || undefined,
    })
    message.success('已创建构建任务，正在跳任务详情')
    showBuild.value = false
    await reload()
    await router.push(`/admin/jobs/${created.jobId}`)
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    building.value = false
  }
}

// ── 卡片操作 ──

async function setDefault(row: AdminRuntimeRow): Promise<void> {
  busy.value = true
  try {
    await updateRuntime(row.id, { isDefault: true })
    message.success(`${row.dshVersion} 已设为默认版本（下次重建生效）`)
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    busy.value = false
  }
}

async function retire(row: AdminRuntimeRow): Promise<void> {
  busy.value = true
  try {
    await updateRuntime(row.id, { status: 'retired' })
    message.success(`${row.dshVersion} 已下线，不能再作为下发目标`)
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    busy.value = false
  }
}

async function remove(row: AdminRuntimeRow): Promise<void> {
  try {
    await sensitive(() => deleteRuntime(row.id), {
      title: `删除 DSH 版本 ${row.dshVersion}`,
      description: '会同时删除本地镜像；仍有用户使用时服务端会拒绝。',
      confirmText: '删除',
      type: 'error',
    })
    message.success('版本已删除')
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

function rollout(row: AdminRuntimeRow): void {
  void router.push({ path: '/admin/rollouts/new', query: { kind: 'runtime', runtimeId: String(row.id) } })
}
</script>

<template>
  <AdminPage title="DSH 版本" :platform="platform">
    <template #platform>
      <PlatformSwitch v-model="platform" />
    </template>

    <template #actions>
      <template v-if="!isDesktop">
        <NButton size="small" type="primary" @click="openBuild">
          <template #icon><span class="i-ph-hammer" aria-hidden="true" /></template>
          构建新版本
        </NButton>
        <NButton size="small" :loading="loading" @click="reload">
          <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
          刷新
        </NButton>
      </template>
    </template>

    <DesktopRuntimesPanel v-if="isDesktop" />

    <template v-else>
      <AdminErrorNotice :error="error" title="版本列表加载失败" @retry="reload" />

    <SoftCard compact>
      <div class="runtimes__summary">
        <MiniTag :text="`共 ${runtimes.length} 个版本`" tone="neutral" icon="i-ph-git-branch" />
        <MiniTag
          :text="available ? `npm 上最新 ${available.latest ?? '未知'}` : '正在读取 npm 版本…'"
          tone="sky"
          icon="i-ph-cloud"
        />
      </div>
    </SoftCard>

    <EmptyState
      v-if="runtimes.length === 0"
      title="还没有构建任何 DSH 版本"
      description="先构建一个版本，用户实例才能启动。默认预填 npm 上的最新版本。"
      action-text="构建新版本"
      @action="openBuild"
    />

    <ol v-else class="runtimes__timeline">
      <li v-for="row in runtimes" :key="row.id" class="runtime-card">
        <span
          class="runtime-card__dot"
          :class="{ 'runtime-card__dot--default': row.isDefault }"
          aria-hidden="true"
        >
          <span :class="row.status === 'building' ? 'i-ph-circle-notch ring-spin' : 'i-ph-git-commit'" />
        </span>

        <div class="runtime-card__body">
          <header class="runtime-card__head">
            <span class="runtime-card__version">{{ row.dshVersion }}</span>
            <MiniTag
              :text="STATUS_TEXT[row.status] ?? row.status"
              :tone="STATUS_TONE[row.status] ?? 'neutral'"
              size="sm"
            />
            <MiniTag v-if="row.isDefault" text="默认" tone="sakura" icon="i-ph-star" size="sm" />
            <span class="runtime-card__time"
              >{{ formatDateTime(row.createdAt) }}（{{ fromNow(row.createdAt) }}）</span
            >
          </header>

          <dl class="runtime-card__meta">
            <div>
              <dt>镜像</dt>
              <dd class="font-mono">{{ row.image }}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{{ row.sizeBytes === null ? '未知' : formatBytes(row.sizeBytes) }}</dd>
            </div>
            <div>
              <dt>使用人数</dt>
              <dd>{{ row.usersOnIt }}</dd>
            </div>
          </dl>

          <p v-if="row.notes" class="runtime-card__notes">{{ row.notes }}</p>

          <footer class="runtime-card__actions">
            <NButton
              size="tiny"
              type="primary"
              ghost
              :disabled="row.isDefault || row.status !== 'ready'"
              :loading="busy"
              @click="setDefault(row)"
            >
              设为默认
            </NButton>
            <NButton size="tiny" :disabled="row.status !== 'ready'" @click="rollout(row)">下发升级</NButton>
            <NButton
              size="tiny"
              quaternary
              :disabled="row.status === 'retired' || row.status === 'building'"
              :loading="busy"
              @click="retire(row)"
            >
              下线
            </NButton>
            <NButton
              size="tiny"
              type="error"
              ghost
              :disabled="row.isDefault || row.usersOnIt > 0"
              @click="remove(row)"
            >
              删除
            </NButton>
            <RouterLink :to="`/admin/jobs?type=runtime.build`" class="runtime-card__log-link hub-link">
              <span class="i-ph-list-checks" aria-hidden="true" /> 构建日志
            </RouterLink>
          </footer>
        </div>
      </li>
    </ol>

    <NModal v-model:show="showBuild" preset="card" title="构建新的 DSH 版本" :style="{ maxWidth: '480px' }">
      <NForm label-placement="top" size="small">
        <NFormItem label="DSH 版本" required>
          <NSelect
            v-model:value="buildVersion"
            filterable
            tag
            :options="versionOptions"
            placeholder="选择或直接输入版本号"
          />
        </NFormItem>
        <NFormItem label="备注">
          <NInput v-model:value="buildNotes" placeholder="例如：升级到修复了 SSE 断线的版本" />
        </NFormItem>
      </NForm>
      <p class="runtimes__build-hint">
        构建会打包 `runtime/` 镜像并跑一次 `dsh --version` 冒烟测试；失败可在任务详情的日志面板里看到原因。
      </p>
      <template #footer>
        <div class="runtimes__modal-footer">
          <NButton size="small" @click="showBuild = false">取消</NButton>
          <NButton
            size="small"
            type="primary"
            :loading="building"
            :disabled="!buildVersion"
            @click="submitBuild"
          >
            开始构建
          </NButton>
        </div>
      </template>
      </NModal>
    </template>
  </AdminPage>
</template>

<style scoped>
.runtimes__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.runtimes__timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.runtime-card {
  position: relative;
  display: flex;
  gap: var(--space-4);
}

/* 时间轴细线 */
.runtime-card::before {
  position: absolute;
  top: 30px;
  bottom: calc(-1 * var(--space-4));
  left: 15px;
  width: 1px;
  background: var(--c-border);
  content: '';
}

.runtime-card:last-child::before {
  display: none;
}

.runtime-card__dot {
  z-index: 1;
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: var(--border-width) solid var(--c-border);
  border-radius: 50%;
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: 16px;
}

.runtime-card__dot--default {
  border-color: var(--c-sakura);
  background: var(--c-sakura-soft);
  color: var(--c-sakura-ink);
}

.runtime-card__body {
  min-width: 0;
  flex: 1;
  padding: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

.runtime-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.runtime-card__version {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.runtime-card__time {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.runtime-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin-top: var(--space-3);
  font-size: var(--fs-12);
}

.runtime-card__meta dt {
  color: var(--c-text-3);
}

.runtime-card__meta dd {
  color: var(--c-text-2);
}

.runtime-card__notes {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.runtime-card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-3);
}

.runtime-card__log-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: var(--fs-12);
}

.runtimes__build-hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.runtimes__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
