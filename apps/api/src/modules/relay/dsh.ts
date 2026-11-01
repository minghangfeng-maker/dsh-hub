import { createHash } from 'node:crypto'
import {
  DSH_HUB_PROVIDER_NAME,
  RELAY_DSH_API_PREFERENCE,
  THINKING_LEVELS,
  pinnedModelName,
  type ModelApi,
  type ModelInfo,
  type ThinkingLevel,
} from '@dsh-hub/shared'

/**
 * 「下发到 DSH」的期望状态（12 §7.0，WP12a；WP13a 起按「协议 × 默认思考档位」分路由）。
 *
 * 这个文件是**纯函数**：输入是勾选的对外模型（含各自的下发协议 `deliverApi` 与生效档位）与想用的默认模型 id，
 * 输出是 Hub 应该维护的系统提供方与默认预设；写库（models 模块）由 `models.syncSystemPreset()` 负责。
 * 这样「一个模型只渲染在一个协议下」「同一协议下档位不同的模型分到不同路由」这些规则都能单测覆盖，不依赖数据库。
 *
 * 为什么按档位分路由：DSH 的 `llm-pi-ai` **只能按提供方（profile）设默认思考档位**（字段 `reasoning`），
 * 模型条目没有这个字段；而请求时用 `options.reasoningEffort ?? profile.reasoning`，模型不支持该档位又没选时会报
 * `UNSUPPORTED_REASONING_EFFORT`。所以同一档位的模型必须聚在一条路由里。
 */

/** 系统预设名（12 §7.0「系统预设」） */
export const DSH_SYSTEM_PRESET_NAME = 'Hub 中转站'

/**
 * **桌面平台**的系统预设名（docs/22 §3）：两套预设各一个，桌面端能改、云上不受影响。
 * 迁移 124 复制云上默认预设时用的就是这个后缀规则（`<云上名>（桌面）`）。
 */
export const DSH_DESKTOP_SYSTEM_PRESET_NAME = 'Hub 中转站（桌面）'

/** 由云上预设名推出桌面预设名（复制默认预设时用；与迁移 124 的字面量保持一致） */
export function desktopPresetNameOf(cloudName: string): string {
  return `${cloudName}（桌面）`
}

/** 系统预设的说明（创建时写入；不参与幂等比对） */
export const DSH_SYSTEM_PRESET_DESCRIPTION =
  '由 DSH Hub 自动维护：把「模型 → 下发到 DSH」里勾选的模型渲染进用户 DSH。'

/** 协议基名（12 §7.0：路由名 = 基名 + 有档位时的 `-<档位>`） */
export const DSH_ROUTE_BASE: Record<ModelApi, string> = {
  'openai-completions': 'hub',
  'anthropic-messages': 'hub-anthropic',
  'openai-responses': 'hub-responses',
}

/** 档位在路由名里的先后（无档位在前，然后按 THINKING_LEVELS 顺序；12 §7.0「路由顺序」） */
const THINKING_ORDER = new Map<ThinkingLevel | null, number>([[null, -1]])
THINKING_LEVELS.forEach((level, index) => THINKING_ORDER.set(level, index))

export interface DshSystemProvider {
  /** DSH 里的 provider 路由名：`hub` / `hub-anthropic` / `hub-responses` + 档位后缀 */
  routeKey: string
  /** 用户在 DSH 模型列表里看到的分组标题：所有系统提供方同名（12 §7.0） */
  displayName: string
  api: ModelApi
  /** 这条路由的默认思考档位（渲染成 provider 配置的 `reasoning`）；null = 不设 */
  thinking: ThinkingLevel | null
}

/** 某个「协议 × 档位」组合对应的系统路由名（12 §7.0） */
export function systemRouteName(api: ModelApi, thinking: ThinkingLevel | null): string {
  const base = DSH_ROUTE_BASE[api]
  return thinking === null ? base : `${base}-${thinking}`
}

/** 期望的系统提供方（路由名、显示名、协议、档位） */
export function systemProviderFor(api: ModelApi, thinking: ThinkingLevel | null): DshSystemProvider {
  return {
    routeKey: systemRouteName(api, thinking),
    // WP13 起所有系统提供方共用显示名「DSH Hub」（WP12 的「Hub 中转站 · …」作废）
    displayName: DSH_HUB_PROVIDER_NAME,
    api,
    thinking,
  }
}

