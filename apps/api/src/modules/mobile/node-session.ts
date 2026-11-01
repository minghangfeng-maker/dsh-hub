import { randomUUID } from 'node:crypto'
import {
  MOBILE_PROTOCOL_VERSION,
  type MobileClientFrameAll,
  type MobileServerFrameAll,
  type MobileSessionRowV2,
  type MobileV2Feature,
} from '@dsh-hub/shared'
import type { FrameSink, NodeRemote } from '@dsh-hub/dsh-node-remote'

export interface NodeSessionOptions {
  userId: number
  nodeId: string
  /** 该 `(userId,nodeId)` 唯一的 adapter（mux + `$events` 前台身份）。 */
  remote: NodeRemote
  /** 最后一条通道 detach 后的 linger（毫秒）。 */
  lingerMs: number
  /** 有未决交互 / 回合在跑时最多保持多久（毫秒）。 */
  parkMs: number
  log: (event: string, meta?: Record<string, unknown>) => void
  /** NodeSession 自己判定要关闭时回调（注册表据此删表）。 */
  onClosed?: (reason: string) => void
  /**
   * 关闭时通知还挂着的通道（容器停止/登出/设备吊销）：服务层据此给手机发 `bye` 并关 socket，
   * 否则手机要等到下一次请求或心跳超时才知道节点没了。
   */
  onChannelClosed?: (channelId: string, reason: string) => void
  /** 注入时钟（测试用）。 */
  now?: () => number
  /**
   * 服务端 `created` 帧：这条会话是**本会话所属的管理员**刚建的（WP56b 座舱 initiator）。
   * 座舱是多个管理员共享同一个容器，所以「谁开的会话」只能在 Hub 侧按通道记。
   */
  onSessionCreated?: (sessionId: string) => void
  /** 客户端往某个会话发消息（首次即登记发起人；幂等由调用方保证） */
  onSessionTouched?: (sessionId: string) => void
  /** 会话列表行的装饰（座舱节点加 `initiator`；普通节点不传这个钩子） */
  decorateSessionRows?: (items: MobileSessionRowV2[]) => MobileSessionRowV2[]
}

/** 忙碌态（有未决交互或回合在跑）时的复查周期：状态会变，不能一次睡到 park 上限。 */
const BUSY_RECHECK_MS = 5_000
/** 单通道「原 requestId → 内部 id」映射上限（App 的 id 单调递增，长连接会攒）。 */
const MAX_WIRE_IDS_PER_CHANNEL = 1024
/**
 * 入站 requestId 的内部前缀。
 *
 * App 的 requestId 是**每台设备**从 `a1` 起的计数器（`packages/core/src/channel/requests.ts`），
 * 两台设备 / App 被杀重开后旧半开通道还在时，两条通道会同时出现 `a1`、`a5`……
 * 共享 adapter 下这会让「回包按 requestId 路由」把 A 的 history 回包发给 B。
 * 所以入站时改写成通道内唯一的内部 id，出站再改回原 id（**内部 id 永不下发**）。
 */
const WIRE_ID_PREFIX = 'c'
/** 内部 id 记账上限（超过就丢最早的）。 */
const MAX_REQUEST_ROUTES = 4096

interface Attachment {
  id: string
  send: (frame: MobileServerFrameAll) => void
  /** 该通道当前订阅的会话（通道层语义；断开就清空）。 */
  sessions: Set<string>
  /** 客户端在 hello 里声明的特性；null = 老客户端（没声明）。 */
  declaredFeatures: Set<MobileV2Feature> | null
  /** 该通道**实际启用**的特性（服务端 hello 回显过滤后的集合）。 */
  features: Set<MobileV2Feature>
  /** 通道序号（内部 id 用；只增不复用）。 */
  index: number
  /** 原 requestId → 内部 id（同一通道同一个原 id 复用同一个内部 id，重试语义不变）。 */
  wire: Map<string, string>
}

