/**
 * 手机端「认证 + bootstrap」契约。
 *
 * 来源：WP40a 已把契约落进 Hub 的 `packages/shared/src/api/mobile.ts`，并通过
 * `scripts/sync-shared.sh` 打包成 `vendor/dsh-hub-shared-f608936ba88e.tgz`。
 * 这里**不再有本地临时 zod** —— 全部 re-export 共享包的 schema 与类型，
 * 只保留 App 侧的两个便利别名（`MOBILE` 路径表、`hasCloudBackend`）。
 *
 * 冻结项（契约草案「变更记录」）：
 *  - 401 分两种：`DEVICE_TOKEN_INVALID`（去 refresh）与 `DEVICE_REVOKED`（清令牌回登录页）；
 *  - 登录锁定 → 429 `RATE_LIMITED` + `details.retryAfterSec`；
 *  - wake：409 `CAPACITY_FULL`、402 `INSUFFICIENT_POINTS`、404 `INSTANCE_ABSENT`；
 *  - refresh 轮换后 10 秒内重放旧令牌只回 `DEVICE_TOKEN_INVALID`，客户端仍要单飞刷新。
 */

import { z } from 'zod'
import {
  MOBILE_ASR_MAX_BYTES,
  MOBILE_ASR_MAX_SECONDS,
  MOBILE_BOOTSTRAP_PATH,
  MOBILE_TTS_MAX_CHARS,
  MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX,
  MOBILE_TTS_STREAM_PATH,
  MOBILE_CHANNEL_PATH,
  MOBILE_LOGIN_PATH,
  MOBILE_LOGOUT_PATH,
  MOBILE_REFRESH_PATH,
  MOBILE_WAKE_PATH,
  MobileAppInfoSchema,
  MobileAsrResponseSchema,
  MobileAuthTokensSchema,
  MobileBootstrapResponseSchema,
  MobileLoginRequestSchema,
  MobilePointsSchema,
  MobileRefreshRequestSchema,
  MobileTicketResponseSchema,
  MobileTtsVoiceSchema,
  MobileWakeResponseSchema,
  MOBILE_PROTOCOL_VERSION,
  MOBILE_API_PREFIX,
  MOBILE_CLOUD_NODE_ID,
  mobileTicketPath,
  type MobileAppInfo,
  type MobileAppPlatform,
  type MobileAsrResponse,
  type MobileAuthTokens,
  type MobileBootstrapResponse,
  type MobileLoginRequest,
  type MobileNode,
  type MobilePoints,
  type MobileRefreshRequest,
  type MobileTicketResponse,
  type MobileTtsVoice,
  type MobileUserRef,
  type MobileWakeResponse,
} from '@dsh-hub/shared'

// ── 路径 ────────────────────────────────────────────────────────────────────

export const MOBILE = {
  login: MOBILE_LOGIN_PATH,
  refresh: MOBILE_REFRESH_PATH,
  logout: MOBILE_LOGOUT_PATH,
  /** 0.2.9：合并本机历史重复设备（Bearer；幂等，返回被吊销条数） */
  consolidate: `${MOBILE_API_PREFIX}/auth/consolidate`,
  bootstrap: MOBILE_BOOTSTRAP_PATH,
  wake: MOBILE_WAKE_PATH,
  ticket: mobileTicketPath,
  /**
   * 0.4.2 服务端语音识别（WP49，契约冻结在 Hub `d00b39d`）：
   * `POST /api/mobile/asr`，`Content-Type: audio/wav`，body 是 16kHz / 单声道 / 16bit PCM 的 WAV。
   * 契约包没有导出路径常量，这里按契约文档写死（改契约时这里会随 sync-shared 一起被核对）。
   */
  asr: `${MOBILE_API_PREFIX}/asr`,
  /**
   * 0.4.3 AI 回复朗读（WP50，契约冻结在 Hub `b7b58e8`）：
   * `POST /api/mobile/tts`，JSON `{ text, voice? }` → `audio/wav`（24kHz 单声道 16bit）。
   * 与 asr 一样，契约包没有导出路径常量，这里按契约文档写死（sync-shared 时一起核对）。
   */
  tts: `${MOBILE_API_PREFIX}/tts`,
  /**
   * 0.4.6 流式朗读（WP51，契约冻结在 Hub `ea51e6d`）：
   * `POST /api/mobile/tts/stream`，请求体同 `/tts`，200 时 body 是**原始 PCM16 小端单声道**
   * （无 WAV 头、分块传输、边合成边下发）。只有 `bootstrap.voice.tts.stream === true`
   * 的 Hub 才会用到；老 Hub 继续走整段 `/tts`。
   */
  ttsStream: MOBILE_TTS_STREAM_PATH,
  channel: (nodeId: string) =>
    MOBILE_CHANNEL_PATH.replace(':id', encodeURIComponent(nodeId)),
  /**
   * WP56d 管理座舱（docs/24 §3.3）：交接码换座舱令牌。
   * `POST /api/mobile/auth/cockpit-exchange { code }` → 与网页版登录同形的令牌对，
   * 额外 `scope: 'cockpit'`、`platform: 'web'`。
   *
   * shared 包里只有请求 schema（`CockpitHandoffExchangeRequestSchema`），没有导出路径常量，
   * 和 asr / tts 一样在这里写死；改契约时随 `sync-shared.sh` 一起核对。
   */
  cockpitExchange: `${MOBILE_API_PREFIX}/auth/cockpit-exchange`,
} as const

