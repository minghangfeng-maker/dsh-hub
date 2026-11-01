/**
 * 管理座舱（docs/24）契约：能力目录、`/ops/*` 与 `/api/admin/cockpit/*` 的请求 / 响应、
 * 方案、画布、密钥请求、SSE 事件。
 *
 * 这里是 docs/24 §3 的唯一落点（zod = 真相，类型由 `z.infer` 推导）：
 * 座舱 DSH 侧（WP56b 的 `@dshhub/ops` 插件）、Hub 前端（WP56c）与 App 嵌入模式（WP56d）
 * 都只认这一份；改字段前先改 docs/24。
 */
import { z } from 'zod'
import { IsoDateTimeSchema } from '../common.js'

// ── 常量（docs/24 §3.1 / §3.4 / I4） ────────────────────────────────────────

/** 管理员前缀（cookie 会话 + `X-Hub-Csrf`）；座舱 DSH 前缀挂在内部监听器上 */
export const COCKPIT_ADMIN_PREFIX = '/api/admin/cockpit'
export const COCKPIT_OPS_PREFIX = '/ops'

/** 方案有效期 30 分钟（§3 `ProposalView.expiresAt`） */
export const COCKPIT_PROPOSAL_TTL_MINUTES = 30
/** 密钥引用 15 分钟未使用即删（§3.4） */
export const COCKPIT_SECRET_TTL_MINUTES = 15
/** 交接码 60 秒、一次性（§3.3） */
export const COCKPIT_HANDOFF_TTL_SECONDS = 60
/** 每会话画布卡上限，超出时最旧的非钉住卡被移除（§3.1） */
export const COCKPIT_CANVAS_MAX_ITEMS = 60
/** 同时 pending 的方案上限（§3.1） */
export const COCKPIT_PENDING_PROPOSALS_MAX = 20
/** `/ops/*` 每分钟调用上限（§3.1） */
export const COCKPIT_OPS_RATE_LIMIT_PER_MIN = 120
/** 能力输出（`data`）序列化后的上限；超出截断并 `truncated=true`（§3.1） */
export const COCKPIT_DATA_MAX_BYTES = 64 * 1024
/** 表格行上限（§3.1） */
export const COCKPIT_TABLE_MAX_ROWS = 2000
/** DSH 写的方案说明上限（§3 `ProposalView.rationale`） */
export const COCKPIT_RATIONALE_MAX = 2000
/** 步骤上限（§3 `ProposalView.steps`） */
export const COCKPIT_STEPS_MAX = 20
/** markdown 卡正文上限（§3 `CanvasSpec`） */
export const COCKPIT_MARKDOWN_MAX = 4000
/** 舷位（§1 投放规则）：Hub 解析后只可能是 left / right */
export const CanvasPlacementSchema = z.enum(['left', 'right'])
export type CanvasPlacement = z.infer<typeof CanvasPlacementSchema>

/** DSH 请求时可以写 'auto'：数据类投左舷、行动类投右舷 */
export const CanvasPlacementRequestSchema = z.enum(['left', 'right', 'auto'])
export type CanvasPlacementRequest = z.infer<typeof CanvasPlacementRequestSchema>

/** 卡片高度档位（缺省 m） */
export const CanvasSizeSchema = z.enum(['s', 'm', 'l'])
export type CanvasSize = z.infer<typeof CanvasSizeSchema>

/** `auto` 的解析规则（§1）：数据类 → 左舷，行动类 → 右舷 */
export const CANVAS_LEFT_KINDS = ['stats', 'chart', 'table', 'logs', 'markdown', 'entity'] as const
export const CANVAS_RIGHT_KINDS = ['proposal', 'job', 'secret-request'] as const

