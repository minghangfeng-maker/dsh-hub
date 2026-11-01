import type {
  MobileAppRelease,
  MobileAppRollbackRequest,
  MobileAppRollbackResponse,
  PublicAndroidDownloadResponse,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { RequestOrigin } from '../../server/public-request.js'

/** 安卓 App 发布记录（WP40r）：库里的原始行（snake_case，别的模块看不到） */
export interface MobileAppReleaseRow {
  id: number
  version_name: string
  version_code: number
  file_name: string
  bytes: number
  sha256: string
  status: 'published' | 'yanked'
  uploaded_by: number | null
  uploaded_at: string
}

/** 上传一个 APK：文件已经落在临时目录，service 负责搬进 `mobile-app/bin/` */
export interface MobileAppUploadInput {
  versionName: string
  versionCode: number
  tempFile: string
  /** 浏览器给的原始文件名（service 会规范化成安全的下载文件名） */
  originalName: string
  bytes: number
  sha256: string
  actorId: number | null
  meta: RequestMeta
}

export interface MobileAppService {
  /** 当前对外发布的 APK（没有就是 null） */
  current(): MobileAppRelease | null
  /** 全部记录（versionCode 倒序） */
  list(): MobileAppRelease[]
  /** 上传即发布：旧的那条被 yank，文件保留（回滚不用重传） */
  create(input: MobileAppUploadInput): Promise<MobileAppRelease>
  /** 回滚到上一版（或指到 releaseId） */
  rollback(input: MobileAppRollbackRequest, actorId: number | null, meta: RequestMeta): MobileAppRollbackResponse
  /** 主页右卡（匿名）：当前 APK + 二维码地址（`origin` = 本请求入口，决定 url 与 mirrors） */
  publicDownload(ip: string | null, origin: RequestOrigin): PublicAndroidDownloadResponse
  /** 当前下载地址的二维码 SVG（匿名）；没有发布记录时 404 */
  qrSvg(origin: RequestOrigin): string
  /** `/android/bin/:file`：只认库里登记过的文件名 */
  apkFile(file: string): { filePath: string; fileName: string; bytes: number; sha256: string }
  /** `bootstrap.app.downloadUrl`：绝对地址（没有发布记录时为 null；按请求入口取） */
  downloadUrl(origin: RequestOrigin): string | null
  /** `bootstrap.app.downloadMirrors`：同一个 APK 的全部可用地址，本入口第一（WP52） */
  downloadMirrors(origin: RequestOrigin): string[]
  /** `bootstrap.app.latestVersionCode`：当前发布记录的 versionCode（没有就是 null） */
  latestVersionCode(): number | null
}
