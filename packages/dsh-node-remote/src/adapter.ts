import { HostHttp, HostRpcError, HostTransportError } from './http.js'
import { MuxConnection, type MuxFrameError } from './mux.js'
import { V2Handler } from './v2/handler.js'
import { truncateUtf8 } from './v2/text.js'
import {
  NodeRemoteIncompatibleError,
  NodeRemoteProbeError,
  type ApprovalView,
  type FrameSink,
  type HistoryItem,
  type MobileClientFrame,
  type MobileErrorCode,
  type MobileServerFrame,
  type NodeCapabilities,
  type NodeRemote,
  type NodeProbeResult,
  type MobileV2Feature,
  type NodeCapabilitiesV2,
  type NodeRemoteOptions,
  type PendingQuestionView,
  type Question,
  type SessionRow,
  type SessionRowV2,
  type SessionRuntimeState,
} from './types.js'

/**
 * 未决交互暂存上限的缺省值（WP46 / M6 §1）：30 分钟。
 *
 * 与 Hub 的 `HUB_MOBILE_INTERACTION_PARK_MS` 同义；Hub 显式传值，这里只是
 * 「直接 new adapter 的调用方（测试/桌面）」的兜底。
 */
export const DEFAULT_INTERACTION_PARK_MS = 30 * 60_000

/** 「加入者补发」缓存最多记多少个会话（投影/基线各一份，超出丢最旧的）。 */
const MAX_CACHED_SESSIONS = 128

/** 端点不存在。 */
const MISSING_ENDPOINT_CODES = new Set([
  'gateway/method-unavailable',
  'gateway/definition-unavailable',
  'gateway/endpoint-unavailable',
])

/**
 * 只有**参数/信封校验拒绝**能证明端点存在（Host 在业务调用前拒绝）。
 * 其余一切（401、remote-access/denied、transport、internal）都是探测失败，必须 fail closed。
 */
const VALIDATION_REJECTION_CODES = new Set([
  'gateway/arguments-invalid',
  'gateway/input-invalid',
  'gateway/bad-request',
  'gateway/signature-invalid',
])

/**
 * adapter 自己产生的 v2 错误码：它们已经在手机错误码白名单里，`classify` 直接透传。
 * `model-unavailable` 例外地标成 retryable（App 重拉 models 再试）。
 */
const V2_PASSTHROUGH_CODES = new Map<string, MobileErrorCode>([
  ['model-unavailable', 'model-unavailable'],
  ['effort-unsupported', 'effort-unsupported'],
  ['preset-not-found', 'preset-not-found'],
  ['title-invalid', 'title-invalid'],
  ['file-not-found', 'file-not-found'],
  ['file-refused', 'file-refused'],
  ['file-too-large', 'file-too-large'],
  ['file-not-text', 'file-not-text'],
  ['archive-unsupported', 'archive-unsupported'],
  ['rename-unsupported', 'rename-unsupported'],
  ['feature-unsupported', 'feature-unsupported'],
])

type ProbeVerdict = 'present' | 'missing' | 'failed'

function classifyProbeError(code: string): ProbeVerdict {
  if (MISSING_ENDPOINT_CODES.has(code)) return 'missing'
  if (VALIDATION_REJECTION_CODES.has(code)) return 'present'
  return 'failed'
}

/** 投影白名单：只把这些键推给手机（其余键一律丢弃）。 */
const STATE_KEYS = new Set(['title', 'modelSelection', 'permissions', 'plan', 'goal', 'inbox', 'todos'])

interface FollowHandle {
  streamId: string
  cursor: number | null
  /** 已经流过的最大事件 seq：`session/page` 的 throughSeq 必须用它（不能停在 opening cursor）。 */
  latestSeq: number
  ended: boolean
  /** opening snapshot 的 cursor；`session/page` 依赖它，必须等而不是猜 null。 */
  cursorReady: Promise<number | null>
  resolveCursor: (cursor: number | null) => void
  /**
   * 打开这条 follow 的那次 `subscribe.requestId`（WP46）。
   *
   * 用途：断线追赶失败（catch-up-incomplete）这类**只与发起者有关**的错误必须带上它，
   * 共享 adapter 才能只回给发起 subscribe 的那条通道，而不是广播给所有订阅者。
   */
  requestId: string
}

/**
 * DSH Host 的薄 adapter：手机帧 ↔ Host 的 HTTP unary + `/api/remote.mux` 流。
 *
 * 只做翻译，不做鉴权、不做归属、不做限流（那三件在 Hub 的通道层）。
 * 所有方法都不缓存会话正文；`close()` 之后不再持有任何流。
 */
class RemoteAdapter implements NodeRemote {
  capabilities: NodeCapabilities
  readonly compatible: boolean
  readonly missing: readonly string[]
  readonly node: NodeRemoteOptions['node']

  private readonly options: NodeRemoteOptions
  private readonly http: HostHttp
  private readonly mux: MuxConnection
  private readonly follows = new Map<string, FollowHandle>()
  private readonly subscribed = new Set<string>()
  /**
   * sessionId → (callId → 题目/状态)：仍可回答的投影问答（来自 control 投影 / follow 快照）。
   * WP46 把它从 `Set<callId>` 升级为带题目，`session-state` 才能把 `continued` 问题也带上。
   */
  private readonly openQuestions = new Map<string, Map<string, { questions: Question[]; state: 'open' | 'continued' }>>()
  /**
   * `$events` 上未结算的前台提问：`${sessionId}:${callId}` → eventId/题目/claim/超时。
   *
   * `parkMs !== null` 时还带一个 park 上限计时器（到点 next）；老行为下 `timer` 只用于
   * 「timed 提问由 Host deadline 决定」的清理，不另设 120 秒假延长。
   */
  private readonly pendingQuestions = new Map<
    string,
    {
      eventId: string
      sessionId: string
      callId: string
      questions: Question[]
      timer: NodeJS.Timeout | null
      hold: (() => void) | null
    }
  >()
  /** 已确认的 `userQuestions/answer` agent 参数名（安装 runtime=agent / 新 src=agentId）。 */
  private questionAgentParam: 'agent' | 'agentId' | null = null
  private control: { streamId: string } | null = null
  /** `$events` 代次：ready 帧里的 clientId + 订阅清理。 */
  private events: { streamId: string; clientId: string } | null = null
  private eventsOpening: Promise<boolean> | null = null
  /** eventId → 未结算审批（含超时后 next 的计时器；park 模式下超时 = parkMs）。 */
  private readonly pendingApprovals = new Map<
    string,
    {
      approvalId: string
      sessionId: string
      agentId: string
      timer: NodeJS.Timeout
      /** 发出过的 `approval` 视图：`session-state` 快照要用同一份形状。 */
      approval: ApprovalView
    }
  >()
  /**
   * WP46 常驻会话代理：非 null = 未决交互暂存（通道断开/未订阅都不 next），值为 park 上限。
   * null = 现有行为（桌面端、探针与所有老调用方）。
   */
  private readonly parkMs: number | null
  /** sessionId → 回合态（`session-state` 的权威来源；由事件 / follow 快照 / session/list 维护）。 */
  private readonly runtime = new Map<
    string,
    { running: boolean; attemptId: string | null; cursor: number | null }
  >()
  /**
   * sessionId → 最近一次推给客户端的 `assistant-baseline`（WP46）。
   *
   * 多通道共享一条 follow 时，「加入者」拿不到别人订阅时发过的基线；Hub 的
   * NodeSession 用它给新加入的通道补一份，否则加入者只能看到后续 delta 的残片。
   */
  private readonly baselines = new Map<string, Extract<MobileServerFrame, { type: 'assistant-baseline' }>>()
  /** sessionId → 最近一次的白名单投影值（加入者补 `state` 帧用）。 */
  private readonly projections = new Map<string, Map<string, unknown>>()
  /** 当前通道的帧出口：`$events` 的异步 waterfall 也推到这里。 */
  private sink: FrameSink | null = null
  /** 最近一次取 cursor 的临时 follow 为什么结束（排障用，进错误文案）。 */
  private cursorFailure: string | null = null
  private closed = false
  /** v2 的全部新行为（模型/工具/文件/上传/归档）；老客户端不会触碰它。 */
  private readonly v2: V2Handler
  /** `assistant-stream.start` 的 turn/step：v1 曾恒为 null，v2 填进每个 delta。 */
  private readonly attempts = new Map<string, { turn: number | null; step: number | null }>()

