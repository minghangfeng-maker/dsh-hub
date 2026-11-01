import type { RelayPrice } from '@dsh-hub/shared'

/** 计费用的 token（reasoning 已含在 output 里，不单独计费） */
export interface BillableTokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** 计费用的三个倍率（12 §6.2、18 §3.3）：费用 = 模型价格算出的费用 × 渠道倍率 × 模式倍率 × 钱包倍率 */
export interface RelayRates {
  /** 钱包倍率（百分比）：100 = 原价，0 = 免费 */
  walletRatePercent: number
  /** 渠道倍率（千分比）：1000 = ×1.0，0 = 免费 */
  channelRatePermille: number
  /**
   * 18 D4：模式整体倍率（千分比）：1000 = ×1.0，0 = 免费；省略 = 1000。
   * `dsh` 作用域恒为 1000（不写快照），所以老调用方的结果逐位不变。
   */
  modeRatePermille?: number
}

/** 每次请求固定费用的换算基数：微积分 → 「微积分 × 百万 token」（与 token 项同单位） */
const PER_REQUEST_SCALE = 1_000_000n
/** 公式分母：1e6（百万 token）× 1000（千分比）× 100（百分比） */
const DENOMINATOR = PER_REQUEST_SCALE * 1000n * 100n
/** 模式倍率再乘一项时的分母（18 §3.3：多一个 1000） */
const MODE_DENOMINATOR = DENOMINATOR * 1000n

/**
 * 归一化成非负整数：NaN / Infinity / 负数 → 0，正小数向下取整。
 *
 * usage 可能来自上游回包或本地估算，价格也可能被脏数据污染；余额是真金白银，
 * 所以宁可把无法解释的值算成 0，也不能让 NaN 或负数流进计费公式（余额会被算坏）。
 */
function toNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * 12 §6.2 + 18 §3.3：算一次请求的费用（微积分，向上取整）。
 *
 * ```
 * raw  = input×p_in + cacheRead×(p_cacheRead ?? p_in) + cacheWrite×(p_cacheWrite ?? p_in) + output×p_out
 * base = raw + p_perRequest × 1_000_000
 * cost = ceil(base × channelRatePermille × modeRatePermille × walletRatePercent
 *             / (1_000_000 × 1000 × 1000 × 100))
 * ```
 *
 * 全程 BigInt：百万级 token × 百万级价格 × 最高 ×100 倍率会远超 2^53，
 * 浮点中间结果会悄悄丢精度（余额就错了）。任一倍率为 0 → 0（照常记 token）；脏数据按 0 处理。
 * `modeRatePermille` 省略或 = 1000 时走原来的（少乘一次）路径，保证 dsh 的结果与改动前逐位相同。
 */
export function computeCostMicro(price: RelayPrice, tokens: BillableTokens, rates: RelayRates): number {
  const pIn = toNonNegativeInt(price.inputMicro)
  const pOut = toNonNegativeInt(price.outputMicro)
  // 缓存价缺省 = 输入价（12 §6.2 的 `p_cacheRead ?? p_in`）
  const pCacheRead = toNonNegativeInt(price.cacheReadMicro ?? pIn)
  const pCacheWrite = toNonNegativeInt(price.cacheWriteMicro ?? pIn)
  const raw =
    BigInt(toNonNegativeInt(tokens.input)) * BigInt(pIn) +
    BigInt(toNonNegativeInt(tokens.cacheRead)) * BigInt(pCacheRead) +
    BigInt(toNonNegativeInt(tokens.cacheWrite)) * BigInt(pCacheWrite) +
    BigInt(toNonNegativeInt(tokens.output)) * BigInt(pOut)
  const base = raw + BigInt(toNonNegativeInt(price.perRequestMicro)) * PER_REQUEST_SCALE
  const channel = BigInt(toNonNegativeInt(rates.channelRatePermille))
  const wallet = BigInt(toNonNegativeInt(rates.walletRatePercent))
  const mode = rates.modeRatePermille === undefined ? 1000 : toNonNegativeInt(rates.modeRatePermille)
  if (mode === 1000) {
    const numerator = base * channel * wallet
    return Number((numerator + DENOMINATOR - 1n) / DENOMINATOR)
  }
  const numerator = base * channel * BigInt(mode) * wallet
  return Number((numerator + MODE_DENOMINATOR - 1n) / MODE_DENOMINATOR)
}
