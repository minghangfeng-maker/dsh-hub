import { ERROR_CODES, LoginResponseSchema } from '@dsh-hub/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HubApiError,
  NETWORK_ERROR,
  apiRequest,
  currentInternalPath,
  http,
  setAuthRedirectHandler,
  withQuery,
  type AuthRedirectContext,
} from '@/api/http'

/** 造一个 fetch 响应（jsdom 里没有 fetch，这里直接用 Node 的 Response）。 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse({ error: { code, message, ...(details ? { details } : {}) } }, status)
}

/** fetch 的 header 名大小写不敏感，这里用不敏感的方式取值 */
function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = (init.headers ?? {}) as Record<string, string>
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  setAuthRedirectHandler(null)
  vi.unstubAllGlobals()
})

describe('withQuery（04 §0 分页/筛选参数）', () => {
  it('拼接字符串、数字、布尔与数组，跳过空值', () => {
    expect(withQuery('/api/admin/users', { page: 1, pageSize: 20, q: '', status: undefined })).toBe(
      '/api/admin/users?page=1&pageSize=20',
    )
    expect(withQuery('/api/admin/users', { instance: 'running', role: null })).toBe(
      '/api/admin/users?instance=running',
    )
    expect(withQuery('/api/me/exports/estimate', { parts: ['workspace', 'sessions'] })).toBe(
      '/api/me/exports/estimate?parts=workspace%2Csessions',
    )
    expect(withQuery('/api/x', undefined)).toBe('/api/x')
  })
})

describe('apiRequest：请求构造（04 §0 CSRF 约定）', () => {
  it('GET 不带 CSRF 头；POST 带 X-Hub-Csrf 与 JSON content-type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await http.get('/api/public/site')

    const [getUrl, getInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(getUrl).toBe('/api/public/site')
    expect(getInit.method).toBe('GET')
    expect(headerOf(getInit, 'X-Hub-Csrf')).toBeUndefined()

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await http.post('/api/auth/login', { body: { username: 'mint', password: 'secret' } })

    const [, postInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(postInit.method).toBe('POST')
    expect(headerOf(postInit, 'X-Hub-Csrf')).toBe('1')
    expect(headerOf(postInit, 'Content-Type')).toContain('application/json')
    expect(postInit.body).toBe(JSON.stringify({ username: 'mint', password: 'secret' }))
    expect(postInit.credentials).toBe('same-origin')
  })

  it('没有请求体时不发 body，但**仍带 JSON content-type**（04 §8 第 10 条 + 后端 CSRF 钩子）', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await http.post('/api/me/instance/start')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBeUndefined()
    // 浏览器给 POST 会自动带 Content-Length: 0，后端据此要求 application/json；
    // 不带这个头会 415（联调实测：登出等空 body 接口全中招）
    expect(headerOf(init, 'Content-Type')).toContain('application/json')
    expect(headerOf(init, 'X-Hub-Csrf')).toBe('1')
  })

  it('DELETE 空 body 也带 JSON content-type（04 §3 的设备下线/删除导出）', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await http.delete('/api/me/sessions/abc')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBeUndefined()
    expect(headerOf(init, 'Content-Type')).toContain('application/json')
  })

  it('FormData 上传不设置 content-type（交给浏览器带 boundary），仍带 CSRF 头', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const form = new FormData()
    form.append('file', new Blob(['x']), 'a.png')
    await http.post('/api/me/avatar', { body: form })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(headerOf(init, 'Content-Type')).toBeUndefined()
    expect(headerOf(init, 'X-Hub-Csrf')).toBe('1')
    expect(init.body).toBe(form)
  })

  it('204 返回 undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(apiRequest('/api/me/sessions/abc', { method: 'DELETE' })).resolves.toBeUndefined()
  })
})

