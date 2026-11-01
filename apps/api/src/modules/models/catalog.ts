import type { ModelInfo } from '@dsh-hub/shared'
import { BUILTIN_CATALOG, type BuiltinModel } from './catalog-data.js'

/**
 * 模型信息库的匹配（纯函数，不碰数据库）。
 *
 * 目标：用户从上游拿到的模型 id 写法五花八门（`deepseek/deepseek-chat:free`、`claude-sonnet-4-5-20250929`、
 * `deepseek-v4.1-flash`），按「规范化后的名字」对上库里的条目，补出上下文 / 输出上限 / 输入类型 / 思考档位。
 * 只做**精确的规范化匹配**，不做前缀 / 模糊匹配 —— 宁可没匹配上让用户手填，也不要悄悄填一个别的模型的参数
 * （`gpt-4o-mini` 不能落到 `gpt-4o` 头上）。
 */

/** 规范化的公共尾巴：非字母数字 → `-`，去掉日期后缀（`-20250514` / `-2025-05-14`）与 `-latest` */
function finish(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, '')
    .replace(/-latest$/u, '')
}

/** 模型 id → 匹配键：去厂商路径前缀（`a/b/c` → `c`）和 `:free` 之类的后缀，其余同 `finish` */
export function normalizeModelKey(raw: string): string {
  let text = raw.trim().toLowerCase()
  const slash = text.lastIndexOf('/')
  if (slash >= 0) text = text.slice(slash + 1)
  const colon = text.indexOf(':')
  if (colon >= 0) text = text.slice(0, colon)
  return finish(text)
}

/** 显示名 → 匹配键（显示名里的 `/`、`:` 是文字的一部分，不当作路径 / 后缀） */
export function normalizeModelName(raw: string): string {
  return finish(raw.trim().toLowerCase())
}

/** 库里的一条（内置 / 自定义共用） */
export interface CatalogItem extends ModelInfo {
  id: string
}

export interface CatalogHit {
  /** 命中的最高优先级来源 */
  source: 'custom' | 'builtin'
  /** 命中的库条目 id */
  matchedId: string
  /** 合并后的信息：自定义里写了的字段优先，其余用内置补 */
  info: ModelInfo
}

interface Layer {
  byId: Map<string, CatalogItem>
  byName: Map<string, CatalogItem>
}

function buildLayer(items: readonly CatalogItem[]): Layer {
  const byId = new Map<string, CatalogItem>()
  const byName = new Map<string, CatalogItem>()
  // 列表顺序 = 优先级：规范化后撞键的，先到先得
  for (const item of items) {
    const idKey = normalizeModelKey(item.id)
    if (idKey && !byId.has(idKey)) byId.set(idKey, item)
    if (item.name) {
      const nameKey = normalizeModelName(item.name)
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, item)
    }
  }
  return { byId, byName }
}

function findInLayer(layer: Layer, key: string): CatalogItem | undefined {
  // id 命中优先于显示名命中：`deepseek-v4.1-flash` 既是某条的 id，也是另一条的显示名时，认 id
  return layer.byId.get(key) ?? layer.byName.get(key)
}

function infoOf(item: CatalogItem): ModelInfo {
  const info: ModelInfo = {}
  if (item.name) info.name = item.name
  if (item.contextWindow !== undefined) info.contextWindow = item.contextWindow
  if (item.maxTokens !== undefined) info.maxTokens = item.maxTokens
  if (item.input && item.input.length > 0) info.input = [...item.input]
  if (item.reasoningEfforts && item.reasoningEfforts.length > 0)
    info.reasoningEfforts = [...item.reasoningEfforts]
  return info
}

export interface CatalogMatcher {
  match(modelId: string): CatalogHit | null
}

/** 自定义在前、内置在后；两层都命中时按字段合并（自定义写了的字段优先） */
export function createCatalogMatcher(
  custom: readonly CatalogItem[],
  builtin: readonly BuiltinModel[] = BUILTIN_CATALOG,
): CatalogMatcher {
  const customLayer = buildLayer(custom)
  const builtinLayer = buildLayer(builtin)
  return {
    match(modelId) {
      const key = normalizeModelKey(modelId)
      if (!key) return null
      const fromCustom = findInLayer(customLayer, key)
      const fromBuiltin = findInLayer(builtinLayer, key)
      if (!fromCustom && !fromBuiltin) return null
      const info = { ...(fromBuiltin ? infoOf(fromBuiltin) : {}), ...(fromCustom ? infoOf(fromCustom) : {}) }
      return {
        source: fromCustom ? 'custom' : 'builtin',
        matchedId: (fromCustom ?? fromBuiltin)!.id,
        info,
      }
    },
  }
}
