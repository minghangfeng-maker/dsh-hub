/**
 * 下行 `error` 帧的分派**优先级**（这块以前是 `onError` 里最长的一段，最容易被补丁改错）。
 *
 * 顺序与原实现逐条对齐，不能换：
 *  1. **有界回调优先**：动作（rename/archive/set-model）→ 文件 → 上传 → 用量。
 *     这些请求各有自己的错误出口，不能掉进「旧请求污染新会话」的通用分支，
 *     也不该再弹一条通用错误条。
 *  2. **有界归属表**（history/sessions/subscribe/create/stop/answer）：关会话不清表，
 *     所以旧会话的迟到错误仍能被识别为过期（`epoch`/`sessionId`），而不是污染当前页。
 *     瞬态错误（mux 断开）先静默重试，用尽才把「Host 流连接关闭（1006）」这种技术文案
 *     换成中文兜底显示。
 *  3. **发送请求**：send-in-flight / 可重试错误保留 `clientMessageId`（结果待定），
 *     不可重试才标失败并删掉幂等身份。
 *  4. **通道级错误**（没有 requestId）：可重试的先退避恢复（重订阅把 mux 带起来），
 *     连续多次失败才交给 UI。
 *  5. 归属未知/已过期的 requestId：只同步计数，不改当前页面。
 */

import { errorMessage } from '../errors.js'
import { displayErrorText } from './retry.js'
import type { ConversationStream } from './conversation-stream.js'
import type { SessionActions } from './actions.js'
import type { FileService } from './file-service.js'
import type { UploadService } from './upload-service.js'
import type { PendingSends } from './pending-sends.js'
import type { Outbox } from './outbox.js'
import type { RequestRegistry } from './requests.js'
import type { FrameOf, WorkspaceState } from './workspace-state.js'

export interface ErrorRouterDeps {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  patchState(next: WorkspaceState): void
  epoch(): number
  requests: RequestRegistry
  actions: SessionActions
  files: FileService
  uploads: UploadService
  stream: ConversationStream
  sends: PendingSends
  /** 发送队列：`create` 的失败只按这一次请求的回包判定（不看全局 error）。 */
  outbox: Outbox
  maybeAuthLost(code: string): void
}

export function routeErrorFrame(deps: ErrorRouterDeps, frame: FrameOf<'error'>): void {
  const requestId = frame.requestId
  const open = deps.state().openSessionId
  const code = frame.code || 'internal'
  const text = frame.message || errorMessage(code)

  if (requestId != null) {
    const record = deps.requests.peek(requestId)
    if (record !== undefined) {
      if (record.kind === 'rename' || record.kind === 'archive' || record.kind === 'set-model') {
        if (deps.actions.failRequest(requestId, code, text)) return
      }
      if (record.kind === 'file') {
        deps.files.failRequest(requestId, text, code, frame.retryable === true)
        return
      }
      if (record.kind === 'upload-begin' || record.kind === 'upload-chunk') {
        deps.uploads.failRequest(requestId, code, text)
        return
      }
      // 用量请求的错误只在面板里显示（不污染全局错误条）。
      if (record.kind === 'usage') {
        deps.requests.delete(requestId)
        // 面板里也别给人看 adapter 原始技术文案：用与全局错误条同一份中文映射
        deps.actions.onUsageError(code, frame.message)
        return
      }
    }
  }

  // 先看有界请求归属表（history/sessions/subscribe/create/stop/answer）。
  // 关会话不清表，所以旧 A 的错误仍能被识别为过期，而不是掉进通用错误分支污染 B。
  if (requestId != null) {
    const record = deps.requests.take(requestId)
    if (record) {
      const current = record.epoch === deps.epoch() && (record.sessionId == null || record.sessionId === open)
      if (!current) return
      // 会话快照只是「校正」：读失败（老 Hub 没这个特性 / 会话已删）静默忽略，
      // 绝不能因为它弹一条错误条（这只发生在回前台的那一次后台请求上）。
      if (record.kind === 'session-state') return
      // 建会话失败：只认这一次 create 的回包（以前 UI 是「任何错误」都当建会话失败，
      // 于是别处的错误会把首条消息退回队列）。文案与退避由发送队列自己处理。
      if (record.kind === 'create' && deps.outbox.onCreateError(requestId, code, text, frame.retryable === true)) {
        deps.maybeAuthLost(code)
        return
      }
      // mux 断开/网络抖动：静默重试一次再重试一次，别把「Host 流连接关闭（1006）」
      // 这种技术文案丢到用户脸上（真机 2026-10-26 切后台回来的场景）。
      if (deps.stream.scheduleRetry(record, code, frame.retryable)) {
        if (record.kind === 'sessions') deps.patch({ sessionsLoading: false })
        return
      }
      deps.patch({
        sessionsLoading: record.kind === 'sessions' ? false : deps.state().sessionsLoading,
        historyLoading: record.kind === 'history' ? false : deps.state().historyLoading,
        error: { code, message: displayErrorText(code, frame.message), retryable: frame.retryable },
      })
      // 首页失败也不能把跟随流拖死：直接订阅（不带 cursor），实时流先保住。
      if (record.kind === 'history' && record.sessionId != null) {
        deps.stream.flushPendingSubscribe(record.sessionId)
      }
      deps.maybeAuthLost(code)
      return
    }
  }

  // 发送请求：先只读身份，send-in-flight / 可重试错误要保留 clientMessageId。
  const touchesCurrent = requestId != null ? deps.sends.onError(requestId, code, frame.retryable) : false

  if (requestId == null) {
    // 通道级瞬态错误：真机 2026-10-26 唤容器（17:02）时 Hub→Host 的 mux 还没建好，
    // 会推一条没有 requestId 的 adapter-unavailable。以前直接弹红条，用户只看到
    // 「后端暂时不可用」而会话其实是空的；现在静默退避恢复（重订阅会把 mux 带起来），
    // 连续多次都失败才把错误交给 UI。
    //
    // 上传分片也可能收到没有 requestId 的通道级错误（老 Hub 的「上行过快」就是：
    // 限速发生在解析之前，拒绝帧带不上归属）。窗口 = 1 时最多只有一片在飞，
    // 让 uploads 退避重发它，绝不能把上传任务晾在「上传中」。
    const resumeUpload = frame.retryable === true ? deps.uploads.onChannelPressure() : false
    if (frame.retryable && deps.stream.recoverChannel()) {
      if (deps.state().error !== null) deps.patch({ error: null })
      deps.patch({ pendingSendCount: deps.sends.count, sessionsLoading: false })
      return
    }
    if (resumeUpload) {
      // 通道恢复重试已用尽，但上传还有救（退避重发在飞片）：别弹错误条
      deps.patch({ pendingSendCount: deps.sends.count, sessionsLoading: false })
      return
    }
    // 通道级错误：属于当前连接，照常展示（技术码用中文兜底）。
    deps.patch({
      pendingSendCount: deps.sends.count,
      error: { code, message: displayErrorText(code, frame.message), retryable: frame.retryable },
      sessionsLoading: false,
      historyLoading: false,
    })
  } else if (touchesCurrent) {
    deps.patch({
      pendingSendCount: deps.sends.count,
      error: { code, message: frame.message || errorMessage(code), retryable: frame.retryable },
    })
  } else {
    // 归属未知/已过期的 requestId：不改当前页面（旧响应不得污染新会话）。
    deps.patch({ pendingSendCount: deps.sends.count })
  }
  deps.maybeAuthLost(code)
}
