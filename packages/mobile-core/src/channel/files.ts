/**
 * 产出文件（交付物/工作区文件）的下载与缓存（M5 §8 / §17 D4：只用帧）。
 *
 * 分工：
 * - `FileAssembler`：把 `file`（一次性）或 `file-chunk`（分片）接到一起，校验 seq 连续、
 *   总字节数与 sha256（Hub 在 final 帧给）。**校验失败必须丢弃**，不能让手机显示坏图；
 * - `FileCache`：按「会话 + fileRef」缓存原始字节，带总字节上限（默认 32MiB）与 LRU 淘汰。
 *   只放内存：图片来自对话，退出登录/切账号时由 App 清空（§6.4 的隔离规则）。
 */

import type { MobileFileRef } from '../contracts/mobile-v2.js'

// ── base64 / 摘要 ───────────────────────────────────────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 → 字节。浏览器与 Node 18+ 都有 atob；坏输入抛错（调用方按坏帧处理）。 */
export function base64ToBytes(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0)
  const binary = atob(input)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** 字节 → base64（分片上传用；不依赖 Buffer）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk)
    out += String.fromCharCode(...slice)
  }
  return btoa(out)
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** SHA-256（十六进制小写）。用 Web Crypto：浏览器/Android WebView/Node 18+ 都有。 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const view = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : data.slice()
  const digest = await crypto.subtle.digest('SHA-256', view as unknown as ArrayBuffer)
  return bytesToHex(new Uint8Array(digest))
}

// ── 分片装配 ────────────────────────────────────────────────────────────────

export type AssembledFile = {
  bytes: Uint8Array
  /** Hub 在 final 帧声明的 sha256（可能没有：老 Hub）。 */
  sha256?: string
  /** final 帧声明的原始字节数。 */
  declaredBytes?: number
}

export class FileSequenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileSequenceError'
  }
}

/** 一次文件读的分片装配器：`seq` 必须从 0 连续递增。 */
export class FileAssembler {
  private readonly parts: Uint8Array[] = []
  private nextSeq = 0
  private size = 0

  get received(): number {
    return this.size
  }

  get expectedSeq(): number {
    return this.nextSeq
  }

  /** 一次性 `file` 帧：直接校验并返回。 */
  static fromInline(data: string, expectedBytes?: number, sha256?: string): AssembledFile {
    const bytes = base64ToBytes(data)
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
      throw new FileSequenceError(`文件字节数不符：收到 ${bytes.byteLength}，声明 ${expectedBytes}`)
    }
    return { bytes, ...(sha256 === undefined ? {} : { sha256 }), ...(expectedBytes === undefined ? {} : { declaredBytes: expectedBytes }) }
  }

  /** 追加一片；返回是否收完（`final`）。 */
  push(input: { seq: number; data: string; final: boolean }): AssembledFile | null {
    if (input.seq !== this.nextSeq) {
      throw new FileSequenceError(`分片序号不连续：期望 ${this.nextSeq}，收到 ${input.seq}`)
    }
    const bytes = base64ToBytes(input.data)
    this.parts.push(bytes)
    this.size += bytes.byteLength
    this.nextSeq += 1
    if (!input.final) return null
    return { bytes: this.concat() }
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.byteLength
    }
    return out
  }
}

/** 校验装配结果：字节数与 sha256 都要对得上（Hub 给了才校验）。 */
export async function verifyAssembled(
  assembled: AssembledFile,
  expected: { bytes?: number; sha256?: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (expected.bytes !== undefined && assembled.bytes.byteLength !== expected.bytes) {
    return { ok: false, reason: `字节数不符：收到 ${assembled.bytes.byteLength}，声明 ${expected.bytes}` }
  }
  const want = expected.sha256 ?? assembled.sha256
  if (want !== undefined && want !== '') {
    const actual = await sha256Hex(assembled.bytes)
    if (actual !== want) return { ok: false, reason: `sha256 不符：收到 ${actual}` }
  }
  return { ok: true }
}

// ── 缓存 ────────────────────────────────────────────────────────────────────

/**
 * 一次文件读取失败。
 *
 * 为什么需要类型而不只是 Error 文案：`readFile` 现在会**自动重试**（云容器刚唤醒/
 * 弱网时第一次读常常超时），而「路径被拒 / 文件不存在 / 超过上限」这类错误重试多少次
 * 都不会好——必须据此区分，否则 UI 会卡在无意义的重试上。
 */
export class FileDownloadError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(message: string, code = 'internal', retryable = false) {
    super(message)
    this.name = 'FileDownloadError'
    this.code = code
    this.retryable = retryable
  }
}

