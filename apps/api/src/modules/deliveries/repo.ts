import type { UserStatus } from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'
import type { TargetUserRow } from '../rollouts/repo.js'

/**
 * 统一下发（WP28a / docs/21）的 SQL 层。**只做查询**：期望状态与发布日志的写入全部复用
 * `modules/desktop-delivery/repo.ts` 与 `modules/{plugins,runtimes,models}` 的既有函数
 * （CONTRIBUTING.md 的工程约定 的模块边界：别人拥有的表不在这里写）。
 *
 * 三个来源：
 * 1. 实例侧的目标用户 = `modules/rollouts/repo.ts` 的 `resolveTargetUserRows`（同一份解析，不复制）；
 * 2. 「已安装用户」= `user_plugins`（实例）与 `desktop_device_plugins`（桌面，设备上报）；
 * 3. 桌面设备台账 = `modules/desktop` 的表（本模块只读）。
 */

// ── 实例侧 ──────────────────────────────────────────────────────────────────

/** 一个用户的插件状态（`user_plugins` 的单行投影） */
export interface UserPluginStateRow {
  user_id: number
  desired: string
  desired_version_id: number | null
  actual_version_id: number | null
}

/** 某插件全部用户的状态（一次查询，调用方用 Map 合并进目标行） */
export function listUserPluginStates(db: HubDb, pluginId: number): UserPluginStateRow[] {
  return db.all<UserPluginStateRow>(
    `SELECT user_id, desired, desired_version_id, actual_version_id
       FROM user_plugins WHERE plugin_id = ?`,
    pluginId,
  )
}

export interface InstalledPluginUserRow extends TargetUserRow {
  desired: string
  desired_version_id: number | null
  actual_version_id: number | null
}

/**
 * 实例侧「已安装某插件」的用户：`user_plugins.desired = 'installed'`（docs/21 §2 的原文口径），
 * 排除已软删的用户。排序按 id（金丝雀排序在执行时由 rollouts 服务负责）。
 */
export function listUsersWithPluginInstalled(db: HubDb, pluginId: number): InstalledPluginUserRow[] {
  return db.all<InstalledPluginUserRow>(
    `SELECT u.id, u.slug, u.username, u.role, u.status, u.runtime_id, u.model_preset_id, u.model_policy,
            i.last_active_at AS last_active_at, u.last_login_at AS last_login_at,
            up.desired, up.desired_version_id, up.actual_version_id
       FROM user_plugins up
       JOIN users u ON u.id = up.user_id
       LEFT JOIN instances i ON i.user_id = u.id
      WHERE up.plugin_id = ? AND up.desired = 'installed' AND u.deleted_at IS NULL
      ORDER BY u.id`,
    pluginId,
  )
}

