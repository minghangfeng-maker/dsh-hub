<script setup lang="ts">
import type { ModelPolicy, MyRelayResponse } from '@dsh-hub/shared'
import { computed } from 'vue'

import CopyText from '@/components/base/CopyText.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { formatCount } from '@/composables/useFormat'
import { MODEL_PRICE_UNIT, modelPriceText } from '@/utils/model-price'
import { flattenMyRelayModels, type PinnedModelRow } from '@/utils/pinned-models'
import { formatPoints, formatPrice } from '@/utils/points'
import { applyRate, formatRate } from '@/utils/rate'

/**
 * 工作台「我的模型」（16 §4.2）：把 `models[].routes[]` 展开成**平铺的独立模型**，一行一个、
 * 不按原模型分组；每行是「模型@渠道」、渠道「slug ×倍率」、这条渠道上的确切价格与上下文。
 *
 * 排序：默认模型第一，其余按倍率从低到高、再按名字（16 §4.2）。统一管理（managed）且接口给了
 * `inDsh` 时只列 `inDsh === true` 的行。后端没给 `routes` 时退回 WP19 的按模型显示（价格显示区间）。
 * 价格算法与「可用模型」表共用 `utils/model-price.ts` 与 `utils/rate.ts`。
 */
const props = withDefaults(
  defineProps<{
    summary: { preset: string; defaultModel: string; providers: string[]; policy?: ModelPolicy } | null
    /** `/api/me/relay` 的完整响应（null = 未开通 / 还没读到） */
    relay?: MyRelayResponse | null
    loading?: boolean
  }>(),
  { relay: null, loading: false },
)

/** 统一管理 = 管理员在「模型 → 下发到 DSH」里配好的模型（老响应按有预设推断） */
const managed = computed(() =>
  props.summary?.policy ? props.summary.policy === 'managed' : (props.summary?.preset ?? '').length > 0,
)

const providers = computed(() => props.summary?.providers ?? [])

/** 平铺后的独立模型（同一模型挂三条渠道就是三行；`routes` 缺省时每模型一行） */
const rows = computed<PinnedModelRow[]>(() =>
  flattenMyRelayModels(props.relay?.models ?? [], {
    managed: managed.value,
    defaultModelName: props.summary?.defaultModel ?? null,
  }),
)

/** 页头默认模型：新数据里显示默认的那条「模型@渠道」 */
const defaultModelText = computed(
  () => rows.value.find((row) => row.isDefault)?.name ?? props.summary?.defaultModel ?? '—',
)

const wallet = computed(() => props.relay?.wallet ?? null)
const ratePercent = computed(() => props.relay?.wallet.ratePercent ?? 100)

/** 新数据（有 routes）时按这一条渠道算确切价格；回退时沿用 WP19 的区间算法 */
function inputPrice(row: PinnedModelRow): string {
  if (row.route) return formatRated(row.model.price.inputMicro, row.ratePermille)
  return modelPriceText(row.model.price.inputMicro, row.model).text
}

function outputPrice(row: PinnedModelRow): string {
  if (row.route) return formatRated(row.model.price.outputMicro, row.ratePermille)
  return modelPriceText(row.model.price.outputMicro, row.model).text
}

function cacheReadPrice(row: PinnedModelRow): string {
  if (row.route) {
    if (row.model.price.cacheReadMicro === null) return '同输入'
    return formatRated(row.model.price.cacheReadMicro, row.ratePermille)
  }
  return modelPriceText(row.model.price.cacheReadMicro, row.model).text
}

function priceTitle(row: PinnedModelRow, label: string, micro: number | null, text: string): string {
  if (!row.route) return modelPriceText(micro, row.model).title
  if (micro === null) return `${label}与输入同价`
  return `${text} ${MODEL_PRICE_UNIT}（${row.name}）`
}

/** 模型价格 × 这条渠道的倍率（微积分 / 百万 token） */
function formatRated(micro: number, permille: number | null): string {
  return formatPrice(applyRate(micro, permille))
}

