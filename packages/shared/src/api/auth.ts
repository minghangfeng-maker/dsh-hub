import { z } from 'zod'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_REGEX } from '../constants.js'
import { InstanceSummarySchema, UserPublicSchema } from '../common.js'

/**
 * 注册/登录等接口里复用的用户名约束。
 *
 * **先规整再校验**（WP1）：用户名一律小写存储（02 §5），所以 `Admin` 会先规整成 `admin`
 * 再判规则/保留字 —— 10 §B3 要求 `Admin` 得到 `USERNAME_RESERVED`（而不是格式错误）。
 */
export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_REGEX, '只能包含小写字母、数字、- 和 _，且以字母开头，3–32 位')

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 位`)

// ── POST /api/auth/register ─────────────────────────────────────────────────

export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  displayName: z.string().max(32).optional(),
  inviteCode: z.string().max(64).optional(),
})
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

export const RegisterResponseSchema = z.object({
  user: UserPublicSchema,
  /** requireApproval 时 status=pending 且不建立会话 → false */
  sessionStarted: z.boolean(),
})
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>

// ── GET /api/auth/check-username ────────────────────────────────────────────

export const CheckUsernameQuerySchema = z.object({ username: z.string().min(1).max(64) })
export type CheckUsernameQuery = z.infer<typeof CheckUsernameQuerySchema>

export const CheckUsernameResponseSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['taken', 'reserved', 'invalid']).optional(),
})
export type CheckUsernameResponse = z.infer<typeof CheckUsernameResponseSchema>

// ── POST /api/auth/login ────────────────────────────────────────────────────

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** false/缺省 → 会话 cookie 不带 Max-Age（关掉浏览器即失效） */
  remember: z.boolean().optional(),
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const LoginResponseSchema = z.object({ user: UserPublicSchema })
export type LoginResponse = z.infer<typeof LoginResponseSchema>

// ── POST /api/auth/reauth ───────────────────────────────────────────────────

export const ReauthRequestSchema = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) })
export type ReauthRequest = z.infer<typeof ReauthRequestSchema>

// ── GET /api/auth/me ────────────────────────────────────────────────────────

export const AuthMeResponseSchema = z.object({
  user: UserPublicSchema,
  instance: InstanceSummarySchema,
})
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>