/** 密钥引用前缀（§3.4） */
export const COCKPIT_SECRET_REF_PREFIX = 'sec_'
/** 脱敏占位（I4） */
export const COCKPIT_REDACTION_PLACEHOLDER = '[已隐藏]'
/** 键名里出现这些**子串**即脱敏（I4 的老规则，保持逐字不变） */
export const COCKPIT_REDACT_KEY_PATTERN = /(key|token|secret|password|cookie|subscription|credential)/i

/**
 * 键名里出现这些**整词**即脱敏（I4 加固，WP56e1）：`authorization` / `auth` / `bearer` /
 * `private` / `dsn`。
 *
 * 为什么必须「整词」而不能是子串：子串会误伤 `author`、`authorId`、`authorizeUrl`（桌面端授权地址，
 * 要让用户点开，不是凭据）、`reauthMinutes`。判定实现是**按词切分后比较**
 * （`capabilities/redact.ts` 的 `isSensitiveKey`）：`authHeader` / `x-auth-token` / `privateKey` /
 * `dsnUrl` 切成 `[auth, header]`… 命中；`authorId` 切成 `[author, id]` 不命中。
 *
 * 用代码切词而不是一条正则，是因为 `i` 标志下的 `[^a-z]` 连大写字母也一起排除，
 * 没法同时表达「前面不是字母」和「后面可以是大写开头的下一个词」。
 */
export const COCKPIT_REDACT_KEY_WORDS = ['authorization', 'auth', 'bearer', 'private', 'dsn'] as const

/**
 * I4 的「按值」规则（WP56e1 加固）：光看键名拦不住自由文本里的凭据
 * （`authorization: 'Bearer …'`、日志里的 `sk-…`、订阅地址上的 `token=`），
 * 所以输出里的**每个字符串**再过一遍这些形态，命中即整段或局部替换成 `[已隐藏]`。
 *
 * 顺序有意义：`Bearer …` 必须排在 JWT 之前（否则整段头只隐藏后半段）；其余是「强形态在前、
 * 嵌在文本/URL 里的片段在后」。
 *
 * 每条都是 `g` 正则：`String.prototype.replace` 在全局模式下会先把 `lastIndex` 归零、结束时也归零，
 * 所以这些常量正则可以安全地被反复使用（`capabilities/redact.ts` 的 `redactValueText`）。
 */
