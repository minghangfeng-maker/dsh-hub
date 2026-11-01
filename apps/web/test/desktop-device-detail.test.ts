import type {
  DesktopDevice,
  DesktopDeviceAuditItem,
  DesktopDeviceDetailResponse,
  DesktopDevicePlugin,
} from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { getAdminDesktopDevice, revokeAdminDesktopDevice } from '@/api/desktop'
import { HubApiError } from '@/api/http'
import AdminDesktopDeviceDrawer from '@/components/admin/desktop/AdminDesktopDeviceDrawer.vue'
import { routes } from '@/router'

/**
 * 管理端设备详情抽屉（WP25f 交付物 1）：三种状态（正常 / 404 / 没有插件）+ 隐私边界 + 抽屉里的吊销。
 *
 * 隐私边界在这条用例里是「显示层」的最后一道：假数据故意把 `userAgent` 塞进审计 detail、
 * 把设备描述里塞满字段，断言界面上既没有 UA 也没有任何 IP。
 */
vi.mock('@/api/desktop', () => ({
  getAdminDesktopDevice: vi.fn(),
  revokeAdminDesktopDevice: vi.fn(),
}))

function device(overrides: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    deviceId: `dv_${'a'.repeat(32)}`,
    name: '书房 · Windows 11',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    capabilities: { claudeCode: true, codex: false, pwsh: '7' },
    appliedRevision: 17,
    desiredRevision: 18,
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

function plugin(overrides: Partial<DesktopDevicePlugin> = {}): DesktopDevicePlugin {
  return {
    name: 'dsh-email',
    version: '0.16.0',
    source: 'hub-core',
    state: 'enabled',
    updatedAt: '2026-10-22T08:00:00.000Z',
    ...overrides,
  }
}

/** 审计行：登录那条带着 `userAgent`（真实后端就带），界面不许显示 */
function audit(overrides: Partial<DesktopDeviceAuditItem> = {}): DesktopDeviceAuditItem {
  return {
    id: 1,
    at: '2026-10-22T08:00:00.000Z',
    action: 'desktop.login',
    actorId: 12,
    actorUsername: 'littletao',
    targetType: 'desktop.device',
    targetId: device().deviceId,
    detail: { appVersion: '0.2.1', platform: 'win32', userAgent: 'secret-agent/9.9' },
    ...overrides,
  }
}

function detail(overrides: Partial<DesktopDeviceDetailResponse> = {}): DesktopDeviceDetailResponse {
  return {
    user: { id: 12, slug: 'u7k2m9xr', username: 'littletao', displayName: '小桃', avatarUrl: null },
    device: device(),
    plugins: [
      plugin(),
      plugin({ name: '@xmanrui/dsh-im', version: '4.35.1', source: 'hub-default' }),
      plugin({ name: 'dsh-image-tools', version: '0.1.4', source: 'user', state: 'failed', errorCode: 'plugin_install_failed' }),
    ],
    pluginCount: 3,
    audit: [
      audit(),
      audit({ id: 2, action: 'desktop.rename', detail: { from: '旧名字', to: '书房 · Windows 11' } }),
    ],
    ...overrides,
  }
}

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

beforeEach(() => {
  vi.mocked(getAdminDesktopDevice).mockResolvedValue(detail())
})

async function open(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/instances?tab=desktop')
  await router.isReady()
  const Host = defineComponent({
    render: () =>
      h(NMessageProvider, null, {
        default: () =>
          h(AdminDesktopDeviceDrawer, { show: true, deviceId: device().deviceId, 'onUpdate:show': () => undefined }),
      }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('设备详情抽屉（正常态）', () => {
  it('台账字段 / 插件清单 / 最近操作都在，动作用中文一句话', async () => {
    await open()
    const text = document.body.textContent ?? ''

    expect(getAdminDesktopDevice).toHaveBeenCalledWith(device().deviceId)
    // 抽屉容器（真链路脚本按这个 testid 找抽屉）
    expect(document.querySelector('[data-testid="admin-desktop-detail"]')).toBeTruthy()
    // 台账
    expect(text).toContain('书房 · Windows 11')
    expect(text).toContain(device().deviceId)
    expect(text).toContain('Windows 11')
    expect(text).toContain('x64')
    expect(text).toContain('0.2.1')
    expect(text).toContain('稳定')
    expect(text).toContain('r17')
    expect(text).toContain('r18')
    expect(text).toContain('已应用')
    expect(text).toContain('Claude Code')
    // 插件：名称 / 版本 / 来源 / 状态
    expect(document.querySelector('[data-testid="admin-desktop-detail-plugin-count"]')?.textContent).toContain('3 个')
    for (const name of ['dsh-email', '@xmanrui/dsh-im', 'dsh-image-tools']) expect(text).toContain(name)
    expect(text).toContain('必装')
    expect(text).toContain('自己装的')
    expect(text).toContain('失败')
    // 审计：操作者 + 中文动作
    expect(text).toContain('登录桌面端（客户端 0.2.1）')
    expect(text).toContain('设备改名为「书房 · Windows 11」（原来叫「旧名字」）')
    expect(text).toContain('littletao')
  })

  it('不显示也无法请求任何 IP / 原始上报内容（隐私边界）', async () => {
    const requestSpy = vi.mocked(getAdminDesktopDevice)
    await open()

    const text = document.body.textContent ?? ''
    // 假数据里故意留着 UA；详情抽屉只显示动作，不摊 detail
    expect(text).not.toContain('secret-agent')
    expect(text).not.toContain('Mozilla')
    // 抽屉不该去查管理端审计（那会带回操作者 IP）
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(requestSpy.mock.calls[0]).toEqual([device().deviceId])
  })

  it('抽屉里能吊销：二次确认后调接口并通知外层刷新', async () => {
    vi.mocked(revokeAdminDesktopDevice).mockResolvedValue({
      device: device({ revokedAt: '2026-10-22T09:00:00.000Z', revokeReason: 'admin', presence: 'revoked' }),
    })
    const wrapper = await open()

    const revokeButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="admin-desktop-detail-revoke"]',
    )
    expect(revokeButton).toBeTruthy()
    revokeButton!.click()
    await flushPromises()

    const positive = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '确认吊销',
    )
    expect(positive, '应有确认按钮').toBeTruthy()
    positive!.click()
    await flushPromises()

    expect(revokeAdminDesktopDevice).toHaveBeenCalledWith(device().deviceId)
    expect(wrapper.findComponent(AdminDesktopDeviceDrawer).emitted('revoked')).toEqual([
      [device().deviceId],
    ])
  })
})

describe('设备详情抽屉（错误态与空态）', () => {
  it('404 → 「设备不存在」+ 重试入口', async () => {
    vi.mocked(getAdminDesktopDevice).mockRejectedValue(new HubApiError('NOT_FOUND', '设备不存在', 404))
    await open()

    const block = document.querySelector('[data-testid="admin-desktop-detail-error"]')
    expect(block).toBeTruthy()
    expect(block!.textContent).toContain('设备不存在')
    expect(block!.textContent).toContain('重试')
    expect(document.querySelector('[data-testid="admin-desktop-detail-plugins"]')).toBeNull()
  })

  it('403 → 「需要管理员权限」（不是笼统的加载失败）', async () => {
    vi.mocked(getAdminDesktopDevice).mockRejectedValue(new HubApiError('FORBIDDEN', '需要管理员权限', 403))
    await open()
    expect(document.querySelector('[data-testid="admin-desktop-detail-error"]')?.textContent).toContain(
      '需要管理员权限',
    )
  })

  it('没有插件 / 没有操作 → 两处空态；也没有吊销按钮（已吊销的设备）', async () => {
    vi.mocked(getAdminDesktopDevice).mockResolvedValue(
      detail({
        plugins: [],
        pluginCount: 0,
        audit: [],
        device: device({ revokedAt: '2026-10-20T09:00:00.000Z', revokeReason: 'user', presence: 'revoked' }),
      }),
    )
    await open()

    expect(document.querySelector('[data-testid="admin-desktop-detail-no-plugins"]')?.textContent).toContain(
      '这台设备还没上报插件',
    )
    expect(document.querySelector('[data-testid="admin-desktop-detail-no-audit"]')?.textContent).toContain(
      '这台设备还没有操作记录',
    )
    expect(document.querySelector('[data-testid="admin-desktop-detail-revoke"]')).toBeNull()
    expect(document.body.textContent).toContain('吊销：用户自己退出')
  })
})
