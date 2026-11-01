import type {
  AgentModePlugin,
  AgentModeSettings,
  AgentModeStateResponse,
  AgentModeUser,
  AddRelayChannelKeysResponse,
  DiscoverRelayChannelResponse,
  JobStatus,
  ModelApi,
  MyAgentMode,
  MyRelayModel,
  RelayAgentMode,
  RelayChannel,
  RelayChannelKey,
  RelayModel,
  RelayPrice,
  RelayRoute,
  RelayRouteInput,
  RelayScope,
  RelayUsageRow,
  TestRelayChannelResponse,
} from '@dsh-hub/shared'
import {
  AGENT_MODE_API,
  AGENT_MODE_LABEL,
  AGENT_MODE_PLUGIN_PACKAGE,
  DEFAULT_AGENT_MODE_SETTINGS,
  RelayAgentModeSchema,
} from '@dsh-hub/shared'

import { ADMIN_USERS, isAdminScenario } from './admin'
import { createMockRolloutJob, mockJobDetail } from './jobs'
import { getMockState, type MockScenario } from './state'

/**
 * Claude Code / Codex 管理（18）的假数据与假接口（**仅开发环境**）。
 *
 * - `?mock=admin` / `?mock=agent-modes`：两个模式按 18 §6 的走查场景造数据
 *   （Claude Code 已开通 ×1.5、指定 3 个用户、2 条渠道、3 个模型、待下发、一条 warning；
 *   Codex 未开通、插件库里没有、0 渠道 0 模型）；
 * - 其它用户端场景：两个模式都开通（×1.5 / ×1.0）并各有渠道与模型，
 *   这样「积分与用量」能同时看到两个模式与按来源的用量。
 *
 * 渠道 / 模型沿用 `/api/admin/relay/channels|models`，只在自己的作用域里出现；
 * 用量记录交给 `mocks/relay.ts` 合并（`mockAgentModeUsageRows()`），保证「全部来源」的合计一致。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
const noContent = (): Response => new Response(null, { status: 204 })
const apiError = (
  code: string,
  status: number,
  message: string,
  details: Record<string, unknown> = {},
): Response => json({ error: { code, message, details } }, status)

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

const NOW = Date.now()
const MINUTE = 60_000
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * MINUTE).toISOString()
const SHANGHAI_OFFSET_MS = 8 * 3600_000
const shanghaiDay = (offsetDays = 0): string =>
  new Date(NOW + SHANGHAI_OFFSET_MS - offsetDays * 86_400_000).toISOString().slice(0, 10)
const monthStart = (): string => `${shanghaiDay().slice(0, 7)}-01`

const AGENT_MODES = RelayAgentModeSchema.options as RelayAgentMode[]

interface AgentModeMockState {
  scenario: MockScenario
  settings: Record<RelayAgentMode, AgentModeSettings>
  channels: RelayChannel[]
  models: RelayModel[]
  rows: Record<RelayAgentMode, AgentModeUser[]>
  /** 容器 env 里还有这个模式变量的用户（targets 移出后仍要下发一次去掉） */
  envUserIds: Record<RelayAgentMode, number[]>
  plugins: Record<RelayAgentMode, AgentModePlugin | null>
  /** enabled / targets 改过、还没下发 */
  pendingChange: Record<RelayAgentMode, boolean>
  /** 最近一次下发任务（id / 状态 / 创建时间；任务本身在 mocks/jobs.ts） */
  lastDeliver: Record<RelayAgentMode, number | null>
  lastDeliverStatus: Record<RelayAgentMode, JobStatus>
  lastDeliverAt: Record<RelayAgentMode, string | null>
  extraWarnings: Record<RelayAgentMode, string[]>
  usage: RelayUsageRow[]
  nextChannelId: number
  nextChannelKeyId: number
  nextModelId: number
  nextRouteId: number
  nextUsageId: number
}

let state: AgentModeMockState | null = null

// ── 种子数据 ────────────────────────────────────────────────────────────────

const PRICE_SONNET: RelayPrice = {
  inputMicro: 3_000_000,
  outputMicro: 15_000_000,
  cacheReadMicro: 300_000,
  cacheWriteMicro: 3_750_000,
  perRequestMicro: 0,
}

const PRICE_OPUS: RelayPrice = {
  inputMicro: 15_000_000,
  outputMicro: 75_000_000,
  cacheReadMicro: 1_500_000,
  cacheWriteMicro: 18_750_000,
  perRequestMicro: 0,
}

const PRICE_CODEX: RelayPrice = {
  inputMicro: 1_250_000,
  outputMicro: 10_000_000,
  cacheReadMicro: 125_000,
  cacheWriteMicro: null,
  perRequestMicro: 0,
}

const PRICE_CODEX_MINI: RelayPrice = {
  inputMicro: 250_000,
  outputMicro: 2_000_000,
  cacheReadMicro: 25_000,
  cacheWriteMicro: null,
  perRequestMicro: 0,
}

const PRICE_UNPRICED: RelayPrice = {
  inputMicro: 0,
  outputMicro: 0,
  cacheReadMicro: null,
  cacheWriteMicro: null,
  perRequestMicro: 0,
}

/** 渠道密钥（只给界面看的末 4 位与健康状态） */
function channelKey(id: number, last4: string, label = '主密钥'): RelayChannelKey {
  return {
    id,
    label,
    last4,
    state: 'active',
    cooldownUntil: null,
    lastUsedAt: iso(30),
    lastError: null,
    lastErrorAt: null,
    createdAt: iso(60 * 24 * 12),
  }
}

function makeChannel(input: {
  id: number
  name: string
  slug: string
  baseUrl: string
  apis: ModelApi[]
  ratePermille?: number
  scope: RelayAgentMode
  note?: string
  keys: RelayChannelKey[]
}): RelayChannel {
  return {
    id: input.id,
    name: input.name,
    slug: input.slug,
    baseUrl: input.baseUrl,
    apis: input.apis,
    ratePermille: input.ratePermille ?? 1000,
    priority: 0,
    weight: 1,
    maxConcurrency: 10,
    timeoutMs: 600_000,
    proxyUrl: null,
    headers: null,
    streamUsage: true,
    enabled: true,
    note: input.note ?? '',
    keys: input.keys,
    health: 'ok',
    failStreak: 0,
    cooldownUntil: null,
    lastError: null,
    lastErrorAt: null,
    inFlight: 0,
    modelCount: 0,
    scope: input.scope,
    createdAt: iso(60 * 24 * 12),
    updatedAt: iso(60 * 24),
  }
}

