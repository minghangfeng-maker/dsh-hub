import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AdminRuntimeRowSchema,
  AvailableRuntimesResponseSchema,
  CreateRuntimeRequestSchema,
  CreateRuntimeResponseSchema,
  RuntimeListResponseSchema,
  UpdateRuntimeRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin } from '../../app.js'
import type { BaseDeps } from '../../context.js'
import type { RuntimeService } from './types.js'

const IdParamsSchema = z.object({ id: z.coerce.number().int().positive() })

/** runtimes 模块路由（04 §4.6）。前缀 `/api/admin/runtimes`。 */
export function registerRuntimeRoutes(app: FastifyInstance, deps: BaseDeps, service: RuntimeService): void {
  app.get('/', { preHandler: requireAdmin }, async () =>
    RuntimeListResponseSchema.parse(await service.list()),
  )

  app.get('/available', { preHandler: requireAdmin }, async () =>
    AvailableRuntimesResponseSchema.parse(await service.available()),
  )

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const input = CreateRuntimeRequestSchema.parse(req.body)
    const result = await service.create(input, req.user!.id, requestMeta(req))
    return reply.code(202).send(CreateRuntimeResponseSchema.parse(result))
  })

  app.patch('/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdateRuntimeRequestSchema.parse(req.body)
    const actorId = req.user!.id
    const meta = requestMeta(req)
    // PATCH 是部分更新：按字段依次应用，最后返回当前行
    let row = await service.get(id)
    if (input.status === 'retired') row = await service.retire(id, actorId, meta)
    if (input.isDefault === true) row = await service.setDefault(id, actorId, meta)
    if (input.notes !== undefined) row = await service.updateNotes(id, input.notes, actorId, meta)
    return AdminRuntimeRowSchema.parse(row)
  })

  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    await service.remove(id, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  void deps
}
