/**
 * 座舱管理员令牌的库访问（WP56b / docs/24 §3.3）。
 *
 * 表 `cockpit_admin_tokens` 见迁移 `130_cockpit_ops.sql`。为什么不是复用
 * `desktop_device_tokens`：座舱令牌**不占手机设备名额**（10 台上限）、不出现在「我的设备」里、
 * 吊销的触发条件也不同（管理员登出/降级/删除，而不是设备被吊销）。前缀与哈希纪律与手机令牌一致
 * （`dshm_at_` / `dshm_rt_`，库里只存 sha256），所以 App 的 `/auth/refresh` 不需要改。
 *
 * @module @dsh-hub/api/modules/mobile/cockpit-repo
 */
import type { HubDb } from '../../db/index.js'

/** 座舱令牌的吊销原因（与 130 的 CHECK 约束一致） */
export type CockpitTokenRevokeReason = 'rotated' | 'logout' | 'demoted' | 'deleted' | 'expired'

export interface CockpitTokenRow {
  id: string
  admin_id: number
  kind: 'access' | 'refresh'
  created_at: string
  expires_at: string
  revoked_at: string | null
  revoked_reason: string | null
  /** join users 带出来的管理员现状 */
  user_id: number
  slug: string
  username: string
  display_name: string
  avatar_file: string | null
  role: string
  user_status: string
  is_system: number
  must_change_password: number
  deleted_at: string | null
  user_created_at: string
}

const TOKEN_COLUMNS = `t.id, t.admin_id, t.kind, t.created_at, t.expires_at, t.revoked_at, t.revoked_reason,
       u.id AS user_id, u.slug, u.username, u.display_name, u.avatar_file, u.role,
       u.status AS user_status, u.is_system, u.must_change_password, u.deleted_at,
       u.created_at AS user_created_at`

/** 按 sha256(id) 取一条座舱令牌（带管理员现状）。 */
export function findCockpitTokenRow(db: HubDb, id: string): CockpitTokenRow | undefined {
  return db.get<CockpitTokenRow>(
    `SELECT ${TOKEN_COLUMNS}
       FROM cockpit_admin_tokens t
       JOIN users u ON u.id = t.admin_id
      WHERE t.id = ?`,
    id,
  )
}

/** 插一条令牌（明文不落库，只有调用方拿得到）。 */
export function insertCockpitToken(
  db: HubDb,
  input: {
    id: string
    adminId: number
    kind: 'access' | 'refresh'
    at: string
    expiresAt: string
  },
): void {
  db.run(
    `INSERT INTO cockpit_admin_tokens (id, admin_id, kind, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    input.id,
    input.adminId,
    input.kind,
    input.at,
    input.expiresAt,
  )
}

/** 吊销该管理员的全部有效令牌（轮换 / 登出 / 降级 / 删除都用它）。返回吊销条数。 */
export function revokeCockpitTokensForAdmin(
  db: HubDb,
  input: { adminId: number; at: string; reason: CockpitTokenRevokeReason },
): number {
  const result = db.run(
    `UPDATE cockpit_admin_tokens
        SET revoked_at = ?, revoked_reason = ?
      WHERE admin_id = ? AND revoked_at IS NULL`,
    input.at,
    input.reason,
    input.adminId,
  )
  return result.changes
}

/** 该管理员现在还有没有有效的座舱 access 令牌（通道复查用）。 */
export function hasLiveCockpitToken(db: HubDb, adminId: number, at: string): boolean {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cockpit_admin_tokens
      WHERE admin_id = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?`,
    adminId,
    at,
  )
  return (row?.n ?? 0) > 0
}

/**
 * 记一条「座舱会话 → 发起人」。**幂等**：同一会话只记第一次（谁开的就写谁，
 * 后进来接着聊的管理员不该改写历史）。
 */
export function recordCockpitSessionInitiator(
  db: HubDb,
  input: { sessionId: string; adminId: number; username: string; displayName: string | null; at: string },
): void {
  db.run(
    `INSERT INTO cockpit_session_initiators (session_id, admin_id, username, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO NOTHING`,
    input.sessionId,
    input.adminId,
    input.username,
    input.displayName,
    input.at,
  )
}

export interface CockpitSessionInitiator {
  adminId: number
  username: string
  displayName: string | null
}

/** 批量取若干会话的发起人（会话列表一帧一行，不做 N 次查询）。 */
export function cockpitSessionInitiators(
  db: HubDb,
  sessionIds: readonly string[],
): Map<string, CockpitSessionInitiator> {
  const map = new Map<string, CockpitSessionInitiator>()
  if (sessionIds.length === 0) return map
  const placeholders = sessionIds.map(() => '?').join(',')
  const rows = db.all<{
    session_id: string
    admin_id: number
    username: string
    display_name: string | null
  }>(
    `SELECT session_id, admin_id, username, display_name
       FROM cockpit_session_initiators
      WHERE session_id IN (${placeholders})`,
    ...sessionIds,
  )
  for (const row of rows) {
    map.set(row.session_id, { adminId: row.admin_id, username: row.username, displayName: row.display_name })
  }
  return map
}
