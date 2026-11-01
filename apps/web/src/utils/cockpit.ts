import type {
  CanvasColumnFormat,
  CanvasData,
  CanvasItem,
  CanvasSpec,
  CanvasPlacement,
  CanvasPlacementRequest,
  CanvasSize,
  CanvasStatsItem,
  CapabilityDescriptor,
  CapabilityRisk,
  CockpitEvent,
  CockpitStatusStrip,
  EntityKind,
  OpsStatus,
  ProposalStatus,
  ProposalView,
  SecretRequestView,
} from '@/api/admin-cockpit'
import { CANVAS_RIGHT_KINDS } from '@/api/admin-cockpit'
import type { AdminTone } from '@/components/admin/tone'
import { formatBytes, formatCount, formatDateTime } from '@/composables/useFormat'
import { JOB_STATUS_TEXT, instanceStatusMeta } from '@/composables/useInstanceStatus'
import { isCockpitAppPhase, type CockpitAppPhase } from '@/utils/assist-phase'
import type { CockpitLayoutPayload } from '@/utils/assist-layout'

/**
 * 舰桥的纯逻辑（docs/24 §1–§3、§6）：风险分级文案、方案状态、投放规则（左舷/右舷、待确认区）、
 * 回合强调、SSE 事件归约、postMessage 校验、画布格子格式化、「问 DSH」预填文案。
 *
 * 与组件分开写的原因：这些规则都要单测（任务书 WP56c「测试」），组件只负责渲染。
 */

// ────────────────────────────── 风险与状态 ──────────────────────────────

export interface RiskMeta {
  /** 徽章文字 */
  text: string
  tone: AdminTone
  /** 悬浮说明（docs/24 §0 的风险分级表） */
  hint: string
}

/** 风险分级（docs/24 §0）：R0 只读、R1 低风险可逆、R2 有影响、R3 敏感。 */
export const RISK_META: Record<CapabilityRisk, RiskMeta> = {
  R0: { text: 'R0 只读', tone: 'neutral', hint: '只读查询，DSH 可以直接调用' },
  R1: { text: 'R1 可逆', tone: 'sky', hint: '低风险可自动执行，可在系统设置里关掉自动执行' },
  R2: { text: 'R2 有影响', tone: 'butter', hint: '会改动数据，需要管理员在方案卡上点一次「执行」' },
  R3: { text: 'R3 敏感', tone: 'danger', hint: '敏感操作，除了点「执行」还要输入管理员密码' },
}

export function riskMeta(risk: CapabilityRisk): RiskMeta {
  return RISK_META[risk] ?? RISK_META.R2
}

export const PROPOSAL_STATUS_TEXT: Record<ProposalStatus, string> = {
  pending: '待确认',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  rejected: '已拒绝',
  expired: '已过期',
}

export function proposalStatusTone(status: ProposalStatus): AdminTone {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'sky'
  if (status === 'pending') return 'butter'
  if (status === 'rejected') return 'neutral'
  return 'neutral'
}

/** 方案是否已过期（`expiresAt` 已过；服务端状态为准，这里只用来置灰按钮）。 */
export function isProposalExpired(proposal: ProposalView, now: number = Date.now()): boolean {
  if (proposal.status === 'expired') return true
  const at = Date.parse(proposal.expiresAt)
  return Number.isFinite(at) && at <= now
}

/** 还能不能点「执行 / 拒绝」：只有 pending 且没过期。 */
export function canDecideProposal(proposal: ProposalView, now: number = Date.now()): boolean {
  return proposal.status === 'pending' && !isProposalExpired(proposal, now)
}

/** 能力 id → 中文短名（方案步骤用；目录里没有就退回 id）。 */
export function capabilityTitle(catalog: CapabilityDescriptor[], id: string): string {
  return catalog.find((item) => item.id === id)?.title ?? id
}

export function capabilityClassicPath(catalog: CapabilityDescriptor[], id: string): string | undefined {
  return catalog.find((item) => item.id === id)?.classicPath
}

// ────────────────────────────── 画布 ──────────────────────────────

export const SPEC_KIND_TEXT: Record<CanvasSpec['kind'], string> = {
  stats: '指标',
  table: '表格',
  chart: '图表',
  entity: '实体',
  job: '任务',
  logs: '日志',
  markdown: '说明',
  proposal: '方案',
  'secret-request': '密钥',
}

export const ENTITY_KIND_TEXT: Record<EntityKind, string> = {
  user: '用户',
  instance: '实例',
  plugin: '插件',
  runtime: 'DSH 版本',
  model: '模型',
  job: '任务',
  device: '设备',
  'relay-channel': '渠道',
}

/** 实体卡「在经典页面打开」的地址（docs/24 §3 的 `classicPath` 思路）。 */
export const ENTITY_CLASSIC_PATH: Record<EntityKind, (id: string | number) => string> = {
  user: (id) => `/admin/users/${id}`,
  instance: (id) => `/admin/instances?userId=${id}`,
  plugin: (id) => `/admin/plugins/${id}`,
  runtime: () => '/admin/runtimes',
  model: () => '/admin/models',
  job: (id) => `/admin/jobs/${id}`,
  device: () => '/admin/mobile',
  'relay-channel': () => '/admin/models?tab=channels',
}

/** 实体卡的跳转地址与显示名（`entity` 卡与方案预览共用）。 */
export function normalizeEntity(
  entity: EntityKind,
  id: string | number,
): { classicPath: string; classicLabel: string } {
  return { classicPath: ENTITY_CLASSIC_PATH[entity](id), classicLabel: ENTITY_KIND_TEXT[entity] }
}

