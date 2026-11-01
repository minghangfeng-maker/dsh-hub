import { z } from 'zod'
import {
  DeliveryPlatformSchema,
  DeliveryActionSchema,
  DeliveryItemSchema,
  DeliveryRequestSchema,
  DeliveryTargetsSchema,
  type DeliveryRequest,
  DesktopDeviceListQuerySchema,
  InviteListQuerySchema,
  RelayAgentModeSchema,
  RelayScopeSchema,
  RuntimeStatusSchema,
  StrategySchema,
  type ProposalPreview,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import * as cockpitRepo from '../repo.js'
import { defineCapability } from './define.js'
import type { CapabilityContext } from './types.js'

/**
 * 补齐 docs/24 §4 里**未标 ★** 的 R0（只读）能力（WP56e1）。
 *
 * 与 `read.ts` 的分工：read.ts 是 WP56a 的 ★ 核心（概览/用户/实例/任务/插件/模型/用量/审计/下发预览），
 * 这里是「平台侧」的只读视图（版本、渠道、模式、搜索池、代理、设备、邀请码、设置、统一下发预览）。
 *
 * 三条统一约定（与 read.ts 一致）：
 * 1. 调 service，不走 HTTP 回环；
 * 2. 返回 `{ rows }` 形态（画布 `source` 卡可直接当表用），只有单实体查询返回对象；
 * 3. 输出里的键名**不要**带 key/token/secret/password/cookie/subscription/credential
 *    （I4 会把它们整块换成 `[已隐藏]`）—— 要露「密钥是否配好」这种信息时换个说法（`configured` / `last4`）。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

/** 分页参数的统一切法：DSH 常在 pageSize 上传 1000，按 100 截断而不是报错 */
function clampPageSize(pageSize: number, max = 100): number {
  return Math.max(1, Math.min(max, Math.trunc(pageSize)))
}

// ── DSH 版本 ────────────────────────────────────────────────────────────────

const runtimesList = defineCapability({
  id: 'runtimes.list',
  area: 'runtimes',
  title: '列出 DSH 版本',
  description:
    '列出运行时镜像（DSH 版本）：版本号、镜像 tag、状态（building/ready/failed/retired）、是否默认、占多少磁盘、' +
    '多少用户在用、备注。问「现在有哪些 DSH 版本」「默认版本是哪个」「有没有构建失败的」用它。' +
    '要下发某个版本给用户用 rollouts.runtime（改动，会出方案卡）。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/runtimes',
  input: z.object({
    status: RuntimeStatusSchema.optional().describe(
      '只看这个状态的版本（ready / building / failed / retired）',
    ),
  }),
  async run(ctx, args) {
    const rows = await services(ctx).runtimes.list()
    return {
      rows: rows
        .filter((row) => args.status === undefined || row.status === args.status)
        .map((row) => ({
          runtimeId: row.id,
          dshVersion: row.dshVersion,
          image: row.image,
          status: row.status,
          isDefault: row.isDefault,
          sizeBytes: row.sizeBytes,
          usersOnIt: row.usersOnIt,
          notes: row.notes,
          createdAt: row.createdAt,
        })),
    }
  },
})

// ── 中转站渠道（只读） ──────────────────────────────────────────────────────

const relayChannelsList = defineCapability({
  id: 'relay.channels.list',
  area: 'relay',
  title: '列出中转站渠道',
  description:
    '列出中转站渠道：名称/slug、上游地址、支持的协议、倍率与优先级、是否启用、健康状态、最近错误、' +
    '密钥条数（只给「几把可用/共几把」与末四位，不给明文）、引用它的对外模型数。' +
    '问「渠道有没有挂」「哪个渠道在限流」「现在配了几个渠道」用它。改渠道或加密钥用 ' +
    'relay.channels.upsert（R3，需密钥卡）；只看整体用量用 relay.usage。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/models',
  input: z.object({
    scope: RelayScopeSchema.optional().describe('dsh（DSh 内置）/ claude-code / codex；缺省全部作用域'),
  }),
  async run(ctx, args) {
    const raw = services(ctx).relay.listChannels(args.scope)
    return {
      rows: raw.map((channel) => ({
        channelId: channel.id,
        name: channel.name,
        slug: channel.slug ?? '',
        baseUrl: channel.baseUrl,
        apis: channel.apis,
        scope: channel.scope ?? 'dsh',
        ratePermille: channel.ratePermille,
        priority: channel.priority,
        weight: channel.weight,
        enabled: channel.enabled,
        health: channel.health,
        failStreak: channel.failStreak,
        cooldownUntil: channel.cooldownUntil,
        lastError: channel.lastError,
        modelCount: channel.modelCount,
        inFlight: channel.inFlight,
        // 键名刻意不带 key/secret：I4 会把整块换成 [已隐藏]；这里只给计数与末四位
        active: channel.keys.filter((item) => item.state === 'active').length,
        total: channel.keys.length,
        last4: channel.keys.map((item) => item.last4),
        note: channel.note,
      })),
    }
  },
})

// ── Claude Code / Codex ─────────────────────────────────────────────────────

const agentModesGet = defineCapability({
  id: 'agent-modes.get',
  area: 'agent-modes',
  title: '查看对话模式配置',
  description:
    '查一个对话模式（claude-code / codex）的设置：是否开通、整体倍率、默认模型与小模型、开放范围（targets）、' +
    '容器 env 是否已生效、本月花费、待下发的用户数、警告。问「Claude Code 开着吗」「Codex 的倍率是多少」' +
    '「谁在用 claude-code」用它。改开放范围用 agent-modes.assign（改动），下发到容器用经典页面。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/claude-code',
  input: z.object({
    mode: RelayAgentModeSchema.describe('claude-code 或 codex'),
  }),
  async run(ctx, args) {
    const state = await services(ctx).agentModes.state(args.mode)
    const credits = (micro: number): number => Math.round(micro) / 1_000_000
    return {
      mode: state.mode,
      settings: {
        enabled: state.settings.enabled,
        ratePermille: state.settings.ratePermille,
        defaultModelId: state.settings.defaultModelId,
        smallModelId: state.settings.smallModelId,
        label: state.settings.label,
        targets: state.settings.targets,
        updatedAt: state.settings.updatedAt,
      },
      effectiveDefaultModel: state.effectiveDefaultModel,
      effectiveSmallModel: state.effectiveSmallModel,
      plugin: state.plugin,
      pending: state.pending,
      pendingUsers: state.pendingUsers,
      lastDeliver: state.lastDeliver,
      warnings: state.warnings,
      rows: state.users.map((user) => ({
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        targeted: user.targeted,
        pluginVersion: user.pluginVersion,
        instanceStatus: user.instanceStatus,
        envApplied: user.envApplied,
        monthCredits: credits(user.monthCostMicro),
      })),
    }
  },
})

// ── 搜索 / 抓取池 ───────────────────────────────────────────────────────────

const searchPools = defineCapability({
  id: 'search.pools',
  area: 'search',
  title: '搜索与抓取池',
  description:
    '列出搜索/抓取池的渠道（Tavily / DeepSeek 等）：类型、支持的工具有哪些、优先级与权重、是否启用、健康、' +
    '冷却原因、每次搜索/抓取的上游成本、可用密钥数与末四位，外加本月调用量/免费次数/营收。' +
    '问「搜索池还能用吗」「哪个搜索渠道额度用完了」用它。改渠道/密钥归经典页面（座舱没有对应写能力）。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/search',
  input: z.object({}),
  async run(ctx) {
    const s = services(ctx)
    const channels = s.relay.tools.listChannels()
    const overview = s.relay.tools.overview()
    const credits = (micro: number): number => Math.round(micro) / 1_000_000
    return {
      month: overview.month,
      totals: {
        calls: overview.totals.calls,
        freeCalls: overview.totals.freeCalls,
        revenueCredits: credits(overview.totals.revenueMicro),
        upstreamCostCredits: credits(overview.totals.upstreamCostMicro),
      },
      rows: channels.map((channel) => ({
        channelId: channel.id,
        kind: channel.kind,
        name: channel.name,
        baseUrl: channel.baseUrl,
        tools: channel.tools,
        priority: channel.priority,
        weight: channel.weight,
        enabled: channel.enabled,
        health: channel.health,
        failStreak: channel.failStreak,
        cooldownUntil: channel.cooldownUntil,
        lastError: channel.lastError,
        searchCostCredits: credits(channel.searchCostMicro),
        fetchCostCredits: credits(channel.fetchCostMicro),
        active: channel.keys.filter((item) => item.state === 'active').length,
        total: channel.keys.length,
        last4: channel.keys.map((item) => item.last4),
        note: channel.note,
      })),
    }
  },
})

// ── 网络代理 ────────────────────────────────────────────────────────────────

// ── 设备：桌面端 / 手机 ─────────────────────────────────────────────────────

/** 桌面端与手机共用的查询参数（种类由能力自己钉住，模型不用也不能改） */
const deviceListArgs = DesktopDeviceListQuerySchema.omit({ kind: true, pageSize: true }).extend({
  pageSize: z.number().int().min(1).max(100).default(50),
})

const desktopDevicesList = defineCapability({
  id: 'desktop.devices.list',
  area: 'desktop',
  title: '列出桌面端设备',
  description:
    '列桌面端（Windows/macOS/Linux）设备台账：所属用户、设备名、平台、版本、在线状态（online/offline/revoked）、' +
    '最后心跳、应用状态。问「有几台桌面端在用」「谁的设备掉线了」「这台设备装了什么版本」用它。' +
    '吊销设备用 desktop.devices.revoke（R2），批量吊销用 desktop.devices.revoke-bulk（R3）。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/instances',
  input: deviceListArgs,
  async run(ctx, args) {
    const page = await services(ctx).desktop.listAdmin({
      ...args,
      kind: 'desktop',
      pageSize: clampPageSize(args.pageSize),
    })
    return {
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      rows: page.items.map((item) => ({
        deviceId: item.device.deviceId,
        userId: item.user.id,
        username: item.user.username,
        displayName: item.user.displayName,
        name: item.device.name,
        platform: item.device.platform,
        arch: item.device.arch,
        appVersion: item.device.appVersion,
        runtimeVersion: item.device.runtimeVersion,
        presence: item.device.presence,
        applyState: item.device.applyState,
        lastReportAt: item.device.lastReportAt,
        revokedAt: item.device.revokedAt,
        revokeReason: item.device.revokeReason,
        pluginCount: item.pluginCount,
      })),
    }
  },
})

const mobileDevicesList = defineCapability({
  id: 'mobile.devices.list',
  area: 'mobile',
  title: '列出手机设备',
  description:
    '列手机端设备（安卓 / iOS / 手机网页版）：所属用户、设备名、平台、App 版本、在线状态、最后心跳、吊销原因。' +
    '问「有几个人在用手机端」「谁的手机掉了」用它。桌面端设备用 desktop.devices.list；' +
    '手机令牌不占设备的 10 台上限这类规则见经典页面。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/instances',
  input: deviceListArgs,
  async run(ctx, args) {
    const page = await services(ctx).desktop.listAdmin({
      ...args,
      kind: 'mobile',
      pageSize: clampPageSize(args.pageSize),
    })
    return {
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      rows: page.items.map((item) => ({
        deviceId: item.device.deviceId,
        userId: item.user.id,
        username: item.user.username,
        displayName: item.user.displayName,
        name: item.device.name,
        mobilePlatform: item.device.mobilePlatform ?? null,
        appVersion: item.device.appVersion,
        presence: item.device.presence,
        lastReportAt: item.device.lastReportAt,
        revokedAt: item.device.revokedAt,
        revokeReason: item.device.revokeReason,
      })),
    }
  },
})

// ── 邀请码 ──────────────────────────────────────────────────────────────────

const invitesList = defineCapability({
  id: 'invites.list',
  area: 'invites',
  title: '列出邀请码',
  description:
    '分页列注册邀请码：码、可用次数与已用次数、有效期、备注、角色标签、用过的人。问「还有哪些邀请码没用完」' +
    '「这个码谁用过了」用它。要新生成一批用 invites.create（R1，默认自动执行）。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/invites',
  input: InviteListQuerySchema,
  async run(ctx, query) {
    const page = await services(ctx).system.listInvites({
      ...query,
      pageSize: clampPageSize(query.pageSize),
    })
    return { total: page.total, page: page.page, pageSize: page.pageSize, rows: page.items }
  },
})

// ── 系统设置 ────────────────────────────────────────────────────────────────

const settingsGet = defineCapability({
  id: 'settings.get',
  area: 'settings',
  title: '读取系统设置',
  description:
    '读系统设置：站点信息与公告、注册模式与上限、容量（并发实例上限/维护模式）、导出、安全（会话时长、' +
    'reauth 窗口）、桌面端与手机 App 策略、座舱设置（模型、R1 自动执行）。问「注册开着吗」' +
    '「现在能同时跑几个实例」「座舱用的什么模型」用它。改设置归经典页面（座舱只读）。',
  risk: 'R0',
  classicPath: '/admin/settings',
  input: z.object({}),
  async run(ctx) {
    // `system.getSettings()` 返回的就是 Settings 本体（SettingsResponse = Settings），不是 `{settings}`
    return { settings: await services(ctx).system.getSettings() }
  },
})

// ── 统一下发预览 ────────────────────────────────────────────────────────────

/** 统一下发请求的「可生成 JSON Schema」版本：`DeliveryRequestSchema` 带 refine，`z.toJSONSchema` 会失败 */
const DeliveryDraftSchema = z.object({
  platforms: z.array(DeliveryPlatformSchema).min(1).max(2).describe('instance=云上实例，desktop=桌面端'),
  items: z.array(DeliveryItemSchema).min(1),
  action: DeliveryActionSchema,
  targets: DeliveryTargetsSchema,
  strategy: StrategySchema.partial().optional().describe('并发/金丝雀/失败比例；省略用默认'),
})

/**
 * 统一校验一次下发草稿（`deliveries.preview` / `deliveries.create` 共用）。
 *
 * 两步：先按能生成 JSON Schema 的 `DeliveryDraftSchema` 过一遍（给模型看的参数说明来自它），
 * 再用 `DeliveryRequestSchema` 过一遍 —— 后者带 `superRefine`（「DSH 版本只能下发实例」之类），
 * 是真正的业务规则；它进不了 JSON Schema，但不能因此绕过。
 */
export function parseDeliveryRequest(args: unknown): DeliveryRequest {
  const draft = DeliveryDraftSchema.parse(args)
  return DeliveryRequestSchema.parse({
    platforms: draft.platforms,
    items: draft.items,
    action: draft.action,
    targets: draft.targets,
    ...(draft.strategy === undefined ? {} : { strategy: draft.strategy }),
  })
}

const deliveriesPreview = defineCapability({
  id: 'deliveries.preview',
  area: 'rollouts',
  title: '预览统一下发影响面',
  description:
    '只读预览一次「统一下发」会影响谁：每个内容项 × 每个用户（桌面端按设备）一行，给出当前 → 之后、' +
    '是否要重启、跳过原因与警告。参数与经典「统一下发」向导一致（platforms + items + action + targets）。' +
    '**要真的下发用 deliveries.create（R2，出方案卡）**，它自己算同样的影响面，这个能力只回答「如果下发会怎样」。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/rollouts',
  input: DeliveryDraftSchema,
  async run(ctx, args) {
    const request = parseDeliveryRequest(args)
    const preview = await services(ctx).deliveries.preview(request, ctx.actor?.id ?? null)
    return {
      total: preview.rows.length,
      summary: preview.summary,
      warnings: preview.warnings,
      skippedItems: preview.skippedItems ?? [],
      truncated: preview.truncated,
      rows: preview.rows.map((row) => ({
        platform: row.platform,
        userId: row.userId,
        username: row.username,
        deviceName: row.deviceName,
        itemLabel: row.itemLabel,
        current: row.current,
        after: row.after,
        needsRestart: row.needsRestart,
        skipReason: row.skipReason,
      })),
    }
  },
})

/** `delivery-rollout.ts` 里的写能力共用这次的 preview（I3：与经典页面同一份计算） */
export async function deliveryPreview(ctx: CapabilityContext, args: unknown): Promise<ProposalPreview> {
  const request = parseDeliveryRequest(args)
  const preview = await services(ctx).deliveries.preview(request, ctx.actor?.id ?? null)
  const rows = preview.rows.filter((row) => row.skipReason === null)
  const restartCount = rows.filter((row) => row.needsRestart).length
  return {
    summary:
      `影响 ${String(preview.summary.instance.users)} 个用户 / ${String(
        preview.summary.desktop.devices,
      )} 台桌面设备：` +
      `实例侧执行 ${String(preview.summary.instance.willRun)} 项、跳过 ${String(
        preview.summary.instance.skipped,
      )} 项；` +
      `桌面侧执行 ${String(preview.summary.desktop.willRun)} 项、跳过 ${String(preview.summary.desktop.skipped)} 项` +
      `${restartCount > 0 ? `；${String(restartCount)} 行需要重启` : ''}`,
    affected: rows.slice(0, 2000).map((row) => ({
      kind: 'user' as const,
      id: row.userId,
      label: `${row.username}：${row.itemLabel} ${row.current} → ${row.after}`,
    })),
    warnings: [...preview.warnings, ...(preview.skippedItems ?? []).map((item) => item.reason)],
    detail: preview,
  }
}

/** 座舱能力里「不是 instances.* 但同样不该指着系统账号」的守卫（quota/wallet/restore 等用它） */
export function assertNotSystemUser(ctx: CapabilityContext, userId: number): void {
  if (cockpitRepo.isSystemUser(ctx.deps.db, userId)) {
    throw new HubError('VALIDATION_FAILED', '座舱系统账号不是普通用户，不能通过能力修改')
  }
}

/** 全部追加的 R0 能力（docs/24 §4 未标 ★ 的） */
export const READ_ONLY_EXTRA_CAPABILITIES = [
  runtimesList,
  relayChannelsList,
  agentModesGet,
  searchPools,
  desktopDevicesList,
  mobileDevicesList,
  invitesList,
  settingsGet,
  deliveriesPreview,
] as const
