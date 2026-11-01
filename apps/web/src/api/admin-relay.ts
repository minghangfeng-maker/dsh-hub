import type { z } from 'zod'

import {
  AddRelayChannelKeysResponseSchema,
  CreateRelayModelRequestSchema,
  UpdateRelayModelRequestSchema,
  CreateRelayChannelRequestSchema,
  DiscoverRelayChannelResponseSchema,
  ImportRelayModelsResponseSchema,
  RelayChannelListResponseSchema,
  RelayChannelResponseSchema,
  RelayDshResponseSchema,
  RelayLedgerListResponseSchema,
  RelayModelListResponseSchema,
  RelayModelResponseSchema,
  RelayOverviewResponseSchema,
  RelaySettingsResponseSchema,
  RelayUsageLogResponseSchema,
  RelayUsageStatsResponseSchema,
  RelayWalletListResponseSchema,
  RelayWalletResponseSchema,
  TestRelayChannelResponseSchema,
  type AddRelayChannelKeysRequest,
  type AddRelayChannelKeysResponse,
  type CreateRelayChannelRequest,
  type DiscoverRelayChannelResponse,
  type ImportRelayModelsRequest,
  type ImportRelayModelsResponse,
  type RelayChannel,
  type RelayChannelListResponse,
  type RelayDshResponse,
  type RelayLedgerListResponse,
  type RelayLedgerQuery,
  type RelayModel,
  type RelayModelListResponse,
  type RelayOverviewResponse,
  type RelayScope,
  type RelaySettingsResponse,
  type RelayUsageLogQuery,
  type RelayUsageLogResponse,
  type RelayUsageStatsQuery,
  type RelayUsageStatsResponse,
  type RelayWalletListQuery,
  type RelayWalletListResponse,
  type RelayWalletRow,
  type TestRelayChannelResponse,
  type UpdateRelayChannelKeyRequest,
  type UpdateRelayChannelRequest,
  type UpdateRelayDshRequest,
  type UpdateRelaySettingsRequest,
  type UpdateRelayWalletRequest,
  type AdjustRelayWalletRequest,
  type RelaySettings,
  type Platform,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 管理端中转站接口（12 §9 的 `/api/admin/relay/*`）。
 *
 * 金额一律是整数「微积分」（价格是微积分 / 百万 token），界面换算走 `utils/points.ts`；
 * 删除被路由引用的渠道会收到 `CONFLICT`（details 里带模型名），页面负责展示。
 */

// ── 概览与设置 ──

/** `GET /api/admin/relay/overview`：今日/本月统计、渠道健康、告警。 */
export function getRelayOverview(): Promise<RelayOverviewResponse> {
  return http.get('/api/admin/relay/overview', { schema: RelayOverviewResponseSchema })
}

/** `GET /api/admin/relay/settings`（`internalBaseUrl`/`publicBaseUrl` 只读）。 */
export function getRelaySettings(): Promise<RelaySettingsResponse> {
  return http.get('/api/admin/relay/settings', { schema: RelaySettingsResponseSchema })
}

/** `PATCH /api/admin/relay/settings`。 */
export function updateRelaySettings(input: UpdateRelaySettingsRequest): Promise<RelaySettingsResponse> {
  return http.patch('/api/admin/relay/settings', { body: input, schema: RelaySettingsResponseSchema })
}

// ── 渠道 ──

/**
 * `GET /api/admin/relay/channels`（18 §3.1：`scope` 缺省 = DSH，老页面行为不变）。
 * 非 dsh 的作用域才带 `?scope=`，地址栏干净、与后端「缺省 dsh」的约定一致。
 */
export function listRelayChannels(scope?: RelayScope): Promise<RelayChannelListResponse> {
  const query = scope && scope !== 'dsh' ? { scope } : {}
  return http.get('/api/admin/relay/channels', { query, schema: RelayChannelListResponseSchema })
}

/** `POST /api/admin/relay/channels`（可顺带加密钥池）。 */
export function createRelayChannel(input: CreateRelayChannelRequest): Promise<RelayChannel> {
  return http
    .post<{ channel: RelayChannel }>('/api/admin/relay/channels', {
      body: input,
      schema: RelayChannelResponseSchema,
    })
    .then((response) => response.channel)
}

/** `PATCH /api/admin/relay/channels/:id`。 */
export function updateRelayChannel(id: number, input: UpdateRelayChannelRequest): Promise<RelayChannel> {
  return http
    .patch<{ channel: RelayChannel }>(`/api/admin/relay/channels/${id}`, {
      body: input,
      schema: RelayChannelResponseSchema,
    })
    .then((response) => response.channel)
}

/** `DELETE /api/admin/relay/channels/:id`（被路由引用时 `CONFLICT`，details 带模型名）。 */
export function deleteRelayChannel(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/relay/channels/${id}`)
}

/** `POST /api/admin/relay/channels/:id/test`：每把密钥请求一次上游 `/models`。 */
export function testRelayChannel(id: number): Promise<TestRelayChannelResponse> {
  return http.post(`/api/admin/relay/channels/${id}/test`, { schema: TestRelayChannelResponseSchema })
}

/** `POST /api/admin/relay/channels/:id/discover`：拉上游模型列表（标出已存在的对外模型）。 */
export function discoverRelayChannel(id: number): Promise<DiscoverRelayChannelResponse> {
  return http.post(`/api/admin/relay/channels/${id}/discover`, {
    schema: DiscoverRelayChannelResponseSchema,
  })
}

/** `POST /api/admin/relay/channels/:id/keys`：批量添加（一行一把，服务端去重）。 */
export function addRelayChannelKeys(
  id: number,
  input: AddRelayChannelKeysRequest,
): Promise<AddRelayChannelKeysResponse> {
  return http.post(`/api/admin/relay/channels/${id}/keys`, {
    body: input,
    schema: AddRelayChannelKeysResponseSchema,
  })
}

/** `PATCH /api/admin/relay/channels/:id/keys/:keyId`：改名 / 启停（把 auto-disabled 改回 active = 恢复）。 */
export function updateRelayChannelKey(
  id: number,
  keyId: number,
  input: UpdateRelayChannelKeyRequest,
): Promise<RelayChannel> {
  return http
    .patch<{ channel: RelayChannel }>(`/api/admin/relay/channels/${id}/keys/${keyId}`, {
      body: input,
      schema: RelayChannelResponseSchema,
    })
    .then((response) => response.channel)
}

/** `DELETE /api/admin/relay/channels/:id/keys/:keyId`。 */
export function deleteRelayChannelKey(id: number, keyId: number): Promise<RelayChannel> {
  return http
    .delete<{ channel: RelayChannel }>(`/api/admin/relay/channels/${id}/keys/${keyId}`, {
      schema: RelayChannelResponseSchema,
    })
    .then((response) => response.channel)
}

// ── 对外模型与价格 ──

/** `GET /api/admin/relay/models`（`scope` 缺省 = DSH）。 */
export function listRelayModels(scope?: RelayScope): Promise<RelayModelListResponse> {
  const query = scope && scope !== 'dsh' ? { scope } : {}
  return http.get('/api/admin/relay/models', { query, schema: RelayModelListResponseSchema })
}

/** `POST /api/admin/relay/models`。 */
export function createRelayModel(input: z.input<typeof CreateRelayModelRequestSchema>): Promise<RelayModel> {
  return http
    .post<{ model: RelayModel }>('/api/admin/relay/models', {
      body: input,
      schema: RelayModelResponseSchema,
    })
    .then((response) => response.model)
}

/** `PATCH /api/admin/relay/models/:id`（`routes` 给了就整体替换）。 */
export function updateRelayModel(
  id: number,
  input: z.input<typeof UpdateRelayModelRequestSchema>,
): Promise<RelayModel> {
  return http
    .patch<{ model: RelayModel }>(`/api/admin/relay/models/${id}`, {
      body: input,
      schema: RelayModelResponseSchema,
    })
    .then((response) => response.model)
}

/** `DELETE /api/admin/relay/models/:id`（204）。 */
export function deleteRelayModel(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/relay/models/${id}`)
}

