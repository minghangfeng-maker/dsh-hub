import type {
  ComputeLease,
  ComputeLeaseEndReason,
  ComputeLeaseRow,
  ComputePlan,
  ComputeSettings,
  ComputeSettingsResponse,
  InstanceStatus,
  MyComputePlan,
  MyComputeResponse,
} from '@dsh-hub/shared'
import { DEFAULT_COMPUTE_SETTINGS, computeBlockPriceMicro } from '@dsh-hub/shared'

import { getMockState, type MockScenario } from './state'

/**
 * 算力租赁的假数据与假接口（**仅开发环境**，13 §7）。
 *
 * 场景（`?mock=`）：
 * - `compute-off` 计费关闭（工作台与改版前完全一致）；
 * - `compute-stopped` 计费开启、余额充足、实例已停止（点卡片只记住规格）；
 * - `compute-running` 运行中的计费租约（已扣 3 块）；
 * - `compute-grace` 宽限中（余额 0，7 分钟后停机）；
 * - `compute-low` 余额不足一块（启动 402）；
 * - `compute-exempt` 管理员账号免租（免费租约）；
 * - `compute-custom` 有定制规格（只有本人可见）。
 *
 * 管理端（`?mock=admin*`）另提供设置与全部租约；实例列表的 `lease` 也来自这里。
 * 所有 POST / PUT / PATCH 真的改内存状态，页面上的「选中规格 → 变高亮」「保存 → 生效」能走通。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
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

const NOW = Date.now()
const MINUTE = 60_000
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

/** 算力相关的场景（其余场景 = 计费关闭，工作台不出现这一块） */
const COMPUTE_SCENARIOS: readonly MockScenario[] = [
  'compute-off',
  'compute-stopped',
  'compute-running',
  'compute-grace',
  'compute-low',
  'compute-exempt',
  'compute-custom',
]

export function isComputeScenario(scenario: MockScenario): boolean {
  return (COMPUTE_SCENARIOS as readonly string[]).includes(scenario)
}

/** `?mock=admin*` 的管理端场景（与 `mocks/admin.ts` 的 `isAdminScenario` 同口径，不互相 import） */
function isAdminMockScenario(scenario: MockScenario): boolean {
  return scenario.startsWith('admin')
}

// ── 规格 ────────────────────────────────────────────────────────────────────

const BASE_PLANS: ComputePlan[] = DEFAULT_COMPUTE_SETTINGS.plans.map((plan) => ({ ...plan }))

/** 定制规格：只对指定用户可见（13 §1） */
const CUSTOM_PLAN: ComputePlan = {
  id: 'custom-16c',
  name: '16 核 32 GB',
  cpus: 16,
  memoryMb: 32_768,
  pricePerHourMicro: 2_000_000,
  enabled: true,
  userIds: [12],
  sort: 40,
}

const ADMIN_CUSTOM_PLAN: ComputePlan = {
  id: 'custom-family',
  name: '家人专享 8 核 24 GB',
  cpus: 8,
  memoryMb: 24_576,
  pricePerHourMicro: 800_000,
  enabled: true,
  userIds: [2, 4],
  sort: 40,
}

function plansFor(scenario: MockScenario): ComputePlan[] {
  if (scenario === 'compute-custom') return [...BASE_PLANS, { ...CUSTOM_PLAN }]
  if (isAdminMockScenario(scenario)) return [...BASE_PLANS, { ...ADMIN_CUSTOM_PLAN }]
  return BASE_PLANS.map((plan) => ({ ...plan }))
}

function planById(plans: ComputePlan[], id: string): ComputePlan | undefined {
  return plans.find((plan) => plan.id === id)
}

function toMyPlan(plan: ComputePlan): MyComputePlan {
  return {
    id: plan.id,
    name: plan.name,
    cpus: plan.cpus,
    memoryMb: plan.memoryMb,
    pricePerHourMicro: plan.pricePerHourMicro,
    blockPriceMicro: computeBlockPriceMicro(plan.pricePerHourMicro),
    custom: plan.userIds !== null,
  }
}

