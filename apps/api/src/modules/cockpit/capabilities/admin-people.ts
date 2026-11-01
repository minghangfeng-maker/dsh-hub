import { z } from 'zod'
import {
  ComputeLeaseQuerySchema,
  CreateUserRequestSchema,
  DeletedUserListQuerySchema,
  UpdateInviteRequestSchema,
  UpdateUserRequestSchema,
  type ProposalPreview,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import { defineCapability } from './define.js'
import { assertNotSystemUser } from './read-extra.js'
import type { CapabilityContext } from './types.js'
import { adminActor, userLabel } from './write.js'

/**
 * WP56f：把「人与任务」两页剩下的操作补成能力（docs/24 §4 之外，编排者验收要求覆盖率 ≥90%）。
 *
 * 约定同前几个文件：参数先过 zod、写类必须有 `preview`（Hub 算影响面，含「旧值 → 新值」）、
 * 直接调 service（不走 HTTP 回环）、`ctx.actor` 就是批准的管理员。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

/** 只改给出的字段，逐项列出「旧值 → 新值」（preview 的统一形态） */
function diffLines(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { field: string; from: unknown; to: unknown }[] {
  const changed: { field: string; from: unknown; to: unknown }[] = []
  for (const [field, to] of Object.entries(after)) {
    const from = before[field]
    if (JSON.stringify(from) === JSON.stringify(to)) continue
    changed.push({ field, from, to })
  }
  return changed
}

function renderDiff(changed: { field: string; from: unknown; to: unknown }[]): string {
  const show = (value: unknown): string => {
    if (value === null || value === undefined) return '（空）'
    if (typeof value === 'string') return value.length === 0 ? '（空）' : value
    return JSON.stringify(value)
  }
  return changed.map((item) => `${item.field}: ${show(item.from)} → ${show(item.to)}`).join('；')
}

// ── 用户（新建 / 编辑 / 审批 / 踢下线 / 回收站） ────────────────────────────

const usersCreate = defineCapability({
  id: 'users.create',
  area: 'users',
  title: '新建用户',
  description:
    '直接建一个账号（不走邀请码）：用户名 + 可选昵称/角色/角色标签。不给密码就由 Hub 生成一次性临时密码，' +
    '**临时密码只在经典页面「用户」里显示一次，座舱输出会被脱敏**。问「帮我建个测试账号」用它；' +
    '要让对方自己注册用 invites.create。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/users',
  input: CreateUserRequestSchema,
  async preview(ctx, input) {
    return {
      summary: `新建用户 ${input.username}（${
        input.role === 'admin'
          ? '管理员'
          : input.roleLabel && input.roleLabel !== '普通用户'
            ? input.roleLabel
            : '普通用户'
      }${input.displayName ? `，昵称 ${input.displayName}` : ''}；${
        input.password ? '使用你给的密码' : '由 Hub 生成临时密码'
      }）`,
      affected: [],
      warnings: [
        '临时密码只在经典页面的用户详情里显示一次（对话与画布都会脱敏）',
        '新用户默认状态是 active（不需要审批）',
      ],
    }
  },
  async run(ctx, input) {
    const result = await services(ctx).adminUsers.createUser(input, adminActor(ctx))
    // `tempPassword` 键名命中 I4 → 输出里是 [已隐藏]，管理员要去经典页面抄
    return result
  },
})

const usersUpdate = defineCapability({
  id: 'users.update',
  area: 'users',
  title: '修改用户资料',
  description:
    '改一个用户的基本资料：昵称、角色（user/admin）、角色标签、状态（active/pending/disabled）、钉住的 DSH 版本、' +
    '模型预设、模型策略（managed/free）。只改给出的字段，preview 里逐项给「旧值 → 新值」。' +
    '改配额用 users.quota.set，改钱包用 users.wallet.grant。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/users',
  input: z.object({
    userId: z.number().int().positive().describe('用户 id'),
    patch: UpdateUserRequestSchema.describe('只给要改的字段；quota 不在这里（用 users.quota.set）'),
  }),
  async preview(ctx, args) {
    assertNotSystemUser(ctx, args.userId)
    const detail = await services(ctx).adminUsers.getUser(args.userId)
    const before = detail.user as unknown as Record<string, unknown>
    const changed = diffLines(before, args.patch as Record<string, unknown>)
    return {
      summary: `改 ${await userLabel(ctx, args.userId)}：${changed.length === 0 ? '没有字段变化' : renderDiff(changed)}`,
      affected: [{ kind: 'user', id: args.userId, label: `用户 ${String(args.userId)}` }],
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化，这一步不会改变任何东西'] : []),
        ...(args.patch.status === 'disabled' ? ['停用会立即让该用户的会话与实例失效'] : []),
        ...(args.patch.role === 'admin' ? ['改成管理员会获得管理端全部权限'] : []),
      ],
    }
  },
  async run(ctx, args) {
    assertNotSystemUser(ctx, args.userId)
    return await services(ctx).adminUsers.updateUser(args.userId, args.patch, adminActor(ctx))
  },
})

const usersApprove = defineCapability({
  id: 'users.approve',
  area: 'users',
  title: '通过注册审批',
  description:
    '把「待审核」的用户改成可用（status=pending → active），前提是注册需要审批。低风险可逆，默认自动执行。' +
    '问「把等着的那个人放进来」用它。停用/恢复状态用 users.update（status），别用这个。',
  risk: 'R1',
  classicPath: '/admin/users',
  input: z.object({
    userId: z.number().int().positive().describe('用户 id（users.list 里 status=pending 的那行）'),
  }),
  async preview(ctx, args) {
    assertNotSystemUser(ctx, args.userId)
    const detail = await services(ctx).adminUsers.getUser(args.userId)
    return {
      summary: `通过 ${await userLabel(ctx, args.userId)} 的注册审批（当前状态 ${detail.user.status}）`,
      affected: [{ kind: 'user', id: args.userId, label: `用户 ${String(args.userId)}` }],
    }
  },
  async run(ctx, args) {
    assertNotSystemUser(ctx, args.userId)
    return await services(ctx).adminUsers.approve(args.userId, adminActor(ctx))
  },
})

const usersRevokeSessions = defineCapability({
  id: 'users.revoke-sessions',
  area: 'users',
  title: '踢下线（吊销会话）',
  description:
    '让某个用户的浏览器/桌面端会话立即失效（他要重新登录），账号本身不受影响、密码不变。低风险可逆。' +
    '问「把他踢下线」用它。要让他改密码用 users.password.reset（那个会强制改密并踢下线）。',
  risk: 'R1',
  classicPath: '/admin/users',
  input: z.object({ userId: z.number().int().positive().describe('用户 id') }),
  async preview(ctx, args) {
    assertNotSystemUser(ctx, args.userId)
    return {
      summary: `吊销 ${await userLabel(ctx, args.userId)} 的全部登录会话（他需要重新登录）`,
      affected: [{ kind: 'user', id: args.userId, label: `用户 ${String(args.userId)}` }],
    }
  },
  async run(ctx, args) {
    assertNotSystemUser(ctx, args.userId)
    return await services(ctx).adminUsers.revokeSessions(args.userId, adminActor(ctx))
  },
})

const usersDeletedList = defineCapability({
  id: 'users.deleted.list',
  area: 'users',
  title: '回收站列表',
  description:
    '列出已删除（进回收站）的用户：删除时的用户名、删除时间、还剩几天可恢复、数据是否还在 trash/。' +
    '问「回收站里有什么」「那个删掉的账号还能救回来吗」用它；要恢复用 users.restore（R3，需密码）。' +
    '返回 {rows,total}。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/users',
  input: DeletedUserListQuerySchema,
  async run(ctx, query) {
    const page = await services(ctx).adminUsers.listDeletedUsers({
      ...query,
      pageSize: Math.max(1, Math.min(100, query.pageSize)),
    })
    return { total: page.total, page: page.page, pageSize: page.pageSize, rows: page.items }
  },
})

// ── 邀请码（改 / 删） ───────────────────────────────────────────────────────

const invitesUpdate = defineCapability({
  id: 'invites.update',
  area: 'invites',
  title: '修改邀请码',
  description:
    '改一个邀请码：停用/启用（disabled）、备注、可用次数上限、到期时间、注册后得到的角色标签（只影响之后注册的人）。' +
    '先用 invites.list 找到 inviteId 与当前值，preview 会给「旧值 → 新值」。有影响：出方案卡。' +
    '要新生成用 invites.create。',
  risk: 'R2',
  classicPath: '/admin/invites',
  input: z.object({
    inviteId: z.number().int().positive().describe('邀请码 id（invites.list 的 id）'),
    patch: UpdateInviteRequestSchema,
  }),
  async preview(ctx, args) {
    const current = await services(ctx).system.getInvite(args.inviteId)
    if (!current) throw new HubError('NOT_FOUND', `邀请码 ${String(args.inviteId)} 不存在`)
    const changed = diffLines(current as unknown as Record<string, unknown>, args.patch)
    return {
      summary: `改邀请码 ${current.code}：${changed.length === 0 ? '没有字段变化' : renderDiff(changed)}`,
      affected: [],
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        ...(args.patch.disabled === true ? ['停用后这个码不能再用于注册（已注册的人不受影响）'] : []),
      ],
    }
  },
  async run(ctx, args) {
    return await services(ctx).system.updateInvite(args.inviteId, args.patch, adminActor(ctx))
  },
})

