import { USERNAME_REGEX, USER_TRASH_RETENTION_DAYS } from '@dsh-hub/shared'
import type {
  AdminInstanceRow,
  AdminInstanceStatsRow,
  AdminOverviewResponse,
  DesktopOverviewCounts,
  AdminPluginRow,
  AdminRuntimeRow,
  UserAdminView,
  AuditItem,
  DeletedUserItem,
  InstanceProbe,
  InstanceStats,
  InviteRow,
  JobSummary,
  JobTaskSummary,
  CatalogEntry,
  DiscoveredModel,
  ModelInfo,
  ModelPreset,
  ModelProvider,
  PluginPlatform,
  PluginPlatformSettings,
  PluginVersion,
  Settings,
  UserPluginRow,
  UserRef,
} from '@dsh-hub/shared'

import { isCockpitScenario } from './cockpit'
import { createMockRolloutJob, mockJobDetail, mockJobs } from './jobs'
import { mockLeaseOfUser } from './compute'
import { mockDesktopStatsOf } from './plugin-desktop-stats'
import { getMockState, type MockScenario } from './state'

/**
 * 管理端的假接口（**仅开发环境**，`?mock=admin`；11 §5：WP6 复用 WP5b 的 `src/mocks/`，不另起一套）。
 *
 * 覆盖 04 §4 的全部管理端读取接口与几个写接口（启停、审批、下发、邀请码、设置、审计），
 * 数据形状与 shared 的类型一一对应（TS 会在编译期挡住契约漂移）。
 * 没命中的请求返回 `null`，由 `fetch.ts` 透传给真后端。
 */

const NOW = Date.now()
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()

const MB = 1024 * 1024
const GB = 1024 * MB

// ── 用户 ────────────────────────────────────────────────────────────────────

interface MockUserInput {
  id: number
  slug: string
  username: string
  displayName: string
  role?: 'user' | 'admin'
  roleLabel?: string
  status?: 'pending' | 'active' | 'disabled'
  instanceStatus?: UserAdminView['instance']['status']
  runtimeVersion?: string | null
  modelPresetId?: number | null
  modelPolicy?: 'managed' | 'free'
  quotaIsDefault?: boolean
  createdMinutesAgo?: number
  lastLoginMinutesAgo?: number
}

function makeAdminUser(input: MockUserInput): UserAdminView {
  const {
    id,
    slug,
    username,
    displayName,
    role = 'user',
    roleLabel = '',
    status = 'active',
    instanceStatus = 'running',
    runtimeVersion = '0.2.0-rc.2',
    modelPresetId = 1,
    modelPolicy = 'managed',
    quotaIsDefault = true,
    createdMinutesAgo = 60 * 24 * 30,
    lastLoginMinutesAgo = 30,
  } = input

  return {
    id,
    slug,
    username,
    displayName,
    bio: '',
    avatarUrl: null,
    role,
    roleLabel: role === 'admin' ? '' : roleLabel,
    status,
    mustChangePassword: false,
    createdAt: iso(createdMinutesAgo),
    lastLoginAt: iso(lastLoginMinutesAgo),
    usernameChangedAt: null,
    quota: {
      cpus: 2,
      memoryMb: 4096,
      pidsLimit: 1024,
      diskGb: 20,
      idleStopMinutes: 120,
      idleNoClientMinutes: 30,
      allowUserPlugins: true,
    },
    quotaIsDefault,
    runtimeId: null,
    modelPresetId,
    modelPolicy,
    instance: {
      status: instanceStatus,
      runtimeVersion: instanceStatus === 'absent' ? null : runtimeVersion,
      startedAt: instanceStatus === 'running' ? iso(133) : null,
      lastActiveAt: iso(3),
      needsRecreate: false,
      error: null,
      openUrl: `/dsh/${username}/`,
    },
    lastLoginIp: '192.168.1.24',
    deletedAt: null,
  }
}

export const ADMIN_USERS: UserAdminView[] = [
  makeAdminUser({
    id: 1,
    slug: 'u7k2m9x1',
    username: 'admin',
    displayName: '站长',
    role: 'admin',
    createdMinutesAgo: 60 * 24 * 120,
    lastLoginMinutesAgo: 2,
  }),
  makeAdminUser({
    id: 2,
    slug: 'u3p8q1z2',
    username: 'mint',
    displayName: '薄荷茶',
    roleLabel: '家人',
    createdMinutesAgo: 60 * 24 * 26,
    lastLoginMinutesAgo: 12,
  }),
  makeAdminUser({
    id: 3,
    slug: 'u9w4e5r3',
    username: 'skywalker',
    displayName: '小天',
    status: 'pending',
    instanceStatus: 'absent',
    createdMinutesAgo: 60 * 5,
    lastLoginMinutesAgo: 300,
  }),
  makeAdminUser({
    id: 4,
    slug: 'u2t6y7u4',
    username: 'sakura',
    displayName: '樱花饼',
    roleLabel: '朋友',
    instanceStatus: 'starting',
    runtimeVersion: '0.1.0',
    modelPresetId: null,
    modelPolicy: 'free',
    quotaIsDefault: false,
    createdMinutesAgo: 60 * 24 * 14,
    lastLoginMinutesAgo: 90,
  }),
  makeAdminUser({
    id: 5,
    slug: 'u5i8o9p5',
    username: 'butter',
    displayName: '奶油小狗',
    roleLabel: '家人',
    instanceStatus: 'stopped',
    createdMinutesAgo: 60 * 24 * 9,
    lastLoginMinutesAgo: 60 * 30,
  }),
  makeAdminUser({
    id: 6,
    slug: 'u4a2s3d6',
    username: 'quiet-leaf',
    displayName: '安静的叶子',
    status: 'disabled',
    instanceStatus: 'error',
    createdMinutesAgo: 60 * 24 * 4,
    lastLoginMinutesAgo: 60 * 40,
  }),
  // 极端值（WP14b 走查）：长用户名 / 长昵称 / 长角色名，看表格与详情会不会被挤断行
  makeAdminUser({
    id: 7,
    slug: 'u8l0k1j7',
    username: 'demo-alice-work-laptop',
    displayName: '小陈的第三台工作笔记本（出差用）',
    roleLabel: '一起打游戏的远房表弟',
    status: 'active',
    instanceStatus: 'stopped',
    runtimeVersion: '0.2.0-rc.2',
    modelPolicy: 'free',
    quotaIsDefault: false,
    createdMinutesAgo: 60 * 24 * 2,
    lastLoginMinutesAgo: 60 * 26,
  }),
]

const userRef = (user: UserAdminView): UserRef => ({
  id: user.id,
  slug: user.slug,
  username: user.username,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
})

/** 让「当前登录用户」也能出现在管理端列表里（`?mock=admin` 时 state.user 是管理员）。 */
function currentUserAsAdminView(): UserAdminView {
  const { user, status } = getMockState()
  return makeAdminUser({
    id: user.id,
    slug: user.slug,
    username: user.username,
    displayName: user.displayName,
    role: 'admin',
    instanceStatus: status,
  })
}

// ── 回收站（已删除用户，WP22 / 04 §4.2） ────────────────────────────────────

interface MockDeletedUserInput {
  id: number
  slug: string
  username: string
  displayName: string
  role?: 'user' | 'admin'
  roleLabel?: string
  deletedFromStatus?: 'pending' | 'active' | 'disabled' | null
  /** 删除时间（多少分钟前） */
  deletedMinutesAgo: number
  /** 剩余可恢复天数（服务端按 `deletedAt + 7 天 - now` 向上取整；过期是负数） */
  daysLeft: number
  dataInTrash?: boolean
}

function makeDeletedUser(input: MockDeletedUserInput): DeletedUserItem {
  const {
    id,
    slug,
    username,
    displayName,
    role = 'user',
    roleLabel = '',
    deletedFromStatus = 'active',
    deletedMinutesAgo,
    daysLeft,
    dataInTrash = true,
  } = input

  return {
    id,
    slug,
    username,
    displayName,
    role,
    roleLabel,
    // 删除时一律置为停用（后端行为），恢复后回到 `deletedFromStatus`
    status: 'disabled',
    deletedAt: iso(deletedMinutesAgo),
    deletedFromStatus,
    dataInTrash,
    restorableUntil: iso(deletedMinutesAgo - USER_TRASH_RETENTION_DAYS * 24 * 60),
    daysLeft,
  }
}

/** 回收站假数据：一条还剩 4 天（可恢复），一条已过期（只能彻底删除）。 */
function makeDeletedUserList(): DeletedUserItem[] {
  return [
    makeDeletedUser({
      id: 8,
      slug: 'u6d3l8e8',
      username: 'demo-carl',
      displayName: '大王',
      roleLabel: '家人',
      deletedFromStatus: 'active',
      deletedMinutesAgo: 60 * 24 * 3,
      daysLeft: 4,
    }),
    makeDeletedUser({
      id: 9,
      slug: 'u2o7d9r9',
      username: 'old-friend',
      displayName: '老朋友',
      deletedFromStatus: 'disabled',
      deletedMinutesAgo: 60 * 24 * 8,
      daysLeft: -1,
      dataInTrash: false,
    }),
  ]
}

/** 恢复 / 彻底删除会改这份假数据；每次 `installMockFetch` 重置回初始状态 */
let deletedUsers = makeDeletedUserList()

/** 测试用：把回收站假数据恢复初始（`mocks/fetch.ts` 里每次安装假接口都会调）。 */
export function resetAdminTrashMock(): void {
  deletedUsers = makeDeletedUserList()
}

// ── 插件 ────────────────────────────────────────────────────────────────────

