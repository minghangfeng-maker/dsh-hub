import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Host 返回的结构化 RPC 失败（`result.ok === false`）。 */
export class HostRpcError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HostRpcError'
    this.code = code
    this.details = details
  }
}

/** 传输层失败：连不上、超时、非 JSON、非 2xx。 */
export class HostTransportError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'HostTransportError'
    this.status = status
  }
}

export interface HostHttpOptions {
  origin: string
  headers: () => Promise<Record<string, string>> | Record<string, string>
  fetch?: typeof fetch
  timeoutMs: number
  log?: (event: string, meta?: Record<string, unknown>) => void
}

export interface UnaryEnvelope {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

/**
 * DSH Host 的 HTTP unary 通道。
 *
 * 真实形状（`@deepseek-ai/dsh-client-connection`）：`POST /api/<endpoint>`，
 * body 是 `{type:'client-request',rpcId,method,payload}`，响应是
 * `{type:'server-response',rpcId,result:{ok,value}|{ok:false,error}}`。
 */
export class HostHttp {
  private readonly options: HostHttpOptions
  private readonly base: URL

  constructor(options: HostHttpOptions) {
    this.options = options
    this.base = new URL(options.origin)
  }

  /** 成功返回 value；失败抛 `HostRpcError`（业务）或 `HostTransportError`（传输）。 */
  async unary(endpoint: string, payload: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    const envelope = await this.call(endpoint, payload, timeoutMs)
    if (!envelope.ok) {
      const error = envelope.error ?? { code: 'internal', message: 'Host 未给出错误详情' }
      throw new HostRpcError(error.code, error.message, error.details ?? {})
    }
    return envelope.value
  }

  /**
   * 与 `call()` 相同，但**不解析**响应体。
   *
   * 为什么需要：`workspaceFiles/readBytes` 的响应是 `multipart/form-data`（字节在
   * `bytes-0` 部分），`JSON.parse` 整包会直接失败。调用方拿 content-type 自己解析。
   */
  async callRaw(
    endpoint: string,
    payload: unknown,
    timeoutMs = this.options.timeoutMs,
  ): Promise<{ status: number; contentType: string; body: Buffer }> {
    const body = this.envelopeOf(endpoint, payload)
    const headers = { ...(await this.options.headers()), 'content-type': 'application/json' }
    return await this.postRaw(`/api/${endpoint}`, Buffer.from(body, 'utf8'), headers, timeoutMs)
  }

