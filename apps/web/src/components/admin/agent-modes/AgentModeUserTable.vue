<script setup lang="ts">
import type { AgentModeUser } from '@dsh-hub/shared'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import MiniTag from '@/components/admin/MiniTag.vue'
import type { AdminTone } from '@/components/admin/tone'
import { instanceStatusMeta } from '@/composables/useInstanceStatus'
import { formatPoints } from '@/utils/points'

/**
 * 「下发」页的用户表（18 §4.3 §6）：用户、插件版本、实例状态、env 是否生效、本月该模式花费。
 * `targeted=false` 的行是「已移出」——运行中的容器里还有这个模式的变量，下发一次才会去掉。
 */
const props = withDefaults(defineProps<{ users: AgentModeUser[]; loading?: boolean }>(), { loading: false })

const TONE_MAP: Record<string, AdminTone> = {
  running: 'success',
  progress: 'sky',
  idle: 'neutral',
  error: 'danger',
}

const ENV_META = {
  applied: { text: '已生效', tone: 'success' as AdminTone },
  pending: { text: '待下发', tone: 'butter' as AdminTone },
  later: { text: '下次启动生效', tone: 'neutral' as AdminTone },
}

function envMeta(value: boolean | null): { text: string; tone: AdminTone } {
  if (value === true) return ENV_META.applied
  if (value === false) return ENV_META.pending
  return ENV_META.later
}

const columns = computed<DataTableColumns<AgentModeUser>>(() => [
  {
    title: '用户',
    key: 'username',
    minWidth: 170,
    render: (row) =>
      h('div', { class: 'agent-users__cell' }, [
        h('span', { class: 'agent-users__name', title: row.username }, row.username),
        h(
          'span',
          { class: 'agent-users__sub' },
          [row.displayName, row.targeted ? null : '已移出'].filter(Boolean).join(' · ') || '—',
        ),
      ]),
  },
  {
    title: '插件版本',
    key: 'pluginVersion',
    width: 110,
    render: (row) =>
      row.pluginVersion
        ? h('span', { class: 'agent-users__mono' }, row.pluginVersion)
        : h('span', { class: 'agent-users__muted' }, '未装'),
  },
  {
    title: '实例',
    key: 'instanceStatus',
    width: 96,
    render: (row) => {
      const meta = instanceStatusMeta(row.instanceStatus)
      return h(MiniTag, { text: meta.text, tone: TONE_MAP[meta.tone] ?? 'neutral', size: 'sm' })
    },
  },
  {
    title: 'env',
    key: 'envApplied',
    width: 124,
    render: (row) => {
      const meta = envMeta(row.envApplied)
      return h(MiniTag, { text: meta.text, tone: meta.tone, size: 'sm' })
    },
  },
  {
    title: '本月花费',
    key: 'monthCostMicro',
    width: 120,
    align: 'right',
    render: (row) =>
      h('span', { class: 'agent-users__cost', title: `${formatPoints(row.monthCostMicro)} 积分` }, [
        h('span', null, formatPoints(row.monthCostMicro)),
        h('span', { class: 'agent-users__unit' }, '积分'),
      ]),
  },
])
</script>

<template>
  <div class="agent-users">
    <NDataTable
      :columns="columns"
      :data="props.users"
      :loading="loading"
      :row-key="(row: AgentModeUser) => row.userId"
      :row-class-name="(row: AgentModeUser) => (row.targeted ? '' : 'agent-users__row--removed')"
      :scroll-x="640"
      :pagination="false"
      size="small"
      data-testid="agent-mode-users"
    >
      <template #empty>
        <span class="agent-users__empty">还没有开放给任何用户</span>
      </template>
    </NDataTable>
  </div>
</template>

<style scoped>
.agent-users {
  overflow: hidden;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
}

:deep(.agent-users__cell) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.agent-users__name) {
  /* 07 §2.8：用户名是标识符，单行省略 */
  overflow: hidden;
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.agent-users__sub) {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.agent-users__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.agent-users__muted) {
  color: var(--c-text-3);
  white-space: nowrap;
}

:deep(.agent-users__cost) {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.agent-users__unit) {
  color: var(--c-text-3);
  font-family: var(--font-sans);
  font-size: var(--fs-12);
}

:deep(.agent-users__row--removed) {
  background: var(--c-bg);
}

:deep(.agent-users__empty) {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

:deep(.agent-users__row--removed .agent-users__name) {
  color: var(--c-text-3);
}
</style>
