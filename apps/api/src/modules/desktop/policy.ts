import { DESKTOP_TOKEN_PREFIX } from '@dsh-hub/shared'

/**
 * 设备令牌的**路由白名单**（WP25a 交付物 4）。
 *
 * 设备令牌（`dsh_dev_…`）只做控制面，所以能访问的面也是显式列出的一小块：
 * - `/api/desktop/*`：登录态、会话、设备上报、每设备密钥；
 * - 下面这份**只读** `/api/me/*` 白名单：桌面端的「账户与积分」页要显示钱包/模型/用量/密钥预览，
 *   它已经由 `GET /api/desktop/session` 给了核心三项，但页面上的「用量」「模型」仍走既有接口，
 *   免得桌面端与网页端各维护一套读接口。
 *
 * 其余一切（尤其是 `/api/admin/*`）→ 403 FORBIDDEN。写操作一律要求 cookie 会话：
 * 桌面端要吊销自己，走的是网页端的「我的实例」页面（或把用户送回网页）。
 */
export const DEVICE_TOKEN_ME_ALLOWLIST: readonly string[] = [
  '/api/me/relay',
  '/api/me/relay/usage',
  '/api/me/relay/logs',
  '/api/me/relay/ledger',
  '/api/me/relay/keys',
  '/api/me/desktop-devices',
]

/** 是否是桌面端点（裁决 #6 的 Origin 豁免范围） */
export function isDesktopApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  return path.startsWith('/api/desktop/')
}

/** 设备令牌能不能访问这个「方法 + URL」（只做路径判定，鉴权在会话钩子里） */
export function isDeviceRouteAllowed(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? ''
  if (isDesktopApiPath(url)) return true
  if (method !== 'GET') return false
  return DEVICE_TOKEN_ME_ALLOWLIST.includes(path)
}

/**
 * 从请求头里读设备令牌：只接受 `Authorization: Bearer dsh_dev_…`。
 * 不是这个前缀一律当没带（`/v1` 的 `sk-dsh-…` 与匿名请求都不受影响）。
 */
export function readDeviceBearer(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const matched = /^bearer\s+(\S+)$/iu.exec(value.trim())
  if (!matched) return null
  const token = matched[1]!
  return token.startsWith(DESKTOP_TOKEN_PREFIX) ? token : null
}
