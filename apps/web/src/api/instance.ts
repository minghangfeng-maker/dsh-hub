import {
  InstanceActionResponseSchema,
  MyInstanceResponseSchema,
  type InstanceActionResponse,
  type MyInstanceResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/** `GET /api/me/instance`：实例摘要 + 配额 + 资源 + 模型摘要（04 §3.1）。 */
export function fetchMyInstance(): Promise<MyInstanceResponse> {
  return http.get('/api/me/instance', { schema: MyInstanceResponseSchema })
}

/**
 * `POST /api/me/instance/start`（202，已在运行直接 200）。
 *
 * `planId` 是算力租赁的规格（13 §6）：给出则后端同时记住；不给出则用已选规格。
 * 唤醒页不带请求体，走的是「已选规格」那条路。
 */
export function startInstance(planId?: string | null): Promise<InstanceActionResponse> {
  return http.post('/api/me/instance/start', {
    ...(planId ? { body: { planId } } : {}),
    schema: InstanceActionResponseSchema,
  })
}

/** `POST /api/me/instance/stop`（202）。 */
export function stopInstance(): Promise<InstanceActionResponse> {
  return http.post('/api/me/instance/stop', { schema: InstanceActionResponseSchema })
}

/** `POST /api/me/instance/restart`（202；`needsRecreate` 时是重建）。 */
export function restartInstance(): Promise<InstanceActionResponse> {
  return http.post('/api/me/instance/restart', { schema: InstanceActionResponseSchema })
}

/** `GET /api/me/instance/events` 的 SSE 地址（`event: status`，04 §3.1）。 */
export const MY_INSTANCE_EVENTS_URL = '/api/me/instance/events'
