import { isIP, type Socket } from 'node:net'

/**
 * PROXY protocol v1 解析（02 §5「真实 IP」）。
 *
 * 只有 7443 TLS 网关会用：公网入口的四层代理 的 `send-proxy` 会在每条连接最前面写一行
 * `PROXY TCP4 <src> <dst> <sport> <dport>\r\n`；反向隧道原样透传，所以本机看到的是客户端真实地址。
 * 头最长为 107 字节，3 秒内没读完就断开；头后面的剩余字节（通常与 TLS ClientHello 粘在同一个
 * chunk 里）必须 `unshift` 回流，否则 TLS 握手会缺一段。
 *
 * 只实现 v1：HAProxy 的 `send-proxy` 就是 v1；v2 是二进制格式，本方案用不到（也不接受）。
 */

/** v1 头的最大长度（含 `\r\n`） */
export const PROXY_V1_MAX_BYTES = 107
/** 等头的超时（任务书：3 秒） */
export const PROXY_V1_TIMEOUT_MS = 3_000

const CRLF = Buffer.from('\r\n')
const PREFIX = 'PROXY '

export type ProxyFamily = 'TCP4' | 'TCP6' | 'UNKNOWN'

export interface ProxyV1Header {
  family: ProxyFamily
  /** TCP4/TCP6 是头里的源地址；UNKNOWN 为 null */
  sourceAddress: string | null
  sourcePort: number | null
  destinationAddress: string | null
  destinationPort: number | null
  /** 原始行（不含 CRLF），只用于日志 */
  raw: string
}

export type ProxyProtocolFailure = 'malformed' | 'too-long' | 'timeout' | 'closed'

export class ProxyProtocolError extends Error {
  readonly reason: ProxyProtocolFailure

  constructor(reason: ProxyProtocolFailure, message?: string) {
    super(message ?? `PROXY protocol 解析失败：${reason}`)
    this.name = 'ProxyProtocolError'
    this.reason = reason
  }
}

/**
 * 解析一整行（不含 `\r\n`）。纯函数，方便单测逐条覆盖。
 * `PROXY UNKNOWN` 后面允许跟任意内容（RFC 规定接收方忽略到 CRLF 为止）。
 */
export function parseProxyV1Line(line: string): ProxyV1Header {
  if (!line.startsWith(PREFIX)) throw new ProxyProtocolError('malformed', '不是 PROXY 头')
  const tokens = line.slice(PREFIX.length).split(' ')
  const family = tokens[0]
  if (family === 'UNKNOWN') {
    return {
      family: 'UNKNOWN',
      sourceAddress: null,
      sourcePort: null,
      destinationAddress: null,
      destinationPort: null,
      raw: line,
    }
  }
  if (family !== 'TCP4' && family !== 'TCP6') {
    throw new ProxyProtocolError('malformed', `不支持的协议族：${family ?? ''}`)
  }
  if (tokens.length !== 5) throw new ProxyProtocolError('malformed', 'PROXY v1 头字段数量不对')
  const [, source, destination, sourcePort, destinationPort] = tokens as [
    string,
    string,
    string,
    string,
    string,
  ]
  const expected = family === 'TCP4' ? 4 : 6
  if (isIP(source) !== expected) throw new ProxyProtocolError('malformed', `源地址不是 IPv${expected}`)
  if (isIP(destination) !== expected) {
    throw new ProxyProtocolError('malformed', `目标地址不是 IPv${expected}`)
  }
  return {
    family,
    sourceAddress: source,
    sourcePort: parsePort(sourcePort),
    destinationAddress: destination,
    destinationPort: parsePort(destinationPort),
    raw: line,
  }
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new ProxyProtocolError('malformed', `端口不合法：${value}`)
  const port = Number(value)
  if (port > 65_535) throw new ProxyProtocolError('malformed', `端口超范围：${value}`)
  return port
}

export interface ReadProxyHeaderOptions {
  timeoutMs?: number
  maxBytes?: number
}

/**
 * 从连接最前面读一行 v1 头；成功后已把剩余字节 `unshift` 回 socket，调用方可以直接
 * 交给 https server（`emit('connection', socket)`）。
 *
 * 失败一律抛 `ProxyProtocolError`：`malformed`（不是 PROXY 头/字段非法）、`too-long`
 * （107 字节内没有 CRLF）、`timeout`、`closed`（连接先断了）。
 */
export function readProxyV1Header(
  socket: Socket,
  options: ReadProxyHeaderOptions = {},
): Promise<ProxyV1Header> {
  const timeoutMs = options.timeoutMs ?? PROXY_V1_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? PROXY_V1_MAX_BYTES
  return new Promise<ProxyV1Header>((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0)
    let settled = false

    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      clearTimeout(timer)
    }
    const fail = (error: ProxyProtocolError): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(CRLF)
      if (end === -1) {
        // 还没见到 CRLF：只有超过 107 字节才判超长（头与 TLS 首包粘在一起时 end 一定存在）
        if (buffer.length > maxBytes) fail(new ProxyProtocolError('too-long'))
        return
      }
      if (end + 2 > maxBytes) {
        fail(new ProxyProtocolError('too-long'))
        return
      }
      let header: ProxyV1Header
      try {
        header = parseProxyV1Line(buffer.subarray(0, end).toString('latin1'))
      } catch (error) {
        fail(error instanceof ProxyProtocolError ? error : new ProxyProtocolError('malformed', String(error)))
        return
      }
      if (settled) return
      settled = true
      cleanup()
      // 先停下再回灌：调用方（TLS 或跳转处理）重新 attach 监听并 resume 就能读到这些字节
      socket.pause()
      const rest = buffer.subarray(end + 2)
      if (rest.length > 0) socket.unshift(rest)
      resolve(header)
    }
    const onError = (error: Error): void => {
      fail(new ProxyProtocolError('closed', error.message))
    }
    const onClose = (): void => {
      fail(new ProxyProtocolError('closed', '连接在 PROXY 头读完前关闭'))
    }
    const timer = setTimeout(() => {
      fail(new ProxyProtocolError('timeout'))
    }, timeoutMs)
    timer.unref?.()

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}
