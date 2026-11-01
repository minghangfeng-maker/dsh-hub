/**
 * 按住说话（0.4.1）的 JS 状态机：阈值、partial/final 拼接、静音自动重启、上滑取消、
 * 松手等 final 超时、错误映射、不可用提示、切后台取消。
 *
 * 插件用假实现（FakeBridge），时间用 vitest 假定时器 —— 不碰真机、不碰系统识别。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANCEL_DISTANCE,
  FINAL_TIMEOUT_MS,
  HOLD_MS,
  RESTART_DELAY_MS,
  VoiceInput,
  appendTranscript,
  describeSpeechError,
  isCancelDistance,
  joinSegments,
  normalizeRms,
  speechErrorSlug,
} from '@/lib/voice-input'
import type { VoiceNotice, VoiceSnapshot } from '@/lib/voice-input'
import type {
  SpeechAvailability,
  SpeechBridge,
  SpeechEventName,
  SpeechPayloadMap,
  SpeechStopResult,
  SpeechSubscription,
} from '@/lib/speech-native'

type Handler = (payload: unknown) => void

class FakeBridge implements SpeechBridge {
  info: SpeechAvailability = { available: true, onDevice: false, reason: 'system' }
  startError: unknown = null
  /** 默认「系统还在听」：等 final；测试里可以改成 { listening: false }。 */
  stopResult: SpeechStopResult = { listening: true }
  starts = 0
  stops = 0
  cancels = 0
  private handlers = new Map<string, Set<Handler>>()

  availability = async (): Promise<SpeechAvailability> => this.info

  start = async (): Promise<void> => {
    this.starts += 1
    if (this.startError) throw this.startError
  }

  stop = async (): Promise<SpeechStopResult> => {
    this.stops += 1
    return this.stopResult
  }

  cancel = async (): Promise<void> => {
    this.cancels += 1
  }

  openSettings = async (): Promise<void> => {}

  on<E extends SpeechEventName>(
    event: E,
    handler: (payload: SpeechPayloadMap[E]) => void,
  ): SpeechSubscription {
    const set = this.handlers.get(event) ?? new Set<Handler>()
    set.add(handler as Handler)
    this.handlers.set(event, set)
    return {
      remove: () => {
        set.delete(handler as Handler)
      },
    }
  }

  emit<E extends SpeechEventName>(event: E, payload: SpeechPayloadMap[E]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
}

interface Harness {
  voice: VoiceInput
  bridge: FakeBridge
  notices: VoiceNotice[]
  texts: string[]
  snapshots: VoiceSnapshot[]
  diag: Array<[string, string]>
  haptics: string[]
}

function createHarness(
  bridge: FakeBridge | null = new FakeBridge(),
  availability: SpeechAvailability | null | undefined = undefined,
): Harness {
  const notices: VoiceNotice[] = []
  const texts: string[] = []
  const snapshots: VoiceSnapshot[] = []
  const diag: Array<[string, string]> = []
  const haptics: string[] = []
  const voice = new VoiceInput({
    bridge,
    checkAvailability: async () =>
      availability === undefined ? (bridge ? bridge.info : null) : availability,
    haptic: (kind) => haptics.push(kind),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onNotice: (notice) => notices.push(notice),
    onText: (text) => texts.push(text),
    onDiag: (name, detail) => diag.push([name, detail ?? '']),
  })
  return { voice, bridge: bridge as FakeBridge, notices, texts, snapshots, diag, haptics }
}

/** 按下并按住到开始录音。 */
async function holdToRecord(voice: VoiceInput): Promise<void> {
  await voice.pointerDown(100, 700)
  await vi.advanceTimersByTimeAsync(HOLD_MS)
}

