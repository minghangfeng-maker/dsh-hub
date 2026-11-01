/**
 * App 内录音（0.4.2）：按住说话 → 本机采集 → 16kHz / 单声道 / 16bit PCM 的 WAV，
 * 松手后交给 Hub 的 `POST /api/mobile/asr` 识别。
 *
 * 为什么不再用 Android 的 `SpeechRecognizer`（0.4.1 的做法）：国产 ROM 的系统识别服务
 * 不对第三方应用开放，一按就 `ERROR_CLIENT`，而且不弹麦克风授权。现在录音由 App 自己做，
 * 识别放到 Hub 侧（识别服务只需要对 Hub 开放一次）。
 *
 * 本文件分成两层：
 *  1. **纯函数**（下采样、Int16、WAV 头、音量、上限换算）—— 单测直接覆盖，不碰音频硬件；
 *  2. `VoiceRecorder` —— 计时上限、倒计时、音量节流、释放 Mic；采集设备通过
 *     `capture` 工厂注入（默认 `createMediaCapture`：getUserMedia + AudioWorklet，
 *     不支持 Worklet 时退回 ScriptProcessor），单测用假工厂。
 *
 * 麦克风权限：Android WebView 里 `getUserMedia` 会走 Capacitor 的
 * `BridgeWebChromeClient.onPermissionRequest`（它同时申请 `RECORD_AUDIO` 与
 * `MODIFY_AUDIO_SETTINGS`，见 Capacitor 8 源码）。为了**首次一定弹系统弹窗**，调用方还会
 * 先经原生插件显式申请（`ensurePermission` 回调，见 lib/speech-native.ts），这里只负责
 * 在权限被拒时**不打开麦克风**并抛一个可识别的错误。
 */

import { Capacitor } from '@capacitor/core'

/** 上传格式：Hub 只接受 16kHz 单声道 16bit PCM。 */
export const TARGET_SAMPLE_RATE = 16_000
/** 每秒字节数（16000 * 2）。 */
export const BYTES_PER_SECOND = TARGET_SAMPLE_RATE * 2
/** 默认单段上限（秒）；真实值来自 `bootstrap.voice.maxSeconds`。 */
export const DEFAULT_MAX_SECONDS = 60
/** 剩多少秒开始显示倒计时。 */
export const COUNTDOWN_SECONDS = 10
/** WAV 头长度：44 字节（RIFF + fmt + data）。 */
export const WAV_HEADER_BYTES = 44

/** 录音过程中的错误（都带稳定 code，交给 lib/voice-input 翻成中文）。 */
export type RecorderErrorCode =
  | 'permission-denied'
  | 'unavailable'
  | 'unsupported'
  | 'empty'
  /** 网页版非安全上下文（http）：浏览器根本不给麦克风（WP54 / W3）。 */
  | 'insecure'

export class RecorderError extends Error {
  readonly code: RecorderErrorCode

  constructor(code: RecorderErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'RecorderError'
    this.code = code
  }
}

/* ---------- 纯函数 ---------- */

/** 上限秒数（1–60，非法值退回默认 60）。 */
export function clampMaxSeconds(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SECONDS
  return Math.min(DEFAULT_MAX_SECONDS, Math.max(1, Math.round(value)))
}

/**
 * 下采样到 16kHz（盒式滤波：每个输出样本取对应输入窗口的平均值）。
 *
 * 输入是 `AudioContext.sampleRate`（常见 48000 / 44100）的 Float32 单声道样本；
 * 输出 16kHz。输入本来就是 16k（或更低）时原样返回一份拷贝 —— 不做上采样。
 */
export function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (input.length === 0) return new Float32Array(0)
  if (!Number.isFinite(inputRate) || inputRate <= 0 || inputRate <= targetRate) {
    return new Float32Array(input)
  }
  const ratio = inputRate / targetRate
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += input[j] ?? 0
    output[i] = sum / (end - start)
  }
  return output
}

/** Float32（-1…1）→ Int16 PCM（小端由 encodeWav 负责）。 */
export function floatToInt16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0))
    // 负半轴要乘 0x8000，正半轴乘 0x7fff：否则满幅会溢出成相反值
    pcm[i] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff)
  }
  return pcm
}

