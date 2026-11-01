import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'
import { resetRelayStatus } from '@/composables/useRelayStatus'
import UsageView from '@/views/user/UsageView.vue'
import { daySpan } from '@/utils/relay-day'

/**
 * 19 §1 §2.4 §2.5 的页面级验收：
 * - 外接（API 密钥 / 接入说明）不渲染、不请求；
 * - 积分流水（`/api/me/relay/ledger`）不渲染、不请求；
 * - 使用记录三个标签按条件出现；
 * - 「模型调用」的筛选参数真的传到 `/api/me/relay/logs`；
 * - `?mock=usage-empty` 的空状态。
 */

const restores: (() => void)[] = []

function useMock(scenario: MockScenario): void {
  resetRelayMock()
  resetRelayStatus()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

/** 记录页面真正请求过的 URL（包在假 fetch 外面，仍然透传） */
function recordFetch(): string[] {
  const urls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(raw)
    return original(input as never, init)
  }) as typeof globalThis.fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return urls
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  resetRelayStatus()
  window.localStorage.clear()
  document.body.innerHTML = ''
})

function withMessages(component: unknown, props: Record<string, unknown> = {}) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never, props) }),
  })
}

async function mountAt(component: unknown, path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(withMessages(component), {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

describe('/usage 页面（19 §1 D2 / D3）', () => {
  it('不渲染密钥与接入说明，也不请求 keys / ledger', async () => {
    useMock('running')
    const urls = recordFetch()
    const wrapper = await mountAt(UsageView, '/usage')

    await vi.waitFor(() => expect(wrapper.text()).toContain('积分余额'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.findAll('.model-chart__hit')).toHaveLength(30), {
      timeout: 5000,
    })

    const text = wrapper.text()
    expect(text).not.toContain('新建密钥')
    expect(text).not.toContain('接入说明')
    expect(text).not.toContain('积分流水')
    expect(urls.some((url) => url.includes('/api/me/relay/ledger'))).toBe(false)
    expect(urls.some((url) => url.includes('/api/me/relay/keys'))).toBe(false)

    wrapper.unmount()
  })

  it('使用记录：三个标签按条件出现（搜索池 + 算力计费都开着）', async () => {
    useMock('running')
    const wrapper = await mountAt(UsageView, '/usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('使用记录'), { timeout: 5000 })
    await vi.waitFor(
      () => {
        expect(wrapper.findAll('.n-tabs-tab').map((node) => node.text())).toEqual([
          '模型调用',
          '搜索与抓取',
          '算力租赁',
        ])
      },
      { timeout: 5000 },
    )
    wrapper.unmount()
  })

  it('「模型调用」筛选：默认最近 30 天，改状态后带 status 重新请求', async () => {
    useMock('running')
    const urls = recordFetch()
    const wrapper = await mountAt(UsageView, '/usage')

    await vi.waitFor(() => expect(urls.some((url) => url.includes('/api/me/relay/logs'))).toBe(true), {
      timeout: 5000,
    })

    const logsUrls = (): URL[] =>
      urls.filter((url) => url.includes('/api/me/relay/logs')).map((url) => new URL(url, 'http://localhost'))

    const first = logsUrls()[0]!
    const from = first.searchParams.get('from')!
    const to = first.searchParams.get('to')!
    expect(daySpan(from, to)).toBe(30)
    expect(first.searchParams.get('page')).toBe('1')
    expect(first.searchParams.get('pageSize')).toBe('20')

    const statusSelect = wrapper
      .findAllComponents(NSelect)
      .find((item) =>
        (item.props('options') as { label: string }[] | undefined)?.some(
          (option) => option.label === '全部状态',
        ),
      )
    expect(statusSelect, '应有状态筛选').toBeTruthy()
    statusSelect!.vm.$emit('update:value', 'ok')
    await flushPromises()

    await vi.waitFor(
      () => expect(logsUrls().some((url) => url.searchParams.get('status') === 'ok')).toBe(true),
      { timeout: 5000 },
    )
    wrapper.unmount()
  })

  it('?mock=usage-empty：区间内没有用量 → 图显示空状态', async () => {
    useMock('usage-empty')
    const wrapper = await mountAt(UsageView, '/usage')

    await vi.waitFor(() => expect(wrapper.text()).toContain('这段时间还没有用量'), { timeout: 5000 })
    expect(wrapper.findAll('.model-chart__hit')).toHaveLength(0)
    // 页面其余部分照常
    expect(wrapper.text()).toContain('模型消耗')
    expect(wrapper.text()).toContain('可用模型')
    wrapper.unmount()
  })
})
