import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { TestApp, TestSession } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'

/**
 * PATCH 只改请求里给出的字段（04 §4.9 的 2026-10-16 契约变更）。
 *
 * 契约侧（`packages/shared`）已去掉 zod 4 `.partial()` 注入的默认值，这里从**接口层**钉住后端行为：
 * 只改名字不能把优先级 / 权重 / 并发 / 超时 / 补 usage / 启用 / 备注 / 倍率重置成默认值；
 * 提供方只改显示名不能清空模型列表。
 */

let ctx: TestApp | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

interface Setup {
  app: TestApp
  admin: TestSession
  adminPassword: string
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  return { app: ctx, admin: loginAs(ctx.app, adminUser), adminPassword: adminUser.password }
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

describe('PATCH 只改给出的字段（04 §4.9）', () => {
  it('渠道只改名：优先级、权重、并发、超时、补 usage、启用、备注、倍率全部不变', async () => {
    const { app, admin } = await setup()
    const created = await api(app.app, admin, 'POST', '/api/admin/relay/channels', {
      name: 'keep-all',
      baseUrl: 'https://keep.example/v1',
      apis: ['openai-completions', 'anthropic-messages'],
      ratePermille: 1750,
      priority: 7,
      weight: 9,
      maxConcurrency: 3,
      timeoutMs: 123_456,
      streamUsage: false,
      enabled: true,
      note: '别动我',
      headers: { 'x-extra': 'yes' },
      keys: ['k-1'],
    })
    expect(created.statusCode).toBe(200)
    const channelId = json<{ channel: { id: number } }>(created).channel.id

    const renamed = await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(channelId)}`, {
      name: 'keep-all-2',
    })
    expect(renamed.statusCode).toBe(200)
    expect(json<{ channel: Record<string, unknown> }>(renamed).channel).toMatchObject({
      name: 'keep-all-2',
      baseUrl: 'https://keep.example/v1',
      apis: ['openai-completions', 'anthropic-messages'],
      ratePermille: 1750,
      priority: 7,
      weight: 9,
      maxConcurrency: 3,
      timeoutMs: 123_456,
      streamUsage: false,
      enabled: true,
      note: '别动我',
      headers: { 'x-extra': 'yes' },
    })

    // PATCH {enabled:false}：只改启用（倍率等照旧）
    const disabled = await api(app.app, admin, 'PATCH', `/api/admin/relay/channels/${String(channelId)}`, {
      enabled: false,
    })
    expect(json<{ channel: Record<string, unknown> }>(disabled).channel).toMatchObject({
      name: 'keep-all-2',
      ratePermille: 1750,
      priority: 7,
      weight: 9,
      maxConcurrency: 3,
      timeoutMs: 123_456,
      streamUsage: false,
      enabled: false,
      note: '别动我',
    })
    // 库里也确认一遍（DTO 之外没有别的写入路径）
    expect(
      app.app.deps.db.get<Record<string, unknown>>('SELECT * FROM relay_channels WHERE id = ?', channelId),
    ).toMatchObject({
      name: 'keep-all-2',
      rate_permille: 1750,
      priority: 7,
      weight: 9,
      max_concurrency: 3,
      timeout_ms: 123_456,
      stream_usage: 0,
      enabled: 0,
      note: '别动我',
      headers_json: '{"x-extra":"yes"}',
    })
  })

  it('提供方只改显示名：模型列表、baseUrl、密钥状态都不变', async () => {
    const { app, admin, adminPassword } = await setup()
    // 带 apiKey 的写操作要二次验证（04 §4.7）
    expect(
      (await api(app.app, admin, 'POST', '/api/auth/reauth', { password: adminPassword })).statusCode,
    ).toBe(204)
    const created = await api(app.app, admin, 'POST', '/api/admin/models/providers', {
      routeKey: 'keep-provider',
      displayName: '原显示名',
      kind: 'pi-ai',
      api: 'openai-completions',
      baseUrl: 'https://provider.example/v1',
      models: [
        { id: 'model-a', name: 'Model A', contextWindow: 64_000 },
        { id: 'model-b', name: 'Model B' },
      ],
      keyMode: 'shared',
      apiKey: 'sk-provider-secret-1234',
    })
    expect(created.statusCode).toBe(200)
    const providerId = json<{ provider: { id: number; models: unknown[] } }>(created).provider.id

    const patched = await api(app.app, admin, 'PATCH', `/api/admin/models/providers/${String(providerId)}`, {
      displayName: '新显示名',
    })
    expect(patched.statusCode).toBe(200)
    const provider = json<{
      provider: {
        displayName: string
        baseUrl: string
        models: { id: string }[]
        apiKey: { set: boolean; last4: string | null }
      }
    }>(patched).provider
    expect(provider.displayName).toBe('新显示名')
    expect(provider.baseUrl).toBe('https://provider.example/v1')
    expect(provider.models.map((model) => model.id)).toEqual(['model-a', 'model-b'])
    expect(provider.apiKey).toMatchObject({ set: true, last4: '1234' })

    const row = app.app.deps.db.get<{ models_json: string | null; base_url: string | null }>(
      'SELECT models_json, base_url FROM model_providers WHERE id = ?',
      providerId,
    )!
    expect(JSON.parse(row.models_json ?? '[]')).toHaveLength(2)
    expect(row.base_url).toBe('https://provider.example/v1')
  })
})
