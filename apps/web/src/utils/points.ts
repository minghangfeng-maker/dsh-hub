import { RELAY_MICRO_PER_POINT } from '@dsh-hub/shared'

/**
 * 积分 / 价格 / token 的显示与录入换算（12 §6.1 §10）。
 *
 * 接口里所有金额都是整数**微积分**（1 积分 = 1 元 = 1_000_000 微积分），价格是「微积分 / 百万 token」；
 * 界面一律按「积分」录入与显示（最多 6 位小数），换算只在本文件里做，避免各页面各写一套。
 */

/** 界面允许录入的最大小数位数（6 位小数 = 1 微积分） */
export const POINTS_MAX_DECIMALS = 6

const EM_DASH = '—'

function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 去掉小数末尾多余的 0（`12.30` → `12.3`，`12.00` → `12`）。 */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/**
 * 微积分 → 界面显示的「积分」文本（12 §10）：
 * - `0` 显示 `0`；
 * - `|x| ≥ 1` 积分：两位小数 + `toLocaleString('zh-CN')` 千分位（`12.35`、`1,234.50`）；
 * - `0 < |x| < 1` 积分：最多 4 位小数并去掉多余的 0（`0.5`、`0.0123`）；再小显示 `<0.0001`；
 * - 负数带 `-`；`null` / `NaN` 显示 `—`。
 */
export function formatPoints(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return EM_DASH
  if (!isUsableNumber(micro)) return EM_DASH
  if (micro === 0) return '0'

  const points = micro / RELAY_MICRO_PER_POINT
  const sign = points < 0 ? '-' : ''
  const abs = Math.abs(points)

  if (abs >= 1) return points.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  let text = trimZeros(abs.toFixed(4))
  // 0.999999 这类值四舍五入到 4 位会变成「1」，退到 6 位再显示，免得看起来是 1 积分
  if (text === '1') text = trimZeros(abs.toFixed(POINTS_MAX_DECIMALS))
  if (text === '0') return `${sign}<0.0001`

  return `${sign}${text}`
}

/**
 * 界面输入的一行「积分」文本 → 微积分（整数，四舍五入到 1 微积分）。
 * 非法输入（空、非数字、`Infinity`）返回 `null`，由调用方决定怎么提示。
 */
export function pointsToMicro(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null

  let value: number
  if (typeof input === 'number') {
    value = input
  } else {
    const text = input.trim().replace(/[,\s]/g, '')
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null
    value = Number(text)
  }

  if (!Number.isFinite(value)) return null
  return Math.round(value * RELAY_MICRO_PER_POINT)
}

/** 微积分 → 积分（数值，最多 6 位小数）；非法输入返回 `null`。 */
export function microToPoints(micro: number | null | undefined): number | null {
  if (micro === null || micro === undefined) return null
  if (!isUsableNumber(micro)) return null
  return micro / RELAY_MICRO_PER_POINT
}

/** 微积分 → 表单里可编辑的「积分」文本（不带千分位，去掉多余的 0，最多 6 位小数）。 */
export function microToPointsInput(micro: number | null | undefined): string {
  const points = microToPoints(micro)
  if (points === null) return ''
  if (points === 0) return '0'
  return trimZeros(points.toFixed(POINTS_MAX_DECIMALS))
}

/**
 * 价格（微积分 / 百万 token）→ 「积分 / 百万 token」的数值文本，去掉多余 0：
 * `2_000_000` → `2`、`500_000` → `0.5`、`12_800_000` → `12.8`。
 */
export function formatPrice(microPerM: number | null | undefined): string {
  if (microPerM === null || microPerM === undefined) return EM_DASH
  if (!isUsableNumber(microPerM)) return EM_DASH
  if (microPerM === 0) return '0'

  const points = microPerM / RELAY_MICRO_PER_POINT
  return trimZeros(points.toFixed(POINTS_MAX_DECIMALS))
}

/**
 * token 数 → 中文单位（`12345` → `1.2万`、`340_000_000` → `3.4亿`），
 * 精确值请用 `formatCount`（悬停提示用）。
 */
export function formatTokensZh(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return EM_DASH
  if (!isUsableNumber(tokens)) return EM_DASH

  const abs = Math.abs(tokens)
  const sign = tokens < 0 ? '-' : ''

  if (abs < 10_000) return tokens.toLocaleString('zh-CN')
  if (abs < 100_000_000) return `${sign}${trimZeros((abs / 10_000).toFixed(1))}万`
  return `${sign}${trimZeros((abs / 100_000_000).toFixed(1))}亿`
}

/** 「输入 / 输出」这类成对 token 的简短展示：`1.2万 / 3.4亿`。 */
export function formatTokenPair(input: number | null | undefined, output: number | null | undefined): string {
  return `${formatTokensZh(input)} / ${formatTokensZh(output)}`
}
