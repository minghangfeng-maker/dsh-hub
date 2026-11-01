import type { UserAdminView } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'

import UserEnvironmentTab from '@/components/admin/UserEnvironmentTab.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import { ADMIN_USERS } from '@/mocks/admin'
import { installMockFetch } from '@/mocks/fetch'
import { resetMockJobs } from '@/mocks/jobs'
import { resetRelayMock, relayState } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'
import { resetReauthDialog } from '@/composables/useReauth'
import AdminModelsView from '@/views/admin/AdminModelsView.vue'

/**
 * 「模型 → 下发到 DSH」Tab（16 §6.3，WP20b）：
 * 平铺成一行一个「模型@标识」，勾选路由、设默认路由、保存发 `routeIds` + `defaultRouteId`；
 * 后端没给 `routes` 时退回按模型选择的老界面并保存老写法。
 * 另外覆盖下发流程（确认弹窗 → reauth → POST 不含 presetId）、未保存提示与离开确认。
 *
 * 全走 `?mock=admin*` 假接口（不连任何真实后端）。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(scenario: MockScenario = 'admin'): void {
  resetRelayMock()
  resetMockJobs()
  resetReauthDialog()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  resetReauthDialog()
  setMockScenario('running')
  resetRelayMock()
  resetMockJobs()
  // 平台记忆值（docs/22 §1.2）会跨用例残留：进过桌面侧的用例要清掉
  window.localStorage.clear()
  document.body.innerHTML = ''
})

/** 包一层 NMessageProvider（`useMessage` 需要它）；整个文件只用这一处 defineComponent */
function host(render: () => ReturnType<typeof h>) {
  return defineComponent({ render })
}

function withMessages(component: unknown, props: Record<string, unknown> = {}) {
  return host(() => h(NMessageProvider, null, { default: () => h(component as never, props) }))
}

