/**
 * 座舱 DSH 的库访问（WP56b）：系统账号 `hub-ops` 与 `cockpit_ops_instance` 单行表。
 *
 * 约定（CONTRIBUTING.md 的工程约定）：SQL 只出现在 repo 里，全部参数化。表结构见迁移
 * `129_cockpit.sql`（`users.is_system`，WP56a）与 `130_cockpit_ops.sql`（本包）。
 *
 * @module @dsh-hub/api/modules/cockpit/ops-repo
 */
import type { HubDb } from '../../db/index.js'
import { SYSTEM_ACCOUNT_SLUG, SYSTEM_ACCOUNT_USERNAME } from '../../lib/system-account.js'

/** 系统账号的固定身份：slug 决定容器名（`dshhub-` + slug = `dshhub-ops`）与数据目录。 */
export const SYSTEM_USER_SLUG = SYSTEM_ACCOUNT_SLUG
export const SYSTEM_USER_NAME = SYSTEM_ACCOUNT_USERNAME
export const SYSTEM_USER_DISPLAY_NAME = '座舱 DSH'

/** 座舱容器的固定名字（= 容器名前缀 + 系统账号 slug）。 */
export const OPS_CONTAINER_NAME = 'dshhub-ops'

export interface SystemUserRow {
  id: number
  slug: string
  username: string
  status: string
  role: string
}

/** 系统账号（`users.is_system = 1`）；没有就 undefined。 */
export function findSystemUser(db: HubDb): SystemUserRow | undefined {
  const row = db.get<{ id: number; slug: string; username: string; status: string; role: string }>(
    `SELECT id, slug, username, status, role FROM users WHERE is_system = 1 ORDER BY id LIMIT 1`,
  )
  return row ?? undefined
}

/**
 * 建系统账号（只在不存在时调用）。
 *
 * `role` 只能是 `user`：`admin` 会拿到管理端 cookie 权限，而 docs/24 §3.5 明确
 * 「系统账号不能用 role='admin' 提权」——它的全部能力都从 `/ops/*` 走。
 * `password_hash` 是**一次性随机口令**的哈希（原文丢弃）：账号不能登录（`auth` 里按
 * `is_system` 拒绝），这个哈希只是为了满足 NOT NULL 与「任何路径下都验不过」。
 */
export function insertSystemUser(db: HubDb, input: { passwordHash: string; at: string }): number {
  db.run(
    `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                        must_change_password, model_policy, created_at, updated_at, is_system)
     VALUES (?, ?, ?, '', ?, 'user', 'active', 0, 'managed', ?, ?, 1)`,
    SYSTEM_USER_SLUG,
    SYSTEM_USER_NAME,
    SYSTEM_USER_DISPLAY_NAME,
    input.passwordHash,
    input.at,
    input.at,
  )
  const row = db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', SYSTEM_USER_NAME)
  if (row === undefined) throw new Error('系统账号创建失败')
  return row.id
}

export interface OpsInstanceRow {
  tokenHash: string
  containerName: string
  containerIp: string | null
}

/** `cockpit_ops_instance` 的唯一一行（还没写过时 undefined）。 */
export function getOpsInstanceRow(db: HubDb): OpsInstanceRow | undefined {
  const row = db.get<{ token_hash: string; container_name: string; container_ip: string | null }>(
    'SELECT token_hash, container_name, container_ip FROM cockpit_ops_instance WHERE id = 1',
  )
  if (row === undefined) return undefined
  return { tokenHash: row.token_hash, containerName: row.container_name, containerIp: row.container_ip }
}

/** 覆盖写那一行（令牌轮换 / 容器 IP 变化都走它）。 */
export function saveOpsInstanceRow(
  db: HubDb,
  input: { tokenHash: string; containerName: string; containerIp: string | null; at: string },
): void {
  db.run(
    `INSERT INTO cockpit_ops_instance (id, token_hash, container_name, container_ip, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       token_hash = excluded.token_hash,
       container_name = excluded.container_name,
       container_ip = excluded.container_ip,
       updated_at = excluded.updated_at`,
    input.tokenHash,
    input.containerName,
    input.containerIp,
    input.at,
  )
}

/**
 * 只回写容器 IP（普通启动：令牌没变，只是可能换了 IP）。
 * `updated_at` 也更新，便于排障时看出「Hub 什么时候确认过这个 IP」。
 */
export function saveOpsInstanceIp(db: HubDb, input: { containerIp: string; at: string }): void {
  db.run(
    'UPDATE cockpit_ops_instance SET container_ip = ?, updated_at = ? WHERE id = 1',
    input.containerIp,
    input.at,
  )
}

/**
 * 直接读 `settings` 表里某个键的原始 JSON（不经过 SettingsStore 的 key 白名单）。
 *
 * 为什么需要：`settings.cockpit` 这个键由 WP56a 加进 shared 的 key 表，两个包并行开发时
 * 本分支的 SettingsStore 还不认识它（`get()` 回退默认值）。这里读原始行 + 自己的 zod 校验，
 * 保证「读座舱设置」在合并前后行为一致；合并后走 store 的那条路优先。
 */
export function readSettingsJson(db: HubDb, key: string): unknown {
  const row = db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key)
  if (row === undefined) return undefined
  try {
    return JSON.parse(row.value_json) as unknown
  } catch {
    return undefined
  }
}
