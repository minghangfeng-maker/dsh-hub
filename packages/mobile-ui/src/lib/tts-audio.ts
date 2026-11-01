/**
 * 朗读音频出口（0.4.3）：把一段 WAV 播出来。
 *
 * 为什么选 **Web Audio（AudioBufferSourceNode）** 而不是 `HTMLAudioElement` 队列：
 *  1. 段间无缝：`decodeAudioData` 可以在**预取阶段**（还没轮到播放）就把下一段解码好，
 *     轮到它时 `source.start()` 立即出声，段与段之间只隔一个 JS 任务（毫秒级）；
 *     `HTMLAudioElement` 每次 `src` 变更都要重新加载/解码，真机上段间有 100–300ms 空档，
 *     听起来像「一句一句地卡」；
 *  2. 采样率不用管：Hub 固定 24kHz，AudioContext 会自动重采样到设备输出采样率；
 *     而 `<audio>` 在部分 Android WebView 上对 24kHz 单声道会走另一条解码路径，
 *     偶发「第一段没声音/时长为 0」；
 *  3. 可控：`source.stop()` 立即静音，不像 `<audio>.pause()` 那样在部分机型上还有尾巴。
 *
 * 真机注意：AudioContext 必须在**用户手势**里创建/resume，否则 Android WebView 会挂起它。
 * 播放器在点击「朗读」时同步调用 `createTtsSink()`（还没 await 任何网络请求），满足这个约束；
 * 每次 `play()` 前再 `resume()` 一次兜底（切后台回来、来电之后）。
 *
 * 网页版（WP54 / W3）：Chrome 的规则与 WebView 相同，**iOS Safari 更严** —— 除了在手势里
 * 创建，还必须真的 `resume()` 并播过一段音频，之后 `start()` 才会出声。所以网页版构建
 * （`IS_WEB_BUILD`）在创建两个 Web Audio 出口时会调用 `unlockAudioContext()`
 * （resume + 1 帧静音 buffer），并且播放器每次点「朗读」都会再调一次 `sink.unlock()`（幂等）。
 *
 * **APK 不放这段静音**：Android WebView 在手势里创建 + resume 就够（0.4.x 一直如此），
 * 少一个 AudioBufferSourceNode 也让 0.4.x 的段间无缝断言（scripts/e2e-tts-stream.mjs 的 D2）
 * 保持原样 —— 那条断言会把静音解锁节点也算成一段音频。
 *
 * 没有 AudioContext 的环境（很老的 WebView / 测试）退回 HTMLAudioElement 队列，
 * 这条路只是兜底：慢一点，但能用。
 */

import { IS_WEB_BUILD } from './app-info'

export interface TtsClip {
  /** WAV 字节（24kHz 单声道 16bit）。 */
  wav: Uint8Array
  sampleRate: number
  voice: string
}

/**
 * 流式播放出口（0.4.6 / WP51）：把陆续收到的 PCM 按**时间轴**排程，段与段首尾相接。
 *
 * `schedule()` 返回这段的实际时长（秒），播放器据此把下一段排在上一段结束处
 * （`when + duration`），所以相邻 AudioBuffer 之间没有缝隙；`now()` 是音频时钟，
 * 播放器用它判断抖动缓冲是否快见底（`now() >= scheduledUntil` 就是 underrun）。
 */
export interface TtsStreamSink {
  /** 音频时钟（秒）：与 `AudioContext.currentTime` 同一时间轴。 */
  now(): number
  /**
   * 排程一段单声道 PCM（Float32，[-1,1]），在 `when` 秒开始。
   * 返回这段的时长（秒）：下一段应排在 `when + 返回值`。
   */
  schedule(samples: Float32Array, sampleRate: number, when: number): number
  /** 立即停掉所有已排程的节点（还没开始的不会再响）。 */
  stopAll(): void
  /** 释放底层资源（AudioContext）。 */
  dispose(): void
  /** 被系统挂起（切后台回来/来电）后恢复。 */
  resume?(): Promise<void>
  /**
   * 在**用户手势**里解锁音频（WP54 / W3）：iOS Safari 必须在这里 `resume()` 并播一段
   * 静音 buffer，否则之后排程的 PCM 会被静默丢弃。幂等，可以在每次点「朗读」时调。
   */
  unlock?(): void
}

