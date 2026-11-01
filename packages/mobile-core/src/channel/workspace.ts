/**
 * 单节点工作区状态机（**门面**）：把 `dsh-hub-mobile-v1` 帧翻译成 UI 可直接渲染的状态。
 *
 * 0.2.0 起这份职责一直在一个 2900 行的类里；WP46 按职责拆开，本文件只留门面：
 *
 *   channel/connection.ts          链路：openChannel/ticket、重连退避、心跳、linkDead、
 *                                  探活、generation 防陈旧、hello、4001/4003 分类
 *   channel/requests.ts            请求关联：requestId 生成、有界归属表、
 *                                  `track` / `request`（Promise）/ `reserve` 三种写法统一
 *   channel/retry.ts               瞬态错误重试（幂等读的 4 档退避）+ 通道级退避恢复
 *   channel/sessions.ts            会话列表（includeArchived、turn-sync 权威回包）
 *   channel/conversation.ts        **纯 reducer**：history/delta/baseline/message/turn/
 *                                  state/tool/deliverable/question/approval/本地气泡
 *   channel/conversation-stream.ts 打开会话 → 首页 → 带 cursor 订阅的编排 + 游标
 *   channel/actions.ts             rename / archive / set-model / usage / 模型目录
 *   channel/file-service.ts        产出文件下载（分块、校验、重试、内存+持久缓存）
 *   channel/upload-service.ts      附件上传（窗口 1、失败可重传）
 *   channel/outbox.ts              **发送队列**：建会话再发首条 / 唤醒排队 / 附件就绪 /
 *                                  持久化恢复 / 只按 create 的 requestId 判失败
 *   channel/workspace-state.ts     `WorkspaceState` 的形状（字段只增不改，见文件头）
 *
 * 对外 API 与 `WorkspaceState` 形状**只增不改**：这一轮新增了发送队列
 * （`enqueueSend` / `detachQueuedAttachment` / `discardQueuedForSession` / `state.outbox`），
 * 原有字段与语义一个都没动，现有测试的断言零改动。
 *
 * 六条时序经验（M2-实现进度.md §5，逐条对应 `test/workspace.test.ts` 的 `it`）现在落在
 * `conversation.ts` 的注释里；门面只负责「把帧分给谁、把结果提交给谁」。
 *
 * 另外三条来自 M4 的硬规则不变：`delta-end` ≠ 回合结束（只认 `turn/end`）；
 * `stopped.accepted` 只代表请求被接受；`clientMessageId` 是唯一幂等键。
 */

import {
  answerApproval as answerApprovalFrame,
  answerQuestion as answerQuestionFrame,
  sessionStateRequest as sessionStateRequestFrame,
  stop as stopFrame,
  unsubscribe,
  type AnyServerFrame,
  type CreateFrameOptions,
} from './wire.js'
import { errorMessage } from '../errors.js'
import type { FileCache } from './files.js'
import type { RequestRegistry } from './requests.js'
import type { TransientRetry, ChannelRecovery } from './retry.js'
import type { ChannelConnection } from './connection.js'
import type { SessionList } from './sessions.js'
import type { SessionActions } from './actions.js'
import type { ConversationStream } from './conversation-stream.js'
import type { FileService } from './file-service.js'
import type { UploadService } from './upload-service.js'
import type { PendingSends } from './pending-sends.js'
import type { Outbox } from './outbox.js'
import type { ChannelFrames } from './channel-frames.js'
import { createWorkspaceModules, type WorkspaceHost } from './wiring.js'
import { routeErrorFrame } from './error-router.js'
import {
  clearChannelScoped,
  closeConversation,
  initialStreamState,
  openConversation,
  reduceConversation,
  syncTurnRunning as reduceTurnRunning,
  type ConversationEffect,
  type ConversationResult,
  type ConversationStreamState,
  type ReduceOptions,
} from './conversation.js'
import type {
  ActionOutcome,
  DownloadedFile,
  FileReadTarget,
  FrameOf,
  QuestionPrompt,
  WorkspaceState,
} from './workspace-state.js'
import { initialWorkspaceState } from './workspace-state.js'
import type { WorkspaceControllerOptions } from './workspace-state.js'
import type { MobileOutgoingAttachment } from '../contracts/mobile-v2.js'
import type { MobileQuestionAnswer } from '@dsh-hub/shared'
import type { UploadInput } from './upload.js'

