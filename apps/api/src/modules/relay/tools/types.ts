import type {
  MyToolsResponse,
  ToolChannel,
  ToolChannelKey,
  ToolChannelKind,
  ToolKind,
  ToolOverviewResponse,
  ToolSettings,
  ToolSettingsResponse,
  ToolUsageListResponse,
  ToolUsageQuery,
  ToolUsageRow,
  ToolUsageStatus,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../../context.js'

/**
 * 搜索 / 抓取池（14 §2、§3）的内部类型：数据库行形状、候选排序输入、上游错误分类。
 *
 * 与 relay 的模型渠道分开：计费语义不同（按次 + 免费额度），冷却原因也不同
 * （Tavily 432/433 是「本月额度用完」而不是「限流」）。
 */

/** `relay_tool_channels` 行（数据库列 snake_case，DTO 在 repo 层转 camelCase） */
export interface ToolChannelRow {
  id: number
  kind: ToolChannelKind
  name: string
  base_url: string
  tools_json: string
  priority: number
  weight: number
  timeout_ms: number
  proxy_url: string | null
  search_cost: number
  fetch_cost: number
  enabled: number
  note: string
  fail_streak: number
  cooldown_until: string | null
  last_error: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

/** `relay_tool_keys` 行 */
export interface ToolKeyRow {
  id: number
  channel_id: number
  label: string
  key_enc: string
  key_hash: string
  last4: string
  state: 'active' | 'disabled' | 'auto-disabled'
  cooldown_until: string | null
  cooldown_reason: 'rate-limit' | 'exhausted' | 'error' | null
  last_error: string | null
  last_error_at: string | null
  last_used_at: string | null
  created_at: string
}

/** `relay_tool_usage` 行 */
export interface ToolUsageRowDb {
  id: number
  user_id: number
  key_id: number | null
  tool: ToolKind
  status: ToolUsageStatus
  free: number
  cost: number
  channel_id: number | null
  tool_key_id: number | null
  upstream_cost: number | null
  attempts: number
  duration_ms: number
  summary: string
  error: string | null
  month: string
  created_at: string
}

/** 上游返回的失败分类（14 §3.1 的表）：决定换候选还是直接回 400 */
export type ToolUpstreamFailure = 'unauthorized' | 'rate-limit' | 'exhausted' | 'upstream' | 'client'

/** 上游结果（两种上游都归一到 DeepSeek 格式） */
export type ToolUpstreamResult =
  | { tool: 'search'; results: { url: string; title: string; snippet: string; date: string | null }[] }
  | { tool: 'fetch'; content: string }

/** 一次「渠道 × 密钥」候选（顺序即尝试顺序） */
export interface ToolCandidate {
  channelId: number
  channelName: string
  kind: ToolChannelKind
  keyId: number
  keyIndex: number
  lastResort: boolean
}

/** 管理端 / 用户端接口暴露给路由层的形状（relay service 的 `tools` 字段） */
export interface ToolService {
  // ── 设置 ────────────────────────────────────────────────────────────────
  getSettings(): ToolSettings
  settingsResponse(): ToolSettingsResponse
  updateSettings(patch: Partial<ToolSettings>, actorId: number, meta: RequestMeta): ToolSettingsResponse

  // ── 渠道 ────────────────────────────────────────────────────────────────
  listChannels(): ToolChannel[]
  createChannel(
    input: import('@dsh-hub/shared').CreateToolChannelRequest,
    actorId: number,
    meta: RequestMeta,
  ): ToolChannel
  updateChannel(
    channelId: number,
    input: import('@dsh-hub/shared').UpdateToolChannelRequest,
    actorId: number,
    meta: RequestMeta,
  ): ToolChannel
  deleteChannel(channelId: number, actorId: number, meta: RequestMeta): void
  addChannelKeys(
    channelId: number,
    input: import('@dsh-hub/shared').AddToolChannelKeysRequest,
    actorId: number,
    meta: RequestMeta,
  ): { channel: ToolChannel; added: number; skipped: number }
  updateChannelKey(
    channelId: number,
    keyId: number,
    input: import('@dsh-hub/shared').UpdateToolChannelKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): ToolChannel
  deleteChannelKey(channelId: number, keyId: number, actorId: number, meta: RequestMeta): void
  testChannel(channelId: number): Promise<import('@dsh-hub/shared').TestToolChannelResponse>

  // ── 用量 ────────────────────────────────────────────────────────────────
  overview(): ToolOverviewResponse
  usageList(query: ToolUsageQuery, opts: { userId?: number; scope: 'user' | 'admin' }): ToolUsageListResponse
  myTools(userId: number): MyToolsResponse

  // ── 转发 ────────────────────────────────────────────────────────────────
  /** 处理一次 `/v1/tools/*`；鉴权已在路由层完成（`auth` 传进来） */
  forward(
    tool: ToolKind,
    body: Record<string, unknown>,
    auth: import('../types.js').RelayAuthResult,
  ): Promise<ToolForwardOutcome>

  // ── 下发到 DSH ──────────────────────────────────────────────────────────
  /**
   * 该用户要渲染进 `managed.patch.yml` 的搜索/抓取条目（14 §5）。
   * `needsKey` = 还要给容器注入 `HUB_MK_HUB`（用户没有 hub-relay 提供方时）。
   */
  renderForUser(userId: number): {
    entries: import('../../models/patch-entries.js').PatchEntry[]
    warnings: string[]
    needsKey: boolean
  }
  /** 工具设置的渲染指纹（进入 managed 配置哈希，设置变化 → 需要重新下发） */
  renderFingerprint(): string
  /** 最后一次影响下发的设置变更时间（ISO；从没改过 = null），「待下发」判定用 */
  pendingAt(): string | null
  /** 用户是否已经下发了搜索（`dshAttached`） */
  attachedForUser(userId: number): boolean
}

/** `/v1/tools/*` 的结果：路由层据此写状态码与响应体 */
export type ToolForwardOutcome =
  | { kind: 'ok'; status: 200; body: unknown; free: boolean; cost: number }
  | { kind: 'error'; status: number; code: string; message: string }

export type ToolChannelKeyDto = ToolChannelKey
export type ToolUsageRowDto = ToolUsageRow