const pluginVersion = (
  id: number,
  version: string,
  sourceType: PluginVersion['sourceType'],
  sourceRef: string,
  spec: string,
  minutesAgo: number,
  minDsh: string | null = null,
  sha256: string | null = null,
  platform: PluginVersion['platform'] = 'cloud',
): PluginVersion => ({
  id,
  platform,
  version,
  sourceType,
  sourceRef,
  spec,
  sha256,
  minDsh,
  createdAt: iso(minutesAgo),
})

/** 云上库的种子行：`platform` / `platforms` 由下面的 {@link ADMIN_PLUGINS} 统一补齐 */
const PLUGIN_SEED: Omit<AdminPluginRow, 'platform' | 'platforms'>[] = [
  {
    id: 1,
    packageName: 'dsh-email',
    displayName: '邮件助手',
    description: '让 DSH 收发邮件、整理收件箱，支持 IMAP/SMTP。',
    icon: null,
    homepage: 'https://www.npmjs.com/package/dsh-email',
    policy: 'default',
    isBundle: true,
    bundleOrder: 10,
    needsRestart: true,
    latestVersion: '0.16.0',
    configYaml: '- id: dsh-email\n  config:\n    pollSeconds: 60\n    maxMessages: 200',
    versions: [
      pluginVersion(
        11,
        '0.16.0',
        'npm',
        'dsh-email@0.16.0',
        '0.16.0',
        60 * 24 * 20,
        '0.2.0',
        'a1b2c3d4e5f60718',
      ),
      pluginVersion(12, '0.15.0', 'npm', 'dsh-email@0.15.0', '0.15.0', 60 * 24 * 40, '0.1.0'),
    ],
    stats: { installed: 4, pending: 1, failed: 0 },
  },
  {
    id: 2,
    packageName: '@xmanrui/dsh-im',
    displayName: 'IM 机器人',
    description: '把 DSH 接到即时通讯里，支持群聊指令与图片消息。',
    icon: null,
    homepage: null,
    policy: 'optional',
    isBundle: true,
    bundleOrder: 20,
    needsRestart: true,
    latestVersion: '4.35.1',
    configYaml:
      '- id: dsh-im\n  config:\n    providers:\n      telegram:\n        botTokenEnv: HUB_IM_TELEGRAM_TOKEN',
    versions: [pluginVersion(21, '4.35.1', 'npm', '@xmanrui/dsh-im@4.35.1', '4.35.1', 60 * 24 * 6)],
    stats: { installed: 2, pending: 0, failed: 1 },
  },
  {
    id: 3,
    packageName: '@local/dsh-file-download',
    displayName: '文件下载器',
    description: '从工作区打包下载文件，本地插件（pnpm pack 入库）。',
    icon: null,
    homepage: null,
    policy: 'required',
    isBundle: true,
    bundleOrder: 5,
    needsRestart: false,
    latestVersion: '1.0.0',
    configYaml: '',
    versions: [
      pluginVersion(
        31,
        '1.0.0',
        'local',
        '/path/to/plugin',
        'file:/opt/hub/plugin-store/local-dsh-file-download-1.0.0.tgz',
        60 * 24 * 26,
        null,
        'ffeeddccbbaa9988',
      ),
    ],
    stats: { installed: 6, pending: 0, failed: 0 },
  },
  {
    id: 4,
    packageName: '@demo-alice/dsh-remotion-video-plugin',
    displayName: '视频渲染',
    description: '用 Remotion 渲染短视频（tarball 来源）。',
    icon: null,
    homepage: null,
    policy: 'optional',
    isBundle: false,
    bundleOrder: 30,
    needsRestart: true,
    latestVersion: '0.3.2',
    configYaml: '- id: dsh-remotion\n  config:\n    outputDir: /workspace/videos',
    versions: [
      pluginVersion(
        41,
        '0.3.2',
        'tarball',
        'https://codeload.github.com/demo-alice/dsh-remotion-video-plugin/tar.gz/refs/tags/v0.3.2',
        'https://codeload.github.com/demo-alice/dsh-remotion-video-plugin/tar.gz/refs/tags/v0.3.2',
        60 * 24 * 3,
        '0.2.0',
      ),
    ],
    stats: { installed: 0, pending: 2, failed: 0 },
  },
]

/** 桌面库里的一个版本（id 与云上不同：契约允许同名版本号两边各一条） */
interface MockDesktopVersion {
  id: number
  version: string
}

/**
 * 初始**桌面库**（docs/22 §2.1）：哪些插件也在桌面端的库里、各自的桌面策略与版本。
 *
 * 桌面插件**必须**有整包，版本号与云上各算各的（`plugin_versions.platform`）：
 * - `dsh-email` 0.16.0 / 0.15.0（版本 id 1101 / 1102）：两边都在库，桌面策略 `default`；
 * - `@local/dsh-file-download` 1.0.0（版本 id 1031）：两边都在库，桌面策略 `required`（清单里是 core）；
 * - `dsh-im` 与 `@demo-alice/dsh-remotion-video-plugin`：只在云上（桌面没有整包）——
 *   验证「不在桌面插件库」的提示与 `skippedItems`。
 */
const DESKTOP_LIBRARY: Record<number, { policy: AdminPluginRow['policy']; versions: MockDesktopVersion[] }> = {
  1: {
    policy: 'default',
    versions: [
      { id: 1101, version: '0.16.0' },
      { id: 1102, version: '0.15.0' },
    ],
  },
  3: { policy: 'required', versions: [{ id: 1031, version: '1.0.0' }] },
}

/** 某平台设置（`plugin_platforms` 行）：云上从种子照抄，桌面按 {@link DESKTOP_LIBRARY} */
function platformSettings(
  seed: Pick<AdminPluginRow, 'policy' | 'bundleOrder' | 'configYaml' | 'needsRestart'>,
  policy: AdminPluginRow['policy'] = seed.policy,
  minutesAgo = 60 * 24 * 2,
): PluginPlatformSettings {
  return {
    policy,
    bundleOrder: seed.bundleOrder,
    configYaml: seed.configYaml,
    needsRestart: seed.needsRestart,
    createdAt: iso(60 * 24 * 40),
    updatedAt: iso(minutesAgo),
  }
}

/** 一个插件在某平台库里的状态：设置 + 该平台的版本（桌面版本必须有整包） */
export interface MockPluginLibraryEntry {
  cloud?: PluginPlatformSettings
  desktop?: { settings: PluginPlatformSettings; versions: MockDesktopVersion[] }
}

interface PluginLibraryState {
  scenario: MockScenario
  entries: Map<number, MockPluginLibraryEntry>
}

let libraryState: PluginLibraryState | null = null

function initialLibrary(scenario: MockScenario): Map<number, MockPluginLibraryEntry> {
  const entries = new Map<number, MockPluginLibraryEntry>()
  for (const seed of PLUGIN_SEED) {
    const desktop = DESKTOP_LIBRARY[seed.id]
    entries.set(seed.id, {
      cloud: platformSettings(seed),
      ...(desktop
        ? {
            desktop: {
              settings: platformSettings(seed, desktop.policy, 60 * 24 * 5),
              versions: desktop.versions.map((item) => ({ ...item })),
            },
          }
        : {}),
    })
  }
  if (scenario === 'plugins-bulk') {
    for (const row of bulkScenarioPlugins()) {
      // 批量场景：追加的插件两边都在库，批次演示里可以两边都选
      entries.set(row.id, {
        cloud: platformSettings(row),
        desktop: {
          settings: platformSettings(row, 'optional', 60 * 24 * 5),
          versions: [
            {
              id: row.id * 100 + 1000,
              version: row.latestVersion ?? '1.0.0',
            },
          ],
        },
      })
    }
  }
  return entries
}

/** 插件库的可变状态（按场景惰性初始化；换场景自动重置，测试之间不互相影响） */
export function mockPluginLibrary(scenario: MockScenario): Map<number, MockPluginLibraryEntry> {
  if (!libraryState || libraryState.scenario !== scenario) {
    libraryState = { scenario, entries: initialLibrary(scenario) }
  }
  return libraryState.entries
}

/** 测试用：把插件库恢复初始 */
export function resetPluginLibraryMock(): void {
  libraryState = null
}

/** 桌面版本行：id 与云上区分（契约允许同名版本号两边各一条），桌面版本必须带整包 */
function desktopVersionOf(
  seed: Omit<AdminPluginRow, 'platform' | 'platforms'>,
  item: MockDesktopVersion,
): PluginVersion {
  return pluginVersion(
    item.id,
    item.version,
    'npm',
    `${seed.packageName}@${item.version}`,
    item.version,
    60 * 24 * 5,
    null,
    null,
    'desktop',
  )
}

/** 桌面库里下一个版本 id（max + 1；空库从 seed*100+1000 起步） */
function nextDesktopVersionId(seed: Omit<AdminPluginRow, 'platform' | 'platforms'>, entry?: MockPluginLibraryEntry): number {
  const ids = entry?.desktop?.versions.map((item) => item.id) ?? []
  return ids.length > 0 ? Math.max(...ids) + 1 : seed.id * 100 + 1000
}

/** 某个平台视图下的一行（不在该平台库里 → null） */
function pluginRowFor(
  seed: Omit<AdminPluginRow, 'platform' | 'platforms'>,
  platform: PluginPlatform,
  entry: MockPluginLibraryEntry | undefined,
): AdminPluginRow | null {
  const settings = platform === 'cloud' ? entry?.cloud : entry?.desktop?.settings
  const desktopVersions = entry?.desktop?.versions ?? []
  if (!settings || (platform === 'desktop' && desktopVersions.length === 0)) return null
  const versions =
    platform === 'cloud'
      ? seed.versions.filter((version) => version.platform === 'cloud')
      : desktopVersions.map((item) => desktopVersionOf(seed, item))
  return {
    ...seed,
    platform,
    policy: settings.policy,
    latestVersion: versions[0]?.version ?? null,
    versions,
    platforms: {
      ...(entry?.cloud ? { cloud: entry.cloud } : {}),
      ...(entry?.desktop ? { desktop: entry.desktop.settings } : {}),
    },
    // 桌面库的行带桌面口径的安装统计（docs/22 §2.2；云上视图不给）；「较旧」按桌面最新版本算
    ...(platform === 'desktop' ? { desktopStats: mockDesktopStatsOf(seed.id, versions[0]?.version ?? null) } : {}),
  }
}

