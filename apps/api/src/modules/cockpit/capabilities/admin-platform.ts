import { z } from 'zod'
import {
  CapacitySettingsSchema,
  ContainerSettingsSchema,
  CreatePresetRequestSchema,
  CreateProviderRequestSchema,
  CreateRuntimeRequestSchema,
  CreatePluginRequestSchema,
  DesktopSettingsSchema,
  ExportsSettingsSchema,
  MobileSettingsSchema,
  PluginLookupQuerySchema,
  PluginPlatformSchema,
  QuotaSchema,
  RegistrationSettingsSchema,
  SecuritySettingsSchema,
  SiteSettingsSchema,
  UpdatePluginRequestSchema,
  UpdatePresetRequestSchema,
  UpdateProviderRequestSchema,
  type ProposalPreview,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import { defineCapability } from './define.js'
import type { CapabilityContext } from './types.js'
import { adminActor } from './write.js'

/**
 * WP56f 第二批：DSH 版本、插件库、模型配置、全局设置、桌面/安卓发布。
 *
 * 这批大多是「表单型 CRUD」，座舱的价值就是 DSH 按 JSON Schema 组参数、Hub 算影响面、
 * 管理员点一次执行 —— 逐字段的手工核对进 preview 的「旧值 → 新值」。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

/** 插件必须存在于该平台的库里：底层 repo 对不存在的插件抛普通 Error（会变 500），这里翻成 NOT_FOUND */
async function requirePlugin(
  ctx: CapabilityContext,
  pluginId: number,
  platform?: 'cloud' | 'desktop',
): Promise<{ id: number; packageName: string; displayName: string; policy: string }> {
  const rows = await services(ctx).plugins.listCatalog(platform)
  const row = rows.find((item) => item.id === pluginId)
  if (!row) {
    throw new HubError(
      'NOT_FOUND',
      `插件 ${String(pluginId)} 不在${platform === 'desktop' ? '桌面' : '云上'}插件库里（先用 plugins.list 查 pluginId）`,
    )
  }
  return row
}

/** 「旧值 → 新值」的一行（这批 preview 不引入 admin-people 的完整 diff） */
function changeLine(field: string, from: unknown, to: unknown): string {
  const show = (value: unknown): string =>
    value === null || value === undefined
      ? '（空）'
      : typeof value === 'string'
        ? value || '（空）'
        : JSON.stringify(value)
  return `${field}: ${show(from)} → ${show(to)}`
}

const PLUGIN_PLATFORM_ARGS = {
  platform: PluginPlatformSchema.optional().describe('cloud（云上实例，缺省）/ desktop'),
} as const

// ── DSH 版本 ────────────────────────────────────────────────────────────────

const runtimesAvailable = defineCapability({
  id: 'runtimes.available',
  area: 'runtimes',
  title: '查可用的 DSH 版本',
  description:
    '从 npmmirror 查 `@deepseek-ai/dsh` 现在有哪些版本可取（缓存 10 分钟）：全部版本、最新稳定版、下一个预发布版。' +
    '问「有没有新版本」或准备 runtimes.create 时用它。已经入库的版本用 runtimes.list（那个是本机镜像）。' +
    '要联网查询，一般 1–3 秒。',
  risk: 'R0',
  classicPath: '/admin/runtimes',
  input: z.object({}),
  async run(ctx) {
    const available = await services(ctx).runtimes.available()
    return {
      latest: available.latest,
      next: available.next,
      rows: available.versions.map((version) => ({ dshVersion: version })),
    }
  },
})

const runtimesCreate = defineCapability({
  id: 'runtimes.create',
  area: 'runtimes',
  title: '新建 DSH 版本',
  description:
    '新建一个 DSH 版本并开始构建镜像（后台任务 runtime.build，几分钟到十几分钟，占几百 MB 磁盘）。' +
    '版本号先用 runtimes.available 查。**只建版本，不下发**：要让用户用上新版本再出 rollouts.runtime。' +
    '有影响：出方案卡（构建失败会留下 failed 行）。',
  risk: 'R2',
  classicPath: '/admin/runtimes',
  input: CreateRuntimeRequestSchema,
  async preview(ctx, input) {
    const existing = await services(ctx).runtimes.list()
    return {
      summary: `新建 DSH 版本 ${input.dshVersion} 并开始构建镜像（当前库里有 ${String(existing.length)} 个版本）`,
      affected: [],
      warnings: [
        '构建在后台任务里跑，完成后才能在 runtimes.list 里看到 ready',
        '构建会占磁盘与几分钟 CPU；失败会留下 failed 行（可删除）',
      ],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return await services(ctx).runtimes.create(input, actor.actorId, ctx.meta)
  },
})

/** 单个版本的预览：先读该行，保证「旧值 → 新值」是真的 */
async function runtimePreview(
  ctx: CapabilityContext,
  runtimeId: number,
  what: string,
): Promise<ProposalPreview> {
  const row = await services(ctx).runtimes.get(runtimeId)
  return {
    summary: `${what} DSH 版本 ${row.dshVersion}（当前 ${row.status}${row.isDefault ? '，是默认版本' : ''}）`,
    affected: [],
    warnings:
      row.usersOnIt > 0 && what === '删除'
        ? [`还有 ${String(row.usersOnIt)} 个用户钉在这个版本上：删除前先把他们换成别的版本`]
        : [],
  }
}

const runtimeIdArgs = z.object({
  runtimeId: z.number().int().positive().describe('运行时 id（runtimes.list 的行）'),
})

const runtimesSetDefault = defineCapability({
  id: 'runtimes.set-default',
  area: 'runtimes',
  title: '设为默认 DSH 版本',
  description:
    '把某个 ready 的版本设为默认：之后没有钉住版本的实例都用它（**已运行的容器不重建**，下次启动生效）。' +
    '问「新用户默认用哪个版本」用它。要立刻升级某些用户用 rollouts.runtime。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/runtimes',
  input: runtimeIdArgs,
  async preview(ctx, args) {
    const row = await services(ctx).runtimes.get(args.runtimeId)
    if (row.status !== 'ready')
      throw new HubError('VALIDATION_FAILED', `只有 ready 的版本能设为默认（当前 ${row.status}）`)
    return {
      summary: `把 DSH ${row.dshVersion} 设为默认版本（影响所有没钉住版本的实例：下次启动生效）`,
      affected: [],
      warnings: row.isDefault ? ['它已经是默认版本，这一步不会改变什么'] : [],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).runtimes.setDefault(args.runtimeId, actor.actorId, ctx.meta)
  },
})

const runtimesRetire = defineCapability({
  id: 'runtimes.retire',
  area: 'runtimes',
  title: '下线 DSH 版本',
  description:
    '把一个版本标记为 retired（不再可选、不再默认；已钉住它的用户容器不受影响，但下次重建会失败除非换版本）。' +
    '问「这个旧版本别再用」用它。彻底删镜像用 runtimes.delete（R3）。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/runtimes',
  input: runtimeIdArgs,
  async preview(ctx, args) {
    return await runtimePreview(ctx, args.runtimeId, '下线')
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).runtimes.retire(args.runtimeId, actor.actorId, ctx.meta)
  },
})

const runtimesUpdate = defineCapability({
  id: 'runtimes.update',
  area: 'runtimes',
  title: '改版本备注',
  description:
    '只改一个 DSH 版本的备注文字（说明这个版本为什么留着/有什么坑）。不碰镜像、不影响任何实例。' +
    '问「给这个版本写个备注」用它。有影响：出方案卡（其实只是改一行文字）。',
  risk: 'R2',
  classicPath: '/admin/runtimes',
  input: z.object({
    runtimeId: z.number().int().positive(),
    notes: z.string().max(500).describe('新备注（最多 500 字）'),
  }),
  async preview(ctx, args) {
    const row = await services(ctx).runtimes.get(args.runtimeId)
    const changed = args.notes === row.notes ? [] : [{ field: 'notes', from: row.notes, to: args.notes }]
    return {
      summary: `改 DSH ${row.dshVersion} 的备注：${changed.length === 0 ? '没有变化' : changed.map((item) => changeLine(item.field, item.from, item.to)).join('；')}`,
      affected: [],
      warnings: changed.length === 0 ? ['备注没有变化'] : [],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).runtimes.updateNotes(args.runtimeId, args.notes, actor.actorId, ctx.meta)
  },
})

const runtimesDelete = defineCapability({
  id: 'runtimes.delete',
  area: 'runtimes',
  title: '删除 DSH 版本',
  description:
    '删除一个版本行并尝试删掉本机镜像（不可恢复；钉住它的用户之后重建容器会失败）。**敏感**：方案卡要密码。' +
    '只想「别再用」请用 runtimes.retire。先用 runtimes.list 看有多少用户在这个版本上。',
  risk: 'R3',
  classicPath: '/admin/runtimes',
  input: runtimeIdArgs,
  async preview(ctx, args) {
    const preview = await runtimePreview(ctx, args.runtimeId, '删除')
    return preview
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    await services(ctx).runtimes.remove(args.runtimeId, actor.actorId, ctx.meta)
    return { runtimeId: args.runtimeId, deleted: true }
  },
})

// ── 插件库 ──────────────────────────────────────────────────────────────────

const pluginsCreate = defineCapability({
  id: 'plugins.create',
  area: 'plugins',
  title: '上架插件',
  description:
    '在插件库里新建一个插件（packageName + 显示名 + 策略 + 是否 bundle + 配置片段 + 是否要重启）。' +
    '**只建元数据，不含版本**：版本要再用 plugins.versions.add 加。configYaml 是插件配置片段（不是密钥；' +
    '里面的凭据会被 I4 按值脱敏）。先用 plugins.lookup 查包名与最新版。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: CreatePluginRequestSchema,
  async preview(ctx, input) {
    const rows = await services(ctx).plugins.listCatalog(input.platform)
    const dup = rows.find((row) => row.packageName === input.packageName)
    return {
      summary: `上架插件 ${input.packageName}（${input.displayName}，策略 ${input.policy}${
        input.isBundle === true ? '，是 bundle' : ''
      }）`,
      affected: [],
      warnings: [
        ...(dup ? [`这个平台上已经有同名插件（pluginId=${String(dup.id)}）：重复上架会失败`] : []),
        '新建后还没有版本：用户装不到，要再 plugins.versions.add',
      ],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return await services(ctx).plugins.createPlugin(input, actor.actorId, ctx.meta)
  },
})

const pluginsUpdate = defineCapability({
  id: 'plugins.update',
  area: 'plugins',
  title: '修改插件元数据',
  description:
    '改插件库里的元数据（显示名/描述/图标/bundle 顺序/配置片段/是否要重启/策略）。只改给出的字段，' +
    'preview 逐项给「旧值 → 新值」。只想改策略也可以用 plugins.policy.set（更短的路径）。' +
    '有影响：出方案卡（改配置片段后已装的容器要重新下发才生效）。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: z.object({
    pluginId: z.number().int().positive(),
    patch: UpdatePluginRequestSchema,
  }),
  async preview(ctx, args) {
    await requirePlugin(ctx, args.pluginId, args.patch.platform)
    const current = await services(ctx).plugins.getCatalogRow(args.pluginId, args.patch.platform)
    const changed = Object.entries(args.patch)
      .filter(
        ([key, value]) =>
          key === 'platform' ||
          JSON.stringify((current as never as Record<string, unknown>)[key]) !== JSON.stringify(value),
      )
      .map(([key, value]) => ({
        field: key,
        from: (current as never as Record<string, unknown>)[key],
        to: value,
      }))
    return {
      summary: `改插件「${current.displayName}」：${changed.length === 0 ? '没有字段变化' : changed.map((item) => changeLine(item.field, item.from, item.to)).join('；')}`,
      affected: [{ kind: 'plugin', id: current.id, label: current.packageName }],
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        '改了 configYaml / needsRestart 之后，已安装的容器要重新下发才生效',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).plugins.updatePlugin(args.pluginId, args.patch, actor.actorId, ctx.meta)
  },
})

