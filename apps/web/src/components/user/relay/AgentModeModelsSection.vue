<script setup lang="ts">
import type { MyAgentMode, MyRelayModel } from '@dsh-hub/shared'
import { AGENT_MODE_LABEL } from '@dsh-hub/shared'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'

import CopyText from '@/components/base/CopyText.vue'
import { formatCount } from '@/composables/useFormat'
import { agentModePriceText } from '@/utils/agent-mode-price'
import { formatRate } from '@/utils/rate'

/**
 * 「可用模型」下面的对话模式小节（18 §7）：每个对我开通的模式一节，
 * 每行是模型名（等宽、可复制）、显示名、实际单价（模型价 × 渠道倍率 × 整体倍率 × 钱包倍率）、上下文。
 *
 * `agentModes` 为空时整个组件不渲染（页面与开通前完全一样）。
 */
const props = withDefaults(defineProps<{ modes: MyAgentMode[]; walletRatePercent?: number }>(), {
  walletRatePercent: 100,
})

const UNIT = '积分 / 百万 token'

interface Row {
  mode: MyAgentMode
  model: MyRelayModel
}

function priceText(row: Row, micro: number | null): { text: string; title: string } {
  return agentModePriceText(micro, {
    channelRate: row.model.channelRate,
    modeRatePermille: row.mode.ratePermille,
    walletRatePercent: props.walletRatePercent,
  })
}

function priceCell(row: Row, micro: number | null) {
  const price = priceText(row, micro)
  return h('span', { class: 'agent-models__price', title: price.title }, price.text)
}

const columns: DataTableColumns<Row> = [
  {
    title: '模型',
    key: 'name',
    width: 260,
    render: (row) =>
      h('div', { class: 'agent-models__cell' }, [
        h(CopyText, { text: row.model.name, size: 'sm', truncate: true, compact: true }),
        row.mode.defaultModel === row.model.name
          ? h('span', { class: 'agent-models__default' }, '默认')
          : null,
      ]),
  },
  {
    title: '显示名',
    key: 'displayName',
    minWidth: 160,
    ellipsis: { tooltip: true },
    render: (row) => row.model.displayName || '—',
  },
  {
    title: `实际单价（${UNIT}）`,
    key: 'price',
    children: [
      {
        title: '输入',
        key: 'input',
        width: 96,
        align: 'right',
        render: (row) => priceCell(row, row.model.price.inputMicro),
      },
      {
        title: '输出',
        key: 'output',
        width: 96,
        align: 'right',
        render: (row) => priceCell(row, row.model.price.outputMicro),
      },
      {
        title: '缓存读',
        key: 'cacheRead',
        width: 96,
        align: 'right',
        render: (row) => priceCell(row, row.model.price.cacheReadMicro),
      },
    ],
  },
  {
    title: '上下文',
    key: 'contextWindow',
    width: 110,
    align: 'right',
    render: (row) =>
      row.model.info.contextWindow
        ? h(
            'span',
            {
              class: 'agent-models__price',
              title: `${formatCount(row.model.info.contextWindow)} token`,
            },
            formatCount(row.model.info.contextWindow),
          )
        : '—',
  },
]

const sections = computed(() =>
  props.modes.map((mode) => ({
    mode,
    rows: mode.models.map((model) => ({ mode, model })),
  })),
)
</script>

<template>
  <div class="agent-models" data-testid="agent-mode-models">
    <section v-for="section in sections" :key="section.mode.mode" class="agent-models__section">
      <div class="agent-models__head">
        <h4 class="agent-models__title">{{ AGENT_MODE_LABEL[section.mode.mode] }}</h4>
        <span class="agent-models__rate" data-testid="agent-mode-rate-tag">
          {{ formatRate(section.mode.ratePermille) }}
        </span>
      </div>
      <NDataTable
        v-if="section.rows.length > 0"
        :columns="columns"
        :data="section.rows"
        :row-key="(row: Row) => `${row.mode.mode}:${row.model.name}`"
        :scroll-x="900"
        table-layout="fixed"
        :pagination="false"
        size="small"
      />
      <p v-else class="agent-models__empty">这个模式还没有可用模型</p>
    </section>
  </div>
</template>

<style scoped>
.agent-models {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  margin-top: var(--space-6);
}

.agent-models__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.agent-models__title {
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.agent-models__rate {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.agent-models__cell) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

:deep(.agent-models__default) {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--c-success-soft);
  color: var(--c-success-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.agent-models__price) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.agent-models__empty {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}
</style>
