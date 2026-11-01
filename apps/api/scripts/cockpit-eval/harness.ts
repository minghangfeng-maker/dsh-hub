/**
 * 座舱评测 / 冒烟 / e2e 共用的**临时 Hub + 真座舱容器**环境。
 *
 * 与 `apps/api/scripts/wp56b-smoke.ts` 同一套做法：
 * - 独立的临时数据目录（`mkdtemp`，跑完删）；
 * - 独立端口（API / 内部监听 7710 的替代端口 / 假上游）与独立网段
 *   （默认 8301 / 8302 / 8303、`dshhub-test-WP56e2-net` = `10.219.63.0/24`，可用环境变量覆盖）；
 * - 用现有 `dshhub/runtime:*` 镜像**只读使用**拉起座舱容器（名字前缀 `dshhub-test-WP56e2-`）。
 *
 * 模型上游两种模式：
 * - **fake**（默认）：本文件起一个假上游（`upstream.ts`），并在容器启动前把 hub-ops 的
 *   `managed/managed.patch.yml` 改写成指向它（见 `model-patch.ts`）。全程离线。
 * - **upstream**（`--upstream-url`）：本机真模型反代。容器访问不到宿主的 127.0.0.1，
 *   所以中间加一层**转发器**（`forwarder.ts`，绑定 `0.0.0.0`），密钥只在那层请求头里出现，
 *   由调用方从环境变量读、不打印不落盘。
 *
 * 清理只按名字删自己起的容器与网络（前缀 + 网段前缀双重核对）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Dockerode from 'dockerode'
import { registerCockpitOpsRoutes } from '../../src/modules/cockpit/index.js'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { FALLBACK_DSH_VERSION, imageForVersion } from '../../src/modules/instances/spec.js'
import { DEFAULT_AUTHORITY, createDshCookieMinter } from '../../src/modules/instances/dsh-cookie.js'
import { waitForReady } from '../../src/modules/instances/readiness.js'
import { resolveUpstreamTarget } from '../../src/modules/instances/types.js'
import {
  startRelayInternalListener,
  type RelayInternalListenerHandle,
} from '../../src/modules/relay/internal-listener.js'
import { startFakeUpstream, type FakeUpstreamHandle, type ReplayScript } from './upstream.js'
import { startUpstreamForwarder, type ForwarderHandle } from './forwarder.js'
import { cockpitModelPatch } from './model-patch.js'
import { seedEvalWorld, type SeededWorld } from './seed.js'
import { CockpitDriver } from './driver.js'

const docker = new Dockerode({ socketPath: process.env['DOCKER_SOCKET'] ?? '/var/run/docker.sock' })

/** 座舱容器的 slug（`hub-ops` 的系统账号；容器名 = 前缀 + 这个） */
export const OPS_SLUG = 'ops'

export interface CockpitHarnessOptions {
  /** 模型上游：`fake`（默认，离线）或 `upstream`（真反代） */
  upstream: 'fake' | 'upstream'
  /** `upstream` 模式下的反代地址（例如 `http://127.0.0.1:8788/v1`） */
  upstreamUrl?: string
  /** `upstream` 模式的密钥（只从环境变量来；不打印、不落盘） */
  upstreamKey?: string
  /** `fake` 模式的回放脚本（或「起完 Hub、播完种子后」再算的工厂函数） */
  scripts?: ReplayScript[] | ((world: SeededWorld) => ReplayScript[])
  /** 评测期间 R1 是否自动执行（默认 false：让所有写都停在 pending，便于断言 I1） */
  autoExecuteR1?: boolean
  /** 假上游每步延迟（毫秒） */
  stepDelayMs?: number
  apiPort?: number
  internalPort?: number
  modelPort?: number
  /** 转发器端口（`upstream` 模式；缺省 modelPort + 1） */
  forwardPort?: number
  network?: string
  subnet?: string
  containerPrefix?: string
  envId?: string
  imageVersion?: string
  /** 保留数据目录（排障用） */
  keepDataDir?: boolean
  /** 是否播评测种子数据（三个用户 + 一个插件；默认 true） */
  seed?: boolean
  /** 额外日志（默认不打印 Hub 的 warn 以下） */
  logLevel?: 'warn' | 'info' | 'debug'
}

