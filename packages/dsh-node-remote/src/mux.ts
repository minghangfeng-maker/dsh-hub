import { randomUUID } from 'node:crypto'
import { connectWebSocket } from './ws.js'
import type { WebSocketLike } from './types.js'

export interface MuxFrameError {
  code: string
  message: string
  details: Record<string, unknown>
}

export interface MuxStreamHandlers {
  onItem: (value: unknown) => void
  onEnd: () => void
  onError: (error: MuxFrameError) => void
}

export interface MuxOptions {
  url: string
  headers: () => Promise<Record<string, string>> | Record<string, string>
  createWebSocket?: (url: string, headers: Record<string, string>) => Promise<WebSocketLike>
  log?: (event: string, meta?: Record<string, unknown>) => void
}

/**
 * `/api/remote.mux` 的逻辑流客户端。
 *
 * 帧（`@deepseek-ai/dsh-api-gateway/stream-protocol`）：
 * - 上行 `{type:'open',streamId,endpoint,payload}` / `{type:'cancel',streamId}`
 * - 下行 `{type:'item',streamId,value?}` / `{type:'error',streamId,error}` / `{type:'end',streamId}`
 *
 * 一条物理 WS 上复用多条逻辑流；连接断了先给所有流发 `upstream-unavailable`，
 * 下一次 `open` 再重连（不做后台重连风暴）。
 */
export class MuxConnection {
  private readonly options: MuxOptions
  private socket: WebSocketLike | null = null
  private connecting: Promise<void> | null = null
  private readonly streams = new Map<string, MuxStreamHandlers>()
  private closed = false

  constructor(options: MuxOptions) {
    this.options = options
  }

  get connected(): boolean {
    return this.socket !== null && !this.closed
  }

  async open(endpoint: string, payload: unknown, handlers: MuxStreamHandlers): Promise<string> {
    if (this.closed) throw new Error('mux 已关闭')
    await this.ensureConnected()
    const streamId = randomUUID()
    this.streams.set(streamId, handlers)
    this.options.log?.('mux.open', { endpoint })
    this.send({ type: 'open', streamId, endpoint, payload })
    return streamId
  }

  cancel(streamId: string): void {
    if (!this.streams.delete(streamId)) return
    if (this.socket === null) return
    this.send({ type: 'cancel', streamId })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.streams.clear()
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'client closing')
  }

  private send(message: unknown): void {
    const socket = this.socket
    if (socket === null) return
    try {
      socket.send(JSON.stringify(message))
    } catch (error) {
      this.options.log?.('mux.send-failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket !== null) return
    if (this.connecting !== null) return await this.connecting
    this.connecting = (async () => {
      const headers = await this.options.headers()
      const connect = this.options.createWebSocket ?? connectWebSocket
      const socket = await connect(this.options.url, headers)
      if (this.closed) {
        socket.close(1000, 'closed while connecting')
        throw new Error('mux 已关闭')
      }
      this.socket = socket
      socket.onText((text) => this.handleText(text))
      socket.onClose((code, reason) => {
        this.socket = null
        this.failAll({ code: 'upstream-unavailable', message: `Host 流连接关闭（${code} ${reason}）`, details: {} })
      })
      socket.onError((error) => {
        this.options.log?.('mux.error', { message: error.message })
      })
      this.options.log?.('mux.connected')
    })()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private failAll(error: MuxFrameError): void {
    const streams = [...this.streams.values()]
    this.streams.clear()
    for (const handlers of streams) handlers.onError(error)
  }

  private handleText(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.options.log?.('mux.bad-frame')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const frame = parsed as Record<string, unknown>
    const streamId = typeof frame['streamId'] === 'string' ? frame['streamId'] : null
    if (streamId === null) return
    const handlers = this.streams.get(streamId)
    if (handlers === undefined) return
    const type = frame['type']
    if (type === 'item') {
      handlers.onItem(frame['value'])
      return
    }
    if (type === 'end') {
      this.streams.delete(streamId)
      handlers.onEnd()
      return
    }
    if (type === 'error') {
      this.streams.delete(streamId)
      const error = frame['error']
      const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
      handlers.onError({
        code: typeof record['code'] === 'string' ? record['code'] : 'internal',
        message: typeof record['message'] === 'string' ? record['message'] : 'Host 流失败',
        details:
          typeof record['details'] === 'object' && record['details'] !== null
            ? (record['details'] as Record<string, unknown>)
            : {},
      })
    }
  }
}
