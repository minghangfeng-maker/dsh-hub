/**
 * 按住说话（0.4.2）：手势 + 识别会话的状态机，纯 TS、不依赖 Vue，方便单测。
 *
 * 0.4.2 起有两套引擎（`resolveVoiceEngine`）：
 *  - **服务端**（推荐）：App 自己录音（lib/voice-recorder.ts），松手后上传到 Hub 的
 *    `POST /api/mobile/asr`。浮层只显示波形与「正在听…」，**没有实时文字**；
 *  - **手机系统**（0.4.1 的做法，保留为兜底）：调 `SpeechRecognizer`，有实时文字。
 *
 * 交互对齐微信 / Claude 手机端（与 0.4.1 一致，引擎不影响手势）：
 *  - 按住麦克风 ≥200ms 才开始录音（<200ms 松手只轻提示「按住说话」）；
 *  - 录音时手指上滑超过 60px 进入取消态，松手丢弃；否则松手 stop，等结果后把文字交给输入框；
 *  - 服务端引擎到 `maxSeconds` 上限自动结束（浮层最后 10 秒显示倒计时）；
 *  - 切后台 / 页面切走 → cancel()，丢弃且不打扰用户。
 *
 * 引擎选择（自动 / 服务器 / 手机系统）：
 *  - 服务器失败（502 / 网络 / 超时）且系统识别可用 → 本次提示「服务器识别暂时不可用」，
 *    **下一次按住自动改用系统识别**（`serverFailed` 标记，重新进页面或用户改设置后清除）；
 *  - 两者都不可用 → 弹窗说明（`VOICE_TEXT.unavailable`）。
 *
 * 识别文字**永远不进诊断**：只记引擎、字节数、耗时、错误码。
 *
 * 网页版（WP54 / W3）：`createSpeechBridge()` 在浏览器里返回 null（没有原生插件），
 * 所以系统识别引擎不可用，自动模式直接落到**服务端**引擎 —— 浏览器 `getUserMedia({audio})`
 * 录音 → WAV → Hub ASR，链路与 APK 的服务端识别完全一致。权限被拒 / 非 https 的提示
 * 走网页版文案（见 VOICE_TEXT.webPermission / insecure）。
 */

import { recordDiag } from './diagnostics'
import {
  isSpeechUsable,
  type SpeechAvailability,
  type SpeechBridge,
  type SpeechErrorPayload,
  type SpeechSubscription,
} from './speech-native'
import {
  DEFAULT_MAX_SECONDS,
  RecorderError,
  VoiceRecorder,
  clampMaxSeconds,
  type VoiceRecording,
  type VoiceRecorderCreateOptions,
  type VoiceRecorderLike,
} from './voice-recorder'

/** 按住多久算「开始说话」（毫秒）。 */
export const HOLD_MS = 200
/** 手指上滑多少像素算「取消」。 */
export const CANCEL_DISTANCE = 60
/** 松手后等系统识别最终结果的上限（毫秒）。 */
export const FINAL_TIMEOUT_MS = 2000
/** 一段系统识别结束（静音/无结果）后，隔多久续开下一段。 */
export const RESTART_DELAY_MS = 120
/** 系统识别语言：先用简体中文，跟随系统识别包。 */
export const VOICE_LANGUAGE = 'zh-CN'
/** 服务端识别的语言参数（Hub 默认 zh）。 */
export const SERVER_LANGUAGE = 'zh'
/** 服务端识别的最短录音（秒）：太短直接按「没听清」处理，不浪费一次上传。 */
export const MIN_SERVER_SECONDS = 0.3

/** 界面上的固定文案（弹窗标题/建议在组件里，这里只放一句话提示）。 */
export const VOICE_TEXT = {
  hold: '按住说话',
  web: '语音输入仅在 App 中可用',
  unavailable: '这台手机没有可用的系统语音识别服务',
  permission: '没有麦克风权限，请在系统设置里允许 DSH Hub 使用麦克风',
  empty: '没听清，请再说一次',
  cancelled: '已取消',
  /** 手动选了「服务器」但 Hub 没开：说明清楚（不是权限问题）。 */
  serverDisabled: 'Hub 的服务器识别没有开启，可以让管理员在 Hub 上开启语音识别',
  /** 服务端失败、系统识别还能用：下一次按住自动换引擎。 */
  serverDown: '服务器识别暂时不可用，下次按住会自动改用手机识别',
  /** 服务端失败、系统识别也不可用：弹窗说明（两者都不可用）。 */
  serverDownOnly: '服务器识别暂时不可用，这台手机也没有可用的系统识别服务',
  unsupported: '这台设备不能录音',
  /** 网页版权限被拒（WP54 / W3）：不显示「去设置」，改成浏览器站点设置的引导。 */
  webPermission: '没有麦克风权限，请在浏览器地址栏的站点设置里允许麦克风',
  /** 网页版非安全上下文（http）：浏览器根本不提供麦克风，只能换 https。 */
  insecure: '浏览器只在 https 下允许录音，请用 https 地址打开网页版',
} as const

