import { z } from 'zod'
import { PASSWORD_MAX_LENGTH, SESSION_COOKIE_NAME, SSE_PING_INTERVAL_MS } from '../constants.js'
import { IsoDateTimeSchema, UserPublicSchema } from '../common.js'
import { PasswordSchema, UsernameSchema } from './auth.js'

/** 会话 cookie 名（前端不需读它，仅用于文档/测试） */
export const SESSION_COOKIE = SESSION_COOKIE_NAME
export const SSE_PING_MS = SSE_PING_INTERVAL_MS

// ── PATCH /api/me ───────────────────────────────────────────────────────────

export const UpdateMeRequestSchema = z.object({
  username: UsernameSchema.optional(),
  displayName: z.string().max(32).optional(),
  bio: z.string().max(200, '个人简介最多 200 字').optional(),
})
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>

export const UpdateMeResponseSchema = z.object({ user: UserPublicSchema })
export type UpdateMeResponse = z.infer<typeof UpdateMeResponseSchema>

// ── 头像 ────────────────────────────────────────────────────────────────────

/** multipart 字段名固定为 `file`（png/jpeg/webp，≤1MB，前端已裁剪 512×512） */
export const AVATAR_FIELD_NAME = 'file'

// ── POST /api/me/password ───────────────────────────────────────────────────

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: PasswordSchema,
})
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>

// ── 登录设备 ────────────────────────────────────────────────────────────────

export const SessionItemSchema = z.object({
  id: z.string(),
  /** 是否当前设备 */
  current: z.boolean(),
  createdAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** 人类可读的设备描述，如「桌面 Chrome」 */
  device: z.string(),
})
export type SessionItem = z.infer<typeof SessionItemSchema>

export const SessionListResponseSchema = z.object({ items: z.array(SessionItemSchema) })
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>

export const RevokeOthersResponseSchema = z.object({ revoked: z.number().int().nonnegative() })
export type RevokeOthersResponse = z.infer<typeof RevokeOthersResponseSchema>
