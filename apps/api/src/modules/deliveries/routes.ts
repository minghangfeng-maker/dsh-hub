import type { FastifyPluginAsync } from 'fastify'
import {
  DeliveryCreatedResponseSchema,
  DeliveryPreviewResponseSchema,
  DeliveryRequestSchema,
  PluginInstallStatsResponseSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireReauth } from '../../app.js'
import { HubError } from '../../lib/errors.js'
import type { DeliveryDeps } from './types.js'

/**
 * 统一下发的路由（WP28a / docs/21）。前缀 `/api/admin/deliveries`：
 * `POST /preview`（只读）与 `POST /`（二次密码 + 审计 `delivery.create`）。
 * 安装统计挂在 `/api/admin/plugins/install-stats`（见 `installStatsPlugin`）。
 */
export function deliveriesPlugin(deps: DeliveryDeps): FastifyPluginAsync {
  return async (app) => {
    const service = deps.services.deliveries
    if (!service) throw new HubError('INTERNAL', 'deliveries service 未装配')

    app.post('/preview', { preHandler: requireAdmin }, async (req) => {
      const input = DeliveryRequestSchema.parse(req.body)
      return DeliveryPreviewResponseSchema.parse(await service.preview(input, req.user?.id ?? null))
    })

    // 下发会改用户的 DSH（装包、重建/重启容器）与桌面端的期望状态，按 04 §4.8 需要二次验证
    app.post('/', { preHandler: [requireAdmin, requireReauth()] }, async (req, reply) => {
      const input = DeliveryRequestSchema.parse(req.body)
      const result = await service.create(input, req.user!.id, requestMeta(req))
      return reply.code(202).send(DeliveryCreatedResponseSchema.parse(result))
    })
  }
}

/**
 * 安装统计（交付物 4）：`GET /api/admin/plugins/install-stats`。
 * 挂在 `/api/admin` 前缀下（与插件库其它管理端接口同一层），只读。
 */
export function installStatsPlugin(deps: DeliveryDeps): FastifyPluginAsync {
  return async (app) => {
    const service = deps.services.deliveries
    if (!service) throw new HubError('INTERNAL', 'deliveries service 未装配')
    app.get('/plugins/install-stats', { preHandler: requireAdmin }, async () =>
      PluginInstallStatsResponseSchema.parse(await service.installStats()),
    )
  }
}
