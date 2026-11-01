import type { MobileAppRelease, MobileAppReleaseListResponse, Settings } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import {
  fetchMobileAppReleases,
  publishMobileAppRelease,
  rollbackMobileAppRelease,
} from '@/api/admin-mobile-app'
import { updateSettings } from '@/api/admin-users'
import MobileAppSettingsSection from '@/components/admin/MobileAppSettingsSection.vue'

vi.mock('@/api/admin-mobile-app', () => ({
  fetchMobileAppReleases: vi.fn(),
  publishMobileAppRelease: vi.fn(),
  rollbackMobileAppRelease: vi.fn(),
}))
vi.mock('@/api/admin-users', () => ({ updateSettings: vi.fn() }))

/**
 * 系统设置 · 安卓 App 卡片（WP40r）：当前发布、上传即发布、回滚、版本地板保存。
 * 页面逻辑只负责「把服务端状态画出来 + 把动作转发给接口」，接口本身的语义在
 * `apps/api/test/mobile-app.test.ts` 里测。
 */

const RELEASE: MobileAppRelease = {
  id: 2,
  versionName: '0.2.1',
  versionCode: 21,
  fileName: 'dsh-hub-app-0.2.1-47119762.apk',
  bytes: 22_020_096,
  sha256: 'a'.repeat(64),
  status: 'published',
  path: '/android/bin/dsh-hub-app-0.2.1-47119762.apk',
  uploadedAt: '2026-10-26T02:00:00.000Z',
}

const OLDER: MobileAppRelease = {
  ...RELEASE,
  id: 1,
  versionName: '0.2.0',
  versionCode: 20,
  fileName: 'dsh-hub-app-0.2.0-11111111.apk',
  status: 'yanked',
  path: '/android/bin/dsh-hub-app-0.2.0-11111111.apk',
}

function list(overrides: Partial<MobileAppReleaseListResponse> = {}): MobileAppReleaseListResponse {
  return {
    current: RELEASE,
    items: [RELEASE, OLDER],
    settings: { minVersionCode: 1, latestVersionCode: 1, downloadUrl: null },
    ...overrides,
  }
}

function mountSection() {
  const Host = defineComponent({
    components: { MobileAppSettingsSection, NMessageProvider },
    template: '<NMessageProvider><MobileAppSettingsSection /></NMessageProvider>',
  })
  return mount(Host, { attachTo: document.body })
}

const wrappers: { unmount: () => void }[] = []

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchMobileAppReleases).mockResolvedValue(list())
})

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
})