const invitesDelete = defineCapability({
  id: 'invites.delete',
  area: 'invites',
  title: '删除邀请码',
  description:
    '删掉一个邀请码（不可恢复；已用它注册的用户不受影响）。想「暂停使用」而不是删除，用 invites.update 的 disabled。' +
    '先用 invites.list 确认是哪一条。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/invites',
  input: z.object({ inviteId: z.number().int().positive().describe('邀请码 id') }),
  async preview(ctx, args) {
    const current = await services(ctx).system.getInvite(args.inviteId)
    if (!current) throw new HubError('NOT_FOUND', `邀请码 ${String(args.inviteId)} 不存在`)
    return {
      summary: `删除邀请码 ${current.code}（已用 ${String(current.usedCount)} 次${current.note ? `，备注 ${current.note}` : ''}）`,
      affected: [],
      warnings: ['删除不可恢复；只想停用请改 disabled=true'],
    }
  },
  async run(ctx, args) {
    await services(ctx).system.deleteInvite(args.inviteId, adminActor(ctx))
    return { inviteId: args.inviteId, deleted: true }
  },
})

// ── 任务：暂停 / 继续 / 取消 / 进度 ─────────────────────────────────────────

const jobIdArgs = z.object({ jobId: z.number().int().positive().describe('任务 id（jobs.list 的 id）') })

