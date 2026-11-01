import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import type { ReadableStreamReadResult } from 'node:stream/web'
import {
  MOBILE_TTS_MAX_CHARS,
  MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX,
  type MobileTtsVoice,
} from '@dsh-hub/shared'
import type { AppDeps, RequestMeta } from '../../context.js'
import { createWindowCounter } from '../../lib/rate-limit.js'
import { HubError } from '../../lib/errors.js'
import type { SessionUser } from '../../lib/session.js'

/**
 * 朗读（WP50）：把 App 传来的一段文字合成成语音，转发给本机星汐语音服务（`seki-voice`）。
 *
 * 边界（与 `packages/shared/src/api/mobile.ts` 的契约一致）：
 * - **不存文字、不落音频**：文字只在请求里过一遍，音频只在内存 LRU 里（上限默认 64MB，可配 0 关掉）；
 * - 审计只有 `{voice, chars, bytes, ms, cached, ok}`，日志只有状态码；
 * - **绝不把别的声音冒充星汐**：上游降级到 piper（`x-seki-tts-degraded`）或后端不是该音色的
 *   `backend`，一律按失败（502）处理，不返回、不缓存；
 * - GPU 有全局锁，同一时间只能合成一句：Hub 侧**全局串行**（1 个在途 + 最多 6 个排队，可配常量），
 *   单用户最多 2 个在途/排队；队列满或用户超额回 429（带 `retryAfterSec`）；
 * - `bootstrap.voice.tts.enabled` 取上游 `/health` 的 `breeze.ready`，30 秒缓存（失败也是 false）。
 *
 * 流式朗读（WP51，`POST /api/mobile/tts/stream`）在同一个 service 里，与整段 `/tts` **共用**
 * 排队、限流、音色校验、缓存与审计：
 * - 一个流式请求在**整个上游流期间**占一个全局槽位（直到上游正常结束/失败/超时）；
 * - 缓存命中直接回 PCM（去掉 WAV 头）；未命中以流方式请求上游 `/tts/stream`，逐块转发；
 * - 上游正常结束才把整段 PCM 包成 WAV 写缓存（两种接口互相命中）；
 * - 上游中途失败/超时 → 销毁客户端连接（不发结束块）、不写缓存；
 * - 客户端提前断开 → 停止写客户端，但**继续读完上游**（避免星汐服务半截状态），读完后仍可写缓存。
 */

/** 朗读入口路径（路由、测试与文档共用一份字符串）。 */
export const MOBILE_TTS_PATH = '/api/mobile/tts'

/** 流式朗读入口路径（契约 `MOBILE_TTS_STREAM_PATH`；插件内注册时用去掉 `/api/mobile` 的短路径）。 */
export const MOBILE_TTS_STREAM_ROUTE = '/tts/stream'

/** 单段文字的响应内容类型（契约：`audio/wav`，24kHz 单声道 16bit）。 */
export const TTS_CONTENT_TYPE = 'audio/wav'

/** 成功响应的客户端缓存时长（与契约一致：App 重复朗读同一段不再问 Hub）。 */
export const TTS_CACHE_CONTROL = 'private, max-age=86400'

/** 流式响应的 PCM 格式（契约响应头 `x-tts-format`）。 */
export const TTS_STREAM_FORMAT = 'pcm16le'

/** 流式响应不缓存（边合成边下发；浏览器/中间代理都不该把它留下来）。 */
export const TTS_STREAM_CACHE_CONTROL = 'no-store'

/** 流式 PCM 的响应内容类型（契约 `audio/L16; rate=<采样率>; channels=1`）。 */
export function ttsStreamContentType(sampleRate: number): string {
  return `${MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX}; rate=${sampleRate}; channels=1`
}

/**
 * 流式朗读的默认超时（配置里可改，测试用小的值跑）：
 * - 整段 60 秒（200 字 ≈ 36 秒音频，边合成边下发与音频时长同量级）；
 * - 两块之间 10 秒（这么久没新音频 = 上游卡住/断链）。
 */
export const TTS_STREAM_TIMEOUT_MS = 60_000
export const TTS_STREAM_IDLE_TIMEOUT_MS = 10_000

