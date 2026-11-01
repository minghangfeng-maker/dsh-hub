/**
 * 手机网页版「添加到桌面」引导的纯逻辑（WP54 / W5）。
 *
 * 真机上不好一个个试的分支都在这里钉住：
 *   · 哪些设备/浏览器给哪种说明（Android Chrome / iOS Safari / 微信内置 / 桌面）；
 *   · 已经是 standalone 就别再提示；
 *   · 关掉后 30 天内不再出现，脏数据不能把引导永久吞掉；
 *   · theme-color 在「系统亮 + App 深」这类强制主题场景下要写成 App 实际的颜色。
 */

import { describe, expect, it } from 'vitest'
import {
  INSTALL_HINT_TTL_MS,
  THEME_COLORS,
  hintSuppressed,
  installHintCopy,
  installTargetOf,
  isStandaloneMode,
  serializeHintDismissal,
  themeColorTargets,
} from '../src/lib/pwa-install'

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  wechatAndroid:
    'Mozilla/5.0 (Linux; Android 13; M2012K11AC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x2800313D) WeChat/arm64',
  qqAndroid:
    'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.0.0 Mobile Safari/537.36 MQQBrowser/14.2 Mobile',
  huaweiHarmony:
    'Mozilla/5.0 (Phone; OpenHarmony 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.4.300',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
} as const

describe('installTargetOf：谁能装到桌面', () => {
  it('Android Chrome 给「安装按钮」路线', () => {
    expect(installTargetOf(UA.androidChrome)).toBe('android-chrome')
  })

  it('iOS Safari 给「分享 → 添加到主屏幕」图文说明', () => {
    expect(installTargetOf(UA.iphoneSafari)).toBe('ios-safari')
  })

  it('iPadOS 的 UA 伪装成 Mac，靠触点数仍认成 iOS', () => {
    // 桌面 Safari 也有同一串 UA：没有触点就按桌面处理（不提示）
    expect(installTargetOf(UA.ipadSafari, 5)).toBe('ios-safari')
    expect(installTargetOf(UA.ipadSafari, 0)).toBe('none')
  })

  it('iOS 上的非 Safari 浏览器没有安装入口 → 提示换浏览器', () => {
    expect(installTargetOf(UA.iphoneChrome)).toBe('other')
  })

  it('微信/QQ 内置浏览器一律提示换浏览器（即使底层是 Chrome）', () => {
    expect(installTargetOf(UA.wechatAndroid)).toBe('other')
    expect(installTargetOf(UA.qqAndroid)).toBe('other')
  })

  it('Android 上的三星/华为浏览器走「换浏览器」而不是 beforeinstallprompt', () => {
    expect(installTargetOf(UA.androidSamsung)).toBe('other')
    expect(installTargetOf(UA.huaweiHarmony)).toBe('other')
  })

  it('WebView（App 内嵌页、wv 标记）不当成 Chrome', () => {
    expect(installTargetOf(UA.androidWebView)).toBe('other')
  })

  it('桌面浏览器不提示（手机网页版也能开，但没必要教人装到桌面）', () => {
    expect(installTargetOf(UA.desktopChrome)).toBe('none')
  })
})

describe('installHintCopy：文案与按钮', () => {
  it('Android Chrome 拿到 beforeinstallprompt 才给按钮', () => {
    expect(installHintCopy('android-chrome', true).action).toBe('安装到桌面')
    expect(installHintCopy('android-chrome', false).action).toBeNull()
  })

  it('拿不到 prompt 时退回「菜单 → 添加到主屏幕」', () => {
    expect(installHintCopy('android-chrome', false).body).toContain('添加到主屏幕')
  })

  it('iOS 的说明指向分享按钮', () => {
    const copy = installHintCopy('ios-safari')
    expect(copy.body).toContain('分享')
    expect(copy.body).toContain('添加到主屏幕')
    expect(copy.action).toBeNull()
  })

  it('内置浏览器提示用 Safari / Chrome 打开', () => {
    const copy = installHintCopy('other')
    expect(copy.title).toContain('浏览器')
    expect(copy.body).toContain('Safari')
    expect(copy.action).toBeNull()
  })

  it('none 不给任何文案（组件据此不显示）', () => {
    expect(installHintCopy('none')).toEqual({ title: '', body: '', action: null })
  })
})

describe('isStandaloneMode：从桌面图标打开就不再引导', () => {
  it('display-mode: standalone', () => {
    expect(isStandaloneMode({ standalone: true })).toBe(true)
  })
  it('fullscreen（manifest 改 display 时）', () => {
    expect(isStandaloneMode({ standalone: false, fullscreen: true })).toBe(true)
  })
  it('iOS 的 navigator.standalone', () => {
    expect(isStandaloneMode({ standalone: false, iosStandalone: true })).toBe(true)
  })
  it('浏览器标签页', () => {
    expect(isStandaloneMode({ standalone: false })).toBe(false)
  })
})

describe('hintSuppressed：关掉后 30 天不再出现', () => {
  const now = 1_730_000_000_000

  it('没关过 → 出现', () => {
    expect(hintSuppressed(null, now)).toBe(false)
    expect(hintSuppressed('', now)).toBe(false)
  })

  it('刚关 → 不出现；29 天 → 不出现；31 天 → 又出现', () => {
    expect(hintSuppressed(serializeHintDismissal(now), now)).toBe(true)
    expect(hintSuppressed(serializeHintDismissal(now - 29 * 24 * 3600_000), now)).toBe(true)
    expect(hintSuppressed(serializeHintDismissal(now - 31 * 24 * 3600_000), now)).toBe(false)
    expect(INSTALL_HINT_TTL_MS).toBe(30 * 24 * 3600_000)
  })

  it('系统时间被往回调（elapsed 为负）仍算刚关过', () => {
    expect(hintSuppressed(serializeHintDismissal(now + 60_000), now)).toBe(true)
  })

  it('脏数据不能永久吞掉引导', () => {
    expect(hintSuppressed('not json', now)).toBe(false)
    expect(hintSuppressed('{}', now)).toBe(false)
    expect(hintSuppressed('{"at":"昨天"}', now)).toBe(false)
    expect(hintSuppressed('{"at":null}', now)).toBe(false)
  })
})

describe('themeColorTargets：状态栏配色跟着 App 实际主题', () => {
  it('跟随系统时用两个背景色', () => {
    expect(themeColorTargets(false, false)).toEqual({ ...THEME_COLORS })
    expect(themeColorTargets(true, true)).toEqual({ ...THEME_COLORS })
  })

  it('系统亮但 App 强制深色 → 两条都写深色（否则状态栏一条白边）', () => {
    expect(themeColorTargets(true, false)).toEqual({
      light: THEME_COLORS.dark,
      dark: THEME_COLORS.dark,
    })
  })

  it('系统深但 App 强制浅色 → 两条都写浅色', () => {
    expect(themeColorTargets(false, true)).toEqual({
      light: THEME_COLORS.light,
      dark: THEME_COLORS.light,
    })
  })
})
