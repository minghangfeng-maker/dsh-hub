import {
  AuthMeResponseSchema,
  CheckUsernameResponseSchema,
  LoginResponseSchema,
  RegisterResponseSchema,
  type AuthMeResponse,
  type CheckUsernameResponse,
  type LoginRequest,
  type LoginResponse,
  type RegisterRequest,
  type RegisterResponse,
} from '@dsh-hub/shared'

import { http, withQuery } from './http'

/** `POST /api/auth/register`（04 §2）。`requireApproval` 时 `sessionStarted=false`。 */
export function register(input: RegisterRequest): Promise<RegisterResponse> {
  return http.post('/api/auth/register', {
    body: input,
    schema: RegisterResponseSchema,
    authRedirect: false,
  })
}

/** `GET /api/auth/check-username`（注册页实时校验，限流 30 次/分钟）。 */
export function checkUsername(username: string): Promise<CheckUsernameResponse> {
  return http.get(withQuery('/api/auth/check-username', { username }), {
    schema: CheckUsernameResponseSchema,
    authRedirect: false,
  })
}

/** `POST /api/auth/login`：成功后服务端种 `hub_sid` cookie。 */
export function login(input: LoginRequest): Promise<LoginResponse> {
  return http.post('/api/auth/login', { body: input, schema: LoginResponseSchema, authRedirect: false })
}

/** `POST /api/auth/logout`（204）。 */
export function logout(): Promise<void> {
  return http.post<void>('/api/auth/logout', { authRedirect: false })
}

/** `GET /api/auth/me`：前端启动与守卫用；401 时应视为「未登录」而不是跳转。 */
export function fetchMe(): Promise<AuthMeResponse> {
  return http.get('/api/auth/me', { schema: AuthMeResponseSchema, authRedirect: false })
}

/** `POST /api/auth/reauth`：敏感操作前二次输入密码，刷新会话的 reauth_at（204）。 */
export function reauth(password: string): Promise<void> {
  return http.post<void>('/api/auth/reauth', { body: { password }, authRedirect: false })
}
