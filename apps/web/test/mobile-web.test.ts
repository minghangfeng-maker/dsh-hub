import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it } from 'vitest'

import MobileWebBar from '@/components/base/MobileWebBar.vue'
import { deviceMetaText, deviceSystemText, mobilePlatformIcon, mobilePlatformText } from '@/components/desktop/text'
import { routes } from '@/router'
import globalCss from '@/styles/global.css?raw'
import { isMobileUserAgent, MOBILE_UA_PATTERN, MOBILE_VIEW_HREF, MOBILE_WEB_HREF } from '@/utils/mobile-ua'

/**
 * 手机网页版（WP54c）在 Hub 网页这一侧的三件事：
 *
 * 1. 手机 UA 判定与契约 C8 的 `/` 跳转同一条正则——两边不一致会出现「跳过去了但没有返回入口」；
 * 2. 「返回手机版」/「切到手机版」细条只在手机 UA 出现，链接指向服务端路径（`/m/`、`/?view=mobile`）；
 * 3. 设备台账里 `mobilePlatform === 'web'` 显示「手机网页版」，与 Android / iOS 并列。
 *
 * 另外盯住 `global.css` 里手机宽度那两段触屏口径（输入框 16px、按钮 44px）：它们没有组件归属，
 * 被误删时页面在真机上会悄悄退化（iOS 聚焦放大、按钮点不准），所以用测试钉住。
 */

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Mobile Safari/537.36'
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.0 Mobile/15E148 Safari/604.1'
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36'
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.0 Safari/605.1.15'
/** 安卓平板：`Android` 有、`Mobile` 没有（契约 C8 的口径是「不含平板」） */
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36'

const UA_DESCRIPTOR = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')

function stubUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true })
}

afterEach(() => {
  if (UA_DESCRIPTOR) Object.defineProperty(window.navigator, 'userAgent', UA_DESCRIPTOR)
})

describe('utils/mobile-ua.ts（与契约 C8 同一条正则）', () => {
  it('手机 UA 命中：安卓 Chrome / iPhone Safari / 鸿蒙手机', () => {
    expect(MOBILE_UA_PATTERN.source).toBe('Android.+Mobile|iPhone|iPod|HarmonyOS.+Mobile|Mobile.+Safari')
    expect(isMobileUserAgent(ANDROID_CHROME)).toBe(true)
    expect(isMobileUserAgent(IPHONE_SAFARI)).toBe(true)
    expect(isMobileUserAgent(`Mozilla/5.0 (HarmonyOS 4.0) Mobile; Safari/537.36`)).toBe(true)
  })

  it('电脑 UA 与安卓平板不命中', () => {
    expect(isMobileUserAgent(WINDOWS_CHROME)).toBe(false)
    expect(isMobileUserAgent(MAC_SAFARI)).toBe(false)
    expect(isMobileUserAgent(ANDROID_TABLET)).toBe(false)
  })

  it('iPad Safari 不命中（与服务端 TABLET_UA_RE 一致，C8「不含平板」）', () => {
    const ipad =
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    expect(MOBILE_UA_PATTERN.test(ipad)).toBe(true)
    expect(isMobileUserAgent(ipad)).toBe(false)
  })

  it('空值不炸（构建期 / 测试环境可能没有 navigator）', () => {
    expect(isMobileUserAgent(null)).toBe(false)
    expect(isMobileUserAgent(undefined)).toBe(false)
    expect(isMobileUserAgent('')).toBe(false)
  })

  it('链接指向服务端决定的两个地址（C2 的 /m/ 与 C8 的 /?view=mobile）', () => {
    expect(MOBILE_WEB_HREF).toBe('/m/')
    expect(MOBILE_VIEW_HREF).toBe('/?view=mobile')
  })
})

