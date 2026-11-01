import type { FastifyReply } from 'fastify'
import { SSE_PING_INTERVAL_MS } from '@dsh-hub/shared'

export interface SseStream {
  /** 发一个命名事件：`event: <name>\ndata: <json>\n\n` */
  send(event: string, data: unknown): void
  /** 发注释行（心跳用 `: ping`） */
  comment(text: string): void
  close(): void
  readonly closed: boolean
}

export interface OpenSseOptions {
  /** 心跳间隔，默认 20s（04 §0）；测试可调小 */
  pingMs?: number
  /** 额外响应头（例如 `X-Accel-Buffering: no` 已在默认里） */
  headers?: Record<string, string>
}

/**
 * 打开一个 SSE 流：接管 reply，按 04 §0 的格式写事件，20 秒一个 `: ping`，
 * 客户端断开（`close`）时自动清理定时器与订阅。
 */
export function openSse(reply: FastifyReply, opts: OpenSseOptions = {}): SseStream {
  const pingMs = opts.pingMs ?? SSE_PING_INTERVAL_MS
  const raw = reply.raw
  let closed = false
  const cleanups: (() => void)[] = []

  reply.hijack()
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    // 反向代理（WP7b 的 TLS 网关）不要缓冲
    'x-accel-buffering': 'no',
    ...opts.headers,
  })
  // 立刻冲刷响应头，让浏览器/代理知道流已建立
  raw.flushHeaders?.()
  raw.write(': connected\n\n')

  const timer = setInterval(() => {
    if (!closed) raw.write(': ping\n\n')
  }, pingMs)
  timer.unref?.()

  const onClose = () => {
    close()
  }
  raw.on('close', onClose)
  raw.on('error', onClose)

  function cleanup(): void {
    for (const fn of cleanups.splice(0)) fn()
    clearInterval(timer)
    raw.off('close', onClose)
    raw.off('error', onClose)
  }

  function close(): void {
    if (closed) return
    closed = true
    cleanup()
    try {
      raw.end()
    } catch {
      // 已经断开
    }
  }

  return {
    send(event, data) {
      if (closed) return
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    comment(text) {
      if (closed) return
      raw.write(`: ${text}\n\n`)
    },
    close,
    get closed() {
      return closed
    },
  }
}

/** 给 SSE 流挂一个总线订阅，流关闭时自动退订（`openSse` 之后的常规用法） */
export function pipeEvents(stream: SseStream, subscribe: (emit: SseStream['send']) => () => void): void {
  const off = subscribe((event, data) => stream.send(event, data))
  // 流关闭后由 openSse 的 raw close 事件触发，这里用轮询兜底一次
  const timer = setInterval(() => {
    if (stream.closed) {
      clearInterval(timer)
      off()
    }
  }, 1000)
  timer.unref?.()
}