export const COCKPIT_REDACT_VALUE_RULES: readonly {
  /** 形态说明（给文档与测试用） */
  label: string
  /** `g` 正则；替换文本里 `$1` 这类捕获组按 `String.replace` 语义生效 */
  pattern: RegExp
  replacement: string
}[] = [
  // OpenAI / Anthropic / 中转站常见 API Key：sk-…、sk-ant-…、sk-proj-…
  { label: 'sk-key', pattern: /\bsk-[A-Za-z0-9_-]{12,}/g, replacement: COCKPIT_REDACTION_PLACEHOLDER },
  // GitHub 令牌：ghp_/gho_/ghu_/ghs_/ghr_ 与细粒度 PAT
  {
    label: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    replacement: COCKPIT_REDACTION_PLACEHOLDER,
  },
  {
    label: 'github-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: COCKPIT_REDACTION_PLACEHOLDER,
  },
  // Authorization 头：整段（含 Bearer 前缀）一起隐藏，避免只隐藏后半段后前缀还在。
  // **必须排在 jwt 之前**：`Bearer eyJ…` 先被整段吃掉，否则 jwt 规则会先替换掉后半段。
  {
    label: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
    replacement: COCKPIT_REDACTION_PLACEHOLDER,
  },
  // JWT 三段式（header 以 eyJ 开头）
  {
    label: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: COCKPIT_REDACTION_PLACEHOLDER,
  },
  // AWS 访问键 id
  { label: 'aws-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: COCKPIT_REDACTION_PLACEHOLDER },
  // URL 里的 user:pass@：保留协议与主机，凭据段隐藏
  {
    label: 'url-userinfo',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/:@]+@/gi,
    replacement: `$1${COCKPIT_REDACTION_PLACEHOLDER}@`,
  },
  // 订阅链接 / 回调地址里的 query 凭据：token=、access_token=、api_key=…
  {
    label: 'query-credential',
    pattern: /(^|[\s?&;])((?:access_)?token|api_?key|key|secret|password|sign|signature)=([^&\s"'#]+)/gi,
    replacement: `$1$2=${COCKPIT_REDACTION_PLACEHOLDER}`,
  },
]
/**
 * I4 的例外：纯计数字段（中转站用量里的 token **数量**）。
 * 它们命中上面的模式，但只是计数、不含凭据，隐藏了 `relay.usage` 就没法回答「谁用了多少」。
 *
 * **只对 number / null 放行**：同名键的值一旦是字符串（`{ totalTokens: 'sk-live-…' }` 这种
 * 「名字像计数、其实是密钥」的形态）或对象/数组，照旧替换成 `[已隐藏]`。
 */
export const COCKPIT_REDACT_SAFE_KEYS = [
  'tokens',
  'inputtokens',
  'outputtokens',
  'totaltokens',
  'cachedtokens',
  'cachereadtokens',
  'cachewritetokens',
  'tokensin',
  'tokensout',
  'maxtokens',
  'tokenusage',
] as const

// ── 能力（§3 / §4） ─────────────────────────────────────────────────────────

/** 风险等级（§0）：R0 只读、R1 低风险可逆、R2 有影响、R3 敏感 */
export const CapabilityRiskSchema = z.enum(['R0', 'R1', 'R2', 'R3'])
export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>

/** 能力归属域（与经典页面对应，§3 `CockpitArea`） */
export const CockpitAreaSchema = z.enum([
  'overview',
  'users',
  'instances',
  'rollouts',
  'plugins',
  'runtimes',
  'models',
  'agent-modes',
  'search',
  'jobs',
  'relay',
  'compute',
  'desktop',
  'mobile',
  'invites',
  'settings',
  'audit',
])
export type CockpitArea = z.infer<typeof CockpitAreaSchema>
export const COCKPIT_AREAS = CockpitAreaSchema.options

/** `z.toJSONSchema` 的产出（给模型看的参数说明；运行时校验永远走 zod 本体） */
export const JsonSchemaSchema = z.record(z.string(), z.unknown())
export type JsonSchema = Record<string, unknown>

/** 能力目录项（座舱 DSH 通过 `/ops/catalog` 拿到；Hub 前端显示方案步骤名用） */
export const CapabilityDescriptorSchema = z.object({
  /** `域.动词`：`users.list`、`instances.stop`、`rollouts.plugin`… */
  id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, '能力 id 形如 users.list'),
  area: CockpitAreaSchema,
  /** 中文短名：「列出用户」 */
  title: z.string().min(1).max(60),
  /** 写给模型看的说明：何时用、注意什么（中文，≤ 300 字） */
  description: z.string().min(1).max(300),
  risk: CapabilityRiskSchema,
  /** 由 zod 生成（`z.toJSONSchema`），DSH 按它组参数 */
  input: JsonSchemaSchema,
  /** 这些参数只接受 secretRef（§3.4） */
  secretFields: z.array(z.string()).optional(),
  /** true = 可作为画布数据源（只能是 R0） */
  dataSource: z.boolean().optional(),
  /** 经典页面对应地址，方案卡/实体卡上「在经典页面打开」用 */
  classicPath: z.string().optional(),
})
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>

// ── 方案（§3） ──────────────────────────────────────────────────────────────

export const ProposalStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'rejected',
  'expired',
])
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>

/** 方案里一步执行完的记录（`ProposalView.outcome`） */
export const ProposalOutcomeStepSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string().max(64),
      message: z.string().max(500),
    })
    .optional(),
})
export type ProposalOutcomeStep = z.infer<typeof ProposalOutcomeStepSchema>

