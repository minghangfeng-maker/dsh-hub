import type { InstanceProbeState, InstanceStatus, Quota, ModelPolicy } from '@dsh-hub/shared'
import type { HubDb } from '../../db/index.js'
import { HubError } from '../../lib/errors.js'

/**
 * `instances` 表（03 §1.2）与实例域需要的 `users` 只读字段。
 * SQL 只写在本文件里（11 §5）；DTO 字段 camelCase ←→ 列名 snake_case 的转换也在这里。
 */
/** 探针列（迁移 102；docs/22 §6.3）：全部可空，NULL = 还没探过（按未知状态走旧规则） */
export interface InstanceProbeRow {
  probe_state: InstanceProbeState | null
  probe_at: string | null
  running_sessions: number | null
  last_busy_at: string | null
  last_prompt_at: string | null
  last_client_at: string | null
}

export interface InstanceRow extends InstanceProbeRow {
  user_id: number
  container_id: string | null
  container_name: string
  runtime_id: number | null
  image: string | null
  status: InstanceStatus
  ip: string | null
  authority: string | null
  config_hash: string | null
  started_at: string | null
  last_active_at: string | null
  start_reason: string | null
  bootstrapped_at: string | null
  error: string | null
  updated_at: string
}

/** 实例域要用的用户字段（只读；写用户归 WP1） */
export interface InstanceUserRow {
  id: number
  slug: string
  username: string
  display_name: string
  avatar_file: string | null
  role: 'user' | 'admin'
  status: 'pending' | 'active' | 'disabled'
  quota_json: string | null
  runtime_id: number | null
  model_preset_id: number | null
  model_policy: ModelPolicy
  deleted_at: string | null
}

/** 管理端列表要的用户摘要（04 §4.3） */
export interface InstanceListRow extends InstanceProbeRow {
  user_id: number
  slug: string
  username: string
  display_name: string
  avatar_file: string | null
  status: InstanceStatus
  runtime_id: number | null
  image: string | null
  ip: string | null
  config_hash: string | null
  started_at: string | null
  last_active_at: string | null
  bootstrapped_at: string | null
  error: string | null
  updated_at: string | null
  quota_json: string | null
}

/** 探针一轮的结果（`setProbe`）：时间点只在有新值时才推进，NULL 表示「这一轮没拿到」 */
export interface ProbeUpdate {
  state: InstanceProbeState
  at: string
  runningSessions: number | null
  lastBusyAt?: string | null
  lastPromptAt?: string | null
  lastClientAt?: string | null
}

export interface MarkStartingInput {
  reason: string
  configHash: string
  runtimeId: number | null
  image: string
  authority: string
}

export interface InstanceRepo {
  find(userId: number): InstanceRow | undefined
  list(): InstanceRow[]
  listByStatus(statuses: InstanceStatus[]): InstanceRow[]
  listForAdmin(status?: InstanceStatus): InstanceListRow[]
  countByStatus(statuses: InstanceStatus[], exceptUserId?: number): number
  countAll(): Record<InstanceStatus, number>
  insertStopped(userId: number, containerName: string, authority: string): void
  markStarting(userId: number, input: MarkStartingInput): void
  setContainer(userId: number, containerId: string | null, ip: string | null): void
  markRunning(userId: number, input: { ip: string | null; startedAt: string | null; hash: string }): void
  markStopped(userId: number, opts?: { stopReason?: string }): void
  markError(userId: number, error: string): void
  setStatus(userId: number, status: InstanceStatus, extra?: { error?: string | null }): void
  setBootstrapped(userId: number): void
  setLastActive(userId: number, at: string): void
  /** 写探针结果（docs/22 §6.3）；时间点取「已有值与新值较晚者」，避免并行探针把时间写回去 */
  setProbe(userId: number, update: ProbeUpdate): void
  setRuntime(userId: number, runtimeId: number | null): void
  remove(userId: number): void
  findUser(userId: number): InstanceUserRow | undefined
  requireUser(userId: number): InstanceUserRow
  findUserBySlug(slug: string): InstanceUserRow | undefined
}

