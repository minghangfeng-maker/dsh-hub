import {
  AdminRuntimeRowSchema,
  AvailableRuntimesResponseSchema,
  CreateRuntimeResponseSchema,
  RuntimeListResponseSchema,
  type AdminRuntimeRow,
  type AvailableRuntimesResponse,
  type CreateRuntimeRequest,
  type CreateRuntimeResponse,
  type RuntimeListResponse,
  type UpdateRuntimeRequest,
} from '@dsh-hub/shared'

import { http } from './http'

/** `GET /api/admin/runtimes`：已构建的 DSH 版本。 */
export function listRuntimes(): Promise<RuntimeListResponse> {
  return http.get('/api/admin/runtimes', { schema: RuntimeListResponseSchema })
}

/** `GET /api/admin/runtimes/available`：npm 上可用的 `@deepseek-ai/dsh` 版本。 */
export function listAvailableRuntimes(): Promise<AvailableRuntimesResponse> {
  return http.get('/api/admin/runtimes/available', { schema: AvailableRuntimesResponseSchema })
}

/** `POST /api/admin/runtimes`：创建 `runtime.build` 任务（202）。 */
export function createRuntime(input: CreateRuntimeRequest): Promise<CreateRuntimeResponse> {
  return http.post('/api/admin/runtimes', { body: input, schema: CreateRuntimeResponseSchema })
}

/** `PATCH /api/admin/runtimes/:id`（设为默认 / 下线 / 改备注）。 */
export function updateRuntime(id: number, input: UpdateRuntimeRequest): Promise<AdminRuntimeRow> {
  return http.patch(`/api/admin/runtimes/${id}`, { body: input, schema: AdminRuntimeRowSchema })
}

/** `DELETE /api/admin/runtimes/:id`（无用户使用且非默认时才可删）。 */
export function deleteRuntime(id: number): Promise<void> {
  return http.delete<void>(`/api/admin/runtimes/${id}`)
}
