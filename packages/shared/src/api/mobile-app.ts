import { z } from 'zod'
import type { ContractEntry } from '../contract-map.js'
import { IsoDateTimeSchema } from '../common.js'

/**
 * 安卓 App 的**发布记录**（WP40r，上线决定 ② 的配套）。
 *
 * 为什么不是复用桌面端的 `desktop_releases`：那张表的 `target` 有 CHECK 约束
 * （`win-x64|mac-x64|mac-arm64`），而且每条记录都要生成 electron-updater 的 feed YAML 与
 * blockmap —— 安卓 APK 既不进 updater feed、也不该被桌面端的强更地板影响。为了不给桌面
 * 下发链路加第二套语义，这里用一张**只服务安卓**的单表：
 *
 * - 一条 `published` 行就是当前对外发布的 APK（部分唯一索引保证「最多一条」）；
 * - 「回滚」= 把当前行标成 `yanked`、把上一版标回 `published`（与桌面端的 yank 语义一致）；
 * - 文件放在 `HUB_DATA_DIR/mobile-app/bin/<file>`，由匿名长缓存的 `/android/bin/:file` 提供；
 * - 主页与 `bootstrap.app` 都从这张表取 `downloadUrl` / `latestVersionCode`。
 *
 * 谁写谁读：
 * - 管理端 `POST /api/admin/mobile/app/releases`（multipart）上传，`rollback` 回滚；
 * - 公开 `GET /api/public/android/download`（主页卡片）与 `GET /api/public/android/qr.svg`（二维码）；
 * - `GET /api/mobile/bootstrap` 的 `app` 段（App 检查更新用）。
 */

/** APK 上传上限：首个正式版预计 20–40 MB，留足余量（与桌面安装包上限不同，单独一个常量） */
export const MOBILE_ANDROID_APK_MAX_BYTES = 268_435_456

/** 下载路径前缀（相对站根；与桌面端的 `/desktop/bin/...` 同一口径） */
export const MOBILE_ANDROID_BIN_PREFIX = '/android/bin'
export const MOBILE_ANDROID_DOWNLOAD_PATH = '/api/public/android/download'
export const MOBILE_ANDROID_QR_PATH = '/api/public/android/qr.svg'

/** 版本号：`1.2.3` 或 `1.2.3-rc.1`（与桌面端发布记录同一套正则） */
export const MobileAppVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, '版本号格式应为 1.2.3 或 1.2.3-rc.1')

/** Android `versionCode`：正整数，上限对齐 google play 的 21 亿（这里只给 1000 万够用） */
export const MobileAppVersionCodeSchema = z.number().int().min(1).max(10_000_000)

export const MobileAppReleaseStatusSchema = z.enum(['published', 'yanked'])

export const MobileAppReleaseSchema = z.object({
  id: z.number().int().positive(),
  versionName: MobileAppVersionSchema,
  versionCode: MobileAppVersionCodeSchema,
  /** 下载文件名（与 `/android/bin/<file>` 的最后一段一致；由上传时的原始文件名规范化而来） */
  fileName: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  status: MobileAppReleaseStatusSchema,
  /** 相对站根的下载路径，前端直接当 `<a href>`/`<img>` 用 */
  path: z.string().min(1).max(2048),
  uploadedAt: IsoDateTimeSchema,
})
export type MobileAppRelease = z.infer<typeof MobileAppReleaseSchema>

/** `GET /api/admin/mobile/app/releases`（管理端）：当前发布 + 全部记录（新的在前） */
export const MobileAppReleaseListResponseSchema = z.object({
  current: MobileAppReleaseSchema.nullable(),
  items: z.array(MobileAppReleaseSchema),
  /** 管理端「系统设置 → 容器」之外的 App 版本地板；清空/恢复默认仍走 `/api/admin/settings` */
  settings: z.object({
    minVersionCode: z.number().int().min(1),
    latestVersionCode: z.number().int().min(1),
    downloadUrl: z.string().nullable(),
  }),
})
export type MobileAppReleaseListResponse = z.infer<typeof MobileAppReleaseListResponseSchema>

/** `POST /api/admin/mobile/app/rollback`：不给 releaseId 时回到上一版（versionCode 次高） */
export const MobileAppRollbackRequestSchema = z.object({
  releaseId: z.number().int().positive().optional(),
})
export type MobileAppRollbackRequest = z.infer<typeof MobileAppRollbackRequestSchema>

export const MobileAppRollbackResponseSchema = z.object({
  release: MobileAppReleaseSchema,
  yanked: z.array(z.number().int().positive()),
})
export type MobileAppRollbackResponse = z.infer<typeof MobileAppRollbackResponseSchema>

/**
 * `GET /api/public/android/download`（匿名，主页右卡的数据源）。
 *
 * 没有已发布的 APK 时 `app` 为 `null`（页面显示「即将上线」），不会 404 —— 主页不该因为
 * 还没发版而报错。`url` 是相对站根的路径，`qrUrl` 是同一条地址的二维码 SVG。
 */
export const PublicAndroidDownloadResponseSchema = z.object({
  app: z
    .object({
      version: MobileAppVersionSchema,
      versionCode: MobileAppVersionCodeSchema,
      /** 版本号带预发布后缀（`0.2.1-rc.1`）：主页显示「预览版」标签 */
      prerelease: z.boolean(),
      fileName: z.string().min(1).max(200),
      bytes: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      url: z.string().min(1).max(2048),
      /**
       * WP52：同一个 APK 的全部可用地址（本入口排第一）。**可选字段**，老客户端忽略。
       * 与 `bootstrap.app.downloadMirrors` 同一份数据，主页卡片可用于「换个镜像下载」。
       */
      mirrors: z.array(z.string().min(1).max(2048)).optional(),
      publishedAt: IsoDateTimeSchema,
    })
    .nullable(),
  /** 二维码：同一条下载地址渲染成 SVG（匿名、no-store） */
  qrUrl: z.string().min(1).max(2048),
})
export type PublicAndroidDownloadResponse = z.infer<typeof PublicAndroidDownloadResponseSchema>

// ── 契约表（04 文档新增接口时同步） ─────────────────────────────────────────

export const MOBILE_APP_CONTRACT_MAP: ContractEntry[] = [
  {
    method: 'POST',
    path: '/api/admin/mobile/app/releases',
    note: 'multipart（apk + version + versionCode）；上传即发布，旧的自动 yank',
  },
  {
    method: 'GET',
    path: '/api/admin/mobile/app/releases',
    note: '当前发布 + 全部记录 + settings.mobile.app',
  },
  {
    method: 'POST',
    path: '/api/admin/mobile/app/rollback',
    note: '回到上一版（或指定 releaseId）',
  },
  {
    method: 'GET',
    path: MOBILE_ANDROID_DOWNLOAD_PATH,
    response: 'PublicAndroidDownloadResponseSchema',
    note: '匿名；没有已发布 APK 时 app=null',
  },
  {
    method: 'GET',
    path: MOBILE_ANDROID_QR_PATH,
    note: '匿名；当前下载地址的二维码（SVG，no-store）',
  },
  {
    method: 'GET',
    path: `${MOBILE_ANDROID_BIN_PREFIX}/:file`,
    note: '匿名；APK 字节（长缓存 immutable）',
  },
]
