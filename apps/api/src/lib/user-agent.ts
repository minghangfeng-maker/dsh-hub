/**
 * User-Agent → 人话设备描述（04 §3 `SessionItem.device`：如「桌面 Chrome」「iPhone Safari」）。
 *
 * 只做保守的字符串匹配：识别不出来时给「未知设备」而不是原样回吐 UA（避免把超长 UA 塞进界面）。
 */
export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'unknown'

export interface ParsedUserAgent {
  /** 人话描述（直接给前端显示） */
  device: string
  /** 设备类型 */
  kind: DeviceKind
  /** 操作系统，识别不出为 null */
  os: string | null
  /** 浏览器，识别不出为 null */
  browser: string | null
}

const OS_RULES: { os: string; re: RegExp }[] = [
  // iPad 在 iPadOS 13+ 默认伪装成 Macintosh，但带 Mobile 段；iPhone/iPad 优先于 macOS
  { os: 'iOS', re: /iPhone|iPad|iPod/ },
  { os: 'Android', re: /Android/ },
  { os: 'Windows', re: /Windows NT|Windows Phone/ },
  { os: 'macOS', re: /Macintosh|Mac OS X/ },
  { os: 'Linux', re: /Linux|X11/ },
  { os: 'ChromeOS', re: /CrOS/ },
]

// 顺序有意义：Edg/ 里也含 Chrome/，必须先判 Edge
const BROWSER_RULES: { browser: string; re: RegExp }[] = [
  { browser: '微信', re: /MicroMessenger/i },
  { browser: 'Edge', re: /Edg[A-Z]?\// },
  { browser: 'Chrome', re: /Chrome\/|CriOS\// },
  { browser: 'Firefox', re: /Firefox\/|FxiOS\// },
  { browser: 'Safari', re: /Safari\/.*Version\/|Version\/.*Safari\// },
  { browser: 'Safari', re: /Safari\// },
  { browser: 'curl', re: /^curl\//i },
  { browser: 'Wget', re: /^Wget\//i },
]

function detectOs(ua: string): string | null {
  for (const rule of OS_RULES) if (rule.re.test(ua)) return rule.os
  return null
}

function detectBrowser(ua: string): string | null {
  for (const rule of BROWSER_RULES) if (rule.re.test(ua)) return rule.browser
  return null
}

function detectKind(ua: string, os: string | null): DeviceKind {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet'
  // Android 平板通常不带 "Mobile" 段
  if (os === 'Android') return /Mobile/i.test(ua) ? 'mobile' : 'tablet'
  if (/iPhone|iPod/i.test(ua)) return 'mobile'
  if (/Mobile|Windows Phone/i.test(ua)) return 'mobile'
  if (os === null) return 'unknown'
  return 'desktop'
}

/** 解析 UA；空/无法识别时 kind=unknown、device='未知设备' */
export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const ua = (userAgent ?? '').trim()
  if (ua.length === 0) return { device: '未知设备', kind: 'unknown', os: null, browser: null }
  const os = detectOs(ua)
  const browser = detectBrowser(ua)
  const kind = detectKind(ua, os)

  if (os === 'iOS') {
    const name = /iPad/i.test(ua) ? 'iPad' : /iPod/i.test(ua) ? 'iPod' : 'iPhone'
    return { device: join(name, browser), kind, os, browser }
  }
  if (os === 'Android') {
    return { device: join(kind === 'tablet' ? 'Android 平板' : 'Android 手机', browser), kind, os, browser }
  }
  if (kind === 'desktop') return { device: join('桌面', browser ?? '浏览器'), kind, os, browser }
  if (kind === 'mobile') return { device: join('手机', browser ?? '浏览器'), kind, os, browser }
  if (kind === 'tablet') return { device: join('平板', browser ?? '浏览器'), kind, os, browser }
  if (browser) return { device: browser, kind, os, browser }
  return { device: '未知设备', kind, os, browser }
}

/** 只要人话描述的便捷函数 */
export function describeDevice(userAgent: string | null | undefined): string {
  return parseUserAgent(userAgent).device
}

function join(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ')
}
