/**
 * Hub 入口与构建参数（**仓库里不写死任何 Hub 地址**）。
 *
 * 入口从哪来（优先级从高到低）：
 *  1. 构建参数 `VITE_HUB_ORIGIN=mock` → 进程内假 Hub（不产生任何网络请求）；
 *  2. 运行期注入 `window.__dshHubOrigins`（只给 e2e/调试用，见 `injectedHubOrigins`）；
 *  3. 构建参数 `VITE_HUB_ORIGIN=<地址>` → 单入口覆盖（开发 / 联调 / e2e 常用）；
 *  4. **用户手填并持久化的地址**（APK 没有内置入口时由登录页收集）；
 *  5. 构建参数 `VITE_HUB_ORIGINS=<地址1>,<地址2>` → 有序入口列表（第一个是首选）。
 *     fork 者应该把自己的 Hub 地址写在这里（见 `apps/mobile/README.md`），
 *     这个构建参数会同时决定「网络检测」页里的多入口切换行为。
 *
 * 五个来源全空**是合法状态**（`resolveHubOrigins()` 返回空数组）：说明这个 APK 没有内置
 * 任何 Hub，登录页会要求用户填服务器地址。别在这里偷偷塞一个默认域名 —— 公开仓库里的
 * 默认地址等于把所有构建都指到某一个人的服务器上。
 *
 * 多入口切换的细节见 `http/origin-manager.ts`；「手机网页版」(`VITE_TARGET=web`) 由 Hub
 * 同源托管在 `/m/`，入口是**单个**页面 origin（`resolveWebHubOrigins`），不参与多入口切换。
 */

/** 构建参数取这个值时走进程内 mock（假 Hub），不产生任何网络请求。 */
export const MOCK_HUB_ORIGIN = 'mock'

/** 去掉末尾斜杠；非法值返回 null，由调用方决定回退到哪个地址。 */
export function normalizeHubOrigin(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    // 带路径的 origin 不支持（所有接口都以 /api/mobile 开头）
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/** 去重 + 去末尾斜杠 + 丢掉非法地址（顺序保留）。 */
export function normalizeHubOrigins(list: readonly string[]): string[] {
  const out: string[] = []
  for (const item of list) {
    const origin = normalizeHubOrigin(item)
    if (origin !== null && !out.includes(origin)) out.push(origin)
  }
  return out
}

/**
 * 解析构建期的入口列表（`VITE_HUB_ORIGINS`，逗号分隔；`mock` 单独一个值）。
 *
 * `https://hub.example.com,https://backup.example.com` → 两个入口（第一个是首选）。
 * 空串 / 未设置 → `[]`（合法：没有内置入口，登录页要用户填地址）。
 */
export function parseHubOrigins(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return []
  const parts = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (parts.some((item) => item === MOCK_HUB_ORIGIN)) return [MOCK_HUB_ORIGIN]
  const out = normalizeHubOrigins(parts)
  // 全部非法（手滑打错）也算「没配」：别让一个拼错的地址把 App 指到半个入口上。
  return out
}

/**
 * 解析构建期的入口标签（`VITE_HUB_ORIGIN_LABELS`，`<origin>=<标签>`，逗号分隔）。
 *
 * 例：`https://hub.example.com=主站,https://backup.example.com=备用`
 * 只认能对应上入口的键（值会归一成 origin）；解析不出来的条目直接忽略 ——
 * 标签只影响网络检测页的展示，任何错误都不该让 App 起不来。
 */
export function parseHubOriginLabels(raw: string | null | undefined): Record<string, string> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return {}
  const out: Record<string, string> = {}
  for (const part of trimmed.split(',')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const origin = normalizeHubOrigin(part.slice(0, index))
    const label = part.slice(index + 1).trim()
    if (origin === null || label.length === 0) continue
    out[origin] = label
  }
  return out
}

/**
 * 运行时注入的入口列表（**只给 e2e / 联调用**）：
 *
 * `window.__dshHubOrigins = ['http://127.0.0.1:5401', 'http://127.0.0.1:5402']`
 *
 * 为什么需要它：`VITE_HUB_ORIGIN` 是**构建期**参数，只能给一个地址，而多入口切换要在
 * 浏览器里造「主入口挂了、备用入口正常」。与 `__dshNetDiagControlSites` 同一套做法：
 * 注入非法值时整份忽略，退回构建参数/用户填的地址，绝不让它把 App 指到别的地方去。
 */
export function injectedHubOrigins(): string[] {
  const scope = globalThis as { __dshHubOrigins?: unknown }
  const raw = scope.__dshHubOrigins
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const origin = normalizeHubOrigin(item)
    if (origin !== null && !out.includes(origin)) out.push(origin)
  }
  return out
}

