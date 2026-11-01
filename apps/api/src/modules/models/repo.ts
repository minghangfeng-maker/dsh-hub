import {
  ModelInfoSchema,
  ModelSpecSchema,
  type ModelApi,
  type ModelInfo,
  type ModelKeyInfo,
  type ModelKeyMode,
  type ModelPreset,
  type ModelProvider,
  type ModelProviderKind,
  type ModelSpec,
  type Platform,
} from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'

/**
 * models 模块的 SQL（03 §1.4）。**只有这个文件写 SQL**（11 §5）。
 * `models_json` / `compat_json` / `extra_json` 都是 TEXT，读出时经 zod 校验（坏数据按空处理，不让一行脏数据炸掉列表）。
 */

export interface ModelProviderRow {
  id: number
  route_key: string
  display_name: string
  kind: ModelProviderKind
  /** 1 = Hub 中转站提供方（12 §7；库里存 kind='pi-ai'，DTO 层映射成 'hub-relay'） */
  is_relay: number
  api: ModelApi | null
  base_url: string | null
  models_json: string
  compat_json: string | null
  extra_json: string | null
  key_mode: ModelKeyMode
  api_key_enc: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export interface ModelPresetRow {
  id: number
  /** `cloud` | `desktop`（迁移 124）：每个平台一套预设 */
  platform: Platform
  name: string
  description: string
  provider_ids_json: string
  default_provider: string
  default_model: string
  is_default: number
  revision: number
  created_at: string
  updated_at: string
}

export interface UserProviderKeyRow {
  user_id: number
  provider_id: number
  api_key_enc: string
  updated_at: string
}

/** 解析 JSON 列（坏数据 → 回退值，并让调用方决定是否告警） */
export function parseJsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function parseModels(raw: string): ModelSpec[] {
  const parsed = parseJsonColumn<unknown>(raw, [])
  if (!Array.isArray(parsed)) return []
  const out: ModelSpec[] = []
  for (const item of parsed) {
    const result = ModelSpecSchema.safeParse(item)
    if (result.success) out.push(result.data)
  }
  return out
}

export function parseProviderIds(raw: string): number[] {
  const parsed = parseJsonColumn<unknown>(raw, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
}

/** 行 → DTO（`apiKey` 只给 `{set, last4}`，WP3 只在这里拼装明文之外的字段） */
export function toModelProvider(row: ModelProviderRow, keyInfo: ModelKeyInfo): ModelProvider {
  return {
    id: row.id,
    routeKey: row.route_key,
    displayName: row.display_name,
    // hub-relay 存成 pi-ai + is_relay=1（迁移 044），这里还原成对外的 kind
    kind: row.is_relay === 1 ? 'hub-relay' : row.kind,
    api: row.api,
    baseUrl: row.base_url,
    models: parseModels(row.models_json),
    compat: parseJsonColumn<Record<string, unknown> | null>(row.compat_json, null),
    extra: parseJsonColumn<Record<string, unknown> | null>(row.extra_json, null),
    keyMode: row.key_mode,
    apiKey: keyInfo,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toModelPreset(row: ModelPresetRow, usersOnIt: number): ModelPreset {
  return {
    id: row.id,
    platform: row.platform === 'desktop' ? 'desktop' : 'cloud',
    name: row.name,
    description: row.description,
    providerIds: parseProviderIds(row.provider_ids_json),
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    isDefault: row.is_default === 1,
    revision: row.revision,
    usersOnIt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── model_providers ─────────────────────────────────────────────────────────

export function listProviderRows(db: HubDb): ModelProviderRow[] {
  return db.all<ModelProviderRow>('SELECT * FROM model_providers ORDER BY id ASC')
}

export function getProviderRow(db: HubDb, providerId: number): ModelProviderRow | undefined {
  return db.get<ModelProviderRow>('SELECT * FROM model_providers WHERE id = ?', providerId)
}

export function getProviderRowByRoute(db: HubDb, routeKey: string): ModelProviderRow | undefined {
  return db.get<ModelProviderRow>('SELECT * FROM model_providers WHERE route_key = ?', routeKey)
}

export interface InsertProviderInput {
  routeKey: string
  displayName: string
  kind: ModelProviderKind
  api: ModelApi | null
  baseUrl: string | null
  models: ModelSpec[]
  compat: Record<string, unknown> | null
  extra: Record<string, unknown> | null
  keyMode: ModelKeyMode
  apiKeyEnc: string | null
  enabled: boolean
  isRelay?: boolean
  at: string
}

export function insertProviderRow(db: HubDb, input: InsertProviderInput): number {
  const result = db.run(
    `INSERT INTO model_providers (route_key, display_name, kind, api, base_url, models_json, compat_json,
                                  extra_json, key_mode, api_key_enc, enabled, is_relay, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.routeKey,
    input.displayName,
    input.kind,
    input.api,
    input.baseUrl,
    JSON.stringify(input.models),
    input.compat ? JSON.stringify(input.compat) : null,
    input.extra ? JSON.stringify(input.extra) : null,
    input.keyMode,
    input.apiKeyEnc,
    input.enabled ? 1 : 0,
    input.isRelay ? 1 : 0,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdateProviderInput {
  routeKey?: string
  displayName?: string
  kind?: ModelProviderKind
  api?: ModelApi | null
  baseUrl?: string | null
  models?: ModelSpec[]
  compat?: Record<string, unknown> | null
  extra?: Record<string, unknown> | null
  keyMode?: ModelKeyMode
  /** `undefined` = 不改密钥；`null` = 清空 */
  apiKeyEnc?: string | null
  enabled?: boolean
  isRelay?: boolean
}

export function updateProviderRow(
  db: HubDb,
  providerId: number,
  patch: UpdateProviderInput,
  at: string,
): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.routeKey !== undefined) push('route_key', patch.routeKey)
  if (patch.displayName !== undefined) push('display_name', patch.displayName)
  if (patch.kind !== undefined) push('kind', patch.kind)
  if (patch.api !== undefined) push('api', patch.api)
  if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl)
  if (patch.models !== undefined) push('models_json', JSON.stringify(patch.models))
  if (patch.compat !== undefined) push('compat_json', patch.compat ? JSON.stringify(patch.compat) : null)
  if (patch.extra !== undefined) push('extra_json', patch.extra ? JSON.stringify(patch.extra) : null)
  if (patch.keyMode !== undefined) push('key_mode', patch.keyMode)
  if (patch.apiKeyEnc !== undefined) push('api_key_enc', patch.apiKeyEnc)
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
  if (patch.isRelay !== undefined) push('is_relay', patch.isRelay ? 1 : 0)
  push('updated_at', at)
  db.run(`UPDATE model_providers SET ${sets.join(', ')} WHERE id = ?`, ...params, providerId)
}

export function deleteProviderRow(db: HubDb, providerId: number): void {
  db.run('DELETE FROM model_providers WHERE id = ?', providerId)
}

// ── user_provider_keys ──────────────────────────────────────────────────────

export function getUserProviderKeyRow(
  db: HubDb,
  providerId: number,
  userId: number,
): UserProviderKeyRow | undefined {
  return db.get<UserProviderKeyRow>(
    'SELECT * FROM user_provider_keys WHERE provider_id = ? AND user_id = ?',
    providerId,
    userId,
  )
}

export function upsertUserProviderKeyRow(
  db: HubDb,
  providerId: number,
  userId: number,
  apiKeyEnc: string,
  at: string,
): void {
  db.run(
    `INSERT INTO user_provider_keys (user_id, provider_id, api_key_enc, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, provider_id) DO UPDATE SET api_key_enc = excluded.api_key_enc, updated_at = excluded.updated_at`,
    userId,
    providerId,
    apiKeyEnc,
    at,
  )
}

export function deleteUserProviderKeyRow(db: HubDb, providerId: number, userId: number): void {
  db.run('DELETE FROM user_provider_keys WHERE provider_id = ? AND user_id = ?', providerId, userId)
}

export function countProviderUserKeys(db: HubDb, providerId: number): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM user_provider_keys WHERE provider_id = ?',
    providerId,
  )
  return Number(row?.n ?? 0)
}

// ── model_presets ───────────────────────────────────────────────────────────

/** 全部预设（两个平台都在内）：引用计数、系统路由停用判定要用全量 */
export function listPresetRows(db: HubDb, platform?: Platform): ModelPresetRow[] {
  if (platform === undefined) return db.all<ModelPresetRow>('SELECT * FROM model_presets ORDER BY id ASC')
  return db.all<ModelPresetRow>(
    'SELECT * FROM model_presets WHERE platform = ? ORDER BY id ASC',
    platform,
  )
}

export function getPresetRow(db: HubDb, presetId: number): ModelPresetRow | undefined {
  return db.get<ModelPresetRow>('SELECT * FROM model_presets WHERE id = ?', presetId)
}

/** 预设名只在**同一平台内**唯一（迁移 124） */
export function getPresetRowByName(db: HubDb, name: string, platform: Platform = 'cloud'): ModelPresetRow | undefined {
  return db.get<ModelPresetRow>(
    'SELECT * FROM model_presets WHERE name = ? AND platform = ?',
    name,
    platform,
  )
}

/** 某平台的默认预设（缺省云上） */
export function getDefaultPresetRow(db: HubDb, platform: Platform = 'cloud'): ModelPresetRow | undefined {
  return db.get<ModelPresetRow>(
    'SELECT * FROM model_presets WHERE is_default = 1 AND platform = ? ORDER BY id LIMIT 1',
    platform,
  )
}

export interface InsertPresetInput {
  name: string
  description: string
  providerIds: number[]
  defaultProvider: string
  defaultModel: string
  isDefault: boolean
  at: string
  /** 缺省云上（旧调用不变） */
  platform?: Platform
}

export function insertPresetRow(db: HubDb, input: InsertPresetInput): number {
  const result = db.run(
    `INSERT INTO model_presets (name, platform, description, provider_ids_json, default_provider, default_model,
                                is_default, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    input.name,
    input.platform ?? 'cloud',
    input.description,
    JSON.stringify(input.providerIds),
    input.defaultProvider,
    input.defaultModel,
    input.isDefault ? 1 : 0,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdatePresetInput {
  name?: string
  description?: string
  providerIds?: number[]
  defaultProvider?: string
  defaultModel?: string
  isDefault?: boolean
}

/** PATCH 语义：改动即 `revision + 1`；`isDefault` 由调用方在同一事务里先清空其他默认 */
export function updatePresetRow(db: HubDb, presetId: number, patch: UpdatePresetInput, at: string): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.name !== undefined) push('name', patch.name)
  if (patch.description !== undefined) push('description', patch.description)
  if (patch.providerIds !== undefined) push('provider_ids_json', JSON.stringify(patch.providerIds))
  if (patch.defaultProvider !== undefined) push('default_provider', patch.defaultProvider)
  if (patch.defaultModel !== undefined) push('default_model', patch.defaultModel)
  if (patch.isDefault !== undefined) push('is_default', patch.isDefault ? 1 : 0)
  sets.push('revision = revision + 1')
  push('updated_at', at)
  db.run(`UPDATE model_presets SET ${sets.join(', ')} WHERE id = ?`, ...params, presetId)
}

/** 清掉某平台的默认标记（缺省云上；`exceptId` 保留一个） */
export function clearDefaultPresets(db: HubDb, exceptId?: number, platform: Platform = 'cloud'): void {
  if (exceptId === undefined) {
    db.run('UPDATE model_presets SET is_default = 0 WHERE is_default = 1 AND platform = ?', platform)
  } else {
    db.run(
      'UPDATE model_presets SET is_default = 0 WHERE is_default = 1 AND platform = ? AND id <> ?',
      platform,
      exceptId,
    )
  }
}

export function deletePresetRow(db: HubDb, presetId: number): void {
  db.run('DELETE FROM model_presets WHERE id = ?', presetId)
}

/** 引用该预设的用户数（逻辑外键 → users.model_preset_id） */
export function countUsersOnPreset(db: HubDb, presetId: number): number {
  const row = db.get<{ n: number }>(
    // 系统账号（WP56b 的 hub-ops）不算「有几个用户用这个预设」
    'SELECT COUNT(*) AS n FROM users WHERE model_preset_id = ? AND deleted_at IS NULL AND is_system = 0',
    presetId,
  )
  return Number(row?.n ?? 0)
}

export function countUsersOnProvider(db: HubDb, providerId: number): number {
  const presets = listPresetRows(db).filter((row) =>
    parseProviderIds(row.provider_ids_json).includes(providerId),
  )
  if (presets.length === 0) return 0
  const placeholders = presets.map(() => '?').join(', ')
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND is_system = 0 AND model_preset_id IN (${placeholders})`,
    ...presets.map((preset) => preset.id),
  )
  return Number(row?.n ?? 0)
}

/** 所有 per-user 密钥模式的提供方（管理端用户详情的 providerKeys 用） */
export function listPerUserProviderRows(db: HubDb): ModelProviderRow[] {
  return db.all<ModelProviderRow>("SELECT * FROM model_providers WHERE key_mode = 'per-user' ORDER BY id ASC")
}

/** 模型策略为 managed 且没有指定预设时用默认预设；free 的用户完全不注入模型配置 */
export interface UserModelTargetRow {
  id: number
  slug: string
  model_policy: string
  model_preset_id: number | null
  runtime_id: number | null
  /** 渲染 hub-relay 的模型列表时要按管理员的可见性口径（12 §7.2） */
  role: string
}

export function getUserModelTarget(db: HubDb, userId: number): UserModelTargetRow | undefined {
  return db.get<UserModelTargetRow>(
    `SELECT id, slug, model_policy, model_preset_id, runtime_id, role
     FROM users WHERE id = ? AND deleted_at IS NULL`,
    userId,
  )
}

/** 所有「模型由 Hub 管理」的用户（下发目标解析用） */
export function listManagedModelUsers(db: HubDb): number[] {
  return db
    .all<{ id: number }>(
      "SELECT id FROM users WHERE deleted_at IS NULL AND model_policy = 'managed' ORDER BY id ASC",
    )
    .map((row) => row.id)
}

/** 把用户的预设期望值写库（rollout 步骤 2；`null` = 跟随默认预设） */
export function setUserPreset(db: HubDb, userId: number, presetId: number | null, at: string): void {
  db.run('UPDATE users SET model_preset_id = ?, updated_at = ? WHERE id = ?', presetId, at, userId)
}

/**
 * 把所有用户的预设期望值清空（12 §7.0：下发配置改了以后统一跟随默认预设），返回清掉的用户数。
 * 已删除的用户也清（恢复后不会带着一个早就过期的预设）。
 */
export function clearAllUserPresets(db: HubDb, at: string): number {
  return db.run(
    'UPDATE users SET model_preset_id = NULL, updated_at = ? WHERE model_preset_id IS NOT NULL',
    at,
  ).changes
}

// ── model_catalog（自定义模型信息库）─────────────────────────────────────────

export interface CatalogRow {
  key: string
  model_id: string
  info_json: string
  updated_at: string
}

export interface CatalogRecord {
  key: string
  modelId: string
  info: ModelInfo
  updatedAt: string
}

export function listCatalogRows(db: HubDb): CatalogRow[] {
  return db.all<CatalogRow>('SELECT * FROM model_catalog ORDER BY key ASC')
}

/** 行 → 记录；info_json 经 zod 校验，坏行按「没有信息」处理（不让一行脏数据炸掉整个库） */
export function toCatalogRecord(row: CatalogRow): CatalogRecord {
  const parsed = ModelInfoSchema.safeParse(parseJsonColumn<unknown>(row.info_json, {}))
  return {
    key: row.key,
    modelId: row.model_id,
    info: parsed.success ? parsed.data : {},
    updatedAt: row.updated_at,
  }
}

export function upsertCatalogRow(db: HubDb, key: string, modelId: string, info: ModelInfo, at: string): void {
  db.run(
    `INSERT INTO model_catalog (key, model_id, info_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET model_id = excluded.model_id, info_json = excluded.info_json,
                                    updated_at = excluded.updated_at`,
    key,
    modelId,
    JSON.stringify(info),
    at,
  )
}

/** 返回是否真的删到了一行 */
export function deleteCatalogRow(db: HubDb, key: string): boolean {
  return db.run('DELETE FROM model_catalog WHERE key = ?', key).changes > 0
}

// ── hub-relay 相关（WP10a）─────────────────────────────────────────────────

/** 全部 hub-relay 提供方（12 §7） */
export function listRelayProviderRows(db: HubDb): ModelProviderRow[] {
  return db.all<ModelProviderRow>('SELECT * FROM model_providers WHERE is_relay = 1 ORDER BY id ASC')
}

export function countRelayProviderRows(db: HubDb): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM model_providers WHERE is_relay = 1')?.n ?? 0)
}

/** 生效预设里是否有启用的 hub-relay 提供方（`/api/me/relay` 的 dshAttached） */
export function countEnabledRelayProvidersIn(db: HubDb, providerIds: number[]): number {
  if (providerIds.length === 0) return 0
  const placeholders = providerIds.map(() => '?').join(', ')
  return Number(
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM model_providers WHERE is_relay = 1 AND enabled = 1 AND id IN (${placeholders})`,
      ...providerIds,
    )?.n ?? 0,
  )
}
