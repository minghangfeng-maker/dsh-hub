import {
  MOBILE_ACCESS_TOKEN_PREFIX,
  MOBILE_ACCESS_TTL_MS,
  MOBILE_MAX_DEVICES_PER_USER,
  MOBILE_REFRESH_TOKEN_PREFIX,
  MOBILE_REFRESH_TTL_DAYS,
  MOBILE_TOKEN_RANDOM_LENGTH,
  type DesktopMobilePlatform,
  type MobileAuthTokens,
  type MobileLoginRequest,
  type MobileRefreshRequest,
} from '@dsh-hub/shared'
import type { AppDeps, RequestMeta } from '../../context.js'
import { isoPlusDays, isoPlusMs, isExpired } from '../../lib/clock.js'
import { randomString, sha256Hex } from '../../lib/crypto.js'
import { HubError } from '../../lib/errors.js'
import { createTokenBucket, isLoopbackIp } from '../../lib/rate-limit.js'
import type { SessionUser } from '../../lib/session.js'
import type { MobileTokenScope } from '@dsh-hub/shared'
import { pseudoDeviceIdFor } from './cockpit-auth.js'
import {
  countActiveMobileDevices,
  findActiveDeviceByInstallKey,
  findOldestActiveMobileDevice,
  findReusableMobileDevice,
  findTokenJoin,
  listDuplicateLegacyMobileDevices,
  getDeviceRow,
  insertDevice,
  insertToken,
  revokeDeviceRow,
  revokeTokensForDevice,
  updateDeviceRow,
} from '../desktop/repo.js'
import { installKeyOf, newDeviceId } from '../desktop/service.js'

/**
 * 手机 App 的设备令牌（WP40a / v2 §4.1）。
 *
 * 复用桌面端的**设备台账与令牌表**（`desktop_devices` / `desktop_device_tokens`），
 * 所以手机在「我的实例 → 桌面设备」里与桌面设备同屏可见、同一个吊销入口、同一套级联吊销。
 * 与桌面端令牌的差别只有生命周期与轮换语义：
 *
 * - 前缀 `dshm_at_` / `dshm_rt_`（桌面是 `dsh_dev_`）——桌面端的 `resolveDeviceToken` /
 *   `readDeviceBearer` 只看 `dsh_dev_`，两套令牌互不认识；
 * - access 1 小时（短命，泄漏窗口小），refresh 60 天，**每次 refresh 轮换一对**；
 * - 旧 refresh 被重放 = 令牌失窃信号 → 吊销整个设备（10 秒宽限期内按「并发刷新」处理，见下）。
 *
 * 库里只存 sha256（与桌面端同一纪律），明文只在签发响应里出现一次。
 */

/** base62：与桌面设备令牌同一字母表 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * refresh 重放判定前的宽限期。
 *
 * App 在「恢复前台 + 收到 401」时可能并发发两次 refresh：后到的那次拿的是刚被轮换掉的
 * 旧 refresh。如果立刻按重放处理，用户只是因为一次竞态就被踢出登录，体验不可接受。
 * 所以**轮换后 10 秒内**的旧 refresh 只回 `401 DEVICE_TOKEN_INVALID`（App 手里已经有
 * 另一份新令牌），超过 10 秒才认定为「旧令牌泄漏/重放」→ 吊销设备。
 * 这段窗口写进了契约草案的「变更记录」（WP40a）。
 */
export const MOBILE_REFRESH_REPLAY_GRACE_MS = 10_000

/** 登录限流：10 次 / 10 分钟 / 真实客户端 IP（回环豁免同网页登录） */
const LOGIN_LIMIT = { capacity: 10, windowMs: 10 * 60_000 }
/** refresh 限流：60 次 / 10 分钟 / IP（正常一小时一次，留足重试余量） */
const REFRESH_LIMIT = { capacity: 60, windowMs: 10 * 60_000 }
/** 设备名/状态刷新节流：同一台手机最多 1 分钟写一次库 */
const TOUCH_INTERVAL_MS = 60_000

/** 认证主体：`user` 与 cookie 会话同形，所以 `requireUser` / `req.user` 零改动可用 */
export interface MobilePrincipal {
  user: SessionUser
  deviceId: string
  tokenId: string
  /**
   * 令牌作用域（WP56b）：`mobile` = 手机/网页版的设备令牌；
   * `cockpit` = 管理座舱 iframe 用交接码换来的令牌（只认 `cloud:ops`、不占设备名额）。
   */
  scope: MobileTokenScope
}

