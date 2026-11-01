<script setup lang="ts">
import type { RelayUsageRow } from '@dsh-hub/shared'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import MiniTag from '@/components/admin/MiniTag.vue'
import UsageStatusTag from '@/components/relay/UsageStatusTag.vue'
import { formatCount, formatDateTime } from '@/composables/useFormat'
import { formatPoints, formatTokensZh } from '@/utils/points'
import { formatRate } from '@/utils/rate'
import { relayScopeLabel } from '@/utils/relay-scope'

/**
 * 逐条用量表（12 §10）：用户端与「用量记录」Tab 共用，差别只有几列
 * （用户端看密钥名，管理端看用户，渠道列两边都有）。remote 分页由调用方负责取数。
 */
const props = withDefaults(
  defineProps<{
    rows: RelayUsageRow[]
    total: number
    page: number
    pageSize: number
    loading?: boolean
    /** user = 用户端（不显示用户，显示密钥名）；admin = 管理端 */
    scope?: 'user' | 'admin'
    /** 18 D7：多一列「来源」（DSH / Claude Code / Codex）；老数据缺 scope 视为 DSH */
    showSource?: boolean
  }>(),
  { loading: false, scope: 'user', showSource: false },
)

const emit = defineEmits<{
  'page-change': [page: number]
  'page-size-change': [pageSize: number]
}>()

function seconds(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return `${(value / 1000).toFixed(1)}s`
}

/** token 三列挤在一起会看不清，用「输入 / 缓存 / 输出」一行 + 悬停精确值 */
function tokenCell(row: RelayUsageRow) {
  return h('span', { class: 'usage-log__tokens', title: tokenTitle(row) }, [
    h('span', null, formatTokensZh(row.inputTokens)),
    h('span', { class: 'usage-log__sep' }, '/'),
    h('span', null, formatTokensZh(row.cacheReadTokens)),
    h('span', { class: 'usage-log__sep' }, '/'),
    h('span', null, formatTokensZh(row.outputTokens)),
  ])
}

function tokenTitle(row: RelayUsageRow): string {
  return `输入 ${formatCount(row.inputTokens)} · 缓存读 ${formatCount(row.cacheReadTokens)} · 缓存写 ${formatCount(
    row.cacheWriteTokens,
  )} · 输出 ${formatCount(row.outputTokens)}（其中思考 ${formatCount(row.reasoningTokens)}）`
}

/** 模型名下面的副行：接口 + 流式 + 实际打到哪个上游模型（长内容靠 title 看全） */
function modelSub(row: RelayUsageRow): string {
  const upstream = row.upstreamModel && row.upstreamModel !== row.model ? ` → ${row.upstreamModel}` : ''
  return `${row.api}${row.stream ? ' · 流式' : ' · 非流式'}${upstream}`
}

/** 16 §4.3：渠道列显示公开的「标识 ×倍率」；没走到渠道显示「—」 */
function channelText(row: RelayUsageRow): string {
  if (row.channelSlug) {
    return row.channelRatePermille === null
      ? row.channelSlug
      : `${row.channelSlug} ${formatRate(row.channelRatePermille)}`
  }
  return row.channelName ?? '—'
}

