import type {
  AddRelayChannelKeysResponse,
  DiscoverRelayChannelResponse,
  ModelApi,
  ImportRelayModelsResponse,
  MyRelayModel,
  MyRelayResponse,
  RelayAlert,
  RelayChannel,
  RelayChannelKey,
  RelayDshModel,
  RelayDshResponse,
  RelayDshRoute,
  RelayLedgerRow,
  RelayModel,
  RelayOverviewResponse,
  RelayPrice,
  RelayRoute,
  RelayScope,
  RelaySettings,
  RelayUsageBucket,
  RelayUsageRow,
  RelayWalletRow,
  RelayKey,
  RelaySettingsResponse,
  TestRelayChannelResponse,
  ThinkingLevel,
} from '@dsh-hub/shared'

import {
  RELAY_DSH_API_PREFERENCE,
  THINKING_LEVELS,
  effectiveDshThinking,
  pinnedModelName,
  RELAY_PINNED_MODEL_SEPARATOR,
} from '@dsh-hub/shared'

import { applyRate } from '@/utils/rate'
import { isUnpricedModel } from '@/utils/relay-model'

import { ADMIN_USERS } from './admin'
import { mockAgentModeUsageRows, mockMyAgentModes } from './agent-modes'
import { mockComputeWalletMicro } from './compute'
import { latestMockModelsRollout, resetMockJobs } from './jobs'
import { getMockState, type MockScenario } from './state'

/**
 * 中转站的假数据与假接口（**仅开发环境**，`?mock=1` 走用户端、`?mock=admin` 走管理端，
 * `?mock=relay-off` 是「未开通」场景）。
 *
 * 覆盖 12 §9 的全部接口：渠道 + 密钥池、对外模型与价格、钱包（积分）、流水、用量统计与逐条记录、
 * 用户自己的 API 密钥。POST/PATCH/DELETE 真的改这里的内存状态（照 `mocks/admin.ts` 的写法），
 * 所以页面上「新建密钥 → 列表多一把」「加/扣积分 → 余额变了」都能走通，也不碰任何真实后端。
 */

/** 区间里的每一天（12 §9：没有用量的日子也要有一项，便于画图） */
type RelayDayBucket = RelayUsageBucket & { day: string }

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

// ── 时间与日期（统计按 Asia/Shanghai 自然日，12 §6.5）──────────────────────

const SHANGHAI_OFFSET_MS = 8 * 3600_000
const NOW = Date.now()

const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()

/** 今天（UTC+8）的 `YYYY-MM-DD`；`offsetDays` 向前推。 */
function shanghaiDay(offsetDays = 0): string {
  return new Date(NOW + SHANGHAI_OFFSET_MS - offsetDays * 86_400_000).toISOString().slice(0, 10)
}

function dayToIndex(day: string): number {
  // 以 UTC 零点为天索引；展示/星期计算时再加 SHANGHAI_OFFSET_MS。
  // （以前这里减了 8 小时，导致 dayRange 的日期整体早一天、与 from/to 对不上。）
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000)
}

function monthStartDay(): string {
  return `${shanghaiDay().slice(0, 7)}-01`
}

/** 闭区间 [from, to] 的日期列表（跨度已由调用方限制）。 */
function dayRange(from: string, to: string): string[] {
  const start = dayToIndex(from)
  const end = dayToIndex(to)
  const days: string[] = []
  for (let index = start; index <= end; index += 1) {
    days.push(new Date(index * 86_400_000).toISOString().slice(0, 10))
  }
  return days
}

/** 走查用的「休息日」：整个平台没有任何用量，图上能看到真正的 0（19 §2.2 空档）。 */
const QUIET_DAY_OFFSETS = [5, 12, 20]

function isQuietDay(day: string): boolean {
  return QUIET_DAY_OFFSETS.some((offset) => day === shanghaiDay(offset))
}

/** 稳定的伪随机（同一天同一格的数据每次刷新都一样，截图不会跳）。 */
function rng(seed: number): () => number {
  let state = (seed ^ 0x9e3779b9) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

// ── 假用户与钱包 ────────────────────────────────────────────────────────────

interface MockRelayUser {
  id: number
  username: string
  displayName: string
  avatarUrl: string | null
}

/** 钱包持有者（沿用管理端假用户；`id` 与 `/admin/users` 一致） */
interface MockWalletSeed {
  id: number
  username: string
  displayName: string
  balanceMicro: number
  ratePercent: number
  maxConcurrency: number | null
  dailyLimitMicro: number | null
  enabled: boolean
  totalSpentMicro: number
  /** 19 §2.1：今日赠送还没用掉的部分（0 / 省略 = 不显示那一行） */
  dailyBonusLeftMicro?: number
}

const WALLET_SEEDS: MockWalletSeed[] = [
  {
    id: 1,
    username: 'admin',
    displayName: '站长',
    balanceMicro: 128_500_000,
    ratePercent: 100,
    maxConcurrency: null,
    dailyLimitMicro: null,
    enabled: true,
    totalSpentMicro: 36_400_000,
  },
  {
    id: 2,
    username: 'mint',
    displayName: '薄荷茶',
    balanceMicro: 42_180_000,
    ratePercent: 100,
    maxConcurrency: 2,
    dailyLimitMicro: 10_000_000,
    enabled: true,
    totalSpentMicro: 18_260_000,
  },
  {
    id: 4,
    username: 'sakura',
    displayName: '樱花饼',
    balanceMicro: -120_000,
    ratePercent: 50,
    maxConcurrency: null,
    dailyLimitMicro: null,
    enabled: true,
    totalSpentMicro: 5_780_000,
  },
  {
    id: 5,
    username: 'butter',
    displayName: '奶油小狗',
    balanceMicro: 3_050_000,
    ratePercent: 100,
    maxConcurrency: 1,
    dailyLimitMicro: null,
    enabled: false,
    totalSpentMicro: 1_240_000,
  },
  {
    id: 6,
    username: 'quiet-leaf',
    displayName: '安静的叶子',
    balanceMicro: 0,
    ratePercent: 100,
    maxConcurrency: null,
    dailyLimitMicro: null,
    enabled: true,
    totalSpentMicro: 0,
  },
  {
    // 极端值（WP14b 走查）：长用户名 / 长昵称 + 大额余额
    id: 7,
    username: 'demo-alice-work-laptop',
    displayName: '小陈的第三台工作笔记本（出差用）',
    balanceMicro: 987_654_321_000,
    ratePercent: 85,
    maxConcurrency: 3,
    dailyLimitMicro: 50_000_000,
    enabled: true,
    totalSpentMicro: 12_345_678_900,
  },
]

/** 用户端场景里的「我自己」（`?mock=1` 的 littletao，id 12） */
const CURRENT_USER_WALLET = {
  // 极端值（WP14a 走查）：5 位积分的余额，量统计卡「数字 + 单位」会不会断行
  balanceMicro: 12_345_670_000,
  ratePercent: 100,
  maxConcurrency: null,
  dailyLimitMicro: 20_000_000,
  enabled: true,
  totalSpentMicro: 2_140_000,
  // 19 §2.1：今日赠送还剩一点，统计卡上要多一行数据
  dailyBonusLeftMicro: 2_340_000,
}

function mockUsers(
  currentUserId: number,
  currentUsername: string,
  currentDisplayName: string,
  currentAvatar: string | null,
): MockRelayUser[] {
  const users: MockRelayUser[] = ADMIN_USERS.map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  }))
  if (!users.some((user) => user.id === currentUserId)) {
    users.push({
      id: currentUserId,
      username: currentUsername,
      displayName: currentDisplayName,
      avatarUrl: currentAvatar,
    })
  }
  return users
}

// ── 状态 ────────────────────────────────────────────────────────────────────

const PRICE_FLASH: RelayPrice = {
  inputMicro: 1_000_000,
  outputMicro: 2_000_000,
  cacheReadMicro: 100_000,
  cacheWriteMicro: 1_000_000,
  perRequestMicro: 0,
}

interface RelayMockState {
  scenario: MockScenario
  settings: RelaySettings
  channels: RelayChannel[]
  models: RelayModel[]
  ledger: RelayLedgerRow[]
  /** 逐条用量（生成后固定） */
  logs: MockUsageRow[]
  /** 当前用户自己的密钥 */
  keys: RelayKey[]
  users: MockRelayUser[]
  walletSeeds: Map<number, (typeof WALLET_SEEDS)[number]>
  /** 日汇总缓存：day → 各 (user, model, channel) 的格子 */
  dayCache: Map<string, UsageCell[]>
  nextChannelId: number
  nextChannelKeyId: number
  nextKeyId: number
  nextLedgerId: number
  nextModelId: number
  nextRouteId: number
  nextUsageId: number
  secretCounter: number
  /** 下发到 DSH：选中的对外模型 id（12 §7.0，模拟 `relay_models.dsh_enabled`） */
  dshModelIds: number[]
  /** 下发到 DSH 的默认模型 id（模拟 `settings.relay_dsh`；老写法的兼容字段） */
  dshDefaultModelId: number | null
  /** 下发到 DSH 选中的路由 id（16 §6：模型 × 渠道） */
  dshRouteIds: number[]
  /** 下发到 DSH 的默认路由 id */
  dshDefaultRouteId: number | null
  /** 系统预设 revision（每次保存 +1，模拟后端 `syncDshPreset()`） */
  dshRevision: number
  /** 下发配置最近一次变化的时间；从没配置过 = null */
  dshUpdatedAt: string | null
  // ── docs/22 §3：桌面端是独立的一套系统预设（cloud 用上面的 dsh* 字段）──
  desktopDshModelIds: number[]
  desktopDshDefaultModelId: number | null
  desktopDshRouteIds: number[]
  desktopDshDefaultRouteId: number | null
  desktopDshRevision: number
  desktopDshUpdatedAt: string | null
  /** 保存了桌面配置但还没走统一下发（界面上的「有改动，尚未下发」） */
  desktopDshPending: boolean
  /** docs/22 §3：最近一次**写入桌面模型片段**的清单版本（`RelayDshResponse.lastDelivery`） */
  desktopDshLastDelivery: { revision: number; at: string; by: string | null } | null
}

/** 假的逐条用量多一个 `clientKind`（契约合入前只用于假接口按桌面来源筛选） */
type MockUsageRow = RelayUsageRow & { clientKind?: string }

interface UsageCell {
  userId: number
  model: string
  channelId: number
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costMicro: number
}

let state: RelayMockState | null = null

function makeKeys(): RelayKey[] {
  return [
    {
      id: 1,
      kind: 'system',
      name: 'DSH 内置密钥',
      preview: 'sk-dsh-7f3ac2…c91d',
      enabled: true,
      lastUsedAt: iso(12),
      createdAt: iso(60 * 24 * 40),
    },
    {
      id: 2,
      kind: 'user',
      name: '本机 curl',
      preview: 'sk-dsh-2b8ce1…4e77',
      enabled: true,
      lastUsedAt: iso(60 * 26),
      createdAt: iso(60 * 24 * 20),
    },
    {
      id: 3,
      kind: 'user',
      name: '旧笔记本',
      preview: 'sk-dsh-9d10f4…77aa',
      enabled: false,
      lastUsedAt: iso(60 * 24 * 30),
      createdAt: iso(60 * 24 * 60),
    },
    {
      // 极端值（WP14a 走查）：超长密钥名，量密钥表的名称列
      id: 4,
      kind: 'user',
      name: '公司笔记本上的命令行工具（长期不用）',
      preview: 'sk-dsh-5f7a19…0b3c',
      enabled: true,
      lastUsedAt: iso(60 * 24 * 3),
      createdAt: iso(60 * 24 * 12),
    },
  ]
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function mockSecret(counter: number): string {
  const random = rng(counter * 7919)
  let body = ''
  for (let index = 0; index < 40; index += 1) {
    body += BASE62[Math.floor(random() * BASE62.length)] ?? 'x'
  }
  return `sk-dsh-${body}`
}

function previewOf(secret: string): string {
  return `${secret.slice(0, 11)}…${secret.slice(-4)}`
}

function channelKey(
  id: number,
  last4: string,
  stateValue: RelayChannelKey['state'],
  label: string,
  extra: Partial<RelayChannelKey> = {},
): RelayChannelKey {
  return {
    id,
    label,
    last4,
    state: stateValue,
    cooldownUntil: null,
    lastError: null,
    lastErrorAt: null,
    lastUsedAt: iso(30),
    createdAt: iso(60 * 24 * 30),
    ...extra,
  }
}

/** 渠道的「模型数」= 引用它的对外模型数（12 §10 渠道表）；模型的增删改之后都要刷一遍 */
function refreshChannelModelCounts(mock: RelayMockState): void {
  for (const channel of mock.channels) {
    channel.modelCount = mock.models.filter((model) =>
      model.routes.some((r) => r.channelId === channel.id),
    ).length
  }
}

function healthOf(channel: Pick<RelayChannel, 'enabled' | 'keys' | 'cooldownUntil'>): RelayChannel['health'] {
  if (!channel.enabled) return 'disabled'
  if (channel.cooldownUntil && Date.parse(channel.cooldownUntil) > Date.now()) return 'cooling'
  if (!channel.keys.some((key) => key.state === 'active')) return 'no-key'
  return 'ok'
}

/** 16 §2：按名称生成标识（后端规则的小型复刻，仅用于假数据） */
function slugifyChannelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
}