/**
 * 解析 access token 的结果。**区分原因**是给 App 的行为依据：
 * - `expired` / `rotated` / `invalid` → 401 `DEVICE_TOKEN_INVALID`：先去 refresh，别回登录页；
 * - `revoked` / `account` → 401 `DEVICE_REVOKED`：设备没了（或账号被停用），回登录页。
 */
export type MobileTokenResolution =
  | { ok: true; principal: MobilePrincipal }
  | { ok: false; reason: 'invalid' | 'expired' | 'rotated' | 'revoked' | 'account' }

export interface MobileAuthService {
  /** `POST /api/mobile/auth/login`（免登录） */
  login(input: MobileLoginRequest, meta: RequestMeta): MobileAuthTokens
  /** `POST /api/mobile/auth/refresh`（免登录：refresh token 本身就是凭据） */
  refresh(input: MobileRefreshRequest, meta: RequestMeta): MobileAuthTokens
  /** `POST /api/mobile/auth/logout`（Bearer）：吊销本设备 */
  logout(principal: MobilePrincipal, meta: RequestMeta): void
  /** 解析 `Authorization: Bearer dshm_at_…`；结果带原因（过期 vs 吊销） */
  resolveAccessToken(plain: string): MobileTokenResolution
  /**
   * 合并这台手机的历史重复设备（同名同平台）。
   * 0.2.9 前 App 每次重新登录都会新增一条设备记录；升级后登录/启动时调一次即可清干净。
   * 返回被吊销的条数。只动 `kind='mobile'` 且同名同平台的其它设备，不碰桌面端。
   */
  consolidate(principal: MobilePrincipal, meta: RequestMeta): number
  /**
   * 这台移动设备现在还能不能用（通道每 20 秒复查用）：
   * 设备行被吊销、账号被停用/删除 → false。
   */
  isDeviceUsable(userId: number, deviceId: string): boolean
}