/**
 * 某路由名是不是系统路由名（`hub[-anthropic|-responses][-<档位>]`）。
 * 系统路由名是保留的：被非中转站提供方占用 → 同步 CONFLICT / GET warnings（12 §7.0）。
 */
export function isSystemRouteName(routeKey: string): boolean {
  return parseSystemRouteKey(routeKey) !== null
}

/** 拆解系统路由名；不是系统路由名 = null */
export function parseSystemRouteKey(
  routeKey: string,
): { api: ModelApi; thinking: ThinkingLevel | null } | null {
  for (const api of RELAY_DSH_API_PREFERENCE) {
    const base = DSH_ROUTE_BASE[api]
    if (routeKey === base) return { api, thinking: null }
    if (!routeKey.startsWith(`${base}-`)) continue
    const suffix = routeKey.slice(base.length + 1)
    const level = (THINKING_LEVELS as readonly string[]).find((item) => item === suffix)
    if (level) return { api, thinking: level as ThinkingLevel }
  }
  return null
}

/** 所有可能被系统用到的路由名（冲突检查用：哪怕现在没勾选对应档位的模型） */
export function allSystemRouteNames(): string[] {
  const names: string[] = []
  for (const api of RELAY_DSH_API_PREFERENCE) {
    names.push(systemRouteName(api, null))
    for (const level of THINKING_LEVELS) names.push(systemRouteName(api, level))
  }
  return names
}

/**
 * 一个模型用哪个协议渲染进 DSH（12 §7.0）：可用接口里按 `RELAY_DSH_API_PREFERENCE`
 * （openai-completions > anthropic-messages > openai-responses）取的第一个；没有可用接口 = null（不可下发）。
 */
export function deliverApiFor(apis: readonly ModelApi[]): ModelApi | null {
  for (const api of RELAY_DSH_API_PREFERENCE) {
    if (apis.includes(api)) return api
  }
  return null
}

/** 期望状态计算的输入：一条「模型 × 渠道」路由（16 §6.1） */
export interface DshRouteInput {
  routeId: number
  modelId: number
  /** 模型本名（拼 `<模型>@<slug>`） */
  modelName: string
  /** 模型显示名（拼 `<显示名> · <slug>`） */
  displayName: string
  /** 模型排序（与对外模型列表一致：sort DESC、name ASC） */
  sort: number
  /** 生效的默认思考档位 */
  thinking: ThinkingLevel | null
  channelId: number
  channelName: string
  channelSlug: string
  channelPriority: number
  ratePermille: number
  /** 是否被选中下发（`relay_routes.dsh_enabled`；老数据由调用方做兼容判定） */
  selected: boolean
  routeEnabled: boolean
  channelEnabled: boolean
  modelEnabled: boolean
  /** 模型可用接口（启用路由所在启用渠道的并集） */
  modelApis: readonly ModelApi[]
  /** 渠道支持的接口 */
  channelApis: readonly ModelApi[]
  visibility: 'all' | 'admin'
}

/** 这条路由能下发时用哪个协议：模型可用接口 ∩ 渠道 apis，按 `RELAY_DSH_API_PREFERENCE` 取第一个 */
export function deliverApiForRoute(route: DshRouteInput): ModelApi | null {
  const common = route.modelApis.filter((api) => route.channelApis.includes(api))
  return deliverApiFor(common)
}

/**
 * 路由级不能下发的原因（16 §6.1，四种）：模型已停用 / 渠道已停用 / 路由已停用 / 协议不匹配。
 * 顺序就是判定顺序；能下发 = null。
 */
export function dshRouteBlockedReason(route: DshRouteInput): string | null {
  if (!route.modelEnabled) return '模型已停用'
  if (!route.channelEnabled) return '渠道已停用'
  if (!route.routeEnabled) return '路由已停用'
  if (deliverApiForRoute(route) === null) return '协议不匹配'
  return null
}

/** 可下发 = 已选中且没有被阻断 */
export function isDshRouteDeliverable(route: DshRouteInput): boolean {
  return route.selected && dshRouteBlockedReason(route) === null
}

/** 这条路由在 DSH 里的模型 id：`<模型>@<slug>`（16 §6.2） */
export function dshRouteModelId(route: Pick<DshRouteInput, 'modelName' | 'channelSlug'>): string {
  return pinnedModelName(route.modelName, route.channelSlug)
}

