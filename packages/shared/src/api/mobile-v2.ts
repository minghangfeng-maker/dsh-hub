import { z } from 'zod'
import {
  DesktopRelayFrameEnvelopeSchema,
  MOBILE_MAX_FRAME_BYTES,
  MOBILE_PROTOCOL_VERSION,
  MobileApprovalSchema,
  MobileClientFrameSchema,
  MobileErrorCodeSchema,
  MobileHistoryItemSchema,
  MobileNodeCapabilitiesSchema,
  MobileNodeSchema,
  MobileQuestionSchema,
  MobileRequestIdSchema,
  MobileServerFrameSchema,
  MobileSessionRowSchema,
  MobileSessionIdSchema,
} from './mobile.js'

/**
 * 手机通道 v2（WP40c-2）—— **只新增，v1 定义一个字节都不改**。
 *
 * 依据：`mobile-plan/v2/M5-通道v2契约.md`（§17「主会话冻结裁决」优先级最高）与
 * `mobile-plan/v2/M5-mobile-v2.draft.ts`。凡与草案不同的地方都在注释里标了 `§17`，
 * 并在 `mobile-plan/v2/WP40c2-进度.md`「与契约的偏差」里逐条说明原因。
 *
 * 三条设计约束（写进类型，不靠注释约束）：
 * 1. **信封仍是 `v:1`**：v2 只靠 `hello.features` 协商（§17 D1）。没声明特性的客户端
 *    收到的帧与 v1 逐字节一致。
 * 2. **客户端 → Hub 依旧 `strictObject`**；Hub → 客户端依旧 `z.object`（可加字段）。
 * 3. **App 永远看不到路径、provider 之外的 DSH 内部标识**：文件用不透明 `fileRef`，
 *    工具只给摘要，spill 路径在 adapter 内就被抹掉（§17「禁止转发 spill 路径」）。
 */

// ── 特性协商（§17 D1） ──────────────────────────────────────────────────────

/**
 * v2 特性 id：App 在 `hello.features` 里声明，Hub 只对**双方都支持**的特性发新帧，
 * 并在 `hello.features` 里回显真正启用的集合（客户端只认回显）。
 *
 * 为什么不用 `v:2`：0.2.0 客户端在线上，改 `v` 会让它只能收到
 * `protocol-version-unsupported`；特性协商让老客户端行为与 v1 完全一致。
 */
export const MOBILE_V2_FEATURES = [
  /** `models` / `set-model` / `model-changed`、`create` 的 model/effort */
  'models',
  /** `tool` 帧 */
  'tools',
  /** `delta.done` + `history[].reasoning` */
  'reasoning',
  /** `file-read` / `file` / `file-chunk` / `file-list` */
  'files',
  /** `deliverable` 帧 */
  'deliverables',
  /** `upload-begin/chunk/abort` + `send.attachments` */
  'attachments',
  /** `rename` / `renamed` */
  'rename',
  /** `archive` / `archived`、`sessions.includeArchived` */
  'archive',
  /** `usage` 请求 / `usage` 回帧：按会话聚合 token 用量（只读统计，不产生副作用） */
  'usage',
  /**
   * `session-state` 服务端帧 / `session-state-request` 客户端帧（WP46，M6 §2）：
   * 会话回合态 + 未决提问/审批的**权威快照**，以及会话行的 `pendingInteractions` 角标。
   * 未协商时 Hub 行为与 0.2.16 一致（不因通道断开 next，但不发快照）。
   */
  'session-state',
] as const
export const MobileV2FeatureSchema = z.enum(MOBILE_V2_FEATURES)
export type MobileV2Feature = z.infer<typeof MobileV2FeatureSchema>

/** 帧类型 → 需要协商的特性（Hub 通道层用它做早拒，避免老 adapter 静默不回帧）。 */
export const MOBILE_V2_FEATURE_OF_FRAME: Readonly<Record<string, MobileV2Feature>> = {
  models: 'models',
  'set-model': 'models',
  rename: 'rename',
  archive: 'archive',
  'file-read': 'files',
  'file-list': 'files',
  'upload-begin': 'attachments',
  'upload-chunk': 'attachments',
  'upload-abort': 'attachments',
  usage: 'usage',
  // WP46：读快照（幂等读）也要先协商，否则 Hub 只能回 feature-unsupported
  'session-state-request': 'session-state',
}

// ── 能力位（增量，与 v1 的 8 个平铺在同一层） ───────────────────────────────

/**
 * v2 能力位：全部 optional（缺省 = false），与 v1 的 8 个**平铺在同一层**。
 *
 * 为什么平铺：桌面中继的 hello 用 v1 的 8 布尔对象，老桌面端只报 8 个字段；
 * 平铺 + optional 让 Hub 能容忍缺项（缺 = false），嵌套对象会让「整块缺失」更难容错。
 */
export const MobileNodeCapabilitiesV2Schema = z.object({
  /** `session/modelCatalog` + `session/selectModel` 都可达 */
  models: z.boolean().optional(),
  /** `session/rename` 可达（且部署挂载了 sessionTitle 服务） */
  rename: z.boolean().optional(),
  /** `workspace/archiveSession|unarchiveSession` + `workspace/follow` 基线可达 */
  archive: z.boolean().optional(),
  /** `workspaceFiles/stat|read|readBytes` 可达 */
  filesRead: z.boolean().optional(),
  /** `workspaceFiles/list` 可达 */
  filesList: z.boolean().optional(),
  /** `/api/session/uploadFileBinary` 或 `fileUploads/upload` 可达 */
  filesUpload: z.boolean().optional(),
  /** `present` 工具在册（事件能力，探测不可靠；UI 只在真收到 `deliverable` 帧时显示） */
  deliverables: z.boolean().optional(),
})
export type MobileNodeCapabilitiesV2 = z.infer<typeof MobileNodeCapabilitiesV2Schema>