/** 封装 WAV（44 字节头 + PCM 数据），全部小端。 */
export function encodeWav(pcm: Int16Array, sampleRate = TARGET_SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // 文件长度 - 8
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度（PCM 固定 16）
  view.setUint16(20, 1, true) // audioFormat = 1（PCM）
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byteRate
  view.setUint16(32, 2, true) // blockAlign = 声道 * 位深/8
  view.setUint16(34, 16, true) // bitsPerSample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i] ?? 0, true)
  }
  return bytes
}

/** 是不是一段 16k 单声道 16bit 的 WAV（只用于自检/测试，不作为上传前的唯一依据）。 */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < WAV_HEADER_BYTES) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number, text: string): boolean => {
    for (let i = 0; i < text.length; i += 1) {
      if (view.getUint8(offset + i) !== text.charCodeAt(i)) return false
    }
    return true
  }
  return tag(0, 'RIFF') && tag(8, 'WAVE')
}

/** 音量（0–1）：Float32 样子的 RMS 放大 6 倍，够驱动浮层的 9 根竖条。 */
export function levelFromSamples(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0
    sum += value * value
  }
  const rms = Math.sqrt(sum / samples.length)
  return Math.min(1, Math.max(0, rms * 6))
}

/** 时长（毫秒）→ 倒计时用的剩余秒数（向上取整，0 表示已经到点）。 */
export function remainingSeconds(maxSeconds: number, elapsedMs: number): number {
  const left = maxSeconds * 1_000 - elapsedMs
  return Math.max(0, Math.ceil(left / 1_000))
}

/* ---------- 采集层 ---------- */

/** 一段采集会话（默认实现基于 MediaStream + WebAudio）。 */
export interface CaptureSession {
  /** 设备实际采样率（AudioContext.sampleRate）。 */
  readonly sampleRate: number
  /** 停止并释放（MediaStream 轨道 / AudioContext）。可重复调用。 */
  release: () => void
}

/** 采集工厂：测试注入假实现，真机/浏览器用 `createMediaCapture`。 */
export type CaptureFactory = (
  onSamples: (samples: Float32Array) => void,
) => Promise<CaptureSession>

export interface VoiceRecording {
  /** 44 字节头 + PCM。 */
  wav: Uint8Array
  /** 实际时长（毫秒）。 */
  durationMs: number
  sampleRate: number
  /** PCM 样本数（= 16k * 秒）。 */
  samples: number
}

export interface VoiceRecorderOptions {
  /** 单段上限（秒）；默认 60。 */
  maxSeconds?: number
  /** 音量回调（0–1，约 15Hz）。 */
  onLevel?: (level: number) => void
  /** 倒计时：剩 10…1 秒时每秒回调一次（到 0 前不再回调）。 */
  onCountdown?: (remainingSeconds: number) => void
  /** 到上限：自动结束（调用方据此走「松手」同一条收尾路径）。 */
  onLimit?: () => void
  /** 采集工厂（默认 getUserMedia + AudioWorklet/ScriptProcessor）。 */
  capture?: CaptureFactory
  /** 打开麦克风前申请权限（Android 走原生插件）；返回 denied 就不开麦。 */
  ensurePermission?: () => Promise<'granted' | 'denied' | 'unknown'>
  /** 时钟（测试注入）。 */
  now?: () => number
  /** 计时检查间隔（毫秒），默认 250。 */
  tickMs?: number
}

/** voice-input 创建录音器时传入的部分（权限申请由 voice-input 自己补上）。 */
export type VoiceRecorderCreateOptions = Pick<
  VoiceRecorderOptions,
  'maxSeconds' | 'onLevel' | 'onCountdown' | 'onLimit'
>

/** voice-input 只需要这几个方法（测试用假录音器替身）。 */
export interface VoiceRecorderLike {
  start: () => Promise<void>
  stop: () => Promise<VoiceRecording>
  cancel: () => void
  readonly active: boolean
}

/* ---------- 默认采集实现（浏览器 / WebView） ---------- */

const WORKLET_NAME = 'dsh-voice-recorder'
const WORKLET_SOURCE = `
class DshVoiceRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel))
    return true
  }
}
registerProcessor('${WORKLET_NAME}', DshVoiceRecorder)
`

