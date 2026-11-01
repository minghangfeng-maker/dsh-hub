/**
 * 模型与思考程度：**数据驱动**目录（冻结项 D3）。
 *
 * 数据来源两种，形状统一：
 *   1. 通道 v2 的 `models` 帧（Hub 摊平后的 `items`）—— 服务端回显 `models` feature 时优先；
 *   2. `fixtures-v2/models-catalog.json` 的原始形状（mock）—— 通过 `flattenModelCatalog()` 转成同一形状。
 *
 * 冻结裁决（M5 §17，覆盖草案里的 A 方案）：
 *   App 四档 ↔ DSH effort **一一对应**：低=off、中等=low、高=high（默认）、超高=max。
 *   档位是否可选只看当前模型的 `efforts[].id`；未知 id 直接忽略。
 *   模型没有 `reasoning` → 整个思考程度区置灰，提示「该模型不支持调节思考程度」。
 *
 * 这里不硬编码 provider 语义：provider/model 只作为不透明字符串回传给 Hub（§6.2）。
 */

import type { Backend } from '../contracts/auth-bootstrap.js'
import { MOCK_MODEL_CATALOG, type RawModelCatalog } from '../mock/models-catalog.js'

/** App 的四档（UI 词汇，不是 DSH 的 effort id）。 */
export type EffortTierId = 'low' | 'medium' | 'high' | 'ultra'

export interface EffortLevel {
  id: EffortTierId
  /** UI 文案：低 / 中等 / 高 / 超高（§1.4 第 1 条） */
  label: string
  /** 冻结映射：这一档对应 DSH 的哪个 effort id。 */
  dshEffortId: string
  desc: string
}

/** 四档固定顺序：从弱到强；「低」就是 DSH 的 off（不思考）。 */
export const EFFORT_LEVELS: EffortLevel[] = [
  { id: 'low', label: '低', dshEffortId: 'off', desc: '不思考，最快' },
  { id: 'medium', label: '中等', dshEffortId: 'low', desc: '轻量思考' },
  { id: 'high', label: '高', dshEffortId: 'high', desc: '默认，平衡' },
  { id: 'ultra', label: '超高', dshEffortId: 'max', desc: '最慢，质量优先' },
]

const TIER_BY_DSH_ID: Record<string, EffortTierId> = {
  off: 'low',
  low: 'medium',
  high: 'high',
  max: 'ultra',
}

export function dshEffortIdOfTier(tier: EffortTierId): string {
  return EFFORT_LEVELS.find((e) => e.id === tier)?.dshEffortId ?? 'high'
}

/** 未知 id 返回 null（App 忽略，不显示）。 */
export function tierOfDshEffort(effortId: string | null | undefined): EffortTierId | null {
  if (!effortId) return null
  return TIER_BY_DSH_ID[effortId] ?? null
}

export interface CatalogEffort {
  id: string
  name: string
  description?: string
}

export interface CatalogModel {
  provider: string
  model: string
  name: string
  description: string | null
  /** 空数组 = 不支持思考。 */
  efforts: CatalogEffort[]
  /** DSH 的 defaultEffort；null = 不支持思考。 */
  defaultEffort: string | null
  input?: { text: true; image: boolean | null }
  /**
   * 渠道倍率（1 = 原价，0.3 = 三折）；null/undefined = 后端没给价格信息。
   * 来自 Hub 中转站的渠道倍率，手机端在模型名后显示 `X0.3`。
   */
  multiplier?: number | null
}

export interface BackendModelCatalog {
  backendId: string
  items: CatalogModel[]
  default: { provider: string; model: string; effort?: string } | null
  failures: Array<{ provider: string; name: string; message: string }>
  /** 'channel-v2' = 服务端 `models` 帧；'mock' = 本地 fixture。 */
  source: 'mock' | 'channel-v2'
}

export interface ModelSelection {
  provider: string
  model: string
  /** App 档位；null = 该模型不支持思考（整块置灰）。 */
  effortTier: EffortTierId | null
}

export function modelKey(model: Pick<CatalogModel, 'provider' | 'model'>): string {
  return `${model.provider}/${model.model}`
}

