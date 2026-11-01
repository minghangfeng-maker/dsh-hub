import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import ToolsOverviewPanel from '@/components/admin/search/ToolsOverviewPanel.vue'
import ToolsChannelsPanel from '@/components/admin/search/ToolsChannelsPanel.vue'
import ToolsCard from '@/components/user/tools/ToolsCard.vue'
import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { resetToolsMock } from '@/mocks/tools'
import { routes } from '@/router'

/**
 * 搜索池假数据（WP18b 交付物 3）：`?mock=admin` 有 Tavily + DeepSeek 两个渠道、一把额度用完、
 * 一把自动停用；`?mock=1` 用户端能看到搜索与抓取卡片；`?mock=tools-exhausted` 免费额度用完；
 * `?mock=admin-tools-off` 总开关关闭。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(scenario: MockScenario): void {
  resetRelayMock()
  resetToolsMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  resetRelayMock()
  resetToolsMock()
  setMockScenario('running')
  document.body.innerHTML = ''
})

function withMessages(component: unknown) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never) }),
  })
}

async function mountWithRouter(component: unknown, path = '/usage') {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(withMessages(component), { global: { plugins: [router] } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('搜索池 · 渠道（?mock=admin）', () => {
  it('列出 Tavily 与 DeepSeek 两个渠道，密钥统计含冷却与自动停用', async () => {
    useMock('admin')
    const wrapper = await mountWithRouter(ToolsChannelsPanel, '/admin/models?tab=tools')

    await vi.waitFor(() => expect(wrapper.text()).toContain('Tavily 免费池'), { timeout: 5000 })
    const text = wrapper.text()
    expect(text).toContain('DeepSeek 官方')
    // 可用 / 冷却 / 额度用完 / 停用：Tavily 是 1 / 0 / 1 / 0，DeepSeek 是 1 / 0 / 0 / 1
    expect(text).toContain('1 / 0 / 1 / 0')
    expect(text).toContain('1 / 0 / 0 / 1')
  })
})

describe('搜索池 · 概览（?mock=admin）', () => {
  it('显示本月调用、免费调用、收入、上游成本与毛利', async () => {
    useMock('admin')
    const wrapper = await mountWithRouter(ToolsOverviewPanel, '/admin/models?tab=tools')

    await vi.waitFor(() => expect(wrapper.text()).toContain('本月调用'), { timeout: 5000 })
    const text = wrapper.text()
    expect(text).toContain('其中免费调用')
    expect(text).toContain('收入（积分）')
    expect(text).toContain('上游成本（积分）')
    expect(text).toContain('毛利（积分）')
    expect(text).toContain('按渠道')
    expect(text).toContain('按工具')
  })
})

describe('搜索与抓取卡片（用户端，14 §7；19 §2.4 起只显示三格用量）', () => {
  it('?mock=1：只显示本月免费 / 本月调用 / 本月花费三格', async () => {
    useMock('running')
    const wrapper = await mountWithRouter(ToolsCard)

    await vi.waitFor(() => expect(wrapper.text()).toContain('搜索与抓取'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('本月免费'), { timeout: 5000 })
    const text = wrapper.text()
    expect(text).toContain('本月调用')
    expect(text).toContain('本月花费')
    // 19 §2.4：去掉超出后单价、下发到 DSH、卡内说明与逐条表
    expect(text).not.toContain('超出后单价')
    expect(text).not.toContain('下发到 DSH')
    expect(text).not.toContain('DSH 是什么')
    expect(wrapper.find('.n-data-table').exists()).toBe(false)
  })

  it('?mock=tools-exhausted：免费额度用满（100 / 100）', async () => {
    useMock('tools-exhausted')
    const wrapper = await mountWithRouter(ToolsCard)

    await vi.waitFor(() => expect(wrapper.text()).toContain('搜索与抓取'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('100 / 100'), { timeout: 5000 })
  })

  it('?mock=admin-tools-off：总开关关掉，卡片不渲染', async () => {
    useMock('admin-tools-off')
    const wrapper = await mountWithRouter(ToolsCard)

    await flushPromises()
    expect(wrapper.find('[data-testid="tools-card"]').exists()).toBe(false)
  })
})
