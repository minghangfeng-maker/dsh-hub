import {
  DesktopConfigDeliverRequestSchema,
  DesktopDeliveryStateSchema,
  type AuditItem,
  type DesktopAppDeliverRequest,
  type DesktopChannelPolicy,
  type DesktopConfigFragmentView,
  type DesktopDeliverResponse,
  type DesktopDeliveryState,
  type DesktopDeliveryTarget,
  type DesktopPluginArtifact,
  type DesktopPluginTarget,
  type DesktopPolicyOverride,
  type DesktopRelease,
  type DesktopReleaseChannel,
  type DesktopApplyErrorCode,
  type DesktopDevice,
  type DesktopReleaseTarget,
  type DesktopUninstallView,
  type DesktopUpdateFloor,
  type UserRef,
} from '@dsh-hub/shared'

import { ADMIN_PLUGINS, ADMIN_USERS } from './admin'
import { getMockState, type MockScenario } from './state'

/**
 * 桌面下发（WP25d）的假接口（**仅开发环境**）。
 *
 * 场景：
 * - `admin-desktop`：一整套真实形状的下发（3 个受管插件、2 条配置片段、1 条卸载、两个渠道策略、
 *   两个覆盖、2 条安装包），4 台设备含「已应用 / 待应用 / 失败」三种；
 * - `admin-desktop-empty`：全新 Hub（revision 0、什么都没下发、没有设备）；
 * - `admin-desktop-failed`：4 台设备全部卡在失败 / 部分应用（看失败明细与错误码）；
 * - `admin-desktop-warn`：下发数据带 3 条渲染告警（origin 不是 https、插件缺整包、provider 不在 Hub 下）。
 *
 * 名字都以 `admin` 开头：`isAdminScenario()` 认得它们，`mocks/desktop.ts` 的设备台账、
 * 插件库、用户列表与审计兜底也照常生效。**写接口是有状态的**：下发给全部 → 已下发列表里真的多一行，
 * 走查时能看见「保存即下发新 revision」。
 */

const MINUTE = 60_000
const NOW = Date.now()
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
const deviceId = (n: number): string => `dv_${String(n).padStart(32, '0')}`

export const DESKTOP_DELIVERY_SCENARIOS: readonly MockScenario[] = [
  'admin-desktop',
  'admin-desktop-empty',
  'admin-desktop-failed',
  'admin-desktop-warn',
]

export function isDesktopDeliveryScenario(scenario: MockScenario): boolean {
  return DESKTOP_DELIVERY_SCENARIOS.includes(scenario)
}

/**
 * docs/22 §1.3：Claude Code / Codex 页的桌面侧也要读写配置片段
 * （`GET /api/admin/desktop/delivery` + `PUT /api/admin/desktop/config`）。
 * 这几个场景只接管这两个接口，其余桌面接口仍返回 `null`（不遮挡别的假数据）。
 */
const FRAGMENT_ONLY_SCENARIOS: readonly MockScenario[] = ['agent-modes']

// ── 设备（概览的 revision 分布 + 设备数）────────────────────────────────────

interface SeedDevice {
  n: number
  userId: number
  name: string
  platform: 'win32' | 'darwin' | 'linux'
  osMajor: string
  arch: 'x64' | 'arm64'
  appVersion: string
  appChannel: DesktopReleaseChannel
  runtimeVersion: string | null
  appliedRevision: number | null
  desiredRevision: number | null
  applyState: 'unknown' | 'applied' | 'partial' | 'pending' | 'failed'
  applyErrorCode?: DesktopApplyErrorCode
  errorCount?: number
  reportMinutesAgo: number | null
  online: boolean
}

const NORMAL_DEVICES: SeedDevice[] = [
  {
    n: 1,
    userId: 1,
    name: '站长的 Windows 开发机',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'latest',
    runtimeVersion: '0.2.1-rc.2',
    appliedRevision: 42,
    desiredRevision: 42,
    applyState: 'applied',
    reportMinutesAgo: 0.5,
    online: true,
  },
  {
    n: 2,
    userId: 2,
    name: '薄荷茶的 MacBook',
    platform: 'darwin',
    osMajor: '14',
    arch: 'arm64',
    appVersion: '0.2.0',
    appChannel: 'latest',
    runtimeVersion: '0.2.0',
    appliedRevision: 40,
    desiredRevision: 42,
    applyState: 'pending',
    reportMinutesAgo: 3 * 60,
    online: false,
  },
  {
    n: 3,
    userId: 4,
    name: '樱花饼的联想小新',
    platform: 'win32',
    osMajor: '11',
    arch: 'x64',
    appVersion: '0.2.1',
    appChannel: 'nightly',
    runtimeVersion: '0.2.1-rc.2',
    appliedRevision: 41,
    desiredRevision: 42,
    applyState: 'failed',
    applyErrorCode: 'disk_full',
    errorCount: 2,
    reportMinutesAgo: 40,
    online: true,
  },
  {
    n: 4,
    userId: 7,
    name: '小陈的第三台工作笔记本（出差用）',
    platform: 'linux',
    osMajor: '24.04',
    arch: 'arm64',
    appVersion: '0.1.9',
    appChannel: 'latest',
    runtimeVersion: null,
    appliedRevision: null,
    desiredRevision: 42,
    applyState: 'unknown',
    reportMinutesAgo: 9 * 24 * 60,
    online: false,
  },
]

