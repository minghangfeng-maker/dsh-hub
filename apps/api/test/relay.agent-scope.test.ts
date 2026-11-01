import { afterEach, describe, expect, it } from 'vitest'
import type { AgentModeClientConfig } from '@dsh-hub/shared'
import { AgentModeClientConfigSchema } from '@dsh-hub/shared'
import type { TestApp, TestUser } from './helpers.js'
import { createTestApp, createUser } from './helpers.js'
import {
  ANTHROPIC_NON_STREAM_BODY,
  RESPONSES_NON_STREAM_BODY,
  createChannel,
  createRelayModel,
  grantMicro,
  jsonResponse,
  startFakeUpstream,
  systemKey,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * 18 §3.1 §3.2 §3.3 §3.4：作用域隔离、密钥鉴权、模型解析、`/v1/models`、模式配置接口、
 * 路径分类去查询串（转发保留查询串）、模式倍率计费。
 *
 * 假上游是进程内 http server；不连任何真实 Anthropic / OpenAI。
 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }

let ctx: TestApp | undefined
let claudeUpstream: FakeUpstream | undefined
let codexUpstream: FakeUpstream | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
  await claudeUpstream?.close()
  claudeUpstream = undefined
  await codexUpstream?.close()
  codexUpstream = undefined
})

interface Setup {
  app: TestApp
  admin: TestUser
  alice: TestUser
  bob: TestUser
  claudeModelId: number
  codexModelId: number
  claudeKey: string
  codexKey: string
  dshKey: string
}

/** 建两个模式各一个渠道 + 模型，并给 alice 开通（Claude ×2.0）、bob 不开通 */
async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const app = ctx.app
  const admin = await createUser(app, { username: 'boss', role: 'admin' })
  const alice = await createUser(app, { username: 'alice' })
  const bob = await createUser(app, { username: 'bob' })
  grantMicro(app, alice.id, 100_000_000)
  grantMicro(app, bob.id, 100_000_000)

  claudeUpstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, ANTHROPIC_NON_STREAM_BODY))
  codexUpstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, RESPONSES_NON_STREAM_BODY))

  const claudeChannel = createChannel(app, {
    name: 'claude-up',
    baseUrl: claudeUpstream.url,
    apis: ['anthropic-messages'],
    scope: 'claude-code',
    keys: ['up-claude-key'],
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
    baseUrl: codexUpstream.url,
    apis: ['openai-responses'],
    scope: 'codex',
    keys: ['up-codex-key'],
  })
  const codexModel = await createRelayModel(app, {
    name: 'gpt-test',
    displayName: 'GPT Test',
    scope: 'codex',
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: 'GPT Test', contextWindow: 128_000 },
    routes: [{ channelId: codexChannel.id, upstreamModel: 'gpt-upstream', enabled: true }],
  })

  // dsh 作用域也有一个模型：/v1/models 与模型解析必须只看本作用域
  const dshChannel = createChannel(app, {
    name: 'dsh-up',
    baseUrl: 'https://dsh-upstream.example/v1',
    apis: ['openai-completions'],
    keys: ['dsh-up-key'],
  })
  await createRelayModel(app, {
    name: 'dsh-test',
    displayName: 'DSH Test',
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    routes: [{ channelId: dshChannel.id, upstreamModel: 'dsh-upstream', enabled: true }],
  })

  const agentModes = app.deps.services.agentModes
  await agentModes.update(
    'claude-code',
    {
      enabled: true,
      ratePermille: 2000,
      defaultModelId: claudeModel.id,
      smallModelId: claudeModel.id,
      targets: { userIds: [alice.id] },
    },
    admin.id,
    META,
  )
  await agentModes.update(
    'codex',
    { enabled: true, ratePermille: 1000, targets: { userIds: [alice.id] } },
    admin.id,
    META,
  )

  const claudeKey = app.deps.services.relay.systemKeyPlain(alice.id, 'claude-code')
  const codexKey = app.deps.services.relay.systemKeyPlain(alice.id, 'codex')
  if (!claudeKey || !codexKey) throw new Error('模式密钥签发失败')
  return {
    app: ctx,
    admin,
    alice,
    bob,
    claudeModelId: claudeModel.id,
    codexModelId: codexModel.id,
    claudeKey,
    codexKey,
    dshKey: systemKey(app, alice.id),
  }
}