export {
  MOBILE_API_PREFIX,
  MOBILE_ASR_MAX_BYTES,
  MOBILE_ASR_MAX_SECONDS,
  MOBILE_CLOUD_NODE_ID,
  MOBILE_PROTOCOL_VERSION,
  MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX,
  mobileTicketPath,
}

/** 服务端识别的一次上传上限（字节）：超过 Hub 直接 413 `PAYLOAD_TOO_LARGE`。 */
export const MOBILE_ASR_BYTES_LIMIT = MOBILE_ASR_MAX_BYTES
/** 单段录音上限（秒）：Hub 的 `bootstrap.voice.maxSeconds` 默认由这个值兜底。 */
export const MOBILE_ASR_SECONDS_LIMIT = MOBILE_ASR_MAX_SECONDS

// ── 设备令牌 ────────────────────────────────────────────────────────────────

export const AuthPlatformSchema = MobileLoginRequestSchema.shape.platform
export type AuthPlatform = MobileAppPlatform

export const LoginRequestSchema = MobileLoginRequestSchema
export type LoginRequest = MobileLoginRequest

/** `POST /api/mobile/auth/consolidate` 响应：被合并吊销的重复设备条数。 */
export const ConsolidateDevicesResponseSchema = z.object({
  removed: z.number().int().nonnegative(),
})
export type ConsolidateDevicesResponse = z.infer<typeof ConsolidateDevicesResponseSchema>

export const RefreshRequestSchema = MobileRefreshRequestSchema
export type RefreshRequest = MobileRefreshRequest

export const AuthTokensSchema = MobileAuthTokensSchema
export type AuthTokens = MobileAuthTokens
export type AuthUser = MobileUserRef

/** 认证错误码白名单（与 Hub 的 `MOBILE_AUTH_ERROR_CODES` 一致）。 */
export const AUTH_ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'USER_DISABLED',
  'USER_PENDING',
  'MUST_CHANGE_PASSWORD',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'DEVICE_REVOKED',
  'DEVICE_TOKEN_INVALID',
  'UNAUTHENTICATED',
  'INVALID_REQUEST',
  'INTERNAL',
] as const

// ── bootstrap / 唤醒 / ticket ───────────────────────────────────────────────

export const PointsSchema = MobilePointsSchema
export type Points = MobilePoints

/** 后端列表直接复用 v1 的 MobileNodeSchema。 */
export const BackendSchema = MobileBootstrapResponseSchema.shape.backends.element
export type Backend = MobileNode

export const BootstrapInstanceSchema = MobileBootstrapResponseSchema.shape.instance
export type BootstrapInstance = MobileBootstrapResponse['instance']

/**
 * App 版本信息（`bootstrap.app`）。
 *
 * 0.4.11 / WP52 起 Hub 会多发一个可选字段 `downloadMirrors`（同一个 APK 的全部下载地址，
 * 本入口的排第一）；老 Hub 没有这个字段，App 退回 `downloadUrl`。
 * `sha256` 同样是**前瞻可选**字段：Hub 目前不发，发了就参与下载校验（对不上就换镜像）。
 */
