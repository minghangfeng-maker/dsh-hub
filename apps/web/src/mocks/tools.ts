import type {
  MyToolsResponse,
  TestToolChannelResponse,
  ToolChannel,
  ToolChannelKey,
  ToolOverviewResponse,
  ToolSettings,
  ToolUsageRow,
  ToolUsageStatus,
} from '@dsh-hub/shared'

import { DEFAULT_TOOL_SETTINGS } from '@dsh-hub/shared'

import { ADMIN_USERS } from './admin'
import { getMockState, type MockScenario } from './state'

/**
 * 搜索 / 抓取池的假数据与假接口（**仅开发环境**，`?mock=admin` 的管理端 + 用户端 `/api/me/tools*`）。
 *
 * 覆盖 14 §3 的全部接口：设置、概览、渠道 CRUD + 测试、批量加密钥、改/删密钥、用量分页；
 * 场景：
 * - 默认（`?mock=admin` / `?mock=1`）：搜索池开着，有 Tavily + DeepSeek 两个渠道，
 *   其中一把 Tavily 密钥额度用完（冷却到下月 1 日）、一把 DeepSeek 密钥被自动停用；
 * - `admin-tools-off`：管理端看到「总开关关掉」的样子；
 * - `tools-exhausted`：用户端免费额度用完（卡片进度条打满、按次扣费）。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

function apiError(
  code: string,
  status: number,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return json({ error: { code, message, details } }, status)
}

function readJson(init?: RequestInit): Record<string, unknown> {
  const raw = init?.body
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ── 时间（Asia/Shanghai 自然月，14 §4）──────────────────────────────────────

const SHANGHAI_OFFSET_MS = 8 * 3600_000
const NOW = Date.now()

const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()

/** 当前自然月 `YYYY-MM`（UTC+8） */
function shanghaiMonth(): string {
  return new Date(NOW + SHANGHAI_OFFSET_MS).toISOString().slice(0, 7)
}

/** Tavily 额度用完的冷却时刻：下个月 1 日 00:00 UTC（14 §3.1） */
function nextMonthStartUtc(): string {
  const now = new Date(NOW + SHANGHAI_OFFSET_MS)
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  return new Date(Date.UTC(month === 11 ? year + 1 : year, (month + 1) % 12, 1)).toISOString()
}

// ── 状态 ────────────────────────────────────────────────────────────────────

interface ToolsMockState {
  scenario: MockScenario
  settings: ToolSettings
  channels: ToolChannel[]
  usage: ToolUsageRow[]
  nextChannelId: number
  nextKeyId: number
}

let state: ToolsMockState | null = null

function toolsEnabled(scenario: MockScenario): boolean {
  return scenario !== 'admin-tools-off'
}

function key(
  id: number,
  last4: string,
  stateValue: ToolChannelKey['state'],
  label: string,
  extra: Partial<ToolChannelKey> = {},
): ToolChannelKey {
  return {
    id,
    label,
    last4,
    state: stateValue,
    cooldownUntil: null,
    cooldownReason: null,
    lastError: null,
    lastErrorAt: null,
    lastUsedAt: iso(20),
    monthCalls: 12,
    createdAt: iso(60 * 24 * 30),
    ...extra,
  }
}

