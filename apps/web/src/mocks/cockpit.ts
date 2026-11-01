import type {
  CanvasItem,
  CanvasPlacement,
  CanvasSize,
  CanvasSpec,
  CapabilityDescriptor,
  CockpitEvent,
  CockpitStatusStrip,
  OpsStatus,
  ProposalView,
  SecretRequestView,
} from '@/api/admin-cockpit'

import { DEV_COCKPIT_SESSIONS } from '@/components/admin/cockpit/dev-sessions'
import { defaultPlacementOf } from '@/utils/cockpit'

import type { MockScenario } from './state'

/**
 * 管理座舱的假接口（`?mock=cockpit*`，WP56c）。
 *
 * 三个用途：
 * 1. `/admin` 三栏、画布渲染器、方案卡、密钥卡、态势板在 WP56a 后端合并前就能开发与截图；
 * 2. 组件测试拿它当夹具（`?mock=cockpit` 与 mock `EventSource` 配合）；
 * 3. 走查六种状态：空态势板 / 多种卡 / pending·running·failed 方案 / R3 方案 / 密钥卡 / 座舱停止。
 *
 * 场景（`?mock=<scenario>`）：
 * - `cockpit`：运行中。态势板 = 三张 Hub 默认卡 + 待处理方案卡 + 一张钉住的图；会话里另有
 *   统计 / 图表 / 表格 / 实体 / 任务 / 日志 / 说明卡，三个方案分别处于 pending / running / failed；
 * - `cockpit-empty`：运行中但一张卡都没有（空态势板）；
 * - `cockpit-off`：座舱 DSH 停止、模型不可用（I6：态势板与待处理方案照常可用）；
 * - `cockpit-r3`：R3 方案（删除用户）待确认，按钮要密码；
 * - `cockpit-secret`：密钥输入卡（密钥值不经过对话，填完只回 204）。
 * - `cockpit-boot` / `cockpit-fail` / `cockpit-legacy`（WP58）：启动加载的三个走查场景 ——
 *   容器从「未启动」开始，点「启动」走 starting → booting → connecting → ready；
 *   第一次启动报错（演示 failed + 重试）、老 App（不发 caps / status）。
 *
 * 时间线（执行 / 重启）用定时器模拟，`resetCockpitMock()` 会清掉，测试之间不互相影响。
 */

// ────────────────────────────── 夹具 ──────────────────────────────

// 会话 id 与 dev 占位面板共用一份常量（真实模式下会话列表在 iframe 里，由 App 网页版提供）
const SESS_USAGE = DEV_COCKPIT_SESSIONS[0]?.id ?? 'sess_weekly_usage'
const SESS_PLUGIN = DEV_COCKPIT_SESSIONS[1]?.id ?? 'sess_plugin_upgrade'
const SESS_ONCALL = DEV_COCKPIT_SESSIONS[2]?.id ?? 'sess_oncall_1029'

/** 能力目录（真后端由 zod schema 生成 input，这里只放前端要用的字段）。 */
const CATALOG: CapabilityDescriptor[] = [
  {
    id: 'cockpit.board-vitals',
    area: 'overview',
    title: '舰况',
    description:
      '态势板「舰况」指标卡的数据源：运行实例 value/max、今日请求与积分带 7 天 spark、失败任务按 tone 变色。',
    risk: 'R0',
    input: { type: 'object', properties: {} },
    dataSource: true,
    classicPath: '/admin',
  },
  {
    id: 'cockpit.pending-proposals',
    area: 'overview',
    title: '待处理方案',
    description: '列出还在等管理员确认的方案（pending）以及最近的决定结果；批准/拒绝只能在管理端点（I5）。',
    risk: 'R0',
    input: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } },
    dataSource: true,
    classicPath: '/admin',
  },
  {
    id: 'overview.summary',
    area: 'overview',
    title: '总览摘要',
    description: '各域数量与宿主资源的摘要，回答「整体情况怎么样」时先看它。',
    risk: 'R0',
    input: { type: 'object', properties: {} },
    dataSource: true,
    classicPath: '/admin/overview',
  },
  {
    id: 'instances.list',
    area: 'instances',
    title: '列出实例',
    description: '列出用户实例的状态、资源占用与运行时长；可按用户名过滤。',
    risk: 'R0',
    input: { type: 'object', properties: { user: { type: 'string' } } },
    dataSource: true,
    classicPath: '/admin/instances',
  },
  {
    id: 'instances.start',
    area: 'instances',
    title: '启动实例',
    description: '启动某个用户的实例（R1，默认自动执行）。',
    risk: 'R1',
    input: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
    classicPath: '/admin/instances',
  },
  {
    id: 'instances.stop',
    area: 'instances',
    title: '停止实例',
    description: '停止正在运行的实例，会中断该用户当前的对话。',
    risk: 'R2',
    input: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
    classicPath: '/admin/instances',
  },
  {
    id: 'users.list',
    area: 'users',
    title: '列出用户',
    description: '用户名、角色、实例状态与最近登录；用于「谁的积分用得最多」这类问题的取数。',
    risk: 'R0',
    input: { type: 'object', properties: { status: { type: 'string' } } },
    dataSource: true,
    classicPath: '/admin/users',
  },
  {
    id: 'users.delete',
    area: 'users',
    title: '删除用户',
    description: '删除用户并释放用户名（进入回收站 7 天）。敏感操作，需要管理员密码。',
    risk: 'R3',
    input: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
    classicPath: '/admin/users',
  },
  {
    id: 'users.quota.set',
    area: 'users',
    title: '修改用户配额',
    description: '调整单个用户的磁盘 / 内存配额，改完立即生效。',
    risk: 'R2',
    input: {
      type: 'object',
      properties: { username: { type: 'string' }, diskGb: { type: 'number' } },
      required: ['username', 'diskGb'],
    },
    classicPath: '/admin/users',
  },
  {
    id: 'plugins.list',
    area: 'plugins',
    title: '列出插件',
    description: '插件库里的插件、最新版本与装机数。',
    risk: 'R0',
    input: { type: 'object', properties: {} },
    dataSource: true,
    classicPath: '/admin/plugins',
  },
  {
    id: 'rollouts.plugin',
    area: 'rollouts',
    title: '下发插件',
    description: '把插件库里的某个版本下发给用户（全部或指定用户），可指定下次启动生效。',
    risk: 'R2',
    input: {
      type: 'object',
      properties: { pluginId: { type: 'number' }, versionId: { type: 'number' } },
      required: ['pluginId', 'versionId'],
    },
    classicPath: '/admin/rollouts',
  },
  {
    id: 'jobs.list',
    area: 'jobs',
    title: '列出任务',
    description: '下发、构建等异步任务的进度与失败数。',
    risk: 'R0',
    input: { type: 'object', properties: {} },
    dataSource: true,
    classicPath: '/admin/jobs',
  },
  {
    id: 'jobs.retry',
    area: 'jobs',
    title: '重试失败任务',
    description: '把任务里失败的分片重新排队（R1，默认自动执行）。',
    risk: 'R1',
    input: { type: 'object', properties: { jobId: { type: 'number' } }, required: ['jobId'] },
    classicPath: '/admin/jobs',
  },
  {
    id: 'relay.usage',
    area: 'relay',
    title: '中转站用量',
    description: '按天 / 用户 / 模型统计积分与 token 消耗。',
    risk: 'R0',
    input: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
    dataSource: true,
    classicPath: '/admin/models?tab=usage',
  },
  {
    id: 'relay.channels.upsert',
    area: 'relay',
    title: '新增中转站渠道',
    description: '新增或更新一个上游渠道。密钥只能通过密钥输入卡提交（secretRef）。',
    risk: 'R3',
    input: { type: 'object', properties: { name: { type: 'string' }, apiKey: { type: 'string' } } },
    secretFields: ['apiKey'],
    classicPath: '/admin/models?tab=channels',
  },
]

