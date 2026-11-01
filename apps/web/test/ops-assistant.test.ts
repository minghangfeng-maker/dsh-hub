import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import OpsAssistantSection from '@/components/admin/assistant/OpsAssistantSection.vue'
import { installMockEventSource } from '@/mocks/eventsource'
import { installMockFetch } from '@/mocks/fetch'
import { routes } from '@/router'

/**
 * 概览里的 AI 助手（WP57，docs/25 §5）：座舱的对话 + 事件卡片，去掉舰桥外壳。
 * 关键约束：打开概览**不拉起**座舱容器（`/state?start=0`），点「启动」才起。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  for (const restore of restores.reverse()) restore()
  restores.length = 0
  vi.restoreAllMocks()
  localStorage.removeItem('hub.admin.assistant.clearedAt')
  document.body.innerHTML = ''
})

/**
 * 视口宽度决定档位（WP58，docs/26 §2.1）：默认给 1440（M 档，事件栏常驻）。
 * jsdom 缺省的 1024 会落到 S 档 —— 那时事件栏在抽屉里，另行在 assist-console.test.ts 里测。
 */
function setInnerWidth(width: number): void {
  const original = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  restores.push(() => {
    if (original) Object.defineProperty(window, 'innerWidth', original)
    else Reflect.deleteProperty(window, 'innerWidth')
  })
}

async function mountAssistant(scenario: string, width = 1440) {
  setInnerWidth(width)
  restores.push(installMockFetch(scenario as never))
  restores.push(installMockEventSource())
  const calls: { url: string; method: string }[] = []
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), method: init?.method ?? 'GET' })
    return original(input, init)
  })

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/overview')
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(OpsAssistantSection) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, calls }
}

describe('概览 · AI 助手（WP57）', () => {
  it('座舱没在跑：只读状态（?start=0），显示「未启动」和启动按钮，不建对话', async () => {
    const { wrapper, calls } = await mountAssistant('cockpit-off')
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('未启动'),
    )
    const stateCalls = calls.filter((call) => call.url.includes('/api/admin/cockpit/state'))
    expect(stateCalls.length).toBeGreaterThan(0)
    expect(stateCalls.every((call) => call.url.includes('start=0'))).toBe(true)
    expect(wrapper.find('[data-testid="ops-assistant-idle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ops-assistant-start"]').exists()).toBe(true)
  })

  it('点「启动」才调启动接口', async () => {
    const { wrapper, calls } = await mountAssistant('cockpit-off')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ops-assistant-start-big"]').exists()).toBe(true))
    expect(calls.some((call) => call.url.includes('/ops-instance/start'))).toBe(false)
    await wrapper.get('[data-testid="ops-assistant-start-big"]').trigger('click')
    await flushPromises()
    expect(calls.some((call) => call.url.includes('/ops-instance/start') && call.method === 'POST')).toBe(true)
  })

  it('在跑：右侧事件卡片列出待确认的方案，标题旁有待确认数', async () => {
    const { wrapper } = await mountAssistant('cockpit')
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('就绪'),
    )
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ops-assistant-pending"]').exists()).toBe(true))
    const events = wrapper.get('[data-testid="ops-assistant-events"]')
    expect(events.text()).toContain('待确认')
    expect(events.find('[data-event-proposal]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ops-assistant-restart"]').exists()).toBe(true)
  })

  it('清空：已处理的方案与结果卡不再显示（本浏览器记住），待确认的保留；刷新后仍是清空的', async () => {
    const { wrapper } = await mountAssistant('cockpit')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ops-assistant-pending"]').exists()).toBe(true))
    const events = () => wrapper.get('[data-testid="ops-assistant-events"]')
    await vi.waitFor(() => expect(events().text()).toContain('最近处理'))
    const pendingBefore = events().findAll('[data-event-proposal]').length

    await wrapper.get('[data-testid="ops-assistant-clear"]').trigger('click')
    await flushPromises()
    expect(events().text()).not.toContain('最近处理')
    expect(events().text()).toContain('待确认')
    expect(events().findAll('[data-event-proposal]').length).toBeLessThan(pendingBefore)
    expect(localStorage.getItem('hub.admin.assistant.clearedAt')).not.toBeNull()
    // 没东西可清了：按钮禁用
    expect(wrapper.get('[data-testid="ops-assistant-clear"]').attributes('disabled')).toBeDefined()

    wrapper.unmount()
    wrappers.length = 0
    const again = await mountAssistant('cockpit')
    await vi.waitFor(() => expect(again.wrapper.find('[data-testid="ops-assistant-pending"]').exists()).toBe(true))
    expect(again.wrapper.get('[data-testid="ops-assistant-events"]').text()).not.toContain('最近处理')
  })

  it('独立页 /admin/assistant：侧边栏在「概览」下面', async () => {
    const { ADMIN_NAV_GROUPS } = await import('@/layouts/admin-nav')
    const first = ADMIN_NAV_GROUPS[0]!.items.map((item) => item.to)
    expect(first).toEqual(['/admin/overview', '/admin/assistant'])
  })
})
