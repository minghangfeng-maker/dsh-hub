/**
 * 发送队列：本地乐观气泡、幂等键（`clientMessageId`）、「结果未知」判定、ack 结算。
 *
 * M4 §12.1 的三条硬规则在这里落地：
 *  - `send()` 自己复核链路/节点/能力/停止中，不依赖 UI 是否禁用按钮（停止中发送的自我保护）；
 *  - `ack` 只代表 Host 已接受：气泡保留「已发送」，等带 `clientMessageId` 的 canonical
 *    消息到达才按**精确 id** 归并，不按顺序、不按文本猜；
 *  - 「结果未知」按消息自身的生命周期判定（跨越一次成功重连，或超过 120s），
 *    不按连续失败次数；用户显式重试时沿用同一个 `clientMessageId`（幂等键）。
 */

import { send as sendFrame } from './wire.js'
import type { FrameOf } from './workspace-state.js'
import type { MobileOutgoingAttachment } from '../contracts/mobile-v2.js'
import { errorMessage } from '../errors.js'
import { randomId } from './ids.js'
import { appendLocalMessage, markMessageFlags, markUnknownMessages } from './conversation.js'
import type { ChatEntry, WorkspaceState } from './workspace-state.js'
import type { RequestFrame } from './requests.js'

const PENDING_UNKNOWN_MS = 120_000

/** 一次已发出、还没收口的 send（结果未知的判定要用它的生命周期）。 */
export interface PendingSend {
  sessionId: string
  text: string
  at: number
  connectionGeneration: number
  attachments?: MobileOutgoingAttachment[]
}

export interface PendingSendsDeps {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  patchState(next: WorkspaceState): void
  fail(code: string, message: string, retryable?: boolean): void
  send(frame: RequestFrame): boolean
  nextRequestId(): string
  now(): number
  connectionGeneration(): number
  canSend(): boolean
}

export class PendingSends {
  private readonly sends = new Map<string, PendingSend>()
  /** requestId → clientMessageId（ack/error 帧可能只带其一来回）。 */
  private readonly byRequest = new Map<string, string>()

  constructor(private readonly deps: PendingSendsDeps) {}

  get count(): number {
    return this.sends.size
  }

  /** 记一条「已发出、未收口」的 send（供 sweep/ack/error 用）。 */
  remember(requestId: string, clientMessageId: string, pending: PendingSend): void {
    this.byRequest.set(requestId, clientMessageId)
    this.sends.set(clientMessageId, pending)
  }

