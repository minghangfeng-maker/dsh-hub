import type { DesktopDeliveryState } from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { getDesktopDelivery } from '@/api/admin-desktop'
import { reauthDialog, resetReauthDialog, resolveReauth } from '@/composables/useReauth'
import ReauthGate from '@/components/admin/ReauthGate.vue'
import { installMockFetch } from '@/mocks/fetch'
import { resetDesktopDeliveryMock } from '@/mocks/desktop-delivery'
import { resetDesktopMock } from '@/mocks/desktop'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import DesktopVersionsTab from '@/components/admin/desktop/DesktopVersionsTab.vue'

/**
 * 桌面端 · 版本与升级（WP25d 交付物 4）：渠道策略校验（版本号 / 灰度 0–100）、
 * 安装包发布（上传进度与 409/400 文案）、回滚的二次密码确认、强更地板预览与保存。
 */

// ── 假 XHR（安装包上传走 XMLHttpRequest）──────────────────────────────────
class FakeXhr extends EventTarget {
  static instances: FakeXhr[] = []
  static respond: (body: XMLHttpRequestBodyInit | null) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {},
  })

  upload = new EventTarget()
  status = 0
  responseText = ''
  url = ''
  body: XMLHttpRequestBodyInit | null = null

  open(_method: string, url: string): void {
    this.url = url
  }

  setRequestHeader(): void {}

  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    this.body = (body as XMLHttpRequestBodyInit | null) ?? null
    FakeXhr.instances.push(this)
    setTimeout(() => {
      const response = FakeXhr.respond(this.body)
      this.status = response.status
      this.responseText = JSON.stringify(response.body)
      this.dispatchEvent(new Event('load'))
    }, 0)
  }

  abort(): void {
    this.dispatchEvent(new Event('abort'))
  }

  emitProgress(loaded: number, total: number): void {
    const event = new Event('progress')
    Object.defineProperty(event, 'loaded', { value: loaded })
    Object.defineProperty(event, 'lengthComputable', { value: true })
    Object.defineProperty(event, 'total', { value: total })
    this.upload.dispatchEvent(event)
  }
}

const originalXhr = globalThis.XMLHttpRequest
const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetDesktopDeliveryMock()
  resetDesktopMock()
  setMockScenario('admin-desktop')
  restores.push(installMockFetch('admin-desktop'))
  FakeXhr.instances = []
  FakeXhr.respond = () => ({ status: 200, body: {} })
  ;(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr
}

beforeEach(() => {
  resetReauthDialog()
})

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetDesktopDeliveryMock()
  resetReauthDialog()
  ;(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = originalXhr
  document.body.innerHTML = ''
})

async function mountTab(): Promise<{
  wrapper: ReturnType<typeof mount>
  tab: VueWrapper
  state: DesktopDeliveryState
}> {
  useMock()
  const state = await getDesktopDelivery()
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/desktop?tab=versions')
  const wrapper = mount(
    defineComponent({
      render: () =>
        h(NMessageProvider, null, {
          default: () => h('div', [h(DesktopVersionsTab, { state }), h(ReauthGate)]),
        }),
    }),
    { global: { plugins: [router] }, attachTo: document.body },
  )
  // 假接口有 90ms 延迟：等发布列表与强更地板都到齐，否则表单会被「到货」的 props 覆盖
  await settle()
  wrappers.push(wrapper)
  return { wrapper, tab: wrapper.findComponent(DesktopVersionsTab) as VueWrapper, state }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120))
  await flushPromises()
}

function captureWrites(prefix: string): {
  calls: { url: string; method: string; body: string | null }[]
  restore: () => void
} {
  const calls: { url: string; method: string; body: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && url.includes(prefix)) {
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null })
    }
    return original(input, init)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

function setInput(testid: string, value: string): void {
  // NInput 的 input / textarea 都认（强更的「说明」是多行）
  const input = document.body.querySelector<HTMLInputElement>(`[data-testid="${testid}"] input, [data-testid="${testid}"] textarea`)
  expect(input, `找不到输入框 ${testid}`).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
}

function pickFile(testid: string, name: string, bytes = 'installer-bytes'): File {
  const file = new File([bytes], name, { type: 'application/octet-stream' })
  const input = document.body.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)
  expect(input, `找不到文件输入 ${testid}`).toBeTruthy()
  Object.defineProperty(input!, 'files', { value: [file], configurable: true })
  input!.dispatchEvent(new Event('change', { bubbles: true }))
  return file
}