/** 某个平台视图下的插件目录（`GET /api/admin/plugins?platform=`） */
export function pluginCatalogFor(scenario: MockScenario, platform: PluginPlatform): AdminPluginRow[] {
  const library = mockPluginLibrary(scenario)
  const rows: AdminPluginRow[] = []
  for (const seed of PLUGIN_SEED) {
    const row = pluginRowFor(seed, platform, library.get(seed.id))
    if (row) rows.push(row)
  }
  return rows
}

/**
 * 桌面插件库的假目录（docs/22 §2：两平台两套库；统一下发向导与「整包清单」共用）。
 *
 * 库里的内容来自 {@link DESKTOP_LIBRARY}：邮件助手（桌面 0.16.0 / 0.15.0，版本 id 1101/1102）
 * 与文件下载器（1.0.0，id 1031）。IM 机器人与视频渲染**不在桌面库** —— 向导里显示
 * 「不在桌面插件库」、预览/提交把它们放进 `skippedItems`。
 */
export function desktopPluginCatalog(scenario: MockScenario): AdminPluginRow[] {
  return adminPluginCatalog(scenario, 'desktop')
}

/** 云上视图（静态版：种子表原样，桌面库是否存在的信息也在 `platforms` 里） */
export const ADMIN_PLUGINS: AdminPluginRow[] = PLUGIN_SEED.map((seed) => {
  const desktop = DESKTOP_LIBRARY[seed.id]
  return {
    ...seed,
    platform: 'cloud',
    platforms: {
      cloud: platformSettings(seed),
      ...(desktop ? { desktop: platformSettings(seed, desktop.policy, 60 * 24 * 5) } : {}),
    },
  }
})

/** 种子行（找不到就借第一行，mock 不因为 id 打错而崩） */
function pluginSeedOf(pluginId: number): Omit<AdminPluginRow, 'platform' | 'platforms'> {
  const seed = PLUGIN_SEED.find((item) => item.id === pluginId)
  if (seed) return seed
  const first = PLUGIN_SEED[0]
  if (!first) throw new Error('mock 插件种子表是空的')
  return first
}

/** 某个平台视图下的一行（详情页 / 增删改后的回包用） */
export function pluginRowIn(scenario: MockScenario, pluginId: number, platform: PluginPlatform): AdminPluginRow | null {
  const seed = PLUGIN_SEED.find((item) => item.id === pluginId)
  if (!seed) return null
  return pluginRowFor(seed, platform, mockPluginLibrary(scenario).get(pluginId))
}
/** 某个用户的插件行（用户详情的「插件」Tab 与插件详情的「装机情况」共用）。 */
/** 插件行的名称字段（04 §10.2）。 */
function pluginName(pluginId: number): { packageName: string; displayName: string } {
  const plugin = ADMIN_PLUGINS.find((item) => item.id === pluginId)
  return { packageName: plugin?.packageName ?? '', displayName: plugin?.displayName ?? '' }
}

/** 04 §10.2：插件行自带 packageName/displayName（页面不必再 join 插件目录）。 */
export function adminUserPluginRows(user: UserAdminView): UserPluginRow[] {
  return [
    {
      userId: user.id,
      username: user.username,
      pluginId: 1,
      ...pluginName(1),
      desired: 'installed',
      desiredVersionId: 11,
      actualVersionId: 11,
      actualVersion: '0.16.0',
      state: 'synced',
      source: 'policy',
      error: null,
      updatedAt: iso(60 * 20),
    },
    {
      userId: user.id,
      username: user.username,
      pluginId: 3,
      ...pluginName(3),
      desired: 'installed',
      desiredVersionId: 31,
      actualVersionId: 31,
      actualVersion: '1.0.0',
      state: 'synced',
      source: 'policy',
      error: null,
      updatedAt: iso(60 * 20),
    },
    {
      userId: user.id,
      username: user.username,
      pluginId: 2,
      ...pluginName(2),
      desired: 'absent',
      desiredVersionId: null,
      actualVersionId: null,
      actualVersion: null,
      state: 'pending',
      source: 'user',
      error: null,
      updatedAt: iso(35),
    },
    {
      userId: user.id,
      username: user.username,
      pluginId: 4,
      ...pluginName(4),
      desired: 'installed',
      desiredVersionId: 41,
      actualVersionId: null,
      actualVersion: null,
      state: 'failed',
      source: 'admin',
      error: 'pnpm install 失败：ETIMEDOUT registry.npmmirror.com',
      updatedAt: iso(18),
    },
  ]
}

// ── 实例 ────────────────────────────────────────────────────────────────────

const STATS_TABLE: InstanceStats[] = [
  {
    cpuPercent: 38.4,
    memoryBytes: Math.round(1.25 * GB),
    memoryLimitBytes: 2 * GB,
    pids: 86,
    diskBytes: Math.round(4 * GB),
    diskLimitBytes: 20 * GB,
  },
  {
    cpuPercent: 12.2,
    memoryBytes: Math.round(0.76 * GB),
    memoryLimitBytes: 2 * GB,
    pids: 41,
    diskBytes: Math.round(2 * GB),
    diskLimitBytes: 20 * GB,
  },
  {
    cpuPercent: 61.5,
    memoryBytes: Math.round(1.5 * GB),
    memoryLimitBytes: 2 * GB,
    pids: 132,
    diskBytes: Math.round(8 * GB),
    diskLimitBytes: 20 * GB,
  },
]

/**
 * 会话探针的假数据（WP33）：4 种状态轮着来，管理台「会话」列/详情在 mock 里能看全。
 *
 * 顺序是 busy → unattended → watching → unknown：列表里运行中的第 1、2 台正好显示
 * 「进行中 2」与「空闲 10 分钟（20 分钟后休眠）」，走查与截图能看见最长的一档文案（WP32d）。
 */
const PROBE_TABLE: InstanceProbe[] = [
  {
    state: 'busy',
    probeAt: iso(2),
    runningSessions: 2,
    openClients: 1,
    lastPromptAt: iso(3),
    lastBusyAt: iso(2),
    lastClientAt: iso(30),
    idleSince: null,
    stopAt: null,
  },
  {
    state: 'unattended',
    probeAt: iso(2),
    runningSessions: 0,
    openClients: 0,
    lastPromptAt: iso(70),
    lastBusyAt: iso(90),
    lastClientAt: iso(10),
    idleSince: iso(10),
    stopAt: iso(-20),
  },
  {
    state: 'watching',
    probeAt: iso(2),
    runningSessions: 0,
    openClients: 1,
    lastPromptAt: iso(40),
    lastBusyAt: iso(45),
    lastClientAt: iso(50),
    idleSince: iso(40),
    stopAt: iso(-80),
  },
  {
    state: 'unknown',
    probeAt: iso(2),
    runningSessions: null,
    openClients: 0,
    lastPromptAt: null,
    lastBusyAt: null,
    lastClientAt: null,
    idleSince: null,
    stopAt: null,
  },
]

export function adminInstances(): AdminInstanceRow[] {
  const users = [currentUserAsAdminView(), ...ADMIN_USERS.slice(1)]
  return users.map((user, index) => {
    const running = user.instance.status === 'running'
    return {
      user: userRef(user),
      instance: user.instance,
      stats: running ? (STATS_TABLE[index % STATS_TABLE.length] ?? null) : null,
      // WP33：stats 只读后台采样器的缓存，这个时刻说明样本有多旧
      statsAt: running ? iso(1) : null,
      probe: running ? (PROBE_TABLE[index % PROBE_TABLE.length] ?? null) : null,
      // 算力租赁（13 §6）：运行中的实例带进行中的租约，规格与状态标签由页面渲染
      lease: mockLeaseOfUser(user.id, user.instance.status),
    }
  })
}

/** `GET /api/admin/instances/stats`（WP33）：与列表同口径的缓存快照 */
export function adminInstanceStats(): AdminInstanceStatsRow[] {
  return adminInstances()
    .filter((row) => row.instance.status === 'running')
    .map((row) => ({ userId: row.user.id, stats: row.stats, statsAt: row.statsAt ?? null }))
}

// ── 模型 ────────────────────────────────────────────────────────────────────

export const ADMIN_PROVIDERS: ModelProvider[] = [
  {
    // hub-relay（12 §7）：地址、模型列表、密钥都由 Hub 决定，管理员只选路由名 / 显示名 / 协议
    // WP13：系统提供方的显示名一律 DSH_HUB_PROVIDER_NAME（用户在 DSH 里看到的分组名）
    id: 1,
    routeKey: 'hub',
    displayName: 'DSH Hub',
    kind: 'hub-relay',
    api: 'openai-completions',
    baseUrl: 'http://10.213.0.1:7710/v1',
    models: [
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        contextWindow: 1000000,
        maxTokens: 384000,
        input: ['text', 'image'],
        reasoningEfforts: ['low', 'high', 'max'],
      },
      { id: 'deepseek-v3', name: 'DeepSeek V3', contextWindow: 131072, maxTokens: 8192, input: ['text'] },
      { id: 'qwen3-coder', name: 'Qwen3 Coder', contextWindow: 262144, maxTokens: 16384, input: ['text'] },
    ],
    compat: null,
    extra: null,
    keyMode: 'per-user',
    apiKey: { set: true, last4: null },
    enabled: true,
    createdAt: iso(60 * 24 * 50),
    updatedAt: iso(60 * 24 * 2),
  },
  {
    id: 2,
    routeKey: 'deepseek',
    displayName: 'DeepSeek 官方',
    kind: 'deepseek-official',
    api: null,
    baseUrl: null,
    models: [],
    compat: null,
    extra: null,
    keyMode: 'shared',
    apiKey: { set: true, last4: 'c1d2' },
    enabled: true,
    createdAt: iso(60 * 24 * 50),
    updatedAt: iso(60 * 24 * 20),
  },
  {
    id: 3,
    routeKey: 'local-vllm',
    displayName: '内网 vLLM',
    kind: 'pi-ai',
    api: 'openai-completions',
    baseUrl: 'http://10.0.0.9:8000/v1',
    models: [{ id: 'qwen2.5-32b', name: 'Qwen2.5 32B', contextWindow: 32768 }],
    compat: { supportsVision: false },
    extra: { timeoutMs: 60000 },
    keyMode: 'none',
    apiKey: { set: false, last4: null },
    enabled: false,
    createdAt: iso(60 * 24 * 12),
    updatedAt: iso(60 * 24 * 12),
  },
]

