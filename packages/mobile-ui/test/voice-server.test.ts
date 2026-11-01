/**
 * 0.4.2 引擎选择与服务端识别：矩阵、录音 → 上传 → 插字、失败回退、取消、倒计时、诊断。
 *
 * 录音器与上传都是注入的假实现（FakeRecorder / transcribe），时间用假定时器；
 * 真麦克风 + 真 HTTP 的路径由 scripts/e2e-voice.mjs 覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOLD_MS,
  MIN_SERVER_SECONDS,
  SERVER_LANGUAGE,
  VOICE_TEXT,
  VoiceInput,
  asrErrorCode,
  describeAsrError,
  isServerFallbackCode,
  resolveVoiceEngine,
  type VoiceEngine,
  type VoiceEngineContext,
  type VoiceNotice,
  type VoiceSnapshot,
} from '@/lib/voice-input'
import { HubApiError } from '@dsh-hub/mobile-core'
import { encodeWav, type VoiceRecorderCreateOptions, type VoiceRecorderLike } from '@/lib/voice-recorder'
import type {
  SpeechAvailability,
  SpeechBridge,
  SpeechEventName,
  SpeechPayloadMap,
  SpeechStopResult,
  SpeechSubscription,
} from '@/lib/speech-native'

/* ---------- 假件 ---------- */

class FakeBridge implements SpeechBridge {
  info: SpeechAvailability = { available: true, onDevice: false, reason: 'system' }
  starts = 0
  stops = 0
  cancels = 0
  availability = async (): Promise<SpeechAvailability> => this.info
  start = async (): Promise<void> => {
    this.starts += 1
  }
  stop = async (): Promise<SpeechStopResult> => {
    this.stops += 1
    return { listening: true }
  }
  cancel = async (): Promise<void> => {
    this.cancels += 1
  }
  openSettings = async (): Promise<void> => {}
  on<E extends SpeechEventName>(
    _event: E,
    _handler: (payload: SpeechPayloadMap[E]) => void,
  ): SpeechSubscription {
    return { remove: () => {} }
  }
}

/** 假录音器：可手动推音量、倒计时、上限；stop 返回一段固定长度的 WAV。 */
class FakeRecorder implements VoiceRecorderLike {
  readonly options: VoiceRecorderCreateOptions
  started = false
  cancelled = false
  stopped = 0
  active = false
  /** stop 时返回的样本数（16k）；默认 1.5 秒。 */
  samples = 24_000
  startError: unknown = null
  startResolve: (() => void) | null = null
  /** true = start() 挂起，等测试手动放行（模拟「开麦慢」）。 */
  holdStart = false
  level: (level: number) => void
  countdown: (left: number) => void
  limit: () => void

  constructor(options: VoiceRecorderCreateOptions) {
    this.options = options
    this.level = options.onLevel ?? (() => {})
    this.countdown = options.onCountdown ?? (() => {})
    this.limit = options.onLimit ?? (() => {})
  }

  start = async (): Promise<void> => {
    if (this.startError) throw this.startError
    if (this.holdStart) await new Promise<void>((resolve) => (this.startResolve = resolve))
    this.started = true
    this.active = true
  }

  stop = async () => {
    this.stopped += 1
    this.active = false
    const pcm = new Int16Array(this.samples)
    return {
      wav: encodeWav(pcm),
      durationMs: Math.round((this.samples / 16_000) * 1_000),
      sampleRate: 16_000,
      samples: this.samples,
    }
  }

  cancel = (): void => {
    this.cancelled = true
    this.active = false
  }

  release(): void {
    this.startResolve?.()
  }
}

interface Harness {
  voice: VoiceInput
  notices: VoiceNotice[]
  texts: string[]
  snapshots: VoiceSnapshot[]
  diag: Array<[string, string]>
  recorders: FakeRecorder[]
  transcribe: ReturnType<typeof vi.fn>
  bridge: FakeBridge | null
}

