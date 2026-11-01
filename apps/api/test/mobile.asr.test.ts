import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { MOBILE_ASR_MAX_SECONDS } from '@dsh-hub/shared'
import { createTestApp, createUser, json, type TestApp } from './helpers.js'
import { MOBILE_APP_ORIGIN, mobileBootstrap, mobileSession } from './helpers-mobile.js'

/**
 * `POST /api/mobile/asr` 与 `bootstrap.voice`（WP49）。
 *
 * 上游 `dsh-asr` 用 `vi.stubGlobal('fetch')` 替身：这些用例只验证 Hub 的边界
 * （鉴权 / Content-Type / 大小 / lang / 限流 / 错误码映射 / 审计不含文字）；
 * 真实识别链路由集成冒烟脚本覆盖（未随开源版发布）。
 */

const ASR_ENV = { HUB_ASR_ENABLED: 'true', HUB_ASR_URL: 'http://asr.test' }

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

/** 造一段合法的 16k/单声道/16bit PCM WAV（正弦波，内容不重要）。 */
function wavBytes(durationMs = 200): Buffer {
  const sampleRate = 16_000
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

const contexts: TestApp[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.close()
})

interface Setup {
  ctx: TestApp
  headers: Record<string, string>
}

async function setup(env: Record<string, string> = ASR_ENV): Promise<Setup> {
  const ctx = await createTestApp({ env })
  contexts.push(ctx)
  const alice = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
  const { headers } = await mobileSession(ctx.app, alice)
  return { ctx, headers }
}

