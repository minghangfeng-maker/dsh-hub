import type {
  AgentModeStateResponse,
  JobDetailResponse,
  MyRelayResponse,
  RelayChannelListResponse,
  RelayModelListResponse,
  RelayUsageLogResponse,
  RelayUsageStatsResponse,
} from '@dsh-hub/shared'
import {
  AgentModeStateResponseSchema,
  MyRelayResponseSchema,
  RelayChannelListResponseSchema,
  RelayModelListResponseSchema,
  RelayUsageLogResponseSchema,
  RelayUsageStatsResponseSchema,
} from '@dsh-hub/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'

/**
 * 18 的假接口（`?mock=agent-modes` / 用户端场景）：
 * 模式状态、PUT 校验与待下发、两种 targets 写法、下发任务、作用域隔离（渠道 / 模型只在自己的页面），
 * 用户端的 `agentModes`、按来源的用量与筛选。
 */

const restores: (() => void)[] = []

function useMock(scenario: MockScenario): void {
  resetRelayMock()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
})

async function json<T>(
  schema: { parse: (value: unknown) => T },
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init)
  expect(response.status, `${init?.method ?? 'GET'} ${path}`).toBeLessThan(400)
  return schema.parse(await response.json())
}

function put(mode: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`/api/admin/agent-modes/${mode}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('模式状态（GET /api/admin/agent-modes/:mode）', () => {
  it('Claude Code：开通 ×1.5、3 个模型（未定价 / 没路由）、插件、用户表、待下发与一条 warning', async () => {
    useMock('agent-modes')
    const state = await json<AgentModeStateResponse>(
      AgentModeStateResponseSchema,
      '/api/admin/agent-modes/claude-code',
    )

    expect(state.mode).toBe('claude-code')
    expect(state.settings.enabled).toBe(true)
    expect(state.settings.ratePermille).toBe(1500)
    expect(state.settings.targets).toEqual({ userIds: [2, 4, 5] })
    expect(state.effectiveDefaultModel).toBe('claude-sonnet-5-5')
    expect(state.effectiveSmallModel).toBe('claude-haiku-5-5')

    expect(state.models.map((model) => [model.name, model.routable])).toEqual([
      ['claude-sonnet-5-5', true],
      ['claude-haiku-5-5', true],
      ['claude-opus-5-5', false],
    ])
    expect(state.models.find((model) => model.name === 'claude-haiku-5-5')?.routable).toBe(true)

    expect(state.plugin?.packageName).toBe('@local/dsh-claude-pilot')
    expect(state.plugin?.latestVersion).toBe('0.4.0')

    // 3 个在 targets 里 + 1 个已移出（运行中的容器 env 里还有）
    expect(state.users.map((user) => [user.username, user.targeted])).toEqual([
      ['mint', true],
      ['sakura', true],
      ['butter', true],
      ['quiet-leaf', false],
    ])
    expect(state.users.find((user) => user.username === 'sakura')?.pluginVersion).toBeNull()
    expect(state.users.find((user) => user.username === 'butter')?.envApplied).toBe(false)

    expect(state.pending).toBe(true)
    expect(state.pendingUsers).toBeGreaterThan(0)
    expect(state.lastDeliver?.status).toBe('succeeded')
    expect(state.warnings).toHaveLength(1)
    expect(state.warnings[0]).toContain('内部监听器')
  })

  it('Codex：未开通、插件库里没有、0 渠道 0 模型', async () => {
    useMock('agent-modes')
    const state = await json<AgentModeStateResponse>(
      AgentModeStateResponseSchema,
      '/api/admin/agent-modes/codex',
    )

    expect(state.settings.enabled).toBe(false)
    expect(state.settings.smallModelId).toBeNull()
    expect(state.plugin).toBeNull()
    expect(state.models).toEqual([])
    expect(state.users).toEqual([])
    expect(state.pending).toBe(false)
    expect(state.effectiveDefaultModel).toBeNull()
    expect(state.warnings.join('；')).toContain('还没有任何模型')

    const channels = await json<RelayChannelListResponse>(
      RelayChannelListResponseSchema,
      '/api/admin/relay/channels?scope=codex',
    )
    const models = await json<RelayModelListResponse>(
      RelayModelListResponseSchema,
      '/api/admin/relay/models?scope=codex',
    )
    expect(channels).toEqual([])
    expect(models).toEqual([])
  })
})

describe('修改设置（PUT）', () => {
  it('倍率 / 默认模型 / 显示名即时生效，不产生「待下发」', async () => {
    useMock('agent-modes')
    const response = await put('codex', {
      enabled: false,
      ratePermille: 800,
      label: '我的 Codex',
    })
    expect(response.status).toBe(200)
    const state = AgentModeStateResponseSchema.parse(await response.json())
    expect(state.settings.ratePermille).toBe(800)
    expect(state.settings.label).toBe('我的 Codex')
    expect(state.pending).toBe(false)
  })

  it('两种 targets 写法：所有用户 / 指定用户（含移出的人留在表里）', async () => {
    useMock('agent-modes')
    const all = AgentModeStateResponseSchema.parse(
      await (await put('claude-code', { targets: { all: true } })).json(),
    )
    expect(all.settings.targets).toEqual({ all: true })
    expect(all.pending).toBe(true)
    expect(all.users.every((user) => user.targeted)).toBe(true)
    expect(all.users.length).toBeGreaterThan(3)

    const specific = AgentModeStateResponseSchema.parse(
      await (await put('claude-code', { targets: { userIds: [2] } })).json(),
    )
    expect(specific.settings.targets).toEqual({ userIds: [2] })
    const removed = specific.users.filter((user) => !user.targeted)
    expect(removed.length).toBeGreaterThan(0)
    expect(removed.every((user) => user.envApplied === false)).toBe(true)
  })

  it('校验：默认模型必须属于这个作用域、Codex 没有小模型、用户必须存在', async () => {
    useMock('agent-modes')
    const wrongModel = await put('claude-code', { defaultModelId: 999 })
    expect(wrongModel.status).toBe(400)
    expect(((await wrongModel.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')

    const codexSmall = await put('codex', { smallModelId: 51 })
    expect(codexSmall.status).toBe(400)

    const unknownUser = await put('claude-code', { targets: { userIds: [987654] } })
    expect(unknownUser.status).toBe(400)
    expect(
      ((await unknownUser.json()) as { error: { details: { fields?: Record<string, string> } } }).error
        .details.fields,
    ).toHaveProperty('targets')
  })
})

describe('下发（POST …/deliver）', () => {
  it('创建 rollout.agent-mode 任务，返回 jobId，之后不再 pending', async () => {
    useMock('agent-modes')
    const response = await fetch('/api/admin/agent-modes/claude-code/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restart: 'now', installPlugin: true }),
    })
    expect(response.status).toBe(202)
    const { jobId } = (await response.json()) as { jobId: number }
    expect(jobId).toBeGreaterThanOrEqual(1043)

    const job = await json<JobDetailResponse>(
      { parse: (value) => value as JobDetailResponse },
      `/api/admin/jobs/${jobId}`,
    )
    expect(job.job.type).toBe('rollout.agent-mode')
    expect(job.job.total).toBe(4)

    const state = await json<AgentModeStateResponse>(
      AgentModeStateResponseSchema,
      '/api/admin/agent-modes/claude-code',
    )
    expect(state.pending).toBe(false)
    expect(state.pendingUsers).toBe(0)
    expect(state.lastDeliver?.jobId).toBe(jobId)
    // 下发后「已移出」的用户从表里消失
    expect(state.users.every((user) => user.targeted)).toBe(true)
  })
})

describe('作用域隔离（渠道 / 模型）', () => {
  it('列表按 scope 过滤；DSH 的列表看不到两个模式的渠道与模型', async () => {
    useMock('agent-modes')
    const claudeChannels = await json<RelayChannelListResponse>(
      RelayChannelListResponseSchema,
      '/api/admin/relay/channels?scope=claude-code',
    )
    expect(claudeChannels.map((channel) => channel.slug)).toEqual(['anthropic', 'claude-pool'])
    expect(claudeChannels.every((channel) => channel.scope === 'claude-code')).toBe(true)

    const dshChannels = await json<RelayChannelListResponse>(
      RelayChannelListResponseSchema,
      '/api/admin/relay/channels',
    )
    expect(dshChannels.map((channel) => channel.slug)).toEqual(['upstream-c', 'upstream-b', 'official'])

    const claudeModels = await json<RelayModelListResponse>(
      RelayModelListResponseSchema,
      '/api/admin/relay/models?scope=claude-code',
    )
    expect(claudeModels.map((model) => model.name)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-5-5',
    ])
    const dshModels = await json<RelayModelListResponse>(
      RelayModelListResponseSchema,
      '/api/admin/relay/models',
    )
    expect(dshModels.every((model) => model.scope === undefined || model.scope === 'dsh')).toBe(true)
  })

  it('新建渠道带 scope 与固定的协议；协议不对 → VALIDATION_FAILED', async () => {
    useMock('agent-modes')
    const created = await fetch('/api/admin/relay/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Claude 备用',
        baseUrl: 'https://claude-backup.example.com/v1',
        apis: ['anthropic-messages'],
        keys: ['sk-ant-demo'],
        scope: 'claude-code',
      }),
    })
    expect(created.status).toBe(201)
    const { channel } = (await created.json()) as { channel: { id: number; scope?: string; apis: string[] } }
    expect(channel.scope).toBe('claude-code')
    expect(channel.apis).toEqual(['anthropic-messages'])

    const wrong = await fetch('/api/admin/relay/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Claude 错协议',
        baseUrl: 'https://claude-backup.example.com/v1',
        apis: ['openai-completions'],
        keys: ['sk-ant-demo'],
        scope: 'claude-code',
      }),
    })
    expect(wrong.status).toBe(400)
  })
})

describe('用户端（18 §7）', () => {
  it('开通的两个模式：整体倍率、默认模型、可用模型带渠道倍率范围', async () => {
    useMock('running')
    const data = await json<MyRelayResponse>(MyRelayResponseSchema, '/api/me/relay')

    expect(data.agentModes?.map((mode) => [mode.mode, mode.ratePermille])).toEqual([
      ['claude-code', 1500],
      ['codex', 1000],
    ])
    const claude = data.agentModes?.find((mode) => mode.mode === 'claude-code')
    expect(claude?.defaultModel).toBe('claude-sonnet-5-5')
    const sonnet = claude?.models.find((model) => model.name === 'claude-sonnet-5-5')
    // 两条渠道 ×1 与 ×1.2 → 用户看到区间
    expect(sonnet?.channelRate).toEqual({ minPermille: 1000, maxPermille: 1200 })
    expect(sonnet?.routes).toBeUndefined()
    // 没路由的模型不给用户
    expect(claude?.models.some((model) => model.name === 'claude-opus-5-5')).toBe(false)

    const codex = data.agentModes?.find((mode) => mode.mode === 'codex')
    expect(codex?.models.find((model) => model.name === 'gpt-5.1-codex')?.channelRate).toEqual({
      minPermille: 800,
      maxPermille: 1000,
    })
  })

  it('用量统计带 byScope（全部来源的合计与分来源一致）；逐条记录可按 scope 筛', async () => {
    useMock('running')
    const stats = await json<RelayUsageStatsResponse>(RelayUsageStatsResponseSchema, '/api/me/relay/usage')
    expect(stats.byScope?.map((bucket) => bucket.scope).sort()).toEqual(['claude-code', 'codex', 'dsh'])
    const sumRequests = (stats.byScope ?? []).reduce((sum, bucket) => sum + bucket.requests, 0)
    expect(sumRequests).toBe(stats.total.requests)

    const all = await json<RelayUsageLogResponse>(RelayUsageLogResponseSchema, '/api/me/relay/logs')
    expect(new Set(all.items.map((row) => row.scope))).toEqual(new Set(['dsh']))

    const claude = await json<RelayUsageLogResponse>(
      RelayUsageLogResponseSchema,
      '/api/me/relay/logs?scope=claude-code',
    )
    expect(claude.items.length).toBeGreaterThan(0)
    expect(claude.items.every((row) => row.scope === 'claude-code')).toBe(true)
    expect(claude.items.every((row) => row.modeRatePermille === 1500)).toBe(true)
    expect(claude.items.every((row) => row.channelId === null)).toBe(true)
  })
})
