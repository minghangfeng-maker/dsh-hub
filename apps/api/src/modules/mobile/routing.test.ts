import { describe, expect, it } from 'vitest'
import { canRelayRoute, mapDesktopStatus } from './routing.js'
import type { RelayConnection } from './types.js'

function relay(overrides: Partial<RelayConnection> = {}): RelayConnection {
  return {
    deviceId: 'dv_0123456789abcdef0123456789abcdef',
    generation: 'g1',
    closed: false,
    userId: 1,
    clientVersion: '0.9.3',
    hostStatus: 'running',
    capabilities: {
      sessions: true, history: true, send: true, stop: true, stream: true, questions: true, approvals: true, create: true,
    },
    channels: new Set(['ch1']),
    // WP48：中继层能放行的 v2 特性；null = 旧 connector（只放行 v1 帧）
    relayFeatures: null,
    send: () => undefined,
    close: () => undefined,
    ...overrides,
  }
}

describe('R8 桌面状态映射', () => {
  it('running→host-running、stopped→host-stopped、starting→unknown', () => {
    expect(mapDesktopStatus('running')).toBe('host-running')
    expect(mapDesktopStatus('stopped')).toBe('host-stopped')
    expect(mapDesktopStatus('starting')).toBe('unknown')
  })
})

describe('R1 中继帧归属', () => {
  it('同实例同用户同设备且通道在该 relay 登记表里才可路由', () => {
    const r = relay()
    expect(canRelayRoute({ userId: 1, nodeId: r.deviceId, relay: r, channelId: 'ch1' }, r)).toBe(true)
  })

  it('跨用户 / 跨设备 / 旧 relay 实例 / 未登记通道一律拒绝', () => {
    const r = relay()
    const old = relay({ generation: 'g0' })
    expect(canRelayRoute({ userId: 2, nodeId: r.deviceId, relay: r, channelId: 'ch1' }, r)).toBe(false)
    expect(canRelayRoute({ userId: 1, nodeId: 'dv_other', relay: r, channelId: 'ch1' }, r)).toBe(false)
    expect(canRelayRoute({ userId: 1, nodeId: r.deviceId, relay: old, channelId: 'ch1' }, r)).toBe(false)
    expect(canRelayRoute({ userId: 1, nodeId: r.deviceId, relay: r, channelId: 'ch_unknown' }, r)).toBe(false)
  })
})