export interface CockpitHarness {
  readonly app: Awaited<ReturnType<typeof buildApp>>
  /** `/ops` 的基地址（容器视角：网关 IP + internalPort） */
  readonly opsBaseUrlForContainer: string | null
  /** 容器 IP 与名字 */
  readonly containerName: string
  readonly containerIp: string
  /** 网关 IP（容器能访问宿主的那一个） */
  readonly gateway: string
  /** 假上游（`fake` 模式才有） */
  readonly upstream: FakeUpstreamHandle | null
  /** 转发器（`upstream` 模式才有） */
  readonly forwarder: ForwarderHandle | null
  /** 播种出来的用户 / 插件（评测场景的占位符靠它） */
  readonly world: SeededWorld
  /** 座舱 DSH 的驱动器（直接说一句话、收工具帧） */
  driver(): Promise<CockpitDriver>
  /** 当前驱动器的 cookie origin（容器内 DSH 地址） */
  readonly dshOrigin: string
  /** 关掉一切并清理容器/网络/临时目录 */
  close(): Promise<void>
}

/** 座舱容器名（与生产一致：前缀 + slug） */
export function opsContainerName(prefix: string): string {
  return `${prefix}${OPS_SLUG}`
}

/**
 * 起一个完整的评测环境：临时 Hub（API + `/ops` 内部监听）→ 座舱容器 → 模型指到上游。
 *
 * **顺序很重要**：`bootstrap()` 会 provision 并渲染生产版 `managed.patch.yml`；
 * 我们在这之后、`start()` 之前覆写它，容器起来读到的就是假上游版本。
 */
