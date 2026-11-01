import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HubError } from '../../lib/errors.js'

/**
 * 极简 tar(.gz) 读取器：只为插件包服务（校验 `package.json`、密钥扫描、入 plugin-store）。
 *
 * 为什么不用 `tar` 包：11 §2 要求尽量不加依赖，而 npm 包 tarball 的结构极稳定
 * （ustar，条目名 ≤ 100 字节或带 `prefix`/GNU LongLink/pax `path=`）；这里只读不写，
 * 400 行以内的实现比多一个依赖更可控。**不跟随符号链接**，解包路径必须落在目标目录内。
 */

/** 解压后大小上限（防 gzip 炸弹；插件包 ≤ 50MB 上传，解压 200MB 足够） */
export const MAX_TAR_BYTES = 200 * 1024 * 1024
/** 条目数上限 */
export const MAX_TAR_ENTRIES = 5000

const BLOCK = 512

export interface TarEntry {
  /** 归一化后的相对路径（`/` 分隔，去掉 `./` 前缀） */
  name: string
  type: 'file' | 'dir' | 'other'
  size: number
  data: Buffer
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

/** 解析 pax 头（typeflag `x`），取出 `path=` / `size=` */
function parsePax(data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) {
      const key = record.slice(0, eq)
      const value = record.slice(eq + 1)
      if (key === 'path') out.path = value
      if (key === 'size') out.size = Number.parseInt(value, 10)
    }
    offset += length
  }
  return out
}

/**
 * 读取 tar.gz 的全部条目。`opts.maxBytes` / `opts.maxEntries` 超限直接抛 HubError。
 * 目录与符号链接条目也会返回（type=dir/other），但 data 为空。
 */
export function readTarGz(buffer: Buffer, opts: { maxBytes?: number; maxEntries?: number } = {}): TarEntry[] {
  const maxBytes = opts.maxBytes ?? MAX_TAR_BYTES
  const maxEntries = opts.maxEntries ?? MAX_TAR_ENTRIES
  let raw: Buffer
  try {
    raw = gunzipSync(buffer, { maxOutputLength: maxBytes })
  } catch {
    throw new HubError('VALIDATION_FAILED', '不是合法的 .tgz（gzip 解压失败或超过大小上限）')
  }

  const entries: TarEntry[] = []
  let offset = 0
  let longName: string | null = null
  let pax: { path?: string; size?: number } | null = null

  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (header.every((byte) => byte === 0)) break // 结束块

    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset
    const dataEnd = Math.min(raw.length, dataStart + size)
    const data = raw.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0+$/u, '')
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      pax = parsePax(data)
      continue
    }

    const prefix = readString(header, 345, 155)
    const rawName = pax?.path ?? longName ?? readString(header, 0, 100)
    const name = normalizeName(prefix ? `${prefix}/${rawName}` : rawName)
    const entrySize = pax?.size ?? size
    longName = null
    pax = null
    if (name.length === 0) continue
    if (entries.length >= maxEntries) {
      throw new HubError('VALIDATION_FAILED', `插件包条目数超过 ${String(maxEntries)}`)
    }
    const type: TarEntry['type'] =
      typeflag === '5' ? 'dir' : typeflag === '0' || typeflag === '' ? 'file' : 'other'
    entries.push({
      name,
      type,
      size: entrySize,
      data: type === 'file' ? Buffer.from(data) : Buffer.alloc(0),
    })
  }
  return entries
}

/** 解包路径安全检查：拒绝绝对路径与 `..` 逃逸（tar 里的 `../` 是经典攻击面） */
export function safeJoin(root: string, name: string): string {
  const absRoot = resolve(root)
  const target = resolve(absRoot, name)
  if (target !== absRoot && !target.startsWith(absRoot + sep)) {
    throw new HubError('VALIDATION_FAILED', `插件包内路径越界：${name}`)
  }
  return target
}

export interface ExtractResult {
  /** 解包出来的文件（相对路径，`/` 分隔） */
  files: string[]
  /** 顶层目录名（npm 包通常是 `package/`）；没有时为空串 */
  rootDir: string
}

/** 把 tar.gz 解到 `destDir`（只写普通文件与目录，符号链接/设备文件忽略） */
export function extractTarGz(
  buffer: Buffer,
  destDir: string,
  opts: { maxBytes?: number } = {},
): ExtractResult {
  const entries = readTarGz(buffer, opts)
  mkdirSync(destDir, { recursive: true })
  const files: string[] = []
  for (const entry of entries) {
    const target = safeJoin(destDir, entry.name)
    if (entry.type === 'dir') {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (entry.type !== 'file') continue // 符号链接、硬链接、设备文件一律不解
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    files.push(entry.name)
  }
  const first = entries[0]?.name ?? ''
  const rootDir = first.includes('/') ? (first.split('/')[0] ?? '') : ''
  return { files, rootDir }
}

/** 从条目列表里挑出包根目录下的 `package.json` 条目（npm tarball 在 `package/` 下） */
export function findPackageJsonEntry(entries: TarEntry[]): TarEntry | null {
  const candidates = entries.filter(
    (entry) =>
      entry.type === 'file' && (entry.name === 'package.json' || entry.name.endsWith('/package.json')),
  )
  if (candidates.length === 0) return null
  // 取层级最浅的那个（`package/package.json` 优先于 `package/sub/package.json`）
  candidates.sort((a, b) => a.name.split('/').length - b.name.split('/').length)
  return candidates[0]!
}

/** 条目名去掉最外层目录（`package/lib/x.js` → `lib/x.js`），用于密钥扫描时的展示路径 */
export function stripRootDir(name: string, rootDir: string): string {
  if (!rootDir) return name
  const prefix = `${rootDir}/`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

export function joinInside(...parts: string[]): string {
  return join(...parts)
}