/** 影响面里的一条（谁会被影响） */
export const ProposalAffectedSchema = z.object({
  kind: z.enum(['user', 'instance', 'device', 'plugin', 'model', 'job']),
  id: z.union([z.string(), z.number()]),
  label: z.string().max(200),
})
export type ProposalAffected = z.infer<typeof ProposalAffectedSchema>

/** Hub 在创建方案时算好并存库的影响面（I3：DSH 的 rationale 不参与） */
export const ProposalPreviewSchema = z.object({
  /** 「影响 8 个用户；其中 2 个实例运行中，下次启动生效」 */
  summary: z.string().min(1).max(500),
  affected: z.array(ProposalAffectedSchema).max(2000).optional(),
  warnings: z.array(z.string().max(300)).max(50).optional(),
  /** 能力自定义（如 rollouts/preview 的逐人结果） */
  detail: z.unknown().optional(),
})
export type ProposalPreview = z.infer<typeof ProposalPreviewSchema>

export const ProposalStepSchema = z.object({
  capability: z.string().max(64),
  /** 已校验；secretRef 只显示引用号 */
  args: z.record(z.string(), z.unknown()),
  preview: ProposalPreviewSchema,
})
export type ProposalStep = z.infer<typeof ProposalStepSchema>

export const ProposalViewSchema = z.object({
  id: z.number().int().positive(),
  sessionId: z.string().min(1).max(200),
  /** DSH 起的标题 */
  title: z.string().min(1).max(200),
  /** DSH 的说明（原样展示，≤ 2000 字，纯文本） */
  rationale: z.string().max(COCKPIT_RATIONALE_MAX),
  /** 各步最高级 */
  risk: CapabilityRiskSchema,
  /** 1–20 步，按顺序执行，遇错停止 */
  steps: z.array(ProposalStepSchema).min(1).max(COCKPIT_STEPS_MAX),
  status: ProposalStatusSchema,
  createdAt: IsoDateTimeSchema,
  /** 创建后 30 分钟 */
  expiresAt: IsoDateTimeSchema,
  decidedBy: z.object({ id: z.number().int(), username: z.string() }).optional(),
  decidedAt: IsoDateTimeSchema.optional(),
  outcome: z.array(ProposalOutcomeStepSchema).optional(),
})
export type ProposalView = z.infer<typeof ProposalViewSchema>

// ── 画布（§3） ─────────────────────────────────────────────────────────────

export const EntityKindSchema = z.enum([
  'user',
  'instance',
  'plugin',
  'runtime',
  'model',
  'job',
  'device',
  'relay-channel',
])
export type EntityKind = z.infer<typeof EntityKindSchema>

/** 画布数据：DSH 内联（标注「DSH 计算」）或 Hub 数据源引用（用管理员身份重查） */
export const CanvasDataSourceSchema = z.object({
  source: z.object({
    capability: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
    refreshSec: z.number().int().min(0).max(3600).optional(),
  }),
})
export type CanvasDataSource = z.infer<typeof CanvasDataSourceSchema>

export const CanvasDataSchema = z.union([
  z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(COCKPIT_TABLE_MAX_ROWS) }),
  CanvasDataSourceSchema,
])
export type CanvasData = z.infer<typeof CanvasDataSchema>

/**
 * 一个指标（`stats` 卡的一项；`data.source` 卡则是一行 → 一项，见下）。
 *
 * WP56h 追加两个**可选**字段，老的 `{label,value}` 卡片一个字节都不用改：
 * - `max`：有就画环形仪表（value/max），用于「5 / 8 台实例在跑」这种有上限的数；
 * - `spark`：有就画迷你走势线（≤60 点，取最近的若干点），用于「今日请求」这类要看变化的数。
 */
export const CanvasStatsItemSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.union([z.number(), z.string()]),
  unit: z.string().max(16).optional(),
  delta: z.number().optional(),
  tone: z.enum(['neutral', 'good', 'warn', 'bad']).optional(),
  /** 上限（>0 才画环形仪表；value 超出按满环算） */
  max: z.number().positive().optional(),
  /** 迷你走势（最多 60 点，从旧到新） */
  spark: z.array(z.number().finite()).max(60).optional(),
})
export type CanvasStatsItem = z.infer<typeof CanvasStatsItemSchema>

