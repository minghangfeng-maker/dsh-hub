import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DesktopSessionResponseSchema,
  ToolUsageListResponseSchema,
  type DesktopSessionResponse,
  type ToolUsageListResponse,
} from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestSession, type TestUser } from './helpers.js'
import { grantMicro, startFakeUpstream, type FakeUpstream } from './helpers-relay.js'
import { createToolChannel, updateToolSettings } from './helpers-tools.js'
import { deviceHeaders, loginDesktop, type DesktopLoginResult } from './helpers-desktop.js'

/**
 * WP29h：桌面端用 Hub 的搜索池（任务书 §A1 §A2）。
 *
 * 这里钉住三件事：
 * 1. **设备密钥能直接打公网侧** `/v1/tools/{search,fetch}`（不是只有容器用的内部监听器）——
 *    桌面端没有 `HUB_MK_HUB` 的容器注入，靠的是登录时签发的每设备 `kind=user / scope=dsh` 密钥；
 * 2. 计费与限流复用同一套：免费额度、按次扣积分、钱包停用 403、总开关关 503、吊销后 401；
 * 3. `GET /api/desktop/session` 的加法字段 `tools` 跟着搜索池开关走，且用量能看出调用来自桌面端。
 */

interface Fixture {
  app: FastifyInstance
  test: TestApp
  user: TestUser
  session: TestSession
  device: DesktopLoginResult
  /** 设备密钥（登录时签发的 `sk-dsh-…`） */
  key: string
  upstreams: FakeUpstream[]
  close(): Promise<void>
}

const open: Fixture[] = []

afterEach(async () => {
  for (const fixture of open.splice(0)) await fixture.close()
})

const OK_SEARCH = {
  results: [
    { url: 'https://wp29.test/1', title: '假搜索结果', snippet: '来自假上游', date: '2026-10-01' },
  ],
}

const SEARCH_HANDLER = (req: { url?: string }, res: import('node:http').ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(req.url?.startsWith('/fetch') ? { content: '# 假抓取' } : OK_SEARCH))
}