  /**
   * 发一条消息。
   *
   * @param options.clientMessageId 指定幂等键（**发送队列用它**：队列 id 就是 clientMessageId，
   *        这样「待发气泡」和「发送中气泡」是同一个身份，Hub/Host 也能按稳定 id 去重）；
   *        缺省自己生成。
   * @returns 生成的 `clientMessageId`（UI 用它把本地附件缩略图挂到 pending 气泡上）；
   *          前置条件不满足时返回 null（错误已经通过 `state.error` 暴露）。
   */
  send(
    text: string,
    options: { attachments?: MobileOutgoingAttachment[]; clientMessageId?: string } = {},
  ): string | null {
    const trimmed = text.trim()
    if (!trimmed && (options.attachments ?? []).length === 0) return null
    const state = this.deps.state()
    const open = state.openSessionId
    if (open == null) {
      this.deps.fail('session-not-found', '还没有打开会话')
      return null
    }
    // 入口自检（与 canSend 等价），不依赖 UI 是否禁用按钮。
    if (state.link !== 'connected') {
      this.deps.fail('not-connected', errorMessage('not-connected'), true)
      return null
    }
    if (!state.nodeConnectable) {
      this.deps.fail('node-not-connectable', state.nodeBlockedReason ?? errorMessage('node-not-connectable'))
      return null
    }
    if (state.stopRequested) {
      this.deps.fail('stop-requested', errorMessage('stop-requested'), true)
      return null
    }
    if (!(state.capabilities?.send ?? false)) {
      this.deps.fail('unsupported', errorMessage('unsupported'))
      return null
    }
    const clientMessageId = options.clientMessageId ?? `m_${randomId()}`
    const requestId = this.deps.nextRequestId()
    this.remember(requestId, clientMessageId, {
      sessionId: open,
      text: trimmed,
      at: this.deps.now(),
      connectionGeneration: this.deps.connectionGeneration(),
      ...(options.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
    })
    const entry: ChatEntry = {
      seq: null,
      localId: clientMessageId,
      role: 'user',
      text: trimmed,
      tools: [],
      at: this.deps.now(),
      pending: true,
      failed: false,
      unknown: false,
    }
    this.deps.patchState({
      ...appendLocalMessage(state, entry),
      pendingSendCount: this.count,
      error: null,
    })
    if (
      !this.deps.send(
        sendFrame(requestId, open, trimmed, clientMessageId, undefined, options.attachments),
      )
    ) {
      this.deps.fail('send-failed', errorMessage('send-failed'), true)
      return null
    }
    return clientMessageId
  }

  /**
   * 用户显式重试「结果未知」的消息：沿用**同一个** clientMessageId，
   * 让 Hub/Host 用稳定 id 去重；绝不自动重发（M4 §12.1）。
   */
  retryUnknown(localId: string): void {
    const state = this.deps.state()
    const entry = state.messages.find((m) => m.localId === localId && m.unknown)
    if (!entry) return
    const open = state.openSessionId
    if (open == null) return
    if (!this.deps.canSend()) {
      this.deps.fail('not-connected', '连接未就绪，请重连后再试', true)
      return
    }
    const requestId = this.deps.nextRequestId()
    this.remember(requestId, localId, {
      sessionId: open,
      text: entry.text,
      at: this.deps.now(),
      connectionGeneration: this.deps.connectionGeneration(),
    })
    this.deps.patchState({
      ...markMessageFlags(state, localId, { pending: true, unknown: false, failed: false }),
      pendingSendCount: this.count,
    })
    this.deps.send(sendFrame(requestId, open, entry.text, localId))
  }

  /** ack：清幂等身份；旧会话的 ack 只清记录，不改当前页。 */
  onAck(frame: FrameOf<'ack'>): void {
    const clientMessageId = frame.clientMessageId ?? this.byRequest.get(frame.requestId) ?? null
    if (!clientMessageId) return
    const pending = this.sends.get(clientMessageId)
    this.sends.delete(clientMessageId)
    this.forgetRequestsOf(clientMessageId)
    if (pending && pending.sessionId !== this.deps.state().openSessionId) {
      this.deps.patch({ pendingSendCount: this.count })
      return
    }
    this.deps.patchState({
      ...markMessageFlags(this.deps.state(), clientMessageId, { pending: false, unknown: false }),
      pendingSendCount: this.count,
    })
  }

  /** canonical 消息已落地（同一 clientMessageId）：幂等身份可以清了。 */
  settle(clientMessageId: string): void {
    this.sends.delete(clientMessageId)
    this.forgetRequestsOf(clientMessageId)
  }

  /**
   * 错误帧：结算这条 send（保留身份 / 标结果未知 / 标失败）。
   *
   * @returns true = 属于当前会话的待发消息，调用方还要把错误条也标出来。
   */
  onError(requestId: string, code: string, retryable: boolean): boolean {
    const clientMessageId = this.byRequest.get(requestId)
    if (clientMessageId === undefined) return false
    const pending = this.sends.get(clientMessageId)
    const touchesCurrent = pending != null && pending.sessionId === this.deps.state().openSessionId
    this.byRequest.delete(requestId)
    if (code === 'send-in-flight') {
      // 结果待定：保留 pending 与身份，不自动重发。
      return touchesCurrent
    }
    if (retryable) {
      if (touchesCurrent) {
        this.deps.patchState({
          ...markMessageFlags(this.deps.state(), clientMessageId, { pending: false, unknown: true }),
          pendingSendCount: this.count,
        })
      }
      return touchesCurrent
    }
    this.sends.delete(clientMessageId)
    if (touchesCurrent) {
      this.deps.patchState({
        ...markMessageFlags(this.deps.state(), clientMessageId, { pending: false, failed: true }),
        pendingSendCount: this.count,
      })
    }
    return touchesCurrent
  }

  /**
   * 未决消息的「结果未知」判定只看消息自身生命周期：
   * 1) 跨越过一次成功重连（connectionGeneration 变了），或
   * 2) 从发出到现在超过 120s。
   * 不用连续失败次数 —— onHello 每次都会把 attempt 归零。
   */
  sweep(): void {
    const state = this.deps.state()
    const open = state.openSessionId
    if (open == null || this.sends.size === 0) return
    const nowMs = this.deps.now()
    const generation = this.deps.connectionGeneration()
    const stale: string[] = []
    for (const [id, pending] of this.sends) {
      if (
        pending.sessionId === open &&
        (pending.connectionGeneration < generation || nowMs - pending.at >= PENDING_UNKNOWN_MS)
      ) {
        stale.push(id)
      }
    }
    if (stale.length === 0) return
    this.deps.patchState(markUnknownMessages(state, stale))
  }

  clear(): void {
    this.sends.clear()
    this.byRequest.clear()
  }

  private forgetRequestsOf(clientMessageId: string): void {
    for (const [requestId, value] of this.byRequest) {
      if (value === clientMessageId) this.byRequest.delete(requestId)
    }
  }
}
