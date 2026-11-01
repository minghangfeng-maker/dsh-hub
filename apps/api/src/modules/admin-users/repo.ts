import type { AuditItem, UserAdminView, UserSort } from '@dsh-hub/shared'
import { DELETED_USERNAME_SUFFIX } from '@dsh-hub/shared'
import { AUDIT_COLUMNS, auditItemFromRow, type AuditRow } from '../../lib/audit.js'
import type { HubDb } from '../../db/index.js'
import { userColumns, type UserRecord } from '../../lib/user-view.js'

/**
 * admin-users 模块的 SQL（04 §4.1 §4.2 §4.4）。
 *
 * 跨任务包的逻辑外键（`instances`/`runtimes`/`model_presets`）不写 REFERENCES（03 §1），
 * 且这些表在 WP1 合并时还不存在，所以凡是碰 `instances` 的查询都先探测表是否存在，
 * 不存在就退化成「没有实例」——不能因为别的包还没合并就让管理端 500。
 */

/** 表是否存在（WP1 与 WP2/WP3 并行开发期间的兼容层） */
export function hasTable(db: HubDb, name: string): boolean {
  return Boolean(
    db.get<{ name: string }>('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', name),
  )
}

const USER_SORTS: Record<UserSort, string> = {
  'createdAt:desc': 'u.created_at DESC, u.id DESC',
  'createdAt:asc': 'u.created_at ASC, u.id ASC',
  'username:asc': 'u.username ASC',
  'username:desc': 'u.username DESC',
  'lastLoginAt:desc': 'u.last_login_at IS NULL, u.last_login_at DESC',
}

export interface ListUsersParams {
  q?: string
  status?: string
  role?: string
  roleLabel?: string
  instance?: string
  sort: UserSort
  page: number
  pageSize: number
  withInstances: boolean
}

/** 分页查用户（管理端列表）。筛选项都是可选，SQL 片段固定、值参数化 */
export function listUsers(db: HubDb, params: ListUsersParams): { rows: UserRecord[]; total: number } {
  // 系统账号（hub-ops，WP56a/WP56b 的座舱 DSH）不是人：不进用户列表、不计入分页总数（docs/24 §3.5）
  const where: string[] = ['u.deleted_at IS NULL', 'u.is_system = 0']
  const args: (string | number)[] = []
  if (params.q) {
    where.push('(u.username LIKE ? OR u.display_name LIKE ?)')
    const like = `%${params.q}%`
    args.push(like, like)
  }
  if (params.status) {
    where.push('u.status = ?')
    args.push(params.status)
  }
  if (params.role) {
    where.push('u.role = ?')
    args.push(params.role)
  }
  if (params.roleLabel) {
    where.push("u.role = 'user' AND u.role_label = ?")
    args.push(params.roleLabel)
  }
  if (params.instance && params.withInstances) {
    where.push('i.status = ?')
    args.push(params.instance)
  }
  const join = params.withInstances ? 'LEFT JOIN instances i ON i.user_id = u.id' : ''
  const whereSql = `WHERE ${where.join(' AND ')}`
  const total =
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${join} ${whereSql}`, ...args)?.n ?? 0
  const rows = db.all<UserRecord>(
    `SELECT ${userColumns('u')}
       FROM users u ${join}
       ${whereSql}
      ORDER BY ${USER_SORTS[params.sort]}
      LIMIT ? OFFSET ?`,
    ...args,
    params.pageSize,
    (params.page - 1) * params.pageSize,
  )
  return { rows, total: Number(total) }
}

export interface UserStats {
  total: number
  active: number
  pending: number
  disabled: number
  newToday: number
}

/** 概览里的用户统计（04 §4.1）；软删除的不计入 */
export function userStats(db: HubDb, todayStartIso: string): UserStats {
  const row = db.get<{ total: number; active: number; pending: number; disabled: number; new_today: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_today
       FROM users
      WHERE deleted_at IS NULL AND is_system = 0`,
    todayStartIso,
  )
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    pending: Number(row?.pending ?? 0),
    disabled: Number(row?.disabled ?? 0),
    newToday: Number(row?.new_today ?? 0),
  }
}

/** 最近注册（概览用） */
export function recentRegistrations(db: HubDb, limit: number): UserRecord[] {
  return db.all<UserRecord>(
    `SELECT ${userColumns('u')} FROM users u
      WHERE u.deleted_at IS NULL AND u.is_system = 0
      ORDER BY u.id DESC LIMIT ?`,
    limit,
  )
}

export interface AdminInsertUserInput {
  slug: string
  username: string
  displayName: string
  passwordHash: string
  role: 'user' | 'admin'
  roleLabel: string
  mustChangePassword: boolean
  at: string
}

