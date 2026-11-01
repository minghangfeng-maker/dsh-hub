import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AddPluginPlatformRequestSchema,
  AddPluginVersionQuerySchema,
  AddPluginVersionRequestSchema,
  AddPluginVersionResponseSchema,
  AdminPluginListQuerySchema,
  AdminPluginListResponseSchema,
  AdminPluginRowSchema,
  CreatePluginRequestSchema,
  MyPluginsResponseSchema,
  PluginLookupQuerySchema,
  PluginLookupResponseSchema,
  PluginPlatformParamsSchema,
  PluginPlatformResponseSchema,
  PluginToggleResponseSchema,
  PluginUsersResponseSchema,
  RemovePluginPlatformQuerySchema,
  UpdatePluginPlatformRequestSchema,
  UpdatePluginRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireReauth, requireUser } from '../../app.js'
import type { BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { PLUGIN_SOURCE_MAX_BYTES } from './sources.js'
import type { PluginService } from './types.js'

const IdParamsSchema = z.object({ id: z.coerce.number().int().positive() })
const PluginIdParamsSchema = z.object({ pluginId: z.coerce.number().int().positive() })
const VersionParamsSchema = IdParamsSchema.extend({ versionId: z.coerce.number().int().positive() })

/**
 * plugins 模块路由（04 §3.2 §4.5）。前缀 `/api`：
 * `/api/admin/plugins*` 与 `/api/me/plugins*`。
 */
export function registerPluginRoutes(app: FastifyInstance, deps: BaseDeps, service: PluginService): void {
  // ── 管理端目录 ────────────────────────────────────────────────────────────

  app.get('/admin/plugins', { preHandler: requireAdmin }, async (req) => {
    const { platform } = AdminPluginListQuerySchema.parse(req.query)
    return AdminPluginListResponseSchema.parse(await service.listCatalog(platform))
  })

  app.get('/admin/plugins/lookup', { preHandler: requireAdmin }, async (req) => {
    const query = PluginLookupQuerySchema.parse(req.query)
    return PluginLookupResponseSchema.parse(await service.lookup(query))
  })

  // 上传 .tgz 的元数据预读（添加插件抽屉第 ② 步）：multipart 字段 file，只读 package.json，不入库
  app.post('/admin/plugins/lookup', { preHandler: requireAdmin }, async (req) => {
    if (!req.isMultipart()) throw new HubError('VALIDATION_FAILED', '请用 multipart 上传 .tgz 文件')
    const file = await req.file({ limits: { fileSize: PLUGIN_SOURCE_MAX_BYTES, files: 1 } })
    if (!file) throw new HubError('VALIDATION_FAILED', '缺少文件字段 file')
    if (file.fieldname !== 'file') throw new HubError('VALIDATION_FAILED', '文件字段名必须是 file')
    const data = await file.toBuffer()
    return PluginLookupResponseSchema.parse(
      await service.lookupUpload({ data, filename: file.filename, mimetype: file.mimetype }),
    )
  })

  app.post('/admin/plugins', { preHandler: requireAdmin }, async (req, reply) => {
    const input = CreatePluginRequestSchema.parse(req.body)
    const row = await service.createPlugin(input, req.user?.id ?? null, requestMeta(req))
    return reply.code(201).send(AdminPluginRowSchema.parse(row))
  })

  app.patch('/admin/plugins/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdatePluginRequestSchema.parse(req.body)
    return AdminPluginRowSchema.parse(
      await service.updatePlugin(id, input, req.user?.id ?? null, requestMeta(req)),
    )
  })

  app.delete('/admin/plugins/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    await service.deletePlugin(id, req.user?.id ?? null, requestMeta(req))
    return reply.code(204).send()
  })

  // ── 版本（JSON 或 multipart 上传） ────────────────────────────────────────

  app.post('/admin/plugins/:id/versions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    const { platform } = AddPluginVersionQuerySchema.parse(req.query ?? {})
    const meta = requestMeta(req)
    const actorId = req.user?.id ?? null
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: PLUGIN_SOURCE_MAX_BYTES, files: 1 } })
      if (!file) throw new HubError('VALIDATION_FAILED', '缺少文件字段 file')
      if (file.fieldname !== 'file') {
        throw new HubError('VALIDATION_FAILED', '文件字段名必须是 file')
      }
      // multipart 的平台只能是查询串（字段在流里读不到全部）
      const data = await file.toBuffer()
      const version = await service.addUploadedVersion(
        id,
        { data, filename: file.filename, mimetype: file.mimetype },
        meta,
        actorId,
        platform,
      )
      return reply.code(201).send(AddPluginVersionResponseSchema.parse({ version }))
    }
    const input = AddPluginVersionRequestSchema.parse(req.body)
    // 查询串优先（旧客户端只给 body，且 body 里没有 platform → 云上）
    const version = await service.addVersion(
      id,
      { ...input, platform: input.platform ?? platform },
      meta,
      actorId,
    )
    return reply.code(201).send(AddPluginVersionResponseSchema.parse({ version }))
  })

  // ── 平台库（docs/22 §2.2） ────────────────────────────────────────────────

  app.post('/admin/plugins/:id/platforms', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = AddPluginPlatformRequestSchema.parse(req.body)
    return PluginPlatformResponseSchema.parse({
      plugin: await service.addPlatform(id, input, req.user?.id ?? null, requestMeta(req)),
    })
  })

  app.patch('/admin/plugins/:id/platforms/:platform', { preHandler: requireAdmin }, async (req) => {
    const { id, platform } = PluginPlatformParamsSchema.parse(req.params)
    const input = UpdatePluginPlatformRequestSchema.parse(req.body ?? {})
    return PluginPlatformResponseSchema.parse({
      plugin: await service.updatePlatform(id, platform, input, req.user?.id ?? null, requestMeta(req)),
    })
  })

  // 移出某个平台的库：明确写 destructive 的地方统一要二次密码（04 §4.8）
  app.delete(
    '/admin/plugins/:id/platforms/:platform',
    { preHandler: [requireAdmin, requireReauth()] },
    async (req, reply) => {
      const { id, platform } = PluginPlatformParamsSchema.parse(req.params)
      const { force } = RemovePluginPlatformQuerySchema.parse(req.query ?? {})
      await service.removePlatform(id, platform, { force }, req.user?.id ?? null, requestMeta(req))
      return reply.code(204).send()
    },
  )

  app.delete('/admin/plugins/:id/versions/:versionId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, versionId } = VersionParamsSchema.parse(req.params)
    await service.removeVersion(id, versionId, req.user?.id ?? null, requestMeta(req))
    return reply.code(204).send()
  })

  app.get('/admin/plugins/:id/users', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    return PluginUsersResponseSchema.parse({ items: await service.listUsersOfPlugin(id) })
  })

  // ── 我的插件（04 §3.2，用户自助） ─────────────────────────────────────────

  app.get('/me/plugins', { preHandler: requireUser }, async (req) =>
    MyPluginsResponseSchema.parse(await service.listForUser(req.user!.id)),
  )

  app.post('/me/plugins/:pluginId/install', { preHandler: requireUser }, async (req, reply) => {
    const { pluginId } = PluginIdParamsSchema.parse(req.params)
    const job = await service.requestToggle(req.user!.id, pluginId, 'install')
    return reply.code(202).send(PluginToggleResponseSchema.parse(job))
  })

  app.post('/me/plugins/:pluginId/uninstall', { preHandler: requireUser }, async (req, reply) => {
    const { pluginId } = PluginIdParamsSchema.parse(req.params)
    const job = await service.requestToggle(req.user!.id, pluginId, 'uninstall')
    return reply.code(202).send(PluginToggleResponseSchema.parse(job))
  })

  void deps
}
