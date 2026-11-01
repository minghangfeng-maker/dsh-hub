import {
  StrategySchema,
  type DeliveryItem,
  type DeliveryRequest,
  type Role,
  type Strategy,
  type UserStatus,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { compareSemver } from '../desktop-delivery/service.js'
import { listConfigFragments, scopeOf, type ScopeKey } from '../desktop-delivery/repo.js'
import { getPresetName, resolveTargetUserRows, type TargetUserRow } from '../rollouts/repo.js'
import {
  findVersionRowOfPlatform,
  getDeliveryRuntimeRow,
  getDeliveryVersionRow,
  getLatestDeliveryVersionRow,
  hasDesktopArtifact,
  listDeliveryRuntimeRows,
  listDesktopDevices,
  listDesktopPluginTargetRows,
  listDesktopUsersWithActiveDevices,
  listUserPluginStates,
  listUsersWithPluginInstalled,
  listVersionLabels,
  type DeliveryVersionRow,
  type DesktopDeviceTargetRow,
  type DesktopPluginTargetRowLite,
} from './repo.js'

/**
 * 统一下发的目标解析（WP28a 交付物 1）。**预览与提交共用本文件的同一份实现**：
 * - `preview.ts` 把每个内容项在某个平台上的解析结果渲染成 `DeliveryPreviewRow`；
 * - `execute.ts` 只按「没有 skipReason」的行去建 job / 写桌面目标。
 *
 * 语义来源 `docs/21` §2：
 * - `all` / `users` / `role`：实例侧 = 现有 rollouts 的目标解析（`resolveTargetUserRows`，金丝雀排序由
 *   rollouts 负责）；桌面侧 = 至少有一台有效设备的用户，**一台设备一行**；
 * - `installed`：每个内容项各自解析（plugin 看 `user_plugins` / `desktop_device_plugins`；models 看
 *   「在用 Hub 模型配置」/「已登录的有效设备」），`outdatedOnly` 用 semver 比较。
 *
 * 「跳过」的口径：`skipReason !== null` 的行**不会**进本次的任务与桌面目标
 * （执行侧只认没有 skipReason 的行），这样预览说的「会执行 N 行」与真正提交的东西一致。
 */

import { getPluginPlatformRow } from '../plugins/repo.js'
import type { DeliveryDeps } from './types.js'
export type { DeliveryDeps }

// ── 解析结果的数据形状 ──────────────────────────────────────────────────────

/** 一个内容项的可读描述 + 它的引用对象（三个平台共用） */
export interface ResolvedItem {
  index: number
  item: DeliveryItem
  /** 「dsh-memory 0.3.1」「模型与 API 配置」「DSH 0.2.1-rc.2」 */
  label: string
  plugin: { id: number; packageName: string; policy: string; needsRestart: boolean } | null
  /** **云上**版本（实例侧用）：`versionId` 或云上最新 */
  version: { id: number; version: string; minDsh: string | null; desktopArtifact: boolean } | null
  /** **桌面**版本（桌面侧用）：`desktopVersionId` 或桌面最新；必须有整包才能下发 */
  desktopVersion: { id: number; version: string; minDsh: string | null } | null
  /** 桌面侧可读标签（可能与云上版本号不同） */
  desktopLabel: string
  preset: { id: number | null; name: string | null } | null
  runtime: { id: number; version: string; isDefault: boolean } | null
  /** 整项在某个平台不可执行的原因（runtime 选了桌面、缺桌面整包、hidden、插件没有可用版本） */
  instanceBlocked: string | null
  desktopBlocked: string | null
}

/** 实例侧的一个目标用户（含解析「已安装」时拿到的插件状态） */
export interface InstanceTarget {
  userId: number
  username: string
  status: UserStatus
  runtimeId: number | null
  modelPresetId: number | null
  modelPolicy: string
  desired: string | null
  desiredVersionId: number | null
  actualVersionId: number | null
  /** 该用户当前生效的 DSH 版本（钉住的优先，否则默认版本） */
  effectiveRuntimeVersion: string | null
  /** `installed` + `outdatedOnly`：已装版本号解析不出来，按「较旧」处理（行里会写明） */
  versionUnparsable?: boolean
}

/** 桌面侧的一台设备（一台设备一行） */
export interface DesktopTarget {
  userId: number
  username: string
  role: string
  deviceId: string
  deviceName: string
  deviceStatus: 'active' | 'revoked'
  /** 设备上报里这个插件的版本（models / 非插件项为 null） */
  pluginVersion: string | null
  /** 目标作用域（`installed`/`users` = scope:user；`all`/`role` = 请求里的那个） */
  scope: ScopeKey
  /** `installed` + `outdatedOnly`：设备上报的版本号解析不出来，按「较旧」处理（行里会写明） */
  versionUnparsable?: boolean
}

export interface RowState {
  current: string
  after: string
  needsRestart: boolean
  skipReason: string | null
  /** 版本号解析不出来、被当成「较旧」（`outdatedOnly` 的说明用） */
  versionUnparsable?: boolean
}

export interface InstanceSide {
  /** 整项不可执行（缺可用版本等） */
  blocked: string | null
  rows: (RowState & { target: InstanceTarget })[]
  /** 会真正进 job 的用户 id */
  userIds: number[]
}

export interface DesktopSide {
  blocked: string | null
  rows: (RowState & { target: DesktopTarget })[]
  /** 会真正写目标的作用域（`all`/`role` 一个；`users`/`installed` 每个用户一个） */
  scopes: ScopeKey[]
  /** 会写到的用户（`scope=user` 才有意义） */
  userIds: number[]
  users: number
  devices: number
}


export interface DeliveryPlan {
  request: DeliveryRequest
  strategy: Strategy
  platforms: { instance: boolean; desktop: boolean }
  items: ResolvedItem[]
  /** 内容项级别的警告（平台不适用、缺整包、模型渲染告警…） */
  warnings: string[]
  /** 桌面 models 一次性渲染的片段（多个 models 内容项共用） */
  modelFragments: { fragments: { id: string; config: Record<string, unknown> }[]; warnings: string[] } | null
}

// ── 版本比较的小工具 ────────────────────────────────────────────────────────

const VERSION_RE = /^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/u

/** 版本号能不能按 semver 解析（解析不出来 → 按「较旧」处理并在行里写明） */
export function isParsableVersion(value: string | null | undefined): value is string {
  return typeof value === 'string' && VERSION_RE.test(value.trim())
}

/** 插件版本的 `min_dsh` 与用户的 DSH 版本是否兼容（支持 `>=0.2.0` / `^0.2.0` / 裸版本） */
export function satisfiesMinDsh(dshVersion: string | null, minDsh: string | null): boolean {
  if (minDsh === null || minDsh.trim().length === 0) return true
  if (!isParsableVersion(dshVersion)) return true
  const raw = minDsh.trim()
  const floor = raw.replace(/^(>=|>|\^|~)/u, '').trim()
  if (!isParsableVersion(floor)) return true
  if (raw.startsWith('>') && !raw.startsWith('>=')) return compareSemver(dshVersion, floor) > 0
  return compareSemver(dshVersion, floor) >= 0
}

// ── 计划：内容项解析（引用校验 + 可读标签 + 整项跳过的原因）──────────────────

/**
 * 解析请求里的每个内容项。引用不存在一律 404 / 409（与 rollouts 的 `assertReferences` 同口径，D9），
 * 绝不落到 INTERNAL。
 */
export async function buildPlan(deps: DeliveryDeps, request: DeliveryRequest): Promise<DeliveryPlan> {
  const db = deps.db
  const platforms = {
    instance: request.platforms.includes('instance'),
    desktop: request.platforms.includes('desktop'),
  }
  const strategy = StrategySchema.parse(request.strategy ?? {})
  const warnings: string[] = []
  const items: ResolvedItem[] = request.items.map((item, index) =>
    resolveItem(db, item, index, request.action),
  )

  // 桌面侧 models 片段：一次渲染，多个 models 内容项共用（要读预设与中转站桥，不该按目标循环）
  let modelFragments: DeliveryPlan['modelFragments'] = null
  if (platforms.desktop && items.some((entry) => entry.item.kind === 'models')) {
    modelFragments = await renderDesktopModelFragments(deps, request)
    warnings.push(...modelFragments.warnings)
  }

  for (const entry of items) {
    if (entry.item.kind === 'models' && platforms.desktop) {
      if (modelFragments !== null && modelFragments.fragments.length === 0) {
        entry.desktopBlocked = modelFragments.warnings[0] ?? '没有可下发的模型配置片段'
      }
    }
    if (
      entry.item.kind === 'plugin' &&
      platforms.desktop &&
      entry.desktopBlocked === null &&
      entry.desktopVersion !== null &&
      entry.item.desktopVersionId === undefined &&
      entry.version !== null &&
      entry.desktopVersion.id !== entry.version.id
    ) {
      // docs/22 §2.2：旧请求只给 `versionId`（云上）时，桌面侧取桌面最新并在预览里说明
      warnings.push(
        `「${entry.label}」没有指定桌面版本（desktopVersionId），桌面侧按桌面最新版本 ${entry.desktopVersion.version} 下发`,
      )
    }
    if (entry.item.kind === 'runtime' && platforms.desktop) {
      warnings.push(`「${entry.label}」只能下发给实例：桌面端的版本走「桌面端 → 版本与升级」`)
    }
    if (entry.desktopBlocked !== null && platforms.desktop) {
      warnings.push(`桌面端跳过「${entry.label}」：${entry.desktopBlocked}`)
    }
    if (entry.instanceBlocked !== null && platforms.instance) {
      warnings.push(`实例端跳过「${entry.label}」：${entry.instanceBlocked}`)
    }
  }

  // `users` 目标里不存在 / 已删除的用户：给出警告，不静默吞掉
  if (request.targets.mode === 'users') {
    const found = new Set(
      resolveTargetUserRows(db, { userIds: request.targets.userIds }, null).map((row) => row.id),
    )
    const missing = request.targets.userIds.filter((id) => !found.has(id))
    if (missing.length > 0) {
      warnings.push(
        `有 ${String(missing.length)} 个用户不存在或已删除，已忽略：${missing.slice(0, 10).join('、')}`,
      )
    }
  }

  return { request, strategy, platforms, items, warnings, modelFragments }
}

function resolveItem(
  db: BaseDeps['db'],
  item: DeliveryItem,
  index: number,
  action: DeliveryRequest['action'],
): ResolvedItem {
  if (item.kind === 'plugin') {
    const plugin = db.get<{ id: number; package_name: string; policy: string; needs_restart: number }>(
      'SELECT id, package_name, policy, needs_restart FROM plugins WHERE id = ?',
      item.pluginId,
    )
    if (!plugin) throw new HubError('NOT_FOUND', '插件不存在')
    // docs/22 §2：两个平台各一套库与版本，缺省各取自己的最新
    const cloudSettings = getPluginPlatformRow(db, plugin.id, 'cloud')
    const desktopSettings = getPluginPlatformRow(db, plugin.id, 'desktop')

    // 云上版本：`versionId`（缺省云上最新）。给的是桌面版本 id 时按同名版本落到云上版本
    let version: ResolvedItem['version'] = null
    let versionNote: string | null = null
    if (item.versionId !== undefined) {
      const found = resolveVersionAcrossPlatforms(db, item.versionId, item.pluginId, 'cloud')
      if (found.row) version = versionOf(db, found.row)
      else versionNote = `该版本只存在于桌面插件库`
    } else if (action !== 'uninstall') {
      const row = getLatestDeliveryVersionRow(db, item.pluginId, 'cloud')
      if (row) version = versionOf(db, row)
    }

    // 桌面版本：`desktopVersionId`（缺省桌面最新）；给的是云上版本 id 时按同名版本落到桌面版本
    let desktopVersion: ResolvedItem['desktopVersion'] = null
    let desktopVersionNote: string | null = null
    if (item.desktopVersionId !== undefined) {
      const found = resolveVersionAcrossPlatforms(db, item.desktopVersionId, item.pluginId, 'desktop')
      if (found.row) desktopVersion = { id: found.row.id, version: found.row.version, minDsh: found.row.min_dsh }
      else desktopVersionNote = '该版本只存在于云上插件库'
    } else if (action !== 'uninstall') {
      const row = getLatestDeliveryVersionRow(db, item.pluginId, 'desktop')
      if (row) desktopVersion = { id: row.id, version: row.version, minDsh: row.min_dsh }
    }

    const label = version ? `${plugin.package_name} ${version.version}` : plugin.package_name
    const desktopLabel = desktopVersion
      ? `${plugin.package_name} ${desktopVersion.version}`
      : plugin.package_name
    const noVersion = version === null && action !== 'uninstall' ? '该插件还没有可安装的版本' : null

    const instanceBlocked =
      (cloudSettings === undefined ? `插件 ${plugin.package_name} 不在云上插件库` : null) ??
      versionNote ??
      noVersion

    let desktopBlocked: string | null = null
    if (action === 'uninstall') {
      // 卸载只看包名（客户端本地可能装过），插件不在桌面库也允许
      desktopBlocked = null
    } else if (desktopSettings === undefined) {
      desktopBlocked = `插件 ${plugin.package_name} 不在桌面插件库`
    } else if (desktopSettings.policy === 'hidden') {
      desktopBlocked = `插件 ${plugin.package_name} 的桌面 policy 是 hidden，桌面端不下发`
    } else if (desktopVersion === null) {
      desktopBlocked = desktopVersionNote ?? `插件 ${plugin.package_name} 在桌面插件库里还没有版本`
    } else if (!hasDesktopArtifact(db, desktopVersion.id)) {
      desktopBlocked = `插件 ${plugin.package_name}@${desktopVersion.version} 还没有上传桌面整包`
    }

    return {
      index,
      item,
      label,
      desktopLabel,
      plugin: {
        id: plugin.id,
        packageName: plugin.package_name,
        policy: cloudSettings?.policy ?? plugin.policy,
        needsRestart: (cloudSettings?.needs_restart ?? plugin.needs_restart) === 1,
      },
      version,
      desktopVersion,
      preset: null,
      runtime: null,
      instanceBlocked,
      desktopBlocked,
    }
  }

  if (item.kind === 'models') {
    if (item.presetId !== undefined && getPresetName(db, item.presetId) === null) {
      throw new HubError('NOT_FOUND', '模型预设不存在')
    }
    const name = item.presetId === undefined ? null : getPresetName(db, item.presetId)
    const modelLabel = name === null ? '模型与 API 配置' : `模型与 API 配置（${name}）`
    return {
      index,
      item,
      label: modelLabel,
      desktopLabel: modelLabel,
      plugin: null,
      version: null,
      desktopVersion: null,
      preset: { id: item.presetId ?? null, name },
      runtime: null,
      instanceBlocked: null,
      desktopBlocked: null,
    }
  }

  const runtime = getDeliveryRuntimeRow(db, item.runtimeId)
  if (!runtime) throw new HubError('NOT_FOUND', 'DSH 版本不存在')
  if (runtime.status !== 'ready') {
    throw new HubError('RUNTIME_NOT_READY', '该版本的镜像还没就绪，不能下发')
  }
  return {
    index,
    item,
    label: `DSH ${runtime.dsh_version}`,
    desktopLabel: `DSH ${runtime.dsh_version}`,
    plugin: null,
    version: null,
    desktopVersion: null,
    preset: null,
    runtime: { id: runtime.id, version: runtime.dsh_version, isDefault: runtime.is_default === 1 },
    instanceBlocked: null,
    desktopBlocked: 'DSH 版本只能下发给实例',
  }
}

/**
 * 解析内容项里给的版本 id：id 必须属于该插件；**平台不一致时按同名版本落到目标平台**
 * （docs/22 §2.2：老请求只给 `versionId`（云上），桌面侧要取桌面最新/同名版本）。
 * 返回 `row=null` 且在目标平台没有同名版本时，由调用方给「只存在于另一个平台」的原因。
 */
function resolveVersionAcrossPlatforms(
  db: DeliveryDeps['db'],
  versionId: number,
  pluginId: number,
  wanted: 'cloud' | 'desktop',
): { row: DeliveryVersionRow | null } {
  const row = getDeliveryVersionRow(db, versionId)
  if (!row || row.plugin_id !== pluginId) {
    throw new HubError('NOT_FOUND', '插件版本不存在或不属于该插件')
  }
  if (row.platform === wanted) return { row }
  return { row: findVersionRowOfPlatform(db, pluginId, row.version, wanted) ?? null }
}

function versionOf(
  db: BaseDeps['db'],
  row: { id: number; version: string; min_dsh: string | null },
): NonNullable<ResolvedItem['version']> {
  return {
    id: row.id,
    version: row.version,
    minDsh: row.min_dsh,
    desktopArtifact: hasDesktopArtifact(db, row.id),
  }
}

async function renderDesktopModelFragments(
  deps: DeliveryDeps,
  request: DeliveryRequest,
): Promise<{ fragments: { id: string; config: Record<string, unknown> }[]; warnings: string[] }> {
  const modelsItem = request.items.find((item) => item.kind === 'models')
  const presetId = modelsItem !== undefined && modelsItem.kind === 'models' ? modelsItem.presetId : undefined
  const delivery = deps.services.desktopDelivery
  if (delivery) {
    try {
      const result = await delivery.modelPresetFragments(undefined, presetId)
      return { fragments: result.fragments, warnings: result.warnings }
    } catch (error) {
      // 没有默认预设之类的「渲染不出来」不该让预览 500：降级成一条警告，桌面 models 整项跳过
      if (HubError.is(error)) return { fragments: [], warnings: [`桌面模型片段渲染失败：${error.message}`] }
      throw error
    }
  }
  const models = deps.services.models
  if (!models) return { fragments: [], warnings: ['模型服务未装配，无法渲染桌面模型片段'] }
  try {
    const result = await models.desktopModelFragments(null, { presetId })
    return { fragments: result.fragments, warnings: result.warnings }
  } catch (error) {
    if (HubError.is(error)) return { fragments: [], warnings: [`桌面模型片段渲染失败：${error.message}`] }
    throw error
  }
}

// ── 实例侧解析 ──────────────────────────────────────────────────────────────

export interface InstanceResolutionDeps extends DeliveryDeps {
  /** rollouts 的 preview：current/after/willRestart 沿用现有逻辑（执行侧同一套过滤） */
  rolloutPreview: (input: RolloutRequestLike, actorId: number | null) => Promise<{
    targets: { userId: number; username: string; current: string; after: string; willRestart: boolean }[]
  }>
}

type RolloutRequestLike = Parameters<AppDeps['services']['rollouts']['create']>[0]

export async function resolveInstanceSide(
  deps: InstanceResolutionDeps,
  plan: DeliveryPlan,
  entry: ResolvedItem,
): Promise<InstanceSide> {
  if (entry.instanceBlocked !== null) {
    return { blocked: entry.instanceBlocked, rows: [], userIds: [] }
  }

  const runtimeVersions = runtimeVersionMap(deps.db, listDeliveryRuntimeRows(deps.db))
  const states = entry.item.kind === 'plugin' ? pluginStates(deps.db, entry) : null
  const targets = filterOutdatedInstanceTargets(
    deps.db,
    plan.request,
    entry,
    resolveInstanceTargets(deps, plan.request, entry, runtimeVersions),
    states,
  )
  if (targets.length === 0) return { blocked: null, rows: [], userIds: [] }

  // 1) 不依赖状态的跳过原因（未启用 / 待审批 / DSH 版本不兼容 / 已钉在别的版本 / 已是该版本）
  const preRows = targets.map((target) => ({
    target,
    ...instanceSkipReason(plan.request, entry, target, states),
  }))

  // 2) 交给 rollouts 的 preview 算 current/after/willRestart：它就是执行侧用的那套过滤
  //    （金丝雀排序、钉版本、卸载只看装过的），这样「会执行」的行数 = 提交时真正建的任务数
  const candidateIds = preRows.filter((row) => row.skipReason === null).map((row) => row.target.userId)
  const previewById = new Map<number, { current: string; after: string; willRestart: boolean }>()
  if (candidateIds.length > 0) {
    const preview = await deps.rolloutPreview(rolloutRequestFor(plan, entry, candidateIds), null)
    for (const item of preview.targets) {
      previewById.set(item.userId, {
        current: item.current,
        after: item.after,
        willRestart: item.willRestart,
      })
    }
  }

  const rows: InstanceSide['rows'] = []
  const userIds: number[] = []
  for (const row of preRows) {
    const preview = previewById.get(row.target.userId)
    let skipReason = row.skipReason
    // 执行侧（rollouts）自己也会过滤：preview 没返回 = 这次不会为它建任务
    if (skipReason === null && preview === undefined) {
      skipReason = entry.item.kind === 'plugin' ? '该用户上没有这个插件' : '不在本次执行范围内'
    }
    const unparsable = row.versionUnparsable === true || row.target.versionUnparsable === true
    const baseCurrent = preview?.current ?? fallbackCurrent(entry, row.target, states)
    rows.push({
      target: row.target,
      current: unparsable ? `${baseCurrent}（无法解析版本，按较旧处理）` : baseCurrent,
      after: preview?.after ?? fallbackAfter(entry),
      needsRestart: skipReason === null ? (preview?.willRestart ?? false) : false,
      skipReason,
      ...(unparsable ? { versionUnparsable: true } : {}),
    })
    if (skipReason === null) userIds.push(row.target.userId)
  }
  return { blocked: null, rows, userIds }
}

function runtimeVersionMap(
  db: BaseDeps['db'],
  rows: { id: number; dsh_version: string; is_default: number }[],
): { byId: Map<number, string>; defaultVersion: string | null } {
  void db
  const byId = new Map<number, string>()
  let defaultVersion: string | null = null
  for (const row of rows) {
    byId.set(row.id, row.dsh_version)
    if (row.is_default === 1 && defaultVersion === null) defaultVersion = row.dsh_version
  }
  return { byId, defaultVersion }
}

interface PluginStates {
  byUser: Map<number, { desired: string; desired_version_id: number | null; actual_version_id: number | null }>
  actualLabels: Map<number, string>
}

function pluginStates(db: BaseDeps['db'], entry: ResolvedItem): PluginStates | null {
  if (entry.item.kind !== 'plugin' || entry.plugin === null) return null
  const byUser = new Map<
    number,
    { desired: string; desired_version_id: number | null; actual_version_id: number | null }
  >()
  const versionIds: number[] = []
  for (const row of listUserPluginStates(db, entry.plugin.id)) {
    byUser.set(row.user_id, {
      desired: row.desired,
      desired_version_id: row.desired_version_id,
      actual_version_id: row.actual_version_id,
    })
    if (row.desired_version_id !== null) versionIds.push(row.desired_version_id)
    if (row.actual_version_id !== null) versionIds.push(row.actual_version_id)
  }
  return { byUser, actualLabels: listVersionLabels(db, versionIds) }
}

function resolveInstanceTargets(
  deps: DeliveryDeps,
  request: DeliveryRequest,
  entry: ResolvedItem,
  runtimeVersions: { byId: Map<number, string>; defaultVersion: string | null },
): InstanceTarget[] {
  const targets = request.targets
  const effective = (runtimeId: number | null): string | null =>
    runtimeId === null ? runtimeVersions.defaultVersion : (runtimeVersions.byId.get(runtimeId) ?? null)

  if (targets.mode === 'installed') {
    if (entry.item.kind === 'plugin' && entry.plugin !== null) {
      return listUsersWithPluginInstalled(deps.db, entry.plugin.id).map((row) =>
        instanceTargetOf(row, row.desired, row.desired_version_id, row.actual_version_id, effective(row.runtime_id)),
      )
    }
    if (entry.item.kind === 'models') {
      // 「容器已渲染过 Hub 路由的用户」：模型托管（managed）且生效预设里有启用的 hub-relay 提供方
      const models = deps.services.models
      return resolveTargetUserRows(deps.db, { all: true }, null)
        .filter((row) => row.model_policy === 'managed' && (models ? models.hasRelayProviderForUser(row.id) : true))
        .map((row) => instanceTargetOf(row, null, null, null, effective(row.runtime_id)))
    }
    return []
  }

  const targetParam =
    targets.mode === 'all'
      ? ({ all: true } as const)
      : targets.mode === 'users'
        ? ({ userIds: targets.userIds } as const)
        : ({ filter: { role: targets.role } } as const)
  return resolveTargetUserRows(deps.db, targetParam, null).map((row) =>
    instanceTargetOf(row, null, null, null, effective(row.runtime_id)),
  )
}

function instanceTargetOf(
  row: TargetUserRow,
  desired: string | null,
  desiredVersionId: number | null,
  actualVersionId: number | null,
  effectiveRuntimeVersion: string | null,
): InstanceTarget {
  return {
    userId: row.id,
    username: row.username,
    status: row.status,
    runtimeId: row.runtime_id,
    modelPresetId: row.model_preset_id,
    modelPolicy: row.model_policy,
    desired,
    desiredVersionId,
    actualVersionId,
    effectiveRuntimeVersion,
  }
}

function instanceSkipReason(
  request: DeliveryRequest,
  entry: ResolvedItem,
  target: InstanceTarget,
  states: PluginStates | null,
): { skipReason: string | null; versionUnparsable?: boolean } {
  if (target.status === 'pending') return { skipReason: '待审批：账号还未启用' }
  if (target.status === 'disabled') return { skipReason: '用户未启用' }

  if (entry.item.kind === 'plugin') {
    if (request.action === 'uninstall' || entry.version === null) return { skipReason: null }
    if (!satisfiesMinDsh(target.effectiveRuntimeVersion, entry.version.minDsh)) {
      return { skipReason: `DSH 版本不兼容（插件要求 ≥ ${entry.version.minDsh ?? '?'}）` }
    }
    const state = states?.byUser.get(target.userId) ?? null
    if (
      state !== null &&
      state.desired === 'installed' &&
      state.desired_version_id === entry.version.id &&
      state.actual_version_id === entry.version.id
    ) {
      return { skipReason: '已是该版本' }
    }
    return { skipReason: null }
  }

  if (entry.item.kind === 'runtime' && entry.runtime !== null) {
    if (target.runtimeId === entry.runtime.id) return { skipReason: '已在该 DSH 版本' }
    if (target.runtimeId === null && entry.runtime.isDefault) {
      return { skipReason: '已在默认 DSH 版本（跟随默认）' }
    }
    if (target.runtimeId !== null && target.runtimeId !== entry.runtime.id) {
      return { skipReason: '已钉在其它 DSH 版本' }
    }
    return { skipReason: null }
  }

  // models：model_policy=free 的用户不会被 Hub 渲染（沿用 rollouts 预览的文案，不在这里跳过）
  return { skipReason: null }
}

/**
 * `installed` + `outdatedOnly`：只保留「版本低于本次要下发版本」的用户（semver 语义）。
 * 解析不出版本号的一律按「较旧」保留，并在行里写明（契约要求）。
 */
function filterOutdatedInstanceTargets(
  db: BaseDeps['db'],
  request: DeliveryRequest,
  entry: ResolvedItem,
  targets: InstanceTarget[],
  states: PluginStates | null,
): InstanceTarget[] {
  void db
  if (request.targets.mode !== 'installed' || !request.targets.outdatedOnly) return targets
  if (entry.item.kind !== 'plugin' || entry.version === null || request.action === 'uninstall') return targets
  const targetVersion = entry.version.version
  const kept: InstanceTarget[] = []
  for (const row of targets) {
    const currentId = row.actualVersionId ?? row.desiredVersionId
    const current = currentId === null ? null : (states?.actualLabels.get(currentId) ?? null)
    if (!isParsableVersion(current)) {
      kept.push({ ...row, versionUnparsable: true })
      continue
    }
    if (!isParsableVersion(targetVersion) || compareSemver(current, targetVersion) < 0) kept.push(row)
  }
  return kept
}

/** rollouts preview 没返回这一行时的兜底文案（目标在执行侧被过滤掉的极少情况） */
function fallbackCurrent(entry: ResolvedItem, target: InstanceTarget, states: PluginStates | null): string {
  if (entry.item.kind === 'plugin') {
    const state = states?.byUser.get(target.userId) ?? null
    const actual = state?.actual_version_id ?? null
    const label = actual === null ? null : (states?.actualLabels.get(actual) ?? null)
    return label === null ? '未安装' : `${entry.plugin?.packageName ?? ''}@${label}`
  }
  if (entry.item.kind === 'models') {
    return target.modelPolicy === 'free' ? '自由配置（不下发）' : 'Hub 托管'
  }
  return target.effectiveRuntimeVersion ?? '未就绪'
}

function fallbackAfter(entry: ResolvedItem): string {
  if (entry.item.kind === 'plugin') {
    return entry.version === null ? '未安装' : `${entry.plugin?.packageName ?? ''}@${entry.version.version}`
  }
  if (entry.item.kind === 'models') return '按最新配置重渲染'
  return entry.runtime?.version ?? '未知版本'
}

// ── 桌面侧解析 ──────────────────────────────────────────────────────────────

export function resolveDesktopSide(
  db: BaseDeps['db'],
  plan: DeliveryPlan,
  entry: ResolvedItem,
): DesktopSide {
  const request = plan.request
  if (entry.desktopBlocked !== null) {
    return { blocked: entry.desktopBlocked, rows: [], scopes: [], userIds: [], users: 0, devices: 0 }
  }

  const scopeLevel = request.targets.mode === 'all' || request.targets.mode === 'role'
  const pluginTargets = entry.plugin !== null ? listDesktopPluginTargetRows(db, entry.plugin.id) : []
  const fragments = entry.item.kind === 'models' ? listConfigFragments(db) : []

  const targetUsers = scopeLevel ? [] : desktopTargetUserIds(db, request, entry)
  if (!scopeLevel && targetUsers.length === 0) {
    return { blocked: null, rows: [], scopes: [], userIds: [], users: 0, devices: 0 }
  }

  let devices = listDesktopDevices(db, {
    ...(scopeLevel
      ? request.targets.mode === 'role'
        ? { role: request.targets.role as Role }
        : {}
      : { userIds: targetUsers }),
    // 显式点名的用户：连已吊销的设备一起列出来并标「设备已吊销」（其他目标模式吊销设备根本不进目标）
    includeRevoked: request.targets.mode === 'users',
    installedPackageName:
      request.targets.mode === 'installed' && entry.item.kind === 'plugin'
        ? (entry.plugin?.packageName ?? null)
        : null,
    packageName: entry.item.kind === 'plugin' ? (entry.plugin?.packageName ?? null) : null,
  })

  // `installed` + `outdatedOnly`：只留版本低于目标版本的设备；解析不出版本的按「较旧」保留
  if (
    request.targets.mode === 'installed' &&
    request.targets.outdatedOnly &&
    entry.item.kind === 'plugin' &&
    entry.desktopVersion !== null &&
    request.action !== 'uninstall'
  ) {
    const targetVersion = entry.desktopVersion.version
    devices = devices.filter((device) => {
      if (!isParsableVersion(device.plugin_version)) return true
      return !isParsableVersion(targetVersion) || compareSemver(device.plugin_version, targetVersion) < 0
    })
  }

  const rows: DesktopSide['rows'] = []
  const executableUsers = new Set<number>()
  for (const device of devices) {
    const scope = scopeLevel
      ? request.targets.mode === 'role'
        ? scopeOf({ scope: 'role', role: request.targets.role as Role })
        : scopeOf({ scope: 'all' })
      : scopeOf({ scope: 'user', userId: device.user_id })
    const target: DesktopTarget = {
      userId: device.user_id,
      username: device.username,
      role: device.role,
      deviceId: device.device_id,
      deviceName: device.device_name,
      deviceStatus: device.device_status,
      pluginVersion: device.plugin_version,
      scope,
      ...(device.plugin_version !== null && !isParsableVersion(device.plugin_version)
        ? { versionUnparsable: true }
        : {}),
    }
    const verdict = desktopRowState(request, entry, device, scope, pluginTargets, fragments)
    rows.push({
      target,
      current: verdict.current,
      after: verdict.after,
      needsRestart: verdict.skipReason === null ? needsRestartForDesktop(entry) : false,
      skipReason: verdict.skipReason,
      ...(verdict.versionUnparsable === true || target.versionUnparsable === true
        ? { versionUnparsable: true }
        : {}),
    })
    if (verdict.skipReason === null) executableUsers.add(device.user_id)
  }

  const scopeList = scopeLevel
    ? [
        request.targets.mode === 'role'
          ? scopeOf({ scope: 'role', role: request.targets.role as Role })
          : scopeOf({ scope: 'all' }),
      ]
    : [...executableUsers].sort((a, b) => a - b).map((userId) => scopeOf({ scope: 'user', userId }))

  return {
    blocked: null,
    rows,
    scopes: scopeList,
    userIds: scopeLevel ? [] : scopeList.map((scope) => scope.userId ?? 0).filter((id) => id > 0),
    users: new Set(rows.map((row) => row.target.userId)).size,
    devices: new Set(rows.filter((row) => row.skipReason === null).map((row) => row.target.deviceId)).size,
  }
}

function desktopTargetUserIds(db: BaseDeps['db'], request: DeliveryRequest, entry: ResolvedItem): number[] {
  const targets = request.targets
  if (targets.mode === 'users') {
    return resolveTargetUserRows(db, { userIds: targets.userIds }, null).map((row) => row.id)
  }
  if (targets.mode !== 'installed') return []
  if (entry.item.kind === 'plugin') {
    const devices = listDesktopDevices(db, {
      installedPackageName: entry.plugin?.packageName ?? null,
      packageName: entry.plugin?.packageName ?? null,
    })
    return [...new Set(devices.map((device) => device.user_id))].sort((a, b) => a - b)
  }
  return listDesktopUsersWithActiveDevices(db, {})
}

function desktopRowState(
  request: DeliveryRequest,
  entry: ResolvedItem,
  device: DesktopDeviceTargetRow,
  scope: ScopeKey,
  pluginTargets: DesktopPluginTargetRowLite[],
  fragments: { entry_id: string; scope: string; role: string; user_id: number | null }[],
): RowState {
  const current = desktopCurrent(entry, device, scope, fragments)
  const after = desktopAfter(entry, request)
  if (device.device_status === 'revoked') {
    return { current, after, needsRestart: false, skipReason: '设备已吊销' }
  }
  if (device.user_status === 'pending') {
    return { current, after, needsRestart: false, skipReason: '待审批：账号还未启用' }
  }
  if (device.user_status === 'disabled') {
    return { current, after, needsRestart: false, skipReason: '用户未启用' }
  }

  if (entry.item.kind === 'plugin') {
    if (request.action === 'uninstall') {
      if (device.plugin_version === null) {
        return { current: '未安装', after: '未安装', needsRestart: false, skipReason: '设备上没有这个插件' }
      }
      return { current, after: '未安装', needsRestart: true, skipReason: null }
    }
    if (entry.desktopVersion === null) {
      return { current, after, needsRestart: false, skipReason: '该插件还没有可安装的版本' }
    }
    const existing = pluginTargets.find(
      (row) =>
        row.scope === scope.scope &&
        row.role === scope.role &&
        (row.user_id ?? null) === (scope.userId ?? null),
    )
    const alreadyDelivered = existing?.version_id === entry.desktopVersion.id
    if (alreadyDelivered && device.plugin_version !== null) {
      if (!isParsableVersion(device.plugin_version)) {
        return { current, after, needsRestart: true, skipReason: null, versionUnparsable: true }
      }
      if (compareSemver(device.plugin_version, entry.desktopVersion.version) === 0) {
        return { current, after, needsRestart: false, skipReason: '已是该版本' }
      }
    }
    return { current, after, needsRestart: true, skipReason: null }
  }

  return { current, after, needsRestart: true, skipReason: null }
}

function desktopCurrent(
  entry: ResolvedItem,
  device: DesktopDeviceTargetRow,
  scope: ScopeKey,
  fragments: { entry_id: string; scope: string; role: string; user_id: number | null }[],
): string {
  if (entry.item.kind === 'plugin') {
    if (device.plugin_version === null) return '未安装'
    const label = `${entry.plugin?.packageName ?? ''}@${device.plugin_version}`
    return isParsableVersion(device.plugin_version) ? label : `${label}（无法解析版本，按较旧处理）`
  }
  if (entry.item.kind === 'models') {
    const mine = fragments.filter(
      (row) =>
        row.scope === scope.scope &&
        row.role === scope.role &&
        (row.user_id ?? null) === (scope.userId ?? null),
    )
    const hasModels = mine.some((row) => row.entry_id === 'llm-pi-ai')
    const hasDefault = mine.some((row) => row.entry_id === 'agent-default-model')
    if (hasModels && hasDefault) return '已配置'
    if (hasModels || hasDefault) return '部分配置'
    return '未配置'
  }
  return device.device_name
}

function desktopAfter(entry: ResolvedItem, request: DeliveryRequest): string {
  if (entry.item.kind === 'plugin') {
    if (request.action === 'uninstall') return '未安装'
    return entry.desktopVersion === null
      ? '未知版本'
      : `${entry.plugin?.packageName ?? ''}@${entry.desktopVersion.version}`
  }
  if (entry.item.kind === 'models') {
    const name = entry.preset?.name ?? null
    return name === null ? '已配置（系统预设）' : `已配置（预设 ${name}）`
  }
  return entry.runtime?.version ?? '未知版本'
}

function needsRestartForDesktop(entry: ResolvedItem): boolean {
  if (entry.item.kind === 'plugin') return entry.plugin?.needsRestart ?? true
  return true
}

/** 桌面 models 写目标时要读的现有片段（执行侧合并用） */
export function existingDesktopFragments(
  db: BaseDeps['db'],
  scope: ScopeKey,
): { entryId: string; mode: string; configJson: string; note: string }[] {
  return listConfigFragments(db)
    .filter(
      (row) =>
        row.scope === scope.scope &&
        row.role === scope.role &&
        (row.user_id ?? null) === (scope.userId ?? null),
    )
    .map((row) => ({ entryId: row.entry_id, mode: row.mode, configJson: row.config_json, note: row.note }))
}

/** 交给 rollouts 的请求体（实例侧每个内容项一个） */
export function rolloutRequestFor(
  plan: DeliveryPlan,
  entry: ResolvedItem,
  userIds: number[],
): RolloutRequestLike {
  const targets = { userIds }
  if (entry.item.kind === 'plugin') {
    if (entry.plugin === null) throw new HubError('INTERNAL', '插件内容项缺少插件引用')
    return {
      kind: 'plugin',
      action: plan.request.action,
      pluginId: entry.plugin.id,
      ...(entry.item.versionId === undefined ? {} : { versionId: entry.item.versionId }),
      targets,
      strategy: plan.strategy,
    }
  }
  if (entry.item.kind === 'models') {
    return {
      kind: 'models',
      ...(entry.item.presetId === undefined ? {} : { presetId: entry.item.presetId }),
      targets,
      strategy: plan.strategy,
    }
  }
  if (entry.runtime === null) throw new HubError('INTERNAL', 'DSH 版本内容项缺少版本引用')
  return { kind: 'runtime', runtimeId: entry.runtime.id, targets, strategy: plan.strategy }
}