const FAILED_DEVICES: SeedDevice[] = NORMAL_DEVICES.map((device, index) => ({
  ...device,
  appliedRevision: index === 3 ? null : 39,
  applyState: index === 3 ? 'unknown' : 'failed',
  applyErrorCode:
    index === 0
      ? 'plugin_conflict'
      : index === 1
        ? 'config_write_failed'
        : index === 2
          ? 'plugin_hash_mismatch'
          : undefined,
  errorCount: index === 3 ? 0 : index + 1,
}))

function toDevice(seed: SeedDevice): DesktopDevice {
  const reportedAt = seed.reportMinutesAgo === null ? null : iso(-seed.reportMinutesAgo * MINUTE)
  return {
    deviceId: deviceId(seed.n),
    name: seed.name,
    platform: seed.platform,
    osMajor: seed.osMajor,
    arch: seed.arch,
    appVersion: seed.appVersion,
    appChannel: seed.appChannel,
    runtimeVersion: seed.runtimeVersion,
    capabilities: { claudeCode: true, codex: seed.n % 2 === 0, pwsh: seed.platform === 'win32' ? '7' : 'none' },
    appliedRevision: seed.appliedRevision,
    desiredRevision: seed.desiredRevision,
    appliedAt: seed.appliedRevision === null || reportedAt === null ? null : reportedAt,
    applyState: seed.applyState,
    applyErrorCode: seed.applyErrorCode ?? null,
    errorCount: seed.errorCount ?? 0,
    presence: seed.online ? 'online' : 'offline',
    firstSeenAt: iso(-12 * 24 * 60 * MINUTE),
    registeredAt: iso(-12 * 24 * 60 * MINUTE),
    lastReportAt: reportedAt,
    lastAuthAt: iso(-12 * 24 * 60 * MINUTE),
    revokedAt: null,
    revokeReason: null,
    createdAt: iso(-12 * 24 * 60 * MINUTE),
  }
}

function userRefOf(userId: number): UserRef {
  const user = ADMIN_USERS.find((item) => item.id === userId)
  return {
    id: userId,
    slug: user?.slug ?? `umock${String(userId)}`,
    username: user?.username ?? `user${String(userId)}`,
    displayName: user?.displayName ?? `用户 ${String(userId)}`,
    avatarUrl: user?.avatarUrl ?? null,
  }
}

// ── 假数据的状态（写接口会改它）────────────────────────────────────────────

/** 视频渲染（id 4）故意没有整包：用来演示「缺整包」与下发的 400 */
const PLUGIN_WITHOUT_ARTIFACT = 4

function artifactOf(pluginId: number): DesktopPluginArtifact | null {
  if (pluginId === PLUGIN_WITHOUT_ARTIFACT) return null
  const plugin = ADMIN_PLUGINS.find((item) => item.id === pluginId)
  const version = plugin?.versions[0]
  if (!plugin || !version) return null
  return {
    pluginId,
    packageName: plugin.packageName,
    versionId: version.id,
    version: version.version,
    fileName: `${plugin.packageName.replace(/^@[^/]+\//u, '')}-${version.version}.tgz`,
    bytes: 41_216 + pluginId * 1_024,
    sha256: `${'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2)}`.slice(0, 64),
    uploadedAt: iso(-6 * 60 * MINUTE),
  }
}

function pluginTargetOf(
  pluginId: number,
  versionId: number,
  level: DesktopPluginTarget['level'],
  target: DesktopDeliveryTarget,
  options: { enabled?: boolean; withArtifact?: boolean } = {},
): DesktopPluginTarget {
  const plugin = ADMIN_PLUGINS.find((item) => item.id === pluginId)
  const version = plugin?.versions.find((item) => item.id === versionId) ?? plugin?.versions[0]
  return {
    id: pluginId,
    pluginId,
    packageName: plugin?.packageName ?? `plugin-${String(pluginId)}`,
    displayName: plugin?.displayName ?? `插件 ${String(pluginId)}`,
    policy: plugin?.policy ?? 'default',
    versionId: version?.id ?? versionId,
    version: version?.version ?? '0.0.1',
    level,
    enabled: options.enabled ?? true,
    needsRestart: plugin?.needsRestart ?? false,
    minDsh: version?.minDsh ?? null,
    artifact: options.withArtifact === false ? null : artifactOf(pluginId),
    ...scopeOf(target),
  }
}

