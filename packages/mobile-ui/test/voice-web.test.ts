/**
 * 网页版（WP54 / W3）录音相关的差异：
 *  1. **非 https**：浏览器不给 `navigator.mediaDevices` → 明确抛 `insecure`，
 *     界面上是「需要 https」的弹窗（不是「这台设备不能录音」，也不显示「去设置」）；
 *  2. **跳过 Capacitor 的麦克风授权**：浏览器里没有原生桥，`ensureMicPermission(null)`
 *     返回 unknown，交给 `getUserMedia` 自己弹授权；
 *  3. 设置页那行能力文案：网页版不再写「请用 App」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLD_MS, VOICE_TEXT, VoiceInput, type VoiceNotice } from '@/lib/voice-input'
import {
  RecorderError,
  createMediaCapture,
  isRecordingSupported,
  isSecureAudioContext,
  type VoiceRecorderCreateOptions,
  type VoiceRecorderLike,
} from '@/lib/voice-recorder'
import { ensureMicPermission, speechSupportLabel } from '@/lib/speech-native'

const savedSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext')
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setSecureContext(value: boolean | undefined): void {
  if (value === undefined) {
    delete (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext
    return
  }
  Object.defineProperty(globalThis, 'isSecureContext', { value, configurable: true, writable: true })
}

afterEach(() => {
  vi.useRealTimers()
  if (savedSecure) Object.defineProperty(globalThis, 'isSecureContext', savedSecure)
  else delete (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
})

describe('网页版安全上下文', () => {
  it('没有 isSecureContext 字段的环境（老 WebView/测试）当作安全', () => {
    setSecureContext(undefined)
    expect(isSecureAudioContext()).toBe(true)
  })

  it('http 页面 → isSecureAudioContext=false、isRecordingSupported=false、采集直接抛 insecure', async () => {
    setSecureContext(false)
    expect(isSecureAudioContext()).toBe(false)
    expect(isRecordingSupported()).toBe(false)
    await expect(createMediaCapture(() => {})).rejects.toMatchObject({
      name: 'RecorderError',
      code: 'insecure',
    })
  })

  it('https 页面 → 正常去取 getUserMedia（这里没设备，报的是设备类错误而不是 insecure）', async () => {
    setSecureContext(true)
    await expect(createMediaCapture(() => {})).rejects.not.toMatchObject({ code: 'insecure' })
  })
})

class InsecureRecorder implements VoiceRecorderLike {
  readonly options: VoiceRecorderCreateOptions
  active = false
  constructor(options: VoiceRecorderCreateOptions) {
    this.options = options
  }
  async start(): Promise<void> {
    throw new RecorderError('insecure', '浏览器只在 https（或本机地址）下允许录音')
  }
  async stop() {
    return { wav: new Uint8Array(0), durationMs: 0, sampleRate: 16_000, samples: 0 }
  }
  cancel(): void {}
}

describe('非 https 时的界面反馈', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('弹「需要 https」的弹窗，不带「去设置」按钮', async () => {
    const notices: VoiceNotice[] = []
    const input = new VoiceInput({
      bridge: null,
      checkAvailability: async () => null,
      engine: () => ({ preference: 'auto', serverEnabled: true }),
      transcribe: async () => ({ text: '' }),
      createRecorder: (options) => new InsecureRecorder(options),
      onNotice: (notice) => notices.push(notice),
    })
    await input.pointerDown(10, 10)
    await vi.advanceTimersByTimeAsync(HOLD_MS + 10)
    const dialog = notices.find((notice) => notice.text === VOICE_TEXT.insecure)
    expect(dialog).toBeDefined()
    expect(dialog!.dialog).toBe(true)
    expect(dialog!.settings).not.toBe(true)
    expect(dialog!.text).toContain('https')
    input.destroy()
  })
})

describe('麦克风权限：网页里不调 Capacitor 插件', () => {
  it('没有原生桥 → unknown（交给 getUserMedia 自己弹授权）', async () => {
    await expect(ensureMicPermission(null)).resolves.toBe('unknown')
  })
})

describe('设置页的语音识别文案', () => {
  it('网页版：不再是「仅 App 内可用」，说明录音上传 Hub', () => {
    const info = speechSupportLabel(null, { web: true })
    expect(info.label).toBe('网页版录音')
    expect(info.state).toBe('ok')
    expect(info.detail).toContain('Hub')
  })

  it('APK 构建（默认）保持不变', () => {
    expect(speechSupportLabel(null).label).toBe('仅 App 内可用')
  })
})