function lastSnapshot(harness: Harness): VoiceSnapshot {
  const snapshot = harness.snapshots.at(-1)
  if (!snapshot) throw new Error('没有状态快照')
  return snapshot
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('appendTranscript / joinSegments', () => {
  it('空输入框直接填文字；中文之间不补空格', () => {
    expect(appendTranscript('', '你好')).toBe('你好')
    expect(appendTranscript('你好', '世界')).toBe('你好世界')
    expect(appendTranscript('你好', '，世界')).toBe('你好，世界')
  })

  it('英文/数字之间补一个空格；结尾已有空格不重复补', () => {
    expect(appendTranscript('hello', 'world')).toBe('hello world')
    expect(appendTranscript('hello ', 'world')).toBe('hello world')
    expect(appendTranscript('42', 'ok')).toBe('42 ok')
    expect(appendTranscript('hello', '，world')).toBe('hello，world')
  })

  it('空白段直接略过；多段 final 顺序拼起来', () => {
    expect(appendTranscript('你好', '   ')).toBe('你好')
    expect(joinSegments(['你好', '世界', '', '  '])).toBe('你好世界')
    expect(joinSegments(['one', 'two', 'three'])).toBe('one two three')
    expect(joinSegments([])).toBe('')
  })
})

describe('normalizeRms / isCancelDistance', () => {
  it('rms 归一到 0–1（-2dB 起、10dB 满）', () => {
    expect(normalizeRms(-2)).toBe(0)
    expect(normalizeRms(10)).toBe(1)
    expect(normalizeRms(-20)).toBe(0)
    expect(normalizeRms(30)).toBe(1)
    expect(normalizeRms(Number.NaN)).toBe(0)
    expect(normalizeRms(4)).toBeCloseTo(0.5, 5)
  })

  it('上滑超过 60px 才算取消（正好 60 不算）', () => {
    expect(isCancelDistance(700, 700 - CANCEL_DISTANCE)).toBe(false)
    expect(isCancelDistance(700, 700 - CANCEL_DISTANCE - 1)).toBe(true)
    expect(isCancelDistance(700, 800)).toBe(false)
  })
})

describe('错误码映射', () => {
  it('数字码与字符串码都映射成同一句中文', () => {
    expect(speechErrorSlug(7)).toBe('no-match')
    expect(speechErrorSlug(8)).toBe('busy')
    expect(speechErrorSlug('9')).toBe('permission-denied')
    expect(speechErrorSlug('network')).toBe('network')
    expect(speechErrorSlug(undefined)).toBe('unknown')
    expect(describeSpeechError(2)).toBe('网络不可用，请检查网络后再试')
    expect(describeSpeechError(6)).toBe('没听清，请再说一次')
    expect(describeSpeechError(7)).toBe('没听清，请再说一次')
    expect(describeSpeechError(8)).toBe('识别服务忙，请稍后再试')
    expect(describeSpeechError(9)).toContain('麦克风权限')
    expect(describeSpeechError('no-recognizer')).toContain('没有可用的系统语音识别服务')
    // 未知码用原生给的 message 兜底，再不行才用通用文案
    expect(describeSpeechError('weird', '系统说了句别的')).toBe('系统说了句别的')
    expect(describeSpeechError('weird')).toBe('识别出错了，请再试一次')
  })
})

describe('按住说话手势', () => {
  it('短按（<200ms）只提示「按住说话」，不开录音', async () => {
    const harness = createHarness()
    await harness.voice.pointerDown(100, 700)
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1)
    expect(harness.bridge.starts).toBe(0)

    await harness.voice.pointerUp()
    expect(harness.bridge.starts).toBe(0)
    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.notices.at(-1)).toMatchObject({ kind: 'hold', text: '按住说话' })
    expect(harness.haptics).toEqual([])
  })

  it('按住满 200ms 才开始录音，并给触感', async () => {
    const harness = createHarness()
    await harness.voice.pointerDown(100, 700)
    expect(harness.voice.currentPhase).toBe('pending')
    await vi.advanceTimersByTimeAsync(HOLD_MS)

    expect(harness.bridge.starts).toBe(1)
    expect(harness.voice.currentPhase).toBe('recording')
    expect(harness.haptics).toEqual(['start'])
    expect(lastSnapshot(harness)).toMatchObject({ phase: 'recording', cancelling: false })
  })

  it('partial 实时更新浮层文字；松手后 final 到达立即填入', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)

    harness.bridge.emit('partial', { text: '今天' })
    expect(lastSnapshot(harness).text).toBe('今天')
    harness.bridge.emit('partial', { text: '今天下午' })
    expect(lastSnapshot(harness).text).toBe('今天下午')

    await harness.voice.pointerUp()
    expect(harness.bridge.stops).toBe(1)
    expect(harness.voice.currentPhase).toBe('finalizing')

    // stop 之后系统才把最终结果送回来
    harness.bridge.emit('final', { text: '今天下午三点' })
    expect(harness.texts).toEqual(['今天下午三点'])
    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.diag).toContainEqual(['speech:insert', '6 字'])
  })

  it('静音自动结束：按住期间自动续一段，多段 final 拼起来', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)

    harness.bridge.emit('final', { text: '第一段' })
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    expect(harness.bridge.starts).toBe(2)
    expect(harness.voice.currentPhase).toBe('recording')

    harness.bridge.emit('final', { text: '第二段' })
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    expect(harness.bridge.starts).toBe(3)

    // 松手后系统还给了最后一段
    await harness.voice.pointerUp()
    harness.bridge.emit('final', { text: '第三段' })
    expect(harness.texts).toEqual(['第一段第二段第三段'])
  })

  it('系统只发 end 不发 final 时也会续段；error(no-speech) 同样悄悄续（不打扰用户）', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)

    harness.bridge.emit('error', { code: 'no-speech', message: '没听清，请再说一次' })
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    expect(harness.bridge.starts).toBe(2)
    expect(harness.notices).toEqual([])

    harness.bridge.emit('end', {})
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    expect(harness.bridge.starts).toBe(3)
    expect(harness.voice.currentPhase).toBe('recording')
  })

  it('上滑超过 60px 进入取消态；松手丢弃、不插入文字', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)

    harness.bridge.emit('partial', { text: '这句不要了' })
    harness.voice.pointerMove(700 - CANCEL_DISTANCE - 10)
    expect(lastSnapshot(harness).cancelling).toBe(true)
    expect(harness.haptics).toEqual(['start', 'cancel'])

    await harness.voice.pointerUp()
    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.bridge.cancels).toBe(1)
    expect(harness.texts).toEqual([])
    expect(harness.notices.at(-1)).toMatchObject({ kind: 'cancelled', text: '已取消' })
  })

  it('上滑后又滑回来：退出取消态，松手正常插入', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)

    harness.voice.pointerMove(700 - CANCEL_DISTANCE - 10)
    expect(lastSnapshot(harness).cancelling).toBe(true)
    harness.voice.pointerMove(700 - 10)
    expect(lastSnapshot(harness).cancelling).toBe(false)

    await harness.voice.pointerUp()
    harness.bridge.emit('final', { text: '还是要发的' })
    expect(harness.texts).toEqual(['还是要发的'])
  })

  it('松手后等 final 最多 2 秒：超时用已经拿到的 final 收尾', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    harness.bridge.emit('final', { text: '先落库的一段' })
    await harness.voice.pointerUp()

    expect(harness.texts).toEqual([])
    await vi.advanceTimersByTimeAsync(FINAL_TIMEOUT_MS - 10)
    expect(harness.texts).toEqual([])

    // 超时后用 cancel 收掉原生会话，避免后台继续录
    await vi.advanceTimersByTimeAsync(20)
    expect(harness.bridge.cancels).toBe(1)
    expect(harness.texts).toEqual(['先落库的一段'])
    expect(harness.voice.currentPhase).toBe('idle')
  })

  it('系统早已结束这一段（stop 返回 listening=false）：松手立刻填入，不用干等 2 秒', async () => {
    const harness = createHarness()
    harness.bridge.stopResult = { listening: false }
    await holdToRecord(harness.voice)
    harness.bridge.emit('final', { text: '提前结束的一段' })
    // final 在按住期间到达后会安排续段；松手时把它清掉，识别器其实已经释放
    await harness.voice.pointerUp()
    expect(harness.texts).toEqual(['提前结束的一段'])
    expect(harness.voice.currentPhase).toBe('idle')
  })

  it('松手后一段 final 都没有、只有 partial：把屏幕上的文字填进去', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    harness.bridge.emit('partial', { text: '屏幕上这句' })
    await harness.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(FINAL_TIMEOUT_MS + 10)
    expect(harness.texts).toEqual(['屏幕上这句'])
  })

  it('识别为空：提示「没听清，请再说一次」', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    await harness.voice.pointerUp()
    await vi.advanceTimersByTimeAsync(FINAL_TIMEOUT_MS + 10)
    expect(harness.texts).toEqual([])
    expect(harness.notices.at(-1)).toMatchObject({ kind: 'empty', text: '没听清，请再说一次' })
  })
})

