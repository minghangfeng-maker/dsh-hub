import type { ModelProvider } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import ProviderDrawer from '@/components/admin/ProviderDrawer.vue'
import { ADMIN_PROVIDERS } from '@/mocks/admin'
import { installMockFetch } from '@/mocks/fetch'
import { relayState, resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'
import InfoTip from '@/components/base/InfoTip.vue'
import AdminModelsView from '@/views/admin/AdminModelsView.vue'

/**
 * 合并后的模型页 `/admin/models`（WP11b 交付物 1、12 §10；WP12b 把「DSH 配置」换成「下发到 DSH」；
 * WP19b 把「搜索池」拆成独立页）：七个 Tab 的顺序与标签、`?tab=` 同步与旧地址重定向、
 * 概览告警、模型与价格工具栏、提供方抽屉。
 *
 * 走 `?mock=admin` 的假接口；弹窗内容传送到 body，断言查 `document.body`。
 * 「下发到 DSH」Tab 自己的行为在 `test/relay-dsh-tab.test.ts`；「搜索池」在 `test/tools-admin.test.ts`。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(scenario: MockScenario = 'admin'): void {
  resetRelayMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  // 先卸载组件再清 body：Teleport 到 body 的弹窗留着的话，下一个用例会查到上一个弹窗的元素
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  // 平台记忆值（docs/22 §1.2）会跨用例残留
  window.localStorage.clear()
  document.body.innerHTML = ''
})

/** 包一层 NMessageProvider（`useMessage` 需要它），props 可以是普通对象或 reactive */
function withMessages(component: unknown, props: Record<string, unknown> = {}) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never, props) }),
  })
}