export const CanvasTableColumnSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(60),
  format: z.enum(['text', 'number', 'datetime', 'bytes', 'credits', 'status']).optional(),
})

export const CanvasChartSeriesSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(60),
})

/** 画布卡内容（§3；`proposal` / `secret-request` 只由 Hub 生成） */
export const CanvasSpecSchema = z.discriminatedUnion('kind', [
  /**
   * 指标卡（WP56h）：`items` 可以是空的（默认 `[]`），此时靠 `data.source` 的每一行当一项；
   * 给了 `source` 就按 `refreshSec` 重查，指标卡也能像图表一样实时刷新。
   */
  z.object({
    kind: z.literal('stats'),
    items: z.array(CanvasStatsItemSchema).max(12).default([]),
    data: CanvasDataSchema.optional(),
  }),
  z.object({
    kind: z.literal('table'),
    columns: z.array(CanvasTableColumnSchema).min(1).max(30),
    data: CanvasDataSchema,
    rowRef: z.object({ entity: EntityKindSchema, idKey: z.string().min(1).max(64) }).optional(),
  }),
  z.object({
    kind: z.literal('chart'),
    /**
     * `donut`（WP56h 追加）：占比图。`x.key` 是**分类名**，`series[0].key` 是**数值**
     * （只取第一条系列；多给的系列会被忽略），适合「按用户的消耗占比」这类问题。
     */
    chart: z.enum(['line', 'bar', 'stacked-bar', 'area', 'donut']),
    x: z.object({ key: z.string().min(1).max(64), format: z.enum(['date', 'datetime', 'text']).optional() }),
    series: z.array(CanvasChartSeriesSchema).min(1).max(12),
    unit: z.string().max(16).optional(),
    data: CanvasDataSchema,
  }),
  z.object({
    kind: z.literal('entity'),
    entity: EntityKindSchema,
    id: z.union([z.string(), z.number()]),
  }),
  z.object({ kind: z.literal('job'), jobId: z.number().int().positive() }),
  z.object({ kind: z.literal('logs'), data: CanvasDataSchema }),
  z.object({ kind: z.literal('markdown'), text: z.string().max(COCKPIT_MARKDOWN_MAX) }),
  z.object({ kind: z.literal('proposal'), proposalId: z.number().int().positive() }),
  z.object({ kind: z.literal('secret-request'), requestId: z.string().min(1).max(80) }),
])
export type CanvasSpec = z.infer<typeof CanvasSpecSchema>

/** 画布卡（SSE 与 `/canvas` 都发它） */
export const CanvasItemSchema = z.object({
  id: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  spec: CanvasSpecSchema,
  /** 钉到态势板 */
  pinned: z.boolean(),
  order: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** hub = 方案卡 / 密钥卡 / 默认态势卡 */
  origin: z.enum(['dsh', 'hub']),
  /** 已解析的舷位（POST /ops/canvas 可以传 'auto'，落库的是解析后的结果） */
  placement: CanvasPlacementSchema,
  /** 高度档位（缺省 m） */
  size: CanvasSizeSchema,
})
export type CanvasItem = z.infer<typeof CanvasItemSchema>

// ── 座舱状态 / 密钥请求（§3） ───────────────────────────────────────────────

export const OpsInstanceStateSchema = z.enum(['running', 'starting', 'stopped', 'error', 'missing'])
export type OpsInstanceState = z.infer<typeof OpsInstanceStateSchema>

export const OpsStatusSchema = z.object({
  instance: OpsInstanceStateSchema,
  model: z.string().nullable(),
  /** 中文，顶栏胶囊悬浮显示 */
  reason: z.string().max(300).optional(),
  autoExecuteR1: z.boolean(),
})
export type OpsStatus = z.infer<typeof OpsStatusSchema>

