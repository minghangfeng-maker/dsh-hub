import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  DESKTOP_INSTALLER_MAX_BYTES,
  DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES,
  DesktopAppDeliverRequestSchema,
  DesktopConfigDeliverRequestSchema,
  DesktopDeliverResponseSchema,
  DesktopDeliveryStateSchema,
  DesktopManifestSchema,
  DesktopModelPresetFragmentsResponseSchema,
  DesktopPluginArtifactListResponseSchema,
  DesktopPluginArtifactResponseSchema,
  DesktopPluginDeliverRequestSchema,
  DesktopPluginWithdrawRequestSchema,
  DesktopReleaseChannelSchema,
  DesktopReleaseListResponseSchema,
  DesktopReleaseRollbackRequestSchema,
  DesktopReleaseRollbackResponseSchema,
  DesktopReleaseSchema,
  DesktopReleaseTargetSchema,
  DesktopUninstallDeliverRequestSchema,
  DesktopUpdateFloorResponseSchema,
  PublicDesktopDownloadResponseSchema,
  UpdateDesktopFloorRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin } from '../../app.js'
import { requestOrigin } from '../../server/public-request.js'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { ARTIFACT_SIGN_DEVICE_PARAM, ARTIFACT_SIGN_SIGNATURE_PARAM } from './artifact-sign.js'
import { matchesEtag } from './service.js'
import type { DesktopDeliveryService, DesktopReleaseUploadInput } from './types.js'

/** 路径参数：插件 id / 版本 id */
const VersionParamsSchema = z.object({
  pluginId: z.coerce.number().int().positive(),
  versionId: z.coerce.number().int().positive(),
})
/** 公共 feed/bin 的路径参数 */
const FeedParamsSchema = z.object({ target: DesktopReleaseTargetSchema, file: z.string().min(1).max(200) })
/** 插件整包的取件查询串（WP31）：`?d=<deviceId>&sig=<签名>`；都不给时走「无令牌无签名 → 401」 */
const ArtifactQuerySchema = z.object({
  [ARTIFACT_SIGN_DEVICE_PARAM]: z.string().trim().min(1).max(64).optional(),
  [ARTIFACT_SIGN_SIGNATURE_PARAM]: z.string().trim().min(1).max(128).optional(),
})

/**
 * 设备侧下发端点（WP25b）：`/api/desktop/manifest` 与 `/api/desktop/plugins/*`。
 * 清单只认 Bearer 设备令牌（app.ts 的会话钩子已解析成 `req.desktop`）；不校验 Origin（裁决 #6）。
 * 整包下载接受「Bearer 设备令牌」**或**「清单里的每设备签名」（WP31，桌面端取件不带任何头），
 * 其余端点一律只认 Bearer。
 */
export function deviceDeliveryPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDelivery(deps)

    // 桌面模型基线（WP32a / docs/22 §3）：迁移 124 在 SQL 里渲染不出片段，改在**服务启动时幂等补齐**。
    // 放在 onReady（此时 models/relay 都已就绪），设备第一次拉清单之前就写完；重复启动是 no-op。
    app.addHook('onReady', async () => {
      try {
        const result = await service.ensureModelBaseline()
        if (result.written) {
          app.log.info({ revision: result.revision }, '已补齐桌面模型基线')
        }
      } catch (error) {
        app.log.warn({ err: error }, '补齐桌面模型基线失败')
      }
    })

    app.get('/manifest', async (req, reply) => {
      const deviceId = requireDeviceId(req)
      const envelope = service.manifestForDevice(deviceId)
      reply.header('ETag', envelope.etag)
      reply.header('Cache-Control', 'no-store')
      if (matchesEtag(req.headers['if-none-match'], envelope.etag)) return reply.code(304).send()
      return DesktopManifestSchema.parse(envelope.manifest)
    })

    // 插件整包：包名可能带 scope（`@local/dsh-memory/0.1.2.tgz`），所以用通配路由再自己切
    app.get('/plugins/*', async (req, reply) => {
      const raw = (req.params as Record<string, string>)['*'] ?? ''
      // 两条鉴权路径：带设备令牌（旧客户端/网页）优先；否则用清单里给的每设备签名
      const query = ArtifactQuerySchema.parse(req.query ?? {})
      const download = req.desktop
        ? service.artifactDownload(req.desktop.deviceId, raw)
        : service.signedArtifactDownload(raw, {
            deviceId: query[ARTIFACT_SIGN_DEVICE_PARAM] ?? '',
            signature: query[ARTIFACT_SIGN_SIGNATURE_PARAM] ?? '',
          })
      reply.header('Content-Type', 'application/gzip')
      reply.header('Content-Length', String(download.bytes))
      reply.header('Content-Disposition', `attachment; filename="${download.fileName}"`)
      if (download.sha256) reply.header('X-Checksum-Sha256', download.sha256)
      reply.header('ETag', `"sha256-${download.sha256 ?? ''}"`)
      reply.header('Cache-Control', 'private, max-age=0, no-store')
      return reply.send(createReadStream(download.filePath))
    })
  }
}