/**
 * 常驻会话代理（WP46 / M6 §1）：每个 `(userId, nodeId)` 至多一个，持有唯一的 adapter。
 *
 * 手机通道只是 attach/detach 的**观察者**：通道关闭 ≠ NodeSession 关闭，因此
 * 「App 切后台 → 通道断开 → DSH 提问被 next」这条事故链在 Hub 侧被切断。
 *
 * 三条不变量：
 * 1. **不是「有人在看」**：本类不碰 `proxy.openClients` / 实例 presence，WP33 的
 *    「无人看时休眠」判定口径不因它改变（回合在跑时容器本来也不会停）。
 * 2. 帧按各通道的订阅分发；`requestId → 通道` 保证回包只回到发起者。
 * 3. 生命周期：最后一条通道 detach 后进入 linger（90s）；有未决交互/回合在跑则保持，
 *    直到结算/结束或 park 上限（30 分钟）；容器停止/登出/设备吊销/Hub 关闭立即关闭
 *    （`close()` 会让 adapter 把未决交互 next 回 Host）。
 */
export class NodeSession {
  readonly id = randomUUID()
  readonly userId: number
  readonly nodeId: string
  private readonly remote: NodeRemote
  private readonly lingerMs: number
  private readonly parkMs: number
  private readonly log: NodeSessionOptions['log']
  private readonly onClosed: ((reason: string) => void) | undefined
  private readonly onChannelClosed: ((channelId: string, reason: string) => void) | undefined
  private readonly now: () => number
  private readonly attachments = new Map<string, Attachment>()
  /** 内部 requestId → 发起通道 + 原 id（回包只回发起者、并把 id 改回去）。 */
  private readonly requestRoutes = new Map<string, { channelId: string; original: string }>()
  /** 会话 → 正在建立跟随流的 subscribe 任务（并发 subscribe 串行化，避免重复建流）。 */
  private readonly subscribeTasks = new Map<string, Promise<void>>()
  private nextChannelIndex = 1
  /** 上一次发给客户端的 running（只在变化时推 session-state）。 */
  private readonly lastRunning = new Map<string, boolean>()
  private closed = false
  private detachedAt: number | null = null
  private reaper: NodeJS.Timeout | null = null
  /** WP56b：座舱会话的发起人钩子（普通节点不传，三个都是 undefined） */
  private readonly onSessionCreated: ((sessionId: string) => void) | undefined
  private readonly onSessionTouched: ((sessionId: string) => void) | undefined
  private readonly decorateSessionRows: ((items: MobileSessionRowV2[]) => MobileSessionRowV2[]) | undefined

  /** 稳定 sink：adapter 的异步帧（`$events` waterfall 等）也走这里，不随通道变化。 */
  private readonly sink: FrameSink = (frame) => {
    this.route(frame as MobileServerFrameAll)
  }

  constructor(options: NodeSessionOptions) {
    this.userId = options.userId
    this.nodeId = options.nodeId
    this.remote = options.remote
    this.lingerMs = options.lingerMs
    this.parkMs = options.parkMs
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
    this.onSessionCreated = options.onSessionCreated
    this.onSessionTouched = options.onSessionTouched
    this.decorateSessionRows = options.decorateSessionRows
    if (options.onClosed !== undefined) this.onClosed = options.onClosed
    if (options.onChannelClosed !== undefined) this.onChannelClosed = options.onChannelClosed
    // 兜底（WP48）：通道的 attach 推迟到 hello 通过之后（P2 硬切要能「不 attach」），
    // 于是「建了会话但一条通道都没挂过」是可达状态。没人 attach 就按 linger 自行收掉，
    // 否则这条 adapter 会一直留在注册表里，永远没人来 detach 触发回收。
    this.detachedAt = this.now()
    this.armReaper()
  }

  get isClosed(): boolean {
    return this.closed
  }

  get attachmentCount(): number {
    return this.attachments.size
  }

  /** 挂上一条通道（同 id 重复挂载是幂等的：新 sink 覆盖旧的）。 */
  attach(channelId: string, send: (frame: MobileServerFrameAll) => void): void {
    if (this.closed) return
    const existing = this.attachments.get(channelId)
    if (existing !== undefined) {
      existing.send = send
    } else {
      this.attachments.set(channelId, {
        id: channelId,
        send,
        sessions: new Set<string>(),
        declaredFeatures: null,
        features: new Set<MobileV2Feature>(),
        index: this.nextChannelIndex,
        wire: new Map<string, string>(),
      })
      this.nextChannelIndex += 1
    }
    this.detachedAt = null
    this.cancelReaper()
    this.log('session.attach', { channelId, channels: this.attachments.size })
  }

