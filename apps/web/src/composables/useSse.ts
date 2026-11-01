import { onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

/** useSse 依赖的最小 EventSource 形状（便于测试注入假实现，jsdom 没有 EventSource）。 */
export interface SseSource {
  close(): void
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

export type SseSourceFactory = (url: string) => SseSource

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface UseSseOptions {
  /** 事件名 → 回调；`message` 是默认事件名（服务端没写 event 时） */
  events?: Record<string, (data: unknown, event: MessageEvent) => void>
  onOpen?: (event: Event) => void
  /** 连接或解析出错时回调（重连逻辑仍会继续） */
  onError?: (event: Event) => void
  /** 是否立即连接，默认 true */
  immediate?: boolean
  /** 组件卸载时自动 close（默认 true，Vue 作用域内才生效） */
  autoClose?: boolean
  /** 注入 EventSource 实现（测试用） */
  factory?: SseSourceFactory
  /** 重连基础/最大间隔，默认 1s / 15s（指数退避） */
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface UseSseReturn {
  status: Ref<SseStatus>
  /** 已重连次数（成功连接后归零） */
  retries: Ref<number>
  open: () => void
  close: () => void
}

function defaultFactory(url: string): SseSource {
  return new EventSource(url, { withCredentials: true }) as unknown as SseSource
}

/**
 * SSE 订阅（04 §0 的 `event: <name>` + 20s `: ping`）。
 *
 * - 断线自动重连：指数退避 1s→2s→…→15s，成功后退避归零；
 * - 作用域销毁（组件卸载）时关闭连接；
 * - `EventSource` 由 factory 注入，测试里可直接驱动假实现。
 */
export function useSse(url: MaybeRefOrGetter<string>, options: UseSseOptions = {}): UseSseReturn {
  const { events = {}, onOpen, onError, immediate = true, autoClose = true } = options

  const status = ref<SseStatus>('idle')
  const retries = ref(0)

  let source: SseSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let manuallyClosed = false

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const close = (): void => {
    manuallyClosed = true
    clearTimer()
    source?.close()
    source = null
    status.value = 'closed'
  }

  const scheduleReconnect = (): void => {
    if (manuallyClosed) return

    const base = options.baseDelayMs ?? 1000
    const max = options.maxDelayMs ?? 15_000
    const delay = Math.min(max, base * 2 ** retries.value)
    retries.value += 1
    status.value = 'reconnecting'

    clearTimer()
    timer = setTimeout(() => {
      timer = null
      connect()
    }, delay)
  }

  const connect = (): void => {
    if (manuallyClosed) return

    clearTimer()
    source?.close()
    source = null
    status.value = retries.value > 0 ? 'reconnecting' : 'connecting'

    const target = toValue(url)
    if (!target) {
      status.value = 'idle'
      return
    }

    let next: SseSource
    try {
      next = (options.factory ?? defaultFactory)(target)
    } catch (error) {
      // 例如浏览器不支持 EventSource：不再重试，交给调用方展示降级 UI
      status.value = 'closed'
      onError?.(error as Event)
      return
    }

    source = next
    next.onopen = (event) => {
      retries.value = 0
      status.value = 'open'
      onOpen?.(event)
    }
    next.onerror = (event) => {
      onError?.(event)
      if (source === next) source = null
      next.close()
      scheduleReconnect()
    }

    for (const [name, handler] of Object.entries(events)) {
      next.addEventListener(name, (event: MessageEvent) => {
        let payload: unknown = event.data
        try {
          payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        } catch {
          // 非 JSON 的 data 原样给回调（服务端约定是 JSON，这里只是不抛错）
        }
        handler(payload, event)
      })
    }
  }

  const open = (): void => {
    manuallyClosed = false
    retries.value = 0
    connect()
  }

  watch(
    () => toValue(url),
    () => {
      if (manuallyClosed) return
      retries.value = 0
      connect()
    },
  )

  if (immediate) open()

  if (autoClose) onScopeDispose(close)

  return { status, retries, open, close }
}
