/**
 * `session/modelCatalog` → 手机 `models` 帧的投影（契约 §4、§17 D3）。
 *
 * 两条来自实测的硬事实（不能靠猜）：
 * - **是否支持思考** = 该模型有没有 `reasoning` 字段；
 * - **支持哪些档位** = `reasoning.efforts[].id`，**任意字符串**（`ReasoningEffortId` 无约束），
 *   所以 App 不能硬编码 off/low/high/max，四档映射由 Hub 侧的一张表 + 未知 id 兜底决定。
 *
 * `failures[]` 是「某些 provider 拿不到模型」（网络/凭据）的隔离错误，
 * **不**代表整个能力不可用，原样透传但不阻断。
 */

/** App 的四档（与 `@dsh-hub/shared` 的 `MOBILE_EFFORT_TIERS` 一致；本包不依赖 shared）。 */
export type EffortTier = 'low' | 'medium' | 'high' | 'ultra'

export const EFFORT_TIERS: readonly EffortTier[] = ['low', 'medium', 'high', 'ultra']

/**
 * 四档 ↔ DSH effort id（§17 D3 一一对应）：低→off、中等→low、高→high、超高→max。
 * 「低」就是「不思考」，不另设开关。
 */
export const DSH_EFFORT_BY_TIER: Readonly<Record<EffortTier, string>> = {
  low: 'off',
  medium: 'low',
  high: 'high',
  ultra: 'max',
}

const TIER_BY_DSH_EFFORT: Readonly<Record<string, EffortTier>> = Object.fromEntries(
  EFFORT_TIERS.map((tier) => [DSH_EFFORT_BY_TIER[tier], tier]),
) as Readonly<Record<string, EffortTier>>

export function tierOfDshEffort(effortId: string): EffortTier | null {
  return TIER_BY_DSH_EFFORT[effortId] ?? null
}

export interface ModelEffortEntry {
  id: string
  name: string
  description?: string
  tier: EffortTier | null
}

export interface ModelEntry {
  provider: string
  model: string
  name: string
  description: string | null
  efforts: ModelEffortEntry[]
  defaultEffort: string | null
}

export interface ModelSelectionView {
  provider: string
  model: string
  effort?: string
}

export interface ModelCatalogFailure {
  provider: string
  name: string
  message: string
}

export interface ModelCatalogView {
  default: ModelSelectionView
  items: ModelEntry[]
  failures: ModelCatalogFailure[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function projectEfforts(reasoning: Record<string, unknown>): ModelEffortEntry[] {
  const raw = reasoning['efforts']
  if (!Array.isArray(raw)) return []
  const efforts: ModelEffortEntry[] = []
  for (const item of raw.slice(0, 16)) {
    const record = asRecord(item)
    const id = asText(record['id'])
    if (id === null) continue
    const description = asText(record['description'])
    efforts.push({
      id: id.slice(0, 64),
      name: (asText(record['name']) ?? id).slice(0, 64),
      ...(description === null ? {} : { description: description.slice(0, 500) }),
      tier: tierOfDshEffort(id),
    })
  }
  return efforts
}

/**
 * 把 `session/modelCatalog` 的返回值摊平成 `items[]`（provider 分组对 App 不可见）。
 *
 * `default` 里的 `reasoningEffort` 可能缺省（模型不支持思考）；这时 `effort` 字段也不给，
 * 因为 DSH 的 `selectModel` 对「不支持思考的模型 + reasoningEffort」是**直接报错**的。
 */
export function projectModelCatalog(value: unknown): ModelCatalogView {
  const root = asRecord(value)
  const defaultSelection = asRecord(root['default'])
  const defaultProvider = asText(defaultSelection['provider']) ?? ''
  const defaultModel = asText(defaultSelection['model']) ?? ''
  const defaultEffort = asText(defaultSelection['reasoningEffort'])
  const items: ModelEntry[] = []
  const groups = Array.isArray(root['groups']) ? root['groups'] : []
  for (const group of groups) {
    const groupRecord = asRecord(group)
    const provider = asText(groupRecord['id'])
    if (provider === null) continue
    const models = Array.isArray(groupRecord['models']) ? groupRecord['models'] : []
    for (const model of models) {
      const record = asRecord(model)
      const id = asText(record['id'])
      if (id === null) continue
      const reasoning = asRecord(record['reasoning'])
      const hasReasoning = Object.keys(reasoning).length > 0
      const efforts = hasReasoning ? projectEfforts(reasoning) : []
      const description = asText(record['description'])
      items.push({
        provider: provider.slice(0, 64),
        model: id.slice(0, 128),
        name: (asText(record['name']) ?? id).slice(0, 120),
        description: description === null ? null : description.slice(0, 500),
        efforts,
        defaultEffort: hasReasoning ? (asText(reasoning['defaultEffort']) ?? efforts[0]?.id ?? null) : null,
        // `input.image` 恒 null：§17 D2 不做图片能力位（modelCatalog 不返回模态，Hub 不猜）
      })
      if (items.length >= 64) break
    }
  }
  const failures: ModelCatalogFailure[] = []
  const rawFailures = Array.isArray(root['failures']) ? root['failures'] : []
  for (const failure of rawFailures.slice(0, 16)) {
    const record = asRecord(failure)
    failures.push({
      provider: (asText(record['provider']) ?? 'unknown').slice(0, 64),
      name: (asText(record['name']) ?? '').slice(0, 120),
      message: (asText(record['message']) ?? '模型目录不可用').slice(0, 500),
    })
  }
  const fallback = items[0]
  return {
    default:
      defaultProvider !== '' && defaultModel !== ''
        ? {
            provider: defaultProvider.slice(0, 64),
            model: defaultModel.slice(0, 128),
            ...(defaultEffort === null ? {} : { effort: defaultEffort.slice(0, 64) }),
          }
        : fallback === undefined
          ? { provider: '', model: '' }
          : { provider: fallback.provider, model: fallback.model },
    items,
    failures,
  }
}

/** 找到某个模型的目录条目（`set-model` 预检用）。 */
export function findModel(
  catalog: ModelCatalogView,
  provider: string,
  model: string,
): ModelEntry | undefined {
  return catalog.items.find((item) => item.provider === provider && item.model === model)
}

/**
 * 档位预检：`effort` 必须在该模型的 `efforts[].id` 里。
 *
 * 返回 `ok` 时不代表 DSH 一定接受（竞态：会话开着时目录变了），
 * 只代表「按 Hub 缓存的目录看是合法的」——真正的权威是 Host。
 */
export function checkEffort(
  item: ModelEntry,
  effort: string | undefined,
): { ok: true; effort?: string } | { ok: false; reason: 'effort-unsupported' | 'model-no-reasoning' } {
  if (item.efforts.length === 0) {
    // 模型完全不支持思考：带 effort 会被 DSH 直接拒（llm/src/index.ts:908-940），必须省略
    return effort === undefined ? { ok: true } : { ok: false, reason: 'model-no-reasoning' }
  }
  const wanted = effort ?? item.defaultEffort ?? item.efforts[0]?.id
  if (wanted === undefined) return { ok: false, reason: 'effort-unsupported' }
  if (!item.efforts.some((candidate) => candidate.id === wanted)) {
    return { ok: false, reason: 'effort-unsupported' }
  }
  return { ok: true, effort: wanted }
}
