import {
  ModelApiSchema,
  RelayKeyStateSchema,
  RelayScopeSchema,
  RelayUsageSourceSchema,
  RelayUsageStatusSchema,
  RelayModelVisibilitySchema,
  ThinkingLevelSchema,
  type ModelApi,
  type ModelInfo,
  type RelayChannelKey,
  type RelayKeyKind,
  type RelayLedgerRow,
  type RelayScope,
  type RelayLedgerType,
  type RelayModel,
  type RelayPrice,
  type RelayRoute,
  type RelayUsageBucket,
  type RelayUsageRow,
  type RelayWallet,
} from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'

/**
 * relay 模块的 SQL（11 §5：只有 repo 写 SQL）。列名 snake_case ↔ DTO camelCase 的转换都在这里，
 * `*_json` 列解析失败一律回退（一行脏数据不该炸掉整个列表）。
 */

// ── 行类型 ──────────────────────────────────────────────────────────────────

export interface RelayChannelRow {
  id: number
  /** 18 §3.1：作用域（迁移 087；老库默认 dsh） */
  scope: string
  name: string
  /** 16 §2：对用户可见的渠道标识（迁移 086；老库由启动补齐） */
  slug: string | null
  base_url: string
  apis_json: string
  /** 渠道倍率（千分比，1000 = ×1.0）：费用 = 模型价格算出的费用 × 它（12 §6.2） */
  rate_permille: number
  priority: number
  weight: number
  max_concurrency: number
  timeout_ms: number
  proxy_url: string | null
  headers_json: string | null
  stream_usage: number
  enabled: number
  note: string
  fail_streak: number
  cooldown_until: string | null
  last_error: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

export interface RelayChannelKeyRow {
  id: number
  channel_id: number
  label: string
  key_enc: string
  key_hash: string
  last4: string
  state: string
  cooldown_until: string | null
  last_error: string | null
  last_error_at: string | null
  last_used_at: string | null
  created_at: string
}

export interface RelayModelRow {
  id: number
  /** 18 §3.1：作用域（迁移 087；老库默认 dsh） */
  scope: string
  name: string
  display_name: string
  enabled: number
  visibility: string
  /** 1 = 勾选下发到用户 DSH（迁移 082，12 §7.0） */
  dsh_enabled: number
  /** 下发到 DSH 时的默认思考档位（迁移 083；NULL = 不指定） */
  default_thinking: string | null
  price_input: number
  price_output: number
  price_cache_read: number | null
  price_cache_write: number | null
  price_request: number
  info_json: string
  compat_json: string | null
  sort: number
  created_at: string
  updated_at: string
}

export interface RelayRouteRow {
  id: number
  model_id: number
  channel_id: number
  upstream_model: string
  priority: number | null
  weight: number | null
  enabled: number
  /** 1 = 这条「模型 × 渠道」被选中下发到 DSH（迁移 086） */
  dsh_enabled: number
}

export interface RelayWalletRow {
  user_id: number
  balance: number
  rate_percent: number
  max_concurrency: number | null
  daily_limit: number | null
  enabled: number
  total_spent: number
  last_used_at: string | null
  /** 余额中「今日赠送」还没用掉的部分（13 §2；迁移 084） */
  daily_bonus_left: number
  /** 最近一次发放的上海日期 YYYY-MM-DD；从未发放为 NULL */
  daily_bonus_day: string | null
  created_at: string
  updated_at: string
}

export interface RelayKeyRow {
  id: number
  user_id: number
  /** 桌面设备专用密钥的归属（088）；用户自建与 system 密钥为 NULL */
  device_id: string | null
  /** 18 D5：密钥作用域（system 每人每作用域一把；user 恒 dsh） */
  scope: string
  kind: string
  name: string
  key_hash: string
  key_enc: string | null
  preview: string
  enabled: number
  last_used_at: string | null
  created_at: string
  revoked_at: string | null
}

export interface RelayLedgerDbRow {
  id: number
  user_id: number
  type: string
  amount: number
  balance_after: number
  note: string
  actor_id: number | null
  created_at: string
}

export interface RelayUsageDbRow {
  id: number
  request_id: string
  created_at: string
  user_id: number
  key_id: number | null
  /** 18 D7：用量来源（= 密钥作用域） */
  scope: string
  model: string
  /** 模型本名（迁移 086；老行回填 = model） */
  base_model: string | null
  /** 1 = 请求用 `<模型>@<slug>` 指定了渠道 */
  pinned: number
  upstream_model: string | null
  channel_id: number | null
  api: string
  stream: number
  source: string
  status: string
  http_status: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  cost: number
  /** 计费时的渠道倍率快照（千分比）；没走到渠道 = NULL（迁移 081 之前的老行也是 NULL） */
  channel_rate_permille: number | null
  /** 18 §3.3：计费时的模式整体倍率快照（千分比）；dsh = NULL */
  mode_rate_permille: number | null
  estimated: number
  attempts: number
  duration_ms: number | null
  ttft_ms: number | null
  error: string | null
}

export interface RelayUsageBucketDbRow {
  requests: number
  errors: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost: number
}

// ── JSON 列 ─────────────────────────────────────────────────────────────────

export function parseJsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** `apis_json` → ModelApi[]（非法值丢掉，不炸列表） */
export function parseApis(raw: string): ModelApi[] {
  const parsed = parseJsonColumn<unknown>(raw, [])
  if (!Array.isArray(parsed)) return []
  const out: ModelApi[] = []
  for (const item of parsed) {
    const result = ModelApiSchema.safeParse(item)
    if (result.success && !out.includes(result.data)) out.push(result.data)
  }
  return out
}

export function parseHeaders(raw: string | null): Record<string, string> | null {
  const parsed = parseJsonColumn<unknown>(raw, null)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

export function parseInfo(raw: string | null): ModelInfo {
  const parsed = parseJsonColumn<Record<string, unknown>>(raw ?? '{}', {})
  return parsed as ModelInfo
}

/** 库里的作用域列 → 契约枚举（脏数据按 dsh 处理，不让一行坏值打挂列表） */
export function parseScope(raw: string | null): RelayScope {
  const parsed = RelayScopeSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'dsh'
}

// ── 行 → DTO 片段 ───────────────────────────────────────────────────────────

export function toRelayChannelKey(row: RelayChannelKeyRow): RelayChannelKey {
  const state = RelayKeyStateSchema.safeParse(row.state)
  return {
    id: row.id,
    label: row.label,
    last4: row.last4,
    state: state.success ? state.data : 'disabled',
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }
}

export function toRelayPrice(row: RelayModelRow): RelayPrice {
  return {
    inputMicro: row.price_input,
    outputMicro: row.price_output,
    cacheReadMicro: row.price_cache_read,
    cacheWriteMicro: row.price_cache_write,
    perRequestMicro: row.price_request,
  }
}

/** 一条路由的 DTO；`channelRatePermille` 是所在渠道当前的倍率，界面用它显示「价格 × 倍率」 */
export function toRelayRoute(
  row: RelayRouteRow,
  channelName: string,
  channelRatePermille: number,
  channelSlug: string,
): RelayRoute {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName,
    channelRatePermille,
    channelSlug,
    upstreamModel: row.upstream_model,
    priority: row.priority,
    weight: row.weight,
    enabled: row.enabled === 1,
  }
}

export function toRelayModel(row: RelayModelRow, routes: RelayRoute[], apis: ModelApi[]): RelayModel {
  const visibility = RelayModelVisibilitySchema.safeParse(row.visibility)
  // 库里的 CHECK 保证取值合法；坏数据（手工改库）当作没设，不让一行脏值把列表打挂
  const defaultThinking = ThinkingLevelSchema.safeParse(row.default_thinking)
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    visibility: visibility.success ? visibility.data : 'all',
    scope: parseScope(row.scope),
    price: toRelayPrice(row),
    info: parseInfo(row.info_json),
    compat: parseJsonColumn<Record<string, unknown> | null>(row.compat_json, null),
    defaultThinking: defaultThinking.success ? defaultThinking.data : null,
    routes,
    apis,
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toRelayWallet(row: RelayWalletRow): RelayWallet {
  return {
    userId: row.user_id,
    balanceMicro: row.balance,
    ratePercent: row.rate_percent,
    maxConcurrency: row.max_concurrency,
    dailyLimitMicro: row.daily_limit,
    enabled: row.enabled === 1,
    totalSpentMicro: row.total_spent,
    lastUsedAt: row.last_used_at,
    // 13 §2.5：显示「今日赠送剩余」= min(赠送剩余, max(余额, 0))；余额为负时不能显示还有赠送
    dailyBonusLeftMicro: Math.min(Math.max(row.daily_bonus_left, 0), Math.max(row.balance, 0)),
  }
}

export function toRelayKey(row: RelayKeyRow): {
  id: number
  kind: RelayKeyKind
  name: string
  preview: string
  enabled: boolean
  lastUsedAt: string | null
  createdAt: string
  scope: RelayScope
} {
  return {
    id: row.id,
    kind: row.kind === 'system' ? 'system' : 'user',
    scope: parseScope(row.scope),
    name: row.name,
    preview: row.preview,
    enabled: row.enabled === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }
}

export interface LedgerJoinRow extends RelayLedgerDbRow {
  username: string
  actor: string | null
}

export function toRelayLedgerRow(row: LedgerJoinRow): RelayLedgerRow {
  // 迁移 084 之前只有 grant/deduct/signup；未知值（手工改库）按 signup 兜底，不让一行脏数据打挂列表
  const type: RelayLedgerType =
    row.type === 'grant' ||
    row.type === 'deduct' ||
    row.type === 'signup' ||
    row.type === 'daily' ||
    row.type === 'expire' ||
    row.type === 'compute'
      ? row.type
      : 'signup'
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    type,
    amountMicro: row.amount,
    balanceAfterMicro: row.balance_after,
    note: row.note,
    actor: row.actor,
    createdAt: row.created_at,
  }
}

export interface UsageJoinRow extends RelayUsageDbRow {
  username: string
  key_name: string | null
  channel_name: string | null
  channel_slug: string | null
}

export function toRelayUsageRow(row: UsageJoinRow, opts: { hideChannel: boolean }): RelayUsageRow {
  const api = ModelApiSchema.safeParse(row.api)
  const source = RelayUsageSourceSchema.safeParse(row.source)
  const status = RelayUsageStatusSchema.safeParse(row.status)
  return {
    id: row.id,
    requestId: row.request_id,
    createdAt: row.created_at,
    userId: row.user_id,
    username: row.username,
    keyId: row.key_id,
    keyName: row.key_name,
    model: row.model,
    channelSlug: row.channel_slug,
    pinned: row.pinned === 1,
    baseModel: row.base_model ?? row.model,
    upstreamModel: row.upstream_model,
    channelId: opts.hideChannel ? null : row.channel_id,
    channelName: opts.hideChannel ? null : row.channel_name,
    // 倍率是解释费用的必要信息，用户端也返回（不含渠道名）
    channelRatePermille: row.channel_rate_permille,
    api: api.success ? api.data : 'openai-completions',
    stream: row.stream === 1,
    source: source.success ? source.data : 'local',
    status: status.success ? status.data : 'ok',
    httpStatus: row.http_status,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    costMicro: row.cost,
    estimated: row.estimated === 1,
    attempts: row.attempts,
    durationMs: row.duration_ms,
    ttftMs: row.ttft_ms,
    error: row.error,
    scope: parseScope(row.scope),
    modeRatePermille: row.mode_rate_permille,
  }
}

export function toUsageBucket(row: RelayUsageBucketDbRow | undefined): RelayUsageBucket {
  return {
    requests: Number(row?.requests ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
    costMicro: Number(row?.cost ?? 0),
  }
}

// ── 渠道 ────────────────────────────────────────────────────────────────────

export function listChannelRows(db: HubDb, scope?: RelayScope): RelayChannelRow[] {
  if (scope === undefined) {
    return db.all<RelayChannelRow>('SELECT * FROM relay_channels ORDER BY priority DESC, id ASC')
  }
  return db.all<RelayChannelRow>(
    'SELECT * FROM relay_channels WHERE scope = ? ORDER BY priority DESC, id ASC',
    scope,
  )
}

export function getChannelRow(db: HubDb, id: number): RelayChannelRow | undefined {
  return db.get<RelayChannelRow>('SELECT * FROM relay_channels WHERE id = ?', id)
}

export function getChannelRowByName(db: HubDb, name: string): RelayChannelRow | undefined {
  return db.get<RelayChannelRow>('SELECT * FROM relay_channels WHERE name = ?', name)
}

export function getChannelRowBySlug(db: HubDb, slug: string): RelayChannelRow | undefined {
  return db.get<RelayChannelRow>('SELECT * FROM relay_channels WHERE slug = ?', slug)
}

/** 已占用的渠道标识（新建/修改时查重；老库的空标识不占位） */
export function listChannelSlugs(db: HubDb): string[] {
  return db
    .all<{ slug: string }>('SELECT slug FROM relay_channels WHERE slug IS NOT NULL ORDER BY id ASC')
    .map((row) => row.slug)
}

export interface InsertChannelInput {
  scope: RelayScope
  name: string
  /** 16 §2：标识在插入后由 service 生成/校验（`ch<id>` 需要自增 id） */
  slug: string | null
  baseUrl: string
  apis: ModelApi[]
  ratePermille: number
  priority: number
  weight: number
  maxConcurrency: number
  timeoutMs: number
  proxyUrl: string | null
  headers: Record<string, string> | null
  streamUsage: boolean
  enabled: boolean
  note: string
  at: string
}

export function insertChannelRow(db: HubDb, input: InsertChannelInput): number {
  const result = db.run(
    `INSERT INTO relay_channels (scope, name, slug, base_url, apis_json, rate_permille, priority, weight,
                                 max_concurrency, timeout_ms, proxy_url, headers_json, stream_usage, enabled, note,
                                 created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.scope,
    input.name,
    input.slug,
    input.baseUrl,
    JSON.stringify(input.apis),
    input.ratePermille,
    input.priority,
    input.weight,
    input.maxConcurrency,
    input.timeoutMs,
    input.proxyUrl,
    input.headers ? JSON.stringify(input.headers) : null,
    input.streamUsage ? 1 : 0,
    input.enabled ? 1 : 0,
    input.note,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdateChannelInput {
  name?: string
  slug?: string
  baseUrl?: string
  apis?: ModelApi[]
  ratePermille?: number
  priority?: number
  weight?: number
  maxConcurrency?: number
  timeoutMs?: number
  proxyUrl?: string | null
  headers?: Record<string, string> | null
  streamUsage?: boolean
  enabled?: boolean
  note?: string
  failStreak?: number
  cooldownUntil?: string | null
  lastError?: string | null
  lastErrorAt?: string | null
}

export function updateChannelRow(db: HubDb, id: number, patch: UpdateChannelInput, at: string): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.name !== undefined) push('name', patch.name)
  if (patch.slug !== undefined) push('slug', patch.slug)
  if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl)
  if (patch.apis !== undefined) push('apis_json', JSON.stringify(patch.apis))
  if (patch.ratePermille !== undefined) push('rate_permille', patch.ratePermille)
  if (patch.priority !== undefined) push('priority', patch.priority)
  if (patch.weight !== undefined) push('weight', patch.weight)
  if (patch.maxConcurrency !== undefined) push('max_concurrency', patch.maxConcurrency)
  if (patch.timeoutMs !== undefined) push('timeout_ms', patch.timeoutMs)
  if (patch.proxyUrl !== undefined) push('proxy_url', patch.proxyUrl)
  if (patch.headers !== undefined) push('headers_json', patch.headers ? JSON.stringify(patch.headers) : null)
  if (patch.streamUsage !== undefined) push('stream_usage', patch.streamUsage ? 1 : 0)
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
  if (patch.note !== undefined) push('note', patch.note)
  if (patch.failStreak !== undefined) push('fail_streak', patch.failStreak)
  if (patch.cooldownUntil !== undefined) push('cooldown_until', patch.cooldownUntil)
  if (patch.lastError !== undefined) push('last_error', patch.lastError)
  if (patch.lastErrorAt !== undefined) push('last_error_at', patch.lastErrorAt)
  push('updated_at', at)
  db.run(`UPDATE relay_channels SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
}

export function deleteChannelRow(db: HubDb, id: number): void {
  db.run('DELETE FROM relay_channels WHERE id = ?', id)
}

/** 引用该渠道的对外模型名（删除前的 CONFLICT 明细） */
export function listChannelModelNames(db: HubDb, channelId: number): string[] {
  return db
    .all<{ name: string }>(
      `SELECT DISTINCT m.name AS name FROM relay_routes r
       JOIN relay_models m ON m.id = r.model_id
       WHERE r.channel_id = ? ORDER BY m.name ASC`,
      channelId,
    )
    .map((row) => row.name)
}

export function countModelsByChannel(db: HubDb): Map<number, number> {
  const out = new Map<number, number>()
  for (const row of db.all<{ channel_id: number; n: number }>(
    `SELECT channel_id, COUNT(DISTINCT model_id) AS n FROM relay_routes GROUP BY channel_id`,
  )) {
    out.set(row.channel_id, Number(row.n))
  }
  return out
}

// ── 渠道密钥 ────────────────────────────────────────────────────────────────

export function listChannelKeyRows(db: HubDb, channelId: number): RelayChannelKeyRow[] {
  return db.all<RelayChannelKeyRow>(
    'SELECT * FROM relay_channel_keys WHERE channel_id = ? ORDER BY id ASC',
    channelId,
  )
}

export function listChannelKeyRowsByChannels(db: HubDb, channelIds: number[]): RelayChannelKeyRow[] {
  if (channelIds.length === 0) return []
  const placeholders = channelIds.map(() => '?').join(', ')
  return db.all<RelayChannelKeyRow>(
    `SELECT * FROM relay_channel_keys WHERE channel_id IN (${placeholders}) ORDER BY id ASC`,
    ...channelIds,
  )
}

export function getChannelKeyRow(db: HubDb, id: number): RelayChannelKeyRow | undefined {
  return db.get<RelayChannelKeyRow>('SELECT * FROM relay_channel_keys WHERE id = ?', id)
}

export function findChannelKeyRowByHash(
  db: HubDb,
  channelId: number,
  keyHash: string,
): RelayChannelKeyRow | undefined {
  return db.get<RelayChannelKeyRow>(
    'SELECT * FROM relay_channel_keys WHERE channel_id = ? AND key_hash = ?',
    channelId,
    keyHash,
  )
}

export interface InsertChannelKeyInput {
  channelId: number
  label: string
  keyEnc: string
  keyHash: string
  last4: string
  at: string
}

export function insertChannelKeyRow(db: HubDb, input: InsertChannelKeyInput): number {
  const result = db.run(
    `INSERT INTO relay_channel_keys (channel_id, label, key_enc, key_hash, last4, state, created_at)
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

export interface UpdateChannelKeyInput {
  label?: string
  state?: string
  cooldownUntil?: string | null
  lastError?: string | null
  lastErrorAt?: string | null
  lastUsedAt?: string | null
}

export function updateChannelKeyRow(db: HubDb, id: number, patch: UpdateChannelKeyInput): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.label !== undefined) push('label', patch.label)
  if (patch.state !== undefined) push('state', patch.state)
  if (patch.cooldownUntil !== undefined) push('cooldown_until', patch.cooldownUntil)
  if (patch.lastError !== undefined) push('last_error', patch.lastError)
  if (patch.lastErrorAt !== undefined) push('last_error_at', patch.lastErrorAt)
  if (patch.lastUsedAt !== undefined) push('last_used_at', patch.lastUsedAt)
  if (sets.length === 0) return
  db.run(`UPDATE relay_channel_keys SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
}

export function deleteChannelKeyRow(db: HubDb, id: number): void {
  db.run('DELETE FROM relay_channel_keys WHERE id = ?', id)
}

/** 到期冷却的密钥恢复 active（惰性，不靠定时器；12 §8「冷却到期自然失效」） */
export function clearExpiredKeyCooldowns(db: HubDb, nowIso: string): void {
  db.run(
    `UPDATE relay_channel_keys SET cooldown_until = NULL
     WHERE cooldown_until IS NOT NULL AND cooldown_until <= ? AND state = 'active'`,
    nowIso,
  )
}

// ── 对外模型与路由 ──────────────────────────────────────────────────────────

export function listModelRows(db: HubDb, scope?: RelayScope): RelayModelRow[] {
  if (scope === undefined) {
    return db.all<RelayModelRow>('SELECT * FROM relay_models ORDER BY sort DESC, id ASC')
  }
  return db.all<RelayModelRow>('SELECT * FROM relay_models WHERE scope = ? ORDER BY sort DESC, id ASC', scope)
}

export function getModelRow(db: HubDb, id: number): RelayModelRow | undefined {
  return db.get<RelayModelRow>('SELECT * FROM relay_models WHERE id = ?', id)
}

export function getModelRowByName(db: HubDb, name: string): RelayModelRow | undefined {
  return db.get<RelayModelRow>('SELECT * FROM relay_models WHERE name = ?', name)
}

export interface InsertModelInput {
  scope: RelayScope
  name: string
  displayName: string
  enabled: boolean
  visibility: string
  priceInput: number
  priceOutput: number
  priceCacheRead: number | null
  priceCacheWrite: number | null
  priceRequest: number
  info: ModelInfo
  compat: Record<string, unknown> | null
  /** 默认思考档位；省略 = NULL（导入新建的模型一律 NULL，12 §7.0） */
  defaultThinking?: string | null
  sort: number
  at: string
}

export function insertModelRow(db: HubDb, input: InsertModelInput): number {
  const result = db.run(
    `INSERT INTO relay_models (scope, name, display_name, enabled, visibility, price_input, price_output,
                               price_cache_read, price_cache_write, price_request, info_json, compat_json,
                               default_thinking, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.scope,
    input.name,
    input.displayName,
    input.enabled ? 1 : 0,
    input.visibility,
    input.priceInput,
    input.priceOutput,
    input.priceCacheRead,
    input.priceCacheWrite,
    input.priceRequest,
    JSON.stringify(input.info),
    input.compat ? JSON.stringify(input.compat) : null,
    input.defaultThinking ?? null,
    input.sort,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdateModelInput {
  name?: string
  displayName?: string
  enabled?: boolean
  visibility?: string
  priceInput?: number
  priceOutput?: number
  priceCacheRead?: number | null
  priceCacheWrite?: number | null
  priceRequest?: number
  info?: ModelInfo
  compat?: Record<string, unknown> | null
  /** `null` = 清除（与「省略 = 不改」区分开） */
  defaultThinking?: string | null
  sort?: number
}

export function updateModelRow(db: HubDb, id: number, patch: UpdateModelInput, at: string): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.name !== undefined) push('name', patch.name)
  if (patch.displayName !== undefined) push('display_name', patch.displayName)
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
  if (patch.visibility !== undefined) push('visibility', patch.visibility)
  if (patch.priceInput !== undefined) push('price_input', patch.priceInput)
  if (patch.priceOutput !== undefined) push('price_output', patch.priceOutput)
  if (patch.priceCacheRead !== undefined) push('price_cache_read', patch.priceCacheRead)
  if (patch.priceCacheWrite !== undefined) push('price_cache_write', patch.priceCacheWrite)
  if (patch.priceRequest !== undefined) push('price_request', patch.priceRequest)
  if (patch.info !== undefined) push('info_json', JSON.stringify(patch.info))
  if (patch.compat !== undefined) push('compat_json', patch.compat ? JSON.stringify(patch.compat) : null)
  if (patch.defaultThinking !== undefined) push('default_thinking', patch.defaultThinking)
  if (patch.sort !== undefined) push('sort', patch.sort)
  push('updated_at', at)
  db.run(`UPDATE relay_models SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
}

export function deleteModelRow(db: HubDb, id: number): void {
  db.run('DELETE FROM relay_models WHERE id = ?', id)
}

export function listRouteRows(db: HubDb, modelId: number): RelayRouteRow[] {
  return db.all<RelayRouteRow>('SELECT * FROM relay_routes WHERE model_id = ? ORDER BY id ASC', modelId)
}

export function listRouteRowsForModels(db: HubDb, modelIds: number[]): RelayRouteRow[] {
  if (modelIds.length === 0) return []
  const placeholders = modelIds.map(() => '?').join(', ')
  return db.all<RelayRouteRow>(
    `SELECT * FROM relay_routes WHERE model_id IN (${placeholders}) ORDER BY id ASC`,
    ...modelIds,
  )
}

export function listRouteRowsForChannel(db: HubDb, channelId: number): RelayRouteRow[] {
  return db.all<RelayRouteRow>('SELECT * FROM relay_routes WHERE channel_id = ? ORDER BY id ASC', channelId)
}

export interface InsertRouteInput {
  modelId: number
  channelId: number
  upstreamModel: string
  priority: number | null
  weight: number | null
  enabled: boolean
  /** 省略 = 0（新路由默认不下发；迁移 086 的回填单独处理老配置） */
  dshEnabled?: boolean
}

export function insertRouteRow(db: HubDb, input: InsertRouteInput): number {
  const result = db.run(
    `INSERT INTO relay_routes (model_id, channel_id, upstream_model, priority, weight, enabled, dsh_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.modelId,
    input.channelId,
    input.upstreamModel,
    input.priority,
    input.weight,
    input.enabled ? 1 : 0,
    input.dshEnabled === true ? 1 : 0,
  )
  return result.lastInsertRowid
}

export function getRouteRow(db: HubDb, id: number): RelayRouteRow | undefined {
  return db.get<RelayRouteRow>('SELECT * FROM relay_routes WHERE id = ?', id)
}

export interface UpdateRouteInput {
  upstreamModel?: string
  priority?: number | null
  weight?: number | null
  enabled?: boolean
  dshEnabled?: boolean
}

export function updateRouteRow(db: HubDb, id: number, patch: UpdateRouteInput): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.upstreamModel !== undefined) push('upstream_model', patch.upstreamModel)
  if (patch.priority !== undefined) push('priority', patch.priority)
  if (patch.weight !== undefined) push('weight', patch.weight)
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
  if (patch.dshEnabled !== undefined) push('dsh_enabled', patch.dshEnabled ? 1 : 0)
  if (sets.length === 0) return
  db.run(`UPDATE relay_routes SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
}

export function deleteRouteRow(db: HubDb, id: number): void {
  db.run('DELETE FROM relay_routes WHERE id = ?', id)
}

export function deleteRoutesForModel(db: HubDb, modelId: number): void {
  db.run('DELETE FROM relay_routes WHERE model_id = ?', modelId)
}

export function countRouteRows(db: HubDb): number {
  const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relay_routes')
  return Number(row?.n ?? 0)
}

export function countModelRows(db: HubDb, scope: RelayScope = 'dsh'): { total: number; enabled: number } {
  const row = db.get<{ total: number; enabled: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
       FROM relay_models WHERE scope = ?`,
    scope,
  )
  return { total: Number(row?.total ?? 0), enabled: Number(row?.enabled ?? 0) }
}

/**
 * 已启用、但价格全为 0 的对外模型（概览告警 `models-unpriced`，12 §9）；缓存价 null 也算 0。
 * 18 §3.1：三个作用域都算，告警文案按作用域带上页面名。
 */
export function listUnpricedModelRows(db: HubDb): { name: string; scope: RelayScope }[] {
  return db
    .all<{ name: string; scope: string }>(
      `SELECT name, scope FROM relay_models
        WHERE enabled = 1
          AND price_input = 0 AND price_output = 0 AND price_request = 0
          AND COALESCE(price_cache_read, 0) = 0 AND COALESCE(price_cache_write, 0) = 0
        ORDER BY scope ASC, name ASC`,
    )
    .map((row) => ({ name: row.name, scope: parseScope(row.scope) }))
}

/**
 * 每个模型「启用路由所在启用渠道」的倍率区间（12 §9 的 `MyRelayModel.channelRate`）。
 * 没有可用路由的模型不在返回的 Map 里（DTO 映射成 null）。
 */
export function channelRateRanges(
  db: HubDb,
  modelIds: number[],
): Map<number, { minPermille: number; maxPermille: number }> {
  const out = new Map<number, { minPermille: number; maxPermille: number }>()
  if (modelIds.length === 0) return out
  const placeholders = modelIds.map(() => '?').join(', ')
  const rows = db.all<{ model_id: number; min_rate: number; max_rate: number }>(
    `SELECT r.model_id AS model_id, MIN(c.rate_permille) AS min_rate, MAX(c.rate_permille) AS max_rate
       FROM relay_routes r JOIN relay_channels c ON c.id = r.channel_id
      WHERE r.model_id IN (${placeholders}) AND r.enabled = 1 AND c.enabled = 1
      GROUP BY r.model_id`,
    ...modelIds,
  )
  for (const row of rows) {
    out.set(row.model_id, { minPermille: Number(row.min_rate), maxPermille: Number(row.max_rate) })
  }
  return out
}

// ── 下发到 DSH（WP12a，12 §7.0）────────────────────────────────────────────

/**
 * 整体替换选中集合：`ids` 里的置 1，其余置 0（PUT 的语义，不碰 models 的其它字段）。
 * 不改 `updated_at`：勾选不是模型内容变更，配置的变更时间记在 `settings.relay_dsh.updatedAt`。
 */
export function updateDshEnabledRows(db: HubDb, ids: number[]): void {
  if (ids.length === 0) {
    db.run('UPDATE relay_models SET dsh_enabled = 0 WHERE dsh_enabled <> 0')
    return
  }
  const placeholders = ids.map(() => '?').join(', ')
  db.run(
    `UPDATE relay_models SET dsh_enabled = CASE WHEN id IN (${placeholders}) THEN 1 ELSE 0 END
      WHERE dsh_enabled <> CASE WHEN id IN (${placeholders}) THEN 1 ELSE 0 END`,
    ...ids,
    ...ids,
  )
}

/** 整体替换选中路由（16 §6.1）；`relay_models.dsh_enabled` 随后由 `syncModelDshEnabledFlags` 维护 */
export function updateRouteDshEnabledRows(db: HubDb, ids: number[]): void {
  if (ids.length === 0) {
    db.run('UPDATE relay_routes SET dsh_enabled = 0 WHERE dsh_enabled <> 0')
    return
  }
  const placeholders = ids.map(() => '?').join(', ')
  db.run(
    `UPDATE relay_routes SET dsh_enabled = CASE WHEN id IN (${placeholders}) THEN 1 ELSE 0 END
      WHERE dsh_enabled <> CASE WHEN id IN (${placeholders}) THEN 1 ELSE 0 END`,
    ...ids,
    ...ids,
  )
}

/** `relay_models.dsh_enabled` = 这个模型是否有任意一条被选中的路由（16 §6.1） */
export function syncModelDshEnabledFlags(db: HubDb): void {
  db.run(
    `UPDATE relay_models
        SET dsh_enabled = CASE
          WHEN EXISTS (SELECT 1 FROM relay_routes r WHERE r.model_id = relay_models.id AND r.dsh_enabled = 1)
          THEN 1 ELSE 0 END
      WHERE scope = 'dsh' AND dsh_enabled <> CASE
          WHEN EXISTS (SELECT 1 FROM relay_routes r WHERE r.model_id = relay_models.id AND r.dsh_enabled = 1)
          THEN 1 ELSE 0 END`,
  )
}

/** 所有路由（跨模型；下发页与渲染都要全量视图） */
export function listAllRouteRows(db: HubDb): RelayRouteRow[] {
  return db.all<RelayRouteRow>('SELECT * FROM relay_routes ORDER BY model_id ASC, id ASC')
}

/**
 * 每个模型的「可用路由」所在渠道名（启用路由 + 启用渠道），按渠道名排序去重。
 * 与 `modelApis()` 的口径一致：这就是「有可用渠道」的判定来源。
 */
export function channelNamesForModels(db: HubDb, modelIds: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (modelIds.length === 0) return out
  const placeholders = modelIds.map(() => '?').join(', ')
  const rows = db.all<{ model_id: number; name: string }>(
    `SELECT DISTINCT r.model_id AS model_id, c.name AS name
       FROM relay_routes r JOIN relay_channels c ON c.id = r.channel_id
      WHERE r.model_id IN (${placeholders}) AND r.enabled = 1 AND c.enabled = 1
      ORDER BY c.name ASC`,
    ...modelIds,
  )
  for (const row of rows) {
    const list = out.get(row.model_id)
    if (list) list.push(row.name)
    else out.set(row.model_id, [row.name])
  }
  return out
}

/** 会收到下发的用户数：未删除、模型策略为「统一管理」 */
export function countManagedUsers(db: HubDb): number {
  return Number(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND model_policy = 'managed'",
    )?.n ?? 0,
  )
}

/** 上述用户里正在运行的实例数（`instances.status = 'running'`） */
export function countManagedRunningInstances(db: HubDb): number {
  return Number(
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM instances i JOIN users u ON u.id = i.user_id
        WHERE u.deleted_at IS NULL AND u.model_policy = 'managed' AND i.status = 'running'`,
    )?.n ?? 0,
  )
}

// ── 钱包 ────────────────────────────────────────────────────────────────────

export function getWalletRow(db: HubDb, userId: number): RelayWalletRow | undefined {
  return db.get<RelayWalletRow>('SELECT * FROM relay_wallets WHERE user_id = ?', userId)
}

/** 发每日赠送前的账号状态判定（13 §2.3：待审批 / 停用 / 已删除不发） */
export function getUserStatusRow(
  db: HubDb,
  userId: number,
): { status: string; deleted_at: string | null } | undefined {
  return db.get<{ status: string; deleted_at: string | null }>(
    'SELECT status, deleted_at FROM users WHERE id = ?',
    userId,
  )
}

/** 懒创建：第一次要写时才建行（12 §6.4）；已存在则原样返回 */
export function ensureWalletRow(db: HubDb, userId: number, at: string): RelayWalletRow {
  db.run(
    `INSERT INTO relay_wallets (user_id, balance, rate_percent, max_concurrency, daily_limit, enabled,
                                total_spent, created_at, updated_at)
     VALUES (?, 0, 100, NULL, NULL, 1, 0, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
    userId,
    at,
    at,
  )
  const row = getWalletRow(db, userId)
  if (!row) throw new Error(`relay_wallets 行创建失败：user ${String(userId)}`)
  return row
}

export interface UpdateWalletInput {
  balance?: number
  ratePercent?: number
  maxConcurrency?: number | null
  dailyLimit?: number | null
  enabled?: boolean
  totalSpent?: number
  lastUsedAt?: string | null
  /** 余额中「今日赠送」剩余（13 §2；调用方负责算好扣减后的值） */
  dailyBonusLeft?: number
  /** 最近一次发放日期（`null` = 清空，例如测试/手工修复） */
  dailyBonusDay?: string | null
}

export function updateWalletRow(db: HubDb, userId: number, patch: UpdateWalletInput, at: string): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.balance !== undefined) push('balance', patch.balance)
  if (patch.ratePercent !== undefined) push('rate_percent', patch.ratePercent)
  if (patch.maxConcurrency !== undefined) push('max_concurrency', patch.maxConcurrency)
  if (patch.dailyLimit !== undefined) push('daily_limit', patch.dailyLimit)
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
  if (patch.totalSpent !== undefined) push('total_spent', patch.totalSpent)
  if (patch.lastUsedAt !== undefined) push('last_used_at', patch.lastUsedAt)
  if (patch.dailyBonusLeft !== undefined) push('daily_bonus_left', patch.dailyBonusLeft)
  if (patch.dailyBonusDay !== undefined) push('daily_bonus_day', patch.dailyBonusDay)
  push('updated_at', at)
  db.run(`UPDATE relay_wallets SET ${sets.join(', ')} WHERE user_id = ?`, ...params, userId)
}

export interface WalletListJoinRow extends RelayWalletRow {
  username: string
  display_name: string
  avatar_file: string | null
  deleted_at: string | null
  /** 今日 / 本月消耗与本月请求数（子查询聚合，仅供 DTO 组装） */
  today_cost: number
  month_cost: number
  month_requests: number
}

/**
 * 管理端钱包列表：`users` LEFT JOIN `relay_wallets`（没建钱包的用户也要出现），
 * 排除已删除用户；今日/本月消耗从日汇总取。
 */
export function listWalletRows(
  db: HubDb,
  opts: { q?: string; sort: string; limit: number; offset: number; today: string; monthStart: string },
): { rows: WalletListJoinRow[]; total: number } {
  const where: string[] = ['u.deleted_at IS NULL']
  const params: SqlParam[] = []
  if (opts.q) {
    where.push('(u.username LIKE ? OR u.display_name LIKE ?)')
    const like = `%${opts.q}%`
    params.push(like, like)
  }
  const whereSql = `WHERE ${where.join(' AND ')}`
  const total = Number(
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, ...params)?.n ?? 0,
  )
  const orderSql =
    opts.sort === 'balance'
      ? 'COALESCE(w.balance, 0) DESC, u.id ASC'
      : opts.sort === 'monthCost'
        ? 'month_cost DESC, u.id ASC'
        : opts.sort === 'username'
          ? 'u.username ASC'
          : 'COALESCE(w.last_used_at, u.created_at) DESC, u.id ASC'
  const rows = db.all<WalletListJoinRow>(
    `SELECT COALESCE(w.user_id, u.id) AS user_id,
            COALESCE(w.balance, 0) AS balance,
            COALESCE(w.rate_percent, 100) AS rate_percent,
            w.max_concurrency AS max_concurrency,
            w.daily_limit AS daily_limit,
            COALESCE(w.enabled, 1) AS enabled,
            COALESCE(w.total_spent, 0) AS total_spent,
            w.last_used_at AS last_used_at,
            COALESCE(w.daily_bonus_left, 0) AS daily_bonus_left,
            w.daily_bonus_day AS daily_bonus_day,
            COALESCE(w.created_at, u.created_at) AS created_at,
            COALESCE(w.updated_at, u.updated_at) AS updated_at,
            u.username AS username, u.display_name AS display_name, u.avatar_file AS avatar_file,
            u.deleted_at AS deleted_at,
            COALESCE((SELECT SUM(cost) FROM relay_usage_daily d WHERE d.user_id = u.id AND d.day = ?), 0) AS today_cost,
            COALESCE((SELECT SUM(cost) FROM relay_usage_daily d WHERE d.user_id = u.id AND d.day >= ?), 0) AS month_cost,
            COALESCE((SELECT SUM(requests) FROM relay_usage_daily d WHERE d.user_id = u.id AND d.day >= ?), 0) AS month_requests
     FROM users u LEFT JOIN relay_wallets w ON w.user_id = u.id
     ${whereSql}
     ORDER BY ${orderSql}
     LIMIT ? OFFSET ?`,
    opts.today,
    opts.monthStart,
    opts.monthStart,
    ...params,
    opts.limit,
    opts.offset,
  )
  return { rows, total }
}

export function sumWalletBalances(db: HubDb): number {
  return Number(
    db.get<{ total: number | null }>('SELECT SUM(balance) AS total FROM relay_wallets')?.total ?? 0,
  )
}

// ── 用户密钥 ────────────────────────────────────────────────────────────────

export function listKeyRows(db: HubDb, userId: number, scope?: RelayScope): RelayKeyRow[] {
  if (scope === undefined) {
    return db.all<RelayKeyRow>(
      'SELECT * FROM relay_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY kind DESC, id ASC',
      userId,
    )
  }
  return db.all<RelayKeyRow>(
    `SELECT * FROM relay_keys WHERE user_id = ? AND scope = ? AND revoked_at IS NULL
      ORDER BY kind DESC, id ASC`,
    userId,
    scope,
  )
}

export function getKeyRow(db: HubDb, id: number): RelayKeyRow | undefined {
  return db.get<RelayKeyRow>('SELECT * FROM relay_keys WHERE id = ?', id)
}

export function getActiveSystemKeyRow(
  db: HubDb,
  userId: number,
  scope: RelayScope = 'dsh',
): RelayKeyRow | undefined {
  return db.get<RelayKeyRow>(
    `SELECT * FROM relay_keys WHERE user_id = ? AND kind = 'system' AND scope = ? AND revoked_at IS NULL`,
    userId,
    scope,
  )
}

export interface AuthKeyJoinRow extends RelayKeyRow {
  user_status: string
  user_role: string
  /** `users.is_system`（WP56e1）：系统账号的请求不扣积分、来源记 cockpit */
  user_is_system: number | null
}

/** 鉴权用：按 sha256 找未作废的密钥，并带上用户状态（一次性判定） */
export function findKeyRowByHash(db: HubDb, keyHash: string): AuthKeyJoinRow | undefined {
  return db.get<AuthKeyJoinRow>(
    `SELECT k.*, u.status AS user_status, u.role AS user_role, u.is_system AS user_is_system
     FROM relay_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND u.deleted_at IS NULL`,
    keyHash,
  )
}

export function countUserKeyRows(db: HubDb, userId: number, kind?: RelayKeyKind): number {
  const row =
    kind === undefined
      ? db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM relay_keys WHERE user_id = ? AND revoked_at IS NULL',
          userId,
        )
      : db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM relay_keys WHERE user_id = ? AND kind = ? AND revoked_at IS NULL',
          userId,
          kind,
        )
  return Number(row?.n ?? 0)
}

export interface InsertKeyInput {
  userId: number
  /** 18 D5：作用域；用户自建密钥恒 dsh（设备密钥与模式密钥除外） */
  scope: RelayScope
  kind: RelayKeyKind
  name: string
  keyHash: string
  keyEnc: string | null
  preview: string
  at: string
  /** WP25a：桌面设备专用密钥记设备 id（吊销设备时按它一次吊销）；其它为 null */
  deviceId?: string | null
}

export function insertKeyRow(db: HubDb, input: InsertKeyInput): number {
  const result = db.run(
    `INSERT INTO relay_keys (user_id, scope, kind, name, key_hash, key_enc, preview, enabled,
                             device_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    input.userId,
    input.scope,
    input.kind,
    input.name,
    input.keyHash,
    input.keyEnc,
    input.preview,
    input.deviceId ?? null,
    input.at,
  )
  return result.lastInsertRowid
}

export function updateKeyRow(db: HubDb, id: number, patch: { name?: string; enabled?: boolean }): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name)
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    params.push(patch.enabled ? 1 : 0)
  }
  if (sets.length === 0) return
  db.run(`UPDATE relay_keys SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
}

/** 软删：用量记录还引用它（12 §8） */
/** 用户**自建**密钥的数量（不含桌面设备密钥：设备密钥有自己的设备维度与吊销路径，不占 10 把配额） */
export function countUserCreatedKeyRows(db: HubDb, userId: number): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM relay_keys
      WHERE user_id = ? AND kind = 'user' AND device_id IS NULL AND revoked_at IS NULL`,
    userId,
  )
  return Number(row?.n ?? 0)
}

/** 一台设备在某作用域里的有效密钥（吊销设备 / 复用模式密钥时用） */
export function listDeviceKeyRows(db: HubDb, deviceId: string, scope?: RelayScope): RelayKeyRow[] {
  if (scope === undefined) {
    return db.all<RelayKeyRow>(
      `SELECT * FROM relay_keys WHERE device_id = ? AND revoked_at IS NULL ORDER BY id ASC`,
      deviceId,
    )
  }
  return db.all<RelayKeyRow>(
    `SELECT * FROM relay_keys WHERE device_id = ? AND scope = ? AND revoked_at IS NULL ORDER BY id ASC`,
    deviceId,
    scope,
  )
}

/** 吊销一台设备的全部密钥（中转站 + 两个模式），返回条数 */
export function revokeKeysByDevice(db: HubDb, deviceId: string, at: string): number {
  return db.run(
    `UPDATE relay_keys SET revoked_at = ?, enabled = 0
      WHERE device_id = ? AND revoked_at IS NULL`,
    at,
    deviceId,
  ).changes
}

export function revokeKeyRow(db: HubDb, id: number, at: string): void {
  db.run('UPDATE relay_keys SET revoked_at = ?, enabled = 0 WHERE id = ?', at, id)
}

export function touchKeyLastUsed(db: HubDb, id: number, at: string): void {
  db.run('UPDATE relay_keys SET last_used_at = ? WHERE id = ?', at, id)
}

// ── 流水 ────────────────────────────────────────────────────────────────────

export interface InsertLedgerInput {
  userId: number
  type: RelayLedgerType
  amount: number
  balanceAfter: number
  note: string
  actorId: number | null
  at: string
}

export function insertLedgerRow(db: HubDb, input: InsertLedgerInput): number {
  const result = db.run(
    `INSERT INTO relay_ledger (user_id, type, amount, balance_after, note, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.userId,
    input.type,
    input.amount,
    input.balanceAfter,
    input.note,
    input.actorId,
    input.at,
  )
  return result.lastInsertRowid
}

export function listLedgerRows(
  db: HubDb,
  opts: { userId?: number; limit: number; offset: number },
): { rows: LedgerJoinRow[]; total: number } {
  const where = opts.userId === undefined ? '' : 'WHERE l.user_id = ?'
  const params: SqlParam[] = opts.userId === undefined ? [] : [opts.userId]
  const total = Number(
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_ledger l ${where}`, ...params)?.n ?? 0,
  )
  const rows = db.all<LedgerJoinRow>(
    `SELECT l.*, u.username AS username, a.username AS actor
     FROM relay_ledger l
     JOIN users u ON u.id = l.user_id
     LEFT JOIN users a ON a.id = l.actor_id
     ${where}
     ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...params,
    opts.limit,
    opts.offset,
  )
  return { rows, total }
}

// ── 用量 ────────────────────────────────────────────────────────────────────

export interface InsertUsageInput {
  requestId: string
  createdAt: string
  userId: number
  keyId: number | null
  /** 18 D7：用量来源（= 密钥作用域） */
  scope: RelayScope
  model: string
  baseModel: string
  pinned: boolean
  upstreamModel: string | null
  channelId: number | null
  api: ModelApi
  stream: boolean
  source: string
  status: string
  httpStatus: number | null
  /** 来源（= 凭据种类，088）：docker | desktop | external | unknown */
  clientKind: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  cost: number
  /** 计费用的渠道倍率快照（千分比）；没走到渠道传 null */
  channelRatePermille: number | null
  /** 18 §3.3：计费用的模式整体倍率快照（千分比）；dsh 传 null */
  modeRatePermille: number | null
  estimated: boolean
  attempts: number
  durationMs: number | null
  ttftMs: number | null
  error: string | null
}

export function insertUsageRow(db: HubDb, input: InsertUsageInput): number {
  const result = db.run(
    `INSERT INTO relay_usage (request_id, created_at, user_id, key_id, scope, model, base_model, pinned,
                              upstream_model, channel_id, api, stream, source, status, http_status,
                              client_kind, input_tokens, output_tokens, cache_read_tokens,
                              cache_write_tokens, reasoning_tokens, cost, channel_rate_permille,
                              mode_rate_permille, estimated, attempts, duration_ms, ttft_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.requestId,
    input.createdAt,
    input.userId,
    input.keyId,
    input.scope,
    input.model,
    input.baseModel,
    input.pinned ? 1 : 0,
    input.upstreamModel,
    input.channelId,
    input.api,
    input.stream ? 1 : 0,
    input.source,
    input.status,
    input.httpStatus,
    input.clientKind,
    input.inputTokens,
    input.outputTokens,
    input.cacheReadTokens,
    input.cacheWriteTokens,
    input.reasoningTokens,
    input.cost,
    input.channelRatePermille,
    input.modeRatePermille,
    input.estimated ? 1 : 0,
    input.attempts,
    input.durationMs,
    input.ttftMs,
    input.error,
  )
  return result.lastInsertRowid
}

export interface DailyDelta {
  day: string
  userId: number
  /** 18 §3.3：来源（= 密钥作用域） */
  scope: RelayScope
  model: string
  channelId: number
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export function upsertUsageDaily(db: HubDb, delta: DailyDelta): void {
  db.run(
    `INSERT INTO relay_usage_daily (day, user_id, scope, model, channel_id, requests, errors,
                                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, user_id, model, channel_id) DO UPDATE SET
       requests = requests + excluded.requests,
       errors = errors + excluded.errors,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       cost = cost + excluded.cost`,
    delta.day,
    delta.userId,
    delta.scope,
    delta.model,
    delta.channelId,
    delta.requests,
    delta.errors,
    delta.inputTokens,
    delta.outputTokens,
    delta.cacheReadTokens,
    delta.cacheWriteTokens,
    delta.cost,
  )
}

export interface UsageJoinOptions {
  userId?: number
  /** 18 §6：按来源筛选 */
  scope?: RelayScope
  /** docs/22 §1.3：按用量来源筛选（`relay_usage.client_kind`） */
  clientKind?: string
  /** WP56e1：按 `relay_usage.source` 筛选（internal / local / public / cockpit） */
  source?: string
  model?: string
  /** 16 §5：按模型本名筛选（管理端用量记录） */
  baseModel?: string
  channelId?: number
  status?: string
  /** ISO 时间下界（含） */
  fromIso?: string
  /** ISO 时间上界（不含） */
  toIso?: string
}

function usageWhere(opts: UsageJoinOptions): { sql: string; params: SqlParam[] } {
  const where: string[] = []
  const params: SqlParam[] = []
  if (opts.userId !== undefined) {
    where.push('v.user_id = ?')
    params.push(opts.userId)
  }
  if (opts.scope !== undefined) {
    where.push('v.scope = ?')
    params.push(opts.scope)
  }
  if (opts.clientKind !== undefined) {
    where.push('v.client_kind = ?')
    params.push(opts.clientKind)
  }
  if (opts.source !== undefined) {
    where.push('v.source = ?')
    params.push(opts.source)
  }
  if (opts.model) {
    where.push('v.model = ?')
    params.push(opts.model)
  }
  if (opts.baseModel) {
    where.push('v.base_model = ?')
    params.push(opts.baseModel)
  }
  if (opts.channelId !== undefined) {
    where.push('v.channel_id = ?')
    params.push(opts.channelId)
  }
  if (opts.status) {
    where.push('v.status = ?')
    params.push(opts.status)
  }
  if (opts.fromIso) {
    where.push('v.created_at >= ?')
    params.push(opts.fromIso)
  }
  if (opts.toIso) {
    where.push('v.created_at < ?')
    params.push(opts.toIso)
  }
  return { sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params }
}

export function listUsageRows(
  db: HubDb,
  opts: UsageJoinOptions & { limit: number; offset: number },
): { rows: UsageJoinRow[]; total: number } {
  const { sql, params } = usageWhere(opts)
  const total = Number(
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_usage v ${sql}`, ...params)?.n ?? 0,
  )
  const rows = db.all<UsageJoinRow>(
    `SELECT v.*, u.username AS username, k.name AS key_name, c.name AS channel_name,
            c.slug AS channel_slug
     FROM relay_usage v
     JOIN users u ON u.id = v.user_id
     LEFT JOIN relay_keys k ON k.id = v.key_id
     LEFT JOIN relay_channels c ON c.id = v.channel_id
     ${sql}
     ORDER BY v.id DESC LIMIT ? OFFSET ?`,
    ...params,
    opts.limit,
    opts.offset,
  )
  return { rows, total }
}

export interface DailyBucketOptions {
  userId?: number
  /** 18 §6：按来源筛选 */
  scope?: RelayScope
  /** docs/22 §1.3：按用量来源筛选（`relay_usage.client_kind`） */
  clientKind?: string
  /** WP56e1：按 `relay_usage.source` 筛选；`relay_usage_daily` 没有这一列，所以会回落到明细表 */
  source?: string
  /** 只看某模型（用户端「按模型」表用不到，管理端筛选用） */
  model?: string
  channelId?: number
}

/**
 * 统计的「日行」数据源。`relay_usage_daily` **没有** `client_kind`（迁移 088 有意不加，来源维度靠 join 明细），
 * 所以按来源筛选时回落到明细表：一行 = 一次请求，`errors` 按 status。
 * 日界按 Asia/Shanghai（与 `shanghaiDay` 同一偏移），`date(created_at, '+8 hours')` 就是那个日子。
 */
const RAW_DAILY_SELECT = `SELECT date(created_at, '+8 hours') AS day, user_id, model,
         COALESCE(channel_id, 0) AS channel_id, scope, source,
         1 AS requests, CASE WHEN status = 'ok' THEN 0 ELSE 1 END AS errors,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost
    FROM relay_usage`

/**
 * 统计用哪张表：默认 `relay_usage_daily`（已按天聚合）；一旦按 `client_kind` 或 `source` 筛，
 * 就得回落到明细表（`relay_usage_daily` 这两列都没有，WP56e1 只给 source 加过滤、不加聚合列）。
 */
function dailySource(opts: DailyBucketOptions): { sql: string; params: SqlParam[] } {
  const where: string[] = []
  const params: SqlParam[] = []
  if (opts.clientKind !== undefined) {
    where.push('client_kind = ?')
    params.push(opts.clientKind)
  }
  if (opts.source !== undefined) {
    where.push('source = ?')
    params.push(opts.source)
  }
  if (where.length === 0) return { sql: 'relay_usage_daily', params: [] }
  return { sql: `(${RAW_DAILY_SELECT} WHERE ${where.join(' AND ')})`, params }
}

function dailyWhere(opts: DailyBucketOptions): { sql: string; params: SqlParam[] } {
  const where: string[] = []
  const params: SqlParam[] = []
  if (opts.userId !== undefined) {
    where.push('user_id = ?')
    params.push(opts.userId)
  }
  if (opts.scope !== undefined) {
    where.push('scope = ?')
    params.push(opts.scope)
  }
  if (opts.model) {
    where.push('model = ?')
    params.push(opts.model)
  }
  if (opts.channelId !== undefined) {
    where.push('channel_id = ?')
    params.push(opts.channelId)
  }
  return { sql: where.length > 0 ? ` AND ${where.join(' AND ')}` : '', params }
}

const BUCKET_COLUMNS = `COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(errors), 0) AS errors,
       COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens, COALESCE(SUM(cost), 0) AS cost`

/** 同上，但列都带 `d.` 前缀（join users / relay_channels 时避免歧义） */
const BUCKET_COLUMNS_ALIASED = `COALESCE(SUM(d.requests), 0) AS requests, COALESCE(SUM(d.errors), 0) AS errors,
       COALESCE(SUM(d.input_tokens), 0) AS input_tokens, COALESCE(SUM(d.output_tokens), 0) AS output_tokens,
       COALESCE(SUM(d.cache_read_tokens), 0) AS cache_read_tokens,
       COALESCE(SUM(d.cache_write_tokens), 0) AS cache_write_tokens, COALESCE(SUM(d.cost), 0) AS cost`

/** `dailyWhere` 的别名版（列前加 `d.`） */
function dailyWhereAliased(opts: DailyBucketOptions): { sql: string; params: SqlParam[] } {
  const where: string[] = []
  const params: SqlParam[] = []
  if (opts.userId !== undefined) {
    where.push('d.user_id = ?')
    params.push(opts.userId)
  }
  if (opts.scope !== undefined) {
    where.push('d.scope = ?')
    params.push(opts.scope)
  }
  if (opts.model) {
    where.push('d.model = ?')
    params.push(opts.model)
  }
  if (opts.channelId !== undefined) {
    where.push('d.channel_id = ?')
    params.push(opts.channelId)
  }
  return { sql: where.length > 0 ? ` AND ${where.join(' AND ')}` : '', params }
}

/** 区间合计（`from`/`to` 是 Asia/Shanghai 的 `YYYY-MM-DD`，闭区间） */
export function sumDailyBuckets(
  db: HubDb,
  opts: DailyBucketOptions & { from: string; to: string },
): RelayUsageBucketDbRow {
  const { sql, params } = dailyWhere(opts)
  const source = dailySource(opts)
  return (
    db.get<RelayUsageBucketDbRow>(
      `SELECT ${BUCKET_COLUMNS} FROM ${source.sql} WHERE day >= ? AND day <= ?${sql}`,
      ...source.params,
      opts.from,
      opts.to,
      ...params,
    ) ?? {
      requests: 0,
      errors: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: 0,
    }
  )
}

export function dailyBucketsByDay(
  db: HubDb,
  opts: DailyBucketOptions & { from: string; to: string },
): (RelayUsageBucketDbRow & { day: string })[] {
  const { sql, params } = dailyWhere(opts)
  const source = dailySource(opts)
  return db.all<RelayUsageBucketDbRow & { day: string }>(
    `SELECT day, ${BUCKET_COLUMNS} FROM ${source.sql}
     WHERE day >= ? AND day <= ?${sql} GROUP BY day ORDER BY day ASC`,
    ...source.params,
    opts.from,
    opts.to,
    ...params,
  )
}

export function dailyBucketsByModel(
  db: HubDb,
  opts: DailyBucketOptions & { from: string; to: string },
): (RelayUsageBucketDbRow & { model: string })[] {
  const { sql, params } = dailyWhere(opts)
  const source = dailySource(opts)
  return db.all<RelayUsageBucketDbRow & { model: string }>(
    `SELECT model, ${BUCKET_COLUMNS} FROM ${source.sql}
     WHERE day >= ? AND day <= ?${sql} GROUP BY model ORDER BY cost DESC, model ASC`,
    ...source.params,
    opts.from,
    opts.to,
    ...params,
  )
}

/**
 * 19 §3：按「天 × 模型」分组的明细（用户端与管理端都给）。
 * 只返回有用量的格子（日汇总表里没有的格子前端自己补 0）；排序固定 `day ASC, cost DESC`。
 */
export function dailyBucketsByDayModel(
  db: HubDb,
  opts: DailyBucketOptions & { from: string; to: string },
): (RelayUsageBucketDbRow & { day: string; model: string })[] {
  const { sql, params } = dailyWhere(opts)
  const source = dailySource(opts)
  return db.all<RelayUsageBucketDbRow & { day: string; model: string }>(
    `SELECT day, model, ${BUCKET_COLUMNS} FROM ${source.sql}
     WHERE day >= ? AND day <= ?${sql}
     GROUP BY day, model ORDER BY day ASC, cost DESC, model ASC`,
    ...source.params,
    opts.from,
    opts.to,
    ...params,
  )
}

/** 按用户分组的汇总（管理端「按用户」Tab）；用别名 d 前缀的列，避免与 users 的列歧义 */
export function dailyBucketsByUser(
  db: HubDb,
  opts: DailyBucketOptions & { from: string; to: string },
): (RelayUsageBucketDbRow & { user_id: number; username: string })[] {
  const { sql, params } = dailyWhereAliased(opts)
  const source = dailySource(opts)
  return db.all<RelayUsageBucketDbRow & { user_id: number; username: string }>(
    `SELECT d.user_id AS user_id, u.username AS username, ${BUCKET_COLUMNS_ALIASED}
     FROM ${source.sql} d JOIN users u ON u.id = d.user_id
     WHERE d.day >= ? AND d.day <= ?${sql}
     GROUP BY d.user_id ORDER BY cost DESC, d.user_id ASC`,
    ...source.params,
    opts.from,
    opts.to,
    ...params,
  )
}

/** 按渠道分组的汇总（管理端「按渠道」Tab）；channel_id = 0 的行显示占位名 */
export function dailyBucketsByChannel(
  db: HubDb,
  opts: DailyBucketOptions & { from: string; to: string },
): (RelayUsageBucketDbRow & { channel_id: number; channel_name: string | null })[] {
  const { sql, params } = dailyWhereAliased(opts)
  const source = dailySource(opts)
  return db.all<RelayUsageBucketDbRow & { channel_id: number; channel_name: string | null }>(
    `SELECT d.channel_id AS channel_id, c.name AS channel_name, ${BUCKET_COLUMNS_ALIASED}
     FROM ${source.sql} d LEFT JOIN relay_channels c ON c.id = d.channel_id
     WHERE d.day >= ? AND d.day <= ?${sql}
     GROUP BY d.channel_id ORDER BY cost DESC, d.channel_id ASC`,
    ...source.params,
    opts.from,
    opts.to,
    ...params,
  )
}

/** 按来源分组的汇总（18 D7；用户端与管理端都返回） */
export function dailyBucketsByScope(
  db: HubDb,
  opts: DailyBucketOptions & { from: string; to: string },
): (RelayUsageBucketDbRow & { scope: string })[] {
  const { sql, params } = dailyWhere(opts)
  const source = dailySource(opts)
  return db.all<RelayUsageBucketDbRow & { scope: string }>(
    `SELECT scope, ${BUCKET_COLUMNS} FROM ${source.sql}
     WHERE day >= ? AND day <= ?${sql} GROUP BY scope ORDER BY cost DESC, scope ASC`,
    ...source.params,
    opts.from,
    opts.to,
    ...params,
  )
}

export function sumDailyCost(db: HubDb, userId: number, from: string, to: string): number {
  return Number(
    db.get<{ total: number | null }>(
      'SELECT SUM(cost) AS total FROM relay_usage_daily WHERE user_id = ? AND day >= ? AND day <= ?',
      userId,
      from,
      to,
    )?.total ?? 0,
  )
}

/** 逐条记录保留期清理（12 §8）；日汇总不删 */
export function deleteUsageBefore(db: HubDb, iso: string): number {
  return db.run('DELETE FROM relay_usage WHERE created_at < ?', iso).changes
}

/** 概览告警用：最近一段时间内按估算计费的请求比例 */
export function countUsageRows(db: HubDb, opts: { fromIso: string; estimated?: boolean }): number {
  const row =
    opts.estimated === undefined
      ? db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relay_usage WHERE created_at >= ?', opts.fromIso)
      : db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM relay_usage WHERE created_at >= ? AND estimated = ?',
          opts.fromIso,
          opts.estimated ? 1 : 0,
        )
  return Number(row?.n ?? 0)
}

/** 渠道最近一次上游错误（概览告警用） */
export function listChannelErrorRows(db: HubDb): RelayChannelRow[] {
  return db.all<RelayChannelRow>(
    'SELECT * FROM relay_channels WHERE last_error IS NOT NULL ORDER BY last_error_at DESC',
  )
}

export function listKeyErrorRows(db: HubDb): RelayChannelKeyRow[] {
  return db.all<RelayChannelKeyRow>(
    "SELECT * FROM relay_channel_keys WHERE state = 'auto-disabled' ORDER BY last_error_at DESC LIMIT 20",
  )
}

export function listKeyRowsByChannelsWithState(db: HubDb, channelIds: number[]): RelayChannelKeyRow[] {
  return listChannelKeyRowsByChannels(db, channelIds)
}

export function countKeyRowsByState(db: HubDb): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of db.all<{ state: string; n: number }>(
    'SELECT state, COUNT(*) AS n FROM relay_channel_keys GROUP BY state',
  )) {
    out.set(row.state, Number(row.n))
  }
  return out
}