export type VoiceNoticeKind =
  | 'hold'
  | 'web'
  | 'unavailable'
  | 'permission'
  | 'empty'
  | 'error'
  | 'server'
  | 'cancelled'

/** 给界面的一条反馈：`dialog` 走居中弹窗，否则走轻提示（toast）。 */
export interface VoiceNotice {
  kind: VoiceNoticeKind
  text: string
  /** 需要弹窗说明（不可用 / 没权限），带建议与「去设置」。 */
  dialog?: boolean
  /** 弹窗里给「去设置」按钮。 */
  settings?: boolean
}

export type VoicePhase = 'idle' | 'pending' | 'recording' | 'finalizing'

/** 识别引擎：服务端 / 手机系统。 */
export type VoiceEngine = 'server' | 'native'
/** 用户偏好：自动（推荐）/ 服务器 / 手机系统。 */
export type VoiceEnginePreference = 'auto' | 'server' | 'native'

/** 浮层要画的状态快照。 */
export interface VoiceSnapshot {
  phase: VoicePhase
  /** 手指已上滑到取消区。 */
  cancelling: boolean
  /** 已经识别出来的文字（系统识别的 partial；服务端引擎录音中恒为空）。 */
  text: string
  /** 最近一次音量，0–1。 */
  level: number
  /** 本次按住的引擎（idle 时 null）。 */
  engine: VoiceEngine | null
  /** 服务端引擎的倒计时：剩 ≤10 秒才有值，否则 null。 */
  countdown: number | null
}

/** 引擎选择需要的外部事实（偏好来自设置页，其余来自 bootstrap 与原生插件）。 */
export interface VoiceEngineContext {
  preference: VoiceEnginePreference
  /** `bootstrap.voice.asr === true`：Hub 侧识别可用。 */
  serverEnabled: boolean
}

export interface VoiceEngineInputs extends VoiceEngineContext {
  /** 手机系统识别可用（`isSpeechUsable`）。 */
  nativeUsable: boolean
  /** 上一次服务端识别失败过（自动模式下本次改用系统识别）。 */
  serverFailed?: boolean
}

/**
 * 引擎选择矩阵（单测逐格覆盖）：
 *
 * | 偏好 | 条件 | 结果 |
 * | --- | --- | --- |
 * | server | 服务端可用 | server |
 * | server | 服务端不可用 | null（弹窗说明，**不偷偷**改用系统识别） |
 * | native | 系统可用 | native |
 * | native | 系统不可用 | null（同上） |
 * | auto | 服务端可用且没失败过 | server |
 * | auto | 服务端失败过、系统可用 | native（下次自动换引擎） |
 * | auto | 服务端不可用、系统可用 | native |
 * | auto | 服务端失败过、系统不可用 | server（重试；用户再按就是重来） |
 * | auto | 两者都不可用 | null（弹窗说明） |
 *
 * 手动选择**严格生效**：用户明确选了「手机系统」时，绝不因为系统识别不可用就悄悄把录音
 * 传去服务器 —— 这既是可预期性，也是隐私选择。自动模式才做「能用的顶上」。
 */
export function resolveVoiceEngine(inputs: VoiceEngineInputs): VoiceEngine | null {
  const { preference, serverEnabled, nativeUsable } = inputs
  const serverFailed = inputs.serverFailed === true
  if (preference === 'server') return serverEnabled ? 'server' : null
  if (preference === 'native') return nativeUsable ? 'native' : null
  // auto
  if (serverEnabled && !serverFailed) return 'server'
  if (nativeUsable) return 'native'
  return serverEnabled ? 'server' : null
}

export interface VoiceInputOptions {
  /** 原生桥；null = Web / 壳里没有插件。 */
  bridge: SpeechBridge | null
  /** 可用性检查（默认走 speech-native 的缓存版本）；测试里注入假实现。 */
  checkAvailability?: () => Promise<SpeechAvailability | null>
  /** 触感：开始录音 / 上滑取消。 */
  haptic?: (kind: 'start' | 'cancel') => void
  onSnapshot?: (snapshot: VoiceSnapshot) => void
  onNotice?: (notice: VoiceNotice) => void
  /** 一段话识别完（松手后的最终文字，已去掉首尾空白）。 */
  onText?: (text: string) => void
  language?: string
  /** 诊断埋点（默认写本地诊断事件；**只记状态与码，不记文字**）。 */
  onDiag?: (name: string, detail?: string) => void