function usageRows(app: TestApp, userId: number) {
  return app.app.deps.db.all<{
    scope: string
    mode_rate_permille: number | null
    cost: number
    model: string
    status: string
  }>(
    'SELECT scope, mode_rate_permille, cost, model, status FROM relay_usage WHERE user_id = ? ORDER BY id',
    userId,
  )
}

function emptyModelInput(name: string, scope: 'claude-code' | 'codex' | 'dsh', channelId: number) {
  return {
    name,
    scope,
    price: {
      inputMicro: 1,
      outputMicro: 2,
      cacheReadMicro: null,
      cacheWriteMicro: null,
      perRequestMicro: 0,
    },
    info: {},
    compat: null,
    defaultThinking: null,
    routes: [{ channelId, upstreamModel: 'x', priority: null, weight: null, enabled: true }],
    sort: 0,
    enabled: true,
    visibility: 'all' as const,
  }
}

describe('作用域隔离（18 §3.1）', () => {
  it('渠道 / 模型列表按 scope 过滤，缺省 dsh；模式渠道协议写错 → VALIDATION_FAILED fields.apis', async () => {
    const { app } = await setup()
    const relay = app.app.deps.services.relay
    expect(relay.listChannels().map((item) => item.name)).toEqual(['dsh-up'])
    expect(relay.listChannels('claude-code').map((item) => item.name)).toEqual(['claude-up'])
    expect(relay.listChannels('codex').map((item) => item.name)).toEqual(['codex-up'])
    expect(relay.listModels().map((item) => item.name)).toEqual(['dsh-test'])
    expect(relay.listModels('claude-code').map((item) => item.name)).toEqual(['claude-test'])

    expect(() =>
      createChannel(app.app, {
        name: 'bad-claude',
        baseUrl: 'https://bad.example/v1',
        apis: ['openai-responses'],
        scope: 'claude-code',
      }),
    ).toThrow(/anthropic-messages/)
    expect(() =>
      createChannel(app.app, {
        name: 'bad-codex',
        baseUrl: 'https://bad.example/v1',
        apis: ['anthropic-messages'],
        scope: 'codex',
      }),
    ).toThrow(/openai-responses/)
  })

  it('模型路由必须同作用域：跨页面路由 → VALIDATION_FAILED fields.routes', async () => {
    const { app, admin } = await setup()
    const relay = app.app.deps.services.relay
    const codexChannel = relay.listChannels('codex')[0]!
    await expect(
      relay.createModel(emptyModelInput('cross-scope', 'claude-code', codexChannel.id), admin.id, META),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { routes: '渠道和模型不在同一个页面' } },
    })
  })

  it('模型名跨作用域冲突 → VALIDATION_FAILED fields.name（文案带页面名）', async () => {
    const { app, admin } = await setup()
    const relay = app.app.deps.services.relay
    const claudeChannel = relay.listChannels('claude-code')[0]!
    await expect(
      relay.createModel(emptyModelInput('dsh-test', 'claude-code', claudeChannel.id), admin.id, META),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { name: '这个模型名已被「模型」页使用' } },
    })
  })

  it('「模型」页的下发只看 dsh：模式模型不进 managed.patch.yml，也不触发系统预设 bump', async () => {
    const { app, admin } = await setup()
    const relay = app.app.deps.services.relay
    const dsh = await relay.dshResponse()
    expect(dsh.models.map((model) => model.name)).toEqual(['dsh-test'])
    expect(dsh.models[0]!.selected).toBe(false)

    const claudeChannel = relay.listChannels('claude-code')[0]!
    await createRelayModel(app.app, {
      name: 'claude-extra',
      displayName: 'Claude Extra',
      scope: 'claude-code',
      price: { inputMicro: 1, outputMicro: 2 },
      info: { name: 'Claude Extra' },
      routes: [{ channelId: claudeChannel.id, upstreamModel: 'extra', enabled: true }],
    })
    const after = await relay.dshResponse()
    expect(after.revision).toBe(dsh.revision)
    expect(after.models.map((model) => model.name)).toEqual(['dsh-test'])
    void admin
  })
})

