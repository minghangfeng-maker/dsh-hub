/**
 * 「服务器地址」：用户手填的 Hub 入口。
 *
 * 什么时候需要它：这个 APK **没有内置任何 Hub 入口**（构建时没给 `VITE_HUB_ORIGINS`），
 * 于是登录页会让用户填自己 Hub 的地址。fork 者如果内置了地址，这个输入框平时是收起的
 * （只在登录页底部的「服务器地址」按钮里展开，用于改错/换服务器）。
 *
 * 为什么用 `localStorage` 而不是 Capacitor Preferences：
 *  1. 入口列表在**模块加载时**就要定下来（`lib/app-info.ts` 的 `HUB_ORIGINS` 是常量，
 *     网关 `lib/instance.ts` 直接拿它建客户端），而 Preferences 是异步 API，冷启动来不及；
 *  2. 这个值不是秘密（就是 Hub 的地址），令牌仍然只在 Keystore / SecureStorage 里；
 *  3. APK 的 WebView 固定是 `https://localhost` 这个 origin，localStorage 跨启动保留；
 *     手机网页版与 Hub 同源，同样可用（但网页版不需要手填，入口就是页面 origin）。
 *
 * 改地址之后必须**重新加载页面**：网关在模块加载时就用旧的入口列表建好了，
 * 换地址等于换客户端。登录页会先保存再 `location.reload()`。
 */

import { normalizeHubOrigin } from '@dsh-hub/mobile-core'

/** localStorage 键（带 `dsh-hub:` 前缀，避免和 App 的其它键混在一起）。 */
export const SERVER_ADDRESS_KEY = 'dsh-hub:server-address'

export type ServerAddressResult =
  | { ok: true; origin: string }
  | { ok: false; reason: 'empty' | 'scheme' | 'host' | 'path'; message: string }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 读出保存过的服务器地址（非法/读不到都算没存过）。 */
export function readServerAddress(): string | null {
  try {
    return normalizeHubOrigin(storage()?.getItem(SERVER_ADDRESS_KEY) ?? null)
  } catch {
    return null
  }
}

/** 保存服务器地址（传 null 表示清除）。返回是否真的写进去了。 */
export function saveServerAddress(origin: string | null): boolean {
  const store = storage()
  if (!store) return false
  try {
    if (origin === null) {
      store.removeItem(SERVER_ADDRESS_KEY)
      return true
    }
    const normalized = normalizeHubOrigin(origin)
    if (normalized === null) return false
    store.setItem(SERVER_ADDRESS_KEY, normalized)
    return true
  } catch {
    return false
  }
}

/**
 * 校验并归一用户输入：`hub.example.com` → `https://hub.example.com`。
 *
 * 允许的写法（都归一成 `协议//主机[:端口]`）：
 *  - `https://hub.example.com`、`http://192.168.1.10:7700`（局域网/开发用明文）
 *  - `hub.example.com`、`hub.example.com:8443`（省略协议按 https 补）
 *
 * 拒绝：空、非 http(s) 协议、带路径/查询串、带用户名口令（地址里塞凭据迟早泄露到日志里）。
 */
export function normalizeServerAddressInput(raw: string | null | undefined): ServerAddressResult {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty', message: '请填写 Hub 地址' }
  // 省略协议：补 https://；`host:port` 这种写法也别被当成协议名
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'host', message: '地址格式不对，例如 https://hub.example.com' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'scheme', message: '只支持 http:// 或 https:// 开头的地址' }
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return { ok: false, reason: 'path', message: '只填到主机（可带端口），不要带路径' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'host', message: '请不要把账号口令写进地址里' }
  }
  const origin = normalizeHubOrigin(url.toString())
  if (origin === null) {
    return { ok: false, reason: 'host', message: '地址格式不对，例如 https://hub.example.com' }
  }
  return { ok: true, origin }
}
