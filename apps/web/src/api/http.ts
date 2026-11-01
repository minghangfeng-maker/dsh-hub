import { CSRF_HEADER, ErrorBodySchema, type ErrorCode } from '@dsh-hub/shared'
import type { ZodType } from 'zod'

import { defaultErrorMessage, describeError } from './errors'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[]

export interface RequestOptions<T> {
  method?: HttpMethod
  query?: Record<string, QueryValue>
  /** JSON 对象或 FormData（上传）；`undefined` 表示没有请求体（04 §8 第 10 条允许） */
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** 传入后对响应做 zod 校验（shared 里的契约 schema） */
  schema?: ZodType<T>
  /** 401 / MUST_CHANGE_PASSWORD 是否触发全局跳转，默认 true */
  authRedirect?: boolean
}

/**
 * **前端专用**错误码：请求根本没到服务器（断网、代理挡掉、连接被拒）。
 *
 * 04 §0.2 是后端契约，里面没有也不该有它——后端永远发不出这个码；
 * 前端用它把「网络问题」与「业务错误」在类型层面区分开，文案见 `api/errors.ts`。
 */
export const NETWORK_ERROR = 'NETWORK_ERROR'

/** 前端能见到的全部错误码：后端 04 §0.2 + 前端专用的 NETWORK_ERROR */
export type FrontendErrorCode = ErrorCode | typeof NETWORK_ERROR

/** 统一的接口错误（04 §0.2 的错误体；网络失败时 code 为 NETWORK_ERROR）。 */
export class HubApiError extends Error {
  readonly code: FrontendErrorCode
  readonly status: number
  readonly details: Record<string, unknown>

  constructor(
    code: FrontendErrorCode,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'HubApiError'
    this.code = code
    this.status = status
    this.details = details
  }

  /** 网络层失败（没拿到 HTTP 响应），与业务错误区分开 */
  get isNetworkError(): boolean {
    return this.code === NETWORK_ERROR || this.status === 0
  }
}

export function isHubApiError(error: unknown): error is HubApiError {
  return error instanceof HubApiError
}

// ── 认证失效的全局跳转（401 → /login?next=…；MUST_CHANGE_PASSWORD → /me/password） ──

export type AuthRedirectReason = 'unauthenticated' | 'must-change-password'

export interface AuthRedirectContext {
  reason: AuthRedirectReason
  /** 站内路径（含查询串），登录后回跳用；登录页自身或非法值时是 null */
  next: string | null
  error: HubApiError
}

export type AuthRedirectHandler = (context: AuthRedirectContext) => void

let authRedirectHandler: AuthRedirectHandler | null = null
let lastRedirect = { reason: '' as AuthRedirectReason | '', at: 0 }

/**
 * 注册全局跳转处理（router/index.ts 在创建路由时注册；测试可注入自己的实现）。
 * 传 null 恢复默认实现（直接改 `window.location`）。
 */
export function setAuthRedirectHandler(handler: AuthRedirectHandler | null): void {
  authRedirectHandler = handler
  lastRedirect = { reason: '', at: 0 }
}

/** 当前站内路径（登录页/根路径返回 null）：`/admin/users?page=2`。 */
export function currentInternalPath(): string | null {
  if (typeof window === 'undefined') return null
  const { pathname, search } = window.location
  if (!pathname || pathname === '/' || pathname.startsWith('/login')) return null
  return `${pathname}${search}`
}

function notifyAuthFailure(error: HubApiError): void {
  const reason: AuthRedirectReason =
    error.code === 'MUST_CHANGE_PASSWORD' ? 'must-change-password' : 'unauthenticated'

  const now = Date.now()
  // 同一原因 1s 内只跳一次：页面初始化会并发打好几个接口，避免互相打断
  if (lastRedirect.reason === reason && now - lastRedirect.at < 1000) return
  lastRedirect = { reason, at: now }

  const context: AuthRedirectContext = { reason, next: currentInternalPath(), error }

  if (authRedirectHandler) {
    authRedirectHandler(context)
    return
  }

  if (typeof window === 'undefined') return
  if (reason === 'must-change-password') {
    window.location.assign('/me/password')
    return
  }
  const target = context.next ? `/login?next=${encodeURIComponent(context.next)}` : '/login'
  if (window.location.pathname !== '/login') window.location.assign(target)
}