/** 这条路由在 DSH 里的显示名：`<显示名> · <slug>` */
export function dshRouteDisplayName(route: Pick<DshRouteInput, 'displayName' | 'channelSlug'>): string {
  return `${route.displayName} · ${route.channelSlug}`
}

export interface DshExpectedPreset {
  name: string
  /** 预设的 provider 顺序 = 期望的系统提供方顺序（默认路由所在提供方第一） */
  providerRouteKeys: string[]
  defaultProvider: string
  /** 16 §6.2：默认模型 id = `<模型>@<slug>` */
  defaultModel: string
}

export interface DshExpectedState {
  /** 需要存在的系统提供方（只包含选中且可下发的路由实际用到的「协议 × 档位」组合） */
  providers: DshSystemProvider[]
  /** 实际生效的默认模型（失效时自动改选；一个可下发的都没有 = null） */
  defaultModelId: number | null
  /** 16 §6：实际生效的默认路由（失效时自动改选；一个可下发的都没有 = null） */
  defaultRouteId: number | null
  /** 系统预设内容；没有任何可下发模型 = null（此时不该有系统预设） */
  preset: DshExpectedPreset | null
}

/** 路由展示顺序：模型 sort 降序、name 升序，同一模型内按路由 id（创建顺序，渠道调优先级不改变渲染结果） */
export function compareDshRoutes(left: DshRouteInput, right: DshRouteInput): number {
  if (left.sort !== right.sort) return right.sort - left.sort
  if (left.modelName !== right.modelName) return left.modelName < right.modelName ? -1 : 1
  if (left.modelId !== right.modelId) return left.modelId - right.modelId
  return left.routeId - right.routeId
}

/** 默认路由候选顺序：模型 sort DESC/name，同一模型内渠道优先级降序、倍率升序、渠道 id 升序（16 §6.1） */
function compareDefaultCandidates(left: DshRouteInput, right: DshRouteInput): number {
  if (left.sort !== right.sort) return right.sort - left.sort
  if (left.modelName !== right.modelName) return left.modelName < right.modelName ? -1 : 1
  if (left.modelId !== right.modelId) return left.modelId - right.modelId
  if (left.channelPriority !== right.channelPriority) return right.channelPriority - left.channelPriority
  if (left.ratePermille !== right.ratePermille) return left.ratePermille - right.ratePermille
  if (left.channelId !== right.channelId) return left.channelId - right.channelId
  return left.routeId - right.routeId
}

/** 路由顺序：默认路由所在提供方第一，其余按协议优先级、档位（无档位在前，然后按 THINKING_LEVELS 顺序） */
function compareProviders(
  left: DshSystemProvider,
  right: DshSystemProvider,
  defaultRouteKey: string,
): number {
  if (left.routeKey === right.routeKey) return 0
  const leftDefault = left.routeKey === defaultRouteKey ? 0 : 1
  const rightDefault = right.routeKey === defaultRouteKey ? 0 : 1
  if (leftDefault !== rightDefault) return leftDefault - rightDefault
  const apiDiff = RELAY_DSH_API_PREFERENCE.indexOf(left.api) - RELAY_DSH_API_PREFERENCE.indexOf(right.api)
  if (apiDiff !== 0) return apiDiff
  return (THINKING_ORDER.get(left.thinking) ?? -1) - (THINKING_ORDER.get(right.thinking) ?? -1)
}

/**
 * 期望状态（16 §6.1 / §6.2）：
 * - 只考虑**已选中且可下发**的路由；一个都没有 → 不要系统提供方、不要系统预设；
 * - 默认路由 = 请求的 route id（仍可下发时）否则剩余里按「模型 sort DESC/name、同模型内渠道优先级/倍率/id」排第一的；
 * - 系统提供方 = 用到的「协议 × 生效档位」组合各一条（路由名/显示名固定）；
 * - 预设的 `default_provider/default_model` = 默认路由所在路由名 / `<模型>@<slug>`。
 */
