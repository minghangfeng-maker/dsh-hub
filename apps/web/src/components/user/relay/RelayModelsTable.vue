<script setup lang="ts">
import type { MyRelayModel } from '@dsh-hub/shared'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import CopyText from '@/components/base/CopyText.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import { formatCount } from '@/composables/useFormat'
import { MODEL_PRICE_UNIT, modelPriceText } from '@/utils/model-price'
import { flattenMyRelayModels, type PinnedModelRow } from '@/utils/pinned-models'
import { formatPrice } from '@/utils/points'
import { applyRate, formatRate } from '@/utils/rate'

/**
 * 「可用模型」表（16 §4.3）：和「我的模型」一样把 `models[].routes[]` 平铺成独立的
 * 「模型@渠道」一行，列为模型（可复制）、渠道（`slug ×倍率`）、可用接口、这条渠道上的确切价格、上下文。
 *
 * 价格按该行渠道的倍率算（`applyRate`），缓存读为 null 时显示「同输入」。`routes` 缺省（老后端）时
 * 退回 WP19 的按模型一行 + 倍率区间。07 §2.7 / §2.8：单位进分组列标题、说明收进「模型」列标题的 InfoTip。
 */
const props = defineProps<{ models: MyRelayModel[]; loading?: boolean; walletRatePercent?: number }>()

const API_TEXT: Record<string, string> = {
  'openai-completions': 'OpenAI 对话',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic',
}

const rows = computed<PinnedModelRow[]>(() => flattenMyRelayModels(props.models))

/** 这一行价格：有路由时按该渠道倍率算死，回退时沿用 WP19 的区间显示 */
function priced(micro: number | null, row: PinnedModelRow): { text: string; title: string } {
  if (micro === null) return { text: '同输入', title: '缓存读与输入同价' }
  if (!row.route) {
    const price = modelPriceText(micro, row.model)
    return { text: price.text, title: price.title }
  }
  const text = formatPrice(applyRate(micro, row.ratePermille))
  return { text, title: `${text} ${MODEL_PRICE_UNIT}（${row.name}）` }
}

function priceCell(micro: number | null, row: PinnedModelRow) {
  const price = priced(micro, row)
  return h('span', { class: 'relay-models__price', title: price.title }, price.text)
}

function channelCell(row: PinnedModelRow) {
  if (!row.channelSlug) return h('span', { class: 'relay-models__muted' }, '—')
  const text = `${row.channelSlug} ${formatRate(row.ratePermille)}`
  return h('span', { class: 'relay-models__channel', title: text }, text)
}

const columns = computed<DataTableColumns<PinnedModelRow>>(() => [
  {
    title: () =>
      h('span', { class: 'relay-models__th' }, [
        '模型',
        h(InfoTip, {
          label: '模型名里的 @',
          text: '模型名后面的 @ 表示走哪条渠道，价格按这条渠道算。',
        }),
      ]),
    key: 'name',
    width: 250,
    render: (row) =>
      h('div', { class: 'relay-models__cell' }, [
        h(CopyText, { text: row.name, size: 'sm', truncate: true, compact: true }),
        row.displayName && row.displayName !== row.name
          ? h('span', { class: 'relay-models__sub', title: row.displayName }, row.displayName)
          : null,
      ]),
  },
  {
    title: '渠道',
    key: 'channel',
    width: 130,
    render: channelCell,
  },
  {
    title: '可用接口',
    key: 'apis',
    width: 160,
    render: (row) =>
      h(
        'div',
        { class: 'relay-models__apis' },
        row.model.apis.map((api) => h('span', { class: 'relay-models__api' }, API_TEXT[api] ?? api)),
      ),
  },
  {
    // 单位进列标题（07 §2.7 第 2 条），不再在表格下面写一行说明
    title: `价格（${MODEL_PRICE_UNIT}）`,
    key: 'price',
    children: [
      {
        title: '输入',
        key: 'input',
        width: 80,
        align: 'right',
        render: (row) => priceCell(row.model.price.inputMicro, row),
      },
      {
        title: '输出',
        key: 'output',
        width: 80,
        align: 'right',
        render: (row) => priceCell(row.model.price.outputMicro, row),
      },
      {
        title: '缓存读',
        key: 'cacheRead',
        width: 85,
        align: 'right',
        render: (row) => priceCell(row.model.price.cacheReadMicro, row),
      },
    ],
  },
  {
    title: '每次请求',
    key: 'perRequest',
    width: 80,
    align: 'right',
    render: (row) => priced(row.model.price.perRequestMicro, row).text,
  },
  {
    title: '上下文',
    key: 'contextWindow',
    width: 95,
    align: 'right',
    render: (row) =>
      row.model.info.contextWindow
        ? h(
            'span',
            {
              class: 'relay-models__price',
              title: `${formatCount(row.model.info.contextWindow)} token`,
            },
            formatCount(row.model.info.contextWindow),
          )
        : '—',
  },
])

// 列宽合计 960：1440 下模型列还有富余，1024 及以下由表格自己横向滚动（07 §2.8）
const scrollX = 960
</script>

<template>
  <NDataTable
    class="relay-models"
    :columns="columns"
    :data="rows"
    :loading="loading"
    :row-key="(row: PinnedModelRow) => row.key"
    :scroll-x="scrollX"
    table-layout="fixed"
    :pagination="false"
    size="small"
  />
  <!-- 计费倍率不是 100% 时才出现的状态行（07 §2.7 第 3 条） -->
  <p
    v-if="walletRatePercent !== undefined && walletRatePercent !== 100"
    class="relay-models__rate"
    data-testid="wallet-rate"
  >
    <span class="i-ph-percent" aria-hidden="true" />
    你的计费倍率 {{ walletRatePercent }}%
  </p>
</template>

<style scoped>
:deep(.relay-models__cell) {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

:deep(.relay-models__sub) {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.relay-models__channel) {
  overflow: hidden;
  color: var(--c-primary-press);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.relay-models__muted) {
  color: var(--c-text-3);
}

:deep(.relay-models__th) {
  white-space: nowrap;
}

:deep(.relay-models__apis) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

:deep(.relay-models__api) {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.relay-models__price) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.relay-models__rate {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-3);
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}
</style>
