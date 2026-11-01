import { afterEach, describe, expect, it } from 'vitest'
import type {
  RelayChannel,
  RelayDshResponse,
  RelayUsageLogResponse,
  RelayUsageStatsResponse,
} from '@dsh-hub/shared'
import type { TestApp, TestSession, TestUser } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import {
  createChannel,
  createRelayModel,
  grantMicro,
  issueKey,
  jsonResponse,
  OPENAI_NON_STREAM_BODY,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * WP20a：模型 × 渠道拆成独立模型（16 §2 §3 §4.1 §5 §6.1 §6.2）。
 *
 * 覆盖：渠道 slug（生成/冲突/修改同步）、`@` 调用只走指定渠道与错误码、
 * 用量 model/base_model/pinned/channelSlug、按模型分组与 baseModel 筛选、
 * `/v1/models` 只列 @ 名字、下发按路由的 GET/PUT/渲染/默认路由自动改选。
 */

let ctx: TestApp | undefined
const upstreams: FakeUpstream[] = []

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  for (const upstream of upstreams.splice(0)) await upstream.close()
})

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

interface Setup {
  app: TestApp
  admin: TestSession
  user: TestUser
  key: string
  adminUser: TestSession
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  const user = await createUser(ctx.app, { username: 'wp20-user' })
  grantMicro(ctx.app, user.id, 100_000_000)
  // 渲染 hub-relay 需要内部地址（不起真监听器）
  ctx.app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7902/v1')
  ctx.app.deps.services.relay.setInternalListening(true)
  return {
    app: ctx,
    admin: loginAs(ctx.app, adminUser),
    adminUser: loginAs(ctx.app, adminUser),
    user,
    key: issueKey(ctx.app, user.id),
  }
}

async function fakeUpstream(): Promise<FakeUpstream> {
  const upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
  upstreams.push(upstream)
  return upstream
}

function api(
  app: TestApp,
  session: TestSession,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return app.app.inject({
    method,
    url,
    headers: session.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })
}

/** 两条渠道 + 同一个模型各一条路由（渠道倍率不同），返回渠道/模型/路由 id */
async function seedTwoChannels(
  app: TestApp,
  rates: { alpha: number; beta: number } = { alpha: 300, beta: 100 },
) {
  const upA = await fakeUpstream()
  const upB = await fakeUpstream()
  const alpha = createChannel(app.app, {
    name: 'alpha',
    baseUrl: upA.url,
    apis: ['openai-completions'],
    ratePermille: rates.alpha,
    keys: ['k-alpha'],
  })
  const beta = createChannel(app.app, {
    name: 'beta',
    baseUrl: upB.url,
    apis: ['openai-completions'],
    ratePermille: rates.beta,
    keys: ['k-beta'],
  })
  const model = await createRelayModel(app.app, {
    name: 'm',
    displayName: '模型 M',
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { contextWindow: 128_000, maxTokens: 8_192 },
    routes: [
      { channelId: alpha.id, upstreamModel: 'up-a', enabled: true },
      { channelId: beta.id, upstreamModel: 'up-b', enabled: true },
    ],
  })
  const routeA = model.routes!.find((route) => route.channelId === alpha.id)!
  const routeB = model.routes!.find((route) => route.channelId === beta.id)!
  return { alpha, beta, model, routeA, routeB, upA, upB }
}

function usageRows(app: TestApp): {
  id: number
  model: string
  base_model: string
  pinned: number
  channel_id: number | null
  channel_rate_permille: number | null
  cost: number
}[] {
  return app.app.deps.db.all(
    'SELECT id, model, base_model, pinned, channel_id, channel_rate_permille, cost FROM relay_usage ORDER BY id ASC',
  )
}

