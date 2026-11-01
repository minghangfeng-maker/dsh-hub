import {
  SessionListResponseSchema,
  UpdateMeResponseSchema,
  type ChangePasswordRequest,
  type RevokeOthersResponse,
  type SessionListResponse,
  type SessionItem,
  type UpdateMeRequest,
  type UpdateMeResponse,
} from '@dsh-hub/shared'
import { AVATAR_FIELD_NAME } from '@dsh-hub/shared'

import { http } from './http'

/** `PATCH /api/me`：改昵称/简介（用户名 30 天冷却，见 04 §0.2）。 */
export function updateMe(input: UpdateMeRequest): Promise<UpdateMeResponse> {
  return http.patch('/api/me', { body: input, schema: UpdateMeResponseSchema })
}

/** `POST /api/me/avatar`（multipart，字段名固定 `file`，前端已裁剪 512×512）。 */
export function uploadAvatar(file: Blob, filename = 'avatar.webp'): Promise<UpdateMeResponse> {
  const form = new FormData()
  form.append(AVATAR_FIELD_NAME, file, filename)
  return http.post('/api/me/avatar', { body: form, schema: UpdateMeResponseSchema })
}

/** `DELETE /api/me/avatar`。 */
export function deleteAvatar(): Promise<UpdateMeResponse> {
  return http.delete('/api/me/avatar', { schema: UpdateMeResponseSchema })
}

/** `POST /api/me/password`（204）：成功后服务端吊销其他会话。 */
export function changePassword(input: ChangePasswordRequest): Promise<void> {
  return http.post<void>('/api/me/password', { body: input, authRedirect: false })
}

/** `GET /api/me/sessions`：登录设备列表。 */
export function listSessions(): Promise<SessionListResponse> {
  return http.get('/api/me/sessions', { schema: SessionListResponseSchema })
}

/** `DELETE /api/me/sessions/:id`（204）。 */
export function revokeSession(id: SessionItem['id']): Promise<void> {
  return http.delete<void>(`/api/me/sessions/${encodeURIComponent(id)}`)
}

/** `POST /api/me/sessions/revoke-others`。 */
export function revokeOtherSessions(): Promise<RevokeOthersResponse> {
  return http.post('/api/me/sessions/revoke-others')
}
