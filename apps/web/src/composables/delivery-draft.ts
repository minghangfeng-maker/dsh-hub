import { DELIVERY_MAX_ITEMS } from '@dsh-hub/shared'
import type {
  AdminPluginRow,
  DeliveryAction,
  DeliveryItem,
  DeliveryPlatform,
  DeliveryPreviewResponse,
  DeliveryRequest,
  DeliveryTargets,
  PluginInstallStat,
  Role,
  Strategy,
  UserStatus,
} from '@dsh-hub/shared'

/**
 * 统一下发向导的草稿与请求体组装（docs/21，契约 `packages/shared/src/api/delivery.ts`）。
 *
 * 纯逻辑放这里（步骤门控 + 平台/内容/动作的联动禁用 + URL 预填 + 请求体组装 + 预览分组），
 * 页面只负责渲染与调用，这样上面这些规则可以直接单测（`test/delivery-draft.test.ts`）。
 *
 * 与旧向导（`composables/rollout-draft.ts`）的关系：旧草稿是「一个 kind + 一个动作」，
 * 新草稿是「若干平台 × 若干内容项」，旧文件仅供兼容逻辑使用（模型页也走统一向导）。
 */

/** 平台选择的两种写法：管理台页面的「云端 / 桌面」与实际下发平台「实例 / 桌面端」的映射。 */
export type DeliveryPlatformChoice = 'cloud' | 'desktop'

/**
 * 从模型页 / 模型概览的「下发」入口进入统一向导：内容固定为「模型与 API 配置」，
 * 平台**只预选来源页面当前的那个**（docs/22 §1.3：从任一页带平台进来只预选那个平台）。
 *
 * 云端 → `instance`；桌面 → `desktop`。
 */
export function modelDeliveryLocation(platform: DeliveryPlatformChoice = 'cloud'): {
  path: string
  query: Record<string, string>
} {
  return {
    path: '/admin/rollouts',
    query: { platforms: platform === 'desktop' ? 'desktop' : 'instance', items: 'models' },
  }
}

/** 云端（默认）的模型下发位置；不区分平台的调用点用它。 */
export const MODEL_DELIVERY_LOCATION = modelDeliveryLocation('cloud')

/** 向导的步骤下标（含被跳过的策略步，见 {@link visibleSteps}）：0 平台与内容 / 1 动作与目标 / 2 策略 / 3 预览。 */
export type DeliveryStep = 0 | 1 | 2 | 3

export type DeliveryItemKind = DeliveryItem['kind']

export interface PluginItemDraft {
  kind: 'plugin'
  pluginId: number | null
  /** 云端版本；null = 云端最新版本 */
  versionId: number | null
  /** 桌面版本（docs/22 §2.2）；null = 桌面最新版本 */
  desktopVersionId: number | null
}

export interface ModelsItemDraft {
  kind: 'models'
  /** null = 系统预设 */
  presetId: number | null
}

export interface RuntimeItemDraft {
  kind: 'runtime'
  runtimeId: number | null
}

export type DeliveryItemDraft = PluginItemDraft | ModelsItemDraft | RuntimeItemDraft

/**
 * 契约里的四种目标 + 「条件筛选」（前端先解析成明确的用户清单，见 {@link buildDeliveryTargets}）
 * + `none`（还没有选：**卸载**这类动作默认不预选「全部」，由管理员明确点一个目标）。
 */
export type DeliveryTargetMode = 'all' | 'users' | 'role' | 'installed' | 'filter' | 'none'

/**
 * 条件筛选（旧向导的高级选项）：契约的 `targets` 没有 filter 分支，所以这里在**提交前**把条件
 * 解析成明确的 `userIds`（提交那一刻落成清单，之后新装的人不会被追加 —— 与「已安装」同一语义）。
 */
export interface DeliveryFilter {
  status?: UserStatus
  /** 当前 DSH 版本（按用户行里的 `instance.runtimeVersion` 比） */
  dshVersion?: string
  /** 当前模型预设 id */
  presetId?: number
}

export interface DeliveryDraft {
  platforms: DeliveryPlatform[]
  items: DeliveryItemDraft[]
  action: DeliveryAction
  targetMode: DeliveryTargetMode
  userIds: number[]
  role: Role
  /** 只在 `targetMode === 'installed'` 时有意义 */
  outdatedOnly: boolean
  filter: DeliveryFilter
  strategy: Strategy
}

export const DEFAULT_DELIVERY_STRATEGY: Strategy = {
  concurrency: 3,
  canary: 1,
  maxFailureRatio: 0.2,
  restart: 'now',
}

export const DELIVERY_ACTION_TEXT: Record<DeliveryAction, string> = {
  install: '安装',
  upgrade: '升级',
  uninstall: '卸载',
  'apply-config': '仅应用配置',
}

export const DELIVERY_PLATFORM_TEXT: Record<DeliveryPlatform, string> = {
  instance: '实例',
  desktop: '桌面端',
}

