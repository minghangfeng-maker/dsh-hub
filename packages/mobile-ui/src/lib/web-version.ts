/**
 * 手机网页版的版本检查（WP54 / 契约 C7）。
 *
 * 网页版没有 APK、没有强更地板：用户刷新页面就是最新版本。所以「更新」这件事在网页版
 * 只剩一个问题：**页面已经打开了，Hub 上换了新构建，怎么让用户切到新版本？**
 *
 * 做法（契约 C7）：构建时把 `{version, build, builtAt}` 注入客户端，同时产出
 * `dist-web/version.json`（与注入值逐字节一致，见 packages/mobile-ui/vite.config.ts 的
 * `webVersionPlugin`）。运行时在**回前台**（`visibilitychange` → visible）与**每 30 分钟**
 * 拉一次 `./version.json`（`cache: 'no-store'`，C6 里这个路径也是 no-store），
 * 与内置值不同 → store 暴露 `webUpdateAvailable`，W4 的界面提示「有新版本，点此刷新」，
 * 点一下调 `reloadToUpdate()`（`location.reload()`）。
 *
 * 「判断不了」一律**静默跳过**（不提示、不报错、不弹 toast，下个周期再试）：
 * 非 200（含 Hub 还没部署时 `/m/version.json` 的 404 —— 契约 C6 对带扩展名的缺失路径回 404，
 * 不会拿 index.html 冒充 JSON）、响应不是 JSON、字段缺失/类型不对。宁可晚一次提示，
 * 也不能因为部署中间态把人钉在「有新版本」的假提示上。
 *
 * 这个文件只放**不依赖 Vue** 的纯逻辑 + 一个可注入 document/定时器/fetch 的小类，
 * 单测直接跑（不需要真浏览器）。接线在 `stores/app-update.ts`。
 */

import type { BuildInfo } from './app-info'

/** 版本文件（与 Hub 托管目录同源，相对 `index.html`；hash 路由下 base 仍是 `/m/`）。 */
export const WEB_VERSION_URL = './version.json'
/** 常驻轮询间隔：30 分钟（契约 C7）。 */
export const WEB_VERSION_INTERVAL_MS = 30 * 60 * 1_000
/**
 * 两次检查之间的最小间隔：切页签很频繁，别每切一次就打一次 Hub。
 * 冷启动的首次检查不受它约束（`start()` 里直接查一次）。
 */
export const WEB_VERSION_MIN_GAP_MS = 3_000

/** 只用到 Response 的这几个字段，单测可以给假对象。 */
export interface WebVersionResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
export type WebVersionFetch = (url: string, init?: RequestInit) => Promise<WebVersionResponse>

/** 只用到 document 的可见性接口（单测注入假对象）。 */
export interface WebVisibilitySource {
  visibilityState?: string
  hidden?: boolean
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type TimerHandle = unknown
export type SetIntervalFn = (fn: () => void, ms: number) => TimerHandle
export type ClearIntervalFn = (handle: TimerHandle) => void

/**
 * 解析 `version.json`。
 *
 * 坏数据/少字段一律返回 null（当作「没有新版本」），绝不让一个手滑写坏的 JSON
 * 把所有人卡在「有新版本」的提示里。`builtAt` 只用于诊断展示，缺了也能用。
 */
export function parseWebVersion(raw: unknown): BuildInfo | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const build = typeof record.build === 'string' ? record.build.trim() : ''
  const builtAt = typeof record.builtAt === 'string' ? record.builtAt.trim() : ''
  if (version === '' || build === '') return null
  return { version, build, builtAt }
}

/**
 * 线上版本与内置版本是不是**不同的构建**。
 *
 * 只比 `version` + `build`（git 短 sha）：同一版本重打过包（只换了时间/依赖）也该提示刷新，
 * 所以不比 `builtAt`（它每次构建都变，拿来比会把「同一份产物」也判成新版本）。
 */
export function isNewerWebVersion(current: BuildInfo, remote: BuildInfo): boolean {
  return current.version !== remote.version || current.build !== remote.build
}

export interface WebVersionWatchOptions {
  /** 本产物内置的构建信息（`BUILD_INFO`）。 */
  current: BuildInfo
  url?: string
  intervalMs?: number
  minGapMs?: number
  fetchImpl?: WebVersionFetch
  now?: () => number
  /** 检测到「线上是另一个构建」时回调（只回调一次，之后停止轮询）。 */
  onUpdate?: (remote: BuildInfo) => void
  /** 诊断事件（进本地环形缓冲；不含 URL）。 */
  onEvent?: (name: string, detail: string) => void
  /** 可见性事件源；不传时用 `globalThis.document`（拿不到就只跑定时器）。 */
  doc?: WebVisibilitySource | null
  setIntervalImpl?: SetIntervalFn
  clearIntervalImpl?: ClearIntervalFn
}