export async function startCockpitHarness(options: CockpitHarnessOptions): Promise<CockpitHarness> {
  const apiPort = options.apiPort ?? Number(process.env['COCKPIT_EVAL_API_PORT'] ?? '8301')
  const internalPort = options.internalPort ?? Number(process.env['COCKPIT_EVAL_INTERNAL_PORT'] ?? '8302')
  const modelPort = options.modelPort ?? Number(process.env['COCKPIT_EVAL_MODEL_PORT'] ?? '8303')
  const network = options.network ?? process.env['COCKPIT_EVAL_NETWORK'] ?? 'dshhub-test-WP56e2-net'
  const subnet = options.subnet ?? process.env['COCKPIT_EVAL_SUBNET'] ?? '10.219.63.0/24'
  // 容器前缀只能小写（config.ts 的 HUB_CONTAINER_PREFIX 正则）；网络名保留 WP56e2 的大小写
  const containerPrefix =
    options.containerPrefix ?? process.env['COCKPIT_EVAL_CONTAINER_PREFIX'] ?? 'dshhub-test-wp56e2-'
  const envId = options.envId ?? 'wp56e2-eval'
  const imageVersion =
    options.imageVersion ??
    process.env['COCKPIT_EVAL_DSH_VERSION'] ??
    process.env['HUB_SMOKE_DSH_VERSION'] ??
    pickLocalRuntimeVersion()
  const dataDir = mkdtempSync(join(tmpdir(), 'cockpit-eval-'))

  const config = loadConfig({
    HUB_DATA_DIR: dataDir,
    HUB_CONTAINER_DRIVER: 'docker',
    HUB_HTTP_PORT: String(apiPort),
    HUB_TLS_PORT: '0',
    HUB_REDIRECT_PORT: '0',
    HUB_EDGE_PORT: '0',
    HUB_RELAY_INTERNAL_PORT: String(internalPort),
    HUB_CONTAINER_PREFIX: containerPrefix,
    HUB_USERS_NETWORK: network,
    HUB_USERS_SUBNET: subnet,
    HUB_ENV_ID: envId,
    HUB_LOG_LEVEL: options.logLevel ?? 'warn',
  })
  const app = await buildApp({ config })
  const deps = app.deps
  adoptRuntime(deps, imageVersion)
  const world = options.seed === false ? emptyWorld() : seedEvalWorld(deps)
  // 评测口径：把 R1 自动执行关掉，**任何**写操作都必须停在 pending（I1 由服务端读设置决定，
  // 不看请求里的字段）。要验「R1 自动执行」本身时用 autoExecuteR1: true。
  deps.settings.set('cockpit', {
    model: null,
    autoExecuteR1: options.autoExecuteR1 === true,
  })
  const containerName = opsContainerName(containerPrefix)

  let listener: RelayInternalListenerHandle | null = null
  let upstream: FakeUpstreamHandle | null = null
  let forwarder: ForwarderHandle | null = null
  let driver: CockpitDriver | null = null
  let closed = false

  const cleanup = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      await driver?.close()
    } catch {
      // 已经断了
    }
    if (process.env['COCKPIT_EVAL_KEEP_CONTAINER'] !== '1') {
      await deps.driver.remove(containerName).catch(() => undefined)
    }
    await docker
      .getNetwork(network)
      .remove()
      .catch(() => undefined)
    await listener?.close().catch(() => undefined)
    await forwarder?.close().catch(() => undefined)
    await upstream?.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    if (options.keepDataDir !== true) rmSync(dataDir, { recursive: true, force: true })
  }

  try {
    // 上一次跑留下的同名容器（成功退出时没走 cleanup 的历史包袱）先删掉：
    // 只删**我们自己的名字**，且它的 DSH_HOME 指向旧的（可能已删的）数据目录，
    // 留着会让本次的 readiness 永远等不到 `.credentials.yaml`。
    await deps.driver.remove(containerName).catch(() => undefined)
    await deps.driver.ensureNetwork(network, subnet)
    const gateway = await deps.driver.networkGateway(network)
    if (gateway === null) throw new Error(`拿不到网络 ${network} 的网关地址`)
    listener = await startRelayInternalListener({
      deps,
      host: null,
      port: internalPort,
      // 与生产 listeners.ts 一致：座舱 `/ops/*` 挂在同一个内部监听器上
      extraRoutes: (internalApp) => registerCockpitOpsRoutes(internalApp, deps),
    })

    // 1) 先按生产路径 provision（写生产版 managed.patch.yml、建系统账号与实例行）
    const ops = deps.services.cockpitOps
    await ops.bootstrap()

    // 2) 再把模型指到我们的上游
    let modelBaseUrl: string
    if (options.upstream === 'upstream') {
      const upstreamUrl = options.upstreamUrl ?? process.env['COCKPIT_EVAL_UPSTREAM_URL'] ?? ''
      if (upstreamUrl === '') throw new Error('upstream 模式必须给 --upstream-url')
      const key = options.upstreamKey ?? process.env['COCKPIT_EVAL_UPSTREAM_KEY'] ?? ''
      forwarder = await startUpstreamForwarder({
        port: options.forwardPort ?? modelPort + 1,
        upstreamUrl,
        ...(key === '' ? {} : { apiKey: key }),
      })
      modelBaseUrl = `http://${gateway}:${String(forwarder.port)}/v1`
    } else {
      const scripts =
        typeof options.scripts === 'function'
          ? options.scripts(world)
          : (options.scripts ?? [])
      upstream = await startFakeUpstream({
        port: modelPort,
        scripts,
        ...(options.stepDelayMs === undefined ? {} : { stepDelayMs: options.stepDelayMs }),
      })
      modelBaseUrl = upstream.url(gateway)
    }
    writeCockpitModelPatch(deps, modelBaseUrl)

    // 3) 起容器（这一步会因 config_hash 变化重建，数据卷保留）
    await ops.start()
    await ops.whenSettled()

    const info = await deps.driver.inspect(containerName)
    if (info === null || info.state !== 'running' || info.ip === null) {
      throw new Error(`座舱容器没有运行（${String(info?.state ?? 'missing')}）`)
    }
    const ready = await waitForReady({
      driver: deps.driver,
      name: containerName,
      upstream: resolveUpstreamTarget(deps.driver, info),
      authority: DEFAULT_AUTHORITY,
      minter: createDshCookieMinter({ dshHome: deps.paths.userDshHome(OPS_SLUG) }),
      timeoutMs: 180_000,
    })
    if (!ready.ok) {
      const tail = await containerLogs(containerName, 80)
      throw new Error(`座舱 DSH 没有就绪：${ready.reason} ${ready.message}\n--- 容器日志尾部 ---\n${tail}`)
    }

    return {
      app,
      world,
      opsBaseUrlForContainer: `http://${gateway}:${String(internalPort)}/ops`,
      containerName,
      containerIp: info.ip,
      gateway,
      upstream,
      forwarder,
      dshOrigin: `http://${info.ip}:3000`,
      async driver() {
        driver = await openCockpitDriver(deps)
        return driver
      },
      close: cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * 把 hub-ops 的 `managed/managed.patch.yml` 改写成「模型指向假上游」。
 * 必须在 `ops.bootstrap()`（provision）之后、容器启动之前调用。
 */
export function writeCockpitModelPatch(
  deps: Awaited<ReturnType<typeof buildApp>>['deps'],
  baseUrl: string,
): void {
  const dir = deps.paths.userManaged(OPS_SLUG)
  writeFileSync(join(dir, 'managed.patch.yml'), cockpitModelPatch({ baseUrl }), { mode: 0o600 })
}

/**
 * 打开座舱 DSH 的驱动器（与生产 `cloudNodeOptions()` 同一套 cookie/authority）。
 *
 * 先等就绪：重启容器换模型配置之后 DSH 还要几十秒才挂好路由，直接 `createNodeRemote()`
 * 会停在 probe 失败上（冒烟的模型分支就踩过）。
 * @param deps - Hub 依赖
 */
export async function openCockpitDriver(
  deps: Awaited<ReturnType<typeof buildApp>>['deps'],
): Promise<CockpitDriver> {
  const name = opsContainerName(deps.config.containerPrefix)
  const info = await deps.driver.inspect(name)
  const target = info === null ? null : resolveUpstreamTarget(deps.driver, info)
  if (info === null || info.state !== 'running' || target === null) {
    throw new Error('座舱容器没在运行，先 startCockpitHarness()')
  }
  const ready = await waitForReady({
    driver: deps.driver,
    name,
    upstream: target,
    authority: DEFAULT_AUTHORITY,
    minter: createDshCookieMinter({ dshHome: deps.paths.userDshHome(OPS_SLUG) }),
    timeoutMs: 180_000,
  })
  if (!ready.ok) throw new Error(`座舱 DSH 没有就绪：${ready.reason} ${ready.message}`)
  return CockpitDriver.open({
    origin: `http://${target.host}:${String(target.port)}`,
    headers: async () => {
      const cookie = await deps.services.proxy.mintDshCookie(OPS_SLUG)
      return { cookie: `${cookie.name}=${cookie.value}`, host: DEFAULT_AUTHORITY }
    },
    log: (event, meta) => deps.logger.debug({ ...meta, driver: event }, '座舱驱动器'),
  })
}

/** `seed: false` 时的空世界（占位符一个都不换） */
function emptyWorld(): SeededWorld {
  return {
    users: [],
    plugin: { id: 0, packageName: '' },
    versions: [],
    relayModel: { id: 0, name: '' },
    placeholders: {},
  }
}

/** 容器日志尾部（只用于失败现场；不含任何密钥） */
async function containerLogs(name: string, lines: number): Promise<string> {
  try {
    const buffer = (await docker.getContainer(name).logs({
      stdout: true,
      stderr: true,
      tail: lines,
    })) as unknown as Buffer
    // docker 的多路复用流：去掉 8 字节头
    const text = buffer.toString('utf8')
    // docker 的多路复用流前 8 字节是头（可能夹控制字符），把不可见字符剔掉再返回
    return [...text].filter((char) => char === '\n' || char === '\t' || char >= ' ').join('')
  } catch (error) {
    return `（读不到容器日志：${error instanceof Error ? error.message : String(error)}）`
  }
}

/** 镜像在不在（不在就明确报错，别让上游报一个看不懂的 docker 错） */
export async function requireRuntimeImage(version: string): Promise<string> {
  const image = imageForVersion(version)
  const images = await docker.listImages({ filters: { reference: [image] } })
  if (images.length === 0) throw new Error(`找不到运行时镜像 ${image}（先构建或设置 HUB_SMOKE_DSH_VERSION）`)
  return image
}

/**
 * 挑本机最新的一枚 `dshhub/runtime:*` 镜像（只看 tag，不改镜像）。
 *
 * 为什么不直接用 `FALLBACK_DSH_VERSION`：那是 `0.2.0-rc.2`（WP8a 时代的默认），
 * 本机现在只有 `0.2.1-rc.2` 系；写死会让冒烟/评测在一个缺镜像的环境里莫名其妙地 409。
 * 用环境变量（`COCKPIT_EVAL_DSH_VERSION` / `HUB_SMOKE_DSH_VERSION`）可以钉住。
 */
export function pickLocalRuntimeVersion(): string {
  try {
    const output = execFileSync(
      'docker',
      ['images', '--format', '{{.Repository}}:{{.Tag}}', 'dshhub/runtime'],
      { encoding: 'utf8', timeout: 10_000 },
    )
    const tags = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('dshhub/runtime:'))
      .map((line) => line.slice('dshhub/runtime:'.length))
      .filter((tag) => tag !== '' && tag !== 'latest')
    if (tags.length === 0) return FALLBACK_DSH_VERSION
    // 版本号按「数字段」比较（0.2.1-rc.2 > 0.2.0-rc.2）；带构建后缀的排在同版本之后
    const score = (tag: string): number[] =>
      tag
        .split(/[.-]/u)
        .map((part) => (/^\d+$/u.test(part) ? Number(part) : 0))
        .slice(0, 6)
    tags.sort((a, b) => {
      const left = score(a)
      const right = score(b)
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0)
        if (diff !== 0) return diff
      }
      return a.localeCompare(b)
    })
    return tags[tags.length - 1] ?? FALLBACK_DSH_VERSION
  } catch {
    return FALLBACK_DSH_VERSION
  }
}

