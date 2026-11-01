<script setup lang="ts">
import type { JobSummary } from '@dsh-hub/shared'
import { NButton, NDataTable, NInput, NSelect, useMessage, type DataTableColumns } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { listJobs } from '@/api/admin-jobs'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import DesktopManifestPanel from '@/components/admin/desktop/DesktopManifestPanel.vue'
import JobProgress from '@/components/admin/JobProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAdminPlatform } from '@/composables/admin-platform'
import { JOB_STATUS_TONE, jobPercent, jobTypeIcon, jobTypeText } from '@/composables/job-meta'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { JOB_STATUS_TEXT } from '@/composables/useInstanceStatus'
import { useTableQuery } from '@/composables/table-query'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'
import { jobAction } from '@/api/admin-jobs'

/**
 * 任务中心（07 §7.9；docs/22 §1.3 加平台切换）：
 * - **云端**：实例任务（类型 / 状态筛选与 URL 同步、进度条、创建人与时间，进行中的每 10 秒刷新）；
 * - **桌面**：桌面清单的版本记录与已下发条目（`DesktopManifestPanel`，原「桌面端 · 总览」的清单部分）。
 *
 * 两侧的「任务」不是同一个东西：云端是实例上的异步任务（job），桌面是一次次清单下发（revision）。
 */
const { platform, isDesktop } = useAdminPlatform()
const router = useRouter()
const message = useMessage()

const DEFAULTS = { type: '', status: '', q: '', page: 1, pageSize: 20 }
type JobsQuery = typeof DEFAULTS

const { state, update, reset } = useTableQuery<JobsQuery>(DEFAULTS)

const searchInput = ref(state.value.q)
watch(
  () => state.value.q,
  (value) => {
    if (value !== searchInput.value) searchInput.value = value
  },
)

const { data, loading, error, reload } = useAsyncData(
  () =>
    listJobs({
      type: (state.value.type || undefined) as never,
      status: (state.value.status || undefined) as never,
      page: state.value.page,
      pageSize: state.value.pageSize,
    }),
  { pollMs: 10_000 },
)
watch(
  () => ({ ...state.value }),
  () => {
    // 本地过滤只影响展示，改关键词不必重新请求
    if (searchInput.value.trim() !== state.value.q) return
    void reload()
  },
)

const allRows = computed<JobSummary[]>(() => data.value?.items ?? [])

/** 标题关键词是本地过滤（04 §4.8 的列表接口没有 q 参数）。 */
const rows = computed<JobSummary[]>(() => {
  const keyword = searchInput.value.trim().toLowerCase()
  if (!keyword) return allRows.value
  return allRows.value.filter((job) => {
    return (
      job.title.toLowerCase().includes(keyword) ||
      jobTypeText(job.type).toLowerCase().includes(keyword) ||
      String(job.id) === keyword
    )
  })
})
const total = computed(() => data.value?.total ?? 0)

const typeOptions = [
  { label: '全部类型', value: '' },
  { label: '插件下发', value: 'rollout.plugin' },
  { label: 'DSH 升级', value: 'rollout.runtime' },
  { label: '模型配置', value: 'rollout.models' },
  { label: '模式配置', value: 'rollout.agent-mode' },
  { label: '构建版本', value: 'runtime.build' },
  { label: '数据导出', value: 'export' },
  { label: '重建实例', value: 'instance.recreate' },
]

const statusOptions = [
  { label: '全部状态', value: '' },
  { label: '排队中', value: 'queued' },
  { label: '进行中', value: 'running' },
  { label: '已暂停', value: 'paused' },
  { label: '已完成', value: 'succeeded' },
  { label: '部分成功', value: 'partial' },
  { label: '失败', value: 'failed' },
  { label: '已取消', value: 'canceled' },
]

