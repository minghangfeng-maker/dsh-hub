/**
 * 门面的**模块装配**：把 `WorkspaceControllerOptions` 和门面的私有回调接成一套模块实例。
 *
 * 放在单独文件里的原因：装配是纯管道（没有业务逻辑），但占篇幅；门面本身要留给
 * 生命周期、公开 API、帧分派和 reducer 接线。
 *
 * 依赖方向（不允许反向）：`wiring` → 各模块 + `workspace-state`；模块之间**不**互相 import。
 */

import { FileCache } from './files.js'
import { RequestRegistry, type RequestFrame } from './requests.js'
import { ChannelRecovery, TransientRetry } from './retry.js'
import { createChannelConnection, type ChannelConnection } from './connection.js'
import { SessionList } from './sessions.js'
import { SessionActions } from './actions.js'
import { ConversationStream } from './conversation-stream.js'
import { FileService, fileRetryConfigOf } from './file-service.js'
import { UploadService } from './upload-service.js'
import { PendingSends } from './pending-sends.js'
import { Outbox } from './outbox.js'
import { ChannelFrames } from './channel-frames.js'
import type { ReduceOptions } from './conversation.js'
import type { AnyServerFrame } from './wire.js'
import type { WorkspaceControllerOptions, WorkspaceState } from './workspace-state.js'

/**
 * 各模块共用的最小上下文（门面实现）。
 *
 * 模块只依赖自己声明的那几个回调；这里把公共部分收成一份，装配时按需 spread ——
 * 既能少写一遍闭包，也不会把这些内部实现暴露成 `WorkspaceController` 的公开方法。
 */
export interface WorkspaceHost {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  patchState(next: WorkspaceState): void
  send(frame: RequestFrame): boolean
  requests: RequestRegistry
  nextRequestId(): string
  now(): number
  log(event: string, meta?: Record<string, unknown>): void
  fail(code: string, message: string, retryable?: boolean): void
  canSend(): boolean
  connectionGeneration(): number
  epoch(): number
  disposed(): boolean
}

/** 门面提供给模块的其余回调（都不在 `WorkspaceHost` 里，只有个别模块用）。 */
export interface WorkspaceWiringCallbacks {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  patchState(next: WorkspaceState): void
  now(): number
  log(event: string, meta?: Record<string, unknown>): void
  fail(code: string, message: string, retryable?: boolean): void
  canSend(): boolean
  epoch(): number
  disposed(): boolean
  handleFrame(frame: AnyServerFrame): void
  applyFrame(frame: AnyServerFrame, options: ReduceOptions): void
  openSession(sessionId: string): void
  syncTurnRunning(running: boolean): void
  sweep(): void
  maybeAuthLost(code: string): void
  onChannelEnd(): void
  onProtocolMismatch(): void
  onConnectionRecovered(): void
}

export interface WorkspaceModules {
  host: WorkspaceHost
  requests: RequestRegistry
  connection: ChannelConnection
  stream: ConversationStream
  sessions: SessionList
  actions: SessionActions
  files: FileService
  uploads: UploadService
  sends: PendingSends
  outbox: Outbox
  frames: ChannelFrames
  retries: TransientRetry
  recovery: ChannelRecovery
  fileCache: FileCache
}

