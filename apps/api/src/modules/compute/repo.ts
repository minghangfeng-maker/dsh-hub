import type { ComputeLease, ComputeLeaseEndReason } from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'
import { HubError } from '../../lib/errors.js'

/**
 * 算力租赁的 SQL（11 §5：SQL 只写在模块 repo 里）。
 * 租约开租时快照规格与价格；`ended_at IS NULL` = 进行中。
 */

export interface ComputeLeaseDbRow {
  id: number
  user_id: number
  plan_id: string
  plan_name: string
  cpus: number
  memory_mb: number
  price_per_hour: number
  block_price: number
  billed: number
  start_reason: string
  started_at: string
  paid_until: string | null
  grace_until: string | null
  ended_at: string | null
  end_reason: string | null
  blocks: number
  charged: number
  created_at: string
  updated_at: string
}

export interface ComputeLeaseJoinRow extends ComputeLeaseDbRow {
  username: string
}

export function toComputeLease(row: ComputeLeaseDbRow): ComputeLease {
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    planName: row.plan_name,
    cpus: row.cpus,
    memoryMb: row.memory_mb,
    pricePerHourMicro: row.price_per_hour,
    blockPriceMicro: row.block_price,
    billed: row.billed === 1,
    startedAt: row.started_at,
    paidUntil: row.paid_until,
    graceUntil: row.grace_until,
    endedAt: row.ended_at,
    endReason: (row.end_reason as ComputeLeaseEndReason | null) ?? null,
    blocks: row.blocks,
    chargedMicro: row.charged,
  }
}

export interface InsertComputeLeaseInput {
  userId: number
  planId: string
  planName: string
  cpus: number
  memoryMb: number
  pricePerHourMicro: number
  blockPriceMicro: number
  billed: boolean
  startReason: string
  startedAt: string
  paidUntil: string | null
  blocks: number
  charged: number
  at: string
}

export function insertComputeLease(db: HubDb, input: InsertComputeLeaseInput): number {
  const result = db.run(
    `INSERT INTO compute_leases (user_id, plan_id, plan_name, cpus, memory_mb, price_per_hour, block_price,
                                 billed, start_reason, started_at, paid_until, grace_until, ended_at,
                                 end_reason, blocks, charged, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
    input.userId,
    input.planId,
    input.planName,
    input.cpus,
    input.memoryMb,
    input.pricePerHourMicro,
    input.blockPriceMicro,
    input.billed ? 1 : 0,
    input.startReason,
    input.startedAt,
    input.paidUntil,
    input.blocks,
    input.charged,
    input.at,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdateComputeLeaseInput {
  paidUntil?: string | null
  graceUntil?: string | null
  endedAt?: string | null
  endReason?: ComputeLeaseEndReason | null
  blocks?: number
  charged?: number
}

export function updateComputeLease(db: HubDb, id: number, patch: UpdateComputeLeaseInput, at: string): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.paidUntil !== undefined) push('paid_until', patch.paidUntil)
  if (patch.graceUntil !== undefined) push('grace_until', patch.graceUntil)
  if (patch.endedAt !== undefined) push('ended_at', patch.endedAt)
  if (patch.endReason !== undefined) push('end_reason', patch.endReason)
  if (patch.blocks !== undefined) push('blocks', patch.blocks)
  if (patch.charged !== undefined) push('charged', patch.charged)
  push('updated_at', at)
  db.run(`UPDATE compute_leases SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
}

export function findActiveLease(db: HubDb, userId: number): ComputeLeaseDbRow | undefined {
  return db.get<ComputeLeaseDbRow>(
    'SELECT * FROM compute_leases WHERE user_id = ? AND ended_at IS NULL',
    userId,
  )
}

export function listActiveLeases(db: HubDb): ComputeLeaseDbRow[] {
  return db.all<ComputeLeaseDbRow>('SELECT * FROM compute_leases WHERE ended_at IS NULL ORDER BY id ASC')
}

/** 「停了马上再开」续接用：最近一条已结束的租约 */
export function findLatestEndedLease(db: HubDb, userId: number): ComputeLeaseDbRow | undefined {
  return db.get<ComputeLeaseDbRow>(
    `SELECT * FROM compute_leases WHERE user_id = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC, id DESC LIMIT 1`,
    userId,
  )
}

export function endComputeLease(db: HubDb, id: number, reason: ComputeLeaseEndReason, at: string): void {
  db.run(
    `UPDATE compute_leases SET ended_at = ?, end_reason = ?, grace_until = NULL, updated_at = ?
      WHERE id = ? AND ended_at IS NULL`,
    at,
    reason,
    at,
    id,
  )
}

export interface ListComputeLeaseOptions {
  userId?: number
  /** true = 只看进行中；false = 只看已结束；省略 = 全部 */
  active?: boolean
  limit: number
  offset: number
}

export function listComputeLeaseRows(
  db: HubDb,
  opts: ListComputeLeaseOptions,
): { rows: ComputeLeaseJoinRow[]; total: number } {
  const where: string[] = []
  const params: SqlParam[] = []
  if (opts.userId !== undefined) {
    where.push('l.user_id = ?')
    params.push(opts.userId)
  }
  if (opts.active === true) where.push('l.ended_at IS NULL')
  if (opts.active === false) where.push('l.ended_at IS NOT NULL')
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = Number(
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM compute_leases l ${whereSql}`, ...params)?.n ?? 0,
  )
  const rows = db.all<ComputeLeaseJoinRow>(
    `SELECT l.*, u.username AS username
       FROM compute_leases l JOIN users u ON u.id = l.user_id
       ${whereSql}
      ORDER BY l.started_at DESC, l.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    opts.limit,
    opts.offset,
  )
  return { rows, total }
}

// ── 规格偏好 ────────────────────────────────────────────────────────────────

export function getComputePref(db: HubDb, userId: number): string | null {
  return (
    db.get<{ plan_id: string }>('SELECT plan_id FROM compute_prefs WHERE user_id = ?', userId)?.plan_id ??
    null
  )
}

export function upsertComputePref(db: HubDb, userId: number, planId: string, at: string): void {
  db.run(
    `INSERT INTO compute_prefs (user_id, plan_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, updated_at = excluded.updated_at`,
    userId,
    planId,
    at,
  )
}

// ── 用户 ────────────────────────────────────────────────────────────────────

export interface ComputeUserRow {
  role: string
  status: string
  deleted_at: string | null
}

export function getComputeUser(db: HubDb, userId: number): ComputeUserRow | undefined {
  return db.get<ComputeUserRow>('SELECT role, status, deleted_at FROM users WHERE id = ?', userId)
}

/** 计费豁免：管理员本人且 `billAdmins = false`（13 §4） */
export function isBillingExempt(db: HubDb, userId: number, billAdmins: boolean): boolean {
  const user = getComputeUser(db, userId)
  if (!user || user.deleted_at !== null) throw new HubError('NOT_FOUND', '用户不存在')
  return user.role === 'admin' && !billAdmins
}
