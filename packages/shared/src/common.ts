import { z } from 'zod'
import { DEFAULT_QUOTA, ROLE_LABEL_MAX_LENGTH, SLUG_REGEX } from './constants.js'
import { ErrorBodySchema } from './errors.js'

// ── 时间 / 基础 ─────────────────────────────────────────────────────────────

/** ISO-8601 UTC 字符串，例如 `2026-10-12T13:00:00.000Z`（03 §1 约定） */
export const IsoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/, '时间必须是 ISO-8601 UTC 字符串')

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>

/** 路径参数里的数字 id（字符串 → number） */
export const NumericIdParamSchema = z.object({ id: z.coerce.number().int().positive() })

/** 路径参数里的用户 slug */
export const SlugParamSchema = z.object({ slug: z.string().regex(SLUG_REGEX) })

/** 查询串里的布尔值：`?purge=true|false|1|0` */
export const BooleanQuerySchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
])

/** 空响应（204）的占位类型 */
export const EmptyResponseSchema = z.null()

// ── 分页（04 §0） ───────────────────────────────────────────────────────────

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type PageQuery = z.infer<typeof PageQuerySchema>

/** 分页响应包 `{ items, total, page, pageSize }` */
export function pagedOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

// ── 错误体 ──────────────────────────────────────────────────────────────────

export { ErrorBodySchema }

// ── 枚举 ────────────────────────────────────────────────────────────────────

export const RoleSchema = z.enum(['user', 'admin'])
export type Role = z.infer<typeof RoleSchema>

/** 普通用户的角色标签（见 constants 的 ROLE_LABEL_*）；空串 = 「普通用户」 */
export const RoleLabelSchema = z.string().trim().max(ROLE_LABEL_MAX_LENGTH)

export const UserStatusSchema = z.enum(['pending', 'active', 'disabled'])
export type UserStatus = z.infer<typeof UserStatusSchema>

export const InstanceStatusSchema = z.enum(['absent', 'stopped', 'starting', 'running', 'stopping', 'error'])
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>

export const ModelPolicySchema = z.enum(['managed', 'free'])
export type ModelPolicy = z.infer<typeof ModelPolicySchema>

export const RegistrationModeSchema = z.enum(['open', 'invite', 'closed'])
export type RegistrationMode = z.infer<typeof RegistrationModeSchema>

/**
 * **平台**（docs/22 §2 §3）：`cloud` = Hub 服务器上容器里跑的 DSH（云上），
 * `desktop` = 用户自己电脑上的 DSH Hub 桌面端。插件库、插件版本、模型配置（系统预设）按平台各一套；
 * 带 `platform` 的接口/查询参数**缺省 = `cloud`**，旧调用行为不变。
 */
export const PlatformSchema = z.enum(['cloud', 'desktop'])
export type Platform = z.infer<typeof PlatformSchema>

/** 查询串里的平台（缺省云上） */
export const PlatformQuerySchema = z.object({ platform: PlatformSchema.default('cloud') })
export type PlatformQuery = z.infer<typeof PlatformQuerySchema>

export const AnnouncementLevelSchema = z.enum(['info', 'success', 'warning', 'error'])
export type AnnouncementLevel = z.infer<typeof AnnouncementLevelSchema>

// ── 配额（03 §1.5） ─────────────────────────────────────────────────────────

export const QuotaSchema = z.object({
  cpus: z.number().min(0.5).max(8),
  memoryMb: z.number().int().min(512).max(8192),
  pidsLimit: z.number().int().min(64).max(8192),
  diskGb: z.number().min(1).max(200),
  idleStopMinutes: z.number().int().min(0).max(10080),
  /**
   * 无人在看时的休眠阈值（docs/22 §6.2；WP33）。`.default(30)` 让**旧库里已有的完整配额 JSON**
   * （没有这个键）仍然解析成功——否则 `resolveQuota` 会把用户自定义配额当成脏数据回退全局默认。
   */
  idleNoClientMinutes: z.number().int().min(0).max(10080).default(30),
  allowUserPlugins: z.boolean(),
})

