/**
 * 附件上传（v2 g）：分片窗口 = 1、按 localId 记住任务、失败可从头上传。
 *
 * 规则：
 *  - `upload-begin → upload-started` 给出 uploadId 与单片上限，然后按窗口 1 发片：
 *    这一片 `upload-received` 确认了才发下一片，最后一片确认后等 `uploaded`；
 *  - 进度按服务端回报的累计字节**只增不减**（乱序/重放不会让进度倒退）；
 *  - `uploaded` 帧带的是最后一片的 requestId，所以 `upload-received` 里**不能**删
 *    requestId → localId 的映射（A2 实现时踩过：附件永远停在 uploading）；
 *  - 失败整条回退到 failed（Hub 丢旧字节），用户可以点重试从头来；
 *  - 只有 `ready` 的附件能进 `send.attachments[]`。
 *
 * 0.4.14 起的三个兜底（2026-11-10 真机：15.9 MiB 的 HTML 永远停在「发送中…」）：
 *  1. **发出节流** `MIN_CHUNK_INTERVAL_MS`：窗口 = 1 的连续分片每片只花一个 RTT，
 *     低延迟链路上天然 20~30 片/秒；老 Hub 的上行配额是 20 帧/秒且**把分片也算进去**，
 *     片被拒后整条上传就没人推了。限到 15 片/秒，控制帧也留出余量；
 *  2. **在飞片看门狗** `CHUNK_STALL_MS`：回包丢了（通道抖动、服务端重启）就同一 seq
 *     重发，最多 `CHUNK_RESEND_LIMIT` 次，然后**整条判失败**——气泡给「重试」，
 *     绝不留下一个永远「发送中…」的僵尸任务；
 *  3. **`rate-limited` 退避重发**：Hub 在转发前就拒了这一片（同一 seq 重发安全），
 *     按 `RATE_LIMIT_BACKOFF_MS × n` 退避重发；老 Hub 的拒绝帧没有 requestId，
 *     由通道级错误钩子 `onChannelPressure()` 兜住同样的情况。
 */

import { uploadAbort, uploadBegin, uploadChunk } from './wire.js'
import {
  createUploadTask,
  nextUploadChunk,
  toOutgoingAttachment,
  uploadView,
  type UploadInput,
  type UploadTask,
  type UploadTaskView,
} from './upload.js'
import { randomId } from './ids.js'
import { errorMessage } from '../errors.js'
import type { MobileOutgoingAttachment } from '../contracts/mobile-v2.js'
import type { RequestFrame, RequestRegistry } from './requests.js'
import type { AnyServerFrame } from './wire.js'
import type { WorkspaceState } from './workspace-state.js'

/** 分片之间的最小间隔：15 片/秒 ≈ 1.9 MiB/s（详见文件头 §1）。 */
const MIN_CHUNK_INTERVAL_MS = 66
/** 一片发出去后这么久没有任何回音就当丢包重发。 */
const CHUNK_STALL_MS = 12_000
/** 同一片最多重发几次（看门狗），超过整条判失败。 */
const CHUNK_RESEND_LIMIT = 2
/** 收到 `rate-limited`（Hub 明确没转发）后的重发退避：第 n 次 = n × 该值。 */
const RATE_LIMIT_BACKOFF_MS = 800
/** 同一片被 `rate-limited` 最多退避重发几次。 */
const RATE_LIMIT_RESEND_LIMIT = 5
/** 通道级可重试错误（没有 requestId）后重发在飞片的延迟。 */
const CHANNEL_PRESSURE_BACKOFF_MS = 1_000

/** 每个任务最多三个计时器：节流、看门狗、退避重发。 */
type TimerKind = 'pace' | 'stall' | 'resend'
type TimerSlot = Record<TimerKind, ReturnType<typeof setTimeout> | null>

export interface UploadServiceDeps {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  send(frame: RequestFrame): boolean
  requests: RequestRegistry
  fail(code: string, message: string): void
}

export class UploadService {
  /** 上传任务（localId → task，含 base64；状态视图进 state.uploads）。 */
  private readonly tasks = new Map<string, UploadTask>()
  /** 分片 requestId → {localId, seq}，用于把 upload-received/uploaded 归位。 */
  private readonly chunkRequests = new Map<string, { localId: string; seq: number }>()
  /** localId → 计时器（节流/看门狗/退避），任务结束必须清掉，别让定时器拖着死任务。 */
  private readonly timers = new Map<string, TimerSlot>()

