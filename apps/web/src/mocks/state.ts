import type {
  ExportItem,
  InstancePhase,
  InstanceStats,
  InstanceStatus,
  InstanceSummary,
  MyPluginItem,
  PublicSiteResponse,
  Quota,
  SessionItem,
  UserPublic,
} from '@dsh-hub/shared'

import { isCockpitScenario } from './cockpit'
import { resetMockJobs } from './jobs'

/**
 * 开发/截图用的假数据与假状态机（**仅开发环境**，见 `mocks/index.ts`）。
 *
 * 为什么要有它：WP2（实例域）与 WP3（插件域）还没合并到主干，`/api/me/instance*` 与
 * `/api/me/plugins` 目前是 `not-implemented` 桩；WP5b 的页面需要有真实形状的数据才能
 * 自测与出截图（任务书「完成定义」要求 `?mock=1` 开关）。生产构建里这段代码会被摇掉。
 */

/**
 * 场景由 `?mock=<scenario>` 指定（默认 running）；切换场景会重置全部假状态。
 * `admin` / `admin-empty` 是 WP6 的管理端场景（当前用户变成管理员，管理端接口见 `mocks/admin.ts`）；
 * `admin-no-relay`（WP11b）在 `admin` 基础上去掉 hub-relay 提供方（WP12 起界面不再有引导卡，留着给假数据回归用）。
 * `admin-empty-dsh`（WP12b）在 `admin` 基础上去掉全部对外模型，用来看「下发到 DSH」的空状态。
 * `relay-off` 是 WP10b 的「中转站未开通」场景（`GET /api/me/relay` 返回 `enabled:false`，见 `mocks/relay.ts`）。
 * `compute-*`（WP17b）是算力租赁场景（`mocks/compute.ts`）：计费关闭 / 已停止 / 运行中 / 宽限中 /
 * 余额不足 / 管理员免租 / 有定制规格。
 * `admin-tools-off`（WP18b）是搜索池关掉时管理端的样子；`tools-exhausted`（WP18b）是用户本月免费额度
 * 用完。
 * `guest`（WP19b）是未登录场景：`GET /api/auth/me` 返回 401，用来看登录页（截 login 图）。
 * `agent-modes`（WP23b）是「Claude Code / Codex」管理页的走查场景：在 `admin` 之上带两个模式的数据
 * （Claude Code 已开通 ×1.5、指定用户、2 渠道 3 模型、待下发；Codex 未开通、插件库里没有）。
 * `usage-empty`（WP24）是「积分与用量」的空状态：中转站开通着，但区间内没有任何用量。
 * `desktop` / `desktop-empty` / `desktop-limit` / `desktop-expired` / `desktop-done`（WP25c）是桌面端场景
 * （`mocks/desktop.ts`）：有设备（在线 + 离线）/ 没有设备 / 5 台打满上限 / 授权请求已过期 / 已经允许过。
 * `admin-desktop` / `admin-desktop-empty` / `admin-desktop-failed` / `admin-desktop-warn`（WP25d）是
 * 「桌面端」下发页的四个场景（`mocks/desktop-delivery.ts`）：正常 / 全新 Hub / 设备全部失败 / 带渲染告警。
 * `desktop-password`（WP25f）是「账号必须先改密」的授权页（403 + `loginCode=password_change_required`）；
 * `admin-batch`（WP25f）是管理端批量吊销的混合结果（revoked / already_revoked / not_found / failed）。
 * `plugins-bulk`（WP28c）是插件库多选批量的走查场景：在 `admin` 之上多 7 个插件（共 11 个、两页、含 policy=hidden）。
 * `delivery` / `delivery-desktop-only` / `delivery-warnings` / `delivery-truncated`（WP28b）是统一下发向导的场景
 * （`mocks/deliveries.ts`）：正常 / 桌面端（实例侧没有安装记录 + 一台已吊销设备）/ 带警告 / 预览被截断。
 */