const STATUS_ALL: InstanceStatus[] = ['absent', 'stopped', 'starting', 'running', 'stopping', 'error']

export function createInstanceRepo(db: HubDb, now: () => string): InstanceRepo {
  const insertRow = () =>
    db.prepare(
      `INSERT INTO instances (user_id, container_name, status, authority, updated_at)
       VALUES (?, ?, 'stopped', ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )

  function touch(userId: number, extra?: { status?: InstanceStatus; error?: string | null }): void {
    if (extra?.status !== undefined) {
      db.run(
        'UPDATE instances SET status = ?, error = ?, updated_at = ? WHERE user_id = ?',
        extra.status,
        extra.error ?? null,
        now(),
        userId,
      )
      return
    }
    if (extra && 'error' in extra) {
      db.run(
        'UPDATE instances SET error = ?, updated_at = ? WHERE user_id = ?',
        extra.error ?? null,
        now(),
        userId,
      )
      return
    }
    db.run('UPDATE instances SET updated_at = ? WHERE user_id = ?', now(), userId)
  }

  return {
    find(userId) {
      return db.get<InstanceRow>('SELECT * FROM instances WHERE user_id = ?', userId)
    },
    list() {
      return db.all<InstanceRow>('SELECT * FROM instances ORDER BY user_id')
    },
    listByStatus(statuses) {
      if (statuses.length === 0) return []
      const placeholders = statuses.map(() => '?').join(', ')
      return db.all<InstanceRow>(
        `SELECT * FROM instances WHERE status IN (${placeholders}) ORDER BY user_id`,
        ...statuses,
      )
    },
    listForAdmin(status) {
      const base = `SELECT i.user_id, u.slug, u.username, u.display_name, u.avatar_file, i.status,
                           i.runtime_id, i.image, i.ip, i.config_hash, i.started_at, i.last_active_at,
                           i.bootstrapped_at, i.error, i.updated_at, u.quota_json,
                           i.probe_state, i.probe_at, i.running_sessions,
                           i.last_busy_at, i.last_prompt_at, i.last_client_at
                      FROM instances i
                      JOIN users u ON u.id = i.user_id
                     WHERE u.deleted_at IS NULL`
      if (status) {
        return db.all<InstanceListRow>(`${base} AND i.status = ? ORDER BY i.user_id`, status)
      }
      return db.all<InstanceListRow>(`${base} ORDER BY i.user_id`)
    },
    countByStatus(statuses, exceptUserId) {
      if (statuses.length === 0) return 0
      const placeholders = statuses.map(() => '?').join(', ')
      const row =
        exceptUserId === undefined
          ? db.get<{ n: number }>(
              `SELECT COUNT(*) AS n FROM instances WHERE status IN (${placeholders})`,
              ...statuses,
            )
          : db.get<{ n: number }>(
              `SELECT COUNT(*) AS n FROM instances WHERE status IN (${placeholders}) AND user_id <> ?`,
              ...statuses,
              exceptUserId,
            )
      return Number(row?.n ?? 0)
    },
    countAll() {
      const result = Object.fromEntries(STATUS_ALL.map((s) => [s, 0])) as Record<InstanceStatus, number>
      for (const row of db.all<{ status: InstanceStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM instances GROUP BY status',
      )) {
        if (STATUS_ALL.includes(row.status)) result[row.status] = Number(row.n)
      }
      return result
    },
    insertStopped(userId, containerName, authority) {
      insertRow().run(userId, containerName, authority, now())
    },
    markStarting(userId, input) {
      db.run(
        `UPDATE instances
            SET status = 'starting', start_reason = ?, config_hash = ?, runtime_id = ?, image = ?,
                authority = ?, error = NULL, updated_at = ?
          WHERE user_id = ?`,
        input.reason,
        input.configHash,
        input.runtimeId,
        input.image,
        input.authority,
        now(),
        userId,
      )
    },
    setContainer(userId, containerId, ip) {
      db.run(
        'UPDATE instances SET container_id = ?, ip = ?, updated_at = ? WHERE user_id = ?',
        containerId,
        ip,
        now(),
        userId,
      )
    },
    markRunning(userId, input) {
      // started_at 每次都按传入值覆盖（原来的 COALESCE 会保留重启前的时刻）：
      // 空闲回收以 max(last_active_at, started_at) 为起点，重启/重建/对账恢复必须从**这次**启动重新计时，
      // 否则刚被管理员重启、还没人访问的实例会立刻被判定为空闲（WP15）。
      db.run(
        `UPDATE instances
            SET status = 'running', ip = ?, started_at = ?, config_hash = ?,
                error = NULL, updated_at = ?
          WHERE user_id = ?`,
        input.ip,
        input.startedAt,
        input.hash,
        now(),
        userId,
      )
    },
    markStopped(userId, opts) {
      db.run(
        `UPDATE instances
            SET status = 'stopped', ip = NULL, error = NULL, started_at = NULL,
                last_active_at = COALESCE(?, last_active_at), updated_at = ?
          WHERE user_id = ?`,
        opts?.stopReason ?? null,
        now(),
        userId,
      )
    },
    markError(userId, error) {
      db.run(
        `UPDATE instances SET status = 'error', error = ?, updated_at = ? WHERE user_id = ?`,
        error,
        now(),
        userId,
      )
    },
    setStatus(userId, status, extra) {
      db.run('UPDATE instances SET status = ?, updated_at = ? WHERE user_id = ?', status, now(), userId)
      if (extra && 'error' in extra) touch(userId, { error: extra.error ?? null })
    },
    setBootstrapped(userId) {
      db.run(
        'UPDATE instances SET bootstrapped_at = ?, updated_at = ? WHERE user_id = ?',
        now(),
        now(),
        userId,
      )
    },
    setLastActive(userId, at) {
      db.run('UPDATE instances SET last_active_at = ? WHERE user_id = ?', at, userId)
    },
    setProbe(userId, update) {
      const current = db.get<InstanceProbeRow>(
        `SELECT probe_state, probe_at, running_sessions, last_busy_at, last_prompt_at, last_client_at
           FROM instances WHERE user_id = ?`,
        userId,
      )
      if (!current) return
      db.run(
        `UPDATE instances
            SET probe_state = ?, probe_at = ?, running_sessions = ?,
                last_busy_at = ?, last_prompt_at = ?, last_client_at = ?
          WHERE user_id = ?`,
        update.state,
        update.at,
        update.runningSessions,
        laterOf(current.last_busy_at, update.lastBusyAt ?? null),
        laterOf(current.last_prompt_at, update.lastPromptAt ?? null),
        laterOf(current.last_client_at, update.lastClientAt ?? null),
        userId,
      )
    },
    setRuntime(userId, runtimeId) {
      db.run(
        'UPDATE instances SET runtime_id = ?, updated_at = ? WHERE user_id = ?',
        runtimeId,
        now(),
        userId,
      )
    },
    remove(userId) {
      db.run('DELETE FROM instances WHERE user_id = ?', userId)
    },
    findUser(userId) {
      return db.get<InstanceUserRow>(
        `SELECT id, slug, username, display_name, avatar_file, role, status, quota_json,
                runtime_id, model_preset_id, model_policy, deleted_at
           FROM users WHERE id = ?`,
        userId,
      )
    },
    requireUser(userId) {
      const user = this.findUser(userId)
      if (!user || user.deleted_at) throw new HubError('NOT_FOUND', '用户不存在')
      return user
    },
    findUserBySlug(slug) {
      return db.get<InstanceUserRow>(
        `SELECT id, slug, username, display_name, avatar_file, role, status, quota_json,
                runtime_id, model_preset_id, model_policy, deleted_at
           FROM users WHERE slug = ?`,
        slug,
      )
    },
  }
}

/** 两个 ISO 时间里较晚的那个（NULL 安全）；用于探针时间点只前进不后退 */
export function laterOf(existing: string | null, next: string | null): string | null {
  if (!existing) return next
  if (!next) return existing
  return next > existing ? next : existing
}

/** `users.quota_json` → Quota（为空/损坏时由调用方回退全局默认，03 §1.5） */
export function parseQuotaJson(raw: string | null): Partial<Quota> | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    return value as Partial<Quota>
  } catch {
    return null
  }
}
