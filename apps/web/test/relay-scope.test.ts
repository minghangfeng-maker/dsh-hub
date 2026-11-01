import type { RelayChannel } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { listRelayChannels } from '@/api/admin-relay'
import AddChannelDialog from '@/components/admin/relay/AddChannelDialog.vue'
import RelayChannelsTab from '@/components/admin/relay/RelayChannelsTab.vue'
import RelayModelsTab from '@/components/admin/relay/RelayModelsTab.vue'
import RelayUsageTab from '@/components/admin/relay/RelayUsageTab.vue'
import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'

/**
 * 18 §6：中转站组件加 `scope` 之后——
 * 缺省（DSH）时请求**不带** `scope` 参数、行为与原来一样；传了作用域时列表 / 筛选都带上它；
 * 对话模式的渠道弹窗协议固定、新建请求带 `scope` 与固定协议。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(scenario: MockScenario = 'admin'): void {
  resetRelayMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  document.body.innerHTML = ''
})

function withMessages(component: unknown, props: Record<string, unknown> = {}) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never, props) }),
  })
}

async function mountAt(
  component: unknown,
  props: Record<string, unknown> = {},
  path = '/admin/models?tab=channels',
) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(withMessages(component, props), {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  wrappers.push(wrapper)
  return wrapper
}

function captureUrls(): { urls: string[]; restore: () => void } {
  const urls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    return original(input, init)
  }) as typeof fetch
  return { urls, restore: () => (globalThis.fetch = original) }
}

describe('scope 缺省（DSH）时行为不变', () => {
  it('渠道列表不带 scope 参数，只看 DSH 的渠道', async () => {
    useMock()
    const { urls, restore } = captureUrls()
    const wrapper = await mountAt(RelayChannelsTab)

    await vi.waitFor(() => expect(wrapper.text()).toContain('Upstream B'), { timeout: 5000 })
    restore()
    const list = urls.find((url) => url.includes('/api/admin/relay/channels'))
    expect(list).toBe('/api/admin/relay/channels')
    expect(wrapper.text()).not.toContain('Anthropic 官方')
    wrapper.unmount()
  })
})

describe('scope 传给列表接口（18 §6）', () => {
  it('渠道 Tab：请求带 ?scope=claude-code，只列本作用域的渠道', async () => {
    useMock('agent-modes')
    const { urls, restore } = captureUrls()
    const wrapper = await mountAt(RelayChannelsTab, { scope: 'claude-code' })

    await vi.waitFor(() => expect(wrapper.text()).toContain('Anthropic 官方'), { timeout: 5000 })
    restore()
    expect(urls.some((url) => url === '/api/admin/relay/channels?scope=claude-code')).toBe(true)
    expect(wrapper.text()).not.toContain('Upstream B')
    wrapper.unmount()
  })

  it('模型与价格：请求带 scope，价格旁是乘整体倍率后的单价、没有「默认思考」', async () => {
    useMock('agent-modes')
    const channels: RelayChannel[] = await listRelayChannels('claude-code')
    const { urls, restore } = captureUrls()
    const wrapper = await mountAt(RelayModelsTab, {
      channels,
      scope: 'claude-code',
      modeRatePermille: 1500,
    })

    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })
    restore()
    expect(urls.some((url) => url === '/api/admin/relay/models?scope=claude-code')).toBe(true)
    // 3 积分 / 百万 token × ×1.5 = 4.5
    expect(wrapper.text()).toContain('实际单价')
    expect(wrapper.text()).toContain('4.5')
    expect(wrapper.text()).not.toContain('默认思考')
    wrapper.unmount()
  })

  it('用量：统计与记录都带 scope，逐条表有「来源」列', async () => {
    useMock('agent-modes')
    const channels: RelayChannel[] = await listRelayChannels('claude-code')
    const { urls, restore } = captureUrls()
    const wrapper = await mountAt(
      RelayUsageTab,
      { channels, scope: 'claude-code' },
      '/admin/claude-code?tab=usage',
    )

    await vi.waitFor(() => expect(wrapper.text()).toContain('区间请求'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })
    restore()
    expect(
      urls.some((url) => url.includes('/api/admin/relay/usage') && url.includes('scope=claude-code')),
    ).toBe(true)
    expect(
      urls.some((url) => url.includes('/api/admin/relay/logs') && url.includes('scope=claude-code')),
    ).toBe(true)
    expect(wrapper.text()).toContain('来源')
    wrapper.unmount()
  })

  it('「模型」页看全部来源：来源筛选选中 Claude Code 后，统计与记录都按它筛', async () => {
    useMock('admin')
    const wrapper = await mountAt(RelayUsageTab, { showSource: true }, '/admin/models?tab=usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('区间请求'), { timeout: 5000 })

    const select = wrapper
      .findAllComponents(NSelect)
      .find((item) => item.attributes('data-testid') === 'usage-source-filter')
    expect(select, '应有「来源」筛选').toBeTruthy()

    const { urls, restore } = captureUrls()
    select!.vm.$emit('update:value', 'claude-code')
    await flushPromises()
    await vi.waitFor(
      () =>
        expect(
          urls.some((url) => url.includes('/api/admin/relay/usage') && url.includes('scope=claude-code')),
        ).toBe(true),
      { timeout: 5000 },
    )
    restore()
    wrapper.unmount()
  })

  it('「用量来源」筛选（WP56e1）：选中座舱后统计与记录都带 source=cockpit', async () => {
    useMock('admin')
    const wrapper = await mountAt(RelayUsageTab, { showSource: true }, '/admin/models?tab=usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('区间请求'), { timeout: 5000 })

    const select = wrapper
      .findAllComponents(NSelect)
      .find((item) => item.attributes('data-testid') === 'usage-origin-filter')
    expect(select, '应有「用量来源」筛选').toBeTruthy()

    const { urls, restore } = captureUrls()
    select!.vm.$emit('update:value', 'cockpit')
    await flushPromises()
    await vi.waitFor(
      () =>
        expect(
          urls.some((url) => url.includes('/api/admin/relay/usage') && url.includes('source=cockpit')),
        ).toBe(true),
      { timeout: 5000 },
    )
    await vi.waitFor(
      () =>
        expect(
          urls.some((url) => url.includes('/api/admin/relay/logs') && url.includes('source=cockpit')),
        ).toBe(true),
      { timeout: 5000 },
    )
    restore()
    wrapper.unmount()
  })
})

describe('对话模式的「添加渠道」', () => {
  it('不显示模板 / 协议选择；新建请求带 scope 与固定协议', async () => {
    useMock('agent-modes')
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/admin/claude-code?tab=channels')
    await router.isReady()

    const props = reactive<Record<string, unknown>>({ scope: 'claude-code', show: false })
    const wrapper = mount(withMessages(AddChannelDialog, props), {
      global: { plugins: [router] },
      attachTo: document.body,
    })
    wrappers.push(wrapper)
    props.show = true
    await nextTick()
    await flushPromises()

    expect(document.body.querySelector('[data-testid="add-channel-template"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="add-channel-fixed-api"]')?.textContent).toContain(
      'anthropic-messages',
    )
    expect(
      document.body.querySelector('[data-testid="add-channel-url"] input')?.getAttribute('placeholder'),
    ).toBe('https://api.anthropic.com/v1')

    const setInput = (testid: string, value: string): void => {
      const input = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-testid="${testid}"] input, [data-testid="${testid}"] textarea`,
      )
      expect(input, `找不到 ${testid}`).toBeTruthy()
      input!.value = value
      input!.dispatchEvent(new Event('input'))
    }
    setInput('add-channel-name', 'Claude 备用渠道')
    setInput('add-channel-url', 'https://claude-backup.example.com/v1')
    setInput('add-channel-keys', 'sk-ant-demo-1')

    const bodies: { url: string; body: Record<string, unknown> }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.startsWith('{')) {
        bodies.push({ url: String(input), body: JSON.parse(init.body) as Record<string, unknown> })
      }
      return original(input, init)
    }) as typeof fetch
    document.body
      .querySelector<HTMLElement>('[data-testid="add-channel-next"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0), { timeout: 5000 })
    globalThis.fetch = original

    const created = bodies.find((item) => item.url === '/api/admin/relay/channels')!
    expect(created.body['scope']).toBe('claude-code')
    expect(created.body['apis']).toEqual(['anthropic-messages'])

    // 也真的建在了本作用域里
    const runtime = await fetch('/api/admin/relay/channels?scope=claude-code')
    const list = (await runtime.json()) as RelayChannel[]
    const channel = list.find((item) => item.name === 'Claude 备用渠道')
    expect(channel?.scope).toBe('claude-code')
    expect(channel?.apis).toEqual(['anthropic-messages'])
    wrapper.unmount()
  })
})