function scopeOf(target: DesktopDeliveryTarget): {
  scope: 'all' | 'role' | 'user'
  role: 'user' | 'admin' | null
  userId: number | null
} {
  if (target.scope === 'all') return { scope: 'all', role: null, userId: null }
  if (target.scope === 'role') return { scope: 'role', role: target.role, userId: null }
  return { scope: 'user', role: null, userId: target.userId }
}

function defaultChannels(): DesktopChannelPolicy[] {
  return [
    { channel: 'nightly', targetVersion: null, minVersion: '0.2.1', minVersionHard: false, rolloutPercent: 100 },
    { channel: 'latest', targetVersion: null, minVersion: '0.2.0', minVersionHard: false, rolloutPercent: 100 },
  ]
}

const NORMAL_FRAGMENTS: DesktopConfigFragmentView[] = [
  {
    id: 1,
    entryId: 'llm-pi-ai',
    mode: 'enforce',
    note: 'Hub 中转站',
    config: {
      providers: {
        hub: {
          displayName: 'DSH Hub',
          api: 'openai-completions',
          baseURL: 'https://hub.example.test/v1',
          apiKeyEnv: 'HUB_MK_HUB',
          models: [
            { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 128_000 },
            { id: 'deepseek-v4.1', name: 'DeepSeek V4.1', contextWindow: 128_000 },
          ],
        },
      },
    },
    scope: 'all',
    role: null,
    userId: null,
  },
  {
    id: 2,
    entryId: 'agent-default-model',
    mode: 'enforce',
    note: '',
    config: { provider: 'hub', model: 'deepseek-v4.1-flash' },
    scope: 'all',
    role: null,
    userId: null,
  },
  {
    id: 3,
    entryId: 'claude-pilot',
    mode: 'default',
    note: '',
    config: { hubMode: true },
    scope: 'role',
    role: 'user',
    userId: null,
  },
]

const NORMAL_RELEASES: DesktopRelease[] = [
  {
    id: 2,
    target: 'win-x64',
    channel: 'latest',
    version: '0.2.1',
    installerFile: 'deepseek-harness-0.2.1-win-x64.exe',
    installerBytes: 183_500_800,
    installerSha512: 'rQ8m0nJ7pQ2vY5sT1uW3xZ6aB9cD4eF7gH0iJ2kL5mN8oP1qR3sT6uV9wX2yZ4aB7cD0eF3gH6iJ8kL1mN4oP7qR9sT2uV5wX8yZ0aB3cD6eF9gH2iJ4kL7mN0oP',
    blockmapFile: 'deepseek-harness-0.2.1-win-x64.exe.blockmap',
    portableFile: 'deepseek-harness-0.2.1-win-x64-portable.zip',
    portableBytes: 248_512_000,
    feedFile: 'latest.yml',
    status: 'published',
    publishedAt: iso(-2 * 60 * MINUTE),
  },
  {
    id: 1,
    target: 'win-x64',
    channel: 'latest',
    version: '0.2.0',
    installerFile: 'deepseek-harness-0.2.0-win-x64.exe',
    installerBytes: 181_403_648,
    installerSha512: 'bW3xY6zA9cB2dE5fG8hJ1kL4mN7oP0qR3sT6uV9wX2yZ5aB8cD1eF4gH7iJ0kL3mN6oP9qR2sT5uV8wX1yZ4aB7cD0eF3gH6iJ9kL2mN5oP8qR1sT',
    blockmapFile: null,
    portableFile: null,
    portableBytes: null,
    feedFile: 'latest.yml',
    status: 'yanked',
    publishedAt: iso(-9 * 24 * 60 * MINUTE),
  },
]

interface DeliveryMockState {
  revision: number
  pluginTargets: DesktopPluginTarget[]
  configFragments: DesktopConfigFragmentView[]
  uninstalls: DesktopUninstallView[]
  channels: DesktopChannelPolicy[]
  overrides: DesktopPolicyOverride[]
  releases: DesktopRelease[]
  floor: DesktopUpdateFloor
  audits: AuditItem[]
  nextId: number
}

function normalOverrides(): DesktopPolicyOverride[] {
  return [
    {
      channel: 'latest',
      targetVersion: '0.2.2',
      minVersion: null,
      minVersionHard: null,
      rolloutPercent: 5,
      scope: 'role',
      role: 'admin',
      userId: null,
    },
    {
      channel: 'nightly',
      targetVersion: null,
      minVersion: '0.2.2',
      minVersionHard: true,
      rolloutPercent: null,
      scope: 'user',
      role: null,
      userId: 4,
    },
  ]
}

