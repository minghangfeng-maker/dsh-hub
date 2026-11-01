import type { HubDb } from '../../db/index.js'

/**
 * 桌面下发（WP25b，迁移 122）的 SQL 层。**只做查询与写入**，业务规则在 service.ts。
 *
 * 三条纪律：
 * 1. 发布日志（desktop_deliveries）只 INSERT —— 设备的 desiredRevision 是它的纯函数（max 匹配行）；
 * 2. 期望状态的三个表（插件 / 配置片段 / 卸载）用 scope + role/user_id 表达目标，
 *    组合由迁移里的 CHECK 锁死，partial unique index 保证「同目标同条目只有一行」；
 * 3. 时间一律由调用方传入（`at`），不在这里取时钟 —— 测试才能推进时间。
 */

// ── 行类型 ──────────────────────────────────────────────────────────────────

/** 受管插件行 + 目录/版本/整包的联表结果（渲染清单与管���端视图共用） */
export interface PluginTargetRow {
  id: number
  plugin_id: number
  version_id: number
  enabled: number
  scope: string
  role: string
  user_id: number | null
  package_name: string
  display_name: string
  policy: string
  bundle_order: number
  needs_restart: number
  config_yaml: string
  version: string
  min_dsh: string | null
  file_name: string | null
  bytes: number | null
  sha256: string | null
  artifact_uploaded_at: string | null
}

export interface ConfigFragmentRow {
  id: number
  entry_id: string
  mode: string
  config_json: string
  note: string
  scope: string
  role: string
  user_id: number | null
}

export interface UninstallRow {
  id: number
  package_name: string
  scope: string
  role: string
  user_id: number | null
}

export interface ChannelPolicyRow {
  channel: string
  target_version: string | null
  min_version: string | null
  min_version_hard: number
  rollout_percent: number
}

export interface PolicyOverrideRow {
  id: number
  channel: string
  scope: string
  role: string
  user_id: number | null
  target_version: string | null
  min_version: string | null
  min_version_hard: number | null
  rollout_percent: number | null
}

export interface DeliveryRow {
  revision: number
  scope: string
  role: string
  user_id: number | null
  kind: string
  created_at: string
}

export interface ArtifactRow {
  version_id: number
  plugin_id: number
  package_name: string
  version: string
  file_name: string
  bytes: number
  sha256: string
  uploaded_at: string
}

export interface ReleaseRow {
  id: number
  target: string
  channel: string
  version: string
  installer_file: string
  installer_bytes: number
  installer_sha512: string
  blockmap_file: string | null
  blockmap_bytes: number | null
  blockmap_sha512: string | null
  /** WP38：免安装 ZIP（不进 feed，只给公开主页下载） */
  portable_file: string | null
  portable_bytes: number | null
  portable_sha512: string | null
  feed_file: string
  yaml: string
  status: string
  uploaded_at: string
}

export interface FloorRow {
  min_version: string | null
  title: string
  detail: string
  app_link: string | null
  updated_at: string
}

/** 目标作用域的规范化形态（`role`/`user_id` 在不适用的 scope 下是空串/null） */
export interface ScopeKey {
  scope: 'all' | 'role' | 'user'
  role: string
  userId: number | null
}

/** 由请求里的判别联合目标算出 SQL 用的三元组 */
export function scopeOf(target: {
  scope: 'all' | 'role' | 'user'
  role?: 'user' | 'admin'
  userId?: number
}): ScopeKey {
  if (target.scope === 'all') return { scope: 'all', role: '', userId: null }
  if (target.scope === 'role') return { scope: 'role', role: target.role ?? 'user', userId: null }
  if (target.userId === undefined) {
    throw new Error('scope=user 的目标缺少 userId')
  }
  return { scope: 'user', role: '', userId: target.userId }
}

// ── 发布计数器与发布日志 ────────────────────────────────────────────────────

export function readCounter(db: HubDb): number {
  const row = db.get<{ revision: number }>('SELECT revision FROM desktop_delivery_counter WHERE id = 1')
  return Number(row?.revision ?? 0)
}

