import { z } from 'zod'
import { IsoDateTimeSchema } from '../common.js'
import { JobStatusSchema } from './jobs.js'
import { RelayAgentModeSchema, RelayScopeSchema } from './relay.js'
import { PluginPolicySchema } from './plugins.js'

/**
 * Claude Code 与 Codex 管理（18）：管理员在两个页面里配置上游渠道、模型价格、整体倍率，
 * 开放给指定用户并下发；用户容器里的两个对话模式插件经 Hub 中转站调用，按「来源」计费。
 * 作用域与中转站共用（`RelayScopeSchema`，定义在 relay.ts，避免循环引用）。
 */

export { RelayAgentModeSchema as AgentModeSchema, RelayScopeSchema }
export type AgentMode = z.infer<typeof RelayAgentModeSchema>

/** 每个模式只用一种协议（18 D8） */
export const AGENT_MODE_API = {
  'claude-code': 'anthropic-messages',
  codex: 'openai-responses',
} as const

/** 插件库里对应的包名（18 F6） */
export const AGENT_MODE_PLUGIN_PACKAGE = {
  'claude-code': '@local/dsh-claude-pilot',
  codex: '@local/dsh-codex-pilot',
} as const

/** 界面显示名 */
export const AGENT_MODE_LABEL = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
} as const

/** 插件里显示的账号名缺省值 */
export const AGENT_MODE_DEFAULT_LABEL = 'DSH Hub'

/** 开放给谁：所有用户，或指定用户（可以为空 = 谁都没开放） */
export const AgentModeTargetsSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ userIds: z.array(z.number().int().positive()).max(1000) }),
])
export type AgentModeTargets = z.infer<typeof AgentModeTargetsSchema>

/** 整体倍率（千分比）：1000 = ×1.0；0 = 免费；最大 ×100 */
const ModeRatePermilleSchema = z.number().int().min(0).max(100_000)

/** settings 表键 `agent_modes` 里一个模式的设置（18 §2） */
export const AgentModeSettingsSchema = z.object({
  enabled: z.boolean(),
  ratePermille: ModeRatePermilleSchema,
  /** 本作用域的对外模型 id；null = 可用模型里 `sort, name` 第一个 */
  defaultModelId: z.number().int().positive().nullable(),
  /** 仅 Claude Code：后台小任务（标题、摘要）用的模型；null = 同默认模型。Codex 恒为 null */
  smallModelId: z.number().int().positive().nullable(),
  /** 插件里显示的账号名 */
  label: z.string().trim().min(1).max(32),
  targets: AgentModeTargetsSchema,
  updatedAt: IsoDateTimeSchema.nullable(),
  /** 最近一次改 enabled 或 targets 的时间（判断「待下发」用） */
  targetsUpdatedAt: IsoDateTimeSchema.nullable(),
})
export type AgentModeSettings = z.infer<typeof AgentModeSettingsSchema>

export const DEFAULT_AGENT_MODE_SETTINGS: AgentModeSettings = {
  enabled: false,
  ratePermille: 1000,
  defaultModelId: null,
  smallModelId: null,
  label: AGENT_MODE_DEFAULT_LABEL,
  targets: { userIds: [] },
  updatedAt: null,
  targetsUpdatedAt: null,
}

/**
 * 修改设置（全部可选，省略 = 不改）。
 * 注意不能用 `AgentModeSettingsSchema.partial()`：zod 4 的 partial 会给缺省字段填默认值（WP11 的坑）。
 */
export const UpdateAgentModeRequestSchema = z.object({
  enabled: z.boolean().optional(),
  ratePermille: ModeRatePermilleSchema.optional(),
  defaultModelId: z.number().int().positive().nullable().optional(),
  smallModelId: z.number().int().positive().nullable().optional(),
  label: z.string().trim().min(1).max(32).optional(),
  targets: AgentModeTargetsSchema.optional(),
})
export type UpdateAgentModeRequest = z.infer<typeof UpdateAgentModeRequestSchema>

/** 插件库里对应插件的情况；库里没有 = null */
export const AgentModePluginSchema = z.object({
  pluginId: z.number().int(),
  packageName: z.string(),
  latestVersion: z.string().nullable(),
  policy: PluginPolicySchema,
  /** 已装上（actual_version_id 非空）的用户数 */
  installedUsers: z.number().int().nonnegative(),
})
export type AgentModePlugin = z.infer<typeof AgentModePluginSchema>

