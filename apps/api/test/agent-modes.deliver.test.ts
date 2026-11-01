import { afterEach, describe, expect, it } from 'vitest'
import type { AgentModeStateResponse } from '@dsh-hub/shared'
import { AgentModeStateResponseSchema } from '@dsh-hub/shared'
import type { TestApp, TestSession, TestUser } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import {
  createChannel,
  createRelayModel,
  grantMicro,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'
import { seedPlugin, startInstance, waitFor, writeProfile } from './helpers-wp3.js'

/**
 * 18 §4.2 下发任务的完整链路（FakeDriver，不碰 Docker）：
 * 开通 → 运行中的实例 env 未生效（pending）→ 下发（重建）→ 容器 env 带上 HUB_CLAUDE_* → 待下发消失；
 * 移出 targets → 再下发 → 容器 env 去掉；装插件的路径复用 `rollout.plugin` 的执行函数。
 */

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
  alice: TestUser
  claudeModelId: number
}

async function setup(opts: { withPlugin?: boolean; profile?: boolean } = {}): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  const app = ctx.app
  const adminUser = await createUser(app, { username: 'boss', role: 'admin' })
  const alice = await createUser(app, { username: 'alice' })
  grantMicro(app, alice.id, 100_000_000)
  const admin = loginAs(app, adminUser)
  app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7932/v1')

  upstream = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const channel = createChannel(app, {
    name: 'claude-up',
    baseUrl: upstream.url,
    apis: ['anthropic-messages'],
    scope: 'claude-code',
    keys: ['up-key'],
  })
  const model = await createRelayModel(app, {
    name: 'claude-test',
    displayName: 'Claude Test',
    scope: 'claude-code',
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: 'Claude Test', contextWindow: 200_000, maxTokens: 64_000 },
    routes: [{ channelId: channel.id, upstreamModel: 'claude-upstream', enabled: true }],
  })
  if (opts.withPlugin === true) {
    seedPlugin(app, { packageName: '@local/dsh-claude-pilot', version: '0.4.0', policy: 'optional' })
  }
  if (opts.profile === true) {
    writeProfile(app, alice.slug, { dependencies: {} })
  }
  return { app: ctx, admin, alice, claudeModelId: model.id }
}

