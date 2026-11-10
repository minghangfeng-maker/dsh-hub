import { randomUUID } from 'node:crypto'
import {
  MOBILE_BULK_FRAME_MIN_CHARS,
  MOBILE_HEARTBEAT_MS,
  MOBILE_MAX_UPLINK_FPS,
  MOBILE_MAX_UPLOAD_FPS,
  MOBILE_PROTOCOL_VERSION,
  MOBILE_V2_FEATURE_OF_FRAME,
  MobileClientFrameAllSchema,
  type MobileClientFrameAll,
  type MobileErrorCode,
  type MobileErrorCodeV2,
  type MobileServerFrameAll,
  type MobileV2Feature,
} from '@dsh-hub/shared'
import type { WsConnection } from '../../lib/ws-upgrade.js'
import type { MobileChannelContext } from './types.js'

/**
 * 幂等缓存：key = `sessionId:clientMessageId`，由服务层按 `(userId,nodeId)` 共享，
 * 同一账号重连/第二条通道也能识别同一条消息。三态：
 * - `pending`：刚下发、尚未回帧 → 再发回 `send-in-flight`，不重复执行；
 * - `unknown`：超时/断链，Host 可能已经执行 → 同样不再自动发，提示人工确认；
 * - `done`：Host 明确 accepted → 重放 ack。
 * 只有**确凿、不可重试**的 Host 错误才删除条目。
 */
export class IdempotencyStore {
  private readonly entries = new Map<
    string,
    { at: number; state: 'pending' | 'unknown' | 'done'; frame?: MobileServerFrameAll }
  >()

  lookup(key: string): { state: 'pending' | 'unknown' | 'done'; frame?: MobileServerFrameAll } | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > 600_000) {
      this.entries.delete(key)
      return undefined
    }
    if (entry.state === 'done')
      return { state: 'done', ...(entry.frame === undefined ? {} : { frame: entry.frame }) }
    return { state: entry.state }
  }

  begin(key: string): void {
    if (this.entries.size >= 256) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { at: Date.now(), state: 'pending' })
  }

  complete(key: string, frame: MobileServerFrameAll): void {
    this.entries.set(key, { at: Date.now(), state: 'done', frame })
  }

  /** 确凿拒绝（Host 明确 error 且 retryable=false）：删除，允许重试。 */
  fail(key: string): void {
    this.entries.delete(key)
  }

  /** 超时/断链：结果未知，保留 unknown，不自动重发。 */
  markUnknown(key: string): void {
    this.entries.set(key, { at: Date.now(), state: 'unknown' })
  }

  /** 有界队列上限（供测试断言）。 */
  get size(): number {
    return this.entries.size
  }
}

const IDLE_CLOSE_MS = 45_000
/** 上游 adapter 关闭的上限：卡住也不能拖着手机侧不关（见 dispose 的注释） */
const UPSTREAM_CLOSE_MS = 3_000

function upstreamCloseMs(): number {
  const raw = Number(process.env['HUB_MOBILE_UPSTREAM_CLOSE_MS'] ?? '')
  // 注意空串：`Number('') === 0`，只判 isFinite 会让默认值永远不生效
  return Number.isFinite(raw) && raw > 0 ? raw : UPSTREAM_CLOSE_MS
}
/** 独立会话复查周期：**不**受消息重置，避免连续发送把复查饿死；测试可注入更短值。 */
const SESSION_RECHECK_MS = 20_000

/**
 * 该客户端帧需要哪个 v2 特性（§17 D1：所有 v2 行为都要先协商）。
 *
 * v2 独有帧看 `MOBILE_V2_FEATURE_OF_FRAME`；v1 帧的 v2 扩展字段单独判
 * （`create.model` / `send.attachments` / `sessions.includeArchived`）。
 */
function requiredFeatureOf(frame: MobileClientFrameAll): MobileV2Feature | null {
  const mapped = MOBILE_V2_FEATURE_OF_FRAME[frame.type]
  if (mapped !== undefined) return mapped
  if (frame.type === 'create') {
    if (frame.model !== undefined || frame.provider !== undefined || frame.effort !== undefined)
      return 'models'
    return null
  }
  if (frame.type === 'send') return (frame.attachments?.length ?? 0) > 0 ? 'attachments' : null
  if (frame.type === 'sessions') return frame.includeArchived === true ? 'archive' : null
  return null
}

