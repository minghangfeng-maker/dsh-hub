/**
 * 0.4.3 朗读播放器：边播边合成、预取、并发上限、停止丢弃、缓存、429 重试、502 停止。
 *
 * 合成与音频出口都是注入的假件，时间是同步推进的；真音频解码由 e2e 覆盖
 * （scripts/e2e-tts.mjs 在 Chrome 里跑真的 Web Audio）。
 */

import { describe, expect, it, vi } from 'vitest'
import { HubApiError } from '@dsh-hub/mobile-core'
import {
  TTS_CACHE_BYTES,
  TTS_RETRY_MAX_SEC,
  TTS_TEXT,
  TtsClipCache,
  TtsPlayer,
  ttsErrorCode,
  ttsRetryDelayMs,
  type TtsSnapshot,
} from '@/lib/tts-player'
import type { TtsClip, TtsSink } from '@/lib/tts-audio'

/* ---------- 假件 ---------- */

/** 假音频出口：记录 prepare/play 顺序，播放由测试手动结束。 */
class FakeSink implements TtsSink {
  prepared: TtsClip[] = []
  played: TtsClip[] = []
  stopped = 0
  disposed = 0
  private pending: Array<() => void> = []

  async prepare(clip: TtsClip): Promise<void> {
    this.prepared.push(clip)
  }

  play(clip: TtsClip): Promise<void> {
    this.played.push(clip)
    return new Promise<void>((resolve) => this.pending.push(resolve))
  }

  stop(): void {
    this.stopped += 1
    const pending = this.pending
    this.pending = []
    for (const resolve of pending) resolve()
  }

  dispose(): void {
    this.disposed += 1
  }

  /** 结束当前这一段（模拟「播完了」）。 */
  finishOne(): void {
    const resolve = this.pending.shift()
    resolve?.()
  }
}

interface Request {
  text: string
  voice: string | undefined
  resolve: (clip: TtsClip) => void
  reject: (error: unknown) => void
}

function clipFor(text: string, bytes = 1_024): TtsClip {
  const wav = new Uint8Array(bytes)
  wav[0] = text.length % 256
  return { wav, sampleRate: 24_000, voice: 'seki' }
}

/** 一组确定可切的句子（minChars=0 时一句一段）。 */
const SENTENCES = [
  '第一句讲的是登录流程。',
  '第二句讲的是唤醒实例。',
  '第三句讲的是通道连接。',
  '第四句讲的是消息发送。',
  '第五句讲的是断线续传。',
]
const TEXT = SENTENCES.join('')

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Harness {
  player: TtsPlayer
  sink: FakeSink
  requests: Request[]
  snapshots: TtsSnapshot[]
  diags: Array<[string, string]>
  notices: string[]
  sleeps: number[]
  maxInflight: number
  /** 等待第 n 个请求出现（默认全部）。 */
  waitForRequests: (count: number) => Promise<void>
}

function makeHarness(options: {
  synthesize?: (text: string, voice?: string) => Promise<TtsClip>
  maxChars?: number
  cache?: TtsClipCache
  cacheBytes?: number
} = {}): Harness {
  const sink = new FakeSink()
  const requests: Request[] = []
  const snapshots: TtsSnapshot[] = []
  const diags: Array<[string, string]> = []
  const notices: string[] = []
  const sleeps: number[] = []
  let inflight = 0
  let maxInflight = 0

  const synthesize = (text: string, voice?: string): Promise<TtsClip> => {
    if (options.synthesize) return options.synthesize(text, voice)
    return new Promise<TtsClip>((resolve, reject) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      requests.push({
        text,
        voice,
        resolve: (clip) => {
          inflight -= 1
          resolve(clip)
        },
        reject: (error) => {
          inflight -= 1
          reject(error)
        },
      })
    })
  }

  const player = new TtsPlayer({
    synthesize,
    sink: () => sink,
    maxChars: options.maxChars ?? 200,
    minChars: 0,
    cache: options.cache ?? new TtsClipCache(options.cacheBytes ?? TTS_CACHE_BYTES),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    now: () => 0,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDiag: (name, detail) => diags.push([name, detail ?? '']),
    onNotice: (text) => notices.push(text),
  })

  return {
    player,
    sink,
    requests,
    snapshots,
    diags,
    notices,
    sleeps,
    get maxInflight() {
      return maxInflight
    },
    async waitForRequests(count: number) {
      for (let i = 0; i < 50 && requests.length < count; i += 1) await flush()
    },
  }
}

