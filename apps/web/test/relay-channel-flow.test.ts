import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import AddChannelDialog from '@/components/admin/relay/AddChannelDialog.vue'
import RelayModelPickerDialog from '@/components/admin/relay/RelayModelPickerDialog.vue'
import { installMockFetch } from '@/mocks/fetch'
import { relayState, resetRelayMock } from '@/mocks/relay'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'

/**
 * 两步「添加渠道」与模型选择器（WP11b 交付物 3，12 §10）：
 * 填表 → 下一步（建渠道 + 拉模型）→ 勾选 → `import`（**不带 price**）→「去定价」跳 `?unpriced=1`；
 * 取消勾选已有的 = 二次确认后 PATCH 该模型 `routes` 去掉本渠道。
 *
 * 弹窗传送到 body，交互走 `document.body` 上的真实元素。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetRelayMock()
  setMockScenario('admin')
  restores.push(installMockFetch('admin'))
}

afterEach(() => {
  // 先卸载组件再清 body：Teleport 到 body 的弹窗留着的话，下一个用例会查到上一个弹窗的元素
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  document.body.innerHTML = ''
})

function withMessages(component: unknown, props: Record<string, unknown>) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never, props) }),
  })
}

/** 挂一个弹窗组件并把它打开（NModal 的 show 从 false 变 true 时才会填内容） */
async function mountDialog(
  component: unknown,
  props: Record<string, unknown>,
  path = '/admin/models?tab=channels',
): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const reactiveProps = reactive<Record<string, unknown>>({ ...props, show: false })
  const wrapper = mount(withMessages(component, reactiveProps), {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  reactiveProps.show = true
  await nextTick()
  await flushPromises()
  wrappers.push(wrapper)
  return { wrapper, router }
}

function setInput(testid: string, value: string): void {
  const input = document.body.querySelector<HTMLInputElement>(`[data-testid="${testid}"] input`)
  const textarea = document.body.querySelector<HTMLTextAreaElement>(`[data-testid="${testid}"] textarea`)
  const element = input ?? textarea
  expect(element, `找不到输入框 ${testid}`).toBeTruthy()
  element!.value = value
  element!.dispatchEvent(new Event('input'))
}

function click(testid: string): void {
  const button = document.body.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)
  expect(button, `找不到按钮 ${testid}`).toBeTruthy()
  button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * 选择器里某一行的勾选框（按行文本匹配模型名）。
 * Naive 的 NCheckbox 渲染的是 `div[role=checkbox]`（没有 input），点它 / 读 aria-checked。
 */
function checkboxOf(label: string): HTMLElement {
  const row = [...document.body.querySelectorAll<HTMLLIElement>('.picker__item')].find((item) =>
    item.textContent?.includes(label),
  )
  expect(row, `选择器里应有 ${label}`).toBeTruthy()
  const box = row!.querySelector<HTMLElement>('.n-checkbox')
  expect(box, `${label} 应有勾选框`).toBeTruthy()
  return box!
}

function clickBox(label: string): void {
  checkboxOf(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function isChecked(label: string): boolean {
  return checkboxOf(label).getAttribute('aria-checked') === 'true'
}

function captureRequests(): {
  bodies: { url: string; body: Record<string, unknown> }[]
  restore: () => void
} {
  const bodies: { url: string; body: Record<string, unknown> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string' && init.body.startsWith('{')) {
      bodies.push({ url: String(input), body: JSON.parse(init.body) as Record<string, unknown> })
    }
    return original(input, init)
  }) as typeof fetch
  return { bodies, restore: () => (globalThis.fetch = original) }
}

describe('「添加渠道」两步弹窗（12 §10）', () => {
  it('填表 → 下一步 → 勾选 → import 不带 price → 「去定价」跳 ?tab=models&unpriced=1', async () => {
    useMock()
    const { wrapper, router } = await mountDialog(AddChannelDialog, {})

    expect(document.body.textContent ?? '').toContain('渠道信息')
    expect(document.body.textContent ?? '').toContain('选择模型')

    setInput('add-channel-name', '演示渠道')
    setInput('add-channel-url', 'https://demo.example.com/v1')
    setInput('add-channel-keys', 'sk-demo-1\nsk-demo-2')
    setInput('add-channel-rate', '1.5')
    await nextTick()

    const { bodies, restore } = captureRequests()
    click('add-channel-next')
    await flushPromises()

    // 第 2 步：模型选择器（mock 的 discover 给 8 个，其中 2 个已有同名对外模型）
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('deepseek-chat'), {
      timeout: 5000,
    })
    expect(document.body.textContent ?? '').toContain('已有，只加渠道')

    // 勾两个新模型（真实点击之间会重渲染，两次点击之间要让 Vue 走一轮）
    clickBox('deepseek-chat')
    await nextTick()
    clickBox('glm-4.7')
    await nextTick()
    expect(document.body.textContent ?? '').toContain('添加 2 个模型')

    click('picker-submit')
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('还没定价'), { timeout: 5000 })
    restore()

    const importRequest = bodies.find((item) => item.url.includes('/api/admin/relay/models/import'))
    expect(importRequest, '应发出 import 请求').toBeTruthy()
    expect(importRequest!.body['price'], 'import 不带 price（新模型先按未定价建）').toBeUndefined()
    expect(importRequest!.body['models']).toHaveLength(2)
    expect(
      (importRequest!.body['models'] as { upstreamModel: string }[]).map((m) => m.upstreamModel),
    ).toEqual(['deepseek-chat', 'glm-4.7'])

    // 渠道真的建出来了（倍率 1.5）
    const created = relayState().channels.find((channel) => channel.name === '演示渠道')
    expect(created?.ratePermille).toBe(1500)
    expect(created?.keys).toHaveLength(2)

    // 成功提示 +「去定价」
    expect(document.body.textContent ?? '').toContain('已添加 2 个模型，还没定价')
    click('picker-goto-pricing')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/admin/models')
    expect(router.currentRoute.value.query).toEqual({ tab: 'models', unpriced: '1' })

    wrapper.unmount()
  })

  it('倍率填错时停在第一步并提示；密钥为空也不给下一步', async () => {
    useMock()
    const { wrapper } = await mountDialog(AddChannelDialog, {})

    setInput('add-channel-name', '演示渠道')
    setInput('add-channel-url', 'https://demo.example.com/v1')
    setInput('add-channel-rate', '1.2345')
    await nextTick()
    click('add-channel-next')
    await flushPromises()
    expect(document.body.textContent ?? '').toContain('至少填一把密钥')

    setInput('add-channel-keys', 'sk-demo-1')
    await nextTick()
    click('add-channel-next')
    await flushPromises()
    expect(document.body.textContent ?? '').toContain('倍率填 0–100 的数字，最多 3 位小数')
    wrapper.unmount()
  })
})