export interface TtsSink {
  /**
   * 预热（解码）一段音频：不会出声，只是把解码开销挪到预取阶段。
   * 同一段只解码一次（按对象身份缓存）。
   */
  prepare(clip: TtsClip): Promise<void>
  /**
   * 立即播放（应已 `prepare` 过）。返回的 Promise 在**播完**或 `stop()` 时 resolve；
   * 解码/播放失败时 reject。
   */
  play(clip: TtsClip): Promise<void>
  /** 立即停止当前播放（不抛错）；`play()` 的 Promise 会随即 resolve。 */
  stop(): void
  /** 释放底层资源（AudioContext / object URL）。 */
  dispose(): void
  /** 在用户手势里解锁音频（见 TtsStreamSink.unlock）。幂等。 */
  unlock?(): void
}

/** WebView/浏览器里有没有 Web Audio。 */
export function hasWebAudio(): boolean {
  const scope = globalThis as unknown as {
    AudioContext?: unknown
    webkitAudioContext?: unknown
  }
  return typeof scope.AudioContext === 'function' || typeof scope.webkitAudioContext === 'function'
}

/** WAV 的 ArrayBuffer（`Uint8Array` 可能是大 buffer 的视图，必须按偏移切出来）。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

interface AudioBufferLike {
  duration: number
  copyToChannel?: (source: Float32Array, channel: number) => void
  getChannelData?: (channel: number) => Float32Array
}

interface AudioContextLike {
  state?: string
  currentTime: number
  destination: unknown
  resume?: () => Promise<void>
  decodeAudioData: (data: ArrayBuffer) => Promise<unknown>
  createBuffer?: (channels: number, length: number, sampleRate: number) => AudioBufferLike
  createBufferSource: () => {
    buffer: unknown
    connect: (target: unknown) => void
    start: (when?: number) => void
    stop: () => void
    onended: (() => void) | null
  }
  close?: () => Promise<void>
}

type AudioContextCtor = new () => AudioContextLike

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return scope.AudioContext ?? scope.webkitAudioContext ?? null
}

/**
 * 在用户手势里解锁 AudioContext（WP54 / W3：网页版 Chrome + iOS Safari 都要走通）。
 *
 * 两个平台的要求不一样：
 *  - **Chrome / Android WebView**：手势里创建的 context 直接是 `running`，`resume()` 只是兜底
 *    （切后台回来、来电之后会被挂起）；
 *  - **iOS Safari**：仅 `resume()` 不够 —— 必须真的**播过声音**（哪怕是 1 帧静音），
 *    之后再 `createBufferSource().start()` 才不会被静默丢弃。所以这里固定播一段静音 buffer。
 *
 * 静音只给**网页版构建**（`options.silent` 默认 `IS_WEB_BUILD`）：APK 的 Android WebView
 * 不需要它，少一个节点也让 0.4.x 的段间无缝 e2e 断言保持原样。
 *
 * 幂等、绝不抛错：失败时（老 WebView 没有 createBuffer / context 已关闭）静默跳过。
 */
export function unlockAudioContext(
  context: AudioContextLike,
  options: { silent?: boolean } = {},
): void {
  // `interrupted` 是 iOS Safari 特有的状态（来电/切走之后）：和 suspended 一样要 resume
  if (typeof context.resume === 'function' && context.state !== 'running') {
    void context.resume().catch(() => undefined)
  }
  if ((options.silent ?? IS_WEB_BUILD) !== true) return
  try {
    const createBuffer = context.createBuffer
    if (typeof createBuffer !== 'function') return
    // 1 帧静音就够解锁（有的 WebView 对 0 长度 buffer 直接抛错，所以用 1）
    const buffer = createBuffer.call(context, 1, 1, 8_000)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.start(0)
  } catch {
    /* 解锁失败不影响后续：真正播放时还会 resume 一次 */
  }
}