/**
 * 管理端下发端点（WP25b）：`/api/admin/desktop/*`。
 * 全部要求管理员会话；有副作用（写期望状态 / 生成 revision / 落盘）的都在这里。
 */
export function adminDesktopDeliveryPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDelivery(deps)

    app.get('/delivery', { preHandler: requireAdmin }, async () =>
      DesktopDeliveryStateSchema.parse(service.state()),
    )

    app.put('/plugins', { preHandler: requireAdmin }, async (req) => {
      const input = DesktopPluginDeliverRequestSchema.parse(req.body ?? {})
      return DesktopDeliverResponseSchema.parse(
        service.deliverPlugin(input, req.user?.id ?? null, requestMeta(req)),
      )
    })

    app.delete('/plugins', { preHandler: requireAdmin }, async (req) => {
      const input = DesktopPluginWithdrawRequestSchema.parse(req.body ?? {})
      return DesktopDeliverResponseSchema.parse(
        service.withdrawPlugin(input, req.user?.id ?? null, requestMeta(req)),
      )
    })

    app.put('/config', { preHandler: requireAdmin }, async (req) => {
      const input = DesktopConfigDeliverRequestSchema.parse(req.body ?? {})
      return DesktopDeliverResponseSchema.parse(
        service.deliverConfig(input, req.user?.id ?? null, requestMeta(req)),
      )
    })

    app.put('/app', { preHandler: requireAdmin }, async (req) => {
      const input = DesktopAppDeliverRequestSchema.parse(req.body ?? {})
      return DesktopDeliverResponseSchema.parse(
        service.deliverApp(input, req.user?.id ?? null, requestMeta(req)),
      )
    })

    app.put('/uninstall', { preHandler: requireAdmin }, async (req) => {
      const input = DesktopUninstallDeliverRequestSchema.parse(req.body ?? {})
      return DesktopDeliverResponseSchema.parse(
        service.deliverUninstall(input, req.user?.id ?? null, requestMeta(req)),
      )
    })

    // 复用「下发到 DSH」的模型预设：给管理端一键带入两个片段。
    // WP25e：userId 可选 —— 不带时用**系统预设**（默认预设的全部可下发模型与默认），响应 userId=null
    app.get('/config/model-preset', { preHandler: requireAdmin }, async (req) => {
      const query = z
        .object({
          userId: z.coerce.number().int().positive().optional(),
          // WP28a：统一下发的 models 内容项可以指定预设（不传 = 系统预设）
          presetId: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query ?? {})
      return DesktopModelPresetFragmentsResponseSchema.parse(
        await service.modelPresetFragments(query.userId, query.presetId),
      )
    })

    // 插件整包上传（multipart file）：裁决 #16 的检查在 service 里
    app.post(
      '/plugins/:pluginId/versions/:versionId/package',
      { preHandler: requireAdmin, bodyLimit: DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES },
      async (req, reply) => {
        const { pluginId, versionId } = VersionParamsSchema.parse(req.params ?? {})
        if (!req.isMultipart()) {
          throw new HubError('VALIDATION_FAILED', '请用 multipart 上传插件整包（字段名 file）')
        }
        const part = await req.file({
          limits: { fileSize: DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES, files: 1 },
        })
        if (!part) throw new HubError('VALIDATION_FAILED', '缺少文件字段 file')
        if (part.fieldname !== 'file') throw new HubError('VALIDATION_FAILED', '文件字段名必须是 file')
        const saved = await saveUpload(part.file, {
          maxBytes: DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES,
          originalName: part.filename,
        })
        try {
          const artifact = await service.uploadPluginArtifact({
            pluginId,
            versionId,
            tempFile: saved.tempFile,
            bytes: saved.bytes,
            sha256: saved.sha256,
            actorId: req.user?.id ?? null,
            meta: requestMeta(req),
          })
          return reply.code(201).send(DesktopPluginArtifactResponseSchema.parse({ artifact }))
        } finally {
          rmSync(saved.dir, { recursive: true, force: true })
        }
      },
    )

    app.get('/artifacts', { preHandler: requireAdmin }, async () =>
      DesktopPluginArtifactListResponseSchema.parse({ items: service.listArtifacts() }),
    )

    // 安装包 + blockmap（multipart；字段 target/channel/version，文件 installer/blockmap）
    app.post(
      '/releases',
      { preHandler: requireAdmin, bodyLimit: DESKTOP_INSTALLER_MAX_BYTES },
      async (req, reply) => {
        if (!req.isMultipart()) {
          throw new HubError('VALIDATION_FAILED', '请用 multipart 上传安装包与 blockmap')
        }
        const fields: Record<string, string> = {}
        const uploads: ReleaseUpload[] = []
        try {
          const parts = req.parts({
            limits: { fileSize: DESKTOP_INSTALLER_MAX_BYTES, files: 2, fields: 10 },
          })
          for await (const part of parts) {
            if (part.type === 'field') {
              fields[part.fieldname] = String(part.value)
              continue
            }
            if (part.fieldname !== 'installer' && part.fieldname !== 'blockmap') {
              throw new HubError('VALIDATION_FAILED', `未知的文件字段 ${part.fieldname}`)
            }
            const saved = await saveUpload(part.file, {
              maxBytes: DESKTOP_INSTALLER_MAX_BYTES,
              originalName: part.filename,
            })
            uploads.push({
              field: part.fieldname,
              dir: saved.dir,
              tempFile: saved.tempFile,
              fileName: saved.fileName,
              bytes: saved.bytes,
              sha512: saved.sha512,
            })
          }
          const installer = uploads.find((entry) => entry.field === 'installer')
          if (!installer) throw new HubError('VALIDATION_FAILED', '缺少安装包文件（字段名 installer）')
          const blockmap = uploads.find((entry) => entry.field === 'blockmap') ?? null
          const input: DesktopReleaseUploadInput = {
            target: DesktopReleaseTargetSchema.parse(fields['target']),
            channel: DesktopReleaseChannelSchema.parse(fields['channel']),
            version: z
              .string()
              .max(128)
              .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, '版本号格式应为 1.2.3 或 1.2.3-rc.1')
              .parse(fields['version']),
            installer: {
              tempFile: installer.tempFile,
              fileName: installer.fileName,
              bytes: installer.bytes,
              sha512: installer.sha512,
            },
            blockmap: blockmap
              ? {
                  tempFile: blockmap.tempFile,
                  fileName: blockmap.fileName,
                  bytes: blockmap.bytes,
                  sha512: blockmap.sha512,
                }
              : null,
            actorId: req.user?.id ?? null,
            meta: requestMeta(req),
          }
          const release = service.createRelease(input)
          return reply.code(201).send(DesktopReleaseSchema.parse(release))
        } finally {
          for (const upload of uploads) rmSync(upload.dir, { recursive: true, force: true })
        }
      },
    )

    app.get('/releases', { preHandler: requireAdmin }, async () =>
      DesktopReleaseListResponseSchema.parse(service.listReleases()),
    )

    app.post('/releases/rollback', { preHandler: requireAdmin }, async (req) => {
      const input = DesktopReleaseRollbackRequestSchema.parse(req.body ?? {})
      return DesktopReleaseRollbackResponseSchema.parse(
        service.rollbackRelease(input, req.user?.id ?? null, requestMeta(req)),
      )
    })

    // WP38：给已有发布记录挂免安装 ZIP（multipart，文件字段 portable）；不进 feed、不改版本
    app.post(
      '/releases/:id/portable',
      { preHandler: requireAdmin, bodyLimit: DESKTOP_INSTALLER_MAX_BYTES },
      async (req) => {
        const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params ?? {})
        if (!req.isMultipart()) {
          throw new HubError('VALIDATION_FAILED', '请用 multipart 上传免安装包（字段名 portable）')
        }
        let saved: SavedUpload | null = null
        try {
          const parts = req.parts({
            limits: { fileSize: DESKTOP_INSTALLER_MAX_BYTES, files: 1, fields: 5 },
          })
          for await (const part of parts) {
            if (part.type === 'field') continue
            if (part.fieldname !== 'portable' || saved) {
              throw new HubError('VALIDATION_FAILED', `未知的文件字段 ${part.fieldname}`)
            }
            saved = await saveUpload(part.file, {
              maxBytes: DESKTOP_INSTALLER_MAX_BYTES,
              originalName: part.filename,
            })
          }
          if (!saved) throw new HubError('VALIDATION_FAILED', '缺少免安装包文件（字段名 portable）')
          const release = service.attachPortable({
            releaseId: id,
            portable: {
              tempFile: saved.tempFile,
              fileName: saved.fileName,
              bytes: saved.bytes,
              sha512: saved.sha512,
            },
            actorId: req.user?.id ?? null,
            meta: requestMeta(req),
          })
          return DesktopReleaseSchema.parse(release)
        } finally {
          if (saved) rmSync(saved.dir, { recursive: true, force: true })
        }
      },
    )

    app.get('/update-floor', { preHandler: requireAdmin }, async () =>
      DesktopUpdateFloorResponseSchema.parse(service.getFloor()),
    )

    app.put('/update-floor', { preHandler: requireAdmin }, async (req) => {
      const input = UpdateDesktopFloorRequestSchema.parse(req.body ?? {})
      return DesktopUpdateFloorResponseSchema.parse(
        service.setFloor(input, req.user?.id ?? null, requestMeta(req)),
      )
    })
  }
}

