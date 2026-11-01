import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { TestApp, TestSession } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import {
  OPENAI_NON_STREAM_BODY,
  grantMicro,
  issueKey,
  jsonResponse,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * 渠道倍率（WP11a，12 §6.2 §9）：
 * - 倍率是渠道级字段（千分比，缺省 1000），创建/修改/列表 DTO 全链路；
 * - 费用与用量快照都取**实际服务这次请求**的渠道（失败切换后的最后一个候选）；
 * - 倍率变化进审计（前后值）但不影响历史用量行。
 */

let ctx: TestApp | undefined
const upstreams: FakeUpstream[] = []

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  for (const upstream of upstreams.splice(0)) await upstream.close()
})

interface Setup {
  app: TestApp
  admin: TestSession
  user: TestSession
  userId: number
  key: string
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  const user = await createUser(ctx.app, { username: 'rate-user' })
  grantMicro(ctx.app, user.id, 500_000_000)
  return {
    app: ctx,
    admin: loginAs(ctx.app, adminUser),
    user: loginAs(ctx.app, user),
    userId: user.id,
    key: issueKey(ctx.app, user.id),
  }
}

function api(
  app: FastifyInstance,
  session: TestSession,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: session.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })
}

async function createChannel(
  app: TestApp,
  admin: TestSession,
  body: Record<string, unknown>,
): Promise<{ id: number; ratePermille: number }> {
  const res = await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
    baseUrl: 'https://x.example/v1',
    apis: ['openai-completions'],
    ...body,
  })
  expect(res.statusCode).toBe(200)
  return json<{ channel: { id: number; ratePermille: number } }>(res).channel
}

describe('渠道倍率 CRUD 与审计（12 §9）', () => {
  it('创建缺省 1000‰；显式值生效；越界 400', async () => {
    const { app, admin } = await setup()
    const fallback = await createChannel(app, admin, { name: 'default-rate' })
    expect(fallback.ratePermille).toBe(1000)

    const custom = await createChannel(app, admin, { name: 'x1.5', ratePermille: 1500 })
    expect(custom.ratePermille).toBe(1500)

    // 列表 / 详情都带倍率
    const list = json<{ id: number; ratePermille: number }[]>(
      await api(app.app, admin, 'GET', '/api/admin/relay/channels'),
    )
    expect(list.map((channel) => channel.ratePermille).sort((a, b) => a - b)).toEqual([1000, 1500])

    for (const bad of [100_001, -1, 1.5]) {
      expect(
        (
          await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(custom.id)}`, {
            ratePermille: bad,
          })
        ).statusCode,
      ).toBe(400)
    }
    expect(
      (
        await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
          name: 'too-big',
          baseUrl: 'https://x.example/v1',
          apis: ['openai-completions'],
          ratePermille: 100_001,
        })
      ).statusCode,
    ).toBe(400)
  })

  it('PATCH 改倍率：只改倍率，审计 detail 留前后值', async () => {
    const { app, admin } = await setup()
    const channel = await createChannel(app, admin, {
      name: 'audited',
      ratePermille: 1500,
      priority: 3,
      note: '原备注',
    })
    const patched = await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(channel.id)}`, {
      ratePermille: 1200,
    })
    expect(patched.statusCode).toBe(200)
    const body = json<{ channel: { ratePermille: number; priority: number; note: string } }>(patched)
    expect(body.channel).toMatchObject({ ratePermille: 1200, priority: 3, note: '原备注' })

    const audit = app.app.deps.db.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'relay.channel.update' ORDER BY id DESC LIMIT 1",
    )!
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      fields: ['ratePermille'],
      ratePermille: { from: 1500, to: 1200 },
    })

    // PATCH 里没给倍率 → 审计里不该冒出 ratePermille，值也不变
    await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(channel.id)}`, { note: '新备注' })
    const latest = app.app.deps.db.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'relay.channel.update' ORDER BY id DESC LIMIT 1",
    )!
    const detail = JSON.parse(latest.detail_json) as Record<string, unknown>
    expect(detail).toEqual({ fields: ['note'] })
    expect(
      app.app.deps.db.get<{ rate_permille: number }>(
        'SELECT rate_permille FROM relay_channels WHERE id = ?',
        channel.id,
      )!.rate_permille,
    ).toBe(1200)
  })

  it('路由 DTO 带 channelRatePermille（界面显示「价格 × 倍率」）', async () => {
    const { app, admin } = await setup()
    const channel = await createChannel(app, admin, { name: 'route-rate', ratePermille: 800 })
    const created = await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'rate-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up-rate', enabled: true }],
    })
    expect(created.statusCode).toBe(200)
    const routes = json<{ model: { routes: { channelRatePermille: number; channelName: string }[] } }>(
      created,
    ).model.routes
    expect(routes).toEqual([expect.objectContaining({ channelName: 'route-rate', channelRatePermille: 800 })])

    // 改渠道倍率后，路由 DTO 跟着变（价格 × 新倍率）
    await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(channel.id)}`, {
      ratePermille: 2500,
    })
    const list = json<{ name: string; routes: { channelRatePermille: number }[] }[]>(
      await api(app.app, admin, 'GET', '/api/admin/relay/models'),
    )
    expect(list.find((model) => model.name === 'rate-model')!.routes[0]!.channelRatePermille).toBe(2500)
  })
})

