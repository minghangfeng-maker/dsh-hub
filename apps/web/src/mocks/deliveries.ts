import {
  DeliveryRequestSchema,
  type DeliveryItem,
  type DeliveryPreviewResponse,
  type DeliveryPreviewRow,
  type DeliveryRequest,
  type DesktopPluginArtifact,
  type DeliverySkippedItem,
  type PluginInstallStat,
} from '@dsh-hub/shared'

import { ADMIN_PLUGINS, ADMIN_USERS, desktopPluginCatalog } from './admin'
import { createMockRolloutJob } from './jobs'
import { getMockState, type MockScenario } from './state'

/**
 * 统一下发的假后端（**仅开发环境**）：`POST /api/admin/deliveries/preview` 与 `POST /api/admin/deliveries`，
 * 外加向导第 2 步要用的人数（`GET /api/admin/plugins/install-stats`）与「有 / 缺桌面整包」的整包清单。
 *
 * 有状态：预览只读；提交会真的把 revision 往前推、按实例侧每个内容项建一条几秒跑完的假任务
 * （任务中心 / 任务详情能看到），并把「已安装」解析成明确的行 —— 与 docs/21 §2 的语义一致，
 * 页面在没有后端（WP28a 未合入）时也能走完整条链路。
 *
 * 场景（`?mock=`）：
 * | 场景 | 内容 |
 * |---|---|
 * | `delivery` | 正常：7 位用户（含待审批 / 已停用的跳过行）、5 台设备（其中一个用户两台）、插件 4 缺桌面整包 |
 * | `delivery-desktop-only` | 桌面端场景：实例侧没有任何安装记录（选中实例时预览是空组）、有一台已吊销设备 |
 * | `delivery-warnings` | 预览带 3 条警告（缺整包 / DSH 版本只对实例 / 已吊销设备不在目标里） |
 * | `delivery-truncated` | 行数被截断（`truncated: true`），执行仍按完整清单 |
 */

export const DELIVERY_SCENARIOS: readonly MockScenario[] = [
  'delivery',
  'delivery-desktop-only',
  'delivery-warnings',
  'delivery-truncated',
]

export function isDeliveryScenario(scenario: MockScenario): boolean {
  return DELIVERY_SCENARIOS.includes(scenario)
}

/** 视频渲染（id 4）故意没有整包：演示「缺桌面整包」与整项跳过 */
const PLUGIN_WITHOUT_ARTIFACT = 4

const MINUTE = 60_000
const NOW = Date.now()
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

// ── 种子：实例侧的安装记录 ─────────────────────────────────────────────────

/** pluginId → 装了它的用户与版本（`user_plugins` 期望状态 = 已安装） */
const INSTANCE_INSTALLED: Record<number, { userId: number; version: string }[]> = {
  1: [
    { userId: 1, version: '0.16.0' },
    { userId: 2, version: '0.15.0' },
    { userId: 3, version: '0.16.0' },
    { userId: 4, version: '0.15.0' },
    { userId: 5, version: '0.16.0' },
    { userId: 6, version: '0.16.0' },
    { userId: 7, version: '0.16.0' },
  ],
  2: [],
  3: [
    { userId: 1, version: '1.0.0' },
    { userId: 2, version: '1.0.0' },
    { userId: 4, version: '1.0.0' },
    { userId: 7, version: '1.0.0' },
  ],
  4: [
    { userId: 1, version: '0.3.2' },
    { userId: 2, version: '0.3.2' },
  ],
}

// ── 种子：桌面设备（一台设备一行；用户 1 有两台）────────────────────────────

interface SeedDevice {
  id: string
  userId: number
  name: string
  /** 这台设备上报的插件清单：pluginId → 版本 */
  plugins: Record<number, string>
  /** 已登录（渲染过 Hub 模型配置） */
  loggedIn: boolean
  revoked: boolean
  runtimeVersion: string | null
}