export type MockScenario =
  | 'admin'
  | 'admin-empty'
  | 'admin-empty-dsh'
  | 'admin-no-relay'
  | 'admin-tools-off'
  | 'agent-modes'
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'absent'
  | 'error'
  | 'capacity'
  | 'exporting'
  | 'plugins'
  | 'empty'
  | 'relay-off'
  | 'tools-exhausted'
  | 'compute-off'
  | 'compute-stopped'
  | 'compute-running'
  | 'compute-grace'
  | 'compute-low'
  | 'compute-exempt'
  | 'compute-custom'
  | 'usage-empty'
  | 'desktop'
  | 'desktop-empty'
  | 'desktop-limit'
  | 'desktop-expired'
  | 'desktop-done'
  | 'desktop-password'
  | 'admin-batch'
  | 'admin-desktop'
  | 'admin-desktop-empty'
  | 'admin-desktop-failed'
  | 'admin-desktop-warn'
  | 'plugins-bulk'
  | 'delivery'
  | 'delivery-desktop-only'
  | 'delivery-warnings'
  | 'delivery-truncated'
  | 'cockpit'
  | 'cockpit-empty'
  | 'cockpit-off'
  | 'cockpit-r3'
  | 'cockpit-secret'
  | 'cockpit-turn'
  | 'cockpit-boot'
  | 'cockpit-fail'
  | 'cockpit-legacy'
  | 'guest'

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  'admin',
  'admin-empty',
  'admin-empty-dsh',
  'admin-no-relay',
  'admin-tools-off',
  'agent-modes',
  'running',
  'stopped',
  'starting',
  'stopping',
  'absent',
  'error',
  'capacity',
  'exporting',
  'plugins',
  'empty',
  'relay-off',
  'tools-exhausted',
  'compute-off',
  'compute-stopped',
  'compute-running',
  'compute-grace',
  'compute-low',
  'compute-exempt',
  'compute-custom',
  'usage-empty',
  'desktop',
  'desktop-empty',
  'desktop-limit',
  'desktop-expired',
  'desktop-done',
  'desktop-password',
  'admin-batch',
  'admin-desktop',
  'admin-desktop-empty',
  'admin-desktop-failed',
  'admin-desktop-warn',
  'plugins-bulk',
  'delivery',
  'delivery-desktop-only',
  'delivery-warnings',
  'delivery-truncated',
  'cockpit',
  'cockpit-empty',
  'cockpit-off',
  'cockpit-r3',
  'cockpit-secret',
  'cockpit-turn',
  'cockpit-boot',
  'cockpit-fail',
  'cockpit-legacy',
  'guest',
]

// 注意：SLUG_REGEX = /^u[a-z0-9]{7}$/（shared/constants.ts）
export const MOCK_SLUG = 'u7k2m9xr'

const MB = 1024 * 1024
const GB = 1024 * MB

/** 假用户（形状与 04 §0.1 的 UserPublic 一致；不含任何真实信息）。 */
function makeUser(scenario: MockScenario): UserPublic {
  const admin =
    scenario === 'admin' ||
    scenario === 'agent-modes' ||
    scenario === 'admin-empty' ||
    scenario === 'admin-empty-dsh' ||
    scenario === 'admin-no-relay' ||
    scenario === 'admin-tools-off' ||
    // WP25d：桌面端下发页的四个场景（管理端）；WP25f：批量吊销混合结果
    scenario === 'admin-batch' ||
    scenario === 'admin-desktop' ||
    scenario === 'admin-desktop-empty' ||
    scenario === 'admin-desktop-failed' ||
    scenario === 'admin-desktop-warn' ||
    // WP28c：插件库多选批量走查场景
    scenario === 'plugins-bulk' ||
    // WP28b：统一下发向导的四个场景（管理端）
    scenario === 'delivery' ||
    scenario === 'delivery-desktop-only' ||
    scenario === 'delivery-warnings' ||
    scenario === 'delivery-truncated' ||
    // WP56c：管理座舱的五个走查场景（座舱页要管理员身份）
    isCockpitScenario(scenario) ||
    scenario === 'compute-exempt'
  return {
    id: admin ? 1 : 12,
    slug: admin ? 'u7k2m9x1' : MOCK_SLUG,
    username: admin ? 'admin' : 'littletao',
    // 极端值（WP14a 走查）：偏长的昵称，量顶栏账号名与问候语的省略 / 换行
    displayName: admin ? '站长' : '小桃和她的十三个小工具',
    bio: '喜欢把东西收拾得整整齐齐，也喜欢让 AI 帮忙写点小工具。',
    avatarUrl: null,
    role: admin ? 'admin' : 'user',
    status: 'active',
    mustChangePassword: false,
    createdAt: '2026-09-01T02:10:00.000Z',
    lastLoginAt: '2026-10-12T05:30:00.000Z',
    usernameChangedAt: null,
  }
}