export const SecretRequestStatusSchema = z.enum(['pending', 'filled', 'cancelled', 'expired'])
export type SecretRequestStatus = z.infer<typeof SecretRequestStatusSchema>

export const SecretRequestViewSchema = z.object({
  id: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(200),
  /** DSH 写：「新渠道 xx 的 API Key」 */
  purpose: z.string().min(1).max(200),
  /** 要用到它的能力 */
  capability: z.string().min(1).max(64),
  /** 该能力里的哪个 secretFields */
  field: z.string().min(1).max(64),
  status: SecretRequestStatusSchema,
  /** 15 分钟 */
  expiresAt: IsoDateTimeSchema,
})
export type SecretRequestView = z.infer<typeof SecretRequestViewSchema>

// ── 座舱 DSH → Hub（§3.1） ─────────────────────────────────────────────────

/**
 * 状态条（§1 顶栏下方一行数字）：运行实例/总数、今日中转站用量、失败任务、待确认方案。
 * 变化时经 SSE 推 `strip.update`；`GET /api/admin/cockpit/status-strip` 也能直接拿。
 */
export const CockpitStatusStripSchema = z.object({
  instancesRunning: z.number().int().nonnegative(),
  instancesTotal: z.number().int().nonnegative(),
  relayTodayRequests: z.number().int().nonnegative(),
  relayTodayCredits: z.number().nonnegative(),
  failedJobs: z.number().int().nonnegative(),
  pendingProposals: z.number().int().nonnegative(),
})
export type CockpitStatusStrip = z.infer<typeof CockpitStatusStripSchema>

/** `GET /api/admin/cockpit/status-strip` 的响应（与 SSE 的 `strip` 同形） */
export const CockpitStatusStripResponseSchema = CockpitStatusStripSchema
export type CockpitStatusStripResponse = z.infer<typeof CockpitStatusStripResponseSchema>

/** SSE 事件（`/api/admin/cockpit/events`） */
export const CockpitEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('canvas.upsert'), item: CanvasItemSchema }),
  z.object({ type: z.literal('canvas.remove'), id: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal('proposal.upsert'), proposal: ProposalViewSchema }),
  z.object({ type: z.literal('secret.request'), request: SecretRequestViewSchema }),
  z.object({ type: z.literal('ops.status'), status: OpsStatusSchema }),
  z.object({ type: z.literal('strip.update'), strip: CockpitStatusStripSchema }),
])
export type CockpitEvent = z.infer<typeof CockpitEventSchema>

/** `POST /ops/call` 的返回（docs/24 §3） */
export const OpsCallResultSchema = z.discriminatedUnion('kind', [
  /** R0 */
  z.object({
    kind: z.literal('data'),
    data: z.unknown(),
    truncated: z.boolean(),
    hint: z.string().max(300).optional(),
  }),
  /** R1 且自动执行开启 */
  z.object({ kind: z.literal('done'), result: z.unknown(), auditId: z.number().int().nonnegative() }),
  /** R1（关闭自动）/ R2 / R3 */
  z.object({ kind: z.literal('proposal'), proposal: ProposalViewSchema }),
])
export type OpsCallResult = z.infer<typeof OpsCallResultSchema>

/** 多步方案里的一步（`/ops/call` 的 `steps`，与 `capability/args` 二选一） */
export const OpsCallStepSchema = z.object({
  capability: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).optional(),
})
export type OpsCallStep = z.infer<typeof OpsCallStepSchema>

export const OpsCallRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    capability: z.string().min(1).max(64).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(OpsCallStepSchema).min(1).max(COCKPIT_STEPS_MAX).optional(),
    /** 写类能力必须带 */
    title: z.string().min(1).max(200).optional(),
    rationale: z.string().max(COCKPIT_RATIONALE_MAX).optional(),
  })
  .refine((value) => (value.capability ? value.steps === undefined : value.steps !== undefined), {
    message: 'capability/args 与 steps 二选一',
    path: ['capability'],
  })