  /* ---------- 0.4.2：引擎 ---------- */
  /** 每次按住时重新算偏好与服务端可用性（bootstrap / 设置页会变）。 */
  engine?: () => VoiceEngineContext
  /** 服务端识别上传（不提供 = 服务端引擎不可用）。 */
  transcribe?: (wav: Uint8Array, lang?: string) => Promise<{ text?: string }>
  /** 单段上限（秒），默认 60；真实值来自 `bootstrap.voice.maxSeconds`。 */
  maxSeconds?: () => number
  /** 录音器工厂（默认 new VoiceRecorder；测试注入假实现）。 */
  createRecorder?: (options: VoiceRecorderCreateOptions) => VoiceRecorderLike
  /** 打开麦克风前申请权限（Android 原生插件）；默认不预申请。 */
  ensureMicPermission?: () => Promise<'granted' | 'denied' | 'unknown'>
}

/* ---------- 纯函数（单测直接覆盖） ---------- */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const NO_SPACE_BEFORE = /[，。！？、；：,.!?;:…—～~）)】》」』”’]/
const NO_SPACE_AFTER = /[（(【《「『“’]/

/** 两段文字之间要不要补一个空格（中文不加，英文/数字之间加）。 */
function needsSpace(left: string, right: string): boolean {
  if (!left || !right) return false
  const last = left[left.length - 1] ?? ''
  const first = right[0] ?? ''
  if (/\s/.test(last) || /\s/.test(first)) return false
  if (NO_SPACE_AFTER.test(last)) return false
  if (NO_SPACE_BEFORE.test(first)) return false
  if (CJK.test(last) || CJK.test(first)) return false
  return true
}

/**
 * 把识别文字追加到输入框现有文字后面（按需补空格）。
 *
 * 例：`'' + '你好'` → `你好`；`'hello' + 'world'` → `hello world`；
 * `'你好' + '，世界'` → `你好，世界`（标点前不补空格）。
 */
export function appendTranscript(current: string, addition: string): string {
  const base = current ?? ''
  const extra = (addition ?? '').trim()
  if (!extra) return base
  if (!base) return extra
  if (/\s$/.test(base)) return `${base}${extra}`
  return needsSpace(base, extra) ? `${base} ${extra}` : `${base}${extra}`
}

/** 多段 final 拼成一句话（同样的补空格规则）。 */
export function joinSegments(segments: readonly string[]): string {
  return segments.reduce((acc, segment) => appendTranscript(acc, segment), '')
}

/** 系统给的 rms（约 -2…10 dB）→ 0–1 的波形高度。 */
export function normalizeRms(rms: number | undefined | null): number {
  if (typeof rms !== 'number' || !Number.isFinite(rms)) return 0
  const value = (rms + 2) / 12
  return Math.min(1, Math.max(0, value))
}

/** 手指上滑是否已经进入取消区（超过 60px）。 */
export function isCancelDistance(startY: number, currentY: number): boolean {
  return startY - currentY > CANCEL_DISTANCE
}

const NATIVE_ERROR_SLUGS: Record<number, string> = {
  1: 'network-timeout',
  2: 'network',
  3: 'audio',
  4: 'server',
  5: 'client',
  6: 'no-speech',
  7: 'no-match',
  8: 'busy',
  9: 'permission-denied',
  10: 'too-many-requests',
  11: 'server-disconnected',
  12: 'language-not-supported',
  13: 'language-unavailable',
  14: 'cannot-check-support',
  15: 'cannot-listen-downloads',
}

const SPEECH_ERROR_TEXT: Record<string, string> = {
  'network-timeout': '网络超时了，请重试',
  network: '网络不可用，请检查网络后再试',
  audio: '录音出错了，请重试',
  server: '识别服务出错了，请重试',
  client: '识别被中断了，请重试',
  'no-speech': '没听清，请再说一次',
  'no-match': '没听清，请再说一次',
  busy: '识别服务忙，请稍后再试',
  'permission-denied': '没有麦克风权限，请在系统设置里允许 DSH Hub 使用麦克风',
  'too-many-requests': '识别太频繁了，请稍后再试',
  'server-disconnected': '识别服务断开了，请重试',
  'language-not-supported': '系统语音识别不支持中文',
  'language-unavailable': '系统缺少中文识别包，请在系统设置里下载',
  'cannot-check-support': '这台手机的系统语音识别不可用',
  'cannot-listen-downloads': '系统识别服务还没准备好，请稍后再试',
  'no-recognizer': '这台手机没有可用的系统语音识别服务',
  unavailable: '这台手机没有可用的系统语音识别服务',
  unknown: '识别出错了，请再试一次',
}

/** 把原生错误码（数字或字符串）规范成稳定 slug。 */
export function speechErrorSlug(code: string | number | undefined | null): string {
  if (typeof code === 'number') return NATIVE_ERROR_SLUGS[code] ?? 'unknown'
  if (typeof code === 'string' && code.trim().length > 0) {
    const numeric = Number(code)
    if (Number.isInteger(numeric) && NATIVE_ERROR_SLUGS[numeric]) return NATIVE_ERROR_SLUGS[numeric]!
    return code.trim()
  }
  return 'unknown'
}

/** 错误码 → 中文（原生已经带 message 时优先用原生的）。 */
export function describeSpeechError(
  code: string | number | undefined | null,
  fallback?: string,
): string {
  const slug = speechErrorSlug(code)
  const mapped = SPEECH_ERROR_TEXT[slug]
  if (mapped) return mapped
  const custom = typeof fallback === 'string' ? fallback.trim() : ''
  return custom || SPEECH_ERROR_TEXT['unknown']!
}

/* ---------- 服务端识别的错误映射 ---------- */

/** 上传失败时值得「下次改用系统识别」的码（识别服务侧的问题，不是我们录坏了）。 */
const SERVER_FALLBACK_CODES = new Set([
  'UPSTREAM_ERROR',
  'network',
  'timeout',
  'INTERNAL',
  'upstream-unavailable',
  'protocol',
])

/** 从任意错误对象里取稳定的错误码（HubApiError / RecorderError / DOM 错误）。 */
export function asrErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; name?: unknown }
    if (typeof record.code === 'string' && record.code.length > 0) return record.code
    if (record.name === 'AbortError') return 'timeout'
  }
  return 'unknown'
}

