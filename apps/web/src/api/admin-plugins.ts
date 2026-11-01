import {
  AdminPluginListResponseSchema,
  AdminPluginRowSchema,
  AddPluginVersionResponseSchema,
  PluginLookupResponseSchema,
  PluginPlatformResponseSchema,
  PluginUsersResponseSchema,
  type AddPluginPlatformRequest,
  type AddPluginVersionRequest,
  type AddPluginVersionResponse,
  type AdminPluginListResponse,
  type AdminPluginRow,
  type CreatePluginRequest,
  type PluginLookupQuery,
  type PluginLookupResponse,
  type PluginPlatform,
  type PluginPlatformResponse,
  type PluginUsersResponse,
  type UpdatePluginPlatformRequest,
  type UpdatePluginRequest,
} from '@dsh-hub/shared'

import { PLUGIN_UPLOAD_MAX_BYTES } from '@dsh-hub/shared'

import { uploadWithProgress, type UploadOptions } from './admin-desktop'
import { http } from './http'

/**
 * `GET /api/admin/plugins?platform=cloud|desktop`（含 versions 与装机统计）。
 *
 * `platform` 省略 = 云上（docs/22 §2.2：旧调用行为不变）；桌面侧返回的是**桌面插件库** ——
 * 只有桌面版本的插件，policy / bundled 统计都按桌面口径。
 */
export function listPlugins(platform?: PluginPlatform): Promise<AdminPluginListResponse> {
  return http.get('/api/admin/plugins', {
    query: platform ? { platform } : undefined,
    schema: AdminPluginListResponseSchema,
  })
}

/** `GET /api/admin/plugins/lookup?source=npm&name=…`（添加插件抽屉第 ② 步）。 */
export function lookupPlugin(query: PluginLookupQuery): Promise<PluginLookupResponse> {
  return http.get('/api/admin/plugins/lookup', { query, schema: PluginLookupResponseSchema })
}

/** `POST /api/admin/plugins/lookup`（multipart 上传 `.tgz`，只读 package.json、不入库）。 */
export function lookupPluginUpload(file: Blob, filename: string): Promise<PluginLookupResponse> {
  const form = new FormData()
  form.append('file', file, filename)
  return http.post('/api/admin/plugins/lookup', { body: form, schema: PluginLookupResponseSchema })
}

/** `POST /api/admin/plugins`。 */
export function createPlugin(input: CreatePluginRequest): Promise<AdminPluginRow> {
  return http.post('/api/admin/plugins', { body: input, schema: AdminPluginRowSchema })
}

/** `PATCH /api/admin/plugins/:id`。 */
export function updatePlugin(id: number, input: UpdatePluginRequest): Promise<AdminPluginRow> {
  return http.patch(`/api/admin/plugins/${id}`, { body: input, schema: AdminPluginRowSchema })
}

/** `DELETE /api/admin/plugins/:id`（仍有用户安装时 CONFLICT）。 */
export function deletePlugin(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/plugins/${id}`)
}

/** `POST /api/admin/plugins/:id/versions`（JSON：npm / tarball / local）。 */
export function addPluginVersion(
  id: number,
  input: AddPluginVersionRequest,
): Promise<AddPluginVersionResponse> {
  return http.post(`/api/admin/plugins/${id}/versions`, {
    body: input,
    schema: AddPluginVersionResponseSchema,
  })
}

/** `POST /api/admin/plugins/:id/versions`（multipart 上传 `.tgz`，`sourceType=upload`）。 */
export function uploadPluginVersion(
  id: number,
  file: Blob,
  filename: string,
  platform?: PluginPlatform,
): Promise<AddPluginVersionResponse> {
  const form = new FormData()
  form.append('sourceType', 'upload')
  form.append('file', file, filename)
  return http.post(`/api/admin/plugins/${id}/versions`, {
    query: platform ? { platform } : undefined,
    body: form,
    schema: AddPluginVersionResponseSchema,
  })
}

/**
 * `POST /api/admin/plugins/:id/versions?platform=desktop`（multipart，带进度）。
 *
 * 桌面的「上传整包」= **创建桌面版本**（docs/22 §2.2）：服务端读包内 `package.json` 拿版本号、
 * 校验包名 / 密钥 / patch 文件，并把整包登记成这个桌面版本的 artifact。插件还不在桌面库时顺手加进去。
 */
export function uploadDesktopVersion(
  id: number,
  file: File,
  options?: UploadOptions,
): Promise<AddPluginVersionResponse> {
  const form = new FormData()
  form.append('file', file, file.name)
  return uploadWithProgress<AddPluginVersionResponse>({
    path: `/api/admin/plugins/${String(id)}/versions?platform=desktop`,
    form,
    schema: AddPluginVersionResponseSchema,
    bytes: file.size,
    maxBytes: PLUGIN_UPLOAD_MAX_BYTES,
    options,
  })
}

/** `DELETE /api/admin/plugins/:id/versions/:versionId`。 */
export function deletePluginVersion(id: number, versionId: number): Promise<void> {
  return http.delete<void>(`/api/admin/plugins/${id}/versions/${versionId}`)
}

/** `GET /api/admin/plugins/:id/users`：每个用户的安装状态。 */
export function listPluginUsers(id: number): Promise<PluginUsersResponse> {
  return http.get(`/api/admin/plugins/${id}/users`, { schema: PluginUsersResponseSchema })
}

// ── 平台库（docs/22 §2.2，WP32a 契约）────────────────────────────────────────

/** `POST /api/admin/plugins/:id/platforms`：把已有插件加入另一个平台的库。 */
export function addPluginPlatform(
  id: number,
  input: AddPluginPlatformRequest,
): Promise<PluginPlatformResponse> {
  return http.post(`/api/admin/plugins/${id}/platforms`, {
    body: input,
    schema: PluginPlatformResponseSchema,
  })
}

/** `PATCH /api/admin/plugins/:id/platforms/:platform`：只改这个平台的设置。 */
export function updatePluginPlatform(
  id: number,
  platform: PluginPlatform,
  input: UpdatePluginPlatformRequest,
): Promise<PluginPlatformResponse> {
  return http.patch(`/api/admin/plugins/${id}/platforms/${platform}`, {
    body: input,
    schema: PluginPlatformResponseSchema,
  })
}

/**
 * `DELETE /api/admin/plugins/:id/platforms/:platform`：把一个插件移出某平台的库。
 *
 * 这个平台还有下发目标或已装记录时服务端会拒绝；`force` 同时撤销目标（需要二次密码，
 * 由调用方包 `withReauth`）。
 */
export function removePluginPlatform(
  id: number,
  platform: PluginPlatform,
  force = false,
): Promise<void> {
  return http.delete<void>(`/api/admin/plugins/${id}/platforms/${platform}`, {
    query: force ? { force: 1 } : undefined,
  })
}
