import type {
  DesktopAppChannel,
  DesktopApplyState,
  DesktopArch,
  DesktopMobilePlatform,
  DesktopPluginEntry,
  DesktopPlatform,
  DeviceKind,
} from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'

/**
 * 桌面设备域的全部 SQL（CONTRIBUTING.md 的工程约定：路由与 service 不写裸 SQL，整包 SQL 走本文件）。
 *
 * 两条纪律：
 * 1. 落库只写列（`desktop_devices` 的列就是隐私白名单），**没有 raw JSON 列**可装别的东西；
 *    唯一的 JSON 列 `capabilities_json` 由契约层 `DesktopCapabilitiesSchema` 严格校验后才写。
 * 2. 时间一律由 service 传 `deps.clock` 的 ISO 字符串进来，SQL 不调 `now()`。
 */

// ── 设备行 ──────────────────────────────────────────────────────────────────

export interface DesktopDeviceRow {
  id: number
  device_id: string
  user_id: number
  /** 'desktop' | 'mobile'（WP40a；126 迁移加列，历史行是 'desktop'） */
  kind: DeviceKind
  /** 手机平台（kind='mobile' 时有值；桌面端用 platform） */
  mobile_platform: DesktopMobilePlatform | null
  install_key: string | null
  name: string
  platform: DesktopPlatform | null
  os_major: string | null
  arch: DesktopArch | null
  app_version: string | null
  app_channel: DesktopAppChannel | null
  runtime_version: string | null
  applied_revision: number | null
  applied_at: string | null
  apply_state: DesktopApplyState
  apply_error: string | null
  apply_error_count: number | null
  capabilities_json: string | null
  registered_at: string | null
  first_seen_at: string
  last_report_at: string | null
  last_auth_at: string | null
  status: 'active' | 'revoked'
  revoked_at: string | null
  revoked_by: number | null
  revoke_reason: string | null
  relay_key_id: number | null
  created_at: string
  updated_at: string
}

export interface DesktopDeviceAdminRow extends DesktopDeviceRow {
  u_id: number
  u_slug: string
  u_username: string
  u_display_name: string
  u_avatar_file: string | null
  plugin_count: number
}

export interface InsertDeviceInput {
  deviceId: string
  userId: number
  installKey: string | null
  name: string
  /** 缺省 'desktop'（历史调用不变） */
  kind?: DeviceKind
  /** 仅 kind='mobile'：android / ios / web（web = 手机网页版，WP54a） */
  mobilePlatform?: DesktopMobilePlatform | null
  /** 桌面端字段；手机安装不提供（落库里是 NULL） */
  platform?: DesktopPlatform | null
  osMajor?: string | null
  arch?: DesktopArch | null
  appVersion?: string | null
  appChannel?: DesktopAppChannel | null
  runtimeVersion?: string | null
  capabilitiesJson: string | null
  at: string
  registeredAt: string | null
}

