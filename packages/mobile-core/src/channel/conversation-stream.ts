/**
 * 打开会话的**编排**：首页 → 拿到 opening cursor → 带 cursor 订阅。
 *
 * 为什么不能省这一步（真机 2026-10-26）：`history` 帧里的 `cursor` 就是 Host
 * `session/follow` 的 opening cursor；订阅必须带 `sinceCursor = 该 cursor`，否则
 * (history cursor, 新 follow 的 snapshot.cursor] 之间落下的消息两边都收不到。
 * 表现是「新建会话后立刻发第一条消息，工具卡排到用户气泡上面」——因为本地气泡 seq=null
 * 永远等不到它的 canonical 消息，被 `mergeThread` 排到最后。
 *
 * 这里也装着首页/上一页的游标与重试编排：
 *  - `lastCursor`：history.cursor / replay.toCursor 的前移值（下一份订阅的 sinceCursor）；
 *  - 首页失败（不可重试）也必须裸订阅：实时流优先于首屏完整性；
 *  - 瞬态错误按 `retry` 的策略静默重试（0.5/1/2/3s），用尽才交给 UI。
 *
 * reducer 是纯的（`conversation.ts`），本文件只做「什么时候发什么帧」。
 */

import { history, subscribe, unsubscribe } from './wire.js'
import type { AnyServerFrame } from './wire.js'
import { isTransientCode, type ChannelRecovery, type TransientRetry } from './retry.js'
import type { RequestFrame, RequestRecord, RequestRegistry } from './requests.js'
import { setHistoryLoading, withOpenSessionId } from './conversation.js'
import type { ReduceOptions } from './conversation.js'
import type { WorkspaceState } from './workspace-state.js'

/**
 * 打开会话时「等首页游标再订阅」的兜底时长：首页迟迟不回就直接订阅（不带 cursor），
 * 先保住实时流，不要在没订阅的状态下干等。
 */
const OPEN_SUBSCRIBE_TIMEOUT_MS = 3_000
const HISTORY_PAGE_SIZE = 30

export interface ConversationStreamDeps {
  state(): WorkspaceState
  patch(next: WorkspaceState): void
  send(frame: RequestFrame): boolean
  requests: RequestRegistry
  /** 当前会话代次（打开/关闭会话时自增；旧代次的迟到回包据此丢弃）。 */
  epoch(): number
  /** 把帧交给 reducer 并提交（门面实现；顺带执行 effects）。 */
  apply(frame: AnyServerFrame, options: ReduceOptions): void
  log(event: string, meta?: Record<string, unknown>): void
  retry: TransientRetry
  recovery: ChannelRecovery
  disposed(): boolean
}

export class ConversationStream {
  /** 下一份订阅的 sinceCursor（history.cursor / replay.toCursor 的前移值）。 */
  private lastCursor: number | null = null
  /** 「等首页游标再订阅」的待办（见 `open`）。 */
  private pendingSubscribe: {
    sessionId: string
    epoch: number
    timer: ReturnType<typeof setTimeout> | null
  } | null = null

  constructor(private readonly deps: ConversationStreamDeps) {}

  get cursor(): number | null {
    return this.lastCursor
  }

  /** 游标只前移（history 与 replay 都会带，重复到达不会把它拉回旧值）。 */
  advanceCursor(cursor: number | null | undefined): void {
    if (cursor == null) return
    this.lastCursor = Math.max(this.lastCursor ?? 0, cursor)
  }

  reset(): void {
    this.lastCursor = null
    this.clearPending()
  }

  /** 打开会话后的跟随流启动（门面在 patch 完 openSessionId 之后调）。 */
  open(sessionId: string): void {
    this.clearPending()
    if (this.deps.state().messages.length > 0) {
      this.subscribe(sessionId)
      return
    }
    const pending = {
      sessionId,
      epoch: this.deps.epoch(),
      timer: null as ReturnType<typeof setTimeout> | null,
    }
    this.pendingSubscribe = pending
    const timer = setTimeout(() => {
      if (this.pendingSubscribe !== pending || pending.epoch !== this.deps.epoch()) return
      this.pendingSubscribe = null
      this.subscribe(sessionId)
    }, OPEN_SUBSCRIBE_TIMEOUT_MS)
    timer.unref?.()
    pending.timer = timer
    this.requestHistory(sessionId, null)
  }

