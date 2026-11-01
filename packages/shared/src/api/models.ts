import { z } from 'zod'
import { PROVIDER_KEY_ENV_PREFIX, ROUTE_KEY_REGEX, THINKING_LEVELS } from '../constants.js'
import { IsoDateTimeSchema, PlatformQuerySchema, PlatformSchema } from '../common.js'

/**
 * `hub-relay` = Hub 自己的模型中转站（12 §7）：baseURL、模型列表、密钥都由 Hub 自动生成，
 * 管理员只选协议（`api`）与路由名；库里存成 `kind='pi-ai'` + `is_relay=1`（迁移 044）。
 */
export const ModelProviderKindSchema = z.enum(['pi-ai', 'deepseek-official', 'hub-relay'])
export type ModelProviderKind = z.infer<typeof ModelProviderKindSchema>

/** pi-ai 支持的协议（06 §4.1） */
export const ModelApiSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages'])
export type ModelApi = z.infer<typeof ModelApiSchema>

export const ModelKeyModeSchema = z.enum(['shared', 'per-user', 'none'])
export type ModelKeyMode = z.infer<typeof ModelKeyModeSchema>

export const RouteKeySchema = z
  .string()
  .regex(ROUTE_KEY_REGEX, '路由名只能是小写字母、数字和 -，且以字母开头')

/** 模型能接收的输入类型（pi-ai 的 `input`）：文字 / 图片。不声明 = 由 pi-ai 的目录或路由默认值（文字）决定 */
export const ModelInputSchema = z.enum(['text', 'image'])
export type ModelInput = z.infer<typeof ModelInputSchema>

/** 思考档位（pi-ai 的 THINKING_LEVELS，按强度递增） */
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS)

/** 模型条目（写进 providers.<routeKey>.models） */
export const ModelSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  input: z.array(ModelInputSchema).optional(),
  reasoningEfforts: z.array(z.string()).optional(),
})
export type ModelSpec = z.infer<typeof ModelSpecSchema>

/** 密钥只回显「是否已设置 + 末 4 位」 */
export const ModelKeyInfoSchema = z.object({
  set: z.boolean(),
  last4: z.string().nullable(),
})
export type ModelKeyInfo = z.infer<typeof ModelKeyInfoSchema>

export const ModelProviderSchema = z.object({
  id: z.number().int(),
  routeKey: z.string(),
  displayName: z.string(),
  kind: ModelProviderKindSchema,
  api: ModelApiSchema.nullable(),
  baseUrl: z.string().nullable(),
  models: z.array(ModelSpecSchema),
  compat: z.record(z.string(), z.unknown()).nullable(),
  extra: z.record(z.string(), z.unknown()).nullable(),
  keyMode: ModelKeyModeSchema,
  apiKey: ModelKeyInfoSchema,
  enabled: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type ModelProvider = z.infer<typeof ModelProviderSchema>

export const ModelProviderListResponseSchema = z.array(ModelProviderSchema)
export type ModelProviderListResponse = z.infer<typeof ModelProviderListResponseSchema>

// ── 提供方增删改 ────────────────────────────────────────────────────────────

export const CreateProviderRequestSchema = z.object({
  routeKey: RouteKeySchema,
  displayName: z.string().min(1).max(64),
  kind: ModelProviderKindSchema,
  api: ModelApiSchema.optional(),
  baseUrl: z.string().max(500).optional(),
  models: z.array(ModelSpecSchema).default([]),
  compat: z.record(z.string(), z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  keyMode: ModelKeyModeSchema,
  apiKey: z.string().max(500).optional(),
})
export type CreateProviderRequest = z.infer<typeof CreateProviderRequestSchema>

/** 不能只写 `.partial()`：zod 4 会给缺省的 `models` 填默认的 `[]`，只改名的 PATCH 会清空模型列表（见 relay.ts 同类说明） */
export const UpdateProviderRequestSchema = CreateProviderRequestSchema.partial().extend({
  models: z.array(ModelSpecSchema).optional(),
})
export type UpdateProviderRequest = z.infer<typeof UpdateProviderRequestSchema>

export const ProviderResponseSchema = z.object({ provider: ModelProviderSchema })
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>

// ── 测试连接 / 发现模型 ─────────────────────────────────────────────────────

export const TestProviderResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  models: z.array(z.string()).optional(),
  error: z.string().optional(),
})
export type TestProviderResponse = z.infer<typeof TestProviderResponseSchema>

export const DiscoverModelsRequestSchema = z.object({
  api: ModelApiSchema,
  baseUrl: z.string().min(1).max(500),
  apiKey: z.string().max(500).optional(),
})
export type DiscoverModelsRequest = z.infer<typeof DiscoverModelsRequestSchema>

/** 信息来源：端点自己返回的 / 管理员存的自定义条目 / 内置模型库 */
export const ModelInfoSourceSchema = z.enum(['upstream', 'custom', 'builtin'])
export type ModelInfoSource = z.infer<typeof ModelInfoSourceSchema>

/** 发现结果：模型条目 + 参数是怎么补全的（`infoSource` 缺省 = 没匹配上，需要手填） */
export const DiscoveredModelSchema = ModelSpecSchema.extend({
  infoSource: ModelInfoSourceSchema.optional(),
  /** 命中的模型库条目 id（可能和上游的 id 写法不同，如 deepseek-v4.1-flash → deepseek-flash） */
  matchedId: z.string().optional(),
})
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>

export const DiscoverModelsResponseSchema = z.object({ models: z.array(DiscoveredModelSchema) })
export type DiscoverModelsResponse = z.infer<typeof DiscoverModelsResponseSchema>

// ── 模型信息库（按模型名自动补全上下文 / 输出上限 / 输入类型 / 思考档位）──────

/** 模型信息的可补全字段（都可省略；省略 = 这个库不知道） */
export const ModelInfoSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  input: z.array(ModelInputSchema).optional(),
  reasoningEfforts: z.array(z.string()).optional(),
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

/** 自定义条目（`id` 是匹配用的模型名，服务端会规范化；同名覆盖内置） */
export const CatalogEntryInputSchema = ModelInfoSchema.extend({ id: z.string().min(1).max(200) })
export type CatalogEntryInput = z.infer<typeof CatalogEntryInputSchema>

export const CatalogEntrySchema = CatalogEntryInputSchema.extend({
  /** 规范化后的匹配键（小写、去厂商前缀和日期后缀、`.`/`_` 统一成 `-`） */
  key: z.string(),
  updatedAt: IsoDateTimeSchema,
})
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>

export const CatalogResponseSchema = z.object({
  custom: z.array(CatalogEntrySchema),
  /** 内置库条目数与来源说明（只读，不下发全表） */
  builtin: z.object({ count: z.number().int().nonnegative(), source: z.string() }),
})
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>

export const SaveCatalogRequestSchema = z.object({
  entries: z.array(CatalogEntryInputSchema).min(1).max(100),
})
export type SaveCatalogRequest = z.infer<typeof SaveCatalogRequestSchema>

export const MatchModelsRequestSchema = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(500) })
export type MatchModelsRequest = z.infer<typeof MatchModelsRequestSchema>