interface RouteSeed {
  id: number
  channel: RelayChannel
  upstreamModel?: string
}

function makeRoute(seed: RouteSeed): RelayRoute {
  return {
    id: seed.id,
    channelId: seed.channel.id,
    channelName: seed.channel.name,
    channelSlug: seed.channel.slug ?? undefined,
    channelRatePermille: seed.channel.ratePermille,
    upstreamModel: seed.upstreamModel ?? '',
    priority: null,
    weight: null,
    enabled: true,
  }
}

function makeModel(input: {
  id: number
  name: string
  displayName: string
  scope: RelayAgentMode
  price: RelayPrice
  routes: RelayRoute[]
  info?: RelayModel['info']
  enabled?: boolean
}): RelayModel {
  const apis =
    input.routes.length > 0 ? [...new Set(input.routes.map(() => AGENT_MODE_API[input.scope]))] : []
  return {
    id: input.id,
    name: input.name,
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    visibility: 'all',
    price: input.price,
    info: input.info ?? {},
    compat: null,
    defaultThinking: null,
    routes: input.routes,
    apis: apis as RelayModel['apis'],
    sort: input.id,
    scope: input.scope,
    createdAt: iso(60 * 24 * 10),
    updatedAt: iso(60 * 24),
  }
}

const CLAUDE_INFO: RelayModel['info'] = {
  contextWindow: 200_000,
  maxTokens: 64_000,
  input: ['text', 'image'],
  reasoningEfforts: ['low', 'medium', 'high'],
}

const CODEX_INFO: RelayModel['info'] = {
  contextWindow: 400_000,
  maxTokens: 128_000,
  input: ['text', 'image'],
  reasoningEfforts: ['low', 'medium', 'high'],
}

/** 用户表里需要的资料：管理端假用户 + 当前用户（用户端场景的 id 12） */
function userProfile(userId: number): {
  username: string
  displayName: string | null
  instanceStatus: string
} {
  const current = getMockState().user
  if (current.id === userId) {
    return {
      username: current.username,
      displayName: current.displayName,
      instanceStatus: getMockState().status,
    }
  }
  const adminUser = ADMIN_USERS.find((user) => user.id === userId)
  return {
    username: adminUser?.username ?? `user${userId}`,
    displayName: adminUser?.displayName ?? null,
    instanceStatus: adminUser?.instance.status ?? 'stopped',
  }
}

function seedUserRow(
  userId: number,
  input: Partial<AgentModeUser> & { monthCostMicro: number },
): AgentModeUser {
  const profile = userProfile(userId)
  return {
    userId,
    username: profile.username,
    displayName: profile.displayName,
    targeted: true,
    pluginVersion: null,
    instanceStatus: profile.instanceStatus,
    envApplied: null,
    ...input,
  }
}

/** 用量种子：近 30 天，每个模式几种模型、几个用户（覆盖「按来源」与用户表的本月花费） */
function seedUsage(
  mock: Pick<AgentModeMockState, 'channels' | 'models'>,
  mode: RelayAgentMode,
  userIds: number[],
): RelayUsageRow[] {
  const models = mock.models.filter(
    (model) => model.scope === mode && model.price.inputMicro > 0 && model.routes.length > 0,
  )
  if (models.length === 0) return []
  const rows: RelayUsageRow[] = []
  let id = mode === 'claude-code' ? 9000 : 9500
  const api: ModelApi = AGENT_MODE_API[mode]

  for (let day = 29; day >= 0; day -= 1) {
    if ((day + models.length) % 3 === 0) continue
    for (const [index, userId] of userIds.entries()) {
      const model = models[(day + index) % models.length]!
      const route = model.routes[(day + index) % model.routes.length]
      const channelId = route?.channelId ?? 0
      const channel = mock.channels.find((item) => item.id === channelId)
      const inputTokens = 4_000 + ((day * 977 + index * 311) % 22_000)
      const outputTokens = 600 + ((day * 233 + index * 97) % 4_000)
      const cacheReadTokens = Math.round(inputTokens * 0.4)
      const base =
        (inputTokens * model.price.inputMicro +
          outputTokens * model.price.outputMicro +
          cacheReadTokens * (model.price.cacheReadMicro ?? model.price.inputMicro)) /
        1_000_000
      const channelPermille = channel?.ratePermille ?? 1000
      const modePermille = mode === 'claude-code' ? 1500 : 1000
      const costMicro = Math.max(1, Math.round((base * channelPermille * modePermille) / (1000 * 1000)))
      rows.push({
        id: id++,
        requestId: `req_${mode}_${String(id).padStart(4, '0')}`,
        userId,
        username: userProfile(userId).username,
        keyId: null,
        keyName: null,
        model: model.name,
        baseModel: model.name,
        upstreamModel: model.name,
        channelId,
        channelName: channel?.name ?? null,
        channelSlug: channel?.slug ?? null,
        channelRatePermille: channel?.ratePermille ?? null,
        api,
        stream: true,
        source: 'internal',
        pinned: false,
        status: 'ok',
        httpStatus: 200,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costMicro,
        estimated: false,
        attempts: 1,
        durationMs: 900 + ((day * 37) % 2_600),
        ttftMs: 300 + ((day * 13) % 700),
        createdAt: new Date(
          Date.parse(`${shanghaiDay(day)}T04:00:00.000Z`) + (index + 1) * 37 * MINUTE,
        ).toISOString(),
        error: null,
        scope: mode,
        modeRatePermille: modePermille,
      })
    }
  }
  return rows
}