// ── URL 与请求体 ──

/** 拼接查询串（跳过 null/undefined/空串；数组用逗号连接，如 `?parts=a,b`）。 */
export function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue
    params.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }

  const search = params.toString()
  return search ? `${path}${path.includes('?') ? '&' : '?'}${search}` : path
}

/** 把 HTTP 状态兜底映射成错误码（响应体不是标准错误体时用）。 */
function codeFromStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 413) return 'PAYLOAD_TOO_LARGE'
  if (status === 415) return 'UNSUPPORTED_MEDIA'
  if (status === 429) return 'RATE_LIMITED'
  return 'INTERNAL'
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }

  try {
    return await response.text()
  } catch {
    return undefined
  }
}

function toApiError(response: Response, payload: unknown): HubApiError {
  const parsed = ErrorBodySchema.safeParse(payload)
  if (parsed.success) {
    const { code, message, details } = parsed.data.error
    return new HubApiError(code, message || defaultErrorMessage(code), response.status, details ?? {})
  }

  const code = codeFromStatus(response.status)
  return new HubApiError(code, defaultErrorMessage(code), response.status)
}

// ── 主入口 ──

/**
 * `fetch` 封装（07 §1）：
 * - 统一 JSON、非 GET 自动带 `X-Hub-Csrf: 1`（04 §0）；
 * - 错误响应 → {@link HubApiError}（错误码 + 中文文案 + details）；
 * - 401 `UNAUTHENTICATED` → 跳登录并带 `next`；`MUST_CHANGE_PASSWORD` → 跳 `/me/password`；
 * - 可用 `schema` 做响应体契约校验。
 */
export async function apiRequest<T = unknown>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', query, body, headers = {}, signal, schema, authRedirect = true } = options

  const url = withQuery(path, query)
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  const hasBody = body !== undefined && body !== null

  const finalHeaders: Record<string, string> = { Accept: 'application/json', ...headers }
  if (method !== 'GET') {
    finalHeaders[CSRF_HEADER] = '1'
    // 即使**没有请求体**也要声明 JSON：浏览器给 POST 会自动带 `Content-Length: 0`，
    // 后端的 CSRF 钩子看到 content-length 就认为「有请求体」，进而要求 application/json（04 §0），
    // 否则会 415 UNSUPPORTED_MEDIA（联调实测：登出、实例启停、任务操作等一大批空 body 接口全中招）。
    // 空 body + JSON content-type 由后端解析成 undefined（04 §8 第 10 条明确允许）。
    if (!isFormData && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json; charset=utf-8'
    }
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      credentials: 'same-origin',
      body: hasBody ? (isFormData ? (body as FormData) : JSON.stringify(body)) : undefined,
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new HubApiError(NETWORK_ERROR, '网络好像断开了，请稍后再试', 0, { network: true })
  }

  const payload = await readBody(response)

  if (!response.ok) {
    const apiError = toApiError(response, payload)
    if (authRedirect && (apiError.code === 'UNAUTHENTICATED' || apiError.code === 'MUST_CHANGE_PASSWORD')) {
      notifyAuthFailure(apiError)
    }
    throw apiError
  }

  if (!schema) return payload as T

  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new HubApiError('INTERNAL', '接口返回的数据不符合契约', response.status, {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    })
  }

  return parsed.data
}

/** 便捷方法（`http.get('/api/me')`）。 */
export const http = {
  get: <T = unknown>(path: string, options: Omit<RequestOptions<T>, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T = unknown>(path: string, options: Omit<RequestOptions<T>, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'POST' }),
  patch: <T = unknown>(path: string, options: Omit<RequestOptions<T>, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'PATCH' }),
  put: <T = unknown>(path: string, options: Omit<RequestOptions<T>, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'PUT' }),
  delete: <T = unknown>(path: string, options: Omit<RequestOptions<T>, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
}

/** 给界面用的最终文案（HTTP 错误也走同一套）。 */
export function toErrorMessage(error: unknown): string {
  return describeError(error).message
}
