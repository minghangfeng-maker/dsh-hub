import {
  AuditListResponseSchema,
  CSRF_HEADER,
  DESKTOP_INSTALLER_MAX_BYTES,
  DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES,
  DesktopDeliverResponseSchema,
  DesktopDeliveryStateSchema,
  DesktopModelPresetFragmentsResponseSchema,
  DesktopPluginArtifactListResponseSchema,
  DesktopPluginArtifactResponseSchema,
  DesktopReleaseListResponseSchema,
  DesktopReleaseRollbackResponseSchema,
  DesktopReleaseSchema,
  DesktopUpdateFloorResponseSchema,
  ErrorBodySchema,
  type AuditListResponse,
  type DesktopAppDeliverRequest,
  type DesktopConfigDeliverRequest,
  type DesktopDeliverResponse,
  type DesktopDeliveryState,
  type DesktopModelPresetFragmentsResponse,
  type DesktopPluginArtifactListResponse,
  type DesktopPluginArtifactResponse,
  type DesktopPluginDeliverRequest,
  type DesktopPluginWithdrawRequest,
  type DesktopRelease,
  type DesktopReleaseChannel,
  type DesktopReleaseListResponse,
  type DesktopReleaseRollbackRequest,
  type DesktopReleaseRollbackResponse,
  type DesktopReleaseTarget,
  type DesktopUninstallDeliverRequest,
  type DesktopUpdateFloorResponse,
  type UpdateDesktopFloorRequest,
} from '@dsh-hub/shared'
import type { ZodType } from 'zod'

import { defaultErrorMessage } from './errors'
import { HubApiError, NETWORK_ERROR, http } from './http'

/**
 * 桌面下发与升级的管理端接口（契约 `packages/shared/src/api/desktop-delivery.ts`，WP25b 后端）。
 *
 * 两个上传接口（插件整包、安装包）走 **XMLHttpRequest**：`fetch` 没有上传进度，
 * 而这两个包可能是几十上百 MB，管理端必须看得见「传了多少」。其余一律复用 `api/http.ts`。
 */

// ── 读 ──────────────────────────────────────────────────────────────────────

/** `GET /api/admin/desktop/delivery`：期望状态全貌（插件目标 / 配置片段 / 渠道策略 / 告警）。 */
export function getDesktopDelivery(): Promise<DesktopDeliveryState> {
  return http.get('/api/admin/desktop/delivery', { schema: DesktopDeliveryStateSchema })
}

/** `GET /api/admin/desktop/artifacts`：已上传的桌面整包（每插件只留最近 2 版）。 */
export function listDesktopArtifacts(): Promise<DesktopPluginArtifactListResponse> {
  return http.get('/api/admin/desktop/artifacts', { schema: DesktopPluginArtifactListResponseSchema })
}

/**
 * `GET /api/admin/desktop/config/model-preset?userId=`：把「下发到 DSH」的模型预设翻成两条片段。
 *
 * `userId` 可选（WP25e）：不带时用**系统预设**（默认预设 + 管理员可见性，响应 `userId: null`）。
 * 「全部设备 / 角色」目标没有具体用户，就用系统预设；只有「指定用户」目标才带 userId。
 */
export function getDesktopModelPreset(userId?: number): Promise<DesktopModelPresetFragmentsResponse> {
  return http.get('/api/admin/desktop/config/model-preset', {
    query: { userId },
    schema: DesktopModelPresetFragmentsResponseSchema,
  })
}

/** `GET /api/admin/desktop/releases`：所有安装包发布记录（含已撤回的）。 */
export function listDesktopReleases(): Promise<DesktopReleaseListResponse> {
  return http.get('/api/admin/desktop/releases', { schema: DesktopReleaseListResponseSchema })
}

/** `GET /api/admin/desktop/update-floor`：全局强更地板与弹窗文案。 */
export function getDesktopUpdateFloor(): Promise<DesktopUpdateFloorResponse> {
  return http.get('/api/admin/desktop/update-floor', { schema: DesktopUpdateFloorResponseSchema })
}

/** 发布日志覆盖的动作（服务端一次前缀查询后在本地按它筛，见 {@link listDesktopAuditLog}） */
export const DESKTOP_AUDIT_ACTIONS = [
  'desktop.deliver',
  'desktop.release.publish',
  'desktop.release.rollback',
  'desktop.update-floor.set',
  'desktop.plugin-package.upload',
] as const

/** 桌面端全部动作的公共前缀（审计接口的 `actionPrefix`，WP25e） */
export const DESKTOP_AUDIT_ACTION_PREFIX = 'desktop.'

/** 一次前缀查询取回的上限（契约 `PageQuerySchema.pageSize` 上限就是 100） */
const DESKTOP_AUDIT_FETCH_SIZE = 100

