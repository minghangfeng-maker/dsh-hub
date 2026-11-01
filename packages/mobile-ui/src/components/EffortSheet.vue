<script setup lang="ts">
/**
 * 强度拖动条弹层（Codex 风格的芯片 → 强度段）。
 *
 * 四档从左到右：低 Low / 中等 Medium / 高 High / 超高 Max。
 *  - pointer events 拖动（`touch-action: none`，WebView 里不会连带滚动页面）；
 *  - 拖动时按最近**可用档**吸附，跨档立即生效（调用 chat.pushModelSelection，失败会回滚+toast）；
 *  - 松手吸附到档位；点下面的刻度标签可直接跳到该档；
 *  - 当前模型不支持的档位置灰、不可拖到（吸附会避开）；
 *  - 无障碍：role="slider" + aria-valuemin/max/now + aria-valuetext，方向键可调。
 */
import { computed, ref, watch } from 'vue'
import BottomSheet from './BottomSheet.vue'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { EFFORT_LEVELS, type EffortTierId } from '@dsh-hub/mobile-core'
import { EFFORT_SHORT_LABELS, effortShortLabel } from '@/lib/model-label'
import { indexFromRatio, nearestAvailableIndex } from '@/lib/effort-slider'

const ui = useUiStore()
const chat = useChatStore()
const models = useModelsStore()

const levels = EFFORT_LEVELS
const lastIndex = levels.length - 1

const supports = computed(() => models.supportsThinking)
const available = computed(() => new Set<string>(models.efforts))
/** 四档可用性：拖动吸附与刻度置灰都只看这份（下标与 EFFORT_LEVELS 对齐）。 */
const availableFlags = computed(() => levels.map((level) => available.value.has(level.id)))
const availableIndexes = computed(() =>
  availableFlags.value.map((ok, index) => (ok ? index : -1)).filter((i) => i >= 0),
)

const selectionIndex = computed(() => {
  const index = levels.findIndex((level) => level.id === models.selection?.effortTier)
  if (index >= 0) return index
  return availableIndexes.value[0] ?? 0
})

/** 拖动中的落点（一定落在可用档上）。 */
const draft = ref(0)
const dragging = ref(false)
const draftLevel = computed(() => levels[draft.value] ?? levels[0]!)
const draftShort = computed(() => effortShortLabel(draftLevel.value.id))

const hint = computed(() => {
  if (!supports.value) return '该模型不支持调节思考程度'
  return draftLevel.value.desc
})

const trackEl = ref<HTMLElement | null>(null)
let activePointerId: number | null = null

function ratioFromX(clientX: number): number {
  const el = trackEl.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

/** 拖动 / 点击的落点 → 吸附到最近可用档（不支持的档位拖不到）→ 跨档立即生效。 */
function moveTo(clientX: number): void {
  if (!supports.value || availableIndexes.value.length === 0) return
  const raw = indexFromRatio(ratioFromX(clientX), levels.length)
  const index = nearestAvailableIndex(raw, availableFlags.value, selectionIndex.value)
  if (index === draft.value) return
  draft.value = index
  void commit(levels[index]!.id)
}

function onPointerDown(event: PointerEvent): void {
  if (!supports.value || availableIndexes.value.length === 0) return
  if (activePointerId !== null) return
  activePointerId = event.pointerId
  dragging.value = true
  const el = event.currentTarget as HTMLElement
  el.setPointerCapture?.(event.pointerId)
  moveTo(event.clientX)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value || event.pointerId !== activePointerId) return
  moveTo(event.clientX)
}

function endDrag(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return
  activePointerId = null
  dragging.value = false
  const el = event.currentTarget as HTMLElement
  if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
  // 松手时再对齐一次：拖动过程中指针可能已经离开轨道。
  moveTo(event.clientX)
}

function pickIndex(index: number): void {
  const level = levels[index]
  if (!level || !available.value.has(level.id)) return
  draft.value = index
  void commit(level.id)
}

function onKeydown(event: KeyboardEvent): void {
  if (!supports.value) return
  const indexes = availableIndexes.value
  if (indexes.length === 0) return
  let target: number | null = null
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    target = [...indexes].reverse().find((i) => i < draft.value) ?? indexes[0]!
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    target = indexes.find((i) => i > draft.value) ?? indexes[indexes.length - 1]!
  } else if (event.key === 'Home') {
    target = indexes[0]!
  } else if (event.key === 'End') {
    target = indexes[indexes.length - 1]!
  }
  if (target === null) return
  event.preventDefault()
  draft.value = target
  void commit(levels[target]!.id)
}

// ── 生效链路（不绕过 core 的 set-model：选择 → 作用到当前会话，失败回滚） ──

let committing = false
let queuedTier: EffortTierId | null = null

async function applyTier(tier: EffortTierId): Promise<void> {
  chat.rememberSelectionBeforeChange()
  await models.selectEffort(tier)
  await chat.pushModelSelection()
}

async function commit(tier: EffortTierId): Promise<void> {
  if (!available.value.has(tier)) return
  if (tier === models.selection?.effortTier) return
  // 拖动很快时会连续跨档：串行化，只保留最后一个落点。
  if (committing) {
    queuedTier = tier
    return
  }
  committing = true
  try {
    await applyTier(tier)
  } finally {
    committing = false
    const next = queuedTier
    queuedTier = null
    if (next && next !== models.selection?.effortTier && available.value.has(next)) void commit(next)
  }
}

/** 打开时对齐当前档；选择被回滚时（set-model 失败）也跟着回到真实档位。 */
watch(
  () => ui.effortSheetOpen,
  (open) => {
    if (!open) return
    activePointerId = null
    dragging.value = false
    draft.value = selectionIndex.value
  },
  { immediate: true },
)
watch(selectionIndex, (index) => {
  if (!dragging.value) draft.value = index
})