const SEED_DEVICES: SeedDevice[] = [
  {
    id: 'dv_00000000000000000000000000000001',
    userId: 1,
    name: '站长的 Windows 开发机',
    plugins: { 1: '0.16.0', 3: '1.0.0' },
    loggedIn: true,
    revoked: false,
    runtimeVersion: '0.2.1-rc.2',
  },
  {
    id: 'dv_00000000000000000000000000000002',
    userId: 2,
    name: '薄荷茶的 MacBook',
    plugins: { 1: '0.15.0' },
    loggedIn: true,
    revoked: false,
    runtimeVersion: '0.2.0',
  },
  {
    id: 'dv_00000000000000000000000000000003',
    userId: 4,
    name: '樱花饼的联想小新',
    plugins: { 1: '0.16.0' },
    loggedIn: true,
    revoked: false,
    runtimeVersion: '0.2.1-rc.2',
  },
  {
    id: 'dv_00000000000000000000000000000004',
    userId: 7,
    name: '小陈的第三台工作笔记本（出差用）',
    plugins: {},
    loggedIn: false,
    revoked: false,
    runtimeVersion: null,
  },
  {
    id: 'dv_00000000000000000000000000000005',
    userId: 1,
    name: '站长的 Mac mini',
    plugins: { 1: '0.16.0', 3: '1.0.0' },
    loggedIn: true,
    revoked: false,
    runtimeVersion: '0.2.1-rc.2',
  },
]

/** 运行中的 DSH 版本（`GET /api/admin/runtimes` 的假数据里也有这两个） */
const RUNTIME_VERSIONS: Record<number, string> = { 1: '0.2.0', 2: '0.2.1-rc.2' }

// ── 状态 ────────────────────────────────────────────────────────────────────

interface DeliveriesMockState {
  revision: number
  /** 最近一次提交（单测与走查用） */
  lastCreated: DeliveryRequest | null
}

let state: DeliveriesMockState = { revision: 41, lastCreated: null }

export function resetDeliveriesMock(): void {
  state = { revision: 41, lastCreated: null }
}

/** 当前桌面清单版本（提交后 +1；走查脚本可据此断言） */
export function deliveriesRevision(): number {
  return state.revision
}

export function lastDeliveryRequest(): DeliveryRequest | null {
  return state.lastCreated
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function apiError(code: string, status: number, message: string, details: Record<string, unknown> = {}): Response {
  return json({ error: { code, message, details } }, status)
}

function readJson(init?: RequestInit): Record<string, unknown> {
  const raw = init?.body
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function userOf(userId: number) {
  return ADMIN_USERS.find((user) => user.id === userId) ?? null
}

function pluginOf(pluginId: number) {
  return ADMIN_PLUGINS.find((plugin) => plugin.id === pluginId) ?? null
}

/** 版本号比较（只比数字段，`0.2.0-rc.2` 与 `0.2.0` 视为同段） */
function versionParts(version: string): number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

function isOlder(version: string, target: string): boolean {
  const left = versionParts(version)
  const right = versionParts(target)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b
  }
  return false
}

function desktopPluginOf(pluginId: number, scenario: MockScenario) {
  return desktopPluginCatalog(scenario).find((plugin) => plugin.id === pluginId) ?? null
}

/** 桌面整包（docs/22 §2：桌面版本必须带整包）；不在桌面插件库 = null */
function deviceArtifact(
  pluginId: number,
  scenario: MockScenario,
  versionId: number | null = null,
): DesktopPluginArtifact | null {
  if (pluginId === PLUGIN_WITHOUT_ARTIFACT) return null
  const plugin = desktopPluginOf(pluginId, scenario)
  const version =
    versionId === null
      ? plugin?.versions[0]
      : plugin?.versions.find((item) => item.id === versionId) ?? plugin?.versions[0]
  if (!plugin || !version) return null
  return {
    pluginId,
    packageName: plugin.packageName,
    versionId: version.id,
    version: version.version,
    fileName: `${plugin.packageName.replace(/^@[^/]+\//u, '')}-${version.version}-desktop.tgz`,
    bytes: 41_216 + pluginId * 1_024,
    sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2).slice(0, 64),
    uploadedAt: iso(-3 * 24 * 60 * MINUTE),
  }
}

/** 云上版本号（`versionId` 为空 = 最新） */
function targetVersionOf(pluginId: number, versionId: number | null): string | null {
  const plugin = pluginOf(pluginId)
  if (!plugin) return null
  if (versionId === null) return plugin.latestVersion
  return plugin.versions.find((version) => version.id === versionId)?.version ?? plugin.latestVersion
}

