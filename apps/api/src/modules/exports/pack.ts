import { createHash } from 'node:crypto'
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import archiver from 'archiver'
import { EXPORT_FORMATS, type ExportFormat, type ExportPart, type ExportProgress } from '@dsh-hub/shared'
import { HubError } from '../../lib/errors.js'
import { isInside } from '../../lib/paths.js'

/**
 * 导出打包（06 §6）：先遍历计数（文件数/字节数）再压缩；不跟随符号链接；
 * 指向用户目录之外的符号链接直接跳过并记入跳过清单；写入临时文件后 rename（原子替换）。
 */

/** 永远排除的目录名（任何层级） */
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.pnpm-store', '.cache'])
/** 永远排除的文件名（任何层级）：`.env`、`.env.local`…、`.credentials.yaml` */
const EXCLUDED_FILE_NAMES = new Set(['.credentials.yaml', '.env'])
const ENV_FILE_RE = /^\.env\..+$/

export function isExcludedDirName(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name)
}

export function isExcludedFileName(name: string): boolean {
  return EXCLUDED_FILE_NAMES.has(name) || ENV_FILE_RE.test(name)
}

export interface ArchiveEntry {
  kind: 'file' | 'symlink'
  /** 归档内相对路径（POSIX 风格，无前导 `/`） */
  archivePath: string
  /** `kind=file` 时的宿主绝对路径 */
  sourcePath?: string
  /** `kind=symlink` 时的链接目标（原样写入归档） */
  linkTarget?: string
  sizeBytes: number
}

export interface SkippedEntry {
  path: string
  reason: string
}

export interface PartStats {
  bytes: number
  files: number
}

export interface ScanResult {
  entries: ArchiveEntry[]
  skipped: SkippedEntry[]
  bytes: number
  files: number
  partStats: Record<string, PartStats>
}

export interface ScanInput {
  /** 用户根目录 `users/<slug>`（符号链接指向它之外的一律跳过） */
  userRoot: string
  /** 各 part 的源目录/文件（由 service 按 HubPaths 组装） */
  sources: Partial<Record<ExportPart, PartSource[]>>
  maxBytes: number
}

export interface PartSource {
  /** 源目录（递归）或单个文件 */
  path: string
  /** 归档内前缀，例如 `workspace` / `dsh/sessions` */
  archivePrefix: string
  kind: 'dir' | 'file'
}

/** 递归统计 + 收集待打包条目；超过 maxBytes 立刻抛 EXPORT_TOO_LARGE（06 §6） */
export function scanExport(input: ScanInput): ScanResult {
  const state: ScanState = {
    userRoot: input.userRoot,
    maxBytes: input.maxBytes,
    entries: [],
    skipped: [],
    totalBytes: 0,
    partStats: {},
  }
  for (const [part, sources] of Object.entries(input.sources) as [ExportPart, PartSource[]][]) {
    const stats: PartStats = { bytes: 0, files: 0 }
    state.partStats[part] = stats
    for (const source of sources ?? []) {
      if (source.kind === 'file') {
        const size = fileSizeOrNull(source.path)
        if (size === null) continue
        addEntry(state, stats, {
          kind: 'file',
          archivePath: `${source.archivePrefix}/${basename(source.path)}`,
          sourcePath: source.path,
          sizeBytes: size,
        })
        continue
      }
      walk(state, stats, source.path, source.archivePrefix)
    }
  }
  return {
    entries: state.entries,
    skipped: state.skipped,
    bytes: state.totalBytes,
    files: state.entries.length,
    partStats: state.partStats,
  }
}

interface ScanState {
  userRoot: string
  maxBytes: number
  entries: ArchiveEntry[]
  skipped: SkippedEntry[]
  /** 累计字节（边扫边判 maxBytes，避免二次遍历） */
  totalBytes: number
  partStats: Record<string, PartStats>
}

function addEntry(state: ScanState, stats: PartStats, entry: ArchiveEntry): void {
  guard(state.totalBytes + entry.sizeBytes, state.maxBytes)
  state.totalBytes += entry.sizeBytes
  stats.bytes += entry.sizeBytes
  stats.files += 1
  state.entries.push(entry)
}

