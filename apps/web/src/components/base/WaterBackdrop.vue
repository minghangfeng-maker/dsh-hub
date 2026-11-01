<script setup lang="ts">
import { ref } from 'vue'

import { useWaterRipples } from '@/composables/useWaterRipples'

/**
 * 水波纹背景（07 §2.5）。
 *
 * - `full`（登录/注册/唤醒页）：柔光 + 两处同心涟漪环 + 三层波浪 + 画布涟漪（鼠标划过 / 点击 / 偶尔落一滴雨）；
 * - `calm`（用户端工作台）：只有底部两层很淡的波浪，固定在视口底部，不抢内容的戏，也没有指针交互。
 *
 * 纯装饰：`aria-hidden`、`pointer-events: none`；颜色全部来自令牌（motion.css 里的 --c-wave-* / --c-ripple），
 * 减少动态效果时由 motion.css 关掉所有动画（波浪停在静态位置），画布涟漪由 composable 整体不启用。
 */
const props = withDefaults(defineProps<{ variant?: 'full' | 'calm' }>(), { variant: 'full' })

/**
 * 三层波浪的路径：viewBox 宽 2880 = 两个 1440 周期，CSS 平移 -50% 即无缝循环。
 * 三层的振幅与相位不同，叠起来才有水面的层次。
 */
const WAVES = [
  {
    layer: 'back',
    d: 'M0 110 c240 -80 480 -80 720 0 s480 80 720 0 s480 -80 720 0 s480 80 720 0 V220 H0 Z',
  },
  {
    layer: 'mid',
    d: 'M0 100 c240 60 480 60 720 0 s480 -60 720 0 s480 60 720 0 s480 -60 720 0 V220 H0 Z',
  },
  {
    layer: 'front',
    d: 'M0 90 c180 -40 540 -40 720 0 s540 40 720 0 s540 -40 720 0 s540 40 720 0 V220 H0 Z',
  },
] as const

/** calm 只留最后面和最前面两层 */
const visibleWaves = props.variant === 'calm' ? WAVES.filter((wave) => wave.layer !== 'mid') : WAVES

const RING_SOURCES = [
  { left: '16%', top: '66%', size: '600px' },
  { left: '82%', top: '24%', size: '480px' },
] as const

const canvas = ref<HTMLCanvasElement | null>(null)
if (props.variant === 'full') useWaterRipples(canvas)
</script>

<template>
  <div class="water-backdrop" :class="`water-backdrop--${variant}`" aria-hidden="true">
    <template v-if="variant === 'full'">
      <span
        class="water-glow water-glow--primary"
        :style="{ top: '-140px', left: '-100px', width: '460px', height: '460px' }"
      />
      <span
        class="water-glow water-glow--sky"
        :style="{ top: '30%', right: '-140px', width: '520px', height: '520px' }"
      />

      <span
        v-for="source in RING_SOURCES"
        :key="source.left"
        class="ripple-source"
        :style="{ left: source.left, top: source.top, '--ripple-size': source.size }"
      >
        <span v-for="ring in 3" :key="ring" class="ripple-ring" :style="{ '--ring': ring - 1 }" />
      </span>
    </template>

    <div
      v-for="wave in visibleWaves"
      :key="wave.layer"
      class="water-wave"
      :class="`water-wave--${wave.layer}`"
    >
      <svg class="water-wave__svg" viewBox="0 0 2880 220" preserveAspectRatio="none" focusable="false">
        <path :d="wave.d" />
      </svg>
    </div>

    <canvas v-if="variant === 'full'" ref="canvas" class="water-backdrop__canvas" />
  </div>
</template>

<style scoped>
.water-backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 工作台：固定在视口底部，内容滚动时水面不动；z-index 0，内容区自行 z-index: 1 盖在上面 */
.water-backdrop--calm {
  position: fixed;
  z-index: 0;
  opacity: 0.85;
}

.water-backdrop__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
