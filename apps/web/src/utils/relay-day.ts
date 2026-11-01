/**
 * 日期区间的纯计算（统计按 Asia/Shanghai 自然日，12 §6.5）。
 *
 * 抽出来是为了让「模型消耗」与「使用记录」两处日期选择器用同一套换算，
 * 也方便单测（组件里只做绑定）。NDatePicker 给的是**本地**时间戳，所以 `tsToDay` 走本地日历，
 * 避免时区把日期挪一天。
 */

export const SHANGHAI_OFFSET_MS = 8 * 3600_000
export const DAY_MS = 86_400_000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 今天（Asia/Shanghai）的 `YYYY-MM-DD`。 */
export function shanghaiToday(): string {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/** 今天往前推 `days` 天（Asia/Shanghai）的 `YYYY-MM-DD`。 */
export function dayOffset(days: number): string {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS - days * DAY_MS).toISOString().slice(0, 10)
}

/** 本地时间戳 → `YYYY-MM-DD`（按本地日历）。 */
export function tsToDay(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `YYYY-MM-DD` → 本地零点的时间戳。 */
export function dayToTs(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1).getTime()
}

/** 闭区间 [from, to] 的天数（含首尾，与后端 `relayDaySpan` 同口径）。 */
export function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

/** 把区间收进「不晚于今天、跨度 ≤ maxDays」，返回合法区间（含首尾）。 */
export function clampDayRange(from: string, to: string, maxDays: number): { from: string; to: string } {
  const today = shanghaiToday()
  let start = from || dayOffset(maxDays - 1)
  let end = to || today
  if (start > end) [start, end] = [end, start]
  if (end > today) end = today
  if (start > end) start = end
  if (daySpan(start, end) > maxDays) {
    start = new Date(Date.parse(`${end}T00:00:00Z`) - (maxDays - 1) * DAY_MS).toISOString().slice(0, 10)
  }
  return { from: start, to: end }
}

/**
 * 日期选择器里该禁用的日子：今天之后；以及会让跨度超过 `maxDays` 的日子
 * （19 §2.2「超长时 picker 里禁用，不弹错误」）。
 * `anchor` 是区间另一端（daterange 里就是当前值的那一端）。
 */
export function isDayDisabled(day: string, anchor: string, maxDays: number): boolean {
  if (day > shanghaiToday()) return true
  const diff = Math.abs(
    Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / DAY_MS),
  )
  return diff + 1 > maxDays
}
