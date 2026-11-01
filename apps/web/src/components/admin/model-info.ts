import type { ModelInfo, ModelInput, ModelSpec } from '@dsh-hub/shared'

/**
 * 模型参数（上下文 / 最大输出 / 输入类型）与「模型信息库」补全的纯函数。
 * 补全只填**空着的**字段：用户手填过的值永远不被库覆盖。
 */

export const MODEL_INPUT_OPTIONS: { label: string; value: ModelInput }[] = [
  { label: '文字', value: 'text' },
  { label: '图片', value: 'image' },
]

/** 输入类型按固定顺序、去重、丢掉不认识的；一个不剩 → undefined（不声明） */
export function normalizeInputs(list: readonly string[] | undefined): ModelInput[] | undefined {
  const picked = MODEL_INPUT_OPTIONS.map((option) => option.value).filter((kind) => list?.includes(kind))
  return picked.length > 0 ? picked : undefined
}

/**
 * token 数的紧凑写法：384000 → 384K，1000000 → 1M，131072 → 128K，其它保留千分位。
 * 十进制整数优先（384000 同时是 1024 的倍数，但写 375K 会误导），不是整千的再按 1024 算。
 */
export function formatTokens(value: number): string {
  const unit = (divisor: number, suffix: string): string | null =>
    value >= divisor && value % divisor === 0 ? `${value / divisor}${suffix}` : null
  return (
    unit(1_000_000, 'M') ??
    unit(1000, 'K') ??
    unit(1_048_576, 'M') ??
    unit(1024, 'K') ??
    value.toLocaleString('en-US')
  )
}

/** 一行摘要，如「1M 上下文 · 384K 输出 · 文字+图片 · 思考 off/low/high/max」；什么都没有 → 空串 */
export function modelInfoSummary(info: ModelInfo): string {
  const parts: string[] = []
  if (info.contextWindow !== undefined) parts.push(`${formatTokens(info.contextWindow)} 上下文`)
  if (info.maxTokens !== undefined) parts.push(`${formatTokens(info.maxTokens)} 输出`)
  if (info.input && info.input.length > 0) {
    parts.push(info.input.map((kind) => (kind === 'image' ? '图片' : '文字')).join('+'))
  }
  if (info.reasoningEfforts && info.reasoningEfforts.length > 0) {
    parts.push(`思考 ${info.reasoningEfforts.join('/')}`)
  }
  return parts.join(' · ')
}

/** 这个模型有没有填任何参数（决定能不能存进模型库、要不要自动补全） */
export function hasModelInfo(model: ModelInfo): boolean {
  return (
    model.contextWindow !== undefined ||
    model.maxTokens !== undefined ||
    (model.input?.length ?? 0) > 0 ||
    (model.reasoningEfforts?.length ?? 0) > 0
  )
}

/**
 * 把库里的信息补进模型：只填空字段；显示名只在空着或等于 id 时才换成库里的。
 * 没有任何变化时原样返回同一个对象（调用方据此判断「有没有补上」）。
 */
export function fillMissing(model: ModelSpec, info: ModelInfo): ModelSpec {
  const next: ModelSpec = { ...model }
  if (next.contextWindow === undefined && info.contextWindow !== undefined) {
    next.contextWindow = info.contextWindow
  }
  if (next.maxTokens === undefined && info.maxTokens !== undefined) next.maxTokens = info.maxTokens
  if ((next.input?.length ?? 0) === 0 && info.input && info.input.length > 0) next.input = [...info.input]
  if (
    (next.reasoningEfforts?.length ?? 0) === 0 &&
    info.reasoningEfforts &&
    info.reasoningEfforts.length > 0
  ) {
    next.reasoningEfforts = [...info.reasoningEfforts]
  }
  if ((!next.name || next.name === next.id) && info.name && info.name !== next.id) next.name = info.name
  const changed =
    next.contextWindow !== model.contextWindow ||
    next.maxTokens !== model.maxTokens ||
    next.input !== model.input ||
    next.reasoningEfforts !== model.reasoningEfforts ||
    next.name !== model.name
  return changed ? next : model
}

/** 存进模型库的条目：只带填了的字段；显示名和 id 一样时不存 */
export function toCatalogInput(model: ModelSpec): {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ModelInput[]
  reasoningEfforts?: string[]
} {
  const id = model.id.trim()
  return {
    id,
    ...(model.name && model.name !== id ? { name: model.name } : {}),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.input && model.input.length > 0 ? { input: [...model.input] } : {}),
    ...(model.reasoningEfforts && model.reasoningEfforts.length > 0
      ? { reasoningEfforts: [...model.reasoningEfforts] }
      : {}),
  }
}