  constructor(options: NodeRemoteOptions, capabilities: NodeCapabilities, missing: string[]) {
    this.options = options
    this.node = options.node
    this.capabilities = capabilities
    this.missing = missing
    this.compatible = missing.length === 0
    const park = options.parkInteractions
    this.parkMs =
      park === undefined
        ? null
        : typeof park.parkMs === 'number' && Number.isFinite(park.parkMs) && park.parkMs > 0
          ? park.parkMs
          : DEFAULT_INTERACTION_PARK_MS
    this.http = new HostHttp({
      origin: options.origin,
      headers: options.headers ?? (() => ({})),
      fetch: options.fetch,
      timeoutMs: options.probeTimeoutMs ?? 5_000,
      log: options.log,
    })
    const origin = new URL(options.origin)
    const wsProtocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
    this.mux = new MuxConnection({
      url: `${wsProtocol}//${origin.host}/api/remote.mux`,
      headers: options.headers ?? (() => ({})),
      createWebSocket: options.createWebSocket,
      log: options.log,
    })
    this.v2 = new V2Handler({
      nodeKind: options.node.kind,
      http: this.http,
      mux: this.mux,
      probeTimeoutMs: options.probeTimeoutMs ?? 5_000,
      cursorTimeoutMs: options.cursorTimeoutMs ?? 8_000,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.chatDir === undefined ? {} : { chatDir: options.chatDir }),
      defaultWorkspace: (refresh) => this.ensureDefaultWorkspace(refresh),
      ...(options.fileRoots === undefined ? {} : { fileRoots: options.fileRoots }),
      ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
      ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
      // tools/reasoning 没有自己的端点：它们依赖 v1 已经探到的流能力
      streamAvailable: capabilities.stream,
      // 用量聚合要用会话游标（session/page 必须带 throughSeq）
      cursorFor: (sessionId) => this.cursorFor(sessionId),
      emit: (frame) => this.emit(frame),
    })
  }

  /** v2 能力位（hello 协商后才有值）。 */
  get capabilitiesV2(): NodeCapabilitiesV2 {
    return this.v2.capabilities
  }

  /** 已启用的 v2 特性（老客户端为空）。 */
  get features(): readonly MobileV2Feature[] {
    return this.v2.enabledFeatures
  }

  async dispatch(frame: MobileClientFrame, sink: FrameSink): Promise<void> {
    this.sink = sink
    const requestId = requestIdOf(frame)
    if (this.closed) {
      await sink(this.errorFrame(requestId, 'adapter-unavailable', 'adapter 已关闭', false))
      return
    }
    if (!this.compatible && frame.type !== 'hello' && frame.type !== 'ping') {
      await sink(
        this.errorFrame(
          requestId,
          'adapter-incompatible',
          `DSH Host 版本不兼容，缺少：${this.missing.join(', ')}`,
          false,
        ),
      )
      return
    }
    try {
      // v2 独有帧交给 handler（未协商对应特性时它自己回 feature-unsupported）
      if (await this.v2.dispatch(frame, sink)) return
      switch (frame.type) {
        case 'hello':
          await this.handleHello(frame.requestId, frame.features ?? null, sink)
          return
        case 'sessions':
          await this.handleSessions(frame.requestId, frame.includeArchived === true, sink)
          return
        case 'history':
          await this.handleHistory(
            frame.requestId,
            frame.sessionId,
            frame.beforeSeq ?? null,
            frame.limit ?? 30,
            sink,
          )
          return
        case 'create':
          await this.handleCreate(frame, sink)
          return
        case 'send':
          await this.handleSend(frame, sink)
          return
        case 'stop':
          await this.handleStop(frame.requestId, frame.sessionId, sink)
          return
        case 'subscribe':
          await this.handleSubscribe(frame.requestId, frame.sessionId, frame.sinceCursor ?? null, sink)
          return
        case 'unsubscribe':
          this.unsubscribe(frame.sessionId)
          return
        case 'answer-question':
          await this.handleAnswer(frame, sink)
          return
        case 'answer-approval':
          await this.handleApprovalAnswer(frame, sink)
          return
        case 'session-state-request':
          // WP46：云节点的这条帧由 Hub 的 NodeSession 直接回（本地快照）。走到这里说明
          // 桌面/老路径把它转给了 adapter —— 明确报「没协商」，绝不静默吞掉。
          await sink(
            this.errorFrame(requestId, 'feature-unsupported', '该节点不提供 session-state 快照', false),
          )
          return
        case 'ping':
          await sink({ v: 1, type: 'pong', t: frame.t })
          return
      }
    } catch (error) {
      await sink(this.errorFrame(requestId, ...this.classify(error)))
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [sessionId, handle] of this.follows) {
      this.follows.delete(sessionId)
      this.mux.cancel(handle.streamId)
    }
    if (this.control !== null) {
      this.mux.cancel(this.control.streamId)
      this.control = null
    }
    // 断开不是撤销：未决审批先各自 next（交回 Host 的失败关闭尾巴），再释放
    for (const [eventId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer)
      await this.sendEventsResult(eventId, { kind: 'next' }).catch(() => undefined)
    }
    this.pendingApprovals.clear()
    for (const [key, pending] of [...this.pendingQuestions]) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.hold?.()
      this.pendingQuestions.delete(key)
      await this.sendEventsResult(pending.eventId, { kind: 'next' }).catch(() => undefined)
    }
    this.pendingQuestions.clear()
    if (this.events !== null) {
      this.mux.cancel(this.events.streamId)
      this.events = null
    }
    this.eventsOpening = null
    this.capabilities = { ...this.capabilities, approvals: false }
    this.subscribed.clear()
    this.attempts.clear()
    this.sink = null
    await this.v2.close().catch(() => undefined)
    await this.mux.close()
  }

  // ── 基础端点 ──────────────────────────────────────────────────────────────

  private async handleHello(
    requestId: string,
    declaredFeatures: readonly string[] | null,
    sink: FrameSink,
  ): Promise<void> {
    // v2 协商：只探测客户端声明过的特性需要的端点；老客户端（features 缺省）一个多余
    // 请求都不发，hello 帧也与 v1 逐字节一致。
    let enabled: readonly MobileV2Feature[] | null = null
    if (declaredFeatures !== null) {
      enabled = await this.v2.negotiate(declaredFeatures).catch((error: unknown) => {
        this.options.log?.('v2.negotiate-failed', { message: messageOf(error) })
        return [] as MobileV2Feature[]
      })
    }
    // approvals 只有在真实手机通道 hello 之后才尝试打开 answering `$events`；
    // 列表/开关探测（probeNodeRemote）永远不打开它，避免点亮 hasLiveClient。
    void this.ensureEvents().then(async (ready) => {
      if (!ready || this.closed) return
      this.capabilities = { ...this.capabilities, approvals: true }
      await sink({ v: 1, type: 'capability', capabilities: this.capabilities })
    })
    await sink({
      v: 1,
      type: 'hello',
      requestId,
      node: this.node,
      capabilities: this.capabilities,
      subscribed: [...this.subscribed],
      serverTime: Date.now(),
      ...(enabled === null ? {} : { features: [...enabled], capabilitiesV2: this.v2.capabilities }),
    })
  }

  private async handleSessions(requestId: string, includeArchived: boolean, sink: FrameSink): Promise<void> {
    const value = asRecord(await this.http.unary('session/list', { _request: {} }))
    const rawItems = Array.isArray(value['items']) ? value['items'] : []
    const items: SessionRow[] = []
    for (const raw of rawItems) {
      const item = asRecord(raw)
      const sessionId = typeof item['sessionId'] === 'string' ? item['sessionId'] : null
      if (sessionId === null) continue
      // 子代理会话不进手机主列表（避免与根会话混排）
      if (item['parentSessionId'] !== undefined) continue
      if (item['origin'] === 'subagent') continue
      // 会话目录：最权威的来源之一（stat 的包含检查要用它）
      if (typeof item['cwd'] === 'string') this.v2.learnCwd(sessionId, item['cwd'])
      items.push({
        sessionId,
        title: titleOf(item),
        updatedAt: typeof item['updatedAt'] === 'number' ? item['updatedAt'] : 0,
        running: item['running'] === true,
        blank: item['blank'] === true,
        agentAvailable: item['agentAvailable'] === true,
        origin: typeof item['origin'] === 'string' ? item['origin'] : null,
      })
      // WP46：`session/list` 是 Host 对「跑没在跑」的权威答案，`session-state` 用它校正，
      // 不能只靠流式事件推（App 可能刚重连、事件已经错过）。老行为下不记，保持零开销。
      if (this.parkMs !== null) this.setRuntimeRunning(sessionId, item['running'] === true)
    }
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    // §17 D5：归档集合来自 `workspace/follow`，`session/list` 本身不过滤。
    // **只有协商了 archive 的客户端才做这件事**：老客户端拿到的帧必须与 v1 完全一致
    // （也不要因为一次 follow 失败把会话藏起来）。
    const archived = this.v2.enabled('archive') ? await this.v2.archivedIds().catch(() => null) : null
    if (archived === null) {
      await sink({ v: 1, type: 'sessions', requestId, items })
      return
    }
    const rows: SessionRowV2[] = items.map((item) =>
      archived.has(item.sessionId) ? { ...item, archived: true } : item,
    )
    await sink({
      v: 1,
      type: 'sessions',
      requestId,
      items: includeArchived ? rows : rows.filter((item) => item.archived !== true),
    })
  }

  private async handleHistory(
    requestId: string,
    sessionId: string,
    beforeSeq: number | null,
    limit: number,
    sink: FrameSink,
  ): Promise<void> {
    const cursor = await this.cursorFor(sessionId)
    // 真实 Host 的 session/page **必须**带 throughSeq（且不得越过当前 cursor），
    // 取不到 follow 的 snapshot.cursor 时不能拿空游标去猜。
    if (cursor === null)
      throw new HostRpcError(
        'upstream-unavailable',
        `无法取得会话游标（session/follow 未给出 snapshot.cursor${this.cursorFailure === null ? '' : `：${this.cursorFailure}`}）`,
      )
    const page = asRecord(
      await this.http.unary('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          ...(cursor === null ? {} : { throughSeq: cursor }),
          ...(beforeSeq === null ? {} : { beforeSeq }),
          maxMessages: Math.min(Math.max(limit, 1), 100),
        },
      }),
    )
    const records = Array.isArray(page['records']) ? page['records'] : []
    const items = mapRecords(records)
    // §7.4：reasoning 只在协商了 reasoning 的连接上带（v1 帧不多一个字段）
    const withReasoning = this.v2.enabled('reasoning')
    await sink({
      v: 1,
      type: 'history',
      requestId,
      sessionId,
      items: withReasoning
        ? items
        : items.map(({ reasoning, ...rest }) => {
            void reasoning
            return rest
          }),
      nextBeforeSeq: items.length > 0 ? (items[0]?.seq ?? null) : null,
      cursor,
      hasMore: page['hasMore'] === true,
    })
    // §7.3 / §8.1：该页里的工具与交付物**再补发**成独立帧（有自己的截断预算）
    await this.v2.replayHistory(sessionId, records).catch((error: unknown) => {
      this.options.log?.('v2.replay-history-failed', { message: messageOf(error) })
    })
  }

  private defaultWorkspaceId: string | null = null

  /**
   * 新建会话必须落在**真实存在的工作区**：先 `workspace/initializeDefault`
   * （Host 返回 `{workspace:{workspaceId,path,...}}`，没有就创建一个默认工作区），
   * 再 `session/create{workspaceId}`。不凭空用 root cwd 造会话。
   */
  private async handleCreate(
    frame: Extract<MobileClientFrame, { type: 'create' }>,
    sink: FrameSink,
  ): Promise<void> {
    // v2：cwd 交给 Host 的 defaultCwd（标准 DSH 工作区；显式 chatDir 除外），支持 preset/model/effort。
    // 老客户端（没有任何 v2 字段）继续走 v1：initializeDefault → create{workspaceId}。
    const wantsV2 =
      frame.preset !== undefined ||
      frame.model !== undefined ||
      frame.provider !== undefined ||
      frame.effort !== undefined ||
      this.v2.enabled('models')
    if (!wantsV2) {
      const workspaceId = await this.ensureDefaultWorkspace()
      const value = asRecord(await this.http.unary('session/create', { request: { workspaceId } }))
      const sessionId = typeof value['sessionId'] === 'string' ? value['sessionId'] : null
      if (sessionId === null) throw new HostRpcError('internal', 'Host 未返回 sessionId')
      await sink({ v: 1, type: 'created', requestId: frame.requestId, sessionId })
      return
    }
    if (
      (frame.provider === undefined) !== (frame.model === undefined) ||
      (frame.effort !== undefined && frame.model === undefined)
    ) {
      throw new HostRpcError('internal', 'provider 与 model 必须一起给；effort 需要 model')
    }
    const created = await this.v2.create({
      ...(frame.preset === undefined ? {} : { preset: frame.preset }),
      ...(frame.provider === undefined ? {} : { provider: frame.provider }),
      ...(frame.model === undefined ? {} : { model: frame.model }),
      ...(frame.effort === undefined ? {} : { effort: frame.effort }),
    })
    await sink({
      v: 1,
      type: 'created',
      requestId: frame.requestId,
      sessionId: created.sessionId,
      ...(created.preset === undefined ? {} : { preset: created.preset }),
      ...(created.model === undefined ? {} : { model: created.model }),
      ...(created.warning === undefined ? {} : { warning: created.warning }),
    })
  }

  private async ensureDefaultWorkspace(refresh = false): Promise<string> {
    if (refresh) this.defaultWorkspaceId = null
    if (this.defaultWorkspaceId !== null) return this.defaultWorkspaceId
    const value = asRecord(await this.http.unary('workspace/initializeDefault', {}))
    const workspace = asRecord(value['workspace'])
    const workspaceId = typeof workspace['workspaceId'] === 'string' ? workspace['workspaceId'] : null
    if (workspaceId === null) throw new HostRpcError('internal', 'Host 未返回默认工作区')
    this.defaultWorkspaceId = workspaceId
    return workspaceId
  }

  private async handleSend(
    frame: Extract<MobileClientFrame, { type: 'send' }>,
    sink: FrameSink,
  ): Promise<void> {
    const attachments = frame.attachments ?? []
    if (attachments.length > 0 && !this.v2.enabled('attachments')) {
      throw new HostRpcError('feature-unsupported', '该连接没有协商附件能力')
    }
    const extra =
      attachments.length === 0
        ? []
        : await this.v2.contentParts(
            frame.sessionId,
            attachments.map((item) => ({
              kind: item.kind,
              uploadId: item.uploadId,
              name: item.name,
              bytes: item.bytes,
            })),
          )
    await this.http.unary('session/prompt', {
      request: {
        // `requestId` 是 DSH 持久化在用户消息上的身份 —— 直接复用客户端的幂等键。
        requestId: frame.clientMessageId,
        sessionId: frame.sessionId,
        mode: frame.mode ?? 'queue',
        content: [{ type: 'text', text: frame.text }, ...extra],
      },
    })
    await sink({ v: 1, type: 'ack', requestId: frame.requestId, clientMessageId: frame.clientMessageId })
  }

  private async handleStop(requestId: string, sessionId: string, sink: FrameSink): Promise<void> {
    const value = asRecord(await this.http.unary('session/cancel', { request: { sessionId } }))
    const accepted = value['accepted'] === true
    // WP46：用户点了停止 = 「该回合被停止」，暂存的提问/审批立刻交还 Host（M6 §1）。
    // 先结算再推 stopped，Hub 收到 stopped 时取到的快照已经是干净的。
    if (accepted && this.parkMs !== null) {
      this.setRuntimeRunning(sessionId, false)
      this.releaseParkedInteractions(sessionId, 'stopped')
    }
    await sink({ v: 1, type: 'stopped', requestId, sessionId, accepted })
  }

  private async handleAnswer(
    frame: Extract<MobileClientFrame, { type: 'answer-question' }>,
    sink: FrameSink,
  ): Promise<void> {
    // agent 必须就是该 session（`userQuestions/answer` 的 agent 参数类型是 SessionId）。
    if (frame.agent !== frame.sessionId) {
      throw new HostRpcError('question/not-found', 'agent 与 session 不匹配')
    }
    // 老行为：只允许回答「本通道订阅会话里、真实投影出现过的 callId」。
    // WP46 park 模式：暂存的提问不再绑在订阅上（手机重连后先答再订阅也必须能答），
    // 但仍要求「确实是本 adapter 接住的未决条目」（下面两处 map 校验）——绝不凭空接受。
    if (this.parkMs === null && !this.subscribed.has(frame.sessionId)) {
      throw new HostRpcError('question/not-found', 'agent 与 session 不匹配或该会话未订阅')
    }
    // open 前台提问：走 `$events` waterfall 结果（unary 只认 continued）
    const pendingQuestion = (() => {
      for (const [key, value] of this.pendingQuestions) {
        if (key === `${frame.sessionId}:${frame.callId}`) return { key, value }
      }
      return null
    })()
    if (pendingQuestion !== null) {
      await this.sendEventsResult(pendingQuestion.value.eventId, {
        kind: 'result',
        value: { answers: frame.answers.map((item) => ({ ...item, selected: [...item.selected] })) },
      })
      if (pendingQuestion.value.timer !== null) clearTimeout(pendingQuestion.value.timer)
      pendingQuestion.value.hold?.()
      this.pendingQuestions.delete(pendingQuestion.key)
      await sink({
        v: 1,
        type: 'question-settled',
        sessionId: frame.sessionId,
        callId: frame.callId,
        answers: frame.answers.map((item) => ({ ...item, selected: [...item.selected] })),
      })
      await sink({
        v: 1,
        type: 'answer-result',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        accepted: true,
        continued: false,
      })
      return
    }
    const open = this.openQuestions.get(frame.sessionId)
    if (open === undefined || !open.has(frame.callId)) {
      throw new HostRpcError('question/not-found', '该问题不属于当前订阅会话或已结算')
    }
    // 手机协议字段保持 `agent`；Host 真实参数名随版本不同：
    // 安装 runtime 0.2.1-rc.2 = `agent`，M3 当前 src = `agentId`。先试新名，参数校验失败再退回旧名。
    const args = {
      callId: frame.callId,
      answer: { answers: frame.answers.map((item) => ({ ...item, selected: [...item.selected] })) },
    }
    const attempt: Array<'agent' | 'agentId'> =
      this.questionAgentParam === null ? ['agentId', 'agent'] : [this.questionAgentParam]
    let continued: unknown = undefined
    let lastError: unknown = null
    for (const param of attempt) {
      try {
        continued = await this.http.unary('userQuestions/answer', { [param]: frame.agent, ...args })
        this.questionAgentParam = param
        break
      } catch (error) {
        const code = error instanceof HostRpcError ? error.code : ''
        if (
          code !== 'gateway/arguments-invalid' &&
          code !== 'gateway/input-invalid' &&
          code !== 'gateway/bad-request'
        )
          throw error
        lastError = error
      }
    }
    if (this.questionAgentParam === null)
      throw lastError ?? new HostRpcError('internal', 'Host 不接受 agent/agentId 任一参数名')
    if (continued !== true) {
      // Host 明确说「不是 continued 可答」：绝不能假报 accepted
      throw new HostRpcError('question/not-found', '该问题不是 continued 状态，且没有对应的 $events 前台请求')
    }
    await sink({
      v: 1,
      type: 'answer-result',
      requestId: frame.requestId,
      sessionId: frame.sessionId,
      accepted: true,
      continued: true,
    })
  }

  // ── 流式 ──────────────────────────────────────────────────────────────────

  private async handleSubscribe(
    requestId: string,
    sessionId: string,
    sinceCursor: number | null,
    sink: FrameSink,
  ): Promise<void> {
    this.unsubscribe(sessionId)
    this.subscribed.add(sessionId)
    let resolveCursor!: (cursor: number | null) => void
    const cursorReady = new Promise<number | null>((resolve) => {
      resolveCursor = resolve
    })
    const handle: FollowHandle = {
      streamId: '',
      cursor: null,
      latestSeq: 0,
      ended: false,
      cursorReady,
      resolveCursor,
      requestId,
    }
    const streamId = await this.mux.open(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } },
      {
        onItem: (value) => {
          void this.handleFollowItem(sessionId, sinceCursor, handle, value, sink)
        },
        onEnd: () => {
          handle.ended = true
          handle.resolveCursor(null)
          // WP46：follow 自己断了就不再算「正在跟随」，下一次 subscribe 该重建（共享 adapter 下
          // 别的通道不会替它重建）。`subscribed` 保留，回答资格与 control 投影口径不变。
          if (this.follows.get(sessionId) === handle) this.follows.delete(sessionId)
          void sink(this.errorFrame(requestId, 'adapter-unavailable', 'Host 结束了会话订阅', true))
        },
        onError: (error) => {
          handle.ended = true
          handle.resolveCursor(null)
          if (this.follows.get(sessionId) === handle) this.follows.delete(sessionId)
          void sink(this.errorFrame(requestId, ...muxError(error)))
        },
      },
    )
    handle.streamId = streamId
    this.follows.set(sessionId, handle)
    this.ensureControl(sink)
    void this.ensureEvents()
  }

  private async handleFollowItem(
    sessionId: string,
    sinceCursor: number | null,
    handle: FollowHandle,
    value: unknown,
    sink: FrameSink,
  ): Promise<void> {
    const frame = asRecord(value)
    const type = frame['type']
    if (type === 'snapshot') {
      handle.cursor = typeof frame['cursor'] === 'number' ? frame['cursor'] : null
      handle.resolveCursor(handle.cursor)
      // 会话目录的最权威来源（`stat` 的包含检查要用它）
      const header = asRecord(frame['header'])
      this.v2.learnCwd(sessionId, header['cwd'])
      if (this.parkMs !== null) this.noteSnapshotRuntime(sessionId, handle.cursor, frame)
      // 断线追赶：把 (sinceCursor, snapshot.cursor] 之间的持久消息补发，再发 replay 边界
      if (handle.cursor !== null && sinceCursor !== null && sinceCursor < handle.cursor) {
        const complete = await this.catchUp(sessionId, sinceCursor, handle.cursor, frame, sink)
        if (!complete) {
          // 追不到 sinceCursor 就不能发 replay 假装推进：要求客户端全量重载。
          // WP46：**只回发起这次 subscribe 的通道**（带它的 requestId），并且**不拆 follow** ——
          // 共享 adapter 下这条 follow 还服务着别的通道，谁追不上只是谁要重载历史。
          this.options.log?.('follow.catch-up-incomplete', { sessionId })
          await sink(
            this.errorFrame(
              handle.requestId,
              'upstream-unavailable',
              'catch-up-incomplete: 断线期间消息超出有界追赶范围，请重新拉取历史',
              true,
            ),
          )
          return
        }
      }
      await sink({
        v: 1,
        type: 'replay',
        sessionId,
        fromCursor: sinceCursor,
        toCursor: handle.cursor ?? 0,
      })
      const projections = asRecord(frame['projections'])
      await this.emitProjectionValues(sessionId, projections['values'], sink)
      // 进行中的 assistant attempt：stream 是 compact 记录，不能在这里拼正文；
      // 显式告知客户端「有活跃 attempt + nextIndex」，由客户端重新同步/等待后续 chunk。
      const baseline = asRecord(frame['assistantStream'])
      const active = asRecord(baseline['activeAttempt'])
      const attemptId = typeof active['attemptId'] === 'string' ? active['attemptId'] : null
      if (attemptId !== null) {
        // 真实 compact stream：text-chunks / reasoning-chunks{texts[],dt[],index,time0}。
        // 正文与思考分开拼：正文放 text、思考放 reasoning（断线重连后思考框能接上）。
        const stream = Array.isArray(active['stream']) ? active['stream'] : []
        let text = ''
        let reasoning = ''
        for (const record of stream) {
          const entry = asRecord(record)
          const kind = entry['type']
          if (kind !== 'text-chunks' && kind !== 'reasoning-chunks') continue
          const texts = Array.isArray(entry['texts']) ? entry['texts'] : []
          for (const member of texts) {
            if (typeof member !== 'string') continue
            if (kind === 'text-chunks') text += member
            else reasoning += member
          }
        }
        // 思考可能很长：只带尾部 8000 字（客户端本来就跟着最后一行滚，且帧有大小上限）
        const reasoningTail = reasoning.length > 8_000 ? reasoning.slice(-8_000) : reasoning
        const baselineFrame: Extract<MobileServerFrame, { type: 'assistant-baseline' }> = {
          v: 1,
          type: 'assistant-baseline',
          sessionId,
          attemptId,
          revision: typeof baseline['revision'] === 'number' ? baseline['revision'] : 0,
          nextIndex: typeof active['nextIndex'] === 'number' ? active['nextIndex'] : 0,
          text,
          ...(reasoningTail === '' ? {} : { reasoning: reasoningTail }),
        }
        // WP46：多通道共享一条 follow 时，后加入的通道靠这份缓存补基线（见 sessionBaseline()）
        if (!this.baselines.has(sessionId) && this.baselines.size >= MAX_CACHED_SESSIONS) {
          const oldest = this.baselines.keys().next()
          if (!oldest.done) this.baselines.delete(oldest.value)
        }
        this.baselines.set(sessionId, baselineFrame)
        await sink(baselineFrame)
      } else {
        this.baselines.delete(sessionId)
      }
      return
    }
    if (type === 'event') {
      const event = asRecord(frame['event'])
      const seq = typeof event['seq'] === 'number' ? event['seq'] : 0
      // 订阅期间读过的事件也是「可读到的最新一刀」：history 的 throughSeq 要用它，
      // 否则活跃会话里往上翻历史会拿到 opening snapshot 那个很旧的 cursor（v1 缺陷 ④）。
      if (seq > handle.latestSeq) handle.latestSeq = seq
      await this.emitEvent(sessionId, frame['event'], sink)
      return
    }
    if (type === 'assistant-stream') {
      await this.emitAssistantFrame(sessionId, frame['frame'], handle, sink)
    }
  }

  private async emitAssistantFrame(
    sessionId: string,
    value: unknown,
    handle: FollowHandle,
    sink: FrameSink,
  ): Promise<void> {
    const frame = asRecord(value)
    const type = frame['type']
    const attemptId = typeof frame['attemptId'] === 'string' ? frame['attemptId'] : ''
    const revision = typeof frame['revision'] === 'number' ? frame['revision'] : 0
    if (type === 'start') {
      // v1 的缺陷：delta 的 turn/step 恒为 null。start 帧里本来就有，记下来即可。
      this.attempts.set(attemptId, {
        turn: typeof frame['turn'] === 'number' ? frame['turn'] : null,
        step: typeof frame['step'] === 'number' ? frame['step'] : null,
      })
      if (this.parkMs !== null && attemptId !== '') this.setRuntimeAttempt(sessionId, attemptId)
      return
    }
    if (type === 'chunk') {
      const chunk = asRecord(frame['chunk'])
      const attempt = this.attempts.get(attemptId)
      const part = classifyChunk(frame['chunk'])
      const block = asRecord(chunk['block'])
      const blockEndKind = chunk['type'] === 'block-end' ? block['type'] : null
      // v2 e)：思考块结束 → `done`，App 不用靠超时收起「正在思考」（正文即将开始）
      if (blockEndKind === 'reasoning' && this.v2.enabled('reasoning')) {
        await sink({
          v: 1,
          type: 'delta',
          sessionId,
          attemptId,
          revision,
          index: typeof frame['index'] === 'number' ? frame['index'] : 0,
          turn: attempt?.turn ?? null,
          step: attempt?.step ?? null,
          part: { kind: 'reasoning' },
          done: true,
        })
        return
      }
      // §7.2：v2 下工具不进 `delta`（走独立 `tool` 帧）；老客户端保持原样
      if (part.kind === 'tool' && this.v2.enabled('tools')) return
      await sink({
        v: 1,
        type: 'delta',
        sessionId,
        attemptId,
        revision,
        index: typeof frame['index'] === 'number' ? frame['index'] : 0,
        turn: attempt?.turn ?? null,
        step: attempt?.step ?? null,
        part: part.kind === 'unknown' ? { kind: 'unknown' } : { kind: part.kind, text: part.text },
        raw: frame['chunk'],
      })
      return
    }
    if (type === 'end') {
      this.attempts.delete(attemptId)
      // 基线只对「正在出字」的 attempt 有意义：attempt 结束就作废
      if (this.baselines.get(sessionId)?.attemptId === attemptId) this.baselines.delete(sessionId)
      // attempt 结束不等于回合结束（回合只认 turn/end），这里只清 attemptId。
      if (this.parkMs !== null && attemptId !== '') this.setRuntimeAttempt(sessionId, null)
      const outcome = asRecord(frame['outcome'])
      await sink({
        v: 1,
        type: 'delta-end',
        sessionId,
        attemptId,
        revision,
        committed: outcome['kind'] === 'committed',
      })
      // 注意：这里**不**发 turn end —— 回合结束只认 `turn/end` 事件。
      void handle
    }
  }

  private async emitEvent(sessionId: string, value: unknown, sink: FrameSink): Promise<void> {
    const event = asRecord(value)
    const name = typeof event['type'] === 'string' ? event['type'] : ''
    const data = asRecord(event['data'])
    // v2 的事件投影（工具卡/交付物/模型变化）；内部只看特性开关，老客户端无额外帧
    await this.v2.onEvent(sessionId, event).catch((error: unknown) => {
      this.options.log?.('v2.event-projection-failed', { name, message: messageOf(error) })
    })
    if (name === 'turn/start' || name === 'turn/end') {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : 0
      // WP46：回合态是 `session-state` 的权威口径，必须在推帧**之前**更新——
      // Hub 收到 `turn` 帧后会立刻取快照决定要不要再发一份 session-state。
      if (this.parkMs !== null) {
        if (name === 'turn/start') {
          this.setRuntimeRunning(sessionId, true)
        } else {
          this.setRuntimeRunning(sessionId, false)
          // 回合结束：基线作废（下一个回合的 attempt 会重新产生）
          this.baselines.delete(sessionId)
          // 「该回合被停止/结束」也交还未决交互（M6 §1 的 next 出口之一）：
          // 回合都结束了还留着提问，等于让 Host 永久悬挂。
          this.releaseParkedInteractions(sessionId, 'turn-ended')
        }
      }
      await sink({
        v: 1,
        type: 'turn',
        sessionId,
        phase: name === 'turn/start' ? 'start' : 'end',
        turn,
        ...(name === 'turn/end' && typeof data['reason'] === 'string' ? { reason: data['reason'] } : {}),
      })
      return
    }
    if (name === 'approval/asked') {
      // 历史事件（非实时 waterfall）：只展示，不可答
      const approvalId = typeof data['id'] === 'string' ? data['id'] : `ap_${String(event['seq'] ?? '')}`
      await sink({
        v: 1,
        type: 'approval',
        sessionId,
        approval: {
          sessionId,
          callId: typeof data['callId'] === 'string' ? data['callId'] : null,
          approvalId,
          tool: typeof data['toolName'] === 'string' ? data['toolName'] : 'unknown',
          ...(typeof data['reason'] === 'string' ? { reason: data['reason'] } : {}),
          answerable: false,
          actions: ['cancel'],
          state: 'open',
        },
      })
      return
    }
    if (name === 'user/message' || name === 'assistant/message' || name === 'system/message') {
      // v1 缺陷 ①：只有 `source.kind==='user'` 的 user/message 才是用户说的话。
      // `runtime-context` / `time-context` 这类注入消息**不得**推成用户气泡。
      if (name === 'user/message' && sourceRpcIdKind(data['source']) !== 'user') return
      const message = messageBodyOf(name, data)
      const role = name === 'user/message' ? 'user' : name === 'assistant/message' ? 'assistant' : 'system'
      const tools = role === 'assistant' ? toolNamesOf(message) : []
      const rpcId = role === 'user' ? sourceRpcId(data['source']) : undefined
      await sink({
        v: 1,
        type: 'message',
        sessionId,
        seq: typeof event['seq'] === 'number' ? event['seq'] : 0,
        role,
        at: typeof event['time'] === 'number' ? event['time'] : 0,
        text: textOfContent(message['content']),
        ...(rpcId === undefined ? {} : { clientMessageId: rpcId }),
        ...(tools.length === 0 ? {} : { tools }),
      })
      return
    }
    if (name === 'approval/decided') {
      await sink({
        v: 1,
        type: 'approval-settled',
        sessionId,
        approvalId: typeof data['id'] === 'string' ? data['id'] : '',
        decision: data['outcome'] === 'denied' ? 'reject' : 'approve',
      })
      return
    }
    if (name === 'session/title') {
      await sink({
        v: 1,
        type: 'state',
        sessionId,
        key: 'title',
        value: typeof data['title'] === 'string' ? data['title'] : null,
        seq: typeof event['seq'] === 'number' ? event['seq'] : null,
      })
    }
  }

  private async emitProjectionValues(sessionId: string, value: unknown, sink: FrameSink): Promise<void> {
    if (typeof value !== 'object' || value === null) return
    for (const [key, projection] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'userQuestions') {
        await this.emitQuestions(sessionId, projection, sink)
        continue
      }
      if (!STATE_KEYS.has(key)) continue
      this.rememberProjection(sessionId, key, projection)
      await sink({ v: 1, type: 'state', sessionId, key, value: projection, seq: null })
      if (key === 'modelSelection') await this.emitModelChanged(sessionId, projection)
    }
  }

  /**
   * `modelSelection` 投影 → `model-changed`（§5.4：App **只认投影**刷新芯片，
   * `set-model` 的应答只用于清 loading，避免两台设备互相打架时来回跳）。
   */
  private async emitModelChanged(sessionId: string, value: unknown): Promise<void> {
    if (!this.v2.enabled('models')) return
    const projection = asRecord(value)
    const chosen = asRecord(projection['next'] ?? projection['lastUsed'])
    const provider = typeof chosen['provider'] === 'string' ? chosen['provider'] : null
    const model = typeof chosen['model'] === 'string' ? chosen['model'] : null
    if (provider === null || model === null) return
    const effort = typeof chosen['reasoningEffort'] === 'string' ? chosen['reasoningEffort'] : undefined
    await this.emit({
      v: 1,
      type: 'model-changed',
      sessionId,
      provider,
      model,
      ...(effort === undefined ? {} : { effort }),
    })
  }

  /**
   * 只把投影记进 `openQuestions`（不发帧）。WP46 的两个用途：
   * 1. `session-state` 要把 `continued` 问题也带上（题目、状态都要，不能只有 callId）；
   * 2. park 模式下没有订阅的会话也要知道「还有问题没答」（`pendingInteractions` 角标）。
   */
  private recordQuestions(sessionId: string, value: unknown): void {
    const record = asRecord(value)
    const active = Array.isArray(record['active']) ? record['active'] : []
    // 投影是完整状态：用 active 重建资格，不能只做加法（否则已答的 callId 永久残留）
    const next = new Map<string, { questions: Question[]; state: 'open' | 'continued' }>()
    for (const raw of active) {
      const entry = asRecord(raw)
      const callId = typeof entry['callId'] === 'string' ? entry['callId'] : null
      const questions = mapQuestions(entry['questions'])
      if (callId === null || questions.length === 0) continue
      next.set(callId, { questions, state: entry['state'] === 'continued' ? 'continued' : 'open' })
    }
    // settled 是同一份投影里的「已结算」集合：先从新的 active 里删（真实 Host 的 settled
    // 条目不会再出现在 active 里，这一步只是防御），再决定这个会话还有没有未决提问。
    const settled = Array.isArray(record['settled']) ? record['settled'] : []
    for (const raw of settled) {
      const entry = asRecord(raw)
      const callId = typeof entry['callId'] === 'string' ? entry['callId'] : null
      if (callId !== null) next.delete(callId)
    }
    if (next.size === 0) this.openQuestions.delete(sessionId)
    else this.openQuestions.set(sessionId, next)
  }

  private async emitQuestions(sessionId: string, value: unknown, sink: FrameSink): Promise<void> {
    const record = asRecord(value)
    this.recordQuestions(sessionId, value)
    const active = Array.isArray(record['active']) ? record['active'] : []
    for (const raw of active) {
      const entry = asRecord(raw)
      const callId = typeof entry['callId'] === 'string' ? entry['callId'] : null
      const questions = mapQuestions(entry['questions'])
      if (callId === null || questions.length === 0) continue
      await sink({
        v: 1,
        type: 'question',
        sessionId,
        agent: sessionId,
        callId,
        questions,
        state: entry['state'] === 'continued' ? 'continued' : 'open',
      })
    }
    const settled = Array.isArray(record['settled']) ? record['settled'] : []
    for (const raw of settled) {
      const entry = asRecord(raw)
      const callId = typeof entry['callId'] === 'string' ? entry['callId'] : null
      if (callId === null) continue
      // 真实 settled 只有 {callId, answers}：用专用帧撤卡，不能再等 questions
      const answers = Array.isArray(entry['answers'])
        ? entry['answers'].flatMap((item) => {
            const answer = asRecord(item)
            const id = typeof answer['id'] === 'string' ? answer['id'] : null
            if (id === null) return []
            const selected = Array.isArray(answer['selected'])
              ? answer['selected'].filter((label): label is string => typeof label === 'string')
              : []
            return [
              { id, selected, ...(typeof answer['custom'] === 'string' ? { custom: answer['custom'] } : {}) },
            ]
          })
        : undefined
      await sink({
        v: 1,
        type: 'question-settled',
        sessionId,
        callId,
        ...(answers === undefined ? {} : { answers }),
      })
    }
  }

  /** 控制流：Host 级会话状态（问答/标题/权限…）。整个 adapter 只开一条。 */
  private ensureControl(sink: FrameSink): void {
    if (this.control !== null) return
    void (async () => {
      try {
        const streamId = await this.mux.open(
          'session/control',
          { args: {} },
          {
            onItem: (value) => {
              void this.handleControlItem(value, sink)
            },
            onEnd: () => {
              this.control = null
            },
            onError: () => {
              this.control = null
            },
          },
        )
        this.control = { streamId }
      } catch (error) {
        this.options.log?.('control.open-failed', { message: messageOf(error) })
      }
    })()
  }

  private async handleControlItem(value: unknown, sink: FrameSink): Promise<void> {
    const frame = asRecord(value)
    if (frame['type'] === 'baseline') {
      const baseline = asRecord(frame['value'])
      const projections = asRecord(baseline['projections'])
      for (const sessionId of this.subscribed) {
        const entry = asRecord(projections[sessionId])
        await this.emitProjectionValues(sessionId, entry['values'], sink)
      }
      // WP46 park：没订阅的会话也要记一份「还有没有 continued 问题」——
      // 通道断开期间手机看不到帧，但会话列表的待回答角标与重连后的 session-state 都要它。
      // 老行为（parkMs === null）一个多余的事都不做。
      if (this.parkMs !== null) {
        for (const [sessionId, entry] of Object.entries(projections)) {
          if (this.subscribed.has(sessionId)) continue
          this.recordQuestions(sessionId, asRecord(asRecord(entry)['values'])['userQuestions'])
        }
      }
      return
    }
    if (frame['type'] !== 'projection') return
    const sessionId = typeof frame['sessionId'] === 'string' ? frame['sessionId'] : null
    const key = typeof frame['key'] === 'string' ? frame['key'] : null
    if (sessionId === null || key === null || !this.subscribed.has(sessionId)) return
    const seq = typeof frame['seq'] === 'number' ? frame['seq'] : null
    if (key === 'userQuestions') {
      await this.emitQuestions(sessionId, frame['value'], sink)
      return
    }
    if (!STATE_KEYS.has(key)) return
    this.rememberProjection(sessionId, key, frame['value'])
    await sink({ v: 1, type: 'state', sessionId, key, value: frame['value'], seq })
    if (key === 'modelSelection') await this.emitModelChanged(sessionId, frame['value'])
  }

  private unsubscribe(sessionId: string): void {
    this.subscribed.delete(sessionId)
    const handle = this.follows.get(sessionId)
    if (handle !== undefined) {
      this.follows.delete(sessionId)
      this.mux.cancel(handle.streamId)
    }
    // WP46 park 模式：切换/断开订阅**不等于**放弃提问与审批——条目留在 pending 里，
    // 由 park 上限、回合结束或 close() 结算（M6 §1「通道断开不回 next」）。
    if (this.parkMs !== null) return
    // 老行为：切走会话立刻失去问答资格，并把本会话未决审批交还给 Host（next），不留悬挂
    this.openQuestions.delete(sessionId)
    this.releaseParkedInteractions(sessionId, 'unsubscribed')
  }

  /**
   * 交还某会话的全部未决交互（next + 撤卡）。
   *
   * WP46：这是**唯一**的 next 出口之一（另一个是 `close()`），调用方只有
   * 「park 上限到点」「回合结束/被停止」「老行为下的 unsubscribe」「close」。
   * 审批**绝不**自动批准 —— 这里回的是 `{kind:'next'}`，让 Host 走它自己的失败关闭。
   */
  private releaseParkedInteractions(sessionId: string, reason: string): void {
    for (const [key, pending] of [...this.pendingQuestions]) {
      if (pending.sessionId !== sessionId) continue
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.hold?.()
      this.pendingQuestions.delete(key)
      void this.sendEventsResult(pending.eventId, { kind: 'next' }).catch(() => undefined)
      void this.emit({ v: 1, type: 'question-settled', sessionId, callId: pending.callId })
    }
    for (const [eventId, pending] of [...this.pendingApprovals]) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pendingApprovals.delete(eventId)
      void this.sendEventsResult(eventId, { kind: 'next' }).catch(() => undefined)
      void this.emit({
        v: 1,
        type: 'approval-settled',
        sessionId,
        approvalId: pending.approvalId,
        decision: 'expired',
      })
    }
    this.options.log?.('session.interactions-released', { sessionId, reason })
  }

  // ── 会话快照（WP46 / M6 §2.1） ────────────────────────────────────────────

  private setRuntimeRunning(sessionId: string, running: boolean): void {
    const current = this.runtime.get(sessionId)
    const next = {
      running,
      attemptId: running ? (current?.attemptId ?? null) : null,
      cursor: current?.cursor ?? null,
    }
    this.runtime.set(sessionId, next)
  }

  private setRuntimeAttempt(sessionId: string, attemptId: string | null): void {
    const current = this.runtime.get(sessionId) ?? { running: false, attemptId: null, cursor: null }
    this.runtime.set(sessionId, {
      running: attemptId === null ? current.running : true,
      attemptId,
      cursor: current.cursor,
    })
  }

  private setRuntimeCursor(sessionId: string, cursor: number | null): void {
    if (cursor === null) return
    const current = this.runtime.get(sessionId) ?? { running: false, attemptId: null, cursor: null }
    this.runtime.set(sessionId, { ...current, cursor })
  }

  /**
   * 从 follow 的 opening snapshot 推回合态（WP46）：
   * - `assistantStream.activeAttempt` 存在 = 正在出字，running 必为 true；
   * - 否则看快照自带的历史窗口里最后一条 turn 事件（turn/start vs turn/end）；
   * - 都没有就沿用已知状态（例如刚由 `session/list` 拿到的 running），只把 attemptId 清掉。
   */
  private noteSnapshotRuntime(
    sessionId: string,
    cursor: number | null,
    snapshot: Record<string, unknown>,
  ): void {
    this.setRuntimeCursor(sessionId, cursor)
    const baseline = asRecord(snapshot['assistantStream'])
    const active = asRecord(baseline['activeAttempt'])
    const attemptId = typeof active['attemptId'] === 'string' ? active['attemptId'] : null
    if (attemptId !== null) {
      this.setRuntimeAttempt(sessionId, attemptId)
      this.setRuntimeRunning(sessionId, true)
      return
    }
    const records = Array.isArray(snapshot['records']) ? snapshot['records'] : []
    let turned: boolean | null = null
    for (const record of records) {
      const event = asRecord(asRecord(record)['event'])
      const name = event['type']
      if (name === 'turn/start') turned = true
      else if (name === 'turn/end') turned = false
    }
    if (turned === null) this.setRuntimeAttempt(sessionId, null)
    else this.setRuntimeRunning(sessionId, turned)
  }

  /** 该会话的回合/未决交互快照（`session-state` 的 `questions/approvals/running/attemptId`）。 */
  sessionState(sessionId: string): SessionRuntimeState {
    const runtime = this.runtime.get(sessionId)
    // 瀑布提问优先于投影（同一 callId 时以「真的在等 $events 结果」的那份为准）
    const questions = new Map<string, PendingQuestionView>()
    for (const [callId, entry] of this.openQuestions.get(sessionId) ?? []) {
      questions.set(callId, {
        agent: sessionId,
        callId,
        questions: entry.questions,
        state: entry.state,
      })
    }
    for (const pending of this.pendingQuestions.values()) {
      if (pending.sessionId !== sessionId) continue
      questions.set(pending.callId, {
        agent: pending.sessionId,
        callId: pending.callId,
        questions: pending.questions,
        state: 'open',
      })
    }
    const approvals: ApprovalView[] = []
    for (const pending of this.pendingApprovals.values()) {
      if (pending.sessionId !== sessionId) continue
      approvals.push(pending.approval)
    }
    const running = runtime?.running === true
    return {
      // 游标与 `replay.toCursor` 同口径：跟随流的 opening cursor（没有 follow 时退回已知值）
      cursor: this.followCursor(sessionId),
      running,
      attemptId: running ? (runtime?.attemptId ?? null) : null,
      questions: [...questions.values()].slice(0, 16),
      approvals: approvals.slice(0, 16),
    }
  }

  /** 每个会话的未决交互数（会话列表 `pendingInteractions` 角标；按 callId 去重）。 */
  pendingInteractions(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>()
    const seen = new Set<string>()
    const bump = (sessionId: string, kind: 'question' | 'approval', id: string): void => {
      const key = `${sessionId}\u0000${kind}:${id}`
      if (seen.has(key)) return
      seen.add(key)
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
    }
    for (const [sessionId, map] of this.openQuestions) {
      for (const callId of map.keys()) bump(sessionId, 'question', callId)
    }
    for (const pending of this.pendingQuestions.values()) bump(pending.sessionId, 'question', pending.callId)
    for (const pending of this.pendingApprovals.values()) bump(pending.sessionId, 'approval', pending.approvalId)
    return counts
  }

  /** 有回合在跑的会话（Hub 的 NodeSession 靠它决定「还不能关」）。 */
  runningSessions(): readonly string[] {
    const ids: string[] = []
    for (const [sessionId, state] of this.runtime) if (state.running) ids.push(sessionId)
    return ids
  }

  // ── 多通道加入（WP46 返工：一条 follow 服务多条通道） ──────────────────────

  /** 该会话现在有没有活着的跟随流（NodeSession 据此决定「加入」还是「新建 follow」）。 */
  isFollowing(sessionId: string): boolean {
    const handle = this.follows.get(sessionId)
    return handle !== undefined && !handle.ended
  }

  /**
   * 会话**当前**游标（与 history 的 throughSeq / `replay.toCursor` 同口径）。
   *
   * 取「opening cursor 与本条 follow 已见最大 seq」的较大者：只看 opening cursor 的话，
   * 加入者会以为「没有新消息可补」（打开 follow 之后产生的消息 seq 都大于它）。
   */
  private followCursor(sessionId: string): number | null {
    const handle = this.follows.get(sessionId)
    if (handle !== undefined) {
      if (handle.cursor !== null) return Math.max(handle.cursor, handle.latestSeq)
      if (handle.latestSeq > 0) return handle.latestSeq
    }
    return this.runtime.get(sessionId)?.cursor ?? null
  }

  /** 最近一次推给客户端的 `assistant-baseline`（加入者补基线用；没有进行中的 attempt = null）。 */
  sessionBaseline(sessionId: string): Extract<MobileServerFrame, { type: 'assistant-baseline' }> | null {
    return this.baselines.get(sessionId) ?? null
  }

  /** 最近一次的白名单投影值（加入者补 `state` 帧用；顺序不稳定，键唯一）。 */
  sessionProjections(sessionId: string): ReadonlyArray<{ key: string; value: unknown }> {
    const cached = this.projections.get(sessionId)
    if (cached === undefined) return []
    return [...cached].map(([key, value]) => ({ key, value }))
  }

  /**
   * 给**后来加入**某会话的通道补一次断线追赶（WP46）。
   *
   * 与 `handleFollowItem` 里的 catch-up 是同一套逻辑，区别是帧只回调给调用方：
   * Hub 的 NodeSession 只把这一串帧发给发起 `subscribe` 的那条通道，
   * 不动已有的 follow，也不让别的订阅者收到重复消息。
   */
  async catchUpFor(sessionId: string, sinceCursor: number | null, emit: FrameSink): Promise<'ok' | 'gap'> {
    if (sinceCursor === null) return 'ok'
    const cursor = this.followCursor(sessionId)
    if (cursor === null || sinceCursor >= cursor) return 'ok'
    const complete = await this.catchUp(sessionId, sinceCursor, cursor, {}, emit)
    return complete ? 'ok' : 'gap'
  }

  /** 记住一条白名单投影（有界：最多 128 个会话，最旧的先丢）。 */
  private rememberProjection(sessionId: string, key: string, value: unknown): void {
    let map = this.projections.get(sessionId)
    if (map === undefined) {
      if (this.projections.size >= MAX_CACHED_SESSIONS) {
        const oldest = this.projections.keys().next()
        if (!oldest.done) this.projections.delete(oldest.value)
      }
      map = new Map<string, unknown>()
      this.projections.set(sessionId, map)
    }
    map.set(key, value)
  }

  // ── 审批（$events waterfall） ─────────────────────────────────────────────

  /** 打开 `$events` 并等 ready 帧（拿到 clientId 才能回 result）。 */
  private async ensureEvents(): Promise<boolean> {
    if (this.events !== null && this.events.clientId !== '') return true
    if (this.eventsOpening !== null) return await this.eventsOpening
    this.eventsOpening = (async () => {
      let openedStreamId = ''
      const streamId = await this.mux.open(
        '$events',
        { args: {} },
        {
          onItem: (value) => {
            void this.handleEventsItem(openedStreamId, value)
          },
          onEnd: () => {
            this.events = null
            this.capabilities = { ...this.capabilities, approvals: false }
          },
          onError: () => {
            this.events = null
            this.capabilities = { ...this.capabilities, approvals: false }
          },
        },
      )
      openedStreamId = streamId
      if (this.events === null) this.events = { streamId, clientId: '' }
      let poll: NodeJS.Timeout | null = null
      const ready = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (poll !== null) clearInterval(poll)
          resolve(false)
        }, this.options.probeTimeoutMs ?? 5_000)
        timer.unref?.()
        poll = setInterval(() => {
          if (this.events !== null && this.events.clientId !== '') {
            if (poll !== null) clearInterval(poll)
            clearTimeout(timer)
            resolve(true)
          }
        }, 10)
        poll.unref?.()
      })
      if (poll !== null) clearInterval(poll)
      if (!ready || this.closed) {
        this.mux.cancel(streamId)
        if (!this.closed) this.events = null
        return false
      }
      this.capabilities = { ...this.capabilities, approvals: true }
      return true
    })()
    try {
      return await this.eventsOpening
    } catch {
      return false
    } finally {
      this.eventsOpening = null
    }
  }

  private async handleEventsItem(streamId: string, value: unknown): Promise<void> {
    const frame = asRecord(value)
    const type = frame['type']
    if (type === 'ready') {
      const clientId = typeof frame['clientId'] === 'string' ? frame['clientId'] : ''
      if (clientId !== '') {
        // ready 可能早于 open() 的赋值到达：以帧里的 streamId 为准
        if (this.events === null || this.events.clientId === '') this.events = { streamId, clientId }
      }
      return
    }
    if (type === 'cancel') {
      const eventId = typeof frame['eventId'] === 'string' ? frame['eventId'] : ''
      const pending = this.pendingApprovals.get(eventId)
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        this.pendingApprovals.delete(eventId)
        await this.emit({
          v: 1,
          type: 'approval-settled',
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          decision: 'expired',
        })
        return
      }
      // 电脑端先答：撤掉手机卡片并释放 claim
      for (const [key, question] of [...this.pendingQuestions]) {
        if (question.eventId !== eventId) continue
        if (question.timer !== null) clearTimeout(question.timer)
        question.hold?.()
        this.pendingQuestions.delete(key)
        await this.emit({
          v: 1,
          type: 'question-settled',
          sessionId: question.sessionId,
          callId: question.callId,
        })
      }
      return
    }
    if (type !== 'waterfall') return
    const eventName = typeof frame['event'] === 'string' ? frame['event'] : ''
    const eventId = typeof frame['eventId'] === 'string' ? frame['eventId'] : ''
    const agentId = typeof frame['agentId'] === 'string' ? frame['agentId'] : ''
    if (eventName === 'user-questions/request') {
      const request = asRecord(frame['request'])
      const wait = asRecord(request['wait'])
      // legacy blocking 提问没有 wait.callId：用稳定的 eventId 生成合成 key（不回给 Host 当 callId）
      const rawCallId = typeof wait['callId'] === 'string' ? wait['callId'] : ''
      const callId = rawCallId !== '' ? rawCallId : `evt:${eventId}`
      if (agentId === '' || eventId === '') return
      // WP46 park：**无论该会话当前有没有手机订阅**都接住，通道断开也不 next（M6 §1）。
      // 老行为：非当前订阅会话立即 next。
      if (this.parkMs === null && !this.subscribed.has(agentId)) {
        await this.sendEventsResult(eventId, { kind: 'next' }).catch(() => undefined)
        return
      }
      const questions = mapQuestions(request['questions'])
      const timed = wait['timed'] === true && rawCallId !== ''
      const key = `${agentId}:${callId}`
      const entry: {
        eventId: string
        sessionId: string
        callId: string
        questions: Question[]
        timer: NodeJS.Timeout | null
        hold: (() => void) | null
      } = {
        eventId,
        sessionId: agentId,
        callId,
        questions,
        timer: null,
        hold: null,
      }
      this.pendingQuestions.set(key, entry)
      const settleExpired = (): void => {
        if (this.pendingQuestions.get(key) !== entry) return
        if (entry.timer !== null) clearTimeout(entry.timer)
        this.pendingQuestions.delete(key)
        entry.hold?.()
        void this.sendEventsResult(eventId, { kind: 'next' }).catch(() => undefined)
        void this.emit({ v: 1, type: 'question-settled', sessionId: agentId, callId })
      }
      if (timed) {
        // 真实语义：timed 由 Host deadline 决定；手机侧用 attachWait 维持 claim，断开即释放。
        // 不用 120s 定时器假装延长。
        void this.holdQuestion(agentId, callId, () => settleExpired())
          .then((close) => {
            if (this.pendingQuestions.get(key) !== entry) {
              close?.()
              return
            }
            entry.hold = close
          })
          .catch(() => settleExpired())
      }
      if (this.parkMs !== null) {
        // 提问的 park 上限（M6 §1）：到了就交回 Host 的失败关闭，绝不自作主张回答。
        // legacy 提问本来没有 deadline，这一步就是它唯一的超时；timed 提问通常先被
        // Host deadline 结算（120s 级），上限只是个兜底。
        const parkTimer = setTimeout(() => settleExpired(), this.parkMs)
        parkTimer.unref()
        entry.timer = parkTimer
      }
      await this.emit({
        v: 1,
        type: 'question',
        sessionId: agentId,
        agent: agentId,
        callId,
        questions,
        state: 'open',
      })
      return
    }
    if (eventName !== 'approval/request') {
      // 其它 waterfall 立刻交回链尾，避免 Host 等待
      if (eventId !== '') await this.sendEventsResult(eventId, { kind: 'next' }).catch(() => undefined)
      return
    }
    if (agentId === '' || eventId === '') return
    // 老行为：非当前订阅会话立即 next（探针实测行为），不在手机上弹。
    // WP46 park：非订阅会话也接住（提问/审批不再绑在通道与订阅上）。
    if (this.parkMs === null && !this.subscribed.has(agentId)) {
      await this.sendEventsResult(eventId, { kind: 'next' }).catch(() => undefined)
      return
    }
    const request = asRecord(frame['request'])
    const approvalId = eventId
    const approval: ApprovalView = {
      sessionId: agentId,
      callId: typeof request['callId'] === 'string' ? request['callId'] : null,
      approvalId,
      tool: typeof request['toolName'] === 'string' ? request['toolName'] : 'unknown',
      ...(typeof request['displayReason'] === 'string'
        ? { reason: request['displayReason'] }
        : typeof request['reason'] === 'string'
          ? { reason: request['reason'] }
          : {}),
      answerable: true,
      actions: ['approve', 'reject', 'cancel'],
      state: 'open',
    }
    // park 模式：审批的等待上限就是 park 上限（默认 30 分钟），老行为保持 120 秒。
    // 两种情况都只回 next，**绝不自动批准**。
    const waitMs = this.parkMs ?? 120_000
    const timer = setTimeout(() => {
      this.pendingApprovals.delete(eventId)
      void this.sendEventsResult(eventId, { kind: 'next' }).catch(() => undefined)
      void this.emit({ v: 1, type: 'approval-settled', sessionId: agentId, approvalId, decision: 'expired' })
    }, waitMs)
    timer.unref()
    this.pendingApprovals.set(eventId, { approvalId, sessionId: agentId, agentId, timer, approval })
    await this.emit({ v: 1, type: 'approval', sessionId: agentId, approval })
  }

  private async handleApprovalAnswer(
    frame: Extract<MobileClientFrame, { type: 'answer-approval' }>,
    sink: FrameSink,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(frame.approvalId)
    if (pending === undefined || pending.sessionId !== frame.sessionId) {
      throw new HostRpcError('approval/not-found', '该审批已结算、已过期或不属于当前会话')
    }
    if (this.events === null || this.events.clientId === '') {
      throw new HostRpcError('approval/unavailable', '审批事件流尚未就绪')
    }
    // 先发结果；HTTP 失败时保留 pending（可重试/可取消），避免删了 pending 又没送达导致永久悬挂
    await this.sendEventsResult(frame.approvalId, {
      kind: 'result',
      value: frame.decision === 'approve' ? 'allowed-once' : 'rejected',
    })
    clearTimeout(pending.timer)
    this.pendingApprovals.delete(frame.approvalId)
    const settled = frame.decision
    await sink({
      v: 1,
      type: 'approval-settled',
      sessionId: frame.sessionId,
      approvalId: frame.approvalId,
      decision: settled,
    })
  }

  /**
   * 打开 `userQuestions/attachWait` 维持 timed claim；返回关闭函数。
   * 首帧 item 表示 Host 接受；此后 onEnd/onError（deadline/断线）必须显式 onReleased，
   * 否则手机上的卡片永远不会撤。本机主动 close（应答/取消/切会话）用 closedByUs 防重复释放。
   */
  private async holdQuestion(
    agentId: string,
    callId: string,
    onReleased: () => void,
  ): Promise<(() => void) | null> {
    const attempt: Array<'agentId' | 'agent'> =
      this.questionAgentParam === null ? ['agentId', 'agent'] : [this.questionAgentParam]
    for (const param of attempt) {
      let accepted = false
      let closedByUs = false
      let streamId = ''
      const release = (): void => {
        if (closedByUs) return
        closedByUs = true
        onReleased()
      }
      const close = (): void => {
        closedByUs = true
        if (streamId !== '') this.mux.cancel(streamId)
      }
      const outcome = await new Promise<
        { kind: 'accepted'; close: () => void } | { kind: 'validation' } | { kind: 'released' }
      >((resolve) => {
        let settled = false
        const finish = (
          value: { kind: 'accepted'; close: () => void } | { kind: 'validation' } | { kind: 'released' },
        ): void => {
          if (settled) return
          settled = true
          resolve(value)
        }
        const timer = setTimeout(() => {
          accepted = true
          finish({ kind: 'accepted', close })
        }, 3_000)
        timer.unref?.()
        void this.mux
          .open(
            'userQuestions/attachWait',
            { args: { [param]: agentId, callId } },
            {
              onItem: () => {
                if (accepted) return
                accepted = true
                clearTimeout(timer)
                finish({ kind: 'accepted', close })
              },
              onEnd: () => {
                clearTimeout(timer)
                if (accepted) {
                  release()
                  return
                }
                finish({ kind: 'released' })
              },
              onError: (error) => {
                clearTimeout(timer)
                const validation =
                  error.code === 'gateway/arguments-invalid' ||
                  error.code === 'gateway/input-invalid' ||
                  error.code === 'gateway/bad-request'
                if (accepted) {
                  release()
                  return
                }
                finish(validation ? { kind: 'validation' } : { kind: 'released' })
              },
            },
          )
          .then((id) => {
            streamId = id
            if (settled) this.mux.cancel(id)
          })
          .catch(() => {
            clearTimeout(timer)
            finish({ kind: 'validation' })
          })
      })
      if (outcome.kind === 'accepted') {
        this.questionAgentParam = param
        return outcome.close
      }
      if (outcome.kind === 'released') {
        release()
        return null
      }
    }
    onReleased()
    return null
  }

  private async sendEventsResult(eventId: string, outcome: unknown): Promise<void> {
    const events = this.events
    if (events === null || events.clientId === '')
      throw new HostRpcError('approval/unavailable', '审批事件流尚未就绪')
    await this.http.unary('$events/result', { clientId: events.clientId, eventId, outcome })
  }

  private async emit(frame: MobileServerFrame): Promise<void> {
    const sink = this.sink
    if (sink === null) return
    await sink(frame)
  }

  /** 补发 (from, to] 区间的持久消息；按 seq 升序，去重。 */
  private async catchUp(
    sessionId: string,
    from: number,
    to: number,
    snapshot: Record<string, unknown>,
    sink: FrameSink,
  ): Promise<boolean> {
    const seen = new Map<number, HistoryItem>()
    // 先吃 snapshot 自带的 records（真实 follow 的 opening window）
    const snapshotRecords = Array.isArray(snapshot['records']) ? snapshot['records'] : []
    for (const item of mapRecords(snapshotRecords)) {
      if (item.seq > from && item.seq <= to) seen.set(item.seq, item)
    }
    let beforeSeq: number | null = null
    let coveredFrom = false
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page = asRecord(
        await this.http.unary('session/page', {
          request: {
            address: { kind: 'session', sessionId },
            throughSeq: to,
            ...(beforeSeq === null ? {} : { beforeSeq }),
          },
        }),
      )
      const records = Array.isArray(page['records']) ? page['records'] : []
      const items = mapRecords(records)
      for (const item of items) {
        if (item.seq > from && item.seq <= to) seen.set(item.seq, item)
      }
      const oldest = items[0]?.seq
      // 固定 throughSeq=to（opening cursor），只向前翻 beforeSeq
      if (oldest === undefined || oldest <= from + 1) {
        coveredFrom = true
        break
      }
      if (page['hasMore'] !== true) {
        coveredFrom = true
        break
      }
      beforeSeq = oldest
    }
    // snapshot.records 若已覆盖起点也算追到
    if (seen.size > 0 && Math.min(...seen.keys()) <= from + 1) coveredFrom = true
    if (!coveredFrom) return false
    for (const item of [...seen.values()].sort((left, right) => left.seq - right.seq)) {
      if (item.role === 'tool') continue
      await sink({
        v: 1,
        type: 'message',
        sessionId,
        seq: item.seq,
        role: item.role,
        at: item.at,
        text: item.text,
        ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
        ...(item.tools === undefined ? {} : { tools: item.tools }),
      })
    }
    return true
  }

  // ── 游标 ──────────────────────────────────────────────────────────────────

  /**
   * 历史页的 `throughSeq` 必须取自「对应 follow 的 opening cursor」。
   * 已有订阅就复用；没有就开一条临时 follow 读到 snapshot 再取消。
   */
  private async cursorFor(sessionId: string): Promise<number | null> {
    const existing = this.follows.get(sessionId)
    if (existing !== undefined) {
      // 已订阅：取「opening cursor 与本通道已见最大 seq」的较大者
      if (existing.cursor !== null) return Math.max(existing.cursor, existing.latestSeq)
      if (existing.latestSeq > 0) return existing.latestSeq
      // 已有 follow 但还没收到 opening snapshot：等它，而不是返回 null（并发 history/subscribe 竞态）
      return await Promise.race([
        existing.cursorReady,
        new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), this.options.cursorTimeoutMs ?? 8_000)
          timer.unref?.()
        }),
      ])
    }
    // 冷启动/刚重连时第一条 mux 连接 + Host follow 建立可能比 probe 慢：
    // 用独立的 cursorTimeoutMs，并且失败后立刻再试一次（mux 可能刚连上）。
    this.cursorFailure = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cursor = await this.openFollowForCursor(sessionId)
      if (cursor !== null) return cursor
      if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 250))
    }
    return null
  }

  /** 开一条临时 follow 只为读 opening snapshot.cursor（cursorFor 的单次尝试）。 */
  private async openFollowForCursor(sessionId: string): Promise<number | null> {
    return await new Promise<number | null>((resolve) => {
      let settled = false
      const finish = (cursor: number | null): void => {
        if (settled) return
        settled = true
        this.mux.cancel(streamId)
        resolve(cursor)
      }
      let streamId = ''
      void this.mux
        .open(
          'session/follow',
          // 与正式订阅保持同一组参数（assistantStream 让 Host 走同一条 follow 路径）
          { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } },
          {
            onItem: (value) => {
              const frame = asRecord(value)
              if (frame['type'] !== 'snapshot') return
              finish(typeof frame['cursor'] === 'number' ? frame['cursor'] : null)
            },
            onEnd: () => {
              this.cursorFailure = 'Host 结束了临时 follow'
              finish(null)
            },
            onError: (error: unknown) => {
              const rec = asRecord(error)
              const code = typeof rec['code'] === 'string' ? rec['code'] : 'error'
              const message = typeof rec['message'] === 'string' ? rec['message'] : ''
              this.cursorFailure = message === '' ? code : `${code}: ${message}`
              finish(null)
            },
          },
        )
        .then((id) => {
          streamId = id
          if (settled) this.mux.cancel(id)
        })
        .catch(() => finish(null))
      setTimeout(() => finish(null), this.options.cursorTimeoutMs ?? 8_000).unref?.()
    })
  }

  // ── 错误 ──────────────────────────────────────────────────────────────────

  private classify(error: unknown): [MobileErrorCode, string, boolean] {
    if (error instanceof HostRpcError) {
      if (MISSING_ENDPOINT_CODES.has(error.code)) {
        return ['adapter-incompatible', `Host 缺少端点（${error.code}）`, false]
      }
      if (error.code === 'session/not-found') return ['session-not-found', error.message, false]
      if (error.code === 'session/agent-busy') return ['agent-busy', error.message, true]
      if (error.code === 'gateway/rate-limited' || error.code === 'rate-limited') {
        return ['rate-limited', error.message, true]
      }
      if (error.code === 'question/not-found' || error.code === 'question/settled') {
        return ['question-not-answerable', error.message, false]
      }
      if (error.code === 'approval/not-found' || error.code === 'approval/expired') {
        return ['approval-not-answerable', error.message, false]
      }
      if (error.code === 'approval/unavailable') {
        return ['approval-not-answerable', error.message, true]
      }
      // ── v2：adapter 自己抛的码直接透传（已经在白名单里） ──
      const passthrough = V2_PASSTHROUGH_CODES.get(error.code)
      if (passthrough !== undefined) return [passthrough, error.message, passthrough === 'model-unavailable']
      // ── v2：DSH 原始码必须映射，不透给 App ──
      if (error.code === 'session/model-unavailable') return ['model-unavailable', error.message, true]
      if (error.code === 'agent-preset/not-found') return ['preset-not-found', error.message, false]
      if (error.code === 'session/title-invalid') return ['title-invalid', error.message, false]
      if (error.code === 'workspace-file/not-found') return ['file-not-found', error.message, false]
      if (error.code === 'workspace-file/too-large') return ['file-too-large', error.message, false]
      if (error.code === 'workspace-file/not-text') return ['file-not-text', error.message, false]
      if (error.code === 'workspace-file/outside-workspace')
        return ['file-refused', '不允许访问该路径', false]
      if (error.code === 'workspace/session-active') {
        return ['agent-busy', '会话正在运行，先停止再归档', false]
      }
      // adapter 自己抛的「上游暂时不可用」（例如容器刚唤醒时 session/follow 还没给出
      // snapshot.cursor）：必须是可重试的 upstream-unavailable，不能当 internal 打死。
      // （真机 2026-10-26 21:01 红条原文就是因为这里落到了 internal。）
      if (error.code === 'upstream-unavailable') return ['upstream-unavailable', error.message, true]
      if (error.code === 'session/attachment-invalid') {
        return ['internal', `附件无法处理（${error.message}），请重新选择文件`, false]
      }
      return ['internal', `${error.code}: ${error.message}`, false]
    }
    if (error instanceof HostTransportError) {
      return ['upstream-unavailable', error.message, true]
    }
    return ['internal', messageOf(error), false]
  }

  private errorFrame(
    requestId: string | undefined,
    code: MobileErrorCode,
    message: string,
    retryable: boolean,
  ): MobileServerFrame {
    return {
      v: 1,
      type: 'error',
      ...(requestId === undefined ? {} : { requestId }),
      code,
      message,
      retryable,
    }
  }
}

