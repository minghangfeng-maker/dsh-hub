<script setup lang="ts">
import { computed } from 'vue'

import type { CanvasItem } from '@/api/admin-cockpit'
import MiniTag from '@/components/admin/MiniTag.vue'
import { SPEC_KIND_TEXT, canvasDataBadge, sizeClassOf } from '@/utils/cockpit'

/**
 * 画布卡片外壳（docs/24 §1）：标题、数据角标、卡片操作（钉住 / 关闭 / 问 DSH）。
 *
 * - 「Hub 数据」= 用管理员身份重查的数；「DSH 计算」= DSH 自己算的数（§0 第 2 条：数字要可核对）；
 * - 钉住 / 关闭只对 DSH 生成的卡开放：Hub 生成的卡（方案卡、密钥卡、默认态势卡）由 Hub 管理生命周期；
 * - `placement` / `size` 来自契约（舷位与高度档位）；`emphasis` / `arriving` 只影响动效：
 *   入场的卡「从中控台边缘飞出」（§1 实时感），本回合的卡强调边框、旧卡余辉变暗。
 */
const props = withDefaults(
  defineProps<{
    item: CanvasItem
    /** 本回合强调档位 */
    emphasis?: 'current' | 'past' | 'idle'
    /** 刚由 SSE 投放进来（触发入场动效） */
    arriving?: boolean
    /** 显示「放大查看」按钮（AI 助手的窄事件栏用，docs/26） */
    expandable?: boolean
    /** 显示「钉到态势板」（态势板只在座舱里有；AI 助手页没有，传 false） */
    pinnable?: boolean
  }>(),
  { emphasis: 'idle', arriving: false, expandable: false, pinnable: true },
)

const emit = defineEmits<{
  pin: [item: CanvasItem]
  close: [item: CanvasItem]
  ask: [text: string]
  expand: [item: CanvasItem]
}>()

const badge = computed(() => canvasDataBadge(props.item.spec, props.item.origin))
const kindText = computed(() => SPEC_KIND_TEXT[props.item.spec.kind])
const manageable = computed(() => props.item.origin === 'dsh')
const classes = computed(() => [
  sizeClassOf(props.item.size),
  `canvas-card--${props.item.placement}`,
  props.emphasis === 'current' ? 'canvas-card--current' : '',
  props.emphasis === 'past' ? 'canvas-card--past' : '',
  props.arriving ? `canvas-card--arrive-${props.item.placement}` : '',
])
</script>

<template>
  <article
    class="canvas-card"
    :class="classes"
    :data-card-id="item.id"
    :data-card-kind="item.spec.kind"
    :data-card-placement="item.placement"
  >
    <header class="canvas-card__head">
      <h3 class="canvas-card__title" :title="item.title">{{ item.title }}</h3>

      <MiniTag v-if="badge === 'hub'" text="Hub 数据" tone="primary" size="sm" />
      <MiniTag v-else-if="badge === 'dsh'" text="DSH 计算" tone="butter" size="sm" />
      <span v-else class="canvas-card__kind">{{ kindText }}</span>

      <div class="canvas-card__actions">
        <button
          v-if="expandable"
          type="button"
          class="canvas-card__action press"
          aria-label="放大查看"
          title="放大查看"
          data-testid="canvas-card-expand"
          @click="emit('expand', item)"
        >
          <span class="i-ph-arrows-out" aria-hidden="true" />
        </button>

        <button
          v-if="manageable && pinnable"
          type="button"
          class="canvas-card__action press"
          :class="{ 'canvas-card__action--on': item.pinned }"
          :aria-pressed="item.pinned"
          :aria-label="item.pinned ? '取消钉住' : '钉到态势板'"
          :title="item.pinned ? '取消钉住' : '钉到态势板'"
          @click="emit('pin', item)"
        >
          <span :class="item.pinned ? 'i-ph-push-pin-fill' : 'i-ph-push-pin'" aria-hidden="true" />
        </button>

        <button
          type="button"
          class="canvas-card__action press"
          aria-label="问 DSH"
          title="问 DSH"
          @click="emit('ask', `关于画布上的「${item.title}」，`)"
        >
          <span class="i-ph-chat-circle-text" aria-hidden="true" />
        </button>

        <button
          v-if="manageable"
          type="button"
          class="canvas-card__action press"
          aria-label="关闭这张卡"
          title="关闭这张卡"
          @click="emit('close', item)"
        >
          <span class="i-ph-x" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="canvas-card__body">
      <slot />
    </div>
  </article>
</template>

<style scoped>
.canvas-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--b-panel, var(--c-surface));
  box-shadow: var(--shadow-card);
  transition:
    box-shadow var(--duration-base) var(--ease-out-soft),
    border-color var(--duration-base) var(--ease-out-soft),
    opacity var(--duration-base) var(--ease-out-soft);
}