const RELEASE_ACTIONS: ReadonlySet<string> = new Set(DESKTOP_AUDIT_ACTIONS)

/**
 * 发布日志（谁、什么时候、改了什么）：`GET /api/admin/audit?actionPrefix=desktop.` **一次**查询。
 *
 * WP25d 的做法是按 5 个动作并发查 5 次再合并（审计接口当时只支持精确匹配一个动作）。
 * WP25e 加了 `actionPrefix`，这里改成一次取回最近的桌面动作、本地筛出「发布类」动作，
 * 再按时间倒序截断到 `pageSize` —— 结果与原来一致，请求数从 5 变 1。
 * 吊销 / 改名这类**设备台账**动作不在发布日志里（它们有各自的审计入口），所以仍要本地筛。
 */
export async function listDesktopAuditLog(pageSize = 20): Promise<AuditListResponse['items']> {
  const page = await http.get('/api/admin/audit', {
    query: { actionPrefix: DESKTOP_AUDIT_ACTION_PREFIX, pageSize: DESKTOP_AUDIT_FETCH_SIZE },
    schema: AuditListResponseSchema,
  })
  return page.items
    .filter((item) => RELEASE_ACTIONS.has(item.action))
    .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
    .slice(0, pageSize)
}

// ── 写 ──────────────────────────────────────────────────────────────────────

/** `PUT /api/admin/desktop/plugins`：把某插件版本下发给一个目标（新 revision）。 */
export function deliverDesktopPlugin(input: DesktopPluginDeliverRequest): Promise<DesktopDeliverResponse> {
  return http.put('/api/admin/desktop/plugins', {
    body: input,
    schema: DesktopDeliverResponseSchema,
  })
}

/** `DELETE /api/admin/desktop/plugins`：撤掉一个目标上的受管条目。 */
export function withdrawDesktopPlugin(
  input: DesktopPluginWithdrawRequest,
): Promise<DesktopDeliverResponse> {
  return http.delete('/api/admin/desktop/plugins', {
    body: input,
    schema: DesktopDeliverResponseSchema,
  })
}

/** `PUT /api/admin/desktop/config`：**整体替换**某目标的配置片段（白名单外 400）。 */
export function deliverDesktopConfig(input: DesktopConfigDeliverRequest): Promise<DesktopDeliverResponse> {
  return http.put('/api/admin/desktop/config', {
    body: input,
    schema: DesktopDeliverResponseSchema,
  })
}

/** `PUT /api/admin/desktop/app`：渠道级 / 角色 / 用户的版本策略。 */
export function deliverDesktopApp(input: DesktopAppDeliverRequest): Promise<DesktopDeliverResponse> {
  return http.put('/api/admin/desktop/app', { body: input, schema: DesktopDeliverResponseSchema })
}

/** `PUT /api/admin/desktop/uninstall`：增删「明确要求卸载」的包名。 */
export function deliverDesktopUninstall(
  input: DesktopUninstallDeliverRequest,
): Promise<DesktopDeliverResponse> {
  return http.put('/api/admin/desktop/uninstall', {
    body: input,
    schema: DesktopDeliverResponseSchema,
  })
}

/** `POST /api/admin/desktop/releases/rollback`：把比目标新的同 target+channel 标 yanked。 */
export function rollbackDesktopRelease(
  input: DesktopReleaseRollbackRequest,
): Promise<DesktopReleaseRollbackResponse> {
  return http.post('/api/admin/desktop/releases/rollback', {
    body: input,
    schema: DesktopReleaseRollbackResponseSchema,
  })
}

/** `PUT /api/admin/desktop/update-floor`：全局最低版本与 40005 弹窗文案。 */
export function updateDesktopFloor(input: UpdateDesktopFloorRequest): Promise<DesktopUpdateFloorResponse> {
  return http.put('/api/admin/desktop/update-floor', {
    body: input,
    schema: DesktopUpdateFloorResponseSchema,
  })
}

// ── 带进度的上传（XHR）────────────────────────────────────────────────────────

export interface UploadProgress {
  /** 已发送的字节数（浏览器在拿不到 Content-Length 时会给个估值） */
  loaded: number
  /** 总字节数（0 = 未知，界面显示不确定进度） */
  total: number
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}

/** 一次上传需要的全部输入（文件大小先查一遍，免得白传几百 MB 才被 413 打断） */
export interface MultipartUploadRequest {
  path: string
  form: FormData
  schema: ZodType<unknown>
  /** 本次上传的文件字节数（所有文件之和） */
  bytes: number
  maxBytes: number
  options?: UploadOptions
}

