import type { ExportFormat, ExportItem, ExportPart, ExportProgress, ExportStatus } from '@dsh-hub/shared'
import { EXPORT_LIST_LIMIT } from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'
import { HubError } from '../../lib/errors.js'

/** `exports` 行（03 §1.3） */
export interface ExportRow {
  id: number
  user_id: number
  job_id: number | null
  parts_json: string
  format: ExportFormat
  status: ExportStatus
  file_name: string | null
  size_bytes: number | null
  sha256: string | null
  created_at: string
  expires_at: string | null
  downloaded: number
  error: string | null
}

export interface ExportUserRow {
  id: number
  slug: string
  username: string
  display_name: string
}

export interface ExportPatch {
  jobId?: number | null
  status?: ExportStatus
  fileName?: string | null
  fileSizeBytes?: number | null
  sha256?: string | null
  expiresAt?: string | null
  downloaded?: number
  error?: string | null
}

const COLUMNS: Record<keyof ExportPatch, string> = {
  jobId: 'job_id',
  status: 'status',
  fileName: 'file_name',
  fileSizeBytes: 'size_bytes',
  sha256: 'sha256',
  expiresAt: 'expires_at',
  downloaded: 'downloaded',
  error: 'error',
}

export function getUser(db: HubDb, userId: number): ExportUserRow | undefined {
  return db.get<ExportUserRow>('SELECT id, slug, username, display_name FROM users WHERE id = ?', userId)
}

export function requireUser(db: HubDb, userId: number): ExportUserRow {
  const user = getUser(db, userId)
  if (!user) throw new HubError('NOT_FOUND', '用户不存在')
  return user
}

export interface InsertExportInput {
  userId: number
  jobId?: number | null
  parts: ExportPart[]
  format: ExportFormat
  status: ExportStatus
  fileName: string | null
  createdAt: string
  expiresAt: string | null
}

export function insertExport(db: HubDb, input: InsertExportInput): number {
  const result = db.run(
    `INSERT INTO exports (user_id, job_id, parts_json, format, status, file_name, created_at, expires_at, downloaded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    input.userId,
    input.jobId ?? null,
    JSON.stringify(input.parts),
    input.format,
    input.status,
    input.fileName,
    input.createdAt,
    input.expiresAt,
  )
  return result.lastInsertRowid
}

export function updateExport(db: HubDb, id: number, patch: ExportPatch): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  for (const [key, column] of Object.entries(COLUMNS) as [keyof ExportPatch, string][]) {
    const value = patch[key]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    params.push(value as SqlParam)
  }
  if (sets.length === 0) return
  params.push(id)
  db.run(`UPDATE exports SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

export function deleteExport(db: HubDb, id: number): void {
  db.run('DELETE FROM exports WHERE id = ?', id)
}

export function getExportRow(db: HubDb, id: number): ExportRow | undefined {
  return db.get<ExportRow>('SELECT * FROM exports WHERE id = ?', id)
}

export function listExportRows(db: HubDb, userId: number, limit = EXPORT_LIST_LIMIT): ExportRow[] {
  return db.all<ExportRow>('SELECT * FROM exports WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit)
}

/** 今日已创建次数（每日次数限制，04 §3.3） */
export function countCreatedSince(db: HubDb, userId: number, sinceIso: string): number {
  return (
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM exports WHERE user_id = ? AND created_at >= ?',
      userId,
      sinceIso,
    )?.n ?? 0
  )
}

/** 进行中的导出（每用户串行：同一用户同时只能有一个 queued/running 的导出） */
export function countActive(db: HubDb, userId: number): number {
  return (
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM exports WHERE user_id = ? AND status IN ('queued','running')",
      userId,
    )?.n ?? 0
  )
}

/** 到期待清理的导出（status=ready 且 expires_at 已过） */
export function listExpiredRows(db: HubDb, nowIso: string, limit = 500): ExportRow[] {
  return db.all<ExportRow>(
    `SELECT * FROM exports
      WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY id ASC LIMIT ?`,
    nowIso,
    limit,
  )
}

export function parseParts(row: ExportRow): ExportPart[] {
  try {
    const parsed = JSON.parse(row.parts_json) as unknown
    return Array.isArray(parsed) ? (parsed as ExportPart[]) : []
  } catch {
    return []
  }
}

/** 行 → 04 §3.3 的 ExportItem（`progress` 只有进行中的导出才有） */
export function toExportItem(row: ExportRow, progress: ExportProgress | null = null): ExportItem {
  return {
    id: row.id,
    parts: parseParts(row),
    format: row.format,
    status: row.status,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    downloaded: row.downloaded === 1,
    error: row.error,
    progress,
  }
}
