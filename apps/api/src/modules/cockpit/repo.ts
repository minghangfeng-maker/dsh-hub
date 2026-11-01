import type { ProposalStatus } from '@dsh-hub/shared'
import type { HubDb } from '../../db/index.js'

/**
 * 座舱的持久化（docs/24 §3.5）：方案、画布卡、密钥请求、交接码。
 *
 * 模块边界：只有本文件写这些表的 SQL（11 §5）；上层（proposals/canvas/secrets/handoff）
 * 只做校验、事件与审计。全部参数化，不拼字符串。
 */

// ── 系统账号（docs/24 §3.5 / §7） ───────────────────────────────────────────

/** 这个用户是不是系统账号（hub-ops）。座舱自己的实例不能被能力启停 */
export function isSystemUser(db: HubDb, userId: number): boolean {
  const row = db.get<{ is_system: number }>('SELECT is_system FROM users WHERE id = ?', userId)
  return row?.is_system === 1
}

/** 全部系统账号 id（R0 列表里过滤用；通常只有 hub-ops 一个） */
export function systemUserIds(db: HubDb): Set<number> {
  const rows = db.all<{ id: number }>('SELECT id FROM users WHERE is_system = 1')
  return new Set(rows.map((row) => row.id))
}

/** 状态条用：实例总数（不含系统账号的实例） */
export function countInstances(db: HubDb): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM instances i JOIN users u ON u.id = i.user_id WHERE u.is_system = 0',
  )
  return row?.n ?? 0
}

// ── 方案 ────────────────────────────────────────────────────────────────────

export interface ProposalRow {
  id: number
  session_id: string
  title: string
  rationale: string
  risk: string
  steps_json: string
  status: string
  created_at: string
  expires_at: string
  decided_by: number | null
  decided_at: string | null
  outcome_json: string | null
  decided_by_username: string | null
}

const PROPOSAL_COLUMNS = `p.id, p.session_id, p.title, p.rationale, p.risk, p.steps_json, p.status,
       p.created_at, p.expires_at, p.decided_by, p.decided_at, p.outcome_json,
       COALESCE(u.deleted_username, u.username) AS decided_by_username`

export interface InsertProposalInput {
  sessionId: string
  title: string
  rationale: string
  risk: string
  stepsJson: string
  createdAt: string
  expiresAt: string
}

export function insertProposal(db: HubDb, input: InsertProposalInput): number {
  const result = db.run(
    `INSERT INTO cockpit_proposals
       (session_id, title, rationale, risk, steps_json, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    input.sessionId,
    input.title,
    input.rationale,
    input.risk,
    input.stepsJson,
    input.createdAt,
    input.expiresAt,
  )
  return result.lastInsertRowid
}

export function getProposal(db: HubDb, id: number): ProposalRow | undefined {
  return db.get<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM cockpit_proposals p
       LEFT JOIN users u ON u.id = p.decided_by
      WHERE p.id = ?`,
    id,
  )
}

export function listProposals(
  db: HubDb,
  query: { status?: ProposalStatus; sessionId?: string; limit?: number } = {},
): ProposalRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (query.status) {
    where.push('p.status = ?')
    params.push(query.status)
  }
  if (query.sessionId) {
    where.push('p.session_id = ?')
    params.push(query.sessionId)
  }
  params.push(Math.max(1, Math.min(200, query.limit ?? 50)))
  return db.all<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM cockpit_proposals p
       LEFT JOIN users u ON u.id = p.decided_by
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.id DESC
      LIMIT ?`,
    ...params,
  )
}

export function countPendingProposals(db: HubDb): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cockpit_proposals WHERE status IN ('pending', 'running')",
  )
  return row?.n ?? 0
}

/**
 * 状态迁移（并发批准只执行一次的锁）：`WHERE status = 'pending'` + 返回 changes。
 * node:sqlite 是同步单写者，两条并发请求里只有一个能把 pending → running。
 */
export function decideProposal(
  db: HubDb,
  id: number,
  next: ProposalStatus,
  opts: { decidedBy: number; decidedAt: string },
): number {
  const result = db.run(
    `UPDATE cockpit_proposals
        SET status = ?, decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'`,
    next,
    opts.decidedBy,
    opts.decidedAt,
    id,
  )
  return result.changes
}

/** 执行结束：写最终状态与逐步结果（`decided_*` 保持不变：它是谁批的，不是谁跑完的） */
export function finishProposal(
  db: HubDb,
  id: number,
  status: ProposalStatus,
  outcomeJson: string | null,
): void {
  db.run('UPDATE cockpit_proposals SET status = ?, outcome_json = ? WHERE id = ?', status, outcomeJson, id)
}

