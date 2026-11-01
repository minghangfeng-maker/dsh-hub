import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import {
  grantMicro,
  issueKey,
  startFakeUpstream,
  type FakeUpstream,
  type FakeUpstreamHandler,
} from './helpers-relay.js'
import {
  DEEPSEEK_FETCH_BODY,
  DEEPSEEK_SEARCH_BODY,
  TAVILY_FETCH_BODY,
  TAVILY_SEARCH_BODY,
  createToolChannel,
  markInternalListening,
  toolService,
  updateToolSettings,
} from './helpers-tools.js'

/**
 * 搜索池集成测试（WP18a，任务书 §5）：假上游（进程内 http server）+ `app.inject`。
 * 覆盖格式转换、错误分支与候选切换、免费额度与计费、对账不变量、下发渲染、路由边界。
 */

interface Fixture {
  app: FastifyInstance
  test: TestApp
  user: TestUser
  key: string
  upstreams: FakeUpstream[]
  close(): Promise<void>
}

const open: Fixture[] = []

/** `/v1/tools/*` 的错误体（14 §3.1） */
function errorOf(res: { body: string }): { code: string; message: string; type: string } {
  return (JSON.parse(res.body) as { error: { code: string; message: string; type: string } }).error
}

afterEach(async () => {
  for (const fixture of open.splice(0)) await fixture.close()
})

async function upstream(handler: FakeUpstreamHandler): Promise<FakeUpstream> {
  return await startFakeUpstream(handler)
}

async function setup(
  opts: {
    walletMicro?: number
    freeCallsPerMonth?: number
    searchPriceMicro?: number
    fetchPriceMicro?: number
    deliverToDsh?: boolean
    ratePercent?: number
  } = {},
): Promise<Fixture> {
  const test = await createTestApp()
  const user = await createUser(test.app)
  grantMicro(test.app, user.id, opts.walletMicro ?? 10_000_000)
  if (opts.ratePercent !== undefined) {
    test.app.deps.services.relay.updateWallet(user.id, { ratePercent: opts.ratePercent }, 1, {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
  }
  updateToolSettings(test.app, {
    enabled: true,
    deliverToDsh: opts.deliverToDsh ?? false,
    freeCallsPerMonth: opts.freeCallsPerMonth ?? 100,
    searchPriceMicro: opts.searchPriceMicro ?? 10_000,
    fetchPriceMicro: opts.fetchPriceMicro ?? 20_000,
    maxAttempts: 3,
    keyCooldownSeconds: 60,
  })
  const key = issueKey(test.app, user.id)
  const fixture: Fixture = {
    app: test.app,
    test,
    user,
    key,
    upstreams: [],
    async close() {
      for (const server of fixture.upstreams) await server.close()
      await test.close()
    },
  }
  open.push(fixture)
  return fixture
}

function addUpstream(fixture: Fixture, server: FakeUpstream): FakeUpstream {
  fixture.upstreams.push(server)
  return server
}

async function post(fixture: Fixture, path: string, payload: Record<string, unknown>, key = fixture.key) {
  return await fixture.app.inject({
    method: 'POST',
    url: path,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload,
  })
}

const OK_SEARCH: FakeUpstreamHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(req.url?.startsWith('/search') ? DEEPSEEK_SEARCH_BODY : DEEPSEEK_FETCH_BODY))
}

