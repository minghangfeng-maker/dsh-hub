import { afterEach, describe, expect, it } from 'vitest'
import type { TestApp } from './helpers.js'
import { createTestApp, createUser, json } from './helpers.js'
import {
  ANTHROPIC_NON_STREAM_BODY,
  ANTHROPIC_STREAM_CHUNKS,
  OPENAI_NON_STREAM_BODY,
  OPENAI_STREAM_CHUNKS,
  RESPONSES_NON_STREAM_BODY,
  RESPONSES_STREAM_CHUNKS,
  grantMicro,
  issueKey,
  jsonResponse,
  setupChannelAndModel,
  sseResponse,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * `/v1` 端到端（12 §4 §5）：三协议 × 流式/非流式、字节透传、usage 入库、钱包扣费、日汇总。
 * 假上游是进程内 http server；应用侧一律 `app.inject`（除非要测客户端断开）。
 */

/** service 调用要的请求元信息（RequestMeta 的 userAgent 是必填） */
const META = { ip: '127.0.0.1', userAgent: 'vitest' }

let ctx: TestApp | undefined
let upstream: FakeUpstream | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
})

async function setup(): Promise<{ app: TestApp; user: { id: number }; key: string }> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const user = await createUser(ctx.app, { username: 'relay-user' })
  grantMicro(ctx.app, user.id, 100_000_000) // 100 积分
  const key = issueKey(ctx.app, user.id)
  return { app: ctx, user, key }
}

function usageRows(app: TestApp, userId: number) {
  return app.app.deps.db.all<{
    model: string
    status: string
    source: string
    stream: number
    attempts: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    cost: number
    estimated: number
    upstream_model: string | null
    http_status: number | null
    error: string | null
    ttft_ms: number | null
    duration_ms: number | null
  }>('SELECT * FROM relay_usage WHERE user_id = ? ORDER BY id ASC', userId)
}

function wallet(app: TestApp, userId: number) {
  return app.app.deps.db.get<{ balance: number; total_spent: number }>(
    'SELECT balance, total_spent FROM relay_wallets WHERE user_id = ?',
    userId,
  )!
}