function toApiError(status: number, text: string): HubApiError {
  let payload: unknown = null
  try {
    payload = text.length > 0 ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  const parsed = ErrorBodySchema.safeParse(payload)
  if (parsed.success) {
    const { code, message, details } = parsed.data.error
    return new HubApiError(code, message || defaultErrorMessage(code), status, details ?? {})
  }
  const fallback = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL'
  return new HubApiError(fallback, defaultErrorMessage(fallback), status)
}

/**
 * multipart 上传，带进度回调。
 *
 * 错误解析与 `apiRequest` 一致（错误体 → {@link HubApiError}，文案优先用服务端的）：
 * 「Hub 不能托管 Claude Agent SDK 的二进制」「带 codex 二进制的整包必须同时包含 LICENSE 与 NOTICE」
 * 这两条 400 文案要**原样**给管理员看，所以这里不能吞掉 message。
 */
export function uploadWithProgress<T>(request: MultipartUploadRequest): Promise<T> {
  const { path, form, schema, bytes, maxBytes, options = {} } = request

  return new Promise<T>((resolve, reject) => {
    if (bytes > maxBytes) {
      reject(new HubApiError('PAYLOAD_TOO_LARGE', '文件太大了，换个小一点的吧', 413))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path, true)
    xhr.withCredentials = true
    xhr.setRequestHeader(CSRF_HEADER, '1')
    xhr.responseType = 'text'

    const onAbort = (): void => {
      xhr.abort()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    xhr.upload.addEventListener('progress', (event) => {
      options.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : 0,
      })
    })

    xhr.addEventListener('load', () => {
      options.signal?.removeEventListener('abort', onAbort)
      if (xhr.status >= 200 && xhr.status < 300) {
        const text = xhr.responseText
        let payload: unknown = null
        try {
          payload = text.length > 0 ? JSON.parse(text) : null
        } catch {
          reject(new HubApiError('INTERNAL', '接口返回的数据不符合契约', xhr.status))
          return
        }
        const parsed = schema.safeParse(payload)
        if (!parsed.success) {
          reject(
            new HubApiError('INTERNAL', '接口返回的数据不符合契约', xhr.status, {
              issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
            }),
          )
          return
        }
        resolve(parsed.data as T)
        return
      }
      reject(toApiError(xhr.status, xhr.responseText))
    })

    xhr.addEventListener('error', () => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new HubApiError(NETWORK_ERROR, '网络好像断开了，请稍后再试', 0, { network: true }))
    })

    xhr.addEventListener('abort', () => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('上传已取消', 'AbortError'))
    })

    xhr.send(form)
  })
}

/**
 * `POST /api/admin/desktop/plugins/:pluginId/versions/:versionId/package`（multipart，字段名 `file`）。
 *
 * 服务端只读 tar 头就拒绝 claude 二进制与缺 LICENSE/NOTICE 的 codex 整包（裁决 #16），
 * 所以上传一个几百 MB 的包也可能秒回 400 —— 界面要把这句服务端文案原样展示出来。
 */
export function uploadDesktopPluginPackage(
  pluginId: number,
  versionId: number,
  file: File,
  options?: UploadOptions,
): Promise<DesktopPluginArtifactResponse> {
  const form = new FormData()
  form.append('file', file, file.name)
  return uploadWithProgress<DesktopPluginArtifactResponse>({
    path: `/api/admin/desktop/plugins/${String(pluginId)}/versions/${String(versionId)}/package`,
    form,
    schema: DesktopPluginArtifactResponseSchema,
    bytes: file.size,
    maxBytes: DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES,
    options,
  })
}

export interface ReleaseUploadInput {
  target: DesktopReleaseTarget
  channel: DesktopReleaseChannel
  version: string
  installer: File
  blockmap: File | null
}

/**
 * `POST /api/admin/desktop/releases`（multipart：字段 target/channel/version + 文件 installer/blockmap）。
 *
 * 服务端流式算 sha512 并**立刻生成 feed YAML**（逐字照 D3 §7.2），成功即出现在发布列表里。
 */
export function publishDesktopRelease(
  input: ReleaseUploadInput,
  options?: UploadOptions,
): Promise<DesktopRelease> {
  const form = new FormData()
  form.append('target', input.target)
  form.append('channel', input.channel)
  form.append('version', input.version)
  form.append('installer', input.installer, input.installer.name)
  if (input.blockmap) form.append('blockmap', input.blockmap, input.blockmap.name)
  return uploadWithProgress<DesktopRelease>({
    path: '/api/admin/desktop/releases',
    form,
    schema: DesktopReleaseSchema,
    bytes: input.installer.size + (input.blockmap?.size ?? 0),
    maxBytes: DESKTOP_INSTALLER_MAX_BYTES,
    options,
  })
}
