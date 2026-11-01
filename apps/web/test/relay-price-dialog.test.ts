import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'

import InfoTip from '@/components/base/InfoTip.vue'
import RelayModelPriceDialog from '@/components/admin/relay/RelayModelPriceDialog.vue'
import { installMockFetch } from '@/mocks/fetch'
import { relayState, resetRelayMock } from '@/mocks/relay'
import { setMockScenario } from '@/mocks/state'

/**
 * 「定价」弹窗（WP11b 交付物 4，12 §10）：价格五项 + 每个渠道一行的「实际价格」预览
 * （价格 × 渠道倍率，随输入实时变化）+ PATCH 保存。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetRelayMock()
  setMockScenario('admin')
  restores.push(installMockFetch('admin'))
}

afterEach(() => {
  // 先卸载组件再清 body：Teleport 到 body 的弹窗留着的话，下一个用例会查到上一个弹窗的输入框
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  document.body.innerHTML = ''
})

async function mountDialog(modelName: string) {
  const model = relayState().models.find((item) => item.name === modelName)!
  const props = reactive<Record<string, unknown>>({ show: false, model, channels: relayState().channels })
  const wrapper = mount(
    defineComponent({
      render: () => h(NMessageProvider, null, { default: () => h(RelayModelPriceDialog as never, props) }),
    }),
    { attachTo: document.body },
  )
  props.show = true
  await nextTick()
  await flushPromises()
  wrappers.push(wrapper)
  return wrapper
}

/** 实际价格表的一行：渠道名 + 四项价格 */
function actualRow(label: string): string[] {
  const row = [
    ...document.querySelectorAll<HTMLTableRowElement>('[data-testid="price-actual"] tbody tr'),
  ].find((item) => item.textContent?.includes(label))
  expect(row, `实际价格表应有「${label}」`).toBeTruthy()
  return [...row!.querySelectorAll('td')].map((cell) => cell.textContent?.trim() ?? '')
}

/**
 * 改一个价格输入框。每次改完都要让 Vue 走一轮：真实输入是两次独立的键盘事件，
 * 同步连改两个框的话，第二次的 handler 会读到上一次的旧 props。
 */
async function setPriceInput(index: number, value: string): Promise<void> {
  const input = document.querySelectorAll<HTMLInputElement>('.price-fields input')[index]
  expect(input, `第 ${index} 个价格输入框`).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
  await nextTick()
}

/** 弹窗里的「默认思考档位」下拉（WP13） */
function thinkingSelect(wrapper: {
  findAllComponents: (c: unknown) => {
    attributes: (name: string) => string | undefined
    props: (name: string) => unknown
    vm: { $emit: (event: string, ...args: unknown[]) => void }
  }[]
}) {
  const select = wrapper
    .findAllComponents(NSelect as never)
    .find((item) => item.attributes('data-testid') === 'price-default-thinking')
  expect(select, '应有「默认思考档位」下拉').toBeTruthy()
  return select!
}

/** 「模型参数」里的思考档位（multiple 的那个 NSelect） */
function effortsSelect(wrapper: {
  findAllComponents: (
    c: unknown,
  ) => { props: (name: string) => unknown; vm: { $emit: (event: string, ...args: unknown[]) => void } }[]
}) {
  const select = wrapper.findAllComponents(NSelect as never).find((item) => item.props('multiple') === true)
  expect(select, '应有思考档位多选').toBeTruthy()
  return select!
}