// ── 对外类型（index.ts 与 UI 从 `channel/workspace.js` 取这些名字，不能挪走）────────
export type {
  ActionOutcome,
  ApprovalRequest,
  ChatEntry,
  DownloadedFile,
  LinkState,
  OutboxAttachmentState,
  OutboxEntryView,
  QuestionPrompt,
  UiError,
  WorkspaceControllerOptions,
  WorkspaceOutboxOptions,
  WorkspaceState,
} from './workspace-state.js'

export class WorkspaceController {
  private readonly opts: WorkspaceControllerOptions
  private readonly now: () => number
  private state: WorkspaceState
  private readonly listeners = new Set<(state: WorkspaceState) => void>()

  /** 流式 attempt 记账 + 会话代次（纯 reducer 的配套状态，不进 UI 形状）。 */
  private streamState: ConversationStreamState = initialStreamState()
  private readonly requests: RequestRegistry
  private readonly connection: ChannelConnection
  private readonly stream: ConversationStream
  private readonly sessions: SessionList
  private readonly actions: SessionActions
  private readonly files: FileService
  private readonly uploads: UploadService
  private readonly retries: TransientRetry
  private readonly recovery: ChannelRecovery

  private readonly sends: PendingSends
  private readonly outbox: Outbox
  private readonly frames: ChannelFrames
  /** 模块共用的最小上下文（构造时建一次）。 */
  private readonly host: WorkspaceHost
  /** 产出文件缓存：按「会话 + fileRef」存已校验的字节（UI 可注入共享实例）。 */
  readonly fileCache: FileCache
  private disposed = false

  constructor(options: WorkspaceControllerOptions) {
    this.opts = options
    this.now = options.now ?? (() => Date.now())
    this.state = initialWorkspaceState(options.nodeId)
    const modules = createWorkspaceModules(options, {
      state: () => this.state,
      patch: (partial) => this.patch(partial),
      patchState: (next) => this.patchState(next),
      now: () => this.now(),
      log: (event, meta) => this.log(event, meta),
      fail: (code, message, retryable) => this.fail(code, message, retryable),
      canSend: () => this.canSend,
      epoch: () => this.streamState.epoch,
      disposed: () => this.disposed,
      handleFrame: (frame) => this.handleFrame(frame),
      applyFrame: (frame, reduceOptions) => this.applyConversation(frame, reduceOptions),
      openSession: (sessionId) => this.openSession(sessionId),
      syncTurnRunning: (running) => this.syncTurnRunning(running),
      sweep: () => this.sweepUnknownPending(),
      maybeAuthLost: (code) => this.maybeAuthLost(code),
      onChannelEnd: () => this.onChannelEnd(),
      onProtocolMismatch: () => this.onProtocolMismatch(),
      onConnectionRecovered: () => this.recovery.clear(),
    })
    this.host = modules.host
    this.fileCache = modules.fileCache
    this.requests = modules.requests
    this.connection = modules.connection
    this.stream = modules.stream
    this.sessions = modules.sessions
    this.actions = modules.actions
    this.files = modules.files
    this.uploads = modules.uploads
    this.sends = modules.sends
    this.outbox = modules.outbox
    this.frames = modules.frames
    this.retries = modules.retries
    this.recovery = modules.recovery
    // 冷启动就把上次没发出去的条目读回来（显示成待发气泡）：
    // 唤醒期间后端还不可连接、通道也还没起，但用户**已经能看到**自己打过的字。
    // 幂等，`start()` 里再调一次也没关系。
    void this.outbox.restore()
  }

  // ── 订阅 ────────────────────────────────────────────────────────────────

  getState(): WorkspaceState {
    return this.state
  }

