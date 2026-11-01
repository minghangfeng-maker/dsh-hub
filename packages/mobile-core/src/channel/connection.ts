/**
 * 通道连接：openChannel + ticket、重连退避、心跳、linkDead、探活、generation 防陈旧、
 * hello 发送、`onChannelEnd` 分类（4001/4003 → 登录过期）。
 *
 * 这一层只管「链路」，不解析业务状态：
 *   - `openChannel(nodeId)` 由上层注入（浏览器用 `WsChannelLink`，单测用 `FakeChannel`）；
 *   - 每条链路一个 generation，旧的 `onEvent` 一律丢弃（防「上一次连接的回包污染新连接」）；
 *   - 心跳每 25s 发 ping；`linkDeadMs`（默认 90s）内没有任何下行就主动掐掉重连——
 *     手机切后台/换网后的 TCP 半边开不会触发 close，但发出去的帧全进黑洞；
 *   - 回前台 `probeLink(6s)`：发 ping 后等任何下行，等不到就主动断开。
 *
 * 业务帧一律转给 `onFrame`（门面分派），连接层不认 delta/message。
 */

import { encodeClientFrame, hello, parseServerFrame, ping } from './wire.js'
import type { AnyServerFrame, ClientIdentity } from './wire.js'
import type { ChannelLink, ChannelLinkEvent } from './link.js'
import type { MobileHelloV2 } from '../contracts/mobile-v2.js'
import { APP_DECLARED_FEATURES } from '../contracts/mobile-v2.js'
import { errorMessage } from '../errors.js'
import type { LinkState, WorkspaceState } from './workspace-state.js'
import type { RequestFrame } from './requests.js'

export const DEFAULT_RECONNECT = { baseMs: 1_000, maxMs: 15_000, maxAttempts: 8 }
const KEEPALIVE_MS = 25_000
const LINK_DEAD_MS = 90_000
/** 主动探活（App 从后台切回）：这么久没任何下行就判定链路已死。 */
const PROBE_TIMEOUT_MS = 6_000

/** 构造一条链路的全部输入（与 `WorkspaceControllerOptions` 的对应字段同名）。 */
export interface ConnectionOptions {
  nodeId: string
  client: ClientIdentity
  openChannel: (nodeId: string) => Promise<ChannelLink>
  /** 25s 客户端心跳；单测关掉。 */
  keepAlive?: boolean
  keepAliveMs?: number
  linkDeadMs?: number
  reconnect?: { baseMs?: number; maxMs?: number; maxAttempts?: number }
}

/** 链路层回调（门面实现）。 */
export interface ConnectionHandlers {
  now(): number
  log(event: string, meta?: Record<string, unknown>): void
  onSessionExpired?: (() => void) | undefined
  /** requestId 生成器（与请求表共用同一个计数器）。 */
  nextRequestId(): string
  /** 每条下行文本、解析之前（门面在这里做未决消息的「结果未知」判定）。 */
  beforeParse(): void
  /** 一帧合法下行。 */
  onFrame(frame: AnyServerFrame): void
  /** `v` 不匹配（M4 §7）：停止重连并提示升级。 */
  onProtocolMismatch(): void
  onMalformed(type: string): void
  /** 新连接 hello 已到：门面协商 features/能力。generation 已自增。 */
  onHello(frame: MobileHelloV2): void
  /** 通道结束（分类之前）：清掉只活在一条通道里的状态（文件/卡片/用量）。 */
  onChannelEnd(code: number, reason: string): void
  /** 收到任何合法下行帧（非 error）：通道级错误已恢复。 */
  onRecovered(): void
  /** 排重连之前（未决消息的生命周期判定）。 */
  beforeReconnect(): void
  patch(partial: Partial<WorkspaceState>): void
  state(): WorkspaceState
}

type ConnectionDeps = ConnectionOptions &
  ConnectionHandlers & {
    keepAlive: boolean
    keepAliveMs: number
    linkDeadMs: number
    reconnect: { baseMs: number; maxMs: number; maxAttempts: number }
  }

/** 归一化选项并建链（缺省值 / 重连配置只在这里写一次）。 */
export function createChannelConnection(
  options: ConnectionOptions,
  handlers: ConnectionHandlers,
): ChannelConnection {
  return new ChannelConnection({
    ...handlers,
    nodeId: options.nodeId,
    client: options.client,
    openChannel: options.openChannel,
    keepAlive: options.keepAlive !== false,
    keepAliveMs: options.keepAliveMs ?? KEEPALIVE_MS,
    linkDeadMs: options.linkDeadMs ?? LINK_DEAD_MS,
    reconnect: { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) },
  })
}

