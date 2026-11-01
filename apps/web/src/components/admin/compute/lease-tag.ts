import type { ComputeLease } from '@dsh-hub/shared'

import type { AdminTone } from '@/components/admin/tone'
import { LEASE_STATE_TEXT, leaseStateOf } from '@/components/user/compute/text'

/**
 * 管理端实例卡 / 表格上的租约标签（13 §7）：
 * 计费中 / 宽限中 / 免费。`lease` 缺省或 null（计费关闭、实例没在跑）时返回 null，界面不显示。
 */
export interface LeaseTag {
  text: string
  tone: AdminTone
}

const STATE_TONE = {
  billed: 'success',
  grace: 'danger',
  free: 'neutral',
} as const

export function leaseTagOf(lease: ComputeLease | null | undefined): LeaseTag | null {
  if (!lease) return null
  const state = leaseStateOf(lease)
  return { text: LEASE_STATE_TEXT[state], tone: STATE_TONE[state] }
}
