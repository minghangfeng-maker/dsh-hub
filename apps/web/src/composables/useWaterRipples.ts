import { useEventListener } from '@vueuse/core'
import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'

/**
 * 画布涟漪（07 §2.5「水波纹」）：鼠标划过 / 点击 / 偶尔的「雨滴」在背景上荡开一圈圈水纹。
 *
 * 动画数学（纯函数）和副作用（rAF、指针事件、画布）分开：前者在 test/water-ripples.test.ts 里直接测，
 * 后者由 `useWaterRipples` 管理，并且只在有涟漪存活时才跑 rAF（空闲时零开销）。
 * 减少动态效果下完全不启用（07 §2.5、10 §H2）。
 */

export type RippleKind = 'drop' | 'move' | 'touch'

export interface Ripple {
  x: number
  y: number
  /** 诞生时间（performance.now 毫秒） */
  born: number
  /** 存活毫秒数 */
  life: number
  maxRadius: number
  /** 同心环数量 */
  rings: number
  /** 整体透明度系数 */
  strength: number
}

export interface RingShape {
  radius: number
  alpha: number
  lineWidth: number
}

const KIND_PRESET: Record<RippleKind, Omit<Ripple, 'x' | 'y' | 'born'>> = {
  /** 偶发「雨滴」：中等、慢 */
  drop: { life: 2800, maxRadius: 170, rings: 3, strength: 0.5 },
  /** 鼠标划过：小、快、淡 */
  move: { life: 1500, maxRadius: 84, rings: 2, strength: 0.38 },
  /** 点击 / 触摸：大、明显 */
  touch: { life: 2400, maxRadius: 240, rings: 3, strength: 0.7 },
}

/** 每一圈相对上一圈延后的进度（让同心环错开） */
const RING_STAGGER = 0.16

export function createRipple(kind: RippleKind, x: number, y: number, now: number): Ripple {
  return { x, y, born: now, ...KIND_PRESET[kind] }
}

export function rippleProgress(ripple: Ripple, now: number): number {
  return Math.min(1, Math.max(0, (now - ripple.born) / ripple.life))
}

