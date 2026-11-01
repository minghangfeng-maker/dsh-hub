import {
  DESKTOP_PERMISSIONS,
  DesktopLoginErrorCodeSchema,
  type DesktopAuthorizeView as AuthorizeView,
  type DesktopDevice,
  type DesktopMyDevicesResponse,
} from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import {
  decideDesktopAuthorize,
  fetchDesktopAuthorizeRequest,
  listMyDesktopDevices,
  revokeMyDesktopDevice,
} from '@/api/desktop'
import { HubApiError } from '@/api/http'
import { loginCodeText } from '@/components/desktop/text'
import { routes } from '@/router'
import { replaceLocation } from '@/utils/navigation'
import DesktopAuthorizeView from '@/views/desktop/DesktopAuthorizeView.vue'

/**
 * 桌面端授权页（WP25c 交付物 1，D2 §3.2）。
 *
 * 三件事必须守住：
 * 1. 三种状态（待授权 / 已过期或不存在 / 已处理）各有明确界面；
 * 2. 点「允许 / 拒绝」拿到 redirectUrl 后**只跳本机回环**——后端返回别的地址就拒绝跳转并报错
 *    （开放重定向防线，任务书「验证」第 1 条）；
 * 3. 设备数超限时就地列出已登录设备、可吊销一台（不必离开授权页）。
 */
vi.mock('@/api/desktop', () => ({
  fetchDesktopAuthorizeRequest: vi.fn(),
  decideDesktopAuthorize: vi.fn(),
  listMyDesktopDevices: vi.fn(),
  revokeMyDesktopDevice: vi.fn(),
}))
vi.mock('@/utils/navigation', () => ({ replaceLocation: vi.fn() }))

const EXPIRES = '2026-10-22T09:10:00.000Z'

function authorizeView(overrides: Partial<AuthorizeView> = {}): AuthorizeView {
  return {
    requestId: 'req_1',
    deviceName: 'WP25C-TEST-PC',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    locale: 'zh-CN',
    user: { username: 'littletao', displayName: '小桃', roleLabel: '普通用户' },
    expiresAt: EXPIRES,
    deviceCount: 1,
    deviceLimit: 5,
    permissions: [...DESKTOP_PERMISSIONS],
    status: 'waiting',
    ...overrides,
  }
}

function device(id: number, overrides: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    deviceId: `dv_${String(id).padStart(32, '0')}`,
    name: `设备 ${String(id)}`,
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    capabilities: null,
    desiredRevision: 17,
    appliedRevision: 17,
    appliedAt: '2026-10-21T08:00:00.000Z',
    applyState: 'applied',
    applyErrorCode: null,
    errorCount: 0,
    presence: 'online',
    firstSeenAt: '2026-10-01T08:00:00.000Z',
    registeredAt: '2026-10-21T08:00:00.000Z',
    lastReportAt: '2026-10-22T08:20:00.000Z',
    lastAuthAt: '2026-10-21T08:00:00.000Z',
    revokedAt: null,
    revokeReason: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }
}

function myDevices(items: DesktopDevice[], max = 5): DesktopMyDevicesResponse {
  return {
    items,
    limit: { max, used: items.filter((item) => item.revokedAt === null).length },
  }
}

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(fetchDesktopAuthorizeRequest).mockResolvedValue(authorizeView())
  vi.mocked(listMyDesktopDevices).mockResolvedValue(myDevices([]))
  vi.mocked(decideDesktopAuthorize).mockResolvedValue({
    redirectUrl: 'http://127.0.0.1:53124/oauth/hub/callback?code=abc&state=xyz',
  })
})

async function routerAt(path: string): Promise<Router> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  return router
}