/**
 * 公开的 feed / bin（D3 §7.2）：`/desktop/feeds/<target>/<channel>.yml` 与 `/desktop/bin/<target>/<file>`。
 * electron-updater 的 generic provider 匿名取件，所以这里**没有**任何鉴权 —— 清单里只有版本号与哈希。
 */
export function desktopFeedPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDelivery(deps)

    app.get('/feeds/:target/:file', async (req, reply) => {
      const params = FeedParamsSchema.parse(req.params ?? {})
      const yaml = service.feedYaml(params.target, params.file)
      reply.header('Content-Type', 'text/yaml; charset=utf-8')
      reply.header('Cache-Control', 'no-store')
      return reply.send(yaml)
    })

    app.get('/bin/:target/:file', async (req, reply) => {
      const params = FeedParamsSchema.parse(req.params ?? {})
      const download = service.releaseFile(params.target, params.file)
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Length', String(download.bytes))
      if (download.sha512) reply.header('X-Checksum-Sha512', download.sha512)
      // 发布产物用不可变路径 + 长缓存（D3 §7.2）
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      return reply.send(createReadStream(download.filePath))
    })
  }
}

/**
 * 公开主页的安装包信息（WP36，挂在 `/api/public` 前缀下）：
 * `GET /api/public/desktop/download`。免登录、按 IP 限流；页面只需要「有没有 / 是哪一版」。
 */