/** 服务端识别的错误码 → 中文（界面只显示这一句）。 */
export function describeAsrError(code: string, fallback?: string): string {
  switch (code) {
    case 'UPSTREAM_ERROR':
    case 'upstream-unavailable':
      return VOICE_TEXT.serverDownOnly
    case 'network':
      return '网络连接失败，这段录音没发出去，请检查网络后重试'
    case 'timeout':
      return '识别超时了，请再说一次'
    case 'PAYLOAD_TOO_LARGE':
      return '录音太长了，请说短一点'
    case 'UNSUPPORTED_MEDIA':
    case 'VALIDATION_FAILED':
      return '这段录音没能识别，请再说一次'
    case 'RATE_LIMITED':
      return '识别太频繁了，请稍后再试'
    case 'permission-denied':
      return VOICE_TEXT.permission
    case 'insecure':
      return VOICE_TEXT.insecure
    case 'unavailable':
    case 'unsupported':
      return VOICE_TEXT.unsupported
    default: {
      const custom = typeof fallback === 'string' ? fallback.trim() : ''
      return custom || '识别出错了，请再试一次'
    }
  }
}

/** 是否值得「下次自动改用系统识别」。 */
export function isServerFallbackCode(code: string): boolean {
  return SERVER_FALLBACK_CODES.has(code)
}

/** 静音/没听清：按住期间遇到它应当默默续一段，不给用户报错。 */
function isSoftError(code: string): boolean {
  return code === 'no-speech' || code === 'no-match'
}

interface ErrorDetails {
  code: string
  message: string
}

function errorDetails(error: unknown): ErrorDetails {
  if (error && typeof error === 'object') {
    const record = error as {
      code?: unknown
      message?: unknown
      data?: { code?: unknown; message?: unknown }
    }
    const rawCode = record.code ?? record.data?.code
    const code =
      typeof rawCode === 'string' || typeof rawCode === 'number'
        ? speechErrorSlug(rawCode)
        : 'unknown'
    const rawMessage = record.message ?? record.data?.message
    const message =
      typeof rawMessage === 'string' && rawMessage.trim().length > 0
        ? rawMessage.trim()
        : describeSpeechError(code)
    return { code, message }
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return { code: 'unknown', message: error.trim() }
  }
  return { code: 'unknown', message: SPEECH_ERROR_TEXT['unknown']! }
}

/* ---------- 状态机 ---------- */

type Timer = ReturnType<typeof setTimeout>

export class VoiceInput {
  private readonly bridge: SpeechBridge | null
  private readonly checkAvailability: () => Promise<SpeechAvailability | null>
  private readonly haptic: (kind: 'start' | 'cancel') => void
  private readonly onSnapshot: (snapshot: VoiceSnapshot) => void
  private readonly onNotice: (notice: VoiceNotice) => void
  private readonly onText: (text: string) => void
  private readonly onDiag: (name: string, detail?: string) => void
  private readonly language: string
  private readonly engineContext: () => VoiceEngineContext
  private readonly transcribe?: (wav: Uint8Array, lang?: string) => Promise<{ text?: string }>
  private readonly maxSeconds: () => number
  private readonly createRecorder: (options: VoiceRecorderCreateOptions) => VoiceRecorderLike

  private subscriptions: SpeechSubscription[] = []
  private phase: VoicePhase = 'idle'
  private pressed = false
  private gesture = 0
  private pressStartY = 0
  private cancelling = false
  private segments: string[] = []
  private partial = ''
  private level = 0
  private holdTimer: Timer | null = null
  private finalTimer: Timer | null = null
  private restartTimer: Timer | null = null
  private availability: SpeechAvailability | null = null
  private availabilityTask: Promise<SpeechAvailability | null> | null = null
  private destroyed = false

  /* 0.4.2 引擎状态 */
  private engine: VoiceEngine | null = null
  private recorder: VoiceRecorderLike | null = null
  private countdown: number | null = null
  private serverFailed = false
  private nativeUsable = false

