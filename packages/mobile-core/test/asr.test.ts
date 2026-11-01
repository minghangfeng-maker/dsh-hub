/**
 * 0.4.2 服务端语音识别：`POST /api/mobile/asr`（契约冻结在 Hub `d00b39d`）。
 *
 * 覆盖：
 *  - 上传形状：`Content-Type: audio/wav`、Bearer、`?lang=`、字节原样、响应解析；
 *  - 401 单飞刷新后**用同一段字节重放一次**（不重编码、不丢 body）；
 *  - 错误码映射（400 / 413 / 415 / 429 / 502）与 502 的「可重试」；
 *  - 30 秒超时走 `timeout`（假定时器，不真的等）；
 *  - bootstrap 的 `voice`：老 Hub 不发 = 没有；`asr=false` 也要能读到；
 *  - MockHub 的实现（固定文字 / 失败钩子 / 假 WAV 被拒）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HubClient, ASR_TIMEOUT_MS, type FetchLike } from '../src/http/hub-client.js'
import { HubApiError } from '../src/errors.js'
import { MemoryTokenStore } from '../src/auth/token-store.js'
import { MOBILE, type AuthTokens, type Bootstrap } from '../src/contracts/auth-bootstrap.js'
import { MockHub, MOCK_TTS_CAPABILITY } from '../src/mock/mock-hub.js'
import { makeTokens } from './helpers/tokens.js'

const NOW = Date.parse('2026-10-25T12:00:00.000Z')
const ORIGIN = 'https://hub.test:8123'
const AT = `Bearer dshm_at_${'a'.repeat(40)}`

/** 44 字节头的假 WAV：够看出「字节有没有被改动」。 */
function fakeWav(dataBytes = 32_000): Uint8Array {
  const bytes = new Uint8Array(44 + dataBytes)
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
  }
  tag(0, 'RIFF')
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  tag(36, 'data')
  for (let i = 44; i < bytes.length; i += 1) bytes[i] = (i * 7) % 251
  return bytes
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Call {
  url: string
  method: string
  auth: string | null
  contentType: string | null
  body: Uint8Array | null
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
    const raw = init?.body
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? null,
      contentType: headers['Content-Type'] ?? null,
      body: raw instanceof Uint8Array ? new Uint8Array(raw) : null,
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

function bootstrapBody(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    user: { id: 1, username: 'demo', displayName: 'demo' },
    points: { balance: 12.5, enabled: true },
    backends: [],
    instance: { status: 'running', capacityFull: false },
    app: { minVersionCode: 1, latestVersionCode: 10, downloadUrl: null },
    serverTime: new Date(NOW).toISOString(),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('transcribe：上传形状', () => {
  it('POST audio/wav + Bearer + ?lang，字节原样，响应解析成 {text,durationMs}', async () => {
    const wav = fakeWav(3_200)
    let seenBody: Uint8Array | null = null
    const h = makeClient((call) => {
      expect(call.url).toBe(`${ORIGIN}${MOBILE.asr}?lang=zh`)
      expect(call.method).toBe('POST')
      expect(call.auth).toBe(AT)
      expect(call.contentType).toBe('audio/wav')
      seenBody = call.body
      return json({ text: '这是一段测试语音', durationMs: 1_600 })
    }, { initial: makeTokens() })

    const result = await h.client.transcribe(wav, 'zh')
    expect(result).toEqual({ text: '这是一段测试语音', durationMs: 1_600 })
    expect(seenBody).not.toBeNull()
    expect(seenBody!.byteLength).toBe(wav.byteLength)
    // 逐字节不变（假 fetch 里拿到的就是客户端写出去的东西）
    expect(Array.from(seenBody!)).toEqual(Array.from(wav))
    expect(h.calls).toHaveLength(1)
  })

  it('不给 lang 时 URL 不带查询串', async () => {
    const h = makeClient(() => json({ text: '好', durationMs: 200 }), { initial: makeTokens() })
    await h.client.transcribe(fakeWav(1_000))
    expect(h.calls[0]!.url).toBe(`${ORIGIN}${MOBILE.asr}`)
  })

  it('30 秒超时（ASR_TIMEOUT_MS）', () => {
    expect(ASR_TIMEOUT_MS).toBe(30_000)
  })
})

describe('transcribe：401 刷新后重放一次', () => {
  it('第二次带新 access，body 还是同一段字节', async () => {
    const wav = fakeWav(4_800)
    const fresh = makeTokens({ accessToken: `dshm_at_${'c'.repeat(40)}` })
    let asrCalls = 0
    const h = makeClient(
      (call) => {
        if (call.url.endsWith(MOBILE.refresh)) return json(fresh)
        asrCalls += 1
        if (asrCalls === 1) return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
        expect(call.auth).toBe(`Bearer ${fresh.accessToken}`)
        expect(call.contentType).toBe('audio/wav')
        expect(call.body?.byteLength).toBe(wav.byteLength)
        return json({ text: '刷新后也能识别', durationMs: 900 })
      },
      { initial: makeTokens() },
    )
    const result = await h.client.transcribe(wav, 'zh')
    expect(result.text).toBe('刷新后也能识别')
    expect(asrCalls).toBe(2)
    // refresh 只发生一次
    expect(h.calls.filter((call) => call.url.endsWith(MOBILE.refresh))).toHaveLength(1)
    expect((await h.store.load())?.refreshToken).toBe(fresh.refreshToken)
  })
})

describe('transcribe：错误码 → 中文', () => {
  const cases: Array<[number, string, string, boolean]> = [
    [400, 'VALIDATION_FAILED', '不合法', false],
    [413, 'PAYLOAD_TOO_LARGE', '太大', false],
    [415, 'UNSUPPORTED_MEDIA', '格式', false],
    [429, 'RATE_LIMITED', '频繁', false],
    [502, 'UPSTREAM_ERROR', '暂时不可用', true],
  ]
  for (const [status, code, expected, retryable] of cases) {
    it(`${status} ${code} → 中文且 retryable=${retryable}`, async () => {
      const h = makeClient(
        () => json({ error: { code, message: 'english detail' } }, status),
        { initial: makeTokens() },
      )
      const error = await h.client.transcribe(fakeWav(1_000)).catch((e) => e)
      expect(error).toBeInstanceOf(HubApiError)
      expect(error.code).toBe(code)
      expect(error.status).toBe(status)
      expect(error.retryable).toBe(retryable)
      expect(error.message).toContain(expected)
    })
  }

  it('没有 body 的 413/415/502 按 HTTP 状态兜底', async () => {
    for (const [status, code] of [
      [413, 'PAYLOAD_TOO_LARGE'],
      [415, 'UNSUPPORTED_MEDIA'],
      [502, 'UPSTREAM_ERROR'],
    ] as const) {
      const h = makeClient(() => new Response('', { status }), { initial: makeTokens() })
      const error = await h.client.transcribe(fakeWav(64)).catch((e) => e)
      expect(error.code).toBe(code)
    }
  })

  it('网络错误 → network（不清令牌，可重试）', async () => {
    const h = makeClient(
      () => {
        throw new Error('offline')
      },
      { initial: makeTokens() },
    )
    const error = await h.client.transcribe(fakeWav(64)).catch((e) => e)
    expect(error.code).toBe('network')
    expect(error.retryable).toBe(true)
    expect(await h.store.load()).not.toBeNull()
  })

  it('超时 → timeout（abort 在 30 秒后触发）', async () => {
    vi.useFakeTimers()
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
    const pending = client.transcribe(fakeWav(64)).catch((e) => e)
    await vi.advanceTimersByTimeAsync(ASR_TIMEOUT_MS + 10)
    const error = await pending
    expect(error.code).toBe('timeout')
    expect(error.message).toContain('超时')
  })
})

describe('bootstrap.voice', () => {
  it('下发 voice 时原样解析（asr / maxSeconds）', async () => {
    const h = makeClient(() => json(bootstrapBody({ voice: { asr: true, maxSeconds: 45 } })), {
      initial: makeTokens(),
    })
    const bootstrap = await h.client.bootstrap()
    expect(bootstrap.voice).toEqual({ asr: true, maxSeconds: 45 })
  })

  it('老 Hub 不发 voice：undefined（= 只能用手机系统识别）', async () => {
    const h = makeClient(() => json(bootstrapBody()), { initial: makeTokens() })
    expect((await h.client.bootstrap()).voice).toBeUndefined()
  })

  it('voice.asr=false 也照原样读出来（Hub 侧关掉了识别）', async () => {
    const h = makeClient(() => json(bootstrapBody({ voice: { asr: false, maxSeconds: 60 } })), {
      initial: makeTokens(),
    })
    expect((await h.client.bootstrap()).voice?.asr).toBe(false)
  })
})

describe('MockHub 的服务端识别', () => {
  function mockWav(seconds = 1): Uint8Array {
    return fakeWav(Math.round(seconds * 32_000))
  }

  it('bootstrap 默认带 voice，transcribe 回固定文字与时长', async () => {
    const hub = new MockHub()
    await hub.login({ username: 'demo', password: 'demo1234', deviceName: 't', platform: 'android' })
    // 0.4.3：voice 里多了 tts（WP50）；asr 部分不变
    expect((await hub.bootstrap()).voice).toEqual({
      asr: true,
      maxSeconds: 60,
      tts: MOCK_TTS_CAPABILITY,
    })
    const result = await hub.transcribe(mockWav(1.5))
    expect(result.text).toBe('这是一段测试语音')
    expect(result.durationMs).toBe(1_500)
  })

  it('voice:null 模拟老 Hub：bootstrap 里没有该字段', async () => {
    const hub = new MockHub({ voice: null })
    await hub.login({ username: 'demo', password: 'demo1234', deviceName: 't', platform: 'android' })
    expect((await hub.bootstrap()).voice).toBeUndefined()
  })

  it('非 WAV → 400 VALIDATION_FAILED', async () => {
    const hub = new MockHub()
    await hub.login({ username: 'demo', password: 'demo1234', deviceName: 't', platform: 'android' })
    const error = await hub.transcribe(new Uint8Array([1, 2, 3])).catch((e) => e)
    expect(error.code).toBe('VALIDATION_FAILED')
  })

  it('failAsr() 后一次 502 UPSTREAM_ERROR，之后恢复', async () => {
    const hub = new MockHub()
    await hub.login({ username: 'demo', password: 'demo1234', deviceName: 't', platform: 'android' })
    hub.failAsr(1)
    const error = await hub.transcribe(mockWav(1)).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
    expect((await hub.transcribe(mockWav(1))).text).toBe('这是一段测试语音')
  })

  it('voice.asr=false 时识别按上游不可用失败', async () => {
    const hub = new MockHub({ voice: { asr: false, maxSeconds: 60 } })
    await hub.login({ username: 'demo', password: 'demo1234', deviceName: 't', platform: 'android' })
    const error = await hub.transcribe(mockWav(1)).catch((e) => e)
    expect(error.code).toBe('UPSTREAM_ERROR')
  })
})
