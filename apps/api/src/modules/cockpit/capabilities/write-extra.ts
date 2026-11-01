import { z } from 'zod'
import {
  AgentModeTargetsSchema,
  DeliveryActionSchema,
  DeliveryItemSchema,
  DeliveryPlatformSchema,
  DeliveryTargetsSchema,
  PartialQuotaSchema,
  PlatformSchema,
  PluginPolicySchema,
  RelayAgentModeSchema,
  RelayPriceInputSchema,
  StrategySchema,
  TargetsSchema,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import type { InternalInstanceService } from '../../instances/service.js'
import { defineCapability } from './define.js'
import { deliveryPreview, assertNotSystemUser, parseDeliveryRequest } from './read-extra.js'
import type { CapabilityContext } from './types.js'
import { actorOf, adminActor, assertNotOpsInstance, rolloutPreview, userLabel } from './write.js'

/**
 * 补齐 docs/24 §4 里**未标 ★** 的 R1 / R2 能力（WP56e1）。
 *
 * 与 `write.ts` 一样的三条硬规矩：
 * 1. 参数先过 zod（`defineCapability` 保证），能力内不再相信任何外来字段；
 * 2. 写类能力**必须**有 `preview`（I3：影响面由 Hub 算并存库，DSH 的 rationale 不参与）；
 * 3. 调 service，不走 HTTP 回环；`ctx.actor` 就是批准的管理员（I2）。
 *
 * R3（含 `secretFields` 的两个）在 `write-sensitive.ts`。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

/** 用户维度的写能力（配额 / 钱包）：都不能指着座舱自己的系统账号 */
function assertTargetUser(ctx: CapabilityContext, userId: number): void {
  assertNotSystemUser(ctx, userId)
}

const credits = (micro: number): number => Math.round(micro) / 1_000_000

// ── R1 低风险可逆 ───────────────────────────────────────────────────────────

const jobsRetry = defineCapability({
  id: 'jobs.retry',
  area: 'jobs',
  title: '重试失败任务',
  description:
    '把一个任务里**失败的那几步**重置为待执行、任务状态回到运行中（已成功的步骤不重跑）。' +
    '排障常用：先 jobs.get / jobs.logs 确认失败原因已经消失，再重试。低风险可逆，默认自动执行。' +
    '要暂停或取消任务在经典页面（座舱没有这两个能力）。',
  risk: 'R1',
  classicPath: '/admin/jobs',
  input: z.object({
    jobId: z.number().int().positive().describe('任务 id（jobs.list 的 id）'),
  }),
  async preview(ctx, args) {
    const detail = await services(ctx).jobs.get(args.jobId)
    const failed = detail.tasks.filter((task) => task.status === 'failed')
    if (failed.length === 0) {
      throw new HubError('VALIDATION_FAILED', `任务 #${String(args.jobId)} 没有失败的步骤，不需要重试`)
    }
    return {
      summary: `重试任务 #${String(args.jobId)}「${detail.job.title}」的 ${String(
        failed.length,
      )} 个失败步骤（当前 ${detail.job.status}）`,
      affected: failed.slice(0, 500).map((task) => ({
        kind: 'job' as const,
        id: task.id,
        label: `步骤 #${String(task.seq)}${task.username ? ` · ${task.username}` : ''}`,
      })),
      warnings: detail.tasks.some((task) => task.status === 'running')
        ? ['任务里还有正在跑的步骤：重试会等它们收尾后再排']
        : [],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).jobs.retryFailed(args.jobId, ctx.meta, actor.actorId)
  },
})

const instancesProbe = defineCapability({
  id: 'instances.probe',
  area: 'instances',
  title: '刷新会话探针',
  description:
    '现在就去探一遍运行中实例的 DSH 会话状态（有无人在看、有几个进行中的回合），写回探针状态供列表显示。' +
    '问「他到底在不在用」「这个实例是不是卡住了」时，先用 instances.get 看缓存，数字可疑再用它刷新。' +
    '低风险可逆（只写探针状态，不动容器）；不给 userId 就是全部运行中实例。',
  risk: 'R1',
  classicPath: '/admin/instances',
  input: z.object({
    userId: z.number().int().positive().optional().describe('只探这一个用户；省略 = 全部运行中实例'),
  }),
  async preview(ctx, args) {
    const s = services(ctx)
    const entries = await s.instances.listForAdmin(
      args.userId === undefined ? { status: 'running' } : undefined,
    )
    const rows = entries.filter(
      (entry) => entry.status === 'running' && (args.userId === undefined || entry.user.id === args.userId),
    )
    if (args.userId !== undefined) assertNotOpsInstance(ctx, args.userId)
    return {
      summary:
        args.userId === undefined
          ? `探测 ${String(rows.length)} 个运行中实例的会话状态（只写探针状态，不影响容器）`
          : `${await userLabel(ctx, args.userId)} 的实例当前 ${rows[0]?.status ?? 'absent'}：探测其会话状态`,
      affected: rows.slice(0, 500).map((entry) => ({
        kind: 'instance' as const,
        id: entry.user.id,
        label: `${entry.user.username}（${entry.status}）`,
      })),
      ...(rows.length === 0 ? { warnings: ['没有运行中的实例可探测：这一步不会做什么'] } : {}),
    }
  },
  async run(ctx, args) {
    if (args.userId !== undefined) assertNotOpsInstance(ctx, args.userId)
    const instances = services(ctx).instances as InternalInstanceService
    const entries = await instances.probeRunningInstances()
    const filtered =
      args.userId === undefined ? entries : entries.filter((entry) => entry.userId === args.userId)
    return {
      probed: filtered.length,
      rows: filtered.map((entry) => ({ userId: entry.userId, state: entry.state })),
    }
  },
})

// ── R2 有影响 ───────────────────────────────────────────────────────────────

const runtimeRollout = defineCapability({
  id: 'rollouts.runtime',
  area: 'rollouts',
  title: '下发 DSH 版本',
  description:
    '把某个 DSH 版本（运行时镜像）下发给用户：重建容器到该镜像，失败自动回滚。' +
    '先用 runtimes.list 找到 runtimeId（不确定默认版本就用 isDefault=true 的那个）。' +
    '影响面由 Hub 计算（每个用户「当前 → 之后」与是否重启）；正在跑的用户会被重建容器（数据卷保留）。' +
    '要下发插件用 rollouts.plugin、模型预设用 rollouts.model。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/rollouts',
  input: z.object({
    runtimeId: z.number().int().positive().describe('runtimeId（runtimes.list 里 ready 的行）'),
    targets: TargetsSchema,
    strategy: StrategySchema.partial().optional().describe('并发/金丝雀/失败比例；省略用默认'),
  }),
  async preview(ctx, args) {
    return await rolloutPreview(ctx, {
      kind: 'runtime',
      runtimeId: args.runtimeId,
      targets: args.targets,
      strategy: args.strategy ?? {},
    })
  },
  async run(ctx, args) {
    return await services(ctx).rollouts.create(
      {
        kind: 'runtime',
        runtimeId: args.runtimeId,
        targets: args.targets,
        strategy: StrategySchema.parse(args.strategy ?? {}),
      },
      actorOf(ctx).id,
      ctx.meta,
    )
  },
})

const modelRollout = defineCapability({
  id: 'rollouts.model',
  area: 'rollouts',
  title: '下发模型配置',
  description:
    '把模型与 API 配置（模型预设）下发给用户：重写他们的 managed 配置并重启容器。' +
    'presetId 省略 = 用默认预设（先用 models.list kind=presets 看有哪些）。影响面由 Hub 计算；' +
    '只改价格用 models.price.set，只改某人的预设归属用经典页面。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/rollouts',
  input: z.object({
    presetId: z.number().int().positive().optional().describe('省略 = 默认预设'),
    targets: TargetsSchema,
    strategy: StrategySchema.partial().optional(),
  }),
  async preview(ctx, args) {
    return await rolloutPreview(ctx, {
      kind: 'models',
      ...(args.presetId === undefined ? {} : { presetId: args.presetId }),
      targets: args.targets,
      strategy: args.strategy ?? {},
    })
  },
  async run(ctx, args) {
    return await services(ctx).rollouts.create(
      {
        kind: 'models',
        ...(args.presetId === undefined ? {} : { presetId: args.presetId }),
        targets: args.targets,
        strategy: StrategySchema.parse(args.strategy ?? {}),
      },
      actorOf(ctx).id,
      ctx.meta,
    )
  },
})

const deliveriesCreate = defineCapability({
  id: 'deliveries.create',
  area: 'rollouts',
  title: '提交统一下发',
  description:
    '提交一次「统一下发」（实例侧建任务、桌面侧出新清单 revision）：平台 + 内容项 + 动作 + 目标。' +
    '内容项从 plugins.list / runtimes.list / models.list 拿 id；**先把参数交给 deliveries.preview 看影响面**' +
    '（本能力自己也会算同样一份进方案卡）。有影响：出方案卡，批准后按任务进度执行。',
  risk: 'R2',
  classicPath: '/admin/rollouts',
  input: z.object({
    platforms: z.array(DeliveryPlatformSchema).min(1).max(2).describe('instance=云上实例，desktop=桌面端'),
    items: z.array(DeliveryItemSchema).min(1).describe('内容项：plugin / models / runtime'),
    action: DeliveryActionSchema,
    targets: DeliveryTargetsSchema,
    strategy: StrategySchema.partial().optional().describe('并发/金丝雀/失败比例；省略用默认'),
  }),
  async preview(ctx, args) {
    return await deliveryPreview(ctx, args)
  },
  async run(ctx, args) {
    const request = parseDeliveryRequest(args)
    return await services(ctx).deliveries.create(request, actorOf(ctx).id, ctx.meta)
  },
})

const usersQuotaSet = defineCapability({
  id: 'users.quota.set',
  area: 'users',
  title: '修改用户配额',
  description:
    '改一个用户的资源配额：cpus / memoryMb / diskGb / pidsLimit / 空闲停实例分钟数 / 是否允许自装插件。' +
    '只写给出的字段（其余保持不变）；quota=null 表示恢复全局默认。改完在**这个实例下次重启**时生效。' +
    '先用 users.get 看当前配额。要动钱包余额用 users.wallet.grant。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/users',
  input: z.object({
    userId: z.number().int().positive().describe('用户 id'),
    quota: PartialQuotaSchema.describe('只给要改的字段；整体传 {} 等于不改'),
  }),
  async preview(ctx, args) {
    assertTargetUser(ctx, args.userId)
    const detail = await services(ctx).adminUsers.getUser(args.userId)
    const before = detail.user.quota
    const after = { ...before, ...args.quota }
    const changed = Object.entries(args.quota)
      .filter(([key, value]) => (before as Record<string, unknown>)[key] !== value)
      .map(([key]) => key)
    return {
      summary: `改 ${await userLabel(ctx, args.userId)} 的配额：${
        changed.length === 0 ? '没有字段变化' : changed.join('、')
      }（CPU ${String(before.cpus)}→${String(after.cpus)}，内存 ${String(before.memoryMb)}→${String(
        after.memoryMb,
      )} MB，磁盘 ${String(before.diskGb)}→${String(after.diskGb)} GB）`,
      affected: [{ kind: 'user', id: args.userId, label: `用户 ${String(args.userId)} 的实例规格` }],
      warnings: [
        '新配额在这个实例下次重启时生效（要立刻生效就再出一张 instances.restart）',
        ...(changed.length === 0 ? ['没有字段真的变化，这一步不会改变任何东西'] : []),
      ],
    }
  },
  async run(ctx, args) {
    assertTargetUser(ctx, args.userId)
    const actor = adminActor(ctx)
    return await services(ctx).adminUsers.updateUser(args.userId, { quota: args.quota }, actor)
  },
})

const usersWalletGrant = defineCapability({
  id: 'users.wallet.grant',
  area: 'users',
  title: '增减用户余额',
  description:
    '给用户的中转站钱包加减积分（amountMicro 为正 = 充值，负 = 扣减；1 积分 = 1_000_000 微积分）。' +
    '会写一条流水、note 会进流水备注。问「给他补 100 积分」用它。改计费倍率/每日上限归经典页面；' +
    '看某人这周花了多少用 relay.usage。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: z.object({
    userId: z.number().int().positive().describe('用户 id'),
    credits: z
      .number()
      .describe('积分增量：正数充值、负数扣减（≤ ±100 万），例如 100 或 -20.5')
      .refine((value) => value !== 0, '积分增量不能为 0'),
    note: z.string().max(200).default('').describe('流水备注（会显示在用户的积分明细里）'),
  }),
  async preview(ctx, args) {
    assertTargetUser(ctx, args.userId)
    const wallet = services(ctx).relay.getWalletRow(args.userId)
    const amountMicro = Math.round(args.credits * 1_000_000)
    return {
      summary: `${args.credits > 0 ? '充值' : '扣减'} ${String(Math.abs(args.credits))} 积分给 ${await userLabel(
        ctx,
        args.userId,
      )}：余额 ${String(credits(wallet.balanceMicro))} → ${String(
        credits(wallet.balanceMicro + amountMicro),
      )} 积分`,
      affected: [{ kind: 'user', id: args.userId, label: `用户 ${String(args.userId)} 的钱包` }],
      ...(amountMicro < 0 && wallet.balanceMicro + amountMicro < 0
        ? { warnings: ['扣减后余额为负：这个用户接下来的模型请求会被拒（余额不足）'] }
        : {}),
    }
  },
  async run(ctx, args) {
    assertTargetUser(ctx, args.userId)
    const amountMicro = Math.round(args.credits * 1_000_000)
    const actor = adminActor(ctx)
    return await services(ctx).relay.adjustWallet(
      args.userId,
      { amountMicro, note: args.note },
      actor.actorId,
      ctx.meta,
    )
  },
})