/** 合并视图：v1 必填 8 项 + v2 可选 7 项。 */
export const MobileNodeCapabilitiesFullSchema = MobileNodeCapabilitiesSchema.extend(
  MobileNodeCapabilitiesV2Schema.shape,
)
export type MobileNodeCapabilitiesFull = z.infer<typeof MobileNodeCapabilitiesFullSchema>

/** 节点 V2：`capabilities` 用合并视图（老 Hub 只报 8 个也能解析）。 */
export const MobileNodeV2Schema = MobileNodeSchema.extend({
  capabilities: MobileNodeCapabilitiesFullSchema.optional(),
})
export type MobileNodeV2 = z.infer<typeof MobileNodeV2Schema>

export const MobileNodesResponseV2Schema = z.object({
  items: z.array(MobileNodeV2Schema),
  limits: z.object({
    channelsPerUser: z.number().int().positive(),
    channelsPerNode: z.number().int().positive(),
    idleMs: z.number().int().positive(),
    maxFrameBytes: z.number().int().positive(),
  }),
})
export type MobileNodesResponseV2 = z.infer<typeof MobileNodesResponseV2Schema>

// ── 错误码（增量） ──────────────────────────────────────────────────────────

/**
 * v2 新增错误码。纪律：**不把 DSH 的原始 code 透给 App**
 * （`session/attachment-invalid`、`gateway/bad-request` 之类），adapter 必须映射到本表；
 * 映射不到用 `internal`，原码放 `message`。
 */
export const MobileErrorCodeV2ExtraSchema = z.enum([
  /** Host 拒绝模型/档位（竞态）：重拉 models 再试 */
  'model-unavailable',
  /** adapter 预检就发现档位不在该模型 efforts 里：不发上游请求 */
  'effort-unsupported',
  /** `session/create` 的 preset 不存在（DSH `agent-preset/not-found`） */
  'preset-not-found',
  /** 标题非法（DSH `session/title-invalid`） */
  'title-invalid',
  /** 文件不存在（DSH `workspace-file/not-found`） */
  'file-not-found',
  /** **Hub 的防穿越规则拒绝**（绝不回显绝对路径） */
  'file-refused',
  /** 超过 Hub 上限（20 MiB / 图 5 MiB），或 DSH `workspace-file/too-large` */
  'file-too-large',
  /** 用文本通道读二进制（DSH `workspace-file/not-text`） */
  'file-not-text',
  /** 能力位不支持时收到对应帧 */
  'archive-unsupported',
  'rename-unsupported',
  /** 收到本连接没协商的 v2 帧 */
  'feature-unsupported',
])
export type MobileErrorCodeV2Extra = z.infer<typeof MobileErrorCodeV2ExtraSchema>

export const MobileErrorCodeV2Schema = z.union([MobileErrorCodeSchema, MobileErrorCodeV2ExtraSchema])
export type MobileErrorCodeV2 = z.infer<typeof MobileErrorCodeV2Schema>

// ── 思考程度四档（§17 D3：一一对应，四档全部可选） ──────────────────────────

/**
 * App 的固定四档。**这是 UI 词汇，不是 DSH 的 effort id**。
 *
 * §17 D3：低→`off`、中等→`low`、高→`high`、超高→`max`；不另设「不思考」项
 * （「低」就是不思考）。App 只显示中文四档，不显示 DSH 的英文名。
 */
export const MOBILE_EFFORT_TIERS = ['low', 'medium', 'high', 'ultra'] as const
export const MobileEffortTierSchema = z.enum(MOBILE_EFFORT_TIERS)
export type MobileEffortTier = z.infer<typeof MobileEffortTierSchema>

/** 中文标签（App 直接用，避免两端各写一份）。 */
export const MOBILE_EFFORT_TIER_LABELS: Readonly<Record<MobileEffortTier, string>> = {
  low: '低',
  medium: '中等',
  high: '高',
  ultra: '超高',
}

/**
 * App 档位 → DSH effort id（§17 D3 一一对应）。
 *
 * 依据 DSH 0.2.1-rc.2 的 DeepSeek 适配器（`llm-deepseek/src/model-info.ts`）：
 * off=不思考 / low=日常低延迟 / high=默认均衡 / max=最难优先。
 */
export const MOBILE_DSH_EFFORT_BY_TIER: Readonly<Record<MobileEffortTier, string>> = {
  low: 'off',
  medium: 'low',
  high: 'high',
  ultra: 'max',
}

/** App 的默认档（§17：DSH 默认 `high`，也是 App 的默认档）。 */
export const MOBILE_DEFAULT_EFFORT_TIER: MobileEffortTier = 'high'

const DSH_EFFORT_TO_TIER: Readonly<Record<string, MobileEffortTier>> = Object.fromEntries(
  MOBILE_EFFORT_TIERS.map((tier) => [MOBILE_DSH_EFFORT_BY_TIER[tier], tier]),
) as Readonly<Record<string, MobileEffortTier>>

/** 反查：DSH effort id → App 档位；未知 id（别的 provider 起的名字）返回 null，UI 忽略。 */
export function tierOfDshEffort(effortId: string): MobileEffortTier | null {
  return DSH_EFFORT_TO_TIER[effortId] ?? null
}

/** 正查：App 档位 → DSH effort id。 */
export function dshEffortOfTier(tier: MobileEffortTier): string {
  return MOBILE_DSH_EFFORT_BY_TIER[tier]
}

/** 该模型的 `efforts` 里有哪些 App 档可选（`reasoning` 缺失即空数组 → 整块置灰）。 */
export function availableTiers(effortIds: readonly string[]): MobileEffortTier[] {
  const present = new Set<MobileEffortTier>()
  for (const id of effortIds) {
    const tier = tierOfDshEffort(id)
    if (tier !== null) present.add(tier)
  }
  return MOBILE_EFFORT_TIERS.filter((tier) => present.has(tier))
}

