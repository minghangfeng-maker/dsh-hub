import type {
  DesktopApplyErrorCode,
  DesktopApplyState,
  DesktopAppChannel,
  DesktopArch,
  DesktopMobilePlatform,
  DesktopPermission,
  DesktopPlatform,
  DesktopPluginSource,
  DesktopPluginState,
  DesktopPresence,
  DesktopRevokeReason,
  DeviceKind,
} from '@dsh-hub/shared'
import { deviceKindOf } from '@dsh-hub/shared'

// 设备种类判定只在 shared 里有一份（老响应没有 `kind` 键时按桌面端读），这里只做转出
export { deviceKindOf }

import type { AdminTone } from '@/components/admin/tone'

/**
 * 桌面端枚举 → 界面文案（07 §2.7：文案靠控件与状态表达，不靠解释句）。
 *
 * 一份集中在这里，因为设备台账在**四个**地方出现（授权页、工作台「桌面设备」、管理端实例页、
 * 用户详情的设备卡片），同一个 `applyErrorCode` 不能两种说法。
 * 文案口径：`docs/20` §2 / D6 §4.7 的隐私声明用词；错误码按「用户能理解的后果」写，不照抄英文。
 */

/** 系统名（`process.platform` 的取值，客户端不做映射） */
export function platformText(platform: DesktopPlatform | null | undefined): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return '未知系统'
}

/** 「Windows 11」/「macOS 14」/「Linux 24.04」（只到主版本，契约就是这么收的） */
export function systemText(
  platform: DesktopPlatform | null | undefined,
  osMajor: string | null | undefined,
): string {
  const name = platformText(platform)
  return osMajor ? `${name} ${osMajor}` : name
}

/**
 * 手机平台（WP40a：手机与桌面端共用设备台账；WP54 加 `web` = 手机网页版）。
 *
 * `web` 是「同一套 App 界面由 Hub 同源托管」的那一端（`/m/`），和设备台账里的 android / ios 并列，
 * 不是「浏览器」这种泛称——所以要写成「手机网页版」而不是「网页」。
 */
export function mobilePlatformText(platform: DesktopMobilePlatform | null | undefined): string {
  if (platform === 'android') return 'Android'
  if (platform === 'ios') return 'iOS'
  if (platform === 'web') return '手机网页版'
  return '手机'
}

/** 平台图标（Phosphor）：安卓 / 苹果 / 浏览器（手机网页版）/ 兜底手机 */
export function mobilePlatformIcon(platform: DesktopMobilePlatform | null | undefined): string {
  if (platform === 'android') return 'i-ph-android-logo'
  if (platform === 'ios') return 'i-ph-apple-logo'
  if (platform === 'web') return 'i-ph-browser'
  return 'i-ph-device-mobile'
}

/** 设备种类文案（老响应没有 `kind` → 桌面端） */
export function deviceKindText(kind: DeviceKind | undefined): string {
  return kind === 'mobile' ? '手机' : '桌面端'
}

/**
 * 台账里「系统」那一列的文案：手机写「手机 · Android」，桌面端写「Windows 11」。
 * 手机没有 `platform`（那是 Node 的 process.platform），两套字段不互相借位。
 *
 * 手机网页版例外：它本身就是「手机浏览器里的 App」，前缀再加「手机 · 」会变成
 * 「手机 · 手机网页版」，所以整列直接写「手机网页版」。
 */
export function deviceSystemText(device: {
  kind?: DeviceKind
  platform: DesktopPlatform | null
  osMajor: string | null
  mobilePlatform?: DesktopMobilePlatform
}): string {
  if (deviceKindOf(device) === 'mobile') {
    if (device.mobilePlatform === 'web') return '手机网页版'
    return `手机 · ${mobilePlatformText(device.mobilePlatform)}`
  }
  return systemText(device.platform, device.osMajor)
}

/** 台账一行的「系统 · 架构」：手机只写「手机 · Android」，桌面端写「Windows 11 · x64」 */
export function deviceMetaText(device: {
  kind?: DeviceKind
  platform: DesktopPlatform | null
  osMajor: string | null
  mobilePlatform?: DesktopMobilePlatform
  arch: DesktopArch | null
}): string {
  if (deviceKindOf(device) === 'mobile') return deviceSystemText(device)
  return `${deviceSystemText(device)} · ${archText(device.arch)}`
}

/** 架构：`x64` / `arm64` / 其它 */
export function archText(arch: DesktopArch | null | undefined): string {
  if (arch === 'x64') return 'x64'
  if (arch === 'arm64') return 'arm64'
  return '未知架构'
}

/** 更新通道（契约是上游的 nightly/latest，界面写「测试 / 稳定」，裁决 #17） */
export function channelText(channel: DesktopAppChannel | null | undefined): string {
  if (channel === 'nightly') return '测试'
  if (channel === 'latest') return '稳定'
  return '—'
}

