/**
 * 附件上传（M5 §9 / §17 D4：客户端**只发帧**，云节点与桌面节点同一套）。
 *
 * 协议：`upload-begin` → Hub 回 `upload-started{uploadId,maxChunkBytes}` → 逐片
 * `upload-chunk{seq,data,final}` → Hub 每片回 `upload-received{received}`，最后回
 * `uploaded{uploadId,expiresAt}`；`send.attachments[]` 只引用 `uploadId`。
 *
 * 为什么这里要单独一个状态机：
 * - **窗口 = 1**：一片确认了才发下一片。手机网络抖动时不能把 20MB 一次灌进 WS 缓冲；
 * - `maxChunkBytes` 由服务端给（云 144KiB 原始 → base64 192KiB），客户端不硬编码；
 * - base64 切片必须按 4 字符对齐，否则每一片都不是合法 base64。
 */

import type { MobileOutgoingAttachment } from '../contracts/mobile-v2.js'

/** 服务端没给 `maxChunkBytes` 时的保守默认（与 shared 的 144KiB 一致）。 */
export const DEFAULT_UPLOAD_CHUNK_RAW = 144 * 1024

export type UploadState = 'local' | 'uploading' | 'ready' | 'failed' | 'cancelled'

export interface UploadInput {
  kind: 'image' | 'file'
  name: string
  mimeType: string
  bytes: number
  /** 整个文件的 base64（App 端已在压缩后读成 base64）。 */
  data: string
}

export interface UploadTask extends UploadInput {
  localId: string
  sessionId: string
  state: UploadState
  /** Hub 签发；`ready` 之后有效。 */
  uploadId: string | null
  /** 已确认收到的字节数（按 upload-received 累加）。 */
  received: number
  /** 下一个要发的 seq。 */
  nextSeq: number
  /** 服务端给的单片原始字节上限。 */
  maxChunkBytes: number
  error: string | null
  attempts: number
  /** 当前在等待确认的 requestId（诊断用）。 */
  requestId: string | null
  expiresAt: number | null
}

/** 一条附件在 UI 里需要的视图（不含 base64，避免大字符串进响应式状态）。 */
export interface UploadTaskView {
  localId: string
  sessionId: string
  kind: 'image' | 'file'
  name: string
  mimeType: string
  bytes: number
  state: UploadState
  received: number
  progress: number
  error: string | null
  uploadId: string | null
  expiresAt: number | null
  attempts: number
}

export function createUploadTask(
  localId: string,
  sessionId: string,
  input: UploadInput,
): UploadTask {
  return {
    localId,
    sessionId,
    ...input,
    state: 'local',
    uploadId: null,
    received: 0,
    nextSeq: 0,
    maxChunkBytes: DEFAULT_UPLOAD_CHUNK_RAW,
    error: null,
    attempts: 0,
    requestId: null,
    expiresAt: null,
  }
}

export function uploadView(task: UploadTask): UploadTaskView {
  const progress = task.bytes <= 0 ? 0 : Math.min(1, task.received / task.bytes)
  return {
    localId: task.localId,
    sessionId: task.sessionId,
    kind: task.kind,
    name: task.name,
    mimeType: task.mimeType,
    bytes: task.bytes,
    state: task.state,
    received: task.received,
    progress,
    error: task.error,
    uploadId: task.uploadId,
    expiresAt: task.expiresAt,
    attempts: task.attempts,
  }
}

/**
 * 取下一片。返回 null 表示已经发完。
 *
 * base64 长度必须是 4 的倍数：`maxChunkBytes` 先按 3 的倍数向下取整再算 base64 长度，
 * 保证每一片独立可解。
 */
export function nextUploadChunk(
  task: UploadTask,
  maxChunkRaw = task.maxChunkBytes,
): { seq: number; data: string; final: boolean } | null {
  const raw = Math.max(3, Math.floor(maxChunkRaw / 3) * 3)
  const chunkChars = Math.ceil(raw / 3) * 4
  const offset = task.nextSeq * chunkChars
  if (offset >= task.data.length) return null
  const end = Math.min(offset + chunkChars, task.data.length)
  const data = task.data.slice(offset, end)
  // 去掉 base64 padding 后整段仍要能被 atob 解；末尾片可能带 padding，属于正常情况。
  const final = end >= task.data.length
  return { seq: task.nextSeq, data, final }
}

/** 已收字节换算（服务端按原始字节回报，这里只做展示兜底）。 */
export function progressOf(task: UploadTask): number {
  if (task.bytes <= 0) return 0
  return Math.min(1, task.received / task.bytes)
}

/** `send.attachments[]` 的一条：只引用 Hub 签发的 uploadId。 */
export function toOutgoingAttachment(task: UploadTask): MobileOutgoingAttachment | null {
  if (task.state !== 'ready' || task.uploadId === null) return null
  return {
    kind: task.kind,
    uploadId: task.uploadId,
    name: task.name,
    mimeType: task.mimeType,
    bytes: task.bytes,
  }
}

/** 附件上限（云 / 桌面分别限制，见 shared 常量）。 */
export function limitForBackend(kind: 'cloud' | 'desktop', fileKind: 'image' | 'file'): number {
  if (kind === 'desktop') return 1024 * 1024
  return fileKind === 'image' ? 5 * 1024 * 1024 : 20 * 1024 * 1024
}