/**
 * 取画布卡的数据部分（表格 / 图表 / 日志 / 指标四种卡有）。
 * WP56h 起 `stats` 也能挂 `data.source`：给了就让 Hub 重查，指标卡同样按 `refreshSec` 刷新。
 */
export function canvasDataOf(spec: CanvasSpec): CanvasData | null {
  if (spec.kind === 'table' || spec.kind === 'chart' || spec.kind === 'logs') return spec.data
  if (spec.kind === 'stats') return spec.data ?? null
  return null
}

/**
 * 数据角标（docs/24 §1）：
 * `source` = Hub 用管理员身份重查 →「Hub 数据」；内联 rows = DSH 自己算的 →「DSH 计算」。
 * Hub 自己生成的卡（默认态势卡、方案卡）即使内联数据也算 Hub 数据。
 */
export function canvasDataBadge(spec: CanvasSpec, origin: 'dsh' | 'hub' = 'dsh'): 'hub' | 'dsh' | null {
  const data = canvasDataOf(spec)
  if (!data) return null
  if ('source' in data) return 'hub'
  return origin === 'hub' ? 'hub' : 'dsh'
}

/** 角标文案（`CanvasCard` 用）。 */
export function dataBadgeText(badge: 'hub' | 'dsh'): string {
  return badge === 'hub' ? 'Hub 数据' : 'DSH 计算'
}

export function sortCanvasItems(items: CanvasItem[]): CanvasItem[] {
  return [...items].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
}

// ───────────────────── 状态条读数 → 态势板默认卡（docs/24 §1） ─────────────────────

/**
 * 态势板默认卡的 id（WP56h 图形化后的五张）。
 *
 * 写成常量而不是散在模板里：Hub 后端的 `boardDefaults()`、假数据、状态条的定位逻辑
 * 必须是同一份 id，改一处就全改（`cockpit-mocks` / `cockpit-view` 两个测试也用它对齐）。
 */
export const BOARD_CARD_IDS = {
  /** ①舰况：stats 指标卡（运行实例 value/max、今日请求/积分带 spark） */
  vitals: 'board:vitals',
  /** ②近 7 天中转站用量：堆叠柱（输入 / 输出 tokens） */
  relayUsage: 'board:relay-usage',
  /** ③实例资源：柱状（按用户的内存 MB） */
  instanceResources: 'board:instance-resources',
  /** ④失败任务：明细表（逐行追问） */
  failedJobs: 'board:failed-jobs',
  /** 右舷：待处理方案（逐行追问） */
  pendingProposals: 'board:pending-proposals',
} as const

/** 状态条上可以点的四个读数 */
export type StatusStatKind = 'instances' | 'usage' | 'failed-jobs' | 'pending'

/**
 * 状态条读数 → 定位到哪张默认卡。
 *
 * 「实例」定位到**舰况**（运行实例 5/12 就在那里），不是明细表；「今日用量」定位到 7 天用量图；
 * 「失败任务」定位到失败任务表；「待确认」定位到待处理方案（有 pending 方案时前端会先找方案卡）。
 */
export function statusStatCardId(kind: StatusStatKind): string {
  switch (kind) {
    case 'instances':
      return BOARD_CARD_IDS.vitals
    case 'usage':
      return BOARD_CARD_IDS.relayUsage
    case 'failed-jobs':
      return BOARD_CARD_IDS.failedJobs
    default:
      return BOARD_CARD_IDS.pendingProposals
  }
}

// ────────────────────────────── 投放规则（docs/24 §1） ──────────────────────────────

/** 行动类：默认投右舷 · 行动（`CANVAS_RIGHT_KINDS` 同值，见 docs/24 §1）。 */
const ACTION_KINDS: ReadonlySet<CanvasSpec['kind']> = new Set(CANVAS_RIGHT_KINDS)

/** 数据类默认投左舷，行动类默认投右舷（`auto` 的解析规则；真正的解析在 Hub 服务端）。 */
export function defaultPlacementOf(spec: CanvasSpec): CanvasPlacement {
  return ACTION_KINDS.has(spec.kind) ? 'right' : 'left'
}

/**
 * 前端侧的 `auto` 解析（只在 mock / 「投放态势卡」这类本地动作里用）：
 * 目标舷可视区放不下时投另一舷 —— 用「卡片数」当近似（真值只有 Hub 知道）。
 */
export function resolvePlacement(
  spec: CanvasSpec,
  requested: CanvasPlacementRequest | undefined,
  leftCount: number,
  rightCount: number,
): CanvasPlacement {
  const preferred = requested && requested !== 'auto' ? requested : defaultPlacementOf(spec)
  if (preferred === 'left' && leftCount - rightCount >= 2) return 'right'
  if (preferred === 'right' && rightCount - leftCount >= 2) return 'left'
  return preferred
}

/** 方案卡 / 密钥卡（右舷顶部「待确认」区）。 */
export function isActionSpec(spec: CanvasSpec): boolean {
  return ACTION_KINDS.has(spec.kind)
}

export interface PlacementSplit {
  left: CanvasItem[]
  right: CanvasItem[]
}

/** 按舷分桶（舷内按 order 排好）。 */
export function splitByPlacement(items: CanvasItem[]): PlacementSplit {
  const left: CanvasItem[] = []
  const right: CanvasItem[] = []
  for (const item of sortCanvasItems(items)) {
    if (item.placement === 'right') right.push(item)
    else left.push(item)
  }
  return { left, right }
}

