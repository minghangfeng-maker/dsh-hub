import { createHash } from 'node:crypto'

/**
 * v2 文本投影的纯函数：按 UTF-8 字节截断、抹掉 spill 路径、抽候选文件路径。
 *
 * 这些规则是**安全与体验的硬约束**（契约 §7.2、§8.2），所以放在独立模块里单测，
 * 不埋在 adapter 的流程代码里。
 */

/** UTF-8 字节数（不是字符数：中文 3 字节、emoji 4 字节）。 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 按码点边界截到 ≤ maxBytes 个 UTF-8 字节，截断处追加 `…`。
 *
 * 为什么要按码点：直接 `Buffer.subarray` 会把中文/emoji 截成半个，客户端渲染出替换符。
 * `…` 本身占 3 字节，所以预算里预留它。
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 }
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false }
  const ellipsis = '…'
  const budget = Math.max(0, maxBytes - utf8Bytes(ellipsis))
  let used = 0
  let out = ''
  for (const codePoint of text) {
    const size = utf8Bytes(codePoint)
    if (used + size > budget) break
    out += codePoint
    used += size
  }
  return { text: out + ellipsis, truncated: true }
}

/** DSH 的 spill 目录前缀；命中即视为「主机临时路径」，绝不转发。 */
const SPILL_PATH = /(?:^|[\s"'(])[^\s"')]*dsh-spill-[^\s"')]*/gu
/** spill 提示整段：`(Omitted N bytes. Full formatted result stored at: <locator>. <hint>)`。 */
const SPILL_NOTICE = /\((?:[^()]{0,120}?)Full formatted result stored at:[^)]*\)/gu
/** `(Omitted N bytes.)` 单独出现时也去掉（没有 locator 的变体）。 */
const SPILL_OMITTED = /\(Omitted [^()]{0,60}?bytes\.[^()]{0,160}?\)/gu

/**
 * 抹掉 spill 路径与省略提示。
 *
 * 契约 §7.2 规则 4 / §17：**禁止**把 DSH 的 spill 临时路径转发给手机
 * （泄漏主机目录结构，而且手机根本读不到）。
 */
export function redactSpill(text: string): string {
  return text
    .replace(SPILL_NOTICE, '(结果过长，已省略)')
    .replace(SPILL_OMITTED, '(结果过长，已省略)')
    .replace(SPILL_PATH, '<已省略>')
}

/** 是否包含 spill 路径（候选文件过滤用）。 */
export function hasSpillPath(text: string): boolean {
  return /dsh-spill-/u.test(text)
}

/** 文件 sha256（hex）。`file`/`file-chunk` 帧的完整性字段。 */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 允许作为「产出文件」出现的扩展名（契约 §8.2 规则 3）。 */
const CANDIDATE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'pdf',
  'md',
  'csv',
  'txt',
  'json',
  'xlsx',
  'docx',
  'pptx',
  'zip',
])

/** 单次扫描的正文上限（契约 §8.2 规则 2：只扫前 32 KiB）。 */
export const CANDIDATE_SCAN_BYTES = 32 * 1024
/** 每个工具结果最多的候选数（契约 §8.2 规则 4）。 */
export const CANDIDATE_LIMIT = 8

/**
 * 从工具输出里抽「像是产出文件」的路径 token（契约 §8.2）。
 *
 * 规则：含 `/` 或 `\`、以白名单扩展名结尾、不是 URL、不含 spill。
 * 这里只做**候选**；是否真的允许由 `stat` + 包含检查（`paths.ts`）决定。
 */
export function extractPathCandidates(text: string): string[] {
  const head = truncateUtf8(text, CANDIDATE_SCAN_BYTES).text
  const seen = new Set<string>()
  const out: string[] = []
  // 用空白/引号/括号/逗号切词，避免把整句当路径
  for (const raw of head.split(/[\s"'`()<>[\]{},;]+/u)) {
    if (raw.length === 0 || raw.length > 512) continue
    if (hasSpillPath(raw)) continue
    if (raw.includes('://')) continue
    if (!raw.includes('/') && !raw.includes('\\')) continue
    const cleaned = raw.replace(/[.:]+$/u, '').replace(/^[.*]+/u, '')
    const dot = cleaned.lastIndexOf('.')
    if (dot < 0) continue
    const extension = cleaned.slice(dot + 1).toLowerCase()
    if (!CANDIDATE_EXTENSIONS.has(extension)) continue
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
    if (out.length >= CANDIDATE_LIMIT) break
  }
  return out
}

/** 扩展名 → `image`/`file`（契约 §8.2 规则 6）。 */
export function mediaTypeOfPath(path: string): 'image' | 'file' {
  const dot = path.lastIndexOf('.')
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(extension) ? 'image' : 'file'
}

/** 展示名：只取叶子名（绝不带绝对路径）。 */
export function leafName(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const cut = normalized.lastIndexOf('/')
  return cut < 0 ? normalized : normalized.slice(cut + 1)
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  md: 'text/markdown',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

/** 按扩展名猜 MIME（拿不到 Content-Type 时用；`file` 帧必须给一个）。 */
export function mimeTypeOfPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}