export function createDeliveryDraft(partial: Partial<DeliveryDraft> = {}): DeliveryDraft {
  return {
    platforms: ['instance'],
    items: [],
    action: 'install',
    targetMode: 'all',
    userIds: [],
    role: 'user',
    outdatedOnly: false,
    filter: {},
    strategy: { ...DEFAULT_DELIVERY_STRATEGY },
    ...partial,
  }
}

// ── 内容项 ──────────────────────────────────────────────────────────────────

export function itemKinds(items: readonly DeliveryItemDraft[]): Set<DeliveryItemKind> {
  return new Set(items.map((item) => item.kind))
}

/** 平台与内容的联动：DSH 版本只对实例有效（契约为准，见 `DeliveryRequestSchema.superRefine`） */
export function runtimeAvailable(platforms: readonly DeliveryPlatform[]): boolean {
  return platforms.includes('instance')
}

/** 同一个插件只应出现一次（UI 里也拦，但校验要独立成立） */
export function duplicatePluginIds(items: readonly DeliveryItemDraft[]): number[] {
  const seen = new Set<number>()
  const duplicated = new Set<number>()
  for (const item of items) {
    if (item.kind !== 'plugin' || item.pluginId === null) continue
    if (seen.has(item.pluginId)) duplicated.add(item.pluginId)
    seen.add(item.pluginId)
  }
  return [...duplicated]
}

export function createPluginItem(
  pluginId: number | null = null,
  versionId: number | null = null,
  desktopVersionId: number | null = null,
): PluginItemDraft {
  return { kind: 'plugin', pluginId, versionId, desktopVersionId }
}

// ── 两套插件库（docs/22 §2：cloud / desktop 各一套，互不打架） ───────────────

/**
 * 一个插件在「两套库」里的合并视图：统一下发向导第 1 步用它渲染两个版本下拉。
 * 某个平台为 `null` = 该插件不在这个平台的库里（预览里这一侧整项跳过）。
 */
export interface DeliveryPluginView {
  id: number
  packageName: string
  displayName: string
  isBundle: boolean
  latestVersion: string | null
  /** 两个平台版本的并集（标签与 `itemLabel` 用） */
  versions: { id: number; version: string }[]
  cloud: AdminPluginRow | null
  desktop: AdminPluginRow | null
}

/** 按插件 id 合并两个平台的库：云端的顺序在前，只在桌面的追加在后面 */
export function mergePluginLibraries(
  cloud: readonly AdminPluginRow[],
  desktop: readonly AdminPluginRow[],
): DeliveryPluginView[] {
  const byId = new Map<number, DeliveryPluginView>()
  const add = (row: AdminPluginRow, platform: 'cloud' | 'desktop'): void => {
    const existing = byId.get(row.id)
    if (existing) {
      existing[platform === 'desktop' ? 'desktop' : 'cloud'] = row
      existing.versions = [
        ...new Map([...existing.versions, ...row.versions].map((version) => [version.id, version])).values(),
      ].map((version) => ({ id: version.id, version: version.version }))
      return
    }
    byId.set(row.id, {
      id: row.id,
      packageName: row.packageName,
      displayName: row.displayName,
      isBundle: row.isBundle,
      latestVersion: row.latestVersion,
      versions: row.versions.map((version) => ({ id: version.id, version: version.version })),
      cloud: platform === 'cloud' ? row : null,
      desktop: platform === 'desktop' ? row : null,
    })
  }
  for (const row of cloud) add(row, 'cloud')
  for (const row of desktop) add(row, 'desktop')
  return [...byId.values()]
}

/** 这个插件能不能在某平台下发（不在库 / hidden 都不行；docs/22 §2.1 + 裁决 #17） */
export function pluginAvailableOn(view: DeliveryPluginView, platform: DeliveryPlatform): boolean {
  const row = platform === 'desktop' ? view.desktop : view.cloud
  return row !== null && row.policy !== 'hidden'
}

// ── 动作与内容的联动 ────────────────────────────────────────────────────────

/**
 * 哪些动作对当前内容适用（按所选内容自动禁用不适用项）：
 * - `apply-config` 只对 `models` 有意义（契约：混了别的内容项就是 400）；
 * - `uninstall` 只对插件（模型配置不能卸载、DSH 版本没有卸载）；
 * - 有 `runtime` 时只能「升级」（DSH 版本本身只有升级一种动作）。
 */
export function actionAvailability(kinds: ReadonlySet<DeliveryItemKind>): Record<DeliveryAction, boolean> {
  const hasPlugin = kinds.has('plugin')
  const hasModels = kinds.has('models')
  const hasRuntime = kinds.has('runtime')
  return {
    install: !hasRuntime,
    upgrade: true,
    uninstall: hasPlugin && !hasModels && !hasRuntime,
    'apply-config': hasModels && !hasPlugin && !hasRuntime,
  }
}

