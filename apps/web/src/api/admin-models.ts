import type { z } from 'zod'

import {
  CatalogResponseSchema,
  DiscoverModelsResponseSchema,
  MatchModelsResponseSchema,
  ModelPresetListResponseSchema,
  CreateProviderRequestSchema,
  UpdateProviderRequestSchema,
  ModelProviderListResponseSchema,
  PresetPreviewResponseSchema,
  PresetResponseSchema,
  ProviderResponseSchema,
  TestProviderResponseSchema,
  type CatalogEntryInput,
  type CatalogResponse,
  type CreatePresetRequest,
  type DiscoverModelsRequest,
  type DiscoverModelsResponse,
  type MatchModelsResponse,
  type ModelPreset,
  type ModelPresetListResponse,
  type ModelProvider,
  type ModelProviderListResponse,
  type PresetPreviewResponse,
  type PresetResponse,
  type ProviderResponse,
  type TestProviderResponse,
  type UpdatePresetRequest,
} from '@dsh-hub/shared'

import { http } from './http'

// ── 提供方（04 §4.7） ──

/** `GET /api/admin/models/providers`（`apiKey` 只有 `{set,last4}`）。 */
export function listProviders(): Promise<ModelProviderListResponse> {
  return http.get('/api/admin/models/providers', { schema: ModelProviderListResponseSchema })
}

/** `POST /api/admin/models/providers`（**改密钥需 reauth**）。`hub-relay` 只需路由名 / 显示名 / 协议。 */
export function createProvider(input: z.input<typeof CreateProviderRequestSchema>): Promise<ModelProvider> {
  return http
    .post<ProviderResponse>('/api/admin/models/providers', { body: input, schema: ProviderResponseSchema })
    .then((response) => response.provider)
}

/** `PATCH /api/admin/models/providers/:id`。 */
export function updateProvider(
  id: number,
  input: z.input<typeof UpdateProviderRequestSchema>,
): Promise<ModelProvider> {
  return http
    .patch<ProviderResponse>(`/api/admin/models/providers/${id}`, { body: input, schema: ProviderResponseSchema })
    .then((response) => response.provider)
}

/** `DELETE /api/admin/models/providers/:id`（被预设引用时拒绝）。 */
export function deleteProvider(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/models/providers/${id}`)
}

/** `POST /api/admin/models/providers/:id/test`：用存储的密钥请求端点，返回延迟与模型数。 */
export function testProvider(id: number): Promise<TestProviderResponse> {
  return http.post(`/api/admin/models/providers/${id}/test`, { schema: TestProviderResponseSchema })
}

/** `POST /api/admin/models/discover`：从端点发现模型（不落库）。 */
export function discoverModels(input: DiscoverModelsRequest): Promise<DiscoverModelsResponse> {
  return http.post('/api/admin/models/discover', { body: input, schema: DiscoverModelsResponseSchema })
}

// ── 模型信息库（按模型名补全上下文 / 输出上限 / 输入类型 / 思考档位） ──

/** `GET /api/admin/models/catalog`：自定义条目 + 内置库概况。 */
export function getCatalog(): Promise<CatalogResponse> {
  return http.get('/api/admin/models/catalog', { schema: CatalogResponseSchema })
}

/** `PUT /api/admin/models/catalog`：批量新增 / 覆盖自定义条目（按规范化后的模型名为键）。 */
export function saveCatalog(entries: CatalogEntryInput[]): Promise<CatalogResponse> {
  return http.put('/api/admin/models/catalog', { body: { entries }, schema: CatalogResponseSchema })
}

/** `DELETE /api/admin/models/catalog/:key`（204；key 是规范化后的匹配键）。 */
export function deleteCatalogEntry(key: string): Promise<void> {
  return http.delete<void>(`/api/admin/models/catalog/${encodeURIComponent(key)}`)
}

/** `POST /api/admin/models/catalog/match`：按模型名查库（自定义优先于内置），只返回命中的。 */
export function matchModels(ids: string[]): Promise<MatchModelsResponse> {
  return http.post('/api/admin/models/catalog/match', { body: { ids }, schema: MatchModelsResponseSchema })
}

/** `PUT /api/admin/models/providers/:id/user-keys/:userId`（per-user 模式，204）。 */
export function setUserProviderKey(id: number, userId: number, apiKey: string): Promise<void> {
  return http.put<void>(`/api/admin/models/providers/${id}/user-keys/${userId}`, { body: { apiKey } })
}

/** `DELETE /api/admin/models/providers/:id/user-keys/:userId`（204）。 */
export function deleteUserProviderKey(id: number, userId: number): Promise<void> {
  return http.delete<void>(`/api/admin/models/providers/${id}/user-keys/${userId}`)
}

// ── 预设（04 §4.7） ──

/** `GET /api/admin/models/presets`（含 usersOnIt）。 */
/** `GET /api/admin/models/presets?platform=`（docs/22 §3：每个平台一个默认预设，缺省云上）。 */
export function listPresets(platform?: 'cloud' | 'desktop'): Promise<ModelPresetListResponse> {
  const query = platform === 'desktop' ? { platform } : {}
  return http.get('/api/admin/models/presets', { query, schema: ModelPresetListResponseSchema })
}

/** `POST /api/admin/models/presets`。 */
export function createPreset(input: CreatePresetRequest): Promise<ModelPreset> {
  return http
    .post<PresetResponse>('/api/admin/models/presets', { body: input, schema: PresetResponseSchema })
    .then((response) => response.preset)
}

/** `PATCH /api/admin/models/presets/:id`（revision+1）。 */
export function updatePreset(id: number, input: UpdatePresetRequest): Promise<ModelPreset> {
  return http
    .patch<PresetResponse>(`/api/admin/models/presets/${id}`, { body: input, schema: PresetResponseSchema })
    .then((response) => response.preset)
}

/** `DELETE /api/admin/models/presets/:id`（被用户引用或为默认时拒绝）。 */
export function deletePreset(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/models/presets/${id}`)
}

/** `GET /api/admin/models/presets/:id/preview?userId=`：为该用户渲染的 managed.patch.yml。 */
export function previewPreset(id: number, userId: number): Promise<PresetPreviewResponse> {
  return http.get(`/api/admin/models/presets/${id}/preview`, {
    query: { userId },
    schema: PresetPreviewResponseSchema,
  })
}
