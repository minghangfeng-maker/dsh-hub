/**
 * 系统账号（WP56b / docs/24 §3.5）：`users.is_system = 1`。
 *
 * 现在只有一个：座舱 DSH 的 `hub-ops`。它是「机器账号」——
 * 不能登录、不出现在用户列表与统计、不计名额、不扣积分（中转站用量按来源 `cockpit` 记）。
 *
 * 判据只有库里的 `is_system` 列（`129_cockpit.sql` 加的），不要再拿 username 去比：
 * 用户名可以改，系统账号的判定不该跟着用户名走。
 *
 * @module @dsh-hub/api/lib/system-account
 */
import type { HubDb } from '../db/index.js'

/** 座舱系统账号的用户名（建号时用；不是查询判据）。 */
export const SYSTEM_ACCOUNT_USERNAME = 'hub-ops'
/** 座舱系统账号的 slug：容器名 = `dshhub-` + slug = `dshhub-ops`（`paths.ts` 有显式例外）。 */
export const SYSTEM_ACCOUNT_SLUG = 'ops'

/** 这个 `users.id` 是不是系统账号。 */
export function isSystemUserId(db: HubDb, userId: number): boolean {
  if (!Number.isInteger(userId) || userId <= 0) return false
  const row = db.get<{ is_system: number }>('SELECT is_system FROM users WHERE id = ?', userId)
  return row?.is_system === 1
}

/** 这批用户 id 里哪些是系统账号（列表过滤用，避免 N 次查询）。 */
export function systemUserIds(db: HubDb): Set<number> {
  const rows = db.all<{ id: number }>('SELECT id FROM users WHERE is_system = 1')
  return new Set(rows.map((row) => row.id))
}
