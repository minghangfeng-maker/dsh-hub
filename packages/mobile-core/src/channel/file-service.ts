/**
 * 产出文件下载：分块组装、校验、重试、内存 + 持久缓存。
 *
 * 真机 0.2.14 反馈 ① ② 的修复都在这里：
 *  - 「交付物图片一直正在加载图片…」：读取失败要能重试（默认 3 次退避），
 *    明确拒绝（`file-refused`/`file-not-found`）立刻失败，UI 显示错误卡片而不是转圈；
 *  - 「重新打开会话交付物大概率超时」：下载一次后**落盘**（IndexedDB），重开会话
 *    先查持久缓存，命中就**不发 `file-read`**。
 *
 * 读取顺序：进程内 FileCache → 持久缓存 → 走通道（成功后同时写两级缓存）。
 * 通道断开时立刻失败在飞请求（`failAll`），不让每张图各等 30s。
 */

import {
  FileAssembler,
  FileCache,
  FileDownloadError,
  FileSequenceError,
  fileErrorCodeOf,
  fileErrorRetryable,
  verifyAssembled,
  type AssembledFile,
} from './files.js'
import { fileRead } from './wire.js'
import { fileCacheKeyOf, type FileStore } from '../cache/file-store.js'
import { errorMessage } from '../errors.js'
import type { PendingRequest, RequestFrame, RequestRegistry } from './requests.js'
import type { DownloadedFile, FileReadTarget, FrameOf, WorkspaceState } from './workspace-state.js'

const DEFAULT_FILE_TIMEOUT_MS = 30_000
const DEFAULT_FILE_RETRY_ATTEMPTS = 3
const DEFAULT_FILE_RETRY_BASE_MS = 700

export interface FileRetryConfig {
  attempts: number
  baseDelayMs: number
  timeoutMs: number
}

export interface FileServiceDeps {
  state(): WorkspaceState
  send(frame: RequestFrame): boolean
  requests: RequestRegistry
  log(event: string, meta?: Record<string, unknown>): void
  now(): number
  /** 产出文件缓存（UI 可注入共享实例）。 */
  cache: FileCache
  /** 持久缓存（跨重启） + 账号隔离键；两者都有才落盘。 */
  fileStore: FileStore | undefined
  accountKey: string | undefined
  retry: FileRetryConfig
}

interface PendingFile {
  requestId: string
  sessionId: string
  assembler: FileAssembler
  /** 请求侧缓存键（fileRef 或 `path:<路径>`）：持久缓存与内存缓存都用它。 */
  cacheKey: string
  expectBytes?: number
  meta: { name?: string; mimeType?: string; mediaType?: 'image' | 'file'; fileRef?: string; path?: string }
  timer: ReturnType<typeof setTimeout> | null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 按 opts.fileRetry 归一化下载策略（单测注入很小的值）。 */
export function fileRetryConfigOf(input: { attempts?: number; baseDelayMs?: number; timeoutMs?: number } = {}): FileRetryConfig {
  return {
    attempts: Math.max(1, Math.floor(input.attempts ?? DEFAULT_FILE_RETRY_ATTEMPTS)),
    baseDelayMs: Math.max(0, input.baseDelayMs ?? DEFAULT_FILE_RETRY_BASE_MS),
    timeoutMs: Math.max(1, input.timeoutMs ?? DEFAULT_FILE_TIMEOUT_MS),
  }
}

export class FileService {
  /** 正在下载的文件（requestId → 装配器 + 元信息）。 */
  private readonly pending = new Map<string, PendingFile>()

  constructor(private readonly deps: FileServiceDeps) {}

