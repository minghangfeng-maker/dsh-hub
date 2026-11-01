/**
 * 座舱交接码换令牌（WP56d，docs/24 §3.3）。
 *
 * 独立于 `HubClient`：这条请求**不需要 Bearer**，也发生在「还没有任何令牌」的时刻
 * （父页面刚把 `#code=…` 塞进 iframe）。放进 HubClient 反而要绕开它的令牌前置逻辑，
 * 所以做成一个纯函数，由 UI 的 cockpit store 调用。
 *
 * 失败语义（UI 据此决定「等父页面重新交接」还是「报错」）：
 *  - 网络/超时 → `network` / `timeout`（可重试，不弹登录页）；
 *  - 交接码无效/过期/已用过 → `cockpit-handoff-invalid`（等父页面发新的 code）；
 *  - 其它 Hub 业务错误 → 服务端给的码（`RATE_LIMITED` 等，沿用中文文案）。
 */

import {
  HubErrorEnvelopeSchema,
  MOBILE,
  type AuthTokens,
} from '../contracts/auth-bootstrap.js'
import { CockpitExchangeResponseSchema, type CockpitSession } from '../cockpit/embed.js'
import { HubApiError, codeFromHttpStatus, errorMessage } from '../errors.js'

export type CockpitFetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface CockpitExchangeOptions {
  /** Hub 入口（网页版里就是页面自己的 origin）。 */
  origin: string
  /** 父页面给的一次性交接码（60 秒有效、只能用一次）。 */
  code: string
  fetchImpl?: CockpitFetchLike
  timeoutMs?: number
  now?: () => number
}

/** 交接码换令牌的等待上限：一条 POST，15 秒足够（比普通请求宽松一点，容器可能冷启动）。 */
export const COCKPIT_EXCHANGE_TIMEOUT_MS = 15_000

/** 交接码这类失败不重试、也不回登录页：等父页面重新发码。 */
export const COCKPIT_HANDOFF_INVALID = 'cockpit-handoff-invalid'

function positiveTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : COCKPIT_EXCHANGE_TIMEOUT_MS
}

/**
 * `POST /api/mobile/auth/cockpit-exchange`。
 *
 * @returns 令牌 + `scope: 'cockpit'`（`scope` 缺省也当 cockpit：这是唯一的调用方）
 */
export async function exchangeCockpitHandoff(
  options: CockpitExchangeOptions,
): Promise<CockpitSession> {
  const origin = options.origin.replace(/\/+$/, '')
  const fetchImpl: CockpitFetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const timeoutMs = positiveTimeout(options.timeoutMs)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()

  let response: Response
  try {
    response = await fetchImpl(`${origin}${MOBILE.cockpitExchange}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        // 必须显式带 Content-Type：fetch 的 string body 不会自动加（真 Hub 会对无
        // content-type 的 POST 回 415 / 自定义错误，见 HubClient 里同一处注释）。
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: options.code }),
      signal: controller.signal,
    })
  } catch (error) {
    if (timedOut) {
      throw new HubApiError('timeout', {
        message: errorMessage('timeout'),
        retryable: true,
        detail: 'cockpit-exchange: timeout',
      })
    }
    throw new HubApiError('network', {
      message: errorMessage('network'),
      retryable: true,
      detail: String((error as Error)?.message ?? error),
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) throw await exchangeFailure(response)

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new HubApiError('protocol', {
      status: response.status,
      message: errorMessage('protocol'),
      detail: 'cockpit-exchange: invalid-json',
    })
  }
  const parsed = CockpitExchangeResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new HubApiError('protocol', {
      status: response.status,
      message: errorMessage('protocol'),
      detail: `cockpit-exchange: ${parsed.error.issues.map((i) => i.path.join('.')).join(',')}`,
    })
  }
  const tokens: AuthTokens = {
    accessToken: parsed.data.accessToken,
    accessExpiresAt: parsed.data.accessExpiresAt,
    refreshToken: parsed.data.refreshToken,
    refreshExpiresAt: parsed.data.refreshExpiresAt,
    deviceId: parsed.data.deviceId,
    user: parsed.data.user,
  }
  return { tokens, scope: 'cockpit' }
}

/** 非 2xx：读 Hub 的错误信封，把「码无效」单独成一个可识别的码。 */
async function exchangeFailure(response: Response): Promise<HubApiError> {
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    /* 有些错误没有 body */
  }
  const envelope = HubErrorEnvelopeSchema.safeParse(json)
  const error = envelope.success ? envelope.data.error : undefined
  const serverCode = envelope.success ? (error?.code ?? envelope.data.code) : undefined
  const serverMessage = envelope.success ? (error?.message ?? envelope.data.message) : undefined
  // 400 / 401 / 403 / 404 / 410 都是「这个码不能用了」：等父页面重新交接，不要回登录页。
  if (serverCode === undefined && response.status >= 400 && response.status < 500) {
    return new HubApiError(COCKPIT_HANDOFF_INVALID, {
      status: response.status,
      message: errorMessage(COCKPIT_HANDOFF_INVALID),
      detail: serverMessage,
    })
  }
  const code = serverCode ?? codeFromHttpStatus(response.status)
  return new HubApiError(code, {
    status: response.status,
    message: errorMessage(code),
    retryable: response.status >= 500,
    detail: serverMessage,
  })
}
