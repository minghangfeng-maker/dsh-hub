/**
 * 座舱 DSH 的实例生命周期（WP56b / docs/24 §5）。
 *
 * 它做四件事，全部只围绕一个系统账号：
 *
 * 1. **账号与实例**：确保 `users` 里有 `hub-ops`（`is_system=1`、`role='user'`）与它的
 *    `instances` 行（slug = `ops` → 容器 `dshhub-ops`、数据目录 `users/ops/`）；
 * 2. **容器规格**：通过 instances 的「规格覆盖」钩子把座舱容器改成 2 CPU / 2 GB、
 *    **不带出网代理**、并注入 `DSHHUB_OPS_URL` / `DSHHUB_OPS_TOKEN`（令牌只在容器 env 里）；
 * 3. **令牌与 IP**：每次（重新）建容器换一枚新令牌（旧的立即作废），每次启动回写容器 IP；
 *    `/ops/*` 的鉴权就是「令牌哈希对得上 **且** 来源 IP 等于这一行」；
 * 4. **插件**：把仓库 `runtime/plugins/dshhub-ops/` 同步进容器内用户目录并按需
 *    `dsh plugin --profile web add file:/home/dsh/ops-plugin` —— 复用现有插件安装管线
 *    （同一套 CLI 与 profile 文件），但**不进插件库**、普通用户看不到也下发不到。
 *
 * 明确不做的事（docs/24 §7 + 编排者补充）：座舱容器**不挂 docker.sock**、不加 `--privileged`、
 * 不加额外 capability；它和普通用户容器同网段同规则（只放行内部监听器），
 * 想动别的容器一律走 Hub 能力。
 *
 * @module @dsh-hub/api/modules/cockpit/ops-instance
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { OpsStatus } from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { randomToken, sha256Hex, timingSafeEqualStr } from '../../lib/crypto.js'
import { hashPassword } from '../../lib/password.js'
import { ensureUserDirs } from '../../lib/paths.js'
import { DEFAULT_AUTHORITY, createDshCookieMinter } from '../instances/dsh-cookie.js'
import { waitForReady } from '../instances/readiness.js'
import { containerNameFor } from '../instances/spec.js'
import { resolveUpstreamTarget, type ContainerSpec } from '../instances/types.js'
import {
  findSystemUser,
  getOpsInstanceRow,
  insertSystemUser,
  readSettingsJson,
  saveOpsInstanceIp,
  saveOpsInstanceRow,
} from './ops-repo.js'
import type { OpsInstanceProbe } from './ops-probe.js'

/** 座舱容器规格（docs/24 §5：2 CPU / 2 GB）。 */
export const OPS_CPUS = 2
export const OPS_MEMORY_MB = 2048

/** 容器内的插件目录（bind mount 的是整个 home，所以它在 `/home/dsh` 下）。 */
export const CONTAINER_OPS_PLUGIN_DIR = '/home/dsh/ops-plugin'

/** 同步进容器的插件文件（指纹也按这份清单算） */
const OPS_PLUGIN_FILES = [
  'index.js',
  'tools.js',
  'guard.js',
  'client.js',
  'session.js',
  'package.json',
  'cordis.patch.yml',
  'README.md',
] as const
/** 插件安装命令超时（05 的一次性维护容器口径，10 分钟）。 */
const INSTALL_TIMEOUT_MS = 10 * 60_000

/**
 * 座舱设置里允许覆盖的字段（`settings.cockpit`，由 WP56a 的
 * `PUT /api/admin/cockpit/settings` 写入）。这里只**读**，写归他们。
 */
const CockpitSettingsShape = z
  .object({
    model: z.string().trim().min(1).max(200).nullable().optional(),
    autoExecuteR1: z.boolean().optional(),
  })
  .partial()

export interface OpsInstanceService extends OpsInstanceProbe {
  /** Hub 启动时调（幂等）：确保账号与实例行；容器在跑就同步 IP */
  bootstrap(): Promise<void>
  /** 起容器并（近似）等到就绪；`/admin` 打开时也走它 */
  start(): Promise<OpsStatus>
  /** 容器名字（测试与排障用） */
  containerName(): string
  /** 等后台的启动 / 安装任务结束（测试用；生产不要 await） */
  whenSettled(): Promise<void>
  /** 停掉后台任务（Hub 关闭时） */
  dispose(): void
}

