/**
 * 进程内 mock Hub：没有网络也能把「登录 → bootstrap → 唤醒 → 连接 → 发消息 →
 * 流式 → 停止 → 断线续传」整条链路走一遍。
 *
 * 它**不是** UI 的假数据源：通道帧、能力位、幂等、assistant-baseline 都按 v1 契约生成，
 * WorkspaceController 走的是和真实 Hub 完全相同的代码路径。所以 mock APK 能真实暴露
 * 状态机问题，而不是「看起来能用」。正式构建不会包含它（只在 VITE_HUB_ORIGIN=mock 时引入）。
 *
 * 账号（只在 mock 里存在）：
 *   demo / demo1234        正常账号
 *   pending / demo1234     待审批（USER_PENDING）
 *   disabled / demo1234    已停用（USER_DISABLED）
 *   changepw / demo1234    必须改密码（MUST_CHANGE_PASSWORD）
 *   ratelimit / demo1234   触发限流（RATE_LIMITED）
 */

import {
  MOBILE_ASR_MAX_BYTES,
  MOBILE_CLOUD_NODE_ID,
  MOBILE_TTS_CHARS_LIMIT,
  TTS_DEFAULT_SAMPLE_RATE,
  type AsrResponse,
  type AuthTokens,
  type Bootstrap,
  type BootstrapTts,
  type LoginRequest,
  type TtsAudio,
  type TtsStream,
  type TtsVoice,
  type WakeResponse,
} from '../contracts/auth-bootstrap.js'
import { HubApiError } from '../errors.js'
import type { HubGateway } from '../gateway.js'
import type { ChannelLink, ChannelLinkEvent } from '../channel/link.js'
import { decodeClientFrame } from '../channel/wire.js'
import { MemoryTokenStore, type TokenStore } from '../auth/token-store.js'
import type { MobileClientFrame, MobileServerFrame, MobileSessionRow } from '@dsh-hub/shared'
import type { MobileClientFrameV2, MobileServerFrameV2 } from '../contracts/mobile-v2.js'
import { MOCK_HISTORY, MOCK_REPLY, MOCK_TICK_MS } from './content.js'
import { MOCK_MODEL_CATALOG } from './models-catalog.js'
import { encodeTtsPcm, encodeTtsWav } from './tts-wav.js'

/** 是不是一段像样的 WAV（RIFF/WAVE + fmt 块）：mock 用它模拟 Hub 的 400。 */
function isWavBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44) return false
  const tag = (offset: number, text: string): boolean => {
    for (let i = 0; i < text.length; i += 1) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false
    }
    return true
  }
  return tag(0, 'RIFF') && tag(8, 'WAVE')
}

/** 从 WAV 的 data 块长度估时长（16kHz / 单声道 / 16bit：每秒 32000 字节）。 */
function wavDurationMs(bytes: Uint8Array): number {
  if (bytes.byteLength <= 44) return 0
  return Math.max(0, Math.round(((bytes.byteLength - 44) / 32_000) * 1_000))
}

/**
 * 按开关给朗读能力加上/去掉 `stream`（0.4.6）：`false` 时是**老 Hub 形状**（字段不存在），
 * 不能留一个 `stream: false` —— 那会让「老 Hub 不发这个字段」的语义测不出来。
 */
function withStreamCapability(tts: BootstrapTts, stream: boolean): BootstrapTts {
  if (stream) return { ...tts, stream: true }
  const { stream: _drop, ...rest } = tts
  return rest
}