describe('错误与权限', () => {
  it('录音中遇到识别错误：结束并给中文提示，不插入文字', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    harness.bridge.emit('error', { code: 'busy', message: '' })

    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.texts).toEqual([])
    expect(harness.notices.at(-1)).toMatchObject({ kind: 'error', text: '识别服务忙，请稍后再试' })
    expect(harness.diag).toContainEqual(['speech:error', 'code=busy'])
  })

  it('已经说了半句才报错：保留已识别的文字', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    harness.bridge.emit('final', { text: '我要说的话' })
    harness.bridge.emit('error', { code: 'client', message: '' })
    expect(harness.texts).toEqual(['我要说的话'])
  })

  it('权限被拒：弹窗引导去系统设置', async () => {
    const bridge = new FakeBridge()
    bridge.startError = Object.assign(new Error('没有麦克风权限'), {
      code: 'permission-denied',
      data: { code: 'permission-denied', message: '没有麦克风权限，请在系统设置里允许 DSH Hub 使用麦克风' },
    })
    const harness = createHarness(bridge)
    await holdToRecord(harness.voice)

    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.notices.at(-1)).toMatchObject({
      kind: 'permission',
      dialog: true,
      settings: true,
    })
    expect(harness.notices.at(-1)?.text).toContain('麦克风权限')
  })

  it('没有系统识别服务：弹窗说明，不调 start', async () => {
    const bridge = new FakeBridge()
    bridge.info = { available: false, onDevice: false, reason: 'none' }
    const harness = createHarness(bridge)
    await harness.voice.pointerDown(100, 700)

    expect(harness.bridge.starts).toBe(0)
    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.notices.at(-1)).toMatchObject({ kind: 'unavailable', dialog: true })
    expect(harness.notices.at(-1)?.text).toContain('没有可用的系统语音识别服务')
    expect(harness.diag).toContainEqual(['speech:unavailable', 'none'])
  })

  it('只有离线识别（available=false, onDevice=true）也能开始录音', async () => {
    const bridge = new FakeBridge()
    bridge.info = { available: false, onDevice: true, reason: 'on-device-only' }
    const harness = createHarness(bridge)
    await holdToRecord(harness.voice)
    expect(harness.bridge.starts).toBe(1)
    expect(harness.voice.currentPhase).toBe('recording')
  })

  it('Web（没有原生桥）：点按提示「语音输入仅在 App 中可用」', async () => {
    const harness = createHarness(null)
    await harness.voice.pointerDown(100, 700)
    await harness.voice.pointerUp()

    expect(harness.notices).toEqual([{ kind: 'web', text: '语音输入仅在 App 中可用' }])
    expect(harness.voice.currentPhase).toBe('idle')
  })
})