export interface HubOriginSources {
  /** 构建期入口（`VITE_HUB_ORIGINS` 解析后的结果）。 */
  builtIn?: readonly string[]
  /** 用户手填并持久化的入口（APK：内置列表为空时由登录页收集）。 */
  saved?: readonly string[]
  /** 一次性覆盖（`VITE_HUB_ORIGIN`；开发 / 联调 / e2e 用）。 */
  override?: string | null
}

/**
 * 解析入口列表（有序）。
 *
 * 优先级：mock > 运行时注入（e2e）> `VITE_HUB_ORIGIN` 覆盖 > 用户手填 > 构建期列表。
 * 某一层给了非法值就**跳过这一层**（继续往下找），而不是把整份列表清空 ——
 * 手滑打错一个覆盖值不应该让 App 变成「没有服务器」。
 * 五层都空返回 `[]`：调用方（登录页）据此要求用户填服务器地址。
 */
export function resolveHubOrigins(sources: HubOriginSources = {}): string[] {
  const overrideRaw = (sources.override ?? '').trim()
  const builtIn = normalizeHubOrigins(sources.builtIn ?? [])
  if (overrideRaw === MOCK_HUB_ORIGIN) return [MOCK_HUB_ORIGIN]
  if ((sources.builtIn ?? []).some((item) => item === MOCK_HUB_ORIGIN)) return [MOCK_HUB_ORIGIN]

  const injected = injectedHubOrigins()
  if (injected.length > 0) return injected

  if (overrideRaw) {
    const origin = normalizeHubOrigin(overrideRaw)
    if (origin !== null) return [origin]
    // 覆盖值非法（手滑打错）：当作没覆盖，继续看用户手填 / 构建期列表。
  }

  const saved = normalizeHubOrigins(sources.saved ?? [])
  if (saved.length > 0) return saved

  return builtIn
}

/** 单入口版本（旧调用方/测试用）：取列表第一个，没有入口时返回空串。 */
export function resolveHubOrigin(override?: string | null): string {
  return resolveHubOrigins({ override })[0] ?? ''
}

/**
 * 手机网页版入口（契约 C4）——**永远只有一个候选**（没有返回空数组以外的例外）。
 *
 * 手机网页版由 Hub 同源托管在 `/m/`（`MOBILE_WEB_BASE_PATH`），所以：
 *  1. `VITE_HUB_ORIGIN` 有值时用它（开发 / e2e / mock 用；与 APK 的 dev 构建同一套覆盖语义）；
 *  2. 否则用**页面自己的 origin**（`location.origin`）——网页版只有一个入口，不做多入口切换，
 *     也不做「回切首选」（Hub 的 CSP 是 `connect-src 'self'`，跨源请求本来就会被浏览器拦住）；
 *  3. `VITE_HUB_ORIGINS` 的构建期列表只在拿不到页面 origin 时兜底（SSR / 单测 / file://）；
 *  4. `VITE_HUB_ORIGIN=mock` 仍是进程内假 Hub。
 *
 * 与 `resolveHubOrigins` 的两点区别，都是刻意为之：
 *  - **不读** 运行期注入的 `window.__dshHubOrigins`（那是 APK 多入口 e2e 的开关，网页版是单入口）；
 *  - 覆盖值非法时不回退到构建期列表，而是继续用页面 origin（网页版没有备用入口）。
 */
export function resolveWebHubOrigins(
  override?: string | null,
  pageOrigin?: string | null,
  builtIn?: readonly string[],
): string[] {
  const raw = (override ?? '').trim()
  if (raw === MOCK_HUB_ORIGIN) return [MOCK_HUB_ORIGIN]
  if (raw) {
    const origin = normalizeHubOrigin(raw)
    if (origin !== null) return [origin]
    // 覆盖值非法：当作没覆盖，继续走「页面自己的 origin」。
  }
  const page = normalizeHubOrigin(pageOrigin)
  if (page !== null) return [page]
  return normalizeHubOrigins(builtIn ?? [])
}

export function isMockOrigin(origin: string): boolean {
  return origin === MOCK_HUB_ORIGIN
}

/** https://host:port → wss://host:port（通道升级用）。 */
export function wsOriginOf(origin: string): string {
  if (origin.startsWith('https://')) return `wss://${origin.slice('https://'.length)}`
  if (origin.startsWith('http://')) return `ws://${origin.slice('http://'.length)}`
  return origin
}

/** 注册/忘记密码/改密码等网页入口（Hub 网页与 API 同源）。 */
export function webPageOf(origin: string, path: string): string | null {
  if (!origin.startsWith('http')) return null
  return `${origin.replace(/\/+$/, '')}${path}`
}

/** 账号隔离键（M2 的 `HubAccountKey(origin, username)`）：origin + 账号变了就换一份缓存。 */
export function accountKeyOf(origin: string, username: string): string {
  return `${origin}#${username.trim().toLowerCase()}`
}
