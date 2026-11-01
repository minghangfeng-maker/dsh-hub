import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { MyRelayResponse, RelayDshResponse } from '@dsh-hub/shared'
import type { TestApp, TestSession, TestUser } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import { createChannel, createRelayModel } from './helpers-relay.js'

/**
 * 「下发到 DSH」（12 §7.0、§9；WP12a）走真实 HTTP 路由：GET / PUT /api/admin/relay/dsh。
 *
 * 覆盖：逐字段响应、选中集合与默认模型的整体替换、系统提供方/系统预设的自动维护与幂等、
 * 被阻断模型的 VALIDATION_FAILED（details 带模型名与原因）、默认模型失效自动改选、
 * 路由名被占用 → CONFLICT、pending / lastRollout / users / warnings、以及审计。
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
  // 内部监听器端口不为 0（测试里不真的监听，用 setInternalBaseUrl 模拟已监听）
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '7832' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  const alice = await createUser(ctx.app, { username: 'alice' })
  const bob = await createUser(ctx.app, { username: 'bob' })
  const admin = loginAs(ctx.app, adminUser)
  const user = loginAs(ctx.app, alice)
  ctx.app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7832/v1')
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

/** 建一个渠道 + 一个模型（默认带价格、走给定协议），返回 modelId */
async function seedModel(
  app: TestApp,
  opts: {
    name: string
    apis: ('openai-completions' | 'anthropic-messages' | 'openai-responses')[]
    enabled?: boolean
  },
): Promise<number> {
  const channel = createChannel(app.app, {
    name: `ch-${opts.name}`,
    baseUrl: 'https://upstream.example/v1',
    apis: opts.apis,
    keys: ['k-1'],
  })
  const model = await createRelayModel(app.app, {
    name: opts.name,
    displayName: `显示 ${opts.name}`,
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: `显示 ${opts.name}`, contextWindow: 128_000, maxTokens: 8_192 },
    routes: [{ channelId: channel.id, upstreamModel: `up-${opts.name}`, enabled: true }],
  })
  return model.id
}