/** 动作被禁用时的一句话原因（放在单选按钮的 title 上，不做常驻小字） */
export function actionDisabledReason(action: DeliveryAction, kinds: ReadonlySet<DeliveryItemKind>): string {
  switch (action) {
    case 'install':
      return 'DSH 版本只有升级'
    case 'uninstall':
      if (kinds.has('models')) return '模型与 API 配置不能卸载'
      if (kinds.has('runtime')) return 'DSH 版本只有升级'
      return '这里没有可卸载的插件'
    case 'apply-config':
      return '「仅应用配置」只能用于模型与 API 配置'
    default:
      return ''
  }
}

/** 内容变化后把动作收敛到一个合法值（用户仍可以在可用项里改） */
export function defaultActionFor(kinds: ReadonlySet<DeliveryItemKind>): DeliveryAction {
  if (kinds.has('runtime')) return 'upgrade'
  if (kinds.size === 1 && kinds.has('models')) return 'apply-config'
  return 'install'
}

export function normalizeAction(draft: DeliveryDraft): DeliveryAction {
  const availability = actionAvailability(itemKinds(draft.items))
  return availability[draft.action] ? draft.action : defaultActionFor(itemKinds(draft.items))
}

// ── 步骤门控 ────────────────────────────────────────────────────────────────

/** 只选桌面端时「策略」整步跳过（策略只影响实例侧） */
export function visibleSteps(platforms: readonly DeliveryPlatform[]): DeliveryStep[] {
  return platforms.includes('instance') ? [0, 1, 2, 3] : [0, 1, 3]
}

/** 第几步是「第几个显示的步骤」（`NSteps` 的 current 从 1 起） */
export function stepPosition(step: DeliveryStep, platforms: readonly DeliveryPlatform[]): number {
  return visibleSteps(platforms).indexOf(step) + 1
}

export function nextVisibleStep(step: DeliveryStep, platforms: readonly DeliveryPlatform[]): DeliveryStep {
  const steps = visibleSteps(platforms)
  const at = steps.indexOf(step)
  return steps[Math.min(at + 1, steps.length - 1)] ?? step
}

export function previousVisibleStep(step: DeliveryStep, platforms: readonly DeliveryPlatform[]): DeliveryStep {
  const steps = visibleSteps(platforms)
  const at = steps.indexOf(step)
  return steps[Math.max(at - 1, 0)] ?? step
}

export function isLastStep(step: DeliveryStep, platforms: readonly DeliveryPlatform[]): boolean {
  const steps = visibleSteps(platforms)
  return steps[steps.length - 1] === step
}

export const DELIVERY_STEP_TITLES: Record<DeliveryStep, string> = {
  0: '平台与内容',
  1: '动作与目标',
  2: '策略',
  3: '预览与确认',
}

export interface DeliveryStepValidationContext {
  /** 「条件筛选」解析出来的用户（页面按用户列表算好传进来） */
  matchedUserIds?: number[]
}

/** 某一步的校验错误（空数组 = 可以进入下一步）。 */
export function validateDeliveryStep(
  step: DeliveryStep,
  draft: DeliveryDraft,
  context: DeliveryStepValidationContext = {},
): string[] {
  const errors: string[] = []
  const kinds = itemKinds(draft.items)

  if (step === 0) {
    if (draft.platforms.length === 0) errors.push('至少选一个平台')
    if (draft.items.length === 0) errors.push('至少选一个内容项')
    if (draft.items.length > DELIVERY_MAX_ITEMS) errors.push(`一次最多 ${String(DELIVERY_MAX_ITEMS)} 个内容项`)
    if (draft.items.some((item) => item.kind === 'plugin' && item.pluginId === null)) {
      errors.push('插件内容项还没选插件')
    }
    if (duplicatePluginIds(draft.items).length > 0) errors.push('同一个插件只选一次')
    if (kinds.has('runtime') && !runtimeAvailable(draft.platforms)) {
      errors.push('DSH 版本只能下发给实例')
    }
    if (draft.items.some((item) => item.kind === 'runtime' && item.runtimeId === null)) {
      errors.push('请选择要下发的 DSH 版本')
    }
  }

  if (step === 1) {
    if (!actionAvailability(kinds)[draft.action]) errors.push(actionDisabledReason(draft.action, kinds))
    if (draft.targetMode === 'none') errors.push('请选择下发给谁')
    if (kinds.has('runtime') && draft.targetMode === 'installed') {
      errors.push('DSH 版本不支持「已安装用户」')
    }
    if (draft.targetMode === 'users' && draft.userIds.length === 0) errors.push('至少勾选一位用户')
    if (draft.targetMode === 'users' && draft.userIds.length > 500) errors.push('一次最多下发给 500 位用户')
    if (draft.targetMode === 'filter') {
      const filter = draft.filter
      const empty = filter.status === undefined && filter.dshVersion === undefined && filter.presetId === undefined
      const matched = (context.matchedUserIds ?? []).length
      if (empty) {
        errors.push('条件筛选至少设置一个条件')
      } else if (matched === 0) {
        errors.push('没有用户符合这些条件')
      } else if (matched > 500) {
        // 契约的 users 目标最多 500 人：条件筛选是在前端解析成明确的用户清单的
        errors.push('一次最多下发给 500 位用户，请收窄条件')
      }
    }
  }

  if (step === 2 && draft.platforms.includes('instance')) {
    if (draft.strategy.concurrency < 1 || draft.strategy.concurrency > 8) errors.push('并发数需要在 1–8 之间')
    if (draft.strategy.canary < 0 || draft.strategy.canary > 5) errors.push('金丝雀数量需要在 0–5 之间')
    if (draft.strategy.maxFailureRatio < 0 || draft.strategy.maxFailureRatio > 1) {
      errors.push('失败阈值需要在 0–1 之间')
    }
  }

  return errors
}