function api(
  app: TestApp,
  session: TestSession,
  method: 'GET' | 'POST' | 'PUT',
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

async function openMode(setupResult: Setup, targets: { userIds: number[] } | { all: true }): Promise<void> {
  const { app, admin, claudeModelId } = setupResult
  const put = await api(app, admin, 'PUT', '/api/admin/agent-modes/claude-code', {
    enabled: true,
    ratePermille: 1000,
    defaultModelId: claudeModelId,
    targets,
  })
  expect(put.statusCode, put.body).toBe(200)
}

async function deliver(
  setupResult: Setup,
  input: { restart?: 'now' | 'next-start'; installPlugin?: boolean } = {},
): Promise<number> {
  const { app, admin } = setupResult
  const reauth = await api(app, admin, 'POST', '/api/auth/reauth', {
    password: admin.user.password,
  })
  expect(reauth.statusCode).toBe(204)
  const res = await api(app, admin, 'POST', '/api/admin/agent-modes/claude-code/deliver', {
    restart: input.restart ?? 'now',
    installPlugin: input.installPlugin ?? false,
  })
  expect(res.statusCode, res.body).toBe(202)
  const jobId = json<{ jobId: number }>(res).jobId
  await waitFor(async () => {
    const detail = await app.app.deps.services.jobs.get(jobId)
    return detail.job.status === 'succeeded' || detail.job.status === 'partial'
  })
  return jobId
}

function containerSpec(app: TestApp, slug: string) {
  const driver = app.driver
  if (!driver) throw new Error('测试没有 FakeDriver')
  return driver.getContainer(`${app.config.containerPrefix}${slug}`)
}

describe('下发 env（18 §4.2）', () => {
  it('运行中实例 env 未生效 → 下发重建 → 容器 env 带上 HUB_CLAUDE_* → 待下发消失', async () => {
    const setupResult = await setup()
    const { app, admin, alice } = setupResult
    const instances = app.app.deps.services.instances
    await startInstance(app.app, alice.id)
    expect(instances.currentStatus(alice.id)).toBe('running')

    await openMode(setupResult, { userIds: [alice.id] })
    const before = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(before.pending).toBe(true)
    expect(before.pendingUsers).toBe(1)
    expect(before.users).toHaveLength(1)
    expect(before.users[0]).toMatchObject({
      userId: alice.id,
      targeted: true,
      instanceStatus: 'running',
      envApplied: false,
    })

    await deliver(setupResult)
    const spec = containerSpec(app, alice.slug)
    expect(spec).toBeDefined()
    expect(spec!.spec.env.HUB_CLAUDE_AUTH).toBe('apiKey')
    expect(spec!.spec.env.HUB_CLAUDE_KEY).toMatch(/^sk-dsh-/)
    expect(spec!.spec.env.HUB_CLAUDE_BASE_URL).toBe('http://10.213.0.1:7932')

    const after = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(after.pending).toBe(false)
    expect(after.users[0]!.envApplied).toBe(true)

    // 再下发一次：没有变化，不重建（envApplied 仍 true、pending false）
    await deliver(setupResult)
    expect(containerSpec(app, alice.slug)!.spec.env.HUB_CLAUDE_KEY).toMatch(/^sk-dsh-/)
  })

  it('移出 targets → 该用户在用户表里标为已移出且 env 未生效 → 下发后容器 env 去掉', async () => {
    const setupResult = await setup()
    const { app, admin, alice } = setupResult
    await startInstance(app.app, alice.id)
    await openMode(setupResult, { userIds: [alice.id] })
    await deliver(setupResult)
    expect(containerSpec(app, alice.slug)!.spec.env.HUB_CLAUDE_KEY).toMatch(/^sk-dsh-/)

    await openMode(setupResult, { userIds: [] })
    const state = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(state.users).toHaveLength(1)
    expect(state.users[0]).toMatchObject({ userId: alice.id, targeted: false, envApplied: false })
    expect(state.pending).toBe(true)

    await deliver(setupResult)
    expect(containerSpec(app, alice.slug)!.spec.env.HUB_CLAUDE_KEY).toBeUndefined()
    const after = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(after.pending).toBe(false)
    // 不再列为「被移出但 env 里还有」的用户
    expect(after.users).toEqual([])
  })

  it('next-start：形状变化只记日志、不重建；实例没跑时也不动', async () => {
    const setupResult = await setup()
    const { app, admin, alice } = setupResult
    await startInstance(app.app, alice.id)
    await openMode(setupResult, { userIds: [alice.id] })
    await deliver(setupResult, { restart: 'next-start' })
    // 容器还是旧的规格（没有模式 env），但任务成功、状态保持「待下发」
    expect(containerSpec(app, alice.slug)!.spec.env.HUB_CLAUDE_KEY).toBeUndefined()
    const state = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(state.pending).toBe(true)

    const jobId = await deliver(setupResult, { restart: 'next-start' })
    const tasks = (await app.app.deps.services.jobs.get(jobId)).tasks
    const log = await app.app.deps.services.jobs.taskLog(jobId, tasks[0]!.id)
    expect(log).toContain('next-start')
    void admin
  })

  it('installPlugin：targets 里没装插件 → 自动装插件库里的最新版本（复用 rollout.plugin 执行函数）', async () => {
    const setupResult = await setup({ withPlugin: true, profile: true })
    const { app, admin, alice } = setupResult
    await openMode(setupResult, { userIds: [alice.id] })
    const jobId = await deliver(setupResult, { installPlugin: true })

    const tasks = (await app.app.deps.services.jobs.get(jobId)).tasks
    const log = await app.app.deps.services.jobs.taskLog(jobId, tasks[0]!.id)
    expect(log).toContain('安装 @local/dsh-claude-pilot@0.4.0')

    const rows = await app.app.deps.services.plugins.listUserPluginRows(alice.id)
    const installed = rows.find((row) => row.packageName === '@local/dsh-claude-pilot')
    expect(installed?.actualVersion).toBe('0.4.0')

    const state = AgentModeStateResponseSchema.parse(
      json<AgentModeStateResponse>(await api(app, admin, 'GET', '/api/admin/agent-modes/claude-code')),
    )
    expect(state.plugin?.installedUsers).toBe(1)
    expect(state.users[0]!.pluginVersion).toBe('0.4.0')
    expect(state.pending).toBe(false)
  })

  it('插件库里没有插件：跳过安装但 env 照常应用（任务成功）', async () => {
    const setupResult = await setup()
    const { app } = setupResult
    await openMode(setupResult, { userIds: [setupResult.alice.id] })
    const jobId = await deliver(setupResult, { installPlugin: true })
    const detail = await app.app.deps.services.jobs.get(jobId)
    expect(detail.job.status).toBe('succeeded')
    const log = await app.app.deps.services.jobs.taskLog(jobId, detail.tasks[0]!.id)
    expect(log).toContain('插件库里还没有 @local/dsh-claude-pilot')
  })

  it('实例没在跑：只记「下次启动生效」，容器不被创建', async () => {
    const setupResult = await setup()
    const { app, alice } = setupResult
    await openMode(setupResult, { userIds: [alice.id] })
    const jobId = await deliver(setupResult)
    const detail = await app.app.deps.services.jobs.get(jobId)
    const log = await app.app.deps.services.jobs.taskLog(jobId, detail.tasks[0]!.id)
    expect(log).toContain('实例没在运行')
    expect(app.driver!.getContainer(`${app.config.containerPrefix}${alice.slug}`)).toBeUndefined()
  })
})
