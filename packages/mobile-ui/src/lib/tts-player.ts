/**
 * 朗读播放器（0.4.3 / WP50）：一次读一条 AI 回复，**边播边合成**。
 *
 * 时序（服务端合成速度约等于实时，所以只能流水线）：
 *
 *   loading   请求第 1 段 ──► 出声 ──► 播第 1 段，同时预取第 2、3 段
 *                                    播第 2 段，同时预取第 3、4 段 ……
 *
 * 关键约束（任务包 WP50）：
 *  - 一次只读一条回复：`start()` 另一条时先把上一条停掉（reason=switch）；
 *  - **并发请求 ≤ 2**：服务端本来就全局串行，多开只会排队；预取窗口固定 2 段；
 *  - 停止要「立即静音 + 丢弃迟到的段」：`generation` 令牌，停止后任何在飞的响应都不再播放；
 *  - 同一条消息的段落在内存里缓存（默认 30MB LRU），再读不重复请求；
 *  - 429 按 `retryAfterSec` 重试 **1 次**；502/网络错误轻提示「朗读暂时不可用」并停止。
 *
 * 全部依赖注入（合成函数、音频出口、计时、睡眠），单测在 node 里跑真状态机（见
 * test/tts-player.test.ts）；浏览器里的实现见 lib/tts-audio.ts（Web Audio）。
 * 诊断事件只记段数/字数/字节/耗时/错误码，**不记文字**。
 */

import { levelSpeechWav } from './speech-level'
import {
  DEFAULT_SPEECH_MAX_CHARS,
  DEFAULT_SPEECH_MIN_CHARS,
  prepareSpeechText,
} from './speech-text'
import type { TtsClip, TtsSink } from './tts-audio'


/** 每段合成字数上限（合成约等于实时：80 字 ≈ 15 秒音频，也要等这么久才出来）。 */
export const SYNTH_SEGMENT_MAX_CHARS = 80
/** 第一段上限：用户点「朗读」到听到声音的等待时间主要由它决定。 */
export const FIRST_SEGMENT_MAX_CHARS = 40

/** 第一段太长时，在上限内的最后一个逗号/顿号处切开（找不到就按上限硬切）。 */
export function shortenFirstSegment(segments: string[], limit: number): string[] {
  const first = segments[0]
  if (first === undefined || first.length <= limit) return segments
  const head = first.slice(0, limit)
  const cut = Math.max(...['，', '、', '：', ',', ':', ' '].map((mark) => head.lastIndexOf(mark)))
  const at = cut >= Math.floor(limit / 3) ? cut + 1 : limit
  const left = first.slice(0, at).trim()
  const right = first.slice(at).trim()
  return right === '' ? segments : [left, right, ...segments.slice(1)]
}

export type TtsPhase = 'idle' | 'loading' | 'playing' | 'error'

/** 停止原因（进诊断，不进界面）：用户点停止 / 换一条 / 发消息 / 离开页面 / 切后台 / 读完 / 出错。 */
export type TtsStopReason =
  | 'user'
  | 'switch'
  | 'send'
  | 'leave'
  | 'background'
  | 'done'
  | 'error'
  | 'unavailable'

export interface TtsSnapshot {
  phase: TtsPhase
  /** 正在读哪条消息（调用方给的 key，例如对话块 key）；空闲时 null。 */
  messageKey: string | null
  /** 正在播第几段（1-based）；loading 时是 0。 */
  segment: number
  /** 这条回复一共几段。 */
  total: number
  /** 纯文本字数（诊断 tts:play 的 chars）。 */
  chars: number
  voice: string | null
}

export interface TtsPlayInput {
  /** 消息标识（对话块的 key）；预览时用 `__preview__`。 */
  key: string
  /** 原始 Markdown 回复（播放器内部转纯文本 + 切段）。 */
  text: string
  /** 音色 id；省略 = Hub 默认音色。 */
  voice?: string
}

