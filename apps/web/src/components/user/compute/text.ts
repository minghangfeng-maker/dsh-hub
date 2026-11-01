import type { ComputeLease, ComputeLeaseEndReason } from '@dsh-hub/shared'

/**
 * 算力租赁的展示文案（13 §6 §7）：时间、内存、结束原因。
 *
 * 为什么单独一个文件：工作台的租约面板与「积分与用量」的租约记录表要用同一套中文映射，
 * 两处各写一份迟早会漂（结束原因是契约枚举，后端加一项这里要跟着报错才看得见）。
 */

const END_REASON_TEXT: Record<ComputeLeaseEndReason, string> = {
  user: '用户停止',
  admin: '管理员停止',
  idle: '空闲自动停止',
  insufficient: '余额不足停止',
  crash: '异常退出',
  'plan-change': '切换规格',
  'billing-off': '计费关闭',
  system: '系统',
}

/** 结束原因 → 中文；`null`（还没结束）=「进行中」。 */
export function leaseEndReasonText(reason: ComputeLeaseEndReason | null | undefined): string {
  if (!reason) return '进行中'
  return END_REASON_TEXT[reason] ?? reason
}

/** `HH:mm`（本地时区，界面上的「下次扣费 14:30」）。 */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 内存 MB → `4 GB` / `1.5 GB`（规格卡片上的「N 核 / N GB」）。 */
export function formatMemoryGb(memoryMb: number): string {
  const gb = memoryMb / 1024
  const text = Number.isInteger(gb) ? String(gb) : gb.toFixed(1).replace(/\.0$/, '')
  return `${text} GB`
}

/** 规格的一句描述：`2 核 / 4 GB`。 */
export function planSpecText(plan: { cpus: number; memoryMb: number }): string {
  return `${plan.cpus} 核 / ${formatMemoryGb(plan.memoryMb)}`
}

/** 租约状态（工作台 / 管理端标签用）：免费、宽限中、计费中。 */
export type LeaseState = 'free' | 'grace' | 'billed'

export function leaseStateOf(lease: Pick<ComputeLease, 'billed' | 'graceUntil'>): LeaseState {
  if (!lease.billed) return 'free'
  if (lease.graceUntil) return 'grace'
  return 'billed'
}

export const LEASE_STATE_TEXT: Record<LeaseState, string> = {
  free: '免费',
  grace: '宽限中',
  billed: '计费中',
}
