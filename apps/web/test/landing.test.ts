import type {
  PublicAndroidDownloadResponse,
  PublicDesktopDownloadResponse,
  PublicSiteResponse,
  UserPublic,
} from '@dsh-hub/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { routes } from '@/router'
import { useAuthStore } from '@/stores/auth'
import LandingView from '@/views/LandingView.vue'

/**
 * 公开主页（WP36 → WP41 → WP42）。
 *
 * WP42：下载区改成三模式 Tab —— 云上模式（默认、主推，2核4G 私有 DSH / 7×24；WP53 去掉限时免费）、
 * 桌面端（Windows 安装包 + 安装版/免安装版切换）、安卓端（APK）。二维码已移除；
 * 页脚链接文案是「隐私说明」。`?platform=cloud|desktop|android` 可强制默认 Tab。
 *
 * 背景 canvas 在 jsdom 里拿不到 2D 上下文，组件会自己跳过绘制；右侧动效组件在挂载时启动
 * 4.8s 轮播定时器，所以这里用 enableAutoUnmount 保证每个用例结束都卸载组件、清掉定时器。
 */

enableAutoUnmount(afterEach)

const USER: UserPublic = {
  id: 1,
  slug: 'u7k2m9xa',
  username: 'mint-tea',
  displayName: '薄荷茶',
  bio: '',
  avatarUrl: null,
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastLoginAt: '2026-10-12T08:00:00.000Z',
  usernameChangedAt: null,
}

const SITE: PublicSiteResponse = {
  name: 'DSH Hub',
  tagline: '你的云上 AI 工作台',
  announcement: '',
  announcementLevel: 'info',
  registrationMode: 'invite',
  requireApproval: false,
  caCertUrl: null,
}

const NO_DOWNLOAD: PublicDesktopDownloadResponse = { windows: null, android: null }

const RELEASE: PublicDesktopDownloadResponse = {
  windows: {
    version: '0.2.1-rc.2',
    channel: 'nightly',
    prerelease: true,
    fileName: 'DSH-Hub-Setup-0.2.1-rc.2.exe',
    // 359 * 1024 * 1024
    bytes: 376_438_784,
    url: '/desktop/bin/win-x64/DSH-Hub-Setup-0.2.1-rc.2.exe',
    publishedAt: '2026-10-23T01:02:03.000Z',
    portable: null,
  },
  android: null,
}

const ANDROID: PublicAndroidDownloadResponse = {
  app: {
    version: '0.2.14',
    versionCode: 34,
    prerelease: false,
    fileName: 'dsh-hub-app-0.2.14-698e475c.apk',
    bytes: 8_518_697,
    sha256: 'a'.repeat(64),
    url: 'https://cdn.example.com/downloads/mobile-app/dsh-hub-app-0.2.14-698e475c.apk',
    publishedAt: '2026-10-27T02:00:00.000Z',
  },
  qrUrl: '/api/public/android/qr.svg',
}

