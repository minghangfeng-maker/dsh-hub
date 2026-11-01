<script setup lang="ts">
import type { ComputeLeaseRow, RelayUsageRow, ToolUsageRow } from '@dsh-hub/shared'
import { NButton, NDatePicker, NSelect, NTab, NTabs } from 'naive-ui'
import { computed } from 'vue'

import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import UsageLogTable from '@/components/relay/UsageLogTable.vue'
import ComputeLeaseTable from '@/components/user/compute/ComputeLeaseTable.vue'
import ToolsUsageTable from '@/components/user/tools/ToolsUsageTable.vue'
import { dayToTs, isDayDisabled, tsToDay } from '@/utils/relay-day'

/**
 * 「使用记录」整块（19 §2.5）：三个标签「模型调用 / 搜索与抓取 / 算力租赁」，
 * 后两个只在有内容时出现；只有一个标签时不显示标签头。取数与分页由页面负责（这里只渲染与转发事件）。
 */
export type UsageLogTab = 'calls' | 'tools' | 'compute'

export interface PagedCalls {
  rows: RelayUsageRow[]
  total: number
  loading: boolean
  page: number
  pageSize: number
}

export interface PagedTools {
  rows: ToolUsageRow[]
  total: number
  loading: boolean
  page: number
  pageSize: number
}

export interface PagedCompute {
  rows: ComputeLeaseRow[]
  total: number
  loading: boolean
  page: number
  pageSize: number
}

export interface LogFilters {
  from: string
  to: string
  scope: string
  model: string
  status: string
}

const props = defineProps<{
  tab: UsageLogTab
  showSource: boolean
  calls: PagedCalls
  tools: PagedTools | null
  compute: PagedCompute | null
  filters: LogFilters
  modelOptions: { label: string; value: string }[]
  /** 「模型调用」日期区间最长天数（与后端一致：92 × 4） */
  maxRangeDays: number
}>()

const emit = defineEmits<{
  'tab-change': [tab: UsageLogTab]
  'filters-change': [filters: LogFilters]
  'calls-page': [page: number]
  'calls-page-size': [size: number]
  'tools-page': [page: number]
  'tools-page-size': [size: number]
  'compute-page': [page: number]
  'compute-page-size': [size: number]
}>()

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '成功', value: 'ok' },
  { label: '中断', value: 'aborted' },
  { label: '上游错误', value: 'upstream_error' },
  { label: '请求错误', value: 'client_error' },
]

const SOURCE_OPTIONS = [
  { label: '全部来源', value: '' },
  { label: 'DSH', value: 'dsh' },
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Codex', value: 'codex' },
]

const tabs = computed(() => {
  const list: { key: UsageLogTab; label: string }[] = [{ key: 'calls', label: '模型调用' }]
  if (props.tools) list.push({ key: 'tools', label: '搜索与抓取' })
  if (props.compute) list.push({ key: 'compute', label: '算力租赁' })
  return list
})

const currentTab = computed<UsageLogTab>(() =>
  tabs.value.some((item) => item.key === props.tab) ? props.tab : 'calls',
)

const dateRange = computed<[number, number] | null>(() =>
  props.filters.from && props.filters.to ? [dayToTs(props.filters.from), dayToTs(props.filters.to)] : null,
)

function patch(patchValue: Partial<LogFilters>): void {
  emit('filters-change', { ...props.filters, ...patchValue })
}

function onDateRange(value: [number, number] | null): void {
  // daterange 选第一端时第二端可能还是 null：保留另一端为空，别当成 1970-01-01
  patch({
    from: typeof value?.[0] === 'number' ? tsToDay(value[0]) : '',
    to: typeof value?.[1] === 'number' ? tsToDay(value[1]) : '',
  })
}

function isDateDisabled(timestamp: number): boolean {
  const range = dateRange.value
  if (!range) return false
  const other = timestamp <= range[0] ? range[1] : range[0]
  return isDayDisabled(tsToDay(timestamp), tsToDay(other), props.maxRangeDays)
}

function reset(): void {
  emit('filters-change', { from: '', to: '', scope: '', model: '', status: '' })
}
</script>

<template>
  <SoftCard title="使用记录" data-testid="usage-records">
    <template #title-extra>
      <InfoTip label="使用记录说明" text="只记录模型、token、耗时和费用，不保存对话内容。" />
    </template>

    <template v-if="tabs.length > 1">
      <NTabs
        :value="currentTab"
        type="line"
        size="small"
        class="records__tabs"
        @update:value="(value: string) => emit('tab-change', value as UsageLogTab)"
      >
        <NTab v-for="item in tabs" :key="item.key" :name="item.key" :tab="item.label" />
      </NTabs>
    </template>

    <!-- 模型调用：日期区间 / 来源 / 模型 / 状态 / 重置 -->
    <div v-if="currentTab === 'calls'" class="records__filters" data-testid="usage-log-filters">
      <NDatePicker
        :value="dateRange"
        type="daterange"
        size="small"
        clearable
        class="records__dates"
        :is-date-disabled="isDateDisabled"
        data-testid="usage-log-dates"
        @update:value="onDateRange"
      />
      <NSelect
        v-if="showSource"
        :value="filters.scope"
        size="small"
        class="records__select"
        :options="SOURCE_OPTIONS"
        data-testid="usage-log-source"
        @update:value="(value: string) => patch({ scope: value })"
      />
      <NSelect
        :value="filters.model || null"
        size="small"
        filterable
        clearable
        class="records__model"
        :options="modelOptions"
        placeholder="全部模型"
        data-testid="usage-log-model"
        @update:value="(value: string | null) => patch({ model: value ?? '' })"
      />
      <NSelect
        :value="filters.status"
        size="small"
        class="records__select"
        :options="STATUS_OPTIONS"
        data-testid="usage-log-status"
        @update:value="(value: string) => patch({ status: value })"
      />
      <NButton size="small" quaternary data-testid="usage-log-reset" @click="reset">重置</NButton>
    </div>

    <UsageLogTable
      v-if="currentTab === 'calls'"
      :show-source="showSource"
      :rows="calls.rows"
      :total="calls.total"
      :page="calls.page"
      :page-size="calls.pageSize"
      :loading="calls.loading"
      @page-change="(page: number) => emit('calls-page', page)"
      @page-size-change="(size: number) => emit('calls-page-size', size)"
    />

    <ToolsUsageTable
      v-else-if="currentTab === 'tools' && tools"
      :rows="tools.rows"
      :total="tools.total"
      :page="tools.page"
      :page-size="tools.pageSize"
      :loading="tools.loading"
      @page-change="(page: number) => emit('tools-page', page)"
      @page-size-change="(size: number) => emit('tools-page-size', size)"
    />

    <ComputeLeaseTable
      v-else-if="currentTab === 'compute' && compute"
      :rows="compute.rows"
      :total="compute.total"
      :page="compute.page"
      :page-size="compute.pageSize"
      :loading="compute.loading"
      @page-change="(page: number) => emit('compute-page', page)"
      @page-size-change="(size: number) => emit('compute-page-size', size)"
    />
  </SoftCard>
</template>

<style scoped>
.records__tabs {
  margin-bottom: var(--space-2);
}

.records__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

/* 控件里的文字不断行（07 §2.8） */
.records__filters :deep(.n-base-selection-label),
.records__filters :deep(.n-button) {
  white-space: nowrap;
}

.records__dates {
  width: 250px;
}

.records__select {
  width: 130px;
}

.records__model {
  width: 220px;
}
</style>