async function mountModels(path = '/admin/models') {
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

async function openTab(
  wrapper: { findAll: (selector: string) => { text: () => string; trigger: (e: string) => Promise<void> }[] },
  label: string,
) {
  const tab = wrapper.findAll('.n-tabs-tab').find((item) => item.text().includes(label))
  expect(tab, `应有「${label}」Tab`).toBeTruthy()
  await tab!.trigger('click')
  await flushPromises()
}

describe('/admin/models 七个 Tab（12 §10、15 §1）', () => {
  it('Tab 顺序与标签（WP19b 起不再有「搜索池」），默认「概览」并显示统计卡、渠道健康与告警', async () => {
    useMock()
    const { wrapper } = await mountModels()

    await vi.waitFor(() => expect(wrapper.text()).toContain('今日请求'), { timeout: 5000 })

    const labels = wrapper.findAll('.n-tabs-tab').map((tab) => tab.text().trim())
    expect(labels).toEqual(['概览', '渠道', '模型与价格', '模型配置', '积分', '用量记录', '设置'])
    const text = wrapper.text()
    expect(text).toContain('内部监听器')
    expect(text).toContain('渠道健康')
    expect(text).toContain('告警')
    expect(text).toContain('个模型还没定价') // models-unpriced（12 §10）
    expect(text).toContain('glm-4.7-air')
    // models-changed 的「去下发」跳统一向导（只预选当前平台 + 模型与 API 配置）
    expect(wrapper.find('a[href="/admin/rollouts?platforms=instance&items=models"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('概览的 models-unpriced 告警点「去定价」→ 切到「模型与价格」并打开「只看未定价」', async () => {
    useMock()
    const { wrapper, router } = await mountModels()

    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('个模型还没定价'), {
      timeout: 5000,
    })

    const action = document.body.querySelector<HTMLButtonElement>('[data-testid="alert-unpriced"]')
    expect(action, 'models-unpriced 告警应有「去定价」').toBeTruthy()
    action!.click()
    await flushPromises()

    await vi.waitFor(() => expect(router.currentRoute.value.query['tab']).toBe('models'), { timeout: 5000 })
    expect(router.currentRoute.value.query['unpriced']).toBe('1')
    await vi.waitFor(() => expect(wrapper.text()).toContain('只看未定价'), { timeout: 5000 })
    // 只看未定价：两个未定价模型还在，有价的被滤掉
    await vi.waitFor(() => expect(wrapper.text()).toContain('glm-4.7-air'), { timeout: 5000 })
    expect(wrapper.text()).toContain('kimi-k2-thinking')
    expect(wrapper.text()).not.toContain('deepseek-v4.1-flash')
    wrapper.unmount()
  })

  it('渠道 Tab：倍率列（×1.5 高亮）、模型数可点开选择器、密钥可用数', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=channels')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Upstream C 池'), { timeout: 5000 })

    const text = wrapper.text()
    expect(text).toContain('×0.3')
    expect(text).toContain('×0.1')
    expect(text).toContain('×1')
    // 16 §2：渠道表有「标识」列（用户会看到它）
    expect(text).toContain('标识')
    expect(text).toContain('upstream-c')
    expect(text).toContain('upstream-b')
    expect(text).toContain('official')
    expect(text).toContain('添加渠道')
    expect(text).toContain('选择模型')
    expect(text).toContain('已停用')
    expect(text).toContain('正常')
    // 07 §2.7：表格上方那段「一个渠道 = 一个上游端点 + …」的说明没了，
    // 「费用 = 模型价格 × 倍率」收进倍率列标题的 InfoTip
    expect(text).not.toContain('一个渠道 = 一个上游端点')
    const tip = wrapper.findComponent(InfoTip)
    expect(tip.exists(), '倍率列标题旁应有 InfoTip').toBe(true)
    expect(tip.props('text')).toContain('费用 = 模型价格 × 倍率')
    // 07 §2.8：列标题单行（「密钥 可用 / 总」不再折成两行）
    expect(text).toContain('密钥 可用 / 总')
    wrapper.unmount()
  })

  it('模型与价格 Tab：单位进列标题（价格 · 积分 / 百万 token），表格上方不再有说明行', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=models')
    await vi.waitFor(() => expect(wrapper.text()).toContain('deepseek-v4.1-flash'), { timeout: 5000 })

    expect(wrapper.text()).toContain('价格 · 积分 / 百万 token')
    expect(wrapper.text()).not.toContain('价格单位「积分 / 百万 token」')
    // 16 §5：渠道胶囊显示用户可见的「标识 ×倍率」
    expect(wrapper.text()).toContain('upstream-b ×0.1')
    expect(wrapper.text()).toContain('official ×1')
    wrapper.unmount()
  })

  it('模型与价格 Tab：工具栏（含模型信息库入口）、未定价/无渠道胶囊、models-changed 横幅跳统一下发', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=models')
    await vi.waitFor(() => expect(wrapper.text()).toContain('deepseek-v4.1-flash'), { timeout: 5000 })

    const text = wrapper.text()
    expect(text).toContain('模型列表有变化，通过统一下发同步到用户的实例或桌面端')
    expect(text).toContain('模型信息库')
    expect(wrapper.find('[data-testid="models-catalog"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/admin/rollouts?platforms=instance&items=models"]').exists()).toBe(true)
    expect(text).toContain('未定价')
    expect(text).toContain('无渠道')
    expect(text).toContain('只看未定价')
    expect(text).toContain('添加模型')

    // 搜索：只剩匹配的模型
    const search = wrapper.find('[data-testid="models-search"] input')
    await search.setValue('kimi')
    await flushPromises()
    expect(wrapper.text()).toContain('kimi-k2-thinking')
    expect(wrapper.text()).not.toContain('deepseek-v4.1-flash')
    wrapper.unmount()
  })

  it('用量记录 Tab：逐条表有「倍率」列（没走到渠道显示 —）', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('区间请求'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('逐条用量'), { timeout: 5000 })

    await vi.waitFor(() => expect(wrapper.text()).toContain('×0.3'), { timeout: 5000 })
    expect(wrapper.text()).toContain('倍率')
    expect(wrapper.text()).toContain('渠道')
    wrapper.unmount()
  })

  it('桌面视图：/usage 与 /logs 都带 clientKind=desktop，汇总与逐条只算桌面来源（docs/22 §1.3）', async () => {
    useMock()

    /** 抓请求 URL（在假接口之上再包一层） */
    const capture = (): { urls: string[]; restore: () => void } => {
      const urls: string[] = []
      const original = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/admin/relay/usage') || url.includes('/api/admin/relay/logs')) urls.push(url)
        return original(input, init)
      }) as typeof fetch
      return { urls, restore: () => (globalThis.fetch = original) }
    }

    const requestsOf = (wrapper: Awaited<ReturnType<typeof mountModels>>['wrapper']): number => {
      const text = wrapper.get('[data-testid="usage-requests"]').text()
      return Number(text.replace(/[^\d]/gu, ''))
    }

    // 云上：什么都不带（全部来源）
    const cloudCapture = capture()
    const cloud = await mountModels('/admin/models?tab=usage')
    await vi.waitFor(() => expect(requestsOf(cloud.wrapper)).toBeGreaterThan(0), { timeout: 5000 })
    cloudCapture.restore()
    const allRequests = requestsOf(cloud.wrapper)
    expect(cloudCapture.urls.length).toBeGreaterThan(0)
    expect(cloudCapture.urls.every((url) => !url.includes('clientKind='))).toBe(true)
    cloud.wrapper.unmount()

    // 桌面：汇总与逐条都带 clientKind=desktop
    const desktopCapture = capture()
    const desktop = await mountModels('/admin/models?tab=usage&platform=desktop')
    await vi.waitFor(() => expect(requestsOf(desktop.wrapper)).toBeGreaterThan(0), { timeout: 5000 })
    desktopCapture.restore()

    expect(
      desktopCapture.urls.some(
        (url) => url.includes('/api/admin/relay/usage') && url.includes('clientKind=desktop'),
      ),
    ).toBe(true)
    expect(
      desktopCapture.urls.some(
        (url) => url.includes('/api/admin/relay/logs') && url.includes('clientKind=desktop'),
      ),
    ).toBe(true)

    // 结果：只剩桌面来源的记录（假数据里每 4 条有 1 条 client_kind=desktop），比全部来源少
    const desktopRows = relayState().logs.filter(
      (row) => (row as { clientKind?: string }).clientKind === 'desktop',
    )
    expect(desktopRows.length).toBeGreaterThan(0)
    expect(requestsOf(desktop.wrapper)).toBe(desktopRows.length)
    expect(requestsOf(desktop.wrapper)).toBeLessThan(allRequests)
    desktop.wrapper.unmount()
  })

  it('积分与设置 Tab 照旧（余额、流水、设置表单与只读地址）', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=wallets')
    await vi.waitFor(() => expect(wrapper.text()).toContain('加 / 扣积分'), { timeout: 5000 })
    expect(wrapper.text()).toContain('-0.12')
    expect(wrapper.text()).toContain('积分流水')

    await openTab(wrapper, '设置')
    await vi.waitFor(() => expect(wrapper.text()).toContain('启用中转站'), { timeout: 5000 })
    expect(wrapper.text()).toContain('注册赠送（积分）')
    await vi.waitFor(() => expect(wrapper.text()).toContain('https://hub.example.com:8123/v1'), {
      timeout: 5000,
    })
    wrapper.unmount()
  })
})