export function insertUserAsAdmin(db: HubDb, input: AdminInsertUserInput): number {
  return db.run(
    `INSERT INTO users (slug, username, display_name, bio, password_hash, role, role_label, status,
                        must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, 'active', ?, ?, ?)`,
    input.slug,
    input.username,
    input.displayName,
    input.passwordHash,
    input.role,
    input.roleLabel,
    input.mustChangePassword ? 1 : 0,
    input.at,
    input.at,
  ).lastInsertRowid
}

/** 更新用户（管理端）；字段名固定，值参数化 */
export function updateUserAsAdmin(
  db: HubDb,
  userId: number,
  patch: {
    displayName?: string
    role?: 'user' | 'admin'
    roleLabel?: string
    status?: 'pending' | 'active' | 'disabled'
    quotaJson?: string | null
    runtimeId?: number | null
    modelPresetId?: number | null
    modelPolicy?: 'managed' | 'free'
    at: string
  },
): void {
  const sets: string[] = ['updated_at = ?']
  const args: (string | number | null)[] = [patch.at]
  const assign = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return
    sets.push(`${column} = ?`)
    args.push(value)
  }
  assign('display_name', patch.displayName)
  assign('role', patch.role)
  assign('role_label', patch.roleLabel)
  assign('status', patch.status)
  assign('quota_json', patch.quotaJson)
  assign('runtime_id', patch.runtimeId)
  assign('model_preset_id', patch.modelPresetId)
  assign('model_policy', patch.modelPolicy)
  args.push(userId)
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args)
}

/**
 * 在用的角色标签及人数（新建/编辑用户与邀请码的候选项）；软删除的用户不算。
 *
 * 口径（04 §4.2）：未删除普通用户的标签 ∪ 邀请码上的标签，`count` **始终是用户人数**——
 * 只在邀请码上出现的标签给 0（它只是「可以选」），这样邀请码新定的角色名也能立刻出现在候选里。
 */
export function listRoleLabels(db: HubDb): { label: string; count: number }[] {
  return db
    .all<{ label: string; n: number }>(
      `SELECT label, SUM(n) AS n
         FROM (
           SELECT role_label AS label, COUNT(*) AS n
             FROM users
            WHERE deleted_at IS NULL AND role = 'user' AND role_label <> ''
            GROUP BY role_label
           UNION ALL
           SELECT role_label AS label, 0 AS n
             FROM invites
            WHERE role_label <> ''
         )
        GROUP BY label
        ORDER BY n DESC, label ASC`,
    )
    .map((row) => ({ label: row.label, count: Number(row.n) }))
}

// ── 用户回收站（WP22 / 迁移 006） ────────────────────────────────────────────

/**
 * 软删除 + **立即释放用户名**：`username` 改成墓碑名 `<原名>#del<id>`（不满足 `USERNAME_REGEX`，
 * 永远无法被注册/登录），原名记进 `deleted_username` 供回收站展示与恢复；同时记下删除前状态。
 * 返回墓碑名（审计 detail 用）。
 */
