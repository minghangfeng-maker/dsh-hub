import { z } from 'zod'
import { DesktopOverviewCountsSchema } from './desktop.js'
import { ModelKeyModeSchema } from './models.js'
import {
  AuditItemSchema,
  BooleanQuerySchema,
  InstanceStatusSchema,
  IsoDateTimeSchema,
  ModelPolicySchema,
  PageQuerySchema,
  PartialQuotaSchema,
  RoleLabelSchema,
  RoleSchema,
  SettingsSchema,
  UserAdminViewSchema,
  UserStatusSchema,
  pagedOf,
} from '../common.js'
import { INVITE_MAX_COUNT_PER_REQUEST, PASSWORD_MAX_LENGTH } from '../constants.js'
import { UserPluginRowSchema } from './plugins.js'
import { UsernameSchema } from './auth.js'

// ── GET /api/admin/overview ─────────────────────────────────────────────────

export const HostStatsSchema = z.object({
  cpuCount: z.number().int(),
  load1: z.number(),
  load5: z.number(),
  memTotal: z.number(),
  memAvailable: z.number(),
  diskTotal: z.number(),
  diskFree: z.number(),
  dockerOk: z.boolean(),
  dockerVersion: z.string().nullable(),
})
export type HostStats = z.infer<typeof HostStatsSchema>

export const AdminOverviewResponseSchema = z.object({
  users: z.object({
    total: z.number().int(),
    active: z.number().int(),
    pending: z.number().int(),
    disabled: z.number().int(),
    newToday: z.number().int(),
  }),
  instances: z.object({
    running: z.number().int(),
    max: z.number().int(),
    starting: z.number().int(),
    error: z.number().int(),
  }),
  host: HostStatsSchema,
  jobs: z.object({
    running: z.number().int(),
    queued: z.number().int(),
    failedLast24h: z.number().int(),
  }),
  runtime: z.object({
    defaultVersion: z.string().nullable(),
    versions: z.number().int(),
  }),
  recent: z.object({
    registrations: z.array(UserAdminViewSchema),
    audit: z.array(AuditItemSchema),
  }),
  /**
   * 桌面设备计数（WP25e 交付物 4，纯加法）：`total = online + stale + revoked`，
   * 判定口径见 04 §4.1。**可选**：老客户端与前端假数据没有这个键也照样能过契约。
   */
  desktop: DesktopOverviewCountsSchema.optional(),
})
export type AdminOverviewResponse = z.infer<typeof AdminOverviewResponseSchema>

// ── 用户列表 / 详情 ─────────────────────────────────────────────────────────

export const UserSortSchema = z.enum([
  'createdAt:desc',
  'createdAt:asc',
  'username:asc',
  'username:desc',
  'lastLoginAt:desc',
])
export type UserSort = z.infer<typeof UserSortSchema>

export const UserListQuerySchema = PageQuerySchema.extend({
  q: z.string().max(64).optional(),
  status: UserStatusSchema.optional(),
  role: RoleSchema.optional(),
  /** 只看某个角色标签的普通用户 */
  roleLabel: RoleLabelSchema.optional(),
  /** 只看某个实例状态，如 `instance=running` */
  instance: InstanceStatusSchema.optional(),
  sort: UserSortSchema.default('createdAt:desc'),
})
export type UserListQuery = z.infer<typeof UserListQuerySchema>

export const UserListResponseSchema = pagedOf(UserAdminViewSchema)
export type UserListResponse = z.infer<typeof UserListResponseSchema>

/** 04 §10.3：per-user 模式的提供方密钥状态（管理端用户详情展示） */
export const UserProviderKeySchema = z.object({
  providerId: z.number().int(),
  routeKey: z.string(),
  displayName: z.string(),
  keyMode: ModelKeyModeSchema,
  set: z.boolean(),
  last4: z.string().nullable(),
})
export type UserProviderKey = z.infer<typeof UserProviderKeySchema>

export const UserDetailResponseSchema = z.object({
  user: UserAdminViewSchema,
  plugins: z.array(UserPluginRowSchema),
  providerKeys: z.array(UserProviderKeySchema),
  sessions: z.number().int(),
  recentAudit: z.array(AuditItemSchema),
})
export type UserDetailResponse = z.infer<typeof UserDetailResponseSchema>