describe('渠道标识（16 §2）', () => {
  it('按名称自动生成、中文名、留空用 ch<id>、手动冲突报 VALIDATION_FAILED', async () => {
    const { app, admin } = await setup()
    const chinese = createChannel(app.app, {
      name: 'upstream-c 池',
      baseUrl: 'https://a.example/v1',
      apis: ['openai-completions'],
    })
    expect(chinese.slug).toBe('upstream-c')
    const symbols = createChannel(app.app, {
      name: '！！！',
      baseUrl: 'https://b.example/v1',
      apis: ['openai-completions'],
    })
    expect(symbols.slug).toBe(`ch${String(symbols.id)}`)

    const res = await api(app, admin, 'POST', '/api/admin/relay/channels', {
      name: 'dup',
      slug: 'upstream-c',
      baseUrl: 'https://c.example/v1',
      apis: ['openai-completions'],
    })
    expect(res.statusCode).toBe(400)
    expect(json<{ error: { code: string; details: { fields: { slug: string } } } }>(res).error).toMatchObject(
      {
        code: 'VALIDATION_FAILED',
        details: { fields: { slug: expect.stringContaining('upstream-c') } },
      },
    )
    // 自动生成撞名 → 依次加后缀
    const auto = createChannel(app.app, {
      name: 'upstream-c',
      baseUrl: 'https://d.example/v1',
      apis: ['openai-completions'],
    })
    expect(auto.slug).toBe('upstream-c-2')

    // 路由 DTO 带 channelSlug
    const model = await createRelayModel(app.app, {
      name: 'slug-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: chinese.id, upstreamModel: 'up', enabled: true }],
    })
    expect(model.routes![0]!.channelSlug).toBe('upstream-c')
  })

  it('修改标识：唯一校验、审计 from/to、触发 revision+1；改倍率不触发', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    // 先选中一条路由，产生系统预设 revision
    const put = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id],
      defaultRouteId: seeded.routeA.id,
    })
    expect(put.statusCode, put.body).toBe(200)
    const before = json<RelayDshResponse>(put)

    const conflict = await api(app, admin, 'PATCH', `/api/admin/relay/channels/${String(seeded.beta.id)}`, {
      slug: 'alpha',
    })
    expect(conflict.statusCode).toBe(400)
    expect(
      json<{ error: { details: { fields: { slug: string } } } }>(conflict).error.details.fields.slug,
    ).toContain('alpha')

    const renamed = await api(app, admin, 'PATCH', `/api/admin/relay/channels/${String(seeded.alpha.id)}`, {
      slug: 'alpha-x',
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(json<{ channel: RelayChannel }>(renamed).channel.slug).toBe('alpha-x')
    const audit = app.app.deps.db.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'relay.channel.update' ORDER BY id DESC LIMIT 1",
    )!
    expect(JSON.parse(audit.detail_json).slug).toEqual({ from: 'alpha', to: 'alpha-x' })

    const after = json<RelayDshResponse>(await api(app, admin, 'GET', '/api/admin/relay/dsh'))
    expect(after.revision).toBe(before.revision + 1)
    expect(after.models[0]!.routes!.find((route) => route.routeId === seeded.routeA.id)!.channelSlug).toBe(
      'alpha-x',
    )

    // 只改倍率：不触发 revision / updatedAt
    const rateUpdatedAt = after.updatedAt
    const rate = await api(app, admin, 'PATCH', `/api/admin/relay/channels/${String(seeded.beta.id)}`, {
      ratePermille: 777,
    })
    expect(rate.statusCode, rate.body).toBe(200)
    const afterRate = json<RelayDshResponse>(await api(app, admin, 'GET', '/api/admin/relay/dsh'))
    expect(afterRate.revision).toBe(after.revision)
    expect(afterRate.updatedAt).toBe(rateUpdatedAt)
  })
})