/**
 * 启动清扫（WP56e1，docs/24 §2 I3 的「不静默跳过」）：把上次进程里**还在 running** 的方案标 failed。
 *
 * 方案执行是进程内 fire-and-forget（WP56a 的已知问题 3）：Hub 在两步之间重启，那条方案会永远停在
 * running —— 既不显示结果，也不能再批（状态已经不是 pending）。这里在进程启动时收尾，
 * `outcome` 明确写明「Hub 重启中断」，让管理员知道该重新提一次，而不是看到一个卡住的方案。
 */
export function failInterruptedProposals(db: HubDb, reason: string): number[] {
  const rows = db.all<{ id: number }>("SELECT id FROM cockpit_proposals WHERE status = 'running'")
  if (rows.length === 0) return []
  db.run(
    "UPDATE cockpit_proposals SET status = 'failed', outcome_json = ? WHERE status = 'running'",
    JSON.stringify([{ stepIndex: 0, ok: false, error: { code: 'INTERRUPTED', message: reason } }]),
  )
  return rows.map((row) => row.id)
}

/** 懒过期：把已过 `expires_at` 的 pending 方案标成 expired，返回被标记的 id */
export function expireStaleProposals(db: HubDb, nowIso: string): number[] {
  const rows = db.all<{ id: number }>(
    "SELECT id FROM cockpit_proposals WHERE status = 'pending' AND expires_at <= ?",
    nowIso,
  )
  if (rows.length === 0) return []
  db.run(
    "UPDATE cockpit_proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    nowIso,
  )
  return rows.map((row) => row.id)
}

// ── 画布 ────────────────────────────────────────────────────────────────────

export interface CanvasRow {
  id: string
  session_id: string
  title: string
  spec_json: string
  pinned: number
  sort_order: number
  origin: string
  placement: string
  size: string
  created_at: string
  updated_at: string
}

const CANVAS_COLUMNS =
  'id, session_id, title, spec_json, pinned, sort_order, origin, placement, size, created_at, updated_at'

export interface InsertCanvasInput {
  id: string
  sessionId: string
  title: string
  specJson: string
  pinned: boolean
  order: number
  origin: 'dsh' | 'hub'
  placement: 'left' | 'right'
  size: 's' | 'm' | 'l'
  createdAt: string
  updatedAt: string
}