export function insertDevice(db: HubDb, input: InsertDeviceInput): number {
  const result = db.run(
    `INSERT INTO desktop_devices (device_id, user_id, install_key, name, kind, mobile_platform,
                                  platform, os_major, arch,
                                  app_version, app_channel, runtime_version, capabilities_json,
                                  registered_at, first_seen_at, last_auth_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.deviceId,
    input.userId,
    input.installKey,
    input.name,
    input.kind ?? 'desktop',
    input.mobilePlatform ?? null,
    input.platform ?? null,
    input.osMajor ?? null,
    input.arch ?? null,
    input.appVersion ?? null,
    input.appChannel ?? null,
    input.runtimeVersion ?? null,
    input.capabilitiesJson,
    input.registeredAt,
    input.at,
    input.at,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export function getDeviceRow(db: HubDb, deviceId: string): DesktopDeviceRow | undefined {
  return db.get<DesktopDeviceRow>('SELECT * FROM desktop_devices WHERE device_id = ?', deviceId)
}

/** 同一用户 + 同一 install_key 的**有效**设备（部分唯一索引的同款条件） */
export function findActiveDeviceByInstallKey(
  db: HubDb,
  userId: number,
  installKey: string,
): DesktopDeviceRow | undefined {
  return db.get<DesktopDeviceRow>(
    `SELECT * FROM desktop_devices
      WHERE user_id = ? AND install_key = ? AND status = 'active'`,
    userId,
    installKey,
  )
}

export function listDevicesByUser(db: HubDb, userId: number): DesktopDeviceRow[] {
  return db.all<DesktopDeviceRow>(
    'SELECT * FROM desktop_devices WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    userId,
  )
}

/** 设备数上限的计数口径：只数 active（吊销的不占额度） */
/**
 * 桌面设备数上限的计数口径：只数 `status='active'` **且 `kind='desktop'`**。
 * 手机（WP40a）有自己的上限（`MOBILE_MAX_DEVICES_PER_USER`），不能把用户的桌面名额挤掉；
 * 126 迁移之前的历史行 kind 默认就是 'desktop'，所以老库的计数不变。
 */
export function countActiveDevices(db: HubDb, userId: number): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM desktop_devices
      WHERE user_id = ? AND status = 'active' AND kind = 'desktop'`,
    userId,
  )
  return Number(row?.n ?? 0)
}

export function listActiveDevicesByUser(db: HubDb, userId: number): DesktopDeviceRow[] {
  return db.all<DesktopDeviceRow>(
    `SELECT * FROM desktop_devices WHERE user_id = ? AND status = 'active' AND kind = 'desktop'
      ORDER BY COALESCE(last_report_at, created_at) DESC, id DESC`,
    userId,
  )
}

/** 该用户有效手机设备数（WP40a 的上限计数口径） */
export function countActiveMobileDevices(db: HubDb, userId: number): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM desktop_devices
      WHERE user_id = ? AND status = 'active' AND kind = 'mobile'`,
    userId,
  )
  return Number(row?.n ?? 0)
}

/**
 * 可复用的移动设备行：同一用户 + 同一设备名 + 同一平台、且**没有任何有效令牌**。
 *
 * 登录时复用它（退出登录后重登、refresh 过期后重登不会在台账里堆垃圾）；
 * 有有效令牌的同类设备不复用 —— 两台同型号手机默认设备名一样，共用一行会互相顶掉令牌。
 */
export function findReusableMobileDevice(
  db: HubDb,
  userId: number,
  name: string,
  mobilePlatform: DesktopMobilePlatform,
  nowIso: string,
): DesktopDeviceRow | undefined {
  return db.get<DesktopDeviceRow>(
    `SELECT d.* FROM desktop_devices d
      WHERE d.user_id = ? AND d.kind = 'mobile' AND d.status = 'active'
        AND d.name = ? AND d.mobile_platform = ?
        AND NOT EXISTS (
          SELECT 1 FROM desktop_device_tokens t
           WHERE t.device_id = d.device_id AND t.revoked_at IS NULL AND t.expires_at > ?
        )
      ORDER BY d.id DESC LIMIT 1`,
    userId,
    name,
    mobilePlatform,
    nowIso,
  )
}

/**
 * 同一用户下「同名同平台」的**旧版**（没有 install_key）有效手机设备。
 *
 * 只合并旧记录：两张不同的手机恰好同名时，只要有 install_key 就永不互相合并；
 * 新版 App 的每一台手机都有自己的 install_key，天然一条记录。
 */
export function listDuplicateLegacyMobileDevices(
  db: HubDb,
  userId: number,
  keepDeviceId: string,
  name: string,
  mobilePlatform: DesktopMobilePlatform,
): DesktopDeviceRow[] {
  return db.all<DesktopDeviceRow>(
    `SELECT * FROM desktop_devices
      WHERE user_id = ? AND kind = 'mobile' AND status = 'active'
        AND device_id != ? AND name = ? AND mobile_platform = ?
        AND install_key IS NULL
      ORDER BY id ASC`,
    userId,
    keepDeviceId,
    name,
    mobilePlatform,
  )
}

/** 最老的有效手机设备（达到上限时顶掉它，而不是让用户登录失败） */
export function findOldestActiveMobileDevice(db: HubDb, userId: number): DesktopDeviceRow | undefined {
  return db.get<DesktopDeviceRow>(
    `SELECT * FROM desktop_devices
      WHERE user_id = ? AND kind = 'mobile' AND status = 'active'
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    userId,
  )
}