export function isRippleDone(ripple: Ripple, now: number): boolean {
  return now - ripple.born >= ripple.life
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

/** 某一时刻这个涟漪的每一圈：半径向外扩散，透明度与线宽随之衰减。 */
export function ringsOf(ripple: Ripple, now: number): RingShape[] {
  const progress = rippleProgress(ripple, now)
  const shapes: RingShape[] = []

  for (let index = 0; index < ripple.rings; index += 1) {
    const start = index * RING_STAGGER
    const t = Math.min(1, Math.max(0, (progress - start) / (1 - start)))
    if (t <= 0 || t >= 1) continue

    shapes.push({
      radius: ripple.maxRadius * easeOutCubic(t) * (1 - index * 0.12),
      alpha: ripple.strength * (1 - t) ** 1.6,
      lineWidth: 2.2 - 1.4 * t,
    })
  }

  return shapes
}

/** 画一帧：调用方负责先清屏并设好 DPR 缩放。颜色来自 CSS 变量的计算值，不在代码里写死。 */
export function drawRipples(
  ctx: CanvasRenderingContext2D,
  ripples: readonly Ripple[],
  now: number,
  color: string,
): void {
  ctx.strokeStyle = color

  for (const ripple of ripples) {
    for (const ring of ringsOf(ripple, now)) {
      ctx.globalAlpha = ring.alpha
      ctx.lineWidth = ring.lineWidth
      ctx.beginPath()
      ctx.arc(ripple.x, ripple.y, ring.radius, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  ctx.globalAlpha = 1
}

export interface WaterRipplesOptions {
  /** 是否偶尔自己落一滴「雨」（默认 true） */
  ambient?: boolean
  /** 同时存活的涟漪上限，防止疯狂划鼠标时堆积 */
  maxRipples?: number
}

const MOVE_MIN_DISTANCE = 30
const MOVE_MIN_INTERVAL = 110
const AMBIENT_MIN_DELAY = 2200
const AMBIENT_MAX_DELAY = 4400

export function useWaterRipples(
  canvas: Ref<HTMLCanvasElement | null>,
  options: WaterRipplesOptions = {},
): void {
  const { ambient = true, maxRipples = 18 } = options
  const reduced = usePrefersReducedMotion()

  const ripples: Ripple[] = []
  let ctx: CanvasRenderingContext2D | null = null
  let color = ''
  let frame = 0
  let ambientTimer = 0
  let width = 0
  let height = 0
  let lastMove = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, at: 0 }
  let resizeObserver: ResizeObserver | null = null

  function resize(): void {
    const el = canvas.value
    if (!el || !ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    width = el.clientWidth
    height = el.clientHeight
    el.width = Math.round(width * dpr)
    el.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function tick(now: number): void {
    frame = 0
    if (!ctx) return

    for (let index = ripples.length - 1; index >= 0; index -= 1) {
      const ripple = ripples[index]
      if (ripple && isRippleDone(ripple, now)) ripples.splice(index, 1)
    }

    ctx.clearRect(0, 0, width, height)
    drawRipples(ctx, ripples, now, color)

    // 只在还有涟漪时继续排下一帧；空了就彻底停下
    if (ripples.length > 0) frame = requestAnimationFrame(tick)
  }

  function spawn(kind: RippleKind, x: number, y: number): void {
    if (!ctx) return

    ripples.push(createRipple(kind, x, y, performance.now()))
    if (ripples.length > maxRipples) ripples.shift()
    if (frame === 0) frame = requestAnimationFrame(tick)
  }

  function toLocal(event: PointerEvent): { x: number; y: number } | null {
    const el = canvas.value
    if (!el) return null

    const rect = el.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    // 指针在画布范围外就不落涟漪
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null
    return { x, y }
  }

  function onPointerDown(event: PointerEvent): void {
    const point = toLocal(event)
    if (point) spawn('touch', point.x, point.y)
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'touch') return

    const now = performance.now()
    if (now - lastMove.at < MOVE_MIN_INTERVAL) return

    const point = toLocal(event)
    if (!point) return
    if (Math.hypot(point.x - lastMove.x, point.y - lastMove.y) < MOVE_MIN_DISTANCE) return

    lastMove = { ...point, at: now }
    spawn('move', point.x, point.y)
  }

  function scheduleAmbient(): void {
    const delay = AMBIENT_MIN_DELAY + Math.random() * (AMBIENT_MAX_DELAY - AMBIENT_MIN_DELAY)

    ambientTimer = window.setTimeout(() => {
      if (document.visibilityState === 'visible' && width > 0) {
        spawn('drop', width * (0.08 + Math.random() * 0.84), height * (0.12 + Math.random() * 0.76))
      }
      scheduleAmbient()
    }, delay)
  }

  function stop(): void {
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    window.clearTimeout(ambientTimer)
    ripples.length = 0
    resizeObserver?.disconnect()
    resizeObserver = null
    ctx?.clearRect(0, 0, width, height)
    ctx = null
  }

  function start(): void {
    const el = canvas.value
    // jsdom 等没有 2D 画布的环境拿到 null，直接不启用
    ctx = el?.getContext('2d') ?? null
    if (!el || !ctx) return

    color = getComputedStyle(el).getPropertyValue('--c-primary').trim() || 'currentColor'
    resize()
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(el)
    if (ambient) scheduleAmbient()
  }

  useEventListener(window, 'pointerdown', onPointerDown, { passive: true })
  useEventListener(window, 'pointermove', onPointerMove, { passive: true })

  onMounted(() => {
    if (!reduced.value) start()
  })

  // 系统偏好中途改变也要跟上
  watch(reduced, (value) => {
    if (value) stop()
    else if (!ctx) start()
  })

  onBeforeUnmount(stop)
}
