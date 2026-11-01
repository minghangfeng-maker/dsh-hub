<script setup lang="ts">
import type { JobStatus, JobSummary, JobTaskSummary } from '@dsh-hub/shared'
import { NButton, NDataTable, useMessage, type DataTableColumns } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { getJob, getJobTaskLog, jobAction, jobEventsUrl } from '@/api/admin-jobs'
import { describeError } from '@/api/errors'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import JobProgress from '@/components/admin/JobProgress.vue'
import JsonCollapse from '@/components/admin/JsonCollapse.vue'
import LogViewer from '@/components/admin/LogViewer.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import UserCell from '@/components/admin/UserCell.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import {
  JOB_STATUS_TONE,
  isJobActive,
  jobPercent,
  jobTaskStatusText,
  jobTypeText,
} from '@/composables/job-meta'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, formatDuration, fromNow } from '@/composables/useFormat'
import { JOB_STATUS_TEXT } from '@/composables/useInstanceStatus'
import { useSse } from '@/composables/useSse'
import { isReauthCanceled, sensitive, withReauth } from '@/composables/useReauth'

/**
 * 任务详情（07 §7.9）：顶部进度与操作（暂停 / 继续 / 取消 / 重试失败），
 * task 表（用户、状态、耗时、错误摘要），右侧日志面板实时追加选中 task 的日志。
 */
const route = useRoute()
const message = useMessage()

const jobId = computed(() => Number(route.params['id']))

const { data, loading, error, reload } = useAsyncData(() => getJob(jobId.value))

const job = computed<JobSummary | null>(() => data.value?.job ?? null)
const tasks = ref<JobTaskSummary[]>([])
const selectedTaskId = ref<number | null>(null)
const selectedUserId = ref<number | null>(null)
const logText = ref('')
const logLoading = ref(false)
const streaming = ref(true)

watch(
  data,
  (value) => {
    if (!value) return
    tasks.value = [...value.tasks]
    if (selectedTaskId.value === null) {
      const first = value.tasks.find((task) => task.status === 'running') ?? value.tasks[0]
      if (first) void selectTask(first)
    }
  },
  { immediate: true },
)

watch(jobId, () => {
  selectedTaskId.value = null
  logText.value = ''
  void reload()
})

// ── SSE：job / task / log 三类事件（04 §4.8） ──

const {
  status: sseStatus,
  open: openStream,
  close: closeStream,
} = useSse(() => jobEventsUrl(jobId.value), {
  immediate: true,
  events: {
    job: (payload) => {
      const event = payload as { job?: JobSummary } | null
      if (event?.job && data.value) data.value = { ...data.value, job: event.job }
    },
    task: (payload) => {
      const event = payload as { task?: JobTaskSummary } | null
      if (!event?.task) return
      const incoming = event.task
      const index = tasks.value.findIndex((task) => task.id === incoming.id)
      tasks.value =
        index === -1
          ? [...tasks.value, incoming].sort((a, b) => a.seq - b.seq)
          : tasks.value.map((task) => (task.id === incoming.id ? incoming : task))
    },
    log: (payload) => {
      const event = payload as { taskId?: number; chunk?: string } | null
      if (!event || event.taskId !== selectedTaskId.value || typeof event.chunk !== 'string') return
      logText.value = `${logText.value}${event.chunk}`
    },
  },
})

// 「暂停刷新」= 断开 SSE，恢复时重连并补一次全量
watch(streaming, (value) => {
  if (value) {
    openStream()
    void reload()
  } else {
    closeStream()
  }
})

// ── 选中 task → 拉一次历史日志，之后由 SSE 追加 ──

async function selectTask(task: JobTaskSummary): Promise<void> {
  selectedTaskId.value = task.id
  selectedUserId.value = task.userId
  logLoading.value = true
  logText.value = ''
  try {
    const result = await getJobTaskLog(jobId.value, task.id)
    logText.value = result.text
  } catch (cause) {
    logText.value = `读取日志失败：${describeError(cause).message}`
  } finally {
    logLoading.value = false
  }
}

// ── 操作 ──

const busy = ref(false)

