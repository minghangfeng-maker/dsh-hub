import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OpsCallResult, ProposalView } from '@dsh-hub/shared'
import { createUser, type TestUser } from './helpers.js'
import {
  adminInject,
  createCockpitHarness,
  jsonOf,
  opsInject,
  reauth,
  waitProposalSettled,
  type CockpitHarness,
} from './helpers-cockpit.js'
import {
  createChannel,
  createRelayModel,
  jsonResponse,
  startFakeUpstream,
  type FakeUpstream,
} from './helpers-relay.js'

/**
 * WP56f 第三批：中转站（渠道/模型/下发/设置/钱包/用量记录）、搜索池。
 *
 * 这类「运维交互」按编排者口径定级：有副作用但可逆 → R1；纯探测 → R0。
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

async function callData<T = Record<string, unknown>>(capability: string, args: unknown = {}): Promise<T> {
  const res = await opsInject(h, 'POST', '/call', { payload: { sessionId: 's1', capability, args } })
  expect(res.statusCode, `${capability}: ${res.body}`).toBe(200)
  const result = jsonOf<OpsCallResult>(res)
  if (result.kind !== 'data') throw new Error(`${capability} 应该是 R0 数据，实际 ${result.kind}`)
  return result.data as T
}

async function callProposal(capability: string, args: unknown): Promise<ProposalView> {
  const res = await opsInject(h, 'POST', '/call', {
    payload: { sessionId: 's1', capability, args, title: `测试 ${capability}`, rationale: 'WP56f 测试' },
  })
  expect(res.statusCode, `${capability}: ${res.body}`).toBe(200)
  const result = jsonOf<OpsCallResult>(res)
  if (result.kind !== 'proposal') throw new Error(`${capability} 应该出方案，实际 ${result.kind}`)
  return result.proposal
}

function lastAuditId(): number {
  return db().get<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs')?.id ?? 0
}

function expectCockpitAudits(mark: number): void {
  const rows = db().all<{ action: string; detail_json: string | null }>(
    'SELECT action, detail_json FROM audit_logs WHERE id > ? ORDER BY id',
    mark,
  )
  const parsed = rows.map((row) => ({
    action: row.action,
    detail: JSON.parse(row.detail_json ?? '{}') as Record<string, unknown>,
  }))
  expect(parsed.find((row) => row.action === 'cockpit.proposal-approve')?.detail['via']).toBe('cockpit')
  for (const row of parsed.filter((item) => !item.action.startsWith('cockpit.'))) {
    expect(row.detail['via'], `${row.action} 缺 via`).toBe('cockpit')
  }
}

async function expectWrite(
  capability: string,
  args: unknown,
  opts: { check?: (settled: ProposalView) => void | Promise<void> } = {},
): Promise<ProposalView> {
  const proposal = await callProposal(capability, args)
  expect(proposal.steps[0]?.preview.summary.length ?? 0, `${capability} 缺 preview.summary`).toBeGreaterThan(
    4,
  )
  if (proposal.risk === 'R3') await reauth(h)
  const mark = lastAuditId()
  const approved = await adminInject(h, 'POST', `/proposals/${String(proposal.id)}/approve`)
  expect(approved.statusCode, `${capability} 批准失败：${approved.body}`).toBe(200)
  const settled = await waitProposalSettled(h, proposal.id)
  expect(settled.status, `${capability} 执行结果：${JSON.stringify(settled.outcome)}`).toBe('succeeded')
  expectCockpitAudits(mark)
  await opts.check?.(settled)
  return settled
}

// ── 中转站：渠道与模型 ─────────────────────────────────────────────────────

function seedChannel(name = '夹具渠道'): { channelId: number; keyIds: number[] } {
  const channel = createChannel(h.app, {
    name,
    baseUrl: 'https://upstream.example.com',
    apis: ['openai-completions'],
    keys: ['sk-test-FAKE-relay-key-0123456789'],
  })
  return { channelId: channel.id, keyIds: channel.keys.map((key) => key.id) }
}

describe('中转站：渠道的删除 / 测速 / 密钥', () => {
  it('relay.channels.delete：渠道与密钥一起没了（R3）', async () => {
    const { channelId } = seedChannel()
    await expectWrite(
      'relay.channels.delete',
      { channelId },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM relay_channels WHERE id = ?', channelId),
          ).toBeUndefined()
        },
      },
    )
  })

  it('relay.channels.test：逐把密钥给结果（R1，自动执行）', async () => {
    const { channelId } = seedChannel()
    const res = await opsInject(h, 'POST', '/call', {
      payload: { sessionId: 's1', capability: 'relay.channels.test', args: { channelId }, title: '测渠道' },
    })
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('done')
    const data = (result as { result: { ok: boolean; results: unknown[] } }).result
    expect(typeof data.ok).toBe('boolean')
    expect(Array.isArray(data.results)).toBe(true)
  })

  it('relay.channels.key.update：停用一把密钥（旧值 → 新值）', async () => {
    const { channelId, keyIds } = seedChannel()
    const keyId = keyIds[0]!
    const proposal = await callProposal('relay.channels.key.update', { channelId, keyId, state: 'disabled' })
    expect(proposal.steps[0]?.preview.summary).toContain('active → disabled')
    await expectWrite(
      'relay.channels.key.update',
      { channelId, keyId, state: 'disabled' },
      {
        check: () => {
          expect(
            db().get<{ state: string }>('SELECT state FROM relay_channel_keys WHERE id = ?', keyId)?.state,
          ).toBe('disabled')
        },
      },
    )
  })

  it('relay.channels.key.delete：删掉一把密钥', async () => {
    const { channelId, keyIds } = seedChannel()
    const keyId = keyIds[0]!
    await expectWrite(
      'relay.channels.key.delete',
      { channelId, keyId },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM relay_channel_keys WHERE id = ?', keyId),
          ).toBeUndefined()
        },
      },
    )
  })
})

describe('中转站：对外模型', () => {
  it('relay.models.create：建出模型与路由', async () => {
    const { channelId } = seedChannel()
    await expectWrite(
      'relay.models.create',
      {
        name: 'wp56f-model',
        displayName: 'WP56f 模型',
        price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
        routes: [{ channelId, upstreamModel: 'upstream-x', enabled: true }],
      },
      {
        check: () => {
          expect(
            db().get<{ n: number }>("SELECT COUNT(*) AS n FROM relay_models WHERE name = 'wp56f-model'")?.n,
          ).toBe(1)
        },
      },
    )
  })

  it('relay.models.update：改显示名与启用状态', async () => {
    const { channelId } = seedChannel()
    const model = await createRelayModel(h.app, {
      name: 'wp56f-update',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId, upstreamModel: 'upstream-x', enabled: true }],
    })
    const proposal = await callProposal('relay.models.update', {
      modelId: model.id,
      patch: { displayName: '改过的名字', enabled: false },
    })
    expect(proposal.steps[0]?.preview.summary).toContain('→')
    await expectWrite(
      'relay.models.update',
      { modelId: model.id, patch: { displayName: '改过的名字', enabled: false } },
      {
        check: () => {
          const row = db().get<{ display_name: string; enabled: number }>(
            'SELECT display_name, enabled FROM relay_models WHERE id = ?',
            model.id,
          )
          expect(row).toMatchObject({ display_name: '改过的名字', enabled: 0 })
        },
      },
    )
  })

  it('relay.models.delete：删掉（R3）', async () => {
    const { channelId } = seedChannel()
    const model = await createRelayModel(h.app, {
      name: 'wp56f-delete',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId, upstreamModel: 'upstream-x', enabled: true }],
    })
    await expectWrite(
      'relay.models.delete',
      { modelId: model.id },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM relay_models WHERE id = ?', model.id),
          ).toBeUndefined()
        },
      },
    )
  })

  it('relay.models.import：从渠道导入模型（含价格）', async () => {
    const { channelId } = seedChannel()
    await expectWrite(
      'relay.models.import',
      {
        channelId,
        models: [{ upstreamModel: 'imported-a' }, { upstreamModel: 'imported-b', name: 'imported-b-alias' }],
        price: { inputMicro: 1_000_000, outputMicro: 1_000_000 },
      },
      {
        check: () => {
          expect(
            db().get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM relay_models WHERE name IN ('imported-a', 'imported-b-alias')",
            )?.n,
          ).toBe(2)
        },
      },
    )
  })
})

describe('中转站：下发与设置 / 钱包 / 用量记录', () => {
  it('relay.dsh.update：改下发勾选与默认路由（R3）', async () => {
    const { channelId } = seedChannel()
    await createRelayModel(h.app, {
      name: 'wp56f-dsh',
      price: { inputMicro: 1_000_000, outputMicro: 2_000_000 },
      routes: [{ channelId, upstreamModel: 'upstream-x', enabled: true }],
    })
    const dsh = await h.app.deps.services.relay.dshResponse()
    const routeId = dsh.models.flatMap((model) => model.routes ?? [])[0]?.routeId
    expect(routeId).toBeGreaterThan(0)
    const proposal = await callProposal('relay.dsh.update', {
      routeIds: [routeId!],
      defaultRouteId: routeId!,
    })
    expect(proposal.steps[0]?.preview.summary).toContain('routeIds')
    await expectWrite(
      'relay.dsh.update',
      { routeIds: [routeId!], defaultRouteId: routeId! },
      {
        check: async () => {
          const after = await h.app.deps.services.relay.dshResponse()
          expect(after.defaultRouteId).toBe(routeId)
          const selected = after.models
            .flatMap((model) => model.routes ?? [])
            .filter((route) => route.selected)
          expect(selected.map((route) => route.routeId)).toEqual([routeId])
        },
      },
    )
  })

  it('relay.settings.update：改 bonus 组（R3）', async () => {
    await expectWrite(
      'relay.settings.update',
      {
        group: 'bonus',
        values: { signupBonusMicro: 4_000_000, dailyBonusMicro: 1_000_000 },
      },
      {
        check: () => {
          expect(h.app.deps.services.relay.getSettings()).toMatchObject({
            signupBonusMicro: 4_000_000,
            dailyBonusMicro: 1_000_000,
          })
        },
      },
    )
  })

  it('relay.wallets.list：钱包列表（R0）', async () => {
    await h.app.deps.services.relay.adjustWallet(alice.id, { amountMicro: 5_000_000, note: '夹具' }, 1, {
      ip: null,
      userAgent: 'vitest',
    })
    const data = await callData<{ total: number; rows: { username: string; balanceMicro: number }[] }>(
      'relay.wallets.list',
    )
    const row = data.rows.find((item) => item.username === 'alice')
    expect(row?.balanceMicro).toBe(5_000_000)
  })

  it('relay.usage.logs：逐条用量记录（R0）', async () => {
    db().run(
      `INSERT INTO relay_usage (request_id, created_at, user_id, key_id, scope, model, base_model, pinned,
                                channel_id, api, stream, source, status, http_status, input_tokens,
                                output_tokens, cache_read_tokens, cache_write_tokens, cost, attempts,
                                duration_ms)
       VALUES ('req-wp56f', ?, ?, NULL, 'dsh', 'm1', 'm1', 0, NULL, 'openai-completions', 0, 'cockpit', 'ok',
               200, 10, 20, 0, 0, 0, 1, 100)`,
      now(),
      alice.id,
    )
    const data = await callData<{ total: number; rows: { requestId: string; source: string }[] }>(
      'relay.usage.logs',
      { source: 'cockpit' },
    )
    expect(data.total).toBe(1)
    expect(data.rows[0]).toMatchObject({ requestId: 'req-wp56f', source: 'cockpit' })
  })
})

// ── 搜索 / 抓取池 ───────────────────────────────────────────────────────────

describe('搜索池页', () => {
  function seedToolChannel(name = '夹具搜索'): number {
    const channel = h.app.deps.services.relay.tools.createChannel(
      {
        kind: 'tavily',
        name,
        baseUrl: 'https://api.tavily.example.com',
        tools: ['search'],
        priority: 10,
        weight: 100,
        timeoutMs: 10_000,
        proxyUrl: null,
        searchCostMicro: 1_000,
        fetchCostMicro: 0,
        enabled: true,
        note: '',
      } as never,
      1,
      { ip: null, userAgent: 'vitest' },
    )
    return channel.id
  }

  it('search.usage：逐次用量（R0）', async () => {
    const data = await callData<{ total: number; rows: unknown[] }>('search.usage')
    expect(data.total).toBe(0)
    expect(Array.isArray(data.rows)).toBe(true)
  })

  it('search.channels.upsert：新建 → 修改', async () => {
    await expectWrite(
      'search.channels.upsert',
      { kind: 'tavily', name: '新搜索渠道' },
      {
        check: () => {
          expect(
            db().get<{ n: number }>("SELECT COUNT(*) AS n FROM relay_tool_channels WHERE name = '新搜索渠道'")
              ?.n,
          ).toBe(1)
        },
      },
    )
    const channelId = db().get<{ id: number }>(
      "SELECT id FROM relay_tool_channels WHERE name = '新搜索渠道'",
    )!.id
    await expectWrite(
      'search.channels.upsert',
      { channelId, name: '改名后的渠道' },
      {
        check: () => {
          expect(
            db().get<{ name: string }>('SELECT name FROM relay_tool_channels WHERE id = ?', channelId)?.name,
          ).toBe('改名后的渠道')
        },
      },
    )
  })

  it('search.channels.delete：删掉（R3）', async () => {
    const channelId = seedToolChannel('要删的搜索渠道')
    await expectWrite(
      'search.channels.delete',
      { channelId },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM relay_tool_channels WHERE id = ?', channelId),
          ).toBeUndefined()
        },
      },
    )
  })

  it('search.channels.keys：密钥只收 secretRef（走密钥卡）', async () => {
    const channelId = seedToolChannel()
    const plain = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'search.channels.keys',
        args: { channelId, apiKey: 'tvly-FAKE-plaintext-key-123456' },
        title: '加密钥',
      },
    })
    expect(plain.statusCode).toBe(400)
    expect(plain.body).toContain('secretRef')

    const created = jsonOf<{ id: string }>(
      await opsInject(h, 'POST', '/secret-requests', {
        payload: {
          sessionId: 's1',
          purpose: 'Tavily key',
          capability: 'search.channels.keys',
          field: 'apiKey',
        },
      }),
    )
    await adminInject(h, 'POST', `/secret-requests/${created.id}`, {
      value: 'tvly-FAKE-key-0123456789abcdef',
    })
    await expectWrite(
      'search.channels.keys',
      { channelId, apiKey: created.id, label: '主账号' },
      {
        check: () => {
          expect(
            db().get<{ n: number }>(
              'SELECT COUNT(*) AS n FROM relay_tool_keys WHERE channel_id = ?',
              channelId,
            )?.n,
          ).toBe(1)
        },
      },
    )
  })

  it('search.channels.key.delete：删掉密钥', async () => {
    const channelId = seedToolChannel()
    const added = h.app.deps.services.relay.tools.addChannelKeys(
      channelId,
      { keys: ['tvly-FAKE-key-for-delete-0123'], label: '' },
      1,
      { ip: null, userAgent: 'vitest' },
    )
    const keyId = added.channel.keys[0]!.id
    await expectWrite(
      'search.channels.key.delete',
      { channelId, keyId },
      {
        check: () => {
          expect(
            db().get<{ id: number }>('SELECT id FROM relay_tool_keys WHERE id = ?', keyId),
          ).toBeUndefined()
        },
      },
    )
  })

  it('search.channels.test：渠道测速（R1，直接执行返回结果）', async () => {
    // 没有密钥时服务端明确拒绝（先钉住这条提示）
    const bare = seedToolChannel('没密钥的渠道')
    const denied = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'search.channels.test',
        args: { channelId: bare },
        title: '测搜索渠道',
      },
    })
    expect(denied.statusCode).toBe(400)
    expect(denied.body).toContain('密钥')

    // 有密钥 + 假上游 → 返回结构化结果（ok 布尔 + 耗时）
    upstream = await startFakeUpstream((_req, res) => {
      jsonResponse(res, 200, { results: [], response_time: 0.01 })
    })
    const channel = h.app.deps.services.relay.tools.createChannel(
      {
        kind: 'tavily',
        name: '带密钥的渠道',
        baseUrl: upstream.url,
        tools: ['search'],
        priority: 10,
        weight: 100,
        timeoutMs: 5_000,
        proxyUrl: null,
        searchCostMicro: 1_000,
        fetchCostMicro: 0,
        enabled: true,
        note: '',
      } as never,
      1,
      { ip: null, userAgent: 'vitest' },
    )
    h.app.deps.services.relay.tools.addChannelKeys(
      channel.id,
      { keys: ['tvly-FAKE-key-for-test-0123456789'], label: '' },
      1,
      { ip: null, userAgent: 'vitest' },
    )
    const res = await opsInject(h, 'POST', '/call', {
      payload: {
        sessionId: 's1',
        capability: 'search.channels.test',
        args: { channelId: channel.id },
        title: '测搜索渠道',
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    const result = jsonOf<OpsCallResult>(res)
    expect(result.kind).toBe('done')
    expect(typeof (result as { result: { ok: boolean } }).result.ok).toBe('boolean')
  })

  it('search.settings.update：改 pricing 组（R3）', async () => {
    await expectWrite(
      'search.settings.update',
      {
        group: 'pricing',
        values: { freeCallsPerMonth: 50, searchPriceMicro: 20_000, fetchPriceMicro: 20_000 },
      },
      {
        check: () => {
          expect(h.app.deps.services.relay.tools.getSettings()).toMatchObject({
            freeCallsPerMonth: 50,
            searchPriceMicro: 20_000,
          })
        },
      },
    )
  })
})