/**
 * 「待确认」区：右舷顶部，方案 pending / 密钥 pending 的卡放这里；
 * 处理完（succeeded/failed/rejected/expired、filled/cancelled）才沉到普通区。
 */
export function isAwaitingConfirmation(
  item: CanvasItem,
  proposals: ProposalView[],
  secrets: SecretRequestView[],
): boolean {
  if (item.spec.kind === 'proposal') {
    const id = item.spec.proposalId
    return proposals.find((row) => row.id === id)?.status === 'pending'
  }
  if (item.spec.kind === 'secret-request') {
    const id = item.spec.requestId
    return secrets.find((row) => row.id === id)?.status === 'pending'
  }
  return false
}

export interface PaneGroups {
  /** 右舷顶部「待确认」区 */
  pending: CanvasItem[]
  /** 普通区（左舷全部、右舷处理完的行动卡） */
  normal: CanvasItem[]
}

/** 一舷之内的分组：右舷先「待确认」，再普通区（舷内各自按 order）。 */
export function groupForPane(
  items: CanvasItem[],
  side: CanvasPlacement,
  proposals: ProposalView[],
  secrets: SecretRequestView[],
): PaneGroups {
  if (side !== 'right') return { pending: [], normal: sortCanvasItems(items) }

  const pending: CanvasItem[] = []
  const normal: CanvasItem[] = []
  for (const item of sortCanvasItems(items)) {
    if (isAwaitingConfirmation(item, proposals, secrets)) pending.push(item)
    else normal.push(item)
  }
  return { pending, normal }
}

/**
 * 拖动换舷 / 舷内排序的落点（docs/24 §1）：
 * 返回要 PATCH 的 `{ placement, order }`。`order` 用落点位置的中值，服务端会重新编号。
 */
export function dropTargetOf(
  items: CanvasItem[],
  draggedId: string,
  side: CanvasPlacement,
  beforeId?: string,
): { placement: CanvasPlacement; order: number } {
  const siblings = sortCanvasItems(items.filter((item) => item.id !== draggedId && item.placement === side))
  const index = beforeId ? siblings.findIndex((item) => item.id === beforeId) : siblings.length
  const position = index < 0 ? siblings.length : index

  const before = siblings[position - 1]
  const after = siblings[position]
  let order: number
  if (before && after) order = (before.order + after.order) / 2
  else if (before) order = before.order + 1
  else if (after) order = after.order - 1
  else order = 1

  return { placement: side, order }
}

// ────────────────────────────── 回合与投放动效（docs/24 §1「实时感」） ──────────────────────────────

export interface TurnState {
  /** iframe 报「回合进行中」（`cockpit.turn`） */
  running: boolean
  /** 本回合开始时刻（ms）；没有回合时为 null */
  startedAt: number | null
}

export function emptyTurnState(): TurnState {
  return { running: false, startedAt: null }
}

/** 收到 `cockpit.turn`：回合开始时记时刻，结束时保留（旧的卡继续变暗，不必清空）。 */
export function applyTurnMessage(state: TurnState, running: boolean, now: number = Date.now()): TurnState {
  if (running) return { running: true, startedAt: state.running ? (state.startedAt ?? now) : now }
  return { ...state, running: false }
}

export type TurnEmphasis = 'current' | 'past' | 'idle'

/**
 * 一张卡的强调档位：
 * - `current`：本回合投放的卡（强调边框）；
 * - `past`：更早的卡（余辉变暗）；
 * - `idle`：不在回合内（没有 `cockpit.turn`）。
 *
 * 判定优先用「这张卡到达前端的时刻」（`arrivedAt`）：DSH 给的 `updatedAt` 是服务端时间，
 * 与浏览器时钟差几秒就会判错；没有到达时刻（比如首屏从接口一次拉下来的）才退回 `updatedAt`。
 */
export function turnEmphasisOf(item: CanvasItem, turn: TurnState, arrivedAt?: number): TurnEmphasis {
  if (turn.startedAt === null) return 'idle'
  const stamp = arrivedAt ?? Date.parse(item.updatedAt || item.createdAt)
  if (!Number.isFinite(stamp)) return 'idle'
  return stamp >= turn.startedAt ? 'current' : 'past'
}

/** 一次算出两舷所有卡的强调档位（父页面渲染时用）。 */
export function buildEmphasis(
  items: CanvasItem[],
  turn: TurnState,
  arrivedAt: Record<string, number> = {},
): Record<string, TurnEmphasis> {
  const result: Record<string, TurnEmphasis> = {}
  for (const item of items) result[item.id] = turnEmphasisOf(item, turn, arrivedAt[item.id])
  return result
}

/** 高度档位的样式类。 */
export function sizeClassOf(size: CanvasSize | undefined): string {
  return `canvas-card--${size ?? 'm'}`
}

// ────────────────────────────── SSE 事件归约 ──────────────────────────────

/**
 * 座舱页的实时状态（SSE 推什么就更新什么，不整页重拉）。
 * 画布按会话分桶：切会话时直接取对应的一桶，事件晚到也不会串到别的会话。
 */
export interface CockpitLive {
  status: OpsStatus | null
  /** 状态条数字（`strip.update` 推） */
  strip: CockpitStatusStrip | null
  canvas: Record<string, CanvasItem[]>
  /** 态势板（钉住的卡 + Hub 默认卡） */
  board: CanvasItem[]
  proposals: ProposalView[]
  secrets: SecretRequestView[]
}