function createState(scenario: MockScenario): ToolsMockState {
  const enabled = toolsEnabled(scenario)

  const channels: ToolChannel[] = [
    {
      id: 1,
      kind: 'tavily',
      name: 'Tavily 免费池',
      baseUrl: 'https://api.tavily.com',
      tools: ['search', 'fetch'],
      priority: 10,
      weight: 2,
      timeoutMs: 30_000,
      proxyUrl: null,
      searchCostMicro: 0,
      fetchCostMicro: 0,
      enabled: true,
      note: '每月免费额度优先走这里',
      keys: [
        key(11, 'a3f9', 'active', '主密钥', { monthCalls: 86, lastUsedAt: iso(4) }),
        // 额度用完：冷却到下个月 1 日 UTC（14 §3.1）
        key(12, '77c1', 'active', '备用（这个月用完了）', {
          cooldownUntil: nextMonthStartUtc(),
          cooldownReason: 'exhausted',
          monthCalls: 0,
          lastError: '上游返回 432（计划额度用完）',
          lastErrorAt: iso(60 * 30),
        }),
      ],
      health: 'ok',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: iso(60 * 24 * 30),
      updatedAt: iso(60 * 24 * 2),
    },
    {
      id: 2,
      kind: 'deepseek',
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1/tools',
      tools: ['search', 'fetch'],
      priority: 0,
      weight: 1,
      timeoutMs: 30_000,
      proxyUrl: null,
      searchCostMicro: 5_000,
      fetchCostMicro: 5_000,
      enabled: true,
      note: 'Tavily 用完时的兜底，按量付费',
      keys: [
        key(21, 'c1d2', 'active', '默认', { monthCalls: 18, lastUsedAt: iso(90) }),
        key(22, '4b7e', 'auto-disabled', '旧密钥', {
          monthCalls: 0,
          lastError: '上游返回 401（密钥无效）',
          lastErrorAt: iso(60 * 20),
        }),
      ],
      health: 'ok',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: iso(60 * 24 * 28),
      updatedAt: iso(60 * 24 * 6),
    },
    {
      // 极端值（WP14b 走查）：长名称 / 长备注 / 没有可用密钥
      id: 3,
      kind: 'tavily',
      name: 'Tavily 家人共用备用线路（限流很严，只有夜里快）',
      baseUrl: 'https://api.tavily.com',
      tools: ['search'],
      priority: -5,
      weight: 1,
      timeoutMs: 60_000,
      proxyUrl: 'http://127.0.0.1:7890',
      searchCostMicro: 0,
      fetchCostMicro: 0,
      enabled: false,
      note: '备用线路：主池限流的时候才会轮到它，密钥是上个月换的那把，别删',
      keys: [],
      health: 'disabled',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: iso(60 * 24 * 5),
      updatedAt: iso(60 * 24 * 5),
    },
  ]

  const settings: ToolSettings = {
    ...DEFAULT_TOOL_SETTINGS,
    enabled,
    deliverToDsh: enabled,
  }

  const mockState: ToolsMockState = {
    scenario,
    settings,
    channels,
    usage: [],
    nextChannelId: 100,
    nextKeyId: 500,
  }
  mockState.usage = buildUsage(mockState, scenario)
  return mockState
}

