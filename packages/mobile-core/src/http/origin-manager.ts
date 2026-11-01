/**
 * 多入口（0.4.11 / WP52）：当前用哪个 Hub 入口、什么时候换、换过之后记住。
 *
 * 背景：同一个 Hub 可以有多个入口（多个域名 / 多个边缘节点，同一个后端、令牌通用），
 * 而主入口可能被中间层挡掉：域名未备案被云厂商按 SNI 拦截（HTML 403）、TLS 被中间设备
 * reset、链路抖动。App 必须能在主入口不可达时自动切到备用入口，并在主入口恢复后悄悄切回来。
 *
 * 切换规则（只有「网络层失败」与「被拦截页」才切）：
 *  - fetch 抛异常（TypeError / TLS 失败 / 连接被重置）→ 切；
 *  - 超时（我们自己的 AbortController 掐的）→ 切；
 *  - HTTP 403 且响应**不是 JSON**（中间层拦截页是 HTML，比如带 `Server: Beaver` 的那种）→ 切；
 *  - Hub 正常返回的业务错误（JSON 的 401 / 403 / 429 / 5xx）→ **不切**。
 *
 * 切之前先探测另一个入口的 `GET /api/health`（短超时 4 秒），通了才切，并把这次请求
 * 重放到新入口（由 HubClient 负责重放）。探测失败不切，避免两个入口都挂时每发一个请求
 * 都白等 4 秒 —— 失败后有一个冷却窗口。
 *
 * 持久化：记住「上次可用的入口」（KeyValueStore，正式包是 Capacitor Preferences）。
 * 下次启动先用它，避免每次冷启动都先撞一遍坏掉的主入口。
 */

import type { KeyValueStore } from '../prefs/selection-store.js'

/** 探测路径：Hub 的公开健康检查（无需鉴权、不写任何数据）。 */
export const ORIGIN_PROBE_PATH = '/api/health'
/** 探测超时：移动网络下 4 秒够一次健康检查，再久就不如不切。 */
export const ORIGIN_PROBE_TIMEOUT_MS = 4_000
/** 一次探测失败后的冷却：这段时间内再失败不再探测（两个入口都挂时不拖慢每个请求）。 */
export const ORIGIN_FAILOVER_COOLDOWN_MS = 8_000
/** 记住上次可用入口的存储键。 */
export const ORIGIN_STORE_KEY = 'dsh-hub:origin:v1'

/** 为什么会切：网络层失败 / 超时 / 被拦截页；回切时用 prefer-primary。 */
export type FailoverReason = 'network' | 'timeout' | 'blocked-page'
export type OriginSwitchReason = FailoverReason | 'restore' | 'prefer-primary'

export interface OriginSwitch {
  from: string
  to: string
  reason: OriginSwitchReason
}

export interface OriginProbe {
  ok: boolean
  status: number | null
  ms: number
  /** 失败分类（只进本地诊断，不展示给用户）。 */
  errorKind?: 'network' | 'timeout' | 'http' | 'body'
}

export type ProbeFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface OriginManagerOptions {
  /** 有序候选（首选在前）；单入口时所有切换逻辑自动退化为 no-op。 */
  origins: readonly string[]
  /** 注入 fetch（测试用）；默认全局 fetch。 */
  fetchImpl?: ProbeFetch
  /** 持久化「上次可用入口」；不传则不落盘（单测/纯内存）。 */
  store?: KeyValueStore
  storeKey?: string
  probeTimeoutMs?: number
  cooldownMs?: number
  now?: () => number
  /** 诊断事件（进本地环形缓冲，不含 url）。 */
  onEvent?: (event: string, detail: string) => void
}

/** 403 且不是 JSON 的响应 = 被中间层拦截（阿里云备案拦截页就是 HTML 403）。 */
export interface InterceptCheckInput {
  status: number
  contentType: string | null
  /** 响应体开头（只读一小段）。读不到就当空串。 */
  bodyHead?: string
}

