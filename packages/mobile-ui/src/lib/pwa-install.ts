/**
 * 手机网页版（PWA）相关的纯逻辑：装到桌面的入口判断、引导的「30 天内不再出现」、
 * 以及状态栏配色（theme-color）跟随 App 实际主题。
 *
 * 拆出来的理由和 `lib/connection-banner.ts` 一样：组件只管渲染，判断与文案在这里，
 * 单测（test/pwa-install.test.ts）能直接覆盖 —— 手机 UA、iOS 各浏览器、
 * 微信内置浏览器这些分支在真机上不好一个个试。
 *
 * 边界：只在 `VITE_TARGET=web` 的构建里有意义（`IS_WEB_BUILD`）。APK 里这些函数不会
 * 被调用，模块本身也只多几 KB 死代码（`IS_WEB_BUILD` 是构建期常量 false）。
 */

import { IS_WEB_BUILD } from './app-info'

/** 「添加到桌面」引导关掉后多久再出现（30 天）。 */
export const INSTALL_HINT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 关闭时间存这个偏好键（Capacitor Preferences → 网页版落到 localStorage）。 */
export const INSTALL_HINT_KEY = 'dsh-hub:install-hint:v1'

/** App 的实际背景色（= app.css 的 `--bg`；顶栏与页面同色，所以也是顶栏色）。 */
export const THEME_COLORS = { light: '#F9F8F6', dark: '#17171A' } as const

/** 引导该给哪种说明。`none` = 不显示（电脑浏览器、或已经装到桌面）。 */
export type InstallTarget = 'android-chrome' | 'ios-safari' | 'other' | 'none'

export interface InstallHintCopy {
  title: string
  body: string
  /** 有按钮才给（只有 Android Chrome 拿到 beforeinstallprompt 时才有） */
  action: string | null
}

/** `beforeinstallprompt` 事件（Chromium 私有，TS 标准库里没有）。 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/** 微信 / QQ / 微博 / 支付宝这类内置浏览器：没有「添加到主屏幕」，只能请用户换浏览器。 */
const UA_IN_APP =
  /MicroMessenger|WeChat|QQ\/|MQQBrowser|Weibo|AlipayClient|DingTalk|aweme|douyin/i

/** 不是「系统自带浏览器」的那些（Android 上的 Chrome 之外 / iOS 上的 Safari 之外）。 */
const UA_OTHER_BROWSER =
  /CriOS\/|EdgiOS\/|EdgA?\/|OPR\/|OPT\/|SamsungBrowser|UCBrowser|Quark|MiuiBrowser|HuaweiBrowser|HeytapBrowser|VivoBrowser|FxiOS\/|Firefox\//i

/** 手机内的 WebView（`; wv)` 标记）：不是能「添加到主屏幕」的浏览器。 */
const UA_WEBVIEW = /;\s*wv\)/i

const UA_IPHONE_IPAD = /iPhone|iPad|iPod/i
const UA_ANDROID = /Android/i
// 只用来区分「手机 vs 电脑」：桌面的 Chrome/Safari 都没有 Mobile/Android/Harmony 这些记号
const UA_MOBILE = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|OpenHarmony/i
const UA_CHROME = /Chrome\//i

/**
 * 判断「这台设备、这个浏览器」能不能装到桌面。
 *
 * @param ua `navigator.userAgent`
 * @param maxTouchPoints `navigator.maxTouchPoints`（iPadOS 13 起 UA 伪装成 Mac，只能靠触点数认）
 */
export function installTargetOf(ua: string, maxTouchPoints = 0): InstallTarget {
  const ios = UA_IPHONE_IPAD.test(ua) || (maxTouchPoints > 1 && /Macintosh|Mac OS X/i.test(ua))
  // 内置浏览器先判：微信/QQ 里即使用户点「在浏览器打开」也只是换个壳，说明要往「换浏览器」上写
  if (UA_IN_APP.test(ua) || UA_WEBVIEW.test(ua)) return 'other'
  if (ios) {
    // iOS 上只有 Safari 能加到主屏幕（Chrome/Edge/Firefox 在 iOS 上都是 WebKit 外壳，没有这个入口）
    return UA_OTHER_BROWSER.test(ua) ? 'other' : 'ios-safari'
  }
  if (UA_ANDROID.test(ua)) {
    return UA_OTHER_BROWSER.test(ua) || !UA_CHROME.test(ua) ? 'other' : 'android-chrome'
  }
  // 桌面浏览器：手机网页版也能开，但没必要在这里教人装到桌面
  return UA_MOBILE.test(ua) ? 'other' : 'none'
}

export interface DisplayModeSources {
  /** `matchMedia('(display-mode: standalone)').matches`（Android Chrome / iOS 13+） */
  standalone: boolean
  /** `matchMedia('(display-mode: fullscreen)').matches`（manifest 若改成 fullscreen） */
  fullscreen?: boolean
  /** `navigator.standalone`（iOS 的老 API，Safari 一直在给） */
  iosStandalone?: boolean
}

/** 已经是从桌面图标打开（全屏、没有地址栏）时，引导不该再出现。 */
export function isStandaloneMode(sources: DisplayModeSources): boolean {
  return sources.standalone === true || sources.fullscreen === true || sources.iosStandalone === true
}

/**
 * 关闭过吗（30 天内）。存的是关闭那一刻的时间戳（毫秒），坏数据一律当作「没关过」——
 * 宁可多提示一次，也不要因为一条脏数据把引导永久吞掉。
 */
export function hintSuppressed(raw: string | null | undefined, now: number): boolean {
  if (!raw) return false
  let at: unknown
  try {
    at = (JSON.parse(raw) as { at?: unknown }).at
  } catch {
    return false
  }
  if (typeof at !== 'number' || !Number.isFinite(at)) return false
  const elapsed = now - at
  // 时间往回拨（时区/手改系统时间）时 elapsed 可能为负：仍然算「刚关过」
  return elapsed < INSTALL_HINT_TTL_MS
}