/* ---------- 用例 ---------- */

describe('TtsPlayer：边播边合成', () => {
  it('先请求第 1 段（loading），播第 1 段时预取第 2、3 段', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: TEXT, voice: 'seki' })

    await h.waitForRequests(1)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.text).toBe(SENTENCES[0])
    expect(h.requests[0]!.voice).toBe('seki')
    expect(h.player.snapshot.phase).toBe('loading')
    expect(h.player.snapshot.segment).toBe(0)

    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()
    // 第 1 段开始播；第 2、3 段已经发出请求（预取窗口 2）
    expect(h.sink.played).toHaveLength(1)
    expect(h.requests.map((r) => r.text)).toEqual([SENTENCES[0], SENTENCES[1], SENTENCES[2]])
    expect(h.player.snapshot.phase).toBe('playing')
    expect(h.player.snapshot.segment).toBe(1)
    expect(h.player.snapshot.total).toBe(5)
    expect(h.maxInflight).toBeLessThanOrEqual(2)
  })

  it('播完一段就接下一段，整条读完回到 idle（reason=done）', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: TEXT })

    for (let index = 0; index < SENTENCES.length; index += 1) {
      await h.waitForRequests(index + 1)
      // 每段都在「轮到它」之前就请求好了（首段之后不再等待合成）
      expect(h.requests[index]!.text).toBe(SENTENCES[index])
      h.requests[index]!.resolve(clipFor(SENTENCES[index]!))
      await flush()
      expect(h.player.snapshot.segment).toBe(index + 1)
      h.sink.finishOne()
      await flush()
    }

    expect(h.sink.played).toHaveLength(5)
    expect(h.player.snapshot.phase).toBe('idle')
    expect(h.diags.filter(([name]) => name === 'tts:play')).toHaveLength(1)
    expect(h.diags.filter(([name]) => name === 'tts:stop').at(-1)).toEqual([
      'tts:stop',
      'reason=done',
    ])
  })

  it('并发请求不超过 2（预取窗口再大也压住）', async () => {
    const h = makeHarness({ maxChars: 200 })
    void h.player.start({ key: 'm1', text: TEXT })
    await h.waitForRequests(1)
    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()
    // 播第 1 段时 2、3 段在飞
    expect(h.requests).toHaveLength(3)
    expect(h.maxInflight).toBe(2)

    h.sink.finishOne()
    await flush()
    // 第 1 段播完，等第 2 段（已在飞，不新开请求）
    expect(h.requests).toHaveLength(3)
    h.requests[1]!.resolve(clipFor(SENTENCES[1]!))
    await flush()
    expect(h.player.snapshot.segment).toBe(2)
    // 窗口前移：第 4 段补进来，在飞的仍然是第 3、4 段（≤2）
    expect(h.requests).toHaveLength(4)
    expect(h.requests[3]!.text).toBe(SENTENCES[3])
    expect(h.maxInflight).toBe(2)
  })
})

