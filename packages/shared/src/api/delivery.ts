import { z } from 'zod'
import type { ContractEntry } from '../contract-map.js'
import { RoleSchema, StrategySchema } from '../common.js'
import { JobRefSchema } from './jobs.js'

/**
 * 统一下发（docs/21）：管理员在一个入口里同时面向「实例」（Docker 容器里的 DSH）与「桌面端」
 * （用户自己电脑上的 DSH Hub 桌面端）下发插件与模型/API 配置，目标可以选「已安装用户」，一次可选多个插件。
 *
 * 与旧接口的关系：`POST /api/admin/rollouts` 与 `/api/admin/desktop/*` 的既有接口**保持不变**（向后兼容），
 * 统一下发是新增的编排层：实例侧复用 rollouts 的任务引擎，桌面侧复用 desktop-delivery 的清单服务。
 */

/** 下发面向的平台；可同时选两个 */
export const DeliveryPlatformSchema = z.enum(['instance', 'desktop'])
export type DeliveryPlatform = z.infer<typeof DeliveryPlatformSchema>

/** 一次最多多少个内容项（防止一个请求拖垮任务引擎） */
export const DELIVERY_MAX_ITEMS = 20

/**
 * 内容项。
 * - `plugin`：`versionId` = **云上**版本；`desktopVersionId` = **桌面**版本（docs/22 §2.2，各自缺省 = 该平台最新）。
 *   桌面端只认桌面版本（必须有整包），云上只认云上版本；`uninstall` 动作忽略版本。
 * - `models`：模型与 API（渠道）配置。实例侧 = 既有「模型配置」下发（按「模型 → 下发到 DSH」重渲染并按需重启）；
 *   桌面侧 = 把 `llm-pi-ai` 与 `agent-default-model` 两个配置片段按**桌面**系统预设（或 `presetId`）更新到目标。
 * - `runtime`：DSH 版本升级，只对实例有效（桌面端的版本走「桌面端 → 版本与升级」）。
 */
export const DeliveryItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('plugin'),
    pluginId: z.number().int().positive(),
    /** 云上版本；缺省 = 云上最新版本 */
    versionId: z.number().int().positive().optional(),
    /** 桌面版本（docs/22 §2.2）；缺省 = 桌面最新版本。不给 = 桌面侧也取自己的最新 */
    desktopVersionId: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('models'),
    presetId: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('runtime'),
    runtimeId: z.number().int().positive(),
  }),
])
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>

/** 动作；`apply-config` 只对 `models` 有意义，`runtime` 只有「升级」一种（动作忽略） */
export const DeliveryActionSchema = z.enum(['install', 'upgrade', 'uninstall', 'apply-config'])
export type DeliveryAction = z.infer<typeof DeliveryActionSchema>

/**
 * 下发给谁：
 * - `all`：所有（对应平台上的）用户；
 * - `users`：指定用户（`userIds`）；
 * - `role`：某个角色的全部用户；
 * - `installed`：**已安装用户**。每个内容项各自解析：
 *     · `plugin`：已安装这个插件的用户（实例：`user_plugins` 期望状态为已安装；桌面：设备上报的插件清单里有它）。
 *       `outdatedOnly=true` 时只取版本低于本次要下发版本的（升级场景），默认 false；
 *     · `models`：已经在用 Hub 模型配置的用户（实例：容器已渲染过 Hub 路由；桌面：已登录的设备）；
 *     · `runtime`：不支持 `installed`（用 `all` / `users`）。
 *   「已安装」的解析发生在提交那一刻，结果落成明确的用户清单写进任务与审计，之后新装的用户不会被追加。
 */
export const DeliveryTargetsSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({ mode: z.literal('users'), userIds: z.array(z.number().int().positive()).min(1).max(500) }),
  z.strictObject({ mode: z.literal('role'), role: RoleSchema }),
  z.strictObject({ mode: z.literal('installed'), outdatedOnly: z.boolean().default(false) }),
])
export type DeliveryTargets = z.infer<typeof DeliveryTargetsSchema>

