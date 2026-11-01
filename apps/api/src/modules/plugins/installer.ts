import { basename } from 'node:path'
import type { PluginPolicy } from '@dsh-hub/shared'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { withUserLock } from '../../lib/locks.js'
import { ensureUserDirs } from '../../lib/paths.js'
import {
  DEFAULT_AUTHORITY,
  containerNameFor,
  createDshCookieMinter,
  resolveUpstreamTarget,
} from '../instances/index.js'
import { waitForReady } from '../instances/readiness.js'
import { applyPackageChanges, readBundles, readDependencies, PROFILE_BACKUP_KEEP } from './package-json.js'
import { createProfileFiles, type ProfileFiles } from './profile.js'
import {
  getPluginRow,
  getUserPluginRow,
  getUserRefRow,
  getVersionRow,
  latestVersionRow,
  listPluginRows,
  requirePluginRow,
  setUserPluginActual,
  upsertUserPluginRow,
  type PluginRow,
  type PluginVersionRow,
  type UserRefRow,
} from './repo.js'

/**
 * 单用户插件安装执行器（06 §2.4）。Hub 负责顺序与回滚，装包动作交给官方
 * `dsh plugin --profile web add|remove`（WP0b S4 实测：它同时改 dependencies 与 bundles）。
 *
 * **谁持锁**：本模块自己取 `withUserLock`（06 §2.4 步骤 1）。所有调用路径（jobs 引擎的 runTask、
 * 实例启动时的 bootstrap）也取同一把锁 —— 靠 `lib/locks.ts` 的**可重入**语义避免自锁：
 * 已在本异步上下文持锁时是空操作，独立调用（测试、脚本）时则真的串行化。
 */
export interface InstallForUserOutcome {
  installed: { pluginId: number; packageName: string; versionId: number }[]
  removed: { pluginId: number; packageName: string }[]
  restarted: boolean
  /** 因 `restart: 'next-start'` 或实例未运行而没有立即重启 */
  deferredRestart: boolean
}

export interface PluginChangesLike {
  add: { id: number; version: string }[]
  remove: { id: number; packageName: string }[]
}

export interface InstallOptions {
  restart: 'now' | 'next-start'
  onLog?: (line: string) => void
  signal?: AbortSignal
  /** 写入 user_plugins 的 source（rollout=admin / 用户自助=user / bootstrap=policy） */
  source?: 'admin' | 'user' | 'policy'
}

export interface PluginInstaller {
  installForUser(
    userId: number,
    changes: PluginChangesLike,
    opts: InstallOptions,
  ): Promise<InstallForUserOutcome>
  /** 首次启动装 required + default（06 §2.5）；失败抛错（由实例服务决定不阻塞启动） */
  bootstrapUser(userId: number, opts: InstallOptions): Promise<{ installed: string[]; failed: string[] }>
  /** 轻量对账：required 插件缺失/版本落后就补装（06 §2.2「下次对账也会装回来」） */
  reconcileUser(userId: number, opts: InstallOptions): Promise<{ changed: string[] }>
  /** 实例就绪后，为「required 有差异」的用户排队一次后台对账（不阻塞调用方） */
  scheduleReconcile(userId: number): void
  /** 等该用户的后台对账结束（测试/关停用） */
  waitForReconcile(userId: number): Promise<void>
}

/** 安装命令超时（06 §2.4：10 分钟） */
export const INSTALL_TIMEOUT_MS = 10 * 60_000
/** 一次性维护容器里跑 `pnpm install` 的超时 */
export const PNPM_TIMEOUT_MS = 5 * 60_000
/** 重启后就绪等待上限（05 §6：90s）；`HUB_INSTANCE_READY_TIMEOUT_MS` 可覆盖（集成测试用） */
export const RESTART_READY_TIMEOUT_MS = 90_000

export function restartReadyTimeoutMs(): number {
  const raw = process.env.HUB_INSTANCE_READY_TIMEOUT_MS
  const value = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : RESTART_READY_TIMEOUT_MS
}

