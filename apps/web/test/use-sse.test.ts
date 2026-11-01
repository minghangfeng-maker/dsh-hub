import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSse, type SseSource } from '@/composables/useSse'

/** 假的 EventSource：手动触发 open/error 与事件，用来验证重连与卸载关闭。 */
class FakeSource implements SseSource {
  readonly url: string
  closed = false
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
  }

  fireOpen(): void {
    this.onopen?.(new Event('open'))
  }

  fireError(): void {
    this.onerror?.(new Event('error'))
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent)
    }
  }
}

function setup(options: Parameters<typeof useSse>[1] = {}) {
  const sources: FakeSource[] = []
  const scope = effectScope()
  const result = scope.run(() =>
    useSse('/api/me/instance/events', {
      factory: (url) => {
        const source = new FakeSource(url)
        sources.push(source)
        return source
      },
      baseDelayMs: 1000,
      maxDelayMs: 4000,
      ...options,
    }),
  )

  if (!result) throw new Error('useSse 没有返回结果')
  return { sources, scope, ...result }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSse（04 §3.1 实例事件流）', () => {
  it('立即连接；open 后状态是 open', () => {
    const { sources, status } = setup()

    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('/api/me/instance/events')
    expect(status.value).toBe('connecting')

    sources[0]?.fireOpen()
    expect(status.value).toBe('open')
  })

  it('按事件名分发并自动解析 JSON（`event: status` 的 data 是 JSON）', () => {
    const received: unknown[] = []
    const { sources } = setup({ events: { status: (data) => received.push(data) } })

    sources[0]?.emit('status', JSON.stringify({ instance: { status: 'running' }, phase: 'ready' }))
    sources[0]?.emit('status', 'not-json')

    expect(received[0]).toEqual({ instance: { status: 'running' }, phase: 'ready' })
    expect(received[1]).toBe('not-json')
  })

  it('断线后指数退避自动重连，成功后退避归零', () => {
    const { sources, status, retries } = setup()

    sources[0]?.fireError()
    expect(status.value).toBe('reconnecting')
    expect(retries.value).toBe(1)
    expect(sources).toHaveLength(1)

    // 第 1 次退避 1s
    vi.advanceTimersByTime(1000)
    expect(sources).toHaveLength(2)

    // 第 2 次退避 2s
    sources[1]?.fireError()
    expect(retries.value).toBe(2)
    vi.advanceTimersByTime(1999)
    expect(sources).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(3)

    sources[2]?.fireOpen()
    expect(status.value).toBe('open')
    expect(retries.value).toBe(0)
  })

  it('退避有上限（maxDelayMs）', () => {
    const { sources, retries } = setup({ maxDelayMs: 4000 })

    sources[0]?.fireError()
    vi.advanceTimersByTime(1000)
    sources[1]?.fireError()
    vi.advanceTimersByTime(2000)
    sources[2]?.fireError()
    expect(retries.value).toBe(3)

    // 第 4 次本应 8s，被压到 4s
    vi.advanceTimersByTime(4000)
    expect(sources).toHaveLength(4)
  })

  it('组件卸载（作用域销毁）时关闭连接，不再重连', () => {
    const { sources, scope, status } = setup()

    sources[0]?.fireOpen()
    scope.stop()

    expect(sources[0]?.closed).toBe(true)
    expect(status.value).toBe('closed')

    vi.advanceTimersByTime(10_000)
    expect(sources).toHaveLength(1)
  })

  it('close() 之后不再自动重连', () => {
    const { sources, close, retries } = setup()

    close()
    sources[0]?.fireError()
    vi.advanceTimersByTime(10_000)

    expect(sources).toHaveLength(1)
    expect(retries.value).toBe(0)
  })

  it('浏览器不支持 EventSource 时给出 closed 状态与 onError 回调（不无限重试）', () => {
    const onError = vi.fn()
    const { status, sources } = setup({
      factory: () => {
        throw new Error('EventSource is not defined')
      },
      onError,
    })

    expect(sources).toHaveLength(0)
    expect(status.value).toBe('closed')
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('URL 为空时保持 idle，不建连接', () => {
    const { sources } = setup()
    expect(sources).toHaveLength(1)

    const empty = effectScope().run(() => useSse('', { factory: () => new FakeSource('') }))
    expect(empty?.status.value).toBe('idle')
  })
})