/** 关闭时间戳的存储格式（和 hintSuppressed 配对）。 */
export function serializeHintDismissal(now: number): string {
  return JSON.stringify({ at: now })
}

/** 按目标给文案。`canPrompt` = 拿不拿得到 beforeinstallprompt（拿不到就让用户走菜单）。 */
export function installHintCopy(target: InstallTarget, canPrompt = false): InstallHintCopy {
  switch (target) {
    case 'android-chrome':
      return canPrompt
        ? {
            title: '加到主屏幕',
            body: '全屏打开，不用每次输网址。',
            action: '安装到桌面',
          }
        : {
            title: '加到主屏幕',
            body: '点浏览器右上角菜单，选「添加到主屏幕」。',
            action: null,
          }
    case 'ios-safari':
      return {
        title: '加到主屏幕',
        body: '点 Safari 底部的分享按钮，再选「添加到主屏幕」。',
        action: null,
      }
    case 'other':
      return {
        title: '在浏览器里打开',
        body: '这个环境不能加到主屏幕，请用 Safari 或 Chrome 打开本页。',
        action: null,
      }
    default:
      return { title: '', body: '', action: null }
  }
}

/**
 * 两条 `theme-color`（亮/暗两条 media）此刻该写什么颜色。
 *
 * 浏览器按**系统的**亮暗偏好挑其中一条，而 App 允许用户在设置里强制主题。两者一致时
 * 就是 App 自己的两个背景色；不一致（强制了相反的主题）时两条都写成 App 实际的颜色，
 * 否则状态栏会留一条和界面对不上的边。
 */
export function themeColorTargets(
  appDark: boolean,
  systemDark: boolean,
): { light: string; dark: string } {
  if (appDark === systemDark) return { ...THEME_COLORS }
  const actual = appDark ? THEME_COLORS.dark : THEME_COLORS.light
  return { light: actual, dark: actual }
}

// ── beforeinstallprompt 的「早到」问题 ────────────────────────────────────────
//
// Chrome 判完「可安装」就会派发一次 beforeinstallprompt，而且只派发一次；那一刻首页
// 很可能还没挂载（还在登录页、或者会话恢复中）。所以事件由本模块在 App 主包执行时就
// 拦住存起来（InstallHint 组件挂载后再来取），组件另外订阅后续到达的事件。
// `preventDefault()` 顺带把 Chrome 自己那条 mini-infobar 压掉 —— 改用首页这张卡片。

let deferredPrompt: BeforeInstallPromptEvent | null = null
const promptSubscribers = new Set<(event: BeforeInstallPromptEvent) => void>()

/** 现在存着的安装事件（没有就是 null：没装过但浏览器没给，或者已经用掉了）。 */
export function currentInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt
}

/** 记下一个安装事件并通知订阅者（模块自己监听 window 时调用；e2e 也直接调它造场景）。 */
export function noteInstallPrompt(event: BeforeInstallPromptEvent): void {
  deferredPrompt = event
  for (const handler of promptSubscribers) handler(event)
}

/** 订阅后续到达的安装事件，返回取消函数。 */
export function onInstallPrompt(handler: (event: BeforeInstallPromptEvent) => void): () => void {
  promptSubscribers.add(handler)
  return () => {
    promptSubscribers.delete(handler)
  }
}

/** 用掉存着的事件（点过「安装到桌面」之后不该再给一次）。 */
export function consumeInstallPrompt(): BeforeInstallPromptEvent | null {
  const event = deferredPrompt
  deferredPrompt = null
  return event
}

/** 把 index.html 里的两条 theme-color 改成实际颜色。 */
export function applyThemeColor(): void {
  if (typeof document === 'undefined') return
  const appDark = document.documentElement?.dataset?.theme === 'dark'
  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  const targets = themeColorTargets(appDark, media?.matches ?? appDark)
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
  const darkMeta = metas.find((meta) => (meta.getAttribute('media') ?? '').includes('dark'))
  const lightMeta = metas.find(
    (meta) => meta !== darkMeta && (meta.getAttribute('media') ?? '').includes('light'),
  )
  darkMeta?.setAttribute('content', targets.dark)
  lightMeta?.setAttribute('content', targets.light)
}

/**
 * 盯住 `data-theme`（stores/settings 改主题时只改这一个属性）与系统偏好变化，
 * 随时把状态栏颜色校正回来。返回取消函数（App 生命周期内不调用）。
 */
export function startThemeColorSync(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  applyThemeColor()
  const media =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  const onSchemeChange = (): void => applyThemeColor()
  media?.addEventListener?.('change', onSchemeChange)
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => applyThemeColor())
      : null
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  return () => {
    media?.removeEventListener?.('change', onSchemeChange)
    observer?.disconnect()
  }
}

/**
 * 网页构建里模块一加载就把状态栏配色接上、把 beforeinstallprompt 拦住。
 *
 * 为什么不挂在 App.vue：那个文件是 W2（导航与生命周期）的独占文件，这里用「HomeView
 * → InstallHint → 本模块」这条本来就存在的静态引用链，在 App 主包里同步执行，
 * 一行都不用动别人的文件。APK 构建里 `IS_WEB_BUILD` 是 false，这段不执行。
 */
if (IS_WEB_BUILD) {
  if (typeof document !== 'undefined') startThemeColorSync()
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (event) => {
      // 默认行为是 Chrome 自己的 mini-infobar；拦下来换成首页那张卡片
      event.preventDefault()
      noteInstallPrompt(event as BeforeInstallPromptEvent)
    })
  }
}
