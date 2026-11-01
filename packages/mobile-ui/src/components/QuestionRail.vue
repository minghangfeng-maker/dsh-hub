<script setup lang="ts">
/**
 * 问题导航条（0.4.0 §4）：对话区右侧的竖向细轨，每个用户提问一个圆点。
 *
 * 出现条件：已加载的用户消息 ≥ 3 条（由对话页决定是否挂载）。
 * - 用户手动滚动时淡入（复用对话页的 `interacting` 与自己的 scroll 监听），停手 1.5s 后淡出；
 *   手指按在轨道上时保持显示（§4.1）；
 * - 轨道宽 3px、上下各留 12px、高度 = 对话区可视高度；圆点 6px，当前视口里的点放大并高亮；
 * - 热区左右各扩 14px（总宽约 31px），隐藏时不拦截滚动（pointer-events: none）；
 * - 按住上下拖动：吸附最近的提问点，左侧弹出简述气泡（前 20 字，单行省略），
 *   吸附目标变化时轻触感；松手平滑滚到该提问，让用户消息顶部位于对话区顶部下方 12px；
 * - `historyHasMore` 时轨道顶端显示「⋯」，点它加载更早的消息；
 * - 位置只在 `inner` 高度变化时重算并缓存（ResizeObserver），滚动只做算术，不遍历 DOM（§4.2）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { hapticTap } from '@/lib/platform'
import {
  RAIL_FADE_MS,
  RAIL_PAD,
  marksInView,
  railLabel,
  railOffsets,
  railTrackHeight,
  snapIndex,
} from '@/lib/question-rail'

const props = defineProps<{
  /** 对话区滚动容器（`.thread`）。 */
  scroller?: HTMLElement | null
  /** 用户提问列表：key 与消息 DOM 的 `data-user-msg-key` 一致。 */
  marks: { key: string; text: string }[]
  hasMore?: boolean
  /** 对话页的 `userInteracting`：用户正在滚动手势里。 */
  interacting?: boolean
}>()

const emit = defineEmits<{ jump: [key: string]; loadOlder: [] }>()

const visible = ref(false)
const pressed = ref(false)
const dragIndex = ref(-1)
const bubbleIndex = ref(-1)

const offsets = ref<number[]>([])
const heights = ref<number[]>([])
const scrollTop = ref(0)
const scrollHeight = ref(0)
const viewportHeight = ref(0)
const viewport = ref(0)

const labels = computed(() => props.marks.map((mark) => railLabel(mark.text)))
const trackHeight = computed(() => railTrackHeight(viewportHeight.value))
const positions = computed(() => railOffsets(offsets.value, scrollHeight.value, trackHeight.value))
const inViewSet = computed(
  () => new Set(marksInView(offsets.value, heights.value, scrollTop.value, viewport.value)),
)
const bubbleTop = computed(() => {
  const index = bubbleIndex.value
  if (index < 0) return 0
  return RAIL_PAD + (positions.value[index] ?? 0)
})

let hideTimer: ReturnType<typeof setTimeout> | null = null
let scrollRaf = 0
let resizeObserver: ResizeObserver | null = null

function clearHideTimer(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

function scheduleHide(): void {
  clearHideTimer()
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (!pressed.value) visible.value = false
  }, RAIL_FADE_MS)
}

function reveal(): void {
  visible.value = true
  scheduleHide()
}

/** 位置只在布局变化时重算（滚动时只更新 scrollTop，不量 DOM）。 */
function measure(): void {
  const scroller = props.scroller
  if (!scroller) return
  // 内容坐标系的原点：容器顶部减去已滚动的高度
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop
  const nodes = Array.from(scroller.querySelectorAll<HTMLElement>('[data-user-msg-key]'))
  const byKey = new Map<string, HTMLElement>()
  for (const node of nodes) {
    const key = node.dataset.userMsgKey
    if (key !== undefined) byKey.set(key, node)
  }
  const nextOffsets: number[] = []
  const nextHeights: number[] = []
  for (const mark of props.marks) {
    const node = byKey.get(mark.key)
    if (node === undefined) {
      nextOffsets.push(0)
      nextHeights.push(1)
      continue
    }
    const rect = node.getBoundingClientRect()
    nextOffsets.push(Math.max(0, rect.top - origin))
    nextHeights.push(Math.max(1, rect.height))
  }
  offsets.value = nextOffsets
  heights.value = nextHeights
  scrollHeight.value = Math.max(1, scroller.scrollHeight)
  viewportHeight.value = scroller.clientHeight
  viewport.value = scroller.clientHeight
  scrollTop.value = scroller.scrollTop
}

function onScroll(): void {
  if (scrollRaf !== 0) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const scroller = props.scroller
    if (!scroller) return
    scrollTop.value = scroller.scrollTop
  })
  // 只有「用户自己在滚」才淡入：打开会话时的吸底滚动、程序跳转不弹出来（§4.1）
  if (props.interacting) reveal()
}

function detach(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  const scroller = props.scroller
  if (scroller) {
    scroller.removeEventListener('scroll', onScroll)
  }
  if (scrollRaf !== 0) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = 0
  }
}

