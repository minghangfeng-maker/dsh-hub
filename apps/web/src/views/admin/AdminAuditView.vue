<script setup lang="ts">
import type { AuditItem } from '@dsh-hub/shared'
import { NButton, NDatePicker, NInput, NSelect } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { listAudit, listUsers } from '@/api/admin-users'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import AuditTimeline from '@/components/admin/AuditTimeline.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { AUDIT_ACTION_OPTIONS } from '@/composables/audit-actions'
import { useAsyncData } from '@/composables/useAsyncData'
import { useTableQuery } from '@/composables/table-query'

/**
 * 审计（07 §7.10）：筛选（用户 / 动作 / 时间范围）+ 时间线式列表 + JSON 折叠。
 * 筛选条件与 URL 同步（可以直接把某次排查的链接发给同事）。
 */
const DEFAULTS = {
  actorId: '',
  action: '',
  targetType: '',
  targetId: '',
  from: '',
  to: '',
  page: 1,
  pageSize: 20,
}
type AuditQuery = typeof DEFAULTS

const { state, update, reset } = useTableQuery<AuditQuery>(DEFAULTS)

/** 日期范围在本地是 [start, end] 两个时间戳，写回 URL 时折成两个字符串 */
const range = ref<[number, number] | null>(null)
watch(
  () => [state.value.from, state.value.to],
  ([from, to]) => {
    if (!from && !to) {
      range.value = null
      return
    }
    range.value = [
      from ? new Date(from).getTime() : Date.now() - 86_400_000,
      to ? new Date(to).getTime() : Date.now(),
    ]
  },
  { immediate: true },
)

function onRangeChange(value: [number, number] | null): void {
  if (!value) {
    update({ from: '', to: '' })
    return
  }
  update({ from: new Date(value[0]).toISOString(), to: new Date(value[1]).toISOString() })
}

const { data, loading, error, reload } = useAsyncData(() =>
  listAudit({
    actorId: state.value.actorId ? Number(state.value.actorId) : undefined,
    action: state.value.action || undefined,
    targetType: state.value.targetType || undefined,
    targetId: state.value.targetId || undefined,
    from: state.value.from || undefined,
    to: state.value.to || undefined,
    page: state.value.page,
    pageSize: state.value.pageSize,
  }),
)
watch(
  () => ({ ...state.value }),
  () => void reload(),
)

const { data: userPage } = useAsyncData(() => listUsers({ pageSize: 100 }))

const items = computed<AuditItem[]>(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / state.value.pageSize)))

const userOptions = computed(() => [
  { label: '全部用户', value: '' },
  ...(userPage.value?.items ?? []).map((user) => ({
    label: `${user.username}（${user.displayName}）`,
    value: String(user.id),
  })),
])

const targetTypeOptions = [
  { label: '全部对象', value: '' },
  { label: '用户 user', value: 'user' },
  { label: '实例 instance', value: 'instance' },
  { label: '插件 plugin', value: 'plugin' },
  { label: '版本 runtime', value: 'runtime' },
  { label: '预设 preset', value: 'preset' },
  { label: '提供方 provider', value: 'provider' },
  { label: '邀请码 invite', value: 'invite' },
  { label: '任务 job', value: 'job' },
]

function goto(page: number): void {
  update({ page: Math.min(Math.max(1, page), pageCount.value) }, { resetPage: false })
}
</script>

<template>
  <AdminPage title="审计日志" wide>
    <template #actions>
      <NButton size="small" :loading="loading" @click="reload">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </template>

    <AdminErrorNotice :error="error" title="审计日志加载失败" @retry="reload" />

    <SoftCard compact>
      <div class="audit__toolbar">
        <NSelect
          v-model:value="state.actorId"
          class="audit__select"
          size="small"
          filterable
          :options="userOptions"
          placeholder="按用户筛选"
        />
        <NSelect
          v-model:value="state.action"
          class="audit__select audit__select--wide"
          size="small"
          filterable
          clearable
          :options="AUDIT_ACTION_OPTIONS"
          placeholder="按动作筛选"
        />
        <NSelect
          v-model:value="state.targetType"
          class="audit__select"
          size="small"
          :options="targetTypeOptions"
          placeholder="对象类型"
        />
        <NInput
          v-model:value="state.targetId"
          class="audit__input"
          size="small"
          placeholder="对象 ID"
          clearable
        />
        <NDatePicker
          :value="range"
          type="datetimerange"
          size="small"
          clearable
          class="audit__range"
          @update:value="onRangeChange"
        />
        <NButton size="small" quaternary @click="reset">清空筛选</NButton>
        <span class="audit__count">共 {{ total }} 条</span>
      </div>
    </SoftCard>

    <SoftCard>
      <EmptyState
        v-if="items.length === 0 && !loading"
        title="没有符合条件的记录"
        description="换一个用户、动作或时间范围试试。"
        :size="96"
      />
      <AuditTimeline v-else :items="items" />
    </SoftCard>

    <div v-if="total > state.pageSize" class="audit__pager">
      <NButton size="small" :disabled="state.page <= 1" @click="goto(state.page - 1)">上一页</NButton>
      <MiniTag :text="`第 ${state.page} / ${pageCount} 页`" tone="neutral" size="sm" />
      <NButton size="small" :disabled="state.page >= pageCount" @click="goto(state.page + 1)">下一页</NButton>
    </div>
  </AdminPage>
</template>

<style scoped>
.audit__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.audit__select {
  width: 168px;
}

.audit__select--wide {
  width: 240px;
}

.audit__input {
  width: 120px;
}

.audit__range {
  width: 340px;
}

.audit__count {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.audit__pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}
</style>