export function looksLikeInterceptPage(input: InterceptCheckInput): boolean {
  if (input.status !== 403) return false
  const type = (input.contentType ?? '').toLowerCase()
  // Hub 正常的业务错误一定是 application/json（统一错误信封）——哪怕状态码是 403 也不切。
  if (type.includes('json')) return false
  const head = (input.bodyHead ?? '').trimStart()
  // 确实回了 JSON 体（但 content-type 缺失/写错）：按业务错误处理，不切。
  return !(head.startsWith('{') || head.startsWith('['))
}

/** 健康检查响应按「JSON 对象且 `ok` 不是 false」算健康（Hub 回 `{ok,version,db,docker}`）。 */
function isHealthyBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const ok = (body as { ok?: unknown }).ok
  return ok === undefined || ok === true
}

/**
 * 入口管理器：持有当前入口、候选顺序、持久化与健康探测。
 *
 * 所有方法都可以并发调用：切换本身是单飞的（同一时刻只有一次探测），切换成功会通知
 * 订阅者（UI 据此重连通道）。
 */
export class OriginManager {
  private readonly list: string[]
  private readonly fetchImpl: ProbeFetch
  private readonly store: KeyValueStore | null
  private readonly storeKey: string
  private readonly probeTimeoutMs: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private readonly onEvent: ((event: string, detail: string) => void) | undefined

  private active: string
  private readyPromise: Promise<void> | null = null
  private failoverPromise: Promise<boolean> | null = null
  /** 最近一次「全部候选都不可用」的时间（冷却起点）。 */
  private lastFailedAt = 0
  /**
   * 刚失败的那个入口：在它自己恢复（回前台探测首选）之前不再探它。
   * 不加这个的话，两个入口交替失败/成功会来回切（请求在两个坏入口之间反复重放）。
   */
  private badOrigin: string | null = null
  private readonly listeners = new Set<(change: OriginSwitch) => void>()

