import type {
  JobListQuery,
  JobListResponse,
  JobStatus,
  JobSummary,
  JobTaskStatus,
  Strategy,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'

/**
 * 任务执行上下文（06 §5.2）：handler 用它写日志、看取消信号、报进度。
 * 日志块由引擎按 200ms 合并后推 SSE。
 */
export interface TaskContext {
  log(line: string): void
  signal: AbortSignal
  progress(p: { done?: number; total?: number; message?: string }): void
}

/** job_tasks 行（03 §1.3 + WP4 补的 payload_json） */
export interface JobTaskRow {
  id: number
  jobId: number
  seq: number
  userId: number | null
  /** 用户的 username（列表/详情展示用，用户被删时为空） */
  username: string | null
  status: JobTaskStatus
  attempt: number
  log: string
  resultJson: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  /** 建任务时写入的每任务参数（plan() 的 payload） */
  payload: unknown
}

/** 任务类型处理器（06 §5.2）：`export`、`runtime.build`、`rollout.*`、`instance.recreate` 各一个 */
export interface JobHandler<P = unknown> {
  type: string
  /** 规划阶段：产出标题与任务列表（金丝雀用户排在前面） */
  plan(params: P): Promise<{ title: string; tasks: { userId: number | null; payload?: unknown }[] }>
  /** 执行单个任务；抛错 = 失败（引擎记录 error 并按策略暂停） */
  runTask(ctx: TaskContext, task: JobTaskRow, params: P): Promise<unknown>
  /**
   * 该类型任务的并发上限（WP4 补充：导出用 `capacity.maxConcurrentExports`）。
   * 不实现则只受全局并发与 strategy.concurrency 限制。
   */
  maxConcurrent?(): number
}

export interface CreateJobInput<P = unknown> {
  type: string
  /** 不给则用 handler.plan() 返回的标题 */
  title?: string
  params: P
  strategy?: Partial<Strategy>
  createdBy?: number | null
  /** 直接给任务列表（不给则调 handler.plan） */
  tasks?: { userId: number | null; payload?: unknown }[]
}

/** 概览接口的 `jobs` 字段（04 §4.1） */
export interface JobsOverviewCounts {
  running: number
  queued: number
  failedLast24h: number
}

/**
 * 任务引擎（06 §5.2；WP4 实现）。
 * 持久化在 jobs/job_tasks；全局并发 4；每用户同一时刻只有一个 task（复用 withUserLock）；
 * Hub 重启后 running → failed('hub restarted')、job → paused。
 */
export interface JobService {
  /** 建 job + tasks（金丝雀在前）并入队 */
  create<P>(input: CreateJobInput<P>): Promise<JobSummary>
  list(query: JobListQuery): Promise<JobListResponse>
  /**
   * 最近 N 个某类型的任务（带创建时的 params）。18 §4.3 用它找「最近一次某模式的下发任务」：
   * 同一类型下两个模式共用 `rollout.agent-mode`，必须看 params.mode 才能分辨。
   */
  listWithParams(type: string, limit: number): Promise<{ job: JobSummary; params: unknown }[]>
  get(jobId: number): Promise<{ job: JobSummary; tasks: JobTaskRow[] }>
  taskLog(jobId: number, taskId: number): Promise<string>
  pause(jobId: number, meta: RequestMeta, actorId?: number | null): Promise<JobSummary>
  resume(jobId: number, meta: RequestMeta, actorId?: number | null): Promise<JobSummary>
  cancel(jobId: number, meta: RequestMeta, actorId?: number | null): Promise<JobSummary>
  /** 失败 task 重置为 pending，job 回 running（attempt 在下次开始时 +1） */
  retryFailed(jobId: number, meta: RequestMeta, actorId?: number | null): Promise<JobSummary>
  registerHandler<P>(handler: JobHandler<P>): void
  /** 启动调度循环（jobs 插件注册时调用一次） */
  start(): void
  /** 优雅停止：等当前 task 收尾（超过宽限期则发 AbortSignal） */
  stop(): Promise<void>
  /** Hub 重启后的恢复：把 running 的 task 标失败、job 置 paused */
  recoverAfterRestart(): Promise<{ failedTasks: number; pausedJobs: number }>
  /** 某状态的任务数（概览页用） */
  countByStatus(status: JobStatus): number
  /** 概览页的 jobs 字段（running/queued/failedLast24h，04 §4.1，WP1 的 overview 调它） */
  overviewCounts(): JobsOverviewCounts
}
