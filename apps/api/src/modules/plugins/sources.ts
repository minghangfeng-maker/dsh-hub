import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { HubError } from '../../lib/errors.js'
import { findPackageJsonEntry, readTarGz, stripRootDir, type TarEntry } from './tar.js'

/**
 * 插件来源（06 §2.1）：npm 元数据 / tarball URL / 宿主目录（pnpm pack）/ 上传的 .tgz。
 * 所有来源都要经过「取包 → 校验 package.json → 密钥扫描 → 入 plugin-store」这条流水线（见 service）。
 */

const execFileAsync = promisify(execFile)

/** 下载/打包的超时（06 §2.4 的 10 分钟是安装；这里给来源准备 5 分钟） */
export const SOURCE_TIMEOUT_MS = 5 * 60_000

/** 上传上限（WP3 任务书：≤ 50MB）。shared 的 `PLUGIN_UPLOAD_MAX_BYTES` 是 64MB（multipart 全局限制），
 * 插件入库这一层按任务书收紧到 50MB，并在响应里说明。 */
export const PLUGIN_SOURCE_MAX_BYTES = 50 * 1024 * 1024

/** 装包/打包命令要清掉代理（11 §2：本机 shell 带全局代理，速度只有 25KB/s） */
export function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'http_proxy',
    'https_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'all_proxy',
    'NODE_USE_ENV_PROXY',
  ]) {
    delete env[key]
  }
  return { ...env, ...extra }
}

export interface NpmPackageInfo {
  name: string
  description: string
  homepage: string | null
  versions: string[]
  latest: string | null
  distTags: Record<string, string>
  /** 该版本是否声明了 `dsh.bundle`（04 §4.5 的 lookup 字段） */
  isBundle: boolean
  /** `dsh.needsRestart`（没有则 null，调用方用目录里的默认值） */
  needsRestart: boolean | null
  /** 该版本的 tarball 下载地址（密钥扫描要拉包检查；元数据里没有时为 null） */
  distTarball: string | null
  dsh: unknown
}

/** 读 package.json 里的 `dsh` 字段（bundle 声明 / needsRestart） */
export function interpretDshField(dsh: unknown): { isBundle: boolean; needsRestart: boolean | null } {
  if (typeof dsh !== 'object' || dsh === null) return { isBundle: false, needsRestart: null }
  const bundle = (dsh as { bundle?: unknown }).bundle
  const needsRestartRaw = (dsh as { needsRestart?: unknown }).needsRestart
  return {
    // DSH 只认 `dsh.bundle.patch`（字符串或字符串数组，WP3 真容器实测）；只要声明了 bundle 就算 bundle
    isBundle: bundle !== undefined && bundle !== null,
    needsRestart: typeof needsRestartRaw === 'boolean' ? needsRestartRaw : null,
  }
}

function registryUrl(registry: string, packageName: string): string {
  const base = registry.replace(/\/+$/u, '')
  const encoded = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName)
  return `${base}/${encoded}`
}

