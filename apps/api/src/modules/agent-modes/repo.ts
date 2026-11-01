import type { HubDb } from '../../db/index.js'

/**
 * 18 §4.3：模式状态接口要的用户信息（用户名、显示名、slug、是否已删除）。
 * 只读 `users`，不碰别的模块的表（实例状态 / 插件状态分别走 instances / plugins 服务）。
 */
export interface AgentModeUserRow {
  id: number
  username: string
  display_name: string
  slug: string
  deleted_at: string | null
}

export function listUserRows(db: HubDb): AgentModeUserRow[] {
  return db.all<AgentModeUserRow>(
    `SELECT id, username, display_name, slug, deleted_at FROM users
      WHERE deleted_at IS NULL ORDER BY id ASC`,
  )
}

export function getUserRows(db: HubDb, ids: number[]): AgentModeUserRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  return db.all<AgentModeUserRow>(
    `SELECT id, username, display_name, slug, deleted_at FROM users
      WHERE deleted_at IS NULL AND id IN (${placeholders}) ORDER BY id ASC`,
    ...ids,
  )
}

export function userExists(db: HubDb, userId: number): boolean {
  return (
    db.get<{ id: number }>('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', userId) !== undefined
  )
}