async function mountModels(path = '/admin/models?tab=dsh') {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const wrapper = mount(withMessages(AdminModelsView), {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  wrappers.push(wrapper)
  return { wrapper, router }
}

async function openDsh() {
  const mounted = await mountModels()
  await vi.waitFor(() => expect(testid('dsh-rollout')).toBeTruthy(), { timeout: 5000 })
  await vi.waitFor(() => expect(mounted.wrapper.text()).toContain('deepseek-v4.1-flash@upstream-b'), {
    timeout: 5000,
  })
  return mounted
}

/**
 * 经过真正的 `RouterView` 挂载：`onBeforeRouteLeave` 只有在 RouterView 提供路由上下文时才生效，
 * 所以「路由离开被拦下」这一条必须这么挂。
 */
async function mountWithRouterView(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const wrapper = mount(
    host(() => h(NMessageProvider, null, { default: () => h(RouterView) })),
    { global: { plugins: [router] }, attachTo: document.body },
  )
  await flushPromises()
  wrappers.push(wrapper)
  return { wrapper, router }
}

function testid(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

function clickTestid(id: string): void {
  const element = testid(id)
  expect(element, `应有 ${id}`).toBeTruthy()
  element!.click()
}

/** 点勾选框 / 单选框本身（`data-testid` 有时候挂在外面那层容器上） */
function clickControl(id: string): void {
  const element = testid(id)
  expect(element, `应有 ${id}`).toBeTruthy()
  const control = element!.matches('.n-checkbox, .n-radio')
    ? element!
    : element!.querySelector<HTMLElement>('.n-checkbox, .n-radio')
  ;(control ?? element!).click()
}

/** 勾选框 / 单选框的根元素带 `n-checkbox--disabled` / `n-radio--disabled`（禁用时点不动） */
function disabledControl(id: string): boolean {
  const element = testid(id)
  expect(element, `应有 ${id}`).toBeTruthy()
  const control = element!.matches('.n-checkbox, .n-radio')
    ? element!
    : element!.querySelector('.n-checkbox, .n-radio')
  expect(control, `${id} 里应有勾选框 / 单选框`).toBeTruthy()
  return (
    control!.classList.contains('n-checkbox--disabled') || control!.classList.contains('n-radio--disabled')
  )
}

/** 拦截写请求的 JSON 体（假 fetch 仍然照常回数据） */
function captureBodies(): { url: string; method: string; body: Record<string, unknown> }[] {
  const captured: { url: string; method: string; body: Record<string, unknown> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && typeof init?.body === 'string' && init.body.startsWith('{')) {
      captured.push({ url: String(input), method, body: JSON.parse(init.body) as Record<string, unknown> })
    }
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return captured
}

/** 把 GET `/api/admin/relay/dsh` 的 `routes` / `defaultRouteId` 去掉，模拟 WP20a 之前的老后端 */
function stripRouteFields(): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const response = await original(input, init)
    if (method === 'GET' && String(input).includes('/api/admin/relay/dsh') && response.status === 200) {
      const data = (await response.clone().json()) as {
        models: (Record<string, unknown> & { routes?: unknown })[]
        defaultRouteId?: unknown
      }
      const models = data.models.map(({ routes: _routes, ...rest }) => rest)
      const payload = { ...data, models }
      delete payload.defaultRouteId
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    return response
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
}

describe('「下发到 DSH」Tab：按「模型 × 渠道」平铺（16 §6.3）', () => {
  it('页头显示「默认：模型@标识」，每个路由一行：模型名 / 渠道 + 倍率 / 协议 / 默认思考 / 默认单选', async () => {
    useMock()
    const { wrapper } = await openDsh()

    expect(testid('dsh-default-label')?.textContent?.trim()).toBe('deepseek-v4.1-flash@upstream-b')
    const text = wrapper.text()
    expect(text).toContain('deepseek-v4.1-flash@upstream-c')
    expect(text).toContain('deepseek-v4.1-flash@upstream-b')
    expect(text).toContain('deepseek-v4.1-flash@official')
    expect(text).toContain('qwen3-coder@upstream-b')
    expect(text).toContain('Upstream C 池 ×0.3')
    expect(text).toContain('Upstream B ×0.1')
    expect(text).toContain('DeepSeek 官方 ×1')
    expect(testid('dsh-blocked-101')?.textContent ?? '').toContain('已选中但渠道已停用')

    expect(disabledControl('dsh-default-102')).toBe(false)
    expect(disabledControl('dsh-default-106')).toBe(true)

    expect(testid('dsh-thinking-102')?.textContent?.trim()).toBe('max')
    expect(testid('dsh-thinking-105')?.textContent?.trim()).toBe('—')
    expect(wrapper.find('a[href="/admin/models?tab=models&edit=1"]').exists()).toBe(true)
    const tip = wrapper.findComponent(InfoTip)
    expect(tip.exists()).toBe(true)
    expect(String(tip.props('text')).replace(/\u00a0/g, ' ')).toContain(
      '用户在 DSH 里看到的提供方都叫「DSH Hub」',
    )
    wrapper.unmount()
  })

  it('默认单选：勾上未选中的路由 → 可设为默认；取消默认那一行后默认落到剩下第一个可下发的', async () => {
    useMock()
    const { wrapper } = await openDsh()

    clickControl('dsh-check-106')
    await flash()
    expect(disabledControl('dsh-default-106')).toBe(false)
    clickControl('dsh-default-106')
    await flash()
    await vi.waitFor(
      () => expect(testid('dsh-savebar')?.textContent ?? '').toContain('默认 claude-sonnet-4.6@official'),
      { timeout: 5000 },
    )
    // 初始 4 个 + 新勾 106 = 5 个
    expect(testid('dsh-savebar')?.textContent ?? '').toContain('已选 5 个')

    // 取消刚设为默认的 106 → 默认落到剩下第一个可下发的（103 deepseek@official）
    clickControl('dsh-check-106')
    await flash()
    await vi.waitFor(
      () => expect(testid('dsh-savebar')?.textContent ?? '').toContain('默认 deepseek-v4.1-flash@official'),
      { timeout: 5000 },
    )
    expect(testid('dsh-savebar')?.textContent ?? '').toContain('已选 4 个')
    wrapper.unmount()
  })

  it('阻断行：新勾不上、鼠标悬停有原因；已选中但被阻断的仍可取消勾选', async () => {
    useMock()
    const { wrapper } = await openDsh()

    expect(disabledControl('dsh-check-104')).toBe(true)
    expect(testid('dsh-check-104')?.getAttribute('title')).toContain('渠道已停用')
    expect(disabledControl('dsh-check-101')).toBe(false)
    expect(testid('dsh-blocked-101')?.textContent ?? '').toContain('已选中但渠道已停用')

    testid('dsh-check-104')!.click()
    await flash()
    expect(testid('dsh-savebar')).toBeNull()
    expect(wrapper.text()).toContain('只看已选（4）')

    clickControl('dsh-check-101')
    await flash()
    await vi.waitFor(() => expect(testid('dsh-savebar')?.textContent ?? '').toContain('已选 3 个'), {
      timeout: 5000,
    })
    expect(disabledControl('dsh-check-101')).toBe(true)
    wrapper.unmount()
  })

  it('工具栏：按模型本名搜索、全选可下发的、只看已选', async () => {
    useMock()
    const { wrapper } = await openDsh()

    const search = wrapper.find('[data-testid="dsh-search"] input')
    await search.setValue('qwen')
    await flash()
    const filteredNames = wrapper.findAll('.relay-dsh__name').map((node) => node.text())
    expect(filteredNames).toContain('qwen3-coder@upstream-b')
    expect(filteredNames.some((name) => name.startsWith('deepseek-v4.1-flash@'))).toBe(false)
    await search.setValue('')
    await flash()

    clickTestid('dsh-selected-only')
    await flash()
    const selectedNames = wrapper.findAll('.relay-dsh__name').map((node) => node.text())
    expect(selectedNames).toContain('qwen3-coder@upstream-b')
    expect(selectedNames).not.toContain('glm-4.7-air@official')
    clickTestid('dsh-selected-only')
    await flash()

    clickTestid('dsh-select-all')
    await flash()
    await vi.waitFor(() => expect(testid('dsh-savebar')?.textContent ?? '').toContain('已选 8 个'), {
      timeout: 5000,
    })

    clickTestid('dsh-select-all')
    await flash()
    expect(testid('dsh-select-all')?.hasAttribute('disabled')).toBe(true)
    wrapper.unmount()
  })

  it('保存发新写法：routeIds + defaultRouteId（默认模型 / 路由整体替换）', async () => {
    useMock()
    const { wrapper } = await openDsh()

    clickControl('dsh-check-106')
    await flash()
    const captured = captureBodies()
    clickTestid('dsh-save')
    await vi.waitFor(
      () => expect(captured.some((item) => item.url.includes('/api/admin/relay/dsh'))).toBe(true),
      { timeout: 5000 },
    )

    const put = captured.find((item) => item.url.includes('/api/admin/relay/dsh'))!
    expect(put.method).toBe('PUT')
    expect([...(put.body['routeIds'] as number[])].sort((a, b) => a - b)).toEqual([101, 102, 103, 106, 108])
    expect(put.body['defaultRouteId']).toBe(102)
    await vi.waitFor(() => expect(testid('dsh-savebar')).toBeNull(), { timeout: 5000 })
    expect(testid('dsh-pending')).toBeTruthy()
    wrapper.unmount()
  })

  it('后端没给 routes：退回按模型选择的老界面，保存发 modelIds + defaultModelId', async () => {
    useMock()
    stripRouteFields()
    const { wrapper } = await mountModels()
    await vi.waitFor(() => expect(testid('dsh-rollout')).toBeTruthy(), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('deepseek-v4.1-flash'), { timeout: 5000 })

    expect(wrapper.text()).not.toContain('@upstream-b')
    expect(wrapper.text()).toContain('DeepSeek V4.1 Flash')
    expect(testid('dsh-check-1')).toBeTruthy()
    expect(disabledControl('dsh-default-2')).toBe(true)

    clickControl('dsh-check-2')
    await flash()
    const captured = captureBodies()
    clickTestid('dsh-save')
    await vi.waitFor(
      () => expect(captured.some((item) => item.url.includes('/api/admin/relay/dsh'))).toBe(true),
      { timeout: 5000 },
    )

    const put = captured.find((item) => item.url.includes('/api/admin/relay/dsh'))!
    expect(put.body).toEqual({ modelIds: [1, 4, 2], defaultModelId: 1 })
    wrapper.unmount()
  })
})

describe('「模型配置」Tab：下发入口（docs/22 §3）', () => {
  it('点「下发」跳到统一向导，只预选当前平台（云上 → 实例）+ 模型与 API 配置', async () => {
    useMock()
    const { wrapper, router } = await openDsh()

    clickTestid('dsh-rollout')
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/rollouts'), {
      timeout: 5000,
    })
    expect(router.currentRoute.value.query['platforms']).toBe('instance')
    expect(router.currentRoute.value.query['items']).toBe('models')
    expect(testid('dsh-rollout-dialog')).toBeNull()
    wrapper.unmount()
  })

  it('有未保存改动时点「下发」先提示保存，不跳走', async () => {
    useMock()
    const { wrapper, router } = await openDsh()

    clickControl('dsh-check-103')
    await flash()
    clickTestid('dsh-rollout')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/admin/models')
    expect(testid('dsh-save-hint')?.textContent ?? '').toContain('先点「保存」再下发')
    expect(wrapper.text()).toContain('先点「保存」再下发')
    wrapper.unmount()
  })

  it('桌面「上次下发」显示清单 revision、时间与操作人；云上不显示这一块', async () => {
    useMock()
    const { wrapper } = await mountModels()
    await vi.waitFor(() => expect(testid('dsh-rollout')).toBeTruthy(), { timeout: 5000 })
    // 云上仍是「实例下发任务」那一行，没有桌面清单字段
    await vi.waitFor(() => expect(testid('dsh-last-job')).toBeTruthy(), { timeout: 5000 })
    expect(testid('dsh-last-delivery')).toBeNull()

    clickTestid('platform-desktop')
    // 切平台会重新拉桌面预设，等数据回来再断言
    await vi.waitFor(() => expect(testid('dsh-last-delivery')?.textContent).toContain('清单 #3'), {
      timeout: 5000,
    })
    const block = testid('dsh-last-delivery')!
    expect(block.textContent).toContain('由 admin')
    // 时间给相对时间 + 悬浮看绝对时间（docs/22 §3 的 lastDelivery.at）
    const at = testid('dsh-last-delivery-at')!
    expect(at.textContent?.trim()).not.toBe('')
    expect(at.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} /)
    wrapper.unmount()
  })

  it('桌面还没下发过：显示「还没下发过」', async () => {
    useMock('admin-empty-dsh')
    const { wrapper } = await mountModels('/admin/models?tab=dsh&platform=desktop')
    await vi.waitFor(() => expect(testid('dsh-last-delivery-empty')).toBeTruthy(), { timeout: 5000 })
    expect(testid('dsh-last-delivery-empty')?.textContent).toContain('还没下发过')
    wrapper.unmount()
  })

  it('切到桌面平台：读写桌面预设（?platform=desktop），下发入口只预选桌面', async () => {
    useMock()
    const { wrapper, router } = await mountModels()
    await vi.waitFor(() => expect(testid('dsh-rollout')).toBeTruthy(), { timeout: 5000 })
    // 云上默认预设：4 个选中路由
    await vi.waitFor(() => expect(wrapper.text()).toContain('只看已选（4）'), { timeout: 5000 })

    clickTestid('platform-desktop')
    await vi.waitFor(() => expect(router.currentRoute.value.query['platform']).toBe('desktop'), {
      timeout: 5000,
    })
    // 桌面预设是另一套：2 个选中路由（route 102 + 106），默认仍是 102
    await vi.waitFor(() => expect(wrapper.text()).toContain('只看已选（2）'), { timeout: 5000 })
    expect(testid('dsh-platform-tag')?.textContent?.trim()).toBe('桌面端')
    expect(testid('dsh-default-label')?.textContent?.trim()).toBe('deepseek-v4.1-flash@upstream-b')

    const captured = captureBodies()
    clickControl('dsh-check-103')
    await flash()
    clickTestid('dsh-save')
    await vi.waitFor(
      () =>
        expect(
          captured.some(
            (item) => item.url.includes('/api/admin/relay/dsh?platform=desktop') && item.method === 'PUT',
          ),
        ).toBe(true),
      { timeout: 5000 },
    )
    await vi.waitFor(() => expect(testid('dsh-savebar')).toBeNull(), { timeout: 5000 })

    clickTestid('dsh-rollout')
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/rollouts'), {
      timeout: 5000,
    })
    expect(router.currentRoute.value.query['platforms']).toBe('desktop')
    expect(router.currentRoute.value.query['items']).toBe('models')
    wrapper.unmount()
  })
})

