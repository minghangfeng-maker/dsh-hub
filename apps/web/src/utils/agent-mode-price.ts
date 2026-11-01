import { formatPrice } from './points'
import { formatRate } from './rate'

/**
 * 对话模式模型的「实际单价」（18 §7）：
 * 模型价格 × 渠道倍率 × 模式整体倍率 × 钱包倍率。
 *
 * 与 `model-price.ts`（只乘渠道倍率）分开：这边的结果才是用户真正被扣的单价。
 * 渠道倍率有区间（同一模型挂在多条渠道上）时显示区间，格式与「可用模型」表一致。
 */
export interface AgentModePriceInput {
  /** 模型启用路由所在渠道的倍率范围；null = 没有可用路由 */
  channelRate: { minPermille: number; maxPermille: number } | null
  /** 模式整体倍率（千分比） */
  modeRatePermille: number
  /** 钱包倍率（百分数，100 = ×1） */
  walletRatePercent?: number
}

export interface AgentModePriceText {
  text: string
  title: string
}

/** 一次算完（只四舍五入一次，避免逐项取整的累积误差） */
function applyAll(
  micro: number,
  channelPermille: number,
  modePermille: number,
  walletPercent: number,
): number {
  return Math.round((micro * channelPermille * modePermille * walletPercent) / (1000 * 1000 * 100))
}

/** 单元格文本 + 悬停说明；`micro = null` = 缓存读价格缺省（同输入价） */
export function agentModePriceText(
  micro: number | null,
  input: AgentModePriceInput,
  unit = '积分 / 百万 token',
): AgentModePriceText {
  if (micro === null) return { text: '同输入', title: '缓存读与输入同价' }

  const walletPercent = input.walletRatePercent ?? 100
  const low = input.channelRate?.minPermille ?? 1000
  const high = input.channelRate?.maxPermille ?? 1000
  const lowPrice = applyAll(micro, low, input.modeRatePermille, walletPercent)
  const highPrice = applyAll(micro, high, input.modeRatePermille, walletPercent)
  const text =
    lowPrice === highPrice ? formatPrice(lowPrice) : `${formatPrice(lowPrice)}–${formatPrice(highPrice)}`

  const parts = [
    `模型价格 ${formatPrice(micro)}`,
    low === high ? `渠道 ${formatRate(low)}` : `渠道 ${formatRate(low)}–${formatRate(high)}`,
    `模式 ${formatRate(input.modeRatePermille)}`,
  ]
  if (walletPercent !== 100) parts.push(`钱包 ${walletPercent}%`)
  return {
    text,
    title: `${text} ${unit}（${parts.join(' × ')}）`,
  }
}