async function cancel(job: JobSummary): Promise<void> {
  try {
    await sensitive(() => jobAction(job.id, 'cancel'), {
      title: `取消任务 ${job.title || jobTypeText(job.type)}`,
      description: '已执行的部分不会回滚，剩余目标会被跳过。',
      confirmText: '取消任务',
      type: 'warning',
    })
    message.success('任务已取消')
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

const columns = computed<DataTableColumns<JobSummary>>(() => [
  {
    title: '任务',
    key: 'title',
    minWidth: 260,
    fixed: 'left',
    render: (row) =>
      h('div', { class: 'jobs__title' }, [
        h('span', { class: [jobTypeIcon(row.type), 'jobs__icon'] }),
        h('div', { class: 'jobs__title-body' }, [
          h('span', { class: 'jobs__title-text' }, row.title || jobTypeText(row.type)),
          h('span', { class: 'jobs__type' }, `${jobTypeText(row.type)} · #${row.id}`),
        ]),
      ]),
  },
  {
    title: '状态',
    key: 'status',
    width: 110,
    render: (row) =>
      h(MiniTag, {
        text: JOB_STATUS_TEXT[row.status] ?? row.status,
        tone: JOB_STATUS_TONE[row.status],
        size: 'sm',
      }),
  },
  {
    title: '进度',
    key: 'progress',
    width: 220,
    render: (row) =>
      h('div', { class: 'jobs__progress' }, [
        h(JobProgress, { total: row.total, done: row.done, failed: row.failed, size: 'sm' }),
        h('span', { class: 'jobs__percent' }, `${jobPercent(row)}%`),
      ]),
  },
  {
    title: '创建人',
    key: 'createdBy',
    width: 120,
    render: (row) => row.createdByUsername ?? '系统',
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 150,
    render: (row) => fromNow(row.createdAt),
  },
  {
    title: '结束时间',
    key: 'finishedAt',
    width: 160,
    render: (row) => (row.finishedAt ? formatDateTime(row.finishedAt) : '—'),
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'jobs__actions' }, [
        h(
          NButton,
          { size: 'tiny', onClick: () => void router.push(`/admin/jobs/${row.id}`) },
          { default: () => '详情' },
        ),
        ['queued', 'running', 'paused'].includes(row.status)
          ? h(
              NButton,
              { size: 'tiny', type: 'warning', ghost: true, onClick: () => void cancel(row) },
              { default: () => '取消' },
            )
          : null,
      ]),
  },
])
</script>

<template>
  <AdminPage title="任务中心" wide :platform="platform">
    <template #platform>
      <PlatformSwitch v-model="platform" />
    </template>

    <template #actions>
      <NButton v-if="!isDesktop" size="small" :loading="loading" @click="reload">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </template>

    <DesktopManifestPanel v-if="isDesktop" />

    <template v-else>
      <AdminErrorNotice :error="error" title="任务列表加载失败" @retry="reload" />

    <SoftCard :padded="false">
      <div class="jobs__toolbar">
        <NInput
          v-model:value="searchInput"
          class="jobs__search"
          size="small"
          placeholder="搜索任务标题（本地过滤）"
          clearable
        />
        <NSelect v-model:value="state.type" class="jobs__select" size="small" :options="typeOptions" />
        <NSelect v-model:value="state.status" class="jobs__select" size="small" :options="statusOptions" />
        <NButton size="small" quaternary @click="reset">清空筛选</NButton>
        <span class="jobs__count">共 {{ total }} 个任务</span>
      </div>

      <NDataTable
        class="jobs__table"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="(row: JobSummary) => row.id"
        :scroll-x="1120"
        remote
        size="small"
        :pagination="{
          page: state.page,
          pageSize: state.pageSize,
          itemCount: total,
          pageSizes: [20, 50, 100],
          showSizePicker: true,
          onUpdatePage: (page: number) => update({ page }),
          onUpdatePageSize: (pageSize: number) => update({ pageSize, page: 1 }),
        }"
      />
      </SoftCard>
    </template>
  </AdminPage>
</template>

<style scoped>
.jobs__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width) solid var(--c-border);
}

.jobs__search {
  width: 220px;
}

.jobs__select {
  width: 148px;
}

.jobs__count {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.jobs__table {
  padding: 0 var(--space-2) var(--space-2);
}

:deep(.jobs__title) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

:deep(.jobs__icon) {
  color: var(--c-primary);
  font-size: 18px;
}

:deep(.jobs__title-body) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.jobs__title-text) {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

:deep(.jobs__type) {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

:deep(.jobs__progress) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

:deep(.jobs__percent) {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  font-variant-numeric: tabular-nums;
}

:deep(.jobs__actions) {
  display: flex;
  gap: 4px;
}
</style>