// ── 余额（与中转站钱包共用，`mocks/relay.ts` 也读这个函数） ─────────────────

export function mockComputeWalletMicro(scenario: MockScenario = getMockState().scenario): number {
  switch (scenario) {
    case 'compute-stopped':
    case 'compute-custom':
      return 2_400_000
    case 'compute-running':
      return 1_860_000
    case 'compute-grace':
      return -20_000
    case 'compute-low':
      return 20_000
    case 'compute-exempt':
      // 管理员场景的钱包（与 `WALLET_SEEDS` 的 admin 一致）
      return 128_500_000
    default:
      return 12_345_670_000
  }
}

// ── 状态 ────────────────────────────────────────────────────────────────────

interface ComputeMockState {
  scenario: MockScenario
  settings: ComputeSettings
  selectedPlanId: string
  balanceMicro: number
  dailyBonusMicro: number
  dailyBonusLeftMicro: number
  /** 当前租约（不是租约场景时为 null，运行中会自动合成） */
  lease: ComputeLease | null
  history: ComputeLeaseRow[]
  host: { memTotalMb: number; committedMemoryMb: number }
  nextLeaseId: number
}

let state: ComputeMockState | null = null
let stateScenario: MockScenario | null = null

function leaseRow(
  id: number,
  userId: number,
  username: string,
  plan: ComputePlan,
  options: {
    startedMinutesAgo: number
    endedMinutesAgo?: number
    endReason?: ComputeLeaseEndReason | null
    blocks?: number
    graceMinutesLeft?: number | null
    billed?: boolean
  },
): ComputeLeaseRow {
  const blockPrice = computeBlockPriceMicro(plan.pricePerHourMicro)
  const blocks = options.blocks ?? 1
  const billed = options.billed ?? true
  const startedAt = iso(-options.startedMinutesAgo * MINUTE)
  const endedMinutes = options.endedMinutesAgo ?? null
  const endedAt = endedMinutes === null ? null : iso(-endedMinutes * MINUTE)
  const paidUntil =
    billed && endedAt === null
      ? iso((10 - (options.startedMinutesAgo % 10)) * MINUTE)
      : billed && endedMinutes !== null
        ? iso(-endedMinutes * MINUTE)
        : null
  return {
    id,
    userId,
    username,
    planId: plan.id,
    planName: plan.name,
    cpus: plan.cpus,
    memoryMb: plan.memoryMb,
    pricePerHourMicro: plan.pricePerHourMicro,
    blockPriceMicro: blockPrice,
    billed,
    startedAt,
    paidUntil,
    graceUntil:
      options.graceMinutesLeft === null || options.graceMinutesLeft === undefined
        ? null
        : iso(options.graceMinutesLeft * MINUTE),
    endedAt,
    endReason: options.endReason ?? null,
    blocks,
    chargedMicro: billed ? blocks * blockPrice : 0,
  }
}