describe('系统设置 · 安卓 App（WP40r）', () => {
  it('显示当前发布（版本 / versionCode / 大小 / 下载路径）与历史版本', async () => {
    const wrapper = mountSection()
    wrappers.push(wrapper)
    await flushPromises()

    const current = wrapper.get('[data-testid="mobile-app-current"]')
    expect(current.text()).toContain('v0.2.1')
    expect(current.text()).toContain('versionCode 21')
    expect(current.text()).toContain('21.0 MB')
    expect(current.text()).toContain('/android/bin/dsh-hub-app-0.2.1-47119762.apk')
    const history = wrapper.get('[data-testid="mobile-app-history"]')
    expect(history.text()).toContain('0.2.0')
    expect(history.text()).toContain('已下线')
  })

  it('没发过 APK：显示空态与「上传并发布」，没有回滚按钮', async () => {
    vi.mocked(fetchMobileAppReleases).mockResolvedValue(list({ current: null, items: [] }))
    const wrapper = mountSection()
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.get('[data-testid="mobile-app-empty"]').text()).toContain('还没有发布过 APK')
    expect(wrapper.find('[data-testid="mobile-app-rollback"]').exists()).toBe(false)
  })

  it('上传：版本号 / versionCode / 文件齐全时调发布接口，成功后刷新', async () => {
    const wrapper = mountSection()
    wrappers.push(wrapper)
    await flushPromises()

    // versionCode 默认预填成「当前 +1」
    expect(
      (wrapper.get('[data-testid="mobile-app-version-code"] input').element as HTMLInputElement).value,
    ).toBe('22')

    await wrapper.get('[data-testid="mobile-app-version"] input').setValue('0.2.2')
    const input = wrapper.get('[data-testid="mobile-app-file"]')
    const file = new File([new Uint8Array(16)], 'app-release.apk', {
      type: 'application/vnd.android.package-archive',
    })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')

    vi.mocked(publishMobileAppRelease).mockResolvedValue({ ...RELEASE, id: 3, versionName: '0.2.2' })
    await wrapper.get('[data-testid="mobile-app-upload"]').trigger('click')
    await flushPromises()

    expect(publishMobileAppRelease).toHaveBeenCalledTimes(1)
    const call = vi.mocked(publishMobileAppRelease).mock.calls[0]![0]
    expect(call.version).toBe('0.2.2')
    expect(call.versionCode).toBe(22)
    expect(call.apk.name).toBe('app-release.apk')
    // 刷新了一次列表（初次加载 + 发布后）
    expect(fetchMobileAppReleases).toHaveBeenCalledTimes(2)
  })

  it('没选文件就点上传：给出提示且不调接口', async () => {
    const wrapper = mountSection()
    wrappers.push(wrapper)
    await flushPromises()

    await wrapper.get('[data-testid="mobile-app-upload"]').trigger('click')
    await flushPromises()

    expect(publishMobileAppRelease).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="mobile-app-upload-error"]').text()).toContain('先选择 APK 文件')
  })

  it('回滚：只有存在更旧版本时才显示按钮，点击后调回滚接口', async () => {
    const wrapper = mountSection()
    wrappers.push(wrapper)
    await flushPromises()

    vi.mocked(rollbackMobileAppRelease).mockResolvedValue({ release: OLDER, yanked: [RELEASE.id] })
    await wrapper.get('[data-testid="mobile-app-rollback"]').trigger('click')
    await flushPromises()

    expect(rollbackMobileAppRelease).toHaveBeenCalledWith()
    expect(fetchMobileAppReleases).toHaveBeenCalledTimes(2)

    // 只有一版时不显示回滚
    vi.mocked(fetchMobileAppReleases).mockResolvedValue(list({ current: RELEASE, items: [RELEASE] }))
    const single = mountSection()
    wrappers.push(single)
    await flushPromises()
    expect(single.find('[data-testid="mobile-app-rollback"]').exists()).toBe(false)
  })

  it('版本地板：改 minVersionCode 后保存，走 PATCH settings 且保留 latestVersionCode', async () => {
    const wrapper = mountSection()
    wrappers.push(wrapper)
    await flushPromises()

    await wrapper.get('[data-testid="mobile-app-min-version-code"] input').setValue('20')
    vi.mocked(updateSettings).mockResolvedValue({} as Settings)
    await wrapper.get('[data-testid="mobile-app-save-settings"]').trigger('click')
    await flushPromises()

    expect(updateSettings).toHaveBeenCalledWith({
      mobile: { app: { minVersionCode: 20, latestVersionCode: 1, downloadUrl: null } },
    })
  })

  it('下载地址：非 http(s) 被拦下，留空保存为 null（用发布记录接管）', async () => {
    const wrapper = mountSection()
    wrappers.push(wrapper)
    await flushPromises()

    await wrapper.get('[data-testid="mobile-app-download-url"] input').setValue('ftp://cdn/app.apk')
    await wrapper.get('[data-testid="mobile-app-save-settings"]').trigger('click')
    await flushPromises()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="mobile-app-save-error"]').text()).toContain('http')

    // 清空下载地址（= 交给发布记录）：同时改一下地板，确保表单处于「已修改」状态
    await wrapper.get('[data-testid="mobile-app-download-url"] input').setValue('')
    await wrapper.get('[data-testid="mobile-app-min-version-code"] input').setValue('20')
    vi.mocked(updateSettings).mockResolvedValue({} as Settings)
    await wrapper.get('[data-testid="mobile-app-save-settings"]').trigger('click')
    await flushPromises()
    expect(vi.mocked(updateSettings).mock.calls[0]![0]).toMatchObject({
      mobile: { app: { downloadUrl: null } },
    })
  })
})
