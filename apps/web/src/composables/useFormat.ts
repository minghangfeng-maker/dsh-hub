import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import relativeTime from 'dayjs/plugin/relativeTime'

// 07 §1：相对时间用 dayjs，中文
dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 字节数 → `1.2 GB`（默认 1 位小数，磁盘/内存/导出大小统一走它）。 */
export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—'
  if (bytes <= 0) return '0 B'

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const unit = BYTE_UNITS[exponent] ?? 'B'
  // 整数就不显示 `.0`
  const text = exponent === 0 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(decimals)

  return `${text} ${unit}`
}

/** 0.62 → `62%`；入参是 0–1 的比例。 */
export function formatPercent(ratio: number | null | undefined, decimals = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—'
  return `${(ratio * 100).toFixed(decimals)}%`
}

/** 毫秒/秒 → `2 小时 13 分`、`13 分 5 秒`、`3 天 4 小时`（超出两级就够，读着不累）。 */
export function formatDuration(input: number, unit: 'ms' | 's' = 'ms'): string {
  const totalSeconds = Math.max(0, Math.floor(unit === 'ms' ? input / 1000 : input))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${seconds} 秒`
}

/** 秒数 → `mm:ss`（锁定倒计时用）。 */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 绝对时间：`2026-10-12 21:30`。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dayjs(iso).format('YYYY-MM-DD HH:mm')
}

/** 相对时间：`3 分钟前`（07 §1）。 */
export function fromNow(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dayjs(iso).fromNow()
}

/** 千分位计数（概览统计卡）。 */
export function formatCount(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