  /** 摘掉一条通道：**不关 adapter、不 next 未决交互**，只按 linger/park 规则排期。 */
  detach(channelId: string): void {
    const attachment = this.attachments.get(channelId)
    if (attachment === undefined) return
    this.attachments.delete(channelId)
    for (const sessionId of attachment.sessions) this.maybeReleaseSession(sessionId)
    this.log('session.detach', { channelId, channels: this.attachments.size })
    if (this.attachments.size === 0 && !this.closed) {
      this.detachedAt = this.now()
      this.armReaper()
    }
  }

  hasChannel(channelId: string): boolean {
    return this.attachments.has(channelId)
  }

  /** 会话 → 未决交互数（会话列表 `pendingInteractions` 角标）。 */
  pendingInteractionCounts(): ReadonlyMap<string, number> {
    return this.remote.pendingInteractions?.() ?? new Map<string, number>()
  }

  /**
   * 处理一条通道发来的客户端帧。
   *
   * 除了订阅记账、`hello` 特性求并集、`session-state-request` 由本地直接回包之外，
   * 其余原样交给 adapter —— 语义（answer-question/answer-approval/…）**一行没改**。
   */
  async dispatch(channelId: string, frame: MobileClientFrameAll): Promise<void> {
    const attachment = this.attachments.get(channelId)
    if (this.closed || attachment === undefined) return
    // 入站 requestId 改成「内部唯一」的形式（见 WIRE_ID_PREFIX 的注释）。
    const original = requestIdOf(frame)
    const outgoing =
      original === undefined
        ? frame
        : ({ ...frame, requestId: this.wireRequestId(attachment, original) } as MobileClientFrameAll)

    if (frame.type === 'hello') {
      attachment.declaredFeatures = frame.features === undefined ? null : new Set(frame.features)
    } else if (frame.type === 'subscribe') {
      attachment.sessions.add(frame.sessionId)
      await this.handleSubscribe(channelId, outgoing as Extract<MobileClientFrameAll, { type: 'subscribe' }>)
      return
    } else if (frame.type === 'unsubscribe') {
      attachment.sessions.delete(frame.sessionId)
      // 只有「没有别的通道还订阅它」且「不忙」时才真的把 follow 交回 adapter；
      // 以前直接转发，adapter 会 cancel 掉这条会话唯一的 follow，把别的设备一起打哑。
      this.maybeReleaseSession(frame.sessionId)
      return
    } else if (frame.type === 'session-state-request') {
      // 幂等读：DSH 没有这个概念，Hub 用 adapter 的现状直接回一份（不求订阅）。
      this.emitState(frame.sessionId, { requestId: frame.requestId, channelId })
      return
    }

    // 往某个会话发消息 = 这个管理员参与了这个会话；首次时登记发起人（可见性只在座舱节点）
    if (frame.type === 'send') this.onSessionTouched?.(frame.sessionId)

    // 老客户端（没声明 features）拿到的 hello 必须与 v1 逐字节一致：特性并集只给
    // **协商过**的通道用，老通道在 route() 里会被剥掉 features/capabilitiesV2。
    const upgraded =
      frame.type === 'hello' && attachment.declaredFeatures !== null
        ? { ...outgoing, features: this.unionDeclaredFeatures() }
        : outgoing
    await this.remote.dispatch(upgraded, this.sink)
  }

  /**
   * `subscribe`：会话**已有活着的 follow** 时不重建（重建会拆掉别人正在用的流，
   * 并让已订阅的通道收到重复的 replay/baseline/message）；只给加入者补它自己的一份。
   *
   * 同一会话的并发 subscribe 用 `subscribeTasks` 串行化：否则两条通道可能都看到
   * 「还没有 follow」，第二条把第一条刚建的流拆掉。
   */
  private async handleSubscribe(
    channelId: string,
    frame: Extract<MobileClientFrameAll, { type: 'subscribe' }>,
  ): Promise<void> {
    const sessionId = frame.sessionId
    const previous = this.subscribeTasks.get(sessionId)
    const task = (async (): Promise<void> => {
      if (previous !== undefined) await previous.catch(() => undefined)
      if (this.closed || !this.attachments.has(channelId)) return
      if (this.remote.isFollowing?.(sessionId) === true) {
        await this.joinSession(channelId, frame)
        return
      }
      await this.remote.dispatch(frame, this.sink)
    })()
    this.subscribeTasks.set(sessionId, task)
    try {
      await task
    } finally {
      if (this.subscribeTasks.get(sessionId) === task) this.subscribeTasks.delete(sessionId)
    }
  }