function nowIso(): string {
  return new Date().toISOString()
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

/** 近 N 天的日期（`YYYY-MM-DD`，图表 x 轴用）。 */
function recentDays(count: number): string[] {
  const days: string[] = []
  const today = new Date()
  for (let index = count - 1; index >= 0; index -= 1) {
    const day = new Date(today.getTime() - index * 86_400_000)
    days.push(day.toISOString().slice(0, 10))
  }
  return days
}

function opsStatusOf(scenario: MockScenario): OpsStatus {
  // WP58：启动加载的三个走查场景都从「未启动」开始，点「启动」才走 starting → running
  if (scenario === 'cockpit-boot' || scenario === 'cockpit-fail' || scenario === 'cockpit-legacy') {
    return {
      instance: 'stopped',
      model: null,
      reason: '座舱未启动（假数据）：点「启动」拉起',
      autoExecuteR1: true,
    }
  }
  if (scenario === 'cockpit-off') {
    return {
      instance: 'stopped',
      model: null,
      reason: '座舱 DSH 未运行：容器已停止，模型的密钥也无法读取',
      autoExecuteR1: true,
    }
  }
  return { instance: 'running', model: 'deepseek-v4.1-flash', autoExecuteR1: true }
}

/** 状态条（docs/24 §1）：运行实例 / 今日用量 / 失败任务 / 待确认方案。 */
function stripOf(scenario: MockScenario): CockpitStatusStrip {
  return {
    instancesRunning: scenario === 'cockpit-off' ? 3 : 5,
    instancesTotal: 12,
    relayTodayRequests: 421,
    relayTodayCredits: 3.21,
    failedJobs: 1,
    pendingProposals: 0,
  }
}

/** 一张卡（`order` 越小越靠上；`origin` 区分 DSH 生成与 Hub 生成）。 */
/** 高度档位：数据卡矮、图与表格高，行动卡常规（docs/24 §3 `size`）。 */
const SIZE_BY_KIND: Record<CanvasSpec['kind'], CanvasSize> = {
  stats: 's',
  chart: 'l',
  table: 'm',
  logs: 'm',
  markdown: 'm',
  entity: 's',
  job: 'm',
  proposal: 'm',
  'secret-request': 'm',
}

type CardInput = Omit<CanvasItem, 'createdAt' | 'updatedAt' | 'placement' | 'size'> & {
  createdAt?: string
  updatedAt?: string
  /** 不给就按投放规则推（数据类左舷、行动类右舷） */
  placement?: CanvasPlacement
  size?: CanvasSize
}

function card(partial: CardInput): CanvasItem {
  const at = partial.createdAt ?? nowIso()
  return {
    createdAt: at,
    updatedAt: partial.updatedAt ?? at,
    ...partial,
    // 舷位：真后端按 §1 解析后存 `left`/`right`，假数据按同一规则推
    placement: partial.placement ?? defaultPlacementOf(partial.spec),
    size: partial.size ?? SIZE_BY_KIND[partial.spec.kind],
  }
}

/**
 * 态势板的四张 Hub 默认卡（与 WP56a `service.ts` 的 `boardCards()` 同形：
 * 左舷三张 source 表格 + 右舷「待处理方案」source 表格，`sessionId='board'`、`pinned=false`）。
 * 全部是 Hub 数据源，不依赖模型（I6：座舱停了也照常显示）。
 */
function defaultBoardCards(): CanvasItem[] {
  return [
    card({
      id: 'board:vitals',
      sessionId: 'board',
      title: '舰况',
      pinned: false,
      order: 10,
      origin: 'hub',
      placement: 'left',
      size: 's',
      spec: {
        kind: 'stats',
        items: [],
        data: { source: { capability: 'cockpit.board-vitals', args: {}, refreshSec: 15 } },
      },
    }),
    card({
      id: 'board:relay-usage',
      sessionId: 'board',
      title: '近 7 天中转站用量',
      pinned: false,
      order: 20,
      origin: 'hub',
      placement: 'left',
      spec: {
        kind: 'chart',
        chart: 'stacked-bar',
        x: { key: 'day', format: 'date' },
        series: [
          { key: 'inputTokens', label: '输入 tokens' },
          { key: 'outputTokens', label: '输出 tokens' },
        ],
        unit: 'tokens',
        data: { source: { capability: 'relay.usage', args: { by: 'day' }, refreshSec: 60 } },
      },
    }),
    card({
      id: 'board:instance-resources',
      sessionId: 'board',
      title: '实例资源',
      pinned: false,
      order: 30,
      origin: 'hub',
      placement: 'left',
      spec: {
        kind: 'chart',
        chart: 'bar',
        x: { key: 'username', format: 'text' },
        series: [{ key: 'memoryUsedMb', label: '内存 MB' }],
        unit: 'MB',
        data: { source: { capability: 'instances.list', args: { status: 'running' }, refreshSec: 30 } },
      },
    }),
    card({
      id: 'board:failed-jobs',
      sessionId: 'board',
      title: '失败任务',
      pinned: false,
      order: 40,
      origin: 'hub',
      placement: 'left',
      size: 's',
      spec: {
        kind: 'table',
        columns: [
          { key: 'id', label: '任务', format: 'number' },
          { key: 'title', label: '标题' },
          { key: 'status', label: '状态', format: 'status' },
          { key: 'failed', label: '失败数', format: 'number' },
          { key: 'createdAt', label: '创建时间', format: 'datetime' },
        ],
        data: {
          source: { capability: 'jobs.list', args: { status: 'failed', pageSize: 20 }, refreshSec: 60 },
        },
        rowRef: { entity: 'job', idKey: 'id' },
      },
    }),
    card({
      id: 'board:pending-proposals',
      sessionId: 'board',
      title: '待处理方案',
      pinned: false,
      order: 50,
      origin: 'hub',
      // 表格默认算数据类（左舷），这张是「右舷 · 行动」的待办，必须显式指定
      placement: 'right',
      size: 's',
      spec: {
        kind: 'table',
        columns: [
          { key: 'proposalId', label: '方案', format: 'number' },
          { key: 'title', label: '标题' },
          { key: 'risk', label: '风险', format: 'status' },
        ],
        data: { source: { capability: 'cockpit.pending-proposals', args: {}, refreshSec: 15 } },
      },
    }),
  ]
}

/** 会话「本周用量」里的卡（对话中带 3 种卡：指标 / 图表 / 表格）。 */
function usageSessionCards(): CanvasItem[] {
  const days = recentDays(7)
  return [
    card({
      id: 'card-usage-stats',
      sessionId: SESS_USAGE,
      title: '本周用量概览',
      pinned: false,
      order: 1,
      origin: 'dsh',
      spec: {
        kind: 'stats',
        items: [
          { label: '本周积分', value: '86.07', unit: '积分', tone: 'neutral', delta: -8 },
          {
            label: '请求',
            value: 4210,
            tone: 'neutral',
            delta: 15,
            spark: [310, 402, 366, 512, 470, 604, 421],
          },
          { label: '失败', value: 3, tone: 'warn' },
          // 有上限的数画环形仪表（5 / 12 台在跑）
          { label: '运行实例', value: 5, max: 12, tone: 'good' },
        ],
      },
    }),
    card({
      id: 'card-usage-chart',
      sessionId: SESS_USAGE,
      title: '近 7 天积分消耗',
      pinned: true,
      order: 2,
      origin: 'dsh',
      spec: {
        kind: 'chart',
        chart: 'area',
        x: { key: 'day', format: 'date' },
        series: [
          { key: 'dsh', label: 'DSH' },
          { key: 'claude', label: 'Claude Code' },
          { key: 'codex', label: 'Codex' },
        ],
        unit: '积分',
        data: {
          source: { capability: 'relay.usage', args: { from: days[0], to: days[6] }, refreshSec: 120 },
        },
      },
    }),
    card({
      id: 'card-usage-donut',
      sessionId: SESS_USAGE,
      title: '本周消耗占比',
      pinned: false,
      order: 3,
      origin: 'dsh',
      spec: {
        kind: 'chart',
        chart: 'donut',
        x: { key: 'username', format: 'text' },
        series: [{ key: 'credits', label: '积分' }],
        unit: '积分',
        data: { source: { capability: 'relay.usage', args: { by: 'user' }, refreshSec: 120 } },
      },
    }),
    card({
      id: 'card-usage-top',
      sessionId: SESS_USAGE,
      title: '本周消耗最多的用户',
      pinned: false,
      order: 4,
      origin: 'dsh',
      spec: {
        kind: 'table',
        columns: [
          { key: 'username', label: '用户' },
          { key: 'role', label: '角色' },
          { key: 'points', label: '积分', format: 'credits' },
          { key: 'requests', label: '请求', format: 'number' },
          { key: 'lastLoginAt', label: '最近登录', format: 'datetime' },
        ],
        data: { source: { capability: 'users.list', args: { order: 'points' }, refreshSec: 60 } },
        rowRef: { entity: 'user', idKey: 'id' },
      },
    }),
    card({
      id: 'card-usage-note',
      sessionId: SESS_USAGE,
      title: '小结',
      pinned: false,
      order: 5,
      origin: 'dsh',
      spec: {
        kind: 'markdown',
        text: '本周总消耗 86.07 积分，比上周下降 8%。\n\n- `claude-code` 渠道占 62%，主要来自两名用户；\n- 周三有一波失败（3 次，均为上游 429），已自动重试；\n- 下周的额度按当前速度够用。',
      },
    }),
  ]
}

/** 会话「插件升级」里的卡：方案卡三态 + 实体卡 + 日志。 */
function pluginSessionCards(): CanvasItem[] {
  return [
    card({
      id: 'card-proposal-12',
      sessionId: SESS_PLUGIN,
      title: '方案 #12 · 下发 dsh-memory 0.1.4',
      pinned: false,
      order: 1,
      origin: 'hub',
      spec: { kind: 'proposal', proposalId: 12 },
    }),
    card({
      id: 'card-proposal-13',
      sessionId: SESS_PLUGIN,
      title: '方案 #13 · 停止实例 test-x',
      pinned: false,
      order: 2,
      origin: 'hub',
      spec: { kind: 'proposal', proposalId: 13 },
    }),
    card({
      id: 'card-proposal-14',
      sessionId: SESS_PLUGIN,
      title: '方案 #14 · 调整 test-y 的配额',
      pinned: false,
      order: 3,
      origin: 'hub',
      spec: { kind: 'proposal', proposalId: 14 },
    }),
    card({
      id: 'card-plugin-entity',
      sessionId: SESS_PLUGIN,
      title: 'dsh-memory',
      pinned: false,
      order: 4,
      origin: 'dsh',
      // 5 = mocks/admin.ts 里 dsh-memory 的插件 id，实体卡标题才和方案对得上
      spec: { kind: 'entity', entity: 'plugin', id: 5 },
    }),
    card({
      id: 'card-plugin-logs',
      sessionId: SESS_PLUGIN,
      title: '下发日志',
      pinned: false,
      order: 5,
      origin: 'dsh',
      spec: {
        kind: 'logs',
        data: {
          rows: [
            { time: '21:02:11', level: 'info', line: 'delivery 421：开始下发 dsh-memory@0.1.4 给 8 人' },
            { time: '21:02:19', level: 'info', line: 'user 3：写入插件清单完成（next-start）' },
            { time: '21:02:24', level: 'warn', line: 'user 7：实例运行中，等待下次启动生效' },
            { time: '21:02:31', level: 'info', line: 'delivery 421：8/8 完成' },
          ],
        },
      },
    }),
  ]
}

/** 会话「值班 10-29」里的卡：任务进度 + 说明。 */
function oncallSessionCards(): CanvasItem[] {
  return [
    card({
      id: 'card-oncall-job',
      sessionId: SESS_ONCALL,
      title: '构建 DSH 版本',
      pinned: false,
      order: 1,
      origin: 'dsh',
      spec: { kind: 'job', jobId: 9001 },
    }),
    card({
      id: 'card-oncall-note',
      sessionId: SESS_ONCALL,
      title: '值班记录',
      pinned: false,
      order: 2,
      origin: 'dsh',
      spec: {
        kind: 'markdown',
        text: '18:40 中转站上游 429，重试后恢复。\n21:02 插件下发到 8 人，全部成功。\n23:10 例行检查：无异常任务。',
      },
    }),
  ]
}

/** 密钥输入卡所在的会话（`cockpit-secret`）。 */
function secretSessionCards(): CanvasItem[] {
  return [
    card({
      id: 'card-secret-1',
      sessionId: SESS_ONCALL,
      title: '密钥输入 · DeepSeek 官方渠道',
      pinned: false,
      order: 1,
      origin: 'hub',
      spec: { kind: 'secret-request', requestId: 'sec_req_1' },
    }),
    card({
      id: 'card-secret-2',
      sessionId: SESS_ONCALL,
      title: '渠道现状',
      pinned: false,
      order: 2,
      origin: 'hub',
      spec: {
        kind: 'table',
        columns: [
          { key: 'name', label: '渠道' },
          { key: 'state', label: '状态', format: 'status' },
          { key: 'models', label: '模型数', format: 'number' },
        ],
        data: {
          rows: [
            { name: 'DeepSeek 官方', state: 'running', models: 4 },
            { name: 'hub-relay', state: 'running', models: 6 },
          ],
        },
      },
    }),
  ]
}

function proposalFixtures(): ProposalView[] {
  const pending: ProposalView = {
    id: 12,
    sessionId: SESS_PLUGIN,
    title: '下发 dsh-memory 0.1.4',
    rationale:
      'dsh-memory 0.1.4 修了长会话里记忆丢失的问题。建议这次只升这一个插件，重启时机选「下次启动」，避免打断正在对话的用户。',
    risk: 'R2',
    steps: [
      {
        capability: 'rollouts.plugin',
        args: { pluginId: 3, versionId: 14, targets: 'all', restart: 'next-start' },
        preview: {
          summary: '影响 8 个用户；其中 2 个实例正在运行，重启后生效',
          affected: [
            { kind: 'user', id: 3, label: 'alice' },
            { kind: 'user', id: 7, label: 'bob' },
            { kind: 'plugin', id: 3, label: 'dsh-memory@0.1.4' },
          ],
          warnings: ['2 个用户的实例正在运行，插件将在下次启动时生效'],
        },
      },
    ],
    status: 'pending',
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    expiresAt: minutesFromNow(26),
  }

  const running: ProposalView = {
    id: 13,
    sessionId: SESS_PLUGIN,
    title: '停止实例 test-x',
    rationale: 'test-x 的实例连续 3 次探针失败，占着 2 GB 内存。先停掉，等用户确认后再重建。',
    risk: 'R2',
    steps: [
      {
        capability: 'instances.stop',
        args: { username: 'test-x' },
        preview: {
          summary: '停止 1 个实例（test-x）；该用户当前没有进行中的对话',
          affected: [{ kind: 'instance', id: 9, label: 'test-x' }],
        },
      },
    ],
    status: 'running',
    createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    expiresAt: minutesFromNow(18),
    decidedBy: { id: 1, username: 'admin' },
    decidedAt: new Date(Date.now() - 60_000).toISOString(),
    outcome: [{ stepIndex: 0, ok: true, result: { stopped: true } }],
  }

  const failed: ProposalView = {
    id: 14,
    sessionId: SESS_PLUGIN,
    title: '调整 test-y 的配额',
    rationale: 'test-y 的磁盘用到 96%，把配额从 5 GB 提到 10 GB。',
    risk: 'R2',
    steps: [
      {
        capability: 'users.quota.set',
        args: { username: 'test-y', diskGb: 10 },
        preview: {
          summary: '修改 1 个用户的磁盘配额：5 GB → 10 GB',
          affected: [{ kind: 'user', id: 12, label: 'test-y' }],
        },
      },
    ],
    status: 'failed',
    createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    expiresAt: minutesFromNow(-10),
    decidedBy: { id: 1, username: 'admin' },
    decidedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    outcome: [
      {
        stepIndex: 0,
        ok: false,
        error: { code: 'CONFLICT', message: '用户 test-y 的实例正在重建，请稍后再试' },
      },
    ],
  }

  return [pending, running, failed]
}

function r3Proposal(): ProposalView {
  return {
    id: 15,
    sessionId: SESS_ONCALL,
    title: '删除用户 test-x',
    rationale: 'test-x 是上周验证用的账号，配额一直占着。删除后用户名进回收站，7 天内可以恢复。',
    risk: 'R3',
    steps: [
      {
        capability: 'users.delete',
        args: { username: 'test-x' },
        preview: {
          summary: '删除 1 个用户（test-x）；文档与工作区一并删除，7 天内可恢复',
          affected: [{ kind: 'user', id: 9, label: 'test-x' }],
          warnings: ['该用户有 1 个运行中的实例，删除会先停止它'],
        },
      },
    ],
    status: 'pending',
    createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    expiresAt: minutesFromNow(28),
  }
}

function secretRequestFixture(): SecretRequestView {
  return {
    id: 'sec_req_1',
    sessionId: SESS_ONCALL,
    purpose: '新渠道「DeepSeek 官方」的 API Key',
    capability: 'relay.channels.upsert',
    field: 'apiKey',
    status: 'pending',
    expiresAt: minutesFromNow(15),
  }
}

// ────────────────────────────── 状态与事件总线 ──────────────────────────────

interface CockpitMockState {
  scenario: MockScenario
  status: OpsStatus
  /** 点过几次「启动 / 重启」：`cockpit-fail` 第一次失败、第二次成功（演示「重试」） */
  startAttempts: number
  /** 状态条数字（WP56a 的 `CockpitStatusStrip`） */
  strip: CockpitStatusStrip
  catalog: CapabilityDescriptor[]
  canvas: Record<string, CanvasItem[]>
  board: CanvasItem[]
  proposals: ProposalView[]
  secrets: SecretRequestView[]
}

type CockpitListener = (event: CockpitEvent) => void

const listeners = new Set<CockpitListener>()
const timers = new Set<ReturnType<typeof setTimeout>>()
let state: CockpitMockState = buildState('cockpit')

function later(action: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer)
    action()
  }, delayMs)
  timers.add(timer)
}

