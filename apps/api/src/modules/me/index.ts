import { existsSync, readFileSync } from 'node:fs'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  AVATAR_FIELD_NAME,
  AVATAR_MAX_BYTES,
  ChangePasswordRequestSchema,
  UpdateMeRequestSchema,
} from '@dsh-hub/shared'
import { requireUser } from '../../app.js'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { avatarMime, resolveAvatarFile } from './avatar.js'

const SessionIdParamSchema = z.object({ id: z.string().min(1).max(128) })
const AvatarFileParamSchema = z.object({ file: z.string().min(1).max(64) })

/**
 * me 模块（04 §3）。前缀 `/api/me`：
 * `PATCH /`、`POST|DELETE /avatar`、`POST /password`、`GET /sessions`、`DELETE /sessions/:id`、
 * `POST /sessions/revoke-others`。
 * 实例相关（`/api/me/instance*`）归 WP2 的 instances 模块，插件归 WP3，导出归 WP4。
 */
export function mePlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = deps.services.me

    app.patch('/', { preHandler: requireUser }, async (req) => {
      const body = UpdateMeRequestSchema.parse(req.body ?? {})
      return service.updateProfile(req.user!.id, body)
    })

    app.post('/avatar', { preHandler: requireUser }, async (req) => {
      if (!req.isMultipart()) throw new HubError('UNSUPPORTED_MEDIA', '头像上传必须使用 multipart/form-data')
      const file = await req.file({ limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } })
      if (!file) throw new HubError('VALIDATION_FAILED', `缺少 ${AVATAR_FIELD_NAME} 文件字段`)
      if (file.fieldname !== AVATAR_FIELD_NAME) {
        throw new HubError('VALIDATION_FAILED', `文件字段名必须是 ${AVATAR_FIELD_NAME}`)
      }
      // 超限时 toBuffer 抛 413（@fastify/multipart），错误处理器翻成 PAYLOAD_TOO_LARGE
      const data = await file.toBuffer()
      return service.setAvatar(req.user!.id, { data, mimeType: file.mimetype, filename: file.filename })
    })

    app.delete('/avatar', { preHandler: requireUser }, async (req) => service.deleteAvatar(req.user!.id))

    app.post('/password', { preHandler: requireUser }, async (req, reply) => {
      const body = ChangePasswordRequestSchema.parse(req.body ?? {})
      await service.changePassword(req.user!.id, req.user!.sessionId, body)
      return reply.code(204).send()
    })

    app.get('/sessions', { preHandler: requireUser }, async (req) =>
      service.listSessions(req.user!.id, req.user!.sessionId),
    )

    app.delete('/sessions/:id', { preHandler: requireUser }, async (req, reply) => {
      const { id } = SessionIdParamSchema.parse(req.params ?? {})
      await service.revokeSession(req.user!.id, req.user!.sessionId, id)
      return reply.code(204).send()
    })

    app.post('/sessions/revoke-others', { preHandler: requireUser }, async (req) =>
      service.revokeOthers(req.user!.id, req.user!.sessionId),
    )
  }
}

/**
 * 头像读取（04 §3）。前缀 `/api/avatars`：文件名为 `<userId>-<sha256 前 12>.<ext>`，
 * 含哈希所以可长缓存；加 `nosniff` 防内容嗅探（02 §T12），文件名不合法一律 404。
 */
export function avatarsPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/:file', async (req, reply) => {
      const { file } = AvatarFileParamSchema.parse(req.params ?? {})
      const abs = resolveAvatarFile(deps.paths.avatarsDir, file)
      if (!existsSync(abs)) throw new HubError('NOT_FOUND')
      const data = readFileSync(abs)
      reply.header('Content-Type', avatarMime(file))
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      reply.header('X-Content-Type-Options', 'nosniff')
      return reply.send(data)
    })
  }
}

export { createMeService } from './service.js'
export { sniffImage, avatarFileName, AVATAR_FILE_REGEX } from './avatar.js'
export type { MeService } from './types.js'
