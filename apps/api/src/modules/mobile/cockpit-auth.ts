/**
 * 座舱管理员令牌（WP56b / docs/24 §3.3）：交接码换令牌、解析、轮换、吊销。
 *
 * 与手机设备令牌的**相同**之处：前缀（`dshm_at_` / `dshm_rt_`）、库里只存 sha256、
 * access/refresh 成对轮换；所以 App 的 `/auth/refresh`、通道 ticket 与 WS 升级都不用改。
 * **不同**之处（本文件存在的理由）：
 * - 不占手机设备名额：令牌在 `cockpit_admin_tokens`，`desktop_devices` 里没有这一行；
 * - 12 小时绝对过期（access 与 refresh 同口径）；
 * - 只认管理员本人：管理员被降级 / 删除 / 登出 → 令牌立即作废、通道收到 `bye`；
 * - 一个管理员同一时刻只有一对有效令牌（轮换即吊销旧的）。
 *
 * @module @dsh-hub/api/modules/mobile/cockpit-auth
 */
import {
  MOBILE_ACCESS_TOKEN_PREFIX,
  MOBILE_COCKPIT_TOKEN_TTL_MS,
  MOBILE_REFRESH_TOKEN_PREFIX,
  MOBILE_TOKEN_RANDOM_LENGTH,
  type MobileAuthTokens,
} from '@dsh-hub/shared'
import type { AppDeps, RequestMeta } from '../../context.js'
import { isoPlusMs, isExpired } from '../../lib/clock.js'
import { randomString, sha256Hex } from '../../lib/crypto.js'
import { HubError } from '../../lib/errors.js'
import type { SessionUser } from '../../lib/session.js'
import type { MobileTokenResolution } from './auth.js'
import { findCockpitHandoffExchange } from './cockpit-port.js'
import {
  findCockpitTokenRow,
  hasLiveCockpitToken,
  insertCockpitToken,
  revokeCockpitTokensForAdmin,
  type CockpitTokenRevokeReason,
  type CockpitTokenRow,
} from './cockpit-repo.js'

/** base62：与手机设备令牌同一字母表（前缀不同即可区分来源，字母表没必要分叉） */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * 座舱令牌的「伪设备 id」：`dv_` + sha256(`cockpit:<adminId>`) 前 32 位。
 *
 * 为什么要有它：ticket / 通道 / 审计里到处用 deviceId（契约 `MobileAuthTokens.deviceId` 是
 * `dv_` 形状），但座舱令牌**不能**在 `desktop_devices` 建行（那会占手机设备名额）。
 * 用「用户名派生的确定性 id」既能通过契约校验，又能在 `isDeviceUsable` 里一眼认出
 * （`deviceId === pseudoDeviceIdFor(userId)`），不需要额外查表。
 */
export function pseudoDeviceIdFor(adminId: number): string {
  return `dv_${sha256Hex(`cockpit:${adminId}`).slice(0, 32)}`
}

export interface CockpitAuthService {
  /** `POST /api/mobile/auth/cockpit-exchange`：一次性交接码换一对座舱令牌 */
  exchange(code: string, meta: RequestMeta): Promise<MobileAuthTokens>
  /** access 令牌解析；不是座舱令牌时返回 null（交回手机设备令牌那条路） */
  resolveAccessToken(plain: string): MobileTokenResolution | null
  /** `POST /api/mobile/auth/refresh`：轮换一对新令牌（绝对过期不延长） */
  refresh(refreshToken: string, meta: RequestMeta): MobileAuthTokens
  /** `POST /api/mobile/auth/logout`（座舱作用域）：吊销本管理员全部座舱令牌 */
  logout(userId: number, meta: RequestMeta): void
  /** 管理员登出 / 降级 / 删除：吊销令牌并通知通道（`bye`） */
  revokeForAdmin(adminId: number, reason: CockpitTokenRevokeReason): number
  /** 通道复查：这个管理员的座舱令牌还有效吗 */
  isAdminUsable(adminId: number): boolean
}

