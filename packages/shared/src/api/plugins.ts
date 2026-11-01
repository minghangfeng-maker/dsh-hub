import { z } from 'zod'
import type { ContractEntry } from '../contract-map.js'
import {
  BooleanQuerySchema,
  IsoDateTimeSchema,
  PlatformQuerySchema,
  PlatformSchema,
  UserRefSchema,
  UserStatusSchema,
  type Platform,
} from '../common.js'
import { JobRefSchema } from './jobs.js'

/** 插件策略（06 §2.2） */
export const PluginPolicySchema = z.enum(['required', 'default', 'optional', 'hidden'])
export type PluginPolicy = z.infer<typeof PluginPolicySchema>

/** 插件库所在的平台（docs/22 §2.1）：一个插件可以同时出现在两边的库里，各自的策略互不影响 */
export const PluginPlatformSchema = PlatformSchema
export type PluginPlatform = Platform

/**
 * 某插件在**一个平台**上的设置（docs/22 §2.1 的 `plugin_platforms` 行）。
 * 插件出现在某平台的库里 ⇔ 有该平台的行；两个平台各有自己的 policy / 排序 / 配置片段。
 */
export const PluginPlatformSettingsSchema = z.object({
  policy: PluginPolicySchema,
  bundleOrder: z.number().int(),
  configYaml: z.string(),
  needsRestart: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type PluginPlatformSettings = z.infer<typeof PluginPlatformSettingsSchema>

/** `GET /api/admin/plugins?platform=cloud|desktop`：缺省云上（旧调用行为不变） */
export const AdminPluginListQuerySchema = PlatformQuerySchema
export type AdminPluginListQuery = z.infer<typeof AdminPluginListQuerySchema>

/** 插件来源（06 §2.1） */
export const PluginSourceTypeSchema = z.enum(['npm', 'tarball', 'local', 'upload'])
export type PluginSourceType = z.infer<typeof PluginSourceTypeSchema>

/** 期望/实际状态（03 §1.4 user_plugins） */
export const UserPluginStateSchema = z.enum(['synced', 'pending', 'failed'])
export type UserPluginState = z.infer<typeof UserPluginStateSchema>

export const UserPluginDesiredSchema = z.enum(['installed', 'absent'])
export type UserPluginDesired = z.infer<typeof UserPluginDesiredSchema>

export const UserPluginSourceSchema = z.enum(['admin', 'user', 'policy'])
export type UserPluginSource = z.infer<typeof UserPluginSourceSchema>

/** 04 §4.5 的插件卡片 */
export const PluginCardSchema = z.object({
  id: z.number().int(),
  packageName: z.string(),
  displayName: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  homepage: z.string().nullable(),
  policy: PluginPolicySchema,
  isBundle: z.boolean(),
  bundleOrder: z.number().int(),
  needsRestart: z.boolean(),
  latestVersion: z.string().nullable(),
})
export type PluginCard = z.infer<typeof PluginCardSchema>

export const PluginVersionSchema = z.object({
  id: z.number().int(),
  /** 这个版本属于哪个平台（docs/22 §2.1：同名版本号可以在两个平台各有一条）。后端总会给；缺省按云上看 */
  platform: PluginPlatformSchema.optional(),
  version: z.string(),
  sourceType: PluginSourceTypeSchema,
  sourceRef: z.string(),
  spec: z.string(),
  sha256: z.string().nullable(),
  minDsh: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
})
export type PluginVersion = z.infer<typeof PluginVersionSchema>

export const UserPluginRowSchema = z.object({
  userId: z.number().int(),
  username: z.string(),
  /** 04 §10.2：前端列表要用包名/显示名，不必再查一次目录 */
  packageName: z.string(),
  displayName: z.string(),
  pluginId: z.number().int(),
  desired: UserPluginDesiredSchema,
  desiredVersionId: z.number().int().nullable(),
  actualVersionId: z.number().int().nullable(),
  actualVersion: z.string().nullable(),
  state: UserPluginStateSchema,
  source: UserPluginSourceSchema,
  error: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
})
export type UserPluginRow = z.infer<typeof UserPluginRowSchema>

// ── GET /api/admin/plugins ──────────────────────────────────────────────────

/**
 * 桌面侧的安装统计（docs/22 §2.2；与 `PluginInstallStat.desktop` 同一口径）：
 * 有效设备里上报了该包（`state <> 'absent'`）的设备数 / 用户数 / 版本较旧的设备数 / 内置设备数。
 * 桌面的「较旧」按**桌面最新版本**算（桌面库看的是桌面版本，不是云上版本）。
 */
export const PluginDesktopStatsSchema = z.object({
  devices: z.number().int(),
  users: z.number().int(),
  outdated: z.number().int(),
  /** 上报 `source=bundled`（客户端自带）的设备数 */
  bundledDevices: z.number().int().optional(),
})
export type PluginDesktopStats = z.infer<typeof PluginDesktopStatsSchema>

export const AdminPluginRowSchema = PluginCardSchema.extend({
  /** 本行是哪个平台的视图（= 请求的 `?platform`，缺省 `cloud`）：policy / versions / stats 都按它对口径 */
  platform: PluginPlatformSchema.optional(),
  configYaml: z.string(),
  versions: z.array(PluginVersionSchema),
  stats: z.object({
    installed: z.number().int(),
    pending: z.number().int(),
    failed: z.number().int(),
  }),
  /** 该插件在哪些平台的库里，以及各平台的设置（docs/22 §2.2；只给存在的平台） */
  platforms: z
    .object({
      cloud: PluginPlatformSettingsSchema.optional(),
      desktop: PluginPlatformSettingsSchema.optional(),
    })
    .optional(),
  /** 桌面视图（`?platform=desktop`）的统计；云上视图不给（`stats` 仍是实例侧的期望/实际状态） */
  desktopStats: PluginDesktopStatsSchema.optional(),
})
export type AdminPluginRow = z.infer<typeof AdminPluginRowSchema>

export const AdminPluginListResponseSchema = z.array(AdminPluginRowSchema)
export type AdminPluginListResponse = z.infer<typeof AdminPluginListResponseSchema>

// ── GET /api/admin/plugins/lookup ───────────────────────────────────────────

export const PluginLookupQuerySchema = z
  .object({
    source: PluginSourceTypeSchema,
    name: z.string().optional(),
    path: z.string().optional(),
  })
  .refine((v) => (v.source === 'local' ? Boolean(v.path) : Boolean(v.name)), {
    message: 'source=local 需要 path，其它来源需要 name',
    path: ['name'],
  })
export type PluginLookupQuery = z.infer<typeof PluginLookupQuerySchema>

export const PluginLookupResponseSchema = z.object({
  packageName: z.string(),
  displayName: z.string(),
  description: z.string(),
  homepage: z.string().nullable(),
  versions: z.array(z.string()),
  latest: z.string().nullable(),
  isBundle: z.boolean(),
  needsRestart: z.boolean().nullable(),
})
export type PluginLookupResponse = z.infer<typeof PluginLookupResponseSchema>

// ── 插件增删改 ──────────────────────────────────────────────────────────────

export const CreatePluginRequestSchema = z.object({
  packageName: z.string().min(1).max(214),
  displayName: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  icon: z.string().max(2000).optional(),
  policy: PluginPolicySchema,
  isBundle: z.boolean(),
  bundleOrder: z.number().int().min(0).max(9999).optional(),
  configYaml: z
    .string()
    .max(64 * 1024)
    .optional(),
  needsRestart: z.boolean().optional(),
  /** 新建到哪个平台的库里（缺省云上，docs/22 §2.2） */
  platform: PluginPlatformSchema.optional(),
})
export type CreatePluginRequest = z.infer<typeof CreatePluginRequestSchema>

export const UpdatePluginRequestSchema = CreatePluginRequestSchema.partial()
export type UpdatePluginRequest = z.infer<typeof UpdatePluginRequestSchema>

/** 新增版本时可选平台（multipart 上传用查询串 `?platform=`） */
export const AddPluginVersionQuerySchema = PlatformQuerySchema
export type AddPluginVersionQuery = z.infer<typeof AddPluginVersionQuerySchema>

export const AddPluginVersionRequestSchema = z.union([
  z.object({
    sourceType: z.literal('npm'),
    version: z.string().min(1),
    platform: PluginPlatformSchema.optional(),
  }),
  z.object({
    sourceType: z.literal('tarball'),
    url: z.string().url(),
    version: z.string().min(1),
    platform: PluginPlatformSchema.optional(),
  }),
  z.object({
    sourceType: z.literal('local'),
    path: z.string().min(1),
    platform: PluginPlatformSchema.optional(),
  }),
])
export type AddPluginVersionRequest = z.infer<typeof AddPluginVersionRequestSchema>

export const AddPluginVersionResponseSchema = z.object({ version: PluginVersionSchema })
export type AddPluginVersionResponse = z.infer<typeof AddPluginVersionResponseSchema>

// ── 平台库的增删改（docs/22 §2.2） ──────────────────────────────────────────

/** `POST /api/admin/plugins/:id/platforms`：把已有插件加入另一个平台的库 */
export const AddPluginPlatformRequestSchema = z.object({
  platform: PluginPlatformSchema,
  policy: PluginPolicySchema.optional(),
  bundleOrder: z.number().int().min(0).max(9999).optional(),
  configYaml: z.string().max(64 * 1024).optional(),
  needsRestart: z.boolean().optional(),
})
export type AddPluginPlatformRequest = z.infer<typeof AddPluginPlatformRequestSchema>

/** `PATCH /api/admin/plugins/:id/platforms/:platform`：只改这个平台的设置 */
export const UpdatePluginPlatformRequestSchema = AddPluginPlatformRequestSchema.omit({
  platform: true,
}).partial()
export type UpdatePluginPlatformRequest = z.infer<typeof UpdatePluginPlatformRequestSchema>

/** 增/改某个平台的设置后返回该平台视图下的完整目录行 */
export const PluginPlatformResponseSchema = z.object({ plugin: AdminPluginRowSchema })
export type PluginPlatformResponse = z.infer<typeof PluginPlatformResponseSchema>

/** `DELETE /api/admin/plugins/:id/platforms/:platform?force=1`：`force` 需要二次密码（与其它危险操作一致） */
export const RemovePluginPlatformQuerySchema = z.object({
  force: BooleanQuerySchema.default(false),
})
export type RemovePluginPlatformQuery = z.infer<typeof RemovePluginPlatformQuerySchema>

export const PluginPlatformParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  platform: PluginPlatformSchema,
})
export type PluginPlatformParams = z.infer<typeof PluginPlatformParamsSchema>

