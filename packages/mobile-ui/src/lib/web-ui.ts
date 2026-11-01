/**
 * 手机网页版（WP54）的界面文案与地址：W4「页面差异」独占。
 *
 * 约定：判断「是不是网页版」只用 `IS_WEB_BUILD`（构建期常量，C3），不要用 `isNative()` 推断。
 * 这里的函数都是纯的（地址/文案/判定），DOM 动作留在调用方，单测见 `test/web-ui.test.ts`。
 *
 * APK 构建：`IS_WEB_BUILD` 是字面量 false，直接写在 JS 里的网页分支（如 `__dshWebUpdate` 开关）
 * 会被 tree-shake；但**模板**里的 `v-if="IS_WEB_BUILD"` 由 Vue 运行时求值，包裹的静态文案仍会
 * 留在包里（只是永远不渲染）。行为与 0.4.11 完全一致，别把「包里搜得到」当成漏网。
 */

import { APP_VERSION, HUB_ORIGIN, IS_WEB_BUILD, webPage } from './app-info'

// ── 版本区 ──────────────────────────────────────────────────────────────────

/** 网页版在设置页里的名字（APK 叫「DSH Hub」，网页版要让用户知道自己在手机浏览器里）。 */
export const WEB_VERSION_TITLE = '手机网页版'

/**
 * 版本区文案：`手机网页版 0.4.11`。
 *
 * 网页版没有 versionCode，用户也认不出 `51`；改成名字 + 版本号。
 * 构建号（`BUILD_INFO.build`）只在诊断面板里传进来显示；设置页给用户看的版本区不带它。
 */
export function webVersionText(version: string = APP_VERSION, build?: string | null): string {
  const head = `${WEB_VERSION_TITLE} ${version}`
  return build ? `${head}（${build}）` : head
}

// ── 地址 ────────────────────────────────────────────────────────────────────

/** 只把 http(s) 地址当入口（`mock` 构建没有网页）。 */
function isWebOrigin(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value)
}

function currentOrigin(): string | null {
  if (typeof location === 'undefined') return null
  return typeof location.origin === 'string' && location.origin.length > 0 ? location.origin : null
}

/** 两个地址是不是同源（解析失败/非 http(s) 一律 false）。 */
export function sameOrigin(url: string, origin: string): boolean {
  const target = parseOrigin(url)
  return target !== null && target === parseOrigin(origin)
}

function parseOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * 电脑版入口（C8）：`/?view=desktop`。
 *
 * Hub 的 `GET /` 在手机 UA 下会 302 回 `/m/`；带上 `view=desktop` 它会写 30 天的
 * `hub_view=desktop` cookie 并正常出电脑版首页。用户点的就是这个地址，同页跳转。
 * `mock`（开发版进程内假 Hub）没有网页入口，返回 null（界面不显示这一行）。
 */
export function desktopPageUrl(): string | null {
  const root = webPage('/')
  return root === null ? null : `${root}?view=desktop`
}

/**
 * Hub 网页（注册 / 找回密码 / 隐私说明）在网页版里怎么打开。
 *
 * `same`：同页跳转。网页版本身由 Hub **同源**托管在 `/m/`，`webPage()` 出来的就是同源路径，
 * 浏览器后退/侧滑返回直接回登录页（Chrome 的 bfcache 通常还会保留已输入的账号密码），
 * 与 APK 里 Custom Tab 盖一层、返回即回 App 的体验一致；新标签在手机浏览器里要多一步切标签。
 * `new`：新标签。开发/e2e 构建是跨源的（`VITE_HUB_ORIGIN`），同页跳转会把 dev server 带走；
 * APK 构建则根本不用这个判定（原生走 Browser 插件，见 `lib/storage.ts` 的 openExternal）。
 */
export type HubPageTarget = 'same' | 'new'

export interface HubPageTargetOptions {
  /** 当前页面地址（默认 `location.origin`；单测显式传）。 */
  origin?: string
  /** 是否网页构建（默认 `IS_WEB_BUILD`；单测显式传）。 */
  web?: boolean
}

export function hubPageTarget(url: string, options: HubPageTargetOptions = {}): HubPageTarget {
  if (!(options.web ?? IS_WEB_BUILD)) return 'new'
  const origin = options.origin ?? currentOrigin()
  return origin !== null && sameOrigin(url, origin) ? 'same' : 'new'
}

