import type {
  AdminPluginRow,
  PluginCard,
  PluginDesktopStats,
  PluginPlatform,
  PluginPlatformSettings,
  PluginPolicy,
  PluginSourceType,
  PluginVersion,
  UserPluginDesired,
  UserPluginRow,
  UserPluginSource,
  UserPluginState,
  UserStatus,
} from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'

/**
 * plugins 模块的 SQL（03 §1.4）。**只有这个文件写 SQL**（11 §5）。
 * 数据库列 snake_case，DTO 字段 camelCase，转换在本文件完成。
 *
 * WP32a（docs/22 §2.1）：插件按平台分库 —— 设置行在 `plugin_platforms`（每插件每平台一行），
 * 版本行的 `plugin_versions.platform` 区分云上/桌面。`plugins` 的 policy/bundle_order/config_yaml/
 * needs_restart 保留为**云上行的镜像**，只由本文件的 `syncCloudMirror` 写。
 */

export interface PluginRow {
  id: number
  package_name: string
  display_name: string
  description: string
  icon: string | null
  homepage: string | null
  policy: PluginPolicy
  is_bundle: number
  bundle_order: number
  config_yaml: string
  needs_restart: number
  created_at: string
  updated_at: string
}

export interface PluginVersionRow {
  id: number
  plugin_id: number
  /** `cloud` | `desktop`（迁移 123） */
  platform: PluginPlatform
  version: string
  source_type: PluginSourceType
  source_ref: string
  spec: string
  store_file: string | null
  sha256: string | null
  min_dsh: string | null
  created_at: string
}

/** `plugin_platforms` 的一行（某插件在某平台上的设置） */
export interface PluginPlatformRow {
  plugin_id: number
  platform: PluginPlatform
  policy: PluginPolicy
  bundle_order: number
  config_yaml: string
  needs_restart: number
  created_at: string
  updated_at: string
}

/** 某平台的库：插件身份（plugins 行）+ 该平台的设置 */
export interface PluginPlatformLibraryRow {
  plugin_id: number
  platform: PluginPlatform
  package_name: string
  display_name: string
  description: string
  icon: string | null
  homepage: string | null
  is_bundle: number
  created_at: string
  updated_at: string
  policy: PluginPolicy
  bundle_order: number
  config_yaml: string
  needs_restart: number
  platform_created_at: string
  platform_updated_at: string
}

export interface UserPluginDbRow {
  user_id: number
  plugin_id: number
  desired: UserPluginDesired
  desired_version_id: number | null
  actual_version_id: number | null
  state: UserPluginState
  source: UserPluginSource
  error: string | null
  updated_at: string
}

export interface PluginStats {
  installed: number
  pending: number
  failed: number
}

// ── 行 → DTO ────────────────────────────────────────────────────────────────

export function toPluginVersion(row: PluginVersionRow): PluginVersion {
  return {
    id: row.id,
    platform: row.platform,
    version: row.version,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    spec: row.spec,
    sha256: row.sha256,
    minDsh: row.min_dsh,
    createdAt: row.created_at,
  }
}