describe('GET /api/admin/relay/dsh（12 §7.0）', () => {
  it('初始状态：没有模型、没有预设、没有下发过；users 统计与 warnings', async () => {
    const { app, admin, users } = await setup()
    const body = await getDsh(app, admin)
    expect(body).toMatchObject({
      models: [],
      defaultModelId: null,
      revision: 0,
      updatedAt: null,
      pending: false,
      lastRollout: null,
      // 管理员自己也算「统一管理」用户
      users: { total: users.length + 1, running: 0 },
      warnings: [],
    })

    // 内部监听器没在监听 → warnings（12 §7.0「渲染层面的提醒」）
    app.app.deps.services.relay.setInternalBaseUrl(null)
    expect((await getDsh(app, admin)).warnings.join('\n')).toContain('内部监听器没在监听')
  })

  it('模型行进字段：deliverApi 按协议优先级、渠道名、priced、blockedReason、selected', async () => {
    const { app, admin } = await setup()
    // 双协议模型（openai + anthropic）→ deliverApi 取 openai-completions
    const dual = await seedModel(app, { name: 'dual', apis: ['anthropic-messages', 'openai-completions'] })
    // 停用模型
    const disabled = await seedModel(app, { name: 'off', apis: ['openai-completions'], enabled: false })
    // 没有路由的模型（未定价）→ 「没有可用渠道」
    const orphan = await createRelayModel(app.app, {
      name: 'orphan',
      displayName: '没渠道',
      price: { inputMicro: 0, outputMicro: 0 },
    })
    // 渠道停用 → 也没了可用渠道
    const channel = createChannel(app.app, {
      name: 'ch-dead',
      baseUrl: 'https://dead.example/v1',
      apis: ['openai-responses'],
      keys: ['k-1'],
    })
    const dead = await createRelayModel(app.app, {
      name: 'dead',
      price: { inputMicro: 1_000, outputMicro: 2_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up', enabled: true }],
    })
    app.app.deps.services.relay.updateChannel(channel.id, { enabled: false }, 1, {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })

    const body = await getDsh(app, admin)
    const byId = new Map(body.models.map((model) => [model.id, model]))
    expect(byId.get(dual)).toMatchObject({
      name: 'dual',
      displayName: '显示 dual',
      enabled: true,
      visibility: 'all',
      deliverApi: 'openai-completions',
      channelNames: ['ch-dual'],
      apis: ['anthropic-messages', 'openai-completions'],
      priced: true,
      selected: false,
      blockedReason: null,
    })
    expect(byId.get(disabled)!.blockedReason).toBe('已停用')
    expect(byId.get(orphan.id)).toMatchObject({
      deliverApi: null,
      channelNames: [],
      priced: false,
      blockedReason: '没有可用渠道',
    })
    expect(byId.get(dead.id)).toMatchObject({
      deliverApi: null,
      channelNames: [],
      blockedReason: '没有可用渠道',
    })
  })
})

describe('PUT /api/admin/relay/dsh（12 §7.0、§9）', () => {
  it('整体替换选中集合 + 默认模型：写 dsh_enabled、系统提供方、系统预设、settings、清用户预设、审计', async () => {
    const { app, admin, users } = await setup()
    const openai = await seedModel(app, { name: 'oa-model', apis: ['openai-completions'] })
    const anthropic = await seedModel(app, { name: 'an-model', apis: ['anthropic-messages'] })
    // 先给一个用户钉住别的预设：PUT 之后必须被清空（都用默认预设）
    const otherPreset = app.app.deps.db.run(
      `INSERT INTO model_presets (name, description, provider_ids_json, default_provider, default_model,
                                  is_default, revision, created_at, updated_at)
       VALUES ('别人的预设', '', '[]', 'x', 'y', 0, 3, ?, ?)`,
      app.app.deps.clock.nowIso(),
      app.app.deps.clock.nowIso(),
    ).lastInsertRowid
    app.app.deps.db.run('UPDATE users SET model_preset_id = ? WHERE id = ?', otherPreset, users[0]!.id)

    const { statusCode, body } = await putDsh(app, admin, {
      modelIds: [openai, anthropic],
      defaultModelId: anthropic,
    })
    expect(statusCode, statusCode === 200 ? '' : JSON.stringify(body)).toBe(200)
    expect(body.defaultModelId).toBe(anthropic)
    expect(body.revision).toBe(1)
    expect(body.updatedAt).toBe(app.app.deps.clock.nowIso())
    expect(body.pending).toBe(true)
    expect(
      body.models
        .filter((model) => model.selected)
        .map((model) => model.id)
        .sort(),
    ).toEqual([openai, anthropic].sort())
    expect(body.warnings).toEqual([])

    // 系统提供方：默认模型所在路由第一（WP13 起按「协议 × 档位」分路由，显示名都是「DSH Hub」）
    const providers = app.app.deps.db.all<{
      id: number
      route_key: string
      display_name: string
      api: string
      is_relay: number
      key_mode: string
      extra_json: string | null
    }>(
      'SELECT id, route_key, display_name, api, is_relay, key_mode, extra_json FROM model_providers ORDER BY id ASC',
    )
    expect(providers.map((row) => [row.route_key, row.api, row.display_name, row.is_relay])).toEqual([
      ['hub-anthropic', 'anthropic-messages', 'DSH Hub', 1],
      ['hub', 'openai-completions', 'DSH Hub', 1],
    ])
    expect(providers.every((row) => row.key_mode === 'per-user')).toBe(true)
    // 没有档位的路由不写 extra（渲染时也就没有 provider 级 reasoning）
    expect(providers.map((row) => row.extra_json)).toEqual([null, null])

    // 系统预设：名为「Hub 中转站」、是默认预设、默认模型 = 选的 anthropic 模型
    const preset = app.app.deps.db.get<{
      id: number
      name: string
      provider_ids_json: string
      default_provider: string
      default_model: string
      is_default: number
      revision: number
    }>("SELECT * FROM model_presets WHERE name = 'Hub 中转站'")!
    expect(preset.default_provider).toBe('hub-anthropic')
    expect(preset.default_model).toBe('an-model@ch-an-model')
    expect(preset.is_default).toBe(1)
    expect(preset.revision).toBe(1)
    expect(JSON.parse(preset.provider_ids_json)).toEqual(providers.map((row) => row.id))
    // 别的预设被取消默认但不删
    expect(
      app.app.deps.db.get<{ is_default: number }>(
        'SELECT is_default FROM model_presets WHERE id = ?',
        otherPreset,
      )!.is_default,
    ).toBe(0)

    // settings.relay_dsh：预设 id + 默认模型 + 变更时间
    const settings = JSON.parse(
      app.app.deps.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'relay_dsh'")!
        .value_json,
    ) as { presetId: number; defaultModelId: number; updatedAt: string; renderHash: string }
    expect(settings).toMatchObject({ presetId: preset.id, defaultModelId: anthropic })
    expect(settings.updatedAt).toBe(app.app.deps.clock.nowIso())
    expect(settings.renderHash).toMatch(/^[0-9a-f]{32}$/)

    // 用户预设被清空
    expect(
      app.app.deps.db.all<{ model_preset_id: number | null }>(
        'SELECT model_preset_id FROM users WHERE deleted_at IS NULL',
      ),
    ).toEqual([{ model_preset_id: null }, { model_preset_id: null }, { model_preset_id: null }])

    // 审计：前后模型名列表与默认模型
    const audit = app.app.deps.db.get<{ action: string; detail_json: string }>(
      "SELECT action, detail_json FROM audit_logs WHERE action = 'relay.dsh.update' ORDER BY id DESC LIMIT 1",
    )!
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      models: { from: [], to: ['an-model', 'oa-model'] },
      defaultModel: { from: null, to: 'an-model' },
    })
  })

  it('幂等：连续两次同样的 PUT 第二次不 bump revision、不更新 updatedAt', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, { name: 'once', apis: ['openai-completions'] })
    const payload = { modelIds: [model], defaultModelId: model }

    const first = await putDsh(app, admin, payload)
    const second = await putDsh(app, admin, payload)
    expect(second.statusCode).toBe(200)
    expect(second.body.revision).toBe(first.body.revision)
    expect(second.body.updatedAt).toBe(first.body.updatedAt)
    expect(second.body.models.map((row) => row.selected)).toEqual([true])
    // 每次显式保存都留一条审计（前后列表相同 = 这次保存没有实际变化）
    const audits = app.app.deps.db.all<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'relay.dsh.update' ORDER BY id ASC",
    )
    expect(audits).toHaveLength(2)
    expect(JSON.parse(audits[1]!.detail_json)).toMatchObject({
      models: { from: ['once'], to: ['once'] },
      defaultModel: { from: 'once', to: 'once' },
    })
  })

  it('被阻断的模型出现在 modelIds 里 → VALIDATION_FAILED（details 列出模型名与原因），且不写库', async () => {
    const { app, admin } = await setup()
    const ok = await seedModel(app, { name: 'ok-model', apis: ['openai-completions'] })
    const disabled = await seedModel(app, { name: 'off-model', apis: ['openai-completions'], enabled: false })
    const orphan = await createRelayModel(app.app, {
      name: 'no-route',
      price: { inputMicro: 1_000, outputMicro: 2_000 },
    })

    const res = await api(app.app, admin, 'PUT', '/api/admin/relay/dsh', {
      modelIds: [ok, disabled, orphan.id, 999_999],
      defaultModelId: ok,
    })
    expect(res.statusCode).toBe(400)
    const body = json<{ error: { code: string; details: { routes: { name: string; reason: string }[] } } }>(
      res,
    )
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.routes).toEqual(
      expect.arrayContaining([
        { id: expect.any(Number), name: 'off-model@ch-off-model', reason: '模型已停用' },
        { id: expect.any(Number), name: '#999999', reason: '模型不存在' },
      ]),
    )
    // 整体替换有事务性：失败的 PUT 不留半截状态
    expect(app.app.deps.db.all<{ dsh_enabled: number }>('SELECT dsh_enabled FROM relay_models')).toEqual([
      { dsh_enabled: 0 },
      { dsh_enabled: 0 },
      { dsh_enabled: 0 },
    ])
    expect(app.app.deps.db.get('SELECT COUNT(*) AS n FROM model_presets')).toMatchObject({ n: 0 })
  })

  it('已选中、后来才被停用的模型：原样再保存照常 200（保持选中、给 warnings），取消勾选也能保存', async () => {
    const { app, admin } = await setup()
    const keep = await seedModel(app, { name: 'keep-model', apis: ['openai-completions'] })
    const later = await seedModel(app, { name: 'later-off', apis: ['openai-completions'] })
    expect((await putDsh(app, admin, { modelIds: [keep, later], defaultModelId: keep })).statusCode).toBe(200)
    await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(later)}`, { enabled: false })

    // 界面把「已选但被阻断」的 id 原样带回来（例如只是改了默认模型）：不能因此整页保存不了
    const again = await putDsh(app, admin, { modelIds: [keep, later], defaultModelId: keep })
    expect(again.statusCode, again.raw).toBe(200)
    expect(again.body.models.find((row) => row.id === later)).toMatchObject({
      selected: true,
      blockedReason: '已停用',
    })
    expect(again.body.warnings.join('\n')).toContain('已选中的「later-off@ch-later-off」模型已停用')

    // 取消勾选它 → 正常去掉
    const dropped = await putDsh(app, admin, { modelIds: [keep], defaultModelId: keep })
    expect(dropped.statusCode, dropped.raw).toBe(200)
    expect(dropped.body.models.find((row) => row.id === later)?.selected).toBe(false)

    // 去掉之后再新勾上一个仍被停用的 → 照样 VALIDATION_FAILED
    const reAdd = await putDsh(app, admin, { modelIds: [keep, later], defaultModelId: keep })
    expect(reAdd.statusCode).toBe(400)
  })

  it('默认模型必须是选中的（契约 refine）：不在 modelIds 里 → 400', async () => {
    const { app, admin } = await setup()
    const a = await seedModel(app, { name: 'a-model', apis: ['openai-completions'] })
    const b = await seedModel(app, { name: 'b-model', apis: ['openai-completions'] })
    const res = await api(app.app, admin, 'PUT', '/api/admin/relay/dsh', {
      modelIds: [a],
      defaultModelId: b,
    })
    expect(res.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('VALIDATION_FAILED')
  })

  it('取消所有勾选 → 系统预设被删掉（revision 0），模型都不再 selected', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, { name: 'temp', apis: ['openai-completions'] })
    await putDsh(app, admin, { modelIds: [model], defaultModelId: model })
    const cleared = await putDsh(app, admin, { modelIds: [], defaultModelId: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.body).toMatchObject({ revision: 0, defaultModelId: null, pending: false })
    expect(cleared.body.models.every((row) => !row.selected)).toBe(true)
    expect(app.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM model_presets')).toMatchObject({
      n: 0,
    })
    const settings = JSON.parse(
      app.app.deps.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'relay_dsh'")!
        .value_json,
    ) as { presetId: number | null; defaultModelId: number | null }
    expect(settings).toMatchObject({ presetId: null, defaultModelId: null })
  })

  it('默认模型失效（停用 / 没了路由）→ 自动改选剩余里 sort, name 排第一的', async () => {
    const { app, admin } = await setup()
    const first = await seedModel(app, { name: 'aaa', apis: ['openai-completions'] })
    const second = await seedModel(app, { name: 'bbb', apis: ['openai-completions'] })
    await putDsh(app, admin, { modelIds: [first, second], defaultModelId: first })

    // 停用默认模型 → 自动改选 bbb（排序：sort 相同、name 升序）
    const res = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(first)}`, {
      enabled: false,
    })
    expect(res.statusCode, res.body).toBe(200)
    const after = await getDsh(app, admin)
    expect(after.defaultModelId).toBe(second)
    expect(after.warnings.join('\n')).toContain('已选中的「aaa@ch-aaa」模型已停用')
    expect(
      app.app.deps.db.get<{ default_model: string }>(
        "SELECT default_model FROM model_presets WHERE name = 'Hub 中转站'",
      )!.default_model,
    ).toBe('bbb@ch-bbb')
    expect(
      (
        JSON.parse(
          app.app.deps.db.get<{ value_json: string }>(
            "SELECT value_json FROM settings WHERE key = 'relay_dsh'",
          )!.value_json,
        ) as { defaultModelId: number }
      ).defaultModelId,
    ).toBe(second)

    // 两个都不能下发 → 默认模型 null、预设被删、warnings 提示
    await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(second)}`, { enabled: false })
    const empty = await getDsh(app, admin)
    expect(empty.defaultModelId).toBeNull()
    expect(empty.revision).toBe(0)
    expect(empty.warnings.join('\n')).toContain('已选中的模型都不能下发')
  })

  it('路由名被非中转站提供方占用 → PUT CONFLICT，GET 在 warnings 里点名', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, { name: 'conflict', apis: ['openai-completions'] })
    // 先建一个普通的 pi-ai 提供方占住 hub
    const created = await api(app.app, admin, 'POST', '/api/admin/models/providers', {
      routeKey: 'hub',
      displayName: '别的提供方',
      kind: 'pi-ai',
      api: 'openai-completions',
      baseUrl: 'https://other.example/v1',
      models: [{ id: 'm', name: 'M' }],
      keyMode: 'none',
    })
    expect(created.statusCode, created.body).toBe(200)

    const { statusCode, raw } = await putDsh(app, admin, { modelIds: [model], defaultModelId: model })
    expect(statusCode).toBe(409)
    expect(json<{ error: { code: string } }>({ body: raw }).error.code).toBe('CONFLICT')
    expect(raw).toContain('hub')

    const listing = await getDsh(app, admin)
    expect(listing.warnings.join('\n')).toContain('路由名 hub 已被提供方「别的提供方」占用')

    // 删掉占位的提供方 → PUT 成功
    const providerId = json<{ provider: { id: number } }>(created).provider.id
    expect(
      (await api(app.app, admin, 'DELETE', `/api/admin/models/providers/${String(providerId)}`)).statusCode,
    ).toBe(204)
    const retry = await putDsh(app, admin, { modelIds: [model], defaultModelId: model })
    expect(retry.statusCode, retry.raw).toBe(200)
    expect(retry.body.revision).toBe(1)
  })

  it('pending 与 lastRollout 跟着 rollout.models 任务走；改显示名 → 又变 pending', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, { name: 'pending-model', apis: ['openai-completions'] })
    await putDsh(app, admin, { modelIds: [model], defaultModelId: model })
    expect((await getDsh(app, admin)).pending).toBe(true)

    // 造一个「刚下发完」的任务（比配置更新时间晚）
    app.clock.advance(60_000)
    const jobId = app.app.deps.db.run(
      `INSERT INTO jobs (type, title, status, params_json, total, done, failed, created_at, finished_at)
       VALUES ('rollout.models', '下发模型配置', 'succeeded', '{}', 1, 1, 0, ?, ?)`,
      app.app.deps.clock.nowIso(),
      app.app.deps.clock.nowIso(),
    ).lastInsertRowid
    const afterRollout = await getDsh(app, admin)
    expect(afterRollout.pending).toBe(false)
    expect(afterRollout.lastRollout).toEqual({
      jobId,
      status: 'succeeded',
      createdAt: app.app.deps.clock.nowIso(),
    })

    // 改显示名：会改变 managed.patch.yml 的内容 → 预设 revision+1、updatedAt 晚于任务 → pending
    app.clock.advance(60_000)
    const revision = afterRollout.revision
    const renamed = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(model)}`, {
      displayName: '换了名字',
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    const afterRename = await getDsh(app, admin)
    expect(afterRename.pending).toBe(true)
    expect(afterRename.revision).toBe(revision + 1)
    expect(afterRename.models[0]!.displayName).toBe('换了名字')

    // 只改价格不影响渲染 → updatedAt 不变（仍 pending，因为上面那次还没下发）
    const beforePrice = afterRename.updatedAt
    app.clock.advance(60_000)
    await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(model)}`, {
      price: {
        inputMicro: 9_000_000,
        outputMicro: 9_000_000,
        cacheReadMicro: null,
        cacheWriteMicro: null,
        perRequestMicro: 0,
      },
    })
    const afterPrice = await getDsh(app, admin)
    expect(afterPrice.updatedAt).toBe(beforePrice)
    expect(afterPrice.revision).toBe(afterRename.revision)
  })

  it('users.running 统计运行中的受管实例；模型策略 free 的用户不计入', async () => {
    const { app, admin, users } = await setup()
    const model = await seedModel(app, { name: 'count', apis: ['openai-completions'] })
    await putDsh(app, admin, { modelIds: [model], defaultModelId: model })
    const at = app.app.deps.clock.nowIso()
    app.app.deps.db.run(
      `INSERT INTO instances (user_id, container_name, status, updated_at) VALUES (?, ?, 'running', ?)`,
      users[0]!.id,
      `dshhub-${users[0]!.slug}`,
      at,
    )
    app.app.deps.db.run(
      `INSERT INTO instances (user_id, container_name, status, updated_at) VALUES (?, ?, 'stopped', ?)`,
      users[1]!.id,
      `dshhub-${users[1]!.slug}`,
      at,
    )
    expect((await getDsh(app, admin)).users).toEqual({ total: users.length + 1, running: 1 })

    // free 策略的用户不算「会收到下发」的用户
    app.app.deps.db.run("UPDATE users SET model_policy = 'free' WHERE id = ?", users[0]!.id)
    expect((await getDsh(app, admin)).users).toEqual({ total: users.length, running: 0 })
  })

  it('系统预设被外部删掉 → 下一次同步重建并记进 settings.presetId', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, { name: 'rebuild', apis: ['openai-completions'] })
    await putDsh(app, admin, { modelIds: [model], defaultModelId: model })
    app.app.deps.db.run("DELETE FROM model_presets WHERE name = 'Hub 中转站'")

    // 改显示名会触发同步 → 期望状态里有系统预设，但库里没有 → 重建
    const res = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(model)}`, {
      displayName: '外部删除后',
    })
    expect(res.statusCode, res.body).toBe(200)
    const rebuilt = app.app.deps.db.get<{ id: number }>(
      "SELECT id FROM model_presets WHERE name = 'Hub 中转站'",
    )!
    const settings = JSON.parse(
      app.app.deps.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'relay_dsh'")!
        .value_json,
    ) as { presetId: number; defaultModelId: number }
    expect(settings.presetId).toBe(rebuilt.id)
    expect(settings.defaultModelId).toBe(model)
    const listing = await getDsh(app, admin)
    expect(listing.revision).toBeGreaterThan(0)
    expect(listing.models[0]!.displayName).toBe('外部删除后')
  })

  it('把别的预设设为默认 → 系统预设立刻拉回默认（系统托管，不删别的预设）', async () => {
    const { app, admin } = await setup()
    const model = await seedModel(app, { name: 'keep-default', apis: ['openai-completions'] })
    await putDsh(app, admin, { modelIds: [model], defaultModelId: model })
    const hub = app.app.deps.db.get<{ id: number }>("SELECT id FROM model_providers WHERE route_key = 'hub'")!

    const created = await api(app.app, admin, 'POST', '/api/admin/models/presets', {
      name: '别人的默认',
      providerIds: [hub.id],
      defaultProvider: 'hub',
      defaultModel: 'x',
      isDefault: true,
    })
    expect(created.statusCode, created.body).toBe(200)
    const rows = app.app.deps.db.all<{ name: string; is_default: number }>(
      'SELECT name, is_default FROM model_presets ORDER BY id ASC',
    )
    expect(rows.find((row) => row.name === 'Hub 中转站')!.is_default).toBe(1)
    expect(rows.find((row) => row.name === '别人的默认')!.is_default).toBe(0)
    // 别的预设保留（12 §7.0：其它预设取消默认，但不删）
    expect(rows).toHaveLength(2)
  })

  it('权限：普通用户 GET / PUT 都 403', async () => {
    const { app, user } = await setup()
    expect((await api(app.app, user, 'GET', '/api/admin/relay/dsh')).statusCode).toBe(403)
    expect(
      (await api(app.app, user, 'PUT', '/api/admin/relay/dsh', { modelIds: [], defaultModelId: null }))
        .statusCode,
    ).toBe(403)
  })
})