/** 首发从 2 开始（1 预留空清单），此后计数器 +1；事务中追加一行发布日志。 */
export function appendDelivery(
  db: HubDb,
  input: {
    scope: ScopeKey
    kind: 'plugin' | 'config' | 'app' | 'uninstall' | 'mixed'
    actorId: number | null
    detail: Record<string, unknown> | null
    at: string
  },
): number {
  return db.tx(() => {
    // A new device may already have applied the empty revision 1 before any publication.
    // This also repairs existing databases whose counter is still seeded with 0.
    const next = Math.max(1, readCounter(db)) + 1
    db.run('UPDATE desktop_delivery_counter SET revision = ?, updated_at = ? WHERE id = 1', next, input.at)
    db.run(
      `INSERT INTO desktop_deliveries (revision, scope, role, user_id, kind, actor_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      next,
      input.scope.scope,
      input.scope.role,
      input.scope.userId,
      input.kind,
      input.actorId,
      input.detail ? JSON.stringify(input.detail) : null,
      input.at,
    )
    return next
  })
}

/**
 * 设备的 desiredRevision = 作用于它的发布行的 max（没有行 → 1，清单 schema 的 minimum）。
 * **纯函数**：只读，不改状态 —— manifest GET 必须无副作用（裁决 #4）。
 */
export function desiredRevisionFor(db: HubDb, userId: number, role: string): number {
  const row = db.get<{ revision: number | null }>(
    `SELECT MAX(revision) AS revision FROM desktop_deliveries
      WHERE scope = 'all'
         OR (scope = 'role' AND role = ?)
         OR (scope = 'user' AND user_id = ?)`,
    role,
    userId,
  )
  return Math.max(1, Number(row?.revision ?? 0))
}

/** 最近 N 条发布（管理端「什么时候下发过什么」） */
export function listRecentDeliveries(db: HubDb, limit = 20): DeliveryRow[] {
  return db.all<DeliveryRow>(
    `SELECT revision, scope, role, user_id, kind, created_at FROM desktop_deliveries
      ORDER BY revision DESC LIMIT ?`,
    Math.max(1, Math.min(200, limit)),
  )
}

export function getUserRole(db: HubDb, userId: number): string | null {
  const row = db.get<{ role: string }>('SELECT role FROM users WHERE id = ? AND deleted_at IS NULL', userId)
  return row?.role ?? null
}

/** 某个目标作用域下的有效设备数（active） */
export function countActiveDevicesFor(db: HubDb, scope: ScopeKey): number {
  if (scope.scope === 'all') {
    const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM desktop_devices WHERE status = 'active'")
    return Number(row?.n ?? 0)
  }
  if (scope.scope === 'role') {
    const row = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM desktop_devices d JOIN users u ON u.id = d.user_id
        WHERE d.status = 'active' AND u.role = ? AND u.deleted_at IS NULL`,
      scope.role,
    )
    return Number(row?.n ?? 0)
  }
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM desktop_devices WHERE status = 'active' AND user_id = ?",
    scope.userId,
  )
  return Number(row?.n ?? 0)
}

// ── 受管插件 ────────────────────────────────────────────────────────────────

/**
 * 受管插件行 + 目录/版本/整包的联表结果。
 * WP32a（docs/22 §2.1）：`policy` / `bundle_order` / `needs_restart` / `config_yaml` 取自**桌面平台**的设置行
 * （`plugin_platforms.platform='desktop'`），不再是 `plugins` 的镜像列 —— 云上设为 required 的插件
 * 不会再被当成 core 推给桌面。没有桌面行时回落到镜像列（历史数据兜底）。
 */
const PLUGIN_TARGET_SELECT = `
  SELECT t.id, t.plugin_id, t.version_id, t.enabled, t.scope, t.role, t.user_id,
         p.package_name, p.display_name,
         COALESCE(pp.policy, p.policy) AS policy,
         COALESCE(pp.bundle_order, p.bundle_order) AS bundle_order,
         COALESCE(pp.needs_restart, p.needs_restart) AS needs_restart,
         COALESCE(pp.config_yaml, p.config_yaml) AS config_yaml,
         v.version, v.min_dsh,
         a.file_name, a.bytes, a.sha256, a.uploaded_at AS artifact_uploaded_at
    FROM desktop_plugin_targets t
    JOIN plugins p ON p.id = t.plugin_id
    JOIN plugin_versions v ON v.id = t.version_id
    LEFT JOIN plugin_platforms pp ON pp.plugin_id = t.plugin_id AND pp.platform = 'desktop'
    LEFT JOIN desktop_plugin_artifacts a ON a.version_id = t.version_id`