/** 三个「任务控制」共用一次预览：旧状态 → 新状态 + 影响面 */
async function jobControlPreview(
  ctx: CapabilityContext,
  jobId: number,
  next: 'paused' | 'running' | 'canceled',
): Promise<ProposalPreview> {
  const detail = await services(ctx).jobs.get(jobId)
  const running = detail.tasks.filter((task) => task.status === 'running').length
  const pending = detail.tasks.filter((task) => task.status === 'pending').length
  return {
    summary:
      `把任务 #${String(jobId)}「${detail.job.title}」从 ${detail.job.status} 改成 ${next}` +
      `（共 ${String(detail.tasks.length)} 步：进行中 ${String(running)}、待执行 ${String(pending)}）`,
    affected: [{ kind: 'job', id: jobId, label: `任务 #${String(jobId)}` }],
    warnings:
      next === 'canceled'
        ? ['取消后已成功的步骤不回滚，剩余步骤不再执行（不可恢复）']
        : next === 'paused'
          ? ['暂停只阻止新步骤启动；正在跑的步骤会自己收尾']
          : [],
  }
}

const jobsPause = defineCapability({
  id: 'jobs.pause',
  area: 'jobs',
  title: '暂停任务',
  description:
    '暂停一个正在跑/排队的任务：不再启动新步骤（正在执行的步骤会自己收尾）。之后可以 jobs.resume 继续。' +
    '问「先停下那批下发」用它。要彻底停掉用 jobs.cancel（不可恢复）。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/jobs',
  input: jobIdArgs,
  async preview(ctx, args) {
    return await jobControlPreview(ctx, args.jobId, 'paused')
  },
  async run(ctx, args) {
    return await services(ctx).jobs.pause(args.jobId, ctx.meta, adminActor(ctx).actorId)
  },
})