export type OpsCallRequest = z.infer<typeof OpsCallRequestSchema>

/** `GET /ops/context`：Hub 版本、各域数量摘要、策略、今天日期与时区 */
export const OpsContextResponseSchema = z.object({
  version: z.string().max(32),
  today: z.string().max(32),
  timezone: z.string().max(64),
  policy: z.object({ autoExecuteR1: z.boolean() }),
  /** 各域数量摘要（键名固定，值是非负整数） */
  counts: z.record(z.string(), z.number().int().nonnegative()),
})
export type OpsContextResponse = z.infer<typeof OpsContextResponseSchema>

export const OpsCatalogQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  area: CockpitAreaSchema.optional(),
})
export type OpsCatalogQuery = z.infer<typeof OpsCatalogQuerySchema>

export const OpsCatalogResponseSchema = z.object({
  items: z.array(CapabilityDescriptorSchema),
  total: z.number().int().nonnegative(),
})
export type OpsCatalogResponse = z.infer<typeof OpsCatalogResponseSchema>

/** 长轮询的等待秒数（`/ops/proposals/:id`、`/ops/secret-requests/:id`） */
export const OpsWaitQuerySchema = z.object({
  waitSec: z.coerce.number().int().min(0).max(60).default(0),
})
export type OpsWaitQuery = z.infer<typeof OpsWaitQuerySchema>

export const OpsCanvasCreateRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  spec: CanvasSpecSchema,
  /** 缺省 auto：数据类投左舷、行动类投右舷（§1 投放规则） */
  placement: CanvasPlacementRequestSchema.optional(),
  size: CanvasSizeSchema.optional(),
})
export type OpsCanvasCreateRequest = z.infer<typeof OpsCanvasCreateRequestSchema>

export const OpsCanvasPatchRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    title: z.string().min(1).max(200).optional(),
    spec: CanvasSpecSchema.optional(),
    placement: CanvasPlacementSchema.optional(),
    size: CanvasSizeSchema.optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.spec !== undefined ||
      value.placement !== undefined ||
      value.size !== undefined,
    { message: 'title / spec / placement / size 至少给一个' },
  )
export type OpsCanvasPatchRequest = z.infer<typeof OpsCanvasPatchRequestSchema>

export const OpsSecretRequestCreateSchema = z.object({
  sessionId: z.string().min(1).max(200),
  purpose: z.string().min(1).max(200),
  capability: z.string().min(1).max(64),
  field: z.string().min(1).max(64),
})
export type OpsSecretRequestCreate = z.infer<typeof OpsSecretRequestCreateSchema>

/** `GET /ops/secret-requests/:id`：填好后返回引用号，**不返回值** */
export const OpsSecretStatusResponseSchema = z.object({
  status: SecretRequestStatusSchema,
  secretRef: z.string().max(80).optional(),
})
export type OpsSecretStatusResponse = z.infer<typeof OpsSecretStatusResponseSchema>

// ── 管理员浏览器 → Hub（§3.2） ─────────────────────────────────────────────

/** `GET /state` */
export const CockpitStateResponseSchema = z.object({
  status: OpsStatusSchema,
  pendingProposals: z.number().int().nonnegative(),
  /** 前端显示方案步骤名用 */
  catalog: z.array(CapabilityDescriptorSchema),
  /** 状态条（与 `GET /status-strip` 同形，省一次请求） */
  strip: CockpitStatusStripSchema,
})
export type CockpitStateResponse = z.infer<typeof CockpitStateResponseSchema>

/** `PUT /settings`：改 `autoExecuteR1` 需要 reauth（路由层） */
export const CockpitSettingsRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(200).nullable().optional(),
    autoExecuteR1: z.boolean().optional(),
  })
  .refine((value) => value.model !== undefined || value.autoExecuteR1 !== undefined, {
    message: 'model 与 autoExecuteR1 至少给一个',
  })
