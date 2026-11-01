import { MOBILE_ASR_MAX_SECONDS, MobileAsrResponseSchema, type MobileAsrResponse } from '@dsh-hub/shared'
import type { AppDeps, RequestMeta } from '../../context.js'
import { createWindowCounter } from '../../lib/rate-limit.js'
import { HubError } from '../../lib/errors.js'
import type { SessionUser } from '../../lib/session.js'

/**
 * 服务端语音识别（WP49）：把手机录音转发给本机 `dsh-asr`（SenseVoice）。
 *
 * 边界（与 `packages/shared/src/api/mobile.ts` 的契约一致）：
 * - **不存音频**：请求体只在内存里过一遍，转发完就丢；
 * - **不记文字**：审计只有 `{bytes, durationMs, ms, ok}`，日志也只有状态码；
 * - Hub 只做鉴权 / 大小 / Content-Type / 限流 / 错误码映射，识别逻辑全在 `dsh-asr`；
 * - `bootstrap.voice.asr` 取 `/health` 的 30 秒缓存（失败也是 false，不让首屏卡住）。
 */

/** 契约允许的语言（默认 zh）。 */
export const ASR_LANGUAGES = ['zh', 'auto', 'en', 'yue', 'ja', 'ko'] as const
export type AsrLanguage = (typeof ASR_LANGUAGES)[number]
export const ASR_DEFAULT_LANGUAGE: AsrLanguage = 'zh'

/** 识别入口路径（CSRF 钩子要按这条路由放行 `audio/wav`，避免两处各写一份字符串）。 */
export const MOBILE_ASR_PATH = '/api/mobile/asr'

/** 健康检查缓存：30 秒（与云节点探测同一量级）。 */
export const ASR_HEALTH_TTL_MS = 30_000
/** 健康探测超时：本机服务，1.5 秒足够；不要让 bootstrap 等太久。 */
export const ASR_HEALTH_TIMEOUT_MS = 1_500

export interface MobileAsrRequest {
  user: SessionUser
  /** WAV 字节（Hub 已校验 Content-Type 与大小） */
  audio: Buffer
  lang: AsrLanguage
  meta: RequestMeta
}

export interface MobileAsrService {
  /** `/health` 的 30 秒缓存结果；`HUB_ASR_ENABLED=false` 时恒 false */
  available(): Promise<boolean>
  /** 转发识别；按契约抛 `VALIDATION_FAILED` / `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA` / `RATE_LIMITED` / `UPSTREAM_ERROR` */
  transcribe(input: MobileAsrRequest): Promise<MobileAsrResponse>
}

export function createMobileAsrService(deps: AppDeps): MobileAsrService {
  const { config, clock, audit } = deps
  const minuteLimit = createWindowCounter({ capacity: config.asrPerMinute, windowMs: 60_000, clock })
  const dayLimit = createWindowCounter({ capacity: config.asrPerDay, windowMs: 86_400_000, clock })

  let health = { at: Number.NEGATIVE_INFINITY, value: false }
  let probe: Promise<boolean> | null = null

  function auditAsr(user: SessionUser, meta: RequestMeta, detail: Record<string, unknown>): void {
    audit.log({
      actorId: user.id,
      actorIp: meta.ip,
      action: 'mobile.asr',
      targetType: 'user',
      targetId: user.id,
      detail,
    })
  }

  async function probeHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${config.asrUrl}/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(ASR_HEALTH_TIMEOUT_MS),
      })
      if (!response.ok) return false
      const body = (await response.json()) as { ok?: unknown }
      return body.ok === true
    } catch {
      return false
    }
  }

  async function available(): Promise<boolean> {
    if (!config.asrEnabled) return false
    const now = clock.now().getTime()
    if (now - health.at < ASR_HEALTH_TTL_MS) return health.value
    // 并发 bootstrap（多设备同时打开 App）只发一次探测
    if (probe === null) {
      probe = probeHealth()
        .then((value) => {
          health = { at: clock.now().getTime(), value }
          return value
        })
        .finally(() => {
          probe = null
        })
    }
    return probe
  }

  function consumeLimit(user: SessionUser): void {
    for (const limiter of [minuteLimit, dayLimit]) {
      const decision = limiter.consume(String(user.id))
      if (!decision.allowed) {
        throw new HubError('RATE_LIMITED', '说话太频繁，请稍后再试', {
          retryAfterSec: decision.retryAfterSec,
        })
      }
    }
  }

  async function transcribe(input: MobileAsrRequest): Promise<MobileAsrResponse> {
    const started = performance.now()
    const bytes = input.audio.length
    const elapsed = (): number => Math.round(performance.now() - started)

    if (!config.asrEnabled) {
      throw new HubError('UPSTREAM_ERROR', '语音识别未启用')
    }
    consumeLimit(input.user)

    let response: Response
    try {
      response = await fetch(`${config.asrUrl}/transcribe?lang=${encodeURIComponent(input.lang)}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', accept: 'application/json' },
        body: new Uint8Array(input.audio),
        signal: AbortSignal.timeout(config.asrTimeoutMs),
      })
    } catch {
      // 连接拒绝 / DNS / 25 秒超时：对外一律 502，不区分（识别服务在本机，细节进日志意义不大）
      auditAsr(input.user, input.meta, { bytes, ms: elapsed(), ok: false })
      throw new HubError('UPSTREAM_ERROR', '语音识别服务不可用')
    }

    const elapsedMid = elapsed()
    if (response.status !== 200) {
      // 读完错误体再丢，避免连接悬着；上游文案不转发给 App（契约只认错误码）
      await response.text().catch(() => '')
      deps.logger.debug({ status: response.status, bytes }, 'mobile.asr upstream non-200')
      auditAsr(input.user, input.meta, { bytes, ms: elapsedMid, ok: false })
      if (response.status === 400) {
        throw new HubError('VALIDATION_FAILED', '音频无法识别（需要 16kHz 单声道 16bit WAV）')
      }
      if (response.status === 413) throw new HubError('PAYLOAD_TOO_LARGE', '录音太长')
      if (response.status === 415) throw new HubError('UNSUPPORTED_MEDIA', '音频格式不支持')
      if (response.status === 429) {
        throw new HubError('RATE_LIMITED', '识别服务忙，请稍后再试', { retryAfterSec: 2 })
      }
      throw new HubError('UPSTREAM_ERROR', '语音识别失败')
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      auditAsr(input.user, input.meta, { bytes, ms: elapsedMid, ok: false })
      throw new HubError('UPSTREAM_ERROR', '语音识别返回了无法解析的内容')
    }
    const parsed = MobileAsrResponseSchema.safeParse(body)
    if (!parsed.success) {
      auditAsr(input.user, input.meta, { bytes, ms: elapsed(), ok: false })
      throw new HubError('UPSTREAM_ERROR', '语音识别返回了无法解析的内容')
    }

    const durationMs = parsed.data.durationMs
    auditAsr(input.user, input.meta, { bytes, durationMs, ms: elapsed(), ok: true })
    return parsed.data
  }

  return { available, transcribe }
}

/** `bootstrap.voice`（老 Hub 不发；App 缺字段时回落到系统识别）。 */
export function mobileVoiceInfo(asr: boolean): { asr: boolean; maxSeconds: number } {
  return { asr, maxSeconds: MOBILE_ASR_MAX_SECONDS }
}
