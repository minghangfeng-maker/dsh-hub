import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type {
  AgentModeStateResponse,
  MyRelayResponse,
  RelayChannel,
  RelayModel,
  RelayUsageLogResponse,
  RelayUsageStatsResponse,
} from '@dsh-hub/shared'
import {
  AgentModeStateResponseSchema,
  MyRelayResponseSchema,
  RelayUsageLogResponseSchema,
  RelayUsageStatsResponseSchema,
} from '@dsh-hub/shared'
import type { TestApp, TestSession, TestUser } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import {
  ANTHROPIC_NON_STREAM_BODY,
  createChannel,
  createRelayModel,
  grantMicro,
  jsonResponse,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'
import { seedPlugin, waitFor } from './helpers-wp3.js'

/**
 * 18 §4.3 管理端接口 + §7 用户端 + §4.1 env：走真实 HTTP 路由（cookie + CSRF），
 * 容器与插件用 FakeDriver / 直接造库，不碰 Docker 与真实上游。
 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

let ctx: TestApp | undefined
let upstream: FakeUpstream | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  await upstream?.close()
  upstream = undefined
})

interface Setup {
  app: TestApp
  admin: TestSession
  user: TestSession
  adminUser: TestUser
  alice: TestUser
  bob: TestUser
  claudeModel: RelayModel
  claudeChannel: RelayChannel
  codexModel: RelayModel
}

async function setup(opts: { seedPluginRow?: boolean } = {}): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const app = ctx.app
  const adminUser = await createUser(app, { username: 'boss', role: 'admin' })
  const alice = await createUser(app, { username: 'alice' })
  const bob = await createUser(app, { username: 'bob' })
  grantMicro(app, alice.id, 100_000_000)
  grantMicro(app, bob.id, 100_000_000)
  const admin = loginAs(app, adminUser)
  const user = loginAs(app, alice)
  app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7932/v1')

  upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, ANTHROPIC_NON_STREAM_BODY))
  const claudeChannel = createChannel(app, {
    name: 'claude-up',
    baseUrl: upstream.url,
    apis: ['anthropic-messages'],
    scope: 'claude-code',
    keys: ['up-key'],
  })
  const claudeModel = await createRelayModel(app, {
    name: 'claude-test',
    displayName: 'Claude Test',
    scope: 'claude-code',
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: 'Claude Test', contextWindow: 200_000, maxTokens: 64_000 },
    routes: [{ channelId: claudeChannel.id, upstreamModel: 'claude-upstream', enabled: true }],
  })
  const codexChannel = createChannel(app, {
    name: 'codex-up',
    baseUrl: upstream.url,
    apis: ['openai-responses'],
    scope: 'codex',
    keys: ['up-key-2'],
  })
  const codexModel = await createRelayModel(app, {
    name: 'gpt-test',
    displayName: 'GPT Test',
    scope: 'codex',
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: 'GPT Test', contextWindow: 128_000 },
    routes: [{ channelId: codexChannel.id, upstreamModel: 'gpt-upstream', enabled: true }],
  })
  if (opts.seedPluginRow !== false) {
    seedPlugin(app, { packageName: '@local/dsh-claude-pilot', version: '0.4.0', policy: 'optional' })
    seedPlugin(app, { packageName: '@local/dsh-codex-pilot', version: '0.2.0', policy: 'optional' })
  }
  return { app: ctx, admin, user, adminUser, alice, bob, claudeModel, claudeChannel, codexModel }
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

describe('GET/PUT /api/admin/agent-modes/:mode（18 §4.3）', () => {
  it('默认状态：未开通、倍率 1000、插件信息、可选模型、warnings；未知模式 404', async () => {
    const { app, admin } = await setup()
    const res = await api(app.app, admin, 'GET', '/api/admin/agent-modes/claude-code')
    expect(res.statusCode).toBe(200)
    const state = AgentModeStateResponseSchema.parse(json<AgentModeStateResponse>(res))
    expect(state.mode).toBe('claude-code')
    expect(state.settings.enabled).toBe(false)
    expect(state.settings.ratePermille).toBe(1000)
    expect(state.settings.targets).toEqual({ userIds: [] })
    expect(state.plugin).toMatchObject({
      packageName: '@local/dsh-claude-pilot',
      latestVersion: '0.4.0',
      policy: 'optional',
      installedUsers: 0,
    })
    expect(state.models).toEqual([
      {
        id: state.models[0]!.id,
        name: 'claude-test',
        displayName: 'Claude Test',
        enabled: true,
        routable: true,
      },
    ])
    expect(state.effectiveDefaultModel).toBe('claude-test')
    expect(state.effectiveSmallModel).toBe('claude-test')
    expect(state.users).toEqual([])
    expect(state.pending).toBe(false)
    expect(state.lastDeliver).toBeNull()
    expect(state.warnings).toEqual([])

    const missing = await api(app.app, admin, 'GET', '/api/admin/agent-modes/nope')
    expect(missing.statusCode).toBe(404)
  })

  it('插件库里没有插件 → plugin=null + warning', async () => {
    const { app, admin } = await setup({ seedPluginRow: false })
    const res = await api(app.app, admin, 'GET', '/api/admin/agent-modes/codex')
    const state = AgentModeStateResponseSchema.parse(json<AgentModeStateResponse>(res))
    expect(state.plugin).toBeNull()
    expect(state.warnings.some((line) => line.includes('插件库里还没有 @local/dsh-codex-pilot'))).toBe(true)
  })

  it('PUT：开放给指定用户、倍率 ×2、默认/小模型；pending 与 targetsUpdatedAt；审计', async () => {
    const { app, admin, adminUser, alice, bob, claudeModel } = await setup()
    const res = await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      enabled: true,
      ratePermille: 2000,
      defaultModelId: claudeModel.id,
      smallModelId: claudeModel.id,
      label: '公司账号',
      targets: { userIds: [alice.id] },
    })
    expect(res.statusCode, res.body).toBe(200)
    const state = AgentModeStateResponseSchema.parse(json<AgentModeStateResponse>(res))
    expect(state.settings).toMatchObject({
      enabled: true,
      ratePermille: 2000,
      label: '公司账号',
      targets: { userIds: [alice.id] },
    })
    expect(state.settings.targetsUpdatedAt).not.toBeNull()
    expect(state.pending).toBe(true)
    expect(state.pendingUsers).toBe(1)
    expect(state.users.map((row) => [row.userId, row.targeted])).toEqual([[alice.id, true]])

    const audit = app.app.deps.db.get<{ action: string; detail_json: string }>(
      "SELECT action, detail_json FROM audit_logs WHERE action = 'agent-mode.update' ORDER BY id DESC LIMIT 1",
    )!
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      mode: 'claude-code',
      fields: ['enabled', 'ratePermille', 'label', 'defaultModelId', 'smallModelId', 'targets'],
      targets: { added: [alice.id], removed: [] },
      ratePermille: { from: 1000, to: 2000 },
    })

    // all 也能用；放开后再改回指定用户
    const all = await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      targets: { all: true },
    })
    expect(all.statusCode).toBe(200)
    const allState = AgentModeStateResponseSchema.parse(json<AgentModeStateResponse>(all))
    // `{ all: true }` = 所有未删除用户（管理员账号本身也是用户）
    expect(allState.users.map((row) => row.userId).sort((a, b) => a - b)).toEqual(
      [adminUser.id, alice.id, bob.id].sort((a, b) => a - b),
    )
  })

  it('PUT 校验：模型不在本作用域 / Codex 设小模型 / 用户不存在 / 倍率越界', async () => {
    const { app, admin, codexModel, claudeModel } = await setup()
    const wrongModel = await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      defaultModelId: codexModel.id,
    })
    expect(wrongModel.statusCode).toBe(400)
    expect(
      json<{ error: { code: string; details: { fields: Record<string, string> } } }>(wrongModel).error.details
        .fields.defaultModelId,
    ).toContain('不在 Claude Code 的作用域里')

    const codexSmall = await api(app.app, admin, 'PUT', '/api/admin/agent-modes/codex', {
      smallModelId: codexModel.id,
    })
    expect(codexSmall.statusCode).toBe(400)
    expect(
      json<{ error: { details: { fields: Record<string, string> } } }>(codexSmall).error.details.fields
        .smallModelId,
    ).toContain('Codex 没有小模型设置')

    const ghost = await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      targets: { userIds: [999_999] },
    })
    expect(ghost.statusCode).toBe(400)
    expect(
      json<{ error: { details: { fields: Record<string, string> } } }>(ghost).error.details.fields.targets,
    ).toContain('不存在')

    const rate = await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      ratePermille: 100_001,
    })
    expect(rate.statusCode).toBe(400)
    void claudeModel
  })

  it('PUT 无实际变化时不改 updatedAt、不写审计', async () => {
    const { app, admin } = await setup()
    const first = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(
        await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', { ratePermille: 1200 }),
      ),
    )
    const beforeAudit = Number(
      app.app.deps.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'agent-mode.update'",
      )!.n,
    )
    const second = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(
        await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', { ratePermille: 1200 }),
      ),
    )
    expect(second.settings.updatedAt).toBe(first.settings.updatedAt)
    expect(
      Number(
        app.app.deps.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'agent-mode.update'",
        )!.n,
      ),
    ).toBe(beforeAudit)
  })
})

describe('POST /api/admin/agent-modes/:mode/deliver（18 §4.2）', () => {
  async function openAndDeliver(setupResult: Setup, restart: 'now' | 'next-start' = 'now') {
    const { app, admin, alice, claudeModel } = setupResult
    const put = await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      enabled: true,
      ratePermille: 2000,
      defaultModelId: claudeModel.id,
      targets: { userIds: [alice.id] },
    })
    expect(put.statusCode, put.body).toBe(200)
    const reauth = await api(app.app, admin, 'POST', '/api/auth/reauth', {
      password: admin.user.password,
    })
    expect(reauth.statusCode).toBe(204)
    const deliver = await api(app.app, admin, 'POST', '/api/admin/agent-modes/claude-code/deliver', {
      restart,
      installPlugin: false,
    })
    expect(deliver.statusCode, deliver.body).toBe(202)
    return json<{ jobId: number }>(deliver).jobId
  }

  it('需要二次密码：未 reauth → 403 REAUTH_REQUIRED', async () => {
    const setupResult = await setup()
    const { app, admin, alice, claudeModel } = setupResult
    await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      enabled: true,
      defaultModelId: claudeModel.id,
      targets: { userIds: [alice.id] },
    })
    const res = await api(app.app, admin, 'POST', '/api/admin/agent-modes/claude-code/deliver', {})
    expect(res.statusCode).toBe(403)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('REAUTH_REQUIRED')
  })

  it('下发成功 → pending=false、lastDeliver 指向任务；审计 agent-mode.deliver', async () => {
    const setupResult = await setup()
    const { app, admin } = setupResult
    const jobId = await openAndDeliver(setupResult)
    await waitFor(async () => {
      const detail = await app.app.deps.services.jobs.get(jobId)
      return detail.job.status === 'succeeded' || detail.job.status === 'partial'
    })
    const res = await api(app.app, admin, 'GET', '/api/admin/agent-modes/claude-code')
    const state = AgentModeStateResponseSchema.parse(json<AgentModeStateResponse>(res))
    expect(state.pending).toBe(false)
    expect(state.pendingUsers).toBe(0)
    expect(state.lastDeliver).toMatchObject({ jobId, status: 'succeeded' })
    const taskLog = await app.app.deps.services.jobs.taskLog(
      jobId,
      (await app.app.deps.services.jobs.get(jobId)).tasks[0]!.id,
    )
    expect(taskLog).toContain('实例没在运行')

    const audit = app.app.deps.db.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'agent-mode.deliver' ORDER BY id DESC LIMIT 1",
    )!
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      mode: 'claude-code',
      jobId,
      users: 1,
      restart: 'now',
      installPlugin: false,
    })
  })

  it('没有可下发的用户 → 409 CONFLICT', async () => {
    const setupResult = await setup()
    const { app, admin } = setupResult
    const reauth = await api(app.app, admin, 'POST', '/api/auth/reauth', {
      password: admin.user.password,
    })
    expect(reauth.statusCode).toBe(204)
    const res = await api(app.app, admin, 'POST', '/api/admin/agent-modes/codex/deliver', {})
    expect(res.statusCode).toBe(409)
    expect(json<{ error: { message: string } }>(res).error.message).toContain('没有需要下发的用户')
  })
})

describe('容器 env（18 §4.1）与用户端（18 §7）', () => {
  it('开通后 containerEnv 叠加 Claude/Codex env；模式密钥每人每作用域一把', async () => {
    const { app, admin, alice, claudeModel, codexModel } = await setup()
    await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      enabled: true,
      targets: { userIds: [alice.id] },
      defaultModelId: claudeModel.id,
    })
    await api(app.app, admin, 'PUT', '/api/admin/agent-modes/codex', {
      enabled: true,
      targets: { all: true },
      defaultModelId: codexModel.id,
    })

    const env = await app.app.deps.services.models.containerEnv(alice.id)
    expect(env.HUB_CLAUDE_AUTH).toBe('apiKey')
    expect(env.HUB_CLAUDE_KEY).toMatch(/^sk-dsh-/)
    expect(env.HUB_CLAUDE_BASE_URL).toBe('http://10.213.0.1:7932')
    expect(env.HUB_CODEX_KEY).toMatch(/^sk-dsh-/)
    expect(env.HUB_CODEX_BASE_URL).toBe('http://10.213.0.1:7932/v1')
    expect(env.HUB_CODEX_WIRE_API).toBe('responses')
    expect(env.HUB_CLAUDE_KEY).not.toBe(env.HUB_CODEX_KEY)

    // 每人每作用域一把 system 密钥（user 自建密钥仍是 dsh）
    const keys = app.app.deps.db.all<{ scope: string; kind: string }>(
      'SELECT scope, kind FROM relay_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY scope',
      alice.id,
    )
    expect(keys).toEqual([
      { scope: 'claude-code', kind: 'system' },
      { scope: 'codex', kind: 'system' },
    ])

    // 内部监听器关闭 → 不注入
    app.app.deps.services.relay.setInternalBaseUrl(null)
    const closed = await app.app.deps.services.models.containerEnv(alice.id)
    expect(closed.HUB_CLAUDE_KEY).toBeUndefined()
    expect(closed.HUB_CODEX_KEY).toBeUndefined()
  })

  it('/api/me/relay 只给对我开通的模式、模型价格与倍率；密钥列表不显示模式密钥', async () => {
    const { app, admin, user, alice, claudeModel } = await setup()
    // 先签发一把模式密钥（模拟已下发过），再开通
    const relay = app.app.deps.services.relay
    relay.systemKeyPlain(alice.id, 'claude-code')
    await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      enabled: true,
      ratePermille: 2000,
      targets: { userIds: [alice.id] },
      defaultModelId: claudeModel.id,
    })

    const me = await api(app.app, user, 'GET', '/api/me/relay')
    expect(me.statusCode).toBe(200)
    const body = MyRelayResponseSchema.parse(json<MyRelayResponse>(me))
    expect(body.agentModes).toHaveLength(1)
    const mode = body.agentModes![0]!
    expect(mode).toMatchObject({
      mode: 'claude-code',
      label: 'DSH Hub',
      ratePermille: 2000,
      defaultModel: 'claude-test',
    })
    expect(mode.models.map((model) => model.name)).toEqual(['claude-test'])
    expect(mode.models[0]!.price.inputMicro).toBe(1_000_000)
    expect(mode.models[0]!.channelRate).toEqual({ minPermille: 1000, maxPermille: 1000 })

    const keys = await api(app.app, user, 'GET', '/api/me/relay/keys')
    expect(keys.statusCode).toBe(200)
    const listed = json<{ id: number; scope?: string; kind: string }[]>(keys)
    expect(listed.every((key) => key.scope === 'dsh' && key.kind !== 'system')).toBe(true)
  })

  it('用量记录与统计按来源筛选、byScope 分桶', async () => {
    const { app, admin, user, alice, claudeModel } = await setup()
    await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      enabled: true,
      ratePermille: 2000,
      targets: { userIds: [alice.id] },
      defaultModelId: claudeModel.id,
    })
    const key = app.app.deps.services.relay.systemKeyPlain(alice.id, 'claude-code')!
    const call = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(call.statusCode).toBe(200)

    const logs = await api(app.app, admin, 'GET', '/api/admin/relay/logs?scope=claude-code')
    const logBody = RelayUsageLogResponseSchema.parse(json<RelayUsageLogResponse>(logs))
    expect(logBody.items).toHaveLength(1)
    expect(logBody.items[0]).toMatchObject({
      scope: 'claude-code',
      modeRatePermille: 2000,
      model: 'claude-test',
      costMicro: 290,
    })

    // 同一天再记一条 dsh 来源的用量：按用户汇总也必须按来源筛（合并验收时发现漏筛）
    const today = RelayUsageStatsResponseSchema.parse(
      json<RelayUsageStatsResponse>(await api(app.app, admin, 'GET', '/api/admin/relay/usage')),
    ).to
    app.app.deps.db.run(
      `INSERT INTO relay_usage_daily (day, user_id, scope, model, channel_id, requests, cost)
       VALUES (?, ?, 'dsh', 'dsh-only-model', 0, 3, 5000)`,
      today,
      alice.id,
    )
    const stats = await api(app.app, admin, 'GET', '/api/admin/relay/usage?scope=claude-code')
    const statsBody = RelayUsageStatsResponseSchema.parse(json<RelayUsageStatsResponse>(stats))
    expect(statsBody.total.costMicro).toBe(290)
    expect(statsBody.byUser).toEqual([
      expect.objectContaining({ userId: alice.id, costMicro: 290, requests: 1 }),
    ])
    expect(statsBody.byScope).toEqual([
      expect.objectContaining({ scope: 'claude-code', costMicro: 290, requests: 1 }),
    ])

    const mine = await api(app.app, user, 'GET', '/api/me/relay/logs?scope=claude-code')
    expect(mine.statusCode).toBe(200)
    const mineBody = RelayUsageLogResponseSchema.parse(json<RelayUsageLogResponse>(mine))
    expect(mineBody.items).toHaveLength(1)
    expect(mineBody.items[0]!.scope).toBe('claude-code')
  })

  it('模式状态：内部监听器没开 → warnings；本月花费按月汇总到用户行', async () => {
    const { app, admin, alice, claudeModel } = await setup()
    app.app.deps.services.relay.setInternalBaseUrl(null)
    const closed = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app.app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(closed.warnings).toContain('中转站内部监听器没开，用户容器连不上中转站')

    app.app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7932/v1')
    await api(app.app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
      enabled: true,
      ratePermille: 2000,
      targets: { userIds: [alice.id] },
      defaultModelId: claudeModel.id,
    })
    const key = app.app.deps.services.relay.systemKeyPlain(alice.id, 'claude-code')!
    await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    })
    const state = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app.app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(state.users[0]!.monthCostMicro).toBe(290)
  })

  it('渠道/模型接口的 ?scope=（缺省 dsh，模式页只看自己）', async () => {
    const { app, admin } = await setup()
    const dshChannels = await api(app.app, admin, 'GET', '/api/admin/relay/channels')
    expect(json<RelayChannel[]>(dshChannels)).toHaveLength(0)
    const claudeChannels = await api(app.app, admin, 'GET', '/api/admin/relay/channels?scope=claude-code')
    expect(json<RelayChannel[]>(claudeChannels).map((item) => item.name)).toEqual(['claude-up'])
    const codexModels = await api(app.app, admin, 'GET', '/api/admin/relay/models?scope=codex')
    expect(json<RelayModel[]>(codexModels).map((item) => item.name)).toEqual(['gpt-test'])
    const bad = await api(app.app, admin, 'GET', '/api/admin/relay/models?scope=nope')
    expect(bad.statusCode).toBe(400)
  })

  it('概览只看 dsh 的渠道/模型计数，但没定价告警三个作用域都算（文案带页面名）', async () => {
    const { app, admin } = await setup()
    const codexChannel = app.app.deps.services.relay.listChannels('codex')[0]!
    await createRelayModel(app.app, {
      name: 'codex-unpriced',
      displayName: 'Codex Unpriced',
      scope: 'codex',
      price: { inputMicro: 0, outputMicro: 0 },
      info: { name: 'Codex Unpriced' },
      routes: [{ channelId: codexChannel.id, upstreamModel: 'x', enabled: true }],
    })

    const overview = await api(app.app, admin, 'GET', '/api/admin/relay/overview')
    expect(overview.statusCode, overview.body).toBe(200)
    const body = json<{
      channels: { total: number }
      models: { total: number }
      alerts: { kind: string; message: string }[]
    }>(overview)
    expect(body.channels.total).toBe(0)
    expect(body.models.total).toBe(0)
    const alert = body.alerts.find(
      (item) => item.kind === 'models-unpriced' && item.message.includes('Codex'),
    )
    expect(alert?.message).toContain('Codex：1 个模型还没定价')
  })
})

void META