async function expandMore(): Promise<void> {
  document
    .querySelector<HTMLElement>('.n-collapse-item__header-main')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

/** 记下 PATCH 的请求体（假 fetch 照常回数据） */
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

function clickSave(): void {
  const save = document.querySelector<HTMLButtonElement>('[data-testid="price-save"]')
  expect(save, '应有保存按钮').toBeTruthy()
  save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('「定价」弹窗 · 默认思考档位（WP13，12 §7.0 §10）', () => {
  it('在价格下面、不折叠；候选 =「不指定」+ 当前勾选的档位，默认显示生效档位', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()

    const select = thinkingSelect(wrapper)
    expect((select.props('options') as { label: string }[]).map((option) => option.label)).toEqual([
      '不指定',
      'low · 低',
      'high · 高',
      'max · 最高',
    ])
    expect(select.props('value')).toBe('max')
    expect(select.props('disabled')).toBe(false)
    // 07 §2.7 第 2 条：单位进标题，页面上不再写「单位：积分 / 百万 token」那一行
    expect(document.body.textContent ?? '').toContain('价格（积分 / 百万 token')
    expect(document.body.textContent ?? '').not.toContain('单位：积分 / 百万 token')
    // 07 §2.7 第 5 条：旁注收进「默认思考档位」标签旁的 InfoTip
    const tip = wrapper.findComponent(InfoTip)
    expect(tip.exists(), '「默认思考档位」旁应有 InfoTip').toBe(true)
    expect(tip.props('text')).toContain('用户仍可自己改')
    // 不折叠：没点「更多设置」也能看到
    expect(document.body.textContent ?? '').toContain('默认思考档位')
    wrapper.unmount()
  })

  it('取消勾选了正选着的档位 → 回到「不指定」并提示一行', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()

    await expandMore()
    effortsSelect(wrapper).vm.$emit('update:value', ['low', 'high'])
    await flushPromises()

    expect(thinkingSelect(wrapper).props('value')).toBe('')
    expect(document.querySelector('[data-testid="price-thinking-hint"]')?.textContent ?? '').toContain(
      '已经不在模型声明的档位里',
    )
    // 候选中「max」也没了
    expect((thinkingSelect(wrapper).props('options') as { label: string }[]).map((o) => o.label)).toEqual([
      '不指定',
      'low · 低',
      'high · 高',
    ])
    wrapper.unmount()
  })

  it('一个档位都没勾：下拉禁用 + 旁注，点旁注上的「更多设置」能展开', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v3')
    await flushPromises()

    expect(thinkingSelect(wrapper).props('disabled')).toBe(true)
    const note = document.querySelector('[data-testid="price-thinking-empty"]')
    expect(note?.textContent ?? '').toContain('这个模型还没声明思考档位')

    expect(document.body.textContent ?? '').not.toContain('模型参数（渲染进用户的 DSH）')
    document
      .querySelector<HTMLElement>('[data-testid="price-thinking-more"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.body.textContent ?? '').toContain('模型参数（渲染进用户的 DSH）')
    wrapper.unmount()
  })

  it('保存时随 PATCH 发 defaultThinking；没变就不发', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()
    const unchanged = capturePatches()

    await setPriceInput(0, '1.2')
    clickSave()
    await flushPromises()
    expect(unchanged).toHaveLength(1)
    expect(unchanged[0]).not.toHaveProperty('defaultThinking')

    wrapper.unmount()

    // 改档位 → 带着新档位一起发
    const wrapper2 = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()
    const changed = capturePatches()
    thinkingSelect(wrapper2).vm.$emit('update:value', 'high')
    await nextTick()
    clickSave()
    await flushPromises()

    expect(changed).toHaveLength(1)
    expect(changed[0]?.['defaultThinking']).toBe('high')
    expect(relayState().models.find((item) => item.name === 'deepseek-v4.1-flash')?.defaultThinking).toBe(
      'high',
    )
    wrapper2.unmount()
  })

  it('库里存着但不生效的档位：界面按「不指定」显示 + 提示，保存时清成 null', async () => {
    useMock()
    const wrapper = await mountDialog('glm-4.7-air')
    await flushPromises()

    expect(thinkingSelect(wrapper).props('value')).toBe('')
    expect(document.querySelector('[data-testid="price-thinking-hint"]')?.textContent ?? '').toContain(
      '原来设的「max」',
    )

    const patches = capturePatches()
    clickSave()
    await flushPromises()

    expect(patches).toHaveLength(1)
    expect(patches[0]?.['defaultThinking']).toBeNull()
    wrapper.unmount()
  })

  it('服务端 `fields.defaultThinking` 的报错显示在该字段下', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()

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

    clickSave()
    await flushPromises()

    expect(document.querySelector('[data-testid="price-thinking-error"]')?.textContent?.trim()).toBe(
      '模型没有声明「xhigh」这个思考档位',
    )
    wrapper.unmount()
  })
})

