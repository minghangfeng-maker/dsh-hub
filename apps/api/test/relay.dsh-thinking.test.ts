import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { RelayDshResponse, RelayModel } from '@dsh-hub/shared'
import type { TestApp, TestSession, TestUser } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import { createChannel, createRelayModel } from './helpers-relay.js'
import { startInstance } from './helpers-wp3.js'

/**
 * 默认思考档位（12 §7.0「默认思考档位（WP13）」，WP13a）：
 * 写入校验（创建 / 修改 / 导入）、`GET /dsh` 的生效档位与 warnings、按「协议 × 档位」分路由的渲染、
 * 默认模型的 `reasoningEffort`、统一的 `HUB_MK_HUB` 密钥 env、改档位触发重新下发、路由增减只重启。
 *
 * 关键前提（真容器 `dsh-llm-pi-ai` 0.2.0-rc.2 源码核实）：pi-ai 的 provider profile 有 `reasoning` 字段，
 * 模型条目没有默认档位字段；同一条路由里的模型必须都支持这个档位，所以按生效档位分路由。
 */

let ctx: TestApp | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

interface Setup {
  app: TestApp
  admin: TestSession
  user: TestSession
  users: TestUser[]
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '7842' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  const alice = await createUser(ctx.app, { username: 'alice' })
  const bob = await createUser(ctx.app, { username: 'bob' })
  const admin = loginAs(ctx.app, adminUser)
  const user = loginAs(ctx.app, alice)
  ctx.app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7842/v1')
  return { app: ctx, admin, user, users: [alice, bob] }
}

