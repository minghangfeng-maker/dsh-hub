import type { PluginPolicy, UserStatus } from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'
import { parseProviderIds, setUserPreset } from '../models/repo.js'
import { upsertUserPluginRow } from '../plugins/repo.js'
import { setUserRuntime } from '../runtimes/repo.js'

/**
 * rollouts 模块的 SQL（06 §5.1）。目标解析要同时看 `users` 与 `instances.last_active_at`
 * （金丝雀排序：管理员自己 + 最近活跃用户排前面），写期望状态则复用各模块 repo 的函数。
 */

export interface TargetUserRow {
  id: number
  slug: string
  username: string
  role: string
  status: UserStatus
  runtime_id: number | null
  model_preset_id: number | null
  model_policy: string
  last_active_at: string | null
  last_login_at: string | null
}

export interface TargetFilter {
  status?: UserStatus
  runtimeId?: number
  presetId?: number
  pluginId?: number
  /**
   * 按角色过滤（WP28a 统一下发的 `targets.mode='role'` 复用同一份解析）。
   * 加法字段：既有调用点都不传，行为一字不变。
   */
  role?: 'user' | 'admin'
}

/**
 * 解析目标用户（排除已删除，含 disabled；金丝雀排序：actor 自己 → 管理员 → 最近活跃 → id）。
 * `filter.pluginId` 只保留「期望安装或实际已安装」该插件的用户。
 */
export function resolveTargetUserRows(
  db: HubDb,
  targets: { all: true } | { userIds: number[] } | { filter: TargetFilter },
  actorId: number | null,
): TargetUserRow[] {
  // 系统账号（hub-ops）不参与「下发给所有用户」（docs/24 §3.5：不占名额、不扣积分）
  const where: string[] = ['u.deleted_at IS NULL', 'u.is_system = 0']
  const args: SqlParam[] = []
  let joinPlugin = ''

  if ('userIds' in targets) {
    if (targets.userIds.length === 0) return []
    where.push(`u.id IN (${targets.userIds.map(() => '?').join(', ')})`)
    args.push(...targets.userIds)
  } else if ('filter' in targets) {
    const filter = targets.filter
    if (filter.status) {
      where.push('u.status = ?')
      args.push(filter.status)
    }
    if (filter.runtimeId !== undefined) {
      where.push('u.runtime_id = ?')
      args.push(filter.runtimeId)
    }
    if (filter.presetId !== undefined) {
      where.push('u.model_preset_id = ?')
      args.push(filter.presetId)
    }
    if (filter.role !== undefined) {
      where.push('u.role = ?')
      args.push(filter.role)
    }
    if (filter.pluginId !== undefined) {
      joinPlugin = 'JOIN user_plugins up ON up.user_id = u.id AND up.plugin_id = ?'
      where.push("(up.desired = 'installed' OR up.actual_version_id IS NOT NULL)")
      args.unshift(filter.pluginId)
    }
  }

  const orderArgs: SqlParam[] = [actorId ?? -1]
  const rows = db.all<TargetUserRow>(
    `SELECT u.id, u.slug, u.username, u.role, u.status, u.runtime_id, u.model_preset_id, u.model_policy,
            i.last_active_at AS last_active_at, u.last_login_at AS last_login_at
       FROM users u
       LEFT JOIN instances i ON i.user_id = u.id
       ${joinPlugin}
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN u.id = ? THEN 0 WHEN u.role = 'admin' THEN 1 ELSE 2 END,
               COALESCE(i.last_active_at, u.last_login_at) DESC,
               u.id ASC`,
    ...args,
    ...orderArgs,
  )
  return rows
}

export interface PluginRowForRollout {
  id: number
  package_name: string
  policy: PluginPolicy
  needs_restart: number
}

export function getPluginRowForRollout(db: HubDb, pluginId: number): PluginRowForRollout | undefined {
  return db.get<PluginRowForRollout>(
    'SELECT id, package_name, policy, needs_restart FROM plugins WHERE id = ?',
    pluginId,
  )
}

export function getUserPluginStateRow(
  db: HubDb,
  userId: number,
  pluginId: number,
): { desired: string; desired_version_id: number | null; actual_version_id: number | null } | undefined {
  return db.get<{ desired: string; desired_version_id: number | null; actual_version_id: number | null }>(
    'SELECT desired, desired_version_id, actual_version_id FROM user_plugins WHERE user_id = ? AND plugin_id = ?',
    userId,
    pluginId,
  )
}

export function getVersionLabel(db: HubDb, versionId: number): string | null {
  const row = db.get<{ version: string }>('SELECT version FROM plugin_versions WHERE id = ?', versionId)
  return row?.version ?? null
}

export function getLatestVersionId(db: HubDb, pluginId: number): number | null {
  const row = db.get<{ id: number }>(
    'SELECT id FROM plugin_versions WHERE plugin_id = ? ORDER BY id DESC LIMIT 1',
    pluginId,
  )
  return row?.id ?? null
}

export function getRuntimeVersionLabel(db: HubDb, runtimeId: number): string | null {
  const row = db.get<{ dsh_version: string }>('SELECT dsh_version FROM runtimes WHERE id = ?', runtimeId)
  return row?.dsh_version ?? null
}

export function getPresetName(db: HubDb, presetId: number): string | null {
  const row = db.get<{ name: string }>('SELECT name FROM model_presets WHERE id = ?', presetId)
  return row?.name ?? null
}

export function getDefaultPresetName(db: HubDb): string | null {
  const row = db.get<{ name: string }>(
    'SELECT name FROM model_presets WHERE is_default = 1 ORDER BY id LIMIT 1',
  )
  return row?.name ?? null
}

/** 用户当前生效的 DSH 版本：钉住的优先，否则默认版本 */
export function effectiveRuntimeVersion(db: HubDb, user: TargetUserRow): string | null {
  if (user.runtime_id !== null) return getRuntimeVersionLabel(db, user.runtime_id)
  const row = db.get<{ dsh_version: string }>(
    "SELECT dsh_version FROM runtimes WHERE is_default = 1 AND status = 'ready' ORDER BY id LIMIT 1",
  )
  return row?.dsh_version ?? null
}

/** 写期望状态：插件（user_plugins） */
export function writePluginDesired(
  db: HubDb,
  userId: number,
  pluginId: number,
  desired: 'installed' | 'absent',
  versionId: number | null,
  source: 'admin' | 'user',
  at: string,
): void {
  upsertUserPluginRow(db, {
    userId,
    pluginId,
    desired,
    desiredVersionId: desired === 'absent' ? null : versionId,
    // 实际状态不动：等执行器把 task 跑完再更新（这样「有 N 项待应用」才准确）
    actualVersionId: getUserPluginStateRow(db, userId, pluginId)?.actual_version_id ?? null,
    state: 'pending',
    source,
    error: null,
    at,
  })
}

/** 写期望状态：DSH 版本（users.runtime_id） */
export function writeRuntimeDesired(db: HubDb, userId: number, runtimeId: number | null, at: string): void {
  setUserRuntime(db, userId, runtimeId, at)
}

/** 写期望状态：模型预设（users.model_preset_id） */
export function writePresetDesired(db: HubDb, userId: number, presetId: number | null, at: string): void {
  setUserPreset(db, userId, presetId, at)
}

export { parseProviderIds }
