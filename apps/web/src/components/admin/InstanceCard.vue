<script setup lang="ts">
import type { AdminInstanceRow, InstanceAction } from '@dsh-hub/shared'
import { NButton, NSkeleton } from 'naive-ui'
import { computed } from 'vue'

import InfoTip from '@/components/base/InfoTip.vue'
import MiniBars from '@/components/admin/MiniBars.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import UserCell from '@/components/admin/UserCell.vue'
import { leaseTagOf } from '@/components/admin/compute/lease-tag'
import { probeTextOf } from '@/components/admin/instance-probe'
import StatusPill from '@/components/base/StatusPill.vue'
import { formatDuration, formatDateTime } from '@/composables/useFormat'

/**
 * 实例卡片（07 §7.4 卡片视图）：用户、状态、运行时长、迷你资源条、操作。
 * 资源数据由父页 10 秒轮询刷新（`stats` 可能为 null）。
 */
const props = withDefaults(
  defineProps<{
    row: AdminInstanceRow
    /**
     * 这张卡片正在进行中的操作（null = 空闲）。
     * 只有被点的那颗按钮转圈、同一实例的其他按钮 disabled；别的实例不受影响（WP15 ③）。
     */
    busyAction?: InstanceAction | null
    /** 当前时间戳（父页轮询时更新，用于「已运行」文案） */
    now?: number
  }>(),
  { busyAction: null, now: () => Date.now() },
)

const emit = defineEmits<{ action: [action: InstanceAction] }>()

const uptime = computed(() => {
  const started = props.row.instance.startedAt
  if (!started) return null
  const elapsed = props.now - new Date(started).getTime()
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null
  return formatDuration(elapsed, 'ms')
})

const actions: { key: InstanceAction; label: string; type: 'primary' | 'default' | 'error' }[] = [
  { key: 'start', label: '启动', type: 'primary' },
  { key: 'stop', label: '停止', type: 'default' },
  { key: 'restart', label: '重启', type: 'default' },
  { key: 'recreate', label: '重建', type: 'default' },
]

/** 算力租约标签（13 §7）：计费中 / 宽限中 / 免费；没有租约时不显示 */
const leaseTag = computed(() => leaseTagOf(props.row.lease))

/** 会话判定（WP33，docs/22 §6.3）：卡片是「详情」，主文案之外还给出判定依据 */
const probe = computed(() => probeTextOf(props.row.probe, props.now))
/** 资源样本的采集时刻（采样器每 15 s 一轮，可能比列表旧） */
const statsAt = computed(() => {
  if (!props.row.statsAt) return null
  const ms = Date.parse(props.row.statsAt)
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : null
})
</script>

<template>
  <article class="instance-card">
    <header class="instance-card__head">
      <UserCell :user="row.user" :to="`/admin/users/${row.user.id}`" />
      <StatusPill :status="row.instance.status" size="sm" />
    </header>

    <dl class="instance-card__meta">
      <div>
        <dt>DSH 版本</dt>
        <dd>{{ row.instance.runtimeVersion ?? '默认版本' }}</dd>
      </div>
      <div>
        <dt>已运行</dt>
        <dd>{{ uptime ?? '—' }}</dd>
      </div>
      <div>
        <dt>最近活跃</dt>
        <dd>{{ formatDateTime(row.instance.lastActiveAt) }}</dd>
      </div>
    </dl>

    <div v-if="row.instance.status === 'running'" class="instance-card__probe" data-testid="instance-probe">
      <MiniTag :text="probe.label" :tone="probe.tone" size="lg" />
      <!-- 判定依据（探针时刻 / 最近提问 / 连接数）放悬停说明，不常驻小字（WP14 口径） -->
      <InfoTip :text="probe.hint" label="会话判定依据" :width="220" />
    </div>

    <div v-if="row.lease && leaseTag" class="instance-card__lease" data-testid="instance-lease">
      <span class="instance-card__lease-plan">{{ row.lease.planName }}</span>
      <MiniTag :text="leaseTag.text" :tone="leaseTag.tone" size="sm" />
    </div>

    <p v-if="row.instance.error" class="instance-card__error">{{ row.instance.error }}</p>
    <p v-else-if="row.instance.needsRecreate" class="instance-card__warn">配置已更新，重建后生效</p>

    <div v-if="row.stats" class="instance-card__stats">
      <MiniBars :stats="row.stats" />
      <span v-if="statsAt" class="instance-card__stats-at">采样 {{ statsAt }}</span>
    </div>
    <div v-else-if="row.instance.status === 'running'" class="instance-card__stats" aria-label="资源采集中">
      <NSkeleton text :repeat="2" />
    </div>
    <MiniBars v-else :stats="row.stats" />

    <footer class="instance-card__actions">
      <NButton
        v-for="action in actions"
        :key="action.key"
        size="tiny"
        :type="action.type"
        :ghost="action.type === 'default'"
        :loading="busyAction === action.key"
        :disabled="busyAction !== null && busyAction !== action.key"
        @click="emit('action', action.key)"
      >
        {{ action.label }}
      </NButton>
      <NButton size="tiny" quaternary tag="a" :href="row.instance.openUrl" target="_blank" rel="noopener">
        打开
      </NButton>
    </footer>
  </article>
</template>

<style scoped>
.instance-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
  transition:
    transform var(--duration-base) var(--ease-out-soft),
    box-shadow var(--duration-base) var(--ease-out-soft);
}

.instance-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-hover);
}

.instance-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.instance-card__head > :last-child {
  margin-left: auto;
}

.instance-card__meta {
  display: grid;
  gap: var(--space-2);
  font-size: var(--fs-12);
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.instance-card__meta dt {
  color: var(--c-text-3);
}

.instance-card__meta dd {
  overflow: hidden;
  color: var(--c-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 会话那一行是数据（状态 + 判定依据的入口），用正文字号；12px 会被 audit-ui 记成
   「常驻小字」（07 §2.7，WP32d：卡片里出现「空闲 10 分钟（20 分钟后休眠）」时被误报） */
.instance-card__probe {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--fs-14);
}

.instance-card__stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.instance-card__stats-at {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.instance-card__lease {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-12);
}

.instance-card__lease-plan {
  overflow: hidden;
  color: var(--c-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-card__error {
  border-radius: var(--radius-control);
  padding: var(--space-1) var(--space-2);
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.instance-card__warn {
  border-radius: var(--radius-control);
  padding: var(--space-1) var(--space-2);
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}

.instance-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
</style>