function buildHistory(
  scenario: MockScenario,
  userId: number,
  username: string,
  plans: ComputePlan[],
): ComputeLeaseRow[] {
  const plan = (id: string): ComputePlan => planById(plans, id) ?? plans[0]!

  const rows: ComputeLeaseRow[] = [
    leaseRow(101, userId, username, plan('c4m8'), {
      startedMinutesAgo: 180,
      endedMinutesAgo: 150,
      endReason: 'user',
      blocks: 3,
    }),
    leaseRow(102, userId, username, plan('c2m4'), {
      startedMinutesAgo: 1440,
      endedMinutesAgo: 1360,
      endReason: 'idle',
      blocks: 8,
    }),
    leaseRow(103, userId, username, plan('c2m4'), {
      startedMinutesAgo: 2880,
      endedMinutesAgo: 2840,
      endReason: 'insufficient',
      blocks: 4,
    }),
    leaseRow(104, userId, username, plan('c8m16'), {
      startedMinutesAgo: 4320,
      endedMinutesAgo: 4300,
      endReason: 'plan-change',
      blocks: 2,
    }),
    leaseRow(105, userId, username, plan('c2m4'), {
      startedMinutesAgo: 5760,
      endedMinutesAgo: 5750,
      endReason: 'admin',
      blocks: 1,
    }),
    leaseRow(106, userId, username, plan('c4m8'), {
      startedMinutesAgo: 7200,
      endedMinutesAgo: 7195,
      endReason: 'billing-off',
      blocks: 0,
    }),
    leaseRow(107, userId, username, plan('c4m8'), {
      startedMinutesAgo: 8600,
      endedMinutesAgo: 8550,
      endReason: 'crash',
      blocks: 5,
    }),
    leaseRow(108, userId, username, plan('c2m4'), {
      startedMinutesAgo: 10000,
      endedMinutesAgo: 9970,
      endReason: 'system',
      blocks: 3,
    }),
  ]

  // 当前场景正在跑的租约也在历史里（endedAt 为空 = 进行中）
  if (scenario === 'compute-running' || scenario === 'compute-grace' || scenario === 'compute-exempt') {
    const active = makeActiveLease(scenario, plans, userId, username)
    if (active) rows.unshift(active)
  }

  return rows
}

function makeActiveLease(
  scenario: MockScenario,
  plans: ComputePlan[],
  userId: number,
  username: string,
): ComputeLeaseRow | null {
  if (scenario === 'compute-running') {
    return leaseRow(120, userId, username, planById(plans, 'c4m8') ?? plans[0]!, {
      startedMinutesAgo: 25,
      blocks: 3,
    })
  }
  if (scenario === 'compute-grace') {
    const row = leaseRow(121, userId, username, planById(plans, 'c4m8') ?? plans[0]!, {
      startedMinutesAgo: 35,
      blocks: 3,
      graceMinutesLeft: 7,
    })
    // 已经欠费：付费时刻早就过了
    row.paidUntil = iso(-12 * MINUTE)
    return row
  }
  if (scenario === 'compute-exempt') {
    return leaseRow(122, userId, username, planById(plans, 'c4m8') ?? plans[0]!, {
      startedMinutesAgo: 40,
      blocks: 0,
      billed: false,
    })
  }
  return null
}

function createState(scenario: MockScenario): ComputeMockState {
  const mock = getMockState()
  const adminScenario = isAdminMockScenario(scenario)
  const plans = plansFor(scenario)
  const billingEnabled = scenario !== 'compute-off'
  const billAdmins = false

  const selectedPlanId =
    scenario === 'compute-custom'
      ? 'custom-16c'
      : scenario === 'compute-running' || scenario === 'compute-grace' || scenario === 'compute-exempt'
        ? 'c4m8'
        : 'c2m4'

  const balanceMicro = mockComputeWalletMicro(scenario)
  const dailyBonusMicro = scenario === 'compute-off' ? 0 : 600_000
  const dailyBonusLeftMicro =
    scenario === 'compute-grace' || scenario === 'compute-low'
      ? 0
      : scenario === 'compute-stopped'
        ? 300_000
        : dailyBonusMicro

  const settings: ComputeSettings = {
    billingEnabled,
    billAdmins: adminScenario ? false : billAdmins,
    graceMinutes: 10,
    capacityMemoryMb: 10_240,
    contactText: DEFAULT_COMPUTE_SETTINGS.contactText,
    defaultPlanId: DEFAULT_COMPUTE_SETTINGS.defaultPlanId,
    plans,
  }

  const isUserLeaseScenario =
    scenario === 'compute-running' || scenario === 'compute-grace' || scenario === 'compute-exempt'
  const activeRow = isUserLeaseScenario
    ? makeActiveLease(scenario, plans, mock.user.id, mock.user.username)
    : null
  const lease: ComputeLease | null = activeRow
    ? {
        id: activeRow.id,
        userId: activeRow.userId,
        planId: activeRow.planId,
        planName: activeRow.planName,
        cpus: activeRow.cpus,
        memoryMb: activeRow.memoryMb,
        pricePerHourMicro: activeRow.pricePerHourMicro,
        blockPriceMicro: activeRow.blockPriceMicro,
        billed: activeRow.billed,
        startedAt: activeRow.startedAt,
        paidUntil: activeRow.paidUntil,
        graceUntil: activeRow.graceUntil,
        endedAt: activeRow.endedAt,
        endReason: activeRow.endReason,
        blocks: activeRow.blocks,
        chargedMicro: activeRow.chargedMicro,
      }
    : null

  return {
    scenario,
    settings,
    selectedPlanId,
    balanceMicro,
    dailyBonusMicro,
    dailyBonusLeftMicro,
    lease,
    history: buildHistory(scenario, mock.user.id, mock.user.username, plans),
    host: { memTotalMb: 16_384, committedMemoryMb: 8_192 },
    nextLeaseId: 200,
  }
}