/** 桌面版本号（`desktopVersionId` 为空 = 桌面最新；不在桌面库 = null） */
function desktopVersionOf(
  pluginId: number,
  versionId: number | null,
  scenario: MockScenario,
): string | null {
  const plugin = desktopPluginOf(pluginId, scenario)
  if (!plugin) return null
  if (versionId === null) return plugin.latestVersion
  return plugin.versions.find((version) => version.id === versionId)?.version ?? plugin.latestVersion
}

function itemLabelOf(item: DeliveryItem, platform: 'instance' | 'desktop' = 'instance'): string {
  if (item.kind === 'models') return '模型与 API 配置'
  if (item.kind === 'runtime') return `DSH ${RUNTIME_VERSIONS[item.runtimeId] ?? '版本'}`
  const plugin = pluginOf(item.pluginId)
  const version =
    platform === 'desktop'
      ? desktopVersionOf(item.pluginId, item.desktopVersionId ?? null, getMockState().scenario)
      : targetVersionOf(item.pluginId, item.versionId ?? null)
  if (!plugin) return '插件'
  return version === null ? plugin.displayName : `${plugin.displayName} ${version}`
}

// ── 目标解析（「已安装」在这里落成明确的行）──────────────────────────────────

interface UserRow {
  userId: number
  username: string
  /** 这一行不会执行的原因（null = 会执行） */
  skipReason: string | null
}

function userSkipReason(userId: number): string | null {
  const user = userOf(userId)
  if (!user) return '用户不存在'
  if (user.status === 'pending') return '用户待审批'
  if (user.status === 'disabled') return '用户已停用'
  if (user.instance.status === 'absent') return '实例还没创建'
  return null
}

function devicesFor(scenario: MockScenario): SeedDevice[] {
  if (scenario === 'delivery-desktop-only') {
    // 桌面端场景：第 3 台已吊销（会作为跳过行出现），其余照常
    return SEED_DEVICES.map((device) =>
      device.id.endsWith('03') ? { ...device, revoked: true } : device,
    )
  }
  return SEED_DEVICES
}

function instanceUsersFor(
  request: DeliveryRequest,
  item: DeliveryItem,
  scenario: MockScenario,
): UserRow[] {
  const targets = request.targets
  if (targets.mode === 'users') {
    return targets.userIds.map((userId) => ({
      userId,
      username: userOf(userId)?.username ?? `user${String(userId)}`,
      skipReason: userSkipReason(userId),
    }))
  }
  if (targets.mode === 'role') {
    return ADMIN_USERS.filter((user) => user.role === targets.role).map((user) => ({
      userId: user.id,
      username: user.username,
      skipReason: userSkipReason(user.id),
    }))
  }
  if (targets.mode === 'installed') {
    // desktop-only 场景：实例侧没有任何安装记录（用来走「只选桌面端」那条路）
    if (scenario === 'delivery-desktop-only') return []
    if (item.kind === 'runtime') return []
    if (item.kind === 'models') {
      return ADMIN_USERS.filter((user) => user.modelPresetId !== null).map((user) => ({
        userId: user.id,
        username: user.username,
        skipReason: userSkipReason(user.id),
      }))
    }
    const target = targetVersionOf(item.pluginId, item.versionId ?? null)
    return (INSTANCE_INSTALLED[item.pluginId] ?? [])
      .filter((row) => {
        if (!targets.outdatedOnly) return true
        return target !== null && isOlder(row.version, target)
      })
      .map((row) => ({
        userId: row.userId,
        username: userOf(row.userId)?.username ?? `user${String(row.userId)}`,
        skipReason: userSkipReason(row.userId),
      }))
      .sort((left, right) => left.userId - right.userId)
  }
  // all
  return ADMIN_USERS.map((user) => ({
    userId: user.id,
    username: user.username,
    skipReason: userSkipReason(user.id),
  }))
}

