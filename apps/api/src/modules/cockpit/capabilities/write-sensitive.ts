import { z } from 'zod'
import {
  CreateRelayChannelRequestSchema,
  DESKTOP_BATCH_REVOKE_MAX,
  ModelApiSchema,
  RelayChannelSlugSchema,
  RelayScopeSchema,
  UpdateRelayChannelRequestSchema,
  UsernameSchema,
} from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import { defineCapability } from './define.js'
import type { CapabilityContext } from './types.js'
import { adminActor } from './write.js'

/**
 * R3（敏感）能力（WP56e1）：docs/24 §4 里未标 ★ 的那四条。
 *
 * **带 `secretFields` 的能力**（`relay.channels.upsert` 的渠道密钥）只能通过密钥卡给值：
 * 参数里只接受 `sec_…` 引用（明文一律 400，由 service.ts 的
 * `assertSecretArgs` 在执行前拦下）。因此：
 * - `preview` 里拿到的是**引用号**，不能、也不该把它写进影响面文案；
 * - `run` 里拿到的是**明文**（Hub 解引用并「用完即删」），能力自己负责把它交给 service。
 */

function services(ctx: CapabilityContext) {
  return ctx.deps.services
}

// ── 中转站渠道：新建 / 修改 / 追加密钥 ──────────────────────────────────────

/** 渠道写参数的「可生成 JSON Schema」版本（create 与 update 合一，必填项在 preview/run 里各自校验） */
const ChannelUpsertArgsSchema = z.object({
  channelId: z.number().int().positive().optional().describe('省略 = 新建渠道；给了 = 修改这个渠道'),
  name: z.string().trim().min(1).max(64).optional().describe('显示名（新建必填）'),
  slug: z.string().trim().min(1).max(32).optional().describe('对用户可见的渠道标识（省略 = 按名字生成）'),
  baseUrl: z.string().trim().min(1).max(500).optional().describe('上游地址（新建必填）'),
  apis: z
    .array(ModelApiSchema)
    .min(1)
    .optional()
    .describe('支持的协议（新建必填）：openai-chat / anthropic-messages / openai-responses'),
  ratePermille: z.number().int().min(0).max(100_000).optional().describe('渠道倍率（千分比，1000 = 原价）'),
  priority: z.number().int().min(-100).max(100).optional(),
  weight: z.number().int().min(1).max(100).optional(),
  maxConcurrency: z.number().int().min(0).max(1000).optional().describe('并发上限，0 = 不限'),
  timeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
  proxyUrl: z.string().trim().max(500).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional().describe('额外请求头（不能含鉴权头）'),
  streamUsage: z.boolean().optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(500).optional(),
  scope: RelayScopeSchema.optional().describe('仅新建时有效：dsh / claude-code / codex'),
  apiKey: z
    .string()
    .optional()
    .describe(
      '渠道密钥：**只能**填 secret_request 拿到的 sec_… 引用，不接受明文（新建时会给渠道登记这把密钥）',
    ),
})

type ChannelUpsertArgs = z.infer<typeof ChannelUpsertArgsSchema>

const RELAY_CHANNELS_UPSERT = 'relay.channels.upsert'

