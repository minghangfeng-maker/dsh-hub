import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { MOBILE_TTS_MAX_CHARS } from '@dsh-hub/shared'
import { createTestApp, createUser, json, type TestApp } from './helpers.js'
import { MOBILE_APP_ORIGIN, mobileBootstrap, mobileSession } from './helpers-mobile.js'

/**
 * `POST /api/mobile/tts` 与 `bootstrap.voice.tts`（WP50）。
 *
 * 上游 `seki-voice` 用 `vi.stubGlobal('fetch')` 替身：这些用例只验证 Hub 的边界
 * （鉴权 / 校验 / 未知音色 / 降级判失败 / 超时 / 排队 / 限流 / 缓存 / 审计 / CORS 暴露头）；
 * 真实合成链路由集成冒烟脚本覆盖（未随开源版发布）。
 */

const TTS_ENV = { HUB_TTS_ENABLED: 'true', HUB_TTS_URL: 'http://tts.test' }

interface FetchCall {
  url: string
  init: RequestInit
}

type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response

function installFetch(handler: FetchHandler): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      return await handler(url, init)
    }),
  )
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 造一段合法的 24k/单声道/16bit PCM WAV（正弦波，内容不重要）。 */
function wavBytes(durationMs = 200, sampleRate = 24_000): Buffer {
  const frames = Math.round((sampleRate * durationMs) / 1000)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * Math.PI * 2) * 8_000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byteRate
  header.writeUInt16LE(2, 32) // blockAlign
  header.writeUInt16LE(16, 34) // bits
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

interface UpstreamAudioOptions {
  /** `null` = 不发这个头（模拟来路不明的后端）；缺省 `breeze` */
  backend?: string | null
  /** 缺省 = 不发降级头 */
  degraded?: string
  /** `null` = 不发采样率头 */
  sampleRate?: number | null
  wav?: Buffer
  status?: number
  contentType?: string
}

function upstreamAudio(opts: UpstreamAudioOptions = {}): Response {
  const wav = opts.wav ?? wavBytes()
  const headers = new Headers({ 'content-type': opts.contentType ?? 'audio/wav' })
  const backend = opts.backend === undefined ? 'breeze' : opts.backend
  if (backend !== null) headers.set('x-seki-tts-backend', backend)
  const sampleRate = opts.sampleRate === undefined ? 24_000 : opts.sampleRate
  if (sampleRate !== null) headers.set('x-seki-tts-sample-rate', String(sampleRate))
  if (opts.degraded !== undefined) headers.set('x-seki-tts-degraded', opts.degraded)
  return new Response(new Uint8Array(wav), { status: opts.status ?? 200, headers })
}

const contexts: TestApp[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.close()
})

interface Setup {
  ctx: TestApp
  headers: Record<string, string>
}

async function setup(env: Record<string, string> = TTS_ENV): Promise<Setup> {
  const ctx = await createTestApp({ env })
  contexts.push(ctx)
  const alice = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
  const { headers } = await mobileSession(ctx.app, alice)
  return { ctx, headers }
}

/** 再登录 N 个手机用户（测全局排队/单用户上限需要多个身份）。 */
async function mobileUsers(ctx: TestApp, count: number): Promise<Array<Record<string, string>>> {
  const out: Array<Record<string, string>> = []
  for (let i = 0; i < count; i += 1) {
    const user = await createUser(ctx.app, {
      username: `tts-user-${i}-${Date.now()}`,
      password: 'Tts-pass-1',
    })
    const { headers } = await mobileSession(ctx.app, user)
    out.push(headers)
  }
  return out
}

interface TtsResponse {
  status: number
  headers: Record<string, unknown>
  raw: Buffer
  body: Record<string, unknown>
  errorCode: string | undefined
}