export function emptyCockpitLive(): CockpitLive {
  return { status: null, strip: null, canvas: {}, board: [], proposals: [], secrets: [] }
}

function upsertItem(item: CanvasItem, items: CanvasItem[]): CanvasItem[] {
  const index = items.findIndex((row) => row.id === item.id)
  if (index === -1) return sortCanvasItems([...items, item])
  const next = [...items]
  next[index] = item
  return sortCanvasItems(next)
}

function upsertProposal(proposal: ProposalView, items: ProposalView[]): ProposalView[] {
  const index = items.findIndex((row) => row.id === proposal.id)
  if (index === -1) return [proposal, ...items]
  const next = [...items]
  next[index] = proposal
  return next
}

function upsertSecret(request: SecretRequestView, items: SecretRequestView[]): SecretRequestView[] {
  const index = items.findIndex((row) => row.id === request.id)
  if (index === -1) return [request, ...items]
  const next = [...items]
  next[index] = request
  return next
}

/** 把一条 SSE 事件合进当前状态（返回新对象，方便组件里用 computed 差分）。 */
export function applyCockpitEvent(state: CockpitLive, event: CockpitEvent): CockpitLive {
  switch (event.type) {
    case 'canvas.upsert': {
      const item = event.item
      const canvas = {
        ...state.canvas,
        [item.sessionId]: upsertItem(item, state.canvas[item.sessionId] ?? []),
      }
      // 钉住的卡同时进态势板；取消钉住就从板上撤掉
      const board = item.pinned
        ? upsertItem(item, state.board)
        : state.board.filter((row) => row.id !== item.id)
      return { ...state, canvas, board }
    }
    case 'canvas.remove': {
      const canvas = { ...state.canvas }
      const list = canvas[event.sessionId]
      if (list) canvas[event.sessionId] = list.filter((row) => row.id !== event.id)
      return { ...state, canvas, board: state.board.filter((row) => row.id !== event.id) }
    }
    case 'proposal.upsert':
      return { ...state, proposals: upsertProposal(event.proposal, state.proposals) }
    case 'secret.request':
      return { ...state, secrets: upsertSecret(event.request, state.secrets) }
    case 'ops.status':
      return { ...state, status: event.status }
    case 'strip.update':
      return { ...state, strip: event.strip }
    default:
      return state
  }
}

/**
 * 把 SSE 的 `(事件名, data)` 归一成 `CockpitEvent`。
 *
 * 兼容两种服务端写法（docs/24 §3 只规定了事件体，没规定 `event:` 名与 data 的包装）：
 * 1. `event: canvas.upsert` + `data: {"item": {...}}`；
 * 2. `data: {"type":"canvas.upsert","item":{...}}`（默认事件名 `message`）。
 * 认不出的形状返回 null（宁可不画，也不要把脏数据塞进画布）。
 */
export function normalizeCockpitEvent(name: string, payload: unknown): CockpitEvent | null {
  if (!payload || typeof payload !== 'object') return null

  const raw = payload as Record<string, unknown>
  const type = typeof raw['type'] === 'string' ? raw['type'] : name
  const objectOf = (key: string): Record<string, unknown> | null => {
    const value = raw[key]
    if (value && typeof value === 'object') return value as Record<string, unknown>
    // data 本身就是那个对象（没有一层 key 包装）
    return raw
  }

  function isCanvasItem(value: Record<string, unknown> | null): value is Record<string, unknown> {
    return (
      value !== null &&
      typeof value['id'] === 'string' &&
      typeof value['spec'] === 'object' &&
      value['spec'] !== null
    )
  }

  switch (type) {
    case 'canvas.upsert': {
      const item = objectOf('item')
      if (!isCanvasItem(item)) return null
      return { type, item: item as unknown as CanvasItem }
    }
    case 'canvas.remove': {
      const id = typeof raw['id'] === 'string' ? raw['id'] : undefined
      const sessionId = typeof raw['sessionId'] === 'string' ? raw['sessionId'] : ''
      return id ? { type, id, sessionId } : null
    }
    case 'proposal.upsert': {
      const proposal = objectOf('proposal')
      if (!proposal || typeof proposal['id'] !== 'number') return null
      return { type, proposal: proposal as unknown as ProposalView }
    }
    case 'secret.request': {
      const request = objectOf('request')
      if (!request || typeof request['id'] !== 'string') return null
      return { type, request: request as unknown as SecretRequestView }
    }
    case 'ops.status': {
      const status = objectOf('status')
      if (!status || typeof status['instance'] !== 'string') return null
      return { type, status: status as unknown as OpsStatus }
    }
    case 'strip.update': {
      const strip = objectOf('strip')
      if (!strip || typeof strip['instancesRunning'] !== 'number') return null
      return { type, strip: strip as unknown as CockpitStatusStrip }
    }
    default:
      return null
  }
}

// ────────────────────────────── iframe（postMessage 协议，docs/24 §6） ──────────────────────────────