/** 从 npm 兼容源拉包元数据（`dist-tags` / `versions` / `dsh` 字段，06 §2.1） */
export async function fetchNpmPackage(
  registry: string,
  packageName: string,
  opts: { version?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<NpmPackageInfo> {
  const doFetch = opts.fetchImpl ?? fetch
  const url = registryUrl(registry, packageName)
  const response = await fetchWithTimeout(doFetch, url, {
    headers: { accept: 'application/json' },
    timeoutMs: opts.timeoutMs ?? 15_000,
  })
  if (!response.ok) {
    throw new HubError('UPSTREAM_ERROR', `查询 npm 元数据失败（HTTP ${String(response.status)}）`, {
      packageName,
      status: response.status,
    })
  }
  const body = (await response.json()) as {
    name?: string
    description?: string
    homepage?: string
    'dist-tags'?: Record<string, string>
    versions?: Record<string, { dsh?: unknown; version?: string; dist?: { tarball?: string } }>
    dsh?: unknown
  }
  const versions = Object.keys(body.versions ?? {})
  const distTags = body['dist-tags'] ?? {}
  const latest = opts.version ?? distTags.latest ?? versions[versions.length - 1] ?? null
  const versionEntry = latest ? body.versions?.[latest] : undefined
  const dsh = versionEntry?.dsh ?? body.dsh
  const interpreted = interpretDshField(dsh)
  return {
    name: body.name ?? packageName,
    description: body.description ?? '',
    homepage: body.homepage ?? null,
    versions,
    latest: latest ?? null,
    distTags,
    isBundle: interpreted.isBundle,
    needsRestart: interpreted.needsRestart,
    distTarball: versionEntry?.dist?.tarball ?? null,
    dsh: dsh ?? null,
  }
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await doFetch(url, { ...rest, signal: controller.signal })
  } catch (error) {
    throw new HubError('UPSTREAM_ERROR', `请求 ${url} 失败：${errorText(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface DownloadedTarball {
  file: string
  bytes: number
  sha256: string
}

/** 下载 tarball 到 `destFile`（限 http(s)、限 50MB；返回 sha256 供入库记录） */
export async function downloadTarball(
  url: string,
  destFile: string,
  opts: { fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<DownloadedTarball> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HubError('VALIDATION_FAILED', '插件 tarball 只支持 http(s) URL')
  }
  const maxBytes = opts.maxBytes ?? PLUGIN_SOURCE_MAX_BYTES
  const doFetch = opts.fetchImpl ?? fetch
  const response = await fetchWithTimeout(doFetch, url, { timeoutMs: SOURCE_TIMEOUT_MS })
  if (!response.ok) {
    throw new HubError('UPSTREAM_ERROR', `下载插件包失败（HTTP ${String(response.status)}）`, { url })
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HubError('PAYLOAD_TOO_LARGE', `插件包超过 ${formatMb(maxBytes)}`)
  }
  const chunks: Buffer[] = []
  let total = 0
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > maxBytes) throw new HubError('PAYLOAD_TOO_LARGE', `插件包超过 ${formatMb(maxBytes)}`)
      chunks.push(Buffer.from(chunk))
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer())
    total = buffer.byteLength
    if (total > maxBytes) throw new HubError('PAYLOAD_TOO_LARGE', `插件包超过 ${formatMb(maxBytes)}`)
    chunks.push(buffer)
  }
  const buffer = Buffer.concat(chunks)
  mkdirSync(dirname(destFile), { recursive: true })
  writeFileSync(destFile, buffer)
  return { file: destFile, bytes: buffer.byteLength, sha256: sha256Of(buffer) }
}

function formatMb(bytes: number): string {
  return `${String(Math.round(bytes / 1024 / 1024))}MB`
}

export function sha256Of(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export interface PackedLocal {
  tgzFile: string
  packageJson: PackageJsonLike
  /** pnpm 的输出（写进 task 日志，便于排查） */
  output: string
}

export interface PackageJsonLike {
  name: string
  version: string
  description: string
  homepage: string | null
  dsh: unknown
  raw: Record<string, unknown>
}

/** 解析 `package.json` 文本（插件包必须有合法 name/version） */
export function parsePackageManifest(text: string, what = 'package.json'): PackageJsonLike {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HubError('VALIDATION_FAILED', `${what} 不是合法 JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HubError('VALIDATION_FAILED', `${what} 顶层必须是对象`)
  }
  const raw = parsed as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (name.length === 0) throw new HubError('VALIDATION_FAILED', `${what} 缺少 name`)
  if (version.length === 0) throw new HubError('VALIDATION_FAILED', `${what} 缺少 version`)
  return {
    name,
    version,
    description: typeof raw.description === 'string' ? raw.description : '',
    homepage: typeof raw.homepage === 'string' ? raw.homepage : null,
    dsh: raw.dsh,
    raw,
  }
}

/** 读宿主目录里的 package.json（`lookup?source=local` 与 `local` 版本入库都用它） */
export function readLocalPackage(dir: string): PackageJsonLike {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new HubError('VALIDATION_FAILED', `目录里没有 package.json：${dir}`)
  }
  return parsePackageManifest(readFileSync(manifestPath, 'utf8'))
}

/**
 * Hub 仓库根（`apps/api/{src,dist}/modules/plugins` 往上五级）。`pnpm pack` 在这里启动、用 `-C` 指向插件副本：
 * pnpm 由 corepack 提供时，版本取自**当前目录**往上找到的 `packageManager`；插件副本里通常没有这个字段，
 * 在副本里直接跑会落到 corepack 的默认版本（可能没缓存，要联网下载）。从仓库根启动就固定用仓库锁定的版本。
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

/** systemd 用户服务的 PATH 很精简，找不到 pnpm 是部署问题而不是用户操作问题：给出能照着做的提示 */
const PNPM_MISSING_HINT =
  '服务的 PATH 里找不到 pnpm。在普通终端跑一次 deploy/upgrade.sh（它会用 corepack 生成 pnpm 入口，并由 systemd 单元的 PATH 带给服务），或在单元里把 pnpm 所在目录加进 PATH 后重启服务'

export interface PackRunner {
  (
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<{
    stdout: string
    stderr: string
  }>
}

const defaultPackRunner: PackRunner = async (command, args, opts) => {
  const result = await execFileAsync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: SOURCE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

/** 复制目录（跳过 node_modules/.git，避免把几百 MB 搬来搬去） */
export function copyPackageDirectory(source: string, dest: string): void {
  cpSync(source, dest, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const base = src.split(/[\\/]/u).pop() ?? ''
      return base !== 'node_modules' && base !== '.git'
    },
  })
}

/**
 * `local` 来源：**复制到临时目录后** `pnpm pack`（06 §2.1 明确要求不改原目录），
 * 产出 `@scope/name` 的 tgz。原目录只读不写。
 */
export async function packLocalDirectory(
  sourceDir: string,
  workDir: string,
  opts: { registry: string; packRunner?: PackRunner } = { registry: '' },
): Promise<PackedLocal> {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new HubError('VALIDATION_FAILED', `本地插件目录不存在：${sourceDir}`)
  }
  const manifest = readLocalPackage(sourceDir)
  const copyDir = join(workDir, 'src')
  const outDir = join(workDir, 'out')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  copyPackageDirectory(sourceDir, copyDir)

  const runner = opts.packRunner ?? defaultPackRunner
  let output = ''
  try {
    const result = await runner('pnpm', ['-C', copyDir, 'pack', '--pack-destination', outDir], {
      cwd: REPO_ROOT,
      env: sanitizedEnv({
        npm_config_registry: opts.registry,
        npm_config_loglevel: 'warn',
        CI: '1',
      }),
    })
    output = `${result.stdout}\n${result.stderr}`
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    throw new HubError(
      'UPSTREAM_ERROR',
      missing ? `pnpm pack 失败：${PNPM_MISSING_HINT}` : `pnpm pack 失败：${errorText(error)}`,
    )
  }
  const expected = join(
    outDir,
    `${manifest.name.replace(/^@/u, '').replace(/\//gu, '-')}-${manifest.version}.tgz`,
  )
  const tgzFile = existsSync(expected) ? expected : firstTgz(outDir)
  if (!tgzFile) throw new HubError('UPSTREAM_ERROR', 'pnpm pack 没有产出 .tgz')
  return { tgzFile, packageJson: manifest, output }
}