function makeHarness(
  options: {
    bridge?: FakeBridge | null
    engine?: () => VoiceEngineContext
    transcribeImpl?: () => Promise<{ text?: string }>
    nativeAvailable?: boolean
    recorderSetup?: (recorder: FakeRecorder) => void
  } = {},
): Harness {
  const notices: VoiceNotice[] = []
  const texts: string[] = []
  const snapshots: VoiceSnapshot[] = []
  const diag: Array<[string, string]> = []
  const recorders: FakeRecorder[] = []
  const bridge = options.bridge === undefined ? null : options.bridge
  const transcribe = vi.fn(options.transcribeImpl ?? (async () => ({ text: '这是一段测试语音' })))
  const voice = new VoiceInput({
    bridge,
    checkAvailability: async () =>
      options.nativeAvailable === false
        ? { available: false, onDevice: false, reason: 'none' }
        : (bridge?.info ?? null),
    engine: options.engine ?? (() => ({ preference: 'auto', serverEnabled: true })),
    transcribe: (wav, lang) => transcribe(wav, lang),
    maxSeconds: () => 60,
    createRecorder: (recorderOptions) => {
      const recorder = new FakeRecorder(recorderOptions)
      options.recorderSetup?.(recorder)
      recorders.push(recorder)
      return recorder
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onNotice: (notice) => notices.push(notice),
    onText: (text) => texts.push(text),
    onDiag: (name, detail) => diag.push([name, detail ?? '']),
  })
  return { voice, notices, texts, snapshots, diag, recorders, transcribe, bridge }
}

/** 按住 → 过阈值 → 松手（服务端引擎在松手后上传）。 */
async function holdAndRelease(h: Harness, holdMs = 1_200): Promise<void> {
  await h.voice.pointerDown(10, 500)
  await vi.advanceTimersByTimeAsync(HOLD_MS)
  await vi.advanceTimersByTimeAsync(holdMs)
  await h.voice.pointerUp()
  await vi.advanceTimersByTimeAsync(0)
}

/* ---------- 引擎矩阵 ---------- */

describe('resolveVoiceEngine：自动 / 服务器 / 手机系统', () => {
  const cases: Array<{
    name: string
    inputs: Parameters<typeof resolveVoiceEngine>[0]
    expected: VoiceEngine | null
  }> = [
    { name: 'auto + 服务端可用 → server', inputs: { preference: 'auto', serverEnabled: true, nativeUsable: true }, expected: 'server' },
    { name: 'auto + 服务端没开 → native', inputs: { preference: 'auto', serverEnabled: false, nativeUsable: true }, expected: 'native' },
    { name: 'auto + 服务端失败过 → native', inputs: { preference: 'auto', serverEnabled: true, nativeUsable: true, serverFailed: true }, expected: 'native' },
    { name: 'auto + 服务端失败且系统不可用 → server（重试）', inputs: { preference: 'auto', serverEnabled: true, nativeUsable: false, serverFailed: true }, expected: 'server' },
    { name: 'auto + 两者都不可用 → null', inputs: { preference: 'auto', serverEnabled: false, nativeUsable: false }, expected: null },
    { name: '手动 server + 可用 → server', inputs: { preference: 'server', serverEnabled: true, nativeUsable: true }, expected: 'server' },
    { name: '手动 server + 不可用 → null（不偷偷改用系统识别）', inputs: { preference: 'server', serverEnabled: false, nativeUsable: true }, expected: null },
    { name: '手动 server + 都不可用 → null', inputs: { preference: 'server', serverEnabled: false, nativeUsable: false }, expected: null },
    { name: '手动 native + 可用 → native', inputs: { preference: 'native', serverEnabled: true, nativeUsable: true }, expected: 'native' },
    { name: '手动 native + 不可用 → null（不偷偷上传服务器）', inputs: { preference: 'native', serverEnabled: true, nativeUsable: false }, expected: null },
    { name: '手动 native + 都不可用 → null', inputs: { preference: 'native', serverEnabled: false, nativeUsable: false }, expected: null },
    { name: '手动 native + 服务端失败过 → 还是 native', inputs: { preference: 'native', serverEnabled: true, nativeUsable: true, serverFailed: true }, expected: 'native' },
  ]
  for (const item of cases) {
    it(item.name, () => {
      expect(resolveVoiceEngine(item.inputs)).toBe(item.expected)
    })
  }
})

/* ---------- 服务端引擎 ---------- */

describe('服务端引擎：录音 → 上传 → 插字', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('按住 1.2 秒松手：上传 16k WAV，浮层先「正在听」再「正在识别」，文字进输入框', async () => {
    const h = makeHarness()
    await h.voice.pointerDown(10, 500)
    // <200ms 松手不录音（0.4.1 的既有交互不走样）
    expect(h.snapshots.at(-1)?.phase).toBe('pending')
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(h.snapshots.at(-1)?.phase).toBe('recording')
    expect(h.recorders).toHaveLength(1)
    expect(h.recorders[0]!.started).toBe(true)
    // 服务端引擎录音中：浮层没有实时文字
    expect(h.snapshots.at(-1)?.text).toBe('')
    expect(h.snapshots.at(-1)?.engine).toBe('server')
    expect(h.bridge?.starts ?? 0).toBe(0)

    // 音量与倒计时推进到浮层
    h.recorders[0]!.level(0.42)
    h.recorders[0]!.countdown(9)
    expect(h.snapshots.at(-1)?.level).toBeCloseTo(0.42)
    expect(h.snapshots.at(-1)?.countdown).toBe(9)

    await vi.advanceTimersByTimeAsync(1_000)
    const releasing = h.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(0)
    // 松手后要先经过「正在识别…」这一帧（假上传是同步完成的，所以看历史快照）
    expect(h.snapshots.some((snapshot) => snapshot.phase === 'finalizing')).toBe(true)
    await releasing

    expect(h.transcribe).toHaveBeenCalledTimes(1)
    const [wav, lang] = h.transcribe.mock.calls[0] as [Uint8Array, string]
    expect(lang).toBe(SERVER_LANGUAGE)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(h.texts).toEqual(['这是一段测试语音'])
    expect(h.snapshots.at(-1)?.phase).toBe('idle')
    expect(h.notices).toHaveLength(0)
  })

  it('诊断只记引擎 / 字节数 / 耗时 / 码，不记识别文字', async () => {
    const h = makeHarness()
    await holdAndRelease(h)
    const engine = h.diag.find(([name]) => name === 'speech:engine')
    expect(engine?.[1]).toBe('server · auto')
    const upload = h.diag.find(([name]) => name === 'speech:upload')
    expect(upload?.[1]).toMatch(/^bytes=\d+ ms=\d+ code=ok$/)
    const insert = h.diag.find(([name]) => name === 'speech:insert')
    expect(insert?.[1]).toBe('8 字')
    // 任何一条诊断都不得包含识别出来的文字
    for (const [, detail] of h.diag) {
      expect(detail).not.toContain('这是一段测试语音')
    }
  })

  it('录音太短（< 0.3 秒）不上传，提示「没听清」', async () => {
    const h = makeHarness()
    await h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    h.recorders[0]!.samples = 1_600 // 0.1 秒
    const releasing = h.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(0)
    await releasing
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.notices).toEqual([{ kind: 'empty', text: VOICE_TEXT.empty }])
    expect(MIN_SERVER_SECONDS).toBe(0.3)
  })

  it('上滑取消：释放录音器、不上传、不插字', async () => {
    const h = makeHarness()
    await h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    h.voice.pointerMove(500 - 90)
    expect(h.snapshots.at(-1)?.cancelling).toBe(true)
    const releasing = h.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(0)
    await releasing
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.recorders[0]!.cancelled).toBe(true)
    expect(h.texts).toEqual([])
    expect(h.notices.at(-1)?.kind).toBe('cancelled')
  })

  it('切后台（cancel）：录音器被取消，上传不会发生', async () => {
    const h = makeHarness()
    await h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    h.voice.cancel()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.recorders[0]!.cancelled).toBe(true)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.snapshots.at(-1)?.phase).toBe('idle')
  })

  it('到上限自动结束：不需要松手也会上传并插字', async () => {
    const h = makeHarness()
    await h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    const recorder = h.recorders[0]!
    recorder.limit() // 录音器到点回调
    await vi.advanceTimersByTimeAsync(0)
    expect(h.snapshots.some((snapshot) => snapshot.phase === 'finalizing')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    expect(h.texts).toEqual(['这是一段测试语音'])
    // 到点后再松手不会重复上传
    const releasing = h.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(0)
    await releasing
    expect(h.transcribe).toHaveBeenCalledTimes(1)
  })

  it('开麦慢：松手发生在 start 完成前，也只会收尾一次且不重复上传', async () => {
    const h = makeHarness()
    await h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    const recorder = h.recorders[0]!
    // 第一次 start 已返回；这里模拟「第二段」不需要，直接验证 start 尚未完成的路径
    expect(recorder.started).toBe(true)
    recorder.holdStart = false
    recorder.release()
    const releasing = h.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(0)
    await releasing
    expect(h.transcribe).toHaveBeenCalledTimes(1)
  })

  it('权限被拒（录音器抛 permission-denied）：弹窗 +「去设置」，不上传', async () => {
    const h = makeHarness({
      recorderSetup: (recorder) => {
        recorder.startError = Object.assign(new Error('denied'), { code: 'permission-denied' })
      },
    })
    await h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.transcribe).not.toHaveBeenCalled()
    const notice = h.notices.at(-1)!
    expect(notice.kind).toBe('permission')
    expect(notice.dialog).toBe(true)
    expect(notice.settings).toBe(true)
    expect(h.snapshots.at(-1)?.phase).toBe('idle')
  })

  it('开麦慢：松手发生在 start 完成前，只收尾一次；start 回来后录音器立刻被取消', async () => {
    const h = makeHarness({
      recorderSetup: (recorder) => {
        recorder.holdStart = true
      },
    })
    await h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    const recorder = h.recorders[0]!
    expect(recorder.started).toBe(false)

    const releasing = h.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(0)
    await releasing
    expect(h.transcribe).toHaveBeenCalledTimes(1)

    // 开麦终于完成：这一段已经作废 → 立刻释放麦克风
    recorder.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(recorder.cancelled).toBe(true)
    expect(h.transcribe).toHaveBeenCalledTimes(1)
  })
})

