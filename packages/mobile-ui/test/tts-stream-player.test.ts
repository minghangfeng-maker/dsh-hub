/**
 * 0.4.6/0.4.7 流式朗读播放器：自适应抖动缓冲、排程时间轴、静音裁剪/增益、
 * 自适应切段（逐段规划）、速率持久化、缓存、429 重试、中途中断、停止丢弃迟到数据、自然读完。
 *
 * 时间、流、音频出口都是假的（虚拟时钟按毫秒推进）；真 Web Audio 由
 * scripts/e2e-tts-stream.mjs 在 Chrome 里覆盖。
 */

import { describe, expect, it } from 'vitest'
import { HubApiError } from '@dsh-hub/mobile-core'
import {
  SegmentShaper,
  TTS_ASSUMED_RATE,
  TTS_BLOCK_MS,
  TTS_FIRST_MAX_CHARS,
  TTS_FIRST_MIN_CHARS,
  TTS_GAP_PARAGRAPH_SEC,
  TTS_GAP_SENTENCE_SEC,
  TTS_OPEN_BUFFER_SEC,
  TTS_PEAK_LIMIT,
  TTS_RATE_EWMA_ALPHA,
  TTS_RATE_MAX,
  TTS_RATE_MIN,
  TTS_RATE_STORAGE_KEY,
  TTS_SEGMENT_MAX_CHARS,
  TTS_SEGMENT_MIN_CHARS,
  TTS_TAIL_MERGE_RATIO,
  TTS_TAIL_PAUSE_MS,
  TtsPcmCache,
  TtsStreamPlayer,
  blendTtsRate,
  buildSpeechUnits,
  clampTtsRate,
  estimateSpeechGain,
  estimateStreamRate,
  persistTtsRate,
  planNextSegment,
  planSegmentCount,
  readPersistedTtsRate,
  streamBufferSeconds,
  trimLeadingSilence,
  trimTrailingSilence,
  type TtsRateStorage,
  type TtsStreamInfo,
} from '@/lib/tts-stream-player'
import type { TtsStreamSink } from '@/lib/tts-audio'
import type { TtsSnapshot } from '@/lib/tts-player'

const SAMPLE_RATE = 24_000

/* ---------- 虚拟时钟 ---------- */

class FakeTime {
  private t = 0
  private waiters: Array<{ at: number; resolve: () => void }> = []

  now = (): number => this.t

  /** 播放器/测试用的睡眠：推进虚拟时钟并让等时间的流继续。 */
  sleep = async (ms: number): Promise<void> => {
    this.t += Math.max(0, ms)
    this.drain()
    await Promise.resolve()
    await Promise.resolve()
  }

  /** 流按真实节奏等时间：时钟推进到点时才继续（由播放器的 sleep 驱动）。 */
  wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    const at = this.t + ms
    return new Promise<void>((resolve) => this.waiters.push({ at, resolve }))
  }

  advance(ms: number): void {
    this.t += ms
    this.drain()
  }

  private drain(): void {
    const due = this.waiters.filter((waiter) => this.t >= waiter.at)
    if (due.length === 0) return
    this.waiters = this.waiters.filter((waiter) => this.t < waiter.at)
    for (const waiter of due) waiter.resolve()
  }
}

/* ---------- 假音频出口 ---------- */

class FakeSink implements TtsStreamSink {
  readonly blocks: Array<{ when: number; duration: number; samples: Float32Array }> = []
  stops = 0
  disposed = 0
  resumed = 0

  constructor(private readonly time: FakeTime) {}

  now(): number {
    return this.time.now() / 1_000
  }

  schedule(samples: Float32Array, sampleRate: number, when: number): number {
    const duration = samples.length / sampleRate
    this.blocks.push({ when, duration, samples })
    return duration
  }

  stopAll(): void {
    this.stops += 1
  }

  dispose(): void {
    this.disposed += 1
  }

  async resume(): Promise<void> {
    this.resumed += 1
  }

  /** 排程时间轴是否首尾相接（每一块的 when 都等于上一块的结束时刻）。 */
  contiguous(tolerance = 0.001): boolean {
    for (let i = 1; i < this.blocks.length; i += 1) {
      const prevEnd = this.blocks[i - 1]!.when + this.blocks[i - 1]!.duration
      if (Math.abs(this.blocks[i]!.when - prevEnd) > tolerance) return false
    }
    return true
  }

  /** 段内是否首尾相接：只允许段尾 220ms 停顿之后出现段间等待。 */
  contiguousWithinSegments(tolerance = 0.001): boolean {
    for (let i = 1; i < this.blocks.length; i += 1) {
      const prev = this.blocks[i - 1]!
      const gap = this.blocks[i]!.when - (prev.when + prev.duration)
      if (Math.abs(gap) <= tolerance) continue
      if (Math.abs(prev.duration - TTS_TAIL_PAUSE_MS / 1_000) <= 0.005) continue
      return false
    }
    return true
  }
}

/* ---------- 假 PCM（有声的正弦，整形器才认得出「有声帧」） ---------- */

function pcmFor(chars: number, options: { msPerChar?: number } = {}): Uint8Array {
  const msPerChar = options.msPerChar ?? 90
  const totalSamples = Math.max(1, Math.round((chars * msPerChar * SAMPLE_RATE) / 1_000))
  const bytes = new Uint8Array(totalSamples * 2)
  const view = new DataView(bytes.buffer)
  const syllable = Math.max(1, Math.round((msPerChar * SAMPLE_RATE) / 1_000))
  for (let i = 0; i < totalSamples; i += 1) {
    const phase = (i % syllable) / syllable
    const envelope = Math.sin(Math.PI * phase) ** 2
    const value = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.25 * envelope
    view.setInt16(i * 2, Math.round(value * 32_767), true)
  }
  return bytes
}

