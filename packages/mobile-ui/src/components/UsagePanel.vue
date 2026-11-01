<script setup lang="ts">
/**
 * Token 用量面板（0.4.0 §1.3）：从旧 `ConversationInfoSheet` 的「用量」区块拆出来。
 *
 * 形态改成分组列表：大字号主数值（总 tokens）+ 小字说明（回合 / 提问数），
 * 下面是「输入 / 输出 / 缓存命中 / 缓存命中率」与「积分消耗 / 回合数 / 用户消息数」。
 *
 * 数据来源仍是 `chat.sessionUsage`（协议层 `usage` 帧的投影），组件只负责展示：
 * 打开时 `loadSessionUsage()` 拉一次，关闭（卸载）时 `clearSessionUsage()` 清掉，
 * loading / 失败重试 / 暂无数据三种状态都有明确文案。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'
import { useChatStore } from '@/stores/chat'
import { cacheHitRateText, formatPointsMicro } from '@/lib/usage-format'

const chat = useChatStore()

const usage = computed(() => chat.sessionUsage)
const loading = computed(() => chat.sessionUsageLoading)
const error = computed(() => chat.sessionUsageError)
const pointsText = computed(() => formatPointsMicro(usage.value?.pointsMicro ?? null))

const numberFormat = new Intl.NumberFormat('zh-CN')
function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(value) : '—'
}

/** 主数值下面那行小字：回合数 + 提问数（没有数据时给一句中性说明）。 */
const heroSub = computed(() => {
  const current = usage.value
  if (!current) return '本会话累计消耗'
  return `${formatCount(current.turns)} 回合 · ${formatCount(current.userMessages)} 条提问`
})

function refresh(): void {
  if (loading.value) return
  chat.loadSessionUsage()
}

onMounted(() => {
  chat.loadSessionUsage()
})

onBeforeUnmount(() => {
  chat.clearSessionUsage()
})
</script>

<template>
  <section class="usage" data-panel="usage">
    <div class="usage__hero">
      <div class="usage__hero-main">
        <p class="usage__hero-value" data-key="totalTokens">
          {{ formatCount(usage?.totalTokens) }}
        </p>
        <p class="usage__hero-label">总 tokens</p>
      </div>
      <button
        class="usage__refresh"
        :class="{ 'is-spinning': loading }"
        type="button"
        aria-label="刷新用量"
        :disabled="loading"
        @click="refresh"
      >
        <AppIcon name="refresh" :size="18" />
      </button>
    </div>
    <p class="usage__hero-sub">{{ heroSub }}</p>

    <p v-if="usage && usage.truncated" class="usage__hint">统计已截断（仅统计了最近的若干消息）</p>

    <p v-if="!usage && loading" class="usage__state">正在统计用量…</p>

    <div v-else-if="error" class="usage__error">
      <span class="usage__error-text">{{ error }}</span>
      <button class="usage__retry" type="button" @click="refresh">重试</button>
    </div>

    <p v-else-if="!usage" class="usage__state">暂无用量数据</p>

    <template v-else>
      <p class="usage__group-label">明细</p>
      <dl class="usage__group">
        <div class="usage__row" data-key="inputTokens">
          <dt>输入 tokens</dt>
          <dd>{{ formatCount(usage.inputTokens) }}</dd>
        </div>
        <div class="usage__row" data-key="outputTokens">
          <dt>输出 tokens</dt>
          <dd>{{ formatCount(usage.outputTokens) }}</dd>
        </div>
        <div class="usage__row" data-key="cacheReadTokens">
          <dt>缓存命中</dt>
          <dd>{{ formatCount(usage.cacheReadTokens) }}</dd>
        </div>
        <div
          class="usage__row"
          data-key="cacheHitRate"
          title="缓存命中 ÷（输入 tokens + 缓存命中）"
        >
          <dt>缓存命中率</dt>
          <dd>{{ cacheHitRateText(usage) }}</dd>
        </div>
      </dl>

      <p class="usage__group-label">消耗</p>
      <dl class="usage__group">
        <div
          class="usage__row"
          data-key="pointsMicro"
          title="按 Hub 中转站的模型价格 × 渠道倍率 × 钱包倍率估算"
        >
          <dt>积分消耗</dt>
          <dd>
            {{ pointsText }}
            <span v-if="usage.pointsEstimated" class="usage__estimate">估算</span>
          </dd>
        </div>
      </dl>

      <p class="usage__group-label">数量</p>
      <dl class="usage__group">
        <div class="usage__row" data-key="turns">
          <dt>回合数</dt>
          <dd>{{ formatCount(usage.turns) }}</dd>
        </div>
        <div class="usage__row" data-key="userMessages">
          <dt>用户消息数</dt>
          <dd>{{ formatCount(usage.userMessages) }}</dd>
        </div>
      </dl>

      <p v-if="loading" class="usage__hint">正在刷新用量…</p>
    </template>
  </section>
</template>

<style scoped>
.usage {
  padding-top: 6px;
}
.usage__hero {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.usage__hero-main {
  flex: 1;
  min-width: 0;
}
/* 主数值：一眼能读出来的大小，数字用等宽字形对齐 */
.usage__hero-value {
  margin: 0;
  font-size: 34px;
  line-height: 1.1;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.usage__hero-label {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--text-3);
}
.usage__hero-sub {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.usage__refresh {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  transition: background-color 0.14s ease, transform 0.14s ease;
}
.usage__refresh:active {
  background: var(--surface-3);
  transform: scale(0.94);
}
.usage__refresh[disabled] {
  opacity: 0.6;
}
.usage__refresh.is-spinning .icon {
  animation: usage-spin 0.9s linear infinite;
}
@keyframes usage-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.usage__group-label {
  margin: 22px 0 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-3);
}
.usage__group {
  margin: 0;
  padding: 0 0 2px;
}
.usage__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 0.5px solid var(--border);
}
.usage__row:last-child {
  border-bottom: 0;
}
.usage__row dt {
  font-size: 14px;
  color: var(--text-2);
}
.usage__row dd {
  margin: 0;
  font-size: 16.5px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.usage__estimate {
  margin-left: 5px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-3);
}

.usage__hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}
.usage__state {
  margin: 18px 0 0;
  font-size: 13px;
  color: var(--text-3);
}
.usage__error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  font-size: 13px;
  color: var(--danger);
}
.usage__error-text {
  flex: 1;
  min-width: 0;
  line-height: 1.45;
}
.usage__retry {
  flex: 0 0 auto;
  padding: 6px 12px;
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}
</style>