describe('@ 调用（16 §3）', () => {
  it('@a / @b 只走各自渠道；用量记原始名字、本名、pinned 与渠道倍率', async () => {
    const { app, key } = await setup()
    const seeded = await seedTwoChannels(app)

    const a = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'm@alpha', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(a.statusCode, a.body).toBe(200)
    expect(seeded.upA.requests[0]!.json?.model).toBe('up-a')
    expect(seeded.upB.requests).toHaveLength(0)

    const b = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'm@beta', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(b.statusCode, b.body).toBe(200)
    expect(seeded.upB.requests[0]!.json?.model).toBe('up-b')

    const rows = usageRows(app)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      model: 'm@alpha',
      base_model: 'm',
      pinned: 1,
      channel_id: seeded.alpha.id,
      channel_rate_permille: 300,
      cost: 54,
    })
    expect(rows[1]).toMatchObject({
      model: 'm@beta',
      base_model: 'm',
      pinned: 1,
      channel_id: seeded.beta.id,
      channel_rate_permille: 100,
      cost: 18,
    })
  })

  it('指定渠道全失败 → 502，且不会换到另一条渠道', async () => {
    const { app, key } = await setup()
    const seeded = await seedTwoChannels(app)
    seeded.upA.setHandler((_req, res) => jsonResponse(res, 500, { error: { message: 'boom' } }))
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'm@alpha', messages: [] },
    })
    expect(res.statusCode).toBe(502)
    expect(seeded.upB.requests).toHaveLength(0)
    expect(usageRows(app)[0]).toMatchObject({
      model: 'm@alpha',
      base_model: 'm',
      pinned: 1,
      channel_id: seeded.alpha.id,
    })
  })

  it('不带 @ 的老写法照常自动选渠道，用量 pinned=0、model=本名', async () => {
    const { app, key } = await setup()
    await seedTwoChannels(app)
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(usageRows(app)[0]).toMatchObject({ model: 'm', base_model: 'm', pinned: 0 })
  })

  it('指定渠道的错误码：模型/渠道不存在 404、渠道或路由停用 503、协议不支持 400', async () => {
    const { app, key } = await setup()
    const seeded = await seedTwoChannels(app)
    const relay = app.app.deps.services.relay

    const notFound = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'm@nope', messages: [] },
    })
    expect(notFound.statusCode).toBe(404)
    expect(json<{ error: { message: string } }>(notFound).error.message).toContain('m@nope')

    // 模型不在这条渠道上 → 404
    const onlyOnAlpha = await createRelayModel(app.app, {
      name: 'only-alpha',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId: seeded.alpha.id, upstreamModel: 'up-only', enabled: true }],
    })
    const noRoute = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'only-alpha@beta', messages: [] },
    })
    expect(noRoute.statusCode).toBe(404)
    void onlyOnAlpha

    // 渠道停用 → 503，且不会去访问另一条可用渠道
    relay.updateChannel(seeded.beta.id, { enabled: false }, 1, META)
    const disabledChannel = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'm@beta', messages: [] },
    })
    expect(disabledChannel.statusCode).toBe(503)
    expect(seeded.upA.requests).toHaveLength(0)
    relay.updateChannel(seeded.beta.id, { enabled: true }, 1, META)

    // 路由停用 → 503
    relay.updateModel(
      seeded.model.id,
      {
        routes: [
          { channelId: seeded.alpha.id, upstreamModel: 'up-a', enabled: true },
          { channelId: seeded.beta.id, upstreamModel: 'up-b', enabled: false },
        ],
      },
      1,
      META,
    )
    const disabledRoute = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'm@beta', messages: [] },
    })
    expect(disabledRoute.statusCode).toBe(503)

    // 渠道不支持本次协议 → 400（`m@alpha` 只有 openai-completions，走 /v1/messages）
    const unsupported = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': key },
      payload: { model: 'm@alpha', messages: [] },
    })
    expect(unsupported.statusCode).toBe(400)
    expect(json<{ type: string; error: { type: string } }>(unsupported).error.type).toBe(
      'invalid_request_error',
    )
  })

  it('/v1/models 只列 `模型@slug`；按模型统计按原始名字分组', async () => {
    const { app, key, user } = await setup()
    await seedTwoChannels(app)
    for (const model of ['m@alpha', 'm@beta']) {
      const res = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model, messages: [] },
      })
      expect(res.statusCode, res.body).toBe(200)
    }
    const list = json<{ data: { id: string; display_name: string }[] }>(
      await app.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } }),
    )
    expect(list.data.map((item) => item.id).sort()).toEqual(['m@alpha', 'm@beta'])
    expect(list.data.find((item) => item.id === 'm@alpha')!.display_name).toBe('模型 M · alpha')
    expect(list.data.some((item) => item.id === 'm')).toBe(false)

    const session = loginAs(app.app, user)
    const stats = json<RelayUsageStatsResponse>(await api(app, session, 'GET', '/api/me/relay/usage'))
    expect(stats.byModel.map((bucket) => [bucket.model, bucket.requests]).sort()).toEqual([
      ['m@alpha', 1],
      ['m@beta', 1],
    ])
    const rows = app.app.deps.db.all<{ model: string; requests: number }>(
      'SELECT model, SUM(requests) AS requests FROM relay_usage_daily WHERE user_id = ? GROUP BY model ORDER BY model',
      user.id,
    )
    expect(rows).toEqual([
      { model: 'm@alpha', requests: 1 },
      { model: 'm@beta', requests: 1 },
    ])
  })
})

