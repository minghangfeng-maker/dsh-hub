import {
  SESSION_TTL_DAYS,
  type CheckUsernameResponse,
  type RegisterResponse,
  type UserPublic,
} from '@dsh-hub/shared'
import type { AppDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { newSlug, newTempPassword } from '../../lib/ids.js'
import { checkPasswordStrength, hashPassword, needsRehash, verifyPassword } from '../../lib/password.js'
import {
  createFailureLock,
  createTokenBucket,
  createWindowCounter,
  isLoopbackIp,
  type RateLimitDecision,
  type RateLimiter,
} from '../../lib/rate-limit.js'
import { createSession, markReauth, revokeSession } from '../../lib/session.js'
import { isSystemUserId } from '../../lib/system-account.js'
import { findUserById, findUserByUsername, toUserPublic } from '../../lib/user-view.js'
import { assertUsernameAvailable, normalizeUsername, usernameAvailability } from '../../lib/usernames.js'
import { absentInstanceSummary, resolveInstanceSummary } from '../../lib/instance-view.js'
import {
  consumeInvite,
  countUsers,
  insertInviteUse,
  insertUser,
  touchLastLogin,
  updatePasswordHash,
} from './repo.js'
import type { AuthService, LoginResult, RegisterResult } from './types.js'

/**
 * 限流参数（02 §5）：
 * 登录 同 IP 10 次/10 分钟；同用户名 5 次失败锁 15 分钟；注册 同 IP 3 次/小时、10 次/天；
 * check-username 30 次/分钟；reauth 每个用户 10 次/10 分钟（防用会话暴力猜密码）。
 */
export const AUTH_RATE_LIMITS = {
  loginIp: { capacity: 10, windowMs: 10 * 60_000 },
  loginFailures: { threshold: 5, lockMs: 15 * 60_000 },
  registerHourly: { capacity: 3, windowMs: 60 * 60_000 },
  registerDaily: { capacity: 10, windowMs: 24 * 60 * 60_000 },
  checkUsername: { capacity: 30, windowMs: 60_000 },
  reauth: { capacity: 10, windowMs: 10 * 60_000 },
} as const

/**
 * 假哈希（02 §5「用户不存在时也做一次假哈希」）：模块级缓存，每个进程只算一次，
 * 让「用户不存在」与「密码错误」的耗时接近，避免用计时差枚举用户名。
 */
let dummyHashCache: string | null = null
function dummyPasswordHash(): string {
  dummyHashCache ??= hashPassword(newTempPassword(24))
  return dummyHashCache
}

/** 账号域服务（04 §2；限流、锁定、邀请码消耗都在这里，路由只管解析请求与写 cookie） */
export function createAuthService(deps: AppDeps): AuthService {
  const { db, clock, settings, audit } = deps
  // 登录/reauth 用令牌桶（平滑限速，不给窗口边界留突刺）；
  // 注册与用户名校验用固定窗口（「3 次/小时、10 次/天」要的是窗口内不超过 N 次）
  const loginIpBucket = createTokenBucket({ ...AUTH_RATE_LIMITS.loginIp, clock })
  const registerHourlyBucket = createWindowCounter({ ...AUTH_RATE_LIMITS.registerHourly, clock })
  const registerDailyBucket = createWindowCounter({ ...AUTH_RATE_LIMITS.registerDaily, clock })
  const checkUsernameBucket = createWindowCounter({ ...AUTH_RATE_LIMITS.checkUsername, clock })
  const reauthBucket = createTokenBucket({ ...AUTH_RATE_LIMITS.reauth, clock })
  const usernameLock = createFailureLock({ ...AUTH_RATE_LIMITS.loginFailures, clock })

  /** 限流不通过 → 429（04 §0.2），details 带 retryAfterSec 供前端倒计时 */
  function assertAllowed(decision: RateLimitDecision): void {
    if (!decision.allowed) {
      throw new HubError('RATE_LIMITED', undefined, { retryAfterSec: decision.retryAfterSec })
    }
  }

  /**
   * 按 IP 的限流：**回环地址豁免只对经 7700 的本机请求生效**（02 §5）。
   * 阶段一 Hub 只监听 127.0.0.1，浏览器、curl、验收脚本都从本机来，限流只会误伤自己；
   * 阶段二真实客户端 IP 由 PROXY 头带入；经 7443 的公网请求即使 IP 显示为回环
   * （例如 PROXY UNKNOWN 的兜底）也照常限流（10 §F9）。
   * 按用户名/按用户的失败锁定不走这里，始终生效。
   */
  function consumeIpLimit(limiter: RateLimiter, meta: RequestMeta): void {
    if (!meta.publicRequest && (!meta.ip || isLoopbackIp(meta.ip))) return
    assertAllowed(limiter.consume(meta.ip ?? 'unknown'))
  }

  function assertPasswordStrength(password: string, username: string): void {
    const reasons = checkPasswordStrength(password, username)
    if (reasons.length > 0) throw new HubError('WEAK_PASSWORD', undefined, { reasons })
  }

  /**
   * 凭据校验的唯一实现（网页登录与手机 App 设备令牌登录共用，WP40a）。
   *
   * 顺序即安全策略：先按 IP 限流、再看用户名锁定、密码对不上就记一次失败并审计，
   * 密码正确之后才暴露账号状态（停用 / 待审批）——不给攻击者「这个账号存在」的探测面。
   * 成功后重置失败计数、必要时升级哈希、更新 last_login、发每日赠送、记成功审计。
   * **不建会话**：cookie 会话由 `login` 建，手机令牌由 mobile 模块建。
   */
  function authenticate(
    input: { username: string; password: string },
    meta: RequestMeta,
    surface: 'web' | 'mobile',
  ): UserPublic {
    const username = normalizeUsername(input.username)
    // 按 IP 的登录限流只对本机请求豁免；按用户名的失败锁定照旧（02 §5）
    consumeIpLimit(loginIpBucket, meta)

    const lock = usernameLock.check(username)
    if (lock.locked) {
      throw new HubError('ACCOUNT_LOCKED', undefined, { retryAfterSec: lock.retryAfterSec })
    }

    const row = findUserByUsername(db, username)
    // 系统账号（WP56b 的座舱 DSH，`users.is_system = 1`）永远不能登录：
    // 它的口令是一次性随机值、没有人负责；/ops/* 才是它唯一的入口。
    if (row !== undefined && row !== null && isSystemUserId(db, row.id)) {
      throw new HubError('INVALID_CREDENTIALS')
    }
    const passwordOk = row
      ? verifyPassword(input.password, row.password_hash)
      : // 用户不存在也走一次 scrypt，避免用耗时差枚举用户名
        verifyPassword(input.password, dummyPasswordHash())
    if (!row || !passwordOk) {
      const state = usernameLock.recordFailure(username)
      audit.log({
        actorId: row?.id ?? null,
        actorIp: meta.ip,
        action: 'auth.login.failure',
        targetType: 'user',
        targetId: row?.id ?? null,
        detail: { username, reason: row ? 'bad_password' : 'unknown_user', locked: state.locked, surface },
      })
      // 第 5 次失败仍然是「密码错误」，锁定从第 6 次开始生效（10 §B5）；这样也不会把
      // 「输错第 5 次」和「已被锁定」两种状态混在同一个响应里
      throw new HubError('INVALID_CREDENTIALS')
    }
    // 软删除的账号视为不存在（不泄漏它曾经存在）
    if (row.deleted_at) {
      usernameLock.recordFailure(username)
      throw new HubError('INVALID_CREDENTIALS')
    }
    // 密码正确后才看状态：不给攻击者「这个账号存在但被停用」的探测面
    if (row.status === 'disabled') throw new HubError('ACCOUNT_DISABLED')
    if (row.status === 'pending') throw new HubError('ACCOUNT_PENDING')

    const now = clock.nowIso()
    usernameLock.reset(username)
    if (needsRehash(row.password_hash)) updatePasswordHash(db, row.id, hashPassword(input.password), now)

    touchLastLogin(db, row.id, now, meta.ip)
    // 13 §2.3：登录成功发每日赠送（同一天只会成功一次；待审批账号在更早的分支就被拒了）
    grantDailyBonus(row.id)
    audit.log({
      actorId: row.id,
      actorIp: meta.ip,
      action: 'auth.login.success',
      targetType: 'user',
      targetId: row.id,
      detail: { username: row.username, surface },
    })

    const fresh = findUserById(db, row.id)
    return toUserPublic(fresh ?? row)
  }

  function currentUserPublic(userId: number): UserPublic {
    const row = findUserById(db, userId)
    if (!row || row.deleted_at) throw new HubError('NOT_FOUND', '用户不存在')
    return toUserPublic(row)
  }

  /**
   * 每日赠送（13 §2.3）：登录成功与 GET /api/auth/me 时触发。
   * 钱包问题不该让登录/打开页面失败，失败只记 warn（下一次扣费或打开页面还会再试）。
   */
  function grantDailyBonus(userId: number): void {
    try {
      deps.services.relay.grantDailyBonus(userId)
    } catch (error) {
      deps.logger.warn({ err: error, userId }, '每日赠送发放失败')
    }
  }

  return {
    async register(input, meta): Promise<RegisterResult> {
      const registration = settings.get('registration')
      if (registration.mode === 'closed') throw new HubError('REGISTRATION_CLOSED')
      consumeIpLimit(registerHourlyBucket, meta)
      consumeIpLimit(registerDailyBucket, meta)

      const username = input.username
      assertUsernameAvailable(db, username)
      assertPasswordStrength(input.password, username)

      const now = clock.nowIso()
      const passwordHash = hashPassword(input.password)
      let userId: number
      let inviteId: number | null = null
      // 用邀请码注册的人得到的角色名 = 消耗该码那一刻码上的 role_label（快照，04 §2）；
      // 码上没有 role 字段，所以 role 恒为 'user'，夹带 role:'admin' 也不会有效果
      let roleLabel = ''
      try {
        userId = db.tx(() => {
          // 上限在事务里判：并发注册不会一起挤过 maxUsers
          if (countUsers(db) >= registration.maxUsers) throw new HubError('USER_LIMIT_REACHED')
          if (registration.mode === 'invite') {
            const code = (input.inviteCode ?? '').trim()
            if (code.length === 0) throw new HubError('INVITE_INVALID')
            const consumed = consumeInvite(db, code, now)
            if (consumed === null) throw new HubError('INVITE_INVALID')
            inviteId = consumed.id
            roleLabel = consumed.roleLabel
          }
          const id = insertUser(db, {
            slug: newSlug(),
            username,
            displayName: input.displayName?.trim() || username,
            passwordHash,
            role: 'user',
            roleLabel,
            status: registration.requireApproval ? 'pending' : 'active',
            mustChangePassword: false,
            at: now,
          })
          if (inviteId !== null) insertInviteUse(db, inviteId, id, now)
          // 中转站钱包（12 §6.4）：注册成功（含待审批）就建行，赠送在同一事务里落流水
          deps.services.relay.ensureSignupWallet(id)
          return id
        })
      } catch (error) {
        // 唯一索引兜住并发抢同一个用户名（先 SELECT 后 INSERT 之间有窗口）
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.username')) {
          throw new HubError('USERNAME_TAKEN')
        }
        throw error
      }

      audit.log({
        actorId: userId,
        actorIp: meta.ip,
        action: 'auth.register',
        targetType: 'user',
        targetId: userId,
        detail: {
          username,
          mode: registration.mode,
          requireApproval: registration.requireApproval,
          inviteId,
          ...(roleLabel ? { roleLabel } : {}),
        },
      })

      const user = currentUserPublic(userId)
      let session: RegisterResult['session'] = null
      if (!registration.requireApproval) {
        const created = createSession(db, {
          userId,
          now,
          ip: meta.ip,
          userAgent: meta.userAgent,
          isAdmin: false,
        })
        // 注册即登录：cookie 带 Max-Age（04 §2 的 sessionStarted=true）
        session = { token: created.token, expiresAt: created.expiresAt, remember: true }
      }

      // 建目录/渲染 managed 归 WP2；桩阶段调用会抛错，只记日志不影响注册（任务书）
      try {
        await deps.services.instances.provision(userId, { reason: 'user' })
      } catch (error) {
        deps.logger.warn({ err: error, userId }, '注册后 provision 失败（WP2 未就绪或实例域异常）')
      }

      const response: RegisterResponse = { user, sessionStarted: session !== null }
      return { response, session }
    },

    async checkUsername(username, meta): Promise<CheckUsernameResponse> {
      consumeIpLimit(checkUsernameBucket, meta)
      return usernameAvailability(db, normalizeUsername(username))
    },

    async login(input, meta): Promise<LoginResult> {
      const user = authenticate(input, meta, 'web')
      const remember = input.remember === true
      const row = findUserById(db, user.id)
      if (!row) throw new HubError('INTERNAL', '用户行消失')
      const newSession = createSession(db, {
        userId: row.id,
        now: clock.nowIso(),
        ttlDays: SESSION_TTL_DAYS,
        isAdmin: row.role === 'admin',
        adminSessionHours: settings.get('security').adminSessionHours,
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      return {
        response: { user },
        session: { ...newSession, remember },
      }
    },

    /**
     * 手机 App 的设备令牌登录（WP40a）：只做「凭据 → 这个人是谁」，
     * 不建 cookie 会话（手机不用 cookie）。判定顺序、锁定计数、审计与网页登录**同一份实现**，
     * 所以「输了 5 次被锁」在两端口径一致。
     */
    authenticateForDevice(input, meta): UserPublic {
      return authenticate(input, meta, 'mobile')
    },

    async logout(userId, sessionId, meta): Promise<void> {
      const revoked = revokeSession(db, sessionId, clock.nowIso())
      audit.log({
        actorId: userId,
        actorIp: meta.ip,
        action: 'auth.logout',
        targetType: 'user',
        targetId: userId,
        detail: { revoked },
      })
      // 座舱令牌不跟 cookie 会话走：管理员登出时把它的座舱令牌一起作废（docs/24 §3.3）
      deps.events.emit('cockpit.admin-logout', { adminId: userId })
    },

    async reauth(userId, sessionId, password): Promise<void> {
      assertAllowed(reauthBucket.consume(`u${userId}`))
      const row = findUserById(db, userId)
      if (!row || row.deleted_at) throw new HubError('UNAUTHENTICATED')
      if (!verifyPassword(password, row.password_hash)) throw new HubError('WRONG_PASSWORD')
      markReauth(db, sessionId, clock.nowIso())
    },

    async me(userId) {
      const row = findUserById(db, userId)
      if (!row || row.deleted_at) throw new HubError('UNAUTHENTICATED')
      // 打开 Hub 任何页面都会调它（13 §2.3）
      grantDailyBonus(userId)
      let instance
      try {
        instance = await resolveInstanceSummary(deps, userId, row.username)
      } catch {
        instance = absentInstanceSummary(row.username)
      }
      return { user: toUserPublic(row), instance }
    },
  }
}
