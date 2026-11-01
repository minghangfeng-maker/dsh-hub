import { z } from 'zod'
import { IsoDateTimeSchema, PageQuerySchema, PlatformQuerySchema, PlatformSchema, pagedOf } from '../common.js'
import { THINKING_LEVELS, type ThinkingLevel } from '../constants.js'
import {
  ModelApiSchema,
  ModelInfoSchema,
  ModelInfoSourceSchema,
  ThinkingLevelSchema,
  type ModelInfo,
} from './models.js'
import { JobStatusSchema } from './jobs.js'

/**
 * 模型中转站（12）：上游渠道 → 对外模型（含价格与路由）→ 用户钱包（积分）→ 用户密钥 → 用量记录。
 *
 * 金额一律用整数「微积分」（`*Micro`，1 积分 = 1 元 = 1_000_000 微积分），避免浮点误差；
 * 价格单位是「微积分 / 百万 token」，即「积分/百万 token」× 1_000_000。界面负责换算显示。
 */

/** 1 积分 = 1_000_000 微积分 */
export const RELAY_MICRO_PER_POINT = 1_000_000

/** 用户密钥前缀（`sk-dsh-` + 40 位 base62） */
export const RELAY_KEY_PREFIX = 'sk-dsh-'

/** 渠道倍率默认值（千分比：1000 = ×1.0；12 §6.2） */
export const RELAY_RATE_PERMILLE_DEFAULT = 1000

/** 统计查询的最大日期跨度（天） */
export const RELAY_MAX_RANGE_DAYS = 92

/** 日期（中转站统计按 Asia/Shanghai 自然日分桶）：`2026-10-16` */
export const RelayDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')

/** 非负整数微积分 */
const MicroSchema = z.number().int().nonnegative()
/** 带符号整数微积分（余额可能因并发略微为负；流水有正有负） */
const SignedMicroSchema = z.number().int()
/** 渠道倍率（千分比）：0 = 免费，1000 = ×1.0，最大 ×100 */
const RatePermilleSchema = z.number().int().min(0).max(100_000)

/**
 * 作用域（18 D3）：`dsh` = 原中转站（DSH 自己的模型，「模型」页）；`claude-code` / `codex` = 两个对话模式各自的渠道、模型、密钥与用量。
 * 渠道、对外模型、system 密钥、用量记录各属一个作用域；路由只能连同作用域的模型与渠道。
 */
export const RelayScopeSchema = z.enum(['dsh', 'claude-code', 'codex'])
export type RelayScope = z.infer<typeof RelayScopeSchema>

/** 对话模式（= 除 dsh 以外的作用域） */
export const RelayAgentModeSchema = z.enum(['claude-code', 'codex'])
export type RelayAgentMode = z.infer<typeof RelayAgentModeSchema>

/** 渠道 / 模型列表的作用域筛选（缺省 dsh，老前端行为不变） */
export const RelayScopeQuerySchema = z.object({ scope: RelayScopeSchema.default('dsh') })
export type RelayScopeQuery = z.infer<typeof RelayScopeQuerySchema>

// ── 设置（settings 表键 `relay`，由中转站自己的接口读写）──────────────────

export const RelaySettingsSchema = z.object({
  /** 总开关：关闭后 /v1 一律 503，用户页隐藏 */
  enabled: z.boolean(),
  /** 新注册用户赠送（微积分） */
  signupBonusMicro: MicroSchema,
  /**
   * 每日赠送（微积分；0 = 关闭，13 §2）：每个 Asia/Shanghai 自然日首次登录 / 打开 Hub 时发放，
   * **不累计**——次日发放前先把前一天没用完的部分作废（`expire` 流水）。
   */
  dailyBonusMicro: MicroSchema,
  /** 每用户同时进行的请求数（钱包没单独设时用它） */
  defaultMaxConcurrency: z.number().int().min(1).max(64),
  /** 一次请求最多尝试几个「渠道 × 密钥」组合（仅在还没向客户端写出任何字节时换） */
  maxAttempts: z.number().int().min(1).max(10),
  /** 上游 429 后该密钥冷却秒数（上游给了 Retry-After 时取较大者） */
  keyCooldownSeconds: z.number().int().min(1).max(3600),
  /** 渠道连续失败多少次熔断 */
  channelFailureThreshold: z.number().int().min(1).max(100),
  /** 渠道熔断时长（秒） */
  channelCooldownSeconds: z.number().int().min(1).max(3600),
  /** 逐条用量记录保留天数（日汇总永久保留） */
  logRetentionDays: z.number().int().min(7).max(3650),
})
export type RelaySettings = z.infer<typeof RelaySettingsSchema>

export const DEFAULT_RELAY_SETTINGS: RelaySettings = {
  enabled: true,
  signupBonusMicro: 0,
  dailyBonusMicro: 0,
  defaultMaxConcurrency: 4,
  maxAttempts: 3,
  keyCooldownSeconds: 60,
  channelFailureThreshold: 5,
  channelCooldownSeconds: 60,
  logRetentionDays: 90,
}

export const RelaySettingsResponseSchema = z.object({
  settings: RelaySettingsSchema,
  /** 容器内 DSH 访问中转站用的地址（只读，来自环境变量与用户网络网关）；内部监听器关闭时为 null */
  internalBaseUrl: z.string().nullable(),
  /** 外部工具用的地址：`HUB_PUBLIC_ORIGIN` + `/v1` */
  publicBaseUrl: z.string(),
})
export type RelaySettingsResponse = z.infer<typeof RelaySettingsResponseSchema>

export const UpdateRelaySettingsRequestSchema = RelaySettingsSchema.partial()
export type UpdateRelaySettingsRequest = z.infer<typeof UpdateRelaySettingsRequestSchema>

// ── 上游渠道 ────────────────────────────────────────────────────────────────

export const RelayKeyStateSchema = z.enum(['active', 'disabled', 'auto-disabled'])
export type RelayKeyState = z.infer<typeof RelayKeyStateSchema>