/**
 * 朗读播放器的统一接口（0.4.6）：整段播放器与流式播放器都实现它，
 * store 只按 `bootstrap.voice.tts.stream` 选实现，界面代码不用关心是哪一种。
 */
export interface TtsController {
  /** 正在读（loading / playing）：按钮显示「停止」。 */
  readonly busy: boolean
  readonly snapshot: TtsSnapshot
  /** 这条消息是不是正在读。 */
  isActive(key: string): boolean
  /** 开始朗读（内部会先停掉上一条）；返回的 Promise 只方便测试等待。 */
  start(input: TtsPlayInput): Promise<void>
  /** 停止：立即静音，晚到的数据丢弃。重复调用无害。 */
  stop(reason?: TtsStopReason): void
  /** 释放音频资源（离开 App / 退出登录）。 */
  dispose(): void
}

export interface TtsPlayerOptions {
  /** 合成一段（HubClient.synthesize / MockHub.synthesize）。 */
  synthesize: (text: string, voice?: string) => Promise<TtsClip>
  /** 音频出口（Web Audio / `<audio>` / 测试假件）。第一次 `start()` 时才创建。 */
  sink: () => TtsSink
  /** 单段上限（bootstrap.voice.tts.maxChars）；可传函数以跟随 bootstrap 刷新。 */
  maxChars?: number | (() => number | undefined)
  /** 过短句子的合并阈值。 */
  minChars?: number | (() => number | undefined)
  /** 预取窗口（默认 2 段：播第 i 段时预取 i+1、i+2）。 */
  prefetch?: number
  /** 并发请求上限（默认 2）。 */
  maxInflight?: number
  /** 段缓存（默认新建 30MB LRU；测试可注入同一个实例来断言命中）。 */
  cache?: TtsClipCache
  /** 429 重试前等待（默认 setTimeout）；测试注入假睡眠。 */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onSnapshot?: (snapshot: TtsSnapshot) => void
  /** 轻提示（502/网络错误/没有可读内容）。 */
  onNotice?: (text: string) => void
  /** 诊断事件：`tts:play` / `tts:segment` / `tts:stop`（只记数字与错误码，不记文字）。 */
  onDiag?: (name: string, detail?: string) => void
}

/** 段缓存上限：30MB ≈ 10 分钟 24kHz 16bit 单声道音频（一次性读一部短篇也够）。 */
export const TTS_CACHE_BYTES = 30 * 1024 * 1024
/** 429 重试的等待上限（秒）：`retryAfterSec` 再大也不让用户干等一分钟后才提示失败。 */
export const TTS_RETRY_MAX_SEC = 10

/** 播放器对外的固定文案（界面/提示都从这里取，避免各处措辞不同）。 */
export const TTS_TEXT = {
  unavailable: '朗读暂时不可用',
  empty: '这条回复没有可以朗读的内容',
} as const

/**
 * 合成段的内存缓存（LRU，按字节计）。
 *
 * key 由「音色 + 文本」组成：同一个音色下同一段文字永远合成出同样的音频，
 * 所以缓存跨消息、跨播放复用；换音色不会串音。
 */
export class TtsClipCache {
  private readonly limit: number
  private readonly entries = new Map<string, { clip: TtsClip; bytes: number }>()
  private used = 0

  constructor(limitBytes: number = TTS_CACHE_BYTES) {
    this.limit = Math.max(0, limitBytes)
  }

  /** 缓存 key：音色 + 文本（音色为空 = Hub 默认音色）。 */
  static keyOf(text: string, voice?: string): string {
    return `${voice ?? ''}\u0000${text}`
  }

  get bytes(): number {
    return this.used
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): TtsClip | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    // LRU：命中后挪到队尾
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.clip
  }

  set(key: string, clip: TtsClip): void {
    const bytes = clip.wav.byteLength
    if (bytes > this.limit) return // 单段就超上限：不缓存，免得把整个缓存冲掉
    const existing = this.entries.get(key)
    if (existing) {
      this.used -= existing.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, { clip, bytes })
    this.used += bytes
    // 超上限：从最久没用的开始淘汰
    for (const [oldKey, entry] of this.entries) {
      if (this.used <= this.limit) break
      this.entries.delete(oldKey)
      this.used -= entry.bytes
    }
  }

  clear(): void {
    this.entries.clear()
    this.used = 0
  }
}

