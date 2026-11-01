import { z } from 'zod'
import {
  DeliverAgentModeRequestSchema,
  DesktopAppDeliverRequestSchema,
  DesktopConfigDeliverRequestSchema,
  DesktopPluginDeliverRequestSchema,
  DesktopPluginWithdrawRequestSchema,
  DesktopReleaseRollbackRequestSchema,
  DesktopUninstallDeliverRequestSchema,
  RelayAgentModeSchema,
  type ProposalPreview,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import { defineCapability } from './define.js'
import type { CapabilityContext } from './types.js'
import { actorOf, adminActor, assertNotOpsInstance, userLabel } from './write.js'

/**
 * WP56f 第四批：桌面端下发/发布、实例重建、对话模式下发、设备详情。
 *
 * 这几项都是「会改别人机器上的东西」的写操作：全部 R2/R3，`preview` 里必须把
 * 影响面（多少台设备 / 多少用户 / 要不要重启）写清楚。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

// ── 桌面端下发（配置 / 插件 / 卸载 / 版本策略） ─────────────────────────────

/** 桌面端目标的展示文案（`scope` 判别：all / role / user） */
function desktopTargetLabel(input: {
  target?: { scope: 'all' } | { scope: 'role'; role: string } | { scope: 'user'; userId: number }
}): string {
  const target = input.target
  if (target === undefined) return '渠道级（所有设备）'
  if (target.scope === 'role') return `角色 ${target.role} 的设备`
  if (target.scope === 'user') return `用户 ${String(target.userId)} 的设备`
  return '全部设备'
}

const desktopConfigSet = defineCapability({
  id: 'desktop.config.set',
  area: 'desktop',
  title: '下发桌面端配置片段',
  description:
    '整体替换某个目标（全部设备 / 某角色 / 某用户）上的桌面配置片段：给一组 `{id, config}`，桌面端下次拉清单时应用。' +
    '配置片段只允许白名单里的键（写错保留 id 会让桌面 Host 起不来）—— 请照经典页面现有片段的形状写。' +
    '有影响：出方案卡（会推进 checklist revision）。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: DesktopConfigDeliverRequestSchema,
  async preview(ctx, input) {
    const audience = services(ctx).desktopDelivery.audience()
    return {
      summary: `替换 ${desktopTargetLabel(input)} 的桌面配置片段：${String(input.fragments.length)} 个片段（当前活跃设备 ${String(
        audience.devices,
      )} 台）`,
      warnings: [
        '整体替换：没写进去的旧片段会被移除',
        '桌面端下一次拉清单（默认 60 秒）才生效；改错保留 id 会让桌面 Host 起不来',
      ],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return services(ctx).desktopDelivery.deliverConfig(input, actor.actorId, ctx.meta)
  },
})

const desktopPluginsSet = defineCapability({
  id: 'desktop.plugins.set',
  area: 'desktop',
  title: '给桌面端下发插件',
  description:
    '把某个桌面插件版本下发给目标设备（全部 / 某角色 / 某用户）：装进清单、可选「装了但禁用」。' +
    '插件必须有桌面整包（没有的话经典页面上传不了，这里也会失败）。先 plugins.list platform=desktop 找 pluginId/versionId。' +
    '有影响：出方案卡。撤掉用 desktop.plugins.withdraw。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: DesktopPluginDeliverRequestSchema,
  async preview(ctx, input) {
    const rows = await services(ctx).plugins.listCatalog('desktop')
    const plugin = rows.find((row) => row.id === input.pluginId)
    if (!plugin)
      throw new HubError('NOT_FOUND', '桌面插件库里没有这个插件（先加入桌面平台：plugins.platforms.add）')
    const version = plugin.versions.find((item) => item.id === input.versionId)
    if (!version)
      throw new HubError(
        'NOT_FOUND',
        `插件 ${String(input.pluginId)} 没有桌面版本 ${String(input.versionId)}`,
      )
    const audience = services(ctx).desktopDelivery.audience()
    return {
      summary: `给 ${desktopTargetLabel(input)} 下发桌面插件 ${plugin.packageName}@${version.version}${
        input.enabled === false ? '（装了但禁用）' : ''
      }`,
      affected: [{ kind: 'plugin', id: plugin.id, label: `${plugin.packageName}@${version.version}` }],
      warnings: [
        plugin.policy === 'hidden' ? '这个插件的策略是 hidden：桌面清单不会下发它' : '',
        `当前活跃设备 ${String(audience.devices)} 台`,
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return services(ctx).desktopDelivery.deliverPlugin(input, actor.actorId, ctx.meta)
  },
})

const desktopPluginsWithdraw = defineCapability({
  id: 'desktop.plugins.withdraw',
  area: 'desktop',
  title: '撤掉桌面端插件',
  description:
    '把某插件从某个桌面目标上撤掉（不再出现在清单里；桌面端下次拉清单时不再要求它）。' +
    '问「桌面端别装这个了」用它。要彻底卸载用户机器上的包用 desktop.uninstall（R3）。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: DesktopPluginWithdrawRequestSchema,
  async preview(ctx, input) {
    const rows = await services(ctx).plugins.listCatalog('desktop')
    const plugin = rows.find((row) => row.id === input.pluginId)
    return {
      summary: `从 ${desktopTargetLabel(input)} 撤掉桌面插件${
        plugin ? ` ${plugin.packageName}` : ` #${String(input.pluginId)}`
      }`,
      warnings: ['已装上的包不会自动删除（要删用 desktop.uninstall）'],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return services(ctx).desktopDelivery.withdrawPlugin(input, actor.actorId, ctx.meta)
  },
})

const desktopAppSet = defineCapability({
  id: 'desktop.app.set',
  area: 'desktop',
  title: '设置桌面端版本策略',
  description:
    '按渠道（nightly/latest）设置桌面端版本策略：目标版本 targetVersion、最低版本 minVersion、是否硬地板 minVersionHard、' +
    '灰度百分比 rolloutPercent。省略 target 是渠道级；给了 role/user 就是覆盖项。' +
    '**有影响**：硬地板会让低版本客户端打不开。出方案卡。上传安装包只能在经典页面做。',
  risk: 'R2',
  classicPath: '/admin/settings',
  input: DesktopAppDeliverRequestSchema,
  async preview(ctx, input) {
    const floor = services(ctx).desktopDelivery.getFloor().floor
    return {
      summary: `${input.channel} 渠道版本策略：${[
        input.targetVersion === undefined ? '' : `目标 ${input.targetVersion ?? '清空'}`,
        input.minVersion === undefined
          ? ''
          : `最低 ${input.minVersion ?? '清空'}${input.minVersionHard === true ? '（硬）' : ''}`,
        input.rolloutPercent === undefined ? '' : `灰度 ${String(input.rolloutPercent)}%`,
      ]
        .filter((line) => line.length > 0)
        .join('、')}${input.target === undefined ? '（渠道级）' : `（覆盖 ${desktopTargetLabel(input)}）`}`,
      warnings: [
        ...(input.minVersionHard === true ? ['硬地板：低于它的客户端会被强制挡住（必须升级才能用）'] : []),
        `当前强更地板：${floor.minVersion ?? '未设置'}`,
      ],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return services(ctx).desktopDelivery.deliverApp(input, actor.actorId, ctx.meta)
  },
})

const desktopUninstall = defineCapability({
  id: 'desktop.uninstall',
  area: 'desktop',
  title: '让桌面端卸载插件',
  description:
    '给某个桌面目标加/去「明确要求卸载」的包名（之前由 Hub 下发过的）。桌面端下次拉清单会把它们卸掉。' +
    '**敏感**：会真的删用户机器上的包，方案卡要密码。只想不再下发用 desktop.plugins.withdraw（R2）。',
  risk: 'R3',
  classicPath: '/admin/plugins',
  input: DesktopUninstallDeliverRequestSchema,
  async preview(ctx, input) {
    return {
      summary: `给 ${desktopTargetLabel(input)} ${
        (input.add?.length ?? 0) > 0 ? `加 ${String(input.add?.length ?? 0)} 个卸载包名` : ''
      }${(input.add?.length ?? 0) > 0 && (input.remove?.length ?? 0) > 0 ? '、' : ''}${
        (input.remove?.length ?? 0) > 0 ? `去掉 ${String(input.remove?.length ?? 0)} 个卸载包名` : ''
      }`,
      warnings: [
        '桌面端会真的删掉这些包（用户机器上的数据/配置可能一起没）',
        '这一条需要管理员再输入一次密码',
      ],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return services(ctx).desktopDelivery.deliverUninstall(input, actor.actorId, ctx.meta)
  },
})

const desktopReleasesRollback = defineCapability({
  id: 'desktop.releases.rollback',
  area: 'desktop',
  title: '回滚桌面端发布',
  description:
    '把某个目标（win-x64 / mac-x64 / mac-arm64）× 渠道（nightly/latest）的发布回退到上一个版本（feed 里的 latest 换回旧安装包）。' +
    '问「刚发的桌面版有问题，回滚」用它。**有影响**：桌面端更新会退回旧版。出方案卡。' +
    '上传/发布安装包只能在经典页面做（二进制）。',
  risk: 'R2',
  classicPath: '/admin/settings',
  input: DesktopReleaseRollbackRequestSchema,
  async preview(ctx, input) {
    const releases = services(ctx).desktopDelivery.listReleases().items
    const same = releases.filter((item) => item.target === input.target && item.channel === input.channel)
    const published = same.filter((item) => item.status === 'published')
    const target = published.length > 1 ? published[1] : undefined
    return {
      summary: `回滚 ${input.target} / ${input.channel} 的桌面端发布${
        target === undefined ? '（没有更旧的已发布版本，会失败）' : `到 ${target.version}`
      }`,
      warnings: [
        target === undefined ? '没有可回滚的旧版本：这一步会被服务端拒绝' : '桌面端更新会自动退回这个旧版本',
      ],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return services(ctx).desktopDelivery.rollbackRelease(input, actor.actorId, ctx.meta)
  },
})

// ── 设备详情 ────────────────────────────────────────────────────────────────

const desktopDevicesGet = defineCapability({
  id: 'desktop.devices.get',
  area: 'desktop',
  title: '设备详情',
  description:
    '查一台设备（桌面端或手机）的详情：所属用户、平台与版本、在线状态、已装插件清单、最近与该设备相关的审计。' +
    '问「这台机器装了什么」「这台设备最近怎么了」用它。拉黑/吊销用 desktop.devices.revoke。' +
    'deviceId 来自 desktop.devices.list / mobile.devices.list。',
  risk: 'R0',
  classicPath: '/admin/instances',
  input: z.object({ deviceId: z.string().min(1).max(80).describe('设备标识（`dv_…`）') }),
  async run(ctx, args) {
    const detail = await services(ctx).desktop.detail(args.deviceId)
    return {
      device: detail.device,
      user: detail.user,
      pluginCount: detail.pluginCount,
      rows: detail.plugins.map((plugin) => ({
        packageName: plugin.name,
        version: plugin.version,
        state: plugin.state,
        updatedAt: plugin.updatedAt,
      })),
      recentAudit: detail.audit,
    }
  },
})

// ── 实例重建 ────────────────────────────────────────────────────────────────

const instancesRecreate = defineCapability({
  id: 'instances.recreate',
  area: 'instances',
  title: '重建实例容器',
  description:
    '删掉容器再按当前规格重建（数据卷保留；已装插件按期望状态重装）。排障用：容器层坏了、配置漂了、' +
    '改了规格想立刻生效。有影响：DSH 会中断 10–60 秒，比 instances.restart 更彻底（重启只重启进程）。出方案卡。',
  risk: 'R2',
  classicPath: '/admin/instances',
  input: z.object({ userId: z.number().int().positive().describe('用户 id') }),
  async preview(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    const summary = await services(ctx).instances.getSummary(args.userId)
    return {
      summary: `重建 ${await userLabel(ctx, args.userId)} 的容器（当前 ${summary.status}；数据卷保留，DSH 中断 10–60 秒）`,
      affected: [{ kind: 'instance', id: args.userId, label: `用户 ${String(args.userId)} 的实例` }],
      warnings: [
        '重建会重新装一遍期望插件，装失败的话容器可能起不来（看任务/日志）',
        ...(summary.status === 'running' ? ['用户正在用的会话会断开'] : []),
      ],
    }
  },
  async run(ctx, args) {
    assertNotOpsInstance(ctx, args.userId)
    return await services(ctx).instances.recreate(args.userId, { reason: 'admin' })
  },
})

// ── 对话模式下发（批量重建） ────────────────────────────────────────────────

const agentModesDeliver = defineCapability({
  id: 'agent-modes.deliver',
  area: 'agent-modes',
  title: '下发对话模式到容器',
  description:
    '把某个对话模式（claude-code / codex）的开通状态、密钥与模型写进目标用户的容器（需要时重建容器），' +
    '按需自动装插件。**敏感**：会批量重建容器，方案卡要密码。先用 agent-modes.get 看谁在用、' +
    '改范围用 agent-modes.assign。',
  risk: 'R3',
  classicPath: '/admin/claude-code',
  input: z.object({
    mode: RelayAgentModeSchema.describe('claude-code 或 codex'),
    restart: z
      .enum(['now', 'next-start'])
      .default('now')
      .describe('now = 立刻重建容器；next-start = 下次启动生效'),
    installPlugin: z.boolean().default(true).describe('targets 里没装插件的用户是否自动装最新版'),
  }),
  async preview(ctx, args) {
    const s = services(ctx)
    const state = await s.agentModes.state(args.mode)
    const targets = await s.agentModes.deliverTargetUsers(args.mode)
    const name = args.mode === 'claude-code' ? 'Claude Code' : 'Codex'
    return {
      summary: `把 ${name} 下发到 ${String(targets.length)} 个用户的容器（${
        args.restart === 'now' ? '现在就重建容器' : '下次启动生效'
      }${args.installPlugin ? '，缺插件的自动装' : ''}；当前待下发 ${String(state.pendingUsers)} 人）`,
      affected: targets.slice(0, 500).map((userId) => ({
        kind: 'user' as const,
        id: userId,
        label: `用户 ${String(userId)}`,
      })),
      warnings: [
        args.restart === 'now' ? '选 now 会重建这些容器：正在用的会话会断开' : '',
        args.installPlugin ? '' : '不装插件：没装过的用户拿到 env 也连不上',
        '这一条需要管理员再输入一次密码',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = actorOf(ctx)
    const input = DeliverAgentModeRequestSchema.parse({
      restart: args.restart,
      installPlugin: args.installPlugin,
    })
    return await services(ctx).agentModes.deliver(args.mode, input, actor.id, ctx.meta)
  },
})

/** 供 admin-relay.ts 之外的写能力复用的 preview 类型出口（避免各文件重复 import） */
export type { ProposalPreview }

export const OPS_CAPABILITIES = [
  desktopConfigSet,
  desktopPluginsSet,
  desktopPluginsWithdraw,
  desktopAppSet,
  desktopUninstall,
  desktopReleasesRollback,
  desktopDevicesGet,
  instancesRecreate,
  agentModesDeliver,
] as const
