import { randomBytes } from 'node:crypto'
import {
  DESKTOP_AGENT_MODE_KEY_REFS,
  DESKTOP_DEVICE_AUDIT_LIMIT,
  DESKTOP_PERMISSIONS,
  DESKTOP_RELAY_KEY_REF,
  DESKTOP_REPORT_INTERVAL_MAX_SEC,
  DESKTOP_TOKEN_ABSOLUTE_DAYS,
  DESKTOP_TOKEN_PREFIX,
  DESKTOP_TOKEN_RANDOM_LENGTH,
  DESKTOP_TOKEN_TTL_DAYS,
  DesktopCapabilitiesSchema,
  type DesktopAgentModeKeyResponse,
  type DesktopApplyErrorCode,
  type DesktopApplyState,
  type DesktopAppChannel,
  type DesktopArch,
  type DesktopAuthStartRequest,
  type DesktopAuthStartResponse,
  type DesktopAuthTokenRequest,
  type DesktopAuthTokenResponse,
  type DesktopAuthorizeDecisionResponse,
  type DesktopAuthorizeView,
  type DesktopAuthRefreshResponse,
  type DesktopBatchRevokeItem,
  type DesktopBatchRevokeResponse,
  type DesktopDevice,
  type DesktopDeviceBrief,
  type DesktopDeviceDetailResponse,
  type DesktopDeviceListQuery,
  type DesktopDeviceListResponse,
  type DesktopDeviceReportRequest,
  type DesktopDeviceReportResponse,
  type DesktopDeviceRevokeResponse,
  type DesktopLogoutResponse,
  type DesktopMyDevicesResponse,
  type DesktopMobilePlatform,
  type DesktopOverviewCounts,
  type DesktopPlatform,
  type DesktopPluginSource,
  type DesktopPluginState,
  type DesktopPresence,
  type DesktopRenameDeviceResponse,
  type DesktopRevokeReason,
  type DesktopSessionResponse,
  type DesktopSessionUser,
  type RelayAgentMode,
} from '@dsh-hub/shared'
import type { AppDeps, RequestMeta } from '../../context.js'
import { isoPlusDays, isoPlusMs } from '../../lib/clock.js'
import { randomString, sha256Hex, timingSafeEqualStr } from '../../lib/crypto.js'
import { HubError } from '../../lib/errors.js'
import { createWindowCounter, isLoopbackIp } from '../../lib/rate-limit.js'
import { roleLabelText } from '../../lib/role-label.js'
import { findUserById } from '../../lib/user-view.js'
import type { SessionUser } from '../../lib/session.js'
import type { RelayService } from '../relay/types.js'
import type { RequestOrigin } from '../../server/public-request.js'
import { createPendingStore, isPendingExpired, type PendingAuthRequest } from './pending.js'
import {
  countActiveDevices,
  countDevicesForAdmin,
  countDevicesOverview,
  deleteExpiredTokensBefore,
  findActiveDeviceByInstallKey,
  findTokenJoin,
  getAdminDeviceRow,
  getDeviceRow,
  insertDevice,
  insertToken,
  listActiveDevicesByUser,
  listDevicesByUser,
  listDevicesForAdmin,
  listPlugins,
  renewToken,
  replacePlugins,
  revokeDevicesForUser,
  revokeDeviceRow,
  revokeToken,
  revokeTokensForDevice,
  revokeTokensForUser,
  touchToken,
  updateDeviceRow,
  type DesktopDeviceRow,
} from './repo.js'
import type {
  DesktopDeviceRowView,
  DesktopPrincipal,
  DesktopService,
  DesktopSessionEnvelope,
} from './types.js'

/** 每次使用的滑动续期节流：1 小时内不重复写库（app.ts 的 lastTouch 同一做法） */
const TOKEN_RENEW_INTERVAL_MS = 3_600_000
/** `last_used_at` 刷新节流 */
const TOKEN_TOUCH_INTERVAL_MS = 60_000
/** 登录发起限流：10 次 / 10 分钟 / 真实客户端 IP（免登录端点，防刷） */
const START_LIMIT_PER_WINDOW = 10
const START_LIMIT_WINDOW_MS = 10 * 60_000
/** 过期设备令牌保留期：`expires_at` 早于 now-30 天才删（WP25e 交付物 9） */
const TOKEN_CLEANUP_AFTER_EXPIRY_DAYS = 30
/** 设备令牌随机部分的 base62 字母表 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 新设备令牌明文：`dsh_dev_` + 40 位 base62（库里只存 sha256） */
export function newDeviceToken(): string {
  return `${DESKTOP_TOKEN_PREFIX}${randomString(DESKTOP_TOKEN_RANDOM_LENGTH, BASE62)}`
}

/** 新设备标识：`dv_` + 128 bit hex（服务端生成，客户端永不提供 —— 裁决 #1） */
export function newDeviceId(): string {
  return `dv_${randomBytes(16).toString('hex')}`
}

/** PKCE：`base64url(SHA256(verifier))` */
export function pkceChallengeOf(verifier: string): string {
  return Buffer.from(sha256Hex(verifier), 'hex').toString('base64url')
}

/** install_key = sha256('<userId>:<installId>')：按用户加盐，跨账号不可关联（裁决 #1） */
export function installKeyOf(userId: number, installId: string): string {
  return sha256Hex(`${String(userId)}:${installId}`)
}