/* ---------- 假 Hub（按可配置的速率下发） ---------- */

interface StreamScript {
  /** 音频秒 / 真实秒：0.9 = 比实时慢 10%（真星汐实测 0.89–0.91）。 */
  rate?: number
  firstChunkMs?: number
  chunkMs?: number
  /** 每个字多少毫秒音频。 */
  msPerChar?: number
  /** 第 N 次请求直接抛错（429 / 502 …）。 */
  failOnCall?: (index: number) => unknown
  /** 下发这么多块之后掐断（模拟 Hub 开始下发后失败）。 */
  interruptAfterChunks?: number
  /** 第 N 块之后停顿这么久（模拟网络抖动）。 */
  stallAfterChunks?: number
  stallMs?: number
}

interface FakeCall {
  text: string
  voice: string | undefined
  aborted: boolean
}

class FakeHub {
  readonly calls: FakeCall[] = []
  inflight = 0
  maxInflight = 0

  constructor(
    private readonly time: FakeTime,
    private readonly script: StreamScript = {},
  ) {}

  synthesizeStream = async (input: {
    text: string
    voice?: string
    signal?: AbortSignal
  }): Promise<TtsStreamInfo> => {
    const index = this.calls.length
    const failure = this.script.failOnCall?.(index)
    this.calls.push({ text: input.text, voice: input.voice, aborted: false })
    if (failure !== undefined) throw failure
    this.inflight += 1
    this.maxInflight = Math.max(this.maxInflight, this.inflight)
    return {
      sampleRate: SAMPLE_RATE,
      voice: input.voice ?? 'seki',
      cached: false,
      chunks: this.generate(input.text, input.signal, index),
    }
  }

  private async *generate(
    text: string,
    signal: AbortSignal | undefined,
    index: number,
  ): AsyncGenerator<Uint8Array, void, void> {
    const rate = this.script.rate ?? 1
    const chunkMs = this.script.chunkMs ?? 200
    const firstChunkMs = this.script.firstChunkMs ?? 200
    const pcm = pcmFor(Array.from(text).length, { msPerChar: this.script.msPerChar })
    const chunkBytes = Math.max(2, Math.round((chunkMs * SAMPLE_RATE * 2) / 1_000))
    const call = this.calls[index]
    try {
      await this.time.wait(firstChunkMs)
      let offset = 0
      let chunks = 0
      while (offset < pcm.byteLength) {
        if (signal?.aborted === true) {
          if (call) call.aborted = true
          throw new HubApiError('cancelled', { status: 0 })
        }
        if (
          this.script.interruptAfterChunks !== undefined &&
          chunks >= this.script.interruptAfterChunks
        ) {
          throw new HubApiError('stream-interrupted', { status: 502 })
        }
        const end = Math.min(pcm.byteLength, offset + chunkBytes)
        const piece = pcm.slice(offset, end)
        offset = end
        chunks += 1
        yield piece
        if (offset >= pcm.byteLength) return
        if (
          this.script.stallAfterChunks !== undefined &&
          chunks === this.script.stallAfterChunks
        ) {
          await this.time.wait(this.script.stallMs ?? 5_000)
        } else {
          await this.time.wait(chunkMs / rate)
        }
      }
    } finally {
      this.inflight = Math.max(0, this.inflight - 1)
    }
  }
}

/* ---------- 播放器夹具 ---------- */

interface Harness {
  player: TtsStreamPlayer
  sink: FakeSink
  hub: FakeHub
  time: FakeTime
  snapshots: TtsSnapshot[]
  diags: Array<[string, string]>
  notices: string[]
  cache: TtsPcmCache
}

function makeHarness(options: {
  script?: StreamScript
  cache?: TtsPcmCache
  maxChars?: number
  charsPerSecond?: number
  startBufferSec?: number
  loadRate?: () => number | undefined
  saveRate?: (rate: number) => number
} = {}): Harness {
  const time = new FakeTime()
  const sink = new FakeSink(time)
  const hub = new FakeHub(time, options.script)
  const snapshots: TtsSnapshot[] = []
  const diags: Array<[string, string]> = []
  const notices: string[] = []
  const cache = options.cache ?? new TtsPcmCache()
  const player = new TtsStreamPlayer({
    synthesizeStream: (input) => hub.synthesizeStream(input),
    sink: () => sink,
    maxChars: options.maxChars ?? 120,
    charsPerSecond: options.charsPerSecond,
    startBufferSec: options.startBufferSec,
    cache,
    loadRate: options.loadRate,
    saveRate: options.saveRate,
    now: time.now,
    sleep: time.sleep,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDiag: (name, detail) => diags.push([name, detail ?? '']),
    onNotice: (text) => notices.push(text),
  })
  return { player, sink, hub, time, snapshots, diags, notices, cache }
}

/** 两句各 30 字（0.4.7 首段会被切成 ~20 字，用时可控）。 */
const SHORT_TEXT = `${'一二三四五六七八九十'.repeat(3)}。${'甲乙丙丁戊己庚辛壬癸'.repeat(3)}。`

/** 10 字一句（切段测试的可数单位）。 */
const TEN_CHARS = `${'一'.repeat(9)}。`
/** n 个 10 字句（同一段）。 */
function uniformSpeech(sentences: number): string {
  return Array.from({ length: sentences }, () => TEN_CHARS).join('')
}

/* ---------- 自适应切段（0.4.7） ---------- */