/**
 * 回前台 + 每 30 分钟拉一次 `version.json` 的小状态机。
 *
 * 语义：
 *  - `start()`：立刻查一次，挂 visibilitychange 监听，起 30 分钟定时器（幂等）；
 *  - `checkNow()`：真正的拉取动作（`no-store`）；并发调用合并成一次；
 *  - 一旦判定「有新版本」，回调一次 `onUpdate` 并自动 `stop()`（提示出现后不必再查）；
 *  - `stop()`：摘监听、清定时器（登出/卸载时调用）。
 */
export class WebVersionWatch {
  private readonly url: string
  private readonly intervalMs: number
  private readonly minGapMs: number
  private readonly fetchImpl: WebVersionFetch
  private readonly now: () => number
  private readonly doc: WebVisibilitySource | null
  private readonly setIntervalImpl: SetIntervalFn
  private readonly clearIntervalImpl: ClearIntervalFn

  private started = false
  private available = false
  private timer: TimerHandle = null
  private lastCheckAt = 0
  private inflight: Promise<boolean> | null = null
  private readonly onVisible = (): void => {
    // 只认「回到可见」：切走（hidden）什么也不做
    if (this.doc?.visibilityState === 'hidden') return
    if (this.doc?.hidden === true) return
    void this.checkNow()
  }

  constructor(private readonly options: WebVersionWatchOptions) {
    this.url = options.url ?? WEB_VERSION_URL
    this.intervalMs = Math.max(1_000, options.intervalMs ?? WEB_VERSION_INTERVAL_MS)
    this.minGapMs = Math.max(0, options.minGapMs ?? WEB_VERSION_MIN_GAP_MS)
    this.fetchImpl =
      options.fetchImpl ??
      ((url, init) => (globalThis.fetch as unknown as WebVersionFetch)(url, init))
    this.now = options.now ?? (() => Date.now())
    this.doc =
      options.doc !== undefined
        ? options.doc
        : typeof document === 'undefined'
          ? null
          : (document as unknown as WebVisibilitySource)
    this.setIntervalImpl =
      options.setIntervalImpl ?? ((fn, ms) => globalThis.setInterval(fn, ms) as TimerHandle)
    this.clearIntervalImpl =
      options.clearIntervalImpl ?? ((handle) => globalThis.clearInterval(handle as never))
  }

  /** 是否已经提示过「有新版本」。 */
  get updateAvailable(): boolean {
    return this.available
  }

  /** 开始观察（幂等）。冷启动立刻查一次。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.doc?.addEventListener('visibilitychange', this.onVisible)
    // 定时器只兜「一直开着不切后台」的场景：浏览器会把后台标签页的 timer 节流得厉害，
    // 所以回前台时还会额外查一次（`onVisible`），两边都不指望对方。
    this.timer = this.setIntervalImpl(() => {
      void this.checkNow()
    }, this.intervalMs)
    void this.checkNow()
  }

  /** 停止观察（摘监听、清定时器）。 */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.doc?.removeEventListener('visibilitychange', this.onVisible)
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer)
      this.timer = null
    }
  }

  /**
   * 立刻拉一次 `version.json` 并比较。
   * 返回 true = 线上是另一个构建（同时已触发 `onUpdate`，并停止观察）。
   */
  async checkNow(): Promise<boolean> {
    if (this.available) return true
    if (this.inflight) return this.inflight
    // 最小间隔：切页签打得太密时直接跳过（不 force：调用方没有「必须查到」的需求）
    const at = this.now()
    if (this.lastCheckAt !== 0 && at - this.lastCheckAt < this.minGapMs) return false
    this.lastCheckAt = at
    const tracked = this.doCheck().finally(() => {
      this.inflight = null
    })
    this.inflight = tracked
    return tracked
  }

  private async doCheck(): Promise<boolean> {
    let remote: BuildInfo | null = null
    try {
      const response = await this.fetchImpl(this.url, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) {
        this.options.onEvent?.('web:version', `http-${String(response.status)}`)
        return false
      }
      remote = parseWebVersion(await response.json())
      if (!remote) {
        this.options.onEvent?.('web:version', 'bad-json')
        return false
      }
    } catch {
      // 离线 / Hub 暂时不可用：静默（下次回前台再查），不影响使用
      this.options.onEvent?.('web:version', 'network')
      return false
    }
    if (!isNewerWebVersion(this.options.current, remote)) return false
    this.available = true
    this.options.onEvent?.('web:version', `${remote.version}/${remote.build}`)
    // 提示已经出现：不用再查了（用户点刷新就换到新构建）
    this.stop()
    this.options.onUpdate?.(remote)
    return true
  }
}
