<script setup lang="ts">
import { computed } from 'vue'

import type { CanvasItem, CapabilityDescriptor, ProposalView, SecretRequestView } from '@/api/admin-cockpit'
import ProposalCard from '@/components/admin/cockpit/ProposalCard.vue'
import SecretRequestCard from '@/components/admin/cockpit/SecretRequestCard.vue'
import CanvasChart from '@/components/admin/cockpit/renderers/CanvasChart.vue'
import CanvasEntity from '@/components/admin/cockpit/renderers/CanvasEntity.vue'
import CanvasJob from '@/components/admin/cockpit/renderers/CanvasJob.vue'
import CanvasLogs from '@/components/admin/cockpit/renderers/CanvasLogs.vue'
import CanvasMarkdown from '@/components/admin/cockpit/renderers/CanvasMarkdown.vue'
import CanvasStats from '@/components/admin/cockpit/renderers/CanvasStats.vue'
import CanvasTable from '@/components/admin/cockpit/renderers/CanvasTable.vue'
import { useCanvasData } from '@/components/admin/cockpit/use-canvas-data'
import {
  buildCanvasChartData,
  buildCanvasDonutData,
  buildCanvasStatsItems,
  canvasDataOf,
  canvasTableEmptyText,
  prefillForRow,
} from '@/utils/cockpit'

/**
 * 画布卡的「内容」分发器（docs/24 §3 的九种 `CanvasSpec`）。
 *
 * 卡片外壳（标题、角标、钉住 / 关闭 / 问 DSH）在 `CanvasCard` 里；
 * 这里只负责「这一张卡画什么」，并把 source 数据的取数交给 `useCanvasData`。
 *
 * WP56h：`stats` 也能挂 `data.source`（Hub 重查的每一行 = 一项指标），
 * `chart` 多了 `donut`（一行一个扇区），表格的空态可以说人话（「一切正常」）。
 */
const props = defineProps<{
  item: CanvasItem
  proposal?: ProposalView | null
  secretRequest?: SecretRequestView | null
  catalog: CapabilityDescriptor[]
}>()

const emit = defineEmits<{
  ask: [text: string]
  'proposal-updated': [proposal: ProposalView]
  'secret-updated': [request: SecretRequestView]
}>()

const spec = computed(() => props.item.spec)
const data = computed(() => canvasDataOf(props.item.spec))

const { rows, loading, error } = useCanvasData(() => data.value)

const chart = computed(() =>
  spec.value.kind === 'chart' && spec.value.chart !== 'donut'
    ? buildCanvasChartData(spec.value, rows.value)
    : null,
)

const donut = computed(() =>
  spec.value.kind === 'chart' && spec.value.chart === 'donut'
    ? buildCanvasDonutData(spec.value, rows.value)
    : null,
)

/** `stats` 卡：给了 `data.source` 就用重查回来的行，否则用 DSH 内联的 `items` */
const statsItems = computed(() => {
  if (spec.value.kind !== 'stats') return []
  const inline = spec.value.items
  if (!spec.value.data) return inline
  const fromRows = buildCanvasStatsItems(rows.value)
  // 第一次取数还没回来时先显示内联的占位（没有占位就让指标卡显示「正在读取…」）
  return fromRows.length === 0 && loading.value ? inline : fromRows
})

/** 表格空态的那一句话（docs/24 §1）：规则在 utils 里（可单测），这里只做分派 */
const tableEmptyText = computed(() => canvasTableEmptyText(spec.value))

function askRow(row: Record<string, unknown>): void {
  emit('ask', prefillForRow(props.item, row))
}
</script>

<template>
  <CanvasStats
    v-if="spec.kind === 'stats'"
    :items="statsItems"
    :loading="loading"
    :error="error?.message ?? null"
  />

  <CanvasTable
    v-else-if="spec.kind === 'table'"
    :columns="spec.columns"
    :rows="rows"
    :loading="loading"
    :error="error?.message ?? null"
    :empty-text="tableEmptyText"
    @ask="askRow"
  />

  <CanvasChart
    v-else-if="spec.kind === 'chart' && chart"
    :chart="spec.chart"
    :labels="chart.labels"
    :series="chart.series"
    :unit="spec.unit"
    :loading="loading"
    :error="error?.message ?? null"
  />

  <CanvasChart
    v-else-if="spec.kind === 'chart' && donut"
    :chart="spec.chart"
    :labels="[]"
    :series="[]"
    :slices="donut.slices"
    :donut-label="donut.seriesLabel"
    :unit="spec.unit"
    :loading="loading"
    :error="error?.message ?? null"
  />

  <CanvasEntity v-else-if="spec.kind === 'entity'" :id="spec.id" :entity="spec.entity" />

  <CanvasJob v-else-if="spec.kind === 'job'" :job-id="spec.jobId" />

  <CanvasLogs
    v-else-if="spec.kind === 'logs'"
    :rows="rows"
    :loading="loading"
    :error="error?.message ?? null"
  />

  <CanvasMarkdown v-else-if="spec.kind === 'markdown'" :text="spec.text" />

  <ProposalCard
    v-else-if="spec.kind === 'proposal'"
    :proposal="proposal ?? null"
    :catalog="catalog"
    @updated="(next) => emit('proposal-updated', next)"
  />

  <SecretRequestCard
    v-else-if="spec.kind === 'secret-request'"
    :request-id="spec.requestId"
    :request="secretRequest ?? null"
    @updated="(next) => emit('secret-updated', next)"
  />
</template>