function muxError(error: MuxFrameError): [MobileErrorCode, string, boolean] {
  if (MISSING_ENDPOINT_CODES.has(error.code)) {
    return ['adapter-incompatible', `Host 缺少流端点（${error.code}）`, false]
  }
  if (error.code === 'session/not-found') return ['session-not-found', error.message, false]
  return ['adapter-unavailable', `${error.code}: ${error.message}`, true]
}

function emptyCapabilities(): NodeCapabilities {
  return {
    sessions: false,
    history: false,
    send: false,
    stop: false,
    stream: false,
    questions: false,
    approvals: false,
    create: false,
  }
}

function requestIdOf(frame: MobileClientFrame): string | undefined {
  if (frame.type === 'unsubscribe' || frame.type === 'ping' || frame.type === 'upload-abort') return undefined
  return frame.requestId
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function titleOf(item: Record<string, unknown>): string | null {
  const projections = asRecord(item['projections'])
  const values = asRecord(projections['values'])
  const title = values['title']
  return typeof title === 'string' ? title : null
}

/** 注入消息的 source.kind（`runtime-context` / `time-context` …）不是用户输入。 */
function sourceRpcIdKind(source: unknown): string | null {
  const record = asRecord(source)
  return typeof record['kind'] === 'string' ? record['kind'] : null
}

/** 助手消息里的 reasoning 块（顺序是 `[reasoning, text]`；**不**与正文混在一起）。 */
function reasoningOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record['type'] === 'reasoning' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('')
}