describe('TtsPlayer：停止与切换', () => {
  it('停止后不再播放迟到的段（在飞的响应被丢弃）', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: TEXT })
    await h.waitForRequests(1)
    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()
    expect(h.sink.played).toHaveLength(1)

    h.player.stop('user')
    expect(h.sink.stopped).toBe(1)
    expect(h.player.snapshot.phase).toBe('idle')

    // 迟到的预取段回来：不能播、也不能重新开始
    h.requests[1]!.resolve(clipFor(SENTENCES[1]!))
    h.requests[2]!.resolve(clipFor(SENTENCES[2]!))
    await flush()
    expect(h.sink.played).toHaveLength(1)
    expect(h.player.snapshot.phase).toBe('idle')
    expect(h.diags.at(-1)).toEqual(['tts:stop', 'reason=user'])
  })

  it('开始读另一条：先停上一条（reason=switch），只播新的一条', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: SENTENCES[0]! })
    await h.waitForRequests(1)
    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()
    expect(h.sink.played).toHaveLength(1)
    expect(h.player.isActive('m1')).toBe(true)

    void h.player.start({ key: 'm2', text: SENTENCES[1]! })
    await h.waitForRequests(2)
    expect(h.sink.stopped).toBe(1)
    expect(h.diags.map(([name, detail]) => `${name}:${detail}`)).toContain('tts:stop:reason=switch')
    expect(h.player.snapshot.messageKey).toBe('m2')
    expect(h.player.isActive('m1')).toBe(false)

    h.requests[1]!.resolve(clipFor(SENTENCES[1]!))
    await flush()
    expect(h.sink.played.at(-1)!.wav[0]).toBe(SENTENCES[1]!.length % 256)
    expect(h.player.isActive('m2')).toBe(true)
  })

  it('各种停止原因都进诊断：send / leave / background', async () => {
    for (const reason of ['send', 'leave', 'background'] as const) {
      const h = makeHarness()
      void h.player.start({ key: 'm1', text: SENTENCES[0]! })
      await h.waitForRequests(1)
      h.player.stop(reason)
      expect(h.diags.at(-1)).toEqual(['tts:stop', `reason=${reason}`])
    }
  })

  it('没有可朗读的内容：只提示、不请求', async () => {
    const h = makeHarness()
    await h.player.start({ key: 'm1', text: '🎉🎉' })
    expect(h.notices).toEqual([TTS_TEXT.empty])
    expect(h.requests).toHaveLength(0)
    expect(h.snapshots).toHaveLength(0)
  })

  it('重复 stop() 无害', async () => {
    const h = makeHarness()
    h.player.stop('user')
    h.player.stop('user')
    expect(h.diags).toHaveLength(0)
  })
})

describe('TtsPlayer：缓存', () => {
  it('同一条消息再读一次：命中缓存，不再请求', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: SENTENCES[0]! })
    await h.waitForRequests(1)
    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()
    h.sink.finishOne()
    await flush()

    void h.player.start({ key: 'm1', text: SENTENCES[0]! })
    await flush()
    expect(h.requests).toHaveLength(1) // 没有第二次请求
    expect(h.sink.played).toHaveLength(2)
    expect(h.player.snapshot.phase).toBe('playing')
    // 缓存命中也会记一条 tts:segment（cached=1）
    expect(h.diags.filter(([name, detail]) => name === 'tts:segment' && detail.includes('cached=1'))).toHaveLength(1)
  })

  it('换音色不会串音（缓存 key 含音色）', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: SENTENCES[0]!, voice: 'seki' })
    await h.waitForRequests(1)
    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()
    h.sink.finishOne()
    await flush()

    void h.player.start({ key: 'm1', text: SENTENCES[0]!, voice: 'other' })
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1]!.voice).toBe('other')
  })

  it('TtsClipCache 按字节 LRU 淘汰，超大段不缓存', () => {
    const cache = new TtsClipCache(120)
    const a = clipFor('a', 60)
    const b = clipFor('b', 60)
    const c = clipFor('c', 60)
    cache.set('a', a)
    cache.set('b', b)
    expect(cache.bytes).toBe(120)
    expect(cache.get('a')).toBe(a)
    // 访问过 a 之后，b 是最久没用的：加入 c 时淘汰 b
    cache.set('c', c)
    expect(cache.get('a')).toBe(a)
    expect(cache.get('b')).toBeNull()
    expect(cache.get('c')).toBe(c)
    // 单段就超过上限：不缓存（避免把缓存整个冲掉）
    const huge = clipFor('huge', 200)
    cache.set('huge', huge)
    expect(cache.get('huge')).toBeNull()
    expect(cache.bytes).toBeLessThanOrEqual(120)
    cache.clear()
    expect(cache.bytes).toBe(0)
  })
})