function sessionRecheckMs(): number {
  const raw = Number(process.env['HUB_MOBILE_SESSION_RECHECK_MS'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : SESSION_RECHECK_MS
}

/**
 * P2 硬切开关（WP48 / 评估 §3.1）：`HUB_MOBILE_REQUIRE_V2=1` 时，hello 必须带**非空**
 * `features`。默认（未设 / 其他值）= 现行为，老客户端照旧能用。
 *
 * 为什么「空数组也算老客户端」：`features: []` 启用的特性集合与 v1 逐字节等价 ——
 * 硬切要挡的正是「这条通道一个 v2 特性都不会有」。P2 可以打开的前提见
 * （实测 `declared=[]` 计数为 0，观察 ≥7 天）。
 */
function requireV2(): boolean {
  return process.env['HUB_MOBILE_REQUIRE_V2'] === '1'
}

/** 入站队列上限：超过就断，不无限占内存。 */
const MAX_QUEUED_FRAMES = 64
/** 单连接同时处理的帧数（串行队列，恒为 1；保留常量便于以后并发化时约束）。 */
const MAX_INFLIGHT = 1

interface PendingSend {
  key: string
  sessionId: string
  clientMessageId: string
}

/**
 * 一条手机通道：帧校验、幂等、转发（云 adapter / 桌面中继）、心跳、会话复查。
 * 所有异步处理走**串行队列**：``void onText`` 不再无限并发。
 */
export class MobileChannel {
  readonly id = randomUUID()
  private readonly connection: WsConnection
  private readonly ctx: MobileChannelContext
  private readonly idempotency: IdempotencyStore
  private readonly log: (event: string, meta?: Record<string, unknown>) => void
  private readonly onDispose: (id: string) => void
  private helloReceived = false
  /** 服务端 hello 回显过的特性（未收到回显前不早拒，避免和 relay 的异步性打架）。 */
  private featuresKnown = false
  private enabledFeatures = new Set<string>()
  /** 通道是否已经挂到这个节点上（见 `attachSession` / `openRelay`：都推迟到 hello 之后）。 */
  private attached = false
  private relayOpened = false
  /** 客户端 hello 的自述（**只用于审计**，不含令牌与正文；WP48）。 */
  private clientName = ''
  private clientVersion = ''
  private declaredFeatures: MobileV2Feature[] = []
  private closed = false
  private queue: string[] = []
  private draining = false
  private inFlight = 0
  /** requestId → 待确认发送（错误按 requestId 精确解锁，绝不误伤其它请求）。 */
  private readonly pendingByRequest = new Map<string, PendingSend>()
  private readonly pendingByMessage = new Map<string, PendingSend>()
  private readonly timers: NodeJS.Timeout[] = []
  private lastUplinkAt = 0
  private uplinkWindow = 0
  /** 大帧（附件分片）的独立配额窗口，与上面控制帧的互不影响。 */
  private lastBulkAt = 0
  private bulkWindow = 0

  constructor(
    connection: WsConnection,
    ctx: MobileChannelContext,
    idempotency: IdempotencyStore,
    log: (event: string, meta?: Record<string, unknown>) => void,
    onDispose: (id: string) => void,
  ) {
    this.connection = connection
    this.ctx = ctx
    this.idempotency = idempotency
    this.log = log
    this.onDispose = onDispose
  }

  async start(): Promise<void> {
    // 节点侧的开销（挂 NodeSession / 让桌面建 adapter）**都推迟到 hello 通过之后**：
    // 见 `attachSession` 与 `openRelay`。这样 P2 硬切拒绝老客户端时，节点上什么都没发生。
    this.connection.onText((text) => this.enqueue(text))
    this.connection.onClose(() => {
      void this.dispose('client-closed', false)
    })
    if (this.ctx.node.kind === 'desktop') {
      // 只登记，不发 `open`：桌面 connector 收到 `open` 才会建这条通道的 adapter。
      // 登记本身要留在 start：中继断开时 Hub 得知道该给哪条通道发 `bye`。
      this.ctx.node.relay.channels.add(this.id)
    }
    this.schedule(MOBILE_HEARTBEAT_MS, () => {
      if (this.closed) return
      if (Date.now() - this.connection.lastActivityAt > IDLE_CLOSE_MS) {
        this.bye('internal', '连接空闲超时')
        return
      }
      this.connection.ping()
      // 应用层心跳：WS 的 ping/pong 是控制帧，浏览器 JS 看不到；长任务/等待审批时
      // 可能几十秒没有任何业务帧，App 端的存活检测会把「安静」误判成「死链」。
      // 这里每 25s 补一帧文本 pong（老客户端本来就认这个类型），让客户端始终有下行。
      this.send({ v: 1, type: 'pong', t: Date.now() })
    })
    // 会话复查独立于消息：即使只在收流，也会发现退出/停用/过期
    this.schedule(sessionRecheckMs(), () => {
      if (this.closed) return
      if (this.ctx.validateSession() === null) this.bye('session-expired', '登录态已失效')
    })
    this.ctx.audit('mobile.node.connect', { nodeId: this.ctx.nodeId })
  }

  /** 桌面中继推来的服务端帧；错误只解锁**精确对应**的发送。 */
  deliver(frame: MobileServerFrameAll): void {
    if (frame.type === 'ack' && frame.clientMessageId !== undefined) {
      const pending = this.pendingByMessage.get(frame.clientMessageId)
      if (pending !== undefined) {
        this.idempotency.complete(pending.key, frame)
        this.forget(pending)
      }
    } else if (frame.type === 'error') {
      const pending = frame.requestId === undefined ? undefined : this.pendingByRequest.get(frame.requestId)
      if (pending !== undefined) {
        // 可重试错误（上游不可用/超时）= 结果未知；确凿拒绝才允许重发
        if (frame.retryable) this.idempotency.markUnknown(pending.key)
        else this.idempotency.fail(pending.key)
        this.forget(pending)
      }
    }
    this.send(frame)
  }

  /**
   * 断链：所有在飞发送标 unknown（Host 可能已执行），再释放。
   *
   * **关闭顺序是安全属性**（M4 §16 的阻断问题）：先关手机这一侧的 socket，再拆上游。
   * 反过来的话，`remote.close()` 里只要有一次 HTTP 往返卡住（容器已被停掉、
   * 网络半开、Host 不响应 `$events/result`），客户端就永远收不到 WebSocket close ——
   * 手机上表现为「明明点了退出/被吊销，界面还以为连着」。
   * 上游清理现在放最后，并且有超时上限（超时就放弃，交给 GC 与 socket 自身的存活期）。
   */
  async dispose(reason: string, closeSocket = true): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    for (const pending of this.pendingByRequest.values()) this.idempotency.markUnknown(pending.key)
    this.pendingByRequest.clear()
    this.pendingByMessage.clear()
    if (this.ctx.node.kind === 'desktop') {
      // 中继侧只清记账并发一帧，同步完成，不会卡。
      // `open` 没发过就别说 close：桌面 connector 会对未知通道报一句
      // 「dropped a close for an unknown channel」（P2 拒绝的老客户端就是这种）。
      this.ctx.node.relay.channels.delete(this.id)
      if (this.relayOpened)
        this.ctx.node.relay.send({ v: 1, type: 'close', channelId: this.id, code: 'node-offline', reason })
    }
    // WP46：云节点的通道只是 NodeSession 的观察者 —— 断开只 detach，
    // **不关 adapter、不 next 未决提问**（这正是真机事故的根因）。
    if (this.ctx.node.kind === 'session') this.ctx.node.session.detach(this.id)
    this.onDispose(this.id)
    this.ctx.audit('mobile.node.disconnect', { nodeId: this.ctx.nodeId, reason })
    // 先让已排队的 bye 文本帧出队，再发 close 握手（否则客户端只看到 close）
    if (closeSocket && !this.connection.closed) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!this.connection.closed) this.connection.close(1000, reason)
    }
    // 上游清理放在最后，且不阻塞关闭：卡住时最多等 upstreamCloseMs()
    if (this.ctx.node.kind === 'cloud') {
      await withTimeout(this.ctx.node.remote.close().catch(() => undefined), upstreamCloseMs())
    }
  }

  private schedule(intervalMs: number, task: () => void): void {
    const timer = setInterval(task, intervalMs)
    timer.unref()
    this.timers.push(timer)
  }

  private enqueue(text: string): void {
    if (this.closed) return
    // 大帧（附件分片）走独立配额：按长度分流，热路径不做 JSON.parse。
    const bulk = text.length >= MOBILE_BULK_FRAME_MIN_CHARS
    if (!this.takeUplinkToken(bulk)) {
      // 拒绝帧必须能**指名道姓**：客户端只有拿到 requestId 才能把这一片判失败/重发。
      // 以前这里固定传 undefined，分片被拒后 App 的上传任务没有归属，气泡永远「发送中…」
      // （2026-11-10 真机：15.9 MiB 的 HTML 传到片 17 就停住）。
      this.sendErr(frameRequestIdOf(text), 'rate-limited', '上行过快', true)
      return
    }
    if (this.queue.length >= MAX_QUEUED_FRAMES) {
      this.bye('rate-limited', '上行积压过多')
      return
    }
    this.queue.push(text)
    void this.drain()
  }

  /**
   * 上行配额（固定 1 秒窗口，不排队，超限直接拒），分两档：
   * - 控制帧 20 帧/秒（`MOBILE_MAX_UPLINK_FPS`），防一条手机把 Hub 打满；
   * - 大帧（附件分片）60 帧/秒（`MOBILE_MAX_UPLOAD_FPS`）。窗口 = 1 的分片上传在
   *   低延迟链路上天然超过 20 片/秒，共用配额会把正常上传误杀。
   */
  private takeUplinkToken(bulk: boolean): boolean {
    const now = Date.now()
    if (bulk) {
      if (now - this.lastBulkAt >= 1_000) {
        this.lastBulkAt = now
        this.bulkWindow = 0
      }
      this.bulkWindow += 1
      return this.bulkWindow <= MOBILE_MAX_UPLOAD_FPS
    }
    if (now - this.lastUplinkAt >= 1_000) {
      this.lastUplinkAt = now
      this.uplinkWindow = 0
    }
    this.uplinkWindow += 1
    return this.uplinkWindow <= MOBILE_MAX_UPLINK_FPS
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.closed && this.queue.length > 0 && this.inFlight < MAX_INFLIGHT) {
        const text = this.queue.shift()
        if (text === undefined) break
        this.inFlight += 1
        try {
          await this.onText(text)
        } catch (error) {
          this.log('channel.frame-failed', {
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          this.inFlight -= 1
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async onText(text: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.sendErr(undefined, 'internal', '帧不是合法 JSON', false)
      return
    }
    const rawVersion =
      typeof parsed === 'object' && parsed !== null ? (parsed as { v?: unknown }).v : undefined
    if (rawVersion !== MOBILE_PROTOCOL_VERSION) {
      this.sendErr(
        undefined,
        'protocol-version-unsupported',
        `只支持协议 v${String(MOBILE_PROTOCOL_VERSION)}`,
        false,
      )
      return
    }
    const result = MobileClientFrameAllSchema.safeParse(parsed)
    if (!result.success) {
      // 诊断信息要能指名道姓：`strictObject` 遇到多余字段时 issue 的 path 是空的
      // （`unrecognized_keys` 把键名放在 `keys` 里），以前只能回一个「帧字段不合法：?」，
      // 客户端完全不知道是哪个字段（例如 App 误传了 create.cwd）。
      const issue = result.error.issues[0]
      const where = issue?.path.join('.') ?? ''
      const unknownKeys =
        issue !== undefined && 'keys' in issue && Array.isArray((issue as { keys?: unknown }).keys)
          ? ((issue as { keys: string[] }).keys.join(',') ?? '')
          : ''
      const field = where !== '' ? where : unknownKeys
      const requestId =
        typeof parsed === 'object' && parsed !== null && typeof (parsed as { requestId?: unknown }).requestId === 'string'
          ? (parsed as { requestId: string }).requestId
          : undefined
      this.sendErr(requestId, 'internal', `帧字段不合法：${field === '' ? '?' : field}`, false)
      return
    }
    const frame = result.data
    if (!this.helloReceived && frame.type !== 'hello') {
      this.sendErr(undefined, 'unauthenticated', '第一帧必须是 hello', false)
      return
    }
    if (frame.type === 'hello') {
      // 审计要的是「这条通道自述了什么」：名字/版本/声明集合，**不碰令牌与正文**。
      this.clientName = frame.client.name
      this.clientVersion = frame.client.version
      this.declaredFeatures = frame.features ?? []
      if (requireV2() && this.declaredFeatures.length === 0) {
        // P2 硬切：把老客户端挡在节点之外 —— hello 不派发（不建 adapter、不 attach
        // NodeSession），只回可读错误 + bye。App 侧对该码已有文案（`protocol-version-unsupported`）。
        const message = '客户端版本过旧，请升级 App'
        this.sendErr(frame.requestId, 'protocol-version-unsupported', message, false)
        this.bye('protocol-version-unsupported', message)
        return
      }
      this.helloReceived = true
    }
    const requiredFeature = requiredFeatureOf(frame)
    if (requiredFeature !== null && this.featuresKnown && !this.enabledFeatures.has(requiredFeature)) {
      // 节点没协商成功（老桌面端 / 老 Host）：立刻给可读原因，绝不让客户端干等
      this.sendErr(
        'requestId' in frame ? frame.requestId : undefined,
        'feature-unsupported',
        `该节点没有启用「${requiredFeature}」能力：请升级桌面端或 Hub`,
        false,
      )
      return
    }
    if (frame.type === 'ping') {
      this.send({ v: 1, type: 'pong', t: frame.t })
      return
    }
    if (frame.type === 'send') {
      const key = `${frame.sessionId}:${frame.clientMessageId}`
      const cached = this.idempotency.lookup(key)
      if (cached?.state === 'done' && cached.frame !== undefined) {
        this.send(cached.frame)
        return
      }
      if (cached !== undefined) {
        this.sendErr(
          frame.requestId,
          'send-in-flight',
          '这条消息上次的结果未知或仍在发送：请先看会话里是否已出现，不要连续重发',
          false,
        )
        return
      }
      this.idempotency.begin(key)
      const pending: PendingSend = { key, sessionId: frame.sessionId, clientMessageId: frame.clientMessageId }
      this.pendingByRequest.set(frame.requestId, pending)
      this.pendingByMessage.set(frame.clientMessageId, pending)
      await this.route(frame, pending)
      return
    }
    await this.route(frame)
  }

  private forget(pending: PendingSend): void {
    for (const [requestId, value] of this.pendingByRequest) {
      if (value === pending) this.pendingByRequest.delete(requestId)
    }
    this.pendingByMessage.delete(pending.clientMessageId)
  }

  private async route(frame: MobileClientFrameAll, pending?: PendingSend): Promise<void> {
    if (this.ctx.node.kind === 'desktop') {
      // 桌面 connector 收到 `open` 就为这条通道建 adapter（`relay.ts` 的 `openChannel`），
      // 所以推迟到这里：能走到 route 的帧已经过了 hello 校验（含 P2 硬切）。
      // 顺序仍是 open → frame：connector 会把 frame 排在 adapter 创建之后（`forward`）。
      this.openRelay()
      this.ctx.node.relay.send({ v: 1, type: 'frame', channelId: this.id, payload: frame })
      return
    }
    if (this.ctx.node.kind === 'session') {
      // 挂载同样推迟到第一帧（必是 hello）**之前**：adapter 的 hello 回包是同步走 sink 的，
      // 晚一步挂就会丢帧。P2 拒绝的老客户端永远走不到这里，NodeSession 上不会留下通道。
      this.attachSession()
      // 共享 adapter：NodeSession 负责 requestId→通道 的路由，回包（ack/error）仍走
      // `deliver()`，所以幂等记账一行都不用改。
      await this.ctx.node.session.dispatch(this.id, frame)
      return
    }
    await this.ctx.node.remote.dispatch(frame, (out) => {
      if (pending !== undefined) {
        if (out.type === 'ack') {
          this.idempotency.complete(pending.key, out)
          this.forget(pending)
        } else if (out.type === 'error') {
          if (out.retryable) this.idempotency.markUnknown(pending.key)
          else this.idempotency.fail(pending.key)
          this.forget(pending)
        }
      }
      this.send(out)
    })
  }

  /** 把这条通道挂到常驻会话代理上（幂等；只有 session 节点有）。 */
  private attachSession(): void {
    if (this.attached || this.ctx.node.kind !== 'session') return
    this.attached = true
    this.ctx.node.session.attach(this.id, (frame) => this.deliver(frame))
  }

  /** 让桌面中继为这条通道建 adapter（幂等；只有 desktop 节点有）。 */
  private openRelay(): void {
    if (this.relayOpened || this.ctx.node.kind !== 'desktop') return
    this.relayOpened = true
    this.ctx.node.relay.send({ v: 1, type: 'open', channelId: this.id, nodeId: this.ctx.nodeId })
  }

  private send(frame: MobileServerFrameAll): void {
    if (this.closed) return
    // 服务端 hello 会回显**实际启用**的 v2 特性（§17 D1）：客户端只认这个，
    // 通道层也拿它做早拒（老桌面 adapter 不认识 v2 帧，不回帧会让 App 干等）。
    if (frame.type === 'hello') {
      const { frame: out, enabled } = this.echoedHello(frame)
      this.featuresKnown = true
      this.enabledFeatures = new Set(enabled)
      this.auditHello(enabled)
      this.connection.send(JSON.stringify(out))
      return
    }
    this.connection.send(JSON.stringify(frame))
  }

  /**
   * 这条通道**真正回显给手机**的 hello（WP48）。
   *
   * 桌面中继只放行 v1 的 11 种客户端帧（评估 R1）：中继没声明 `relayFeatures` 时，
   * adapter 回显的 v2 特性在手机上只会点亮「点了没反应」的界面。所以按中继声明求交，
   * 交集为空就整块降级成 v1 形状（`features` / `capabilitiesV2` 都不下发）。
   */
  private echoedHello(frame: Extract<MobileServerFrameAll, { type: 'hello' }>): {
    frame: MobileServerFrameAll
    enabled: MobileV2Feature[]
  } {
    const echoed = frame.features ?? []
    if (this.ctx.node.kind !== 'desktop') return { frame, enabled: echoed }
    const allowed = this.ctx.node.relay.relayFeatures
    const enabled =
      allowed === null || allowed.length === 0 ? [] : echoed.filter((feature) => allowed.includes(feature))
    if (enabled.length > 0) return { frame: { ...frame, features: enabled }, enabled }
    // 一个特性都不能用时，连两个 v2 字段一起摘掉：与老客户端看到的 hello 逐字节一致。
    const { features: _features, capabilitiesV2: _capabilitiesV2, ...rest } = frame
    return { frame: rest as MobileServerFrameAll, enabled }
  }

  /**
   * P0 审计：一条 `mobile.hello`（评估 §3.1，判断「能否硬切 v1」的唯一硬证据）。
   *
   * `enabled` 是**该通道实际回显**的集合（WP46 之后由 NodeSession 按通道改写、桌面还要
   * 再过中继声明），不是 adapter 对整个节点算出来的集合。`v2` 表示这条通道真的在跑 v2：
   * 客户端声明了、节点也真回显了 —— 「声明了但回显为空」正是评估 R1 的假 v2，能被数出来。
   */
  private auditHello(enabled: readonly MobileV2Feature[]): void {
    const declared = [...this.declaredFeatures]
    this.ctx.audit('mobile.hello', {
      nodeId: this.ctx.nodeId,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      declared,
      enabled: [...enabled],
      v2: declared.length > 0 && enabled.length > 0,
    })
  }

  private sendErr(
    requestId: string | undefined,
    code: MobileErrorCodeV2,
    message: string,
    retryable: boolean,
  ): void {
    this.send({
      v: 1,
      type: 'error',
      ...(requestId === undefined ? {} : { requestId }),
      code,
      message,
      retryable,
    })
  }

  private bye(code: MobileErrorCode, reason: string): void {
    if (this.closed) return
    this.send({ v: 1, type: 'bye', code, reason })
    void this.dispose(code)
  }
}

/** 给一个可能永远不 resolve 的 Promise 加上限（到点就当它完成了） */
async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}

/**
 * 从**还没校验**的帧文本里抠出 `requestId`（只在限速拒绝这条冷路径上用）。
 *
 * 限速发生在 schema 校验之前（校验一条 192 KiB 的分片 JSON 比数一个计数器贵得多），
 * 所以拒绝时手里只有原始字符串。这里尽力而为：解析失败/没有 requestId 就返回
 * undefined，仍然照旧回一条不带归属的错误帧。
 */
function frameRequestIdOf(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const requestId = (parsed as { requestId?: unknown }).requestId
    return typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined
  } catch {
    return undefined
  }
}