/** 某平台的设置行 → 契约形状 */
export function toPluginPlatformSettings(row: PluginPlatformRow): PluginPlatformSettings {
  return {
    policy: row.policy,
    bundleOrder: row.bundle_order,
    configYaml: row.config_yaml,
    needsRestart: row.needs_restart === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toPluginCard(row: PluginRow, latestVersion: string | null): PluginCard {
  return {
    id: row.id,
    packageName: row.package_name,
    displayName: row.display_name,
    description: row.description,
    icon: row.icon,
    homepage: row.homepage,
    policy: row.policy,
    isBundle: row.is_bundle === 1,
    bundleOrder: row.bundle_order,
    needsRestart: row.needs_restart === 1,
    latestVersion,
  }
}

export function toUserPluginRow(
  row: UserPluginDbRow & { plugin_package_name: string; plugin_display_name: string },
  username: string,
  actualVersion: string | null,
): UserPluginRow {
  return {
    userId: row.user_id,
    username,
    packageName: row.plugin_package_name,
    displayName: row.plugin_display_name,
    pluginId: row.plugin_id,
    desired: row.desired,
    desiredVersionId: row.desired_version_id,
    actualVersionId: row.actual_version_id,
    actualVersion,
    state: row.state,
    source: row.source,
    error: row.error,
    updatedAt: row.updated_at,
  }
}

// ── plugins ─────────────────────────────────────────────────────────────────

export function listPluginRows(db: HubDb): PluginRow[] {
  return db.all<PluginRow>('SELECT * FROM plugins ORDER BY bundle_order ASC, id ASC')
}

export function getPluginRow(db: HubDb, pluginId: number): PluginRow | undefined {
  return db.get<PluginRow>('SELECT * FROM plugins WHERE id = ?', pluginId)
}

export function getPluginRowByPackage(db: HubDb, packageName: string): PluginRow | undefined {
  return db.get<PluginRow>('SELECT * FROM plugins WHERE package_name = ?', packageName)
}

export function requirePluginRow(db: HubDb, pluginId: number): PluginRow {
  const row = getPluginRow(db, pluginId)
  if (!row) throw new PluginNotFoundError(pluginId)
  return row
}

/** 用业务错误类而不是 HubError：repo 层不依赖 HTTP 语义，由 service 翻译 */
export class PluginNotFoundError extends Error {
  constructor(readonly pluginId: number) {
    super(`插件不存在：${String(pluginId)}`)
  }
}

export class PluginVersionNotFoundError extends Error {
  constructor(readonly versionId: number) {
    super(`插件版本不存在：${String(versionId)}`)
  }
}

export interface InsertPluginInput {
  packageName: string
  displayName: string
  description: string
  icon: string | null
  homepage: string | null
  policy: PluginPolicy
  isBundle: boolean
  bundleOrder: number
  configYaml: string
  needsRestart: boolean
  at: string
}

export function insertPluginRow(db: HubDb, input: InsertPluginInput): number {
  const result = db.run(
    `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                          is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.packageName,
    input.displayName,
    input.description,
    input.icon,
    input.homepage,
    input.policy,
    input.isBundle ? 1 : 0,
    input.bundleOrder,
    input.configYaml,
    input.needsRestart ? 1 : 0,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdatePluginInput {
  displayName?: string
  description?: string
  icon?: string | null
  homepage?: string | null
  policy?: PluginPolicy
  isBundle?: boolean
  bundleOrder?: number
  configYaml?: string
  needsRestart?: boolean
}

export function updatePluginRow(db: HubDb, pluginId: number, patch: UpdatePluginInput, at: string): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.displayName !== undefined) push('display_name', patch.displayName)
  if (patch.description !== undefined) push('description', patch.description)
  if (patch.icon !== undefined) push('icon', patch.icon)
  if (patch.homepage !== undefined) push('homepage', patch.homepage)
  if (patch.policy !== undefined) push('policy', patch.policy)
  if (patch.isBundle !== undefined) push('is_bundle', patch.isBundle ? 1 : 0)
  if (patch.bundleOrder !== undefined) push('bundle_order', patch.bundleOrder)
  if (patch.configYaml !== undefined) push('config_yaml', patch.configYaml)
  if (patch.needsRestart !== undefined) push('needs_restart', patch.needsRestart ? 1 : 0)
  push('updated_at', at)
  db.run(`UPDATE plugins SET ${sets.join(', ')} WHERE id = ?`, ...params, pluginId)
}

export function deletePluginRow(db: HubDb, pluginId: number): void {
  db.run('DELETE FROM plugins WHERE id = ?', pluginId)
}

// ── plugin_platforms（每个插件在每个平台上的设置，迁移 123）──────────────────

/**
 * 某平台库的行。**云上**额外包含「一个平台行都没有」的插件（迁移前手写进库的数据、或别的模块直接 insert 的插件）：
 * 这类插件在迁移后的真实库里不会出现，但让云上列表兜住它们，旧行为（目录 = 全量插件）才不会因为一次重构而断。
 * 桌面侧仍然严格「有行 ⇔ 在库里」。
 */
const LIBRARY_SELECT = `
  SELECT p.id AS plugin_id, COALESCE(pp.platform, ?) AS platform,
         p.package_name, p.display_name, p.description, p.icon, p.homepage, p.is_bundle,
         p.created_at, p.updated_at,
         COALESCE(pp.policy, p.policy) AS policy,
         COALESCE(pp.bundle_order, p.bundle_order) AS bundle_order,
         COALESCE(pp.config_yaml, p.config_yaml) AS config_yaml,
         COALESCE(pp.needs_restart, p.needs_restart) AS needs_restart,
         COALESCE(pp.created_at, p.created_at) AS platform_created_at,
         COALESCE(pp.updated_at, p.updated_at) AS platform_updated_at
    FROM plugins p
    LEFT JOIN plugin_platforms pp ON pp.plugin_id = p.id AND pp.platform = ?
   WHERE (pp.plugin_id IS NOT NULL
          OR (? = 'cloud' AND NOT EXISTS (SELECT 1 FROM plugin_platforms x WHERE x.plugin_id = p.id)))`

/** 某个平台库里的全部插件（按该平台的 bundle_order 排序） */
export function listPlatformLibraryRows(db: HubDb, platform: PluginPlatform): PluginPlatformLibraryRow[] {
  return db.all<PluginPlatformLibraryRow>(
    `${LIBRARY_SELECT} ORDER BY bundle_order ASC, p.id ASC`,
    platform,
    platform,
    platform,
  )
}

export function getPlatformLibraryRow(
  db: HubDb,
  pluginId: number,
  platform: PluginPlatform,
): PluginPlatformLibraryRow | undefined {
  return db.get<PluginPlatformLibraryRow>(`${LIBRARY_SELECT} AND p.id = ?`, platform, platform, platform, pluginId)
}

export function getPluginPlatformRow(db: HubDb, pluginId: number, platform: PluginPlatform): PluginPlatformRow | undefined {
  return db.get<PluginPlatformRow>('SELECT * FROM plugin_platforms WHERE plugin_id = ? AND platform = ?', pluginId, platform)
}

/** 该插件出现在哪些平台的库里 */
export function listPluginPlatformRows(db: HubDb, pluginId: number): PluginPlatformRow[] {
  return db.all<PluginPlatformRow>(
    'SELECT * FROM plugin_platforms WHERE plugin_id = ? ORDER BY platform',
    pluginId,
  )
}

export interface InsertPluginPlatformInput {
  pluginId: number
  platform: PluginPlatform
  policy: PluginPolicy
  bundleOrder: number
  configYaml: string
  needsRestart: boolean
  at: string
}

export function insertPluginPlatformRow(db: HubDb, input: InsertPluginPlatformInput): void {
  db.run(
    `INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.pluginId,
    input.platform,
    input.policy,
    input.bundleOrder,
    input.configYaml,
    input.needsRestart ? 1 : 0,
    input.at,
    input.at,
  )
}

export interface UpdatePluginPlatformInput {
  policy?: PluginPolicy
  bundleOrder?: number
  configYaml?: string
  needsRestart?: boolean
}

export function updatePluginPlatformRow(
  db: HubDb,
  pluginId: number,
  platform: PluginPlatform,
  patch: UpdatePluginPlatformInput,
  at: string,
): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.policy !== undefined) push('policy', patch.policy)
  if (patch.bundleOrder !== undefined) push('bundle_order', patch.bundleOrder)
  if (patch.configYaml !== undefined) push('config_yaml', patch.configYaml)
  if (patch.needsRestart !== undefined) push('needs_restart', patch.needsRestart ? 1 : 0)
  push('updated_at', at)
  db.run(
    `UPDATE plugin_platforms SET ${sets.join(', ')} WHERE plugin_id = ? AND platform = ?`,
    ...params,
    pluginId,
    platform,
  )
}

