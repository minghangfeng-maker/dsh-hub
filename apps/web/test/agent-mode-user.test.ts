import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import UsageLogTable from '@/components/relay/UsageLogTable.vue'
import AgentModeModelsSection from '@/components/user/relay/AgentModeModelsSection.vue'
import { resetRelayStatus } from '@/composables/useRelayStatus'
import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'
import UsageView from '@/views/user/UsageView.vue'

/**
 * 用户端「积分与用量」（18 §7）：开通的 Claude Code / Codex 各一节（模型名、显示名、实际单价、上下文）、
 * 用量「按来源」、使用记录的「来源」列与筛选；没开通（没有 `agentModes`）时页面与原来一样。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(scenario: MockScenario): void {
  resetRelayMock()
  resetRelayStatus()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  resetRelayStatus()
  document.body.innerHTML = ''
})

function withMessages(component: unknown) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never) }),
  })
}

async function mountUsage(): Promise<ReturnType<typeof mount>> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/usage')
  await router.isReady()
  const wrapper = mount(withMessages(UsageView), {
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

describe('可用模型下面的对话模式小节', () => {
  it('两个模式各一节：×1.5 / ×1、模型名可复制、实际单价按渠道区间算', async () => {
    useMock('running')
    const wrapper = await mountUsage()

    await vi.waitFor(() => expect(wrapper.find('[data-testid="agent-mode-models"]').exists()).toBe(true), {
      timeout: 5000,
    })
    const text = wrapper.text()
    expect(text).toContain('Claude Code')
    expect(text).toContain('Codex')

    // 整体倍率标签
    const rates = wrapper.findAll('[data-testid="agent-mode-rate-tag"]').map((tag) => tag.text())
    expect(rates).toEqual(['×1.5', '×1'])

    // 模型名（等宽、可复制）+ 显示名 + 默认标签
    expect(text).toContain('claude-sonnet-5-5')
    expect(text).toContain('Claude Sonnet 5.5')
    expect(text).toContain('gpt-5.1-codex')
    expect(text).toContain('默认')
    const names = wrapper.findAll('.agent-models__cell code').map((node) => node.text())
    expect(names).toContain('claude-sonnet-5-5')

    // 实际单价 = 模型价 × 渠道倍率（区间）× 整体倍率
    // Claude Sonnet：3 × (×1–×1.2) × ×1.5 = 4.5–5.4
    expect(text).toContain('4.5–5.4')
    // Codex gpt-5.1-codex：1.25 × (×0.8–×1) × ×1 = 1–1.25
    expect(text).toContain('1–1.25')

    // 上下文列
    expect(text).toContain('200,000')
    wrapper.unmount()
  })

  it('没有可用模型时给一句空状态（不崩）', async () => {
    useMock('running')
    const wrapper = mount(AgentModeModelsSection, {
      props: {
        modes: [{ mode: 'codex', label: 'DSH Hub', ratePermille: 1000, defaultModel: null, models: [] }],
      },
      global: { stubs: { NDataTable: true } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('这个模式还没有可用模型')
    wrapper.unmount()
  })
})

describe('按来源与来源筛选', () => {
  it('用量统计有「按来源」，使用记录按来源筛后请求带 scope', async () => {
    useMock('running')
    const wrapper = await mountUsage()

    await vi.waitFor(() => expect(wrapper.find('[data-testid="usage-by-scope"]').exists()).toBe(true), {
      timeout: 5000,
    })
    const scopeTable = wrapper.find('[data-testid="usage-by-scope"]')
    expect(scopeTable.text()).toContain('DSH')
    expect(scopeTable.text()).toContain('Claude Code')
    expect(scopeTable.text()).toContain('Codex')

    const select = wrapper
      .findAllComponents(NSelect)
      .find((item) => item.attributes('data-testid') === 'usage-log-source')
    expect(select, '使用记录应有来源筛选').toBeTruthy()

    const { urls, restore } = captureUrls()
    select!.vm.$emit('update:value', 'claude-code')
    await flushPromises()
    await vi.waitFor(
      () =>
        expect(
          urls.some((url) => url.includes('/api/me/relay/logs') && url.includes('scope=claude-code')),
        ).toBe(true),
      { timeout: 5000 },
    )
    restore()

    // 逐条表的「来源」列只显示 Claude Code
    const logTable = wrapper.findAllComponents(UsageLogTable).at(-1)!
    await vi.waitFor(() => expect(logTable.text()).toContain('Claude Code'), { timeout: 5000 })
    expect(logTable.text()).not.toContain('DSH')
    wrapper.unmount()
  })

  it('agentModes 缺省（老后端）：不显示模式小节 / 按来源 / 来源筛选，页面照旧', async () => {
    useMock('running')
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init)
      if (String(input).endsWith('/api/me/relay')) {
        const data = (await response.clone().json()) as Record<string, unknown>
        delete data['agentModes']
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      return response
    }) as typeof fetch

    try {
      const wrapper = await mountUsage()
      await vi.waitFor(() => expect(wrapper.text()).toContain('可用模型'), { timeout: 5000 })
      await vi.waitFor(() => expect(wrapper.text()).toContain('模型消耗'), { timeout: 5000 })

      expect(wrapper.find('[data-testid="agent-mode-models"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="usage-by-scope"]').exists()).toBe(false)
      expect(document.body.querySelector('[data-testid="usage-log-source"]')).toBeNull()
      // 老的「可用模型」与「使用记录」还在
      expect(wrapper.text()).toContain('deepseek-v4.1-flash@upstream-b')
      expect(wrapper.text()).toContain('使用记录')
      wrapper.unmount()
    } finally {
      globalThis.fetch = original
    }
  })
})