function makeAudit(
  id: number,
  action: string,
  detail: Record<string, unknown>,
  minutesAgo: number,
  actor = 'admin',
): AuditItem {
  return {
    id,
    at: iso(-minutesAgo * MINUTE),
    actorId: 1,
    actorIp: '10.0.0.8',
    actorUsername: actor,
    action,
    targetType: action === 'desktop.deliver' ? 'desktop.delivery' : 'desktop.release',
    targetId: String(id),
    detail,
  }
}

function buildNormalState(): DeliveryMockState {
  return {
    revision: 42,
    pluginTargets: [
      pluginTargetOf(3, 31, 'core', { scope: 'all' }),
      pluginTargetOf(1, 11, 'default', { scope: 'all' }),
      pluginTargetOf(2, 21, 'optional', { scope: 'role', role: 'user' }),
      pluginTargetOf(4, 41, 'optional', { scope: 'user', userId: 4 }, { withArtifact: false }),
    ],
    configFragments: NORMAL_FRAGMENTS.map((fragment) => ({ ...fragment })),
    uninstalls: [{ id: 1, packageName: '@local/dsh-image-gen', scope: 'all', role: null, userId: null }],
    channels: [
      { channel: 'nightly', targetVersion: '0.3.0-rc.1', minVersion: '0.2.1', minVersionHard: false, rolloutPercent: 100 },
      { channel: 'latest', targetVersion: '0.2.2', minVersion: '0.2.1', minVersionHard: false, rolloutPercent: 25 },
    ],
    overrides: normalOverrides(),
    releases: NORMAL_RELEASES.map((release) => ({ ...release })),
    floor: {
      minVersion: '0.2.0',
      title: '需要更新 DSH Hub 桌面端',
      detail: '当前版本已停止支持，请安装 0.2.1 或更高版本后再继续使用。',
      appLink: 'https://hub.example.test/download',
      updatedAt: iso(-3 * 24 * 60 * MINUTE),
    },
    audits: [
      // revision 越大越新（时间轴与版本号同向，截图 / 走查看起来才顺）
      makeAudit(105, 'desktop.deliver', { action: 'deliver', packageName: 'dsh-email', version: '0.16.0', pluginId: 1, versionId: 11, scope: 'all', role: null, userId: null }, 12),
      makeAudit(104, 'desktop.deliver', { channel: 'latest', targetVersion: '0.2.2', minVersion: '0.2.1', minVersionHard: false, rolloutPercent: 25, scope: 'all', role: null, userId: null }, 40),
      makeAudit(103, 'desktop.release.publish', { target: 'win-x64', channel: 'latest', version: '0.2.1' }, 90),
      makeAudit(102, 'desktop.deliver', { entryIds: ['claude-pilot'], count: 1, scope: 'role', role: 'user', userId: null }, 150),
      makeAudit(101, 'desktop.deliver', { action: 'deliver', packageName: '@xmanrui/dsh-im', version: '4.35.1', pluginId: 2, versionId: 21, scope: 'role', role: 'user', userId: null }, 240),
      makeAudit(106, 'desktop.update-floor.set', { minVersion: '0.2.0' }, 3 * 24 * 60),
      makeAudit(107, 'desktop.release.rollback', { target: 'win-x64', channel: 'latest' }, 9 * 24 * 60),
    ],
    nextId: 200,
  }
}

let state: DeliveryMockState = buildNormalState()

export function resetDesktopDeliveryMock(): void {
  state = buildNormalState()
}

function stateOf(scenario: MockScenario): DesktopDeliveryState {
  const warnings =
    scenario === 'admin-desktop-warn'
      ? [
          'Hub 的公开 origin（http://127.0.0.1:5246）不是 https：清单里的 artifact.url / app.feedUrl 不满足 D3 schema（客户端会整份拒绝）',
          '插件 @demo-alice/dsh-remotion-video-plugin@0.3.2 还没有上传桌面整包，设备拿不到它',
          '配置片段 llm-pi-ai 的 provider hub 的 baseURL（https://relay.example.test/v1）不在 Hub 的公开 origin（https://hub.example.test）下',
        ]
      : []
  if (scenario === 'admin-desktop-empty') {
    return DesktopDeliveryStateSchema.parse({
      revision: 0,
      allowlistVersion: 1,
      pluginTargets: [],
      configFragments: [],
      uninstalls: [],
      app: { channels: defaultChannels(), overrides: [] },
      warnings: [],
    })
  }
  return DesktopDeliveryStateSchema.parse({
    revision: state.revision,
    allowlistVersion: 1,
    pluginTargets: state.pluginTargets,
    configFragments: state.configFragments,
    uninstalls: state.uninstalls,
    app: { channels: state.channels, overrides: state.overrides },
    warnings,
  })
}

// ── 写操作（有状态）────────────────────────────────────────────────────────

