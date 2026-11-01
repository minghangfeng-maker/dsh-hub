import type {
  AdminOverviewResponse,
  AdminUserResponse,
  AuditListQuery,
  AuditListResponse,
  CreateInvitesRequest,
  CreateInvitesResponse,
  CreateUserRequest,
  CreateUserResponse,
  DeletedUserListQuery,
  DeletedUserListResponse,
  DeleteUserQuery,
  InviteResponse,
  InviteRow,
  InviteListQuery,
  InviteListResponse,
  ResetPasswordResponse,
  RestoreUserRequest,
  RevokeSessionsResponse,
  RoleLabelListResponse,
  SettingsResponse,
  UpdateInviteRequest,
  UpdateSettingsRequest,
  UpdateUserRequest,
  UserDetailResponse,
  UserListQuery,
  UserListResponse,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'

/** 管理端写操作的调用者：审计的 actor 与「不能删自己」的判断都要用 */
export interface AdminActor extends RequestMeta {
  actorId: number
}

/**
 * 管理端用户服务（04 §4.1 §4.2；WP1 实现）。
 * 所有写操作都要写审计（04 §7），删除用户走 trash/ 保留 7 天。
 */
export interface AdminUsersService {
  /** 概览：用户统计 + 最近注册与审计（实例/宿主/任务/版本字段归 WP2/WP3/WP4，先占位） */
  overview(): Promise<AdminOverviewResponse>
  listUsers(query: UserListQuery): Promise<UserListResponse>
  /** 普通用户在用的角色标签及人数（新建/编辑用户时的候选项） */
  roleLabels(): Promise<RoleLabelListResponse>
  createUser(input: CreateUserRequest, actor: AdminActor): Promise<CreateUserResponse>
  /** 详情：UserPublic + 插件状态 + 会话数 + 相关审计 */
  getUser(userId: number): Promise<UserDetailResponse>
  updateUser(userId: number, input: UpdateUserRequest, actor: AdminActor): Promise<AdminUserResponse>
  approve(userId: number, actor: AdminActor): Promise<AdminUserResponse>
  /** 生成 14 位临时密码并置 must_change_password（需 reauth，由路由层保证） */
  resetPassword(userId: number, actor: AdminActor): Promise<ResetPasswordResponse>
  revokeSessions(userId: number, actor: AdminActor): Promise<RevokeSessionsResponse>
  /** 停容器 → 删容器 → 数据移入 trash/（purge=true 时直接删）；同时软删除并立即释放用户名 */
  deleteUser(userId: number, query: DeleteUserQuery, actor: AdminActor): Promise<void>
  /** 回收站列表（`deleted_at` 非空且未彻底删除，按删除时间倒序） */
  listDeletedUsers(query: DeletedUserListQuery): Promise<DeletedUserListResponse>
  /** 7 天内从回收站恢复；原名被占用时由管理员指定新用户名（需 reauth，路由层保证） */
  restoreUser(userId: number, input: RestoreUserRequest, actor: AdminActor): Promise<AdminUserResponse>
  /** 彻底删除回收站条目：删 trash/ 数据目录 + `purged_at` 置位（需 reauth） */
  purgeUser(userId: number, actor: AdminActor): Promise<void>
  /** 超过保留期的回收站条目自动彻底删除（插件 onReady + 每小时定时器调用，测试可直接调） */
  sweepExpiredDeletions(): Promise<{ purged: number; failed: number }>
}

/** 邀请码 / 系统设置 / 审计查询（04 §4.4）+ 公共站点信息（04 §1） */
export interface SystemService {
  listInvites(query: InviteListQuery): Promise<InviteListResponse>
  createInvites(input: CreateInvitesRequest, actor: AdminActor): Promise<CreateInvitesResponse>
  updateInvite(inviteId: number, input: UpdateInviteRequest, actor: AdminActor): Promise<InviteResponse>
  deleteInvite(inviteId: number, actor: AdminActor): Promise<void>
  getInvite(inviteId: number): Promise<InviteRow | null>
  getSettings(): Promise<SettingsResponse>
  updateSettings(input: UpdateSettingsRequest, actor: AdminActor): Promise<SettingsResponse>
  listAudit(query: AuditListQuery): Promise<AuditListResponse>
  /** `GET /api/public/site`（未登录可访问） */
  publicSite(): Promise<{
    name: string
    tagline: string
    announcement: string
    announcementLevel: 'info' | 'success' | 'warning' | 'error'
    registrationMode: 'open' | 'invite' | 'closed'
    requireApproval: boolean
    caCertUrl: string | null
  }>
}
