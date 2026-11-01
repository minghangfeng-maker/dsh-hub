import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import BubbleCat from '@/components/illustrations/BubbleCat.vue'
import CloudNap from '@/components/illustrations/CloudNap.vue'
import KeyLeaf from '@/components/illustrations/KeyLeaf.vue'
import LeafSprout from '@/components/illustrations/LeafSprout.vue'
import PaperPlane from '@/components/illustrations/PaperPlane.vue'

const ILLUSTRATIONS = [
  { name: 'LeafSprout', component: LeafSprout, label: '新芽', animation: 'ill-sway' },
  { name: 'CloudNap', component: CloudNap, label: '云朵', animation: 'ill-sleep' },
  { name: 'PaperPlane', component: PaperPlane, label: '纸飞机', animation: 'ill-float' },
  { name: 'BubbleCat', component: BubbleCat, label: '小猫', animation: 'ill-peek' },
  { name: 'KeyLeaf', component: KeyLeaf, label: '钥匙', animation: 'ill-sway' },
] as const

describe('插画组件（07 §2.6）', () => {
  it('五个插画都渲染内联 SVG，且支持 size 属性', () => {
    for (const item of ILLUSTRATIONS) {
      const wrapper = mount(item.component, { props: { size: 88 } })
      const svg = wrapper.find('svg')

      expect(svg.exists(), `${item.name} 应该渲染 svg`).toBe(true)
      expect(svg.attributes('width')).toBe('88')
      expect(svg.attributes('role')).toBe('img')
      expect(svg.attributes('aria-label')).toContain(item.label)
      wrapper.unmount()
    }
  })

  it('线条统一 2px、圆端点（07 §2.6）', () => {
    for (const item of ILLUSTRATIONS) {
      const svg = mount(item.component).find('svg')
      const paths = svg.findAll('path, circle')

      expect(svg.attributes('fill')).toBe('none')
      for (const node of paths) {
        const strokeWidth = node.attributes('stroke-width')
        if (strokeWidth) expect(strokeWidth, `${item.name} 线宽`).toBe('2')
      }
    }
  })

  it('最多三种色相，且都来自设计令牌（不写死色值）', () => {
    for (const item of ILLUSTRATIONS) {
      const html = mount(item.component).html()
      // 同一色相的浅底（如 --c-primary-soft）与主色算一种颜色
      const hues = new Set(
        [...html.matchAll(/var\((--c-[a-z0-9-]+)\)/g)].map((match) => (match[1] ?? '').replace(/-soft$/, '')),
      )

      expect(hues.size, `${item.name} 色相数量`).toBeLessThanOrEqual(3)
      expect(hues.size).toBeGreaterThan(0)
      // 不允许出现十六进制色值
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })

  it('animated=false 时没有任何动画 class；true 时挂上摇摆/呼吸/漂浮', () => {
    for (const item of ILLUSTRATIONS) {
      const still = mount(item.component).find('svg')
      expect(still.classes(), `${item.name} 默认不动`).not.toContain(item.animation)

      const animated = mount(item.component, { props: { animated: true } }).find('svg')
      expect(animated.classes(), `${item.name} animated`).toContain(item.animation)
    }
  })

  it('title 可自定义（复用同一个插画时有正确读屏文案）', () => {
    const wrapper = mount(LeafSprout, { props: { title: '空列表插画' } })
    expect(wrapper.attributes('aria-label')).toBe('空列表插画')
  })
})