function api(
  app: FastifyInstance,
  session: TestSession,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

async function getDsh(app: TestApp, session: TestSession): Promise<RelayDshResponse> {
  const res = await api(app.app, session, 'GET', '/api/admin/relay/dsh')
  expect(res.statusCode, res.body).toBe(200)
  return json<RelayDshResponse>(res)
}

async function putDsh(
  app: TestApp,
  session: TestSession,
  payload: { modelIds: number[]; defaultModelId: number | null },
): Promise<{ statusCode: number; body: RelayDshResponse; raw: string }> {
  const res = await api(app.app, session, 'PUT', '/api/admin/relay/dsh', payload)
  return {
    statusCode: res.statusCode,
    body: res.statusCode === 200 ? json<RelayDshResponse>(res) : ({} as RelayDshResponse),
    raw: res.body,
  }
}

/** 建渠道 + 模型（走 REST，便于断言错误码）；返回响应与 DTO */
async function createModelViaApi(
  app: TestApp,
  session: TestSession,
  input: Record<string, unknown>,
): Promise<{ statusCode: number; raw: string; model: RelayModel | null }> {
  const channel = createChannel(app.app, {
    name: `ch-${String(input.name)}`,
    baseUrl: 'https://upstream.example/v1',
    apis: (input.apis as ('openai-completions' | 'anthropic-messages' | 'openai-responses')[]) ?? [
      'openai-completions',
    ],
    keys: ['k-1'],
  })
  const res = await api(app.app, session, 'POST', '/api/admin/relay/models', {
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { contextWindow: 128_000, maxTokens: 8_192 },
    routes: [{ channelId: channel.id, upstreamModel: `up-${String(input.name)}` }],
    ...input,
  })
  return {
    statusCode: res.statusCode,
    raw: res.body,
    model: res.statusCode === 200 ? json<{ model: RelayModel }>(res).model : null,
  }
}

/** 建一个模型（带档位声明），返回 DTO */
async function seedModel(
  app: TestApp,
  opts: {
    name: string
    apis?: ('openai-completions' | 'anthropic-messages' | 'openai-responses')[]
    reasoningEfforts?: string[]
    defaultThinking?: string | null
    visibility?: 'all' | 'admin'
    enabled?: boolean
  },
): Promise<RelayModel> {
  const channel = createChannel(app.app, {
    name: `ch-${opts.name}`,
    baseUrl: 'https://upstream.example/v1',
    apis: opts.apis ?? ['openai-completions'],
    keys: ['k-1'],
  })
  return await createRelayModel(app.app, {
    name: opts.name,
    displayName: `显示 ${opts.name}`,
    ...(opts.visibility === undefined ? {} : { visibility: opts.visibility }),
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
    ...(opts.defaultThinking === undefined ? {} : { defaultThinking: opts.defaultThinking as never }),
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: {
      contextWindow: 128_000,
      maxTokens: 8_192,
      ...(opts.reasoningEfforts === undefined ? {} : { reasoningEfforts: opts.reasoningEfforts }),
    },
    routes: [{ channelId: channel.id, upstreamModel: `up-${opts.name}`, enabled: true }],
  })
}

/** 渲染出的 patch 里的 llm-pi-ai 提供方与默认模型条目 */
function patchOf(app: TestApp, userId: number): Promise<string> {
  return app.app.deps.services.models.renderManaged(userId).then((result) => result.content)
}

function entriesOf(content: string): { id: string; config: unknown }[] {
  return parseYaml(content) as { id: string; config: unknown }[]
}

function providersOf(content: string): Record<string, Record<string, unknown>> {
  const entry = entriesOf(content).find((item) => item.id === 'llm-pi-ai')
  return (entry?.config as { providers: Record<string, Record<string, unknown>> }).providers
}

function defaultModelOf(content: string): Record<string, unknown> {
  const entry = entriesOf(content).find((item) => item.id === 'agent-default-model')
  return entry?.config as Record<string, unknown>
}

describe('写入校验：defaultThinking 必须在（写入后的）info.reasoningEfforts 里（12 §7.0）', () => {
  it('创建：声明了就能设；没声明 / 只有 off → VALIDATION_FAILED（fields.defaultThinking 给中文原因）', async () => {
    const { app, admin } = await setup()
    const ok = await createModelViaApi(app, admin, {
      name: 'wp13a-ok',
      defaultThinking: 'high',
      info: { contextWindow: 128_000, maxTokens: 8_192, reasoningEfforts: ['off', 'high'] },
    })
    expect(ok.statusCode, ok.raw).toBe(200)
    expect(ok.model?.defaultThinking).toBe('high')
    expect(
      app.app.deps.db.get<{ default_thinking: string | null }>(
        'SELECT default_thinking FROM relay_models WHERE id = ?',
        ok.model!.id,
      )!.default_thinking,
    ).toBe('high')

    // 没声明这个档位
    const bad = await createModelViaApi(app, admin, {
      name: 'wp13a-bad',
      defaultThinking: 'max',
      info: { contextWindow: 128_000, maxTokens: 8_192, reasoningEfforts: ['off', 'high'] },
    })
    expect(bad.statusCode, bad.raw).toBe(400)
    const error = json<{ error: { code: string; details: { fields: Record<string, string> } } }>({
      body: bad.raw,
    }).error
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.details.fields.defaultThinking).toContain('没有「max」')
    expect(error.details.fields.defaultThinking).toContain('off、high')

    // 只有 off（没有思考能力）→ 也不能设
    const onlyOff = await createModelViaApi(app, admin, {
      name: 'wp13a-off',
      defaultThinking: 'off',
      info: { contextWindow: 128_000, maxTokens: 8_192, reasoningEfforts: ['off'] },
    })
    expect(onlyOff.statusCode, onlyOff.raw).toBe(400)
    expect(
      json<{ error: { details: { fields: Record<string, string> } } }>({ body: onlyOff.raw }).error.details
        .fields.defaultThinking,
    ).toContain('off 之外的思考档位')

    // 完全不设 = null，合法
    const none = await createModelViaApi(app, admin, {
      name: 'wp13a-none',
      info: { contextWindow: 128_000, maxTokens: 8_192 },
    })
    expect(none.statusCode, none.raw).toBe(200)
    expect(none.model?.defaultThinking).toBeNull()
  })

  it('修改：只改 info 让现有档位失效 → 400 且库里不变；显式改/清才生效；省略不改', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, {
      name: 'wp13a-patch',
      reasoningEfforts: ['off', 'low', 'high'],
      defaultThinking: 'high',
    })
    const patch = (payload: Record<string, unknown>) =>
      api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(model.id)}`, payload)

    // 只改 info，把 high 去掉 → 现有默认档位失效 → 报错，且 info 与 default_thinking 都没变
    const invalidated = await patch({
      info: { contextWindow: 200_000, maxTokens: 8_192, reasoningEfforts: ['off', 'low'] },
    })
    expect(invalidated.statusCode, invalidated.body).toBe(400)
    const body = json<{ error: { code: string; details: { fields: Record<string, string> } } }>(invalidated)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.fields.defaultThinking).toContain('没有「high」')
    const stored = app.app.deps.db.get<{ default_thinking: string | null; info_json: string }>(
      'SELECT default_thinking, info_json FROM relay_models WHERE id = ?',
      model.id,
    )!
    expect(stored.default_thinking).toBe('high')
    expect(JSON.parse(stored.info_json)).toMatchObject({ contextWindow: 128_000 })

    // 同时把 info 与 defaultThinking 改掉 → 通过
    const moved = await patch({
      info: { contextWindow: 200_000, maxTokens: 8_192, reasoningEfforts: ['off', 'low'] },
      defaultThinking: 'low',
    })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(json<{ model: RelayModel }>(moved).model.defaultThinking).toBe('low')

    // 只改显示名：不能把 defaultThinking 重置掉（zod 4 partial 陷阱）
    const renamed = await patch({ displayName: '改名' })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(json<{ model: RelayModel }>(renamed).model.defaultThinking).toBe('low')

    // 显式清空
    const cleared = await patch({ defaultThinking: null })
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(json<{ model: RelayModel }>(cleared).model.defaultThinking).toBeNull()
  })

  it('导入：新建的模型 default_thinking = NULL（12 §7.0）', async () => {
    const { app, admin } = await setup()
    const channel = createChannel(app.app, {
      name: 'ch-import',
      baseUrl: 'https://upstream.example/v1',
      apis: ['openai-completions'],
      keys: ['k-1'],
    })
    const res = await api(app.app, admin, 'POST', '/api/admin/relay/models/import', {
      channelId: channel.id,
      models: [{ upstreamModel: 'imp-a', name: 'imp-a' }],
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(json<{ models: RelayModel[] }>(res).models[0]!.defaultThinking).toBeNull()
    expect(
      app.app.deps.db.get<{ default_thinking: string | null }>(
        "SELECT default_thinking FROM relay_models WHERE name = 'imp-a'",
      )!.default_thinking,
    ).toBeNull()
  })
})

describe('GET /api/admin/relay/dsh：生效档位与 warnings（12 §7.0）', () => {
  it('每行给生效档位；设了但不生效的已选模型进 warnings', async () => {
    const { app, admin } = await setup()
    const ok = await seedModel(app, {
      name: 'wp13a-listed',
      reasoningEfforts: ['off', 'medium'],
      defaultThinking: 'medium',
    })
    const stale = await seedModel(app, {
      name: 'wp13a-stale',
      reasoningEfforts: ['off', 'high'],
      defaultThinking: 'high',
    })
    const put = await putDsh(app, admin, { modelIds: [ok.id, stale.id], defaultModelId: ok.id })
    expect(put.statusCode, put.raw).toBe(200)
    const listed = await getDsh(app, admin)
    expect(listed.models.find((model) => model.id === ok.id)?.defaultThinking).toBe('medium')
    expect(listed.warnings).toEqual([])

    // 直接改库（模拟历史数据 / 手工改库）：档位还在，但模型已经不声明它了 → 不生效 + 警告
    app.app.deps.db.run(
      'UPDATE relay_models SET info_json = ? WHERE id = ?',
      JSON.stringify({ contextWindow: 128_000, reasoningEfforts: ['off', 'low'] }),
      stale.id,
    )
    const after = await getDsh(app, admin)
    expect(after.models.find((model) => model.id === stale.id)?.defaultThinking).toBeNull()
    expect(after.warnings.join('\n')).toContain(
      '模型「显示 wp13a-stale」的默认思考档位 high 不在它声明的档位里，没有生效',
    )

    // 不生效的旧值不挡无关修改（改价格照常 200）；显式清掉后 warning 消失
    const priced = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(stale.id)}`, {
      price: { inputMicro: 2_000_000, outputMicro: 4_000_000 },
    })
    expect(priced.statusCode, priced.body).toBe(200)
    const cleared = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(stale.id)}`, {
      defaultThinking: null,
    })
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect((await getDsh(app, admin)).warnings).toEqual([])
  })
})

describe('渲染：按「协议 × 档位」分路由（12 §7.0「渲染」）', () => {
  it('带档位的路由有 reasoning；模型只出现在对应路由；apiKeyEnv 全是 HUB_MK_HUB', async () => {
    const { app, admin, users } = await setup()
    const plain = await seedModel(app, { name: 'wp13a-plain' })
    const high = await seedModel(app, {
      name: 'wp13a-high',
      reasoningEfforts: ['off', 'high'],
      defaultThinking: 'high',
    })
    const put = await putDsh(app, admin, { modelIds: [plain.id, high.id], defaultModelId: plain.id })
    expect(put.statusCode, put.raw).toBe(200)

    const content = await patchOf(app, users[0]!.id)
    const providers = providersOf(content)
    // 顺序：默认模型（无档位）所在路由第一，其余按档位顺序
    expect(Object.keys(providers)).toEqual(['hub', 'hub-high'])
    expect(providers['hub']!.reasoning).toBeUndefined()
    expect(providers['hub-high']!.reasoning).toBe('high')
    expect(providers['hub']!.apiKeyEnv).toBe('HUB_MK_HUB')
    expect(providers['hub-high']!.apiKeyEnv).toBe('HUB_MK_HUB')
    expect(providers['hub']!.displayName).toBe('DSH Hub')
    expect(providers['hub-high']!.displayName).toBe('DSH Hub')
    expect((providers['hub']!.models as { id: string }[]).map((model) => model.id)).toEqual([
      'wp13a-plain@ch-wp13a-plain',
    ])
    expect((providers['hub-high']!.models as { id: string }[]).map((model) => model.id)).toEqual([
      'wp13a-high@ch-wp13a-high',
    ])
    // 默认模型没有档位 → 不写 reasoningEffort
    expect(defaultModelOf(content)).toEqual({
      provider: 'hub',
      model: 'wp13a-plain@ch-wp13a-plain',
    })

    // 管理端提供方列表（DTO 派生字段）也只列该路由档位下的模型
    const dto = json<{ id: number; routeKey: string; models: { id: string }[] }[]>(
      await api(app.app, admin, 'GET', '/api/admin/models/providers'),
    )
    expect(dto.map((provider) => [provider.routeKey, provider.models.map((model) => model.id)])).toEqual([
      ['hub', ['wp13a-plain@ch-wp13a-plain']],
      ['hub-high', ['wp13a-high@ch-wp13a-high']],
    ])

    // 库里：带档位的系统提供方把档位存在 extra_json
    const rows = app.app.deps.db.all<{ route_key: string; extra_json: string | null }>(
      'SELECT route_key, extra_json FROM model_providers ORDER BY route_key ASC',
    )
    expect(rows).toEqual([
      { route_key: 'hub', extra_json: null },
      { route_key: 'hub-high', extra_json: '{"reasoning":"high"}' },
    ])

    // 默认模型有档位 → agent-default-model 同时写 reasoningEffort
    const switched = await putDsh(app, admin, { modelIds: [plain.id, high.id], defaultModelId: high.id })
    expect(switched.statusCode, switched.raw).toBe(200)
    const content2 = await patchOf(app, users[0]!.id)
    expect(defaultModelOf(content2)).toEqual({
      provider: 'hub-high',
      model: 'wp13a-high@ch-wp13a-high',
      reasoningEffort: 'high',
    })
    // 路由顺序：默认模型所在路由第一
    expect(Object.keys(providersOf(content2))).toEqual(['hub-high', 'hub'])
  })

  it('某路由对该用户一个可见模型都没有 → 这条路由不渲染（admin-only）', async () => {
    const { app, admin, user, users } = await setup()
    const shared = await seedModel(app, { name: 'wp13a-shared' })
    const adminOnly = await seedModel(app, {
      name: 'wp13a-admin',
      visibility: 'admin',
      reasoningEfforts: ['off', 'low'],
      defaultThinking: 'low',
    })
    const put = await putDsh(app, admin, { modelIds: [shared.id, adminOnly.id], defaultModelId: shared.id })
    expect(put.statusCode, put.raw).toBe(200)

    const normal = await patchOf(app, users[0]!.id)
    expect(Object.keys(providersOf(normal))).toEqual(['hub'])
    expect(normal).not.toContain('wp13a-admin')
    expect(normal).not.toContain('hub-low')

    const adminContent = await patchOf(app, admin.user.id)
    expect(Object.keys(providersOf(adminContent))).toEqual(['hub', 'hub-low'])
    expect(adminContent).toContain('id: wp13a-admin')

    // 直接调桥：省略 thinking = 不按档位筛（WP12 旧口径，给手工建的非系统提供方留着）
    const service = app.app.deps.services.relay
    expect(
      service
        .providerModels('openai-completions', { userId: users[0]!.id, admin: false })
        .map((model) => model.id),
    ).toEqual(['wp13a-shared@ch-wp13a-shared'])
    // 给了档位 = 只渲染该档位的模型（系统的每一条路由都用它）
    expect(
      service
        .providerModels('openai-completions', { userId: users[0]!.id, admin: false, thinking: null })
        .map((model) => model.id),
    ).toEqual(['wp13a-shared@ch-wp13a-shared'])
    expect(
      service
        .providerModels('openai-completions', { userId: users[0]!.id, admin: false, thinking: 'low' })
        .map((model) => model.id),
    ).toEqual([])
    void user
  })

  it('默认模型对某用户不可见 → 不写 reasoningEffort（路由也不渲染，行为与 WP12 一致）', async () => {
    const { app, admin, users } = await setup()
    const visible = await seedModel(app, { name: 'wp13a-visible' })
    const adminDefault = await seedModel(app, {
      name: 'wp13a-admin-default',
      visibility: 'admin',
      reasoningEfforts: ['off', 'xhigh'],
      defaultThinking: 'xhigh',
    })
    const put = await putDsh(app, admin, {
      modelIds: [visible.id, adminDefault.id],
      defaultModelId: adminDefault.id,
    })
    expect(put.statusCode, put.raw).toBe(200)

    const normal = await patchOf(app, users[0]!.id)
    // 默认提供方（hub-xhigh）对普通用户是空的 → 整条不渲染；默认条目保留配置但不写档位
    expect(Object.keys(providersOf(normal))).toEqual(['hub'])
    expect(defaultModelOf(normal)).toEqual({
      provider: 'hub-xhigh',
      model: 'wp13a-admin-default@ch-wp13a-admin-default',
    })
    // 管理员自己看得见 → 档位照写
    const adminContent = await patchOf(app, admin.user.id)
    expect(Object.keys(providersOf(adminContent))).toEqual(['hub-xhigh', 'hub'])
    expect(defaultModelOf(adminContent)).toMatchObject({ reasoningEffort: 'xhigh' })
    expect(adminContent).toContain('reasoning: xhigh')
  })

  it('containerEnv：多个带档位的系统路由只注入一个 HUB_MK_HUB', async () => {
    const { app, admin, users } = await setup()
    const a = await seedModel(app, {
      name: 'wp13a-env-a',
      reasoningEfforts: ['off', 'low'],
      defaultThinking: 'low',
    })
    const b = await seedModel(app, {
      name: 'wp13a-env-b',
      apis: ['anthropic-messages'],
      reasoningEfforts: ['off', 'max'],
      defaultThinking: 'max',
    })
    const put = await putDsh(app, admin, { modelIds: [a.id, b.id], defaultModelId: a.id })
    expect(put.statusCode, put.raw).toBe(200)
    const routes = app.app.deps.db.all<{ route_key: string }>(
      'SELECT route_key FROM model_providers ORDER BY route_key ASC',
    )
    expect(routes.map((row) => row.route_key)).toEqual(['hub-anthropic-max', 'hub-low'])

    const env = await app.app.deps.services.models.containerEnv(users[0]!.id)
    expect(Object.keys(env)).toEqual(['HUB_MK_HUB'])
    expect(env.HUB_MK_HUB).toMatch(/^sk-dsh-[0-9A-Za-z]{40}$/)
  })

  it('WP12 时代建的系统提供方行（旧显示名）被对齐成「DSH Hub」', async () => {
    const { app, admin } = await setup()
    const at = app.app.deps.clock.nowIso()
    // 手工造一行 WP12 口径的 hub-anthropic（显示名是旧的「Hub 中转站 · Anthropic」）
    app.app.deps.db.run(
      `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                    extra_json, key_mode, api_key_enc, enabled, is_relay, created_at, updated_at)
       VALUES ('hub-anthropic', 'Hub 中转站 · Anthropic', 'pi-ai', 'anthropic-messages', NULL, '[]', NULL,
               NULL, 'per-user', NULL, 1, 1, ?, ?)`,
      at,
      at,
    )
    const model = await seedModel(app, { name: 'wp13a-align', apis: ['anthropic-messages'] })
    const put = await putDsh(app, admin, { modelIds: [model.id], defaultModelId: model.id })
    expect(put.statusCode, put.raw).toBe(200)
    const row = app.app.deps.db.get<{ display_name: string; enabled: number }>(
      "SELECT display_name, enabled FROM model_providers WHERE route_key = 'hub-anthropic'",
    )!
    expect(row).toEqual({ display_name: 'DSH Hub', enabled: 1 })
  })
})

describe('同步与下发（12 §7.0「同步时机」）', () => {
  it('改档位 → revision+1、pending=true；只改价格不影响', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, {
      name: 'wp13a-sync',
      reasoningEfforts: ['off', 'low', 'high'],
    })
    const put = await putDsh(app, admin, { modelIds: [model.id], defaultModelId: model.id })
    expect(put.statusCode, put.raw).toBe(200)
    const before = await getDsh(app, admin)
    expect(before.revision).toBe(1)

    app.clock.advance(60_000)
    const patched = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(model.id)}`, {
      defaultThinking: 'high',
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const after = await getDsh(app, admin)
    expect(after.revision).toBe(before.revision + 1)
    expect(after.pending).toBe(true)
    expect(after.models[0]!.defaultThinking).toBe('high')
    // 换了档位 = 换了路由：hub-high 启用，旧的 hub 行不再被预设引用 → 停用（12 §7.0）
    expect(
      app.app.deps.db.all<{ route_key: string; enabled: number }>(
        "SELECT route_key, enabled FROM model_providers WHERE route_key LIKE 'hub%' ORDER BY route_key ASC",
      ),
    ).toEqual([
      { route_key: 'hub', enabled: 0 },
      { route_key: 'hub-high', enabled: 1 },
    ])
    // 系统预设里也只剩这条路由（不再用到的路由从预设里拿掉，12 §7.0）
    const preset = app.app.deps.db.get<{
      provider_ids_json: string
      default_provider: string
      default_model: string
    }>(
      "SELECT provider_ids_json, default_provider, default_model FROM model_presets WHERE name = 'Hub 中转站'",
    )!
    const hubHighId = app.app.deps.db.get<{ id: number }>(
      "SELECT id FROM model_providers WHERE route_key = 'hub-high'",
    )!.id
    expect(JSON.parse(preset.provider_ids_json)).toEqual([hubHighId])
    expect(preset.default_provider).toBe('hub-high')
    expect(preset.default_model).toBe('wp13a-sync@ch-wp13a-sync')

    // 只改价格：updatedAt / revision 都不动（12 §7.0：改价格不触发）
    const beforePrice = { updatedAt: after.updatedAt, revision: after.revision }
    app.clock.advance(60_000)
    await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(model.id)}`, {
      price: {
        inputMicro: 9_000_000,
        outputMicro: 9_000_000,
        cacheReadMicro: null,
        cacheWriteMicro: null,
        perRequestMicro: 0,
      },
    })
    const afterPrice = await getDsh(app, admin)
    expect(afterPrice.updatedAt).toBe(beforePrice.updatedAt)
    expect(afterPrice.revision).toBe(beforePrice.revision)
  })

  it('路由增减（多一个档位 = 多一条路由）后 applyForUser 只重启、不重建', async () => {
    const { app, admin, users } = await setup()
    const plain = await seedModel(app, { name: 'wp13a-restart' })
    const put = await putDsh(app, admin, { modelIds: [plain.id], defaultModelId: plain.id })
    expect(put.statusCode, put.raw).toBe(200)

    const userId = users[0]!.id
    await startInstance(app.app, userId)
    const containerName = `dshhub-${users[0]!.slug}`
    const logs: string[] = []
    await app.app.deps.services.models.applyForUser(userId, undefined, { onLog: (line) => logs.push(line) })
    const firstId = (await ctx!.driver!.listManaged()).find((info) => info.name === containerName)?.id
    expect(firstId).toBeDefined()
    expect(logs.join('\n')).not.toContain('重建容器')

    // 加一个带档位的模型 → 多一条路由：patch 内容变了，但密钥 env 没变（都是 HUB_MK_HUB）
    const leveled = await seedModel(app, {
      name: 'wp13a-restart-high',
      reasoningEfforts: ['off', 'high'],
      defaultThinking: 'high',
    })
    const put2 = await putDsh(app, admin, {
      modelIds: [plain.id, leveled.id],
      defaultModelId: plain.id,
    })
    expect(put2.statusCode, put2.raw).toBe(200)
    const logs2: string[] = []
    await app.app.deps.services.models.applyForUser(userId, undefined, { onLog: (line) => logs2.push(line) })
    expect(logs2.join('\n')).toContain('重启 DSH')
    expect(logs2.join('\n')).not.toContain('重建容器')
    const secondId = (await ctx!.driver!.listManaged()).find((info) => info.name === containerName)?.id
    expect(secondId).toBe(firstId)
    expect((await ctx!.driver!.getContainer(containerName)?.spec.env.HUB_MK_HUB) ?? '').toMatch(/^sk-dsh-/)
    // 容器 env 里只有一个 HUB_MK_* 键（其余是运行时基础 env）
    const envKeys = Object.keys(ctx!.driver!.getContainer(containerName)?.spec.env ?? {})
    expect(envKeys.filter((key) => key.startsWith('HUB_MK_'))).toEqual(['HUB_MK_HUB'])
  })

  it('集成：建渠道 → 导入 → 设档位 → PUT dsh → 渲染出的 managed.patch.yml 符合预期', async () => {
    const { app, admin, users } = await setup()
    const channel = createChannel(app.app, {
      name: 'wp13a-e2e',
      baseUrl: 'https://upstream.example/v1',
      apis: ['openai-completions'],
      keys: ['k-1'],
    })
    const imported = await api(app.app, admin, 'POST', '/api/admin/relay/models/import', {
      channelId: channel.id,
      models: [
        { upstreamModel: 'e2e-plain', name: 'e2e-plain' },
        { upstreamModel: 'e2e-thinker', name: 'e2e-thinker' },
      ],
    })
    expect(imported.statusCode, imported.body).toBe(200)
    const models = json<{ models: RelayModel[] }>(imported).models
    const thinker = models.find((model) => model.name === 'e2e-thinker')!
    const plain = models.find((model) => model.name === 'e2e-plain')!

    // 设档位（先声明档位再设：写入校验要求写入后的 info 里有它）
    const declared = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(thinker.id)}`, {
      info: { contextWindow: 64_000, maxTokens: 4_096, reasoningEfforts: ['off', 'medium'] },
    })
    expect(declared.statusCode, declared.body).toBe(200)
    const leveled = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(thinker.id)}`, {
      defaultThinking: 'medium',
      displayName: '推理模型',
    })
    expect(leveled.statusCode, leveled.body).toBe(200)

    const put = await putDsh(app, admin, { modelIds: [plain.id, thinker.id], defaultModelId: thinker.id })
    expect(put.statusCode, put.raw).toBe(200)
    expect(put.body.revision).toBe(1)
    expect(put.body.pending).toBe(true)
    expect(put.body.warnings).toEqual([])

    const content = await patchOf(app, users[0]!.id)
    const providers = providersOf(content)
    expect(Object.keys(providers)).toEqual(['hub-medium', 'hub'])
    expect(providers['hub-medium']!.reasoning).toBe('medium')
    expect((providers['hub-medium']!.models as { id: string; name: string }[])[0]).toMatchObject({
      id: 'e2e-thinker@wp13a-e2e',
      name: '推理模型 · wp13a-e2e',
    })
    expect((providers['hub']!.models as { id: string }[]).map((model) => model.id)).toEqual([
      'e2e-plain@wp13a-e2e',
    ])
    expect(defaultModelOf(content)).toEqual({
      provider: 'hub-medium',
      model: 'e2e-thinker@wp13a-e2e',
      reasoningEffort: 'medium',
    })

    // 落盘的 managed.patch.yml 与渲染结果一致（用户目录存在时才写）
    const patchPath = join(app.dataDir, 'users', users[0]!.slug, 'managed', 'managed.patch.yml')
    const onDisk = await import('node:fs').then((fs) =>
      fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : null,
    )
    if (onDisk !== null) expect(onDisk).toBe(content)
  })
})