/** 单个档位：`id` 是 DSH 原始 id（原样透传），`tier` 是归一后的 App 档（未知为 null）。 */
export const MobileModelEffortSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(64),
  description: z.string().max(500).optional(),
  /** null = 该档不进四档（别的 provider 起的名字）；§17：App 忽略它，不显示。 */
  tier: MobileEffortTierSchema.nullable(),
})
export type MobileModelEffort = z.infer<typeof MobileModelEffortSchema>

/** 一个可选模型。App 不需要 provider 概念，但 `provider` 必须原样回传才能调 DSH。 */
export const MobileModelSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  efforts: z.array(MobileModelEffortSchema).max(16),
  /** 该模型的默认档位（DSH `reasoning.defaultEffort`）；null = 不支持思考。 */
  defaultEffort: z.string().max(64).nullable(),
  /**
   * 输入模态。`image:null` = 未知（§17 D2：不做图片能力位，
   * `session/modelCatalog` 不返回模态，Hub 不猜）。
   */
  input: z.object({ text: z.literal(true), image: z.boolean().nullable() }),
  /**
   * 渠道倍率（可选）：1 = 原价，0.3 = 三折。来自 Hub 中转站「渠道倍率」，
   * 手机端在模型名后显示 `X0.3`。旧 Hub 不发这个字段 = 未知，App 不显示。
   */
  multiplier: z.number().nonnegative().max(10_000).optional(),
})
export type MobileModel = z.infer<typeof MobileModelSchema>

/** 当前选择。`effort` 缺省 = 模型不支持思考（DSH 侧不能传 'off' 冒充）。 */
export const MobileModelSelectionSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  effort: z.string().min(1).max(64).optional(),
})
export type MobileModelSelection = z.infer<typeof MobileModelSelectionSchema>

// ── 文件引用 ────────────────────────────────────────────────────────────────

/** 一次文件引用：对 App 不透明；`pathLabel` 是相对会话根（**永不带绝对路径**）。 */
export const MobileFileRefSchema = z.object({
  fileRef: z.string().min(1).max(2048),
  name: z.string().min(1).max(255),
  pathLabel: z.string().max(1024),
  mediaType: z.enum(['image', 'file']),
  mimeType: z.string().max(128).optional(),
  bytes: z.number().int().nonnegative().optional(),
})
export type MobileFileRef = z.infer<typeof MobileFileRefSchema>

// ── 客户端帧（v2） ──────────────────────────────────────────────────────────

type ClientOption = (typeof MobileClientFrameSchema.options)[number]
type ClientOptionOf<T extends string> = Extract<ClientOption, { shape: { type: z.ZodLiteral<T> } }>

/** 从 v1 的判别联合里取一个变体（按 `type` 字面量），用于 `.extend` 出 v2 超集。 */
function clientVariant<T extends string>(type: T): ClientOptionOf<T> {
  const found = MobileClientFrameSchema.options.find(
    (option) => (option.shape as { type: { value: string } }).type.value === type,
  )
  if (found === undefined) throw new Error(`v1 客户端帧缺少变体 ${type}`)
  return found as unknown as ClientOptionOf<T>
}

/**
 * 发消息时的附件引用。
 *
 * - `image`：Hub 把字节内联成 `session/prompt` 的 `image` part（真视觉输入）；
 * - `file`：Hub 在 `uploaded` 之前已经走 `uploadFileBinary`/`fileUploads/upload` 拿到
 *   `receiptId`，发送时作为 `file` part（模型当普通文件读）。
 *
 * **App 不持有 receiptId**：那是 DSH 的会话内凭据，只存在于 adapter。
 */
export const MobileOutgoingAttachmentSchema = z.strictObject({
  kind: z.enum(['image', 'file']),
  /** Hub 在 `uploaded` 帧里签发的上传凭据。 */
  uploadId: z.string().min(1).max(128),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  bytes: z.number().int().positive(),
})
export type MobileOutgoingAttachment = z.infer<typeof MobileOutgoingAttachmentSchema>

/** `hello`：v1 字段 + 可选 `features`（§17 D1）。 */
export const MobileClientHelloV2Schema = clientVariant('hello').extend({
  /** 去重、保序无所谓；Hub 用集合语义求交集。 */
  features: z.array(MobileV2FeatureSchema).max(16).optional(),
})
export type MobileClientHelloV2 = z.infer<typeof MobileClientHelloV2Schema>

/** `sessions`：v1 字段 + `includeArchived`（§17 D5）。 */
export const MobileClientSessionsV2Schema = clientVariant('sessions').extend({
  /** true = 连已归档会话一起返回（「全部会话 → 已归档」筛选）。 */
  includeArchived: z.boolean().optional(),
})
export type MobileClientSessionsV2 = z.infer<typeof MobileClientSessionsV2Schema>

/**
 * `create`：v1 字段 + preset/model/effort。
 *
 * **没有 cwd**：工作目录由 adapter 写死（云节点 `/workspace/chat`，§17）。客户端传 cwd
 * 会被 `strictObject` 直接拒。
 *
 * 顺序（adapter 内部）：`session/create{cwd}` → 若给了 model → `session/selectModel`；
 * 后者失败**不回滚**会话，`created.warning` 给可读原因。
 */
export const MobileClientCreateV2Schema = clientVariant('create').extend({
  /** 实例上真实存在的 agent preset id（H4 下发的「普通对话」预设）。 */
  preset: z.string().min(1).max(64).optional(),
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  effort: z.string().min(1).max(64).optional(),
})
export type MobileClientCreateV2 = z.infer<typeof MobileClientCreateV2Schema>