const relayChannelsUpsert = defineCapability({
  id: RELAY_CHANNELS_UPSERT,
  area: 'relay',
  title: '新建或修改中转站渠道',
  description:
    '新建一个中转站渠道（name + baseUrl + apis），或修改已有渠道（channelId + 任意字段）；也可以只给已有渠道' +
    '追加一把密钥。**密钥不能写在对话里**：先 secret_request(purpose=「新渠道的 API Key」, ' +
    'capability=relay.channels.upsert, field=apiKey)，管理员在密钥卡填好后把返回的 sec_… 引用填进 apiKey。' +
    '先用 relay.channels.list 查 channelId 与现有配置。敏感操作：方案卡要求再输一次密码。',
  risk: 'R3',
  classicPath: '/admin/models',
  secretFields: ['apiKey'],
  input: ChannelUpsertArgsSchema,
  async preview(ctx, args) {
    const patch = channelPatchOf(args)
    if (args.channelId === undefined) {
      if (args.name === undefined || args.baseUrl === undefined || args.apis === undefined) {
        throw new HubError('VALIDATION_FAILED', '新建渠道必须给 name、baseUrl、apis')
      }
      return {
        summary:
          `新建中转站渠道「${args.name}」（${args.baseUrl}；协议 ${args.apis.join('、')}` +
          `${args.ratePermille === undefined ? '' : `；倍率 ${String(args.ratePermille / 10)}%`}）` +
          `${args.apiKey === undefined ? '，不加密钥（之后可单独追加）' : '，并登记 1 把密钥'}`,
        warnings: ['新渠道要真的接上请求，还需要把模型路由指到它（经典页面「模型与价格」）'],
      }
    }
    const channel = await requireChannel(ctx, args.channelId)
    const fields = Object.keys(patch)
    return {
      summary:
        `修改渠道「${channel.name}」：${fields.length === 0 ? '没有字段变化' : fields.join('、')}` +
        `${args.apiKey === undefined ? '' : '；追加 1 把密钥'}`,
      warnings: [
        ...(fields.length === 0 && args.apiKey === undefined ? ['这一步什么也不会改变'] : []),
        '改地址/协议会立即影响正在走这条渠道的请求',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    const patch = channelPatchOf(args)
    if (args.channelId === undefined) {
      if (args.name === undefined || args.baseUrl === undefined || args.apis === undefined) {
        throw new HubError('VALIDATION_FAILED', '新建渠道必须给 name、baseUrl、apis')
      }
      const request = CreateRelayChannelRequestSchema.parse({
        name: args.name,
        baseUrl: args.baseUrl,
        apis: args.apis,
        ...patch,
        ...(args.slug === undefined ? {} : { slug: RelayChannelSlugSchema.parse(args.slug) }),
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        keys: args.apiKey === undefined ? [] : [args.apiKey],
      })
      return await services(ctx).relay.createChannel(request, actor.actorId, ctx.meta)
    }
    await requireChannel(ctx, args.channelId)
    const updated =
      Object.keys(patch).length === 0
        ? await requireChannel(ctx, args.channelId)
        : await services(ctx).relay.updateChannel(
            args.channelId,
            UpdateRelayChannelRequestSchema.parse(patch),
            actor.actorId,
            ctx.meta,
          )
    if (args.apiKey === undefined) return updated
    const added = await services(ctx).relay.addChannelKeys(
      args.channelId,
      { keys: [args.apiKey], label: '' },
      actor.actorId,
      ctx.meta,
    )
    return added
  },
})

/** 从入参里挑出「渠道本身」的字段（密钥、scope、channelId 单独处理） */
function channelPatchOf(args: ChannelUpsertArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of [
    'name',
    'baseUrl',
    'apis',
    'ratePermille',
    'priority',
    'weight',
    'maxConcurrency',
    'timeoutMs',
    'proxyUrl',
    'headers',
    'streamUsage',
    'enabled',
    'note',
  ] as const) {
    const value = args[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

async function requireChannel(
  ctx: CapabilityContext,
  channelId: number,
): Promise<{ id: number; name: string }> {
  const channel = services(ctx)
    .relay.listChannels()
    .find((item) => item.id === channelId)
  if (!channel)
    throw new HubError('NOT_FOUND', `渠道 ${String(channelId)} 不存在（先用 relay.channels.list 查）`)
  return { id: channel.id, name: channel.name }
}

// ── 批量吊销设备 ────────────────────────────────────────────────────────────

const desktopDevicesRevokeBulk = defineCapability({
  id: 'desktop.devices.revoke-bulk',
  area: 'desktop',
  title: '批量吊销设备',
  description:
    `一次吊销多台设备（最多 ${String(DESKTOP_BATCH_REVOKE_MAX)} 台）：逐台独立处理，结果里每台一条` +
    '（revoked / already_revoked / not_found / failed）。**敏感操作**：方案卡要求管理员再输一次密码。' +
    '这是处置「设备丢了 / 被人捡到」的批量手段；只吊销一台用 desktop.devices.revoke（R2）就够。',
  risk: 'R3',
  classicPath: '/admin/instances',
  input: z.object({
    deviceIds: z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(DESKTOP_BATCH_REVOKE_MAX)
      .describe('要吊销的设备标识列表（list 能力返回的 deviceId）'),
  }),
  async preview(ctx, args) {
    const rows = await Promise.all(
      [...new Set(args.deviceIds)].map(async (deviceId) => {
        try {
          const detail = await services(ctx).desktop.detail(deviceId)
          return {
            deviceId,
            label: `${detail.user.username} · ${detail.device.name}`,
            active: detail.device.revokedAt === null,
          }
        } catch {
          return { deviceId, label: '（设备不存在）', active: false }
        }
      }),
    )
    const active = rows.filter((row) => row.active).length
    return {
      summary: `批量吊销 ${String(rows.length)} 台设备（其中 ${String(active)} 台当前有效，其余会被跳过）`,
      affected: rows.map((row) => ({ kind: 'device' as const, id: row.deviceId, label: row.label })),
      warnings: ['被吊销的设备令牌与密钥立即失效，用户要重新登录授权', '这一条需要管理员再输入一次密码'],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    return await services(ctx).desktop.batchRevoke(args.deviceIds, actor.actorId, ctx.meta)
  },
})

// ── 恢复回收站里的用户 ──────────────────────────────────────────────────────

const usersRestore = defineCapability({
  id: 'users.restore',
  area: 'users',
  title: '恢复已删除用户',
  description:
    '把 7 天内删除的用户从回收站恢复：原名可用就用原名（也可显式给 username 换一个），数据目录从 trash/ 带回，' +
    '状态回到删除前的状态。userId 是回收站里那条记录 id。敏感操作：方案卡要求再输一次密码。' +
    '删除用户用 users.delete；彻底删除只能去经典页面。',
  risk: 'R3',
  classicPath: '/admin/users',
  input: z.object({
    userId: z.number().int().positive().describe('回收站记录的 id（已删除用户的 userId）'),
    username: z.string().max(64).optional().describe('恢复成哪个用户名；省略 = 用删除时的用户名'),
  }),
  async preview(ctx, args) {
    const item = await findDeletedUser(ctx, args.userId)
    return {
      summary:
        `从回收站恢复 ${item.username}（删除于 ${item.deletedAt}，还剩 ${String(item.daysLeft)} 天可恢复）` +
        `${args.username === undefined ? '' : `，恢复后用户名 ${args.username}`}`,
      affected: [{ kind: 'user', id: item.id, label: `用户 ${item.username}` }],
      warnings: [
        ...(item.dataInTrash ? ['数据目录会从 trash/ 带回来'] : ['数据目录已不在 trash/：恢复后只有账号']),
        '恢复后状态是删除前的状态（不会是 active，除非删除前就是）',
      ],
    }
  },
  async run(ctx, args) {
    const actor = adminActor(ctx)
    const input = args.username === undefined ? {} : { username: UsernameSchema.parse(args.username) }
    return await services(ctx).adminUsers.restoreUser(args.userId, input, actor)
  },
})

/** 在回收站里找一条（最多翻 5 页 500 条；找不到就是 NOT_FOUND，不让模型瞎猜 id） */
async function findDeletedUser(
  ctx: CapabilityContext,
  userId: number,
): Promise<{
  id: number
  username: string
  deletedAt: string
  daysLeft: number
  dataInTrash: boolean
}> {
  for (let page = 1; page <= 5; page += 1) {
    const result = await services(ctx).adminUsers.listDeletedUsers({ page, pageSize: 100 })
    const found = result.items.find((item) => item.id === userId)
    if (found) return found
    if (result.items.length < 100) break
  }
  throw new HubError(
    'NOT_FOUND',
    `回收站里没有 userId=${String(userId)}（可能已彻底删除或超过 7 天）：经典页面「用户 → 回收站」可核对`,
  )
}

/** 全部 R3 能力（docs/24 §4 未标 ★ 的四条） */
export const SENSITIVE_CAPABILITIES = [
  relayChannelsUpsert,
  desktopDevicesRevokeBulk,
  usersRestore,
] as const
