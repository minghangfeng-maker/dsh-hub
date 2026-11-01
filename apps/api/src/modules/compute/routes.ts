import type { FastifyInstance } from 'fastify'
import {
  ComputeLeaseListResponseSchema,
  ComputeLeaseQuerySchema,
  ComputeSettingsResponseSchema,
  MyComputeResponseSchema,
  SelectComputePlanRequestSchema,
  SelectComputePlanResponseSchema,
  UpdateComputeSettingsRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireUser } from '../../app.js'
import type { BaseDeps } from '../../context.js'
import type { ComputeService } from './types.js'

/**
 * 算力租赁接口（13 §6；合同见 `packages/shared/src/api/compute.ts`）。
 * 注册前缀是 `/api`（`MODULE_PREFIXES.compute`），所以下面路径不重复写 `/api`：
 *   `GET /api/me/compute`、`PUT /api/me/compute/plan`、`GET /api/me/compute/leases`、
 *   `GET|PATCH /api/admin/compute/settings`、`GET /api/admin/compute/leases`。
 */
export function registerComputeRoutes(app: FastifyInstance, deps: BaseDeps, service: ComputeService): void {
  const user = { preHandler: requireUser }
  const admin = { preHandler: requireAdmin }

  app.get('/me/compute', user, async (req) => {
    // 13 §2.3：打开 Hub 任何页面都会调 GET /api/auth/me；这里再兜一次（含直接进工作台）
    service.grantDailyBonus(req.user!.id)
    return MyComputeResponseSchema.parse(service.myCompute(req.user!.id))
  })

  app.put('/me/compute/plan', user, async (req) => {
    const input = SelectComputePlanRequestSchema.parse(req.body ?? {})
    return SelectComputePlanResponseSchema.parse(await service.selectPlan(req.user!.id, input.planId))
  })

  app.get('/me/compute/leases', user, async (req) => {
    const query = ComputeLeaseQuerySchema.parse(req.query ?? {})
    return ComputeLeaseListResponseSchema.parse(service.listMyLeases(req.user!.id, query))
  })

  app.get('/admin/compute/settings', admin, async () =>
    ComputeSettingsResponseSchema.parse(await service.settingsResponse()),
  )

  app.patch('/admin/compute/settings', admin, async (req) => {
    const input = UpdateComputeSettingsRequestSchema.parse(req.body ?? {})
    const result = await service.updateSettings(input, req.user!.id, requestMeta(req))
    return ComputeSettingsResponseSchema.parse(result)
  })

  app.get('/admin/compute/leases', admin, async (req) => {
    const query = ComputeLeaseQuerySchema.parse(req.query ?? {})
    return ComputeLeaseListResponseSchema.parse(service.listAdminLeases(query))
  })

  void deps
}