function broadcast(event: CockpitEvent): void {
  for (const listener of listeners) listener(event)
}

/** 订阅座舱事件（假 SSE 用）。 */
export function subscribeCockpit(listener: CockpitListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 连接建立时补发的全量事件（docs/24 §3.2：先补一次 `ops.status`，状态条一起给）。 */
export function cockpitBootstrapEvents(): CockpitEvent[] {
  return [
    { type: 'ops.status', status: state.status },
    { type: 'strip.update', strip: state.strip },
    // 真后端只补发 ops.status + strip.update（契约如此）；假数据额外把 pending 的密钥请求补一次，
    // 这样 `?mock=cockpit-secret` 刷新后密钥卡仍是完整形态（前端的降级形态另有单测）
    ...state.secrets
      .filter((request) => request.status === 'pending')
      .map((request) => ({ type: 'secret.request' as const, request })),
  ]
}

/** 重算状态条并在变化时推 `strip.update`（WP56a 的 `statusStrip()` 同口径）。 */
function refreshStrip(): void {
  const pending = state.proposals.filter((item) => item.status === 'pending').length
  const next: CockpitStatusStrip = { ...state.strip, pendingProposals: pending }
  if (JSON.stringify(next) === JSON.stringify(state.strip)) return
  state.strip = next
  broadcast({ type: 'strip.update', strip: next })
}

/** 从各会话里挑出钉住的 DSH 卡（态势板 = 默认卡 + 这些）。 */
function pinnedCards(canvas: Record<string, CanvasItem[]>): CanvasItem[] {
  const all = Object.values(canvas).flat()
  return all
    .filter((item) => item.pinned && item.origin === 'dsh')
    .sort((a, b) => a.order - b.order || aCreatedFirst(a, b))
  function aCreatedFirst(a: CanvasItem, b: CanvasItem): number {
    return a.createdAt.localeCompare(b.createdAt)
  }
}

/**
 * `cockpit-turn` 的连续投放（900 / 1700 / 2500 / 3300 ms）。
 *
 * WP56h：管理员说过「能用图的不要用表，图是可以显示变化的」，所以演示回合投的是
 * ①折线/面积（描线与呼吸光点）、②堆叠柱（柱从底部长出）、③donut（逐段扫出），
 * 最后才是右舷的方案卡——一次回答里图在前、行动在后，顺序和真实回合一致。
 */
function scheduleTurnDemo(): void {
  const days = recentDays(7)

  const areaCard = card({
    id: 'turn-area',
    sessionId: 'board',
    title: '近 7 天积分消耗',
    pinned: true,
    order: 1,
    origin: 'dsh',
    spec: {
      kind: 'chart',
      chart: 'area',
      x: { key: 'day', format: 'date' },
      series: [
        { key: 'dsh', label: 'DSH' },
        { key: 'claude', label: 'Claude Code' },
        { key: 'codex', label: 'Codex' },
      ],
      unit: '积分',
      data: { source: { capability: 'relay.usage', args: { from: days[0], to: days[6] }, refreshSec: 120 } },
    },
  })

  const stackedCard = card({
    id: 'turn-stacked',
    sessionId: 'board',
    title: '近 7 天中转站用量',
    pinned: true,
    order: 2,
    origin: 'dsh',
    spec: {
      kind: 'chart',
      chart: 'stacked-bar',
      x: { key: 'day', format: 'date' },
      series: [
        { key: 'inputTokens', label: '输入 tokens' },
        { key: 'outputTokens', label: '输出 tokens' },
      ],
      unit: 'tokens',
      data: { source: { capability: 'relay.usage', args: { by: 'day' }, refreshSec: 60 } },
    },
  })

  const donutCard = card({
    id: 'turn-donut',
    sessionId: 'board',
    title: '本周消耗占比',
    pinned: true,
    order: 3,
    origin: 'dsh',
    spec: {
      kind: 'chart',
      chart: 'donut',
      x: { key: 'username', format: 'text' },
      series: [{ key: 'credits', label: '积分' }],
      unit: '积分',
      data: { source: { capability: 'relay.usage', args: { by: 'user' }, refreshSec: 120 } },
    },
  })

  const proposalCard = card({
    id: 'turn-proposal',
    sessionId: 'board',
    title: '待处理方案 #12',
    pinned: true,
    order: 4,
    origin: 'hub',
    spec: { kind: 'proposal', proposalId: 12 },
  })

  for (const [delay, item] of [
    [900, areaCard],
    [1700, stackedCard],
    [2500, donutCard],
    [3300, proposalCard],
  ] as const) {
    later(() => {
      state.board = [...state.board, item]
      broadcast({ type: 'canvas.upsert', item: { ...item } })
    }, delay)
  }
}

function buildState(scenario: MockScenario): CockpitMockState {
  const status = opsStatusOf(scenario)
  const empty = scenario === 'cockpit-empty'

  let canvas: Record<string, CanvasItem[]> = {}
  let board: CanvasItem[] = []
  let proposals: ProposalView[] = []
  let secrets: SecretRequestView[] = []

  if (!empty) {
    canvas = {
      [SESS_USAGE]: usageSessionCards(),
      [SESS_PLUGIN]: pluginSessionCards(),
      [SESS_ONCALL]: oncallSessionCards(),
    }
    proposals = proposalFixtures()
    // 态势板 = Hub 默认四张 + 钉住的卡（docs/24 §3.2）
    board = [...defaultBoardCards(), ...pinnedCards(canvas)]
  }

  if (scenario === 'cockpit-r3') {
    const r3 = r3Proposal()
    proposals = [r3]
    // R3 方案卡落在「值班」会话里（Hub 造卡，sessionId 是会话本身）；态势板的「待处理方案」
    // 表格会通过 source 能力列出它
    canvas[SESS_ONCALL] = [
      card({
        id: 'card-r3-proposal',
        sessionId: SESS_ONCALL,
        title: '方案 #15 · 删除用户 test-x',
        pinned: false,
        order: 1,
        origin: 'hub',
        spec: { kind: 'proposal', proposalId: 15 },
      }),
      card({
        id: 'card-r3-entity',
        sessionId: SESS_ONCALL,
        title: 'test-x',
        pinned: false,
        order: 2,
        origin: 'dsh',
        spec: { kind: 'entity', entity: 'user', id: 9 },
      }),
    ]
    board = [...defaultBoardCards(), ...pinnedCards(canvas)]
  }

  if (scenario === 'cockpit-secret') {
    secrets = [secretRequestFixture()]
    canvas[SESS_ONCALL] = secretSessionCards()
    proposals = []
    board = [
      // 这个场景没有方案，「待处理方案」那张默认卡不出现
      ...defaultBoardCards().filter((item) => item.id !== 'board:pending-proposals'),
      ...pinnedCards(canvas),
    ]
  }

  if (scenario === 'cockpit-off') {
    // I6：座舱停了，态势板与待处理方案仍然可用
    proposals = proposalFixtures().filter((item) => item.status === 'pending')
    canvas = {}
    board = defaultBoardCards()
  }

  if (scenario === 'cockpit-turn') {
    /*
     * 「一个回合连续投放 3 张卡」的演示（任务书要求：左图、左表、右方案）。
     * 开局两舷都是空的，之后依次经 SSE 推 canvas.upsert —— 走查时能看清
     * 「卡片从中控台边缘飞出 + 落位亮边 + 本回合强调」这套动效。
     */
    board = []
    canvas = {}
    proposals = proposalFixtures().filter((item) => item.status === 'pending')
    secrets = []
    scheduleTurnDemo()
  }

  return {
    scenario,
    status,
    startAttempts: 0,
    strip: {
      ...stripOf(scenario),
      pendingProposals: proposals.filter((item) => item.status === 'pending').length,
    },
    catalog: CATALOG,
    canvas,
    board,
    proposals,
    secrets,
  }
}

/** 换场景时重置（`installMockFetch` 调用；测试之间不互相影响）。 */
export function resetCockpitMock(scenario: MockScenario = 'cockpit'): void {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  state = buildState(scenario)
}

// ────────────────────────────── 假接口 ──────────────────────────────

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

function apiError(code: string, status: number, message: string): Response {
  return json({ error: { code, message, details: {} } }, status)
}

function readJsonBody(init?: RequestInit): Record<string, unknown> {
  const raw = init?.body
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function findCard(id: string): { item: CanvasItem; list: CanvasItem[]; key: string } | null {
  for (const [key, list] of Object.entries(state.canvas)) {
    const item = list.find((row) => row.id === id)
    if (item) return { item, list, key }
  }
  const boardItem = state.board.find((row) => row.id === id)
  if (boardItem) return { item: boardItem, list: state.board, key: 'board' }
  return null
}

/** `/source` 的假数据源（只实现目录里 `dataSource=true` 的几个 R0 能力）。 */
function sourceRows(capability: string, args: Record<string, unknown>): Record<string, unknown>[] | null {
  const days = recentDays(7)
  switch (capability) {
    case 'cockpit.board-vitals':
      // 与真能力同形：一行就是 stats 卡的一项（value/max/spark/tone）
      return [
        { label: '运行实例', value: 5, max: 12 },
        { label: '今日请求', value: 421, spark: [310, 402, 366, 512, 470, 604, 421] },
        {
          label: '今日积分消耗',
          value: 3.21,
          unit: '积分',
          spark: [2.4, 3.1, 2.8, 4.2, 3.8, 5.1, 3.21],
        },
        { label: '失败任务', value: 1, tone: 'bad' },
      ]
    case 'cockpit.pending-proposals': {
      // 态势板右舷「待处理方案」（WP56a 追加的能力）：默认只看 pending，与真能力同口径
      const wanted = typeof args['status'] === 'string' ? args['status'] : 'pending'
      return state.proposals
        .filter((proposal) => proposal.status === wanted)
        .map((proposal) => ({
          proposalId: proposal.id,
          title: proposal.title,
          risk: proposal.risk,
          steps: proposal.steps.length,
          status: proposal.status,
          sessionId: proposal.sessionId,
          createdAt: proposal.createdAt,
          expiresAt: proposal.expiresAt,
        }))
    }
    case 'users.list':
      return [
        {
          id: 3,
          username: 'alice',
          role: '管理员',
          points: 32.14,
          requests: 1203,
          lastLoginAt: minutesFromNow(-35),
        },
        {
          id: 7,
          username: 'bob',
          role: '家人',
          points: 21.4,
          requests: 842,
          lastLoginAt: minutesFromNow(-95),
        },
        {
          id: 12,
          username: 'test-y',
          role: '普通用户',
          points: 12.07,
          requests: 421,
          lastLoginAt: minutesFromNow(-240),
        },
        {
          id: 9,
          username: 'test-x',
          role: '普通用户',
          points: 8.2,
          requests: 210,
          lastLoginAt: minutesFromNow(-1500),
        },
        {
          id: 15,
          username: 'carol',
          role: '朋友',
          points: 6.4,
          requests: 133,
          lastLoginAt: minutesFromNow(-2880),
        },
        {
          id: 18,
          username: 'dave',
          role: '普通用户',
          points: 5.86,
          requests: 98,
          lastLoginAt: minutesFromNow(-4300),
        },
      ]
    case 'relay.usage':
      // 图表卡要按来源分组的序列；态势板的表格要按天的汇总（`args.by === 'day'`）
      if (args['by'] === 'user') {
        // donut（按用户占比）要 分类名 + 数值
        return [
          { username: 'alice', credits: 32.14, requests: 1203 },
          { username: 'bob', credits: 21.4, requests: 842 },
          { username: 'test-y', credits: 12.07, requests: 421 },
          { username: 'test-x', credits: 8.2, requests: 210 },
          { username: 'carol', credits: 6.4, requests: 133 },
          { username: 'dave', credits: 5.86, requests: 98 },
        ]
      }
      if (args['by'] === 'day') {
        return days.map((day, index) => ({
          day,
          requests: [310, 402, 366, 512, 470, 604, 421][index] ?? 0,
          inputTokens: 820_000 + index * 40_000,
          outputTokens: 96_000 + index * 8_000,
          credits: Number(([2.4, 3.1, 2.8, 4.2, 3.8, 5.1, 3.21][index] ?? 0).toFixed(2)),
        }))
      }
      return days.map((day, index) => ({
        day,
        dsh: [9.2, 11.4, 8.6, 14.1, 12.8, 16.4, 10.7][index] ?? 0,
        claude: [4.1, 3.2, 5.6, 7.4, 6.1, 8.8, 5.2][index] ?? 0,
        codex: [0.4, 0.8, 0.6, 1.2, 0.9, 1.6, 1.1][index] ?? 0,
      }))
    case 'jobs.list': {
      // 态势板「失败任务」表要 id / title / status / failed / createdAt
      const jobs = [
        {
          id: 9001,
          title: '构建 DSH 版本 1.4.0',
          status: 'running',
          total: 12,
          done: 7,
          failed: 0,
          createdAt: minutesFromNow(-14),
        },
        {
          id: 9002,
          title: '下发插件 dsh-memory 0.1.4',
          status: 'failed',
          total: 8,
          done: 6,
          failed: 2,
          createdAt: minutesFromNow(-45),
        },
        {
          id: 9003,
          title: '升级 DSH 版本',
          status: 'queued',
          total: 12,
          done: 0,
          failed: 0,
          createdAt: minutesFromNow(-3),
        },
      ]
      // 真能力按 status 过滤：态势板只问 failed，就别把运行中/排队中的行混进来
      const jobStatus = typeof args['status'] === 'string' ? args['status'] : ''
      return jobStatus ? jobs.filter((row) => row.status === jobStatus) : jobs
    }
    case 'instances.list': {
      // 态势板「实例资源」柱状图用 username + memoryUsedMb（派生的 MB 数），
      // 「运行中实例」明细表用 status / cpuPercent / memoryBytes / memoryLimitBytes + userId
      const instances = [
        {
          userId: 3,
          username: 'alice',
          status: 'running',
          cpuPercent: 12,
          memoryBytes: 851_443_712,
          memoryUsedMb: 812,
          memoryLimitBytes: 2_147_483_648,
        },
        {
          userId: 7,
          username: 'bob',
          status: 'running',
          cpuPercent: 8,
          memoryBytes: 671_088_640,
          memoryUsedMb: 640,
          memoryLimitBytes: 2_147_483_648,
        },
        {
          userId: 12,
          username: 'test-y',
          status: 'starting',
          cpuPercent: 3,
          memoryBytes: 134_217_728,
          memoryUsedMb: 128,
          memoryLimitBytes: 1_073_741_824,
        },
        {
          userId: 9,
          username: 'test-x',
          status: 'error',
          cpuPercent: 0,
          memoryBytes: 0,
          memoryUsedMb: 0,
          memoryLimitBytes: 1_073_741_824,
        },
        {
          userId: 15,
          username: 'carol',
          status: 'stopped',
          cpuPercent: 0,
          memoryBytes: 0,
          memoryUsedMb: 0,
          memoryLimitBytes: 1_073_741_824,
        },
      ]
      const status = typeof args['status'] === 'string' ? args['status'] : ''
      return status ? instances.filter((row) => row.status === status) : instances
    }
    case 'plugins.list':
      return [
        { name: 'dsh-memory', version: '0.1.4', installs: 8, pending: 2 },
        { name: 'dsh-websearch', version: '0.3.1', installs: 12, pending: 0 },
        { name: 'dsh-seki', version: '0.2.0', installs: 3, pending: 1 },
      ]
    case 'overview.summary':
      return [
        {
          users: 12,
          runningInstances: 5,
          pendingUsers: 1,
          failedJobs24h: 2,
          diskFreeGb: 42,
        },
      ]
    default:
      return null
  }
}

function proposalById(id: number): ProposalView | undefined {
  return state.proposals.find((item) => item.id === id)
}

function upsertProposal(proposal: ProposalView): void {
  const index = state.proposals.findIndex((item) => item.id === proposal.id)
  if (index === -1) state.proposals.push(proposal)
  else state.proposals[index] = proposal
}

/** 把方案卡同步到对应的画布卡标题（状态变了，卡片标题也带上结果）。 */
function proposalCardTitle(proposal: ProposalView): string {
  const suffix =
    proposal.status === 'succeeded'
      ? ' · 已完成'
      : proposal.status === 'failed'
        ? ' · 失败'
        : proposal.status === 'rejected'
          ? ' · 已拒绝'
          : ''
  return `方案 #${String(proposal.id)} · ${proposal.title}${suffix}`
}

function broadcastProposal(proposal: ProposalView): void {
  upsertProposal(proposal)
  broadcast({ type: 'proposal.upsert', proposal })
  for (const list of Object.values(state.canvas)) {
    for (const item of list) {
      if (item.spec.kind !== 'proposal' || item.spec.proposalId !== proposal.id) continue
      item.title = proposalCardTitle(proposal)
      item.updatedAt = nowIso()
      broadcast({ type: 'canvas.upsert', item: { ...item } })
    }
  }
  // 态势板上的方案卡也要跟着变
  for (const item of state.board) {
    if (item.spec.kind !== 'proposal' || item.spec.proposalId !== proposal.id) continue
    item.title = proposalCardTitle(proposal)
    item.updatedAt = nowIso()
    broadcast({ type: 'canvas.upsert', item: { ...item } })
  }
  refreshStrip()
}

function decideProposal(id: number, status: 'running' | 'rejected'): Response {
  const proposal = proposalById(id)
  if (!proposal) return apiError('NOT_FOUND', 404, '方案不存在')
  if (proposal.status !== 'pending') return apiError('CONFLICT', 409, '这个方案已经处理过了')

  const next: ProposalView = {
    ...proposal,
    status,
    decidedBy: { id: 1, username: 'admin' },
    decidedAt: nowIso(),
  }
  broadcastProposal(next)

  if (status === 'running') {
    // 方案是异步执行的：2.4 秒后给最终结果（截图与走查能看到「执行中 → 已完成」）
    later(() => {
      const current = proposalById(id)
      if (!current || current.status !== 'running') return
      const ok = id !== 14
      broadcastProposal({
        ...current,
        status: ok ? 'succeeded' : 'failed',
        outcome: current.steps.map((step, index) => ({
          stepIndex: index,
          ok: ok || index > 0,
          result: ok ? { capability: step.capability, applied: true } : undefined,
          error: ok ? undefined : { code: 'INTERNAL', message: '执行失败（假数据）' },
        })),
      })
    }, 2400)
  }

  return json(next)
}

/** `/api/admin/cockpit/**` 的假响应；`null` = 不是座舱接口。 */
export function handleCockpit(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Response | null {
  if (!pathname.startsWith('/api/admin/cockpit')) return null

  const path = pathname.slice('/api/admin/cockpit'.length) || '/'

  if (path === '/state' && method === 'GET') {
    return json({
      status: state.status,
      pendingProposals: state.proposals.filter((item) => item.status === 'pending').length,
      catalog: state.catalog,
      strip: state.strip,
    })
  }

  if (path === '/status-strip' && method === 'GET') {
    return json(state.strip)
  }

  if (path === '/ops-instance/start' || path === '/ops-instance/restart') {
    // WP58：`cockpit-fail` 第一次启动失败（加载卡显示原因），重试一次就成功
    if (state.scenario === 'cockpit-fail' && state.startAttempts === 0) {
      state.startAttempts += 1
      const failed: OpsStatus = {
        ...state.status,
        instance: 'stopped',
        reason: '启动失败：容器运行时不可用（假数据）',
      }
      state.status = failed
      broadcast({ type: 'ops.status', status: failed })
      return apiError('INTERNAL', 500, '启动失败：容器运行时不可用（假数据）')
    }
    state.startAttempts += 1
    const running: OpsStatus = { ...state.status, instance: 'starting', reason: '正在启动座舱容器…' }
    state.status = running
    broadcast({ type: 'ops.status', status: running })
    later(() => {
      state.status = {
        instance: 'running',
        model: 'deepseek-v4.1-flash',
        autoExecuteR1: state.status.autoExecuteR1,
      }
      broadcast({ type: 'ops.status', status: state.status })
    }, 2000)
    return json({ status: running })
  }

  if (path === '/settings' && method === 'PUT') {
    const body = readJsonBody(init)
    const next: OpsStatus = {
      ...state.status,
      model: typeof body['model'] === 'string' ? body['model'] : state.status.model,
      autoExecuteR1:
        typeof body['autoExecuteR1'] === 'boolean' ? body['autoExecuteR1'] : state.status.autoExecuteR1,
    }
    state.status = next
    broadcast({ type: 'ops.status', status: next })
    return json({ status: next })
  }

  if (path === '/handoff' && method === 'POST') {
    const code = `hnd_${Math.random().toString(36).slice(2, 12)}`
    return json({ code, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  }

  if (path === '/canvas' && method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    return json({ items: state.canvas[sessionId] ?? [] })
  }

  if (path === '/board' && method === 'GET') {
    // 与真后端同形（CockpitBoardResponse）：钉住的一组 + 默认的一组
    const board = [...state.board].sort((a, b) => a.order - b.order)
    return json({
      pinned: board.filter((item) => item.pinned),
      defaults: board.filter((item) => !item.pinned),
    })
  }

  const canvasItem = /^\/canvas\/(.+)$/.exec(path)
  if (canvasItem) {
    const id = decodeURIComponent(canvasItem[1] ?? '')
    const found = findCard(id)
    if (!found) return apiError('NOT_FOUND', 404, '这张卡已经不在了')

    if (method === 'PATCH') {
      const body = readJsonBody(init)
      if (typeof body['pinned'] === 'boolean') found.item.pinned = body['pinned']
      if (typeof body['order'] === 'number') found.item.order = body['order']
      // 拖动换舷（docs/24 §1）：真后端也是存解析后的 left/right
      if (body['placement'] === 'left' || body['placement'] === 'right') {
        found.item.placement = body['placement']
      }
      found.item.updatedAt = nowIso()

      if (found.key !== 'board') {
        // 钉住 / 取消钉住要同步态势板
        if (found.item.pinned) {
          const exists = state.board.some((row) => row.id === found.item.id)
          if (!exists) state.board.push({ ...found.item })
        } else {
          state.board = state.board.filter((row) => row.id !== found.item.id)
        }
      }
      broadcast({ type: 'canvas.upsert', item: { ...found.item } })
      return json(found.item)
    }

    if (method === 'DELETE') {
      if (found.key === 'board') state.board = state.board.filter((row) => row.id !== id)
      else state.canvas[found.key] = found.list.filter((row) => row.id !== id)
      broadcast({ type: 'canvas.remove', id, sessionId: found.item.sessionId })
      return noContent()
    }
  }

  if (path === '/source' && method === 'POST') {
    const body = readJsonBody(init)
    const capability = typeof body['capability'] === 'string' ? body['capability'] : ''
    const args =
      body['args'] && typeof body['args'] === 'object' ? (body['args'] as Record<string, unknown>) : {}
    const descriptor = state.catalog.find((item) => item.id === capability)
    if (!descriptor || !descriptor.dataSource) {
      return apiError('FORBIDDEN', 403, '这个能力不能当画布数据源')
    }
    const rows = sourceRows(capability, args)
    if (!rows) return apiError('NOT_IMPLEMENTED', 501, '假数据还没实现这个数据源')
    return json({ rows, truncated: false })
  }

  if (path === '/proposals' && method === 'GET') {
    const status = url.searchParams.get('status')
    const sessionId = url.searchParams.get('sessionId')
    const items = state.proposals
      .filter((item) => (status ? item.status === status : true))
      .filter((item) => (sessionId ? item.sessionId === sessionId : true))
    return json({ items })
  }

  const decision = /^\/proposals\/(\d+)\/(approve|reject)$/.exec(path)
  if (decision) {
    const id = Number(decision[1])
    return decideProposal(id, decision[2] === 'approve' ? 'running' : 'rejected')
  }

  const secretAction = /^\/secret-requests\/(.+)$/.exec(path)
  if (secretAction) {
    const id = decodeURIComponent(secretAction[1] ?? '')
    const request = state.secrets.find((item) => item.id === id)
    if (!request) return apiError('NOT_FOUND', 404, '这条密钥请求已经失效')

    if (method === 'POST') {
      const body = readJsonBody(init)
      if (typeof body['value'] !== 'string' || body['value'].length === 0) {
        return apiError('VALIDATION_FAILED', 400, '请填写密钥')
      }
      request.status = 'filled'
      broadcast({ type: 'secret.request', request: { ...request } })
      for (const list of Object.values(state.canvas)) {
        for (const item of list) {
          if (item.spec.kind !== 'secret-request' || item.spec.requestId !== id) continue
          item.title = '密钥已填写'
          item.updatedAt = nowIso()
          broadcast({ type: 'canvas.upsert', item: { ...item } })
        }
      }
      return noContent()
    }

    if (method === 'DELETE') {
      request.status = 'cancelled'
      broadcast({ type: 'secret.request', request: { ...request } })
      return noContent()
    }
  }

  return null
}

/** 场景判定（`mocks/fetch.ts` 与 `mocks/admin.ts` 用）。 */
export function isCockpitScenario(scenario: MockScenario): boolean {
  return (
    scenario === 'cockpit' ||
    scenario === 'cockpit-empty' ||
    scenario === 'cockpit-off' ||
    scenario === 'cockpit-r3' ||
    scenario === 'cockpit-secret' ||
    scenario === 'cockpit-turn' ||
    scenario === 'cockpit-boot' ||
    scenario === 'cockpit-fail' ||
    scenario === 'cockpit-legacy'
  )
}

/** 测试用：读当前假状态（不要在生产代码里用）。 */
export function getCockpitMockState(): CockpitMockState {
  return state
}