function firstTgz(dir: string): string | null {
  const found = readdirSync(dir).find((name) => name.endsWith('.tgz'))
  return found ? join(dir, found) : null
}

export interface ValidatedTarball {
  packageJson: PackageJsonLike
  /** 包内相对路径（去掉最外层目录）→ 文本内容（只收集文本文件，供密钥扫描） */
  files: { path: string; content: string }[]
  bytes: number
  sha256: string
  /**
   * `dsh.bundle.patch` 声明的补丁文件是否都在包里（WP3 真容器实测：不在时
   * `dsh plugin add` 会报 `dsh.bundle.patch must be a file path or a list of file paths` 并回滚）。
   * 不声明 bundle 的包恒为 false。
   */
  bundlePatchMissing: boolean
}

/** 校验 tgz 是合法 npm 包，并抽出所有文本文件供密钥扫描（06 §2.1） */
export function inspectTarball(buffer: Buffer): ValidatedTarball {
  const entries = readTarGz(buffer)
  const manifestEntry = findPackageJsonEntry(entries)
  if (!manifestEntry) {
    throw new HubError('VALIDATION_FAILED', '插件包里没有 package.json，不是合法 npm 包')
  }
  const manifest = parsePackageManifest(manifestEntry.data.toString('utf8'))
  const rootDir = manifestEntry.name.includes('/') ? (manifestEntry.name.split('/')[0] ?? '') : ''
  const files: { path: string; content: string }[] = []
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    if (entry.name === manifestEntry.name || entry.name.endsWith('/package.json')) continue
    if (entry.data.byteLength > 512 * 1024) continue
    if (entry.data.includes(0)) continue
    files.push({ path: stripRootDir(entry.name, rootDir), content: entry.data.toString('utf8') })
  }
  return {
    packageJson: manifest,
    files,
    bytes: buffer.byteLength,
    sha256: sha256Of(buffer),
    bundlePatchMissing: missingBundlePatchFiles(entries, manifest),
  }
}

/** `plugin-store/` 下的安全文件名：`@local/dsh-x` + `1.0.0` → `local-dsh-x-1.0.0.tgz` */
export function safeStoreFileName(packageName: string, version: string): string {
  const safeName = packageName
    .replace(/^@/u, '')
    .replace(/\//gu, '-')
    .replace(/[^A-Za-z0-9._-]/gu, '_')
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/gu, '_')
  return `${safeName}-${safeVersion}.tgz`
}

/** 条目列表里是否有 `dsh.bundle.patch` 声明的补丁文件（DSH 安装时会校验，提前给出人话错误） */
export function missingBundlePatchFiles(entries: TarEntry[], manifest: PackageJsonLike): boolean {
  const interpreted = interpretDshField(manifest.dsh)
  if (!interpreted.isBundle) return false
  const bundle = (manifest.dsh as { bundle?: { patch?: unknown } }).bundle
  const declared = typeof bundle?.patch === 'string' ? [bundle.patch] : bundle?.patch
  if (!Array.isArray(declared)) return true
  const names = new Set(entries.map((entry) => entry.name.replace(/^\.\//u, '')))
  return declared.some((file) => {
    if (typeof file !== 'string') return true
    const normalized = file.replace(/^\.\//u, '')
    return ![...names].some((name) => name === normalized || name.endsWith(`/${normalized}`))
  })
}