  constructor(options: VoiceInputOptions) {
    this.bridge = options.bridge
    this.checkAvailability = options.checkAvailability ?? (async () => null)
    this.haptic = options.haptic ?? (() => {})
    this.onSnapshot = options.onSnapshot ?? (() => {})
    this.onNotice = options.onNotice ?? (() => {})
    this.onText = options.onText ?? (() => {})
    this.onDiag = options.onDiag ?? ((name, detail) => recordDiag(name, detail ?? ''))
    this.language = options.language ?? VOICE_LANGUAGE
    this.engineContext =
      options.engine ??
      (() => ({ preference: 'auto' as const, serverEnabled: false }))
    this.transcribe = options.transcribe
    this.maxSeconds = options.maxSeconds ?? (() => DEFAULT_MAX_SECONDS)
    this.createRecorder =
      options.createRecorder ??
      ((recorderOptions) =>
        new VoiceRecorder({
          ...recorderOptions,
          ensurePermission: options.ensureMicPermission,
        }))
    this.bindEvents()
  }

  get snapshot(): VoiceSnapshot {
    return {
      phase: this.phase,
      cancelling: this.cancelling,
      text: joinSegments([...this.segments, this.partial]),
      level: this.level,
      engine: this.engine,
      countdown: this.countdown,
    }
  }

  /** 正在按住 / 正在等结果（浮层要用）。 */
  get active(): boolean {
    return this.phase !== 'idle' || this.pressed
  }

  /** 预查可用性（进入页面时调一次，按住时就不用等检查了）。 */
  async prepare(): Promise<SpeechAvailability | null> {
    if (!this.bridge) {
      this.nativeUsable = false
      return null
    }
    if (this.availability) return this.availability
    if (!this.availabilityTask) {
      this.availabilityTask = this.checkAvailability()
        .then((value) => {
          this.availability = value
          this.nativeUsable = isSpeechUsable(value)
          return value
        })
        .catch(() => null)
    }
    return this.availabilityTask
  }

