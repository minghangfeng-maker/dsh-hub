/**
 * 网页版触感（WP54 / W3）：有 `navigator.vibrate` 就按 10ms / 20ms 调，没有就静默。
 *
 * 覆盖三条真机事实：
 *  - Android Chrome 有 vibrate；
 *  - iOS Safari **没有** vibrate（只能静默，不能抛错、不能提示）；
 *  - 有的环境 vibrate 会抛（被策略禁用）：也要静默。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { HAPTIC_STRONG_MS, HAPTIC_TAP_MS, webHaptic } from '@/lib/haptic-web'

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function installNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}

afterEach(() => {
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
})

describe('webHaptic', () => {
  it('常量与 APK 的 Light / Medium 对齐（10ms / 20ms）', () => {
    expect(HAPTIC_TAP_MS).toBe(10)
    expect(HAPTIC_STRONG_MS).toBe(20)
  })

  it('有 navigator.vibrate → 按毫秒调用', () => {
    const calls: number[] = []
    installNavigator({
      vibrate: (ms: number) => {
        calls.push(ms)
        return true
      },
    })
    webHaptic(HAPTIC_TAP_MS)
    webHaptic(HAPTIC_STRONG_MS)
    expect(calls).toEqual([10, 20])
  })

  it('iOS Safari（没有 vibrate）→ 静默，不抛错', () => {
    installNavigator({})
    expect(() => webHaptic(10)).not.toThrow()
  })

  it('没有 navigator（node/worker）→ 静默', () => {
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true })
    expect(() => webHaptic(10)).not.toThrow()
  })

  it('vibrate 抛错（被权限策略禁用）→ 吞掉', () => {
    installNavigator({
      vibrate: () => {
        throw new Error('blocked by permissions policy')
      },
    })
    expect(() => webHaptic(20)).not.toThrow()
  })
})
