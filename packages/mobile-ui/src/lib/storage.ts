/**
 * 平台存储与外部链接的薄封装。
 *
 * 令牌**只**能走 SecureTokenStore（Android Keystore / iOS Keychain）；
 * 普通偏好（主题、模型选择）走 Capacitor Preferences（Web 开发用 localStorage）；
 * 会话缓存走 IndexedDB。三类数据的边界写在这里，避免以后有人图省事把令牌塞进 localStorage。
 *
 * WP54 例外（契约 C10）：**手机网页版**（`IS_WEB_BUILD`）没有 SecureStorage 可用，
 * 设备令牌只能放 `localStorage`（键名 `dshm.web.` 前缀）。这个例外只在网页构建里成立，
 * APK 里那段代码被 tree-shake 掉；为什么可以接受、风险由谁兜底，见 `LocalStorageTokenStore`。
 */

import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { Preferences } from '@capacitor/preferences'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import {
  AuthTokensSchema,
  COCKPIT_TOKEN_STORAGE_KEY,
  IndexedDbSessionCache,
  MemoryKeyValueStore,
  MemorySessionCache,
  MemoryTokenStore,
  SecureTokenStore,
  SessionStorageTokenStore,
  type AuthTokens,
  type KeyValueStore,
  type SecureStringStore,
  type SessionCache,
  type TokenStore,
} from '@dsh-hub/mobile-core'
import { IS_WEB_BUILD } from './app-info'
import { isCockpitEmbed } from './cockpit-embed'

/**
 * 手机网页版的 localStorage 键前缀（契约 C10）。
 *
 * 加前缀是为了在 Hub 同源的 localStorage 里划出「App 自己的命名空间」：`/m/` 与 Hub 网页
 * （`/`）同源，共用一个 Storage；前缀让清理/排查时一眼能分清哪些条目属于手机网页版。
 */
export const WEB_STORAGE_PREFIX = 'dshm.web.'
/** 设备令牌条目（access + refresh + user 的 JSON，与 SecureTokenStore 同一份形状）。 */
export const WEB_TOKEN_STORAGE_KEY = `${WEB_STORAGE_PREFIX}auth-v1`

export const isNative = (): boolean => Capacitor.isNativePlatform()

/** 安全存储后端：aparajita 插件在 Android 侧是 EncryptedSharedPreferences + Keystore。 */
class NativeSecureStringStore implements SecureStringStore {
  async get(key: string): Promise<string | null> {
    const value = await SecureStorage.getItem(key)
    return value ?? null
  }
  async set(key: string, value: string): Promise<void> {
    await SecureStorage.setItem(key, value)
  }
  async remove(key: string): Promise<void> {
    await SecureStorage.removeItem(key)
  }
}

// ── 安全存储冷启动探针 ──────────────────────────────────────────────────────
//
// 冷启动最初几十/几百毫秒里原生插件可能还没就绪：`getItem` 会抛错，SecureTokenStore
// 内部吞掉后返回 null。上层如果只看「null」就分不清「插件没起来」和「确实没登录」：
//  - error/unknown → 值得再等等（可能是插件刚启动）；
//  - present        → 读到了原始条目（令牌过期/损坏被清掉），不必重试；
//  - absent         → 读成功但确实没有条目，只给 1.2s 宽限（首次安装别白等太久）。
//
// 这里把「最近一次安全存储读取结果」记在模块状态里，UI 层（auth.init 的重试窗口）读取。

export type SecureStoreReadStatus = 'unknown' | 'present' | 'absent' | 'error'

let secureReadStatus: SecureStoreReadStatus = 'unknown'

/** 最近一次从安全存储读令牌的结果（见 SecureStoreReadStatus）。 */
export function secureStoreReadStatus(): SecureStoreReadStatus {
  return secureReadStatus
}

/** 记录一次读取结果（TracedSecureStringStore 用；单测也直接调它造状态）。 */
export function noteSecureStoreRead(status: SecureStoreReadStatus): void {
  secureReadStatus = status
}

/** 测试/诊断用：把探针状态复位。 */
export function resetSecureStoreReadStatus(): void {
  secureReadStatus = 'unknown'
}