/** `send`：v1 字段 + 附件。 */
export const MobileClientSendV2Schema = clientVariant('send').extend({
  attachments: z.array(MobileOutgoingAttachmentSchema).max(10).optional(),
})
export type MobileClientSendV2 = z.infer<typeof MobileClientSendV2Schema>

/** a) 拉模型目录。`sessionId` 可选：带上则同时返回该会话当前选择。 */
export const MobileClientModelsFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('models'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema.optional(),
})

/**
 * b) 切当前会话的模型/强度。
 *
 * 语义与 DSH `session/selectModel` 一致：**只对下一次请求生效**，正在跑的回合不受影响。
 * `effort` 必须是该模型 `efforts[].id` 里的值；adapter 先用缓存的目录预检，
 * 不在列表里直接回 `effort-unsupported`（不发上游请求）。
 */
export const MobileClientSetModelFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('set-model'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  /** 缺省 = 用该模型的 `defaultEffort`；模型不支持思考时**必须**缺省（不能传 'off'）。 */
  effort: z.string().min(1).max(64).optional(),
})

/** h) 重命名。空/超长由 Host 判（`session/title-invalid` → `title-invalid`）。 */
export const MobileClientRenameFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('rename'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  title: z.string().min(1).max(300),
})

/**
 * h) 归档 / 取消归档。
 *
 * **不是删除**：DSH 没有会话删除接口（契约 §10），归档只是从列表隐藏，会话仍在容器里。
 */
export const MobileClientArchiveFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('archive'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  archived: z.boolean(),
})

/**
 * i) 会话用量：客户端按会话要一次聚合统计（token/回合数）。
 *
 * 只在 App 打开「会话信息」面板时按需请求；adapter 从 `session/page` 的
 * `assistant/message.usage` 聚合，**只读**、不产生任何副作用。
 */
export const MobileClientUsageFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('usage'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
})

/**
 * j) 会话快照（幂等读，WP46 / M6 §2.2.4）。
 *
 * Hub 回一份 `session-state` 并带上同一个 `requestId`。App 在「回到前台后想立刻
 * 校正回合态」时用它——不需要重新 subscribe，也就不会扰动别人的跟随流。
 */
export const MobileClientSessionStateRequestSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('session-state-request'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
})

/**
 * f) 读一个文件。二选一给 `fileRef` 或 `path`（相对会话根）。
 *
 * **两者都不经过 App 的路径拼接**：adapter 永远自己算绝对路径并做四步包含检查
 * （含 realpath 兜底），拒绝时只回「不允许访问该路径」，不回显绝对路径。
 */
export const MobileClientFileReadFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('file-read'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  fileRef: z.string().min(1).max(2048).optional(),
  path: z.string().min(1).max(4096).optional(),
})

/** f) 列目录。`'.'`/`'./'` 表示会话根。 */
export const MobileClientFileListFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('file-list'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  path: z.string().min(1).max(4096),
})

/**
 * g) 上传第一步：声明大小与类型，Hub 回 `upload-started{uploadId,maxChunkBytes}`。
 *
 * §17 D4：客户端**只发帧**（不走 HTTP multipart）；云与桌面同一套。
 * 上限：云图片 5 MiB、云文件 20 MiB、桌面单附件 1 MiB（中继帧限制）。
 */
export const MobileClientUploadBeginFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('upload-begin'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  kind: z.enum(['image', 'file']),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  bytes: z.number().int().positive(),
})

/** g) 上传分片：base64，`seq` 从 0 连续递增，`final:true` 收尾。 */
export const MobileClientUploadChunkFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('upload-chunk'),
  requestId: MobileRequestIdSchema,
  uploadId: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  data: z.string(),
  final: z.boolean().optional(),
})

/** g) 放弃一次上传（用户取消）：Hub 丢弃已收字节，无回帧。 */
export const MobileClientUploadAbortFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('upload-abort'),
  uploadId: z.string().min(1).max(128),
})

type ClientTypeExtended = 'hello' | 'sessions' | 'create' | 'send'
type ClientOptionRest = Exclude<ClientOption, { shape: { type: z.ZodLiteral<ClientTypeExtended> } }>
const V1_OPTION_TYPES = new Set<string>(['hello', 'sessions', 'create', 'send'])
/**
 * 与 v1 **逐字段相同**的其余变体：原样复用 v1 的 schema 对象（不重建、不漂移）。
 * 类型上把被 v2 扩展过的四个变体排除掉，否则判别联合里会出现两个 `create`。
 */
const PASS_THROUGH_CLIENT_FRAMES = MobileClientFrameSchema.options.filter(
  (option) => !V1_OPTION_TYPES.has((option.shape as { type: { value: string } }).type.value),
) as unknown as [ClientOptionRest, ...ClientOptionRest[]]

/** 全部客户端帧：v1 的其余变体 + v2 超集变体 + v2 独有帧。 */
export const MobileClientFrameAllSchema = z.discriminatedUnion('type', [
  MobileClientHelloV2Schema,
  MobileClientSessionsV2Schema,
  MobileClientCreateV2Schema,
  MobileClientSendV2Schema,
  ...PASS_THROUGH_CLIENT_FRAMES,
  MobileClientModelsFrameSchema,
  MobileClientSetModelFrameSchema,
  MobileClientRenameFrameSchema,
  MobileClientArchiveFrameSchema,
  MobileClientFileReadFrameSchema,
  MobileClientFileListFrameSchema,
  MobileClientUploadBeginFrameSchema,
  MobileClientUploadChunkFrameSchema,
  MobileClientUploadAbortFrameSchema,
  MobileClientUsageFrameSchema,
  MobileClientSessionStateRequestSchema,
])
export type MobileClientFrameAll = z.infer<typeof MobileClientFrameAllSchema>

// ── 服务端帧（v2） ──────────────────────────────────────────────────────────