/** 在线状态（派生值，不落库） */
export function presenceText(presence: DesktopPresence): string {
  if (presence === 'online') return '在线'
  if (presence === 'offline') return '离线'
  return '已吊销'
}

export function presenceTone(presence: DesktopPresence): AdminTone {
  if (presence === 'online') return 'success'
  if (presence === 'offline') return 'neutral'
  return 'danger'
}

/** 清单应用状态（D3 的 ok/partial/failed → 这里五值） */
export function applyStateText(state: DesktopApplyState): string {
  if (state === 'applied') return '已应用'
  if (state === 'partial') return '部分应用'
  if (state === 'pending') return '等待应用'
  if (state === 'failed') return '应用失败'
  return '未知'
}

export function applyStateTone(state: DesktopApplyState): AdminTone {
  if (state === 'applied') return 'success'
  if (state === 'partial') return 'butter'
  if (state === 'failed') return 'danger'
  return 'neutral'
}

/** 应用失败原因（固定枚举 → 一句话后果；不含任何客户端自由文本） */
const APPLY_ERROR_TEXT: Record<DesktopApplyErrorCode, string> = {
  manifest_fetch_failed: '拉取下发清单失败',
  manifest_invalid: '下发清单格式不对',
  plugin_download_failed: '插件下载失败',
  plugin_hash_mismatch: '插件校验不通过',
  plugin_install_failed: '插件安装失败',
  plugin_conflict: '插件之间冲突',
  plugin_missing_runtime: '缺少运行环境',
  config_write_failed: '配置写入失败',
  update_download_failed: '升级包下载失败',
  update_install_failed: '升级安装失败',
  runtime_busy: '运行时正忙',
  disk_full: '磁盘空间不足',
  permission_denied: '没有权限',
  unknown: '未知原因',
}

export function applyErrorText(code: DesktopApplyErrorCode | null | undefined): string {
  return code ? APPLY_ERROR_TEXT[code] : '—'
}

/** 吊销原因（台账里看得见「为什么这台设备被踢了」） */
const REVOKE_REASON_TEXT: Record<DesktopRevokeReason, string> = {
  user: '用户自己退出',
  admin: '管理员吊销',
  'user-deleted': '账号被删除',
  'user-disabled': '账号被停用',
  'password-change': '修改密码',
  expired: '登录过期',
}

export function revokeReasonText(reason: DesktopRevokeReason | null | undefined): string {
  return reason ? REVOKE_REASON_TEXT[reason] : '—'
}

/** 插件来源（= D3 的 level；`bundled` = 客户端自带，docs/22 §4.2） */
const PLUGIN_SOURCE_TEXT: Record<DesktopPluginSource, string> = {
  'hub-core': '必装',
  'hub-default': '默认',
  'hub-optional': '可选',
  user: '自己装的',
  bundled: '内置',
}

export function pluginSourceText(source: DesktopPluginSource): string {
  return PLUGIN_SOURCE_TEXT[source]
}

/** 插件在一台设备上的状态 */
const PLUGIN_STATE_TEXT: Record<DesktopPluginState, string> = {
  enabled: '已启用',
  disabled: '已关闭',
  failed: '失败',
  absent: '未安装',
}

export function pluginStateText(state: DesktopPluginState): string {
  return PLUGIN_STATE_TEXT[state]
}

/**
 * 授权页的权限清单（契约 `DESKTOP_PERMISSIONS`，文案由前端本地化）。
 * 一行一条，写「能做什么」，不写权限位。
 */
const PERMISSION_TEXT: Record<DesktopPermission, string> = {
  'account.read': '用户名、昵称与角色',
  'wallet.read': '积分余额',
  'relay.call': '走 Hub 中转站调用模型',
  'manifest.pull': '接收下发的插件与配置',
}

export function permissionText(permission: DesktopPermission): string {
  return PERMISSION_TEXT[permission]
}

/** `登录阶段细分原因`（`details.loginCode`）→ 中文（04 §0.2 之外的补充，D2 §3.4） */
const LOGIN_CODE_TEXT: Record<string, string> = {
  code_invalid: '授权码无效或已经用过了，请回到桌面端重新登录',
  pkce_mismatch: '这次登录的校验值对不上，请回到桌面端重新登录',
  access_denied: '已经拒绝了这次登录',
  expired: '这次登录请求已经过期，请回到桌面端重新发起',
  device_limit_reached: '已登录的设备数量已达上限，请先吊销一台',
  // account_blocked 只留给「停用 / 待审批」（必须改密有自己的码，见下一条）
  account_blocked: '账号已被停用或还在等待审批，请联系管理员',
  // WP25e 从 account_blocked 里分出「必须改密」：这条要给出**下一步动作**（网页端改密）
  password_change_required: '请先在网页端修改初始密码，再登录桌面端',
}

export function loginCodeText(code: unknown): string | null {
  return typeof code === 'string' ? (LOGIN_CODE_TEXT[code] ?? null) : null
}