const NO_ANDROID: PublicAndroidDownloadResponse = { app: null, qrUrl: '/api/public/android/qr.svg' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

type LandingPlatform = 'cloud' | 'desktop' | 'android'

interface MountOptions {
  site?: Partial<PublicSiteResponse>
  download?: PublicDesktopDownloadResponse
  android?: PublicAndroidDownloadResponse
  user?: UserPublic | null
  /** 覆盖默认 Tab（模拟 `?platform=` 直达链接） */
  platform?: LandingPlatform
}

async function mountLanding(
  options: MountOptions = {},
): Promise<{ wrapper: ReturnType<typeof mount>; router: Router; pinia: Pinia }> {
  const siteResponse = { ...SITE, ...options.site }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/public/site')) return json(siteResponse)
      if (url.includes('/api/public/android/download')) return json(options.android ?? NO_ANDROID)
      if (url.includes('/api/public/desktop/download')) return json(options.download ?? NO_DOWNLOAD)
      return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
    }),
  )

  window.history.replaceState(null, '', options.platform ? `/?platform=${options.platform}` : '/')

  const pinia = createPinia()
  if (options.user) useAuthStore(pinia).setUser(options.user)

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/')
  await router.isReady()

  const wrapper = mount(LandingView, { global: { plugins: [pinia, router] } })
  await flushPromises()

  return { wrapper, router, pinia }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('公开主页顶栏与页脚（WP36 / WP41）', () => {
  it('未登录：右上角是「登录」「注册」，不显示进入工作台', async () => {
    const { wrapper } = await mountLanding()

    expect(wrapper.text()).toContain('登录')
    expect(wrapper.get('[data-testid="landing-register"]').text()).toBe('注册')
    expect(wrapper.find('[data-testid="landing-workbench"]').exists()).toBe(false)
    expect(wrapper.get('h1').text()).toBe('DSH Hub 连通万物')
    for (const word of ['免费', '限时', '体验', '付费', '名额']) expect(wrapper.text()).not.toContain(word)
  })

  it('注册关闭时只显示「登录」，不显示注册', async () => {
    const { wrapper } = await mountLanding({ site: { registrationMode: 'closed' } })

    expect(wrapper.find('[data-testid="landing-login"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="landing-register"]').exists()).toBe(false)
  })

  it('已登录：右上角换成「进入工作台」，指向 /home', async () => {
    const { wrapper } = await mountLanding({ user: USER })

    const workbench = wrapper.get('[data-testid="landing-workbench"]')
    expect(workbench.text()).toBe('进入工作台')
    expect(workbench.attributes('href')).toBe('/home')
  })

  it('页脚：隐私说明，指向 /desktop/privacy；不再有旧文案和二维码', async () => {
    const { wrapper } = await mountLanding()

    const privacy = wrapper.get('a[href="/desktop/privacy"]')
    expect(privacy.text()).toBe('隐私说明')
    expect(wrapper.text()).not.toContain('桌面端会上报什么')
    expect(wrapper.find('[data-testid="landing-android-qr"]').exists()).toBe(false)
  })
  it('顶栏与页脚都有「使用文档」入口，指向 /docs（WP44）', async () => {
    const { wrapper } = await mountLanding()

    expect(wrapper.get('[data-testid="landing-docs"]').attributes('href')).toBe('/docs')
    const links = wrapper.findAll('a[href="/docs"]')
    expect(links).toHaveLength(2)
    expect(links.every((link) => link.text() === '使用文档')).toBe(true)
  })
})

