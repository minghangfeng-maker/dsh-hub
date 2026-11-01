import type {
  AuthMeResponse,
  CheckUsernameResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
  UserPublic,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'

/** 会话票据：明文 token 只在这里出现一次，库里存 sha256（02 §5） */
export interface SessionTicket {
  token: string
  expiresAt: string
  /** false → cookie 不带 Max-Age（关掉浏览器即失效，04 §2 login） */
  remember: boolean
}

export interface RegisterResult {
  response: RegisterResponse
  /** `requireApproval` 时没有会话（不自动登录） */
  session: SessionTicket | null
}

export interface LoginResult {
  response: LoginResponse
  session: SessionTicket
}

/**
 * 账号域服务（04 §2；WP1 实现）。
 * 限流、锁定、邀请码消耗都在实现里做，路由只负责解析请求/写 cookie。
 */
export interface AuthService {
  /** 注册：校验邀请码/用户名/密码强度/限流 → 写 users → 消耗邀请码 → 审计 */
  register(input: RegisterRequest, meta: RequestMeta): Promise<RegisterResult>
  /** 注册页实时校验（限流 30 次/分钟，按 IP） */
  checkUsername(username: string, meta: RequestMeta): Promise<CheckUsernameResponse>
  /** 登录：scrypt 校验、失败计数与锁定、写会话、更新 last_login_* */
  login(input: LoginRequest, meta: RequestMeta): Promise<LoginResult>
  /**
   * 手机 App 的设备令牌登录（WP40a）：与 `login` 共用同一份凭据校验 / 锁定 / 审计，
   * **不建 cookie 会话**（手机不用 cookie），返回通过校验的用户。
   */
  authenticateForDevice(input: { username: string; password: string }, meta: RequestMeta): UserPublic
  /** 登出：吊销当前会话 + 审计 */
  logout(userId: number, sessionId: string, meta: RequestMeta): Promise<void>
  /** 二次验证：刷新会话的 reauth_at（敏感操作前置条件） */
  reauth(userId: number, sessionId: string, password: string): Promise<void>
  /** `GET /api/auth/me`：UserPublic + InstanceSummary（实例信息向 instances 服务取） */
  me(userId: number): Promise<AuthMeResponse>
}
