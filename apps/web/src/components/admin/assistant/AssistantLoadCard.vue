<script setup lang="ts">
import { NButton } from 'naive-ui'
import { computed } from 'vue'

import {
  ASSIST_EXPECTED_HINT,
  ASSIST_STEP_KEYS,
  ASSIST_STEP_LABELS,
  assistLoadTitle,
  formatAssistElapsed,
  type AssistPhase,
  type AssistStepKey,
  type AssistStepState,
} from '@/utils/assist-phase'

/**
 * 启动加载卡（WP58，docs/26 §4.2）：盖在对话区上，**下面**是正在加载的 iframe 与本页画的骨架。
 *
 * - 三步竖排步骤条（✓ 完成 / 转圈 进行中 / 灰点 未到 / ✕ 失败）；
 * - 右上「已用 0:42」计时（从点启动起算）；
 * - 上方一条 2px 主色不定进度条，背后骨架用全局 `.skeleton` 的微光；
 * - 失败时停在出错那一步，红字原因 +「重试」「重启容器」；
 * - `prefers-reduced-motion`：微光与进度条不动、转圈换静态图标（见样式里的媒体查询与 `.ring-spin`）。
 */
const props = defineProps<{
  phase: AssistPhase
  steps: Record<AssistStepKey, AssistStepState>
  /** 从点启动 / 重启起已用的毫秒数 */
  elapsedMs: number
  /** 失败原因（`failed` 时有） */
  reason: string | null
  /** App 报来的那句中文（`cockpit.status.message`） */
  message: string | null
  /** 会话列表常驻（L 档及以上）：骨架左边多画一列会话占位 */
  dockedSessions: boolean
}>()

defineEmits<{ retry: []; restart: [] }>()

const title = computed(() => assistLoadTitle(props.phase))
const failed = computed(() => props.phase === 'failed')
const elapsedLabel = computed(() => formatAssistElapsed(props.elapsedMs))
const showElapsed = computed(() => props.elapsedMs > 0)

const steps = computed(() =>
  ASSIST_STEP_KEYS.map((key) => ({
    key,
    label: ASSIST_STEP_LABELS[key],
    state: props.steps[key],
  })),
)

/** 进行中的那一步（`failed` 时没有） */
function markClass(state: AssistStepState): string {
  return `load__step-mark load__step-mark--${state}`
}
</script>

<template>
  <div class="load" :data-phase="phase" data-testid="ops-assistant-load">
    <!-- 卡片头顶 2px 主色不定进度条 -->
    <div class="load__progress" aria-hidden="true"><span /></div>

    <!-- 卡后面的对话区骨架：会话（L 档起）+ 消息 + 输入框 -->
    <div class="load__skeleton" aria-hidden="true">
      <div v-if="dockedSessions" class="load__skeleton-sessions">
        <span class="skeleton load__bar" />
        <span v-for="index in 3" :key="`s-${String(index)}`" class="skeleton load__row" />
      </div>
      <div class="load__skeleton-chat">
        <span class="skeleton load__bubble load__bubble--user" />
        <span class="skeleton load__bubble load__bubble--dsh" />
        <span class="skeleton load__bubble load__bubble--short" />
        <span class="skeleton load__input" />
      </div>
    </div>

    <div class="load__card" role="status" aria-live="polite">
      <header class="load__head">
        <span class="load__title">{{ title }}</span>
        <span v-if="showElapsed" class="load__elapsed" data-testid="ops-assistant-elapsed">
          已用 {{ elapsedLabel }}
        </span>
      </header>

      <ol class="load__steps">
        <li v-for="step in steps" :key="step.key" class="load__step" :class="`load__step--${step.state}`">
          <span :class="markClass(step.state)" aria-hidden="true">
            <span v-if="step.state === 'done'" class="i-ph-check" />
            <span v-else-if="step.state === 'active'" class="i-ph-circle-notch ring-spin" />
            <span v-else-if="step.state === 'failed'" class="i-ph-x" />
            <span v-else class="load__dot" />
          </span>
          <span class="load__step-label">{{ step.label }}</span>
        </li>
      </ol>

      <p v-if="failed" class="load__reason" data-testid="ops-assistant-fail-reason">
        {{ reason ?? '启动失败' }}
        <span v-if="message && message !== reason" class="load__message">（{{ message }}）</span>
      </p>
      <p v-else class="load__hint">{{ ASSIST_EXPECTED_HINT }}</p>

      <div v-if="failed" class="load__actions">
        <NButton size="small" type="primary" data-testid="ops-assistant-retry" @click="$emit('retry')">
          重试
        </NButton>
        <NButton size="small" quaternary data-testid="ops-assistant-restart-container" @click="$emit('restart')">
          重启容器
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.load {
  position: absolute;
  z-index: 3;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: inherit;
  background: var(--c-surface);
}

