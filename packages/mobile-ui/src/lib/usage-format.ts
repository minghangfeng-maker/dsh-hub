/**
 * 会话用量的展示层计算（纯函数，可单测）。
 *
 * **缓存命中率**口径：`cacheReadTokens / (inputTokens + cacheReadTokens)`。
 * DSH 的 `assistant/message.usage` 里 `inputTokens` 是**未命中缓存的输入**，
 * `cacheReadTokens` 是命中缓存的前缀部分（两者相加才是完整 prompt），
 * 所以命中率 = 命中 / 完整 prompt。totals 为 0（空会话/老数据）时返回 null，
 * 面板显示「—」，不除零、不假装 0%。
 */

export interface UsageTokensLike {
  inputTokens: number
  cacheReadTokens: number
}

/** 缓存命中率（0..1）；没有可用的 prompt token 时返回 null。 */
export function cacheHitRate(usage: UsageTokensLike | null | undefined): number | null {
  if (!usage) return null
  const { inputTokens, cacheReadTokens } = usage
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cacheReadTokens)) return null
  const prompt = inputTokens + cacheReadTokens
  if (!(prompt > 0)) return null
  const rate = cacheReadTokens / prompt
  return Math.min(1, Math.max(0, rate))
}

/** 命中率文案：一位小数（44.4%）；null → 「—」。 */
export function formatCacheHitRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/** 便捷组合：直接从 usage 取文案（面板用）。 */
export function cacheHitRateText(usage: UsageTokensLike | null | undefined): string {
  return formatCacheHitRate(cacheHitRate(usage))
}

/** 1 积分 = 1_000_000 微积分（与 Hub 的 `RELAY_MICRO_PER_POINT` 一致）。 */
const POINTS_MICRO_PER_POINT = 1_000_000

function trimTrailingZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/**
 * 会话积分消耗（微积分 → 积分文案）。
 *
 * 口径与 Hub 账单一致：1 积分 = 1_000_000 微积分。
 * - `null`/`undefined` → 「—」（老 Hub 或模型没有价格信息）；
 * - ≥ 1 积分：两位小数 + 千分位；
 * - 0 < x < 1：最多 4 位小数去掉多余 0；再小显示 `<0.0001`。
 */
export function formatPointsMicro(micro: number | null | undefined): string {
  if (micro === null || micro === undefined || !Number.isFinite(micro)) return '—'
  if (micro === 0) return '0'
  const points = micro / POINTS_MICRO_PER_POINT
  const abs = Math.abs(points)
  const sign = points < 0 ? '-' : ''
  if (abs >= 1) {
    return `${sign}${abs.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  const text = trimTrailingZeros(abs.toFixed(4))
  if (text === '0') return `${sign}<0.0001`
  return `${sign}${text}`
}