  /** 首页（opening page）已就绪：用它的 cursor 订阅（`history-applied` effect 触发）。 */
  flushPendingSubscribe(sessionId: string): void {
    const pending = this.pendingSubscribe
    if (!pending || pending.sessionId !== sessionId || pending.epoch !== this.deps.epoch()) return
    this.clearPending()
    this.subscribe(sessionId)
  }

  clearPending(): void {
    const pending = this.pendingSubscribe
    this.pendingSubscribe = null
    if (pending?.timer != null) clearTimeout(pending.timer)
  }

  /** 首页/上一页（`beforeSeq = null` 表示首页）。 */
  requestHistory(sessionId: string, beforeSeq: number | null): void {
    const requestId = this.deps.requests.nextId()
    this.deps.requests.track(requestId, { kind: 'history', sessionId, beforeSeq })
    this.deps.send(history(requestId, sessionId, { beforeSeq, limit: HISTORY_PAGE_SIZE }))
    this.deps.patch(setHistoryLoading(this.deps.state(), true))
  }

  /** 订阅会话跟随流（带 `lastCursor` 续看）；未连接时静默跳过。 */
  subscribe(sessionId: string): void {
    if (this.deps.state().link !== 'connected') return
    const requestId = this.deps.requests.nextId()
    this.deps.requests.track(requestId, { kind: 'subscribe', sessionId })
    this.deps.send(subscribe(requestId, sessionId, this.lastCursor))
  }

  /** 取消订阅（切会话/关会话）；发不出去无所谓。 */
  unsubscribe(sessionId: string): void {
    this.deps.send(unsubscribe(sessionId))
  }

  /** history 回包：归属校验（kind / 发起时会话）之后交给 reducer（epoch 由 reducer 校验）。 */
  onHistory(frame: Extract<AnyServerFrame, { type: 'history' }>): void {
    const record = this.deps.requests.take(frame.requestId)
    if (!record || record.kind !== 'history') return
    if (record.sessionId == null) return
    if (record.sessionId !== this.deps.state().openSessionId) return
    this.deps.apply(frame, { requestEpoch: record.epoch, beforeSeq: record.beforeSeq })
  }

  /**
   * 瞬态错误的静默重试（只对幂等读 history/subscribe）。返回 true = 已排重试，别弹错误条。
   *
   * mux 断开时所有流都收到 upstream-unavailable，下一次 open 会重连，所以再发一次
   * 就能自己恢复；四档退避（0.5s / 1s / 2s / 3s）用尽才把错误交给 UI。
   */
  scheduleRetry(record: RequestRecord, code: string, retryable: boolean): boolean {
    if (!retryable || !isTransientCode(code)) return false
    if (record.kind !== 'history' && record.kind !== 'subscribe') return false
    const sessionId = record.sessionId
    if (sessionId == null) return false
    const epoch = this.deps.epoch()
    const beforeSeq = record.beforeSeq
    return this.deps.retry.schedule(`${record.kind}:${sessionId}`, () => {
      if (this.deps.epoch() !== epoch) return
      if (this.deps.state().link !== 'connected') return
      if (this.deps.state().openSessionId !== sessionId) return
      if (record.kind === 'history') this.requestHistory(sessionId, beforeSeq)
      else this.subscribe(sessionId)
    })
  }

  /**
   * 通道级瞬态错误（Hub→Host 的 mux 断了 / 实例正在启动）的自动恢复：
   * 退避后重新订阅一次，把 adapter 的 follow / `$events` 流重新带起来。
   */
  recoverChannel(): boolean {
    return this.deps.recovery.schedule(() => {
      if (this.deps.disposed()) return
      if (this.deps.state().link !== 'connected') return
      const open = this.deps.state().openSessionId
      if (open == null) return
      this.subscribe(open)
      if (this.deps.state().messages.length === 0) this.requestHistory(open, null)
    })
  }

  /** 会话列表回包把「打开的会话」收敛成服务端给的值（只改 id，不清页面）。 */
  setOpenSessionId(sessionId: string | null): void {
    this.deps.patch(withOpenSessionId(this.deps.state(), sessionId))
  }
}
