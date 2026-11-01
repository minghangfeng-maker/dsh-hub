import {
  DesktopAuthorizeViewSchema,
  DesktopDeviceListResponseSchema,
  DesktopMyDevicesResponseSchema,
  type DesktopDevice,
  type DesktopDeviceAdminItem,
  type DesktopMyDevicesResponse,
  type Settings,
} from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { fetchSettings } from '@/api/admin-users'
import {
  listAdminDesktopDevices,
  listMyDesktopDevices,
  revokeAdminDesktopDevice,
  revokeMyDesktopDevice,
} from '@/api/desktop'
import AdminDesktopDevicesPanel from '@/components/admin/desktop/AdminDesktopDevicesPanel.vue'
import DesktopDevicesCard from '@/components/desktop/DesktopDevicesCard.vue'
import { handleDesktop, resetDesktopMock } from '@/mocks/desktop'
import { MOCK_SCENARIOS, setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import AdminSettingsView from '@/views/admin/AdminSettingsView.vue'

/**
 * 桌面设备的前端三处（WP25c 交付物 2 / 3 / 6）：
 * - 工作台「桌面设备」卡片：列表字段 + 二次确认吊销 + 没有设备时的下载入口；
 * - 管理端台账：「全部」= 在用设备、选「已吊销」时 `presence=revoked` + `revoked=all`（否则两个条件互相抵消）；
 * - 系统设置「桌面端」分组：`settings.desktop` 五个字段都在界面上；
 * - 假数据：新场景的设备 / 授权请求都过一遍契约 schema（`?mock=` 走查用的就是它们）。
 */
vi.mock('@/api/desktop', () => ({
  listMyDesktopDevices: vi.fn(),
  revokeMyDesktopDevice: vi.fn(),
  listAdminDesktopDevices: vi.fn(),
  revokeAdminDesktopDevice: vi.fn(),
}))
vi.mock('@/api/admin-users', () => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}))

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

function adminItem(
  id: number,
  username: string,
  overrides: Partial<DesktopDevice> = {},
): DesktopDeviceAdminItem {
  return {
    user: {
      id: id + 100,
      slug: `u${String(id)}`,
      username,
      displayName: `${username} 的昵称`,
      avatarUrl: null,
    },
    device: device(id, { name: `${username} 的笔记本`, ...overrides }),
    pluginCount: 4,
  }
}

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  document.body.innerHTML = ''
  window.localStorage.clear()
})

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(listMyDesktopDevices).mockResolvedValue(myDevices([]))
})

async function mountWithProviders(
  component: unknown,
  path: string,
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

function clickPopconfirmPositive(text: string): void {
  const positive = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  )
  expect(positive, `应有「${text}」按钮`).toBeTruthy()
  positive?.click()
}

