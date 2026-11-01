import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'

import AddChannelDialog from '@/components/admin/relay/AddChannelDialog.vue'
import ChannelDrawer from '@/components/admin/relay/ChannelDrawer.vue'
import { installMockFetch } from '@/mocks/fetch'
import { relayState, resetRelayMock } from '@/mocks/relay'
import { setMockScenario } from '@/mocks/state'

/**
 * 渠道标识（16 §2）：新建 / 编辑抽屉都有「标识」字段，格式不对在字段下报错、冲突显示服务端
 * `fields.slug`；编辑已有渠道改标识时给出「要重新下发 / 旧调用名会失效」的警告。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetRelayMock()
  setMockScenario('admin')
  restores.push(installMockFetch('admin'))
}

afterEach(() => {
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

async function mountDrawer(channelId = 2) {
  const channel = relayState().channels.find((item) => item.id === channelId)!
  const props = reactive<Record<string, unknown>>({ show: false, channel })
  const wrapper = mount(withMessages(ChannelDrawer, props), { attachTo: document.body })
  props.show = true
  await nextTick()
  await flushPromises()
  wrappers.push(wrapper)
  return wrapper
}

function setInput(testid: string, value: string): void {
  const textarea = document.body.querySelector<HTMLTextAreaElement>(`[data-testid="${testid}"] textarea`)
  const input = document.body.querySelector<HTMLInputElement>(`[data-testid="${testid}"] input`)
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

function capturePatches(): { url: string; body: Record<string, unknown> }[] {
  const captured: { url: string; body: Record<string, unknown> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      String(input).includes('/api/admin/relay/channels/') &&
      (init?.method ?? 'GET').toUpperCase() === 'PATCH' &&
      typeof init?.body === 'string'
    ) {
      captured.push({ url: String(input), body: JSON.parse(init.body) as Record<string, unknown> })
    }
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return captured
}

describe('渠道抽屉的「标识」字段（16 §2 §5）', () => {
  it('格式不对：在字段下报错，不发 PATCH；改对后随保存一起发 slug', async () => {
    useMock()
    await mountDrawer()

    setInput('channel-slug', 'Bad Slug')
    await nextTick()
    const patches = capturePatches()
    click('channel-save')
    await flushPromises()

    expect(document.querySelector('[data-testid="channel-slug-error"]')?.textContent ?? '').toContain(
      '只能用小写字母、数字和 -',
    )
    expect(patches).toHaveLength(0)

    setInput('channel-slug', 'upstream-b-new')
    await nextTick()
    click('channel-save')
    await vi.waitFor(() => expect(patches).toHaveLength(1), { timeout: 5000 })
    expect(patches[0]?.body['slug']).toBe('upstream-b-new')
    expect(relayState().channels.find((item) => item.id === 2)?.slug).toBe('upstream-b-new')
  })

  it('服务端说标识冲突：错误显示在字段下（fields.slug）', async () => {
    useMock()
    await mountDrawer()

    setInput('channel-slug', 'upstream-c')
    await nextTick()
    click('channel-save')
    await flushPromises()

    await vi.waitFor(
      () =>
        expect(document.querySelector('[data-testid="channel-slug-error"]')?.textContent ?? '').toContain(
          '已经被别的渠道用了',
        ),
      { timeout: 5000 },
    )
    expect(relayState().channels.find((item) => item.id === 2)?.slug).toBe('upstream-b')
  })

  it('改了已有渠道的标识：出现「要重新下发 / 旧调用名失效」的警告', async () => {
    useMock()
    await mountDrawer()

    expect(document.querySelector('[data-testid="channel-slug-warning"]')).toBeNull()
    setInput('channel-slug', 'upstream-b-2')
    await nextTick()
    expect(document.querySelector('[data-testid="channel-slug-warning"]')?.textContent ?? '').toContain(
      '用户 DSH 里的模型名会变',
    )
    expect(document.querySelector('[data-testid="channel-slug-warning"]')?.textContent ?? '').toContain(
      '模型@旧标识',
    )
  })
})

describe('「添加渠道」的「标识」字段（16 §2）', () => {
  it('留空不提交 slug（服务端按名称生成）；填了就带上', async () => {
    useMock()
    const props = reactive<Record<string, unknown>>({ show: false })
    const wrapper = mount(withMessages(AddChannelDialog, props), { attachTo: document.body })
    props.show = true
    await nextTick()
    await flushPromises()
    wrappers.push(wrapper)

    setInput('add-channel-name', '演示渠道')
    setInput('add-channel-url', 'https://demo.example.com/v1')
    setInput('add-channel-keys', 'sk-demo-1')
    await nextTick()

    const bodies: Record<string, unknown>[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/admin/relay/channels') && (init?.method ?? 'GET') === 'POST') {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      }
      return original(input, init)
    }) as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })

    click('add-channel-next')
    await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 5000 })
    expect(bodies[0]).not.toHaveProperty('slug')
    // 中文名生成不出标识 → 退回 ch<id>（16 §2）
    expect(relayState().channels.find((item) => item.name === '演示渠道')?.slug).toMatch(/^ch\d+$/)
    wrapper.unmount()
  })
})