export type CockpitSettingsRequest = z.infer<typeof CockpitSettingsRequestSchema>

export const CockpitSettingsResponseSchema = z.object({ status: OpsStatusSchema })
export type CockpitSettingsResponse = z.infer<typeof CockpitSettingsResponseSchema>

/** `POST /handoff` → 一次性交接码（60 秒，绑定当前管理员） */
export const CockpitHandoffResponseSchema = z.object({
  code: z.string().min(1).max(200),
  expiresAt: IsoDateTimeSchema,
})
export type CockpitHandoffResponse = z.infer<typeof CockpitHandoffResponseSchema>

export const CockpitHandoffExchangeRequestSchema = z.object({ code: z.string().min(1).max(200) })
export type CockpitHandoffExchangeRequest = z.infer<typeof CockpitHandoffExchangeRequestSchema>

export const CockpitCanvasQuerySchema = z.object({ sessionId: z.string().min(1).max(200) })
export type CockpitCanvasQuery = z.infer<typeof CockpitCanvasQuerySchema>

export const CockpitCanvasListResponseSchema = z.object({ items: z.array(CanvasItemSchema) })
export type CockpitCanvasListResponse = z.infer<typeof CockpitCanvasListResponseSchema>

/** `GET /board`：钉住的卡 + 默认五张（舰况、近 7 天用量、实例资源、失败任务、待处理方案；WP56h） */
export const CockpitBoardResponseSchema = z.object({
  pinned: z.array(CanvasItemSchema),
  defaults: z.array(CanvasItemSchema),
})
export type CockpitBoardResponse = z.infer<typeof CockpitBoardResponseSchema>

export const CockpitCanvasPatchRequestSchema = z
  .object({
    pinned: z.boolean().optional(),
    order: z.number().int().optional(),
    /** 管理员拖动换舷 */
    placement: CanvasPlacementSchema.optional(),
    size: CanvasSizeSchema.optional(),
  })
  .refine(
    (value) =>
      value.pinned !== undefined ||
      value.order !== undefined ||
      value.placement !== undefined ||
      value.size !== undefined,
    { message: 'pinned / order / placement / size 至少给一个' },
  )
export type CockpitCanvasPatchRequest = z.infer<typeof CockpitCanvasPatchRequestSchema>

/** `POST /source`：用当前管理员身份跑一次数据源（只允许 `dataSource=true` 的 R0） */
export const CockpitSourceRequestSchema = z.object({
  capability: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).optional(),
})
export type CockpitSourceRequest = z.infer<typeof CockpitSourceRequestSchema>

export const CockpitSourceResponseSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).max(COCKPIT_TABLE_MAX_ROWS),
  truncated: z.boolean(),
  hint: z.string().max(300).optional(),
})
export type CockpitSourceResponse = z.infer<typeof CockpitSourceResponseSchema>

export const CockpitProposalsQuerySchema = z.object({
  status: ProposalStatusSchema.optional(),
  sessionId: z.string().min(1).max(200).optional(),
})
export type CockpitProposalsQuery = z.infer<typeof CockpitProposalsQuerySchema>

export const CockpitProposalsResponseSchema = z.object({ items: z.array(ProposalViewSchema) })
export type CockpitProposalsResponse = z.infer<typeof CockpitProposalsResponseSchema>

/** `POST /proposals/:id/approve` 的返回（执行是异步的，后续状态经 SSE 推） */
export const CockpitProposalDecisionResponseSchema = ProposalViewSchema
export type CockpitProposalDecisionResponse = z.infer<typeof CockpitProposalDecisionResponseSchema>

/** `POST /secret-requests/:id`：管理员填值（204） */
export const CockpitSecretFillRequestSchema = z.object({ value: z.string().min(1).max(8192) })
export type CockpitSecretFillRequest = z.infer<typeof CockpitSecretFillRequestSchema>