describe('工作台「桌面设备」（交付物 2）', () => {
  it('列出名称 / 系统 / 应用版本 / 最后在线 / 登录时间，且没有「本机」标记', async () => {
    vi.mocked(listMyDesktopDevices).mockResolvedValue(
      myDevices([
        device(1, { name: '小桃的 Windows 笔记本', presence: 'online' }),
        device(2, {
          name: '书房那台台式机',
          platform: 'win32',
          osMajor: '10',
          appVersion: '0.2.0',
          appChannel: 'nightly',
          presence: 'offline',
          lastReportAt: '2026-10-20T08:00:00.000Z',
        }),
      ]),
    )

    const { wrapper } = await mountWithProviders(DesktopDevicesCard, '/home')
    const text = wrapper.text()

    expect(text).toContain('桌面设备')
    expect(text).toContain('共 2 台')
    expect(text).toContain('小桃的 Windows 笔记本')
    expect(text).toContain('书房那台台式机')
    expect(text).toContain('Windows 11 · x64')
    expect(text).toContain('客户端 0.2.1')
    expect(text).toContain('最后在线')
    expect(text).toContain('登录于')
    expect(text).toContain('在线')
    expect(text).toContain('离线')
    // 服务端不知道哪台是当前浏览器所在的机器 → 不做「本机」标记
    expect(text).not.toContain('本机')
    expect(wrapper.findAll('[data-testid="desktop-device-row"]')).toHaveLength(2)
    expect(wrapper.find('a[href="/desktop/privacy"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="desktop-download-link"]').exists()).toBe(false)
  })

  it('「退出登录」要二次确认，确认后 DELETE 并按新数据刷新', async () => {
    vi.mocked(listMyDesktopDevices).mockResolvedValue(
      myDevices([device(1, { name: '小桃的 Windows 笔记本' })]),
    )
    vi.mocked(revokeMyDesktopDevice).mockResolvedValue()

    const { wrapper } = await mountWithProviders(DesktopDevicesCard, '/home')
    await wrapper.get('[data-testid="desktop-device-revoke"]').trigger('click')
    await flushPromises()

    expect(revokeMyDesktopDevice).not.toHaveBeenCalled()
    clickPopconfirmPositive('确认退出')
    await flushPromises()

    expect(revokeMyDesktopDevice).toHaveBeenCalledWith(device(1).deviceId)
    expect(listMyDesktopDevices).toHaveBeenCalledTimes(2)
  })

  it('没有设备时给「下载桌面端」入口（指向占位页）', async () => {
    const { wrapper } = await mountWithProviders(DesktopDevicesCard, '/home')

    expect(wrapper.get('[data-testid="desktop-devices-empty"]').text()).toContain('还没有设备登录过桌面端')
    const download = wrapper.get('[data-testid="desktop-download-link"]')
    expect(download.attributes('href')).toBe('/')
  })

  it('已吊销的设备不铺在工作台上（台账里看得到就够）', async () => {
    vi.mocked(listMyDesktopDevices).mockResolvedValue(
      myDevices([device(1), device(2, { revokedAt: '2026-10-22T07:00:00.000Z', revokeReason: 'user' })]),
    )
    const { wrapper } = await mountWithProviders(DesktopDevicesCard, '/home')

    expect(wrapper.findAll('[data-testid="desktop-device-row"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('共 1 台')
  })
})

describe('管理端「桌面设备」台账（交付物 3）', () => {
  const LIST = {
    items: [adminItem(1, 'mint'), adminItem(2, 'sakura', { presence: 'offline' })],
    total: 2,
    page: 1,
    pageSize: 20,
  }

  beforeEach(() => {
    vi.mocked(listAdminDesktopDevices).mockResolvedValue(LIST)
  })

  it('渲染用户 / 设备 / 系统 / 版本 / 状态，并显示总数', async () => {
    const { wrapper } = await mountWithProviders(AdminDesktopDevicesPanel, '/admin/instances?tab=desktop')
    const text = wrapper.text()

    expect(text).toContain('mint')
    expect(text).toContain('mint 的笔记本')
    expect(text).toContain('Windows 11')
    expect(text).toContain('0.2.1')
    expect(text).toContain('共 2 台')
    expect(listAdminDesktopDevices).toHaveBeenCalledWith(
      expect.objectContaining({ revoked: 'active', page: 1, pageSize: 20 }),
    )
    expect(wrapper.findAll('[data-testid="admin-desktop-revoke"]').length).toBeGreaterThan(0)
  })

  it('「全部」只列在用设备；筛选条件来自地址栏（在线 / 系统 / 版本）', async () => {
    await mountWithProviders(
      AdminDesktopDevicesPanel,
      '/admin/instances?tab=desktop&presence=online&platform=win32&version=0.2.1',
    )

    expect(listAdminDesktopDevices).toHaveBeenCalledWith({
      q: undefined,
      presence: 'online',
      revoked: 'active',
      platform: 'win32',
      appVersion: '0.2.1',
      page: 1,
      pageSize: 20,
    })
  })

  it('选「已吊销」时 presence=revoked 且 revoked=all（两个条件不能互相抵消）', async () => {
    await mountWithProviders(AdminDesktopDevicesPanel, '/admin/instances?tab=desktop&presence=revoked')

    expect(listAdminDesktopDevices).toHaveBeenCalledWith(
      expect.objectContaining({ presence: 'revoked', revoked: 'all' }),
    )
  })

  it('吊销要先确认，确认后调用管理端接口并刷新', async () => {
    vi.mocked(revokeAdminDesktopDevice).mockResolvedValue({ device: device(1) })
    const { wrapper } = await mountWithProviders(AdminDesktopDevicesPanel, '/admin/instances?tab=desktop')

    await wrapper.find('[data-testid="admin-desktop-revoke"]').trigger('click')
    await flushPromises()
    expect(revokeAdminDesktopDevice).not.toHaveBeenCalled()

    clickPopconfirmPositive('确认吊销')
    await flushPromises()

    expect(revokeAdminDesktopDevice).toHaveBeenCalledWith(device(1).deviceId)
    expect(listAdminDesktopDevices).toHaveBeenCalledTimes(2)
  })

  it('没有设备时给空状态文案', async () => {
    vi.mocked(listAdminDesktopDevices).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
    const { wrapper } = await mountWithProviders(AdminDesktopDevicesPanel, '/admin/instances?tab=desktop')

    expect(wrapper.get('[data-testid="admin-desktop-empty"]').text()).toContain('还没有用户登录桌面端')
  })
})

describe('系统设置「桌面端」分组（交付物 3）', () => {
  const SETTINGS: Settings = {
    site: { name: 'DSH Hub', tagline: '探索未至之境', announcement: '', announcementLevel: 'info' },
    registration: { mode: 'invite', requireApproval: false, maxUsers: 50 },
    default_quota: {
      cpus: 2,
      memoryMb: 4096,
      pidsLimit: 512,
      diskGb: 20,
      idleStopMinutes: 60,
      idleNoClientMinutes: 30,
      allowUserPlugins: true,
    },
    capacity: { maxRunning: 12, maxConcurrentExports: 2, busyMaxMinutes: 720 },
    exports: { ttlHours: 24, maxBytes: 20 * 1024 ** 3, dailyLimit: 5 },
    security: { adminSessionHours: 12, reauthMinutes: 10 },
    desktop: {
      maxDevicesPerUser: 5,
      reportIntervalSec: 60,
      minReportIntervalSec: 10,
      offlineAfterSec: 180,
      diagnosticsAllowed: false,
    },
    mobile: { app: { minVersionCode: 1, latestVersionCode: 1, downloadUrl: null } },
    container: { permissionPreset: 'danger-full-access', chatPreset: true },
    cockpit: { model: 'deepseek-v4.1-flash', autoExecuteR1: true },
  }

  it('settings.desktop 的五个字段都在界面上（单位写在标签里）', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(SETTINGS)
    const { wrapper } = await mountWithProviders(AdminSettingsView, '/admin/settings')
    const text = wrapper.text()

    expect(text).toContain('桌面端')
    expect(text).toContain('每人设备上限')
    expect(text).toContain('心跳间隔（秒）')
    expect(text).toContain('最短上报间隔（秒）')
    expect(text).toContain('离线判定（秒）')
    expect(text).toContain('允许上报诊断')
  })

  it('WP40d：容器分组有「容器内权限」与「普通对话」预设开关', async () => {
    vi.mocked(fetchSettings).mockResolvedValue(SETTINGS)
    const { wrapper } = await mountWithProviders(AdminSettingsView, '/admin/settings')
    const text = wrapper.text()

    expect(text).toContain('容器内权限')
    expect(text).toContain('完全放行（容器内免审批）')
    expect(text).toContain('下发「普通对话」预设')
  })
})

describe('桌面端假数据符合契约（交付物 6）', () => {
  it.each(MOCK_SCENARIOS)('场景 %s：我的设备列表过 DesktopMyDevicesResponseSchema', async (scenario) => {
    setMockScenario(scenario)
    resetDesktopMock()
    const response = handleDesktop(
      '/api/me/desktop-devices',
      'GET',
      new URL('http://127.0.0.1/api/me/desktop-devices'),
    )
    expect(response).toBeTruthy()
    const body: unknown = await response!.json()
    const parsed = DesktopMyDevicesResponseSchema.safeParse(body)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('desktop 场景：授权请求过 DesktopAuthorizeViewSchema，且是待授权', async () => {
    setMockScenario('desktop')
    resetDesktopMock()
    const response = handleDesktop(
      '/api/desktop/auth/requests/req_wp25c',
      'GET',
      new URL('http://127.0.0.1/api/desktop/auth/requests/req_wp25c'),
    )
    const parsed = DesktopAuthorizeViewSchema.safeParse(await response!.json())
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(parsed.data?.status).toBe('waiting')
    expect(parsed.data?.requestId).toBe('req_wp25c')
    // WP54c：`desktop` 场景多了第三台「手机网页版」设备（WP40a 起手机与桌面端共用台账）
    expect(parsed.data?.deviceCount).toBe(3)
  })

  it('desktop-expired 场景：授权请求 410；desktop-limit 场景：设备数打满上限', async () => {
    setMockScenario('desktop-expired')
    const expired = handleDesktop(
      '/api/desktop/auth/requests/any',
      'GET',
      new URL('http://127.0.0.1/api/desktop/auth/requests/any'),
    )
    expect(expired?.status).toBe(410)

    setMockScenario('desktop-limit')
    resetDesktopMock()
    const limit = handleDesktop(
      '/api/desktop/auth/requests/any',
      'GET',
      new URL('http://127.0.0.1/api/desktop/auth/requests/any'),
    )
    const view = DesktopAuthorizeViewSchema.parse(await limit!.json())
    expect(view.deviceCount).toBe(5)
    expect(view.deviceLimit).toBe(5)
  })

  it('管理端场景：台账过 DesktopDeviceListResponseSchema，且「在用 / 已吊销」筛选对得上', async () => {
    setMockScenario('admin')
    resetDesktopMock()

    const active = handleDesktop(
      '/api/admin/desktop-devices',
      'GET',
      new URL('http://127.0.0.1/api/admin/desktop-devices?revoked=active&page=1&pageSize=20'),
    )
    const activeBody = DesktopDeviceListResponseSchema.parse(await active!.json())
    expect(activeBody.items.length).toBeGreaterThan(0)
    expect(activeBody.items.every((item) => item.device.presence !== 'revoked')).toBe(true)

    const revoked = handleDesktop(
      '/api/admin/desktop-devices',
      'GET',
      new URL('http://127.0.0.1/api/admin/desktop-devices?presence=revoked&revoked=all&page=1&pageSize=20'),
    )
    const revokedBody = DesktopDeviceListResponseSchema.parse(await revoked!.json())
    expect(revokedBody.items.length).toBeGreaterThan(0)
    expect(revokedBody.items.every((item) => item.device.presence === 'revoked')).toBe(true)
  })

  it('吊销是会话内的（同一场景刷新后仍在吊销态）', async () => {
    setMockScenario('desktop')
    resetDesktopMock()
    const first = handleDesktop(
      '/api/me/desktop-devices',
      'GET',
      new URL('http://127.0.0.1/api/me/desktop-devices'),
    )
    const before = DesktopMyDevicesResponseSchema.parse(await first!.json())
    // 2 台桌面端 + 1 台手机网页版（WP54c 的假数据）
    expect(before.items).toHaveLength(3)

    const revoked = handleDesktop(
      `/api/me/desktop-devices/${before.items[0]!.deviceId}`,
      'DELETE',
      new URL(`http://127.0.0.1/api/me/desktop-devices/${before.items[0]!.deviceId}`),
    )
    expect(revoked?.status).toBe(204)

    const second = handleDesktop(
      '/api/me/desktop-devices',
      'GET',
      new URL('http://127.0.0.1/api/me/desktop-devices'),
    )
    const after = DesktopMyDevicesResponseSchema.parse(await second!.json())
    expect(after.limit.used).toBe(2)
    expect(after.items[0]?.revokeReason).toBe('user')
  })
})