/** 包一层记录读取结果；错误照旧抛给 SecureTokenStore（它会吞掉并返回 null）。 */
class TracedSecureStringStore implements SecureStringStore {
  constructor(private readonly inner: SecureStringStore) {}
  async get(key: string): Promise<string | null> {
    try {
      const value = await this.inner.get(key)
      noteSecureStoreRead(value === null ? 'absent' : 'present')
      return value
    } catch (error) {
      noteSecureStoreRead('error')
      throw error
    }
  }
  async set(key: string, value: string): Promise<void> {
    await this.inner.set(key, value)
  }
  async remove(key: string): Promise<void> {
    await this.inner.remove(key)
  }
}

/** 令牌恢复重试的总窗口：原生插件冷启动就绪慢（真机上常见几百毫秒）。 */
export const TOKEN_RESTORE_WINDOW_MS = 4_500
/**
 * 「读成功但没有令牌」的宽限：插件没就绪时可能回 null 而不是抛错（真机观察到过），
 * 所以这里也要等一小会儿；但比报错窗口短，首次安装/手动退出后别白等太久。
 */
export const TOKEN_RESTORE_ABSENT_GRACE_MS = 1_200
/** 指数退避的起点/上限。 */
export const TOKEN_RESTORE_INITIAL_DELAY_MS = 50
export const TOKEN_RESTORE_MAX_DELAY_MS = 1_000

export interface TokenRestoreRetryOptions<T> {
  /** 读一次令牌（HubClient.restore：读安全存储 + 过期判断）。 */
  restore: () => Promise<T | null>
  /** 最近一次安全存储读取结果（区分「插件没就绪」与「确实没条目」）。 */
  status?: () => SecureStoreReadStatus
  /** 是否原生安全存储（Web/内存令牌读一次就够，不要白等）。 */
  secureStorage: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  windowMs?: number
  absentGraceMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  onEvent?: (name: string, detail: string) => void
}

/**
 * 冷启动读令牌：SecureStorage 最初可能没就绪，按指数退避重试到总窗口（~4.5s）。
 *
 * - 读到令牌立刻返回；
 * - 读成功但没有条目（absent）：只给 1.2s 宽限（挡住「插件刚起来返回空」的瞬间）；
 * - 读取报错/状态未知（error/unknown）：一直重试到窗口结束；
 * - 读到了但被判定过期/损坏（present）：不重试（同样的条目再读一次也不会变）。
 */
export async function restoreTokensWithBackoff<T>(
  options: TokenRestoreRetryOptions<T>,
): Promise<T | null> {
  const now = options.now ?? (() => Date.now())
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const windowMs = Math.max(0, options.windowMs ?? TOKEN_RESTORE_WINDOW_MS)
  const absentGraceMs = Math.max(0, options.absentGraceMs ?? TOKEN_RESTORE_ABSENT_GRACE_MS)
  const maxDelayMs = Math.max(1, options.maxDelayMs ?? TOKEN_RESTORE_MAX_DELAY_MS)
  let delay = Math.max(1, options.initialDelayMs ?? TOKEN_RESTORE_INITIAL_DELAY_MS)
  const started = now()

  for (;;) {
    const tokens = await options.restore()
    if (tokens) return tokens
    if (!options.secureStorage) {
      options.onEvent?.('auth:secure-store', 'unavailable')
      return null
    }
    const status = options.status?.() ?? 'unknown'
    if (status === 'present') {
      // 读到了条目却被判过期/损坏：再读也是同一份，交给上层自动登录回退。
      options.onEvent?.('auth:secure-store', 'expired')
      return null
    }
    const elapsed = Math.max(0, now() - started)
    const budget = status === 'absent' ? absentGraceMs : windowMs
    if (elapsed >= budget) {
      options.onEvent?.('auth:secure-store', status)
      return null
    }
    const wait = Math.min(delay, Math.max(0, budget - elapsed), maxDelayMs)
    if (wait <= 0) {
      options.onEvent?.('auth:secure-store', status)
      return null
    }
    await sleep(wait)
    delay = Math.min(maxDelayMs, Math.max(1, Math.round(delay * 2)))
  }
}

/** Capacitor Preferences（非敏感）。 */
class PreferencesKeyValueStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key })
    return value ?? null
  }
  async set(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value })
  }
  async remove(key: string): Promise<void> {
    await Preferences.remove({ key })
  }
}