const modelsPriceSet = defineCapability({
  id: 'models.price.set',
  area: 'models',
  title: '修改模型价格',
  description:
    '改一个对外模型的单价（微积分 / 百万 tokens）：输入、输出、缓存读/写、每次请求附加费。' +
    '先用 models.list kind=providers 或经典页面找到 modelId；价格是「原价」，实际扣费还要乘渠道倍率。' +
    '要改倍率去渠道（relay.channels.upsert 的 ratePermille）。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: z.object({
    modelId: z.number().int().positive().describe('对外模型 id（不是渠道 id）'),
    price: RelayPriceInputSchema.describe('单价（微积分 / 1M tokens）；省略的缓存项按 0 处理'),
  }),
  async preview(ctx, args) {
    const models = services(ctx).relay.listModels()
    const model = models.find((item) => item.id === args.modelId)
    if (!model) throw new HubError('NOT_FOUND', `模型 ${String(args.modelId)} 不存在（先用 models.list 查）`)
    const before = model.price
    const perMillion = (micro: number): string => (Math.round(micro) / 1_000_000).toString()
    return {
      summary:
        `改模型「${model.displayName || model.name}」的价格：输入 ${perMillion(before.inputMicro)} → ` +
        `${perMillion(microOf(args.price.inputMicro))}、输出 ${perMillion(before.outputMicro)} → ` +
        `${perMillion(microOf(args.price.outputMicro))} 积分/百万 tokens`,
      affected: [{ kind: 'model', id: model.id, label: model.name }],
      warnings: ['价格按渠道倍率缩放后才落到用户账单；正在进行的请求仍按旧价'],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).relay.updateModel(args.modelId, { price: args.price }, actor.actorId, ctx.meta)
  },
})