// ── 请求体 ──────────────────────────────────────────────────────────────────

/** 草稿 → `DeliveryItem[]`（`uninstall` 忽略 `versionId`；`presetId` 省略 = 系统预设） */
export function buildDeliveryItems(draft: DeliveryDraft): DeliveryItem[] {
  return draft.items.map((item) => {
    if (item.kind === 'models') {
      return item.presetId === null ? { kind: 'models' } : { kind: 'models', presetId: item.presetId }
    }
    if (item.kind === 'runtime') return { kind: 'runtime', runtimeId: item.runtimeId ?? 0 }
    const result: DeliveryItem = { kind: 'plugin', pluginId: item.pluginId ?? 0 }
    if (draft.action !== 'uninstall') {
      // 只带所选平台的版本：云端版本给桌面端没意义，反之亦然（各自缺省 = 该平台最新）
      if (draft.platforms.includes('instance') && item.versionId !== null) result.versionId = item.versionId
      if (draft.platforms.includes('desktop') && item.desktopVersionId !== null) {
        result.desktopVersionId = item.desktopVersionId
      }
    }
    return result
  })
}

/** 草稿 → `DeliveryTargets`（「条件筛选」在这一步变成明确的用户清单） */
export function buildDeliveryTargets(
  draft: DeliveryDraft,
  context: DeliveryStepValidationContext = {},
): DeliveryTargets {
  // 「还没选目标」，例如卸载的默认状态：绝不能悄悄落成「全部」
  if (draft.targetMode === 'none') throw new Error('还没有选择下发给谁')
  if (draft.targetMode === 'all') return { mode: 'all' }
  if (draft.targetMode === 'role') return { mode: 'role', role: draft.role }
  if (draft.targetMode === 'installed') return { mode: 'installed', outdatedOnly: draft.outdatedOnly }
  if (draft.targetMode === 'filter') return { mode: 'users', userIds: [...(context.matchedUserIds ?? [])] }
  return { mode: 'users', userIds: [...draft.userIds] }
}

/** 草稿 → 请求体（预览与提交同体） */
export function buildDeliveryRequest(
  draft: DeliveryDraft,
  context: DeliveryStepValidationContext = {},
): DeliveryRequest {
  const request: DeliveryRequest = {
    platforms: [...draft.platforms],
    items: buildDeliveryItems(draft),
    action: draft.action,
    targets: buildDeliveryTargets(draft, context),
  }
  // 只影响实例侧；只选桌面端时不带（后端会忽略，但少一个字段更清楚）
  if (draft.platforms.includes('instance')) request.strategy = { ...draft.strategy }
  return request
}

// ── 文案 ────────────────────────────────────────────────────────────────────

export interface DeliveryLabelContext {
  plugins?: readonly {
    id: number
    displayName: string
    packageName: string
    latestVersion: string | null
    versions: readonly { id: number; version: string }[]
  }[]
  runtimes?: readonly { id: number; dshVersion: string }[]
  presets?: readonly { id: number; name: string }[]
}

/** 一个内容项的显示名（预览表的 `itemLabel` 与步骤摘要共用同一套写法） */
export function itemLabel(item: DeliveryItemDraft, context: DeliveryLabelContext = {}): string {
  if (item.kind === 'models') {
    const preset = (context.presets ?? []).find((row) => row.id === item.presetId)
    return preset ? `模型与 API 配置（${preset.name}）` : '模型与 API 配置'
  }
  if (item.kind === 'runtime') {
    const runtime = (context.runtimes ?? []).find((row) => row.id === item.runtimeId)
    return runtime ? `DSH ${runtime.dshVersion}` : 'DSH 版本'
  }
  const plugin = (context.plugins ?? []).find((row) => row.id === item.pluginId)
  if (!plugin) return '插件'
  const version =
    (item.versionId === null ? null : plugin.versions.find((row) => row.id === item.versionId)?.version) ??
    plugin.latestVersion
  return version === null ? plugin.displayName : `${plugin.displayName} ${version}`
}

/** 内容项摘要（第 1 步底部的「当前内容」一行） */
export function describeDeliveryItems(draft: DeliveryDraft, context: DeliveryLabelContext = {}): string {
  if (draft.items.length === 0) return '还没选内容'
  const labels = draft.items.map((item) => itemLabel(item, context))
  if (labels.length <= 3) return labels.join('、')
  return `${labels.slice(0, 3).join('、')} 等 ${String(labels.length)} 项`
}