/**
 * 把本机已有的镜像登记成 ready 的默认运行时（等价于 `cli runtime:adopt <版本> --default`，
 * 但只动**临时库**：这几行在 `mkdtemp` 出来的数据目录里，跑完就删）。
 *
 * 不这么做的话 `instances` 会去用 `FALLBACK_DSH_VERSION`（0.2.0-rc.2）而本机没有那个镜像，
 * 报 `RUNTIME_NOT_READY: 运行时镜像尚未就绪`。
 */
export function adoptRuntime(deps: Awaited<ReturnType<typeof buildApp>>['deps'], dshVersion: string): void {
  const existing = deps.db.get<{ id: number; status: string; is_default: number }>(
    'SELECT id, status, is_default FROM runtimes WHERE dsh_version = ?',
    dshVersion,
  )
  if (existing !== undefined) {
    if (existing.status !== 'ready') {
      deps.db.run("UPDATE runtimes SET status = 'ready' WHERE id = ?", existing.id)
    }
    if (existing.is_default !== 1) {
      deps.db.run('UPDATE runtimes SET is_default = 0 WHERE is_default = 1')
      deps.db.run('UPDATE runtimes SET is_default = 1 WHERE id = ?', existing.id)
    }
    return
  }
  deps.db.run('UPDATE runtimes SET is_default = 0 WHERE is_default = 1')
  deps.db.run(
    `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
     VALUES (?, ?, 'ready', 1, ?, ?)`,
    dshVersion,
    imageForVersion(dshVersion),
    'cockpit-eval：本机已存在的镜像（测试用临时库）',
    deps.clock.nowIso(),
  )
}