  /**
   * 读一个产出文件 / 对话内图片：成功返回**校验过 sha256** 的字节，失败抛错（中文消息）。
   *
   * 读取顺序：内存缓存 → 持久缓存（命中不发 file-read）→ 通道下载 → 写两级缓存。
   */
  async readFile(sessionId: string, target: FileReadTarget): Promise<DownloadedFile> {
    const cacheKey = fileCacheKeyOf(target)
    if (cacheKey === null) {
      throw new FileDownloadError('文件引用缺失，无法下载', 'file-refused', false)
    }
    const memory = this.deps.cache.get(sessionId, cacheKey)
    if (memory) {
      return this.toDownloaded(cacheKey, target, {
        fileRef: target.fileRef ?? cacheKey,
        name: memory.name,
        mimeType: memory.mimeType,
        mediaType: memory.mediaType,
        bytes: memory.data,
        ...(memory.sha256 === undefined ? {} : { sha256: memory.sha256 }),
      }, true)
    }
    // 没有持久缓存时保持**同步发帧**（老客户端/单测的时序依赖：调用后立刻看得到
    // `file-read`；这也少一次微任务，UI 首帧更快）。
    const persistentReady = this.persistentReady()
    const persisted = persistentReady ? await this.readPersistentFile(sessionId, cacheKey) : null
    if (persisted) {
      this.deps.cache.put({
        sessionId,
        fileRef: cacheKey,
        name: persisted.name,
        mimeType: persisted.mimeType,
        mediaType: persisted.mediaType,
        bytes: persisted.bytes.byteLength,
        data: persisted.bytes,
        ...(persisted.sha256 === undefined ? {} : { sha256: persisted.sha256 }),
      })
      this.deps.log('file-cache-hit', { bytes: persisted.bytes.byteLength, mediaType: persisted.mediaType })
      return this.toDownloaded(cacheKey, target, persisted, true)
    }

    const retry = this.deps.retry
    let lastError: unknown = null
    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      try {
        const file = await this.downloadOnce(sessionId, cacheKey, target, retry.timeoutMs)
        this.deps.log('file-download-ok', {
          bytes: file.bytes.byteLength,
          mediaType: file.mediaType,
          attempt,
        })
        // 落盘不阻塞返回（大文件写 IndexedDB 要几十 ms，别让图片多转一圈）。
        void this.persistFile(sessionId, cacheKey, file)
        return file
      } catch (error) {
        lastError = error
        const code = fileErrorCodeOf(error)
        if (attempt >= retry.attempts || !fileErrorRetryable(error)) {
          this.deps.log('file-download-failed', {
            code: code ?? 'unknown',
            attempt,
            retryable: fileErrorRetryable(error),
          })
          break
        }
        this.deps.log('file-download-retry', { code: code ?? 'unknown', attempt })
        await delay(retry.baseDelayMs * 2 ** (attempt - 1))
      }
    }
    throw lastError instanceof Error ? lastError : new FileDownloadError('文件下载失败', 'internal', true)
  }

