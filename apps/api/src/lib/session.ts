import { randomToken, sha256Hex } from './crypto.js'
import { SESSION_TTL_DAYS } from '@dsh-hub/shared'
import { isoPlusDays, isoPlusHours, isExpired } from './clock.js'
import type { Role, UserStatus } from '@dsh-hub/shared'
import type { HubDb } from '../db/index.js'

/**
 * 会话解析（WP0a 提供的基础设施，WP1 会在 auth 模块里继续完善滑动续期/限流）。
 * 库里只存 `sha256(token)`（02 §5），所以这里先哈希再查。
 */
export interface SessionUser {
  id: number
  slug: string
  username: string
  displayName: string
  avatarFile: string | null
  role: Role
  status: UserStatus
  mustChangePassword: boolean
  sessionId: string
  createdAt: string
  expiresAt: string
  /** 上次活跃时间：滑动续期的判据（距上次刷新超过 1 小时才延长 expires_at） */
  lastSeenAt: string
  reauthAt: string | null
}

interface SessionJoinRow {
  session_id: string
  session_created_at: string
  last_seen_at: string
  expires_at: string
  revoked_at: string | null
  reauth_at: string | null
  user_id: number
  slug: string
  username: string
  display_name: string
  avatar_file: string | null
  role: Role
  status: UserStatus
  must_change_password: number
  deleted_at: string | null
}

/** 会话 id：`sha256(token)` hex */
export function sessionIdFromToken(token: string): string {
  return sha256Hex(token)
}

/**
 * 用 cookie 里的 token 解析登录用户。以下情况一律视为未登录（返回 null）：
 * 会话不存在、已吊销、已过期、用户已软删除、用户不是 active（pending/disabled）。
 */
export function resolveSession(db: HubDb, token: string, nowIso: string): SessionUser | null {
  if (!token || token.length > 512) return null
  const row = db.get<SessionJoinRow>(
    `SELECT s.id AS session_id, s.created_at AS session_created_at, s.last_seen_at, s.expires_at,
            s.revoked_at, s.reauth_at,
            u.id AS user_id, u.slug, u.username, u.display_name, u.avatar_file, u.role, u.status,
            u.must_change_password, u.deleted_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    sessionIdFromToken(token),
  )
  if (!row) return null
  if (row.revoked_at) return null
  if (row.deleted_at) return null
  if (row.status !== 'active') return null
  if (isExpired(row.expires_at, nowIso)) return null
  return {
    id: row.user_id,
    slug: row.slug,
    username: row.username,
    displayName: row.display_name,
    avatarFile: row.avatar_file,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    sessionId: row.session_id,
    createdAt: row.session_created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    reauthAt: row.reauth_at,
  }
}

/** 刷新 `last_seen_at`（节流由调用方控制，见 app.ts 的会话钩子） */
export function touchSession(db: HubDb, sessionId: string, at: string): void {
  db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', at, sessionId)
}

/**
 * 滑动续期（02 §5「30 天滑动过期」）：把 `expires_at` 推到 `now + ttlDays`。
 * 管理员会话另有**绝对**上限（`settings.security.adminSessionHours`，从会话创建时刻算），
 * 滑动不能越过它；否则管理员会一直在线，12 小时的绝对过期就形同虚设。
 */
export function renewSession(
  db: HubDb,
  session: Pick<SessionUser, 'sessionId' | 'createdAt' | 'role'>,
  nowIso: string,
  opts: { ttlDays?: number; adminSessionHours?: number } = {},
): string {
  let expiresAt = isoPlusDays(nowIso, opts.ttlDays ?? SESSION_TTL_DAYS)
  if (session.role === 'admin' && opts.adminSessionHours) {
    const absolute = isoPlusHours(session.createdAt, opts.adminSessionHours)
    if (absolute < expiresAt) expiresAt = absolute
  }
  db.run('UPDATE sessions SET expires_at = ? WHERE id = ? AND revoked_at IS NULL', expiresAt, session.sessionId)
  return expiresAt
}

/** 标记二次验证时间（`/api/auth/reauth`） */
export function markReauth(db: HubDb, sessionId: string, at: string): void {
  db.run('UPDATE sessions SET reauth_at = ? WHERE id = ?', at, sessionId)
}

export interface CreateSessionInput {
  userId: number
  /** 明文 token（只在内存/响应里出现一次，库里存哈希） */
  token?: string
  now: string
  /** 普通会话 30 天（02 §5） */
  ttlDays?: number
  /** 管理员会话额外受绝对时长限制（settings.security.adminSessionHours） */
  adminSessionHours?: number
  isAdmin?: boolean
  ip?: string | null
  userAgent?: string | null
}

/** 建会话行，返回明文 token（调用方负责写 cookie）与过期时间 */
export function createSession(
  db: HubDb,
  input: CreateSessionInput,
): { token: string; id: string; expiresAt: string } {
  const token = input.token ?? randomToken(32)
  const id = sessionIdFromToken(token)
  let expiresAt = isoPlusDays(input.now, input.ttlDays ?? SESSION_TTL_DAYS)
  if (input.isAdmin && input.adminSessionHours) {
    const adminExpiry = isoPlusHours(input.now, input.adminSessionHours)
    if (adminExpiry < expiresAt) expiresAt = adminExpiry
  }
  db.run(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.userId,
    input.now,
    input.now,
    expiresAt,
    input.ip ?? null,
    input.userAgent ?? null,
  )
  return { token, id, expiresAt }
}

/** 吊销一个会话；返回是否真的改了行 */
export function revokeSession(db: HubDb, sessionId: string, at: string): boolean {
  const res = db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', at, sessionId)
  return res.changes > 0
}

/** 吊销某用户的全部会话（改密/重置密码/强制下线），可保留当前会话 */
export function revokeUserSessions(db: HubDb, userId: number, at: string, exceptSessionId?: string): number {
  if (exceptSessionId) {
    return db.run(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
      at,
      userId,
      exceptSessionId,
    ).changes
  }
  return db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', at, userId)
    .changes
}

/** 未过期且未吊销的会话数 */
export function countActiveSessions(db: HubDb, userId: number, nowIso: string): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    userId,
    nowIso,
  )
  return Number(row?.n ?? 0)
}

/** 是否在二次验证窗口内（默认 10 分钟，02 §5） */
export function hasRecentReauth(
  session: Pick<SessionUser, 'reauthAt'>,
  nowIso: string,
  windowMinutes: number,
): boolean {
  if (!session.reauthAt) return false
  const deadline = new Date(new Date(session.reauthAt).getTime() + windowMinutes * 60_000).toISOString()
  return deadline > nowIso
}