/** 只在 `source.kind==='user'` 时读 rpcId；其它来源一律不猜。 */
function sourceRpcId(source: unknown): string | undefined {
  const record = asRecord(source)
  if (record['kind'] !== 'user') return undefined
  return typeof record['rpcId'] === 'string' && record['rpcId'] !== '' ? record['rpcId'] : undefined
}

/** 逐 role 取消息体：user/message 是 UserMessage 本体，其余是 {message,...}。 */
function messageBodyOf(eventName: string, data: Record<string, unknown>): Record<string, unknown> {
  if (eventName === 'user/message') return data
  return asRecord(data['message'])
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('')
}

function mapRecords(records: readonly unknown[]): HistoryItem[] {
  const items: HistoryItem[] = []
  for (const raw of records) {
    const record = asRecord(raw)
    if (record['type'] !== 'event') continue
    const event = asRecord(record['event'])
    const name = typeof event['type'] === 'string' ? event['type'] : ''
    const seq = typeof event['seq'] === 'number' ? event['seq'] : 0
    const at = typeof event['time'] === 'number' ? event['time'] : 0
    const data = asRecord(event['data'])
    const message = messageBodyOf(name, data)
    if (name === 'user/message') {
      // v1 缺陷 ①：注入消息（runtime-context / time-context）不是用户说的话
      if (sourceRpcIdKind(data['source']) !== 'user') continue
      const rpcId = sourceRpcId(data['source'])
      items.push({
        seq,
        role: 'user',
        at,
        text: textOfContent(message['content']),
        ...(rpcId === undefined ? {} : { clientMessageId: rpcId }),
      })
      continue
    }
    if (name === 'assistant/message') {
      const tools = toolNamesOf(message)
      const reasoning = reasoningOfContent(message['content'])
      items.push({
        seq,
        role: 'assistant',
        at,
        text: textOfContent(message['content']),
        ...(tools.length === 0 ? {} : { tools }),
        ...(reasoning === '' ? {} : { reasoning: truncateUtf8(reasoning, 16 * 1024).text }),
      })
      continue
    }
    if (name === 'developer/message' || name === 'system/message') {
      items.push({ seq, role: 'system', at, text: textOfContent(message['content']) })
    }
  }
  return items
}