export interface UpdateDevicePatch {
  name?: string
  /** 手机重登时补写安装标识（老记录升级到 installId 机制） */
  installKey?: string | null
  /** 仅 kind='mobile' */
  mobilePlatform?: DesktopMobilePlatform
  appVersion?: string
  appChannel?: DesktopAppChannel
  runtimeVersion?: string | null
  appliedRevision?: number | null
  appliedAt?: string | null
  applyState?: DesktopApplyState
  applyError?: string | null
  applyErrorCount?: number | null
  capabilitiesJson?: string | null
  registeredAt?: string | null
  lastReportAt?: string | null
  lastAuthAt?: string | null
  relayKeyId?: number | null
  updatedAt?: string
}

const DEVICE_COLUMNS: Record<keyof UpdateDevicePatch, string> = {
  name: 'name',
  installKey: 'install_key',
  mobilePlatform: 'mobile_platform',
  appVersion: 'app_version',
  appChannel: 'app_channel',
  runtimeVersion: 'runtime_version',
  appliedRevision: 'applied_revision',
  appliedAt: 'applied_at',
  applyState: 'apply_state',
  applyError: 'apply_error',
  applyErrorCount: 'apply_error_count',
  capabilitiesJson: 'capabilities_json',
  registeredAt: 'registered_at',
  lastReportAt: 'last_report_at',
  lastAuthAt: 'last_auth_at',
  relayKeyId: 'relay_key_id',
  updatedAt: 'updated_at',
}

/** 动态 UPDATE：只写给出的列（心跳路径只碰 last_report_at / 应用结果几列） */
export function updateDeviceRow(db: HubDb, deviceId: string, patch: UpdateDevicePatch): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  for (const [key, column] of Object.entries(DEVICE_COLUMNS) as [keyof UpdateDevicePatch, string][]) {
    const value = patch[key]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    params.push(value as SqlParam)
  }
  if (sets.length === 0) return
  params.push(deviceId)
  db.run(`UPDATE desktop_devices SET ${sets.join(', ')} WHERE device_id = ?`, ...params)
}

export interface RevokeDeviceInput {
  deviceId: string
  at: string
  reason: string
  /** 管理员操作者；用户自助时 null */
  revokedBy: number | null
}

/** 吊销设备行（已吊销的不动，返回是否真的改了行） */
export function revokeDeviceRow(db: HubDb, input: RevokeDeviceInput): boolean {
  const res = db.run(
    `UPDATE desktop_devices
        SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ?, updated_at = ?
      WHERE device_id = ? AND status = 'active'`,
    input.at,
    input.revokedBy,
    input.reason,
    input.at,
    input.deviceId,
  )
  return res.changes > 0
}

/** 吊销某用户的全部有效设备（账号停用 / 删除 / 改密的级联），返回条数 */
export function revokeDevicesForUser(db: HubDb, userId: number, at: string, reason: string): number {
  return db.run(
    `UPDATE desktop_devices
        SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE user_id = ? AND status = 'active'`,
    at,
    reason,
    at,
    userId,
  ).changes
}

// ── 管理端列表 ──────────────────────────────────────────────────────────────

export interface AdminListFilter {
  q?: string | undefined
  /** presence 过滤的派生条件（service 已把 offlineAfterSec 换算成 cutoff） */
  presence?: 'online' | 'offline' | 'revoked' | undefined
  revoked: 'active' | 'revoked' | 'all'
  offlineCutoff: string
  userId?: number | undefined
  platform?: DesktopPlatform | undefined
  appVersion?: string | undefined
  /** 设备种类（WP56e1）：手机与桌面端共用一张表，管理端列表要能只取一类 */
  kind?: 'desktop' | 'mobile' | undefined
}

