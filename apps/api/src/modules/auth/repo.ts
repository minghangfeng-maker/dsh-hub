import { INVITE_CODE_REGEX } from '@dsh-hub/shared'
import type { HubDb } from '../../db/index.js'

/**
 * auth 模块的 SQL（11 §5：SQL 只写在模块的 repo.ts 里，全部参数化）。
 * 用户名/密码哈希等通用读取在 `lib/user-view.ts`（三个模块共用）。
 */

export interface NewUserInput {
  slug: string
  username: string
  displayName: string
  passwordHash: string
  role: 'user' | 'admin'
  /** 自定义角色名（空串 = 「普通用户」）；邀请码注册时取码上的快照（04 §2） */
  roleLabel: string
  status: 'pending' | 'active' | 'disabled'
  mustChangePassword: boolean
  at: string
}

/** 插入用户，返回新 id */
export function insertUser(db: HubDb, input: NewUserInput): number {
  const result = db.run(
    `INSERT INTO users (slug, username, display_name, bio, password_hash, role, role_label, status,
                        must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
    input.slug,
    input.username,
    input.displayName,
    input.passwordHash,
    input.role,
    input.roleLabel,
    input.status,
    input.mustChangePassword ? 1 : 0,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

/** 未软删除的用户数（注册上限 `settings.registration.maxUsers` 用它；系统账号不占名额，docs/24 §3.5） */
export function countUsers(db: HubDb): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND is_system = 0',
  )
  return Number(row?.n ?? 0)
}

export function touchLastLogin(db: HubDb, userId: number, at: string, ip: string | null): void {
  db.run('UPDATE users SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?', at, ip, at, userId)
}

export function updatePasswordHash(db: HubDb, userId: number, hash: string, at: string): void {
  db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, at, userId)
}

/** 被消耗掉的邀请码：注册时要拿到 id 与**此刻**的角色标签（快照，04 §2） */
export interface ConsumedInvite {
  id: number
  roleLabel: string
}

/**
 * 原子消耗一次邀请码：只有「存在 + 未停用 + 未过期 + 未用尽」才会 `used_count + 1`。
 * 返回邀请码 id 与码上的 `role_label`；不可用时返回 null（调用方统一抛 `INVITE_INVALID`，
 * 不区分原因，避免被枚举）。
 *
 * 为什么用一条 UPDATE 而不是「先 SELECT 再 UPDATE」：并发注册时后者会超用同一个码。
 * 读 role_label 与自增在同一个事务里（自己的 savepoint），保证角色与「消耗成功」一致。
 */
export function consumeInvite(db: HubDb, code: string, nowIso: string): ConsumedInvite | null {
  const normalized = code.trim().toUpperCase()
  if (!INVITE_CODE_REGEX.test(normalized)) return null
  return db.tx(() => {
    const result = db.run(
      `UPDATE invites
          SET used_count = used_count + 1
        WHERE code = ?
          AND disabled = 0
          AND (expires_at IS NULL OR expires_at > ?)
          AND used_count < max_uses`,
      normalized,
      nowIso,
    )
    if (result.changes === 0) return null
    const row = db.get<{ id: number; role_label: string }>(
      'SELECT id, role_label FROM invites WHERE code = ?',
      normalized,
    )
    return row ? { id: row.id, roleLabel: row.role_label } : null
  })
}

export function insertInviteUse(db: HubDb, inviteId: number, userId: number, at: string): void {
  db.run('INSERT INTO invite_uses (invite_id, user_id, used_at) VALUES (?, ?, ?)', inviteId, userId, at)
}
