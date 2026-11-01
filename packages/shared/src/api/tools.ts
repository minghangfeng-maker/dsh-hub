import { z } from 'zod'
import { IsoDateTimeSchema, PageQuerySchema, pagedOf } from '../common.js'

/**
 * 搜索 / 网页抓取池（14）：Hub 在中转站上提供与 DeepSeek Search/Fetch API 同格式的
 * `/v1/tools/search`、`/v1/tools/fetch`，上游是「DeepSeek 官方 + Tavily」混合渠道池；
 * 用户每月有免费次数，超出按次扣积分（钱包与中转站、算力共用）。
 *
 * 金额一律整数微积分（`*Micro`）。
 */

export const ToolKindSchema = z.enum(['search', 'fetch'])
export type ToolKind = z.infer<typeof ToolKindSchema>

/** deepseek = 原样转发到 DeepSeek `/v1/tools/{search,fetch}`；tavily = 转成 Tavily `/search`、`/extract` 再改回 DeepSeek 格式 */
export const ToolChannelKindSchema = z.enum(['deepseek', 'tavily'])
export type ToolChannelKind = z.infer<typeof ToolChannelKindSchema>

/** 各渠道类型的默认地址 */
export const TOOL_CHANNEL_DEFAULT_BASE_URL: Record<ToolChannelKind, string> = {
  deepseek: 'https://api.deepseek.com/v1/tools',
  tavily: 'https://api.tavily.com',
}

const MicroSchema = z.number().int().nonnegative()

// ── 设置（settings 表键 `relay_tools`，由 relay 模块自己读写）────────────────

export const ToolSettingsSchema = z.object({
  /** 总开关：关闭后 `/v1/tools/*` 一律 503，用户页隐藏 */
  enabled: z.boolean(),
  /** 是否把搜索/抓取下发到用户 DSH（渲染 `dsh-web-deepseek-api` 指向内部地址，14 §5） */
  deliverToDsh: z.boolean(),
  /** 每用户每自然月（Asia/Shanghai）免费次数，搜索与抓取**合计** */
  freeCallsPerMonth: z.number().int().min(0).max(100_000),
  /** 免费次数用完后每次的价格 */
  searchPriceMicro: MicroSchema,
  fetchPriceMicro: MicroSchema,
  /** 每用户每分钟最多调用次数（保护上游池） */
  perUserPerMinute: z.number().int().min(1).max(600),
  /** 一次调用最多尝试几个「渠道 × 密钥」 */
  maxAttempts: z.number().int().min(1).max(10),
  /** 429 / 5xx 后密钥冷却秒数 */
  keyCooldownSeconds: z.number().int().min(1).max(3600),
})
export type ToolSettings = z.infer<typeof ToolSettingsSchema>

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  enabled: false,
  deliverToDsh: false,
  freeCallsPerMonth: 100,
  searchPriceMicro: 10_000,
  fetchPriceMicro: 10_000,
  perUserPerMinute: 30,
  maxAttempts: 3,
  keyCooldownSeconds: 60,
}

export const ToolSettingsResponseSchema = z.object({
  settings: ToolSettingsSchema,
  /** 容器内 DSH 用的地址（内部监听器 + `/v1/tools`）；内部监听器关闭时 null */
  internalBaseUrl: z.string().nullable(),
  /** 外部工具用：`HUB_PUBLIC_ORIGIN/v1/tools` */
  publicBaseUrl: z.string(),
})
export type ToolSettingsResponse = z.infer<typeof ToolSettingsResponseSchema>

export const UpdateToolSettingsRequestSchema = z.object({
  enabled: z.boolean().optional(),
  deliverToDsh: z.boolean().optional(),
  freeCallsPerMonth: z.number().int().min(0).max(100_000).optional(),
  searchPriceMicro: MicroSchema.optional(),
  fetchPriceMicro: MicroSchema.optional(),
  perUserPerMinute: z.number().int().min(1).max(600).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  keyCooldownSeconds: z.number().int().min(1).max(3600).optional(),
})
export type UpdateToolSettingsRequest = z.infer<typeof UpdateToolSettingsRequestSchema>

// ── 渠道与密钥 ───────────────────────────────────────────────────────────────

/** auto-disabled = 上游判定密钥无效（401/403），要管理员确认后手动恢复 */
export const ToolKeyStateSchema = z.enum(['active', 'disabled', 'auto-disabled'])
export type ToolKeyState = z.infer<typeof ToolKeyStateSchema>