interface AudioContextLike {
  sampleRate: number
  state: string
  resume: () => Promise<void>
  close: () => Promise<void>
  createMediaStreamSource: (stream: MediaStream) => { connect: (node: unknown) => void; disconnect: () => void }
  createGain: () => { gain: { value: number }; connect: (node: unknown) => void; disconnect: () => void }
  createScriptProcessor?: (
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ) => {
    onaudioprocess: ((event: { inputBuffer: AudioBuffer }) => void) | null
    connect: (node: unknown) => void
    disconnect: () => void
  }
  createAnalyser?: () => unknown
  destination: unknown
  audioWorklet?: { addModule: (url: string) => Promise<void> }
}

type AudioContextCtor = new (options?: { latencyHint?: string }) => AudioContextLike

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return scope.AudioContext ?? scope.webkitAudioContext ?? null
}

/** 浏览器里能不能录音（有 mediaDevices 与 AudioContext；网页版还要求 https）。 */
export function isRecordingSupported(): boolean {
  const scope = globalThis as unknown as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }
  if (!Capacitor.isNativePlatform() && !isSecureAudioContext()) return false
  return (
    typeof scope.navigator?.mediaDevices?.getUserMedia === 'function' && audioContextCtor() !== null
  )
}

/**
 * 当前是不是安全上下文（https / localhost / 原生壳的 `https://localhost`）。
 *
 * 浏览器的规则：**非安全上下文里根本没有 `navigator.mediaDevices`**（用明文 http 打开
 * Hub 的手机网页版时就是这种情况）。这时报「这台设备不能录音」会让人以为是手机问题，
 * 所以先单独判出来，给「需要 https」的提示（WP54 / W3）。
 */
export function isSecureAudioContext(): boolean {
  const scope = globalThis as { isSecureContext?: boolean }
  // 没有这个字段的环境（老 WebView / 测试）当作安全：真正失败时 getMediaStream 会抛错
  return scope.isSecureContext !== false
}

/** 网页版 + 非 https：录音一定失败，明确抛 `insecure`（原生壳内始终是安全上下文）。 */
function assertSecureContext(): void {
  if (Capacitor.isNativePlatform()) return
  if (isSecureAudioContext()) return
  throw new RecorderError('insecure', '浏览器只在 https（或本机地址）下允许录音')
}

function recorderErrorFor(error: unknown): RecorderError {
  const name = (error as { name?: unknown })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new RecorderError('permission-denied', '麦克风权限被拒绝')
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new RecorderError('unavailable', '找不到可用的麦克风')
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'OverconstrainedError') {
    return new RecorderError('unavailable', '麦克风被别的应用占用')
  }
  return new RecorderError('unsupported', '这台设备不能录音')
}

/** 约束：单声道，开回声消除/降噪/自动增益（按住说话场景人声为主）。 */
export const MIC_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const

/**
 * 默认采集：`getUserMedia` → WebAudio。
 *
 * 优先 AudioWorklet（`addModule` 用 blob URL：不额外增加构建产物），
 * `audioWorklet` 不可用或 addModule 失败时退回 `ScriptProcessorNode`（已废弃但兼容老 WebView）。
 *
 * 网页版（WP54 / W3）里这条路径就是全部：先判安全上下文（http 下浏览器不给麦克风），
 * 再 `getUserMedia({audio})`；**不**经过 Capacitor 的 `requestMicPermission`
 * （那是 Android 原生插件，网页里没有桥，见 lib/speech-native.ts 的 ensureMicPermission）。
 */