export function expectedDshState(
  routes: readonly DshRouteInput[],
  requestedDefaultRouteId: number | null,
): DshExpectedState {
  const deliverable = routes.filter(isDshRouteDeliverable)
  if (deliverable.length === 0) {
    return { providers: [], defaultModelId: null, defaultRouteId: null, preset: null }
  }
  const candidates = [...deliverable].sort(compareDefaultCandidates)
  const chosen = deliverable.find((route) => route.routeId === requestedDefaultRouteId) ?? candidates[0]!
  const usedRoutes = new Map<string, DshSystemProvider>()
  for (const route of deliverable) {
    const api = deliverApiForRoute(route)
    if (api === null) continue
    const provider = systemProviderFor(api, route.thinking)
    if (!usedRoutes.has(provider.routeKey)) usedRoutes.set(provider.routeKey, provider)
  }
  const chosenApi = deliverApiForRoute(chosen)!
  const defaultRouteKey = systemRouteName(chosenApi, chosen.thinking)
  const providers = [...usedRoutes.values()].sort((left, right) =>
    compareProviders(left, right, defaultRouteKey),
  )
  return {
    providers,
    defaultModelId: chosen.modelId,
    defaultRouteId: chosen.routeId,
    preset: {
      name: DSH_SYSTEM_PRESET_NAME,
      providerRouteKeys: providers.map((provider) => provider.routeKey),
      defaultProvider: defaultRouteKey,
      defaultModel: dshRouteModelId(chosen),
    },
  }
}

// ── 渲染指纹 ────────────────────────────────────────────────────────────────

/** 一个要渲染进用户 DSH 的模型条目 = 一条选中且可下发的路由（16 §6.2） */
export interface DshRenderModel {
  /** `relay_routes.id`（渲染顺序的次级键） */
  routeId: number
  /** `relay_models.id` */
  modelId: number
  /** `relay_models.sort`（渲染顺序的首要键） */
  sort: number
  /** 模型本名（用于排序与说明） */
  modelName: string
  /** 渠道标识（显示名后缀） */
  channelSlug: string
  /** 模型条目 id：`<模型>@<slug>` */
  id: string
  /** 模型条目 name：`<显示名> · <slug>` */
  name: string
  /** 挂在哪个协议下（每条路由只挂一个） */
  api: ModelApi
  /** 生效的默认思考档位（决定它挂在哪条路由下） */
  thinking: ThinkingLevel | null
  /** 只对 all 的用户可见；admin-only 的模型普通用户渲染不到 */
  visibility: 'all' | 'admin'
  info: ModelInfo
  compat: Record<string, unknown> | null
}

/**
 * 渲染指纹（12 §7.0：`revision` 每次**影响渲染的变化** +1）。
 *
 * 为什么不能只看系统预设那一行：模型名、显示名、上下文、compat、**生效档位**都不在预设里（预设只有提供方与默认模型），
 * 但它们确实会改变 `managed.patch.yml` 的内容。这里把这些字段规范化后取哈希，
 * 让「改档位 → 要重新下发」「改价格 → 不用」都能精确判定，且重复调用结果一致（幂等）。
 */
export function dshRenderFingerprint(
  models: readonly DshRenderModel[],
  expected: DshExpectedState,
  /** 搜索池的渲染指纹（14 §5）：工具开关变化也要让「待下发」出现 */
  toolsFingerprint: string | null = null,
): string {
  const canonical = {
    providers: expected.providers.map((provider) => ({
      routeKey: provider.routeKey,
      api: provider.api,
      displayName: provider.displayName,
      thinking: provider.thinking,
    })),
    default: expected.preset
      ? { provider: expected.preset.defaultProvider, model: expected.preset.defaultModel }
      : null,
    models: [...models]
      // 与 compareDshRoutes 一致：同一模型的多条渠道条目顺序也是渲染结果的一部分
      .sort(
        (left, right) =>
          right.sort - left.sort ||
          (left.modelName < right.modelName ? -1 : left.modelName > right.modelName ? 1 : 0) ||
          left.modelId - right.modelId ||
          left.routeId - right.routeId,
      )
      .map((model) => ({
        routeId: model.routeId,
        rowId: model.modelId,
        sort: model.sort,
        id: model.id,
        name: model.name,
        slug: model.channelSlug,
        api: model.api,
        routeKey: systemRouteName(model.api, model.thinking),
        thinking: model.thinking,
        visibility: model.visibility,
        contextWindow: model.info.contextWindow ?? null,
        maxTokens: model.info.maxTokens ?? null,
        input: model.info.input ?? null,
        reasoningEfforts: model.info.reasoningEfforts ?? null,
        compat: model.compat,
      })),
    tools: toolsFingerprint,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)
}