export function createWorkspaceModules(
  options: WorkspaceControllerOptions,
  callbacks: WorkspaceWiringCallbacks,
): WorkspaceModules {
  const fileCache = options.fileCache ?? new FileCache()
  const retries = new TransientRetry()
  const recovery = new ChannelRecovery()

  let connection!: ChannelConnection
  const requests = new RequestRegistry((frame) => connection.send(frame), callbacks.epoch)
  connection = createChannelConnection(options, {
    state: callbacks.state,
    patch: callbacks.patch,
    now: callbacks.now,
    log: callbacks.log,
    onSessionExpired: options.onSessionExpired,
    nextRequestId: () => requests.nextId(),
    beforeParse: callbacks.sweep,
    onFrame: callbacks.handleFrame,
    onProtocolMismatch: callbacks.onProtocolMismatch,
    onMalformed: (type) => callbacks.log('frame-malformed', { type }),
    // connection 在 hello 之后才回调；frames 在下面装配，闭包延迟求值。
    onHello: (frame) => frames.onHello(frame),
    onChannelEnd: callbacks.onChannelEnd,
    onRecovered: callbacks.onConnectionRecovered,
    beforeReconnect: callbacks.sweep,
  })

  const host: WorkspaceHost = {
    state: callbacks.state,
    patch: callbacks.patch,
    patchState: callbacks.patchState,
    send: (frame) => connection.send(frame),
    requests,
    nextRequestId: () => requests.nextId(),
    now: callbacks.now,
    log: callbacks.log,
    fail: callbacks.fail,
    canSend: callbacks.canSend,
    connectionGeneration: () => connection.connectionGeneration,
    epoch: callbacks.epoch,
    disposed: callbacks.disposed,
  }

  const sends = new PendingSends(host)
  const stream = new ConversationStream({
    ...host,
    retry: retries,
    recovery,
    apply: callbacks.applyFrame,
  })
  const sessions: SessionList = new SessionList({
    ...host,
    requestHistory: (sessionId, beforeSeq) => stream.requestHistory(sessionId, beforeSeq),
    openSession: callbacks.openSession,
    applyModelEcho: (model) => actions.applyModelEcho(model),
    syncTurnRunning: callbacks.syncTurnRunning,
    // 发送队列靠这次 create 的 requestId 关联回包（成功/失败都只认它）。
    sessionCreated: (requestId, sessionId) => outbox.onCreateResult(requestId, sessionId),
  })
  const actions = new SessionActions(host)
  const files = new FileService({
    ...host,
    cache: fileCache,
    fileStore: options.fileStore,
    accountKey: options.accountKey,
    retry: fileRetryConfigOf(options.fileRetry),
  })
  const uploads = new UploadService(host)
  /**
   * 发送队列：建会话参数/附件就绪判定/提示/持久化全部来自 `options.outbox`（UI 注入）。
   * 真正写帧走 `sends`（幂等键 = 队列 id）与 `sessions.createSession`。
   */
  const outboxOptions = options.outbox ?? {}
  const outbox = new Outbox({
    state: callbacks.state,
    patch: callbacks.patch,
    createSession: (createOptions) => sessions.createSession(createOptions),
    deliver: (text, sendOptions) => sends.send(text, sendOptions),
    fail: callbacks.fail,
    now: callbacks.now,
    log: callbacks.log,
    ...(outboxOptions.createOptions ? { createOptions: outboxOptions.createOptions } : {}),
    ...(outboxOptions.onCreateFailed ? { onCreateFailed: outboxOptions.onCreateFailed } : {}),
    ...(outboxOptions.attachmentState ? { attachmentState: outboxOptions.attachmentState } : {}),
    ...(outboxOptions.outgoingAttachment ? { outgoingAttachment: outboxOptions.outgoingAttachment } : {}),
    ...(outboxOptions.startUploads ? { startUploads: outboxOptions.startUploads } : {}),
    ...(outboxOptions.retryAttachment ? { retryAttachment: outboxOptions.retryAttachment } : {}),
    ...(outboxOptions.store ? { store: outboxOptions.store } : {}),
    ...(options.accountKey === undefined ? {} : { accountKey: options.accountKey }),
    backendId: options.nodeId,
  })
  const frames = new ChannelFrames({
    ...host,
    nodeId: options.nodeId,
    sessions,
    actions,
    stream,
    sends,
    retries,
    recovery,
    sweep: callbacks.sweep,
    maybeAuthLost: callbacks.maybeAuthLost,
    markManualClose: () => connection.markManualClose(),
  })

  return {
    host,
    requests,
    connection,
    stream,
    sessions,
    actions,
    files,
    uploads,
    sends,
    outbox,
    frames,
    retries,
    recovery,
    fileCache,
  }
}