describe('路由与 `?tab=` 同步（12 §10）', () => {
  it('`?tab=providers` → `dsh`（旧「模型」页的 Tab 名归一化），地址栏也改过来', async () => {
    useMock()
    const { wrapper, router } = await mountModels('/admin/models?tab=providers')
    await flushPromises()

    expect(router.currentRoute.value.query['tab']).toBe('dsh')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="dsh-rollout"]').exists()).toBe(true), { timeout: 5000 })
    // 旧入口（提供方 / 预设 / 引导卡）不再出现
    expect(wrapper.text()).not.toContain('模型信息库')
    expect(wrapper.text()).not.toContain('新建 Hub 中转站提供方')
    wrapper.unmount()
  })

  it('`?tab=presets` 同样归到 dsh；未知 Tab 回概览', async () => {
    useMock()
    const { router, wrapper } = await mountModels('/admin/models?tab=presets')
    await flushPromises()
    expect(router.currentRoute.value.query['tab']).toBe('dsh')
    wrapper.unmount()

    const second = await mountModels('/admin/models?tab=nonsense')
    await flushPromises()
    expect(second.router.currentRoute.value.query['tab']).toBe('overview')
    second.wrapper.unmount()
  })

  it('`/admin/relay?tab=wallets&userId=2` 重定向到 `/admin/models`，参数原样带过去', async () => {
    useMock()
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/admin/relay?tab=wallets&userId=2')
    await router.isReady()

    expect(router.currentRoute.value.path).toBe('/admin/models')
    expect(router.currentRoute.value.query).toEqual({ tab: 'wallets', userId: '2' })
  })
})