export class ChannelConnection {
  private link: ChannelLink | null = null
  /** 链路代数：每次 connect 自增；旧链路的 onEvent 全部忽略。 */
  private generation = 0
  /** hello 代数：每次收到 hello 自增；未决消息用它判定「跨越过一次成功重连」。 */
  private hellos = 0
  private manualClose = false
  private disconnected = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  /** 最后一次收到任何合法下行帧的时间（心跳判活用）。 */
  private lastInboundAt = 0
  /** 主动探活的超时器（发 ping 后等任何下行；到点没等到就主动断开重连）。 */
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  /** 探活进行中的「收到下行」回调（成功一次就丢）。 */
  private probeAlive: (() => void) | null = null

  constructor(private readonly deps: ConnectionDeps) {}

  /** hello 代数（门面用它判定未决消息是否跨越了一次成功重连）。 */
  get connectionGeneration(): number {
    return this.hellos
  }

  get linkState(): LinkState {
    return this.deps.state().link
  }

  get hasLink(): boolean {
    return this.link !== null
  }

  get disposed(): boolean {
    return this.disconnected
  }

  markDisposed(): void {
    this.disconnected = true
  }

  /** 登录失效（bye/`session-expired`）：不再重连。 */
  markManualClose(): void {
    this.manualClose = true
  }

  start(): void {
    if (this.disconnected) return
    const link = this.deps.state().link
    if (link === 'connecting' || link === 'connected') return
    this.manualClose = false
    this.connect(false)
  }

  retry(): void {
    if (this.disconnected) return
    this.manualClose = false
    this.connect(true)
  }

  connect(reconnecting: boolean): void {
    if (this.disconnected) return
    this.clearReconnect()
    // 上一次连接还在时先关掉（重连窗口里可能残留）
    if (this.link) {
      const old = this.link
      this.link = null
      try {
        old.close(1000, 'reconnect')
      } catch {
        /* ignore */
      }
    }
    const gen = ++this.generation
    this.deps.patch({
      link: reconnecting ? 'reconnecting' : 'connecting',
      error: reconnecting ? this.deps.state().error : null,
    })

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    void this.deps
      .openChannel(this.deps.nodeId)
      .then((link) => {
        if (gen !== this.generation || this.disconnected) {
          link.close(1000, 'stale')
          return
        }
        this.link = link
        link.onEvent((event: ChannelLinkEvent) => {
          if (gen !== this.generation || this.disconnected) return
          switch (event.type) {
            case 'open':
              this.sendHello()
              break
            case 'text':
              this.handleText(event.data)
              break
            case 'close':
              finish(() => this.onChannelEnd(event.code, event.reason))
              break
            case 'error':
              // WS 的 error 后面通常跟 close；先记诊断，等 close 决定是否重连。
              this.deps.log('channel-error', { error: String(event.error) })
              break
          }
        })
      })
      .catch((error: unknown) => {
        if (gen !== this.generation || this.disconnected) return
        this.deps.patch({
          link: 'failed',
          error: {
            code: 'upstream-unavailable',
            message: errorMessage('upstream-unavailable'),
            retryable: true,
          },
        })
        this.deps.log('channel-open-failed', { error: String(error) })
      })
  }

  /**
   * 主动断开（用户显式断开 / dispose）。
   *
   * 先自增 generation 再 close：这样 close 事件的回调会被判成旧链路而忽略
   * （主动断开不该走 `onChannelEnd` 的分类/重连）。
   */
  disconnect(cleanup: () => void): void {
    this.manualClose = true
    this.generation += 1
    this.clearReconnect()
    this.stopKeepAlive()
    cleanup()
    const link = this.link
    this.link = null
    link?.close(1000, 'client-bye')
  }

  /** 发送一帧；链路不在/编码失败返回 false（调用方据此报「没发出去」，绝不假装成功）。 */
  send(frame: RequestFrame): boolean {
    if (!this.link) return false
    try {
      return this.link.send(encodeClientFrame(frame))
    } catch {
      return false
    }
  }

