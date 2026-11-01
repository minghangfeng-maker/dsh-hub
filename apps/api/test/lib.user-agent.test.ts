import { describe, expect, it } from 'vitest'
import { parseUserAgent } from '../src/lib/user-agent.js'

/** 真实 UA 片段（缩短但保留关键 token） */
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
const SAFARI_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const WECHAT_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 MicroMessenger/8.0.49'

describe('User-Agent → 人话设备（04 §3 device）', () => {
  it('识别常见浏览器与系统', () => {
    const cases: [string, string, string][] = [
      [CHROME_WIN, '桌面 Chrome', 'desktop'],
      [EDGE_WIN, '桌面 Edge', 'desktop'],
      [SAFARI_MAC, '桌面 Safari', 'desktop'],
      [SAFARI_IPHONE, 'iPhone Safari', 'mobile'],
      [SAFARI_IPAD, 'iPad Safari', 'tablet'],
      [CHROME_ANDROID, 'Android 手机 Chrome', 'mobile'],
      [FIREFOX_LINUX, '桌面 Firefox', 'desktop'],
      [WECHAT_ANDROID, 'Android 手机 微信', 'mobile'],
    ]
    for (const [ua, device, kind] of cases) {
      const parsed = parseUserAgent(ua)
      expect(parsed.device, ua).toBe(device)
      expect(parsed.kind, ua).toBe(kind)
    }
  })

  it('空/无法识别的 UA 给「未知设备」，不原样回吐长 UA', () => {
    expect(parseUserAgent(null).device).toBe('未知设备')
    expect(parseUserAgent('').device).toBe('未知设备')
    expect(parseUserAgent('   ').device).toBe('未知设备')
    const weird = parseUserAgent('something-weird/1.0')
    expect(weird.device).toBe('未知设备')
    expect(weird.kind).toBe('unknown')

    // curl / 无浏览器 token 的客户端
    expect(parseUserAgent('curl/8.5.0').browser).toBe('curl')
  })
})
