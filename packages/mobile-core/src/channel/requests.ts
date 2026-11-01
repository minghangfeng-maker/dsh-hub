/**
 * 请求关联器：**只有一处**生成 `requestId`、只有一张有界归属表、只有一套「等回包」写法。
 *
 * 拆分前 `WorkspaceController` 里有两种并行写法：
 *   - `RequestRecord`：只登记 `(kind, epoch, sessionId, beforeSeq)`，回包在各自 handler 里查表；
 *   - `PendingAction` / `PendingFile` / `uploadRequests`：各自维护 Map + Promise + 超时器。
 * 两套写法的超时语义、清理时机、错误优先级都不一样，是这个类里最容易叠补丁的地方。
 *
 * 这里把两套合成一套：
 *   - **所有**请求（幂等读、动作、文件、上传）都进同一张有界表（128 条，淘汰最旧）；
 *   - 需要回包的请求挂一个 waiter（`request()` 返回 `reply` Promise）；
 *   - 错误帧按 `kind` 分派给对应模块，模块用 `take()` 领走归属权；
 *   - 超时是 waiter 的属性（动作类「超时算失败但保留归属记录」，文件类「超时丢记录」）。
 *
 * 归属表的意义（M2 §5.2）：`epoch` 是会话代次，切会话不清表——旧会话的迟到回包仍能被
 * 识别为「过期」，从而不污染当前页；`sessionId` 让「同一会话」的语义可判。
 */

import type { MobileClientFrame, MobileClientFrameV2 } from './wire.js'

export type RequestFrame = MobileClientFrame | MobileClientFrameV2

export type RequestKind =
  | 'sessions'
  | 'history'
  | 'subscribe'
  | 'create'
  | 'stop'
  | 'answer-question'
  | 'answer-approval'
  | 'models'
  | 'set-model'
  | 'rename'
  | 'archive'
  | 'usage'
  | 'file'
  | 'upload-begin'
  | 'upload-chunk'
  /** 会话快照的幂等读（WP46 / M6 §2.2.4）。 */
  | 'session-state'

/** 有界归属的上限：超过就淘汰最旧（旧请求的回包此后按「归属未知」处理）。 */
export const MAX_TRACKED_REQUESTS = 128

export interface RequestMeta {
  kind: RequestKind
  sessionId?: string | null
  beforeSeq?: number | null
  includeArchived?: boolean
}

export interface RequestRecord extends RequestMeta {
  requestId: string
  /** 发起时的会话代次（与当前 `sessionEpoch` 不同 = 过期回包）。 */
  epoch: number
  sessionId: string | null
  beforeSeq: number | null
}

/** waiter 的结算方式（超时/帧发不出去时用）。 */
export type RequestSettlement<T> = { resolve: T } | { reject: unknown }

export interface RequestOptions<T> extends RequestMeta {
  /** 超时结算；`keepRecord` 见下方注释。 */
  timeout?: {
    ms: number
    settlement: RequestSettlement<T>
    /**
     * 超时后是否保留归属记录。
     *
     * 动作类（rename/archive/set-model）保留：旧实现只清 `pendingActions`，迟到回包仍会
     * 走「归属当前会话」的通用错误分支；文件类丢弃（旧实现超时即从 pendingFiles 删除，
     * 之后同 requestId 的回包一律忽略）。
     */
    keepRecord?: boolean
  }
  /** 帧没发出去（链路断了）时的结算；缺省 reject RequestNotSentError。 */
  notSent?: RequestSettlement<T>
}

export interface PendingRequest<T> {
  id: string
  reply: Promise<T>
}

/** 「帧没发出去」：与 `errorMessage('not-connected')` 同码，方便调用方映射成中文文案。 */
export class RequestNotSentError extends Error {
  readonly code = 'not-connected'

  constructor(message = '连接未就绪') {
    super(message)
    this.name = 'RequestNotSentError'
  }
}

