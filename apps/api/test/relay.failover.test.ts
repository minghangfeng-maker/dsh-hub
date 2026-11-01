import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { TestApp } from './helpers.js'
import { createTestApp, createUser, json } from './helpers.js'
import {
  OPENAI_NON_STREAM_BODY,
  OPENAI_STREAM_CHUNKS,
  createChannel,
  createRelayModel,
  grantMicro,
  issueKey,
  jsonResponse,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * 失败切换与中断（12 §5.2 §5.4）。两类"断开"要分清楚：
 * - **上游**在流式开始后断开 → 不重试，状态 `upstream_error`；
 * - **客户端**中途断开 → 中止上游请求，状态 `aborted`，按已见 usage 或估算计费。
 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

let ctx: TestApp | undefined
const upstreams: FakeUpstream[] = []

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  for (const upstream of upstreams.splice(0)) await upstream.close()
})

async function setup(): Promise<{ app: TestApp; userId: number; key: string }> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const user = await createUser(ctx.app, { username: 'failover-user' })
  grantMicro(ctx.app, user.id, 100_000_000)
  const key = issueKey(ctx.app, user.id)
  return { app: ctx, userId: user.id, key }
}

/** 建一个渠道（可指定失败行为） */
function channel(
  app: TestApp,
  baseUrl: string,
  options: { name: string; priority?: number; keys?: string[] },
) {
  return createChannel(app.app, {
    name: options.name,
    baseUrl,
    apis: ['openai-completions'],
    priority: options.priority ?? 0,
    keys: options.keys ?? [`key-${options.name}`],
  })
}

function usageRows(app: TestApp, userId: number) {
  return app.app.deps.db.all<{
    status: string
    attempts: number
    cost: number
    estimated: number
    http_status: number | null
    channel_id: number | null
    error: string | null
    input_tokens: number
    output_tokens: number
  }>('SELECT * FROM relay_usage WHERE user_id = ? ORDER BY id ASC', userId)
}

