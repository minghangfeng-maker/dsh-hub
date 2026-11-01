import type { JobStatus, JobSummary, JobType } from '@dsh-hub/shared'
import type { BaseDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { isoPlusMs } from '../../lib/clock.js'
import { withUserLock } from '../../lib/locks.js'
// 复用实例模块的日志脱敏规则（`token=***`、cookie、api key…）：失败信息可能带上游 URL/凭据
import { redactLogLine } from '../instances/readiness.js'
import * as repo from './repo.js'
import type { CreateJobInput, JobHandler, JobService, JobTaskRow, TaskContext } from './types.js'

/**
 * jobs 引擎（06 §5.2）：全局并发 4、每用户串行（`withUserLock`）、金丝雀阶段串行、
 * 失败率超阈值暂停；取消通过 `AbortSignal` 通知 handler。
 *
 * 调度是**单进程内存状态 + 数据库持久化**的组合：进程内用 `inFlight` 记账，
 * 数据库里的 `job_tasks.status` 是重启恢复的唯一依据（调度前先写 running，避免重复调度）。
 */
export interface JobEngineOptions {
  /** 全局并发上限，默认 4（06 §5.2） */
  globalConcurrency?: number
  /** 日志/事件合并窗口，默认 200ms（06 §5.2） */
  logFlushMs?: number
  /** 兜底轮询间隔，默认 1s（正常路径靠 notify() 立即调度） */
  pollMs?: number
  /** 关停时等当前任务收尾的宽限时间，默认 10s */
  stopGraceMs?: number
}

/** 任务日志单条上限（03 §1.3：超出截断头部） */
const MAX_TASK_LOG_CHARS = 256 * 1024
/** 等用户锁的最长时间：任务可能被实例重建/插件安装占用（超时按失败处理，避免永久挂住） */
const USER_LOCK_TIMEOUT_MS = 10 * 60_000

interface InFlight {
  jobId: number
  taskId: number
  userId: number | null
  type: string
  controller: AbortController
  /** 管理员取消/关停时置位：handler 正常返回也按 canceled 记 */
  aborted: boolean
  logBuffer: string
  logTimer: NodeJS.Timeout | null
  progress: { done?: number; total?: number }
  progressTimer: NodeJS.Timeout | null
  promise: Promise<void> | null
}

export function createJobEngine(deps: BaseDeps, opts: JobEngineOptions = {}): JobService {
  const globalConcurrency = Math.max(1, opts.globalConcurrency ?? 4)
  const logFlushMs = Math.max(10, opts.logFlushMs ?? 200)
  const pollMs = Math.max(50, opts.pollMs ?? 1000)
  const stopGraceMs = Math.max(0, opts.stopGraceMs ?? 10_000)

  const handlers = new Map<string, JobHandler<never>>()
  const inFlight = new Map<number, InFlight>()
  const runningUsers = new Set<number>()

  let started = false
  let stopped = false
  let tickScheduled = false
  let tickTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null

  // ── 事件 ──────────────────────────────────────────────────────────────────

  function emitJob(jobId: number): JobSummary | null {
    const job = repo.jobSummary(deps.db, jobId)
    if (job) deps.events.emit('job.updated', { job })
    return job ?? null
  }

  function emitTask(jobId: number, taskId: number): void {
    const task = repo.taskSummary(deps.db, taskId)
    if (task) deps.events.emit('job.task', { jobId, task })
  }

  function requireSummary(jobId: number): JobSummary {
    const job = repo.jobSummary(deps.db, jobId)
    if (!job) throw new HubError('NOT_FOUND', '任务不存在')
    return job
  }

  // ── 日志 / 进度（200ms 合并） ─────────────────────────────────────────────

  function flushLog(entry: InFlight): void {
    if (entry.logTimer) {
      clearTimeout(entry.logTimer)
      entry.logTimer = null
    }
    const chunk = entry.logBuffer
    entry.logBuffer = ''
    if (chunk.length === 0) return
    repo.appendTaskLog(deps.db, entry.taskId, chunk, MAX_TASK_LOG_CHARS)
    deps.events.emit('job.log', { jobId: entry.jobId, taskId: entry.taskId, chunk })
  }

  function appendLog(entry: InFlight, line: string): void {
    const text = typeof line === 'string' ? line : String(line)
    entry.logBuffer += text.endsWith('\n') ? text : `${text}\n`
    if (entry.logBuffer.length > MAX_TASK_LOG_CHARS) {
      entry.logBuffer = entry.logBuffer.slice(-MAX_TASK_LOG_CHARS)
    }
    if (entry.logTimer) return
    entry.logTimer = setTimeout(() => {
      entry.logTimer = null
      flushLog(entry)
    }, logFlushMs)
    entry.logTimer.unref?.()
  }

  function applyProgress(entry: InFlight): void {
    if (entry.progressTimer) {
      clearTimeout(entry.progressTimer)
      entry.progressTimer = null
    }
    const { done, total } = entry.progress
    if (done === undefined && total === undefined) return
    // 任务级子进度写进 job 计数（终态由任务统计覆盖，见 afterTaskFinished）
    repo.updateJob(deps.db, entry.jobId, {
      ...(done === undefined ? {} : { done }),
      ...(total === undefined ? {} : { total }),
    })
    emitJob(entry.jobId)
  }

  function createTaskContext(entry: InFlight): TaskContext {
    return {
      log: (line) => appendLog(entry, line),
      signal: entry.controller.signal,
      progress: (p) => {
        if (p.message) appendLog(entry, p.message)
        if (p.done !== undefined) entry.progress.done = p.done
        if (p.total !== undefined) entry.progress.total = p.total
        if (entry.progressTimer) return
        entry.progressTimer = setTimeout(() => {
          entry.progressTimer = null
          applyProgress(entry)
        }, logFlushMs)
        entry.progressTimer.unref?.()
      },
    }
  }

  // ── 调度 ──────────────────────────────────────────────────────────────────

  function notify(): void {
    if (stopped || !started || tickScheduled) return
    tickScheduled = true
    tickTimer = setTimeout(() => {
      tickScheduled = false
      tickTimer = null
      tick()
    }, 0)
    tickTimer.unref?.()
  }

  function countInFlight(predicate: (entry: InFlight) => boolean): number {
    let n = 0
    for (const entry of inFlight.values()) if (predicate(entry)) n += 1
    return n
  }

  function canRunUser(userId: number | null): boolean {
    return userId === null || !runningUsers.has(userId)
  }

  /** 选一个可执行的任务：金丝雀阶段串行，之后按 strategy.concurrency 与全局并发 */
  function pickTask(job: repo.JobRow): JobTaskRow | null {
    const handler = handlers.get(job.type)
    if (!handler) return null
    const maxConcurrent = handler.maxConcurrent?.()
    if (maxConcurrent !== undefined && countInFlight((e) => e.type === job.type) >= maxConcurrent) {
      return null
    }
    const tasks = repo.getTaskRows(deps.db, job.id)
    if (tasks.length === 0) return null
    const strategy = repo.parseStrategy(job.strategy_json)
    const inFlightForJob = countInFlight((e) => e.jobId === job.id)

    const canaryCount = Math.min(strategy.canary, tasks.length)
    const canaryTasks = tasks.slice(0, canaryCount)
    const canaryDone = canaryTasks.every((t) => t.status !== 'pending' && t.status !== 'running')
    if (!canaryDone) {
      // 阶段 A：金丝雀串行（同一时刻只跑一个）
      if (inFlightForJob > 0) return null
      const next = canaryTasks.find((t) => t.status === 'pending')
      if (!next || !canRunUser(next.userId)) return null
      return next
    }

    // 阶段 B：其余任务按 job 并发上限跑
    if (inFlightForJob >= strategy.concurrency) return null
    const next = tasks.slice(canaryCount).find((t) => t.status === 'pending' && canRunUser(t.userId))
    return next ?? null
  }

  function tick(): void {
    if (stopped) return
    let launched = true
    while (launched && inFlight.size < globalConcurrency) {
      launched = false
      for (const job of repo.listActiveJobRows(deps.db)) {
        if (inFlight.size >= globalConcurrency) break
        const task = pickTask(job)
        if (!task) continue
        launch(job, task)
        launched = true
      }
    }
  }

  function launch(job: repo.JobRow, task: JobTaskRow): void {
    const handler = handlers.get(job.type)
    if (!handler) return
    const now = deps.clock.nowIso()
    // 先落库 running 再执行：重启时才能正确恢复，也避免同一 task 被重复调度
    repo.updateTask(deps.db, task.id, {
      status: 'running',
      attempt: task.attempt + 1,
      startedAt: now,
      finishedAt: null,
      error: null,
    })
    if (job.status === 'queued') {
      repo.updateJob(deps.db, job.id, { status: 'running', startedAt: job.started_at ?? now })
      emitJob(job.id)
    }
    emitTask(job.id, task.id)

    const entry: InFlight = {
      jobId: job.id,
      taskId: task.id,
      userId: task.userId,
      type: job.type,
      controller: new AbortController(),
      aborted: false,
      logBuffer: '',
      logTimer: null,
      progress: {},
      progressTimer: null,
      promise: null,
    }
    inFlight.set(task.id, entry)
    if (task.userId !== null) runningUsers.add(task.userId)
    const runningTask: JobTaskRow = { ...task, status: 'running', attempt: task.attempt + 1 }
    entry.promise = runEntry(entry, job, runningTask, handler)
    void entry.promise
  }

  async function runEntry(
    entry: InFlight,
    job: repo.JobRow,
    task: JobTaskRow,
    handler: JobHandler<never>,
  ): Promise<void> {
    const params = repo.parseJsonColumn(job.params_json)
    const ctx = createTaskContext(entry)
    let outcome: 'succeeded' | 'failed' | 'canceled' = 'succeeded'
    let error: string | null = null
    let result: unknown = null
    try {
      const run = async (): Promise<void> => {
        // 等锁期间被取消：不要再进 handler（已经没意义，且可能改坏数据）
        if (entry.controller.signal.aborted) throw abortError()
        result = await handler.runTask(ctx, task, params as never)
      }
      if (entry.userId !== null) {
        await withUserLock(entry.userId, run, { timeoutMs: USER_LOCK_TIMEOUT_MS })
      } else {
        await run()
      }
    } catch (err) {
      if (entry.aborted || isAbortError(err)) {
        outcome = 'canceled'
      } else {
        outcome = 'failed'
        error = errorText(err)
        // WP8b B3：失败原因只写 `job_tasks.error` 的话，任务日志里看不到收尾；
        // 引擎统一在日志末尾补一行（脱敏后），管理员不必再去别处找原因。
        appendLog(entry, `✗ 失败：${redactLogLine(error)}`)
      }
    } finally {
      // 已取消/关停：handler 即使正常返回也按 canceled 记（job 已经是 canceled 状态）
      if (entry.aborted) outcome = 'canceled'
      if (entry.progressTimer) {
        clearTimeout(entry.progressTimer)
        entry.progressTimer = null
      }
      flushLog(entry)
      inFlight.delete(entry.taskId)
      if (entry.userId !== null) runningUsers.delete(entry.userId)
    }

    const now = deps.clock.nowIso()
    repo.updateTask(deps.db, entry.taskId, {
      status: outcome,
      finishedAt: now,
      error,
      resultJson: result === undefined || result === null ? null : safeJson(result),
    })
    emitTask(entry.jobId, entry.taskId)
    afterTaskFinished(entry.jobId)
    notify()
  }

  /** 一个任务结束后：更新计数 → 判失败策略 → 收尾或暂停 */
  function afterTaskFinished(jobId: number): void {
    const counts = repo.countTasks(deps.db, jobId)
    repo.updateJob(deps.db, jobId, { done: counts.succeeded, failed: counts.failed })
    const job = repo.getJobRow(deps.db, jobId)
    if (!job) return

    if (job.status === 'canceled' || job.status === 'paused') {
      maybeFinalize(job)
      emitJob(jobId)
      return
    }

    if (counts.failed > 0) {
      const strategy = repo.parseStrategy(job.strategy_json)
      const canaryFailed =
        strategy.canary > 0 &&
        repo.getTaskRows(deps.db, jobId).some((t) => t.seq <= strategy.canary && t.status === 'failed')
      if (canaryFailed) {
        pauseJob(job, '金丝雀任务失败，已暂停等待处理')
        return
      }
      if (counts.pending > 0 && counts.failed / Math.max(1, counts.total) > strategy.maxFailureRatio) {
        const ratio = (counts.failed / Math.max(1, counts.total)).toFixed(2)
        pauseJob(job, `失败率 ${ratio} 超过阈值 ${strategy.maxFailureRatio}，已暂停`)
        return
      }
    }

    maybeFinalize(job)
    emitJob(jobId)
  }

  function pauseJob(job: repo.JobRow, reason: string): void {
    repo.updateJob(deps.db, job.id, { status: 'paused', error: reason })
    deps.events.emit('job.updated', { job: requireSummary(job.id) })
  }

  /** 没有 pending/running 任务且没有在飞任务时收尾（paused 除外：等管理员 resume/cancel） */
  function maybeFinalize(job: repo.JobRow): JobSummary | null {
    const counts = repo.countTasks(deps.db, job.id)
    if (counts.pending > 0 || counts.running > 0) return null
    if (countInFlight((e) => e.jobId === job.id) > 0) return null
    if (job.status === 'paused') return null

    const now = deps.clock.nowIso()
    if (job.status === 'canceled') {
      repo.updateJob(deps.db, job.id, {
        status: 'canceled',
        done: counts.succeeded,
        failed: counts.failed,
        finishedAt: job.finished_at ?? now,
      })
      return requireSummary(job.id)
    }

    const status: JobStatus = counts.failed > 0 ? (counts.succeeded > 0 ? 'partial' : 'failed') : 'succeeded'
    repo.updateJob(deps.db, job.id, {
      status,
      done: counts.succeeded,
      failed: counts.failed,
      finishedAt: now,
      error: counts.failed > 0 ? `${counts.failed}/${counts.total} 个任务失败` : null,
    })
    return requireSummary(job.id)
  }

  /** 启动时收尾：进程在「任务已结束、job 未收尾」之间崩溃时会留下 running 但无在飞任务的 job */
  function finalizeStrandedJobs(): void {
    for (const job of repo.listActiveJobRows(deps.db)) {
      const counts = repo.countTasks(deps.db, job.id)
      if (counts.pending > 0) continue
      maybeFinalize(job)
      notify()
    }
  }

  // ── JobService ────────────────────────────────────────────────────────────

  const service: JobService = {
    registerHandler(handler) {
      if (!handler?.type) throw new HubError('INTERNAL', '任务处理器必须有 type')
      handlers.set(handler.type, handler as JobHandler<never>)
    },

    async create<P>(input: CreateJobInput<P>): Promise<JobSummary> {
      const handler = handlers.get(input.type)
      if (!handler) throw new HubError('INTERNAL', `未注册的任务类型：${input.type}`)

      let title = input.title
      let tasks = input.tasks
      if (!tasks) {
        const planned = await handler.plan(input.params as never)
        title = title ?? planned.title
        tasks = planned.tasks
      }
      const strategy = repo.parseStrategy(JSON.stringify({ ...repo.DEFAULT_STRATEGY, ...input.strategy }))
      const now = deps.clock.nowIso()
      const jobId = repo.insertJob(deps.db, {
        type: input.type,
        title: title ?? input.type,
        status: 'queued',
        params: input.params ?? null,
        strategy,
        total: tasks.length,
        createdBy: input.createdBy ?? null,
        createdAt: now,
      })
      repo.insertTasks(deps.db, jobId, tasks)

      if (tasks.length === 0) {
        repo.updateJob(deps.db, jobId, { status: 'succeeded', startedAt: now, finishedAt: now })
      }
      const summary = requireSummary(jobId)
      deps.events.emit('job.updated', { job: summary })
      if (tasks.length > 0) notify()
      return summary
    },

    async list(query) {
      const { items, total } = repo.listJobs(deps.db, query)
      return { items, total, page: query.page, pageSize: query.pageSize }
    },

    async listWithParams(type, limit) {
      const pageSize = Math.min(100, Math.max(1, Math.trunc(limit)))
      const page = repo.listJobs(deps.db, { type: type as JobType, page: 1, pageSize })
      return page.items.map((job) => {
        const row = repo.getJobRow(deps.db, job.id)
        let params: unknown = null
        if (row?.params_json) {
          try {
            params = JSON.parse(row.params_json) as unknown
          } catch {
            params = null
          }
        }
        return { job, params }
      })
    },

    async get(jobId) {
      const job = requireSummary(jobId)
      return { job, tasks: repo.getTaskRows(deps.db, jobId) }
    },

    async taskLog(jobId, taskId) {
      const task = repo.getTaskRow(deps.db, jobId, taskId)
      if (!task) throw new HubError('NOT_FOUND', '任务项不存在')
      return task.log
    },

    async pause(jobId, meta, actorId) {
      const job = repo.requireJobRow(deps.db, jobId)
      if (job.status !== 'queued' && job.status !== 'running') {
        throw new HubError('CONFLICT', '任务当前状态不能暂停')
      }
      repo.updateJob(deps.db, jobId, { status: 'paused', error: job.error ?? '管理员暂停' })
      audit(actorId, meta, 'job.pause', jobId)
      return emitJob(jobId) ?? requireSummary(jobId)
    },

    async resume(jobId, meta, actorId) {
      const job = repo.requireJobRow(deps.db, jobId)
      if (job.status !== 'paused') throw new HubError('CONFLICT', '任务当前状态不能恢复')
      repo.updateJob(deps.db, jobId, {
        status: 'running',
        error: null,
        finishedAt: null,
        startedAt: job.started_at ?? deps.clock.nowIso(),
      })
      audit(actorId, meta, 'job.resume', jobId)
      const counts = repo.countTasks(deps.db, jobId)
      if (counts.pending === 0 && countInFlight((e) => e.jobId === jobId) === 0) {
        // 已经没有可跑的任务（例如重启恢复后全部失败）：直接按实际结果收尾
        maybeFinalize(repo.requireJobRow(deps.db, jobId))
      } else {
        notify()
      }
      return emitJob(jobId) ?? requireSummary(jobId)
    },

    async cancel(jobId, meta, actorId) {
      const job = repo.requireJobRow(deps.db, jobId)
      if (isTerminal(job.status)) throw new HubError('CONFLICT', '任务已结束，不能取消')
      const now = deps.clock.nowIso()
      repo.updateJob(deps.db, jobId, { status: 'canceled', finishedAt: now, error: '已取消' })
      for (const task of repo.listTaskRowsByStatus(deps.db, jobId, 'pending')) {
        repo.updateTask(deps.db, task.id, { status: 'canceled', finishedAt: now, error: '已取消' })
        emitTask(jobId, task.id)
      }
      for (const entry of inFlight.values()) {
        if (entry.jobId !== jobId) continue
        entry.aborted = true
        entry.controller.abort(new Error('job canceled'))
      }
      audit(actorId, meta, 'job.cancel', jobId)
      const latest = repo.requireJobRow(deps.db, jobId)
      if (repo.countTasks(deps.db, jobId).running === 0) maybeFinalize(latest)
      return emitJob(jobId) ?? requireSummary(jobId)
    },

    async retryFailed(jobId, meta, actorId) {
      const job = repo.requireJobRow(deps.db, jobId)
      const failed = repo.listTaskRowsByStatus(deps.db, jobId, 'failed')
      if (failed.length === 0) throw new HubError('CONFLICT', '没有失败的任务项')
      if (job.status === 'canceled') throw new HubError('CONFLICT', '任务已取消，不能重试')
      deps.db.tx(() => {
        for (const task of failed) {
          repo.updateTask(deps.db, task.id, {
            status: 'pending',
            startedAt: null,
            finishedAt: null,
            error: null,
            resultJson: null,
          })
          emitTask(jobId, task.id)
        }
        repo.updateJob(deps.db, jobId, {
          status: 'running',
          error: null,
          finishedAt: null,
          startedAt: job.started_at ?? deps.clock.nowIso(),
        })
      })
      audit(actorId, meta, 'job.retry', jobId)
      notify()
      return emitJob(jobId) ?? requireSummary(jobId)
    },

    start() {
      if (started) return
      started = true
      stopped = false
      pollTimer = setInterval(() => tick(), pollMs)
      pollTimer.unref?.()
      finalizeStrandedJobs()
      tick()
    },

    async stop() {
      if (stopped) return
      stopped = true
      if (tickTimer) {
        clearTimeout(tickTimer)
        tickTimer = null
        tickScheduled = false
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      await waitForInFlight(stopGraceMs)
      if (inFlight.size > 0) {
        // 宽限期内没收尾：通知 handler 收尾，再给一小段时间
        for (const entry of inFlight.values()) {
          entry.aborted = true
          entry.controller.abort(new Error('hub shutting down'))
        }
        await waitForInFlight(1000)
      }
      for (const entry of inFlight.values()) flushLog(entry)
    },

    async recoverAfterRestart() {
      return repo.recoverRunningJobs(deps.db, deps.clock.nowIso())
    },

    countByStatus(status) {
      return repo.countJobsByStatus(deps.db, status)
    },

    overviewCounts() {
      return {
        running: repo.countJobsByStatus(deps.db, 'running'),
        queued: repo.countJobsByStatus(deps.db, 'queued'),
        failedLast24h: repo.countFailedSince(deps.db, isoPlusMs(deps.clock.nowIso(), -24 * 3600_000)),
      }
    },
  }

  function audit(
    actorId: number | null | undefined,
    meta: RequestMeta | undefined,
    action: string,
    jobId: number,
  ): void {
    deps.audit.log({
      actorId: actorId ?? null,
      actorIp: meta?.ip ?? null,
      action,
      targetType: 'job',
      targetId: jobId,
    })
  }

  async function waitForInFlight(timeoutMs: number): Promise<void> {
    const pending = [...inFlight.values()].map((e) => e.promise).filter((p): p is Promise<void> => !!p)
    if (pending.length === 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
      void Promise.allSettled(pending).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return service
}

function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'canceled'
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: string }).name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR')
  )
}

function errorText(error: unknown): string {
  if (HubError.is(error)) return error.message
  if (error instanceof Error) return error.message.slice(0, 2000)
  return String(error).slice(0, 2000)
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}