const ADMIN_SELECT = `SELECT d.*, u.id AS u_id, u.slug AS u_slug, u.username AS u_username,
                             u.display_name AS u_display_name, u.avatar_file AS u_avatar_file,
                             (SELECT COUNT(*) FROM desktop_device_plugins p
                               WHERE p.device_id = d.device_id) AS plugin_count
                        FROM desktop_devices d
                        JOIN users u ON u.id = d.user_id`

/** 管理端筛选条件（`q` 匹配用户名 / 显示名 / 设备名 / deviceId） */
function adminWhere(filter: AdminListFilter): { sql: string; params: SqlParam[] } {
  const conditions: string[] = []
  const params: SqlParam[] = []
  if (filter.revoked === 'active') conditions.push(`d.status = 'active'`)
  else if (filter.revoked === 'revoked') conditions.push(`d.status = 'revoked'`)
  switch (filter.presence) {
    case 'online':
      conditions.push(`d.status = 'active' AND d.last_report_at IS NOT NULL AND d.last_report_at >= ?`)
      params.push(filter.offlineCutoff)
      break
    case 'offline':
      conditions.push(`d.status = 'active' AND (d.last_report_at IS NULL OR d.last_report_at < ?)`)
      params.push(filter.offlineCutoff)
      break
    case 'revoked':
      conditions.push(`d.status = 'revoked'`)
      break
    default:
      break
  }
  if (filter.userId !== undefined) {
    conditions.push('d.user_id = ?')
    params.push(filter.userId)
  }
  if (filter.platform !== undefined) {
    conditions.push('d.platform = ?')
    params.push(filter.platform)
  }
  if (filter.appVersion !== undefined) {
    conditions.push('d.app_version = ?')
    params.push(filter.appVersion)
  }
  if (filter.kind !== undefined) {
    conditions.push('d.kind = ?')
    params.push(filter.kind)
  }
  if (filter.q !== undefined && filter.q.length > 0) {
    const like = `%${filter.q}%`
    conditions.push('(u.username LIKE ? OR u.display_name LIKE ? OR d.name LIKE ? OR d.device_id LIKE ?)')
    params.push(like, like, like, like)
  }
  return { sql: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`, params }
}

export function countDevicesForAdmin(db: HubDb, filter: AdminListFilter): number {
  const where = adminWhere(filter)
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM desktop_devices d JOIN users u ON u.id = d.user_id ${where.sql}`,
    ...where.params,
  )
  return Number(row?.n ?? 0)
}

export function listDevicesForAdmin(
  db: HubDb,
  filter: AdminListFilter,
  page: { limit: number; offset: number },
): DesktopDeviceAdminRow[] {
  const where = adminWhere(filter)
  return db.all<DesktopDeviceAdminRow>(
    `${ADMIN_SELECT} ${where.sql}
      ORDER BY COALESCE(d.last_report_at, d.created_at) DESC, d.id DESC
      LIMIT ? OFFSET ?`,
    ...where.params,
    page.limit,
    page.offset,
  )
}

// ── 插件清单（每次上报整表替换） ─────────────────────────────────────────────

export interface DesktopPluginRow {
  device_id: string
  package_name: string
  version: string
  source: string
  state: string
  error_code: string | null
  updated_at: string
}

export function listPlugins(db: HubDb, deviceId: string): DesktopPluginRow[] {
  return db.all<DesktopPluginRow>(
    `SELECT * FROM desktop_device_plugins WHERE device_id = ? ORDER BY package_name ASC`,
    deviceId,
  )
}

/** 管理端统计用的「事实行」：每台**有效**设备上报的插件（一次查完，不按插件循环查库） */
export interface DevicePluginFactRow {
  plugin_id: number
  package_name: string
  version: string
  source: string
  state: string
  device_id: string
  user_id: number
}

/**
 * 某插件在各设备上的上报（管理员看「已装设备数 / 用户数 / 较旧数」）：
 * 只算 `status='active'` 的设备与未删除的用户；`state='absent'`（已被移除）不算装了。
 */
