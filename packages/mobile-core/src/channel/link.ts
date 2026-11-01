/**
 * 通道传输抽象。
 *
 * S0 原型只有一个「单向事件流」（open + sinceCursor + stop）；手机通道是**双向**的
 * （send/stop/answer 上行，delta/message 下行），并且同一帧集合里既有会话级流也有通道级
 * 事件，所以这一层抽成 `ChannelLink`（S0 的 SSE 那一层已在 0.2.17 删除）：
 *
 *   - 依赖方向不变：状态机（WorkspaceController）只认 `ChannelLink`；
 *   - 实现可替换：浏览器/Android 用 `WsChannelLink`，单测与 mock 用 `FakeChannelLink`；
 *   - 游标语义不变：重连仍然靠 `subscribe { sinceCursor }` 续看，游标来自 `history.cursor`
 *     / `replay.toCursor`，不在传输层发明第二套序号。
 */

export interface ChannelOpenEvent {
  type: 'open'
}

export interface ChannelTextEvent {
  type: 'text'
  data: string
}

export interface ChannelCloseEvent {
  type: 'close'
  code: number
  reason: string
}

export interface ChannelErrorEvent {
  type: 'error'
  error: unknown
  httpStatus?: number
}

export type ChannelLinkEvent = ChannelOpenEvent | ChannelTextEvent | ChannelCloseEvent | ChannelErrorEvent

export type ChannelLinkState = 'connecting' | 'open' | 'closed'

export interface ChannelLink {
  readonly state: ChannelLinkState
  /** 发送一帧文本；未连接/缓冲已满返回 false（状态机据此报「消息未发送」，绝不假装成功）。 */
  send(text: string): boolean
  close(code?: number, reason?: string): void
  /** 返回取消订阅函数。 */
  onEvent(handler: (event: ChannelLinkEvent) => void): () => void
}

/** 单帧上限（M4 §4：256 KiB）。 */
export const MAX_FRAME_BYTES = 262_144

/** 把字符串按 UTF-8 估算字节数；超过上限直接拒绝，避免被服务端断连。 */
export function frameByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', handler: (ev: any) => void): void
  removeEventListener?: (type: string, handler: (ev: any) => void) => void
}

export interface WsChannelLinkOptions {
  /** 注入 WebSocket 构造器（测试/Node 用）；默认取全局 WebSocket。 */
  createSocket?: (url: string) => WebSocketLike
}

/**
 * 浏览器 / Android WebView 的 WS 实现。
 *
 * 鉴权走 URL 上的 `?ticket=`（契约草案 §3），不带 cookie；
 * 连接失败（握手 401/403）由上层重新申请 ticket 后重试，本类不做重试。
 */
export class WsChannelLink implements ChannelLink {
  private socket: WebSocketLike | null = null
  private handlers = new Set<(event: ChannelLinkEvent) => void>()
  private stateValue: ChannelLinkState = 'connecting'

  constructor(url: string, options: WsChannelLinkOptions = {}) {
    const factory =
      options.createSocket ??
      ((target: string) => {
        const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
        if (!Ctor) throw new Error('当前环境没有 WebSocket')
        return new Ctor(target)
      })
    try {
      const socket = factory(url)
      this.socket = socket
      socket.addEventListener('open', () => {
        this.stateValue = 'open'
        this.emit({ type: 'open' })
      })
      socket.addEventListener('message', (ev) => {
        const data = typeof ev?.data === 'string' ? ev.data : ''
        if (data) this.emit({ type: 'text', data })
      })
      socket.addEventListener('close', (ev) => {
        this.stateValue = 'closed'
        this.emit({ type: 'close', code: Number(ev?.code ?? 1006), reason: String(ev?.reason ?? '') })
      })
      socket.addEventListener('error', (ev) => {
        this.emit({ type: 'error', error: ev })
      })
    } catch (error) {
      this.stateValue = 'closed'
      queueMicrotask(() => this.emit({ type: 'error', error }))
    }
  }

  get state(): ChannelLinkState {
    return this.stateValue
  }

  send(text: string): boolean {
    if (this.stateValue !== 'open' || !this.socket) return false
    if (frameByteLength(text) > MAX_FRAME_BYTES) return false
    try {
      this.socket.send(text)
      return true
    } catch {
      return false
    }
  }

  close(code = 1000, reason = 'client-bye'): void {
    if (this.stateValue === 'closed') return
    this.stateValue = 'closed'
    try {
      this.socket?.close(code, reason)
    } catch {
      /* ignore */
    }
  }

  onEvent(handler: (event: ChannelLinkEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private emit(event: ChannelLinkEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event)
      } catch {
        /* 单个监听器异常不能影响其他监听器 */
      }
    }
  }
}