export function listPluginTargets(db: HubDb): PluginTargetRow[] {
  return db.all<PluginTargetRow>(`${PLUGIN_TARGET_SELECT} ORDER BY p.package_name, t.id`)
}

export function getPluginTarget(db: HubDb, scope: ScopeKey, pluginId: number): PluginTargetRow | undefined {
  return db.get<PluginTargetRow>(
    `${PLUGIN_TARGET_SELECT}
      WHERE t.plugin_id = ? AND t.scope = ? AND t.role = ?
        AND (t.user_id = ? OR (t.user_id IS NULL AND ? IS NULL))`,
    pluginId,
    scope.scope,
    scope.role,
    scope.userId,
    scope.userId,
  )
}

/** 同目标同插件：有则改版本/开关，无则插 */
export function upsertPluginTarget(
  db: HubDb,
  input: {
    scope: ScopeKey
    pluginId: number
    versionId: number
    enabled: boolean
    actorId: number | null
    at: string
  },
): number {
  const existing = getPluginTarget(db, input.scope, input.pluginId)
  if (existing) {
    db.run(
      `UPDATE desktop_plugin_targets SET version_id = ?, enabled = ?, updated_by = ?, updated_at = ?
        WHERE id = ?`,
      input.versionId,
      input.enabled ? 1 : 0,
      input.actorId,
      input.at,
      existing.id,
    )
    return existing.id
  }
  const result = db.run(
    `INSERT INTO desktop_plugin_targets (plugin_id, version_id, enabled, scope, role, user_id, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.pluginId,
    input.versionId,
    input.enabled ? 1 : 0,
    input.scope.scope,
    input.scope.role,
    input.scope.userId,
    input.actorId,
    input.at,
  )
  return result.lastInsertRowid
}

/** 某插件在该平台上的设置行（下发前检查 policy / 加入桌面库用） */
export function getPluginPlatformSettings(
  db: HubDb,
  pluginId: number,
  platform: 'cloud' | 'desktop',
): { policy: string; bundle_order: number; config_yaml: string; needs_restart: number } | undefined {
  return db.get<{ policy: string; bundle_order: number; config_yaml: string; needs_restart: number }>(
    'SELECT policy, bundle_order, config_yaml, needs_restart FROM plugin_platforms WHERE plugin_id = ? AND platform = ?',
    pluginId,
    platform,
  )
}

export function insertPluginPlatformSettings(
  db: HubDb,
  input: {
    pluginId: number
    platform: 'cloud' | 'desktop'
    policy: string
    bundleOrder: number
    configYaml: string
    needsRestart: number
    at: string
  },
): void {
  db.run(
    `INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id, platform) DO NOTHING`,
    input.pluginId,
    input.platform,
    input.policy,
    input.bundleOrder,
    input.configYaml,
    input.needsRestart,
    input.at,
    input.at,
  )
}

export function deletePluginTarget(db: HubDb, scope: ScopeKey, pluginId: number): number {
  return db.run(
    `DELETE FROM desktop_plugin_targets
      WHERE plugin_id = ? AND scope = ? AND role = ?
        AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    pluginId,
    scope.scope,
    scope.role,
    scope.userId,
    scope.userId,
  ).changes
}

/** 版本行（平台归属与可复制字段） */
export interface VersionPlatformRow {
  id: number
  plugin_id: number
  platform: 'cloud' | 'desktop'
  version: string
  source_type: string
  source_ref: string
  spec: string
  store_file: string | null
  sha256: string | null
  min_dsh: string | null
  created_at: string
}

export function getVersionPlatformRow(db: HubDb, versionId: number): VersionPlatformRow | undefined {
  return db.get<VersionPlatformRow>('SELECT * FROM plugin_versions WHERE id = ?', versionId)
}

export function findVersionOfPlatform(
  db: HubDb,
  pluginId: number,
  version: string,
  platform: 'cloud' | 'desktop',
): VersionPlatformRow | undefined {
  return db.get<VersionPlatformRow>(
    'SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ? AND platform = ?',
    pluginId,
    version,
    platform,
  )
}