export const DeliveryRequestSchema = z
  .strictObject({
    platforms: z.array(DeliveryPlatformSchema).min(1).max(2),
    items: z.array(DeliveryItemSchema).min(1).max(DELIVERY_MAX_ITEMS),
    action: DeliveryActionSchema,
    targets: DeliveryTargetsSchema,
    /** 只影响实例侧（并发、金丝雀、失败比例、何时重启）；桌面侧按设备心跳拉取，忽略此项 */
    strategy: StrategySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const kinds = new Set(value.items.map((item) => item.kind))
    if (kinds.has('runtime') && value.platforms.includes('desktop') && !value.platforms.includes('instance')) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'DSH 版本只能下发给实例' })
    }
    if (kinds.has('runtime') && value.targets.mode === 'installed') {
      ctx.addIssue({ code: 'custom', path: ['targets'], message: 'DSH 版本不支持「已安装用户」' })
    }
    if (value.action === 'apply-config' && [...kinds].some((kind) => kind !== 'models')) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: '「仅应用配置」只能用于模型与 API 配置' })
    }
    if (value.action === 'uninstall' && kinds.has('models')) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: '模型与 API 配置不能卸载' })
    }
  })
export type DeliveryRequest = z.infer<typeof DeliveryRequestSchema>

/** 因预检不满足而**整项**跳过的内容项（预览与提交同一形状） */
export const DeliverySkippedItemSchema = z.object({
  itemLabel: z.string(),
  platform: DeliveryPlatformSchema,
  reason: z.string(),
})
export type DeliverySkippedItem = z.infer<typeof DeliverySkippedItemSchema>

/** 预览里的一行：一个内容项 × 一个用户（桌面侧带设备） */
export const DeliveryPreviewRowSchema = z.object({
  platform: DeliveryPlatformSchema,
  userId: z.number().int(),
  username: z.string(),
  /** 仅桌面侧：这一行对应的设备（一个用户多台设备时一台一行） */
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  /** 内容项的可读名称，如「dsh-memory 0.3.1」「模型与 API 配置」「DSH 0.2.1-rc.2」 */
  itemLabel: z.string(),
  /** 当前状态，如 `0.2.0` / `未安装` / `未配置` */
  current: z.string(),
  /** 执行后的期望状态 */
  after: z.string(),
  /** 实例侧：这一步会不会重启用户的 DSH；桌面侧：是否需要用户重启桌面端才生效 */
  needsRestart: z.boolean(),
  /** 这一行不会执行的原因（如「已是该版本」「用户未启用」「设备已吊销」）；null = 会执行 */
  skipReason: z.string().nullable(),
})
export type DeliveryPreviewRow = z.infer<typeof DeliveryPreviewRowSchema>

export const DeliveryPreviewResponseSchema = z.object({
  rows: z.array(DeliveryPreviewRowSchema),
  /** 各平台实际会执行的行数 / 跳过的行数 */
  summary: z.object({
    instance: z.object({ willRun: z.number().int(), skipped: z.number().int(), users: z.number().int() }),
    desktop: z.object({ willRun: z.number().int(), skipped: z.number().int(), users: z.number().int(), devices: z.number().int() }),
  }),
  /** 面向管理员的警告（如「该插件没有桌面整包，桌面端拿不到」「所选内容项在实例平台不适用」） */
  warnings: z.array(z.string()),
  /** 预览结果是否被截断（行数上限 2000；截断后仍按完整清单执行） */
  truncated: z.boolean(),
  /**
   * 整项被预检跳过（「该插件不在桌面插件库」「还没有上传桌面整包」…），与 `POST /api/admin/deliveries`
   * 响应里的 `skippedItems` 同一形状、同一口径 —— 预览就能看到提交时会出现哪些跳过。
   */
  skippedItems: z.array(DeliverySkippedItemSchema).optional(),
})
export type DeliveryPreviewResponse = z.infer<typeof DeliveryPreviewResponseSchema>

