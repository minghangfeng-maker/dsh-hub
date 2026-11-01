import {
  AdminInstanceListResponseSchema,
  AdminInstanceStatsResponseSchema,
  InstanceActionResponseSchema,
  InstanceLogsResponseSchema,
  type AdminInstanceListResponse,
  type AdminInstanceStatsResponse,
  type InstanceAction,
  type InstanceActionResponse,
  type InstanceLogsResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * `GET /api/admin/instances`：WP33 起 stats 只读后台采样器的缓存（可能为 null + `statsAt`），
 * 列表本身不再等 docker stats。
 */
export function listInstances(): Promise<AdminInstanceListResponse> {
  return http.get('/api/admin/instances', { schema: AdminInstanceListResponseSchema })
}

/** `GET /api/admin/instances/stats`（WP33：只读缓存快照，前端每 10 s 轮询填「资源」列）。 */
export function listInstanceStats(): Promise<AdminInstanceStatsResponse> {
  return http.get('/api/admin/instances/stats', { schema: AdminInstanceStatsResponseSchema })
}

/** `POST /api/admin/instances/:userId/{start|stop|restart|recreate}`（202）。 */
export function instanceAction(userId: number, action: InstanceAction): Promise<InstanceActionResponse> {
  return http.post(`/api/admin/instances/${userId}/${action}`, { schema: InstanceActionResponseSchema })
}

/** `GET /api/admin/instances/:userId/logs?tail=`（已脱敏）。 */
export function fetchInstanceLogs(userId: number, tail = 300): Promise<InstanceLogsResponse> {
  return http.get(`/api/admin/instances/${userId}/logs`, { query: { tail }, schema: InstanceLogsResponseSchema })
}

/** `GET /api/admin/instances/:userId/logs/stream`（SSE `event: line`）。 */
export function instanceLogsStreamUrl(userId: number): string {
  return `/api/admin/instances/${userId}/logs/stream`
}
