import type { AdminPluginRow } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { resolveReauth } from '@/composables/useReauth'
import { installMockFetch } from '@/mocks/fetch'
import { resetPluginLibraryMock } from '@/mocks/admin'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import DesktopPluginLibrary from '@/components/admin/desktop/DesktopPluginLibrary.vue'

/**
 * 插件 · 桌面侧的桌面插件库（WP32b，docs/22 §2）：
 *
 * - 列表只出来桌面库里的插件（云上独有的 dsh-im 与视频渲染不在），带「内置」徽标与已装设备；
 * - 桌面策略就地改 → `PATCH /plugins/:id/platforms/desktop`；
 * - 加入 / 移出桌面库（移出遇到 409 时走二次密码 + `force=1`）；
 * - 上传 `.tgz` = 创建桌面版本（XHR 带进度，`?platform=desktop`）；
 * - 批量 → 统一下发向导，预选 `platforms=desktop`。
 */

// ── 假 XHR（上传走 XMLHttpRequest：fetch 看不到进度）────────────────────────

interface FakeResponse {
  status: number
  body: unknown
}

class FakeXhr extends EventTarget {
  static instances: FakeXhr[] = []
  static respond: (xhr: FakeXhr) => FakeResponse = () => ({ status: 200, body: {} })

  upload = new EventTarget()
  status = 0
  responseText = ''
  withCredentials = false
  responseType = ''
  method = ''
  url = ''
  body: XMLHttpRequestBodyInit | null = null

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(): void {
    // 不关心
  }

  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    this.body = (body as XMLHttpRequestBodyInit | null) ?? null
    FakeXhr.instances.push(this)
    setTimeout(() => {
      const response = FakeXhr.respond(this)
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

function installFakeXhr(): void {
  FakeXhr.instances = []
  FakeXhr.respond = () => ({ status: 200, body: {} })
  ;(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetPluginLibraryMock()
  ;(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = originalXhr
  document.body.innerHTML = ''
})

interface Mounted {
  wrapper: ReturnType<typeof mount>
  router: ReturnType<typeof createRouter>
}

async function mountLibrary(): Promise<Mounted> {
  setMockScenario('admin')
  restores.push(installMockFetch('admin'))
  installFakeXhr()
  resetPluginLibraryMock()

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/plugins?platform=desktop')
  const wrapper = mount(
    defineComponent({
      render: () => h(NMessageProvider, null, { default: () => h(DesktopPluginLibrary) }),
    }),
    { global: { plugins: [router] }, attachTo: document.body },
  )
  await flushPromises()
  wrappers.push(wrapper)
  await settle()
  return { wrapper, router }
}

/** 假接口每个请求有 90ms 人为延迟（列表 + 安装统计是两个串行请求），等过它 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 320))
  await flushPromises()
}

/** 抓请求（在假接口之上再包一层） */
function captureRequests(
  match: (url: string) => boolean,
): { calls: { url: string; method: string; body: string | null }[]; restore: () => void } {
  const calls: { url: string; method: string; body: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (match(url)) {
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

function pick(testid: string, bytes = 'tgz-bytes', name = 'demo.tgz'): void {
  const file = new File([bytes], name, { type: 'application/gzip' })
  const input = document.body.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)
  expect(input, `找不到文件输入 ${testid}`).toBeTruthy()
  Object.defineProperty(input!, 'files', { value: [file], configurable: true })
  input!.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 按 data-testid 找某一行的下拉（naive-ui 的 NSelect 会透传 attrs 到根节点） */
function selectByTestId(wrapper: ReturnType<typeof mount>, testid: string) {
  const found = wrapper
    .findAllComponents(NSelect)
    .find((item) => item.attributes('data-testid') === testid)
  expect(found, `找不到下拉 ${testid}`).toBeTruthy()
  return found!
}

describe('桌面插件库列表', () => {
  it('只列桌面库里的插件；内置与已装设备都在', async () => {
    const { wrapper } = await mountLibrary()
    const text = wrapper.text()
    expect(text).toContain('共 2 个桌面插件')
    expect(text).toContain('邮件助手')
    expect(text).toContain('文件下载器')
    // dsh-im 与视频渲染只在云上（桌面没有整包）→ 不应该出现（与统一下发向导的数据同源）
    expect(text).not.toContain('IM 机器人')
    expect(text).not.toContain('视频渲染')
    // 邮件助手在桌面库有两个版本（0.16.0 / 0.15.0），不是云上的版本号
    expect(text).toContain('2 个版本')
    // 文件下载器是客户端自带的一个（安装统计里 bundledDevices=2）
    expect(text).toContain('内置 v')
  })

  it('桌面策略就地改 → PATCH /plugins/:id/platforms/desktop', async () => {
    const { wrapper } = await mountLibrary()
    const capture = captureRequests((url) => url.includes('/platforms/desktop'))
    selectByTestId(wrapper, 'lib-policy-3').vm.$emit('update:value', 'optional')
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]!.method).toBe('PATCH')
    expect(capture.calls[0]!.url).toContain('/api/admin/plugins/3/platforms/desktop')
    expect(JSON.parse(capture.calls[0]!.body ?? '{}')).toEqual({ policy: 'optional' })
  })
})

describe('加入 / 移出桌面库', () => {
  it('候选只有「还不在桌面库」的插件，加入后列表多一个', async () => {
    const { wrapper } = await mountLibrary()
    await wrapper.find('[data-testid="lib-add-open"]').trigger('click')
    await settle()

    // 候选 = 云上有、桌面没有整包的插件（dsh-im、视频渲染），默认选中第一个（dsh-im id=2）
    const capture = captureRequests((url) => /\/api\/admin\/plugins\/\d+\/platforms$/.test(url))
    document.body.querySelector<HTMLButtonElement>('[data-testid="lib-add-confirm"]')!.click()
    await settle()
    capture.restore()

    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]!.method).toBe('POST')
    expect(JSON.parse(capture.calls[0]!.body ?? '{}')).toEqual({ platform: 'desktop', policy: 'optional' })
    expect(wrapper.text()).toContain('共 3 个桌面插件')
    expect(wrapper.text()).toContain('IM 机器人')
  })

  it('移出遇 409 → 二次密码确认后带 force=1 再来一次', async () => {
    const { wrapper } = await mountLibrary()
    const capture = captureRequests((url) => url.includes('/platforms/desktop'))

    // 邮件助手有桌面下发目标：第一次 DELETE 被服务端拒绝
    await wrapper.find('[data-testid="lib-remove-1"]').trigger('click')
    await settle()
    const positive = document.body.querySelector<HTMLButtonElement>('.n-popconfirm__action .n-button--primary-type')
    expect(positive, '应弹出行内确认').toBeTruthy()
    positive!.click()
    await settle()

    expect(document.body.textContent).toContain('还有桌面端下发目标')
    document.body.querySelector<HTMLButtonElement>('[data-testid="lib-force-confirm"]')!.click()
    await settle()
    // 二次密码框（ReauthGate 没挂，直接确认掉）
    resolveReauth()
    await settle()
    capture.restore()

    expect(capture.calls.map((call) => `${call.method} force=${call.url.includes('force=1') ? 1 : 0}`)).toEqual([
      'DELETE force=0',
      'DELETE force=1',
    ])
  })
})

describe('上传桌面整包（创建桌面版本）', () => {
  it('XHR 打到 ?platform=desktop，进度可见，成功后刷新列表', async () => {
    const { wrapper } = await mountLibrary()
    selectByTestId(wrapper, 'lib-package-plugin').vm.$emit('update:value', 1)
    await flushPromises()

    FakeXhr.respond = () => ({
      status: 201,
      body: {
        version: {
          id: 1101,
          platform: 'desktop',
          version: '1.0.1',
          sourceType: 'upload',
          sourceRef: 'dsh-email-1.0.1.tgz',
          spec: 'file:/opt/hub/plugin-store/desktop-dsh-email-1.0.1.tgz',
          sha256: 'a'.repeat(64),
          minDsh: null,
          createdAt: '2026-10-22T00:00:00.000Z',
        },
      },
    })

    pick('lib-package-file', 'x'.repeat(2000), 'dsh-email-1.0.1.tgz')
    await flushPromises()
    await wrapper.find('[data-testid="lib-package-upload"]').trigger('click')
    await flushPromises()

    const xhr = FakeXhr.instances[0]
    expect(xhr, '应该发了一次 XHR 上传').toBeTruthy()
    expect(xhr!.method).toBe('POST')
    expect(xhr!.url).toBe('/api/admin/plugins/1/versions?platform=desktop')

    xhr!.emitProgress(500, 2000)
    await flushPromises()
    expect(document.body.querySelector('[data-testid="desktop-upload"]')?.textContent).toContain('%')

    await settle()
    expect(wrapper.find('[data-testid="lib-package-error"]').exists()).toBe(false)
  })

  it('服务端的拒绝理由原样显示（缺 LICENSE / NOTICE）', async () => {
    const { wrapper } = await mountLibrary()
    selectByTestId(wrapper, 'lib-package-plugin').vm.$emit('update:value', 1)
    await flushPromises()

    FakeXhr.respond = () => ({
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: '带 codex 二进制的整包必须同时包含 LICENSE 与 NOTICE（Apache-2.0 再分发要求）',
          details: { fields: { file: '缺 LICENSE 或 NOTICE' } },
        },
      },
    })

    pick('lib-package-file')
    await flushPromises()
    await wrapper.find('[data-testid="lib-package-upload"]').trigger('click')
    await settle()

    const error = wrapper.find('[data-testid="lib-package-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('必须同时包含 LICENSE 与 NOTICE')
    expect(error.text()).toContain('缺 LICENSE 或 NOTICE')
  })
})

describe('批量 → 统一下发', () => {
  it('勾选两个插件后点「下发 / 安装」，向导预选桌面平台', async () => {
    const { wrapper, router } = await mountLibrary()
    const boxes = wrapper.findAll('[aria-label^="选择 "]')
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    await boxes[0]!.trigger('click')
    await boxes[1]!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已选 2 个')
    const buttons = wrapper.findAll('button').filter((item) => item.text().includes('下发 / 安装'))
    await buttons.at(-1)!.trigger('click')
    // 目标路由是懒加载：等它真正切过去（慢机器上模块加载可能远超固定的 settle 时长）
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/rollouts'), {
      timeout: 5000,
      interval: 50,
    })
    await settle()
    expect(router.currentRoute.value.query).toMatchObject({
      platforms: 'desktop',
      action: 'install',
    })
    expect(String(router.currentRoute.value.query['items'])).toMatch(/^plugin:\d+,plugin:\d+$/u)
  })
})

/** 供类型检查：桌面行里应该带 platform */
const _typecheck: AdminPluginRow['platform'] = 'desktop'
void _typecheck