export function parseModelKey(key: string | null | undefined): { provider: string; model: string } | null {
  if (!key) return null
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return null
  return { provider: key.slice(0, at), model: key.slice(at + 1) }
}

/** 原始 `session/modelCatalog` 形状 → 统一目录。 */
export function flattenModelCatalog(raw: RawModelCatalog, backendId: string): BackendModelCatalog {
  const items: CatalogModel[] = []
  for (const group of raw.groups ?? []) {
    for (const model of group.models ?? []) {
      const efforts = (model.reasoning?.efforts ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        ...(e.description ? { description: e.description } : {}),
      }))
      items.push({
        provider: group.id,
        model: model.id,
        name: model.name,
        description: model.description ?? null,
        efforts,
        defaultEffort: efforts.length > 0 ? (model.reasoning?.defaultEffort ?? null) : null,
        // modelCatalog 不返回模态；null = 未知，不拦（§4.1 / D2）。
        input: { text: true, image: null },
      })
    }
  }
  return {
    backendId,
    items,
    default: raw.default
      ? {
          provider: raw.default.provider,
          model: raw.default.model,
          ...(raw.default.reasoningEffort ? { effort: raw.default.reasoningEffort } : {}),
        }
      : null,
    failures: raw.failures ?? [],
    source: 'mock',
  }
}

/**
 * mock 后端目录：按 kind 给同一份 fixture（真实容器导出）。
 * TODO(WP40c-2)：真实 `models` 帧到达后由 auth store 覆盖 `source='channel-v2'` 的目录。
 */
export function resolveModelCatalog(backend: Pick<Backend, 'id' | 'kind'> | null): BackendModelCatalog {
  if (!backend) {
    return { backendId: '', items: [], default: null, failures: [], source: 'mock' }
  }
  return flattenModelCatalog(MOCK_MODEL_CATALOG, backend.id)
}

/**
 * `models` 帧里模型的最小结构。
 *
 * 刻意比 shared 的 `MobileModel` 宽松：目录只关心「有哪些模型、每档 effort 在不在」，
 * 不关心 description/input 这些投影细节；测试与 mock 也不用把每个字段填满。
 */
export interface ServerModelLike {
  provider: string
  model: string
  name: string
  description?: string | null
  efforts: Array<{
    id: string
    name: string
    description?: string
    /** shared 的 App 档归一结果；目录不依赖它，按 `efforts[].id` 自己算。 */
    tier?: 'low' | 'medium' | 'high' | 'ultra' | null
  }>
  defaultEffort: string | null
  input?: { text: true; image: boolean | null }
  /** Hub 中转站的渠道倍率（1 = 原价）；老 Hub 不传。 */
  multiplier?: number
}

/** 从 `models` 帧的 items 构造目录（服务端已摊平）。 */
export function catalogFromServer(input: {
  backendId: string
  items: ServerModelLike[]
  default?: { provider: string; model: string; effort?: string } | null
  failures?: Array<{ provider: string; name: string; message: string }>
}): BackendModelCatalog {
  const items: CatalogModel[] = input.items.map((m) => ({
    provider: m.provider,
    model: m.model,
    name: m.name,
    description: m.description ?? null,
    efforts: m.efforts.map((e) => ({
      id: e.id,
      name: e.name,
      ...(e.description ? { description: e.description } : {}),
    })),
    defaultEffort: m.defaultEffort,
    input: m.input ?? { text: true as const, image: null },
    multiplier: typeof m.multiplier === 'number' && Number.isFinite(m.multiplier) ? m.multiplier : null,
  }))
  return {
    backendId: input.backendId,
    items,
    default: input.default ?? null,
    failures: input.failures ?? [],
    source: 'channel-v2',
  }
}

export function supportsThinking(model: CatalogModel | null | undefined): boolean {
  return !!model && model.efforts.length > 0
}

export function tierAvailable(model: CatalogModel | null | undefined, tier: EffortTierId): boolean {
  if (!supportsThinking(model)) return false
  const effortId = dshEffortIdOfTier(tier)
  return !!model!.efforts.some((e) => e.id === effortId)
}