function channelText(row: PinnedModelRow): string {
  if (!row.channelSlug) return ''
  return `${row.channelSlug} ${formatRate(row.ratePermille)}`
}

function isRated(row: PinnedModelRow): boolean {
  return row.ratePermille !== null && row.ratePermille !== 1000
}
</script>

<template>
  <SoftCard title="我的模型">
    <template #title-extra>
      <InfoTip
        v-if="managed"
        label="模型由管理员统一配置"
        text="由管理员统一配置，在 DSH 设置页修改不会生效。"
      />
    </template>
    <template #extra>
      <span v-if="managed" class="i-ph-lock-key text-[16px] text-3" aria-label="由管理员统一配置" />
    </template>

    <div v-if="loading" class="skeleton h-[96px] rounded-control" aria-hidden="true" />

    <template v-else-if="summary">
      <div class="home-models__default">
        <p class="home-models__default-name">{{ defaultModelText }}</p>
        <p class="home-models__default-note">
          {{ managed ? '由管理员统一配置' : '由你自己配置' }}
        </p>
        <div class="home-models__providers">
          <span v-for="provider in providers" :key="provider" class="hub-chip">{{ provider }}</span>
          <span v-if="providers.length === 0" class="hub-muted">还没有可用提供方</span>
        </div>
      </div>

      <!-- 12 §10：积分余额与本月消耗，点进「积分与用量」 -->
      <RouterLink v-if="relay?.enabled && wallet" to="/usage" class="home-models__points">
        <span class="i-ph-arrows-left-right" aria-hidden="true" />
        <span class="home-models__points-text">
          <span>积分余额 {{ formatPoints(wallet.balanceMicro) }}</span>
          <span>本月已用 {{ formatPoints(props.relay?.month.costMicro ?? 0) }}</span>
        </span>
        <span class="i-ph-arrow-right home-models__points-arrow" aria-hidden="true" />
      </RouterLink>

      <!-- 15 §2.2：钱包倍率不是 100% 时才出现的状态行 -->
      <p
        v-if="relay?.enabled && ratePercent !== 100"
        class="home-models__rate"
        data-testid="home-wallet-rate"
      >
        <span class="i-ph-percent" aria-hidden="true" />
        你的价格为标价的 {{ ratePercent }}%
      </p>

      <template v-if="relay?.enabled">
        <div v-if="rows.length > 0" class="home-models__table">
          <div class="home-models__head" aria-hidden="true">
            <span>模型</span>
            <span>价格（{{ MODEL_PRICE_UNIT }}）</span>
            <span class="home-models__head-context">上下文</span>
          </div>

          <ul class="home-models__list">
            <li
              v-for="row in rows"
              :key="row.key"
              class="home-models__row"
              data-testid="home-model-row"
              :data-model="row.model.name"
              :data-pinned="row.name"
            >
              <div class="home-models__model">
                <div class="home-models__name-line">
                  <CopyText :text="row.name" size="sm" truncate />
                  <span
                    v-if="row.isDefault"
                    class="home-models__default-tag"
                    data-testid="home-model-default"
                  >
                    默认
                  </span>
                </div>
                <span
                  v-if="row.displayName && row.displayName !== row.name"
                  class="home-models__sub"
                  :title="row.displayName"
                >
                  {{ row.displayName }}
                </span>
                <span
                  v-if="row.route"
                  class="home-models__channel"
                  :class="{ 'home-models__channel--rated': isRated(row) }"
                  data-testid="home-model-channel"
                >
                  {{ channelText(row) }}
                </span>
              </div>

              <div class="home-models__prices">
                <span
                  class="home-models__price"
                  :title="priceTitle(row, '输入', row.model.price.inputMicro, inputPrice(row))"
                >
                  <span class="home-models__price-label">输入</span>
                  {{ inputPrice(row) }}
                </span>
                <span
                  class="home-models__price"
                  :title="priceTitle(row, '输出', row.model.price.outputMicro, outputPrice(row))"
                >
                  <span class="home-models__price-label">输出</span>
                  {{ outputPrice(row) }}
                </span>
                <span
                  class="home-models__price"
                  :title="priceTitle(row, '缓存读', row.model.price.cacheReadMicro, cacheReadPrice(row))"
                >
                  <span class="home-models__price-label">缓存读</span>
                  {{ cacheReadPrice(row) }}
                </span>
              </div>

              <div class="home-models__context">
                <span
                  v-if="row.model.info.contextWindow"
                  :title="`${formatCount(row.model.info.contextWindow)} token`"
                >
                  {{ formatCount(row.model.info.contextWindow) }}
                </span>
                <span v-else>—</span>
              </div>
            </li>
          </ul>
        </div>

        <p v-else class="home-models__empty">你的 DSH 里还没有可用的模型。</p>
      </template>
    </template>

    <p v-else class="hub-muted">实例启动后就能看到模型信息了。</p>
  </SoftCard>