describe('用户端 / 管理端接口（16 §4.1 §5）', () => {
  it('/api/me/relay 的 routes[]：只含启用渠道上的启用路由、按倍率排序、inDsh/dshDefault 按路由', async () => {
    const { app, admin, user } = await setup()
    const seeded = await seedTwoChannels(app)
    await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeB.id],
      defaultRouteId: seeded.routeB.id,
    })
    const session = loginAs(app.app, user)
    const body = json<{
      models: {
        name: string
        routes: {
          channelSlug: string
          ratePermille: number
          pinnedModel: string
          inDsh: boolean
          dshDefault: boolean
        }[]
        inDsh: boolean
        dshDefault: boolean
      }[]
    }>(await api(app, session, 'GET', '/api/me/relay'))
    const model = body.models.find((item) => item.name === 'm')!
    expect(model.routes.map((route) => [route.channelSlug, route.ratePermille, route.pinnedModel])).toEqual([
      ['beta', 100, 'm@beta'],
      ['alpha', 300, 'm@alpha'],
    ])
    expect(model.routes.map((route) => [route.inDsh, route.dshDefault])).toEqual([
      [true, true],
      [false, false],
    ])
    expect(model.inDsh).toBe(true)
    expect(model.dshDefault).toBe(true)
  })

  it('用户使用记录返回 channelSlug/pinned/baseModel，channelId/Name 仍为 null；管理端可按本名筛选', async () => {
    const { app, admin, key, user } = await setup()
    await seedTwoChannels(app)
    for (const model of ['m@alpha', 'm']) {
      const res = await app.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model, messages: [] },
      })
      expect(res.statusCode, res.body).toBe(200)
    }
    const userSession = loginAs(app.app, user)
    const logs = json<RelayUsageLogResponse>(await api(app, userSession, 'GET', '/api/me/relay/logs'))
    expect(logs.items).toHaveLength(2)
    for (const row of logs.items) {
      expect(row.channelId).toBeNull()
      expect(row.channelName).toBeNull()
      expect(row.channelSlug).toBeTruthy()
      expect(row.baseModel).toBe('m')
      expect(typeof row.pinned).toBe('boolean')
    }
    expect(logs.items.find((row) => row.model === 'm@alpha')!.pinned).toBe(true)
    expect(logs.items.find((row) => row.model === 'm')!.pinned).toBe(false)

    const adminLogs = json<RelayUsageLogResponse>(
      await api(app, admin, 'GET', '/api/admin/relay/logs?baseModel=m'),
    )
    expect(adminLogs.total).toBe(2)
    expect(adminLogs.items.every((row) => row.baseModel === 'm')).toBe(true)
    const none = json<RelayUsageLogResponse>(
      await api(app, admin, 'GET', '/api/admin/relay/logs?baseModel=m%40alpha'),
    )
    expect(none.total).toBe(0)
  })
})