/** Web Audio 出口：预解码 + 逐个 `AudioBufferSourceNode` 播放。 */
class WebAudioSink implements TtsSink {
  private readonly Ctor: AudioContextCtor
  private context: AudioContextLike | null = null
  private readonly buffers = new WeakMap<TtsClip, unknown>()
  private active: {
    source: ReturnType<AudioContextLike['createBufferSource']>
    finish: () => void
  } | null = null
  private disposed = false

  constructor(Ctor: AudioContextCtor) {
    this.Ctor = Ctor
  }

  /**
   * 懒创建：**在用户手势里**创建（Android WebView / iOS Safari 的硬要求，WP54 / W3）。
   *
   * 播放器在点击「朗读」时同步调用 `sink.unlock()` → 这里建 context → 立刻解锁
   * （resume + 一帧静音），iOS Safari 之后才允许真的出声。
   */
  private ctx(): AudioContextLike {
    if (!this.context || this.disposed) this.context = new this.Ctor()
    return this.context
  }

  /** 每次点「朗读」都会调（幂等）：手势里建 context / 解锁 / 切后台回来后再 resume 一次。 */
  unlock(): void {
    unlockAudioContext(this.ctx())
  }

  async prepare(clip: TtsClip): Promise<void> {
    if (this.buffers.has(clip)) return
    const context = this.ctx()
    const decoded = await context.decodeAudioData(toArrayBuffer(clip.wav))
    this.buffers.set(clip, decoded)
  }

  async play(clip: TtsClip): Promise<void> {
    const context = this.ctx()
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      // 后台回来 / 来电之后 context 会被挂起：恢复失败也不阻断（下面的 start 会很快结束）
      await context.resume().catch(() => undefined)
    }
    let buffer = this.buffers.get(clip)
    if (buffer === undefined) {
      buffer = await context.decodeAudioData(toArrayBuffer(clip.wav))
      this.buffers.set(clip, buffer)
    }
    return new Promise<void>((resolve, reject) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        if (this.active?.source === source) this.active = null
        resolve()
      }
      const source = context.createBufferSource()
      try {
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = finish
        source.start()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.active = { source, finish }
    })
  }

  stop(): void {
    const active = this.active
    this.active = null
    if (!active) return
    active.source.onended = null
    try {
      active.source.stop()
    } catch {
      /* 已经结束的 source 再 stop 会抛 InvalidStateError：忽略 */
    }
    active.finish()
  }

  dispose(): void {
    this.stop()
    this.disposed = true
    const context = this.context
    this.context = null
    if (context && typeof context.close === 'function') void context.close().catch(() => undefined)
  }
}

/** HTMLAudioElement 兜底（没有 Web Audio 的老 WebView）：一段一个 Blob URL。 */
class ElementAudioSink implements TtsSink {
  private audio: HTMLAudioElement | null = null
  private urls = new WeakMap<TtsClip, string>()

  async prepare(): Promise<void> {
    // `<audio>` 自己解码：这里没有可以提前做的事
  }

  private urlFor(clip: TtsClip): string {
    const existing = this.urls.get(clip)
    if (existing) return existing
    const blob = new Blob([toArrayBuffer(clip.wav)], { type: 'audio/wav' })
    const url = URL.createObjectURL(blob)
    this.urls.set(clip, url)
    return url
  }