export const ADMIN_PRESETS: ModelPreset[] = [
  {
    id: 1,
    platform: 'cloud',
    name: '默认',
    description: '中转站主力模型 + DeepSeek 官方兜底',
    providerIds: [1, 2],
    defaultProvider: 'hub',
    defaultModel: 'deepseek-v4.1-flash',
    isDefault: true,
    revision: 7,
    usersOnIt: 4,
    createdAt: iso(60 * 24 * 50),
    updatedAt: iso(60 * 24 * 2),
  },
  {
    id: 2,
    platform: 'cloud',
    name: '省钱模式',
    description: '只用内网 vLLM，适合跑批量任务',
    providerIds: [3],
    defaultProvider: 'local-vllm',
    defaultModel: 'qwen2.5-32b',
    isDefault: false,
    revision: 2,
    usersOnIt: 1,
    createdAt: iso(60 * 24 * 10),
    updatedAt: iso(60 * 24 * 10),
  },
  {
    id: 3,
    platform: 'desktop',
    name: '桌面默认',
    description: '桌面端自带的渠道模型（docs/22 §3：每个平台一个默认预设）',
    providerIds: [1, 2],
    defaultProvider: 'hub',
    defaultModel: 'deepseek-v4.1-flash',
    isDefault: true,
    revision: 4,
    usersOnIt: 2,
    createdAt: iso(60 * 24 * 40),
    updatedAt: iso(60 * 24),
  },
]

export const ADMIN_PRESET_PREVIEW = `# 由 DSH Hub 生成，请勿手改 —— preset "默认" r7
# 用户 mint · runtime 0.2.0-rc.2
- id: llm-pi-ai
  config:
    providers:
      hub:
        displayName: DSH Hub
        api: openai-completions
        baseURL: http://10.213.0.1:7710/v1
        apiKeyEnv: HUB_MK_HUB
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
- id: agent-default-model
  config:
    provider: hub
    model: deepseek-v4.1-flash
# —— 默认工作区根（总是输出）——
- id: workspace-controller
  config:
    documentsDirectory: /workspace
# —— 以下为插件配置（按 bundle_order）——
- id: workspace-files
  config: { maxFileBytes: 1073741824, maxBytes: 2097152, maxLines: 5000, maxEntries: 2000 }
`

// ── DSH 版本 ────────────────────────────────────────────────────────────────

export const ADMIN_RUNTIMES: AdminRuntimeRow[] = [
  {
    id: 2,
    dshVersion: '0.2.0-rc.2',
    image: 'dshhub/runtime:0.2.0-rc.2',
    status: 'ready',
    isDefault: true,
    sizeBytes: GB,
    usersOnIt: 4,
    createdAt: iso(60 * 24 * 6),
    notes: '修复 SSE 断线重连；新增 workspace 配额上报',
  },
  {
    id: 1,
    dshVersion: '0.1.0',
    image: 'dshhub/runtime:0.1.0',
    status: 'ready',
    isDefault: false,
    sizeBytes: 1_020_000_000,
    usersOnIt: 1,
    createdAt: iso(60 * 24 * 30),
    notes: '第一个可用版本',
  },
  {
    id: 3,
    dshVersion: '0.2.0-rc.3',
    image: 'dshhub/runtime:0.2.0-rc.3',
    status: 'building',
    isDefault: false,
    sizeBytes: null,
    usersOnIt: 0,
    createdAt: iso(6),
    notes: '试构建：升级 Node 依赖',
  },
]

// ── 任务 ────────────────────────────────────────────────────────────────────

export const ADMIN_JOBS: JobSummary[] = [
  {
    id: 1042,
    type: 'rollout.plugin',
    title: '安装 邮件助手 0.16.0 → 5 位用户',
    status: 'running',
    total: 5,
    done: 3,
    failed: 1,
    createdBy: 1,
    createdByUsername: 'admin',
    createdAt: iso(9),
    startedAt: iso(8),
    finishedAt: null,
    error: null,
  },
  {
    id: 1041,
    type: 'runtime.build',
    title: '构建 DSH 0.2.0-rc.3',
    status: 'running',
    total: 1,
    done: 0,
    failed: 0,
    createdBy: 1,
    createdByUsername: 'admin',
    createdAt: iso(6),
    startedAt: iso(6),
    finishedAt: null,
    error: null,
  },
  {
    id: 1040,
    type: 'rollout.runtime',
    title: 'DSH 升级到 0.2.0-rc.2 → 4 位用户',
    status: 'partial',
    total: 4,
    done: 4,
    failed: 1,
    createdBy: 1,
    createdByUsername: 'admin',
    createdAt: iso(60 * 26),
    startedAt: iso(60 * 26),
    finishedAt: iso(60 * 25),
    error: '1 位用户重建失败：镜像拉取超时',
  },
  {
    id: 1039,
    type: 'export',
    title: '导出 薄荷茶 的数据',
    status: 'succeeded',
    total: 1,
    done: 1,
    failed: 0,
    createdBy: 2,
    createdByUsername: 'mint',
    createdAt: iso(60 * 30),
    startedAt: iso(60 * 30),
    finishedAt: iso(60 * 30 - 3),
    error: null,
  },
  {
    id: 1038,
    type: 'rollout.models',
    title: '下发模型预设 默认 → 全部用户',
    status: 'paused',
    total: 6,
    done: 2,
    failed: 1,
    createdBy: 1,
    createdByUsername: 'admin',
    createdAt: iso(60 * 48),
    startedAt: iso(60 * 48),
    finishedAt: null,
    error: null,
  },
  {
    id: 1037,
    type: 'rollout.plugin',
    title: '卸载 IM 机器人 → 2 位用户',
    status: 'canceled',
    total: 2,
    done: 1,
    failed: 0,
    createdBy: 1,
    createdByUsername: 'admin',
    createdAt: iso(60 * 72),
    startedAt: iso(60 * 72),
    finishedAt: iso(60 * 71),
    error: null,
  },
]

export const ADMIN_JOB_TASKS: JobTaskSummary[] = [
  {
    id: 9001,
    seq: 1,
    userId: 1,
    username: 'admin',
    status: 'succeeded',
    attempt: 1,
    startedAt: iso(8),
    finishedAt: iso(7),
    error: null,
  },
  {
    id: 9002,
    seq: 2,
    userId: 2,
    username: 'mint',
    status: 'succeeded',
    attempt: 1,
    startedAt: iso(7),
    finishedAt: iso(6),
    error: null,
  },
  {
    id: 9003,
    seq: 3,
    userId: 4,
    username: 'sakura',
    status: 'failed',
    attempt: 2,
    startedAt: iso(6),
    finishedAt: iso(5),
    error: 'pnpm install 失败：ETIMEDOUT registry.npmmirror.com',
  },
  {
    id: 9004,
    seq: 4,
    userId: 5,
    username: 'butter',
    status: 'running',
    attempt: 1,
    startedAt: iso(4),
    finishedAt: null,
    error: null,
  },
  {
    id: 9005,
    seq: 5,
    userId: 6,
    username: 'quiet-leaf',
    status: 'pending',
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  },
]

export const ADMIN_JOB_LOG = `[21:22:01] 目标 mint（u3p8q1z2）：当前未安装
[21:22:01] 读取 users/u3p8q1z2/home/.dsh/profiles/web/package.json
[21:22:02] 备份 package.json → package.json.hub-bak-20261012-212202
[21:22:02] $ dsh plugin --profile web add dsh-email@0.16.0
[21:22:09] added 12 packages in 6.4s
[21:22:09] 改写 dsh.profile.bundles：workspace-files → dsh-email（按 bundle_order）
[21:22:09] 更新 dshHub.managed：dsh-email = 0.16.0
[21:22:10] 重渲染 managed/managed.patch.yml.tmp → rename
[21:22:10] 重启 DSH（needs_restart=true）
[21:22:24] 就绪检查：GET /dsh/mint/ → 200（11.8s）
[21:22:24] task 完成：实际版本 0.16.0`

// ── 邀请码 / 设置 / 审计 / 概览 ─────────────────────────────────────────────

