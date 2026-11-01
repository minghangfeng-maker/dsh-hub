import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

/**
 * Hub 侧 WebSocket 薄封装（M1）。
 *
 * **不自己实现 RFC 6455**：握手、分片（含累计 message 上限）、UTF-8 校验、RSV/控制帧规则
 * 全部交给 `ws`（MIT，`^8.22.0`，在 `apps/api/package.json` 显式声明）。这里只保留业务需要的
 * 窄接口，并补上 `ws` 默认不管的三件事：
 * 1. **慢消费者**：`bufferedAmount` 超过 1 MiB 时先把待发帧放进有上限的发送队列（默认 32 MiB），
 *    通过轮询 `bufferedAmount` 排空；队列本身超限才 1013 关闭，避免一次几十片文件帧就断链；
 * 2. **关闭超时**：`close()` 后 5 秒没完成就 `terminate()`，避免半开连接长期占资源；
 * 3. **空闲判据**：任何 message/ping/pong 都刷新 `lastActivityAt`。
 */

const MAX_PAYLOAD_BYTES = 262_144
/** 高于该水位就不再直接 send，而是进入发送队列等消费者排空。 */
const MAX_BUFFERED_BYTES = 1_048_576
/** 发送队列上限：慢消费者持续不排空时按 1013 关闭，避免无限占用内存。 */
const MAX_QUEUED_BYTES = 32 * 1024 * 1024
/** 队列排空的轮询间隔（`ws` 没有 drain 事件，只能轮询 bufferedAmount）。 */
const DRAIN_POLL_MS = 20
const CLOSE_TIMEOUT_MS = 5_000

export interface WsConnection {
  readonly remoteAddress: string | null
  readonly lastActivityAt: number
  readonly closed: boolean
  send(text: string): void
  ping(): void
  close(code?: number, reason?: string): void
  onText(listener: (text: string) => void): void
  onClose(listener: (code: number, reason: string) => void): void
}

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return (req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}

/** 拒绝升级：写一个最小 HTTP 响应后关 socket（upgrade 失败没有 Fastify reply 可用）。 */
export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`
  try {
    socket.write(
      `HTTP/1.1 ${String(status)} ${statusText(status)}\r\n` +
        'connection: close\r\ncontent-type: text/plain; charset=utf-8\r\n' +
        `content-length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
    )
  } catch {
    // 对端已断开
  }
  socket.destroy()
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request'
    case 401:
      return 'Unauthorized'
    case 404:
      return 'Not Found'
    case 429:
      return 'Too Many Requests'
    case 503:
      return 'Service Unavailable'
    default:
      return 'Error'
  }
}

/** 单例 server：`noServer` 模式不监听端口，只负责解码交给我们的升级请求。 */
let wss: WebSocketServer | null = null

function server(): WebSocketServer {
  wss ??= new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  })
  return wss
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection {
  let connection: WsConnection | null = null
  server().handleUpgrade(req, socket, head, (webSocket) => {
    connection = wrap(webSocket, socket)
  })
  if (connection === null) throw new Error('ws upgrade callback 未同步触发')
  return connection
}

/** 关停：测试与进程退出用。 */
export function closeWebSocketServer(): Promise<void> {
  if (wss === null) return Promise.resolve()
  const current = wss
  wss = null
  return new Promise((resolve) => {
    current.close(() => resolve())
  })
}

/** 测试接缝：只依赖下面这组最小方法，便于注入「受控慢消费者」。 */
export interface WsLike {
  readyState: number
  bufferedAmount: number
  send(data: string, cb?: (error?: Error) => void): void
  ping(): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'ping' | 'pong', listener: () => void): unknown
}

export function wrapWebSocket(webSocket: WsLike, remoteAddress: string | null): WsConnection {
  const raw = { remoteAddress } as unknown as Duplex
  return wrap(webSocket as unknown as WebSocket, raw)
}