function createState(scenario: MockScenario): AgentModeMockState {
  const admin = isAdminScenario(scenario)
  const channels: RelayChannel[] = [
    makeChannel({
      id: 101,
      name: 'Anthropic 官方',
      slug: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apis: ['anthropic-messages'],
      ratePermille: 1000,
      scope: 'claude-code',
      note: '官方直连，按官方价',
      keys: [channelKey(2101, 'a3f9'), channelKey(2102, '7b2d', '备用密钥')],
    }),
    makeChannel({
      id: 102,
      name: 'Claude 中转池',
      slug: 'claude-pool',
      baseUrl: 'https://claude.example.com/v1',
      apis: ['anthropic-messages'],
      ratePermille: 1200,
      scope: 'claude-code',
      note: '第三方兼容中转，×1.2',
      keys: [channelKey(2103, '1c4e')],
    }),
  ]

  const models: RelayModel[] = [
    makeModel({
      id: 51,
      name: 'claude-sonnet-5-5',
      displayName: 'Claude Sonnet 5.5',
      scope: 'claude-code',
      price: PRICE_SONNET,
      info: CLAUDE_INFO,
      routes: [
        makeRoute({ id: 5001, channel: channels[0]!, upstreamModel: 'claude-sonnet-5-5' }),
        makeRoute({ id: 5002, channel: channels[1]!, upstreamModel: 'claude-sonnet-5-5-20261001' }),
      ],
    }),
    makeModel({
      id: 52,
      name: 'claude-haiku-5-5',
      displayName: 'Claude Haiku 5.5',
      scope: 'claude-code',
      price: PRICE_UNPRICED,
      info: { ...CLAUDE_INFO, contextWindow: 200_000, maxTokens: 32_000 },
      routes: [makeRoute({ id: 5003, channel: channels[0]!, upstreamModel: 'claude-haiku-5-5' })],
    }),
    makeModel({
      // 没路由：默认模型下拉里禁用，并在选项里标原因
      id: 53,
      name: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      scope: 'claude-code',
      price: PRICE_OPUS,
      info: { ...CLAUDE_INFO, contextWindow: 200_000, maxTokens: 64_000 },
      routes: [],
    }),
  ]

  if (!admin) {
    // 用户端场景：Codex 也要有模型，才能看到两个模式的模型小节与按来源用量
    const codexChannel = makeChannel({
      id: 103,
      name: 'OpenAI 官方',
      slug: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apis: ['openai-responses'],
      ratePermille: 1000,
      scope: 'codex',
      note: '官方直连',
      keys: [channelKey(2104, '9d3b')],
    })
    channels.push(
      codexChannel,
      makeChannel({
        id: 104,
        name: 'Codex 中转池',
        slug: 'codex-pool',
        baseUrl: 'https://codex.example.com/v1',
        apis: ['openai-responses'],
        ratePermille: 800,
        scope: 'codex',
        note: '便宜线路，×0.8',
        keys: [channelKey(2105, '5e8a')],
      }),
    )
    models.push(
      makeModel({
        id: 61,
        name: 'gpt-5.1-codex',
        displayName: 'GPT-5.1 Codex',
        scope: 'codex',
        price: PRICE_CODEX,
        info: CODEX_INFO,
        routes: [
          makeRoute({ id: 5101, channel: codexChannel, upstreamModel: 'gpt-5.1-codex' }),
          makeRoute({ id: 5102, channel: channels[3]!, upstreamModel: 'gpt-5.1-codex' }),
        ],
      }),
      makeModel({
        id: 62,
        name: 'gpt-5.1-codex-mini',
        displayName: 'GPT-5.1 Codex mini',
        scope: 'codex',
        price: PRICE_CODEX_MINI,
        info: { ...CODEX_INFO, maxTokens: 32_000 },
        routes: [makeRoute({ id: 5103, channel: codexChannel, upstreamModel: 'gpt-5.1-codex-mini' })],
      }),
    )
  }

  for (const channel of channels) {
    channel.modelCount = models.filter((model) =>
      model.routes.some((route) => route.channelId === channel.id),
    ).length
  }

  const claudeSettings: AgentModeSettings = {
    ...DEFAULT_AGENT_MODE_SETTINGS,
    enabled: true,
    ratePermille: 1500,
    defaultModelId: 51,
    smallModelId: 52,
    label: 'DSH Hub',
    targets: admin ? { userIds: [2, 4, 5] } : { all: true },
    updatedAt: iso(60 * 6),
    targetsUpdatedAt: iso(60 * 26),
  }
  const codexSettings: AgentModeSettings = {
    ...DEFAULT_AGENT_MODE_SETTINGS,
    enabled: !admin,
    ratePermille: 1000,
    defaultModelId: admin ? null : 61,
    smallModelId: null,
    label: 'DSH Hub',
    targets: admin ? { userIds: [] } : { all: true },
    updatedAt: admin ? null : iso(60 * 30),
    targetsUpdatedAt: admin ? null : iso(60 * 30),
  }

  const usage = [...seedUsage({ channels, models }, 'claude-code', admin ? [2, 4, 5] : [12])]
  if (!admin) usage.push(...seedUsage({ channels, models }, 'codex', [12]))

  const monthUsage = (userId: number, mode: RelayAgentMode): number =>
    usage
      .filter(
        (row) => row.userId === userId && row.scope === mode && row.createdAt.slice(0, 10) >= monthStart(),
      )
      .reduce((sum, row) => sum + row.costMicro, 0)

  const rows: Record<RelayAgentMode, AgentModeUser[]> = {
    'claude-code': admin
      ? [
          // 已装最新版、实例运行中、env 已生效
          seedUserRow(2, {
            pluginVersion: '0.4.0',
            instanceStatus: 'running',
            envApplied: true,
            monthCostMicro: monthUsage(2, 'claude-code'),
          }),
          // 没装插件、实例停着
          seedUserRow(4, {
            pluginVersion: null,
            instanceStatus: 'stopped',
            envApplied: null,
            monthCostMicro: monthUsage(4, 'claude-code'),
          }),
          // 旧版插件、运行中、env 待下发
          seedUserRow(5, {
            pluginVersion: '0.3.8',
            instanceStatus: 'running',
            envApplied: false,
            monthCostMicro: monthUsage(5, 'claude-code'),
          }),
          // 已移出，但运行中的容器 env 里还有这个模式
          seedUserRow(6, {
            targeted: false,
            pluginVersion: '0.4.0',
            instanceStatus: 'running',
            envApplied: false,
            monthCostMicro: monthUsage(6, 'claude-code'),
          }),
        ]
      : [
          seedUserRow(getMockState().user.id, {
            pluginVersion: '0.4.0',
            instanceStatus: getMockState().status,
            envApplied: true,
            monthCostMicro: monthUsage(getMockState().user.id, 'claude-code'),
          }),
        ],
    codex: admin
      ? []
      : [
          seedUserRow(getMockState().user.id, {
            pluginVersion: '0.2.0',
            instanceStatus: getMockState().status,
            envApplied: true,
            monthCostMicro: monthUsage(getMockState().user.id, 'codex'),
          }),
        ],
  }

  return {
    scenario,
    settings: { 'claude-code': claudeSettings, codex: codexSettings },
    channels,
    models,
    rows,
    envUserIds: {
      'claude-code': admin ? [2, 4, 5, 6] : [getMockState().user.id],
      codex: admin ? [] : [getMockState().user.id],
    },
    plugins: {
      'claude-code': admin
        ? {
            pluginId: 7,
            packageName: AGENT_MODE_PLUGIN_PACKAGE['claude-code'],
            latestVersion: '0.4.0',
            policy: 'optional',
            installedUsers: 2,
          }
        : {
            pluginId: 7,
            packageName: AGENT_MODE_PLUGIN_PACKAGE['claude-code'],
            latestVersion: '0.4.0',
            policy: 'optional',
            installedUsers: 3,
          },
      codex: admin
        ? null
        : {
            pluginId: 8,
            packageName: AGENT_MODE_PLUGIN_PACKAGE.codex,
            latestVersion: '0.2.0',
            policy: 'optional',
            installedUsers: 2,
          },
    },
    pendingChange: { 'claude-code': admin, codex: false },
    // 最近一次下发是成功的旧任务（任务列表里的夹具 #1041）
    lastDeliver: admin ? { 'claude-code': 1041, codex: null } : { 'claude-code': null, codex: null },
    lastDeliverStatus: { 'claude-code': 'succeeded', codex: 'succeeded' },
    lastDeliverAt: admin ? { 'claude-code': iso(45), codex: null } : { 'claude-code': null, codex: null },
    extraWarnings: {
      'claude-code': admin ? ['内部监听器没有监听，用户容器暂时连不上中转站'] : [],
      codex: [],
    },
    usage,
    nextChannelId: 105,
    nextChannelKeyId: 2106,
    nextModelId: 70,
    nextRouteId: 5200,
    nextUsageId: 9700,
  }
}

