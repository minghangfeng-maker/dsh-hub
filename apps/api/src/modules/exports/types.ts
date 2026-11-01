import type {
  CreateExportRequest,
  CreateExportResponse,
  ExportEstimateResponse,
  ExportFormat,
  ExportItem,
  ExportListResponse,
  ExportPart,
  ExportProgress,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { JobService } from '../jobs/types.js'
import type { TaskContext } from '../jobs/types.js'

export interface ExportFileRef {
  /** 绝对路径（宿主卷上的文件） */
  path: string
  fileName: string
  sizeBytes: number
  /** 下载响应头用 */
  mimeType: string
  /** 整包 sha256（hex），下载响应头 `X-Hub-Sha256` 用 */
  sha256: string | null
}

/** `export` 类型 job 的参数（也是每 task 的 payload） */
export interface ExportJobParams {
  exportId: number
  userId: number
  /** 用户 slug（算 `users/<slug>/...` 路径用；创建时固化，避免用户改名影响） */
  slug: string
  fileName: string
  /** 归档根目录名（与 fileName 同一时间戳，如 `dsh-user-20261012-2130`） */
  root: string
  parts: ExportPart[]
  format: ExportFormat
  /** 生成 manifest 用；取不到时为 null */
  dshVersion?: string | null
}

export interface ExportRunResult {
  exportId: number
  fileName: string
  sizeBytes: number
  sha256: string
}

/** 打包时的进度上报（与 jobs 的 TaskContext 同形，便于 handler 直接转交） */
export type ExportTaskContext = TaskContext

/**
 * 数据导出服务（04 §3.3、06 §6；WP4 实现）。
 * 读宿主卷不进容器；不跟随符号链接；永远排除 `.credentials.yaml`/`.env`/`node_modules`/缓存；
 * 打包时持该用户的读锁（`withUserLock`，由 jobs 引擎在 task 上保证），避免与插件安装同时改 profile。
 */
export interface ExportService {
  /** `?parts=workspace,sessions` 的 du 估算（缓存 60s） */
  estimate(userId: number, parts: ExportPart[]): Promise<ExportEstimateResponse>
  /** 建 export 行 + `export` 类型 job（每用户串行、全局并发 2） */
  create(userId: number, input: CreateExportRequest, meta?: RequestMeta): Promise<CreateExportResponse>
  /** 最近 20 条 */
  list(userId: number): Promise<ExportListResponse>
  get(userId: number, exportId: number): Promise<ExportItem | null>
  /** 下载（校验归属、更新 downloaded 与审计、返回文件元信息） */
  fileFor(userId: number, exportId: number, meta?: RequestMeta): Promise<ExportFileRef | null>
  remove(userId: number, exportId: number): Promise<void>
  /** 每小时：过期导出删文件并置 expired（返回清理条数） */
  cleanupExpired(): Promise<number>
  /** 由 exports 插件注入任务引擎（模块间只通过 `deps.services.<other>` 调用，01 §4） */
  bindJobs(jobs: JobService): void
  /** `export` job 的执行体（单 task）：遍历计数 → 打包 → 原子落盘 → 更新记录 */
  run(params: ExportJobParams, ctx: ExportTaskContext): Promise<ExportRunResult>
  /** 当前内存中的打包进度（列表/SSE 用；没有则 null） */
  progressOf(exportId: number): ExportProgress | null
}