/** 可被 abort 提前唤醒的等待（mock 流式下发用；不留下悬着的定时器）。 */
function mockSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const timer = setTimeout(() => finish(), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    function finish(): void {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

const CAPABILITIES = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
  // v2 能力位（与 v1 平铺）
  models: true,
  rename: true,
  archive: true,
  filesRead: true,
  filesList: true,
  filesUpload: true,
  deliverables: true,
}

/** mock 支持的 v2 feature：客户端声明什么就回显什么（交集）。 */
const SUPPORTED_FEATURES = ['models', 'archive', 'reasoning', 'tools', 'usage', 'session-state']

const DESKTOP_NODE = {
  id: 'dv_mock_desktop_01',
  kind: 'desktop' as const,
  name: '书房的 Windows',
  status: 'host-running' as const,
  presence: 'online' as const,
  connectable: false,
  reason: 'desktop-remote-off' as const,
  clientVersion: '0.9.3',
}

interface MockMessage {
  seq: number
  role: 'user' | 'assistant' | 'system'
  at: number
  text: string
  tools?: string[]
  clientMessageId?: string
}

interface MockSession {
  sessionId: string
  title: string | null
  createdAt: number
  updatedAt: number
  messages: MockMessage[]
  running: boolean
}

interface TurnRuntime {
  sessionId: string
  attemptId: string
  revision: number
  target: string
  delivered: number
  timer: ReturnType<typeof setInterval> | null
  listeners: Set<MockChannelLink>
  stopped: boolean
}

export interface MockHubOptions {
  tokenStore?: TokenStore
  now?: () => number
  /** 每个字符之间的间隔（ms），默认 25 → 40 字/秒。 */
  tickMs?: number
  /** 唤醒耗时（ms），默认 1200。 */
  wakeMs?: number
  /** bootstrap 的语音能力（0.4.2）：默认 `{ asr: true, maxSeconds: 60 }`；`false` = 老 Hub 不发该字段。 */
  voice?: { asr: boolean; maxSeconds: number } | null
  /** 服务端识别返回的固定文字（默认「这是一段测试语音」）。 */
  asrText?: string
  /**
   * 朗读能力（0.4.3 / WP50）：默认开启、只有一个音色「星汐 seki」。
   * `null` = 老 Hub / 管理端没开朗读（bootstrap 里没有 `voice.tts`）。
   */
  tts?: BootstrapTts | null
  /** 每次整段合成的固定延迟（ms），默认 0：e2e 用来看清「边播边合成」的时序。 */
  ttsDelayMs?: number
  /**
   * 流式朗读能力（0.4.6 / WP51）：默认 true（bootstrap.voice.tts.stream = true）。
   * `false` = 模拟**老 Hub**（只有整段 `/tts`），App 应回退整段模式。
   */
  ttsStream?: boolean
  /** 流式下发的节奏（mock 用；默认首块 200ms、每块 200ms 音频、速率 0.9）。 */
  ttsStreamTiming?: MockTtsStreamTiming
}

/**
 * mock 流式下发的节奏参数。
 *
 * 真 Hub 的星汐首块约 0.2 秒、之后合成速率 r 在 0.9（GPU 被占）到 1.05 之间；e2e 用
 * 默认值就能复现「首声 ~1 秒、段间无缝」。单测把 `realtime: false` 打开，就不必真的等。
 */
export interface MockTtsStreamTiming {
  /** 首块延迟（毫秒），默认 200。 */
  firstChunkMs?: number
  /** 每块包含的音频时长（毫秒），默认 200。 */
  chunkMs?: number
  /**
   * 流式下发速率（音频秒 / 真实秒）：默认取环境变量 `MOCK_TTS_STREAM_RATE`，没有则 0.9
   * （真星汐实测 0.89–0.91）。1.05 = 比实时快，0.9 = 比实时慢。
   */
  rate?: number
  /**
   * 合成耗时 / 音频时长（旧口径，与 rate 互为倒数）：设置后优先于 rate；
   * 0 = 立即下发（单测用）；1 = 实时，2 = 慢于实时（下载跟不上播放，用来测 underrun）。
   */
  speed?: number
  /** 是否按真实时间等待（单测关掉）；默认 true。 */
  realtime?: boolean
  /** 下发这么多块之后掐断连接（模拟开始下发后的合成失败）；0 = 正常。 */
  interruptAfterChunks?: number
}

/** 默认流式速率（与真星汐同量级）。 */
export const DEFAULT_MOCK_STREAM_RATE = 0.9

/** 速率钳位：防御环境变量/参数填成 0、负数或离谱值。 */
function clampMockStreamRate(rate: number): number {
  return Math.min(1.5, Math.max(0.3, rate))
}

/**
 * 环境变量里的默认流式速率：`MOCK_TTS_STREAM_RATE`（Node / e2e 用）。
 * 浏览器里没有 process，返回 undefined（退回 0.9）；这里不依赖 @types/node。
 */
export function mockStreamRateFromEnv(): number | undefined {
  try {
    const scope = globalThis as { process?: { env?: Record<string, string | undefined> } }
    const raw = scope.process?.env?.['MOCK_TTS_STREAM_RATE']
    if (raw === undefined || raw === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? clampMockStreamRate(value) : undefined
  } catch {
    return undefined
  }
}

/** 解析后的节奏（构造函数里算一次；rate 与 speed 二选一，speed 优先）。 */
interface ResolvedStreamTiming {
  firstChunkMs: number
  chunkMs: number
  rate: number
  /** null = 用 rate 反推每块要等多久。 */
  speed: number | null
  realtime: boolean
  interruptAfterChunks: number
}

function resolveStreamTiming(timing: MockTtsStreamTiming | undefined): ResolvedStreamTiming {
  const rate =
    typeof timing?.rate === 'number' && Number.isFinite(timing.rate)
      ? clampMockStreamRate(timing.rate)
      : (mockStreamRateFromEnv() ?? DEFAULT_MOCK_STREAM_RATE)
  const speed =
    typeof timing?.speed === 'number' && Number.isFinite(timing.speed)
      ? Math.max(0, timing.speed)
      : null
  return {
    firstChunkMs: timing?.firstChunkMs ?? 200,
    chunkMs: timing?.chunkMs ?? 200,
    rate,
    speed,
    realtime: timing?.realtime ?? true,
    interruptAfterChunks: timing?.interruptAfterChunks ?? 0,
  }
}

/** mock 的默认音色（与 Hub 的生产音色同名；id 只在 mock 里有意义）。 */
export const MOCK_TTS_VOICES: TtsVoice[] = [
  { id: 'seki', name: '星汐 seki', description: '温柔清晰的女声，适合朗读长回复' },
]

/**
 * mock 默认的朗读能力：与真 Hub 的形状一致（enabled / voices / defaultVoice / maxChars）。
 * 0.4.6 起默认带 `stream: true`（模拟 WP51 的新 Hub）；`ttsStream: false` 才是老 Hub 形状。
 */
export const MOCK_TTS_CAPABILITY: BootstrapTts = {
  enabled: true,
  voices: MOCK_TTS_VOICES,
  defaultVoice: 'seki',
  maxChars: MOBILE_TTS_CHARS_LIMIT,
  stream: true,
}

export class MockHub implements HubGateway {
  readonly mode = 'mock' as const
  readonly origin = 'mock'
  private readonly tokenStore: TokenStore
  private readonly now: () => number
  private readonly tickMs: number
  private readonly wakeMs: number
  private readonly voice: { asr: boolean; maxSeconds: number } | null
  private readonly asrText: string
  /** bootstrap.voice.tts（0.4.3）；null = 不下发（App 不显示朗读入口）。 */
  private readonly tts: BootstrapTts | null
  private readonly ttsDelayMs: number
  private readonly ttsStream: boolean
  private readonly ttsStreamTiming: ResolvedStreamTiming
  /** 接下来几次 transcribe 直接 502（模拟识别服务没起来；0 = 正常）。 */
  private asrFailures = 0
  /** 接下来几次 synthesize 直接 502（模拟合成服务没起来；0 = 正常）。 */
  private ttsFailures = 0
  /** 被合成的段数（e2e/单测断言「有没有重复请求」用；不记文字）。 */
  private ttsCalls = 0
  private authLostHandlers = new Set<(reason: string) => void>()

  private instanceStatus: 'stopped' | 'starting' | 'running' = 'stopped'
  private capacityFull = false
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private sessions: MockSession[]
  private runtimes = new Map<string, TurnRuntime>()
  private channels = new Set<MockChannelLink>()
  private seqCounter = 100
  private currentUsername = 'demo'
  private archived = new Set<string>()
  private modelSelections = new Map<string, { provider: string; model: string; effort?: string }>()

  constructor(options: MockHubOptions = {}) {
    this.tokenStore = options.tokenStore ?? new MemoryTokenStore()
    this.now = options.now ?? (() => Date.now())
    this.tickMs = options.tickMs ?? MOCK_TICK_MS
    this.wakeMs = options.wakeMs ?? 1_200
    this.voice = options.voice === undefined ? { asr: true, maxSeconds: 60 } : options.voice
    this.asrText = options.asrText ?? '这是一段测试语音'
    this.tts = options.tts === undefined ? MOCK_TTS_CAPABILITY : options.tts
    this.ttsDelayMs = options.ttsDelayMs ?? 0
    this.ttsStream = options.ttsStream ?? true
    this.ttsStreamTiming = resolveStreamTiming(options.ttsStreamTiming)
    const seeded: MockMessage[] = MOCK_HISTORY.map((m) => ({
      seq: m.seq,
      role: m.role,
      at: m.at,
      text: m.text,
      tools: 'tools' in m ? (m.tools as string[]) : [],
    }))
    this.sessions = [
      {
        sessionId: 's_mock_plan',
        title: '今天的计划',
        createdAt: this.now() - 3_600_000,
        updatedAt: this.now() - 60_000,
        messages: seeded,
        running: false,
      },
      {
        sessionId: 's_mock_blank',
        title: null,
        createdAt: this.now() - 600_000,
        updatedAt: this.now() - 600_000,
        messages: [],
        running: false,
      },
      {
        sessionId: 's_mock_archived',
        title: '上个月的复盘',
        createdAt: this.now() - 30 * 86_400_000,
        updatedAt: this.now() - 29 * 86_400_000,
        messages: [
          { seq: 1, role: 'user', at: this.now() - 30 * 86_400_000, text: '帮我复盘上个月' },
          {
            seq: 2,
            role: 'assistant',
            at: this.now() - 30 * 86_400_000 + 1000,
            text: '上个月完成了三件事……',
          },
        ],
        running: false,
      },
    ]
    this.archived = new Set(['s_mock_archived'])
    /** 每个会话当前的模型选择（mock 用 v2 的 model-changed / 投影回显）。 */
    this.modelSelections = new Map()
  }

  // ── 账号 ────────────────────────────────────────────────────────────────

  async login(input: LoginRequest): Promise<AuthTokens> {
    if (input.password !== 'demo1234') {
      throw new HubApiError('INVALID_CREDENTIALS', { status: 401 })
    }
    if (input.username === 'pending') throw new HubApiError('USER_PENDING', { status: 403 })
    if (input.username === 'disabled') throw new HubApiError('USER_DISABLED', { status: 403 })
    if (input.username === 'changepw') throw new HubApiError('MUST_CHANGE_PASSWORD', { status: 403 })
    if (input.username === 'ratelimit') throw new HubApiError('RATE_LIMITED', { status: 429 })
    this.currentUsername = input.username
    const issued = this.now()
    // 令牌必须满足 shared 的格式（`dshm_at_`/`dshm_rt_` + 16 位以上字母数字；deviceId `dv_`+32 hex），
    // 否则 SecureTokenStore 读回时会按契约判为损坏。
    const suffix = Math.random().toString(36).slice(2).padEnd(20, '0')
    const tokens: AuthTokens = {
      accessToken: `dshm_at_${suffix}`,
      accessExpiresAt: new Date(issued + 3_600_000).toISOString(),
      refreshToken: `dshm_rt_${suffix}`,
      refreshExpiresAt: new Date(issued + 60 * 86_400_000).toISOString(),
      deviceId: `dv_${'0'.repeat(32)}`,
      user: { id: 1, username: input.username, displayName: input.username },
    }
    await this.tokenStore.save(tokens)
    return tokens
  }

  async restore(): Promise<AuthTokens | null> {
    return this.tokenStore.load()
  }

  async hasSession(): Promise<boolean> {
    return (await this.tokenStore.load()) !== null
  }

  async consolidateDevices(): Promise<number> {
    // 进程内 mock 没有历史设备台账：永远没有可合并的
    return 0
  }

  async logout(): Promise<void> {
    await this.tokenStore.clear()
    this.disconnectAll('logout')
  }

  /** 测试用：当前实例状态（不暴露内部字段）。 */
  get instanceState(): 'stopped' | 'starting' | 'running' {
    return this.instanceStatus
  }

  /** 测试/e2e 用：模拟网络掉线（4006 不会被当成鉴权失效，客户端会重连）。 */
  simulateDisconnect(code = 1006, reason = 'network-drop'): void {
    for (const channel of [...this.channels]) channel.close(code, reason)
    this.channels.clear()
  }

  /** 测试用：模拟「设备被吊销」，访问下一个接口就回登录页。 */
  async simulateRevoke(): Promise<void> {
    await this.tokenStore.clear()
    this.disconnectAll('revoked')
    for (const handler of [...this.authLostHandlers]) handler('revoked')
  }

  onAuthLost(handler: (reason: string) => void): () => void {
    this.authLostHandlers.add(handler)
    return () => this.authLostHandlers.delete(handler)
  }

  private async requireAuth(): Promise<AuthTokens> {
    const tokens = await this.tokenStore.load()
    if (!tokens) throw new HubApiError('UNAUTHENTICATED', { status: 401 })
    return tokens
  }

  // ── bootstrap / 唤醒 ────────────────────────────────────────────────────

  async bootstrap(): Promise<Bootstrap> {
    const tokens = await this.requireAuth()
    return {
      user: tokens.user,
      points: { balance: 1280.5, enabled: true },
      backends: [
        {
          id: MOBILE_CLOUD_NODE_ID,
          kind: 'cloud',
          name: '云服务器',
          status: this.instanceStatus,
          connectable: this.instanceStatus === 'running',
          ...(this.instanceStatus === 'running' ? {} : { reason: 'instance-not-running' as const }),
          capabilities: CAPABILITIES,
        },
        DESKTOP_NODE,
      ],
      instance: { status: this.instanceStatus, capacityFull: this.capacityFull },
      app: { minVersionCode: 1, latestVersionCode: 10, downloadUrl: null },
      // 老 Hub 不发 voice：`null` 用来模拟「只能用手机系统识别」的下发形状。
      // 0.4.3：voice.tts 与 asr 同级；`tts=null` 时不下发（老 Hub / 管理端没开朗读）。
      // 0.4.6：`ttsStream=false` 时**不带** stream 字段（老 Hub 形状），App 回退整段模式。
      ...(this.voice
        ? {
            voice: {
              ...this.voice,
              ...(this.tts ? { tts: withStreamCapability(this.tts, this.ttsStream) } : {}),
            },
          }
        : {}),
      serverTime: new Date(this.now()).toISOString(),
    }
  }

  /**
   * 服务端语音识别（0.4.2）：mock 只校验 WAV 头与上限，然后回固定文字。
   *
   * 与真实 Hub 的差别只在「谁在识别」；错误码形状一样（400 / 413 / 502），
   * 这样 UI 的失败分支在 mock 里也能跑通。
   */
  async transcribe(wav: Uint8Array, _lang?: string): Promise<AsrResponse> {
    await this.requireAuth()
    if (!isWavBytes(wav)) {
      throw new HubApiError('VALIDATION_FAILED', {
        status: 400,
        detail: 'mock: not a wav',
      })
    }
    if (wav.byteLength > MOBILE_ASR_MAX_BYTES) {
      throw new HubApiError('PAYLOAD_TOO_LARGE', {
        status: 413,
        detail: `mock: ${wav.byteLength} bytes`,
      })
    }
    if (this.asrFailures > 0) {
      this.asrFailures -= 1
      throw new HubApiError('UPSTREAM_ERROR', { status: 502, detail: 'mock: asr unavailable' })
    }
    if (!this.voice?.asr) {
      // Hub 明确关掉了识别（bootstrap.voice.asr=false）：当作上游不可用
      throw new HubApiError('UPSTREAM_ERROR', { status: 502, detail: 'mock: asr disabled' })
    }
    return { text: this.asrText, durationMs: wavDurationMs(wav) }
  }

  /** 只给测试/演示：接下来 `times` 次识别直接失败（502）。 */
  failAsr(times = 1): void {
    this.asrFailures = Math.max(0, times)
  }

  /**
   * 朗读合成（0.4.3 / WP50）：mock 只校验文本/音色，然后按字数生成一段正弦波 WAV。
   *
   * 与真 Hub 的差别只在「谁来合成」；请求形状、响应头、错误码（400 / 429 / 502）一致，
   * 这样播放器的切段、预取、重试与失败降级在 mock 里也能跑通。
   */
  async synthesize(input: { text: string; voice?: string }): Promise<TtsAudio> {
    await this.requireAuth()
    const { text, voice } = this.validateTtsInput(input.text, input.voice)
    if (this.ttsDelayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.ttsDelayMs)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      })
    }
    if (this.ttsFailures > 0) {
      this.ttsFailures -= 1
      throw new HubApiError('UPSTREAM_ERROR', { status: 502, detail: 'mock: tts unavailable' })
    }
    this.ttsCalls += 1
    return {
      wav: encodeTtsWav(text, { sampleRate: TTS_DEFAULT_SAMPLE_RATE }),
      sampleRate: TTS_DEFAULT_SAMPLE_RATE,
      voice,
    }
  }

  /**
   * 流式朗读（0.4.6 / WP51）：与 `/tts/stream` 同形——先校验（400 / 502 直接抛），
   * 再按实时速率分块交出**裸 PCM16**（无 WAV 头）。
   *
   * 节奏由 `ttsStreamTiming` 控制：首块延迟、每块音频时长、合成速度（>1 = 慢于实时）、
   * 第 N 块后掐断（模拟「开始下发后失败」）。`signal` 取消时抛 `cancelled`。
   */
  async synthesizeStream(input: {
    text: string
    voice?: string
    signal?: AbortSignal
  }): Promise<TtsStream> {
    await this.requireAuth()
    const { text, voice } = this.validateTtsInput(input.text, input.voice)
    if (!this.ttsStream) {
      throw new HubApiError('UPSTREAM_ERROR', { status: 502, detail: 'mock: tts stream disabled' })
    }
    if (this.ttsFailures > 0) {
      this.ttsFailures -= 1
      throw new HubApiError('UPSTREAM_ERROR', { status: 502, detail: 'mock: tts unavailable' })
    }
    this.ttsCalls += 1
    const timing = this.ttsStreamTiming
    const sampleRate = TTS_DEFAULT_SAMPLE_RATE
    const pcm = encodeTtsPcm(text, { sampleRate })
    const chunkBytes = Math.max(2, Math.round((sampleRate * timing.chunkMs) / 1_000) * 2)
    const signal = input.signal
    const firstChunkMs = timing.firstChunkMs
    const chunkMs = timing.chunkMs
    /** 每块之间等多久：speed（合成耗时/音频时长）优先，否则按 rate 反推。 */
    const chunkWaitMs = timing.speed === null ? chunkMs / timing.rate : chunkMs * timing.speed
    const realtime = timing.realtime
    const interruptAfter = timing.interruptAfterChunks

    const chunks = async function* (): AsyncGenerator<Uint8Array, void, void> {
      const checkAbort = (): void => {
        if (signal?.aborted) {
          throw new HubApiError('cancelled', { status: 0, detail: 'mock: stream aborted' })
        }
      }
      await mockSleep(firstChunkMs, signal)
      checkAbort()
      // 绝对时间排程：setTimeout 的几毫秒开销不逐块累积，实测速率才等于配置的 rate
      const startedAt = Date.now()
      let offset = 0
      let index = 0
      while (offset < pcm.byteLength) {
        if (interruptAfter > 0 && index >= interruptAfter) {
          // 开始下发之后失败：真 Hub 直接掐断连接，App 读到的是「流中断」
          throw new HubApiError('stream-interrupted', {
            status: 502,
            detail: 'mock: stream interrupted',
          })
        }
        const end = Math.min(pcm.byteLength, offset + chunkBytes)
        const piece = pcm.subarray(offset, end)
        offset = end
        index += 1
        yield piece
        if (offset >= pcm.byteLength) return
        if (realtime) {
          const due = startedAt + firstChunkMs + index * chunkWaitMs
          await mockSleep(Math.max(0, due - Date.now()), signal)
        }
        checkAbort()
      }
    }

    return { sampleRate, voice, cached: false, chunks: chunks() }
  }

  /** `/tts` 与 `/tts/stream` 共用的请求校验（400 / 502 的错误码与真 Hub 一致）。 */
  private validateTtsInput(rawText: string, rawVoice?: string): { text: string; voice: string } {
    const text = rawText.trim()
    const tts = this.tts
    if (!tts || !tts.enabled) {
      throw new HubApiError('UPSTREAM_ERROR', { status: 502, detail: 'mock: tts disabled' })
    }
    if (text.length === 0 || text.length > tts.maxChars) {
      throw new HubApiError('VALIDATION_FAILED', {
        status: 400,
        detail: `mock: text length ${text.length}`,
      })
    }
    const voice = rawVoice ?? tts.defaultVoice ?? tts.voices[0]?.id ?? ''
    if (voice !== '' && !tts.voices.some((item) => item.id === voice)) {
      throw new HubApiError('VALIDATION_FAILED', { status: 400, detail: `mock: voice ${voice}` })
    }
    return { text, voice }
  }

  /** 只给测试/演示：接下来 `times` 次合成直接失败（502）。 */
  failTts(times = 1): void {
    this.ttsFailures = Math.max(0, times)
  }

  /** 合成过的段数（测试用；不记录文字）。 */
  get synthesizedSegments(): number {
    return this.ttsCalls
  }

  async wake(): Promise<WakeResponse> {
    await this.requireAuth()
    if (this.instanceStatus === 'running') return { status: 'running' }
    if (this.capacityFull) throw new HubApiError('CAPACITY_FULL', { status: 409 })
    if (this.instanceStatus === 'stopped') {
      this.instanceStatus = 'starting'
      if (this.wakeTimer) clearTimeout(this.wakeTimer)
      this.wakeTimer = setTimeout(() => {
        this.instanceStatus = 'running'
        this.wakeTimer = null
      }, this.wakeMs)
      ;(this.wakeTimer as unknown as { unref?: () => void }).unref?.()
    }
    return { status: this.instanceStatus }
  }

  // ── 通道 ────────────────────────────────────────────────────────────────

  async openChannel(nodeId: string): Promise<ChannelLink> {
    await this.requireAuth()
    if (nodeId !== MOBILE_CLOUD_NODE_ID) {
      throw new HubApiError('node-not-connectable', { status: 409 })
    }
    if (this.instanceStatus !== 'running') {
      throw new HubApiError('instance-not-running', { status: 409 })
    }
    const channel = new MockChannelLink(this)
    this.channels.add(channel)
    return channel
  }

  private disconnectAll(reason: string): void {
    for (const channel of [...this.channels]) channel.close(4003, reason)
    this.channels.clear()
  }

  // ── 内部：会话/流式 ─────────────────────────────────────────────────────

  sessionRows(includeArchived = false) {
    return [...this.sessions]
      .filter((s) => includeArchived || !this.archived.has(s.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
        running: s.running,
        blank: s.messages.length === 0,
        agentAvailable: true,
        ...(includeArchived ? { archived: this.archived.has(s.sessionId) } : {}),
      }))
  }

  /** mock 的模型目录：形状与真实 `session/modelCatalog` → Hub 摊平后的 `models` 帧一致。 */
  modelsPayload(selection?: { provider: string; model: string; effort?: string } | null) {
    const items = MOCK_MODEL_CATALOG.groups.flatMap((group) =>
      group.models.map((model) => ({
        provider: group.id,
        model: model.id,
        name: model.name,
        description: model.description ?? null,
        efforts: (model.reasoning?.efforts ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          ...(e.description ? { description: e.description } : {}),
          // shared 的 MobileModelEffort.tier 必填：App 不靠它判断（按 id 算），但契约要全。
          tier:
            e.id === 'off'
              ? ('low' as const)
              : e.id === 'low'
                ? ('medium' as const)
                : e.id === 'high'
                  ? ('high' as const)
                  : e.id === 'max'
                    ? ('ultra' as const)
                    : null,
        })),
        defaultEffort: model.reasoning?.efforts?.length ? (model.reasoning.defaultEffort ?? null) : null,
        input: { text: true as const, image: null },
      })),
    )
    const fallback = {
      provider: MOCK_MODEL_CATALOG.default.provider,
      model: MOCK_MODEL_CATALOG.default.model,
      ...(MOCK_MODEL_CATALOG.default.reasoningEffort
        ? { effort: MOCK_MODEL_CATALOG.default.reasoningEffort }
        : {}),
    }
    return {
      items,
      default: fallback,
      // shared 的 models 帧把 failures 定为必填（拿不到模型的 provider 列表，可为空）。
      failures: [],
      ...(selection ? { current: selection } : {}),
    }
  }

  historyPage(sessionId: string, beforeSeq: number | null, limit: number): {
    items: MockMessage[]
    nextBeforeSeq: number | null
    cursor: number
    hasMore: boolean
  } {
    const session = this.sessions.find((s) => s.sessionId === sessionId)
    if (!session) return { items: [], nextBeforeSeq: null, cursor: 0, hasMore: false }
    const upto = beforeSeq == null ? Number.MAX_SAFE_INTEGER : beforeSeq
    const filtered = session.messages.filter((m) => m.seq < upto)
    const page = filtered.slice(Math.max(0, filtered.length - limit))
    const hasMore = filtered.length > page.length
    return {
      items: page,
      nextBeforeSeq: hasMore && page.length > 0 ? page[0]!.seq : null,
      cursor: session.messages.length > 0 ? session.messages[session.messages.length - 1]!.seq : 0,
      hasMore,
    }
  }

  createSession(): MockSession {
    const session: MockSession = {
      sessionId: `s_mock_${Math.random().toString(36).slice(2, 8)}`,
      title: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      messages: [],
      running: false,
    }
    this.sessions.unshift(session)
    return session
  }

  appendMessage(sessionId: string, input: Omit<MockMessage, 'seq'>): MockMessage {
    const session = this.sessions.find((s) => s.sessionId === sessionId)
    if (!session) throw new HubApiError('session-not-found')
    const message: MockMessage = { ...input, seq: ++this.seqCounter }
    session.messages.push(message)
    session.updatedAt = this.now()
    if (input.role === 'user' && !session.title) {
      session.title = input.text.slice(0, 24)
    }
    return message
  }

  startTurn(sessionId: string, channel: MockChannelLink): void {
    const session = this.sessions.find((s) => s.sessionId === sessionId)
    if (!session) return
    // 同一会话已有回合：先结束旧的（mock 不做队列，保持确定性）
    const existing = this.runtimes.get(sessionId)
    if (existing) this.finishTurn(existing, 'cancelled')
    const runtime: TurnRuntime = {
      sessionId,
      attemptId: `att_mock_${Math.random().toString(36).slice(2, 8)}`,
      revision: 1,
      target: MOCK_REPLY,
      delivered: 0,
      timer: null,
      listeners: new Set([channel]),
      stopped: false,
    }
    this.runtimes.set(sessionId, runtime)
    session.running = true
    this.broadcastSessionState(sessionId)
    runtime.timer = setInterval(() => this.tick(runtime), this.tickMs)
    ;(runtime.timer as unknown as { unref?: () => void }).unref?.()
  }

  private tick(runtime: TurnRuntime): void {
    if (runtime.stopped) return
    if (runtime.delivered >= runtime.target.length) {
      this.finishTurn(runtime, 'completed')
      return
    }
    const char = runtime.target[runtime.delivered]!
    const index = runtime.delivered
    runtime.delivered += 1
    runtime.revision = Math.max(runtime.revision, 1)
    for (const channel of runtime.listeners) {
      channel.deliver({
        v: 1,
        type: 'delta',
        sessionId: runtime.sessionId,
        attemptId: runtime.attemptId,
        revision: runtime.revision,
        index,
        turn: 1,
        step: 1,
        part: { kind: 'text', text: char },
      })
    }
  }

  /**
   * 会话快照（WP46 / M6 §2.1）：进程内 mock 不模拟未决提问/审批，
   * 只把**回合态**（running / attemptId）给一份权威快照。
   */
  sessionStateFrame(sessionId: string, requestId?: string): MobileServerFrameV2 {
    const runtime = this.runtimes.get(sessionId)
    const session = this.sessions.find((item) => item.sessionId === sessionId)
    const last = session && session.messages.length > 0 ? session.messages[session.messages.length - 1] : null
    return {
      v: 1,
      type: 'session-state',
      ...(requestId ? { requestId } : {}),
      sessionId,
      cursor: last ? last.seq : null,
      running: !!runtime,
      attemptId: runtime ? runtime.attemptId : null,
      questions: [],
      approvals: [],
      at: new Date(this.now()).toISOString(),
    } as unknown as MobileServerFrameV2
  }

  /** 回合开始/结束时把快照推给订阅了该会话的通道（M6 §2.2.2）。 */
  private broadcastSessionState(sessionId: string): void {
    for (const channel of this.channels) {
      if (!channel.sessionState) continue
      if (!channel.hasSubscription(sessionId)) continue
      channel.deliver(this.sessionStateFrame(sessionId))
    }
  }

  hasRuntime(sessionId: string): boolean {
    return this.runtimes.has(sessionId)
  }

  stopTurn(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return false
    runtime.stopped = true
    // finishTurn 会给所有订阅者发 assistant message + turn end（reason=cancelled）
    this.finishTurn(runtime, 'cancelled')
    return true
  }

  private finishTurn(runtime: TurnRuntime, reason: 'completed' | 'cancelled'): void {
    if (runtime.timer) clearInterval(runtime.timer)
    runtime.timer = null
    this.runtimes.delete(runtime.sessionId)
    const session = this.sessions.find((s) => s.sessionId === runtime.sessionId)
    if (session) {
      session.running = false
      const text = runtime.target.slice(0, runtime.delivered)
      if (text.trim()) {
        const message = this.appendMessage(runtime.sessionId, {
          role: 'assistant',
          at: this.now(),
          text,
        })
        for (const channel of runtime.listeners) {
          channel.deliver({
            v: 1,
            type: 'message',
            sessionId: runtime.sessionId,
            seq: message.seq,
            role: 'assistant',
            at: message.at,
            text: message.text,
          })
        }
      }
      session.updatedAt = this.now()
    }
    for (const channel of runtime.listeners) {
      channel.deliver({
        v: 1,
        type: 'turn',
        sessionId: runtime.sessionId,
        phase: 'end',
        turn: 1,
        reason,
      })
    }
    this.broadcastSessionState(runtime.sessionId)
    runtime.listeners.clear()
  }

  /** 订阅时把「进行中的输出」用 assistant-baseline 交给新通道（M4 v1.5）。 */
  attachToRuntime(sessionId: string, channel: MockChannelLink): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    runtime.listeners.add(channel)
    channel.deliver({
      v: 1,
      type: 'assistant-baseline',
      sessionId,
      attemptId: runtime.attemptId,
      revision: runtime.revision,
      nextIndex: runtime.delivered,
      text: runtime.target.slice(0, runtime.delivered),
    })
  }

  detachChannel(channel: MockChannelLink): void {
    this.channels.delete(channel)
    for (const runtime of this.runtimes.values()) runtime.listeners.delete(channel)
  }

  // ── 内部：请求分发（由 MockChannelLink 调用） ───────────────────────────

  handleFrame(channel: MockChannelLink, frame: MobileClientFrame | MobileClientFrameV2): void {
    switch (frame.type) {
      case 'hello': {
        const declared = (frame as { features?: string[] }).features
        const features = declared
          ? declared.filter((feature) => SUPPORTED_FEATURES.includes(feature))
          : undefined
        channel.sessionState = (features ?? []).includes('session-state')
        channel.deliver({
          v: 1,
          type: 'hello',
          requestId: frame.requestId,
          node: {
            id: MOBILE_CLOUD_NODE_ID,
            kind: 'cloud',
            name: '云服务器',
            status: this.instanceStatus,
          },
          capabilities: CAPABILITIES,
          subscribed: channel.subscriptions(),
          serverTime: this.now(),
          ...(features && features.length > 0 ? { features } : {}),
        })
        return
      }
      case 'models': {
        const sessionId = (frame as { sessionId?: string }).sessionId
        const selection = sessionId ? this.modelSelections.get(sessionId) ?? null : null
        channel.deliver({
          v: 1,
          type: 'models',
          requestId: frame.requestId,
          ...this.modelsPayload(selection),
        })
        return
      }
      case 'set-model': {
        const modelFrame = frame as {
          sessionId: string
          provider: string
          model: string
          effort?: string
        }
        const selection = {
          provider: modelFrame.provider,
          model: modelFrame.model,
          ...(modelFrame.effort ? { effort: modelFrame.effort } : {}),
        }
        this.modelSelections.set(modelFrame.sessionId, selection)
        channel.deliver({
          v: 1,
          type: 'model-changed',
          requestId: frame.requestId,
          sessionId: modelFrame.sessionId,
          ...selection,
        })
        channel.deliver({
          v: 1,
          type: 'state',
          sessionId: modelFrame.sessionId,
          key: 'modelSelection',
          value: {
            lastUsed: { ...selection, reasoningEffort: selection.effort ?? 'high' },
            next: { ...selection, reasoningEffort: selection.effort ?? 'high' },
          },
          seq: null,
        })
        return
      }
      case 'usage': {
        // 会话用量：按 mock 里已有的消息确定性算一份，供会话信息面板/e2e 验收。
        const usageFrame = frame as { sessionId: string }
        const session = this.sessions.find((item) => item.sessionId === usageFrame.sessionId)
        const assistant = session ? session.messages.filter((m) => m.role === 'assistant') : []
        const user = session ? session.messages.filter((m) => m.role === 'user') : []
        const outputChars = assistant.reduce((sum, message) => sum + message.text.length, 0)
        const outputTokens = Math.round(outputChars / 2.2)
        const inputTokens = assistant.length * 1200 + user.length * 40
        const cacheReadTokens = assistant.length * 800
        channel.deliver({
          v: 1,
          type: 'usage',
          requestId: frame.requestId,
          sessionId: usageFrame.sessionId,
          stats: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens + cacheReadTokens,
            cacheReadTokens,
            assistantMessages: assistant.length,
            userMessages: user.length,
            turns: assistant.length,
            truncated: false,
          },
        })
        return
      }
      case 'session-state-request': {
        if (!channel.sessionState) {
          channel.deliver({
            v: 1,
            type: 'error',
            requestId: frame.requestId,
            code: 'feature-unsupported',
            message: '当前后端不支持会话快照',
            retryable: false,
          })
          return
        }
        channel.deliver(this.sessionStateFrame(frame.sessionId, frame.requestId))
        return
      }
      case 'sessions': {
        const includeArchived = (frame as { includeArchived?: boolean }).includeArchived === true
        channel.deliver({
          v: 1,
          type: 'sessions',
          requestId: frame.requestId,
          items: this.sessionRows(includeArchived),
        })
        return
      }
      case 'history': {
        const page = this.historyPage(frame.sessionId, frame.beforeSeq ?? null, frame.limit ?? 30)
        channel.deliver({
          v: 1,
          type: 'history',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          items: page.items,
          nextBeforeSeq: page.nextBeforeSeq,
          cursor: page.cursor,
          hasMore: page.hasMore,
        })
        return
      }
      case 'create': {
        const session = this.createSession()
        const createFrame = frame as {
          preset?: string
          provider?: string
          model?: string
          effort?: string
        }
        const selection =
          createFrame.provider && createFrame.model
            ? {
                provider: createFrame.provider,
                model: createFrame.model,
                ...(createFrame.effort ? { effort: createFrame.effort } : {}),
              }
            : null
        if (selection) this.modelSelections.set(session.sessionId, selection)
        channel.deliver({
          v: 1,
          type: 'created',
          requestId: frame.requestId,
          sessionId: session.sessionId,
          ...(createFrame.preset ? { preset: createFrame.preset } : {}),
          ...(selection ? { model: selection } : {}),
        })
        return
      }
      case 'subscribe': {
        channel.addSubscription(frame.sessionId)
        const page = this.historyPage(frame.sessionId, null, 30)
        channel.deliver({
          v: 1,
          type: 'history',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          items: page.items,
          nextBeforeSeq: page.nextBeforeSeq,
          cursor: page.cursor,
          hasMore: page.hasMore,
        })
        channel.deliver({
          v: 1,
          type: 'replay',
          sessionId: frame.sessionId,
          fromCursor: frame.sinceCursor ?? null,
          toCursor: page.cursor,
        })
        this.attachToRuntime(frame.sessionId, channel)
        // WP46 / M6 §2.2.1：订阅成功后发一份权威快照（回合态 + 未决交互）。
        if (channel.sessionState) channel.deliver(this.sessionStateFrame(frame.sessionId))
        return
      }
      case 'unsubscribe':
        channel.removeSubscription(frame.sessionId)
        return
      case 'send': {
        const session = this.sessions.find((s) => s.sessionId === frame.sessionId)
        if (!session) {
          channel.deliver({
            v: 1,
            type: 'error',
            requestId: frame.requestId,
            code: 'session-not-found',
            message: '会话不存在',
            retryable: false,
          })
          return
        }
        const duplicate = session.messages.some((m) => m.clientMessageId === frame.clientMessageId)
        if (duplicate) {
          // 幂等：不重复执行，只重放 ack。
          channel.deliver({
            v: 1,
            type: 'ack',
            requestId: frame.requestId,
            clientMessageId: frame.clientMessageId,
          })
          return
        }
        const userMessage = this.appendMessage(frame.sessionId, {
          role: 'user',
          at: this.now(),
          text: frame.text,
          clientMessageId: frame.clientMessageId,
        })
        channel.deliver({
          v: 1,
          type: 'ack',
          requestId: frame.requestId,
          clientMessageId: frame.clientMessageId,
        })
        channel.deliver({
          v: 1,
          type: 'message',
          sessionId: frame.sessionId,
          seq: userMessage.seq,
          role: 'user',
          at: userMessage.at,
          text: userMessage.text,
          clientMessageId: frame.clientMessageId,
        })
        channel.deliver({
          v: 1,
          type: 'turn',
          sessionId: frame.sessionId,
          phase: 'start',
          turn: 1,
        })
        this.startTurn(frame.sessionId, channel)
        return
      }
      case 'stop': {
        // 现实里 stopped 是 unary 的应答，先于 turn/end 到达；mock 也照这个顺序发。
        const accepted = this.hasRuntime(frame.sessionId)
        channel.deliver({
          v: 1,
          type: 'stopped',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          accepted,
        })
        if (accepted) this.stopTurn(frame.sessionId)
        return
      }
      case 'ping':
        channel.deliver({ v: 1, type: 'pong', t: frame.t })
        return
      case 'answer-question':
        channel.deliver({
          v: 1,
          type: 'answer-result',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          accepted: true,
          continued: false,
        })
        return
      case 'answer-approval':
        channel.deliver({
          v: 1,
          type: 'error',
          requestId: frame.requestId,
          code: 'approval-not-answerable',
          message: 'mock 不支持审批应答',
          retryable: false,
        })
        return
      default:
        return
    }
  }
}

