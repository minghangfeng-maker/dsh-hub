import { createHash } from 'node:crypto'
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createReadStream } from 'node:fs'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  MOBILE_ANDROID_APK_MAX_BYTES,
  MobileAppReleaseListResponseSchema,
  MobileAppReleaseSchema,
  MobileAppRollbackRequestSchema,
  MobileAppRollbackResponseSchema,
  MobileAppVersionCodeSchema,
  MobileAppVersionSchema,
  PublicAndroidDownloadResponseSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin } from '../../app.js'
import type { AppDeps } from '../../context.js'
import { requestOrigin } from '../../server/public-request.js'
import { HubError } from '../../lib/errors.js'
import type { MobileAppService } from './types.js'

/**
 * 安卓 App 发布记录的路由（WP40r）。
 *
 * 三层前缀，鉴权各不相同（与桌面端下发同一套划分）：
 * - `/api/admin/mobile/app/*`：管理端，`requireAdmin`；上传 APK、看记录、回滚；
 * - `/api/public/android/*`：匿名（主页右卡与二维码），按 IP 限流；
 * - `/android/bin/:file`：匿名字节流，长缓存 immutable（文件名内容寻址）。
 */

const APK_FIELD = 'apk'

export function adminMobileAppPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireMobileApp(deps)

    // 上传即发布（multipart：字段 version / versionCode，文件字段 apk）
    app.post(
      '/app/releases',
      { preHandler: requireAdmin, bodyLimit: MOBILE_ANDROID_APK_MAX_BYTES },
      async (req, reply) => {
        if (!req.isMultipart()) {
          throw new HubError('VALIDATION_FAILED', '请用 multipart 上传 APK（文件字段 apk）')
        }
        const fields: Record<string, string> = {}
        let saved: SavedApk | null = null
        try {
          const parts = req.parts({ limits: { fileSize: MOBILE_ANDROID_APK_MAX_BYTES, files: 1, fields: 8 } })
          for await (const part of parts) {
            if (part.type === 'field') {
              fields[part.fieldname] = String(part.value)
              continue
            }
            if (part.fieldname !== APK_FIELD) {
              throw new HubError('VALIDATION_FAILED', `未知的文件字段 ${part.fieldname}`)
            }
            saved = await saveApk(part.file, {
              maxBytes: MOBILE_ANDROID_APK_MAX_BYTES,
              originalName: part.filename,
            })
          }
          if (!saved) throw new HubError('VALIDATION_FAILED', `缺少 APK 文件（字段名 ${APK_FIELD}）`)
          const release = await service.create({
            versionName: MobileAppVersionSchema.parse(fields['version']),
            versionCode: MobileAppVersionCodeSchema.parse(Number(fields['versionCode'])),
            tempFile: saved.tempFile,
            originalName: saved.fileName,
            bytes: saved.bytes,
            sha256: saved.sha256,
            actorId: req.user?.id ?? null,
            meta: requestMeta(req),
          })
          return reply.code(201).send(MobileAppReleaseSchema.parse(release))
        } finally {
          if (saved) rmSync(saved.dir, { recursive: true, force: true })
        }
      },
    )

    app.get('/app/releases', { preHandler: requireAdmin }, async () => {
      const mobile = deps.settings.get('mobile').app
      return MobileAppReleaseListResponseSchema.parse({
        current: service.current(),
        items: service.list(),
        settings: {
          minVersionCode: mobile.minVersionCode,
          latestVersionCode: mobile.latestVersionCode,
          downloadUrl: mobile.downloadUrl,
        },
      })
    })

    app.post('/app/rollback', { preHandler: requireAdmin }, async (req) => {
      const input = MobileAppRollbackRequestSchema.parse(req.body ?? {})
      return MobileAppRollbackResponseSchema.parse(
        service.rollback(input, req.user?.id ?? null, requestMeta(req)),
      )
    })
  }
}

/** 公开主页右卡 + 二维码（匿名；没有发布记录时 app=null，二维码 404） */
export function publicAndroidPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireMobileApp(deps)

    app.get('/android/download', async (req, reply) => {
      // 发布/回滚随时改「当前版本」，不让中间层缓存
      reply.header('Cache-Control', 'no-store')
      return PublicAndroidDownloadResponseSchema.parse(
        service.publicDownload(req.ip ?? null, requestOrigin(req, deps.config)),
      )
    })

    app.get('/android/qr.svg', async (req, reply) => {
      const svg = service.qrSvg(requestOrigin(req, deps.config))
      reply.header('Content-Type', 'image/svg+xml; charset=utf-8')
      // 二维码内容随「当前版本」变化，同样不许缓存
      reply.header('Cache-Control', 'no-store')
      return svg
    })
  }
}

/** APK 字节流（匿名；文件名内容寻址 → immutable 长缓存） */
export function androidBinPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireMobileApp(deps)
    const params = z.object({ file: z.string().min(1).max(200) })

    app.get('/bin/:file', async (req, reply) => {
      const { file } = params.parse(req.params ?? {})
      const download = service.apkFile(file)
      reply.header('Content-Type', 'application/vnd.android.package-archive')
      reply.header('Content-Length', String(download.bytes))
      reply.header('X-Checksum-Sha256', download.sha256)
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      return reply.send(createReadStream(download.filePath))
    })
  }
}

interface SavedApk {
  dir: string
  tempFile: string
  fileName: string
  bytes: number
  sha256: string
}

/**
 * 把上传流写进系统临时目录并同时算 sha256（与桌面安装包上传同一套做法：
 * 上传过程中就限流/算摘要，落盘后再由 service 复核一次）。
 */
async function saveApk(
  stream: NodeJS.ReadableStream,
  opts: { maxBytes: number; originalName: string },
): Promise<SavedApk> {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-mobile-apk-'))
  const tempFile = join(dir, 'upload.apk')
  const sha256 = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > opts.maxBytes) {
        callback(new HubError('PAYLOAD_TOO_LARGE', `APK 超过 ${String(opts.maxBytes)} 字节上限`))
        return
      }
      sha256.update(chunk)
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
    throw new HubError('VALIDATION_FAILED', '上传的 APK 是空的')
  }
  return { dir, tempFile, fileName: opts.originalName, bytes, sha256: sha256.digest('hex') }
}

function requireMobileApp(deps: AppDeps): MobileAppService {
  const service = deps.services.mobileApp
  if (!service) throw new HubError('INTERNAL', '手机 App 发布记录服务不可用')
  return service
}