describe('apiRequest：错误映射（04 §0.2）', () => {
  it('标准错误体 → HubApiError（code/message/details/status）', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse('ACCOUNT_LOCKED', '账号被临时锁定，请稍后再试', 423, { retryAfterSec: 900 }),
    )

    const error = await apiRequest('/api/auth/login', { method: 'POST' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HubApiError)
    const apiError = error as HubApiError
    expect(apiError.code).toBe('ACCOUNT_LOCKED')
    expect(apiError.status).toBe(423)
    expect(apiError.message).toContain('锁定')
    expect(apiError.details['retryAfterSec']).toBe(900)
  })

  it('非标准错误体（如反代返回 HTML）按 HTTP 状态兜底映射', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }))
    const error = (await apiRequest('/api/admin/overview').catch((e: unknown) => e)) as HubApiError

    expect(error.code).toBe('INTERNAL')
    expect(error.status).toBe(502)
    expect(error.message).toBe('服务器内部错误')
  })

  it('网络失败 → 前端专用 NETWORK_ERROR（不进后端 04 §0.2 错误表）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const error = (await apiRequest('/api/health').catch((e: unknown) => e)) as HubApiError

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.code).toBe(NETWORK_ERROR)
    expect(error.isNetworkError).toBe(true)
    expect(error.status).toBe(0)
    expect(error.message).toBe('网络好像断开了，请稍后再试')
  })

  it('后端不会发出 NETWORK_ERROR（04 §0.2 里没有它）', () => {
    expect(ERROR_CODES).not.toContain('NETWORK_ERROR')
  })

  it('响应体不符合契约 schema 时报错，不把脏数据交给页面', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: { id: 'not-a-number' } }))
    const error = (await http
      .post('/api/auth/login', { body: {}, schema: LoginResponseSchema })
      .catch((e: unknown) => e)) as HubApiError

    expect(error.code).toBe('INTERNAL')
    expect(error.message).toContain('契约')
  })
})

describe('apiRequest：401 / MUST_CHANGE_PASSWORD 全局跳转（07 §1）', () => {
  it('UNAUTHENTICATED → 通知处理者，并带站内 next', async () => {
    window.history.pushState({}, '', '/admin/users?page=2')
    expect(currentInternalPath()).toBe('/admin/users?page=2')

    const contexts: AuthRedirectContext[] = []
    setAuthRedirectHandler((context) => contexts.push(context))

    fetchMock.mockResolvedValueOnce(errorResponse('UNAUTHENTICATED', '请先登录', 401))
    await apiRequest('/api/admin/users').catch(() => undefined)

    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.reason).toBe('unauthenticated')
    expect(contexts[0]?.next).toBe('/admin/users?page=2')
  })

  it('MUST_CHANGE_PASSWORD → 通知处理者（reason 区分开）', async () => {
    const contexts: AuthRedirectContext[] = []
    setAuthRedirectHandler((context) => contexts.push(context))

    fetchMock.mockResolvedValueOnce(errorResponse('MUST_CHANGE_PASSWORD', '请先修改初始密码', 403))
    await apiRequest('/api/me/instance').catch(() => undefined)

    expect(contexts[0]?.reason).toBe('must-change-password')
  })

  it('INVALID_CREDENTIALS（401）不触发跳转：登录页要就地报错', async () => {
    const handler = vi.fn()
    setAuthRedirectHandler(handler)

    fetchMock.mockResolvedValueOnce(errorResponse('INVALID_CREDENTIALS', '用户名或密码错误', 401))
    await http.post('/api/auth/login', { body: {} }).catch(() => undefined)

    expect(handler).not.toHaveBeenCalled()
  })

  it('登录页自身不作为 next（避免回跳登录页绕圈）', async () => {
    window.history.pushState({}, '', '/login')
    expect(currentInternalPath()).toBeNull()

    const contexts: AuthRedirectContext[] = []
    setAuthRedirectHandler((context) => contexts.push(context))
    fetchMock.mockResolvedValueOnce(errorResponse('UNAUTHENTICATED', '请先登录', 401))
    await apiRequest('/api/auth/me', { authRedirect: true }).catch(() => undefined)

    expect(contexts[0]?.next).toBeNull()
  })

  it('authRedirect: false 的请求不触发跳转（守卫探测登录态时用）', async () => {
    const handler = vi.fn()
    setAuthRedirectHandler(handler)

    fetchMock.mockResolvedValueOnce(errorResponse('UNAUTHENTICATED', '请先登录', 401))
    await apiRequest('/api/auth/me', { authRedirect: false }).catch(() => undefined)

    expect(handler).not.toHaveBeenCalled()
  })

  it('同一原因 1s 内只跳一次（并发请求不会互相打断）', async () => {
    const handler = vi.fn()
    setAuthRedirectHandler(handler)

    fetchMock
      .mockResolvedValueOnce(errorResponse('UNAUTHENTICATED', '请先登录', 401))
      .mockResolvedValueOnce(errorResponse('UNAUTHENTICATED', '请先登录', 401))

    await Promise.all([
      apiRequest('/api/me/instance').catch(() => undefined),
      apiRequest('/api/me/exports').catch(() => undefined),
    ])

    expect(handler).toHaveBeenCalledTimes(1)
  })
})
