import type { FastifyReply, FastifyRequest } from 'fastify'
import type {
  AddRelayChannelKeysRequest,
  AddRelayChannelKeysResponse,
  CreateRelayChannelRequest,
  CreateRelayModelRequest,
  CreateRelayKeyRequest,
  DiscoverRelayChannelResponse,
  ImportRelayModelsRequest,
  ImportRelayModelsResponse,
  ModelApi,
  ModelInfo,
  ModelSpec,
  MyRelayModel,
  Platform,
  MyRelayResponse,
  RelayChannel,
  RelayDshResponse,
  RelayKey,
  RelayKeySecretResponse,
  RelayLedgerListResponse,
  RelayLedgerQuery,
  RelayModel,
  RelayOverviewResponse,
  RelayPrice,
  RelayScope,
  RelaySettings,
  RelaySettingsResponse,
  RelayUsageLogQuery,
  RelayUsageLogResponse,
  RelayUsageSource,
  RelayUsageStatsQuery,
  RelayUsageStatsResponse,
  RelayWalletListQuery,
  RelayWalletListResponse,
  RelayWalletRow,
  TestRelayChannelResponse,
  UpdateRelayChannelKeyRequest,
  UpdateRelayChannelRequest,
  UpdateRelayDshRequest,
  UpdateRelayKeyRequest,
  UpdateRelayModelRequest,
  UpdateRelaySettingsRequest,
  UpdateRelayWalletRequest,
  AdjustRelayWalletRequest,
  UserStatus,
  ThinkingLevel,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { RequestOrigin } from '../../server/public-request.js'
import type { ToolService } from './tools/types.js'

/** 渲染进 DSH 的模型条目 = 模型信息 + 可选的模型级 compat（12 §7.2，待真容器验证） */
export type RelayRenderModel = ModelSpec & { compat?: Record<string, unknown> | null }

/** `/v1` 鉴权结果（密钥 + 用户的最少信息，够做进门检查） */
export interface RelayAuthResult {
  key: {
    id: number
    name: string
    kind: 'system' | 'user'
    userId: number
    scope: RelayScope
    /** WP25a：桌面设备专用密钥的设备 id（决定 `relay_usage.client_kind`）；其它密钥为 null */
    deviceId: string | null
  }
  user: {
    id: number
    username: string
    status: UserStatus
    role: 'user' | 'admin'
    /**
     * `users.is_system = 1`（WP56e1，docs/24 §3.5）：座舱自己的系统账号。
     * 它的请求**不扣任何人的积分**（成本按 0 记），用量来源记 `cockpit`，也不做余额/日上限检查。
     */
    isSystem?: boolean
  }
}

/**
 * 18 §3.1：某作用域里的一个对外模型（给 Claude Code / Codex 管理页与插件配置用）。
 * 与 `RelayModel` 的区别：只带下拉/插件需要的字段，并预先算好「有没有可用路由」。
 */
export interface RelayScopeModel {
  id: number
  name: string
  displayName: string
  enabled: boolean
  /** 对该用户可见（`visibility=admin` 的模型对普通用户为 false） */
  visible: boolean
  /** 有启用路由、所在渠道启用、协议与作用域一致（模型本身也必须启用） */
  routable: boolean
  apis: ModelApi[]
  price: RelayPrice
  info: ModelInfo
  /** 下发到 DSH 的默认思考档位（18 §3.4 给插件的 `defaultThinking`） */
  defaultThinking: ThinkingLevel | null
  /** 「模型」页的排序（默认模型按 sort DESC、name 取第一个） */
  sort: number
  /** 启用路由所在渠道的倍率范围；没有可用路由 = null */
  channelRate: { minPermille: number; maxPermille: number } | null
}

/** 一次 `/v1` 请求的上下文（路由层解析好后交给 service） */
export interface RelayV1RequestContext {
  api: ModelApi
  source: RelayUsageSource
  auth: RelayAuthResult
  /** 请求头白名单透传的原始头（小写键） */
  headers: Record<string, string | string[] | undefined>
  /** 已解析的请求体（JSON 对象） */
  body: Record<string, unknown>
  ip: string | null
  /** 客户端请求路径（区分 `/messages` 与 `/messages/count_tokens`） */
  path?: string
  /** 是否记账：`count_tokens` 透传但不计费、不记用量（12 §4） */
  metered?: boolean
}

/** 中转站服务（12 §2 的模块边界：别的模块只通过它调用） */
export interface RelayService {
  // ── 设置与地址 ──────────────────────────────────────────────────────────
  getSettings(): RelaySettings
  updateSettings(
    patch: UpdateRelaySettingsRequest,
    actorId: number,
    meta: RequestMeta,
    entry?: RequestOrigin,
  ): RelaySettingsResponse
  settingsResponse(entry?: RequestOrigin): RelaySettingsResponse
  /** 容器内 DSH 用的地址（含 `/v1`）；内部监听器关闭时 null */
  internalBaseUrl(): string | null
  /** 外部工具用的地址：`HUB_PUBLIC_ORIGIN/v1`；边缘入口的请求给 `HUB_EDGE_ORIGIN/v1`（WP52） */
  publicBaseUrl(entry?: RequestOrigin): string
  /** 内部监听器是否在监听（供概览与渲染判断） */
  setInternalListening(listening: boolean): void
  /** 内部监听器实际绑定的地址（含 `/v1`）；未监听时传 null */
  setInternalBaseUrl(baseUrl: string | null): void
  isInternalListening(): boolean

  // ── 概览 ────────────────────────────────────────────────────────────────
  overview(): RelayOverviewResponse

  // ── 下发到 DSH（12 §7.0、§9；WP12a）─────────────────────────────────────
  /** 「下发到 DSH」页的数据：模型行（含 routes）+ 默认路由 + revision/pending/lastRollout/users/warnings */
  /** 某个平台的「下发到 DSH」（docs/22 §3；缺省云上） */
  dshResponse(platform?: Platform): Promise<RelayDshResponse>
  /**
   * 桌面平台第一次上线时的「勾选集合 / 默认模型」初值（docs/22 §3，WP32d 补）：
   * `settings.relay_dsh_desktop` 还没写过时从云上当前配置带一份并落库；写过一次就不再跟随（幂等）。
   */
  ensureDesktopDshSeeded(): { seeded: boolean; routeIds: number[] }
  /** 整体替换选中路由与默认路由（新写法 routeIds / 老写法 modelIds；只保存，不下发） */
  updateDsh(
    input: UpdateRelayDshRequest,
    actorId: number,
    meta: RequestMeta,
    platform?: Platform,
  ): Promise<RelayDshResponse>

  // ── 渠道 ────────────────────────────────────────────────────────────────
  /** 18 §3.1：按作用域列渠道（省略 = dsh，老前端行为不变） */
  listChannels(scope?: RelayScope): RelayChannel[]
  createChannel(input: CreateRelayChannelRequest, actorId: number, meta: RequestMeta): RelayChannel
  updateChannel(
    channelId: number,
    input: UpdateRelayChannelRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayChannel
  deleteChannel(channelId: number, actorId: number, meta: RequestMeta): void
  testChannel(channelId: number): Promise<TestRelayChannelResponse>
  discoverChannel(channelId: number): Promise<DiscoverRelayChannelResponse>
  addChannelKeys(
    channelId: number,
    input: AddRelayChannelKeysRequest,
    actorId: number,
    meta: RequestMeta,
  ): AddRelayChannelKeysResponse
  updateChannelKey(
    channelId: number,
    keyId: number,
    input: UpdateRelayChannelKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayChannel
  deleteChannelKey(channelId: number, keyId: number, actorId: number, meta: RequestMeta): RelayChannel

  // ── 对外模型 ────────────────────────────────────────────────────────────
  /** 18 §3.1：按作用域列对外模型（省略 = dsh） */
  listModels(scope?: RelayScope): RelayModel[]
  /**
   * 手机端：DSH 模型 id（`<对外模型名>@<渠道标识>`）→ 渠道倍率（1 = 原价）。
   * 拿不到价格信息（模型/渠道不在中转站里）返回 null。
   */
  modelMultiplier(dshModelId: string): number | null
  /**
   * 手机端：一条 assistant/message 的微积分消耗（与计费同一公式）。
   * 模型没有价格信息返回 null（App 的会话统计会标「估算/—」）。
   */
  quoteCostMicro(input: {
    userId: number
    model: string
    tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  }): number | null
  /**
   * 18 §3.1 §3.4：某作用域里的模型摘要（含可用性、价格、渠道倍率区间）。
   * `admin` = 管理端口径（不看 visibility）；否则按用户角色过滤 `visibility=admin`。
   */
  scopeModels(scope: RelayScope, opts: { userId: number; role: 'user' | 'admin' }): RelayScopeModel[]
  createModel(input: CreateRelayModelRequest, actorId: number, meta: RequestMeta): Promise<RelayModel>
  updateModel(
    modelId: number,
    input: UpdateRelayModelRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<RelayModel>
  deleteModel(modelId: number, actorId: number, meta: RequestMeta): void
  importModels(
    input: ImportRelayModelsRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ImportRelayModelsResponse>

  // ── 钱包与流水 ──────────────────────────────────────────────────────────
  listWallets(query: RelayWalletListQuery): RelayWalletListResponse
  getWalletRow(userId: number): RelayWalletRow
  updateWallet(
    userId: number,
    input: UpdateRelayWalletRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayWalletRow
  adjustWallet(
    userId: number,
    input: AdjustRelayWalletRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayWalletRow
  listLedger(query: RelayLedgerQuery, opts: { userId?: number }): RelayLedgerListResponse

  // ── 算力租赁的钱包接口（13 §2；WP17a；compute 通过依赖注入拿到）────────────
  /** 钱包余额（没有钱包行 = 0，不写库） */
  getBalance(userId: number): number
  /**
   * 算力按块扣费：写 `compute` 负数流水、先用今日赠送，**不动 `total_spent`**；
   * 返回扣费后的余额。调用方负责事务外的业务判断（余额、宽限）。
   */
  chargeCompute(userId: number, amountMicro: number, note: string): number
  /** 每日赠送：先作废昨天的未用部分，再给今天的一次；返回本次发放额（0 = 未发） */
  grantDailyBonus(userId: number): number
  /** 只作废过期赠送（不发放）；所有扣费路径已在事务内自动调用它 */
  expireStaleBonus(userId: number): void

  // ── 搜索 / 抓取池（14；WP18a）─────────────────────────────────────────────
  /**
   * 搜索池按次扣费（14 §3.1）：写法照 `chargeCompute`（先作废过期赠送、消费先用赠送、不动 `total_spent`），
   * 但**不写 ledger** —— 工具费用记在 `relay_tool_usage.cost` 里（14 §3.3 的对账不变量）。
   */
  chargeTool(userId: number, amountMicro: number): number
  /** 搜索池子域（渠道 / 密钥 / 用量 / 设置 / `/v1/tools/*`） */
  tools: ToolService

  // ── 用量统计 ────────────────────────────────────────────────────────────
  usageStats(
    query: RelayUsageStatsQuery,
    opts: { userId?: number; scope: 'user' | 'admin' },
  ): RelayUsageStatsResponse
  usageLogs(
    query: RelayUsageLogQuery,
    opts: { userId?: number; scope: 'user' | 'admin' },
  ): RelayUsageLogResponse

  // ── 用户端 ──────────────────────────────────────────────────────────────
  myRelay(userId: number, role: 'user' | 'admin', entry?: RequestOrigin): MyRelayResponse
  myModels(userId: number, role: 'user' | 'admin'): MyRelayModel[]
  listKeys(userId: number): RelayKey[]
  createKey(
    userId: number,
    input: CreateRelayKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayKeySecretResponse
  updateKey(
    userId: number,
    keyId: number,
    input: UpdateRelayKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayKey
  deleteKey(userId: number, keyId: number, actorId: number, meta: RequestMeta): void
  rotateSystemKey(userId: number, actorId: number, meta: RequestMeta): RelayKeySecretResponse

  // ── models 模块的晚绑定桥（12 §7；由 models 在渲染 / containerEnv 时回调）────
  /** 该用户某作用域的 system 密钥明文（没有就签发）；失败返回 null。省略 scope = dsh */
  systemKeyPlain(userId: number, scope?: RelayScope): string | null
  /**
   * 按提供方协议列出要渲染的模型条目（16 §6.2：每条选中且可下发的路由一条，
   * id = `<模型>@<slug>`）；`thinking` 给了（含 null）= 再按生效档位筛；省略 = 不筛。
   */
  providerModels(
    api: ModelApi,
    opts: { userId?: number; admin: boolean; thinking?: ThinkingLevel | null },
  ): RelayRenderModel[]
  /** 提示「刚刚把中转站模型渲染进了某个用户的 managed.patch.yml」（清 `models-changed` 告警） */
  noteRendered(): void

  // ── 注册赠送 ────────────────────────────────────────────────────────────
  /** 注册成功（含待审批）时建钱包并按设置赠送；管理员 CLI 建号不走这里 */
  ensureSignupWallet(userId: number): void
  /** 进去重/清理（测试与优雅退出用） */
  dispose(): void

  // ── `/v1` ───────────────────────────────────────────────────────────────
  authenticate(secret: string): RelayAuthResult | null
  /** 转发一次 `/v1` 请求（含进门检查、候选切换、字节透传、计费落库） */
  forward(req: FastifyRequest, reply: FastifyReply, ctx: RelayV1RequestContext): Promise<void>
  /** 概览里的「进行中」计数 */
  inFlightTotal(): number

  // ── 桌面设备密钥（WP25a；裁决 #8、#11）─────────────────────────────────
  /**
   * 给一台桌面设备签发一把**该设备专属**的秘密（kind='user'，scope=dsh / claude-code / codex）。
   * 同设备同作用域的旧密钥先吊销（一台设备一把），然后发新的；不占用户的 10 把自建配额。
   * `remember=true` 时同时加密存一份明文（`key_enc`），之后可用 `deviceKeySecret` 反复取（模式密钥需要）。
   */
  mintDeviceKey(input: MintDeviceKeyInput): { keyId: number; secret: string }
  /** 该设备某作用域的有效密钥明文（没有 / 没存密文 → null）；模式密钥的重复索取走它 */
  deviceKeySecret(deviceId: string, scope: RelayScope): { keyId: number; secret: string } | null
  /** 吊销一台设备的全部密钥（中转站 + 模式），返回条数：吊销设备、改密、停用/删除用户时调用 */
  revokeDeviceKeys(deviceId: string): number
}

export interface MintDeviceKeyInput {
  userId: number
  deviceId: string
  name: string
  scope: RelayScope
  /** true = 同时存 `key_enc`（之后可反复取明文）；中转站密钥不需要，模式密钥需要 */
  remember: boolean
}
