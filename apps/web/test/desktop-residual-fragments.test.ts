import type { DesktopDeliveryState } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { getDesktopDelivery } from '@/api/admin-desktop'
import { installMockFetch } from '@/mocks/fetch'
import { resetDesktopDeliveryMock } from '@/mocks/desktop-delivery'
import { resetDesktopMock } from '@/mocks/desktop'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import DesktopOtherFragmentsCard from '@/components/admin/desktop/DesktopOtherFragmentsCard.vue'
import {
  RESIDUAL_ENTRIES,
  RESIDUAL_ENTRY_IDS,
  RESIDUAL_SELECTION_KEYS,
  residualDraftOf,
  residualRowOf,
  residualRowsOf,
} from '@/utils/desktop-residual-fragments'

/**
 * DSH 版本 · 桌面侧的「其它配置片段」（WP32b，docs/22 §1.3）：
 *
 * 桌面白名单里没被模型 / 代理 / 桥接三页接管的键收在这张卡。关键约束：
 * **同一个条目（claude-pilot）由多个页面写**，这张卡只能改自己接管的键 —— 保存时
 * `hubMode` 必须原样带上（接口是整体替换，冲掉就等于把「桥接」开关关了）。
 */

// ── 纯逻辑 ──────────────────────────────────────────────────────────────────

describe('residual 字段草稿', () => {
  const claude = RESIDUAL_ENTRIES[0]!

  it('只读本卡接管的键：条目里只有 hubMode 时草稿是空的（未配置）', () => {
    const draft = residualDraftOf(claude, { hubMode: true })
    expect(draft.enabled).toBe(false)
    expect(draft.values['permissionMode']).toBe('')
    // 接管范围里没有 hubMode
    expect(RESIDUAL_SELECTION_KEYS['claude-pilot']).not.toContain('hubMode')
    expect(RESIDUAL_ENTRY_IDS).toEqual(['claude-pilot', 'codex-pilot'])
  })

  it('已配置的条目回填表单，mode 沿用条目现在的值', () => {
    const draft = residualDraftOf(claude, { permissionMode: 'plan', maxToolResultChars: 20_000, verbose: true }, 'default')
    expect(draft.enabled).toBe(true)
    expect(draft.mode).toBe('default')
    expect(draft.values).toMatchObject({ permissionMode: 'plan', maxToolResultChars: '20000', verbose: true })
  })

  it('开关打开但一项都没填 → 报错，不发空片段', () => {
    const draft = residualDraftOf(claude, {})
    draft.enabled = true
    const built = residualRowOf(claude, draft)
    expect(built.row).toBeNull()
    expect(built.errors[0]).toContain('一项都没填')
  })

  it('数字越界被拦住；空值不写进片段', () => {
    const draft = residualDraftOf(claude, {})
    draft.enabled = true
    draft.values['permissionMode'] = 'plan'
    draft.values['maxToolResultChars'] = '9999999'
    const built = residualRowOf(claude, draft)
    expect(built.errors[0]).toContain('1000')
    expect(built.row?.config).toEqual({ permissionMode: 'plan' })
  })

  it('只把填了的键写出去（开关关掉的条目整条不出现）', () => {
    const claudeDraft = residualDraftOf(claude, {})
    claudeDraft.enabled = true
    claudeDraft.values['defaultModel'] = ' sonnet '
    const codexDraft = residualDraftOf(RESIDUAL_ENTRIES[1]!, {})
    const built = residualRowsOf({ 'claude-pilot': claudeDraft, 'codex-pilot': codexDraft })
    expect(built.errors).toEqual([])
    expect(built.rows).toEqual([
      { entryId: 'claude-pilot', mode: 'enforce', config: { defaultModel: 'sonnet' } },
    ])
  })
})

// ── 组件 ────────────────────────────────────────────────────────────────────

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetDesktopDeliveryMock()
  document.body.innerHTML = ''
})

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 320))
  await flushPromises()
}

async function mountCard(): Promise<{
  wrapper: ReturnType<typeof mount>
  state: DesktopDeliveryState
}> {
  resetDesktopDeliveryMock()
  resetDesktopMock()
  setMockScenario('admin-desktop')
  restores.push(installMockFetch('admin-desktop'))
  const state = await getDesktopDelivery()

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/runtimes?platform=desktop')
  const wrapper = mount(
    defineComponent({
      render: () =>
        h(NMessageProvider, null, {
          default: () => h(DesktopOtherFragmentsCard, { state }),
        }),
    }),
    { global: { plugins: [router] }, attachTo: document.body },
  )
  wrappers.push(wrapper)
  await settle()
  return { wrapper, state }
}

function captureConfigWrites(): {
  calls: { url: string; method: string; body: string | null }[]
  restore: () => void
} {
  const calls: { url: string; method: string; body: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && url.includes('/api/admin/desktop/config')) {
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null })
    }
    return original(input, init)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

describe('其它配置片段卡片', () => {
  it('目标=全部设备时两个条目都未配置（pilot 的片段在「普通用户」目标上）', async () => {
    const { wrapper } = await mountCard()
    expect(wrapper.find('[data-testid="residual-claude-pilot-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="residual-codex-pilot-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('其它配置片段')
  })

  it('切到「角色 · 普通用户」后能读到 claude-pilot 的其它键（hubMode 不算在卡片里）', async () => {
    const { wrapper } = await mountCard()
    const roleInput = document.body.querySelector<HTMLInputElement>('[data-testid="desktop-target-role"] input')
    roleInput!.checked = true
    roleInput!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    // 这个目标上 claude-pilot 只有 hubMode → 本卡仍然显示未配置
    expect(wrapper.find('[data-testid="residual-claude-pilot-empty"]').exists()).toBe(true)
  })

  it('保存时把条目里不属于本卡的键（hubMode）原样带上，mode 沿用现有值', async () => {
    const { wrapper } = await mountCard()
    const roleInput = document.body.querySelector<HTMLInputElement>('[data-testid="desktop-target-role"] input')
    roleInput!.checked = true
    roleInput!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    // 打开 claude-pilot 卡片并填权限模式
    await wrapper.find('[data-testid="residual-claude-pilot-enabled"]').trigger('click')
    await flushPromises()
    const select = wrapper
      .findAllComponents(NSelect)
      .find((item) => item.attributes('data-testid') === 'residual-claude-pilot-permissionMode')
    expect(select, '应有权限模式下拉').toBeTruthy()
    select!.vm.$emit('update:value', 'plan')
    await flushPromises()

    const capture = captureConfigWrites()
    await wrapper.find('[data-testid="residual-save"]').trigger('click')
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    const body = JSON.parse(capture.calls[0]!.body ?? '{}')
    expect(body.target).toEqual({ scope: 'role', role: 'user' })
    const claude = (body.fragments as { id: string; mode: string; config: Record<string, unknown> }[]).find(
      (fragment) => fragment.id === 'claude-pilot',
    )
    expect(claude, '应带上 claude-pilot 条目').toBeTruthy()
    // hubMode 原样保留（不是这张卡接管的键），mode 也沿用 default
    expect(claude!.config).toEqual({ hubMode: true, permissionMode: 'plan' })
    expect(claude!.mode).toBe('default')
    // 只写这一个条目：别的条目没有被顺手改掉
    expect(body.fragments).toHaveLength(1)
  })
})
