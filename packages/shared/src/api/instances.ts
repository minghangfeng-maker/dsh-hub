import { z } from 'zod'
import { IsoDateTimeSchema, ModelPolicySchema } from '../common.js'
import { ComputeLeaseSchema } from './compute.js'
import {
  InstanceStatusSchema,
  InstanceStatsSchema,
  InstanceSummarySchema,
  QuotaSchema,
  UserRefSchema,
} from '../common.js'

// ── POST /api/me/instance/{start|stop|restart} ──────────────────────────────

export const InstanceActionSchema = z.enum(['start', 'stop', 'restart', 'recreate'])
export type InstanceAction = z.infer<typeof InstanceActionSchema>

export const InstanceActionResponseSchema = z.object({ instance: InstanceSummarySchema })
export type InstanceActionResponse = z.infer<typeof InstanceActionResponseSchema>

// ── GET /api/me/instance ────────────────────────────────────────────────────

export const MyInstanceResponseSchema = z.object({
  instance: InstanceSummarySchema,
  quota: QuotaSchema,
  stats: InstanceStatsSchema.nullable(),
  modelSummary: z.object({
    /** 04 §10.4：managed = 由管理员下发；free = 用户自己在 DSH 里配 */
    policy: ModelPolicySchema,
    preset: z.string(),
    defaultModel: z.string(),
    providers: z.array(z.string()),
  }),
})
export type MyInstanceResponse = z.infer<typeof MyInstanceResponseSchema>

// ── GET /api/me/instance/events（SSE `event: status`） ──────────────────────

export const InstancePhaseSchema = z.enum(['pulling', 'creating', 'booting', 'bootstrapping', 'ready'])
export type InstancePhase = z.infer<typeof InstancePhaseSchema>

export const InstanceStatusEventSchema = z.object({
  instance: InstanceSummarySchema,
  phase: InstancePhaseSchema.optional(),
  message: z.string().optional(),
})
export type InstanceStatusEvent = z.infer<typeof InstanceStatusEventSchema>

// ── 会话探针（docs/22 §6；WP33） ────────────────────────────────────────────

/**
 * 实例的会话状态（每分钟一轮探针，docs/22 §6.2）：
 * - `busy`：容器里有会话 `running=true`（含子代理会话）；
 * - `watching`：没有进行中的会话，但有打开的 WebSocket（有人在看）；
 * - `unattended`：既没有进行中的会话也没人看；
 * - `unknown`：探针失败，或旧版 DSH 没有 `running` 字段 → 回收沿用旧的 CPU 规则。
 */
export const InstanceProbeStateSchema = z.enum(['busy', 'watching', 'unattended', 'unknown'])
export type InstanceProbeState = z.infer<typeof InstanceProbeStateSchema>

/**
 * 管理端列表里的一行探针结果。`idleSince` / `stopAt` 由服务端按当前状态与配额算好，
 * 前端只做展示（「空闲 X 分钟（Y 分钟后休眠）」），不再自己推规则。
 */
export const InstanceProbeSchema = z.object({
  state: InstanceProbeStateSchema,
  /** 最近一次探针时间 */
  probeAt: IsoDateTimeSchema.nullable(),
  /** 进行中的会话数（`items[].running=true`）；`unknown` 时为 null */
  runningSessions: z.number().int().nonnegative().nullable(),
  /** 当前打开的代理 WebSocket 数（代理层实时值） */
  openClients: z.number().int().nonnegative(),
  /** `max(items[].updatedAt)`：最近一次用户消息推进的时间 */
  lastPromptAt: IsoDateTimeSchema.nullable(),
  lastBusyAt: IsoDateTimeSchema.nullable(),
  lastClientAt: IsoDateTimeSchema.nullable(),
  /** 空闲起点 = max(startedAt, lastBusyAt, lastPromptAt, lastClientAt) */
  idleSince: IsoDateTimeSchema.nullable(),
  /** 预计休眠时刻；null = 进行中 / 未知 / 不回收 */
  stopAt: IsoDateTimeSchema.nullable(),
})
export type InstanceProbe = z.infer<typeof InstanceProbeSchema>

// ── GET /api/admin/instances ────────────────────────────────────────────────

export const AdminInstanceRowSchema = z.object({
  user: UserRefSchema,
  instance: InstanceSummarySchema,
  stats: InstanceStatsSchema.nullable(),
  /** stats 样本的采集时刻（WP33：列表只读缓存，null = 还没有样本） */
  statsAt: IsoDateTimeSchema.nullable().optional(),
  /** 会话探针结果（WP33；停止/未知时也可能是 null） */
  probe: InstanceProbeSchema.nullable().optional(),
  /** 当前算力租约（13；计费关闭或没在跑时 null；WP17 起返回） */
  lease: ComputeLeaseSchema.nullable().optional(),
})
export type AdminInstanceRow = z.infer<typeof AdminInstanceRowSchema>

export const AdminInstanceListResponseSchema = z.array(AdminInstanceRowSchema)
export type AdminInstanceListResponse = z.infer<typeof AdminInstanceListResponseSchema>

/** `status` 过滤参数（04 §0.1） */
export const InstanceStatusFilterSchema = InstanceStatusSchema
export type InstanceStatusFilter = z.infer<typeof InstanceStatusFilterSchema>

// ── GET /api/admin/instances/:userId/logs ───────────────────────────────────

export const InstanceLogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(10_000).default(300),
})
export type InstanceLogsQuery = z.infer<typeof InstanceLogsQuerySchema>

export const InstanceLogsResponseSchema = z.object({ text: z.string() })
export type InstanceLogsResponse = z.infer<typeof InstanceLogsResponseSchema>

/** 日志流 SSE：`event: line` */
export const InstanceLogLineEventSchema = z.object({ line: z.string() })
export type InstanceLogLineEvent = z.infer<typeof InstanceLogLineEventSchema>

// ── GET /api/admin/instances/stats（docs/22 §5.3；WP33） ────────────────────

/**
 * 列表的 stats 列不再内联采集：后台采样器维护缓存，列表与这个接口都只读缓存。
 * `statsAt` = 该样本的采集时刻（null = 还没有样本）。
 */
export const AdminInstanceStatsRowSchema = z.object({
  userId: z.number().int(),
  stats: InstanceStatsSchema.nullable(),
  statsAt: IsoDateTimeSchema.nullable(),
})
export type AdminInstanceStatsRow = z.infer<typeof AdminInstanceStatsRowSchema>

export const AdminInstanceStatsResponseSchema = z.array(AdminInstanceStatsRowSchema)
export type AdminInstanceStatsResponse = z.infer<typeof AdminInstanceStatsResponseSchema>