async function postAsr(
  app: FastifyInstance,
  headers: Record<string, string>,
  opts: {
    payload?: Buffer | string
    contentType?: string
    query?: string
    authenticated?: boolean
  } = {},
): Promise<{ status: number; body: Record<string, unknown>; errorCode?: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/mobile/asr${opts.query ?? ''}`,
    headers: {
      origin: MOBILE_APP_ORIGIN,
      ...(opts.authenticated === false ? {} : { authorization: headers.authorization! }),
      'content-type': opts.contentType ?? 'audio/wav',
    },
    payload: opts.payload ?? wavBytes(),
  })
  const body = json<Record<string, unknown>>(response)
  const errorCode =
    typeof body['error'] === 'object' && body['error'] !== null
      ? String((body['error'] as { code?: unknown }).code ?? '')
      : undefined
  return { status: response.statusCode, body, errorCode }
}

function auditDetail(ctx: TestApp): Record<string, unknown> {
  const row = ctx.app.deps.db.get<{ detail_json: string }>(
    'SELECT detail_json FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1',
    'mobile.asr',
  )
  return JSON.parse(row!.detail_json) as Record<string, unknown>
}

describe('POST /api/mobile/asr', () => {
  it('鉴权：没有设备令牌 401，且不会碰上游', async () => {
    const { ctx } = await setup()
    const calls = installFetch(() => jsonResponse({ text: '你好', durationMs: 200 }))
    const res = await postAsr(ctx.app, {}, { authenticated: false })
    expect(res.status).toBe(401)
    expect(res.errorCode).toBe('UNAUTHENTICATED')
    expect(calls).toHaveLength(0)
  })

  it('415：Content-Type 不是 audio/wav（JSON 与 audio/mp4 两条路径）', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => jsonResponse({ text: '', durationMs: 0 }))

    const asJson = await postAsr(ctx.app, headers, { contentType: 'application/json', payload: '{}' })
    expect(asJson.status).toBe(415)
    expect(asJson.errorCode).toBe('UNSUPPORTED_MEDIA')

    const asMp4 = await postAsr(ctx.app, headers, { contentType: 'audio/mp4' })
    expect(asMp4.status).toBe(415)
    expect(asMp4.errorCode).toBe('UNSUPPORTED_MEDIA')
    expect(calls).toHaveLength(0)
  })

  it('413：超过 MOBILE_ASR_MAX_BYTES 的 body 在解析阶段就被拒', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => jsonResponse({ text: '', durationMs: 0 }))
    // 比契约上限多 1 字节；仍小于 Fastify 全局 2MB JSON 限制，验证的是路由级 bodyLimit
    const big = Buffer.alloc(1_921_025, 1)
    const res = await postAsr(ctx.app, headers, { payload: big })
    expect(res.status).toBe(413)
    expect(res.errorCode).toBe('PAYLOAD_TOO_LARGE')
    expect(calls).toHaveLength(0)
  })

  it('400：空 body 与非法 lang 都在本地拒绝，不转发', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => jsonResponse({ text: '', durationMs: 0 }))

    const empty = await postAsr(ctx.app, headers, { payload: Buffer.alloc(0) })
    expect(empty.status).toBe(400)
    expect(empty.errorCode).toBe('VALIDATION_FAILED')

    const badLang = await postAsr(ctx.app, headers, { query: '?lang=fr' })
    expect(badLang.status).toBe(400)
    expect(badLang.errorCode).toBe('VALIDATION_FAILED')
    expect(calls).toHaveLength(0)
  })

  it('成功：转发 audio/wav 到 /transcribe、默认 lang=zh，返回契约字段', async () => {
    const { ctx, headers } = await setup()
    const audio = wavBytes(500)
    const calls = installFetch(() => jsonResponse({ text: '开饭时间早上9点至下午5点。', durationMs: 500 }))
    const res = await postAsr(ctx.app, headers, { payload: audio })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ text: '开饭时间早上9点至下午5点。', durationMs: 500 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://asr.test/transcribe?lang=zh')
    expect(calls[0]!.init.method).toBe('POST')
    const forwarded = calls[0]!.init.headers as Record<string, string>
    expect(forwarded['content-type']).toBe('audio/wav')
    expect(Buffer.from(calls[0]!.init.body as Uint8Array)).toEqual(audio)
  })

  it('lang 透传：audio/wav 带参数也能识别；?lang=en 原样转发', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => jsonResponse({ text: 'hello', durationMs: 300 }))
    const res = await postAsr(ctx.app, headers, {
      contentType: 'audio/wav; charset=binary',
      query: '?lang=en',
    })
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe('http://asr.test/transcribe?lang=en')
  })

  it('错误码映射：上游 400/413/415 原样透传，其它 5xx → 502', async () => {
    const { ctx, headers } = await setup()
    const cases: Array<[number, number, string]> = [
      [400, 400, 'VALIDATION_FAILED'],
      [413, 413, 'PAYLOAD_TOO_LARGE'],
      [415, 415, 'UNSUPPORTED_MEDIA'],
      [500, 502, 'UPSTREAM_ERROR'],
      [504, 502, 'UPSTREAM_ERROR'],
    ]
    for (const [upstream, status, code] of cases) {
      const calls = installFetch(() => new Response('{}', { status: upstream }))
      const res = await postAsr(ctx.app, headers)
      expect(res.status, `upstream ${upstream}`).toBe(status)
      expect(res.errorCode, `upstream ${upstream}`).toBe(code)
      expect(calls).toHaveLength(1)
    }
  })

  it('上游 429（识别服务并发满）→ 契约 429 RATE_LIMITED', async () => {
    const { ctx, headers } = await setup()
    installFetch(() => new Response('{}', { status: 429 }))
    const res = await postAsr(ctx.app, headers)
    expect(res.status).toBe(429)
    expect(res.errorCode).toBe('RATE_LIMITED')
    expect((res.body['error'] as { details?: { retryAfterSec?: number } }).details?.retryAfterSec).toBe(2)
  })

  it('上游超时（AbortSignal 25 秒的映射路径）→ 502 UPSTREAM_ERROR', async () => {
    const { ctx, headers } = await setup({ ...ASR_ENV, HUB_ASR_TIMEOUT_MS: '150' })
    const calls = installFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    const started = Date.now()
    const res = await postAsr(ctx.app, headers)
    expect(res.status).toBe(502)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    // 真的等到了 AbortSignal.timeout 触发，而不是同步抛错
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  it('上游返回垃圾 JSON → 502，而不是把坏数据透给 App', async () => {
    const { ctx, headers } = await setup()
    installFetch(() => new Response('not json', { status: 200 }))
    const res = await postAsr(ctx.app, headers)
    expect(res.status).toBe(502)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
  })

  it('审计只记字节数/时长/耗时/ok，不记文字', async () => {
    const { ctx, headers } = await setup()
    const text = '这一段文字绝不能出现在审计里'
    installFetch(() => jsonResponse({ text, durationMs: 700 }))
    const res = await postAsr(ctx.app, headers)
    expect(res.status).toBe(200)

    const detail = auditDetail(ctx)
    expect(Object.keys(detail).sort()).toEqual(['bytes', 'durationMs', 'ms', 'ok'])
    expect(detail['ok']).toBe(true)
    expect(detail['durationMs']).toBe(700)
    expect(typeof detail['bytes']).toBe('number')
    expect(typeof detail['ms']).toBe('number')
    expect(JSON.stringify(detail)).not.toContain(text)
  })

  it('失败也审计（ok=false），仍然不记文字', async () => {
    const { ctx, headers } = await setup()
    installFetch(() => new Response('{}', { status: 500 }))
    const res = await postAsr(ctx.app, headers)
    expect(res.status).toBe(502)
    const detail = auditDetail(ctx)
    expect(Object.keys(detail).sort()).toEqual(['bytes', 'ms', 'ok'])
    expect(detail['ok']).toBe(false)
  })

  it('每分钟限流：第 3 次拒绝，不碰上游；推进 60 秒后恢复', async () => {
    const { ctx, headers } = await setup({ ...ASR_ENV, HUB_ASR_PER_MINUTE: '2', HUB_ASR_PER_DAY: '100' })
    const calls = installFetch(() => jsonResponse({ text: '好', durationMs: 100 }))
    expect((await postAsr(ctx.app, headers)).status).toBe(200)
    expect((await postAsr(ctx.app, headers)).status).toBe(200)
    const limited = await postAsr(ctx.app, headers)
    expect(limited.status).toBe(429)
    expect(limited.errorCode).toBe('RATE_LIMITED')
    expect(
      (limited.body['error'] as { details?: { retryAfterSec?: number } }).details?.retryAfterSec,
    ).toBeGreaterThan(0)
    expect(calls).toHaveLength(2)

    ctx.clock.advance(60_001)
    expect((await postAsr(ctx.app, headers)).status).toBe(200)
    expect(calls).toHaveLength(3)
  })

  it('每天限流：跨过分钟窗口后按 429 拒绝', async () => {
    const { ctx, headers } = await setup({ ...ASR_ENV, HUB_ASR_PER_MINUTE: '100', HUB_ASR_PER_DAY: '2' })
    const calls = installFetch(() => jsonResponse({ text: '好', durationMs: 100 }))
    expect((await postAsr(ctx.app, headers)).status).toBe(200)
    expect((await postAsr(ctx.app, headers)).status).toBe(200)
    ctx.clock.advance(60_001)
    const limited = await postAsr(ctx.app, headers)
    expect(limited.status).toBe(429)
    expect(limited.errorCode).toBe('RATE_LIMITED')
    expect(calls).toHaveLength(2)
  })

  it('HUB_ASR_ENABLED=false：端点 502（契约没有「关闭」码），也不碰上游', async () => {
    const { ctx, headers } = await setup({ HUB_ASR_ENABLED: 'false', HUB_ASR_URL: 'http://asr.test' })
    const calls = installFetch(() => jsonResponse({ text: '好', durationMs: 100 }))
    const res = await postAsr(ctx.app, headers)
    expect(res.status).toBe(502)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
    expect(calls).toHaveLength(0)
  })
})

describe('GET /api/mobile/bootstrap · voice', () => {
  it('健康时 voice={asr:true,maxSeconds:60}，30 秒内复用缓存', async () => {
    const { ctx, headers } = await setup()
    const calls = installFetch(() => jsonResponse({ ok: true, ready: true }))

    const first = await mobileBootstrap(ctx.app, headers)
    expect(first.status).toBe(200)
    // WP50 起 `voice` 多了 `tts`（本节只关心 ASR 字段，故用 toMatchObject）
    expect(first.body.voice).toMatchObject({ asr: true, maxSeconds: MOBILE_ASR_MAX_SECONDS })
    expect(calls.map((call) => call.url)).toEqual(['http://asr.test/health'])

    const second = await mobileBootstrap(ctx.app, headers)
    expect(second.body.voice?.asr).toBe(true)
    expect(calls).toHaveLength(1)

    ctx.clock.advance(30_001)
    const third = await mobileBootstrap(ctx.app, headers)
    expect(third.body.voice?.asr).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('识别服务不健康 → asr=false，失败结果同样缓存 30 秒', async () => {
    const { ctx, headers } = await setup()
    let healthy = false
    const calls = installFetch(() => jsonResponse({ ok: healthy }))

    const first = await mobileBootstrap(ctx.app, headers)
    expect(first.body.voice).toMatchObject({ asr: false, maxSeconds: MOBILE_ASR_MAX_SECONDS })
    expect(calls).toHaveLength(1)

    healthy = true
    const cached = await mobileBootstrap(ctx.app, headers)
    expect(cached.body.voice?.asr).toBe(false) // 还在 30 秒缓存里
    ctx.clock.advance(30_001)
    const fresh = await mobileBootstrap(ctx.app, headers)
    expect(fresh.body.voice?.asr).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('HUB_ASR_ENABLED=false：voice.asr=false，且不发健康探测', async () => {
    const { ctx, headers } = await setup({ HUB_ASR_ENABLED: 'false' })
    const calls = installFetch(() => jsonResponse({ ok: true }))
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.body.voice).toMatchObject({ asr: false, maxSeconds: MOBILE_ASR_MAX_SECONDS })
    expect(calls).toHaveLength(0)
  })
})