async function mountAuthorize(path = '/desktop/authorize?req=req_1'): Promise<VueWrapper> {
  const router = await routerAt(path)
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(DesktopAuthorizeView) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function buttonByTestId(wrapper: VueWrapper, testId: string) {
  return wrapper.find(`[data-testid="${testId}"]`)
}

describe('桌面端授权页：待授权状态', () => {
  it('显示设备名 / 系统 / 客户端版本、当前账号与权限清单', async () => {
    const wrapper = await mountAuthorize()

    expect(fetchDesktopAuthorizeRequest).toHaveBeenCalledWith('req_1')
    const text = wrapper.text()
    expect(text).toContain('登录授权')
    expect(text).toContain('WP25C-TEST-PC')
    expect(text).toContain('Windows 11')
    expect(text).toContain('x64')
    expect(text).toContain('客户端 0.2.1')
    expect(text).toContain('小桃')
    expect(text).toContain('@littletao')
    expect(text).toContain('普通用户')
    // 权限清单逐条本地化（不显示 account.read 之类的契约值）
    for (const permission of DESKTOP_PERMISSIONS) {
      expect(text).toContain(permissionTextOf(permission))
    }
    expect(buttonByTestId(wrapper, 'desktop-authorize-allow').exists()).toBe(true)
    expect(buttonByTestId(wrapper, 'desktop-authorize-deny').exists()).toBe(true)
    expect(buttonByTestId(wrapper, 'desktop-authorize-not-me').exists()).toBe(true)
    // 隐私说明始终可达
    expect(wrapper.find('a[href="/desktop/privacy"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="desktop-authorize-limit"]').exists()).toBe(false)
  })

  it('点「允许」→ approve 后整页跳到本机回环地址', async () => {
    const wrapper = await mountAuthorize()
    await buttonByTestId(wrapper, 'desktop-authorize-allow').trigger('click')
    await flushPromises()

    expect(decideDesktopAuthorize).toHaveBeenCalledWith('req_1', true)
    expect(replaceLocation).toHaveBeenCalledWith(
      'http://127.0.0.1:53124/oauth/hub/callback?code=abc&state=xyz',
    )
  })

  it('点「拒绝」→ deny 后同样回到桌面端，不出现错误态', async () => {
    vi.mocked(decideDesktopAuthorize).mockResolvedValue({
      redirectUrl: 'http://localhost:53124/oauth/hub/callback?error=access_denied&state=xyz',
    })
    const wrapper = await mountAuthorize()
    await buttonByTestId(wrapper, 'desktop-authorize-deny').trigger('click')
    await flushPromises()

    expect(decideDesktopAuthorize).toHaveBeenCalledWith('req_1', false)
    expect(replaceLocation).toHaveBeenCalledWith(
      'http://localhost:53124/oauth/hub/callback?error=access_denied&state=xyz',
    )
    expect(wrapper.find('[data-testid="desktop-authorize-problem"]').exists()).toBe(false)
  })

  it('「这不是我的设备」也是拒绝（同一个动作，语义不同）', async () => {
    const wrapper = await mountAuthorize()
    await buttonByTestId(wrapper, 'desktop-authorize-not-me').trigger('click')
    await flushPromises()
    expect(decideDesktopAuthorize).toHaveBeenCalledWith('req_1', false)
  })
})

describe('桌面端授权页：防开放重定向', () => {
  it.each([
    ['公网地址', 'https://evil.example/callback?code=abc&state=xyz'],
    ['同主机的公网域名', 'http://127.0.0.1.evil.example:53124/cb?code=abc'],
    ['缺端口的回环', 'http://127.0.0.1/oauth/hub/callback?code=abc'],
    ['userinfo 伪装', 'http://127.0.0.1@evil.example:53124/cb?code=abc'],
    ['非 http 协议', 'dsh-app://app/callback?code=abc'],
  ])('后端返回%s时不跳转，就地报错', async (_label, redirectUrl) => {
    vi.mocked(decideDesktopAuthorize).mockResolvedValue({ redirectUrl })
    const wrapper = await mountAuthorize()
    await buttonByTestId(wrapper, 'desktop-authorize-allow').trigger('click')
    await flushPromises()

    expect(replaceLocation).not.toHaveBeenCalled()
    const problem = wrapper.get('[data-testid="desktop-authorize-problem"]')
    expect(problem.text()).toContain('不安全')
  })
})

describe('桌面端授权页：过期 / 不存在 / 已处理', () => {
  it('410 GONE（loginCode=expired）→ 过期态，没有允许按钮', async () => {
    vi.mocked(fetchDesktopAuthorizeRequest).mockRejectedValue(
      new HubApiError('GONE', '登录请求已过期，请在桌面端重新发起登录', 410, { loginCode: 'expired' }),
    )
    const wrapper = await mountAuthorize()

    const problem = wrapper.get('[data-testid="desktop-authorize-problem"]')
    expect(problem.text()).toContain('这次登录已过期')
    expect(problem.text()).toContain('桌面端重新点「登录」')
    expect(wrapper.find('[data-testid="desktop-authorize-allow"]').exists()).toBe(false)
  })

  it('404 NOT_FOUND → 请求不存在态', async () => {
    vi.mocked(fetchDesktopAuthorizeRequest).mockRejectedValue(
      new HubApiError('NOT_FOUND', '登录请求不存在或已失效，请在桌面端重新发起登录', 404),
    )
    const wrapper = await mountAuthorize()
    expect(wrapper.get('[data-testid="desktop-authorize-problem"]').text()).toContain('登录请求不存在')
  })

  it('缺 req 参数 → 直接提示缺少编号，不发请求', async () => {
    const wrapper = await mountAuthorize('/desktop/authorize')
    expect(fetchDesktopAuthorizeRequest).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="desktop-authorize-problem"]').text()).toContain('缺少登录请求编号')
  })

  it('刷新回来看到 status=allowed → 「已经允许」，不再显示按钮', async () => {
    vi.mocked(fetchDesktopAuthorizeRequest).mockResolvedValue(authorizeView({ status: 'allowed' }))
    const wrapper = await mountAuthorize()

    expect(wrapper.get('[data-testid="desktop-authorize-done"]').text()).toContain('已经允许这台设备登录')
    expect(wrapper.find('[data-testid="desktop-authorize-allow"]').exists()).toBe(false)
  })

  it('点击时后端回 409 CONFLICT → 报「已经处理过了」并刷新真实状态', async () => {
    vi.mocked(decideDesktopAuthorize).mockRejectedValue(
      new HubApiError('CONFLICT', '这条登录请求已经处理过了', 409),
    )
    const wrapper = await mountAuthorize()
    await buttonByTestId(wrapper, 'desktop-authorize-allow').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="desktop-authorize-problem"]').text()).toContain('已经处理过了')
    expect(replaceLocation).not.toHaveBeenCalled()
  })
})

