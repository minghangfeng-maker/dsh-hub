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
    if (task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    this.begin(task)
  }

  /** 取消并让 Hub 丢掉已收字节（`upload-abort` 没有回帧）。 */
  cancel(localId: string): void {
    const task = this.tasks.get(localId)
    if (!task) return
    if (task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    task.state = 'cancelled'
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
      if (task.state === 'uploading' && task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    }
    this.tasks.clear()
    this.chunkRequests.clear()
    this.publish()
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
    task.state = 'ready'
    task.uploadId = frame.uploadId
    task.received = frame.bytes
    task.expiresAt = frame.expiresAt
    task.error = null
    this.publish()
  }

  /** 错误帧（`error` + 上传类 requestId）：整条回退到 failed。返回 true = 已处理。 */
  failRequest(requestId: string, message: string): boolean {
    const record = this.deps.requests.peek(requestId)
    if (!record || (record.kind !== 'upload-begin' && record.kind !== 'upload-chunk')) return false
    const entry = this.chunkRequests.get(requestId)
    this.deps.requests.take(requestId)
    if (!entry) return true
    const task = this.tasks.get(entry.localId)
    this.forgetRequests(entry.localId)
    if (!task) return true
    // 分片失败可重试：整条上传回退到 failed，用户点一下从头来（Hub 丢旧字节）。
    if (task.uploadId) this.deps.send(uploadAbort(task.uploadId))
    this.fail(task, message)
    return true
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private begin(task: UploadTask): void {
    task.state = 'uploading'
    task.received = 0
    task.nextSeq = 0
    task.uploadId = null
    task.error = null
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

  private sendNextChunk(task: UploadTask): void {
    if (task.state !== 'uploading' || task.uploadId === null) return
    const chunk = nextUploadChunk(task)
    if (!chunk) return
    const requestId = this.deps.requests.nextId()
    this.deps.requests.track(requestId, { kind: 'upload-chunk', sessionId: task.sessionId })
    this.chunkRequests.set(requestId, { localId: task.localId, seq: chunk.seq })
    task.nextSeq = chunk.seq + 1
    task.requestId = requestId
    if (!this.deps.send(uploadChunk(requestId, task.uploadId, chunk.seq, chunk.data, chunk.final))) {
      this.fail(task, errorMessage('not-connected'))
      return
    }
    this.publish()
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
    task.state = 'failed'
    task.error = message
    this.publish()
  }

  private publish(): void {
    const uploads: UploadTaskView[] = [...this.tasks.values()].map(uploadView)
    this.deps.patch({ uploads })
  }
}
