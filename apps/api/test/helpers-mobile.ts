import type { FastifyInstance } from 'fastify'
import type {
  MobileAppPlatform,
  MobileAuthTokens,
  MobileBootstrapResponse,
  MobileTicketResponse,
} from '@dsh-hub/shared'
import { json, type TestUser } from './helpers.js'

/**
 * 手机 App 测试脚手架（WP40a）。
 *
 * 一律带 `Origin: https://localhost`（Capacitor Android 的真实来源），这样同时验证了
 * 「App 来源能过 Origin/CSRF 校验」与「CORS 头在响应里」。
 * 默认 `remoteAddress` 用回环地址：按 IP 的登录限流对回环豁免（与网页登录同一口径），
 * 要测限流的用例显式传 `ip`。
 */

export const MOBILE_APP_ORIGIN = 'https://localhost'
export const MOBILE_IOS_ORIGIN = 'capacitor://localhost'
/** 不在白名单里的来源（测「豁免只对 Bearer 生效」） */
export const EVIL_ORIGIN = 'https://evil.example'

export interface MobileLoginOptions {
  deviceName?: string
  /** WP54a：'web' = Hub 同源托管的手机网页版（与 android/ios 是不同平台） */
  platform?: MobileAppPlatform
  /** 0.2.9：App 本地持久化的安装标识（同设备复用台账） */
  installId?: string
  password?: string
  ip?: string
  /** 覆盖/补充请求头（例如显式给一个恶意 Origin） */
  headers?: Record<string, string>
  origin?: string
}

export interface MobileLoginResult {
  status: number
  body: Record<string, unknown>
  tokens: MobileAuthTokens | null
  errorCode: string | undefined
  headers: Record<string, unknown>
}

/** `POST /api/mobile/auth/login` */
export async function mobileLogin(
  app: FastifyInstance,
  user: Pick<TestUser, 'username' | 'password'>,
  opts: MobileLoginOptions = {},
): Promise<MobileLoginResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/mobile/auth/login',
    headers: {
      'content-type': 'application/json',
      origin: opts.origin ?? MOBILE_APP_ORIGIN,
      ...opts.headers,
    },
    payload: JSON.stringify({
      username: user.username,
      password: opts.password ?? user.password,
      deviceName: opts.deviceName ?? 'Android 上的 DSH Hub',
      platform: opts.platform ?? 'android',
      ...(opts.installId === undefined ? {} : { installId: opts.installId }),
    }),
    remoteAddress: opts.ip ?? '127.0.0.1',
  })
  const body = json<Record<string, unknown>>(response)
  const errorCode =
    typeof body['error'] === 'object' && body['error'] !== null
      ? String((body['error'] as { code?: unknown }).code ?? '')
      : undefined
  return {
    status: response.statusCode,
    body,
    tokens: response.statusCode === 200 ? (body as unknown as MobileAuthTokens) : null,
    errorCode,
    headers: response.headers as Record<string, unknown>,
  }
}

/** 登录并返回可直接用的 Bearer 头 */
export async function mobileSession(
  app: FastifyInstance,
  user: Pick<TestUser, 'username' | 'password'>,
  opts: MobileLoginOptions = {},
): Promise<{ tokens: MobileAuthTokens; headers: Record<string, string> }> {
  const result = await mobileLogin(app, user, opts)
  if (result.tokens === null) throw new Error(`手机登录失败：${String(result.status)} ${JSON.stringify(result.body)}`)
  return { tokens: result.tokens, headers: bearerHeaders(result.tokens.accessToken) }
}

/** `Authorization: Bearer dshm_at_…` + App 来源（App 的每个请求都是这样） */
export function bearerHeaders(token: string, origin = MOBILE_APP_ORIGIN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    origin,
    'content-type': 'application/json',
  }
}

export async function refreshToken(
  app: FastifyInstance,
  token: string,
  opts: { ip?: string; origin?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; tokens: MobileAuthTokens | null; errorCode: string | undefined }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/mobile/auth/refresh',
    headers: { 'content-type': 'application/json', origin: opts.origin ?? MOBILE_APP_ORIGIN },
    payload: JSON.stringify({ refreshToken: token }),
    remoteAddress: opts.ip ?? '127.0.0.1',
  })
  const body = json<Record<string, unknown>>(response)
  const errorCode =
    typeof body['error'] === 'object' && body['error'] !== null
      ? String((body['error'] as { code?: unknown }).code ?? '')
      : undefined
  return {
    status: response.statusCode,
    body,
    tokens: response.statusCode === 200 ? (body as unknown as MobileAuthTokens) : null,
    errorCode,
  }
}

export async function mobileBootstrap(
  app: FastifyInstance,
  headers: Record<string, string>,
): Promise<{ status: number; body: MobileBootstrapResponse; errorCode: string | undefined }> {
  const response = await app.inject({ method: 'GET', url: '/api/mobile/bootstrap', headers })
  const body = json<Record<string, unknown>>(response)
  const errorCode =
    typeof body['error'] === 'object' && body['error'] !== null
      ? String((body['error'] as { code?: unknown }).code ?? '')
      : undefined
  return {
    status: response.statusCode,
    body: body as unknown as MobileBootstrapResponse,
    errorCode,
  }
}

export async function mobileTicket(
  app: FastifyInstance,
  headers: Record<string, string>,
  nodeId = 'cloud:self',
): Promise<{ status: number; body: MobileTicketResponse; errorCode: string | undefined }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/mobile/nodes/${encodeURIComponent(nodeId)}/ticket`,
    headers,
  })
  const body = json<Record<string, unknown>>(response)
  const errorCode =
    typeof body['error'] === 'object' && body['error'] !== null
      ? String((body['error'] as { code?: unknown }).code ?? '')
      : undefined
  return { status: response.statusCode, body: body as unknown as MobileTicketResponse, errorCode }
}
