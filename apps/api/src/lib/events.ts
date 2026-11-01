import type {
  ExportItem,
  ExportProgress,
  InstanceStatusEvent,
  JobLogEvent,
  JobSummary,
  JobTaskSummary,
} from '@dsh-hub/shared'

/**
 * 进程内事件总线（供 SSE 用）。模块只 emit 事实，SSE 路由负责翻译成 `event: <name>`。
 * 事件不持久化：错过就错过（前端重连时会重新拉一次快照）。
 */
export interface HubEventMap {
  /** `/api/me/instance/events` → `event: status` */
  'instance.status': { userId: number; event: InstanceStatusEvent }
  /** `/api/me/exports/:id/events` → `event: progress` */
  'export.progress': { userId: number; exportId: number; progress: ExportProgress }
  /** `event: done` */
  'export.done': { userId: number; exportId: number; item: ExportItem }
  /** `event: failed` */
  'export.failed': { userId: number; exportId: number; error: { code: string; message: string } }
  /** `/api/admin/jobs/:id/events` → `event: job` */
  'job.updated': { job: JobSummary }
  /** `event: task` */
  'job.task': { jobId: number; task: JobTaskSummary }
  /** `event: log` */
  'job.log': { jobId: number } & JobLogEvent
  /**
   * 设备被吊销（WP40a）：手机通道据此**立刻**发 `bye` 并关连接，
   * 而不是等 20 秒一次的会话复查。来源包括：用户/管理员吊销设备、改密吊销令牌、
   * 停用账号、删除用户的级联吊销。
   */
  'mobile.device.revoked': { userId: number; deviceId: string }
  /**
   * 管理员登出（WP56b / docs/24 §3.3）：其座舱令牌立即作废、座舱通道收到 `bye`。
   * 座舱令牌是「用交接码换来的另一套凭据」，不跟着 cookie 会话走，所以必须显式通知。
   */
  'cockpit.admin-logout': { adminId: number }
}

export type HubEventName = keyof HubEventMap

export interface EventBus {
  on<K extends HubEventName>(name: K, handler: (payload: HubEventMap[K]) => void): () => void
  once<K extends HubEventName>(name: K, handler: (payload: HubEventMap[K]) => void): () => void
  emit<K extends HubEventName>(name: K, payload: HubEventMap[K]): void
  listenerCount(name?: HubEventName): number
  clear(): void
}

export interface EventBusOptions {
  /** 订阅者抛错时的回调（默认吞掉，避免一个坏订阅者影响业务） */
  onError?: (error: unknown, name: HubEventName) => void
}

export function createEventBus(opts: EventBusOptions = {}): EventBus {
  const listeners = new Map<HubEventName, Set<(payload: never) => void>>()

  function remove(name: HubEventName, handler: (payload: never) => void): void {
    const set = listeners.get(name)
    if (!set) return
    set.delete(handler)
    if (set.size === 0) listeners.delete(name)
  }

  return {
    on(name, handler) {
      const set = listeners.get(name) ?? new Set()
      set.add(handler as (payload: never) => void)
      listeners.set(name, set)
      return () => remove(name, handler as (payload: never) => void)
    },
    once(name, handler) {
      const off = this.on(name, (payload) => {
        off()
        handler(payload)
      })
      return off
    },
    emit(name, payload) {
      const set = listeners.get(name)
      if (!set) return
      for (const handler of [...set]) {
        try {
          ;(handler as (p: HubEventMap[typeof name]) => void)(payload)
        } catch (error) {
          opts.onError?.(error, name)
        }
      }
    },
    listenerCount(name) {
      if (name) return listeners.get(name)?.size ?? 0
      let total = 0
      for (const set of listeners.values()) total += set.size
      return total
    },
    clear() {
      listeners.clear()
    },
  }
}
