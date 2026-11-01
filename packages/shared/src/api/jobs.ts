import { z } from 'zod'
import { IsoDateTimeSchema, PageQuerySchema, pagedOf } from '../common.js'

/** 任务类型（03 §1.3 jobs.type） */
export const JobTypeSchema = z.enum([
  'export',
  'runtime.build',
  'rollout.plugin',
  'rollout.runtime',
  'rollout.models',
  'instance.recreate',
  /** 18 §4.2：Claude Code / Codex 模式下发（装插件 + 应用 env） */
  'rollout.agent-mode',
])
export type JobType = z.infer<typeof JobTypeSchema>

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'partial',
  'canceled',
])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const JobTaskStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
])
export type JobTaskStatus = z.infer<typeof JobTaskStatusSchema>

/** 202 响应里的任务引用（`{ jobId }`） */
export const JobRefSchema = z.object({ jobId: z.number().int() })
export type JobRef = z.infer<typeof JobRefSchema>

export const JobSummarySchema = z.object({
  id: z.number().int(),
  type: JobTypeSchema.or(z.string()),
  title: z.string(),
  status: JobStatusSchema,
  total: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  createdBy: z.number().int().nullable(),
  createdByUsername: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  error: z.string().nullable(),
})
export type JobSummary = z.infer<typeof JobSummarySchema>

export const JobTaskSummarySchema = z.object({
  id: z.number().int(),
  seq: z.number().int(),
  userId: z.number().int().nullable(),
  username: z.string().nullable(),
  status: JobTaskStatusSchema,
  attempt: z.number().int(),
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  error: z.string().nullable(),
})
export type JobTaskSummary = z.infer<typeof JobTaskSummarySchema>

// ── GET /api/admin/jobs ─────────────────────────────────────────────────────

export const JobListQuerySchema = PageQuerySchema.extend({
  type: JobTypeSchema.optional(),
  status: JobStatusSchema.optional(),
})
export type JobListQuery = z.infer<typeof JobListQuerySchema>

export const JobListResponseSchema = pagedOf(JobSummarySchema)
export type JobListResponse = z.infer<typeof JobListResponseSchema>

// ── GET /api/admin/jobs/:id ─────────────────────────────────────────────────

export const JobDetailResponseSchema = z.object({
  job: JobSummarySchema,
  tasks: z.array(JobTaskSummarySchema),
})
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>

// ── GET /api/admin/jobs/:id/tasks/:taskId/log ───────────────────────────────

export const JobTaskLogResponseSchema = z.object({ text: z.string() })
export type JobTaskLogResponse = z.infer<typeof JobTaskLogResponseSchema>

// ── POST /api/admin/jobs/:id/{pause|resume|cancel|retry-failed} ─────────────

export const JobActionSchema = z.enum(['pause', 'resume', 'cancel', 'retry-failed'])
export type JobAction = z.infer<typeof JobActionSchema>

// ── GET /api/admin/jobs/:id/events（SSE） ───────────────────────────────────

export const JobEventSchema = z.object({ job: JobSummarySchema })
export type JobEvent = z.infer<typeof JobEventSchema>

export const JobTaskEventSchema = z.object({ task: JobTaskSummarySchema })
export type JobTaskEvent = z.infer<typeof JobTaskEventSchema>

export const JobLogEventSchema = z.object({ taskId: z.number().int(), chunk: z.string() })
export type JobLogEvent = z.infer<typeof JobLogEventSchema>