describe('渲染口径（12 §7.0「渲染」）', () => {
  it('managed.patch.yml 只含勾选的模型，默认模型 = hub/<模型> 或 hub-anthropic/<模型>', async () => {
    const { app, admin, users } = await setup()
    const openai = await seedModel(app, { name: 'oa', apis: ['openai-completions'] })
    const anthropic = await seedModel(app, { name: 'an', apis: ['anthropic-messages'] })
    await seedModel(app, { name: 'third', apis: ['openai-completions'] })
    await putDsh(app, admin, { modelIds: [openai, anthropic], defaultModelId: anthropic })

    const rendered = await app.app.deps.services.models.renderManaged(users[0]!.id)
    expect(rendered.content).toContain('provider: hub-anthropic')
    expect(rendered.content).toContain('model: an')
    expect(rendered.content).toContain('id: oa')
    expect(rendered.content).toContain('id: an')
    expect(rendered.content).not.toContain('id: third')
    // 两个系统提供方各出现一次；WP13：所有 hub-relay 提供方共用 apiKeyEnv: HUB_MK_HUB
    expect(rendered.content).toContain('hub:')
    expect(rendered.content).toContain('hub-anthropic:')
    expect(rendered.content).toContain('displayName: DSH Hub')
    expect([...rendered.content.matchAll(/apiKeyEnv: (\S+)/gu)].map((m) => m[1])).toEqual([
      'HUB_MK_HUB',
      'HUB_MK_HUB',
    ])
    // baseURL：OpenAI 协议带 /v1；Anthropic 协议不带（它的 SDK 自己拼 /v1/messages，带了会变成 /v1/v1/messages）。
    // 路由顺序：默认模型（an，anthropic）所在路由第一
    const baseUrls = [...rendered.content.matchAll(/baseURL: (\S+)/gu)].map((m) => m[1])
    expect(baseUrls).toEqual(['http://10.213.0.1:7832', 'http://10.213.0.1:7832/v1'])
    // 渲染过一次 → 概览的「模型待下发」告警消掉
    expect(app.app.deps.services.relay.overview().alerts.some((a) => a.kind === 'models-changed')).toBe(false)
  })

  it('admin-only 可见性的模型对普通用户不渲染，对管理员渲染', async () => {
    const { app, admin, users } = await setup()
    const channel = createChannel(app.app, {
      name: 'ch-vis',
      baseUrl: 'https://upstream.example/v1',
      apis: ['openai-completions'],
      keys: ['k-1'],
    })
    const model = await createRelayModel(app.app, {
      name: 'admin-only',
      displayName: '仅管理员',
      visibility: 'admin',
      price: { inputMicro: 1_000, outputMicro: 2_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up', enabled: true }],
    })
    await putDsh(app, admin, { modelIds: [model.id], defaultModelId: model.id })

    const normal = await app.app.deps.services.models.renderManaged(users[0]!.id)
    expect(normal.content).not.toContain('id: admin-only@')
    const adminRendered = await app.app.deps.services.models.renderManaged(admin.user.id)
    expect(adminRendered.content).toContain('id: admin-only@ch-vis')
    // REST DTO 的 admin 口径同样只列勾选 + 该协议
    const service = app.app.deps.services.relay
    expect(service.providerModels('openai-completions', { admin: true }).map((m) => m.id)).toEqual([
      'admin-only@ch-vis',
    ])
    expect(service.providerModels('anthropic-messages', { admin: true })).toEqual([])
  })
})

describe('用户端 /api/me/relay 的 DSH 标记（15 §3.2）', () => {
  async function getMine(app: TestApp, session: TestSession): Promise<MyRelayResponse> {
    const res = await api(app.app, session, 'GET', '/api/me/relay')
    expect(res.statusCode, res.body).toBe(200)
    return json<MyRelayResponse>(res)
  }

  it('没配置过下发 → 所有模型 inDsh=false、dshDefault=false', async () => {
    const { app, user } = await setup()
    await seedModel(app, { name: 'a', apis: ['openai-completions'] })
    const mine = await getMine(app, user)
    expect(mine.models).toHaveLength(1)
    expect(mine.models[0]).toMatchObject({ name: 'a', inDsh: false, dshDefault: false })
  })

  it('选中且可下发 → inDsh=true；默认模型 dshDefault=true；未选中 → 都是 false', async () => {
    const { app, admin, user } = await setup()
    const a = await seedModel(app, { name: 'a', apis: ['openai-completions'] })
    const b = await seedModel(app, { name: 'b', apis: ['anthropic-messages'] })
    await seedModel(app, { name: 'c', apis: ['openai-responses'] })
    await putDsh(app, admin, { modelIds: [a, b], defaultModelId: b })

    const dsh = await getDsh(app, admin)
    const mine = await getMine(app, user)
    const byName = new Map(mine.models.map((model) => [model.name, model]))
    expect(byName.get('a')).toMatchObject({ inDsh: true, dshDefault: false })
    expect(byName.get('b')).toMatchObject({ inDsh: true, dshDefault: true })
    expect(byName.get('c')).toMatchObject({ inDsh: false, dshDefault: false })

    // 与 GET /api/admin/relay/dsh 的 selected / blockedReason 同一判定，默认模型取自动修正后的值
    for (const model of mine.models) {
      const adminRow = dsh.models.find((row) => row.name === model.name)
      expect(adminRow, model.name).toBeDefined()
      expect(model.inDsh, model.name).toBe(adminRow?.selected === true && adminRow.blockedReason === null)
      expect(model.dshDefault, model.name).toBe(adminRow?.id === dsh.defaultModelId)
    }
  })

  it('选中但渠道全停 → inDsh=false；默认模型失效 → 全部 dshDefault=false', async () => {
    const { app, admin, user } = await setup()
    const channel = createChannel(app.app, {
      name: 'ch-dead',
      baseUrl: 'https://upstream.example/v1',
      apis: ['openai-completions'],
      keys: ['k-1'],
    })
    const a = await createRelayModel(app.app, {
      name: 'a',
      displayName: '显示 a',
      price: { inputMicro: 1_000, outputMicro: 2_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up-a', enabled: true }],
    })
    const b = await createRelayModel(app.app, {
      name: 'b',
      displayName: '显示 b',
      price: { inputMicro: 1_000, outputMicro: 2_000 },
      routes: [{ channelId: channel.id, upstreamModel: 'up-b', enabled: true }],
    })
    await putDsh(app, admin, { modelIds: [a.id, b.id], defaultModelId: b.id })

    // 渠道停用：模型保留选中，但 blockedReason 变成「没有可用渠道」；默认模型自动失效
    app.app.deps.services.relay.updateChannel(channel.id, { enabled: false }, 1, {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    const dsh = await getDsh(app, admin)
    expect(dsh.defaultModelId).toBeNull()
    for (const model of dsh.models.filter((row) => row.selected)) {
      expect(model.blockedReason).toBe('没有可用渠道')
    }

    const mine = await getMine(app, user)
    expect(mine.models.map((model) => model.name).sort()).toEqual(['a', 'b'])
    expect(mine.models.every((model) => model.inDsh === false && model.dshDefault === false)).toBe(true)
  })
})