const pluginsDelete = defineCapability({
  id: 'plugins.delete',
  area: 'plugins',
  title: '删除插件',
  description:
    '把插件从某个平台的库里删掉（同时删版本与安装记录；桌面平台还要先撤掉目标）。**有影响**：用户下次启动会失去它，' +
    '必装插件被删会让容器起不来。只想下架请用 plugins.policy.set（hidden）。先用 plugins.list 确认 pluginId。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: z.object({
    pluginId: z.number().int().positive(),
    ...PLUGIN_PLATFORM_ARGS,
  }),
  async preview(ctx, args) {
    await requirePlugin(ctx, args.pluginId, args.platform)
    const current = await services(ctx).plugins.getCatalogRow(args.pluginId, args.platform)
    return {
      summary: `删除插件「${current.displayName}」（${current.packageName}，策略 ${current.policy}，已装 ${String(
        current.stats.installed,
      )} 人）`,
      affected: [{ kind: 'plugin', id: current.id, label: current.packageName }],
      warnings: [
        current.stats.installed > 0
          ? `还有 ${String(current.stats.installed)} 个用户装着它：删除后他们的容器下次启动会少这个插件`
          : '还没有人装它',
        ...(current.policy === 'required' ? ['它是必装插件：删除后需要先改策略，否则容器启动会缺包'] : []),
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    await services(ctx).plugins.deletePlugin(args.pluginId, actor.actorId, ctx.meta)
    return { pluginId: args.pluginId, deleted: true }
  },
})

