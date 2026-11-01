import { formatPrice } from './points'

/**
 * 渠道倍率工具（12 §6.2、§10）。
 *
 * 界面上「倍率」是小数（`1`、`1.5`、`0.333`），接口里是千分比整数（`1000`、`1500`、`333`）——
 * 换算只在这一个文件里做，界面与假数据都走这里的函数，免得两边各写一套四舍五入。
 * 「实际价格」= 模型价格（微积分 / 百万 token）× 倍率，只用于显示（真正的计费在后端 `billing.ts`）。
 */

/** 界面允许的最大倍率（×100，与契约 `RatePermilleSchema` 的 100_000 一致） */
export const MAX_RATE = 100
const MAX_PERMILLE = MAX_RATE * 1000

/** 千分比 → 界面文本：`1000` → `1`、`1500` → `1.5`、`333` → `0.333`；非法给空串（表单里显示为空） */
export function permilleToRateInput(permille: number | null | undefined): string {
  if (permille === null || permille === undefined) return ''
  if (!Number.isFinite(permille) || permille < 0 || permille > MAX_PERMILLE) return ''
  const whole = Math.trunc(permille / 1000)
  const fraction = Math.round(permille % 1000)
  if (fraction === 0) return String(whole)
  return `${whole}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`
}

/**
 * 界面「倍率」文本 → 千分比整数。
 * 规则（12 §10）：最多 3 位小数、0–100；空串、负数、超过 100、多余小数位、非数字一律 `null`。
 */
export function rateToPermille(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  const text = typeof input === 'number' ? String(input) : input.trim()
  if (!/^\d+(\.\d{1,3})?$/.test(text)) return null

  const [whole = '0', fraction = ''] = text.split('.')
  const value = Number(text)
  if (!Number.isFinite(value) || value > MAX_RATE) return null

  const permille = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  return permille <= MAX_PERMILLE ? permille : null
}

/** 显示用：`1000` → `×1`、`1500` → `×1.5`、`333` → `×0.333`；null / 非法 → `—` */
export function formatRate(permille: number | null | undefined): string {
  const text = permilleToRateInput(permille)
  return text ? `×${text}` : '—'
}

/** 价格 × 倍率（微积分，四舍五入到整数）；倍率为 null = 不加价 */
export function applyRate(micro: number, permille: number | null | undefined): number {
  if (permille === null || permille === undefined || !Number.isFinite(permille)) return micro
  return Math.round((micro * permille) / 1000)
}

/**
 * 「可用模型」表里的价格显示（12 §10 `/usage`）：
 * 倍率区间相同 → 直接给乘好的价；不同 → 区间 `0.8–1.2`；没有可用渠道（null）→ 原始价格。
 */
export function formatRatedPrice(
  micro: number,
  rate: { minPermille: number; maxPermille: number } | null | undefined,
): string {
  if (!rate) return formatPrice(micro)
  const low = applyRate(micro, rate.minPermille)
  const high = applyRate(micro, rate.maxPermille)
  return low === high ? formatPrice(low) : `${formatPrice(low)}–${formatPrice(high)}`
}

/** 这个价格在倍率区间下是不是一个区间（决定要不要给「0.8–1.2 是区间」的说明） */
export function isRatedRange(rate: { minPermille: number; maxPermille: number } | null | undefined): boolean {
  if (!rate) return false
  return rate.minPermille !== rate.maxPermille
}