/** 渠道里的一把上游密钥（只回显末 4 位） */
export const RelayChannelKeySchema = z.object({
  id: z.number().int(),
  label: z.string(),
  last4: z.string(),
  state: RelayKeyStateSchema,
  /** 429 冷却到何时（未冷却 = null） */
  cooldownUntil: IsoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: IsoDateTimeSchema.nullable(),
  lastUsedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
})
export type RelayChannelKey = z.infer<typeof RelayChannelKeySchema>

/** 渠道健康：ok / 熔断冷却中 / 没有可用密钥 / 停用 */
export const RelayChannelHealthSchema = z.enum(['ok', 'cooling', 'no-key', 'disabled'])
export type RelayChannelHealth = z.infer<typeof RelayChannelHealthSchema>

/**
 * 渠道标识（16 §2）：**对用户可见**的短名。每个「模型 × 渠道」是一个独立模型，名字 `<模型>@<slug>`
 * （用户界面、`/v1/models`、DSH 模型列表都只列这种名字）。小写字母、数字和 -，最长 24 位，全局唯一。
 */
export const RELAY_CHANNEL_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,23}$/
export const RelayChannelSlugSchema = z
  .string()
  .trim()
  .regex(RELAY_CHANNEL_SLUG_REGEX, '渠道标识只能用小写字母、数字和 -，以字母或数字开头，最长 24 位')

/** 「模型 × 渠道」独立模型名的分隔符：`deepseek-v4.1-flash@upstream-b`（16 §3；若 DSH 不接受 `@`，WP20a 只改这一处） */
export const RELAY_PINNED_MODEL_SEPARATOR = '@'

/** 拼出指定渠道的调用名 */
export function pinnedModelName(model: string, channelSlug: string): string {
  return `${model}${RELAY_PINNED_MODEL_SEPARATOR}${channelSlug}`
}

export const RelayChannelSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** 16 §2：对用户可见的渠道标识（WP20 起总会给出） */
  slug: z.string().optional(),
  /** 请求路径拼在它后面：`{baseUrl}/chat/completions`、`/responses`、`/messages`、`/models` */
  baseUrl: z.string(),
  apis: z.array(ModelApiSchema).min(1),
  /** 渠道倍率（千分比，1000 = ×1.0）：走这条渠道的请求，费用 = 模型价格算出的费用 × 倍率（12 §6.2） */
  ratePermille: RatePermilleSchema,
  /** 大的优先；同优先级按权重分流 */
  priority: z.number().int(),
  weight: z.number().int().min(1),
  /** 渠道同时进行的请求上限，0 = 不限（订阅类上游常有并发限制） */
  maxConcurrency: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  proxyUrl: z.string().nullable(),
  /** 额外请求头（不能含鉴权头） */
  headers: z.record(z.string(), z.string()).nullable(),
  /** OpenAI 流式请求自动补 `stream_options.include_usage=true`（上游不认该字段时关掉） */
  streamUsage: z.boolean(),
  enabled: z.boolean(),
  note: z.string(),
  keys: z.array(RelayChannelKeySchema),
  health: RelayChannelHealthSchema,
  failStreak: z.number().int().nonnegative(),
  cooldownUntil: IsoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: IsoDateTimeSchema.nullable(),
  /** 当前进行中的请求数（内存计数） */
  inFlight: z.number().int().nonnegative(),
  /** 引用它的对外模型数 */
  modelCount: z.number().int().nonnegative(),
  /** 18 §3.1：作用域（WP23 起总会给出；建好后不能改） */
  scope: RelayScopeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type RelayChannel = z.infer<typeof RelayChannelSchema>

export const RelayChannelListResponseSchema = z.array(RelayChannelSchema)
export type RelayChannelListResponse = z.infer<typeof RelayChannelListResponseSchema>

export const CreateRelayChannelRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** 省略 = 由名称自动生成（16 §2.1）；冲突 → VALIDATION_FAILED（fields.slug） */
  slug: RelayChannelSlugSchema.optional(),
  baseUrl: z.string().trim().min(1).max(500),
  apis: z.array(ModelApiSchema).min(1),
  ratePermille: RatePermilleSchema.default(RELAY_RATE_PERMILLE_DEFAULT),
  priority: z.number().int().min(-100).max(100).default(0),
  weight: z.number().int().min(1).max(100).default(1),
  maxConcurrency: z.number().int().min(0).max(1000).default(0),
  timeoutMs: z.number().int().min(5_000).max(3_600_000).default(600_000),
  proxyUrl: z.string().trim().max(500).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  streamUsage: z.boolean().default(true),
  enabled: z.boolean().default(true),
  note: z.string().max(500).default(''),
  /** 建渠道时顺带加密钥（每项一把） */
  keys: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  /** 18 §3.1：作用域，省略 = dsh；修改接口不接受它。claude-code 渠道的 apis 只能是 anthropic-messages，codex 只能是 openai-responses */
  scope: RelayScopeSchema.optional(),
})
export type CreateRelayChannelRequest = z.infer<typeof CreateRelayChannelRequestSchema>

/**
 * 修改渠道（密钥走单独的接口）。
 * 不能只写 `.partial()`：zod 4 的 partial 仍会给缺省字段填 `.default()`，只改名的 PATCH 会把其它字段全部重置成默认值。
 * 所以带默认值的字段在这里重新声明为「纯可选」（`test/partial-defaults.test.ts` 钉住）。
 */
export const UpdateRelayChannelRequestSchema = CreateRelayChannelRequestSchema.omit({
  keys: true,
  scope: true,
})
  .partial()
  .extend({
    ratePermille: RatePermilleSchema.optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    weight: z.number().int().min(1).max(100).optional(),
    maxConcurrency: z.number().int().min(0).max(1000).optional(),
    timeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
    streamUsage: z.boolean().optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(500).optional(),
  })
export type UpdateRelayChannelRequest = z.infer<typeof UpdateRelayChannelRequestSchema>

export const RelayChannelResponseSchema = z.object({ channel: RelayChannelSchema })
export type RelayChannelResponse = z.infer<typeof RelayChannelResponseSchema>

/** 批量加密钥：一行一把（服务端去重：与本渠道已有密钥相同的跳过） */
export const AddRelayChannelKeysRequestSchema = z.object({
  keys: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  label: z.string().max(64).default(''),
})
export type AddRelayChannelKeysRequest = z.infer<typeof AddRelayChannelKeysRequestSchema>