/** 健康检查缓存：30 秒（与 ASR / 云节点探测同一口径）。 */
export const TTS_HEALTH_TTL_MS = 30_000
/** 健康探测超时：本机服务，1.5 秒足够；不要让 bootstrap 等太久。 */
export const TTS_HEALTH_TIMEOUT_MS = 1_500

/** 排队上限：正在合成的 1 个之外，最多再排 6 个（第 8 个直接 429）。 */
export const TTS_QUEUE_MAX_WAITING = 6
/** 单用户最多 2 个在途/排队（连点朗读时挡在 Hub，不打到 GPU）。 */
export const TTS_PER_USER_INFLIGHT = 2
/** 队列满时让 App 等 3 秒再试（契约 `retryAfterSec`）。 */
export const TTS_QUEUE_RETRY_AFTER_SEC = 3
/** 单用户已有 2 段在途/排队时的等待秒数。 */
export const TTS_USER_BUSY_RETRY_AFTER_SEC = 2

/**
 * 音色表的一项：**可扩展的配置结构**。
 *
 * 加新音色只需要往 `MOBILE_TTS_VOICES` 里加一行：
 * - `id` / `name` / `description` 直接进 `bootstrap.voice.tts.voices`（契约 `MobileTtsVoiceSchema`）；
 * - `backend` 是转发给 `seki-voice` 的后端名，也是**验收条件**：响应头
 *   `x-seki-tts-backend` 必须等于它，否则视为「不是这个音色」→ 502（防止降级到 piper 冒充）。
 */
export interface TtsVoiceConfig {
  /** 契约里的音色 id（App 传这个） */
  id: string
  /** 展示名（设置页） */
  name: string
  /** 一句话介绍（设置页） */
  description?: string
  /** 合成服务的后端名（`breeze` = 星汐本人的音色） */
  backend: string
}

/** 当前只有一个音色：星汐 seki（本机 breeze 后端）。 */
export const MOBILE_TTS_VOICES: readonly TtsVoiceConfig[] = [
  {
    id: 'seki',
    name: '星汐 seki',
    description: '温柔俏皮的少女音（本机合成）',
    backend: 'breeze',
  },
]

/** 默认音色 id（契约 `bootstrap.voice.tts.defaultVoice`）。 */
export const MOBILE_TTS_DEFAULT_VOICE = 'seki'

/** 音色表 → 契约形状（只回白名单字段，`backend` 不外泄）。 */
export function mobileTtsVoices(): MobileTtsVoice[] {
  return MOBILE_TTS_VOICES.map((voice) => ({
    id: voice.id,
    name: voice.name,
    ...(voice.description === undefined ? {} : { description: voice.description }),
  }))
}

/** `bootstrap.voice.tts`（缺失 = 老 Hub，App 不显示朗读入口）。 */
export interface MobileTtsBootstrap {
  enabled: boolean
  voices: MobileTtsVoice[]
  defaultVoice: string | null
  maxChars: number
  /** WP51：支持流式朗读 `POST /api/mobile/tts/stream`（老 Hub 不发这个字段 = 只能整段） */
  stream: boolean
}

/**
 * `stream` 只在「朗读可用 + `HUB_TTS_STREAM_ENABLED`」时为 true：
 * 朗读整体关掉时 App 根本不显示入口，不需要再区分流式与否。
 */
export function mobileTtsInfo(enabled: boolean, streamEnabled = false): MobileTtsBootstrap {
  return {
    enabled,
    voices: mobileTtsVoices(),
    defaultVoice: MOBILE_TTS_DEFAULT_VOICE,
    maxChars: MOBILE_TTS_MAX_CHARS,
    stream: enabled && streamEnabled,
  }
}

/** 按 id 找音色；未知音色抛 `VALIDATION_FAILED`（**不静默回退**到默认音色）。 */
export function resolveTtsVoice(raw: string | undefined): TtsVoiceConfig {
  const id = raw ?? MOBILE_TTS_DEFAULT_VOICE
  const voice = MOBILE_TTS_VOICES.find((candidate) => candidate.id === id)
  if (voice === undefined) {
    throw new HubError('VALIDATION_FAILED', `未知音色：${id}`)
  }
  return voice
}