/** 从错误对象里取稳定错误码（HubApiError 有 `.code`；其它一律 network）。 */
export function ttsErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.length > 0) return code
  return 'network'
}

/** 429 的等待毫秒数（`retryAfterSec`，缺省 1 秒；钳到 TTS_RETRY_MAX_SEC）。 */
export function ttsRetryDelayMs(error: unknown): number {
  const raw = (error as { retryAfterSec?: unknown } | null)?.retryAfterSec
  const seconds = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1
  return Math.min(seconds, TTS_RETRY_MAX_SEC) * 1_000
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

/** 停止时用来快速结束在飞的请求：播放器不 await 它，只看 generation 令牌。 */
class TtsStopped extends Error {
  constructor() {
    super('tts-stopped')
    this.name = 'TtsStopped'
  }
}

export class TtsPlayer implements TtsController {
  private readonly options: TtsPlayerOptions
  private readonly cache: TtsClipCache
  private readonly maxCharsOf: () => number | undefined
  private readonly minCharsOf: () => number | undefined
  private readonly prefetch: number
  private readonly maxInflight: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private sink: TtsSink | null = null

  /** 每开始/停止一次 +1：所有异步回调都拿它比对，晚到的段直接丢弃。 */
  private generation = 0
  private active: {
    key: string
    voice: string | undefined
    segments: string[]
    chars: number
  } | null = null
  private phase: TtsPhase = 'idle'
  private segmentIndex = 0
  private readonly inflight = new Map<number, Promise<TtsClip>>()
  private readonly localCache = new Map<number, TtsClip>()

  constructor(options: TtsPlayerOptions) {
    this.options = options
    this.cache = options.cache ?? new TtsClipCache()
    const pick = (
      value: number | (() => number | undefined) | undefined,
    ): (() => number | undefined) => (typeof value === 'function' ? value : () => value)
    this.maxCharsOf = pick(options.maxChars)
    this.minCharsOf = pick(options.minChars)
    this.prefetch = Math.max(1, Math.floor(options.prefetch ?? 2))
    this.maxInflight = Math.max(1, Math.floor(options.maxInflight ?? 2))
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => Date.now())
  }

  /** 当前是否需要显示「停止」（loading 也算：首段加载中要能取消）。 */
  get busy(): boolean {
    return this.phase === 'loading' || this.phase === 'playing'
  }

  get snapshot(): TtsSnapshot {
    return {
      phase: this.phase,
      messageKey: this.active?.key ?? null,
      segment: this.phase === 'playing' ? this.segmentIndex + 1 : 0,
      total: this.active?.segments.length ?? 0,
      chars: this.active?.chars ?? 0,
      voice: this.active?.voice ?? null,
    }
  }

  /** 这条回复现在是不是正在读（按钮据此显示「停止」）。 */
  isActive(key: string): boolean {
    return this.busy && this.active?.key === key
  }

  /**
   * 开始朗读一条回复（会先停掉上一条，reason=switch）。
   *
   * 返回的 Promise 只是方便测试等待；界面不需要 await（状态通过 onSnapshot 推）。
   */
  start(input: TtsPlayInput): Promise<void> {
    if (this.busy) this.stop('switch')
    // 合成速度约等于实时：一段 200 字要等 30 多秒。每段不超过 SYNTH_SEGMENT_MAX_CHARS，
    // 第一段再收紧到 FIRST_SEGMENT_MAX_CHARS，让开口尽快（服务端上限仍是硬上限）。
    const serverMax = Math.max(1, Math.floor(this.maxCharsOf() ?? DEFAULT_SPEECH_MAX_CHARS))
    const maxChars = Math.min(serverMax, SYNTH_SEGMENT_MAX_CHARS)
    const minChars = Math.max(
      0,
      Math.min(this.minCharsOf() ?? DEFAULT_SPEECH_MIN_CHARS, maxChars),
    )
    const prepared = prepareSpeechText(input.text, { maxChars, minChars })
    prepared.segments = shortenFirstSegment(prepared.segments, Math.min(maxChars, FIRST_SEGMENT_MAX_CHARS))
    if (prepared.segments.length === 0) {
      this.options.onNotice?.(TTS_TEXT.empty)
      return Promise.resolve()
    }
    const generation = ++this.generation
    this.active = {
      key: input.key,
      voice: input.voice,
      segments: prepared.segments,
      chars: prepared.chars,
    }
    this.segmentIndex = 0
    this.localCache.clear()
    // 在**用户手势**里创建音频出口并解锁：Android WebView 里 AudioContext 只有这时才不会被挂起，
    // 网页版构建里 iOS Safari 还必须在这里播过一段静音（见 lib/tts-audio.ts 的 unlockAudioContext）
    this.sinkForPlay().unlock?.()
    this.diag('tts:play', `segments=${prepared.segments.length} chars=${prepared.chars}`)
    this.emit('loading')
    return this.run(generation)
  }

  /** 停止（立即静音；在飞的段作废）。重复调用无害。 */
  stop(reason: TtsStopReason = 'user'): void {
    if (!this.busy && this.active === null) return
    this.generation += 1
    this.inflight.clear()
    this.localCache.clear()
    this.sink?.stop()
    const key = this.active?.key ?? null
    this.reset()
    this.options.onSnapshot?.({
      phase: 'idle',
      messageKey: key,
      segment: 0,
      total: 0,
      chars: 0,
      voice: null,
    })
    this.diag('tts:stop', `reason=${reason}`)
  }

  /** 清掉当前朗读（不改 generation、不发快照）。 */
  private reset(): void {
    this.active = null
    this.segmentIndex = 0
    this.phase = 'idle'
  }

  /** 释放音频资源（离开 App / 退出登录）。 */
  dispose(): void {
    this.stop('leave')
    this.sink?.dispose()
    this.sink = null
    this.cache.clear()
  }

  // ── 主循环 ──────────────────────────────────────────────────────────────

  private async run(generation: number): Promise<void> {
    const active = this.active
    if (!active) return
    const total = active.segments.length
    try {
      for (let index = 0; index < total; index += 1) {
        // 首段要等（loading），之后各段在播放上一段时已经预取好，基本零等待。
        const clip = await this.ensure(index, generation)
        if (generation !== this.generation) return
        this.segmentIndex = index
        this.emit('playing')
        // 边播边合成：先把后面两段排上（并发不超过 maxInflight）
        this.prefetchAhead(index, generation)
        await this.sinkForPlay().play(clip)
        if (generation !== this.generation) return
      }
      if (generation !== this.generation) return
      // 自然读完：必须通知界面回到空闲，否则按钮会一直停在「朗读中」（0.4.3 真机 bug）
      const key = active.key
      this.reset()
      this.options.onSnapshot?.({
        phase: 'idle',
        messageKey: key,
        segment: 0,
        total: 0,
        chars: 0,
        voice: null,
      })
      this.diag('tts:stop', 'reason=done')
    } catch (error) {
      if (generation !== this.generation) return // 停止导致的取消：静默
      const code = ttsErrorCode(error)
      this.generation += 1
      this.inflight.clear()
      this.localCache.clear()
      const key = this.active?.key ?? null
      this.reset()
      this.phase = 'error'
      this.options.onSnapshot?.({
        phase: 'error',
        messageKey: key,
        segment: 0,
        total: 0,
        chars: 0,
        voice: null,
      })
      this.diag('tts:stop', `reason=error code=${code}`)
      this.options.onNotice?.(TTS_TEXT.unavailable)
      // 界面回到「朗读」按钮（错误态只用于诊断/一次快照，不把按钮卡在错误上）
      this.phase = 'idle'
      this.options.onSnapshot?.({
        phase: 'idle',
        messageKey: key,
        segment: 0,
        total: 0,
        chars: 0,
        voice: null,
      })
    }
  }

  /** 拿到第 index 段：缓存 → 在飞 → 新请求（429 在这一层重试一次）。 */
  private async ensure(index: number, generation: number): Promise<TtsClip> {
    const active = this.active
    if (!active) throw new TtsStopped()
    const text = active.segments[index]!
    const cacheKey = TtsClipCache.keyOf(text, active.voice)

    const local = this.localCache.get(index)
    if (local) return local
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.localCache.set(index, cached)
      this.diag('tts:segment', `ms=0 bytes=${cached.wav.byteLength} cached=1 code=ok`)
      return cached
    }
    const existing = this.inflight.get(index)
    if (existing) return existing

    const task = this.fetchSegment(index, text, cacheKey, generation).finally(() => {
      if (this.inflight.get(index) === task) this.inflight.delete(index)
    })
    this.inflight.set(index, task)
    return task
  }

  /** 真正合成一段：计时 + 诊断 + 429 重试一次；停止/换代后丢弃结果。 */
  private async fetchSegment(
    index: number,
    text: string,
    cacheKey: string,
    generation: number,
  ): Promise<TtsClip> {
    const active = this.active
    if (!active) throw new TtsStopped()
    const startedAt = this.now()
    let attempt = 0
    for (;;) {
      try {
        const raw = await this.options.synthesize(text, active.voice)
        if (generation !== this.generation) throw new TtsStopped()
        // 0.4.4：统一每段的响度、首尾静音与段间停顿（整篇读下来更一致）
        const clip: TtsClip = { ...raw, wav: levelSpeechWav(raw.wav) }
        this.cache.set(cacheKey, clip)
        this.localCache.set(index, clip)
        this.diag(
          'tts:segment',
          `ms=${Math.max(0, this.now() - startedAt)} bytes=${clip.wav.byteLength} cached=0 code=ok`,
        )
        return clip
      } catch (error) {
        if (error instanceof TtsStopped) throw error
        if (generation !== this.generation) throw new TtsStopped()
        const code = ttsErrorCode(error)
        // 429：按 retryAfterSec 等一次再试（服务端排队满/用户限流），只重试一次
        if (code === 'RATE_LIMITED' && attempt === 0) {
          attempt += 1
          await this.sleep(ttsRetryDelayMs(error))
          if (generation !== this.generation) throw new TtsStopped()
          continue
        }
        this.diag(
          'tts:segment',
          `ms=${Math.max(0, this.now() - startedAt)} bytes=0 cached=0 code=${code}`,
        )
        throw error
      }
    }
  }

  /** 预取接下来的 1..prefetch 段（不 await：播放不等它）。 */
  private prefetchAhead(index: number, generation: number): void {
    const active = this.active
    if (!active) return
    for (let offset = 1; offset <= this.prefetch; offset += 1) {
      const next = index + offset
      if (next >= active.segments.length) return
      if (this.localCache.has(next) || this.inflight.has(next)) continue
      // 并发上限：服务端本来就是全局串行，客户端多开只会让队列更乱
      if (this.inflight.size >= this.maxInflight) return
      void this.ensure(next, generation).catch(() => {
        /* 预取失败不在这里报错：轮到它时 ensure 会重新请求（或在那里失败并停止） */
      })
    }
  }

  private sinkForPlay(): TtsSink {
    if (!this.sink) this.sink = this.options.sink()
    return this.sink
  }

  private emit(phase: TtsPhase): void {
    this.phase = phase
    this.options.onSnapshot?.(this.snapshot)
  }

  private diag(name: string, detail: string): void {
    this.options.onDiag?.(name, detail)
  }
}
