import type {
  JobListQuery,
  JobStatus,
  JobSummary,
  JobTaskStatus,
  JobTaskSummary,
  Strategy,
} from '@dsh-hub/shared'
import type { HubDb, SqlParam } from '../../db/index.js'
import { HubError } from '../../lib/errors.js'
import type { JobTaskRow } from './types.js'

/** `jobs` 行（03 §1.3） */
export interface JobRow {
  id: number
  type: string
  title: string
  status: JobStatus
  params_json: string
  strategy_json: string | null
  total: number
  done: number
  failed: number
  created_by: number | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
}

interface JobJoinedRow extends JobRow {
  created_by_username: string | null
}

/** `job_tasks` 行（03 §1.3；payload_json 是 WP4 的补充列） */
interface TaskDbRow {
  id: number
  job_id: number
  seq: number
  user_id: number | null
  status: JobTaskStatus
  attempt: number
  log: string
  payload_json: string | null
  result_json: string | null
  started_at: string | null
  finished_at: string | null
  error: string | null
}

interface TaskJoinedRow extends TaskDbRow {
  username: string | null
}

/** 04 §4.8 的策略默认值（shared 的 StrategySchema 同源） */
export const DEFAULT_STRATEGY: Strategy = {
  concurrency: 3,
  canary: 1,
  maxFailureRatio: 0.2,
  restart: 'now',
}

export interface TaskCounts {
  total: number
  pending: number
  running: number
  succeeded: number
  failed: number
  canceled: number
  skipped: number
}

export interface JobPatch {
  title?: string
  status?: JobStatus
  strategyJson?: string | null
  total?: number
  done?: number
  failed?: number
  startedAt?: string | null
  finishedAt?: string | null
  error?: string | null
}

export interface TaskPatch {
  status?: JobTaskStatus
  attempt?: number
  log?: string
  resultJson?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  error?: string | null
}

const JOB_COLUMNS: Record<keyof JobPatch, string> = {
  title: 'title',
  status: 'status',
  strategyJson: 'strategy_json',
  total: 'total',
  done: 'done',
  failed: 'failed',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  error: 'error',
}

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  status: 'status',
  attempt: 'attempt',
  log: 'log',
  resultJson: 'result_json',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  error: 'error',
}

// ── 序列化 / 反序列化 ───────────────────────────────────────────────────────

/** 容错解析 strategy_json：坏数据回退默认策略（不能让一条脏行卡死整个引擎） */
export function parseStrategy(json: string | null): Strategy {
  if (!json) return DEFAULT_STRATEGY
  try {
    const raw = JSON.parse(json) as Partial<Strategy>
    return {
      concurrency: clampInt(raw.concurrency ?? DEFAULT_STRATEGY.concurrency, 1, 8),
      canary: clampInt(raw.canary ?? DEFAULT_STRATEGY.canary, 0, 5),
      maxFailureRatio: clampNumber(raw.maxFailureRatio ?? DEFAULT_STRATEGY.maxFailureRatio, 0, 1),
      restart: raw.restart === 'next-start' ? 'next-start' : 'now',
    }
  } catch {
    return DEFAULT_STRATEGY
  }
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : min
  return Math.min(max, Math.max(min, n))
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, n))
}

