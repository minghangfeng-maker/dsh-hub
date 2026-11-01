import {
  MOBILE_ANDROID_APK_MAX_BYTES,
  MobileAppReleaseListResponseSchema,
  MobileAppReleaseSchema,
  MobileAppRollbackResponseSchema,
  type MobileAppRelease,
  type MobileAppReleaseListResponse,
  type MobileAppRollbackResponse,
} from '@dsh-hub/shared'
import type { ZodType } from 'zod'

import { http } from './http'
import { uploadWithProgress, type UploadOptions } from './admin-desktop'

/**
 * 安卓 App 发布记录（WP40r，`/api/admin/mobile/app/*`）。
 *
 * 上传即发布：服务端落盘 + 算 sha256 + 把旧的那条 yank，返回 201 与这条记录；
 * 回滚只改状态（文件保留），所以不需要重新上传。
 */

/** `GET /api/admin/mobile/app/releases`：当前发布 + 全部记录 + `settings.mobile.app` */
export function fetchMobileAppReleases(): Promise<MobileAppReleaseListResponse> {
  return http.get('/api/admin/mobile/app/releases', { schema: MobileAppReleaseListResponseSchema })
}

export interface MobileAppUploadInput {
  version: string
  versionCode: number
  apk: File
}

/** `POST /api/admin/mobile/app/releases`（multipart：字段 version / versionCode + 文件 apk） */
export function publishMobileAppRelease(
  input: MobileAppUploadInput,
  options?: UploadOptions,
): Promise<MobileAppRelease> {
  const form = new FormData()
  form.append('version', input.version)
  form.append('versionCode', String(input.versionCode))
  form.append('apk', input.apk, input.apk.name)
  return uploadWithProgress<MobileAppRelease>({
    path: '/api/admin/mobile/app/releases',
    form,
    schema: MobileAppReleaseSchema as unknown as ZodType<unknown>,
    bytes: input.apk.size,
    maxBytes: MOBILE_ANDROID_APK_MAX_BYTES,
    options,
  })
}

/** `POST /api/admin/mobile/app/rollback`：不给 releaseId 时回到上一版（versionCode 更低的最高一条） */
export function rollbackMobileAppRelease(releaseId?: number): Promise<MobileAppRollbackResponse> {
  return http.post('/api/admin/mobile/app/rollback', {
    schema: MobileAppRollbackResponseSchema,
    body: releaseId === undefined ? {} : { releaseId },
  })
}
