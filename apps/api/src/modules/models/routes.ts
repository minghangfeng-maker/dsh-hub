import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  CatalogResponseSchema,
  CreatePresetRequestSchema,
  CreateProviderRequestSchema,
  DiscoverModelsRequestSchema,
  DiscoverModelsResponseSchema,
  MatchModelsRequestSchema,
  MatchModelsResponseSchema,
  ModelPresetListQuerySchema,
  ModelPresetListResponseSchema,
  ModelProviderListResponseSchema,
  PresetPreviewQuerySchema,
  PresetPreviewResponseSchema,
  PresetResponseSchema,
  ProviderResponseSchema,
  SaveCatalogRequestSchema,
  SetUserProviderKeyRequestSchema,
  TestProviderResponseSchema,
  UpdatePresetRequestSchema,
  UpdateProviderRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireReauth } from '../../app.js'
import type { FastifyRequest } from 'fastify'
import type { BaseDeps } from '../../context.js'
import type { ModelService } from './types.js'

const IdParamsSchema = z.object({ id: z.coerce.number().int().positive() })
const CatalogKeyParamsSchema = z.object({ key: z.string().min(1).max(200) })
const UserKeyParamsSchema = IdParamsSchema.extend({ userId: z.coerce.number().int().positive() })

/**
 * models 模块路由（04 §4.7）。前缀 `/api/admin/models`。
 * 改密钥（POST/PATCH 带 apiKey、PUT/DELETE user-keys）要求二次验证（`requireReauth`）。
 */
export function registerModelRoutes(app: FastifyInstance, deps: BaseDeps, service: ModelService): void {
  /** 请求体里带 apiKey → 需要重新输入过密码（04 §4.7） */
  const reauthIfKey = async (req: FastifyRequest): Promise<void> => {
    if (!req.user) return
    const body = req.body
    const hasKey =
      typeof body === 'object' &&
      body !== null &&
      'apiKey' in body &&
      (body as { apiKey?: unknown }).apiKey !== undefined
    if (!hasKey) return
    await requireReauth()(req)
  }

  app.get('/providers', { preHandler: requireAdmin }, async () =>
    ModelProviderListResponseSchema.parse(await service.listProviders()),
  )

  app.post('/providers', { preHandler: [requireAdmin, reauthIfKey] }, async (req) => {
    const input = CreateProviderRequestSchema.parse(req.body)
    const provider = await service.createProvider(input, req.user!.id, requestMeta(req))
    return ProviderResponseSchema.parse({ provider })
  })

  app.patch('/providers/:id', { preHandler: [requireAdmin, reauthIfKey] }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdateProviderRequestSchema.parse(req.body)
    const provider = await service.updateProvider(id, input, req.user!.id, requestMeta(req))
    return ProviderResponseSchema.parse({ provider })
  })

  app.delete('/providers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    await service.deleteProvider(id, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  app.post('/providers/:id/test', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    return TestProviderResponseSchema.parse(await service.testProvider(id))
  })

  app.post('/discover', { preHandler: requireAdmin }, async (req) => {
    const input = DiscoverModelsRequestSchema.parse(req.body)
    return DiscoverModelsResponseSchema.parse(await service.discover(input))
  })

  app.get('/catalog', { preHandler: requireAdmin }, async () =>
    CatalogResponseSchema.parse(await service.getCatalog()),
  )

  app.put('/catalog', { preHandler: requireAdmin }, async (req) => {
    const input = SaveCatalogRequestSchema.parse(req.body)
    return CatalogResponseSchema.parse(
      await service.saveCatalog(input.entries, req.user!.id, requestMeta(req)),
    )
  })

  app.delete('/catalog/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const { key } = CatalogKeyParamsSchema.parse(req.params)
    await service.deleteCatalogEntry(key, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  app.post('/catalog/match', { preHandler: requireAdmin }, async (req) => {
    const input = MatchModelsRequestSchema.parse(req.body)
    return MatchModelsResponseSchema.parse(await service.matchModels(input.ids))
  })

  app.put(
    '/providers/:id/user-keys/:userId',
    { preHandler: [requireAdmin, requireReauth()] },
    async (req, reply) => {
      const { id, userId } = UserKeyParamsSchema.parse(req.params)
      const input = SetUserProviderKeyRequestSchema.parse(req.body)
      await service.setUserProviderKey(id, userId, input.apiKey, req.user!.id, requestMeta(req))
      return reply.code(204).send()
    },
  )

  app.delete(
    '/providers/:id/user-keys/:userId',
    { preHandler: [requireAdmin, requireReauth()] },
    async (req, reply) => {
      const { id, userId } = UserKeyParamsSchema.parse(req.params)
      await service.deleteUserProviderKey(id, userId, req.user!.id, requestMeta(req))
      return reply.code(204).send()
    },
  )

  app.get('/presets', { preHandler: requireAdmin }, async (req) => {
    // docs/22 §3：`?platform=cloud|desktop` 缺省 cloud
    const { platform } = ModelPresetListQuerySchema.parse(req.query ?? {})
    return ModelPresetListResponseSchema.parse(await service.listPresets(platform))
  })

  app.post('/presets', { preHandler: requireAdmin }, async (req) => {
    const input = CreatePresetRequestSchema.parse(req.body)
    const preset = await service.createPreset(input, req.user!.id, requestMeta(req))
    return PresetResponseSchema.parse({ preset })
  })

  app.patch('/presets/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdatePresetRequestSchema.parse(req.body)
    const preset = await service.updatePreset(id, input, req.user!.id, requestMeta(req))
    return PresetResponseSchema.parse({ preset })
  })

  app.delete('/presets/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    await service.deletePreset(id, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  app.get('/presets/:id/preview', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const query = PresetPreviewQuerySchema.parse(req.query)
    return PresetPreviewResponseSchema.parse(await service.previewForUser(id, query.userId))
  })

  void deps
}