export const ModelMatchSchema = ModelInfoSchema.extend({
  /** 请求里的原始 id */
  id: z.string(),
  source: z.enum(['custom', 'builtin']),
  matchedId: z.string(),
})
export type ModelMatch = z.infer<typeof ModelMatchSchema>

/** 只返回命中的；没命中的 id 不出现 */
export const MatchModelsResponseSchema = z.object({ matches: z.array(ModelMatchSchema) })
export type MatchModelsResponse = z.infer<typeof MatchModelsResponseSchema>

// ── per-user 密钥 ───────────────────────────────────────────────────────────

export const SetUserProviderKeyRequestSchema = z.object({ apiKey: z.string().min(1).max(500) })
export type SetUserProviderKeyRequest = z.infer<typeof SetUserProviderKeyRequestSchema>

// ── 预设 ────────────────────────────────────────────────────────────────────

export const ModelPresetSchema = z.object({
  id: z.number().int(),
  /** 这个预设属于哪个平台（docs/22 §3）：每个平台一个默认预设，互不影响；缺省云上 */
  platform: PlatformSchema.optional(),
  name: z.string(),
  description: z.string(),
  providerIds: z.array(z.number().int()),
  defaultProvider: z.string(),
  defaultModel: z.string(),
  isDefault: z.boolean(),
  /** 每次修改 +1，写进 managed.patch.yml 头部注释 */
  revision: z.number().int(),
  usersOnIt: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type ModelPreset = z.infer<typeof ModelPresetSchema>

/** `GET /api/admin/models/presets?platform=cloud|desktop`（缺省云上） */
export const ModelPresetListQuerySchema = PlatformQuerySchema
export type ModelPresetListQuery = z.infer<typeof ModelPresetListQuerySchema>

export const ModelPresetListResponseSchema = z.array(ModelPresetSchema)
export type ModelPresetListResponse = z.infer<typeof ModelPresetListResponseSchema>

export const CreatePresetRequestSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  providerIds: z.array(z.number().int().positive()).min(1),
  defaultProvider: z.string().min(1),
  defaultModel: z.string().min(1),
  isDefault: z.boolean().optional(),
  /** 建到哪个平台（docs/22 §3；缺省云上）。预设名只在平台内唯一 */
  platform: PlatformSchema.optional(),
})
export type CreatePresetRequest = z.infer<typeof CreatePresetRequestSchema>

export const UpdatePresetRequestSchema = CreatePresetRequestSchema.partial()
export type UpdatePresetRequest = z.infer<typeof UpdatePresetRequestSchema>

export const PresetResponseSchema = z.object({ preset: ModelPresetSchema })
export type PresetResponse = z.infer<typeof PresetResponseSchema>

// ── GET /api/admin/models/presets/:id/preview ───────────────────────────────

export const PresetPreviewQuerySchema = z.object({ userId: z.coerce.number().int().positive() })
export type PresetPreviewQuery = z.infer<typeof PresetPreviewQuerySchema>

export const PresetPreviewResponseSchema = z.object({
  userId: z.number().int(),
  /** 渲染出的 managed.patch.yml 全文（密钥只以 env 名出现） */
  content: z.string(),
  warnings: z.array(z.string()),
})
export type PresetPreviewResponse = z.infer<typeof PresetPreviewResponseSchema>

/** 提供方密钥注入容器的环境变量名：`HUB_MK_<ROUTE_KEY 大写下划线>`（05 §4） */
export function providerKeyEnvName(routeKey: string): string {
  return PROVIDER_KEY_ENV_PREFIX + routeKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}
