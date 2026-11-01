import type { AdminOverviewResponse, DesktopDeliveryState, DesktopDeviceListResponse } from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { listInstances } from '@/api/admin-instances'
import { fetchOverview } from '@/api/admin-users'
import { handleDesktop } from '@/mocks/desktop'
import { handleDesktopDelivery, resetDesktopDeliveryMock } from '@/mocks/desktop-delivery'
import { resetDesktopMock } from '@/mocks/desktop'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import AdminDesktopDevicesPanel from '@/components/admin/desktop/AdminDesktopDevicesPanel.vue'
import AdminStatCard from '@/components/admin/AdminStatCard.vue'
import AdminInstancesView from '@/views/admin/AdminInstancesView.vue'

/**
 * 实例页的「云上 | 桌面」平台切换（WP32b，docs/22 §1.3）：
 *
 * - 云上：原有的容器列表（顶部「运行中 x/y」汇总）；
 * - 桌面：设备统计卡（原「桌面端 · 总览」的四颗数）+ 设备台账；
 * - 旧的 `?tab=cloud|desktop` 仍然认，会规范成 `?platform=`；云上缺省不写进地址栏；
 * - 切的平台记进 localStorage，换页面仍停在那一边。
 *
 * 统计卡的数字与台账是同一份数据（`GET /api/admin/desktop-devices`），这里用假接口的台账
 * 反推期望值，避免「两套算法」。
 */
vi.mock('@/api/admin-users', () => ({ fetchOverview: vi.fn() }))
vi.mock('@/api/admin-instances', () => ({ listInstances: vi.fn(), instanceAction: vi.fn() }))
vi.mock('@/api/desktop', () => ({
  listAdminDesktopDevices: vi.fn(),
  revokeAdminDesktopDevice: vi.fn(),
  revokeAdminDesktopDevices: vi.fn(),
  getAdminDesktopDevice: vi.fn(),
}))
vi.mock('@/api/admin-desktop', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getDesktopDelivery: vi.fn() }
})

// 动态 import 拿到被 mock 的模块（vi.mock 已提升到文件顶部）
const desktopApi = await import('@/api/desktop')
const adminDesktopApi = await import('@/api/admin-desktop')
const listDevices = vi.mocked(desktopApi.listAdminDesktopDevices)
const getDelivery = vi.mocked(adminDesktopApi.getDesktopDelivery)

function overview(desktop?: AdminOverviewResponse['desktop']): AdminOverviewResponse {
  return {
    users: { total: 12, active: 11, pending: 1, disabled: 0, newToday: 0 },
    instances: { running: 3, max: 12, starting: 0, error: 0 },
    host: {
      cpuCount: 16,
      load1: 1.2,
      load5: 1,
      memTotal: 64_000,
      memAvailable: 32_000,
      diskTotal: 1_000_000,
      diskFree: 500_000,
      dockerOk: true,
      dockerVersion: '27.3.1',
    },
    jobs: { running: 0, queued: 0, failedLast24h: 0 },
    runtime: { defaultVersion: null, versions: 0 },
    recent: { registrations: [], audit: [] },
    ...(desktop ? { desktop } : {}),
  }
}

/** 用假接口自己造台账与期望状态（形状与契约一致，不手搓设备对象） */
async function mockDesktopFixtures(): Promise<{
  devices: DesktopDeviceListResponse
  delivery: DesktopDeliveryState
}> {
  setMockScenario('admin-desktop')
  resetDesktopMock()
  resetDesktopDeliveryMock()
  const devicesResponse = handleDesktop(
    '/api/admin/desktop-devices',
    'GET',
    new URL('http://localhost/api/admin/desktop-devices?pageSize=100'),
  )
  const deliveryResponse = handleDesktopDelivery(
    '/api/admin/desktop/delivery',
    'GET',
    new URL('http://localhost/api/admin/desktop/delivery'),
  )
  expect(devicesResponse, '假接口应有台账').toBeTruthy()
  expect(deliveryResponse, '假接口应有期望状态').toBeTruthy()
  const devices = (await devicesResponse!.json()) as DesktopDeviceListResponse
  const delivery = (await deliveryResponse!.json()) as DesktopDeliveryState
  listDevices.mockResolvedValue(devices)
  getDelivery.mockResolvedValue(delivery)
  return { devices, delivery }
}