/** 16 §2：自动生成的标识冲突时依次加 -2、-3……（手动填的由调用方报 VALIDATION_FAILED） */
function uniqueChannelSlug(mock: RelayMockState, base: string, excludeId?: number): string {
  const root = base || 'channel'
  let candidate = root.slice(0, 24).replace(/-+$/g, '')
  let suffix = 2
  while (mock.channels.some((channel) => channel.slug === candidate && channel.id !== excludeId)) {
    const tail = `-${suffix}`
    candidate = `${root.slice(0, 24 - tail.length).replace(/-+$/g, '')}${tail}`
    suffix += 1
  }
  return candidate
}

function isValidChannelSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(value)
}

/** 一条路由：渠道倍率快照跟着渠道走（12 §9：路由 DTO 带 `channelRatePermille`） */
function route(
  id: number,
  channel: Pick<RelayChannel, 'id' | 'name' | 'slug' | 'ratePermille'>,
  upstreamModel: string,
  extra: Partial<RelayRoute> = {},
): RelayRoute {
  return {
    id,
    channelId: channel.id,
    channelName: channel.name,
    channelSlug: channel.slug,
    channelRatePermille: channel.ratePermille,
    upstreamModel,
    priority: null,
    weight: null,
    enabled: true,
    ...extra,
  }
}

