/**
 * 0.4.2 App 内录音：WAV 封装、16k 下采样、音量、上限与倒计时、取消与释放。
 *
 * 不碰真麦克风：采集层用假工厂（`capture`），时间用 vitest 假定时器 + 注入时钟。
 * 真实 getUserMedia / AudioWorklet 的行为由 `scripts/e2e-voice.mjs`（Chrome 假麦克风）覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BYTES_PER_SECOND,
  COUNTDOWN_SECONDS,
  DEFAULT_MAX_SECONDS,
  RecorderError,
  TARGET_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  VoiceRecorder,
  clampMaxSeconds,
  downsampleTo16k,
  encodeWav,
  floatToInt16,
  isWav,
  levelFromSamples,
  remainingSeconds,
  type CaptureFactory,
  type CaptureSession,
} from '@/lib/voice-recorder'

/** 把 WAV 读回来（测试用）：头字段 + 样本。 */
function parseWav(wav: Uint8Array): {
  riff: string
  wave: string
  fmt: string
  channels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bits: number
  dataTag: string
  dataBytes: number
  samples: Int16Array
} {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const text = (offset: number, length: number): string =>
    Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('')
  const dataBytes = view.getUint32(40, true)
  const samples = new Int16Array(dataBytes / 2)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(WAV_HEADER_BYTES + i * 2, true)
  }
  return {
    riff: text(0, 4),
    wave: text(8, 4),
    fmt: text(12, 4),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    dataTag: text(36, 4),
    dataBytes,
    samples,
  }
}

/** 一段 48kHz 的单声道正弦（1 秒 = 48000 个样本）。 */
function sine(seconds: number, rate = 48_000, hz = 440, amplitude = 0.5): Float32Array {
  const length = Math.round(seconds * rate)
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate)
  }
  return samples
}

class FakeCapture {
  readonly sampleRate = 48_000
  pushed: Float32Array[] = []
  released = 0
  private sink: ((samples: Float32Array) => void) | null = null

  factory: CaptureFactory = async (onSamples) => {
    this.sink = onSamples
    const session: CaptureSession = {
      sampleRate: this.sampleRate,
      release: () => {
        this.released += 1
        this.sink = null
      },
    }
    return session
  }

  /** 推一帧（模拟采集回调）。 */
  push(samples: Float32Array): void {
    this.pushed.push(samples)
    this.sink?.(samples)
  }
}

describe('clampMaxSeconds', () => {
  it('默认 60，最小 1，最大 60', () => {
    expect(clampMaxSeconds(undefined)).toBe(DEFAULT_MAX_SECONDS)
    expect(clampMaxSeconds(0)).toBe(DEFAULT_MAX_SECONDS)
    expect(clampMaxSeconds(-3)).toBe(DEFAULT_MAX_SECONDS)
    expect(clampMaxSeconds(Number.NaN)).toBe(DEFAULT_MAX_SECONDS)
    expect(clampMaxSeconds(30)).toBe(30)
    expect(clampMaxSeconds(120)).toBe(60)
    expect(clampMaxSeconds(0.4)).toBe(1)
  })
})

describe('downsampleTo16k', () => {
  it('48000 → 16000：1 秒变 16000 个样本', () => {
    const input = sine(1, 48_000)
    const output = downsampleTo16k(input, 48_000)
    expect(output.length).toBe(TARGET_SAMPLE_RATE)
  })

  it('44100 → 16000：1 秒也是 16000 个样本（非整数倍）', () => {
    const input = sine(1, 44_100)
    const output = downsampleTo16k(input, 44_100)
    expect(output.length).toBe(TARGET_SAMPLE_RATE)
  })

  it('已经是 16k：原样拷贝，长度不变', () => {
    const input = sine(0.5, 16_000)
    const output = downsampleTo16k(input, 16_000)
    expect(output.length).toBe(input.length)
    expect(Array.from(output)).toEqual(Array.from(input))
    expect(output).not.toBe(input)
  })

  it('空输入 → 空输出', () => {
    expect(downsampleTo16k(new Float32Array(0), 48_000).length).toBe(0)
  })

  it('直流分量（0.5）下采样后还是 0.5（盒式滤波不改变电平）', () => {
    const input = new Float32Array(48_000).fill(0.5)
    const output = downsampleTo16k(input, 48_000)
    for (const value of output) expect(value).toBeCloseTo(0.5, 5)
  })
})