function mockState(): AgentModeMockState {
  const scenario = getMockState().scenario
  state ??= createState(scenario)
  return state
}

/** 测试与场景切换用：丢掉内存状态（下一次请求按当前场景重建）。 */
export function resetAgentModeMock(): void {
  state = null
}

// ── 计算 ────────────────────────────────────────────────────────────────────

function scopeChannels(mock: AgentModeMockState, scope: RelayScope): RelayChannel[] {
  return mock.channels.filter((channel) => (channel.scope ?? 'dsh') === scope)
}

function scopeModels(mock: AgentModeMockState, scope: RelayScope): RelayModel[] {
  return mock.models.filter((model) => (model.scope ?? 'dsh') === scope)
}

function modelScopedRoutes(
  mock: AgentModeMockState,
  model: RelayModel,
): { route: RelayRoute; channel: RelayChannel }[] {
  return model.routes
    .map((route) => ({ route, channel: mock.channels.find((item) => item.id === route.channelId) }))
    .filter((entry): entry is { route: RelayRoute; channel: RelayChannel } => entry.channel !== undefined)
}

/** 有启用渠道上的启用路由 = 可路由（默认模型下拉用） */
function isRoutable(mock: AgentModeMockState, model: RelayModel): boolean {
  return (
    model.enabled &&
    modelScopedRoutes(mock, model).some((entry) => entry.channel.enabled && entry.route.enabled)
  )
}

/** 「默认模型」下拉的兜底：设置里的模型还能用就用它，否则按 sort/name 取第一个可用模型（18 §2） */
function effectiveModel(
  mock: AgentModeMockState,
  scope: RelayAgentMode,
  preferredId: number | null,
): string | null {
  const models = scopeModels(mock, scope)
  const preferred = models.find((model) => model.id === preferredId)
  if (preferred && isRoutable(mock, preferred)) return preferred.name
  const fallback = models
    .filter((model) => isRoutable(mock, model))
    .sort((left, right) => left.sort - right.sort || left.name.localeCompare(right.name))[0]
  return fallback?.name ?? null
}

function pluginOf(mock: AgentModeMockState, mode: RelayAgentMode): AgentModePlugin | null {
  return mock.plugins[mode]
}

/** 每行用户 + 待下发统计（18 §4.3） */
function usersOf(mock: AgentModeMockState, mode: RelayAgentMode): AgentModeUser[] {
  const rows = mock.rows[mode]
  const envUsers = mock.envUserIds[mode]
  const known = new Set(rows.map((row) => row.userId))
  const extras: AgentModeUser[] = envUsers
    .filter((userId) => !known.has(userId))
    .map((userId) => seedUserRow(userId, { targeted: false, monthCostMicro: 0 }))
  return [...rows, ...extras].sort((left, right) => {
    if (left.targeted !== right.targeted) return left.targeted ? -1 : 1
    return left.userId - right.userId
  })
}

function pendingOf(
  mock: AgentModeMockState,
  mode: RelayAgentMode,
): { pending: boolean; pendingUsers: number } {
  const users = usersOf(mock, mode)
  const changed = mock.pendingChange[mode]
  const notApplied = users.filter((user) => user.envApplied === false).length
  const pendingUsers = notApplied + (changed ? users.filter((user) => user.targeted).length : 0)
  return { pending: changed || notApplied > 0, pendingUsers }
}

function warningsOf(mock: AgentModeMockState, mode: RelayAgentMode): string[] {
  const settings = mock.settings[mode]
  const models = scopeModels(mock, mode)
  const warnings = [...mock.extraWarnings[mode]]
  // 插件库里没有这个插件时，「插件」卡已经说得清楚，这里不重复一条 warning（07 §2.7）
  if (models.length === 0) warnings.push('还没有任何模型，用户那边选不到模型')
  else if (!models.some((model) => isRoutable(mock, model)))
    warnings.push('没有可路由的模型，默认模型会给不出来')

  const preferred = models.find((model) => model.id === settings.defaultModelId)
  const effective = effectiveModel(mock, mode, settings.defaultModelId)
  if (settings.defaultModelId !== null && preferred && !isRoutable(mock, preferred) && effective) {
    warnings.push(`默认模型 ${preferred.name} 当前不能路由，实际使用 ${effective}`)
  }
  if (mode === 'claude-code' && settings.smallModelId !== null) {
    const small = models.find((model) => model.id === settings.smallModelId)
    if (!small) warnings.push('设置的小模型已经不存在，后台小任务改用默认模型')
  }
  return warnings
}

function stateResponse(mock: AgentModeMockState, mode: RelayAgentMode): AgentModeStateResponse {
  const settings = mock.settings[mode]
  const models = scopeModels(mock, mode)
  const users = usersOf(mock, mode)
  const pending = pendingOf(mock, mode)
  const jobId = mock.lastDeliver[mode]
  const detail = jobId === null ? null : mockJobDetail(jobId)
  const status: JobStatus = detail?.job.status ?? mock.lastDeliverStatus[mode] ?? 'succeeded'

  return {
    mode,
    settings,
    effectiveDefaultModel: effectiveModel(mock, mode, settings.defaultModelId),
    effectiveSmallModel: mode === 'claude-code' ? effectiveModel(mock, mode, settings.smallModelId) : null,
    plugin: pluginOf(mock, mode),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      displayName: model.displayName,
      enabled: model.enabled,
      routable: isRoutable(mock, model),
    })),
    users,
    pending: pending.pending,
    pendingUsers: pending.pendingUsers,
    lastDeliver:
      jobId === null
        ? null
        : {
            jobId,
            status,
            createdAt: mock.lastDeliverAt[mode] ?? iso(45),
          },
    warnings: warningsOf(mock, mode),
  }
}