describe('服务端引擎：失败与回退', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('502 且系统识别可用：轻提示「服务器识别暂时不可用」，下一次按住自动改用系统识别', async () => {
    const bridge = new FakeBridge()
    const h = makeHarness({
      bridge,
      transcribeImpl: async () => {
        throw new HubApiError('UPSTREAM_ERROR', { status: 502 })
      },
    })
    await holdAndRelease(h)
    expect(h.texts).toEqual([])
    const notice = h.notices.at(-1)!
    expect(notice.kind).toBe('server')
    expect(notice.text).toBe(VOICE_TEXT.serverDown)
    expect(notice.dialog).toBeUndefined()
    expect(h.diag.find(([name]) => name === 'speech:upload')?.[1]).toMatch(/code=UPSTREAM_ERROR$/)

    // 第二次按住：auto 已经改用系统识别（不再上传）
    h.transcribe.mockClear()
    await holdAndRelease(h, 300)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(bridge.starts).toBe(1)
    expect(h.snapshots.at(-1)?.engine).toBe('native')
  })

  it('502 且系统识别不可用：弹窗说明（两者都不可用）', async () => {
    const h = makeHarness({
      nativeAvailable: false,
      transcribeImpl: async () => {
        throw new HubApiError('UPSTREAM_ERROR', { status: 502 })
      },
    })
    await holdAndRelease(h)
    const notice = h.notices.at(-1)!
    expect(notice.kind).toBe('server')
    expect(notice.dialog).toBe(true)
    expect(notice.text).toContain('也没有可用的系统识别服务')
  })

  it('网络错误也走回退（下次用系统识别）', async () => {
    const bridge = new FakeBridge()
    const h = makeHarness({
      bridge,
      transcribeImpl: async () => {
        throw new HubApiError('network')
      },
    })
    await holdAndRelease(h)
    expect(h.notices.at(-1)?.text).toBe(VOICE_TEXT.serverDown)
    await holdAndRelease(h, 300)
    expect(h.snapshots.at(-1)?.engine).toBe('native')
  })

  it('限流/格式错误不走回退：直接给具体中文提示', async () => {
    const cases: Array<[HubApiError, string]> = [
      [new HubApiError('RATE_LIMITED', { status: 429 }), '识别太频繁了'],
      [new HubApiError('PAYLOAD_TOO_LARGE', { status: 413 }), '录音太长了'],
      [new HubApiError('UNSUPPORTED_MEDIA', { status: 415 }), '没能识别'],
      [new HubApiError('VALIDATION_FAILED', { status: 400 }), '没能识别'],
    ]
    for (const [error, expected] of cases) {
      const h = makeHarness({
        transcribeImpl: async () => {
          throw error
        },
      })
      await holdAndRelease(h)
      const notice = h.notices.at(-1)!
      expect(notice.kind).toBe('error')
      expect(notice.text).toContain(expected)
      expect(isServerFallbackCode(error.code)).toBe(false)
    }
  })

  it('手动选「服务器」但 Hub 没开：弹窗说明「没有开启」，不上传也不用系统识别', async () => {
    const bridge = new FakeBridge()
    const h = makeHarness({
      bridge,
      engine: () => ({ preference: 'server', serverEnabled: false }),
    })
    await holdAndRelease(h, 300)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(bridge.starts).toBe(0)
    const notice = h.notices.at(-1)!
    expect(notice.kind).toBe('unavailable')
    expect(notice.dialog).toBe(true)
    expect(notice.text).toContain('没有开启')
  })

  it('手动选「手机系统」但系统不可用：弹窗说明，绝不把录音传去服务器', async () => {
    const bridge = new FakeBridge()
    const h = makeHarness({
      bridge,
      nativeAvailable: false,
      engine: () => ({ preference: 'native', serverEnabled: true }),
    })
    await holdAndRelease(h, 300)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(bridge.starts).toBe(0)
    const notice = h.notices.at(-1)!
    expect(notice.kind).toBe('unavailable')
    expect(notice.dialog).toBe(true)
    expect(notice.text).toBe(VOICE_TEXT.unavailable)
  })

  it('手动选「手机系统」：哪怕服务端可用也用系统识别', async () => {
    const bridge = new FakeBridge()
    const h = makeHarness({
      bridge,
      engine: () => ({ preference: 'native', serverEnabled: true }),
    })
    await holdAndRelease(h, 300)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(bridge.starts).toBe(1)
    expect(h.diag.find(([name]) => name === 'speech:engine')?.[1]).toBe('native · native')
  })

  it('服务端没开且没有原生桥（浏览器）：提示「语音输入仅在 App 中可用」', async () => {
    const h = makeHarness({ engine: () => ({ preference: 'auto', serverEnabled: false }) })
    const releasing = h.voice.pointerDown(10, 500)
    await vi.advanceTimersByTimeAsync(0)
    await releasing
    await vi.advanceTimersByTimeAsync(0)
    expect(h.notices).toEqual([{ kind: 'web', text: VOICE_TEXT.web }])
    expect(h.voice.currentPhase).toBe('idle')
  })
})

