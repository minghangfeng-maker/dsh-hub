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
 * WP58 的 AI 助手页（docs/26 §2 / §4）：五档布局里的 S 档抽屉、启动加载卡的成败两条路、
 * 老 App（不发 caps / status）的兜底。阶段判据本身在 `assist-phase.test.ts` 里测，
 * 这里只验「界面确实按那个阶段变」。
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

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/assistant')
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(OpsAssistantSection, { page: true }) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('AI 助手 · S 档把事件栏收进抽屉（WP58，docs/26 §2.3）', () => {
  it('1100 宽：没有常驻事件栏，头部「事件」按钮带待确认徽标，点开抽屉能看到同样的卡片', async () => {
    const wrapper = await mountAssistant('cockpit', 1100)

    expect(wrapper.get('[data-testid="ops-assistant"]').attributes('data-tier')).toBe('S')
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('就绪'),
    )

    // S 档：常驻事件栏不在，头部出现「事件」按钮（带数字徽标）
    expect(wrapper.find('[data-testid="ops-assistant-events"]').exists()).toBe(false)
    const open = wrapper.get('[data-testid="ops-assistant-events-open"]')
    expect(open.text()).toContain('事件')
    expect(open.text()).toMatch(/\d/)

    await open.trigger('click')
    await flushPromises()
    // 抽屉是 teleport 到 body 的：内容与常驻栏同一个 AssistantEvents 组件
    await vi.waitFor(() => expect(document.body.textContent).toContain('待确认'))
    expect(document.body.querySelector('[data-testid="ops-assistant-events"]')).not.toBeNull()
  })

  it('1440 宽（M 档）：事件栏常驻，没有「事件」按钮', async () => {
    const wrapper = await mountAssistant('cockpit', 1440)

    expect(wrapper.get('[data-testid="ops-assistant"]').attributes('data-tier')).toBe('M')
    expect(wrapper.find('[data-testid="ops-assistant-events-open"]').exists()).toBe(false)
    await vi.waitFor(() => expect(wrapper.find('[data-testid="ops-assistant-events"]').exists()).toBe(true))
  })
})

describe('AI 助手 · 启动加载卡（WP58，docs/26 §4）', () => {
  it('容器 running、App 还没报 ready：先盖加载卡；ready 后卡消失、胶囊变「就绪」', async () => {
    const wrapper = await mountAssistant('cockpit', 1440)
    const section = wrapper.get('[data-testid="ops-assistant"]')

    // 占位面板还没走完握手：booting，卡上有三步（占位面板的 quick 脚本 400ms 后报 ready）
    await vi.waitFor(() => expect(section.attributes('data-phase')).toBe('booting'))
    const card = wrapper.get('[data-testid="ops-assistant-load"]')
    expect(card.text()).toContain('等 DSH 就绪')

    await vi.waitFor(() => expect(wrapper.find('[data-testid="ops-assistant-load"]').exists()).toBe(false))
    expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('就绪')
  })

  it('启动接口报错：卡上停在「启动容器」并给原因 + 重试 + 重启容器；重试后重新进入启动中', async () => {
    const wrapper = await mountAssistant('cockpit-fail', 1440)

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="ops-assistant-start-big"]').exists()).toBe(true),
    )
    expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('未启动')

    await wrapper.get('[data-testid="ops-assistant-start-big"]').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('启动失败'),
    )
    const card = wrapper.get('[data-testid="ops-assistant-load"]')
    expect(card.attributes('data-phase')).toBe('failed')
    expect(wrapper.get('[data-testid="ops-assistant-fail-reason"]').text()).toContain('容器运行时不可用')
    expect(wrapper.find('[data-testid="ops-assistant-retry"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ops-assistant-restart-container"]').exists()).toBe(true)

    // 假数据里第二次启动会成功：重试 → 回到「启动中」，失败原因不再显示
    await wrapper.get('[data-testid="ops-assistant-retry"]').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('启动中'),
    )
    expect(wrapper.find('[data-testid="ops-assistant-fail-reason"]').exists()).toBe(false)
  })

  it('老 App（cockpit.ready 不带 caps、不发 status）：running + ready 就当就绪', async () => {
    const wrapper = await mountAssistant('cockpit-legacy', 1440)

    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="ops-assistant-start-big"]').exists()).toBe(true),
    )
    await wrapper.get('[data-testid="ops-assistant-start-big"]').trigger('click')

    // 容器起来（假数据 2 秒）+ 占位面板按老 App 的脚本只发一条 ready
    await vi.waitFor(
      () => expect(wrapper.get('[data-testid="ops-assistant-status"]').text()).toContain('就绪'),
      { timeout: 6000 },
    )
    expect(wrapper.find('[data-testid="ops-assistant-load"]').exists()).toBe(false)
  })
})