describe('TtsPlayer：错误', () => {
  it('429 按 retryAfterSec 等一次后重试成功', async () => {
    const h = makeHarness({
      synthesize: (() => {
        let calls = 0
        return async (text: string) => {
          calls += 1
          if (calls === 1) {
            throw new HubApiError('RATE_LIMITED', { status: 429, retryAfterSec: 2 })
          }
          return clipFor(text)
        }
      })(),
    })
    void h.player.start({ key: 'm1', text: SENTENCES[0]! })
    await flush()
    await flush()
    expect(h.sleeps).toEqual([2_000])
    expect(h.sink.played).toHaveLength(1)
    expect(h.player.snapshot.phase).toBe('playing')
  })

  it('429 连续两次失败：提示「朗读暂时不可用」并停止', async () => {
    let calls = 0
    const h = makeHarness({
      synthesize: async () => {
        calls += 1
        throw new HubApiError('RATE_LIMITED', { status: 429, retryAfterSec: 1 })
      },
    })
    await h.player.start({ key: 'm1', text: SENTENCES[0]! })
    expect(calls).toBe(2) // 1 次 + 重试 1 次
    expect(h.notices).toEqual([TTS_TEXT.unavailable])
    expect(h.player.snapshot.phase).toBe('idle')
    expect(h.diags.at(-1)).toEqual(['tts:stop', 'reason=error code=RATE_LIMITED'])
  })

  it('502 直接停止并轻提示（不重试、不播半条）', async () => {
    const h = makeHarness({
      synthesize: async () => {
        throw new HubApiError('UPSTREAM_ERROR', { status: 502 })
      },
    })
    await h.player.start({ key: 'm1', text: SENTENCES[0]! })
    expect(h.sink.played).toHaveLength(0)
    expect(h.notices).toEqual([TTS_TEXT.unavailable])
    expect(h.snapshots.map((s) => s.phase)).toContain('error')
    expect(h.player.snapshot.phase).toBe('idle')
  })

  it('网络错误同样按 502 处理（提示 + 停止）', async () => {
    const h = makeHarness({
      synthesize: async () => {
        throw new HubApiError('network', { retryable: true })
      },
    })
    await h.player.start({ key: 'm1', text: SENTENCES[0]! })
    expect(h.notices).toEqual([TTS_TEXT.unavailable])
    expect(h.diags.at(-1)).toEqual(['tts:stop', 'reason=error code=network'])
  })
})