describe('下发到 DSH 按路由（16 §6.1 §6.2）', () => {
  it('GET 返回 routes 与 defaultRouteId；新写法只选一条路由 → 渲染一个模型条目', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    const put = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id],
      defaultRouteId: seeded.routeA.id,
    })
    expect(put.statusCode, put.body).toBe(200)
    const body = json<RelayDshResponse>(put)
    expect(body.defaultRouteId).toBe(seeded.routeA.id)
    expect(body.defaultModelId).toBe(seeded.model.id)
    const model = body.models.find((item) => item.id === seeded.model.id)!
    expect(model.selected).toBe(true)
    expect(model.routes!.map((route) => [route.routeId, route.channelSlug, route.selected])).toEqual([
      [seeded.routeA.id, 'alpha', true],
      [seeded.routeB.id, 'beta', false],
    ])

    const rendered = await app.app.deps.services.models.renderManaged(
      (await createUser(app.app, { username: 'render-user' })).id,
    )
    // 该用户没有分配默认预设也会渲染默认预设（新建用户默认用默认预设）
    expect(rendered.content).toContain('id: m@alpha')
    expect(rendered.content).toContain('name: 模型 M · alpha')
    expect(rendered.content).not.toContain('id: m@beta')
    expect(rendered.content).toContain('model: m@alpha')

    // 路由选中变化 → revision + 1
    const selectBoth = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id, seeded.routeB.id],
      defaultRouteId: seeded.routeA.id,
    })
    expect(selectBoth.statusCode, selectBoth.body).toBe(200)
    expect(json<RelayDshResponse>(selectBoth).revision).toBe(body.revision + 1)
  })

  it('渲染的 deliverApi 按路由算：同一模型两条不同协议的渠道 → 两个提供方各一个条目', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    const gamma = createChannel(app.app, {
      name: 'gamma',
      baseUrl: 'https://gamma.example/v1',
      apis: ['anthropic-messages'],
    })
    const dual = await createRelayModel(app.app, {
      name: 'dual',
      displayName: '双协议',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [
        { channelId: seeded.alpha.id, upstreamModel: 'up-dual-a', enabled: true },
        { channelId: gamma.id, upstreamModel: 'up-dual-g', enabled: true },
      ],
    })
    const routeA = dual.routes!.find((route) => route.channelId === seeded.alpha.id)!
    const routeG = dual.routes!.find((route) => route.channelId === gamma.id)!
    const put = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [routeA.id, routeG.id],
      defaultRouteId: routeA.id,
    })
    expect(put.statusCode, put.body).toBe(200)
    const user = await createUser(app.app, { username: 'render-user-dual' })
    const rendered = await app.app.deps.services.models.renderManaged(user.id)
    expect(rendered.content).toContain('hub:')
    expect(rendered.content).toContain('hub-anthropic:')
    expect(rendered.content).toContain('id: dual@alpha')
    expect(rendered.content).toContain('id: dual@gamma')
    expect(rendered.content).toContain('api: openai-completions')
    expect(rendered.content).toContain('api: anthropic-messages')
  })

  it('路由增减不改变容器 env（仍是 HUB_MK_HUB 一把），升级只需重启、不需重建', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    const user = await createUser(app.app, { username: 'env-user' })
    await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id],
      defaultRouteId: seeded.routeA.id,
    })
    const before = await app.app.deps.services.models.containerEnv(user.id)
    await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id, seeded.routeB.id],
      defaultRouteId: seeded.routeB.id,
    })
    const after = await app.app.deps.services.models.containerEnv(user.id)
    expect(Object.keys(before)).toEqual(['HUB_MK_HUB'])
    expect(Object.keys(after)).toEqual(['HUB_MK_HUB'])
    expect(after.HUB_MK_HUB).toBe(before.HUB_MK_HUB)
  })

  it('老写法 modelIds = 该模型的全部路由；同一提供方下两个模型条目，默认路由按渠道优先级/倍率', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    const put = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      modelIds: [seeded.model.id],
      defaultModelId: seeded.model.id,
    })
    expect(put.statusCode, put.body).toBe(200)
    const body = json<RelayDshResponse>(put)
    // beta 倍率更低 → 默认路由 rB
    expect(body.defaultRouteId).toBe(seeded.routeB.id)
    expect(body.models[0]!.routes!.every((route) => route.selected)).toBe(true)

    const user = await createUser(app.app, { username: 'render-user-2' })
    const rendered = await app.app.deps.services.models.renderManaged(user.id)
    expect(rendered.content).toContain('id: m@alpha')
    expect(rendered.content).toContain('id: m@beta')
    expect(rendered.content).toContain('model: m@beta')
    const modelEntries = rendered.content.match(/- id: m@/g) ?? []
    expect(modelEntries).toHaveLength(2)
    // 提供方仍叫「DSH Hub」，模型条目 id 与 name 正确
    expect(rendered.content).toContain('displayName: DSH Hub')
    expect(rendered.content).toContain('name: 模型 M · beta')
  })

  it('两种写法二选一；默认项必须是选中的之一', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    const both = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id],
      defaultRouteId: seeded.routeA.id,
      modelIds: [seeded.model.id],
      defaultModelId: seeded.model.id,
    })
    expect(both.statusCode).toBe(400)
    const badDefault = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id],
      defaultRouteId: seeded.routeB.id,
    })
    expect(badDefault.statusCode).toBe(400)
  })

  it('新勾上的路由不能下发 → 拒绝；已选中后变得不能下发 → 接受并给 warning', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    app.app.deps.services.relay.updateChannel(seeded.beta.id, { enabled: false }, 1, META)

    const rejected = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id, seeded.routeB.id],
      defaultRouteId: seeded.routeA.id,
    })
    expect(rejected.statusCode).toBe(400)
    expect(
      json<{ error: { details: { routes: { name: string; reason: string }[] } } }>(rejected).error.details
        .routes,
    ).toEqual(expect.arrayContaining([{ id: seeded.routeB.id, name: 'm@beta', reason: '渠道已停用' }]))

    // 先选中两条，再把 beta 停用；原样保存仍 200，并提示
    app.app.deps.services.relay.updateChannel(seeded.beta.id, { enabled: true }, 1, META)
    expect(
      (
        await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
          routeIds: [seeded.routeA.id, seeded.routeB.id],
          defaultRouteId: seeded.routeA.id,
        })
      ).statusCode,
    ).toBe(200)
    app.app.deps.services.relay.updateChannel(seeded.beta.id, { enabled: false }, 1, META)
    const again = await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id, seeded.routeB.id],
      defaultRouteId: seeded.routeA.id,
    })
    expect(again.statusCode, again.body).toBe(200)
    expect(json<RelayDshResponse>(again).warnings.join('\n')).toContain('m@beta')
  })

  it('默认路由失效（渠道停用）→ 自动改选剩余可下发路由', async () => {
    const { app, admin } = await setup()
    const seeded = await seedTwoChannels(app)
    await api(app, admin, 'PUT', '/api/admin/relay/dsh', {
      routeIds: [seeded.routeA.id, seeded.routeB.id],
      defaultRouteId: seeded.routeA.id,
    })
    app.app.deps.services.relay.updateChannel(seeded.alpha.id, { enabled: false }, 1, META)
    const after = json<RelayDshResponse>(await api(app, admin, 'GET', '/api/admin/relay/dsh'))
    expect(after.defaultRouteId).toBe(seeded.routeB.id)
    expect(after.defaultModelId).toBe(seeded.model.id)
    const settings = JSON.parse(
      app.app.deps.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'relay_dsh'")!
        .value_json,
    ) as { defaultRouteId: number }
    expect(settings.defaultRouteId).toBe(seeded.routeB.id)
  })
})