function call(app: TestApp, key: string, payload: Record<string, unknown> = {}) {
  return app.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}` },
    payload: { model: 'test-model', messages: [], ...payload },
  })
}

describe('失败切换（12 §5.2）', () => {
  it('第一个渠道 500 → 换第二个成功，attempts=2，只记一条用量', async () => {
    const { app, userId, key } = await setup()
    const bad = await startFakeUpstream((_req, res) => jsonResponse(res, 500, { error: 'boom' }))
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(bad, good)
    const badChannel = channel(app, bad.url, { name: 'bad500', priority: 10 })
    const goodChannel = channel(app, good.url, { name: 'good' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: badChannel.id, upstreamModel: 'up-bad', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })

    const res = await call(app, key)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(JSON.stringify(OPENAI_NON_STREAM_BODY))
    const rows = usageRows(app, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'ok', attempts: 2, channel_id: goodChannel.id })
    // 失败渠道记了熔断计数与最近错误
    const badRow = app.app.deps.db.get<{ fail_streak: number; last_error: string | null }>(
      'SELECT fail_streak, last_error FROM relay_channels WHERE id = ?',
      badChannel.id,
    )!
    expect(badRow.fail_streak).toBe(1)
    expect(badRow.last_error).toContain('boom')
  })

  it('连接拒绝（端口没人听）→ 换下一个成功', async () => {
    const { app, userId, key } = await setup()
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(good)
    const deadChannel = channel(app, 'http://127.0.0.1:1', { name: 'dead', priority: 10 })
    const goodChannel = channel(app, good.url, { name: 'good2' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: deadChannel.id, upstreamModel: 'up-dead', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })
    const res = await call(app, key)
    expect(res.statusCode).toBe(200)
    expect(usageRows(app, userId)[0]).toMatchObject({ status: 'ok', attempts: 2 })
  })

  it('429 → 该密钥冷却，下次请求跳过它；全是 429 时回 429', async () => {
    const { app, userId, key } = await setup()
    const limited = await startFakeUpstream((_req, res) =>
      jsonResponse(res, 429, { error: { message: 'rate limited' } }),
    )
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(limited, good)
    const limitedChannel = channel(app, limited.url, { name: 'limited', priority: 10, keys: ['k-limit'] })
    const goodChannel = channel(app, good.url, { name: 'good3' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: limitedChannel.id, upstreamModel: 'up-limited', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })

    expect((await call(app, key)).statusCode).toBe(200)
    const cooledKey = app.app.deps.db.get<{ id: number; cooldown_until: string | null; state: string }>(
      'SELECT id, cooldown_until, state FROM relay_channel_keys WHERE channel_id = ?',
      limitedChannel.id,
    )!
    expect(cooledKey.state).toBe('active')
    expect(cooledKey.cooldown_until).toBeTruthy()

    // 第二次：冷却中的密钥被跳过 → 只打 good（上游只收到一次请求）
    const before = limited.requests.length
    expect((await call(app, key)).statusCode).toBe(200)
    expect(limited.requests.length).toBe(before)

    // 只剩 429 渠道 → 429（不是 502）
    app.app.deps.services.relay.updateChannel(goodChannel.id, { enabled: false }, 1, META)
    app.app.deps.db.run('UPDATE relay_channel_keys SET cooldown_until = NULL WHERE id = ?', cooledKey.id)
    const allLimited = await call(app, key)
    expect(allLimited.statusCode).toBe(429)
    expect(usageRows(app, userId).at(-1)).toMatchObject({ status: 'upstream_error' })
  })

  it('401 → 密钥 auto-disabled + 审计 relay.channel.key.auto-disable', async () => {
    const { app, userId, key } = await setup()
    const unauthorized = await startFakeUpstream((_req, res) =>
      jsonResponse(res, 401, { error: { message: 'invalid api key sk-live-abcdef123456' } }),
    )
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(unauthorized, good)
    const badChannel = channel(app, unauthorized.url, {
      name: 'unauthorized',
      priority: 10,
      keys: ['bad-key-1'],
    })
    const goodChannel = channel(app, good.url, { name: 'good4' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: badChannel.id, upstreamModel: 'up-401', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })

    expect((await call(app, key)).statusCode).toBe(200)
    const disabled = app.app.deps.db.get<{ state: string; last_error: string | null }>(
      'SELECT state, last_error FROM relay_channel_keys WHERE channel_id = ?',
      badChannel.id,
    )!
    expect(disabled.state).toBe('auto-disabled')
    // 上游错误信息脱敏后才落库
    expect(disabled.last_error).not.toContain('sk-live-abcdef123456')
    expect(disabled.last_error).toContain('[redacted]')
    const audit = app.app.deps.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'relay.channel.key.auto-disable'",
    )!
    expect(audit.n).toBe(1)
    expect(usageRows(app, userId)[0]).toMatchObject({ status: 'ok', attempts: 2 })
  })

  it('上游 400/422 原样回、不计费、不换渠道', async () => {
    const { app, userId, key } = await setup()
    const client = await startFakeUpstream((_req, res) =>
      jsonResponse(res, 400, { error: { message: 'bad request', code: 'invalid' } }),
    )
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(client, good)
    const clientChannel = channel(app, client.url, { name: 'client400', priority: 10 })
    const goodChannel = channel(app, good.url, { name: 'good5' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: clientChannel.id, upstreamModel: 'up-400', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })

    const res = await call(app, key)
    expect(res.statusCode).toBe(400)
    expect(json<{ error: { message: string } }>(res).error.message).toBe('bad request')
    expect(good.requests).toHaveLength(0)
    const rows = usageRows(app, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'client_error',
      attempts: 1,
      cost: 0,
      channel_id: clientChannel.id,
    })
  })

  it('换遍候选仍失败 → 502 upstream_error，attempts 记满', async () => {
    const { app, userId, key } = await setup()
    const dead = await startFakeUpstream((_req, res) => jsonResponse(res, 503, { error: 'down' }))
    upstreams.push(dead)
    const only = channel(app, dead.url, { name: 'only503' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: only.id, upstreamModel: 'up', enabled: true }],
    })
    const res = await call(app, key)
    expect(res.statusCode).toBe(502)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('upstream_error')
    expect(usageRows(app, userId)[0]).toMatchObject({ status: 'upstream_error', cost: 0 })
  })

  it('熔断：连续失败达到阈值后渠道进入冷却，熔断渠道排最后', async () => {
    const { app, userId, key } = await setup()
    const dead = await startFakeUpstream((_req, res) => jsonResponse(res, 500, { error: 'x' }))
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(dead, good)
    const deadChannel = channel(app, dead.url, { name: 'cooling', priority: 10 })
    const goodChannel = channel(app, good.url, { name: 'good6' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: deadChannel.id, upstreamModel: 'up-dead', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })
    app.app.deps.services.relay.updateSettings({ channelFailureThreshold: 2 }, 1, META)

    await call(app, key)
    await call(app, key)
    const row = app.app.deps.db.get<{ fail_streak: number; cooldown_until: string | null }>(
      'SELECT fail_streak, cooldown_until FROM relay_channels WHERE id = ?',
      deadChannel.id,
    )!
    expect(row.fail_streak).toBeGreaterThanOrEqual(2)
    expect(row.cooldown_until).toBeTruthy()

    // 熔断后：即使它优先级更高，也不再被尝试
    const before = dead.requests.length
    const res = await call(app, key)
    expect(res.statusCode).toBe(200)
    expect(dead.requests.length).toBe(before)
    void userId
  })
})

describe('中断（12 §5.4）', () => {
  it('流式开始后上游断开 → 不重试，upstream_error', async () => {
    const { app, userId, key } = await setup()
    const flaky = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
      setTimeout(() => res.destroy(), 20)
    })
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(flaky, good)
    const flakyChannel = channel(app, flaky.url, { name: 'flaky', priority: 10 })
    const goodChannel = channel(app, good.url, { name: 'good7' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: flakyChannel.id, upstreamModel: 'up-flaky', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })

    const res = await call(app, key, { stream: true })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('你')
    // 已经写出字节 → 不能再换候选
    expect(good.requests).toHaveLength(0)
    const row = usageRows(app, userId)[0]!
    expect(row.status).toBe('upstream_error')
    expect(row.attempts).toBe(1)
  })

  it('客户端中途断开 → 中止上游、状态 aborted、按已见 usage 计费', async () => {
    const { app, userId, key } = await setup()
    let upstreamClosed = false
    let sawAbort = false
    const slow = await startFakeUpstream((_req, res, raw) => {
      raw.on('aborted', () => {
        sawAbort = true
      })
      res.on('close', () => {
        if (!res.writableEnded) upstreamClosed = true
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'data: {"choices":[{"delta":{"content":"开"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      )
      // 之后一直不结束，等客户端断开把我们带走
    })
    upstreams.push(slow)
    const slowChannel = channel(app, slow.url, { name: 'slow' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: slowChannel.id, upstreamModel: 'up-slow', enabled: true }],
    })

    // 客户端断开必须走真实连接（inject 是内存调用，没有"连接"可断）
    await app.app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        },
        (res) => {
          res.on('data', () => {
            // 收到第一块就断开（模拟用户 Ctrl-C）
            req.destroy()
            resolve()
          })
        },
      )
      req.end(JSON.stringify({ model: 'test-model', stream: true, messages: [] }))
    })
    // 等后端把 abort 落库
    for (let index = 0; index < 40 && usageRows(app, userId).length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const row = usageRows(app, userId)[0]!
    expect(row.status).toBe('aborted')
    expect(row.input_tokens + row.output_tokens).toBeGreaterThan(0)
    expect(row.cost).toBeGreaterThan(0)
    expect(upstreamClosed || sawAbort).toBe(true)
  })

  it('客户端读到 [DONE] 就断开、上游还没关响应体 → 流已讲完，状态 ok（不是 aborted）', async () => {
    const { app, userId, key } = await setup()
    const lingering = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const chunk of OPENAI_STREAM_CHUNKS) res.write(chunk)
      // [DONE] 已经发出，但上游迟迟不关响应体：客户端的 FIN 会先到
    })
    upstreams.push(lingering)
    const lingeringChannel = channel(app, lingering.url, { name: 'lingering' })
    await createRelayModel(app.app, {
      name: 'test-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: lingeringChannel.id, upstreamModel: 'up-lingering', enabled: true }],
    })

    await app.app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        },
        (res) => {
          let received = ''
          res.on('data', (chunk: Buffer) => {
            received += chunk.toString('utf8')
            // 像 OpenAI SDK 那样：读到 [DONE] 立刻收摊，不等服务端关连接
            if (received.includes('data: [DONE]')) {
              req.destroy()
              resolve()
            }
          })
        },
      )
      req.end(JSON.stringify({ model: 'test-model', stream: true, messages: [] }))
    })
    for (let index = 0; index < 40 && usageRows(app, userId).length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const row = usageRows(app, userId)[0]!
    expect(row.status).toBe('ok')
    expect(row.input_tokens).toBe(100)
    expect(row.output_tokens).toBe(40)
    expect(row.cost).toBeGreaterThan(0)
    // 日聚合里也不能算错误（管理端的「错误率」读的是这里）
    const daily = app.app.deps.db.get<{ requests: number; errors: number }>(
      'SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(errors), 0) AS errors FROM relay_usage_daily WHERE user_id = ?',
      userId,
    )
    expect(daily).toMatchObject({ requests: 1, errors: 0 })
  })
})
