import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuditItem } from '@dsh-hub/shared'
import type { HubDb } from '../db/index.js'
import type { Clock } from './clock.js'

/**
 * 审计**上下文**（WP56a）：在一个异步调用链里给所有审计条目补 `detail`。
 *
 * 为什么需要它：座舱执行方案时会产生各能力自己的审计动作（`delivery.create`、`instances.stop`…），
 * 这些动作由各自的 service 自己写，签名里没有「方案 id」。docs/24 §7 要求它们在 `detail` 里带
 * `via='cockpit'`、`proposalId`、`sessionId`。与其改十几个 service 的签名，不如在执行期间放一个
 * AsyncLocalStorage 上下文，由 `createAuditLogger` 在写库时合并 —— 作用域随 async 调用链传播，
 * 不会串到别的请求（并发管理员各自在自己的链里）。
 */
export interface AuditContext {
  /** 强制指定 actor（R1 自动执行时是 hub-ops）；缺省沿用调用方给的 actorId */
  actorId?: number | null
  /** 合并进 `detail`（条目自己的 detail 优先，避免被上下文盖掉） */
  detail?: Record<string, unknown>
}

const auditContext = new AsyncLocalStorage<AuditContext>()

/** 在审计上下文里跑一段逻辑（同步/异步都行） */
export function runWithAuditContext<T>(context: AuditContext, fn: () => T): T {
  return auditContext.run(context, fn)
}

/** 当前审计上下文（没有时 undefined） */
export function currentAuditContext(): AuditContext | undefined {
  return auditContext.getStore()
}

export interface AuditEntry {
  /** 匿名操作（登录失败、注册被拒）留空 */
  actorId?: number | null
  actorIp?: string | null
  /** 04 §7 的取值，如 `auth.login.success` */
  action: string
  targetType?: string | null
  targetId?: string | number | null
  detail?: Record<string, unknown> | null
}

export interface AuditLogger {
  /**
   * 写一条审计（同步、不抛错：审计失败不该让业务失败）。
   * 返回新行的 id（座舱 `/ops/call` 的 `done.auditId` 要用）；失败/未写入返回 0。
   */
  log(entry: AuditEntry): number
  /** 最近 N 条（管理后台概览用；完整查询接口归 WP1） */
  recent(limit?: number): AuditItem[]
  /**
   * 某个对象最近 N 条审计（WP25e 设备详情用）。
   * **不返回 `actorIp`**：设备详情是「看这台机器」的页面，操作者 IP 留在完整审计视图里。
   */
  recentForTarget(targetType: string, targetId: string, limit?: number): AuditItemWithoutIp[]
}

/** 审计项去掉 `actorIp`（设备详情等「只回白名单字段」的地方用） */
export type AuditItemWithoutIp = Omit<AuditItem, 'actorIp'>

/** 查某个对象最近 N 条审计的列（有意不含 `a.actor_ip`） */
export const AUDIT_TARGET_COLUMNS = `a.id, a.at, a.actor_id,
       COALESCE(u.deleted_username, u.username) AS actor_username, a.action,
       a.target_type, a.target_id, a.detail_json`

export interface AuditRow {
  id: number
  at: string
  actor_id: number | null
  actor_ip: string | null
  actor_username: string | null
  action: string
  target_type: string | null
  target_id: string | null
  detail_json: string | null
}

/**
 * 审计查询的列（带 `a.` 前缀，配合 `FROM audit_logs a LEFT JOIN users u`）；管理端查询也用它。
 * 操作者可能已被删除（软删后 `username` 是墓碑名），展示用 `deleted_username` 还原删除时原名。
 */
export const AUDIT_COLUMNS = `a.id, a.at, a.actor_id, a.actor_ip,
       COALESCE(u.deleted_username, u.username) AS actor_username, a.action,
       a.target_type, a.target_id, a.detail_json`

/** 审计行 → `AuditItem`（04 §0.1；`detail_json` 损坏时按 null 处理，不让一条脏数据炸掉列表） */
export function auditItemFromRow(row: AuditRow): AuditItem {
  let detail: Record<string, unknown> | null = null
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json) as Record<string, unknown>
    } catch {
      detail = null
    }
  }
  return {
    id: row.id,
    at: row.at,
    actorId: row.actor_id,
    actorIp: row.actor_ip,
    actorUsername: row.actor_username,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail,
  }
}

/**
 * 审计日志（02 §5：登录、改名、改密、配额变更、实例起停、下发任务、密钥变更…都要记）。
 * 保留 180 天由清理任务负责（WP4/WP7a），这里只负责写与读。
 */
export function createAuditLogger(db: HubDb, clock: Clock): AuditLogger {
  return {
    log(entry) {
      try {
        const context = auditContext.getStore()
        const actorId = context?.actorId === undefined ? (entry.actorId ?? null) : context.actorId
        const detail =
          context?.detail === undefined
            ? entry.detail
            : { ...context.detail, ...(entry.detail ?? {}) }
        const result = db.run(
          `INSERT INTO audit_logs (at, actor_id, actor_ip, action, target_type, target_id, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          clock.nowIso(),
          actorId,
          entry.actorIp ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId === undefined || entry.targetId === null ? null : String(entry.targetId),
          detail ? JSON.stringify(detail) : null,
        )
        return result.lastInsertRowid
      } catch {
        // 审计写入失败不能影响业务；日志由调用方（pino）记录
        return 0
      }
    },
    recent(limit = 20) {
      const rows = db.all<AuditRow>(
        `SELECT ${AUDIT_COLUMNS}
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.id DESC
          LIMIT ?`,
        Math.max(1, Math.min(200, limit)),
      )
      return rows.map(auditItemFromRow)
    },
    recentForTarget(targetType, targetId, limit = 20) {
      const rows = db.all<AuditRow>(
        `SELECT ${AUDIT_TARGET_COLUMNS}
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.target_type = ? AND a.target_id = ?
          ORDER BY a.id DESC
          LIMIT ?`,
        targetType,
        targetId,
        Math.max(1, Math.min(200, limit)),
      )
      return rows.map((row) => {
        const item = auditItemFromRow(row)
        const { actorIp: _actorIp, ...rest } = item
        return rest
      })
    },
  }
}