type ServerOption = (typeof MobileServerFrameSchema.options)[number]
type ServerOptionOf<T extends string> = Extract<ServerOption, { shape: { type: z.ZodLiteral<T> } }>

function serverVariant<T extends string>(type: T): ServerOptionOf<T> {
  const found = MobileServerFrameSchema.options.find(
    (option) => (option.shape as { type: { value: string } }).type.value === type,
  )
  if (found === undefined) throw new Error(`v1 服务端帧缺少变体 ${type}`)
  return found as unknown as ServerOptionOf<T>
}

/** `hello`：v1 字段 + 实际启用的特性回显 + v2 能力位。 */
export const MobileServerHelloV2Schema = serverVariant('hello').extend({
  /** **Hub 实际启用的**特性（客户端只认这个，不认自己声明的）。 */
  features: z.array(MobileV2FeatureSchema).max(16).optional(),
  capabilitiesV2: MobileNodeCapabilitiesV2Schema.optional(),
})
export type MobileServerHelloV2 = z.infer<typeof MobileServerHelloV2Schema>

/** 会话行：v1 字段 + `archived`（§17 D5：归档页签靠它）。 */
export const MobileSessionRowV2Schema = MobileSessionRowSchema.extend({
  archived: z.boolean().optional(),
  /**
   * 未决提问 + 未决审批的数量（WP46 / M6 §2.4）：抽屉据此给会话加「待回答」角标，
   * 提问不再只在当前打开的会话里可见。0 可省略（老 Hub 不发 = 未知/没有）。
   */
  pendingInteractions: z.number().int().nonnegative().optional(),
  /**
   * 会话发起人（WP56b / docs/24 §6）：**只有座舱节点 `cloud:ops` 的会话带**。
   *
   * 座舱是多个管理员共享同一个容器（共享会话列表），这一行告诉 App「这条是谁开的」。
   * Hub 在通道里登记「座舱会话 id → 创建它的管理员」（该管理员新建会话或首次发消息时），
   * 普通节点的会话行不带这个字段。
   */
  initiator: z
    .object({
      username: z.string().min(1).max(64),
      displayName: z.string().max(64).optional(),
    })
    .optional(),
})
export type MobileSessionRowV2 = z.infer<typeof MobileSessionRowV2Schema>

/** `sessions`：items 允许带 `archived`。 */
export const MobileServerSessionsV2Schema = serverVariant('sessions').extend({
  items: z.array(MobileSessionRowV2Schema),
})
export type MobileServerSessionsV2 = z.infer<typeof MobileServerSessionsV2Schema>

/**
 * `history` 条目：v1 字段 + `reasoning`（截断到 16 KiB）。
 *
 * 为什么要在 history 里带：DSH 的 `assistant-baseline` 只展开 text-chunks，
 * 不含 reasoning —— 不带的话重进会话思考内容就丢了。
 */
export const MobileHistoryItemV2Schema = MobileHistoryItemSchema.extend({
  reasoning: z
    .string()
    .max(16 * 1024)
    .optional(),
})
export type MobileHistoryItemV2 = z.infer<typeof MobileHistoryItemV2Schema>

export const MobileServerHistoryV2Schema = serverVariant('history').extend({
  items: z.array(MobileHistoryItemV2Schema),
})
export type MobileServerHistoryV2 = z.infer<typeof MobileServerHistoryV2Schema>

/** `delta`：v1 字段 + `done`（对应 reasoning 块的 `block-end`）。 */
export const MobileServerDeltaV2Schema = serverVariant('delta').extend({
  /** 该块结束：App 可以立即收起「正在思考」，不用靠超时。 */
  done: z.literal(true).optional(),
})
export type MobileServerDeltaV2 = z.infer<typeof MobileServerDeltaV2Schema>

/** c) 新建结果：回显真正生效的 preset/model（可能与请求不同）。 */
export const MobileServerCreatedV2Schema = serverVariant('created').extend({
  preset: z.string().max(64).optional(),
  model: MobileModelSelectionSchema.optional(),
  /** 例如 selectModel 失败但会话已建好：给出可读原因，**不回滚**。 */
  warning: z.object({ code: MobileErrorCodeV2Schema, message: z.string().max(500) }).optional(),
})
export type MobileServerCreatedV2 = z.infer<typeof MobileServerCreatedV2Schema>

/** a) 模型目录：provider 分组已摊平，App 只按 `model` 选。 */
export const MobileServerModelsFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('models'),
  requestId: MobileRequestIdSchema,
  default: MobileModelSelectionSchema,
  /** 仅当请求带了 `sessionId`。 */
  current: MobileModelSelectionSchema.optional(),
  items: z.array(MobileModelSchema).max(64),
  /** 拿不到模型的 provider（网络/凭据）；**不**代表整个能力不可用。 */
  failures: z
    .array(
      z.object({
        provider: z.string().max(64),
        name: z.string().max(120),
        message: z.string().max(500),
      }),
    )
    .max(16),
})
export type MobileServerModelsFrame = z.infer<typeof MobileServerModelsFrameSchema>

/** b) 选择变化：既作为 `set-model` 应答（带 requestId），也作为投影变化的推送。 */
export const MobileServerModelChangedFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('model-changed'),
  requestId: MobileRequestIdSchema.optional(),
  sessionId: MobileSessionIdSchema,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  effort: z.string().min(1).max(64).optional(),
})
export type MobileServerModelChangedFrame = z.infer<typeof MobileServerModelChangedFrameSchema>

/**
 * d) 工具卡（`tool` 帧）。
 *
 * 数据源：`tool/call`（start）+ `tool/result`（end）两个 durable 事件；
 * `assistant-stream` 的 `tool-call-delta` 只用来**更早**发 start。
 * `seq` = 对应事件的序号，客户端按它把工具卡与消息合并排序。
 */
