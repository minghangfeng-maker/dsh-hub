import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { installMockFetch } from '@/mocks/fetch'
import { resetDesktopDeliveryMock } from '@/mocks/desktop-delivery'
import { resetDesktopMock } from '@/mocks/desktop'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import DesktopManifestPanel from '@/components/admin/desktop/DesktopManifestPanel.vue'

/**
 * 任务中心 · 桌面侧的清单面板（WP32b，docs/22 §1.3）：
 *
 * - **清单版本记录**：`desktop.deliver` 审计按 revision 倒序列出（内容 / 目标 / 操作人）；
 * - **已下发的插件**：受管条目（缺整包标红），可查看、改目标、撤回；
 * - 改目标 = 先下发新目标、再撤旧目标（两条请求，各生成一条 revision）。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetDesktopDeliveryMock()
  document.body.innerHTML = ''
})

async function mountPanel(): Promise<{ wrapper: ReturnType<typeof mount>; router: ReturnType<typeof createRouter> }> {
  resetDesktopDeliveryMock()
  resetDesktopMock()
  setMockScenario('admin-desktop')
  restores.push(installMockFetch('admin-desktop'))

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/jobs?platform=desktop')
  const wrapper = mount(
    defineComponent({
      render: () => h(NMessageProvider, null, { default: () => h(DesktopManifestPanel) }),
    }),
    { global: { plugins: [router] }, attachTo: document.body },
  )
  wrappers.push(wrapper)
  await settle()
  return { wrapper, router }
}

/** 假接口每个请求 90ms 人为延迟（清单 + 审计是两个请求） */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 320))
  await flushPromises()
}

function captureRequests(): { calls: { url: string; method: string; body: string | null }[]; restore: () => void } {
  const calls: { url: string; method: string; body: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/admin/desktop/plugins')) {
      calls.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : null,
      })
    }
    return original(input, init)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

describe('清单版本记录', () => {
  it('按 revision 倒序列出 desktop.deliver 的每一条，带内容与目标', async () => {
    const { wrapper } = await mountPanel()
    const text = wrapper.text()
    expect(text).toContain('清单版本记录')
    expect(text).toContain('当前 revision r42')
    expect(wrapper.find('[data-testid="manifest-revision-101"]').exists()).toBe(true)
    // 四类内容都能读出「改了什么」
    expect(text).toContain('下发插件')
    expect(text).toContain('配置片段：claude-pilot')
    expect(text).toContain('稳定渠道')
    // 目标列（全部设备 / 普通用户）
    expect(text).toContain('全部设备')
    expect(text).toContain('普通用户')

    const firstRevision = wrapper.find('[data-testid="manifest-revision-105"]')
    expect(firstRevision.text()).toBe('r105')
  })

  it('清单里的渲染告警原样显示', async () => {
    const { wrapper } = await mountPanel()
    // 这个场景没有告警时整块都不出现；有告警时逐条 NAlert
    expect(wrapper.find('[data-testid="manifest-warning"]').exists()).toBe(false)
  })
})

describe('已下发的插件', () => {
  it('四个受管条目，缺整包的标红', async () => {
    const { wrapper } = await mountPanel()
    expect(wrapper.text()).toContain('4 个条目')
    expect(wrapper.find('[data-testid="manifest-target-3"]').text()).toBe('文件下载器')
    expect(wrapper.text()).toContain('缺整包')
  })

  it('撤回走 DELETE（确认框写清后果）', async () => {
    const { wrapper } = await mountPanel()
    const capture = captureRequests()
    await wrapper.find('[data-testid="manifest-withdraw-3"]').trigger('click')
    await flushPromises()
    const positive = document.body.querySelector<HTMLButtonElement>('.n-popconfirm__action .n-button--primary-type')
    expect(positive, '应弹出行内确认').toBeTruthy()
    positive!.click()
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]!.method).toBe('DELETE')
    expect(JSON.parse(capture.calls[0]!.body ?? '{}')).toEqual({
      target: { scope: 'all' },
      pluginId: 3,
    })
  })

  it('查看：详情弹窗里是版本 / 级别 / 目标 / 整包', async () => {
    const { wrapper } = await mountPanel()
    await wrapper.find('[data-testid="manifest-view-3"]').trigger('click')
    await flushPromises()
    const detail = document.body.querySelector('[data-testid="manifest-target-detail"]')
    expect(detail, '应打开详情弹窗').toBeTruthy()
    expect(detail!.textContent).toContain('文件下载器')
    expect(detail!.textContent).toContain('@local/dsh-file-download')
    expect(detail!.textContent).toContain('全部设备')
  })

  it('改目标：先下发到新目标、再撤旧目标（两条请求）', async () => {
    const { wrapper } = await mountPanel()
    await wrapper.find('[data-testid="manifest-retarget-3"]').trigger('click')
    await flushPromises()

    const roleInput = document.body.querySelector<HTMLInputElement>('[data-testid="desktop-target-role"] input')
    expect(roleInput, '弹窗里应有目标选择').toBeTruthy()
    roleInput!.checked = true
    roleInput!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const capture = captureRequests()
    document.body.querySelector<HTMLButtonElement>('[data-testid="manifest-retarget-confirm"]')!.click()
    await settle()
    capture.restore()

    expect(capture.calls.map((call) => call.method)).toEqual(['PUT', 'DELETE'])
    expect(JSON.parse(capture.calls[0]!.body ?? '{}')).toEqual({
      target: { scope: 'role', role: 'user' },
      pluginId: 3,
      versionId: 31,
    })
  })
})
