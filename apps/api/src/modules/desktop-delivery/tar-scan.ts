import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { HubError } from '../../lib/errors.js'

/**
 * 只读 tar 条目名的**流式**扫描器（WP25b 的裁决 #16 检查 + LICENSE/NOTICE 检查）。
 *
 * 为什么不用 `plugins/tar.ts` 的 `readTarGz`：那个会把整包解到内存（`Buffer.from(data)` 每一条），
 * 而桌面整包可能是 160–450 MB 的平台包 —— 一次上传就能吃掉 1 GB。这里只走**头部**，
 * 文件数据直接跳过（不分配），并保留 pax（`x`）与 GNU LongLink（`L`）的长路径支持，
 * 免得「用长路径藏一个 claude 二进制」绕过检查。
 *
 * 上限：条目数（默认 5000）、解压后总字节（默认 1 GiB）—— 防 gzip 炸弹。
 */

const BLOCK = 512

export interface TarScanOptions {
  maxEntries?: number
  maxBytes?: number
}

export interface TarScanResult {
  /** 规范化后的条目名（`/` 分隔，去掉 `./` 前缀） */
  names: string[]
  /** 解压后的总字节数（用于诊断） */
  totalBytes: number
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const raw = buffer.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim()
  if (text.length === 0) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

function normalizeName(name: string): string {
  return name.replace(/^\.\//u, '').replace(/\/+$/u, '')
}

/** pax 头（typeflag `x`）里可能有 `path=` / `size=`（记录格式：`<len> <key>=<value>\n`） */
function parsePaxRecords(text: string): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {}
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space === -1) break
    const length = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break
    const record = text.slice(space + 1, offset + length - 1)
    const eq = record.indexOf('=')
    if (eq > 0) {
      const key = record.slice(0, eq)
      const value = record.slice(eq + 1)
      if (key === 'path') out.path = value
      if (key === 'size') {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed)) out.size = parsed
      }
    }
    offset += length
  }
  return out
}

/**
 * 扫描一个 `.tgz` 的条目名。**不落盘、不缓冲文件数据**；格式错误直接抛 VALIDATION_FAILED。
 */
export async function scanTarGzNames(file: string, opts: TarScanOptions = {}): Promise<TarScanResult> {
  const maxEntries = opts.maxEntries ?? 5000
  const maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024
  const names: string[] = []
  let totalBytes = 0
  let buffer: Buffer = Buffer.alloc(0)

  // 状态机：header（等下一条 512 字节头） / data（跳过当前条目的数据 + 对齐填充）
  let remaining = 0
  let captureType: 'L' | 'x' | 'g' | null = null
  let captureRemaining = 0
  let capture: Buffer[] = []
  let longName: string | null = null
  let paxPath: string | null = null
  let paxSize: number | null = null
  let ended = false

  function finishEntry(): void {
    const type = captureType
    if (type === 'L') {
      longName = Buffer.concat(capture).toString('utf8').replace(/\0+$/u, '')
    } else if (type === 'x') {
      const parsed = parsePaxRecords(Buffer.concat(capture).toString('utf8'))
      if (parsed.path !== undefined) paxPath = parsed.path
      if (parsed.size !== undefined) paxSize = parsed.size
    }
    captureType = null
    capture = []
    captureRemaining = 0
    remaining = 0
  }

  const stream = createReadStream(file).pipe(createGunzip())

  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        stream.destroy()
        throw new HubError('VALIDATION_FAILED', `插件包解压后超过 ${String(maxBytes)} 字节上限`)
      }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      let offset = 0
      while (offset < buffer.length) {
        if (ended) break
        if (remaining > 0) {
          const take = Math.min(remaining, buffer.length - offset)
          if (captureType !== null && captureRemaining > 0) {
            const captureTake = Math.min(take, captureRemaining)
            capture.push(Buffer.from(buffer.subarray(offset, offset + captureTake)))
            captureRemaining -= captureTake
          }
          offset += take
          remaining -= take
          // 捕获型条目：数据吃完还要跳过对齐填充（remaining 已包含填充，所以这里是整块消耗）
          if (remaining === 0) finishEntry()
          continue
        }
        if (buffer.length - offset < BLOCK) break
        const header = buffer.subarray(offset, offset + BLOCK)
        offset += BLOCK
        if (header.every((byte) => byte === 0)) {
          ended = true // 结束块：后面的内容一律忽略
          break
        }
        const size = readOctal(header, 124, 12)
        const typeflag = String.fromCharCode(header[156] ?? 0)
        const prefix = readString(header, 345, 155)
        const rawName = readString(header, 0, 100)
        if (typeflag === 'L' || typeflag === 'x' || typeflag === 'g') {
          captureType = typeflag
          captureRemaining = size
          capture = []
          remaining = Math.ceil(size / BLOCK) * BLOCK
          continue
        }
        // 长路径优先：pax `path=` > GNU LongLink > 头里的 prefix/name
        const fullPath = paxPath ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
        const name = normalizeName(fullPath)
        const entrySize = paxSize ?? size
        longName = null
        paxPath = null
        paxSize = null
        if (name.length > 0) {
          if (names.length >= maxEntries) {
            stream.destroy()
            throw new HubError('VALIDATION_FAILED', `插件包条目数超过 ${String(maxEntries)}`)
          }
          names.push(name)
        }
        remaining = Math.ceil(entrySize / BLOCK) * BLOCK
      }
      if (ended) break
      buffer = buffer.subarray(offset)
    }
  } catch (error) {
    // gzip 头坏了 / 被截断：zlib 抛的是普通 Error，这里统一成 400（不是 500）
    if (HubError.is(error)) throw error
    throw new HubError('VALIDATION_FAILED', '不是合法的 .tgz（gzip 解压失败或文件被截断）')
  }

  if (!ended) {
    // 没有结束块：可能是合法 tar（有些打包器省略）也可能被截断。条目名已经拿全就算过。
    if (remaining > 0) {
      throw new HubError('VALIDATION_FAILED', '插件包不完整（tar 在条目数据中途结束）')
    }
  }
  return { names, totalBytes }
}

