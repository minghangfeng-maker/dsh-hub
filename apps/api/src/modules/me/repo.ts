import type { HubDb } from '../../db/index.js'

/** me 模块的 SQL（11 §5）；资料/会话/密码的写操作都走这里 */

export interface ProfilePatch {
  username?: string
  displayName?: string
  bio?: string
  /** 改用户名时同时记录冷却起点 */
  usernameChangedAt?: string
  at: string
}

/** 部分更新资料；字段名来自固定白名单，值全部参数化 */
export function updateProfile(db: HubDb, userId: number, patch: ProfilePatch): void {
  const sets: string[] = ['updated_at = ?']
  const params: (string | number)[] = [patch.at]
  if (patch.username !== undefined) {
    sets.push('username = ?')
    params.push(patch.username)
  }
  if (patch.usernameChangedAt !== undefined) {
    sets.push('username_changed_at = ?')
    params.push(patch.usernameChangedAt)
  }
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?')
    params.push(patch.displayName)
  }
  if (patch.bio !== undefined) {
    sets.push('bio = ?')
    params.push(patch.bio)
  }
  params.push(userId)
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

export function updateAvatarFile(db: HubDb, userId: number, avatarFile: string | null, at: string): void {
  db.run('UPDATE users SET avatar_file = ?, updated_at = ? WHERE id = ?', avatarFile, at, userId)
}

/** 改密：写新哈希并清掉「必须改密」标记（02 §5） */
export function updatePassword(db: HubDb, userId: number, passwordHash: string, at: string): void {
  db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
    passwordHash,
    at,
    userId,
  )
}

export interface SessionRecord {
  id: string
  created_at: string
  last_seen_at: string
  expires_at: string
  ip: string | null
  user_agent: string | null
}

/** 有效会话（未吊销、未过期），最近活跃在前 */
export function listUserSessions(db: HubDb, userId: number, nowIso: string): SessionRecord[] {
  return db.all<SessionRecord>(
    `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent
       FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC`,
    userId,
    nowIso,
  )
}

/** 会话归属校验（下线别人的会话必须 404，不能泄漏存在性） */
export function findSessionOwner(db: HubDb, sessionId: string): number | null {
  const row = db.get<{ user_id: number }>('SELECT user_id FROM sessions WHERE id = ?', sessionId)
  return row?.user_id ?? null
}