export const AddRelayChannelKeysResponseSchema = z.object({
  added: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  channel: RelayChannelSchema,
})
export type AddRelayChannelKeysResponse = z.infer<typeof AddRelayChannelKeysResponseSchema>

/** 启用/停用某把密钥（把 auto-disabled 改回 active = 人工恢复） */
export const UpdateRelayChannelKeyRequestSchema = z.object({
  label: z.string().max(64).optional(),
  state: z.enum(['active', 'disabled']).optional(),
})
export type UpdateRelayChannelKeyRequest = z.infer<typeof UpdateRelayChannelKeyRequestSchema>

/** 测试渠道：用每把可用密钥请求 `{baseUrl}/models`（anthropic-only 的渠道带 x-api-key + anthropic-version） */
export const TestRelayChannelResponseSchema = z.object({
  ok: z.boolean(),
  results: z.array(
    z.object({
      keyId: z.number().int(),
      last4: z.string(),
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      httpStatus: z.number().int().nullable(),
      error: z.string().optional(),
    }),
  ),
})
export type TestRelayChannelResponse = z.infer<typeof TestRelayChannelResponseSchema>

/** 从渠道发现模型：上游 `/models` 列表 + 模型信息库补全（同 06 §4.1 的发现） */
export const DiscoverRelayChannelResponseSchema = z.object({
  models: z.array(
    ModelInfoSchema.extend({
      /** 上游的模型 id */
      id: z.string(),
      infoSource: ModelInfoSourceSchema.optional(),
      matchedId: z.string().optional(),
      /** 已有同名对外模型的 id（导入时会只加路由不新建） */
      existingModelId: z.number().int().nullable(),
    }),
  ),
})
export type DiscoverRelayChannelResponse = z.infer<typeof DiscoverRelayChannelResponseSchema>

// ── 对外模型（名字、价格、路由）─────────────────────────────────────────────

export const RelayModelVisibilitySchema = z.enum(['all', 'admin'])
export type RelayModelVisibility = z.infer<typeof RelayModelVisibilitySchema>

/** 价格：微积分 / 百万 token；缓存价缺省 = 同输入价；perRequest 是每次请求的固定费用（微积分） */
export const RelayPriceSchema = z.object({
  inputMicro: MicroSchema,
  outputMicro: MicroSchema,
  cacheReadMicro: MicroSchema.nullable(),
  cacheWriteMicro: MicroSchema.nullable(),
  perRequestMicro: MicroSchema,
})
export type RelayPrice = z.infer<typeof RelayPriceSchema>

/** 一条路由：这个对外模型可以走哪个渠道、在上游叫什么名字 */
export const RelayRouteSchema = z.object({
  id: z.number().int(),
  channelId: z.number().int(),
  channelName: z.string(),
  /** 该渠道当前的倍率（千分比），便于界面显示「价格 × 倍率」 */
  channelRatePermille: z.number().int(),
  /** 16 §2：渠道标识（WP20 起总会给出） */
  channelSlug: z.string().optional(),
  upstreamModel: z.string(),
  /** null = 用渠道自己的优先级 / 权重 */
  priority: z.number().int().nullable(),
  weight: z.number().int().min(1).nullable(),
  enabled: z.boolean(),
})
export type RelayRoute = z.infer<typeof RelayRouteSchema>

export const RelayRouteInputSchema = z.object({
  channelId: z.number().int().positive(),
  /** 省略 = 与对外模型同名 */
  upstreamModel: z.string().trim().min(1).max(200).optional(),
  priority: z.number().int().min(-100).max(100).nullable().optional(),
  weight: z.number().int().min(1).max(100).nullable().optional(),
  enabled: z.boolean().default(true),
})
export type RelayRouteInput = z.infer<typeof RelayRouteInputSchema>

