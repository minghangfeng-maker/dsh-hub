import {
  DESKTOP_BATCH_REVOKE_MAX,
  DESKTOP_PERMISSIONS,
  DeviceNameSchema,
  type DesktopApplyErrorCode,
  type DesktopApplyState,
  type DesktopAppChannel,
  type DesktopArch,
  type DesktopAuthorizeView,
  type DesktopBatchRevokeItem,
  type DesktopDevice,
  type DesktopDeviceAdminItem,
  type DesktopDeviceAuditItem,
  type DesktopDevicePlugin,
  type DesktopMobilePlatform,
  type DesktopOverviewCounts,
  type DesktopPlatform,
  type DesktopPresence,
  type DesktopRevokeReason,
  type DeviceKind,
  type UserRef,
} from '@dsh-hub/shared'

import { ADMIN_SETTINGS, ADMIN_USERS } from './admin'
import { getMockState, type MockScenario } from './state'

/**
 * 桌面端假接口（**仅开发环境**，`?mock=desktop` 系列；WP25c 交付物 6）。
 *
 * 场景（`?mock=<名>`）：
 * - `desktop`：3 台设备（一台在线、一台离线、一台手机网页版）+ 一条待授权的登录请求；
 * - `desktop-empty`：没有任何设备（看工作台「下载桌面端」入口）；
 * - `desktop-limit`：5 台设备打满上限（授权页展开「先吊销一台」的列表）；
 * - `desktop-expired`：授权请求已过期（410，看错误态）；
 * - `desktop-done`：授权请求已经处理过（看「已经允许」态 + 409）；
 * - `desktop-password`：账号必须先改密（403 + `details.loginCode=password_change_required`，
 *   看授权页的「请先在网页端修改初始密码」+ 改密页链接，WP25f 交付物 7）；
 * - `admin-batch`（管理端）：批量吊销固定给出四种结果（revoked / already_revoked / not_found / failed），
 *   用来走查「未生效」那一列与「重试未生效的 N 台」（WP25f 交付物 2 / 9）。
 *
 * 写接口都是**有状态**的：改名写进 `nameOverride`、吊销写进 `revokedOverride`，
 * 场景切换（`resetDesktopMock`）时清空。
 *
 * 管理端（`?mock=admin` 等）额外给几台别的用户的设备，用来走查筛选、分页与吊销。
 * 设备形状严格按 `DesktopDeviceSchema`（`test/desktop-mocks.test.ts` 会过一遍 schema）。
 */

const MINUTE = 60_000
const NOW = Date.now()
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

/** 本次会话里被吊销的设备 → 原因（夹具本身不改，场景切换时清空） */
const revokedOverride = new Map<number, DesktopRevokeReason>()
/** 本次会话里改过的设备名（`PATCH /api/me/desktop-devices/:id`） */
const nameOverride = new Map<number, string>()
/** 契约要求 `dv_` + 32 位十六进制 */
const deviceId = (n: number): string => `dv_${n.toString(16).padStart(32, '0')}`

/** 离线判定阈值（服务端 `settings.desktop.offlineAfterSec` 默认 180 秒） */
const OFFLINE_AFTER_MS = ADMIN_SETTINGS.desktop.offlineAfterSec * 1000

interface DeviceSeed {
  id: number
  userId: number
  name: string
  /** 手机（WP40a）只有 `kind` + `mobilePlatform`，桌面端才有 platform/osMajor/arch */
  kind?: DeviceKind
  mobilePlatform?: DesktopMobilePlatform
  platform: DesktopPlatform | null
  osMajor: string | null
  arch: DesktopArch | null
  appVersion: string | null
  appChannel: DesktopAppChannel
  runtimeVersion: string | null
  appliedRevision: number | null
  applyState: DesktopApplyState
  applyErrorCode?: DesktopApplyErrorCode
  errorCount?: number
  lastReportMinutesAgo: number | null
  lastAuthMinutesAgo: number | null
  registeredMinutesAgo: number
  firstSeenMinutesAgo: number
  createdAtMinutesAgo: number
  revokedMinutesAgo?: number
  revokeReason?: DesktopRevokeReason
  pluginCount: number
}

