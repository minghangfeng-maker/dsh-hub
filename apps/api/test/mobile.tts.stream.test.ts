import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { MOBILE_TTS_MAX_CHARS, MOBILE_TTS_STREAM_PATH } from '@dsh-hub/shared'
import { createTestApp, createUser, json, type TestApp } from './helpers.js'
import { MOBILE_APP_ORIGIN, mobileBootstrap, mobileSession } from './helpers-mobile.js'

/**
 * `POST /api/mobile/tts/stream`（WP51）：流式朗读。
 *
 * 这些用例**必须用真实端口**：`app.inject` 会把响应攒到最后一次性给出来，测不出
 * 「边合成边下发」与「中途断开连接」。所以每个用例起两个真的 HTTP 服务：
 * 1. 假上游（`node:http`）扮演星汐语音服务的 `/tts/stream`，按用例控制分块节奏/失败方式；
 * 2. Hub 自己 `listen(0)`，客户端用 Node 的 fetch 读 `response.body` 的分块。
 *
 * 真实 seki-voice **不参与**（另起服务会抢 GPU 且影响线上星汐）。
 */

const SAMPLE_RATE = 24_000
const CHUNK_BYTES = 4_096
const TOTAL_CHUNKS = 4
const GAP_MS = 50
/**
 * 「首块很快」的上限：给到 3 个间隔（4 块里最后一块产出的时刻），仍能区分「边合成边发」与「整段合成完才发」，
 * 又不会在 CI 的 2 核机器上因为几十毫秒的调度抖动误报。
 */
const FIRST_CHUNK_BUDGET_MS = GAP_MS * 3

const STREAM_ENV = {
  HUB_TTS_ENABLED: 'true',
  HUB_TTS_STREAM_ENABLED: 'true',
  // 默认保守值放到 2 秒，只有专门的超时用例才调小
  HUB_TTS_STREAM_IDLE_TIMEOUT_MS: '2000',
  HUB_TTS_STREAM_TIMEOUT_MS: '20000',
}

// ── 假上游 ──────────────────────────────────────────────────────────────────

interface UpstreamHit {
  method: string
  url: string
  body: string
}

type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void

interface FakeUpstream {
  url: string
  hits: UpstreamHit[]
  handler: UpstreamHandler
  /** 上游把响应写完的时刻（证明「客户端在上游结束前就收到前几块」） */
  finishedAt: number | null
  close(): Promise<void>
}

async function startUpstream(): Promise<FakeUpstream> {
  let handler: UpstreamHandler = (_req, res) => {
    writeAudioChunks(res)
  }
  const upstream: FakeUpstream = {
    url: '',
    hits: [],
    get handler() {
      return handler
    },
    set handler(next: UpstreamHandler) {
      handler = next
    },
    finishedAt: null,
    close: async () => undefined,
  }
  const server = createServer((req, res) => {
    // 客户端（Hub）中途断了之后我们还会写：接住 EPIPE，别让测试进程崩
    res.on('error', () => undefined)
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (piece: string) => {
      body += piece
    })
    req.on('end', () => {
      upstream.hits.push({ method: req.method ?? '', url: req.url ?? '', body })
      if ((req.url ?? '').split('?')[0] === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, breeze: { ready: true } }))
        return
      }
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  upstream.url = `http://127.0.0.1:${port}`
  upstream.close = async () => {
    // 假上游留着 keep-alive 连接（Hub 的 undici 池）会让 close() 永远等下去
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return upstream
}

function streamHeaders(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'audio/L16; rate=24000; channels=1',
    'x-seki-tts-backend': 'breeze',
    'x-seki-tts-sample-rate': String(SAMPLE_RATE),
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[key]
    else headers[key] = value
  }
  return headers
}

function pcmChunk(index: number, size = CHUNK_BYTES): Buffer {
  return Buffer.alloc(size, index + 1)
}

function fullPcm(): Buffer {
  return Buffer.concat(Array.from({ length: TOTAL_CHUNKS }, (_v, i) => pcmChunk(i)))
}

interface WriteAudioOptions {
  chunkCount?: number
  gapMs?: number
  headers?: Record<string, string | undefined>
  /** 写完最后一块时回调（记时间/断言用） */
  onEnd?: () => void
}

/**
 * 假上游的正常行为：立刻写响应头 + 第一块，之后每 `gapMs` 一块，最后 `res.end()`
 * （= 有分块结束标记的完整响应）。
 */