export function deletePluginPlatformRow(db: HubDb, pluginId: number, platform: PluginPlatform): number {
  return db.run('DELETE FROM plugin_platforms WHERE plugin_id = ? AND platform = ?', pluginId, platform).changes
}

/**
 * `plugins` 的 policy/bundle_order/config_yaml/needs_restart 是**云上行的镜像**（旧代码读它不出错）。
 * 任何写云上平台设置的地方都必须调它，保证旧接口（安装器按 policy 捞插件、按 bundle_order 排序）看到的是同一份。
 */
export function syncCloudMirror(db: HubDb, pluginId: number, at: string): void {
  db.run(
    `UPDATE plugins SET
       policy = COALESCE((SELECT policy FROM plugin_platforms WHERE plugin_id = ? AND platform = 'cloud'), policy),
       bundle_order = COALESCE((SELECT bundle_order FROM plugin_platforms WHERE plugin_id = ? AND platform = 'cloud'), bundle_order),
       config_yaml = COALESCE((SELECT config_yaml FROM plugin_platforms WHERE plugin_id = ? AND platform = 'cloud'), config_yaml),
       needs_restart = COALESCE((SELECT needs_restart FROM plugin_platforms WHERE plugin_id = ? AND platform = 'cloud'), needs_restart),
       updated_at = ?
     WHERE id = ?`,
    pluginId,
    pluginId,
    pluginId,
    pluginId,
    at,
    pluginId,
  )
}

