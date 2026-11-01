import { USERNAME_REGEX, isReservedUsername } from '@dsh-hub/shared'
import type { HubDb } from '../db/index.js'
import { HubError } from './errors.js'
import { findUserByUsername } from './user-view.js'

/**
 * 用户名规则（02 §5）：统一小写、`^[a-z][a-z0-9_-]{2,31}$`、保留字、唯一。
 * 注册 / 改名 / 管理员建号三处共用，规则只能有一份。
 */

export const USERNAME_RULE_MESSAGE = '只能包含小写字母、数字、- 和 _，且以字母开头，3–32 位'

/** 规整（trim + 小写）；schema 层已经规整过一次，直接调服务时也不怕 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase()
}

/** 格式不合法 → `VALIDATION_FAILED` + `details.fields.username`（04 §0） */
export function assertUsernameFormat(username: string): void {
  if (!USERNAME_REGEX.test(username)) {
    throw new HubError('VALIDATION_FAILED', undefined, { fields: { username: USERNAME_RULE_MESSAGE } })
  }
}

/** 保留字 → 400 `USERNAME_RESERVED`；已被占用 → 409 `USERNAME_TAKEN` */
export function assertUsernameAvailable(db: HubDb, username: string, exceptUserId?: number): void {
  assertUsernameFormat(username)
  if (isReservedUsername(username)) throw new HubError('USERNAME_RESERVED')
  const existing = findUserByUsername(db, username)
  if (existing && existing.id !== exceptUserId) throw new HubError('USERNAME_TAKEN')
}

/** 用户名是否可用（`check-username` 用，不抛错） */
export function usernameAvailability(
  db: HubDb,
  raw: string,
): { available: boolean; reason?: 'taken' | 'reserved' | 'invalid' } {
  const username = normalizeUsername(raw)
  if (!USERNAME_REGEX.test(username)) return { available: false, reason: 'invalid' }
  if (isReservedUsername(username)) return { available: false, reason: 'reserved' }
  if (findUserByUsername(db, username)) return { available: false, reason: 'taken' }
  return { available: true }
}