describe('搜索池 /v1/tools：格式转换与鉴权', () => {
  it('DeepSeek 渠道：原样转发请求、响应原样返回 DeepSeek 格式', async () => {
    const fixture = await setup()
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['ds-key-1'],
    })

    const res = await post(fixture, '/v1/tools/search', { query: '你好', count: 5 })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual(DEEPSEEK_SEARCH_BODY)
    const sent = server.requests[0]!
    expect(sent.url).toBe('/search')
    expect(sent.headers.authorization).toBe('Bearer ds-key-1')
    expect(sent.json).toEqual({ query: '你好', count: 5, need_content: false })
  })

  it('Tavily 渠道：请求/响应适配成 DeepSeek 格式（count 截 20、ori_question 忽略）', async () => {
    const fixture = await setup()
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(TAVILY_SEARCH_BODY))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'tavily',
      name: 'tv',
      baseUrl: server.url,
      keys: ['tv-key-1'],
    })

    const res = await post(fixture, '/v1/tools/search', { query: 'q', count: 50, ori_question: 'orig' })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({
      results: [
        { url: 'https://tv.test/1', title: 'Tavily 结果', snippet: '来自 Tavily', date: null },
        { url: 'https://tv.test/2', title: '没有日期', snippet: '第二条', date: null },
      ],
    })
    expect(server.requests[0]!.url).toBe('/search')
    expect(server.requests[0]!.json).toEqual({
      query: 'q',
      max_results: 20,
      search_depth: 'basic',
      include_answer: false,
    })
  })

  it('Tavily 抓取：/extract → {content}', async () => {
    const fixture = await setup()
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(TAVILY_FETCH_BODY))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'tavily',
      name: 'tv',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const res = await post(fixture, '/v1/tools/fetch', { url: 'https://tv.test/1' })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ content: '# 标题\n\n正文' })
    expect(server.requests[0]!.json).toEqual({
      urls: ['https://tv.test/1'],
      format: 'markdown',
      extract_depth: 'basic',
    })
  })

  it('密钥无效 401、请求体不合法 400、总开关关 503', async () => {
    const fixture = await setup()
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })

    const bad = await post(fixture, '/v1/tools/search', { query: 'x' }, 'sk-dsh-not-a-real-key')
    expect(bad.statusCode).toBe(401)
    expect(errorOf(bad).code).toBe('invalid_api_key')

    const invalid = await post(fixture, '/v1/tools/search', { query: '' })
    expect(invalid.statusCode).toBe(400)
    expect(errorOf(invalid).type).toBe('invalid_request_error')

    updateToolSettings(fixture.app, { enabled: false })
    const off = await post(fixture, '/v1/tools/search', { query: 'x' })
    expect(off.statusCode).toBe(503)
    expect(errorOf(off).message).toContain('已关闭')
  })
})

