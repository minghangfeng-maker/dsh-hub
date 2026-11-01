import { ADMIN_JOB_LOG, ADMIN_JOB_TASKS, ADMIN_JOBS } from './admin'
import { cockpitBootstrapEvents, subscribeCockpit } from './cockpit'
import { mockJobDetail, subscribeMockJob } from './jobs'
import { advanceMockExport, getMockState, mockInstanceSummary, subscribeMockEvent } from './state'

/**
 * 假 `EventSource`（**仅开发环境**）：让 `composables/useSse.ts` 在 `?mock=1` 下也能工作。
 *
 * - `/api/me/instance/events`：连接后立刻补一条当前 `status`，之后转发假状态机广播的阶段事件；
 * - `/api/me/exports/:id/events`：每 600ms 推进一次假进度，完成时发 `done`；
 * - `/api/admin/jobs/:id/events`（WP6）：补一条 `job` + 周期发 `log` 块（保持连接，界面显示「实时」）；
 *   WP12b 起动态任务（`mocks/jobs.ts`）改发它自己的 `job` / `task` 事件，进度真的会走到成功；
 * - `/api/admin/instances/:id/logs/stream`（WP6）：周期发 `line`。
 */
export class MockEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly url: string
  readyState = MockEventSource.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private readonly timeouts: ReturnType<typeof setTimeout>[] = []
  private unsubscribe: (() => void) | null = null

  constructor(url: string) {
    this.url = url

    this.timeouts.push(
      setTimeout(() => {
        if (this.readyState === MockEventSource.CLOSED) return
        this.readyState = MockEventSource.OPEN
        this.onopen?.(new Event('open'))
        this.attach()
      }, 20),
    )
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED
    for (const timer of this.timers) clearInterval(timer)
    for (const timer of this.timeouts) clearTimeout(timer)
    this.timers.length = 0
    this.timeouts.length = 0
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private dispatch(type: string, data: unknown): void {
    if (this.readyState === MockEventSource.CLOSED) return
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    if (type === 'message') this.onmessage?.(event)
  }

  private attach(): void {
    // 管理座舱（WP56c，24 §3.2）：连上先补发一次全量 ops.status，之后跟着假状态机广播
    if (this.url.includes('/api/admin/cockpit/events')) {
      for (const event of cockpitBootstrapEvents()) this.dispatch(event.type, event)
      this.unsubscribe = subscribeCockpit((event) => this.dispatch(event.type, event))
      return
    }

    if (this.url.includes('/api/me/instance/events')) {
      const state = getMockState()
      // 新连接先把当前状态补一次，订阅者不用等下一次变化
      this.dispatch('status', {
        instance: mockInstanceSummary(),
        phase: state.phase ?? undefined,
        message: state.phaseMessage ?? undefined,
      })
      this.unsubscribe = subscribeMockEvent((event) => this.dispatch(event.type, event.data))
      return
    }

    const jobEvents = /\/api\/admin\/jobs\/(\d+)\/events/.exec(this.url)
    if (jobEvents) {
      const id = Number(jobEvents[1])
      const dynamic = mockJobDetail(id)
      if (dynamic) {
        // 动态任务：先补当前状态，之后跟着任务状态机走（几秒内跑完）
        this.dispatch('job', { job: dynamic.job })
        for (const task of dynamic.tasks) this.dispatch('task', { task })
        this.unsubscribe = subscribeMockJob(id, (event) => this.dispatch(event.type, event.payload))
        return
      }

      const job = ADMIN_JOBS.find((item) => item.id === id) ?? ADMIN_JOBS[0]
      this.dispatch('job', { job })
      for (const task of ADMIN_JOB_TASKS) this.dispatch('task', { task })

      const lines = ADMIN_JOB_LOG.split('\n')
      let cursor = 0
      this.timers.push(
        setInterval(() => {
          const runningTask = ADMIN_JOB_TASKS.find((task) => task.status === 'running') ?? ADMIN_JOB_TASKS[0]
          const line = lines[cursor % lines.length] ?? ''
          cursor += 1
          this.dispatch('log', { taskId: runningTask?.id ?? 0, chunk: `${line}\n` })
        }, 4000),
      )
      return
    }

    const instanceLogs = /\/api\/admin\/instances\/(\d+)\/logs\/stream/.exec(this.url)
    if (instanceLogs) {
      const lines = ADMIN_JOB_LOG.split('\n')
      let cursor = 0
      this.timers.push(
        setInterval(() => {
          const line = lines[cursor % lines.length] ?? ''
          cursor += 1
          this.dispatch('line', { line })
        }, 5000),
      )
      return
    }

    const match = /\/api\/me\/exports\/(\d+)\/events/.exec(this.url)
    if (match) {
      const id = Number(match[1])
      this.timers.push(
        setInterval(() => {
          const tick = advanceMockExport(id)
          if (!tick) return
          if (tick.done) {
            this.dispatch('done', { export: tick.item })
            this.close()
            return
          }
          this.dispatch('progress', tick.item.progress)
        }, 600),
      )
    }
  }
}

/** 把全局 `EventSource` 换成假实现（返回还原函数，测试/热更新用）。 */
export function installMockEventSource(): () => void {
  const original = globalThis.EventSource
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource
  return () => {
    globalThis.EventSource = original
  }
}