/** 「默认模型」下拉用的模型摘要（本作用域） */
export const AgentModeModelOptionSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  /** 有启用渠道上的启用路由 */
  routable: z.boolean(),
})
export type AgentModeModelOption = z.infer<typeof AgentModeModelOptionSchema>

/** 用户表一行（18 §4.3） */
export const AgentModeUserSchema = z.object({
  userId: z.number().int(),
  username: z.string(),
  displayName: z.string().nullable(),
  /** 在 targets 里（false = 已被移出，但运行中容器的 env 里还有这个模式，下发后会去掉） */
  targeted: z.boolean(),
  /** 装的插件版本；没装 = null */
  pluginVersion: z.string().nullable(),
  /** 实例状态（同实例接口的 status 字符串，如 running / stopped / absent） */
  instanceStatus: z.string(),
  /**
   * 容器 env 是否已与期望一致：true = 已生效；false = 要下发（重建）；
   * null = 实例没在跑（下次启动自然生效）
   */
  envApplied: z.boolean().nullable(),
  /** 本月（Asia/Shanghai）该模式的花费（微积分） */
  monthCostMicro: z.number().int().nonnegative(),
})
export type AgentModeUser = z.infer<typeof AgentModeUserSchema>

export const AgentModeDeliverJobSchema = z.object({
  jobId: z.number().int(),
  status: JobStatusSchema,
  createdAt: IsoDateTimeSchema,
})
export type AgentModeDeliverJob = z.infer<typeof AgentModeDeliverJobSchema>

/** `GET /api/admin/agent-modes/:mode` */
export const AgentModeStateResponseSchema = z.object({
  mode: RelayAgentModeSchema,
  settings: AgentModeSettingsSchema,
  /** 兜底后实际生效的默认模型 / 小模型名（一个可用模型都没有 = null） */
  effectiveDefaultModel: z.string().nullable(),
  effectiveSmallModel: z.string().nullable(),
  plugin: AgentModePluginSchema.nullable(),
  models: z.array(AgentModeModelOptionSchema),
  users: z.array(AgentModeUserSchema),
  /** 有没下发的开通 / 开放范围变化，或有 env 未生效的运行中实例（18 §4.2） */
  pending: z.boolean(),
  /** 需要下发的用户数（envApplied === false 的用户 + 尚未下发的范围变化涉及的用户） */
  pendingUsers: z.number().int().nonnegative(),
  lastDeliver: AgentModeDeliverJobSchema.nullable(),
  /** 中文提示，如「默认模型 X 已停用，实际使用 Y」「内部监听器没开，用户容器连不上中转站」「插件库里还没有这个插件」 */
  warnings: z.array(z.string()),
})
export type AgentModeStateResponse = z.infer<typeof AgentModeStateResponseSchema>

/** `POST /api/admin/agent-modes/:mode/deliver`（需要二次密码） */
export const DeliverAgentModeRequestSchema = z.object({
  restart: z.enum(['now', 'next-start']).default('now'),
  /** targets 里没装插件的用户，自动安装插件库里的最新版本 */
  installPlugin: z.boolean().default(true),
})
export type DeliverAgentModeRequest = z.infer<typeof DeliverAgentModeRequestSchema>

// ── 插件用：GET /v1/hub/agent-mode（18 §3.4）────────────────────────────────

export const AgentModeClientModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  contextWindow: z.number().int().positive().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  reasoningEfforts: z.array(z.string()),
  defaultThinking: z.string().nullable(),
})
export type AgentModeClientModel = z.infer<typeof AgentModeClientModelSchema>

export const AgentModeClientConfigSchema = z.object({
  mode: RelayAgentModeSchema,
  label: z.string(),
  defaultModel: z.string().nullable(),
  /** 仅 Claude Code 有值；Codex 恒为 null */
  smallModel: z.string().nullable(),
  models: z.array(AgentModeClientModelSchema),
  updatedAt: IsoDateTimeSchema.nullable(),
})
export type AgentModeClientConfig = z.infer<typeof AgentModeClientConfigSchema>

// 用户端 `/api/me/relay` 的 `agentModes[]`（18 §7）：`MyAgentModeSchema` 定义在 relay.ts（MyRelayResponseSchema 要用它）
export { MyAgentModeSchema } from './relay.js'
export type { MyAgentMode } from './relay.js'