function affectedDevices(target: DesktopDeliveryTarget): number {
  const scenario = getMockState().scenario
  if (scenario === 'admin-desktop-empty') return 0
  const seeds = scenario === 'admin-desktop-failed' ? FAILED_DEVICES : NORMAL_DEVICES
  if (target.scope === 'all') return seeds.length
  if (target.scope === 'role') {
    const admin = target.role === 'admin'
    return seeds.filter((seed) => (seed.userId === 1) === admin).length
  }
  return seeds.filter((seed) => seed.userId === target.userId).length
}

function publish(target: DesktopDeliveryTarget, detail: Record<string, unknown>): DesktopDeliverResponse {
  state.revision += 1
  const id = state.nextId++
  state.audits.unshift(
    makeAudit(
      id,
      'desktop.deliver',
      {
        ...detail,
        scope: target.scope,
        role: target.scope === 'role' ? target.role : null,
        userId: target.scope === 'user' ? target.userId : null,
      },
      0,
    ),
  )
  return { revision: state.revision, affectedDevices: affectedDevices(target) }
}

function findPlugin(pluginId: number) {
  return ADMIN_PLUGINS.find((plugin) => plugin.id === pluginId) ?? null
}

function upsertPluginTarget(
  target: DesktopDeliveryTarget,
  pluginId: number,
  versionId: number,
): DesktopPluginTarget {
  const plugin = findPlugin(pluginId)
  if (!plugin) throw new Error('插件不存在')
  const version = plugin.versions.find((item) => item.id === versionId) ?? plugin.versions[0]
  const level: DesktopPluginTarget['level'] =
    plugin.policy === 'required' ? 'core' : plugin.policy === 'optional' ? 'optional' : 'default'
  const row = pluginTargetOf(pluginId, version?.id ?? versionId, level, target)
  const index = state.pluginTargets.findIndex(
    (item) =>
      item.pluginId === pluginId &&
      item.scope === row.scope &&
      item.role === row.role &&
      item.userId === row.userId,
  )
  if (index >= 0) {
    const previous = state.pluginTargets[index]
    state.pluginTargets[index] = { ...row, artifact: previous?.artifact ?? row.artifact }
  } else {
    state.pluginTargets.push(row)
  }
  return row
}

// ── 路由 ────────────────────────────────────────────────────────────────────

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

function pageOf<T>(items: T[], url: URL): { items: T[]; total: number; page: number; pageSize: number } {
  const pageNo = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
  const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? '20') || 20)
  return {
    items: items.slice((pageNo - 1) * pageSize, pageNo * pageSize),
    total: items.length,
    page: pageNo,
    pageSize,
  }
}

