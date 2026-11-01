/**
 * 0.4.6 流式朗读（WP51）：`POST /api/mobile/tts/stream`。
 *
 * 覆盖：
 *  - 请求形状（URL / Bearer / JSON body）与响应头（采样率、音色、cached）；
 *  - **PCM 跨块奇数字节**：网络可能在任意偏移切开样本，拼接后必须与原始字节逐字节相同；
 *  - 开始下发前的错误照中文错误码抛出（400 / 429 带 retryAfterSec / 502）；
 *  - 开始下发后连接被掐断 → `stream-interrupted`（可识别），内容类型不对 → `protocol`；
 *  - `signal` 取消 → `cancelled`（发起前与读流中都算）；
 *  - 401 单飞刷新仍只在**发起前**生效；
 *  - MockHub 的流式实现：裸 PCM、按块下发、首块延迟、中途掐断、老 Hub（stream:false）。
 */

import { describe, expect, it, vi } from 'vitest'
import { HubClient, type FetchLike } from '../src/http/hub-client.js'
import { alignPcm16, concatBytes } from '../src/http/pcm.js'
import { MemoryTokenStore } from '../src/auth/token-store.js'
import { MOBILE, TTS_DEFAULT_SAMPLE_RATE, type AuthTokens } from '../src/contracts/auth-bootstrap.js'
import { MockHub, MOCK_TTS_CAPABILITY, mockStreamRateFromEnv } from '../src/mock/mock-hub.js'
import { encodeTtsPcm } from '../src/mock/tts-wav.js'
import { makeTokens, NOW } from './helpers/tokens.js'

const ORIGIN = 'https://hub.test:8123'
const AT = `Bearer dshm_at_${'a'.repeat(40)}`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一段可以按任意边界切开的 PCM 字节（每 2 字节一个样本，值各不相同）。 */
function pcmBytes(samples = 12): Uint8Array {
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, (i + 1) * 100, true)
  return bytes
}

/** 把一块字节按给定长度切成多块（故意切成奇数长度）。 */
function sliceOdd(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  let offset = 0
  for (const size of sizes) {
    if (offset >= bytes.byteLength) break
    const end = Math.min(bytes.byteLength, offset + size)
    out.push(bytes.slice(offset, end))
    offset = end
  }
  if (offset < bytes.byteLength) out.push(bytes.slice(offset))
  return out
}

function streamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  status = 200,
  contentType = 'audio/L16; rate=24000; channels=1',
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream as unknown as BodyInit, {
    status,
    headers: { 'content-type': contentType, ...headers },
  })
}

/** 先下发两段，然后把连接搞死（模拟 Hub 开始下发后中断）。 */
function interruptedResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      setTimeout(() => controller.error(new Error('connection reset')), 0)
    },
  })
  return new Response(stream as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': 'audio/L16; rate=24000; channels=1' },
  })
}

/** 永远不产出数据的流（用来测分块空闲超时）；`signal` 取消时按 fetch 语义报错。 */
function stalledResponse(signal?: AbortSignal | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        'abort',
        () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      )
    },
    pull() {
      return new Promise<void>(() => {})
    },
  })
  return new Response(stream as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': 'audio/L16; rate=24000; channels=1' },
  })
}

interface Call {
  url: string
  method: string
  auth: string | null
  contentType: string | null
  body: string | null
}

function makeClient(
  handler: (call: Call, init?: RequestInit) => Response | Promise<Response>,
  options: { initial?: AuthTokens | null } = {},
): { client: HubClient; store: MemoryTokenStore; calls: Call[] } {
  const store = new MemoryTokenStore()
  if (options.initial) void store.save(options.initial)
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? null,
      contentType: headers['Content-Type'] ?? null,
      body: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(call)
    return handler(call, init)
  }
  const client = new HubClient({
    origin: ORIGIN,
    tokenStore: store,
    fetchImpl,
    now: () => NOW,
    clientName: 'test',
    clientVersion: '0.4.6',
  })
  return { client, store, calls }
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return concatBytes(parts)
}

describe('alignPcm16：跨块奇数字节', () => {
  it('任意偏移切开后拼接结果与原始字节逐字节相同', async () => {
    const bytes = pcmBytes(10)
    for (const sizes of [[1, 1, 1, 1], [3, 5, 7], [2, 1, 2, 1, 13], [1, 19]]) {
      const parts = sliceOdd(bytes, sizes)
      const merged = await collect(alignPcm16(toAsync(parts)))
      expect(Array.from(merged)).toEqual(Array.from(bytes))
      // 每块都是完整样本（偶数字节）
      for await (const chunk of alignPcm16(toAsync(parts))) {
        expect(chunk.byteLength % 2).toBe(0)
      }
    }
  })

  it('末尾多出的半个样本被丢弃（不是一段完整声音）', async () => {
    const bytes = pcmBytes(3) // 6 字节
    const parts = [bytes.slice(0, 5)] // 5 字节：最后一个样本只有一半
    const merged = await collect(alignPcm16(toAsync(parts)))
    expect(merged.byteLength).toBe(4)
    expect(Array.from(merged)).toEqual(Array.from(bytes.slice(0, 4)))
  })

  it('空块被跳过，不会打断跨块拼接', async () => {
    const bytes = pcmBytes(4)
    const parts = [bytes.slice(0, 1), new Uint8Array(0), bytes.slice(1, 3), bytes.slice(3)]
    const merged = await collect(alignPcm16(toAsync(parts)))
    expect(Array.from(merged)).toEqual(Array.from(bytes))
  })
})

