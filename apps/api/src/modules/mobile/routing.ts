import type { MobileDesktopStatus } from '@dsh-hub/shared'
import type { RelayConnection } from './types.js'

/** 桌面 relay 的 hostStatus → 手机 DTO 的状态枚举（R8：不能把 'running' 冒充云状态）。 */
export function mapDesktopStatus(hostStatus: RelayConnection['hostStatus']): MobileDesktopStatus {
  if (hostStatus === 'running') return 'host-running'
  if (hostStatus === 'stopped') return 'host-stopped'
  return 'unknown'
}

export interface RelayRouteTarget {
  userId: number
  nodeId: string
  relay: RelayConnection
  channelId: string
}

/**
 * 中继帧能不能落到这条通道（R1）：
 * - 必须是同一条 relay 实例（防旧代际仍可发帧）；
 * - 通道属于该 relay 的 user 与该 device；
 * - 该 channelId 确实挂在这条 relay 的登记表里。
 */
export function canRelayRoute(target: RelayRouteTarget, relay: RelayConnection): boolean {
  return (
    target.relay === relay &&
    target.userId === relay.userId &&
    target.nodeId === relay.deviceId &&
    relay.channels.has(target.channelId)
  )
}