export const MOCK_SITE: PublicSiteResponse = {
  name: 'DSH Hub',
  tagline: '你的 DSH，安安静静跑在自己的机器上',
  announcement: '10 月 14 日 02:00–04:00 升级 DSH 版本，期间实例会自动重启一次。',
  announcementLevel: 'info',
  registrationMode: 'invite',
  requireApproval: false,
  caCertUrl: '/ca.crt',
}

export const MOCK_QUOTA: Quota = {
  cpus: 2,
  memoryMb: 4096,
  pidsLimit: 512,
  diskGb: 20,
  idleStopMinutes: 60,
  idleNoClientMinutes: 30,
  allowUserPlugins: true,
}

export const MOCK_STATS: InstanceStats = {
  cpuPercent: 36.8,
  // 契约里磁盘/内存都是整数字节（z.number().int()），假数据也必须取整
  memoryBytes: Math.round(1.62 * GB),
  memoryLimitBytes: 4 * GB,
  pids: 47,
  diskBytes: Math.round(6.4 * GB),
  diskLimitBytes: 20 * GB,
}

export const MOCK_MODEL_SUMMARY = {
  policy: 'managed' as const,
  preset: '默认预设',
  defaultModel: 'deepseek-chat',
  providers: ['DeepSeek', 'Kimi'],
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function makePlugins(scenario: MockScenario): MyPluginItem[] {
  const card = (
    id: number,
    packageName: string,
    displayName: string,
    description: string,
    version: string,
  ) => ({
    id,
    packageName,
    displayName,
    description,
    icon: null,
    homepage: null,
    policy: 'optional' as const,
    isBundle: false,
    bundleOrder: 0,
    needsRestart: true,
    latestVersion: version,
  })

  return [
    {
      plugin: {
        ...card(1, 'dsh-email', '邮件通知', '任务完成后发一封邮件给你，支持 SMTP。', '0.3.1'),
        policy: 'required',
      },
      installed: true,
      version: '0.3.1',
      state: 'synced',
      canToggle: false,
    },
    {
      plugin: card(2, 'dsh-file-download', '文件下载', '在预览面板里直接下载 agent 生成的文件。', '0.2.0'),
      installed: scenario !== 'empty',
      version: scenario !== 'empty' ? '0.2.0' : null,
      state: scenario === 'plugins' ? 'pending' : 'synced',
      canToggle: true,
    },
    {
      plugin: card(3, 'dsh-image-tools', '图片小工具', '压缩、裁剪、转格式，随手就能用。', '0.1.4'),
      installed: scenario !== 'empty',
      version: scenario !== 'empty' ? '0.1.4' : null,
      state: 'synced',
      canToggle: true,
    },
    {
      plugin: card(4, 'dsh-web-search', '联网搜索', '给模型加一个搜索工具，回答更新鲜。', '0.5.0'),
      installed: false,
      version: null,
      state: 'synced',
      canToggle: true,
    },
  ]
}

function makeExports(scenario: MockScenario): ExportItem[] {
  const base = {
    parts: ['workspace', 'sessions'] as ExportItem['parts'],
    format: 'zip' as const,
    sha256: null,
    downloaded: false,
    error: null,
    progress: null,
  }

  if (scenario === 'empty') return []

  const items: ExportItem[] = [
    {
      ...base,
      id: 31,
      status: 'ready',
      fileName: 'dsh-littletao-20261012-0930.zip',
      sizeBytes: Math.round(1.24 * GB),
      createdAt: nowIso(-2 * 3600_000),
      expiresAt: nowIso(22 * 3600_000),
    },
    {
      ...base,
      id: 30,
      parts: ['workspace', 'sessions', 'settings', 'profile-plugins'],
      status: 'expired',
      fileName: 'dsh-littletao-20261009-2101.zip',
      sizeBytes: Math.round(1.1 * GB),
      createdAt: nowIso(-74 * 3600_000),
      expiresAt: nowIso(-50 * 3600_000),
    },
  ]

  if (scenario === 'exporting') {
    items.unshift({
      ...base,
      id: 32,
      parts: ['workspace', 'sessions', 'settings', 'profile-plugins'],
      status: 'running',
      fileName: null,
      sizeBytes: null,
      createdAt: nowIso(-40_000),
      expiresAt: null,
      progress: { bytesWritten: Math.round(0.46 * GB), filesDone: 1284, filesTotal: 3120 },
    })
  }

  return items
}

function makeSessions(): SessionItem[] {
  return [
    {
      id: 'sess-current',
      current: true,
      createdAt: nowIso(-3 * 3600_000),
      lastSeenAt: nowIso(-30_000),
      ip: '192.168.1.24',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0',
      device: '桌面 Chrome',
    },
    {
      id: 'sess-phone',
      current: false,
      createdAt: nowIso(-30 * 3600_000),
      lastSeenAt: nowIso(-5 * 3600_000),
      ip: '192.168.1.31',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1',
      device: 'iPhone Safari',
    },
    {
      id: 'sess-old',
      current: false,
      createdAt: nowIso(-9 * 86_400_000),
      lastSeenAt: nowIso(-6 * 86_400_000),
      ip: '10.0.0.8',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1',
      device: 'macOS Safari',
    },
  ]
}

export interface MockState {
  scenario: MockScenario
  user: UserPublic
  status: InstanceStatus
  startedAt: string | null
  lastActiveAt: string | null
  needsRecreate: boolean
  error: string | null
  /** 当前启动阶段（`starting` 时有值） */
  phase: InstancePhase | null
  phaseMessage: string | null
  /** 场景 starting 时冻结阶段（截图/走查用，不会自己跑到 ready） */
  frozen: boolean
  /** 场景 capacity：start 返回 CAPACITY_FULL */
  capacityFullOnStart: boolean
  stats: InstanceStats
  quota: Quota
  plugins: MyPluginItem[]
  exports: ExportItem[]
  sessions: SessionItem[]
  nextExportId: number
}

function initialState(scenario: MockScenario): MockState {
  /** 算力租赁里「实例停着」的几个场景（13 §7：点规格卡片只记住，不重启） */
  const computeStopped =
    scenario === 'compute-off' ||
    scenario === 'compute-stopped' ||
    scenario === 'compute-low' ||
    scenario === 'compute-custom'

  const running =
    !computeStopped &&
    scenario !== 'stopped' &&
    scenario !== 'absent' &&
    scenario !== 'error' &&
    scenario !== 'capacity'
  const starting = scenario === 'starting'
  const stopping = scenario === 'stopping'
  const computeRunning =
    scenario === 'compute-running' || scenario === 'compute-grace' || scenario === 'compute-exempt'

  return {
    scenario,
    user: makeUser(scenario),
    status: starting
      ? 'starting'
      : stopping
        ? 'stopping'
        : running
          ? 'running'
          : scenario === 'error'
            ? 'error'
            : 'stopped',
    startedAt: running
      ? computeRunning
        ? nowIso(-(scenario === 'compute-grace' ? 35 : 25) * 60_000)
        : nowIso(-(2 * 3600_000 + 13 * 60_000))
      : null,
    lastActiveAt: running ? nowIso(-4 * 60_000) : nowIso(-20 * 3600_000),
    needsRecreate: scenario === 'running' || scenario === 'exporting' || scenario === 'plugins',
    error: scenario === 'error' ? '容器启动失败：端口 3000 被占用' : null,
    phase: starting ? 'bootstrapping' : null,
    phaseMessage: starting ? '正在安装插件（2/3）' : null,
    frozen: starting,
    capacityFullOnStart: scenario === 'capacity',
    stats: { ...MOCK_STATS },
    quota: { ...MOCK_QUOTA },
    plugins: makePlugins(scenario),
    exports: makeExports(scenario),
    sessions: makeSessions(),
    nextExportId: 33,
  }
}

let state: MockState = initialState('running')

export function getMockState(): MockState {
  return state
}

export function setMockScenario(scenario: MockScenario): void {
  state = initialState(scenario)
  // 换场景时把「下发到 DSH」的假任务也清掉，免得上一次的任务串到新场景里
  resetMockJobs()
}

// ── 实例摘要与事件流 ────────────────────────────────────────────────────────

export function mockInstanceSummary(): InstanceSummary {
  return {
    status: state.status,
    runtimeVersion: state.status === 'absent' ? null : '0.9.4',
    startedAt: state.startedAt,
    lastActiveAt: state.lastActiveAt,
    needsRecreate: state.needsRecreate,
    error: state.error,
    openUrl: `/dsh/${state.user.username}/`,
  }
}

export type MockEvent = { type: string; data: unknown }

type MockListener = (event: MockEvent) => void

const listeners = new Set<MockListener>()

/** 订阅假事件（假 EventSource 用；与真 SSE 的 `event: <name>` 语义一致）。 */
export function subscribeMockEvent(listener: MockListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitMockEvent(type: string, data: unknown): void {
  for (const listener of [...listeners]) listener({ type, data })
}

function emitStatus(): void {
  emitMockEvent('status', {
    instance: mockInstanceSummary(),
    phase: state.phase ?? undefined,
    message: state.phaseMessage ?? undefined,
  })
}

/** 启动阶段顺序（04 §3.1 的 phase 枚举）。 */
const START_PHASES: readonly { phase: InstancePhase; message: string; delayMs: number }[] = [
  { phase: 'pulling', message: '正在拉取镜像', delayMs: 500 },
  { phase: 'creating', message: '正在创建容器', delayMs: 700 },
  { phase: 'booting', message: '正在启动 DSH 服务', delayMs: 900 },
  { phase: 'bootstrapping', message: '正在安装插件（1/3）', delayMs: 1200 },
  { phase: 'bootstrapping', message: '正在安装插件（3/3）', delayMs: 1200 },
  { phase: 'ready', message: '准备就绪', delayMs: 600 },
]

let phaseTimers: ReturnType<typeof setTimeout>[] = []

function clearPhaseTimers(): void {
  for (const timer of phaseTimers) clearTimeout(timer)
  phaseTimers = []
}

/**
 * 进入启动流程：按 {@link START_PHASES} 逐阶段推进并广播 `status` 事件。
 * 场景 `starting` 是冻结的（截图要停在「启动中」）。
 */
export function beginStart(): void {
  clearPhaseTimers()
  state.status = 'starting'
  state.phase = 'pulling'
  state.phaseMessage = '正在拉取镜像'
  state.error = null
  emitStatus()

  if (state.frozen) {
    state.phase = 'bootstrapping'
    state.phaseMessage = '正在安装插件（2/3）'
    emitStatus()
    return
  }

  let elapsed = 0
  for (const step of START_PHASES) {
    elapsed += step.delayMs
    phaseTimers.push(
      setTimeout(() => {
        state.phase = step.phase
        state.phaseMessage = step.message
        if (step.phase === 'ready') {
          state.status = 'running'
          state.startedAt = nowIso()
          state.phase = null
          state.phaseMessage = null
        }
        emitStatus()
      }, elapsed),
    )
  }
}

export function beginStop(): void {
  clearPhaseTimers()
  state.status = 'stopping'
  state.phase = null
  state.phaseMessage = '正在停止容器'
  emitStatus()
  phaseTimers.push(
    setTimeout(
      () => {
        state.status = 'stopped'
        state.startedAt = null
        state.phaseMessage = null
        emitStatus()
      },
      state.frozen ? 10 * 60_000 : 1200,
    ),
  )
}

// ── 导出进度（假 SSE 用） ───────────────────────────────────────────────────

/** 假导出包的目标大小（进度条按它封顶） */
const MOCK_EXPORT_TOTAL_BYTES = 1.8 * GB

export interface MockExportTick {
  item: ExportItem
  done: boolean
}

/** 让一个「进行中」的导出往前走一小步（假 SSE 定时调用）。 */
export function advanceMockExport(id: number): MockExportTick | null {
  const item = state.exports.find((row) => row.id === id)
  if (!item) return null

  if (item.status === 'running') {
    const progress = item.progress ?? { bytesWritten: 0, filesDone: 0, filesTotal: 3120 }
    const next = {
      bytesWritten: Math.min(MOCK_EXPORT_TOTAL_BYTES, progress.bytesWritten + 42 * MB),
      filesDone: Math.min(progress.filesTotal, progress.filesDone + 96),
      filesTotal: progress.filesTotal,
    }
    item.progress = next

    if (next.filesDone >= next.filesTotal) {
      item.status = 'ready'
      item.fileName = `dsh-${state.user.username}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`
      item.sizeBytes = next.bytesWritten
      item.expiresAt = nowIso(24 * 3600_000)
      item.progress = next
      return { item, done: true }
    }
    return { item, done: false }
  }

  return { item, done: item.status === 'ready' || item.status === 'failed' || item.status === 'expired' }
}
