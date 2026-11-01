<script setup lang="ts">
import type { AdminInstanceRow, AdminPluginRow, JobSummary, UserAdminView } from '@dsh-hub/shared'
import { computed } from 'vue'

import type { EntityKind } from '@/api/admin-cockpit'
import { getJob } from '@/api/admin-jobs'
import { listInstances } from '@/api/admin-instances'
import { listPlugins } from '@/api/admin-plugins'
import { getUser } from '@/api/admin-users'
import JobProgress from '@/components/admin/JobProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import UserCell from '@/components/admin/UserCell.vue'
import StatusPill from '@/components/base/StatusPill.vue'
import { JOB_STATUS_TEXT } from '@/composables/useInstanceStatus'
import { useAsyncData } from '@/composables/useAsyncData'
import { normalizeEntity } from '@/utils/cockpit'

/**
 * `entity` 卡（docs/24 §3）：Hub 用现有组件渲染实体摘要（用户 / 实例 / 插件 / 任务）。
 *
 * 数据用经典页面的接口现取（`useAsyncData`），拿不到的实体（DSH 版本 / 模型 / 设备 / 渠道）
 * 不做特判，直接给「在经典页面打开」的入口 —— 座舱是入口，不重造所有详情页。
 */
const props = defineProps<{
  entity: EntityKind
  id: string | number
}>()

type EntityData =
  | { kind: 'user'; user: UserAdminView }
  | { kind: 'instance'; row: AdminInstanceRow }
  | { kind: 'plugin'; plugin: AdminPluginRow }
  | { kind: 'job'; job: JobSummary }
  | { kind: 'link' }

async function load(): Promise<EntityData> {
  const numeric = Number(props.id)
  switch (props.entity) {
    case 'user': {
      if (!Number.isFinite(numeric)) return { kind: 'link' }
      const detail = await getUser(numeric)
      return { kind: 'user', user: detail.user }
    }
    case 'instance': {
      // 实例按「所属用户」定位（经典页面 `/admin/instances?userId=`，与 04 §4 一致）
      const rows = await listInstances()
      const found = rows.find((row) => Number(props.id) === row.user.id)
      return found ? { kind: 'instance', row: found } : { kind: 'link' }
    }
    case 'plugin': {
      const plugins = await listPlugins()
      const found = plugins.find((row) => row.id === numeric)
      return found ? { kind: 'plugin', plugin: found } : { kind: 'link' }
    }
    case 'job': {
      if (!Number.isFinite(numeric)) return { kind: 'link' }
      const detail = await getJob(numeric)
      return { kind: 'job', job: detail.job }
    }
    default:
      return { kind: 'link' }
  }
}

const { data, loading, error } = useAsyncData(load)

const classicPath = computed(() => normalizeEntity(props.entity, props.id).classicPath)
const classicLabel = computed(() => normalizeEntity(props.entity, props.id).classicLabel)

const jobStatusText = computed(() => {
  if (data.value?.kind !== 'job') return ''
  return JOB_STATUS_TEXT[data.value.job.status] ?? data.value.job.status
})
</script>

<template>
  <div class="canvas-entity">
    <p v-if="loading" class="canvas-entity__hint">正在读取…</p>

    <template v-else-if="data?.kind === 'user'">
      <UserCell :user="data.user" :to="classicPath" />
      <div class="canvas-entity__meta">
        <MiniTag
          :text="data.user.role === 'admin' ? '管理员' : data.user.roleLabel || '普通用户'"
          tone="sakura"
        />
        <StatusPill :status="data.user.instance.status" size="sm" />
        <span class="canvas-entity__muted">最近登录</span>
        <span class="canvas-entity__value">{{ data.user.lastLoginAt ? '已登录过' : '从未登录' }}</span>
      </div>
    </template>

    <template v-else-if="data?.kind === 'instance'">
      <UserCell :user="data.row.user" :to="classicPath" />
      <div class="canvas-entity__meta">
        <StatusPill :status="data.row.instance.status" size="sm" />
        <span class="canvas-entity__muted">DSH</span>
        <span class="canvas-entity__value">{{ data.row.instance.runtimeVersion ?? '未启动' }}</span>
      </div>
    </template>

    <template v-else-if="data?.kind === 'plugin'">
      <p class="canvas-entity__title">{{ data.plugin.displayName }}</p>
      <p class="canvas-entity__sub">{{ data.plugin.packageName }}</p>
      <div class="canvas-entity__meta">
        <MiniTag :text="data.plugin.latestVersion ?? '无版本'" tone="sky" />
        <span class="canvas-entity__muted">装机</span>
        <span class="canvas-entity__value">{{ data.plugin.stats.installed }} 人</span>
        <span class="canvas-entity__muted">待装</span>
        <span class="canvas-entity__value">{{ data.plugin.stats.pending }}</span>
      </div>
    </template>

    <template v-else-if="data?.kind === 'job'">
      <p class="canvas-entity__title">{{ data.job.title }}</p>
      <div class="canvas-entity__meta">
        <MiniTag :text="jobStatusText" tone="sky" />
      </div>
      <JobProgress :total="data.job.total" :done="data.job.done" :failed="data.job.failed" size="sm" />
    </template>

    <p v-else-if="error" class="canvas-entity__hint canvas-entity__hint--error">{{ error.message }}</p>

    <RouterLink :to="classicPath" class="hub-link canvas-entity__link">
      在经典页面打开{{ classicLabel ? `（${classicLabel}）` : '' }}
      <span class="i-ph-arrow-square-out" aria-hidden="true" />
    </RouterLink>
  </div>
</template>

<style scoped>
.canvas-entity {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.canvas-entity__title {
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.canvas-entity__sub {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.canvas-entity__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-12);
}

.canvas-entity__muted {
  color: var(--c-text-3);
}

.canvas-entity__value {
  color: var(--c-text-2);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.canvas-entity__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-12);
}

.canvas-entity__hint {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.canvas-entity__hint--error {
  color: var(--c-danger-ink);
}
</style>
