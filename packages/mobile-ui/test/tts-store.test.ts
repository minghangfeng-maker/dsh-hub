/**
 * 0.4.3 朗读 store：能力可见性、音色/自动朗读偏好（按账号）、播放状态映射。
 *
 * 网关与音频出口都是假的（真 HTTP / 真 Web Audio 由 scripts/e2e-tts.mjs 覆盖），
 * localStorage 换成内存实现，这样「换账号偏好隔离」也能测。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => {
  interface Deferred {
    text: string
    voice?: string
    resolve: () => void
    reject: (error: unknown) => void
  }
  const state = {
    requests: [] as Deferred[],
    played: [] as string[],
    stopped: 0,
    pendingPlay: [] as Array<() => void>,
    toast: [] as string[],
    /** 假 Web Audio：node 环境本来没有，测试里按需打开。 */
    webAudio: false,
    /** 流式请求（0.4.6）：记录发出的段，音频永远不回来（保持 loading 便于断言）。 */
    streamRequests: [] as Array<{ text: string; voice?: string }>,
    streamStopped: 0,
  }
  // 网关的 synthesize 收一个对象（`{ text, voice }`），与 HubGateway 一致
  const synthesize = (input: {
    text: string
    voice?: string
  }): Promise<{ wav: Uint8Array; sampleRate: number; voice: string }> =>
    new Promise((resolve, reject) => {
      state.requests.push({
        text: input.text,
        voice: input.voice,
        resolve: () =>
          resolve({ wav: new Uint8Array(64), sampleRate: 24_000, voice: input.voice ?? 'seki' }),
        reject,
      })
    })
  const sink = {
    prepare: async () => {},
    play: (clip: { wav: Uint8Array }) =>
      new Promise<void>((resolve) => {
        state.played.push('play')
        state.pendingPlay.push(resolve)
      }),
    stop: () => {
      state.stopped += 1
      const pending = state.pendingPlay
      state.pendingPlay = []
      for (const resolve of pending) resolve()
    },
    dispose: () => {},
  }
  const synthesizeStream = (input: {
    text: string
    voice?: string
    signal?: AbortSignal
  }): Promise<{
    sampleRate: number
    voice: string
    cached: boolean
    chunks: AsyncIterable<Uint8Array>
  }> => {
    state.streamRequests.push({ text: input.text, voice: input.voice })
    return Promise.resolve({
      sampleRate: 24_000,
      voice: input.voice ?? 'seki',
      cached: false,
      chunks: (async function* () {
        await new Promise<void>(() => {})
      })(),
    })
  }
  const streamSink = {
    now: () => 0,
    schedule: () => 0.15,
    stopAll: () => {
      state.streamStopped += 1
    },
    dispose: () => {},
    resume: async () => {},
  }
  const toasts: string[] = []
  return { state, synthesize, synthesizeStream, sink, streamSink, toasts }
})

vi.mock('@/lib/instance', () => ({
  gateway: {
    synthesize: h.synthesize,
    synthesizeStream: h.synthesizeStream,
    mode: 'http',
    origin: 'https://hub.test',
  },
}))
vi.mock('@/lib/tts-audio', () => ({
  createTtsSink: () => h.sink,
  createTtsStreamSink: () => h.streamSink,
  hasWebAudio: () => h.state.webAudio,
}))
vi.mock('@/lib/diagnostics', () => ({
  recordDiag: () => {},
}))

import { useTtsStore } from '@/stores/tts'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import type { BootstrapTts } from '@dsh-hub/mobile-core'

const PREFS_KEY = 'dsh-hub:tts:v1'

function sekiCapability(overrides: Partial<BootstrapTts> = {}): BootstrapTts {
  return {
    enabled: true,
    voices: [{ id: 'seki', name: '星汐 seki', description: '温柔清晰的女声' }],
    defaultVoice: 'seki',
    maxChars: 200,
    ...overrides,
  }
}

/** 内存版 localStorage（测试环境是 node，没有真 localStorage）。 */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() {
        return map.size
      },
    },
  })
  return map
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let store: Map<string, string>