describe('启动补齐（迁移 086）', () => {
  it('空 slug 的渠道在启动时生成并写审计', async () => {
    const created = await setup()
    const at = created.app.app.deps.clock.nowIso()
    created.app.app.deps.db.run(
      `INSERT INTO relay_channels (id, name, base_url, apis_json, created_at, updated_at)
       VALUES (99, 'upstream-c 池', 'https://old.example/v1', '["openai-completions"]', ?, ?)`,
      at,
      at,
    )
    // 关掉第一个实例（保留数据目录），用同一数据目录再 build 一次 = 重启
    const config = created.app.config
    const clock = created.app.clock
    const dataDir = created.app.dataDir
    await created.app.app.close()
    ctx = undefined
    const { buildApp } = await import('../src/app.js')
    const { FakeDriver } = await import('../src/modules/instances/fake-driver.js')
    const app2 = await buildApp({
      config,
      testing: true,
      clock,
      driver: new FakeDriver({ clock, envId: config.envId }),
    })
    try {
      const row = app2.deps.db.get<{ slug: string | null }>('SELECT slug FROM relay_channels WHERE id = 99')!
      expect(row.slug).toBe('upstream-c')
      const audit = app2.deps.db.get<{ action: string; detail_json: string }>(
        "SELECT action, detail_json FROM audit_logs WHERE action = 'relay.channel.slug-backfill'",
      )
      expect(audit).toBeTruthy()
      expect(JSON.parse(audit!.detail_json)).toMatchObject({ name: 'upstream-c 池', slug: 'upstream-c' })
    } finally {
      await app2.close()
      const { rmSync } = await import('node:fs')
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
