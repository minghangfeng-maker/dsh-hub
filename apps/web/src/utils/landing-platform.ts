/**
 * 公开主页的模式偏好（WP42）。
 *
 * 三种模式：`cloud` 云上模式（主推、默认）、`desktop` 桌面端、`android` 安卓端。
 * 默认永远落云上模式——下载只是第二选择；`?platform=cloud|desktop|android` 可强制指定，
 * 分享链接和验收脚本都靠它，不依赖 UA。
 */
export type LandingPlatform = 'cloud' | 'desktop' | 'android'

const PLATFORMS: readonly LandingPlatform[] = ['cloud', 'desktop', 'android']

export function detectLandingPlatform(search: string = window.location.search): LandingPlatform {
  const forced = new URLSearchParams(search).get('platform')
  if (forced !== null && (PLATFORMS as readonly string[]).includes(forced)) {
    return forced as LandingPlatform
  }
  return 'cloud'
}