  /**
   * 手指按下（坐标只用于上滑取消，x 目前不参与判断）。
   *
   * 这里是 async 的：可用性检查还没回来时松手要能正确收尾，所以用 `gesture` 记号作废
   * 过期的后续动作。
   */
  async pointerDown(x: number, y: number): Promise<void> {
    if (this.destroyed || this.pressed || this.phase !== 'idle') return
    this.pressed = true
    this.pressStartY = y
    this.cancelling = false
    const token = ++this.gesture
    const availability = await this.prepare()
    if (this.destroyed || !this.pressed || token !== this.gesture) return

    this.nativeUsable = isSpeechUsable(availability)
    const context = this.engineContext()
    const engine = resolveVoiceEngine({
      preference: context.preference,
      serverEnabled: context.serverEnabled && typeof this.transcribe === 'function',
      nativeUsable: this.nativeUsable,
      serverFailed: this.serverFailed,
    })

    if (!engine) {
      this.pressed = false
      this.onDiag('speech:engine', 'none')
      if (!this.bridge && !context.serverEnabled) {
        // 浏览器里既没有原生桥、Hub 也没开服务端识别：与 0.4.1 同一句提示
        this.onNotice({ kind: 'web', text: VOICE_TEXT.web })
        return
      }
      this.onDiag(
        'speech:unavailable',
        availability?.reason ?? (context.serverEnabled ? 'server-disabled' : 'none'),
      )
      const text =
        context.preference === 'server' && !context.serverEnabled
          ? VOICE_TEXT.serverDisabled
          : VOICE_TEXT.unavailable
      this.onNotice({ kind: 'unavailable', text, dialog: true })
      return
    }

    this.engine = engine
    this.onDiag('speech:engine', `${engine} · ${context.preference}`)
    this.phase = 'pending'
    this.emit()
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      void this.beginRecording()
    }, HOLD_MS)
  }

  /** 手指移动：只有上滑超过阈值才切换取消态。 */
  pointerMove(y: number): void {
    if (this.phase !== 'recording') return
    const next = isCancelDistance(this.pressStartY, y)
    if (next === this.cancelling) return
    this.cancelling = next
    if (next) this.haptic('cancel')
    this.emit()
  }

  /** 手指抬起：短按提示；录音中则收尾（或按取消态丢弃）。 */
  async pointerUp(): Promise<void> {
    const wasPressed = this.pressed
    this.pressed = false
    this.gesture += 1

    if (this.phase === 'pending') {
      this.clearHoldTimer()
      this.phase = 'idle'
      this.engine = null
      this.emit()
      this.onNotice({ kind: 'hold', text: VOICE_TEXT.hold })
      return
    }
    if (this.phase === 'idle' && wasPressed) {
      // 可用性检查还没回来就松手：当作短按，别把录音留在半路
      this.onNotice({ kind: 'hold', text: VOICE_TEXT.hold })
      return
    }
    if (this.phase === 'recording') {
      if (this.cancelling) {
        this.abortSession('cancelled')
        return
      }
      if (this.engine === 'server') {
        await this.finalizeServer()
        return
      }
      await this.finalize()
    }
  }

  /** 页面切走 / 切后台 / 来电：静默丢弃，不插入文字。 */
  cancel(): void {
    if (this.phase === 'idle' && !this.pressed) return
    this.abortSession()
  }

  destroy(): void {
    this.cancel()
    this.destroyed = true
    for (const subscription of this.subscriptions) subscription.remove()
    this.subscriptions = []
  }

  /** 用户改了引擎偏好 / 服务端恢复：清掉「上次失败」的标记。 */
  resetServerFailure(): void {
    this.serverFailed = false
  }

  /** 只给测试：当前阶段。 */
  get currentPhase(): VoicePhase {
    return this.phase
  }

  /** 只给测试：本段录音用的引擎。 */
  get currentEngine(): VoiceEngine | null {
    return this.engine
  }

  /* ---------- 内部 ---------- */

  private bindEvents(): void {
    if (!this.bridge) return
    this.subscriptions.push(
      this.bridge.on('partial', (payload) => this.handlePartial(payload?.text)),
      this.bridge.on('final', (payload) => this.handleFinal(payload?.text)),
      this.bridge.on('level', (payload) => this.handleLevel(payload?.rms)),
      this.bridge.on('end', () => this.handleEnd()),
      this.bridge.on('error', (payload) => this.handleError(payload)),
    )
  }

  private emit(): void {
    this.onSnapshot(this.snapshot)
  }

  /** 读当前阶段（用方法读，避免 TS 把 `this.phase` 的窄化带过 await）。 */
  private phaseNow(): VoicePhase {
    return this.phase
  }

  private async beginRecording(): Promise<void> {
    if (this.destroyed || !this.pressed || this.phase !== 'pending') return
    this.phase = 'recording'
    this.cancelling = false
    this.segments = []
    this.partial = ''
    this.level = 0
    this.countdown = null
    this.emit()
    this.haptic('start')
    if (this.engine === 'server') {
      this.startServerRecording()
      return
    }
    await this.startSegment()
  }

  /* ---------- 服务端引擎 ---------- */

  private startServerRecording(): void {
    let recorder: VoiceRecorderLike
    try {
      recorder = this.createRecorder({
        maxSeconds: clampMaxSeconds(this.maxSeconds()),
        onLevel: (level) => this.handleRecorderLevel(level),
        onCountdown: (left) => this.handleCountdown(left),
        onLimit: () => this.handleLimit(),
      })
    } catch {
      this.failServerStart(new RecorderError('unsupported', VOICE_TEXT.unsupported))
      return
    }
    this.recorder = recorder
    void recorder
      .start()
      .then(() => {
        // 开麦过程中用户已经松手 / 切后台：这一段已经作废，立刻释放麦克风
        if (this.phaseNow() !== 'recording') recorder.cancel()
      })
      .catch((error) => this.failServerStart(error))
  }

  private failServerStart(error: unknown): void {
    this.recorder = null
    // 开麦失败（权限 / 没有麦克风）不是服务端的问题：**不**标记服务器不可用，
    // 否则下一次按住会被误判成「服务器挂了」而改用系统识别
    if (this.phase === 'idle') {
      // 已经收尾过：只提示，不改变状态
      this.emit()
      this.onNotice(this.recorderErrorNotice(error))
      return
    }
    const failure = this.recorderErrorNotice(error)
    this.resetSession()
    this.emit()
    this.onDiag('speech:error', asrErrorCode(error))
    this.onNotice(failure)
  }

  private async finalizeServer(): Promise<void> {
    if (this.phase !== 'recording') return
    this.clearRestartTimer()
    this.phase = 'finalizing'
    this.cancelling = false
    this.emit()
    const recorder = this.recorder
    this.recorder = null
    let recording: VoiceRecording | null = null
    try {
      recording = recorder ? await recorder.stop() : null
    } catch {
      recording = null
    }
    if (this.phase !== 'finalizing') return
    if (!recording || recording.samples < MIN_SERVER_SECONDS * 16_000) {
      this.finishServer({ kind: 'empty' })
      return
    }
    await this.uploadRecording(recording)
  }

  private async uploadRecording(recording: VoiceRecording): Promise<void> {
    const bytes = recording.wav.byteLength
    const startedAt = Date.now()
    try {
      const result = await this.transcribe!(recording.wav, SERVER_LANGUAGE)
      const ms = Date.now() - startedAt
      this.onDiag('speech:upload', `bytes=${bytes} ms=${ms} code=ok`)
      if (this.phase !== 'finalizing') return
      this.serverFailed = false
      const text = typeof result?.text === 'string' ? result.text.trim() : ''
      if (text.length === 0) this.finishServer({ kind: 'empty' })
      else this.finishServer({ kind: 'text', text })
    } catch (error) {
      const code = asrErrorCode(error)
      const ms = Date.now() - startedAt
      this.onDiag('speech:upload', `bytes=${bytes} ms=${ms} code=${code}`)
      if (this.phase !== 'finalizing') return
      this.finishServer({ kind: 'error', code, message: describeAsrError(code) })
    }
  }

  private handleCountdown(left: number): void {
    if (this.phase !== 'recording') return
    this.countdown = left > 0 ? left : null
    this.emit()
  }

  private handleRecorderLevel(level: number): void {
    if (this.phase !== 'recording') return
    this.level = Math.min(1, Math.max(0, level))
    this.emit()
  }

  /** 到上限（浮层最后 10 秒在倒计时）：当作「松手」，走同一条收尾路径。 */
  private handleLimit(): void {
    if (this.phase !== 'recording' || this.engine !== 'server') return
    this.pressed = false
    this.gesture += 1
    this.cancelling = false
    this.countdown = null
    this.onDiag('speech:limit', `${Math.round(clampMaxSeconds(this.maxSeconds()))}s`)
    void this.finalizeServer()
  }

  /** 服务端引擎收尾：有文字交出去；空/错误按情形提示（失败时允许下次换系统识别）。 */
  private finishServer(outcome: { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'error'; code: string; message: string }): void {
    if (this.phase === 'idle') return
    this.resetSession()
    this.emit()
    if (outcome.kind === 'text') {
      this.onDiag('speech:insert', `${outcome.text.length} 字`)
      this.onText(outcome.text)
      return
    }
    if (outcome.kind === 'empty') {
      this.onNotice({ kind: 'empty', text: VOICE_TEXT.empty })
      return
    }
    const fallback = isServerFallbackCode(outcome.code)
    if (fallback) {
      this.serverFailed = true
      // 系统识别可用：轻提示 + 下次自动换引擎；两者都不可用：弹窗说明
      this.onNotice(
        this.nativeUsable
          ? { kind: 'server', text: VOICE_TEXT.serverDown }
          : { kind: 'server', text: VOICE_TEXT.serverDownOnly, dialog: true },
      )
      return
    }
    this.onNotice({ kind: 'error', text: outcome.message })
  }

  private recorderErrorNotice(error: unknown): VoiceNotice {
    const code = error instanceof RecorderError ? error.code : asrErrorCode(error)
    if (code === 'insecure') {
      // 网页版 http：浏览器不给麦克风，换 https 才行（不是权限问题，别显示「去设置」）
      return { kind: 'error', text: VOICE_TEXT.insecure, dialog: true }
    }
    if (code === 'permission-denied') {
      return {
        kind: 'permission',
        text: VOICE_TEXT.permission,
        dialog: true,
        settings: true,
      }
    }
    if (code === 'unsupported' || code === 'unavailable') {
      return { kind: 'error', text: describeAsrError(code), dialog: true }
    }
    return { kind: 'error', text: describeAsrError(code) }
  }

  /* ---------- 系统识别引擎（0.4.1） ---------- */

  private async startSegment(): Promise<void> {
    if (!this.bridge || this.phase !== 'recording' || this.destroyed) return
    try {
      await this.bridge.start({
        language: this.language,
        partial: true,
        preferOffline: true,
      })
      // start 在等权限时用户可能已经松手：补一刀 stop，别让麦克风在后台继续录。
      if (this.phaseNow() === 'finalizing') {
        try {
          await this.bridge.stop()
        } catch {
          /* 停不下来就等超时 */
        }
      }
    } catch (error) {
      this.fail(error)
    }
  }

  private async finalize(): Promise<void> {
    if (this.phase !== 'recording') return
    this.clearRestartTimer()
    this.phase = 'finalizing'
    this.cancelling = false
    this.emit()
    this.clearFinalTimer()
    this.finalTimer = setTimeout(() => {
      this.finalTimer = null
      if (this.phase !== 'finalizing') return
      // 等不到 final 也不能让麦克风继续录：先取消原生会话再收尾
      void this.bridge?.cancel()
      this.finish()
    }, FINAL_TIMEOUT_MS)
    try {
      const result = await this.bridge?.stop()
      // 系统早已结束这一段（没有识别器在听）：不会再有 final，立刻收尾
      if (this.phaseNow() === 'finalizing' && result?.listening === false) this.finish()
    } catch {
      /* stop 失败就等 final 超时 */
    }
  }

  /** 收尾：有文字就交给输入框，没有就按情况提示。 */
  private finish(error?: ErrorDetails): void {
    if (this.phase === 'idle') return
    this.clearFinalTimer()
    this.clearRestartTimer()
    // 一段 final 都没等到（有的 ROM 只给 partial）：把屏幕上已经显示的文字填进去，
    // 总比让用户白说一遍好。
    const fallback = this.segments.length === 0 && this.partial.trim().length > 0 ? [this.partial] : []
    const text = joinSegments([...this.segments, ...fallback])
    this.resetSession()
    this.emit()
    if (text.length > 0) {
      this.onDiag('speech:insert', `${text.length} 字`)
      this.onText(text)
      return
    }
    if (error) {
      if (isSoftError(error.code)) {
        this.onNotice({ kind: 'empty', text: VOICE_TEXT.empty })
        return
      }
      this.onNotice(this.errorNotice(error))
      return
    }
    this.onNotice({ kind: 'empty', text: VOICE_TEXT.empty })
  }

  private abortSession(noticeKind?: 'cancelled'): void {
    this.pressed = false
    this.gesture += 1
    this.clearHoldTimer()
    this.clearFinalTimer()
    this.clearRestartTimer()
    const hadSession = this.phase !== 'idle'
    const recorder = this.recorder
    this.recorder = null
    try {
      recorder?.cancel()
    } catch {
      /* ignore */
    }
    this.resetSession()
    if (hadSession) {
      void this.bridge?.cancel()
    }
    this.emit()
    if (noticeKind === 'cancelled') {
      this.onNotice({ kind: 'cancelled', text: VOICE_TEXT.cancelled })
    }
  }

  /** 清掉一段会话的所有临时状态（不动 pressed / 定时器）。 */
  private resetSession(): void {
    this.phase = 'idle'
    this.engine = null
    this.segments = []
    this.partial = ''
    this.level = 0
    this.countdown = null
    this.cancelling = false
  }

  private fail(error: unknown): void {
    const details = errorDetails(error)
    this.onDiag('speech:error', details.code)
    if (this.phase === 'recording' || this.phase === 'finalizing') {
      void this.bridge?.cancel()
      this.finish(details)
      return
    }
    this.onNotice(this.errorNotice(details))
  }

  private errorNotice(error: ErrorDetails): VoiceNotice {
    switch (error.code) {
      case 'permission-denied':
        return {
          kind: 'permission',
          text: error.message || VOICE_TEXT.permission,
          dialog: true,
          settings: true,
        }
      case 'no-recognizer':
      case 'unavailable':
      case 'cannot-check-support':
        return { kind: 'unavailable', text: VOICE_TEXT.unavailable, dialog: true }
      default:
        return { kind: 'error', text: error.message }
    }
  }

  private handlePartial(text: string | undefined): void {
    if (this.phase !== 'recording') return
    this.partial = typeof text === 'string' ? text : ''
    this.emit()
  }

  private handleFinal(text: string | undefined): void {
    const segment = typeof text === 'string' ? text.trim() : ''
    if (this.phase === 'recording') {
      if (segment.length > 0) this.segments.push(segment)
      this.partial = ''
      this.emit()
      this.scheduleRestart()
      return
    }
    if (this.phase === 'finalizing') {
      if (segment.length > 0) this.segments.push(segment)
      this.partial = ''
      this.finish()
    }
  }

  private handleLevel(rms: number | undefined): void {
    if (this.phase !== 'recording' && this.phase !== 'finalizing') return
    this.level = normalizeRms(rms)
    this.emit()
  }

  private handleEnd(): void {
    // 系统一段识别结束（静音/无结果）。
    //  - 等 final 的收尾：可以提前完成，不用干等 2 秒；
    //  - 还在按住：如果是系统自己结束的（没给 final/error），续开下一段。
    if (this.phase === 'finalizing') {
      this.finish()
      return
    }
    // final 后面紧跟的 end 不要再把续段推迟一轮
    if (this.phase === 'recording' && this.restartTimer === null) this.scheduleRestart()
  }

  private handleError(payload: SpeechErrorPayload | undefined): void {
    const code = speechErrorSlug(payload?.code)
    const message =
      typeof payload?.message === 'string' && payload.message.trim().length > 0
        ? payload.message.trim()
        : describeSpeechError(code)
    // 真机排错（0.4.2）：带上系统给的原始码与**默认识别服务组件名**，不记识别文字
    const parts = [`code=${code}`]
    if (payload?.nativeCode !== undefined && payload.nativeCode !== null) {
      parts.push(`native=${payload.nativeCode}`)
    }
    if (typeof payload?.service === 'string' && payload.service.length > 0) {
      parts.push(`service=${payload.service}`)
    }
    const detail = parts.join(' ')
    if (this.phase === 'recording' && isSoftError(code)) {
      // 静音自动结束（用户还没松手）：悄悄续一段，不打扰用户
      this.partial = ''
      this.emit()
      this.scheduleRestart()
      return
    }
    this.onDiag('speech:error', detail)
    if (this.phase === 'recording' || this.phase === 'finalizing') {
      void this.bridge?.cancel()
      this.finish({ code, message })
    }
  }

  private scheduleRestart(): void {
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.phase === 'recording') void this.startSegment()
    }, RESTART_DELAY_MS)
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }

  private clearFinalTimer(): void {
    if (this.finalTimer !== null) {
      clearTimeout(this.finalTimer)
      this.finalTimer = null
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }
}