function desktopDevicesFor(request: DeliveryRequest, item: DeliveryItem, scenario: MockScenario): SeedDevice[] {
  const devices = devicesFor(scenario).filter((device) => {
    // 已吊销设备不进目标，但会作为「设备已吊销」的跳过行出现（管理员要看得见）
    const targets = request.targets
    if (targets.mode === 'users') return targets.userIds.includes(device.userId)
    if (targets.mode === 'role') return userOf(device.userId)?.role === targets.role
    if (targets.mode === 'installed') {
      if (item.kind === 'runtime') return false
      if (item.kind === 'models') return device.loggedIn
      return device.plugins[item.pluginId] !== undefined
    }
    return true
  })
  if (request.targets.mode !== 'installed') return devices
  if (item.kind === 'plugin' && request.targets.outdatedOnly) {
    const target = desktopVersionOf(item.pluginId, item.desktopVersionId ?? null, scenario)
    return devices.filter((device) => {
      const current = device.plugins[item.pluginId]
      return current === undefined || (target !== null && isOlder(current, target))
    })
  }
  return devices
}

// ── 预览行 ──────────────────────────────────────────────────────────────────

function instanceRow(
  item: DeliveryItem,
  user: UserRow,
  request: DeliveryRequest,
): DeliveryPreviewRow {
  const base = {
    platform: 'instance' as const,
    userId: user.userId,
    username: user.username,
    deviceId: null,
    deviceName: null,
    itemLabel: itemLabelOf(item),
  }

  if (item.kind === 'models') {
    const view = userOf(user.userId)
    return {
      ...base,
      current: view?.modelPresetId === null || view?.modelPresetId === undefined ? '未配置' : '已配置 Hub 路由',
      after: '按当前模型配置重渲染',
      needsRestart: true,
      skipReason: user.skipReason,
    }
  }

  if (item.kind === 'runtime') {
    const view = userOf(user.userId)
    const after = RUNTIME_VERSIONS[item.runtimeId] ?? '0.0.0'
    const current = view?.instance.runtimeVersion ?? '未创建'
    const skip = user.skipReason ?? (current === after ? '已是该版本' : null)
    return { ...base, current, after, needsRestart: true, skipReason: skip }
  }

  const plugin = pluginOf(item.pluginId)
  const after = request.action === 'uninstall' ? '未安装' : (targetVersionOf(item.pluginId, item.versionId ?? null) ?? '—')
  const installed = (INSTANCE_INSTALLED[item.pluginId] ?? []).find((row) => row.userId === user.userId)
  const current = installed?.version ?? '未安装'
  let skip = user.skipReason
  if (skip === null && request.action === 'uninstall') skip = installed ? null : '没装这个插件'
  if (skip === null && request.action !== 'uninstall' && current === after) skip = '已是该版本'
  return { ...base, current, after, needsRestart: plugin?.needsRestart ?? true, skipReason: skip }
}

function desktopRow(
  item: DeliveryItem,
  device: SeedDevice,
  request: DeliveryRequest,
  scenario: MockScenario,
): DeliveryPreviewRow {
  const base = {
    platform: 'desktop' as const,
    userId: device.userId,
    username: userOf(device.userId)?.username ?? `user${String(device.userId)}`,
    deviceId: device.id,
    deviceName: device.name,
    itemLabel: itemLabelOf(item, 'desktop'),
  }

  const ownerSkip = userSkipReason(device.userId)
  if (device.revoked) {
    return { ...base, current: '—', after: '—', needsRestart: false, skipReason: '设备已吊销' }
  }
  if (ownerSkip !== null && ownerSkip !== '实例还没创建') {
    return { ...base, current: '—', after: '—', needsRestart: false, skipReason: ownerSkip }
  }

  if (item.kind === 'models') {
    return {
      ...base,
      current: device.loggedIn ? '已登录' : '未配置',
      after: '按系统预设更新两条片段',
      needsRestart: true,
      skipReason: null,
    }
  }

  if (item.kind === 'runtime') {
    const after = RUNTIME_VERSIONS[item.runtimeId] ?? '0.0.0'
    const current = device.runtimeVersion ?? '未上报'
    return {
      ...base,
      current,
      after,
      needsRestart: true,
      skipReason: current === after ? '已是该版本' : null,
    }
  }

  const library = desktopPluginOf(item.pluginId, scenario)
  const artifact = deviceArtifact(item.pluginId, scenario, item.desktopVersionId ?? null)
  const after =
    request.action === 'uninstall'
      ? '未安装'
      : (desktopVersionOf(item.pluginId, item.desktopVersionId ?? null, scenario) ?? '—')
  const current = device.plugins[item.pluginId] ?? '未安装'
  if (library === null && request.action !== 'uninstall') {
    return { ...base, current, after, needsRestart: false, skipReason: '该插件不在桌面插件库' }
  }
  if (artifact === null && request.action !== 'uninstall') {
    return { ...base, current, after, needsRestart: false, skipReason: '缺桌面整包' }
  }
  let skip: string | null = null
  if (request.action === 'uninstall') skip = device.plugins[item.pluginId] === undefined ? '这台设备没装' : null
  else if (current === after) skip = '已是该版本'
  return {
    ...base,
    current,
    after,
    needsRestart: pluginOf(item.pluginId)?.needsRestart ?? true,
    skipReason: skip,
  }
}

