import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

/**
 * 测试用「经 TLS 网关的客户端」：先建立 TCP 连接并写 PROXY v1 头（可选），再做 TLS 握手，
 * 然后手工收发原始 HTTP —— 这样才能断言 PROXY 头缺失时的断开、SSE 首帧时刻、WS 101 等细节。
 */

export interface TlsClientOptions {
  port: number
  /** PROXY v1 头（不含 CRLF 也会自动补）；`null` = 不发（用于「缺 PROXY 头 → 断开」用例） */
  proxy?: string | null
  servername?: string
  /** 等 TLS 握手完成的超时 */
  timeoutMs?: number
}

export interface TlsClient {
  socket: TLSSocket
  /** 已收到的原始字节（utf8） */
  text(): string
  /** 第一段数据距 open 的毫秒数；还没收到数据是 null */
  firstDataMs(): number | null
  /** 等 predicate 成立；超时抛错 */
  waitFor(predicate: (text: string) => boolean, timeoutMs?: number): Promise<void>
  /** 等连接关闭（`Connection: close` 的响应收全） */
  waitForClose(timeoutMs?: number): Promise<void>
  write(data: string): void
  end(): void
  close(): void
}

export function openTlsClient(options: TlsClientOptions): Promise<TlsClient> {
  const timeoutMs = options.timeoutMs ?? 5_000
  return new Promise<TlsClient>((resolve, reject) => {
    const started = Date.now()
    let raw: Socket | null = null
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      raw?.destroy()
      reject(error)
    }
    raw = netConnect(options.port, '127.0.0.1', () => {
      if (options.proxy) raw?.write(`${options.proxy}\r\n`)
      const socket = tlsConnect(
        {
          socket: raw as Socket,
          servername: options.servername ?? 'localhost',
          rejectUnauthorized: false,
        },
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(makeClient(socket, started))
        },
      )
      socket.on('error', (error: Error) => {
        fail(error)
      })
    })
    raw.on('error', (error: Error) => {
      fail(error)
    })
    const timer = setTimeout(() => {
      fail(new Error('TLS 握手超时'))
    }, timeoutMs)
    timer.unref?.()
  })
}

function makeClient(socket: TLSSocket, started: number): TlsClient {
  let received = ''
  let firstDataMs: number | null = null
  let closed = false
  const closeWaiters: (() => void)[] = []
  const waiters: { predicate: (text: string) => boolean; resolve: () => void }[] = []
  socket.setEncoding('utf8')
  socket.on('close', () => {
    closed = true
    for (const resolve of closeWaiters.splice(0)) resolve()
  })
  socket.on('data', (chunk: string | Buffer) => {
    if (firstDataMs === null) firstDataMs = Date.now() - started
    received += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (const waiter of [...waiters]) {
      if (waiter.predicate(received)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  })
  return {
    socket,
    text: () => received,
    firstDataMs: () => firstDataMs,
    waitFor(predicate, timeout = 5_000) {
      if (predicate(received)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`等待响应超时；已收到：${JSON.stringify(received.slice(0, 200))}`))
        }, timeout)
        timer.unref?.()
        waiters.push({
          predicate,
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
        })
      })
    },
    waitForClose(timeout = 5_000) {
      if (closed) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`等待连接关闭超时；已收到：${JSON.stringify(received.slice(0, 200))}`))
        }, timeout)
        timer.unref?.()
        closeWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    write(data: string) {
      socket.write(data)
    },
    end() {
      socket.end()
    },
    close() {
      socket.destroy()
    },
  }
}

export interface ParsedHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** 解析一个已经收全的响应（`Connection: close` 的响应文） */
export function parseHttpResponse(text: string): ParsedHttpResponse {
  const headerEnd = text.indexOf('\r\n\r\n')
  if (headerEnd === -1) throw new Error(`响应头不完整：${JSON.stringify(text.slice(0, 120))}`)
  const lines = text.slice(0, headerEnd).split('\r\n')
  const statusLine = lines[0] ?? ''
  const match = /^HTTP\/1\.[01] (\d{3})/u.exec(statusLine)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  const rawBody = text.slice(headerEnd + 4)
  const body = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')
    ? decodeChunked(rawBody)
    : rawBody
  return { status: match ? Number(match[1]) : 0, headers, body }
}

/** 上游没给 Content-Length 时 Node 会用 chunked，手工解一下 */
function decodeChunked(raw: string): string {
  let rest = raw
  let out = ''
  for (;;) {
    const lineEnd = rest.indexOf('\r\n')
    if (lineEnd === -1) break
    const size = Number.parseInt(rest.slice(0, lineEnd).split(';')[0]?.trim() ?? '', 16)
    if (!Number.isFinite(size) || size <= 0) break
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size)
    rest = rest.slice(lineEnd + 2 + size + 2)
  }
  return out
}

/** 发一个请求并等响应收全（`stopAfter` 给定时等到条件成立即可），返回解析后的响应 */
export async function tlsExchange(
  options: TlsClientOptions & { request: string; stopAfter?: (text: string) => boolean; timeoutMs?: number },
): Promise<{ client: TlsClient; response: ParsedHttpResponse; raw: string; firstDataMs: number | null }> {
  const client = await openTlsClient(options)
  client.write(options.request)
  try {
    const timeout = options.timeoutMs ?? 5_000
    if (options.stopAfter) await client.waitFor(options.stopAfter, timeout)
    else await client.waitForClose(timeout)
  } catch (error) {
    client.close()
    throw error
  }
  const raw = client.text()
  return { client, response: parseHttpResponse(raw), raw, firstDataMs: client.firstDataMs() }
}