/** 目标摘要（第 2 步底部与预览页头部） */
export function describeDeliveryTargets(
  draft: DeliveryDraft,
  userName: (id: number) => string,
  context: DeliveryStepValidationContext = {},
): string {
  if (draft.targetMode === 'none') return '还没选'
  if (draft.targetMode === 'all') return '全部'
  if (draft.targetMode === 'role') return draft.role === 'admin' ? '角色：管理员' : '角色：普通用户'
  if (draft.targetMode === 'installed') {
    return draft.outdatedOnly ? '已安装用户（只选版本较旧的）' : '已安装用户'
  }
  if (draft.targetMode === 'filter') {
    const parts: string[] = []
    if (draft.filter.status) parts.push(`状态=${statusText(draft.filter.status)}`)
    if (draft.filter.dshVersion) parts.push(`DSH=${draft.filter.dshVersion}`)
    if (draft.filter.presetId !== undefined) parts.push(`预设=#${String(draft.filter.presetId)}`)
    const matched = (context.matchedUserIds ?? []).length
    return `条件：${parts.join('，')}（匹配 ${String(matched)} 人）`
  }
  const names = draft.userIds.map(userName)
  if (names.length <= 3) return names.join('、')
  return `${names.slice(0, 3).join('、')} 等 ${String(names.length)} 位用户`
}

export function statusText(status: UserStatus): string {
  return status === 'active' ? '正常' : status === 'pending' ? '待审批' : '已停用'
}

// ── 「已安装」的人数提示（第 2 步） ─────────────────────────────────────────

/**
 * 每个插件在所选平台上的安装人数：`实例 7 人 · 桌面 4 台`（只显示选中的平台）。
 * `outdated` 用「其中版本较旧」单独一句，避免与总数混在一行。
 */
export function installCountText(stat: PluginInstallStat, platforms: readonly DeliveryPlatform[]): string {
  const parts: string[] = []
  if (platforms.includes('instance')) parts.push(`实例 ${String(stat.instance.users)} 人`)
  if (platforms.includes('desktop')) parts.push(`桌面 ${String(stat.desktop.devices)} 台`)
  return parts.join(' · ')
}

export function installOutdatedText(stat: PluginInstallStat, platforms: readonly DeliveryPlatform[]): string {
  const parts: string[] = []
  if (platforms.includes('instance') && stat.instance.outdated > 0) {
    parts.push(`实例 ${String(stat.instance.outdated)} 人`)
  }
  if (platforms.includes('desktop') && stat.desktop.outdated > 0) {
    parts.push(`桌面 ${String(stat.desktop.outdated)} 台`)
  }
  return parts.join(' · ')
}

// ── 预览 ────────────────────────────────────────────────────────────────────

export interface DeliveryPreviewGroups {
  instance: DeliveryPreviewResponse['rows']
  desktop: DeliveryPreviewResponse['rows']
}

/** 预览按平台分组（实例一张表、桌面一张表；桌面一台设备一行） */
export function groupPreviewRows(rows: DeliveryPreviewResponse['rows']): DeliveryPreviewGroups {
  return {
    instance: rows.filter((row) => row.platform === 'instance'),
    desktop: rows.filter((row) => row.platform === 'desktop'),
  }
}

export function isSkippedRow(row: DeliveryPreviewResponse['rows'][number]): boolean {
  return row.skipReason !== null
}

/** 预览顶部的一句话摘要（只写选中的平台） */
export function previewSummaryText(
  summary: DeliveryPreviewResponse['summary'],
  platforms: readonly DeliveryPlatform[],
): string {
  const parts: string[] = []
  if (platforms.includes('instance')) {
    const row = summary.instance
    parts.push(`实例 ${String(row.willRun)} 项会执行${row.skipped > 0 ? `、${String(row.skipped)} 项跳过` : ''}（${String(row.users)} 人）`)
  }
  if (platforms.includes('desktop')) {
    const row = summary.desktop
    parts.push(
      `桌面端 ${String(row.willRun)} 项会执行${row.skipped > 0 ? `、${String(row.skipped)} 项跳过` : ''}（${String(row.devices)} 台设备 / ${String(row.users)} 人）`,
    )
  }
  return parts.join(' · ')
}

// ── URL 预填（契约注释里的 `DELIVERY_PREFILL_QUERY_KEYS`） ──────────────────

export interface DeliveryPrefill {
  draft: DeliveryDraft
  /** 是否有任何被认出来的预填（页面据此显示「已按来源页面预填」） */
  prefilled: boolean
  /** 被忽略的键（非法值忽略掉、回落到默认；单测用） */
  ignored: string[]
}

const PLATFORMS: readonly string[] = ['instance', 'desktop']
const ACTIONS: readonly string[] = ['install', 'upgrade', 'uninstall', 'apply-config']