describe('登录阶段的细分错误码（details.loginCode）都有中文文案', () => {
  it.each(DesktopLoginErrorCodeSchema.options)('%s 有中文说明', (code) => {
    const text = loginCodeText(code)
    expect(text, `loginCode ${code} 缺少文案`).toBeTruthy()
    expect(text).toMatch(/[一-鿿]/u)
    expect(text).not.toBe(code)
  })

  it('认不出的 loginCode 返回 null（界面回落到全局错误码文案）', () => {
    expect(loginCodeText('something_new')).toBeNull()
    expect(loginCodeText(undefined)).toBeNull()
  })
})

describe('桌面端授权页：设备数超限', () => {
  it('达到上限时提示并列出已登录设备，可就地吊销一台', async () => {
    vi.mocked(fetchDesktopAuthorizeRequest).mockResolvedValue(
      authorizeView({ deviceCount: 5, deviceLimit: 5 }),
    )
    vi.mocked(listMyDesktopDevices).mockResolvedValue(
      myDevices([device(1), device(2), device(3), device(4), device(5)]),
    )
    vi.mocked(revokeMyDesktopDevice).mockResolvedValue()

    const wrapper = await mountAuthorize()
    const limit = wrapper.get('[data-testid="desktop-authorize-limit"]')
    expect(limit.text()).toContain('已登录 5 台设备')
    expect(limit.text()).toContain('上限（5 台）')
    expect(wrapper.findAll('[data-testid="desktop-authorize-limit-row"]')).toHaveLength(5)

    await wrapper.find('[data-testid="desktop-authorize-limit-revoke"]').trigger('click')
    await flushPromises()
    const positive = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '确认吊销',
    )
    expect(positive, '应有「确认吊销」').toBeTruthy()
    positive?.click()
    await flushPromises()

    expect(revokeMyDesktopDevice).toHaveBeenCalledWith(device(1).deviceId)
    // 吊销后重新取数（设备数会变，上限提示可能消失）
    expect(fetchDesktopAuthorizeRequest).toHaveBeenCalledTimes(2)
  })

  it('没到上限时不请求设备列表，也不显示提示', async () => {
    const wrapper = await mountAuthorize()
    expect(listMyDesktopDevices).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="desktop-authorize-limit"]').exists()).toBe(false)
  })
})

/** 与 `components/desktop/text.ts` 的权限文案一致（这里只用来断言「没有再显示契约英文值」） */
function permissionTextOf(permission: string): string {
  const map: Record<string, string> = {
    'account.read': '用户名、昵称与角色',
    'wallet.read': '积分余额',
    'relay.call': '走 Hub 中转站调用模型',
    'manifest.pull': '接收下发的插件与配置',
  }
  return map[permission] ?? permission
}