function toolNamesOf(message: Record<string, unknown>): string[] {
  const content = message['content']
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record['type'] === 'tool-call' && typeof record['name'] === 'string') names.push(record['name'])
  }
  return names
}

/**
 * 真实 StreamChunk（`packages/llm/llm/src/types.ts:478-483`）：
 * `text-delta{index,text}` / `reasoning-delta{index,text}` / `tool-call-delta{index,id,name?,argumentsDelta}`
 * 以及 block-start/end/usage/finish 等。**不再有任何“带 text 就当归答”的兜底**。
 */
function classifyChunk(chunk: unknown): { kind: 'text' | 'reasoning' | 'tool' | 'unknown'; text?: string } {
  const record = asRecord(chunk)
  const type = typeof record['type'] === 'string' ? record['type'] : ''
  if (type === 'text-delta') {
    return typeof record['text'] === 'string' ? { kind: 'text', text: record['text'] } : { kind: 'unknown' }
  }
  if (type === 'reasoning-delta') {
    return typeof record['text'] === 'string'
      ? { kind: 'reasoning', text: record['text'] }
      : { kind: 'unknown' }
  }
  if (type === 'tool-call-delta') return { kind: 'tool' }
  return { kind: 'unknown' }
}

function mapQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return []
  const questions: Question[] = []
  for (const raw of value) {
    const record = asRecord(raw)
    const id = typeof record['id'] === 'string' ? record['id'] : null
    const question = typeof record['question'] === 'string' ? record['question'] : null
    if (id === null || question === null) continue
    const options = Array.isArray(record['options'])
      ? record['options'].flatMap((item) => {
          const option = asRecord(item)
          const label = typeof option['label'] === 'string' ? option['label'] : null
          if (label === null) return []
          return [
            {
              label,
              ...(typeof option['description'] === 'string' ? { description: option['description'] } : {}),
            },
          ]
        })
      : undefined
    questions.push({
      id,
      question,
      ...(typeof record['detail'] === 'string' ? { detail: record['detail'] } : {}),
      ...(typeof record['header'] === 'string' ? { header: record['header'] } : {}),
      ...(options === undefined ? {} : { options }),
      ...(record['multiSelect'] === true ? { multiSelect: true } : {}),
    })
  }
  return questions
}