// ── plugin_versions ─────────────────────────────────────────────────────────

export function listVersionRows(db: HubDb, pluginId: number, platform: PluginPlatform = 'cloud'): PluginVersionRow[] {
  return db.all<PluginVersionRow>(
    'SELECT * FROM plugin_versions WHERE plugin_id = ? AND platform = ? ORDER BY id DESC',
    pluginId,
    platform,
  )
}

export function getVersionRow(db: HubDb, versionId: number): PluginVersionRow | undefined {
  return db.get<PluginVersionRow>('SELECT * FROM plugin_versions WHERE id = ?', versionId)
}

/** 同一插件在两个平台可能有同名版本 —— 按平台查才不会串 */
export function getVersionRowByVersion(
  db: HubDb,
  pluginId: number,
  version: string,
  platform: PluginPlatform = 'cloud',
): PluginVersionRow | undefined {
  return db.get<PluginVersionRow>(
    'SELECT * FROM plugin_versions WHERE plugin_id = ? AND platform = ? AND version = ?',
    pluginId,
    platform,
    version,
  )
}

/** 最新版本（按 id 倒序，目录里的插入顺序即「后加的更新」） */
export function latestVersionRow(
  db: HubDb,
  pluginId: number,
  platform: PluginPlatform = 'cloud',
): PluginVersionRow | undefined {
  return db.get<PluginVersionRow>(
    'SELECT * FROM plugin_versions WHERE plugin_id = ? AND platform = ? ORDER BY id DESC LIMIT 1',
    pluginId,
    platform,
  )
}

export interface InsertVersionInput {
  pluginId: number
  version: string
  sourceType: PluginSourceType
  sourceRef: string
  spec: string
  storeFile: string | null
  sha256: string | null
  minDsh: string | null
  at: string
  /** 缺省云上（旧调用不变） */
  platform?: PluginPlatform
}

export function insertVersionRow(db: HubDb, input: InsertVersionInput): number {
  const result = db.run(
    `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.pluginId,
    input.platform ?? 'cloud',
    input.version,
    input.sourceType,
    input.sourceRef,
    input.spec,
    input.storeFile,
    input.sha256,
    input.minDsh,
    input.at,
  )
  return result.lastInsertRowid
}

export function deleteVersionRow(db: HubDb, versionId: number): void {
  db.run('DELETE FROM plugin_versions WHERE id = ?', versionId)
}

export function countVersionUsers(db: HubDb, versionId: number): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM user_plugins
      WHERE desired_version_id = ? OR actual_version_id = ?`,
    versionId,
    versionId,
  )
  return Number(row?.n ?? 0)
}

// ── user_plugins ────────────────────────────────────────────────────────────

export function getUserPluginRow(db: HubDb, userId: number, pluginId: number): UserPluginDbRow | undefined {
  return db.get<UserPluginDbRow>(
    'SELECT * FROM user_plugins WHERE user_id = ? AND plugin_id = ?',
    userId,
    pluginId,
  )
}

type UserPluginJoinRow = UserPluginDbRow & {
  actual_version: string | null
  plugin_package_name: string
  plugin_display_name: string
}

export function listUserPluginRows(db: HubDb, userId: number): UserPluginJoinRow[] {
  return db.all<UserPluginJoinRow>(
    `SELECT up.*, pv.version AS actual_version,
            p.package_name AS plugin_package_name, p.display_name AS plugin_display_name
       FROM user_plugins up
       JOIN plugins p ON p.id = up.plugin_id
       LEFT JOIN plugin_versions pv ON pv.id = up.actual_version_id
      WHERE up.user_id = ?
      ORDER BY up.plugin_id ASC`,
    userId,
  )
}

/**
 * 04 §10.1：某插件的**全量未删除用户**矩阵（`row=null` = 从未安装过该插件）。
 * 管理端「插件详情 → 用户」列表与下发向导的目标选择都用它。
 */