/** 当前用户（工作台「桌面设备」）—— `desktop` / `desktop-limit` / `desktop-expired` / `desktop-done` */
const CURRENT_USER_SEEDS: DeviceSeed[] = [
  {
    id: 1,
    userId: 12,
    name: '小桃的 Windows 笔记本',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    appliedRevision: 17,
    applyState: 'applied',
    lastReportMinutesAgo: 0.7,
    lastAuthMinutesAgo: 3 * 60,
    registeredMinutesAgo: 3 * 60,
    firstSeenMinutesAgo: 26 * 24 * 60,
    createdAtMinutesAgo: 26 * 24 * 60,
    pluginCount: 5,
  },
  {
    id: 2,
    userId: 12,
    name: '书房那台台式机',
    platform: 'win32',
    osMajor: '10',
    arch: 'x64',
    appVersion: '0.2.0',
    appChannel: 'nightly',
    runtimeVersion: '0.2.0-rc.1',
    appliedRevision: 14,
    applyState: 'failed',
    applyErrorCode: 'plugin_install_failed',
    errorCount: 1,
    lastReportMinutesAgo: 2 * 24 * 60,
    lastAuthMinutesAgo: 9 * 24 * 60,
    registeredMinutesAgo: 9 * 24 * 60,
    firstSeenMinutesAgo: 40 * 24 * 60,
    createdAtMinutesAgo: 40 * 24 * 60,
    pluginCount: 3,
  },
  {
    // WP54：手机网页版（`/m/`）登录出来的设备。手机与桌面端共用台账（WP40a），
    // 所以它出现在同一张列表里，平台列写「手机网页版」，和 Android / iOS 并列。
    id: 3,
    userId: 12,
    name: '手机网页版 · Chrome · Android',
    kind: 'mobile',
    mobilePlatform: 'web',
    platform: null,
    osMajor: null,
    arch: null,
    appVersion: null,
    appChannel: 'latest',
    runtimeVersion: null,
    appliedRevision: null,
    applyState: 'applied',
    lastReportMinutesAgo: 0.2,
    lastAuthMinutesAgo: 12,
    registeredMinutesAgo: 12,
    firstSeenMinutesAgo: 12,
    createdAtMinutesAgo: 12,
    pluginCount: 0,
  },
]

/** `desktop-limit`：5 台打满（上限 5） */
const LIMIT_SEEDS: DeviceSeed[] = [1, 2, 3, 4, 5].map((index) => ({
  id: index,
  userId: 12,
  name:
    ['小桃的 Windows 笔记本', '书房那台台式机', '公司电脑', '旧笔记本', '虚拟机里的测试机'][index - 1] ??
    '设备',
  platform: index === 4 ? 'linux' : 'win32',
  osMajor: index === 4 ? '24.04' : index === 3 ? '10' : '11',
  arch: 'x64',
  appVersion: index === 5 ? '0.2.0' : '0.2.1',
  appChannel: index === 5 ? 'nightly' : 'latest',
  runtimeVersion: '0.2.1-rc.2',
  appliedRevision: index === 1 ? 17 : 16,
  applyState: index === 5 ? 'pending' : 'applied',
  lastReportMinutesAgo: index <= 2 ? 0.8 * index : 120 * index,
  lastAuthMinutesAgo: 30 * index,
  registeredMinutesAgo: 30 * index,
  firstSeenMinutesAgo: 30 * index,
  createdAtMinutesAgo: 30 * index,
  pluginCount: 5 - index,
}))