/** 「模型与价格」表格里某个模型的默认思考下拉 */
function thinkingCell(
  wrapper: {
    findAllComponents: (c: unknown) => {
      attributes: (name: string) => string | undefined
      props: (name: string) => unknown
      vm: { $emit: (event: string, ...args: unknown[]) => void }
    }[]
  },
  id: number,
) {
  const select = wrapper
    .findAllComponents(NSelect as never)
    .find((item) => item.attributes('data-testid') === `model-thinking-${id}`)
  expect(select, `模型 #${id} 应有默认思考下拉`).toBeTruthy()
  return select!
}

/** 记下 `/api/admin/relay/models/:id` 的 PATCH 体 */
function capturePatches(): Record<string, unknown>[] {
  const captured: Record<string, unknown>[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      String(input).includes('/api/admin/relay/models/') &&
      (init?.method ?? 'GET').toUpperCase() === 'PATCH'
    ) {
      captured.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    }
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return captured
}

describe('「模型与价格」默认思考列（WP13，12 §10）', () => {
  it('行内下拉的候选 =「不指定」+ 声明的档位；选了立即 PATCH（真改假状态）', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=models')
    await vi.waitFor(() => expect(wrapper.text()).toContain('deepseek-v4.1-flash'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('默认思考'), { timeout: 5000 })

    const cell = thinkingCell(wrapper, 1)
    expect((cell.props('options') as { label: string }[]).map((option) => option.label)).toEqual([
      '不指定',
      'low · 低',
      'high · 高',
      'max · 最高',
    ])
    expect(cell.props('value')).toBe('max')

    const patches = capturePatches()
    cell.vm.$emit('update:value', 'low')
    await vi.waitFor(() => expect(patches).toHaveLength(1), { timeout: 5000 })
    expect(patches[0]).toEqual({ defaultThinking: 'low' })
    expect(relayState().models.find((item) => item.id === 1)?.defaultThinking).toBe('low')
    wrapper.unmount()
  })

  it('PATCH 失败：回滚到原档位并提示', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=models')
    await vi.waitFor(() => expect(wrapper.text()).toContain('deepseek-v4.1-flash'), { timeout: 5000 })

    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        String(input).includes('/api/admin/relay/models/') &&
        (init?.method ?? '').toUpperCase() === 'PATCH'
      ) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_FAILED',
              message: '默认思考档位不合法',
              details: { fields: { defaultThinking: '模型没有声明「xhigh」这个思考档位' } },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } },
        )
      }
      return original(input, init)
    }) as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })

    const cell = thinkingCell(wrapper, 1)
    cell.vm.$emit('update:value', 'low')
    await flushPromises()
    await vi.waitFor(() => expect(cell.props('value')).toBe('max'), { timeout: 5000 })
    // 服务端值没变
    expect(relayState().models.find((item) => item.id === 1)?.defaultThinking).toBe('max')
    wrapper.unmount()
  })

  it('没声明档位 → 灰「—」+ 悬停提示；设了但不生效 → 琥珀「未生效」', async () => {
    useMock()
    const { wrapper } = await mountModels('/admin/models?tab=models')
    await vi.waitFor(() => expect(wrapper.text()).toContain('deepseek-v4.1-flash'), { timeout: 5000 })

    // deepseek-v3（#2）没声明任何档位
    const none = wrapper.find('[data-testid="model-thinking-none-2"]')
    expect(none.exists()).toBe(true)
    expect(none.text()).toBe('—')
    expect(none.attributes('title')).toContain('模型参数里勾选')

    // glm-4.7-air（#6）设了 max，但只声明 low/medium/high
    expect(wrapper.find('[data-testid="model-thinking-ineffective-6"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="model-thinking-ineffective-6"]').text()).toContain('未生效')
    expect(thinkingCell(wrapper, 6).props('value')).toBe('')
    wrapper.unmount()
  })

  it('`?tab=models&edit=<id>`：打开该模型的定价弹窗，关掉后地址栏不再带 edit', async () => {
    useMock()
    const { wrapper, router } = await mountModels('/admin/models?tab=models&edit=4')
    await vi.waitFor(() => expect(document.body.textContent ?? '').toContain('定价 · qwen3-coder'), {
      timeout: 5000,
    })
    expect(router.currentRoute.value.query['edit']).toBe('4')

    const cancel = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '取消',
    )
    expect(cancel, '弹窗应有取消按钮').toBeTruthy()
    cancel!.click()
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.query['edit']).toBeUndefined(), { timeout: 5000 })
    wrapper.unmount()
  })
})

