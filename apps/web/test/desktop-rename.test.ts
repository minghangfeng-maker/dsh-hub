import type { DesktopDevice, DesktopMyDevicesResponse } from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { listMyDesktopDevices, renameMyDesktopDevice } from '@/api/desktop'
import { HubApiError } from '@/api/http'
import DesktopDevicesCard from '@/components/desktop/DesktopDevicesCard.vue'
import { routes } from '@/router'

/**
 * 工作台「桌面设备」的改名（WP25f 交付物 3）：
 * 前端先做 `DeviceNameSchema` 同款校验（空 / 超 64 字 / 控制字符 / 路径分隔符）→ 提交 PATCH；
 * 404 说「设备不存在或已退出」（不是「没有权限」）；成功后列表刷新。
 */
vi.mock('@/api/desktop', () => ({
  listMyDesktopDevices: vi.fn(),
  renameMyDesktopDevice: vi.fn(),
  revokeMyDesktopDevice: vi.fn(),
}))

function device(overrides: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    deviceId: `dv_${'c'.repeat(32)}`,
    name: '书房 · Windows 11',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    capabilities: null,
    appliedRevision: 17,
    desiredRevision: 17,
    appliedAt: '2026-10-22T08:00:00.000Z',
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

function myDevices(items: DesktopDevice[]): DesktopMyDevicesResponse {
  return {
    items,
    limit: { max: 5, used: items.filter((entry) => entry.revokedAt === null).length },
  }
}

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

beforeEach(() => {
  vi.mocked(listMyDesktopDevices).mockResolvedValue(myDevices([device()]))
})

async function mountCard(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/home')
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(DesktopDevicesCard) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

async function typeName(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-testid="desktop-device-rename-input"] input')
  expect(input, '应出现改名输入框').toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
  await flushPromises()
}

async function clickByTestId(id: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  expect(element, `应有 ${id}`).toBeTruthy()
  element!.click()
  await flushPromises()
}

describe('改名', () => {
  it('点「改名」进入行内编辑，默认填入当前设备名', async () => {
    await mountCard()
    await clickByTestId('desktop-device-rename')

    const input = document.querySelector<HTMLInputElement>('[data-testid="desktop-device-rename-input"] input')
    expect(input?.value).toBe('书房 · Windows 11')
    expect(document.querySelector('[data-testid="desktop-device-rename-save"]')).toBeTruthy()
  })

  it('路径分隔符 / 控制字符 / 空名字 / 超 64 字都在前端挡住，不发请求', async () => {
    await mountCard()
    await clickByTestId('desktop-device-rename')

    for (const [value, expected] of [
      ['C:\\Users\\52914', '路径分隔符'],
      ['/home/alice', '路径分隔符'],
      ['坏\u0007名字', '控制字符'],
      ['   ', '不能为空'],
      ['名'.repeat(65), '最多 64 个字'],
    ] as const) {
      await typeName(value)
      await clickByTestId('desktop-device-rename-save')
      const error = document.querySelector('[data-testid="desktop-device-rename-error"]')
      expect(error?.textContent, value).toContain(expected)
    }

    expect(renameMyDesktopDevice).not.toHaveBeenCalled()
  })

  it('成功：提交的是 trim 过的名字，成功后刷新列表', async () => {
    vi.mocked(renameMyDesktopDevice).mockResolvedValue({ device: device({ name: '小桃的笔记本' }) })
    await mountCard()
    const before = vi.mocked(listMyDesktopDevices).mock.calls.length
    await clickByTestId('desktop-device-rename')

    await typeName('  小桃的笔记本  ')
    await clickByTestId('desktop-device-rename-save')

    expect(renameMyDesktopDevice).toHaveBeenCalledWith(device().deviceId, '小桃的笔记本')
    expect(vi.mocked(listMyDesktopDevices).mock.calls.length).toBeGreaterThan(before)
    expect(document.querySelector('[data-testid="desktop-device-rename-input"]')).toBeNull()
  })

  it('404 → 「设备不存在或已退出」，不刷新列表、不退出编辑', async () => {
    vi.mocked(renameMyDesktopDevice).mockRejectedValue(new HubApiError('NOT_FOUND', '设备不存在', 404))
    await mountCard()
    const before = vi.mocked(listMyDesktopDevices).mock.calls.length
    await clickByTestId('desktop-device-rename')

    await typeName('别人的设备')
    await clickByTestId('desktop-device-rename-save')

    expect(document.querySelector('[data-testid="desktop-device-rename-error"]')?.textContent).toContain(
      '设备不存在或已退出',
    )
    expect(vi.mocked(listMyDesktopDevices).mock.calls.length).toBe(before)
    expect(document.querySelector('[data-testid="desktop-device-rename-input"]')).toBeTruthy()
  })

  it('同名不提交（服务端也不会写库）', async () => {
    await mountCard()
    await clickByTestId('desktop-device-rename')
    await clickByTestId('desktop-device-rename-save')

    expect(renameMyDesktopDevice).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="desktop-device-rename-input"]')).toBeNull()
  })
})