// ── 预览 ────────────────────────────────────────────────────────────────────

function buildPreviewRows(request: DeliveryRequest, scenario: MockScenario): DeliveryPreviewRow[] {
  const rows: DeliveryPreviewRow[] = []
  for (const item of request.items) {
    if (request.platforms.includes('instance')) {
      // 「DSH 版本」只对实例有效；桌面端那边也会生成「跳过」行说明原因
      for (const user of instanceUsersFor(request, item, scenario)) rows.push(instanceRow(item, user, request))
    }
    if (request.platforms.includes('desktop')) {
      for (const device of desktopDevicesFor(request, item, scenario)) {
        rows.push(desktopRow(item, device, request, scenario))
      }
    }
  }
  return rows
}

function summarize(rows: DeliveryPreviewRow[]): DeliveryPreviewResponse['summary'] {
  const instanceRows = rows.filter((row) => row.platform === 'instance')
  const desktopRows = rows.filter((row) => row.platform === 'desktop')
  const distinct = (list: DeliveryPreviewRow[], key: (row: DeliveryPreviewRow) => string | null): number =>
    new Set(list.map(key).filter((value): value is string => value !== null)).size

  return {
    instance: {
      willRun: instanceRows.filter((row) => row.skipReason === null).length,
      skipped: instanceRows.filter((row) => row.skipReason !== null).length,
      users: distinct(
        instanceRows.filter((row) => row.skipReason === null),
        (row) => String(row.userId),
      ),
    },
    desktop: {
      willRun: desktopRows.filter((row) => row.skipReason === null).length,
      skipped: desktopRows.filter((row) => row.skipReason !== null).length,
      users: distinct(
        desktopRows.filter((row) => row.skipReason === null),
        (row) => String(row.userId),
      ),
      devices: distinct(
        desktopRows.filter((row) => row.skipReason === null),
        (row) => row.deviceId,
      ),
    },
  }
}

function scenarioWarnings(request: DeliveryRequest, scenario: MockScenario): string[] {
  const warnings: string[] = []
  if (request.platforms.includes('desktop')) {
    for (const item of request.items) {
      if (item.kind === 'plugin') {
        const library = desktopPluginOf(item.pluginId, scenario)
        if (library === null) {
          warnings.push(`${itemLabelOf(item, 'desktop')} 不在桌面插件库，桌面端这一项会被跳过`)
        } else if (deviceArtifact(item.pluginId, scenario, item.desktopVersionId ?? null) === null) {
          warnings.push(`${itemLabelOf(item, 'desktop')} 没有桌面整包，桌面端这一项会被跳过`)
        }
      }
      if (item.kind === 'runtime') {
        warnings.push('DSH 版本只对实例生效，桌面端的这一项会被跳过')
      }
    }
  }
  if (scenario === 'delivery-warnings') {
    warnings.push('有 1 台设备已吊销，不在这次的目标里（预览里列为「设备已吊销」）')
    if (warnings.length === 0) {
      warnings.push('所选内容项在实例平台都不适用，实例侧不会有任何行')
    }
    warnings.push('桌面端按设备心跳拉取，提交后最迟一个心跳周期生效')
  }
  return warnings
}