/** 复制一条版本行到另一个平台（桌面整包必须有对应的桌面版本行） */
export function copyVersionToPlatform(db: HubDb, row: VersionPlatformRow, platform: 'cloud' | 'desktop'): number {
  return db.run(
    `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.plugin_id,
    platform,
    row.version,
    row.source_type,
    row.source_ref,
    row.spec,
    row.store_file,
    row.sha256,
    row.min_dsh,
    row.created_at,
  ).lastInsertRowid
}

/**
 * 最近一次**写入桌面模型片段**的清单版本（`/api/admin/relay/dsh?platform=desktop` 的 lastDelivery 用）。
 *
 * 「写入模型片段」的三种来源，都在 `desktop_deliveries.detail_json` 里留了痕迹：
 * - 统一下发 models（`items[].kind = 'models'`，新行还有 `modelsWritten`）；
 * - 桌面模型基线（`reason = 'desktop-model-baseline'`）；
 * - 管理端直接改配置片段（`entryIds` 里有 `llm-pi-ai` / `agent-default-model`）。
 */
export interface LastModelDeliveryRow {
  revision: number
  created_at: string
  actor_id: number | null
  actor_name: string | null
}

export function lastModelConfigDelivery(db: HubDb): LastModelDeliveryRow | undefined {
  return db.get<LastModelDeliveryRow>(
    `SELECT d.revision, d.created_at, d.actor_id, u.username AS actor_name
       FROM desktop_deliveries d
       LEFT JOIN users u ON u.id = d.actor_id
      WHERE d.kind IN ('config', 'mixed')
        AND json_valid(d.detail_json)
        AND (
          json_extract(d.detail_json, '$.modelsWritten') = 1
          OR json_extract(d.detail_json, '$.reason') = 'desktop-model-baseline'
          OR EXISTS (
            SELECT 1 FROM json_each(d.detail_json, '$.entryIds')
             WHERE value IN ('llm-pi-ai', 'agent-default-model')
          )
          OR EXISTS (
            SELECT 1 FROM json_each(d.detail_json, '$.items')
             WHERE json_extract(value, '$.kind') = 'models'
          )
        )
      ORDER BY d.revision DESC LIMIT 1`,
  )
}

/** 桌面受众与最近一次模型配置下发（`/relay/dsh?platform=desktop` 的 pending 用） */
export function desktopAudience(db: HubDb): { users: number; devices: number; lastConfigAt: string | null } {
  const devices = db.get<{ n: number; users: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT d.user_id) AS users
       FROM desktop_devices d JOIN users u ON u.id = d.user_id
      WHERE d.status = 'active' AND u.deleted_at IS NULL`,
  )
  const last = db.get<{ at: string | null }>(
    `SELECT MAX(created_at) AS at FROM desktop_deliveries WHERE kind IN ('config', 'mixed')`,
  )
  return {
    users: Number(devices?.users ?? 0),
    devices: Number(devices?.n ?? 0),
    lastConfigAt: last?.at ?? null,
  }
}

// ── 配置片段 ────────────────────────────────────────────────────────────────

const FRAGMENT_SELECT = `
  SELECT id, entry_id, mode, config_json, note, scope, role, user_id
    FROM desktop_config_fragments`

export function listConfigFragments(db: HubDb): ConfigFragmentRow[] {
  return db.all<ConfigFragmentRow>(`${FRAGMENT_SELECT} ORDER BY entry_id, id`)
}

export function listConfigFragmentsFor(db: HubDb, scope: ScopeKey): ConfigFragmentRow[] {
  return db.all<ConfigFragmentRow>(
    `${FRAGMENT_SELECT}
      WHERE scope = ? AND role = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
      ORDER BY entry_id`,
    scope.scope,
    scope.role,
    scope.userId,
    scope.userId,
  )
}

/** 整体替换某个目标上的片段集合（PUT 语义） */
export function replaceConfigFragments(
  db: HubDb,
  input: {
    scope: ScopeKey
    fragments: { entryId: string; mode: string; configJson: string; note: string }[]
    actorId: number | null
    at: string
  },
): void {
  db.tx(() => {
    db.run(
      `DELETE FROM desktop_config_fragments
        WHERE scope = ? AND role = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
      input.scope.scope,
      input.scope.role,
      input.scope.userId,
      input.scope.userId,
    )
    for (const fragment of input.fragments) {
      db.run(
        `INSERT INTO desktop_config_fragments
           (entry_id, mode, config_json, note, scope, role, user_id, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fragment.entryId,
        fragment.mode,
        fragment.configJson,
        fragment.note,
        input.scope.scope,
        input.scope.role,
        input.scope.userId,
        input.actorId,
        input.at,
      )
    }
  })
}

