/**
 * 会话列表：刷新 / 全部 vs 已归档筛选 / 新建会话 / **turn-sync 权威回包**。
 *
 * 这里的时序规则（真机 2026-10-27 16:07「会话卡住」）——**仅在未协商
 * `session-state` 时生效**：协商后回合态由快照（`conversation.ts` 的 `onSessionState`）负责。
 *   - 断线期间结束的回合在 catch-up 里**只有持久消息、没有 `turn/end`**（adapter 不补发
 *     控制帧），所以重连后的回合状态只能靠会话列表的 `running` 收口；
 *   - 但「手动刷新列表」拿到的旧快照不能当权威位 —— 只认 hello 触发的那一次，或
 *     replay 之后主动补拉的那一次（`turnSyncRequestId`）；
 *   - §17 D5：默认列表**不含**已归档；归档成功后要把这一行从当前列表里拿掉，
 *     在「已归档」视图里则保留并打标。
 */

import { create, sessions as sessionsFrame } from './wire.js'
import type { CreateFrameOptions } from './wire.js'
import { errorMessage } from '../errors.js'
import type { RequestFrame, RequestRegistry } from './requests.js'
import type { MobileSessionRowV2, MobileSessionsV2Frame } from '../contracts/mobile-v2.js'
import type { AnyServerFrame } from './wire.js'
import type { ModelEcho, WorkspaceState } from './workspace-state.js'

export interface SessionsDeps {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  send(frame: RequestFrame): boolean
  requests: RequestRegistry
  now(): number
  fail(code: string, message: string): void
  /** 首页/上一页（`conversation-stream`）。 */
  requestHistory(sessionId: string, beforeSeq: number | null): void
  /** 打开会话（门面）。 */
  openSession(sessionId: string): void
  /** 把服务端回显的模型写进当前选择（`actions`）。 */
  applyModelEcho(model: ModelEcho): void
  /** 回合状态校正（门面 → 纯 reducer）。 */
  syncTurnRunning(running: boolean): void
  /** `created` 回包（发送队列据此把「待建会话」的条目归到新会话）。 */
  sessionCreated?(requestId: string, sessionId: string): void
}

export class SessionList {
  /**
   * 重连后第一份会话列表的 requestId（hello 触发的那一次 / replay 后补拉的那一次）。
   *
   * 断线期间结束的回合在 catch-up 里没有 `turn/end`，所以重连后的回合状态只能靠列表的
   * `running` 收口；只认这一份回包，避免把用户手动刷新拿到的旧快照当成权威位。
   */
  private turnSyncRequestId: string | null = null

  constructor(private readonly deps: SessionsDeps) {}

  refresh(includeArchived = this.deps.state().sessionsIncludeArchived): void {
    const requestId = this.deps.requests.nextId()
    if (!this.deps.send(sessionsFrame(requestId, true, includeArchived))) return
    this.deps.requests.track(requestId, { kind: 'sessions', includeArchived })
    this.deps.patch({ sessionsLoading: true })
  }

  /** 切换「全部会话 / 已归档」视图（只有服务端回显 `archive` feature 时才有入口）。 */
  setIncludeArchived(includeArchived: boolean): void {
    this.deps.patch({ sessionsIncludeArchived: includeArchived })
    this.refresh(includeArchived)
  }

  /**
   * 新建会话。
   *
   * @returns 这次 create 的 requestId（**发送队列靠它关联回包**：只有这一次请求的成功/失败
   *          才算数）；能力不支持或帧没发出去时返回 null。
   */
  createSession(options: CreateFrameOptions = {}): string | null {
    const capabilities = this.deps.state().capabilities
    if (!capabilities?.create) {
      this.deps.fail('unsupported', errorMessage('unsupported'))
      return null
    }
    const requestId = this.deps.requests.nextId()
    if (!this.deps.send(create(requestId, options))) return null
    this.deps.requests.track(requestId, { kind: 'create' })
    return requestId
  }

  /**
   * 要一份最新的会话列表来校正回合状态（hello 之后 / replay 之后调用）。
   *
   * 与手动刷新共用同一条帧，但会把它记进 `turnSyncRequestId`：迟到/过期的会话列表
   * 永远不会被当成回合状态的权威位。
   */
  requestTurnSync(): void {
    if (this.deps.state().link !== 'connected') return
    const requestId = this.deps.requests.nextId()
    if (!this.deps.send(sessionsFrame(requestId, false, this.deps.state().sessionsIncludeArchived))) return
    this.deps.requests.track(requestId, { kind: 'sessions', includeArchived: this.deps.state().sessionsIncludeArchived })
    this.turnSyncRequestId = requestId
  }

  onSessions(frame: MobileSessionsV2Frame): void {
    const record = this.deps.requests.take(frame.requestId)
    const open = this.deps.state().openSessionId
    const rows = frame.items as MobileSessionRowV2[]
    const includeArchived = record?.includeArchived ?? this.deps.state().sessionsIncludeArchived
    // 打开的会话不在列表里 = 服务端认为它不存在/已归档到看不见（只收敛 id，不清页面消息）。
    const resolved = open != null && rows.some((row) => row.sessionId === open) ? open : null
    this.deps.patch({
      sessions: rows,
      sessionsIncludeArchived: includeArchived,
      sessionsLoading: false,
      openSessionId: resolved,
    })
    if (frame.requestId === this.turnSyncRequestId) {
      this.turnSyncRequestId = null
      // 协商了 `session-state` 时回合态以**快照**为准（M6 §2.3）：会话列表是「拉的时刻」的
      // 旧快照，拿它校正会把已经结束/开始的回合又翻回去。未协商（老 Hub）才走这条兜底。
      if (!this.deps.state().features.includes('session-state')) {
        const row = resolved == null ? undefined : rows.find((item) => item.sessionId === resolved)
        if (row !== undefined) this.deps.syncTurnRunning(row.running === true)
      }
    }
    if (resolved != null && this.deps.state().messages.length === 0) {
      this.deps.requestHistory(resolved, null)
    }
  }

  onCreated(frame: Extract<AnyServerFrame, { type: 'created' }>): void {
    this.deps.requests.delete(frame.requestId)
    if (!frame.sessionId) return
    const row: MobileSessionRowV2 = {
      sessionId: frame.sessionId,
      title: null,
      updatedAt: this.deps.now(),
      running: false,
      blank: true,
      agentAvailable: true,
    }
    this.deps.patch({
      sessions: [row, ...this.deps.state().sessions.filter((item) => item.sessionId !== row.sessionId)],
    })
    // v2 created 会回显真正生效的 preset/model（selectModel 由服务端执行）。
    const model = (frame as { model?: ModelEcho }).model
    if (model) this.deps.applyModelEcho(model)
    this.deps.openSession(frame.sessionId)
    // 发送队列：把「还没会话」的条目归到这次新建的会话上（只认这次 create 的 requestId）。
    this.deps.sessionCreated?.(frame.requestId, frame.sessionId)
  }

  /** hello 时的那一份列表也参与回合状态校正（与 `requestTurnSync` 同语义）。 */
  markTurnSync(requestId: string): void {
    this.turnSyncRequestId = requestId
  }
}