export const RelayModelSchema = z.object({
  id: z.number().int(),
  /** 对外模型名：用户请求里的 `model`，也是 DSH 里看到的模型 id */
  name: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  visibility: RelayModelVisibilitySchema,
  price: RelayPriceSchema,
  /** 渲染进 DSH 的模型参数（上下文、最大输出、输入类型、思考档位） */
  info: ModelInfoSchema,
  /** 渲染进 DSH 的 pi-ai compat（如 DeepSeek 思考格式），null = 不写 */
  compat: z.record(z.string(), z.unknown()).nullable(),
  /**
   * 下发到 DSH 时的默认思考档位（WP13，12 §7.0）：用户在 DSH 里选这个模型时默认用的档位。
   * 必须是 `info.reasoningEfforts` 里声明过的档位；null = 不指定（由模型/上游自己的默认决定）
   */
  defaultThinking: ThinkingLevelSchema.nullable(),
  routes: z.array(RelayRouteSchema),
  /** 由路由上启用渠道的 apis 汇总得出：这个模型能用哪些接口调 */
  apis: z.array(ModelApiSchema),
  sort: z.number().int(),
  /** 18 §3.1：作用域（WP23 起总会给出；建好后不能改） */
  scope: RelayScopeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type RelayModel = z.infer<typeof RelayModelSchema>

export const RelayModelListResponseSchema = z.array(RelayModelSchema)
export type RelayModelListResponse = z.infer<typeof RelayModelListResponseSchema>

/** 对外模型名：不能含空白；允许 `/`、`:`、`.`（如 `deepseek/deepseek-v4.1-flash`） */
export const RelayModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, '模型名只能用字母、数字和 . _ : / @ -')

export const RelayPriceInputSchema = z.object({
  inputMicro: MicroSchema,
  outputMicro: MicroSchema,
  cacheReadMicro: MicroSchema.nullable().default(null),
  cacheWriteMicro: MicroSchema.nullable().default(null),
  perRequestMicro: MicroSchema.default(0),
})

export const CreateRelayModelRequestSchema = z.object({
  name: RelayModelNameSchema,
  displayName: z.string().trim().max(128).optional(),
  enabled: z.boolean().default(true),
  visibility: RelayModelVisibilitySchema.default('all'),
  price: RelayPriceInputSchema,
  /** 省略的字段由服务端按模型信息库补全 */
  info: ModelInfoSchema.default({}),
  compat: z.record(z.string(), z.unknown()).nullable().default(null),
  /** 必须在 `info.reasoningEfforts` 里（12 §7.0）；不在 → VALIDATION_FAILED（fields.defaultThinking） */
  defaultThinking: ThinkingLevelSchema.nullable().default(null),
  routes: z.array(RelayRouteInputSchema).default([]),
  sort: z.number().int().default(0),
  /** 18 §3.1：作用域，省略 = dsh；路由的渠道必须同作用域（否则 VALIDATION_FAILED fields.routes）。模型名三个作用域共用一个名字空间 */
  scope: RelayScopeSchema.optional(),
})
export type CreateRelayModelRequest = z.infer<typeof CreateRelayModelRequestSchema>

/** 修改对外模型：`routes` 给了就整体替换 */
export const UpdateRelayModelRequestSchema = z.object({
  name: RelayModelNameSchema.optional(),
  displayName: z.string().trim().max(128).optional(),
  enabled: z.boolean().optional(),
  visibility: RelayModelVisibilitySchema.optional(),
  price: RelayPriceInputSchema.optional(),
  info: ModelInfoSchema.optional(),
  compat: z.record(z.string(), z.unknown()).nullable().optional(),
  /**
   * 省略 = 不改；null = 清除。校验用**更新后的** `info.reasoningEfforts`：同时改了 info 去掉了这个档位、
   * 又没有同时改 defaultThinking → VALIDATION_FAILED（fields.defaultThinking），不悄悄清掉
   */
  defaultThinking: ThinkingLevelSchema.nullable().optional(),
  routes: z.array(RelayRouteInputSchema).optional(),
  sort: z.number().int().optional(),
})
export type UpdateRelayModelRequest = z.infer<typeof UpdateRelayModelRequestSchema>

export const RelayModelResponseSchema = z.object({ model: RelayModelSchema })
export type RelayModelResponse = z.infer<typeof RelayModelResponseSchema>

/** 从渠道批量导入：每项一个上游模型；同名对外模型已存在 → 只给它加一条路由 */
export const ImportRelayModelsRequestSchema = z.object({
  channelId: z.number().int().positive(),
  models: z
    .array(
      z.object({
        upstreamModel: z.string().trim().min(1).max(200),
        /** 省略 = 同上游名 */
        name: RelayModelNameSchema.optional(),
        displayName: z.string().trim().max(128).optional(),
        info: ModelInfoSchema.optional(),
      }),
    )
    .min(1)
    .max(500),
  /** 新建模型用的价格；省略 = 全 0（「未定价」，之后在「模型与价格」里逐个定价）。已存在的模型不改价 */
  price: RelayPriceInputSchema.optional(),
})
export type ImportRelayModelsRequest = z.infer<typeof ImportRelayModelsRequestSchema>

export const ImportRelayModelsResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  routesAdded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  models: z.array(RelayModelSchema),
})
export type ImportRelayModelsResponse = z.infer<typeof ImportRelayModelsResponseSchema>

// ── 用户钱包与流水 ──────────────────────────────────────────────────────────

/**
 * grant/deduct 管理员加扣；signup 注册赠送；daily 每日赠送；expire 每日赠送作废（负数）；
 * compute 算力租赁按块扣费（负数，13 §3）。token 用量不进流水（在 relay_usage 里）。
 */
export const RelayLedgerTypeSchema = z.enum(['grant', 'deduct', 'signup', 'daily', 'expire', 'compute'])
export type RelayLedgerType = z.infer<typeof RelayLedgerTypeSchema>

export const RelayWalletSchema = z.object({
  userId: z.number().int(),
  balanceMicro: SignedMicroSchema,
  /** 计费倍率（百分比）：100 = 原价，0 = 免费 */
  ratePercent: z.number().int().min(0).max(1000),
  /** null = 用设置里的默认并发 */
  maxConcurrency: z.number().int().min(1).max(64).nullable(),
  /** 每日消耗上限（微积分），null = 不限 */
  dailyLimitMicro: MicroSchema.nullable(),
  enabled: z.boolean(),
  totalSpentMicro: MicroSchema,
  lastUsedAt: IsoDateTimeSchema.nullable(),
  /** 余额中今日赠送还没用掉的部分（13 §2；WP17 起返回） */
  dailyBonusLeftMicro: MicroSchema.optional(),
})
export type RelayWallet = z.infer<typeof RelayWalletSchema>

/** 管理端钱包列表的一行（带用户信息与今日 / 本月消耗） */
export const RelayWalletRowSchema = RelayWalletSchema.extend({
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  todayCostMicro: MicroSchema,
  monthCostMicro: MicroSchema,
  monthRequests: z.number().int().nonnegative(),
})
export type RelayWalletRow = z.infer<typeof RelayWalletRowSchema>

export const RelayWalletListQuerySchema = PageQuerySchema.extend({
  q: z.string().max(64).optional(),
  sort: z.enum(['balance', 'monthCost', 'lastUsed', 'username']).default('lastUsed'),
})
export type RelayWalletListQuery = z.infer<typeof RelayWalletListQuerySchema>

export const RelayWalletListResponseSchema = pagedOf(RelayWalletRowSchema)
export type RelayWalletListResponse = z.infer<typeof RelayWalletListResponseSchema>

export const RelayWalletResponseSchema = z.object({ wallet: RelayWalletRowSchema })
export type RelayWalletResponse = z.infer<typeof RelayWalletResponseSchema>

export const UpdateRelayWalletRequestSchema = z.object({
  ratePercent: z.number().int().min(0).max(1000).optional(),
  maxConcurrency: z.number().int().min(1).max(64).nullable().optional(),
  dailyLimitMicro: MicroSchema.nullable().optional(),
  enabled: z.boolean().optional(),
})
export type UpdateRelayWalletRequest = z.infer<typeof UpdateRelayWalletRequestSchema>