  /** 通道断开：在飞的文件读取立刻失败（否则每条都要等自己的 30s 超时）。 */
  failAll(reason: string): void {
    if (this.pending.size === 0) return
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const file of pending) {
      if (file.timer) clearTimeout(file.timer)
      this.deps.requests.reject(file.requestId, new FileDownloadError(reason, 'not-connected', true))
    }
    this.deps.log('file-aborted', { count: pending.length })
  }

  /** 错误帧（`error` + 文件类 requestId）：按「是否可重试」拒绝。返回 true = 已处理。 */
  failRequest(requestId: string, message: string, code: string, retryable: boolean): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    if (pending.timer) clearTimeout(pending.timer)
    // 明确拒绝（路径越权/文件不存在/过大）不自动重试；链路类错误重试一次往往就好。
    this.deps.requests.reject(requestId, new FileDownloadError(message, code, retryable))
    return true
  }

  /** 一次性 `file` 帧（小文件走这条）。 */
  onFile(frame: FrameOf<'file'>): void {
    const pending = this.pending.get(frame.requestId)
    if (!pending) return
    if (frame.sessionId !== pending.sessionId) return
    this.forget(frame.requestId, pending)
    let assembled: AssembledFile
    try {
      assembled = FileAssembler.fromInline(frame.data, frame.bytes, frame.sha256)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.requests.reject(
        frame.requestId,
        new FileDownloadError(`文件装配失败：${reason}`, 'protocol', false),
      )
      return
    }
    void this.complete(pending, assembled, {
      bytes: frame.bytes,
      ...(frame.sha256 === undefined ? {} : { sha256: frame.sha256 }),
      name: frame.name,
      mimeType: frame.mimeType,
      mediaType: frame.mediaType,
      fileRef: frame.fileRef,
    })
  }

  /** 分片 `file-chunk`（大文件）：按 seq 严格装配，final 帧带总字节数与 sha256。 */
  onFileChunk(frame: FrameOf<'file-chunk'>): void {
    const pending = this.pending.get(frame.requestId)
    if (!pending) return
    if (frame.sessionId !== pending.sessionId) return
    let done: AssembledFile | null
    try {
      done = pending.assembler.push({ seq: frame.seq, data: frame.data, final: frame.final })
    } catch (error) {
      this.forget(frame.requestId, pending)
      const reason =
        error instanceof FileSequenceError || error instanceof Error ? error.message : String(error)
      this.deps.requests.reject(frame.requestId, new FileDownloadError(reason, 'protocol', false))
      return
    }
    if (!done || !frame.final) return
    this.forget(frame.requestId, pending)
    const meta = pending.meta
    void this.complete(pending, done, {
      ...(frame.bytes === undefined ? {} : { bytes: frame.bytes }),
      ...(frame.sha256 === undefined ? {} : { sha256: frame.sha256 }),
      ...(meta.name === undefined ? {} : { name: meta.name }),
      ...(meta.mimeType === undefined ? {} : { mimeType: meta.mimeType }),
      ...(meta.mediaType === undefined ? {} : { mediaType: meta.mediaType }),
      ...(frame.fileRef === '' ? {} : { fileRef: frame.fileRef }),
    })
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  /** 装配完成/失败都先把在飞登记摘掉（避免超时器再打一次）。 */
  private forget(requestId: string, pending: PendingFile): void {
    this.pending.delete(requestId)
    if (pending.timer) clearTimeout(pending.timer)
  }

  /** 走通道读一次（不含重试/缓存）。成功时写内存缓存并 resolve。 */
  private downloadOnce(
    sessionId: string,
    cacheKey: string,
    target: FileReadTarget,
    timeoutMs: number,
  ): Promise<DownloadedFile> {
    if (!this.deps.state().features.includes('files')) {
      return Promise.reject(
        new FileDownloadError(errorMessage('feature-unsupported'), 'feature-unsupported', false),
      )
    }
    // 先把装配器与超时器装好，再发帧（回包不能早于登记）。
    const call: PendingRequest<DownloadedFile> = this.deps.requests.reserve<DownloadedFile>({
      kind: 'file',
      sessionId,
    })
    const timer = setTimeout(() => {
      this.pending.delete(call.id)
      this.deps.requests.reject(call.id, new FileDownloadError(errorMessage('timeout'), 'timeout', true))
    }, timeoutMs)
    this.pending.set(call.id, {
      requestId: call.id,
      sessionId,
      assembler: new FileAssembler(),
      cacheKey,
      ...(target.bytes === undefined ? {} : { expectBytes: target.bytes }),
      meta: {
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.mimeType === undefined ? {} : { mimeType: target.mimeType }),
        ...(target.mediaType === undefined ? {} : { mediaType: target.mediaType }),
        ...(target.fileRef === undefined ? {} : { fileRef: target.fileRef }),
        ...(target.path === undefined ? {} : { path: target.path }),
      },
      timer,
    })
    if (!this.deps.send(fileRead(call.id, sessionId, target))) {
      clearTimeout(timer)
      this.pending.delete(call.id)
      this.deps.requests.reject(
        call.id,
        new FileDownloadError(errorMessage('not-connected'), 'not-connected', true),
      )
    }
    return call.reply
  }

  private async complete(
    pending: PendingFile,
    assembled: AssembledFile,
    meta: {
      bytes?: number
      sha256?: string
      fileRef?: string
      name?: string
      mimeType?: string
      mediaType?: 'image' | 'file'
    },
  ): Promise<void> {
    const check = await verifyAssembled(assembled, {
      ...(meta.bytes === undefined ? {} : { bytes: meta.bytes }),
      ...(meta.sha256 === undefined ? {} : { sha256: meta.sha256 }),
    })
    if (!check.ok) {
      // 坏字节绝不能显示成图片；但链路抖动导致的坏帧可以重读一次。
      this.deps.requests.reject(
        pending.requestId,
        new FileDownloadError(`文件校验失败：${check.reason}`, 'protocol', false),
      )
      return
    }
    const fileRef =
      meta.fileRef ??
      pending.meta.fileRef ??
      (pending.meta.path !== undefined ? `path:${pending.meta.path}` : '')
    const sha = meta.sha256 ?? assembled.sha256
    const file: DownloadedFile = {
      fileRef,
      ...(pending.meta.path === undefined ? {} : { path: pending.meta.path }),
      name: meta.name ?? pending.meta.name ?? 'file',
      mimeType: meta.mimeType ?? pending.meta.mimeType ?? 'application/octet-stream',
      mediaType: meta.mediaType ?? pending.meta.mediaType ?? 'file',
      bytes: assembled.bytes,
      ...(sha === undefined ? {} : { sha256: sha }),
      cacheKey: pending.cacheKey,
    }
    this.deps.cache.put({
      sessionId: pending.sessionId,
      // 内存缓存键用请求侧缓存键：按 path 读的文件也能被同一路径的下一次读取命中。
      fileRef: pending.cacheKey,
      name: file.name,
      mimeType: file.mimeType,
      mediaType: file.mediaType,
      bytes: file.bytes.byteLength,
      data: file.bytes,
      ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
    })
    this.deps.requests.resolve(pending.requestId, file)
  }

  /** 构造对外的 `DownloadedFile`（补 path/cacheKey/fromCache）。 */
  private toDownloaded(
    cacheKey: string,
    target: { fileRef?: string; path?: string },
    file: {
      fileRef: string
      name: string
      mimeType: string
      mediaType: 'image' | 'file'
      bytes: Uint8Array
      sha256?: string
    },
    fromCache: boolean,
  ): DownloadedFile {
    return {
      fileRef: file.fileRef,
      ...(target.path === undefined ? {} : { path: target.path }),
      name: file.name,
      mimeType: file.mimeType,
      mediaType: file.mediaType,
      bytes: file.bytes,
      ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
      cacheKey,
      fromCache,
    }
  }

  private persistentReady(): boolean {
    return this.deps.fileStore !== undefined && this.deps.accountKey !== undefined && this.deps.accountKey !== ''
  }

  /** 持久缓存命中：返回 null 表示未命中/缓存不可用（都继续走网络）。 */
  private async readPersistentFile(sessionId: string, cacheKey: string): Promise<DownloadedFile | null> {
    const store = this.deps.fileStore
    const accountKey = this.deps.accountKey
    if (!store || accountKey === undefined || accountKey === '') return null
    try {
      const hit = await store.get(accountKey, sessionId, cacheKey)
      if (!hit) return null
      return {
        fileRef: cacheKey.startsWith('path:') ? cacheKey.slice('path:'.length) : cacheKey,
        name: hit.name,
        mimeType: hit.mimeType,
        mediaType: hit.mediaType,
        bytes: hit.data,
        ...(hit.sha256 === undefined ? {} : { sha256: hit.sha256 }),
        cacheKey,
        fromCache: true,
      }
    } catch {
      return null
    }
  }

  /** 下载成功写持久缓存（失败只记诊断，绝不影响已经拿到的字节）。 */
  private async persistFile(sessionId: string, cacheKey: string, file: DownloadedFile): Promise<void> {
    const store = this.deps.fileStore
    const accountKey = this.deps.accountKey
    if (!store || accountKey === undefined || accountKey === '') return
    try {
      const now = this.deps.now()
      await store.put({
        accountKey,
        sessionId,
        key: cacheKey,
        name: file.name,
        mimeType: file.mimeType,
        mediaType: file.mediaType,
        bytes: file.bytes.byteLength,
        data: file.bytes,
        ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
        cachedAt: now,
        touchedAt: now,
      })
    } catch {
      this.deps.log('file-cache-write-failed')
    }
  }
}