describe('渠道策略', () => {
  it('两个渠道各一张卡，回填当前策略', async () => {
    const { wrapper } = await mountTab()
    expect(wrapper.findAll('[data-testid="desk-channel-card"]')).toHaveLength(2)
    const target = document.body.querySelector<HTMLInputElement>('[data-testid="desk-target-version-latest"] input')
    expect(target?.value).toBe('0.2.2')
    const percent = document.body.querySelector<HTMLInputElement>('[data-testid="desk-rollout-latest"] input')
    expect(percent?.value).toBe('25')
  })

  it('版本号格式不对就不提交（表单校验）', async () => {
    const { wrapper } = await mountTab()
    setInput('desk-target-version-latest', '0.2')
    await flushPromises()

    const capture = captureWrites('/api/admin/desktop/app')
    await wrapper.find('[data-testid="desk-channel-save-latest"]').trigger('click')
    await settle()
    capture.restore()

    expect(capture.calls).toEqual([])
    expect(document.body.textContent).toContain('版本号格式应为 1.2.3 / 1.2.3-rc.1')
  })

  it('灰度超过 100 报错', async () => {
    const { wrapper } = await mountTab()
    setInput('desk-rollout-nightly', '120')
    await flushPromises()

    const capture = captureWrites('/api/admin/desktop/app')
    await wrapper.find('[data-testid="desk-channel-save-nightly"]').trigger('click')
    await settle()
    capture.restore()

    expect(capture.calls).toEqual([])
    expect(document.body.textContent).toContain('填 0–100 的整数')
  })

  it('保存发出渠道级请求（空的最低版本 = null）', async () => {
    const { wrapper, tab } = await mountTab()
    setInput('desk-target-version-latest', '0.2.3')
    setInput('desk-min-version-latest', '0.2.1')
    setInput('desk-rollout-latest', '55')
    await flushPromises()

    const capture = captureWrites('/api/admin/desktop/app')
    await wrapper.find('[data-testid="desk-channel-save-latest"]').trigger('click')
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    expect(JSON.parse(capture.calls[0]!.body ?? '{}')).toEqual({
      channel: 'latest',
      targetVersion: '0.2.3',
      minVersion: '0.2.1',
      minVersionHard: false,
      rolloutPercent: 55,
    })
    expect(tab.emitted('changed')).toBeTruthy()
  })
})

describe('安装包发布与回滚', () => {
  it('上传中显示进度，成功后刷新列表', async () => {
    const { wrapper, tab } = await mountTab()
    FakeXhr.respond = () => ({
      status: 201,
      body: {
        id: 99,
        target: 'win-x64',
        channel: 'latest',
        version: '0.2.2',
        installerFile: 'deepseek-harness-0.2.2-win-x64.exe',
        installerBytes: 2048,
        installerSha512: 'x'.repeat(86),
        blockmapFile: null,
        feedFile: 'latest.yml',
        status: 'published',
        publishedAt: '2026-10-22T00:00:00.000Z',
      },
    })

    setInput('desk-release-version', '0.2.2')
    pickFile('desk-release-installer', 'deepseek-harness-0.2.2-win-x64.exe', 'x'.repeat(2048))
    await flushPromises()
    await wrapper.find('[data-testid="desk-release-publish"]').trigger('click')
    await flushPromises()

    const xhr = FakeXhr.instances[0]
    expect(xhr?.url).toBe('/api/admin/desktop/releases')
    xhr!.emitProgress(1024, 2048)
    await flushPromises()
    expect(wrapper.find('[data-testid="desktop-upload"]').text()).toContain('50%')

    await new Promise((resolve) => setTimeout(resolve, 20))
    await flushPromises()
    expect(tab.emitted('changed')).toBeTruthy()
  })

  it('稳定通道发预发布版本：前端直接拦下（不发请求）', async () => {
    const { wrapper } = await mountTab()
    setInput('desk-release-version', '0.3.0-rc.1')
    pickFile('desk-release-installer', 'x.exe')
    await flushPromises()

    await wrapper.find('[data-testid="desk-release-publish"]').trigger('click')
    await flushPromises()
    expect(FakeXhr.instances).toHaveLength(0)
    expect(document.body.textContent).toContain('稳定通道不能发预发布版本')
  })

  it('后端 409（同版本重复发布）原样提示', async () => {
    const { wrapper } = await mountTab()
    FakeXhr.respond = () => ({
      status: 409,
      body: { error: { code: 'CONFLICT', message: 'win-x64/latest 已经有 0.2.1 的发布记录' } },
    })
    setInput('desk-release-version', '0.2.1')
    pickFile('desk-release-installer', 'dup.exe')
    await flushPromises()
    await wrapper.find('[data-testid="desk-release-publish"]').trigger('click')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await flushPromises()
    expect(wrapper.find('[data-testid="desk-release-error"]').text()).toContain('已经有 0.2.1 的发布记录')
  })

  it('回滚：先弹二次密码，确认后才发请求', async () => {
    const { wrapper } = await mountTab()
    // 列表来自假接口：id=2 的 0.2.1 是当前 published
    const capture = captureWrites('/api/admin/desktop/releases/rollback')
    await wrapper.find('[data-testid="desk-release-rollback-2"]').trigger('click')
    await flushPromises()

    expect(reauthDialog.visible).toBe(true)
    expect(reauthDialog.title).toBe('确认回滚安装包')
    expect(capture.calls).toEqual([])

    resolveReauth()
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]!.method).toBe('POST')
    expect(JSON.parse(capture.calls[0]!.body ?? '{}')).toEqual({ target: 'win-x64', channel: 'latest' })
  })

  it('取消二次确认就不回滚', async () => {
    const { wrapper } = await mountTab()
    const capture = captureWrites('/api/admin/desktop/releases/rollback')
    await wrapper.find('[data-testid="desk-release-rollback-2"]').trigger('click')
    await flushPromises()
    expect(reauthDialog.visible).toBe(true)

    // 点「取消」= cancelReauth（这里直接复位弹窗）
    reauthDialog.visible = false
    await settle()
    capture.restore()
    expect(capture.calls).toEqual([])
  })
})

