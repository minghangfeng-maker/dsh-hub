/**
 * 0.4.3 AI 回复朗读：`POST /api/mobile/tts`（契约冻结在 Hub `b7b58e8`）。
 *
 * 覆盖：
 *  - 请求形状：JSON `{text, voice?}`、Bearer、Content-Type、URL；
 *  - 响应形状：`audio/wav` 字节原样、`x-tts-sample-rate` / `x-tts-voice` 缺省与解析；
 *  - 401 单飞刷新后用同一段文本重放一次；
 *  - 错误码（400 / 429 带 retryAfterSec / 502）与 45 秒超时；
 *  - bootstrap.voice.tts 的解析（有 / 老 Hub 不发 / enabled=false）；
 *  - MockHub：默认下发星汐 seki、按字数生成 WAV、音色与长度校验、失败钩子。
 */

import { describe, expect, it, vi } from 'vitest'
import { HubClient, TTS_TIMEOUT_MS, type FetchLike } from '../src/http/hub-client.js'
import { HubApiError } from '../src/errors.js'
import { MemoryTokenStore } from '../src/auth/token-store.js'
import { MOBILE, TTS_DEFAULT_SAMPLE_RATE, type AuthTokens } from '../src/contracts/auth-bootstrap.js'
import { MockHub, MOCK_TTS_CAPABILITY } from '../src/mock/mock-hub.js'
import { makeTokens } from './helpers/tokens.js'

const NOW = Date.parse('2026-10-25T12:00:00.000Z')
const ORIGIN = 'https://hub.test:8123'
const AT = `Bearer dshm_at_${'a'.repeat(40)}`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 44 字节头的假 WAV（与真服务一样以 RIFF/WAVE 开头）。 */
function fakeWav(dataBytes = 4_800): Uint8Array {
  const bytes = new Uint8Array(44 + dataBytes)
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
  }
  tag(0, 'RIFF')
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  tag(36, 'data')
  for (let i = 44; i < bytes.length; i += 1) bytes[i] = (i * 11) % 241
  return bytes
}

function wavResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': 'audio/wav', ...headers },
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
  handler: (call: Call) => Response | Promise<Response>,
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
    return handler(call)
  }
  const client = new HubClient({
    origin: ORIGIN,
    tokenStore: store,
    fetchImpl,
    now: () => NOW,
    timeoutMs: 1_000,
  })
  return { client, store, calls }
}

/** bootstrap 的最小合法响应（只看 voice.tts 时够用）。 */
function bootstrapBody(voice?: unknown): Record<string, unknown> {
  return {
    user: { id: 1, username: 'demo', displayName: 'demo' },
    points: { balance: 0, enabled: false },
    backends: [],
    instance: { status: 'running', capacityFull: false },
    app: { minVersionCode: 1, latestVersionCode: 1, downloadUrl: null },
    ...(voice === undefined ? {} : { voice }),
    serverTime: '2026-10-27T12:00:00.000Z',
  }
}

const TTS_VOICE = { id: 'seki', name: '星汐 seki', description: '温柔清晰的女声' }

describe('synthesize：请求形状', () => {
  it('POST JSON {text, voice} + Bearer；URL 是 /api/mobile/tts', async () => {
    const wav = fakeWav()
    const h = makeClient((call) => {
      expect(call.url).toBe(`${ORIGIN}${MOBILE.tts}`)
      expect(call.method).toBe('POST')
      expect(call.auth).toBe(AT)
      expect(call.contentType).toBe('application/json')
      expect(JSON.parse(call.body ?? '{}')).toEqual({ text: '你好呀', voice: 'seki' })
      return wavResponse(wav)
    }, { initial: makeTokens() })

    const result = await h.client.synthesize({ text: '你好呀', voice: 'seki' })
    expect(Array.from(result.wav)).toEqual(Array.from(wav))
    expect(h.calls).toHaveLength(1)
  })

  it('不给 voice 时请求体里没有该字段', async () => {
    let body: unknown = null
    const h = makeClient(
      (call) => {
        body = JSON.parse(call.body ?? '{}')
        return wavResponse(fakeWav())
      },
      { initial: makeTokens() },
    )
    await h.client.synthesize({ text: '只有文字' })
    expect(body).toEqual({ text: '只有文字' })
  })

  it('文本两端空白会被去掉；空文本本地拒绝、不发请求', async () => {
    let sent: unknown = null
    const h = makeClient(
      (call) => {
        sent = JSON.parse(call.body ?? '{}')
        return wavResponse(fakeWav())
      },
      { initial: makeTokens() },
    )
    await h.client.synthesize({ text: '  有空白的句子  ' })
    expect(sent).toEqual({ text: '有空白的句子' })

    const error = await h.client.synthesize({ text: '   ' }).catch((e) => e)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(h.calls).toHaveLength(1)
  })
})