describe('三模式 Tab（WP42）', () => {
  it('默认落在云上模式：Tab 选中、面板与主推文案都在', async () => {
    const { wrapper } = await mountLanding({ android: ANDROID })

    expect(wrapper.get('[data-testid="landing-tab-cloud"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="landing-tab-desktop"]').attributes('aria-selected')).toBe('false')
    expect(wrapper.get('[data-testid="landing-tab-android"]').attributes('aria-selected')).toBe('false')

    const pane = wrapper.get('[data-testid="landing-pane-cloud"]')
    expect(pane.text()).toContain('云上模式')
    expect(wrapper.get('[data-testid="landing-cloud-pitch"]').text()).toBe(
      '2核4G 私有 DSH，7×24 小时在线，打开浏览器就能用。',
    )
    expect(wrapper.find('[data-testid="landing-cloud-tag"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-shot-cloud"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="landing-pane-desktop"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-pane-android"]').exists()).toBe(false)
  })

  it('云上模式 CTA：未登录且注册开放 → /register「注册使用」', async () => {
    const { wrapper } = await mountLanding()

    const cta = wrapper.get('[data-testid="landing-cloud-cta"]')
    expect(cta.attributes('href')).toBe('/register')
    expect(cta.text()).toContain('注册使用云上 DSH')
    expect(wrapper.get('[data-testid="landing-cloud-note"]').text()).toBe('注册后即可开通 · 无需安装')
  })

  it('云上模式 CTA：已登录 → /home「进入我的云上 DSH」', async () => {
    const { wrapper } = await mountLanding({ user: USER })

    const cta = wrapper.get('[data-testid="landing-cloud-cta"]')
    expect(cta.attributes('href')).toBe('/home')
    expect(cta.text()).toContain('进入我的云上 DSH')
  })

  it('云上模式 CTA：注册关闭且未登录 → /login', async () => {
    const { wrapper } = await mountLanding({ site: { registrationMode: 'closed' } })

    const cta = wrapper.get('[data-testid="landing-cloud-cta"]')
    expect(cta.attributes('href')).toBe('/login')
    expect(cta.text()).toContain('登录使用云上 DSH')
  })

  it('点「桌面端」切到下载面板：版本 / 直链按钮都在', async () => {
    const { wrapper } = await mountLanding({ download: RELEASE })

    await wrapper.get('[data-testid="landing-tab-desktop"]').trigger('click')

    expect(wrapper.get('[data-testid="landing-tab-desktop"]').attributes('aria-selected')).toBe('true')
    const pane = wrapper.get('[data-testid="landing-pane-desktop"]')
    expect(pane.text()).toContain('Windows 客户端')
    expect(wrapper.get('[data-testid="landing-windows-meta"]').text()).toBe('v0.2.1-rc.2 · 359 MB')
    const download = wrapper.get('[data-testid="landing-download"]')
    expect(download.attributes('href')).toBe('/desktop/bin/win-x64/DSH-Hub-Setup-0.2.1-rc.2.exe')
    expect(wrapper.get('[data-testid="landing-prerelease"]').text()).toBe('预览版')
    expect(wrapper.find('[data-testid="landing-shot-desktop"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="landing-pane-cloud"]').exists()).toBe(false)
  })

  it('点「安卓端」切到 APK 面板：版本 / 大小 / 直链按钮，没有二维码', async () => {
    const { wrapper } = await mountLanding({ android: ANDROID })

    await wrapper.get('[data-testid="landing-tab-android"]').trigger('click')

    expect(wrapper.get('[data-testid="landing-tab-android"]').attributes('aria-selected')).toBe('true')
    const pane = wrapper.get('[data-testid="landing-pane-android"]')
    expect(pane.text()).toContain('安卓 App')
    expect(wrapper.get('[data-testid="landing-android-meta"]').text()).toBe('v0.2.14 · 8 MB · Android 8+')
    const download = wrapper.get('[data-testid="landing-android-download"]')
    expect(download.attributes('href')).toBe(
      'https://cdn.example.com/downloads/mobile-app/dsh-hub-app-0.2.14-698e475c.apk',
    )
    expect(download.attributes('download')).toBe('dsh-hub-app-0.2.14-698e475c.apk')
    expect(download.text()).toContain('下载安卓 App')
    expect(wrapper.find('[data-testid="landing-android-qr"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-shot-android"]').exists()).toBe(true)
  })

  it('安卓端面板给「手机浏览器直接打开网页版」入口（WP54c，→ /?view=mobile）', async () => {
    const { wrapper } = await mountLanding({ android: ANDROID })

    await wrapper.get('[data-testid="landing-tab-android"]').trigger('click')

    const note = wrapper.get('[data-testid="landing-android-web"]')
    expect(note.text()).toContain('不想装 App')
    const link = wrapper.get('[data-testid="landing-android-web-link"]')
    expect(link.attributes('href')).toBe('/?view=mobile')
    expect(link.text()).toBe('手机浏览器直接打开网页版')
  })

  it('?platform=desktop 直达桌面端 Tab；?platform=android 直达安卓端', async () => {
    const desktop = await mountLanding({ platform: 'desktop', download: RELEASE })
    expect(desktop.wrapper.get('[data-testid="landing-tab-desktop"]').attributes('aria-selected')).toBe(
      'true',
    )
    expect(desktop.wrapper.find('[data-testid="landing-download"]').exists()).toBe(true)
    desktop.wrapper.unmount()

    const android = await mountLanding({ platform: 'android', android: ANDROID })
    expect(android.wrapper.get('[data-testid="landing-tab-android"]').attributes('aria-selected')).toBe(
      'true',
    )
    expect(android.wrapper.find('[data-testid="landing-android-download"]').exists()).toBe(true)
  })
})