/** 加/扣积分：正数 = grant，负数 = deduct；不能为 0 */
export const AdjustRelayWalletRequestSchema = z.object({
  amountMicro: z
    .number()
    .int()
    .refine((v) => v !== 0, '金额不能为 0')
    .refine((v) => Math.abs(v) <= 1_000_000 * RELAY_MICRO_PER_POINT, '单次最多 100 万积分'),
  note: z.string().trim().max(200).default(''),
})
export type AdjustRelayWalletRequest = z.infer<typeof AdjustRelayWalletRequestSchema>

export const RelayLedgerRowSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  username: z.string(),
  type: RelayLedgerTypeSchema,
  amountMicro: SignedMicroSchema,
  balanceAfterMicro: SignedMicroSchema,
  note: z.string(),
  /** 操作者用户名（signup/daily/expire/compute 为 null） */
  actor: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
})
export type RelayLedgerRow = z.infer<typeof RelayLedgerRowSchema>

export const RelayLedgerQuerySchema = PageQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
})
export type RelayLedgerQuery = z.infer<typeof RelayLedgerQuerySchema>

export const RelayLedgerListResponseSchema = pagedOf(RelayLedgerRowSchema)
export type RelayLedgerListResponse = z.infer<typeof RelayLedgerListResponseSchema>

// ── 用户密钥 ────────────────────────────────────────────────────────────────

/** system = DSH 内置（每人一把，自动注入容器 env，不能删只能重置）；user = 用户自建（给外部工具用） */
export const RelayKeyKindSchema = z.enum(['system', 'user'])
export type RelayKeyKind = z.infer<typeof RelayKeyKindSchema>

export const RelayKeySchema = z.object({
  id: z.number().int(),
  kind: RelayKeyKindSchema,
  name: z.string(),
  /** 显示用：`sk-dsh-ab12…9xyz` */
  preview: z.string(),
  enabled: z.boolean(),
  lastUsedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  /** 18 D5：作用域；用户端密钥列表只列 dsh（模式密钥不给用户看） */
  scope: RelayScopeSchema.optional(),
})
export type RelayKey = z.infer<typeof RelayKeySchema>

export const RelayKeyListResponseSchema = z.array(RelayKeySchema)
export type RelayKeyListResponse = z.infer<typeof RelayKeyListResponseSchema>

export const CreateRelayKeyRequestSchema = z.object({ name: z.string().trim().min(1).max(32) })
export type CreateRelayKeyRequest = z.infer<typeof CreateRelayKeyRequestSchema>

/** 新建 / 重置后**只此一次**返回明文 */
export const RelayKeySecretResponseSchema = z.object({
  key: RelayKeySchema,
  secret: z.string().startsWith(RELAY_KEY_PREFIX),
  /** 重置 DSH 内置密钥后为 true：容器要重建才生效（实例状态页也会提示） */
  needsRecreate: z.boolean(),
})
export type RelayKeySecretResponse = z.infer<typeof RelayKeySecretResponseSchema>

export const UpdateRelayKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  enabled: z.boolean().optional(),
})
export type UpdateRelayKeyRequest = z.infer<typeof UpdateRelayKeyRequestSchema>

export const RelayKeyResponseSchema = z.object({ key: RelayKeySchema })
export type RelayKeyResponse = z.infer<typeof RelayKeyResponseSchema>

// ── 用量 ────────────────────────────────────────────────────────────────────

/**
 * ok = 正常完成；aborted = 客户端中途断开；upstream_error = 换遍渠道仍失败（5xx/超时/网络）；
 * client_error = 上游 4xx 原样回给客户端（参数错等，不计费）
 */
export const RelayUsageStatusSchema = z.enum(['ok', 'aborted', 'upstream_error', 'client_error'])
export type RelayUsageStatus = z.infer<typeof RelayUsageStatusSchema>

/** 请求从哪来：容器内部监听器 / 本机 7700 / 公网 7443 */
/**
 * 用量来源（`relay_usage.source`）。
 * - `internal`：容器里的 DSH 经内部监听器（10.213.0.1:7710）来；
 * - `local` / `public`：本机 / 公网直连 `/v1`；
 * - `cockpit`：**管理座舱**（`is_system=1` 的系统账号 hub-ops）来的请求（WP56e1）。
 *   它不扣任何人的积分（成本记 0），但 token 用量照常记账，管理端用量页可以按来源筛出来。
 */
export const RelayUsageSourceSchema = z.enum(['internal', 'local', 'public', 'cockpit'])
export type RelayUsageSource = z.infer<typeof RelayUsageSourceSchema>

export const RelayTokensSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
})
export type RelayTokens = z.infer<typeof RelayTokensSchema>

export const RelayUsageRowSchema = RelayTokensSchema.extend({
  id: z.number().int(),
  requestId: z.string(),
  createdAt: IsoDateTimeSchema,
  userId: z.number().int(),
  username: z.string(),
  keyId: z.number().int().nullable(),
  keyName: z.string().nullable(),
  model: z.string(),
  upstreamModel: z.string().nullable(),
  /** 用户端不返回渠道 id 与名称（null） */
  channelId: z.number().int().nullable(),
  channelName: z.string().nullable(),
  /** 16 §5：渠道标识（公开信息，用户端也返回）；没走到渠道 = null。WP20 起总会给出 */
  channelSlug: z.string().nullable().optional(),
  /** 16 §3：这次请求是否用 `<模型>@<slug>` 指定了渠道。WP20 起总会给出 */
  pinned: z.boolean().optional(),
  /** 16 §3：模型本名（`model` 是请求里的原始名字，可能带 `@slug`）。WP20 起总会给出 */
  baseModel: z.string().optional(),
  /** 计费时用的渠道倍率快照（千分比）；没走到渠道 = null。用户端也返回（不含渠道名），用来解释费用 */
  channelRatePermille: z.number().int().nullable(),
  api: ModelApiSchema,
  stream: z.boolean(),
  source: RelayUsageSourceSchema,
  status: RelayUsageStatusSchema,
  httpStatus: z.number().int().nullable(),
  reasoningTokens: z.number().int().nonnegative(),
  costMicro: MicroSchema,
  /** 上游没回 usage、按字数估算的 */
  estimated: z.boolean(),
  attempts: z.number().int().min(1),
  durationMs: z.number().int().nonnegative().nullable(),
  /** 首字节耗时 */
  ttftMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  /** 18 D7：来源（密钥的作用域）。WP23 起总会给出 */
  scope: RelayScopeSchema.optional(),
  /** 18 §3.3：计费时的模式整体倍率快照（千分比）；dsh = null */
  modeRatePermille: z.number().int().nullable().optional(),
})
export type RelayUsageRow = z.infer<typeof RelayUsageRowSchema>