export const MobileToolFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('tool'),
  sessionId: MobileSessionIdSchema,
  callId: z.string().min(1).max(128),
  /** 白名单种类；未知工具统一 `other`（不把 DSH 原始工具名当 UI 分类）。 */
  kind: z.enum([
    'bash',
    'python',
    'search',
    'fetch',
    'file-read',
    'file-write',
    'present',
    'question',
    'agent',
    'other',
  ]),
  /** 原始工具名：只用于排障与「其它」卡片标题兜底。 */
  name: z.string().max(64),
  phase: z.enum(['start', 'end']),
  seq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  /** `phase=end` 才确定。 */
  status: z.enum(['running', 'ok', 'error']).optional(),
  /** 人话标题，adapter 生成（「运行命令」「搜索网页」「交付文件」…）。 */
  title: z.string().max(120),
  /** 截断后 ≤ 4096 字节 UTF-8（按码点边界截，截断处追加 `…`）。 */
  inputPreview: z.string().max(4096).optional(),
  outputPreview: z.string().max(4096).optional(),
  /** 截断前的真实字节数（UI 显示「已截断」）。 */
  inputBytes: z.number().int().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  truncated: z.object({ input: z.literal(true).optional(), output: z.literal(true).optional() }).optional(),
  /** 工具产出/引用的文件（§8.2 的抽取规则，只给 fileRef）。 */
  files: z.array(MobileFileRefSchema).max(8).optional(),
  /** 搜索类引用的来源；拿不到就空。 */
  citations: z
    .array(z.object({ title: z.string().max(200).optional(), url: z.string().max(2048) }))
    .max(8)
    .optional(),
  /** 失败身份（`tool/result.data.error`）。 */
  error: z
    .object({
      name: z.string().max(80),
      code: z.string().max(80),
      reason: z.string().max(500).optional(),
    })
    .optional(),
  /** 工具耗时（`job/registered`→`job/settled` 或 start/end 时间差）。 */
  durationMs: z.number().int().nonnegative().optional(),
})
export type MobileToolFrame = z.infer<typeof MobileToolFrameSchema>

/** f) 交付物：来自 `deliverables/presented` 事件（没有列表端点，只能扫事件）。 */
export const MobileDeliverableFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('deliverable'),
  sessionId: MobileSessionIdSchema,
  seq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  callId: z.string().min(1).max(128),
  files: z.array(MobileFileRefSchema).min(1).max(8),
})
export type MobileDeliverableFrame = z.infer<typeof MobileDeliverableFrameSchema>

export const MobileServerRenamedFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('renamed'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  title: z.string().max(300),
  seq: z.number().int().nonnegative(),
})
export type MobileServerRenamedFrame = z.infer<typeof MobileServerRenamedFrameSchema>

/** h) 归档结果：`sessionIds` 是归档**之后**的完整集合，App 直接替换本地集合。 */
export const MobileServerArchivedFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('archived'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  archived: z.boolean(),
  sessionIds: z.array(MobileSessionIdSchema),
})
export type MobileServerArchivedFrame = z.infer<typeof MobileServerArchivedFrameSchema>

/**
 * i) 会话用量统计（`usage` 回帧）。
 *
 * 口径：把 `assistant/message.usage` 逐条累加（每次请求的 prompt/completion 都算），
 * `totalTokens` 用 Host 报的单步 total（= input + output + cacheRead）累加。
 * `truncated:true` 表示只统计了最近的若干页（超长会话），面板要提示「已截断」。
 */
export const MobileSessionUsageStatsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  /** assistant/message 事件数（含中间步骤） */
  assistantMessages: z.number().int().nonnegative(),
  /** 用户消息数（source.kind === 'user'） */
  userMessages: z.number().int().nonnegative(),
  /** turn/start 计数 */
  turns: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /**
   * 会话积分消耗（**微积分**，1 积分 = 1_000_000 微积分）。口径与 Hub 计费一致：
   * 每条 `assistant/message.usage` × 该消息模型的价格 × 渠道倍率 × 钱包倍率，逐条累加。
   * 没有价格信息的消息（例如 Claude/Codex 渠道）不计入。旧 Hub 不发 = 未知。
   */
  pointsMicro: z.number().int().nonnegative().optional(),
  /** pointsMicro 里是否只统计了部分消息（有消息没有价格信息）。 */
  pointsEstimated: z.boolean().optional(),
})
export type MobileSessionUsageStats = z.infer<typeof MobileSessionUsageStatsSchema>

export const MobileServerUsageFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('usage'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  stats: MobileSessionUsageStatsSchema,
})
export type MobileServerUsageFrame = z.infer<typeof MobileServerUsageFrameSchema>

// ── 会话快照（WP46，M6 §2） ─────────────────────────────────────────────────

/**
 * 未决提问（与 `question` 帧的元素同构：`agent/callId/questions/state`）。
 *
 * M6 §2.1 冻结形状：**不含** `sessionId`（外层帧已经带了），`state` 只有
 * `open`（`$events` 前台提问）与 `continued`（投影里仍可继续回答的问题）两种。
 */
export const MobilePendingQuestionSchema = z.object({
  agent: z.string().min(1).max(128),
  callId: z.string().min(1).max(128),
  questions: z.array(MobileQuestionSchema).min(1).max(32),
  state: z.enum(['open', 'continued']),
})
export type MobilePendingQuestion = z.infer<typeof MobilePendingQuestionSchema>

/**
 * `session-state`：该会话回合态与未决交互的**权威快照**（WP46，M6 §2.1）。
 *
 * 客户端语义（M6 §2.3）：收到即用 `running/questions/approvals` **整体替换**本地状态，
 * 不是合并。Hub 在四个时机发它：`subscribe` 的 replay 边界之后、`running` 变化、
 * 未决集合变化、以及 `session-state-request` 的回包。
 *
 * `requestId` 是**可选加法字段**：M6 §2.1 的字面形状里没有它，但 §2.2.4 要求
 * 「回一份并带同 `requestId`」，两处都满足只能做成可选（主动推送时不带）。
 */