describe('「定价」弹窗（12 §10）', () => {
  it('每个渠道一行「实际价格」= 价格 × 倍率（渠道胶囊用标识）', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()

    // 输入 1 / 输出 2 / 缓存读 0.1 / 每次 0
    expect(actualRow('upstream-c')).toEqual(['upstream-c ×0.3', '0.3', '0.6', '0.03', '0'])
    expect(actualRow('upstream-b')).toEqual(['upstream-b ×0.1', '0.1', '0.2', '0.01', '0'])
    expect(actualRow('official')).toEqual(['official ×1', '1', '2', '0.1', '0'])
    wrapper.unmount()
  })

  it('价格随输入实时变化（改输入 → 实际价格重算）', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()

    await setPriceInput(0, '2')
    expect(actualRow('upstream-c')[1]).toBe('0.6')
    expect(actualRow('official')[1]).toBe('2')

    await setPriceInput(2, '')
    // 缓存读留空 = 同输入价
    expect(actualRow('upstream-c')[3]).toBe('0.6')
    wrapper.unmount()
  })

  it('「更多设置」折叠里有模型参数、可见性与路由子表', async () => {
    useMock()
    const wrapper = await mountDialog('deepseek-v4.1-flash')
    await flushPromises()

    expect(document.body.textContent ?? '').toContain('更多设置（模型参数、可见性、compat、路由）')
    // 折叠默认收起（Naive 不渲染未展开的内容），点开再断言
    document
      .querySelector<HTMLElement>('.n-collapse-item__header-main')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.body.textContent ?? '').toContain('按模型库补全')
    expect(document.body.textContent ?? '').toContain('可见性')
    expect(document.body.textContent ?? '').toContain('compat（JSON，可留空）')
    expect(document.body.textContent ?? '').toContain('路由（可以挂到多个渠道）')
    wrapper.unmount()
  })

  it('保存发出 PATCH：价格、显示名、路由都在（缓存读留空 = null）', async () => {
    useMock()
    const wrapper = await mountDialog('glm-4.7-air')
    await flushPromises()

    await setPriceInput(0, '0.5')
    await setPriceInput(1, '1.5')
    await setPriceInput(2, '')

    const captured: { url: string; body: Record<string, unknown> }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.startsWith('{')) {
        captured.push({ url: String(input), body: JSON.parse(init.body) as Record<string, unknown> })
      }
      return original(input, init)
    }) as typeof fetch

    const save = document.querySelector<HTMLButtonElement>('[data-testid="price-save"]')
    expect(save, '应有保存按钮').toBeTruthy()
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    globalThis.fetch = original

    const patch = captured.find((item) => item.url.includes('/api/admin/relay/models/'))
    expect(patch, '应发出 PATCH').toBeTruthy()
    expect(patch!.body['price']).toMatchObject({
      inputMicro: 500_000,
      outputMicro: 1_500_000,
      cacheReadMicro: null,
      perRequestMicro: 0,
    })
    expect(patch!.body['displayName']).toBe('智谱 GLM-4.7 Air')
    expect((patch!.body['routes'] as unknown[]).length).toBe(1)

    // 假状态真的改了
    const saved = relayState().models.find((item) => item.name === 'glm-4.7-air')!
    expect(saved.price.inputMicro).toBe(500_000)
    wrapper.unmount()
  })

  it('无渠道的模型：实际价格表给「先挂到渠道」的提示', async () => {
    useMock()
    const wrapper = await mountDialog('kimi-k2-thinking')
    await flushPromises()

    expect(document.body.textContent ?? '').toContain('这个模型还没有渠道（无渠道）')
    wrapper.unmount()
  })
})