describe('三协议 × 流式/非流式（12 §4 §5）', () => {
  it('openai-completions 非流式：字节透传 + usage 入库 + 钱包扣费 + 日汇总', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url })

    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    // 字节原样（不重新序列化）
    expect(res.body).toBe(JSON.stringify(OPENAI_NON_STREAM_BODY))
    expect(res.headers['x-dshhub-request-id']).toBeTruthy()
    // 上游收到改写后的 model 与鉴权，客户端鉴权头不转发
    const sent = upstream.requests[0]!
    expect(sent.url).toBe('/chat/completions')
    expect(sent.json?.model).toBe('upstream-model')
    expect(sent.headers.authorization).toBe('Bearer upstream-key-1')

    const rows = usageRows(app, user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'ok',
      source: 'local',
      stream: 0,
      input_tokens: 100,
      output_tokens: 40,
      attempts: 1,
      upstream_model: 'upstream-model',
      http_status: 200,
    })
    // 1 积分/百万输入 + 2 积分/百万输出 = 100 + 80 = 180 微积分
    expect(rows[0]!.cost).toBe(180)
    // 首字节耗时与总耗时都记了（12 §5.4）
    expect(rows[0]!.ttft_ms).not.toBeNull()
    expect(rows[0]!.duration_ms).not.toBeNull()
    expect(wallet(app, user.id).balance).toBe(100_000_000 - 180)
    const daily = app.app.deps.db.get<{ requests: number; cost: number; day: string }>(
      'SELECT requests, cost, day FROM relay_usage_daily WHERE user_id = ?',
      user.id,
    )!
    expect(daily).toMatchObject({ requests: 1, cost: 180 })
  })

  it('openai-responses 非流式：缓存 token 从 input 里减去', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, RESPONSES_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'resp-model' })

    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'resp-model', input: 'hi' },
    })
    expect(res.statusCode).toBe(200)
    expect(upstream.requests[0]!.url).toBe('/responses')
    const row = usageRows(app, user.id)[0]!
    expect(row.input_tokens).toBe(56) // 60 - 4
    expect(row.cache_read_tokens).toBe(4)
    // 缓存价缺省 = 输入价：56 + 4（缓存读）+ 40（输出 ×2）
    expect(row.cost).toBe(100)
  })

  it('anthropic-messages 非流式：input 不含缓存', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, ANTHROPIC_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'claude-model' })

    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': key },
      payload: { model: 'claude-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    const sent = upstream.requests[0]!
    expect(sent.url).toBe('/messages')
    expect(sent.headers['x-api-key']).toBe('upstream-key-1')
    expect(sent.headers['anthropic-version']).toBe('2023-06-01')
    const row = usageRows(app, user.id)[0]!
    expect(row.input_tokens).toBe(80)
    expect(row.cache_read_tokens).toBe(10)
    expect(row.cache_write_tokens).toBe(5)
    expect(row.cost).toBe(80 + 10 + 5 + 50)
  })

  it('openai-completions 流式：透传字节一致 + include_usage 自动补上', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => sseResponse(res, OPENAI_STREAM_CHUNKS))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'stream-model' })

    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'stream-model', stream: true, messages: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-accel-buffering']).toBe('no')
    expect(res.body).toBe(OPENAI_STREAM_CHUNKS.join(''))
    // 渠道开着 streamUsage → 自动补 stream_options.include_usage
    expect(upstream.requests[0]!.json?.stream_options).toEqual({ include_usage: true })
    const row = usageRows(app, user.id)[0]!
    expect(row).toMatchObject({ status: 'ok', stream: 1, input_tokens: 100, output_tokens: 40, estimated: 0 })
  })

  it('渠道关掉 streamUsage 时不补 include_usage', async () => {
    const { app, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => sseResponse(res, OPENAI_STREAM_CHUNKS))
    await setupChannelAndModel(app.app, {
      upstreamUrl: upstream.url,
      streamUsage: false,
      modelName: 'no-usage-model',
    })
    await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'no-usage-model', stream: true, messages: [] },
    })
    expect(upstream.requests[0]!.json?.stream_options).toBeUndefined()
  })

  it('anthropic 流式：message_start + message_delta 合并计费', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => sseResponse(res, ANTHROPIC_STREAM_CHUNKS))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'claude-stream' })

    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': key },
      payload: { model: 'claude-stream', stream: true, messages: [] },
    })
    expect(res.body).toBe(ANTHROPIC_STREAM_CHUNKS.join(''))
    const row = usageRows(app, user.id)[0]!
    expect(row.input_tokens).toBe(80)
    expect(row.cache_read_tokens).toBe(10)
    expect(row.cache_write_tokens).toBe(5)
    expect(row.output_tokens).toBe(25)
    expect(row.cost).toBe(80 + 10 + 5 + 50)
  })

  it('openai-responses 流式：response.completed 里取 usage', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => sseResponse(res, RESPONSES_STREAM_CHUNKS))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'resp-stream' })
    await app.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'resp-stream', stream: true, input: 'hi' },
    })
    const row = usageRows(app, user.id)[0]!
    expect(row.input_tokens).toBe(56)
    expect(row.cache_read_tokens).toBe(4)
    expect(row.output_tokens).toBe(20)
  })

  it('请求了 stream 但上游回整段 JSON：按 JSON 取 usage，不估算', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, ANTHROPIC_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'claude-ignores-stream' })

    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': key },
      payload: { model: 'claude-ignores-stream', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    const row = usageRows(app, user.id)[0]!
    expect(row.estimated).toBe(0)
    expect(row.input_tokens).toBe(80)
    expect(row.cost).toBe(80 + 10 + 5 + 50)
  })

  it('上游没回 usage → 按字数估算并标 estimated', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) =>
      jsonResponse(res, 200, { id: 'x', choices: [{ message: { content: 'abcdefgh' } }] }),
    )
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'no-usage' })
    await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'no-usage', messages: [{ role: 'user', content: '你好世界' }] },
    })
    const row = usageRows(app, user.id)[0]!
    expect(row.estimated).toBe(1)
    expect(row.input_tokens).toBeGreaterThan(0)
  })

  it('GET /v1/models 同时满足两家的列表格式，且只列可用模型', async () => {
    const { app, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, {}))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'm1' })
    const res = await app.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
    const body = json<{
      object: string
      data: { id: string; object: string; type: string; owned_by: string }[]
    }>(res)
    expect(body.object).toBe('list')
    // 16 §3：只列 `模型@渠道标识`，不再列不带 @ 的原名（不带 @ 的仍可调用）
    expect(body.data.map((item) => item.id)).toHaveLength(1)
    expect(body.data[0]!.id).toMatch(/^m1@[a-z0-9][a-z0-9-]{0,23}$/)
    expect(body.data[0]).toMatchObject({ object: 'model', type: 'model', owned_by: 'dsh-hub' })
  })

  it('count_tokens 透传但不计费、不记用量', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, { input_tokens: 12 }))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url, modelName: 'ct-model' })
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { 'x-api-key': key },
      payload: { model: 'ct-model', messages: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(upstream.requests[0]!.url).toBe('/messages/count_tokens')
    expect(usageRows(app, user.id)).toHaveLength(0)
  })
})

