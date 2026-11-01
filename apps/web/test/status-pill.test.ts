import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import StatusPill from '@/components/base/StatusPill.vue'
import { INSTANCE_STATUS_META, instanceStatusMeta } from '@/composables/useInstanceStatus'

const STATUSES = ['running', 'starting', 'stopping', 'stopped', 'absent', 'error'] as const

describe('StatusPill（07 §2.1 实例状态）', () => {
  it('六种状态都有中文文案，且色调分组正确', () => {
    expect(INSTANCE_STATUS_META.running).toMatchObject({ text: '运行中', tone: 'running', breathe: true })
    expect(INSTANCE_STATUS_META.starting).toMatchObject({ text: '启动中', tone: 'progress', spinner: true })
    expect(INSTANCE_STATUS_META.stopping).toMatchObject({ text: '停止中', tone: 'progress', spinner: true })
    expect(INSTANCE_STATUS_META.stopped).toMatchObject({ text: '已停止', tone: 'idle' })
    expect(INSTANCE_STATUS_META.absent).toMatchObject({ text: '未创建', tone: 'idle' })
    expect(INSTANCE_STATUS_META.error).toMatchObject({ text: '异常', tone: 'error' })
  })

  it('未知状态兜底不抛错', () => {
    expect(instanceStatusMeta('something-new').text).toBe('未知')
    expect(instanceStatusMeta(null).tone).toBe('idle')
  })

  it('每个状态都渲染出对应文案与色调 class', () => {
    for (const status of STATUSES) {
      const wrapper = mount(StatusPill, { props: { status } })
      const meta = INSTANCE_STATUS_META[status]

      expect(wrapper.text()).toContain(meta.text)
      expect(wrapper.classes()).toContain(`status-pill--${meta.tone}`)
      // 颜色来自令牌（禁止写死色值）
      expect(wrapper.attributes('style')).toContain('var(--c-status-')
      wrapper.unmount()
    }
  })

  it('运行中：呼吸光点（.breathe）；启动/停止中：旋转细环', () => {
    const running = mount(StatusPill, { props: { status: 'running' } })
    expect(running.find('.status-pill__dot').classes()).toContain('breathe')
    expect(running.find('.breathe').exists()).toBe(true)

    const starting = mount(StatusPill, { props: { status: 'starting' } })
    expect(starting.find('.status-pill__ring').classes()).toContain('ring-spin')
    expect(starting.find('.breathe').exists()).toBe(false)

    const stopped = mount(StatusPill, { props: { status: 'stopped' } })
    expect(stopped.find('.ring-spin').exists()).toBe(false)
    expect(stopped.find('.breathe').exists()).toBe(false)
  })

  it('支持覆盖文案、尺寸与隐藏图标（表格里用 sm）', () => {
    const wrapper = mount(StatusPill, { props: { status: 'running', label: '在线', size: 'sm', showIcon: false } })

    expect(wrapper.text()).toBe('在线')
    expect(wrapper.classes()).toContain('status-pill--sm')
    expect(wrapper.find('.status-pill__icon').exists()).toBe(false)
  })
})
