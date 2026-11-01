import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DEFAULT_QUOTA_VALUE,
  PLUGIN_UPLOAD_MAX_BYTES,
  type AddPluginPlatformRequest,
  type AddPluginVersionRequest,
  type AdminPluginRow,
  type CreatePluginRequest,
  type MyPluginItem,
  type MyPluginsResponse,
  type PluginCard,
  type PluginDesktopStats,
  type PluginLookupQuery,
  type PluginLookupResponse,
  type PluginPolicy,
  type PluginPlatform,
  type PluginPlatformSettings,
  type PluginUserMatrixItem,
  type PluginVersion,
  type UpdatePluginPlatformRequest,
  type UpdatePluginRequest,
  type UserPluginRow,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { listActiveDevicePluginFacts } from '../desktop/repo.js'
import { sha256Hex } from '../../lib/crypto.js'
import { validateConfigYaml } from '../models/patch-entries.js'
import { createPluginInstaller } from './installer.js'
import {
  countPluginUsers,
  countVersionUsers,
  deletePluginPlatformRow,
  deletePluginRow,
  deleteVersionRow,
  getPluginPlatformRow,
  getPluginRowByPackage,
  getPlatformLibraryRow,
  getUserPluginRow,
  getUserRefRow,
  getVersionRow,
  getVersionRowByVersion,
  insertPluginPlatformRow,
  insertPluginRow,
  insertVersionRow,
  latestVersionRow,
  listPlatformLibraryRows,
  listPluginPlatformRows,
  listPluginRows,
  listPluginStats,
  listPluginUserMatrix,
  listUserPluginRows,
  listVersionRows,
  requirePluginRow,
  syncCloudMirror,
  toAdminPluginRow,
  toPluginPlatformSettings,
  toPluginRowOfLibrary,
  toPluginVersion,
  toUserPluginRow,
  updatePluginPlatformRow,
  updatePluginRow,
  type PluginPlatformRow,
  type PluginRow,
  type PluginVersionRow,
} from './repo.js'
import { scanFileNames, scanText, type SecretHit } from './secret-scan.js'
import {
  downloadTarball,
  fetchNpmPackage,
  inspectTarball,
  interpretDshField,
  packLocalDirectory,
  readLocalPackage,
  safeStoreFileName,
  type PackageJsonLike,
  type ValidatedTarball,
} from './sources.js'
import type { InstallForUserOptions, PluginChanges, PluginService, UploadedPluginFile } from './types.js'

/** 插件包上传上限（04 §10.7：shared 常量 50MB，这一层再兜一次） */
export const PLUGIN_SOURCE_MAX_BYTES = PLUGIN_UPLOAD_MAX_BYTES

/** 容器内的 plugin-store 路径（05 §4 固定挂载） */
export const CONTAINER_PLUGIN_STORE = '/opt/hub/plugin-store'