export function listActiveDevicePluginFacts(db: HubDb): DevicePluginFactRow[] {
  return db.all<DevicePluginFactRow>(
    `SELECT p.id AS plugin_id, ddp.package_name, ddp.version, ddp.source, ddp.state,
            ddp.device_id, d.user_id
       FROM desktop_device_plugins ddp
       JOIN desktop_devices d ON d.device_id = ddp.device_id AND d.status = 'active'
       JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL
       JOIN plugins p ON p.package_name = ddp.package_name
      WHERE ddp.state <> 'absent'
      ORDER BY p.id ASC, ddp.device_id ASC`,
  )
}

/** 整表替换（调用方在外层事务里；上限 200 由契约层保证） */
export function replacePlugins(
  db: HubDb,
  deviceId: string,
  plugins: readonly DesktopPluginEntry[],
  at: string,
): void {
  db.run('DELETE FROM desktop_device_plugins WHERE device_id = ?', deviceId)
  for (const plugin of plugins) {
    db.run(
      `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      deviceId,
      plugin.name,
      plugin.version,
      plugin.source,
      plugin.state,
      plugin.errorCode ?? null,
      at,
    )
  }
}

export function countPlugins(db: HubDb, deviceId: string): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM desktop_device_plugins WHERE device_id = ?',
    deviceId,
  )
  return Number(row?.n ?? 0)
}

// ── 设备令牌 ────────────────────────────────────────────────────────────────

export interface DesktopTokenRow {
  id: string
  device_id: string
  user_id: number
  created_at: string
  last_used_at: string
  expires_at: string
  renewed_at: string | null
  revoked_at: string | null
  revoked_reason: string | null
  replaced_by: string | null
}

/** 令牌 + 用户 + 设备一次查全（鉴权热路径只有这一条 SQL） */
export interface DesktopAuthJoinRow {
  token_id: string
  token_created_at: string
  token_last_used_at: string
  token_expires_at: string
  token_renewed_at: string | null
  token_revoked_at: string | null
  /** 吊销原因（WP40a：手机 refresh 的重放检测要看它是 'rotated' 还是别的） */
  token_revoked_reason: string | null
  device_id: string
  device_name: string
  device_kind: DeviceKind
  device_status: string
  device_revoked_at: string | null
  user_id: number
  slug: string
  username: string
  display_name: string
  avatar_file: string | null
  role: 'user' | 'admin'
  user_status: string
  must_change_password: number
  deleted_at: string | null
}

export function findTokenJoin(db: HubDb, tokenHash: string): DesktopAuthJoinRow | undefined {
  return db.get<DesktopAuthJoinRow>(
    `SELECT t.id AS token_id, t.created_at AS token_created_at, t.last_used_at AS token_last_used_at,
            t.expires_at AS token_expires_at, t.renewed_at AS token_renewed_at,
            t.revoked_at AS token_revoked_at, t.revoked_reason AS token_revoked_reason,
            d.device_id, d.name AS device_name, d.kind AS device_kind, d.status AS device_status,
            d.revoked_at AS device_revoked_at,
            u.id AS user_id, u.slug, u.username, u.display_name, u.avatar_file, u.role,
            u.status AS user_status, u.must_change_password, u.deleted_at
       FROM desktop_device_tokens t
       JOIN desktop_devices d ON d.device_id = t.device_id
       JOIN users u ON u.id = t.user_id
      WHERE t.id = ?`,
    tokenHash,
  )
}

export interface InsertTokenInput {
  /** sha256(明文) hex */
  id: string
  deviceId: string
  userId: number
  at: string
  expiresAt: string
  ip: string | null
  userAgent: string | null
  appVersion: string | null
}

export function insertToken(db: HubDb, input: InsertTokenInput): void {
  db.run(
    `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at,
                                        ip, user_agent, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.deviceId,
    input.userId,
    input.at,
    input.at,
    input.expiresAt,
    input.ip,
    input.userAgent,
    input.appVersion,
  )
}

export function touchToken(db: HubDb, tokenId: string, at: string): void {
  db.run('UPDATE desktop_device_tokens SET last_used_at = ? WHERE id = ?', at, tokenId)
}

export function renewToken(db: HubDb, tokenId: string, at: string, expiresAt: string): void {
  db.run(
    `UPDATE desktop_device_tokens SET renewed_at = ?, expires_at = ?
      WHERE id = ? AND revoked_at IS NULL`,
    at,
    expiresAt,
    tokenId,
  )
}

export function revokeToken(
  db: HubDb,
  tokenId: string,
  at: string,
  reason: string,
  replacedBy: string | null = null,
): boolean {
  const res = db.run(
    `UPDATE desktop_device_tokens SET revoked_at = ?, revoked_reason = ?, replaced_by = ?
      WHERE id = ? AND revoked_at IS NULL`,
    at,
    reason,
    replacedBy,
    tokenId,
  )
  return res.changes > 0
}

/** 吊销某设备全部有效令牌，返回条数 */
export function revokeTokensForDevice(db: HubDb, deviceId: string, at: string, reason: string): number {
  return db.run(
    `UPDATE desktop_device_tokens SET revoked_at = ?, revoked_reason = ?
      WHERE device_id = ? AND revoked_at IS NULL`,
    at,
    reason,
    deviceId,
  ).changes
}

/** 吊销某用户全部有效令牌，返回条数 */
export function revokeTokensForUser(db: HubDb, userId: number, at: string, reason: string): number {
  return db.run(
    `UPDATE desktop_device_tokens SET revoked_at = ?, revoked_reason = ?
      WHERE user_id = ? AND revoked_at IS NULL`,
    at,
    reason,
    userId,
  ).changes
}

export function countActiveTokens(db: HubDb, userId: number, nowIso: string): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM desktop_device_tokens
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    userId,
    nowIso,
  )
  return Number(row?.n ?? 0)
}