export function createMobileAuthService(deps: AppDeps): MobileAuthService {
  const { db, clock, audit, logger } = deps
  const loginLimit = createTokenBucket({ ...LOGIN_LIMIT, clock })
  const refreshLimit = createTokenBucket({ ...REFRESH_LIMIT, clock })
  /** deviceId → 上次刷新 `last_report_at` 的内存时间（节流写库） */
  const lastTouch = new Map<string, number>()

  function nowIso(): string {
    return clock.nowIso()
  }

  function newToken(prefix: string): string {
    return `${prefix}${randomString(MOBILE_TOKEN_RANDOM_LENGTH, BASE62)}`
  }

  /** 按 IP 限流：回环/本机请求豁免（与 `auth.consumeIpLimit` 同一口径） */
  function consumeIpLimit(limiter: ReturnType<typeof createTokenBucket>, meta: RequestMeta): void {
    if (!meta.publicRequest && (!meta.ip || isLoopbackIp(meta.ip))) return
    const decision = limiter.consume(meta.ip ?? 'unknown')
    if (!decision.allowed) {
      throw new HubError('RATE_LIMITED', '尝试太频繁，请稍后再试', { retryAfterSec: decision.retryAfterSec })
    }
  }

  /** 账号状态 → App 侧错误码（契约草案 §1 的 401/403 组合） */
  function assertAccountUsable(status: string, mustChangePassword: boolean, deletedAt: string | null): void {
    if (deletedAt !== null) throw new HubError('DEVICE_REVOKED')
    if (status === 'disabled') throw new HubError('USER_DISABLED')
    if (status === 'pending') throw new HubError('USER_PENDING')
    // 与网页端一致：没改初始密码就不给手机登录（契约：先去网页改密码）
    if (mustChangePassword) throw new HubError('MUST_CHANGE_PASSWORD')
  }

  function sessionUserOf(row: {
    user_id: number
    slug: string
    username: string
    display_name: string
    avatar_file: string | null
    role: 'user' | 'admin'
    must_change_password: number
    token_id: string
    token_created_at: string
    token_expires_at: string
    token_last_used_at: string
  }): SessionUser {
    return {
      id: row.user_id,
      slug: row.slug,
      username: row.username,
      displayName: row.display_name,
      avatarFile: row.avatar_file,
      role: row.role,
      status: 'active',
      mustChangePassword: row.must_change_password === 1,
      sessionId: `mob:${row.token_id}`,
      createdAt: row.token_created_at,
      expiresAt: row.token_expires_at,
      lastSeenAt: row.token_last_used_at,
      reauthAt: null,
    }
  }

  /**
   * 签一对新令牌：**先吊销该设备上所有还活着的令牌**，再插 access + refresh。
   * 这样设备上永远只有一对有效令牌（轮换链只在审计/排障里有意义）。
   */
  function issueTokens(deviceId: string, userId: number, meta: RequestMeta, at: string): MobileAuthTokens {
    const accessToken = newToken(MOBILE_ACCESS_TOKEN_PREFIX)
    const refreshToken = newToken(MOBILE_REFRESH_TOKEN_PREFIX)
    const accessExpiresAt = isoPlusMs(at, MOBILE_ACCESS_TTL_MS)
    const refreshExpiresAt = isoPlusDays(at, MOBILE_REFRESH_TTL_DAYS)
    db.tx(() => {
      revokeTokensForDevice(db, deviceId, at, 'rotated')
      insertToken(db, {
        id: sha256Hex(accessToken),
        deviceId,
        userId,
        at,
        expiresAt: accessExpiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
        appVersion: null,
      })
      insertToken(db, {
        id: sha256Hex(refreshToken),
        deviceId,
        userId,
        at,
        // refresh 的 expires_at 也写库：过期后连轮换都不允许（60 天没打开过 App = 重新登录）
        expiresAt: refreshExpiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
        appVersion: null,
      })
      updateDeviceRow(db, deviceId, { lastAuthAt: at, updatedAt: at })
    })
    const row = db.get<{ username: string; display_name: string }>(
      'SELECT username, display_name FROM users WHERE id = ?',
      userId,
    )
    return {
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt,
      deviceId,
      user: {
        id: userId,
        username: row?.username ?? '',
        displayName: row?.display_name ?? '',
      },
    }
  }

  /** 设备被吊销（refresh 重放 / 用户退出）：设备行 + 全部令牌 + 事件（关通道） */
  function revokeDevice(userId: number, deviceId: string, reason: 'user' | 'expired', detail: Record<string, unknown>): void {
    const at = nowIso()
    db.tx(() => {
      revokeDeviceRow(db, { deviceId, at, reason, revokedBy: userId })
      revokeTokensForDevice(db, deviceId, at, 'device-revoked')
    })
    audit.log({
      actorId: userId,
      actorIp: null,
      action: 'mobile.device.revoke',
      targetType: 'desktop.device',
      targetId: deviceId,
      detail,
    })
    // 已建立的手机通道立刻关（不等 20 秒复查）
    deps.events.emit('mobile.device.revoked', { userId, deviceId })
  }

  /**
   * 「这台手机」= 同一用户 + 同一设备名 + 同一平台、且**当前没有任何有效令牌**的移动设备。
   *
   * 契约的登录请求没有安装指纹，只能按名字认；但如果无条件复用，两台同型号手机
   * （App 给的默认设备名一样）会共用一行，每次 refresh 互相把对方顶掉。所以只在
   * 「这台设备上次登录的令牌都失效了」时复用（退出登录后重登、令牌过期后重登）。
   */
  /**
   * 登录用哪条设备记录（顺序：installId 命中 → 历史复用 → 新建）。
   *
   * `installId` 是 App 首次启动生成、本地持久化的安装标识（Hub 存 `sha256(userId:installId)`）。
   * 有它之后，同一台手机无论重新登录多少次都复用同一条设备记录——以前每次登录都新建一条，
   * 网页「桌面设备」里会堆出一串同名「Android · 7SUN」，还会把设备上限（10 台）顶满、
   * 反过来把正在用的设备顶掉、逼 App 重新登录（2026-10-26 真机反馈）。
   *
   * `platform` 是**设备台账里的手机平台**，WP54a 起有第三个值 `'web'`（Hub 同源托管的手机网页版）。
   * 它只用于「按名字+平台复用」与「同名同平台去重」两处判据：**web 与 android 是两台设备**，
   * 永远不会被当成同一台（网页版给的设备名以「手机网页版 · 」开头，本来也不会撞名）。
   * `installId` 是各端本地生成的（App 存在原生偏好里、网页版存在 `localStorage` 里，按来源隔离），
   * 所以同一个人「手机 App + 同一部手机的浏览器」两条记录各带自己的 install_key，互不覆盖。
   */
  function deviceFor(
    userId: number,
    deviceName: string,
    platform: DesktopMobilePlatform,
    installId: string | undefined,
    at: string,
  ): string {
    const installKey = installId === undefined ? null : installKeyOf(userId, installId)
    if (installKey !== null) {
      const existing = findActiveDeviceByInstallKey(db, userId, installKey)
      if (existing !== undefined) {
        updateDeviceRow(db, existing.device_id, {
          name: deviceName,
          mobilePlatform: platform,
          lastAuthAt: at,
          updatedAt: at,
        })
        mergeDuplicateMobileDevices(userId, existing.device_id, deviceName, platform, at)
        return existing.device_id
      }
    }
    const reusable = findReusableMobileDevice(db, userId, deviceName, platform, at)
    if (reusable !== undefined) {
      updateDeviceRow(db, reusable.device_id, {
        lastAuthAt: at,
        updatedAt: at,
        ...(installKey === null ? {} : { installKey }),
      })
      if (installKey !== null) {
        mergeDuplicateMobileDevices(userId, reusable.device_id, deviceName, platform, at)
      }
      return reusable.device_id
    }
    // 上限：顶掉最老的一台，而不是让用户登录失败（手机是主入口，不能因为台账满了进不去）
    if (countActiveMobileDevices(db, userId) >= MOBILE_MAX_DEVICES_PER_USER) {
      const oldest = findOldestActiveMobileDevice(db, userId)
      if (oldest !== undefined) {
        db.tx(() => {
          revokeDeviceRow(db, { deviceId: oldest.device_id, at, reason: 'expired', revokedBy: userId })
          revokeTokensForDevice(db, oldest.device_id, at, 'device-revoked')
        })
        deps.events.emit('mobile.device.revoked', { userId, deviceId: oldest.device_id })
        audit.log({
          actorId: userId,
          actorIp: null,
          action: 'mobile.device.evict',
          targetType: 'desktop.device',
          targetId: oldest.device_id,
          detail: { reason: 'device-limit', max: MOBILE_MAX_DEVICES_PER_USER },
        })
      }
    }
    const deviceId = newDeviceId()
    insertDevice(db, {
      deviceId,
      userId,
      installKey,
      name: deviceName,
      kind: 'mobile',
      mobilePlatform: platform,
      // 桌面端的 platform/os/arch/appVersion 对手机不适用 → NULL（不是空串）
      capabilitiesJson: null,
      at,
      registeredAt: at,
    })
    if (installKey !== null) {
      mergeDuplicateMobileDevices(userId, deviceId, deviceName, platform, at)
    }
    return deviceId
  }

  /**
   * 吊销同一用户下「同名同平台」的其它有效手机设备（历史重复记录）。
   * 只处理手机、只处理同名同平台：不会误伤桌面端 / 另一台型号不同的手机。
   *
   * 「同平台」是按 `mobile_platform` 精确比较的（WP54a）：**web 与 android/ios 永远不互相合并** ——
   * 网页版和 App 是两台各自有令牌的设备，合并等于把其中一台踢下线。
   */
  function mergeDuplicateMobileDevices(
    userId: number,
    keepDeviceId: string,
    deviceName: string,
    platform: DesktopMobilePlatform,
    at: string,
  ): number {
    const duplicates = listDuplicateLegacyMobileDevices(db, userId, keepDeviceId, deviceName, platform)
    for (const duplicate of duplicates) {
      db.tx(() => {
        revokeDeviceRow(db, {
          deviceId: duplicate.device_id,
          at,
          // revoke_reason 有 CHECK 约束，合法值里复用 'expired'（语义：被新记录取代）
          reason: 'expired',
          revokedBy: userId,
        })
        revokeTokensForDevice(db, duplicate.device_id, at, 'device-revoked')
      })
      deps.events.emit('mobile.device.revoked', { userId, deviceId: duplicate.device_id })
      audit.log({
        actorId: userId,
        actorIp: null,
        action: 'mobile.device.merge',
        targetType: 'desktop.device',
        targetId: duplicate.device_id,
        detail: { reason: 'duplicate-device', keptDeviceId: keepDeviceId, name: deviceName },
      })
    }
    return duplicates.length
  }

  /** 每次成功认证顺带刷新「最后在线」：手机没有独立心跳，用它替代 */
  function touchDevice(deviceId: string, at: string): void {
    const previous = lastTouch.get(deviceId) ?? 0
    const nowMs = clock.now().getTime()
    if (nowMs - previous < TOUCH_INTERVAL_MS) return
    if (lastTouch.size > 10_000) lastTouch.clear()
    lastTouch.set(deviceId, nowMs)
    updateDeviceRow(db, deviceId, { lastReportAt: at })
  }

  return {
    login(input, meta): MobileAuthTokens {
      consumeIpLimit(loginLimit, meta)
      // 凭据校验与网页登录同一份实现（限流/锁定/审计/每日赠送都在里面）
      const user = deps.services.auth.authenticateForDevice(
        { username: input.username, password: input.password },
        meta,
      )
      assertAccountUsable(user.status, user.mustChangePassword, null)
      const at = nowIso()
      const deviceId = deviceFor(user.id, input.deviceName, input.platform, input.installId, at)
      const tokens = issueTokens(deviceId, user.id, meta, at)
      audit.log({
        actorId: user.id,
        actorIp: meta.ip,
        action: 'mobile.login',
        targetType: 'desktop.device',
        targetId: deviceId,
        detail: { platform: input.platform, deviceName: input.deviceName },
      })
      logger.debug({ userId: user.id, deviceId }, '手机登录：签发设备令牌')
      return {
        ...tokens,
        user: { id: user.id, username: user.username, displayName: user.displayName },
      }
    },

    refresh(input, meta): MobileAuthTokens {
      consumeIpLimit(refreshLimit, meta)
      const at = nowIso()
      const row = findTokenJoin(db, sha256Hex(input.refreshToken))
      if (row === undefined) {
        // 座舱令牌（WP56b）：同一前缀、另一张表。它在实现里自己校验过期/吊销，
        // 不是座舱令牌时会抛同一个 DEVICE_TOKEN_INVALID（App 的行为不变）
        const cockpit = deps.services.cockpitAuth
        if (input.refreshToken.startsWith(MOBILE_REFRESH_TOKEN_PREFIX) && cockpit !== undefined) {
          return cockpit.refresh(input.refreshToken, meta)
        }
        // 找不到 = 伪造/已清理；与「过期」同一种用户动作（重新登录）
        throw new HubError('DEVICE_TOKEN_INVALID', '登录已失效，请重新登录')
      }
      if (row.device_kind !== 'mobile') {
        // 桌面设备令牌不能拿来换手机令牌（前缀本就不同，这里是纵深防御）
        throw new HubError('DEVICE_TOKEN_INVALID', '登录已失效，请重新登录')
      }
      if (row.token_revoked_at !== null) {
        const rotatedAt = row.token_revoked_at
        const elapsed = Date.parse(at) - Date.parse(rotatedAt)
        if (row.token_revoked_reason === 'rotated' && elapsed <= MOBILE_REFRESH_REPLAY_GRACE_MS) {
          // 并发刷新（App 同时发两次）：不判重放，让客户端用另一份新令牌继续
          logger.debug({ deviceId: row.device_id, elapsed }, '手机 refresh：宽限期内重复使用旧令牌')
          throw new HubError('DEVICE_TOKEN_INVALID', '登录状态刚更新过，请用新的令牌重试')
        }
        if (row.token_revoked_reason === 'rotated') {
          // 旧 refresh 被重放 → 令牌可能已泄漏：吊销整台设备
          audit.log({
            actorId: row.user_id,
            actorIp: meta.ip,
            action: 'mobile.auth.refresh-replay',
            targetType: 'desktop.device',
            targetId: row.device_id,
            detail: { elapsedMs: elapsed },
          })
          revokeDevice(row.user_id, row.device_id, 'user', { reason: 'refresh-replay' })
          throw new HubError('DEVICE_REVOKED', '这台设备已被吊销，请重新登录')
        }
        throw new HubError('DEVICE_REVOKED', '这台设备已被吊销，请重新登录')
      }
      if (row.device_status !== 'active') throw new HubError('DEVICE_REVOKED', '这台设备已被吊销，请重新登录')
      if (isExpired(row.token_expires_at, at)) {
        throw new HubError('DEVICE_TOKEN_INVALID', '登录已过期，请重新登录')
      }
      assertAccountUsable(row.user_status, row.must_change_password === 1, row.deleted_at)
      const tokens = issueTokens(row.device_id, row.user_id, meta, at)
      touchDevice(row.device_id, at)
      return tokens
    },

    consolidate(principal, meta): number {
      const row = getDeviceRow(db, principal.deviceId)
      if (row === undefined || row.user_id !== principal.user.id) return 0
      const at = nowIso()
      const removed = mergeDuplicateMobileDevices(
        principal.user.id,
        principal.deviceId,
        row.name,
        /**
         * `?? 'android'` 是给 126 之前的老数据的兜底：那时 `mobile_platform` 还是可空的裸列，
         * 万一有一条手机行的平台是 NULL，按 android 处理（与当时唯一的客户端一致）。
         * WP54a 之后新写的手机行一定有平台（android / ios / web），兜底不改变任何现有行的含义；
         * 而且它不影响「web 不与 android 合并」：web 行的平台一定读得出 'web'，不会走到兜底。
         */
        (row.mobile_platform ?? 'android') as DesktopMobilePlatform,
        at,
      )
      if (removed > 0) {
        logger.debug({ userId: principal.user.id, deviceId: principal.deviceId, removed }, '手机设备合并')
        audit.log({
          actorId: principal.user.id,
          actorIp: meta.ip,
          action: 'mobile.device.consolidate',
          targetType: 'desktop.device',
          targetId: principal.deviceId,
          detail: { removed },
        })
      }
      return removed
    },

    logout(principal, meta): void {
      if (principal.scope === 'cockpit') {
        deps.services.cockpitAuth?.logout(principal.user.id, meta)
        return
      }
      const at = nowIso()
      db.tx(() => {
        revokeDeviceRow(db, { deviceId: principal.deviceId, at, reason: 'user', revokedBy: principal.user.id })
        revokeTokensForDevice(db, principal.deviceId, at, 'logout')
      })
      audit.log({
        actorId: principal.user.id,
        actorIp: meta.ip,
        action: 'mobile.logout',
        targetType: 'desktop.device',
        targetId: principal.deviceId,
        detail: { tokenId: principal.tokenId.slice(0, 12) },
      })
      deps.events.emit('mobile.device.revoked', { userId: principal.user.id, deviceId: principal.deviceId })
    },

    resolveAccessToken(plain): MobileTokenResolution {
      if (!plain.startsWith(MOBILE_ACCESS_TOKEN_PREFIX) || plain.length > 128) return { ok: false, reason: 'invalid' }
      const tokenId = sha256Hex(plain)
      const row = findTokenJoin(db, tokenId)
      if (row === undefined || row.device_kind !== 'mobile') {
        // 座舱令牌（WP56b）在另一张表里：前缀相同、哈希同一口径，所以先试它再下结论
        const cockpit = deps.services.cockpitAuth?.resolveAccessToken(plain) ?? null
        return cockpit ?? { ok: false, reason: 'invalid' }
      }
      if (row.device_status !== 'active' || row.deleted_at !== null) return { ok: false, reason: 'revoked' }
      if (row.token_revoked_at !== null) {
        // 轮换掉的旧令牌 = 已被新令牌取代（App 应该 refresh），不是设备被吊销
        return { ok: false, reason: row.token_revoked_reason === 'rotated' ? 'rotated' : 'revoked' }
      }
      if (row.user_status !== 'active' || row.must_change_password === 1) return { ok: false, reason: 'account' }
      const at = nowIso()
      if (isExpired(row.token_expires_at, at)) return { ok: false, reason: 'expired' }
      // access 不滑动续期（1 小时就是 1 小时）：过期只能 refresh
      touchDevice(row.device_id, at)
      return {
        ok: true,
        principal: {
          user: sessionUserOf(row),
          deviceId: row.device_id,
          tokenId,
          scope: 'mobile',
        },
      }
    },

    isDeviceUsable(userId, deviceId): boolean {
      // 座舱令牌的「设备」是从管理员 id 派生的伪 id（不落 desktop_devices）：
      // 判据变成「管理员还有效 + 还有活着的座舱令牌」，见 cockpit-auth
      if (deviceId === pseudoDeviceIdFor(userId)) {
        return deps.services.cockpitAuth?.isAdminUsable(userId) ?? false
      }
      const row = getDeviceRow(db, deviceId)
      return row !== undefined && row.user_id === userId && row.status === 'active'
    },
  }
}

/** 供通道/路由判断用：`Authorization: Bearer dshm_at_…` → 明文（不是手机 access token 就 null） */
export function readMobileBearer(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const matched = /^bearer\s+(\S+)$/iu.exec(value.trim())
  if (!matched) return null
  const token = matched[1]!
  return token.startsWith(MOBILE_ACCESS_TOKEN_PREFIX) ? token : null
}
