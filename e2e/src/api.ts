import type { APIRequestContext, APIResponse } from 'playwright-core'

/**
 * 带会话的 HTTP 客户端：直接用浏览器上下文的 `request`，因此与页面共享 `hub_sid` cookie
 * （登录/注册走界面或接口都行，两者会话是同一份）。
 */
export interface ApiResult<T = unknown> {
  status: number
  ok: boolean
  body: T
  headers: Record<string, string>
  raw: Buffer
}

export class ApiClient {
  constructor(
    private readonly request: APIRequestContext,
    private readonly origin: string,
  ) {}

  url(path: string): string {
    return path.startsWith('http') ? path : `${this.origin}${path}`
  }

  private async parse(response: APIResponse): Promise<ApiResult> {
    const headers: Record<string, string> = response.headers()
    const raw = Buffer.from(await response.body())
    const contentType = headers['content-type'] ?? ''
    let body: unknown = null
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(raw.toString('utf8')) as unknown
      } catch {
        body = null
      }
    } else {
      body = raw.toString('utf8')
    }
    return { status: response.status(), ok: response.ok(), body, headers, raw }
  }

  async get<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    return (await this.parse(
      await this.request.get(this.url(path), {
        headers: options.headers,
        maxRedirects: options.maxRedirects,
        timeout: options.timeoutMs,
      }),
    )) as ApiResult<T>
  }

  /** 非 GET 一律 JSON 请求体（04 §0 的 CSRF 要求）；带 `Origin` 时等于 HUB_PUBLIC_ORIGIN，天然放行 */
  async post<T = unknown>(path: string, data?: unknown, headers?: Record<string, string>): Promise<ApiResult<T>> {
    return (await this.parse(
      await this.request.post(this.url(path), {
        data: data ?? {},
        headers: { 'content-type': 'application/json', ...headers },
      }),
    )) as ApiResult<T>
  }

  async patch<T = unknown>(path: string, data?: unknown): Promise<ApiResult<T>> {
    return (await this.parse(
      await this.request.patch(this.url(path), { data: data ?? {}, headers: { 'content-type': 'application/json' } }),
    )) as ApiResult<T>
  }

  async delete<T = unknown>(path: string): Promise<ApiResult<T>> {
    return (await this.parse(await this.request.delete(this.url(path)))) as ApiResult<T>
  }
}

export interface RequestOptions {
  headers?: Record<string, string>
  /** 0 = 不跟随重定向（验证 302 用） */
  maxRedirects?: number
  /** 毫秒；SSE 之类的长连接必须给超时，否则会挂住 */
  timeoutMs?: number
}

/** 从错误体里取错误码（失败信息里带上它，报告一眼能看出是契约还是实现问题） */
export function errorCodeOf(result: ApiResult): string | null {
  const body = result.body as { error?: { code?: string } } | null
  return body?.error?.code ?? null
}

export function describeApi(result: ApiResult): string {
  const code = errorCodeOf(result)
  return `HTTP ${String(result.status)}${code ? ` ${code}` : ''}：${result.raw.toString('utf8').slice(0, 300)}`
}