describe('floatToInt16 / encodeWav', () => {
  it('满幅不溢出：1 → 32767，-1 → -32768，0 → 0', () => {
    const pcm = floatToInt16(new Float32Array([1, -1, 0, 0.5, -0.5]))
    expect(Array.from(pcm)).toEqual([32767, -32768, 0, 16384, -16384])
  })

  it('WAV 头：44 字节，PCM/单声道/16kHz/16bit 全部写对', () => {
    const pcm = new Int16Array(16_000) // 1 秒静音
    const wav = encodeWav(pcm)
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.length * 2)
    const parsed = parseWav(wav)
    expect(parsed.riff).toBe('RIFF')
    expect(parsed.wave).toBe('WAVE')
    expect(parsed.fmt).toBe('fmt ')
    expect(parsed.dataTag).toBe('data')
    expect(parsed.channels).toBe(1)
    expect(parsed.sampleRate).toBe(16_000)
    expect(parsed.byteRate).toBe(BYTES_PER_SECOND)
    expect(parsed.blockAlign).toBe(2)
    expect(parsed.bits).toBe(16)
    expect(parsed.dataBytes).toBe(32_000)
    // RIFF 长度 = 文件总长 - 8
    const view = new DataView(wav.buffer)
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8)
    expect(view.getUint16(20, true)).toBe(1) // audioFormat = PCM
  })

  it('样本按小端写回，能原样读出来', () => {
    const pcm = new Int16Array([1234, -2345, 0, 32767, -32768])
    const parsed = parseWav(encodeWav(pcm))
    expect(Array.from(parsed.samples)).toEqual(Array.from(pcm))
  })

  it('空录音（0 样本）也是合法 WAV：只有 44 字节头', () => {
    const wav = encodeWav(new Int16Array(0))
    expect(wav.byteLength).toBe(44)
    expect(isWav(wav)).toBe(true)
    expect(parseWav(wav).dataBytes).toBe(0)
  })

  it('isWav 认得出自己的产物、认不出杂音', () => {
    expect(isWav(encodeWav(new Int16Array(8)))).toBe(true)
    expect(isWav(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(isWav(new Uint8Array(44))).toBe(false)
  })
})

describe('levelFromSamples / remainingSeconds', () => {
  it('静音 0，满幅 1，中间有区分度', () => {
    expect(levelFromSamples(new Float32Array(0))).toBe(0)
    expect(levelFromSamples(new Float32Array(480).fill(0))).toBe(0)
    const quiet = levelFromSamples(new Float32Array(480).fill(0.02))
    const loud = levelFromSamples(new Float32Array(480).fill(0.4))
    expect(quiet).toBeGreaterThan(0)
    expect(quiet).toBeLessThan(loud)
    expect(loud).toBe(1)
  })

  it('倒计时：60 秒上限，剩 10 秒开始每秒一个数', () => {
    // 剩余秒数是「向上取整」：只有刚好跨过整秒才会少 1
    expect(remainingSeconds(60, 0)).toBe(60)
    expect(remainingSeconds(60, 49_999)).toBe(11)
    expect(remainingSeconds(60, 50_000)).toBe(10)
    expect(remainingSeconds(60, 50_999)).toBe(10)
    expect(remainingSeconds(60, 51_000)).toBe(9)
    expect(remainingSeconds(60, 59_000)).toBe(1)
    expect(remainingSeconds(60, 59_999)).toBe(1)
    expect(remainingSeconds(60, 60_000)).toBe(0)
    expect(remainingSeconds(60, 61_000)).toBe(0)
  })

  it('倒计时常量是 10 秒（与需求一致）', () => {
    expect(COUNTDOWN_SECONDS).toBe(10)
  })
})