</template>

<style scoped>
.home-models__default {
  min-width: 0;
}

.home-models__default-name {
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.home-models__default-note {
  margin-top: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.home-models__providers {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.home-models__points {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: var(--border-width) solid var(--c-border);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.home-models__points:hover {
  color: var(--c-primary-press);
}

.home-models__points-text {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  min-width: 0;
}

.home-models__points-text > span {
  white-space: nowrap;
}

.home-models__points-arrow {
  margin-left: auto;
}

.home-models__rate {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-2);
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}

.home-models__table {
  margin-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
}

.home-models__head {
  display: grid;
  align-items: center;
  gap: var(--space-3);
  grid-template-columns: minmax(220px, 1.2fr) minmax(260px, 1.4fr) 110px;
  padding: var(--space-2) 0;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.home-models__head-context {
  text-align: right;
}

.home-models__list {
  display: flex;
  flex-direction: column;
}

.home-models__row {
  display: grid;
  align-items: center;
  gap: var(--space-3);
  grid-template-columns: minmax(220px, 1.2fr) minmax(260px, 1.4fr) 110px;
  padding: var(--space-3) 0;
  border-top: var(--border-width) solid var(--c-border);
}

.home-models__model {
  min-width: 0;
}

.home-models__name-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.home-models__sub {
  display: block;
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.home-models__channel {
  display: inline-block;
  max-width: 100%;
  margin-top: 2px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

/* 倍率不等于 1 时用强调色，提醒这条渠道不是原价（16 §4.2） */
.home-models__channel--rated {
  background: var(--c-butter-soft);
  color: var(--c-butter-ink);
}

.home-models__default-tag {
  flex: none;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.home-models__prices {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.home-models__price {
  display: flex;
  flex-direction: column;
  gap: 1px;
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.home-models__price-label {
  color: var(--c-text-3);
  font-family: var(--font-sans);
  font-size: var(--fs-12);
}

.home-models__context {
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-align: right;
  white-space: nowrap;
}

.home-models__empty {
  margin-top: var(--space-4);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

/* 手机宽度：一个模型一张卡片，价格成对排在模型名下面（15 §2.2，不做横向滚动的宽表） */
@media (max-width: 900px) {
  .home-models__head {
    display: none;
  }

  .home-models__table {
    border-top: 0;
    margin-top: var(--space-3);
  }

  .home-models__list {
    gap: var(--space-2);
  }

  .home-models__row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
    padding: var(--space-3);
    border: var(--border-width) solid var(--c-border);
    border-radius: var(--radius-control);
    background: var(--c-bg);
  }

  .home-models__prices {
    gap: var(--space-1) var(--space-3);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .home-models__context {
    align-self: flex-start;
    color: var(--c-text-3);
  }

  .home-models__context::before {
    content: '上下文 ';
    font-family: var(--font-sans);
  }
}
</style>
