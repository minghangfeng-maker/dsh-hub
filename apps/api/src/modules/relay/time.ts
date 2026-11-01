/**
 * 中转站的日期分桶（12 §6.5）：一律按 **Asia/Shanghai（UTC+8 固定偏移）** 自然日，
 * 不依赖服务器时区（生产容器里 TZ 可能是 UTC，用 `Date` 的本地方法会算错天）。
 */

export const SHANGHAI_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 是否是合法的 `YYYY-MM-DD`（含真实日历校验） */
export function isRelayDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

/** 某一时刻属于上海时间的哪一天（`YYYY-MM-DD`） */
export function shanghaiDay(at: string | Date): string {
  const ms = typeof at === 'string' ? Date.parse(at) : at.getTime()
  const shifted = Number.isFinite(ms) ? ms : 0
  return new Date(shifted + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/** 上海时间某天 `00:00:00` 对应的 UTC ISO 时刻（区间查询用左闭右开） */
export function shanghaiDayStartIso(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - SHANGHAI_OFFSET_MS).toISOString()
}

/** 日期加减（返回 `YYYY-MM-DD`） */
export function addRelayDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** 两个日期相差的天数（含首尾时为 1；`to` 早于 `from` 时为 0 或负数） */
export function relayDaySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1
}

/** 某天所在月的 1 号（「本月」分桶的起点） */
export function shanghaiMonthStart(day: string): string {
  return `${day.slice(0, 7)}-01`
}

/** 升序日期序列（统计接口 `daily` 每天都给一项，没用量给 0） */
export function relayDayRange(from: string, to: string): string[] {
  const out: string[] = []
  const span = relayDaySpan(from, to)
  for (let index = 0; index < span; index += 1) out.push(addRelayDays(from, index))
  return out
}