.canvas-card:hover {
  box-shadow: var(--shadow-hover);
}

/* 四角刻度（HUD 角标）：舰桥面板的仪表感；颜色随回合强调变化 */
.canvas-card::after {
  --tick: var(--b-tick-dim, var(--c-border));
  --len: var(--b-tick-len, 9px);
  position: absolute;
  inset: -1px;
  background:
    linear-gradient(var(--tick) 0 0) top left / var(--len) 1px,
    linear-gradient(var(--tick) 0 0) top left / 1px var(--len),
    linear-gradient(var(--tick) 0 0) top right / var(--len) 1px,
    linear-gradient(var(--tick) 0 0) top right / 1px var(--len),
    linear-gradient(var(--tick) 0 0) bottom left / var(--len) 1px,
    linear-gradient(var(--tick) 0 0) bottom left / 1px var(--len),
    linear-gradient(var(--tick) 0 0) bottom right / var(--len) 1px,
    linear-gradient(var(--tick) 0 0) bottom right / 1px var(--len);
  background-repeat: no-repeat;
  content: '';
  pointer-events: none;
  transition: opacity var(--duration-base) var(--ease-out-soft);
}

.canvas-card:hover::after {
  --tick: var(--b-tick, var(--c-primary));
}

.canvas-card--s .canvas-card__body {
  padding-block: var(--space-2);
  font-size: var(--fs-12);
}

.canvas-card--l .canvas-card__body {
  min-height: 220px;
}

/* 本回合投放的卡：强调边框；更早的卡余辉变暗（docs/24 §1「实时感」） */
.canvas-card--current {
  border-color: var(--b-line-strong, var(--c-primary));
  box-shadow: var(--b-glow-current, var(--shadow-card));
}

.canvas-card--current::after {
  --tick: var(--b-tick, var(--c-primary));
}

/* 本回合的卡顶边亮一条青色刻线（像仪表刚刷新） */
.canvas-card--current::before {
  position: absolute;
  top: -1px;
  right: 18%;
  left: 18%;
  height: 1px;
  background: var(--b-horizon, var(--c-sky));
  content: '';
  pointer-events: none;
}

.canvas-card--past {
  opacity: 0.78;
}

.canvas-card--past:hover {
  opacity: 1;
}

/* 入场：从中控台那一侧「飞出」落位，落位后亮一次边框 */
.canvas-card--arrive-left {
  animation:
    bridge-fly-from-center-left var(--b-arrive-duration, 350ms) var(--ease-out-soft) both,
    bridge-land-flash 620ms ease-out 220ms;
}

.canvas-card--arrive-right {
  animation:
    bridge-fly-from-center-right var(--b-arrive-duration, 350ms) var(--ease-out-soft) both,
    bridge-land-flash 620ms ease-out 220ms;
}

@keyframes bridge-fly-from-center-left {
  0% {
    opacity: 0;
    filter: blur(3px);
    transform: translateX(104px) scale(0.94);
  }
  60% {
    opacity: 1;
    filter: blur(0);
  }
  100% {
    opacity: 1;
    filter: none;
    transform: translateX(0) scale(1);
  }
}

@keyframes bridge-fly-from-center-right {
  0% {
    opacity: 0;
    filter: blur(3px);
    transform: translateX(-104px) scale(0.94);
  }
  60% {
    opacity: 1;
    filter: blur(0);
  }
  100% {
    opacity: 1;
    filter: none;
    transform: translateX(0) scale(1);
  }
}

@keyframes bridge-land-flash {
  0% {
    box-shadow:
      0 0 0 1px var(--c-sky),
      0 0 28px var(--c-sky);
  }
  100% {
    box-shadow: var(--shadow-card);
  }
}

/* 减少动态效果：只淡入（≤120ms），不做位移与闪光 */
@media (prefers-reduced-motion: reduce) {
  .canvas-card,
  .canvas-card--arrive-left,
  .canvas-card--arrive-right {
    transition: opacity 120ms linear;
    animation: bridge-fade-in 120ms linear both;
  }
}

@keyframes bridge-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.canvas-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
}

.canvas-card__title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.01em;
  /* 卡片标题是标识性文字：单行省略，完整内容进 title（07 §2.8） */
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-card__kind {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.canvas-card__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

.canvas-card__action {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  font-size: 15px;
}

.canvas-card__action:hover,
.canvas-card__action:focus-visible {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.canvas-card__action--on {
  color: var(--c-primary-press);
}

.canvas-card__body {
  padding: var(--space-3) var(--space-4) var(--space-4);
}
</style>
