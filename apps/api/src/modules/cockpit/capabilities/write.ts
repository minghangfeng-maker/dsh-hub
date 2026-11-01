import { z } from 'zod'
import {
  CreateInvitesRequestSchema,
  RolloutRequestSchema,
  StrategySchema,
  TargetsSchema,
  type ProposalPreview,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import * as cockpitRepo from '../repo.js'
import { defineCapability } from './define.js'
import type { CapabilityActor, CapabilityContext } from './types.js'

/**
 * R1 / R2 / R3（写）能力：docs/24 §4 标 ★ 的全部。
 *
 * 三条硬规矩：
 * 1. **参数先过 zod**（`defineCapability` 已保证），能力内不再相信任何外来字段；
 * 2. 写类能力**必须**有 `preview`（I3：影响面由 Hub 算并存库，DSH 的 rationale 不参与）；
 * 3. 调的是 service，不是 HTTP 回环（§4「直接调 service」），`ctx.actor` 就是批准的管理员（I2）。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

/** 写操作必须有执行者：方案执行时是批准的管理员，R1 自动执行时是 hub-ops */
export function actorOf(ctx: CapabilityContext): CapabilityActor {
  if (!ctx.actor) throw new HubError('INTERNAL', '写操作缺少执行者（座舱系统账号未就绪）')
  return ctx.actor
}

/** 现有 service 用的 `AdminActor` 形状（`RequestMeta` + actorId） */
export function adminActor(ctx: CapabilityContext): {
  actorId: number
  ip: string | null
  userAgent: string | null
} {
  return { actorId: actorOf(ctx).id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent }
}

/** 影响面里用来显示「是谁」的标签（顺带确认用户存在：不存在就让能力自己抛 NOT_FOUND） */
export async function userLabel(ctx: CapabilityContext, userId: number): Promise<string> {
  const detail = await services(ctx).adminUsers.getUser(userId)
  return `@${detail.user.username}（${detail.user.displayName}）`
}

const userTarget = z.object({
  userId: z.number().int().positive().describe('用户 id（先用 users.list 找到）'),
})

/**
 * 座舱自己的实例（系统账号 hub-ops）不能被任何 `instances.*` 写能力当成目标：
 * 启停它会让管理台自己的对话断掉，只能从顶栏「重启座舱」走（docs/24 §7）。
 * 在**参数校验阶段**就拒绝，方案都建不出来。
 */
export function assertNotOpsInstance(ctx: CapabilityContext, userId: number): void {
  if (cockpitRepo.isSystemUser(ctx.deps.db, userId)) {
    throw new HubError('VALIDATION_FAILED', '座舱实例只能在顶栏重启（不能通过能力启停）')
  }
}

// ── R1 低风险可逆 ───────────────────────────────────────────────────────────

const invitesCreate = defineCapability({
  id: 'invites.create',
  area: 'invites',
  title: '生成邀请码',
  description:
    '生成一批注册邀请码（数量、每码可用次数、有效期、备注、角色标签）。低风险可逆：默认自动执行，' +
    '结果里的码可以直接发给对方。问「给我来个邀请码」用它。要停用已生成的码用经典页面的邀请列表。',
  risk: 'R1',
  classicPath: '/admin/invites',
  input: CreateInvitesRequestSchema,
  async preview(ctx, input) {
    return {
      summary: `生成 ${String(input.count)} 个邀请码（每个最多 ${String(input.maxUses)} 次有效）${
        input.expiresAt ? `，到期时间 ${input.expiresAt}` : '，永久有效'
      }`,
    }
  },
  async run(ctx, input) {
    return await services(ctx).system.createInvites(input, adminActor(ctx))
  },
})

const instancesStart = defineCapability({
  id: 'instances.start',
  area: 'instances',
  title: '启动实例',
  description:
    '启动（或确保运行）某个用户的 DSH 实例：容器不在就建、停了就起，最多等 90 秒就绪。' +
    '低风险可逆，默认自动执行。问「把 alice 的 DSH 拉起来」用它。要重启已经在跑的实例用 ' +
    'instances.restart；要先看状态用 instances.get。',
  risk: 'R1',
  classicPath: '/admin/instances',
  input: userTarget,
  async preview(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    const summary = await services(ctx).instances.getSummary(args.userId)
    return {
      summary: `启动 ${await userLabel(ctx, args.userId)} 的实例（当前状态：${summary.status}）`,
      affected: [{ kind: 'instance', id: args.userId, label: `用户 ${String(args.userId)} 的实例` }],
    }
  },
  async run(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    return await services(ctx).instances.ensureRunning(args.userId)
  },
})

// ── R2 有影响 ───────────────────────────────────────────────────────────────

const instancesStop = defineCapability({
  id: 'instances.stop',
  area: 'instances',
  title: '停止实例',
  description:
    '停止某个用户的 DSH 实例（容器保留，数据不丢，下次启动很快）。有影响：出方案卡等管理员确认。' +
    '「先把他那个停了省内存」用它。要重启用 instances.restart；删用户的数据用 users.delete。',
  risk: 'R2',
  classicPath: '/admin/instances',
  input: userTarget,
  async preview(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    const summary = await services(ctx).instances.getSummary(args.userId)
    return {
      summary:
        summary.status === 'running'
          ? `停止 ${await userLabel(ctx, args.userId)} 的实例（运行中，停止后 DSH 立即不可访问）`
          : `${await userLabel(ctx, args.userId)} 的实例当前是 ${summary.status}，停止不会改变什么`,
      affected: [{ kind: 'instance', id: args.userId, label: `用户 ${String(args.userId)} 的实例` }],
      ...(summary.status === 'running' ? {} : { warnings: ['实例当前没在运行，这一步可能什么也不做'] }),
    }
  },
  async run(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    return await services(ctx).instances.stop(args.userId)
  },
})

const instancesRestart = defineCapability({
  id: 'instances.restart',
  area: 'instances',
  title: '重启实例',
  description:
    '重启某个用户的实例：规格哈希变了就重建容器，否则 docker restart（数据卷不动）。' +
    '排障常用（改配置后不生效、进程卡住）。有影响：出方案卡。要让没在跑的实例起来用 instances.start。',
  risk: 'R2',
  classicPath: '/admin/instances',
  input: userTarget,
  async preview(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    const summary = await services(ctx).instances.getSummary(args.userId)
    return {
      summary: `重启 ${await userLabel(ctx, args.userId)} 的实例（当前 ${summary.status}；重启期间 DSH 短暂不可用${
        summary.needsRecreate ? '，且会按新规格重建容器' : ''
      }）`,
      affected: [{ kind: 'instance', id: args.userId, label: `用户 ${String(args.userId)} 的实例` }],
      ...(summary.needsRecreate
        ? { warnings: ['规格已变，这次会重建容器（数据卷保留，已装插件按期望状态重装）'] }
        : {}),
    }
  },
  async run(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    return await services(ctx).instances.restart(args.userId)
  },
})

const pluginRollout = defineCapability({
  id: 'rollouts.plugin',
  area: 'rollouts',
  title: '下发插件',
  description:
    '把插件库里某个版本下发给用户（targets.all 或 userIds/按条件过滤）：装、升级、卸载、重应用配置。' +
    '先用 plugins.list 找到 pluginId 与 versionId（不确定版本就省略 versionId = 最新版）；' +
    '影响面由 Hub 计算（会列出每个用户「当前 → 之后」与是否重启）。要下发 DSH 版本用 rollouts.runtime，' +
    '模型预设用 rollouts.model。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/rollouts',
  input: z.object({
    pluginId: z.number().int().positive(),
    versionId: z.number().int().positive().optional().describe('省略 = 该插件最新版'),
    action: z.enum(['install', 'upgrade', 'uninstall', 'apply-config']).default('install'),
    targets: TargetsSchema,
    strategy: StrategySchema.partial().optional().describe('并发/金丝雀/失败比例；省略用默认'),
  }),
  async preview(ctx, args) {
    const request = { kind: 'plugin' as const, ...args, strategy: args.strategy ?? {} }
    return await rolloutPreview(ctx, request)
  },
  async run(ctx, args) {
    const request = RolloutRequestSchema.parse({ kind: 'plugin', ...args, strategy: args.strategy ?? {} })
    return await services(ctx).rollouts.create(request, actorOf(ctx).id, ctx.meta)
  },
})

/** 写类下发能力的统一影响面：复用 rollouts/preview（I3：与经典页面同一份计算） */
export async function rolloutPreview(ctx: CapabilityContext, request: unknown): Promise<ProposalPreview> {
  const parsed = RolloutRequestSchema.parse(request)
  const s = services(ctx)
  const preview = await s.rollouts.preview(parsed, ctx.actor?.id ?? null)
  const restartCount = preview.targets.filter((item) => item.willRestart).length
  const changed = preview.targets.filter((item) => item.current !== item.after).length
  return {
    summary: `影响 ${String(preview.total)} 个用户（其中 ${String(changed)} 个会变化、${String(
      restartCount,
    )} 个正在运行会重启）`,
    affected: preview.targets.slice(0, 2000).map((item) => ({
      kind: 'user' as const,
      id: item.userId,
      label: `${item.username}：${item.current} → ${item.after}`,
    })),
    ...(preview.total === 0 ? { warnings: ['没有匹配的目标用户，这一步不会做任何事'] } : {}),
    detail: preview,
  }
}

// ── R3 敏感 ─────────────────────────────────────────────────────────────────

const usersDelete = defineCapability({
  id: 'users.delete',
  area: 'users',
  title: '删除用户',
  description:
    '删除一个用户：默认软删除（数据进回收站保留 7 天、用户名立即释放、可恢复），purge=true 则立即彻底删除。' +
    '敏感操作：方案卡要求管理员再次输入密码（reauth）。删之前务必先用 users.get 确认是谁；' +
    '只想断他访问用经典页面的停用账号。',
  risk: 'R3',
  classicPath: '/admin/users',
  input: z.object({
    userId: z.number().int().positive(),
    purge: z.boolean().default(false).describe('true = 立即彻底删除（不进回收站，不可恢复）'),
  }),
  async preview(ctx, args) {
    const summary = await services(ctx).instances.getSummary(args.userId)
    return {
      summary: `${args.purge ? '立即彻底删除' : '删除（进回收站，7 天内可恢复）'} ${await userLabel(
        ctx,
        args.userId,
      )}，其实例当前 ${summary.status}`,
      affected: [
        { kind: 'user', id: args.userId, label: `用户 ${String(args.userId)}` },
        { kind: 'instance', id: args.userId, label: '其 DSH 实例与数据目录' },
      ],
      warnings: args.purge
        ? ['purge=true：数据不进回收站，无法恢复', '该用户的所有会话与设备令牌立即失效']
        : ['用户名立即释放，7 天内可从回收站恢复', '该用户的所有会话与设备令牌立即失效'],
    }
  },
  async run(ctx, args) {
    await services(ctx).adminUsers.deleteUser(args.userId, { purge: args.purge }, adminActor(ctx))
    return { userId: args.userId, deleted: true, purge: args.purge }
  },
})

const usersPasswordReset = defineCapability({
  id: 'users.password.reset',
  area: 'users',
  title: '重置用户密码',
  description:
    '给用户生成一个一次性临时密码，并强制其下次登录后改密；该用户所有会话立即失效。敏感操作：需要 reauth。' +
    '临时密码**只在经典页面显示一次**，座舱对话里看不到（输出会被脱敏）——告诉管理员去 /admin/users 抄。' +
    '用户自己改密码不需要这个能力。',
  risk: 'R3',
  classicPath: '/admin/users',
  input: userTarget,
  async preview(ctx, args) {
    return {
      summary: `重置 ${await userLabel(ctx, args.userId)} 的密码并踢掉其全部会话`,
      affected: [{ kind: 'user', id: args.userId, label: `用户 ${String(args.userId)}` }],
      warnings: ['新密码只在经典页面显示一次（对话与画布都会脱敏）', '该用户的现有会话立即失效'],
    }
  },
  async run(ctx, args) {
    const result = await services(ctx).adminUsers.resetPassword(args.userId, adminActor(ctx))
    // 输出会过 redact()：临时密码字段名命中 password → 替换成 [已隐藏]
    return result
  },
})

/** 全部写能力（R1 / R2 / R3） */
export const WRITE_CAPABILITIES = [
  invitesCreate,
  instancesStart,
  instancesStop,
  instancesRestart,
  pluginRollout,
  usersDelete,
  usersPasswordReset,
] as const