async function postTts(
  app: FastifyInstance,
  headers: Record<string, string>,
  opts: {
    payload?: unknown
    raw?: string
    contentType?: string
    authenticated?: boolean
  } = {},
): Promise<TtsResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/mobile/tts',
    headers: {
      origin: MOBILE_APP_ORIGIN,
      ...(opts.authenticated === false ? {} : { authorization: headers.authorization! }),
      'content-type': opts.contentType ?? 'application/json',
    },
    payload: opts.raw ?? JSON.stringify(opts.payload ?? { text: '你好呀' }),
  })
  const contentType = String(response.headers['content-type'] ?? '')
  const body = contentType.includes('application/json') ? json<Record<string, unknown>>(response) : {}
  const errorCode =
    typeof body['error'] === 'object' && body['error'] !== null
      ? String((body['error'] as { code?: unknown }).code ?? '')
      : undefined
  return {
    status: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    raw: response.rawPayload,
    body,
    errorCode,
  }
}

function retryAfterSecOf(body: Record<string, unknown>): number | undefined {
  const error = body['error'] as { details?: { retryAfterSec?: number } } | undefined
  return error?.details?.retryAfterSec
}

/** 第 `offset` 条 `mobile.tts` 审计（0 = 最新） */
function auditDetail(ctx: TestApp, offset = 0): Record<string, unknown> {
  const rows = ctx.app.deps.db.all<{ detail_json: string }>(
    'SELECT detail_json FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 10',
    'mobile.tts',
  )
  const row = rows[offset]
  if (row === undefined) throw new Error(`没有第 ${offset} 条 mobile.tts 审计`)
  return JSON.parse(row.detail_json) as Record<string, unknown>
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('POST /api/mobile/tts', () => {
  it('鉴权：没有设备令牌 401，且不会碰上游', async () => {
    const { ctx } = await setup()
    const calls = installFetch(() => upstreamAudio())
    const res = await postTts(ctx.app, {}, { authenticated: false })
    expect(res.status).toBe(401)
    expect(res.errorCode).toBe('UNAUTHENTICATED')
    expect(calls).toHaveLength(0)
  })

  it('415：Content-Type 不是 application/json（CSRF 规则，本地拒绝）', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => upstreamAudio())
    const res = await postTts(ctx.app, headers, { contentType: 'text/plain', raw: 'hello' })
    expect(res.status).toBe(415)
    expect(res.errorCode).toBe('UNSUPPORTED_MEDIA')
    expect(calls).toHaveLength(0)
  })

  it('400：空文本 / 超长 / 未知音色都在本地拒绝，不转发', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => upstreamAudio())

    const empty = await postTts(ctx.app, headers, { payload: { text: '   ' } })
    expect(empty.status).toBe(400)
    expect(empty.errorCode).toBe('VALIDATION_FAILED')

    const tooLong = await postTts(ctx.app, headers, {
      payload: { text: '好'.repeat(MOBILE_TTS_MAX_CHARS + 1) },
    })
    expect(tooLong.status).toBe(400)
    expect(tooLong.errorCode).toBe('VALIDATION_FAILED')

    const unknown = await postTts(ctx.app, headers, { payload: { text: '你好', voice: 'nobody' } })
    expect(unknown.status).toBe(400)
    expect(unknown.errorCode).toBe('VALIDATION_FAILED')

    expect(calls).toHaveLength(0)
  })

  it('成功：转发 {text,backend:breeze}、透传 WAV、采样率/音色/缓存头与 CORS 暴露头', async () => {
    const { ctx, headers } = await setup()
    const wav = wavBytes(300)
    const calls = installFetch(() => upstreamAudio({ wav }))
    const res = await postTts(ctx.app, headers, { payload: { text: '今天也要开心呀。' } })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://tts.test/tts')
    expect(calls[0]!.init.method).toBe('POST')
    const forwarded = calls[0]!.init.headers as Record<string, string>
    expect(forwarded['content-type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: '今天也要开心呀。', backend: 'breeze' })

    expect(res.headers['content-type']).toBe('audio/wav')
    expect(res.headers['x-tts-sample-rate']).toBe('24000')
    expect(res.headers['x-tts-voice']).toBe('seki')
    expect(res.headers['cache-control']).toBe('private, max-age=86400')
    expect(res.raw.equals(wav)).toBe(true)

    // CORS：App（https://localhost）跨域读 body 与两个自定义响应头
    expect(res.headers['access-control-allow-origin']).toBe(MOBILE_APP_ORIGIN)
    expect(String(res.headers['access-control-expose-headers'])).toContain('x-tts-sample-rate')
    expect(String(res.headers['access-control-expose-headers'])).toContain('x-tts-voice')
  })

  it('显式 voice=seki 与省略 voice 等价；采样率以响应头为准', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => upstreamAudio({ sampleRate: 24_000 }))
    const res = await postTts(ctx.app, headers, { payload: { text: '你好', voice: 'seki' } })
    expect(res.status).toBe(200)
    expect(res.headers['x-tts-voice']).toBe('seki')
    expect(res.headers['x-tts-sample-rate']).toBe('24000')
    expect(calls).toHaveLength(1)
  })

  it('降级即失败：x-seki-tts-degraded 或 backend 不是 breeze → 502，且不返回不缓存', async () => {
    const { ctx, headers } = await setup()
    const cases: Array<UpstreamAudioOptions> = [
      { backend: 'piper', degraded: '1' },
      { backend: 'piper' },
      { backend: null }, // 没有 backend 头：来路不明，宁可不给
      { backend: 'breeze', degraded: 'timeout' },
    ]
    for (const [index, opts] of cases.entries()) {
      const calls = installFetch(() => upstreamAudio(opts))
      const text = `降级测试第${index}段`
      const res = await postTts(ctx.app, headers, { payload: { text } })
      expect(res.status, JSON.stringify(opts)).toBe(502)
      expect(res.errorCode).toBe('UPSTREAM_ERROR')
      expect(calls).toHaveLength(1)
      // 失败不缓存：同一段再问一次仍然会打上游
      const again = await postTts(ctx.app, headers, { payload: { text } })
      expect(again.status).toBe(502)
      expect(calls).toHaveLength(2)
    }
  })

  it('上游错误映射：400 → 400 VALIDATION_FAILED，5xx → 502', async () => {
    const { ctx, headers } = await setup()
    const cases: Array<[number, number, string]> = [
      [400, 400, 'VALIDATION_FAILED'],
      [500, 502, 'UPSTREAM_ERROR'],
      [503, 502, 'UPSTREAM_ERROR'],
    ]
    for (const [upstream, status, code] of cases) {
      installFetch(() => new Response('{}', { status: upstream }))
      const res = await postTts(ctx.app, headers, { payload: { text: `上游${upstream}` } })
      expect(res.status, `upstream ${upstream}`).toBe(status)
      expect(res.errorCode, `upstream ${upstream}`).toBe(code)
    }
  })

  it('上游超时（AbortSignal）→ 502 UPSTREAM_ERROR', async () => {
    const { ctx, headers } = await setup({ ...TTS_ENV, HUB_TTS_TIMEOUT_MS: '150' })
    const calls = installFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    const started = Date.now()
    const res = await postTts(ctx.app, headers)
    expect(res.status).toBe(502)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  it('上游 200 但不是 WAV → 502，且不缓存', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => new Response('{"error":"boom"}', { status: 200 }))
    const res = await postTts(ctx.app, headers, { payload: { text: '坏响应' } })
    expect(res.status).toBe(502)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
    await postTts(ctx.app, headers, { payload: { text: '坏响应' } })
    expect(calls).toHaveLength(2)
  })

  it('缓存命中：同 (音色, 文字) 第二次不打上游，返回同样字节，审计 cached=true', async () => {
    const { ctx, headers } = await setup()
    const wav = wavBytes(400)
    const calls = installFetch(() => upstreamAudio({ wav }))
    const text = '自动朗读和手动朗读不应该合成两次。'

    const first = await postTts(ctx.app, headers, { payload: { text } })
    expect(first.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(auditDetail(ctx)['cached']).toBe(false)

    const second = await postTts(ctx.app, headers, { payload: { text } })
    expect(second.status).toBe(200)
    expect(calls).toHaveLength(1) // 命中缓存，没有再打上游
    expect(second.raw.equals(first.raw)).toBe(true)
    expect(second.headers['x-tts-sample-rate']).toBe('24000')
    expect(auditDetail(ctx)['cached']).toBe(true)

    // 不同文字仍然要合成
    const third = await postTts(ctx.app, headers, { payload: { text: `${text}换一句` } })
    expect(third.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it('缓存开关：HUB_TTS_CACHE_BYTES=0 时每次都打上游', async () => {
    const { ctx, headers } = await setup({ ...TTS_ENV, HUB_TTS_CACHE_BYTES: '0' })
    const calls = installFetch(() => upstreamAudio())
    await postTts(ctx.app, headers, { payload: { text: '同一段' } })
    await postTts(ctx.app, headers, { payload: { text: '同一段' } })
    expect(calls).toHaveLength(2)
  })

  it('审计只记 {voice,chars,bytes,ms,cached,ok}，不记文字、不存音频', async () => {
    const { ctx, headers } = await setup()
    const text = '这段文字绝不能出现在审计里，也不能落盘。'
    const wav = wavBytes(250)
    installFetch(() => upstreamAudio({ wav }))
    const res = await postTts(ctx.app, headers, { payload: { text } })
    expect(res.status).toBe(200)

    const detail = auditDetail(ctx)
    expect(Object.keys(detail).sort()).toEqual(['bytes', 'cached', 'chars', 'ms', 'ok', 'voice'])
    expect(detail['ok']).toBe(true)
    expect(detail['cached']).toBe(false)
    expect(detail['voice']).toBe('seki')
    expect(detail['chars']).toBe(text.length)
    expect(detail['bytes']).toBe(wav.length)
    expect(typeof detail['ms']).toBe('number')
    expect(JSON.stringify(detail)).not.toContain(text)

    // 库里除了审计没有别的地方落文字/音频
    const tables = ctx.app.deps.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name)
    expect(tables.filter((name) => /tts|audio|speech/u.test(name))).toEqual([])
  })

  it('失败也审计（ok=false），仍然不记文字', async () => {
    const { ctx, headers } = await setup()
    const text = '失败也不能留文字'
    installFetch(() => new Response('{}', { status: 500 }))
    const res = await postTts(ctx.app, headers, { payload: { text } })
    expect(res.status).toBe(502)
    const detail = auditDetail(ctx)
    expect(Object.keys(detail).sort()).toEqual(['cached', 'chars', 'ms', 'ok', 'voice'])
    expect(detail['ok']).toBe(false)
    expect(detail['chars']).toBe(text.length)
    expect(JSON.stringify(detail)).not.toContain(text)
  })

  it('全局排队：1 个在途 + 6 个排队，第 8 个 429 retryAfterSec=3', async () => {
    const { ctx } = await setup()
    const [a, b, c, d] = await mobileUsers(ctx, 4)
    let released = false
    const hanging: Array<() => void> = []
    const calls = installFetch(
      () =>
        new Promise<Response>((resolve) => {
          const settle = (): void => resolve(upstreamAudio())
          if (released) settle()
          else hanging.push(settle)
        }),
    )
    const service = ctx.app.deps.services.mobileTts
    const pending: Array<Promise<TtsResponse>> = []

    pending.push(postTts(ctx.app, a!, { payload: { text: '排队1' } }))
    await waitFor(() => service.stats().active === 1)

    // a 的第 2 段 + b/c 各 2 段 + d 的 1 段 = 队列 6 个
    const queued = [
      postTts(ctx.app, a!, { payload: { text: '排队2' } }),
      postTts(ctx.app, b!, { payload: { text: '排队3' } }),
      postTts(ctx.app, b!, { payload: { text: '排队4' } }),
      postTts(ctx.app, c!, { payload: { text: '排队5' } }),
      postTts(ctx.app, c!, { payload: { text: '排队6' } }),
      postTts(ctx.app, d!, { payload: { text: '排队7' } }),
    ]
    pending.push(...queued)
    await waitFor(() => service.stats().queued === 6)
    expect(calls).toHaveLength(1) // 只有 1 个在途，其余都在 Hub 排队

    // d 还有额度（1 < 2），但队列已满 → 429
    const full = await postTts(ctx.app, d!, { payload: { text: '排队8' } })
    expect(full.status).toBe(429)
    expect(full.errorCode).toBe('RATE_LIMITED')
    expect(retryAfterSecOf(full.body)).toBe(3)

    released = true
    for (const settle of hanging.splice(0)) settle()
    const results = await Promise.all(pending)
    expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200, 200, 200])
    expect(service.stats()).toEqual({ active: 0, queued: 0, users: 0 })
  })

  it('单用户最多 2 个在途/排队：第 3 段 429 retryAfterSec=2', async () => {
    const { ctx } = await setup()
    const [a] = await mobileUsers(ctx, 1)
    let released = false
    const hanging: Array<() => void> = []
    installFetch(
      () =>
        new Promise<Response>((resolve) => {
          const settle = (): void => resolve(upstreamAudio())
          if (released) settle()
          else hanging.push(settle)
        }),
    )
    const service = ctx.app.deps.services.mobileTts

    const first = postTts(ctx.app, a!, { payload: { text: '第一段' } })
    await waitFor(() => service.stats().active === 1)
    const second = postTts(ctx.app, a!, { payload: { text: '第二段' } })
    await waitFor(() => service.stats().queued === 1)

    const third = await postTts(ctx.app, a!, { payload: { text: '第三段' } })
    expect(third.status).toBe(429)
    expect(third.errorCode).toBe('RATE_LIMITED')
    expect(retryAfterSecOf(third.body)).toBe(2)

    released = true
    for (const settle of hanging.splice(0)) settle()
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([200, 200])
  })

  it('每分钟限流：第 3 段拒绝，不碰上游；推进 60 秒后恢复', async () => {
    const { ctx, headers } = await setup({ ...TTS_ENV, HUB_TTS_PER_MINUTE: '2', HUB_TTS_PER_DAY: '100' })
    const calls = installFetch(() => upstreamAudio())
    expect((await postTts(ctx.app, headers, { payload: { text: '一分钟1' } })).status).toBe(200)
    expect((await postTts(ctx.app, headers, { payload: { text: '一分钟2' } })).status).toBe(200)
    const limited = await postTts(ctx.app, headers, { payload: { text: '一分钟3' } })
    expect(limited.status).toBe(429)
    expect(limited.errorCode).toBe('RATE_LIMITED')
    expect(retryAfterSecOf(limited.body)).toBeGreaterThan(0)
    expect(calls).toHaveLength(2)

    ctx.clock.advance(60_001)
    expect((await postTts(ctx.app, headers, { payload: { text: '一分钟3' } })).status).toBe(200)
    expect(calls).toHaveLength(3)
  })

  it('每天限流：跨过分钟窗口后仍然 429', async () => {
    const { ctx, headers } = await setup({ ...TTS_ENV, HUB_TTS_PER_MINUTE: '100', HUB_TTS_PER_DAY: '2' })
    const calls = installFetch(() => upstreamAudio())
    expect((await postTts(ctx.app, headers, { payload: { text: '一天1' } })).status).toBe(200)
    expect((await postTts(ctx.app, headers, { payload: { text: '一天2' } })).status).toBe(200)
    ctx.clock.advance(60_001)
    const limited = await postTts(ctx.app, headers, { payload: { text: '一天3' } })
    expect(limited.status).toBe(429)
    expect(limited.errorCode).toBe('RATE_LIMITED')
    expect(calls).toHaveLength(2)
  })

  it('缓存命中同样计入用户配额（规则一致，不绕过限流）', async () => {
    const { ctx, headers } = await setup({ ...TTS_ENV, HUB_TTS_PER_MINUTE: '2', HUB_TTS_PER_DAY: '100' })
    const calls = installFetch(() => upstreamAudio())
    const text = '同一段读三遍'
    expect((await postTts(ctx.app, headers, { payload: { text } })).status).toBe(200)
    expect((await postTts(ctx.app, headers, { payload: { text } })).status).toBe(200) // 命中缓存
    expect(calls).toHaveLength(1)
    const limited = await postTts(ctx.app, headers, { payload: { text } })
    expect(limited.status).toBe(429)
  })

  it('HUB_TTS_ENABLED=false：端点 502（契约没有「关闭」码），也不碰上游', async () => {
    const { ctx, headers } = await setup({ HUB_TTS_ENABLED: 'false', HUB_TTS_URL: 'http://tts.test' })
    const calls = installFetch(() => upstreamAudio())
    const res = await postTts(ctx.app, headers)
    expect(res.status).toBe(502)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
    expect(calls).toHaveLength(0)
  })
})