describe('搜索池：候选切换与失败分类', () => {
  it('Tavily 432 → 密钥冷却到下月 1 日 UTC 并切到 DeepSeek', async () => {
    const fixture = await setup()
    fixture.test.clock.set('2026-10-18T03:00:00.000Z')
    const tavily = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(432, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'plan limit reached' } }))
      }),
    )
    const deepseek = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'tavily',
      name: 'tv',
      baseUrl: tavily.url,
      keys: ['tv-key-0001'],
      priority: 10,
    })
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: deepseek.url,
      keys: ['ds-key-0001'],
      priority: 0,
    })

    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(200)
    expect(deepseek.requests).toHaveLength(1)
    const keys = toolService(fixture.app)
      .listChannels()
      .find((c) => c.name === 'tv')!.keys
    expect(keys[0]!.cooldownReason).toBe('exhausted')
    expect(keys[0]!.cooldownUntil).toBe('2026-11-01T00:00:00.000Z')
  })

  it('401 → 密钥 auto-disabled + 审计，换下一把密钥成功', async () => {
    const fixture = await setup()
    let calls = 0
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        calls += 1
        if (calls === 1) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'bad key' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(DEEPSEEK_SEARCH_BODY))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-aaaa', 'tool-key-bbbb'],
    })

    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(200)
    expect(server.requests).toHaveLength(2)
    const keys = toolService(fixture.app).listChannels()[0]!.keys
    expect(keys.filter((k) => k.state === 'auto-disabled')).toHaveLength(1)
    const audits = fixture.app.deps.db.all<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'tools.key.auto-disable'",
    )
    expect(audits).toHaveLength(1)
  })

  it('429 → 密钥冷却 max(Retry-After, keyCooldownSeconds)', async () => {
    const fixture = await setup()
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'slow down' } }))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const before = fixture.test.clock.now().getTime()
    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(429)
    const key = toolService(fixture.app).listChannels()[0]!.keys[0]!
    expect(key.cooldownReason).toBe('rate-limit')
    expect(Date.parse(key.cooldownUntil!)).toBe(before + 120_000)
  })

  it('5xx → 密钥冷却 + 渠道 fail_streak，换下一渠道成功', async () => {
    const fixture = await setup()
    const bad = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'boom' } }))
      }),
    )
    const good = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'bad',
      baseUrl: bad.url,
      keys: ['tool-key-0001'],
      priority: 10,
    })
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'good',
      baseUrl: good.url,
      keys: ['tool-key-0002'],
      priority: 0,
    })
    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(200)
    const channels = toolService(fixture.app).listChannels()
    expect(channels.find((c) => c.name === 'bad')!.failStreak).toBe(1)
    expect(channels.find((c) => c.name === 'bad')!.keys[0]!.cooldownReason).toBe('error')
  })

  it('400 → client_error：原样回 400、不换候选、不计费', async () => {
    const fixture = await setup()
    let calls = 0
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        calls += 1
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad query' } }))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).message).toContain('bad query')
    expect(calls).toBe(1)
    const row = fixture.app.deps.db.get<{ status: string; cost: number }>(
      'SELECT status, cost FROM relay_tool_usage ORDER BY id DESC LIMIT 1',
    )
    expect(row).toEqual({ status: 'client_error', cost: 0 })
  })

  it('Tavily 抓取目标抓不到 → client_error 400，不换不计费', async () => {
    const fixture = await setup()
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ results: [], failed_results: [{ url: 'https://x.test', error: '404' }] }))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'tavily',
      name: 'tv',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const res = await post(fixture, '/v1/tools/fetch', { url: 'https://x.test' })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).message).toContain('抓不到')
  })

  it('全部候选失败 → 502，不计费', async () => {
    const fixture = await setup()
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'down' } }))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const before = fixture.app.deps.services.relay.getBalance(fixture.user.id)
    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(502)
    expect(fixture.app.deps.services.relay.getBalance(fixture.user.id)).toBe(before)
    const row = fixture.app.deps.db.get<{ status: string; cost: number; attempts: number }>(
      'SELECT status, cost, attempts FROM relay_tool_usage ORDER BY id DESC LIMIT 1',
    )
    expect(row!.status).toBe('upstream_error')
    expect(row!.cost).toBe(0)
  })

  it('没有可用渠道 → 503', async () => {
    const fixture = await setup()
    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(503)
    expect(errorOf(res).code).toBe('no_available_channel')
  })
})