function walk(state: ScanState, stats: PartStats, root: string, prefix: string): void {
  const stack: { dir: string; rel: string }[] = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()!
    let dirents
    try {
      dirents = readdirSync(current.dir, { withFileTypes: true })
    } catch (error) {
      state.skipped.push({
        path: joinArchive(prefix, current.rel),
        reason: `目录不可读：${errorText(error)}`,
      })
      continue
    }
    for (const dirent of dirents) {
      const abs = join(current.dir, dirent.name)
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name
      const archivePath = joinArchive(prefix, rel)

      if (dirent.isSymbolicLink()) {
        // 不跟随：指向用户目录之外的跳过并记录（06 §6 / 验收 E2）
        let target: string
        try {
          target = readlinkSync(abs)
        } catch (error) {
          state.skipped.push({ path: archivePath, reason: `符号链接不可读：${errorText(error)}` })
          continue
        }
        const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(dirname(abs), target)
        if (!isInside(state.userRoot, resolvedTarget)) {
          state.skipped.push({ path: archivePath, reason: `符号链接指向用户目录之外：${target}` })
          continue
        }
        addEntry(state, stats, {
          kind: 'symlink',
          archivePath,
          linkTarget: target,
          sizeBytes: Buffer.byteLength(target),
        })
        continue
      }

      if (dirent.isDirectory()) {
        if (isExcludedDirName(dirent.name)) continue
        stack.push({ dir: abs, rel })
        continue
      }

      if (dirent.isFile()) {
        if (isExcludedFileName(dirent.name)) continue
        const size = fileSizeOrNull(abs)
        if (size === null) {
          state.skipped.push({ path: archivePath, reason: '文件不可读' })
          continue
        }
        addEntry(state, stats, { kind: 'file', archivePath, sourcePath: abs, sizeBytes: size })
        continue
      }

      state.skipped.push({ path: archivePath, reason: '套接字/设备/FIFO 等特殊文件已跳过' })
    }
  }
}

function guard(totalBytes: number, maxBytes: number): void {
  if (Number.isFinite(maxBytes) && totalBytes > maxBytes) {
    throw new HubError('EXPORT_TOO_LARGE', '导出内容过大，请只勾选部分内容', {
      totalBytes,
      maxBytes,
    })
  }
}

function joinArchive(prefix: string, rel: string): string {
  return rel ? `${prefix}/${rel}` : prefix
}