async function run(
  action: 'pause' | 'resume' | 'cancel' | 'retry-failed',
  options: { confirm?: boolean } = {},
): Promise<void> {
  const current = job.value
  if (!current) return

  const label: Record<string, string> = {
    pause: '暂停任务',
    resume: '继续任务',
    cancel: '取消任务',
    'retry-failed': '重试失败项',
  }

  busy.value = true
  try {
    const call = () => jobAction(current.id, action)
    if (options.confirm) {
      await sensitive(call, {
        title: label[action] ?? action,
        description: `${current.title || jobTypeText(current.type)}：这个操作会写入审计日志。`,
        confirmText: label[action] ?? '确认',
        type: action === 'cancel' ? 'warning' : 'primary',
      })
    } else {
      await withReauth(call, { title: label[action] ?? action, confirmText: '确认' })
    }
    message.success('操作已提交')
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    busy.value = false
  }
}

// ── 展示 ──

const counts = computed(() => {
  const result: Record<string, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
  }
  for (const task of tasks.value) result[task.status] = (result[task.status] ?? 0) + 1
  return result
})

function durationOf(task: JobTaskSummary): string {
  if (!task.startedAt) return '—'
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now()
  const span = end - new Date(task.startedAt).getTime()
  return Number.isFinite(span) && span >= 0 ? formatDuration(span, 'ms') : '—'
}

const TASK_STATUS_TONE: Record<string, 'primary' | 'sky' | 'butter' | 'danger' | 'neutral'> = {
  pending: 'neutral',
  running: 'sky',
  succeeded: 'primary',
  failed: 'danger',
  skipped: 'neutral',
  canceled: 'neutral',
}

const columns = computed<DataTableColumns<JobTaskSummary>>(() => [
  { title: '#', key: 'seq', width: 56 },
  {
    title: '用户',
    key: 'user',
    width: 180,
    render: (row) =>
      row.userId
        ? h(UserCell, {
            user: {
              id: row.userId,
              username: row.username ?? `#${row.userId}`,
              displayName: '',
              avatarUrl: null,
            },
            to: `/admin/users/${row.userId}`,
          })
        : (row.username ?? '系统'),
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) =>
      h(MiniTag, {
        text: jobTaskStatusText(row.status),
        tone: TASK_STATUS_TONE[row.status] ?? 'neutral',
        size: 'sm',
      }),
  },
  { title: '尝试', key: 'attempt', width: 70, render: (row) => `${row.attempt}` },
  { title: '耗时', key: 'duration', width: 110, render: (row) => durationOf(row) },
  {
    title: '错误',
    key: 'error',
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (row) => row.error ?? '—',
  },
  {
    title: '日志',
    key: 'log',
    width: 80,
    fixed: 'right',
    render: (row) =>
      h(
        NButton,
        {
          size: 'tiny',
          quaternary: true,
          type: selectedTaskId.value === row.id ? 'primary' : 'default',
          onClick: () => void selectTask(row),
        },
        { default: () => (selectedTaskId.value === row.id ? '查看中' : '查看') },
      ),
  },
])

const canPause = computed(() => job.value?.status === 'running')
const canResume = computed(() => job.value?.status === 'paused')
const canCancel = computed(() => job.value !== null && isJobActive(job.value.status as JobStatus))
const canRetry = computed(
  () => (job.value?.failed ?? 0) > 0 && !isJobActive((job.value?.status ?? 'failed') as JobStatus),
)
</script>