describe('components/base/MobileWebBar.vue', () => {
  it('电脑 UA：什么都不渲染（不占位、不影响原布局）', () => {
    stubUserAgent(WINDOWS_CHROME)
    const wrapper = mount(MobileWebBar)
    expect(wrapper.find('[data-testid="mobile-web-back"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-view-switch"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })

  it('手机 UA：默认给「返回手机版」→ /m/', () => {
    stubUserAgent(ANDROID_CHROME)
    const wrapper = mount(MobileWebBar)
    const link = wrapper.get('[data-testid="mobile-web-back"]')
    expect(link.attributes('href')).toBe('/m/')
    expect(link.text()).toBe('返回手机版')
    wrapper.unmount()
  })

  it('手机 UA + kind="switch"：给「切到手机版」→ /?view=mobile', () => {
    stubUserAgent(ANDROID_CHROME)
    const wrapper = mount(MobileWebBar, { props: { kind: 'switch' } })
    const link = wrapper.get('[data-testid="mobile-view-switch"]')
    expect(link.attributes('href')).toBe('/?view=mobile')
    expect(link.text()).toBe('切到手机版')
    wrapper.unmount()
  })
})

describe('设备台账里的手机网页版', () => {
  it('平台文案：web → 手机网页版，与 Android / iOS 并列', () => {
    expect(mobilePlatformText('web')).toBe('手机网页版')
    expect(mobilePlatformText('android')).toBe('Android')
    expect(mobilePlatformText('ios')).toBe('iOS')
    expect(mobilePlatformText(null)).toBe('手机')
  })

  it('平台图标：web 用浏览器图标，安卓 / 苹果各有自己的', () => {
    expect(mobilePlatformIcon('web')).toBe('i-ph-browser')
    expect(mobilePlatformIcon('android')).toBe('i-ph-android-logo')
    expect(mobilePlatformIcon('ios')).toBe('i-ph-apple-logo')
    expect(mobilePlatformIcon(null)).toBe('i-ph-device-mobile')
  })

  it('系统列：网页版写「手机网页版」，安卓 / iOS 仍写「手机 · Android」', () => {
    const web = { kind: 'mobile' as const, mobilePlatform: 'web' as const, platform: null, osMajor: null }
    const android = {
      kind: 'mobile' as const,
      mobilePlatform: 'android' as const,
      platform: null,
      osMajor: null,
    }
    const desktop = { kind: 'desktop' as const, platform: 'win32' as const, osMajor: '11' }

    expect(deviceSystemText(web)).toBe('手机网页版')
    expect(deviceSystemText(android)).toBe('手机 · Android')
    expect(deviceSystemText(desktop)).toBe('Windows 11')
    expect(deviceMetaText({ ...web, arch: null })).toBe('手机网页版')
  })
})

describe('手机应用会外链的 Hub 地址都在路由表里（WP54c）', () => {
  it('注册 / 找回密码 / 改密码 / 隐私政策 / 改密强制页', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes })

    expect(router.resolve('/register').name).toBe('Register')
    expect(router.resolve('/forgot-password').name).toBe('ForgotPassword')
    expect(router.resolve('/me/password').name).toBe('ForcePassword')
    // App 里 `webPage('/privacy')`：别名到同一份隐私说明，不再落 404
    expect(router.resolve('/privacy').name).toBe('DesktopPrivacy')

    // App 里「去网页修改密码」写死的 `/settings/security` → 个人中心「安全」Tab
    await router.push('/settings/security')
    expect(router.currentRoute.value.path).toBe('/me')
    expect(router.currentRoute.value.query['tab']).toBe('security')
  })
})

describe('手机宽度的触屏口径（global.css）', () => {
  it('≤640px 时输入框字号 ≥16px（iOS 聚焦不放大整页）', () => {
    expect(globalCss).toMatch(/@media \(max-width: 640px\)/)
    expect(globalCss).toContain('.n-input .n-input__input-el')
    expect(globalCss).toContain('.n-input .n-input__textarea-el')
    expect(globalCss).toMatch(/font-size: var\(--fs-16\)/)
  })

  it('≤640px 时按钮可点区域 ≥44px', () => {
    expect(globalCss).toMatch(/\.n-button \{[^}]*min-height: 44px/)
  })
})
