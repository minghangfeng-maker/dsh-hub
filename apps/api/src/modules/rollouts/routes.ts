import type { FastifyInstance } from 'fastify'
import {
  RolloutCreatedResponseSchema,
  RolloutPreviewRequestSchema,
  RolloutPreviewResponseSchema,
  RolloutRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireReauth } from '../../app.js'
import type { BaseDeps } from '../../context.js'
import type { RolloutService } from './types.js'

/** rollouts 模块路由（04 §4.8）。前缀 `/api/admin/rollouts`。 */
export function registerRolloutRoutes(app: FastifyInstance, deps: BaseDeps, service: RolloutService): void {
  app.post('/preview', { preHandler: requireAdmin }, async (req) => {
    const input = RolloutPreviewRequestSchema.parse(req.body)
    return RolloutPreviewResponseSchema.parse(await service.preview(input, req.user?.id ?? null))
  })

  // 下发会改用户环境（装包、重建容器），按 04 §4.8 需要二次验证
  app.post('/', { preHandler: [requireAdmin, requireReauth()] }, async (req, reply) => {
    const input = RolloutRequestSchema.parse(req.body)
    const result = await service.create(input, req.user!.id, requestMeta(req))
    return reply.code(202).send(RolloutCreatedResponseSchema.parse(result))
  })

  void deps
}
