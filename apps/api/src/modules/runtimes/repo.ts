import type { AdminRuntimeRow, RuntimeStatus } from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'

/** runtimes 模块的 SQL（03 §1.4）。跨任务包外键（jobs / users / instances）一律逻辑外键。 */

export interface RuntimeRow {
  id: number
  dsh_version: string
  image: string
  status: RuntimeStatus
  is_default: number
  image_id: string | null
  size_bytes: number | null
  build_job_id: number | null
  notes: string
  created_at: string
}

export function toAdminRuntimeRow(row: RuntimeRow, usersOnIt: number): AdminRuntimeRow {
  return {
    id: row.id,
    dshVersion: row.dsh_version,
    image: row.image,
    status: row.status,
    isDefault: row.is_default === 1,
    sizeBytes: row.size_bytes,
    usersOnIt,
    createdAt: row.created_at,
    notes: row.notes,
  }
}

export function listRuntimeRows(db: HubDb): RuntimeRow[] {
  return db.all<RuntimeRow>('SELECT * FROM runtimes ORDER BY id DESC')
}

export function getRuntimeRow(db: HubDb, runtimeId: number): RuntimeRow | undefined {
  return db.get<RuntimeRow>('SELECT * FROM runtimes WHERE id = ?', runtimeId)
}

export function getRuntimeRowByVersion(db: HubDb, dshVersion: string): RuntimeRow | undefined {
  return db.get<RuntimeRow>('SELECT * FROM runtimes WHERE dsh_version = ?', dshVersion)
}

export function getDefaultRuntimeRow(db: HubDb): RuntimeRow | undefined {
  return db.get<RuntimeRow>(
    "SELECT * FROM runtimes WHERE is_default = 1 AND status = 'ready' ORDER BY id LIMIT 1",
  )
}
export interface InsertRuntimeInput {
  dshVersion: string
  image: string
  status: RuntimeStatus
  notes: string
  at: string
}

export function insertRuntimeRow(db: HubDb, input: InsertRuntimeInput): number {
  const result = db.run(
    `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
    input.dshVersion,
    input.image,
    input.status,
    input.notes,
    input.at,
  )
  return result.lastInsertRowid
}

export interface UpdateRuntimeInput {
  status?: RuntimeStatus
  isDefault?: boolean
  imageId?: string | null
  sizeBytes?: number | null
  buildJobId?: number | null
  notes?: string
}

export function updateRuntimeRow(db: HubDb, runtimeId: number, patch: UpdateRuntimeInput): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  const push = (column: string, value: SqlParam): void => {
    sets.push(`${column} = ?`)
    params.push(value)
  }
  if (patch.status !== undefined) push('status', patch.status)
  if (patch.isDefault !== undefined) push('is_default', patch.isDefault ? 1 : 0)
  if (patch.imageId !== undefined) push('image_id', patch.imageId)
  if (patch.sizeBytes !== undefined) push('size_bytes', patch.sizeBytes)
  if (patch.buildJobId !== undefined) push('build_job_id', patch.buildJobId)
  if (patch.notes !== undefined) push('notes', patch.notes)
  if (sets.length === 0) return
  db.run(`UPDATE runtimes SET ${sets.join(', ')} WHERE id = ?`, ...params, runtimeId)
}

export function deleteRuntimeRow(db: HubDb, runtimeId: number): void {
  db.run('DELETE FROM runtimes WHERE id = ?', runtimeId)
}

/** 默认版本最多一个（部分唯一索引兜底，这里先清再设） */
export function clearDefaultRuntimes(db: HubDb): void {
  db.run('UPDATE runtimes SET is_default = 0 WHERE is_default = 1')
}

/** 钉在该版本上的用户数（`users.runtime_id`，期望状态） */
export function countUsersOnRuntime(db: HubDb, runtimeId: number): number {
  const row = db.get<{ n: number }>(
    // 系统账号（WP56b 的座舱 DSH hub-ops）不算「用户」：运行时的用户数只数真人
    'SELECT COUNT(*) AS n FROM users WHERE runtime_id = ? AND deleted_at IS NULL AND is_system = 0',
    runtimeId,
  )
  return Number(row?.n ?? 0)
}

/** 未钉版本（跟随默认）的用户数：默认版本行显示它更有意义 */
export function countUnpinnedUsers(db: HubDb): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM users WHERE runtime_id IS NULL AND deleted_at IS NULL AND is_system = 0',
  )
  return Number(row?.n ?? 0)
}

export interface RuntimeUserRow {
  id: number
  slug: string
  username: string
  runtime_id: number | null
  status: string
}

export function getUserRuntimeRow(db: HubDb, userId: number): RuntimeUserRow | undefined {
  return db.get<RuntimeUserRow>(
    'SELECT id, slug, username, runtime_id, status FROM users WHERE id = ? AND deleted_at IS NULL',
    userId,
  )
}

/** 把用户的期望版本写库（rollout 步骤 2；`null` = 跟随默认） */
export function setUserRuntime(db: HubDb, userId: number, runtimeId: number | null, at: string): void {
  db.run('UPDATE users SET runtime_id = ?, updated_at = ? WHERE id = ?', runtimeId, at, userId)
}

/** 下线/删除校验用的目标解析：所有用户（含 disabled，落实 06 §5.1） */
export function listRuntimeTargetUsers(db: HubDb, runtimeId: number): RuntimeUserRow[] {
  return db
    .all<RuntimeUserRow>(
      'SELECT id, slug, username, runtime_id, status FROM users WHERE deleted_at IS NULL ORDER BY id ASC',
    )
    .filter((row) => row.runtime_id === null || row.runtime_id === runtimeId)
}