describe('服务端错误码工具函数', () => {
  it('HubApiError / RecorderError / AbortError 都能取出稳定 code', () => {
    expect(asrErrorCode(new HubApiError('UPSTREAM_ERROR', { status: 502 }))).toBe('UPSTREAM_ERROR')
    expect(asrErrorCode(Object.assign(new Error('x'), { code: 'permission-denied' }))).toBe(
      'permission-denied',
    )
    expect(asrErrorCode(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout')
    expect(asrErrorCode(undefined)).toBe('unknown')
  })

  it('中文文案覆盖 Hub 契约里的错误码', () => {
    expect(describeAsrError('UPSTREAM_ERROR')).toBe(VOICE_TEXT.serverDownOnly)
    expect(describeAsrError('network')).toContain('网络')
    expect(describeAsrError('timeout')).toContain('超时')
    expect(describeAsrError('PAYLOAD_TOO_LARGE')).toContain('太长')
    expect(describeAsrError('RATE_LIMITED')).toContain('频繁')
    expect(describeAsrError('permission-denied')).toBe(VOICE_TEXT.permission)
    expect(describeAsrError('whatever')).toContain('识别出错')
  })

  it('只有服务端侧的问题才值得回退到系统识别', () => {
    for (const code of ['UPSTREAM_ERROR', 'network', 'timeout', 'INTERNAL']) {
      expect(isServerFallbackCode(code)).toBe(true)
    }
    for (const code of ['RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED', 'foo']) {
      expect(isServerFallbackCode(code)).toBe(false)
    }
  })
})