export interface MobileTtsRequest {
  user: SessionUser
  /** 已按契约 trim 过的文字（1–200 字） */
  text: string
  /** 音色 id；缺省用默认音色 */
  voice: string | undefined
  meta: RequestMeta
}

export interface MobileTtsAudio {
  wav: Buffer
  /** 采样率（写响应头 `x-tts-sample-rate`） */
  sampleRate: number
  /** 实际使用的音色 id（写响应头 `x-tts-voice`） */
  voice: string
  /** 是否命中 Hub 的内存缓存（审计用，不进响应头） */
  cached: boolean
}

/** 流式朗读的结果：响应头元数据 + PCM 流（正常结束 = 完整音频；error = 合成中断，必须断开连接）。 */
export interface MobileTtsStream {
  /**
   * PCM16LE 单声道原始字节（无 WAV 头）。
   * - 正常 `end`：这一段的音频完整，Hub 已（或不再）写缓存；
   * - `error`：上游中途失败/超时 → 路由必须**中断** HTTP 连接（不发分块结束标记）。
   */
  body: Readable
  /** 采样率（写响应头 `x-tts-sample-rate` 与 content-type 的 `rate=`） */
  sampleRate: number
  /** 实际使用的音色 id（写响应头 `x-tts-voice`） */
  voice: string
  /** 是否命中 Hub 的内存缓存（写响应头 `x-tts-cached: 1|0`） */
  cached: boolean
}

export interface MobileTtsService {
  /** `/health` 的 30 秒缓存结果（`breeze.ready`）；`HUB_TTS_ENABLED=false` 时恒 false */
  available(): Promise<boolean>
  /** 合成一段；按契约抛 `VALIDATION_FAILED` / `RATE_LIMITED` / `UPSTREAM_ERROR` */
  synthesize(input: MobileTtsRequest): Promise<MobileTtsAudio>
  /**
   * 流式合成：返回 PCM 流。**开始下发之前**的错误按契约抛 `VALIDATION_FAILED` /
   * `RATE_LIMITED` / `UPSTREAM_ERROR`（路由此时还没写任何字节，回 JSON）；
   * 返回之后才可能失败（上游中途断开/超时），那由流的 `error` 事件表达。
   */
  stream(input: MobileTtsRequest): Promise<MobileTtsStream>
  /** 队列诊断（测试与排障用）：当前在途、排队长、占用用户数 */
  stats(): { active: number; queued: number; users: number }
}

/** 从 WAV 头读采样率（RIFF/WAVE，fmt 块在第 12 字节起，采样率是小端 u32@24）。 */
export function wavSampleRate(wav: Buffer): number | null {
  if (wav.length < 44) return null
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') return null
  const rate = wav.readUInt32LE(24)
  return rate > 0 && rate <= 384_000 ? rate : null
}

/** WAV 里的 PCM 数据与采样率（流式缓存命中要剥掉 WAV 头）。 */
export interface WavPcm {
  /** `data` 块里的字节（PCM16LE 单声道） */
  pcm: Buffer
  sampleRate: number
}

/**
 * 从 WAV 取 PCM 与采样率：**按 RIFF 块链走**，不假设头就是 44 字节。
 *
 * 上游的 WAV 可能带 `LIST`/`fact` 块（例如加了元信息），硬切 44 字节会把音频切坏；
 * 这里只认 PCM16 单声道的 `data` 块，其它形状一律返回 null（调用方按失败/未命中处理）。
 */
export function wavPcm(wav: Buffer): WavPcm | null {
  if (wav.length < 16) return null
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') return null
  let offset = 12
  let format = 0
  let channels = 0
  let bits = 0
  let sampleRate = 0
  let pcm: Buffer | null = null
  // 块头 8 字节 + 偶数对齐：块链遍历一定往前走，损坏的文件最多走到结尾
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ' && size >= 16 && start + 16 <= wav.length) {
      format = wav.readUInt16LE(start)
      channels = wav.readUInt16LE(start + 2)
      sampleRate = wav.readUInt32LE(start + 4)
      bits = wav.readUInt16LE(start + 14)
    } else if (id === 'data') {
      pcm = wav.subarray(start, Math.min(start + size, wav.length))
      break
    }
    offset = start + size + (size % 2)
  }
  if (pcm === null || format !== 1 || channels !== 1 || bits !== 16) return null
  if (!(sampleRate > 0 && sampleRate <= 384_000)) return null
  return { pcm, sampleRate }
}