/** Web 开发用的 localStorage（只有主题/模型选择这类非敏感数据）。 */
class WebKeyValueStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  async set(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* ignore */
    }
  }
  async remove(key: string): Promise<void> {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 原生插件是否真的注册进了壳（`cap sync` 按 capacitor.plugins.json 打包，原生启动时把这些插件
 * 注入 `window.Capacitor.PluginHeaders`）。
 *
 * 为什么要判断：插件**没注册**时调用它不会抛错，而是走插件的 JS 兜底实现——
 * `@aparajita/capacitor-secure-storage` 的 `internalGetItem` 在那条路径上会无限递归，
 * 把主线程与微任务队列占死，首屏永远停在启动蓝点（2026-10-25 真机事故，本机可复现）。
 * 所以宁可这次启动不持久化令牌，也不能让首屏卡死。
 */
export function isNativePluginRegistered(name: string): boolean {
  const cap = (globalThis as { Capacitor?: { PluginHeaders?: Array<{ name?: string }> } }).Capacitor
  const headers = cap?.PluginHeaders
  return Array.isArray(headers) && headers.some((header) => header?.name === name)
}

/** 安全存储（Keystore / Keychain）是否可用：原生 + 插件确实注册进了壳。 */
export function isSecureStorageAvailable(): boolean {
  return isNative() && isNativePluginRegistered('SecureStorage')
}

/**
 * 手机网页版的令牌存储：**localStorage**（契约 C10）。
 *
 * 为什么网页只能这样：浏览器里没有 Keystore/Keychain（Web Crypto 的非导出密钥也保不住
 * 「刷新页面后还能用」的持久化），所以「刷新后仍是登录态」与「令牌不落盘」二者不可兼得；
 * 产品要求刷新不掉登录，于是令牌只能落 localStorage。
 *
 * 风险与兜底：
 *  - 能被偷的路径是 XSS（脚本一跑就能读 localStorage）。手机网页版由 Hub 同源托管在 `/m/`，
 *    响应头是 `/m/` 专用 CSP `default-src 'self'; script-src 'self'`（契约 C6 / WP54b），
 *    没有内联脚本、没有第三方脚本，XSS 面由它兜底 —— 这也是**不要**在网页版里引入
 *    `eval` / 内联脚本 / 外链脚本的原因；
 *  - 令牌本身是「可吊销的设备令牌」（Hub 侧设备列表可见、可一键吊销），不是长期口令；
 *  - 条目带 `dshm.web.` 前缀，退出登录时由 `clear()` 精确清理，不碰 Hub 网页自己的条目。
 *
 * 形状与 `SecureTokenStore` 完全一致（同一份 `AuthTokensSchema`）：读到损坏/过期数据结构
 * 直接清掉并当作未登录，避免「坏数据 → 每次启动都在这里崩」。
 */
export class LocalStorageTokenStore implements TokenStore {
  constructor(private readonly key: string = WEB_TOKEN_STORAGE_KEY) {}

  async load(): Promise<AuthTokens | null> {
    let raw: string | null = null
    try {
      raw = globalThis.localStorage?.getItem(this.key) ?? null
    } catch {
      // 隐私模式 / 被禁用 Storage：当作没登录（不要在这里抛，冷启动路径要稳）
      return null
    }
    if (!raw) return null
    try {
      const parsed = AuthTokensSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        await this.clear()
        return null
      }
      return parsed.data
    } catch {
      await this.clear()
      return null
    }
  }

  async save(tokens: AuthTokens): Promise<void> {
    try {
      globalThis.localStorage?.setItem(this.key, JSON.stringify(tokens))
    } catch {
      /* 配额满 / 隐私模式：本次仍可用（内存里由网关持有），下次启动要重新登录 */
    }
  }

  async clear(): Promise<void> {
    try {
      globalThis.localStorage?.removeItem(this.key)
    } catch {
      /* 已经不存在就算了 */
    }
  }
}