describe('自适应切段：常量与公式', () => {
  it('策略常量就是任务包的数值（改了要同步 README/注释）', () => {
    expect(TTS_OPEN_BUFFER_SEC).toBe(0.8)
    expect(TTS_FIRST_MIN_CHARS).toBe(20)
    expect(TTS_FIRST_MAX_CHARS).toBe(80)
    expect(TTS_SEGMENT_MIN_CHARS).toBe(60)
    expect(TTS_SEGMENT_MAX_CHARS).toBe(200)
    expect(TTS_GAP_SENTENCE_SEC).toBe(0.6)
    expect(TTS_GAP_PARAGRAPH_SEC).toBe(1)
    expect(TTS_TAIL_MERGE_RATIO).toBe(1.25)
    expect(TTS_RATE_EWMA_ALPHA).toBe(0.5)
  })

  it('上限按 (预算 − 0.3) / (1/r − 1) × 字/秒 反推，并钳在 MIN–MAX', () => {
    // 首段：0.5 / (1/0.95 − 1) × 5.6 ≈ 53.2；0.88 时约 20.5 → 下限 20
    expect(Math.floor(((TTS_OPEN_BUFFER_SEC - 0.3) / (1 / 0.95 - 1)) * 5.6)).toBe(53)
    expect(Math.floor(((TTS_OPEN_BUFFER_SEC - 0.3) / (1 / 0.88 - 1)) * 5.6)).toBeLessThanOrEqual(
      TTS_FIRST_MIN_CHARS,
    )
    // 后续段：0.6 / (1/0.9 − 1) × 5.6 ≈ 30.2 → 下限 60
    expect(Math.floor((TTS_GAP_SENTENCE_SEC / (1 / 0.9 - 1)) * 5.6)).toBeLessThan(
      TTS_SEGMENT_MIN_CHARS,
    )
  })
})

describe('自适应切段：首段', () => {
  it('首段字数随 r̂ 变化：0.88→20、0.95→50、1.03→80（整句装满、不超上限）', () => {
    const text = uniformSpeech(30) // 300 字
    const cases = [
      { rate: 0.88, cap: 20, chars: 20 },
      { rate: 0.95, cap: 53, chars: 50 },
      { rate: 1.03, cap: 80, chars: 80 },
    ]
    for (const row of cases) {
      const plan = planNextSegment(buildSpeechUnits(text), { first: true, rate: row.rate })
      expect(plan).not.toBeNull()
      expect(plan!.cap).toBe(row.cap)
      expect(plan!.chars).toBe(row.chars)
      expect(plan!.chars).toBeLessThanOrEqual(plan!.cap)
      expect(plan!.text).toBe(text.slice(0, row.chars))
      expect(plan!.rate).toBeCloseTo(row.rate, 5)
    }
  })

  it('r̂≥1 没有取舍：首段直接取 FIRST_MAX', () => {
    const plan = planNextSegment(buildSpeechUnits(uniformSpeech(30)), { first: true, rate: 1.05 })!
    expect(plan.cap).toBe(TTS_FIRST_MAX_CHARS)
    expect(plan.chars).toBe(TTS_FIRST_MAX_CHARS)
  })

  it('第一句超上限时在逗号处切，仍然只装一句', () => {
    const sentence = `${'甲乙丙丁戊己庚辛壬癸，'.repeat(3)}` // 33 字、每 11 字一个逗号
    const plan = planNextSegment([{ text: sentence, paragraphEnd: true }], {
      first: true,
      rate: 0.88,
    })!
    expect(plan.cap).toBe(20)
    expect(plan.chars).toBe(11)
    expect(plan.text.endsWith('，')).toBe(true)
    expect(plan.units).toBe(1)
    expect(`${plan.text}${plan.rest[0]!.text}`).toBe(sentence)
  })

  it('首句很短（<FIRST_MIN）且装得下第二句时继续装', () => {
    const text = `好。${'一二三四五六七八九十一二。'}` // 2 + 13 字
    const units = buildSpeechUnits(text)
    expect(units).toHaveLength(2)
    const plan = planNextSegment(units, { first: true, rate: 0.88 })!
    expect(plan.units).toBe(2)
    expect(plan.chars).toBe(15)
    expect(plan.text).toBe(text)
  })

  it('服务端 maxChars 小于 FIRST_MAX 时首段上限被压低', () => {
    const plan = planNextSegment(buildSpeechUnits(uniformSpeech(30)), {
      first: true,
      rate: 1.03,
      serverMaxChars: 50,
    })!
    expect(plan.cap).toBe(50)
    expect(plan.chars).toBeLessThanOrEqual(50)
  })
})