describe('下载面板边界情况（WP36 / WP38）', () => {
  it('还没有已发布安装包：按钮禁用显示「安装包准备中」，不显示版本 meta', async () => {
    const { wrapper } = await mountLanding({ download: NO_DOWNLOAD, platform: 'desktop' })

    const disabled = wrapper.get('[data-testid="landing-download-disabled"]')
    expect(disabled.text()).toBe('安装包准备中')
    expect(disabled.attributes('aria-disabled')).toBe('true')
    expect(wrapper.find('[data-testid="landing-download"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-windows-meta"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-prerelease"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="landing-windows-sub"]').text()).toContain('安装后用 Hub 账号登录')
  })

  it('挂了免安装包：按钮下方出现「安装版 | 免安装版」切换，按钮 / 大小 / 提示随之切换', async () => {
    const withPortable: PublicDesktopDownloadResponse = {
      windows: {
        ...RELEASE.windows!,
        portable: {
          fileName: 'DSH-Hub-0.2.1-rc.2-win-x64-portable.zip',
          // 474 * 1024 * 1024
          bytes: 497_025_024,
          url: '/desktop/bin/win-x64/DSH-Hub-0.2.1-rc.2-win-x64-portable.zip',
        },
      },
      android: null,
    }
    const { wrapper } = await mountLanding({ download: withPortable, platform: 'desktop' })

    expect(wrapper.get('[data-testid="landing-variant-installer"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-testid="landing-download"]').attributes('href')).toBe(
      '/desktop/bin/win-x64/DSH-Hub-Setup-0.2.1-rc.2.exe',
    )

    await wrapper.get('[data-testid="landing-variant-portable"]').trigger('click')

    const download = wrapper.get('[data-testid="landing-download"]')
    expect(download.attributes('href')).toBe('/desktop/bin/win-x64/DSH-Hub-0.2.1-rc.2-win-x64-portable.zip')
    expect(download.text()).toContain('下载免安装版')
    expect(wrapper.get('[data-testid="landing-windows-meta"]').text()).toBe('v0.2.1-rc.2 · 474 MB')
    expect(wrapper.get('[data-testid="landing-windows-sub"]').text()).toContain('解压即用')
  })

  it('没挂免安装包：不显示切换', async () => {
    const { wrapper } = await mountLanding({ download: RELEASE, platform: 'desktop' })

    expect(wrapper.find('[data-testid="landing-variant"]').exists()).toBe(false)
  })

  it('安卓没发版：显示「即将上线」，没有下载按钮', async () => {
    const { wrapper } = await mountLanding({ android: NO_ANDROID, platform: 'android' })

    expect(wrapper.get('[data-testid="landing-android-soon"]').text()).toBe('即将上线')
    expect(wrapper.find('[data-testid="landing-android-download"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-android-meta"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="landing-android-sub"]').text()).toContain('先用网页版')
  })

  it('安卓接口挂了不影响云上模式和桌面端下载', async () => {
    const { wrapper } = await mountLanding({ download: RELEASE, android: NO_ANDROID })

    expect(wrapper.find('[data-testid="landing-pane-cloud"]').exists()).toBe(true)
    await wrapper.get('[data-testid="landing-tab-desktop"]').trigger('click')
    expect(wrapper.get('[data-testid="landing-windows-meta"]').text()).toContain('v0.2.1-rc.2')
  })
})

describe('右侧真实截图（WP43）', () => {
  it('三个模式各配一张真实截图，带说明文字和替代文本', async () => {
    const cases: Array<[LandingPlatform, string]> = [
      ['cloud', '分析销售表'],
      ['desktop', 'Windows 客户端'],
      ['android', '安卓 App'],
    ]
    for (const [platform, caption] of cases) {
      const { wrapper } = await mountLanding({ platform, download: RELEASE, android: ANDROID })
      const shot = wrapper.get(`[data-testid="landing-shot-${platform}"]`)
      expect(shot.get('figcaption').text()).toContain('真实截图')
      expect(shot.get('figcaption').text()).toContain(caption)
      const images = shot.findAll('img')
      expect(images.length).toBeGreaterThan(0)
      for (const image of images) expect(image.attributes('alt')).toBeTruthy()
      wrapper.unmount()
    }
  })

  it('不再有假动效', async () => {
    const { wrapper } = await mountLanding()

    expect(wrapper.find('[data-testid^="landing-reel"]').exists()).toBe(false)
  })
})
