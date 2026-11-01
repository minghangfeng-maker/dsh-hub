import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario } from '@/mocks/state'
import { resetToolsMock } from '@/mocks/tools'
import { routes } from '@/router'
import AdminSearchView from '@/views/admin/AdminSearchView.vue'

/**
 * 搜索池独立页 `/admin/search`（15 §1）：
 * 四个一级标签、`?tab=` 同步、默认「概览」、旧地址 `/admin/models?tab=tools` 直接跳过来。
 * 走 `?mock=admin` 的假接口，不连后端。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetRelayMock()
  resetToolsMock()
  setMockScenario('admin')
  restores.push(installMockFetch('admin'))
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

async function mountSearch(path: string): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const wrapper = mount(withMessages(AdminSearchView), {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

describe('/admin/search 搜索池（15 §1）', () => {
  it('标题「搜索池」，四个一级标签，默认打开「概览」', async () => {
    useMock()
    const { wrapper } = await mountSearch('/admin/search')

    expect(wrapper.text()).toContain('搜索池')
    const labels = wrapper.findAll('.n-tabs-tab').map((tab) => tab.text().trim())
    expect(labels).toEqual(['设置', '概览', '渠道', '用量'])
    expect(wrapper.find('[data-testid="search-panel-overview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="search-panel-settings"]').exists()).toBe(false)
    await vi.waitFor(() => expect(wrapper.text()).toContain('本月调用'), { timeout: 5000 })
    wrapper.unmount()
  })

  it('点「设置」切换面板并写入 ?tab=settings；带 ?tab=usage 直接落到用量', async () => {
    useMock()
    const settings = await mountSearch('/admin/search')
    const tab = settings.wrapper.findAll('.n-tabs-tab').find((item) => item.text().includes('设置'))
    await tab?.trigger('click')
    await flushPromises()
    expect(settings.router.currentRoute.value.query['tab']).toBe('settings')
    expect(settings.wrapper.find('[data-testid="search-panel-settings"]').exists()).toBe(true)
    settings.wrapper.unmount()

    const usage = await mountSearch('/admin/search?tab=usage')
    expect(usage.wrapper.find('[data-testid="search-panel-usage"]').exists()).toBe(true)
    usage.wrapper.unmount()
  })

  it('旧地址 /admin/models?tab=tools 跳到 /admin/search，并保留其余查询参数', async () => {
    useMock()
    const { wrapper, router } = await mountSearch('/admin/models?tab=tools&userId=2')

    expect(router.currentRoute.value.path).toBe('/admin/search')
    expect(router.currentRoute.value.query).toEqual({ userId: '2' })
    expect(wrapper.find('[data-testid="search-panel-overview"]').exists()).toBe(true)
    // 不能落到模型概览
    expect(wrapper.text()).not.toContain('今日请求')
    wrapper.unmount()
  })
})