  /**
   * 主动探活：发一个 ping，`timeoutMs` 内没等到任何下行帧就主动断开（触发重连）。
   *
   * App 从后台切回时调用（`chat.onForeground`）：手机切后台/换网后 WS 可能半边开，
   * 浏览器不会立刻给 close —— 不探活的话，用户接下来改模型/归档都会「请求超时」。
   */
  probe(timeoutMs = PROBE_TIMEOUT_MS, onAlive?: () => void): void {
    if (this.disconnected || this.deps.state().link !== 'connected' || this.link === null) return
    this.clearProbe()
    this.probeAlive = onAlive ?? null
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.deps.state().link !== 'connected') return
      this.deps.log('link-probe-timeout', { timeoutMs })
      this.link?.close(4002, 'probe-timeout')
    }, Math.max(10, timeoutMs))
    ;(this.probeTimer as unknown as { unref?: () => void }).unref?.()
    this.send(ping(this.deps.now()))
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private sendHello(): void {
    // v2 协商：声明本 App 能处理的特性；服务端回显子集，没回显就按 v1 降级。
    if (!this.send(hello(this.deps.nextRequestId(), this.deps.client, APP_DECLARED_FEATURES))) {
      return
    }
    this.deps.patch({ sessionsLoading: true })
  }

  private handleText(data: string): void {
    this.deps.beforeParse()
    const parsed = parseServerFrame(data)
    if (parsed.kind === 'protocol-mismatch') {
      this.manualClose = true
      this.deps.onProtocolMismatch()
      return
    }
    if (parsed.kind !== 'frame') {
      if (parsed.kind === 'malformed') this.deps.onMalformed(parsed.type)
      return
    }
    this.lastInboundAt = this.deps.now()
    const alive = this.probeAlive
    this.clearProbe()
    // 探活成功：任何下行都算链路活着（业务帧、pong、快照都行）。
    if (alive) alive()
    if (parsed.frame.type !== 'error') this.deps.onRecovered()
    if (parsed.frame.type === 'hello') this.onHelloReceived()
    this.deps.onFrame(parsed.frame)
  }

  /**
   * hello：新连接真正建立。
   *
   * 先做连接层的记账（代数自增、重连计数归零、心跳开始），再交给门面协商
   * features/能力——门面会在同一个 tick 里发 sessions/history/subscribe。
   */
  private onHelloReceived(): void {
    this.hellos += 1
    this.lastInboundAt = this.deps.now()
    this.clearProbe()
    this.reconnectAttempts = 0
    if (this.deps.keepAlive) this.startKeepAlive()
  }

  private onChannelEnd(code: number, reason: string): void {
    this.link = null
    this.stopKeepAlive()
    this.deps.log('link-closed', { code, reason })
    // 通道死了：通道内瞬态的提问/审批已经没有应答窗口（Hub 在 adapter close 时会把未决
    // 请求回 `next`）。不清掉的话，断线那一刻的卡片会永远留在 UI 上（真机 2026-10-27 16:07）。
    this.deps.onChannelEnd(code, reason)
    if (this.manualClose || this.disconnected) {
      this.deps.patch({ link: 'closed' })
      return
    }
    if (code === 4001 || code === 4003) {
      this.manualClose = true
      this.deps.patch({
        link: 'failed',
        error: { code: 'unauthenticated', message: errorMessage('unauthenticated'), retryable: false },
      })
      this.deps.onSessionExpired?.()
      return
    }
    this.scheduleReconnect(reason)
  }

  private scheduleReconnect(reason: string): void {
    if (this.manualClose || this.disconnected) return
    const attempt = this.reconnectAttempts + 1
    if (attempt > this.deps.reconnect.maxAttempts) {
      this.deps.patch({
        link: 'failed',
        error: { code: 'reconnect-failed', message: errorMessage('reconnect-failed'), retryable: true },
      })
      return
    }
    this.reconnectAttempts = attempt
    this.deps.patch({
      link: 'reconnecting',
      reconnectAttempt: attempt,
      error: {
        code: 'reconnecting',
        message: `连接已断开，正在重连（第 ${attempt} 次）…`,
        retryable: true,
      },
    })
    // 未知判定只看未决消息自身的生命周期，不按连续失败次数（onHello 会归零 attempt）。
    this.deps.beforeReconnect()
    this.clearReconnect()
    const delay = Math.min(
      this.deps.reconnect.baseMs * 2 ** Math.min(attempt - 1, 4),
      this.deps.reconnect.maxMs,
    )
    this.deps.log('channel-reconnect', { attempt, delay, reason })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.manualClose && !this.disconnected) this.connect(true)
    }, delay)
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    // 连上（或重连成功）就从现在开始算存活时间，避免拿上一代的 lastInboundAt 误判死链。
    this.lastInboundAt = this.deps.now()
    this.keepAliveTimer = setInterval(() => {
      if (this.deps.state().link !== 'connected') return
      const idleMs = this.deps.now() - this.lastInboundAt
      if (idleMs > this.deps.linkDeadMs) {
        // 半边开：close 事件可能永远不来，主动掐掉让状态机重连（UI 会看到「正在重连」）。
        this.deps.log('link-dead', { idleMs })
        this.link?.close(4002, 'liveness-timeout')
        return
      }
      this.send(ping(this.deps.now()))
    }, this.deps.keepAliveMs)
    // Node 里 setInterval 会挂住事件循环；浏览器里没有 unref。
    ;(this.keepAliveTimer as unknown as { unref?: () => void }).unref?.()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
    this.clearProbe()
  }

  private clearProbe(): void {
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    this.probeAlive = null
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

export { KEEPALIVE_MS, LINK_DEAD_MS, PROBE_TIMEOUT_MS }