function computeState(): ComputeMockState {
  const scenario = getMockState().scenario
  if (!state || stateScenario !== scenario) {
    state = createState(scenario)
    stateScenario = scenario
  }
  return state
}

/** 重置（切换场景时 `mocks/index.ts` 会重建 state，这里也跟着重建） */
export function resetComputeMock(): void {
  state = null
  stateScenario = null
}

// ── 用户端响应 ──────────────────────────────────────────────────────────────

function isExempt(s: ComputeMockState): boolean {
  const mock = getMockState()
  return mock.user.role === 'admin' && !s.settings.billAdmins
}

/** 实例刚启动时没有现成租约：按选中规格合成一条，页面才有东西可看 */
function effectiveLease(s: ComputeMockState): ComputeLease | null {
  if (!s.settings.billingEnabled) return null
  if (s.lease) return s.lease

  const mock = getMockState()
  if (mock.status !== 'running') return null

  const plan = planById(s.settings.plans, s.selectedPlanId) ?? s.settings.plans[0]
  if (!plan) return null

  const billed = !isExempt(s)
  const blockPrice = computeBlockPriceMicro(plan.pricePerHourMicro)
  const startedAt = mock.startedAt ?? new Date().toISOString()
  return {
    id: s.nextLeaseId,
    userId: mock.user.id,
    planId: plan.id,
    planName: plan.name,
    cpus: plan.cpus,
    memoryMb: plan.memoryMb,
    pricePerHourMicro: plan.pricePerHourMicro,
    blockPriceMicro: blockPrice,
    billed,
    startedAt,
    paidUntil: billed ? iso(10 * MINUTE) : null,
    graceUntil: null,
    endedAt: null,
    endReason: null,
    blocks: billed ? 1 : 0,
    chargedMicro: billed ? blockPrice : 0,
  }
}

function myComputeResponse(): MyComputeResponse {
  const s = computeState()
  const mock = getMockState()
  const visible = s.settings.plans.filter(
    (plan) => plan.enabled && (plan.userIds === null || plan.userIds.includes(mock.user.id)),
  )
  return {
    billingEnabled: s.settings.billingEnabled,
    exempt: isExempt(s),
    plans: visible.map(toMyPlan),
    selectedPlanId: s.selectedPlanId,
    lease: effectiveLease(s),
    balanceMicro: s.balanceMicro,
    dailyBonusLeftMicro: s.dailyBonusLeftMicro,
    dailyBonusMicro: s.dailyBonusMicro,
    blockMinutes: 10,
    graceMinutes: s.settings.graceMinutes,
    contactText: s.settings.contactText,
  }
}

function pageOf<T>(items: T[], url: URL): { items: T[]; total: number; page: number; pageSize: number } {
  const rawPage = Number(url.searchParams.get('page') ?? 1)
  const rawSize = Number(url.searchParams.get('pageSize') ?? 20)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
  const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(100, Math.floor(rawSize)) : 20
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize }
}