describe('模型选择器（渠道 Tab 的「选择模型」）', () => {
  it('取消勾选已有模型 → 二次确认 → PATCH 的 routes 不含本渠道；取消则勾选恢复', async () => {
    useMock()
    const channel = relayState().channels.find((item) => item.id === 1)!
    const { wrapper } = await mountDialog(RelayModelPickerDialog, {
      channel,
      channels: relayState().channels,
    })

    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('deepseek-v3'), {
      timeout: 5000,
    })
    // 本渠道已有的两条路由默认勾上（deepseek-v4.1-flash、deepseek-v3）
    expect(document.body.textContent ?? '').toContain('已选 2 /')

    // 先试「取消」：勾选恢复
    clickBox('deepseek-v3')
    await nextTick()
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('从本渠道移除模型？'), {
      timeout: 5000,
    })
    expect(document.body.textContent ?? '').toContain('模型和价格保留')
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('.picker__footer button')].find(
      (button) => button.textContent?.includes('取消'),
    )
    cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(isChecked('deepseek-v3')).toBe(true)

    // 再来一次，这次确认
    const { bodies, restore } = captureRequests()
    clickBox('deepseek-v3')
    await nextTick()
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('从本渠道移除模型？'), {
      timeout: 5000,
    })
    click('picker-confirm-remove')
    await flushPromises()
    restore()

    const patch = bodies.find((item) => /\/api\/admin\/relay\/models\/\d+$/.test(item.url))
    expect(patch, '应 PATCH 那个模型').toBeTruthy()
    const routes = patch!.body['routes'] as { channelId: number; upstreamModel: string }[]
    expect(routes.some((route) => route.channelId === 1)).toBe(false)
    expect(routes).toHaveLength(1)
    expect(routes[0]!.channelId).toBe(2)

    // 假状态真的改了：模型 2 不再挂渠道 1
    const model = relayState().models.find((item) => item.name === 'deepseek-v3')!
    expect(model.routes.some((route) => route.channelId === 1)).toBe(false)
    wrapper.unmount()
  })

  it('discover 失败的渠道：显示原因，手动添加照常可用（import 也不带 price）', async () => {
    useMock()
    const channel = relayState().channels.find((item) => item.id === 3)!
    const { wrapper } = await mountDialog(RelayModelPickerDialog, {
      channel,
      channels: relayState().channels,
    })

    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('拉取上游模型列表失败'), {
      timeout: 5000,
    })
    expect(document.body.textContent ?? '').toContain('连接上游超时')

    setInput('picker-manual', 'my-custom-model')
    await nextTick()
    const addButton = [...document.body.querySelectorAll<HTMLButtonElement>('.picker__manual button')][0]!
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(document.body.textContent ?? '').toContain('my-custom-model')
    expect(document.body.textContent ?? '').toContain('添加 1 个模型')

    const { bodies, restore } = captureRequests()
    click('picker-submit')
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('还没定价'), { timeout: 5000 })
    restore()

    const importRequest = bodies.find((item) => item.url.includes('/api/admin/relay/models/import'))
    expect(importRequest!.body['price']).toBeUndefined()
    expect((importRequest!.body['models'] as { upstreamModel: string }[])[0]!.upstreamModel).toBe(
      'my-custom-model',
    )
    wrapper.unmount()
  })
})
