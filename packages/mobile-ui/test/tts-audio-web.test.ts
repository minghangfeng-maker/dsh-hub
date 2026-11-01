/**
 * 朗读音频出口的解锁（WP54 / W3）：Chrome 与 iOS Safari 都要在**用户手势**里解锁。
 *
 * 用一个假的 `AudioContext` 记下三件事：
 *  1. 什么时候被创建（必须在点「朗读」的同一个同步任务里，不能等网络回来）；
 *  2. 有没有 `resume()`（iOS Safari 不 resume 就一直 suspended）；
 *  3. 有没有真的 start 过一段 buffer（iOS Safari 只认「播过声」的 context）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createTtsSink, createTtsStreamSink, unlockAudioContext } from '@/lib/tts-audio'

interface FakeBuffer {
  duration: number
  length: number
  sampleRate: number
}

interface FakeSource {
  buffer: FakeBuffer | null
  started: number[]
  stopped: number
  onended: (() => void) | null
  connect: (target: unknown) => void
  start: (when?: number) => void
  stop: () => void
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  sampleRate = 48_000
  state = 'suspended'
  currentTime = 0
  destination = { name: 'dest' }
  resumes = 0
  startedBuffers: FakeSource[] = []
  sources: FakeSource[] = []
  closed = 0

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  async resume(): Promise<void> {
    this.resumes += 1
    this.state = 'running'
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return { duration: length / sampleRate, length, sampleRate }
  }

  createBufferSource(): FakeSource {
    const context = this
    const source: FakeSource = {
      buffer: null,
      started: [],
      stopped: 0,
      onended: null,
      connect: () => {},
      start(when?: number) {
        source.started.push(when ?? 0)
        context.startedBuffers.push(source)
      },
      stop() {
        source.stopped += 1
      },
    }
    this.sources.push(source)
    return source
  }

  async decodeAudioData(): Promise<FakeBuffer> {
    return { duration: 0.5, length: 12_000, sampleRate: 24_000 }
  }

  async close(): Promise<void> {
    this.closed += 1
  }
}

const savedAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')

function installFakeAudioContext(): void {
  FakeAudioContext.instances = []
  Object.defineProperty(globalThis, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  if (savedAudioContext) Object.defineProperty(globalThis, 'AudioContext', savedAudioContext)
  else delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
})

describe('unlockAudioContext', () => {
  it('网页版的静音解锁：resume + 真的 start 一段 1 帧静音 buffer（iOS Safari 的要求）', () => {
    installFakeAudioContext()
    const context = new FakeAudioContext()
    unlockAudioContext(context as never, { silent: true })
    expect(context.resumes).toBe(1)
    expect(context.startedBuffers).toHaveLength(1)
    expect(context.startedBuffers[0]!.started).toEqual([0])
    expect(context.state).toBe('running')
  })

  it('APK（默认 IS_WEB_BUILD=false）：只 resume，不额外插静音节点', () => {
    installFakeAudioContext()
    const context = new FakeAudioContext()
    unlockAudioContext(context as never)
    expect(context.resumes).toBe(1)
    expect(context.startedBuffers).toHaveLength(0)
  })

  it('running 的 context 不重复 resume（幂等，不抛错）', () => {
    installFakeAudioContext()
    const context = new FakeAudioContext()
    context.state = 'running'
    unlockAudioContext(context as never, { silent: true })
    unlockAudioContext(context as never, { silent: true })
    expect(context.resumes).toBe(0)
    expect(context.startedBuffers).toHaveLength(2)
  })

  it('没有 createBuffer 的老 WebView：只 resume，不抛错', () => {
    installFakeAudioContext()
    const context = new FakeAudioContext() as FakeAudioContext & { createBuffer?: unknown }
    delete context.createBuffer
    expect(() => unlockAudioContext(context as never, { silent: true })).not.toThrow()
    expect(context.resumes).toBe(1)
  })
})

describe('音频出口在用户手势里创建并解锁', () => {
  it('整段播放器：createTtsSink() 本身不建 context，unlock() 才建（播放器在手势里调它）', () => {
    installFakeAudioContext()
    const sink = createTtsSink()
    expect(FakeAudioContext.instances).toHaveLength(0)
    sink.unlock?.()
    expect(FakeAudioContext.instances).toHaveLength(1)
    const context = FakeAudioContext.instances[0]!
    expect(context.resumes).toBe(1)
    // 再点一次「朗读」：复用同一个 context，不会无限建
    sink.unlock?.()
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('流式播放器：createTtsStreamSink() 当场建 context 并 resume（PCM 排程前就 running）', () => {
    installFakeAudioContext()
    const sink = createTtsStreamSink()
    expect(FakeAudioContext.instances).toHaveLength(1)
    const context = FakeAudioContext.instances[0]!
    expect(context.state).toBe('running')
    expect(context.resumes).toBe(1)
    // schedule 排程 PCM：AudioBufferSource.start(when) 用的是音频时钟
    const duration = sink.schedule(new Float32Array(480), 24_000, context.currentTime)
    expect(duration).toBeCloseTo(0.02, 5)
    expect(context.startedBuffers).toHaveLength(1)
    expect(context.startedBuffers[0]!.started).toEqual([0])
    sink.dispose()
    expect(context.closed).toBe(1)
  })

  it('没有 Web Audio 时 createTtsStreamSink 直接报错（store 会回退整段播放器）', () => {
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
    delete (globalThis as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
    expect(() => createTtsStreamSink()).toThrow()
  })
})