function percent(index: number): string {
  return `${(index / Math.max(1, lastIndex)) * 100}%`
}

function close(): void {
  ui.closeEffortSheet()
}
</script>

<template>
  <BottomSheet :open="ui.effortSheetOpen" label="调整思考程度" @close="close">
    <p class="sheet__title">思考程度</p>

    <div class="effort__head">
      <span class="effort__now">{{ draftLevel.label }}</span>
      <span class="effort__now-en">{{ draftShort }}</span>
      <span class="effort__desc">{{ hint }}</span>
    </div>

    <div
      class="effort__slider"
      :class="{ 'is-disabled': !supports }"
      role="slider"
      tabindex="0"
      aria-label="思考程度"
      :aria-valuemin="1"
      :aria-valuemax="levels.length"
      :aria-valuenow="draft + 1"
      :aria-valuetext="`${draftLevel.label}（${draftShort}）`"
      :aria-disabled="!supports"
      @pointerdown.prevent="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @keydown="onKeydown"
    >
      <div ref="trackEl" class="effort__rail">
        <div class="effort__rail-bg" />
        <div class="effort__rail-fill" :style="{ width: percent(draft) }" />
        <span
          v-for="(level, index) in levels"
          :key="level.id"
          class="effort__tick"
          :class="{
            'is-passed': index <= draft,
            'is-active': index === draft,
            'is-disabled': !available.has(level.id),
          }"
          :style="{ left: percent(index) }"
          aria-hidden="true"
        />
        <div
          class="effort__thumb"
          :class="{ 'is-dragging': dragging }"
          :style="{ left: percent(draft) }"
          aria-hidden="true"
        />
      </div>
    </div>

    <div class="effort__labels">
      <button
        v-for="(level, index) in levels"
        :key="level.id"
        class="effort__label"
        :class="{ 'is-active': index === draft, 'is-disabled': !available.has(level.id) }"
        type="button"
        :disabled="!available.has(level.id)"
        :data-tier="level.id"
        :aria-pressed="index === draft"
        :aria-label="`思考程度 ${level.label}（${EFFORT_SHORT_LABELS[level.id]}）`"
        @click="pickIndex(index)"
      >
        <span class="effort__label-cn">{{ level.label }}</span>
        <span class="effort__label-en">{{ EFFORT_SHORT_LABELS[level.id] }}</span>
      </button>
    </div>

    <p v-if="!supports" class="sheet__note">当前模型不支持调节思考程度，换一个支持思考的模型后再试。</p>
  </BottomSheet>
</template>

<style scoped>
/* 只有「当前模型不支持调节思考程度」这一句状态提示（0.4.5 去掉了解释性脚注） */
.sheet__note {
  margin: 10px 6px 2px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}
.effort__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 0 6px;
}
.effort__now {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.25;
}
.effort__now-en {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-ink);
  letter-spacing: 0.02em;
}
.effort__desc {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
  min-width: 0;
}

/* 拖动区：整个横向条都是热区，纵向给到 44px 触控高度 */
.effort__slider {
  position: relative;
  height: 44px;
  margin: 4px 0 0;
  border-radius: 12px;
  outline: none;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  cursor: pointer;
}
.effort__slider:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.effort__slider.is-disabled {
  cursor: default;
  opacity: 0.55;
}

/* 四个停靠点在 x = 12.5% / 37.5% / 62.5% / 87.5%，
   与下面四等分的刻度标签中心对齐。 */
.effort__rail {
  position: absolute;
  left: 12.5%;
  right: 12.5%;
  top: 50%;
  height: 6px;
  transform: translateY(-50%);
}
.effort__rail-bg {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--surface-3);
}
.effort__rail-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.12s ease;
}
.effort__tick {
  position: absolute;
  top: 50%;
  width: 7px;
  height: 7px;
  margin: -3.5px 0 0 -3.5px;
  border-radius: 50%;
  background: var(--bg-elev);
  border: 1.5px solid var(--border-strong);
  box-sizing: border-box;
}
.effort__tick.is-passed {
  background: var(--accent);
  border-color: var(--accent);
}
.effort__tick.is-disabled {
  background: var(--surface-2);
  border-color: var(--border);
  opacity: 0.6;
}
.effort__thumb {
  position: absolute;
  top: 50%;
  width: 26px;
  height: 26px;
  margin: -13px 0 0 -13px;
  border-radius: 50%;
  background: var(--bg-elev);
  border: 2px solid var(--accent);
  box-shadow: 0 2px 8px rgba(20, 18, 12, 0.16);
  transition: left 0.12s ease, transform 0.12s ease;
}
.effort__thumb.is-dragging {
  transition: none;
  transform: scale(1.06);
}

/* 刻度标签：四等分，中心对着上面的停靠点 */
.effort__labels {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin: 0 0 2px;
}
.effort__label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 0;
  padding: 6px 0 8px;
  border-radius: 10px;
  color: var(--text-2);
  transition: background-color 0.14s ease, color 0.14s ease;
}
.effort__label:active {
  background: var(--surface-2);
}
.effort__label.is-active {
  color: var(--accent-ink);
  font-weight: 600;
}
.effort__label.is-disabled {
  color: var(--text-3);
  opacity: 0.5;
}
.effort__label-cn {
  font-size: 12.5px;
  line-height: 1.3;
  white-space: nowrap;
}
.effort__label-en {
  font-size: 10.5px;
  line-height: 1.3;
  color: var(--text-3);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.effort__label.is-active .effort__label-en {
  color: var(--accent-ink);
}
</style>