/** 提交结果：实例侧每个内容项一个任务；桌面侧一次提交只生成一个新的清单版本 */
export const DeliveryCreatedResponseSchema = z.object({
  jobs: z.array(
    JobRefSchema.extend({
      itemLabel: z.string(),
    }),
  ),
  desktop: z
    .object({
      /** 本次提交后的清单版本；没有桌面侧内容时为 null */
      revision: z.number().int().nullable(),
      users: z.number().int(),
      devices: z.number().int(),
    })
    .nullable(),
  /** 因预检不满足而整项跳过的内容项（如「桌面端缺整包」），不影响其它项 */
  skippedItems: z.array(DeliverySkippedItemSchema),
})
export type DeliveryCreatedResponse = z.infer<typeof DeliveryCreatedResponseSchema>

/** 每个插件的安装情况：插件库列表的「已安装」列与批量下发向导的目标人数提示用 */
export const PluginInstallStatSchema = z.object({
  pluginId: z.number().int(),
  /** 实例侧：期望状态为已安装的用户数 / 其中版本低于**云上最新版本**的人数 */
  instance: z.object({ users: z.number().int(), outdated: z.number().int() }),
  /**
   * 桌面侧：上报里有这个插件的设备数 / 用户数 / 其中版本低于**桌面最新版本**的设备数
   * （docs/22 §2.1 起两平台版本独立，用云上最新判桌面旧是错的）。
   */
  desktop: z.object({
    devices: z.number().int(),
    users: z.number().int(),
    outdated: z.number().int(),
    /** 上报 `source=bundled`（客户端自带）的设备数（docs/22 §4.2 的「内置」徽标）；后端总会给 */
    bundledDevices: z.number().int().optional(),
  }),
  /** 云上最新版本（实例侧的「旧」按它算）；没有云上版本 = null */
  latestVersion: z.string().nullable(),
  /** 桌面最新版本（桌面侧的「旧」按它算）；没有桌面版本 = null。后端总会给 */
  desktopLatestVersion: z.string().nullable().optional(),
})
export type PluginInstallStat = z.infer<typeof PluginInstallStatSchema>

export const PluginInstallStatsResponseSchema = z.object({ items: z.array(PluginInstallStatSchema) })
export type PluginInstallStatsResponse = z.infer<typeof PluginInstallStatsResponseSchema>

/**
 * 从插件库页跳到统一下发向导时的预填约定（前端两边共用，写在 URL 查询串里，不经过后端）：
 * `/admin/rollouts?platforms=instance,desktop&action=upgrade&targets=installed&items=plugin:12,plugin:15:345`
 * - `items`：逗号分隔，每项 `plugin:<pluginId>[:<versionId>]` | `models[:<presetId>]` | `runtime:<runtimeId>`；
 * - `targets`：`all` | `installed` | `installed-outdated`；
 * - 其它字段缺省时向导用自己的默认值，用户可在向导里改。
 */
export const DELIVERY_PREFILL_QUERY_KEYS = ['platforms', 'action', 'targets', 'items'] as const

export const DELIVERY_CONTRACT_MAP: ContractEntry[] = [
  {
    method: 'POST',
    path: '/api/admin/deliveries/preview',
    request: 'DeliveryRequestSchema',
    response: 'DeliveryPreviewResponseSchema',
    note: '管理员；只读，不改任何状态；「已安装」在这里解析',
  },
  {
    method: 'POST',
    path: '/api/admin/deliveries',
    request: 'DeliveryRequestSchema',
    response: 'DeliveryCreatedResponseSchema',
    note: '202；需要二次密码；审计 delivery.create；实例侧每个内容项一个 job，桌面侧一次一个 revision',
  },
  {
    method: 'GET',
    path: '/api/admin/plugins/install-stats',
    response: 'PluginInstallStatsResponseSchema',
    note: '管理员；每个插件在实例与桌面端的安装人数',
  },
]