function previewOf(request: DeliveryRequest, scenario: MockScenario): DeliveryPreviewResponse {
  let rows = buildPreviewRows(request, scenario)
  let truncated = false
  if (scenario === 'delivery-truncated') {
    truncated = true
    // 造一批「假用户」把行数撑起来：页面只看到截断提示，仍按完整清单执行
    const filler: DeliveryPreviewRow[] = []
    for (let index = 0; index < 40; index += 1) {
      const item = request.items[index % request.items.length]
      if (!item) continue
      filler.push({
        platform: 'instance',
        userId: 1000 + index,
        username: `member-${String(1000 + index)}`,
        deviceId: null,
        deviceName: null,
        itemLabel: itemLabelOf(item),
        current: '0.15.0',
        after:
          item.kind === 'plugin' ? (targetVersionOf(item.pluginId, item.versionId ?? null) ?? '—') : '—',
        needsRestart: true,
        skipReason: null,
      })
    }
    rows = [...rows, ...filler]
  }

  const summary = summarize(rows)
  if (scenario === 'delivery-truncated') {
    summary.instance.users += 812
    summary.instance.willRun += 812
  }
  return {
    rows,
    summary,
    warnings: scenarioWarnings(request, scenario),
    truncated,
    // docs/22 §2.2 / 契约 d12d925：预览就带上「整项跳过」，与提交时的 skippedItems 同一口径
    skippedItems: skippedOf(request, rows, scenario),
  }
}

/**
 * 整项跳过（预览与提交同形同口径）。
 *
 * - 实例侧：这一项在所有目标行上都被跳过（没有需要执行的目标）；
 * - 桌面侧：插件不在桌面插件库 / 缺桌面整包 / DSH 版本只对实例生效。
 */
function skippedOf(
  request: DeliveryRequest,
  rows: DeliveryPreviewRow[],
  scenario: MockScenario,
): DeliverySkippedItem[] {
  const skippedItems: DeliverySkippedItem[] = []

  if (request.platforms.includes('instance')) {
    for (const item of request.items) {
      const label = itemLabelOf(item)
      const hasTarget = rows.some(
        (row) => row.platform === 'instance' && row.itemLabel === label && row.skipReason === null,
      )
      if (!hasTarget) skippedItems.push({ itemLabel: label, platform: 'instance', reason: '没有需要执行的目标' })
    }
  }

  if (request.platforms.includes('desktop')) {
    for (const item of request.items) {
      if (item.kind === 'plugin') {
        if (desktopPluginOf(item.pluginId, scenario) === null) {
          skippedItems.push({
            itemLabel: itemLabelOf(item, 'desktop'),
            platform: 'desktop',
            reason: '该插件不在桌面插件库',
          })
        } else if (deviceArtifact(item.pluginId, scenario, item.desktopVersionId ?? null) === null) {
          skippedItems.push({ itemLabel: itemLabelOf(item, 'desktop'), platform: 'desktop', reason: '缺桌面整包' })
        }
      }
      if (item.kind === 'runtime') {
        skippedItems.push({ itemLabel: itemLabelOf(item), platform: 'desktop', reason: 'DSH 版本只对实例生效' })
      }
    }
  }

  return skippedItems
}

// ── 人数（`GET /api/admin/plugins/install-stats`）───────────────────────────

function installStats(scenario: MockScenario): PluginInstallStat[] {
  const devices = devicesFor(scenario)
  return ADMIN_PLUGINS.map((plugin) => {
    const installed = INSTANCE_INSTALLED[plugin.id] ?? []
    const latest = plugin.latestVersion
    const instance = {
      users: scenario === 'delivery-desktop-only' ? 0 : installed.length,
      outdated:
        scenario === 'delivery-desktop-only' || latest === null
          ? 0
          : installed.filter((row) => isOlder(row.version, latest)).length,
    }
    const withPlugin = devices.filter((device) => device.plugins[plugin.id] !== undefined)
    // docs/22 §2.1：桌面的「旧」按**桌面**最新版本算（不是云上最新）
    const desktopLatest = desktopPluginOf(plugin.id, scenario)?.latestVersion ?? null
    return {
      pluginId: plugin.id,
      instance,
      desktop: {
        devices: withPlugin.length,
        users: new Set(withPlugin.map((device) => device.userId)).size,
        // 契约（WP32a）：上报 source=bundled 的设备数；这个场景的假数据里都算清单装的
        bundledDevices: 0,
        outdated:
          desktopLatest === null
            ? 0
            : withPlugin.filter((device) => {
                const version = device.plugins[plugin.id]
                return version !== undefined && isOlder(version, desktopLatest)
              }).length,
      },
      latestVersion: latest,
      desktopLatestVersion: desktopLatest,
    }
  })
}