export const ToolChannelKeySchema = z.object({
  id: z.number().int(),
  label: z.string(),
  last4: z.string(),
  state: ToolKeyStateSchema,
  cooldownUntil: IsoDateTimeSchema.nullable(),
  /** 冷却原因：rate-limit 限流 / exhausted 额度用完（Tavily 432/433，冷却到下个月 1 日 UTC）/ error 上游 5xx 或网络；没在冷却为 null */
  cooldownReason: z.enum(['rate-limit', 'exhausted', 'error']).nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: IsoDateTimeSchema.nullable(),
  lastUsedAt: IsoDateTimeSchema.nullable(),
  /** 本自然月经这把密钥成功的调用数 */
  monthCalls: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
})
export type ToolChannelKey = z.infer<typeof ToolChannelKeySchema>

export const ToolChannelHealthSchema = z.enum(['ok', 'cooling', 'no-key', 'disabled'])
export type ToolChannelHealth = z.infer<typeof ToolChannelHealthSchema>

export const ToolChannelSchema = z.object({
  id: z.number().int(),
  kind: ToolChannelKindSchema,
  name: z.string(),
  baseUrl: z.string(),
  /** 这条渠道支持哪些工具 */
  tools: z.array(ToolKindSchema).min(1),
  /** 大的优先；同优先级按权重分流。建议 Tavily（免费）高于 DeepSeek（兜底） */
  priority: z.number().int(),
  weight: z.number().int().min(1),
  timeoutMs: z.number().int().positive(),
  proxyUrl: z.string().nullable(),
  /** 我方上游成本估算（只用于统计毛利，不影响向用户收费） */
  searchCostMicro: MicroSchema,
  fetchCostMicro: MicroSchema,
  enabled: z.boolean(),
  note: z.string(),
  keys: z.array(ToolChannelKeySchema),
  health: ToolChannelHealthSchema,
  failStreak: z.number().int().nonnegative(),
  cooldownUntil: IsoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type ToolChannel = z.infer<typeof ToolChannelSchema>

export const ToolChannelListResponseSchema = z.array(ToolChannelSchema)
export type ToolChannelListResponse = z.infer<typeof ToolChannelListResponseSchema>

export const ToolChannelResponseSchema = z.object({ channel: ToolChannelSchema })
export type ToolChannelResponse = z.infer<typeof ToolChannelResponseSchema>

export const CreateToolChannelRequestSchema = z.object({
  kind: ToolChannelKindSchema,
  name: z.string().trim().min(1).max(64),
  /** 省略 = 该类型的默认地址 */
  baseUrl: z.string().url().optional(),
  tools: z.array(ToolKindSchema).min(1).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().min(1).max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  proxyUrl: z.string().url().nullable().optional(),
  searchCostMicro: MicroSchema.optional(),
  fetchCostMicro: MicroSchema.optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).optional(),
  /** 一次贴多把（每行一把，空行忽略，重复的跳过） */
  keys: z.array(z.string().trim().min(8).max(512)).max(500).optional(),
})
export type CreateToolChannelRequest = z.infer<typeof CreateToolChannelRequestSchema>

export const UpdateToolChannelRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  baseUrl: z.string().url().optional(),
  tools: z.array(ToolKindSchema).min(1).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().min(1).max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  proxyUrl: z.string().url().nullable().optional(),
  searchCostMicro: MicroSchema.optional(),
  fetchCostMicro: MicroSchema.optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).optional(),
})
export type UpdateToolChannelRequest = z.infer<typeof UpdateToolChannelRequestSchema>

export const AddToolChannelKeysRequestSchema = z.object({
  keys: z.array(z.string().trim().min(8).max(512)).min(1).max(500),
  label: z.string().trim().max(64).optional(),
})
export type AddToolChannelKeysRequest = z.infer<typeof AddToolChannelKeysRequestSchema>

export const AddToolChannelKeysResponseSchema = z.object({
  channel: ToolChannelSchema,
  added: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
})
export type AddToolChannelKeysResponse = z.infer<typeof AddToolChannelKeysResponseSchema>