function fileSizeOrNull(path: string): number | null {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 打包 ────────────────────────────────────────────────────────────────────

export interface ExtraFile {
  name: string
  content: string
}

export interface WriteArchiveInput {
  format: ExportFormat
  targetPath: string
  entries: ArchiveEntry[]
  /** README.txt / manifest.json / plugins.json 等生成内容 */
  extras: ExtraFile[]
  onProgress?: (progress: ExportProgress) => void
  /** 06 §6：archiver 的 progress 事件节流 500ms 推 SSE */
  progressIntervalMs?: number
  /** 非致命的 archiver warning（例如权限问题）上报给调用方记日志 */
  onWarning?: (warning: Error) => void
}

export interface WriteArchiveResult {
  sizeBytes: number
  sha256: string
}

/** 写 `<target>.part` → 算 sha256 → rename 成正式文件（失败清理临时文件） */
export async function writeArchive(input: WriteArchiveInput): Promise<WriteArchiveResult> {
  const tmpPath = `${input.targetPath}.part`
  mkdirSync(dirname(input.targetPath), { recursive: true })
  rmSync(tmpPath, { force: true })

  const archive =
    input.format === 'zip'
      ? archiver('zip', { zlib: { level: 6 } })
      : archiver('tar', { gzip: true, gzipOptions: { level: 6 } })
  const output = createWriteStream(tmpPath)
  const hash = createHash('sha256')
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  const filesTotal = input.entries.length + input.extras.length
  const interval = input.progressIntervalMs ?? 500
  let lastEmit = 0
  archive.on('progress', (data: { entries?: { processed?: number }; fs?: { processedBytes?: number } }) => {
    if (!input.onProgress) return
    const now = Date.now()
    if (now - lastEmit < interval) return
    lastEmit = now
    input.onProgress({
      bytesWritten: Math.max(0, Math.trunc(data.fs?.processedBytes ?? 0)),
      filesDone: Math.max(0, Math.trunc(data.entries?.processed ?? 0)),
      filesTotal,
    })
  })

  const done = new Promise<WriteArchiveResult>((resolvePromise, rejectPromise) => {
    archive.on('error', rejectPromise)
    // archiver 对「文件在遍历后消失」只发 warning（ENOENT）：必须当失败处理，
    // 否则会悄悄产出缺文件的包
    archive.on('warning', (warning: NodeJS.ErrnoException) => {
      if (warning.code === 'ENOENT') {
        rejectPromise(new HubError('INTERNAL', `打包时文件不存在：${warning.message}`))
      } else {
        input.onWarning?.(warning)
      }
    })
    output.on('error', rejectPromise)
    output.on('close', () => {
      try {
        renameSync(tmpPath, input.targetPath)
        resolvePromise({ sizeBytes: statSync(input.targetPath).size, sha256: hash.digest('hex') })
      } catch (error) {
        rejectPromise(error)
      }
    })
  })

  // finalize() 与 done 是两个 await：先挂一个空 catch，避免 warning 早于 await 触发 unhandled rejection
  void done.catch(() => {})

  archive.pipe(hasher).pipe(output)
  for (const extra of input.extras) archive.append(extra.content, { name: extra.name })
  for (const entry of input.entries) {
    if (entry.kind === 'symlink') archive.symlink(entry.archivePath, entry.linkTarget ?? '')
    else archive.file(entry.sourcePath!, { name: entry.archivePath })
  }

  try {
    await archive.finalize()
    return await done
  } catch (error) {
    output.destroy()
    rmSync(tmpPath, { force: true })
    if (HubError.is(error)) throw error
    throw new HubError('INTERNAL', `打包失败：${errorText(error)}`)
  }
}

// ── 文件名 / 目录结构 ───────────────────────────────────────────────────────

export function timestampCompact(iso: string): string {
  const digits = iso.slice(0, 16).replace(/[-:]/g, '').replace('T', '')
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}`
}

export function exportFileName(username: string, iso: string, format: ExportFormat): string {
  const extension = format === 'zip' ? 'zip' : 'tar.gz'
  return `dsh-${username}-${timestampCompact(iso)}.${extension}`
}

export function archiveRootName(username: string, iso: string): string {
  return `dsh-${username}-${timestampCompact(iso)}`
}

/**
 * 磁盘上的落盘名：`exports/<slug>/<exportId>.<ext>`（03 §2）。
 * 不用下载名（`dsh-<username>-<分钟>.zip`）落盘，避免同一分钟内两次导出互相覆盖。
 */
export function storageNameFor(exportId: number, format: ExportFormat): string {
  return `${exportId}.${format === 'zip' ? 'zip' : 'tar.gz'}`
}

export function mimeTypeFor(format: ExportFormat): string {
  return format === 'zip' ? 'application/zip' : 'application/gzip'
}

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value)
}

// ── README / manifest / plugins.json ────────────────────────────────────────

export interface ManifestInput {
  hubVersion: string
  username: string
  displayName: string
  parts: readonly ExportPart[]
  format: ExportFormat
  exportedAt: string
  dshVersion: string | null
  root: string
  files: number
  bytes: number
  skipped: SkippedEntry[]
}

export function buildManifest(input: ManifestInput): string {
  return `${JSON.stringify(
    {
      generator: 'DSH Hub',
      hubVersion: input.hubVersion,
      exportedAt: input.exportedAt,
      user: { username: input.username, displayName: input.displayName },
      dshVersion: input.dshVersion,
      parts: input.parts,
      format: input.format,
      root: input.root,
      files: input.files,
      bytes: input.bytes,
      // 整包 sha256 无法写进包内（自引用）：以下载接口的 X-Hub-Sha256 响应头与
      // 导出记录（ExportItem.sha256）为准
      archiveSha256: null,
      archiveSha256Source: 'download-header:X-Hub-Sha256',
      skipped: input.skipped,
    },
    null,
    2,
  )}\n`
}

export function buildReadme(input: ManifestInput): string {
  const partLines = input.parts.map((part) => `  - ${part}：${PART_DESCRIPTIONS[part] ?? part}`)
  return `DSH Hub 数据导出
=================

导出用户：${input.username}（${input.displayName}）
导出时间：${input.exportedAt}
DSH 版本：${input.dshVersion ?? '未知'}
包含内容：
${partLines.join('\n')}
文件数：${input.files} 总字节：${input.bytes}

目录说明
--------
  workspace/              你的默认工作区（容器内 /workspace 的完整内容）
  dsh/sessions/           DSH 会话历史（容器内 /home/dsh/.dsh/sessions）
  dsh/attachments/        会话附件（容器内 /home/dsh/.dsh/attachments）
  dsh/settings/profile/   web profile 配置：package.json、cordis.patch.yml
  dsh/settings/storages/  DSH storages 数据（容器内 /home/dsh/.dsh/storages）
  plugins.json            你的插件依赖清单（便于在别处复原）
  manifest.json           导出清单：时间、文件数、跳过清单

如何在本机 DSH 里使用这些会话文件
---------------------------------
  1. 在本机装好 DSH（与你原来使用的版本尽量一致：${input.dshVersion ?? '见 DSH 官方文档'}）。
  2. 先停掉本机 DSH（例如停掉 dsh web 服务），避免写入冲突。
  3. 备份现有目录：mv ~/.dsh/sessions ~/.dsh/sessions.bak（attachments 同理）。
  4. 把包里的 dsh/sessions/ 内容复制到 ~/.dsh/sessions/，
     把 dsh/attachments/ 内容复制到 ~/.dsh/attachments/。
  5. 需要在别处继续用工作区文件时，把 workspace/ 的内容复制到你的工作目录。
  6. 复原插件：把 plugins.json 里的依赖合并进 ~/.dsh/profiles/web/package.json，
     然后在该目录执行安装（pnpm install / npm install）。
  7. 可选：dsh/settings/profile/ 里的 package.json 与 cordis.patch.yml 可以直接对照，
     但建议只手工合并你需要的部分，避免覆盖本机已有配置。

安全说明
--------
  导出包**不含** .credentials.yaml、.env、node_modules、缓存目录，也不含指向
  用户目录之外的符号链接目标（见 manifest.json 的 skipped 清单）。
  下载完成后请在 DSH Hub 的「数据导出」页面删除，Hub 也会在到期后自动清理。
`
}

const PART_DESCRIPTIONS: Record<string, string> = {
  workspace: '默认工作区全部文件',
  sessions: '会话历史与附件',
  settings: 'profile 配置（package.json、cordis.patch.yml）与 storages',
  'profile-plugins': '自装插件清单（package.json 依赖）',
}

export interface PluginsJsonInput {
  exportedAt: string
  profilePackage: unknown
  dependencies: Record<string, string>
}

export function buildPluginsJson(input: PluginsJsonInput): string {
  return `${JSON.stringify(
    {
      exportedAt: input.exportedAt,
      note: '把 dependencies 合并进本机 ~/.dsh/profiles/web/package.json 后执行安装即可复原插件',
      dependencies: input.dependencies,
      profilePackage: input.profilePackage,
    },
    null,
    2,
  )}\n`
}

/** 读 profile 的 package.json（不存在/损坏时返回 null） */
export function readProfilePackage(profileDir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function dependenciesOf(profilePackage: Record<string, unknown> | null): Record<string, string> {
  const deps = profilePackage?.['dependencies']
  if (typeof deps !== 'object' || deps === null) return {}
  const out: Record<string, string> = {}
  for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof version === 'string') out[name] = version
  }
  return out
}

// ── 下载：Content-Disposition（RFC 5987）与 Range ───────────────────────────

/** `attachment; filename="ascii 兜底"; filename*=UTF-8''<百分号编码>`（支持中文文件名） */
export function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export interface ByteRange {
  start: number
  end: number
}

/**
 * 解析 `Range: bytes=…`（只支持单段）：
 * 无 Range → null；非法/越界 → 'invalid'（调用方回 416）。
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  if (rawStart === '') {
    // `bytes=-N`：最后 N 字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}
