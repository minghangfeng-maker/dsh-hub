import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  JobDetailResponseSchema,
  JobListQuerySchema,
  JobListResponseSchema,
  JobTaskLogResponseSchema,
  type JobDetailResponse,
  type JobListResponse,
  type JobTaskLogResponse,
  type JobTaskSummary,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin } from '../../app.js'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { openSse } from '../../lib/sse.js'
import { createJobEngine } from './engine.js'
import type { JobTaskRow, JobService } from './types.js'

export * from './types.js'
export type { JobEngineOptions } from './engine.js'
export { createJobEngine } from './engine.js'

const JobParamsSchema = z.object({ id: z.coerce.number().int().positive() })
const JobTaskParamsSchema = JobParamsSchema.extend({ taskId: z.coerce.number().int().positive() })
const JobActionSchema = z.enum(['pause', 'resume', 'cancel', 'retry-failed'])

/**
 * jobs 模块（04 §4.8；WP4 实现）。前缀 `/api`：
 * `/api/admin/jobs*`（列表/详情/日志/SSE/暂停恢复取消重试）。
 * 其它模块通过 `deps.services.jobs.create(...)` 提交任务（导出、镜像构建、下发、重建）。
 */
export function jobsPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const jobs = deps.services.jobs
    // 重启恢复必须在调度循环之前：把上次进程留下的 running task 标失败、job 置 paused
    const recovered = await jobs.recoverAfterRestart()
    if (recovered.failedTasks > 0) {
      app.log.warn(
        { failedTasks: recovered.failedTasks, pausedJobs: recovered.pausedJobs },
        '检测到未正常结束的任务，已按 hub restarted 处理',
      )
    }
    jobs.start()
    app.addHook('onClose', async () => {
      await jobs.stop()
    })

    app.get('/admin/jobs', { preHandler: requireAdmin }, async (req): Promise<JobListResponse> => {
      const query = JobListQuerySchema.parse(req.query)
      return JobListResponseSchema.parse(await jobs.list(query))
    })

    app.get('/admin/jobs/:id', { preHandler: requireAdmin }, async (req): Promise<JobDetailResponse> => {
      const { id } = JobParamsSchema.parse(req.params)
      const { job, tasks } = await jobs.get(id)
      return JobDetailResponseSchema.parse({ job, tasks: tasks.map(toTaskSummary) })
    })

    app.get(
      '/admin/jobs/:id/tasks/:taskId/log',
      { preHandler: requireAdmin },
      async (req): Promise<JobTaskLogResponse> => {
        const { id, taskId } = JobTaskParamsSchema.parse(req.params)
        return JobTaskLogResponseSchema.parse({ text: await jobs.taskLog(id, taskId) })
      },
    )

    app.post('/admin/jobs/:id/:action', { preHandler: requireAdmin }, async (req) => {
      const { id } = JobParamsSchema.parse(req.params)
      const action = JobActionSchema.safeParse((req.params as { action?: string }).action)
      if (!action.success) throw new HubError('NOT_FOUND', '未知的任务操作')
      const meta = requestMeta(req)
      const actorId = req.user?.id ?? null
      switch (action.data) {
        case 'pause':
          return { job: await jobs.pause(id, meta, actorId) }
        case 'resume':
          return { job: await jobs.resume(id, meta, actorId) }
        case 'cancel':
          return { job: await jobs.cancel(id, meta, actorId) }
        case 'retry-failed':
          return { job: await jobs.retryFailed(id, meta, actorId) }
      }
    })

    app.get('/admin/jobs/:id/events', { preHandler: requireAdmin }, async (req, reply) => {
      const { id } = JobParamsSchema.parse(req.params)
      // 先取快照：任务不存在直接 404，不进入 SSE
      const { job, tasks } = await jobs.get(id)
      const stream = openSse(reply)
      stream.send('job', { job })
      for (const task of tasks) stream.send('task', { task: toTaskSummary(task) })

      const offs = [
        deps.events.on('job.updated', (payload) => {
          if (payload.job.id === id) stream.send('job', { job: payload.job })
        }),
        deps.events.on('job.task', (payload) => {
          if (payload.jobId === id) stream.send('task', { task: payload.task })
        }),
        deps.events.on('job.log', (payload) => {
          if (payload.jobId === id) stream.send('log', { taskId: payload.taskId, chunk: payload.chunk })
        }),
      ]
      const cleanup = (): void => {
        for (const off of offs) off()
      }
      reply.raw.once('close', cleanup)
      reply.raw.once('error', cleanup)
      return reply
    })
  }
}

export function createJobService(deps: BaseDeps): JobService {
  return createJobEngine(deps)
}

/** JobTaskRow（含 log/payload）→ 04 §4.8 的 JobTaskSummary */
export function toTaskSummary(task: JobTaskRow): JobTaskSummary {
  return {
    id: task.id,
    seq: task.seq,
    userId: task.userId,
    username: task.username,
    status: task.status,
    attempt: task.attempt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
  }
}