describe('自适应切段：后续段', () => {
  it('后续段字数随 r 变化：0.88/0.95→60 左右、1.03→200', () => {
    const text = uniformSpeech(40) // 400 字
    const cases = [
      { rate: 0.88, cap: 60, chars: 60 },
      { rate: 0.95, cap: 63, chars: 60 },
      { rate: 1.03, cap: 200, chars: 200 },
    ]
    for (const row of cases) {
      const plan = planNextSegment(buildSpeechUnits(text), { first: false, rate: row.rate })!
      expect(plan.cap).toBe(row.cap)
      expect(plan.chars).toBe(row.chars)
      expect(plan.units).toBe(row.chars / 10)
      expect(plan.rest).toHaveLength(40 - plan.units)
    }
  })

  it('段落边界延伸：r=0.95 装到 100 字的段落边界；r=0.9 段落预算也只有 60，不延伸', () => {
    const text = `${uniformSpeech(10)}\n${uniformSpeech(5)}` // 第一段 100 字，第二段 50 字
    const tight = planNextSegment(buildSpeechUnits(text), { first: false, rate: 0.95 })!
    // cap 63 停在段落中间，下一个段落边界 100 字仍在 GAP_PARAGRAPH（≈106）预算内
    expect(tight.cap).toBe(63)
    expect(tight.chars).toBe(100)
    expect(tight.paragraphEnd).toBe(true)
    expect(tight.rest).toHaveLength(5)

    const slow = planNextSegment(buildSpeechUnits(text), { first: false, rate: 0.9 })!
    expect(slow.cap).toBe(60)
    expect(slow.chars).toBe(60)
    expect(slow.paragraphEnd).toBe(false)
    expect(slow.rest).toHaveLength(9)
  })

  it('收尾合并：剩余 ≤ min(策略上限, 上限×1.25) 时一次装完', () => {
    // r=0.95 时 cap=63、阈值 min(200, 78.75)=78
    const merge = planNextSegment(buildSpeechUnits(uniformSpeech(7)), { first: false, rate: 0.95 })!
    expect(merge.cap).toBe(63)
    expect(merge.chars).toBe(70)
    expect(merge.rest).toHaveLength(0)
    // 一个 120 字的段落：下一个段落边界在 120 字，超过 GAP_PARAGRAPH 的 106 字预算，不延伸
    const noMerge = planNextSegment(buildSpeechUnits(uniformSpeech(12)), { first: false, rate: 0.95 })!
    expect(noMerge.chars).toBe(60)
    expect(noMerge.paragraphEnd).toBe(false)
    expect(noMerge.rest.length).toBeGreaterThan(0)
  })

  it('收尾合并受段落停顿预算约束：r=0.9 时 70 字的尾巴不合并（60 + 10）', () => {
    // r=0.9 时 cap=60、×1.25=75，但 70 字的段自己的预缓冲会把缝拉到 ~1.4s（> GAP_PARAGRAPH）
    const plan = planNextSegment(buildSpeechUnits(uniformSpeech(7)), { first: false, rate: 0.9 })!
    expect(plan.chars).toBe(60)
    expect(plan.rest).toHaveLength(1)
    const rest = planNextSegment(plan.rest, { first: false, rate: 0.9 })!
    expect(rest.chars).toBe(10)
    expect(rest.rest).toHaveLength(0)
  })

  it('单句超上限时在逗号处切，不超过 cap', () => {
    const sentence = '一二三四五六七八九十一二三四，'.repeat(10) // 150 字、每 15 字一个逗号
    const plan = planNextSegment([{ text: sentence, paragraphEnd: false }], {
      first: false,
      rate: 0.9,
    })!
    expect(plan.cap).toBe(60)
    expect(plan.chars).toBe(60)
    expect(plan.text.endsWith('，')).toBe(true)
    expect(plan.rest).toHaveLength(1)
    expect(`${plan.text}${plan.rest[0]!.text}`).toBe(sentence)
  })

  it('服务端 maxChars=120 时后续段上限被压到 120（Hub 的 200 不会被超过）', () => {
    const text = uniformSpeech(30) // 300 字
    const plan = planNextSegment(buildSpeechUnits(text), {
      first: false,
      rate: 1.03,
      serverMaxChars: 120,
    })!
    expect(plan.cap).toBe(120)
    expect(plan.chars).toBe(120)
    expect(plan.rest).toHaveLength(18)
  })

  it('planSegmentCount 与逐次规划一致：500 字在 r=1.03 下只要 4 段', () => {
    const text = uniformSpeech(50)
    const units = buildSpeechUnits(text)
    const count = planSegmentCount(units, { first: true, rate: 1.03 })
    expect(count).toBe(4)
    // 逐次跑一遍，拼回来要不丢字
    let rest = units
    let joined = ''
    let index = 0
    while (rest.length > 0) {
      const plan = planNextSegment(rest, { first: index === 0, rate: 1.03 })!
      joined += plan.text
      rest = plan.rest
      index += 1
    }
    expect(joined).toBe(text)
    expect(index).toBe(count)
  })
})

/* ---------- 速率持久化 ---------- */

function memoryRateStorage(): TtsRateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

describe('速率持久化：EWMA α=0.5、钳在 RATE_MIN–MAX', () => {
  it('首次直接用测量值；之后按 α=0.5 合并并钳位', () => {
    expect(blendTtsRate(undefined, 0.93)).toBeCloseTo(0.93, 5)
    expect(blendTtsRate(0.9, 1.05)).toBeCloseTo(0.9 * 0.5 + 1.05 * 0.5, 5)
    expect(blendTtsRate(null, 2)).toBe(TTS_RATE_MAX)
    expect(clampTtsRate(0.1)).toBe(TTS_RATE_MIN)
    expect(clampTtsRate(5)).toBe(TTS_RATE_MAX)
    expect(clampTtsRate(Number.NaN)).toBe(TTS_ASSUMED_RATE)
  })

  it('read/persist 往返：写 {rate}，第二次与上次做 EWMA', () => {
    const storage = memoryRateStorage()
    expect(readPersistedTtsRate(storage)).toBeUndefined()
    expect(persistTtsRate(0.9, storage)).toBeCloseTo(0.9, 5)
    const raw: unknown = JSON.parse(storage.values.get(TTS_RATE_STORAGE_KEY) ?? '{}')
    expect((raw as { rate?: number }).rate).toBeCloseTo(0.9, 3)
    expect(readPersistedTtsRate(storage)).toBeCloseTo(0.9, 3)
    expect(persistTtsRate(1.04, storage)).toBeCloseTo(0.97, 5)
    expect(readPersistedTtsRate(storage)).toBeCloseTo(0.97, 3)
  })

  it('坏数据/存储不可用：读回 undefined，写入不抛错', () => {
    const storage = memoryRateStorage()
    storage.values.set(TTS_RATE_STORAGE_KEY, '{oops')
    expect(readPersistedTtsRate(storage)).toBeUndefined()
    const broken: TtsRateStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readPersistedTtsRate(broken)).toBeUndefined()
    expect(persistTtsRate(0.9, broken)).toBeCloseTo(0.9, 5)
  })
})