/**
 * 探测用的**已知非法载荷**：`__dsh_hub_probe` 不在任何端点 schema 的 properties 里，
 * 且 strictCodec 是 `additionalProperties:false`，所以 Host 会在**业务调用之前**
 * 以 `gateway/arguments-invalid` 拒绝（README：*The Host validates the received wire
 * fields before business invocation*）。因此探测不会建会话、不会发消息、不会取消任何运行。
 */
const PROBE_PAYLOAD = { __dsh_hub_probe: true }

const PROBE_ENDPOINTS: ReadonlyArray<readonly [string, keyof NodeCapabilities]> = [
  ['session/list', 'sessions'],
  ['session/page', 'history'],
  ['session/prompt', 'send'],
  ['session/cancel', 'stop'],
  ['session/create', 'create'],
  ['userQuestions/answer', 'questions'],
  ['workspace/initializeDefault', 'create'],
]

/**
 * 用**真实调用**探测能力：对每个端点发一个空参数请求，
 * 只有「端点不存在」类错误才算缺；参数/业务错误说明端点在本 Host 上存在。
 * 这样既不产生副作用（不会建会话、不会发消息），也不靠配置自述。
 */
async function probe(http: HostHttp): Promise<{
  capabilities: NodeCapabilities
  missing: string[]
  failure?: { endpoint: string; code: string }
}> {
  const capabilities: NodeCapabilities = {
    sessions: false,
    history: false,
    send: false,
    stop: false,
    stream: false,
    questions: false,
    approvals: false,
    create: false,
  }
  const missing: string[] = []
  const presentByKey = new Map<keyof NodeCapabilities, boolean>()
  for (const [endpoint, key] of PROBE_ENDPOINTS) {
    const envelope = await http.call(endpoint, PROBE_PAYLOAD).catch((error: unknown) => ({
      ok: false as const,
      error: { code: `transport/${messageOf(error)}`, message: messageOf(error) },
    }))
    const code = envelope.ok ? null : (envelope.error?.code ?? 'internal')
    if (code === null) {
      // 非法载荷被「成功接受」= 未证明业务调用前拒绝，探测不安全：立即停止，不继续试写端点
      return {
        capabilities: emptyCapabilities(),
        missing: [],
        failure: { endpoint, code: 'unsafe-probe:invalid-payload-accepted' },
      }
    }
    const verdict = classifyProbeError(code)
    if (verdict === 'failed') {
      // fail closed：鉴权/网络/内部错误不能让能力伪装成 true
      return {
        capabilities: emptyCapabilities(),
        missing: [],
        failure: { endpoint, code },
      }
    }
    const present = verdict === 'present'
    presentByKey.set(key, (presentByKey.get(key) ?? true) && present)
    if (!present) missing.push(endpoint)
  }
  for (const [key, present] of presentByKey) capabilities[key] = present
  // 流式与历史同源（session/follow 与 session/page 同一个控制器）；
  // 真正的流端点判定发生在第一次 subscribe 的 mux.open 错误上。
  capabilities.stream = capabilities.sessions && capabilities.history
  if (!capabilities.stream) missing.push('session/follow')
  capabilities.approvals = false
  return { capabilities, missing }
}

