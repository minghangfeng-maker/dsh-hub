import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { RelayDshResponse } from '@dsh-hub/shared'
import type { TestApp, TestSession, TestUser } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import { createChannel, createRelayModel } from './helpers-relay.js'
import { waitFor } from './helpers-wp3.js'

/**
 * 下发链路集成测试（12 §7.0「下发」，WP12a 交付物 6）：PUT 选模型 → `POST /api/admin/rollouts`
 * （`kind:'models'`、不带 `presetId`、`targets:{all:true}`）→ 任务成功 → 用户的 `managed.patch.yml`
 * 只有勾选的模型、默认模型正确 → GET 的 `pending = false`；再改一个模型的显示名 → `pending = true`。
 *
 * 容器用 FakeDriver（不碰 Docker，也不碰生产实例）。
 */

let ctx: TestApp | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

interface Setup {
  app: TestApp
  admin: TestSession
  users: TestUser[]
}

async function setup(): Promise<Setup> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '7832' } })
  const adminUser = await createUser(ctx.app, { username: 'boss', role: 'admin' })
  const alice = await createUser(ctx.app, { username: 'alice' })
  const bob = await createUser(ctx.app, { username: 'bob' })
  const admin = loginAs(ctx.app, adminUser)
  ctx.app.deps.services.relay.setInternalBaseUrl('http://10.213.0.1:7832/v1')
  return { app: ctx, admin, users: [alice, bob] }
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

async function seed(app: TestApp, name: string, apis: ('openai-completions' | 'anthropic-messages')[]) {
  const channel = createChannel(app.app, {
    name: `ch-${name}`,
    baseUrl: 'https://upstream.example/v1',
    apis,
    keys: ['k-1'],
  })
  return await createRelayModel(app.app, {
    name,
    displayName: `显示 ${name}`,
    price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
    info: { name: `显示 ${name}`, contextWindow: 128_000 },
    routes: [{ channelId: channel.id, upstreamModel: `up-${name}`, enabled: true }],
  })
}

function managedPatch(app: TestApp, user: TestUser): string {
  return readFileSync(join(app.dataDir, 'users', user.slug, 'managed', 'managed.patch.yml'), 'utf8')
}

describe('下发到 DSH 的完整链路（12 §7.0）', () => {
  it('PUT → models 下发任务成功 → patch 内容正确、pending=false；改显示名 → pending=true', async () => {
    const { app, admin, users } = await setup()
    const openai = await seed(app, 'send-oa', ['openai-completions'])
    const anthropic = await seed(app, 'send-an', ['anthropic-messages'])
    await seed(app, 'not-selected', ['openai-completions'])

    const put = await api(app.app, admin, 'PUT', '/api/admin/relay/dsh', {
      modelIds: [openai.id, anthropic.id],
      defaultModelId: openai.id,
    })
    expect(put.statusCode, put.body).toBe(200)
    const saved = json<RelayDshResponse>(put)
    expect(saved).toMatchObject({ pending: true, revision: 1, defaultModelId: openai.id })

    // 下发需要二次验证（04 §4.8）：直接给会话打标记，不依赖 /api/auth/reauth
    app.app.deps.db.run(
      'UPDATE sessions SET reauth_at = ? WHERE id = ?',
      new Date(Date.now() - 1000).toISOString(),
      admin.sessionId,
    )
    app.clock.advance(1000)
    const created = await api(app.app, admin, 'POST', '/api/admin/rollouts', {
      kind: 'models',
      targets: { all: true },
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 0.2, restart: 'next-start' },
    })
    expect(created.statusCode, created.body).toBe(202)
    const jobId = json<{ jobId: number }>(created).jobId

    const status = await waitFor(
      async () => {
        const { job } = await app.app.deps.services.jobs.get(jobId)
        return job.status === 'succeeded' ? job.status : ''
      },
      { label: 'models 下发任务' },
    )
    expect(status).toBe('succeeded')
    const finished = await app.app.deps.services.jobs.get(jobId)
    expect(finished.tasks.every((task) => task.status === 'succeeded')).toBe(true)

    // 每个受管用户的 managed.patch.yml：只有这 2 个模型、默认模型 = hub/send-oa
    for (const user of users) {
      const content = managedPatch(app, user)
      expect(content).toContain('id: send-oa')
      expect(content).toContain('id: send-an')
      expect(content).not.toContain('id: not-selected')
      expect(content).toContain('provider: hub\n    model: send-oa')
      // 一个模型只挂一个协议：send-an 只在 hub-anthropic 下
      const anthropicBlock = content.slice(content.indexOf('hub-anthropic:'))
      expect(anthropicBlock).toContain('id: send-an')
      const hubBlock = content.slice(content.indexOf('hub:'), content.indexOf('hub-anthropic:'))
      expect(hubBlock).not.toContain('id: send-an')
      expect(hubBlock).toContain('id: send-oa')
    }

    const afterRollout = json<RelayDshResponse>(
      await api(app.app, admin, 'GET', '/api/admin/relay/dsh'),
    )
    expect(afterRollout.pending).toBe(false)
    expect(afterRollout.lastRollout).toMatchObject({ jobId, status: 'succeeded' })

    // 改一个模型的显示名（渲染内容变了、预设行没变）→ revision+1、pending=true
    app.clock.advance(60_000)
    const renamed = await api(app.app, admin, 'PATCH', `/api/admin/relay/models/${String(openai.id)}`, {
      displayName: '新显示名',
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    const afterRename = json<RelayDshResponse>(
      await api(app.app, admin, 'GET', '/api/admin/relay/dsh'),
    )
    expect(afterRename.pending).toBe(true)
    expect(afterRename.revision).toBe(afterRollout.revision + 1)
    expect(afterRename.updatedAt! > afterRollout.lastRollout!.createdAt).toBe(true)
  })
})