describe('HubClient.synthesizeStream', () => {
  it('请求形状：POST /api/mobile/tts/stream + Bearer + JSON', async () => {
    const { client, calls } = makeClient(() => streamResponse([pcmBytes(2)]), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    const stream = await client.synthesizeStream({ text: '  你好  ', voice: 'seki' })
    await collect(stream.chunks)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${ORIGIN}${MOBILE.ttsStream}`)
    expect(MOBILE.ttsStream).toBe('/api/mobile/tts/stream')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.auth).toBe(AT)
    expect(calls[0]!.contentType).toBe('application/json')
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({ text: '你好', voice: 'seki' })
  })

  it('不带音色时 body 只有 text（用 Hub 默认音色）', async () => {
    const { client, calls } = makeClient(() => streamResponse([pcmBytes(2)]), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    await collect((await client.synthesizeStream({ text: '你好' })).chunks)
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({ text: '你好' })
  })

  it('响应头：采样率 / 音色 / cached', async () => {
    const { client } = makeClient(
      () =>
        streamResponse([pcmBytes(2)], {
          'x-tts-sample-rate': '48000',
          'x-tts-voice': 'seki',
          'x-tts-cached': '1',
          'x-tts-format': 'pcm16le',
        }),
      { initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }) },
    )
    const stream = await client.synthesizeStream({ text: '你好' })
    expect(stream.sampleRate).toBe(48_000)
    expect(stream.voice).toBe('seki')
    expect(stream.cached).toBe(true)
    await collect(stream.chunks)
  })

  it('响应头缺省：24000 / 请求的音色 / cached=false', async () => {
    const { client } = makeClient(() => streamResponse([pcmBytes(2)]), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    const stream = await client.synthesizeStream({ text: '你好', voice: 'seki' })
    expect(stream.sampleRate).toBe(TTS_DEFAULT_SAMPLE_RATE)
    expect(stream.voice).toBe('seki')
    expect(stream.cached).toBe(false)
    await collect(stream.chunks)
  })

  it('body 是裸 PCM：不缓存 WAV 头，拼接结果原样', async () => {
    const pcm = pcmBytes(20)
    const { client } = makeClient(() => streamResponse(sliceOdd(pcm, [5, 7, 9])), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    const stream = await client.synthesizeStream({ text: '你好' })
    expect(Array.from(await collect(stream.chunks))).toEqual(Array.from(pcm))
  })

  it('空文本本地拦截（400 VALIDATION_FAILED），不发请求', async () => {
    const { client, calls } = makeClient(() => streamResponse([pcmBytes(2)]), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    const error = await client.synthesizeStream({ text: '   ' }).catch((e) => e)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.message).toBe('请求内容不合法，请更新 App 后再试')
    expect(calls).toHaveLength(0)
  })

  it('开始下发前的 429：中文错误码 + retryAfterSec', async () => {
    const { client } = makeClient(
      () =>
        json(
          {
            error: {
              code: 'RATE_LIMITED',
              message: 'queue full',
              details: { retryAfterSec: 3 },
            },
          },
          429,
        ),
      { initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }) },
    )
    const error = await client.synthesizeStream({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('RATE_LIMITED')
    expect(error.status).toBe(429)
    expect(error.retryAfterSec).toBe(3)
    expect(error.message).toBe('尝试太频繁了，请稍等一会儿再试')
  })

  it('开始下发前的 502：UPSTREAM_ERROR', async () => {
    const { client } = makeClient(
      () => json({ error: { code: 'UPSTREAM_ERROR', message: 'tts down' } }, 502),
      { initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }) },
    )
    const error = await client.synthesizeStream({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(error.message).toBe('服务暂时不可用，请稍后重试')
  })

  it('内容类型不是 audio/L16 → protocol（不是 PCM，别当声音放）', async () => {
    const { client } = makeClient(
      () => streamResponse([pcmBytes(2)], {}, 200, 'application/json'),
      { initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }) },
    )
    const error = await client.synthesizeStream({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('protocol')
  })

  it('开始下发后连接被掐断 → stream-interrupted（可识别）', async () => {
    const { client } = makeClient(() => interruptedResponse([pcmBytes(4, )]), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    const stream = await client.synthesizeStream({ text: '你好' })
    const error = await collect(stream.chunks).catch((e) => e)
    expect(error.code).toBe('stream-interrupted')
    expect(error.message).toBe('朗读暂时不可用')
  })

  it('signal 在发起前已取消 → cancelled，不发请求', async () => {
    const { client, calls } = makeClient(() => streamResponse([pcmBytes(2)]), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    const controller = new AbortController()
    controller.abort()
    const error = await client
      .synthesizeStream({ text: '你好', signal: controller.signal })
      .catch((e) => e)
    expect(error.code).toBe('cancelled')
    expect(calls).toHaveLength(0)
  })

  it('signal 在读流中取消 → cancelled（连接一起断）', async () => {
    const controller = new AbortController()
    const { client } = makeClient((_call, init) => stalledResponse(init?.signal), {
      initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
    })
    const stream = await client.synthesizeStream({ text: '你好', signal: controller.signal })
    const pending = collect(stream.chunks).catch((e) => e)
    setTimeout(() => controller.abort(), 10)
    const error = await pending
    expect(error.code).toBe('cancelled')
  })

  it('401 → 单飞刷新后重放一次（发起前），之后才读流', async () => {
    let refreshed = 0
    const fresh = makeTokens({ accessToken: `dshm_at_${'c'.repeat(40)}` })
    const { client, calls } = makeClient(
      (call) => {
        if (call.url.endsWith(MOBILE.refresh)) {
          refreshed += 1
          return json(fresh)
        }
        if (refreshed === 0) {
          return json({ error: { code: 'DEVICE_TOKEN_INVALID', message: 'expired' } }, 401)
        }
        return streamResponse([pcmBytes(3)])
      },
      { initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }) },
    )
    const stream = await client.synthesizeStream({ text: '你好' })
    expect((await collect(stream.chunks)).byteLength).toBe(6)
    expect(refreshed).toBe(1)
    expect(calls.filter((c) => c.url.endsWith(MOBILE.ttsStream))).toHaveLength(2)
  })

  it('分块空闲 30 秒 → timeout（连接挂死不能永远等）', async () => {
    vi.useFakeTimers()
    try {
      const { client } = makeClient(() => stalledResponse(), {
        initial: makeTokens({ accessToken: AT.replace('Bearer ', '') }),
      })
      const stream = await client.synthesizeStream({ text: '你好' })
      const pending = collect(stream.chunks).catch((e) => e)
      await vi.advanceTimersByTimeAsync(30_001)
      const error = await pending
      expect(error.code).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})

async function* toAsync(parts: Uint8Array[]): AsyncGenerator<Uint8Array, void, void> {
  for (const part of parts) yield part
}

/* ---------- MockHub ---------- */

async function makeMockHub(options: ConstructorParameters<typeof MockHub>[0] = {}): Promise<MockHub> {
  const hub = new MockHub(options)
  await hub.login({ username: 'demo', password: 'demo1234', deviceName: 'test', platform: 'android' })
  return hub
}

describe('MockHub 的流式朗读', () => {
  it('bootstrap 默认带 stream: true', async () => {
    const hub = await makeMockHub()
    const tts = (await hub.bootstrap()).voice?.tts
    expect(tts?.stream).toBe(true)
    expect(tts).toEqual(MOCK_TTS_CAPABILITY)
  })

  it('ttsStream:false = 老 Hub（bootstrap 不带 stream，流式接口 502）', async () => {
    const hub = await makeMockHub({ ttsStream: false })
    expect((await hub.bootstrap()).voice?.tts?.stream).toBeUndefined()
    const error = await hub.synthesizeStream({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
  })

  it('下发裸 PCM（没有 WAV 头），拼接后就是 encodeTtsPcm', async () => {
    const hub = await makeMockHub({ ttsStreamTiming: { realtime: false } })
    const stream = await hub.synthesizeStream({ text: '今天天气不错。' })
    expect(stream.sampleRate).toBe(TTS_DEFAULT_SAMPLE_RATE)
    expect(stream.voice).toBe('seki')
    expect(stream.cached).toBe(false)
    const merged = await collect(stream.chunks)
    const expected = encodeTtsPcm('今天天气不错。', { sampleRate: TTS_DEFAULT_SAMPLE_RATE })
    expect(merged.byteLength).toBe(expected.byteLength)
    expect(Array.from(merged)).toEqual(Array.from(expected))
    // 不是 WAV：开头不是 RIFF
    expect(String.fromCharCode(...merged.subarray(0, 4))).not.toBe('RIFF')
  })

  it('按块下发（每块约 chunkMs 的音频），最后一小块收尾', async () => {
    const hub = await makeMockHub({
      ttsStreamTiming: { realtime: false, chunkMs: 200, firstChunkMs: 0 },
    })
    const stream = await hub.synthesizeStream({ text: '一二三四五六七八九十' })
    const sizes: number[] = []
    for await (const chunk of stream.chunks) sizes.push(chunk.byteLength)
    // 10 个字 = 900ms 音频 = 108000 字节；200ms = 9600 字节 → 11 块 + 收尾
    const chunkBytes = 24_000 * 0.2 * 2
    expect(sizes.length).toBe(Math.ceil((900 * 24_000 * 2) / 1000 / chunkBytes))
    expect(sizes.every((size) => size > 0 && size <= chunkBytes)).toBe(true)
    expect(sizes.slice(0, -1).every((size) => size === chunkBytes)).toBe(true)
  })

  it('首块延迟（真实时间）：realtime 时首块在 firstChunkMs 之后才到', async () => {
    const hub = await makeMockHub({
      ttsStreamTiming: { realtime: true, firstChunkMs: 120, chunkMs: 50, speed: 0 },
    })
    const started = Date.now()
    const stream = await hub.synthesizeStream({ text: '你好' })
    const iterator = stream.chunks[Symbol.asyncIterator]()
    const first = await iterator.next()
    const elapsed = Date.now() - started
    expect(first.done).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(100)
    await iterator.return?.(undefined)
  })

  it('第 N 块后掐断 → stream-interrupted（开始下发后的失败）', async () => {
    const hub = await makeMockHub({
      ttsStreamTiming: { realtime: false, interruptAfterChunks: 2, chunkMs: 50 },
    })
    const stream = await hub.synthesizeStream({ text: '今天天气不错，适合出去走走。' })
    const error = await collect(stream.chunks).catch((e) => e)
    expect(error.code).toBe('stream-interrupted')
  })

  it('signal 取消 → cancelled', async () => {
    const hub = await makeMockHub({
      ttsStreamTiming: { realtime: true, firstChunkMs: 5_000 },
    })
    const controller = new AbortController()
    const stream = await hub.synthesizeStream({ text: '你好', signal: controller.signal })
    const pending = collect(stream.chunks).catch((e) => e)
    setTimeout(() => controller.abort(), 20)
    const error = await pending
    expect(error.code).toBe('cancelled')
  })

  it('空文本 / 超长 / 未知音色 → VALIDATION_FAILED（与整段一致）', async () => {
    const hub = await makeMockHub({ ttsStreamTiming: { realtime: false } })
    expect((await hub.synthesizeStream({ text: ' ' }).catch((e) => e)).code).toBe(
      'VALIDATION_FAILED',
    )
    expect(
      (await hub.synthesizeStream({ text: '长'.repeat(201) }).catch((e) => e)).code,
    ).toBe('VALIDATION_FAILED')
    expect(
      (await hub.synthesizeStream({ text: '你好', voice: 'nobody' }).catch((e) => e)).code,
    ).toBe('VALIDATION_FAILED')
  })

  it('流式速率可配：rate 决定块间等待（1.05 比 0.9 快）', async () => {
    // 20 字 = 1.8 秒音频 = 18 块（100ms 一块）→ 17 次块间等待；快慢应差 ~250ms
    const text = '一二三四五六七八九十'.repeat(2)
    const run = async (rate: number): Promise<number> => {
      const hub = await makeMockHub({
        ttsStreamTiming: { realtime: true, chunkMs: 100, firstChunkMs: 0, rate },
      })
      const started = Date.now()
      await collect((await hub.synthesizeStream({ text })).chunks)
      return Date.now() - started
    }
    const fast = await run(1.05)
    const slow = await run(0.9)
    expect(fast).toBeLessThan(slow)
    expect(slow - fast).toBeGreaterThan(100)
  })

  it('MOCK_TTS_STREAM_RATE 是默认速率；非法值退回默认 0.9', () => {
    const key = 'MOCK_TTS_STREAM_RATE'
    const previous = process.env[key]
    try {
      process.env[key] = '1.05'
      expect(mockStreamRateFromEnv()).toBeCloseTo(1.05, 5)
      process.env[key] = '0.9'
      expect(mockStreamRateFromEnv()).toBeCloseTo(0.9, 5)
      // 离谱值钳位；非数字当作没有设置
      process.env[key] = '9'
      expect(mockStreamRateFromEnv()).toBe(1.5)
      process.env[key] = 'oops'
      expect(mockStreamRateFromEnv()).toBeUndefined()
      delete process.env[key]
      expect(mockStreamRateFromEnv()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('failTts() 对流式同样生效（开始前 502）', async () => {
    const hub = await makeMockHub()
    hub.failTts(1)
    const error = await hub.synthesizeStream({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
  })
})