  /**
   * 原始字节 POST（非 JSON 信封）。
   *
   * 用途：`POST /api/session/uploadFileBinary?sessionId=…&name=…`（`application/octet-stream`），
   * 它不认 client-request 信封，也**不是** `/api/<endpoint>` 形态。
   */
  async postRaw(
    path: string,
    body: Buffer,
    headers: Record<string, string>,
    timeoutMs = this.options.timeoutMs,
  ): Promise<{ status: number; contentType: string; body: Buffer }> {
    if (this.options.fetch !== undefined) {
      const response = await this.options.fetch(new URL(path, this.base), {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: Buffer.from(await response.arrayBuffer()),
      }
    }
    const secure = this.base.protocol === 'https:'
    const requestFn = secure ? httpsRequest : httpRequest
    return await new Promise((resolve, reject) => {
      const req = requestFn(
        {
          protocol: secure ? 'https:' : 'http:',
          hostname: this.base.hostname,
          port: this.base.port === '' ? (secure ? 443 : 80) : Number(this.base.port),
          path,
          method: 'POST',
          headers: { ...headers, 'content-length': String(body.length) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              contentType: res.headers['content-type'] ?? '',
              body: Buffer.concat(chunks),
            })
          })
        },
      )
      req.on('timeout', () => {
        req.destroy(new HostTransportError('Host 请求超时'))
      })
      req.on('error', (error) => {
        reject(error instanceof HostTransportError ? error : new HostTransportError(error.message))
      })
      req.end(body)
    })
  }

  /** 发信封并解析 unary 响应；失败也返回信封（探测依赖「错误码」而不是异常）。 */
  async call(endpoint: string, payload: unknown, timeoutMs = this.options.timeoutMs): Promise<UnaryEnvelope> {
    const body = this.envelopeOf(endpoint, payload)
    const headers = { ...(await this.options.headers()), 'content-type': 'application/json' }
    const text = await this.post(`/api/${endpoint}`, body, headers, timeoutMs)
    return parseUnaryEnvelope(text)
  }

  /** 组装 client-request 信封（`call`/`callRaw` 共用，避免两处漂移）。 */
  private envelopeOf(endpoint: string, payload: unknown): string {
    if (
      endpoint === '' ||
      endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new HostTransportError(`非法端点：${endpoint}`)
    }
    // 真实 Host 要求：payload 必须恰好是 `{args}`（gateway `remoteRequest` 校验）。
    // `args` 里放 named 参数（`request` / `_request` / `agent,callId,answer` …）。
    // 例外：`$events/result` 的唯一 named 参数就叫 `args`，调用方已按 `{args:…}` 传入时原样透传，
    // 避免变成 `{args:{args:…}}`。
    const alreadyEnvelope =
      typeof payload === 'object' &&
      payload !== null &&
      Object.keys(payload).length === 1 &&
      'args' in payload
    const envPayload = alreadyEnvelope ? payload : { args: payload }
    return JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: envPayload,
    })
  }

  private async post(
    path: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<string> {
    if (this.options.fetch !== undefined) {
      const response = await this.options.fetch(new URL(path, this.base), {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new HostTransportError(`Host 返回 HTTP ${response.status}`, response.status)
      return await response.text()
    }
    const secure = this.base.protocol === 'https:'
    const requestFn = secure ? httpsRequest : httpRequest
    return await new Promise<string>((resolve, reject) => {
      const req = requestFn(
        {
          protocol: secure ? 'https:' : 'http:',
          hostname: this.base.hostname,
          port: this.base.port === '' ? (secure ? 443 : 80) : Number(this.base.port),
          path,
          method: 'POST',
          headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              reject(new HostTransportError(`Host 返回 HTTP ${status}`, status))
              return
            }
            resolve(text)
          })
        },
      )
      req.on('timeout', () => {
        req.destroy(new HostTransportError('Host 请求超时'))
      })
      req.on('error', (error) => {
        reject(error instanceof HostTransportError ? error : new HostTransportError(error.message))
      })
      req.end(body)
    })
  }
}

/** 解析 `{type:'server-response',result:{ok,value|error}}` 信封。 */
export function parseUnaryEnvelope(text: string): UnaryEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HostTransportError('Host 返回的不是 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new HostTransportError('Host 响应结构不合法')
  const record = parsed as Record<string, unknown>
  if (record['type'] !== 'server-response') throw new HostTransportError('Host 响应缺少 server-response 信封')
  const result = record['result']
  if (typeof result !== 'object' || result === null) throw new HostTransportError('Host 响应缺少 result')
  const resultRecord = result as Record<string, unknown>
  if (resultRecord['ok'] === true) return { ok: true, value: resultRecord['value'] }
  const error = resultRecord['error']
  if (typeof error === 'object' && error !== null) {
    const errorRecord = error as Record<string, unknown>
    return {
      ok: false,
      error: {
        code: typeof errorRecord['code'] === 'string' ? errorRecord['code'] : 'internal',
        message: typeof errorRecord['message'] === 'string' ? errorRecord['message'] : '未知错误',
        details:
          typeof errorRecord['details'] === 'object' && errorRecord['details'] !== null
            ? (errorRecord['details'] as Record<string, unknown>)
            : {},
      },
    }
  }
  return { ok: false, error: { code: 'internal', message: 'Host 返回了无错误详情的失败' } }
}