export function availableTiers(model: CatalogModel | null | undefined): EffortTierId[] {
  return EFFORT_LEVELS.filter((tier) => tierAvailable(model, tier.id)).map((t) => t.id)
}

/**
 * 默认档：模型自己的 defaultEffort 映射得到就用它；否则用「高」（§17 的 App 默认）；
 * 再不行取第一个可用档；模型不支持思考 → null。
 */
export function defaultTierOf(model: CatalogModel | null | undefined): EffortTierId | null {
  if (!supportsThinking(model)) return null
  const fromDefault = tierOfDshEffort(model!.defaultEffort)
  if (fromDefault && tierAvailable(model, fromDefault)) return fromDefault
  if (tierAvailable(model, 'high')) return 'high'
  return availableTiers(model)[0] ?? null
}

export function findModel(
  catalog: BackendModelCatalog,
  key: string | null | undefined,
): CatalogModel | null {
  if (!key) return null
  return catalog.items.find((m) => modelKey(m) === key) ?? null
}

/** 服务端给的当前选择（provider/model/effort id）→ App 选择。 */
export function selectionFromServer(
  catalog: BackendModelCatalog,
  selection: { provider: string; model: string; effort?: string } | null | undefined,
): ModelSelection | null {
  if (!selection) return null
  const model =
    catalog.items.find((m) => m.provider === selection.provider && m.model === selection.model) ??
    null
  if (!model) return null
  const tier =
    tierOfDshEffort(selection.effort) ?? defaultTierOf(model)
  return {
    provider: model.provider,
    model: model.model,
    effortTier: tier && tierAvailable(model, tier) ? tier : defaultTierOf(model),
  }
}

/**
 * 归一化「账号 + 后端」记住的选择：
 * 模型不存在 → 目录第一个；档位不被该模型支持 → 默认档；模型不支持思考 → null。
 */
export function normalizeSelection(
  catalog: BackendModelCatalog,
  saved: { modelId?: string; effortId?: string } | null,
): ModelSelection | null {
  if (catalog.items.length === 0) return null
  const savedModelId: string | undefined = saved?.modelId
  const savedEffortId: string | undefined = saved?.effortId
  const bySaved = findModel(catalog, savedModelId)
  const byDefault = catalog.default
    ? catalog.items.find(
        (m) => m.provider === catalog.default!.provider && m.model === catalog.default!.model,
      )
    : undefined
  const model = bySaved ?? byDefault ?? catalog.items[0]!
  const savedTier = tierOfDshEffort(savedEffortId)
  const tier =
    savedTier && tierAvailable(model, savedTier) ? savedTier : defaultTierOf(model)
  return { provider: model.provider, model: model.model, effortTier: tier }
}

/** 发送 `create` / `set-model` 时用的 DSH effort id；模型不支持思考时必须缺省。 */
export function effortIdForSelection(
  catalog: BackendModelCatalog,
  selection: ModelSelection | null,
): string | undefined {
  if (!selection || !selection.effortTier) return undefined
  const model = findModel(catalog, modelKey(selection))
  if (!model || !tierAvailable(model, selection.effortTier)) return undefined
  return dshEffortIdOfTier(selection.effortTier)
}

/** 持久化用：modelId = provider/model，effortId = DSH 原始 id。 */
export function toStoredSelection(
  selection: ModelSelection | null,
): { modelId: string; effortId: string } | null {
  if (!selection) return null
  return {
    modelId: modelKey(selection),
    effortId: selection.effortTier ? dshEffortIdOfTier(selection.effortTier) : '',
  }
}

/** 芯片文案（§1.4 第 1 条）：只显示思考程度，不显示模型名。 */
export function chipLabel(selection: ModelSelection | null): string {
  if (!selection) return '思考程度 —'
  if (!selection.effortTier) return '思考程度 —'
  const tier = EFFORT_LEVELS.find((e) => e.id === selection.effortTier)
  return `思考程度 ${tier?.label ?? '高'}`
}

export function effortLabel(tier: EffortTierId | null | undefined): string {
  return EFFORT_LEVELS.find((e) => e.id === tier)?.label ?? '—'
}