// ── POST /api/admin/users ───────────────────────────────────────────────────

export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
  displayName: z.string().max(32).optional(),
  role: RoleSchema.optional(),
  /** 仅 role=user 时生效；管理员一律存空串 */
  roleLabel: RoleLabelSchema.optional(),
})
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>

export const CreateUserResponseSchema = z.object({
  user: UserAdminViewSchema,
  /** 未提供密码时生成的 14 位临时密码，只显示一次 */
  tempPassword: z.string().optional(),
})
export type CreateUserResponse = z.infer<typeof CreateUserResponseSchema>

// ── PATCH /api/admin/users/:id ──────────────────────────────────────────────

export const UpdateUserRequestSchema = z.object({
  displayName: z.string().max(32).optional(),
  role: RoleSchema.optional(),
  /** 仅对（改完后）role=user 生效；改成管理员时自动清空 */
  roleLabel: RoleLabelSchema.optional(),
  status: UserStatusSchema.optional(),
  /** `null` = 恢复全局默认配额 */
  quota: PartialQuotaSchema.nullable().optional(),
  runtimeId: z.number().int().positive().nullable().optional(),
  modelPresetId: z.number().int().positive().nullable().optional(),
  modelPolicy: ModelPolicySchema.optional(),
})
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>

export const AdminUserResponseSchema = z.object({ user: UserAdminViewSchema })
export type AdminUserResponse = z.infer<typeof AdminUserResponseSchema>

// ── GET /api/admin/users/role-labels ────────────────────────────────────────

/** 已在用的角色标签（新建/编辑用户时的候选项，按人数倒序） */
export const RoleLabelUsageSchema = z.object({
  label: z.string(),
  count: z.number().int(),
})
export type RoleLabelUsage = z.infer<typeof RoleLabelUsageSchema>

export const RoleLabelListResponseSchema = z.object({ items: z.array(RoleLabelUsageSchema) })
export type RoleLabelListResponse = z.infer<typeof RoleLabelListResponseSchema>

// ── 用户操作 ────────────────────────────────────────────────────────────────

export const ResetPasswordResponseSchema = z.object({ tempPassword: z.string() })
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>

export const RevokeSessionsResponseSchema = z.object({ revoked: z.number().int().nonnegative() })
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponseSchema>

export const DeleteUserQuerySchema = z.object({
  /**
   * false（默认）：数据移入 trash/ 保留 `USER_TRASH_RETENTION_DAYS` 天，用户名**立即释放**，进回收站；
   * true：立即彻底删除，数据不进回收站（04 §8.9）
   */
  purge: BooleanQuerySchema.default(false),
})
export type DeleteUserQuery = z.infer<typeof DeleteUserQuerySchema>

// ── 回收站：已删除用户（04 §4.2，7 天内可恢复） ────────────────────────────

export const DeletedUserListQuerySchema = PageQuerySchema.extend({
  /** 搜索删除时的用户名 / 昵称 */
  q: z.string().max(64).optional(),
})
export type DeletedUserListQuery = z.infer<typeof DeletedUserListQuerySchema>

/** 回收站里的一条（删除时的用户快照；`username` 是删除时的用户名，不是现在的墓碑名） */
export const DeletedUserItemSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  /** 删除时的用户名：恢复时默认用它 */
  username: z.string(),
  displayName: z.string(),
  role: RoleSchema,
  roleLabel: z.string(),
  status: UserStatusSchema,
  deletedAt: IsoDateTimeSchema,
  /** 删除前的状态：恢复后回到这个状态（存量数据可能为 null → 按 active 处理） */
  deletedFromStatus: UserStatusSchema.nullable(),
  /** 数据目录是否已移入 trash/（true = 恢复时文件也能带回来） */
  dataInTrash: z.boolean(),
  /** 可恢复截止时间 = deletedAt + 7 天 */
  restorableUntil: IsoDateTimeSchema,
  /** 剩余可恢复天数（向上取整；<= 0 = 已过期，只能「彻底删除」） */
  daysLeft: z.number().int(),
})
export type DeletedUserItem = z.infer<typeof DeletedUserItemSchema>