export interface MatrixUserRow {
  id: number
  slug: string
  username: string
  display_name: string
  avatar_file: string | null
  status: UserStatus
}

export function listPluginUserMatrix(
  db: HubDb,
  pluginId: number,
): { user: MatrixUserRow; row: UserPluginJoinRow | null }[] {
  const users = db.all<MatrixUserRow>(
    `SELECT id, slug, username, display_name, avatar_file, status
       FROM users WHERE deleted_at IS NULL AND is_system = 0 ORDER BY username ASC`,
  )
  const rows = db.all<UserPluginJoinRow>(
    `SELECT up.*, pv.version AS actual_version,
            p.package_name AS plugin_package_name, p.display_name AS plugin_display_name
       FROM user_plugins up
       JOIN plugins p ON p.id = up.plugin_id
       LEFT JOIN plugin_versions pv ON pv.id = up.actual_version_id
      WHERE up.plugin_id = ?`,
    pluginId,
  )
  const byUser = new Map(rows.map((row) => [row.user_id, row]))
  return users.map((user) => ({ user, row: byUser.get(user.id) ?? null }))
}

export function listUserPluginRowsByPlugin(
  db: HubDb,
  pluginId: number,
): (UserPluginDbRow & {
  username: string
  actual_version: string | null
  plugin_package_name: string
  plugin_display_name: string
})[] {
  return db.all<
    UserPluginDbRow & {
      username: string
      actual_version: string | null
      plugin_package_name: string
      plugin_display_name: string
    }
  >(
    `SELECT up.*, u.username AS username, pv.version AS actual_version,
            p.package_name AS plugin_package_name, p.display_name AS plugin_display_name
       FROM user_plugins up
       JOIN users u ON u.id = up.user_id
       JOIN plugins p ON p.id = up.plugin_id
       LEFT JOIN plugin_versions pv ON pv.id = up.actual_version_id
      WHERE up.plugin_id = ?
      ORDER BY u.username ASC`,
    pluginId,
  )
}

export interface UpsertUserPluginInput {
  userId: number
  pluginId: number
  desired: UserPluginDesired
  desiredVersionId: number | null
  actualVersionId: number | null
  state: UserPluginState
  source: UserPluginSource
  error: string | null
  at: string
}
/** 期望状态 + 实际状态一起写（rollout 写期望，installer 成功后写实际） */
export function upsertUserPluginRow(db: HubDb, input: UpsertUserPluginInput): void {
  db.run(
    `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, plugin_id) DO UPDATE SET
       desired = excluded.desired,
       desired_version_id = excluded.desired_version_id,
       actual_version_id = excluded.actual_version_id,
       state = excluded.state,
       source = excluded.source,
       error = excluded.error,
       updated_at = excluded.updated_at`,
    input.userId,
    input.pluginId,
    input.desired,
    input.desiredVersionId,
    input.actualVersionId,
    input.state,
    input.source,
    input.error,
    input.at,
  )
}

/** 只写实际状态（安装成功后/轻量对账标 pending 时调用）：期望值不动 */
export function setUserPluginActual(
  db: HubDb,
  userId: number,
  pluginId: number,
  actualVersionId: number | null,
  state: UserPluginState,
  error: string | null,
  at: string,
): void {
  db.run(
    `UPDATE user_plugins SET actual_version_id = ?, state = ?, error = ?, updated_at = ?
      WHERE user_id = ? AND plugin_id = ?`,
    actualVersionId,
    state,
    error,
    at,
    userId,
    pluginId,
  )
}

export function listPluginStats(db: HubDb, pluginId: number): PluginStats {
  const row = db.get<{ installed: number; pending: number; failed: number }>(
    `SELECT
       SUM(CASE WHEN desired = 'installed' AND state = 'synced' THEN 1 ELSE 0 END) AS installed,
       SUM(CASE WHEN desired = 'installed' AND state = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM user_plugins WHERE plugin_id = ?`,
    pluginId,
  )
  return {
    installed: Number(row?.installed ?? 0),
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
  }
}