export type Quota = z.infer<typeof QuotaSchema>

/** 部分更新用（PATCH 用户） */
export const PartialQuotaSchema = QuotaSchema.partial()
export type PartialQuota = z.infer<typeof PartialQuotaSchema>

export const DEFAULT_QUOTA_VALUE: Quota = DEFAULT_QUOTA

// ── settings（03 §1.6） ─────────────────────────────────────────────────────

export const SiteSettingsSchema = z.object({
  name: z.string().min(1).max(64),
  tagline: z.string().max(120),
  announcement: z.string().max(2000),
  announcementLevel: AnnouncementLevelSchema,
})
export type SiteSettings = z.infer<typeof SiteSettingsSchema>

export const RegistrationSettingsSchema = z.object({
  mode: RegistrationModeSchema,
  requireApproval: z.boolean(),
  maxUsers: z.number().int().min(1).max(1000),
})
export type RegistrationSettings = z.infer<typeof RegistrationSettingsSchema>

export const CapacitySettingsSchema = z.object({
  /**
   * 同时运行的实例上限。**0 = 维护模式**（只停不起：任何实例启动都按容量满拒绝）。
   *
   * 为什么允许 0：管理员需要一个「不让任何人再起实例」的开关（升级镜像、查内存泄漏、清磁盘时）。
   * 以前最小是 1，只能靠逐个停实例兜；0 让这件事一次配置就成立，且报错与正常容量满完全一致
   * （`CAPACITY_FULL`，手机端显示「当前使用人数较多」）。集成联调也用它来验证容量满这条路径。
   */
  maxRunning: z.number().int().min(0).max(200),
  maxConcurrentExports: z.number().int().min(1).max(16),
  /**
   * 连续「进行中」上限（分钟，0 = 不限；docs/22 §6.2 / WP33）。
   * 同样用 `.default(720)`：旧库里存过的 capacity JSON 没有这个键也要能读出来。
   */
  busyMaxMinutes: z.number().int().min(0).max(10080).default(720),
})
export type CapacitySettings = z.infer<typeof CapacitySettingsSchema>

export const ExportsSettingsSchema = z.object({
  ttlHours: z.number().int().min(1).max(720),
  maxBytes: z.number().int().min(1),
  dailyLimit: z.number().int().min(1).max(100),
})
export type ExportsSettings = z.infer<typeof ExportsSettingsSchema>

export const SecuritySettingsSchema = z.object({
  adminSessionHours: z.number().int().min(1).max(168),
  reauthMinutes: z.number().int().min(1).max(120),
})
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>

/**
 * 桌面端（WP25a / D6 §5.5）：设备台账与心跳策略。
 * `maxDevicesPerUser` 按 `status='active'` 计；`reportIntervalSec` 由服务端下发（客户端不得自行改小，
 * 上限 900 秒 = 15 分钟，D3 的 15 分钟心跳直接配即可）。
 */
export const DesktopSettingsSchema = z.object({
  /** 每人最多几台有效设备（1–20） */
  maxDevicesPerUser: z.number().int().min(1).max(20),
  /** 下发给客户端的心跳间隔（30–900s；默认 60） */
  reportIntervalSec: z.number().int().min(30).max(900),
  /** 服务端限流下限（10–300s）：比它更密的上报 → 429 */
  minReportIntervalSec: z.number().int().min(10).max(300),
  /** 超过这么久没上报就派生为 offline（≈3×心跳） */
  offlineAfterSec: z.number().int().min(60).max(3600),
  /** 崩溃诊断开关（二期，默认关） */
  diagnosticsAllowed: z.boolean(),
})
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>

/**
 * 手机 App（WP40a / v2 §4.5）：`GET /api/mobile/bootstrap` 的 `app` 段。
 *
 * `versionCode` 是 Android 的整数版本号（不是 semver），比较与「必须升级」判定都在 App 侧；
 * 管理端只负责给地板与下载地址。`downloadUrl=null` 时 App 不显示「去下载」入口。
 */