type Settler = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export class RequestRegistry {
  private counter = 0
  private readonly records = new Map<string, RequestRecord>()
  private readonly waiters = new Map<string, Settler>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly send: (frame: RequestFrame) => boolean,
    private readonly epochOf: () => number,
    private readonly limit = MAX_TRACKED_REQUESTS,
  ) {}

  /** `a1`、`a2`…（旧实现同款：单调递增、会话切换不重置）。 */
  nextId(): string {
    this.counter += 1
    return `a${this.counter}`
  }

  /**
   * 登记一条归属记录（不发送）。超过上限淘汰最旧。
   *
   * 幂等读（history/sessions/subscribe/…）仍然走 `nextId() + track() + 自己发帧`：
   * 这类请求没有 waiter，回包由各自的 handler 认领。
   */
  track(requestId: string, meta: RequestMeta): RequestRecord {
    const record: RequestRecord = {
      requestId,
      kind: meta.kind,
      epoch: this.epochOf(),
      sessionId: meta.sessionId ?? null,
      beforeSeq: meta.beforeSeq ?? null,
      ...(meta.includeArchived === undefined ? {} : { includeArchived: meta.includeArchived }),
    }
    this.records.set(requestId, record)
    while (this.records.size > this.limit) {
      const eldest = this.records.keys().next().value
      if (eldest === undefined) break
      this.records.delete(eldest)
    }
    return record
  }

  /**
   * 只登记 + 挂 waiter（**不发送**）：给「帧必须在本地状态就位之后才能发」的调用方用
   * （文件下载要先装好装配器，否则回包可能比登记早到）。
   */
  reserve<T>(options: RequestMeta & Pick<RequestOptions<T>, 'timeout'>): PendingRequest<T> {
    const id = this.nextId()
    this.track(id, options)
    let settle!: Settler
    const reply = new Promise<T>((resolve, reject) => {
      settle = { resolve: resolve as (value: unknown) => void, reject }
    })
    this.waiters.set(id, settle)
    if (options.timeout) this.armTimeout(id, options.timeout)
    return { id, reply }
  }

  /**
   * 统一入口：分配 id、登记归属、挂 waiter、可选超时，然后发送。
   *
   * @returns `{ id, reply }`；帧没发出去时按 `notSent` 结算并返回 `null`
   *          （此时 `reply` 已被内部消化，不会产生未处理的 rejection）。
   */
  request<T>(makeFrame: (requestId: string) => RequestFrame, options: RequestOptions<T>): PendingRequest<T> | null {
    const call = this.reserve<T>(options)
    if (this.send(makeFrame(call.id))) return call

    const id = call.id
    const reply = call.reply
    this.clearTimer(id)
    const notSent: RequestSettlement<T> = options.notSent ?? { reject: new RequestNotSentError() }
    if ('resolve' in notSent) this.resolve(id, notSent.resolve)
    else this.reject(id, notSent.reject)
    // 调用方拿不到 reply（已经 return null），别留下未处理的 rejection。
    void reply.catch(() => {})
    return null
  }

  peek(requestId: string): RequestRecord | undefined {
    return this.records.get(requestId)
  }

  /** 认领归属权并删除记录（回包 handler 用；没有记录 = 不认识这个 requestId）。 */
  take(requestId: string): RequestRecord | undefined {
    const record = this.records.get(requestId)
    if (record === undefined) return undefined
    this.records.delete(requestId)
    return record
  }

  delete(requestId: string): void {
    this.records.delete(requestId)
  }

  has(requestId: string): boolean {
    return this.records.has(requestId)
  }

  hasWaiter(requestId: string): boolean {
    return this.waiters.has(requestId)
  }

  get size(): number {
    return this.records.size
  }

  /** 成功结算（只对还挂着的 waiter 生效）。返回 false = 没有等待者/已结算。 */
  resolve(requestId: string, value: unknown, keepRecord = false): boolean {
    const waiter = this.waiters.get(requestId)
    if (waiter === undefined) return false
    this.waiters.delete(requestId)
    this.clearTimer(requestId)
    if (!keepRecord) this.records.delete(requestId)
    waiter.resolve(value)
    return true
  }

  /** 失败结算（同上）。 */
  reject(requestId: string, error: unknown, keepRecord = false): boolean {
    const waiter = this.waiters.get(requestId)
    if (waiter === undefined) return false
    this.waiters.delete(requestId)
    this.clearTimer(requestId)
    if (!keepRecord) this.records.delete(requestId)
    waiter.reject(error)
    return true
  }

  private armTimeout<T>(requestId: string, timeout: NonNullable<RequestOptions<T>['timeout']>): void {
    if (timeout.ms <= 0) return
    const timer = setTimeout(() => {
      this.timers.delete(requestId)
      if (!this.waiters.has(requestId)) return
      if ('resolve' in timeout.settlement) {
        this.resolve(requestId, timeout.settlement.resolve, timeout.keepRecord ?? false)
      } else {
        this.reject(requestId, timeout.settlement.reject, timeout.keepRecord ?? false)
      }
    }, timeout.ms)
    this.timers.set(requestId, timer)
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(requestId)
  }
}