/** npm 包名（含 scope）：足够宽的校验，真正的合法性由 npm 源决定 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

export function createPluginService(deps: BaseDeps): PluginService {
  const db = deps.db
  const installer = createPluginInstaller(deps)

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  function audit(entry: {
    actorId?: number | null
    meta?: RequestMeta
    action: string
    targetId: number | string
    detail?: Record<string, unknown>
  }): void {
    deps.audit.log({
      actorId: entry.actorId ?? null,
      actorIp: entry.meta?.ip ?? null,
      action: entry.action,
      targetType: 'plugin',
      targetId: entry.targetId,
      detail: entry.detail ?? null,
    })
  }

  /** 头像 URL 与用户详情一致（04 §0.1：`/api/avatars/<file>`；文件名含哈希） */
  function avatarUrlOf(user: { avatar_file: string | null }): string | null {
    return user.avatar_file ? `/api/avatars/${user.avatar_file}` : null
  }

  function requireUser(userId: number) {
    const user = getUserRefRow(db, userId)
    if (!user || user.deleted_at) throw new HubError('NOT_FOUND', '用户不存在')
    return user
  }

  /** 两个平台的设置一起带上（前端「加入桌面库 / 移出桌面库」要知道现有状态） */
  function platformSettingsOf(pluginId: number): Partial<Record<PluginPlatform, PluginPlatformSettings>> {
    const settings: Partial<Record<PluginPlatform, PluginPlatformSettings>> = {}
    for (const row of listPluginPlatformRows(db, pluginId)) settings[row.platform] = toPluginPlatformSettings(row)
    return settings
  }

  /**
   * 目录行（某个平台的视图）：policy / 排序 / 配置片段 / 版本都按该平台取。
   * 老调用（不传 platform）看得就是云上，行为与 WP32a 之前一致。
   */
  function catalogRow(plugin: PluginRow, platform: PluginPlatform = 'cloud'): AdminPluginRow {
    const settings = listPluginPlatformRows(db, plugin.id).find((row) => row.platform === platform)
    const effective: PluginRow = settings
      ? {
          ...plugin,
          policy: settings.policy,
          bundle_order: settings.bundle_order,
          config_yaml: settings.config_yaml,
          needs_restart: settings.needs_restart,
        }
      : plugin
    return toAdminPluginRow(effective, listVersionRows(db, plugin.id, platform), listPluginStats(db, plugin.id), {
      platform,
      platforms: platformSettingsOf(plugin.id),
      ...(platform === 'desktop' ? { desktopStats: desktopStatsOf([plugin.id]).get(plugin.id) } : {}),
    })
  }

  function looksLikeVersion(value: string | null | undefined): value is string {
    return typeof value === 'string' && /^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/u.test(value.trim())
  }

  /**
   * 桌面侧统计（docs/22 §2.2）：有效设备里上报了该包（`state <> 'absent'`）的设备数 / 用户数 /
   * 版本较旧的设备数 / 内置设备数。与 install-stats 的 desktop 同一口径，只是「较旧」按**桌面最新版本**算
   * （桌面库看的是桌面版本）；一次查完再按插件分组，不按插件循环查库。
   */
  function desktopStatsOf(pluginIds: number[]): Map<number, PluginDesktopStats> {
    const stats = new Map<number, PluginDesktopStats>()
    if (pluginIds.length === 0) return stats
    const latest = new Map<number, string | null>()
    for (const pluginId of pluginIds) latest.set(pluginId, latestVersionRow(db, pluginId, 'desktop')?.version ?? null)
    const devices = new Map<number, Set<string>>()
    const users = new Map<number, Set<number>>()
    const outdated = new Map<number, Set<string>>()
    const bundled = new Map<number, Set<string>>()
    const add = <T>(target: Map<number, Set<T>>, pluginId: number, value: T): void => {
      const set = target.get(pluginId)
      if (set) set.add(value)
      else target.set(pluginId, new Set([value]))
    }
    for (const fact of listActiveDevicePluginFacts(db)) {
      if (!latest.has(fact.plugin_id)) continue
      const target = latest.get(fact.plugin_id) ?? null
      add(devices, fact.plugin_id, fact.device_id)
      add(users, fact.plugin_id, fact.user_id)
      if (fact.source === 'bundled') add(bundled, fact.plugin_id, fact.device_id)
      // 版本号缺失/解析不出来算较旧（无法确认是最新），与 install-stats 一致
      const older =
        target !== null &&
        (!looksLikeVersion(fact.version) || (looksLikeVersion(target) && compareVersions(fact.version, target) < 0))
      if (older) add(outdated, fact.plugin_id, fact.device_id)
    }
    for (const pluginId of pluginIds) {
      stats.set(pluginId, {
        devices: devices.get(pluginId)?.size ?? 0,
        users: users.get(pluginId)?.size ?? 0,
        outdated: outdated.get(pluginId)?.size ?? 0,
        bundledDevices: bundled.get(pluginId)?.size ?? 0,
      })
    }
    return stats
  }

  /** 某平台库里的插件（桌面库没有该平台设置行的插件根本不出现） */
  function libraryRows(platform: PluginPlatform): AdminPluginRow[] {
    const rows = listPlatformLibraryRows(db, platform)
    const desktopStats =
      platform === 'desktop' ? desktopStatsOf(rows.map((row) => row.plugin_id)) : new Map()
    return rows.map((row) =>
      toAdminPluginRow(
        toPluginRowOfLibrary(row),
        listVersionRows(db, row.plugin_id, platform),
        listPluginStats(db, row.plugin_id),
        {
          platform,
          platforms: platformSettingsOf(row.plugin_id),
          ...(platform === 'desktop' ? { desktopStats: desktopStats.get(row.plugin_id) } : {}),
        },
      ),
    )
  }

  /** 把插件加进某个平台的库；已存在则报冲突（由调用方决定是 POST 还是 PATCH） */
  function ensurePlatformRow(
    plugin: PluginRow,
    platform: PluginPlatform,
    override: {
      policy?: PluginPolicy
      bundleOrder?: number
      configYaml?: string
      needsRestart?: boolean
    } = {},
    at = deps.clock.nowIso(),
  ): PluginPlatformRow {
    const existing = getPluginPlatformRow(db, plugin.id, platform)
    if (existing) return existing
    const cloud = platform === 'cloud' ? undefined : getPluginPlatformRow(db, plugin.id, 'cloud')
    const policy = override.policy ?? cloud?.policy ?? plugin.policy
    insertPluginPlatformRow(db, {
      pluginId: plugin.id,
      platform,
      policy,
      bundleOrder: override.bundleOrder ?? cloud?.bundle_order ?? plugin.bundle_order,
      configYaml: override.configYaml ?? cloud?.config_yaml ?? plugin.config_yaml,
      needsRestart: override.needsRestart ?? (cloud ? cloud.needs_restart === 1 : plugin.needs_restart === 1),
      at,
    })
    if (platform === 'cloud') syncCloudMirror(db, plugin.id, at)
    const row = getPluginPlatformRow(db, plugin.id, platform)
    if (!row) throw new HubError('INTERNAL', '插件平台设置写入失败')
    return row
  }

  function requirePlatformRow(pluginId: number, platform: PluginPlatform): PluginPlatformRow {
    const row = getPluginPlatformRow(db, pluginId, platform)
    if (!row) {
      throw new HubError('NOT_FOUND', `该插件不在${platform === 'desktop' ? '桌面' : '云上'}插件库里`)
    }
    return row
  }

  function insertVersion(input: {
    pluginId: number
    version: string
    sourceType: PluginVersionRow['source_type']
    sourceRef: string
    spec: string
    storeFile: string | null
    sha256: string | null
    minDsh?: string | null
    platform?: PluginPlatform
  }): PluginVersionRow {
    const platform = input.platform ?? 'cloud'
    if (getVersionRowByVersion(db, input.pluginId, input.version, platform)) {
      throw new HubError('CONFLICT', `该插件在${platform === 'desktop' ? '桌面' : '云上'}已有版本 ${input.version}`)
    }
    const id = insertVersionRow(db, {
      pluginId: input.pluginId,
      version: input.version,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      spec: input.spec,
      storeFile: input.storeFile,
      sha256: input.sha256,
      minDsh: input.minDsh ?? null,
      at: deps.clock.nowIso(),
      platform,
    })
    const row = getVersionRow(db, id)
    if (!row) throw new HubError('INTERNAL', '插件版本写入失败')
    return row
  }

  /** 包声明的 `dsh.bundle.patch` 必须存在，否则每个用户都会装不上（spike 实测 dsh 会拒绝并回滚） */
  function assertBundlePatchPresent(validated: ValidatedTarball, sourceLabel: string): void {
    if (!validated.bundlePatchMissing) return
    throw new HubError(
      'VALIDATION_FAILED',
      `插件包（${sourceLabel}）声明的 dsh.bundle.patch 文件不在包里，DSH 会拒绝安装`,
      { packageName: validated.packageJson.name },
    )
  }

  /** 密钥扫描（06 §2.1）：命中就拒绝入库，只回 {file,line,rule}，**不回显命中的值** */
  function assertNoSecrets(validated: ValidatedTarball, sourceLabel: string): void {
    const hits: SecretHit[] = scanFileNames(validated.files.map((file) => file.path))
    for (const file of validated.files) {
      if (hits.length > 50) break
      hits.push(...scanText(file.path, file.content))
    }
    if (hits.length > 0) {
      throw new HubError(
        'VALIDATION_FAILED',
        `插件包内发现疑似密钥（${sourceLabel}），已拒绝入库；需要密钥的插件请改用「插件配置 + 模型/密钥下发」`,
        { hits: hits.slice(0, 50) },
      )
    }
  }

  function storeTarball(
    buffer: Buffer,
    packageName: string,
    version: string,
  ): { storeFile: string; spec: string } {
    mkdirSync(deps.paths.pluginStoreDir, { recursive: true })
    const fileName = safeStoreFileName(packageName, version)
    writeFileSync(join(deps.paths.pluginStoreDir, fileName), buffer)
    return { storeFile: fileName, spec: `file:${CONTAINER_PLUGIN_STORE}/${fileName}` }
  }

  function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-wp3-plugin-'))
    return Promise.resolve(fn(dir)).finally(() => {
      rmSync(dir, { recursive: true, force: true })
    })
  }

  /** 校验失败信息里用的来源标签（包名@版本） */
  function sourceLabelOf(validated: ValidatedTarball): string {
    return `${validated.packageJson.name}@${validated.packageJson.version}`
  }

  function assertPackageNameMatch(expected: string, actual: string, what: string): void {
    if (expected !== actual) {
      throw new HubError('VALIDATION_FAILED', `${what} 的包名是 ${actual}，与目录里的 ${expected} 不一致`)
    }
  }

  // ── 目录 CRUD ─────────────────────────────────────────────────────────────

  async function listCatalog(platform: PluginPlatform = 'cloud'): Promise<AdminPluginRow[]> {
    return libraryRows(platform)
  }

  /** 插件详情的行（缺省云上视图）；插件不在该平台库里时回落到「这个插件是什么」的行 */
  async function getCatalogRow(pluginId: number, platform: PluginPlatform = 'cloud'): Promise<AdminPluginRow> {
    const library = getPlatformLibraryRow(db, pluginId, platform)
    if (library) return catalogRow(toPluginRowOfLibrary(library), platform)
    return catalogRow(requirePluginRow(db, pluginId), platform)
  }

  async function createPlugin(
    input: CreatePluginRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<AdminPluginRow> {
    if (!PACKAGE_NAME_RE.test(input.packageName)) {
      throw new HubError('VALIDATION_FAILED', '包名不合法', {
        fields: { packageName: '不是合法的 npm 包名' },
      })
    }
    if (getPluginRowByPackage(db, input.packageName)) {
      throw new HubError('CONFLICT', `插件 ${input.packageName} 已在目录里`)
    }
    const platform = input.platform ?? 'cloud'
    const configYaml = input.configYaml ?? ''
    validateConfigYaml(configYaml)
    const id = db.tx(() => {
      const pluginId = insertPluginRow(db, {
        packageName: input.packageName,
        displayName: input.displayName,
        description: input.description ?? '',
        icon: input.icon ?? null,
        homepage: null,
        policy: input.policy,
        isBundle: input.isBundle,
        bundleOrder: input.bundleOrder ?? 100,
        configYaml,
        needsRestart: input.needsRestart ?? true,
        at: deps.clock.nowIso(),
      })
      insertPluginPlatformRow(db, {
        pluginId,
        platform,
        policy: input.policy,
        bundleOrder: input.bundleOrder ?? 100,
        configYaml,
        needsRestart: input.needsRestart ?? true,
        at: deps.clock.nowIso(),
      })
      // plugins 的旧列是云上镜像：新建云上插件时同步；只建桌面库的插件让旧列保持默认值（旧代码不读它）
      if (platform === 'cloud') syncCloudMirror(db, pluginId, deps.clock.nowIso())
      return pluginId
    })
    audit({
      actorId,
      meta,
      action: 'plugin.create',
      targetId: id,
      detail: { packageName: input.packageName, platform },
    })
    return getCatalogRow(id, platform)
  }

  async function updatePlugin(
    pluginId: number,
    input: UpdatePluginRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<AdminPluginRow> {
    const plugin = requirePluginRow(db, pluginId)
    if (input.configYaml !== undefined) validateConfigYaml(input.configYaml)
    const platform = input.platform ?? 'cloud'
    // 身份字段（显示名/描述/图标）两平台共用；策略/排序/配置片段/重启走平台行
    const identity = {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
      // isBundle 是「进不进 dsh.profile.bundles」，与平台无关（桌面端不看它）
      ...(input.isBundle === undefined ? {} : { isBundle: input.isBundle }),
    }
    const settings = {
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      ...(input.bundleOrder === undefined ? {} : { bundleOrder: input.bundleOrder }),
      ...(input.configYaml === undefined ? {} : { configYaml: input.configYaml }),
      ...(input.needsRestart === undefined ? {} : { needsRestart: input.needsRestart }),
    }
    const platformRow = getPluginPlatformRow(db, pluginId, platform)
    // 老接口（不带 platform）应该只改「已经在云上库里的插件」的设置；不在库里就按旧行为直写镜像列
    if (!platformRow && Object.keys(settings).length > 0 && platform === 'cloud') {
      updatePluginRow(db, pluginId, settings, deps.clock.nowIso())
    } else if (platformRow && Object.keys(settings).length > 0) {
      db.tx(() => {
        updatePluginPlatformRow(db, pluginId, platform, settings, deps.clock.nowIso())
        if (platform === 'cloud') syncCloudMirror(db, pluginId, deps.clock.nowIso())
      })
    }
    if (Object.keys(identity).length > 0) updatePluginRow(db, pluginId, identity, deps.clock.nowIso())
    audit({
      actorId,
      meta,
      action: 'plugin.update',
      targetId: pluginId,
      detail: { fields: Object.keys(input), platform, packageName: plugin.package_name },
    })
    return getCatalogRow(pluginId, platform)
  }

  async function deletePlugin(pluginId: number, actorId: number | null, meta: RequestMeta): Promise<void> {
    const plugin = requirePluginRow(db, pluginId)
    const users = countPluginUsers(db, pluginId)
    if (users > 0) {
      throw new HubError('CONFLICT', `还有 ${String(users)} 个用户在期望/实际使用该插件，请先下发卸载`)
    }
    const targets = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM desktop_plugin_targets WHERE plugin_id = ?',
      pluginId,
    )
    if (Number(targets?.n ?? 0) > 0) {
      throw new HubError('CONFLICT', '这个插件还有桌面下发目标，请先在桌面侧撤回')
    }
    deletePluginRow(db, pluginId)
    audit({
      actorId,
      meta,
      action: 'plugin.delete',
      targetId: pluginId,
      detail: { packageName: plugin.package_name },
    })
  }

  // ── 平台库（docs/22 §2.2） ────────────────────────────────────────────────

  async function addPlatform(
    pluginId: number,
    input: AddPluginPlatformRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<AdminPluginRow> {
    const plugin = requirePluginRow(db, pluginId)
    if (getPluginPlatformRow(db, pluginId, input.platform)) {
      throw new HubError('CONFLICT', `插件 ${plugin.package_name} 已在${input.platform === 'desktop' ? '桌面' : '云上'}插件库里`)
    }
    if (input.configYaml !== undefined) validateConfigYaml(input.configYaml)
    ensurePlatformRow(plugin, input.platform, {
      ...(input.policy === undefined ? {} : { policy: input.policy }),
      ...(input.bundleOrder === undefined ? {} : { bundleOrder: input.bundleOrder }),
      ...(input.configYaml === undefined ? {} : { configYaml: input.configYaml }),
      ...(input.needsRestart === undefined ? {} : { needsRestart: input.needsRestart }),
    })
    audit({
      actorId,
      meta,
      action: 'plugin.platform.add',
      targetId: pluginId,
      detail: { platform: input.platform, packageName: plugin.package_name },
    })
    return getCatalogRow(pluginId, input.platform)
  }

  async function updatePlatform(
    pluginId: number,
    platform: PluginPlatform,
    input: UpdatePluginPlatformRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<AdminPluginRow> {
    const plugin = requirePluginRow(db, pluginId)
    requirePlatformRow(pluginId, platform)
    if (input.configYaml !== undefined) validateConfigYaml(input.configYaml)
    db.tx(() => {
      updatePluginPlatformRow(
        db,
        pluginId,
        platform,
        {
          ...(input.policy === undefined ? {} : { policy: input.policy }),
          ...(input.bundleOrder === undefined ? {} : { bundleOrder: input.bundleOrder }),
          ...(input.configYaml === undefined ? {} : { configYaml: input.configYaml }),
          ...(input.needsRestart === undefined ? {} : { needsRestart: input.needsRestart }),
        },
        deps.clock.nowIso(),
      )
      if (platform === 'cloud') syncCloudMirror(db, pluginId, deps.clock.nowIso())
    })
    audit({
      actorId,
      meta,
      action: 'plugin.platform.update',
      targetId: pluginId,
      detail: { platform, fields: Object.keys(input), packageName: plugin.package_name },
    })
    return getCatalogRow(pluginId, platform)
  }

  /**
   * 从某个平台的库里移出插件（docs/22 §2.2）：
   * - 有该平台的下发目标或已装记录 → 拒绝；
   * - `force=true` 时**同时撤销桌面目标**（桌面侧），然后移出；二次密码由路由的 requireReauth 保证。
   * 云上库被移出时同样要清掉 `user_plugins` 的期望（有记录就拒绝，`force` 只对桌面目标动手）。
   */
  async function removePlatform(
    pluginId: number,
    platform: PluginPlatform,
    opts: { force: boolean },
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<void> {
    const plugin = requirePluginRow(db, pluginId)
    requirePlatformRow(pluginId, platform)
    const desktopTargets = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM desktop_plugin_targets WHERE plugin_id = ?',
      pluginId,
    )
    const targetCount = Number(desktopTargets?.n ?? 0)
    if (platform === 'cloud') {
      const users = countPluginUsers(db, pluginId)
      if (users > 0) {
        throw new HubError('CONFLICT', `还有 ${String(users)} 个用户在期望/实际使用该插件，请先下发卸载`)
      }
    } else {
      const installed = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM desktop_device_plugins ddp
           JOIN desktop_devices d ON d.device_id = ddp.device_id AND d.status = 'active'
          WHERE ddp.package_name = ? AND ddp.state <> 'absent'`,
        plugin.package_name,
      )
      const installedCount = Number(installed?.n ?? 0)
      if (installedCount > 0 && !opts.force) {
        throw new HubError(
          'CONFLICT',
          `还有 ${String(installedCount)} 台设备装着这个插件；确认要移出桌面插件库请勾选强制（会同时撤销桌面下发目标）`,
        )
      }
      if (targetCount > 0 && !opts.force) {
        throw new HubError('CONFLICT', '这个插件还有桌面下发目标，确认要移出桌面插件库请勾选强制（会同时撤销它们）')
      }
    }
    db.tx(() => {
      if (platform === 'desktop' && opts.force) {
        db.run('DELETE FROM desktop_plugin_targets WHERE plugin_id = ?', pluginId)
      }
      deletePluginPlatformRow(db, pluginId, platform)
    })
    audit({
      actorId,
      meta,
      action: 'plugin.platform.remove',
      targetId: pluginId,
      detail: { platform, force: opts.force, revokedTargets: platform === 'desktop' && opts.force ? targetCount : 0 },
    })
  }

  // ── lookup ────────────────────────────────────────────────────────────────

  async function lookup(query: PluginLookupQuery): Promise<PluginLookupResponse> {
    if (query.source === 'npm') {
      const info = await fetchNpmPackage(deps.config.npmRegistry, query.name ?? '')
      return {
        packageName: info.name,
        displayName: info.name,
        description: info.description,
        homepage: info.homepage,
        versions: sortVersionsDesc(info.versions),
        latest: info.latest,
        isBundle: info.isBundle,
        needsRestart: info.needsRestart,
      }
    }
    if (query.source === 'local') {
      return lookupFromManifest(readLocalPackage(query.path ?? ''))
    }
    if (query.source === 'tarball') {
      const url = query.name ?? ''
      return withTempDir(async (dir) => {
        await downloadTarball(url, join(dir, 'plugin.tgz'))
        return lookupFromManifest(inspectTarball(readFileSync(join(dir, 'plugin.tgz'))).packageJson)
      })
    }
    throw new HubError('VALIDATION_FAILED', '上传来源请用 POST /api/admin/plugins/lookup 提交 .tgz 文件')
  }

  /** 上传的 .tgz：和 `addUploadedVersion` 同一套大小/结构校验，但只读 package.json、不扫密钥不入库 */
  async function lookupUpload(file: UploadedPluginFile): Promise<PluginLookupResponse> {
    if (file.data.byteLength > PLUGIN_SOURCE_MAX_BYTES) {
      throw new HubError(
        'PAYLOAD_TOO_LARGE',
        `插件包不能超过 ${String(PLUGIN_SOURCE_MAX_BYTES / 1024 / 1024)}MB`,
      )
    }
    return lookupFromManifest(inspectTarball(file.data).packageJson)
  }

  function lookupFromManifest(manifest: PackageJsonLike): PluginLookupResponse {
    const interpreted = interpretDshField(manifest.dsh)
    return {
      packageName: manifest.name,
      displayName: manifest.name,
      description: manifest.description,
      homepage: manifest.homepage,
      versions: [manifest.version],
      latest: manifest.version,
      isBundle: interpreted.isBundle,
      needsRestart: interpreted.needsRestart,
    }
  }

  // ── 版本 ──────────────────────────────────────────────────────────────────

  async function addVersion(
    pluginId: number,
    input: AddPluginVersionRequest,
    meta: RequestMeta,
    actorId: number | null = null,
  ): Promise<PluginVersion> {
    const plugin = requirePluginRow(db, pluginId)
    const platform = input.platform ?? 'cloud'
    // 桌面版本只从「整包上传」来（design §2.2）：npm/tarball/local 只收云上，否则桌面端拿不到整包
    if (platform === 'desktop') {
      throw new HubError(
        'VALIDATION_FAILED',
        '桌面版本请用整包上传（POST /api/admin/plugins/:id/versions 的 multipart 或 POST /api/admin/desktop/artifacts）',
        { fields: { platform: '桌面版本必须有整包' } },
      )
    }
    requirePlatformRow(pluginId, 'cloud')

    if (input.sourceType === 'npm') {
      const info = await fetchNpmPackage(deps.config.npmRegistry, plugin.package_name, {
        version: input.version,
      })
      if (!info.versions.includes(input.version)) {
        throw new HubError('VALIDATION_FAILED', `npm 上没有 ${plugin.package_name}@${input.version} 这个版本`)
      }
      // 密钥扫描需要包内容：把 tarball 拉下来扫一遍（不入库，spec 用精确版本号）
      let sha256: string | null = null
      const tarballUrl = info.distTarball
      if (tarballUrl) {
        await withTempDir(async (dir) => {
          const file = join(dir, 'plugin.tgz')
          await downloadTarball(tarballUrl, file)
          const validated = inspectTarball(readFileSync(file))
          assertPackageNameMatch(plugin.package_name, validated.packageJson.name, 'npm 包')
          assertNoSecrets(validated, `${plugin.package_name}@${input.version}`)
          assertBundlePatchPresent(validated, sourceLabelOf(validated))
          sha256 = validated.sha256
        })
      }
      // 顺手补全目录里的描述/主页（已经拉过元数据，不再额外请求）
      const enrichment: { description?: string; homepage?: string } = {}
      if (plugin.description.length === 0 && info.description.length > 0)
        enrichment.description = info.description
      if (!plugin.homepage && info.homepage) enrichment.homepage = info.homepage
      if (Object.keys(enrichment).length > 0) {
        updatePluginRow(db, pluginId, enrichment, deps.clock.nowIso())
      }
      const row = insertVersion({
        pluginId,
        platform: 'cloud',
        version: input.version,
        sourceType: 'npm',
        sourceRef: `${plugin.package_name}@${input.version}`,
        spec: input.version,
        storeFile: null,
        sha256,
      })
      audit({
        actorId,
        meta,
        action: 'plugin.version.add',
        targetId: pluginId,
        detail: { version: input.version, sourceType: 'npm' },
      })
      return toPluginVersion(row)
    }

    if (input.sourceType === 'tarball') {
      const row = await withTempDir(async (dir) => {
        const file = join(dir, 'plugin.tgz')
        const downloaded = await downloadTarball(input.url, file)
        const validated = inspectTarball(readFileSync(file))
        assertPackageNameMatch(plugin.package_name, validated.packageJson.name, 'tarball')
        if (validated.packageJson.version !== input.version) {
          throw new HubError(
            'VALIDATION_FAILED',
            `tarball 里的版本是 ${validated.packageJson.version}，与填写的 ${input.version} 不一致`,
          )
        }
        assertNoSecrets(validated, input.url)
        assertBundlePatchPresent(validated, sourceLabelOf(validated))
        return insertVersion({
          pluginId,
          platform: 'cloud',
          version: input.version,
          sourceType: 'tarball',
          sourceRef: input.url,
          spec: input.url,
          storeFile: null,
          sha256: downloaded.sha256,
        })
      })
      audit({
        actorId,
        meta,
        action: 'plugin.version.add',
        targetId: pluginId,
        detail: { version: input.version, sourceType: 'tarball' },
      })
      return toPluginVersion(row)
    }

    // local：复制到临时目录后 pnpm pack（**不改原目录**）
    const row = await withTempDir(async (dir) => {
      const packed = await packLocalDirectory(input.path, join(dir, 'pack'), {
        registry: deps.config.npmRegistry,
      })
      const buffer = readFileSync(packed.tgzFile)
      const validated = inspectTarball(buffer)
      assertPackageNameMatch(plugin.package_name, validated.packageJson.name, '本地插件')
      assertNoSecrets(validated, input.path)
      assertBundlePatchPresent(validated, sourceLabelOf(validated))
      const stored = storeTarball(buffer, validated.packageJson.name, validated.packageJson.version)
      return insertVersion({
        pluginId,
        platform: 'cloud',
        version: validated.packageJson.version,
        sourceType: 'local',
        sourceRef: input.path,
        spec: stored.spec,
        storeFile: stored.storeFile,
        sha256: validated.sha256,
      })
    })
    audit({
      actorId,
      meta,
      action: 'plugin.version.add',
      targetId: pluginId,
      detail: { version: row.version, sourceType: 'local' },
    })
    return toPluginVersion(row)
  }

  async function addUploadedVersion(
    pluginId: number,
    file: UploadedPluginFile,
    meta: RequestMeta,
    actorId: number | null = null,
    platform: PluginPlatform = 'cloud',
  ): Promise<PluginVersion> {
    const plugin = requirePluginRow(db, pluginId)
    if (file.data.byteLength > PLUGIN_SOURCE_MAX_BYTES) {
      throw new HubError(
        'PAYLOAD_TOO_LARGE',
        `插件包不能超过 ${String(PLUGIN_SOURCE_MAX_BYTES / 1024 / 1024)}MB`,
      )
    }
    const validated = inspectTarball(file.data)
    assertPackageNameMatch(plugin.package_name, validated.packageJson.name, '上传的插件包')
    assertNoSecrets(validated, file.filename)
    assertBundlePatchPresent(validated, sourceLabelOf(validated))
    const stored = storeTarball(file.data, validated.packageJson.name, validated.packageJson.version)
    // 桌面版本：上传整包 = 创建桌面版本（docs/22 §2.2）。插件还不在桌面库时顺手加进去（策略照抄云上）
    const row = db.tx(() => {
      if (platform === 'desktop' && !getPluginPlatformRow(db, pluginId, 'desktop')) {
        ensurePlatformRow(plugin, 'desktop')
      }
      return insertVersion({
        pluginId,
        platform,
        version: validated.packageJson.version,
        sourceType: 'upload',
        sourceRef: basename(file.filename),
        spec: stored.spec,
        storeFile: stored.storeFile,
        sha256: validated.sha256,
      })
    })
    // 桌面版本「必须有整包」：上传的 tgz 同时也登记成桌面整包（改名进 desktop-plugin-store），
    // 这样传完就能下发（docs/22 §2.2「桌面整包上传 = 创建桌面版本」）。
    if (platform === 'desktop') {
      const delivery = services().desktopDelivery
      if (!delivery) throw new HubError('INTERNAL', 'desktop-delivery service 未装配')
      const tempFile = join(tmpdir(), `dshhub-wp32a-artifact-${randomUUID()}.tgz`)
      writeFileSync(tempFile, file.data)
      await delivery.uploadPluginArtifact({
        pluginId,
        versionId: row.id,
        tempFile,
        bytes: file.data.byteLength,
        sha256: row.sha256 ?? sha256Hex(file.data),
        actorId,
        meta,
      })
    }
    audit({
      actorId,
      meta,
      action: 'plugin.version.add',
      targetId: pluginId,
      detail: { version: row.version, sourceType: 'upload', platform },
    })
    return toPluginVersion(row)
  }

  async function removeVersion(
    pluginId: number,
    versionId: number,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<void> {
    requirePluginRow(db, pluginId)
    const version = getVersionRow(db, versionId)
    if (!version || version.plugin_id !== pluginId) {
      throw new HubError('NOT_FOUND', '插件版本不存在')
    }
    const users = countVersionUsers(db, versionId)
    if (users > 0) {
      throw new HubError('CONFLICT', `还有 ${String(users)} 个用户在用这个版本，不能删除`)
    }
    if (version.platform === 'desktop') {
      const targets = db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM desktop_plugin_targets WHERE version_id = ?',
        versionId,
      )
      if (Number(targets?.n ?? 0) > 0) {
        throw new HubError('CONFLICT', '还有桌面下发目标在用这个版本，请先撤回')
      }
    }
    // 桌面版本带整包：删行前先删文件（artifacts 行由外键级联删掉）
    if (version.platform === 'desktop') {
      const artifact = db.get<{ file_name: string }>(
        'SELECT file_name FROM desktop_plugin_artifacts WHERE version_id = ?',
        versionId,
      )
      if (artifact) rmSync(join(deps.paths.desktopPluginStoreDir, artifact.file_name), { force: true })
    }
    deleteVersionRow(db, versionId)
    if (version.store_file) {
      // 同一个 store 文件可能被多个版本共用（例如 upload 与 local 指向同一份）
      const stillUsed = db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM plugin_versions WHERE store_file = ?',
        version.store_file,
      )
      if (Number(stillUsed?.n ?? 0) === 0) {
        rmSync(join(deps.paths.pluginStoreDir, version.store_file), { force: true })
      }
    }
    audit({
      actorId,
      meta,
      action: 'plugin.version.delete',
      targetId: pluginId,
      detail: { version: version.version, platform: version.platform },
    })
  }

  // ── 用户侧 ────────────────────────────────────────────────────────────────

  async function listUsersOfPlugin(pluginId: number): Promise<PluginUserMatrixItem[]> {
    requirePluginRow(db, pluginId)
    return listPluginUserMatrix(db, pluginId).map(({ user, row }) => ({
      user: {
        id: user.id,
        slug: user.slug,
        username: user.username,
        displayName: user.display_name.length > 0 ? user.display_name : user.username,
        avatarUrl: avatarUrlOf(user),
        status: user.status,
      },
      row: row ? toUserPluginRow(row, user.username, row.actual_version) : null,
    }))
  }

  async function listUserPluginRowsFor(userId: number): Promise<UserPluginRow[]> {
    const user = requireUser(userId)
    return listUserPluginRows(db, userId).map((row) =>
      toUserPluginRow(row, user.username, row.actual_version),
    )
  }

  async function listForUser(userId: number): Promise<MyPluginsResponse> {
    requireUser(userId)
    const instances = services().instances
    const quota = instances ? instances.resolveQuota(userId) : DEFAULT_QUOTA_VALUE
    const items: MyPluginItem[] = []
    // 用户自助列表只看**云上库**（桌面端的插件由客户端与清单管，不在这里自助装卸）；
    // 没有云上平台行的插件（迁移前手写进库的数据）按镜像列算云上
    for (const base of listPluginRows(db)) {
      const settings = getPluginPlatformRow(db, base.id, 'cloud')
      const plugin: PluginRow = settings
        ? {
            ...base,
            policy: settings.policy,
            bundle_order: settings.bundle_order,
            config_yaml: settings.config_yaml,
            needs_restart: settings.needs_restart,
          }
        : base
      if (plugin.policy === 'hidden') continue
      const row = getUserPluginRow(db, userId, plugin.id)
      const latest = latestVersionRow(db, plugin.id, 'cloud')
      const actual = row?.actual_version_id ? getVersionRow(db, row.actual_version_id) : undefined
      items.push({
        plugin: {
          id: plugin.id,
          packageName: plugin.package_name,
          displayName: plugin.display_name,
          description: plugin.description,
          icon: plugin.icon,
          homepage: plugin.homepage,
          policy: plugin.policy,
          isBundle: plugin.is_bundle === 1,
          bundleOrder: plugin.bundle_order,
          needsRestart: plugin.needs_restart === 1,
          latestVersion: latest?.version ?? null,
        },
        installed: row?.actual_version_id != null,
        version: actual?.version ?? null,
        state: row?.state ?? 'synced',
        canToggle: plugin.policy === 'optional' && quota.allowUserPlugins,
      })
    }
    return { items }
  }

  async function installForUser(
    userId: number,
    changes: PluginChanges,
    opts: InstallForUserOptions,
  ): Promise<void> {
    await installer.installForUser(
      userId,
      {
        add: changes.add.map((version) => ({ id: version.id, version: version.version })),
        remove: changes.remove.map((card: PluginCard) => ({ id: card.id, packageName: card.packageName })),
      },
      opts,
    )
  }

  async function bootstrapUser(userId: number, opts: InstallForUserOptions): Promise<void> {
    // 06 §2.5：实例服务在**启动 DSH 之前**调用（容器已创建未启动，WP2 第二轮），
    // 安装走一次性维护容器（runInContainer 见 status≠running → runOnce），随后 DSH 首次启动即带齐插件，
    // 因此照传调用方的 restart（next-start）即可，不需要再重启。
    await installer.bootstrapUser(userId, { ...opts, source: 'policy' })
  }

  async function reconcileUser(
    userId: number,
    opts: Partial<InstallForUserOptions> = {},
  ): Promise<{ changed: number }> {
    const result = await installer.reconcileUser(userId, {
      restart: opts.restart ?? 'next-start',
      onLog: opts.onLog,
      signal: opts.signal,
      source: 'policy',
    })
    return { changed: result.changed.length }
  }

  async function requestToggle(
    userId: number,
    pluginId: number,
    action: 'install' | 'uninstall',
  ): Promise<{ jobId: number }> {
    requireUser(userId)
    const plugin = requirePluginRow(db, pluginId)
    if (plugin.policy !== 'optional') {
      throw new HubError('FORBIDDEN', '只有「可选」插件支持自助安装/卸载')
    }
    const instances = services().instances
    const quota = instances ? instances.resolveQuota(userId) : DEFAULT_QUOTA_VALUE
    if (!quota.allowUserPlugins) {
      throw new HubError('FORBIDDEN', '管理员已关闭自助安装插件')
    }
    const rollouts = services().rollouts
    if (!rollouts) throw new HubError('INTERNAL', '下发服务未装配')
    const current = getUserPluginRow(db, userId, pluginId)
    if (action === 'uninstall' && !current?.actual_version_id) {
      throw new HubError('CONFLICT', '该插件当前没有安装')
    }
    let versionId: number | undefined
    if (action === 'install') {
      const latest = latestVersionRow(db, pluginId)
      if (!latest) throw new HubError('CONFLICT', '该插件还没有可安装的版本')
      if (current?.actual_version_id === latest.id) {
        throw new HubError('CONFLICT', '该插件已经是最新版本')
      }
      versionId = latest.id
    }
    return rollouts.create(
      {
        kind: 'plugin',
        action,
        pluginId,
        ...(versionId === undefined ? {} : { versionId }),
        targets: { userIds: [userId] },
        strategy: { concurrency: 1, canary: 0, maxFailureRatio: 0, restart: 'now' },
      },
      userId,
      { ip: null, userAgent: null },
      { source: 'user' },
    )
  }

  return {
    listCatalog,
    getCatalogRow,
    createPlugin,
    updatePlugin,
    deletePlugin,
    addPlatform,
    updatePlatform,
    removePlatform,
    lookup,
    lookupUpload,
    addVersion,
    addUploadedVersion,
    removeVersion,
    listUsersOfPlugin,
    listUserPluginRows: listUserPluginRowsFor,
    listForUser,
    installForUser,
    bootstrapUser,
    reconcileUser,
    requestToggle,
    waitForReconcile: (userId) => installer.waitForReconcile(userId),
    scheduleReconcile: (userId) => installer.scheduleReconcile(userId),
  }
}

export function sortVersionsDesc(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a))
}

/** 语义化版本比较（够用即可：数字段 + 预发布后缀；不合法时退化为字符串比较） */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; pre: string } => {
    const [core = '', pre = ''] = value.replace(/^v/u, '').split('-', 2)
    return { nums: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.nums.length, right.nums.length); index += 1) {
    const diff = (left.nums[index] ?? 0) - (right.nums[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre.localeCompare(right.pre)
}
