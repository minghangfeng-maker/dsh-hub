import { WebSocket } from 'ws'
import type { WebSocketLike } from './types.js'

/**
 * WebSocket 客户端薄封装（MIT `ws`，显式运行依赖，随包声明）。
 *
 * 选择 `ws` 而不是手写 RFC 6455：需要自定义 `cookie`/`host` 头、分片累计上限、
 * UTF-8 与关闭码校验。桌面端打包时可以把 `ws` 一起 bundle，或作为普通 npm 依赖安装；
 * 「可移植」不等于「零依赖」。
 */
/**
 * Host→Hub 的 mux 单帧上限。
 *
 * `session/follow` 的 opening snapshot 会带整段 durable records；长会话（几十轮/工具卡+
 * 图片交付）动辄超过 1–2 MiB。原来是 256 KiB，超限时 ws 直接报
 * 「Max payload size exceeded」并 1006 断开 mux → history/usage 全部「无法取得会话游标」
 * （真机 2026-10-27 00:14 的「后端暂时不可用」就是它）。这里放宽到 64 MiB；
 * 帧只在真正收到时才占内存，不会预分配。
 */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

export async function connectWebSocket(
  url: string,
  headers: Record<string, string> = {},
): Promise<WebSocketLike> {
  const socket = new WebSocket(url, { headers, maxPayload: MAX_PAYLOAD_BYTES } as never)

  return await new Promise<WebSocketLike>((resolve, reject) => {
    const textListeners: Array<(text: string) => void> = []
    const closeListeners: Array<(code: number, reason: string) => void> = []
    const errorListeners: Array<(error: Error) => void> = []
    let closed = false

    const emitClose = (code: number, reason: string): void => {
      if (closed) return
      closed = true
      for (const listener of closeListeners) listener(code, reason)
    }

    const connection: WebSocketLike = {
      send(text: string) {
        if (closed || socket.readyState !== WebSocket.OPEN) return
        try {
          socket.send(text)
        } catch {
          // 交给 close/error 事件
        }
      },
      close(code = 1000, reason = '') {
        try {
          socket.close(code, reason)
        } catch {
          // ignore
        }
        const timer = setTimeout(() => {
          try {
            socket.terminate()
          } catch {
            // ignore
          }
          emitClose(code, reason)
        }, 5_000)
        timer.unref()
      },
      onText(listener) {
        textListeners.push(listener)
      },
      onClose(listener) {
        closeListeners.push(listener)
      },
      onError(listener) {
        errorListeners.push(listener)
      },
    }

    socket.on('open', () => resolve(connection))
    socket.on('message', (data: Uint8Array, isBinary: boolean) => {
      if (isBinary || closed) return
      const text = Buffer.from(data).toString('utf8')
      for (const listener of textListeners) listener(text)
    })
    socket.on('close', (code: number, reason: Buffer) => emitClose(code, reason.toString('utf8')))
    socket.on('error', (error: Error) => {
      for (const listener of errorListeners) listener(error)
      reject(error)
    })
  })
}