describe('诊断与工具函数', () => {
  it('tts:play 记段数与字数，tts:segment 记字节与错误码，都不含文字', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: SENTENCES[0]! })
    await h.waitForRequests(1)
    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()

    const play = h.diags.find(([name]) => name === 'tts:play')!
    expect(play[1]).toMatch(/^segments=\d+ chars=\d+$/)
    const segments = h.diags.filter(([name]) => name === 'tts:segment')
    expect(segments.length).toBeGreaterThan(0)
    for (const [, detail] of segments) {
      expect(detail).toMatch(/^ms=\d+ bytes=\d+ cached=[01] code=\w+$/)
      expect(detail).not.toContain(SENTENCES[0]!.slice(0, 3))
    }
    for (const [, detail] of h.diags) {
      expect(detail).not.toContain('登录流程')
    }
  })

  it('关闭时释放音频资源并清缓存', async () => {
    const h = makeHarness()
    void h.player.start({ key: 'm1', text: SENTENCES[0]! })
    await h.waitForRequests(1)
    h.player.dispose()
    expect(h.sink.disposed).toBe(1)
    expect(h.player.snapshot.phase).toBe('idle')
  })

  it('ttsErrorCode / ttsRetryDelayMs 的边界', () => {
    expect(ttsErrorCode(new HubApiError('RATE_LIMITED'))).toBe('RATE_LIMITED')
    expect(ttsErrorCode(new Error('boom'))).toBe('network')
    expect(ttsErrorCode(null)).toBe('network')
    expect(ttsRetryDelayMs({ retryAfterSec: 3 })).toBe(3_000)
    expect(ttsRetryDelayMs({ retryAfterSec: 999 })).toBe(TTS_RETRY_MAX_SEC * 1_000)
    expect(ttsRetryDelayMs({})).toBe(1_000)
    expect(ttsRetryDelayMs({ retryAfterSec: -1 })).toBe(1_000)
  })

  it('vi 假定时器下 429 的等待真的走 sleep（不卡死）', async () => {
    vi.useFakeTimers()
    try {
      const sink = new FakeSink()
      let calls = 0
      const player = new TtsPlayer({
        synthesize: async (text) => {
          calls += 1
          if (calls === 1) throw new HubApiError('RATE_LIMITED', { status: 429, retryAfterSec: 5 })
          return clipFor(text)
        },
        sink: () => sink,
        maxChars: 200,
        minChars: 0,
      })
      void player.start({ key: 'm1', text: SENTENCES[0]! })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls).toBe(2)
      expect(sink.played).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('第一段收短（开口要快）', () => {
  it('第一段超过上限时在逗号处切开，后面不动', async () => {
    const { shortenFirstSegment } = await import('../src/lib/tts-player')
    const first = '今晚美股整体小幅上涨，标普五百涨了百分之零点三，纳指表现更强一些，科技股领涨了大盘。'
    const out = shortenFirstSegment([first, '第二段。'], 20)
    expect(out[0]!.length).toBeLessThanOrEqual(20)
    expect(out[0]!.endsWith('，')).toBe(true)
    expect(out.join('')).toBe(first + '第二段。')
    expect(out.at(-1)).toBe('第二段。')
  })

  it('第一段不超限就原样返回', async () => {
    const { shortenFirstSegment } = await import('../src/lib/tts-player')
    const segments = ['你好呀。', '我是星汐。']
    expect(shortenFirstSegment(segments, 40)).toBe(segments)
  })

  it('找不到标点时按上限硬切', async () => {
    const { shortenFirstSegment } = await import('../src/lib/tts-player')
    const out = shortenFirstSegment(['一二三四五六七八九十一二三四五六七八九十'], 10)
    expect(out).toEqual(['一二三四五六七八九十', '一二三四五六七八九十'])
  })
})

describe('TtsPlayer：自然读完', () => {
  it('最后一段播完后推送 idle 快照（按钮不会一直停在「朗读中」）', async () => {
    const h = makeHarness()
    const short = SENTENCES.slice(0, 2).join('')
    const done = h.player.start({ key: 'm-done', text: short, voice: 'seki' })
    await h.waitForRequests(1)
    h.requests[0]!.resolve(clipFor(SENTENCES[0]!))
    await flush()
    await h.waitForRequests(2)
    h.requests[1]!.resolve(clipFor(SENTENCES[1]!))
    for (let i = 0; i < 5; i += 1) await flush()
    h.sink.finishOne()
    for (let i = 0; i < 5; i += 1) await flush()
    h.sink.finishOne()
    await done
    const last = h.snapshots.at(-1)!
    expect(last.phase).toBe('idle')
    expect(last.messageKey).toBe('m-done')
    expect(h.player.snapshot.phase).toBe('idle')
    expect(h.diags.some(([name, detail]) => name === 'tts:stop' && detail === 'reason=done')).toBe(true)
  })
})
