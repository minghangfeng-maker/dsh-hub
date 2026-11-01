import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { TestApp, TestSession } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'

/**
 * 定价与「未定价」告警（WP11a，12 §6.2 §9）：
 * - `import` 的 `price` 可省略 = 新模型价格全 0（未定价，按 0 计费）；同名模型只加路由、**不改价**；
 * - 概览告警 `models-unpriced`（warn）：已启用且价格全 0 的模型个数，message 列出前 5 个名字。
 */

let ctx: TestApp | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

interface Setup {
  app: TestApp
  admin: TestSession
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  return { app: ctx, admin: loginAs(ctx.app, adminUser) }
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

async function createChannel(app: TestApp, admin: TestSession, name: string): Promise<number> {
  const res = await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
    name,
    baseUrl: 'https://x.example/v1',
    apis: ['openai-completions'],
  })
  expect(res.statusCode).toBe(200)
  return json<{ channel: { id: number } }>(res).channel.id
}

interface PriceDto {
  inputMicro: number
  outputMicro: number
  cacheReadMicro: number | null
  cacheWriteMicro: number | null
  perRequestMicro: number
}

async function modelByName(
  app: TestApp,
  admin: TestSession,
  name: string,
): Promise<{ price: PriceDto; routes: { channelId: number }[] }> {
  const list = json<{ name: string; price: PriceDto; routes: { channelId: number }[] }[]>(
    await api(app.app, admin, 'GET', '/api/admin/relay/models'),
  )
  const found = list.find((model) => model.name === name)
  expect(found, `模型 ${name} 应该在列表里`).toBeDefined()
  return found!
}

async function idOf(app: TestApp, admin: TestSession, name: string): Promise<number> {
  const list = json<{ id: number; name: string }[]>(
    await api(app.app, admin, 'GET', '/api/admin/relay/models'),
  )
  return list.find((model) => model.name === name)!.id
}

async function unpricedAlert(app: TestApp, admin: TestSession): Promise<string | null> {
  const overview = json<{ alerts: { kind: string; level: string; message: string }[] }>(
    await api(app.app, admin, 'GET', '/api/admin/relay/overview'),
  )
  return overview.alerts.find((alert) => alert.kind === 'models-unpriced')?.message ?? null
}

describe('import 的价格（12 §9）', () => {
  it('省略 price → 新模型价格全 0（cacheRead/cacheWrite = null、perRequest = 0），概览出现 models-unpriced', async () => {
    const { app, admin } = await setup()
    const channelId = await createChannel(app, admin, 'import-ch')
    const imported = await api(app.app, admin, 'POST', '/api/admin/relay/models/import', {
      channelId,
      models: [{ upstreamModel: 'm1' }, { upstreamModel: 'm2', name: 'm2-alias' }],
    })
    expect(imported.statusCode).toBe(200)
    const result = json<{
      created: number
      routesAdded: number
      skipped: number
      models: { name: string; price: PriceDto }[]
    }>(imported)
    expect(result).toMatchObject({ created: 2, routesAdded: 0, skipped: 0 })
    for (const model of result.models) {
      expect(model.price).toEqual({
        inputMicro: 0,
        outputMicro: 0,
        cacheReadMicro: null,
        cacheWriteMicro: null,
        perRequestMicro: 0,
      })
    }
    expect((await modelByName(app, admin, 'm1')).price.inputMicro).toBe(0)

    expect(await unpricedAlert(app, admin)).toBe('2 个模型还没定价（按 0 计费）：m1、m2-alias')

    // 定价后告警逐个减少，全定价后消失
    await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(await idOf(app, admin, 'm1'))}`, {
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    })
    expect(await unpricedAlert(app, admin)).toBe('1 个模型还没定价（按 0 计费）：m2-alias')
    await api(
      app.app,
      admin,
      'PATCH',
      `/api/admin/relay/models/${String(await idOf(app, admin, 'm2-alias'))}`,
      { price: { inputMicro: 1_000_000, outputMicro: 2_000_000, perRequestMicro: 1 } },
    )
    expect(await unpricedAlert(app, admin)).toBeNull()
  })

  it('同名模型已存在 → 只加路由、不改价（即使请求带了 price）', async () => {
    const { app, admin } = await setup()
    const channelA = await createChannel(app, admin, 'price-ch-a')
    const channelB = await createChannel(app, admin, 'price-ch-b')
    await api(app.app, admin, 'POST', '/api/admin/relay/models', {
      name: 'priced-model',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000, perRequestMicro: 3 },
      routes: [{ channelId: channelA, upstreamModel: 'up-a', enabled: true }],
    })

    const imported = await api(app.app, admin, 'POST', '/api/admin/relay/models/import', {
      channelId: channelB,
      models: [{ upstreamModel: 'up-b', name: 'priced-model' }],
      price: { inputMicro: 9_000_000, outputMicro: 9_000_000, perRequestMicro: 9 },
    })
    expect(imported.statusCode).toBe(200)
    expect(json<{ created: number; routesAdded: number }>(imported)).toMatchObject({
      created: 0,
      routesAdded: 1,
    })

    const model = await modelByName(app, admin, 'priced-model')
    expect(model.price).toEqual({
      inputMicro: 1_000_000,
      outputMicro: 2_000_000,
      cacheReadMicro: null,
      cacheWriteMicro: null,
      perRequestMicro: 3,
    })
    expect(model.routes.map((route) => route.channelId).sort()).toEqual([channelA, channelB].sort())
  })
})

describe('概览告警 models-unpriced（12 §9）', () => {
  it('只统计已启用且价格全 0 的模型；message 列前 5 个名字；缓存价非 0 或停用不算', async () => {
    const { app, admin } = await setup()
    const createModel = async (body: Record<string, unknown>): Promise<void> => {
      const res = await api(app.app, admin, 'POST', '/api/admin/relay/models', body)
      expect(res.statusCode).toBe(200)
    }
    for (const name of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) {
      await createModel({ name, price: { inputMicro: 0, outputMicro: 0 } })
    }
    // 停用的不算
    await createModel({ name: 'u-off', enabled: false, price: { inputMicro: 0, outputMicro: 0 } })
    // 缓存价非 0 = 已经能计费，不算「全 0」
    await createModel({ name: 'u-cache', price: { inputMicro: 0, outputMicro: 0, cacheReadMicro: 100 } })
    // 只有每次费用非 0 也算已定价
    await createModel({ name: 'u-request', price: { inputMicro: 0, outputMicro: 0, perRequestMicro: 1 } })

    const message = await unpricedAlert(app, admin)
    expect(message).toBe('6 个模型还没定价（按 0 计费）：u1、u2、u3、u4、u5')
    expect(message).not.toContain('u6')
    expect(message).not.toContain('u-off')

    const alert = json<{ alerts: { kind: string; level: string; channelId: number | null }[] }>(
      await api(app.app, admin, 'GET', '/api/admin/relay/overview'),
    ).alerts.find((item) => item.kind === 'models-unpriced')!
    expect(alert.level).toBe('warn')
    expect(alert.channelId).toBeNull()
  })
})
