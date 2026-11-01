import type { CockpitEvent } from '@dsh-hub/shared'

/**
 * 座舱事件总线（`GET /api/admin/cockpit/events` 的 SSE 数据源）。
 *
 * 为什么不用 `deps.events`：那个是通用主题总线（字符串主题 + unknown 载荷），
 * 座舱要的是「一个类型安全的事件流、订阅者出错不影响业务」；实现只有二十行，
 * 单独一份比给通用总线加一层映射更清楚。
 */
export interface CockpitEventBus {
  emit(event: CockpitEvent): void
  subscribe(listener: (event: CockpitEvent) => void): () => void
  subscriberCount(): number
  /** 关应用时清掉订阅者（避免把已关闭的 reply 留住） */
  clear(): void
}

export function createCockpitEventBus(onError?: (error: unknown) => void): CockpitEventBus {
  const listeners = new Set<(event: CockpitEvent) => void>()
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (error) {
          onError?.(error)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscriberCount: () => listeners.size,
    clear: () => {
      listeners.clear()
    },
  }
}