/**
 * 令牌存储：手机网页版用 localStorage（见 `LocalStorageTokenStore`）；原生用 Keystore；
 * 其余 Web/开发用内存（刷新页面就要重新登录）。
 * **绝不**让 APK/开发构建回退到 localStorage —— 宁可让开发者多登录一次。
 *
 * 网页版还有第二种运行形态（WP56d 嵌入座舱）：令牌只放 `sessionStorage` 的 cockpit 键。
 * 「这次该用哪一份」由 `isCockpitEmbed()` 在**每次读写时**判断（见 `ModeAwareTokenStore`）：
 * 模块加载顺序决定了不能在建 store 时判断（`main.ts` 抹 hash 之前 instance.ts 已经求值了）。
 */
export function createTokenStore(): TokenStore {
  return new ModeAwareTokenStore(
    createPersistentTokenStore(),
    new SessionStorageTokenStore(COCKPIT_TOKEN_STORAGE_KEY),
    () => isCockpitEmbed(),
  )
}

/** 普通（非嵌入）形态的令牌存储：网页版 localStorage / 原生 Keystore / 其它内存。 */
function createPersistentTokenStore(): TokenStore {
  if (IS_WEB_BUILD) return new LocalStorageTokenStore()
  if (!isNative()) return new MemoryTokenStore()
  if (isNativePluginRegistered('SecureStorage')) {
    return new SecureTokenStore(new TracedSecureStringStore(new NativeSecureStringStore()))
  }
  console.warn('[dsh-hub] SecureStorage 插件未注册到原生壳：令牌只存内存（下次启动需重新登录）')
  return new MemoryTokenStore()
}

/**
 * 两份令牌存储的**路由层**（WP56d）：嵌入模式读写 sessionStorage 的 cockpit 键，
 * 其余情况读写原来的那份。
 *
 * 为什么必须分开：`/m/` 与 `/admin` 同源，Hub 前端自己也可能用 localStorage；嵌入模式的
 * 座舱令牌绝不能写进普通登录的那个键（`dshm.web.auth-v1`）—— 否则关掉座舱页之后普通
 * 手机网页版会「莫名其妙变成某个管理员的会话」，反过来也一样。`clear()` 也只清当前这一份。
 */
export class ModeAwareTokenStore implements TokenStore {
  constructor(
    private readonly persistent: TokenStore,
    private readonly cockpit: TokenStore,
    private readonly embed: () => boolean,
  ) {}

  private active(): TokenStore {
    return this.embed() ? this.cockpit : this.persistent
  }

  load(): Promise<AuthTokens | null> {
    return this.active().load()
  }

  save(tokens: AuthTokens): Promise<void> {
    return this.active().save(tokens)
  }

  clear(): Promise<void> {
    return this.active().clear()
  }
}

export function createPreferenceStore(): KeyValueStore {
  return isNative() ? new PreferencesKeyValueStore() : new WebKeyValueStore()
}

/**
 * 「记住密码」用的安全存储后端：只有原生 + SecureStorage 插件已注册才返回实例。
 *
 * 其余情况返回 null，由 remembered-login.ts 退化成只记用户名：
 *  - Web 绝不把密码写进 localStorage（返回 null）；
 *  - 原生壳没注册插件时**绝不能**调用 SecureStorage（缺插件会死循环，见上面守卫的注释）。
 */
export function createLoginSecureStore(): SecureStringStore | null {
  if (isSecureStorageAvailable()) return new NativeSecureStringStore()
  if (isNative()) {
    console.warn('[dsh-hub] SecureStorage 插件未注册到原生壳：登录口令不保存（只记用户名）')
  }
  return null
}

export function createSessionCache(): SessionCache {
  const hasIdb = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined'
  return hasIdb ? new IndexedDbSessionCache() : new MemorySessionCache()
}

export function currentPlatform(): 'android' | 'ios' | 'web' {
  // 手机网页版（契约 C11）：平台报 web，Hub 设备列表里显示成「手机网页版」。
  if (IS_WEB_BUILD) return 'web'
  return Capacitor.getPlatform() === 'ios' ? 'ios' : 'android'
}

/** 当前浏览器 UA（非浏览器环境返回空串，解析结果就是「其它 · 其它」）。 */
function currentUserAgent(): string {
  try {
    return typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '')
  } catch {
    return ''
  }
}

/** 网页版登录时上报的浏览器名（契约 C11 的粗分档位）。 */
export type WebBrowser = 'Chrome' | 'Edge' | 'Safari' | 'Firefox' | '微信' | 'QQ' | 'UC' | 'Samsung' | '其它'
/** 网页版登录时上报的系统名（契约 C11 的粗分档位；不含平板判断，平板也走这套）。 */
export type WebOs = 'Android' | 'iOS' | 'HarmonyOS' | '其它'

