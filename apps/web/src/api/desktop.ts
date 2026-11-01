import {
  DesktopAuthorizeDecisionResponseSchema,
  DesktopAuthorizeViewSchema,
  DesktopBatchRevokeResponseSchema,
  DesktopDeviceDetailResponseSchema,
  DesktopDeviceListResponseSchema,
  DesktopDeviceRevokeResponseSchema,
  DesktopMyDevicesResponseSchema,
  DesktopRenameDeviceResponseSchema,
  type DesktopAuthorizeDecisionResponse,
  type DesktopAuthorizeView,
  type DesktopBatchRevokeResponse,
  type DesktopDeviceDetailResponse,
  type DesktopDeviceListQuery,
  type DesktopDeviceListResponse,
  type DesktopDeviceRevokeResponse,
  type DesktopMyDevicesResponse,
  type DesktopRenameDeviceResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 桌面端接口（契约 `packages/shared/src/api/desktop.ts`）：授权页、用户的设备、管理端台账与批量吊销。
 *
 * 响应一律过契约 schema：形状漂了在界面上立刻变成「接口返回的数据不符合契约」，而不是半屏空白。
 */

/** `GET /api/desktop/auth/requests/:id`（网页会话）：授权页要显示的内容。 */
export function fetchDesktopAuthorizeRequest(requestId: string): Promise<DesktopAuthorizeView> {
  return http.get(`/api/desktop/auth/requests/${encodeURIComponent(requestId)}`, {
    schema: DesktopAuthorizeViewSchema,
  })
}

/**
 * `POST /api/desktop/auth/requests/:id/approve|deny`：
 * 路径决定语义（`/approve` 只接受 `allow:true`），返回要整页跳转的地址。
 *
 * 返回的地址由**后端**拼（`redirect_uri?code=…&state=…`），前端只负责校验它是本机回环
 * （见 `utils/desktop-redirect.ts`）——防开放重定向。
 */
export function decideDesktopAuthorize(
  requestId: string,
  allow: boolean,
): Promise<DesktopAuthorizeDecisionResponse> {
  const verb = allow ? 'approve' : 'deny'
  return http.post(`/api/desktop/auth/requests/${encodeURIComponent(requestId)}/${verb}`, {
    body: { allow },
    schema: DesktopAuthorizeDecisionResponseSchema,
  })
}

/** `GET /api/me/desktop-devices`：自己的设备（含 30 天内已吊销的，界面只显示有效的）。 */
export function listMyDesktopDevices(): Promise<DesktopMyDevicesResponse> {
  return http.get('/api/me/desktop-devices', { schema: DesktopMyDevicesResponseSchema })
}

/** `DELETE /api/me/desktop-devices/:deviceId`（204）：吊销 = 令牌与设备密钥一起失效。 */
export function revokeMyDesktopDevice(deviceId: string): Promise<void> {
  return http.delete<void>(`/api/me/desktop-devices/${encodeURIComponent(deviceId)}`)
}

/**
 * `PATCH /api/me/desktop-devices/:deviceId`：改自己的设备名（WP25e）。
 *
 * 别人的设备返回 **404**（不是 403）：用 deviceId 枚举别人的设备这件事不该有反馈。
 * 同名不写库、不写审计。服务端用 `DeviceNameSchema`，前端提交前用同一份 schema 先校验一次。
 */
export function renameMyDesktopDevice(
  deviceId: string,
  name: string,
): Promise<DesktopRenameDeviceResponse> {
  return http.patch(`/api/me/desktop-devices/${encodeURIComponent(deviceId)}`, {
    body: { name },
    schema: DesktopRenameDeviceResponseSchema,
  })
}

/** 管理端列表的筛选（全部可选；`revoked` 缺省 `active`，与契约默认一致）。 */
export type AdminDesktopDeviceQuery = Partial<DesktopDeviceListQuery>

/** `GET /api/admin/desktop-devices?q=&presence=&revoked=&platform=&appVersion=&page=&pageSize=` */
export function listAdminDesktopDevices(
  query: AdminDesktopDeviceQuery = {},
): Promise<DesktopDeviceListResponse> {
  return http.get('/api/admin/desktop-devices', {
    query: {
      q: query.q || undefined,
      presence: query.presence,
      revoked: query.revoked ?? 'active',
      userId: query.userId,
      platform: query.platform,
      appVersion: query.appVersion,
      page: query.page,
      pageSize: query.pageSize,
    },
    schema: DesktopDeviceListResponseSchema,
  })
}

/** `POST /api/admin/desktop-devices/:deviceId/revoke`：吊销并返回设备视图。 */
export function revokeAdminDesktopDevice(deviceId: string): Promise<DesktopDeviceRevokeResponse> {
  return http.post(`/api/admin/desktop-devices/${encodeURIComponent(deviceId)}/revoke`, {
    schema: DesktopDeviceRevokeResponseSchema,
  })
}

/**
 * `GET /api/admin/desktop-devices/:deviceId`：台账 + 插件清单 + 最近 20 条审计（WP25e 交付物 1）。
 *
 * 响应里**没有**操作者 IP，也没有任何原始上报 JSON —— 隐私边界在后端就已收口，
 * 前端不请求 `GET /api/admin/audit` 来「补全」这台设备的历史（那会带回 IP）。
 */
export function getAdminDesktopDevice(deviceId: string): Promise<DesktopDeviceDetailResponse> {
  return http.get(`/api/admin/desktop-devices/${encodeURIComponent(deviceId)}`, {
    schema: DesktopDeviceDetailResponseSchema,
  })
}

/**
 * `POST /api/admin/desktop-devices/revoke`：批量吊销（1–50 台，需 reauth，WP25e 交付物 3）。
 *
 * 逐台独立处理：`items` 里每台一个 `outcome`，`revoked + skipped = items.length`。
 * `not_found` / `failed` 不阻断其余设备（前端把这两种一起按「未生效」展示并可重试）。
 */
export function revokeAdminDesktopDevices(deviceIds: string[]): Promise<DesktopBatchRevokeResponse> {
  return http.post('/api/admin/desktop-devices/revoke', {
    body: { deviceIds },
    schema: DesktopBatchRevokeResponseSchema,
  })
}