function onlineOf(devices: DesktopDeviceListResponse): number {
  return devices.items.filter((item) => item.device.presence === 'online').length
}

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  setMockScenario('running')
  resetDesktopMock()
  resetDesktopDeliveryMock()
  localStorage.clear()
  document.body.innerHTML = ''
})

beforeEach(() => {
  vi.mocked(listInstances).mockResolvedValue([])
  vi.mocked(fetchOverview).mockResolvedValue(overview({ total: 8, online: 3, revoked: 1, stale: 4 }))
  listDevices.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
  getDelivery.mockResolvedValue({
    revision: 0,
    allowlistVersion: 1,
    pluginTargets: [],
    configFragments: [],
    uninstalls: [],
    app: { channels: [], overrides: [] },
    warnings: [],
  })
})

async function mountView(path = '/admin/instances'): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(AdminInstancesView) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

describe('实例页：云上 / 桌面切换', () => {
  it('云上缺省：容器列表 + 平台切换；统计卡与旧「在线 N/M」按钮都不在', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.find('[data-testid="platform-switch"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('运行中 0')
    expect(wrapper.find('[data-testid="devices-summary"]').exists()).toBe(false)
    // WP25f 的「桌面端 在线 N/M」已被平台切换取代
    expect(document.querySelector('[data-testid="instances-desktop-online"]')).toBeNull()
  })

  it('桌面侧：统计卡四颗数来自台账与期望状态，下面是设备台账', async () => {
    const { devices, delivery } = await mockDesktopFixtures()
    const { wrapper } = await mountView('/admin/instances?platform=desktop')

    const summary = wrapper.find('[data-testid="devices-summary"]')
    expect(summary.exists()).toBe(true)

    // 数字走 CountUp 动画（文本是中间值），这里直接读卡片 props
    interface CardProps {
      label: string
      value: number
      suffix: string
    }
    const componentList = summary.findAllComponents(AdminStatCard) as unknown as {
      props: () => CardProps
    }[]
    const cards: CardProps[] = componentList.map((card) => ({
      label: card.props().label,
      value: card.props().value,
      suffix: card.props().suffix,
    }))
    expect(cards.map((item) => item.label)).toEqual(['当前 revision', '在线设备', '待应用', '失败'])
    expect(cards[0]!.value).toBe(delivery.revision)
    expect(cards[1]!.value).toBe(onlineOf(devices))
    expect(cards[1]!.suffix).toBe(` / ${String(devices.items.length)}`)

    // 台账面板也在（筛选与分页在 AdminDesktopDevicesPanel 里）
    expect(wrapper.findComponent(AdminDesktopDevicesPanel).exists()).toBe(true)
  })

  it('旧参数 ?tab=desktop 仍然落到桌面侧，并规范成 ?platform=desktop', async () => {
    const { router } = await mountView('/admin/instances?tab=desktop')
    await flushPromises()
    expect(router.currentRoute.value.query['platform']).toBe('desktop')
    expect(router.currentRoute.value.query['tab']).toBeUndefined()
  })

  it('切的平台写进记忆值：重新进入不带参数的页面仍停在桌面', async () => {
    const first = await mountView('/admin/instances?platform=desktop')
    await flushPromises()
    expect(localStorage.getItem('hub.admin.platform')).toBe('desktop')
    first.wrapper.unmount()

    // 新的一次进入（地址栏没有 platform）：从记忆值恢复并写回地址栏
    const { router } = await mountView('/admin/instances')
    await flushPromises()
    expect(router.currentRoute.value.query['platform']).toBe('desktop')
  })
})