describe('VoiceRecorder：采集与封装', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('48k 采集 1 秒 → 16000 个样本的 16k WAV，并报音量', async () => {
    const capture = new FakeCapture()
    const levels: number[] = []
    const recorder = new VoiceRecorder({ capture: capture.factory, onLevel: (l) => levels.push(l) })
    await recorder.start()
    capture.push(sine(0.5))
    vi.advanceTimersByTime(100)
    capture.push(sine(0.5))
    vi.advanceTimersByTime(100)
    const recording = await recorder.stop()
    expect(recording.sampleRate).toBe(16_000)
    expect(recording.samples).toBe(16_000)
    expect(recording.durationMs).toBe(1_000)
    expect(recording.wav.byteLength).toBe(44 + 32_000)
    expect(parseWav(recording.wav).sampleRate).toBe(16_000)
    expect(levels.length).toBeGreaterThan(0)
    expect(Math.max(...levels)).toBeGreaterThan(0.1)
    expect(capture.released).toBe(1)
    expect(recorder.active).toBe(false)
  })

  it('stop() 可重复调用：同一次录音只封装一次', async () => {
    const capture = new FakeCapture()
    const recorder = new VoiceRecorder({ capture: capture.factory })
    await recorder.start()
    capture.push(sine(0.25))
    const first = await recorder.stop()
    const second = await recorder.stop()
    expect(second).toBe(first)
    expect(capture.released).toBe(1)
  })

  it('cancel()：释放麦克风、丢弃音频（stop 后是空 WAV）', async () => {
    const capture = new FakeCapture()
    const recorder = new VoiceRecorder({ capture: capture.factory })
    await recorder.start()
    capture.push(sine(0.5))
    recorder.cancel()
    expect(capture.released).toBe(1)
    expect(recorder.active).toBe(false)
    const recording = await recorder.stop()
    expect(recording.samples).toBe(0)
    expect(recording.durationMs).toBe(0)
  })

  it('权限被拒 → 抛 permission-denied，且不打开麦克风', async () => {
    const capture = new FakeCapture()
    const ensurePermission = vi.fn(async () => 'denied' as const)
    const recorder = new VoiceRecorder({ capture: capture.factory, ensurePermission })
    const error = await recorder.start().catch((e) => e)
    expect(error).toBeInstanceOf(RecorderError)
    expect(error.code).toBe('permission-denied')
    expect(ensurePermission).toHaveBeenCalledTimes(1)
    expect(capture.pushed.length).toBe(0)
    expect(recorder.active).toBe(false)
  })

  it('getUserMedia 抛 NotAllowedError → 也归为 permission-denied', async () => {
    const capture: CaptureFactory = async () => {
      const error = new Error('denied')
      error.name = 'NotAllowedError'
      throw error
    }
    const recorder = new VoiceRecorder({ capture })
    const error = await recorder.start().catch((e) => e)
    expect(error).toBeInstanceOf(RecorderError)
    expect(error.code).toBe('permission-denied')
  })

  it('没有麦克风（NotFoundError）→ unavailable', async () => {
    const capture: CaptureFactory = async () => {
      const error = new Error('no mic')
      error.name = 'NotFoundError'
      throw error
    }
    const recorder = new VoiceRecorder({ capture })
    const error = await recorder.start().catch((e) => e)
    expect(error.code).toBe('unavailable')
  })
})

describe('VoiceRecorder：上限与倒计时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('剩 10 秒开始每秒倒计时，到点自动结束并释放麦克风', async () => {
    const capture = new FakeCapture()
    const countdowns: number[] = []
    const onLimit = vi.fn()
    const recorder = new VoiceRecorder({
      maxSeconds: 12,
      capture: capture.factory,
      onCountdown: (left) => countdowns.push(left),
      onLimit,
    })
    await recorder.start()
    capture.push(sine(0.2))

    // 录到第 2 秒（剩 10 秒）才开始有倒计时
    vi.advanceTimersByTime(1_000)
    expect(countdowns).toHaveLength(0)
    vi.advanceTimersByTime(1_000)
    expect(countdowns.at(-1)).toBe(10)

    vi.advanceTimersByTime(9_000) // 第 11 秒（剩 1 秒）
    expect(countdowns.at(-1)).toBe(1)
    expect(onLimit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000) // 到 12 秒上限
    expect(onLimit).toHaveBeenCalledTimes(1)
    // 到点先放麦克风：上层哪怕卡住也不会一直录
    expect(capture.released).toBe(1)

    // 再走 5 秒也不会重复触发
    vi.advanceTimersByTime(5_000)
    expect(onLimit).toHaveBeenCalledTimes(1)

    const recording = await recorder.stop()
    expect(recording.samples).toBe(3_200) // 只推了 0.2 秒真实音频
  })

  it('倒计时从 10 递减到 1，每一项只回调一次', async () => {
    const capture = new FakeCapture()
    const countdowns: number[] = []
    const recorder = new VoiceRecorder({
      maxSeconds: 15,
      capture: capture.factory,
      onCountdown: (left) => countdowns.push(left),
    })
    await recorder.start()
    vi.advanceTimersByTime(15_000)
    expect(countdowns).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
  })

  it('上限按 clamp 走：maxSeconds=999 也会被钳到 60', async () => {
    const capture = new FakeCapture()
    const onLimit = vi.fn()
    const recorder = new VoiceRecorder({ maxSeconds: 999, capture: capture.factory, onLimit })
    await recorder.start()
    expect(recorder.maxDurationMs).toBe(60_000)
    vi.advanceTimersByTime(59_999)
    expect(onLimit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(onLimit).toHaveBeenCalledTimes(1)
  })

  it('取消后不再倒计时、不再触发上限', async () => {
    const capture = new FakeCapture()
    const onLimit = vi.fn()
    const countdowns: number[] = []
    const recorder = new VoiceRecorder({
      maxSeconds: 12,
      capture: capture.factory,
      onLimit,
      onCountdown: (left) => countdowns.push(left),
    })
    await recorder.start()
    vi.advanceTimersByTime(3_000)
    recorder.cancel()
    vi.advanceTimersByTime(20_000)
    expect(onLimit).not.toHaveBeenCalled()
    expect(countdowns.every((value) => value <= 10 && value >= 1)).toBe(true)
  })
})
