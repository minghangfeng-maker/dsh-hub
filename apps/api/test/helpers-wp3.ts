import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { RequestMeta } from '../src/context.js'
import { loadConfig } from '../src/config.js'
import { createTestClock, type TestClock } from '../src/lib/clock.js'
import { FakeDriver } from '../src/modules/instances/fake-driver.js'

/**
 * WP3 测试脚手架（端口按 11 §3：7731）。提供：
 * - `createWp3App`：临时数据目录 + FakeDriver + 可控时钟 + 假 npm 源/假 OpenAI 端点
 * - `makeTarGz`：写一个最小 npm tarball（测试上传/入库，不依赖系统 tar）
 * - `startFakeNpmRegistry` / `startFakeOpenAi`：本地假上游
 * - `waitFor`：轮询等待任务引擎跑完（引擎是异步调度）
 */

export const WP3_ORIGIN = 'http://127.0.0.1:7731'

export interface Wp3TestApp {
  app: FastifyInstance
  dataDir: string
  clock: TestClock
  driver: FakeDriver
  /** 关掉 app；`dataDir` 由创建者负责删除（复用目录模拟重启时用） */
  close(): Promise<void>
}

export interface CreateWp3AppOptions {
  dataDir?: string
  clock?: TestClock
  driver?: FakeDriver
  env?: Record<string, string>
}

