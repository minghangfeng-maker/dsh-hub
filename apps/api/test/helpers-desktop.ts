import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { TestSession } from './helpers.js'
import { randomToken, sha256Hex } from '../src/lib/crypto.js'

/**
 * 桌面端测试脚手架（WP25a）：真的走一遍「start → 授权页 → approve → 回环拿 code → token」。
 *
 * 与冒烟脚本的区别：这里**不**真的监听回环端口，而是直接从 approve 返回的 redirectUrl 里取 code
 * （回环服务器本身由一个真起的 127.0.0.1 服务器验证过）。
 */

/** 真的 PKCE S256：`base64url(SHA256(verifier))` */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32)
  return { verifier, challenge: Buffer.from(sha256Hex(verifier), 'hex').toString('base64url') }
}

export interface DesktopDeviceInput {
  name?: string
  installId?: string | null
  platform?: 'win32' | 'darwin' | 'linux'
  osMajor?: string
  arch?: 'x64' | 'arm64' | 'other'
  appVersion?: string
  appChannel?: 'nightly' | 'latest'
  runtimeVersion?: string | null
  capabilities?: Record<string, unknown>
}

/** 默认的设备描述（登录时上报；键集合 = 契约的 DESKTOP_REGISTER_KEYS） */
export function desktopDevice(input: DesktopDeviceInput = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(input.installId === null ? {} : { installId: input.installId ?? randomUUID() }),
    name: input.name ?? 'Windows 11 上的 DSH',
    platform: input.platform ?? 'win32',
    osMajor: input.osMajor ?? '11',
    arch: input.arch ?? 'x64',
    appVersion: input.appVersion ?? '0.2.1',
    appChannel: input.appChannel ?? 'latest',
    runtimeVersion: input.runtimeVersion === undefined ? '0.2.1-rc.2' : input.runtimeVersion,
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
  }
}

export interface StartedLogin {
  requestId: string
  verifier: string
  challenge: string
  state: string
  redirectUri: string
  authorizeUrl: string
  device: Record<string, unknown>
}

export interface StartOptions extends DesktopDeviceInput {
  redirectUri?: string
  locale?: 'zh-CN' | 'en-US'
  codeChallenge?: string
  state?: string
  /** 覆盖请求体（测非法字段用） */
  extra?: Record<string, unknown>
}

/** `POST /api/desktop/auth/start`（免登录）：返回 pending 请求与 PKCE 材料 */
export async function startLogin(
  app: FastifyInstance,
  options: StartOptions = {},
): Promise<{ status: number; started: StartedLogin; body: Record<string, unknown> }> {
  const pair = pkcePair()
  const device = desktopDevice(options)
  const state = options.state ?? randomToken(32)
  const redirectUri = options.redirectUri ?? 'http://127.0.0.1:7956/oauth/hub/callback'
  const payload = {
    codeChallenge: options.codeChallenge ?? pair.challenge,
    codeChallengeMethod: 'S256',
    state,
    redirectUri,
    locale: options.locale ?? 'zh-CN',
    device,
    ...options.extra,
  }
  const response = await app.inject({
    method: 'POST',
    url: '/api/desktop/auth/start',
    payload,
    headers: { 'content-type': 'application/json' },
  })
  const body = response.json() as Record<string, unknown>
  return {
    status: response.statusCode,
    body,
    started: {
      requestId: typeof body.requestId === 'string' ? body.requestId : '',
      verifier: pair.verifier,
      challenge: pair.challenge,
      state,
      redirectUri,
      authorizeUrl: typeof body.authorizeUrl === 'string' ? body.authorizeUrl : '',
      device,
    },
  }
}

/** 网页会话点「允许/拒绝」：返回 302 目标（approve 时里面有 code） */
export async function decideLogin(
  app: FastifyInstance,
  session: TestSession,
  requestId: string,
  allow: boolean,
): Promise<{ status: number; redirectUrl: string; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/desktop/auth/requests/${requestId}/${allow ? 'approve' : 'deny'}`,
    payload: { allow },
    headers: session.headers,
  })
  const body = response.json() as Record<string, unknown>
  return {
    status: response.statusCode,
    redirectUrl: typeof body.redirectUrl === 'string' ? body.redirectUrl : '',
    body,
  }
}

/** 从回环地址里取查询参数（等价于桌面端的回环服务器收到浏览器跳转） */
export function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams
}

export interface DesktopLoginResult {
  token: string
  deviceId: string
  relay: { keyId: number; secret: string; ref: string; baseUrl: string } | null
  started: StartedLogin
  /** `POST /api/desktop/auth/token` 的完整响应体 */
  body: Record<string, unknown>
}

/** 完整登录一次（start → approve → token）。失败时抛错，便于测试读到真实状态码 */
export async function loginDesktop(
  app: FastifyInstance,
  session: TestSession,
  options: StartOptions = {},
): Promise<DesktopLoginResult> {
  const { status, started } = await startLogin(app, options)
  if (status !== 200) throw new Error(`auth/start 失败：HTTP ${String(status)}`)
  const approved = await decideLogin(app, session, started.requestId, true)
  if (approved.status !== 200) {
    throw new Error(`approve 失败：HTTP ${String(approved.status)} ${JSON.stringify(approved.body)}`)
  }
  const code = queryOf(approved.redirectUrl).get('code')
  if (!code) throw new Error(`approve 没给出 code：${approved.redirectUrl}`)
  const response = await app.inject({
    method: 'POST',
    url: '/api/desktop/auth/token',
    payload: { code, codeVerifier: started.verifier },
    headers: { 'content-type': 'application/json' },
  })
  if (response.statusCode !== 200) {
    throw new Error(`auth/token 失败：HTTP ${String(response.statusCode)} ${response.body}`)
  }
  const body = response.json() as Record<string, unknown>
  const relay = (body.relay ?? null) as DesktopLoginResult['relay']
  return {
    token: String(body.token),
    deviceId: String((body.device as { deviceId: string }).deviceId),
    relay,
    started,
    body,
  }
}

/** 设备令牌的请求头 */
export function deviceHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

/** `POST /api/desktop/devices/report` 的最小合法请求体（键集合 = DESKTOP_REPORT_KEYS） */
export function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    reportedAt: new Date().toISOString(),
    appliedRevision: null,
    appliedAt: null,
    applyState: 'unknown',
    applyErrorCode: null,
    ...overrides,
  }
}