/** `POST /api/admin/relay/models/import`：批量建模型；同名已存在 → 只加一条路由。 */
export function importRelayModels(input: ImportRelayModelsRequest): Promise<ImportRelayModelsResponse> {
  return http.post('/api/admin/relay/models/import', {
    body: input,
    schema: ImportRelayModelsResponseSchema,
  })
}

// ── 模型配置（12 §7.0 / §10；docs/22 §3 起按平台） ──

/**
 * `GET /api/admin/relay/dsh`：模型配置（勾选集合、默认模型与状态）。
 *
 * `platform` 缺省 = 云上（实例）；`desktop` 读写桌面端的默认预设（docs/22 §3）。
 * 老后端不认识这个参数时会忽略它并返回云上的配置 —— 界面按「两套预设」设计，
 * 后端合入前用假数据（`?mock=`）验。
 */
export function getRelayDsh(platform?: Platform): Promise<RelayDshResponse> {
  const query = platform && platform !== 'cloud' ? { platform } : {}
  return http.get('/api/admin/relay/dsh', { query, schema: RelayDshResponseSchema })
}

/** `PUT /api/admin/relay/dsh?platform=`：整体替换该平台的选中集合与默认模型（**只保存，不下发**）。 */
export function updateRelayDsh(
  input: UpdateRelayDshRequest,
  platform?: Platform,
): Promise<RelayDshResponse> {
  const query = platform && platform !== 'cloud' ? { platform } : {}
  return http.put('/api/admin/relay/dsh', { body: input, query, schema: RelayDshResponseSchema })
}