async function setup(
  opts: {
    walletMicro?: number
    freeCallsPerMonth?: number
    searchPriceMicro?: number
    fetchPriceMicro?: number
    toolsEnabled?: boolean
    deliverToDsh?: boolean
    walletEnabled?: boolean
  } = {},
): Promise<Fixture> {
  const test = await createTestApp()
  const user = await createUser(test.app)
  grantMicro(test.app, user.id, opts.walletMicro ?? 10_000_000)
  if (opts.walletEnabled === false) {
    test.app.deps.services.relay.updateWallet(
      user.id,
      { enabled: false },
      1,
      { ip: '127.0.0.1', userAgent: 'vitest' },
    )
  }
  updateToolSettings(test.app, {
    enabled: opts.toolsEnabled ?? true,
    deliverToDsh: opts.deliverToDsh ?? false,
    freeCallsPerMonth: opts.freeCallsPerMonth ?? 100,
    searchPriceMicro: opts.searchPriceMicro ?? 10_000,
    fetchPriceMicro: opts.fetchPriceMicro ?? 20_000,
    maxAttempts: 3,
    keyCooldownSeconds: 60,
  })
  const session = loginAs(test.app, user)
  const device = await loginDesktop(test.app, session, { name: 'WP29 桌面端' })
  if (!device.relay) throw new Error('登录没有签发设备中转站密钥')
  const fixture: Fixture = {
    app: test.app,
    test,
    user,
    session,
    device,
    key: device.relay.secret,
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

async function postTools(
  fixture: Fixture,
  path: 'search' | 'fetch',
  payload: Record<string, unknown>,
  key = fixture.key,
) {
  return await fixture.app.inject({
    method: 'POST',
    url: `/v1/tools/${path}`,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload,
  })
}

async function sessionOf(fixture: Fixture) {
  const res = await fixture.app.inject({
    method: 'GET',
    url: '/api/desktop/session',
    headers: deviceHeaders(fixture.device.token),
  })
  expect(res.statusCode).toBe(200)
  return { body: DesktopSessionResponseSchema.parse(json(res)) as DesktopSessionResponse, res }
}

async function adminUsage(fixture: Fixture): Promise<ToolUsageListResponse> {
  const admin = await createUser(fixture.app, { role: 'admin' })
  const adminSession = loginAs(fixture.app, admin)
  const res = await fixture.app.inject({
    method: 'GET',
    url: '/api/admin/tools/usage?pageSize=50',
    headers: adminSession.headers,
  })
  expect(res.statusCode).toBe(200)
  return ToolUsageListResponseSchema.parse(json(res)) as ToolUsageListResponse
}

describe('WP29h：设备密钥打公网侧 /v1/tools', () => {
  it('设备密钥直接调 /v1/tools/search 与 /v1/tools/fetch 成功（只靠设备凭据，不注入 HUB_MK_HUB）', async () => {
    const fixture = await setup()
    const upstream = addUpstream(fixture, await startFakeUpstream(SEARCH_HANDLER))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'wp29-deepseek',
      baseUrl: upstream.url,
      keys: ['wp29-upstream-key'],
    })

    const search = await postTools(fixture, 'search', { query: '桌面端搜索', count: 5 })
    expect(search.statusCode).toBe(200)
    expect(json(search)).toEqual(OK_SEARCH)
    expect(upstream.requests[0]!.url).toBe('/search')
    expect(upstream.requests[0]!.headers.authorization).toBe('Bearer wp29-upstream-key')

    const fetch = await postTools(fixture, 'fetch', { url: 'https://wp29.test/1' })
    expect(fetch.statusCode).toBe(200)
    expect(json(fetch)).toEqual({ content: '# 假抓取' })
  })

  it('用量记在设备密钥上：免费额度 +1、管理端能看出 clientKind=desktop', async () => {
    const fixture = await setup({ freeCallsPerMonth: 5 })
    const upstream = addUpstream(fixture, await startFakeUpstream(SEARCH_HANDLER))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'wp29-deepseek',
      baseUrl: upstream.url,
      keys: ['wp29-upstream-key'],
    })

    expect((await postTools(fixture, 'search', { query: '第一次' })).statusCode).toBe(200)

    const row = fixture.app.deps.db.get<{ user_id: number; key_id: number; free: number; status: string }>(
      'SELECT user_id, key_id, free, status FROM relay_tool_usage ORDER BY id DESC LIMIT 1',
    )
    expect(row?.user_id).toBe(fixture.user.id)
    expect(row?.key_id).toBe(fixture.device.relay!.keyId)
    expect(row?.free).toBe(1)
    expect(row?.status).toBe('ok')

    const usage = await adminUsage(fixture)
    expect(usage.items[0]!.clientKind).toBe('desktop')

    const mine = await fixture.app.inject({
      method: 'GET',
      url: '/api/me/tools',
      headers: fixture.session.headers,
    })
    expect((json(mine) as { freeUsed: number }).freeUsed).toBe(1)
  })

  it('超过免费额度后按次扣积分（钱包减少、免费计数不再增长）', async () => {
    const fixture = await setup({ freeCallsPerMonth: 1, searchPriceMicro: 10_000, walletMicro: 1_000_000 })
    const upstream = addUpstream(fixture, await startFakeUpstream(SEARCH_HANDLER))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'wp29-deepseek',
      baseUrl: upstream.url,
      keys: ['wp29-upstream-key'],
    })
    const balanceOf = () =>
      fixture.app.deps.db.get<{ balance: number }>(
        'SELECT balance FROM relay_wallets WHERE user_id = ?',
        fixture.user.id,
      )!.balance

    const before = balanceOf()
    expect((await postTools(fixture, 'search', { query: '免费那次' })).statusCode).toBe(200)
    expect(balanceOf()).toBe(before)

    expect((await postTools(fixture, 'search', { query: '第二次' })).statusCode).toBe(200)
    expect(balanceOf()).toBe(before - 10_000)
    expect((await postTools(fixture, 'search', { query: '第三次' })).statusCode).toBe(200)
    expect(balanceOf()).toBe(before - 20_000)

    // 对账不变量（14 §3.3）：余额 = 充值 - 工具花费
    const spent = fixture.app.deps.db.get<{ n: number }>(
      'SELECT COALESCE(SUM(cost), 0) AS n FROM relay_tool_usage WHERE user_id = ?',
      fixture.user.id,
    )!.n
    expect(spent).toBe(20_000)
    const free = fixture.app.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM relay_tool_usage WHERE user_id = ? AND free = 1',
      fixture.user.id,
    )!.n
    expect(free).toBe(1)
  })

  it('搜索池总开关关着 → 503 service_unavailable（明确错误，不是 500）', async () => {
    const fixture = await setup({ toolsEnabled: false })
    const upstream = addUpstream(fixture, await startFakeUpstream(SEARCH_HANDLER))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'wp29-deepseek',
      baseUrl: upstream.url,
      keys: ['wp29-upstream-key'],
    })
    const res = await postTools(fixture, 'search', { query: '关了' })
    expect(res.statusCode).toBe(503)
    expect((json(res) as { error: { code: string } }).error.code).toBe('service_unavailable')
    expect(upstream.requests).toHaveLength(0)
  })

  it('钱包停用 → 403 permission_denied（与模型调用同一套进门检查）', async () => {
    const fixture = await setup({ walletEnabled: false })
    const upstream = addUpstream(fixture, await startFakeUpstream(SEARCH_HANDLER))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'wp29-deepseek',
      baseUrl: upstream.url,
      keys: ['wp29-upstream-key'],
    })
    const res = await postTools(fixture, 'search', { query: '停用' })
    expect(res.statusCode).toBe(403)
    expect((json(res) as { error: { code: string } }).error.code).toBe('permission_denied')
  })

  it('吊销设备 → 设备密钥立刻 401（密钥与设备令牌一起吊销）', async () => {
    const fixture = await setup()
    const upstream = addUpstream(fixture, await startFakeUpstream(SEARCH_HANDLER))
    createToolChannel(fixture.app, {
      kind: 'deepseek',
      name: 'wp29-deepseek',
      baseUrl: upstream.url,
      keys: ['wp29-upstream-key'],
    })
    expect((await postTools(fixture, 'search', { query: '吊销前' })).statusCode).toBe(200)

    const admin = await createUser(fixture.app, { role: 'admin' })
    const adminSession = loginAs(fixture.app, admin)
    // 管理端的写操作要「刚二次验证过」（WP25d/WP25e 的 reauth 门），测试里直接把标记打上
    fixture.app.deps.db.run(
      'UPDATE sessions SET reauth_at = ? WHERE id = ?',
      new Date(Date.now() - 1000).toISOString(),
      adminSession.sessionId,
    )
    const revoked = await fixture.app.inject({
      method: 'POST',
      url: '/api/admin/desktop-devices/revoke',
      headers: { ...adminSession.headers, 'x-hub-csrf': '1' },
      payload: { deviceIds: [fixture.device.deviceId] },
    })
    expect(revoked.statusCode).toBe(200)

    const res = await postTools(fixture, 'search', { query: '吊销后' })
    expect(res.statusCode).toBe(401)
    expect((json(res) as { error: { code: string } }).error.code).toBe('invalid_api_key')
  })
})