describe('synthesize：响应形状', () => {
  it('采样率与音色来自响应头', async () => {
    const h = makeClient(
      () =>
        wavResponse(fakeWav(), {
          'x-tts-sample-rate': '24000',
          'x-tts-voice': 'seki',
        }),
      { initial: makeTokens() },
    )
    const result = await h.client.synthesize({ text: '一段话' })
    expect(result.sampleRate).toBe(24_000)
    expect(result.voice).toBe('seki')
    expect(result.wav.byteLength).toBe(44 + 4_800)
  })

  it('响应头缺失：采样率用 24000，音色回落到请求的音色', async () => {
    const h = makeClient(() => wavResponse(fakeWav()), { initial: makeTokens() })
    const result = await h.client.synthesize({ text: '一段话', voice: 'seki' })
    expect(result.sampleRate).toBe(TTS_DEFAULT_SAMPLE_RATE)
    expect(result.voice).toBe('seki')
  })

  it('不到 44 字节的响应按 protocol 拒绝（不是 WAV）', async () => {
    const h = makeClient(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }), {
      initial: makeTokens(),
    })
    const error = await h.client.synthesize({ text: '一段话' }).catch((e) => e)
    expect(error.code).toBe('protocol')
  })
})

describe('synthesize：401 刷新后重放一次', () => {
  it('第二次带新 access，body 还是同一段文字', async () => {
    const fresh = makeTokens({ accessToken: `dshm_at_${'c'.repeat(40)}` })
    let ttsCalls = 0
    const h = makeClient(
      (call) => {
        if (call.url.endsWith(MOBILE.refresh)) return json(fresh)
        ttsCalls += 1
        if (ttsCalls === 1) return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
        expect(call.auth).toBe(`Bearer ${fresh.accessToken}`)
        expect(JSON.parse(call.body ?? '{}')).toEqual({ text: '刷新后也能读' })
        return wavResponse(fakeWav())
      },
      { initial: makeTokens() },
    )
    const result = await h.client.synthesize({ text: '刷新后也能读' })
    expect(result.wav.byteLength).toBeGreaterThan(44)
    expect(ttsCalls).toBe(2)
    expect(h.calls.filter((call) => call.url.endsWith(MOBILE.refresh))).toHaveLength(1)
  })
})