export function publicDesktopDownloadPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDelivery(deps)
    app.get('/desktop/download', async (req, reply) => {
      // 发布/回滚随时可能改「最新一版」，不让中间层缓存旧版本号
      reply.header('Cache-Control', 'no-store')
      return PublicDesktopDownloadResponseSchema.parse(
        service.publicDownload(req.ip ?? null, requestOrigin(req, deps.config)),
      )
    })
  }
}

/** 匿名强更地板：`GET /api/v0/check_client_update`（逐字照 D3 §1.4） */
export function checkClientUpdatePlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDelivery(deps)
    app.get('/check_client_update', async (req, reply) => {
      reply.header('Cache-Control', 'no-store')
      return service.checkClientUpdate(req.headers, req.ip ?? null)
    })
  }
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function requireDelivery(deps: AppDeps): DesktopDeliveryService {
  const service = deps.services.desktopDelivery
  if (!service) throw new HubError('INTERNAL', 'desktopDelivery service 未装配')
  return service
}

function requireDeviceId(req: FastifyRequest): string {
  if (!req.desktop) throw new HubError('DEVICE_TOKEN_INVALID')
  return req.desktop.deviceId
}

interface ReleaseUpload {
  field: 'installer' | 'blockmap'
  dir: string
  tempFile: string
  fileName: string
  bytes: number
  sha512: string
}

interface SavedUpload {
  dir: string
  tempFile: string
  fileName: string
  bytes: number
  sha256: string
  sha512: string
}

/**
 * 把 multipart 的文件流落到临时目录，同时算 sha256/sha512 与字节数。
 * **不缓冲整包**（安装包可能有几百 MB），超限立刻中断。
 */
async function saveUpload(
  stream: NodeJS.ReadableStream,
  opts: { maxBytes: number; originalName: string },
): Promise<SavedUpload> {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-desktop-upload-'))
  const tempFile = join(dir, 'upload.bin')
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > opts.maxBytes) {
        callback(new HubError('PAYLOAD_TOO_LARGE', `文件超过 ${String(opts.maxBytes)} 字节上限`))
        return
      }
      sha256.update(chunk)
      sha512.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(stream, meter, createWriteStream(tempFile, { mode: 0o600 }))
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  if (bytes === 0) {
    rmSync(dir, { recursive: true, force: true })
    throw new HubError('VALIDATION_FAILED', '上传的文件是空的')
  }
  return {
    dir,
    tempFile,
    fileName: opts.originalName,
    bytes,
    sha256: sha256.digest('hex'),
    sha512: sha512.digest('base64'),
  }
}