/* ---------- 缓冲公式 ---------- */

describe('自适应抖动缓冲', () => {
  it('速率先保守、攒够 0.5 秒后才按实测算', () => {
    expect(estimateStreamRate({ receivedSeconds: 0.2, elapsedMs: 5_000 })).toBe(TTS_ASSUMED_RATE)
    expect(estimateStreamRate({ receivedSeconds: 0.9, elapsedMs: 1_000 })).toBeCloseTo(0.9, 5)
    // 防御：离谱的测量值被钳住
    expect(estimateStreamRate({ receivedSeconds: 10, elapsedMs: 1_000 })).toBeLessThanOrEqual(1.2)
  })

  it('r=0.9 的长段需要更多的起始缓冲；短段/快段只保底 0.8 秒', () => {
    const short = streamBufferSeconds(20, 0.9)
    expect(short).toBeCloseTo(0.8, 5)
    const long = streamBufferSeconds(120, 0.9)
    expect(long).toBeGreaterThan(2.5)
    expect(long).toBeCloseTo((120 / 5.6) * (1 / 0.9 - 1) + 0.3, 5)
    const fast = streamBufferSeconds(120, 1.05)
    expect(fast).toBeCloseTo(0.8, 5)
  })
})

/* ---------- 整形器：静音、增益、段尾 ---------- */

describe('SegmentShaper：首尾静音、增益、段尾停顿', () => {
  function tone(seconds: number, amplitude = 0.25): Float32Array {
    const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE))
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * amplitude
    }
    return samples
  }

  function silence(seconds: number): Float32Array {
    return new Float32Array(Math.round(seconds * SAMPLE_RATE))
  }

  it('开头静音被裁掉，只保留 30ms', () => {
    const input = new Float32Array([...silence(0.5), ...tone(0.6)])
    const trimmed = trimLeadingSilence(input, SAMPLE_RATE)
    expect(trimmed.length).toBeLessThan(input.length)
    // 开头 30ms 余量 + 0.6 秒有声
    expect(trimmed.length / SAMPLE_RATE).toBeCloseTo(0.63, 2)
  })

  it('段尾静音被裁掉，只保留 30ms', () => {
    const input = new Float32Array([...tone(0.6), ...silence(0.8)])
    const trimmed = trimTrailingSilence(input, SAMPLE_RATE)
    expect(trimmed.length).toBeLessThan(input.length)
    expect(trimmed.length / SAMPLE_RATE).toBeCloseTo(0.63, 2)
  })

  it('段尾留存 0.5 秒：push 不会立刻把最后一截排出去，finish 才裁尾 + 补 220ms', () => {
    const shaper = new SegmentShaper({ sampleRate: SAMPLE_RATE })
    shaper.begin()
    const blocks = shaper.push(tone(1.2))
    const scheduledSec = blocks.reduce((sum, block) => sum + block.samples.length / SAMPLE_RATE, 0)
    // 1.2 秒音频：留 0.5 秒尾巴 + 块余数（150ms 一块）
    expect(scheduledSec).toBeGreaterThan(0.3)
    expect(scheduledSec).toBeLessThanOrEqual(0.7)
    const tailBlocks = shaper.finish()
    const tailSec = tailBlocks.reduce((sum, block) => sum + block.samples.length / SAMPLE_RATE, 0)
    expect(tailSec).toBeGreaterThan(0.4)
    // 最后一块是 220ms 的停顿
    const last = tailBlocks[tailBlocks.length - 1]!
    expect(last.samples.length / SAMPLE_RATE).toBeCloseTo(TTS_TAIL_PAUSE_MS / 1_000, 3)
    expect(last.samples.every((value) => value === 0)).toBe(true)
  })

  const peakOf = (blocks: Array<{ samples: Float32Array }>): number =>
    Math.max(
      ...blocks.map((block) =>
        block.samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
      ),
    )

  it('音量小的段被放大；本来就响的段被压小（0.5–4 倍）', () => {
    const quiet = new SegmentShaper({ sampleRate: SAMPLE_RATE })
    quiet.begin()
    quiet.push(tone(1.0, 0.05))
    const quietBlocks = quiet.finish()
    expect(quiet.gainValue).toBeGreaterThan(1.5)
    expect(quiet.gainValue).toBeLessThanOrEqual(4)
    expect(peakOf(quietBlocks)).toBeGreaterThan(0.05)

    const loud = new SegmentShaper({ sampleRate: SAMPLE_RATE })
    loud.begin()
    loud.push(tone(1.0, 0.9))
    const loudBlocks = loud.finish()
    expect(loud.gainValue).toBeCloseTo(0.5, 5)
    expect(peakOf(loudBlocks)).toBeLessThanOrEqual(0.95 + 1e-6)
  })

  it('增益只降不升：尖峰把增益压下来之后，后面的块不会把它升回去', () => {
    const samples = tone(0.5, 0.05)
    samples[100] = 1 // 一个尖峰（字头发音/爆音）
    const shaper = new SegmentShaper({ sampleRate: SAMPLE_RATE })
    shaper.begin()
    const blocks = [...shaper.push(samples), ...shaper.finish()]
    const audio = blocks.filter((block) => !block.samples.every((value) => value === 0))
    expect(peakOf(audio)).toBeLessThanOrEqual(TTS_PEAK_LIMIT + 1e-6)
    expect(shaper.gainValue).toBeLessThan(1)
    // 尖峰之后的块用的是降下来的增益（0.05 × gain），不是被重新放大
    const lastAudio = audio[audio.length - 1]!
    const lastPeak = lastAudio.samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    expect(lastPeak).toBeLessThan(0.06)
  })

  it('estimateSpeechGain：目标 -20 dBFS，钳在 0.5–4', () => {
    // 幅度 0.05 的正弦 ≈ -29 dBFS（刚好算「有声」）→ 约 2.8 倍
    expect(estimateSpeechGain(tone(0.5, 0.05), SAMPLE_RATE)).toBeCloseTo(2.82, 1)
    expect(estimateSpeechGain(tone(0.5, 0.9), SAMPLE_RATE)).toBeCloseTo(0.5, 5)
    // 整段都是静音（低于 -45 dBFS 的帧）→ 不放大底噪
    expect(estimateSpeechGain(new Float32Array(SAMPLE_RATE / 2), SAMPLE_RATE)).toBe(1)
  })

  it('块长 ~150ms（100–200ms 契约）', () => {
    const shaper = new SegmentShaper({ sampleRate: SAMPLE_RATE })
    shaper.begin()
    const blocks = shaper.push(tone(2.0))
    expect(blocks.length).toBeGreaterThan(3)
    for (const block of blocks) {
      expect(block.samples.length / SAMPLE_RATE).toBeCloseTo(TTS_BLOCK_MS / 1_000, 3)
    }
  })
})