/** 还有用户在期望/实际使用该插件的数量（删除插件、删除版本时用） */
export function countPluginUsers(db: HubDb, pluginId: number): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM user_plugins
      WHERE plugin_id = ? AND (desired = 'installed' OR actual_version_id IS NOT NULL)`,
    pluginId,
  )
  return Number(row?.n ?? 0)
}
export interface DesiredPluginJoinRow extends UserPluginDbRow {
  plugin_package_name: string
  plugin_policy: PluginPolicy
  plugin_bundle_order: number
  plugin_is_bundle: number
  plugin_needs_restart: number
  desired_version: string | null
  actual_version: string | null
}

export function listDesiredPluginsForUser(db: HubDb, userId: number): DesiredPluginJoinRow[] {
  return db.all<DesiredPluginJoinRow>(
    `SELECT up.user_id, up.plugin_id, up.desired, up.desired_version_id, up.actual_version_id,
            up.state, up.source, up.error, up.updated_at,
            p.package_name AS plugin_package_name, p.policy AS plugin_policy,
            p.bundle_order AS plugin_bundle_order, p.is_bundle AS plugin_is_bundle,
            p.needs_restart AS plugin_needs_restart,
            dv.version AS desired_version, av.version AS actual_version
       FROM user_plugins up
       JOIN plugins p ON p.id = up.plugin_id
       LEFT JOIN plugin_versions dv ON dv.id = up.desired_version_id
       LEFT JOIN plugin_versions av ON av.id = up.actual_version_id
      WHERE up.user_id = ? AND up.desired = 'installed'
      ORDER BY p.bundle_order ASC, p.id ASC`,
    userId,
  )
}

/** 某用户已安装（实际）的插件 + 配置片段，按 bundle_order 排序（渲染 managed.patch.yml 用） */
export interface InstalledPluginConfigRow {
  plugin_id: number
  package_name: string
  bundle_order: number
  config_yaml: string
  version: string | null
}

export function listInstalledPluginConfigs(db: HubDb, userId: number): InstalledPluginConfigRow[] {
  return db.all<InstalledPluginConfigRow>(
    `SELECT p.id AS plugin_id, p.package_name AS package_name, p.bundle_order AS bundle_order,
            p.config_yaml AS config_yaml, av.version AS version
       FROM user_plugins up
       JOIN plugins p ON p.id = up.plugin_id
       LEFT JOIN plugin_versions av ON av.id = up.actual_version_id
      WHERE up.user_id = ? AND up.actual_version_id IS NOT NULL AND p.config_yaml <> ''
      ORDER BY p.bundle_order ASC, p.id ASC`,
    userId,
  )
}
export function toAdminPluginRow(
  plugin: PluginRow,
  versions: PluginVersionRow[],
  stats: PluginStats,
  opts: {
    platform?: PluginPlatform
    platforms?: Partial<Record<PluginPlatform, PluginPlatformSettings>>
    /** 只在桌面视图给：桌面侧的已装设备数 / 用户数 / 较旧数 / 内置设备数 */
    desktopStats?: PluginDesktopStats
  } = {},
): AdminPluginRow {
  const latest = versions[0]?.version ?? null
  return {
    ...toPluginCard(plugin, latest),
    platform: opts.platform ?? 'cloud',
    configYaml: plugin.config_yaml,
    versions: versions.map(toPluginVersion),
    stats,
    platforms: opts.platforms ?? {},
    ...(opts.desktopStats === undefined ? {} : { desktopStats: opts.desktopStats }),
  }
}

/** 某平台的库行 → AdminPluginRow 用的「插件身份」投影（policy 等来自该平台的设置） */
export function toPluginRowOfLibrary(row: PluginPlatformLibraryRow): PluginRow {
  return {
    id: row.plugin_id,
    package_name: row.package_name,
    display_name: row.display_name,
    description: row.description,
    icon: row.icon,
    homepage: row.homepage,
    policy: row.policy,
    is_bundle: row.is_bundle,
    bundle_order: row.bundle_order,
    config_yaml: row.config_yaml,
    needs_restart: row.needs_restart,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── users（只读；跨模块的表，插件模块只取自己需要的列） ─────────────────────

export interface UserRefRow {
  id: number
  slug: string
  username: string
  role: string
  status: string
  deleted_at: string | null
  runtime_id: number | null
  model_preset_id: number | null
  model_policy: string
}

export function getUserRefRow(db: HubDb, userId: number): UserRefRow | undefined {
  return db.get<UserRefRow>(
    `SELECT id, slug, username, role, status, deleted_at, runtime_id, model_preset_id, model_policy
       FROM users WHERE id = ?`,
    userId,
  )
}