/** 新增版本的入参（**不支持 .tgz 上传**：二进制走不了对话，上传只能在经典页面做） */
const PluginVersionAddArgs = z.object({
  pluginId: z.number().int().positive(),
  source: z
    .enum(['npm', 'tarball', 'local'])
    .describe('npm=从 npm 源安装；tarball=按 URL 拉；local=用 Hub 本机路径（很少用）'),
  version: z.string().min(1).max(64).describe('版本号，如 0.1.4'),
  url: z.string().url().optional().describe('source=tarball 时的 tgz 地址'),
  path: z.string().min(1).optional().describe('source=local 时的本机路径'),
  ...PLUGIN_PLATFORM_ARGS,
})

const pluginsVersionsAdd = defineCapability({
  id: 'plugins.versions.add',
  area: 'plugins',
  title: '给插件加版本',
  description:
    '给已有插件加一个版本：source=npm（从 npm 源按版本号装）、tarball（给 tgz 的 URL）、local（Hub 本机路径）。' +
    '**上传 .tgz 只能去经典页面**（对话里传不了二进制）。加完可以 rollouts.plugin 下发。' +
    '先用 plugins.lookup 确认版本存在。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: PluginVersionAddArgs,
  async preview(ctx, args) {
    await requirePlugin(ctx, args.pluginId, args.platform)
    const current = await services(ctx).plugins.getCatalogRow(args.pluginId, args.platform)
    return {
      summary: `给插件「${current.displayName}」加版本 ${args.version}（来源 ${args.source}）`,
      affected: [{ kind: 'plugin', id: current.id, label: current.packageName }],
      warnings: [
        args.source === 'tarball' && args.url === undefined ? ['source=tarball 必须给 url'] : [],
        args.source === 'local' && args.path === undefined ? ['source=local 必须给 path'] : [],
        '新版本不会自动下发；要下发用 rollouts.plugin',
      ].flat(),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    const platform = args.platform === undefined ? {} : { platform: args.platform }
    const input =
      args.source === 'npm'
        ? { sourceType: 'npm' as const, version: args.version, ...platform }
        : args.source === 'tarball'
          ? { sourceType: 'tarball' as const, url: args.url ?? '', version: args.version, ...platform }
          : { sourceType: 'local' as const, path: args.path ?? '', version: args.version, ...platform }
    return await services(ctx).plugins.addVersion(args.pluginId, input, ctx.meta, actor.actorId)
  },
})

const pluginsVersionsRemove = defineCapability({
  id: 'plugins.versions.remove',
  area: 'plugins',
  title: '删除插件版本',
  description:
    '删掉插件的一个版本（不可恢复）。还有用户钉在这个版本上时，他们下次重建会落回别的版本。' +
    '问「把 0.1.2 那个版本删了」用它；只想让别人别装新版本用 plugins.policy.set。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: z.object({
    pluginId: z.number().int().positive(),
    versionId: z.number().int().positive().describe('版本 id（plugins.get 的 versions[].versionId）'),
  }),
  async preview(ctx, args) {
    await requirePlugin(ctx, args.pluginId)
    const current = await services(ctx).plugins.getCatalogRow(args.pluginId)
    const version = current.versions.find((item) => item.id === args.versionId)
    if (!version)
      throw new HubError('NOT_FOUND', `插件 ${String(args.pluginId)} 没有版本 ${String(args.versionId)}`)
    return {
      summary: `删除插件「${current.displayName}」的版本 ${version.version}`,
      affected: [{ kind: 'plugin', id: current.id, label: current.packageName }],
      warnings: [
        current.versions.length <= 1 ? '这是它唯一的版本：删完这个插件就没有版本可装了' : '',
        '钉在该版本上的用户，下次重建会落回别的版本',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    await services(ctx).plugins.removeVersion(args.pluginId, args.versionId, actor.actorId, ctx.meta)
    return { pluginId: args.pluginId, versionId: args.versionId, deleted: true }
  },
})

const pluginsPlatformsAdd = defineCapability({
  id: 'plugins.platforms.add',
  area: 'plugins',
  title: '把插件加入另一个平台',
  description:
    '把一个已在库里的插件加入另一个平台的库（云上 ↔ 桌面），两个平台的策略/版本各自独立。' +
    '问「这个插件桌面端也要有」用它。要移出用 plugins.platforms.remove。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: z.object({
    pluginId: z.number().int().positive(),
    platform: PluginPlatformSchema.describe('要加入哪个平台（cloud / desktop）'),
  }),
  async preview(ctx, args) {
    const rows = await services(ctx).plugins.listCatalog(args.platform)
    const exists = rows.some((row) => row.id === args.pluginId)
    const current = await services(ctx).plugins.getCatalogRow(args.pluginId)
    return {
      summary: `把插件「${current.displayName}」加入 ${args.platform} 平台的库`,
      affected: [{ kind: 'plugin', id: current.id, label: current.packageName }],
      warnings: [
        ...(exists ? ['它已经在这个平台的库里了，这一步会失败'] : []),
        '加入后还要给它加这个平台的版本（plugins.versions.add platform=…）',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).plugins.addPlatform(
      args.pluginId,
      { platform: args.platform },
      actor.actorId,
      ctx.meta,
    )
  },
})