<template>
  <AdminPage
    :title="job ? job.title || jobTypeText(job.type) : '任务详情'"
    :subtitle="job ? `${jobTypeText(job.type)} · #${job.id}` : undefined"
    back-to="/admin/jobs"
    back-text="返回任务中心"
  >
    <template #actions>
      <NButton size="small" :disabled="!canPause" :loading="busy" @click="run('pause')">暂停</NButton>
      <NButton size="small" :disabled="!canResume" :loading="busy" @click="run('resume')">继续</NButton>
      <NButton size="small" :disabled="!canCancel" :loading="busy" @click="run('cancel', { confirm: true })"
        >取消</NButton
      >
      <NButton
        size="small"
        type="primary"
        :disabled="!canRetry"
        :loading="busy"
        @click="run('retry-failed', { confirm: true })"
      >
        重试失败
      </NButton>
    </template>

    <AdminErrorNotice :error="error" title="任务加载失败" @retry="reload" />

    <SoftCard v-if="!job && loading">
      <p class="text-2">正在加载任务…</p>
    </SoftCard>

    <template v-else-if="job">
      <SoftCard title="进度">
        <template #extra>
          <div class="job-detail__status">
            <MiniTag
              :text="JOB_STATUS_TEXT[job.status] ?? job.status"
              :tone="JOB_STATUS_TONE[job.status]"
              size="sm"
            />
            <MiniTag
              :text="sseStatus === 'open' ? '实时' : sseStatus === 'reconnecting' ? '重连中' : '静态'"
              :tone="sseStatus === 'open' ? 'primary' : 'neutral'"
              size="sm"
              icon="i-ph-broadcast"
            />
            <NButton size="tiny" quaternary @click="streaming = !streaming">
              {{ streaming ? '暂停刷新' : '恢复刷新' }}
            </NButton>
          </div>
        </template>

        <JobProgress :total="job.total" :done="job.done" :failed="job.failed" />

        <div class="job-detail__counts">
          <MiniTag :text="`排队 ${counts.pending ?? 0}`" tone="neutral" size="sm" />
          <MiniTag :text="`进行中 ${counts.running ?? 0}`" tone="sky" size="sm" />
          <MiniTag :text="`成功 ${counts.succeeded ?? 0}`" tone="primary" size="sm" />
          <MiniTag
            :text="`失败 ${counts.failed ?? 0}`"
            :tone="(counts.failed ?? 0) > 0 ? 'danger' : 'neutral'"
            size="sm"
          />
          <MiniTag :text="`跳过 ${counts.skipped ?? 0}`" tone="neutral" size="sm" />
          <span class="job-detail__percent">{{ jobPercent(job) }}%</span>
        </div>

        <dl class="job-detail__meta">
          <div>
            <dt>创建人</dt>
            <dd>{{ job.createdByUsername ?? '系统' }}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{{ formatDateTime(job.createdAt) }}（{{ fromNow(job.createdAt) }}）</dd>
          </div>
          <div>
            <dt>开始</dt>
            <dd>{{ formatDateTime(job.startedAt) }}</dd>
          </div>
          <div>
            <dt>结束</dt>
            <dd>{{ formatDateTime(job.finishedAt) }}</dd>
          </div>
        </dl>

        <p v-if="job.error" class="job-detail__error">{{ job.error }}</p>
      </SoftCard>

      <div class="job-detail__columns">
        <SoftCard title="目标" :padded="false">
          <EmptyState v-if="tasks.length === 0" title="这个任务还没有目标" :size="96" />
          <NDataTable
            v-else
            class="job-detail__table"
            :columns="columns"
            :data="tasks"
            :row-key="(row: JobTaskSummary) => row.id"
            :scroll-x="880"
            :pagination="{ pageSize: 15 }"
            :row-props="(row: JobTaskSummary) => ({ onClick: () => void selectTask(row) })"
            size="small"
          />
        </SoftCard>

        <SoftCard title="日志" :padded="false">
          <template #extra>
            <span class="text-3 text-[12px]">
              {{
                selectedTaskId === null
                  ? '点左侧「查看」选择任务'
                  : `任务 #${selectedTaskId}${selectedUserId ? ` · 用户 #${selectedUserId}` : ''}`
              }}
            </span>
          </template>
          <div class="job-detail__log">
            <LogViewer
              :text="logText"
              :height="360"
              :empty-text="logLoading ? '正在读取日志…' : '暂无日志'"
            />
          </div>
        </SoftCard>
      </div>

      <SoftCard title="任务 JSON">
        <JsonCollapse label="job / tasks 原始数据" :value="{ job, tasks }" />
      </SoftCard>
    </template>
  </AdminPage>
</template>

<style scoped>
.job-detail__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.job-detail__counts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.job-detail__percent {
  margin-left: auto;
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-13);
}

.job-detail__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  margin-top: var(--space-3);
  font-size: var(--fs-12);
}

.job-detail__meta dt {
  color: var(--c-text-3);
}

.job-detail__error {
  margin-top: var(--space-2);
  border-radius: var(--radius-control);
  padding: var(--space-2);
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.job-detail__columns {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(0, 1fr);
}

@media (min-width: 1280px) {
  .job-detail__columns {
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  }
}

.job-detail__table {
  padding: var(--space-2) var(--space-3);
}

.job-detail__log {
  padding: var(--space-3);
}
</style>
