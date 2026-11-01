import { z } from 'zod'
import {
  CreateRelayModelRequestSchema,
  CreateToolChannelRequestSchema,
  ImportRelayModelsRequestSchema,
  RelayUsageLogQuerySchema,
  RelayWalletListQuerySchema,
  ToolUsageQuerySchema,
  UpdateRelayDshRequestSchema,
  UpdateRelayModelRequestSchema,
  UpdateToolChannelRequestSchema,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import { defineCapability } from './define.js'
import { renderDiff } from './admin-people.js'
import type { CapabilityContext } from './types.js'
import { adminActor } from './write.js'

/**
 * WP56f 第三批：中转站（渠道/模型/下发/设置/钱包/用量记录）、搜索池。
 *
 * 两类「点一下看结果」的运维交互按编排者的口径定级：
 * - **有副作用但可逆**（测渠道会打上游、刷新订阅会重拉节点）→ R1；
 * - **纯探测、无副作用**（端到端检查 check、读日志）→ R0，并在 description 里写明耗时与超时。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

// ── 中转站：渠道的删除 / 测速 / 密钥 ────────────────────────────────────────

async function relayChannelOrThrow(ctx: CapabilityContext, channelId: number) {
  const channel = services(ctx)
    .relay.listChannels()
    .find((item) => item.id === channelId)
  if (!channel)
    throw new HubError('NOT_FOUND', `渠道 ${String(channelId)} 不存在（先用 relay.channels.list 查）`)
  return channel
}

const relayChannelsDelete = defineCapability({
  id: 'relay.channels.delete',
  area: 'relay',
  title: '删除中转站渠道',
  description:
    '删掉一个中转站渠道（连同它的密钥；不可恢复）。渠道上挂的路由会失效，走这些路由的模型可能就没有可用上游了。' +
    '**敏感**：方案卡要密码。只想停用请改 enabled=false（relay.channels.upsert）。' +
    '先用 relay.channels.list 看它的 modelCount 与健康状态。',
  risk: 'R3',
  classicPath: '/admin/models',
  input: z.object({ channelId: z.number().int().positive() }),
  async preview(ctx, args) {
    const channel = await relayChannelOrThrow(ctx, args.channelId)
    return {
      summary: `删除渠道「${channel.name}」（${String(channel.keys.length)} 把密钥，被 ${String(
        channel.modelCount,
      )} 个模型引用）`,
      affected: [],
      warnings: [
        channel.modelCount > 0
          ? '有模型的路由挂在这个渠道上：删完它们可能没有可用上游（请先给模型加别的路由）'
          : '没有模型引用它',
        '删除不可恢复',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    services(ctx).relay.deleteChannel(args.channelId, actor.actorId, ctx.meta)
    return { channelId: args.channelId, deleted: true }
  },
})

const relayChannelsTest = defineCapability({
  id: 'relay.channels.test',
  area: 'relay',
  title: '测中转站渠道',
  description:
    '用渠道里的每把可用密钥请求一次上游 `/models`，逐把给出 ok / 耗时 / 错误（不写库、不改状态，但**会打上游**）。' +
    '问「这个渠道通不通」「哪把 key 挂了」用它。最多等 30 秒（每把密钥单独超时）。要改配置用 relay.channels.upsert。',
  risk: 'R1',
  classicPath: '/admin/models',
  input: z.object({ channelId: z.number().int().positive() }),
  async preview(ctx, args) {
    const channel = await relayChannelOrThrow(ctx, args.channelId)
    return {
      summary: `测渠道「${channel.name}」的 ${String(channel.keys.length)} 把密钥（打一次上游 /models）`,
      warnings: ['会真的请求上游（消耗一次配额），不改任何配置'],
    }
  },
  async run(ctx, args) {
    const result = await services(ctx).relay.testChannel(args.channelId)
    return result
  },
})

const relayChannelsKeyUpdate = defineCapability({
  id: 'relay.channels.key.update',
  area: 'relay',
  title: '改渠道密钥状态/备注',
  description:
    '把渠道里某把密钥改成 active（重新启用）或 disabled（停用），也可以改备注。停用一把坏 key 是最常见的排障动作。' +
    'keyId 与末四位从 relay.channels.list 的 `last4` / 经典页面拿。有影响：出方案卡（停用会让可用密钥变少）。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: z.object({
    channelId: z.number().int().positive(),
    keyId: z.number().int().positive().describe('密钥 id（relay.channels.list 的 keys 顺序与经典页面一致）'),
    label: z.string().max(64).optional(),
    state: z.enum(['active', 'disabled']).optional(),
  }),
  async preview(ctx, args) {
    const channel = await relayChannelOrThrow(ctx, args.channelId)
    const key = channel.keys.find((item) => item.id === args.keyId)
    if (!key) throw new HubError('NOT_FOUND', `渠道 ${String(args.channelId)} 没有密钥 ${String(args.keyId)}`)
    const changed = [
      ...(args.state === undefined || args.state === key.state
        ? []
        : [{ field: 'state', from: key.state, to: args.state }]),
      ...(args.label === undefined || args.label === key.label
        ? []
        : [{ field: 'label', from: key.label, to: args.label }]),
    ]
    return {
      summary: `改渠道「${channel.name}」的密钥 …${key.last4}：${changed.length === 0 ? '没有字段变化' : renderDiff(changed)}`,
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        args.state === 'disabled' ? '停用后这把密钥不再参与分流（可能降低并发/可用性）' : '',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).relay.updateChannelKey(
      args.channelId,
      args.keyId,
      {
        ...(args.label === undefined ? {} : { label: args.label }),
        ...(args.state === undefined ? {} : { state: args.state }),
      },
      actor.actorId,
      ctx.meta,
    )
  },
})

const relayChannelsKeyDelete = defineCapability({
  id: 'relay.channels.key.delete',
  area: 'relay',
  title: '删除渠道密钥',
  description:
    '从渠道里删掉一把密钥（不可恢复；只剩末四位与 id 可核对）。停用一把临时故障的 key 用 relay.channels.key.update（可恢复），' +
    '确认泄漏或作废了才删。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: z.object({
    channelId: z.number().int().positive(),
    keyId: z.number().int().positive(),
  }),
  async preview(ctx, args) {
    const channel = await relayChannelOrThrow(ctx, args.channelId)
    const key = channel.keys.find((item) => item.id === args.keyId)
    if (!key) throw new HubError('NOT_FOUND', `渠道 ${String(args.channelId)} 没有密钥 ${String(args.keyId)}`)
    return {
      summary: `删除渠道「${channel.name}」的密钥 …${key.last4}（当前 ${key.state}）`,
      warnings: [
        '删除不可恢复',
        channel.keys.length <= 1 ? '这是该渠道最后一把密钥：删完渠道就不可用了' : '',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).relay.deleteChannelKey(args.channelId, args.keyId, actor.actorId, ctx.meta)
  },
})

// ── 中转站：对外模型 ────────────────────────────────────────────────────────

const relayModelsCreate = defineCapability({
  id: 'relay.models.create',
  area: 'relay',
  title: '新建对外模型',
  description:
    '在「模型与价格」里新建一个对外模型：名字、价格、可见性、路由（每个渠道一条、带上游模型名）。' +
    '渠道与上游模型名先用 relay.channels.list 看。建完要下发才进容器（经典页面「下发到 DSH」）。' +
    '已有模型加路由用 relay.models.import。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: CreateRelayModelRequestSchema,
  async preview(ctx, input) {
    const existing = services(ctx)
      .relay.listModels()
      .some((model) => model.name === input.name)
    return {
      summary: `新建对外模型 ${input.name}（${input.routes.length} 条路由；输入 ${
        Math.round(input.price.inputMicro) / 1_000_000
      } / 输出 ${Math.round(input.price.outputMicro) / 1_000_000} 积分/百万 tokens）`,
      affected: [],
      warnings: [
        ...(existing ? ['同名模型已存在：新建会失败（要用 relay.models.import 加路由）'] : []),
        ...(input.routes.length === 0 ? ['没有路由的模型不可用：至少要一条渠道路由'] : []),
      ],
    }
  },
  async run(ctx, input) {
    const actor = adminActor(ctx)
    return await services(ctx).relay.createModel(input, actor.actorId, ctx.meta)
  },
})

const relayModelsUpdate = defineCapability({
  id: 'relay.models.update',
  area: 'relay',
  title: '修改对外模型',
  description:
    '改对外模型的显示名/价格/可见性/启用/路由（routes 给了就整体替换）/默认思考档位/排序。只改给出的字段，' +
    'preview 给「旧值 → 新值」。价格单独改也可以用 models.price.set。有影响：出方案卡（改路由会立刻影响流量）。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: z.object({
    modelId: z.number().int().positive(),
    patch: UpdateRelayModelRequestSchema,
  }),
  async preview(ctx, args) {
    const current = services(ctx)
      .relay.listModels()
      .find((model) => model.id === args.modelId)
    if (!current)
      throw new HubError('NOT_FOUND', `模型 ${String(args.modelId)} 不存在（先用 models.list kind=relay）`)
    const before = current as unknown as Record<string, unknown>
    const changed = Object.entries(args.patch)
      .filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({ field: key, from: before[key], to: value }))
    return {
      summary: `改对外模型「${current.displayName || current.name}」：${
        changed.length === 0 ? '没有字段变化' : renderDiff(changed)
      }`,
      affected: [{ kind: 'model', id: current.id, label: current.name }],
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        args.patch.routes === undefined ? '' : 'routes 是整体替换：没写进去的原路由会消失',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).relay.updateModel(args.modelId, args.patch, actor.actorId, ctx.meta)
  },
})

const relayModelsDelete = defineCapability({
  id: 'relay.models.delete',
  area: 'relay',
  title: '删除对外模型',
  description:
    '删掉一个对外模型（不可恢复）。用这个模型的用户与容器下次下发会失去它。**敏感**：方案卡要密码。' +
    '只想停用请改 enabled=false（models.price.set 不覆盖它，用 relay.models.update）。先用 models.list kind=relay 核对。',
  risk: 'R3',
  classicPath: '/admin/models',
  input: z.object({ modelId: z.number().int().positive() }),
  async preview(ctx, args) {
    const current = services(ctx)
      .relay.listModels()
      .find((model) => model.id === args.modelId)
    if (!current) throw new HubError('NOT_FOUND', `模型 ${String(args.modelId)} 不存在`)
    return {
      summary: `删除对外模型「${current.displayName || current.name}」（${String(current.routes?.length ?? 0)} 条路由）`,
      affected: [{ kind: 'model', id: current.id, label: current.name }],
      warnings: ['删除不可恢复；用它的人下次下发会失去这个模型', '只想停用请改 enabled=false'],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    services(ctx).relay.deleteModel(args.modelId, actor.actorId, ctx.meta)
    return { modelId: args.modelId, deleted: true }
  },
})

const relayModelsImport = defineCapability({
  id: 'relay.models.import',
  area: 'relay',
  title: '从渠道导入模型',
  description:
    '把一个渠道上的上游模型批量导入成对外模型：同名已存在就只加一条路由，不存在就新建（价格可给，省略 = 未定价）。' +
    '问「把这个渠道的模型都挂上去」用它。先用 relay.channels.test / 经典页面确认上游模型名。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/models',
  input: ImportRelayModelsRequestSchema,
  async preview(ctx, args) {
    const channel = await relayChannelOrThrow(ctx, args.channelId)
    const existing = new Set(
      services(ctx)
        .relay.listModels()
        .map((model) => model.name),
    )
    const creates = args.models.filter((item) => !existing.has(item.name ?? item.upstreamModel))
    return {
      summary: `从渠道「${channel.name}」导入 ${String(args.models.length)} 个模型：新建 ${String(
        creates.length,
      )} 个、给已有模型加路由 ${String(args.models.length - creates.length)} 条`,
      warnings: [
        ...(args.price === undefined ? ['没给 price：新建的模型是「未定价」（0 价），之后要单独定价'] : []),
        '导入只改配置，要下发才进用户容器',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).relay.importModels(args, actor.actorId, ctx.meta)
  },
})

const relayDshUpdate = defineCapability({
  id: 'relay.dsh.update',
  area: 'relay',
  title: '修改「下发到 DSH」的模型路由',
  description:
    '改「模型 → 下发到 DSH」页勾选哪些路由、默认用哪条：routeIds 是路由 id 列表（整体替换），defaultRouteId 是默认路由。' +
    '这决定**所有用户容器**渲染哪些模型，改错了全站模型都不可用。**敏感**：方案卡要密码。' +
    '先用模型页/relay.usage 看现状；勾选完要 rollouts.model 下发才进容器。',
  risk: 'R3',
  classicPath: '/admin/models',
  input: z.object({
    routeIds: z.array(z.number().int().positive()).max(2000).describe('勾选的路由 id（整体替换）'),
    defaultRouteId: z.number().int().positive().nullable().optional().describe('默认路由；null = 清空'),
    platform: z.enum(['cloud', 'desktop']).optional().describe('缺省 cloud（云上实例）'),
  }),
  async preview(ctx, args) {
    const current = await services(ctx).relay.dshResponse(args.platform)
    // 路由挂在每个对外模型下面：`models[].routes[]`，`selected` = 已勾选下发
    const before = {
      routeIds: current.models
        .flatMap((model) => model.routes ?? [])
        .filter((route) => route.selected)
        .map((route) => route.routeId),
      defaultRouteId: current.defaultRouteId,
    }
    const after = { routeIds: args.routeIds, defaultRouteId: args.defaultRouteId ?? before.defaultRouteId }
    const changed = [
      ...(JSON.stringify(before.routeIds) === JSON.stringify(after.routeIds)
        ? []
        : [{ field: 'routeIds', from: before.routeIds.length, to: after.routeIds.length }]),
      ...(before.defaultRouteId === after.defaultRouteId
        ? []
        : [{ field: 'defaultRouteId', from: before.defaultRouteId, to: after.defaultRouteId }]),
    ]
    return {
      summary:
        `改「下发到 DSH」的勾选：${changed.length === 0 ? '没有变化' : renderDiff(changed)}` +
        `（当前勾选 ${String(before.routeIds.length)} 条路由）`,
      warnings: [
        '这一项决定所有用户容器渲染哪些模型：勾错会导致模型不可用',
        '改完还要 rollouts.model 下发，用户容器才会用新配置',
        ...(args.routeIds.length === 0 ? ['一条路由都没勾：用户容器将没有任何可用模型'] : []),
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    const input = UpdateRelayDshRequestSchema.parse({
      routeIds: args.routeIds,
      ...(args.defaultRouteId === undefined ? {} : { defaultRouteId: args.defaultRouteId }),
    })
    return await services(ctx).relay.updateDsh(input, actor.actorId, ctx.meta, args.platform)
  },
})

// ── 中转站：设置 / 钱包 / 用量记录 ──────────────────────────────────────────

/** `relay.settings.update` 的分组白名单：一次改一组，字段显式列出（影响全站计费 → R3） */
const RelaySettingsGroupArgs = z.discriminatedUnion('group', [
  z.object({ group: z.literal('switch'), values: z.object({ enabled: z.boolean() }) }).describe('总开关'),
  z
    .object({
      group: z.literal('bonus'),
      values: z.object({
        signupBonusMicro: z.number().int().min(0),
        dailyBonusMicro: z.number().int().min(0),
      }),
    })
    .describe('注册赠送 / 每日赠送（微积分）'),
  z
    .object({
      group: z.literal('limits'),
      values: z.object({
        defaultMaxConcurrency: z.number().int().min(1).max(64),
        maxAttempts: z.number().int().min(1).max(10),
      }),
    })
    .describe('默认并发 / 换路尝试次数'),
  z
    .object({
      group: z.literal('resilience'),
      values: z.object({
        keyCooldownSeconds: z.number().int().min(1).max(3600),
        channelFailureThreshold: z.number().int().min(1).max(100),
        channelCooldownSeconds: z.number().int().min(1).max(3600),
      }),
    })
    .describe('密钥冷却 / 渠道熔断'),
  z
    .object({
      group: z.literal('retention'),
      values: z.object({ logRetentionDays: z.number().int().min(7).max(3650) }),
    })
    .describe('用量明细保留天数'),
])

const RELAY_GROUP_LABELS: Record<string, string> = {
  switch: '中转站开关',
  bonus: '赠送积分',
  limits: '并发与重试',
  resilience: '冷却与熔断',
  retention: '用量保留',
}

const relaySettingsUpdate = defineCapability({
  id: 'relay.settings.update',
  area: 'relay',
  title: '修改中转站设置（按组）',
  description:
    '按组改中转站设置，一次一组：switch（总开关）、bonus（注册/每日赠送）、limits（默认并发/重试次数）、' +
    'resilience（密钥冷却/渠道熔断）、retention（用量明细保留天数）。preview 给「旧值 → 新值」。' +
    '**影响所有人的计费，敏感**：方案卡要密码。渠道与模型不在这里（用 relay.channels.* / relay.models.*）。',
  risk: 'R3',
  classicPath: '/admin/models',
  input: RelaySettingsGroupArgs,
  async preview(ctx, args) {
    const current = services(ctx).relay.getSettings() as unknown as Record<string, unknown>
    const changed = Object.entries(args.values as Record<string, unknown>)
      .filter(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({ field: key, from: current[key], to: value }))
    return {
      summary: `改${RELAY_GROUP_LABELS[args.group] ?? args.group}：${changed.length === 0 ? '没有字段变化' : renderDiff(changed)}`,
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        ...(args.group === 'switch' && (args.values as { enabled: boolean }).enabled === false
          ? ['关闭后 /v1 一律 503，所有用户的模型请求都会失败']
          : []),
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).relay.updateSettings(args.values, actor.actorId, ctx.meta)
  },
})

const relayWalletsList = defineCapability({
  id: 'relay.wallets.list',
  area: 'relay',
  title: '列出用户钱包',
  description:
    '分页列用户的钱包与消耗：余额、计费倍率、并发上限、日上限、累计消费、今日/本月消耗。' +
    '问「谁余额快没了」「谁这个月花得最多」用它（也可以按用量排名用 relay.usage）。' +
    '充值/扣减用 users.wallet.grant。返回 {rows,total}。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/models',
  input: RelayWalletListQuerySchema,
  async run(ctx, query) {
    const page = services(ctx).relay.listWallets({
      ...query,
      pageSize: Math.max(1, Math.min(100, query.pageSize)),
    })
    return { total: page.total, page: page.page, pageSize: page.pageSize, rows: page.items }
  },
})

const relayUsageLogs = defineCapability({
  id: 'relay.usage.logs',
  area: 'relay',
  title: '逐条用量记录',
  description:
    '分页查逐条中转站请求记录：时间、用户、模型、渠道、状态、tokens、积分、耗时、来源（含 cockpit）。' +
    '排障「某个请求为什么失败/为什么扣了这么多」用它；看趋势与排名用 relay.usage（聚合）。' +
    '默认近 30 天，按时间倒序，页大小 ≤100。返回 {rows,total}。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/relay/usage',
  input: RelayUsageLogQuerySchema,
  async run(ctx, query) {
    const page = services(ctx).relay.usageLogs(
      { ...query, pageSize: Math.max(1, Math.min(100, query.pageSize)) },
      { scope: 'admin' },
    )
    return { total: page.total, page: page.page, pageSize: page.pageSize, rows: page.items }
  },
})

// ── 网络代理 ────────────────────────────────────────────────────────────────

// ── 搜索 / 抓取池 ───────────────────────────────────────────────────────────

const searchUsage = defineCapability({
  id: 'search.usage',
  area: 'search',
  title: '搜索池逐次用量',
  description:
    '分页查搜索/抓取的逐条调用记录：时间、用户、工具（search/fetch）、渠道、是否免费、扣费、耗时、状态与错误。' +
    '问「谁在猛刷搜索」「为什么这次抓取失败」用它。看汇总（本月次数/营收）用 search.pools。返回 {rows,total}。',
  risk: 'R0',
  dataSource: true,
  classicPath: '/admin/search',
  input: ToolUsageQuerySchema,
  async run(ctx, query) {
    const page = services(ctx).relay.tools.usageList(
      { ...query, pageSize: Math.max(1, Math.min(100, query.pageSize)) },
      { scope: 'admin' },
    )
    return { total: page.total, page: page.page, pageSize: page.pageSize, rows: page.items }
  },
})

const searchChannelsUpsert = defineCapability({
  id: 'search.channels.upsert',
  area: 'search',
  title: '新建或修改搜索渠道',
  description:
    '新建搜索/抓取渠道（kind + 名称 + 可选地址/工具/优先级/成本），或修改已有渠道（channelId + 任意字段）。' +
    '新建时要带密钥用 search.channels.keys（走密钥卡），这里不收明文密钥。' +
    '先用 search.pools 看现有渠道。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/search',
  input: z.object({
    channelId: z.number().int().positive().optional().describe('省略 = 新建；给了 = 修改'),
    kind: z.enum(['tavily', 'deepseek', 'custom']).optional().describe('渠道类型（新建必填）'),
    name: z.string().trim().min(1).max(64).optional().describe('渠道名（新建必填）'),
    baseUrl: z.string().url().optional(),
    tools: z
      .array(z.enum(['search', 'fetch']))
      .min(1)
      .optional(),
    priority: z.number().int().optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    proxyUrl: z.string().url().nullable().optional(),
    searchCostMicro: z.number().int().min(0).optional(),
    fetchCostMicro: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(500).optional(),
  }),
  async preview(ctx, args) {
    const channels = services(ctx).relay.tools.listChannels()
    if (args.channelId === undefined) {
      if (args.kind === undefined || args.name === undefined) {
        throw new HubError('VALIDATION_FAILED', '新建搜索渠道必须给 kind 与 name')
      }
      return {
        summary: `新建搜索渠道「${args.name}」（${args.kind}；现有 ${String(channels.length)} 个渠道）`,
        warnings: ['新渠道没有密钥：要用 search.channels.keys 加一把（走密钥卡）'],
      }
    }
    const current = channels.find((item) => item.id === args.channelId)
    if (!current) throw new HubError('NOT_FOUND', `搜索渠道 ${String(args.channelId)} 不存在`)
    const before = current as unknown as Record<string, unknown>
    const changed = Object.entries(args)
      .filter(([key, value]) => key !== 'channelId' && JSON.stringify(before[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({ field: key, from: before[key], to: value }))
    return {
      summary: `改搜索渠道「${current.name}」：${changed.length === 0 ? '没有字段变化' : renderDiff(changed)}`,
      warnings: changed.length === 0 ? ['没有字段真的变化'] : [],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    if (args.channelId === undefined) {
      return services(ctx).relay.tools.createChannel(
        CreateToolChannelRequestSchema.parse({
          kind: args.kind,
          name: args.name,
          ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
          ...(args.tools === undefined ? {} : { tools: args.tools }),
          ...(args.priority === undefined ? {} : { priority: args.priority }),
          ...(args.weight === undefined ? {} : { weight: args.weight }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          ...(args.proxyUrl === undefined ? {} : { proxyUrl: args.proxyUrl }),
          ...(args.searchCostMicro === undefined ? {} : { searchCostMicro: args.searchCostMicro }),
          ...(args.fetchCostMicro === undefined ? {} : { fetchCostMicro: args.fetchCostMicro }),
          ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
          ...(args.note === undefined ? {} : { note: args.note }),
        }),
        actor.actorId,
        ctx.meta,
      )
    }
    const { channelId, kind: _kind, ...rest } = args
    return services(ctx).relay.tools.updateChannel(
      channelId,
      UpdateToolChannelRequestSchema.parse(rest),
      actor.actorId,
      ctx.meta,
    )
  },
})

const searchChannelsDelete = defineCapability({
  id: 'search.channels.delete',
  area: 'search',
  title: '删除搜索渠道',
  description:
    '删掉一个搜索/抓取渠道（连同它的密钥与冷却状态；不可恢复）。如果它是唯一可用渠道，搜索会全挂。' +
    '**敏感**：方案卡要密码。只想停用请改 enabled=false（search.channels.upsert）。先用 search.pools 核对。',
  risk: 'R3',
  classicPath: '/admin/search',
  input: z.object({ channelId: z.number().int().positive() }),
  async preview(ctx, args) {
    const channels = services(ctx).relay.tools.listChannels()
    const current = channels.find((item) => item.id === args.channelId)
    if (!current) throw new HubError('NOT_FOUND', `搜索渠道 ${String(args.channelId)} 不存在`)
    const enabledOthers = channels.filter((item) => item.id !== current.id && item.enabled).length
    return {
      summary: `删除搜索渠道「${current.name}」（${String(current.keys.length)} 把密钥；其它启用渠道 ${String(
        enabledOthers,
      )} 个）`,
      affected: [],
      warnings: [
        enabledOthers === 0 ? '这是最后一个启用渠道：删完搜索/抓取会全部失败' : '',
        '删除不可恢复',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    services(ctx).relay.tools.deleteChannel(args.channelId, actor.actorId, ctx.meta)
    return { channelId: args.channelId, deleted: true }
  },
})

const searchChannelsKeys = defineCapability({
  id: 'search.channels.keys',
  area: 'search',
  title: '给搜索渠道加密钥',
  description:
    '给搜索渠道追加一把密钥。**密钥不能写在对话里**：先 secret_request(purpose=「Tavily/搜索池 key」, ' +
    'capability=search.channels.keys, field=apiKey)，把返回的 sec_… 填进 apiKey。' +
    '同渠道重复的密钥会被跳过。有影响：出方案卡（密钥入库后立刻参与分流）。',
  risk: 'R2',
  classicPath: '/admin/search',
  secretFields: ['apiKey'],
  input: z.object({
    channelId: z.number().int().positive(),
    apiKey: z.string().describe('只能填 secret_request 拿到的 sec_… 引用，不接受明文'),
    label: z.string().max(64).default('').describe('备注（例如「主账号」）'),
  }),
  async preview(ctx, args) {
    const channels = services(ctx).relay.tools.listChannels()
    const current = channels.find((item) => item.id === args.channelId)
    if (!current) throw new HubError('NOT_FOUND', `搜索渠道 ${String(args.channelId)} 不存在`)
    return {
      summary: `给搜索渠道「${current.name}」加 1 把密钥（当前 ${String(current.keys.length)} 把）${
        args.label ? `，备注 ${args.label}` : ''
      }`,
      warnings: ['新密钥会立刻参与分流（上游额度/限流由它自己承担）'],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return services(ctx).relay.tools.addChannelKeys(
      args.channelId,
      { keys: [args.apiKey], label: args.label },
      actor.actorId,
      ctx.meta,
    )
  },
})

const searchChannelsKeyDelete = defineCapability({
  id: 'search.channels.key.delete',
  area: 'search',
  title: '删除搜索渠道密钥',
  description:
    '从搜索渠道里删掉一把密钥（不可恢复；只剩末四位与 id 可核对）。临时故障先停用（经典页面），确认作废了才删。' +
    'keyId 从 search.pools 的密钥列表或经典页面拿。有影响：出方案卡。',
  risk: 'R2',
  classicPath: '/admin/search',
  input: z.object({
    channelId: z.number().int().positive(),
    keyId: z.number().int().positive(),
  }),
  async preview(ctx, args) {
    const channels = services(ctx).relay.tools.listChannels()
    const current = channels.find((item) => item.id === args.channelId)
    if (!current) throw new HubError('NOT_FOUND', `搜索渠道 ${String(args.channelId)} 不存在`)
    const key = current.keys.find((item) => item.id === args.keyId)
    if (!key) throw new HubError('NOT_FOUND', `渠道 ${String(args.channelId)} 没有密钥 ${String(args.keyId)}`)
    return {
      summary: `删除搜索渠道「${current.name}」的密钥 …${key.last4}（当前 ${key.state}）`,
      warnings: [
        '删除不可恢复',
        current.keys.length <= 1 ? '这是该渠道最后一把密钥：删完这个渠道就用不了了' : '',
      ].filter((line) => line.length > 0),
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    services(ctx).relay.tools.deleteChannelKey(args.channelId, args.keyId, actor.actorId, ctx.meta)
    return { channelId: args.channelId, keyId: args.keyId, deleted: true }
  },
})

const searchChannelsTest = defineCapability({
  id: 'search.channels.test',
  area: 'search',
  title: '测搜索渠道',
  description:
    '用渠道里的密钥向上游发一次最小请求（Tavily 走 search、DeepSeek 走 search），给出 ok / 耗时 / 错误 / 剩余额度。' +
    '问「这个搜索 key 还有额度吗」用它。会真的打上游并消耗一次调用（可逆），最多等 30 秒。',
  risk: 'R1',
  classicPath: '/admin/search',
  input: z.object({ channelId: z.number().int().positive() }),
  async preview(ctx, args) {
    const channels = services(ctx).relay.tools.listChannels()
    const current = channels.find((item) => item.id === args.channelId)
    if (!current) throw new HubError('NOT_FOUND', `搜索渠道 ${String(args.channelId)} 不存在`)
    return {
      summary: `测搜索渠道「${current.name}」（${String(current.keys.length)} 把密钥，打一次上游）`,
      warnings: ['会消耗一次上游调用（可能计入额度）'],
    }
  },
  async run(ctx, args) {
    return await services(ctx).relay.tools.testChannel(args.channelId)
  },
})

/** `search.settings.update` 的分组白名单（影响所有人的计费 → R3） */
const SearchSettingsGroupArgs = z.discriminatedUnion('group', [
  z
    .object({
      group: z.literal('switch'),
      values: z.object({ enabled: z.boolean(), deliverToDsh: z.boolean() }),
    })
    .describe('总开关 / 是否下发到用户 DSH'),
  z
    .object({
      group: z.literal('pricing'),
      values: z.object({
        freeCallsPerMonth: z.number().int().min(0).max(100_000),
        searchPriceMicro: z.number().int().min(0),
        fetchPriceMicro: z.number().int().min(0),
      }),
    })
    .describe('每月免费次数 / 单次价格'),
  z
    .object({
      group: z.literal('limits'),
      values: z.object({
        perUserPerMinute: z.number().int().min(1).max(600),
        maxAttempts: z.number().int().min(1).max(10),
        keyCooldownSeconds: z.number().int().min(1).max(3600),
      }),
    })
    .describe('限流 / 重试 / 冷却'),
])

const searchSettingsUpdate = defineCapability({
  id: 'search.settings.update',
  area: 'search',
  title: '修改搜索池设置（按组）',
  description:
    '按组改搜索/抓取池设置，一次一组：switch（总开关/是否下发到 DSH）、pricing（每月免费次数/单次价格）、' +
    'limits（每用户每分钟上限/重试/冷却）。preview 给「旧值 → 新值」。**影响所有人的计费，敏感**：方案卡要密码。' +
    '改完有的项要重新下发才进用户容器（deliverToDsh）。',
  risk: 'R3',
  classicPath: '/admin/search',
  input: SearchSettingsGroupArgs,
  async preview(ctx, args) {
    const current = services(ctx).relay.tools.getSettings() as unknown as Record<string, unknown>
    const changed = Object.entries(args.values as Record<string, unknown>)
      .filter(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({ field: key, from: current[key], to: value }))
    return {
      summary: `改搜索池 ${args.group}：${changed.length === 0 ? '没有字段变化' : renderDiff(changed)}`,
      warnings: [
        ...(changed.length === 0 ? ['没有字段真的变化'] : []),
        '这一组对所有用户生效；价格改动对之后的调用生效',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return services(ctx).relay.tools.updateSettings(args.values, actor.actorId, ctx.meta)
  },
})

export const RELAY_CAPABILITIES = [
  relayChannelsDelete,
  relayChannelsTest,
  relayChannelsKeyUpdate,
  relayChannelsKeyDelete,
  relayModelsCreate,
  relayModelsUpdate,
  relayModelsDelete,
  relayModelsImport,
  relayDshUpdate,
  relaySettingsUpdate,
  relayWalletsList,
  relayUsageLogs,
  searchUsage,
  searchChannelsUpsert,
  searchChannelsDelete,
  searchChannelsKeys,
  searchChannelsKeyDelete,
  searchChannelsTest,
  searchSettingsUpdate,
] as const
