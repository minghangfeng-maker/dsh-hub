/**
 * 语音识别可用性（0.4.1）：设置页那一行与「不可用」弹窗用的文案/判定。
 *
 * 这些是纯函数，不需要真机：真机上 availability 的取值来自本地插件，
 * 状态机测试见 test/voice-input.test.ts。
 */

import { describe, expect, it } from 'vitest'
import {
  createSpeechBridge,
  isSpeechUsable,
  speechSupportLabel,
} from '@/lib/speech-native'

describe('语音识别可用性', () => {
  it('系统识别可用 → 「可用」', () => {
    const info = speechSupportLabel({ available: true, onDevice: true, reason: 'system' })
    expect(info.label).toBe('可用')
    expect(info.state).toBe('ok')
    expect(info.detail).toContain('系统')
  })

  it('系统服务缺失但离线识别可用 → 「仅离线」', () => {
    const info = speechSupportLabel({ available: false, onDevice: true, reason: 'on-device-only' })
    expect(info.label).toBe('仅离线')
    expect(info.state).toBe('offline')
    expect(info.detail).toContain('离线')
  })

  it('都没有 → 「不可用」并说明原因', () => {
    const info = speechSupportLabel({ available: false, onDevice: false, reason: 'none' })
    expect(info.label).toBe('不可用')
    expect(info.state).toBe('bad')
    expect(info.detail).toContain('没有可用的系统语音识别服务')
  })

  it('检查出错也给可读原因（不把技术错误丢给用户）', () => {
    const info = speechSupportLabel({ available: false, onDevice: false, reason: 'error' })
    expect(info.label).toBe('不可用')
    expect(info.detail).toContain('检查')
  })

  it('没有原生桥（浏览器）→ 仅 App 内可用', () => {
    const info = speechSupportLabel(null)
    expect(info.label).toBe('仅 App 内可用')
    expect(info.detail).toContain('App')
  })

  it('isSpeechUsable：系统服务或离线识别有一个就算可用', () => {
    expect(isSpeechUsable({ available: true, onDevice: false, reason: 'system' })).toBe(true)
    expect(isSpeechUsable({ available: false, onDevice: true, reason: 'on-device-only' })).toBe(true)
    expect(isSpeechUsable({ available: false, onDevice: false, reason: 'none' })).toBe(false)
    expect(isSpeechUsable(null)).toBe(false)
  })

  it('Web 上 createSpeechBridge() 返回 null（绝不盲调未注册的插件）', () => {
    expect(createSpeechBridge()).toBeNull()
  })
})