/** 子 iframe → 父页面（App 网页版嵌入模式发过来的消息，docs/24 §6、docs/26 §5）。 */
export type CockpitInboundMessage =
  /**
   * 新 App（0.4.13 起）会带 `caps`：`['status', 'layout', 'console']`。
   * 老 App 不带（`caps` 为 undefined）——父页面据此判断只能靠 ready 兜底（docs/26 §4.1 最后一句）。
   */
  | { type: 'cockpit.ready'; caps?: string[] }
  /** 新 App 报连接进度（去重后发）：auth → waking → connecting → ready，ready 之后可能 offline */
  | { type: 'cockpit.status'; phase: CockpitAppPhase; message?: string }
  /** `title` 可选（2026-10-30 追加）：App 知道会话标题时带上，两舷铭牌用它 */
  | { type: 'cockpit.session'; sessionId: string | null; title?: string }
  | { type: 'cockpit.auth-expired' }
  | { type: 'cockpit.focus-proposal'; id: number }
  /** 过程行「⟶ 已投放左舷/右舷」被点：闪烁并滚到那张卡 */
  | { type: 'cockpit.focus-canvas'; id: string }
  /** 回合开始/结束：父页面据此区分「本回合」的卡（强调边框 vs 余辉变暗） */
  | { type: 'cockpit.turn'; running: boolean }

const INBOUND_TYPES = new Set([
  'cockpit.ready',
  'cockpit.status',
  'cockpit.session',
  'cockpit.auth-expired',
  'cockpit.focus-proposal',
  'cockpit.focus-canvas',
  'cockpit.turn',
])

/**
 * 解析 iframe 发来的消息。
 *
 * **两个校验，缺一不可**（docs/24 §6「双方都校验 `event.origin === location.origin`」）：
 * 1. 来源必须是本站 origin（别的站点往这个窗口发 postMessage 一律丢掉）；
 * 2. 形状必须是我们认识的那几种，`sessionId` 允许 null 但只允许字符串或 null。
 *
 * docs/26 §5 增补（向后兼容）：`cockpit.ready` 可带 `caps`（只收字符串数组，其它当没带）；
 * 新增 `cockpit.status`（`phase` 必须是六个已知值之一，`message` 只收字符串并截断）。
 */
export function parseCockpitMessage(
  eventOrigin: string,
  expectedOrigin: string,
  data: unknown,
): CockpitInboundMessage | null {
  if (!expectedOrigin || eventOrigin !== expectedOrigin) return null
  if (!data || typeof data !== 'object') return null

  const raw = data as {
    type?: unknown
    sessionId?: unknown
    id?: unknown
    running?: unknown
    title?: unknown
    caps?: unknown
    phase?: unknown
    message?: unknown
  }
  if (typeof raw.type !== 'string' || !INBOUND_TYPES.has(raw.type)) return null

  switch (raw.type) {
    case 'cockpit.ready': {
      // 老 App 不带 caps：字段干脆不出现（`toEqual({type:'cockpit.ready'})` 的老测试不受影响）
      const caps = readCaps(raw.caps)
      return caps ? { type: 'cockpit.ready', caps } : { type: 'cockpit.ready' }
    }
    case 'cockpit.status': {
      if (!isCockpitAppPhase(raw.phase)) return null
      const message = typeof raw.message === 'string' ? raw.message.trim().slice(0, 200) : ''
      return message
        ? { type: 'cockpit.status', phase: raw.phase, message }
        : { type: 'cockpit.status', phase: raw.phase }
    }
    case 'cockpit.auth-expired':
      return { type: 'cockpit.auth-expired' }
    case 'cockpit.session':
      if (raw.sessionId === null) return { type: 'cockpit.session', sessionId: null }
      if (typeof raw.sessionId === 'string' && raw.sessionId.length > 0) {
        const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : ''
        return title
          ? { type: 'cockpit.session', sessionId: raw.sessionId, title }
          : { type: 'cockpit.session', sessionId: raw.sessionId }
      }
      return null
    case 'cockpit.focus-proposal':
      return typeof raw.id === 'number' && Number.isFinite(raw.id)
        ? { type: 'cockpit.focus-proposal', id: raw.id }
        : null
    case 'cockpit.focus-canvas':
      return typeof raw.id === 'string' && raw.id.length > 0
        ? { type: 'cockpit.focus-canvas', id: raw.id }
        : null
    case 'cockpit.turn':
      return typeof raw.running === 'boolean' ? { type: 'cockpit.turn', running: raw.running } : null
    default:
      return null
  }
}

/** `caps` 只收「非空字符串数组」；形状不对当没带（老 App 行为）。 */
function readCaps(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const caps = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return caps.length > 0 ? caps : null
}

/**
 * iframe 地址：`/m/?embed=cockpit&theme=console#code=<一次性交接码>`
 * （码在 hash 里，不进服务器日志；`theme` 原样交给 App 网页版决定配色）。
 *
 * WP58 增补（docs/26 §3 / §5）：AI 助手页传 `theme=console`，App 进入控制台主题；
 * 老 App 不认识 `console` 会当作不传（浅色），Hub 的浅色兜底仍在（`CockpitFrame` 的 MutationObserver）。
 */
/**
 * 两舷铭牌上的会话名：有标题用标题；没有就用短 id（`session-9e3e46f4-…` → `会话 9e3e46`），
 * 不把整串 uuid 糊在铭牌上。
 */
export function sessionLabelOf(sessionId: string, title?: string | null): string {
  if (title) return title
  const core = sessionId.replace(/^(session|sess)[-_]/iu, '')
  return `会话 ${core.slice(0, 6)}`
}

export function cockpitFrameUrl(
  code: string | null,
  options: { path?: string; theme?: string | null } = {},
): string {
  const path = options.path ?? '/m/'
  const theme = options.theme === undefined ? 'console' : options.theme
  const params = new URLSearchParams({ embed: 'cockpit' })
  if (theme) params.set('theme', theme)
  const base = `${path}?${params.toString()}`
  return code ? `${base}#code=${encodeURIComponent(code)}` : base
}