/** 重试也没用的错误码（adapter 已明确拒绝 / 文件根本不在）。 */
export const DEFINITIVE_FILE_ERROR_CODES: ReadonlySet<string> = new Set([
  'file-refused',
  'file-not-found',
  'file-too-large',
  'file-not-text',
  'feature-unsupported',
  'session-expired',
  'unauthenticated',
  'protocol-version-unsupported',
])

/** 从错误里取错误码（不是 FileDownloadError 时返回 null，调用方按「未知 → 可重试」处理）。 */
export function fileErrorCodeOf(error: unknown): string | null {
  return error instanceof FileDownloadError ? error.code : null
}

/**
 * 是否值得自动重试。
 *
 * 未知错误（装配/校验失败、传输层异常）按可重试处理：真机上这些多半是链路抖动，
 * 多读一次就恢复了；已知的明确拒绝则立刻失败，让 UI 显示「云端图片暂不可预览」。
 */
export function fileErrorRetryable(error: unknown): boolean {
  if (error instanceof FileDownloadError) return error.retryable
  return true
}

export interface CachedFile {
  sessionId: string
  fileRef: string
  name: string
  mimeType: string
  mediaType: 'image' | 'file'
  bytes: number
  data: Uint8Array
  sha256?: string
  fetchedAt: number
}

/**
 * 按会话缓存的已下载文件。
 *
 * 上限按**总字节**算（不是条数）：一张 5MB 的图就会吃掉六分之一预算，按条数算会爆内存。
 * 淘汰策略是 LRU；`clearSession` / `clearAll` 供切会话与退出登录用。
 */
export class FileCache {
  private readonly items = new Map<string, CachedFile>()
  private order: string[] = []
  private total = 0

  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}

  private key(sessionId: string, fileRef: string): string {
    return `${sessionId}\u0000${fileRef}`
  }

  get(sessionId: string, fileRef: string): CachedFile | null {
    const key = this.key(sessionId, fileRef)
    const hit = this.items.get(key)
    if (!hit) return null
    this.touch(key)
    return hit
  }

  put(input: Omit<CachedFile, 'fetchedAt'>): CachedFile {
    const entry: CachedFile = { ...input, fetchedAt: Date.now() }
    const key = this.key(entry.sessionId, entry.fileRef)
    const previous = this.items.get(key)
    if (previous) this.total -= previous.data.byteLength
    this.items.set(key, entry)
    this.total += entry.data.byteLength
    this.touch(key)
    this.evict()
    return entry
  }

  private touch(key: string): void {
    this.order = this.order.filter((item) => item !== key)
    this.order.push(key)
  }

  private evict(): void {
    while (this.total > this.maxBytes && this.order.length > 1) {
      const eldest = this.order.shift()
      if (eldest === undefined) break
      const entry = this.items.get(eldest)
      if (!entry) continue
      this.items.delete(eldest)
      this.total -= entry.data.byteLength
    }
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.items.keys()]) {
      if (!key.startsWith(prefix)) continue
      const entry = this.items.get(key)
      if (entry) this.total -= entry.data.byteLength
      this.items.delete(key)
    }
    this.order = this.order.filter((key) => !key.startsWith(prefix))
  }

  clearAll(): void {
    this.items.clear()
    this.order = []
    this.total = 0
  }

  stats(): { count: number; bytes: number } {
    return { count: this.items.size, bytes: this.total }
  }
}

/** 从工具/交付物帧里挑出图片（UI 内联显示用）。 */
export function imagesOf(files: readonly MobileFileRef[]): MobileFileRef[] {
  return files.filter((file) => file.mediaType === 'image')
}

/** 判断 MIME 是否可内联显示（保守白名单：只有图片与纯文本）。 */
export function inlineKindOf(mimeType: string | undefined): 'image' | 'text' | 'other' {
  if (!mimeType) return 'other'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text'
  return 'other'
}

/** 供 UI 生成可读文件名：去掉路径分隔与控制字符。 */
export function safeFileName(name: string, fallback = 'file'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback
}

/** 供 UI 显示大小。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export { B64_ALPHABET }