function parseJsonColumn(json: string | null): unknown {
  if (json === null || json === '') return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

// ── 写入 ────────────────────────────────────────────────────────────────────

export interface InsertJobInput {
  type: string
  title: string
  status: JobStatus
  params: unknown
  strategy: Strategy
  total: number
  createdBy: number | null
  createdAt: string
}

export function insertJob(db: HubDb, input: InsertJobInput): number {
  const result = db.run(
    `INSERT INTO jobs (type, title, status, params_json, strategy_json, total, done, failed, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    input.type,
    input.title,
    input.status,
    JSON.stringify(input.params ?? null),
    JSON.stringify(input.strategy),
    input.total,
    input.createdBy,
    input.createdAt,
  )
  return result.lastInsertRowid
}

/** 批量写任务；seq 从 1 开始（调用方保证金丝雀任务在前） */
export function insertTasks(
  db: HubDb,
  jobId: number,
  tasks: { userId: number | null; payload?: unknown }[],
): void {
  let seq = 1
  for (const task of tasks) {
    db.run(
      `INSERT INTO job_tasks (job_id, seq, user_id, status, attempt, log, payload_json)
       VALUES (?, ?, ?, 'pending', 0, '', ?)`,
      jobId,
      seq,
      task.userId,
      task.payload === undefined ? null : JSON.stringify(task.payload),
    )
    seq += 1
  }
}

export function updateJob(db: HubDb, id: number, patch: JobPatch): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  for (const [key, column] of Object.entries(JOB_COLUMNS) as [keyof JobPatch, string][]) {
    const value = patch[key]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    params.push(value as SqlParam)
  }
  if (sets.length === 0) return
  params.push(id)
  db.run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

export function updateTask(db: HubDb, id: number, patch: TaskPatch): void {
  const sets: string[] = []
  const params: SqlParam[] = []
  for (const [key, column] of Object.entries(TASK_COLUMNS) as [keyof TaskPatch, string][]) {
    const value = patch[key]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    params.push(value as SqlParam)
  }
  if (sets.length === 0) return
  params.push(id)
  db.run(`UPDATE job_tasks SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

/**
 * 追加任务日志：单条上限 256KB，超出截断**头部**（03 §1.3 / 06 §5.2）。
 * 截断在 SQL 里做，避免把整个日志读进内存再写回。
 */
export function appendTaskLog(db: HubDb, taskId: number, chunk: string, maxBytes = 256 * 1024): void {
  if (chunk.length === 0) return
  // SQLite 的 substr 按字符算，ASCII 日志与字节数近似；用 +1 保证不会把最后一条截半行
  const maxChars = Math.max(1024, maxBytes)
  db.run(`UPDATE job_tasks SET log = substr(log || ?, -?) WHERE id = ?`, chunk, maxChars, taskId)
}

// ── 读取 ────────────────────────────────────────────────────────────────────

export function getJobRow(db: HubDb, id: number): JobRow | undefined {
  return db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id)
}

function toSummary(row: JobJoinedRow): JobSummary {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    total: row.total,
    done: row.done,
    failed: row.failed,
    createdBy: row.created_by,
    createdByUsername: row.created_by_username,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

export function jobSummary(db: HubDb, id: number): JobSummary | undefined {
  const row = db.get<JobJoinedRow>(
    `SELECT j.*, COALESCE(u.deleted_username, u.username) AS created_by_username
       FROM jobs j LEFT JOIN users u ON u.id = j.created_by
      WHERE j.id = ?`,
    id,
  )
  return row ? toSummary(row) : undefined
}

export function listJobs(db: HubDb, query: JobListQuery): { items: JobSummary[]; total: number } {
  const where: string[] = []
  const params: SqlParam[] = []
  if (query.type) {
    where.push('j.type = ?')
    params.push(query.type)
  }
  if (query.status) {
    where.push('j.status = ?')
    params.push(query.status)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs j ${clause}`, ...params)?.n ?? 0
  const rows = db.all<JobJoinedRow>(
    `SELECT j.*, COALESCE(u.deleted_username, u.username) AS created_by_username
       FROM jobs j LEFT JOIN users u ON u.id = j.created_by
       ${clause}
      ORDER BY j.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    query.pageSize,
    (query.page - 1) * query.pageSize,
  )
  return { items: rows.map(toSummary), total }
}

function toTaskRow(row: TaskDbRow): JobTaskRow {
  return {
    id: row.id,
    jobId: row.job_id,
    seq: row.seq,
    userId: row.user_id,
    username: (row as TaskJoinedRow).username ?? null,
    status: row.status,
    attempt: row.attempt,
    log: row.log,
    resultJson: row.result_json,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    payload: parseJsonColumn(row.payload_json),
  }
}

const TASK_SELECT = `SELECT t.*, COALESCE(u.deleted_username, u.username) AS username
                       FROM job_tasks t LEFT JOIN users u ON u.id = t.user_id`

export function getTaskRows(db: HubDb, jobId: number): JobTaskRow[] {
  return db.all<TaskJoinedRow>(`${TASK_SELECT} WHERE t.job_id = ? ORDER BY t.seq ASC`, jobId).map(toTaskRow)
}

export function getTaskRow(db: HubDb, jobId: number, taskId: number): JobTaskRow | undefined {
  const row = db.get<TaskJoinedRow>(`${TASK_SELECT} WHERE t.id = ? AND t.job_id = ?`, taskId, jobId)
  return row ? toTaskRow(row) : undefined
}

export function getTaskRowById(db: HubDb, taskId: number): JobTaskRow | undefined {
  const row = db.get<TaskJoinedRow>(`${TASK_SELECT} WHERE t.id = ?`, taskId)
  return row ? toTaskRow(row) : undefined
}

export function taskSummary(db: HubDb, taskId: number): JobTaskSummary | undefined {
  const row = db.get<TaskJoinedRow>(`${TASK_SELECT} WHERE t.id = ?`, taskId)
  return row ? toTaskSummary(row) : undefined
}

export function listTaskSummaries(db: HubDb, jobId: number): JobTaskSummary[] {
  return db
    .all<TaskJoinedRow>(`${TASK_SELECT} WHERE t.job_id = ? ORDER BY t.seq ASC`, jobId)
    .map(toTaskSummary)
}

function toTaskSummary(row: TaskJoinedRow): JobTaskSummary {
  return {
    id: row.id,
    seq: row.seq,
    userId: row.user_id,
    username: row.username,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

export function countTasks(db: HubDb, jobId: number): TaskCounts {
  const row = db.get<Record<string, number>>(
    `SELECT COUNT(*) AS total,
            SUM(status = 'pending')   AS pending,
            SUM(status = 'running')   AS running,
            SUM(status = 'succeeded') AS succeeded,
            SUM(status = 'failed')    AS failed,
            SUM(status = 'canceled')  AS canceled,
            SUM(status = 'skipped')   AS skipped
       FROM job_tasks WHERE job_id = ?`,
    jobId,
  )
  return {
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    running: row?.running ?? 0,
    succeeded: row?.succeeded ?? 0,
    failed: row?.failed ?? 0,
    canceled: row?.canceled ?? 0,
    skipped: row?.skipped ?? 0,
  }
}

/** 调度循环的候选 job：queued / running，按 id（先来先服务） */
export function listActiveJobRows(db: HubDb): JobRow[] {
  return db.all<JobRow>("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY id ASC")
}

export function listTaskRowsByStatus(db: HubDb, jobId: number, status: JobTaskStatus): JobTaskRow[] {
  return db
    .all<TaskDbRow>('SELECT * FROM job_tasks WHERE job_id = ? AND status = ? ORDER BY seq ASC', jobId, status)
    .map(toTaskRow)
}

export function countJobsByStatus(db: HubDb, status: JobStatus): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE status = ?', status)?.n ?? 0
}

/** 概览用：最近 24 小时内失败/部分失败的 job 数 */
export function countFailedSince(db: HubDb, sinceIso: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE status IN ('failed','partial') AND finished_at IS NOT NULL AND finished_at >= ?`,
      sinceIso,
    )?.n ?? 0
  )
}

// ── 重启恢复 ────────────────────────────────────────────────────────────────

/**
 * Hub 重启后的恢复（06 §5.2）：`running` 的 task 标 `failed`（error='hub restarted'），
 * 对应的 job 置 `paused` 等管理员处理；计数按任务实际状态重算。
 */
export function recoverRunningJobs(
  db: HubDb,
  nowIso: string,
  error = 'hub restarted',
): {
  failedTasks: number
  pausedJobs: number
} {
  return db.tx(() => {
    const jobIds = db
      .all<{ job_id: number }>('SELECT DISTINCT job_id FROM job_tasks WHERE status = ?', 'running')
      .map((row) => row.job_id)
    let failedTasks = 0
    if (jobIds.length > 0) {
      const result = db.run(
        `UPDATE job_tasks SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'`,
        error,
        nowIso,
      )
      failedTasks = result.changes
    }
    let pausedJobs = 0
    for (const jobId of jobIds) {
      const counts = countTasks(db, jobId)
      const job = getJobRow(db, jobId)
      if (!job) continue
      updateJob(db, jobId, {
        status: 'paused',
        done: counts.succeeded,
        failed: counts.failed,
        finishedAt: null,
        error,
      })
      pausedJobs += 1
    }
    return { failedTasks, pausedJobs }
  })
}

/** 供引擎/接口层用：拿不到 job 行时抛 404 */
export function requireJobRow(db: HubDb, id: number): JobRow {
  const row = getJobRow(db, id)
  if (!row) throw new HubError('NOT_FOUND', '任务不存在')
  return row
}

export { parseJsonColumn }