export const AppVersionInfoSchema = MobileAppInfoSchema.extend({
  downloadMirrors: z.array(z.string().url()).max(8).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
})
export type AppVersionInfo = z.infer<typeof AppVersionInfoSchema>

/** bootstrap 响应：外层直接用共享包 schema，只把 `app` 换成带 `downloadMirrors` 的版本。 */
export const BootstrapSchema = MobileBootstrapResponseSchema.extend({
  app: AppVersionInfoSchema,
})
export type Bootstrap = z.infer<typeof BootstrapSchema>

/**
 * 语音能力（0.4.2）：老 Hub 的 bootstrap **不发**这个字段（`optional`），
 * App 据此只能用手机系统识别。`asr=false` = Hub 侧识别服务当前不可用，同样退回系统识别。
 */
export type BootstrapVoice = NonNullable<MobileBootstrapResponse['voice']>
export const BootstrapVoiceSchema = MobileBootstrapResponseSchema.shape.voice

/** 服务端识别响应：`{ text, durationMs }`（Hub 只回文字与时长，不回音频）。 */
export const AsrResponseSchema = MobileAsrResponseSchema
export type AsrResponse = MobileAsrResponse

/**
 * 朗读合成结果（`HubClient.synthesize`）：WAV 字节 + 采样率 + 实际音色。
 *
 * `sampleRate` 来自响应头 `x-tts-sample-rate`（缺省 {@link TTS_DEFAULT_SAMPLE_RATE}），
 * `voice` 来自 `x-tts-voice`（缺省回落到请求的音色 id）。
 */
export interface TtsAudio {
  wav: Uint8Array
  sampleRate: number
  voice: string
}

/**
 * 流式朗读的结果（`HubClient.synthesizeStream`，0.4.6 / WP51）。
 *
 * `chunks` 是**已经按 16bit 样本对齐**的原始 PCM16 小端单声道字节（见
 * `src/http/pcm.ts` 的 `alignPcm16`）：网络可能把样本切在任意偏移，消费方拿到的每块
 * 都是偶数字节，可以直接拼成 `Int16Array`。`cached=true` 表示 Hub 命中缓存、一次性下发。
 */
export interface TtsStream {
  sampleRate: number
  voice: string
  cached: boolean
  chunks: AsyncIterable<Uint8Array>
}

/** 契约里的默认采样率：24000（单声道 16bit PCM）。 */
export const TTS_DEFAULT_SAMPLE_RATE = 24_000

/**
 * 朗读能力（0.4.3 / WP50）：`bootstrap.voice.tts`。
 *
 * 老 Hub（以及 Hub 管理端没开朗读时）**不发**这个字段 → App 不显示朗读入口。
 * `enabled=false` 表示合成服务当前不可用（入口置灰并说明）。`maxChars` 是单次
 * `POST /api/mobile/tts` 的文字上限，App 按它切段（Hub 默认 200）。
 */
export type BootstrapTts = NonNullable<BootstrapVoice['tts']>
/** 朗读音色（当前只有「星汐 seki」）。 */
export const TtsVoiceSchema = MobileTtsVoiceSchema
export type TtsVoice = MobileTtsVoice
/** 单次合成的文字上限（默认值；运行时以 `bootstrap.voice.tts.maxChars` 为准）。 */
export const MOBILE_TTS_CHARS_LIMIT = MOBILE_TTS_MAX_CHARS

export const WakeResponseSchema = MobileWakeResponseSchema
export type WakeResponse = MobileWakeResponse

export const ChannelTicketSchema = MobileTicketResponseSchema
export type ChannelTicket = MobileTicketResponse

// ── 错误信封 ────────────────────────────────────────────────────────────────

/**
 * Hub 的错误体：`{error:{code,message,details?}}`（`lib/errors.ts` 原样输出 details）。
 * 限流时 `details.retryAfterSec` 是倒计时秒数；客户端只读它，不猜窗口大小。
 */
export const HubErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .partial()
      .optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

// ── 语义自检 ────────────────────────────────────────────────────────────────

/** 契约草案 §2：未开通云实例时 backends 里仍然返回 `cloud:self`（status 由 Hub 定义）。 */
export function hasCloudBackend(backends: readonly Backend[]): boolean {
  return backends.some((b) => b.id === MOBILE_CLOUD_NODE_ID)
}
