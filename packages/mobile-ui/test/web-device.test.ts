/**
 * 手机网页版的设备名与平台（WP54 / 契约 C11）。
 *
 * 登录时 Hub 校验 `DeviceNameSchema`（1..64、禁控制字符与路径分隔符）与
 * `platform ∈ {android, ios, web}`。网页版要求上报
 * `手机网页版 · <浏览器> · <系统>`，浏览器/系统都是**从 UA 粗分**，不能只认 Chrome
 * （微信/QQ/UC/Samsung 的 UA 里都带 Chrome 或 Safari 字样）。
 */

import { describe, expect, it } from 'vitest'
import { webBrowserOf, webDeviceName, webOsOf } from '@/lib/storage'

/** 真机上抓的 UA 样本（保持原始形状，别自己编）。 */
const UA = {
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  edgeAndroid:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.2210.85',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  edgeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/120.0.2210.150 Mobile/15E148 Safari/605.1.15',
  firefoxAndroid:
    'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15',
  wechatAndroid:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/5075 MMWEBSDK/20230805 MicroMessenger/8.0.40.2420(0x28002837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  wechatIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282b) NetType/WIFI Language/zh_CN',
  qqBrowser:
    'Mozilla/5.0 (Linux; U; Android 13; zh-cn; Pixel 7 Build/TQ3A.230805.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/14.5 Mobile Safari/537.36',
  qqInApp:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.0.0 Mobile Safari/537.36 V1_AND_SQ_8.9.63_4372_YYB_D QQ/8.9.63.11355 NetType/WIFI',
  uc:
    'Mozilla/5.0 (Linux; U; Android 13; zh-CN; Pixel 7 Build/TQ3A.230805.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UCBrowser/15.5.0.1234 Mobile Safari/537.36',
  harmony:
    'Mozilla/5.0 (Phone; OpenHarmony 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.0.0.0 Mobile HuaweiBrowser/5.0.0.300',
} as const

describe('webBrowserOf：UA 粗分浏览器（C11）', () => {
  it('主流浏览器认得出', () => {
    expect(webBrowserOf(UA.chromeAndroid)).toBe('Chrome')
    expect(webBrowserOf(UA.safariIos)).toBe('Safari')
    expect(webBrowserOf(UA.chromeIos)).toBe('Chrome')
    expect(webBrowserOf(UA.firefoxAndroid)).toBe('Firefox')
    expect(webBrowserOf(UA.firefoxIos)).toBe('Firefox')
    expect(webBrowserOf(UA.edgeAndroid)).toBe('Edge')
    expect(webBrowserOf(UA.edgeIos)).toBe('Edge')
    expect(webBrowserOf(UA.samsung)).toBe('Samsung')
  })

  it('国内壳优先于内核（它们 UA 里都带 Chrome/Safari）', () => {
    expect(webBrowserOf(UA.wechatAndroid)).toBe('微信')
    expect(webBrowserOf(UA.wechatIos)).toBe('微信')
    expect(webBrowserOf(UA.qqBrowser)).toBe('QQ')
    expect(webBrowserOf(UA.qqInApp)).toBe('QQ')
    expect(webBrowserOf(UA.uc)).toBe('UC')
  })

  it('认不出来的老实给「其它」（不猜）', () => {
    expect(webBrowserOf('')).toBe('其它')
    expect(webBrowserOf('curl/8.5.0')).toBe('其它')
    expect(webBrowserOf('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101')).toBe('其它')
  })
})

describe('webOsOf：UA 粗分系统（C11）', () => {
  it('Android / iOS / HarmonyOS 分得开', () => {
    expect(webOsOf(UA.chromeAndroid)).toBe('Android')
    expect(webOsOf(UA.safariIos)).toBe('iOS')
    expect(webOsOf(UA.chromeIos)).toBe('iOS')
    // 鸿蒙 UA 的兼容段里还有 Android 字样，必须先认 HarmonyOS
    expect(webOsOf(UA.harmony)).toBe('HarmonyOS')
  })

  it('iPadOS 桌面模式（伪装 Macintosh + Mobile）按 iOS 处理', () => {
    expect(
      webOsOf(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('iOS')
    // 真正的 Mac 桌面浏览器：不是 iOS
    expect(
      webOsOf(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('其它')
  })

  it('认不出来给「其它」', () => {
    expect(webOsOf('')).toBe('其它')
    expect(webOsOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('其它')
  })
})

describe('webDeviceName：设备名形状与契约限制（C11）', () => {
  it('形如「手机网页版 · Chrome · Android」', () => {
    expect(webDeviceName(UA.chromeAndroid)).toBe('手机网页版 · Chrome · Android')
    expect(webDeviceName(UA.safariIos)).toBe('手机网页版 · Safari · iOS')
    expect(webDeviceName(UA.wechatAndroid)).toBe('手机网页版 · 微信 · Android')
    // 华为浏览器（ArkWeb）UA 里就是 `Chrome/114`：粗分归 Chrome，系统名照样准确报 HarmonyOS
    expect(webDeviceName(UA.harmony)).toBe('手机网页版 · Chrome · HarmonyOS')
    expect(webDeviceName('')).toBe('手机网页版 · 其它 · 其它')
  })

  it('任何 UA 下都满足 DeviceNameSchema：1..64 字、无控制字符、无路径分隔符', () => {
    for (const ua of [...Object.values(UA), '', 'weird\nua', 'a/b\\c']) {
      const name = webDeviceName(ua)
      expect(name.length).toBeGreaterThanOrEqual(1)
      expect(name.length).toBeLessThanOrEqual(64)
      expect(/[\u0000-\u001f\u007f]/.test(name)).toBe(false)
      expect(/[\\/]/.test(name)).toBe(false)
      expect(name.startsWith('手机网页版 · ')).toBe(true)
    }
  })
})