describe('鉴权与模型解析（18 §3.2）', () => {
  it('/v1/models 按作用域：claude 密钥只看到本名、看不到 dsh 模型；dsh 密钥看到带 @ 的 dsh 模型', async () => {
    const { app, claudeKey, dshKey } = await setup()
    const claude = await app.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${claudeKey}` },
    })
    expect(claude.statusCode).toBe(200)
    const claudeBody = claude.json<{ data: { id: string; display_name: string }[] }>()
    expect(claudeBody.data.map((item) => item.id)).toEqual(['claude-test'])
    expect(claudeBody.data[0]!.display_name).toBe('Claude Test')

    const dsh = await app.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${dshKey}` },
    })
    const dshBody = dsh.json<{ data: { id: string }[] }>()
    expect(dshBody.data.map((item) => item.id)).toEqual(['dsh-test@dsh-up'])
  })

  it('模式密钥用错接口 → 400；dsh 密钥调模式模型 → 404；模式密钥调 dsh 模型 → 404', async () => {
    const { app, claudeKey, codexKey, dshKey } = await setup()
    const wrongEndpoint = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${claudeKey}` },
      payload: { model: 'claude-test', messages: [] },
    })
    expect(wrongEndpoint.statusCode).toBe(400)
    expect(wrongEndpoint.json<{ error: { code: string; message: string } }>().error.code).toBe(
      'unsupported_endpoint',
    )
    expect(wrongEndpoint.json<{ error: { message: string } }>().error.message).toContain('Claude Code')

    const codexWrong = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${codexKey}` },
      payload: { model: 'gpt-test', messages: [] },
    })
    expect(codexWrong.statusCode).toBe(400)
    expect(codexWrong.json<{ error: { message: string } }>().error.message).toContain('Codex')

    const dshOnModeModel = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${dshKey}` },
      payload: { model: 'claude-test', messages: [] },
    })
    expect(dshOnModeModel.statusCode).toBe(404)
    expect(dshOnModeModel.json<{ type: string; error: { type: string } }>().error.type).toBe(
      'not_found_error',
    )

    const claudeOnDshModel = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': claudeKey },
      payload: { model: 'dsh-test', messages: [] },
    })
    expect(claudeOnDshModel.statusCode).toBe(404)
  })

  it('钉渠道 `<模型>@<slug>` 也只在密钥作用域里认渠道', async () => {
    const { app, claudeKey } = await setup()
    const cross = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${claudeKey}` },
      payload: { model: 'claude-test@codex-up', messages: [] },
    })
    expect(cross.statusCode).toBe(404)
    const own = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${claudeKey}` },
      payload: { model: 'claude-test@claude-up', messages: [] },
    })
    expect(own.statusCode).toBe(200)
  })

  it('未开放 → 403 中文原因；移出 targets / 关闭模式立即生效', async () => {
    const { app, admin, bob } = await setup()
    const agentModes = app.app.deps.services.agentModes
    const relay = app.app.deps.services.relay
    const bobKey = relay.systemKeyPlain(bob.id, 'claude-code')!
    const denied = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${bobKey}` },
      payload: { model: 'claude-test', messages: [] },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json<{ error: { message: string } }>().error.message).toContain('没有对你开放')

    await agentModes.update('claude-code', { targets: { userIds: [bob.id] } }, admin.id, META)
    const allowed = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${bobKey}` },
      payload: { model: 'claude-test', messages: [] },
    })
    expect(allowed.statusCode).toBe(200)

    await agentModes.update('claude-code', { targets: { userIds: [] } }, admin.id, META)
    const afterTargets = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${bobKey}` },
      payload: { model: 'claude-test', messages: [] },
    })
    expect(afterTargets.statusCode).toBe(403)

    await agentModes.update('claude-code', { enabled: false, targets: { all: true } }, admin.id, META)
    const afterDisabled = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${bobKey}` },
      payload: { model: 'claude-test', messages: [] },
    })
    expect(afterDisabled.statusCode).toBe(403)
  })

  it('查询串：/messages?beta=true 正常计费且上游收到 ?beta=true；count_tokens?beta=true 不计费不记用量', async () => {
    const { app, alice, claudeKey } = await setup()
    const before = usageRows(app, alice.id).length

    const main = await app.app.inject({
      method: 'POST',
      url: '/v1/messages?beta=true',
      headers: { authorization: `Bearer ${claudeKey}`, 'anthropic-version': '2023-06-01' },
      payload: { model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(main.statusCode).toBe(200)
    expect(claudeUpstream!.requests.at(-1)!.url).toBe('/messages?beta=true')

    const rows = usageRows(app, alice.id)
    expect(rows).toHaveLength(before + 1)
    // base = 80×1e6 + 10×1e6 + 5×1e6 + 25×2e6 = 1.45e8；×2 模式倍率 → 290 微积分
    expect(rows.at(-1)).toMatchObject({
      scope: 'claude-code',
      mode_rate_permille: 2000,
      cost: 290,
      model: 'claude-test',
      status: 'ok',
    })

    const countRequest = await app.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens?beta=true',
      headers: { authorization: `Bearer ${claudeKey}` },
      payload: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(countRequest.statusCode).toBe(200)
    expect(claudeUpstream!.requests.at(-1)!.url).toBe('/messages/count_tokens?beta=true')
    // count_tokens 不记用量
    expect(usageRows(app, alice.id)).toHaveLength(before + 1)
  })

  it('Codex：/v1/responses 带查询串、scope 与倍率写对', async () => {
    const { app, alice, codexKey } = await setup()
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/responses?trace=1',
      headers: { authorization: `Bearer ${codexKey}` },
      payload: { model: 'gpt-test', input: 'hi', stream: false },
    })
    expect(res.statusCode).toBe(200)
    expect(codexUpstream!.requests.at(-1)!.url).toBe('/responses?trace=1')
    // base = 56×1e6 + 4×1e6（缓存）+ 20×2e6 = 1.0e8 → 100 微积分
    expect(usageRows(app, alice.id).at(-1)).toMatchObject({
      scope: 'codex',
      mode_rate_permille: 1000,
      cost: 100,
    })
  })
})

describe('GET /v1/hub/agent-mode（18 §3.4）', () => {
  it('claude 密钥拿到 AgentModeClientConfigSchema；dsh 密钥 404；未开放 403', async () => {
    const { app, claudeKey, dshKey, bob } = await setup()
    const res = await app.app.inject({
      method: 'GET',
      url: '/v1/hub/agent-mode',
      headers: { authorization: `Bearer ${claudeKey}` },
    })
    expect(res.statusCode).toBe(200)
    const config = AgentModeClientConfigSchema.parse(res.json<AgentModeClientConfig>())
    expect(config.mode).toBe('claude-code')
    expect(config.defaultModel).toBe('claude-test')
    expect(config.smallModel).toBe('claude-test')
    expect(config.models.map((model) => model.id)).toEqual(['claude-test'])
    expect(config.models[0]).toMatchObject({ contextWindow: 200_000, maxTokens: 64_000 })

    const dsh = await app.app.inject({
      method: 'GET',
      url: '/v1/hub/agent-mode',
      headers: { authorization: `Bearer ${dshKey}` },
    })
    expect(dsh.statusCode).toBe(404)

    const bobKey = app.app.deps.services.relay.systemKeyPlain(bob.id, 'codex')!
    const denied = await app.app.inject({
      method: 'GET',
      url: '/v1/hub/agent-mode',
      headers: { authorization: `Bearer ${bobKey}` },
    })
    expect(denied.statusCode).toBe(403)
  })
})

describe('计费落库（18 §3.3）', () => {
  it('relay_usage / relay_usage_daily 的 scope、模式倍率快照与对账不变量', async () => {
    const { app, alice, claudeKey } = await setup()
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${claudeKey}` },
      payload: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)

    const db = app.app.deps.db
    expect(
      db.get<{ scope: string; cost: number }>(
        'SELECT scope, SUM(cost) AS cost FROM relay_usage_daily WHERE user_id = ? GROUP BY scope',
        alice.id,
      ),
    ).toEqual({ scope: 'claude-code', cost: 290 })

    const wallet = db.get<{ balance: number }>(
      'SELECT balance FROM relay_wallets WHERE user_id = ?',
      alice.id,
    )!
    const ledger = db.get<{ total: number }>(
      'SELECT SUM(amount) AS total FROM relay_ledger WHERE user_id = ?',
      alice.id,
    )!
    const usage = db.get<{ total: number }>(
      'SELECT SUM(cost) AS total FROM relay_usage WHERE user_id = ?',
      alice.id,
    )!
    expect(wallet.balance).toBe(Number(ledger.total) - Number(usage.total))
  })
})
