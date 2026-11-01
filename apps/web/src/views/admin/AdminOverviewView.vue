<script setup lang="ts">
import type { JobSummary } from '@dsh-hub/shared'
import { NButton } from 'naive-ui'
import { computed } from 'vue'

import { listJobs } from '@/api/admin-jobs'
import { fetchOverview } from '@/api/admin-users'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import AdminStatCard from '@/components/admin/AdminStatCard.vue'
import AuditTimeline from '@/components/admin/AuditTimeline.vue'
import JobProgress from '@/components/admin/JobProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import RingProgress from '@/components/admin/RingProgress.vue'
import UserCell from '@/components/admin/UserCell.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { JOB_STATUS_TONE, jobTypeIcon, jobTypeText } from '@/composables/job-meta'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatBytes, formatDateTime, fromNow } from '@/composables/useFormat'
import { JOB_STATUS_TEXT } from '@/composables/useInstanceStatus'

/**
 * 概览（07 §7.1）：
 * ① 四个统计卡（计数动画）；② 宿主资源环形进度 + Docker 状态 + 默认版本（无 runtime 时引导构建）；
 * ③ 最近注册 / 最近审计 / 正在进行的任务。（AI 助手在独立页 `/admin/assistant`，WP57）
 */
const {
  data,
  loading,
  error,
  reload: reloadOverview,
} = useAsyncData(() => fetchOverview(), { pollMs: 15_000 })
const { data: jobPage, reload: reloadJobs } = useAsyncData(
  () => listJobs({ status: 'running', pageSize: 5 }),
  {
    pollMs: 15_000,
  },
)

const runningJobs = computed<JobSummary[]>(() => jobPage.value?.items ?? [])

/** 一个版本都没构建成功时显示引导卡（06 §3：首次启动若没有任何 runtime）。 */
const hasRuntime = computed(() => (data.value?.runtime.versions ?? 0) > 0)

const hostRings = computed(() => {
  const host = data.value?.host
  if (!host) return []

  const cpuRatio = host.cpuCount > 0 ? host.load1 / host.cpuCount : 0
  const memUsed = Math.max(0, host.memTotal - host.memAvailable)
  const memRatio = host.memTotal > 0 ? memUsed / host.memTotal : 0
  const diskUsed = Math.max(0, host.diskTotal - host.diskFree)
  const diskRatio = host.diskTotal > 0 ? diskUsed / host.diskTotal : 0

  return [
    {
      key: 'cpu',
      label: 'CPU 负载',
      value: cpuRatio,
      hint: `1 分钟 ${host.load1.toFixed(2)}（${host.cpuCount} 核）`,
      tone: 'sky' as const,
    },
    {
      key: 'mem',
      label: '内存',
      value: memRatio,
      hint: `${formatBytes(memUsed)} / ${formatBytes(host.memTotal)}`,
      tone: 'primary' as const,
    },
    {
      key: 'disk',
      label: '磁盘',
      value: diskRatio,
      hint: `${formatBytes(diskUsed)} / ${formatBytes(host.diskTotal)}`,
      tone: 'sakura' as const,
    },
  ]
})

function reloadAll(): void {
  void reloadOverview()
  void reloadJobs()
}
</script>