/**
 * 只读能力探测（M3 readiness / 列表探测用）：
 * - unary：非法载荷（业务调用前被拒）；
 * - stream：真的开一条 `session/follow`（非法载荷）；
 * - **不**打开 `$events`：那是 answering peer，会点亮 `hasLiveClient`。
 */
export async function probeNodeRemote(options: NodeRemoteOptions): Promise<NodeProbeResult> {
  const http = new HostHttp({
    origin: options.origin,
    headers: options.headers ?? (() => ({})),
    fetch: options.fetch,
    timeoutMs: options.probeTimeoutMs ?? 5_000,
    log: options.log,
  })
  const probeResult = await probe(http)
  const { capabilities, missing } = probeResult
  if (probeResult.failure !== undefined) {
    return {
      compatible: false,
      capabilities,
      missing,
      failure: `${probeResult.failure.endpoint}: ${probeResult.failure.code}`,
    }
  }
  if (capabilities.sessions && capabilities.history) {
    const origin = new URL(options.origin)
    const wsProtocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
    const mux = new MuxConnection({
      url: `${wsProtocol}//${origin.host}/api/remote.mux`,
      headers: options.headers ?? (() => ({})),
      createWebSocket: options.createWebSocket,
      log: options.log,
    })
    let failure: string | null = null
    const present = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), options.probeTimeoutMs ?? 5_000)
      timer.unref?.()
      void mux
        .open(
          'session/follow',
          { args: { request: PROBE_PAYLOAD } },
          {
            onItem: () => finish(false),
            onEnd: () => finish(false),
            onError: (error) => {
              const verdict = classifyProbeError(error.code)
              if (verdict === 'failed') {
                failure = `session/follow: ${error.code}`
                finish(false)
                return
              }
              finish(verdict === 'present')
            },
          },
        )
        .then((streamId) => {
          if (settled) mux.cancel(streamId)
        })
        .catch(() => finish(false))
    })
    await mux.close()
    if (failure !== null)
      return { compatible: false, capabilities: emptyCapabilities(), missing: [], failure }
    capabilities.stream = present
    if (!present) missing.push('session/follow')
  } else {
    capabilities.stream = false
  }
  capabilities.approvals = false
  return { compatible: missing.length === 0, capabilities, missing }
}

/** 创建 adapter：先做只读探测；缺关键端点抛 `NodeRemoteIncompatibleError`。 */
export async function createNodeRemote(options: NodeRemoteOptions): Promise<NodeRemote> {
  const probe = await probeNodeRemote(options)
  if (probe.failure !== undefined)
    throw new NodeRemoteProbeError(probe.failure, probe.failure, 'probe-failed')
  const adapter = new RemoteAdapter(options, probe.capabilities, probe.missing)
  if (!adapter.compatible) {
    await adapter.close()
    throw new NodeRemoteIncompatibleError(probe.missing)
  }
  return adapter
}

export { NodeRemoteIncompatibleError }