export function createCockpitAuthService(deps: AppDeps): CockpitAuthService {
  const { db, clock, audit, logger } = deps

  function newToken(prefix: string): string {
    return `${prefix}${randomString(MOBILE_TOKEN_RANDOM_LENGTH, BASE62)}`
  }

  /** 管理员现状是否还能用座舱（角色仍是 admin、账号 active、没删、不是系统账号、没改密要求） */
  function adminUsable(row: CockpitTokenRow): boolean {
    return (
      row.deleted_at === null &&
      row.user_status === 'active' &&
      row.role === 'admin' &&
      row.is_system === 0 &&
      row.must_change_password === 0
    )
  }

  function sessionUserOf(row: CockpitTokenRow, expiresAt: string): SessionUser {
    const at = clock.nowIso()
    return {
      id: row.user_id,
      slug: row.slug,
      username: row.username,
      displayName: row.display_name,
      avatarFile: row.avatar_file,
      role: 'admin',
      status: 'active',
      mustChangePassword: false,
      sessionId: `cockpit:${row.id}`,
      createdAt: row.user_created_at,
      expiresAt,
      lastSeenAt: at,
      reauthAt: null,
    }
  }

  /**
   * 签发一对新令牌。`absoluteUntil` 是这一对的**绝对**上限：轮换时不延长
   * （`min(now + 12h, 原 refresh 的到期)`），所以「交接后 12 小时」是硬边界。
   */
  function issuePair(
    row: CockpitTokenRow,
    meta: RequestMeta,
    opts: { absoluteUntil?: string } = {},
  ): MobileAuthTokens {
    const at = clock.nowIso()
    const natural = isoPlusMs(at, MOBILE_COCKPIT_TOKEN_TTL_MS)
    const expiresAt =
      opts.absoluteUntil !== undefined && opts.absoluteUntil < natural ? opts.absoluteUntil : natural
    const accessToken = newToken(MOBILE_ACCESS_TOKEN_PREFIX)
    const refreshToken = newToken(MOBILE_REFRESH_TOKEN_PREFIX)
    db.tx(() => {
      // 同一时刻只留一对有效令牌：轮换 = 旧的全部理由 'rotated' 作废
      revokeCockpitTokensForAdmin(db, { adminId: row.admin_id, at, reason: 'rotated' })
      insertCockpitToken(db, {
        id: sha256Hex(accessToken),
        adminId: row.admin_id,
        kind: 'access',
        at,
        expiresAt,
      })
      insertCockpitToken(db, {
        id: sha256Hex(refreshToken),
        adminId: row.admin_id,
        kind: 'refresh',
        at,
        expiresAt,
      })
    })
    logger.debug({ adminId: row.admin_id, ip: meta.ip }, '座舱令牌：已签发一对新令牌')
    return {
      accessToken,
      accessExpiresAt: expiresAt,
      refreshToken,
      refreshExpiresAt: expiresAt,
      deviceId: pseudoDeviceIdFor(row.admin_id),
      user: { id: row.user_id, username: row.username, displayName: row.display_name },
      scope: 'cockpit',
    }
  }

  /** 按管理员 id 取一行（签令牌时用；join 的是 users 现状） */
  function adminRow(adminId: number): CockpitTokenRow | undefined {
    // 用一个已知的令牌 id 拿不到 admin 行，所以这里直接查 users + 借道 findCockpitTokenRow 的形状
    return db.get<CockpitTokenRow>(
      `SELECT '' AS id, u.id AS admin_id, 'access' AS kind, '' AS created_at, '' AS expires_at,
              NULL AS revoked_at, NULL AS revoked_reason,
              u.id AS user_id, u.slug, u.username, u.display_name, u.avatar_file, u.role,
              u.status AS user_status, u.is_system, u.must_change_password, u.deleted_at,
              u.created_at AS user_created_at
         FROM users u WHERE u.id = ?`,
      adminId,
    )
  }

  return {
    async exchange(code, meta): Promise<MobileAuthTokens> {
      const exchange = findCockpitHandoffExchange(deps.services)
      if (exchange === null) {
        // 并行开发的另一个包（WP56a）还没接上：明确报错，不假装成功
        throw new HubError('INTERNAL', '座舱交接尚未接上（cockpit 模块未装配 consumeHandoff）')
      }
      const adminId = await exchange.consumeHandoff(code)
      if (adminId === null || adminId === undefined) {
        throw new HubError('INVALID_CREDENTIALS', '交接码无效、已被使用或已过期')
      }
      const row = adminRow(adminId)
      if (row === undefined || !adminUsable(row)) {
        throw new HubError('FORBIDDEN', '这个账号不能使用管理座舱')
      }
      const tokens = issuePair(row, meta)
      audit.log({
        actorId: row.admin_id,
        actorIp: meta.ip,
        action: 'cockpit.token-exchange',
        targetType: 'user',
        targetId: row.admin_id,
        detail: { scope: 'cockpit', deviceId: tokens.deviceId },
      })
      return tokens
    },

    resolveAccessToken(plain: string): MobileTokenResolution | null {
      if (!plain.startsWith(MOBILE_ACCESS_TOKEN_PREFIX)) return null
      const id = sha256Hex(plain)
      const row = findCockpitTokenRow(db, id)
      if (row === undefined) return null
      if (row.kind !== 'access') return { ok: false, reason: 'invalid' }
      if (row.revoked_at !== null) {
        return { ok: false, reason: row.revoked_reason === 'rotated' ? 'rotated' : 'revoked' }
      }
      if (!adminUsable(row)) return { ok: false, reason: 'account' }
      if (isExpired(row.expires_at, clock.nowIso())) return { ok: false, reason: 'expired' }
      return {
        ok: true,
        principal: {
          user: sessionUserOf(row, row.expires_at),
          deviceId: pseudoDeviceIdFor(row.admin_id),
          tokenId: id,
          scope: 'cockpit',
        },
      }
    },

    refresh(refreshToken, meta): MobileAuthTokens {
      const id = sha256Hex(refreshToken)
      const row = findCockpitTokenRow(db, id)
      if (row === undefined || row.kind !== 'refresh') {
        // 不在这里抛：手机设备令牌的 refresh 走另一条路（调用方负责回 DEVICE_TOKEN_INVALID）
        throw new HubError('DEVICE_TOKEN_INVALID', '登录已失效，请重新登录')
      }
      if (row.revoked_at !== null || !adminUsable(row) || isExpired(row.expires_at, clock.nowIso())) {
        throw new HubError('DEVICE_TOKEN_INVALID', '座舱会话已过期，请回到管理座舱重新进入')
      }
      return issuePair(row, meta, { absoluteUntil: row.expires_at })
    },

    logout(userId, meta): void {
      const at = clock.nowIso()
      const revoked = revokeCockpitTokensForAdmin(db, { adminId: userId, at, reason: 'logout' })
      audit.log({
        actorId: userId,
        actorIp: meta.ip,
        action: 'cockpit.token-logout',
        targetType: 'user',
        targetId: userId,
        detail: { revoked },
      })
      deps.events.emit('cockpit.admin-logout', { adminId: userId })
    },

    revokeForAdmin(adminId, reason): number {
      const revoked = revokeCockpitTokensForAdmin(db, {
        adminId,
        at: clock.nowIso(),
        reason,
      })
      if (revoked > 0) logger.debug({ adminId, reason, revoked }, '座舱令牌已吊销')
      return revoked
    },

    isAdminUsable(adminId: number): boolean {
      const row = adminRow(adminId)
      if (row === undefined || !adminUsable(row)) return false
      return hasLiveCockpitToken(db, adminId, clock.nowIso())
    },
  }
}