function attach(): void {
  detach()
  const scroller = props.scroller
  if (!scroller) return
  scroller.addEventListener('scroll', onScroll, { passive: true })
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(scroller)
    const inner = scroller.firstElementChild
    if (inner instanceof HTMLElement) resizeObserver.observe(inner)
  }
  measure()
}

onMounted(attach)
onBeforeUnmount(() => {
  detach()
  clearHideTimer()
})
watch(() => props.scroller, attach)
watch(
  () => props.marks,
  () => measure(),
  { deep: true },
)
watch(
  () => props.interacting,
  (interacting) => {
    if (interacting) reveal()
  },
)

/** 指针纵坐标 → 轨道坐标（夹在 [0, trackHeight]）。 */
function railY(event: PointerEvent): number {
  const el = event.currentTarget
  if (!(el instanceof HTMLElement)) return 0
  const rect = el.getBoundingClientRect()
  const y = event.clientY - rect.top - RAIL_PAD
  return Math.min(trackHeight.value, Math.max(0, y))
}

function updateDrag(event: PointerEvent): void {
  if (positions.value.length === 0) return
  const index = snapIndex(positions.value, railY(event), dragIndex.value)
  if (index < 0) return
  if (index !== dragIndex.value) {
    dragIndex.value = index
    void hapticTap()
  }
  bubbleIndex.value = index
}

function onPointerDown(event: PointerEvent): void {
  if (props.marks.length === 0) return
  pressed.value = true
  visible.value = true
  clearHideTimer()
  const target = event.currentTarget
  if (target instanceof HTMLElement) {
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      /* 无指针捕获也能用 */
    }
  }
  updateDrag(event)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!pressed.value) return
  updateDrag(event)
}

function onPointerUp(): void {
  if (!pressed.value) return
  pressed.value = false
  const index = dragIndex.value
  dragIndex.value = -1
  bubbleIndex.value = -1
  const mark = props.marks[index]
  if (mark !== undefined) emit('jump', mark.key)
  scheduleHide()
}

/** 键盘（Enter/空格触发的 click 没有 pointer 过程）也能跳转；鼠标点击已由指针路径处理。 */
function onDotClick(event: MouseEvent, index: number): void {
  if (event.detail !== 0) return
  const mark = props.marks[index]
  if (mark !== undefined) emit('jump', mark.key)
}
</script>

<template>
  <nav
    class="rail"
    :class="{ 'rail--visible': visible, 'rail--dragging': pressed }"
    role="navigation"
    aria-label="提问导航"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <button
      v-if="hasMore"
      class="rail__more"
      type="button"
      aria-label="加载更早的消息"
      @pointerdown.stop
      @click="emit('loadOlder')"
    >
      <AppIcon name="more" :size="12" />
    </button>

    <span class="rail__track" aria-hidden="true" />

    <button
      v-for="(mark, index) in marks"
      :key="mark.key"
      class="rail__dot"
      :class="{
        'rail__dot--seen': inViewSet.has(index),
        'rail__dot--active': index === dragIndex,
      }"
      :style="{ top: `${RAIL_PAD + (positions[index] ?? 0)}px` }"
      type="button"
      :aria-label="labels[index]"
      :data-rail-index="index"
      @click="onDotClick($event, index)"
    />

    <span v-if="bubbleIndex >= 0" class="rail__bubble" :style="{ top: `${bubbleTop}px` }">
      {{ labels[bubbleIndex] }}
    </span>
  </nav>
</template>

<style scoped>
.rail {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  /* 热区：轨道 3px + 左右各 14px（§4.2）；不影响正文滑动是在隐藏时 pointer-events: none */
  width: 31px;
  z-index: 11;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  transition: opacity 0.24s ease;
  -webkit-user-select: none;
  user-select: none;
}
.rail--visible {
  opacity: 1;
  pointer-events: auto;
}
.rail--dragging {
  transition: none;
}
.rail__track {
  position: absolute;
  top: 12px;
  bottom: 12px;
  right: 14px;
  width: 3px;
  border-radius: 999px;
  background: var(--text-3);
  opacity: 0.3;
}
.rail__dot {
  position: absolute;
  right: 12.5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  opacity: 0.75;
  transform: translateY(-50%);
  transition: transform 0.14s ease, background-color 0.14s ease, opacity 0.14s ease;
}
.rail__dot--seen {
  background: var(--accent);
  opacity: 1;
  transform: translateY(-50%) scale(1.5);
}
.rail__dot--active {
  background: var(--accent);
  opacity: 1;
  transform: translateY(-50%) scale(1.8);
}
.rail__dot::before {
  /* 圆点本身 6px，热区由轨道容器负责；这里给个小外扩方便点中 */
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
}
.rail__more {
  position: absolute;
  top: 0;
  right: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 14px;
  color: var(--text-3);
  opacity: 0.7;
}
.rail__bubble {
  position: absolute;
  right: 34px;
  transform: translateY(-50%);
  max-width: 60vw;
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
</style>