export const ADMIN_INVITES: InviteRow[] = [
  {
    id: 1,
    code: 'ABCD2345EFGH',
    // 极端值（WP14b 走查）：长备注只换行、不把整表撑坏
    note: '给产品群的三位同学，周五之前注册都算这一批，过期了跟我说一声我再发一批新的',
    maxUses: 3,
    usedCount: 2,
    expiresAt: iso(-60 * 24 * 7),
    disabled: false,
    createdBy: 1,
    createdAt: iso(60 * 24 * 3),
    roleLabel: '家人',
    uses: [
      { userId: 2, username: 'mint', usedAt: iso(60 * 24 * 2) },
      { userId: 5, username: 'butter', usedAt: iso(60 * 30) },
    ],
  },
  {
    id: 2,
    code: 'JKLM6789NPQR',
    note: '一次性邀请',
    maxUses: 1,
    usedCount: 1,
    expiresAt: null,
    disabled: false,
    createdBy: 1,
    createdAt: iso(60 * 24 * 10),
    roleLabel: '朋友',
    uses: [{ userId: 3, username: 'skywalker', usedAt: iso(60 * 5) }],
  },
  {
    id: 3,
    code: 'STUV2345WXYZ',
    note: '已停用',
    maxUses: 5,
    usedCount: 0,
    expiresAt: iso(60 * 24 * 30),
    disabled: true,
    createdBy: 1,
    createdAt: iso(60 * 24),
    // 只在邀请码上出现的标签：候选里有它，但人数是 0（04 §4.2）
    roleLabel: '同事',
    uses: [],
  },
]

export const ADMIN_SETTINGS: Settings = {
  site: {
    name: 'DSH Hub',
    tagline: '探索未至之境',
    announcement: '本周六 22:00–23:00 升级到 0.2.0-rc.2，期间实例会自动重启一次。',
    announcementLevel: 'info',
  },
  registration: { mode: 'invite', requireApproval: true, maxUsers: 50 },
  default_quota: {
    cpus: 2,
    memoryMb: 4096,
    pidsLimit: 1024,
    diskGb: 20,
    idleStopMinutes: 120,
    idleNoClientMinutes: 30,
    allowUserPlugins: true,
  },
  capacity: { maxRunning: 12, maxConcurrentExports: 2, busyMaxMinutes: 720 },
  exports: { ttlHours: 24, maxBytes: 20 * GB, dailyLimit: 5 },
  security: { adminSessionHours: 12, reauthMinutes: 10 },
  // 桌面端设备台账（WP25a；mock 里只补默认值，桌面 UI 由 WP25c 做）
  desktop: {
    maxDevicesPerUser: 5,
    reportIntervalSec: 60,
    minReportIntervalSec: 10,
    offlineAfterSec: 180,
    diagnosticsAllowed: false,
  },
  // 手机 App（WP40a）：版本地板默认不拦任何版本
  mobile: { app: { minVersionCode: 1, latestVersionCode: 1, downloadUrl: null } },
  // 容器设置（WP40d）：与 shared 的 DEFAULT_SETTINGS 保持一致
  container: { permissionPreset: 'danger-full-access', chatPreset: true },
  // 管理座舱（WP56a）：与 shared 的 DEFAULT_SETTINGS 保持一致
  cockpit: { model: 'deepseek-v4.1-flash', autoExecuteR1: true },
}

interface AuditSeed {
  action: string
  actorId: number | null
  actorUsername: string | null
  targetType: string | null
  targetId: string | null
  minutesAgo: number
}

const AUDIT_SEEDS: AuditSeed[] = [
  {
    action: 'auth.login.success',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'user',
    targetId: '1',
    minutesAgo: 2,
  },
  {
    action: 'user.approve',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'user',
    targetId: '3',
    minutesAgo: 12,
  },
  {
    action: 'rollout.create',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'job',
    targetId: '1042',
    minutesAgo: 9,
  },
  {
    action: 'plugin.version.add',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'plugin',
    targetId: '4',
    minutesAgo: 18,
  },
  {
    action: 'instance.recreate',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'instance',
    targetId: '4',
    minutesAgo: 26,
  },
  {
    action: 'model.provider.key.change',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'provider',
    targetId: '1',
    minutesAgo: 41,
  },
  {
    action: 'settings.update',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'settings',
    targetId: 'site',
    minutesAgo: 75,
  },
  {
    action: 'invite.create',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'invite',
    targetId: '3',
    minutesAgo: 90,
  },
  {
    action: 'user.quota.change',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'user',
    targetId: '4',
    minutesAgo: 130,
  },
  {
    action: 'export.download',
    actorId: 2,
    actorUsername: 'mint',
    targetType: 'export',
    targetId: '1039',
    minutesAgo: 180,
  },
  {
    action: 'auth.login.failure',
    actorId: null,
    actorUsername: null,
    targetType: 'user',
    targetId: 'quiet-leaf',
    minutesAgo: 200,
  },
  {
    action: 'user.disable',
    actorId: 1,
    actorUsername: 'admin',
    targetType: 'user',
    targetId: '6',
    minutesAgo: 240,
  },
]

export const ADMIN_AUDIT: AuditItem[] = AUDIT_SEEDS.map((seed, index) => ({
  id: 5000 - index,
  at: iso(seed.minutesAgo),
  actorId: seed.actorId,
  actorIp: seed.actorId ? '127.0.0.1' : '203.0.113.7',
  actorUsername: seed.actorUsername,
  action: seed.action,
  targetType: seed.targetType,
  targetId: seed.targetId,
  detail: seed.action === 'settings.update' ? { key: 'site', changed: ['announcement'] } : { note: 'mock' },
}))

export function adminOverview(): AdminOverviewResponse {
  const users = ADMIN_USERS
  return {
    users: {
      total: users.length,
      active: users.filter((user) => user.status === 'active').length,
      pending: users.filter((user) => user.status === 'pending').length,
      disabled: users.filter((user) => user.status === 'disabled').length,
      newToday: 1,
    },
    instances: { running: 3, max: 12, starting: 1, error: 1 },
    host: {
      cpuCount: 16,
      load1: 2.42,
      load5: 1.98,
      memTotal: 32 * GB,
      memAvailable: Math.round(18 * GB),
      diskTotal: 1000 * GB,
      diskFree: Math.round(650 * GB),
      dockerOk: true,
      dockerVersion: '27.3.1',
    },
    jobs: { running: 2, queued: 1, failedLast24h: 1 },
    runtime: { defaultVersion: '0.2.0-rc.2', versions: ADMIN_RUNTIMES.length },
    recent: { registrations: users.slice(1, 5), audit: ADMIN_AUDIT.slice(0, 8) },
  }
}

// ── 请求分发 ────────────────────────────────────────────────────────────────

/** 矩阵里的用户摘要（04 §10.1 的 `user` 字段）。 */
function matrixUser(user: UserAdminView): {
  id: number
  slug: string
  username: string
  displayName: string
  avatarUrl: string | null
  status: UserAdminView['status']
} {
  return {
    id: user.id,
    slug: user.slug,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
  }
}

// ── 模型信息库（内存里的假库：加 / 删能在页面上走通）──

/** 假的内置库：只放几条，够演示「发现 → 自动匹配」 */
const MOCK_BUILTIN_CATALOG: (ModelInfo & { id: string })[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text', 'image'],
    reasoningEfforts: ['low', 'high', 'max'],
  },
  { id: 'deepseek-chat', name: 'DeepSeek V3', contextWindow: 131_072, maxTokens: 8192, input: ['text'] },
  { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, maxTokens: 16_384, input: ['text', 'image'] },
]

let mockCatalog: CatalogEntry[] = [
  {
    id: 'my-relay/deepseek-chat',
    key: 'deepseek-chat',
    maxTokens: 4096,
    updatedAt: iso(60 * 24),
  },
]

/** 假匹配只做最朴素的规范化（小写 + 非字母数字 → -），真逻辑在服务端 */
const mockKey = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, '-')

function mockMatch(id: string): { source: 'custom' | 'builtin'; matchedId: string; info: ModelInfo } | null {
  const key = mockKey(id)
  const custom = mockCatalog.find((entry) => entry.key === key)
  const builtin = MOCK_BUILTIN_CATALOG.find((entry) => mockKey(entry.id) === key)
  if (!custom && !builtin) return null
  const strip = ({
    id: _id,
    key: _key,
    updatedAt: _updatedAt,
    ...info
  }: Record<string, unknown>): ModelInfo => info as ModelInfo
  return {
    source: custom ? 'custom' : 'builtin',
    matchedId: (custom ?? builtin)!.id,
    info: { ...(builtin ? strip(builtin) : {}), ...(custom ? strip(custom) : {}) },
  }
}

const MOCK_DISCOVERED: DiscoveredModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text', 'image'],
    reasoningEfforts: ['low', 'high', 'max'],
    infoSource: 'builtin',
    matchedId: 'deepseek-v4.1-flash',
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    contextWindow: 131_072,
    maxTokens: 4096,
    input: ['text'],
    infoSource: 'custom',
    matchedId: 'my-relay/deepseek-chat',
  },
  { id: 'qwen3-coder', name: 'qwen3-coder', contextWindow: 262_144, infoSource: 'upstream' },
  { id: 'my-internal-llm', name: 'my-internal-llm' },
]

const paged = <T>(items: T[]): { items: T[]; total: number; page: number; pageSize: number } => ({
  items,
  total: items.length,
  page: 1,
  pageSize: Math.max(items.length, 20),
})

