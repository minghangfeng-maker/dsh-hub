import type { InstanceStats, InstanceSummary } from '@dsh-hub/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import InstanceMainCard from '@/components/user/InstanceMainCard.vue'

/**
 * 主卡片「我的 DSH」的六种状态（07 §6.1）。
 * 任务书要求覆盖五种：运行中 / 已停止 / 启动中 / 停止中 / 异常。
 */

const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const OPEN_URL = '/dsh/littletao/'

const STATS: InstanceStats = {
  cpuPercent: 36.8,
  memoryBytes: 1_738_987_520,
  memoryLimitBytes: 4 * 1024 ** 3,
  pids: 47,
  diskBytes: 6_871_947_674,
  diskLimitBytes: 20 * 1024 ** 3,
}

function summary(partial: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    status: 'running',
    runtimeVersion: '0.9.4',
    startedAt: '2026-10-12T09:47:00.000Z',
    lastActiveAt: '2026-10-12T11:56:00.000Z',
    needsRecreate: false,
    error: null,
    openUrl: OPEN_URL,
    ...partial,
  }
}

function mountCard(props: Record<string, unknown> = {}) {
  return mount(InstanceMainCard, {
    props: { instance: summary(), stats: STATS, now: NOW, ...props },
  })
}

describe('主卡片「我的 DSH」（07 §6.1）', () => {
  it('运行中：打开 DSH / 停止 / 重启都可用，并显示已运行时长', () => {
    const wrapper = mountCard()
    const primary = wrapper.get('[data-testid="instance-primary"]')

    expect(primary.text()).toContain('打开 DSH')
    expect(primary.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="instance-stop"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="instance-restart"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="instance-status-line"]').text()).toBe('已运行 2 小时 13 分')
    // 运行中：资源条三件套 + 状态胶囊
    expect(wrapper.text()).toContain('CPU')
    expect(wrapper.text()).toContain('内存')
    expect(wrapper.text()).toContain('磁盘')
    expect(wrapper.text()).toContain('运行中')
  })

  it('已停止：主按钮仍是「打开 DSH」（点它会先启动），停止/重启禁用', () => {
    const wrapper = mountCard({
      instance: summary({ status: 'stopped', startedAt: null, lastActiveAt: '2026-10-11T13:30:00.000Z' }),
      stats: null,
    })

    expect(wrapper.get('[data-testid="instance-primary"]').text()).toContain('打开 DSH')
    expect(wrapper.get('[data-testid="instance-primary"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="instance-stop"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="instance-restart"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="instance-status-line"]').text()).toContain('上次使用')
    expect(wrapper.text()).toContain('已停止')
    expect(wrapper.text()).toContain('实例启动后')
  })

  it('未创建（absent）：文案提示还没有创建', () => {
    const wrapper = mountCard({
      instance: summary({ status: 'absent', startedAt: null, lastActiveAt: null, runtimeVersion: null }),
      stats: null,
    })

    expect(wrapper.get('[data-testid="instance-status-line"]').text()).toContain('还没有创建')
    expect(wrapper.text()).toContain('未创建')
  })

  it('启动中：主按钮禁用并变成「正在唤醒…」，出现阶段步骤条', () => {
    const wrapper = mountCard({
      instance: summary({ status: 'starting', startedAt: null }),
      stats: null,
      phase: 'bootstrapping',
      phaseMessage: '正在安装插件（2/3）',
    })

    const primary = wrapper.get('[data-testid="instance-primary"]')
    expect(primary.text()).toContain('正在唤醒…')
    expect(primary.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="instance-stop"]').attributes('disabled')).toBeDefined()

    const steps = wrapper.get('[data-testid="instance-phases"]')
    expect(steps.text()).toContain('准备容器')
    expect(steps.text()).toContain('启动服务')
    expect(steps.text()).toContain('准备插件')
    expect(steps.text()).toContain('就绪')
    expect(steps.text()).toContain('正在安装插件（2/3）')
    expect(steps.attributes('aria-live')).toBe('polite')
  })

  it('停止中：主按钮禁用并变成「停止中…」，阶段条仍在', () => {
    const wrapper = mountCard({
      instance: summary({ status: 'stopping' }),
      phaseMessage: '正在停止容器',
    })

    expect(wrapper.get('[data-testid="instance-primary"]').text()).toContain('停止中…')
    expect(wrapper.get('[data-testid="instance-primary"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="instance-phases"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="instance-status-line"]').text()).toBe('正在停止…')
  })

  it('异常：主按钮变成「重试启动」，点击发 retry 事件', async () => {
    const wrapper = mountCard({
      instance: summary({ status: 'error', error: '容器启动失败：端口 3000 被占用' }),
      stats: null,
    })

    const primary = wrapper.get('[data-testid="instance-primary"]')
    expect(primary.text()).toContain('重试启动')
    expect(primary.attributes('disabled')).toBeUndefined()

    await primary.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    expect(wrapper.emitted('open')).toBeUndefined()
  })

  it('运行中点「打开 DSH」发 open 事件；停止/重启各发自己的事件', async () => {
    const wrapper = mountCard()

    await wrapper.get('[data-testid="instance-primary"]').trigger('click')
    await wrapper.get('[data-testid="instance-stop"]').trigger('click')
    await wrapper.get('[data-testid="instance-restart"]').trigger('click')

    expect(wrapper.emitted('open')).toHaveLength(1)
    expect(wrapper.emitted('stop')).toHaveLength(1)
    expect(wrapper.emitted('restart')).toHaveLength(1)
  })

  it('needsRecreate：奶油色提示「配置已更新，重启后生效」+ 立即重启', async () => {
    const wrapper = mountCard({ instance: summary({ needsRecreate: true }) })

    expect(wrapper.text()).toContain('配置已更新，重启后生效')
    await wrapper.get('.instance-card__hint--butter button').trigger('click')
    expect(wrapper.emitted('restart')).toHaveLength(1)
  })

  it('CAPACITY_FULL：友好提示带 running/max，重试按钮发 retry（10 §C7）', async () => {
    const wrapper = mountCard({
      instance: summary({ status: 'stopped', startedAt: null }),
      stats: null,
      errorText: '同时在用的人有点多，稍后再试试（正在运行 12/12）',
      errorCode: 'CAPACITY_FULL',
      errorDetails: { running: 12, max: 12 },
    })

    const alert = wrapper.get('[data-testid="instance-error"]')
    expect(alert.text()).toContain('同时在用的人有点多')
    expect(alert.text()).toContain('12/12')

    await wrapper.get('[data-testid="instance-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('启动失败的普通错误也有重试按钮', async () => {
    const wrapper = mountCard({
      instance: summary({ status: 'error' }),
      stats: null,
      errorText: 'DSH 启动失败了',
      errorCode: 'INSTANCE_START_FAILED',
    })

    expect(wrapper.get('[data-testid="instance-error"]').text()).toContain('DSH 启动失败了')
    await wrapper.get('[data-testid="instance-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('成功提示条会渲染（打开被拦/已开始启动）', () => {
    const wrapper = mountCard({ noticeText: '已经打开了，去新标签页看看吧。' })

    expect(wrapper.get('.instance-card__hint--mint').text()).toContain('已经打开了')
  })
})