export const DeletedUserListResponseSchema = pagedOf(DeletedUserItemSchema)
export type DeletedUserListResponse = z.infer<typeof DeletedUserListResponseSchema>

export const RestoreUserRequestSchema = z.object({
  /** 不给 = 用删除时的用户名；原用户名已被新用户占用时，管理员必须指定新用户名 */
  username: UsernameSchema.optional(),
})
export type RestoreUserRequest = z.infer<typeof RestoreUserRequestSchema>

/** 恢复成功 → 与 PATCH 一致的 `{ user }`（04 §4.2） */
export const RestoreUserResponseSchema = AdminUserResponseSchema
export type RestoreUserResponse = z.infer<typeof RestoreUserResponseSchema>

// ── 邀请码（04 §4.4） ───────────────────────────────────────────────────────

export const InviteUseSchema = z.object({
  userId: z.number().int(),
  username: z.string(),
  usedAt: IsoDateTimeSchema,
})
export type InviteUse = z.infer<typeof InviteUseSchema>

export const InviteRowSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  note: z.string(),
  maxUses: z.number().int(),
  usedCount: z.number().int(),
  expiresAt: IsoDateTimeSchema.nullable(),
  disabled: z.boolean(),
  createdBy: z.number().int().nullable(),
  createdAt: IsoDateTimeSchema,
  /** 用这个码注册的人得到的角色名（空串 = 「普通用户」）；邀请码没有 `role`，永远给不了管理员 */
  roleLabel: z.string(),
  uses: z.array(InviteUseSchema),
})
export type InviteRow = z.infer<typeof InviteRowSchema>

export const InviteListQuerySchema = PageQuerySchema
export type InviteListQuery = z.infer<typeof InviteListQuerySchema>

export const InviteListResponseSchema = pagedOf(InviteRowSchema)
export type InviteListResponse = z.infer<typeof InviteListResponseSchema>

export const CreateInvitesRequestSchema = z.object({
  count: z.number().int().min(1).max(INVITE_MAX_COUNT_PER_REQUEST).default(1),
  maxUses: z.number().int().min(1).max(1000).default(1),
  expiresAt: IsoDateTimeSchema.nullable().optional(),
  note: z.string().max(200).default(''),
  /** 用这个码注册的人得到的角色名；规则同用户（`'普通用户'` = 空串，`'管理员'` 保留） */
  roleLabel: RoleLabelSchema.default(''),
})
export type CreateInvitesRequest = z.infer<typeof CreateInvitesRequestSchema>

export const CreateInvitesResponseSchema = z.object({ items: z.array(InviteRowSchema) })
export type CreateInvitesResponse = z.infer<typeof CreateInvitesResponseSchema>

export const UpdateInviteRequestSchema = z.object({
  disabled: z.boolean().optional(),
  note: z.string().max(200).optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresAt: IsoDateTimeSchema.nullable().optional(),
  /** 改角色只影响之后用此码注册的人（已注册用户是快照） */
  roleLabel: RoleLabelSchema.optional(),
})
export type UpdateInviteRequest = z.infer<typeof UpdateInviteRequestSchema>

export const InviteResponseSchema = z.object({ invite: InviteRowSchema })
export type InviteResponse = z.infer<typeof InviteResponseSchema>

// ── 系统设置（04 §4.4） ─────────────────────────────────────────────────────

export const SettingsResponseSchema = SettingsSchema
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>

// ── 审计查询（04 §4.4） ─────────────────────────────────────────────────────

export const AuditListQuerySchema = PageQuerySchema.extend({
  actorId: z.coerce.number().int().positive().optional(),
  /** 精确匹配一个动作；写成 `desktop.*` 时按前缀匹配（既有行为，保持不变） */
  action: z.string().max(64).optional(),
  /**
   * 按动作前缀匹配（WP25e，与 `action` 二选一即可）：`actionPrefix=desktop.` 一次拿到
   * 下发 / 发布 / 回滚 / 地板 / 吊销 / 归类改名等全部桌面动作，不用并发查 5 次。
   */
  actionPrefix: z.string().trim().min(1).max(64).optional(),
  targetType: z.string().max(32).optional(),
  targetId: z.string().max(64).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
})
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>

export const AuditListResponseSchema = pagedOf(AuditItemSchema)
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>
