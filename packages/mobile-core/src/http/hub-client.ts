/**
 * 真实 Hub 的 HTTP 客户端（Bearer + 401 单飞刷新）。
 *
 * 关键行为（任务包 A1 第 2 条 / 契约草案 §1）：
 *  - 所有 `/api/mobile/*` 都带 `Authorization: Bearer <access>`，不带 cookie；
 *  - access 过期先本地判断并刷新（提前 30s），401 时再刷新一次重试**一次**；
 *  - **并发请求只触发一次 refresh**：共用同一个 Promise（refresh token 会轮换，
 *    重放旧 refresh 会被 Hub 判定重放并吊销整个设备，所以单飞是硬要求）；
 *  - refresh 失败才通知 UI 回登录页；网络错误不清令牌（用户可能只是断网）；
 *  - 错误码统一映射成中文，不把服务端英文/原始 code 显示到界面。
 */

import {
  AsrResponseSchema,
  AuthTokensSchema,
  BootstrapSchema,
  ChannelTicketSchema,
  HubErrorEnvelopeSchema,
  ConsolidateDevicesResponseSchema,
  LoginRequestSchema,
  MOBILE,
  MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX,
  RefreshRequestSchema,
  TTS_DEFAULT_SAMPLE_RATE,
  WakeResponseSchema,
  type AsrResponse,
  type AuthTokens,
  type Bootstrap,
  type ChannelTicket,
  type LoginRequest,
  type TtsAudio,
  type TtsStream,
  type WakeResponse,
} from '../contracts/auth-bootstrap.js'
import {
  HubApiError,
  codeFromHttpStatus,
  errorMessage,
  isRefreshableCode,
  isRetryableCode,
} from '../errors.js'
import {
  isAccessExpired,
  isRefreshExpired,
  type TokenStore,
} from '../auth/token-store.js'
import { WsChannelLink, type ChannelLink, type WebSocketLike } from '../channel/link.js'
import { alignPcm16 } from './pcm.js'
import { normalizeHubOrigins, wsOriginOf } from '../config.js'
import {
  OriginManager,
  looksLikeInterceptPage,
  type FailoverReason,
  type OriginSwitch,
} from './origin-manager.js'
import type { KeyValueStore } from '../prefs/selection-store.js'
import type { HubGateway } from '../gateway.js'
import type { z } from 'zod'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HubClientOptions {
  origin: string
  /**
   * 多入口（0.4.11 / WP52）：有序候选，首选在前。`origin` 必须是列表里的第一个
   * （或只给 `origin` 一个，等于关闭切换）。设备令牌在两个入口通用。
   */
  origins?: readonly string[]
  /** 持久化「上次可用入口」（正式包是 Capacitor Preferences）。 */
  originStore?: KeyValueStore
  originStoreKey?: string
  /** 健康检查超时（默认 4s）；单测可以调小。 */
  originProbeTimeoutMs?: number
  /** 失败冷却（默认 8s）；单测可以调到 0。 */
  originCooldownMs?: number
  /** 入口切换/探测诊断事件。 */
  onOriginEvent?: (event: string, detail: string) => void
  tokenStore: TokenStore
  clientName?: string
  clientVersion?: string
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
  /** 注入 WebSocket 构造器（测试用）；默认全局 WebSocket。 */
  createSocket?: (url: string) => WebSocketLike
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH'
  body?: unknown
  /**
   * 二进制请求体（0.4.2 语音上传）：不走 `JSON.stringify`，Content-Type 由 `contentType` 指定。
   * 与 `body` 互斥；401 刷新后重试会用同一个 `Uint8Array` 重放。
   */
  bodyBytes?: Uint8Array
  /** `bodyBytes` 的 Content-Type（默认 application/octet-stream）。 */
  contentType?: string
  /** 是否带 Bearer（登录/刷新不带）。 */
  auth?: boolean
  /** 是否在 401 时尝试刷新后重试一次（默认 true）。 */
  refreshOn401?: boolean
  timeoutMs?: number
  /**
   * 外部取消信号（0.4.6 流式朗读）：abort 后连接中断，**读流**会抛 `cancelled`。
   * 只对「发起前」与「读流中」有效；已开始的响应体也会随之中断（fetch 语义）。
   */
  signal?: AbortSignal
}

/** 一次语音上传的等待上限（毫秒）：识别比普通请求慢得多，但 30 秒还没结果就当失败。 */
export const ASR_TIMEOUT_MS = 30_000