describe('synthesize：错误码 → 中文', () => {
  it('400 VALIDATION_FAILED 不可重试', async () => {
    const h = makeClient(
      () => json({ error: { code: 'VALIDATION_FAILED', message: 'text too long' } }, 400),
      { initial: makeTokens() },
    )
    const error = await h.client.synthesize({ text: '一段话' }).catch((e) => e)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.status).toBe(400)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('不合法')
  })

  it('429 RATE_LIMITED 透出 retryAfterSec（播放器据此重试一次）', async () => {
    const h = makeClient(
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
      { initial: makeTokens() },
    )
    const error = await h.client.synthesize({ text: '一段话' }).catch((e) => e)
    expect(error.code).toBe('RATE_LIMITED')
    expect(error.retryAfterSec).toBe(3)
    expect(error.message).toContain('频繁')
  })

  it('502 UPSTREAM_ERROR 可重试（播放器直接停止并提示）', async () => {
    const h = makeClient(
      () => json({ error: { code: 'UPSTREAM_ERROR', message: 'engine down' } }, 502),
      { initial: makeTokens() },
    )
    const error = await h.client.synthesize({ text: '一段话' }).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(error.status).toBe(502)
    expect(error.retryable).toBe(true)
  })

  it('超时 45 秒走 timeout 码', async () => {
    vi.useFakeTimers()
    try {
      const store = new MemoryTokenStore()
      await store.save(makeTokens())
      const client = new HubClient({
        origin: ORIGIN,
        tokenStore: store,
        now: () => NOW,
        fetchImpl: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      })
      const pending = client.synthesize({ text: '一段话' }).catch((e) => e)
      await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS + 10)
      const error = await pending
      expect(error.code).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('TTS_TIMEOUT_MS = 45 秒（不是普通请求的 15 秒）', () => {
    expect(TTS_TIMEOUT_MS).toBe(45_000)
  })
})

describe('bootstrap.voice.tts', () => {
  const tts = {
    enabled: true,
    voices: [TTS_VOICE],
    defaultVoice: 'seki',
    maxChars: 200,
  }

  it('原样解析（enabled / voices / defaultVoice / maxChars）', async () => {
    const h = makeClient(() => json(bootstrapBody({ asr: true, maxSeconds: 60, tts })), {
      initial: makeTokens(),
    })
    const bootstrap = await h.client.bootstrap()
    expect(bootstrap.voice?.tts).toEqual(tts)
  })

  it('老 Hub 不发 voice.tts：undefined（App 不显示朗读入口）', async () => {
    const h = makeClient(() => json(bootstrapBody({ asr: true, maxSeconds: 60 })), {
      initial: makeTokens(),
    })
    const bootstrap = await h.client.bootstrap()
    expect(bootstrap.voice?.asr).toBe(true)
    expect(bootstrap.voice?.tts).toBeUndefined()
  })

  it('enabled=false + 空音色列表也能解析（入口置灰、不崩）', async () => {
    const h = makeClient(
      () =>
        json(
          bootstrapBody({
            asr: true,
            maxSeconds: 60,
            tts: { enabled: false, voices: [], defaultVoice: null, maxChars: 200 },
          }),
        ),
      { initial: makeTokens() },
    )
    const bootstrap = await h.client.bootstrap()
    expect(bootstrap.voice?.tts?.enabled).toBe(false)
    expect(bootstrap.voice?.tts?.voices).toEqual([])
    expect(bootstrap.voice?.tts?.defaultVoice).toBeNull()
  })
})

describe('MockHub 的朗读合成', () => {
  async function makeHub(options: ConstructorParameters<typeof MockHub>[0] = {}) {
    const hub = new MockHub(options)
    await hub.login({
      username: 'demo',
      password: 'demo1234',
      deviceName: 'test',
      platform: 'android',
    })
    return hub
  }

  it('bootstrap 默认下发 enabled + 星汐 seki + 200 字上限', async () => {
    const hub = await makeHub()
    const voice = (await hub.bootstrap()).voice
    expect(voice?.asr).toBe(true)
    expect(voice?.tts).toEqual(MOCK_TTS_CAPABILITY)
    expect(voice?.tts?.voices.map((item) => item.name)).toEqual(['星汐 seki'])
    expect(voice?.tts?.maxChars).toBe(200)
  })

  it('synthesize 返回 24kHz 单声道 WAV，长度跟着字数走', async () => {
    const hub = await makeHub()
    const short = await hub.synthesize({ text: '你好' })
    const long = await hub.synthesize({ text: '今天下午三点，我们在三号会议室过一遍发布清单。' })
    expect(short.sampleRate).toBe(24_000)
    expect(short.voice).toBe('seki')
    expect(String.fromCharCode(...short.wav.slice(0, 4))).toBe('RIFF')
    // data 块之后的字节数：24kHz × 2 字节/样本
    expect(long.wav.byteLength).toBeGreaterThan(short.wav.byteLength)
    expect((long.wav.byteLength - 44) % 2).toBe(0)
  })

  it('未知音色 → 400；超长文本 → 400', async () => {
    const hub = await makeHub()
    const wrongVoice = await hub.synthesize({ text: '你好', voice: 'nobody' }).catch((e) => e)
    expect(wrongVoice.code).toBe('VALIDATION_FAILED')
    const tooLong = await hub
      .synthesize({ text: '长'.repeat(MOCK_TTS_CAPABILITY.maxChars + 1) })
      .catch((e) => e)
    expect(tooLong.code).toBe('VALIDATION_FAILED')
  })

  it('failTts() 后一次 502，之后恢复；合成次数可查', async () => {
    const hub = await makeHub()
    hub.failTts(1)
    const error = await hub.synthesize({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect(hub.synthesizedSegments).toBe(0)
    await hub.synthesize({ text: '你好' })
    expect(hub.synthesizedSegments).toBe(1)
  })

  it('tts:null（老 Hub / 没开朗读）→ bootstrap 没有 tts，合成按 502 失败', async () => {
    const hub = await makeHub({ tts: null })
    expect((await hub.bootstrap()).voice?.tts).toBeUndefined()
    const error = await hub.synthesize({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
  })

  it('enabled=false（合成服务不可用）→ 合成 502', async () => {
    const hub = await makeHub({ tts: { ...MOCK_TTS_CAPABILITY, enabled: false } })
    expect((await hub.bootstrap()).voice?.tts?.enabled).toBe(false)
    const error = await hub.synthesize({ text: '你好' }).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
  })

  it('ttsDelayMs 会真的等（e2e 用它看清「边播边合成」）', async () => {
    vi.useFakeTimers()
    try {
      const hub = await makeHub({ ttsDelayMs: 800 })
      let done = false
      const pending = hub.synthesize({ text: '你好' }).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(400)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      await pending
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