function createState(scenario: MockScenario): RelayMockState {
  const mockState = getMockState()
  const currentUserId = mockState.user.id
  const enabled = scenario !== 'relay-off'

  const channels: RelayChannel[] = [
    {
      // 16 §1 的生产形状：upstream-c 池 ×0.3，但已经停用 → 用户看不到这条渠道的「模型@渠道」
      id: 1,
      name: 'Upstream C 池',
      slug: 'upstream-c',
      baseUrl: 'https://upstream-c.example.com/v1',
      apis: ['openai-completions'],
      ratePermille: 300,
      priority: 10,
      weight: 1,
      maxConcurrency: 4,
      timeoutMs: 600_000,
      proxyUrl: null,
      headers: null,
      streamUsage: true,
      enabled: false,
      note: '订阅池：已停用，用户端不会列出它上面的模型',
      keys: [
        channelKey(11, 'a3f9', 'active', '主密钥', { lastUsedAt: iso(3) }),
        channelKey(12, '7b2d', 'auto-disabled', '备用密钥', {
          lastError: '上游返回 401（密钥无效）',
          lastErrorAt: iso(60 * 20),
        }),
      ],
      health: 'disabled',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      inFlight: 0,
      modelCount: 2,
      createdAt: iso(60 * 24 * 40),
      updatedAt: iso(60 * 24 * 2),
    },
    {
      // 用户要求里最便宜的一条：×0.1
      id: 2,
      name: 'Upstream B',
      slug: 'upstream-b',
      baseUrl: 'https://upstream-b.example.com/v1',
      apis: ['openai-completions'],
      ratePermille: 100,
      priority: 0,
      weight: 1,
      maxConcurrency: 2,
      timeoutMs: 600_000,
      proxyUrl: null,
      headers: null,
      streamUsage: true,
      enabled: true,
      note: '主力线路：便宜、只支持 OpenAI 兼容协议',
      keys: [channelKey(21, '1c4e', 'active', '主密钥'), channelKey(22, '8f6a', 'active', '备用密钥')],
      health: 'ok',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      inFlight: 0,
      modelCount: 3,
      createdAt: iso(60 * 24 * 30),
      updatedAt: iso(60 * 24),
    },
    {
      // 官方线路：×1，支持两种协议，用来验证「协议不匹配」的阻断
      id: 3,
      name: 'DeepSeek 官方',
      slug: 'official',
      baseUrl: 'https://api.deepseek.com/v1',
      apis: ['openai-completions', 'anthropic-messages'],
      ratePermille: 1000,
      priority: 5,
      weight: 1,
      maxConcurrency: 0,
      timeoutMs: 600_000,
      proxyUrl: null,
      headers: null,
      streamUsage: true,
      enabled: true,
      note: '官方直连：没有加价，只有它支持 Anthropic 协议',
      keys: [channelKey(31, '9d3b', 'active', '官方密钥')],
      health: 'ok',
      failStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
      inFlight: 0,
      modelCount: 5,
      createdAt: iso(60 * 24 * 24),
      updatedAt: iso(60 * 24),
    },
  ]

  /** 建路由时按 id 取渠道（要拿它的倍率快照） */
  const channelOf = (id: number): RelayChannel => channels.find((item) => item.id === id)!

  const models: RelayModel[] = [
    {
      id: 1,
      name: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      enabled: true,
      visibility: 'all',
      price: PRICE_FLASH,
      info: {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        input: ['text', 'image'],
        reasoningEfforts: ['low', 'high', 'max'],
      },
      // WP13：默认思考档位 max 在声明里 → 生效
      defaultThinking: 'max',
      compat: { supportsReasoning: true },
      // 一个模型挂三条渠道（16 §1 的生产形状）：upstream-c 已停用 → 用户端看到 @upstream-b / @official
      routes: [
        route(101, channelOf(1), 'deepseek-v4.1-flash'),
        route(102, channelOf(2), 'deepseek-chat'),
        route(103, channelOf(3), 'deepseek-v4.1-flash'),
      ],
      apis: ['openai-completions', 'anthropic-messages'],
      sort: 10,
      createdAt: iso(60 * 24 * 20),
      updatedAt: iso(60 * 24),
    },
    {
      id: 2,
      name: 'deepseek-v3',
      displayName: 'DeepSeek V3',
      enabled: true,
      visibility: 'all',
      price: {
        inputMicro: 500_000,
        outputMicro: 1_000_000,
        cacheReadMicro: 50_000,
        cacheWriteMicro: 500_000,
        perRequestMicro: 0,
      },
      info: { contextWindow: 131_072, maxTokens: 8_192, input: ['text'] },
      // 没声明任何思考档位：表格「默认思考」列显示灰「—」
      defaultThinking: null,
      compat: null,
      routes: [route(104, channelOf(1), 'deepseek-v3'), route(105, channelOf(2), 'deepseek-chat')],
      apis: ['openai-completions'],
      sort: 20,
      createdAt: iso(60 * 24 * 20),
      updatedAt: iso(60 * 24 * 3),
    },
    {
      id: 3,
      name: 'claude-sonnet-4.6',
      displayName: 'Claude Sonnet 4.6',
      enabled: true,
      visibility: 'all',
      price: {
        inputMicro: 3_000_000,
        outputMicro: 15_000_000,
        cacheReadMicro: 300_000,
        cacheWriteMicro: 3_750_000,
        perRequestMicro: 0,
      },
      info: { contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'] },
      defaultThinking: null,
      compat: null,
      // official 支持 anthropic；upstream-b 只支持 OpenAI 兼容 → 后者「协议不匹配」不能下发
      routes: [route(106, channelOf(3), 'claude-sonnet-4.6'), route(107, channelOf(2), 'claude-sonnet-4.6')],
      apis: ['anthropic-messages'],
      sort: 30,
      createdAt: iso(60 * 24 * 14),
      updatedAt: iso(60 * 24 * 4),
    },
    {
      id: 4,
      name: 'qwen3-coder',
      displayName: 'Qwen3 Coder',
      enabled: true,
      visibility: 'all',
      price: {
        inputMicro: 800_000,
        outputMicro: 3_200_000,
        cacheReadMicro: 80_000,
        cacheWriteMicro: null,
        perRequestMicro: 100_000,
      },
      info: { contextWindow: 262_144, maxTokens: 16_384, input: ['text'], reasoningEfforts: ['off', 'high'] },
      defaultThinking: 'high',
      compat: null,
      // 只挂一条渠道：用户只看到一个 @upstream-b
      routes: [route(108, channelOf(2), 'qwen3-coder')],
      apis: ['openai-completions'],
      sort: 40,
      createdAt: iso(60 * 24 * 8),
      updatedAt: iso(60 * 24 * 8),
    },
    {
      id: 5,
      name: 'local-qwen3-32b',
      displayName: '内网 Qwen3 32B',
      enabled: false,
      visibility: 'admin',
      price: {
        inputMicro: 100_000,
        outputMicro: 200_000,
        cacheReadMicro: null,
        cacheWriteMicro: null,
        perRequestMicro: 0,
      },
      info: { contextWindow: 32_768, maxTokens: 8_192, input: ['text'] },
      defaultThinking: null,
      compat: null,
      routes: [route(109, channelOf(3), 'qwen2.5-32b')],
      apis: ['openai-completions'],
      sort: 50,
      createdAt: iso(60 * 24 * 12),
      updatedAt: iso(60 * 24 * 12),
    },
    {
      id: 6,
      name: 'glm-4.7-air',
      displayName: '智谱 GLM-4.7 Air',
      enabled: true,
      visibility: 'all',
      price: {
        inputMicro: 0,
        outputMicro: 0,
        cacheReadMicro: null,
        cacheWriteMicro: null,
        perRequestMicro: 0,
      },
      info: {
        contextWindow: 131_072,
        maxTokens: 16_384,
        input: ['text'],
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      // 设了 max 但声明里只有 low/medium/high → 不生效（琥珀「未生效」+ GET /dsh 的 warning）
      defaultThinking: 'max',
      compat: null,
      routes: [route(110, channelOf(3), 'glm-4.7-air')],
      apis: ['openai-completions'],
      sort: 60,
      createdAt: iso(60 * 12),
      updatedAt: iso(60 * 12),
    },
    {
      id: 7,
      name: 'kimi-k2-thinking',
      displayName: 'Kimi K2 Thinking',
      enabled: true,
      visibility: 'all',
      price: {
        inputMicro: 0,
        outputMicro: 0,
        cacheReadMicro: null,
        cacheWriteMicro: null,
        perRequestMicro: 0,
      },
      info: {
        contextWindow: 262_144,
        maxTokens: 32_768,
        input: ['text'],
        reasoningEfforts: ['off', 'low', 'high', 'max'],
      },
      defaultThinking: null,
      compat: null,
      routes: [],
      apis: [],
      sort: 70,
      createdAt: iso(60 * 12),
      updatedAt: iso(60 * 8),
    },
    {
      // 极端值（WP14 走查）：超长模型名，量「可用模型」「使用记录」的标识符列
      id: 8,
      name: 'deepseek-v4.1-flash-preview-2026q4',
      displayName: 'DeepSeek V4.1 Flash 预览版',
      enabled: true,
      visibility: 'all',
      price: {
        inputMicro: 1_200_000,
        outputMicro: 2_400_000,
        cacheReadMicro: 120_000,
        cacheWriteMicro: null,
        perRequestMicro: 0,
      },
      info: {
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        input: ['text', 'image'],
        reasoningEfforts: ['low', 'high'],
      },
      defaultThinking: 'high',
      compat: { supportsReasoning: true },
      routes: [route(111, channelOf(3), 'deepseek-v4.1-flash-preview-2026q4')],
      apis: ['openai-completions'],
      sort: 15,
      createdAt: iso(60 * 24 * 5),
      updatedAt: iso(60 * 4),
    },
  ]

  // WP12b：`?mock=admin-empty-dsh` 用来看「下发到 DSH」的空状态（一个对外模型都没有）
  const finalModels = scenario === 'admin-empty-dsh' ? [] : models

  for (const channel of channels) {
    channel.modelCount = finalModels.filter((model) =>
      model.routes.some((r) => r.channelId === channel.id),
    ).length
  }

  const walletSeeds = new Map<number, (typeof WALLET_SEEDS)[number]>()
  for (const seed of WALLET_SEEDS) walletSeeds.set(seed.id, { ...seed })
  if (!walletSeeds.has(currentUserId)) {
    walletSeeds.set(currentUserId, {
      id: currentUserId,
      username: mockState.user.username,
      displayName: mockState.user.displayName,
      ...CURRENT_USER_WALLET,
      // 算力租赁场景里余额要与 `/api/me/compute` 一致（13 §1：同一个钱包）
      balanceMicro: mockComputeWalletMicro(scenario),
    })
  }

  const users = mockUsers(
    currentUserId,
    mockState.user.username,
    mockState.user.displayName,
    mockState.user.avatarUrl,
  )

  const ledger = buildLedger(walletSeeds, currentUserId)

  const result: RelayMockState = {
    scenario,
    settings: {
      enabled,
      signupBonusMicro: 5_000_000,
      dailyBonusMicro: 0,
      defaultMaxConcurrency: 4,
      maxAttempts: 3,
      keyCooldownSeconds: 60,
      channelFailureThreshold: 5,
      channelCooldownSeconds: 60,
      logRetentionDays: 90,
    },
    channels,
    models: finalModels,
    ledger,
    logs: [],
    keys: makeKeys(),
    users,
    walletSeeds,
    dayCache: new Map(),
    nextChannelId: 100,
    nextChannelKeyId: 500,
    nextKeyId: 5,
    nextLedgerId: ledger.length + 1,
    nextModelId: 9,
    nextRouteId: 200,
    nextUsageId: 1,
    secretCounter: 1,
    // 假配置：选中 deepseek@upstream-c（渠道后来停用 → 已选中但被阻断）、deepseek@upstream-b、
    // qwen3-coder@upstream-b；默认 = deepseek@upstream-b（16 §1 的生产形状）
    dshModelIds: finalModels.some((model) => model.id === 1)
      ? [
          ...new Set(
            finalModels
              .filter((model) => model.routes.some((item) => [101, 102, 103, 108].includes(item.id)))
              .map((model) => model.id),
          ),
        ]
      : [],
    dshDefaultModelId: finalModels.some((model) => model.id === 1) ? 1 : null,
    dshRouteIds: finalModels.some((model) => model.id === 1) ? [103, 101, 102, 108] : [],
    dshDefaultRouteId: finalModels.some((model) => model.id === 1) ? 102 : null,
    dshRevision: 12,
    dshUpdatedAt: finalModels.length > 0 ? iso(30) : null,
    // docs/22 §3：桌面默认预设 = 云上预设的一个子集（生产上由迁移 124 生成，之后两套独立）
    desktopDshModelIds: finalModels.some((model) => model.id === 1) ? [1, 3] : [],
    desktopDshDefaultModelId: finalModels.some((model) => model.id === 1) ? 1 : null,
    desktopDshRouteIds: finalModels.some((model) => model.id === 1) ? [102, 106] : [],
    desktopDshDefaultRouteId: finalModels.some((model) => model.id === 1) ? 102 : null,
    desktopDshRevision: 3,
    desktopDshUpdatedAt: finalModels.length > 0 ? iso(20) : null,
    desktopDshPending: false,
    // 模型基线 + 一次统一下发之后的样子：清单 #3 由 admin 写入（null = 还没下发过）
    desktopDshLastDelivery:
      finalModels.length > 0 ? { revision: 3, at: iso(60 * 20), by: 'admin' } : null,
  }

  result.logs = buildUsageLogs(result)
  return result
}

function buildLedger(
  seeds: Map<number, (typeof WALLET_SEEDS)[number]>,
  currentUserId: number,
): RelayLedgerRow[] {
  interface Seed {
    userId: number
    type: RelayLedgerRow['type']
    amountMicro: number
    note: string
    actor: string | null
    minutesAgo: number
  }

  const seedsList: Seed[] = [
    {
      userId: 2,
      type: 'signup',
      amountMicro: 5_000_000,
      note: '注册赠送',
      actor: null,
      minutesAgo: 60 * 24 * 26,
    },
    {
      userId: 4,
      type: 'grant',
      amountMicro: 50_000_000,
      note: '开号充值',
      actor: 'admin',
      minutesAgo: 60 * 24 * 14,
    },
    {
      userId: 5,
      type: 'grant',
      amountMicro: 10_000_000,
      note: '中秋加送',
      actor: 'admin',
      minutesAgo: 60 * 24 * 9,
    },
    {
      userId: 5,
      type: 'deduct',
      amountMicro: -5_000_000,
      note: '跑批量任务超量，回补一半',
      actor: 'admin',
      minutesAgo: 60 * 24 * 5,
    },
    {
      userId: 4,
      type: 'deduct',
      amountMicro: -3_000_000,
      note: '误用大模型扣回',
      actor: 'admin',
      minutesAgo: 60 * 24 * 3,
    },
    {
      userId: 1,
      type: 'grant',
      amountMicro: 200_000_000,
      note: '站长自用充值',
      actor: 'admin',
      minutesAgo: 60 * 24 * 2,
    },
    {
      userId: 2,
      type: 'grant',
      amountMicro: 20_000_000,
      note: '月度补贴',
      actor: 'admin',
      minutesAgo: 60 * 20,
    },
    {
      userId: 1,
      type: 'deduct',
      amountMicro: -1_500_000,
      note: '测试扣费流程',
      actor: 'admin',
      minutesAgo: 90,
    },
  ]

  // 用户端场景里「我自己」（id 12）也要有几条流水，不然 /usage 的积分流水永远是空的
  if (![1, 2, 4, 5].includes(currentUserId)) {
    // 四笔加起来正好等于这个用户的余额（12,345.67 积分，WP14a 起用 5 位数的极端值），看起来对得上账
    seedsList.unshift(
      {
        userId: currentUserId,
        type: 'grant',
        amountMicro: 12_337_010_000,
        note: '年度额度充值，够用一阵子了',
        actor: 'admin',
        minutesAgo: 60 * 24 * 30,
      },
      {
        userId: currentUserId,
        type: 'signup',
        amountMicro: 5_000_000,
        note: '注册赠送',
        actor: null,
        minutesAgo: 60 * 24 * 20,
      },
      {
        userId: currentUserId,
        type: 'daily',
        amountMicro: 600_000,
        note: '每日赠送',
        actor: null,
        minutesAgo: 60 * 3,
      },
      {
        userId: currentUserId,
        type: 'expire',
        amountMicro: -300_000,
        note: '昨日赠送未用完，作废',
        actor: null,
        minutesAgo: 60 * 26,
      },
      {
        userId: currentUserId,
        type: 'compute',
        amountMicro: -250_002,
        note: '4 核 8 GB 10 分钟 × 3',
        actor: null,
        minutesAgo: 120,
      },
      {
        userId: currentUserId,
        type: 'grant',
        amountMicro: 8_000_000,
        note: '管理员充值',
        actor: 'admin',
        minutesAgo: 60 * 24 * 6,
      },
      {
        userId: currentUserId,
        type: 'deduct',
        amountMicro: -4_340_000,
        note: '上个月超量，扣回一半',
        actor: 'admin',
        minutesAgo: 60 * 24,
      },
    )
  }

  const running = new Map<number, number>()
  for (const [id, seed] of seeds) running.set(id, seed.balanceMicro)

  // 从「当前余额」倒推每条流水之后的余额，保证最后一条读起来就是钱包余额
  const ascending = [...seedsList].sort((a, b) => b.minutesAgo - a.minutesAgo)
  const totals = new Map<number, number>()
  for (const seed of ascending) totals.set(seed.userId, (totals.get(seed.userId) ?? 0) + seed.amountMicro)

  const after = new Map<number, number>()
  for (const [userId, balance] of running) after.set(userId, balance - (totals.get(userId) ?? 0))

  return ascending.map((seed, index) => {
    const next = (after.get(seed.userId) ?? 0) + seed.amountMicro
    after.set(seed.userId, next)
    const user = ADMIN_USERS.find((item) => item.id === seed.userId)
    return {
      id: index + 1,
      userId: seed.userId,
      username: user?.username ?? `user${seed.userId}`,
      type: seed.type,
      amountMicro: seed.amountMicro,
      balanceAfterMicro: next,
      note: seed.note,
      actor: seed.actor,
      createdAt: iso(seed.minutesAgo),
    }
  })
}

/** 逐条用量：近 8 天、几十条，四种状态、含估算与重试，字段都有真实感。 */
function buildUsageLogs(mock: RelayMockState): MockUsageRow[] {
  const statuses: RelayUsageRow['status'][] = [
    'ok',
    'ok',
    'ok',
    'ok',
    'ok',
    'ok',
    'aborted',
    'upstream_error',
    'client_error',
  ]
  const apis: RelayUsageRow['api'][] = ['openai-completions', 'openai-completions', 'anthropic-messages']
  const sources: RelayUsageRow['source'][] = ['internal', 'internal', 'internal', 'local', 'public']
  const models = mock.models.filter((model) => model.enabled && model.apis.length > 0)
  const users = mock.users.filter((user) => mock.walletSeeds.has(user.id))

  const logs: MockUsageRow[] = []
  const random = rng(20261016)

  // `?mock=admin-empty-dsh` 没有任何对外模型：没有可记的用量，直接给空列表
  if (models.length === 0) return logs
  // WP24：`?mock=usage-empty` 要看清空状态，逐条记录也留空
  if (mock.scenario === 'usage-empty') return logs

  for (let index = 0; index < 46; index += 1) {
    const user = users[Math.floor(random() * users.length)] ?? users[0]!
    const model = models[Math.floor(random() * models.length)] ?? models[0]!
    const route = model.routes[Math.floor(random() * model.routes.length)]
    const channel = mock.channels.find((item) => item.id === route?.channelId)
    // 16 §3：用户可能用「模型@渠道」指定渠道，也可能用老名字让路由自动选
    const pinned = channel?.slug !== undefined && random() < 0.55
    const requestModel = pinned && channel?.slug ? pinnedModelName(model.name, channel.slug) : model.name
    const status = statuses[Math.floor(random() * statuses.length)] ?? 'ok'
    const api = apis[Math.floor(random() * apis.length)] ?? 'openai-completions'

    const inputTokens = 400 + Math.floor(random() * 26_000)
    const cacheReadTokens = Math.floor(random() * inputTokens * 0.6)
    const outputTokens = status === 'client_error' ? 0 : 60 + Math.floor(random() * 4_200)
    const cacheWriteTokens = Math.floor(random() * 2_000)
    const billable = status !== 'client_error' && status !== 'upstream_error'
    const ratePermille = billable && channel ? channel.ratePermille : null
    const costMicro = billable
      ? applyRate(
          estimateCost(model.price, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
          channel?.ratePermille ?? 1000,
        )
      : 0
    // 每 5 条留一条「按字数估算」的记录（12 §6.3），页面上能看清「估」小标
    const estimated = status !== 'client_error' && index % 5 === 0

    logs.push({
      id: index + 1,
      requestId: `req_${(index + 1).toString(36).padStart(6, '0')}${Math.floor(random() * 1e6).toString(36)}`,
      createdAt: iso(Math.floor(random() * 60 * 24 * 8)),
      userId: user.id,
      username: user.username,
      keyId: index % 5 === 0 ? null : (index % 3) + 1,
      keyName: index % 5 === 0 ? null : index % 3 === 0 ? 'DSH 内置密钥' : '本机 curl',
      model: requestModel,
      baseModel: model.name,
      pinned,
      upstreamModel: route?.upstreamModel ?? model.name,
      channelId: channel?.id ?? null,
      channelName: channel?.name ?? null,
      channelSlug: channel?.slug ?? null,
      channelRatePermille: ratePermille,
      api,
      stream: index % 7 !== 0,
      source: sources[Math.floor(random() * sources.length)] ?? 'internal',
      // docs/22 §1.3：每 4 条里有 1 条来自桌面设备（假接口按 client_kind 筛桌面来源）
      clientKind: index % 4 === 0 ? 'desktop' : 'docker',
      status,
      httpStatus: status === 'client_error' ? 400 : status === 'upstream_error' ? 502 : 200,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: Math.floor(outputTokens * 0.3),
      costMicro,
      estimated,
      attempts: status === 'upstream_error' ? 3 : 1,
      durationMs: 800 + Math.floor(random() * 40_000),
      ttftMs: 200 + Math.floor(random() * 3_000),
      error:
        status === 'client_error'
          ? 'model 参数不合法'
          : status === 'upstream_error'
            ? '上游暂时不可用（已尝试 3 个候选）'
            : null,
    })
  }

  // 极端值（WP14b 走查）：一条大 token、大额积分、长上游模型名的记录，看数字与单位会不会被拆行
  const flash = mock.models.find((model) => model.name === 'deepseek-v4.1-flash') ?? models[0]!
  const flashChannel = mock.channels.find((channel) => channel.id === flash.routes[0]?.channelId)
  const bigInput = 123_456_789
  const bigOutput = 98_765_432
  logs.push({
    id: 999,
    requestId: 'req_extreme_0001',
    createdAt: iso(1),
    userId: users[0]!.id,
    username: users[0]!.username,
    keyId: 1,
    keyName: 'DSH 内置密钥',
    model: pinnedModelName(flash.name, flashChannel?.slug ?? 'upstream-b'),
    baseModel: flash.name,
    pinned: true,
    upstreamModel: 'deepseek-v4.1-flash-preview-2026-10-16-internal',
    channelId: flashChannel?.id ?? null,
    channelName: flashChannel?.name ?? null,
    channelSlug: flashChannel?.slug ?? null,
    channelRatePermille: flashChannel?.ratePermille ?? 1000,
    api: 'openai-completions',
    stream: true,
    source: 'internal',
    status: 'ok',
    httpStatus: 200,
    inputTokens: bigInput,
    outputTokens: bigOutput,
    cacheReadTokens: 12_345_678,
    cacheWriteTokens: 1_234_567,
    reasoningTokens: 29_629_629,
    costMicro: applyRate(
      estimateCost(flash.price, bigInput, bigOutput, 12_345_678, 1_234_567),
      flashChannel?.ratePermille ?? 1000,
    ),
    estimated: false,
    attempts: 3,
    durationMs: 987_654,
    ttftMs: 12_345,
    error: null,
  })

  // 极端值（WP14a 走查）：一条超长错误信息，量状态列的换行与省略；归属「我」才能在自己页面看到
  const me = users.find((user) => user.id === getMockState().user.id) ?? users[0]
  const errorModel = models[0]!
  if (me) {
    logs.push({
      id: logs.length + 1,
      requestId: 'req_long_error_0001',
      createdAt: iso(35),
      userId: me.id,
      username: me.username,
      keyId: 2,
      keyName: '本机 curl',
      model: errorModel.name,
      baseModel: errorModel.name,
      pinned: false,
      upstreamModel: errorModel.routes[0]?.upstreamModel ?? errorModel.name,
      channelId: errorModel.routes[0]?.channelId ?? null,
      channelName:
        mock.channels.find((channel) => channel.id === errorModel.routes[0]?.channelId)?.name ?? null,
      channelSlug:
        mock.channels.find((channel) => channel.id === errorModel.routes[0]?.channelId)?.slug ?? null,
      channelRatePermille: null,
      api: 'openai-completions',
      stream: true,
      source: 'internal',
      status: 'upstream_error',
      httpStatus: 502,
      inputTokens: 18_400,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costMicro: 0,
      estimated: false,
      attempts: 3,
      durationMs: 30_000,
      ttftMs: null,
      error:
        '上游暂时不可用（已尝试 3 个候选）：connect ETIMEDOUT 10.213.0.9:8443；最后一个候选 30 秒内没有响应，请稍后再试或联系管理员。',
    })
  }

  // 兜底：随机结果里必须同时有带 @ 和不带 @ 的记录（任务书 mock 要求，页面走查要看两种）
  if (!logs.some((row) => row.model.includes(RELAY_PINNED_MODEL_SEPARATOR))) {
    const row = logs[0]
    if (row?.baseModel) row.model = pinnedModelName(row.baseModel, 'upstream-b')
  }
  if (!logs.some((row) => !row.model.includes(RELAY_PINNED_MODEL_SEPARATOR))) {
    const row = logs[1]
    if (row?.baseModel) row.model = row.baseModel
  }

  return logs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function estimateCost(
  price: RelayPrice,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const raw =
    inputTokens * price.inputMicro +
    cacheReadTokens * (price.cacheReadMicro ?? price.inputMicro) +
    cacheWriteTokens * (price.cacheWriteMicro ?? price.inputMicro) +
    outputTokens * price.outputMicro
  return Math.ceil(raw / 1_000_000) + price.perRequestMicro
}

// ── 日汇总的假格子（近 92 天，按天缓存）────────────────────────────────────

function cellsForDay(mock: RelayMockState, day: string): UsageCell[] {
  const cached = mock.dayCache.get(day)
  if (cached) return cached

  // WP24：`?mock=usage-empty` 用来看「开通了但区间内没有用量」的空状态
  if (mock.scenario === 'usage-empty') {
    mock.dayCache.set(day, [])
    return []
  }

  // 假数据只造最近 92 天：92 天以前（例如契约测试里的 2026-01）当作没有用量，
  // 这样空状态与 from/to 的边界都能在走查里看到。
  if (day > shanghaiDay() || day < shanghaiDay(91)) {
    mock.dayCache.set(day, [])
    return []
  }

  // 19 §2.2：留几天完全没有用量，用来检查折线断点 / 堆叠空档与「有几天全 0」
  if (isQuietDay(day)) {
    mock.dayCache.set(day, [])
    return []
  }

  const index = dayToIndex(day)
  const random = rng(index + 1013)
  const weekday = new Date(index * 86_400_000 + SHANGHAI_OFFSET_MS).getUTCDay()
  const weekend = weekday === 0 || weekday === 6
  const cells: UsageCell[] = []

  const pool = mock.models.filter(
    (model) => model.enabled && model.apis.length > 0 && model.price.inputMicro >= 0,
  )
  const users = mock.users.filter((user) => mock.walletSeeds.has(user.id))
  const activity = weekend ? 0.75 : 0.55

  for (const user of users) {
    if (random() > activity) continue
    const buzz = random()
    if (buzz > 0.92) continue

    for (const model of pool) {
      if (random() > 0.45) continue
      const route = model.routes.find(
        (item) => item.enabled && mock.channels.some((c) => c.id === item.channelId && c.enabled),
      )
      if (!route) continue

      // 一次批量任务的日子：数值有起伏，但不像 9 位 token 那样把整张图压成一条平线
      const requests = 8 + Math.floor(random() * 72)
      const inputTokens = requests * (900 + Math.floor(random() * 9_000))
      const cacheReadTokens = Math.floor(inputTokens * random() * 0.7)
      const cacheWriteTokens = Math.floor(random() * requests * 1_200)
      const outputTokens = requests * (120 + Math.floor(random() * 1_600))
      const errors = random() > 0.85 ? 1 : 0
      const channel = mock.channels.find((item) => item.id === route.channelId)
      const costMicro = applyRate(
        estimateCost(model.price, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
        channel?.ratePermille ?? 1000,
      )
      // 16 §3：按模型统计按请求时的原始名字分组，所以 @ 与不带 @ 都要有
      const usageModel =
        channel?.slug && random() < 0.55 ? pinnedModelName(model.name, channel.slug) : model.name

      cells.push({
        userId: user.id,
        model: usageModel,
        channelId: route.channelId,
        requests,
        errors,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costMicro,
      })
    }
  }

  // 一次「批量任务」：3 天前给「我」多一份明显的峰值，图上能看出起伏；
  // 量级控制在一屏可读的范围（不再用 9 位 token 把其他日子压成平线）。
  const meId = getMockState().user.id
  if (day === shanghaiDay(3) && mock.walletSeeds.has(meId)) {
    const spikePrice = mock.models.find((model) => model.name === 'deepseek-v4.1-flash')?.price
    if (spikePrice) {
      const inputTokens = 5_400_000
      const outputTokens = 620_000
      const cacheReadTokens = 1_200_000
      const cacheWriteTokens = 60_000
      cells.push({
        userId: meId,
        model: 'deepseek-v4.1-flash@upstream-b',
        channelId: 2,
        requests: 40,
        errors: 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costMicro: estimateCost(spikePrice, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
      })
    }
  }

  mock.dayCache.set(day, cells)
  return cells
}

function emptyBucket(): RelayUsageBucket {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicro: 0,
  }
}

function addCell(bucket: RelayUsageBucket, cell: UsageCell): RelayUsageBucket {
  return {
    requests: bucket.requests + cell.requests,
    errors: bucket.errors + cell.errors,
    inputTokens: bucket.inputTokens + cell.inputTokens,
    outputTokens: bucket.outputTokens + cell.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens + cell.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens + cell.cacheWriteTokens,
    costMicro: bucket.costMicro + cell.costMicro,
  }
}

function cellsInRange(mock: RelayMockState, from: string, to: string, userId?: number): UsageCell[] {
  const cells: UsageCell[] = []
  for (const day of dayRange(from, to)) {
    for (const cell of cellsForDay(mock, day)) {
      if (userId !== undefined && cell.userId !== userId) continue
      cells.push(cell)
    }
  }
  return cells
}

function sumCells(cells: UsageCell[]): RelayUsageBucket {
  return cells.reduce(addCell, emptyBucket())
}

/** 用户端的钱包行（含今日 / 本月消耗，12 §9）。 */
function walletRow(mock: RelayMockState, userId: number): RelayWalletRow | null {
  const seed = mock.walletSeeds.get(userId)
  const user = mock.users.find((item) => item.id === userId)
  if (!seed || !user) return null

  const today = sumCells(cellsInRange(mock, shanghaiDay(), shanghaiDay(), userId))
  const month = sumCells(cellsInRange(mock, monthStartDay(), shanghaiDay(), userId))

  return {
    userId,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    balanceMicro: seed.balanceMicro,
    ratePercent: seed.ratePercent,
    maxConcurrency: seed.maxConcurrency,
    dailyLimitMicro: seed.dailyLimitMicro,
    enabled: seed.enabled,
    totalSpentMicro: seed.totalSpentMicro,
    lastUsedAt: iso(3),
    todayCostMicro: today.costMicro,
    monthCostMicro: month.costMicro,
    monthRequests: month.requests,
    dailyBonusLeftMicro: seed.dailyBonusLeftMicro ?? 0,
  }
}

/** 没有钱包行的用户按默认值显示（12 §6.4：GET 不写库）。 */
function defaultWalletRow(mock: RelayMockState, userId: number): RelayWalletRow | null {
  const user = mock.users.find((item) => item.id === userId)
  if (!user) return null
  return {
    userId,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    balanceMicro: 0,
    ratePercent: 100,
    maxConcurrency: null,
    dailyLimitMicro: null,
    enabled: true,
    totalSpentMicro: 0,
    lastUsedAt: null,
    todayCostMicro: 0,
    monthCostMicro: 0,
    monthRequests: 0,
    dailyBonusLeftMicro: 0,
  }
}

function myRelayResponse(mock: RelayMockState): MyRelayResponse {
  const userId = getMockState().user.id
  const wallet = walletRow(mock, userId) ?? defaultWalletRow(mock, userId)!

  /** 模型启用路由所在「启用渠道」的倍率范围；没有可用路由 = null（12 §9） */
  const rateRangeOf = (model: RelayModel): { minPermille: number; maxPermille: number } | null => {
    const rates = model.routes
      .filter((route) => route.enabled)
      .map((route) => mock.channels.find((channel) => channel.id === route.channelId))
      .filter((channel): channel is RelayChannel => channel !== undefined && channel.enabled)
      .map((channel) => channel.ratePermille)
    if (rates.length === 0) return null
    return { minPermille: Math.min(...rates), maxPermille: Math.max(...rates) }
  }

  const models: MyRelayModel[] = mock.models
    .filter((model) => model.enabled && model.visibility === 'all' && model.apis.length > 0)
    .map((model) => {
      // 16 §4.1：只给启用渠道上的启用路由；渠道名称 / 地址 / 成本不出现在用户接口里
      const routes = model.routes
        .filter((route) => route.enabled)
        .map((route) => ({ route, channel: mock.channels.find((item) => item.id === route.channelId) }))
        .filter(
          (entry): entry is { route: RelayRoute; channel: RelayChannel } =>
            entry.channel !== undefined && entry.channel.enabled && entry.channel.slug !== undefined,
        )
        .map(({ route, channel }) => ({
          channelSlug: channel.slug!,
          ratePermille: channel.ratePermille,
          pinnedModel: pinnedModelName(model.name, channel.slug!),
          // 选中且这条路由当前能下发，才算用户的 DSH 里看得到
          inDsh: mock.dshRouteIds.includes(route.id) && routeBlockedReason(model, route, channel) === null,
          dshDefault: mock.dshDefaultRouteId === route.id,
        }))

      return {
        name: model.name,
        displayName: model.displayName,
        apis: model.apis,
        price: model.price,
        channelRate: rateRangeOf(model),
        info: model.info,
        // 15 §3.2：任一路由在 DSH 中 = 模型级「在 DSH 中」
        inDsh: routes.some((route) => route.inDsh),
        dshDefault: routes.some((route) => route.dshDefault),
        routes,
      }
    })

  const today = sumCells(cellsInRange(mock, shanghaiDay(), shanghaiDay(), userId))
  const month = sumCells(cellsInRange(mock, monthStartDay(), shanghaiDay(), userId))

  return {
    enabled: mock.settings.enabled && wallet.enabled,
    wallet,
    today,
    month,
    publicBaseUrl: 'https://hub.example.com:8123/v1',
    dshAttached: mock.settings.enabled,
    models: mock.settings.enabled ? models : [],
    // 18 §7：对我开通的对话模式（没开通的不出现）
    agentModes: mock.settings.enabled ? mockMyAgentModes() : undefined,
  }
}

// ── 下发到 DSH（WP12b，12 §7.0 §10）─────────────────────────────────────────

/** 一条路由渲染成 DSH 模型时用的协议 = 模型可用接口 ∩ 渠道 apis，再看偏好顺序 */
function routeDeliverApi(model: RelayModel, channel: RelayChannel): ModelApi | null {
  for (const api of RELAY_DSH_API_PREFERENCE) {
    if (model.apis.includes(api) && channel.apis.includes(api)) return api
  }
  return null
}

/** 路由级阻断原因（16 §6.1 的四种）：模型停用 / 渠道停用 / 路由停用 / 没有共同协议 */
function routeBlockedReason(model: RelayModel, route: RelayRoute, channel: RelayChannel): string | null {
  if (!model.enabled) return '模型已停用'
  if (!channel.enabled) return '渠道已停用'
  if (!route.enabled) return '路由已停用'
  if (routeDeliverApi(model, channel) === null) return '模型和渠道没有共同支持的协议'
  return null
}

/** 可用路由 = 路由启用、渠道启用，且有共同支持的协议 */
function availableRoutes(mock: RelayMockState, model: RelayModel): RelayRoute[] {
  return model.routes.filter((route) => {
    const channel = mock.channels.find((item) => item.id === route.channelId)
    return channel !== undefined && routeBlockedReason(model, route, channel) === null
  })
}

function blockedReasonOf(mock: RelayMockState, model: RelayModel): string | null {
  if (!model.enabled) return '已停用'
  if (availableRoutes(mock, model).length === 0) return '没有可用渠道'
  return null
}

function dshModelRow(mock: RelayMockState, model: RelayModel, selectedRouteIds: number[]): RelayDshModel {
  const routes: RelayDshRoute[] = model.routes.map((route) => {
    const channel = mock.channels.find((item) => item.id === route.channelId)
    return {
      routeId: route.id,
      channelId: route.channelId,
      channelName: channel?.name ?? `#${route.channelId}`,
      channelSlug: channel?.slug ?? `ch-${route.channelId}`,
      ratePermille: channel?.ratePermille ?? route.channelRatePermille,
      deliverApi: channel ? routeDeliverApi(model, channel) : null,
      selected: selectedRouteIds.includes(route.id),
      blockedReason: channel ? routeBlockedReason(model, route, channel) : '渠道已停用',
    }
  })
  const usable = routes.filter((row) => row.blockedReason === null)
  const blocked = blockedReasonOf(mock, model)
  return {
    id: model.id,
    name: model.name,
    displayName: model.displayName,
    enabled: model.enabled,
    visibility: model.visibility,
    apis: model.apis,
    deliverApi: usable[0]?.deliverApi ?? null,
    channelNames: [...new Set(usable.map((item) => item.channelName))],
    // 只认「声明过、且能生效」的档位（12 §7.0：设了但不生效 = null，warnings 里提示）
    defaultThinking: effectiveDshThinking(model.info, model.defaultThinking),
    price: model.price,
    priced: !isUnpricedModel(model),
    selected: routes.some((row) => row.selected),
    routes,
    blockedReason: blocked,
  }
}

/** `GET/PUT /api/admin/relay/dsh` 的响应（照契约现算，选中集合来自假状态） */
function dshResponse(mock: RelayMockState, platform: 'cloud' | 'desktop' = 'cloud'): RelayDshResponse {
  const selectedRouteIds = platform === 'desktop' ? mock.desktopDshRouteIds : mock.dshRouteIds
  const defaultRouteId = platform === 'desktop' ? mock.desktopDshDefaultRouteId : mock.dshDefaultRouteId
  const models = mock.models.map((model) => dshModelRow(mock, model, selectedRouteIds))
  const selectedRoutes = models.flatMap((model) =>
    (model.routes ?? []).filter((route) => route.selected).map((route) => ({ model, route })),
  )
  const lastJob = platform === 'desktop' ? null : latestMockModelsRollout()
  const updatedAt = platform === 'desktop' ? mock.desktopDshUpdatedAt : mock.dshUpdatedAt

  const pending =
    platform === 'desktop'
      ? mock.desktopDshPending
      : selectedRoutes.length > 0 &&
        (lastJob === null || updatedAt === null || Date.parse(updatedAt) > Date.parse(lastJob.createdAt))

  const warnings: string[] = []
  for (const { model, route } of selectedRoutes) {
    if (route.blockedReason) {
      warnings.push(
        `「${pinnedModelName(model.name, route.channelSlug)}」${route.blockedReason}，暂时不会下发到用户的 DSH`,
      )
    }
  }
  // WP13：设了默认思考档位、但模型的 info 里没有声明它 → 当作没设（12 §7.0，文案与后端一致）
  for (const model of models) {
    if (!model.selected) continue
    const source = mock.models.find((item) => item.id === model.id)
    if (source && source.defaultThinking !== null && model.defaultThinking === null) {
      warnings.push(
        `模型「${source.displayName}」的默认思考档位 ${source.defaultThinking} 不在它声明的档位里，没有生效`,
      )
    }
  }
  if (selectedRoutes.length > 0 && selectedRoutes.every(({ route }) => route.blockedReason !== null)) {
    warnings.push('选中的模型都不能下发，请检查渠道与模型是否启用')
  }

  const defaultModelIdOf = platform === 'desktop' ? mock.desktopDshDefaultModelId : mock.dshDefaultModelId
  const revision = platform === 'desktop' ? mock.desktopDshRevision : mock.dshRevision
  const defaultRoute = selectedRoutes.find(({ route }) => route.routeId === defaultRouteId)?.route ?? null

  return {
    // 契约的 `platform`：桌面侧读的是桌面预设（docs/22 §3，WP32c 做按平台读写）
    platform,
    models,
    defaultModelId: defaultRoute
      ? (models.find((model) => (model.routes ?? []).some((route) => route.routeId === defaultRoute.routeId))
          ?.id ?? defaultModelIdOf)
      : defaultModelIdOf,
    defaultRouteId,
    revision,
    updatedAt,
    pending,
    lastRollout: platform === 'desktop' || !lastJob ? null : { jobId: lastJob.id, status: lastJob.status, createdAt: lastJob.createdAt },
    // docs/22 §3：桌面模型配置的「上次下发」= 最近一次写入桌面模型片段的清单版本（云上不给这个键）
    ...(platform === 'desktop' ? { lastDelivery: mock.desktopDshLastDelivery } : {}),
    users: { total: mock.users.length, running: Math.min(3, mock.users.length) },
    warnings,
  }
}

// ── 概览 ────────────────────────────────────────────────────────────────────

function overviewResponse(mock: RelayMockState): RelayOverviewResponse {
  const today = sumCells(cellsInRange(mock, shanghaiDay(), shanghaiDay()))
  const month = sumCells(cellsInRange(mock, monthStartDay(), shanghaiDay()))
  const healthy = mock.channels.filter((channel) => channel.health === 'ok').length
  const unpriced = mock.models.filter((model) => model.enabled && isUnpricedModel(model))

  const alerts: RelayAlert[] = [
    {
      level: 'warn',
      kind: 'key-auto-disabled',
      message: '渠道「Upstream C 池」有 1 把密钥被自动停用（上游返回 401）',
      channelId: 1,
      at: iso(60 * 20),
    },
    {
      level: 'warn',
      kind: 'channel-cooling',
      message: '渠道「Upstream B」有 1 把密钥在冷却（429，还剩 42 秒）',
      channelId: 2,
      at: iso(60 * 8),
    },
    {
      level: 'error',
      kind: 'channel-no-key',
      message: '渠道「DeepSeek 官方」只剩 1 把可用密钥，注意别把它用挂',
      channelId: 3,
      at: null,
    },
    {
      level: 'warn',
      kind: 'usage-missing',
      message: '渠道「Upstream C 池」近 24 小时有 18% 的请求没拿到 usage，费用按估算计',
      channelId: 1,
      at: iso(60 * 3),
    },
    {
      level: 'warn',
      kind: 'models-changed',
      message: '有 2 个对外模型发生变化，需要下发到用户的 DSH',
      channelId: null,
      at: iso(60 * 5),
    },
    ...(unpriced.length > 0
      ? [
          {
            level: 'warn' as const,
            kind: 'models-unpriced',
            message: `${unpriced.length} 个模型还没定价（按 0 计费）：${unpriced
              .slice(0, 5)
              .map((model) => model.name)
              .join('、')}`,
            channelId: null,
            at: iso(60 * 11),
          },
        ]
      : []),
  ]

  if (!mock.settings.enabled) {
    alerts.unshift({
      level: 'error',
      kind: 'internal-listener-down',
      message: '中转站已关闭：/v1 一律返回 503，用户页隐藏',
      channelId: null,
      at: iso(1),
    })
  }

  return {
    enabled: mock.settings.enabled,
    internalBaseUrl: mock.settings.enabled ? 'http://10.213.0.1:7710/v1' : null,
    internalListening: mock.settings.enabled,
    today,
    month,
    inFlight: mock.settings.enabled ? 2 : 0,
    totalBalanceMicro: [...mock.walletSeeds.values()].reduce((sum, seed) => sum + seed.balanceMicro, 0),
    channels: {
      total: mock.channels.length,
      ok: healthy,
      unhealthy: mock.channels.length - healthy,
    },
    models: {
      total: mock.models.length,
      enabled: mock.models.filter((model) => model.enabled).length,
    },
    alerts,
  }
}

// ── 分页 ────────────────────────────────────────────────────────────────────

function pageOf<T>(items: T[], url: URL): { items: T[]; total: number; page: number; pageSize: number } {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20') || 20))
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize }
}

/** 区间统计（12 §9；用户端 `byUser`/`byChannel` 为空数组）。 */
function statsResponse(
  mock: RelayMockState,
  url: URL,
  options: { userScoped: boolean },
): {
  from: string
  to: string
  total: RelayUsageBucket
  daily: RelayDayBucket[]
  byModel: (RelayUsageBucket & { model: string })[]
  byUser: (RelayUsageBucket & { userId: number; username: string })[]
  byChannel: (RelayUsageBucket & { channelId: number; channelName: string })[]
  byScope: (RelayUsageBucket & { scope: RelayScope })[]
  dailyByModel: (RelayUsageBucket & { day: string; model: string })[]
} {
  const to = url.searchParams.get('to') ?? shanghaiDay()
  const defaultFrom = shanghaiDay(29)
  let from = url.searchParams.get('from') ?? defaultFrom
  if (dayToIndex(from) < dayToIndex(to) - 91)
    from = new Date(dayToIndex(to) * 86_400_000 - 91 * 86_400_000).toISOString().slice(0, 10)

  const requestedUser = Number(url.searchParams.get('userId') ?? '') || undefined
  const userId = options.userScoped ? getMockState().user.id : requestedUser

  // 18 D7：来源筛选（省略 = 全部来源）；两个模式的记录在 mocks/agent-modes.ts 里
  const scopeParam = url.searchParams.get('scope')
  const scopeFilter =
    scopeParam === 'dsh' || scopeParam === 'claude-code' || scopeParam === 'codex' ? scopeParam : null
  const cellOf = (row: RelayUsageRow): UsageCell => ({
    userId: row.userId,
    model: row.model,
    channelId: row.channelId ?? 0,
    requests: 1,
    errors: row.status === 'ok' ? 0 : 1,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costMicro: row.costMicro,
  })
  /**
   * docs/22 §1.3：按**用量来源**筛选（桌面视图默认带 `clientKind=desktop`）。与后端一致 ——
   * 日汇总表 `relay_usage_daily` 没有来源列（迁移 088），所以带 clientKind 时回落到明细记录聚合。
   */
  const clientKindParam = url.searchParams.get('clientKind')
  const detailCellsByDay = new Map<string, UsageCell[]>()
  if (clientKindParam) {
    for (const row of mock.logs) {
      if (((row as MockUsageRow).clientKind ?? 'docker') !== clientKindParam) continue
      if (userId !== undefined && row.userId !== userId) continue
      if (scopeFilter && (row.scope ?? 'dsh') !== scopeFilter) continue
      const day = row.createdAt.slice(0, 10)
      if (day < from || day > to) continue
      const list = detailCellsByDay.get(day) ?? []
      list.push(cellOf(row))
      detailCellsByDay.set(day, list)
    }
  }
  const cells = clientKindParam
    ? [...detailCellsByDay.values()].flat()
    : cellsInRange(mock, from, to, userId)

  // `usage-empty` 连 Claude Code / Codex 的来源记录也清掉，整页才是真正的空状态
  const modeRows = clientKindParam
    ? []
    : (mock.scenario === 'usage-empty' ? [] : mockAgentModeUsageRows())
        .filter((row) => !isQuietDay(row.createdAt.slice(0, 10)))
        .filter((row) => (userId === undefined ? true : row.userId === userId))
        .filter((row) => (scopeFilter ? (row.scope ?? 'dsh') === scopeFilter : (row.scope ?? 'dsh') !== 'dsh'))
        .filter((row) => row.createdAt.slice(0, 10) >= from && row.createdAt.slice(0, 10) <= to)
  const modeCells: UsageCell[] = modeRows.map(cellOf)
  const dshCells = scopeFilter && scopeFilter !== 'dsh' ? [] : cells
  const allCells = [...dshCells, ...modeCells]

  /** 某一天的全部格子（来源筛选已应用）——`daily` 与 `dailyByModel` 用同一份，保证合计一致 */
  const dayCells = (day: string): UsageCell[] =>
    clientKindParam
      ? (detailCellsByDay.get(day) ?? [])
      : [
          ...(scopeFilter && scopeFilter !== 'dsh'
            ? []
            : cellsForDay(mock, day).filter((cell) => (userId === undefined ? true : cell.userId === userId))),
          ...modeRows.filter((row) => row.createdAt.slice(0, 10) === day).map(cellOf),
        ]

  const byModelMap = new Map<string, RelayUsageBucket>()
  const byUserMap = new Map<number, RelayUsageBucket>()
  const byChannelMap = new Map<number, RelayUsageBucket>()
  const byScopeMap = new Map<RelayScope, RelayUsageBucket>()
  for (const cell of allCells) {
    byModelMap.set(cell.model, addCell(byModelMap.get(cell.model) ?? emptyBucket(), cell))
    byUserMap.set(cell.userId, addCell(byUserMap.get(cell.userId) ?? emptyBucket(), cell))
    byChannelMap.set(cell.channelId, addCell(byChannelMap.get(cell.channelId) ?? emptyBucket(), cell))
  }
  for (const cell of dshCells) {
    byScopeMap.set('dsh', addCell(byScopeMap.get('dsh') ?? emptyBucket(), cell))
  }
  for (const row of modeRows) {
    const scope = (row.scope ?? 'dsh') as RelayScope
    byScopeMap.set(scope, addCell(byScopeMap.get(scope) ?? emptyBucket(), cellOf(row)))
  }

  return {
    from,
    to,
    total: sumCells(allCells),
    daily: dayRange(from, to).map((day) => ({
      day,
      ...sumCells(dayCells(day)),
    })),
    // 19 §3：按「天 × 模型」的明细（只给有用量的格子；排序与后端一致：day 升序、同日积分降序）
    dailyByModel: dayRange(from, to).flatMap((day) => {
      const byModel = new Map<string, RelayUsageBucket>()
      for (const cell of dayCells(day)) {
        byModel.set(cell.model, addCell(byModel.get(cell.model) ?? emptyBucket(), cell))
      }
      return [...byModel.entries()]
        .map(([model, bucket]) => ({ day, model, ...bucket }))
        .sort((a, b) => b.costMicro - a.costMicro || a.model.localeCompare(b.model))
    }),
    byModel: [...byModelMap.entries()]
      .map(([model, bucket]) => ({ model, ...bucket }))
      .sort((a, b) => b.costMicro - a.costMicro),
    byUser: options.userScoped
      ? []
      : [...byUserMap.entries()]
          .map(([id, bucket]) => ({
            userId: id,
            username: mock.users.find((user) => user.id === id)?.username ?? `user${id}`,
            ...bucket,
          }))
          .sort((a, b) => b.costMicro - a.costMicro),
    byChannel: options.userScoped
      ? []
      : [...byChannelMap.entries()]
          .map(([id, bucket]) => ({
            channelId: id,
            channelName: mock.channels.find((channel) => channel.id === id)?.name ?? `#${id}`,
            ...bucket,
          }))
          .sort((a, b) => b.costMicro - a.costMicro),
    byScope: [...byScopeMap.entries()]
      .map(([scope, bucket]) => ({ scope, ...bucket }))
      .sort((a, b) => (a.scope === 'dsh' ? -1 : b.scope === 'dsh' ? 1 : a.scope.localeCompare(b.scope))),
  }
}

/**
 * 18 D7：按来源筛两个模式的记录（省略 = 全部来源）。
 * dsh 的记录在 `mock.logs` 里；这里只返回 claude-code / codex 的。
 */
function scopeMatchedModeRows(scope: string | null): RelayUsageRow[] {
  const rows = mockAgentModeUsageRows()
  if (scope === 'dsh' || scope === null) return []
  return rows.filter((row) => (row.scope ?? 'dsh') === scope)
}

// ── 用户端接口 ──────────────────────────────────────────────────────────────

/** `GET/POST/... /api/me/relay*`；未命中返回 null（交给其它假接口或真后端）。 */
export async function handleUserRelay(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Promise<Response | null> {
  if (!pathname.startsWith('/api/me/relay')) return null
  const mock = relayState()
  const userId = getMockState().user.id

  if (pathname === '/api/me/relay' && method === 'GET') return json(myRelayResponse(mock))

  if (pathname === '/api/me/relay/usage' && method === 'GET') {
    return json(statsResponse(mock, url, { userScoped: true }))
  }

  if (pathname === '/api/me/relay/logs' && method === 'GET') {
    const model = url.searchParams.get('model')
    const status = url.searchParams.get('status')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const scope = url.searchParams.get('scope')
    const source = mock.scenario === 'usage-empty' ? [] : [...mock.logs, ...scopeMatchedModeRows(scope)]
    const rows = source
      .filter((row) => !isQuietDay(row.createdAt.slice(0, 10)))
      .filter((row) => (scope ? (row.scope ?? 'dsh') === scope : true))
      .filter((row) => row.userId === userId)
      .filter((row) => (model ? row.model === model : true))
      .filter((row) => (status ? row.status === status : true))
      .filter((row) => (from ? row.createdAt.slice(0, 10) >= from : true))
      .filter((row) => (to ? row.createdAt.slice(0, 10) <= to : true))
      // 18 §7：用户端也带来源；渠道名照旧不给
      .map((row) => ({ ...row, scope: row.scope ?? 'dsh', channelId: null, channelName: null }))
    return json(pageOf(rows, url))
  }

  if (pathname === '/api/me/relay/ledger' && method === 'GET') {
    const rows = mock.ledger.filter((row) => row.userId === userId)
    return json(pageOf([...rows].reverse(), url))
  }

  if (pathname === '/api/me/relay/keys' && method === 'GET') return json(mock.keys)

  if (pathname === '/api/me/relay/keys' && method === 'POST') {
    const body = readJson(init)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return apiError('VALIDATION_FAILED', 400, '密钥名称不能为空')
    if (mock.keys.filter((key) => key.kind === 'user').length >= 10)
      return apiError('VALIDATION_FAILED', 400, '每人最多 10 把自建密钥')

    const secret = mockSecret((mock.secretCounter += 1))
    const key: RelayKey = {
      id: mock.nextKeyId++,
      kind: 'user',
      name,
      preview: previewOf(secret),
      enabled: true,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    }
    mock.keys = [...mock.keys, key]
    return json({ key, secret, needsRecreate: false }, 201)
  }

  const keyAction = /^\/api\/me\/relay\/keys\/(\d+)(\/rotate)?$/.exec(pathname)
  if (keyAction) {
    const keyId = Number(keyAction[1])
    const key = mock.keys.find((item) => item.id === keyId)
    if (!key) return apiError('NOT_FOUND', 404, '密钥不存在')

    if (keyAction[2] === '/rotate' && method === 'POST') {
      if (key.kind !== 'system') return apiError('VALIDATION_FAILED', 400, '只有 DSH 内置密钥可以重置')
      const secret = mockSecret((mock.secretCounter += 1))
      key.preview = previewOf(secret)
      key.createdAt = new Date().toISOString()
      return json({ key, secret, needsRecreate: true })
    }

    if (method === 'PATCH') {
      const body = readJson(init)
      if (typeof body.name === 'string' && body.name.trim()) key.name = body.name.trim()
      if (typeof body.enabled === 'boolean') {
        if (key.kind === 'system' && !body.enabled)
          return apiError('VALIDATION_FAILED', 400, 'DSH 内置密钥不能停用，想停请让管理员停钱包')
        key.enabled = body.enabled
      }
      return json({ key })
    }

    if (method === 'DELETE') {
      if (key.kind === 'system') return apiError('VALIDATION_FAILED', 400, 'DSH 内置密钥不能删除')
      mock.keys = mock.keys.filter((item) => item.id !== keyId)
      return noContent()
    }
  }

  return null
}

// ── 管理端接口 ──────────────────────────────────────────────────────────────

function discoverResponse(mock: RelayMockState, channelId: number): DiscoverRelayChannelResponse {
  const upstream = [
    {
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      input: ['text', 'image'] as const,
      reasoningEfforts: ['low', 'high', 'max'],
      infoSource: 'builtin' as const,
      matchedId: 'deepseek-v4.1-flash',
    },
    {
      id: 'deepseek-chat',
      name: 'DeepSeek V3',
      contextWindow: 131_072,
      maxTokens: 8_192,
      input: ['text'] as const,
      infoSource: 'builtin' as const,
      matchedId: 'deepseek-chat',
    },
    {
      id: 'qwen3-coder',
      name: 'qwen3-coder',
      contextWindow: 262_144,
      input: ['text'] as const,
      infoSource: 'upstream' as const,
    },
    { id: 'glm-4.7', name: 'glm-4.7', infoSource: undefined },
    {
      id: 'kimi-k2',
      name: 'kimi-k2',
      contextWindow: 262_144,
      input: ['text'] as const,
      infoSource: undefined,
    },
    {
      id: 'claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      contextWindow: 200_000,
      maxTokens: 32_000,
      input: ['text', 'image'] as const,
      infoSource: 'builtin' as const,
      matchedId: 'claude-haiku-4.5',
    },
    {
      // 极端值（WP14b 走查）：长上游模型 id 与长显示名
      id: 'deepseek-v4.1-flash-preview-2026-10-16-internal',
      name: 'DeepSeek V4.1 Flash 预览版（内部灰度线路，仅供家人使用）',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      input: ['text'] as const,
      infoSource: 'upstream' as const,
    },
    { id: 'gpt-5-mini', name: 'gpt-5-mini', infoSource: undefined },
    {
      id: 'o3-mini',
      name: 'o3-mini',
      contextWindow: 200_000,
      input: ['text'] as const,
      infoSource: undefined,
    },
  ]

  const channel = mock.channels.find((item) => item.id === channelId)
  return {
    models: upstream.map((model) => ({
      ...model,
      input: model.input ? [...model.input] : undefined,
      existingModelId: channel ? (mock.models.find((item) => item.name === model.id)?.id ?? null) : null,
    })),
  }
}

/**
 * 管理端假接口（`?mock=admin`）。命中返回 `Response`，未命中返回 `null`。
 */
export async function handleAdminRelay(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Promise<Response | null> {
  if (!pathname.startsWith('/api/admin/relay')) return null
  const mock = relayState()

  // 概览 / 设置
  if (pathname === '/api/admin/relay/overview' && method === 'GET') return json(overviewResponse(mock))

  // 模型配置（WP12b / docs/22 §3）：GET 看状态；PUT 真改选中集合与默认（只保存，不下发）。
  // `?platform=desktop` 读写另一套系统预设；缺省 = 云上（实例）。
  if (pathname === '/api/admin/relay/dsh') {
    const platform = url.searchParams.get('platform') === 'desktop' ? 'desktop' : 'cloud'
    if (method === 'GET') return json(dshResponse(mock, platform))

    if (method === 'PUT') {
      const body = readJson(init)
      const byRoute = Array.isArray(body.routeIds) || body.defaultRouteId !== undefined

      const findRoute = (routeId: number) => {
        for (const model of mock.models) {
          const route = model.routes.find((item) => item.id === routeId)
          if (!route) continue
          const channel = mock.channels.find((item) => item.id === route.channelId)
          return channel ? { model, route, channel } : null
        }
        return null
      }

      const currentRouteIds = platform === 'desktop' ? mock.desktopDshRouteIds : mock.dshRouteIds

      if (byRoute) {
        const ids = Array.isArray(body.routeIds) ? body.routeIds.map((id) => Number(id)) : []
        const defaultRaw = body.defaultRouteId
        const defaultRouteId = defaultRaw === null || defaultRaw === undefined ? null : Number(defaultRaw)

        if (ids.length === 0 && defaultRouteId !== null) {
          return apiError('VALIDATION_FAILED', 400, '一个路由都不选时默认必须为空')
        }
        if (defaultRouteId !== null && !ids.includes(defaultRouteId)) {
          return apiError('VALIDATION_FAILED', 400, '默认项必须是选中的路由之一')
        }
        for (const id of ids) {
          const found = findRoute(id)
          if (!found) return apiError('NOT_FOUND', 404, `路由 #${id} 不存在`)
          const blocked = routeBlockedReason(found.model, found.route, found.channel)
          // 已选中、后来才被阻断的路由照常接受；只有「新勾上」的拒绝
          if (blocked && !currentRouteIds.includes(id)) {
            return apiError(
              'VALIDATION_FAILED',
              400,
              `「${pinnedModelName(found.model.name, found.channel.slug ?? found.channel.name)}」${blocked}，不能下发`,
            )
          }
        }

        const modelIds = [
          ...new Set(
            ids
              .map((id) => findRoute(id)?.model.id)
              .filter((value): value is number => typeof value === 'number'),
          ),
        ]
        const defaultModelId = defaultRouteId ? (findRoute(defaultRouteId)?.model.id ?? null) : null
        if (platform === 'desktop') {
          mock.desktopDshRouteIds = [...new Set(ids)]
          mock.desktopDshDefaultRouteId = defaultRouteId
          mock.desktopDshModelIds = modelIds
          mock.desktopDshDefaultModelId = defaultModelId
          mock.desktopDshRevision += 1
          mock.desktopDshUpdatedAt = new Date().toISOString()
          mock.desktopDshPending = true
        } else {
          mock.dshRouteIds = [...new Set(ids)]
          mock.dshDefaultRouteId = defaultRouteId
          mock.dshModelIds = modelIds
          mock.dshDefaultModelId = defaultModelId
          mock.dshRevision += 1
          mock.dshUpdatedAt = new Date().toISOString()
        }
        return json(dshResponse(mock, platform))
      }

      // 老写法：modelIds + defaultModelId = 选中这些模型的全部路由
      const ids = Array.isArray(body.modelIds) ? body.modelIds.map((id) => Number(id)) : []
      const defaultRaw = body.defaultModelId
      const defaultModelId = defaultRaw === null || defaultRaw === undefined ? null : Number(defaultRaw)

      if (ids.length === 0 && defaultModelId !== null) {
        return apiError('VALIDATION_FAILED', 400, '一个模型都不选时默认模型必须为空')
      }
      if (defaultModelId !== null && !ids.includes(defaultModelId)) {
        return apiError('VALIDATION_FAILED', 400, '默认模型必须是选中的模型之一')
      }
      for (const id of ids) {
        const model = mock.models.find((item) => item.id === id)
        if (!model) return apiError('NOT_FOUND', 404, `模型 #${id} 不存在`)
        const blocked = blockedReasonOf(mock, model)
        // 已选中的模型后来被停用 / 没了路由：保留选中（12 §7.0），只有「新勾上」的才拒绝
        if (blocked && !(platform === 'desktop' ? mock.desktopDshModelIds : mock.dshModelIds).includes(id)) {
          return apiError('VALIDATION_FAILED', 400, `「${model.displayName}」${blocked}，不能下发`)
        }
      }

      const routeIds = mock.models
        .filter((model) => ids.includes(model.id))
        .flatMap((model) => model.routes.map((route) => route.id))
      const defaultModel = mock.models.find((model) => model.id === defaultModelId)
      const defaultRouteOfDefaultModel =
        defaultModel?.routes.find((route) => {
          const channel = mock.channels.find((item) => item.id === route.channelId)
          return channel !== undefined && routeBlockedReason(defaultModel, route, channel) === null
        })?.id ?? null
      if (platform === 'desktop') {
        mock.desktopDshModelIds = [...new Set(ids)]
        mock.desktopDshDefaultModelId = defaultModelId
        mock.desktopDshRouteIds = routeIds
        mock.desktopDshDefaultRouteId = defaultRouteOfDefaultModel
        mock.desktopDshRevision += 1
        mock.desktopDshUpdatedAt = new Date().toISOString()
        mock.desktopDshPending = true
      } else {
        mock.dshModelIds = [...new Set(ids)]
        mock.dshDefaultModelId = defaultModelId
        mock.dshRouteIds = routeIds
        mock.dshDefaultRouteId = defaultRouteOfDefaultModel
        mock.dshRevision += 1
        mock.dshUpdatedAt = new Date().toISOString()
      }
      return json(dshResponse(mock, platform))
    }
  }

  if (pathname === '/api/admin/relay/settings') {
    const payload: RelaySettingsResponse = {
      settings: mock.settings,
      internalBaseUrl: mock.settings.enabled ? 'http://10.213.0.1:7710/v1' : null,
      publicBaseUrl: 'https://hub.example.com:8123/v1',
    }
    if (method === 'GET') return json(payload)
    if (method === 'PATCH') {
      const body = readJson(init)
      mock.settings = { ...mock.settings, ...(body as Partial<RelaySettings>) }
      return json({ ...payload, settings: mock.settings })
    }
  }

  // 渠道
  if (pathname === '/api/admin/relay/channels' && method === 'GET') return json(mock.channels)

  if (pathname === '/api/admin/relay/channels' && method === 'POST') {
    const body = readJson(init)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return apiError('VALIDATION_FAILED', 400, '渠道名称不能为空')
    if (mock.channels.some((channel) => channel.name === name))
      return apiError('CONFLICT', 409, '已有同名渠道')
    const requestedSlug = typeof body.slug === 'string' ? body.slug.trim() : ''
    if (requestedSlug && !isValidChannelSlug(requestedSlug)) {
      return apiError('VALIDATION_FAILED', 400, '渠道标识格式不对', {
        fields: { slug: '只能用小写字母、数字和 -，以字母或数字开头，最长 24 位' },
      })
    }
    if (requestedSlug && mock.channels.some((channel) => channel.slug === requestedSlug)) {
      return apiError('VALIDATION_FAILED', 400, '渠道标识已被使用', {
        fields: { slug: '这个标识已经被别的渠道用了' },
      })
    }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
    if (!/^https?:\/\//.test(baseUrl))
      return apiError('VALIDATION_FAILED', 400, 'Base URL 必须以 http(s):// 开头')

    const keys = Array.isArray(body.keys) ? (body.keys as string[]) : []
    const channelId = mock.nextChannelId++
    const autoSlug = slugifyChannelName(name) || `ch${channelId}`
    const channel: RelayChannel = {
      id: channelId,
      name,
      slug: requestedSlug || uniqueChannelSlug(mock, autoSlug),
      baseUrl,
      apis:
        Array.isArray(body.apis) && body.apis.length > 0
          ? (body.apis as RelayChannel['apis'])
          : ['openai-completions'],
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    for (const index of keys.keys()) {
      const full = `sk-upstream-${mockSecret(index + mock.secretCounter).slice(9)}`
      channel.keys.push(
        channelKey(mock.nextChannelKeyId++, full.slice(-4), 'active', '', { lastUsedAt: null }),
      )
    }
    channel.health = healthOf(channel)
    mock.channels = [...mock.channels, channel]
    return json({ channel }, 201)
  }

  const channelMatch = /^\/api\/admin\/relay\/channels\/(\d+)$/.exec(pathname)
  if (channelMatch) {
    const channelId = Number(channelMatch[1])
    const channel = mock.channels.find((item) => item.id === channelId)
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')

    if (method === 'PATCH') {
      const body = readJson(init)
      if (typeof body.name === 'string' && body.name.trim()) channel.name = body.name.trim()
      if (typeof body.slug === 'string') {
        const requested = body.slug.trim()
        if (requested && !isValidChannelSlug(requested)) {
          return apiError('VALIDATION_FAILED', 400, '渠道标识格式不对', {
            fields: { slug: '只能用小写字母、数字和 -，以字母或数字开头，最长 24 位' },
          })
        }
        const next = requested || slugifyChannelName(channel.name) || channel.slug || `ch${channel.id}`
        if (mock.channels.some((item) => item.slug === next && item.id !== channel.id)) {
          return apiError('VALIDATION_FAILED', 400, '渠道标识已被使用', {
            fields: { slug: '这个标识已经被别的渠道用了' },
          })
        }
        if (channel.slug !== next) {
          channel.slug = next
          // 16 §2：标识变了会改变用户看到的模型名，触发重新下发
          mock.dshRevision += 1
          mock.dshUpdatedAt = new Date().toISOString()
        }
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
        for (const model of mock.models) {
          for (const item of model.routes) {
            if (item.channelId === channel.id) item.channelRatePermille = channel.ratePermille
          }
        }
      }
      // 路由上的渠道名 / 标识是快照，改名或改标识后一起刷新
      for (const model of mock.models) {
        for (const route of model.routes) {
          if (route.channelId === channel.id) {
            route.channelName = channel.name
            route.channelSlug = channel.slug
          }
        }
      }
      channel.updatedAt = new Date().toISOString()
      channel.health = healthOf(channel)
      return json({ channel })
    }

    if (method === 'DELETE') {
      const referencing = mock.models.filter((model) =>
        model.routes.some((item) => item.channelId === channelId),
      )
      if (referencing.length > 0) {
        return apiError('CONFLICT', 409, '还有模型路由指向这个渠道', {
          models: referencing.map((model) => model.name),
        })
      }
      mock.channels = mock.channels.filter((item) => item.id !== channelId)
      refreshChannelModelCounts(mock)
      return noContent()
    }
  }

  const testMatch = /^\/api\/admin\/relay\/channels\/(\d+)\/test$/.exec(pathname)
  if (testMatch && method === 'POST') {
    const channel = mock.channels.find((item) => item.id === Number(testMatch[1]))
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')
    const results: TestRelayChannelResponse['results'] = channel.keys
      .filter((key) => key.state !== 'disabled')
      .map((key, index) => {
        const autoDisabled = key.state === 'auto-disabled'
        return {
          keyId: key.id,
          last4: key.last4,
          ok: !autoDisabled,
          latencyMs: autoDisabled ? 180 : 120 + index * 90,
          httpStatus: autoDisabled ? 401 : 200,
          ...(autoDisabled ? { error: '上游返回 401（密钥无效）' } : {}),
        }
      })
    return json({ ok: results.every((item) => item.ok), results })
  }

  const discoverMatch = /^\/api\/admin\/relay\/channels\/(\d+)\/discover$/.exec(pathname)
  if (discoverMatch && method === 'POST') {
    const channel = mock.channels.find((item) => item.id === Number(discoverMatch[1]))
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')
    // 12 §10：上游没有 /models（或连不上）时，选择器把原因显示出来，手动添加照常可用
    if (channel.id === 3) {
      return apiError('UPSTREAM_ERROR', 502, '连接上游超时（15s）：这个上游没有 /models 接口')
    }
    return json(discoverResponse(mock, channel.id))
  }

  const keysMatch = /^\/api\/admin\/relay\/channels\/(\d+)\/keys$/.exec(pathname)
  if (keysMatch && method === 'POST') {
    const channel = mock.channels.find((item) => item.id === Number(keysMatch[1]))
    if (!channel) return apiError('NOT_FOUND', 404, '渠道不存在')
    const body = readJson(init)
    const list = Array.isArray(body.keys)
      ? (body.keys as string[]).map((key) => key.trim()).filter(Boolean)
      : []
    if (list.length === 0) return apiError('VALIDATION_FAILED', 400, '至少要填一把密钥')

    let added = 0
    let skipped = 0
    for (const secret of list) {
      const last4 = secret.slice(-4)
      if (channel.keys.some((key) => key.last4 === last4)) {
        skipped += 1
        continue
      }
      channel.keys = [
        ...channel.keys,
        channelKey(
          mock.nextChannelKeyId++,
          last4,
          'active',
          typeof body.label === 'string' ? body.label : '',
          { createdAt: new Date().toISOString(), lastUsedAt: null },
        ),
      ]
      added += 1
    }
    channel.health = healthOf(channel)
    channel.updatedAt = new Date().toISOString()
    const response: AddRelayChannelKeysResponse = { added, skipped, channel }
    return json(response, 201)
  }

  const keyMatch = /^\/api\/admin\/relay\/channels\/(\d+)\/keys\/(\d+)$/.exec(pathname)
  if (keyMatch) {
    const channel = mock.channels.find((item) => item.id === Number(keyMatch[1]))
    const key = channel?.keys.find((item) => item.id === Number(keyMatch[2]))
    if (!channel || !key) return apiError('NOT_FOUND', 404, '密钥不存在')

    if (method === 'PATCH') {
      const body = readJson(init)
      if (typeof body.label === 'string') key.label = body.label
      if (body.state === 'active' || body.state === 'disabled') {
        key.state = body.state
        if (body.state === 'active') {
          key.cooldownUntil = null
          key.lastError = null
          key.lastErrorAt = null
        }
      }
      channel.health = healthOf(channel)
      channel.updatedAt = new Date().toISOString()
      return json({ channel })
    }

    if (method === 'DELETE') {
      channel.keys = channel.keys.filter((item) => item.id !== key.id)
      channel.health = healthOf(channel)
      channel.updatedAt = new Date().toISOString()
      return json({ channel })
    }
  }

  // 对外模型
  if (pathname === '/api/admin/relay/models' && method === 'GET') return json(mock.models)

  if (pathname === '/api/admin/relay/models' && method === 'POST') {
    const body = readJson(init)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return apiError('VALIDATION_FAILED', 400, '模型名不能为空')
    if (mock.models.some((model) => model.name === name)) return apiError('CONFLICT', 409, '已有同名对外模型')
    let model: RelayModel
    try {
      model = applyModelInput(mock, null, body)
    } catch (cause) {
      if (cause instanceof MockValidationError)
        return apiError('VALIDATION_FAILED', 400, cause.message, { fields: cause.fields })
      throw cause
    }
    mock.models = [...mock.models, model]
    refreshChannelModelCounts(mock)
    return json({ model }, 201)
  }

  if (pathname === '/api/admin/relay/models/import' && method === 'POST') {
    const body = readJson(init)
    const channelId = Number(body.channelId)
    const channel = mock.channels.find((item) => item.id === channelId)
    if (!channel) return apiError('VALIDATION_FAILED', 400, '渠道不存在')
    const price = (body.price ?? {}) as Partial<RelayPrice>
    const entries = Array.isArray(body.models) ? (body.models as Record<string, unknown>[]) : []
    if (entries.length === 0) return apiError('VALIDATION_FAILED', 400, '至少要勾一个模型')

    const touched: RelayModel[] = []
    let created = 0
    let routesAdded = 0
    let skipped = 0

    for (const entry of entries) {
      const upstreamModel = typeof entry.upstreamModel === 'string' ? entry.upstreamModel : ''
      if (!upstreamModel) continue
      const name = typeof entry.name === 'string' && entry.name ? entry.name : upstreamModel
      const existing = mock.models.find((model) => model.name === name)

      if (existing) {
        if (
          existing.routes.some((item) => item.channelId === channelId && item.upstreamModel === upstreamModel)
        ) {
          skipped += 1
          continue
        }
        existing.routes = [...existing.routes, route(mock.nextRouteId++, channel, upstreamModel)]
        existing.updatedAt = new Date().toISOString()
        const apis = new Set([...existing.apis, ...channel.apis])
        existing.apis = [...apis]
        routesAdded += 1
        touched.push(existing)
        continue
      }

      const model: RelayModel = {
        id: mock.nextModelId++,
        name,
        displayName: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : name,
        enabled: true,
        visibility: 'all',
        price: {
          inputMicro: price.inputMicro ?? 0,
          outputMicro: price.outputMicro ?? 0,
          cacheReadMicro: price.cacheReadMicro ?? null,
          cacheWriteMicro: price.cacheWriteMicro ?? null,
          perRequestMicro: price.perRequestMicro ?? 0,
        },
        info: (entry.info as RelayModel['info'] | undefined) ?? {},
        defaultThinking: null,
        compat: null,
        routes: [route(mock.nextRouteId++, channel, upstreamModel)],
        apis: [...channel.apis],
        sort: 100 + mock.nextModelId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      mock.models = [...mock.models, model]
      created += 1
      touched.push(model)
    }

    refreshChannelModelCounts(mock)
    const response: ImportRelayModelsResponse = { created, routesAdded, skipped, models: touched }
    return json(response)
  }

  const modelMatch = /^\/api\/admin\/relay\/models\/(\d+)$/.exec(pathname)
  if (modelMatch) {
    const modelId = Number(modelMatch[1])
    const model = mock.models.find((item) => item.id === modelId)
    if (!model) return apiError('NOT_FOUND', 404, '模型不存在')

    if (method === 'PATCH') {
      const body = readJson(init)
      let next: RelayModel
      try {
        next = applyModelInput(mock, model, body)
      } catch (cause) {
        if (cause instanceof MockValidationError)
          return apiError('VALIDATION_FAILED', 400, cause.message, { fields: cause.fields })
        throw cause
      }
      mock.models = mock.models.map((item) => (item.id === modelId ? next : item))
      refreshChannelModelCounts(mock)
      return json({ model: next })
    }

    if (method === 'DELETE') {
      mock.models = mock.models.filter((item) => item.id !== modelId)
      refreshChannelModelCounts(mock)
      return noContent()
    }
  }

  // 钱包（积分）
  if (pathname === '/api/admin/relay/wallets' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const sort = url.searchParams.get('sort') ?? 'lastUsed'
    const rows = mock.users
      .map((user) => walletRow(mock, user.id) ?? defaultWalletRow(mock, user.id))
      .filter((row): row is RelayWalletRow => row !== null)
      .filter((row) =>
        q ? row.username.toLowerCase().includes(q) || row.displayName.toLowerCase().includes(q) : true,
      )
      .sort((a, b) => {
        if (sort === 'balance') return b.balanceMicro - a.balanceMicro
        if (sort === 'monthCost') return b.monthCostMicro - a.monthCostMicro
        if (sort === 'username') return a.username.localeCompare(b.username)
        return Date.parse(b.lastUsedAt ?? '1970-01-01') - Date.parse(a.lastUsedAt ?? '1970-01-01')
      })
    return json(pageOf(rows, url))
  }

  const walletMatch = /^\/api\/admin\/relay\/wallets\/(\d+)(\/adjust)?$/.exec(pathname)
  if (walletMatch) {
    const userId = Number(walletMatch[1])
    const current = walletRow(mock, userId) ?? defaultWalletRow(mock, userId)
    if (!current) return apiError('NOT_FOUND', 404, '用户不存在')

    if (!walletMatch[2] && method === 'GET') return json({ wallet: current })

    if (!walletMatch[2] && method === 'PATCH') {
      const body = readJson(init)
      if (!mock.walletSeeds.has(userId)) {
        mock.walletSeeds.set(userId, {
          id: userId,
          username: current.username,
          displayName: current.displayName,
          balanceMicro: 0,
          ratePercent: 100,
          maxConcurrency: null,
          dailyLimitMicro: null,
          enabled: true,
          totalSpentMicro: 0,
        })
      }
      const seed = mock.walletSeeds.get(userId)!
      if (typeof body.ratePercent === 'number') seed.ratePercent = body.ratePercent
      if ('maxConcurrency' in body) seed.maxConcurrency = (body.maxConcurrency as number | null) ?? null
      if ('dailyLimitMicro' in body) seed.dailyLimitMicro = (body.dailyLimitMicro as number | null) ?? null
      if (typeof body.enabled === 'boolean') seed.enabled = body.enabled
      return json({ wallet: walletRow(mock, userId) ?? current })
    }

    if (walletMatch[2] === '/adjust' && method === 'POST') {
      const body = readJson(init)
      const amountMicro = Number(body.amountMicro)
      if (!Number.isInteger(amountMicro) || amountMicro === 0)
        return apiError('VALIDATION_FAILED', 400, '金额不能为 0')
      if (Math.abs(amountMicro) > 1_000_000 * 1_000_000)
        return apiError('VALIDATION_FAILED', 400, '单次最多 100 万积分')

      if (!mock.walletSeeds.has(userId)) {
        mock.walletSeeds.set(userId, {
          id: userId,
          username: current.username,
          displayName: current.displayName,
          balanceMicro: 0,
          ratePercent: 100,
          maxConcurrency: null,
          dailyLimitMicro: null,
          enabled: true,
          totalSpentMicro: 0,
        })
      }
      const seed = mock.walletSeeds.get(userId)!
      seed.balanceMicro += amountMicro

      mock.ledger = [
        ...mock.ledger,
        {
          id: mock.nextLedgerId++,
          userId,
          username: current.username,
          type: amountMicro > 0 ? 'grant' : 'deduct',
          amountMicro,
          balanceAfterMicro: seed.balanceMicro,
          note: typeof body.note === 'string' ? body.note : '',
          actor: getMockState().user.username,
          createdAt: new Date().toISOString(),
        },
      ]

      return json({ wallet: walletRow(mock, userId) ?? current })
    }
  }

  // 流水 / 用量
  if (pathname === '/api/admin/relay/ledger' && method === 'GET') {
    const userId = Number(url.searchParams.get('userId') ?? '') || undefined
    const rows = mock.ledger.filter((row) => (userId ? row.userId === userId : true))
    return json(pageOf([...rows].reverse(), url))
  }

  if (pathname === '/api/admin/relay/usage' && method === 'GET') {
    return json(statsResponse(mock, url, { userScoped: false }))
  }

  if (pathname === '/api/admin/relay/logs' && method === 'GET') {
    const userId = Number(url.searchParams.get('userId') ?? '') || undefined
    const model = url.searchParams.get('model')
    const baseModel = url.searchParams.get('baseModel')
    const channelId = Number(url.searchParams.get('channelId') ?? '') || undefined
    const status = url.searchParams.get('status')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const scope = url.searchParams.get('scope')
    // docs/22 §1.3：桌面平台的用量记录默认筛 client_kind=desktop
    const clientKind = url.searchParams.get('clientKind')

    const rows = [...mock.logs, ...scopeMatchedModeRows(scope)]
      .filter((row) => (scope ? (row.scope ?? 'dsh') === scope : true))
      .filter((row) => (clientKind ? ((row as MockUsageRow).clientKind ?? 'docker') === clientKind : true))
      .filter((row) => (userId ? row.userId === userId : true))
      // 与后端一致：`model` 按请求名精确匹配，`baseModel` 按本名（16 §5，能把 @upstream-b / @official 一起筛出来）
      .filter((row) => (model ? row.model === model : true))
      .filter((row) => (baseModel ? (row.baseModel ?? row.model) === baseModel : true))
      .filter((row) => (channelId ? row.channelId === channelId : true))
      .filter((row) => (status ? row.status === status : true))
      .filter((row) => (from ? row.createdAt.slice(0, 10) >= from : true))
      .filter((row) => (to ? row.createdAt.slice(0, 10) <= to : true))
      .map((row) => ({ ...row, scope: row.scope ?? 'dsh' }))
    return json(pageOf(rows, url))
  }

  return null
}

/** 假接口的表单校验失败（照 04 §0 的错误体抛给页面；`fields` 里的字段会显示在对应输入框下） */
class MockValidationError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'MockValidationError'
  }
}

/**
 * 默认思考档位必须落在模型（更新后的）`info.reasoningEfforts` 里（12 §7.0）：等价于
 * `effectiveDshThinking(info, value) === value`；没问题返回 null。
 * 文案与 WP13a 的 `assertDefaultThinking()`（`apps/api/src/modules/relay/service.ts`）逐字一致，假接口才像真接口。
 */
function defaultThinkingProblem(model: RelayModel): string | null {
  const value = model.defaultThinking
  if (value === null || effectiveDshThinking(model.info, value) === value) return null
  const declared = (model.info.reasoningEfforts ?? []).filter((level): level is ThinkingLevel =>
    (THINKING_LEVELS as readonly string[]).includes(level),
  )
  return declared.some((level) => level !== 'off')
    ? `这个模型的思考档位里没有「${value}」（已声明：${declared.join('、')}）`
    : '这个模型没有声明 off 之外的思考档位，不能设默认思考档位'
}

/** 把编辑弹窗的请求体合并进模型（`routes` 给了就整体替换）；校验不过抛 `MockValidationError`。 */
function applyModelInput(
  mock: RelayMockState,
  model: RelayModel | null,
  body: Record<string, unknown>,
): RelayModel {
  const routesInput = Array.isArray(body.routes) ? (body.routes as Record<string, unknown>[]) : null
  const price = (body.price ?? {}) as Partial<RelayPrice>

  const next: RelayModel = model
    ? { ...model }
    : {
        id: mock.nextModelId++,
        name: '',
        displayName: '',
        enabled: true,
        visibility: 'all',
        price: {
          inputMicro: 0,
          outputMicro: 0,
          cacheReadMicro: null,
          cacheWriteMicro: null,
          perRequestMicro: 0,
        },
        info: {},
        defaultThinking: null,
        compat: null,
        routes: [],
        apis: [],
        sort: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

  if (typeof body.name === 'string') next.name = body.name.trim()
  if (typeof body.displayName === 'string') next.displayName = body.displayName.trim() || next.name
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled
  if (body.visibility === 'all' || body.visibility === 'admin') next.visibility = body.visibility
  if (body.price) {
    next.price = {
      inputMicro: price.inputMicro ?? 0,
      outputMicro: price.outputMicro ?? 0,
      cacheReadMicro: price.cacheReadMicro ?? null,
      cacheWriteMicro: price.cacheWriteMicro ?? null,
      perRequestMicro: price.perRequestMicro ?? 0,
    }
  }
  if (body.info) next.info = body.info as RelayModel['info']
  if ('defaultThinking' in body) {
    const raw = body.defaultThinking
    if (raw === null) {
      next.defaultThinking = null
    } else {
      const level = String(raw)
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
        const problem = `不认识的思考档位：${level}`
        throw new MockValidationError(problem, { defaultThinking: problem })
      }
      next.defaultThinking = level as ThinkingLevel
    }
  }
  if ('compat' in body) next.compat = (body.compat as RelayModel['compat']) ?? null
  if (typeof body.sort === 'number') next.sort = body.sort

  if (routesInput) {
    next.routes = routesInput.map((item) => {
      const channelId = Number(item.channelId)
      const channel = mock.channels.find((entry) => entry.id === channelId)
      return route(
        mock.nextRouteId++,
        channel ?? { id: channelId, name: `#${channelId}`, ratePermille: 1000 },
        typeof item.upstreamModel === 'string' && item.upstreamModel ? item.upstreamModel : next.name,
        {
          priority: typeof item.priority === 'number' ? item.priority : null,
          weight: typeof item.weight === 'number' ? item.weight : null,
          enabled: item.enabled !== false,
        },
      )
    })
    const apis = new Set<RelayModel['apis'][number]>()
    for (const item of next.routes) {
      if (!item.enabled) continue
      const channel = mock.channels.find((entry) => entry.id === item.channelId)
      if (!channel?.enabled) continue
      for (const api of channel.apis) apis.add(api)
    }
    next.apis = [...apis]
  }

  // 校验用**更新后的** info（12 §7.0）：同时改了 info 去掉这个档位又没改 defaultThinking → 报错，
  // 与 WP13a 的 `assertDefaultThinking()` 同一口径（每次拿写库后的记录校验，不悄悄清掉）。
  const thinkingProblem = defaultThinkingProblem(next)
  if (thinkingProblem) throw new MockValidationError(thinkingProblem, { defaultThinking: thinkingProblem })

  next.updatedAt = new Date().toISOString()
  return next
}

/**
 * 取（必要时重建）假状态：场景变了就重置，`?mock=relay-off` 的 `enabled=false` 也在这里生效。
 * `resetRelayMock` 给测试用（同一场景里想回到初始假数据时）。
 */
export function resetRelayMock(): void {
  state = null
  resetMockJobs()
}

export function relayState(): RelayMockState {
  const scenario = getMockState().scenario
  if (!state || state.scenario !== scenario) {
    state = createState(scenario)
  }
  return state
}