/**
 * 用量来源（`relay_usage.client_kind`）：由**凭据**决定，不由请求自述（迁移 088）。
 * - `docker`：容器里注入的 system 密钥（`HUB_MK_HUB`）
 * - `desktop`：桌面设备专用密钥（`relay_keys.device_id` 非空）
 * - `external`：用户自建密钥（curl / 自写脚本）
 * - `unknown`：判定不出来（密钥已删等历史数据）
 * 与 `ToolUsageClientKindSchema`（tools.ts）同一口径。
 */
export const RelayUsageClientKindSchema = z.enum(['docker', 'desktop', 'external', 'unknown'])
export type RelayUsageClientKind = z.infer<typeof RelayUsageClientKindSchema>

export const RelayUsageLogQuerySchema = PageQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  model: z.string().max(200).optional(),
  /** 16 §5：按模型本名筛选（`base_model`；`model` 仍是原始名字，带 `@slug`） */
  baseModel: z.string().max(200).optional(),
  channelId: z.coerce.number().int().positive().optional(),
  status: RelayUsageStatusSchema.optional(),
  from: RelayDaySchema.optional(),
  to: RelayDaySchema.optional(),
  /** 18 §6：按来源筛选；省略 = 全部来源 */
  scope: RelayScopeSchema.optional(),
  /** docs/22 §1.3：按**用量来源**筛选（管理端；桌面视图默认带 desktop）；省略 = 全部来源 */
  clientKind: RelayUsageClientKindSchema.optional(),
  /** WP56e1：按 `relay_usage.source` 筛（internal / local / public / cockpit）；省略 = 全部来源 */
  source: RelayUsageSourceSchema.optional(),
})
export type RelayUsageLogQuery = z.infer<typeof RelayUsageLogQuerySchema>

export const RelayUsageLogResponseSchema = pagedOf(RelayUsageRowSchema)
export type RelayUsageLogResponse = z.infer<typeof RelayUsageLogResponseSchema>

/** 一个汇总桶（日 / 模型 / 用户 / 渠道） */
export const RelayUsageBucketSchema = RelayTokensSchema.extend({
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  costMicro: MicroSchema,
})
export type RelayUsageBucket = z.infer<typeof RelayUsageBucketSchema>

export const RelayUsageStatsQuerySchema = z.object({
  /** 缺省：今天往前 29 天 */
  from: RelayDaySchema.optional(),
  /** 缺省：今天 */
  to: RelayDaySchema.optional(),
  /** 管理端可按用户过滤；用户端忽略 */
  userId: z.coerce.number().int().positive().optional(),
  /** 18 §6：按来源筛选；省略 = 全部来源 */
  scope: RelayScopeSchema.optional(),
  /** docs/22 §1.3：按**用量来源**筛选（桌面视图默认带 desktop）；省略 = 全部来源 */
  clientKind: RelayUsageClientKindSchema.optional(),
  /** WP56e1：按 `relay_usage.source` 筛（internal / local / public / cockpit）；省略 = 全部来源 */
  source: RelayUsageSourceSchema.optional(),
})
export type RelayUsageStatsQuery = z.infer<typeof RelayUsageStatsQuerySchema>

export const RelayUsageStatsResponseSchema = z.object({
  from: RelayDaySchema,
  to: RelayDaySchema,
  total: RelayUsageBucketSchema,
  /** 区间内每天一项（没有用量的日子也给 0，便于画图） */
  daily: z.array(RelayUsageBucketSchema.extend({ day: RelayDaySchema })),
  byModel: z.array(RelayUsageBucketSchema.extend({ model: z.string() })),
  /** 仅管理端（用户端为空数组） */
  byUser: z.array(RelayUsageBucketSchema.extend({ userId: z.number().int(), username: z.string() })),
  /** 仅管理端（用户端为空数组） */
  byChannel: z.array(RelayUsageBucketSchema.extend({ channelId: z.number().int(), channelName: z.string() })),
  /** 18 D7：按来源（用户端也给）。WP23 起总会给出 */
  byScope: z.array(RelayUsageBucketSchema.extend({ scope: RelayScopeSchema })).optional(),
  /** 19 §3：按「天 × 模型」的明细，只给有用量的格子（没有的天前端补 0）；用户端与管理端都给。WP24 起总会给出 */
  dailyByModel: z.array(RelayUsageBucketSchema.extend({ day: RelayDaySchema, model: z.string() })).optional(),
})
export type RelayUsageStatsResponse = z.infer<typeof RelayUsageStatsResponseSchema>

// ── 管理端概览 ──────────────────────────────────────────────────────────────

export const RelayAlertSchema = z.object({
  level: z.enum(['warn', 'error']),
  /** key-auto-disabled / channel-cooling / channel-no-key / usage-missing / internal-listener-down / models-changed / models-unpriced */
  kind: z.string(),
  message: z.string(),
  channelId: z.number().int().nullable(),
  at: IsoDateTimeSchema.nullable(),
})
export type RelayAlert = z.infer<typeof RelayAlertSchema>

export const RelayOverviewResponseSchema = z.object({
  enabled: z.boolean(),
  internalBaseUrl: z.string().nullable(),
  /** 内部监听器是否在监听 */
  internalListening: z.boolean(),
  today: RelayUsageBucketSchema,
  month: RelayUsageBucketSchema,
  /** 进行中的请求数 */
  inFlight: z.number().int().nonnegative(),
  /** 全部钱包余额之和（微积分，可为负） */
  totalBalanceMicro: SignedMicroSchema,
  channels: z.object({ total: z.number().int(), ok: z.number().int(), unhealthy: z.number().int() }),
  models: z.object({ total: z.number().int(), enabled: z.number().int() }),
  alerts: z.array(RelayAlertSchema),
})
export type RelayOverviewResponse = z.infer<typeof RelayOverviewResponseSchema>

