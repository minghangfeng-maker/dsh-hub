import { z } from 'zod'
import { StrategySchema, TargetsSchema } from '../common.js'
import { JobRefSchema } from './jobs.js'

export const RolloutKindSchema = z.enum(['plugin', 'runtime', 'models'])
export type RolloutKind = z.infer<typeof RolloutKindSchema>

export const RolloutActionSchema = z.enum(['install', 'upgrade', 'uninstall', 'apply-config'])
export type RolloutAction = z.infer<typeof RolloutActionSchema>

/** 插件下发（01 §5.2） */
export const PluginRolloutRequestSchema = z.object({
  kind: z.literal('plugin'),
  action: RolloutActionSchema,
  pluginId: z.number().int().positive(),
  versionId: z.number().int().positive().optional(),
  targets: TargetsSchema,
  strategy: StrategySchema,
})
export type PluginRolloutRequest = z.infer<typeof PluginRolloutRequestSchema>

/** DSH 版本下发（01 §5.3） */
export const RuntimeRolloutRequestSchema = z.object({
  kind: z.literal('runtime'),
  runtimeId: z.number().int().positive(),
  targets: TargetsSchema,
  strategy: StrategySchema,
})
export type RuntimeRolloutRequest = z.infer<typeof RuntimeRolloutRequestSchema>

/** 模型配置下发（06 §4.3） */
export const ModelsRolloutRequestSchema = z.object({
  kind: z.literal('models'),
  presetId: z.number().int().positive().optional(),
  targets: TargetsSchema,
  strategy: StrategySchema,
})
export type ModelsRolloutRequest = z.infer<typeof ModelsRolloutRequestSchema>

export const RolloutRequestSchema = z.discriminatedUnion('kind', [
  PluginRolloutRequestSchema,
  RuntimeRolloutRequestSchema,
  ModelsRolloutRequestSchema,
])
export type RolloutRequest = z.infer<typeof RolloutRequestSchema>

// ── POST /api/admin/rollouts/preview ────────────────────────────────────────

export const RolloutPreviewRequestSchema = RolloutRequestSchema
export type RolloutPreviewRequest = z.infer<typeof RolloutPreviewRequestSchema>

export const RolloutPreviewItemSchema = z.object({
  userId: z.number().int(),
  username: z.string(),
  /** 当前状态描述，如 `0.15.0` / `未安装` */
  current: z.string(),
  /** 执行后的期望状态 */
  after: z.string(),
  willRestart: z.boolean(),
})
export type RolloutPreviewItem = z.infer<typeof RolloutPreviewItemSchema>

export const RolloutPreviewResponseSchema = z.object({
  targets: z.array(RolloutPreviewItemSchema),
  total: z.number().int(),
})
export type RolloutPreviewResponse = z.infer<typeof RolloutPreviewResponseSchema>

// ── POST /api/admin/rollouts ────────────────────────────────────────────────

export const RolloutCreatedResponseSchema = JobRefSchema
export type RolloutCreatedResponse = z.infer<typeof RolloutCreatedResponseSchema>
