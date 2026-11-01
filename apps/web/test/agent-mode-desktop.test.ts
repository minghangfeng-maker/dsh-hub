import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import AgentModeDesktopFragments from '@/components/admin/agent-modes/AgentModeDesktopFragments.vue'
import { resetReauthDialog } from '@/composables/useReauth'
import { installMockFetch } from '@/mocks/fetch'
import { setMockScenario } from '@/mocks/state'

/**
 * Claude Code / Codex 的桌面侧（docs/22 §1.3 §3）：只编辑对应 pilot 的 `hubMode`。
 *
 * 重点验证「按条目 id 只改这一类」：`PUT /api/admin/desktop/config` 是整体替换，
 * 保存时必须把该目标别的片段（模型两条 / 另一个 pilot）原样合并回去。
 * 全走 `?mock=agent-modes` 假接口。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetReauthDialog()
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
  resetReauthDialog()
  document.body.innerHTML = ''
  window.localStorage.clear()
})

function mountFragment(mode: 'claude-code' | 'codex') {
  const wrapper = mount(
    defineComponent({
      render: () =>
        h(NMessageProvider, null, { default: () => h(AgentModeDesktopFragments, { mode }) }),
    }),
    { attachTo: document.body },
  )
  wrappers.push(wrapper)
  return wrapper
}

function testid(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

function clickRadio(id: string): void {
  const element = testid(id)
  expect(element, `应有 ${id}`).toBeTruthy()
  const input = element!.querySelector<HTMLInputElement>('input[type="radio"]')
  expect(input, `${id} 里应有 radio`).toBeTruthy()
  input!.checked = true
  input!.dispatchEvent(new Event('change', { bubbles: true }))
}

function captureWrites(): { url: string; body: Record<string, unknown> }[] {
  const captured: { url: string; body: Record<string, unknown> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT' && String(input).includes('/api/admin/desktop/config')) {
      captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    }
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return captured
}

async function waitForText(text: string): Promise<void> {
  await vi.waitFor(() => expect(document.body.textContent).toContain(text), { timeout: 5000 })
  // 假接口有 90ms 延迟：等到数据真的落到 useAsyncData 里再继续（「尚未配置」在加载中就成立）
  await new Promise((resolve) => setTimeout(resolve, 150))
  await flushPromises()
}

describe('Claude Code / Codex · 桌面侧配置片段', () => {
  it('默认目标是全部设备：读不到这个条目时显示「尚未配置」，保存会保留该目标已有的其它片段', async () => {
    useMock()
    const wrapper = mountFragment('claude-code')
    await waitForText('尚未配置')
    expect(wrapper.text()).toContain('claude-pilot')
    expect(testid('agent-fragment-hubmode')?.classList.contains('n-switch--active')).toBe(true)

    // 关掉 Hub 模式 → 保存
    testid('agent-fragment-hubmode')!.click()
    await flushPromises()
    const captured = captureWrites()
    testid('agent-fragment-save')!.click()
    await vi.waitFor(() => expect(captured.length).toBe(1), { timeout: 5000 })

    const body = captured[0]!.body
    expect(body['target']).toEqual({ scope: 'all' })
    const fragments = body['fragments'] as { id: string; mode: string; config: Record<string, unknown> }[]
    expect(fragments.map((row) => row.id)).toEqual(['llm-pi-ai', 'agent-default-model', 'claude-pilot'])
    expect(fragments.find((row) => row.id === 'claude-pilot')).toEqual({
      id: 'claude-pilot',
      mode: 'enforce',
      config: { hubMode: false },
    })
    // 别的片段原样带回去（没有被冲掉）
    expect(fragments.find((row) => row.id === 'llm-pi-ai')?.config).toHaveProperty('providers')
    expect(fragments.find((row) => row.id === 'agent-default-model')?.config).toEqual({
      provider: 'hub',
      model: 'deepseek-v4.1-flash',
    })
  })

  it('切到角色目标：读回这个目标已有的 hubMode 与片段模式，保存只提交这一个条目', async () => {
    useMock()
    const wrapper = mountFragment('claude-code')
    await waitForText('尚未配置')

    clickRadio('desktop-target-role')
    await waitForText('已配置')
    expect(testid('agent-fragment-mode')?.textContent ?? '').toContain('默认')
    expect(testid('agent-fragment-scope')?.textContent?.trim()).toBe('普通用户')

    const captured = captureWrites()
    testid('agent-fragment-save')!.click()
    await vi.waitFor(() => expect(captured.length).toBe(1), { timeout: 5000 })

    expect(captured[0]!.body['target']).toEqual({ scope: 'role', role: 'user' })
    expect(captured[0]!.body['fragments']).toEqual([
      { id: 'claude-pilot', mode: 'default', config: { hubMode: true } },
    ])
    wrapper.unmount()
  })

  it('Codex 页改的是 codex-pilot，不会碰 claude-pilot', async () => {
    useMock()
    const wrapper = mountFragment('codex')
    await waitForText('尚未配置')
    expect(wrapper.text()).toContain('codex-pilot')

    const captured = captureWrites()
    testid('agent-fragment-save')!.click()
    await vi.waitFor(() => expect(captured.length).toBe(1), { timeout: 5000 })

    const fragments = captured[0]!.body['fragments'] as { id: string; config: Record<string, unknown> }[]
    expect(fragments.map((row) => row.id)).toEqual(['llm-pi-ai', 'agent-default-model', 'codex-pilot'])
    expect(fragments.find((row) => row.id === 'codex-pilot')?.config).toEqual({ hubMode: true })
    expect(fragments.some((row) => row.id === 'claude-pilot')).toBe(false)
  })
})