/** 04 §10.1：`GET /api/admin/plugins/:id/users` 返回**全量**用户矩阵（`row=null` = 从未安装） */
export const PluginUserMatrixItemSchema = z.object({
  user: UserRefSchema.extend({ status: UserStatusSchema }),
  row: UserPluginRowSchema.nullable(),
})
export type PluginUserMatrixItem = z.infer<typeof PluginUserMatrixItemSchema>

export const PluginUsersResponseSchema = z.object({ items: z.array(PluginUserMatrixItemSchema) })
export type PluginUsersResponse = z.infer<typeof PluginUsersResponseSchema>

// ── 我的插件（04 §3.2，用户自助） ───────────────────────────────────────────

export const MyPluginItemSchema = z.object({
  plugin: PluginCardSchema,
  installed: z.boolean(),
  version: z.string().nullable(),
  state: UserPluginStateSchema,
  /** required 插件或配额不允许时为 false */
  canToggle: z.boolean(),
})
export type MyPluginItem = z.infer<typeof MyPluginItemSchema>

export const MyPluginsResponseSchema = z.object({ items: z.array(MyPluginItemSchema) })
export type MyPluginsResponse = z.infer<typeof MyPluginsResponseSchema>

/** 用户自助安装/卸载 → 202 { jobId } */
export const PluginToggleResponseSchema = JobRefSchema
export type PluginToggleResponse = z.infer<typeof PluginToggleResponseSchema>

// ── 契约清单（04 §10；docs/22 §2.2 的平台化加法） ──────────────────────────

export const PLUGIN_CONTRACT_MAP: ContractEntry[] = [
  {
    method: 'POST',
    path: '/api/admin/plugins/:id/platforms',
    request: 'AddPluginPlatformRequestSchema',
    response: 'PluginPlatformResponseSchema',
    note: '把已有插件加入另一个平台的库（docs/22 §2.2）',
  },
  {
    method: 'PATCH',
    path: '/api/admin/plugins/:id/platforms/:platform',
    request: 'UpdatePluginPlatformRequestSchema',
    response: 'PluginPlatformResponseSchema',
    note: '只改这个平台的设置；旧 PATCH /plugins/:id 仍写云上',
  },
  {
    method: 'DELETE',
    path: '/api/admin/plugins/:id/platforms/:platform',
    request: 'RemovePluginPlatformQuerySchema',
    note: '204；有目标或已装记录时拒绝，`?force=1` 同时撤销目标（需要二次密码）',
  },
]