export async function createMediaCapture(
  onSamples: (samples: Float32Array) => void,
): Promise<CaptureSession> {
  assertSecureContext()
  const scope = globalThis as unknown as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }
  const getUserMedia = scope.navigator?.mediaDevices?.getUserMedia
  const Ctor = audioContextCtor()
  if (typeof getUserMedia !== 'function' || !Ctor) {
    throw new RecorderError('unsupported', '这台设备不能录音')
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS } })
  } catch (error) {
    throw recorderErrorFor(error)
  }

  let context: AudioContextLike
  try {
    context = new Ctor({ latencyHint: 'interactive' })
  } catch {
    stopTracks(stream)
    throw new RecorderError('unsupported', '这台设备不能录音')
  }

  let released = false
  const nodes: Array<{ disconnect: () => void }> = []
  let blobUrl: string | null = null

  const release = (): void => {
    if (released) return
    released = true
    for (const node of nodes) {
      try {
        node.disconnect()
      } catch {
        /* 已经断开 */
      }
    }
    nodes.length = 0
    stopTracks(stream)
    if (blobUrl && typeof URL !== 'undefined') {
      try {
        URL.revokeObjectURL(blobUrl)
      } catch {
        /* ignore */
      }
      blobUrl = null
    }
    void context.close().catch(() => {
      /* ignore */
    })
  }

  try {
    if (context.state === 'suspended') {
      // 有些 WebView 起手是 suspended；拿不到用户手势时也会自动恢复，失败不致命
      await context.resume().catch(() => {})
    }
    const source = context.createMediaStreamSource(stream)
    nodes.push(source)
    const sink = context.createGain()
    sink.gain.value = 0
    nodes.push(sink)
    sink.connect(context.destination)

    let captured = false
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        blobUrl = URL.createObjectURL(
          new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
        )
        await context.audioWorklet.addModule(blobUrl)
        const node = new AudioWorkletNode(context as unknown as AudioContext, WORKLET_NAME)
        node.port.onmessage = (event: MessageEvent) => {
          const data = event.data
          if (data instanceof Float32Array) onSamples(data)
        }
        source.connect(node)
        // sink 来自 AudioContextLike（结构类型），真实运行时就是 GainNode
        node.connect(sink as unknown as AudioNode)
        nodes.push(node)
        captured = true
      } catch {
        // 回落到 ScriptProcessor（老 WebView / 禁用了 Worklet）
        captured = false
      }
    }

    if (!captured) {
      const createScriptProcessor = context.createScriptProcessor
      if (typeof createScriptProcessor !== 'function') {
        release()
        throw new RecorderError('unsupported', '这台设备不能录音')
      }
      const processor = createScriptProcessor.call(context, 4096, 1, 1)
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0)
        onSamples(new Float32Array(channel))
      }
      source.connect(processor)
      processor.connect(sink)
      nodes.push(processor)
    }

    return { sampleRate: context.sampleRate, release }
  } catch (error) {
    release()
    if (error instanceof RecorderError) throw error
    throw new RecorderError('unsupported', '这台设备不能录音')
  }
}

function stopTracks(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks?.() ?? []) {
    try {
      track.stop()
    } catch {
      /* ignore */
    }
  }
}

/* ---------- 录音器 ---------- */

/**
 * 一段录音：固定上限、倒计时、音量、WAV 封装。
 *
 * 生命周期：`start()` → 采集（帧写到内存）→ `stop()`（返回 WAV）或 `cancel()`（丢弃）。
 * 到上限时先**立刻释放麦克风**再回调 `onLimit()`：即使上层状态机卡住，也不会一直录下去。
 */
export class VoiceRecorder implements VoiceRecorderLike {
  private readonly options: VoiceRecorderOptions
  private readonly maxSeconds: number
  private readonly now: () => number
  private readonly tickMs: number

  private starting = false
  private session: CaptureSession | null = null
  /** 采集设备的真实采样率（释放 session 之后还要用它下采样）。 */
  private sessionRate = TARGET_SAMPLE_RATE
  private chunks: Float32Array[] = []
  private totalSamples = 0
  private startedAt = 0
  private ticker: ReturnType<typeof setInterval> | null = null
  private lastLevelAt = 0
  private lastCountdown = -1
  private limitFired = false
  private stopping: Promise<VoiceRecording> | null = null
  private lastRecording: VoiceRecording | null = null
  /** 本次录音已经作废（cancel/stop 先于 start 完成）：开麦后立刻释放。 */
  private closed = false

  constructor(options: VoiceRecorderOptions = {}) {
    this.options = options
    this.maxSeconds = clampMaxSeconds(options.maxSeconds)
    this.now = options.now ?? (() => Date.now())
    this.tickMs = Math.max(50, options.tickMs ?? 250)
  }

  get active(): boolean {
    return this.session !== null || this.starting || this.stopping !== null
  }

  /** 已经录了多久（毫秒）。 */
  get elapsedMs(): number {
    if (this.startedAt === 0) return 0
    return Math.min(this.maxSeconds * 1_000, Math.max(0, this.now() - this.startedAt))
  }

  get maxDurationMs(): number {
    return this.maxSeconds * 1_000
  }

