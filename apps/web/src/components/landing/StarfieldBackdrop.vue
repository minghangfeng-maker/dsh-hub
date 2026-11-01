<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 公开主页的背景（WP36，设计稿 `landing/mockup.html`）：中心淡蓝光晕 + 24 px 点阵网格 +
 * **星野** + 从下往上慢慢飘的星尘。
 *
 * 品牌换成「星座鲸」（夜空底上一头由星点连成的鲸鱼）之后，主页背景也跟着改成夜空的样子：
 * 原来那层 bit 化鲸鱼去掉了 —— 一是不再复刻旧图形，二是大面积的鲸鱼像素会和新 logo 抢眼。
 * 现在只有三样东西：疏密不均的星点（一小部分缓慢闪烁）、两处用细线连起来的「星座」、
 * 以及十几粒上浮的星尘。颜色全部从设计令牌读（画布不接受 CSS 变量），用 `globalAlpha`
 * 控制浓淡，既避免把色值写进组件，也省掉每帧拼字符串。
 *
 * 省电和以前一样：`prefers-reduced-motion` 只画静帧；页面不可见（visibilitychange）时停掉 rAF；
 * 窗口尺寸变化防抖 120 ms 后重算；星点数量按面积算（每 14000 px² 一颗），上限 160 颗。
 */

interface Star {
  x: number
  y: number
  /** 边长（px） */
  size: number
  /** 基础透明度（0–1） */
  alpha: number
  /** 闪烁相位（null = 不闪） */
  twinkle: number | null
  color: 'primary' | 'sky'
}

interface Mote {
  x0: number
  y: number
  size: number
  speed: number
  phase: number
  top: number
}

/** 一处星座：几颗星 + 把它们连起来的折线（坐标是视口比例，随窗口重算） */
interface Asterism {
  points: Array<{ x: number; y: number }>
}

const canvasRef = ref<HTMLCanvasElement | null>(null)

let teardown: (() => void) | null = null

