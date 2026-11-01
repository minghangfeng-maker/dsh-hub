import type {
  ToolChannel,
  ToolChannelHealth,
  ToolChannelKey,
  ToolKind,
  ToolUsageRow,
  ToolUsageStatus,
} from '@dsh-hub/shared'
import type { HubDb } from '../../../db/index.js'
import { relayClientKindOf } from '../keys.js'
import { parseJsonColumn } from '../repo.js'
import type { ToolChannelRow, ToolKeyRow, ToolUsageRowDb } from './types.js'

/**
 * 搜索池的 SQL 层（14 §4）：全部参数化；DTO 的 camelCase 转换都在这里。
 * 事务由 service 用 `db.tx()` 组合（本文件不自己开事务）。
 */

export function parseToolKinds(raw: string): ToolKind[] {
  const parsed = parseJsonColumn<unknown>(raw, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is ToolKind => item === 'search' || item === 'fetch')
}

export function toToolChannelKey(row: ToolKeyRow, monthCalls: number): ToolChannelKey {
  return {
    id: row.id,
    label: row.label,
    last4: row.last4,
    state: row.state,
    cooldownUntil: row.cooldown_until,
    cooldownReason: row.cooldown_reason,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastUsedAt: row.last_used_at,
    monthCalls,
    createdAt: row.created_at,
  }
}

/** 渠道健康（14 §3.2 的 `ToolChannelHealthSchema`）：停用 > 冷却 > 没有可用密钥 > ok */
export function toolChannelHealth(
  row: ToolChannelRow,
  keys: ToolKeyRow[],
  nowIso: string,
): ToolChannelHealth {
  if (row.enabled !== 1) return 'disabled'
  const until = row.cooldown_until ? Date.parse(row.cooldown_until) : Number.NaN
  if (Number.isFinite(until) && until > Date.parse(nowIso)) return 'cooling'
  const nowMs = Date.parse(nowIso)
  const usable = keys.some((key) => {
    if (key.state !== 'active') return false
    if (!key.cooldown_until) return true
    const keyUntil = Date.parse(key.cooldown_until)
    return !Number.isFinite(keyUntil) || keyUntil <= nowMs
  })
  if (!usable) return 'no-key'
  return 'ok'
}

export function toToolChannel(
  row: ToolChannelRow,
  keys: ToolKeyRow[],
  monthCalls: Map<number, number>,
  nowIso: string,
): ToolChannel {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.base_url,
    tools: parseToolKinds(row.tools_json),
    priority: row.priority,
    weight: row.weight,
    timeoutMs: row.timeout_ms,
    proxyUrl: row.proxy_url,
    searchCostMicro: row.search_cost,
    fetchCostMicro: row.fetch_cost,
    enabled: row.enabled === 1,
    note: row.note,
    keys: keys.map((key) => toToolChannelKey(key, monthCalls.get(key.id) ?? 0)),
    health: toolChannelHealth(row, keys, nowIso),
    failStreak: row.fail_streak,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ToolUsageJoinRow extends ToolUsageRowDb {
  username: string
  channel_name: string | null
  /** 调用用的那把用户密钥的类型与设备（`relay_keys`；密钥被删后为 null） */
  key_kind: string | null
  key_device_id: string | null
}

export function toToolUsageRow(row: ToolUsageJoinRow, opts: { hideChannel: boolean }): ToolUsageRow {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    tool: row.tool,
    status: row.status,
    free: row.free === 1,
    costMicro: row.cost,
    channelName: opts.hideChannel ? null : (row.channel_name ?? null),
    upstreamCostMicro: opts.hideChannel ? null : row.upstream_cost,
    attempts: row.attempts,
    durationMs: row.duration_ms,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    clientKind: relayClientKindOf({
      kind: row.key_kind === 'system' ? 'system' : 'user',
      deviceId: row.key_device_id,
    }),
  }
}

// ── 渠道 ────────────────────────────────────────────────────────────────────

export function listToolChannelRows(db: HubDb): ToolChannelRow[] {
  return db.all<ToolChannelRow>('SELECT * FROM relay_tool_channels ORDER BY priority DESC, id ASC')
}

export function getToolChannelRow(db: HubDb, id: number): ToolChannelRow | undefined {
  return db.get<ToolChannelRow>('SELECT * FROM relay_tool_channels WHERE id = ?', id)
}

export function getToolChannelRowByName(db: HubDb, name: string): ToolChannelRow | undefined {
  return db.get<ToolChannelRow>('SELECT * FROM relay_tool_channels WHERE name = ?', name)
}

