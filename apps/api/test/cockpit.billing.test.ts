import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RelayUsageStatsResponse } from '@dsh-hub/shared'
import { createUser, type TestUser } from './helpers.js'
import { adminInject, createCockpitHarness, jsonOf, type CockpitHarness } from './helpers-cockpit.js'
import {
  jsonResponse,
  OPENAI_NON_STREAM_BODY,
  setupChannelAndModel,
  startFakeUpstream,
  systemKey,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * WP56e1 的两条「座舱自己」的接线：
 *
 * 1. **计费**（任务书第 9 项）：座舱的系统账号 `hub-ops`（`is_system=1`）钱包恒为 0，
 *    但它的模型请求不该被 402 挡掉；也不扣任何人的积分，用量按来源 `cockpit` 记账，
 *    管理端用量接口能按来源筛出来。
 *    > 修复前：`checkWallet` 只看余额（`balance <= 0` → 402），座舱的每一个请求都会被拒；
 *    > 本文件第一条用例就是这个场景的回归测试。
 * 2. **模型接线**（任务书第 10 项）：`settings.cockpit.model` 要真的写进座舱容器的模型配置
 *    （`managed.patch.yml` 的 `agent-default-model`），改设置后**下次启动生效**。
 */

let h: CockpitHarness
let alice: TestUser
let upstream: FakeUpstream | undefined

beforeEach(async () => {
  h = await createCockpitHarness()
  alice = await createUser(h.app, { username: 'alice', displayName: '爱丽丝' })
})

afterEach(async () => {
  await h.close()
  await upstream?.close()
  upstream = undefined
})

const db = () => h.app.deps.db
const now = (): string => h.ctx.clock.nowIso()

/** 管理端 GET（`adminInject` 会把前缀锁死在 /api/admin/cockpit，这里要打别的前缀） */
async function adminGet<T>(url: string): Promise<T> {
  const res = await h.app.inject({ method: 'GET', url, headers: h.admin.headers })
  expect(res.statusCode, res.body).toBe(200)
  return jsonOf<T>(res)
}

function walletRow(userId: number): { balance: number; total_spent: number } | undefined {
  return db().get<{ balance: number; total_spent: number }>(
    'SELECT balance, total_spent FROM relay_wallets WHERE user_id = ?',
    userId,
  )
}

function usageRows(userId: number) {
  return db().all<{ source: string; cost: number; input_tokens: number; output_tokens: number }>(
    'SELECT source, cost, input_tokens, output_tokens FROM relay_usage WHERE user_id = ? ORDER BY id',
    userId,
  )
}

/** 用某个用户的密钥打一次 `/v1/chat/completions`（假上游，非流式） */
async function chatOnce(key: string): Promise<{ statusCode: number; body: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}` },
    payload: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
  })
  return { statusCode: res.statusCode, body: res.body }
}

describe('座舱计费：hub-ops 不因余额为 0 被拒，也不扣任何人的积分（任务书第 9 项）', () => {
  it('钱包为 0 时请求照样成功（修复前 402），用量记 source=cockpit 且成本为 0', async () => {
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(h.app, { upstreamUrl: upstream.url })

    // 座舱的系统账号：钱包一行都没有（余额按 0 算），这正是修复前必 402 的状态
    expect(walletRow(h.hubOps.id)).toBeUndefined()
    const key = systemKey(h.app, h.hubOps.id)

    const result = await chatOnce(key)
    expect(result.statusCode, result.body).toBe(200)

    const rows = usageRows(h.hubOps.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'cockpit', cost: 0 })
    // token 用量照常记账（只是不收钱）
    expect(rows[0]?.input_tokens).toBe(100)
    expect(rows[0]?.output_tokens).toBe(40)

    // 钱包没被扣（余额仍是 0，累计消费 0）
    expect(walletRow(h.hubOps.id)).toMatchObject({ balance: 0, total_spent: 0 })
    // 日汇总里也有这一条（cost 0）
    const daily = db().get<{ requests: number; cost: number }>(
      'SELECT requests, cost FROM relay_usage_daily WHERE user_id = ?',
      h.hubOps.id,
    )
    expect(daily).toMatchObject({ requests: 1, cost: 0 })
  })

  it('对照：普通用户余额为 0 仍然 402（没有把所有人都放开）', async () => {
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(h.app, { upstreamUrl: upstream.url })
    const key = h.app.deps.services.relay.createKey(alice.id, { name: '无余额' }, alice.id, {
      ip: null,
      userAgent: 'vitest',
    }).secret

    const result = await chatOnce(key)
    expect(result.statusCode).toBe(402)
    expect(result.body).toContain('insufficient_points')
    expect(usageRows(alice.id)).toHaveLength(0)
  })

  it('管理端用量接口可按来源筛（source=cockpit / source=local）', async () => {
    upstream = await startFakeUpstream((_req, res) => jsonResponse(res, 200, OPENAI_NON_STREAM_BODY))
    await setupChannelAndModel(h.app, { upstreamUrl: upstream.url })
    // 一个有钱的普通用户（source=local），一个座舱系统账号（source=cockpit）
    h.app.deps.services.relay.adjustWallet(alice.id, { amountMicro: 100_000_000, note: '测试' }, 1, {
      ip: null,
      userAgent: 'vitest',
    })
    const aliceKey = h.app.deps.services.relay.createKey(alice.id, { name: 'alice' }, alice.id, {
      ip: null,
      userAgent: 'vitest',
    }).secret
    expect((await chatOnce(aliceKey)).statusCode).toBe(200)
    expect((await chatOnce(systemKey(h.app, h.hubOps.id))).statusCode).toBe(200)

    const cockpit = await adminGet<RelayUsageStatsResponse>('/api/admin/relay/usage?source=cockpit')
    expect(cockpit.total.requests).toBe(1)
    expect(cockpit.byUser.map((row) => row.username)).toEqual(['hub-ops'])
    expect(cockpit.total.costMicro).toBe(0)

    const local = await adminGet<RelayUsageStatsResponse>('/api/admin/relay/usage?source=local')
    expect(local.total.requests).toBe(1)
    expect(local.byUser.map((row) => row.username)).toEqual(['alice'])

    // 逐条用量记录也能筛
    const logs = await adminGet<{ items: { source: string; username: string }[]; total: number }>(
      '/api/admin/relay/logs?source=cockpit',
    )
    expect(logs.total).toBe(1)
    expect(logs.items[0]).toMatchObject({ source: 'cockpit', username: 'hub-ops' })
  })
})

describe('座舱模型接线：settings.cockpit.model 进 managed.patch.yml（任务书第 10 项）', () => {
  /** 一个 pi-ai 提供方（两个模型）+ 默认预设（默认模型 = m-default） */
  function seedPreset(): void {
    const at = now()
    const providerId = db().run(
      `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                    extra_json, key_mode, api_key_enc, enabled, created_at, updated_at)
       VALUES ('fixture', '夹具提供方', 'pi-ai', 'openai-completions', 'https://upstream.test/v1', ?,
               NULL, NULL, 'none', NULL, 1, ?, ?)`,
      JSON.stringify([
        { id: 'm-default', name: '默认模型', contextWindow: 128000, maxTokens: 8192 },
        { id: 'm-cockpit', name: '座舱模型', contextWindow: 128000, maxTokens: 8192 },
      ]),
      at,
      at,
    ).lastInsertRowid
    db().run(
      `INSERT INTO model_presets (platform, name, description, provider_ids_json, default_provider, default_model,
                                  is_default, revision, created_at, updated_at)
       VALUES ('cloud', '夹具预设', '', ?, 'fixture', 'm-default', 1, 1, ?, ?)`,
      JSON.stringify([Number(providerId)]),
      at,
      at,
    )
  }

  /** 用户 slug（harness 里的 hub-ops 是直接写库造的，slug 不一定是 'ops'） */
  function slugOf(userId: number): string {
    const row = db().get<{ slug: string }>('SELECT slug FROM users WHERE id = ?', userId)
    if (!row) throw new Error(`用户 ${String(userId)} 不存在`)
    return row.slug
  }

  function managedPatch(userId: number): string {
    return readFileSync(`${h.app.deps.paths.userManaged(slugOf(userId))}/managed.patch.yml`, 'utf8')
  }

  it('改设置后重渲染：座舱容器下次启动用新模型，普通用户不受影响', async () => {
    // 假探针自己会报一个 model；清掉它才能看到「设置里的模型」透传到状态里
    h.probe.model = null
    seedPreset()
    await h.app.deps.services.models.renderManaged(h.hubOps.id)
    expect(managedPatch(h.hubOps.id)).toMatch(/model:\s*m-default/u)

    // 改座舱模型（只改 model 不需要 reauth：只有 autoExecuteR1 才要）
    const res = await adminInject(h, 'PUT', '/settings', { model: 'm-cockpit' })
    expect(res.statusCode).toBe(200)
    const body = jsonOf<{ status: { model: string } }>(res)
    expect(body.status.model).toBe('m-cockpit')

    // 设置一改就重渲染了：下次启动/重启座舱容器即生效
    expect(managedPatch(h.hubOps.id)).toMatch(/model:\s*m-cockpit/u)
    const audit = db().all<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'cockpit.settings' ORDER BY id DESC LIMIT 1",
    )
    expect(JSON.parse(audit[0]?.detail_json ?? '{}')).toMatchObject({
      model: 'm-cockpit',
      modelRender: 'ok',
      appliesAt: 'next-start',
    })

    // 普通用户的容器配置仍是预设默认模型（座舱覆盖只对系统账号生效）
    await h.app.deps.services.models.renderManaged(alice.id)
    expect(managedPatch(alice.id)).toMatch(/model:\s*m-default/u)
  })

  it('填了提供方里没有的模型：保持预设默认并给警告（座舱不会因此完全不可用）', async () => {
    seedPreset()
    // 直接写 settings（等价于 PUT /settings { model: 'nope' }）
    h.app.deps.settings.set('cockpit', { model: '不存在的模型', autoExecuteR1: true })
    const result = await h.app.deps.services.models.renderManaged(h.hubOps.id)
    expect(managedPatch(h.hubOps.id)).toMatch(/model:\s*m-default/u)
    expect(result.warnings.join(' ')).toContain('不在任何启用的提供方里')
  })

  it('没有模型预设时照旧渲染（不炸）', async () => {
    const result = await h.app.deps.services.models.renderManaged(h.hubOps.id)
    expect(result.warnings).toBeDefined()
    expect(managedPatch(h.hubOps.id)).not.toMatch(/model:\s*m-cockpit/u)
  })
})