export function insertCanvas(db: HubDb, input: InsertCanvasInput): void {
  db.run(
    `INSERT INTO cockpit_canvas_items
       (id, session_id, title, spec_json, pinned, sort_order, origin, placement, size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.sessionId,
    input.title,
    input.specJson,
    input.pinned ? 1 : 0,
    input.order,
    input.origin,
    input.placement,
    input.size,
    input.createdAt,
    input.updatedAt,
  )
}

export function getCanvas(db: HubDb, id: string): CanvasRow | undefined {
  return db.get<CanvasRow>(`SELECT ${CANVAS_COLUMNS} FROM cockpit_canvas_items WHERE id = ?`, id)
}

export function listCanvasBySession(db: HubDb, sessionId: string): CanvasRow[] {
  return db.all<CanvasRow>(
    `SELECT ${CANVAS_COLUMNS} FROM cockpit_canvas_items WHERE session_id = ? ORDER BY sort_order, id`,
    sessionId,
  )
}

export function listPinnedCanvas(db: HubDb): CanvasRow[] {
  return db.all<CanvasRow>(
    `SELECT ${CANVAS_COLUMNS} FROM cockpit_canvas_items WHERE pinned = 1 ORDER BY sort_order, id`,
  )
}

export function countCanvasBySession(db: HubDb, sessionId: string): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cockpit_canvas_items WHERE session_id = ?',
    sessionId,
  )
  return row?.n ?? 0
}

/** 每会话 60 张的上限：超了删最旧的**非钉住**卡（docs/24 §3.1） */
export function canvasOverflow(db: HubDb, sessionId: string, max: number): string[] {
  const excess = countCanvasBySession(db, sessionId) - max + 1
  if (excess <= 0) return []
  const rows = db.all<{ id: string }>(
    `SELECT id FROM cockpit_canvas_items
      WHERE session_id = ? AND pinned = 0
      ORDER BY sort_order ASC, created_at ASC
      LIMIT ?`,
    sessionId,
    Math.min(excess, 500),
  )
  return rows.map((row) => row.id)
}

export function updateCanvas(
  db: HubDb,
  id: string,
  patch: {
    title?: string
    specJson?: string
    pinned?: boolean
    order?: number
    placement?: 'left' | 'right'
    size?: 's' | 'm' | 'l'
    updatedAt: string
  },
): void {
  const sets: string[] = ['updated_at = ?']
  const params: (string | number)[] = [patch.updatedAt]
  if (patch.title !== undefined) {
    sets.push('title = ?')
    params.push(patch.title)
  }
  if (patch.specJson !== undefined) {
    sets.push('spec_json = ?')
    params.push(patch.specJson)
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?')
    params.push(patch.pinned ? 1 : 0)
  }
  if (patch.order !== undefined) {
    sets.push('sort_order = ?')
    params.push(patch.order)
  }
  if (patch.placement !== undefined) {
    sets.push('placement = ?')
    params.push(patch.placement)
  }
  if (patch.size !== undefined) {
    sets.push('size = ?')
    params.push(patch.size)
  }
  params.push(id)
  db.run(`UPDATE cockpit_canvas_items SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

export function deleteCanvas(db: HubDb, id: string): CanvasRow | undefined {
  const row = getCanvas(db, id)
  if (row) db.run('DELETE FROM cockpit_canvas_items WHERE id = ?', id)
  return row
}

/** 卡片顺序的下一个值（新卡排在最后） */
export function nextCanvasOrder(db: HubDb, sessionId: string): number {
  const row = db.get<{ n: number | null }>(
    'SELECT MAX(sort_order) AS n FROM cockpit_canvas_items WHERE session_id = ?',
    sessionId,
  )
  return (row?.n ?? 0) + 10
}

// ── 密钥请求 ────────────────────────────────────────────────────────────────

export interface SecretRow {
  id: string
  request_json: string
  ciphertext: string | null
  status: string
  created_at: string
  expires_at: string
  filled_at: string | null
  used_at: string | null
}

const SECRET_COLUMNS = 'id, request_json, ciphertext, status, created_at, expires_at, filled_at, used_at'

export function insertSecret(
  db: HubDb,
  input: { id: string; requestJson: string; createdAt: string; expiresAt: string },
): void {
  db.run(
    `INSERT INTO cockpit_secrets (id, request_json, ciphertext, status, created_at, expires_at)
     VALUES (?, ?, NULL, 'pending', ?, ?)`,
    input.id,
    input.requestJson,
    input.createdAt,
    input.expiresAt,
  )
}

export function getSecret(db: HubDb, id: string): SecretRow | undefined {
  return db.get<SecretRow>(`SELECT ${SECRET_COLUMNS} FROM cockpit_secrets WHERE id = ?`, id)
}

export function fillSecret(db: HubDb, id: string, ciphertext: string, filledAt: string): number {
  const result = db.run(
    `UPDATE cockpit_secrets SET ciphertext = ?, status = 'filled', filled_at = ?
      WHERE id = ? AND status = 'pending'`,
    ciphertext,
    filledAt,
    id,
  )
  return result.changes
}

export function cancelSecret(db: HubDb, id: string): number {
  const result = db.run(
    "UPDATE cockpit_secrets SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'filled')",
    id,
  )
  return result.changes
}

/** 用完即删（§3.4：执行后删除）；同时置 used_at 留痕 */
export function consumeSecret(db: HubDb, id: string, usedAt: string): void {
  db.run(
    "UPDATE cockpit_secrets SET ciphertext = NULL, status = 'expired', used_at = ? WHERE id = ?",
    usedAt,
    id,
  )
}

/** 某状态的全部密钥请求（SSE 连上时补发 pending 的那批，WP56e1） */
export function listSecretsByStatus(db: HubDb, status: string, limit = 100): SecretRow[] {
  return db.all<SecretRow>(
    `SELECT ${SECRET_COLUMNS} FROM cockpit_secrets WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
    status,
    limit,
  )
}

export function expireStaleSecrets(db: HubDb, nowIso: string): void {
  db.run(
    "UPDATE cockpit_secrets SET status = 'expired', ciphertext = NULL WHERE status = 'pending' AND expires_at <= ?",
    nowIso,
  )
}

// ── 交接码 ──────────────────────────────────────────────────────────────────

export function insertHandoff(
  db: HubDb,
  input: { codeHash: string; adminId: number; createdAt: string; expiresAt: string },
): void {
  db.run(
    `INSERT INTO cockpit_handoff_codes (code_hash, admin_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
    input.codeHash,
    input.adminId,
    input.createdAt,
    input.expiresAt,
  )
}

/** 一次性消费：只有 `used_at IS NULL` 且未过期的行能被吃掉 */
export function consumeHandoff(db: HubDb, codeHash: string, nowIso: string): number | null {
  const row = db.get<{ admin_id: number }>(
    `SELECT admin_id FROM cockpit_handoff_codes
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    codeHash,
    nowIso,
  )
  if (!row) return null
  const result = db.run(
    'UPDATE cockpit_handoff_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
    nowIso,
    codeHash,
  )
  return result.changes === 1 ? row.admin_id : null
}

/** 便宜的清场：过期的交接码直接删（表会随管理员操作缓慢增长） */
export function purgeExpiredHandoffs(db: HubDb, nowIso: string): void {
  db.run('DELETE FROM cockpit_handoff_codes WHERE expires_at <= ?', nowIso)
}