describe('进门检查（12 §4）', () => {
  it('无效密钥：两种错误体格式', async () => {
    const { app } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url })

    const openai = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-dsh-not-a-real-key' },
      payload: { model: 'test-model', messages: [] },
    })
    expect(openai.statusCode).toBe(401)
    expect(json<{ error: { code: string } }>(openai).error.code).toBe('invalid_api_key')

    const anthropic = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'sk-dsh-nope' },
      payload: { model: 'test-model', messages: [] },
    })
    expect(anthropic.statusCode).toBe(401)
    expect(json<{ type: string; error: { type: string } }>(anthropic)).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    })
  })

  it('总开关关闭 → 503；未知模型 → 404；协议不支持 → 400；没有可用渠道 → 503', async () => {
    const { app, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    const { channelId } = await setupChannelAndModel(app.app, {
      upstreamUrl: upstream.url,
      apis: ['anthropic-messages'],
    })

    const unknown = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'nope', messages: [] },
    })
    expect(unknown.statusCode).toBe(404)

    const unsupported = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'test-model', messages: [] },
    })
    expect(unsupported.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(unsupported).error.code).toBe('unsupported_endpoint')

    // 渠道停用 → 没有可用渠道 503
    relayServiceUpdate(app, channelId, { enabled: false })
    const noChannel = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': key },
      payload: { model: 'test-model', messages: [] },
    })
    expect(noChannel.statusCode).toBe(503)
    expect(json<{ error: { type: string } }>(noChannel).error.type).toBe('overloaded_error')

    // 总开关关闭 → 503
    app.app.deps.services.relay.updateSettings({ enabled: false }, 1, META)
    const off = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': key },
      payload: { model: 'test-model', messages: [] },
    })
    expect(off.statusCode).toBe(503)
    expect(json<{ error: { type: string } }>(off).error.type).toBe('api_error')
  })

  it('钱包停用 / 余额 0 / 日上限 / 并发满 分别 403 / 402 / 402 / 429', async () => {
    const { app, user, key } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url })
    const service = app.app.deps.services.relay

    const call = () =>
      app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'test-model', messages: [] },
      })

    service.updateWallet(user.id, { enabled: false }, 1, META)
    expect((await call()).statusCode).toBe(403)
    service.updateWallet(user.id, { enabled: true }, 1, META)

    // 余额清零：402 而不是 429（pi-ai 会对 429 自动重试，余额不足重试没有意义）
    app.app.deps.db.run('UPDATE relay_wallets SET balance = 0 WHERE user_id = ?', user.id)
    const broke = await call()
    expect(broke.statusCode).toBe(402)
    expect(json<{ error: { code: string } }>(broke).error.code).toBe('insufficient_points')

    app.app.deps.db.run('UPDATE relay_wallets SET balance = 1000000 WHERE user_id = ?', user.id)
    service.updateWallet(user.id, { dailyLimitMicro: 1 }, 1, META)
    // 今天已经花过钱（上一次成功的调用）→ 日上限 1 微积分必然已超
    app.app.deps.db.run(
      `INSERT INTO relay_usage_daily (day, user_id, model, channel_id, requests, errors, cost)
       VALUES (?, ?, 'test-model', 0, 1, 0, 5)`,
      new Date(app.clock.now().getTime() + 8 * 3600_000).toISOString().slice(0, 10),
      user.id,
    )
    const limited = await call()
    expect(limited.statusCode).toBe(402)
    expect(json<{ error: { code: string } }>(limited).error.code).toBe('daily_limit_reached')
    service.updateWallet(user.id, { dailyLimitMicro: null }, 1, META)

    service.updateWallet(user.id, { maxConcurrency: 1 }, 1, META)
    // 并发满：上游拖着不回，第一个请求占住额度，第二个必须 429
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    upstream.setHandler(async (_req, res) => {
      await held
      jsonResponse(res, 200, OPENAI_NON_STREAM_BODY)
    })
    const first = call()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const second = await call()
    expect(second.statusCode).toBe(429)
    expect(json<{ error: { code: string } }>(second).error.code).toBe('concurrency_limit')
    release()
    expect((await first).statusCode).toBe(200)
  })

  it('无效密钥按 IP 限流（20 次/分钟）', async () => {
    const { app } = await setup()
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(app.app, { upstreamUrl: upstream.url })
    let last = 0
    for (let index = 0; index < 21; index += 1) {
      const res = await app.app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer sk-dsh-bad-key' },
        remoteAddress: '203.0.113.9',
      })
      last = res.statusCode
    }
    expect(last).toBe(429)
  })
})

/** 直接改渠道（测试里改启用状态用） */
function relayServiceUpdate(app: TestApp, channelId: number, patch: { enabled?: boolean }): void {
  app.app.deps.services.relay.updateChannel(channelId, patch, 1, META)
}
