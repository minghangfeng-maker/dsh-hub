import { MOBILE_WEB_BASE_PATH } from '@dsh-hub/shared'

/**
 * 手机 UA 判定（WP54c）。
 *
 * 正则与 Hub 服务端「`GET /` 手机访问 302 到 `/m/`」**完全同一条**（WP54 契约 C8）：
 * 两处不一致就会出现「跳过去了但页面上没有返回入口」或者反过来。要改这条规则必须先改契约。
 * 「不含平板」：iPad 的传统 UA 也带 `Mobile/… Safari`，会命中 C8 正则，所以与服务端
 * （`apps/api/src/server/static.ts` 的 `TABLET_UA_RE`）一样再排掉 iPad/Tablet/Kindle 这类。
 */

/** C8 的 UA 正则（手机 = 命中） */
export const MOBILE_UA_PATTERN = /Android.+Mobile|iPhone|iPod|HarmonyOS.+Mobile|Mobile.+Safari/i
/** 平板排除（与服务端同一条） */
export const TABLET_UA_PATTERN = /iPad|Tablet|PlayBook|Silk|Kindle/i

/** 手机网页版（App 界面的网页构建，由 Hub 同源托管）：C2 的 `MOBILE_WEB_BASE_PATH` */
export const MOBILE_WEB_HREF = MOBILE_WEB_BASE_PATH

/**
 * 「切到手机版」：C8 的 `GET /?view=mobile` —— 清掉 `hub_view=desktop` 后 302 到 `/m/`。
 * 用整页跳转（普通 `<a>`）而不是 SPA 路由：这是服务端的跳转与 cookie 逻辑，路由器不该绕过去。
 */
export const MOBILE_VIEW_HREF = '/?view=mobile'

/** 判断一个 UA 是不是手机（未命中就是电脑/平板） */
export function isMobileUserAgent(ua: string | null | undefined): boolean {
  return typeof ua === 'string' && !TABLET_UA_PATTERN.test(ua) && MOBILE_UA_PATTERN.test(ua)
}

/**
 * 当前浏览器是不是手机。
 *
 * 不做响应式监听：UA 在页面生命周期里不会变，隐藏 `navigator` 缺失（构建/测试环境）也只是「不是手机」。
 */
export function currentIsMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false
  return isMobileUserAgent(navigator.userAgent)
}
