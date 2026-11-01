<script setup lang="ts">
/**
 * 右侧全屏面板容器（0.4.0 §1.3）：从右向左滑入、占满全屏，← 返回关闭。
 *
 * 内容由调用方塞进默认插槽（Token 用量 / 连接诊断）。关闭方式三种：
 *   - 顶部 ← 返回；
 *   - Android 返回键（`ui.consumeOverlay()` 的这一层）；
 *   - 在面板上向右滑（左边缘不算，避免和系统返回手势打架）。
 *
 * 滑入用 transform（220ms / ease-out），只动合成层，不触发重排。
 */
import { onBeforeUnmount, ref } from 'vue'
import AppIcon from './AppIcon.vue'

defineProps<{
  open: boolean
  /** 面板标题（也是 role=dialog 的 aria-label）。 */
  title: string
}>()

const emit = defineEmits<{ close: [] }>()

/** 右滑超过这个距离（CSS px）算关闭，否则回弹。 */
const CLOSE_DX = 90

const panelEl = ref<HTMLElement | null>(null)
let startX = 0
let startY = 0
let dx = 0
let dragging = false
let closing = false
let closeTimer: ReturnType<typeof setTimeout> | null = null
let resetTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  if (resetTimer !== null) {
    clearTimeout(resetTimer)
    resetTimer = null
  }
}

function onTouchStart(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch) return
  clearTimers()
  startX = touch.clientX
  startY = touch.clientY
  dx = 0
  dragging = false
  closing = false
}

function onTouchMove(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch || closing) return
  const moveX = touch.clientX - startX
  const moveY = touch.clientY - startY
  if (!dragging) {
    // 竖向为主 = 在滚内容；向左拖 = 不处理（面板已经贴右边）。
    if (Math.abs(moveX) <= Math.abs(moveY)) return
    if (moveX <= 0) return
    dragging = true
    if (panelEl.value) panelEl.value.style.transition = 'none'
  }
  event.preventDefault()
  dx = Math.max(0, moveX)
  if (panelEl.value) panelEl.value.style.transform = `translateX(${dx}px)`
}

function onTouchEnd(): void {
  const el = panelEl.value
  if (!dragging) {
    dx = 0
    return
  }
  dragging = false
  const shouldClose = dx > CLOSE_DX
  dx = 0
  if (!el) return
  el.style.transition = 'transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)'
  if (shouldClose) {
    closing = true
    el.style.transform = 'translateX(100%)'
    // 先滑出去再真正关闭：否则离场动画会从 0 重放，看起来像「弹回来又飞走」。
    closeTimer = setTimeout(() => {
      closeTimer = null
      emit('close')
    }, 200)
    return
  }
  el.style.transform = 'translateX(0)'
  resetTimer = setTimeout(() => {
    resetTimer = null
    el.style.transition = ''
    el.style.transform = ''
  }, 220)
}

onBeforeUnmount(clearTimers)
</script>

<template>
  <Transition name="panel-slide">
    <aside
      v-if="open"
      ref="panelEl"
      class="side-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      data-panel="side"
      @touchstart.passive="onTouchStart"
      @touchmove="onTouchMove"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchEnd"
    >
      <header class="side-panel__head">
        <button class="icon-btn side-panel__back" type="button" aria-label="返回" @click="emit('close')">
          <AppIcon name="arrowLeft" :size="24" />
        </button>
        <h2 class="side-panel__title">{{ title }}</h2>
      </header>
      <div class="side-panel__body">
        <slot />
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.side-panel {
  position: fixed;
  inset: 0;
  z-index: 58;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  /* 横向手势自己处理（右滑关闭），竖向交给内容滚动 */
  touch-action: pan-y;
  will-change: transform;
}
/* 220ms / ease-out：从右向左滑入（§1.3） */
.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
}

.side-panel__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: calc(var(--safe-top) + 4px) 8px 4px;
  background: var(--bg);
}
.side-panel__back {
  /* 与顶栏一致的热区 44×44（§1.1）；图标仍画 24px */
  margin-left: -8px;
  width: 44px;
  height: 44px;
  color: var(--text);
}
.side-panel__title {
  margin: 0;
  font-size: 16.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}
.side-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 4px 18px calc(24px + var(--safe-bottom));
}
</style>