/* ── 顶边不定进度条 ── */

.load__progress {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 2px;
  overflow: hidden;
  background: var(--c-primary-soft);
}

.load__progress span {
  display: block;
  width: 34%;
  height: 100%;
  border-radius: 2px;
  animation: assist-load-bar 1400ms var(--ease-out-soft) infinite;
  background: var(--c-primary);
}

@keyframes assist-load-bar {
  from {
    transform: translateX(-100%);
  }

  to {
    transform: translateX(320%);
  }
}

/* ── 背后的骨架 ── */

.load__skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  gap: var(--space-4);
  padding: var(--space-4);
  opacity: 0.7;
  pointer-events: none;
}

.load__skeleton-sessions {
  display: flex;
  width: 200px;
  flex: none;
  flex-direction: column;
  gap: var(--space-3);
  padding-right: var(--space-4);
  border-right: var(--border-width) solid var(--c-border);
}

.load__skeleton-chat {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-6);
}

.load__bar {
  height: 28px;
}

.load__row {
  height: 18px;
}

.load__row:nth-child(3) {
  width: 72%;
}

.load__bubble {
  height: 56px;
  border-radius: var(--radius-card);
}

.load__bubble--user {
  width: 46%;
  align-self: flex-end;
}

.load__bubble--dsh {
  width: 78%;
}

.load__bubble--short {
  width: 34%;
  height: 34px;
}

.load__input {
  margin-top: auto;
  height: 72px;
  border-radius: var(--radius-card);
}

/* ── 中间的卡 ── */

.load__card {
  position: relative;
  z-index: 1;
  display: flex;
  width: min(400px, 84%);
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-hover);
}

.load__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.load__title {
  color: var(--c-text);
  font-size: var(--fs-15);
  font-weight: var(--fw-semibold);
}

.load__elapsed {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.load__steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.load__step {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.load__step--active {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

.load__step--done {
  color: var(--c-text-2);
}

.load__step--failed {
  color: var(--c-danger-ink);
  font-weight: var(--fw-semibold);
}

.load__step-mark {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
}

.load__step-mark--done {
  background: var(--c-success-soft);
  color: var(--c-success-ink);
}

.load__step-mark--active {
  background: var(--c-sky-soft);
  color: var(--c-sky-ink);
}

.load__step-mark--failed {
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
}

.load__step-mark--todo {
  background: var(--c-surface-muted);
}

.load__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-text-3);
}

.load__hint {
  margin: 0;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.load__reason {
  margin: 0;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
  line-height: var(--lh-base);
}

.load__message {
  color: var(--c-text-3);
}

.load__actions {
  display: flex;
  gap: var(--space-2);
}

/* 失败：进度条停下，别再让人以为还在跑 */
.load[data-phase='failed'] .load__progress span {
  width: 100%;
  animation: none;
  opacity: 0.35;
}

/* ── 减少动态效果：进度条与骨架微光不动（.skeleton::after 由全局样式关掉），转圈换静态 ── */

@media (prefers-reduced-motion: reduce) {
  .load__progress span {
    width: 100%;
    animation: none;
    opacity: 0.45;
  }
}
</style>