function readString(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

function readPositiveInt(raw: string): number | null {
  if (!/^\d+$/u.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * `/admin/rollouts?platforms=instance,desktop&action=upgrade&targets=installed&items=plugin:12,plugin:15:345`
 * （`/admin/rollouts/new` 是保留查询串的重定向，旧按钮不用改）
 *
 * 也认旧链接的写法（`?kind=plugin&pluginId=1&versionId=11`、`?kind=runtime&runtimeId=2`、
 * `?kind=models&userIds=1,2`）：插件库 / 用户详情 / DSH 版本页上的「下发」按钮现在还按旧格式跳进来，
 * 不认它们等于把这些入口弄断。
 */
export function parseDeliveryPrefill(query: Record<string, unknown>): DeliveryPrefill {
  const draft = createDeliveryDraft()
  const ignored: string[] = []
  let prefilled = false

  const platformsRaw = readString(query['platforms'])
  if (platformsRaw.length > 0) {
    const parsed = platformsRaw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    const valid = parsed.filter((item) => PLATFORMS.includes(item)) as DeliveryPlatform[]
    if (valid.length === 0 || valid.length !== parsed.length) ignored.push('platforms')
    if (valid.length > 0) {
      draft.platforms = [...new Set(valid)]
      prefilled = true
    }
  }

  const actionRaw = readString(query['action'])
  if (actionRaw.length > 0) {
    if (ACTIONS.includes(actionRaw)) {
      draft.action = actionRaw as DeliveryAction
      prefilled = true
    } else ignored.push('action')
  }

  const targetsRaw = readString(query['targets'])
  if (targetsRaw.length > 0) {
    if (targetsRaw === 'all') {
      draft.targetMode = 'all'
      prefilled = true
    } else if (targetsRaw === 'installed' || targetsRaw === 'installed-outdated') {
      draft.targetMode = 'installed'
      draft.outdatedOnly = targetsRaw === 'installed-outdated'
      prefilled = true
    } else ignored.push('targets')
  }

  const itemsRaw = readString(query['items'])
  if (itemsRaw.length > 0) {
    const items: DeliveryItemDraft[] = []
    let invalid = false
    for (const spec of itemsRaw.split(',').map((item) => item.trim()).filter(Boolean)) {
      const [kind, ...rest] = spec.split(':')
      if (kind === 'plugin' && rest.length >= 1 && rest.length <= 2) {
        const pluginId = readPositiveInt(rest[0] ?? '')
        const versionId = rest.length === 2 ? readPositiveInt(rest[1] ?? '') : null
        if (pluginId === null || (rest.length === 2 && versionId === null)) {
          invalid = true
          continue
        }
        items.push({ kind: 'plugin', pluginId, versionId, desktopVersionId: null })
      } else if (kind === 'models' && rest.length <= 1) {
        const presetId = rest.length === 1 ? readPositiveInt(rest[0] ?? '') : null
        if (rest.length === 1 && presetId === null) {
          invalid = true
          continue
        }
        items.push({ kind: 'models', presetId })
      } else if (kind === 'runtime' && rest.length === 1) {
        const runtimeId = readPositiveInt(rest[0] ?? '')
        if (runtimeId === null) {
          invalid = true
          continue
        }
        items.push({ kind: 'runtime', runtimeId })
      } else {
        invalid = true
      }
    }
    if (invalid) ignored.push('items')
    if (items.length > 0) {
      draft.items = items.slice(0, DELIVERY_MAX_ITEMS)
      prefilled = true
    }
  }

  // ── 旧链接（WP28b 之前各页面用的查询串） ──
  const legacyKind = readString(query['kind'])
  if (itemsRaw.length === 0 && ['plugin', 'models', 'runtime'].includes(legacyKind)) {
    const pluginId = readPositiveInt(readString(query['pluginId']))
    const versionId = readPositiveInt(readString(query['versionId']))
    const runtimeId = readPositiveInt(readString(query['runtimeId']))
    const presetId = readPositiveInt(readString(query['presetId']))
    if (legacyKind === 'plugin' && pluginId !== null) {
      draft.items = [createPluginItem(pluginId, versionId)]
      prefilled = true
    } else if (legacyKind === 'models') {
      draft.items = [{ kind: 'models', presetId }]
      prefilled = true
    } else if (legacyKind === 'runtime' && runtimeId !== null) {
      draft.items = [{ kind: 'runtime', runtimeId }]
      draft.platforms = ['instance']
      draft.action = 'upgrade'
      prefilled = true
    } else if (legacyKind === 'plugin' || legacyKind === 'runtime') {
      ignored.push('kind')
    }
  }

  const userIdsRaw = readString(query['userIds'])
  if (userIdsRaw.length > 0 && draft.targetMode === 'all') {
    const userIds = userIdsRaw
      .split(',')
      .map((item) => readPositiveInt(item.trim()))
      .filter((item): item is number => item !== null)
    if (userIds.length > 0) {
      draft.targetMode = 'users'
      draft.userIds = userIds
      prefilled = true
    } else ignored.push('userIds')
  }

  // 动作与内容可能会打架（例如预填了 runtime 却写着 install）：收敛到合法值
  draft.action = normalizeAction(draft)
  // 卸载没有默认目标：来源页面只给 action + items，不能让「全部」被悄悄选中（编排者约定）
  if (draft.action === 'uninstall' && targetsRaw.length === 0) {
    draft.targetMode = 'none'
  }
  return { draft, prefilled, ignored }
}

// ── 条件筛选：把用户列表筛成明确的 userIds ─────────────────────────────────

export interface FilterableUser {
  id: number
  status: UserStatus
  instance: { runtimeVersion: string | null }
  modelPresetId: number | null
}

/** 「条件筛选」是在前端解析的（契约没有 filter 分支），所以匹配规则只在这里维护一份 */
export function matchDeliveryUsers(
  users: readonly FilterableUser[],
  filter: DeliveryFilter,
): FilterableUser[] {
  return users.filter((user) => {
    if (filter.status !== undefined && user.status !== filter.status) return false
    if (filter.dshVersion !== undefined && user.instance.runtimeVersion !== filter.dshVersion) return false
    if (filter.presetId !== undefined && user.modelPresetId !== filter.presetId) return false
    return true
  })
}

// ── WP57：五步下发流程（内容 → 端 → 配置 → 下发 → 完成） ─────────────────────
//
// 一次下发 = **一类内容 × 一个端**。旧向导把「平台多选 + 三类内容 + 动作」放在同一屏里，
// 管理员要同时想清楚四件事；新流程每一步只回答一个问题，两个端都要发时在「完成」页点
// 「再下发到另一端」（内容与动作带过去，回到「配置」——两个端的模型配置 / 插件版本本来就是两套）。
// 请求体仍是契约的 `DeliveryRequest`（`platforms` 只有一个元素、`items` 只有一类），后端不用改。

export type FlowStep = 'content' | 'platform' | 'config' | 'deliver' | 'done'

export const FLOW_STEPS: readonly FlowStep[] = ['content', 'platform', 'config', 'deliver', 'done']

export const FLOW_STEP_TITLES: Record<FlowStep, string> = {
  content: '内容',
  platform: '端',
  config: '配置',
  deliver: '下发',
  done: '完成',
}

/** 第一步的三类内容（就是 `DeliveryItem['kind']`） */
export type FlowContent = DeliveryItemKind

export const FLOW_CONTENT_TEXT: Record<FlowContent, string> = {
  models: '模型配置',
  plugin: '插件',
  runtime: 'DSH 版本',
}

/** 「端」的显示名（管理台各页切换也叫「云端 | 桌面端」） */
export const FLOW_PLATFORM_TEXT: Record<DeliveryPlatform, string> = {
  instance: '云端',
  desktop: '桌面端',
}

/** 草稿当前的内容类别（没有内容项 = 还没选；一次只有一类，取第一项） */
export function flowContentOf(draft: DeliveryDraft): FlowContent | null {
  return draft.items[0]?.kind ?? null
}

/** 草稿当前的端（一次只有一个；旧草稿两个都有时取第一个） */
export function flowPlatformOf(draft: DeliveryDraft): DeliveryPlatform | null {
  return draft.platforms[0] ?? null
}

/** 某类内容能不能发到某个端；不能时给一句原因（放在卡片上） */
export function flowPlatformBlockedReason(content: FlowContent | null, platform: DeliveryPlatform): string | null {
  if (content === 'runtime' && platform === 'desktop') return '桌面端的版本在「DSH 版本 · 桌面端」发布安装包'
  return null
}

/**
 * 第 1 步选内容：换一类内容就重置内容项与动作（同一类再点一次不动，保留已经配好的东西）。
 * DSH 版本只能发云端，选它时端直接落成云端。
 */
export function chooseFlowContent(draft: DeliveryDraft, content: FlowContent): DeliveryDraft {
  if (flowContentOf(draft) === content) return draft
  const items: DeliveryItemDraft[] =
    content === 'models'
      ? [{ kind: 'models', presetId: null }]
      : content === 'runtime'
        ? [{ kind: 'runtime', runtimeId: null }]
        : []
  const kinds = new Set<DeliveryItemKind>([content])
  return {
    ...draft,
    items,
    platforms: content === 'runtime' ? ['instance'] : draft.platforms.slice(0, 1),
    action: defaultActionFor(kinds),
    targetMode: 'all',
    outdatedOnly: false,
  }
}

/**
 * 插件的「选中」：第 1 步选了插件但还一个都没挑时，草稿里没有内容项，
 * 这时 `flowContentOf` 认不出来 —— 页面另外记一份所选类别，用这个函数合并。
 */
export function effectiveFlowContent(draft: DeliveryDraft, chosen: FlowContent | null): FlowContent | null {
  return flowContentOf(draft) ?? chosen
}

/** 第 2 步选端：单选；换端时插件的版本清空（两个端的版本是两套，缺省 = 该端最新） */
export function chooseFlowPlatform(draft: DeliveryDraft, platform: DeliveryPlatform): DeliveryDraft {
  if (draft.platforms.length === 1 && draft.platforms[0] === platform) return draft
  return {
    ...draft,
    platforms: [platform],
    items: draft.items.map((item) =>
      item.kind === 'plugin'
        ? { ...item, versionId: platform === 'instance' ? item.versionId : null, desktopVersionId: platform === 'desktop' ? item.desktopVersionId : null }
        : item,
    ),
  }
}

/** 插件动作切换的联动：升级默认发给「已安装且版本较旧」的人，卸载没有默认目标 */
export function chooseFlowAction(draft: DeliveryDraft, action: DeliveryAction): DeliveryDraft {
  if (draft.action === action) return draft
  if (action === 'upgrade') return { ...draft, action, targetMode: 'installed', outdatedOnly: true }
  if (action === 'uninstall') return { ...draft, action, targetMode: 'none', outdatedOnly: false }
  return { ...draft, action, targetMode: draft.targetMode === 'none' ? 'all' : draft.targetMode, outdatedOnly: false }
}

export interface FlowValidationContext extends DeliveryStepValidationContext {
  /** 第 1 步选了哪一类（插件还没挑具体插件时草稿里没有内容项） */
  content?: FlowContent | null
  /** 模型配置那一步：可下发的模型数（0 = 不能继续） */
  deliverableModels?: number
}

/** 某一步的校验（空数组 = 可以往下走）；规则沿用旧向导，只是拆到了新的步骤里 */
export function validateFlowStep(step: FlowStep, draft: DeliveryDraft, context: FlowValidationContext = {}): string[] {
  const content = effectiveFlowContent(draft, context.content ?? null)
  if (step === 'content') return content === null ? ['先选要下发的内容'] : []
  if (step === 'platform') {
    const platform = flowPlatformOf(draft)
    if (platform === null || draft.platforms.length !== 1) return ['选一个端']
    const blocked = flowPlatformBlockedReason(content, platform)
    return blocked ? [blocked] : []
  }
  if (step === 'config') {
    const errors: string[] = []
    if (content === 'models' && (context.deliverableModels ?? 1) === 0) errors.push('至少勾选一个可下发的模型')
    if (content === 'plugin' && draft.items.length === 0) errors.push('至少选一个插件')
    if (draft.items.length > DELIVERY_MAX_ITEMS) errors.push(`一次最多 ${String(DELIVERY_MAX_ITEMS)} 个插件`)
    if (duplicatePluginIds(draft.items).length > 0) errors.push('同一个插件只选一次')
    if (draft.items.some((item) => item.kind === 'runtime' && item.runtimeId === null)) {
      errors.push('选一个要升级到的 DSH 版本')
    }
    const kinds = itemKinds(draft.items)
    if (kinds.size > 0 && !actionAvailability(kinds)[draft.action]) errors.push(actionDisabledReason(draft.action, kinds))
    return errors
  }
  if (step === 'deliver') {
    return [...validateDeliveryStep(1, draft, context), ...validateDeliveryStep(2, draft, context)]
  }
  return []
}

/**
 * URL 预填 → 五步流程：收敛成「一类 × 一个端」，并算出从哪一步开始。
 *
 * - 混了几类内容：只留第一类（`ignored` 里记 `items`）；
 * - 两个端都带了：留第一个，另一个记成 `otherPlatform`（完成页「再下发到另一端」直接用）；
 * - 起点：内容和端都有 → 配置；只有内容 → 选端；都没有 → 选内容。
 *   插件只带了动作没带插件（不会发生在现有入口上）也从「配置」开始。
 */
export interface FlowPrefill {
  draft: DeliveryDraft
  content: FlowContent | null
  start: FlowStep
  otherPlatform: DeliveryPlatform | null
  ignored: string[]
}

export function parseFlowPrefill(query: Record<string, unknown>): FlowPrefill {
  const base = parseDeliveryPrefill(query)
  const ignored = [...base.ignored]
  const draft: DeliveryDraft = { ...base.draft }
  const content = flowContentOf(draft)
  if (content !== null && draft.items.some((item) => item.kind !== content)) {
    draft.items = draft.items.filter((item) => item.kind === content)
    ignored.push('items')
  }
  const hasPlatform = readString(query['platforms']).length > 0 || content === 'runtime'
  let otherPlatform: DeliveryPlatform | null = null
  if (draft.platforms.length > 1) {
    otherPlatform = draft.platforms[1] ?? null
    draft.platforms = draft.platforms.slice(0, 1)
  }
  if (content === 'runtime') draft.platforms = ['instance']
  draft.action = normalizeAction(draft)
  const start: FlowStep = content === null ? 'content' : hasPlatform ? 'config' : 'platform'
  return { draft, content, start, otherPlatform, ignored }
}

/** 完成页「再下发到另一端」：内容与动作、目标照旧，端换成另一个，插件版本清空，回到配置 */
export function otherFlowPlatform(platform: DeliveryPlatform | null): DeliveryPlatform {
  return platform === 'desktop' ? 'instance' : 'desktop'
}