// ── 用户端 ──────────────────────────────────────────────────────────────────

/**
 * 16 §4：「模型 × 渠道」= 用户看到的一个独立模型（名字 `pinnedModel`），价格按这条渠道的倍率确定。
 * 接口按模型嵌套返回，前端平铺成一行一个、不分组（16 §4.2）。
 * 只含**启用渠道上的启用路由**；渠道只给公开的标识和倍率，不给名称、地址、成本。
 */
export const MyRelayModelRouteSchema = z.object({
  channelSlug: z.string(),
  /** 渠道倍率（千分比）；实际费用 = 模型价格 × 它 × 钱包倍率 */
  ratePermille: z.number().int(),
  /** 指定这个渠道的调用名：`pinnedModelName(model, channelSlug)` */
  pinnedModel: z.string(),
  /** 该模型的这条渠道在「下发到 DSH」里被选中且当前能下发（用户的 DSH 里看得到它） */
  inDsh: z.boolean(),
  /** 是下发配置的默认（模型 + 渠道） */
  dshDefault: z.boolean(),
})
export type MyRelayModelRoute = z.infer<typeof MyRelayModelRouteSchema>

/** 用户看到的模型（不含渠道名称与成本信息） */
export const MyRelayModelSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  apis: z.array(ModelApiSchema),
  /** 模型价格（未乘渠道倍率） */
  price: RelayPriceSchema,
  /** 该模型启用路由所在渠道的倍率范围（千分比）；实际费用 = 价格 × 倍率 × 钱包倍率。没有可用路由 = null */
  channelRate: z.object({ minPermille: z.number().int(), maxPermille: z.number().int() }).nullable(),
  info: ModelInfoSchema,
  /**
   * 15 §3.2：该模型在「下发到 DSH」的选中集合里且当前能下发（用户的 DSH 里看得到它）。
   * 只对统一管理（managed）的用户有意义；缺省 = 老后端没给，前端当作「不知道」，不做区分。
   */
  inDsh: z.boolean().optional(),
  /** 15 §3.2：是「下发到 DSH」的默认模型（用户打开 DSH 时选中的那个） */
  dshDefault: z.boolean().optional(),
  /** 16 §4：按渠道展开的独立模型（按倍率从低到高、再按渠道标识排序）。WP20 起总会给出；model 级的 inDsh = 任一路由 inDsh */
  routes: z.array(MyRelayModelRouteSchema).optional(),
})
export type MyRelayModel = z.infer<typeof MyRelayModelSchema>

/** 18 §7：用户端一个对我开通的对话模式 */
export const MyAgentModeSchema = z.object({
  mode: RelayAgentModeSchema,
  label: z.string(),
  /** 整体倍率（千分比）；实际单价 = 模型价格 × 渠道倍率 × 它 × 钱包倍率 */
  ratePermille: z.number().int().nonnegative(),
  defaultModel: z.string().nullable(),
  /** 本作用域可用模型（价格未乘任何倍率；`channelRate` 是本作用域渠道倍率范围；routes / inDsh / dshDefault 不给） */
  models: z.array(MyRelayModelSchema),
})
export type MyAgentMode = z.infer<typeof MyAgentModeSchema>

export const MyRelayResponseSchema = z.object({
  /** 全局开关 && 钱包启用 */
  enabled: z.boolean(),
  wallet: RelayWalletSchema,
  today: RelayUsageBucketSchema,
  month: RelayUsageBucketSchema,
  /** 外部工具用：`HUB_PUBLIC_ORIGIN/v1` */
  publicBaseUrl: z.string(),
  /** 我的 DSH 是否已经接入中转站（生效预设里有 hub-relay 提供方） */
  dshAttached: z.boolean(),
  models: z.array(MyRelayModelSchema),
  /** 18 §7：对我开通的对话模式（没开通的不出现）。WP23 起总会给出 */
  agentModes: z.array(MyAgentModeSchema).optional(),
})
export type MyRelayResponse = z.infer<typeof MyRelayResponseSchema>

// ── 下发到 DSH（WP12，12 §7）────────────────────────────────────────────────

/**
 * 渲染进用户 DSH 时，一个模型只挂在一个协议下：按这个优先级取它可用接口里的第一个
 * （DSH 的 pi-ai 三种都支持；OpenAI 兼容最通用）。
 */
export const RELAY_DSH_API_PREFERENCE = [
  'openai-completions',
  'anthropic-messages',
  'openai-responses',
] as const

/** 用户 DSH 的模型列表里，Hub 下发的提供方统一显示成这个名字（WP13；所有系统提供方同名） */
export const DSH_HUB_PROVIDER_NAME = 'DSH Hub'

/**
 * 下发到 DSH 时实际生效的默认思考档位（WP13，12 §7.0）：模型声明了这个档位才生效。
 * 「声明」= `info.reasoningEfforts` 里有它，且至少有一个 off 之外的合法档位（只有 off 的声明渲染时会被整体丢掉）。
 * 不生效 = null（渲染时当作没设，`GET /api/admin/relay/dsh` 的 warnings 会提示）。
 */
export function effectiveDshThinking(
  info: Pick<ModelInfo, 'reasoningEfforts'>,
  defaultThinking: ThinkingLevel | null,
): ThinkingLevel | null {
  if (defaultThinking === null) return null
  const declared = (info.reasoningEfforts ?? []).filter((level): level is ThinkingLevel =>
    (THINKING_LEVELS as readonly string[]).includes(level),
  )
  if (!declared.some((level) => level !== 'off')) return null
  return declared.includes(defaultThinking) ? defaultThinking : null
}

/** 16 §6：「下发到 DSH」里一个模型在某个渠道上的那条路由（下发的最小单位） */
export const RelayDshRouteSchema = z.object({
  routeId: z.number().int(),
  channelId: z.number().int(),
  channelName: z.string(),
  channelSlug: z.string(),
  ratePermille: z.number().int(),
  /** 这条路由用哪个协议渲染（模型可用接口 ∩ 渠道 apis，按 RELAY_DSH_API_PREFERENCE 取第一个）；没有 = null */
  deliverApi: ModelApiSchema.nullable(),
  /** 已选中下发 */
  selected: z.boolean(),
  /** 不能下发的原因（「渠道已停用」「路由已停用」「模型已停用」「协议不匹配」）；能下发 = null */
  blockedReason: z.string().nullable(),
})
export type RelayDshRoute = z.infer<typeof RelayDshRouteSchema>

