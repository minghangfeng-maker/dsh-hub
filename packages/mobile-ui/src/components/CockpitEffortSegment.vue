<script setup lang="ts">
/**
 * 控制台主题的「思考程度」分段控件（WP58 / docs/26 §3.2）：直接摆在输入框里，
 * 点一下就切——不再用底部抽屉 + 拖动条（那是手机的手势）。
 *
 * 规则（与 EffortSheet 同一套语义，只是形态不同）：
 *  - 四档「低 | 中 | 高 | 超高」，每段悬停显示 `EFFORT_LEVELS[].desc`；
 *  - 当前模型不支持的档置灰、悬停给原因（原生 title + aria-disabled）；
 *  - 模型根本不支持思考 → 整个控件换成一行灰字「该模型不调思考」；
 *  - 点击走 `chat.pushModelSelection`：失败回滚 + toast（rollback 在 store 里）。
 *
 * 只在 `html.cockpit-console` 下被渲染。
 */
import { computed, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { EFFORT_LEVELS, type EffortTierId } from '@dsh-hub/mobile-core'

const chat = useChatStore()
const models = useModelsStore()

const levels = EFFORT_LEVELS
/** 分段上显示的字：文档的示意是「低 | 中 | 高 | 超高」（比 EFFORT_LEVELS 的 label 短） */
const SEGMENT_LABELS: Record<EffortTierId, string> = {
  low: '低',
  medium: '中',
  high: '高',
  ultra: '超高',
}

const supports = computed(() => models.supportsThinking)
const available = computed(() => new Set<string>(models.efforts))
const current = computed<EffortTierId | null>(() => models.selection?.effortTier ?? null)

/** 支持思考但这一档不可用时的原因（悬停提示，文案与 ModelSheet 的口径一致）。 */
function unsupportedReason(tier: EffortTierId): string {
  const level = levels.find((item) => item.id === tier)
  return `${level?.label ?? tier}：当前模型不支持这一档`
}

async function pick(tier: EffortTierId): Promise<void> {
  if (tier === current.value) return
  if (!available.value.has(tier)) return
  chat.rememberSelectionBeforeChange()
  await models.selectEffort(tier)
  await chat.pushModelSelection()
}

/** 提交中：连点只认最后一档（与拖动条一样串行化，避免 set-model 竞态）。 */
const committing = ref(false)

async function onPick(tier: EffortTierId): Promise<void> {
  if (committing.value) return
  committing.value = true
  try {
    await pick(tier)
  } finally {
    committing.value = false
  }
}
</script>

<template>
  <div v-if="!supports" class="effort-seg effort-seg--off" data-testid="console-effort-off">
    该模型不调思考
  </div>
  <div
    v-else
    class="effort-seg"
    role="group"
    aria-label="思考程度"
    data-testid="console-effort-seg"
  >
    <span class="effort-seg__label">思考</span>
    <button
      v-for="level in levels"
      :key="level.id"
      class="effort-seg__btn"
      :class="{
        'is-active': level.id === current,
        'is-disabled': !available.has(level.id),
      }"
      type="button"
      :data-tier="level.id"
      :disabled="!available.has(level.id)"
      :aria-pressed="level.id === current"
      :aria-disabled="!available.has(level.id)"
      :aria-label="`思考程度 ${level.label}（${SEGMENT_LABELS[level.id]}）`"
      :title="available.has(level.id) ? level.desc : unsupportedReason(level.id)"
      @click="onPick(level.id)"
    >
      {{ SEGMENT_LABELS[level.id] }}
    </button>
  </div>
</template>

<style scoped>
.effort-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--surface-2);
  min-width: 0;
}
.effort-seg--off {
  padding: 3px 4px;
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
  background: transparent;
}
.effort-seg__label {
  padding: 0 4px 0 2px;
  color: var(--text-3);
  font-size: 11.5px;
  white-space: nowrap;
}
.effort-seg__btn {
  min-width: 30px;
  padding: 2px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.effort-seg__btn:hover:not(.is-disabled) {
  background: rgba(20, 18, 12, 0.05);
}
.effort-seg__btn.is-active {
  background: #ffffff;
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(20, 18, 12, 0.12);
}
.effort-seg__btn.is-disabled {
  color: var(--text-3);
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
