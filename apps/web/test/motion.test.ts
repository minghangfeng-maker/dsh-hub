import { describe, expect, it } from 'vitest'

import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'
import motionCss from '@/styles/motion.css?raw'
import tokensCss from '@/styles/tokens.css?raw'

/**
 * 动效自查（07 §2.5、10 §H2）。
 * 这里检查 CSS 层面的「每一条动效都有实现、且都被 reduced-motion 关掉」。
 */
describe('styles/motion.css（07 §2.5 逐条）', () => {
  it('参数与文档一致（220 / 180 / 120 / 600 / 400 / 1400 / 2400ms，波浪 22–34s，涟漪 7s，列表间隔 30ms）', () => {
    expect(tokensCss).toContain('--duration-route: 220ms')
    expect(tokensCss).toContain('--duration-base: 180ms')
    expect(tokensCss).toContain('--duration-press: 120ms')
    expect(motionCss).toContain('--duration-count: 600ms')
    expect(motionCss).toContain('--duration-check: 400ms')
    expect(motionCss).toContain('--duration-skeleton: 1400ms')
    expect(motionCss).toContain('--duration-breathe: 2400ms')
    expect(motionCss).toContain('--duration-drift-slow: 26s')
    expect(motionCss).toContain('--duration-wave-front: 22s')
    expect(motionCss).toContain('--duration-wave-back: 34s')
    expect(motionCss).toContain('--duration-ripple: 7s')
    expect(motionCss).toContain('--stagger-step: 30ms')
    // 缓动曲线在 tokens.css 里（令牌唯一事实来源）
    expect(tokensCss).toContain('cubic-bezier(0.2, 0.8, 0.2, 1)')
  })

  it('路由过渡：淡入 + 上移 8px（.route-fade-*）', () => {
    expect(motionCss).toContain('.route-fade-enter-active')
    expect(motionCss).toContain('.route-fade-enter-from')
    expect(motionCss).toMatch(/\.route-fade-enter-from,[\s\S]*?transform: translateY\(8px\)/)
  })

  it('卡片悬浮 / 按钮按下 / 列表逐项淡入', () => {
    expect(motionCss).toContain('.lift:hover')
    expect(motionCss).toContain('.press:active')
    expect(motionCss).toContain('.stagger-item')
    expect(motionCss).toContain('.list-enter-active')
    // 最多前 10 项（min(var(--stagger, 0), 9)）
    expect(motionCss).toContain('min(var(--stagger, 0), 9)')
  })

  it('水波纹背景：波浪平移 + 上下轻晃、涟漪环扩散、柔光漂移，三层波浪各有速度', () => {
    for (const keyframes of [
      '@keyframes wave-slide',
      '@keyframes wave-bob',
      '@keyframes ripple-expand',
      '@keyframes glow-float',
    ]) {
      expect(motionCss, `缺少 ${keyframes}`).toContain(keyframes)
    }
    for (const className of [
      '.water-wave--back',
      '.water-wave--mid',
      '.water-wave--front',
      '.ripple-ring',
      '.water-glow',
    ]) {
      expect(motionCss, `缺少 ${className}`).toContain(className)
    }
    // 波浪无缝循环：svg 宽 200%，平移 -50%
    expect(motionCss).toMatch(/\.water-wave__svg \{[\s\S]*?width: 200%/)
    expect(motionCss).toMatch(/@keyframes wave-slide \{[\s\S]*?translate3d\(-50%, 0, 0\)/)
    // 同心三圈靠负延迟错开，页面一打开就在扩散中
    expect(motionCss).toContain('var(--duration-ripple) / -3')
  })

  it('实例运行中状态点涟漪扩散（--breathe-color）/ 启动中旋转细环', () => {
    expect(motionCss).toContain('@keyframes breathe')
    expect(motionCss).toContain('--breathe-color')
    expect(motionCss).toContain('.breathe')
    expect(motionCss).toContain('@keyframes ring-spin')
    expect(motionCss).toContain('.ring-spin')
  })

  it('勾号描边（stroke-dashoffset）与骨架屏流光', () => {
    expect(motionCss).toContain('.check-circle')
    expect(motionCss).toContain('.check-path')
    expect(motionCss).toContain('stroke-dashoffset')
    expect(motionCss).toContain('@keyframes check-draw')
    expect(motionCss).toContain('.skeleton::after')
    expect(motionCss).toContain('@keyframes skeleton-shimmer')
  })

  it('插画动效四件套（摇摆 / 呼吸 / 漂浮 / 探头）', () => {
    for (const className of ['.ill-sway', '.ill-sleep', '.ill-float', '.ill-peek']) {
      expect(motionCss, `缺少 ${className}`).toContain(className)
    }
  })

  it('prefers-reduced-motion: reduce 时关掉水波、涟漪、呼吸、旋转、摇摆与流光', () => {
    const reducedBlock = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedBlock.length).toBeGreaterThan(0)

    for (const className of [
      '.water-glow',
      '.water-wave',
      '.water-wave__svg',
      '.ripple-ring',
      '.breathe',
      '.ring-spin',
      '.ill-sway',
      '.ill-float',
      '.ill-sleep',
      '.ill-peek',
    ]) {
      expect(reducedBlock, `${className} 应该被关闭`).toContain(className)
    }
    expect(reducedBlock).toContain('animation: none')
    // 只保留 ≤120ms 的淡入
    expect(reducedBlock).toContain('animation-duration: var(--duration-press)')
    expect(reducedBlock).toContain('transition: opacity var(--duration-press) linear')
  })
})

describe('usePrefersReducedMotion（10 §H2）', () => {
  const stubMatchMedia = (matches: boolean) => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion') ? matches : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    return () => {
      window.matchMedia = original
    }
  }

  it('系统开启「减少动态效果」时返回 true', () => {
    const restore = stubMatchMedia(true)
    expect(usePrefersReducedMotion().value).toBe(true)
    restore()
  })

  it('未开启时返回 false', () => {
    const restore = stubMatchMedia(false)
    expect(usePrefersReducedMotion().value).toBe(false)
    restore()
  })
})