// ── 钱包（积分）与流水 ──

/** `GET /api/admin/relay/wallets`（含没建钱包的用户）。 */
export function listRelayWallets(
  query: Partial<RelayWalletListQuery> = {},
): Promise<RelayWalletListResponse> {
  return http.get('/api/admin/relay/wallets', { query, schema: RelayWalletListResponseSchema })
}

/** `GET /api/admin/relay/wallets/:userId`。 */
export function getRelayWallet(userId: number): Promise<RelayWalletRow> {
  return http
    .get<{ wallet: RelayWalletRow }>(`/api/admin/relay/wallets/${userId}`, {
      schema: RelayWalletResponseSchema,
    })
    .then((response) => response.wallet)
}

/** `PATCH /api/admin/relay/wallets/:userId`：倍率 / 并发 / 日上限 / 启用。 */
export function updateRelayWallet(userId: number, input: UpdateRelayWalletRequest): Promise<RelayWalletRow> {
  return http
    .patch<{ wallet: RelayWalletRow }>(`/api/admin/relay/wallets/${userId}`, {
      body: input,
      schema: RelayWalletResponseSchema,
    })
    .then((response) => response.wallet)
}

/** `POST /api/admin/relay/wallets/:userId/adjust`：正数加、负数扣（写流水与审计）。 */
export function adjustRelayWallet(userId: number, input: AdjustRelayWalletRequest): Promise<RelayWalletRow> {
  return http
    .post<{ wallet: RelayWalletRow }>(`/api/admin/relay/wallets/${userId}/adjust`, {
      body: input,
      schema: RelayWalletResponseSchema,
    })
    .then((response) => response.wallet)
}

/** `GET /api/admin/relay/ledger`：积分流水（可按用户筛选）。 */
export function listRelayLedger(query: Partial<RelayLedgerQuery> = {}): Promise<RelayLedgerListResponse> {
  return http.get('/api/admin/relay/ledger', { query, schema: RelayLedgerListResponseSchema })
}

// ── 用量 ──

/**
 * `GET /api/admin/relay/usage`：区间汇总 + 按模型/用户/渠道。
 *
 * `clientKind`（契约 `RelayUsageStatsQuerySchema`）：docs/22 §1.3 —— 桌面视图只看桌面来源，
 * 后端从明细记录按 `relay_usage.client_kind` 过滤（日汇总表没有来源列）。
 */
export function getRelayUsage(query: RelayUsageStatsQuery = {}): Promise<RelayUsageStatsResponse> {
  return http.get('/api/admin/relay/usage', { query, schema: RelayUsageStatsResponseSchema })
}

/**
 * `GET /api/admin/relay/logs`：逐条用量（支持用户 / 模型 / 渠道 / 状态 / 日期筛选）。
 *
 * `clientKind`（契约 `RelayUsageLogQuerySchema`）：docs/22 §1.3「用量记录在桌面下默认筛
 * `client_kind=desktop`」，后端按凭据判定的来源真的过滤（docker / desktop / external / unknown）。
 */
export function listRelayLogs(query: Partial<RelayUsageLogQuery> = {}): Promise<RelayUsageLogResponse> {
  return http.get('/api/admin/relay/logs', { query, schema: RelayUsageLogResponseSchema })
}

// ── 设置表单的类型出口（页面不必再引 shared） ──

export type { RelaySettings, UpdateRelaySettingsRequest }
export { CreateRelayChannelRequestSchema }
