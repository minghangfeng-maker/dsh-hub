import {
  AddToolChannelKeysResponseSchema,
  MyToolsResponseSchema,
  TestToolChannelResponseSchema,
  ToolChannelListResponseSchema,
  ToolChannelResponseSchema,
  ToolOverviewResponseSchema,
  ToolSettingsResponseSchema,
  ToolUsageListResponseSchema,
  type AddToolChannelKeysRequest,
  type AddToolChannelKeysResponse,
  type CreateToolChannelRequest,
  type MyToolsResponse,
  type TestToolChannelResponse,
  type ToolChannel,
  type ToolChannelListResponse,
  type ToolOverviewResponse,
  type ToolSettingsResponse,
  type ToolUsageListResponse,
  type ToolUsageQuery,
  type UpdateToolChannelKeyRequest,
  type UpdateToolChannelRequest,
  type UpdateToolSettingsRequest,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 搜索 / 抓取池接口（14 §3，契约 `packages/shared/src/api/tools.ts`）。
 *
 * 金额一律整数微积分（`*Micro`），界面换算走 `utils/points.ts`；
 * 管理端在 `/api/admin/tools/*`，用户端在 `/api/me/tools*`。
 */

// ── 管理端 · 设置与概览 ──

/** `GET /api/admin/tools/settings`（`internalBaseUrl`/`publicBaseUrl` 只读）。 */
export function getToolSettings(): Promise<ToolSettingsResponse> {
  return http.get('/api/admin/tools/settings', { schema: ToolSettingsResponseSchema })
}

/** `PATCH /api/admin/tools/settings`：只提交改动过的字段。 */
export function updateToolSettings(input: UpdateToolSettingsRequest): Promise<ToolSettingsResponse> {
  return http.patch('/api/admin/tools/settings', { body: input, schema: ToolSettingsResponseSchema })
}

/** `GET /api/admin/tools/overview`：本月调用、免费调用、收入、上游成本与按渠道/工具两张小表。 */
export function getToolOverview(): Promise<ToolOverviewResponse> {
  return http.get('/api/admin/tools/overview', { schema: ToolOverviewResponseSchema })
}

// ── 管理端 · 渠道与密钥 ──

/** `GET /api/admin/tools/channels`。 */
export function listToolChannels(): Promise<ToolChannelListResponse> {
  return http.get('/api/admin/tools/channels', { schema: ToolChannelListResponseSchema })
}

/** `POST /api/admin/tools/channels`（可顺带批量加密钥）。 */
export function createToolChannel(input: CreateToolChannelRequest): Promise<ToolChannel> {
  return http
    .post<{ channel: ToolChannel }>('/api/admin/tools/channels', {
      body: input,
      schema: ToolChannelResponseSchema,
    })
    .then((response) => response.channel)
}

/** `PATCH /api/admin/tools/channels/:id`。 */
export function updateToolChannel(id: number, input: UpdateToolChannelRequest): Promise<ToolChannel> {
  return http
    .patch<{ channel: ToolChannel }>(`/api/admin/tools/channels/${id}`, {
      body: input,
      schema: ToolChannelResponseSchema,
    })
    .then((response) => response.channel)
}

/** `DELETE /api/admin/tools/channels/:id`（204）。 */
export function deleteToolChannel(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/tools/channels/${id}`)
}

/** `POST /api/admin/tools/channels/:id/test`：用第一把可用密钥真打一次搜索。 */
export function testToolChannel(id: number): Promise<TestToolChannelResponse> {
  return http.post(`/api/admin/tools/channels/${id}/test`, { schema: TestToolChannelResponseSchema })
}

/** `POST /api/admin/tools/channels/:id/keys`：批量添加（一行一把，服务端去重）。 */
export function addToolChannelKeys(
  id: number,
  input: AddToolChannelKeysRequest,
): Promise<AddToolChannelKeysResponse> {
  return http.post(`/api/admin/tools/channels/${id}/keys`, {
    body: input,
    schema: AddToolChannelKeysResponseSchema,
  })
}

/** `PATCH /api/admin/tools/channels/:id/keys/:keyId`：改标签 / 启停 / 清除冷却。 */
export function updateToolChannelKey(
  id: number,
  keyId: number,
  input: UpdateToolChannelKeyRequest,
): Promise<ToolChannel> {
  return http
    .patch<{ channel: ToolChannel }>(`/api/admin/tools/channels/${id}/keys/${keyId}`, {
      body: input,
      schema: ToolChannelResponseSchema,
    })
    .then((response) => response.channel)
}

/** `DELETE /api/admin/tools/channels/:id/keys/:keyId`。 */
export function deleteToolChannelKey(id: number, keyId: number): Promise<ToolChannel> {
  return http
    .delete<{ channel: ToolChannel }>(`/api/admin/tools/channels/${id}/keys/${keyId}`, {
      schema: ToolChannelResponseSchema,
    })
    .then((response) => response.channel)
}

// ── 管理端 · 用量 ──

/** `GET /api/admin/tools/usage`：分页（可按用户 / 工具 / 状态筛选）。 */
export function listToolUsage(query: Partial<ToolUsageQuery> = {}): Promise<ToolUsageListResponse> {
  return http.get('/api/admin/tools/usage', { query, schema: ToolUsageListResponseSchema })
}

// ── 用户端 ──

/** `GET /api/me/tools`：本月免费额度、单价、本月调用与花费、下发状态。 */
export function fetchMyTools(): Promise<MyToolsResponse> {
  return http.get('/api/me/tools', { schema: MyToolsResponseSchema })
}

/** `GET /api/me/tools/usage`：只看自己的逐条用量（渠道与上游成本为 null）。 */
export function listMyToolUsage(query: Partial<ToolUsageQuery> = {}): Promise<ToolUsageListResponse> {
  return http.get('/api/me/tools/usage', { query, schema: ToolUsageListResponseSchema })
}

// ── 页面表单的类型出口（页面不必再引 shared）──

export type { ToolChannel, ToolSettingsResponse, UpdateToolSettingsRequest }