export const MobileSettingsSchema = z.object({
  app: z.object({
    /** 低于它的 App 必须升级才能继续用 */
    minVersionCode: z.number().int().min(1).max(10_000_000),
    /** 最新版本号（App 显示「有新版本」） */
    latestVersionCode: z.number().int().min(1).max(10_000_000),
    /** 最新 APK 的下载地址（公开主页或对象存储）；null = 没有可下载版本 */
    downloadUrl: z.string().url().max(500).nullable(),
  }),
})
export type MobileSettings = z.infer<typeof MobileSettingsSchema>

/**
 * 容器内权限预设（WP40d / docs/05 §4「容器内权限」）。
 *
 * 取值直接对应 DSH `dsh-permission-presets` 的预设名：
 * - `danger-full-access`：容器内沙箱全开 + 审批策略 `never`（手机 App 的默认，容器是隔离边界）
 * - `workspace-write`：只能写工作区 + 审批 `ask`（DSH 出厂行为，即「管理员改回去」的那一档）
 *
 * 实现上通过容器 env `DSH_PERMISSION_MODE` 生效（DSH 0.2.1-rc.2 的 base patch 用它推导
 * `sandbox-policy.mode` 与 `approval.policy`，并让 `permission-presets` 推导出同一个默认预设）；
 * 环境变量参与 `config_hash`，所以改这个值会让现有容器在下次启动时重建（数据卷不受影响）。
 */
export const CONTAINER_PERMISSION_PRESETS = ['danger-full-access', 'workspace-write'] as const
export const ContainerPermissionPresetSchema = z.enum(CONTAINER_PERMISSION_PRESETS)
export type ContainerPermissionPreset = z.infer<typeof ContainerPermissionPresetSchema>
/** 默认值（与 `DEFAULT_SETTINGS.container.permissionPreset` 必须一致，单测会核对） */
export const DEFAULT_CONTAINER_PERMISSION_PRESET: ContainerPermissionPreset = 'danger-full-access'

/**
 * 容器设置（WP40d）：只放「对所有用户容器生效」的开关，不放每用户配额（那是 Quota）。
 */
export const ContainerSettingsSchema = z.object({
  /** 容器内权限预设，默认完全放行（容器就是隔离边界，见 docs/05 §4） */
  permissionPreset: ContainerPermissionPresetSchema,
  /**
   * 是否给用户实例下发「普通对话」预设（手机 App 的默认对话模式）。
   * 关闭只影响之后重新渲染的 `managed.patch.yml`，不动已经在跑的容器。
   */
  chatPreset: z.boolean(),
})
export type ContainerSettings = z.infer<typeof ContainerSettingsSchema>

/**
 * 管理座舱（WP56a / docs/24 §3.2）：`PUT /api/admin/cockpit/settings` 写的两个开关。
 *
 * `autoExecuteR1` 决定 R1 动作是「直接执行」还是「出方案卡」，**只看服务端这份设置**
 * （I1：请求里的任何字段都不能影响它）。
 */
export const CockpitSettingsSchema = z.object({
  /** 座舱 DSH 用的模型（中转站里的模型名）；`null` = 用默认 `deepseek-v4.1-flash` */
  model: z.string().trim().min(1).max(200).nullable(),
  /** R1 低风险动作自动执行（docs/24 §10.1：默认开） */
  autoExecuteR1: z.boolean(),
})
export type CockpitSettings = z.infer<typeof CockpitSettingsSchema>

export const SettingsSchema = z.object({
  site: SiteSettingsSchema,
  registration: RegistrationSettingsSchema,
  default_quota: QuotaSchema,
  capacity: CapacitySettingsSchema,
  exports: ExportsSettingsSchema,
  security: SecuritySettingsSchema,
  desktop: DesktopSettingsSchema,
  mobile: MobileSettingsSchema,
  container: ContainerSettingsSchema,
  /** 管理座舱（WP56a） */
  cockpit: CockpitSettingsSchema,
})
export type Settings = z.infer<typeof SettingsSchema>