<template>
  <AdminPage title="概览">
    <template #actions>
      <NButton size="small" :loading="loading" @click="reloadAll">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </template>

    <AdminErrorNotice :error="error" title="概览数据加载失败" @retry="reloadAll" />

    <template v-if="data">
      <div class="overview__stats">
        <AdminStatCard
          label="用户总数"
          :value="data.users.total"
          :hint="`今日新增 ${data.users.newToday} · 活跃 ${data.users.active}`"
          icon="i-ph-users"
          tone="primary"
          to="/admin/users"
        />
        <AdminStatCard
          label="运行中实例"
          :value="data.instances.running"
          :suffix="`/ ${data.instances.max}`"
          :hint="`启动中 ${data.instances.starting} · 异常 ${data.instances.error}`"
          icon="i-ph-hard-drives"
          tone="sky"
          to="/admin/instances"
        />
        <AdminStatCard
          label="待审批"
          :value="data.users.pending"
          :hint="data.users.pending > 0 ? '去处理等待中的注册' : '暂无待处理'"
          icon="i-ph-user-plus"
          tone="butter"
          :to="data.users.pending > 0 ? '/admin/users?status=pending' : undefined"
        />
        <AdminStatCard
          label="24 小时失败任务"
          :value="data.jobs.failedLast24h"
          :hint="`进行中 ${data.jobs.running} · 排队 ${data.jobs.queued}`"
          icon="i-ph-warning-circle"
          :tone="data.jobs.failedLast24h > 0 ? 'danger' : 'neutral'"
          to="/admin/jobs"
        />
      </div>

      <SoftCard title="宿主资源">
        <template #extra>
          <div class="overview__host-meta">
            <MiniTag
              :text="
                data.host.dockerOk
                  ? `Docker 正常${data.host.dockerVersion ? ` · ${data.host.dockerVersion}` : ''}`
                  : 'Docker 不可用'
              "
              :tone="data.host.dockerOk ? 'success' : 'danger'"
              :icon="data.host.dockerOk ? 'i-ph-check-circle' : 'i-ph-x-circle'"
            />
            <MiniTag
              :text="
                data.runtime.defaultVersion ? `默认 DSH ${data.runtime.defaultVersion}` : '未设置默认版本'
              "
              :tone="data.runtime.defaultVersion ? 'sky' : 'butter'"
              icon="i-ph-git-branch"
            />
          </div>
        </template>

        <div class="overview__rings">
          <RingProgress
            v-for="ring in hostRings"
            :key="ring.key"
            :value="ring.value"
            :label="ring.label"
            :hint="ring.hint"
            :tone="ring.tone"
          />
        </div>

        <div v-if="!hasRuntime" class="overview__guide">
          <span class="i-ph-rocket-launch overview__guide-icon" aria-hidden="true" />
          <div class="overview__guide-body">
            <p class="overview__guide-title">先构建一个 DSH 版本</p>
            <p class="overview__guide-desc">
              还没有可用的运行时镜像，用户实例无法启动。选一个版本点「构建」即可，构建日志会出现在任务中心。
            </p>
          </div>
          <RouterLink to="/admin/runtimes">
            <NButton type="primary" size="small">去构建</NButton>
          </RouterLink>
        </div>
      </SoftCard>

      <div class="overview__columns">
        <SoftCard title="最近注册">
          <template #extra>
            <RouterLink to="/admin/users" class="hub-link text-[13px]">全部用户</RouterLink>
          </template>

          <EmptyState
            v-if="data.recent.registrations.length === 0"
            title="还没有新用户"
            description="开放注册或发一个邀请码，用户就会出现在这里。"
            :size="96"
          />
          <ul v-else class="overview__list">
            <li v-for="user in data.recent.registrations" :key="user.id" class="overview__row">
              <UserCell :user="user" :to="`/admin/users/${user.id}`" />
              <span class="overview__row-meta">{{ fromNow(user.createdAt) }}</span>
            </li>
          </ul>
        </SoftCard>

        <SoftCard title="正在进行的任务">
          <template #extra>
            <RouterLink to="/admin/jobs" class="hub-link text-[13px]">任务中心</RouterLink>
          </template>

          <EmptyState
            v-if="runningJobs.length === 0"
            title="当前没有进行中的任务"
            description="下发插件、升级版本时会在这里实时显示进度。"
            :size="96"
          />
          <ul v-else class="overview__list">
            <li v-for="job in runningJobs" :key="job.id" class="overview__job">
              <RouterLink :to="`/admin/jobs/${job.id}`" class="overview__job-title">
                <span :class="jobTypeIcon(job.type)" aria-hidden="true" />
                {{ job.title || jobTypeText(job.type) }}
              </RouterLink>
              <MiniTag
                :text="JOB_STATUS_TEXT[job.status] ?? job.status"
                :tone="JOB_STATUS_TONE[job.status]"
                size="sm"
              />
              <JobProgress
                class="overview__job-progress"
                :total="job.total"
                :done="job.done"
                :failed="job.failed"
                size="sm"
              />
            </li>
          </ul>
        </SoftCard>
      </div>

      <SoftCard title="最近审计">
        <template #extra>
          <RouterLink to="/admin/audit" class="hub-link text-[13px]">全部记录</RouterLink>
        </template>
        <AuditTimeline :items="data.recent.audit" compact empty-text="暂无审计记录" />
      </SoftCard>

      <p class="overview__footnote">
        <span class="i-ph-clock" aria-hidden="true" />
        页面每 15 秒自动刷新 · 最近一次渲染 {{ formatDateTime(new Date().toISOString()) }}
      </p>
    </template>

    <SoftCard v-else-if="loading">
      <p class="overview__loading">正在加载概览…</p>
    </SoftCard>
  </AdminPage>
</template>

<style scoped>
.overview__stats {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.overview__host-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.overview__rings {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-8);
  justify-content: space-around;
}

.overview__guide {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding: var(--space-4);
  border: var(--border-width) dashed var(--c-primary);
  border-radius: var(--radius-card);
  background: var(--c-primary-soft);
}

.overview__guide-icon {
  color: var(--c-primary-press);
  font-size: 28px;
}

.overview__guide-body {
  min-width: 0;
  flex: 1;
}

.overview__guide-title {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.overview__guide-desc {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.overview__columns {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

.overview__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.overview__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.overview__row-meta {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.overview__job {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.overview__job-title {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview__job-progress {
  width: 120px;
  flex: none;
}

.overview__footnote {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.overview__loading {
  color: var(--c-text-2);
}
</style>
