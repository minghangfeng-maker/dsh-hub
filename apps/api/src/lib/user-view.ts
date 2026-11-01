import { QuotaSchema, type Quota, type UserPublic } from '@dsh-hub/shared'
import type { HubDb } from '../db/index.js'

/**
 * `users` 表整行与视图映射（03 §1.1）。auth / me / admin-users 三个模块都要读它，
 * 放 lib 里避免各写一份 `SELECT` 列表与 `UserPublic` 映射（04 §0.1 的字段是契约）。
 */
export interface UserRecord {
  id: number
  slug: string
  username: string
  display_name: string
  bio: string
  avatar_file: string | null
  password_hash: string
  role: 'user' | 'admin'
  /** 普通用户的自定义角色标签（迁移 004）；空串 = 「普通用户」 */
  role_label: string
  status: 'pending' | 'active' | 'disabled'
  must_change_password: number
  quota_json: string | null
  runtime_id: number | null
  model_preset_id: number | null
  model_policy: 'managed' | 'free'
  username_changed_at: string | null
  last_login_at: string | null
  last_login_ip: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** 删除时的用户名（迁移 006）：回收站展示/恢复默认名；未删除为 NULL */
  deleted_username: string | null
  /** 删除前的状态（迁移 006）：恢复后回到它；存量数据为 NULL → 按 active */
  deleted_from_status: 'pending' | 'active' | 'disabled' | null
  /** 彻底删除时间（迁移 006）：NULL = 仍在回收站（仅 `deleted_at` 非空时有意义） */
  purged_at: string | null
  /** 数据目录在 `trash/` 下的相对路径（迁移 006），无数据为 NULL */
  trash_dir: string | null
}

/** users 表全部列（顺序固定，方便测试与 diff） */
export const USER_COLUMN_NAMES = [
  'id',
  'slug',
  'username',
  'display_name',
  'bio',
  'avatar_file',
  'password_hash',
  'role',
  'role_label',
  'status',
  'must_change_password',
  'quota_json',
  'runtime_id',
  'model_preset_id',
  'model_policy',
  'username_changed_at',
  'last_login_at',
  'last_login_ip',
  'created_at',
  'updated_at',
  'deleted_at',
  'deleted_username',
  'deleted_from_status',
  'purged_at',
  'trash_dir',
] as const

/** 带表别名的列列表（管理端列表要 join instances，必须限定 `u.` 前缀避免歧义） */
export function userColumns(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return USER_COLUMN_NAMES.map((name) => `${prefix}${name}`).join(', ')
}

/** 整行列表（不含表别名，查询里统一把 users 当主表） */
export const USER_COLUMNS = userColumns()

export function findUserById(db: HubDb, id: number): UserRecord | undefined {
  return db.get<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id)
}

/** 用户名一律小写比较（02 §5） */
export function findUserByUsername(db: HubDb, username: string): UserRecord | undefined {
  return db.get<UserRecord>(
    `SELECT ${USER_COLUMNS} FROM users WHERE username = ?`,
    username.trim().toLowerCase(),
  )
}

/** `users.avatar_file` → `UserPublic.avatarUrl`（文件名含哈希，见 03 §2） */
export function avatarUrlFor(avatarFile: string | null): string | null {
  return avatarFile ? `/api/avatars/${avatarFile}` : null
}

/** users 行 → `UserPublic`（04 §0.1，接口与前端共用的字段集） */
export function toUserPublic(row: UserRecord): UserPublic {
  return {
    id: row.id,
    slug: row.slug,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: avatarUrlFor(row.avatar_file),
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    usernameChangedAt: row.username_changed_at,
  }
}

/**
 * 用户生效配额：`quota_json` 覆盖全局默认 `settings.default_quota`（03 §1.5）。
 * 库里数据损坏时回退默认（宁可多给资源也不让管理端 500）。
 */
export function resolveQuota(
  quotaJson: string | null,
  fallback: Quota,
  onWarn?: (message: string) => void,
): { quota: Quota; isDefault: boolean } {
  if (!quotaJson) return { quota: fallback, isDefault: true }
  try {
    const parsed = QuotaSchema.safeParse(JSON.parse(quotaJson))
    if (!parsed.success) {
      onWarn?.('用户配额不合法，已回退全局默认')
      return { quota: fallback, isDefault: true }
    }
    return { quota: parsed.data, isDefault: false }
  } catch {
    onWarn?.('用户配额不是合法 JSON，已回退全局默认')
    return { quota: fallback, isDefault: true }
  }
}