export function markUserDeleted(
  db: HubDb,
  userId: number,
  input: { username: string; fromStatus: string; at: string },
): string {
  const tombstone = `${input.username}${DELETED_USERNAME_SUFFIX}${userId}`
  db.run(
    `UPDATE users
        SET username = ?, deleted_username = ?, deleted_from_status = ?, deleted_at = ?,
            status = 'disabled', updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
    tombstone,
    input.username,
    input.fromStatus,
    input.at,
    input.at,
    userId,
  )
  return tombstone
}

export interface ListDeletedUsersParams {
  q?: string
  page: number
  pageSize: number
}

/**
 * 回收站列表（`deleted_at` 非空且未彻底删除），按删除时间倒序。
 * `q` 搜删除时的用户名与昵称。SQL 片段固定、值参数化。
 */
export function listDeletedUsers(
  db: HubDb,
  params: ListDeletedUsersParams,
): { rows: UserRecord[]; total: number } {
  const where: string[] = ['u.deleted_at IS NOT NULL', 'u.purged_at IS NULL']
  const args: string[] = []
  if (params.q) {
    where.push('(u.deleted_username LIKE ? OR u.display_name LIKE ?)')
    const like = `%${params.q}%`
    args.push(like, like)
  }
  const whereSql = `WHERE ${where.join(' AND ')}`
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, ...args)?.n ?? 0
  const rows = db.all<UserRecord>(
    `SELECT ${userColumns('u')}
       FROM users u ${whereSql}
      ORDER BY u.deleted_at DESC, u.id DESC
      LIMIT ? OFFSET ?`,
    ...args,
    params.pageSize,
    (params.page - 1) * params.pageSize,
  )
  return { rows, total: Number(total) }
}

/** 已超过保留期（`deleted_at < cutoff`）且未彻底删除的行（后台清理任务用） */
export function listExpiredDeletedUsers(db: HubDb, cutoff: string, limit = 500): UserRecord[] {
  return db.all<UserRecord>(
    `SELECT ${userColumns('u')}
       FROM users u
      WHERE u.deleted_at IS NOT NULL AND u.purged_at IS NULL AND u.deleted_at < ?
      ORDER BY u.deleted_at ASC
      LIMIT ?`,
    cutoff,
    limit,
  )
}

/** 记录数据目录在 `trash/` 下的相对路径（删除用户、move 成功后调用） */
export function setTrashDir(db: HubDb, userId: number, trashDir: string, at: string): void {
  db.run('UPDATE users SET trash_dir = ?, updated_at = ? WHERE id = ?', trashDir, at, userId)
}

/** 标记彻底删除：`purged_at` 置位并清掉 `trash_dir`（数据目录已删） */
export function markUserPurged(db: HubDb, userId: number, at: string): void {
  db.run(
    'UPDATE users SET purged_at = ?, trash_dir = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
    at,
    at,
    userId,
  )
}

/** 从回收站恢复：清空删除标记（含墓碑名），回到删除前状态，可指定新用户名 */
export function restoreUserRecord(
  db: HubDb,
  userId: number,
  input: { username: string; status: 'pending' | 'active' | 'disabled'; at: string },
): void {
  db.run(
    `UPDATE users
        SET username = ?, status = ?, deleted_at = NULL, deleted_username = NULL,
            deleted_from_status = NULL, purged_at = NULL, trash_dir = NULL, updated_at = ?
      WHERE id = ? AND deleted_at IS NOT NULL`,
    input.username,
    input.status,
    input.at,
    userId,
  )
}

export function setPasswordAndRevokeFlag(db: HubDb, userId: number, passwordHash: string, at: string): void {
  db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?',
    passwordHash,
    at,
    userId,
  )
}

/** 仍可登录的管理员数量（最后一个管理员保护用） */
export function countActiveAdmins(db: HubDb): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL",
  )
  return Number(row?.n ?? 0)
}

export function countUserSessions(db: HubDb, userId: number, nowIso: string): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    userId,
    nowIso,
  )
  return Number(row?.n ?? 0)
}

/** 与该用户相关的审计（自己是操作者，或是被操作对象） */
export function auditForUser(db: HubDb, userId: number, limit: number): AuditItem[] {
  const rows = db.all<AuditRow>(
    `SELECT ${AUDIT_COLUMNS}
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.actor_id = ? OR (a.target_type = 'user' AND a.target_id = ?)
      ORDER BY a.id DESC
      LIMIT ?`,
    userId,
    String(userId),
    limit,
  )
  return rows.map(auditItemFromRow)
}

// ── 邀请码 ──────────────────────────────────────────────────────────────────

export interface InviteRecord {
  id: number
  code: string
  note: string
  max_uses: number
  used_count: number
  expires_at: string | null
  disabled: number
  created_by: number | null
  created_at: string
  role_label: string
}

const INVITE_COLUMNS =
  'id, code, note, max_uses, used_count, expires_at, disabled, created_by, created_at, role_label'

export function countInvites(db: HubDb): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invites')?.n ?? 0)
}

export function listInvites(
  db: HubDb,
  page: number,
  pageSize: number,
): { rows: InviteRecord[]; total: number } {
  const total = countInvites(db)
  const rows = db.all<InviteRecord>(
    `SELECT ${INVITE_COLUMNS} FROM invites ORDER BY id DESC LIMIT ? OFFSET ?`,
    pageSize,
    (page - 1) * pageSize,
  )
  return { rows, total }
}

export function findInviteById(db: HubDb, id: number): InviteRecord | undefined {
  return db.get<InviteRecord>(`SELECT ${INVITE_COLUMNS} FROM invites WHERE id = ?`, id)
}

export function findInviteByCode(db: HubDb, code: string): InviteRecord | undefined {
  return db.get<InviteRecord>(`SELECT ${INVITE_COLUMNS} FROM invites WHERE code = ?`, code)
}

export interface InsertInviteInput {
  code: string
  note: string
  maxUses: number
  expiresAt: string | null
  createdBy: number | null
  /** 用这个码注册的人得到的角色标签（空串 = 「普通用户」）；已规范化 */
  roleLabel: string
  at: string
}

export function insertInvite(db: HubDb, input: InsertInviteInput): number {
  return db.run(
    `INSERT INTO invites (code, note, max_uses, used_count, expires_at, disabled, created_by, created_at,
                          role_label)
     VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)`,
    input.code,
    input.note,
    input.maxUses,
    input.expiresAt,
    input.createdBy,
    input.at,
    input.roleLabel,
  ).lastInsertRowid
}

export function updateInvite(
  db: HubDb,
  inviteId: number,
  patch: {
    disabled?: boolean
    note?: string
    maxUses?: number
    expiresAt?: string | null
    roleLabel?: string
  },
): void {
  const sets: string[] = []
  const args: (string | number | null)[] = []
  if (patch.disabled !== undefined) {
    sets.push('disabled = ?')
    args.push(patch.disabled ? 1 : 0)
  }
  if (patch.note !== undefined) {
    sets.push('note = ?')
    args.push(patch.note)
  }
  if (patch.maxUses !== undefined) {
    sets.push('max_uses = ?')
    args.push(patch.maxUses)
  }
  if (patch.expiresAt !== undefined) {
    sets.push('expires_at = ?')
    args.push(patch.expiresAt)
  }
  if (patch.roleLabel !== undefined) {
    sets.push('role_label = ?')
    args.push(patch.roleLabel)
  }
  if (sets.length === 0) return
  args.push(inviteId)
  db.run(`UPDATE invites SET ${sets.join(', ')} WHERE id = ?`, ...args)
}

export function deleteInvite(db: HubDb, inviteId: number): void {
  db.tx(() => {
    db.run('DELETE FROM invite_uses WHERE invite_id = ?', inviteId)
    db.run('DELETE FROM invites WHERE id = ?', inviteId)
  })
}

export interface InviteUseRecord {
  invite_id: number
  user_id: number
  username: string | null
  used_at: string
}

/** 一次取回多个邀请码的使用记录（列表页避免 N+1） */
export function listInviteUses(db: HubDb, inviteIds: number[]): InviteUseRecord[] {
  if (inviteIds.length === 0) return []
  const placeholders = inviteIds.map(() => '?').join(', ')
  return db.all<InviteUseRecord>(
    // 用码的人可能后来被删除（`username` 变墓碑名），历史展示仍用删除时原名
    `SELECT iu.invite_id, iu.user_id, COALESCE(u.deleted_username, u.username) AS username, iu.used_at
       FROM invite_uses iu
       LEFT JOIN users u ON u.id = iu.user_id
      WHERE iu.invite_id IN (${placeholders})
      ORDER BY iu.used_at ASC`,
    ...inviteIds,
  )
}

// ── 审计查询 ────────────────────────────────────────────────────────────────

export interface AuditQuery {
  actorId?: number
  action?: string
  /** 动作前缀（WP25e）：与 `action` 同时给出时两个条件都要满足 */
  actionPrefix?: string
  targetType?: string
  targetId?: string
  from?: string
  to?: string
  page: number
  pageSize: number
}

/**
 * LIKE 前缀模式：`%` 与 `_` 是 LIKE 的通配符，前缀里出现时必须转义，
 * 否则 `desktop._x` 会把 `desktop.ax` 也查出来（配合 SQL 里的 `ESCAPE '\'`）。
 */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`
}

export function listAudit(db: HubDb, query: AuditQuery): { rows: AuditItem[]; total: number } {
  const where: string[] = []
  const args: (string | number)[] = []
  if (query.actorId !== undefined) {
    where.push('a.actor_id = ?')
    args.push(query.actorId)
  }
  if (query.action) {
    // 支持 `user.` 前缀匹配（前端按大类筛选）
    if (query.action.endsWith('.*')) {
      where.push("a.action LIKE ? ESCAPE '\\'")
      args.push(likePrefix(query.action.slice(0, -1)))
    } else {
      where.push('a.action = ?')
      args.push(query.action)
    }
  }
  // WP25e：显式的前缀查询（`actionPrefix=desktop.`），一次拿到所有桌面端动作
  if (query.actionPrefix !== undefined && query.actionPrefix.length > 0) {
    where.push("a.action LIKE ? ESCAPE '\\'")
    args.push(likePrefix(query.actionPrefix))
  }
  if (query.targetType) {
    where.push('a.target_type = ?')
    args.push(query.targetType)
  }
  if (query.targetId) {
    where.push('a.target_id = ?')
    args.push(query.targetId)
  }
  if (query.from) {
    where.push('a.at >= ?')
    args.push(query.from)
  }
  if (query.to) {
    where.push('a.at <= ?')
    args.push(query.to)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs a ${whereSql}`, ...args)?.n ?? 0
  const rows = db.all<AuditRow>(
    `SELECT ${AUDIT_COLUMNS}
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       ${whereSql}
      ORDER BY a.id DESC
      LIMIT ? OFFSET ?`,
    ...args,
    query.pageSize,
    (query.page - 1) * query.pageSize,
  )
  return { rows: rows.map(auditItemFromRow), total: Number(total) }
}

/** 概览里的「最近审计」 */
export function recentAudit(db: HubDb, limit: number): AuditItem[] {
  const rows = db.all<AuditRow>(
    `SELECT ${AUDIT_COLUMNS}
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC
      LIMIT ?`,
    limit,
  )
  return rows.map(auditItemFromRow)
}

export type { UserRecord, UserAdminView }
