import {
  AdminOverviewResponseSchema,
  AdminUserResponseSchema,
  AuditListResponseSchema,
  CreateInvitesResponseSchema,
  CreateUserResponseSchema,
  DeletedUserListResponseSchema,
  InviteListResponseSchema,
  InviteResponseSchema,
  ResetPasswordResponseSchema,
  RestoreUserResponseSchema,
  RevokeSessionsResponseSchema,
  RoleLabelListResponseSchema,
  SettingsResponseSchema,
  UserDetailResponseSchema,
  UserListResponseSchema,
  type AdminOverviewResponse,
  type AdminUserResponse,
  type AuditListQuery,
  type AuditListResponse,
  type CreateInvitesRequest,
  type CreateInvitesResponse,
  type CreateUserRequest,
  type CreateUserResponse,
  type DeleteUserQuery,
  type DeletedUserListQuery,
  type DeletedUserListResponse,
  type InviteListResponse,
  type InviteResponse,
  type ResetPasswordResponse,
  type RestoreUserRequest,
  type RestoreUserResponse,
  type RevokeSessionsResponse,
  type RoleLabelListResponse,
  type Settings,
  type UpdateInviteRequest,
  type UpdateUserRequest,
  type UserDetailResponse,
  type UserListQuery,
  type UserListResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/** `GET /api/admin/overview`（04 §4.1）。 */
export function fetchOverview(): Promise<AdminOverviewResponse> {
  return http.get('/api/admin/overview', { schema: AdminOverviewResponseSchema })
}

/** `GET /api/admin/users`（搜索/筛选/分页/排序，04 §4.2）。 */
export function listUsers(query: Partial<UserListQuery> = {}): Promise<UserListResponse> {
  return http.get('/api/admin/users', { query, schema: UserListResponseSchema })
}

/** `GET /api/admin/users/role-labels`：普通用户在用的自定义角色标签（按人数倒序）。 */
export function listRoleLabels(): Promise<RoleLabelListResponse> {
  return http.get('/api/admin/users/role-labels', { schema: RoleLabelListResponseSchema })
}

/** `POST /api/admin/users`：不给密码则返回一次性临时密码。 */
export function createUser(input: CreateUserRequest): Promise<CreateUserResponse> {
  return http.post('/api/admin/users', { body: input, schema: CreateUserResponseSchema })
}

/** `GET /api/admin/users/:id`：详情 + 插件 + 会话数 + 最近审计。 */
export function getUser(id: number): Promise<UserDetailResponse> {
  return http.get(`/api/admin/users/${id}`, { schema: UserDetailResponseSchema })
}

/** `PATCH /api/admin/users/:id`（`quota: null` = 恢复全局默认）。 */
export function updateUser(id: number, input: UpdateUserRequest): Promise<AdminUserResponse> {
  return http.patch(`/api/admin/users/${id}`, { body: input, schema: AdminUserResponseSchema })
}

/** `POST /api/admin/users/:id/approve`：pending → active。 */
export function approveUser(id: number): Promise<AdminUserResponse> {
  return http.post(`/api/admin/users/${id}/approve`, { schema: AdminUserResponseSchema })
}

/** `POST /api/admin/users/:id/reset-password`（**需 reauth**）→ 临时密码。 */
export function resetUserPassword(id: number): Promise<ResetPasswordResponse> {
  return http.post(`/api/admin/users/${id}/reset-password`, { schema: ResetPasswordResponseSchema })
}

/** `POST /api/admin/users/:id/revoke-sessions`。 */
export function revokeUserSessions(id: number): Promise<RevokeSessionsResponse> {
  return http.post(`/api/admin/users/${id}/revoke-sessions`, { schema: RevokeSessionsResponseSchema })
}

/** `DELETE /api/admin/users/:id`（**需 reauth**；默认移入 trash/ 保留 7 天）。 */
export function deleteUser(id: number, query: Partial<DeleteUserQuery> = {}): Promise<void> {
  return http.delete<void>(`/api/admin/users/${id}`, { query })
}

// ── 回收站（04 §4.2，删除后 7 天内可恢复） ─────────────────────────────────

/** `GET /api/admin/users/deleted`：回收站列表（搜索/分页同样生效，按删除时间倒序）。 */
export function listDeletedUsers(
  query: Partial<DeletedUserListQuery> = {},
): Promise<DeletedUserListResponse> {
  return http.get('/api/admin/users/deleted', { query, schema: DeletedUserListResponseSchema })
}

/**
 * `POST /api/admin/users/:id/restore`（**需 reauth**）：
 * 不传 username 就用删除时的原名；原名已被新用户占用时须指定新用户名。
 */
export function restoreUser(id: number, input: RestoreUserRequest = {}): Promise<RestoreUserResponse> {
  return http.post(`/api/admin/users/${id}/restore`, {
    body: input.username ? { username: input.username } : {},
    schema: RestoreUserResponseSchema,
  })
}

/** `POST /api/admin/users/:id/purge`（**需 reauth**）：从回收站彻底删除，数据和用户名都无法恢复。 */
export function purgeUser(id: number): Promise<void> {
  return http.post<void>(`/api/admin/users/${id}/purge`)
}

// ── 邀请码（04 §4.4） ──

/** `GET /api/admin/invites`。 */
export function listInvites(query: { page?: number; pageSize?: number } = {}): Promise<InviteListResponse> {
  return http.get('/api/admin/invites', { query, schema: InviteListResponseSchema })
}

/** `POST /api/admin/invites`：批量生成，响应含明文码（只显示一次）。 */
export function createInvites(input: CreateInvitesRequest): Promise<CreateInvitesResponse> {
  return http.post('/api/admin/invites', { body: input, schema: CreateInvitesResponseSchema })
}

/** `PATCH /api/admin/invites/:id`。 */
export function updateInvite(id: number, input: UpdateInviteRequest): Promise<InviteResponse> {
  return http.patch(`/api/admin/invites/${id}`, { body: input, schema: InviteResponseSchema })
}

/** `DELETE /api/admin/invites/:id`（仅未使用过的可删）。 */
export function deleteInvite(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/invites/${id}`)
}

// ── 系统设置与审计（04 §4.4） ──

/** `GET /api/admin/settings`：全部 settings 键。 */
export function fetchSettings(): Promise<Settings> {
  return http.get('/api/admin/settings', { schema: SettingsResponseSchema })
}

/** `PATCH /api/admin/settings`：按键整体替换。 */
export function updateSettings(input: Partial<Settings>): Promise<Settings> {
  return http.patch('/api/admin/settings', { body: input, schema: SettingsResponseSchema })
}

/** `GET /api/admin/audit`。 */
export function listAudit(query: Partial<AuditListQuery> = {}): Promise<AuditListResponse> {
  return http.get('/api/admin/audit', { query, schema: AuditListResponseSchema })
}