/** 假接口的 `q` 搜索：用户名 / 昵称包含即可（与后端列表、回收站两个接口一致） */
function filterByText<T extends { username: string; displayName: string }>(
  items: T[],
  q: string | null,
): T[] {
  const keyword = (q ?? '').trim().toLowerCase()
  if (!keyword) return items
  return items.filter(
    (item) =>
      item.username.toLowerCase().includes(keyword) || item.displayName.toLowerCase().includes(keyword),
  )
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const apiError = (code: string, status: number, message: string): Response =>
  json({ error: { code, message, details: {} } }, status)

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

/** 场景是否为管理端（`?mock=admin` / `admin-empty` / `admin-tools-off`）。 */
export function isAdminScenario(scenario: MockScenario): boolean {
  return (
    scenario === 'admin' ||
    scenario === 'admin-empty' ||
    scenario === 'admin-empty-dsh' ||
    scenario === 'admin-no-relay' ||
    scenario === 'admin-tools-off' ||
    scenario === 'agent-modes' ||
    scenario === 'admin-batch' ||
    scenario === 'admin-desktop' ||
    scenario === 'admin-desktop-empty' ||
    scenario === 'admin-desktop-failed' ||
    scenario === 'admin-desktop-warn' ||
    // WP28c：插件库多选批量的走查场景（11 个插件、两页、含 policy=hidden）
    scenario === 'plugins-bulk' ||
    // WP28b：统一下发向导的四个场景
    scenario === 'delivery' ||
    scenario === 'delivery-desktop-only' ||
    scenario === 'delivery-warnings' ||
    scenario === 'delivery-truncated' ||
    // WP56c：管理座舱（座舱里的实体卡 / 经典页面都要能读管理端假数据）
    isCockpitScenario(scenario)
  )
}

/** `admin-no-relay` 场景：去掉 hub-relay 提供方，演示「DSH 配置」的接入引导卡（12 §10） */
function providersFor(scenario: MockScenario): ModelProvider[] {
  return scenario === 'admin-no-relay'
    ? ADMIN_PROVIDERS.filter((provider) => provider.kind !== 'hub-relay')
    : ADMIN_PROVIDERS
}

/** 由调用方注入的额外数据块（避免 admin ↔ desktop 两个假接口模块互相 import 成环） */
export interface AdminMockExtras {
  /** `GET /api/admin/overview` 的 `desktop` 计数（WP25e 的可选字段，WP25f 交付物 4/9） */
  desktop?: () => DesktopOverviewCounts
}

/**
 * 管理端假接口。命中返回 `Response`，未命中返回 `null`（调用方透传真后端）。
 * `method` 已经是大写。
 */
export async function handleAdmin(
  pathname: string,
  method: string,
  init?: RequestInit,
  query: URLSearchParams = new URLSearchParams(),
  extras: AdminMockExtras = {},
): Promise<Response | null> {
  const scenario = getMockState().scenario
  const users = scenario === 'admin-empty' ? [] : [currentUserAsAdminView(), ...ADMIN_USERS.slice(1)]
  const filteredUsers = filterByText(users, query.get('q'))
  const filteredDeleted = filterByText(scenario === 'admin-empty' ? [] : deletedUsers, query.get('q'))

  // 概览
  if (pathname === '/api/admin/overview' && method === 'GET') {
    const overview = adminOverview()
    const withDesktop = extras.desktop ? { ...overview, desktop: extras.desktop() } : overview
    if (scenario === 'admin-empty') {
      return json({
        ...withDesktop,
        users: { total: 0, active: 0, pending: 0, disabled: 0, newToday: 0 },
        runtime: { defaultVersion: null, versions: 0 },
        recent: { registrations: [], audit: [] },
      })
    }
    return json(withDesktop)
  }

  // 用户
  if (pathname === '/api/admin/users' && method === 'GET') return json(paged(filteredUsers))
  // 回收站（WP22 / 04 §4.2）：只列「删了但没彻底删」的，按删除时间倒序
  if (pathname === '/api/admin/users/deleted' && method === 'GET') return json(paged(filteredDeleted))
  if (pathname === '/api/admin/users/role-labels' && method === 'GET') {
    const counts = new Map<string, number>()
    for (const user of users) {
      if (user.role === 'user' && user.roleLabel)
        counts.set(user.roleLabel, (counts.get(user.roleLabel) ?? 0) + 1)
    }
    // 口径与后端一致（04 §4.2）：用户标签 ∪ 邀请码上的标签，count 始终是用户人数
    // （只在邀请码上出现的给 0），人数倒序、同数按标签名升序
    const invites = scenario === 'admin-empty' ? [] : ADMIN_INVITES
    for (const invite of invites) {
      if (invite.roleLabel) counts.set(invite.roleLabel, counts.get(invite.roleLabel) ?? 0)
    }
    const items = [...counts]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    return json({ items })
  }
  if (pathname === '/api/admin/users' && method === 'POST') {
    const body = readJson(init)
    const created = makeAdminUser({
      id: 99,
      slug: 'u9z8y7x6',
      username: typeof body.username === 'string' ? body.username : 'newcomer',
      displayName: typeof body.displayName === 'string' && body.displayName ? body.displayName : '新同学',
      role: body.role === 'admin' ? 'admin' : 'user',
      roleLabel: typeof body.roleLabel === 'string' ? body.roleLabel : '',
      status: 'active',
      instanceStatus: 'absent',
      createdMinutesAgo: 0,
      lastLoginMinutesAgo: 0,
    })
    return json({ user: created, tempPassword: body.password ? undefined : 'TempPass123456' }, 201)
  }

  const userDetail = /^\/api\/admin\/users\/(\d+)$/.exec(pathname)
  if (userDetail) {
    const id = Number(userDetail[1])
    const user = users.find((item) => item.id === id) ?? users[0] ?? currentUserAsAdminView()
    if (method === 'GET') {
      return json({
        user,
        plugins: adminUserPluginRows(user),
        sessions: 2,
        recentAudit: ADMIN_AUDIT.slice(0, 6),
        // 04 §10.3：列出所有 per-user 模式的提供方，以及该用户是否已设置专属密钥
        providerKeys: ADMIN_PROVIDERS.filter((provider) => provider.keyMode === 'per-user').map(
          (provider, index) => ({
            providerId: provider.id,
            routeKey: provider.routeKey,
            displayName: provider.displayName,
            keyMode: provider.keyMode,
            set: user.id % 2 === 0 && index === 0,
            last4: user.id % 2 === 0 && index === 0 ? '9f3a' : null,
          }),
        ),
      })
    }
    if (method === 'PATCH') return json({ user: { ...user, ...(readJson(init) as Partial<UserAdminView>) } })
  }

  if (
    /^\/api\/admin\/users\/\d+\/(approve|revoke-sessions|reset-password)$/.test(pathname) &&
    method === 'POST'
  ) {
    if (pathname.endsWith('/revoke-sessions')) return json({ revoked: 2 })
    if (pathname.endsWith('/reset-password')) return json({ tempPassword: 'Reset123456789' })
    return json({ user: users[1] ?? currentUserAsAdminView() })
  }
  if (/^\/api\/admin\/users\/\d+$/.test(pathname) && method === 'DELETE')
    return new Response(null, { status: 204 })

  // 回收站：恢复 / 彻底删除（WP22，都需要 reauth，假接口不校验）
  const restoreTarget = /^\/api\/admin\/users\/(\d+)\/restore$/.exec(pathname)
  if (restoreTarget && method === 'POST') {
    const row = deletedUsers.find((item) => item.id === Number(restoreTarget[1]))
    if (!row) return apiError('NOT_FOUND', 404, '这个用户不在回收站里')
    const body = readJson(init)
    const username = typeof body.username === 'string' && body.username ? body.username : row.username
    if (users.some((user) => user.username === username)) {
      return apiError('USERNAME_TAKEN', 409, `用户名「${username}」已被占用，换一个再恢复`)
    }
    if (!USERNAME_REGEX.test(username)) {
      return apiError('VALIDATION_FAILED', 400, '用户名只能用小写字母、数字、- 和 _')
    }
    deletedUsers = deletedUsers.filter((item) => item.id !== row.id)
    const restored = makeAdminUser({
      id: row.id,
      slug: row.slug,
      username,
      displayName: row.displayName,
      role: row.role,
      roleLabel: row.roleLabel,
      status: row.deletedFromStatus ?? 'active',
      instanceStatus: 'absent',
    })
    return json({ user: restored })
  }
  const purgeTarget = /^\/api\/admin\/users\/(\d+)\/purge$/.exec(pathname)
  if (purgeTarget && method === 'POST') {
    deletedUsers = deletedUsers.filter((item) => item.id !== Number(purgeTarget[1]))
    return new Response(null, { status: 204 })
  }

  // 实例
  if (pathname === '/api/admin/instances' && method === 'GET') return json(adminInstances())
  if (pathname === '/api/admin/instances/stats' && method === 'GET') return json(adminInstanceStats())
  if (/^\/api\/admin\/instances\/\d+\/(start|stop|restart|recreate)$/.test(pathname) && method === 'POST') {
    const id = Number(pathname.split('/')[4])
    const user = users.find((item) => item.id === id) ?? users[0] ?? currentUserAsAdminView()
    const action = pathname.split('/').pop()
    const nextStatus = action === 'stop' ? 'stopped' : action === 'start' ? 'starting' : user.instance.status
    return json({ instance: { ...user.instance, status: nextStatus } }, 202)
  }
  if (/^\/api\/admin\/instances\/\d+\/logs$/.test(pathname) && method === 'GET')
    return json({ text: ADMIN_JOB_LOG })

  // 插件（`plugins-bulk` 场景会多带几个，见文件末尾的 `adminPluginCatalog`）
  if (pathname === '/api/admin/plugins' && method === 'GET') {
    const platform = query.get('platform') === 'desktop' ? 'desktop' : 'cloud'
    return json(adminPluginCatalog(scenario, platform))
  }
  // docs/22 §2.2：插件平台库的增 / 改 / 移出（有桌面下发目标时移出要 force）
  const platformTarget = /^\/api\/admin\/plugins\/(\d+)\/platforms(?:\/(cloud|desktop))?$/.exec(pathname)
  if (platformTarget) {
    const pluginId = Number(platformTarget[1])
    const pathPlatform = platformTarget[2]
    const seed = pluginSeedOf(pluginId)
    const library = mockPluginLibrary(scenario)
    const entry = library.get(pluginId) ?? {}
    const body = readJson(init)

    if (method === 'POST' && pathPlatform === undefined) {
      const platform = body['platform'] === 'desktop' ? 'desktop' : 'cloud'
      if (platform === 'desktop') {
        entry.desktop = {
          settings: platformSettings(seed, (body['policy'] as AdminPluginRow['policy']) ?? 'optional'),
          versions: [{ id: nextDesktopVersionId(seed, entry), version: seed.latestVersion ?? '1.0.0' }],
        }
      } else {
        entry.cloud = platformSettings(seed, (body['policy'] as AdminPluginRow['policy']) ?? seed.policy)
      }
      library.set(pluginId, entry)
      const row = pluginRowIn(scenario, pluginId, platform)
      if (!row) return apiError('NOT_FOUND', 404, '插件不存在')
      return json({ plugin: row }, 201)
    }

    if (method === 'PATCH' && (pathPlatform === 'cloud' || pathPlatform === 'desktop')) {
      const current =
        pathPlatform === 'cloud'
          ? entry.cloud
          : entry.desktop?.settings
      if (!current) return apiError('NOT_FOUND', 404, '这个平台还没有这个插件')
      const policy = typeof body['policy'] === 'string' ? (body['policy'] as AdminPluginRow['policy']) : current.policy
      const next: PluginPlatformSettings = {
        ...current,
        policy,
        bundleOrder: typeof body['bundleOrder'] === 'number' ? body['bundleOrder'] : current.bundleOrder,
        configYaml: typeof body['configYaml'] === 'string' ? body['configYaml'] : current.configYaml,
        needsRestart: typeof body['needsRestart'] === 'boolean' ? body['needsRestart'] : current.needsRestart,
        updatedAt: iso(0),
      }
      if (pathPlatform === 'cloud') entry.cloud = next
      else if (entry.desktop) entry.desktop = { ...entry.desktop, settings: next }
      library.set(pluginId, entry)
      const row = pluginRowIn(scenario, pluginId, pathPlatform)
      if (!row) return apiError('NOT_FOUND', 404, '插件不存在')
      return json({ plugin: row })
    }

    if (method === 'DELETE' && (pathPlatform === 'cloud' || pathPlatform === 'desktop')) {
      const force = query.get('force') === '1' || query.get('force') === 'true'
      // 邮件助手在桌面端有下发目标（见 mocks/desktop-delivery）：不 force 就拒绝，让界面走二次密码 + force
      if (pathPlatform === 'desktop' && pluginId === 1 && !force) {
        return apiError('CONFLICT', 409, '这个插件还有桌面端下发目标，先撤销目标或带上 force')
      }
      if (pathPlatform === 'cloud') delete entry.cloud
      else delete entry.desktop
      library.set(pluginId, entry)
      return new Response(null, { status: 204 })
    }
  }
  // GET = npm / 本地目录；POST = 上传 .tgz 预读 package.json（mock 不真的解包，返回固定样例）
  if (pathname === '/api/admin/plugins/lookup' && (method === 'GET' || method === 'POST')) {
    return json({
      packageName: 'dsh-email',
      displayName: '邮件助手',
      description: '让 DSH 收发邮件、整理收件箱。',
      homepage: 'https://www.npmjs.com/package/dsh-email',
      versions: ['0.16.0', '0.15.0'],
      latest: '0.16.0',
      isBundle: true,
      needsRestart: true,
    })
  }
  // 04 §10.1：装机情况返回全量用户矩阵（row=null 表示从未安装）
  if (/^\/api\/admin\/plugins\/\d+\/users$/.test(pathname) && method === 'GET') {
    const pluginId = Number(pathname.split('/')[4])
    return json({
      items: users.map((user, index) => {
        if (index === 2) return { user: matrixUser(user), row: null }
        const row = adminUserPluginRows(user).find((item) => item.pluginId === pluginId)
        if (!row) return { user: matrixUser(user), row: null }
        return {
          user: matrixUser(user),
          row:
            index === 4
              ? { ...row, state: 'pending' as const, actualVersion: null, actualVersionId: null }
              : row,
        }
      }),
    })
  }
  if (/^\/api\/admin\/plugins\/\d+\/versions$/.test(pathname) && method === 'POST') {
    const pluginId = Number(pathname.split('/')[4])
    const platform = query.get('platform') === 'desktop' ? 'desktop' : 'cloud'
    if (platform === 'desktop') {
      // 桌面整包上传：登记成这个插件在桌面库里的最新版本（版本号自增，方便连着传两版）
      const entry = mockPluginLibrary(scenario).get(pluginId) ?? {}
      const current = entry.desktop?.versions[0]?.version ?? '1.0.0'
      const nextVersion = `${current.replace(/-.*$/u, '').split('.').slice(0, 2).join('.')}.${
        Number(current.split('.').at(-1) ?? 0) + 1
      }`
      const seed = pluginSeedOf(pluginId)
      const item: MockDesktopVersion = { id: nextDesktopVersionId(seed, entry), version: nextVersion }
      entry.desktop = {
        settings: entry.desktop?.settings ?? platformSettings(seed, 'optional'),
        versions: [item, ...(entry.desktop?.versions ?? [])],
      }
      mockPluginLibrary(scenario).set(pluginId, entry)
      return json({ version: desktopVersionOf(seed, item) }, 201)
    }
    return json({ version: pluginVersion(99, '9.9.9', 'npm', 'demo@9.9.9', '9.9.9', 0) }, 201)
  }
  if (/^\/api\/admin\/plugins\/\d+\/versions\/\d+$/.test(pathname) && method === 'DELETE') {
    return new Response(null, { status: 204 })
  }
  if (pathname === '/api/admin/plugins' && method === 'POST') return json(ADMIN_PLUGINS[0], 201)
  const pluginPatch = /^\/api\/admin\/plugins\/(\d+)$/.exec(pathname)
  if (pluginPatch) {
    const plugin = ADMIN_PLUGINS.find((item) => item.id === Number(pluginPatch[1])) ?? ADMIN_PLUGINS[0]
    if (method === 'PATCH') return json({ ...plugin, ...(readJson(init) as Partial<AdminPluginRow>) })
    if (method === 'DELETE') return new Response(null, { status: 204 })
  }

  // DSH 版本
  if (pathname === '/api/admin/runtimes' && method === 'GET')
    return json(scenario === 'admin-empty' ? [] : ADMIN_RUNTIMES)
  if (pathname === '/api/admin/runtimes/available' && method === 'GET') {
    return json({ versions: ['0.2.0-rc.3', '0.2.0-rc.2', '0.1.0'], latest: '0.2.0-rc.3', next: '0.2.0-rc.3' })
  }
  if (pathname === '/api/admin/runtimes' && method === 'POST')
    return json({ runtime: ADMIN_RUNTIMES[2], jobId: 1043 }, 202)
  const runtimePatch = /^\/api\/admin\/runtimes\/(\d+)$/.exec(pathname)
  if (runtimePatch) {
    const runtime = ADMIN_RUNTIMES.find((item) => item.id === Number(runtimePatch[1])) ?? ADMIN_RUNTIMES[0]
    if (method === 'PATCH') return json({ ...runtime, ...(readJson(init) as Partial<AdminRuntimeRow>) })
    if (method === 'DELETE') return new Response(null, { status: 204 })
  }

  // 模型
  if (pathname === '/api/admin/models/providers' && method === 'GET')
    return json(providersFor(getMockState().scenario))
  if (pathname === '/api/admin/models/providers' && method === 'POST')
    return json({ provider: ADMIN_PROVIDERS[0] }, 201)
  if (/^\/api\/admin\/models\/providers\/\d+\/test$/.test(pathname) && method === 'POST') {
    return json({ ok: true, latencyMs: 218, models: ['deepseek-chat', 'deepseek-reasoner'] })
  }
  if (pathname === '/api/admin/models/discover' && method === 'POST') {
    return json({ models: MOCK_DISCOVERED })
  }
  if (pathname === '/api/admin/models/catalog' && method === 'GET') {
    return json({
      custom: mockCatalog,
      builtin: { count: 977, source: '@earendil-works/pi-ai 0.87.1（演示数据）' },
    })
  }
  if (pathname === '/api/admin/models/catalog' && method === 'PUT') {
    const entries = (readJson(init).entries ?? []) as (ModelInfo & { id: string })[]
    for (const entry of entries) {
      const key = mockKey(entry.id)
      const next: CatalogEntry = { ...entry, key, updatedAt: new Date().toISOString() }
      mockCatalog = [...mockCatalog.filter((item) => item.key !== key), next]
    }
    return json({
      custom: mockCatalog,
      builtin: { count: 977, source: '@earendil-works/pi-ai 0.87.1（演示数据）' },
    })
  }
  const catalogDelete = /^\/api\/admin\/models\/catalog\/([^/]+)$/.exec(pathname)
  if (catalogDelete && method === 'DELETE') {
    mockCatalog = mockCatalog.filter((entry) => entry.key !== decodeURIComponent(catalogDelete[1]!))
    return new Response(null, { status: 204 })
  }
  if (pathname === '/api/admin/models/catalog/match' && method === 'POST') {
    const ids = (readJson(init).ids ?? []) as string[]
    const matches = ids.flatMap((id) => {
      const hit = mockMatch(id)
      return hit ? [{ ...hit.info, id, source: hit.source, matchedId: hit.matchedId }] : []
    })
    return json({ matches })
  }
  if (/^\/api\/admin\/models\/providers\/\d+\/user-keys\/\d+$/.test(pathname)) {
    return method === 'PUT' ? new Response(null, { status: 204 }) : new Response(null, { status: 204 })
  }
  const providerPatch = /^\/api\/admin\/models\/providers\/(\d+)$/.exec(pathname)
  if (providerPatch) {
    const provider =
      ADMIN_PROVIDERS.find((item) => item.id === Number(providerPatch[1])) ?? ADMIN_PROVIDERS[0]
    if (method === 'PATCH')
      return json({ provider: { ...provider, ...(readJson(init) as Partial<ModelProvider>) } })
    if (method === 'DELETE') return new Response(null, { status: 204 })
  }
  if (pathname === '/api/admin/models/presets' && method === 'GET') {
    const platform = query.get('platform') === 'desktop' ? 'desktop' : 'cloud'
    return json(ADMIN_PRESETS.filter((preset) => preset.platform === platform))
  }
  if (pathname === '/api/admin/models/presets' && method === 'POST')
    return json({ preset: ADMIN_PRESETS[0] }, 201)
  const presetPreview = /^\/api\/admin\/models\/presets\/(\d+)\/preview$/.exec(pathname)
  if (presetPreview && method === 'GET') {
    return json({ userId: 2, content: ADMIN_PRESET_PREVIEW, warnings: [] })
  }
  const presetPatch = /^\/api\/admin\/models\/presets\/(\d+)$/.exec(pathname)
  if (presetPatch) {
    const preset = ADMIN_PRESETS.find((item) => item.id === Number(presetPatch[1]))
    if (method === 'PATCH') return json({ preset: { ...preset, revision: (preset?.revision ?? 0) + 1 } })
    if (method === 'DELETE') return new Response(null, { status: 204 })
  }

  // 下发
  if (pathname === '/api/admin/rollouts/preview' && method === 'POST') {
    return json({
      targets: users.map((user, index) => ({
        userId: user.id,
        username: user.username,
        current: index === 1 ? '未安装' : '0.15.0',
        after: '0.16.0',
        willRestart: index !== 3,
      })),
      total: users.length,
    })
  }
  if (pathname === '/api/admin/rollouts' && method === 'POST') {
    // WP12b：模型配置下发真的建一条几秒内跑完的假任务（「下发到 DSH」看进度用）
    const body = readJson(init)
    const targets = users.map((user) => ({ userId: user.id, username: user.username }))
    const created = createMockRolloutJob({
      type: `rollout.${typeof body.kind === 'string' ? body.kind : 'models'}`,
      title:
        body.kind === 'models'
          ? `模型配置下发 → ${users.length} 位用户`
          : `下发任务 → ${users.length} 位用户`,
      targets,
    })
    return json({ jobId: created.id }, 202)
  }

  // 任务
  if (pathname === '/api/admin/jobs' && method === 'GET') {
    const dynamic = mockJobs()
    const fixture =
      dynamic.length > 0 ? ADMIN_JOBS.filter((job) => !dynamic.some((d) => d.id === job.id)) : ADMIN_JOBS
    return json(paged([...dynamic, ...fixture]))
  }
  const jobLog = /^\/api\/admin\/jobs\/(\d+)\/tasks\/(\d+)\/log$/.exec(pathname)
  if (jobLog && method === 'GET') return json({ text: ADMIN_JOB_LOG })
  const jobDetail = /^\/api\/admin\/jobs\/(\d+)$/.exec(pathname)
  if (jobDetail && method === 'GET') {
    const id = Number(jobDetail[1])
    const dynamic = mockJobDetail(id)
    if (dynamic) return json(dynamic)
    const job = ADMIN_JOBS.find((item) => item.id === id) ?? ADMIN_JOBS[0]
    return json({ job: job ?? ADMIN_JOBS[0], tasks: ADMIN_JOB_TASKS })
  }
  if (/^\/api\/admin\/jobs\/\d+\/(pause|resume|cancel|retry-failed)$/.test(pathname) && method === 'POST') {
    return new Response(null, { status: 204 })
  }

  // 邀请码 / 设置 / 审计
  if (pathname === '/api/admin/invites' && method === 'GET')
    return json(paged(scenario === 'admin-empty' ? [] : ADMIN_INVITES))
  if (pathname === '/api/admin/invites' && method === 'POST') {
    const body = readJson(init)
    const count = typeof body.count === 'number' ? Math.min(Math.max(body.count, 1), 50) : 1
    const items: InviteRow[] = Array.from({ length: count }, (_, index) => ({
      id: 100 + index,
      code: `MOCK${String(index + 1).padStart(4, '0')}CODE`,
      note: typeof body.note === 'string' ? body.note : '',
      maxUses: typeof body.maxUses === 'number' ? body.maxUses : 1,
      usedCount: 0,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      disabled: false,
      createdBy: 1,
      createdAt: new Date().toISOString(),
      roleLabel: typeof body.roleLabel === 'string' ? body.roleLabel : '',
      uses: [],
    }))
    return json({ items }, 201)
  }
  const invitePatch = /^\/api\/admin\/invites\/(\d+)$/.exec(pathname)
  if (invitePatch) {
    const invite = ADMIN_INVITES.find((item) => item.id === Number(invitePatch[1])) ?? ADMIN_INVITES[0]
    if (method === 'PATCH') return json({ invite: { ...invite, ...(readJson(init) as Partial<InviteRow>) } })
    if (method === 'DELETE') return new Response(null, { status: 204 })
  }
  if (pathname === '/api/admin/settings' && method === 'GET') return json(ADMIN_SETTINGS)
  if (pathname === '/api/admin/settings' && method === 'PATCH') {
    // 按键**合并**而不是整键替换：WP33 起 capacity 里还有 busyMaxMinutes，
    // 只传 {maxRunning} 时不能把别的字段（包括 schema 默认值）抹掉
    const patch = readJson(init) as Partial<Settings>
    const merged = structuredClone(ADMIN_SETTINGS) as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      const current = merged[key]
      merged[key] =
        typeof value === 'object' && value !== null && typeof current === 'object' && current !== null
          ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
          : value
    }
    return json(merged)
  }
  if (pathname === '/api/admin/audit' && method === 'GET')
    return json(paged(scenario === 'admin-empty' ? [] : ADMIN_AUDIT))

  return null
}