// ── 提交 ────────────────────────────────────────────────────────────────────

function createOf(request: DeliveryRequest, scenario: MockScenario): { body: unknown; status: number } {
  const rows = buildPreviewRows(request, scenario)
  const jobs: { jobId: number; itemLabel: string }[] = []
  const skippedItems = skippedOf(request, rows, scenario)

  if (request.platforms.includes('instance')) {
    for (const item of request.items) {
      const label = itemLabelOf(item)
      const targets = rows
        .filter((row) => row.platform === 'instance' && row.itemLabel === label && row.skipReason === null)
        .map((row) => ({ userId: row.userId, username: row.username }))
      if (targets.length === 0) continue
      const job = createMockRolloutJob({
        type: item.kind === 'plugin' ? 'rollout.plugin' : item.kind === 'models' ? 'rollout.models' : 'rollout.runtime',
        title: `${label} → ${String(targets.length)} 位用户`,
        targets,
      })
      jobs.push({ jobId: job.id, itemLabel: label })
    }
  }

  let desktop: { revision: number; users: number; devices: number } | null = null
  if (request.platforms.includes('desktop')) {
    const desktopRows = rows.filter((row) => row.platform === 'desktop' && row.skipReason === null)
    state.revision += 1
    desktop = {
      revision: state.revision,
      users: new Set(desktopRows.map((row) => row.userId)).size,
      devices: new Set(desktopRows.map((row) => row.deviceId)).size,
    }
  }

  state.lastCreated = request
  return { body: { jobs, desktop, skippedItems }, status: 202 }
}

// ── 分发 ────────────────────────────────────────────────────────────────────

/**
 * 统一下发的假接口。命中返回 `Response`，未命中 / 不是本包的场景返回 `null`（调用方透传真后端）。
 */
export function handleDeliveries(
  pathname: string,
  method: string,
  _url: URL,
  init?: RequestInit,
): Response | null {
  const scenario = getMockState().scenario
  if (!isDeliveryScenario(scenario)) return null

  if (pathname === '/api/admin/deliveries/preview' && method === 'POST') {
    const parsed = DeliveryRequestSchema.safeParse(readJson(init))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return apiError('VALIDATION_FAILED', 400, issue?.message ?? '下发请求不合法', {
        fields: { request: issue?.message ?? '' },
      })
    }
    return json(previewOf(parsed.data, scenario))
  }

  if (pathname === '/api/admin/deliveries' && method === 'POST') {
    const parsed = DeliveryRequestSchema.safeParse(readJson(init))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return apiError('VALIDATION_FAILED', 400, issue?.message ?? '下发请求不合法', {
        fields: { request: issue?.message ?? '' },
      })
    }
    const created = createOf(parsed.data, scenario)
    return json(created.body, created.status)
  }

  // 向导第 2 步：「已安装」的人数（WP28c 的插件库也有这一列，那边有自己的实现；这里只服务本包四个场景）
  if (pathname === '/api/admin/plugins/install-stats' && method === 'GET') {
    return json({ items: installStats(scenario) })
  }

  // 「有 / 缺桌面整包」的标记（向导第 1 步）；四个场景里 desktop-delivery 的假接口不接管，这里补上
  if (pathname === '/api/admin/desktop/artifacts' && method === 'GET') {
    const items = desktopPluginCatalog(scenario)
      .flatMap((plugin) => plugin.versions.map((version) => deviceArtifact(plugin.id, scenario, version.id)))
      .filter((artifact): artifact is DesktopPluginArtifact => artifact !== null)
    return json({ items })
  }

  return null
}