export function handleDesktopDelivery(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Response | null {
  const scenario = getMockState().scenario
  const fragmentOnly = FRAGMENT_ONLY_SCENARIOS.includes(scenario)
  if (!isDesktopDeliveryScenario(scenario) && !fragmentOnly) return null
  if (
    fragmentOnly &&
    pathname !== '/api/admin/desktop/delivery' &&
    pathname !== '/api/admin/desktop/config'
  ) {
    return null
  }

  // ── 设备台账（概览的 revision 分布；用整套假设备替掉 WP25c 的，便于造「全部失败」）──
  if (pathname === '/api/admin/desktop-devices' && method === 'GET') {
    const seeds =
      scenario === 'admin-desktop-empty'
        ? []
        : scenario === 'admin-desktop-failed'
          ? FAILED_DEVICES
          : NORMAL_DEVICES
    const items = seeds.map((seed) => ({ user: userRefOf(seed.userId), device: toDevice(seed), pluginCount: 4 }))
    return json(pageOf(items, url))
  }

  // ── 期望状态 ──
  if (pathname === '/api/admin/desktop/delivery' && method === 'GET') {
    return json(stateOf(scenario))
  }

  // ── 插件下发 / 撤掉 ──
  if (pathname === '/api/admin/desktop/plugins' && (method === 'PUT' || method === 'DELETE')) {
    const body = readJson(init)
    const target = body['target'] as DesktopDeliveryTarget | undefined
    const pluginId = Number(body['pluginId'])
    if (!target || !Number.isFinite(pluginId)) return apiError('VALIDATION_FAILED', 400, '缺少目标或插件')
    const plugin = findPlugin(pluginId)
    if (!plugin) return apiError('NOT_FOUND', 404, '插件不存在')

    if (method === 'DELETE') {
      const before = state.pluginTargets.length
      const scope = scopeOf(target)
      state.pluginTargets = state.pluginTargets.filter(
        (item) =>
          !(
            item.pluginId === pluginId &&
            item.scope === scope.scope &&
            item.role === scope.role &&
            item.userId === scope.userId
          ),
      )
      if (state.pluginTargets.length === before) {
        return apiError('NOT_FOUND', 404, '这个目标上没有这个插件')
      }
      return json(publish(target, { action: 'withdraw', pluginId }))
    }

    if (plugin.policy === 'hidden') {
      return apiError('VALIDATION_FAILED', 400, `插件 ${plugin.packageName} 的 policy 是 hidden，不能下发`, {
        fields: { pluginId: 'hidden 不下发（裁决 #17）' },
      })
    }
    const versionId = Number(body['versionId'])
    const version = plugin.versions.find((item) => item.id === versionId)
    if (!version) return apiError('VALIDATION_FAILED', 400, '版本不存在或不属于这个插件')
    const existing = state.pluginTargets.find(
      (item) =>
        item.pluginId === pluginId &&
        item.scope === target.scope &&
        item.role === (target.scope === 'role' ? target.role : null) &&
        item.userId === (target.scope === 'user' ? target.userId : null),
    )
    if (!existing?.artifact && !artifactOf(pluginId)) {
      return apiError(
        'VALIDATION_FAILED',
        400,
        `插件 ${plugin.packageName}@${version.version} 还没有上传桌面整包，先把包传上来再下发`,
        { fields: { versionId: '缺桌面整包' } },
      )
    }
    upsertPluginTarget(target, pluginId, versionId)
    return json(publish(target, { action: 'deliver', packageName: plugin.packageName, version: version.version, pluginId, versionId }))
  }

  // ── 配置片段（整体替换）──
  if (pathname === '/api/admin/desktop/config' && method === 'PUT') {
    const body = readJson(init)
    const parsed = DesktopConfigDeliverRequestSchema.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return apiError('VALIDATION_FAILED', 400, issue?.message ?? '配置片段不合法', {
        fields: { fragments: issue?.message ?? '' },
      })
    }
    const { target, fragments } = parsed.data
    const scope = scopeOf(target)
    state.configFragments = state.configFragments.filter(
      (item) =>
        !(item.scope === scope.scope && item.role === scope.role && item.userId === scope.userId),
    )
    for (const fragment of fragments) {
      state.configFragments.push({
        id: state.nextId++,
        entryId: fragment.id,
        mode: fragment.mode,
        note: fragment.note ?? '',
        config: fragment.config as Record<string, unknown>,
        scope: scope.scope,
        role: scope.role,
        userId: scope.userId,
      })
    }
    return json(publish(target, { entryIds: fragments.map((fragment) => fragment.id), count: fragments.length }))
  }

  // ── 版本策略（渠道级 / 覆盖）──
  if (pathname === '/api/admin/desktop/app' && method === 'PUT') {
    const body = readJson(init) as DesktopAppDeliverRequest
    const channel = body.channel
    if (channel !== 'latest' && channel !== 'nightly') {
      return apiError('VALIDATION_FAILED', 400, 'channel 不对')
    }
    const pick = (key: 'targetVersion' | 'minVersion'): string | null => {
      const value = body[key]
      return typeof value === 'string' && value.length > 0 ? value : null
    }
    const percent = typeof body.rolloutPercent === 'number' ? body.rolloutPercent : null
    if (percent !== null && (percent < 0 || percent > 100)) {
      return apiError('VALIDATION_FAILED', 400, '灰度百分比要在 0–100 之间')
    }
    if (!body.target || body.target.scope === 'all') {
      const index = state.channels.findIndex((item) => item.channel === channel)
      const previous = state.channels[index] ?? {
        channel,
        targetVersion: null,
        minVersion: null,
        minVersionHard: false,
        rolloutPercent: 100,
      }
      state.channels[index >= 0 ? index : state.channels.length] = {
        channel,
        targetVersion: pick('targetVersion'),
        minVersion: pick('minVersion'),
        minVersionHard: body.minVersionHard ?? previous.minVersionHard,
        rolloutPercent: percent ?? previous.rolloutPercent,
      }
      return json(
        publish(
          { scope: 'all' },
          {
            channel,
            targetVersion: pick('targetVersion'),
            minVersion: pick('minVersion'),
            minVersionHard: body.minVersionHard ?? null,
            rolloutPercent: percent,
          },
        ),
      )
    }

    const scope = scopeOf(body.target)
    const cleared =
      (body.targetVersion === null || body.targetVersion === undefined) &&
      (body.minVersion === null || body.minVersion === undefined)
    state.overrides = state.overrides.filter(
      (item) =>
        !(item.channel === channel && item.scope === scope.scope && item.role === scope.role && item.userId === scope.userId),
    )
    if (!cleared) {
      state.overrides.push({
        channel,
        targetVersion: pick('targetVersion'),
        minVersion: pick('minVersion'),
        minVersionHard: body.minVersionHard ?? null,
        rolloutPercent: percent,
        scope: scope.scope,
        role: scope.role,
        userId: scope.userId,
      })
    }
    return json(
      publish(body.target, {
        channel,
        targetVersion: pick('targetVersion'),
        minVersion: pick('minVersion'),
        minVersionHard: body.minVersionHard ?? null,
        rolloutPercent: percent,
        cleared,
      }),
    )
  }

  // ── 卸载清单 ──
  if (pathname === '/api/admin/desktop/uninstall' && method === 'PUT') {
    const body = readJson(init)
    const target = body['target'] as DesktopDeliveryTarget
    const add = Array.isArray(body['add']) ? (body['add'] as string[]) : []
    const remove = Array.isArray(body['remove']) ? (body['remove'] as string[]) : []
    const scope = scopeOf(target)
    for (const name of add) {
      state.uninstalls.push({
        id: state.nextId++,
        packageName: name,
        scope: scope.scope,
        role: scope.role,
        userId: scope.userId,
      })
    }
    state.uninstalls = state.uninstalls.filter(
      (item) => !(remove.includes(item.packageName) && item.scope === scope.scope && item.userId === scope.userId),
    )
    return json(publish(target, { add, remove }))
  }

  // ── 整包清单 / 上传 ──
  if (pathname === '/api/admin/desktop/artifacts' && method === 'GET') {
    return json({ items: state.pluginTargets.flatMap((item) => (item.artifact ? [item.artifact] : [])) })
  }

  const packageMatch = /^\/api\/admin\/desktop\/plugins\/(\d+)\/versions\/(\d+)\/package$/.exec(pathname)
  if (packageMatch && method === 'POST') {
    const pluginId = Number(packageMatch[1])
    const versionId = Number(packageMatch[2])
    const plugin = findPlugin(pluginId)
    if (!plugin) return apiError('NOT_FOUND', 404, '插件版本不存在')
    // 假上传：XHR 走不到 fetch 的补丁（进度需要真请求），这里只在直接 fetch 时兜底
    const form = init?.body
    const file = form instanceof FormData ? form.get('file') : null
    const name = file instanceof File ? file.name.toLowerCase() : ''
    if (name.includes('claude')) {
      return apiError(
        'VALIDATION_FAILED',
        400,
        'Hub 不能托管 Claude Agent SDK / claude-code 的二进制（裁决 #16）：请在客户端按平台从 npm 镜像安装',
        { fields: { file: '命中禁运路径：package/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64' } },
      )
    }
    if (name.includes('codex')) {
      return apiError(
        'VALIDATION_FAILED',
        400,
        '带 codex 二进制的整包必须同时包含 LICENSE 与 NOTICE（Apache-2.0 再分发要求）',
        { fields: { file: '缺 LICENSE 或 NOTICE' } },
      )
    }
    const artifact = artifactOf(pluginId) ?? {
      pluginId,
      packageName: plugin.packageName,
      versionId,
      version: plugin.versions.find((item) => item.id === versionId)?.version ?? '0.0.1',
      fileName: `${plugin.packageName.replace(/^@[^/]+\//u, '')}.tgz`,
      bytes: 50_000,
      sha256: 'b'.repeat(64),
      uploadedAt: iso(0),
    }
    return json({ artifact }, 201)
  }

  // ── 安装包发布 / 回滚 ──
  if (pathname === '/api/admin/desktop/releases' && method === 'GET') {
    return json({ items: scenario === 'admin-desktop-empty' ? [] : state.releases })
  }

  if (pathname === '/api/admin/desktop/releases' && method === 'POST') {
    const form = init?.body
    if (!(form instanceof FormData)) return apiError('VALIDATION_FAILED', 400, '请用 multipart 上传安装包与 blockmap')
    const target = String(form.get('target') ?? '') as DesktopReleaseTarget
    const channel = String(form.get('channel') ?? '') as DesktopReleaseChannel
    const version = String(form.get('version') ?? '')
    const installer = form.get('installer')
    if (!(installer instanceof File)) return apiError('VALIDATION_FAILED', 400, '缺少安装包文件（字段名 installer）')
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      return apiError('VALIDATION_FAILED', 400, '版本号格式应为 1.2.3 或 1.2.3-rc.1', {
        fields: { version: '版本号格式应为 1.2.3' },
      })
    }
    if (channel === 'latest' && version.includes('-')) {
      return apiError('VALIDATION_FAILED', 400, 'latest 通道不能发布预发布版本（上游会拒绝）', {
        fields: { version: 'latest 通道只收正式版' },
      })
    }
    if (state.releases.some((item) => item.target === target && item.channel === channel && item.version === version)) {
      return apiError('CONFLICT', 409, `${target}/${channel} 已经有 ${version} 的发布记录`)
    }
    const release: DesktopRelease = {
      id: state.nextId++,
      target,
      channel,
      version,
      installerFile: installer.name,
      installerBytes: installer.size,
      installerSha512: 'c'.repeat(86),
      blockmapFile: form.get('blockmap') instanceof File ? (form.get('blockmap') as File).name : null,
      portableFile: null,
      portableBytes: null,
      feedFile: channel === 'latest' ? 'latest.yml' : 'nightly.yml',
      status: 'published',
      publishedAt: iso(0),
    }
    state.releases.unshift(release)
    return json(release, 201)
  }

  if (pathname === '/api/admin/desktop/releases/rollback' && method === 'POST') {
    const body = readJson(init)
    const target = body['target'] as DesktopReleaseTarget
    const channel = body['channel'] as DesktopReleaseChannel
    const rows = state.releases.filter((item) => item.target === target && item.channel === channel)
    const published = rows.filter((item) => item.status === 'published')
    const latest = published[0]
    const previous = published[1]
    if (!latest) return apiError('NOT_FOUND', 404, `${target}/${channel} 还没有发布过安装包`)
    if (!previous) return apiError('NOT_FOUND', 404, '没有上一版可回滚（只有一次发布）')
    const yanked = published.filter((item) => item.id !== previous.id).map((item) => item.version)
    state.releases = state.releases.map((item) =>
      item.target === target && item.channel === channel
        ? item.id === previous.id
          ? { ...item, status: 'published' as const }
          : item.status === 'published'
            ? { ...item, status: 'yanked' as const }
            : item
        : item,
    )
    return json({ release: { ...previous, status: 'published' }, yanked })
  }

  // ── 强更地板 ──
  if (pathname === '/api/admin/desktop/update-floor' && method === 'GET') {
    return json({ floor: state.floor })
  }
  if (pathname === '/api/admin/desktop/update-floor' && method === 'PUT') {
    const body = readJson(init)
    const title = typeof body['title'] === 'string' ? body['title'] : state.floor.title
    const detail = typeof body['detail'] === 'string' ? body['detail'] : state.floor.detail
    if (title.length > 256) return apiError('VALIDATION_FAILED', 400, '标题最多 256 字', { fields: { title: '太长了' } })
    if (detail.length > 16_384) {
      return apiError('VALIDATION_FAILED', 400, '说明最多 16384 字', { fields: { detail: '太长了' } })
    }
    const link = typeof body['appLink'] === 'string' ? body['appLink'] : null
    if (link !== null && link !== '' && !link.startsWith('https://')) {
      return apiError('VALIDATION_FAILED', 400, 'appLink 必须是 https://', { fields: { appLink: '必须以 https 开头' } })
    }
    state.floor = {
      minVersion: typeof body['minVersion'] === 'string' ? body['minVersion'] : null,
      title,
      detail,
      appLink: link === '' ? null : link,
      updatedAt: iso(0),
    }
    return json({ floor: state.floor })
  }

  // ── 模型预设 → 两条片段（WP25e：不传 userId = 系统预设，响应 userId: null）──
  if (pathname === '/api/admin/desktop/config/model-preset' && method === 'GET') {
    const raw = url.searchParams.get('userId')
    /** 系统预设（默认预设 + 管理员可见性）与「某个用户的预设」共用同一份片段形状 */
    const presetFragments = (): {
      id: string
      config: Record<string, unknown>
    }[] => [
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            hub: {
              displayName: 'DSH Hub',
              api: 'openai-completions',
              baseURL: 'https://hub.example.test/v1',
              apiKeyEnv: 'HUB_MK_HUB',
              models: [
                { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 128_000 },
                { id: 'deepseek-v4.1', name: 'DeepSeek V4.1', contextWindow: 128_000 },
                { id: 'deepseek-v4.1-flash@upstream-b', name: 'DeepSeek V4.1 Flash · upstream-b' },
              ],
            },
          },
        },
      },
      {
        id: 'agent-default-model',
        config: { provider: 'hub', model: 'deepseek-v4.1-flash' },
      },
    ]

    if (raw === null || raw === '') {
      return json({ userId: null, fragments: presetFragments(), warnings: [] })
    }
    const userId = Number(raw)
    if (!Number.isFinite(userId) || userId <= 0) {
      return apiError('VALIDATION_FAILED', 400, 'userId 不合法')
    }
    const user = ADMIN_USERS.find((item) => item.id === userId)
    if (!user) return apiError('NOT_FOUND', 404, '用户不存在')
    if (user.modelPolicy === 'free') {
      return json({
        userId,
        fragments: [],
        warnings: ['该用户没有生效的模型预设（model_policy=free 或没有默认预设），没有可下发的模型配置'],
      })
    }
    return json({ userId, fragments: presetFragments(), warnings: [] })
  }

  // ── 发布日志（审计；WP25e 起支持 actionPrefix，WP25f 的发布日志只用它）──
  if (pathname === '/api/admin/audit' && method === 'GET') {
    const action = url.searchParams.get('action') ?? ''
    const prefix = url.searchParams.get('actionPrefix') ?? ''
    const rows = state.audits.filter((item) => {
      if (action !== '') return item.action === action || (action.endsWith('*') && item.action.startsWith(action.slice(0, -1)))
      if (prefix !== '') return item.action.startsWith(prefix)
      return true
    })
    return json(pageOf(rows, url))
  }

  return null
}