/** PCM16LE 单声道 → 44 字节标准头 WAV（与 `/tts` 的产物同形状，两种接口共用一份缓存）。 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byteRate
  header.writeUInt16LE(2, 32) // blockAlign
  header.writeUInt16LE(16, 34) // bits
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** 从 media type 里取整型参数（`rate=24000` / `channels=1`）；没有或不合法 → null。 */
export function mediaTypeParam(mediaType: string, name: string): number | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*"?(-?\\d+)"?`, 'iu').exec(mediaType)
  if (match === null || match[1] === undefined) return null
  const value = Number(match[1])
  return Number.isInteger(value) ? value : null
}

/**
 * 等背压解除：`write()` 返回 false 时等 `drain`；流被销毁（客户端走了）时也用同一个
 * Promise 唤醒，避免永远挂在没有 drain 的流上。
 */
export function waitForDrain(stream: PassThrough): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed) {
      resolve()
      return
    }
    const done = (): void => {
      stream.off('drain', done)
      stream.off('close', done)
      resolve()
    }
    stream.once('drain', done)
    stream.once('close', done)
  })
}

/** 缓存键：`(voice, 文字)` 的 sha256（不把文字本身留在内存键里）。 */
export function ttsCacheKey(voiceId: string, text: string): string {
  return createHash('sha256').update(`${voiceId}\u0000${text}`, 'utf8').digest('hex')
}

interface CachedAudio {
  wav: Buffer
  sampleRate: number
}

/** 按总字节数做上限的 LRU（命中即刷新顺序；单条超限就不缓存，不挤掉别人）。 */
function createAudioCache(capacityBytes: number): {
  get(key: string): CachedAudio | null
  set(key: string, value: CachedAudio): void
  stats(): { entries: number; bytes: number }
} {
  const entries = new Map<string, CachedAudio>()
  let bytes = 0

  return {
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return null
      entries.delete(key)
      entries.set(key, hit)
      return hit
    },
    set(key, value) {
      if (capacityBytes <= 0) return
      const size = value.wav.length
      if (size > capacityBytes) return
      const existing = entries.get(key)
      if (existing !== undefined) {
        entries.delete(key)
        bytes -= existing.wav.length
      }
      entries.set(key, value)
      bytes += size
      for (const [oldKey, old] of entries) {
        if (bytes <= capacityBytes) break
        entries.delete(oldKey)
        bytes -= old.wav.length
      }
    },
    stats() {
      return { entries: entries.size, bytes }
    },
  }
}

/**
 * 全局合成队列：**同时只放 1 个请求进 GPU 服务**，其余排队。
 *
 * 语义：
 * - 空闲 → 立即在途；
 * - 忙 → 排队（最多 `maxWaiting` 个，含正在合成的共 `maxWaiting + 1` 个被受理）；
 * - 排队满 → 429 `RATE_LIMITED`（`retryAfterSec = fullRetryAfterSec`）；
 * - 同一用户已在途+排队 ≥ `perUser` → 429（`retryAfterSec = busyRetryAfterSec`）。
 *
 * `run` 适合「拿到最终结果才释放槽位」的整段合成；流式朗读用 `acquire` / `release`
 * （槽位要占**整个上游流期间**，拿不到结果就返回给路由先发响应头）。
 */
function createSynthQueue(opts: {
  maxWaiting: number
  perUser: number
  fullRetryAfterSec: number
  busyRetryAfterSec: number
}): {
  run<T>(user: string, task: () => Promise<T>): Promise<T>
  acquire(user: string): Promise<void>
  release(user: string): void
  stats(): { active: number; queued: number; users: number }
} {
  let active = 0
  const waiters: Array<{ user: string; grant: () => void }> = []
  const perUser = new Map<string, number>()

  function acquire(user: string): Promise<void> {
    const used = perUser.get(user) ?? 0
    if (used >= opts.perUser) {
      return Promise.reject(
        new HubError('RATE_LIMITED', '上一段还在合成，请稍后再试', {
          retryAfterSec: opts.busyRetryAfterSec,
        }),
      )
    }
    if (active === 0) {
      active = 1
      perUser.set(user, used + 1)
      return Promise.resolve()
    }
    if (waiters.length >= opts.maxWaiting) {
      return Promise.reject(
        new HubError('RATE_LIMITED', '朗读合成排队已满，请稍后再试', {
          retryAfterSec: opts.fullRetryAfterSec,
        }),
      )
    }
    perUser.set(user, used + 1)
    return new Promise<void>((grant) => {
      waiters.push({ user, grant })
    })
  }

  function release(user: string): void {
    const used = perUser.get(user) ?? 0
    if (used <= 1) perUser.delete(user)
    else perUser.set(user, used - 1)
    const next = waiters.shift()
    if (next !== undefined) {
      // 槽位直接交给下一个：`active` 保持 1，不经过 0（避免并发插入）
      next.grant()
      return
    }
    active = 0
  }

  return {
    async run(user, task) {
      await acquire(user)
      try {
        return await task()
      } finally {
        release(user)
      }
    },
    acquire,
    release,
    stats() {
      return { active, queued: waiters.length, users: perUser.size }
    },
  }
}

export function createMobileTtsService(deps: AppDeps): MobileTtsService {
  const { config, clock, audit, logger } = deps
  const minuteLimit = createWindowCounter({ capacity: config.ttsPerMinute, windowMs: 60_000, clock })
  const dayLimit = createWindowCounter({ capacity: config.ttsPerDay, windowMs: 86_400_000, clock })
  const cache = createAudioCache(config.ttsCacheBytes)
  const queue = createSynthQueue({
    maxWaiting: TTS_QUEUE_MAX_WAITING,
    perUser: TTS_PER_USER_INFLIGHT,
    fullRetryAfterSec: TTS_QUEUE_RETRY_AFTER_SEC,
    busyRetryAfterSec: TTS_USER_BUSY_RETRY_AFTER_SEC,
  })

  let health = { at: Number.NEGATIVE_INFINITY, value: false }
  let probe: Promise<boolean> | null = null

  function auditTts(user: SessionUser, meta: RequestMeta, detail: Record<string, unknown>): void {
    audit.log({
      actorId: user.id,
      actorIp: meta.ip,
      action: 'mobile.tts',
      targetType: 'user',
      targetId: user.id,
      detail,
    })
  }

  async function probeHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${config.ttsUrl}/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TTS_HEALTH_TIMEOUT_MS),
      })
      if (!response.ok) return false
      const body = (await response.json()) as { breeze?: { ready?: unknown } }
      // 只有 breeze（星汐音色）就绪才算「能朗读」；piper 兜底不是星汐的声音
      return body.breeze?.ready === true
    } catch {
      return false
    }
  }

  async function available(): Promise<boolean> {
    if (!config.ttsEnabled) return false
    const now = clock.now().getTime()
    if (now - health.at < TTS_HEALTH_TTL_MS) return health.value
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

  /** 每用户「段」配额：命中缓存也算一段（规则简单一致），被限流/排队拒掉的不算 */
  function consumeLimit(user: SessionUser): void {
    for (const limiter of [minuteLimit, dayLimit]) {
      const decision = limiter.consume(String(user.id))
      if (!decision.allowed) {
        throw new HubError('RATE_LIMITED', '朗读太频繁，请稍后再试', {
          retryAfterSec: decision.retryAfterSec,
        })
      }
    }
  }

  /**
   * 上游降级判定：`x-seki-tts-degraded` 为真（任意非空/非 0 值），或后端名对不上
   * （含**缺失**：宁可 502 也不把来路不明的声音当星汐），一律失败。
   */
  function degradedReason(response: Response, voice: TtsVoiceConfig): string | null {
    const degraded = response.headers.get('x-seki-tts-degraded')
    if (degraded !== null && degraded.trim() !== '' && degraded !== '0' && degraded !== 'false') {
      return `degraded:${degraded.trim()}`
    }
    const backend = (response.headers.get('x-seki-tts-backend') ?? '').trim()
    if (backend !== voice.backend) return `backend:${backend === '' ? 'missing' : backend}`
    return null
  }

  async function synthesize(input: MobileTtsRequest): Promise<MobileTtsAudio> {
    const started = performance.now()
    const elapsed = (): number => Math.round(performance.now() - started)
    const voice = resolveTtsVoice(input.voice)
    const text = input.text
    const chars = text.length
    const key = ttsCacheKey(voice.id, text)

    if (!config.ttsEnabled) {
      throw new HubError('UPSTREAM_ERROR', '朗读未启用')
    }

    const cachedAudio = cache.get(key)
    if (cachedAudio !== null) {
      consumeLimit(input.user)
      auditTts(input.user, input.meta, {
        voice: voice.id,
        chars,
        bytes: cachedAudio.wav.length,
        ms: elapsed(),
        cached: true,
        ok: true,
      })
      return { wav: cachedAudio.wav, sampleRate: cachedAudio.sampleRate, voice: voice.id, cached: true }
    }

    return queue.run(String(input.user.id), async () => {
      // 真正要占用 GPU 了才计配额：排队被拒、限流被拒都不消耗用户额度
      consumeLimit(input.user)

      let response: Response
      try {
        response = await fetch(`${config.ttsUrl}/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: TTS_CONTENT_TYPE },
          body: JSON.stringify({ text, backend: voice.backend }),
          signal: AbortSignal.timeout(config.ttsTimeoutMs),
        })
      } catch {
        // 连接拒绝 / DNS / 45 秒超时：对外一律 502，细节不进响应体
        auditTts(input.user, input.meta, { voice: voice.id, chars, ms: elapsed(), cached: false, ok: false })
        throw new HubError('UPSTREAM_ERROR', '朗读合成服务不可用')
      }

      if (response.status !== 200) {
        // 读完错误体再丢，避免连接悬着；上游文案不转发给 App（契约只认错误码）
        await response.arrayBuffer().catch(() => undefined)
        logger.debug({ status: response.status, chars }, 'mobile.tts upstream non-200')
        auditTts(input.user, input.meta, { voice: voice.id, chars, ms: elapsed(), cached: false, ok: false })
        if (response.status === 400) {
          throw new HubError('VALIDATION_FAILED', '这段文字没法合成语音')
        }
        throw new HubError('UPSTREAM_ERROR', '朗读合成失败')
      }

      const degraded = degradedReason(response, voice)
      if (degraded !== null) {
        await response.arrayBuffer().catch(() => undefined)
        logger.debug({ reason: degraded, chars }, 'mobile.tts degraded')
        auditTts(input.user, input.meta, { voice: voice.id, chars, ms: elapsed(), cached: false, ok: false })
        throw new HubError('UPSTREAM_ERROR', '朗读合成降级（不是星汐的声音）')
      }

      const wav = Buffer.from(await response.arrayBuffer())
      const wavRate = wavSampleRate(wav)
      if (wavRate === null) {
        // 200 但不是一个 WAV（例如代理的 HTML 错误页）：不返回、不缓存
        auditTts(input.user, input.meta, { voice: voice.id, chars, ms: elapsed(), cached: false, ok: false })
        throw new HubError('UPSTREAM_ERROR', '朗读合成返回了非 WAV 内容')
      }
      const headerRate = Number(response.headers.get('x-seki-tts-sample-rate') ?? '')
      const sampleRate = Number.isInteger(headerRate) && headerRate > 0 ? headerRate : wavRate

      cache.set(key, { wav, sampleRate })
      auditTts(input.user, input.meta, {
        voice: voice.id,
        chars,
        bytes: wav.length,
        ms: elapsed(),
        cached: false,
        ok: true,
      })
      return { wav, sampleRate, voice: voice.id, cached: false }
    })
  }

  /**
   * 流式上游的响应头校验（契约 WP51）：`audio/L16`、单声道、breeze、采样率可读。
   * 任何一项不对就返回原因 —— 调用方**在发任何字节之前**回 502（不回、不缓存）。
   */
  function streamUpstreamProblem(
    response: Response,
    voice: TtsVoiceConfig,
  ): { sampleRate: number } | { reason: string } {
    const contentType = (response.headers.get('content-type') ?? '').trim()
    if (!contentType.toLowerCase().startsWith(MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX.toLowerCase())) {
      return { reason: `content-type:${contentType === '' ? 'missing' : contentType}` }
    }
    const channels = mediaTypeParam(contentType, 'channels')
    // 契约只回单声道；上游给了多声道就没法原样当 pcm16le 转发
    if (channels !== null && channels !== 1) return { reason: `channels:${channels}` }
    // 降级判定与 `/tts` 同一份：`backend` 必须是该音色的后端（含缺失）
    const degraded = degradedReason(response, voice)
    if (degraded !== null) return { reason: degraded }
    const headerRate = Number((response.headers.get('x-seki-tts-sample-rate') ?? '').trim())
    const rate =
      Number.isInteger(headerRate) && headerRate > 0 && headerRate <= 384_000
        ? headerRate
        : mediaTypeParam(contentType, 'rate')
    if (rate === null || rate <= 0 || rate > 384_000) return { reason: 'sample-rate:missing' }
    return { sampleRate: rate }
  }

  async function stream(input: MobileTtsRequest): Promise<MobileTtsStream> {
    const started = performance.now()
    const elapsed = (): number => Math.round(performance.now() - started)
    const voice = resolveTtsVoice(input.voice)
    const text = input.text
    const chars = text.length
    const key = ttsCacheKey(voice.id, text)
    const userKey = String(input.user.id)

    if (!config.ttsEnabled || !config.ttsStreamEnabled) {
      throw new HubError('UPSTREAM_ERROR', '流式朗读未启用')
    }

    // ── 缓存命中：整段 PCM 一次发完（契约 `x-tts-cached: 1`），不占队列、不打上游 ──
    const cachedAudio = cache.get(key)
    if (cachedAudio !== null) {
      const parsed = wavPcm(cachedAudio.wav)
      if (parsed !== null) {
        consumeLimit(input.user)
        auditTts(input.user, input.meta, {
          voice: voice.id,
          chars,
          bytes: parsed.pcm.length,
          ms: elapsed(),
          cached: true,
          ok: true,
          stream: true,
          ttfbMs: 0,
        })
        return {
          body: Readable.from([parsed.pcm], { objectMode: false }),
          sampleRate: parsed.sampleRate,
          voice: voice.id,
          cached: true,
        }
      }
      // 缓存里不是 PCM16 单声道 WAV（理论上不会）：当未命中，继续走上游
    }

    /**
     * 槽位占**整个上游流期间**：`acquire` 之后要么在这里释放（开流失败），
     * 要么交给下面的 pump 在读完后释放。`release` 是幂等的副作用（perUser 减一 +
     * 可能把槽位直接转交给下一个等待者），所以必须**恰好调用一次**。
     */
    await queue.acquire(userKey)
    let handedOff = false
    try {
      // 真正要占用 GPU 了才计配额：排队被拒、限流被拒都不消耗用户额度
      consumeLimit(input.user)

      const controller = new AbortController()
      // 整段超时：从发起上游请求开始算，超过就 abort（= 上游失败，断开客户端）
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.ttsStreamTimeoutMs)])

      let response: Response
      try {
        response = await fetch(`${config.ttsUrl}/tts/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX },
          body: JSON.stringify({ text, backend: voice.backend }),
          signal,
        })
      } catch {
        // 连接拒绝 / DNS / 拿响应头前就超时：对外一律 502（还没发任何字节）
        auditTts(input.user, input.meta, {
          voice: voice.id,
          chars,
          ms: elapsed(),
          cached: false,
          ok: false,
          stream: true,
        })
        throw new HubError('UPSTREAM_ERROR', '朗读合成服务不可用')
      }

      /** 开流前的失败：断开上游连接、审计，返回要抛的错（调用方回 JSON，不发音频） */
      const rejectStream = (reason: string, message: string, status?: 400): HubError => {
        controller.abort()
        logger.debug({ reason, chars, stream: true }, 'mobile.tts stream rejected')
        auditTts(input.user, input.meta, {
          voice: voice.id,
          chars,
          ms: elapsed(),
          cached: false,
          ok: false,
          stream: true,
        })
        if (status === 400) return new HubError('VALIDATION_FAILED', '这段文字没法合成语音')
        return new HubError('UPSTREAM_ERROR', message)
      }

      if (response.status !== 200) {
        throw rejectStream(
          `status:${response.status}`,
          '朗读合成失败',
          response.status === 400 ? 400 : undefined,
        )
      }

      const problem = streamUpstreamProblem(response, voice)
      if ('reason' in problem) {
        throw rejectStream(problem.reason, '朗读合成返回了非流式音频')
      }
      const { sampleRate } = problem

      const upstream = response.body
      if (upstream === null) {
        throw rejectStream('body:missing', '朗读合成返回了空响应')
      }

      // ── 逐块转发：`PassThrough` + `write` 的返回值就是背压信号 ──
      const body = new PassThrough({ highWaterMark: 64 * 1024 })
      const collected: Buffer[] = []
      let bytes = 0
      let ttfbMs: number | null = null
      let clientGone = false
      // 客户端断开时 Fastify 会 destroy 这个流：停止往客户端写，但上游继续读完
      body.once('close', () => {
        clientGone = true
      })
      // 中途失败时我们自己 destroy(err)；这里接住，避免 unhandled 'error'
      body.on('error', () => {
        clientGone = true
      })

      const reader = upstream.getReader()

      /** 读一块；两块之间超过空闲超时就 abort 上游（= 上游失败） */
      async function readNext(): Promise<ReadableStreamReadResult<Uint8Array>> {
        let timer: NodeJS.Timeout | undefined
        const idle = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error(`idle ${config.ttsStreamIdleTimeoutMs}ms`))
          }, config.ttsStreamIdleTimeoutMs)
          timer.unref?.()
        })
        const reading = reader.read()
        // abort 之后这一次读会 reject：先接住，别变成 unhandled rejection
        reading.catch(() => undefined)
        try {
          return await Promise.race([reading, idle])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }

      const pump = (async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await readNext()
            if (done) break
            if (value === undefined || value.byteLength === 0) continue
            const chunk = Buffer.from(value)
            if (ttfbMs === null) ttfbMs = elapsed()
            bytes += chunk.length
            collected.push(chunk)
            if (clientGone || body.destroyed) continue // 客户端走了：只读不写
            if (!body.write(chunk)) await waitForDrain(body)
          }

          // 上游正常结束（分块有结束标记）= 这一段是完整的：写缓存（两种接口共用）
          if (bytes > 0) cache.set(key, { wav: pcmToWav(Buffer.concat(collected), sampleRate), sampleRate })
          auditTts(input.user, input.meta, {
            voice: voice.id,
            chars,
            bytes,
            ms: elapsed(),
            cached: false,
            // 客户端提前走了：合成本身是成功的（也写进了缓存），但这一条请求算不上 ok
            ok: !clientGone,
            stream: true,
            ttfbMs: ttfbMs ?? 0,
            ...(clientGone ? { aborted: 'client' } : {}),
          })
          if (!clientGone && !body.destroyed) body.end()
        } catch (error) {
          // 上游中断 / 整段超时 / 空闲超时：**不写缓存**，让客户端看到连接被中断
          controller.abort()
          logger.debug(
            { chars, stream: true, reason: error instanceof Error ? error.message : String(error) },
            'mobile.tts stream aborted',
          )
          auditTts(input.user, input.meta, {
            voice: voice.id,
            chars,
            bytes,
            ms: elapsed(),
            cached: false,
            ok: false,
            stream: true,
            ...(ttfbMs === null ? {} : { ttfbMs }),
            ...(clientGone ? { aborted: 'client' } : {}),
          })
          if (!clientGone && !body.destroyed) {
            body.destroy(error instanceof Error ? error : new Error('tts stream failed'))
          }
        } finally {
          // 上游读完了（成功或失败）：槽位还给队列，下一个请求可以进
          queue.release(userKey)
        }
      })()
      // pump 自己处理全部错误；这里只是不让 lint 抱怨没接住的 Promise
      void pump

      handedOff = true
      return { body, sampleRate, voice: voice.id, cached: false }
    } finally {
      // 还没交给 pump（校验失败/限流/连接拒绝）：槽位当场还回去
      if (!handedOff) queue.release(userKey)
    }
  }

  return { available, synthesize, stream, stats: () => queue.stats() }
}