describe('切后台 / 页面切换', () => {
  it('录音中切后台：静默取消、丢弃已经识别的文字', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    harness.bridge.emit('final', { text: '别插进去' })

    harness.voice.cancel()
    expect(harness.bridge.cancels).toBe(1)
    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.texts).toEqual([])
    expect(harness.notices).toEqual([])

    // 取消后系统再补 final 也不会插字
    harness.bridge.emit('final', { text: '迟到的结果' })
    expect(harness.texts).toEqual([])
  })

  it('按住还没到 200ms 就切后台：不会开始录音', async () => {
    const harness = createHarness()
    await harness.voice.pointerDown(100, 700)
    harness.voice.cancel()
    await vi.advanceTimersByTimeAsync(HOLD_MS + 10)
    expect(harness.bridge.starts).toBe(0)
    expect(harness.voice.currentPhase).toBe('idle')
  })

  it('destroy() 取消会话并退订事件', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    harness.voice.destroy()
    expect(harness.bridge.cancels).toBe(1)
    harness.bridge.emit('partial', { text: '不该再有反应' })
    expect(harness.voice.currentPhase).toBe('idle')
    expect(harness.snapshots.at(-1)?.phase).toBe('idle')
  })

  it('等 final 期间切后台：不再插入文字', async () => {
    const harness = createHarness()
    await holdToRecord(harness.voice)
    harness.bridge.emit('final', { text: '前半句' })
    await harness.voice.pointerUp()
    harness.voice.cancel()
    harness.bridge.emit('final', { text: '后半句' })
    await vi.advanceTimersByTimeAsync(FINAL_TIMEOUT_MS + 10)
    expect(harness.texts).toEqual([])
  })
})