  /**
   * 给**加入者**补一份它自己的基线序列（M6 §2.2.1 的 replay 边界也在这里给）。
   *
   * 帧只发给这条通道：catch-up 的 `message`、`replay`、`assistant-baseline`、
   * 白名单投影 `state`、未决提问 `question`、最后一份 `session-state`。
   * 已订阅的其它通道**一个字节都收不到**（App 的 `onReplay` 会 `clearChannelScoped`
   * 清掉瞬态状态，重复给它们发等于打断正在看的人）。
   */
  private async joinSession(
    channelId: string,
    frame: Extract<MobileClientFrameAll, { type: 'subscribe' }>,
  ): Promise<void> {
    const sessionId = frame.sessionId
    const send = (out: MobileServerFrameAll): void => {
      this.attachments.get(channelId)?.send(out)
    }
    const requestId = this.originalOf(frame.requestId)
    const sinceCursor = frame.sinceCursor ?? null
    const cursor = this.remote.sessionState?.(sessionId)?.cursor ?? null
    if (sinceCursor !== null && cursor !== null && sinceCursor < cursor) {
      let outcome: 'ok' | 'gap' = 'gap'
      if (this.remote.catchUpFor !== undefined) {
        try {
          outcome = await this.remote.catchUpFor(sessionId, sinceCursor, (out) => {
            send(out as MobileServerFrameAll)
          })
        } catch {
          outcome = 'gap'
        }
      }
      if (outcome === 'gap') {
        // 追不到就要求这个客户端全量重载：只回给它（带它的 requestId），不动共享 follow。
        // 同时撤掉它的订阅 —— 没有 replay 边界就不该继续收实时帧（和老 adapter 的语义一致）。
        this.attachments.get(channelId)?.sessions.delete(sessionId)
        send({
          v: MOBILE_PROTOCOL_VERSION,
          type: 'error',
          ...(requestId === undefined ? {} : { requestId }),
          code: 'upstream-unavailable',
          message: 'catch-up-incomplete: 断线期间消息超出有界追赶范围，请重新拉取历史',
          retryable: true,
        })
        // 如果它是唯一的订阅者，把 follow 交回 adapter（忙的话 maybeReleaseSession 会留着）
        this.maybeReleaseSession(sessionId)
        return
      }
    }
    send({ v: MOBILE_PROTOCOL_VERSION, type: 'replay', sessionId, fromCursor: sinceCursor, toCursor: cursor ?? 0 })
    const baseline = this.remote.sessionBaseline?.(sessionId) ?? null
    if (baseline !== null) send(baseline as MobileServerFrameAll)
    for (const projection of this.remote.sessionProjections?.(sessionId) ?? []) {
      send({
        v: MOBILE_PROTOCOL_VERSION,
        type: 'state',
        sessionId,
        key: projection.key,
        value: projection.value,
        seq: null,
      })
    }
    const state = this.remote.sessionState?.(sessionId)
    for (const question of state?.questions ?? []) {
      send({
        v: MOBILE_PROTOCOL_VERSION,
        type: 'question',
        sessionId,
        agent: question.agent,
        callId: question.callId,
        questions: question.questions,
        state: question.state,
      })
    }
    this.emitState(sessionId, { channelId })
  }

  /** 当前快照（`session-state` 帧本体；`requestId` 只在回包时带）。 */
  stateFrame(sessionId: string, requestId?: string): MobileServerFrameAll {
    const state = this.remote.sessionState?.(sessionId)
    return {
      v: MOBILE_PROTOCOL_VERSION,
      type: 'session-state',
      ...(requestId === undefined ? {} : { requestId }),
      sessionId,
      cursor: state?.cursor ?? null,
      running: state?.running === true,
      attemptId: state?.attemptId ?? null,
      // M6 §2.1 的上限：questions/approvals 各 ≤16（超出的用户也没法在手机上处理）
      questions: (state?.questions ?? []).slice(0, 16),
      approvals: (state?.approvals ?? []).slice(0, 16),
      at: new Date(this.now()).toISOString(),
    }
  }