// ── WP28c：插件库多选走查场景（`?mock=plugins-bulk`）────────────────────────────

/**
 * 插件库批量勾选要看的东西（勾选列 / 批量操作条 / 「已安装」列 / 翻页）在 4 个插件上走不完：
 * 一页装得下就没有第二页，也看不到「已隐藏（policy=hidden）的插件也能选」。这里再补 7 个。
 */
function bulkPluginRow(
  id: number,
  packageName: string,
  displayName: string,
  description: string,
  policy: AdminPluginRow['policy'],
  latestVersion: string,
  stats: AdminPluginRow['stats'],
): AdminPluginRow {
  const row = {
    id,
    packageName,
    displayName,
    description,
    icon: null,
    homepage: null,
    policy,
    isBundle: true,
    bundleOrder: id * 10,
    needsRestart: id % 2 === 1,
    latestVersion,
    configYaml: `- id: ${packageName}\n  config: {}`,
    versions: [
      pluginVersion(id * 100 + 1, latestVersion, 'npm', `${packageName}@${latestVersion}`, latestVersion, 60 * 24 * id),
    ],
    stats,
  } satisfies Omit<AdminPluginRow, 'platform' | 'platforms'>
  return { ...row, platform: 'cloud', platforms: { cloud: platformSettings(row) } }
}