/** 版本 id → 版本号（预览里展示 `0.2.0` 用；一次查完，不按用户循环） */
export function listVersionLabels(db: HubDb, versionIds: number[]): Map<number, string> {
  const ids = [...new Set(versionIds.filter((id) => Number.isInteger(id) && id > 0))]
  const labels = new Map<number, string>()
  if (ids.length === 0) return labels
  const rows = db.all<{ id: number; version: string }>(
    `SELECT id, version FROM plugin_versions WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ...ids,
  )
  for (const row of rows) labels.set(row.id, row.version)
  return labels
}

/** 插件版本行（预览/校验用）；`platform` 见 docs/22 §2.1 */
export interface DeliveryVersionRow {
  id: number
  plugin_id: number
  platform: 'cloud' | 'desktop'
  version: string
  min_dsh: string | null
}

export function getDeliveryVersionRow(db: HubDb, versionId: number): DeliveryVersionRow | undefined {
  return db.get<DeliveryVersionRow>(
    'SELECT id, plugin_id, platform, version, min_dsh FROM plugin_versions WHERE id = ?',
    versionId,
  )
}

/** 「最新版本」与 rollouts 同一个口径：**该平台**里 id 最大（插入顺序） */
export function getLatestDeliveryVersionRow(
  db: HubDb,
  pluginId: number,
  platform: 'cloud' | 'desktop' = 'cloud',
): DeliveryVersionRow | undefined {
  return db.get<DeliveryVersionRow>(
    `SELECT id, plugin_id, platform, version, min_dsh FROM plugin_versions
      WHERE plugin_id = ? AND platform = ? ORDER BY id DESC LIMIT 1`,
    pluginId,
    platform,
  )
}

/** 同插件同版本号在另一个平台的那一行（内容项给了另一个平台的版本 id 时用） */
export function findVersionRowOfPlatform(
  db: HubDb,
  pluginId: number,
  version: string,
  platform: 'cloud' | 'desktop',
): DeliveryVersionRow | undefined {
  return db.get<DeliveryVersionRow>(
    `SELECT id, plugin_id, platform, version, min_dsh FROM plugin_versions
      WHERE plugin_id = ? AND version = ? AND platform = ?`,
    pluginId,
    version,
    platform,
  )
}

/** DSH 版本行（实例侧 runtime 内容项与 minDsh 兼容性预检用） */
export interface DeliveryRuntimeRow {
  id: number
  dsh_version: string
  status: string
  is_default: number
}

export function getDeliveryRuntimeRow(db: HubDb, runtimeId: number): DeliveryRuntimeRow | undefined {
  return db.get<DeliveryRuntimeRow>(
    'SELECT id, dsh_version, status, is_default FROM runtimes WHERE id = ?',
    runtimeId,
  )
}

/** 全部 DSH 版本（一次性拿 id → 版本号，避免按用户循环） */
export function listDeliveryRuntimeRows(db: HubDb): DeliveryRuntimeRow[] {
  return db.all<DeliveryRuntimeRow>('SELECT id, dsh_version, status, is_default FROM runtimes ORDER BY id')
}

/** 插件的桌面整包（`desktop_plugin_artifacts`）：有 = 设备能取到件 */
export function hasDesktopArtifact(db: HubDb, versionId: number): boolean {
  const row = db.get<{ version_id: number }>(
    'SELECT version_id FROM desktop_plugin_artifacts WHERE version_id = ?',
    versionId,
  )
  return row !== undefined
}

/** 插件当前的全部桌面受管条目（判断「已经是这个目标版本了」与统计整包） */
export interface DesktopPluginTargetRowLite {
  plugin_id: number
  version_id: number
  scope: string
  role: string
  user_id: number | null
}

export function listDesktopPluginTargetRows(db: HubDb, pluginId: number): DesktopPluginTargetRowLite[] {
  return db.all<DesktopPluginTargetRowLite>(
    `SELECT plugin_id, version_id, scope, role, user_id
       FROM desktop_plugin_targets WHERE plugin_id = ?`,
    pluginId,
  )
}

// ── 桌面侧：设备台账 ────────────────────────────────────────────────────────

export interface DesktopDeviceTargetRow {
  user_id: number
  username: string
  role: string
  user_status: UserStatus
  device_id: string
  device_name: string
  device_status: 'active' | 'revoked'
  /** 该设备上报的插件版本（`packageName` 不给时为 null） */
  plugin_version: string | null
  plugin_state: string | null
}

export interface DesktopDeviceQuery {
  /** 只取这些用户（`users` 目标） */
  userIds?: number[]
  /** 只取这个角色（`role` 目标） */
  role?: 'user' | 'admin'
  /** 是否连已吊销的设备一起取（只有显式点名的 `users` 目标才需要，用来给「设备已吊销」的行） */
  includeRevoked?: boolean
  /** 给了就只取「上报里有这个包且状态不是 absent」的设备（`installed` 目标） */
  installedPackageName?: string | null
  /** 给了就左连这个包的上报版本（预览 current 用） */
  packageName?: string | null
}

/**
 * 桌面目标设备：一台设备一行，join 用户拿 username / role / status。
 * **默认只取 active 设备**（已吊销的不进目标）；`users` 目标显式点名时才连吊销的一起取。
 */
export function listDesktopDevices(db: HubDb, query: DesktopDeviceQuery): DesktopDeviceTargetRow[] {
  const where: string[] = ['u.deleted_at IS NULL']
  const args: SqlParam[] = [query.packageName ?? '']
  if (!query.includeRevoked) where.push("d.status = 'active'")
  if (query.userIds !== undefined) {
    if (query.userIds.length === 0) return []
    where.push(`d.user_id IN (${query.userIds.map(() => '?').join(', ')})`)
    args.push(...query.userIds)
  }
  if (query.role !== undefined) {
    where.push('u.role = ?')
    args.push(query.role)
  }
  if (query.installedPackageName !== undefined && query.installedPackageName !== null) {
    where.push("ddp.package_name IS NOT NULL AND ddp.state <> 'absent'")
  }
  return db.all<DesktopDeviceTargetRow>(
    `SELECT d.user_id, u.username, u.role, u.status AS user_status,
            d.device_id, d.name AS device_name, d.status AS device_status,
            ddp.version AS plugin_version, ddp.state AS plugin_state
       FROM desktop_devices d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN desktop_device_plugins ddp
              ON ddp.device_id = d.device_id AND ddp.package_name = ?
      WHERE ${where.join(' AND ')}
      ORDER BY d.user_id ASC, d.id ASC`,
    ...args,
  )
}

/** 指定用户在桌面侧「已登录的有效设备」的去重用户 id（`installed` + `models` 用） */
export function listDesktopUsersWithActiveDevices(
  db: HubDb,
  query: { userIds?: number[]; role?: 'user' | 'admin' },
): number[] {
  const where: string[] = ["d.status = 'active'", 'u.deleted_at IS NULL']
  const args: SqlParam[] = []
  if (query.userIds !== undefined) {
    if (query.userIds.length === 0) return []
    where.push(`d.user_id IN (${query.userIds.map(() => '?').join(', ')})`)
    args.push(...query.userIds)
  }
  if (query.role !== undefined) {
    where.push('u.role = ?')
    args.push(query.role)
  }
  const rows = db.all<{ user_id: number }>(
    `SELECT DISTINCT d.user_id
       FROM desktop_devices d JOIN users u ON u.id = d.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.user_id`,
    ...args,
  )
  return rows.map((row) => row.user_id)
}

// ── 安装统计（交付物 4：一条 SQL，不按插件循环）─────────────────────────────

/**
 * 安装统计的「事实行」：`side='instance'` 是用户的期望/实际安装，`side='desktop'` 是设备上报的清单。
 * 一条 UNION ALL 把两侧展开成 (插件, 版本, 用户, 设备) 行，聚合放到 JS 里做
 * （`outdated` 要按 semver 比较，SQLite 没有 semver 函数；这样也避免了 N+1）。
 */
export interface InstallFactRow {
  plugin_id: number
  package_name: string
  /** 云上最新版本（instance 侧的「旧」按它算） */
  latest_version_id: number | null
  latest_version: string | null
  /** 桌面最新版本（desktop 侧的「旧」按它算；两平台版本独立，docs/22 §2.1） */
  desktop_latest_version: string | null
  side: 'instance' | 'desktop'
  version: string | null
  user_id: number | null
  device_id: string | null
  /** 桌面侧：设备上报的来源（`bundled` = 客户端自带，docs/22 §4.2）；实例侧恒 null */
  source: string | null
}

export function listInstallFacts(db: HubDb): InstallFactRow[] {
  return db.all<InstallFactRow>(
    `SELECT p.id AS plugin_id, p.package_name,
            lv.id AS latest_version_id, lv.version AS latest_version,
            dlv.version AS desktop_latest_version,
            f.side AS side, f.version AS version, f.user_id AS user_id, f.device_id AS device_id,
            f.source AS source
       FROM plugins p
       LEFT JOIN (SELECT plugin_id, MAX(id) AS id FROM plugin_versions WHERE platform = 'cloud' GROUP BY plugin_id) l
              ON l.plugin_id = p.id
       LEFT JOIN plugin_versions lv ON lv.id = l.id
       LEFT JOIN (SELECT plugin_id, MAX(id) AS id FROM plugin_versions WHERE platform = 'desktop' GROUP BY plugin_id) dl
              ON dl.plugin_id = p.id
       LEFT JOIN plugin_versions dlv ON dlv.id = dl.id
       LEFT JOIN (
             SELECT up.plugin_id AS plugin_id, 'instance' AS side,
                    v.version AS version, up.user_id AS user_id, NULL AS device_id, NULL AS source
               FROM user_plugins up
               JOIN users u ON u.id = up.user_id AND u.deleted_at IS NULL
               LEFT JOIN plugin_versions v
                      ON v.id = COALESCE(up.actual_version_id, up.desired_version_id)
              WHERE up.desired = 'installed'
             UNION ALL
             SELECT p2.id, 'desktop', ddp.version, d.user_id, ddp.device_id, ddp.source
               FROM desktop_device_plugins ddp
               JOIN desktop_devices d
                 ON d.device_id = ddp.device_id AND d.status = 'active'
               JOIN users u2 ON u2.id = d.user_id AND u2.deleted_at IS NULL
               JOIN plugins p2 ON p2.package_name = ddp.package_name
              WHERE ddp.state <> 'absent'
       ) f ON f.plugin_id = p.id
      ORDER BY p.id ASC, f.user_id ASC`,
  )
}