describe('费用按实际服务的渠道（12 §6.2）', () => {
  it('失败切换：费用与快照都按真正服务的第二个渠道；改倍率不动历史用量', async () => {
    const { app, admin, userId, key } = await setup()
    const bad = await startFakeUpstream((_req, res) => jsonResponse(res, 500, { error: 'boom' }))
    const good = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(bad, good)
    const badChannel = await createChannel(app, admin, {
      name: 'bad-2000',
      baseUrl: bad.url,
      ratePermille: 2000,
      priority: 10,
      keys: ['k-bad'],
    })
    const goodChannel = await createChannel(app, admin, {
      name: 'good-1500',
      baseUrl: good.url,
      ratePermille: 1500,
      keys: ['k-good'],
    })
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'rate-failover',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: badChannel.id, upstreamModel: 'up-bad', enabled: true },
        { channelId: goodChannel.id, upstreamModel: 'up-good', enabled: true },
      ],
    })

    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'rate-failover', messages: [] },
    })
    expect(res.statusCode).toBe(200)
    // 上游 usage：input 100、output 40 → 100×1 + 40×2 = 180 微积分；× 1500‰ = 270
    const row = app.app.deps.db.get<{
      channel_id: number
      channel_rate_permille: number
      cost: number
      attempts: number
    }>('SELECT channel_id, channel_rate_permille, cost, attempts FROM relay_usage WHERE user_id = ?', userId)!
    expect(row).toMatchObject({
      channel_id: goodChannel.id,
      channel_rate_permille: 1500,
      cost: 270,
      attempts: 2,
    })

    // 改渠道倍率（并停掉失败的渠道，避免它再来抢）
    await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(goodChannel.id)}`, {
      ratePermille: 3000,
    })
    await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(badChannel.id)}`, {
      enabled: false,
    })
    const historical = app.app.deps.db.get<{ channel_rate_permille: number; cost: number }>(
      'SELECT channel_rate_permille, cost FROM relay_usage WHERE user_id = ?',
      userId,
    )!
    expect(historical).toEqual({ channel_rate_permille: 1500, cost: 270 })

    const second = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'rate-failover', messages: [] },
    })
    expect(second.statusCode).toBe(200)
    const fresh = app.app.deps.db.get<{ channel_rate_permille: number; cost: number }>(
      'SELECT channel_rate_permille, cost FROM relay_usage WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      userId,
    )!
    expect(fresh).toEqual({ channel_rate_permille: 3000, cost: 540 })
  })

  it('用量记录：管理端与用户端都带 channelRatePermille；没走到渠道 → null', async () => {
    const { app, admin, user, userId, key } = await setup()
    const upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    upstreams.push(upstream)
    const channel = await createChannel(app, admin, {
      name: 'logs-rate',
      baseUrl: upstream.url,
      ratePermille: 1250,
      keys: ['k-1'],
    })
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'logs-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up', enabled: true }],
    })
    await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'logs-model', messages: [] },
    })

    const adminLogs = json<{ items: { channelRatePermille: number | null; channelName: string | null }[] }>(
      await api(app.app, admin, 'GET', '/api/admin/relay/logs'),
    )
    expect(adminLogs.items[0]).toMatchObject({ channelRatePermille: 1250, channelName: 'logs-rate' })
    const meLogs = json<{ items: { channelRatePermille: number | null; channelName: string | null }[] }>(
      await api(app.app, user, 'GET', '/api/me/relay/logs'),
    )
    // 用户端不给渠道名，但要给倍率来解释费用
    expect(meLogs.items[0]).toMatchObject({ channelRatePermille: 1250, channelName: null })

    // 没走到任何渠道（连接被拒）→ 快照为 null，费用 0
    const dead = await createChannel(app, admin, {
      name: 'dead-rate',
      baseUrl: 'http://127.0.0.1:1',
      ratePermille: 5000,
      keys: ['k-dead'],
    })
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'dead-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: dead.id, upstreamModel: 'up', enabled: true }],
    })
    const failed = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'dead-model', messages: [] },
    })
    expect(failed.statusCode).toBe(502)
    const deadRow = app.app.deps.db.get<{ channel_id: number | null; channel_rate_permille: number | null }>(
      'SELECT channel_id, channel_rate_permille FROM relay_usage WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      userId,
    )!
    expect(deadRow).toEqual({ channel_id: null, channel_rate_permille: null })
  })
})

describe('MyRelayModel.channelRate（12 §9）', () => {
  it('启用路由所在启用渠道的倍率最小/最大值；没有可用路由 → null', async () => {
    const { app, admin, user } = await setup()
    const low = await createChannel(app, admin, { name: 'low-800', ratePermille: 800 })
    const high = await createChannel(app, admin, { name: 'high-1500', ratePermille: 1500 })
    const disabled = await createChannel(app, admin, { name: 'off-900', ratePermille: 900 })
    await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(disabled.id)}`, {
      enabled: false,
    })
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'range-model',
      price: { inputMicro: 1_000_000, outputMicro: 1_000_000 },
      routes: [
        { channelId: low.id, upstreamModel: 'up-low', enabled: true },
        { channelId: high.id, upstreamModel: 'up-high', enabled: true },
      ],
    })
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'no-route-model',
      price: { inputMicro: 1_000_000, outputMicro: 1_000_000 },
    })
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'disabled-channel-model',
      price: { inputMicro: 1_000_000, outputMicro: 1_000_000 },
      routes: [{ channelId: disabled.id, upstreamModel: 'up-off', enabled: true }],
    })

    const models = json<{
      models: { name: string; channelRate: { minPermille: number; maxPermille: number } | null }[]
    }>(await api(app.app, user, 'GET', '/api/me/relay')).models
    const byName = new Map(models.map((model) => [model.name, model.channelRate]))
    expect(byName.get('range-model')).toEqual({ minPermille: 800, maxPermille: 1500 })
    expect(byName.get('no-route-model')).toBeNull()
    // 渠道停用后不算数（渠道启用但路由停用同理）
    expect(byName.get('disabled-channel-model')).toBeNull()
  })
})
