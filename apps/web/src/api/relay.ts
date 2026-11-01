import {
  MyRelayResponseSchema,
  RelayKeyListResponseSchema,
  RelayKeyResponseSchema,
  RelayKeySecretResponseSchema,
  RelayLedgerListResponseSchema,
  RelayUsageLogResponseSchema,
  RelayUsageStatsResponseSchema,
  type MyRelayResponse,
  type RelayKey,
  type RelayKeyListResponse,
  type RelayKeySecretResponse,
  type RelayLedgerListResponse,
  type RelayLedgerQuery,
  type RelayUsageLogQuery,
  type RelayUsageLogResponse,
  type RelayUsageStatsQuery,
  type RelayUsageStatsResponse,
  type CreateRelayKeyRequest,
  type UpdateRelayKeyRequest,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 用户端中转站接口（12 §9 的 `/api/me/relay*`，契约 `packages/shared/src/api/relay.ts`）。
 *
 * 金额一律是整数「微积分」，展示与录入走 `utils/points.ts`；页面不自己换算。
 */

/** `GET /api/me/relay`：钱包、今日/本月汇总、公网地址、可用模型。 */
export function fetchMyRelay(): Promise<MyRelayResponse> {
  return http.get('/api/me/relay', { schema: MyRelayResponseSchema })
}

/** `GET /api/me/relay/usage`：区间统计（默认近 30 天，跨度 ≤ 92 天）。 */
export function fetchMyRelayUsage(query: RelayUsageStatsQuery = {}): Promise<RelayUsageStatsResponse> {
  return http.get('/api/me/relay/usage', { query, schema: RelayUsageStatsResponseSchema })
}

/** `GET /api/me/relay/logs`：自己的逐条用量（`channelId`/`channelName` 恒为 null）。 */
export function listMyRelayLogs(query: Partial<RelayUsageLogQuery> = {}): Promise<RelayUsageLogResponse> {
  return http.get('/api/me/relay/logs', { query, schema: RelayUsageLogResponseSchema })
}

/** `GET /api/me/relay/ledger`：自己的积分流水。 */
export function listMyRelayLedger(query: Partial<RelayLedgerQuery> = {}): Promise<RelayLedgerListResponse> {
  return http.get('/api/me/relay/ledger', { query, schema: RelayLedgerListResponseSchema })
}

/** `GET /api/me/relay/keys`：含 DSH 内置的 system 密钥。 */
export function listMyRelayKeys(): Promise<RelayKeyListResponse> {
  return http.get('/api/me/relay/keys', { schema: RelayKeyListResponseSchema })
}

/** `POST /api/me/relay/keys`：新建自建密钥（**明文只回一次**）。 */
export function createMyRelayKey(input: CreateRelayKeyRequest): Promise<RelayKeySecretResponse> {
  return http.post('/api/me/relay/keys', { body: input, schema: RelayKeySecretResponseSchema })
}

/** `PATCH /api/me/relay/keys/:id`：改名 / 启停（system 密钥不能停用）。 */
export function updateMyRelayKey(id: number, input: UpdateRelayKeyRequest): Promise<RelayKey> {
  return http
    .patch<{ key: RelayKey }>(`/api/me/relay/keys/${id}`, { body: input, schema: RelayKeyResponseSchema })
    .then((response) => response.key)
}

/** `DELETE /api/me/relay/keys/:id`（204；软删；system 密钥不能删）。 */
export function deleteMyRelayKey(id: number): Promise<void> {
  return http.delete<void>(`/api/me/relay/keys/${id}`)
}

/** `POST /api/me/relay/keys/:id/rotate`：重签 system 密钥（明文只回一次，需重建容器才生效）。 */
export function rotateMyRelayKey(id: number): Promise<RelayKeySecretResponse> {
  return http.post(`/api/me/relay/keys/${id}/rotate`, { schema: RelayKeySecretResponseSchema })
}