/** 改密钥：启停、改标签、`resetCooldown: true` 清除冷却与 auto-disabled */
export const UpdateToolChannelKeyRequestSchema = z.object({
  label: z.string().trim().max(64).optional(),
  state: z.enum(['active', 'disabled']).optional(),
  resetCooldown: z.boolean().optional(),
})
export type UpdateToolChannelKeyRequest = z.infer<typeof UpdateToolChannelKeyRequestSchema>

/** 测试渠道：用第一把可用密钥做一次真实搜索（query 固定为 "DeepSeek"，count=1；不计用户费用） */
export const TestToolChannelResponseSchema = z.object({
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /** 成功时的结果数；失败时 null */
  results: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
})
export type TestToolChannelResponse = z.infer<typeof TestToolChannelResponseSchema>

// ── 用量 ─────────────────────────────────────────────────────────────────────

/** ok 成功；client_error 请求本身不合法或目标页面抓不到（不换渠道、不计费）；upstream_error 所有候选都失败（不计费）；rejected 进门被拒（余额/限流/停用） */
export const ToolUsageStatusSchema = z.enum(['ok', 'client_error', 'upstream_error', 'rejected'])
export type ToolUsageStatus = z.infer<typeof ToolUsageStatusSchema>

/**
 * 调用来源（WP29）：由**凭据**决定，不由请求自述（与 `relay_usage.client_kind` 同一口径）。
 * - `desktop`：桌面设备专用密钥（`relay_keys.device_id` 非空）
 * - `docker`：容器里注入的 system 密钥（`HUB_MK_HUB`）
 * - `external`：用户自建密钥（curl / 自写脚本）
 * - `unknown`：判定不出来（密钥已删等历史数据）
 */
export const ToolUsageClientKindSchema = z.enum(['docker', 'desktop', 'external', 'unknown'])
export type ToolUsageClientKind = z.infer<typeof ToolUsageClientKindSchema>

export const ToolUsageRowSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  username: z.string(),
  tool: ToolKindSchema,
  status: ToolUsageStatusSchema,
  /** 用的是免费次数 */
  free: z.boolean(),
  costMicro: MicroSchema,
  /** 管理端才有（用户端为 null） */
  channelName: z.string().nullable(),
  upstreamCostMicro: MicroSchema.nullable(),
  attempts: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** 搜索词前 64 字或抓取的 URL（用户端只看自己的；管理端可见，用于排查） */
  summary: z.string(),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  /** 调用来源（WP29，加法字段）：管理端据此区分桌面端与容器；老 Hub 不带这个键 */
  clientKind: ToolUsageClientKindSchema.optional(),
})
export type ToolUsageRow = z.infer<typeof ToolUsageRowSchema>

export const ToolUsageQuerySchema = PageQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  tool: ToolKindSchema.optional(),
  status: ToolUsageStatusSchema.optional(),
})
export type ToolUsageQuery = z.infer<typeof ToolUsageQuerySchema>

export const ToolUsageListResponseSchema = pagedOf(ToolUsageRowSchema)
export type ToolUsageListResponse = z.infer<typeof ToolUsageListResponseSchema>

/** 管理端概览：本月按渠道、按工具 */
export const ToolOverviewResponseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    freeCalls: z.number().int().nonnegative(),
    revenueMicro: MicroSchema,
    upstreamCostMicro: MicroSchema,
  }),
  byChannel: z.array(
    z.object({
      channelId: z.number().int(),
      name: z.string(),
      kind: ToolChannelKindSchema,
      calls: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
      upstreamCostMicro: MicroSchema,
    }),
  ),
  byTool: z.array(
    z.object({
      tool: ToolKindSchema,
      calls: z.number().int().nonnegative(),
      revenueMicro: MicroSchema,
    }),
  ),
})
export type ToolOverviewResponse = z.infer<typeof ToolOverviewResponseSchema>

// ── 用户端 ───────────────────────────────────────────────────────────────────

export const MyToolsResponseSchema = z.object({
  enabled: z.boolean(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  freeCallsPerMonth: z.number().int().nonnegative(),
  freeUsed: z.number().int().nonnegative(),
  searchPriceMicro: MicroSchema,
  fetchPriceMicro: MicroSchema,
  monthCalls: z.number().int().nonnegative(),
  monthCostMicro: MicroSchema,
  /** 我的 DSH 是否已下发搜索（deliverToDsh 且已下发） */
  dshAttached: z.boolean(),
})
export type MyToolsResponse = z.infer<typeof MyToolsResponseSchema>