export const MobileServerSessionStateFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('session-state'),
  requestId: MobileRequestIdSchema.optional(),
  sessionId: MobileSessionIdSchema,
  /** 该快照对应的会话游标（与 `replay.toCursor` 同口径；未知为 null）。 */
  cursor: z.number().int().nonnegative().nullable(),
  /** Host 的 agent 运行态（权威）。 */
  running: z.boolean(),
  /** 进行中的 attempt（running=false 时为 null）。 */
  attemptId: z.string().max(128).nullable(),
  /** 未决提问（与 `question` 帧的元素同构：agent/callId/questions/state）。 */
  questions: z.array(MobilePendingQuestionSchema).max(16),
  /** 未决审批（`MobileApprovalSchema`）。 */
  approvals: z.array(MobileApprovalSchema).max(16),
  /** 服务端时间 ISO，便于诊断。 */
  at: z.string(),
})
export type MobileServerSessionStateFrame = z.infer<typeof MobileServerSessionStateFrameSchema>

/**
 * f) 一次性文件（原始 ≤ 96 KiB）。
 *
 * `sha256` 是**新增的加法字段**：App 校验完整性，也让集成测试不必再问容器要哈希
 * （Hub → 客户端本来就允许加字段）。
 */
export const MobileServerFileFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('file'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  fileRef: z.string().min(1).max(2048),
  name: z.string().max(255),
  mediaType: z.enum(['image', 'file']),
  mimeType: z.string().max(128),
  bytes: z.number().int().nonnegative(),
  encoding: z.literal('base64'),
  data: z.string(),
  sha256: z.string().length(64).optional(),
})
export type MobileServerFileFrame = z.infer<typeof MobileServerFileFrameSchema>

/**
 * f) 分片文件：每片原始 ≤ 144 KiB（base64 后 192 KiB，整帧仍在 256 KiB 内）。
 * `seq` 从 0 递增，`final` 结束；`bytes`/`sha256` 只在 `final:true` 给。
 */
export const MobileServerFileChunkFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('file-chunk'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  fileRef: z.string().min(1).max(2048),
  seq: z.number().int().nonnegative(),
  final: z.boolean(),
  encoding: z.literal('base64'),
  data: z.string(),
  /** 原始字节数（仅 `final:true`）。 */
  bytes: z.number().int().nonnegative().optional(),
  /** 整个文件的 sha256（仅 `final:true`）。 */
  sha256: z.string().length(64).optional(),
})
export type MobileServerFileChunkFrame = z.infer<typeof MobileServerFileChunkFrameSchema>

export const MobileServerFileListFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('file-list'),
  requestId: MobileRequestIdSchema,
  sessionId: MobileSessionIdSchema,
  /** 相对会话根；根是空串（DSH 的 list 就返回空串）。 */
  path: z.string().max(1024),
  entries: z
    .array(
      z.object({
        name: z.string().max(255),
        kind: z.enum(['file', 'directory', 'other']),
        bytes: z.number().int().nonnegative().optional(),
        fileRef: z.string().max(2048).optional(),
      }),
    )
    .max(500),
  truncated: z.boolean(),
})
export type MobileServerFileListFrame = z.infer<typeof MobileServerFileListFrameSchema>

/** g) 上传开始：`uploadId` + 单片上限（App 按它切片）。 */
export const MobileServerUploadStartedFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('upload-started'),
  requestId: MobileRequestIdSchema,
  uploadId: z.string().min(1).max(128),
  maxChunkBytes: z.number().int().positive(),
})
export type MobileServerUploadStartedFrame = z.infer<typeof MobileServerUploadStartedFrameSchema>

/** g) 分片已收：`received` 是累计字节数（App 据此显示进度）。 */
export const MobileServerUploadReceivedFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('upload-received'),
  requestId: MobileRequestIdSchema,
  uploadId: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(),
})
export type MobileServerUploadReceivedFrame = z.infer<typeof MobileServerUploadReceivedFrameSchema>

/** g) 上传完成：`send.attachments[]` 引用这个 `uploadId`。 */
export const MobileServerUploadedFrameSchema = z.object({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('uploaded'),
  requestId: MobileRequestIdSchema,
  uploadId: z.string().min(1).max(128),
  kind: z.enum(['image', 'file']),
  name: z.string().max(255),
  mimeType: z.string().max(128),
  bytes: z.number().int().nonnegative(),
  /** 上传凭据的有效期（毫秒时间戳）；过期后 Hub 丢弃字节，`send` 会报 `file-not-found`。 */
  expiresAt: z.number().int().nonnegative(),
})
export type MobileServerUploadedFrame = z.infer<typeof MobileServerUploadedFrameSchema>

export const MobileServerErrorV2Schema = serverVariant('error').extend({ code: MobileErrorCodeV2Schema })

/** `bye` 也允许 v2 错误码（例如 `feature-unsupported` 导致的服务端主动关闭）。 */
export const MobileServerByeV2Schema = serverVariant('bye').extend({ code: MobileErrorCodeV2Schema })

type ServerTypeExtended = 'hello' | 'sessions' | 'history' | 'delta' | 'created' | 'error' | 'bye'
type ServerOptionRest = Exclude<ServerOption, { shape: { type: z.ZodLiteral<ServerTypeExtended> } }>
const SERVER_V1_EXTENDED = new Set<string>([
  'hello',
  'sessions',
  'history',
  'delta',
  'created',
  'error',
  'bye',
])
const PASS_THROUGH_SERVER_FRAMES = MobileServerFrameSchema.options.filter(
  (option) => !SERVER_V1_EXTENDED.has((option.shape as { type: { value: string } }).type.value),
) as unknown as [ServerOptionRest, ...ServerOptionRest[]]