  async play(clip: TtsClip): Promise<void> {
    this.stop()
    const audio = new Audio()
    this.audio = audio
    audio.src = this.urlFor(clip)
    return new Promise<void>((resolve, reject) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        if (this.audio === audio) this.audio = null
        resolve()
      }
      audio.onended = finish
      audio.onerror = () => {
        if (this.audio === audio) this.audio = null
        reject(new Error('audio error'))
      }
      // 自动播放被拦下时也 resolve：否则整条朗读链会永远卡在这一段
      const started = audio.play()
      if (started && typeof started.catch === 'function') started.catch(() => finish())
    })
  }

  stop(): void {
    const audio = this.audio
    this.audio = null
    if (!audio) return
    audio.onended = null
    audio.onerror = null
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch {
      /* 忽略：元素可能已经被回收 */
    }
  }

  dispose(): void {
    this.stop()
  }

  /** `<audio>` 兜底没有可以提前解锁的（真正的解锁要靠播放动作本身）。 */
  unlock(): void {}
}

/** Web Audio 的流式出口：PCM → AudioBuffer，按音频时钟排程（`start(when)` 首尾相接）。 */
class WebAudioStreamSink implements TtsStreamSink {
  private readonly Ctor: AudioContextCtor
  private context: AudioContextLike | null = null
  private readonly sources = new Set<ReturnType<AudioContextLike['createBufferSource']>>()
  private disposed = false

  constructor(Ctor: AudioContextCtor) {
    this.Ctor = Ctor
    // 在用户手势里就把 AudioContext 建出来并解锁：Android WebView 里之后才建会被挂起，
    // iOS Safari 还必须在这里播过一段静音（见 unlockAudioContext）
    try {
      this.context = new Ctor()
      this.unlock()
    } catch {
      this.context = null
    }
  }

  private ctx(): AudioContextLike {
    if (!this.context || this.disposed) {
      this.context = new this.Ctor()
      this.unlock()
    }
    return this.context
  }

  /** 每次点「朗读」都会调（幂等）：解锁 / 切后台回来后再 resume 一次。 */
  unlock(): void {
    if (!this.context) return
    unlockAudioContext(this.context)
  }

  now(): number {
    return this.ctx().currentTime
  }

  schedule(samples: Float32Array, sampleRate: number, when: number): number {
    const context = this.ctx()
    const createBuffer = context.createBuffer
    if (typeof createBuffer !== 'function') return 0
    const buffer = createBuffer.call(context, 1, Math.max(1, samples.length), sampleRate)
    if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(samples, 0)
    else buffer.getChannelData?.(0)?.set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const entry = source
    source.onended = () => this.sources.delete(entry)
    this.sources.add(entry)
    try {
      source.start(when)
    } catch {
      // 时间点已经过去 / 上下文已关闭：这段丢掉，别让播放器卡死
      this.sources.delete(entry)
      return 0
    }
    return buffer.duration
  }

  stopAll(): void {
    const sources = [...this.sources]
    this.sources.clear()
    for (const source of sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        /* 已经播完的节点再 stop 会抛：忽略 */
      }
    }
  }

  async resume(): Promise<void> {
    const context = this.ctx()
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      await context.resume().catch(() => undefined)
    }
  }

  dispose(): void {
    this.stopAll()
    this.disposed = true
    const context = this.context
    this.context = null
    if (context && typeof context.close === 'function') void context.close().catch(() => undefined)
  }
}

/**
 * 创建音频出口：优先 Web Audio，老 WebView 退回 `<audio>`。
 * 在**用户手势**里调用（第一次点击「朗读」），AudioContext 才不会一直被挂起。
 */
export function createTtsSink(): TtsSink {
  const Ctor = audioContextCtor()
  if (Ctor) return new WebAudioSink(Ctor)
  return new ElementAudioSink()
}

/**
 * 流式朗读的音频出口（0.4.6）：必须是 Web Audio（按时间轴排程才可能无缝）。
 * 没有 Web Audio 的环境由 store 回退到整段播放器（`<audio>` 队列）。
 */
export function createTtsStreamSink(): TtsStreamSink {
  const Ctor = audioContextCtor()
  if (!Ctor) throw new Error('stream tts requires Web Audio')
  return new WebAudioStreamSink(Ctor)
}