function writeAudioChunks(res: ServerResponse, opts: WriteAudioOptions = {}): void {
  const chunks = Array.from({ length: opts.chunkCount ?? TOTAL_CHUNKS }, (_v, i) => pcmChunk(i))
  const gapMs = opts.gapMs ?? GAP_MS
  let index = 0
  const tick = (): void => {
    const chunk = chunks[index]
    index += 1
    if (chunk === undefined) {
      clearInterval(timer)
      opts.onEnd?.()
      if (!res.writableEnded) res.end()
      return
    }
    if (!res.destroyed) res.write(chunk)
  }
  res.writeHead(200, streamHeaders(opts.headers))
  const timer = setInterval(tick, gapMs)
  tick()
  res.on('close', () => clearInterval(timer))
}

// ── Hub + 客户端 ────────────────────────────────────────────────────────────

interface UpstreamCtx {
  ctx: TestApp
  upstream: FakeUpstream
  base: string
  /** `Bearer dshm_at_…` */
  auth: string
  /** 当前用户（造第二个用户测全局排队用） */
  userId: number
}

const contexts: UpstreamCtx[] = []

afterEach(async () => {
  for (const item of contexts.splice(0)) {
    await item.ctx.close()
    await item.upstream.close()
  }
})

async function setup(env: Record<string, string> = {}): Promise<UpstreamCtx> {
  const upstream = await startUpstream()
  const ctx = await createTestApp({ env: { ...STREAM_ENV, HUB_TTS_URL: upstream.url, ...env } })
  // 真端口：inject 会把流攒完，测不了边合成边下发
  await ctx.app.listen({ port: 0, host: '127.0.0.1' })
  const address = ctx.app.server.address() as AddressInfo
  const alice = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
  const { headers } = await mobileSession(ctx.app, alice)
  const item: UpstreamCtx = {
    ctx,
    upstream,
    base: `http://127.0.0.1:${address.port}`,
    auth: headers.authorization!,
    userId: alice.id,
  }
  contexts.push(item)
  return item
}

interface ClientChunk {
  /** 相对请求开始的毫秒数 */
  at: number
  /** 绝对时刻（与上游 `finishedAt` 可比） */
  atAbsolute: number
  bytes: number
}

/** 上游第 index 块（每块 CHUNK_BYTES）最早到达客户端的那一次读；TCP 可能把一块拆成多次读 */
function arrivalOfBlock(chunks: ClientChunk[], index: number): ClientChunk {
  let seen = 0
  for (const chunk of chunks) {
    if (seen + chunk.bytes > index * CHUNK_BYTES) return chunk
    seen += chunk.bytes
  }
  throw new Error(`第 ${String(index)} 块没有到达`)
}

interface StreamResult {
  status: number
  headers: Headers
  chunks: ClientChunk[]
  pcm: Buffer
  /** JSON 错误体（status !== 200 时） */
  text: string
  /** 客户端看到连接被中断（没有正常结束标记） */
  aborted: boolean
  error: string
  startedAt: number
  totalMs: number
}

/**
 * 像 App 一样读流式响应：一拿到就逐块读，记下每块的到达时间。
 * `abortAfterChunks` = 读到第 N 块就 abort（模拟客户端提前断开）。
 */