function buildUsage(mock: ToolsMockState, scenario: MockScenario): ToolUsageRow[] {
  const users = ADMIN_USERS.map((user) => ({ id: user.id, username: user.username }))
  const statuses: ToolUsageStatus[] = ['ok', 'ok', 'ok', 'ok', 'client_error', 'upstream_error', 'rejected']
  const summaries = [
    'DeepSeek V4.1 最新进展',
    'dsh-hub 部署文档',
    'https://api.deepseek.com/v1/tools 的用法',
    '杭州今天天气',
    'https://example.com/very/long/path/for/a/page/that/cannot/be/fetched',
    'Rust 异步运行时对比',
  ]

  const rows: ToolUsageRow[] = []
  for (let index = 0; index < 28; index += 1) {
    const user = users[index % users.length] ?? users[0]!
    const status = statuses[index % statuses.length] ?? 'ok'
    const tool = index % 3 === 0 ? 'fetch' : 'search'
    const free = status === 'ok' && index < 12
    rows.push({
      id: index + 1,
      userId: user.id,
      username: user.username,
      tool,
      status,
      free,
      costMicro: status === 'ok' && !free ? 10_000 : 0,
      channelName: tool === 'search' ? (index % 2 === 0 ? 'Tavily 免费池' : 'DeepSeek 官方') : 'DeepSeek 官方',
      upstreamCostMicro: tool === 'search' ? 0 : 5_000,
      attempts: status === 'upstream_error' ? 3 : 1,
      durationMs: 300 + ((index * 137) % 4200),
      summary: summaries[index % summaries.length] ?? '',
      error:
        status === 'client_error'
          ? '目标页面抓不到（上游返回 404）'
          : status === 'upstream_error'
            ? '所有候选都失败（已尝试 3 个）'
            : status === 'rejected'
              ? '本月免费次数已用完，积分不足'
              : null,
      createdAt: iso(index * 37 + 3),
    })
  }

  // 用户端场景：免费额度用完时把「我」的用量补到 100 次免费
  const me = getMockState().user
  if (scenario === 'tools-exhausted') {
    for (let index = 0; index < 100; index += 1) {
      rows.push({
        id: 1000 + index,
        userId: me.id,
        username: me.username,
        tool: index % 4 === 0 ? 'fetch' : 'search',
        status: 'ok',
        free: true,
        costMicro: 0,
        channelName: 'Tavily 免费池',
        upstreamCostMicro: 0,
        attempts: 1,
        durationMs: 260 + ((index * 31) % 1800),
        summary: `第 ${index + 1} 次搜索`,
        error: null,
        createdAt: iso(index * 11 + 1),
      })
    }
  } else {
    for (let index = 0; index < 5; index += 1) {
      rows.push({
        id: 2000 + index,
        userId: me.id,
        username: me.username,
        tool: index % 2 === 0 ? 'search' : 'fetch',
        status: 'ok',
        free: true,
        costMicro: 0,
        channelName: 'Tavily 免费池',
        upstreamCostMicro: 0,
        attempts: 1,
        durationMs: 300 + index * 90,
        summary: index % 2 === 0 ? 'DSH 是什么' : 'https://example.com/dsh-hub',
        error: null,
        createdAt: iso(index * 53 + 2),
      })
    }
  }

  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

// ── 组装响应 ────────────────────────────────────────────────────────────────

function overviewResponse(mock: ToolsMockState): ToolOverviewResponse {
  const calls = mock.usage.length
  const freeCalls = mock.usage.filter((row) => row.free).length
  const revenueMicro = mock.usage.reduce((sum, row) => sum + row.costMicro, 0)
  const upstreamCostMicro = mock.usage.reduce((sum, row) => sum + (row.upstreamCostMicro ?? 0), 0)

  const byChannelMap = new Map<string, { channelId: number; name: string; kind: 'deepseek' | 'tavily'; calls: number; failures: number; upstreamCostMicro: number }>()
  for (const row of mock.usage) {
    const channel = mock.channels.find((item) => item.name === row.channelName) ?? mock.channels[0]!
    const bucket = byChannelMap.get(channel.name) ?? {
      channelId: channel.id,
      name: channel.name,
      kind: channel.kind,
      calls: 0,
      failures: 0,
      upstreamCostMicro: 0,
    }
    bucket.calls += 1
    if (row.status !== 'ok') bucket.failures += 1
    bucket.upstreamCostMicro += row.upstreamCostMicro ?? 0
    byChannelMap.set(channel.name, bucket)
  }

  const byTool: ToolOverviewResponse['byTool'] = (['search', 'fetch'] as const).map((tool) => {
    const rows = mock.usage.filter((row) => row.tool === tool)
    return {
      tool,
      calls: rows.length,
      revenueMicro: rows.reduce((sum, row) => sum + row.costMicro, 0),
    }
  })

  return {
    month: shanghaiMonth(),
    totals: { calls, freeCalls, revenueMicro, upstreamCostMicro },
    byChannel: [...byChannelMap.values()],
    byTool,
  }
}

function myToolsResponse(mock: ToolsMockState): MyToolsResponse {
  const me = getMockState().user
  const mine = mock.usage.filter((row) => row.userId === me.id)
  const freeUsed =
    mock.scenario === 'tools-exhausted' ? mock.settings.freeCallsPerMonth : mine.filter((row) => row.free).length
  const paid = mine.filter((row) => !row.free)

  return {
    enabled: mock.settings.enabled,
    month: shanghaiMonth(),
    freeCallsPerMonth: mock.settings.freeCallsPerMonth,
    freeUsed,
    searchPriceMicro: mock.settings.searchPriceMicro,
    fetchPriceMicro: mock.settings.fetchPriceMicro,
    monthCalls: mine.length,
    monthCostMicro: paid.reduce((sum, row) => sum + row.costMicro, 0),
    dshAttached: mock.settings.deliverToDsh,
  }
}

function pageOf<T>(items: T[], url: URL): { items: T[]; total: number; page: number; pageSize: number } {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20') || 20))
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize }
}

function usageResponse(
  mock: ToolsMockState,
  url: URL,
  options: { userScoped: boolean },
): { items: ToolUsageRow[]; total: number; page: number; pageSize: number } {
  const me = getMockState().user
  const userId = options.userScoped ? me.id : Number(url.searchParams.get('userId') ?? '') || undefined
  const tool = url.searchParams.get('tool')
  const status = url.searchParams.get('status')

  const rows = mock.usage
    .filter((row) => (options.userScoped ? row.userId === me.id : userId ? row.userId === userId : true))
    .filter((row) => (tool ? row.tool === tool : true))
    .filter((row) => (status ? row.status === status : true))
    .map((row) => (options.userScoped ? { ...row, channelName: null, upstreamCostMicro: null } : row))

  return pageOf(rows, url)
}