  constructor(private readonly deps: UploadServiceDeps) {}

  /**
   * 加一个附件并开始上传（当前会话）。
   *
   * 返回 localId；进度通过 `state.uploads` 推给 UI。上传失败可 `retry(localId)`，
   * 取消用 `cancel(localId)`。**只有 `ready` 的附件能进 `send.attachments[]`。**
   */
  uploadAttachment(sessionId: string, input: UploadInput): string | null {
    if (!this.deps.state().features.includes('attachments')) {
      this.deps.fail('feature-unsupported', '当前后端不支持上传附件')
      return null
    }
    const localId = `att_${randomId()}`
    const task = createUploadTask(localId, sessionId, input)
    this.tasks.set(localId, task)
    this.publish()
    this.begin(task)
    return localId
  }

  /** 重试一次失败的上传（同一个 localId，从头开始；旧 uploadId 由 Hub 丢弃）。 */
  retry(localId: string): void {
    const task = this.tasks.get(localId)
    if (!task) return
    if (task.state !== 'failed' && task.state !== 'cancelled') return
    this.clearTimers(localId)
    if (task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    this.begin(task)
  }

  /** 取消并让 Hub 丢掉已收字节（`upload-abort` 没有回帧）。 */
  cancel(localId: string): void {
    const task = this.tasks.get(localId)
    if (!task) return
    this.clearTimers(localId)
    if (task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    task.state = 'cancelled'
    task.inFlight = null
    this.publish()
  }

  /** 已就绪的附件（发消息时按 localId 取）。 */
  outgoingAttachment(localId: string): MobileOutgoingAttachment | null {
    const task = this.tasks.get(localId)
    return task ? toOutgoingAttachment(task) : null
  }

  /** 丢掉全部上传任务（会话切换/发送完成后由 UI 调）。 */
  clear(): void {
    for (const task of this.tasks.values()) {
      this.clearTimers(task.localId)
      if (task.state === 'uploading' && task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    }
    this.tasks.clear()
    this.chunkRequests.clear()
    this.timers.clear()
    this.publish()
  }

  /**
   * 通道级「可重试」错误的兜底钩子（**没有 requestId**，例如老 Hub 的「上行过快」）。
   *
   * 窗口 = 1 时最多只有一片在飞，退避后把它重发一遍即可（同一 seq 重发是安全的：
   * 被拒的帧没被转发，服务端的 nextSeq 没动）。返回 true = 有上传任务需要重发，
   * 调用方（error-router）据此不弹全局错误条。
   */
  onChannelPressure(): boolean {
    let touched = false
    for (const task of this.tasks.values()) {
      if (task.state !== 'uploading' || task.inFlight === null) continue
      touched = true
      this.scheduleResend(task, CHANNEL_PRESSURE_BACKOFF_MS)
    }
    return touched
  }

  // ── 帧处理 ────────────────────────────────────────────────────────────────

  onStarted(frame: Extract<AnyServerFrame, { type: 'upload-started' }>): void {
    const record = this.chunkRequests.get(frame.requestId)
    this.chunkRequests.delete(frame.requestId)
    this.deps.requests.delete(frame.requestId)
    const task = record ? this.tasks.get(record.localId) : undefined
    if (!task) return
    task.uploadId = frame.uploadId
    task.maxChunkBytes = frame.maxChunkBytes
    task.state = 'uploading'
    this.clearTimer(task.localId, 'stall')
    this.sendNextChunk(task)
  }

  onReceived(frame: Extract<AnyServerFrame, { type: 'upload-received' }>): void {
    const record = this.chunkRequests.get(frame.requestId)
    // **不要**在这里删 `chunkRequests`：`uploaded` 帧带的是最后一片的 requestId，
    // 删了就对不上任务（A2 实现时踩过：附件永远停在 uploading）。
    this.deps.requests.delete(frame.requestId)
    const task = record ? this.tasks.get(record.localId) : undefined
    if (!task) return
    // 服务端按原始字节回报累计值；只增不减（乱序/重放不会让进度倒退）。
    task.received = Math.max(task.received, frame.received)
    // 这一片确认了：清掉看门狗的计时器和在飞记录（`uploaded` 走同一个 requestId）。
    if (task.inFlight?.requestId === frame.requestId) task.inFlight = null
    this.clearTimer(task.localId, 'stall')
    this.publish()
    // 窗口 = 1：这一片确认了才发下一片；最后一片确认后等 `uploaded`。
    if (record !== undefined && frame.seq === task.nextSeq - 1) this.sendNextChunk(task)
  }

  onUploaded(frame: Extract<AnyServerFrame, { type: 'uploaded' }>): void {
    const record = this.chunkRequests.get(frame.requestId)
    this.deps.requests.delete(frame.requestId)
    const task = record ? this.tasks.get(record.localId) : undefined
    if (!task) return
    this.forgetRequests(task.localId)
    this.clearTimers(task.localId)
    task.state = 'ready'
    task.uploadId = frame.uploadId
    task.received = frame.bytes
    task.inFlight = null
    task.expiresAt = frame.expiresAt
    task.error = null
    this.publish()
  }

  /**
   * 错误帧（`error` + 上传类 requestId）。返回 true = 已处理。
   *
   * `rate-limited` 是**可恢复**的：Hub 在转发之前就把这一帧拒了，服务端的 NEXTSEQ 没动，
   * 同一 seq 退避重发是安全的；其它错误整条回退到 failed，用户点一下从头来。
   */
  failRequest(requestId: string, code: string, message: string): boolean {
    const record = this.deps.requests.peek(requestId)
    if (!record || (record.kind !== 'upload-begin' && record.kind !== 'upload-chunk')) return false
    const entry = this.chunkRequests.get(requestId)
    this.deps.requests.take(requestId)
    if (!entry) return true
    const task = this.tasks.get(entry.localId)
    if (!task) {
      this.forgetRequests(entry.localId)
      return true
    }
    if (code === 'rate-limited' && task.state === 'uploading' && task.inFlight?.requestId === requestId) {
      this.chunkRequests.delete(requestId)
      const inflight = task.inFlight
      if (inflight.resends < RATE_LIMIT_RESEND_LIMIT) {
        inflight.resends += 1
        this.scheduleResend(task, RATE_LIMIT_BACKOFF_MS * inflight.resends)
        return true
      }
      // 退避重发也一直被限：落到下面的失败分支，别让用户对着「发送中」干等
    }
    // 分片失败可重试：整条上传回退到 failed，用户点一下从头来（Hub 丢旧字节）。
    this.forgetRequests(entry.localId)
    this.clearTimers(entry.localId)
    if (task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    this.fail(task, message)
    return true
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private begin(task: UploadTask): void {
    this.clearTimers(task.localId)
    task.state = 'uploading'
    task.received = 0
    task.nextSeq = 0
    task.uploadId = null
    task.error = null
    task.inFlight = null
    task.lastSentAt = 0
    task.attempts += 1
    const requestId = this.deps.requests.nextId()
    this.deps.requests.track(requestId, { kind: 'upload-begin', sessionId: task.sessionId })
    this.chunkRequests.set(requestId, { localId: task.localId, seq: -1 })
    const frame = uploadBegin(requestId, task.sessionId, {
      kind: task.kind,
      name: task.name,
      mimeType: task.mimeType,
      bytes: task.bytes,
    })
    if (!this.deps.send(frame)) this.fail(task, errorMessage('not-connected'))
    this.publish()
  }

  /**
   * 发下一片（**带节流**：两片之间至少 `MIN_CHUNK_INTERVAL_MS`）。
   *
   * 节流不能省：窗口 = 1 时下一片是在 `upload-received` 里立刻发的，节奏 = 一个 RTT，
   * 手机 5G 上就是 20~30 片/秒；老 Hub 的上行配额 20 帧/秒把分片也算进去，
   * 超了就把片拒掉（历史上表现为「发送中…」永远不动）。
   */
  private sendNextChunk(task: UploadTask): void {
    if (task.state !== 'uploading' || task.uploadId === null) return
    const wait = task.lastSentAt + MIN_CHUNK_INTERVAL_MS - Date.now()
    if (wait > 0) {
      this.setTimer(task.localId, 'pace', () => this.sendNextChunk(task), wait)
      return
    }
    const chunk = nextUploadChunk(task)
    if (!chunk) return
    this.dispatchChunk(task, chunk.seq, chunk.data, chunk.final)
  }

  /** 真正发出一片并挂上看门狗（重发也走这里：同 seq、新 requestId）。 */
  private dispatchChunk(task: UploadTask, seq: number, data: string, final: boolean): void {
    if (task.state !== 'uploading' || task.uploadId === null) return
    const uploadId = task.uploadId
    const previous = task.inFlight
    const requestId = this.deps.requests.nextId()
    this.deps.requests.track(requestId, { kind: 'upload-chunk', sessionId: task.sessionId })
    this.chunkRequests.set(requestId, { localId: task.localId, seq })
    task.nextSeq = Math.max(task.nextSeq, seq + 1)
    task.requestId = requestId
    task.lastSentAt = Date.now()
    task.inFlight = {
      seq,
      data,
      final,
      requestId,
      resends: previous !== null && previous.seq === seq ? previous.resends : 0,
    }
    this.publish()
    if (!this.deps.send(uploadChunk(requestId, uploadId, seq, data, final))) {
      this.fail(task, errorMessage('not-connected'))
      return
    }
    this.armStallWatch(task, requestId)
  }

  /** 看门狗：这一片的回包丢了就同 seq 重发（最多 `CHUNK_RESEND_LIMIT` 次），再不行判失败。 */
  private armStallWatch(task: UploadTask, requestId: string): void {
    this.setTimer(
      task.localId,
      'stall',
      () => {
        const inflight = task.inFlight
        if (task.state !== 'uploading' || inflight === null || inflight.requestId !== requestId) return
        if (inflight.resends >= CHUNK_RESEND_LIMIT) {
          // 一直没回音：判失败，让待发气泡显示「附件上传失败」并提供重试
          this.clearTimers(task.localId)
          if (task.uploadId) this.deps.send(uploadAbort(task.uploadId))
          this.fail(task, '上传超时，请重试')
          return
        }
        inflight.resends += 1
        this.dispatchChunk(task, inflight.seq, inflight.data, inflight.final)
      },
      CHUNK_STALL_MS,
    )
  }

  /** 退避后重发在飞的那一片（rate-limited / 通道级压力）。 */
  private scheduleResend(task: UploadTask, delayMs: number): void {
    this.setTimer(
      task.localId,
      'resend',
      () => {
        const inflight = task.inFlight
        if (task.state !== 'uploading' || inflight === null) return
        this.dispatchChunk(task, inflight.seq, inflight.data, inflight.final)
      },
      delayMs,
    )
  }

  // ── 计时器 ────────────────────────────────────────────────────────────────

  private setTimer(localId: string, kind: TimerKind, run: () => void, ms: number): void {
    let slot = this.timers.get(localId)
    if (slot === undefined) {
      slot = { pace: null, stall: null, resend: null }
      this.timers.set(localId, slot)
    }
    const existing = slot[kind]
    if (existing !== null) clearTimeout(existing)
    const timer = setTimeout(() => {
      slot![kind] = null
      run()
    }, ms)
    // Node（单测）里定时器会挂住事件循环；浏览器里没有 unref
    ;(timer as unknown as { unref?: () => void }).unref?.()
    slot[kind] = timer
  }

  private clearTimer(localId: string, kind: TimerKind): void {
    const slot = this.timers.get(localId)
    if (slot === undefined) return
    const timer = slot[kind]
    if (timer !== null) clearTimeout(timer)
    slot[kind] = null
  }

  private clearTimers(localId: string): void {
    const slot = this.timers.get(localId)
    if (slot === undefined) return
    for (const kind of ['pace', 'stall', 'resend'] as const) {
      const timer = slot[kind]
      if (timer !== null) clearTimeout(timer)
      slot[kind] = null
    }
  }

  /** 清掉某个上传任务的全部 requestId 记录（成功、失败、取消都要清，避免表无限增长）。 */
  private forgetRequests(localId: string): void {
    for (const [requestId, record] of [...this.chunkRequests]) {
      if (record.localId === localId) {
        this.chunkRequests.delete(requestId)
        this.deps.requests.delete(requestId)
      }
    }
  }

  private fail(task: UploadTask, message: string): void {
    this.clearTimers(task.localId)
    task.inFlight = null
    task.state = 'failed'
    task.error = message
    this.publish()
  }

  private publish(): void {
    const uploads: UploadTaskView[] = [...this.tasks.values()].map(uploadView)
    this.deps.patch({ uploads })
  }
}