async function postStream(
  item: UpstreamCtx,
  payload: unknown,
  opts: { abortAfterChunks?: number; text?: string } = {},
): Promise<StreamResult> {
  const controller = new AbortController()
  const startedAt = Date.now()
  const response = await fetch(`${item.base}${MOBILE_TTS_STREAM_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: item.auth,
      origin: MOBILE_APP_ORIGIN,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
  const chunks: ClientChunk[] = []
  const parts: Buffer[] = []
  let aborted = false
  let error = ''
  const body = response.body
  if (body !== null) {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const now = Date.now()
        chunks.push({ at: now - startedAt, atAbsolute: now, bytes: value.byteLength })
        parts.push(Buffer.from(value))
        if (opts.abortAfterChunks !== undefined && chunks.length >= opts.abortAfterChunks) {
          controller.abort()
          aborted = true
          break
        }
      }
    } catch (err) {
      aborted = true
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    chunks,
    pcm: Buffer.concat(parts),
    text: Buffer.concat(parts).toString('utf8'),
    aborted,
    error,
    startedAt,
    totalMs: Date.now() - startedAt,
  }
}

/** 非流式 `/tts`（用 inject 就够：整段一次性返回） */
async function postTts(item: UpstreamCtx, payload: unknown) {
  const response = await item.ctx.app.inject({
    method: 'POST',
    url: '/api/mobile/tts',
    headers: { 'content-type': 'application/json', authorization: item.auth, origin: MOBILE_APP_ORIGIN },
    payload: JSON.stringify(payload),
  })
  const contentType = String(response.headers['content-type'] ?? '')
  return {
    status: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    raw: response.rawPayload,
    body: contentType.includes('application/json') ? json<Record<string, unknown>>(response) : {},
  }
}

function errorCodeOf(body: Record<string, unknown>): string | undefined {
  const error = body['error']
  if (typeof error !== 'object' || error === null) return undefined
  return String((error as { code?: unknown }).code ?? '')
}

function retryAfterSecOf(body: Record<string, unknown>): number | undefined {
  const error = body['error'] as { details?: { retryAfterSec?: number } } | undefined
  return error?.details?.retryAfterSec
}

/** 第 `offset` 条 `mobile.tts` 审计（0 = 最新） */
function auditDetail(item: UpstreamCtx, offset = 0): Record<string, unknown> {
  const rows = item.ctx.app.deps.db.all<{ detail_json: string }>(
    'SELECT detail_json FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 10',
    'mobile.tts',
  )
  const row = rows[offset]
  if (row === undefined) throw new Error(`没有第 ${offset} 条 mobile.tts 审计`)
  return JSON.parse(row.detail_json) as Record<string, unknown>
}

function streamCalls(item: UpstreamCtx): UpstreamHit[] {
  return item.upstream.hits.filter((hit) => hit.url === '/tts/stream')
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('POST /api/mobile/tts/stream', () => {
  it('分块逐步到达：上游每 50ms 一块，客户端在上游结束前就收到前几块', async () => {
    const item = await setup()
    item.upstream.handler = (_req, res) => {
      writeAudioChunks(res, { onEnd: () => (item.upstream.finishedAt = Date.now()) })
    }

    const res = await postStream(item, { text: '边合成边下发' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/L16; rate=24000; channels=1')
    expect(res.headers.get('x-tts-sample-rate')).toBe('24000')
    expect(res.headers.get('x-tts-voice')).toBe('seki')
    expect(res.headers.get('x-tts-format')).toBe('pcm16le')
    expect(res.headers.get('x-tts-cached')).toBe('0')
    // 流式：不缓存、反代别攒、不压缩
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(res.headers.get('content-encoding')).toBeNull()
    // CORS：App 跨域要能读到四个自定义头
    expect(res.headers.get('access-control-allow-origin')).toBe(MOBILE_APP_ORIGIN)
    const exposed = String(res.headers.get('access-control-expose-headers'))
    for (const name of ['x-tts-sample-rate', 'x-tts-voice', 'x-tts-format', 'x-tts-cached']) {
      expect(exposed).toContain(name)
    }

    // 逐块：4 块 × 4096 字节，一块没被攒到一起（负载高时 TCP 可能把一块拆成两次读，所以只要求每次读不超过一块）
    expect(res.chunks.length).toBeGreaterThanOrEqual(TOTAL_CHUNKS)
    expect(res.chunks.every((chunk) => chunk.bytes <= CHUNK_BYTES)).toBe(true)
    expect(res.pcm.equals(fullPcm())).toBe(true)
    expect(res.aborted).toBe(false)

    // 关键：前两块在上游结束之前就到了（说明不是缓冲到最后才发）
    const finishedAt = item.upstream.finishedAt
    expect(finishedAt).not.toBeNull()
    const first = arrivalOfBlock(res.chunks, 0)
    const second = arrivalOfBlock(res.chunks, 1)
    expect(first.atAbsolute).toBeLessThan(finishedAt!)
    expect(second.atAbsolute).toBeLessThan(finishedAt!)
    // 首块很快（不是等整段合成完）
    expect(first.at).toBeLessThan(FIRST_CHUNK_BUDGET_MS)
    expect(second.at).toBeGreaterThanOrEqual(GAP_MS - 10)
    // 审计：stream=true、ttfb 有值、不记文字
    const detail = auditDetail(item)
    expect(Object.keys(detail).sort()).toEqual([
      'bytes',
      'cached',
      'chars',
      'ms',
      'ok',
      'stream',
      'ttfbMs',
      'voice',
    ])
    expect(detail['stream']).toBe(true)
    expect(detail['ok']).toBe(true)
    expect(detail['bytes']).toBe(TOTAL_CHUNKS * CHUNK_BYTES)
    expect(detail['ttfbMs']).toBeLessThan(FIRST_CHUNK_BUDGET_MS)
    expect(JSON.stringify(detail)).not.toContain('边合成边下发')
    // 转发给上游的是 {text, backend: breeze}
    expect(JSON.parse(streamCalls(item)[0]!.body)).toEqual({ text: '边合成边下发', backend: 'breeze' })
  })

  it('上游 503 / 错误 content-type / 非 breeze / 缺采样率 → 502 JSON（不会先发音频）', async () => {
    const item = await setup()
    const cases: Array<{ name: string; handler: UpstreamHandler }> = [
      {
        name: '503',
        handler: (_req, res) => {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{"error":"breeze not ready"}')
        },
      },
      {
        name: 'content-type',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html', 'x-seki-tts-backend': 'breeze' })
          res.end('<html>proxy error</html>')
        },
      },
      {
        name: 'backend',
        handler: (_req, res) => {
          res.writeHead(200, streamHeaders({ 'x-seki-tts-backend': 'piper' }))
          res.end(pcmChunk(0))
        },
      },
      {
        name: 'degraded',
        handler: (_req, res) => {
          res.writeHead(200, streamHeaders({ 'x-seki-tts-degraded': '1' }))
          res.end(pcmChunk(0))
        },
      },
      {
        name: 'no-sample-rate',
        handler: (_req, res) => {
          res.writeHead(
            200,
            streamHeaders({ 'x-seki-tts-sample-rate': undefined, 'content-type': 'audio/L16; channels=1' }),
          )
          res.end(pcmChunk(0))
        },
      },
    ]

    for (const [index, testCase] of cases.entries()) {
      item.upstream.handler = testCase.handler
      const res = await postStream(item, { text: `失败路径${index}` })
      expect(res.status, testCase.name).toBe(502)
      // 开始下发前失败：JSON 错误体，一点音频都没有发出去
      expect(res.headers.get('content-type'), testCase.name).toContain('application/json')
      expect(errorCodeOf(JSON.parse(res.text) as Record<string, unknown>)).toBe('UPSTREAM_ERROR')
      expect(auditDetail(item)['ok']).toBe(false)
    }

    // 上游失败不写缓存：换成正常上游后同一段仍然要重新合成
    item.upstream.handler = (_req, res) => writeAudioChunks(res)
    const callsBefore = streamCalls(item).length
    const ok = await postStream(item, { text: '失败路径0' })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-tts-cached')).toBe('0')
    expect(streamCalls(item).length).toBe(callsBefore + 1)
  })

  it('本地校验：未知音色 / 空文本 / 超长都 400，不转发', async () => {
    const item = await setup()
    const cases = [
      { text: '   ' },
      { text: '好'.repeat(MOBILE_TTS_MAX_CHARS + 1) },
      { text: '你好', voice: 'nobody' },
    ]
    for (const payload of cases) {
      const res = await postStream(item, payload)
      expect(res.status).toBe(400)
      expect(errorCodeOf(JSON.parse(res.text) as Record<string, unknown>)).toBe('VALIDATION_FAILED')
    }
    expect(streamCalls(item)).toHaveLength(0)
  })

  it('上游中途断开：客户端连接被中断（没有正常结束），且不写缓存', async () => {
    const item = await setup()
    item.upstream.handler = (_req, res) => {
      res.writeHead(200, streamHeaders())
      res.write(pcmChunk(0))
      res.write(pcmChunk(1))
      // 没有分块结束标记：直接掐断连接（星汐合成中途失败的表现）
      setTimeout(() => res.destroy(), 60)
    }

    const res = await postStream(item, { text: '合成到一半挂了' })
    expect(res.status).toBe(200) // 头已经发了，失败只能靠断连接表达
    expect(res.aborted).toBe(true)
    expect(res.error).not.toBe('') // 客户端读流时抛错（undici：TypeError: terminated）
    expect(res.pcm.length).toBeLessThan(TOTAL_CHUNKS * CHUNK_BYTES)
    expect(res.pcm.length).toBeGreaterThan(0)
    const detail = auditDetail(item)
    expect(detail['ok']).toBe(false)
    expect(detail['stream']).toBe(true)
    expect(detail).not.toHaveProperty('aborted')

    // 不写缓存：同一段再来一次仍然是新合成（打上游），而不是命中
    item.upstream.handler = (_req, res) => writeAudioChunks(res)
    const again = await postStream(item, { text: '合成到一半挂了' })
    expect(again.status).toBe(200)
    expect(again.headers.get('x-tts-cached')).toBe('0')
  })

  it('正常结束写缓存：/tts/stream 命中回 PCM（无 WAV 头）、/tts 命中回合法 WAV', async () => {
    const item = await setup()
    item.upstream.handler = (_req, res) => writeAudioChunks(res)

    const first = await postStream(item, { text: '缓存要能在两个接口之间互命中' })
    expect(first.status).toBe(200)
    expect(first.headers.get('x-tts-cached')).toBe('0')
    expect(first.pcm.equals(fullPcm())).toBe(true)
    expect(streamCalls(item)).toHaveLength(1)
    expect(auditDetail(item)['cached']).toBe(false)

    // 流式命中：一次性 PCM（同样 4 块内容），头是 1，不打上游
    const second = await postStream(item, { text: '缓存要能在两个接口之间互命中' })
    expect(second.status).toBe(200)
    expect(second.headers.get('x-tts-cached')).toBe('1')
    expect(second.pcm.equals(fullPcm())).toBe(true)
    expect(streamCalls(item)).toHaveLength(1)
    expect(auditDetail(item)['cached']).toBe(true)
    // 命中时没有上游首块，ttfb 记 0
    expect(auditDetail(item)['ttfbMs']).toBe(0)

    // 整段 /tts 命中的是**同一份**缓存：返回 44 字节头的合法 WAV
    const wav = await postTts(item, { text: '缓存要能在两个接口之间互命中' })
    expect(wav.status).toBe(200)
    expect(wav.headers['content-type']).toBe('audio/wav')
    expect(wav.headers['cache-control']).toBe('private, max-age=86400')
    expect(wav.headers['x-tts-sample-rate']).toBe('24000')
    expect(wav.raw.length).toBe(TOTAL_CHUNKS * CHUNK_BYTES + 44)
    expect(wav.raw.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.raw.toString('latin1', 8, 12)).toBe('WAVE')
    expect(wav.raw.readUInt32LE(24)).toBe(SAMPLE_RATE)
    expect(wav.raw.readUInt16LE(22)).toBe(1)
    expect(wav.raw.readUInt16LE(34)).toBe(16)
    expect(wav.raw.readUInt32LE(40)).toBe(TOTAL_CHUNKS * CHUNK_BYTES)
    expect(wav.raw.subarray(44).equals(fullPcm())).toBe(true)
  })

  it('客户端中途断开：上游仍被读完、写缓存、槽位释放，下一请求可进', async () => {
    const item = await setup()
    const upstreamDone = deferred()
    item.upstream.handler = (_req, res) => {
      writeAudioChunks(res, { onEnd: () => upstreamDone.resolve() })
    }
    const service = item.ctx.app.deps.services.mobileTts

    const res = await postStream(item, { text: '用户听到一半退出了' }, { abortAfterChunks: 1 })
    expect(res.chunks).toHaveLength(1)
    expect(res.aborted).toBe(true)

    // 客户端走了，但 Hub 必须把上游读完（不让星汐服务停在半截）
    await upstreamDone.promise
    await waitFor(() => service.stats().active === 0)

    const detail = auditDetail(item)
    expect(detail['aborted']).toBe('client')
    expect(detail['ok']).toBe(false)
    expect(detail['stream']).toBe(true)
    // 上游读完了：完整字节都记在审计里（但这一条请求不算 ok）
    expect(detail['bytes']).toBe(TOTAL_CHUNKS * CHUNK_BYTES)
    expect(Object.keys(detail).sort()).toEqual([
      'aborted',
      'bytes',
      'cached',
      'chars',
      'ms',
      'ok',
      'stream',
      'ttfbMs',
      'voice',
    ])

    // 读完的整段仍然写进缓存：同一段再问一次直接命中（不打上游）
    const callsBefore = streamCalls(item).length
    const replay = await postStream(item, { text: '用户听到一半退出了' })
    expect(replay.status).toBe(200)
    expect(replay.headers.get('x-tts-cached')).toBe('1')
    expect(replay.pcm.equals(fullPcm())).toBe(true)
    expect(streamCalls(item)).toHaveLength(callsBefore)

    // 槽位确实还给了队列：另一个请求马上能进
    const next = await postStream(item, { text: '下一段还能合成' })
    expect(next.status).toBe(200)
    expect(next.headers.get('x-tts-cached')).toBe('0')
    expect(service.stats().active).toBe(0)
  })

  it('排队中就断开：Hub 仍然读完上游，槽位不会卡住', async () => {
    const item = await setup()
    const gate = deferred()
    item.upstream.handler = (_req, res) => {
      res.writeHead(200, streamHeaders())
      res.write(pcmChunk(0))
      void gate.promise.then(() => {
        if (res.destroyed) return
        res.write(pcmChunk(1))
        res.end()
      })
    }
    const service = item.ctx.app.deps.services.mobileTts

    const first = postStream(item, { text: '占着槽位的第一段' })
    await waitFor(() => service.stats().active === 1)

    // 第二个请求还排在队里（连响应头都没拿到）时客户端就断了
    const controller = new AbortController()
    const queued = fetch(`${item.base}${MOBILE_TTS_STREAM_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: item.auth,
        origin: MOBILE_APP_ORIGIN,
      },
      body: JSON.stringify({ text: '排队中就断开的第二段' }),
      signal: controller.signal,
    }).catch(() => null)
    await waitFor(() => service.stats().queued === 1)
    controller.abort()
    await queued
    expect(service.stats().queued).toBe(1) // Hub 侧还在排队（槽位被第一段占着）

    gate.resolve()
    expect((await first).status).toBe(200)
    // 关键：槽位被释放、队列排空（不会因为「客户端断了」卡住）
    await waitFor(() => service.stats().active === 0 && service.stats().queued === 0)

    // 而且后来的请求照常能用
    item.upstream.handler = (_req, res) => writeAudioChunks(res, { chunkCount: 1 })
    const next = await postStream(item, { text: '后面还能合成' })
    expect(next.status).toBe(200)
    expect(next.headers.get('x-tts-cached')).toBe('0')
  })

  it('单用户在途上限对流式同样生效：第 3 个 429 retryAfterSec=2', async () => {
    const item = await setup()
    const gate = deferred()
    item.upstream.handler = (_req, res) => {
      res.writeHead(200, streamHeaders())
      res.write(pcmChunk(0))
      void gate.promise.then(() => {
        if (res.destroyed) return
        res.write(pcmChunk(1))
        res.end()
      })
    }
    const service = item.ctx.app.deps.services.mobileTts

    const first = postStream(item, { text: '第一个' })
    await waitFor(() => service.stats().active === 1)
    const second = postStream(item, { text: '第二个' })
    await waitFor(() => service.stats().queued === 1)

    const third = await postStream(item, { text: '第三个' })
    expect(third.status).toBe(429)
    expect(third.headers.get('content-type')).toContain('application/json')
    const body = JSON.parse(third.text) as Record<string, unknown>
    expect(errorCodeOf(body)).toBe('RATE_LIMITED')
    expect(retryAfterSecOf(body)).toBe(2)

    gate.resolve()
    const results = await Promise.all([first, second])
    expect(results.map((result) => result.status)).toEqual([200, 200])
    expect(results.every((result) => !result.aborted)).toBe(true)
    await waitFor(() => service.stats().active === 0)
  })

  it('每分钟限流对流式同样生效：第 3 段 429 且不碰上游', async () => {
    const item = await setup({ HUB_TTS_PER_MINUTE: '2', HUB_TTS_PER_DAY: '100' })
    item.upstream.handler = (_req, res) => writeAudioChunks(res, { chunkCount: 1 })

    expect((await postStream(item, { text: '一分钟一' })).status).toBe(200)
    expect((await postStream(item, { text: '一分钟二' })).status).toBe(200)
    const callsBefore = streamCalls(item).length
    const limited = await postStream(item, { text: '一分钟三' })
    expect(limited.status).toBe(429)
    const body = JSON.parse(limited.text) as Record<string, unknown>
    expect(errorCodeOf(body)).toBe('RATE_LIMITED')
    expect(retryAfterSecOf(body)).toBeGreaterThan(0)
    expect(streamCalls(item)).toHaveLength(callsBefore)

    // 命中缓存也算一段（与 /tts 规则一致）
    const cachedHit = await postStream(item, { text: '一分钟一' })
    expect(cachedHit.status).toBe(429)
  })

  it('空闲超时：上游发一块后卡住 → 客户端连接被中断，不写缓存', async () => {
    const item = await setup({ HUB_TTS_STREAM_IDLE_TIMEOUT_MS: '150' })
    item.upstream.handler = (_req, res) => {
      res.writeHead(200, streamHeaders())
      res.write(pcmChunk(0))
      // 之后不再发任何字节（也不用 end）：模拟上游卡死
    }

    const res = await postStream(item, { text: '上游卡住了' })
    expect(res.status).toBe(200)
    expect(res.aborted).toBe(true)
    expect(res.error).not.toBe('')
    expect(res.pcm.length).toBe(CHUNK_BYTES)
    expect(res.totalMs).toBeLessThan(3_000)
    expect(auditDetail(item)['ok']).toBe(false)

    item.upstream.handler = (_req, res) => writeAudioChunks(res)
    const again = await postStream(item, { text: '上游卡住了' })
    expect(again.headers.get('x-tts-cached')).toBe('0')
  })

  it('整段超时：上游一直慢慢发也会在到达时限时中断', async () => {
    const item = await setup({ HUB_TTS_STREAM_TIMEOUT_MS: '300', HUB_TTS_STREAM_IDLE_TIMEOUT_MS: '2000' })
    item.upstream.handler = (_req, res) => {
      // 每 60ms 一块、永远不发完：空闲超时不会触发，只有整段超时能救
      writeAudioChunks(res, { chunkCount: 100, gapMs: 60 })
    }

    const res = await postStream(item, { text: '永远合成不完' })
    expect(res.status).toBe(200)
    expect(res.aborted).toBe(true)
    expect(res.error).not.toBe('')
    expect(res.pcm.length).toBeLessThan(100 * CHUNK_BYTES)
    expect(res.totalMs).toBeLessThan(3_000)
    expect(auditDetail(item)['ok']).toBe(false)
  })

  it('HUB_TTS_STREAM_ENABLED=false：502 且不转发（整段 /tts 不受影响）', async () => {
    const item = await setup({ HUB_TTS_STREAM_ENABLED: 'false' })
    item.upstream.handler = (_req, res) => writeAudioChunks(res)

    const res = await postStream(item, { text: '流式关掉了' })
    expect(res.status).toBe(502)
    expect(errorCodeOf(JSON.parse(res.text) as Record<string, unknown>)).toBe('UPSTREAM_ERROR')
    expect(streamCalls(item)).toHaveLength(0)

    // 整段朗读仍然可用
    const whole = await postTts(item, { text: '整段还能用' })
    expect(whole.status).toBe(502) // 假上游只有 /tts/stream，没有 /tts → 502 说明请求确实发了
    expect(item.upstream.hits.filter((hit) => hit.url === '/tts')).toHaveLength(1)
  })
})