/** docs/26 §5：收到 `cockpit.ready` 后发一次，之后档位变化时再发 */
export type CockpitLayoutMessage = {
  type: 'cockpit.layout'
  scale: number
  sessions: 'docked' | 'menu'
}

/** 父 → 子的消息（发之前调用方要自己带上 targetOrigin）。 */
export type CockpitOutboundMessage =
  | { type: 'cockpit.focus-session'; sessionId: string }
  | { type: 'cockpit.prefill'; text: string }
  | { type: 'cockpit.handoff'; code: string }
  | CockpitLayoutMessage

/**
 * `cockpit.layout` 的载荷整形：`scale` 夹在 1–1.5（协议约定），`sessions` 只认两个值。
 * 老 App 收到不认识的消息会自己忽略，所以多发的这条对它是无害的。
 */
export function cockpitLayoutMessage(layout: CockpitLayoutPayload): CockpitLayoutMessage {
  const scale = Number.isFinite(layout.scale) ? Math.min(1.5, Math.max(1, layout.scale)) : 1
  return {
    type: 'cockpit.layout',
    scale,
    sessions: layout.sessions === 'docked' ? 'docked' : 'menu',
  }
}

// ────────────────────────────── 「问 DSH」预填 ──────────────────────────────

/** 把一行数据压成 `键=值` 的短摘要（最多 6 个字段，供「追问这一行」用）。 */
export function summarizeRow(row: Record<string, unknown>, maxFields = 6): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || value === '') continue
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`)
    if (parts.length >= maxFields) break
  }
  return parts.join('，')
}

/** 卡片级「问 DSH」：把卡片标题与类型告诉它，让它接着这张卡说下去。 */
export function prefillForCard(item: CanvasItem): string {
  return `关于画布上的「${item.title}」（${SPEC_KIND_TEXT[item.spec.kind]}），`
}

/** 表格行的「追问这一行」。 */
export function prefillForRow(item: CanvasItem, row: Record<string, unknown>): string {
  const summary = summarizeRow(row)
  return summary ? `追问「${item.title}」里的这一行：${summary}。` : `追问「${item.title}」里的一行。`
}

// ────────────────────────────── 格子格式化 ──────────────────────────────

/** 表格 / 图表的格子文案（`CanvasSpec.columns[].format`）。 */
export function formatCanvasCell(value: unknown, format: CanvasColumnFormat = 'text'): string {
  if (value === null || value === undefined || value === '') return '—'

  switch (format) {
    case 'number': {
      const num = Number(value)
      return Number.isFinite(num) ? formatCount(num, Number.isInteger(num) ? 0 : 2) : String(value)
    }
    case 'credits': {
      const num = Number(value)
      return Number.isFinite(num) ? `${formatCount(num, 2)}` : String(value)
    }
    case 'bytes': {
      const num = Number(value)
      return Number.isFinite(num) ? formatBytes(num) : String(value)
    }
    case 'datetime':
      return formatCellDateTime(String(value))
    case 'status': {
      const key = String(value)
      // 实例状态优先：「running」在画布表格里基本都是实例；任务状态覆盖剩下的（queued/succeeded/…）
      const instance = instanceStatusMeta(key)
      if (instance.text !== '未知') return instance.text
      const job = JOB_STATUS_TEXT[key as keyof typeof JOB_STATUS_TEXT]
      // 不认识的取值原样显示，别把数据吞掉
      return job ?? key
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

// ────────────────────────────── 图表数据 ──────────────────────────────

export interface CanvasChartSeries {
  label: string
  /** CSS 变量（`var(--c-series-N)` / `var(--c-series-other)`），不写死颜色 */
  color: string
  values: number[]
  /** 第 7 条起复用色位，用虚线作第二编码（19 §2.2 同一做法） */
  dashed: boolean
}

export interface CanvasChartData {
  labels: string[]
  series: CanvasChartSeries[]
  /** y 轴上限（0 表示没有数据） */
  max: number
}

const SERIES_SLOTS = 6

/**
 * 表格里的时间：今年的省掉年份（`10-29 21:02`），舷侧表格很窄，整串 `2026-10-29 21:02` 会被截成「2026-10」；
 * 跨年才写全。解析不了的原样交给 formatDateTime。
 */
function formatCellDateTime(text: string): string {
  const full = formatDateTime(text)
  const year = String(new Date().getFullYear())
  return full.startsWith(`${year}-`) ? full.slice(year.length + 1) : full
}

function labelOf(value: unknown, format: 'date' | 'datetime' | 'text' | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (format === 'date') return text.length >= 10 ? text.slice(5, 10) : text
  if (format === 'datetime') return formatDateTime(text)
  return text
}

/** 把 `chart` 卡的 rows 摊成「x 轴标签 + 每条系列的值」。 */
export function buildCanvasChartData(
  spec: Extract<CanvasSpec, { kind: 'chart' }>,
  rows: Record<string, unknown>[],
): CanvasChartData {
  const labels = rows.map((row) => labelOf(row[spec.x.key], spec.x.format))
  const series = spec.series.map((entry, index) => ({
    label: entry.label,
    color: index < SERIES_SLOTS ? `var(--c-series-${String(index + 1)})` : 'var(--c-series-other)',
    values: rows.map((row) => {
      const num = Number(row[entry.key])
      return Number.isFinite(num) ? num : 0
    }),
    dashed: index >= SERIES_SLOTS,
  }))

  let max = 0
  for (const entry of series) for (const value of entry.values) max = Math.max(max, value)
  return { labels, series, max }
}

/** 图表的 x 轴标签最多显示几个（窄卡里少显示一些，避免重叠）。 */
export function axisLabelStep(count: number, slots: number): number {
  if (count <= 0) return 1
  return Math.max(1, Math.ceil(count / Math.max(1, slots)))
}

// ─────────────────── 图表几何与「能用图就用图」的派生数据（WP56h） ───────────────────

export interface CanvasPathPoint {
  x: number
  y: number
}

/**
 * 单调三次曲线路径（Fritsch–Carlson，WP56h）。
 *
 * 为什么不用 Catmull-Rom：它会「过冲」——两点之间冲到数据范围外，画出来像是用量突然涨了一截
 * （实测 7 天曲线在峰值前后各多出一个假尖）。单调三次保证每个区间的极值只落在两个端点之间，
 * 转折处仍然是圆滑的，这才是仪表盘上该有的形状。
 *
 * 返回 SVG `d`（M/L/C 指令）。点数 < 2 时退化成 `M`；两个点直接画直线（曲线没有意义）。
 */
export function monotoneCubicPath(points: CanvasPathPoint[]): string {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (clean.length === 0) return ''
  const fix = (value: number): string => value.toFixed(1)
  if (clean.length === 1) return `M${fix(clean[0]!.x)},${fix(clean[0]!.y)}`
  if (clean.length === 2) {
    return `M${fix(clean[0]!.x)},${fix(clean[0]!.y)} L${fix(clean[1]!.x)},${fix(clean[1]!.y)}`
  }

  const count = clean.length
  // 区间斜率（dx 为 0 时斜率记 0，避免除零）
  const slopes: number[] = []
  for (let index = 0; index < count - 1; index += 1) {
    const dx = clean[index + 1]!.x - clean[index]!.x
    const dy = clean[index + 1]!.y - clean[index]!.y
    slopes.push(dx === 0 ? 0 : dy / dx)
  }

  // 端点切线取相邻斜率；内部点取两段斜率的平均，再按 Fritsch–Carlson 夹紧到 [0, 3·min]
  const tangents: number[] = new Array<number>(count).fill(0)
  tangents[0] = slopes[0] ?? 0
  tangents[count - 1] = slopes[count - 2] ?? 0
  for (let index = 1; index < count - 1; index += 1) {
    const before = slopes[index - 1] ?? 0
    const after = slopes[index] ?? 0
    if (before * after <= 0) {
      // 峰/谷：切线压平，曲线不会翻过端点
      tangents[index] = 0
      continue
    }
    const average = (before + after) / 2
    const limit = 3 * Math.min(Math.abs(before), Math.abs(after))
    tangents[index] = Math.sign(average) * Math.min(Math.abs(average), limit)
  }
  // 端点同样夹紧（否则第一段会先冲高再回落）
  for (const index of [0, count - 1]) {
    const slope = slopes[index === 0 ? 0 : count - 2] ?? 0
    const tangent = tangents[index] ?? 0
    if (slope === 0 || tangent * slope <= 0) tangents[index] = 0
    else tangents[index] = Math.sign(tangent) * Math.min(Math.abs(tangent), 3 * Math.abs(slope))
  }

  let path = `M${fix(clean[0]!.x)},${fix(clean[0]!.y)}`
  for (let index = 0; index < count - 1; index += 1) {
    const from = clean[index]!
    const to = clean[index + 1]!
    const dx = (to.x - from.x) / 3
    const c1x = from.x + dx
    const c1y = from.y + (tangents[index] ?? 0) * dx
    const c2x = to.x - dx
    const c2y = to.y - (tangents[index + 1] ?? 0) * dx
    path += ` C${fix(c1x)},${fix(c1y)} ${fix(c2x)},${fix(c2y)} ${fix(to.x)},${fix(to.y)}`
  }
  return path
}

const COMPACT_UNITS: readonly { limit: number; suffix: string }[] = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
]

/** 紧凑数字：45200 → `45.2K`，1_200_000 → `1.2M`；小于 1000 时保留原值（坐标轴与柱顶标签用）。 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs < 1e3) return formatCount(value, Number.isInteger(value) ? 0 : 1)
  for (const unit of COMPACT_UNITS) {
    if (abs < unit.limit) continue
    const scaled = value / unit.limit
    // 一位小数就够看趋势；整数就不再写 `.0`
    const text = formatCount(scaled, Math.abs(scaled) >= 100 ? 0 : 1)
    return `${text.replace(/\.0$/, '')}${unit.suffix}`
  }
  return formatCount(value, 0)
}

export interface CanvasDonutSlice {
  label: string
  value: number
  /** 占总数百分比（0–100，保留 1 位） */
  percent: number
  /** CSS 变量（`var(--c-series-N)`），不写死颜色 */
  color: string
}

export interface CanvasDonutData {
  slices: CanvasDonutSlice[]
  total: number
  /** 第一条系列的展示名（图例抬头用） */
  seriesLabel: string
}

/**
 * `chart: 'donut'` 的数据（WP56h）：**一行一个扇区**，`x.key` 是分类名、`series[0].key` 是数值。
 *
 * 负值/非数字按 0 处理；总数为 0 时给出空 slices（渲染器显示「没有可比较的数据」）。
 */
export function buildCanvasDonutData(
  spec: Extract<CanvasSpec, { kind: 'chart' }>,
  rows: Record<string, unknown>[],
): CanvasDonutData {
  const valueKey = spec.series[0]?.key ?? ''
  const raw = rows.map((row) => {
    const num = Number(row[valueKey])
    return {
      label: labelOf(row[spec.x.key], spec.x.format) || '—',
      value: Number.isFinite(num) && num > 0 ? num : 0,
    }
  })
  const total = raw.reduce((sum, entry) => sum + entry.value, 0)
  const slices =
    total <= 0
      ? []
      : raw.map((entry, index) => ({
          label: entry.label,
          value: entry.value,
          percent: Math.round((entry.value / total) * 1000) / 10,
          color: index < SERIES_SLOTS ? `var(--c-series-${String(index + 1)})` : 'var(--c-series-other)',
        }))
  return { slices, total, seriesLabel: spec.series[0]?.label ?? '' }
}

/**
 * `stats` 卡配 `data.source` 时：把 Hub 重查回来的**每一行**变成一项指标（WP56h）。
 *
 * 行形状就是 `CanvasStatsItem`：`{label,value,unit?,delta?,tone?,max?,spark?}`。
 * 这里做的是「别让脏数据把渲染器弄崩」的收口：缺 label 的行丢掉、max 必须 >0、
 * spark 只收数字且最多 60 点、tone 只认四个值。
 */
export function buildCanvasStatsItems(rows: Record<string, unknown>[]): CanvasStatsItem[] {
  const tones = new Set(['neutral', 'good', 'warn', 'bad'])
  const items: CanvasStatsItem[] = []
  for (const row of rows) {
    const label = typeof row['label'] === 'string' ? row['label'].trim() : ''
    if (label.length === 0) continue
    const rawValue = row['value']
    const value =
      typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : String(rawValue ?? '—')
    const item: CanvasStatsItem = { label: label.slice(0, 60), value }
    const unit = typeof row['unit'] === 'string' ? row['unit'].trim() : ''
    if (unit) item.unit = unit.slice(0, 16)
    if (typeof row['delta'] === 'number' && Number.isFinite(row['delta'])) item.delta = row['delta']
    const tone = typeof row['tone'] === 'string' && tones.has(row['tone']) ? row['tone'] : ''
    if (tone) item.tone = tone as CanvasStatsItem['tone']
    if (typeof row['max'] === 'number' && Number.isFinite(row['max']) && row['max'] > 0) item.max = row['max']
    if (Array.isArray(row['spark'])) {
      const spark = row['spark']
        .filter((point): point is number => typeof point === 'number' && Number.isFinite(point))
        .slice(-60)
      if (spark.length > 0) item.spark = spark
    }
    items.push(item)
  }
  return items.slice(0, 12)
}

/**
 * 表格空态那一句话（docs/24 §1，WP56h）：空表不留空表头，说人话。
 *
 * - 「失败任务」= `jobs.list` + `status: failed`，没有行 = 一切正常；
 * - 「待处理方案」= `cockpit.pending-proposals`，没有行 = 没有待确认的操作；
 * - 其它表格给 undefined（渲染器退回「没有数据」）。
 */
export function canvasTableEmptyText(spec: CanvasSpec): string | undefined {
  if (spec.kind !== 'table') return undefined
  if (!('source' in spec.data)) return undefined
  const { capability, args } = spec.data.source
  if (capability === 'jobs.list' && args['status'] === 'failed') return '一切正常'
  if (capability === 'cockpit.pending-proposals') return '没有待确认的操作'
  return undefined
}

/** 表格数值列的数据条：列最大值（0 时不画条）。只在行数 ≤20 时用。 */
export function tableBarMax(rows: Record<string, unknown>[], key: string): number {
  let max = 0
  for (const row of rows) {
    const num = Math.abs(Number(row[key]))
    if (Number.isFinite(num)) max = Math.max(max, num)
  }
  return max
}

/** 数据条的比例（0–1；按列最大值归一，最少 2% 让「有值但很小」的格子也看得见）。 */
export function tableBarRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  const ratio = Math.abs(value) / max
  // 0 就是没有条；非 0 但极小也给 2%，否则格子看起来是空的
  if (ratio <= 0) return 0
  return Math.min(1, Math.max(0.02, ratio))
}

// ────────────────────────────── 顶栏胶囊 ──────────────────────────────

export interface OpsStatusMeta {
  text: string
  tone: AdminTone
  /** 启动中 / 异常时胶囊上的图标转起来 */
  spinning: boolean
}

export function opsStatusMeta(status: OpsStatus | null): OpsStatusMeta {
  switch (status?.instance) {
    case 'running':
      return { text: '运行中', tone: 'success', spinning: false }
    case 'starting':
      return { text: '启动中', tone: 'sky', spinning: true }
    case 'stopped':
      return { text: '已停止', tone: 'neutral', spinning: false }
    case 'missing':
      return { text: '未创建', tone: 'butter', spinning: false }
    case 'error':
      return { text: '异常', tone: 'danger', spinning: false }
    default:
      return { text: '状态未知', tone: 'neutral', spinning: false }
  }
}

/** 胶囊悬浮文字：状态 + 模型 + 服务端给的原因（I6：模型不可用时要说清为什么）。 */
export function opsStatusHint(status: OpsStatus | null): string {
  if (!status) return '正在读取座舱状态…'
  const parts: string[] = []
  if (status.model) parts.push(`模型 ${status.model}`)
  if (status.autoExecuteR1) parts.push('R1 自动执行已开启')
  if (status.reason) parts.push(status.reason)
  return parts.length > 0 ? parts.join(' · ') : '座舱 DSH 状态正常'
}