// ── 用户端接口 ──────────────────────────────────────────────────────────────

export function handleUserCompute(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Response | null {
  if (!pathname.startsWith('/api/me/compute')) return null
  const s = computeState()

  if (pathname === '/api/me/compute' && method === 'GET') return json(myComputeResponse())

  if (pathname === '/api/me/compute/plan' && method === 'PUT') {
    const body = readJson(init)
    const planId = typeof body.planId === 'string' ? body.planId : ''
    const mock = getMockState()
    const plan = s.settings.plans.find(
      (item) =>
        item.id === planId && item.enabled && (item.userIds === null || item.userIds.includes(mock.user.id)),
    )
    if (!plan) return apiError('NOT_FOUND', 404, '没有这个规格')

    const blockPrice = computeBlockPriceMicro(plan.pricePerHourMicro)
    const exempt = isExempt(s)
    if (s.settings.billingEnabled && !exempt && s.balanceMicro < blockPrice) {
      return apiError('INSUFFICIENT_POINTS', 402, '积分不足，请充值后再启动', {
        balanceMicro: s.balanceMicro,
        blockPriceMicro: blockPrice,
      })
    }

    const wasRunning = mock.status === 'running'
    s.selectedPlanId = plan.id

    if (wasRunning && s.settings.billingEnabled) {
      // 换规格 = 结束旧租约（plan-change）→ 新租约先扣一块
      s.lease = null
      const billed = !exempt
      if (billed) s.balanceMicro -= blockPrice
      s.lease = {
        id: s.nextLeaseId++,
        userId: mock.user.id,
        planId: plan.id,
        planName: plan.name,
        cpus: plan.cpus,
        memoryMb: plan.memoryMb,
        pricePerHourMicro: plan.pricePerHourMicro,
        blockPriceMicro: blockPrice,
        billed,
        startedAt: new Date().toISOString(),
        paidUntil: billed ? iso(10 * MINUTE) : null,
        graceUntil: null,
        endedAt: null,
        endReason: null,
        blocks: billed ? 1 : 0,
        chargedMicro: billed ? blockPrice : 0,
      }
    }

    return json({ compute: myComputeResponse(), restarted: wasRunning })
  }

  if (pathname === '/api/me/compute/leases' && method === 'GET') {
    const all = [...s.history]
    const active = effectiveLease(s)
    if (active && !all.some((row) => row.id === active.id)) {
      const mock = getMockState()
      all.unshift({ ...active, username: mock.user.username })
    }
    return json(pageOf(all, url))
  }

  return null
}

/**
 * `POST /api/me/instance/start` 的算力准入（13 §3）：记住请求里带的规格，
 * 余额不够一块就 402（`details { balanceMicro, blockPriceMicro }`）。
 * 返回 null = 放行给原来的实例启动流程。
 */
export function handleComputeStart(body: Record<string, unknown>): Response | null {
  const s = computeState()
  if (!s.settings.billingEnabled) return null

  const mock = getMockState()
  const planId = typeof body.planId === 'string' ? body.planId : s.selectedPlanId
  const plan = s.settings.plans.find(
    (item) =>
      item.id === planId && item.enabled && (item.userIds === null || item.userIds.includes(mock.user.id)),
  )
  if (!plan) return null

  s.selectedPlanId = plan.id
  const blockPrice = computeBlockPriceMicro(plan.pricePerHourMicro)
  if (!isExempt(s) && s.balanceMicro < blockPrice) {
    return apiError('INSUFFICIENT_POINTS', 402, '积分不足，请充值后再启动', {
      balanceMicro: s.balanceMicro,
      blockPriceMicro: blockPrice,
    })
  }
  return null
}

// ── 管理端 ──────────────────────────────────────────────────────────────────

const OTHER_USERNAMES: Record<number, string> = {
  1: 'admin',
  2: 'mint',
  4: 'sakura',
  5: 'butter',
  6: 'quiet-leaf',
}

function adminLeases(s: ComputeMockState): ComputeLeaseRow[] {
  const plans = s.settings.plans
  const plan = (id: string): ComputePlan => planById(plans, id) ?? plans[0]!
  const rows: ComputeLeaseRow[] = [...s.history]

  for (const [userId, username] of Object.entries(OTHER_USERNAMES)) {
    const id = Number(userId)
    rows.push(
      leaseRow(300 + id, id, username, plan(id % 2 === 0 ? 'c4m8' : 'c2m4'), {
        startedMinutesAgo: 300 + id * 37,
        endedMinutesAgo: 240 + id * 30,
        endReason: id % 3 === 0 ? 'admin' : id % 2 === 0 ? 'user' : 'insufficient',
        blocks: 1 + (id % 5),
      }),
    )
  }

  // 管理员自己的免费租约（billAdmins=false）
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function adminSettingsResponse(s: ComputeMockState): ComputeSettingsResponse {
  return { settings: s.settings, host: s.host }
}

export function handleAdminCompute(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Response | null {
  if (!pathname.startsWith('/api/admin/compute')) return null
  const s = computeState()

  if (pathname === '/api/admin/compute/settings') {
    if (method === 'GET') return json(adminSettingsResponse(s))
    if (method === 'PATCH') {
      const body = readJson(init)
      const next = { ...s.settings }
      if (typeof body.billingEnabled === 'boolean') next.billingEnabled = body.billingEnabled
      if (typeof body.billAdmins === 'boolean') next.billAdmins = body.billAdmins
      if (typeof body.graceMinutes === 'number') next.graceMinutes = body.graceMinutes
      if (typeof body.capacityMemoryMb === 'number') next.capacityMemoryMb = body.capacityMemoryMb
      if (typeof body.contactText === 'string') next.contactText = body.contactText
      if (Array.isArray(body.plans)) next.plans = body.plans as ComputePlan[]
      s.settings = next
      return json(adminSettingsResponse(s))
    }
  }

  if (pathname === '/api/admin/compute/leases' && method === 'GET') {
    const userId = Number(url.searchParams.get('userId') ?? 0)
    const activeOnly = url.searchParams.get('active') === 'true'
    let rows = adminLeases(s)
    if (Number.isFinite(userId) && userId > 0) rows = rows.filter((row) => row.userId === userId)
    if (activeOnly) rows = rows.filter((row) => row.endedAt === null)
    return json(pageOf(rows, url))
  }

  return null
}

/**
 * 管理端实例列表里的租约（13 §6：`AdminInstanceRow.lease`）。
 * 只在管理端场景、且实例运行中时给；`billAdmins=false` 时管理员是免费租约。
 */
export function mockLeaseOfUser(userId: number, status: InstanceStatus): ComputeLease | null {
  const scenario = getMockState().scenario
  if (!isAdminMockScenario(scenario)) return null
  if (status !== 'running') return null

  const s = computeState()
  const plan = planById(s.settings.plans, userId === 2 ? 'custom-family' : 'c4m8')
  if (!plan) return null

  const billed = !(userId === 1 && !s.settings.billAdmins)
  const blockPrice = computeBlockPriceMicro(plan.pricePerHourMicro)
  const graceUntil = userId === 4 ? iso(7 * MINUTE) : null
  const startedAt = iso(-(25 + userId * 3) * MINUTE)

  return {
    id: 500 + userId,
    userId,
    planId: plan.id,
    planName: plan.name,
    cpus: plan.cpus,
    memoryMb: plan.memoryMb,
    pricePerHourMicro: plan.pricePerHourMicro,
    blockPriceMicro: blockPrice,
    billed,
    startedAt,
    paidUntil: billed ? iso(5 * MINUTE) : null,
    graceUntil,
    endedAt: null,
    endReason: null,
    blocks: billed ? 3 : 0,
    chargedMicro: billed ? 3 * blockPrice : 0,
  }
}