// ── 卸载清单 ────────────────────────────────────────────────────────────────

export function listUninstallTargets(db: HubDb): UninstallRow[] {
  return db.all<UninstallRow>(
    'SELECT id, package_name, scope, role, user_id FROM desktop_uninstall_targets ORDER BY package_name, id',
  )
}

export function addUninstallTarget(
  db: HubDb,
  input: { scope: ScopeKey; packageName: string; actorId: number | null; at: string },
): void {
  const existing = db.get<{ id: number }>(
    `SELECT id FROM desktop_uninstall_targets
      WHERE package_name = ? AND scope = ? AND role = ?
        AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    input.packageName,
    input.scope.scope,
    input.scope.role,
    input.scope.userId,
    input.scope.userId,
  )
  if (existing) return
  db.run(
    `INSERT INTO desktop_uninstall_targets (package_name, scope, role, user_id, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.packageName,
    input.scope.scope,
    input.scope.role,
    input.scope.userId,
    input.actorId,
    input.at,
  )
}

export function removeUninstallTarget(db: HubDb, scope: ScopeKey, packageName: string): number {
  return db.run(
    `DELETE FROM desktop_uninstall_targets
      WHERE package_name = ? AND scope = ? AND role = ?
        AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    packageName,
    scope.scope,
    scope.role,
    scope.userId,
    scope.userId,
  ).changes
}

// ── 版本策略 ────────────────────────────────────────────────────────────────

export function listChannelPolicies(db: HubDb): ChannelPolicyRow[] {
  return db.all<ChannelPolicyRow>(
    `SELECT channel, target_version, min_version, min_version_hard, rollout_percent
       FROM desktop_channel_policies ORDER BY channel`,
  )
}

export function getChannelPolicy(db: HubDb, channel: string): ChannelPolicyRow | undefined {
  return db.get<ChannelPolicyRow>(
    `SELECT channel, target_version, min_version, min_version_hard, rollout_percent
       FROM desktop_channel_policies WHERE channel = ?`,
    channel,
  )
}

export function upsertChannelPolicy(
  db: HubDb,
  input: {
    channel: string
    targetVersion: string | null
    minVersion: string | null
    minVersionHard: boolean
    rolloutPercent: number
    actorId: number | null
    at: string
  },
): void {
  db.run(
    `UPDATE desktop_channel_policies
        SET target_version = ?, min_version = ?, min_version_hard = ?, rollout_percent = ?,
            updated_by = ?, updated_at = ?
      WHERE channel = ?`,
    input.targetVersion,
    input.minVersion,
    input.minVersionHard ? 1 : 0,
    input.rolloutPercent,
    input.actorId,
    input.at,
    input.channel,
  )
}

export function listPolicyOverrides(db: HubDb): PolicyOverrideRow[] {
  return db.all<PolicyOverrideRow>(
    `SELECT id, channel, scope, role, user_id, target_version, min_version, min_version_hard, rollout_percent
       FROM desktop_policy_overrides ORDER BY channel, scope, role, user_id`,
  )
}

export function upsertPolicyOverride(
  db: HubDb,
  input: {
    channel: string
    scope: ScopeKey
    targetVersion: string | null | undefined
    minVersion: string | null | undefined
    minVersionHard: boolean | undefined
    rolloutPercent: number | undefined
    actorId: number | null
    at: string
  },
): void {
  const existing = db.get<PolicyOverrideRow>(
    `SELECT id FROM desktop_policy_overrides
      WHERE channel = ? AND scope = ? AND role = ?
        AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    input.channel,
    input.scope.scope,
    input.scope.role,
    input.scope.userId,
    input.scope.userId,
  )
  const targetVersion = input.targetVersion === undefined ? undefined : input.targetVersion
  const minVersion = input.minVersion === undefined ? undefined : input.minVersion
  const minVersionHard = input.minVersionHard === undefined ? undefined : input.minVersionHard
  if (existing) {
    db.run(
      `UPDATE desktop_policy_overrides
          SET target_version = ?, min_version = ?, min_version_hard = ?, rollout_percent = ?,
              updated_by = ?, updated_at = ?
        WHERE id = ?`,
      targetVersion === undefined ? null : targetVersion,
      minVersion === undefined ? null : minVersion,
      minVersionHard === undefined ? null : minVersionHard ? 1 : 0,
      input.rolloutPercent === undefined ? null : input.rolloutPercent,
      input.actorId,
      input.at,
      existing.id,
    )
    return
  }
  db.run(
    `INSERT INTO desktop_policy_overrides
       (channel, scope, role, user_id, target_version, min_version, min_version_hard, rollout_percent,
        updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.channel,
    input.scope.scope,
    input.scope.role,
    input.scope.userId,
    targetVersion === undefined ? null : targetVersion,
    minVersion === undefined ? null : minVersion,
    minVersionHard === undefined ? null : minVersionHard ? 1 : 0,
    input.rolloutPercent === undefined ? null : input.rolloutPercent,
    input.actorId,
    input.at,
  )
}

export function deletePolicyOverride(db: HubDb, channel: string, scope: ScopeKey): number {
  return db.run(
    `DELETE FROM desktop_policy_overrides
      WHERE channel = ? AND scope = ? AND role = ?
        AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    channel,
    scope.scope,
    scope.role,
    scope.userId,
    scope.userId,
  ).changes
}

// ── 强更地板 ────────────────────────────────────────────────────────────────

export function getFloor(db: HubDb): FloorRow {
  const row = db.get<FloorRow>(
    'SELECT min_version, title, detail, app_link, updated_at FROM desktop_update_floor WHERE id = 1',
  )
  return row ?? { min_version: null, title: '', detail: '', app_link: null, updated_at: '' }
}

export function updateFloor(
  db: HubDb,
  input: {
    minVersion: string | null
    title: string
    detail: string
    appLink: string | null
    actorId: number | null
    at: string
  },
): void {
  db.run(
    `UPDATE desktop_update_floor
        SET min_version = ?, title = ?, detail = ?, app_link = ?, updated_by = ?, updated_at = ?
      WHERE id = 1`,
    input.minVersion,
    input.title,
    input.detail,
    input.appLink,
    input.actorId,
    input.at,
  )
}

// ── 插件整包 ────────────────────────────────────────────────────────────────

export function getArtifact(db: HubDb, versionId: number): ArtifactRow | undefined {
  return db.get<ArtifactRow>(
    `SELECT a.version_id, a.plugin_id, p.package_name, v.version, a.file_name, a.bytes, a.sha256,
            a.uploaded_at
       FROM desktop_plugin_artifacts a
       JOIN plugins p ON p.id = a.plugin_id
       JOIN plugin_versions v ON v.id = a.version_id
      WHERE a.version_id = ?`,
    versionId,
  )
}

export function findArtifactByPackageVersion(
  db: HubDb,
  packageName: string,
  version: string,
): ArtifactRow | undefined {
  return db.get<ArtifactRow>(
    `SELECT a.version_id, a.plugin_id, p.package_name, v.version, a.file_name, a.bytes, a.sha256,
            a.uploaded_at
       FROM desktop_plugin_artifacts a
       JOIN plugins p ON p.id = a.plugin_id
       JOIN plugin_versions v ON v.id = a.version_id
      WHERE p.package_name = ? AND v.version = ?`,
    packageName,
    version,
  )
}

export function listArtifactsByPlugin(db: HubDb, pluginId: number): ArtifactRow[] {
  return db.all<ArtifactRow>(
    `SELECT a.version_id, a.plugin_id, p.package_name, v.version, a.file_name, a.bytes, a.sha256,
            a.uploaded_at
       FROM desktop_plugin_artifacts a
       JOIN plugins p ON p.id = a.plugin_id
       JOIN plugin_versions v ON v.id = a.version_id
      WHERE a.plugin_id = ?
      ORDER BY v.created_at DESC, a.version_id DESC`,
    pluginId,
  )
}

export function upsertArtifact(
  db: HubDb,
  input: {
    versionId: number
    pluginId: number
    fileName: string
    bytes: number
    sha256: string
    actorId: number | null
    at: string
  },
): void {
  db.run(
    `INSERT INTO desktop_plugin_artifacts (version_id, plugin_id, file_name, bytes, sha256, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_id) DO UPDATE SET
       file_name = excluded.file_name, bytes = excluded.bytes, sha256 = excluded.sha256,
       uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
    input.versionId,
    input.pluginId,
    input.fileName,
    input.bytes,
    input.sha256,
    input.actorId,
    input.at,
  )
}

export function deleteArtifact(db: HubDb, versionId: number): number {
  return db.run('DELETE FROM desktop_plugin_artifacts WHERE version_id = ?', versionId).changes
}

// ── 安装包与 feed ───────────────────────────────────────────────────────────

export function insertRelease(
  db: HubDb,
  input: {
    target: string
    channel: string
    version: string
    installerFile: string
    installerBytes: number
    installerSha512: string
    blockmapFile: string | null
    blockmapBytes: number | null
    blockmapSha512: string | null
    feedFile: string
    yaml: string
    actorId: number | null
    at: string
  },
): number {
  const result = db.run(
    `INSERT INTO desktop_releases
       (target, channel, version, installer_file, installer_bytes, installer_sha512,
        blockmap_file, blockmap_bytes, blockmap_sha512, feed_file, yaml, status, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
    input.target,
    input.channel,
    input.version,
    input.installerFile,
    input.installerBytes,
    input.installerSha512,
    input.blockmapFile,
    input.blockmapBytes,
    input.blockmapSha512,
    input.feedFile,
    input.yaml,
    input.actorId,
    input.at,
  )
  return result.lastInsertRowid
}

export function getRelease(db: HubDb, id: number): ReleaseRow | undefined {
  return db.get<ReleaseRow>('SELECT * FROM desktop_releases WHERE id = ?', id)
}

export function findReleaseByVersion(
  db: HubDb,
  target: string,
  channel: string,
  version: string,
): ReleaseRow | undefined {
  return db.get<ReleaseRow>(
    'SELECT * FROM desktop_releases WHERE target = ? AND channel = ? AND version = ?',
    target,
    channel,
    version,
  )
}

export function listReleases(db: HubDb): ReleaseRow[] {
  return db.all<ReleaseRow>('SELECT * FROM desktop_releases ORDER BY target, channel, id DESC')
}

/** feed 选中：同 target+channel 里 id 最大（最后发布）的 published 行 */
export function latestPublishedRelease(db: HubDb, target: string, channel: string): ReleaseRow | undefined {
  return db.get<ReleaseRow>(
    `SELECT * FROM desktop_releases
      WHERE target = ? AND channel = ? AND status = 'published'
      ORDER BY id DESC LIMIT 1`,
    target,
    channel,
  )
}

/** 回滚目标：该 target+channel 里 id 比 given 小的最近一条 published */
export function previousPublishedRelease(
  db: HubDb,
  target: string,
  channel: string,
  beforeId: number,
): ReleaseRow | undefined {
  return db.get<ReleaseRow>(
    `SELECT * FROM desktop_releases
      WHERE target = ? AND channel = ? AND status = 'published' AND id < ?
      ORDER BY id DESC LIMIT 1`,
    target,
    channel,
    beforeId,
  )
}

/** 比 givenId 新的同 target+channel 行（回滚时把它们标 yanked） */
export function listNewerReleases(db: HubDb, target: string, channel: string, id: number): ReleaseRow[] {
  return db.all<ReleaseRow>(
    'SELECT * FROM desktop_releases WHERE target = ? AND channel = ? AND id > ? ORDER BY id',
    target,
    channel,
    id,
  )
}

export function setReleaseStatus(db: HubDb, id: number, status: 'published' | 'yanked'): void {
  db.run('UPDATE desktop_releases SET status = ? WHERE id = ?', status, id)
}

export function setReleasePortable(
  db: HubDb,
  id: number,
  portable: { file: string; bytes: number; sha512: string },
): void {
  db.run(
    'UPDATE desktop_releases SET portable_file = ?, portable_bytes = ?, portable_sha512 = ? WHERE id = ?',
    portable.file,
    portable.bytes,
    portable.sha512,
    id,
  )
}

export function findReleaseByInstallerFile(db: HubDb, target: string, file: string): ReleaseRow | undefined {
  return db.get<ReleaseRow>(
    `SELECT * FROM desktop_releases
      WHERE target = ? AND (installer_file = ? OR blockmap_file = ? OR portable_file = ?)`,
    target,
    file,
    file,
    file,
  )
}