  constructor(options: OriginManagerOptions) {
    const list = options.origins.length > 0 ? [...options.origins] : []
    if (list.length === 0) throw new Error('OriginManager: origins 不能为空')
    this.list = list
    this.active = list[0]!
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit))
    this.store = options.store ?? null
    this.storeKey = options.storeKey ?? ORIGIN_STORE_KEY
    this.probeTimeoutMs = Math.max(200, options.probeTimeoutMs ?? ORIGIN_PROBE_TIMEOUT_MS)
    this.cooldownMs = Math.max(0, options.cooldownMs ?? ORIGIN_FAILOVER_COOLDOWN_MS)
    this.now = options.now ?? (() => Date.now())
    this.onEvent = options.onEvent
  }

  /** 有序候选（首选在前）。 */
  get candidates(): readonly string[] {
    return this.list
  }

  /** 首选入口。 */
  get primary(): string {
    return this.list[0]!
  }

  /** 当前入口。 */
  get current(): string {
    return this.active
  }

  /** 有备用入口才需要切换逻辑；单入口（覆盖/mock）时全为 no-op。 */
  get multi(): boolean {
    return this.list.length > 1
  }

  /** 是否停在备用入口（App 回前台时据此决定要不要悄悄探回首选）。 */
  get onSecondary(): boolean {
    return this.active !== this.primary
  }

  subscribe(handler: (change: OriginSwitch) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  /**
   * 读持久化的入口并应用（每个进程一次）。
   *
   * 记住的入口不在候选里（换了部署/降级回旧版本）就忽略，绝不连一个没登记的地址。
   */
  ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.restorePersisted().catch(() => undefined)
    }
    return this.readyPromise
  }

  private async restorePersisted(): Promise<void> {
    if (!this.store) return
    let saved: string | null = null
    try {
      saved = await this.store.get(this.storeKey)
    } catch {
      return
    }
    if (saved === null) return
    if (!this.list.includes(saved) || saved === this.active) return
    this.activate(saved, 'restore')
  }

  /** 探测一个入口的 `GET /api/health`：200 + JSON + `ok !== false` 才算通。 */
  async probe(origin: string, timeoutMs = this.probeTimeoutMs): Promise<OriginProbe> {
    const started = this.now()
    const elapsed = (): number => Math.max(0, Math.round(this.now() - started))
    if (typeof AbortController !== 'function') {
      return { ok: false, status: null, ms: elapsed(), errorKind: 'network' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(200, timeoutMs))
    ;(timer as unknown as { unref?: () => void }).unref?.()
    try {
      const response = await this.fetchImpl(`${origin}${ORIGIN_PROBE_PATH}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      })
      const ms = elapsed()
      if (!response.ok) return { ok: false, status: response.status, ms, errorKind: 'http' }
      let body: unknown = null
      try {
        body = await response.json()
      } catch {
        return { ok: false, status: response.status, ms, errorKind: 'body' }
      }
      return isHealthyBody(body)
        ? { ok: true, status: response.status, ms }
        : { ok: false, status: response.status, ms, errorKind: 'body' }
    } catch {
      const timedOut = controller.signal.aborted === true
      return {
        ok: false,
        status: null,
        ms: elapsed(),
        errorKind: timedOut ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 当前入口刚刚网络层失败/被拦截：按候选顺序探测别的入口，通了就切过去。
   *
   * 返回 true 表示「这次调用确实完成了一次切换」（调用方据此重放请求）。
   * 并发调用共用同一次探测；刚失败过（冷却中）直接返回 false，不白等。
   */
  failover(reason: FailoverReason): Promise<boolean> {
    if (!this.multi) return Promise.resolve(false)
    if (this.inCooldown()) return Promise.resolve(false)
    if (!this.failoverPromise) {
      this.failoverPromise = this.doFailover(reason).finally(() => {
        this.failoverPromise = null
      })
    }
    return this.failoverPromise
  }

  private inCooldown(): boolean {
    if (this.lastFailedAt === 0) return false
    return this.now() - this.lastFailedAt < this.cooldownMs
  }

  private async doFailover(reason: FailoverReason): Promise<boolean> {
    const from = this.active
    // 当前失败的这个入口和上次标坏的不是同一个：说明坏掉的那个可能已经恢复，允许再探。
    if (this.badOrigin !== null && this.badOrigin !== from) this.badOrigin = null
    for (const candidate of this.list) {
      if (candidate === this.active) continue
      if (candidate === this.badOrigin) continue
      const probe = await this.probe(candidate)
      this.onEvent?.('hub:origin-probe', `${probe.ok ? 'ok' : `fail:${probe.errorKind ?? 'http'}`}:${probe.ms}`)
      if (probe.ok) {
        this.lastFailedAt = 0
        this.badOrigin = from
        this.activate(candidate, reason)
        return true
      }
    }
    this.lastFailedAt = this.now()
    this.badOrigin = from
    this.onEvent?.('hub:origin-failover', `no-candidate:${reason}`)
    return false
  }

  /**
   * App 回到前台：当前停在备用入口时，静默探测首选入口，通了就切回去。
   * 返回 true 表示切回了首选。别在每次请求上都调它（只在回前台调）。
   */
  async preferPrimary(): Promise<boolean> {
    if (!this.multi) return false
    if (this.active === this.primary) return false
    const probe = await this.probe(this.primary)
    this.onEvent?.('hub:origin-probe', `${probe.ok ? 'ok' : `fail:${probe.errorKind ?? 'http'}`}:${probe.ms}`)
    if (!probe.ok) return false
    this.badOrigin = null
    this.activate(this.primary, 'prefer-primary')
    return true
  }

  private activate(origin: string, reason: OriginSwitchReason): void {
    const from = this.active
    if (origin === from) return
    this.active = origin
    // 切成功就清掉冷却：新入口上的失败该重新走探测，不该被上一次的失败拖着。
    this.lastFailedAt = 0
    // 落盘失败不影响使用（下次冷启动大不了先撞一遍主入口）。
    if (this.store) {
      void Promise.resolve()
        .then(() => this.store!.set(this.storeKey, origin))
        .catch(() => undefined)
    }
    this.onEvent?.('hub:origin-switch', reason)
    for (const handler of [...this.listeners]) {
      try {
        handler({ from, to: origin, reason })
      } catch {
        /* 订阅者自己的异常不能影响切换 */
      }
    }
  }
}