  async start(): Promise<void> {
    if (this.active) return
    this.starting = true
    this.closed = false
    this.chunks = []
    this.totalSamples = 0
    this.lastCountdown = -1
    this.limitFired = false
    this.stopping = null
    this.lastRecording = null
    try {
      // 先显式申请权限（Android 走原生插件；Web 返回 unknown 交给 getUserMedia）
      const permission = (await this.options.ensurePermission?.()) ?? 'unknown'
      if (permission === 'denied') {
        throw new RecorderError('permission-denied', '麦克风权限被拒绝')
      }
      const factory = this.options.capture ?? createMediaCapture
      const session = await factory((samples) => this.pushFrame(samples))
      if (this.closed) {
        // start 还没返回就被 cancel/stop 了（松手太快 / 切后台）：别把麦克风留在后台
        try {
          session.release()
        } catch {
          /* ignore */
        }
        this.starting = false
        return
      }
      this.session = session
      this.sessionRate = session.sampleRate > 0 ? session.sampleRate : TARGET_SAMPLE_RATE
      this.startedAt = this.now()
      this.startTicker()
    } catch (error) {
      this.starting = false
      this.session = null
      this.startedAt = 0
      this.clearTicker()
      if (error instanceof RecorderError) throw error
      throw recorderErrorFor(error)
    }
    this.starting = false
  }

  /** 停止并封装 WAV；可以重复调用（第二次拿同一个结果）。 */
  async stop(): Promise<VoiceRecording> {
    if (this.stopping) return this.stopping
    // 已经结束过（重复松手 / 上限后又一次 stop）：给同一个结果，不重新封装
    if (!this.active && this.lastRecording) return this.lastRecording
    const run = Promise.resolve().then(() => this.finish())
    this.stopping = run
    try {
      const recording = await run
      this.lastRecording = recording
      return recording
    } finally {
      this.stopping = null
    }
  }

  /** 丢弃：释放麦克风，不留结果（上滑取消 / 切后台 / 页面切走）。 */
  cancel(): void {
    this.closed = true
    this.clearTicker()
    this.releaseSession()
    this.chunks = []
    this.totalSamples = 0
    this.startedAt = 0
    this.stopping = null
    this.lastRecording = null
  }

  private finish(): VoiceRecording {
    this.closed = true
    this.clearTicker()
    this.releaseSession()
    const merged = mergeChunks(this.chunks, this.totalSamples)
    this.chunks = []
    this.totalSamples = 0
    this.startedAt = 0
    const rate = this.sampleRateOf()
    const pcm = floatToInt16(downsampleTo16k(merged, rate))
    const wav = encodeWav(pcm)
    return {
      wav,
      // 时长按**实际样本数**算（不是墙钟）：边界帧丢没丢，看这个数字最准
      durationMs: Math.round((pcm.length / TARGET_SAMPLE_RATE) * 1_000),
      sampleRate: TARGET_SAMPLE_RATE,
      samples: pcm.length,
    }
  }

  private sampleRateOf(): number {
    return this.sessionRate
  }

  private pushFrame(samples: Float32Array): void {
    if (!this.session || samples.length === 0) return
    if (this.totalSamples >= this.maxSeconds * TARGET_SAMPLE_RATE) return
    this.chunks.push(samples)
    this.totalSamples += samples.length
    const at = this.now()
    if (at - this.lastLevelAt >= 60) {
      this.lastLevelAt = at
      this.options.onLevel?.(levelFromSamples(samples))
    }
  }

  private startTicker(): void {
    this.clearTicker()
    this.ticker = setInterval(() => this.tick(), this.tickMs)
    ;(this.ticker as unknown as { unref?: () => void }).unref?.()
  }

  private tick(): void {
    if (this.startedAt === 0) return
    const elapsed = this.elapsedMs
    const left = remainingSeconds(this.maxSeconds, elapsed)
    // 单调递减：left 每秒少 1，同一个数只回调一次
    if (left > 0 && left <= COUNTDOWN_SECONDS && left !== this.lastCountdown) {
      this.lastCountdown = left
      this.options.onCountdown?.(left)
    }
    if (elapsed >= this.maxSeconds * 1_000 && !this.limitFired) {
      this.limitFired = true
      this.clearTicker()
      // 先放掉麦克风再通知：上层可能正在等这一下
      this.releaseSession()
      this.options.onLimit?.()
    }
  }

  private releaseSession(): void {
    const session = this.session
    this.session = null
    try {
      session?.release()
    } catch {
      /* ignore */
    }
  }

  private clearTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }
}

function mergeChunks(chunks: readonly Float32Array[], total: number): Float32Array {
  if (chunks.length === 0) return new Float32Array(0)
  if (chunks.length === 1) return chunks[0] ?? new Float32Array(0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}