beforeEach(() => {
  store = installStorage()
  h.state.requests = []
  h.state.played = []
  h.state.stopped = 0
  h.state.pendingPlay = []
  h.state.webAudio = false
  h.state.streamRequests = []
  h.state.streamStopped = 0
  h.toasts = []
  setActivePinia(createPinia())
})

/** 登录态 + 下发朗读能力（auth store 的 voice 是 bootstrap 快照）。 */
function signIn(username = 'demo', tts: BootstrapTts | null = sekiCapability()): void {
  const auth = useAuthStore()
  auth.user = { id: 1, username, displayName: username }
  auth.voice = tts ? { asr: true, maxSeconds: 60, tts } : { asr: true, maxSeconds: 60 }
  useUiStore().toast = (text: string) => void h.toasts.push(text)
}

describe('能力可见性', () => {
  it('老 Hub（没有 voice.tts）：不可用 + 说明「还没有开启朗读」', () => {
    signIn('demo', null)
    const tts = useTtsStore()
    expect(tts.available).toBe(false)
    expect(tts.voices).toEqual([])
    expect(tts.unavailableHint).toBe('这个 Hub 还没有开启朗读')
    tts.playMessage('m1', '你好')
    expect(h.state.requests).toHaveLength(0)
    expect(h.toasts).toContain('朗读暂时不可用')
  })

  it('enabled=false：不可用 + 说明「朗读暂时不可用」', () => {
    signIn('demo', sekiCapability({ enabled: false }))
    const tts = useTtsStore()
    expect(tts.available).toBe(false)
    expect(tts.unavailableHint).toBe('朗读暂时不可用')
  })

  it('可用：音色只有「星汐 seki」，默认选它', () => {
    signIn()
    const tts = useTtsStore()
    expect(tts.available).toBe(true)
    expect(tts.voices.map((voice) => voice.name)).toEqual(['星汐 seki'])
    expect(tts.voiceId).toBe('seki')
    expect(tts.maxChars).toBe(200)
    expect(tts.unavailableHint).toBeNull()
  })
})

describe('偏好（按账号）', () => {
  it('音色与自动朗读默认值：默认音色 + 自动朗读关', () => {
    signIn()
    const tts = useTtsStore()
    expect(tts.autoRead).toBe(false)
    expect(tts.preferredVoice).toBeNull()
    expect(tts.voiceId).toBe('seki')
  })

  it('选音色 / 打开自动朗读：写进本地存储', async () => {
    signIn()
    const tts = useTtsStore()
    tts.setVoice('seki')
    tts.toggleAutoRead()
    await flush()
    expect(tts.autoRead).toBe(true)
    const raw = JSON.parse(store.get(PREFS_KEY) ?? '{}') as Record<string, { voice?: string; autoRead?: boolean }>
    const entry = Object.values(raw)[0]!
    expect(entry.voice).toBe('seki')
    expect(entry.autoRead).toBe(true)
  })

  it('换账号登录：偏好互相隔离', () => {
    signIn('demo')
    const tts = useTtsStore()
    tts.setAutoRead(true)
    expect(tts.autoRead).toBe(true)

    signIn('other')
    // 同一个 store 实例，accountKey 变了 → 读另一个账号的偏好
    expect(tts.autoRead).toBe(false)
    tts.setAutoRead(false)
    tts.setVoice('seki')

    signIn('demo')
    expect(tts.autoRead).toBe(true)
  })

  it('本地偏好里的音色已经不在下发列表：自动回落（不把无效 id 发出去）', () => {
    signIn('demo')
    // accountKey 是「Hub 地址#用户名」（见 core 的 accountKeyOf），偏好按它分开存
    const key = useAuthStore().accountKey!
    store.set(PREFS_KEY, JSON.stringify({ [key]: { voice: 'gone' } }))
    const tts = useTtsStore()
    expect(tts.preferredVoice).toBe('gone')
    expect(tts.voiceId).toBe('seki')
  })

  it('损坏的本地存储不影响使用（按空偏好处理）', () => {
    store.set(PREFS_KEY, '{oops')
    signIn()
    const tts = useTtsStore()
    expect(tts.autoRead).toBe(false)
    expect(tts.voiceId).toBe('seki')
  })
})