/** 管理端：别的用户的设备（id 2 = mint、4 = sakura、7 = 长昵称极端值、6 = 已停用 → 已吊销） */
const ADMIN_SEEDS: DeviceSeed[] = [
  {
    id: 11,
    userId: 2,
    name: 'mint 的 Surface',
    platform: 'win32',
    osMajor: '11',
    arch: 'arm64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    appliedRevision: 17,
    applyState: 'applied',
    lastReportMinutesAgo: 1.2,
    lastAuthMinutesAgo: 5 * 60,
    registeredMinutesAgo: 5 * 60,
    firstSeenMinutesAgo: 12 * 24 * 60,
    createdAtMinutesAgo: 12 * 24 * 60,
    pluginCount: 6,
  },
  {
    id: 12,
    userId: 2,
    name: 'mint 的 MacBook',
    platform: 'darwin',
    osMajor: '14',
    arch: 'arm64',
    appVersion: '0.2.0',
    appChannel: 'latest',
    runtimeVersion: '0.2.0',
    appliedRevision: 12,
    applyState: 'partial',
    lastReportMinutesAgo: 3 * 24 * 60,
    lastAuthMinutesAgo: 7 * 24 * 60,
    registeredMinutesAgo: 7 * 24 * 60,
    firstSeenMinutesAgo: 20 * 24 * 60,
    createdAtMinutesAgo: 20 * 24 * 60,
    pluginCount: 4,
  },
  {
    id: 13,
    userId: 4,
    name: 'sakura 的联想小新',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'nightly',
    runtimeVersion: '0.2.1-rc.2',
    appliedRevision: 17,
    applyState: 'failed',
    applyErrorCode: 'disk_full',
    errorCount: 2,
    lastReportMinutesAgo: 40,
    lastAuthMinutesAgo: 26 * 60,
    registeredMinutesAgo: 26 * 60,
    firstSeenMinutesAgo: 3 * 24 * 60,
    createdAtMinutesAgo: 3 * 24 * 60,
    pluginCount: 5,
  },
  {
    id: 14,
    userId: 7,
    name: '小陈的第三台工作笔记本（出差用）',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.0-rc.2',
    appChannel: 'nightly',
    runtimeVersion: '0.2.0-rc.1',
    appliedRevision: 15,
    applyState: 'pending',
    lastReportMinutesAgo: 5 * 60,
    lastAuthMinutesAgo: 2 * 24 * 60,
    registeredMinutesAgo: 2 * 24 * 60,
    firstSeenMinutesAgo: 2 * 24 * 60,
    createdAtMinutesAgo: 2 * 24 * 60,
    pluginCount: 2,
  },
  {
    id: 15,
    userId: 6,
    name: 'quiet-leaf 的旧台式机',
    platform: 'linux',
    osMajor: '24.04',
    arch: 'arm64',
    appVersion: '0.1.9',
    appChannel: 'latest',
    runtimeVersion: null,
    appliedRevision: null,
    applyState: 'unknown',
    lastReportMinutesAgo: 9 * 24 * 60,
    lastAuthMinutesAgo: 9 * 24 * 60,
    registeredMinutesAgo: 9 * 24 * 60,
    firstSeenMinutesAgo: 30 * 24 * 60,
    createdAtMinutesAgo: 30 * 24 * 60,
    revokedMinutesAgo: 8 * 24 * 60,
    revokeReason: 'user-disabled',
    pluginCount: 0,
  },
  {
    id: 16,
    userId: 1,
    name: '站长的开发机',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    appliedRevision: 17,
    applyState: 'applied',
    lastReportMinutesAgo: 0.4,
    lastAuthMinutesAgo: 90,
    registeredMinutesAgo: 90,
    firstSeenMinutesAgo: 8 * 24 * 60,
    createdAtMinutesAgo: 8 * 24 * 60,
    pluginCount: 6,
  },
]

function isRevoked(seed: DeviceSeed): boolean {
  return seed.revokedMinutesAgo !== undefined || revokedOverride.has(seed.id)
}

function presenceOf(seed: DeviceSeed): DesktopPresence {
  if (isRevoked(seed)) return 'revoked'
  if (seed.lastReportMinutesAgo === null) return 'offline'
  return seed.lastReportMinutesAgo * MINUTE <= OFFLINE_AFTER_MS ? 'online' : 'offline'
}

function toDevice(seed: DeviceSeed): DesktopDevice {
  const reportedAt = seed.lastReportMinutesAgo === null ? null : iso(-seed.lastReportMinutesAgo * MINUTE)
  return {
    deviceId: deviceId(seed.id),
    name: nameOverride.get(seed.id) ?? seed.name,
    // WP54：手机设备带 `kind` / `mobilePlatform`；桌面端老响应里没有这两个键（读端按 desktop 处理）
    ...(seed.kind === undefined ? {} : { kind: seed.kind }),
    ...(seed.mobilePlatform === undefined ? {} : { mobilePlatform: seed.mobilePlatform }),
    platform: seed.platform,
    osMajor: seed.osMajor,
    arch: seed.arch,
    appVersion: seed.appVersion,
    appChannel: seed.appChannel,
    runtimeVersion: seed.runtimeVersion,
    capabilities: { claudeCode: seed.id % 2 === 0, codex: true, pwsh: '7' },
    desiredRevision: seed.appliedRevision,
    appliedRevision: seed.appliedRevision,
    appliedAt:
      seed.appliedRevision === null || seed.lastReportMinutesAgo === null
        ? null
        : iso(-seed.lastReportMinutesAgo * MINUTE),
    applyState: seed.applyState,
    applyErrorCode: seed.applyErrorCode ?? null,
    errorCount: seed.errorCount ?? 0,
    presence: presenceOf(seed),
    firstSeenAt: iso(-seed.firstSeenMinutesAgo * MINUTE),
    registeredAt: iso(-seed.registeredMinutesAgo * MINUTE),
    lastReportAt: reportedAt,
    lastAuthAt: seed.lastAuthMinutesAgo === null ? null : iso(-seed.lastAuthMinutesAgo * MINUTE),
    revokedAt: isRevoked(seed) ? iso(-(seed.revokedMinutesAgo ?? 0) * MINUTE) : null,
    revokeReason: seed.revokeReason ?? revokedOverride.get(seed.id) ?? null,
    createdAt: iso(-seed.createdAtMinutesAgo * MINUTE),
  }
}

