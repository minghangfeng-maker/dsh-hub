import type {
  DesktopAgentModeKeyResponse,
  DesktopAuthRefreshResponse,
  DesktopAuthStartRequest,
  DesktopAuthStartResponse,
  DesktopAuthTokenRequest,
  DesktopAuthTokenResponse,
  DesktopAuthorizeDecisionResponse,
  DesktopAuthorizeView,
  DesktopBatchRevokeResponse,
  DesktopDevice,
  DesktopDeviceDetailResponse,
  DesktopDeviceListQuery,
  DesktopDeviceListResponse,
  DesktopDeviceReportRequest,
  DesktopDeviceReportResponse,
  DesktopDeviceRevokeResponse,
  DesktopLogoutResponse,
  DesktopMyDevicesResponse,
  DesktopOverviewCounts,
  DesktopRenameDeviceResponse,
  DesktopRevokeReason,
  DesktopSessionResponse,
  RelayAgentMode,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { RequestOrigin } from '../../server/public-request.js'
import type { SessionUser } from '../../lib/session.js'

/**
 * 桌面端模块（WP25a）：登录（D2）、设备台账与上报（D6）、会话、每设备的中转站/模式密钥。
 *
 * 模块边界（01 §4）：设备表与令牌表归本模块；**中转站密钥归 relay**（本模块只调
 * `relay.mintDeviceKey` / `relay.deviceKeySecret` / `relay.revokeDeviceKeys`）；
 * 模式是否开通归 agent-modes（`isOpenFor`）。本模块不 import `deps.driver`，
 * 没有任何 exec / 文件读取能力 —— 这是隐私边界（D6 §4.3 L4）的技术落点。
 */

/** 设备令牌解析结果里「设备是谁」的部分（放 req.desktop，供审计与路由判断用） */
export interface DesktopDeviceIdentity {
  /** `desktop_device_tokens.id` = sha256(令牌) hex */
  tokenId: string
  deviceId: string
  deviceName: string
  userId: number
}

/**
 * 设备令牌的鉴权主体：`user` 与 cookie 会话同形，所以既有 `/api/me/*` 端点零改动可用；
 * `device` 是设备维度的附加身份。
 */
export interface DesktopPrincipal {
  user: SessionUser
  device: DesktopDeviceIdentity
}

export interface DesktopSessionEnvelope {
  body: DesktopSessionResponse
  /** 内容哈希（角色 + 标签 + 余额 + 设备名）：`If-None-Match` 命中即 304 */
  etag: string
}

export interface DesktopService {
  // ── 登录（PKCE + 回环）──────────────────────────────────────────────────
  /** `POST /api/desktop/auth/start`（免登录） */
  start(input: DesktopAuthStartRequest, meta: RequestMeta, origin?: RequestOrigin): DesktopAuthStartResponse
  /** `GET /api/desktop/auth/requests/:id`（网页会话） */
  view(requestId: string, user: SessionUser): DesktopAuthorizeView
  /** `POST /api/desktop/auth/requests/:id/approve|deny`（网页会话 + CSRF） */
  decide(
    requestId: string,
    allow: boolean,
    user: SessionUser,
    meta: RequestMeta,
  ): DesktopAuthorizeDecisionResponse
  /** `POST /api/desktop/auth/token`（免登录）：code + verifier → 设备令牌 + deviceId */
  exchange(input: DesktopAuthTokenRequest, meta: RequestMeta): DesktopAuthTokenResponse
  /** `POST /api/desktop/auth/refresh`（Bearer）：轮换 */
  refresh(principal: DesktopPrincipal, meta: RequestMeta): DesktopAuthRefreshResponse
  /** `POST /api/desktop/auth/logout`（Bearer）：吊销当前令牌（设备与密钥保留） */
  logout(principal: DesktopPrincipal, meta: RequestMeta): DesktopLogoutResponse

  // ── 设备令牌解析（app.ts 的会话钩子调用）────────────────────────────────
  /** 用明文设备令牌解析出鉴权主体；无效/过期/吊销/设备吊销/用户不可用一律 null */
  resolveDeviceToken(plain: string): DesktopPrincipal | null

  // ── 会话 ────────────────────────────────────────────────────────────────
  /** `GET /api/desktop/session`（Bearer）：角色 / 积分 / 设备 + ETag */
  session(principal: DesktopPrincipal): DesktopSessionEnvelope

  // ── 设备 ────────────────────────────────────────────────────────────────
  /** `POST /api/desktop/devices/report`（Bearer）：心跳 + 应用结果 */
  report(
    principal: DesktopPrincipal,
    input: DesktopDeviceReportRequest,
    meta: RequestMeta,
  ): DesktopDeviceReportResponse
  /** `GET /api/me/desktop-devices`（网页会话） */
  listMine(userId: number): DesktopMyDevicesResponse
  /** `DELETE /api/me/desktop-devices/:id`（网页会话）：吊销自己的设备 */
  revokeMine(userId: number, deviceId: string, meta: RequestMeta): void
  /** `GET /api/admin/desktop-devices`（管理端） */
  listAdmin(query: DesktopDeviceListQuery): DesktopDeviceListResponse
  /** `POST /api/admin/desktop-devices/:id/revoke`（管理端） */
  adminRevoke(deviceId: string, actorId: number, meta: RequestMeta): DesktopDeviceRevokeResponse
  /** `GET /api/admin/desktop-devices/:deviceId`（管理端）：台账 + 插件清单 + 最近 20 条审计 */
  detail(deviceId: string): DesktopDeviceDetailResponse
  /** `PATCH /api/me/desktop-devices/:deviceId`（网页会话）：只能改自己的（别人的 404） */
  rename(
    userId: number,
    deviceId: string,
    name: string,
    meta: RequestMeta,
  ): DesktopRenameDeviceResponse
  /** `POST /api/admin/desktop-devices/revoke`（管理端，需 reauth）：批量 ≤50 台，逐台结果 */
  batchRevoke(
    deviceIds: readonly string[],
    actorId: number,
    meta: RequestMeta,
  ): DesktopBatchRevokeResponse
  /** 概览的桌面计数（`total = online + stale + revoked`） */
  overview(): DesktopOverviewCounts
  /**
   * 清理「已过期超过 30 天」的设备令牌行（WP25e 交付物 9）。
   * 由模块的定时任务调用，返回删除条数（>0 时写一条汇总审计）。
   */
  cleanupExpiredTokens(): number

  // ── 每设备密钥（裁决 #8、#11）──────────────────────────────────────────
  /** `POST /api/desktop/agent-mode-key`（Bearer）：这台设备自己的模式密钥 */
  agentModeKey(
    principal: DesktopPrincipal,
    mode: RelayAgentMode,
    meta: RequestMeta,
  ): DesktopAgentModeKeyResponse

  // ── 级联吊销（改密 / 停用 / 删除）───────────────────────────────────────
  /**
   * 吊销该用户**全部设备**（`status='revoked'`）+ 全部令牌 + 全部设备密钥。
   * 用于「账号被停用 / 软删除」。返回被吊销的设备数。
   */
  revokeAllForUser(userId: number, reason: DesktopRevokeReason): number
  /**
   * 只吊销**令牌与设备密钥**，设备行保持 active（用户重新登录即复用同一台设备）。
   * 用于「用户改密码」。返回被吊销的令牌数。
   */
  revokeTokensForUser(userId: number, reason: DesktopRevokeReason): number

  /**
   * 彻底删除用户（回收站 purge）时**物理删除**设备行、令牌与插件清单（外键 CASCADE）。
   * 返回删除的设备数；审计里仍留着 180 天的登录/吊销痕迹（D6 §7.4）。
   */
  purgeUser(userId: number): number

  /** 设备行 → 契约视图（路由与测试共用；snake_case → camelCase 的唯一实现点） */
  toDeviceView(row: DesktopDeviceRowView): DesktopDevice

  /**
   * 某台设备是否仍然有效（WP40a）：手机通道的复查用它，
   * 「用户吊销设备 / 管理员吊销 / 账号被停用」都会让它返回 false。
   * 别人的设备一律 false（不区分「不存在」与「不是你的」，避免探测）。
   */
  isDeviceActive(userId: number, deviceId: string): boolean
}

/** 视图映射的输入：只要求设备行的这几个字段（测试可以构造） */
export interface DesktopDeviceRowView {
  device_id: string
  /** 设备所属用户（desiredRevision 要按用户/角色算；查询都是 `SELECT *` / `d.*`，行里一定有它） */
  user_id: number
  name: string
  /** WP40a：设备种类与手机平台（老库靠 126 迁移补的默认值是 'desktop'） */
  kind?: string
  mobile_platform?: string | null
  platform: string | null
  os_major: string | null
  arch: string | null
  app_version: string | null
  app_channel: string | null
  runtime_version: string | null
  capabilities_json: string | null
  applied_revision: number | null
  applied_at: string | null
  apply_state: string
  apply_error: string | null
  apply_error_count: number | null
  first_seen_at: string
  registered_at: string | null
  last_report_at: string | null
  last_auth_at: string | null
  revoked_at: string | null
  revoke_reason: string | null
  created_at: string
  status: string
}