  subscribe(listener: (state: WorkspaceState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get canSend(): boolean {
    return (
      this.state.link === 'connected' &&
      this.state.openSessionId !== null &&
      this.state.nodeConnectable &&
      (this.state.capabilities?.send ?? false) &&
      !this.state.stopRequested
    )
  }

  get canStop(): boolean {
    return (
      this.state.link === 'connected' &&
      this.state.openSessionId !== null &&
      (this.state.capabilities?.stop ?? false) &&
      this.state.turnRunning &&
      !this.state.stopRequested
    )
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  start(): void {
    if (this.disposed) return
    this.connection.start()
    // 冷启动：把上次没发出去的条目读回来（显示成待发气泡，连上后自动发）。
    void this.outbox.restore()
  }

  retryConnection(): void {
    if (this.disposed) return
    this.patch({ error: null })
    this.connection.retry()
  }

  disconnect(): void {
    this.connection.disconnect(() => {
      this.stream.clearPending()
      this.retries.clearAll()
      this.recovery.clear()
      this.files.failAll('连接已断开，请重试')
    })
    this.patch({ link: 'closed', streamingText: null, streamingReasoning: null })
  }

  dispose(): void {
    this.disposed = true
    this.outbox.dispose()
    this.connection.markDisposed()
    this.disconnect()
    this.listeners.clear()
  }

  /**
   * 主动探活（App 从后台切回）：`timeoutMs` 内没下行就主动断开重连。
   *
   * 探活**成功**（收到任何下行）后再补一次 `session-state-request`：切后台期间
   * 回合可能已经结束、未决提问可能变过，而增量帧不会补发（M6 §2.3）。
   */
  probeLink(timeoutMs?: number): void {
    this.connection.probe(timeoutMs, () => this.requestSessionState())
  }

  /**
   * 要一份当前会话的**权威快照**（幂等读，`session-state-request`）。
   *
   * 只在协商到 `session-state` 且链路已连接时发；回包由 reducer 整体替换回合态。
   * @returns 这次请求的 requestId（没发出去时返回 null）。
   */
  requestSessionState(sessionId: string | null = this.state.openSessionId): string | null {
    if (!this.state.features.includes('session-state')) return null
    if (sessionId === null || this.state.link !== 'connected') return null
    const requestId = this.requests.nextId()
    if (!this.connection.send(sessionStateRequestFrame(requestId, sessionId))) return null
    this.requests.track(requestId, { kind: 'session-state', sessionId })
    return requestId
  }

  clearError(): void {
    this.patch({ error: null })
  }

  // ── 会话列表 ────────────────────────────────────────────────────────────

  refreshSessions(includeArchived = this.state.sessionsIncludeArchived): void {
    this.sessions.refresh(includeArchived)
  }

  /** 切换「全部会话 / 已归档」视图（只有服务端回显 `archive` feature 时才有入口）。 */
  setIncludeArchived(includeArchived: boolean): void {
    this.sessions.setIncludeArchived(includeArchived)
  }

  /** 新建会话（UI 一般不用：为了发消息而建的会话由发送队列自己发起）。 */
  createSession(options: CreateFrameOptions = {}): void {
    this.sessions.createSession(options)
  }

  // ── 模型 / 动作 / 用量 ───────────────────────────────────────────────────

  requestModels(sessionId?: string | null): void {
    this.actions.requestModels(sessionId)
  }

  setModel(
    input: { provider: string; model: string; effort?: string },
    callbacks: { onResult?: (outcome: ActionOutcome) => void; timeoutMs?: number } = {},
  ): void {
    this.actions.setModel(input, callbacks)
  }

  renameSession(sessionId: string, title: string): Promise<ActionOutcome> {
    return this.actions.renameSession(sessionId, title)
  }

  archiveSession(sessionId: string, archived: boolean): Promise<ActionOutcome> {
    return this.actions.archiveSession(sessionId, archived)
  }

  requestUsage(sessionId: string): void {
    this.actions.requestUsage(sessionId)
  }

  clearUsage(): void {
    this.actions.clearUsage()
  }

  // ── 附件上传 ────────────────────────────────────────────────────────────

  uploadAttachment(sessionId: string, input: UploadInput): string | null {
    return this.uploads.uploadAttachment(sessionId, input)
  }

  retryUpload(localId: string): void {
    this.uploads.retry(localId)
  }

  cancelUpload(localId: string): void {
    this.uploads.cancel(localId)
  }

  outgoingAttachment(localId: string): MobileOutgoingAttachment | null {
    return this.uploads.outgoingAttachment(localId)
  }

  clearUploads(): void {
    this.uploads.clear()
  }

  // ── 产出文件 ────────────────────────────────────────────────────────────

  readFile(sessionId: string, target: FileReadTarget): Promise<DownloadedFile> {
    return this.files.readFile(sessionId, target)
  }

  // ── 会话页面 ────────────────────────────────────────────────────────────

  openSession(sessionId: string): void {
    const previous = this.state.openSessionId
    if (previous === sessionId) return
    if (previous != null) this.stream.unsubscribe(previous)
    this.retries.clearAll()
    this.recovery.clear()
    this.stream.reset()
    this.commit(openConversation(this.state, this.streamState, sessionId))
    if (this.state.link === 'connected') this.stream.open(sessionId)
  }

  closeSession(): void {
    this.stream.clearPending()
    this.retries.clearAll()
    this.recovery.clear()
    const open = this.state.openSessionId
    if (open == null) return
    this.stream.unsubscribe(open)
    this.commit(closeConversation(this.state, this.streamState))
  }

  loadOlder(): void {
    const open = this.state.openSessionId
    const before = this.state.nextBeforeSeq
    if (open == null || before == null) return
    if (!this.state.historyHasMore || this.state.historyLoading) return
    this.stream.requestHistory(open, before)
  }

  /**
   * 「重试」按钮（通道还连着、但会话页数据没加载出来）：清错误并按当前状态重新拉首页/重订阅。
   * 恢复不了就重新走 `openSessionStream` 的兜底（先首页、再带游标订阅）。
   */
  retryOpenSession(): void {
    const open = this.state.openSessionId
    if (open == null) return
    this.retries.clearAll()
    this.patch({ error: null })
    this.stream.open(open)
  }

  // ── 发送 / 停止 / 问答 ───────────────────────────────────────────────────

  /**
   * 发一条消息（本地乐观气泡 + 幂等键，见 `pending-sends.ts`）。
   * @returns 生成的 `clientMessageId`；前置条件不满足时返回 null。
   */
  send(text: string, options: { attachments?: MobileOutgoingAttachment[] } = {}): string | null {
    return this.sends.send(text, options)
  }

  /**
   * 用户显式重试「结果未知」的消息：沿用**同一个** clientMessageId，
   * 让 Hub/Host 用稳定 id 去重；绝不自动重发（M4 §12.1）。
   */
  retryUnknown(localId: string): void {
    this.sends.retryUnknown(localId)
  }

  /**
   * 入队一条消息（**UI 的发送入口**）：唤醒中/断线中/还没会话/附件还在传都能入队，
   * 满足条件时由队列自动发出去（见 `outbox.ts`）。
   *
   * @returns 队列 id —— **就是**这条消息的 `clientMessageId`（气泡身份稳定、便于幂等）。
   */
  enqueueSend(
    text: string,
    options: { attachmentIds?: string[]; sessionId?: string | null } = {},
  ): string {
    return this.outbox.enqueue({
      text,
      ...(options.attachmentIds === undefined ? {} : { attachmentIds: options.attachmentIds }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    })
  }

  /** 用户移除了还没发出去的附件：从排队条目里摘掉（纯附件消息摘完即作废）。 */
  detachQueuedAttachment(localId: string): void {
    this.outbox.detachAttachment(localId)
  }

  /** 气泡上的「重试」：把出问题的附件上传重新推起来。 */
  retryQueuedAttachments(entryId: string): boolean {
    return this.outbox.retryProblem(entryId)
  }

  /** 气泡上的「去掉附件发送」：按纯文字发出（用户明确选择）。 */
  sendQueuedWithoutAttachments(entryId: string): boolean {
    return this.outbox.sendWithoutAttachments(entryId)
  }

  /** 气泡上的「删除」：整条消息作废。 */
  discardQueuedMessage(entryId: string): boolean {
    return this.outbox.discard(entryId)
  }

  /** 会话被归档：属于它、还没发出去的草稿一并作废。 */
  discardQueuedForSession(sessionId: string): number {
    return this.outbox.discardSession(sessionId)
  }

  /** 队列里属于某个会话的条目数（UI 的状态条/标题用；null = 待建会话的）。 */
  queuedCount(sessionId: string | null = this.state.openSessionId): number {
    return this.outbox.countForSession(sessionId)
  }

  stopTurn(): void {
    const open = this.state.openSessionId
    if (open == null) return
    if (!(this.state.capabilities?.stop ?? false)) return
    const requestId = this.requests.nextId()
    if (this.connection.send(stopFrame(requestId, open))) {
      this.requests.track(requestId, { kind: 'stop', sessionId: open })
      this.patch({ stopRequested: true })
    }
  }

  answerQuestion(prompt: QuestionPrompt, answers: MobileQuestionAnswer[]): void {
    if (answers.length === 0) return
    if (prompt.sessionId !== this.state.openSessionId) return
    const requestId = this.requests.nextId()
    this.frames.rememberAnswer(requestId, prompt.callId)
    this.requests.track(requestId, { kind: 'answer-question', sessionId: prompt.sessionId })
    this.connection.send(
      answerQuestionFrame(requestId, prompt.sessionId, prompt.agent, prompt.callId, answers),
    )
  }

  /** v1 恒不可答（`capabilities.approvals=false`），这里只保留语义，UI 不画假按钮。 */
  answerApproval(approvalId: string, sessionId: string, approve: boolean): void {
    if (!(this.state.capabilities?.approvals ?? false)) return
    const requestId = this.requests.nextId()
    this.requests.track(requestId, { kind: 'answer-approval', sessionId })
    this.connection.send(
      answerApprovalFrame(requestId, sessionId, approvalId, approve ? 'approve' : 'reject'),
    )
  }

  // ── 帧分派 ──────────────────────────────────────────────────────────────

  private handleFrame(frame: AnyServerFrame): void {
    switch (frame.type) {
      case 'hello':
        return this.frames.onHello(frame)
      case 'sessions':
        return this.sessions.onSessions(frame)
      case 'history':
        return this.stream.onHistory(frame)
      case 'created':
        return this.sessions.onCreated(frame)
      case 'ack':
        return this.frames.onAck(frame)
      case 'error':
        return this.onError(frame)
      case 'capability':
        return this.frames.onCapability(frame)
      case 'node-status':
        return this.frames.onNodeStatus(frame)
      case 'models':
        return this.actions.onModels(frame)
      case 'model-changed':
        return this.actions.onModelChanged(frame)
      case 'renamed':
        return this.actions.onRenamed(frame)
      case 'archived':
        return this.actions.onArchived(frame)
      case 'usage':
        return this.actions.onUsage(frame)
      case 'file':
        return this.files.onFile(frame)
      case 'file-chunk':
        return this.files.onFileChunk(frame)
      case 'file-list':
        return this.requests.delete(frame.requestId)
      case 'upload-started':
        return this.uploads.onStarted(frame)
      case 'upload-received':
        return this.uploads.onReceived(frame)
      case 'uploaded':
        return this.uploads.onUploaded(frame)
      case 'answer-result':
        return this.frames.onAnswerResult(frame)
      case 'bye':
        return this.frames.onBye(frame)
      case 'pong':
        return
      case 'stopped':
        this.requests.delete(frame.requestId)
        return this.applyConversation(frame)
      // 会话页面（纯 reducer 处理）：帧只带数据，状态转换见 conversation.ts。
      case 'delta':
      case 'delta-end':
      case 'assistant-baseline':
      case 'message':
      case 'turn':
      case 'state':
      case 'tool':
      case 'deliverable':
      case 'question':
      case 'question-settled':
      case 'approval':
      case 'approval-settled':
      case 'replay':
      // WP46 / M6 §2.3：会话快照（权威）由纯 reducer 整体替换回合态与未决交互。
      case 'session-state':
        return this.applyConversation(frame)
      default:
        return
    }
  }

  /** 错误分派（优先级见 `error-router.ts`，顺序不能换）。 */
  private onError(frame: FrameOf<'error'>): void {
    routeErrorFrame(
      {
        ...this.host,
        actions: this.actions,
        files: this.files,
        uploads: this.uploads,
        stream: this.stream,
        sends: this.sends,
        outbox: this.outbox,
        maybeAuthLost: (code) => this.maybeAuthLost(code),
      },
      frame,
    )
  }


  private onProtocolMismatch(): void {
    // M4 §7：v 不符 = 客户端太旧/太新，停止重连并提示升级。
    this.patch({
      link: 'failed',
      error: {
        code: 'protocol-version-unsupported',
        message: errorMessage('protocol-version-unsupported'),
        retryable: false,
      },
    })
  }

  private onChannelEnd(): void {
    // 通道断开：在飞的文件读取立刻失败（不这么做每条 pending 都要等自己的 30s 超时）。
    this.files.failAll('连接已断开，请重试')
    // 通道死了：通道内瞬态的提问/审批已经没有应答窗口，重连也不会补撤销帧
    // （真机 2026-10-27 16:07：提问等待期间切后台断线，回来只剩一张点不动的提问卡）。
    //
    // **协商了 `session-state` 就不清了**（WP46 / M6 §2.3）：常驻会话代理会把未决交互
    // 暂存住（断开不再回 next），重连后一份快照就能带回来看/回答；清掉反而会让用户失去
    // 本来还有效的提问卡。未协商（老 Hub）时才走 0.2.15 的兜底。
    if (!this.state.features.includes('session-state')) {
      this.patchState(clearChannelScoped(this.state))
    }
    if (this.state.sessionUsageLoading) {
      this.patch({ sessionUsageLoading: false, sessionUsageError: '连接已断开，请重试' })
    }
  }

  // ── reducer 接线 ────────────────────────────────────────────────────────

  private applyConversation(frame: AnyServerFrame, options: ReduceOptions = {}): void {
    this.commit(reduceConversation({ state: this.state, stream: this.streamState }, frame, options))
  }

  private commit(result: ConversationResult): void {
    this.streamState = result.stream
    if (result.state !== this.state) this.patchState(result.state)
    for (const effect of result.effects) this.applyEffect(effect)
    // pendingSends 是门面持有的（reducer 不碰它）：effect 改完之后再把计数同步进状态。
    if (this.state.pendingSendCount !== this.sends.count) {
      this.patch({ pendingSendCount: this.sends.count })
    }
  }

  private applyEffect(effect: ConversationEffect): void {
    switch (effect.type) {
      case 'pending-settled': {
        // canonical 消息已落地：清掉幂等身份（requestId → clientMessageId 的映射一起）。
        this.sends.settle(effect.clientMessageId)
        return
      }
      case 'history-applied': {
        this.stream.advanceCursor(effect.cursor)
        // 首页回来才有 opening cursor：用它订阅，补齐 (history cursor, follow snapshot] 之间的缝。
        if (effect.beforeSeq == null) {
          this.retries.reset(`history:${effect.sessionId}`)
          this.stream.flushPendingSubscribe(effect.sessionId)
        }
        return
      }
      case 'replay': {
        this.stream.advanceCursor(effect.toCursor)
        this.retries.reset(`subscribe:${effect.sessionId}`)
        // 跟随流已经接上，再要一份最新的会话列表校正回合状态。
        if (effect.needsTurnSync) this.sessions.requestTurnSync()
        return
      }
      case 'session-title': {
        this.patch({
          sessions: this.state.sessions.map((row) =>
            row.sessionId === effect.sessionId ? { ...row, title: effect.title } : row,
          ),
        })
        return
      }
      case 'model-selection': {
        this.actions.applyProjection(effect.sessionId, effect.selection)
        return
      }
    }
  }

  private syncTurnRunning(running: boolean): void {
    this.commit(reduceTurnRunning(this.state, this.streamState, running))
  }

  /** 未决消息的「结果未知」判定（见 `pending-sends.ts`）。 */
  private sweepUnknownPending(): void {
    this.sends.sweep()
  }

  private maybeAuthLost(code: string): void {
    if (code === 'session-expired' || code === 'unauthenticated') {
      this.connection.markManualClose()
      this.opts.onSessionExpired?.()
    }
  }

  // ── 状态提交 ────────────────────────────────────────────────────────────

  private log(event: string, meta?: Record<string, unknown>): void {
    this.opts.log?.(event, meta)
  }

  private fail(code: string, message: string, retryable = false): void {
    this.patch({ error: { code, message, retryable } })
  }

  private patch(partial: Partial<WorkspaceState>): void {
    this.patchState({ ...this.state, ...partial })
  }

  private patchState(next: WorkspaceState): void {
    this.state = next
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state)
      } catch {
        /* ignore listener errors */
      }
    }
    // 每一次状态提交都是发送队列的触发点（连上 / 会话打开 / 上传进度 / 停止结束…）。
    // 队列空时只有几次比较，不影响流式帧。
    this.outbox.pump()
  }
}
