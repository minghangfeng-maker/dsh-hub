import {
  PublicAndroidDownloadResponseSchema,
  PublicDesktopDownloadResponseSchema,
  type PublicAndroidDownloadResponse,
  type PublicDesktopDownloadResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 公开主页的安装包信息（WP36，`GET /api/public/desktop/download`，免登录）。
 *
 * 响应里只有「有没有 / 是哪一版 / 直链」；没有已发布安装包时 `windows` 为 null，
 * 页面据此把下载按钮变成「安装包准备中」。
 */
export function fetchPublicDesktopDownload(): Promise<PublicDesktopDownloadResponse> {
  return http.get('/api/public/desktop/download', {
    schema: PublicDesktopDownloadResponseSchema,
    authRedirect: false,
  })
}

/**
 * 公开主页右卡的安卓 APK（WP40r，`GET /api/public/android/download`，免登录）。
 *
 * 与 Windows 卡片分开一个接口：APK 来自「安卓发布记录」（`mobile_app_releases`），
 * 与桌面端的 electron-updater 发布记录是两套东西，混在一个响应里会让语义含糊。
 * 没有已发布 APK 时 `app` 为 null，页面显示「即将上线」。
 */
export function fetchPublicAndroidDownload(): Promise<PublicAndroidDownloadResponse> {
  return http.get('/api/public/android/download', {
    schema: PublicAndroidDownloadResponseSchema,
    authRedirect: false,
  })
}
