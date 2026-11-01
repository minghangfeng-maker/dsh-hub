/**
 * 通道级帧的处理：`hello` 协商、`capability` 合并、`node-status`、`bye`、`ack`、
 * `answer-result`。这些帧不属于任何一个「会话页面」，但都有各自的时序坑：
 *
 *  - **hello**：v1 的 8 个能力位 + v2 的 7 个可选位摊平成一层（UI 只问「有没有这个能力」）；
 *    每次 hello 都要清掉上一代通道排的瞬态重试，并按需重新拉首页/订阅/模型目录。
 *    `connectionGeneration` 由连接层自增，这里只负责业务侧复位。
 *  - **capability**：**合并而不是替换**——Hub 之后还会发 v1 形状的能力帧（DSH 能力刷新），
 *    直接替换会把 v2 位抹掉（真实集成环境实测：filesRead/filesUpload 变 false，
 *    文件卡的「保存」与上传入口跟着消失）。
 *  - **node-status**：不可连接要给具体原因（M4 §3.1），发送入口据此提示。
 *  - **bye**：登录失效（`session-expired`）要回登录页并停止重连。
 *  - **ack**：只代表 Host 已接受（不落库），气泡的「已发送」由 `pending-sends` 结算。
 *  - **answer-result**：`continued=false` 时按 `callId` 撤掉提问卡。
 */

import type { SessionList } from './sessions.js'
import type { SessionActions } from './actions.js'
import type { ConversationStream } from './conversation-stream.js'
import type { PendingSends } from './pending-sends.js'
import type { RequestRegistry } from './requests.js'
import type { TransientRetry, ChannelRecovery } from './retry.js'
import { blockedReasonText, errorMessage } from '../errors.js'
import { withoutQuestion } from './conversation.js'
import type { MobileHelloV2, MobileNodeCapabilitiesFull, MobileNodeCapabilitiesV2 } from '../contracts/mobile-v2.js'
import type { FrameOf, WorkspaceState } from './workspace-state.js'

export interface ChannelFramesDeps {
  nodeId: string
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  patchState(next: WorkspaceState): void
  requests: RequestRegistry
  sessions: SessionList
  actions: SessionActions
  stream: ConversationStream
  sends: PendingSends
  retries: TransientRetry
  recovery: ChannelRecovery
  /** 未决消息的「结果未知」判定。 */
  sweep(): void
  /** 登录/设备失效：停止重连 + 回登录页。 */
  maybeAuthLost(code: string): void
  markManualClose(): void
}

export class ChannelFrames {
  /**
   * v2 能力位（hello.capabilitiesV2）。
   *
   * 单独存一份：Hub 之后还会发 v1 形状的 `capability` 帧（DSH 能力刷新），那帧只有 8 个
   * v1 位；直接替换 `state.capabilities` 会把 v2 位抹掉。
   */
  private capabilitiesV2: MobileNodeCapabilitiesV2 | null = null
  /** answer 请求 → callId（`answer-result` 只带 requestId）。 */
  private readonly answerRequests = new Map<string, string>()

  constructor(private readonly deps: ChannelFramesDeps) {}

  onHello(frame: MobileHelloV2): void {
    // 新连接：旧连接上排的瞬态重试没意义了（open 会话会按需重新拉首页/订阅）。
    this.deps.retries.clearAll()
    this.deps.recovery.clear()
    const features = frame.features ?? []
    this.capabilitiesV2 = { ...(frame.capabilitiesV2 ?? {}) }
    const capabilities: MobileNodeCapabilitiesFull = { ...frame.capabilities, ...this.capabilitiesV2 }
    this.deps.patch({ link: 'connected', capabilities, features, reconnectAttempt: 0, error: null })
    // 这一份（且只有这一份）会话列表用于重连后的回合状态校正。
    this.deps.sessions.requestTurnSync()
    const open = this.deps.state().openSessionId
    // 打开中的会话：有消息就立刻带 lastCursor 续看；没消息（冷启动/深链进会话）先拉首页
    // 再订阅，理由见 conversation-stream（history→follow 的游标缝）。
    if (open != null) this.deps.stream.open(open)
    // v2：连上后主动拉一次模型目录（服务端没回显 feature 时这里不会发）。
    if (features.includes('models')) this.deps.actions.requestModels(open)
    // 重连成功即核对未决消息：跨越连接的未决一律标「结果未知」，等 ack/message 收敛。
    this.deps.sweep()
  }

  onCapability(frame: FrameOf<'capability'>): void {
    // 合并而不是替换：v1 的 capability 帧不含 v2 位，抹掉会让文件/上传入口凭空消失。
    this.deps.patch({ capabilities: { ...frame.capabilities, ...(this.capabilitiesV2 ?? {}) } })
  }

  onNodeStatus(frame: FrameOf<'node-status'>): void {
    if (frame.node.id !== this.deps.nodeId) return
    const reason = frame.node.reason ? blockedReasonText(frame.node.reason) : null
    this.deps.patch({
      nodeConnectable: frame.node.connectable,
      nodeBlockedReason: frame.node.connectable ? null : reason,
      error: frame.node.connectable
        ? this.deps.state().error
        : {
            code: 'node-not-connectable',
            message: reason ?? errorMessage('node-not-connectable'),
            retryable: false,
          },
    })
  }

  onBye(frame: FrameOf<'bye'>): void {
    this.deps.markManualClose()
    this.deps.patch({
      link: 'closed',
      error: {
        code: frame.code || 'internal',
        message: frame.reason || errorMessage(frame.code),
        retryable: false,
      },
    })
    this.deps.maybeAuthLost(frame.code)
  }

  onAck(frame: FrameOf<'ack'>): void {
    this.deps.requests.delete(frame.requestId)
    this.deps.sends.onAck(frame)
  }

  onAnswerResult(frame: FrameOf<'answer-result'>): void {
    this.deps.requests.delete(frame.requestId)
    if (frame.sessionId !== this.deps.state().openSessionId) return
    const callId = this.answerRequests.get(frame.requestId)
    this.answerRequests.delete(frame.requestId)
    if (!frame.continued && callId) {
      this.deps.patchState(withoutQuestion(this.deps.state(), callId))
    }
  }

  /** 记录一次 answer 请求（`answer-result` 只带 requestId，需要回指 callId）。 */
  rememberAnswer(requestId: string, callId: string): void {
    this.answerRequests.set(requestId, callId)
  }
}