/* ---------- 播放器 ---------- */

describe('TtsStreamPlayer：边收边播', () => {
  it('首段按自适应缓冲等够才排程，之后时间轴首尾相接', async () => {
    const h = makeHarness({ script: { rate: 0.9, chunkMs: 200, firstChunkMs: 200 } })
    // 40 字一句：0.4.7 首段按 r̂=0.88 切 20 字 + 收尾合并 20 字，时间轴应当连续
    await h.player.start({ key: 'm1', text: '一二三四五六七八九十'.repeat(4), voice: 'seki' })
    expect(h.sink.blocks.length).toBeGreaterThan(2)
    expect(h.sink.contiguous()).toBe(true)
    // 第一块不能排得太早：至少攒到了下限 0.8 秒（20/5.6≈3.6 秒的段其实要 0.8 秒）
    const firstWhen = h.sink.blocks[0]!.when
    expect(firstWhen).toBeGreaterThanOrEqual(0.75)
    expect(h.diags.some(([name]) => name === 'tts:ttfa')).toBe(true)
    const ttfa = Number(/ms=(\d+)/.exec(h.diags.find(([name]) => name === 'tts:ttfa')![1])![1])
    expect(ttfa).toBeGreaterThan(0)
  })

  it('r=0.9 的长段：段内不会有空洞（排程连续、无 underrun）', async () => {
    // 两句不同的话（避免后半段命中前半段的段缓存）：20 字 + 32 字
    const text = `${'一二三四五六七八九十'.repeat(2)}。${'甲乙丙丁戊己庚辛壬癸'.repeat(2)}。`
    const h = makeHarness({
      script: { rate: 0.9, chunkMs: 200, firstChunkMs: 200, msPerChar: 180 },
      maxChars: 120,
    })
    await h.player.start({ key: 'm1', text, voice: 'seki' })
    // 首段 20 字（r̂=0.88 的上限）+ 尾段 32 字（收尾合并）→ 2 次请求
    expect(h.hub.calls).toHaveLength(2)
    // 段内必须无缝；段间允许等缓冲（r=0.9 时这是计划内的停顿）
    expect(h.sink.contiguousWithinSegments()).toBe(true)
    expect(h.diags.some(([name]) => name === 'tts:underrun')).toBe(false)
    // 段内音频在 1 倍速播放、下载只有 0.9 倍速：没有缓冲到段尾必断
    const played = h.sink.blocks.reduce((sum, block) => sum + block.duration, 0)
    expect(played).toBeGreaterThan(7)
  })

  it('多段之间允许等缓冲：空洞只出现在段边界（220ms 停顿之后）', async () => {
    const text = Array.from({ length: 3 }, (_, index) => `${'内容'.repeat(20)}${index}。`).join('')
    const h = makeHarness({
      script: { rate: 0.9, chunkMs: 200, firstChunkMs: 200, msPerChar: 180 },
      maxChars: 120,
    })
    await h.player.start({ key: 'm1', text, voice: 'seki' })
    expect(h.hub.calls.length).toBeGreaterThan(1)
    expect(h.diags.some(([name]) => name === 'tts:underrun')).toBe(false)
    const blocks = h.sink.blocks
    for (let i = 1; i < blocks.length; i += 1) {
      const gap = blocks[i]!.when - (blocks[i - 1]!.when + blocks[i - 1]!.duration)
      if (Math.abs(gap) <= 0.03) continue
      // 允许的只有段边界：前一块是 220ms 的段尾停顿
      expect(blocks[i - 1]!.duration).toBeCloseTo(TTS_TAIL_PAUSE_MS / 1_000, 3)
    }
  })

  it('下载完成就请求下一段（不是播放完成），并发 ≤ 1', async () => {
    const text = Array.from({ length: 3 }, (_, index) => `${'内容'.repeat(20)}${index}。`).join('')
    const h = makeHarness({ script: { rate: 1, chunkMs: 200, firstChunkMs: 100 }, maxChars: 60 })
    await h.player.start({ key: 'm1', text, voice: 'seki' })
    expect(h.hub.calls.length).toBeGreaterThan(1)
    expect(h.hub.maxInflight).toBe(1)
    // 段数与逐段规划（首段用 r̂=0.88、后续用实测 r≈1）一致
    const expected = planSegmentCount(buildSpeechUnits(text), {
      first: true,
      rate: TTS_ASSUMED_RATE,
      serverMaxChars: 60,
    })
    expect(h.hub.calls.length).toBe(expected)
  })

  it('缓冲耗尽（网络抖动）→ 记 tts:underrun，再攒够后继续', async () => {
    const text = `${'一二三四五六七八九十'.repeat(3)}。`
    const h = makeHarness({
      script: { rate: 1, chunkMs: 200, firstChunkMs: 0, stallAfterChunks: 4, stallMs: 5_000 },
      startBufferSec: 0.8,
    })
    await h.player.start({ key: 'm1', text, voice: 'seki' })
    expect(h.diags.some(([name]) => name === 'tts:underrun')).toBe(true)
    expect(h.sink.contiguous()).toBe(false)
    expect(h.snapshots.at(-1)?.phase).toBe('idle')
  })

  it('中途中断（stream-interrupted）→ 轻提示 + 回空闲', async () => {
    const text = `${'一二三四五六七八九十'.repeat(6)}。`
    const h = makeHarness({
      script: { rate: 1, chunkMs: 200, firstChunkMs: 0, interruptAfterChunks: 3 },
    })
    await h.player.start({ key: 'm1', text, voice: 'seki' })
    expect(h.notices).toContain('朗读暂时不可用')
    expect(h.snapshots.at(-1)?.phase).toBe('idle')
    expect(h.diags.some(([, detail]) => detail.includes('code=stream-interrupted'))).toBe(true)
  })

  it('开始前 502 → 提示并回空闲（不排任何音频）', async () => {
    const h = makeHarness({
      script: {
        failOnCall: (index) =>
          index === 0 ? new HubApiError('UPSTREAM_ERROR', { status: 502 }) : undefined,
      },
    })
    await h.player.start({ key: 'm1', text: SHORT_TEXT })
    expect(h.sink.blocks).toHaveLength(0)
    expect(h.notices).toContain('朗读暂时不可用')
    expect(h.snapshots.at(-1)?.phase).toBe('idle')
  })

  it('429 按 retryAfterSec 重试一次后成功', async () => {
    const h = makeHarness({
      script: {
        failOnCall: (index) =>
          index === 0
            ? new HubApiError('RATE_LIMITED', { status: 429, retryAfterSec: 2 })
            : undefined,
      },
    })
    await h.player.start({ key: 'm1', text: SHORT_TEXT })
    // SHORT_TEXT 被切成两段：第 1 段 429 → 重试成功，第 2 段正常 → 一共 3 次请求
    expect(h.hub.calls).toHaveLength(3)
    expect(h.sink.blocks.length).toBeGreaterThan(0)
    expect(h.notices).toHaveLength(0)
  })

  it('停止：立刻静音、迟到的数据不再排程、只记一次 tts:stop', async () => {
    // 首块之后立刻「断流」（等一个到不了的 1000 秒）：播放不会自然结束，才能验证停止
    const h = makeHarness({
      script: { rate: 1, chunkMs: 200, firstChunkMs: 0, stallAfterChunks: 12, stallMs: 1_000_000 },
    })
    const run = h.player.start({ key: 'm1', text: SHORT_TEXT })
    for (let i = 0; i < 200 && h.sink.blocks.length === 0; i += 1) await h.time.sleep(50)
    expect(h.sink.blocks.length).toBeGreaterThan(0)
    const before = h.sink.blocks.length
    h.player.stop('user')
    await run
    await h.time.sleep(2_000)
    expect(h.sink.blocks.length).toBe(before)
    expect(h.sink.stops).toBeGreaterThan(0)
    expect(h.player.busy).toBe(false)
    expect(h.diags.some(([name, detail]) => name === 'tts:stop' && detail === 'reason=user')).toBe(true)
  })

  it('自然读完：推 idle 快照，按钮能回到「朗读」', async () => {
    const h = makeHarness({ script: { rate: 1, chunkMs: 200, firstChunkMs: 100 } })
    await h.player.start({ key: 'm1', text: SHORT_TEXT, voice: 'seki' })
    const last = h.snapshots.at(-1)
    expect(last?.phase).toBe('idle')
    expect(h.player.busy).toBe(false)
    expect(h.diags.some(([name, detail]) => name === 'tts:stop' && detail === 'reason=done')).toBe(true)
    expect(h.sink.contiguous()).toBe(true)
  })

  it('缓存命中：同一段文字第二次不再请求，直接排程', async () => {
    const cache = new TtsPcmCache()
    const first = makeHarness({ script: { rate: 1, firstChunkMs: 0 }, cache })
    await first.player.start({ key: 'm1', text: SHORT_TEXT, voice: 'seki' })
    const requestsAfterFirst = first.hub.calls.length
    expect(requestsAfterFirst).toBeGreaterThan(0)

    const second = makeHarness({ script: { rate: 1, firstChunkMs: 0 }, cache })
    await second.player.start({ key: 'm2', text: SHORT_TEXT, voice: 'seki' })
    expect(second.hub.calls).toHaveLength(0)
    expect(second.sink.blocks.length).toBeGreaterThan(0)
    expect(second.diags.some(([, detail]) => detail.includes('cached=1'))).toBe(true)
  })

  it('换音色不会命中别人的缓存', async () => {
    const cache = new TtsPcmCache()
    const first = makeHarness({ script: { rate: 1, firstChunkMs: 0 }, cache })
    await first.player.start({ key: 'm1', text: SHORT_TEXT, voice: 'seki' })
    const second = makeHarness({ script: { rate: 1, firstChunkMs: 0 }, cache })
    await second.player.start({ key: 'm2', text: SHORT_TEXT, voice: 'other' })
    // 换了音色就不该命中：每一段都重新请求
    expect(second.hub.calls.length).toBeGreaterThan(0)
    expect(second.hub.calls.every((call) => call.voice === 'other')).toBe(true)
  })

  it('PCM 跨块奇数字节：拼出来的样本数与字节数都不丢', async () => {
    const text = `${'一二三四五六七八九十'.repeat(2)}。`
    const pcm = pcmFor(Array.from(text).length)
    const oddChunks: Uint8Array[] = []
    for (let offset = 0; offset < pcm.byteLength; offset += 3) {
      oddChunks.push(pcm.slice(offset, offset + 3))
    }
    const h = makeHarness({ script: { rate: 1, firstChunkMs: 0 } })
    h.hub.synthesizeStream = async () => ({
      sampleRate: SAMPLE_RATE,
      voice: 'seki',
      cached: false,
      chunks: (async function* () {
        for (const chunk of oddChunks) yield chunk
      })(),
    })
    await h.player.start({ key: 'm1', text })
    const samples = h.sink.blocks.reduce((sum, block) => sum + block.samples.length, 0)
    // 整形器会裁掉首尾一点点静音、补 220ms：这里只要「没有大面积丢样本」
    const receivedSec = pcm.byteLength / 2 / SAMPLE_RATE
    expect(samples / SAMPLE_RATE).toBeGreaterThan(receivedSec - 0.2)
  })

  it('诊断只记数字：tts:stream 记段数/字数，不记文字', async () => {
    const h = makeHarness({ script: { rate: 1, firstChunkMs: 0 } })
    await h.player.start({ key: 'm1', text: SHORT_TEXT, voice: 'seki' })
    const streamDiag = h.diags.find(([name]) => name === 'tts:stream')
    expect(streamDiag).toBeDefined()
    expect(streamDiag![1]).toMatch(/^segments=\d+ chars=\d+$/)
    for (const [, detail] of h.diags) {
      expect(detail).not.toContain('一二三')
      expect(detail).not.toContain('甲乙丙')
    }
  })

  it('每段记一条 tts:plan：序号/字数/上限/规划 r/实测 r/段间等待，且不记文字', async () => {
    const h = makeHarness({
      script: { rate: 0.9, chunkMs: 200, firstChunkMs: 100, msPerChar: 120 },
    })
    await h.player.start({ key: 'm1', text: uniformSpeech(12), voice: 'seki' })
    const plans = h.diags.filter(([name]) => name === 'tts:plan')
    // 20 + 60 + 40 字：三段，每段一条
    expect(plans).toHaveLength(3)
    expect(plans[0]![1]).toMatch(/^index=1 chars=20 cap=20 rate=0\.88 measured=\d\.\d\d waitMs=0$/)
    // 假时钟按 20ms 步进，实测值会比 0.9 略低，只断言量级正确
    const measured = Number(/measured=(\d\.\d\d)/.exec(plans[0]![1])![1])
    expect(measured).toBeGreaterThan(0.7)
    expect(measured).toBeLessThanOrEqual(1)
    for (let index = 0; index < plans.length; index += 1) {
      const detail = plans[index]![1]
      expect(detail).toMatch(
        /^index=\d+ chars=\d+ cap=\d+ rate=\d\.\d\d measured=(na|\d\.\d\d) waitMs=\d+$/,
      )
      expect(detail.startsWith(`index=${index + 1} `)).toBe(true)
      expect(detail).not.toContain('一')
    }
  })

  it('读完后把实测 r 存下来；首段按持久化的 r̂ 规划', async () => {
    const saved: number[] = []
    const h = makeHarness({
      script: { rate: 1, chunkMs: 200, firstChunkMs: 100 },
      loadRate: () => 1.03,
      saveRate: (rate) => {
        saved.push(rate)
        return rate
      },
    })
    await h.player.start({ key: 'm1', text: uniformSpeech(30), voice: 'seki' })
    const plans = h.diags.filter(([name]) => name === 'tts:plan')
    // r̂=1.03 ≥ 1：首段直接取 FIRST_MAX=80，而不是 0.88 时的 20
    expect(plans[0]![1]).toMatch(/^index=1 chars=80 cap=80 rate=1\.03 /)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toBeGreaterThan(0.9)
    expect(saved[0]).toBeLessThanOrEqual(1.1)
    expect(h.diags.some(([name]) => name === 'tts:rate')).toBe(true)
  })

  it('中途停止也把已测到的 r 存下来（只要够 0.5 秒音频）', async () => {
    const saved: number[] = []
    const h = makeHarness({
      script: { rate: 0.9, chunkMs: 200, firstChunkMs: 0, stallAfterChunks: 12, stallMs: 1_000_000 },
      loadRate: () => undefined,
      saveRate: (rate) => {
        saved.push(rate)
        return rate
      },
    })
    const run = h.player.start({ key: 'm1', text: uniformSpeech(30), voice: 'seki' })
    for (let i = 0; i < 200 && h.sink.blocks.length === 0; i += 1) await h.time.sleep(50)
    h.player.stop('user')
    await run
    expect(saved).toHaveLength(1)
    // 假时钟按 20ms 步进，实测值会偏低一点；只要在 0.5–1.2 的合理区间内
    expect(saved[0]).toBeGreaterThan(0.6)
    expect(saved[0]).toBeLessThanOrEqual(1.1)
  })
})