const pluginsPlatformsRemove = defineCapability({
  id: 'plugins.platforms.remove',
  area: 'plugins',
  title: '把插件移出某个平台',
  description:
    '把一个插件从某个平台的库里移出（force=true 同时撤销桌面目标）。另一个平台的库不受影响。**有影响**：' +
    '该平台上的用户下次启动会失去它。只想下架用 plugins.policy.set（hidden）。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/plugins',
  input: z.object({
    pluginId: z.number().int().positive(),
    platform: PluginPlatformSchema,
    force: z.boolean().default(false).describe('true = 同时撤销桌面端目标（不再下发）'),
  }),
  async preview(ctx, args) {
    const current = await services(ctx).plugins.getCatalogRow(args.pluginId, args.platform)
    return {
      summary: `把插件「${current.displayName}」从 ${args.platform} 平台的库移出${args.force ? '（并撤销目标）' : ''}`,
      affected: [{ kind: 'plugin', id: current.id, label: current.packageName }],
      warnings: [
        current.stats.installed > 0
          ? `该平台还有 ${String(current.stats.installed)} 个用户装着它`
          : '该平台还没有人装它',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    await services(ctx).plugins.removePlatform(
      args.pluginId,
      args.platform,
      { force: args.force },
      actor.actorId,
      ctx.meta,
    )
    return { pluginId: args.pluginId, platform: args.platform, removed: true }
  },
})

const pluginsLookup = defineCapability({
  id: 'plugins.lookup',
  area: 'plugins',
  title: '查 npm 上的插件包',
  description:
    '从 npm 源查一个包的元数据（显示名、描述、全部版本、最新版、是不是 bundle、要不要重启），**不入库**。' +
    '问「npm 上 dsh-memory 最新版是多少」「这个包名对不对」用它；查完要入库用 plugins.create。' +
    '要联网（一般 1–5 秒）。',
  risk: 'R0',
  classicPath: '/admin/plugins',
  input: PluginLookupQuerySchema,
  async run(ctx, query) {
    const result = await services(ctx).plugins.lookup(query)
    return { plugin: result }
  },
})

const pluginsUsers = defineCapability({
  id: 'plugins.users',
  area: 'plugins',
  title: '插件安装矩阵',
  description:
    '列出一个插件在全部用户上的安装状态：每个用户装了哪个版本、期望状态、是否有错误（`row=null` 表示从没装过）。' +
    '问「谁装了 0.1.2 还没升级」「哪些用户装失败」用它。只看人数用 plugins.list / plugins.get。' +
    '返回 {rows}。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/plugins',
  input: z.object({ pluginId: z.number().int().positive() }),
  async run(ctx, args) {
    await requirePlugin(ctx, args.pluginId)
    const rows = await services(ctx).plugins.listUsersOfPlugin(args.pluginId)
    return { rows }
  },
})

const pluginsInstallStats = defineCapability({
  id: 'plugins.install-stats',
  area: 'plugins',
  title: '插件安装统计',
  description:
    '每个插件在「实例」与「桌面端」两侧的安装人数与过期人数（一条 SQL 算完，统一下发向导的目标人数提示用它）。' +
    '问「哪些插件该升级了」「桌面端装了多少」用它。要看具体是哪些用户用 plugins.users。返回 {rows}。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/rollouts',
  input: z.object({}),
  async run(ctx) {
    const stats = await services(ctx).deliveries.installStats()
    return { rows: stats.items }
  },
})

// ── 模型：提供方 / 预设 / 发现模型 ──────────────────────────────────────────

const modelsProvidersUpsert = defineCapability({
  id: 'models.providers.upsert',
  area: 'models',
  title: '新建或修改模型提供方',
  description:
    '新建一个模型提供方（routeKey + 显示名 + 协议 + baseUrl + 模型清单 + 密钥模式），或修改已有提供方（providerId + 任意字段）。' +
    'keyMode=shared 需要密钥时用 apiKey：**只能填密钥卡给的 sec_… 引用**，不接受明文。' +
    '先用 models.list kind=providers 看现有配置。有影响：出方案卡（改不动点会牵动所有用它的预设）。',
  risk: 'R2',
  classicPath: '/admin/models',
  secretFields: ['apiKey'],
  input: z.object({
    providerId: z.number().int().positive().optional().describe('省略 = 新建；给了 = 修改这个提供方'),
    routeKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('DSH 里的 provider 名（新建必填，小写连字符）'),
    displayName: z.string().trim().min(1).max(64).optional(),
    kind: z.enum(['pi-ai', 'deepseek-official']).optional(),
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']).optional(),
    baseUrl: z.string().max(500).optional(),
    models: z.array(z.record(z.string(), z.unknown())).optional().describe('模型清单（ModelSpec 数组）'),
    compat: z.record(z.string(), z.unknown()).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
    keyMode: z.enum(['shared', 'per-user', 'none']).optional(),
    apiKey: z.string().optional().describe('keyMode=shared 时的密钥：只能填 sec_… 引用（走密钥卡）'),
    enabled: z.boolean().optional(),
  }),
  async preview(ctx, args) {
    if (args.providerId === undefined) {
      if (
        args.routeKey === undefined ||
        args.displayName === undefined ||
        args.kind === undefined ||
        args.keyMode === undefined
      ) {
        throw new HubError('VALIDATION_FAILED', '新建提供方必须给 routeKey、displayName、kind、keyMode')
      }
      const dup = (await services(ctx).models.listProviders()).some((row) => row.routeKey === args.routeKey)
      return {
        summary: `新建模型提供方 ${args.routeKey}（${args.displayName}，${args.kind}，密钥模式 ${args.keyMode}）`,
        affected: [],
        warnings: [
          ...(dup ? ['routeKey 已被占用：新建会失败'] : []),
          '新建的提供方不会自动进任何预设：要挂进预设用 models.presets.upsert',
        ],
      }
    }
    const current = (await services(ctx).models.listProviders()).find((row) => row.id === args.providerId)
    if (!current) throw new HubError('NOT_FOUND', `提供方 ${String(args.providerId)} 不存在`)
    const before = current as unknown as Record<string, unknown>
    const changed = Object.entries(args)
      .filter(
        ([key, value]) =>
          key !== 'providerId' && key !== 'apiKey' && JSON.stringify(before[key]) !== JSON.stringify(value),
      )
      .map(([key, value]) => ({ field: key, from: before[key], to: value }))
    return {
      summary: `改提供方 ${current.routeKey}：${changed.length === 0 ? '没有字段变化' : changed.map((item) => changeLine(item.field, item.from, item.to)).join('；')}${
        args.apiKey === undefined ? '' : '；并更新密钥'
      }`,
      affected: [{ kind: 'model', id: current.id, label: current.routeKey }],
      warnings: [
        ...(changed.length === 0 && args.apiKey === undefined ? ['没有字段真的变化'] : []),
        '改 baseUrl/模型清单会让用它的用户下次下发时拿到新配置',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    const { providerId, ...rest } = args
    const body = { ...rest }
    if (providerId === undefined) {
      return await services(ctx).models.createProvider(
        CreateProviderRequestSchema.parse(body),
        actor.actorId,
        ctx.meta,
      )
    }
    return await services(ctx).models.updateProvider(
      providerId,
      UpdateProviderRequestSchema.parse(body),
      actor.actorId,
      ctx.meta,
    )
  },
})

const modelsProvidersDelete = defineCapability({
  id: 'models.providers.delete',
  area: 'models',
  title: '删除模型提供方',
  description:
    '删除一个模型提供方（不可恢复）。**敏感**：它可能被多个预设引用，删掉后那些预设会渲染失败、用户的模型配置跟着坏。' +
    '先用 models.list kind=presets 看谁在用它；只想停用请改 enabled=false（models.providers.upsert）。',
  risk: 'R3',
  classicPath: '/admin/models',
  input: z.object({ providerId: z.number().int().positive() }),
  async preview(ctx, args) {
    const providers = await services(ctx).models.listProviders()
    const provider = providers.find((row) => row.id === args.providerId)
    if (!provider) throw new HubError('NOT_FOUND', `提供方 ${String(args.providerId)} 不存在`)
    const presets = (await services(ctx).models.listPresets()).filter((preset) =>
      preset.providerIds.includes(provider.id),
    )
    return {
      summary: `删除模型提供方 ${provider.routeKey}（${provider.displayName}；被 ${String(presets.length)} 个预设引用）`,
      affected: [
        { kind: 'model', id: provider.id, label: provider.routeKey },
        ...presets.map((preset) => ({ kind: 'model' as const, id: preset.id, label: `预设 ${preset.name}` })),
      ],
      warnings: [
        presets.length > 0
          ? `这些预设都引用它：删除后它们渲染时会少一个提供方（用户模型配置会变）`
          : '没有预设引用它',
        '这个操作不可恢复',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    await services(ctx).models.deleteProvider(args.providerId, actor.actorId, ctx.meta)
    return { providerId: args.providerId, deleted: true }
  },
})

const modelsPresetsUpsert = defineCapability({
  id: 'models.presets.upsert',
  area: 'models',
  title: '新建或修改模型预设',
  description:
    '新建一个模型预设（名称 + 提供方列表 + 默认提供方与默认模型 + 是否默认预设），或修改已有预设（presetId + 任意字段）。' +
    '预设决定用户容器里渲染哪套模型配置；改完要 rollouts.model 下发才进容器。' +
    '先用 models.list kind=presets / providers 看现状。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: z.object({
    presetId: z.number().int().positive().optional().describe('省略 = 新建；给了 = 修改'),
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().max(500).optional(),
    providerIds: z.array(z.number().int().positive()).min(1).optional(),
    defaultProvider: z.string().trim().min(1).optional(),
    defaultModel: z.string().trim().min(1).optional(),
    isDefault: z.boolean().optional(),
    platform: z.enum(['cloud', 'desktop']).optional(),
  }),
  async preview(ctx, args) {
    if (args.presetId === undefined) {
      if (
        args.name === undefined ||
        args.providerIds === undefined ||
        args.defaultProvider === undefined ||
        args.defaultModel === undefined
      ) {
        throw new HubError(
          'VALIDATION_FAILED',
          '新建预设必须给 name、providerIds、defaultProvider、defaultModel',
        )
      }
      return {
        summary: `新建模型预设「${args.name}」（默认 ${args.defaultProvider}/${args.defaultModel}，${String(
          args.providerIds.length,
        )} 个提供方）`,
        affected: [],
        warnings: ['新预设不会自动生效：要 rollouts.model 下发，或把它设为默认预设'],
      }
    }
    const presets = await services(ctx).models.listPresets()
    const current = presets.find((row) => row.id === args.presetId)
    if (!current) throw new HubError('NOT_FOUND', `预设 ${String(args.presetId)} 不存在`)
    const before = current as unknown as Record<string, unknown>
    const changed = Object.entries(args)
      .filter(([key, value]) => key !== 'presetId' && JSON.stringify(before[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({ field: key, from: before[key], to: value }))
    return {
      summary:
        `改预设「${current.name}」：${changed.length === 0 ? '没有字段变化' : changed.map((item) => changeLine(item.field, item.from, item.to)).join('；')}` +
        `（当前 ${String(current.usersOnIt)} 个用户在用）`,
      affected: [{ kind: 'model', id: current.id, label: current.name }],
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        current.usersOnIt > 0 ? '改完要 rollouts.model 下发，用户容器才会用新配置' : '',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    const { presetId, ...rest } = args
    if (presetId === undefined) {
      return await services(ctx).models.createPreset(
        CreatePresetRequestSchema.parse(rest),
        actor.actorId,
        ctx.meta,
      )
    }
    return await services(ctx).models.updatePreset(
      presetId,
      UpdatePresetRequestSchema.parse(rest),
      actor.actorId,
      ctx.meta,
    )
  },
})

const modelsPresetsDelete = defineCapability({
  id: 'models.presets.delete',
  area: 'models',
  title: '删除模型预设',
  description:
    '删除一个模型预设（不可恢复）。钉住它的用户会落回默认预设，模型配置随之变化。' +
    '先用 models.list kind=presets 看 usersOnIt；只想退役请先把用户改到别的预设（users.update）。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: z.object({ presetId: z.number().int().positive() }),
  async preview(ctx, args) {
    const presets = await services(ctx).models.listPresets()
    const current = presets.find((row) => row.id === args.presetId)
    if (!current) throw new HubError('NOT_FOUND', `预设 ${String(args.presetId)} 不存在`)
    return {
      summary: `删除模型预设「${current.name}」（${String(current.usersOnIt)} 个用户在用${
        current.isDefault ? '，它是默认预设' : ''
      }）`,
      affected: [{ kind: 'model', id: current.id, label: current.name }],
      warnings: [
        current.usersOnIt > 0 ? '这些用户会落回默认预设，模型配置会变（下次启动生效）' : '没有用户钉在它上面',
        ...(current.isDefault ? ['删掉默认预设后，新用户会拿不到模型配置：请先设另一个默认'] : []),
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    await services(ctx).models.deletePreset(args.presetId, actor.actorId, ctx.meta)
    return { presetId: args.presetId, deleted: true }
  },
})

const modelsDiscover = defineCapability({
  id: 'models.discover',
  area: 'models',
  title: '发现上游模型',
  description:
    '问一个上游（baseUrl + api，可带 apiKey 引用）现在有哪些模型可用，并与 Hub 的模型信息库做匹配（给出上下文长度、思考档位等）。' +
    '造提供方/加模型之前用它「先看看有什么」。要联网（5–20 秒，超时 30 秒）。' +
    'apiKey 只能填密钥卡给的 sec_… 引用。',
  risk: 'R0',
  classicPath: '/admin/models',
  secretFields: ['apiKey'],
  input: z.object({
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
    baseUrl: z.string().trim().min(1).max(500),
    apiKey: z.string().optional().describe('上游密钥：只能填 sec_… 引用（密钥卡）；公共上游可省略'),
  }),
  async run(ctx, args) {
    const result = await services(ctx).models.discover(args)
    return {
      total: result.models.length,
      rows: result.models.map((model) => ({
        modelId: model.id,
        name: model.name,
        matchedId: model.matchedId ?? null,
        infoSource: model.infoSource ?? null,
        contextWindow: model.contextWindow ?? null,
        maxTokens: model.maxTokens ?? null,
        reasoningEfforts: model.reasoningEfforts ?? null,
      })),
    }
  },
})

// ── 全局设置（分组白名单） ──────────────────────────────────────────────────

/**
 * `settings.update` 的分组白名单：**一次只改一组**，每组字段显式列出（JSON Schema 里看得见）。
 * 影响所有用户的组一律 R3 —— 整条能力就是 R3（见 docs/24 §0 的风险分级）。
 */
const SettingsGroupArgs = z.discriminatedUnion('group', [
  z.object({ group: z.literal('site'), values: SiteSettingsSchema }).describe('站点名称/标语/公告'),
  z
    .object({ group: z.literal('registration'), values: RegistrationSettingsSchema })
    .describe('注册模式/审批/人数上限'),
  z.object({ group: z.literal('default_quota'), values: QuotaSchema }).describe('新用户默认配额'),
  z
    .object({ group: z.literal('capacity'), values: CapacitySettingsSchema })
    .describe('并发实例上限/维护模式/进行中上限'),
  z.object({ group: z.literal('exports'), values: ExportsSettingsSchema }).describe('导出 TTL/大小/每日次数'),
  z
    .object({ group: z.literal('security'), values: SecuritySettingsSchema })
    .describe('管理员会话时长/reauth 窗口'),
  z.object({ group: z.literal('desktop'), values: DesktopSettingsSchema }).describe('桌面端设备与心跳策略'),
  z
    .object({ group: z.literal('mobile'), values: MobileSettingsSchema })
    .describe('手机 App 强更地板与下载地址'),
  z.object({ group: z.literal('container'), values: ContainerSettingsSchema }).describe('容器运行参数'),
])

const SETTINGS_GROUP_LABELS: Record<string, string> = {
  site: '站点信息',
  registration: '注册策略',
  default_quota: '新用户默认配额',
  capacity: '容量',
  exports: '导出',
  security: '安全',
  desktop: '桌面端策略',
  mobile: '手机 App 策略',
  container: '容器参数',
}

const settingsUpdate = defineCapability({
  id: 'settings.update',
  area: 'settings',
  title: '修改系统设置（按组）',
  description:
    '按组整体替换一段系统设置，一次只能改一组：site（站点/公告）、registration（注册与审批）、default_quota（新用户配额）、' +
    'capacity（并发上限/维护模式）、exports、security（会话/reauth 窗口）、desktop、mobile、container。' +
    'preview 逐项给「旧值 → 新值」并说明影响面。**影响所有用户，敏感**：方案卡要密码。' +
    '座舱自己的模型/R1 自动执行不用这个（走 PUT /api/admin/cockpit/settings）。',
  risk: 'R3',
  classicPath: '/admin/settings',
  input: SettingsGroupArgs,
  async preview(ctx, args) {
    const current = await services(ctx).system.getSettings()
    const before = (current as unknown as Record<string, unknown>)[args.group] as Record<string, unknown>
    const after = args.values as Record<string, unknown>
    const changed = Object.entries(after)
      .filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({ field: key, from: before[key], to: value }))
    return {
      summary: `改${SETTINGS_GROUP_LABELS[args.group] ?? args.group}：${
        changed.length === 0
          ? '没有字段变化'
          : changed.map((item) => changeLine(item.field, item.from, item.to)).join('；')
      }`,
      affected: [],
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : ['这一组设置对所有用户生效，立即生效（不用重启）']),
        ...(args.group === 'capacity' && (args.values as { maxRunning?: number }).maxRunning === 0
          ? ['maxRunning=0 是维护模式：所有实例启动都会被拒绝']
          : []),
        ...(args.group === 'registration' && (args.values as { mode?: string }).mode === 'closed'
          ? ['注册改成 closed 后，邀请码也不能再注册']
          : []),
      ],
    }
  },
  async run(ctx, args) {
    return await services(ctx).system.updateSettings({ [args.group]: args.values }, adminActor(ctx))
  },
})

// ── 算力设置 / 安卓发布 ───────────────────────────────────────────────────

const ComputeGroupArgs = z.discriminatedUnion('group', [
  z.object({
    group: z.literal('billing'),
    values: z.object({
      billingEnabled: z.boolean(),
      billAdmins: z.boolean(),
      graceMinutes: z.number().int().min(0).max(60),
    }),
  }),
  z.object({
    group: z.literal('capacity'),
    values: z.object({ capacityMemoryMb: z.number().int().min(0).max(4_194_304) }),
  }),
  z.object({
    group: z.literal('plans'),
    values: z.object({
      defaultPlanId: z.string().nullable(),
      contactText: z.string().trim().max(200),
    }),
  }),
])

const computeSettingsUpdate = defineCapability({
  id: 'compute.settings.update',
  area: 'compute',
  title: '修改算力计费设置（按组）',
  description:
    '按组改算力租赁设置：billing（是否计费/管理员是否计费/宽限分钟）、capacity（内存准入上限）、plans（默认规格 id 与' +
    '联系提示；规格列表本身要改价格就整组替换，见经典页面）。preview 给「旧值 → 新值」。' +
    '**影响所有按小时计费的实例，敏感**：方案卡要密码。',
  risk: 'R3',
  classicPath: '/admin/instances',
  input: ComputeGroupArgs,
  async preview(ctx, args) {
    const current = await services(ctx).compute.settingsResponse()
    const before = current.settings as unknown as Record<string, unknown>
    const changed = Object.entries(args.values as Record<string, unknown>)
      .filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({ field: key, from: before[key], to: value }))
    return {
      summary: `改算力设置的 ${args.group} 组：${changed.length === 0 ? '没有字段变化' : changed.map((item) => changeLine(item.field, item.from, item.to)).join('；')}`,
      affected: [],
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        '计费改动对之后产生的租约生效，已扣的费用不回滚',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).compute.updateSettings(args.values, actor.actorId, ctx.meta)
  },
})

const mobileAppRollback = defineCapability({
  id: 'mobile.app.rollback',
  area: 'mobile',
  title: '回滚安卓发布',
  description:
    '把安卓 App 的「最新发布」回退到某条历史记录（releaseId 省略 = 上一条），被撤下的发布会被标为作废。' +
    '发布/上传 APK 只能在经典页面做（二进制）。**有影响**：所有手机端会看到旧版本与强更提示。出方案卡。',
  risk: 'R2',
  classicPath: '/admin/settings',
  input: z.object({
    releaseId: z.number().int().positive().optional().describe('回滚到哪条发布；省略 = 上一条'),
  }),
  async preview(ctx, args) {
    const releases = services(ctx).mobileApp.list()
    const current = services(ctx).mobileApp.current()
    const target =
      args.releaseId === undefined
        ? releases.find((item) => item.id !== current?.id)
        : releases.find((item) => item.id === args.releaseId)
    if (!target) throw new HubError('NOT_FOUND', '没有可回滚的发布记录（或指定的 releaseId 不存在）')
    return {
      summary: `安卓发布回滚到 ${target.versionName}（当前 ${current?.versionName ?? '无'}）`,
      affected: [],
      warnings: ['回滚后所有手机端会看到这个版本；低于强更地板的客户端会被要求升级'],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).mobileApp.rollback(args, actor.actorId, ctx.meta)
  },
})

export const PLATFORM_CAPABILITIES = [
  runtimesAvailable,
  runtimesCreate,
  runtimesSetDefault,
  runtimesRetire,
  runtimesUpdate,
  runtimesDelete,
  pluginsCreate,
  pluginsUpdate,
  pluginsDelete,
  pluginsVersionsAdd,
  pluginsVersionsRemove,
  pluginsPlatformsAdd,
  pluginsPlatformsRemove,
  pluginsLookup,
  pluginsUsers,
  pluginsInstallStats,
  modelsProvidersUpsert,
  modelsProvidersDelete,
  modelsPresetsUpsert,
  modelsPresetsDelete,
  modelsDiscover,
  settingsUpdate,
  computeSettingsUpdate,
  mobileAppRollback,
] as const
