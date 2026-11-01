import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NRadio } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import { reauthDialog, resetReauthDialog, resolveReauth } from '@/composables/useReauth'
import AdminAgentModeView from '@/views/admin/AdminAgentModeView.vue'

/**
 * Claude Code / Codex 管理页（18 §6）：
 * 两个地址共用一个视图、四个标签与 `?tab=` 同步、保存只发改过的字段、
 * 两种 targets 写法、下发弹窗经二次密码后调 deliver 并显示任务进度。
 *
 * 全程走 `?mock=agent-modes` 假接口；弹窗内容传送到 body，断言查 `document.body`。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetRelayMock()
  setMockScenario('agent-modes')
  restores.push(installMockFetch('agent-modes'))
}

beforeEach(() => {
  resetReauthDialog()
})

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  resetReauthDialog()
  // 平台记忆值（docs/22 §1.2）会跨用例残留：进入过桌面侧的用例要清掉，后面的云上用例才从 cloud 起
  window.localStorage.clear()
  document.body.innerHTML = ''
})

function withMessages(component: unknown, props: Record<string, unknown>) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never, props) }),
  })
}

async function mountPage(
  mode: 'claude-code' | 'codex',
  path = `/admin/${mode}`,
): Promise<{
  wrapper: ReturnType<typeof mount>
  router: Router
  props: { mode: 'claude-code' | 'codex' }
}> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  // 用 reactive 的 props 对象：路由切换 mode 那一幕可以像真路由一样改它
  const props = reactive<{ mode: 'claude-code' | 'codex' }>({ mode })
  const wrapper = mount(withMessages(AdminAgentModeView, props), {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  wrappers.push(wrapper)
  return { wrapper, router, props }
}

async function clickTab(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const tab = wrapper.findAll('.n-tabs-tab').find((item) => item.text().includes(label))
  expect(tab, `应有「${label}」标签`).toBeTruthy()
  await tab!.trigger('click')
  await flushPromises()
}

function setInput(testid: string, value: string): void {
  const input = document.body.querySelector<HTMLInputElement>(`[data-testid="${testid}"] input`)
  expect(input, `找不到输入框 ${testid}`).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
}

function clickBody(testid: string): void {
  const element = document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  expect(element, `找不到 ${testid}`).toBeTruthy()
  element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function captureRequests(): {
  requests: { url: string; method: string; body: Record<string, unknown> | null }[]
  restore: () => void
} {
  const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body:
        typeof init?.body === 'string' && init.body.startsWith('{')
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    })
    return original(input, init)
  }) as typeof fetch
  return { requests, restore: () => (globalThis.fetch = original) }
}

describe('路由与页面外壳', () => {
  it('路由表有 /admin/claude-code 与 /admin/codex（mode 由路由传入）', () => {
    const claude = routes.find((route) => route.path === '/admin/claude-code')
    const codex = routes.find((route) => route.path === '/admin/codex')
    expect(claude?.props).toEqual({ mode: 'claude-code' })
    expect(codex?.props).toEqual({ mode: 'codex' })
    expect(claude?.meta?.title).toBe('Claude Code')
    expect(codex?.meta?.title).toBe('Codex')
  })

  it('Claude Code：四个标签（下发 / 渠道 / 模型与价格 / 用量）、默认下发、warnings 顶部告警条', async () => {
    useMock()
    const { wrapper } = await mountPage('claude-code')

    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })

    const labels = wrapper.findAll('.n-tabs-tab').map((tab) => tab.text().trim())
    expect(labels).toEqual(['下发', '渠道', '模型与价格', '用量'])
    expect(wrapper.text()).toContain('内部监听器')
    expect(wrapper.find('[data-testid="agent-mode-warning"]').exists()).toBe(true)
    // 待下发：主按钮带人数
    expect(wrapper.find('[data-testid="agent-mode-pending"]').exists()).toBe(true)
    expect(document.body.querySelector('[data-testid="agent-mode-deliver"]')?.textContent).toContain('下发（')
    // 插件卡
    expect(wrapper.text()).toContain('@local/dsh-claude-pilot')
    expect(wrapper.text()).toContain('0.4.0')
    // 用户表：三个人 + 一个已移出
    expect(wrapper.text()).toContain('mint')
    expect(wrapper.text()).toContain('sakura')
    expect(wrapper.text()).toContain('butter')
    expect(wrapper.text()).toContain('quiet-leaf')
    expect(wrapper.text()).toContain('已移出')
    expect(wrapper.text()).toContain('待下发')
    wrapper.unmount()
  })

  it('?tab= 同步：切到「模型与价格」写进查询串，模型页没有「默认思考」且价格乘整体倍率', async () => {
    useMock()
    const { wrapper, router } = await mountPage('claude-code', '/admin/claude-code?tab=channels')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Anthropic 官方'), { timeout: 5000 })

    await clickTab(wrapper, '模型与价格')
    await vi.waitFor(() => expect(router.currentRoute.value.query['tab']).toBe('models'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })

    expect(wrapper.text()).toContain('实际单价')
    // 3 积分 / 百万 token × 整体倍率 ×1.5 = 4.5
    expect(wrapper.text()).toContain('4.5')
    // 18 §6：对话模式不显示「下发到 DSH」与「默认思考」
    expect(wrapper.text()).not.toContain('默认思考')
    expect(wrapper.text()).not.toContain('下发到用户的 DSH')
    wrapper.unmount()
  })

  it('桌面平台：只显示对应 pilot 的 hubMode 配置片段，没有云上的四个标签', async () => {
    useMock()
    const { wrapper } = await mountPage('claude-code', '/admin/claude-code?platform=desktop')

    await vi.waitFor(() => expect(wrapper.find('[data-testid="agent-mode-desktop"]').exists()).toBe(true), {
      timeout: 5000,
    })
    expect(wrapper.findAll('.n-tabs-tab')).toHaveLength(0)
    expect(wrapper.text()).toContain('claude-pilot')
    expect(wrapper.find('[data-testid="agent-fragment-hubmode"]').exists()).toBe(true)

    const codex = await mountPage('codex', '/admin/codex?platform=desktop')
    await vi.waitFor(() => expect(codex.wrapper.text()).toContain('codex-pilot'), { timeout: 5000 })
    expect(codex.wrapper.text()).not.toContain('claude-pilot')
  })

  it('Codex：没有小模型、插件库里没有、用户表为空；mode 切换后标题跟着变', async () => {
    useMock()
    const { wrapper, props } = await mountPage('codex')
    await vi.waitFor(() => expect(wrapper.text()).toContain('插件库里还没有这个插件'), { timeout: 5000 })

    expect(wrapper.text()).not.toContain('小模型')
    expect(wrapper.text()).toContain('@local/dsh-codex-pilot')
    expect(document.body.querySelector('[data-testid="agent-mode-goto-plugins"]')).toBeTruthy()
    expect(wrapper.find('[data-testid="agent-mode-pending"]').exists()).toBe(false)

    props.mode = 'claude-code'
    await vi.waitFor(() => expect(wrapper.text()).toContain('@local/dsh-claude-pilot'), { timeout: 5000 })
    wrapper.unmount()
  })
})

describe('保存设置', () => {
  it('只发改过的字段：倍率 1.5 → 2 只发 ratePermille；保存后表单显示新值', async () => {
    useMock()
    const { wrapper } = await mountPage('claude-code')
    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })

    expect(
      document.body.querySelector<HTMLInputElement>('[data-testid="agent-mode-rate"] input')?.value,
    ).toBe('1.5')

    const { requests, restore } = captureRequests()
    setInput('agent-mode-rate', '2')
    await flushPromises()
    clickBody('agent-mode-save')
    await vi.waitFor(() => expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1), {
      timeout: 5000,
    })
    restore()

    const put = requests.find((request) => request.method === 'PUT')!
    expect(put.url).toBe('/api/admin/agent-modes/claude-code')
    expect(put.body).toEqual({ ratePermille: 2000 })
    await vi.waitFor(
      () =>
        expect(
          document.body.querySelector<HTMLInputElement>('[data-testid="agent-mode-rate"] input')?.value,
        ).toBe('2'),
      { timeout: 5000 },
    )

    // 提示语是「已保存，…即时生效」一句
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('已保存，模型和价格即时生效'), {
      timeout: 5000,
    })
    wrapper.unmount()
  })

  it('targets 写法一：切到「所有用户」→ PUT targets {all:true}', async () => {
    useMock()
    const { wrapper } = await mountPage('claude-code')
    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })

    const all = wrapper.findAllComponents(NRadio).find((radio) => radio.text().includes('所有用户'))
    expect(all, '应有「所有用户」').toBeTruthy()
    await all!.find('input').setValue()
    await flushPromises()

    const { requests, restore } = captureRequests()
    clickBody('agent-mode-save')
    await vi.waitFor(() => expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1), {
      timeout: 5000,
    })
    restore()
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
      targets: { all: true },
    })
    wrapper.unmount()
  })

  it('targets 写法二：指定用户保持 userIds（不写字面量 all）', async () => {
    useMock()
    const { wrapper } = await mountPage('claude-code')
    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })

    const specific = wrapper.findAllComponents(NRadio).find((radio) => radio.text().includes('指定用户'))
    expect(specific?.find('input').element.checked).toBe(true)

    // 只改显示名：targets 不应该出现在 PUT 里
    const { requests, restore } = captureRequests()
    setInput('agent-mode-label', '我的 Claude')
    await flushPromises()
    clickBody('agent-mode-save')
    await vi.waitFor(() => expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1), {
      timeout: 5000,
    })
    restore()
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({ label: '我的 Claude' })
    wrapper.unmount()
  })
})

describe('下发', () => {
  it('弹窗选重启时机与自动装插件 → 二次密码 → POST deliver → 页内任务进度', async () => {
    useMock()
    const { wrapper } = await mountPage('claude-code')
    await vi.waitFor(() => expect(wrapper.text()).toContain('claude-sonnet-5-5'), { timeout: 5000 })

    clickBody('agent-mode-deliver')
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('什么时候生效'), {
      timeout: 5000,
    })

    const { requests, restore } = captureRequests()
    clickBody('agent-deliver-confirm')
    await vi.waitFor(() => expect(reauthDialog.visible).toBe(true), { timeout: 5000 })
    resolveReauth()

    await vi.waitFor(
      () => expect(requests.filter((request) => request.url.includes('/deliver'))).toHaveLength(1),
      { timeout: 5000 },
    )
    restore()

    const deliver = requests.find((request) => request.url.includes('/deliver'))!
    expect(deliver.method).toBe('POST')
    expect(deliver.url).toBe('/api/admin/agent-modes/claude-code/deliver')
    expect(deliver.body).toEqual({ restart: 'now', installPlugin: true })

    await vi.waitFor(() => expect(wrapper.find('[data-testid="agent-mode-job"]').exists()).toBe(true), {
      timeout: 5000,
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('模式配置下发'), { timeout: 5000 })
    expect(wrapper.find('[data-testid="agent-mode-job-link"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
