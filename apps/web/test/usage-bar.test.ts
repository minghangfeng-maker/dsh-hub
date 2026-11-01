import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import UsageBar from '@/components/base/UsageBar.vue'

const GB = 1024 ** 3

function mountBar(used: number, limit: number) {
  return mount(UsageBar, { props: { used, limit, label: '磁盘' } })
}

describe('UsageBar（07 §6.1 资源条阈值）', () => {
  it('≤90% 用主色蓝，不提醒', () => {
    const wrapper = mountBar(1 * GB, 10 * GB)
    const fill = wrapper.find('.usage-bar__fill')

    expect(wrapper.text()).toContain('1 GB / 10 GB')
    expect(fill.attributes('style')).toContain('var(--c-primary)')
    expect(fill.attributes('style')).toContain('width: 10%')
  })

  it('>90% 变奶油黄（warn）', () => {
    const wrapper = mountBar(9.5 * GB, 10 * GB)

    expect(wrapper.find('.usage-bar__fill').attributes('style')).toContain('var(--c-warning)')
    expect(wrapper.find('.usage-bar__value').classes()).toContain('usage-bar__value--warn')
  })

  it('>100% 变珊瑚红（over），条宽封顶 100%', () => {
    const wrapper = mountBar(12 * GB, 10 * GB)

    expect(wrapper.find('.usage-bar__fill').attributes('style')).toContain('var(--c-danger)')
    expect(wrapper.find('.usage-bar__fill').attributes('style')).toContain('width: 100%')
    expect(wrapper.find('.usage-bar__value').classes()).toContain('usage-bar__value--over')
  })

  it('恰好 90% 仍然是正常色（阈值是「大于」）', () => {
    const wrapper = mountBar(9 * GB, 10 * GB)
    expect(wrapper.find('.usage-bar__fill').attributes('style')).toContain('var(--c-primary)')
  })

  it('可访问性：progressbar 角色 + 数值 + 读屏文本', () => {
    const wrapper = mountBar(2 * GB, 4 * GB)
    const track = wrapper.find('[role="progressbar"]')

    expect(track.attributes('aria-valuenow')).toBe(String(2 * GB))
    expect(track.attributes('aria-valuemax')).toBe(String(4 * GB))
    expect(track.attributes('aria-label')).toBe('磁盘')
    expect(wrapper.find('.usage-bar__sr').text()).toContain('已用 50%')
  })

  it('limit 非法（0）时不崩、显示 0%', () => {
    const wrapper = mountBar(5, 0)
    expect(wrapper.find('.usage-bar__fill').attributes('style')).toContain('width: 0%')
  })

  it('count / percent 单位格式', () => {
    const count = mount(UsageBar, { props: { used: 1200, limit: 2000, unit: 'count', label: '导出次数' } })
    expect(count.text()).toContain('1,200 / 2,000')

    const percent = mount(UsageBar, { props: { used: 42, limit: 100, unit: 'percent' } })
    expect(percent.text()).toContain('42% / 100%')
  })
})
