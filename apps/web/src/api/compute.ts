import {
  ComputeLeaseListResponseSchema,
  ComputeSettingsResponseSchema,
  MyComputeResponseSchema,
  SelectComputePlanResponseSchema,
  type ComputeLeaseListResponse,
  type ComputeLeaseQuery,
  type ComputeSettingsResponse,
  type MyComputeResponse,
  type SelectComputePlanResponse,
  type UpdateComputeSettingsRequest,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 算力租赁接口（13 §6，契约 `packages/shared/src/api/compute.ts`）。
 *
 * 金额一律整数微积分；块价格由 shared 的 `computeBlockPriceMicro` 算，页面不自己写公式。
 * 计费关闭时 `GET /api/me/compute` 也返回 `billingEnabled:false`，页面据此完全保持原样。
 */

/** `GET /api/me/compute`：可选规格、已选规格、当前租约、余额与赠送（会触发每日赠送）。 */
export function fetchMyCompute(): Promise<MyComputeResponse> {
  return http.get('/api/me/compute', { schema: MyComputeResponseSchema })
}

/** `PUT /api/me/compute/plan`：停止中只记住；运行中换规格并重启（`restarted:true`）。 */
export function selectMyComputePlan(planId: string): Promise<SelectComputePlanResponse> {
  return http.put('/api/me/compute/plan', {
    body: { planId },
    schema: SelectComputePlanResponseSchema,
  })
}

/** `GET /api/me/compute/leases`：自己的租约历史（远程分页）。 */
export function listMyComputeLeases(
  query: Partial<ComputeLeaseQuery> = {},
): Promise<ComputeLeaseListResponse> {
  return http.get('/api/me/compute/leases', { query, schema: ComputeLeaseListResponseSchema })
}

/** `GET /api/admin/compute/settings`：设置 + 宿主内存（总内存 / 已占用）。 */
export function getAdminComputeSettings(): Promise<ComputeSettingsResponse> {
  return http.get('/api/admin/compute/settings', { schema: ComputeSettingsResponseSchema })
}

/** `PATCH /api/admin/compute/settings`：只改给出的字段；`plans` 给出时整体替换。 */
export function updateAdminComputeSettings(
  input: UpdateComputeSettingsRequest,
): Promise<ComputeSettingsResponse> {
  return http.patch('/api/admin/compute/settings', {
    body: input,
    schema: ComputeSettingsResponseSchema,
  })
}

/** `GET /api/admin/compute/leases`：全部租约（可按用户、只看进行中）。 */
export function listAdminComputeLeases(
  query: Partial<ComputeLeaseQuery> = {},
): Promise<ComputeLeaseListResponse> {
  return http.get('/api/admin/compute/leases', { query, schema: ComputeLeaseListResponseSchema })
}