// ── 用户端接口 ──────────────────────────────────────────────────────────────

/** `GET /api/me/tools`、`/api/me/tools/usage`；未命中返回 null。 */
export async function handleUserTools(
  pathname: string,
  method: string,
  url: URL,
): Promise<Response | null> {
  if (!pathname.startsWith('/api/me/tools')) return null
  const mock = toolsState()

  if (pathname === '/api/me/tools' && method === 'GET') return json(myToolsResponse(mock))
  if (pathname === '/api/me/tools/usage' && method === 'GET') {
    return json(usageResponse(mock, url, { userScoped: true }))
  }

  return null
}

// ── 管理端接口 ──────────────────────────────────────────────────────────────

/** 管理端假接口（`?mock=admin*`）。命中返回 `Response`，未命中返回 `null`。 */
export async function handleAdminTools(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Promise<Response | null> {
  if (!pathname.startsWith('/api/admin/tools')) return null
  const mock = toolsState()

  if (pathname === '/api/admin/tools/settings') {
    const payload = {
      settings: mock.settings,
      internalBaseUrl: mock.settings.enabled ? 'http://10.213.0.1:7710/v1/tools' : null,
      publicBaseUrl: 'https://hub.example.com:8123/v1/tools',
    }
    if (method === 'GET') return json(payload)
    if (method === 'PATCH') {
      const body = readJson(init)
      mock.settings = { ...mock.settings, ...(body as Partial<ToolSettings>) }
      return json({ ...payload, settings: mock.settings })
    }
  }

  if (pathname === '/api/admin/tools/overview' && method === 'GET') return json(overviewResponse(mock))

  if (pathname === '/api/admin/tools/channels' && method === 'GET') return json(mock.channels)

  if (pathname === '/api/admin/tools/channels' && method === 'POST') {
    const body = readJson(init)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return apiError('VALIDATION_FAILED', 400, '渠道名称不能为空')
    if (mock.channels.some((channel) => channel.name === name))
      return apiError('CONFLICT', 409, '已有同名渠道')
    const kind = body.kind === 'deepseek' ? 'deepseek' : 'tavily'
    const keys = Array.isArray(body.keys) ? (body.keys as string[]) : []
    const channel: ToolChannel = {
      id: mock.nextChannelId++,
      kind,
      name,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : kind === 'deepseek' ? 'https://api.deepseek.com/v1/tools' : 'https://api.tavily.com',
      tools: Array.isArray(body.tools) && body.tools.length > 0 ? (body.tools as ToolChannel['tools']) : ['search', 'fetch'],
      priority: typeof body.priority === 'number' ? body.priority : 0,
      weight: typeof body.weight === 'number' ? body.weight : 1,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 30_000,
      proxyUrl: typeof body.proxyUrl === 'string' && body.proxyUrl ? body.proxyUrl : null,
      searchCostMicro: typeof body.searchCostMicro === 'number' ? body.searchCostMicro : 0,
      fetchCostMicro: typeof body.fetchCostMicro === 'number' ? body.fetchCostMicro : 0,
      enabled: body.enabled !== false,
      note: typeof body.note === 'string' ? body.note : '',
      keys: keys.map((secret) =>
        key(mock.nextKeyId++, secret.slice(-4), 'active', '', { monthCalls: 0, lastUsedAt: null, createdAt: new Date().toISOString() }),
      ),
      health: 'ok',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    channel.health = healthOf(channel)
    mock.channels = [...mock.channels, channel]
    return json({ channel }, 201)
  }

  const channelMatch = /^\/api\/admin\/tools\/channels\/(\d+)$/.exec(pathname)
  if (channelMatch) {
    const channelId = Number(channelMatch[1])
    const channel = mock.channels.find((item) => item.id === channelId)
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')

    if (method === 'PATCH') {
      const body = readJson(init)
      if (typeof body.name === 'string' && body.name.trim()) channel.name = body.name.trim()
      if (typeof body.baseUrl === 'string') channel.baseUrl = body.baseUrl
      if (Array.isArray(body.tools) && body.tools.length > 0) channel.tools = body.tools as ToolChannel['tools']
      for (const field of ['priority', 'weight', 'timeoutMs', 'searchCostMicro', 'fetchCostMicro'] as const) {
        if (typeof body[field] === 'number') channel[field] = body[field] as number
      }
      if ('proxyUrl' in body) channel.proxyUrl = (body.proxyUrl as string | null) ?? null
      if (typeof body.enabled === 'boolean') channel.enabled = body.enabled
      if (typeof body.note === 'string') channel.note = body.note
      channel.updatedAt = new Date().toISOString()
      channel.health = healthOf(channel)
      return json({ channel })
    }

    if (method === 'DELETE') {
      mock.channels = mock.channels.filter((item) => item.id !== channelId)
      return noContent()
    }
  }

  const testMatch = /^\/api\/admin\/tools\/channels\/(\d+)\/test$/.exec(pathname)
  if (testMatch && method === 'POST') {
    const channel = mock.channels.find((item) => item.id === Number(testMatch[1]))
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')
    const usable = channel.keys.some((item) => item.state === 'active')
    const result: TestToolChannelResponse = usable
      ? { ok: true, durationMs: 320, results: 1, error: null }
      : { ok: false, durationMs: 180, results: null, error: '没有可用密钥' }
    return json(result)
  }

  const keysMatch = /^\/api\/admin\/tools\/channels\/(\d+)\/keys$/.exec(pathname)
  if (keysMatch && method === 'POST') {
    const channel = mock.channels.find((item) => item.id === Number(keysMatch[1]))
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')
    const body = readJson(init)
    const list = Array.isArray(body.keys) ? (body.keys as string[]).map((item) => item.trim()).filter(Boolean) : []
    if (list.length === 0) return apiError('VALIDATION_FAILED', 400, '至少要填一把密钥')

    let added = 0
    let skipped = 0
    for (const secret of list) {
      const last4 = secret.slice(-4)
      if (channel.keys.some((item) => item.last4 === last4)) {
        skipped += 1
        continue
      }
      channel.keys = [
        ...channel.keys,
        key(mock.nextKeyId++, last4, 'active', typeof body.label === 'string' ? body.label : '', {
          monthCalls: 0,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
        }),
      ]
      added += 1
    }
    channel.health = healthOf(channel)
    channel.updatedAt = new Date().toISOString()
    return json({ channel, added, skipped }, 201)
  }

  const keyMatch = /^\/api\/admin\/tools\/channels\/(\d+)\/keys\/(\d+)$/.exec(pathname)
  if (keyMatch) {
    const channel = mock.channels.find((item) => item.id === Number(keyMatch[1]))
    const item = channel?.keys.find((entry) => entry.id === Number(keyMatch[2]))
    if (!channel || !item) return apiError('NOT_FOUND', 404, '密钥不存在')

    if (method === 'PATCH') {
      const body = readJson(init)
      if (typeof body.label === 'string') item.label = body.label
      if (body.resetCooldown === true || body.state === 'active') {
        item.state = 'active'
        item.cooldownUntil = null
        item.cooldownReason = null
        item.lastError = null
        item.lastErrorAt = null
      }
      if (body.state === 'disabled') item.state = 'disabled'
      channel.health = healthOf(channel)
      channel.updatedAt = new Date().toISOString()
      return json({ channel })
    }

    if (method === 'DELETE') {
      channel.keys = channel.keys.filter((entry) => entry.id !== item.id)
      channel.health = healthOf(channel)
      channel.updatedAt = new Date().toISOString()
      return json({ channel })
    }
  }

  if (pathname === '/api/admin/tools/usage' && method === 'GET') {
    return json(usageResponse(mock, url, { userScoped: false }))
  }

  return null
}

function healthOf(channel: Pick<ToolChannel, 'enabled' | 'keys' | 'cooldownUntil'>): ToolChannel['health'] {
  if (!channel.enabled) return 'disabled'
  if (channel.cooldownUntil && Date.parse(channel.cooldownUntil) > Date.now()) return 'cooling'
  if (!channel.keys.some((item) => item.state === 'active')) return 'no-key'
  return 'ok'
}

/** 取（必要时重建）假状态；场景变了就重置。 */
export function toolsState(): ToolsMockState {
  const scenario = getMockState().scenario
  if (!state || state.scenario !== scenario) {
    state = createState(scenario)
  }
  return state
}

/** 给测试用：同一场景里回到初始假数据。 */
export function resetToolsMock(): void {
  state = null
}