// ── WP25e：概览计数 / 详情 / 令牌清理 ───────────────────────────────────────

export interface DeviceOverviewCounts {
  total: number
  online: number
  revoked: number
}

/**
 * 概览的桌面设备计数（WP25e 交付物 4）。`online` 与设备台账**同一个判定**：
 * `status='active'` 且 `last_report_at >= cutoff`（cutoff = now - offlineAfterSec）。
 * 返回的三个数互补：`stale = total - online - revoked`。
 */
export function countDevicesOverview(db: HubDb, offlineCutoff: string): DeviceOverviewCounts {
  const row = db.get<{ total: number; online: number | null; revoked: number | null }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' AND last_report_at IS NOT NULL AND last_report_at >= ?
                     THEN 1 ELSE 0 END) AS online,
            SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked
       FROM desktop_devices`,
    offlineCutoff,
  )
  return {
    total: Number(row?.total ?? 0),
    online: Number(row?.online ?? 0),
    revoked: Number(row?.revoked ?? 0),
  }
}

/** 管理端设备详情：设备行 + 用户摘要（与列表同一份 SELECT，避免两处字段漂移） */
export function getAdminDeviceRow(db: HubDb, deviceId: string): DesktopDeviceAdminRow | undefined {
  return db.get<DesktopDeviceAdminRow>(`${ADMIN_SELECT} WHERE d.device_id = ?`, deviceId)
}

/**
 * 清掉**已过期超过 N 天**的设备令牌行（WP25e 交付物 9）。
 *
 * 只按 `expires_at` 判定：过期的令牌本来就已经 401（resolveDeviceToken 先看 expires_at），
 * 留 30 天是为了排障时还能看到「这台设备上一次登录是什么时候」。
 * `replaced_by` 是 ON DELETE SET NULL，删旧行不会破坏轮换链的其余部分。
 */
export function deleteExpiredTokensBefore(db: HubDb, cutoff: string): number {
  return db.run('DELETE FROM desktop_device_tokens WHERE expires_at < ?', cutoff).changes
}