export interface InsertToolChannelInput {
  kind: string
  name: string
  baseUrl: string
  tools: ToolKind[]
  priority: number
  weight: number
  timeoutMs: number
  proxyUrl: string | null
  searchCost: number
  fetchCost: number
  enabled: boolean
  note: string
  at: string
}

export function insertToolChannelRow(db: HubDb, input: InsertToolChannelInput): number {
  const result = db.run(
    `INSERT INTO relay_tool_channels
       (kind, name, base_url, tools_json, priority, weight, timeout_ms, proxy_url,
        search_cost, fetch_cost, enabled, note, fail_streak, cooldown_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    input.kind,
    input.name,
    input.baseUrl,
    JSON.stringify(input.tools),
    input.priority,
    input.weight,
    input.timeoutMs,
    input.proxyUrl,
    input.searchCost,
    input.fetchCost,
    input.enabled ? 1 : 0,
    input.note,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdateToolChannelInput {
  name?: string
  baseUrl?: string
  tools?: ToolKind[]
  priority?: number
  weight?: number
  timeoutMs?: number
  proxyUrl?: string | null
  searchCost?: number
  fetchCost?: number
  enabled?: boolean
  note?: string
  failStreak?: number
  cooldownUntil?: string | null
  lastError?: string | null
  lastErrorAt?: string | null
}

const TOOL_CHANNEL_COLUMNS: Record<keyof UpdateToolChannelInput, string> = {
  name: 'name',
  baseUrl: 'base_url',
  tools: 'tools_json',
  priority: 'priority',
  weight: 'weight',
  timeoutMs: 'timeout_ms',
  proxyUrl: 'proxy_url',
  searchCost: 'search_cost',
  fetchCost: 'fetch_cost',
  enabled: 'enabled',
  note: 'note',
  failStreak: 'fail_streak',
  cooldownUntil: 'cooldown_until',
  lastError: 'last_error',
  lastErrorAt: 'last_error_at',
}

export function updateToolChannelRow(db: HubDb, id: number, patch: UpdateToolChannelInput, at: string): void {
  const sets: string[] = []
  const params: (string | number | null)[] = []
  for (const [key, column] of Object.entries(TOOL_CHANNEL_COLUMNS) as [
    keyof UpdateToolChannelInput,
    string,
  ][]) {
    const value = patch[key]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    if (key === 'tools') params.push(JSON.stringify(value))
    else if (typeof value === 'boolean') params.push(value ? 1 : 0)
    else params.push(value as string | number | null)
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  params.push(at)
  params.push(id)
  db.run(`UPDATE relay_tool_channels SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

export function deleteToolChannelRow(db: HubDb, id: number): void {
  db.run('DELETE FROM relay_tool_channels WHERE id = ?', id)
}

// ── 渠道密钥 ────────────────────────────────────────────────────────────────

export function listToolKeyRows(db: HubDb, channelId: number): ToolKeyRow[] {
  return db.all<ToolKeyRow>('SELECT * FROM relay_tool_keys WHERE channel_id = ? ORDER BY id ASC', channelId)
}

export function listToolKeyRowsByChannels(db: HubDb, channelIds: number[]): ToolKeyRow[] {
  if (channelIds.length === 0) return []
  const placeholders = channelIds.map(() => '?').join(', ')
  return db.all<ToolKeyRow>(
    `SELECT * FROM relay_tool_keys WHERE channel_id IN (${placeholders}) ORDER BY id ASC`,
    ...channelIds,
  )
}

export function getToolKeyRow(db: HubDb, id: number): ToolKeyRow | undefined {
  return db.get<ToolKeyRow>('SELECT * FROM relay_tool_keys WHERE id = ?', id)
}

export function findToolKeyRowByHash(db: HubDb, channelId: number, keyHash: string): ToolKeyRow | undefined {
  return db.get<ToolKeyRow>(
    'SELECT * FROM relay_tool_keys WHERE channel_id = ? AND key_hash = ?',
    channelId,
    keyHash,
  )
}

export interface InsertToolKeyInput {
  channelId: number
  label: string
  keyEnc: string
  keyHash: string
  last4: string
  at: string
}

export function insertToolKeyRow(db: HubDb, input: InsertToolKeyInput): number {
  const result = db.run(
    `INSERT INTO relay_tool_keys (channel_id, label, key_enc, key_hash, last4, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    input.channelId,
    input.label,
    input.keyEnc,
    input.keyHash,
    input.last4,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdateToolKeyInput {
  label?: string
  state?: 'active' | 'disabled' | 'auto-disabled'
  cooldownUntil?: string | null
  cooldownReason?: 'rate-limit' | 'exhausted' | 'error' | null
  lastError?: string | null
  lastErrorAt?: string | null
  lastUsedAt?: string | null
}

const TOOL_KEY_COLUMNS: Record<keyof UpdateToolKeyInput, string> = {
  label: 'label',
  state: 'state',
  cooldownUntil: 'cooldown_until',
  cooldownReason: 'cooldown_reason',
  lastError: 'last_error',
  lastErrorAt: 'last_error_at',
  lastUsedAt: 'last_used_at',
}

export function updateToolKeyRow(db: HubDb, id: number, patch: UpdateToolKeyInput): void {
  const sets: string[] = []
  const params: (string | number | null)[] = []
  for (const [key, column] of Object.entries(TOOL_KEY_COLUMNS) as [keyof UpdateToolKeyInput, string][]) {
    const value = patch[key]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    params.push(value as string | null)
  }
  if (sets.length === 0) return
  params.push(id)
  db.run(`UPDATE relay_tool_keys SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

export function deleteToolKeyRow(db: HubDb, id: number): void {
  db.run('DELETE FROM relay_tool_keys WHERE id = ?', id)
}

/** 冷却到期的密钥回到 active（读列表时顺手清理，和 relay 渠道密钥一样不需要定时器） */
export function clearExpiredToolKeyCooldowns(db: HubDb, nowIso: string): void {
  db.run(
    `UPDATE relay_tool_keys
        SET cooldown_until = NULL, cooldown_reason = NULL
      WHERE cooldown_until IS NOT NULL AND cooldown_until <= ?`,
    nowIso,
  )
}

/** 某渠道各密钥本自然月成功的调用数（`status='ok'`，14 §4） */
export function toolKeyMonthCalls(db: HubDb, channelId: number, month: string): Map<number, number> {
  const rows = db.all<{ tool_key_id: number; n: number }>(
    `SELECT tool_key_id, COUNT(*) AS n
       FROM relay_tool_usage
      WHERE channel_id = ? AND month = ? AND status = 'ok' AND tool_key_id IS NOT NULL
      GROUP BY tool_key_id`,
    channelId,
    month,
  )
  return new Map(rows.map((row) => [row.tool_key_id, Number(row.n)]))
}

// ── 用量 ────────────────────────────────────────────────────────────────────

export interface InsertToolUsageInput {
  userId: number
  keyId: number | null
  tool: ToolKind
  status: ToolUsageStatus
  free: boolean
  cost: number
  channelId: number | null
  toolKeyId: number | null
  upstreamCost: number | null
  attempts: number
  durationMs: number
  summary: string
  error: string | null
  month: string
  at: string
}

export function insertToolUsageRow(db: HubDb, input: InsertToolUsageInput): number {
  const result = db.run(
    `INSERT INTO relay_tool_usage
       (user_id, key_id, tool, status, free, cost, channel_id, tool_key_id, upstream_cost,
        attempts, duration_ms, summary, error, month, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.userId,
    input.keyId,
    input.tool,
    input.status,
    input.free ? 1 : 0,
    input.cost,
    input.channelId,
    input.toolKeyId,
    input.upstreamCost,
    input.attempts,
    input.durationMs,
    input.summary,
    input.error,
    input.month,
    input.at,
  )
  return result.lastInsertRowid
}

/** 本月已用免费次数（`free=1` 的调用；失败调用记 free=0 不占额度，14 §4） */
export function countFreeToolCalls(db: HubDb, userId: number, month: string): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM relay_tool_usage WHERE user_id = ? AND month = ? AND free = 1',
    userId,
    month,
  )
  return Number(row?.n ?? 0)
}

export interface ToolUsageQueryOptions {
  userId?: number
  tool?: ToolKind
  status?: ToolUsageStatus
  limit: number
  offset: number
}

export function listToolUsageRows(
  db: HubDb,
  opts: ToolUsageQueryOptions,
): { rows: ToolUsageJoinRow[]; total: number } {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.userId !== undefined) {
    where.push('u.user_id = ?')
    params.push(opts.userId)
  }
  if (opts.tool !== undefined) {
    where.push('u.tool = ?')
    params.push(opts.tool)
  }
  if (opts.status !== undefined) {
    where.push('u.status = ?')
    params.push(opts.status)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_tool_usage u ${clause}`, ...params)
  const rows = db.all<ToolUsageJoinRow>(
    `SELECT u.*, COALESCE(us.username, '') AS username, c.name AS channel_name,
            rk.kind AS key_kind, rk.device_id AS key_device_id
       FROM relay_tool_usage u
       LEFT JOIN users us ON us.id = u.user_id
       LEFT JOIN relay_tool_channels c ON c.id = u.channel_id
       LEFT JOIN relay_keys rk ON rk.id = u.key_id
       ${clause}
      ORDER BY u.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    opts.limit,
    opts.offset,
  )
  return { rows, total: Number(total?.n ?? 0) }
}

/** 用户本月调用与花费（含失败，用于「本月调用与花费」） */
export function toolMonthTotals(
  db: HubDb,
  userId: number,
  month: string,
): { calls: number; cost: number; freeCalls: number } {
  const row = db.get<{ calls: number; cost: number | null; free_calls: number | null }>(
    `SELECT COUNT(*) AS calls, SUM(cost) AS cost, SUM(free) AS free_calls
       FROM relay_tool_usage WHERE user_id = ? AND month = ?`,
    userId,
    month,
  )
  return {
    calls: Number(row?.calls ?? 0),
    cost: Number(row?.cost ?? 0),
    freeCalls: Number(row?.free_calls ?? 0),
  }
}

/** 管理端概览：本月总计 */
export function toolOverviewTotals(
  db: HubDb,
  month: string,
): { calls: number; freeCalls: number; revenue: number; upstreamCost: number } {
  const row = db.get<{
    calls: number
    free_calls: number | null
    revenue: number | null
    upstream_cost: number | null
  }>(
    `SELECT COUNT(*) AS calls, SUM(free) AS free_calls, SUM(cost) AS revenue,
            SUM(COALESCE(upstream_cost, 0)) AS upstream_cost
       FROM relay_tool_usage WHERE month = ? AND status = 'ok'`,
    month,
  )
  return {
    calls: Number(row?.calls ?? 0),
    freeCalls: Number(row?.free_calls ?? 0),
    revenue: Number(row?.revenue ?? 0),
    upstreamCost: Number(row?.upstream_cost ?? 0),
  }
}

export function toolOverviewByChannel(
  db: HubDb,
  month: string,
): {
  channelId: number
  name: string
  kind: 'deepseek' | 'tavily'
  calls: number
  failures: number
  upstreamCostMicro: number
}[] {
  return db
    .all<{
      channel_id: number
      name: string | null
      kind: 'deepseek' | 'tavily' | null
      calls: number
      failures: number
      upstream_cost: number | null
    }>(
      `SELECT u.channel_id AS channel_id, c.name AS name, c.kind AS kind,
              SUM(CASE WHEN u.status = 'ok' THEN 1 ELSE 0 END) AS calls,
              SUM(CASE WHEN u.status = 'ok' THEN 0 ELSE 1 END) AS failures,
              SUM(COALESCE(u.upstream_cost, 0)) AS upstream_cost
         FROM relay_tool_usage u
         LEFT JOIN relay_tool_channels c ON c.id = u.channel_id
        WHERE u.month = ? AND u.channel_id IS NOT NULL
        GROUP BY u.channel_id
        ORDER BY calls DESC, u.channel_id ASC`,
      month,
    )
    .map((row) => ({
      channelId: row.channel_id,
      name: row.name ?? `#${String(row.channel_id)}`,
      kind: row.kind ?? 'deepseek',
      calls: Number(row.calls ?? 0),
      failures: Number(row.failures ?? 0),
      upstreamCostMicro: Number(row.upstream_cost ?? 0),
    }))
}

export function toolOverviewByTool(
  db: HubDb,
  month: string,
): { tool: ToolKind; calls: number; revenueMicro: number }[] {
  return db
    .all<{ tool: ToolKind; calls: number; revenue: number | null }>(
      `SELECT tool, COUNT(*) AS calls, SUM(cost) AS revenue
         FROM relay_tool_usage WHERE month = ? AND status = 'ok'
        GROUP BY tool ORDER BY tool ASC`,
      month,
    )
    .map((row) => ({
      tool: row.tool,
      calls: Number(row.calls ?? 0),
      revenueMicro: Number(row.revenue ?? 0),
    }))
}

/**
 * 清理逐条用量（14 §4 最后一条）：只删早于保留期**且不是当月**的行，
 * 免得把「本月免费已用」的计数删掉（免费额度按 `month` 统计）。
 */
export function deleteToolUsageBefore(db: HubDb, cutoffIso: string, currentMonth: string): number {
  const result = db.run(
    'DELETE FROM relay_tool_usage WHERE created_at < ? AND month <> ?',
    cutoffIso,
    currentMonth,
  )
  return result.changes
}