describe('WP29h：GET /api/desktop/session 的 tools 字段（加法）', () => {
  it('默认（搜索池关）→ {search:false, baseUrl:null}', async () => {
    const fixture = await setup({ toolsEnabled: false })
    const { body } = await sessionOf(fixture)
    expect(body.tools).toEqual({ search: false, baseUrl: null })
  })

  it('只开总开关、没开下发 → 仍然是关（桌面端拿不到配置）', async () => {
    const fixture = await setup({ toolsEnabled: true, deliverToDsh: false })
    const { body } = await sessionOf(fixture)
    expect(body.tools).toEqual({ search: false, baseUrl: null })
  })

  it('开总开关 + 下发 → search=true，baseUrl = 设置里的 publicBaseUrl', async () => {
    const fixture = await setup({ toolsEnabled: true, deliverToDsh: true })
    const { body } = await sessionOf(fixture)
    const expected = `${fixture.test.config.publicOrigin.replace(/\/+$/u, '')}/v1/tools`
    expect(body.tools).toEqual({ search: true, baseUrl: expected })
    // 与 /api/me/tools 报给管理端的是同一个地址（不各算一份）
    const relayTools = fixture.app.deps.services.relay.tools.settingsResponse()
    expect(body.tools?.baseUrl).toBe(relayTools.publicBaseUrl)
  })

  it('开关变化会让 ETag 变（客户端不会拿到旧的缓存）', async () => {
    const fixture = await setup({ toolsEnabled: false })
    const off = await sessionOf(fixture)
    updateToolSettings(fixture.app, { enabled: true, deliverToDsh: true })
    const on = await sessionOf(fixture)
    expect(on.res.headers.etag).not.toBe(off.res.headers.etag)
    expect(on.body.tools?.search).toBe(true)
    // 再用旧 ETag 换 304 不该成立
    const cached = await fixture.app.inject({
      method: 'GET',
      url: '/api/desktop/session',
      headers: { ...deviceHeaders(fixture.device.token), 'if-none-match': String(off.res.headers.etag) },
    })
    expect(cached.statusCode).toBe(200)
  })

  it('老 Hub 的会话没有 tools 键也能通过契约解析（可选字段）', () => {
    const parsed = DesktopSessionResponseSchema.parse({
      user: { username: 'u', displayName: 'u', role: 'user', roleLabel: '' },
      wallet: null,
      device: { deviceId: `dv_${'a'.repeat(32)}`, name: 'Windows 11 上的 DSH Hub' },
    })
    expect(parsed.tools).toBeUndefined()
  })
})