describe('「下发到 DSH」Tab：离开页面（12 §10）', () => {
  it('有未保存改动时切 Tab 先弹确认；选「留下继续改」不切走，选「丢掉改动并离开」才切', async () => {
    useMock()
    const { wrapper, router } = await openDsh()

    clickControl('dsh-check-103')
    await flash()

    const modelsTab = wrapper.findAll('.n-tabs-tab').find((tab) => tab.text().includes('模型与价格'))!
    await modelsTab.trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(testid('dsh-leave-dialog')).toBeTruthy(), { timeout: 5000 })

    clickTestid('dsh-leave-cancel')
    await flushPromises()
    expect(router.currentRoute.value.query['tab']).toBe('dsh')
    expect(wrapper.text()).toContain('deepseek-v4.1-flash@upstream-b')

    await modelsTab.trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(testid('dsh-leave-discard')).toBeTruthy(), { timeout: 5000 })
    clickTestid('dsh-leave-discard')
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.query['tab']).toBe('models'), { timeout: 5000 })
    wrapper.unmount()
  })

  it('没有未保存改动时切 Tab 不打扰', async () => {
    useMock()
    const { wrapper, router } = await openDsh()

    const channelsTab = wrapper.findAll('.n-tabs-tab').find((tab) => tab.text().includes('渠道'))!
    await channelsTab.trigger('click')
    await flushPromises()
    expect(testid('dsh-leave-dialog')).toBeNull()
    await vi.waitFor(() => expect(router.currentRoute.value.query['tab']).toBe('channels'), { timeout: 5000 })
    wrapper.unmount()
  })

  it('有未保存改动时路由离开被拦下（onBeforeRouteLeave）', async () => {
    useMock()
    const { router } = await mountWithRouterView('/admin/models?tab=dsh')
    await vi.waitFor(() => expect(testid('dsh-check-103')).toBeTruthy(), { timeout: 5000 })

    clickControl('dsh-check-103')
    await flash()

    void router.push('/admin/users')
    await flushPromises()
    await vi.waitFor(() => expect(testid('dsh-leave-dialog')).toBeTruthy(), { timeout: 5000 })
    expect(router.currentRoute.value.path).toBe('/admin/models')

    clickTestid('dsh-leave-discard')
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/users'), { timeout: 5000 })
  })
})