// ── 路由 / 模型 / 渠道的小工具 ──────────────────────────────────────────────

function refreshModelApi(model: RelayModel, scope: RelayAgentMode): void {
  model.apis = model.routes.length > 0 ? [AGENT_MODE_API[scope]] : []
}

function routeInputs(model: RelayModel, inputs: RelayRouteInput[]): RelayRoute[] {
  return inputs.map((input) => {
    const channel = mockState().channels.find((item) => item.id === input.channelId)
    return {
      id: mockState().nextRouteId++,
      channelId: input.channelId,
      channelName: channel?.name ?? `#${input.channelId}`,
      channelSlug: channel?.slug ?? undefined,
      channelRatePermille: channel?.ratePermille ?? 1000,
      upstreamModel: input.upstreamModel ?? model.name,
      priority: input.priority ?? null,
      weight: input.weight ?? null,
      enabled: input.enabled,
    }
  })
}

function uniqueSlug(mock: AgentModeMockState, base: string): string {
  const taken = new Set(mock.channels.map((channel) => channel.slug))
  let candidate = base || 'channel'
  let index = 2
  while (taken.has(candidate)) {
    candidate = `${base}-${index++}`.slice(0, 24)
  }
  return candidate
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

function discoverList(scope: RelayAgentMode): DiscoverRelayChannelResponse['models'] {
  const list: Array<{ id: string; name: string; info: RelayModel['info'] }> =
    scope === 'claude-code'
      ? [
          {
            id: 'claude-sonnet-5-5',
            name: 'Claude Sonnet 5.5',
            info: { ...CLAUDE_INFO },
          },
          {
            id: 'claude-haiku-5-5',
            name: 'Claude Haiku 5.5',
            info: { ...CLAUDE_INFO, maxTokens: 32_000 },
          },
          {
            id: 'claude-opus-5-5',
            name: 'Claude Opus 5.5',
            info: { ...CLAUDE_INFO },
          },
          { id: 'claude-3-7-legacy', name: 'Claude 3.7（旧）', info: { contextWindow: 200_000 } },
        ]
      : [
          { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', info: { ...CODEX_INFO } },
          {
            id: 'gpt-5.1-codex-mini',
            name: 'GPT-5.1 Codex mini',
            info: { ...CODEX_INFO, maxTokens: 32_000 },
          },
          { id: 'gpt-5.1', name: 'GPT-5.1', info: { ...CODEX_INFO } },
        ]

  return list.map((item) => ({
    id: item.id,
    name: item.name,
    ...item.info,
    infoSource: 'builtin',
    matchedId: item.id,
    existingModelId: mockState().models.find((model) => model.name === item.id)?.id ?? null,
  }))
}

// ── 管理员接口 ──────────────────────────────────────────────────────────────

function isMineChannel(mock: AgentModeMockState, id: number): RelayChannel | null {
  return mock.channels.find((channel) => channel.id === id) ?? null
}

/** 这些请求归本模块处理（其余中转站请求交给 `mocks/relay.ts`） */
function claimsRequest(
  mock: AgentModeMockState,
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): boolean {
  if (pathname.startsWith('/api/admin/agent-modes/')) return true

  const scopeParam = url.searchParams.get('scope')
  if (pathname === '/api/admin/relay/channels' || pathname === '/api/admin/relay/models') {
    if (method === 'GET') return scopeParam !== null && scopeParam !== 'dsh'
    const scope = readJson(init)['scope']
    return typeof scope === 'string' && scope !== 'dsh'
  }

  const channelMatch = /^\/api\/admin\/relay\/channels\/(\d+)(\/.*)?$/.exec(pathname)
  if (channelMatch) return isMineChannel(mock, Number(channelMatch[1])) !== null

  const modelMatch = /^\/api\/admin\/relay\/models\/(\d+)$/.exec(pathname)
  if (modelMatch) return mock.models.some((model) => model.id === Number(modelMatch[1]))

  if (pathname === '/api/admin/relay/models/import') {
    const channelId = Number(readJson(init)['channelId'])
    return isMineChannel(mock, channelId) !== null
  }

  return false
}

/**
 * 同步判断一个请求是不是本模块的（18）。放在 `fetch.ts` 里先查一次：
 * 不是本模块的请求不走 `await`，这样 DSH 的假接口仍然在同一次调用里同步改完状态
 * （现有测试依赖这个时序）。
 */
export function isAgentModeRequest(pathname: string, method: string, url: URL, init?: RequestInit): boolean {
  return claimsRequest(mockState(), pathname, method, url, init)
}

/** `GET/PUT /api/admin/agent-modes/:mode`、`POST …/deliver` 与两个模式自己的渠道 / 模型。 */
export async function handleAdminAgentModes(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Promise<Response | null> {
  const mock = mockState()
  if (!claimsRequest(mock, pathname, method, url, init)) return null

  const modeMatch = /^\/api\/admin\/agent-modes\/([^/]+)(\/deliver)?$/.exec(pathname)
  if (modeMatch) {
    const raw = modeMatch[1]!
    if (!(AGENT_MODES as string[]).includes(raw)) return apiError('NOT_FOUND', 404, '没有这个模式')
    const mode = raw as RelayAgentMode

    if (modeMatch[2] === '/deliver' && method === 'POST') {
      const body = readJson(init)
      const installPlugin = body.installPlugin !== false
      const restart = body.restart === 'next-start' ? 'next-start' : 'now'
      const users = usersOf(mock, mode)
      const job = createMockRolloutJob({
        type: 'rollout.agent-mode',
        title: `${AGENT_MODE_LABEL[mode]} 配置下发 → ${users.length} 位用户（${
          restart === 'now' ? '立即重启' : '下次启动生效'
        }${installPlugin ? '，自动装插件' : ''}）`,
        targets: users.map((user) => ({ userId: user.userId, username: user.username })),
      })
      mock.lastDeliver[mode] = job.id
      mock.lastDeliverStatus[mode] = 'queued'
      mock.lastDeliverAt[mode] = job.createdAt
      mock.pendingChange[mode] = false
      mock.settings[mode].targetsUpdatedAt = new Date().toISOString()
      // 下发后：被移出的用户从表里消失，targets 里的 env 视为已生效（重启时机只影响真实容器）
      mock.rows[mode] = mock.rows[mode]
        .filter((row) => row.targeted)
        .map((row) => ({ ...row, envApplied: true }))
      mock.envUserIds[mode] = mock.rows[mode].map((row) => row.userId)
      return json({ jobId: job.id }, 202)
    }

    if (method === 'GET') return json(stateResponse(mock, mode))

    if (method === 'PUT') {
      const body = readJson(init)
      const settings = mock.settings[mode]
      const models = scopeModels(mock, mode)
      const next: AgentModeSettings = { ...settings }

      if (typeof body.enabled === 'boolean') next.enabled = body.enabled
      if (typeof body.ratePermille === 'number') {
        if (!Number.isInteger(body.ratePermille) || body.ratePermille < 0 || body.ratePermille > 100_000) {
          return apiError('VALIDATION_FAILED', 400, '整体倍率要在 0–100 之间', {
            fields: { ratePermille: '整体倍率要在 0–100 之间，最多 3 位小数' },
          })
        }
        next.ratePermille = body.ratePermille
      }
      if ('defaultModelId' in body) {
        const value = body.defaultModelId
        if (value !== null && (typeof value !== 'number' || !models.some((model) => model.id === value))) {
          return apiError('VALIDATION_FAILED', 400, '默认模型必须是这个模式里的模型', {
            fields: { defaultModelId: '默认模型必须是这个模式里的模型' },
          })
        }
        next.defaultModelId = value as number | null
      }
      if ('smallModelId' in body) {
        const value = body.smallModelId
        if (mode === 'codex' && value !== null) {
          return apiError('VALIDATION_FAILED', 400, 'Codex 没有小模型', {
            fields: { smallModelId: 'Codex 没有小模型' },
          })
        }
        if (value !== null && (typeof value !== 'number' || !models.some((model) => model.id === value))) {
          return apiError('VALIDATION_FAILED', 400, '小模型必须是这个模式里的模型', {
            fields: { smallModelId: '小模型必须是这个模式里的模型' },
          })
        }
        next.smallModelId = value as number | null
      }
      if (typeof body.label === 'string') {
        const label = body.label.trim()
        if (label.length === 0 || label.length > 32) {
          return apiError('VALIDATION_FAILED', 400, '显示名要 1–32 个字', {
            fields: { label: '显示名要 1–32 个字' },
          })
        }
        next.label = label
      }
      if (body.targets && typeof body.targets === 'object') {
        const targets = body.targets as { all?: boolean; userIds?: unknown }
        if (targets.all === true) {
          next.targets = { all: true }
        } else if (Array.isArray(targets.userIds)) {
          const ids = targets.userIds.map(Number)
          const unknown = ids.filter(
            (id) =>
              !Number.isInteger(id) ||
              id <= 0 ||
              (!ADMIN_USERS.some((user) => user.id === id) && getMockState().user.id !== id),
          )
          if (unknown.length > 0) {
            return apiError('VALIDATION_FAILED', 400, `这些用户不存在：${unknown.join('、')}`, {
              fields: { targets: `用户不存在：${unknown.join('、')}` },
            })
          }
          next.targets = { userIds: [...new Set(ids)] }
        } else {
          return apiError('VALIDATION_FAILED', 400, 'targets 写法不对', {
            fields: { targets: 'targets 写法不对' },
          })
        }
      }

      const targetsChanged = JSON.stringify(next.targets) !== JSON.stringify(settings.targets)
      const enabledChanged = next.enabled !== settings.enabled
      next.updatedAt = new Date().toISOString()
      if (targetsChanged || enabledChanged) {
        next.targetsUpdatedAt = next.updatedAt
        mock.pendingChange[mode] = true
      }
      mock.settings[mode] = next

      if (targetsChanged) {
        const targetIds =
          'all' in next.targets
            ? [...new Set([...ADMIN_USERS.map((user) => user.id), getMockState().user.id])]
            : next.targets.userIds
        const existing = new Map(mock.rows[mode].map((row) => [row.userId, row]))
        const nextRows: AgentModeUser[] = targetIds.map((userId) => {
          const row = existing.get(userId)
          if (row) return { ...row, targeted: true }
          return seedUserRow(userId, {
            monthCostMicro: monthUsageOf(mock, userId, mode),
          })
        })
        // 被移出的用户先留在表里（targeted=false），下发后才去掉
        for (const row of mock.rows[mode]) {
          if (!targetIds.includes(row.userId) && mock.envUserIds[mode].includes(row.userId)) {
            nextRows.push({ ...row, targeted: false, envApplied: false })
          }
        }
        mock.rows[mode] = nextRows
        for (const userId of targetIds) {
          if (!mock.envUserIds[mode].includes(userId)) mock.envUserIds[mode].push(userId)
        }
      }

      return json(stateResponse(mock, mode))
    }

    return apiError('METHOD_NOT_ALLOWED', 405, '方法不支持')
  }

  // ── 渠道 ──
  if (pathname === '/api/admin/relay/channels' && method === 'GET') {
    const scope = (url.searchParams.get('scope') ?? 'dsh') as RelayScope
    return json(scopeChannels(mock, scope))
  }

  if (pathname === '/api/admin/relay/channels' && method === 'POST') {
    const body = readJson(init)
    const scope = (typeof body.scope === 'string' ? body.scope : 'dsh') as RelayAgentMode
    if (!(AGENT_MODES as string[]).includes(scope)) {
      return apiError('VALIDATION_FAILED', 400, '作用域不对', { fields: { scope: '作用域不对' } })
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return apiError('VALIDATION_FAILED', 400, '渠道名称不能为空')
    if (mock.channels.some((channel) => channel.name === name && channel.scope === scope)) {
      return apiError('CONFLICT', 409, '这个模式里已有同名渠道')
    }
    const apis = Array.isArray(body.apis) ? (body.apis as ModelApi[]) : []
    const fixed = AGENT_MODE_API[scope]
    if (apis.length === 0 || apis.some((api) => api !== fixed)) {
      return apiError('VALIDATION_FAILED', 400, `这个模式的渠道只能用 ${fixed}`, {
        fields: { apis: `这个模式的渠道只能用 ${fixed}` },
      })
    }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
    if (!/^https?:\/\//.test(baseUrl)) {
      return apiError('VALIDATION_FAILED', 400, '地址必须以 http(s):// 开头')
    }
    const requestedSlug = typeof body.slug === 'string' ? body.slug.trim() : ''
    if (requestedSlug && mock.channels.some((channel) => channel.slug === requestedSlug)) {
      return apiError('VALIDATION_FAILED', 400, '这个标识已被使用', {
        fields: { slug: '这个标识已经被别的渠道用了' },
      })
    }
    const id = mock.nextChannelId++
    const channel: RelayChannel = {
      id,
      name,
      slug: requestedSlug || uniqueSlug(mock, slugify(name) || `ch${id}`),
      baseUrl,
      apis: apis as RelayChannel['apis'],
      ratePermille: typeof body.ratePermille === 'number' ? body.ratePermille : 1000,
      priority: typeof body.priority === 'number' ? body.priority : 0,
      weight: typeof body.weight === 'number' ? body.weight : 1,
      maxConcurrency: typeof body.maxConcurrency === 'number' ? body.maxConcurrency : 0,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 600_000,
      proxyUrl: typeof body.proxyUrl === 'string' && body.proxyUrl ? body.proxyUrl : null,
      headers: (body.headers as Record<string, string> | null | undefined) ?? null,
      streamUsage: body.streamUsage !== false,
      enabled: body.enabled !== false,
      note: typeof body.note === 'string' ? body.note : '',
      keys: [],
      health: 'ok',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      inFlight: 0,
      modelCount: 0,
      scope,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const keys = Array.isArray(body.keys) ? (body.keys as string[]) : []
    for (const [index, secret] of keys.entries()) {
      channel.keys.push(channelKey(mock.nextChannelKeyId++, secret.slice(-4), index === 0 ? '主密钥' : ''))
    }
    mock.channels.push(channel)
    return json({ channel }, 201)
  }

  const channelMatch = /^\/api\/admin\/relay\/channels\/(\d+)(\/.*)?$/.exec(pathname)
  if (channelMatch) {
    const channel = isMineChannel(mock, Number(channelMatch[1]))
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')
    const rest = channelMatch[2] ?? ''

    if (rest === '/test' && method === 'POST') {
      const results: TestRelayChannelResponse['results'] = channel.keys.map((key, index) => ({
        keyId: key.id,
        last4: key.last4,
        ok: true,
        latencyMs: 320 + index * 180,
        httpStatus: 200,
      }))
      return json({ ok: true, results } satisfies TestRelayChannelResponse)
    }

    if (rest === '/discover' && method === 'POST') {
      return json({ models: discoverList(channel.scope as RelayAgentMode) })
    }

    if (rest === '/keys' && method === 'POST') {
      const body = readJson(init)
      const keys = Array.isArray(body.keys) ? (body.keys as string[]) : []
      const response: AddRelayChannelKeysResponse = { added: keys.length, skipped: 0, channel }
      for (const secret of keys) {
        channel.keys.push(channelKey(mock.nextChannelKeyId++, secret.slice(-4)))
      }
      return json(response, 201)
    }

    if (rest === '' && method === 'PATCH') {
      const body = readJson(init)
      if (typeof body.name === 'string' && body.name.trim()) channel.name = body.name.trim()
      if (typeof body.slug === 'string') {
        const requested = body.slug.trim()
        if (requested && mock.channels.some((item) => item.slug === requested && item.id !== channel.id)) {
          return apiError('VALIDATION_FAILED', 400, '这个标识已被使用', {
            fields: { slug: '这个标识已经被别的渠道用了' },
          })
        }
        channel.slug = requested || channel.slug
      }
      if (typeof body.baseUrl === 'string') channel.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
      if (Array.isArray(body.apis) && body.apis.length > 0) channel.apis = body.apis as RelayChannel['apis']
      for (const field of ['priority', 'weight', 'maxConcurrency', 'timeoutMs'] as const) {
        if (typeof body[field] === 'number') channel[field] = body[field] as number
      }
      if ('proxyUrl' in body) channel.proxyUrl = (body.proxyUrl as string | null) ?? null
      if ('headers' in body) channel.headers = (body.headers as Record<string, string> | null) ?? null
      if (typeof body.streamUsage === 'boolean') channel.streamUsage = body.streamUsage
      if (typeof body.enabled === 'boolean') channel.enabled = body.enabled
      if (typeof body.note === 'string') channel.note = body.note
      if (typeof body.ratePermille === 'number') {
        channel.ratePermille = body.ratePermille
        for (const model of scopeModels(mock, channel.scope as RelayScope)) {
          for (const route of model.routes) {
            if (route.channelId === channel.id) route.channelRatePermille = channel.ratePermille
          }
        }
      }
      for (const model of mock.models) {
        for (const route of model.routes) {
          if (route.channelId === channel.id) {
            route.channelName = channel.name
            route.channelSlug = channel.slug
          }
        }
      }
      channel.updatedAt = new Date().toISOString()
      return json({ channel })
    }

    if (rest === '' && method === 'DELETE') {
      const referencing = mock.models.filter((model) =>
        model.routes.some((route) => route.channelId === channel.id),
      )
      if (referencing.length > 0) {
        return apiError('CONFLICT', 409, '还有模型路由指向这个渠道', {
          models: referencing.map((model) => model.name),
        })
      }
      mock.channels = mock.channels.filter((item) => item.id !== channel.id)
      return noContent()
    }

    const keyMatch = /^\/keys\/(\d+)$/.exec(rest)
    if (keyMatch) {
      const keyId = Number(keyMatch[1])
      if (method === 'PATCH') {
        const body = readJson(init)
        const key = channel.keys.find((item) => item.id === keyId)
        if (!key) return apiError('NOT_FOUND', 404, '密钥不存在')
        if (typeof body.label === 'string') key.label = body.label
        if (body.state === 'active' || body.state === 'disabled') key.state = body.state
        return json({ channel })
      }
      if (method === 'DELETE') {
        channel.keys = channel.keys.filter((item) => item.id !== keyId)
        return json({ channel })
      }
    }

    return apiError('METHOD_NOT_ALLOWED', 405, '方法不支持')
  }

  // ── 对外模型 ──
  if (pathname === '/api/admin/relay/models' && method === 'GET') {
    const scope = (url.searchParams.get('scope') ?? 'dsh') as RelayScope
    return json(scopeModels(mock, scope))
  }

  if (pathname === '/api/admin/relay/models' && method === 'POST') {
    const body = readJson(init)
    const scope = (typeof body.scope === 'string' ? body.scope : 'dsh') as RelayAgentMode
    if (!(AGENT_MODES as string[]).includes(scope)) {
      return apiError('VALIDATION_FAILED', 400, '作用域不对', { fields: { scope: '作用域不对' } })
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return apiError('VALIDATION_FAILED', 400, '模型名不能为空', { fields: { name: '必填' } })
    const model = makeModel({
      id: mock.nextModelId++,
      name,
      displayName:
        typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : name,
      scope,
      price: (body.price as RelayPrice | undefined) ?? PRICE_UNPRICED,
      info: (body.info as RelayModel['info'] | undefined) ?? {},
      enabled: body.enabled !== false,
      routes: [],
    })
    model.visibility = body.visibility === 'admin' ? 'admin' : 'all'
    mock.models.push(model)
    return json({ model }, 201)
  }

  if (pathname === '/api/admin/relay/models/import' && method === 'POST') {
    const body = readJson(init)
    const channel = isMineChannel(mock, Number(body.channelId))
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')
    const scope = channel.scope as RelayAgentMode
    const entries = Array.isArray(body.models) ? body.models : []
    const created: RelayModel[] = []
    let createdCount = 0
    let routesAdded = 0
    for (const raw of entries) {
      const entry = raw as {
        upstreamModel?: string
        name?: string
        displayName?: string
        info?: RelayModel['info']
      }
      const upstream = (entry.upstreamModel ?? '').trim()
      if (!upstream) continue
      const modelName = (entry.name ?? upstream).trim() || upstream
      let model = mock.models.find((item) => item.name === modelName)
      if (!model) {
        model = makeModel({
          id: mock.nextModelId++,
          name: modelName,
          displayName: entry.displayName ?? modelName,
          scope,
          price: PRICE_UNPRICED,
          info: entry.info ?? {},
          routes: [],
        })
        mock.models.push(model)
        created.push(model)
        createdCount += 1
      }
      if (!model.routes.some((route) => route.channelId === channel.id)) {
        model.routes.push(makeRoute({ id: mock.nextRouteId++, channel, upstreamModel: upstream }))
        refreshModelApi(model, scope)
        routesAdded += 1
      }
    }
    channel.modelCount = mock.models.filter((model) =>
      model.routes.some((route) => route.channelId === channel.id),
    ).length
    return json({ created: createdCount, routesAdded, skipped: 0, models: created })
  }

  const modelMatch = /^\/api\/admin\/relay\/models\/(\d+)$/.exec(pathname)
  if (modelMatch) {
    const id = Number(modelMatch[1])
    const index = mock.models.findIndex((model) => model.id === id)
    const model = mock.models[index]
    if (!model) return apiError('NOT_FOUND', 404, '模型不存在')
    const scope = (model.scope ?? 'dsh') as RelayAgentMode

    if (method === 'PATCH') {
      const body = readJson(init)
      if (typeof body.name === 'string' && body.name.trim()) model.name = body.name.trim()
      if (typeof body.displayName === 'string' && body.displayName.trim())
        model.displayName = body.displayName.trim()
      if (typeof body.enabled === 'boolean') model.enabled = body.enabled
      if (body.visibility === 'all' || body.visibility === 'admin') model.visibility = body.visibility
      if (body.price && typeof body.price === 'object') model.price = body.price as RelayPrice
      if (body.info && typeof body.info === 'object') model.info = body.info as RelayModel['info']
      if ('compat' in body) model.compat = (body.compat as RelayModel['compat']) ?? null
      if (Array.isArray(body.routes)) {
        const inputs = body.routes as RelayRouteInput[]
        const mismatched = inputs.filter(
          (input) => mock.channels.find((channel) => channel.id === input.channelId)?.scope !== scope,
        )
        if (mismatched.length > 0) {
          return apiError('VALIDATION_FAILED', 400, '渠道和模型不在同一个页面', {
            fields: { routes: '渠道和模型不在同一个页面' },
          })
        }
        model.routes = routeInputs(model, inputs)
        refreshModelApi(model, scope)
      }
      model.updatedAt = new Date().toISOString()
      for (const channel of mock.channels) {
        channel.modelCount = mock.models.filter((item) =>
          item.routes.some((route) => route.channelId === channel.id),
        ).length
      }
      return json({ model })
    }

    if (method === 'DELETE') {
      mock.models = mock.models.filter((item) => item.id !== id)
      for (const channel of mock.channels) {
        channel.modelCount = mock.models.filter((item) =>
          item.routes.some((route) => route.channelId === channel.id),
        ).length
      }
      return noContent()
    }

    return apiError('METHOD_NOT_ALLOWED', 405, '方法不支持')
  }

  return null
}

/** 本月该模式的花费（微积分） */
function monthUsageOf(mock: AgentModeMockState, userId: number, mode: RelayAgentMode): number {
  return mock.usage
    .filter(
      (row) => row.userId === userId && row.scope === mode && row.createdAt.slice(0, 10) >= monthStart(),
    )
    .reduce((sum, row) => sum + row.costMicro, 0)
}

// ── 用户端 ──────────────────────────────────────────────────────────────────

/** 用户端「可用模型」里的对话模式小节：只含开通且对我开放的模式（18 §7） */
export function mockMyAgentModes(): MyAgentMode[] | undefined {
  const mock = mockState()
  const userId = getMockState().user.id
  const modes: MyAgentMode[] = []

  for (const mode of AGENT_MODES) {
    const settings = mock.settings[mode]
    const targeted =
      ('all' in settings.targets && settings.targets.all === true) ||
      ('userIds' in settings.targets && settings.targets.userIds.includes(userId)) ||
      mock.envUserIds[mode].includes(userId)
    if (!settings.enabled || !targeted) continue

    const models: MyRelayModel[] = scopeModels(mock, mode)
      .filter((model) => model.enabled && model.visibility === 'all' && isRoutable(mock, model))
      .map((model) => {
        const rates = modelScopedRoutes(mock, model)
          .filter((entry) => entry.channel.enabled && entry.route.enabled)
          .map((entry) => entry.channel.ratePermille)
        return {
          name: model.name,
          displayName: model.displayName,
          apis: [AGENT_MODE_API[mode]],
          price: model.price,
          channelRate:
            rates.length === 0 ? null : { minPermille: Math.min(...rates), maxPermille: Math.max(...rates) },
          info: model.info,
        }
      })

    modes.push({
      mode,
      label: settings.label,
      ratePermille: settings.ratePermille,
      defaultModel: effectiveModel(mock, mode, settings.defaultModelId),
      models,
    })
  }

  return modes.length > 0 ? modes : undefined
}

/** 两个模式的用量记录（带 `scope`），交给 `mocks/relay.ts` 合并进统计 / 逐条记录 */
export function mockAgentModeUsageRows(): RelayUsageRow[] {
  return mockState().usage
}