/** 当前场景下「我的设备」（工作台 + 授权页超限列表） */
function mySeeds(scenario: MockScenario): DeviceSeed[] {
  const admin = scenario.startsWith('admin') || scenario === 'agent-modes'
  if (admin) return ADMIN_SEEDS.filter((seed) => seed.userId === getMockState().user.id)
  if (scenario === 'desktop-empty') return []
  if (scenario === 'desktop-limit') return LIMIT_SEEDS
  if (scenario === 'desktop-done') return CURRENT_USER_SEEDS.slice(0, 1)
  if (scenario === 'desktop' || scenario === 'desktop-expired') return CURRENT_USER_SEEDS
  return []
}

/** 管理端台账：当前场景的全部设备（含已吊销）；用户场景只有自己的 */
function allSeeds(scenario: MockScenario): DeviceSeed[] {
  if (!(scenario.startsWith('admin') || scenario === 'agent-modes')) return mySeeds(scenario)
  return ADMIN_SEEDS
}

const userRefOf = (userId: number): UserRef => {
  const user = ADMIN_USERS.find((item) => item.id === userId)
  return {
    id: userId,
    slug: user?.slug ?? `umock${String(userId)}`,
    username: user?.username ?? `user${String(userId)}`,
    displayName: user?.displayName ?? `用户 ${String(userId)}`,
    avatarUrl: null,
  }
}

/**
 * 授权页上的那条 pending 请求。requestId 回显 URL 里的 `req`（走查时用任意 id 都能看）。
 * `decided` 记录本次会话里点过什么，刷新后能看到「已经允许 / 已经拒绝」。
 */
let decided: 'waiting' | 'allowed' | 'denied' = 'waiting'

export function resetDesktopMock(): void {
  decided = 'waiting'
  revokedOverride.clear()
  nameOverride.clear()
}

/**
 * 概览里的桌面计数（`GET /api/admin/overview` 的 `desktop`，WP25e 的口径：
 * `total = online + stale + revoked`）。由 `mocks/fetch.ts` 注入给 `handleAdmin`，
 * 这样 admin 与 desktop 两个假接口模块不必互相 import（会成环）。
 */
export function desktopOverviewCounts(): DesktopOverviewCounts {
  const devices = allSeeds(getMockState().scenario).map(toDevice)
  return {
    total: devices.length,
    online: devices.filter((device) => device.presence === 'online').length,
    revoked: devices.filter((device) => device.presence === 'revoked').length,
    stale: devices.filter((device) => device.presence === 'offline').length,
  }
}

/**
 * 设备详情里的插件清单：按 `pluginCount` 从固定池里取前 N 个（顺序稳定，截图可复现）。
 * 形状严格按 `DesktopDevicePluginSchema`（`test/desktop-wpf-mocks.test.ts` 会过 schema）。
 */
const PLUGIN_POOL: { name: string; version: string; source: DesktopDevicePlugin['source'] }[] = [
  { name: '@xmanrui/dsh-im', version: '4.35.1', source: 'hub-default' },
  { name: 'dsh-email', version: '0.16.0', source: 'hub-core' },
  { name: 'dsh-web-search', version: '0.5.0', source: 'hub-core' },
  { name: '@demo-alice/dsh-remotion-video-plugin', version: '0.3.2', source: 'hub-optional' },
  { name: 'dsh-image-tools', version: '0.1.4', source: 'user' },
  { name: 'dsh-file-download', version: '0.2.0', source: 'hub-default' },
]