function wrap(webSocket: WebSocket, raw: Duplex): WsConnection {
  const textListeners: Array<(text: string) => void> = []
  const closeListeners: Array<(code: number, reason: string) => void> = []
  let lastActivityAt = Date.now()
  let closed = false
  // 慢消费者的待发帧：只有 bufferedAmount 高于水位时才入队，排空后按原顺序发出。
  const queue: Array<{ readonly text: string; readonly bytes: number }> = []
  let queuedBytes = 0
  let drainTimer: ReturnType<typeof setTimeout> | undefined

  const clearQueue = (): void => {
    queue.length = 0
    queuedBytes = 0
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer)
      drainTimer = undefined
    }
  }

  const markClosed = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    clearQueue()
    for (const listener of closeListeners) listener(code, reason)
  }

  webSocket.on('message', (data, isBinary) => {
    lastActivityAt = Date.now()
    if (isBinary) return
    const text = Buffer.from(data as unknown as Uint8Array).toString('utf8')
    for (const listener of textListeners) listener(text)
  })
  webSocket.on('ping', () => {
    lastActivityAt = Date.now()
  })
  webSocket.on('pong', () => {
    lastActivityAt = Date.now()
  })
  webSocket.on('close', (code, reason) => {
    markClosed(code, reason.toString('utf8'))
  })
  webSocket.on('error', () => {
    markClosed(1006, 'socket error')
  })

  const sendNow = (text: string): void => {
    webSocket.send(text, (error) => {
      if (error != null) {
        webSocket.terminate()
        markClosed(1011, 'send failed')
      }
    })
  }

  const drain = (): void => {
    drainTimer = undefined
    if (closed || webSocket.readyState !== WebSocket.OPEN) return
    while (queue.length > 0 && webSocket.bufferedAmount <= MAX_BUFFERED_BYTES) {
      const next = queue.shift()
      if (next === undefined) break
      queuedBytes -= next.bytes
      sendNow(next.text)
    }
    if (queue.length > 0) scheduleDrain()
  }

  const scheduleDrain = (): void => {
    if (drainTimer !== undefined || closed) return
    drainTimer = setTimeout(drain, DRAIN_POLL_MS)
    drainTimer.unref()
  }

  return {
    remoteAddress: socketAddress(raw),
    get lastActivityAt() {
      return lastActivityAt
    },
    get closed() {
      return closed
    },
    send(text: string) {
      if (closed || webSocket.readyState !== WebSocket.OPEN) return
      if (queue.length === 0 && webSocket.bufferedAmount <= MAX_BUFFERED_BYTES) {
        sendNow(text)
        return
      }
      const bytes = Buffer.byteLength(text)
      if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
        // 消费者持续不排空：队列本身也放不下，按「消息过大/无法处理」关闭
        this.close(1013, 'consumer too slow')
        return
      }
      queue.push({ text, bytes })
      queuedBytes += bytes
      scheduleDrain()
    },
    ping() {
      if (closed || webSocket.readyState !== WebSocket.OPEN) return
      try {
        webSocket.ping()
      } catch {
        // 已断开
      }
    },
    close(code = 1000, reason = '') {
      if (closed) return
      // 主动关闭：立刻对上层可见（不再收帧），底层 close/terminate 只做资源回收
      closed = true
      clearQueue()
      for (const listener of closeListeners) listener(code, reason)
      try {
        webSocket.close(code, reason)
      } catch {
        // ignore
      }
      const timer = setTimeout(() => {
        try {
          webSocket.terminate()
        } catch {
          // ignore
        }
      }, CLOSE_TIMEOUT_MS)
      timer.unref()
    },
    onText(listener) {
      textListeners.push(listener)
    },
    onClose(listener) {
      closeListeners.push(listener)
    },
  }
}

function socketAddress(socket: Duplex): string | null {
  const address = (socket as unknown as { remoteAddress?: unknown }).remoteAddress
  return typeof address === 'string' ? address : null
}