describe('其它页面的简化（WP12，12 §10）', () => {
  it('用户详情「环境」Tab 不再有预设下拉与 per-user 密钥表单，只有只读一行 + 链接', async () => {
    useMock()
    const user = ADMIN_USERS[0] as UserAdminView
    const wrapper = mount(withMessages(UserEnvironmentTab, { user }), {
      global: {
        plugins: [createRouter({ history: createMemoryHistory(), routes })],
      },
      attachTo: document.body,
    })
    wrappers.push(wrapper)
    await flushPromises()

    await vi.waitFor(() => expect(wrapper.text()).toContain('模型策略'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('2 个模型'), { timeout: 5000 })
    const text = wrapper.text()
    expect(text).toContain('模型：由')
    expect(text).toContain('「模型 → 下发到 DSH」')
    expect(text).toContain('统一配置')
    expect(text).toContain('2 个模型')
    expect(text).toContain('默认 DeepSeek V4.1 Flash')

    expect(text).not.toContain('模型预设')
    expect(text).not.toContain('per-user 模型密钥')
    expect(text).not.toContain('专属密钥')
    expect(wrapper.find('a[href="/admin/models?tab=dsh"]').exists()).toBe(true)
    expect(text).toContain('管理员统一配置')
    wrapper.unmount()
  })

  it('假的 DSH 配置状态真的会变：PUT 后 GET 返回新的选中路由', async () => {
    useMock()
    expect(relayState().dshRouteIds).toEqual([103, 101, 102, 108])

    const response = await fetch('/api/admin/relay/dsh', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeIds: [103, 108], defaultRouteId: 103 }),
    })
    expect(response.status).toBe(200)
    expect(relayState().dshRouteIds).toEqual([103, 108])
    expect(relayState().dshDefaultRouteId).toBe(103)
    expect(relayState().dshDefaultModelId).toBe(1)

    const listed = (await (await fetch('/api/admin/relay/dsh')).json()) as {
      defaultRouteId: number
      models: { id: number; routes?: { routeId: number; selected: boolean }[] }[]
    }
    expect(listed.defaultRouteId).toBe(103)
    expect(
      listed.models
        .flatMap((model) => model.routes ?? [])
        .filter((route) => route.selected)
        .map((route) => route.routeId),
    ).toEqual([103, 108])

    const rejected = await fetch('/api/admin/relay/dsh', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeIds: [101], defaultRouteId: 101 }),
    })
    expect(rejected.status).toBe(400)
  })
})

/** `await flushPromises()` 的短别名：点 Naive 控件后让 Vue 走一轮 */
async function flash(): Promise<void> {
  await nextTick()
  await flushPromises()
}