/** 朗读合成的等待上限（毫秒）：一句 3 秒左右，但排队/冷启动要留余量。 */
export const TTS_TIMEOUT_MS = 45_000

/** 流式朗读等**响应头**的上限（毫秒）：拿到头就算开始下发，之后只看分块空闲。 */
export const TTS_STREAM_START_TIMEOUT_MS = 30_000

/**
 * 两次收到分块之间的最长等待（毫秒）：超过就当作连接挂死（Hub 掐断连接但没关 socket），
 * 按 `timeout` 处理——比让播放器永远等下去好。
 */
export const TTS_STREAM_IDLE_TIMEOUT_MS = 30_000

/** `x-tts-sample-rate` 解析：拿不到或不合法就用契约默认值 24000。 */
function positiveInt(raw: string | null): number | null {
  if (raw === null) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export class HubClient implements HubGateway {
  readonly mode = 'http' as const
  private readonly opts: HubClientOptions
  private readonly now: () => number
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  /** 多入口：当前入口 / 候选顺序 / 持久化 / 健康探测（0.4.11）。 */
  private readonly origins: OriginManager
  private refreshPromise: Promise<AuthTokens | null> | null = null
  private authLostHandlers = new Set<(reason: string) => void>()
  /** 最近一次刷新失败的语义：revoked（已清令牌）/ invalid（令牌还在，可稍后再试）。 */
  private lastAuthFailure: 'revoked' | 'invalid' | null = null

  constructor(options: HubClientOptions) {
    this.opts = options
    this.now = options.now ?? (() => Date.now())
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? 15_000
    const candidates = normalizeHubOrigins(options.origins ?? [options.origin])
    this.origins = new OriginManager({
      origins: candidates.length > 0 ? candidates : [options.origin.replace(/\/+$/, '')],
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.originStore === undefined ? {} : { store: options.originStore }),
      ...(options.originStoreKey === undefined ? {} : { storeKey: options.originStoreKey }),
      ...(options.onOriginEvent === undefined ? {} : { onEvent: options.onOriginEvent }),
      ...(options.originProbeTimeoutMs === undefined
        ? {}
        : { probeTimeoutMs: options.originProbeTimeoutMs }),
      ...(options.originCooldownMs === undefined ? {} : { cooldownMs: options.originCooldownMs }),
      now: this.now,
    })
  }

  /** 当前入口（多入口时会被自动切换改变；旧代码只读它取地址）。 */
  get origin(): string {
    return this.origins.current
  }

  /** 有序候选入口（首选在前）。 */
  get originCandidates(): readonly string[] {
    return this.origins.candidates
  }

  /** 读持久化的「上次可用入口」（每个进程一次；首次请求前自动调用，无需手动等）。 */
  ensureOriginReady(): Promise<void> {
    return this.origins.ensureReady()
  }

  onOriginChange(handler: (change: OriginSwitch) => void): () => void {
    return this.origins.subscribe(handler)
  }

  /** App 回到前台：停在备用入口时静默探回首选（通了才切）。 */
  async preferPrimaryOrigin(): Promise<boolean> {
    await this.origins.ensureReady()
    return this.origins.preferPrimary()
  }

  // ── 令牌 ────────────────────────────────────────────────────────────────

  async restore(): Promise<AuthTokens | null> {
    const tokens = await this.opts.tokenStore.load()
    if (!tokens) return null
    if (isRefreshExpired(tokens, this.now())) {
      await this.opts.tokenStore.clear()
      return null
    }
    return tokens
  }

  async hasSession(): Promise<boolean> {
    return (await this.restore()) !== null
  }

  private async requireTokens(): Promise<AuthTokens> {
    const tokens = await this.restore()
    if (!tokens) {
      throw new HubApiError('UNAUTHENTICATED', { message: errorMessage('UNAUTHENTICATED') })
    }
    return tokens
  }

  /**
   * 刷新 access（必要时轮换 refresh）。并发请求共用同一个 Promise。
   * 返回 null 表示「令牌已经不可用」（已清理并通知 UI）；网络错误会抛 HubApiError('network')。
   */
  async refreshTokens(): Promise<AuthTokens | null> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null
      })
    }
    return this.refreshPromise
  }

  private async doRefresh(): Promise<AuthTokens | null> {
    const current = await this.opts.tokenStore.load()
    if (!current) return null
    if (isRefreshExpired(current, this.now())) {
      await this.clearAndNotify('refresh-expired')
      return null
    }
    let response: Response
    try {
      const body = RefreshRequestSchema.parse({ refreshToken: current.refreshToken })
      response = await this.fetchOnce(
        MOBILE.refresh,
        {
          method: 'POST',
          body: JSON.stringify(body),
          // 必须显式带 Content-Type：fetch 的 string body 不会自动加，
          // Fastify 会对无 content-type 的 POST 回 415/自定义错误（真实 Hub 冒烟发现）。
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        },
        this.timeoutMs,
      )
    } catch (error) {
      // 网络问题不能清令牌：用户可能只是断网，恢复后还能继续用。
      throw this.toNetworkError(error)
    }
    if (!response.ok) {
      const payload = await this.readErrorPayload(response)
      if (payload.code === 'DEVICE_REVOKED') {
        // 设备被吊销 / 账号停用：清令牌，回登录页。
        this.lastAuthFailure = 'revoked'
        await this.clearAndNotify('device-revoked')
        return null
      }
      if (payload.code === 'DEVICE_TOKEN_INVALID' || payload.code === undefined) {
        // DEVICE_TOKEN_INVALID：可能是 10 秒宽限期里的「旧 refresh 重放」。
        // 客户端有单飞保证，正常不会走到；真走到了也**不踢人**，保留令牌等下一次。
        this.lastAuthFailure = 'invalid'
        return null
      }
      // 其它（429 RATE_LIMITED、5xx…）：保留令牌，把真实原因抛给调用方。
      // 不能像以前那样吞成 null —— 那会让上层误以为「刷新不可用」而丢掉错误码。
      throw new HubApiError(payload.code, {
        status: response.status,
        message: errorMessage(payload.code),
        detail: payload.message,
        retryAfterSec: payload.retryAfterSec,
      })
    }
    const tokens = await this.parseBody(response, AuthTokensSchema, 'refresh')
    await this.opts.tokenStore.save(tokens)
    this.lastAuthFailure = null
    return tokens
  }

  private async clearAndNotify(reason: string): Promise<void> {
    await this.opts.tokenStore.clear()
    for (const handler of [...this.authLostHandlers]) {
      try {
        handler(reason)
      } catch {
        /* ignore */
      }
    }
  }

  onAuthLost(handler: (reason: string) => void): () => void {
    this.authLostHandlers.add(handler)
    return () => this.authLostHandlers.delete(handler)
  }

  // ── 认证接口 ────────────────────────────────────────────────────────────

  async login(input: LoginRequest): Promise<AuthTokens> {
    const body = LoginRequestSchema.parse(input)
    const response = await this.requestRaw(MOBILE.login, { method: 'POST', body, auth: false })
    if (!response.ok) throw await this.toApiError(response)
    const tokens = await this.parseBody(response, AuthTokensSchema, 'login')
    await this.opts.tokenStore.save(tokens)
    this.lastAuthFailure = null
    return tokens
  }

  /**
   * 合并本机历史重复设备（0.2.9）：老版本 App 每次登录都会新建一条设备记录，
   * 升级后启动时调一次即可清掉同名同平台的旧记录。失败静默（不影响使用）。
   *
   * 0.2.14：之前直接拿 `tokenStore.load()` 的 access 发请求，冷启动时它往往已经过期
   * （生产日志里「refresh 200 后紧跟 consolidate 401」就是这条竞态：bootstrap 触发刷新，
   * consolidate 拿着刷新前的旧 access 并发跑了）。现在先按需刷新、401 时再刷新重试一次，
   * 并且**始终不外抛**（这个调用只做设备台账清理，绝不能把人踢回登录页）。
   */
  async consolidateDevices(): Promise<number> {
    let tokens = await this.opts.tokenStore.load()
    if (!tokens) return 0
    try {
      if (isAccessExpired(tokens, this.now())) {
        const refreshed = await this.refreshTokens()
        if (!refreshed) return 0
        tokens = refreshed
      }
      let response = await this.requestRaw(MOBILE.consolidate, {
        method: 'POST',
        bearer: tokens.accessToken,
      })
      if (response.status === 401) {
        // 并发的 bootstrap 可能刚把令牌轮换掉：先看本地有没有更新的 access，
        // 没有就单飞刷新一次（refresh 失败说明令牌真的不可用，交给上层恢复）。
        const latest = await this.opts.tokenStore.load()
        if (latest && latest.accessToken !== tokens.accessToken) {
          tokens = latest
        } else {
          const refreshed = await this.refreshTokens()
          if (!refreshed) return 0
          tokens = refreshed
        }
        response = await this.requestRaw(MOBILE.consolidate, {
          method: 'POST',
          bearer: tokens.accessToken,
        })
      }
      if (!response.ok) return 0
      const body = await this.parseBody(
        response,
        ConsolidateDevicesResponseSchema,
        'consolidate-devices',
      )
      return body.removed
    } catch {
      return 0
    }
  }

  async logout(): Promise<void> {
    const tokens = await this.opts.tokenStore.load()
    try {
      if (tokens) {
        await this.requestRaw(MOBILE.logout, {
          method: 'POST',
          bearer: tokens.accessToken,
        })
      }
    } catch {
      /* 退出必须成功：网络失败也清本地 */
    } finally {
      await this.opts.tokenStore.clear()
    }
  }

  // ── bootstrap / 唤醒 / ticket ───────────────────────────────────────────

  async bootstrap(): Promise<Bootstrap> {
    return this.requestJson(MOBILE.bootstrap, { method: 'GET' }, BootstrapSchema)
  }

  async wake(): Promise<WakeResponse> {
    return this.requestJson(MOBILE.wake, { method: 'POST' }, WakeResponseSchema)
  }

  /**
   * 服务端语音识别（0.4.2 / WP49）：把一段 16kHz 单声道 16bit PCM 的 WAV 交给 Hub 识别。
   *
   * - 走同一套 Bearer + 401 单飞刷新 + 中文错误码（400 `VALIDATION_FAILED`、
   *   413 `PAYLOAD_TOO_LARGE`、415 `UNSUPPORTED_MEDIA`、429 `RATE_LIMITED`、502 `UPSTREAM_ERROR`）；
   * - 超时 30 秒（比普通请求长：识别本身就要时间）；
   * - `lang` 省略时由 Hub 用默认 `zh`；App 只在需要时传 `zh` / `auto`。
   * - **不重试**：失败交给上层决定「提示 + 下次改用系统识别」，避免用户多等 30 秒。
   */
  async transcribe(wav: Uint8Array, lang?: string): Promise<AsrResponse> {
    const path = lang
      ? `${MOBILE.asr}?lang=${encodeURIComponent(lang)}`
      : MOBILE.asr
    return this.requestJson(
      path,
      {
        method: 'POST',
        bodyBytes: wav,
        contentType: 'audio/wav',
        timeoutMs: ASR_TIMEOUT_MS,
      },
      AsrResponseSchema,
    )
  }

  async requestTicket(nodeId: string): Promise<ChannelTicket> {
    return this.requestJson(MOBILE.ticket(nodeId), { method: 'POST' }, ChannelTicketSchema)
  }

  /**
   * 朗读合成（0.4.3 / WP50）：把一小段文字交给 Hub 合成星汐的声音。
   *
   * - 走同一套 Bearer + 401 单飞刷新（重试一次），错误码沿用 Hub 统一码：
   *   400 `VALIDATION_FAILED`（空文本/超长/未知音色）、429 `RATE_LIMITED`（带
   *   `retryAfterSec`，由播放器决定重试）、502 `UPSTREAM_ERROR`（合成服务不可用）；
   * - 超时 45 秒：合成速度约等于实时，一句 3 秒左右，但排队 + 冷启动要留余量；
   * - 返回 `{ wav, sampleRate, voice }`：采样率与音色取自响应头
   *   （`x-tts-sample-rate` / `x-tts-voice`），缺省 24000 / 请求的音色；
   * - **本地不校验长度**，切段由 ui 的 speech-text 负责（这里只挡空文本，省一次往返）。
   * - **不缓存、不重试**：缓存与 429 重试都在播放器（ui）里，便于跨消息复用与统一策略。
   */
  async synthesize(input: { text: string; voice?: string }): Promise<TtsAudio> {
    const text = input.text.trim()
    if (text.length === 0) {
      throw new HubApiError('VALIDATION_FAILED', {
        status: 400,
        message: errorMessage('VALIDATION_FAILED'),
        detail: 'synthesize: empty text',
      })
    }
    const body = input.voice ? { text, voice: input.voice } : { text }
    const response = await this.requestAuthorized(MOBILE.tts, {
      method: 'POST',
      body,
      timeoutMs: TTS_TIMEOUT_MS,
    })
    if (!response.ok) throw await this.toApiError(response)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch {
      throw new HubApiError('protocol', {
        status: response.status,
        message: errorMessage('protocol'),
        detail: 'synthesize: unreadable body',
      })
    }
    if (bytes.byteLength < 44) {
      throw new HubApiError('protocol', {
        status: response.status,
        message: errorMessage('protocol'),
        detail: 'synthesize: not a wav',
      })
    }
    return {
      wav: bytes,
      sampleRate: positiveInt(response.headers.get('x-tts-sample-rate')) ?? TTS_DEFAULT_SAMPLE_RATE,
      voice: response.headers.get('x-tts-voice') || input.voice || '',
    }
  }

  /**
   * 流式朗读（0.4.6 / WP51）：`POST /api/mobile/tts/stream`，边合成边下发原始 PCM。
   *
   * 与整段 `synthesize` 的差别：
   *  - 成功时 body 是 **PCM16 小端单声道**（无 WAV 头），分块传输；`chunks` 是异步可迭代，
   *    **已经按样本对齐**（见 `alignPcm16`），每块都是偶数字节；
   *  - 开始下发前的错误（400 / 429 带 `retryAfterSec` / 502）照常按中文错误码抛出；
   *  - **开始下发后**失败 = 连接被 Hub 掐断 → 读流抛 `stream-interrupted`（可识别、可重试）；
   *  - `signal` 可随时取消（停止朗读）：抛 `cancelled`，连接一起断；
   *  - 401 单飞刷新只在**发起前**生效（重试一次）；一旦开始读流就不再重放，
   *    否则用户会听到两遍开头。
   *
   * 超时口径：等响应头 30 秒（排队 + 冷启动），之后按**分块空闲** 30 秒判定挂死。
   */
  async synthesizeStream(input: {
    text: string
    voice?: string
    signal?: AbortSignal
  }): Promise<TtsStream> {
    const text = input.text.trim()
    if (text.length === 0) {
      throw new HubApiError('VALIDATION_FAILED', {
        status: 400,
        message: errorMessage('VALIDATION_FAILED'),
        detail: 'synthesizeStream: empty text',
      })
    }
    const body = input.voice ? { text, voice: input.voice } : { text }
    const response = await this.requestAuthorized(MOBILE.ttsStream, {
      method: 'POST',
      body,
      timeoutMs: TTS_STREAM_START_TIMEOUT_MS,
      signal: input.signal,
    })
    if (!response.ok) throw await this.toApiError(response)
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.startsWith(MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX.toLowerCase())) {
      throw new HubApiError('protocol', {
        status: response.status,
        message: errorMessage('protocol'),
        detail: `synthesizeStream: content-type ${contentType.slice(0, 48)}`,
      })
    }
    const reader = response.body?.getReader()
    if (!reader) {
      throw new HubApiError('protocol', {
        status: response.status,
        message: errorMessage('protocol'),
        detail: 'synthesizeStream: no body',
      })
    }
    return {
      sampleRate: positiveInt(response.headers.get('x-tts-sample-rate')) ?? TTS_DEFAULT_SAMPLE_RATE,
      voice: response.headers.get('x-tts-voice') || input.voice || '',
      cached: response.headers.get('x-tts-cached') === '1',
      chunks: alignPcm16(this.readPcmStream(reader, input.signal)),
    }
  }

  /**
   * 读响应体：把网络异常/连接被掐断统一成可识别的错误码。
   * 消费者提前退出（停止）时在 `finally` 里把连接取消掉，不让它挂在后台继续下载。
   */
  private async *readPcmStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array, void, void> {
    let idleTimedOut = false
    try {
      for (;;) {
        const result = await this.readChunk(reader, () => {
          idleTimedOut = true
        })
        if (result.done) return
        const value = result.value
        if (value && value.byteLength > 0) yield value
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new HubApiError('cancelled', {
          status: 0,
          message: errorMessage('cancelled'),
          detail: 'synthesizeStream: aborted',
        })
      }
      if (idleTimedOut) {
        throw new HubApiError('timeout', {
          status: 0,
          message: errorMessage('timeout'),
          retryable: true,
          detail: 'synthesizeStream: idle',
        })
      }
      throw new HubApiError('stream-interrupted', {
        status: 502,
        message: errorMessage('stream-interrupted'),
        retryable: true,
        detail: `synthesizeStream: ${String((error as Error)?.name ?? error).slice(0, 48)}`,
      })
    } finally {
      // 正常读完时 cancel 是空操作；提前退出（停止）时它才是真正断开连接的那一步。
      void reader.cancel().catch(() => undefined)
    }
  }

  /** 读一块，带分块空闲超时（读流挂死时不能让播放器永远等下去）。 */
  private readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onIdle: () => void,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onIdle()
        // cancel 之后挂起的那次 read 也会结束；这里的 reject 已经先到，后续回调被忽略
        void reader.cancel().catch(() => undefined)
        reject(new Error('tts-stream-idle'))
      }, TTS_STREAM_IDLE_TIMEOUT_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      reader.read().then(
        (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  async openChannel(nodeId: string): Promise<ChannelLink> {
    const ticket = await this.requestTicket(nodeId)
    const url = `${wsOriginOf(this.origin)}${MOBILE.channel(nodeId)}?ticket=${encodeURIComponent(ticket.ticket)}`
    return new WsChannelLink(url, { createSocket: this.opts.createSocket })
  }

  // ── 通用请求 ────────────────────────────────────────────────────────────

  private async requestJson<T>(
    path: string,
    options: RequestOptions,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.requestAuthorized(path, options)
    if (!response.ok) throw await this.toApiError(response)
    return this.parseBody(response, schema, path)
  }

  /**
   * 带 Bearer 的请求 + 401 单飞刷新重试一次（0.4.3 从 `requestJson` 抽出来：
   * 朗读要拿**二进制**响应，也需要同一套 401 语义）。
   */
  private async requestAuthorized(path: string, options: RequestOptions): Promise<Response> {
    let response = await this.requestWithAuth(path, options)
    if (response.status === 401 && options.auth !== false && options.refreshOn401 !== false) {
      // 先读错误码：DEVICE_REVOKED 必须直接回登录页；DEVICE_TOKEN_INVALID 才去 refresh。
      const payload = await this.readErrorPayload(response)
      if (payload.code === 'DEVICE_REVOKED') {
        this.lastAuthFailure = 'revoked'
        await this.clearAndNotify('device-revoked')
        throw new HubApiError('DEVICE_REVOKED', {
          status: 401,
          message: errorMessage('DEVICE_REVOKED'),
        })
      }
      const refreshed = await this.refreshTokens()
      if (!refreshed) {
        const failure = this.lastAuthFailure ?? 'invalid'
        throw new HubApiError(failure === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_TOKEN_INVALID', {
          status: 401,
          message:
            failure === 'revoked'
              ? errorMessage('DEVICE_REVOKED')
              : errorMessage('DEVICE_TOKEN_INVALID'),
        })
      }
      response = await this.requestRaw(path, { ...options, bearer: refreshed.accessToken })
      if (response.status === 401) {
        const retryPayload = await this.readErrorPayload(response)
        if (!isRefreshableCode(retryPayload.code ?? '')) {
          if (retryPayload.code === 'DEVICE_REVOKED') {
            this.lastAuthFailure = 'revoked'
            await this.clearAndNotify('device-revoked')
            throw new HubApiError('DEVICE_REVOKED', {
              status: 401,
              message: errorMessage('DEVICE_REVOKED'),
            })
          }
          throw new HubApiError(retryPayload.code ?? 'UNAUTHENTICATED', {
            status: 401,
            message: errorMessage(retryPayload.code ?? 'UNAUTHENTICATED'),
            detail: retryPayload.message,
            retryAfterSec: retryPayload.retryAfterSec,
          })
        }
        // 刚刷新过的 access 仍被判无效：不无限重试，也不清令牌（避免踢人）。
        throw new HubApiError('DEVICE_TOKEN_INVALID', {
          status: 401,
          message: errorMessage('DEVICE_TOKEN_INVALID'),
          detail: retryPayload.message,
        })
      }
    }
    return response
  }

  /** 读取错误体（消费 body）。用于 401 分支先判 code，再决定 refresh / 回登录页。 */
  private async readErrorPayload(response: Response): Promise<{
    code?: string
    message?: string
    retryAfterSec?: number
  }> {
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      return {}
    }
    const envelope = HubErrorEnvelopeSchema.safeParse(json)
    if (!envelope.success) return {}
    const error = envelope.data.error
    const details: Record<string, unknown> | undefined = error?.details ?? envelope.data.details
    const retryAfterSec =
      details && typeof details.retryAfterSec === 'number' ? details.retryAfterSec : undefined
    return {
      code: error?.code ?? envelope.data.code,
      message: error?.message ?? envelope.data.message,
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
    }
  }

  private async requestWithAuth(path: string, options: RequestOptions): Promise<Response> {
    if (options.auth === false) return this.requestRaw(path, options)
    let tokens = await this.requireTokens()
    if (isAccessExpired(tokens, this.now())) {
      const refreshed = await this.refreshTokens()
      if (!refreshed) {
        // 刷新失败时区分两种语义（UI 据此决定「静默恢复登录」还是「回登录页」）：
        //  - 设备被吊销：doRefresh 已经清令牌并通知 onAuthLost，这里抛 DEVICE_REVOKED；
        //  - 令牌无效/刷新被拒：可能是宽限期内的旧 refresh 重放，抛 DEVICE_TOKEN_INVALID，
        //    上层可以先用记住的口令静默登录回来（0.2.14）。
        const revoked = this.lastAuthFailure === 'revoked'
        throw new HubApiError(revoked ? 'DEVICE_REVOKED' : 'DEVICE_TOKEN_INVALID', {
          status: 401,
          message: errorMessage(revoked ? 'DEVICE_REVOKED' : 'DEVICE_TOKEN_INVALID'),
        })
      }
      tokens = refreshed
    }
    return this.requestRaw(path, { ...options, bearer: tokens.accessToken })
  }

  private async requestRaw(
    path: string,
    options: RequestOptions & { bearer?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    // 二进制体（语音 WAV）优先：它不会被 JSON.stringify，Content-Type 由调用方给。
    let payload: BodyInit | undefined
    if (options.bodyBytes !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream'
      payload = options.bodyBytes as unknown as BodyInit
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(options.body)
    }
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
    if (this.opts.clientName) {
      headers['X-DSH-Client'] = `${this.opts.clientName}/${this.opts.clientVersion ?? '0'}`
    }
    return this.fetchOnce(
      path,
      { method: options.method ?? 'GET', body: payload, headers },
      options.timeoutMs ?? this.timeoutMs,
      options.signal,
    )
  }

  /**
   * 发一次请求；网络层失败或被拦截页时尝试换入口并**重放一次**（0.4.11）。
   *
   * 只有这两类失败才换：fetch 抛异常 / 超时 / HTTP 403 且响应不是 JSON（阿里云拦截页）。
   * Hub 正常返回的 JSON 业务错误（401/403/429/5xx）原样返回给上层，不换入口。
   * 换之前先探另一个入口的 `GET /api/health`（4 秒）：不通就不换；网络层失败保留原始错误，
   * 被拦截页则**按网络错误上报**（没有可用入口时，用户该看到「网络检测」，而不是 403）。
   */
  private async fetchOnce(
    path: string,
    init: { method: string; body?: BodyInit; headers?: Record<string, string> },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    await this.origins.ensureReady()
    let failoverTried = false
    for (;;) {
      const originAtStart = this.origins.current
      try {
        const response = await this.fetchOnceAt(originAtStart, path, init, timeoutMs, signal)
        const intercepted = await this.isInterceptPage(response)
        if (!intercepted) return response
        // 被拦截页（HTML 403）：对用户来说等价于「服务器连不上」，不是 Hub 的业务错误。
        // 先试着换入口；换不成也要按网络错误抛出去 —— 否则界面会显示一句莫名其妙的
        // 「没有权限」，而登录页的「网络检测」也不会出现（0.4.11 / WP52）。
        if (failoverTried) throw this.interceptError()
        failoverTried = true
        if (!(await this.tryFailover('blocked-page', originAtStart))) throw this.interceptError()
        continue
      } catch (error) {
        const reason = this.failoverReasonOf(error)
        if (reason === null || failoverTried) throw error
        failoverTried = true
        if (!(await this.tryFailover(reason, originAtStart))) throw error
        // 换到了别的入口：同一次调用重放（body 是 string/Uint8Array，可复用）。
        // 外部取消已经发生就别重放了（否则会白连一次）。
        if (signal?.aborted === true) throw error
      }
    }
  }

  /**
   * 这次失败值不值得换入口：网络错误/超时换，取消与业务错误不换。
   *
   * 只认真正的连接层失败（`fetch` 抛 TypeError / DOMException 带的网络错误）；
   * 自己代码里的其它异常一律不重试，别把 bug 藏进「换个入口又好了」。
   */
  private failoverReasonOf(error: unknown): FailoverReason | null {
    if (error instanceof HubApiError) {
      if (error.code === 'network') return 'network'
      if (error.code === 'timeout') return 'timeout'
      return null
    }
    if (error instanceof TypeError) return 'network'
    const name = (error as { name?: unknown } | null)?.name
    if (typeof name === 'string' && (name === 'NetworkError' || name === 'AbortError')) {
      return name === 'NetworkError' ? 'network' : null
    }
    return null
  }

  /** 403 + 非 JSON 的响应体 = 被中间层拦截（读 clone，不消费原响应）。 */
  private async isInterceptPage(response: Response): Promise<boolean> {
    if (response.status !== 403) return false
    const contentType = response.headers.get('content-type')
    let bodyHead = ''
    if (typeof response.clone === 'function') {
      try {
        const text = await response.clone().text()
        bodyHead = text.slice(0, 256)
      } catch {
        /* 读不到 body 就只看 content-type */
      }
    }
    return looksLikeInterceptPage({ status: response.status, contentType, bodyHead })
  }

  /**
   * 试着换到别的入口；返回 true 表示当前入口已经变了（调用方可以重放）。
   * 单入口 / 冷却中 / 探测失败都返回 false。
   */
  private async tryFailover(
    reason: FailoverReason,
    originAtStart: string,
  ): Promise<boolean> {
    await this.origins.failover(reason)
    return this.origins.current !== originAtStart
  }

  /** 被拦截页且没有可用备用入口：按网络层失败上报（登录页据此显示「网络检测」）。 */
  private interceptError(): HubApiError {
    return new HubApiError('network', {
      status: 403,
      message: errorMessage('network'),
      retryable: true,
      detail: 'intercept-page: 403 non-json',
    })
  }

  private async fetchOnceAt(
    origin: string,
    path: string,
    init: { method: string; body?: BodyInit; headers?: Record<string, string> },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (signal?.aborted === true) {
      throw new HubApiError('cancelled', {
        status: 0,
        message: errorMessage('cancelled'),
        detail: 'request: aborted before send',
      })
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    // 外部取消（停止朗读）：直接断掉这次 fetch（也会断掉已在读的响应体）。
    const onAbort = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    let handed = false
    try {
      const response = await this.fetchImpl(`${origin}${path}`, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      })
      // 响应体可能还在流式传输：**不摘** abort 监听，否则停止朗读时断不掉连接；
      // 监听是一次性的（abort 触发后自动移除），控制器随请求一起回收。
      handed = true
      return response
    } catch (error) {
      if (timedOut) throw new HubApiError('timeout', { message: errorMessage('timeout'), retryable: true })
      if (signal?.aborted) {
        throw new HubApiError('cancelled', {
          status: 0,
          message: errorMessage('cancelled'),
          detail: 'request: aborted',
        })
      }
      throw this.toNetworkError(error)
    } finally {
      clearTimeout(timer)
      if (!handed) signal?.removeEventListener('abort', onAbort)
    }
  }

  private toNetworkError(error: unknown): HubApiError {
    if (error instanceof HubApiError) return error
    return new HubApiError('network', {
      message: errorMessage('network'),
      retryable: true,
      detail: String((error as Error)?.message ?? error),
    })
  }

  private async parseBody<T>(
    response: Response,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<T> {
    let json: unknown
    try {
      json = await response.json()
    } catch {
      throw new HubApiError('protocol', {
        status: response.status,
        message: errorMessage('protocol'),
        detail: `${label}: invalid-json`,
      })
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new HubApiError('protocol', {
        status: response.status,
        message: errorMessage('protocol'),
        detail: `${label}: ${parsed.error.issues.map((i) => i.path.join('.')).join(',')}`,
      })
    }
    return parsed.data
  }

  private async toApiError(response: Response): Promise<HubApiError> {
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
    const details: Record<string, unknown> | undefined =
      error?.details ?? (envelope.success ? envelope.data.details : undefined)
    const retryAfterSec =
      details && typeof details.retryAfterSec === 'number' ? details.retryAfterSec : undefined
    const code = serverCode ?? codeFromHttpStatus(response.status)
    return new HubApiError(code, {
      status: response.status,
      // 界面只显示中文映射；服务端原文放 detail，便于本地诊断。
      message: errorMessage(code),
      retryable: response.status >= 500 || isRetryableCode(code),
      detail: serverMessage,
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
    })
  }
}