/** `plugins-bulk` 场景追加的插件（id 5–11；6 是 hidden，用来验证「已隐藏也能勾选」）。 */
export function bulkScenarioPlugins(): AdminPluginRow[] {
  return [
    bulkPluginRow(5, 'dsh-memory', '记忆库', '长期记忆与检索，按会话自动归档。', 'default', '0.3.1', {
      installed: 3,
      pending: 0,
      failed: 0,
    }),
    bulkPluginRow(
      6,
      'dsh-legacy-notes',
      '旧版便签',
      '已被便签 v2 取代，保留给仍装着的用户。',
      'hidden',
      '1.2.0',
      { installed: 0, pending: 0, failed: 0 },
    ),
    bulkPluginRow(7, 'dsh-git-tools', 'Git 工具', '在工作区里查看状态、提交与差异。', 'optional', '2.1.0', {
      installed: 1,
      pending: 0,
      failed: 0,
    }),
    bulkPluginRow(8, 'dsh-web-search', '网页检索', '把搜索结果带进会话，按域名过滤。', 'default', '0.9.4', {
      installed: 0,
      pending: 1,
      failed: 0,
    }),
    bulkPluginRow(9, 'dsh-cron', '定时任务', '按 cron 表达式跑固定任务。', 'optional', '0.4.2', {
      installed: 2,
      pending: 0,
      failed: 1,
    }),
    bulkPluginRow(10, 'dsh-notify', '消息通知', '任务完成或失败时推一条通知。', 'required', '1.1.0', {
      installed: 5,
      pending: 0,
      failed: 0,
    }),
    bulkPluginRow(11, 'dsh-theme-pack', '主题包', '几套配色与图标，自己切换。', 'optional', '0.6.0', {
      installed: 0,
      pending: 0,
      failed: 0,
    }),
  ]
}

/** 插件库的完整假目录：`GET /api/admin/plugins` 与安装统计（`plugin-install-stats.ts`）共用。 */
export function adminPluginCatalog(scenario: MockScenario, platform: PluginPlatform = 'cloud'): AdminPluginRow[] {
  if (scenario === 'admin-empty') return []
  const rows = pluginCatalogFor(scenario, platform)
  if (platform === 'cloud' && scenario === 'plugins-bulk') {
    // 批量场景的追加插件不在种子表里，单独拼上（它们也进了插件库状态）
    return [...rows, ...bulkScenarioPlugins().map((row) => ({ ...row, platform: 'cloud' as const }))]
  }
  if (platform === 'desktop' && scenario === 'plugins-bulk') {
    return [
      ...rows,
      ...bulkScenarioPlugins().map((row) => ({
        ...row,
        platform: 'desktop' as const,
        policy: 'optional' as const,
      })),
    ]
  }
  return rows}