const columns = computed<DataTableColumns<RelayUsageRow>>(() => {
  const list: DataTableColumns<RelayUsageRow> = [
    {
      title: '时间',
      key: 'createdAt',
      width: 140,
      render: (row) => formatDateTime(row.createdAt),
    },
  ]

  if (props.showSource) {
    list.push({
      title: '来源',
      key: 'scope',
      width: 108,
      render: (row) => {
        const scope = row.scope ?? 'dsh'
        return h(MiniTag, {
          text: relayScopeLabel(scope),
          tone: scope === 'claude-code' ? 'sakura' : scope === 'codex' ? 'sky' : 'neutral',
          size: 'sm',
        })
      },
    })
  }

  if (props.scope === 'admin') {
    list.push({
      title: '用户',
      key: 'username',
      width: 130,
      render: (row) =>
        h('span', { class: 'usage-log__mono usage-log__ellipsis', title: row.username }, row.username),
    })
  }

  list.push({
    title: '模型',
    key: 'model',
    minWidth: 190,
    render: (row) =>
      h('div', { class: 'usage-log__model' }, [
        h('span', { class: 'usage-log__model-name', title: row.model }, row.model),
        h('span', { class: 'usage-log__model-sub', title: modelSub(row) }, modelSub(row)),
      ]),
  })

  list.push({
    title: '渠道',
    key: 'channel',
    width: 145,
    render: (row) =>
      h(
        'span',
        {
          class: row.channelSlug
            ? 'usage-log__mono usage-log__ellipsis usage-log__channel'
            : 'usage-log__muted usage-log__channel',
          title: channelText(row),
        },
        channelText(row),
      ),
  })

  if (props.scope === 'user') {
    list.push({
      title: '密钥',
      key: 'keyName',
      width: 100,
      render: (row) =>
        row.keyName ? h('span', { class: 'usage-log__ellipsis', title: row.keyName }, row.keyName) : '—',
    })
  }

  list.push(
    {
      title: 'token（输入/缓存/输出）',
      key: 'tokens',
      width: 200,
      render: tokenCell,
    },
    {
      title: '积分',
      key: 'costMicro',
      width: 100,
      align: 'right',
      render: (row) =>
        h(
          'span',
          {
            class: 'usage-log__cost',
            // 12 §10：费用里含渠道倍率，悬停说明一下（用户端不给渠道名，只给倍率）
            title:
              row.channelRatePermille === null
                ? undefined
                : `含渠道倍率 ${formatRate(row.channelRatePermille)}`,
          },
          [
            h('span', null, formatPoints(row.costMicro)),
            row.estimated ? h('span', { class: 'usage-log__estimated', title: '按字数估算' }, '估') : null,
          ],
        ),
    },
    {
      title: '耗时 / 首字',
      key: 'durationMs',
      width: 110,
      render: (row) =>
        h('span', { class: 'usage-log__mono' }, `${seconds(row.durationMs)} / ${seconds(row.ttftMs)}`),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (row) => h(UsageStatusTag, { status: row.status, estimated: row.estimated, error: row.error }),
    },
  )

  if (props.scope === 'admin') {
    list.push({
      title: '倍率',
      key: 'channelRatePermille',
      width: 80,
      align: 'right',
      render: (row) =>
        h(
          'span',
          { class: 'usage-log__mono' },
          row.channelRatePermille === null ? '—' : formatRate(row.channelRatePermille),
        ),
    })
    list.push({
      title: '入口 / 重试',
      key: 'source',
      width: 130,
      render: (row) =>
        h(
          'span',
          { class: 'usage-log__mono' },
          `${row.source}${row.attempts > 1 ? ` · 试 ${row.attempts} 次` : ''}`,
        ),
    })
  }

  return list
})

// 列宽合计 > 卡片内宽时表格内部横向滚动（07 §2.8）；带「来源」列再 +108
const scrollX = computed(() => {
  const base = props.scope === 'admin' ? 1400 : 1060
  return base + (props.showSource ? 108 : 0)
})
</script>

<template>
  <NDataTable
    class="usage-log"
    :columns="columns"
    :data="rows"
    :loading="loading"
    :row-key="(row: RelayUsageRow) => row.id"
    :scroll-x="scrollX"
    table-layout="fixed"
    remote
    size="small"
    :pagination="{
      page,
      pageSize,
      itemCount: total,
      showSizePicker: true,
      pageSizes: [20, 50, 100],
      prefix: ({ itemCount }: { itemCount?: number }) => `共 ${itemCount ?? 0} 条`,
      onUpdatePage: (next: number) => emit('page-change', next),
      onUpdatePageSize: (next: number) => emit('page-size-change', next),
    }"
  >
    <template #empty>
      <span class="usage-log__empty">还没有用量记录</span>
    </template>
  </NDataTable>
</template>

<style scoped>
:deep(.usage-log__muted) {
  color: var(--c-text-3);
}

:deep(.usage-log__mono) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.usage-log__empty) {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

/* 标识符列：单行省略，完整内容在 title（07 §2.8） */
:deep(.usage-log__ellipsis) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.usage-log__tokens) {
  display: inline-flex;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

:deep(.usage-log__sep) {
  color: var(--c-text-3);
}

:deep(.usage-log__model) {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}

:deep(.usage-log__model-name) {
  overflow: hidden;
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.usage-log__model-sub) {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.usage-log__cost) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  white-space: nowrap;
}

:deep(.usage-log__estimated) {
  padding: 0 4px;
  border: var(--border-width) solid var(--c-butter);
  border-radius: var(--radius-pill);
  color: var(--c-butter-ink);
  font-family: var(--font-sans);
  font-size: 10px;
}
</style>