function pluginsOf(seed: DeviceSeed): DesktopDevicePlugin[] {
  if (isRevoked(seed)) return []
  return PLUGIN_POOL.slice(0, Math.min(seed.pluginCount, PLUGIN_POOL.length)).map((entry, index) => ({
    ...entry,
    state: seed.applyState === 'failed' && index === 0 ? 'failed' : 'enabled',
    ...(seed.applyState === 'failed' && index === 0
      ? { errorCode: seed.applyErrorCode ?? 'unknown' }
      : {}),
    updatedAt: iso(-(seed.lastReportMinutesAgo ?? 0) * MINUTE),
  }))
}

/**
 * 设备详情里的「最近操作」：登录 / 改名（如果有）/ 吊销（如果已吊销）。
 *
 * `desktop.login` 的 `detail.userAgent` 是**故意**留在假数据里的：真实后端的登录审计就带它，
 * 而详情抽屉的隐私口径是不把它摊出来 —— 单测用这个值断言「界面上看不到原始 UA / IP」。
 */
function auditOf(seed: DeviceSeed): DesktopDeviceAuditItem[] {
  const rows: DesktopDeviceAuditItem[] = []
  let id = seed.id * 100
  rows.push({
    id: ++id,
    at: iso(-(seed.lastAuthMinutesAgo ?? 60) * MINUTE),
    action: 'desktop.login',
    actorId: seed.userId,
    actorUsername: userRefOf(seed.userId).username,
    targetType: 'desktop.device',
    targetId: deviceId(seed.id),
    detail: { appVersion: seed.appVersion, platform: seed.platform, userAgent: 'secret-agent/9.9' },
  })
  if (nameOverride.has(seed.id)) {
    rows.push({
      id: ++id,
      at: iso(-5 * MINUTE),
      action: 'desktop.rename',
      actorId: seed.userId,
      actorUsername: userRefOf(seed.userId).username,
      targetType: 'desktop.device',
      targetId: deviceId(seed.id),
      detail: { from: seed.name, to: nameOverride.get(seed.id) ?? seed.name },
    })
  }
  if (isRevoked(seed)) {
    rows.push({
      id: ++id,
      at: iso(-(seed.revokedMinutesAgo ?? 0) * MINUTE),
      action: revokedOverride.has(seed.id) ? 'desktop.admin-revoke' : 'desktop.revoke',
      actorId: revokedOverride.has(seed.id) ? 1 : seed.userId,
      actorUsername: revokedOverride.has(seed.id) ? 'admin' : userRefOf(seed.userId).username,
      targetType: 'desktop.device',
      targetId: deviceId(seed.id),
      detail: { reason: revokedOverride.has(seed.id) ? 'admin' : 'user', byUser: true },
    })
  }
  return rows.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
}

function authorizeView(scenario: MockScenario, requestId: string): DesktopAuthorizeView {
  const state = getMockState()
  const devices = mySeeds(scenario)
  const active = devices.filter((seed) => seed.revokedMinutesAgo === undefined)
  const status = scenario === 'desktop-done' ? 'allowed' : decided
  return {
    requestId,
    deviceName: scenario === 'desktop-limit' ? '第 6 台新设备' : '小桃的 Windows 笔记本',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    locale: 'zh-CN',
    user: {
      username: state.user.username,
      displayName: state.user.displayName,
      roleLabel: state.user.role === 'admin' ? '管理员' : '普通用户',
    },
    expiresAt: iso(8 * MINUTE),
    deviceCount: active.length,
    deviceLimit: ADMIN_SETTINGS.desktop.maxDevicesPerUser,
    permissions: [...DESKTOP_PERMISSIONS],
    status,
  }
}

function page<T>(items: T[], url: URL): { items: T[]; total: number; page: number; pageSize: number } {
  const pageNo = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
  const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? '20') || 20)
  return {
    items: items.slice((pageNo - 1) * pageSize, pageNo * pageSize),
    total: items.length,
    page: pageNo,
    pageSize,
  }
}