describe('提供方抽屉：Hub 中转站类型（12 §7 §10）', () => {
  const PI_AI = ADMIN_PROVIDERS.find((provider) => provider.kind === 'pi-ai')!
  const RELAY = ADMIN_PROVIDERS.find((provider) => provider.kind === 'hub-relay')!

  /**
   * 抽屉只在 `show` 从 false 变 true 时才填表单（真实用法也是先挂载、再打开），
   * 所以这里先用一个 reactive 的 props 挂载，再把它打开。
   */
  async function mountDrawer(provider: ModelProvider | null) {
    useMock()
    const props = reactive<Record<string, unknown>>({ show: false, provider })
    const wrapper = mount(withMessages(ProviderDrawer, props), { attachTo: document.body })
    props.show = true
    await nextTick()
    await flushPromises()
    wrappers.push(wrapper)
    return wrapper
  }

  it('pi-ai：有 Base URL、密钥模式与模型列表编辑器', async () => {
    const wrapper = await mountDrawer(PI_AI)

    const text = document.body.textContent ?? ''
    expect(text).toContain('Base URL')
    expect(text).toContain('密钥模式')
    expect(text).toContain('模型列表')
    wrapper.unmount()
  })

  it('hub-relay：隐藏 Base URL / 密钥 / 模型编辑，只读显示「将渲染的模型」与内部地址', async () => {
    const wrapper = await mountDrawer(RELAY)

    const text = document.body.textContent ?? ''
    expect(text).toContain('Hub 中转站：')
    expect(text).toContain('将渲染的模型（只读）')
    expect(text).toContain('deepseek-v4.1-flash')
    expect(text).toContain('http://10.213.0.1:7710/v1')
    expect(text).toContain('密钥模式固定 per-user')
    expect(text).not.toContain('Base URL')
    expect(text).not.toContain('密钥（API Key）')
    expect(text).not.toContain('手动添加')
    expect(text).not.toContain('从端点发现')
    wrapper.unmount()
  })

  it('从类型下拉切到 hub-relay 后，Base URL 与密钥编辑立刻隐藏', async () => {
    const wrapper = await mountDrawer(null)
    expect(document.body.textContent).toContain('Base URL')

    const kindSelect = wrapper.findAllComponents(NSelect)[0]!
    kindSelect.vm.$emit('update:value', 'hub-relay')
    await nextTick()
    await flushPromises()

    expect(document.body.textContent).toContain('将渲染的模型（只读）')
    expect(document.body.textContent).not.toContain('Base URL')
    wrapper.unmount()
  })

  it('提交只发路由名 / 显示名 / 协议 / compat / extra（不发 baseUrl、models、apiKey）', async () => {
    const captured: { url: string; body: Record<string, unknown> }[] = []
    const wrapper = await mountDrawer(RELAY)

    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.startsWith('{')) {
        captured.push({ url: String(input), body: JSON.parse(init.body) as Record<string, unknown> })
      }
      return original(input, init)
    }) as typeof fetch

    const save = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '保存',
    )
    expect(save, '抽屉底部应有「保存」').toBeTruthy()
    save!.click()
    await flushPromises()

    globalThis.fetch = original

    const request = captured.find((item) => item.url.includes('/api/admin/models/providers/'))
    expect(request, '应发出保存请求').toBeTruthy()
    expect(request!.body).toMatchObject({
      kind: 'hub-relay',
      routeKey: 'hub',
      // WP13：系统 hub-relay 提供方的显示名一律「DSH Hub」（夹具与保存都跟着走）
      displayName: 'DSH Hub',
      api: 'openai-completions',
    })
    expect(request!.body).not.toHaveProperty('baseUrl')
    expect(request!.body).not.toHaveProperty('models')
    expect(request!.body).not.toHaveProperty('apiKey')
    wrapper.unmount()
  })
})
