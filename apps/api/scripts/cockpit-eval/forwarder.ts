/**
 * 真模型模式的**本机反代转发器**（`--upstream-url`）。
 *
 * 为什么需要它：座舱容器访问不到宿主的 `127.0.0.1:8788`，而真模型反代只监听回环。
 * 这层转发器绑 `0.0.0.0:<port>`（容器经网关 IP 访问），把请求原样转给
 * `http://127.0.0.1:8788/v1`，并**只在请求头里**补上 `Authorization: Bearer <key>`。
 *
 * 密钥纪律（任务书硬要求）：key 只从环境变量 `COCKPIT_EVAL_UPSTREAM_KEY` 来，
 * 只存在内存里；不打印、不落盘、不进报告。响应体（含 SSE）原样流式回传。
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface UpstreamForwarderOptions {
  /** 监听端口（绑 0.0.0.0，容器才能经网关访问到） */
  port: number
  /** 真模型反代地址，例如 `http://127.0.0.1:8788/v1` */
  upstreamUrl: string
  /** 上游密钥（可空：有些本机反代不要 key） */
  apiKey?: string
  /** 监听地址（默认 0.0.0.0） */
  host?: string
}

export interface ForwarderHandle {
  readonly port: number
  /** 转发过多少请求（报告里只说次数） */
  count(): number
  close(): Promise<void>
}

/** 路径前缀（`/v1`）从 upstreamUrl 里拆出来，容器请求的 `/v1/...` 原样接上 */
function splitUpstream(upstreamUrl: string): { origin: URL; prefix: string } {
  const parsed = new URL(upstreamUrl)
  const prefix = parsed.pathname.replace(/\/+$/u, '')
  return { origin: parsed, prefix }
}

export async function startUpstreamForwarder(options: UpstreamForwarderOptions): Promise<ForwarderHandle> {
  const { origin, prefix } = splitUpstream(options.upstreamUrl)
  let count = 0
  const server = createServer((req, res) => {
    count += 1
    forward(req, res)
  })

  function forward(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? '/'
    // 容器请求 `/v1/chat/completions`，上游地址已带 `/v1` → 去掉重复的那一段
    const suffix = prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path
    const target = new URL(`${prefix}${suffix.startsWith('/') ? suffix : `/${suffix}`}`, origin)
    const headers: Record<string, string | string[]> = { ...req.headers, host: target.host }
    if (options.apiKey !== undefined && options.apiKey !== '') {
      headers.authorization = `Bearer ${options.apiKey}`
    }
    const client = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstreamReq = client(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: req.method ?? 'POST',
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
        upstreamRes.on('end', () => res.end())
      },
    )
    upstreamReq.on('error', (error: Error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: `转发到真模型上游失败：${error.message}` } }))
    })
    req.pipe(upstreamReq)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  return {
    port,
    count: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