/** 「下载 App」用的匿名接口（Hub 主页右卡的安卓 APK 就是从这里取的，免登录）。 */
export const APP_DOWNLOAD_API = '/api/public/android/download'

/**
 * 取安卓 APK 的下载地址（「下载 App」入口）。
 *
 * 为什么不直接把「下载页」链成 Hub 主页：C8 让手机 UA 访问 `/` 直接 302 回 `/m/`，
 * 在网页版里点主页等于原地打转；而 `/?view=desktop` 会写 30 天的 `hub_view=desktop` cookie，
 * 把用户永远钉在电脑版 —— 两个都不能当「下载 App」的目标。
 * 主页右卡本来就是从这个匿名接口拿当前 APK 的绝对地址（随发布变，相对站根），
 * 这里走同一条路：一次 fetch 拿到地址，浏览器直接开始下载；取不到就返回 null，界面给一句提示。
 * 生产环境 `/m/` 与 `/api/` 同源，没有 CORS 问题；开发/e2e 是跨源 mock Hub，取不到属正常。
 */
export interface AppDownloadOptions {
  /** Hub 入口（默认 `HUB_ORIGIN`；网页构建里它等于 `location.origin`）。 */
  origin?: string
  /** 注入用（单测）；默认 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch
}

export async function fetchAppDownloadUrl(options: AppDownloadOptions = {}): Promise<string | null> {
  const origin = (options.origin ?? HUB_ORIGIN).replace(/\/+$/, '')
  if (!isWebOrigin(origin)) return null
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (typeof fetchImpl !== 'function') return null
  try {
    const response = await fetchImpl(`${origin}${APP_DOWNLOAD_API}`, {
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!response.ok) return null
    const url = pickAppDownloadUrl(await response.json())
    return url === null ? null : absoluteUrl(url, origin)
  } catch {
    // 网络/跨源/JSON 解析失败都走这里：下载入口点不通就提示，不要误跳到一个坏地址
    return null
  }
}

/**
 * 从 `GET /api/public/android/download` 的响应里认下载地址。
 * 结构是 `{ app: { url, fileName, ... } | null }`；没发布 APK 时 `app` 为 null。
 * 结构不对就当没有（Hub 以后改字段也不会让网页版抛错）。
 */
export function pickAppDownloadUrl(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const app = (body as { app?: unknown }).app
  if (app === null || typeof app !== 'object') return null
  const url = (app as { url?: unknown }).url
  if (typeof url !== 'string') return null
  return url.trim().length > 0 ? url.trim() : null
}

/** 相对站根的路径（接口给的就是这种）补成绝对地址；认不出就 null。 */
export function absoluteUrl(url: string, origin: string): string | null {
  const trimmed = url.trim()
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) return trimmed
  // 协议相对（//host/path）与其它形式都不认：只接受站根相对路径
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  const base = origin.replace(/\/+$/, '')
  if (!isWebOrigin(base)) return null
  return `${base}${trimmed}`
}

// ── 运行形态 ────────────────────────────────────────────────────────────────

/** 匹配 `(display-mode: standalone)` 的函数签名（`window.matchMedia` 的子集，单测可注入）。 */
export type MatchMediaLike = (query: string) => { matches: boolean }

/**
 * 是不是「添加到主屏幕」后全屏运行（PWA standalone / iOS 主屏幕）。
 *
 * 诊断面板要如实写出来：standalone 与浏览器标签页的差异（安全区、返回手势、后台行为）
 * 是排查「网页版怎么和 App 不一样」的第一现场。iOS Safari 老版本不认 display-mode，
 * 它另有 `navigator.standalone`；这里以 `matchMedia` 为准（也是 W5 的判断口径），
 * 拿不到 matchMedia 就当「不是」。
 */
export function isStandaloneDisplay(
  matchMediaFn: MatchMediaLike | undefined = typeof globalThis.matchMedia === 'function'
    ? (globalThis.matchMedia.bind(globalThis) as MatchMediaLike)
    : undefined,
): boolean {
  if (matchMediaFn === undefined) return false
  try {
    return matchMediaFn('(display-mode: standalone)').matches === true
  } catch {
    return false
  }
}

/** 「记住账号密码」是否可用：唯一来源是 W1 的 `lib/remembered-login.ts`（网页版为 false，C10）。 */
export { REMEMBER_LOGIN_SUPPORTED } from './remembered-login'