/** 全部服务端帧（v1 其余变体 + v2 超集变体 + v2 独有帧）。 */
export const MobileServerFrameAllSchema = z.discriminatedUnion('type', [
  MobileServerHelloV2Schema,
  MobileServerSessionsV2Schema,
  MobileServerHistoryV2Schema,
  MobileServerDeltaV2Schema,
  MobileServerCreatedV2Schema,
  MobileServerErrorV2Schema,
  MobileServerByeV2Schema,
  ...PASS_THROUGH_SERVER_FRAMES,
  MobileServerModelsFrameSchema,
  MobileServerModelChangedFrameSchema,
  MobileToolFrameSchema,
  MobileDeliverableFrameSchema,
  MobileServerRenamedFrameSchema,
  MobileServerArchivedFrameSchema,
  MobileServerFileFrameSchema,
  MobileServerFileChunkFrameSchema,
  MobileServerFileListFrameSchema,
  MobileServerUploadStartedFrameSchema,
  MobileServerUploadReceivedFrameSchema,
  MobileServerUploadedFrameSchema,
  MobileServerUsageFrameSchema,
  MobileServerSessionStateFrameSchema,
])
export type MobileServerFrameAll = z.infer<typeof MobileServerFrameAllSchema>

// ── 中继外层（桌面 ↔ Hub）：能力位换成合并视图 ──────────────────────────────

/** 桌面 relay hello：`capabilities` 允许带 v2 位（老桌面端只报 8 个也照样解析）。 */
type RelayOption = (typeof DesktopRelayFrameEnvelopeSchema.options)[number]
type RelayHelloOption = Extract<RelayOption, { shape: { type: z.ZodLiteral<'hello'> } }>
const relayHelloV1 = DesktopRelayFrameEnvelopeSchema.options[0] as unknown as RelayHelloOption

export const DesktopRelayHelloV2Schema = relayHelloV1.extend({
  capabilities: MobileNodeCapabilitiesFullSchema.nullable(),
  /**
   * **中继层能放行的 v2 特性**（WP48 / 评估 R1）。
   *
   * 为什么需要它：桌面 connector 的 relay 只放行 v1 的 11 种客户端帧
   * （`hub-connector/src/channel/relay.ts` 的 `CLIENT_FRAME_TYPES`），v2 独有帧在
   * 中继层就被丢掉并回 `unsupported phone frame` —— 根本到不了 adapter。
   * 所以「adapter 支持 v2」不等于「这条桌面通道能用 v2」。
   *
   * 约定（向后兼容）：
   * - **旧 connector 不发这个字段** → 视为只支持 v1 → Hub 把 hello 的 `features`
   *   清空（v1 降级），App 就不会点亮压根不能用的界面；
   * - 新 connector 在 hello 里声明它放行的特性集合，Hub 只回显
   *   `adapter 回显 ∩ relayFeatures`。
   */
  relayFeatures: z.array(MobileV2FeatureSchema).max(16).optional(),
})

/** 桌面 ↔ Hub 的完整外层：v2 帧不再被 Hub 的 v1 校验丢掉。 */
type RelayRestOption = Exclude<RelayOption, RelayHelloOption>
const relayRestV1 = DesktopRelayFrameEnvelopeSchema.options.slice(1) as unknown as [
  RelayRestOption,
  ...RelayRestOption[],
]
export const DesktopRelayFrameEnvelopeV2Schema = z.discriminatedUnion('type', [
  DesktopRelayHelloV2Schema,
  ...relayRestV1,
])
export type DesktopRelayFrameEnvelopeV2 = z.infer<typeof DesktopRelayFrameEnvelopeV2Schema>

// ── 限额常量 ────────────────────────────────────────────────────────────────

/**
 * 单帧上限沿用 262 144。
 *
 * §17 D4 要求「每块不超过 192KiB」。若按**原始 192 KiB** 切片，base64 后正好 262 144
 * 字节，加上 JSON 信封就超了 256 KiB 的帧上限。所以这里取
 * **144 KiB 原始（→ 192 KiB base64）**：满足「每块数据 ≤192KiB」，整帧仍 < 256 KiB。
 */
export const MOBILE_V2_MAX_FRAME_BYTES = MOBILE_MAX_FRAME_BYTES
/** 分块原始字节：144 KiB → base64 192 KiB。 */
export const MOBILE_V2_FILE_CHUNK_RAW_BYTES = 144 * 1024
/** `file` 一次性内联的原始上限（超过就走 `file-chunk`）。 */
export const MOBILE_V2_FILE_INLINE_RAW_BYTES = 96 * 1024
/** 单个文件的总上限（与 DSH 的 `imageLimits.maxImageBytes` 对齐）。 */
export const MOBILE_V2_FILE_MAX_BYTES = 20 * 1024 * 1024
/** 图片附件上限（云节点；App 侧应先降采样到长边 ≤2048px）。 */
export const MOBILE_V2_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** 云节点单附件上限。 */
export const MOBILE_V2_UPLOAD_MAX_BYTES = 20 * 1024 * 1024
/** 桌面节点单附件上限（中继 1 MiB/帧，§17 D4）。 */
export const MOBILE_V2_DESKTOP_UPLOAD_MAX_BYTES = 1 * 1024 * 1024
/** 工具预览的截断上限（UTF-8 字节）。 */
export const MOBILE_V2_TOOL_PREVIEW_BYTES = 4096
/** `tool` 帧序列化后的整帧上限。 */
export const MOBILE_V2_TOOL_FRAME_BYTES = 12 * 1024
/** 历史里 reasoning 的截断上限。 */
export const MOBILE_V2_HISTORY_REASONING_BYTES = 16 * 1024
/** 上传凭据的默认有效期。 */
export const MOBILE_V2_UPLOAD_TTL_MS = 10 * 60_000