describe('搜索池：免费额度与计费', () => {
  it('前 N 次 free、第 N+1 次按 searchPriceMicro × rate_percent 扣费', async () => {
    const fixture = await setup({ freeCallsPerMonth: 2, searchPriceMicro: 10_000, ratePercent: 200 })
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const start = fixture.app.deps.services.relay.getBalance(fixture.user.id)

    for (let i = 0; i < 3; i += 1) {
      const res = await post(fixture, '/v1/tools/search', { query: `q${String(i)}` })
      expect(res.statusCode).toBe(200)
    }
    // 前两次免费，第三次 10000 × 200% = 20000
    expect(fixture.app.deps.services.relay.getBalance(fixture.user.id)).toBe(start - 20_000)
    const rows = fixture.app.deps.db.all<{ free: number; cost: number }>(
      'SELECT free, cost FROM relay_tool_usage ORDER BY id ASC',
    )
    expect(rows.map((row) => [row.free, row.cost])).toEqual([
      [1, 0],
      [1, 0],
      [0, 20_000],
    ])
  })

  it('失败调用不占免费额度', async () => {
    const fixture = await setup({ freeCallsPerMonth: 1 })
    // 用 client_error（400）而不是 5xx：5xx 会给密钥上冷却，下一次调用会变成 503
    const server = addUpstream(
      fixture,
      await upstream((_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad query' } }))
      }),
    )
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const failed = await post(fixture, '/v1/tools/search', { query: 'fail' })
    expect(failed.statusCode).toBe(400)
    server.setHandler(OK_SEARCH)
    const res = await post(fixture, '/v1/tools/search', { query: 'ok' })
    expect(res.statusCode).toBe(200)
    const row = fixture.app.deps.db.get<{ free: number }>(
      'SELECT free FROM relay_tool_usage ORDER BY id DESC LIMIT 1',
    )
    expect(row!.free).toBe(1)
  })

  it('跨月重置免费额度', async () => {
    const fixture = await setup({ freeCallsPerMonth: 1 })
    fixture.test.clock.set('2026-10-31T10:00:00.000Z')
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    await post(fixture, '/v1/tools/search', { query: 'a' })
    fixture.test.clock.set('2026-11-01T10:00:00.000Z')
    await post(fixture, '/v1/tools/search', { query: 'b' })
    const rows = fixture.app.deps.db.all<{ free: number; month: string }>(
      'SELECT free, month FROM relay_tool_usage ORDER BY id ASC',
    )
    expect(rows).toEqual([
      { free: 1, month: '2026-10' },
      { free: 1, month: '2026-11' },
    ])
  })

  it('免费额度用完且余额 ≤ 0 → 402，不发上游请求', async () => {
    const fixture = await setup({ freeCallsPerMonth: 0, walletMicro: 0 })
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(402)
    expect(errorOf(res).code).toBe('insufficient_points')
    expect(server.requests).toHaveLength(0)
    const row = fixture.app.deps.db.get<{ status: string }>(
      'SELECT status FROM relay_tool_usage ORDER BY id DESC LIMIT 1',
    )
    expect(row!.status).toBe('rejected')
  })

  it('钱包停用 → 403', async () => {
    const fixture = await setup()
    fixture.app.deps.services.relay.updateWallet(fixture.user.id, { enabled: false }, 1, {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    const res = await post(fixture, '/v1/tools/search', { query: 'q' })
    expect(res.statusCode).toBe(403)
  })

  it('对账不变量：balance = Σledger − Σrelay_usage.cost − Σrelay_tool_usage.cost', async () => {
    const fixture = await setup({ freeCallsPerMonth: 1, searchPriceMicro: 10_000 })
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    await post(fixture, '/v1/tools/search', { query: 'a' })
    await post(fixture, '/v1/tools/search', { query: 'b' })
    await post(fixture, '/v1/tools/fetch', { url: 'https://x.test' })

    const db = fixture.app.deps.db
    const ledger = Number(
      db.get<{ total: number | null }>(
        'SELECT SUM(amount) AS total FROM relay_ledger WHERE user_id = ?',
        fixture.user.id,
      )?.total ?? 0,
    )
    const tokenCost = Number(
      db.get<{ total: number | null }>(
        'SELECT SUM(cost) AS total FROM relay_usage WHERE user_id = ?',
        fixture.user.id,
      )?.total ?? 0,
    )
    const toolCost = Number(
      db.get<{ total: number | null }>(
        'SELECT SUM(cost) AS total FROM relay_tool_usage WHERE user_id = ?',
        fixture.user.id,
      )?.total ?? 0,
    )
    const balance = fixture.app.deps.services.relay.getBalance(fixture.user.id)
    expect(balance).toBe(ledger - tokenCost - toolCost)
    // 工具费用不进 total_spent
    const wallet = fixture.app.deps.services.relay.getWalletRow(fixture.user.id)
    expect(wallet.totalSpentMicro).toBe(0)
  })
})

describe('搜索池：管理与用户端接口', () => {
  it('管理端设置 / 概览 / 用量；用户端 myTools', async () => {
    const fixture = await setup({ freeCallsPerMonth: 3 })
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    const channel = createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['sk-tool-secret-abc123', 'sk-tool-secret-def456'],
      searchCostMicro: 5_000,
    })
    expect(channel.keys).toHaveLength(2)
    expect(channel.keys[0]!.last4).toBe('c123')
    // 密钥明文不出现在 DTO 里
    expect(JSON.stringify(channel)).not.toContain('sk-tool-secret-abc123')

    await post(fixture, '/v1/tools/search', { query: 'q' })

    const settings = toolService(fixture.app).settingsResponse()
    expect(settings.settings.enabled).toBe(true)
    expect(settings.publicBaseUrl).toContain('/v1/tools')
    expect(settings.internalBaseUrl).toBeNull()

    const overview = toolService(fixture.app).overview()
    expect(overview.totals.calls).toBe(1)
    expect(overview.totals.freeCalls).toBe(1)
    expect(overview.totals.upstreamCostMicro).toBe(5_000)
    expect(overview.byTool).toEqual([{ tool: 'search', calls: 1, revenueMicro: 0 }])

    const adminUsage = toolService(fixture.app).usageList({ page: 1, pageSize: 20 }, { scope: 'admin' })
    expect(adminUsage.total).toBe(1)
    expect(adminUsage.items[0]!.channelName).toBe('ds')
    expect(adminUsage.items[0]!.upstreamCostMicro).toBe(5_000)

    const userUsage = toolService(fixture.app).usageList(
      { page: 1, pageSize: 20 },
      { userId: fixture.user.id, scope: 'user' },
    )
    expect(userUsage.items[0]!.channelName).toBeNull()
    expect(userUsage.items[0]!.upstreamCostMicro).toBeNull()

    const mine = toolService(fixture.app).myTools(fixture.user.id)
    expect(mine.freeUsed).toBe(1)
    expect(mine.monthCalls).toBe(1)
    expect(mine.dshAttached).toBe(false)
  })

  it('批量加密钥按 sha256 去重；改/删密钥与清除冷却', async () => {
    const fixture = await setup()
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    const channel = createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['dup-key-0001', 'dup-key-0001', 'other-key-0002'],
    })
    expect(channel.keys).toHaveLength(2)
    const again = toolService(fixture.app).addChannelKeys(
      channel.id,
      { keys: ['dup-key-0001', 'third-key-0003'] },
      1,
      { ip: '127.0.0.1', userAgent: 'vitest' },
    )
    expect(again.added).toBe(1)
    expect(again.skipped).toBe(1)

    const first = again.channel.keys[0]!
    const updated = toolService(fixture.app).updateChannelKey(
      channel.id,
      first.id,
      { state: 'disabled' },
      1,
      { ip: '127.0.0.1', userAgent: 'vitest' },
    )
    expect(updated.keys.find((k) => k.id === first.id)!.state).toBe('disabled')

    toolService(fixture.app).deleteChannelKey(channel.id, first.id, 1, {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    const afterDelete = toolService(fixture.app).listChannels()[0]!
    expect(afterDelete.keys.some((key) => key.id === first.id)).toBe(false)
  })

  it('渠道测试用固定 query 真打一次，不计用户费用', async () => {
    const fixture = await setup()
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    const channel = createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const result = await toolService(fixture.app).testChannel(channel.id)
    expect(result.ok).toBe(true)
    expect(result.results).toBe(2)
    expect(server.requests[0]!.json).toMatchObject({ query: 'DeepSeek', count: 1 })
    expect(fixture.app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relay_tool_usage')!.n).toBe(0)
  })
})

describe('搜索池：下发渲染（14 §5）', () => {
  it('开启下发 + 内部监听器在监听 → managed.patch.yml 出现两个 web 条目，容器 env 有 HUB_MK_HUB', async () => {
    const fixture = await setup({ deliverToDsh: true })
    markInternalListening(fixture.app)
    const rendered = await fixture.app.deps.services.models.renderManaged(fixture.user.id)
    expect(rendered.content).toContain('id: web')
    expect(rendered.content).toContain('searchProvider: deepseek-search-api')
    expect(rendered.content).toContain('fetchProvider: deepseek-fetch-api')
    expect(rendered.content).toContain('id: web-deepseek-api')
    expect(rendered.content).toContain('baseURL: http://10.213.0.1:7710/v1/tools')
    expect(rendered.content).toContain('apiKeyEnv: HUB_MK_HUB')

    const env = await fixture.app.deps.services.models.containerEnv(fixture.user.id)
    expect(env.HUB_MK_HUB).toMatch(/^sk-dsh-/)
  })

  it('开关组合变化会改变渲染内容与指纹', async () => {
    const fixture = await setup({ deliverToDsh: false })
    markInternalListening(fixture.app)
    const before = await fixture.app.deps.services.models.renderManaged(fixture.user.id)
    const beforeFingerprint = toolService(fixture.app).renderFingerprint()
    expect(before.content).not.toContain('web-deepseek-api')

    updateToolSettings(fixture.app, { deliverToDsh: true })
    const after = await fixture.app.deps.services.models.renderManaged(fixture.user.id)
    expect(after.content).toContain('id: web-deepseek-api')
    expect(toolService(fixture.app).renderFingerprint()).not.toBe(beforeFingerprint)
  })

  it('内部监听器关闭 → 不渲染并给告警', async () => {
    const fixture = await setup({ deliverToDsh: true })
    // 不调 markInternalListening：internalBaseUrl 为 null
    const rendered = await fixture.app.deps.services.models.renderManaged(fixture.user.id)
    expect(rendered.content).not.toContain('web-deepseek-api')
    expect(rendered.warnings.some((line) => line.includes('内部监听器'))).toBe(true)
    expect(toolService(fixture.app).settingsResponse().internalBaseUrl).toBeNull()
  })

  it('工具开关变化进入 relay 的 GET /dsh warnings（待下发提示）', async () => {
    const fixture = await setup({ deliverToDsh: false })
    markInternalListening(fixture.app)
    const admin = await createUser(fixture.app, { role: 'admin' })
    updateToolSettings(fixture.app, { deliverToDsh: true })
    const response = await fixture.app.deps.services.relay.dshResponse()
    expect(response.warnings.some((line) => line.includes('搜索池') || line.includes('搜索/抓取'))).toBe(true)
    void admin
  })
})

describe('搜索池：路由边界', () => {
  it('/v1/tools/* 不受会话 / CSRF / Origin 钩子影响（无 cookie、无 Origin 也能调）', async () => {
    const fixture = await setup()
    const server = addUpstream(fixture, await upstream(OK_SEARCH))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'ds',
      baseUrl: server.url,
      keys: ['tool-key-0001'],
    })
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/tools/search',
      headers: { authorization: `Bearer ${fixture.key}`, origin: 'http://evil.example' },
      payload: { query: 'q' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('未知的 /v1/tools/* 返回 DeepSeek 风格 404（不落到 SPA）', async () => {
    const fixture = await setup()
    const res = await fixture.app.inject({ method: 'POST', url: '/v1/tools/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('用户端需要登录；管理端需要管理员', async () => {
    const fixture = await setup()
    const anon = await fixture.app.inject({ method: 'GET', url: '/api/me/tools' })
    expect(anon.statusCode).toBe(401)

    const user = await createUser(fixture.app)
    const session = loginAs(fixture.app, user)
    const forbidden = await fixture.app.inject({
      method: 'GET',
      url: '/api/admin/tools/settings',
      headers: session.headers,
    })
    expect(forbidden.statusCode).toBe(403)

    const mine = await fixture.app.inject({ method: 'GET', url: '/api/me/tools', headers: session.headers })
    expect(mine.statusCode).toBe(200)
    expect(json<{ freeCallsPerMonth: number }>(mine).freeCallsPerMonth).toBe(100)
  })
})