/** 管理端筛选（与后端 repo.ts 的口径一致：presence=revoked 时只留已吊销） */
function filterAdmin(scenario: MockScenario, url: URL): DesktopDeviceAdminItem[] {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const presence = url.searchParams.get('presence') ?? ''
  const revoked = url.searchParams.get('revoked') ?? 'active'
  const platform = url.searchParams.get('platform') ?? ''
  const appVersion = url.searchParams.get('appVersion') ?? ''
  const userId = url.searchParams.get('userId')

  return allSeeds(scenario)
    .map((seed) => ({ seed, device: toDevice(seed), user: userRefOf(seed.userId) }))
    .filter(({ seed, device, user }) => {
      if (revoked === 'active' && device.presence === 'revoked') return false
      if (revoked === 'revoked' && device.presence !== 'revoked') return false
      if (presence === 'online' && device.presence !== 'online') return false
      if (presence === 'offline' && device.presence !== 'offline') return false
      if (presence === 'revoked' && device.presence !== 'revoked') return false
      if (platform && seed.platform !== platform) return false
      if (appVersion && seed.appVersion !== appVersion) return false
      if (userId && String(seed.userId) !== userId) return false
      if (q) {
        const haystack = [user.username, user.displayName, device.name, device.deviceId]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
    .map(({ device, user, seed }) => ({ user, device, pluginCount: seed.pluginCount }))
}

function jsonError(
  code: string,
  status: number,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message, details } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * 桌面端假接口入口：命中的返回 `Response`，不命中的返回 `null`（`fetch.ts` 会透传真后端）。
 */
export function handleDesktop(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Response | null {
  const scenario = getMockState().scenario
  const adminScenario = scenario.startsWith('admin') || scenario === 'agent-modes'

  // ── 授权页取数 ──
  /** 「必须改密」的账号：授权页连取数都做不了（与后端一样是 403 + loginCode） */
  const passwordBlocked =
    scenario === 'desktop-password'
      ? jsonError('FORBIDDEN', 403, '请先在网页端修改初始密码，再登录桌面端', {
          loginCode: 'password_change_required',
        })
      : null

  const requestMatch = /^\/api\/desktop\/auth\/requests\/([^/]+)$/.exec(pathname)
  if (requestMatch && method === 'GET') {
    if (passwordBlocked) return passwordBlocked
    if (scenario === 'desktop-expired') {
      return jsonError('GONE', 410, '登录请求已过期，请在桌面端重新发起登录', { loginCode: 'expired' })
    }
    return json(authorizeView(scenario, decodeURIComponent(requestMatch[1] ?? '')))
  }

  const decisionMatch = /^\/api\/desktop\/auth\/requests\/([^/]+)\/(approve|deny)$/.exec(pathname)
  if (decisionMatch && method === 'POST') {
    if (passwordBlocked) return passwordBlocked
    if (scenario === 'desktop-expired') {
      return jsonError('GONE', 410, '登录请求已过期，请在桌面端重新发起登录', { loginCode: 'expired' })
    }
    if (scenario === 'desktop-done' || decided !== 'waiting') {
      return jsonError('CONFLICT', 409, '这条登录请求已经处理过了')
    }
    decided = decisionMatch[2] === 'approve' ? 'allowed' : 'denied'
    const query =
      decided === 'allowed'
        ? `code=${'a'.repeat(43)}&state=${'s'.repeat(32)}`
        : `error=access_denied&state=${'s'.repeat(32)}`
    return json({ redirectUrl: `http://127.0.0.1:53124/oauth/hub/callback?${query}` })
  }

  // ── 用户自己的设备 ──
  if (pathname === '/api/me/desktop-devices' && method === 'GET') {
    const items = mySeeds(scenario).map(toDevice)
    const active = items.filter((item) => item.revokedAt === null).length
    return json({
      items,
      limit: { max: ADMIN_SETTINGS.desktop.maxDevicesPerUser, used: active },
    })
  }

  const mineMatch = /^\/api\/me\/desktop-devices\/([^/]+)$/.exec(pathname)
  if (mineMatch && method === 'DELETE') {
    const seeds = mySeeds(scenario)
    const target = seeds.find((seed) => deviceId(seed.id) === mineMatch[1])
    if (!target) return jsonError('NOT_FOUND', 404, '设备不存在')
    revokedOverride.set(target.id, 'user')
    return new Response(null, { status: 204 })
  }

  // 改名（WP25e / WP25f 交付物 3）：别人的设备与「已经退出的设备」都回 404（不给枚举留信号）
  if (mineMatch && method === 'PATCH') {
    const body = readJsonBody(init)
    const parsed = DeviceNameSchema.safeParse(body['name'])
    if (!parsed.success) {
      return jsonError('VALIDATION_FAILED', 400, parsed.error.issues[0]?.message ?? '设备名不合法')
    }
    const target = mySeeds(scenario).find((seed) => deviceId(seed.id) === mineMatch[1])
    if (!target || isRevoked(target)) return jsonError('NOT_FOUND', 404, '设备不存在')
    nameOverride.set(target.id, parsed.data)
    return json({ device: toDevice(target) })
  }

  // ── 管理端台账 ──
  if (pathname === '/api/admin/desktop-devices' && method === 'GET') {
    if (!adminScenario) return jsonError('FORBIDDEN', 403, '需要管理员权限')
    const items = filterAdmin(scenario, url)
    return json(page(items, url))
  }

  const adminRevokeMatch = /^\/api\/admin\/desktop-devices\/([^/]+)\/revoke$/.exec(pathname)
  if (adminRevokeMatch && method === 'POST') {
    if (!adminScenario) return jsonError('FORBIDDEN', 403, '需要管理员权限')
    const target = allSeeds(scenario).find((seed) => deviceId(seed.id) === adminRevokeMatch[1])
    if (!target) return jsonError('NOT_FOUND', 404, '设备不存在')
    revokedOverride.set(target.id, 'admin')
    return json({ device: toDevice(target) })
  }

  // 批量吊销（WP25e / WP25f 交付物 2）：逐台独立处理，`revoked + skipped = items.length`
  if (pathname === '/api/admin/desktop-devices/revoke' && method === 'POST') {
    if (!adminScenario) return jsonError('FORBIDDEN', 403, '需要管理员权限')
    const body = readJsonBody(init)
    const ids = Array.isArray(body['deviceIds'])
      ? body['deviceIds'].filter((item): item is string => typeof item === 'string')
      : []
    if (ids.length === 0 || ids.length > DESKTOP_BATCH_REVOKE_MAX) {
      return jsonError('VALIDATION_FAILED', 400, `一次吊销 1–${String(DESKTOP_BATCH_REVOKE_MAX)} 台`)
    }
    const seeds = allSeeds(scenario)
    const items: DesktopBatchRevokeItem[] = ids.map((id, index) => {
      const seed = seeds.find((item) => deviceId(item.id) === id)
      // `admin-batch` 场景：固定摆出四种结果，用来走查「未生效」与重试（其余场景按真实语义算）
      const forced =
        scenario === 'admin-batch' && index > 0
          ? (['already_revoked', 'not_found', 'failed'] as const)[Math.min(index - 1, 2)]
          : null
      if (forced === 'not_found' || !seed) return { deviceId: id, outcome: 'not_found', device: null }
      if (forced === 'failed') {
        return { deviceId: id, outcome: 'failed', device: toDevice(seed) }
      }
      if (forced === 'already_revoked' || isRevoked(seed)) {
        revokedOverride.set(seed.id, 'admin')
        return { deviceId: id, outcome: 'already_revoked', device: toDevice(seed) }
      }
      revokedOverride.set(seed.id, 'admin')
      return { deviceId: id, outcome: 'revoked', device: toDevice(seed) }
    })
    const revoked = items.filter((item) => item.outcome === 'revoked').length
    return json({ items, revoked, skipped: items.length - revoked })
  }

  // 设备详情（WP25e / WP25f 交付物 1）：台账 + 插件清单 + 最近 20 条审计（无 IP / 无原始上报）
  const adminDetailMatch = /^\/api\/admin\/desktop-devices\/([^/]+)$/.exec(pathname)
  if (adminDetailMatch && method === 'GET') {
    if (!adminScenario) return jsonError('FORBIDDEN', 403, '需要管理员权限')
    const seed = allSeeds(scenario).find((item) => deviceId(item.id) === adminDetailMatch[1])
    if (!seed) return jsonError('NOT_FOUND', 404, '设备不存在')
    const plugins = pluginsOf(seed)
    return json({
      user: userRefOf(seed.userId),
      device: toDevice(seed),
      plugins,
      pluginCount: plugins.length,
      audit: auditOf(seed).slice(0, 20),
    })
  }

  return null
}

/** `PATCH` / `POST` 的 JSON 请求体（假接口只认对象） */
function readJsonBody(init?: RequestInit): Record<string, unknown> {
  const raw = init?.body
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