/** 包的顶层 `package.json` 是否存在（npm tarball 在 `package/` 下） */
export function hasPackageJson(names: string[]): boolean {
  return names.some((name) => name === 'package.json' || name.endsWith('/package.json'))
}

/** 包里是否存在指定 basename 的文件（LICENSE / NOTICE） */
export function hasFileNamed(names: string[], basenames: readonly string[]): boolean {
  const wanted = new Set(basenames.map((name) => name.toLowerCase()))
  return names.some((name) => {
    const base = name.split('/').pop() ?? ''
    return wanted.has(base.toLowerCase())
  })
}

/** 裁决 #16 的禁运清单：claude-agent-sdk / claude-code 的任何平台二进制形态 */
const FORBIDDEN_CLAUDE_PATTERNS: readonly RegExp[] = [
  // npm 平台包与 SDK 本体（任何层级、任何形式）
  /(^|\/)@anthropic-ai\/claude-agent-sdk(?:[/@-]|$)/iu,
  // 某些打包会把 scoped 目录写成 `@anthropic-ai+claude-agent-sdk-win32-x64`（pnpm 风格）
  /(^|\/)@anthropic-ai\+claude-agent-sdk/iu,
  // 裸二进制（claude / claude.exe）：只认 basename，避免误伤 `claude-pilot` 这类名字
  /(^|\/)claude(\.exe)?$/iu,
]

/** 返回命中的第一条路径（没命中返回 null） */
export function findForbiddenClaudeBinary(names: string[]): string | null {
  for (const name of names) {
    for (const pattern of FORBIDDEN_CLAUDE_PATTERNS) {
      if (pattern.test(name)) return name
    }
  }
  return null
}

/** 带了 codex 平台包 / codex 二进制的整包（裁决 #16：可以托管，但必须带 LICENSE + NOTICE） */
const CODEX_PATTERNS: readonly RegExp[] = [
  /(^|\/)@openai\/codex[/@-]/iu,
  /(^|\/)@openai\+codex/iu,
  /(^|\/)codex(\.exe)?$/iu,
  /codex-code-mode-host$/iu,
]

export function carriesCodexBinary(names: string[]): boolean {
  return names.some((name) => CODEX_PATTERNS.some((pattern) => pattern.test(name)))
}