/** 「下发到 DSH」页的一行：一个对外模型能不能下发、有没有被选中 */
export const RelayDshModelSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  visibility: RelayModelVisibilitySchema,
  apis: z.array(ModelApiSchema),
  /** 渲染进 DSH 时用的协议（按 RELAY_DSH_API_PREFERENCE 取）；没有可用路由 = null */
  deliverApi: ModelApiSchema.nullable(),
  /** 启用路由所在的渠道名（展示用） */
  channelNames: z.array(z.string()),
  /** 生效的默认思考档位（`effectiveDshThinking(info, defaultThinking)`；WP13）。设了但不生效的 = null，并在 warnings 里提示 */
  defaultThinking: ThinkingLevelSchema.nullable(),
  price: RelayPriceSchema,
  /** 价格不全为 0 */
  priced: z.boolean(),
  /** 已选中下发（WP20 起 = 任一路由被选中） */
  selected: z.boolean(),
  /** 16 §6：按渠道展开的路由（WP20 起总会给出） */
  routes: z.array(RelayDshRouteSchema).optional(),
  /** 不能下发的原因（「已停用」「没有可用渠道」）；能下发 = null。被选中后才变得不能下发的，照样返回 selected=true 并给原因 */
  blockedReason: z.string().nullable(),
})
export type RelayDshModel = z.infer<typeof RelayDshModelSchema>

export const RelayDshResponseSchema = z.object({
  /**
   * 这份「下发到 DSH」配置属于哪个平台（docs/22 §3）：云上与桌面各有一套系统预设，
   * 勾选的模型 / 默认模型 / 思考档位互不影响。缺省云上。
   */
  platform: PlatformSchema.optional(),
  models: z.array(RelayDshModelSchema),
  /** 默认模型（用户打开 DSH 时选中的那个）；没选任何模型 = null */
  defaultModelId: z.number().int().nullable(),
  /** 16 §6：默认（模型 + 渠道）对应的路由；没选任何路由 = null。WP20 起总会给出 */
  defaultRouteId: z.number().int().nullable().optional(),
  /** Hub 自动维护的系统预设的 revision（每次影响渲染的变化 +1） */
  revision: z.number().int().nonnegative(),
  /** 下发配置（选中集合 / 默认模型 / 被选模型的渲染内容）最近一次变化的时间；从没配置过 = null */
  updatedAt: IsoDateTimeSchema.nullable(),
  /** 配置在最近一次模型下发任务之后又变过（或已选了模型但从没下发过）→ 界面提示「还没下发到用户」 */
  pending: z.boolean(),
  /** 最近一次模型下发任务（任意状态）；从没下发过 = null */
  lastRollout: z
    .object({ jobId: z.number().int(), status: JobStatusSchema, createdAt: IsoDateTimeSchema })
    .nullable(),
  /** 会收到下发的用户（未删除、模型策略为统一管理）与其中正在运行的实例数 */
  users: z.object({ total: z.number().int().nonnegative(), running: z.number().int().nonnegative() }),
  /**
   * 桌面平台：最近一次**写入桌面模型片段**的那次清单版本（统一下发 models / 桌面模型基线 / 直接改配置片段）；
   * 云上不给这个键（清单不在这个接口里管）。
   */
  lastDelivery: z
    .object({
      revision: z.number().int(),
      at: IsoDateTimeSchema,
      /** 操作者用户名；系统写入（模型基线）= null */
      by: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** 渲染层面的提醒（如内部监听器没在监听、默认模型不可用） */
  warnings: z.array(z.string()),
})
export type RelayDshResponse = z.infer<typeof RelayDshResponseSchema>

/**
 * 保存下发配置：整体替换选中集合与默认。只保存，不下发（下发走 `POST /api/admin/rollouts`，kind=models）。
 *
 * 16 §6：WP20 起按**路由**（模型 × 渠道）选：给 `routeIds` + `defaultRouteId`。
 * 老写法 `modelIds` + `defaultModelId` 仍接受 = 选中这些模型的全部路由，默认 = 默认模型里排第一的可下发路由（§6.2）。
 * 两种写法二选一，同时给 → VALIDATION_FAILED。
 */
export const UpdateRelayDshRequestSchema = z
  .object({
    modelIds: z.array(z.number().int().positive()).max(500).optional(),
    defaultModelId: z.number().int().positive().nullable().optional(),
    routeIds: z.array(z.number().int().positive()).max(2000).optional(),
    defaultRouteId: z.number().int().positive().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const byModel = v.modelIds !== undefined || v.defaultModelId !== undefined
    const byRoute = v.routeIds !== undefined || v.defaultRouteId !== undefined
    if (byModel === byRoute) {
      ctx.addIssue({
        code: 'custom',
        path: ['routeIds'],
        message: '请给出 routeIds + defaultRouteId（或老写法 modelIds + defaultModelId），二选一',
      })
      return
    }
    const ids = byRoute ? (v.routeIds ?? []) : (v.modelIds ?? [])
    const def = byRoute ? (v.defaultRouteId ?? null) : (v.defaultModelId ?? null)
    const ok = ids.length === 0 ? def === null : def !== null && ids.includes(def)
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: [byRoute ? 'defaultRouteId' : 'defaultModelId'],
        message: '默认项必须是选中的之一（一个都不选时默认为空）',
      })
    }
  })
export type UpdateRelayDshRequest = z.infer<typeof UpdateRelayDshRequestSchema>

/**
 * `GET/PUT /api/admin/relay/dsh?platform=cloud|desktop`（docs/22 §3）：
 * 平台只出现在查询串里（请求体形状不变），缺省 `cloud`；`PUT` 只保存、不动桌面清单。
 */
export const RelayDshQuerySchema = PlatformQuerySchema
export type RelayDshQuery = z.infer<typeof RelayDshQuerySchema>