  /**
   * 关闭 NodeSession：先把未决交互交还 Host（adapter 的 `close()` 会 next，绝不自动批准），
   * 再摘掉所有通道。
   */
  async close(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelReaper()
    // 先记下还挂着的通道再清表：它们要收到 `bye`（容器停止/登出/被吊销时手机会停在
    // 「还连着」的假状态里，等下一次请求才发现节点没了）
    const attached = [...this.attachments.keys()]
    this.attachments.clear()
    this.requestRoutes.clear()
    this.subscribeTasks.clear()
    this.lastRunning.clear()
    for (const channelId of attached) {
      try {
        this.onChannelClosed?.(channelId, reason)
      } catch (error) {
        this.log('session.channel-close-failed', {
          channelId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.log('session.close', { reason })
    try {
      await this.remote.close()
    } catch (error) {
      this.log('session.close-failed', { message: error instanceof Error ? error.message : String(error) })
    }
    this.onClosed?.(reason)
  }

  // ── 帧路由 ────────────────────────────────────────────────────────────────

  private route(frame: MobileServerFrameAll): void {
    if (this.closed) return
    // 带 requestId 的帧：内部 id → 发起通道 + 原 id。内部 id 绝不外泄。
    const wireId = requestIdOf(frame)
    const route = wireId === undefined ? undefined : this.requestRoutes.get(wireId)
    const deliver: MobileServerFrameAll =
      route === undefined
        ? wireId === undefined
          ? frame
          : (stripRequestId(frame) as MobileServerFrameAll)
        : ({ ...frame, requestId: route.original } as MobileServerFrameAll)
    const channelId = route?.channelId
    const sessionId = sessionIdOf(deliver)

    // 新建会话的回执：这条会话的发起人就是本通道的管理员（座舱共享列表要标出来）
    if (deliver.type === 'created') this.onSessionCreated?.(deliver.sessionId)

    if (deliver.type === 'hello') {
      const attachment = channelId === undefined ? undefined : this.attachments.get(channelId)
      const declared = attachment?.declaredFeatures ?? null
      // 老客户端：与 v1 逐字节一致（不因为同节点上还有新客户端就突然带 v2 字段）
      const v2ForChannel =
        attachment !== undefined && declared !== null
          ? this.filterFeatures(deliver.features, declared)
          : undefined
      const patched: MobileServerFrameAll =
        attachment === undefined
          ? deliver
          : {
              ...deliver,
              subscribed: [...attachment.sessions],
              ...(v2ForChannel === undefined
                ? { features: undefined, capabilitiesV2: undefined }
                : { features: v2ForChannel }),
            }
      if (attachment !== undefined) {
        attachment.features = new Set<MobileV2Feature>(
          ((patched as { features?: MobileV2Feature[] }).features ?? []).filter(isV2Feature),
        )
      }
      this.sendToChannel(channelId, stripUndefined(patched) as MobileServerFrameAll)
      return
    }

    if (deliver.type === 'sessions') {
      // 节点级装饰（WP56b：座舱会话加 initiator）对**所有**客户端都加，与协商的特性无关；
      // pendingInteractions 仍然只给协商了 session-state 的通道（M6 §2.4：老 App 帧流不变）。
      const decoratedItems = this.applySessionDecorators(deliver.items)
      const decorated = { ...deliver, items: decoratedItems } as MobileServerFrameAll
      const attachment = channelId === undefined ? undefined : this.attachments.get(channelId)
      if (attachment === undefined) {
        const withPending = {
          ...decorated,
          items: this.withPendingInteractions(decoratedItems),
        } as MobileServerFrameAll
        for (const item of this.attachments.values()) {
          item.send(item.features.has('session-state') ? withPending : decorated)
        }
        return
      }
      const withPending = attachment.features.has('session-state')
        ? ({ ...decorated, items: this.withPendingInteractions(decoratedItems) } as MobileServerFrameAll)
        : decorated
      this.sendToChannel(channelId, withPending)
      return
    }

    if (route !== undefined) {
      // 请求回包（`ack`/`error`/`history`/`models`/`file-chunk`…）：只回发起通道。
      this.sendToChannel(route.channelId, deliver)
      // 只有「会话子集」的帧才需要额外推快照（回包类帧不影响会话状态）
      if (sessionId !== null && deliver.type === 'stopped') this.emitState(sessionId)
      return
    }

    if (sessionId !== null) {
      this.sendToSession(sessionId, deliver)
      if (deliver.type === 'replay') {
        // M6 §2.2.1：`replay` 边界帧之后立刻给订阅该会话的通道发一份快照
        this.emitState(sessionId)
      } else if (deliver.type === 'turn') {
        this.emitStateOnRunningChange(sessionId)
      } else if (
        deliver.type === 'question' ||
        deliver.type === 'question-settled' ||
        deliver.type === 'approval' ||
        deliver.type === 'approval-settled'
      ) {
        // M6 §2.2.3：未决集合变化就发（新增/结算/过期）
        this.emitState(sessionId)
      }
      return
    }

    // 既没有 requestId 也没有 sessionId（`capability` / `pong` 等）：广播给所有通道。
    for (const attachment of this.attachments.values()) attachment.send(deliver)
  }

  private sendToChannel(channelId: string | undefined, frame: MobileServerFrameAll): void {
    if (channelId === undefined) {
      for (const attachment of this.attachments.values()) attachment.send(frame)
      return
    }
    this.attachments.get(channelId)?.send(frame)
  }

  private sendToSession(sessionId: string, frame: MobileServerFrameAll): void {
    for (const attachment of this.attachments.values()) {
      if (!attachment.sessions.has(sessionId)) continue
      attachment.send(frame)
    }
  }

  /** 发一份 `session-state`；`channelId` 给定时只发给该通道（`session-state-request` 回包）。 */
  private emitState(
    sessionId: string,
    options: { requestId?: string; channelId?: string } = {},
  ): void {
    const frame = this.stateFrame(sessionId, options.requestId)
    const running = (frame as { running: boolean }).running
    this.lastRunning.set(sessionId, running)
    for (const [channelId, attachment] of this.attachments) {
      if (options.channelId !== undefined && channelId !== options.channelId) continue
      if (!attachment.features.has('session-state')) continue
      if (options.channelId === undefined && !attachment.sessions.has(sessionId)) continue
      attachment.send(frame)
    }
  }

  private emitStateOnRunningChange(sessionId: string): void {
    const next = this.remote.sessionState?.(sessionId)?.running === true
    const previous = this.lastRunning.get(sessionId)
    if (previous === next) return
    this.emitState(sessionId)
  }

  /** 会话行的节点级装饰（座舱节点加 `initiator`）；没有钩子时原样返回。 */
  private applySessionDecorators(items: MobileSessionRowV2[]): MobileSessionRowV2[] {
    return this.decorateSessionRows === undefined ? items : this.decorateSessionRows(items)
  }

  private withPendingInteractions(items: MobileSessionRowV2[]): MobileSessionRowV2[] {
    const counts = this.pendingInteractionCounts()
    if (counts.size === 0) return items
    return items.map((item) => {
      const count = counts.get(item.sessionId) ?? 0
      return count > 0 ? { ...item, pendingInteractions: count } : item
    })
  }

  // ── 订阅释放 / 生命周期 ───────────────────────────────────────────────────

  private subscribedByAnyone(sessionId: string): boolean {
    for (const attachment of this.attachments.values()) {
      if (attachment.sessions.has(sessionId)) return true
    }
    return false
  }

  /**
   * 某个会话已经没人订阅、且**不忙**（没有未决交互、没有回合在跑）时，才把 follow
   * 交回 adapter —— 只有这时 `unsubscribe` 是安全的。
   *
   * 反过来：还有别的通道订阅（或会话在跑/有提问挂着）就**不动**这条 follow。
   * 以前每个通道一个 adapter，`unsubscribe` 只影响自己；现在一条 follow 服务所有通道，
   * 直接转发会把另一台设备正在看的流一起 cancel 掉。
   */
  private maybeReleaseSession(sessionId: string): void {
    if (this.closed || this.subscribedByAnyone(sessionId)) return
    const state = this.remote.sessionState?.(sessionId)
    if (state !== undefined && (state.running || state.questions.length > 0 || state.approvals.length > 0)) return
    if (this.remote.isFollowing?.(sessionId) === false) return
    void this.remote.dispatch({ v: 1, type: 'unsubscribe', sessionId }, this.sink).catch((error: unknown) => {
      this.log('session.unsubscribe-failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private isBusy(): boolean {
    const pending = this.remote.pendingInteractions?.()
    if (pending !== undefined && pending.size > 0) return true
    const running = this.remote.runningSessions?.()
    return running !== undefined && running.length > 0
  }

  private armReaper(): void {
    this.cancelReaper()
    if (this.closed || this.attachments.size > 0) return
    const timer = setTimeout(() => {
      this.reaper = null
      this.reap()
    }, this.nextReapDelay())
    timer.unref?.()
    this.reaper = timer
  }

  private cancelReaper(): void {
    if (this.reaper !== null) {
      clearTimeout(this.reaper)
      this.reaper = null
    }
  }

  private nextReapDelay(): number {
    const detachedAt = this.detachedAt ?? this.now()
    const busy = this.isBusy()
    const remaining = Math.max(0, detachedAt + (busy ? this.parkMs : this.lingerMs) - this.now())
    // 忙碌态随时可能结算：定期复查，别一次睡到 park 上限
    return busy ? Math.min(remaining, BUSY_RECHECK_MS) : remaining
  }

  private reap(): void {
    if (this.closed || this.attachments.size > 0) return
    const detachedAt = this.detachedAt ?? this.now()
    if (this.isBusy()) {
      if (this.now() - detachedAt >= this.parkMs) {
        void this.close('park-limit')
        return
      }
      this.armReaper()
      return
    }
    if (this.now() - detachedAt >= this.lingerMs) {
      void this.close('linger')
      return
    }
    this.armReaper()
  }

  // ── 记账小工具 ────────────────────────────────────────────────────────────

  /**
   * 把客户端给的 requestId 换成内部唯一 id（`c<通道序号>:<原 id>`）。
   *
   * 同一通道同一个原 id 复用同一个内部 id：App 重试同一请求时语义不变（adapter 侧
   * 不会因为「id 变了」而当成另一个请求）。内部 id 只在 Hub 进程内流转，回包时改回原 id，
   * 所以 `MobileRequestIdSchema`（≤64）约束的仍是客户端自己的 id。
   */
  private wireRequestId(attachment: Attachment, original: string): string {
    const cached = attachment.wire.get(original)
    if (cached !== undefined) {
      // 全局表可能已经淘汰过这一条（容量上限）：重新登记，保证回包还能认出来
      if (!this.requestRoutes.has(cached)) {
        this.requestRoutes.set(cached, { channelId: attachment.id, original })
      }
      return cached
    }
    const wire = `${WIRE_ID_PREFIX}${String(attachment.index)}:${original}`
    attachment.wire.set(original, wire)
    this.requestRoutes.set(wire, { channelId: attachment.id, original })
    // 两条链都有界：超了就丢自己最旧的一条（App 的 id 单调递增，旧的不会再回来）
    while (attachment.wire.size > MAX_WIRE_IDS_PER_CHANNEL) {
      const oldest = attachment.wire.keys().next()
      if (oldest.done) break
      const stale = attachment.wire.get(oldest.value)
      attachment.wire.delete(oldest.value)
      if (stale !== undefined) this.requestRoutes.delete(stale)
    }
    while (this.requestRoutes.size > MAX_REQUEST_ROUTES) {
      const oldest = this.requestRoutes.keys().next()
      if (oldest.done) break
      this.requestRoutes.delete(oldest.value)
    }
    return wire
  }

  /** 内部 id → 原 id（合成帧/错误回包要带客户端认识的那个 id）。 */
  private originalOf(wireId: string | undefined): string | undefined {
    return wireId === undefined ? undefined : this.requestRoutes.get(wireId)?.original
  }

  private unionDeclaredFeatures(): MobileV2Feature[] {
    const union = new Set<MobileV2Feature>()
    for (const attachment of this.attachments.values()) {
      for (const feature of attachment.declaredFeatures ?? []) union.add(feature)
    }
    return [...union]
  }

  private filterFeatures(
    enabled: readonly MobileV2Feature[] | undefined,
    declared: ReadonlySet<MobileV2Feature>,
  ): MobileV2Feature[] {
    if (enabled === undefined) return []
    return enabled.filter((feature) => declared.has(feature))
  }
}

/**
 * `(userId,nodeId)` → NodeSession 的注册表（WP46 / M6 §1）。
 *
 * 单独成类是为了让「容器停止/登出/设备吊销/Hub 关闭 → 立即关闭」这条**服务层接线**
 * 有一个可单测的落点：服务模块只负责把事件转成 `closeUser/closeAll` 调用。
 */
type RegistryOptions = Pick<NodeSessionOptions, 'lingerMs' | 'parkMs' | 'log' | 'now' | 'onChannelClosed'>

export class NodeSessionRegistry {
  private readonly sessions = new Map<string, NodeSession>()
  private readonly opening = new Map<string, Promise<NodeSession | null>>()
  private readonly options: RegistryOptions

  constructor(options: RegistryOptions) {
    this.options = options
  }

  private keyOf(userId: number, nodeId: string): string {
    return `${String(userId)}:${nodeId}`
  }

  get(userId: number, nodeId: string): NodeSession | undefined {
    const session = this.sessions.get(this.keyOf(userId, nodeId))
    return session === undefined || session.isClosed ? undefined : session
  }

  list(): NodeSession[] {
    return [...this.sessions.values()]
  }

  /**
   * 取（或建）该 `(userId,nodeId)` 唯一的 NodeSession；`open` 返回值即 adapter。
   *
   * 并发首连只建一个 adapter（同一个 Promise 给所有等待者）。
   */
  async ensure(
    userId: number,
    nodeId: string,
    open: () => Promise<NodeRemote | null>,
  ): Promise<NodeSession | null> {
    const key = this.keyOf(userId, nodeId)
    const existing = this.get(userId, nodeId)
    if (existing !== undefined) return existing
    const inflight = this.opening.get(key)
    if (inflight !== undefined) return await inflight
    const task = (async (): Promise<NodeSession | null> => {
      const remote = await open()
      if (remote === null) return null
      const session: NodeSession = new NodeSession({
        userId,
        nodeId,
        remote,
        lingerMs: this.options.lingerMs,
        parkMs: this.options.parkMs,
        log: this.options.log,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
        ...(this.options.onChannelClosed === undefined
          ? {}
          : { onChannelClosed: this.options.onChannelClosed }),
        onClosed: (reason) => {
          if (this.sessions.get(key) === session) this.sessions.delete(key)
          this.options.log('session.closed', { userId, reason })
        },
      })
      this.sessions.set(key, session)
      this.options.log('session.opened', { userId, nodeId })
      return session
    })()
    this.opening.set(key, task)
    try {
      return await task
    } finally {
      this.opening.delete(key)
    }
  }

  /**
   * 立即关闭该用户在**某一个节点**上的会话（WP56b：管理员登出/降级的座舱通道）。
   * 只影响 `(userId, nodeId)` 这一个，别的节点上的会话照常。
   */
  async closeNode(userId: number, nodeId: string, reason: string): Promise<void> {
    const key = this.keyOf(userId, nodeId)
    const session = this.sessions.get(key)
    if (session === undefined) return
    this.sessions.delete(key)
    await session.close(reason)
  }

  /** 立即关闭该用户的全部会话（容器停止/被休眠、登出、设备吊销）。 */
  async closeUser(userId: number, reason: string): Promise<void> {
    const closing: Promise<void>[] = []
    for (const [key, session] of [...this.sessions]) {
      if (session.userId !== userId) continue
      this.sessions.delete(key)
      closing.push(session.close(reason))
    }
    await Promise.all(closing)
  }

  /** Hub 关闭：全部会话立即关闭（adapter 的 `close()` 会把未决交互 next 回 Host）。 */
  async closeAll(reason: string): Promise<void> {
    const closing = [...this.sessions.values()].map((session) => session.close(reason))
    this.sessions.clear()
    await Promise.all(closing)
  }
}

function isV2Feature(value: unknown): value is MobileV2Feature {
  return typeof value === 'string'
}

function requestIdOf(frame: MobileClientFrameAll | MobileServerFrameAll): string | undefined {
  const value = (frame as { requestId?: unknown }).requestId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function sessionIdOf(frame: MobileServerFrameAll): string | null {
  const value = (frame as { sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : null
}

/** 剥掉 requestId（内部 id 绝不下发；认不出归属的帧按无 requestId 处理）。 */
function stripRequestId(frame: MobileServerFrameAll): MobileServerFrameAll {
  const record = { ...(frame as unknown as Record<string, unknown>) }
  delete record['requestId']
  return record as unknown as MobileServerFrameAll
}

/** 把 `{features: undefined}` 去掉，避免给老客户端塞一个值为 undefined 的键。 */
function stripUndefined(frame: MobileServerFrameAll): MobileServerFrameAll {
  const record = { ...(frame as unknown as Record<string, unknown>) }
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]
  return record as unknown as MobileServerFrameAll
}
