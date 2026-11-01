import { THINKING_LEVELS, type ModelSpec, type ThinkingLevel } from '@dsh-hub/shared'

/**
 * 模型思考档位（06 §4.1）：模型条目里勾了哪些档位，用户在 DSH 对话框里就能选哪些；
 * 一个都不勾 = 不声明，自定义路由上 DSH 当作不支持思考（不显示档位）。
 */
const LEVEL_TEXT: Record<ThinkingLevel, string> = {
  off: '关闭思考',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

export const THINKING_LEVEL_OPTIONS = THINKING_LEVELS.map((level) => ({
  label: `${level} · ${LEVEL_TEXT[level]}`,
  value: level,
}))

/** DeepSeek 官方档位：可关闭思考 + low / high / max 三档（dsh-llm-deepseek 的 REASONING_EFFORTS） */
export const DEEPSEEK_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'high', 'max']

/** 「不指定」在默认思考下拉里的值（NSelect 用 null 会显示占位符，所以用空串当哨兵） */
export const THINKING_NONE = ''

/** 档位的中文名（「最高」） */
export function thinkingLevelText(level: ThinkingLevel): string {
  return LEVEL_TEXT[level]
}

/** 「max · 最高」：下拉与悬停提示用 */
export function thinkingLevelLabel(level: ThinkingLevel): string {
  return `${level} · ${LEVEL_TEXT[level]}`
}

/**
 * 「默认思考档位」下拉的候选：不指定 + 模型声明的档位（12 §10 定价弹窗）。
 * 候选列表由调用方按当前勾选实时算，所以这里只是个纯映射。
 */
export function defaultThinkingOptions(levels: readonly ThinkingLevel[]): { label: string; value: string }[] {
  return [
    { label: '不指定', value: THINKING_NONE },
    ...levels.map((level) => ({ label: thinkingLevelLabel(level), value: level })),
  ]
}

/** 按强度排序、去重、丢掉不认识的档位；一个不剩 → undefined（不声明） */
export function normalizeThinkingLevels(levels: readonly string[]): ThinkingLevel[] | undefined {
  const picked = THINKING_LEVELS.filter((level) => levels.includes(level))
  return picked.length > 0 ? picked : undefined
}

/**
 * 能拿来当默认档位的声明：至少有一个 off 之外的档位（只有 off 的声明渲染时会被整体丢掉，
 * 与 shared 的 `effectiveDshThinking()` 同一口径）。
 */
export function usableThinkingLevels(levels: readonly string[] | undefined): ThinkingLevel[] {
  const declared = normalizeThinkingLevels(levels ?? []) ?? []
  return declared.some((level) => level !== 'off') ? declared : []
}

/** 保存前校验：只勾了 off 的模型会让 DSH 拒绝整条路由，返回提示；没问题返回 null */
export function thinkingLevelsProblem(models: readonly ModelSpec[]): string | null {
  const offOnly = models.find(
    (model) => model.reasoningEfforts?.length === 1 && model.reasoningEfforts[0] === 'off',
  )
  if (!offOnly) return null
  return `模型 ${offOnly.id || '（未填 id）'} 只勾了 off：至少再勾一个思考档位，或者清空表示不支持思考`
}