/** 一条进程内通道：把服务端帧经 microtask 推给客户端（不同步重入状态机）。 */
class MockChannelLink implements ChannelLink {
  private handlers = new Set<(event: ChannelLinkEvent) => void>()
  private stateValue: 'connecting' | 'open' | 'closed' = 'connecting'
  private subs = new Set<string>()
  /** hello 是否协商到 `session-state`（没协商就不发快照，与真 Hub 行为一致）。 */
  sessionState = false

  constructor(private readonly hub: MockHub) {
    // 必须晚于 WorkspaceController 注册 onEvent 的那一拍：
    // openChannel() 是 async，controller 在 .then 里才挂监听。这里用宏任务（不是 microtask）
    // 保证「打开事件」不会在监听器注册之前被丢掉。
    setTimeout(() => {
      if (this.stateValue !== 'connecting') return
      this.stateValue = 'open'
      this.emit({ type: 'open' })
    }, 0)
  }

  get state(): 'connecting' | 'open' | 'closed' {
    return this.stateValue
  }

  send(text: string): boolean {
    if (this.stateValue !== 'open') return false
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return false
    }
    const validated = validateClientFrame(frame)
    if (!validated) return false
    queueMicrotask(() => {
      if (this.stateValue !== 'open') return
      this.hub.handleFrame(this, validated)
    })
    return true
  }

  close(code = 1000, reason = 'client-bye'): void {
    if (this.stateValue === 'closed') return
    this.stateValue = 'closed'
    this.hub.detachChannel(this)
    this.emit({ type: 'close', code, reason })
  }

  onEvent(handler: (event: ChannelLinkEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  deliver(frame: MobileServerFrame | MobileServerFrameV2): void {
    if (this.stateValue !== 'open') return
    const data = JSON.stringify(frame)
    queueMicrotask(() => {
      if (this.stateValue !== 'open') return
      this.emit({ type: 'text', data })
    })
  }

  addSubscription(sessionId: string): void {
    this.subs.add(sessionId)
  }
  removeSubscription(sessionId: string): void {
    this.subs.delete(sessionId)
  }
  subscriptions(): string[] {
    return [...this.subs]
  }
  hasSubscription(sessionId: string): boolean {
    return this.subs.has(sessionId)
  }

  private emit(event: ChannelLinkEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event)
      } catch {
        /* ignore */
      }
    }
  }
}

function validateClientFrame(frame: unknown): MobileClientFrame | MobileClientFrameV2 | null {
  return decodeClientFrame(frame)
}