/** `RelayPriceInputSchema` 的数值字段在入参里可能缺省（有 default），统一取值 */
function microOf(value: number | undefined): number {
  return value ?? 0
}

const agentModesAssign = defineCapability({
  id: 'agent-modes.assign',
  area: 'agent-modes',
  title: '改对话模式开放范围',
  description:
    '改一个对话模式（claude-code / codex）的开通状态与开放范围：enabled、targets（all 或 userIds 列表）、' +
    '整体倍率 ratePermille、默认模型 defaultModelId。改完**还要下发**才进用户容器的 env（经典页面「下发」）。' +
    '先用 agent-modes.get 看当前范围与谁在用。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/claude-code',
  input: z.object({
    mode: RelayAgentModeSchema,
    enabled: z.boolean().optional().describe('整体开关；省略 = 不改'),
    targets: AgentModeTargetsSchema.optional().describe('{all:true} 或 {userIds:[…]}；省略 = 不改'),
    ratePermille: z.number().int().min(0).max(100_000).optional().describe('整体倍率（1000 = 原价）'),
    defaultModelId: z.number().int().positive().nullable().optional().describe('默认模型 id；null = 自动'),
    label: z.string().trim().min(1).max(32).optional(),
  }),
  async preview(ctx, args) {
    const state = await services(ctx).agentModes.state(args.mode)
    const before = state.settings.targets
    const beforeCount = 'all' in before ? state.users.length : before.userIds.length
    const after = args.targets ?? before
    const afterCount =
      'all' in after
        ? state.users.length
        : state.users.filter((user) => after.userIds.includes(user.userId)).length
    const name = args.mode === 'claude-code' ? 'Claude Code' : 'Codex'
    return {
      summary:
        `改 ${name} 的开放范围：${String(beforeCount)} 人 → ${String(afterCount)} 人` +
        `${args.enabled === undefined ? '' : `，${args.enabled ? '开通' : '关闭'}该模式`}` +
        `${args.targets === undefined ? '（开放范围不变）' : ''}；改完还需下发才进容器 env`,
      affected: state.users
        .filter((user) => 'all' in after || after.userIds.includes(user.userId))
        .slice(0, 500)
        .map((user) => ({ kind: 'user' as const, id: user.userId, label: user.username })),
      warnings: [
        ...(state.pending ? ['当前已有未下发的变更：这次会覆盖它们'] : []),
        '本次只改设置；进用户容器还要在经典页面点「下发」（或等下次重启）',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    const patch = {
      ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      ...(args.targets === undefined ? {} : { targets: args.targets }),
      ...(args.ratePermille === undefined ? {} : { ratePermille: args.ratePermille }),
      ...(args.defaultModelId === undefined ? {} : { defaultModelId: args.defaultModelId }),
      ...(args.label === undefined ? {} : { label: args.label }),
    }
    if (Object.keys(patch).length === 0) {
      throw new HubError('VALIDATION_FAILED', '至少要给一个要改的字段（enabled / targets / ratePermille…）')
    }
    return await services(ctx).agentModes.update(args.mode, patch, actor.actorId, ctx.meta)
  },
})

const desktopDevicesRevoke = defineCapability({
  id: 'desktop.devices.revoke',
  area: 'desktop',
  title: '吊销一台设备',
  description:
    '吊销一台设备（桌面端或手机）：它的令牌与设备密钥立即失效，用户要重新登录授权。' +
    'deviceId 从 desktop.devices.list / mobile.devices.list 拿（是 `dev_…` 这样的串，不是数字）。' +
    '要一次吊销多台用 desktop.devices.revoke-bulk（R3）。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/instances',
  input: z.object({
    deviceId: z.string().min(1).max(80).describe('设备标识（list 能力返回的 deviceId）'),
  }),
  async preview(ctx, args) {
    const detail = await services(ctx).desktop.detail(args.deviceId)
    return {
      summary: `吊销 ${detail.user.username} 的设备「${detail.device.name}」（${
        detail.device.presence
      }${detail.device.revokedAt ? '，已吊销过' : ''}）`,
      affected: [{ kind: 'device', id: detail.device.deviceId, label: detail.device.name }],
      warnings: [
        detail.device.revokedAt ? '这台设备之前已经吊销过：这一步不会改变什么' : '该设备的令牌与密钥立即失效',
        '被吊销后用户需要重新走一次登录授权',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).desktop.adminRevoke(args.deviceId, actor.actorId, ctx.meta)
  },
})

const pluginsPolicySet = defineCapability({
  id: 'plugins.policy.set',
  area: 'plugins',
  title: '修改插件策略',
  description:
    '改插件库里一个插件的策略：required（必装，用户卸不掉）/ default（默认装）/ optional（可选）/ hidden（下线，' +
    '用户看不到也装不了）。' +
    '只用 policy 一个参数；平台缺省云上实例（desktop 传 desktop）。先用 plugins.list 找 pluginId、' +
    '看它已经装了多少人。要下发版本用 rollouts.plugin。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: z.object({
    pluginId: z.number().int().positive().describe('插件 id（plugins.list 的 pluginId）'),
    policy: PluginPolicySchema,
    platform: PlatformSchema.optional().describe('cloud（实例，缺省）/ desktop'),
  }),
  async preview(ctx, args) {
    const platform = args.platform
    const rows = await services(ctx).plugins.listCatalog(platform)
    const plugin = rows.find((row) => row.id === args.pluginId)
    if (!plugin) {
      throw new HubError('NOT_FOUND', `插件 ${String(args.pluginId)} 不在这个平台的库里`)
    }
    return {
      summary:
        `把插件「${plugin.displayName}」的策略从 ${plugin.policy} 改成 ${args.policy}` +
        `（当前已装 ${String(plugin.stats.installed)} 人、待更新 ${String(plugin.stats.pending)} 人）`,
      affected: [{ kind: 'plugin', id: plugin.id, label: plugin.packageName }],
      warnings:
        args.policy === 'hidden'
          ? ['改成 hidden 后用户看不到也不能再装；已经装上的不会自动卸载']
          : args.policy === 'required'
            ? ['改成 required 后用户不能卸载，下次下发会强制装回去']
            : [],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).plugins.updatePlugin(
      args.pluginId,
      { policy: args.policy, ...(args.platform === undefined ? {} : { platform: args.platform }) },
      actor.actorId,
      ctx.meta,
    )
  },
})

/** 全部追加的 R1 / R2 能力（docs/24 §4 未标 ★ 的） */
export const WRITE_EXTRA_CAPABILITIES = [
  jobsRetry,
  instancesProbe,
  runtimeRollout,
  modelRollout,
  deliveriesCreate,
  usersQuotaSet,
  usersWalletGrant,
  modelsPriceSet,
  agentModesAssign,
  desktopDevicesRevoke,
  pluginsPolicySet,
] as const