describe('GET /api/mobile/bootstrap · voice.tts', () => {
  const EXPECTED_VOICES = [{ id: 'seki', name: '星汐 seki', description: '温柔俏皮的少女音（本机合成）' }]

  it('breeze 就绪 → tts.enabled=true，字段齐全；30 秒内复用健康缓存', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch((url) =>
      url.endsWith('/health') ? jsonResponse({ ok: true, breeze: { ready: true } }) : upstreamAudio(),
    )

    const first = await mobileBootstrap(ctx.app, headers)
    expect(first.status).toBe(200)
    expect(first.body.voice?.tts).toEqual({
      enabled: true,
      voices: EXPECTED_VOICES,
      defaultVoice: 'seki',
      maxChars: MOBILE_TTS_MAX_CHARS,
      // WP51：bootstrap 多了「支持流式朗读」标记（默认开）
      stream: true,
    })
    expect(calls.map((call) => call.url)).toEqual(['http://tts.test/health'])

    const second = await mobileBootstrap(ctx.app, headers)
    expect(second.body.voice?.tts?.enabled).toBe(true)
    expect(calls).toHaveLength(1)

    ctx.clock.advance(30_001)
    const third = await mobileBootstrap(ctx.app, headers)
    expect(third.body.voice?.tts?.enabled).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('breeze 未就绪 → tts.enabled=false，失败结果同样缓存 30 秒', async () => {
    const { ctx, headers } = await setup()
    let ready = false
    const calls = installFetch(() => jsonResponse({ ok: true, breeze: { ready } }))

    const first = await mobileBootstrap(ctx.app, headers)
    expect(first.body.voice?.tts?.enabled).toBe(false)
    expect(calls).toHaveLength(1)

    ready = true
    const cached = await mobileBootstrap(ctx.app, headers)
    expect(cached.body.voice?.tts?.enabled).toBe(false) // 还在 30 秒缓存里
    ctx.clock.advance(30_001)
    const fresh = await mobileBootstrap(ctx.app, headers)
    expect(fresh.body.voice?.tts?.enabled).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('健康探测失败（连不上）→ tts.enabled=false，不影响 asr 字段', async () => {
    const { ctx, headers } = await setup({ ...TTS_ENV, HUB_ASR_ENABLED: 'false' })
    installFetch(() => Promise.reject(new Error('ECONNREFUSED')))
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.body.voice?.tts?.enabled).toBe(false)
    expect(res.body.voice?.asr).toBe(false)
  })

  it('HUB_TTS_ENABLED=false：tts.enabled=false，且不发健康探测', async () => {
    const { ctx, headers } = await setup({ HUB_TTS_ENABLED: 'false' })
    const calls = installFetch(() => jsonResponse({ ok: true, breeze: { ready: true } }))
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.body.voice?.tts?.enabled).toBe(false)
    expect(res.body.voice?.tts?.stream).toBe(false) // WP51：朗读整体关掉时不谈流式
    expect(res.body.voice?.tts?.voices).toEqual(EXPECTED_VOICES)
    expect(calls).toHaveLength(0)
  })
})