export const SettingsKeySchema = z.enum([
  'site',
  'registration',
  'default_quota',
  'capacity',
  'exports',
  'security',
  'desktop',
  'mobile',
  'container',
  'cockpit',
])
export type SettingsKey = z.infer<typeof SettingsKeySchema>

/** PATCH /api/admin/settings：按键整体替换 */
export const UpdateSettingsRequestSchema = SettingsSchema.partial()
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>

// ── 公共视图类型（04 §0.1） ─────────────────────────────────────────────────

export const UserPublicSchema = z.object({
  id: z.number().int(),
  slug: z.string().regex(SLUG_REGEX),
  username: z.string(),
  displayName: z.string(),
  bio: z.string(),
  avatarUrl: z.string().nullable(),
  role: RoleSchema,
  status: UserStatusSchema,
  mustChangePassword: z.boolean(),
  createdAt: IsoDateTimeSchema,
  lastLoginAt: IsoDateTimeSchema.nullable(),
  /** 最近一次修改用户名的时间（30 天一次的限制据此提示，WP5b 需求） */
  usernameChangedAt: IsoDateTimeSchema.nullable(),
})
export type UserPublic = z.infer<typeof UserPublicSchema>

export const InstanceSummarySchema = z.object({
  status: InstanceStatusSchema,
  runtimeVersion: z.string().nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  lastActiveAt: IsoDateTimeSchema.nullable(),
  /** config_hash 与期望不一致 → 需要重建容器 */
  needsRecreate: z.boolean(),
  error: z.string().nullable(),
  openUrl: z.string(),
})
export type InstanceSummary = z.infer<typeof InstanceSummarySchema>

export const InstanceStatsSchema = z.object({
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
  pids: z.number(),
  diskBytes: z.number().nullable(),
  diskLimitBytes: z.number(),
})
export type InstanceStats = z.infer<typeof InstanceStatsSchema>

/** 列表里引用用户的最小信息 */
export const UserRefSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
})
export type UserRef = z.infer<typeof UserRefSchema>

export const UserAdminViewSchema = UserPublicSchema.extend({
  /** 普通用户的自定义角色标签；空串 = 「普通用户」，管理员恒为空串（只给管理端看） */
  roleLabel: z.string(),
  quota: QuotaSchema,
  quotaIsDefault: z.boolean(),
  runtimeId: z.number().int().nullable(),
  modelPresetId: z.number().int().nullable(),
  modelPolicy: ModelPolicySchema,
  instance: InstanceSummarySchema,
  lastLoginIp: z.string().nullable(),
  deletedAt: IsoDateTimeSchema.nullable(),
})
export type UserAdminView = z.infer<typeof UserAdminViewSchema>

export const AuditItemSchema = z.object({
  id: z.number().int(),
  at: IsoDateTimeSchema,
  actorId: z.number().int().nullable(),
  actorIp: z.string().nullable(),
  actorUsername: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
})
export type AuditItem = z.infer<typeof AuditItemSchema>

// ── 下发任务：目标与策略（04 §4.8） ─────────────────────────────────────────

export const TargetsSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ userIds: z.array(z.number().int().positive()).min(1) }),
  z.object({
    filter: z.object({
      status: UserStatusSchema.optional(),
      runtimeId: z.number().int().optional(),
      presetId: z.number().int().optional(),
      pluginId: z.number().int().optional(),
    }),
  }),
])
export type Targets = z.infer<typeof TargetsSchema>

export const StrategySchema = z.object({
  concurrency: z.number().int().min(1).max(8).default(3),
  canary: z.number().int().min(0).max(5).default(1),
  maxFailureRatio: z.number().min(0).max(1).default(0.2),
  restart: z.enum(['now', 'next-start']).default('now'),
})
export type Strategy = z.infer<typeof StrategySchema>

// ── 通用响应 ────────────────────────────────────────────────────────────────

/** `{ ok: true }` 之类的简单确认 */
export const OkResponseSchema = z.object({ ok: z.boolean() })
export type OkResponse = z.infer<typeof OkResponseSchema>