const jobsResume = defineCapability({
  id: 'jobs.resume',
  area: 'jobs',
  title: '继续任务',
  description:
    '把暂停的任务恢复执行（从剩余步骤继续，已成功的步骤不重跑）。问「继续跑那批」用它；' +
    '失败步骤要重排用 jobs.retry，彻底停止用 jobs.cancel。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/jobs',
  input: jobIdArgs,
  async preview(ctx, args) {
    return await jobControlPreview(ctx, args.jobId, 'running')
  },
  async run(ctx, args) {
    return await services(ctx).jobs.resume(args.jobId, ctx.meta, adminActor(ctx).actorId)
  },
})

const jobsCancel = defineCapability({
  id: 'jobs.cancel',
  area: 'jobs',
  title: '取消任务',
  description:
    '取消一个任务：剩余步骤不再执行，已成功的步骤不回滚（不可恢复）。问「这批别发了」用它；' +
    '只想临时停下来用 jobs.pause。改完状态经 SSE 推到任务卡。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/jobs',
  input: jobIdArgs,
  async preview(ctx, args) {
    return await jobControlPreview(ctx, args.jobId, 'canceled')
  },
  async run(ctx, args) {
    return await services(ctx).jobs.cancel(args.jobId, ctx.meta, adminActor(ctx).actorId)
  },
})

const jobsProgress = defineCapability({
  id: 'jobs.progress',
  area: 'jobs',
  title: '任务进度快照',
  description:
    '拿一个任务的进度快照：总数/已完成/失败/进行中，以及每一步的状态与尝试次数（不含日志）。' +
    '问「那批下发到哪了」「还有几步」用它；要看失败原因用 jobs.get + jobs.logs。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/jobs',
  input: jobIdArgs,
  async run(ctx, args) {
    const detail = await services(ctx).jobs.get(args.jobId)
    const count = (status: string): number => detail.tasks.filter((task) => task.status === status).length
    return {
      jobId: args.jobId,
      title: detail.job.title,
      status: detail.job.status,
      total: detail.tasks.length,
      done: count('succeeded'),
      failed: count('failed'),
      running: count('running'),
      pending: count('pending'),
      percent:
        detail.tasks.length === 0
          ? 0
          : Math.round(
              ((count('succeeded') + count('failed') + count('skipped')) / detail.tasks.length) * 100,
            ),
      rows: detail.tasks.map((task) => ({
        taskId: task.id,
        seq: task.seq,
        username: task.username,
        status: task.status,
        attempt: task.attempt,
        error: task.error,
      })),
    }
  },
})

// ── 算力租约（实例页的「租约」列） ──────────────────────────────────────────

const computeLeases = defineCapability({
  id: 'compute.leases',
  area: 'compute',
  title: '算力租约',
  description:
    '列算力租赁（按小时计费的实例规格租约）：用户、规格、开始时间、已扣费、剩余额度、状态。' +
    '问「现在谁在按小时租着」「租约还剩多久」用它。算力计费开关与价格在经典页面（座舱只读）。' +
    '返回 {rows,total}。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/instances',
  input: ComputeLeaseQuerySchema,
  async run(ctx, query) {
    const page = await services(ctx).compute.listAdminLeases(query)
    return { total: page.total, page: page.page, pageSize: page.pageSize, rows: page.items }
  },
})

/** 供别的文件复用（preview 的「旧值 → 新值」渲染） */
export { renderDiff, diffLines }

export const PEOPLE_CAPABILITIES = [
  usersCreate,
  usersUpdate,
  usersApprove,
  usersRevokeSessions,
  usersDeletedList,
  invitesUpdate,
  invitesDelete,
  jobsPause,
  jobsResume,
  jobsCancel,
  jobsProgress,
  computeLeases,
] as const
