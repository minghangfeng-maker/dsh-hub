import { createHash } from 'node:crypto'
import { createReadStream, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import qrcode from 'qrcode-generator'
import {
  MOBILE_ANDROID_BIN_PREFIX,
  MOBILE_ANDROID_QR_PATH,
  MobileAppReleaseSchema,
  PublicAndroidDownloadResponseSchema,
  type MobileAppRelease,
  type MobileAppRollbackRequest,
  type MobileAppRollbackResponse,
  type PublicAndroidDownloadResponse,
} from '@dsh-hub/shared'
import { HubError } from '../../lib/errors.js'
import { createWindowCounter, isLoopbackIp } from '../../lib/rate-limit.js'
import type { AppDeps, RequestMeta } from '../../context.js'
import type { DownloadBase, RequestOrigin } from '../../server/public-request.js'
import {
  currentRelease,
  findRelease,
  findReleaseByFile,
  insertPublished,
  listReleases,
  previousRelease,
  publishOnly,
} from './repo.js'
import type { MobileAppReleaseRow, MobileAppService, MobileAppUploadInput } from './types.js'

/**
 * 安卓 App 发布记录（WP40r）。
 *
 * 职责边界：**只管「哪个 APK 是当前版本」**——不碰桌面端发布记录、不碰 electron-updater
 * feed、不参与桌面强更地板。主页下载入口、二维码、`bootstrap.app` 的 downloadUrl /
 * latestVersionCode 三处都从这里取同一个答案。
 *
 * 文件：`HUB_DATA_DIR/mobile-app/bin/<file>`，匿名长缓存提供（文件名内容寻址：
 * `dsh-hub-app-<版本>-<sha256 前 8 位>.apk`，同名即同内容，可以 immutable 缓存）。
 */

/** 主页公开接口按 IP 限流（回环豁免，与桌面端公开下载同一套原语与量级） */
const PUBLIC_DOWNLOAD_LIMIT_PER_MINUTE = 120

/** 文件名长度上限（与库里 `file_name` 的 CHECK 一致） */
const MAX_FILE_NAME = 200

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export function createMobileAppService(deps: AppDeps): MobileAppService {
  const { db, clock, paths } = deps
  const downloadLimit = createWindowCounter({ capacity: PUBLIC_DOWNLOAD_LIMIT_PER_MINUTE, windowMs: 60_000, clock })
  const binDir = join(paths.mobileAppDir, 'bin')

  function pathOf(row: MobileAppReleaseRow): string {
    return `${MOBILE_ANDROID_BIN_PREFIX}/${encodeURIComponent(row.file_name)}`
  }

  /**
   * 某个入口的 APK 地址（WP52 / 08 §3）：
   *
   * - 配了独立资产基址（公网入口 `:8124/downloads`、边缘入口 `/downloads`）→ `${assetsOrigin}/mobile-app/<file>`；
   * - 没配 → 绝对站根 + `/android/bin/<file>`（由 Hub 自己提供）。
   */
  function urlForBase(row: MobileAppReleaseRow, base: DownloadBase): string {
    return base.assetsOrigin !== null
      ? `${base.assetsOrigin}/mobile-app/${encodeURIComponent(row.file_name)}`
      : `${base.origin.replace(/\/+$/u, '')}${pathOf(row)}`
  }

  /**
   * 本入口的绝对地址：`bootstrap.app.downloadUrl` 与二维码用（本机 7700 进来也指公网入口，
   * 见 `requestOrigin()` 的说明）。
   */
  function absoluteUrl(row: MobileAppReleaseRow | null, origin: RequestOrigin): string | null {
    return row ? urlForBase(row, origin.download) : null
  }

  /** 同一个 APK 的全部可用地址：本入口排第一，另一入口排第二，去重（08 §3） */
  function mirrorUrls(row: MobileAppReleaseRow | null, origin: RequestOrigin): string[] {
    if (!row) return []
    const urls: string[] = []
    for (const base of origin.downloadMirrors) {
      const url = urlForBase(row, base)
      if (!urls.includes(url)) urls.push(url)
    }
    return urls
  }

  function view(row: MobileAppReleaseRow): MobileAppRelease {
    return MobileAppReleaseSchema.parse({
      id: row.id,
      versionName: row.version_name,
      versionCode: row.version_code,
      fileName: row.file_name,
      bytes: row.bytes,
      sha256: row.sha256,
      status: row.status,
      path: pathOf(row),
      uploadedAt: row.uploaded_at,
    })
  }

  /**
   * 下载文件名：`dsh-hub-app-<版本>-<sha256 前 8 位>.apk`。
   *
   * 完全由服务端生成（不用浏览器给的名字）：文件名要进 URL 与磁盘路径，只能含安全字符；
   * 内容寻址让 `/android/bin/<file>` 可以长缓存 —— 同名必然同字节，换版本一定换名字。
   */
  function fileNameFor(versionName: string, sha256: string): string {
    const safeVersion = versionName.replace(/[^0-9A-Za-z._-]/gu, '_')
    const name = `dsh-hub-app-${safeVersion}-${sha256.slice(0, 8)}.apk`
    if (name.length > MAX_FILE_NAME) throw new HubError('VALIDATION_FAILED', '版本号太长，文件名超限')
    return name
  }

  function auditRelease(
    actorId: number | null,
    action: string,
    targetId: number | string,
    detail: Record<string, unknown>,
    meta: RequestMeta,
  ): void {
    deps.audit.log({
      actorId,
      actorIp: meta.ip,
      action,
      targetType: 'mobile.app.release',
      targetId,
      detail,
    })
  }

  async function create(input: MobileAppUploadInput): Promise<MobileAppRelease> {
    const fileName = fileNameFor(input.versionName, input.sha256)
    const existing = findReleaseByFile(db, fileName)
    if (existing) {
      // 同一份字节（同版本 + 同 sha256）重复上传：把这条标回 published 即可，不重复落盘
      db.tx(() => {
        publishOnly(db, existing.id)
      })
      auditRelease(
        input.actorId,
        'mobile.app.release.republish',
        existing.id,
        { version: input.versionName, versionCode: input.versionCode },
        input.meta,
      )
      const row = findRelease(db, existing.id)
      if (!row) throw new HubError('INTERNAL', '发布记录读不到')
      return view(row)
    }

    mkdirSync(binDir, { recursive: true, mode: 0o700 })
    const target = join(binDir, fileName)
    copyFileSync(input.tempFile, target)
    // 落盘复核：字节数与 sha256 必须与上传流一致（防止半截文件 / 磁盘问题）
    const onDiskBytes = statSync(target).size
    const onDiskSha = await sha256File(target)
    if (onDiskBytes !== input.bytes || onDiskSha !== input.sha256) {
      rmSync(target, { force: true })
      throw new HubError('INTERNAL', 'APK 落盘校验失败（字节数或 sha256 不一致）')
    }

    let createdId = 0
    try {
      db.tx(() => {
        createdId = insertPublished(db, {
          versionName: input.versionName,
          versionCode: input.versionCode,
          fileName,
          bytes: input.bytes,
          sha256: input.sha256,
          actorId: input.actorId,
          at: clock.nowIso(),
        })
      })
    } catch (error) {
      // 事务失败（并发上传 / 部分唯一索引冲突）：删掉刚拷进去的文件，别留孤儿
      rmSync(target, { force: true })
      throw error
    }
    const row = findRelease(db, createdId)
    if (!row) throw new HubError('INTERNAL', '发布记录写入后读不到')
    auditRelease(
      input.actorId,
      'mobile.app.release.publish',
      createdId,
      {
        version: input.versionName,
        versionCode: input.versionCode,
        fileName,
        bytes: input.bytes,
        sha256: input.sha256,
      },
      input.meta,
    )
    return view(row)
  }

  function rollback(
    input: MobileAppRollbackRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): MobileAppRollbackResponse {
    const current = currentRelease(db)
    if (!current) throw new HubError('NOT_FOUND', '还没有发布过安卓 APK')
    let target: MobileAppReleaseRow | null
    if (input.releaseId !== undefined) {
      target = findRelease(db, input.releaseId)
      if (!target) throw new HubError('NOT_FOUND', '发布记录不存在')
      if (target.id === current.id) throw new HubError('CONFLICT', '这条记录已经是当前版本')
    } else {
      target = previousRelease(db, current)
      if (!target) throw new HubError('NOT_FOUND', '没有上一版可回滚（只有一次发布）')
    }
    const targetId = target.id
    db.tx(() => {
      publishOnly(db, targetId)
    })
    const updated = findRelease(db, targetId)
    if (!updated) throw new HubError('INTERNAL', '回滚后读不到发布记录')
    auditRelease(
      actorId,
      'mobile.app.release.rollback',
      updated.id,
      { from: current.version_name, to: updated.version_name, yanked: [current.id] },
      meta,
    )
    return { release: view(updated), yanked: [current.id] }
  }

  return {
    current() {
      const row = currentRelease(db)
      return row ? view(row) : null
    },

    list() {
      return listReleases(db).map(view)
    },

    create,

    rollback,

    publicDownload(ip: string | null, origin: RequestOrigin): PublicAndroidDownloadResponse {
      if (!isLoopbackIp(ip)) {
        const gate = downloadLimit.consume(ip ?? 'unknown')
        if (!gate.allowed) {
          throw new HubError('RATE_LIMITED', '请求太频繁', { retryAfterSec: gate.retryAfterSec })
        }
      }
      const row = currentRelease(db)
      return PublicAndroidDownloadResponseSchema.parse({
        app: row
          ? {
              version: row.version_name,
              versionCode: row.version_code,
              prerelease: row.version_name.includes('-'),
              fileName: row.file_name,
              bytes: row.bytes,
              sha256: row.sha256,
              // 未配资产基址时相对站根；配了就直接给绝对地址（公网/边缘静态托管）
              url:
                origin.download.assetsOrigin !== null
                  ? `${origin.download.assetsOrigin}/mobile-app/${encodeURIComponent(row.file_name)}`
                  : pathOf(row),
              // WP52：App 自动更新按顺序回退（老 App 忽略这个字段）
              mirrors: mirrorUrls(row, origin),
              publishedAt: row.uploaded_at,
            }
          : null,
        qrUrl: MOBILE_ANDROID_QR_PATH,
      })
    },

    qrSvg(origin: RequestOrigin): string {
      const row = currentRelease(db)
      if (!row) throw new HubError('NOT_FOUND', '还没有发布过安卓 APK')
      return renderQrSvg(urlForBase(row, origin.download))
    },

    apkFile(file: string) {
      if (!/^[A-Za-z0-9._-]+$/u.test(file) || file === '.' || file === '..') {
        throw new HubError('NOT_FOUND')
      }
      const row = findReleaseByFile(db, file)
      if (!row) throw new HubError('NOT_FOUND')
      const filePath = join(binDir, file)
      if (!existsSync(filePath)) throw new HubError('NOT_FOUND', 'APK 文件已丢失')
      return { filePath, fileName: file, bytes: row.bytes, sha256: row.sha256 }
    },

    downloadUrl(origin: RequestOrigin): string | null {
      return absoluteUrl(currentRelease(db), origin)
    },

    downloadMirrors(origin: RequestOrigin): string[] {
      return mirrorUrls(currentRelease(db), origin)
    },

    latestVersionCode(): number | null {
      const row = currentRelease(db)
      return row ? row.version_code : null
    },
  }
}

/**
 * 二维码 SVG（服务端渲染，零运行时依赖的 `qrcode-generator`）。
 *
 * 为什么服务端生成而不是前端引一个 QR 库：
 * - 二维码内容必须与 `bootstrap.app.downloadUrl` **完全一致**（同一个绝对地址），
 *   放服务端就只有一个真相来源；
 * - 主页因此不需要多一个前端依赖，SVG 还能被浏览器缓存；
 * - 单元测试可以直接断言「编码内容变了 → 矩阵变了」。
 *
 * 参数：纠错等级 M（约 15% 冗余，手机摄像头够用）、4 模块静区（QR 规范）、
 * 每模块 4px、`shape-rendering="crispEdges"` 保证缩放不糊。
 */
function renderQrSvg(content: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(content)
  qr.make()
  const count = qr.getModuleCount()
  const border = 4
  const scale = 4
  const size = (count + border * 2) * scale
  const cells: string[] = []
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue
      const x = (col + border) * scale
      const y = (row + border) * scale
      cells.push(
        `<rect x="${String(x)}" y="${String(y)}" width="${String(scale)}" height="${String(scale)}"/>`,
      )
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 ${String(size)} ${String(size)}" shape-rendering="crispEdges" role="img" aria-label="安卓 App 下载二维码">`,
    `<rect width="${String(size)}" height="${String(size)}" fill="#ffffff"/>`,
    `<g fill="#000000">${cells.join('')}</g>`,
    '</svg>',
  ].join('')
}

/** 供 routes 与测试使用的路径常量（避免各处重复拼字符串） */
export const MOBILE_APP_PATHS = {
  qr: MOBILE_ANDROID_QR_PATH,
  bin: MOBILE_ANDROID_BIN_PREFIX,
} as const