describe('GET /api/mobile/bootstrap · voice.tts.stream', () => {
  it('breeze 就绪且开关打开 → stream: true', async () => {
    const item = await setup()
    const res = await mobileBootstrap(item.ctx.app, {
      authorization: item.auth,
      origin: MOBILE_APP_ORIGIN,
    })
    expect(res.status).toBe(200)
    expect(res.body.voice?.tts?.enabled).toBe(true)
    expect(res.body.voice?.tts?.stream).toBe(true)
  })

  it('HUB_TTS_STREAM_ENABLED=false → stream: false（整段朗读仍 enabled）', async () => {
    const item = await setup({ HUB_TTS_STREAM_ENABLED: 'false' })
    const res = await mobileBootstrap(item.ctx.app, {
      authorization: item.auth,
      origin: MOBILE_APP_ORIGIN,
    })
    expect(res.body.voice?.tts?.enabled).toBe(true)
    expect(res.body.voice?.tts?.stream).toBe(false)
  })

  it('HUB_TTS_ENABLED=false → enabled 与 stream 都是 false，且不探测上游', async () => {
    const item = await setup({ HUB_TTS_ENABLED: 'false' })
    const res = await mobileBootstrap(item.ctx.app, {
      authorization: item.auth,
      origin: MOBILE_APP_ORIGIN,
    })
    expect(res.body.voice?.tts?.enabled).toBe(false)
    expect(res.body.voice?.tts?.stream).toBe(false)
    expect(item.upstream.hits.filter((hit) => hit.url === '/health')).toHaveLength(0)
  })
})