/**
 * 从 UA 粗分浏览器（C11）。
 *
 * 为什么不能只认 `Chrome`：国内几种主流壳（微信 / QQ / UC / Samsung）的 UA 里**都带**
 * `Chrome/xx` 或 `Safari/xx`，所以顺序必须是「先认壳、再认内核」，否则一律被认成 Chrome。
 * 只做产品需要的粗分，**不追求精确版本**，认不出来老老实实给「其它」。
 */
export function webBrowserOf(ua: string): WebBrowser {
  const text = ua ?? ''
  // 壳优先（它们的 UA 一定含 Chrome/Safari 字样）
  if (/MicroMessenger/i.test(text)) return '微信'
  if (/QQBrowser|MQQBrowser|\bQQ\/[\d.]+/i.test(text)) return 'QQ'
  if (/UCBrowser|UCWEB/i.test(text)) return 'UC'
  if (/SamsungBrowser/i.test(text)) return 'Samsung'
  // 正式浏览器：Edg(A|iOS) 是 Edge 的标记，必须在 Chrome 之前判断
  if (/\bEdgA?\/|\bEdgiOS\//i.test(text)) return 'Edge'
  if (/\bCriOS\/|\bChrome\/|\bChromium\//i.test(text)) return 'Chrome'
  if (/\bFxiOS\/|\bFirefox\//i.test(text)) return 'Firefox'
  // Safari 只有桌面/iOS 版：UA 里带 Safari + Version/
  if (/\bSafari\//i.test(text) && /\bVersion\//i.test(text)) return 'Safari'
  return '其它'
}

/**
 * 从 UA 粗分系统（C11）。
 *
 * HarmonyOS 必须在 Android 之前判断：鸿蒙浏览器的 UA 里仍然带 `Android 10`（兼容段），
 * 先认 Android 就永远看不到「HarmonyOS」。iPadOS 13+ 的桌面模式会伪装成 `Macintosh`
 * 但保留 `Mobile`，按 iOS 处理（手机上打开的那个「Safari」其实就是 iPad 版）。
 */
export function webOsOf(ua: string): WebOs {
  const text = ua ?? ''
  if (/HarmonyOS|OpenHarmony/i.test(text)) return 'HarmonyOS'
  if (/\bAndroid\b/i.test(text)) return 'Android'
  if (/\biPhone\b|\biPad\b|\biPod\b/i.test(text)) return 'iOS'
  if (/\bMacintosh\b/i.test(text) && /\bMobile\b/i.test(text)) return 'iOS'
  return '其它'
}

/** 网页版设备名：`手机网页版 · <浏览器> · <系统>`（契约 C11；约 25 字，远小于 64 上限）。 */
export function webDeviceName(ua: string): string {
  return `手机网页版 · ${webBrowserOf(ua)} · ${webOsOf(ua)}`
}

const DEVICE_KEY = 'dsh-hub:device-name:v1'

/**
 * 登录时上报的设备名（Hub `DeviceNameSchema`：1..64、禁控制字符与路径分隔符）。
 *
 *  - 手机网页版（C11）：`手机网页版 · <浏览器> · <系统>`，不采集任何标识；
 *  - APK：平台 + 一个稳定短码（不采集任何硬件标识）。
 */
export async function deviceName(prefs: KeyValueStore): Promise<string> {
  if (IS_WEB_BUILD) return webDeviceName(currentUserAgent())
  const platform = isNative() ? Capacitor.getPlatform() : 'web'
  let suffix = await prefs.get(DEVICE_KEY)
  if (!suffix) {
    suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
    await prefs.set(DEVICE_KEY, suffix)
  }
  return `${platform === 'web' ? 'Web' : platform === 'ios' ? 'iPhone' : 'Android'} · ${suffix}`
}

/** 打开 Hub 网页（注册 / 忘记密码 / 改密码）。原生用 Browser 插件，Web 用新标签页。 */
export async function openExternal(url: string): Promise<void> {
  if (isNative()) {
    await Browser.open({ url })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export { MemoryKeyValueStore, MemorySessionCache }