describe('流式 / 整段的选择（0.4.6）', () => {
  it('老 Hub（tts 里没有 stream）：继续走整段播放器', () => {
    h.state.webAudio = true
    signIn('demo', sekiCapability())
    const tts = useTtsStore()
    expect(tts.streamCapable).toBe(false)
    tts.playMessage('m1', '一句。')
    expect(h.state.streamRequests).toHaveLength(0)
    expect(h.state.requests).toHaveLength(1)
  })

  it('新 Hub（stream=true）+ Web Audio：走流式播放器', () => {
    h.state.webAudio = true
    signIn('demo', sekiCapability({ stream: true }))
    const tts = useTtsStore()
    expect(tts.streamCapable).toBe(true)
    tts.playMessage('m1', '第一句。第二句。')
    expect(h.state.requests).toHaveLength(0)
    expect(h.state.streamRequests).toHaveLength(1)
    expect(h.state.streamRequests[0]!.text).toBe('第一句。第二句。')
    expect(h.state.streamRequests[0]!.voice).toBe('seki')
    expect(tts.phase).toBe('loading')
  })

  it('新 Hub 但没有 Web Audio（老 WebView）：回退整段播放器', () => {
    h.state.webAudio = false
    signIn('demo', sekiCapability({ stream: true }))
    const tts = useTtsStore()
    expect(tts.streamCapable).toBe(false)
    tts.playMessage('m1', '一句。')
    expect(h.state.streamRequests).toHaveLength(0)
    expect(h.state.requests).toHaveLength(1)
  })

  it('流式播放器 + 试听：设置页试听也走流式，停止会停掉流', () => {
    h.state.webAudio = true
    signIn('demo', sekiCapability({ stream: true }))
    const tts = useTtsStore()
    tts.preview()
    expect(h.state.streamRequests[0]!.text).toBe('你好呀，我是星汐。')
    tts.stop('user')
    expect(h.state.streamStopped).toBeGreaterThan(0)
    expect(tts.phase).toBe('idle')
  })
})

describe('播放状态', () => {
  it('playMessage：loading → playing，按钮状态跟着变；试听用当前音色', async () => {
    signIn()
    const tts = useTtsStore()
    tts.playMessage('m1', '第一句。第二句。')
    expect(tts.busy).toBe(true)
    expect(tts.phase).toBe('loading')
    expect(tts.isReading('m1')).toBe(true)
    expect(tts.isReading('m2')).toBe(false)
    // 合成第一段（第一句是短句，切段时并成一段）
    expect(h.state.requests[0]!.text).toBe('第一句。第二句。')
    expect(h.state.requests[0]!.voice).toBe('seki')

    h.state.requests[0]!.resolve()
    await flush()
    expect(tts.phase).toBe('playing')
    expect(tts.segment).toBe(1)
    expect(tts.total).toBe(1)
  })

  it('再点一次同一条 → 停止（reason=user）', async () => {
    signIn()
    const tts = useTtsStore()
    tts.playMessage('m1', '一句。')
    h.state.requests[0]!.resolve()
    await flush()
    tts.toggleMessage('m1', '一句。')
    expect(h.state.stopped).toBe(1)
    expect(tts.phase).toBe('idle')
    expect(tts.busy).toBe(false)
  })

  it('试听：读固定的示例句，与消息的朗读互斥', async () => {
    signIn()
    const tts = useTtsStore()
    tts.preview()
    expect(h.state.requests[0]!.text).toBe('你好呀，我是星汐。')
    h.state.requests[0]!.resolve()
    await flush()
    tts.playMessage('m1', '另一条。')
    // 换一条会先停掉试听
    expect(h.state.stopped).toBe(1)
  })

  it('停止（切后台/离开页面）后状态回到 idle', async () => {
    signIn()
    const tts = useTtsStore()
    tts.playMessage('m1', '一句。')
    h.state.requests[0]!.resolve()
    await flush()
    tts.stop('background')
    expect(tts.phase).toBe('idle')
    expect(tts.isReading('m1')).toBe(false)
  })
})