/**
 * 建座舱实例服务。**装配顺序**：必须在 `instances` 之后建（要注册规格覆盖钩子）。
 * @param deps - 组装好的 AppDeps（`services.instances` 已存在）
 */
export function createOpsInstance(deps: AppDeps): OpsInstanceService {
  const db = deps.db
  const log = deps.logger

  /** 本次进程里「即将写进容器 env」的令牌原文；Hub 重启后为 null（那时只需校验哈希）。 */
  let pendingToken: string | null = null
  /** 后台任务（起容器 / 装插件）串行化：同一时刻只有一个 */
  let task: Promise<void> | null = null
  /** 规格覆盖钩子注册过没有（重复 create 不会重复注册） */
  let overlayRegistered = false
  let disposed = false

  const containerName = (): string =>
    containerNameFor(findSystemUser(db)?.slug ?? 'ops', deps.config.containerPrefix)

  /** 系统账号（同步查库：调用点很密，缓存反而容易读到旧值）。 */
  function systemUser(): { id: number; slug: string } | null {
    const row = findSystemUser(db)
    return row === null || row === undefined ? null : { id: row.id, slug: row.slug }
  }

  /**
   * `settings.cockpit`（WP56a 写）——读不到就用默认值。
   * 用鸭子类型读：本包与 WP56a 并行开发，settings 的 key 表在对方分支上。
   */
  function cockpitSettings(): z.infer<typeof CockpitSettingsShape> {
    // 1) 先问 SettingsStore：WP56a 合并后 'cockpit' 会成为正式 key（默认值与校验都在那边）
    try {
      const store = deps.settings as unknown as { get(key: string): unknown }
      const parsed = CockpitSettingsShape.safeParse(store.get('cockpit'))
      if (parsed.success && Object.keys(parsed.data).length > 0) return parsed.data
    } catch {
      // 这个键还不存在（本分支先于 WP56a 的 settings 落地）→ 走原始行
    }
    // 2) 兜底：直接读 settings 表的原始 JSON（并行开发期间两边都能跑）
    const parsed = CockpitSettingsShape.safeParse(readSettingsJson(deps.db, 'cockpit'))
    return parsed.success ? parsed.data : {}
  }

  /** 座舱模型（默认 `deepseek-v4.1-flash`，与 docs/24 §5 一致）。 */
  function modelName(): string {
    return cockpitSettings().model ?? 'deepseek-v4.1-flash'
  }

  /** R1 自动执行策略：缺省 true（docs/24 §0 的默认策略）。 */
  function autoExecuteR1(): boolean {
    return cockpitSettings().autoExecuteR1 ?? true
  }

  /**
   * `/ops` 的基地址：与中转站内部监听器同一个「网关 IP:端口」，只是路径换成 `/ops`。
   * `HUB_OPS_BASE_URL` 可覆盖（冒烟脚本用临时 Hub 的端口）。
   */
  function opsBaseUrl(): string | null {
    const override = process.env['HUB_OPS_BASE_URL']
    if (typeof override === 'string' && override.trim().length > 0)
      return override.trim().replace(/\/+$/u, '')
    const relay = deps.services.relay
    const base = relay?.internalBaseUrl?.() ?? null
    if (base === null) return null
    return base.replace(/\/v1\/?$/u, '/ops')
  }

  /** 建系统账号（幂等）。口令是随机生成的**一次性**值，用完即丢：这个账号不能登录。 */
  function ensureAccount(): { id: number; slug: string } {
    const existing = systemUser()
    if (existing !== null) return existing
    const at = deps.clock.nowIso()
    const id = insertSystemUser(db, { passwordHash: hashPassword(randomToken(32)), at })
    deps.audit.log({
      actorId: null,
      actorIp: null,
      action: 'cockpit.system-account-create',
      targetType: 'user',
      targetId: id,
      detail: { username: 'hub-ops' },
    })
    log.info({ userId: id }, '已创建座舱系统账号 hub-ops')
    return { id, slug: 'ops' }
  }

  /** 实例行（+ 目录）存在性：不存在就 provision（不建容器）。 */
  async function ensureInstance(user: { id: number }): Promise<void> {
    const summary = await deps.services.instances.getSummary(user.id)
    if (summary.status === 'absent') await deps.services.instances.provision(user.id, { reason: 'admin' })
  }

  /**
   * 规格覆盖：座舱容器 = 普通运行时容器 + 2C2G + 两个 `/ops` env。
   *
   * 只改 `cpus/memoryMb/env`：挂载、网络、只读根、tmpfs、标签全部沿用 instances 的基线
   * （所以「不能挂 docker.sock」这类安全边界不需要在这里重复实现，也不会被绕过）。
   */
  function overlay(userId: number, spec: ContainerSpec): ContainerSpec | null {
    const user = systemUser()
    if (user === null || userId !== user.id) return null
    const env = { ...spec.env }
    const base = opsBaseUrl()
    if (base !== null) env.DSHHUB_OPS_URL = base
    if (pendingToken !== null) env.DSHHUB_OPS_TOKEN = pendingToken
    env.DSHHUB_OPS_MODE = '1'
    return { ...spec, cpus: OPS_CPUS, memoryMb: OPS_MEMORY_MB, env }
  }

  function registerOverlay(): void {
    if (overlayRegistered) return
    overlayRegistered = true
    deps.services.instances.registerSpecOverlay(overlay)
  }

  /** 换一枚新令牌并落库（哈希）：旧令牌在下一次 `verify` 起立即失效。 */
  function rotateToken(user: { slug: string }): string {
    const token = randomToken(32)
    const at = deps.clock.nowIso()
    saveOpsInstanceRow(db, {
      tokenHash: sha256Hex(token),
      containerName: containerNameFor(user.slug, deps.config.containerPrefix),
      containerIp: null,
      at,
    })
    pendingToken = token
    return token
  }

  /** 容器启动后回写 IP（`/ops/*` 的 IP 白名单就是这一列）。 */
  async function recordIp(name: string): Promise<string | null> {
    const info = await deps.driver.inspect(name)
    if (info === null || info.state !== 'running' || info.ip === null) return null
    saveOpsInstanceIp(db, { containerIp: info.ip, at: deps.clock.nowIso() })
    return info.ip
  }

  // ── 插件安装（复用现有 CLI 管线，但不进插件库） ──────────────────────────

  /** 插件源目录：仓库 `runtime/plugins/dshhub-ops/`（`HUB_OPS_PLUGIN_DIR` 可覆盖）。 */
  function pluginSourceDir(): string | null {
    const override = process.env['HUB_OPS_PLUGIN_DIR']
    if (typeof override === 'string' && override.trim().length > 0) return override.trim()
    // src 与 dist 的目录深度相同（apps/api/{src,dist}/modules/cockpit）
    const candidate = fileURLToPath(new URL('../../../../../runtime/plugins/dshhub-ops/', import.meta.url))
    return existsSync(join(candidate, 'package.json')) ? candidate : null
  }

  function pluginVersion(dir: string): string | null {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : null
    } catch {
      return null
    }
  }

  /**
   * 插件指纹 = 版本号 + 文件内容哈希。只比版本号会漏掉「改了守则没改版本」的发版
   * （2026-10-30 WP56h 上线后座舱一直跑旧守则，就是这个原因）。
   */
  function pluginFingerprint(sourceDir: string, version: string): string {
    const hash = createHash('sha256')
    for (const entry of OPS_PLUGIN_FILES) {
      const from = join(sourceDir, entry)
      hash.update(`${entry}\0`)
      if (existsSync(from)) hash.update(readFileSync(from))
      hash.update('\0')
    }
    return `${version}+${hash.digest('hex').slice(0, 16)}`
  }

  /**
   * 把插件源同步进用户 home（容器里就是 `/home/dsh/ops-plugin`，只读源不写源）。
   * 返回 `changed`：指纹变了（新版本或内容变了）——调用方据此重装插件并重启座舱。
   */
  function syncPlugin(
    user: { slug: string },
    sourceDir: string,
    version: string,
  ): { target: string; changed: boolean } {
    const target = join(deps.paths.userHome(user.slug), 'ops-plugin')
    const marker = join(target, '.hub-version')
    const fingerprint = pluginFingerprint(sourceDir, version)
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === fingerprint)
      return { target, changed: false }
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const entry of OPS_PLUGIN_FILES) {
      const from = join(sourceDir, entry)
      if (existsSync(from)) cpSync(from, join(target, entry))
    }
    writeFileSync(marker, `${fingerprint}\n`, { mode: 0o600 })
    log.info({ slug: user.slug, fingerprint }, '已同步座舱插件到用户目录')
    return { target, changed: true }
  }

  /** profile 里装了没有（读 profile package.json 的 dependencies）。 */
  function profileHasPlugin(user: { slug: string }): boolean {
    try {
      const file = join(deps.paths.userProfileDir(user.slug), 'package.json')
      if (!existsSync(file)) return false
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }
      return typeof parsed.dependencies?.['@dshhub/ops'] === 'string'
    } catch {
      return false
    }
  }

  /** 在容器里跑一条命令（running 用 exec，否则用同规格的一次性维护容器）。 */
  async function runInOpsContainer(user: { id: number }, cmd: string[]): Promise<void> {
    const name = containerName()
    const env = { npm_config_registry: deps.config.npmRegistry }
    const info = await deps.driver.inspect(name)
    if (info?.state === 'running') {
      const result = await deps.driver.exec(name, cmd, { env, timeoutMs: INSTALL_TIMEOUT_MS })
      if (result.exitCode !== 0)
        throw new HubError('UPSTREAM_ERROR', `${cmd.join(' ')} 失败（exit ${String(result.exitCode)}）`)
      return
    }
    const spec = await deps.services.instances.buildSpec(user.id)
    const result = await deps.driver.runOnce(spec, cmd, { env, timeoutMs: INSTALL_TIMEOUT_MS })
    if (result.exitCode !== 0)
      throw new HubError('UPSTREAM_ERROR', `${cmd.join(' ')} 失败（exit ${String(result.exitCode)}）`)
  }

  /**
   * 确保座舱容器里装的是匹配版本的插件。
   * 失败只记日志：没有插件时座舱 DSH 依然能对话，只是没有管理工具（比整个起不来强）。
   */
  /** 返回 true = 这次真的（重新）装了插件，正在运行的座舱要重启一次才会加载。 */
  async function ensurePlugin(user: { id: number; slug: string }): Promise<boolean> {
    const sourceDir = pluginSourceDir()
    if (sourceDir === null) {
      log.warn('找不到座舱插件源目录（runtime/plugins/dshhub-ops），跳过安装')
      return false
    }
    const version = pluginVersion(sourceDir)
    if (version === null) {
      log.warn({ sourceDir }, '座舱插件源没有合法的 package.json，跳过安装')
      return false
    }
    const { changed } = syncPlugin(user, sourceDir, version)
    // profile 里的插件是一份目录拷贝：源变了就重跑 `dsh plugin add`（实测会刷新这份拷贝）
    if (!changed && profileHasPlugin(user)) return false
    ensureUserDirs(deps.paths, user.slug)
    try {
      // profile 不存在时先生成模板（与 plugins 安装器同一手法：dsh --profile web --help）
      if (!existsSync(join(deps.paths.userProfileDir(user.slug), 'package.json'))) {
        await runInOpsContainer(user, ['dsh', '--profile', 'web', '--help'])
      }
      await runInOpsContainer(user, [
        'dsh',
        'plugin',
        '--profile',
        'web',
        'add',
        `file:${CONTAINER_OPS_PLUGIN_DIR}`,
      ])
      deps.audit.log({
        actorId: user.id,
        actorIp: null,
        action: 'cockpit.ops-plugin-install',
        targetType: 'instance',
        targetId: user.id,
        detail: { version },
      })
      log.info({ version }, '座舱插件已安装')
      return true
    } catch (error) {
      log.warn({ err: error }, '座舱插件安装失败（座舱不带管理工具继续可用）')
      return false
    }
  }

  /** 装完插件要重启一次才会加载；只在「刚装好」时重启，已装好的不重启。 */
  async function restartAfterInstall(user: { id: number; slug: string }): Promise<void> {
    // 没装过、或插件内容变了（Hub 升级带来新守则/新工具）才重装 + 重启；其余情况不打扰正在跑的座舱
    const installed = await ensurePlugin(user)
    if (!installed) return
    const info = await deps.driver.inspect(containerName())
    if (info?.state !== 'running' || !profileHasPlugin(user)) return
    await deps.driver.restart(containerName(), 15)
    await waitForReady({
      driver: deps.driver,
      name: containerName(),
      upstream: info === null ? null : resolveUpstreamTarget(deps.driver, info),
      authority: DEFAULT_AUTHORITY,
      minter: createDshCookieMinter({ dshHome: deps.paths.userDshHome(user.slug) }),
    })
  }

  // ── 启动 / 重启 ────────────────────────────────────────────────────────────

  /** 后台任务串行化：重复调用复用同一个 Promise（并发 3 次「打开 /admin」只起一个容器）。 */
  function schedule(fn: () => Promise<void>): Promise<void> {
    if (task !== null) return task
    task = fn()
      .catch((error: unknown) => {
        log.warn({ err: error }, '座舱容器启动失败')
      })
      .finally(() => {
        task = null
      })
    return task
  }

  async function startInternal(): Promise<void> {
    if (disposed) return
    const user = ensureAccount()
    await ensureInstance(user)
    const name = containerName()
    const info = await deps.driver.inspect(name)
    if (info?.state === 'running') {
      await recordIp(name)
      await restartAfterInstall(user)
      return
    }
    // 要起容器了：换一枚新令牌（旧令牌立即作废）；规格因此变化，instances 会重建容器
    rotateToken(user)
    await ensurePlugin(user)
    await deps.services.instances.ensureRunning(user.id, { reason: 'admin' })
    await recordIp(name)
    await restartAfterInstall(user)
  }

  function statusOf(
    state: string | null,
    exitCode: number | null,
  ): { instance: OpsStatus['instance']; reason?: string } {
    if (state === null) return { instance: 'missing', reason: '座舱容器还没创建' }
    switch (state) {
      case 'running':
        return { instance: 'running' }
      case 'created':
      case 'restarting':
      case 'paused':
      case 'removing':
        return { instance: 'starting', reason: '座舱容器正在启动' }
      case 'exited':
        return exitCode === 0
          ? { instance: 'stopped', reason: '座舱容器已停止（打开管理座舱会自动拉起）' }
          : { instance: 'error', reason: `座舱容器异常退出（exit ${String(exitCode ?? '?')}）` }
      default:
        return { instance: 'error', reason: `座舱容器状态异常：${state}` }
    }
  }

  const service: OpsInstanceService = {
    async status(): Promise<OpsStatus> {
      const model = modelName()
      const auto = autoExecuteR1()
      if (systemUser() === null) {
        return { instance: 'missing', model, autoExecuteR1: auto, reason: '系统账号还没建好' }
      }
      let info = null
      try {
        info = await deps.driver.inspect(containerName())
      } catch (error) {
        log.warn({ err: error }, '读取座舱容器状态失败')
        return { instance: 'error', model, autoExecuteR1: auto, reason: '读不到容器状态（容器引擎不可用）' }
      }
      const state = statusOf(info?.state ?? null, info?.exitCode ?? null)
      return {
        instance: state.instance,
        model,
        autoExecuteR1: auto,
        ...(state.reason === undefined ? {} : { reason: state.reason }),
      }
    },

    verify(token: string, remoteIp: string): boolean {
      if (typeof token !== 'string' || token.length === 0) return false
      if (typeof remoteIp !== 'string' || remoteIp.length === 0) return false
      const row = getOpsInstanceRow(db)
      if (row === undefined) return false
      // 先比哈希再比 IP：两者都对才算「还是这台座舱、还是这次启动」
      if (!timingSafeEqualStr(row.tokenHash, sha256Hex(token))) return false
      return row.containerIp !== null && row.containerIp === remoteIp
    },

    async ensureStarted(): Promise<void> {
      registerOverlay()
      const user = ensureAccount()
      await ensureInstance(user)
      void schedule(startInternal)
    },

    async restart(): Promise<void> {
      registerOverlay()
      const user = ensureAccount()
      await ensureInstance(user)
      rotateToken(user)
      await schedule(async () => {
        await ensurePlugin(user)
        // 规格里的令牌变了 → instances 判定 config_hash 变化 → 删旧容器重建
        await deps.services.instances.restart(user.id, { reason: 'admin' })
        await recordIp(containerName())
      })
      deps.audit.log({
        actorId: user.id,
        actorIp: null,
        action: 'cockpit.ops-restart',
        targetType: 'instance',
        targetId: user.id,
        detail: { container: containerName() },
      })
    },

    systemUserId(): number | null {
      return systemUser()?.id ?? null
    },

    async bootstrap(): Promise<void> {
      registerOverlay()
      const user = ensureAccount()
      await ensureInstance(user)
      const info = await deps.driver.inspect(containerName())
      if (info?.state === 'running') {
        await recordIp(containerName())
        void schedule(async () => {
          await restartAfterInstall(user)
        })
      }
    },

    async start(): Promise<OpsStatus> {
      registerOverlay()
      const user = ensureAccount()
      await ensureInstance(user)
      await schedule(startInternal)
      return service.status()
    },

    containerName,

    async whenSettled(): Promise<void> {
      while (task !== null) await task
    },

    dispose(): void {
      disposed = true
    },
  }

  registerOverlay()
  return service
}