describe('强更地板', () => {
  it('预览跟着标题与说明走，字数与上限可见', async () => {
    const { wrapper } = await mountTab()
    setInput('desk-floor-title', '该升级了')
    setInput('desk-floor-detail', '这个版本已经不再支持，请安装新版本。')
    await flushPromises()

    const preview = wrapper.find('[data-testid="desk-floor-preview"]').text()
    expect(preview).toContain('该升级了')
    expect(preview).toContain('这个版本已经不再支持，请安装新版本。')
    expect(preview).toContain('打开网页')
    expect(wrapper.text()).toContain('4 / 256')
  })

  it('https 链接校验（http:// 拒绝）', async () => {
    const { wrapper } = await mountTab()
    setInput('desk-floor-link', 'http://hub.example/download')
    await flushPromises()

    const capture = captureWrites('/api/admin/desktop/update-floor')
    await wrapper.find('[data-testid="desk-floor-save"]').trigger('click')
    await settle()
    capture.restore()
    expect(capture.calls).toEqual([])
    expect(wrapper.find('[data-testid="desk-floor-link-error"]').text()).toContain('https://')
  })

  it('保存发出 minVersion / 文案 / 链接', async () => {
    const { wrapper, tab } = await mountTab()
    setInput('desk-floor-version', '0.2.1')
    setInput('desk-floor-link', 'https://hub.example/download')
    await flushPromises()

    const capture = captureWrites('/api/admin/desktop/update-floor')
    await wrapper.find('[data-testid="desk-floor-save"]').trigger('click')
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    const body = JSON.parse(capture.calls[0]!.body ?? '{}') as Record<string, unknown>
    expect(body['minVersion']).toBe('0.2.1')
    expect(body['appLink']).toBe('https://hub.example/download')
    expect(typeof body['title']).toBe('string')
    expect(tab.emitted('changed')).toBeTruthy()
  })
})

describe('覆盖', () => {
  it('新建覆盖：只允许角色 / 指定用户（没有「全部设备」选项）', async () => {
    const { wrapper } = await mountTab()
    await wrapper.find('[data-testid="desk-override-create-latest"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="desk-override-save"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="desktop-target-all"]')).toBeNull()
  })

  it('覆盖保存带 target（角色）与留空的字段', async () => {
    const { wrapper } = await mountTab()
    await wrapper.find('[data-testid="desk-override-create-latest"]').trigger('click')
    await flushPromises()
    setInput('desk-override-target-version', '0.2.4')
    await flushPromises()

    const capture = captureWrites('/api/admin/desktop/app')
    document.body.querySelector<HTMLButtonElement>('[data-testid="desk-override-save"]')!.click()
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    const body = JSON.parse(capture.calls[0]!.body ?? '{}') as Record<string, unknown>
    expect(body['target']).toEqual({ scope: 'role', role: 'user' })
    expect(body['targetVersion']).toBe('0.2.4')
    expect(body['minVersion']).toBeNull()
    // 灰度留空 = 不传（回到渠道级）
    expect('rolloutPercent' in body).toBe(false)
  })

  it('覆盖列表来自期望状态（两条）', async () => {
    const { wrapper } = await mountTab()
    const rows = wrapper.find('[data-testid="desk-overrides-table"]').text()
    expect(rows).toContain('管理员')
    expect(rows).toContain('用户 #4')
  })
})

describe('通道选择器', () => {
  it('安装包发布的通道下拉是「稳定 / 测试」', async () => {
    const { wrapper } = await mountTab()
    const selects = wrapper.findAllComponents(NSelect)
    const labels = selects.flatMap((select) =>
      (select.props('options') as { label: string }[] | undefined)?.map((option) => option.label) ?? [],
    )
    expect(labels).toContain('稳定')
    expect(labels).toContain('测试')
  })
})