onMounted(() => {
  const canvas = canvasRef.value
  const context = canvas?.getContext('2d')
  // jsdom 没有 2D 画布（测试里 getContext 返回 null）：静默跳过，页面其余部分照常可用
  if (!canvas || !context) return
  const el = canvas
  const ctx = context

  const primary = readToken('--c-primary')
  const sky = readToken('--c-sky')
  if (!primary || !sky) return

  const reduce =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /** 固定的伪随机：同一窗口尺寸下星图不跳，重算 resize 也不会「换一片天」 */
  let seed = 20261031
  function rand(): number {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  let width = 0
  let height = 0
  let stars: Star[] = []
  let asterisms: Asterism[] = []
  let motes: Mote[] = []
  let frameId = 0
  let resizeTimer: number | null = null

  function layout(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    width = window.innerWidth
    height = window.innerHeight
    el.width = Math.max(1, Math.round(width * dpr))
    el.height = Math.max(1, Math.round(height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    seed = 20261031
    const count = Math.min(160, Math.max(40, Math.round((width * height) / 14000)))
    stars = Array.from({ length: count }, () => {
      const roll = rand()
      return {
        x: Math.round(rand() * width),
        y: Math.round(rand() * height),
        // 大部分是 1–2 px 的小星，偶尔来一颗 3 px 的亮星
        size: roll > 0.94 ? 3 : roll > 0.7 ? 2 : 1,
        alpha: 0.16 + rand() * 0.3,
        twinkle: rand() < 0.1 ? rand() * Math.PI * 2 : null,
        color: rand() < 0.22 ? 'sky' : 'primary',
      }
    })

    // 两处「星座」：不闭合的折线 + 顶点各一颗亮一点的星（对称的规则多边形看着像几何图形，
    // 不像星图，所以点位是刻意错开的）
    asterisms = [
      {
        points: [
          { x: 0.11, y: 0.26 },
          { x: 0.155, y: 0.17 },
          { x: 0.235, y: 0.2 },
          { x: 0.205, y: 0.29 },
          { x: 0.275, y: 0.335 },
        ],
      },
      {
        points: [
          { x: 0.89, y: 0.21 },
          { x: 0.825, y: 0.275 },
          { x: 0.85, y: 0.375 },
          { x: 0.925, y: 0.33 },
        ],
      },
    ].map((item) => ({
      points: item.points.map((point) => ({ x: point.x * width, y: point.y * height })),
    }))

    motes = Array.from({ length: 14 }, () => spawnMote(true))
  }

  function spawnMote(scatter: boolean): Mote {
    const size = 1 + Math.random() * 1.6
    const top = -20
    return {
      x0: Math.random() * width,
      y: scatter ? Math.random() * height : top + Math.random() * 40,
      size,
      speed: 0.12 + Math.random() * 0.22,
      phase: Math.random() * 6,
      top,
    }
  }

  function draw(time: number): void {
    ctx.clearRect(0, 0, width, height)

    // 星座：先画细线，再在每一个节点上点一颗星
    ctx.strokeStyle = sky
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.22
    for (const asterism of asterisms) {
      ctx.beginPath()
      asterism.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.stroke()
    }
    // 顶点星：2 px、比背景星亮一档，让折线看起来是「连起来的星」而不是一根线
    ctx.fillStyle = primary
    ctx.globalAlpha = 0.4
    for (const asterism of asterisms) {
      for (const point of asterism.points) ctx.fillRect(point.x - 1, point.y - 1, 2, 2)
    }

    for (const star of stars) {
      const alpha =
        star.twinkle !== null && !reduce
          ? star.alpha + 0.18 * (0.5 + 0.5 * Math.sin(time / 1100 + star.twinkle))
          : star.alpha
      ctx.fillStyle = star.color === 'sky' ? sky : primary
      ctx.globalAlpha = alpha
      ctx.fillRect(star.x, star.y, star.size, star.size)
    }

    ctx.fillStyle = sky
    for (const mote of motes) {
      ctx.globalAlpha = 0.3 * Math.max(0, Math.min(1, (mote.y - mote.top) / height))
      // 落在偶数像素上：像素星尘不糊
      const x = Math.round((mote.x0 + Math.sin(mote.y / 42 + mote.phase) * 10) / 2) * 2
      ctx.fillRect(x, Math.round(mote.y), mote.size, mote.size)
      if (!reduce) {
        mote.y -= mote.speed
        if (mote.y < mote.top) Object.assign(mote, spawnMote(false))
      }
    }
    ctx.globalAlpha = 1
  }

  function loop(time: number): void {
    frameId = 0
    draw(time)
    if (!document.hidden) frameId = window.requestAnimationFrame(loop)
  }

  function start(): void {
    if (reduce) {
      draw(0)
      return
    }
    if (document.hidden || frameId !== 0) return
    frameId = window.requestAnimationFrame(loop)
  }

  function stop(): void {
    if (frameId === 0) return
    window.cancelAnimationFrame(frameId)
    frameId = 0
  }

  function onResize(): void {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null
      layout()
      if (reduce) draw(0)
    }, 120)
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      stop()
      return
    }
    // 后台期间可能改过窗口大小，回来先按当前视口重算
    layout()
    start()
  }

  layout()
  start()
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibilityChange)

  teardown = () => {
    stop()
    if (resizeTimer !== null) window.clearTimeout(resizeTimer)
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
})

onBeforeUnmount(() => {
  teardown?.()
  teardown = null
})

/** 画布不认 CSS 变量：把令牌值读出来再交给 canvas（空串 = 令牌没加载，放弃绘制） */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
</script>

<template>
  <div class="starfield" aria-hidden="true">
    <div class="starfield__glow" />
    <div class="starfield__grid" />
    <canvas ref="canvasRef" class="starfield__canvas" />
  </div>
</template>

<style scoped>
.starfield {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

.starfield__glow {
  position: absolute;
  top: 46%;
  left: 50%;
  width: 1100px;
  height: 640px;
  background: radial-gradient(
    ellipse at center,
    color-mix(in srgb, var(--c-primary) 10%, transparent),
    transparent 65%
  );
  transform: translate(-50%, -50%);
}

.starfield__grid {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(
    circle,
    color-mix(in srgb, var(--c-primary) 16%, transparent) 1px,
    transparent 1.2px
  );
  background-size: 24px 24px;
  -webkit-mask-image: radial-gradient(ellipse 75% 65% at 50% 45%, black 30%, transparent 78%);
  mask-image: radial-gradient(ellipse 75% 65% at 50% 45%, black 30%, transparent 78%);
}

.starfield__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
