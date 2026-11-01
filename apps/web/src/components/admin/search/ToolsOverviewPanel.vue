<script setup lang="ts">
import type { ToolOverviewResponse } from '@dsh-hub/shared'
import { NButton, NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import { getToolOverview } from '@/api/tools'
import MiniTag from '@/components/admin/MiniTag.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatCount } from '@/composables/useFormat'
import { formatPoints } from '@/utils/points'
import { TOOL_KIND_TEXT, toolChannelKindText } from '@/utils/tool-keys'

/**
 * 中转站 · 搜索池 · 概览（14 §3.2 §7）：本月调用、免费调用、收入、上游成本、毛利，
 * 以及「按渠道」「按工具」两张小表。金额一律微积分，展示走 `formatPoints`。
 */
const { data, loading, reload } = useAsyncData(() => getToolOverview())

const overview = computed<ToolOverviewResponse | null>(() => data.value ?? null)

/** 毛利 = 向用户收的 − 我方上游成本（成本只估算，可为负） */
const grossProfitMicro = computed(() => {
  const totals = overview.value?.totals
  if (!totals) return 0
  return totals.revenueMicro - totals.upstreamCostMicro
})

const channelColumns = computed<DataTableColumns<ToolOverviewResponse['byChannel'][number]>>(() => [
  {
    title: '渠道',
    key: 'name',
    minWidth: 120,
    render: (row) =>
      h('div', { class: 'tools-overview__cell' }, [
        h('span', { class: 'tools-overview__name', title: row.name }, row.name),
        h(MiniTag, {
          text: toolChannelKindText(row.kind),
          tone: row.kind === 'tavily' ? 'sky' : 'primary',
          size: 'sm',
        }),
      ]),
  },
  { title: '调用', key: 'calls', width: 90, align: 'right', render: (row) => formatCount(row.calls) },
  { title: '失败', key: 'failures', width: 90, align: 'right', render: (row) => formatCount(row.failures) },
  {
    title: '上游成本（积分）',
    key: 'upstreamCostMicro',
    width: 150,
    align: 'right',
    render: (row) => h('span', { class: 'tools-overview__mono' }, formatPoints(row.upstreamCostMicro)),
  },
])

const toolColumns = computed<DataTableColumns<ToolOverviewResponse['byTool'][number]>>(() => [
  { title: '工具', key: 'tool', width: 120, render: (row) => TOOL_KIND_TEXT[row.tool] },
  { title: '调用', key: 'calls', width: 120, align: 'right', render: (row) => formatCount(row.calls) },
  {
    title: '收入（积分）',
    key: 'revenueMicro',
    width: 150,
    align: 'right',
    render: (row) => h('span', { class: 'tools-overview__mono' }, formatPoints(row.revenueMicro)),
  },
])
</script>

<template>
  <div class="tools-overview">
    <div class="tools-overview__head">
      <p class="tools-overview__month">本月（{{ overview?.month ?? '—' }}）</p>
      <NButton size="tiny" quaternary :loading="loading" @click="reload">刷新</NButton>
    </div>

    <div class="tools-overview__cards">
      <div class="tools-overview__card">
        <p class="tools-overview__label">本月调用</p>
        <p class="tools-overview__value">{{ formatCount(overview?.totals.calls ?? 0) }}</p>
      </div>
      <div class="tools-overview__card">
        <p class="tools-overview__label">其中免费调用</p>
        <p class="tools-overview__value">{{ formatCount(overview?.totals.freeCalls ?? 0) }}</p>
      </div>
      <div class="tools-overview__card">
        <p class="tools-overview__label">收入（积分）</p>
        <p class="tools-overview__value">{{ formatPoints(overview?.totals.revenueMicro ?? 0) }}</p>
      </div>
      <div class="tools-overview__card">
        <p class="tools-overview__label">上游成本（积分）</p>
        <p class="tools-overview__value">{{ formatPoints(overview?.totals.upstreamCostMicro ?? 0) }}</p>
      </div>
      <div class="tools-overview__card">
        <p class="tools-overview__label">毛利（积分）</p>
        <p
          class="tools-overview__value"
          :class="{ 'tools-overview__value--negative': grossProfitMicro < 0 }"
        >
          {{ formatPoints(grossProfitMicro) }}
        </p>
      </div>
    </div>

    <div class="tools-overview__tables">
      <SoftCard title="按渠道">
        <NDataTable
          :columns="channelColumns"
          :data="overview?.byChannel ?? []"
          :loading="loading"
          :row-key="(row: ToolOverviewResponse['byChannel'][number]) => row.channelId"
          :scroll-x="470"
          :pagination="false"
          size="small"
        />
      </SoftCard>

      <SoftCard title="按工具">
        <NDataTable
          :columns="toolColumns"
          :data="overview?.byTool ?? []"
          :loading="loading"
          :row-key="(row: ToolOverviewResponse['byTool'][number]) => row.tool"
          :scroll-x="420"
          :pagination="false"
          size="small"
        />
      </SoftCard>
    </div>
  </div>
</template>

<style scoped>
.tools-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tools-overview__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tools-overview__month {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.tools-overview__cards {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.tools-overview__card {
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
}

.tools-overview__label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.tools-overview__value {
  color: var(--c-text);
  font-size: var(--fs-20);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-semibold);
}

.tools-overview__value--negative {
  color: var(--c-danger-ink);
}

.tools-overview__tables {
  display: grid;
  gap: var(--space-4);
  /* 「按渠道」列更多（渠道 + 调用 + 失败 + 上游成本），给它更多宽度；窄屏改成单列 */
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
}

@media (max-width: 1100px) {
  .tools-overview__tables {
    grid-template-columns: minmax(0, 1fr);
  }
}

:deep(.tools-overview__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.tools-overview__cell) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

:deep(.tools-overview__name) {
  overflow: hidden;
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
