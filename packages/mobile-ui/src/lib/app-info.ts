/**
 * 构建信息与 Hub 入口。
 *
 * 版本号与 Android 的 versionName 保持一致：0.4.12 / versionCode 52
 * （正式包由 `scripts/release/build-release.sh` 注入 0.4.12/52；debug/联调包共用这套常量，
 * 只用于上报给 Hub 的 Client-Version，不参与渠道判断）。
 *
 * **本仓库不写死任何 Hub 地址**，入口按下面的优先级解析（细节见 core 的 `config.ts`）：
 *  1. 构建参数 `VITE_HUB_ORIGIN`（开发 / e2e / 联调；`mock` 走进程内假 Hub）；
 *  2. 用户手填并持久化的地址（`lib/server-address.ts`，APK 没有内置入口时由登录页收集）；
 *  3. 构建参数 `VITE_HUB_ORIGINS`（逗号分隔的有序入口列表，fork 者在这里填自己的 Hub）。
 *
 * 三个都为空是**合法状态**：`HUB_ORIGINS` 为空数组、`NEEDS_SERVER_ADDRESS = true`，
 * 登录页要求用户填服务器地址。界面上平时不显示地址。
 *
 *  - `HUB_ORIGINS` 是有序候选（第一个是首选）；
 *  - `HUB_ORIGIN` 是首选（账号隔离键/网页入口这类**必须稳定**的地方用它，别用「当前入口」，
 *    否则切一次入口就会换一份缓存并触发重新登录）；
 *  - 「当前在用哪个」由 core 的 `OriginManager`（HubClient 内部）管，UI 通过
 *    `stores/hub-origin.ts` 读。
 *
 * 另一种产物：**手机网页版**（`VITE_TARGET=web`，`IS_WEB_BUILD`）。它由 Hub 同源托管在
 * `/m/`，入口是页面自己的 origin（单个候选，不做多入口切换），见 `resolveWebHubOrigins`。
 */

import {
  parseHubOrigins,
  resolveHubOrigins,
  resolveWebHubOrigins,
  webPageOf,
} from '@dsh-hub/mobile-core'
import { readServerAddress } from './server-address'

export const APP_VERSION = '0.4.12'
export const APP_VERSION_CODE = 52
export const APP_PACKAGE = 'tech.dshhub.app'

/**
 * 构建期常量（`vite.config.ts` 的 `define`，`VITE_TARGET=web` 时为 true）：手机网页版（WP54）。
 * 网页版由 Hub 同源托管在 `/m/`，平台报 `web`，没有 APK 更新与原生插件；APK 构建里是字面量 false，
 * 网页专属分支会被 tree-shake。判断「网页版」一律用它，不要用 `isNative()` 推断。
 */
declare const __DSH_WEB__: boolean
export const IS_WEB_BUILD: boolean = __DSH_WEB__

/**
 * 构建号与构建时间（`vite.config.ts` 的 `define`，两个构建都有：git 短 sha / ISO 时间）。
 *
 * 只有网页版会用到：`dist-web/version.json` 里写同一份值，App 回前台拉它判断「线上是不是
 * 已经换了新版本」（C7）。APK 没有这个概念，值是构建期的死数据，不参与任何逻辑。
 */
declare const __DSH_BUILD_SHA__: string
declare const __DSH_BUILD_TIME__: string

/** 本次产物的构建信息（网页版用它和 `./version.json` 对比；APK 只作诊断展示）。 */
export interface BuildInfo {
  version: string
  build: string
  builtAt: string
}

export const BUILD_INFO: BuildInfo = {
  version: APP_VERSION,
  build: __DSH_BUILD_SHA__,
  builtAt: __DSH_BUILD_TIME__,
}

/** 页面自己的 origin（网页版的默认入口）；非浏览器环境返回 null，由 core 退回生产列表。 */
function pageOrigin(): string | null {
  try {
    return typeof location === 'undefined' ? null : (location.origin ?? null)
  } catch {
    return null
  }
}

/** 构建期入口列表（`VITE_HUB_ORIGINS`，逗号分隔；未设置 = 空数组）。 */
export const BUILT_IN_HUB_ORIGINS: readonly string[] = parseHubOrigins(
  import.meta.env.VITE_HUB_ORIGINS ?? null,
)

/** 构建期决定的 Hub 入口（有序：首选在前）；空数组表示这个构建没有内置入口。 */
export const HUB_ORIGINS: readonly string[] = IS_WEB_BUILD
  ? // 网页版：单入口（VITE_HUB_ORIGIN，否则页面 origin；构建期列表只在拿不到页面 origin 时兜底）。
    // APK 构建里这个三元被折成 false 分支。
    resolveWebHubOrigins(
      import.meta.env.VITE_HUB_ORIGIN ?? null,
      pageOrigin(),
      BUILT_IN_HUB_ORIGINS,
    )
  : resolveHubOrigins({
      builtIn: BUILT_IN_HUB_ORIGINS,
      // 用户手填并持久化的地址（只有 localStorage 里有值时才非空）
      saved: savedServerAddresses(),
      override: import.meta.env.VITE_HUB_ORIGIN ?? null,
    })

/** 首选入口（稳定值：账号隔离键、网页入口、诊断页的「首个入口」都用它）；没有入口时是空串。 */
export const HUB_ORIGIN = HUB_ORIGINS[0] ?? ''
export const IS_MOCK = HUB_ORIGIN === 'mock'

/**
 * 这个构建没有任何可用入口（也没有手填过地址）：登录页要显示「服务器地址」输入框，
 * 在用户填好之前不发任何网络请求（网关的 origin 是空串，直接请求会失败）。
 */
export const NEEDS_SERVER_ADDRESS = !IS_MOCK && HUB_ORIGINS.length === 0

/**
 * 登录页能不能改服务器地址：APK 可以（改完重载页面生效）；网页版的入口就是页面 origin，
 * 改不了也不需要改；mock 构建不联网。
 */
export const CAN_EDIT_SERVER_ADDRESS = !IS_MOCK && !IS_WEB_BUILD

/** 手填的服务器地址（读取不抛错：拿不到就当作没填过）。 */
function savedServerAddresses(): string[] {
  const saved = readServerAddress()
  return saved === null ? [] : [saved]
}

/**
 * 从 APK 下载地址里认出正式版本号（`…/dsh-hub-app-0.2.17-<hash>.apk` → `0.2.17`）。
 *
 * 只用于更新提示的展示文案：`bootstrap.app` 只下发 versionCode 与下载地址，没有版本名。
 * 认不出来就返回 null（提示里不写具体版本号），绝不猜。
 */
export function versionFromApkUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const matched = /\/dsh-hub-app-(\d+\.\d+\.\d+)-[0-9a-z]+\.apk(?:$|[?#])/i.exec(url)
  return matched?.[1] ?? null
}

/** 注册/忘记密码/改密码等网页入口（Hub 网页与 API 同源）。 */
export function webPage(path: string): string | null {
  return webPageOf(HUB_ORIGIN, path)
}
