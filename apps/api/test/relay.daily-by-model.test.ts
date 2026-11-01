import type { RelayUsageStatsResponse } from '@dsh-hub/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { dailyBucketsByDayModel } from '../src/modules/relay/repo.js'
import type { TestApp, TestSession } from './helpers.js'
import { createTestApp, createUser, json, loginAs } from './helpers.js'
import { grantMicro } from './helpers-relay.js'

/**
 * 19 §3：`GET /api/me/relay/usage` 与 `GET /api/admin/relay/usage` 的加法字段 `dailyByModel`。
 *
 * 只验契约里写明的三件事：用户隔离（只看自己）、`scope` 筛选、只给有用量的格子；
 * 外加 repo 层的分组与排序（`day ASC, cost DESC`）。
 */


function api(testApp: TestApp, session: TestSession, method: 'GET', url: string) {
  return testApp.app.inject({ method, url, headers: session.headers })
}

let ctx: TestApp | undefined

afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

async function setup(): Promise<TestApp> {
  ctx = await createTestApp({ env: { HUB_RELAY_INTERNAL_PORT: '0' } })
  return ctx
}

interface SeedRow {
  day: string
  userId: number
  model: string
  requests: number
  cost: number
  scope?: 'dsh' | 'claude-code' | 'codex'
  channelId?: number
}

function seedDaily(app: TestApp, rows: SeedRow[]): void {
  for (const row of rows) {
    app.app.deps.db.run(
      `INSERT INTO relay_usage_daily
         (day, user_id, model, channel_id, requests, errors, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, scope)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, 0, ?, ?)`,
      row.day,
      row.userId,
      row.model,
      row.channelId ?? 0,
      row.requests,
      row.requests * 10,
      row.requests * 20,
      row.cost,
      row.scope ?? 'dsh',
    )
  }
}

describe('repo.dailyBucketsByDayModel（19 §3）', () => {
  it('按 day + model 分组，按 day 升序、同日按 cost 降序', async () => {
    const app = await setup()
    const alice = await createUser(app.app, { username: 'alice' })
    const bob = await createUser(app.app, { username: 'bob' })
    seedDaily(app, [
      { day: '2026-10-02', userId: alice.id, model: 'cheap', requests: 2, cost: 10 },
      { day: '2026-10-02', userId: alice.id, model: 'pricey', requests: 1, cost: 90 },
      { day: '2026-10-01', userId: alice.id, model: 'pricey', requests: 3, cost: 30 },
      // 同一天同一模型两条（不同渠道）→ 合成一行
      { day: '2026-10-01', userId: alice.id, model: 'pricey', requests: 4, cost: 70, channelId: 9 },
      { day: '2026-10-01', userId: bob.id, model: 'other-user', requests: 1, cost: 999 },
    ])

    const rows = dailyBucketsByDayModel(app.app.deps.db, {
      userId: alice.id,
      from: '2026-10-01',
      to: '2026-10-02',
    })
    expect(rows.map((row) => [row.day, row.model, row.requests, row.cost])).toEqual([
      ['2026-10-01', 'pricey', 7, 100],
      ['2026-10-02', 'pricey', 1, 90],
      ['2026-10-02', 'cheap', 2, 10],
    ])
  })
})

describe('GET /api/me/relay/usage 的 dailyByModel（19 §3）', () => {
  it('用户端只含自己的格子，且只给有用量的格子', async () => {
    const app = await setup()
    const alice = await createUser(app.app, { username: 'alice' })
    const bob = await createUser(app.app, { username: 'bob' })
    grantMicro(app.app, alice.id, 100_000_000)
    seedDaily(app, [
      { day: '2026-10-01', userId: alice.id, model: 'm-a', requests: 1, cost: 100 },
      { day: '2026-10-01', userId: alice.id, model: 'm-b', requests: 2, cost: 50 },
      { day: '2026-10-02', userId: alice.id, model: 'm-a', requests: 3, cost: 300 },
      { day: '2026-10-02', userId: bob.id, model: 'm-bob', requests: 9, cost: 900 },
    ])

    const session = loginAs(app.app, alice)
    const stats = json<RelayUsageStatsResponse>(
      await api(app, session, 'GET', '/api/me/relay/usage?from=2026-10-01&to=2026-10-03'),
    )
    expect(stats.dailyByModel).toEqual([
      { day: '2026-10-01', model: 'm-a', requests: 1, errors: 0, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 100 },
      { day: '2026-10-01', model: 'm-b', requests: 2, errors: 0, inputTokens: 20, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 50 },
      { day: '2026-10-02', model: 'm-a', requests: 3, errors: 0, inputTokens: 30, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 300 },
    ])
    // 10-03 没有任何用量 → 不给格子（前端自己补 0）
    expect(stats.dailyByModel?.some((row) => row.day === '2026-10-03')).toBe(false)
    expect(stats.dailyByModel?.some((row) => row.model === 'm-bob')).toBe(false)
  })

  it('scope 筛选生效（用户端与管理端都算）', async () => {
    const app = await setup()
    const admin = await createUser(app.app, { username: 'boss', role: 'admin' })
    const alice = await createUser(app.app, { username: 'alice' })
    grantMicro(app.app, alice.id, 100_000_000)
    seedDaily(app, [
      { day: '2026-10-01', userId: alice.id, model: 'dsh-model', requests: 1, cost: 100 },
      { day: '2026-10-01', userId: alice.id, model: 'claude-model', requests: 2, cost: 200, scope: 'claude-code' },
      { day: '2026-10-02', userId: alice.id, model: 'codex-model', requests: 3, cost: 300, scope: 'codex' },
    ])

    const userSession = loginAs(app.app, alice)
    const claude = json<RelayUsageStatsResponse>(
      await api(app, userSession, 'GET', '/api/me/relay/usage?from=2026-10-01&to=2026-10-02&scope=claude-code'),
    )
    expect(claude.dailyByModel?.map((row) => row.model)).toEqual(['claude-model'])

    const all = json<RelayUsageStatsResponse>(
      await api(app, userSession, 'GET', '/api/me/relay/usage?from=2026-10-01&to=2026-10-02'),
    )
    expect(all.dailyByModel?.map((row) => row.model).sort()).toEqual([
      'claude-model',
      'codex-model',
      'dsh-model',
    ])

    // 管理端带 userId 时同样只看该用户，且 scope 照样生效
    const adminSession = loginAs(app.app, admin)
    const adminStats = json<RelayUsageStatsResponse>(
      await api(
        app,
        adminSession,
        'GET',
        `/api/admin/relay/usage?from=2026-10-01&to=2026-10-02&userId=${String(alice.id)}&scope=codex`,
      ),
    )
    expect(adminStats.dailyByModel?.map((row) => [row.day, row.model])).toEqual([
      ['2026-10-02', 'codex-model'],
    ])
  })
})