export async function createWp3App(opts: CreateWp3AppOptions = {}): Promise<Wp3TestApp> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), `dshhub-test-wp3-${process.pid}-`))
  const ownsDir = opts.dataDir === undefined
  const clock = opts.clock ?? createTestClock()
  const driver = opts.driver ?? new FakeDriver({ clock })
  const config = loadConfig({
    HUB_DATA_DIR: dataDir,
    HUB_CONTAINER_DRIVER: 'fake',
    HUB_PUBLIC_ORIGIN: WP3_ORIGIN,
    HUB_LOG_LEVEL: 'silent',
    ...opts.env,
  })
  // 有些超时是模块级读 `process.env` 的（例如插件安装后重启的就绪等待上限），
  // 测试要能把它们调小；app 关闭时还原，避免污染别的用例。
  const savedEnv = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    savedEnv.set(key, process.env[key])
    process.env[key] = value
  }
  const app = await buildApp({ config, testing: true, driver, clock })
  return {
    app,
    dataDir,
    clock,
    driver,
    async close() {
      await app.close()
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (ownsDir) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export function makeTempDir(prefix = 'dshhub-test-wp3-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanupDirs(dirs: string[]): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 轮询等待条件成立（任务引擎异步调度，测试不要用固定 sleep 猜时间） */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const intervalMs = opts.intervalMs ?? 5
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `waitFor 超时${opts.label ? `（${opts.label}）` : ''}${last === undefined ? '' : `：${String(last)}`}`,
  )
}

export const TEST_META: RequestMeta = { ip: '127.0.0.1', userAgent: 'vitest' }

// ── 最小 tar.gz 写入器（测试上传/入库用） ───────────────────────────────────

export interface TarInputEntry {
  name: string
  content: string | Buffer
}

function tarHeader(name: string, size: number, typeflag: '0' | '5' = '0'): Buffer {
  const header = Buffer.alloc(512)
  const nameBuf = Buffer.from(name, 'utf8')
  if (nameBuf.length > 100) throw new Error(`测试 tar 条目名太长：${name}`)
  nameBuf.copy(header, 0)
  header.write('0000644\0', 100, 8, 'utf8')
  header.write('0000000\0', 108, 8, 'utf8')
  header.write('0000000\0', 116, 8, 'utf8')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  header.write('00000000000\0', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8') // 校验和先填空格
  header.write(typeflag, 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return header
}

/** 生成一个 tgz（npm 包形状：条目名以 `package/` 开头） */
export function makeTarGz(entries: TarInputEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content
    blocks.push(tarHeader(entry.name, data.byteLength))
    blocks.push(data)
    const padding = (512 - (data.byteLength % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** 造一个合法插件的 tgz（package.json + 可选额外文件） */
export function makePluginTgz(opts: {
  name: string
  version: string
  extra?: TarInputEntry[]
  dsh?: unknown
  description?: string
}): Buffer {
  const manifest = {
    name: opts.name,
    version: opts.version,
    description: opts.description ?? 'test plugin',
    dsh: opts.dsh ?? { bundle: { patch: 'cordis.patch.yml' } },
  }
  return makeTarGz([
    { name: 'package/package.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...(opts.extra ?? [
      { name: 'package/cordis.patch.yml', content: '- id: test-plugin\n  config:\n    a: 1\n' },
    ]),
  ])
}

// ── 直接造库数据（安装器/下发测试用，绕开路由与 npm 源） ────────────────────

export interface SeededPlugin {
  pluginId: number
  versionId: number
}

/** 往目录里塞一个插件 + 一个版本（安装器与 rollout 测试的夹具） */
export function seedPlugin(
  app: FastifyInstance,
  opts: {
    packageName: string
    version: string
    spec?: string
    sourceType?: 'npm' | 'tarball' | 'local' | 'upload'
    policy?: 'required' | 'default' | 'optional' | 'hidden'
    isBundle?: boolean
    bundleOrder?: number
    needsRestart?: boolean
    configYaml?: string
  },
): SeededPlugin {
  const now = app.deps.clock.nowIso()
  const plugin = app.deps.db.run(
    `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                          is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    opts.packageName,
    opts.packageName,
    opts.policy ?? 'optional',
    opts.isBundle === false ? 0 : 1,
    opts.bundleOrder ?? 100,
    opts.configYaml ?? '',
    opts.needsRestart === false ? 0 : 1,
    now,
    now,
  )
  const version = app.deps.db.run(
    `INSERT INTO plugin_versions (plugin_id, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    plugin.lastInsertRowid,
    opts.version,
    opts.sourceType ?? 'npm',
    `${opts.packageName}@${opts.version}`,
    opts.spec ?? opts.version,
    now,
  )
  return { pluginId: plugin.lastInsertRowid, versionId: version.lastInsertRowid }
}

export interface ProfilePackage {
  name?: string
  dependencies?: Record<string, string>
  bundles?: string[]
  dshHub?: Record<string, unknown>
  extra?: Record<string, unknown>
}

export function profilePath(app: FastifyInstance, slug: string): string {
  return join(app.deps.paths.userProfileDir(slug), 'package.json')
}

/** 写用户的 profile package.json（模拟 DSH 已经创建过 profile） */
export function writeProfile(app: FastifyInstance, slug: string, pkg: ProfilePackage = {}): string {
  const dir = app.deps.paths.userProfileDir(slug)
  mkdirSync(dir, { recursive: true })
  const json = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: pkg.dependencies ?? {},
    dsh: { profile: { bundles: pkg.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    ...(pkg.dshHub ? { dshHub: pkg.dshHub } : {}),
    ...(pkg.extra ?? {}),
  }
  const file = join(dir, 'package.json')
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
  return file
}

export function readProfile(
  app: FastifyInstance,
  slug: string,
): {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  dshHub?: { managed?: Record<string, string> }
  [key: string]: unknown
} {
  return JSON.parse(readFileSync(profilePath(app, slug), 'utf8')) as never
}

/** 造一个「实例已在运行」的用户（FakeDriver 的假 DSH + 就绪检查） */
export async function startInstance(app: FastifyInstance, userId: number): Promise<void> {
  // 实例服务启动前会检查镜像是否存在；测试里先「声明」镜像已构建（等价于 WP3 的 runtime.build 成功）
  const driver = app.deps.driver as unknown as { addImage?: (tag: string, sizeBytes?: number) => void }
  const spec = await app.deps.services.instances.buildSpec(userId)
  driver.addImage?.(spec.image)
  await app.deps.services.instances.ensureRunning(userId, { reason: 'user' })
}

// ── 假上游 ──────────────────────────────────────────────────────────────────

export interface FakeServer {
  url: string
  requests: string[]
  close(): Promise<void>
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/**
 * 假 npm 源（06 §2.1）：`GET /<pkg>` 返回元数据（versions/dist-tags），
 * `GET /<pkg>/-/<file>.tgz` 返回对应 tarball。用于 lookup 与 npm 版本入库的密钥扫描路径。
 */
export async function startFakeNpmRegistry(packages: {
  [name: string]: { versions: Record<string, Record<string, unknown>>; distTags?: Record<string, string> }
}): Promise<FakeServer> {
  const requests: string[] = []
  const decodeName = (raw: string): string => decodeURIComponent(raw.replace(/^\//u, ''))
  const server = createServer((req, res) => {
    const rawUrl = req.url ?? '/'
    requests.push(rawUrl)
    const pathname = new URL(rawUrl, 'http://localhost').pathname
    const tgzMatch = /^(.*)\/-\/([^/]+\.tgz)$/u.exec(pathname)
    if (tgzMatch) {
      const name = decodeName(tgzMatch[1]!)
      const fileName = tgzMatch[2]!
      const pkg = packages[name]
      const base = name.split('/').pop() ?? name
      const version = fileName
        .replace(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-`), '')
        .replace(/\.tgz$/u, '')
      const manifest = pkg?.versions[version]
      if (!pkg || !manifest) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(
        makePluginTgz({
          name,
          version,
          ...(manifest.dsh === undefined ? {} : { dsh: manifest.dsh }),
          ...(manifest.__files === undefined ? {} : { extra: manifest.__files as TarInputEntry[] }),
        }),
      )
      return
    }
    const name = decodeName(pathname)
    const pkg = packages[name]
    if (!pkg) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`
    const base = name.split('/').pop() ?? name
    const versions: Record<string, Record<string, unknown>> = {}
    for (const [version, manifest] of Object.entries(pkg.versions)) {
      versions[version] = {
        ...manifest,
        dist: { tarball: `${origin}/${name}/-/${base}-${version}.tgz` },
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        name,
        description: 'fake plugin',
        homepage: 'https://example.com/fake',
        'dist-tags': pkg.distTags ?? { latest: Object.keys(pkg.versions).at(-1) ?? '' },
        versions,
      }),
    )
  })
  const url = await listen(server)
  return { url, requests, close: () => closeServer(server) }
}

/** 假 OpenAI 兼容端点：`GET /v1/models`（Bearer 校验） */
export async function startFakeOpenAi(
  opts: { apiKey?: string; models?: (string | ({ id: string } & Record<string, unknown>))[] } = {},
): Promise<FakeServer> {
  const requests: string[] = []
  const apiKey = opts.apiKey ?? 'sk-test-key-1234567890abcdef'
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? 'GET'} ${req.url ?? ''}`)
    if ((req.headers.authorization ?? '') !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"bad key"}}')
      return
    }
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: (opts.models ?? ['gpt-4o-mini', 'gpt-4o']).map((item) =>
            typeof item === 'string'
              ? { id: item, object: 'model', name: item }
              : { object: 'model', name: item.id, ...item },
          ),
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  const url = await listen(server)
  return { url, requests, close: () => closeServer(server) }
}