/**
 * 桌面端服务（WP25a）。SQL 在 repo.ts、短命秘密在 pending.ts、路由策略在 policy.ts；
 * 这里只写业务规则。
 */
export function createDesktopService(deps: AppDeps): DesktopService {
  const { db, clock, settings, audit, logger, config } = deps
  const pending = createPendingStore({ clock })
  const startLimit = createWindowCounter({
    capacity: START_LIMIT_PER_WINDOW,
    windowMs: START_LIMIT_WINDOW_MS,
    clock,
  })
  /** 上报节流：设备 → 上次成功上报的毫秒时间戳（内存表，重启清零即可） */
  const lastReportAt = new Map<string, number>()

  function desktopSettings() {
    return settings.get('desktop')
  }

  function services() {
    return deps.services
  }

  function nowIso(): string {
    return clock.nowIso()
  }

  function offlineCutoff(): string {
    return isoPlusMs(nowIso(), -desktopSettings().offlineAfterSec * 1000)
  }

  // ── 视图映射 ──────────────────────────────────────────────────────────────

  function presenceOf(row: DesktopDeviceRowView, cutoff: string): DesktopPresence {
    if (row.status === 'revoked') return 'revoked'
    if (!row.last_report_at) return 'offline'
    return row.last_report_at >= cutoff ? 'online' : 'offline'
  }

  /** 该设备应达到的清单 revision（下发模块给；模块不可用时 null，不影响台账展示） */
  function desiredRevisionOf(deviceId: string, userId: number): number | null {
    const delivery = services().desktopDelivery
    if (!delivery) return null
    try {
      return delivery.desiredRevisionFor(deviceId, userId)
    } catch {
      // 读不通不该让设备列表 500（下发是附加信息）
      return null
    }
  }

  function toDeviceView(row: DesktopDeviceRowView): DesktopDevice {
    let capabilities: DesktopDevice['capabilities'] = null
    if (row.capabilities_json) {
      try {
        const parsed = DesktopCapabilitiesSchema.safeParse(JSON.parse(row.capabilities_json))
        capabilities = parsed.success ? parsed.data : null
      } catch {
        // 脏数据不该让整个列表 500：当作「没上报能力」
        capabilities = null
      }
    }
    return {
      deviceId: row.device_id,
      name: row.name,
      kind: (row.kind ?? 'desktop') as DesktopDevice['kind'],
      ...(row.mobile_platform === null || row.mobile_platform === undefined
        ? {}
        : { mobilePlatform: row.mobile_platform as DesktopMobilePlatform }),
      platform: row.platform as DesktopPlatform | null,
      osMajor: row.os_major,
      arch: row.arch as DesktopArch | null,
      appVersion: row.app_version,
      appChannel: row.app_channel as DesktopAppChannel | null,
      runtimeVersion: row.runtime_version,
      capabilities,
      appliedRevision: row.applied_revision,
      desiredRevision: desiredRevisionOf(row.device_id, row.user_id),
      appliedAt: row.applied_at,
      applyState: row.apply_state as DesktopApplyState,
      applyErrorCode: (row.apply_error ?? null) as DesktopDevice['applyErrorCode'],
      errorCount: row.apply_error_count,
      presence: presenceOf(row, offlineCutoff()),
      firstSeenAt: row.first_seen_at,
      registeredAt: row.registered_at,
      lastReportAt: row.last_report_at,
      lastAuthAt: row.last_auth_at,
      revokedAt: row.revoked_at,
      revokeReason: (row.revoke_reason ?? null) as DesktopDevice['revokeReason'],
      createdAt: row.created_at,
    }
  }

  function briefOf(row: DesktopDeviceRow): DesktopDeviceBrief {
    return {
      deviceId: row.device_id,
      name: row.name,
      presence: presenceOf(row, offlineCutoff()),
      lastReportAt: row.last_report_at,
    }
  }

  function sessionUserOf(user: {
    id: number
    username: string
    display_name: string
    role: 'user' | 'admin'
    role_label: string
    status: string
  }): DesktopSessionUser {
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      roleLabel: roleLabelText(user.role, user.role_label),
      status: user.status === 'active' || user.status === 'disabled' ? user.status : 'pending',
    }
  }

  function walletOf(userId: number): DesktopAuthTokenResponse['wallet'] {
    const wallet = services().relay?.getWalletRow(userId)
    if (!wallet) return null
    return { balance: wallet.balanceMicro, unit: 'micro-point' }
  }

  function requireRelay() {
    const relay = services().relay
    if (!relay) throw new HubError('INTERNAL', 'relay service 未装配')
    return relay
  }

  // ── 登录：发起 / 授权页 / 批准 / 拒绝 ─────────────────────────────────────

  /**
   * 登录发起的限流键（WP25e 交付物 10）：用**真实客户端 IP**，而不是网关地址。
   *
   * 真实 IP 怎么来的（已经在线上的机制，本包只是把它用对）：
   * 公网入口的四层代理加 PROXY v1 → 反向隧道原样透传 → 本机 7443 网关 `readProxyV1Header` →
   * `applyProxiedRemoteAddress` 改写 `socket.remoteAddress` → `trustProxy: false` 下 `req.ip` 就是它
   * （`server/listeners.ts`；任何 `X-Forwarded-*` 都不采信，02 §5）。
   *
   * 三种情况：
   * 1. 本机请求（7700，非公网）且是回环 IP → **不计数**：与 `auth` 的 `consumeIpLimit` 同一口径
   *    （02 §5「回环豁免只对经 7700 的本机请求生效」），否则本机验收/冒烟会把自己挡住；
   * 2. 公网请求 → 按真实 IP 计数（正常情况，一人一个桶）；
   * 3. 公网请求但 IP 仍是回环 = PROXY UNKNOWN 的兜底（反向隧道出口）→ 全部用户共用一个 IP，
   *    退化成「IP + sha256(installId)」分桶，避免几十个人共用 10 次/10 分钟的窗口。
   */
  function startLimitKey(meta: RequestMeta, installId: string | undefined): string | null {
    if (!meta.publicRequest && (!meta.ip || isLoopbackIp(meta.ip))) return null
    const ip = meta.ip ?? 'unknown'
    if (isLoopbackIp(ip)) {
      // 没有 installId 时只能共用（宁可误伤也不能放开）
      return installId ? `${ip}|i:${sha256Hex(installId).slice(0, 32)}` : ip
    }
    return ip
  }

  function start(
    input: DesktopAuthStartRequest,
    meta: RequestMeta,
    origin?: RequestOrigin,
  ): DesktopAuthStartResponse {
    const key = startLimitKey(meta, input.device.installId)
    const gate = key === null ? null : startLimit.consume(key)
    if (gate !== null && !gate.allowed) {
      throw new HubError('RATE_LIMITED', '登录发起太频繁，请稍后再试', {
        retryAfterSec: gate.retryAfterSec,
      })
    }
    const request = pending.create({
      codeChallenge: input.codeChallenge,
      state: input.state,
      redirectUri: input.redirectUri,
      locale: input.locale,
      device: input.device,
    })
    return {
      requestId: request.requestId,
      // WP52：按请求入口取（边缘入口进来的登录请求给 `HUB_EDGE_ORIGIN`，7443/本机仍是公网入口）
      authorizeUrl: `${origin?.linkOrigin ?? config.publicOrigin}/desktop/authorize?req=${encodeURIComponent(request.requestId)}`,
      expiresAt: request.expiresAt,
    }
  }

  /** 取一个还活着的 pending（过期 → 410；不存在 → 404） */
  function requirePending(requestId: string): PendingAuthRequest {
    const request = pending.get(requestId)
    if (!request) {
      throw new HubError('NOT_FOUND', '登录请求不存在或已失效，请在桌面端重新发起登录')
    }
    if (isPendingExpired(request, nowIso())) {
      pending.remove(requestId)
      throw new HubError('GONE', '登录请求已过期，请在桌面端重新发起登录', { loginCode: 'expired' })
    }
    return request
  }

  function view(requestId: string, user: SessionUser): DesktopAuthorizeView {
    const request = requirePending(requestId)
    return {
      requestId: request.requestId,
      deviceName: request.device.name,
      platform: request.device.platform,
      osMajor: request.device.osMajor,
      arch: request.device.arch,
      appVersion: request.device.appVersion,
      appChannel: request.device.appChannel,
      locale: request.locale,
      user: {
        username: user.username,
        displayName: user.displayName,
        roleLabel: roleLabelText(user.role, findUserById(db, user.id)?.role_label ?? ''),
      },
      expiresAt: request.expiresAt,
      deviceCount: countActiveDevices(db, user.id),
      deviceLimit: desktopSettings().maxDevicesPerUser,
      permissions: [...DESKTOP_PERMISSIONS],
      status: request.status === 'approved' ? 'allowed' : request.status,
    }
  }

  function decide(
    requestId: string,
    allow: boolean,
    user: SessionUser,
    meta: RequestMeta,
  ): DesktopAuthorizeDecisionResponse {
    const request = requirePending(requestId)
    if (request.status !== 'waiting') {
      throw new HubError('CONFLICT', '这条登录请求已经处理过了')
    }
    logger.debug({ requestId, allow, ip: meta.ip }, '桌面登录：用户做出授权决定')
    if (!allow) {
      pending.deny(requestId, user.id)
      // 直接回到客户端的回环地址（带 error），客户端可以立刻结束等待而不是超时
      return { redirectUrl: withQuery(request.redirectUri, { error: 'access_denied', state: request.state }) }
    }
    const approved = pending.approve(requestId, user.id)
    return {
      redirectUrl: withQuery(request.redirectUri, { code: approved.code, state: request.state }),
    }
  }

  // ── 登录：code + verifier → 设备令牌 ──────────────────────────────────────

  function exchange(input: DesktopAuthTokenRequest, meta: RequestMeta): DesktopAuthTokenResponse {
    const request = pending.findByCode(input.code)
    if (!request) {
      throw new HubError('VALIDATION_FAILED', '授权码无效或已使用，请重新登录', { loginCode: 'code_invalid' })
    }
    if (isPendingExpired(request, nowIso())) {
      pending.remove(request.requestId)
      throw new HubError('GONE', '登录请求已过期，请重新登录', { loginCode: 'expired' })
    }
    if (request.status === 'denied') {
      throw new HubError('FORBIDDEN', '用户拒绝了这次登录', { loginCode: 'access_denied' })
    }
    if (request.status !== 'approved' || request.codeUsedAt !== null) {
      throw new HubError('VALIDATION_FAILED', '授权码无效或已使用，请重新登录', { loginCode: 'code_invalid' })
    }
    if (!request.codeExpiresAt || request.codeExpiresAt <= nowIso()) {
      pending.failExchange(request.requestId)
      throw new HubError('VALIDATION_FAILED', '授权码已过期，请重新登录', { loginCode: 'code_invalid' })
    }
    // PKCE S256（常数时间比较）；失败计数，5 次销毁（防爆破）
    if (!timingSafeEqualStr(pkceChallengeOf(input.codeVerifier), request.codeChallenge)) {
      pending.failExchange(request.requestId)
      throw new HubError('VALIDATION_FAILED', 'PKCE 校验失败，请重新登录', {
        loginCode: 'pkce_mismatch',
      })
    }
    if (request.userId === null) {
      throw new HubError('VALIDATION_FAILED', '登录请求缺少授权用户，请重新登录', {
        loginCode: 'code_invalid',
      })
    }
    const userId = request.userId
    const user = findUserById(db, userId)
    if (!user || user.deleted_at !== null || user.status !== 'active') {
      throw new HubError('FORBIDDEN', '账号不可用（可能被停用或待审批），请先在网页端处理', {
        loginCode: 'account_blocked',
      })
    }
    if (user.must_change_password === 1) {
      // WP25e：从 `account_blocked` 里分出来 —— 「去网页端改密」与「账号被停用」的下一步完全不同，
      // 客户端要能直接说清楚（授权页/桌面端都按 details.loginCode 本地化）
      throw new HubError('FORBIDDEN', '请先在网页端修改初始密码，再登录桌面端', {
        loginCode: 'password_change_required',
      })
    }

    const at = nowIso()
    const token = newDeviceToken()
    const tokenId = sha256Hex(token)
    const absoluteExpiresAt = isoPlusDays(at, DESKTOP_TOKEN_ABSOLUTE_DAYS)
    const expiresAt = slidingExpiry(at, at)
    const installKey = request.device.installId ? installKeyOf(userId, request.device.installId) : null
    const maxDevices = desktopSettings().maxDevicesPerUser

    const result = db.tx(() => {
      const existing = installKey ? findActiveDeviceByInstallKey(db, userId, installKey) : undefined
      let device: DesktopDeviceRow
      if (existing) {
        device = existing
        updateDeviceRow(db, device.device_id, {
          name: request.device.name,
          appVersion: request.device.appVersion,
          appChannel: request.device.appChannel,
          runtimeVersion: request.device.runtimeVersion,
          capabilitiesJson: request.device.capabilities ? JSON.stringify(request.device.capabilities) : null,
          registeredAt: at,
          lastAuthAt: at,
          updatedAt: at,
        })
      } else {
        if (countActiveDevices(db, userId) >= maxDevices) {
          throw new HubError(
            'DEVICE_LIMIT_REACHED',
            `已登录的设备数量已达上限（${String(maxDevices)} 台），请先在网页端吊销不用的设备`,
            {
              loginCode: 'device_limit_reached',
              devices: listActiveDevicesByUser(db, userId).map(briefOf),
            },
          )
        }
        const deviceId = newDeviceId()
        insertDevice(db, {
          deviceId,
          userId,
          installKey,
          name: request.device.name,
          platform: request.device.platform,
          osMajor: request.device.osMajor,
          arch: request.device.arch,
          appVersion: request.device.appVersion,
          appChannel: request.device.appChannel,
          runtimeVersion: request.device.runtimeVersion,
          capabilitiesJson: request.device.capabilities ? JSON.stringify(request.device.capabilities) : null,
          at,
          registeredAt: at,
        })
        device = getDeviceRow(db, deviceId)!
      }

      // 同一设备重新登录 = 吊销旧令牌 + 发新令牌（D2 §4.1）
      revokeTokensForDevice(db, device.device_id, at, 'rotated')
      insertToken(db, {
        id: tokenId,
        deviceId: device.device_id,
        userId,
        at,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
        appVersion: request.device.appVersion,
      })

      // 每设备一把中转站密钥（裁决 #8）：登录即签发，库里只留 hash
      const minted = requireRelay().mintDeviceKey({
        userId,
        deviceId: device.device_id,
        name: `桌面端 · ${request.device.name}`,
        scope: 'dsh',
        remember: false,
      })
      updateDeviceRow(db, device.device_id, { relayKeyId: minted.keyId, updatedAt: at })

      return { device: getDeviceRow(db, device.device_id)!, relayKeyId: minted.keyId, secret: minted.secret }
    })

    pending.remove(request.requestId)
    audit.log({
      actorId: userId,
      actorIp: meta.ip,
      action: 'desktop.login',
      targetType: 'desktop.device',
      targetId: result.device.device_id,
      detail: {
        deviceId: result.device.device_id,
        appVersion: request.device.appVersion,
        platform: request.device.platform,
        userAgent: meta.userAgent,
      },
    })

    return {
      token,
      expiresAt,
      absoluteExpiresAt,
      user: sessionUserOf(user),
      wallet: walletOf(userId),
      device: {
        deviceId: result.device.device_id,
        name: result.device.name,
        createdAt: result.device.created_at,
      },
      relay: {
        keyId: result.relayKeyId,
        secret: result.secret,
        ref: DESKTOP_RELAY_KEY_REF,
        baseUrl: requireRelay().publicBaseUrl(),
        scope: 'dsh',
      },
      hub: { publicBaseUrl: config.publicOrigin },
    }
  }

  /** 滑动到期时间：now + 30 天，但不超过 created + 90 天 */
  function slidingExpiry(at: string, createdAt: string): string {
    const sliding = isoPlusDays(at, DESKTOP_TOKEN_TTL_DAYS)
    const absolute = isoPlusDays(createdAt, DESKTOP_TOKEN_ABSOLUTE_DAYS)
    return sliding < absolute ? sliding : absolute
  }

  // ── 令牌解析 ──────────────────────────────────────────────────────────────

  function resolveDeviceToken(plain: string): DesktopPrincipal | null {
    if (!plain.startsWith(DESKTOP_TOKEN_PREFIX) || plain.length > 128) return null
    const row = findTokenJoin(db, sha256Hex(plain))
    if (!row) return null
    if (row.token_revoked_at !== null) return null
    if (row.device_status !== 'active') return null
    if (row.deleted_at !== null) return null
    if (row.user_status !== 'active') return null
    const at = nowIso()
    if (row.token_expires_at <= at) return null

    // 滑动续期 + last_used 刷新（都节流；续期写库最多每小时一次）
    const nowMs = clock.now().getTime()
    if (nowMs - Date.parse(row.token_last_used_at) >= TOKEN_TOUCH_INTERVAL_MS) {
      touchToken(db, row.token_id, at)
    }
    const renewedBase = row.token_renewed_at ?? row.token_created_at
    if (nowMs - Date.parse(renewedBase) >= TOKEN_RENEW_INTERVAL_MS) {
      renewToken(db, row.token_id, at, slidingExpiry(at, row.token_created_at))
    }

    const user: SessionUser = {
      id: row.user_id,
      slug: row.slug,
      username: row.username,
      displayName: row.display_name,
      avatarFile: row.avatar_file,
      role: row.role,
      status: 'active',
      mustChangePassword: row.must_change_password === 1,
      sessionId: `dev:${row.token_id}`,
      createdAt: row.token_created_at,
      expiresAt: row.token_expires_at,
      lastSeenAt: row.token_last_used_at,
      reauthAt: null,
    }
    return {
      user,
      device: {
        tokenId: row.token_id,
        deviceId: row.device_id,
        deviceName: row.device_name,
        userId: row.user_id,
      },
    }
  }

  function refresh(principal: DesktopPrincipal, meta: RequestMeta): DesktopAuthRefreshResponse {
    const row = findTokenJoin(db, principal.device.tokenId)
    if (!row) throw new HubError('DEVICE_TOKEN_INVALID')
    const at = nowIso()
    const absoluteExpiresAt = isoPlusDays(row.token_created_at, DESKTOP_TOKEN_ABSOLUTE_DAYS)
    if (absoluteExpiresAt <= at) {
      throw new HubError('DEVICE_TOKEN_INVALID', '登录已超过 90 天，请重新登录')
    }
    const token = newDeviceToken()
    const tokenId = sha256Hex(token)
    const expiresAt = slidingExpiry(at, at)
    db.tx(() => {
      insertToken(db, {
        id: tokenId,
        deviceId: row.device_id,
        userId: row.user_id,
        at,
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
        appVersion: null,
      })
      revokeToken(db, row.token_id, at, 'rotated', tokenId)
    })
    return { token, expiresAt, absoluteExpiresAt }
  }

  function logout(principal: DesktopPrincipal, meta: RequestMeta): DesktopLogoutResponse {
    void meta
    const revoked = revokeToken(db, principal.device.tokenId, nowIso(), 'logout') ? 1 : 0
    return { revoked }
  }

  // ── 会话与设备 ────────────────────────────────────────────────────────────

  /**
   * 会话里的搜索池开关（WP29）：桌面端据此生成 `@deepseek-ai/dsh-web` 的搜索配置。
   * 只报「开/关 + base URL」，免费额度与单价仍由 `/api/me/tools` 负责（不在这里复制一份）。
   * 中转站没装配（理论上不会）时按关闭处理，不让会话 500。
   */
  function toolsOf(): DesktopSessionResponse['tools'] {
    const relay: RelayService | undefined = services().relay
    if (!relay) return { search: false, baseUrl: null }
    const settings = relay.tools.getSettings()
    if (!settings.enabled || !settings.deliverToDsh) return { search: false, baseUrl: null }
    return { search: true, baseUrl: relay.tools.settingsResponse().publicBaseUrl }
  }

  function session(principal: DesktopPrincipal): DesktopSessionEnvelope {
    const user = findUserById(db, principal.user.id)
    if (!user) throw new HubError('DEVICE_TOKEN_INVALID')
    const body: DesktopSessionResponse = {
      user: {
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        roleLabel: roleLabelText(user.role, user.role_label),
      },
      wallet: walletOf(user.id),
      device: { deviceId: principal.device.deviceId, name: principal.device.deviceName },
      tools: toolsOf(),
    }
    const etag = `"${sha256Hex(JSON.stringify(body)).slice(0, 32)}"`
    return { body, etag }
  }

  function report(
    principal: DesktopPrincipal,
    input: DesktopDeviceReportRequest,
    meta: RequestMeta,
  ): DesktopDeviceReportResponse {
    void meta
    const current = desktopSettings()
    const nowMs = clock.now().getTime()
    const previous = lastReportAt.get(principal.device.deviceId) ?? 0
    const minIntervalMs = current.minReportIntervalSec * 1000
    if (nowMs - previous < minIntervalMs) {
      throw new HubError('RATE_LIMITED', '上报太频繁', {
        retryAfterSec: Math.max(1, Math.ceil((minIntervalMs - (nowMs - previous)) / 1000)),
      })
    }
    const at = nowIso()
    db.tx(() => {
      updateDeviceRow(db, principal.device.deviceId, {
        lastReportAt: at,
        appliedRevision: input.appliedRevision,
        appliedAt: input.appliedAt,
        applyState: input.applyState,
        applyError: input.applyErrorCode,
        applyErrorCount: input.errorCount ?? null,
        ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
        ...(input.appChannel === undefined ? {} : { appChannel: input.appChannel }),
        ...(input.runtimeVersion === undefined ? {} : { runtimeVersion: input.runtimeVersion }),
        updatedAt: at,
      })
      if (input.plugins !== undefined) {
        replacePlugins(db, principal.device.deviceId, input.plugins, at)
      }
    })
    lastReportAt.set(principal.device.deviceId, nowMs)
    return {
      serverTime: at,
      reportIntervalSec: Math.min(current.reportIntervalSec, DESKTOP_REPORT_INTERVAL_MAX_SEC),
      presence: 'online',
      // 心跳只回一个整数：客户端拿它跟本地 appliedRevision 比，不同就去拉清单（D3 §6.6）
      desiredRevision: desiredRevisionOf(principal.device.deviceId, principal.user.id),
    }
  }

  function listMine(userId: number): DesktopMyDevicesResponse {
    const rows = listDevicesByUser(db, userId)
    return {
      items: rows.map(toDeviceView),
      limit: {
        max: desktopSettings().maxDevicesPerUser,
        // 配额口径与 countActiveDevices 一致：只数桌面端（手机有自己的上限，WP40a）
        used: rows.filter((row) => row.status === 'active' && row.kind === 'desktop').length,
      },
    }
  }

  /** 一次吊销 = 设备行 + 全部令牌 + 全部设备密钥（同一次事务里做完） */
  function revokeDevice(input: {
    deviceId: string
    reason: DesktopRevokeReason
    revokedBy: number | null
    at: string
  }): number {
    const userId = getDeviceRow(db, input.deviceId)?.user_id ?? null
    const changed = db.tx(() => {
      const rows = revokeDeviceRow(db, {
        deviceId: input.deviceId,
        at: input.at,
        reason: input.reason,
        revokedBy: input.revokedBy,
      })
      const tokens = revokeTokensForDevice(db, input.deviceId, input.at, 'device-revoked')
      const keys = requireRelay().revokeDeviceKeys(input.deviceId)
      logger.debug({ deviceId: input.deviceId, tokens, keys }, '吊销桌面设备')
      return rows ? 1 : 0
    })
    // 手机通道挂在这台设备上时立刻关闭（手机与桌面共用设备台账，WP40a）
    if (changed > 0 && userId !== null) deps.events.emit('mobile.device.revoked', { userId, deviceId: input.deviceId })
    return changed
  }

  function revokeMine(userId: number, deviceId: string, meta: RequestMeta): void {
    const device = getDeviceRow(db, deviceId)
    if (!device || device.user_id !== userId) throw new HubError('NOT_FOUND', '设备不存在')
    if (device.status === 'revoked') return
    const at = nowIso()
    revokeDevice({ deviceId, reason: 'user', revokedBy: userId, at })
    audit.log({
      actorId: userId,
      actorIp: meta.ip,
      action: 'desktop.revoke',
      targetType: 'desktop.device',
      targetId: deviceId,
      detail: { reason: 'user', byUser: true },
    })
  }

  function listAdmin(query: DesktopDeviceListQuery): DesktopDeviceListResponse {
    const filter = {
      q: query.q,
      presence: query.presence,
      revoked: query.revoked,
      offlineCutoff: offlineCutoff(),
      userId: query.userId,
      platform: query.platform,
      appVersion: query.appVersion,
      // WP56e1：手机与桌面端共用一张表，管理端列表可以只取一类（座舱的 desktop/mobile 两个能力）
      kind: query.kind,
    }
    const total = countDevicesForAdmin(db, filter)
    const rows = listDevicesForAdmin(db, filter, {
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    })
    return {
      items: rows.map((row) => ({
        user: {
          id: row.u_id,
          slug: row.u_slug,
          username: row.u_username,
          displayName: row.u_display_name,
          avatarUrl: row.u_avatar_file ? `/api/avatars/${row.u_avatar_file}` : null,
        },
        device: toDeviceView(row),
        pluginCount: Number(row.plugin_count ?? 0),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  function adminRevoke(deviceId: string, actorId: number, meta: RequestMeta): DesktopDeviceRevokeResponse {
    const device = getDeviceRow(db, deviceId)
    if (!device) throw new HubError('NOT_FOUND', '设备不存在')
    const at = nowIso()
    if (device.status === 'active') {
      revokeDevice({ deviceId, reason: 'admin', revokedBy: actorId, at })
      audit.log({
        actorId,
        actorIp: meta.ip,
        action: 'desktop.admin-revoke',
        targetType: 'desktop.device',
        targetId: deviceId,
        detail: { reason: 'admin', byUser: true, ownerId: device.user_id },
      })
    }
    const updated = getDeviceRow(db, deviceId)
    if (!updated) throw new HubError('INTERNAL', '设备吊销后读不到')
    return { device: toDeviceView(updated) }
  }

  /** `GET /api/admin/desktop-devices/:deviceId`：台账 + 插件清单 + 最近 20 条审计（WP25e 交付物 1） */
  function detail(deviceId: string): DesktopDeviceDetailResponse {
    const row = getAdminDeviceRow(db, deviceId)
    if (!row) throw new HubError('NOT_FOUND', '设备不存在')
    const plugins = listPlugins(db, deviceId).map((plugin) => ({
      name: plugin.package_name,
      version: plugin.version,
      source: plugin.source as DesktopPluginSource,
      state: plugin.state as DesktopPluginState,
      // 库里是 null 时不下发这个键（契约里 `errorCode` 可选，null 会被 strictObject 拦住）
      ...(plugin.error_code === null
        ? {}
        : { errorCode: plugin.error_code as DesktopApplyErrorCode }),
      updatedAt: plugin.updated_at,
    }))
    return {
      user: {
        id: row.u_id,
        slug: row.u_slug,
        username: row.u_username,
        displayName: row.u_display_name,
        avatarUrl: row.u_avatar_file ? `/api/avatars/${row.u_avatar_file}` : null,
      },
      device: toDeviceView(row),
      plugins,
      pluginCount: plugins.length,
      // 审计只按 targetType/targetId 取（`desktop.*` 的 target 都是 desktop.device）：不含 actorIp
      audit: audit.recentForTarget('desktop.device', deviceId, DESKTOP_DEVICE_AUDIT_LIMIT),
    }
  }

  /**
   * `PATCH /api/me/desktop-devices/:deviceId`：用户改自己设备的名字（WP25e 交付物 2）。
   *
   * 别人的设备一律 **404 而不是 403**：403 会暴露「这个 deviceId 真实存在但不是你的」，
   * 而 deviceId 是 128 bit 随机串，404 让枚举拿不到任何信息（与 `/dsh/<用户名>` 同口径）。
   */
  function rename(
    userId: number,
    deviceId: string,
    name: string,
    meta: RequestMeta,
  ): DesktopRenameDeviceResponse {
    const device = getDeviceRow(db, deviceId)
    if (!device || device.user_id !== userId) throw new HubError('NOT_FOUND', '设备不存在')
    const from = device.name
    // 名字没变就什么都不写（不刷 updated_at、不写审计噪音）
    if (from !== name) {
      updateDeviceRow(db, deviceId, { name, updatedAt: nowIso() })
      audit.log({
        actorId: userId,
        actorIp: meta.ip,
        action: 'desktop.rename',
        targetType: 'desktop.device',
        targetId: deviceId,
        detail: { from, to: name },
      })
    }
    const updated = getDeviceRow(db, deviceId)
    if (!updated) throw new HubError('INTERNAL', '设备改名后读不到')
    return { device: toDeviceView(updated) }
  }

  /**
   * `POST /api/admin/desktop-devices/revoke`：批量吊销 ≤50 台（WP25e 交付物 3）。
   *
   * 逐台独立：某台不存在 / 已经吊销 / 单台吊销抛错，都只影响它自己的结果，
   * 其余照常处理（`revoked + skipped = items.length`）。每台写一条审计（同一 action，detail 带 result），
   * 这样「这台设备是被哪一次批量操作吊销的」在审计里可查，而不是只剩一条汇总。
   */
  function batchRevoke(
    deviceIds: readonly string[],
    actorId: number,
    meta: RequestMeta,
  ): DesktopBatchRevokeResponse {
    const at = nowIso()
    const items: DesktopBatchRevokeItem[] = []
    let revoked = 0
    let skipped = 0
    for (const deviceId of new Set(deviceIds)) {
      const device = getDeviceRow(db, deviceId)
      const auditOf = (detail: Record<string, unknown>): void => {
        audit.log({
          actorId,
          actorIp: meta.ip,
          action: 'desktop.admin-revoke',
          targetType: 'desktop.device',
          targetId: deviceId,
          detail: { batch: true, ...detail },
        })
      }
      if (!device) {
        skipped += 1
        items.push({ deviceId, outcome: 'not_found', device: null })
        auditOf({ result: 'not_found' })
        continue
      }
      if (device.status !== 'active') {
        skipped += 1
        items.push({ deviceId, outcome: 'already_revoked', device: toDeviceView(device) })
        auditOf({ result: 'already_revoked', reason: device.revoke_reason, ownerId: device.user_id })
        continue
      }
      try {
        revokeDevice({ deviceId, reason: 'admin', revokedBy: actorId, at })
        const updated = getDeviceRow(db, deviceId)
        revoked += 1
        items.push({
          deviceId,
          outcome: 'revoked',
          device: updated ? toDeviceView(updated) : null,
        })
        auditOf({ result: 'revoked', reason: 'admin', ownerId: device.user_id })
      } catch (error) {
        // 单台失败不影响其余：记日志 + 结果里标 failed（原因不外泄给前端，错误原文在日志里）
        skipped += 1
        logger.warn({ err: error, deviceId }, '批量吊销：单台失败')
        items.push({ deviceId, outcome: 'failed', device: null })
        auditOf({ result: 'failed', reason: 'admin', ownerId: device.user_id })
      }
    }
    return { items, revoked, skipped }
  }

  /** 概览的桌面计数（WP25e 交付物 4）：`total = online + stale + revoked` */
  function overview(): DesktopOverviewCounts {
    const counts = countDevicesOverview(db, offlineCutoff())
    return {
      total: counts.total,
      online: counts.online,
      revoked: counts.revoked,
      stale: Math.max(0, counts.total - counts.online - counts.revoked),
    }
  }

  /**
   * 清理「已过期超过 30 天」的设备令牌行（WP25e 交付物 9）。
   * 由模块的定时任务（`desktopPlugin` 的 onReady + 每小时）调用；删了>0 行才写一条汇总审计。
   */
  function cleanupExpiredTokens(): number {
    const cutoff = isoPlusDays(nowIso(), -TOKEN_CLEANUP_AFTER_EXPIRY_DAYS)
    const removed = deleteExpiredTokensBefore(db, cutoff)
    if (removed > 0) {
      audit.log({
        actorId: null,
        actorIp: null,
        action: 'desktop.tokens.cleanup',
        targetType: 'desktop.token',
        targetId: null,
        detail: { removed, cutoff, afterExpiryDays: TOKEN_CLEANUP_AFTER_EXPIRY_DAYS },
      })
      logger.info({ removed, cutoff }, '清理过期的桌面设备令牌')
    }
    return removed
  }

  // ── 每设备密钥 ────────────────────────────────────────────────────────────

  function agentModeKey(
    principal: DesktopPrincipal,
    mode: RelayAgentMode,
    meta: RequestMeta,
  ): DesktopAgentModeKeyResponse {
    const agentModes = services().agentModes
    if (!agentModes || !agentModes.isOpenFor(mode, principal.user.id)) {
      const label = mode === 'claude-code' ? 'Claude Code' : 'Codex'
      throw new HubError('FORBIDDEN', `${label} 没有对你开放，请联系管理员`)
    }
    const relay = requireRelay()
    const existing = relay.deviceKeySecret(principal.device.deviceId, mode)
    const minted =
      existing ??
      relay.mintDeviceKey({
        userId: principal.user.id,
        deviceId: principal.device.deviceId,
        name: `桌面端 · ${principal.device.deviceName} · ${mode === 'claude-code' ? 'Claude Code' : 'Codex'}`,
        scope: mode,
        // 模式密钥要在多次调用间保持同一把（客户端重装/重读凭据时还要它），所以存加密副本
        remember: true,
      })
    audit.log({
      actorId: principal.user.id,
      actorIp: meta.ip,
      action: 'desktop.agent-mode-key',
      targetType: 'desktop.device',
      targetId: principal.device.deviceId,
      detail: { mode },
    })
    return {
      mode,
      scope: mode,
      keyId: minted.keyId,
      secret: minted.secret,
      ref: DESKTOP_AGENT_MODE_KEY_REFS[mode],
      baseUrl: relay.publicBaseUrl(),
    }
  }

  // ── 级联吊销 ──────────────────────────────────────────────────────────────

  function revokeAllForUser(userId: number, reason: DesktopRevokeReason): number {
    const at = nowIso()
    const devices = listDevicesByUser(db, userId)
    const changed = db.tx(() => {
      const rows = revokeTokensForUser(db, userId, at, reason)
      revokeDevicesForUser(db, userId, at, reason)
      for (const device of devices) requireRelay().revokeDeviceKeys(device.device_id)
      return rows
    })
    // 级联吊销（改密 / 停用 / 删除）：手机通道同样要立刻关（WP40a）
    for (const device of devices) {
      if (device.status === 'active') deps.events.emit('mobile.device.revoked', { userId, deviceId: device.device_id })
    }
    return changed
  }

  /** 彻底删除用户：设备行一删，令牌与插件清单由外键 CASCADE 跟着走 */
  function purgeUser(userId: number): number {
    return db.run('DELETE FROM desktop_devices WHERE user_id = ?', userId).changes
  }

  function revokeTokensForUserOnly(userId: number, reason: DesktopRevokeReason): number {
    const at = nowIso()
    const devices = listDevicesByUser(db, userId)
    const changed = db.tx(() => {
      const rows = revokeTokensForUser(db, userId, at, reason)
      for (const device of devices) requireRelay().revokeDeviceKeys(device.device_id)
      return rows
    })
    // 改密只吊销令牌、保留设备行；但已建立的手机通道同样必须立刻断（否则旧令牌还能用通道）
    for (const device of devices) {
      if (device.status === 'active') deps.events.emit('mobile.device.revoked', { userId, deviceId: device.device_id })
    }
    return changed
  }

  /**
   * 某台设备是否仍然有效（WP40a）：手机通道每 20 秒复查一次设备行，
   * 吊销/删除用户之后即使令牌还没被清掉也不再放行。别人的设备一律 false（不做归属泄漏）。
   */
  function isDeviceActive(userId: number, deviceId: string): boolean {
    const row = getDeviceRow(db, deviceId)
    return row !== undefined && row.user_id === userId && row.status === 'active'
  }

  return {
    start,
    view,
    decide,
    exchange,
    refresh,
    logout,
    resolveDeviceToken,
    session,
    report,
    listMine,
    revokeMine,
    listAdmin,
    adminRevoke,
    detail,
    rename,
    batchRevoke,
    overview,
    cleanupExpiredTokens,
    agentModeKey,
    revokeAllForUser,
    revokeTokensForUser: revokeTokensForUserOnly,
    purgeUser,
    toDeviceView,
    isDeviceActive,
  }
}

/** 往回环地址上拼查询串（保留原有 path；redirect_uri 已被契约限制为无查询串） */
function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}