const PROFILE_CONTAINER_DIR = '/home/dsh/.dsh/profiles/web'

/**
 * `dsh plugin add` 的实参（WP8a e2e 发现）：
 * `plugin_versions.spec` 是**写进 package.json 的值**（06 §2.1：npm 源就是精确版本 `0.16.0`），
 * 但 CLI 需要「包名@版本」——只传 `0.16.0` 会让 pnpm 去 registry 找名为 `0.16.0` 的包并 404。
 * tarball（URL）与 local/upload（`file:…`）的 spec 本身就是合法的 CLI 实参。
 */
export function cliAddSpec(plugin: PluginRow, version: PluginVersionRow): string {
  return version.source_type === 'npm' ? `${plugin.package_name}@${version.version}` : version.spec
}

export function createPluginInstaller(deps: BaseDeps): PluginInstaller {
  const db = deps.db
  const pendingReconciles = new Map<number, Promise<void>>()

  function log(opts: InstallOptions, line: string): void {
    opts.onLog?.(line)
  }

  function requireUser(userId: number): UserRefRow {
    const user = getUserRefRow(db, userId)
    if (!user || user.deleted_at) throw new HubError('NOT_FOUND', '用户不存在')
    return user
  }

  function profileOf(user: UserRefRow): ProfileFiles {
    return createProfileFiles(deps.paths.userProfileDir(user.slug))
  }

  function lineWriter(opts: InstallOptions): (chunk: string) => void {
    let buffer = ''
    return (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trimEnd()
        if (text.length > 0) log(opts, text)
      }
    }
  }

  function ensureNotAborted(opts: InstallOptions): void {
    if (opts.signal?.aborted) {
      throw Object.assign(new Error('插件安装被取消'), { name: 'AbortError' })
    }
  }

  /** 在容器里跑一条命令：实例 running 用 exec，否则用一次性维护容器（06 §2.4 步骤 3） */
  async function runInContainer(
    user: UserRefRow,
    cmd: string[],
    opts: InstallOptions,
    timeoutMs = INSTALL_TIMEOUT_MS,
  ): Promise<{ exitCode: number; output: string }> {
    ensureNotAborted(opts)
    const services = (deps as Partial<AppDeps>).services
    const instances = services?.instances
    const env = { npm_config_registry: deps.config.npmRegistry }
    const onOutput = lineWriter(opts)
    const name = containerNameFor(user.slug, deps.config.containerPrefix)
    const status = instances ? instances.currentStatus(user.id) : 'absent'
    if (status === 'running') {
      return deps.driver.exec(name, cmd, { env, timeoutMs, onOutput })
    }
    if (!instances) throw new HubError('INTERNAL', '实例服务未装配，无法创建一次性容器')
    // 一次性容器要 bind mount 用户目录：必须由 Hub 先建好（已存在时是空操作），否则 Docker
    // 会以 root 建目录，容器里的 uid 1000 随后写 /home/dsh/.dsh 报 Permission denied
    ensureUserDirs(deps.paths, user.slug)
    const spec = await instances.buildSpec(user.id)
    return deps.driver.runOnce(spec, cmd, { env, timeoutMs, onOutput })
  }

  /** 官方安装/卸载命令（WP0b S4：同时写 dependencies 与 bundles） */
  async function runPluginCommand(
    user: UserRefRow,
    action: 'add' | 'remove',
    spec: string,
    opts: InstallOptions,
  ): Promise<void> {
    const display = `${action === 'add' ? '安装' : '卸载'} ${spec}`
    log(opts, `$ dsh plugin --profile web ${action} ${spec}`)
    const started = Date.now()
    const result = await runInContainer(user, ['dsh', 'plugin', '--profile', 'web', action, spec], opts)
    log(opts, `${display} 结束：exit=${String(result.exitCode)}（${String(Date.now() - started)}ms）`)
    if (result.exitCode !== 0) {
      throw new HubError(
        'UPSTREAM_ERROR',
        `dsh plugin ${action} ${spec} 失败（exit ${String(result.exitCode)}）`,
        {
          exitCode: result.exitCode,
        },
      )
    }
  }

  /** 还原 package.json 后重跑 pnpm install，让 node_modules/lockfile 回到旧状态（06 §2.4 步骤 5） */
  async function restoreAndReinstall(
    user: UserRefRow,
    profile: ProfileFiles,
    backupPath: string | null,
    opts: InstallOptions,
  ): Promise<void> {
    if (backupPath) {
      try {
        profile.restore(backupPath)
        log(opts, `已还原 profile package.json ← ${basename(backupPath)}`)
      } catch (error) {
        log(opts, `还原 package.json 失败：${errorText(error)}`)
      }
    }
    try {
      const result = await runInContainer(
        user,
        ['pnpm', 'install', '--dir', PROFILE_CONTAINER_DIR],
        opts,
        PNPM_TIMEOUT_MS,
      )
      log(opts, `pnpm install 结束：exit=${String(result.exitCode)}`)
    } catch (error) {
      log(opts, `pnpm install 失败（忽略）：${errorText(error)}`)
    }
  }

  /** 就绪检查 + 失败重试（06 §2.4 步骤 7）：只重启，不动规格（不涉及 recreate） */
  async function restartAndWait(
    user: UserRefRow,
    opts: InstallOptions,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const name = containerNameFor(user.slug, deps.config.containerPrefix)
    log(opts, '重启 DSH 以加载插件…')
    await deps.driver.restart(name, 15)
    const info = await deps.driver.inspect(name)
    const upstream = info ? resolveUpstreamTarget(deps.driver, info) : null
    const minter = createDshCookieMinter({ dshHome: deps.paths.userDshHome(user.slug) })
    minter.invalidate()
    const ready = await waitForReady({
      driver: deps.driver,
      name,
      upstream,
      authority: DEFAULT_AUTHORITY,
      minter,
      timeoutMs: restartReadyTimeoutMs(),
    })
    if (ready.ok) {
      log(opts, `重启后已就绪（${String(ready.waitedMs)}ms）`)
      return { ok: true }
    }
    return { ok: false, message: ready.message }
  }

  /** profile 不存在时先用一次性容器创建（WP0b S3：`dsh --profile web --help` 0.09s 生成模板） */
  async function ensureProfile(user: UserRefRow, opts: InstallOptions): Promise<ProfileFiles> {
    const profile = profileOf(user)
    if (profile.exists()) return profile
    log(opts, 'profile 尚未创建，先用一次性容器生成模板…')
    const result = await runInContainer(user, ['dsh', '--profile', 'web', '--help'], opts, 120_000)
    if (result.exitCode !== 0 || !profile.exists()) {
      throw new HubError('INSTANCE_START_FAILED', '无法创建 DSH profile（dsh --profile web --help 失败）', {
        exitCode: result.exitCode,
      })
    }
    return profile
  }

  async function renderManaged(userId: number, opts: InstallOptions): Promise<void> {
    const services = (deps as Partial<AppDeps>).services
    if (!services?.models?.renderManaged) return
    try {
      await services.models.renderManaged(userId)
      log(opts, '已重渲染 managed.patch.yml')
    } catch (error) {
      // 插件配置渲染失败不该让「装包成功」变成失败：记日志，用户下次启动/下发会再渲染
      log(opts, `managed.patch.yml 渲染失败（忽略）：${errorText(error)}`)
      deps.logger.warn({ err: error, userId }, '插件安装后重渲染 managed.patch.yml 失败')
    }
  }

  function bundleOrders(): Record<string, number> {
    const orders: Record<string, number> = {}
    for (const row of listPluginRows(db)) orders[row.package_name] = row.bundle_order
    return orders
  }

  async function installForUser(
    userId: number,
    changes: PluginChangesLike,
    opts: InstallOptions,
  ): Promise<InstallForUserOutcome> {
    return withUserLock(userId, () => installForUserUnlocked(userId, changes, opts), {
      timeoutMs: INSTALL_TIMEOUT_MS + 60_000,
    })
  }

  async function installForUserUnlocked(
    userId: number,
    changes: PluginChangesLike,
    opts: InstallOptions,
  ): Promise<InstallForUserOutcome> {
    const user = requireUser(userId)
    const outcome: InstallForUserOutcome = {
      installed: [],
      removed: [],
      restarted: false,
      deferredRestart: false,
    }
    if (changes.add.length === 0 && changes.remove.length === 0) return outcome

    const addItems = changes.add.map((version) => {
      const versionRow = getVersionRow(db, version.id)
      if (!versionRow) throw new HubError('NOT_FOUND', `插件版本不存在：${String(version.id)}`)
      const plugin = requirePluginRow(db, versionRow.plugin_id)
      return { plugin, versionRow }
    })
    const removeItems = changes.remove.map((card) => {
      const plugin = getPluginRow(db, card.id)
      return { plugin, packageName: card.packageName }
    })

    const profile = await ensureProfile(user, opts)
    const backupPath = profile.backup(deps.clock.now())
    profile.rotateBackups(PROFILE_BACKUP_KEEP)
    if (backupPath) log(opts, `已备份 profile package.json → ${basename(backupPath)}`)

    const needsRestart = [
      ...addItems.map((item) => item.plugin),
      ...removeItems.map((item) => item.plugin),
    ].some((plugin) => plugin && plugin.needs_restart === 1)

    try {
      for (const item of removeItems) {
        if (!item.plugin) continue
        await runPluginCommand(user, 'remove', item.packageName, opts)
      }
      for (const item of addItems) {
        await runPluginCommand(user, 'add', cliAddSpec(item.plugin, item.versionRow), opts)
      }

      // 官方命令会把新 bundle 追加在末尾、不维护 dshHub.managed；Hub 再改写顺序与登记（步骤 4）
      const after = profile.read()
      const transformed = applyPackageChanges({
        json: after,
        add: addItems.map((item) => ({
          packageName: item.plugin.package_name,
          spec: item.versionRow.spec,
          isBundle: item.plugin.is_bundle === 1,
          bundleOrder: item.plugin.bundle_order,
          version: item.versionRow.version,
        })),
        remove: removeItems.map((item) => item.packageName),
        bundleOrders: bundleOrders(),
        now: deps.clock.nowIso(),
      })
      if (transformed.changed) {
        profile.write(transformed.json)
        log(opts, '已按「出厂 → Hub 管理（bundle_order）→ 用户自装」重排 bundles 并更新 dshHub.managed')
      }
    } catch (error) {
      await restoreAndReinstall(user, profile, backupPath, opts)
      throw error instanceof HubError
        ? error
        : new HubError('UPSTREAM_ERROR', `插件安装失败：${errorText(error)}`)
    }

    await renderManaged(userId, opts)

    // 步骤 7：只有实例在跑、且插件需要重启、且要求 now 时才重启
    const services = (deps as Partial<AppDeps>).services
    const status = services?.instances ? services.instances.currentStatus(userId) : 'absent'
    if (opts.restart === 'now' && status === 'running' && needsRestart) {
      const ready = await restartAndWait(user, opts).catch((error: unknown) => ({
        ok: false as const,
        message: errorText(error),
      }))
      if (!ready.ok) {
        log(opts, `重启后就绪失败：${ready.message}，开始回滚`)
        await restoreAndReinstall(user, profile, backupPath, opts)
        try {
          await restartAndWait(user, opts)
        } catch (error) {
          log(opts, `回滚后的重启也失败：${errorText(error)}`)
        }
        throw new HubError('INSTANCE_START_FAILED', '插件安装后 DSH 未能就绪，已回滚', {
          reason: ready.message,
        })
      }
      outcome.restarted = true
    } else if (needsRestart && status === 'running' && opts.restart === 'next-start') {
      outcome.deferredRestart = true
      log(opts, '按 restart=next-start，插件将在下次启动 DSH 时生效')
    }

    const nowIso = deps.clock.nowIso()
    const source = opts.source ?? 'admin'
    for (const item of addItems) {
      upsertUserPluginRow(db, {
        userId,
        pluginId: item.plugin.id,
        desired: 'installed',
        desiredVersionId: item.versionRow.id,
        actualVersionId: item.versionRow.id,
        state: 'synced',
        source,
        error: null,
        at: nowIso,
      })
      outcome.installed.push({
        pluginId: item.plugin.id,
        packageName: item.plugin.package_name,
        versionId: item.versionRow.id,
      })
    }
    for (const item of removeItems) {
      if (!item.plugin) continue
      upsertUserPluginRow(db, {
        userId,
        pluginId: item.plugin.id,
        desired: 'absent',
        desiredVersionId: null,
        actualVersionId: null,
        state: 'synced',
        source,
        error: null,
        at: nowIso,
      })
      outcome.removed.push({ pluginId: item.plugin.id, packageName: item.packageName })
    }
    return outcome
  }

  /** 标记失败：state=failed 且写 error（06 §2.5：bootstrap 失败不阻塞启动） */
  function markFailure(
    userId: number,
    pluginId: number,
    message: string,
    source: 'admin' | 'user' | 'policy',
  ) {
    const existing = getUserPluginRow(db, userId, pluginId)
    upsertUserPluginRow(db, {
      userId,
      pluginId,
      desired: existing?.desired ?? 'installed',
      desiredVersionId: existing?.desired_version_id ?? null,
      actualVersionId: null,
      state: 'failed',
      source,
      error: message.slice(0, 500),
      at: deps.clock.nowIso(),
    })
  }

  async function bootstrapUser(
    userId: number,
    opts: InstallOptions,
  ): Promise<{ installed: string[]; failed: string[] }> {
    const policies: PluginPolicy[] = ['required', 'default']
    const rows = listPluginRows(db).filter((plugin) => policies.includes(plugin.policy))
    const targets: { plugin: PluginRow; version: { id: number; version: string } }[] = []
    const failed: string[] = []
    for (const plugin of rows) {
      const version = latestVersionRow(db, plugin.id)
      if (!version) {
        failed.push(plugin.package_name)
        markFailure(userId, plugin.id, '目录里没有可用版本', 'policy')
        log(opts, `跳过 ${plugin.package_name}：目录里没有可用版本`)
        continue
      }
      targets.push({ plugin, version })
    }
    if (targets.length === 0) {
      if (failed.length > 0) {
        throw new HubError('UPSTREAM_ERROR', `${String(failed.length)} 个插件没装上：${failed.join('、')}`, {
          failed,
        })
      }
      return { installed: [], failed: [] }
    }
    const installed: string[] = []
    try {
      // 一次装完（06 §2.5：一条 `dsh plugin add a b …` 命令 + 一次重启），而不是每个插件重启一次
      await installForUser(
        userId,
        { add: targets.map((item) => ({ id: item.version.id, version: item.version.version })), remove: [] },
        { ...opts, source: 'policy' },
      )
      for (const item of targets) installed.push(item.plugin.package_name)
    } catch (error) {
      // 一次装多个时前面的可能已经成功了：以 profile 里的实际结果为准记状态，别把装上的标成失败
      const landed = profileOf(requireUser(userId))
      const present = landed.exists() ? readDependencies(landed.read()) : {}
      const at = deps.clock.nowIso()
      for (const item of targets) {
        if (present[item.plugin.package_name] !== undefined) {
          installed.push(item.plugin.package_name)
          upsertUserPluginRow(db, {
            userId,
            pluginId: item.plugin.id,
            desired: 'installed',
            desiredVersionId: item.version.id,
            actualVersionId: item.version.id,
            state: 'synced',
            source: 'policy',
            error: null,
            at,
          })
          continue
        }
        failed.push(item.plugin.package_name)
        markFailure(userId, item.plugin.id, errorText(error), 'policy')
      }
      log(opts, `bootstrap 失败：${errorText(error)}`)
    }
    if (failed.length > 0) {
      throw new HubError('UPSTREAM_ERROR', `${String(failed.length)} 个插件没装上：${failed.join('、')}`, {
        failed,
      })
    }
    return { installed, failed }
  }

  async function reconcileUser(userId: number, opts: InstallOptions): Promise<{ changed: string[] }> {
    const user = requireUser(userId)
    const profile = profileOf(user)
    if (!profile.exists()) return { changed: [] }
    // 只看 DB 不够：用户可能在 DSH 自带插件管理器里把 required 插件删了（10 D5），
    // 所以同时对照 profile package.json 的 dependencies / bundles。
    const json = profile.read()
    const profileDeps = readDependencies(json)
    const bundles = readBundles(json)
    const plugins = listPluginRows(db)
    const changes: PluginChangesLike = { add: [], remove: [] }
    const changed: string[] = []

    for (const plugin of plugins) {
      const row = getUserPluginRow(db, userId, plugin.id)
      const inProfile =
        profileDeps[plugin.package_name] !== undefined &&
        (plugin.is_bundle !== 1 || bundles.includes(plugin.package_name))
      const installed = row?.actual_version_id != null && inProfile

      if (plugin.policy === 'required') {
        // required 必须装回（06 §2.2 / 10 D5）。版本以**期望版本**为准，没有期望才用目录最新版；
        // 目录里出现新版本不会在这里被静默升级（那是下发任务的事，要金丝雀）。
        const desiredVersion = row?.desired_version_id ? getVersionRow(db, row.desired_version_id) : undefined
        const fallback = latestVersionRow(db, plugin.id)
        const target = desiredVersion ?? fallback
        if (!target) continue
        const satisfied = row?.desired === 'installed' && row.actual_version_id === target.id && inProfile
        if (!satisfied) {
          changes.add.push({ id: target.id, version: target.version })
          changed.push(plugin.package_name)
          log(opts, `对账：补装 required 插件 ${plugin.package_name}@${target.version}`)
        }
        continue
      }

      // 非 required：只在「期望安装但实际缺失/版本落后」时标 pending，让状态页提示「有 N 项待应用」，
      // 装包交给下发任务或用户自己点（06 §1：start 的轻量对账不装包）
      if (row?.desired === 'installed' && !installed) {
        const desiredId = row.desired_version_id ?? latestVersionRow(db, plugin.id)?.id ?? null
        if (desiredId !== null && row.actual_version_id !== desiredId) {
          setUserPluginActual(
            db,
            userId,
            plugin.id,
            row.actual_version_id,
            'pending',
            null,
            deps.clock.nowIso(),
          )
          changed.push(plugin.package_name)
        }
      }
    }

    if (changes.add.length === 0) return { changed }
    await installForUser(userId, changes, { ...opts, source: 'policy' })
    return { changed }
  }

  function scheduleReconcile(userId: number): void {
    if (pendingReconciles.has(userId)) return
    const task = (async () => {
      try {
        await reconcileUser(userId, { restart: 'next-start' })
      } catch (error) {
        deps.logger.warn({ err: error, userId }, '实例就绪后的插件对账失败')
      } finally {
        pendingReconciles.delete(userId)
      }
    })()
    pendingReconciles.set(userId, task)
  }

  return {
    installForUser,
    bootstrapUser,
    reconcileUser,
    scheduleReconcile,
    async waitForReconcile(userId) {
      await pendingReconciles.get(userId)
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
