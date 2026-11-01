import type {
  CatalogEntryInput,
  CatalogResponse,
  CreatePresetRequest,
  CreateProviderRequest,
  DiscoverModelsRequest,
  DiscoverModelsResponse,
  MatchModelsResponse,
  ModelApi,
  ModelPreset,
  ModelProvider,
  Platform,
  PresetPreviewResponse,
  TestProviderResponse,
  ThinkingLevel,
  UpdatePresetRequest,
  UpdateProviderRequest,
  UserProviderKey,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { PatchEntry } from './patch-entries.js'
import type { RenderModelSpec } from './render.js'

/**
 * 18 §4.1：Claude Code / Codex 的容器 env 晚绑定桥。
 * agent-modes 模块启动时注册；纯函数在它自己的 `env.ts`，这里只要「userId → env」。
 */
export type AgentModeEnvProvider = (userId: number) => Record<string, string>

/**
 * hub-relay 的晚绑定桥（12 §7.7）：relay 模块启动时把它注册进 models service，
 * 渲染与 `containerEnv()` 通过它拿「中转站的内部地址 / 该用户的 system 密钥 / 要渲染的模型」。
 *
 * 为什么用晚绑定：models 要渲染 relay 的模型与密钥，relay 又要用 models 的模型信息库补全，
 * 直接互相 import 会成环；桥接口定义在 models 侧，relay 只实现它。
 */
export interface RelayBridge {
  /** 内部监听器地址（含 `/v1`）；关闭时 null（此时不渲染该提供方并告警） */
  internalBaseUrl(): string | null
  /** 该用户的 system 密钥明文（没有就签发）；失败返回 null */
  systemKeyPlain(userId: number): string | null
  /**
   * 按协议列出要渲染的对外模型（启用 + 已勾选下发 + 可见 + `deliverApi` = 该协议）。
   * `thinking` 给了（含 null）= 只渲染生效档位等于它的模型（WP13 系统路由，一条路由一个档位）；
   * 省略 = 不按档位筛（WP12 时代手工建的旧 hub-relay 提供方保持原逻辑）。
   */
  providerModels(
    api: ModelApi,
    opts: {
      userId?: number
      admin: boolean
      thinking?: ThinkingLevel | null
      /** 哪个平台的勾选集合（docs/22 §3；缺省云上）。桌面预设只渲染桌面平台选中的路由 */
      platform?: Platform
    },
  ): RenderModelSpec[]
  /** 刚刚渲染过中转站模型（清「模型待下发」告警） */
  noteRendered(): void
  /**
   * 搜索 / 抓取池要渲染进 `managed.patch.yml` 的条目（14 §5）。
   * `needsKey` = 还要给容器注入 `HUB_MK_HUB`（用户没有 hub-relay 提供方时也要注入）。
   */
  toolsRender?(userId: number): {
    entries: PatchEntry[]
    warnings: string[]
    needsKey: boolean
  }
  /**
   * 预设 / 提供方被手工改动后通知 relay 重新同步系统托管的下发配置（12 §7.0「被人删了就重建」）。
   * 可选：没有 relay（纯 models 场景）时不做任何事。
   */
  onSystemPresetsMutated?(): void
}

// ── 系统托管的下发预设（12 §7.0；WP12a）─────────────────────────────────────

/** 系统提供方（hub-relay）：路由名/档位固定，地址 / 模型 / 密钥都由中转站决定 */
export interface SystemPresetProviderSpec {
  routeKey: string
  displayName: string
  api: ModelApi
  /** WP13：这条路由的默认思考档位（渲染成 provider 配置的 `reasoning`）；null = 不设 */
  thinking: ThinkingLevel | null
}

/**
 * 期望的系统预设。`providers` 为空 = 一个模型都没勾选 → **不该有**系统预设（已有的会被删掉）。
 * `defaultProvider` / `defaultModel` 只在 `providers` 非空时有意义。
 */
export interface SystemPresetSpec {
  /** `settings.relay_dsh.presetId`：上次同步记下的预设 id；null = 还没建过 */
  presetId: number | null
  /** 预设属于哪个平台（docs/22 §3；缺省云上）。两个平台的默认预设互不影响 */
  platform?: Platform
  /** 系统预设名（12 §7.0「Hub 中转站」） */
  name: string
  /** 创建预设时写的说明（不参与幂等比对） */
  description?: string
  providers: SystemPresetProviderSpec[]
  defaultProvider: string
  defaultModel: string
  /**
   * 预设行内容看不出、但渲染内容变了（如模型显示名/上下文/compat 改了）→ 仍然把 `revision + 1`。
   * 由 relay 用渲染指纹判断（`dshRenderFingerprint`）；调用方连续两次传同样的期望状态时不会 bump。
   */
  renderChanged?: boolean
}

export interface SystemPresetSyncResult {
  /** 同步后的系统预设 id（`providers` 为空 = null） */
  presetId: number | null
  /** 同步后的预设 revision（没有预设 = 0） */
  revision: number
  /** 期望状态与现状不同、真的写了库 */
  changed: boolean
  /** 系统提供方 id（按 `spec.providers` 顺序） */
  providerIds: number[]
}

/** 渲染结果（06 §4.3）：内容 + manifest + 警告（同 id 覆盖等） */
export interface RenderManagedResult {
  /** managed.patch.yml 全文 */
  content: string
  /** manifest.json 的内容 */
  manifest: {
    userId: number
    slug: string
    presetId: number | null
    presetRevision: number | null
    runtimeVersion: string | null
    plugins: { packageName: string; version: string }[]
    generatedAt: string
  }
  warnings: string[]
}

/**
 * 模型服务（04 §4.7、06 §4；WP3 实现）。
 * `renderManaged` 的核心是**纯函数**（`render.ts`，单元测试覆盖）：用户 + 预设 + 插件配置片段 → managed.patch.yml。
 * 密钥只在渲染结果里以 `apiKeyEnv` 名出现，明文只在 `containerEnv()` 里解密给容器 env（05 §4）。
 */
export interface ModelService {
  /** 04 §10.3：按提供方列出该用户的 per-user 密钥状态（管理端用户详情） */
  providerKeysForUser(userId: number): Promise<UserProviderKey[]>
  listProviders(): Promise<ModelProvider[]>
  createProvider(input: CreateProviderRequest, actorId: number, meta: RequestMeta): Promise<ModelProvider>
  updateProvider(
    providerId: number,
    input: UpdateProviderRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ModelProvider>
  deleteProvider(providerId: number, actorId: number, meta: RequestMeta): Promise<void>
  testProvider(providerId: number): Promise<TestProviderResponse>
  discover(input: DiscoverModelsRequest): Promise<DiscoverModelsResponse>
  /** 模型信息库：自定义条目 + 内置库概况 */
  getCatalog(): Promise<CatalogResponse>
  /** 批量新增 / 覆盖自定义条目（按规范化后的模型名为键），返回最新的库 */
  saveCatalog(entries: CatalogEntryInput[], actorId: number, meta: RequestMeta): Promise<CatalogResponse>
  deleteCatalogEntry(key: string, actorId: number, meta: RequestMeta): Promise<void>
  /** 按模型名查库（自定义优先于内置），只返回命中的 */
  matchModels(ids: string[]): Promise<MatchModelsResponse>
  setUserProviderKey(
    providerId: number,
    userId: number,
    apiKey: string,
    actorId: number,
    meta: RequestMeta,
  ): Promise<void>
  deleteUserProviderKey(providerId: number, userId: number, actorId: number, meta: RequestMeta): Promise<void>
  listPresets(platform?: Platform): Promise<ModelPreset[]>
  createPreset(input: CreatePresetRequest, actorId: number, meta: RequestMeta): Promise<ModelPreset>
  updatePreset(
    presetId: number,
    input: UpdatePresetRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ModelPreset>
  deletePreset(presetId: number, actorId: number, meta: RequestMeta): Promise<void>
  /** 预览某个用户渲染出的 managed.patch.yml（不落盘） */
  previewForUser(presetId: number, userId: number): Promise<PresetPreviewResponse>
  /**
   * 桌面下发用的模型片段（WP25b）：复用「下发到 DSH」的系统路由与默认模型，
   * 返回 `llm-pi-ai` / `agent-default-model` 两条白名单条目的对象形态（不落盘）。
   *
   * `userId = null` 表示**系统预设**（WP25e）：用默认预设 + 管理员可见性渲染
   * （全部可下发模型），不绑定任何具体用户。
   */
  desktopModelFragments(
    userId: number | null,
    opts?: { presetId?: number },
  ): Promise<{
    fragments: { id: string; config: Record<string, unknown> }[]
    warnings: string[]
  }>
  /** 为某用户渲染 managed.patch.yml 并原子写入 `users/<slug>/managed/`（+ manifest.json） */
  renderManaged(userId: number, opts?: { presetId?: number | null }): Promise<RenderManagedResult>
  /**
   * 解密后的模型密钥 env（05 §4；WP2 的 `ContainerDriver` 规格用它）。
   * 键是 `HUB_MK_<ROUTE_KEY>`；deepseek-official 用 `DEEPSEEK_API_KEY`。
   */
  containerEnv(userId: number): Promise<Record<string, string>>
  /** 下发模型配置：重渲染 managed，密钥变化 → 重建容器，否则重启（06 §4.3） */
  /**
   * 下发模型配置。`presetId`：`undefined` = 不改用户的预设，只按最新配置重渲染（04 §10.6）；
   * `null` = 跟随默认预设；数字 = 钉到该预设。
   */
  applyForUser(
    userId: number,
    presetId: number | null | undefined,
    opts?: { onLog?: (line: string) => void; restart?: 'now' | 'next-start' },
  ): Promise<void>
  /** 状态页「我的模型」摘要（04 §3.1 §10.4：带 policy） */
  summaryForUser(userId: number): Promise<{
    policy: 'managed' | 'free'
    preset: string
    defaultModel: string
    providers: string[]
  }>

  // ── hub-relay（12 §7；WP10a）────────────────────────────────────────────
  /** 注册中转站桥（只应由 relay 模块在启动时调用一次） */
  attachRelayBridge(bridge: RelayBridge | null): void
  /** 注册对话模式的 env 提供者（只应由 agent-modes 模块在启动时调用一次；`null` = 卸载） */
  attachAgentModeEnv(provider: AgentModeEnvProvider | null): void
  /** 生效预设里是否有启用的 hub-relay 提供方（`/api/me/relay` 的 dshAttached） */
  hasRelayProviderForUser(userId: number): boolean
  /** hub-relay 提供方总数（概览告警判断用，不暴露细节） */
  listRelayProviderCount(): number

  // ── 系统托管的下发预设（12 §7.0；WP12a）─────────────────────────────────
  /**
   * 把系统提供方与系统预设同步到期望状态（幂等）：系统提供方不存在就建（hub-relay），
   * 预设不存在就建、存在就把内容对齐并设为默认预设；**只有真的有变化才写库并 `revision + 1`**。
   * 路由名被非中转站提供方占用 → `CONFLICT`。调用方是 relay 模块（`syncDshPreset()`）。
   */
  syncSystemPreset(spec: SystemPresetSpec): SystemPresetSyncResult
  /** 系统预设现状（只读；GET 的 `revision` 用）。id 失效时按名字找；没有 = null */
  systemPresetState(
    spec: { presetId: number | null; name: string },
    platform?: Platform,
  ): { presetId: number; revision: number } | null
  /** 预设列表（缺省全部平台；传 platform 只列该平台） */
  listPresets(platform?: Platform): Promise<ModelPreset[]>
  /**
   * 桌面默认预设（docs/22 §3）：没有就从云上默认预设复制一份（幂等）。
   * 返回 null = 连云上默认预设都没有（新装 Hub 还没配模型），此时桌面基线无从渲染。
   */
  ensureDesktopDefaultPreset(): { presetId: number; created: boolean } | null
  /** 系统提供方的路由名被非中转站提供方占用时的提示文本（GET 的 `warnings` 用）；没有占用 = null */
  systemPresetRouteConflict(routeKeys: string[]): string | null
  /** 把所有用户的 `model_preset_id` 置空（12 §7.0：PUT 后都跟随默认预设），返回清掉的用户数 */
  clearUserPresets(): number
}
