import { z } from 'zod'
import type { ContractEntry } from '../contract-map.js'
import {
  IsoDateTimeSchema,
  PageQuerySchema,
  RoleLabelSchema,
  RoleSchema,
  UserRefSchema,
  pagedOf,
} from '../common.js'
import { RelayAgentModeSchema, RelayScopeSchema } from './relay.js'

/**
 * 桌面端契约（WP25a）：登录（D2）+ 混合实例的设备台账（D6），按跨任务裁决 #1–#12 合并。
 *
 * 设计来源与优先级：docs/20 → docs/22 → 两份契约草案。
 *
 * 三条纪律（与 02 §5、12 §3 同一口径）：
 * 1. **明文只出现一次**：设备令牌、设备的中转站密钥、模式密钥都只在签发的那个响应里给明文；
 *    库里只有 sha256（中转站密钥另有 key_enc 供 Hub 自己复用，见 `relay_keys`）。
 * 2. **短命秘密不落库**：PKCE 的 `code_challenge`、一次性 `code` 只存在 Hub 内存（TTL 内有效），
 *    与 Hub 其它一次性令牌同一做法（只在内存、带过期时间）。
 * 3. **设备令牌只做控制面**：登录态、角色/积分、设备上报、清单拉取；模型请求一律用 `sk-dsh-…`。
 *
 * 隐私边界（D6 §4，硬要求）：
 * - 客户端上报的两个入口（登录时的设备描述、`POST /api/desktop/devices/report`）**全部** `z.strictObject`：
 *   未知字段 → 400 VALIDATION_FAILED（`details.fields._`），绝不静默丢弃。
 * - 这里的键名集合就是白名单（`DESKTOP_REGISTER_KEYS` / `DESKTOP_REPORT_KEYS`，两处并集 17 项）；
 *   加字段必须同时改迁移 120、D6 文档 §4.1、客户端 `buildDeviceReport()`。
 * - 设备名 `DeviceNameSchema` 是唯一的自由文本字段：禁控制字符、禁路径分隔符。
 */

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 设备令牌前缀：`dsh_dev_` + 40 位 base62（与中转站密钥同一随机化写法） */
export const DESKTOP_TOKEN_PREFIX = 'dsh_dev_'
/** 令牌随机部分长度（base62，≈238 bit） */
export const DESKTOP_TOKEN_RANDOM_LENGTH = 40

/** PKCE 固定 S256（不做 plain） */
export const DESKTOP_PKCE_METHOD = 'S256' as const
/** 登录请求（pending）有效期：10 分钟 */
export const DESKTOP_AUTH_REQUEST_TTL_SECONDS = 600
/** 一次性授权 code 的有效期：60 秒 */
export const DESKTOP_AUTH_CODE_TTL_SECONDS = 60
/** 一个 pending 请求最多允许 5 次 token 兑换失败（防 code 爆破，14 §6.3 同款） */
export const DESKTOP_MAX_EXCHANGE_ATTEMPTS = 5

/** 设备令牌：滑动 30 天续期 */
export const DESKTOP_TOKEN_TTL_DAYS = 30
/** 设备令牌：绝对 90 天上限（滑动不能越过它） */
export const DESKTOP_TOKEN_ABSOLUTE_DAYS = 90

/** 授权页路径（浏览器打开）：`<hub>/desktop/authorize?req=<requestId>` */
export const DESKTOP_AUTHORIZE_PAGE_PATH = '/desktop/authorize'

/** 登录成功后客户端得到的权限清单（授权页展示用；文案由前端本地化） */
export const DESKTOP_PERMISSIONS = ['account.read', 'wallet.read', 'relay.call', 'manifest.pull'] as const
export const DesktopPermissionSchema = z.enum(DESKTOP_PERMISSIONS)
export type DesktopPermission = z.infer<typeof DesktopPermissionSchema>

/** 桌面端的中转站密钥写进哪个凭据引用：与 Hub 给容器注入的 env 名保持一致（models/render.ts） */
export const DESKTOP_RELAY_KEY_REF = 'HUB_MK_HUB'
/** 两个对话模式的密钥在 DSH 凭据库里的引用名（与 pilots 的 env 名一致，18 §4.1） */
export const DESKTOP_AGENT_MODE_KEY_REFS = {
  'claude-code': 'HUB_CLAUDE_KEY',
  codex: 'HUB_CODEX_KEY',
} as const

/** 设备上报间隔上限（秒）：下发值不得超过它（裁决 #4 / D6 §5.8-12） */
export const DESKTOP_REPORT_INTERVAL_MAX_SEC = 900

// ── 设备标识与设备名 ────────────────────────────────────────────────────────

/** 设备对外标识：`dv_` + 128 bit 随机 hex（**服务端生成**，客户端永不提供 —— 裁决 #1） */
export const DEVICE_ID_REGEX = /^dv_[0-9a-f]{32}$/
export const DeviceIdSchema = z.string().regex(DEVICE_ID_REGEX, '设备标识格式不正确')

/** 设备名：唯一的自由文本字段。≤64 字；禁控制字符与路径分隔符（防把路径抄进来，裁决 #2） */
export const DEVICE_NAME_MAX_LENGTH = 64
export const DeviceNameSchema = z
  .string()
  .trim()
  .min(1, '设备名不能为空')
  .max(DEVICE_NAME_MAX_LENGTH, `设备名最多 ${String(DEVICE_NAME_MAX_LENGTH)} 个字`)
  // 不用正则：eslint 的 no-control-regex 会拦控制字符字面量（这里按码点判断，语义一样清楚）
  .refine(
    (value) =>
      [...value].every((char) => {
        const code = char.codePointAt(0) ?? 0
        return code >= 0x20 && code !== 0x7f
      }),
    '设备名不能包含控制字符',
  )
  .refine((value) => !/[\\/]/u.test(value), '设备名不能包含路径分隔符')

/** 客户端 installId（UUIDv4）：服务端立即哈希成 install_key，原文不落库（裁决 #1） */
export const InstallIdSchema = z.uuid('installId 必须是 UUIDv4')

/** 系统主版本号：`11` / `14` / `24.04`，≤8 字符；不存 build 号（裁决 #2） */
export const OsMajorSchema = z
  .string()
  .max(8)
  .regex(/^[0-9][0-9.]*$/u, '系统版本只填主版本号，如 11 或 24.04')

/** 版本号（semver，允许 `-rc.N` 预发布） */
export const AppVersionSchema = z
  .string()
  .max(32)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, '版本号格式应为 1.2.3 或 1.2.3-rc.1')

/** npm 包名（含 @scope/name）：不允许 `:`、路径、`link:` / `file:` 前缀（D6 §4.2 的泄漏点） */
export const PluginPackageNameSchema = z
  .string()
  .max(128)
  .regex(/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u, '插件名必须是 npm 包名（不含路径）')

/** 单台设备最多上报多少条插件 */
export const DEVICE_PLUGINS_MAX = 200
/** capabilities 序列化后的字节上限（唯一 JSON 列） */
export const DEVICE_CAPABILITIES_MAX_BYTES = 256
/** 设备端点请求体上限（全局 2MB 太宽，D6 §5.3） */
export const DEVICE_BODY_LIMIT_BYTES = 64 * 1024
/** 应用失败计数上限（只计数，不带文本） */
export const DEVICE_ERROR_COUNT_MAX = 100

/** UTF-8 字节数（shared 包不依赖 Node 的 Buffer，也不引 DOM 的 TextEncoder） */
function utf8Bytes(value: unknown): number {
  let bytes = 0
  for (const char of JSON.stringify(value)) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

// ── 枚举 ────────────────────────────────────────────────────────────────────

/** 平台：直接用 Node 的 `process.platform`（客户端不写映射表；显示时再本地化） */
export const DesktopPlatformSchema = z.enum(['win32', 'darwin', 'linux'])
export type DesktopPlatform = z.infer<typeof DesktopPlatformSchema>

/** CPU 架构；未知架构用 `other`（不该让一条上报整体 400） */
export const DesktopArchSchema = z.enum(['x64', 'arm64', 'other'])
export type DesktopArch = z.infer<typeof DesktopArchSchema>

/**
 * 设备种类（WP40a）：桌面端与手机 App 共用同一张设备台账（同一套令牌表、同一个「我的设备」
 * 列表、同一个吊销入口）。`platform` 仍是 Node 的 `process.platform`（桌面端字段），
 * 手机的两端用 `mobilePlatform`，两者不互相借位。
 */
export const DeviceKindSchema = z.enum(['desktop', 'mobile'])
export type DeviceKind = z.infer<typeof DeviceKindSchema>

/** 手机平台（`kind='mobile'` 时有值） */
export const DesktopMobilePlatformSchema = z.enum(['android', 'ios', 'web'])
export type DesktopMobilePlatform = z.infer<typeof DesktopMobilePlatformSchema>

/** 更新通道：与上游统一为 `nightly|latest`（裁决 #17，UI 显示「测试/稳定」） */
export const DesktopAppChannelSchema = z.enum(['nightly', 'latest'])
export type DesktopAppChannel = z.infer<typeof DesktopAppChannelSchema>

/** 清单应用结果（D3） */
export const DesktopApplyStateSchema = z.enum(['unknown', 'applied', 'partial', 'pending', 'failed'])
export type DesktopApplyState = z.infer<typeof DesktopApplyStateSchema>

/** 应用失败原因：**固定枚举，不接受自由文本**（想报新原因就扩枚举 —— 这道人工关口是故意的） */
export const DesktopApplyErrorCodeSchema = z.enum([
  'manifest_fetch_failed',
  'manifest_invalid',
  'plugin_download_failed',
  'plugin_hash_mismatch',
  'plugin_install_failed',
  'plugin_conflict',
  'plugin_missing_runtime',
  'config_write_failed',
  'update_download_failed',
  'update_install_failed',
  'runtime_busy',
  'disk_full',
  'permission_denied',
  'unknown',
])
export type DesktopApplyErrorCode = z.infer<typeof DesktopApplyErrorCodeSchema>

/**
 * 插件来源（= D3 文档里的 level；`bundled` = 客户端自带的插件，docs/22 §4.2 —— 上报它才能算「内置」徽标）
 */
export const DesktopPluginSourceSchema = z.enum(['hub-core', 'hub-default', 'hub-optional', 'user', 'bundled'])
export type DesktopPluginSource = z.infer<typeof DesktopPluginSourceSchema>

/** 插件在一台设备上的状态 */
export const DesktopPluginStateSchema = z.enum(['enabled', 'disabled', 'failed', 'absent'])
export type DesktopPluginState = z.infer<typeof DesktopPluginStateSchema>

/** 在线状态：**派生值**，不落库（last_report_at + settings.desktop.offlineAfterSec） */
export const DesktopPresenceSchema = z.enum(['online', 'offline', 'revoked'])
export type DesktopPresence = z.infer<typeof DesktopPresenceSchema>

/**
 * 吊销原因。D6 给了四个（user/admin/user-deleted/expired）；
 * WP25a 增加两个级联来源，让「为什么这台设备被踢了」在台账里可查：
 * `password-change`（改密）、`user-disabled`（账号被停用）。
 */
export const DesktopRevokeReasonSchema = z.enum([
  'user',
  'admin',
  'user-deleted',
  'user-disabled',
  'password-change',
  'expired',
])
export type DesktopRevokeReason = z.infer<typeof DesktopRevokeReasonSchema>

// ── 上报内容（白名单） ──────────────────────────────────────────────────────

/** 能力探测：纯布尔/枚举，供 D4/D5 判断这台机器上有没有 pwsh7 / 能不能跑 Codex */
export const DesktopCapabilitiesSchema = z.strictObject({
  claudeCode: z.boolean(),
  codex: z.boolean(),
  pwsh: z.enum(['7', '5.1', 'none']),
})
export type DesktopCapabilities = z.infer<typeof DesktopCapabilitiesSchema>

/** 一条已安装插件：包名 + 版本 + 来源 + 状态 + 失败码（**不含**依赖 spec / 模块路径 / 配置） */
export const DesktopPluginEntrySchema = z.strictObject({
  name: PluginPackageNameSchema,
  version: AppVersionSchema,
  source: DesktopPluginSourceSchema,
  state: DesktopPluginStateSchema,
  /** 仅 `state='failed'` 时有意义；枚举码，不允许自由文本 */
  errorCode: DesktopApplyErrorCodeSchema.optional(),
})
export type DesktopPluginEntry = z.infer<typeof DesktopPluginEntrySchema>

/**
 * 登录时提交的设备描述（`name` 必填：授权页要显示「哪台设备在请求登录」）。
 * 键集合 = `DESKTOP_REGISTER_KEYS`（10 项，D6 §4.1 的「描述」白名单）。
 */
export const DesktopAuthDeviceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** 同一台机器的随机标识：服务端哈希成 install_key（按用户加盐，跨账号不可关联） */
    installId: InstallIdSchema.optional(),
    name: DeviceNameSchema,
    platform: DesktopPlatformSchema,
    osMajor: OsMajorSchema,
    arch: DesktopArchSchema,
    appVersion: AppVersionSchema,
    appChannel: DesktopAppChannelSchema,
    /** 内置运行时版本；全新安装尚未读出时为 null */
    runtimeVersion: AppVersionSchema.nullable(),
    capabilities: DesktopCapabilitiesSchema.optional(),
  })
  .refine(
    (value) =>
      value.capabilities === undefined || utf8Bytes(value.capabilities) <= DEVICE_CAPABILITIES_MAX_BYTES,
    { message: '能力信息过大', path: ['capabilities'] },
  )
export type DesktopAuthDevice = z.infer<typeof DesktopAuthDeviceSchema>

/** 通用的设备描述（`name` 可省略：沿用已有设备名） */
export const DesktopDeviceDescriptorSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    installId: InstallIdSchema.optional(),
    name: DeviceNameSchema.optional(),
    platform: DesktopPlatformSchema,
    osMajor: OsMajorSchema,
    arch: DesktopArchSchema,
    appVersion: AppVersionSchema,
    appChannel: DesktopAppChannelSchema,
    runtimeVersion: AppVersionSchema.nullable(),
    capabilities: DesktopCapabilitiesSchema.optional(),
  })
  .refine(
    (value) =>
      value.capabilities === undefined || utf8Bytes(value.capabilities) <= DEVICE_CAPABILITIES_MAX_BYTES,
    { message: '能力信息过大', path: ['capabilities'] },
  )
export type DesktopDeviceDescriptor = z.infer<typeof DesktopDeviceDescriptorSchema>

/**
 * `POST /api/desktop/devices/report`（心跳 + 应用结果一起报）。
 * **strictObject**：未知字段 → 400（隐私白名单只有一个实现点，D6 §4.3 L1）。
 * 缺失 `plugins` 视为「保持上次结果」；`plugins: []` 视为「现在一个都没装」。
 */
export const DesktopDeviceReportRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** 客户端时钟，只用于算偏差（不落库；服务端用自己的时钟） */
  reportedAt: IsoDateTimeSchema,
  appVersion: AppVersionSchema.optional(),
  appChannel: DesktopAppChannelSchema.optional(),
  runtimeVersion: AppVersionSchema.nullable().optional(),
  appliedRevision: z.number().int().nonnegative().nullable(),
  appliedAt: IsoDateTimeSchema.nullable(),
  applyState: DesktopApplyStateSchema,
  /** 首个（最关键的）失败原因；细节走 `plugins[].errorCode` */
  applyErrorCode: DesktopApplyErrorCodeSchema.nullable(),
  /** 本次应用失败了几项（0–100）：只计数，不带任何文本 */
  errorCount: z.number().int().min(0).max(DEVICE_ERROR_COUNT_MAX).optional(),
  plugins: z.array(DesktopPluginEntrySchema).max(DEVICE_PLUGINS_MAX).optional(),
})
export type DesktopDeviceReportRequest = z.infer<typeof DesktopDeviceReportRequestSchema>

/** 客户端发送前的键集合断言用（与 schema 同源，不手写第二份） */
export const DESKTOP_REGISTER_KEYS: readonly string[] = Object.keys(DesktopDeviceDescriptorSchema.shape)
export const DESKTOP_REPORT_KEYS: readonly string[] = Object.keys(DesktopDeviceReportRequestSchema.shape)

/** 隐私白名单的总项数（登录 10 项 + 上报 11 项，其中 4 项共用 = 17，D6 §4.1） */
export const DESKTOP_REPORT_ALLOWLIST_SIZE = new Set([...DESKTOP_REGISTER_KEYS, ...DESKTOP_REPORT_KEYS]).size

/** `POST /api/desktop/devices/report` 的响应 */
export const DesktopDeviceReportResponseSchema = z.object({
  /** 服务端时间（客户端据此校正退避，不信客户端时钟） */
  serverTime: IsoDateTimeSchema,
  /** 下一次上报间隔（秒）：`settings.desktop.reportIntervalSec`，≤900 */
  reportIntervalSec: z.number().int().min(30).max(DESKTOP_REPORT_INTERVAL_MAX_SEC),
  presence: DesktopPresenceSchema,
  /** 目标清单 revision（null = 没有需要应用的清单；WP25b 填） */
  desiredRevision: z.number().int().nonnegative().nullable(),
})
export type DesktopDeviceReportResponse = z.infer<typeof DesktopDeviceReportResponseSchema>

// ── 设备视图（服务端台账 = 「查看已上报内容」的唯一真相） ────────────────────

/**
 * 设备自身可见的全部字段：**这个形状就是数据库列的子集**（`presence` 是派生值）。
 * 库里存在但不对外：`id`（自增）、`install_key`（已哈希）、`revoked_by`（走审计看）。
 */
export const DesktopDeviceSchema = z.object({
  deviceId: DeviceIdSchema,
  name: z.string(),
  /**
   * 设备种类（WP40a）。**可选**：老 Hub 的响应里没有这个键，读端按 `desktop` 处理
   * （`deviceKindOf()` 是这个回退的唯一实现点）。
   */
  kind: DeviceKindSchema.optional(),
  /** 仅手机有值（`kind='mobile'`）；桌面端用 `platform` */
  mobilePlatform: DesktopMobilePlatformSchema.optional(),
  platform: DesktopPlatformSchema.nullable(),
  osMajor: z.string().nullable(),
  arch: DesktopArchSchema.nullable(),
  appVersion: AppVersionSchema.nullable(),
  appChannel: DesktopAppChannelSchema.nullable(),
  runtimeVersion: AppVersionSchema.nullable(),
  capabilities: DesktopCapabilitiesSchema.nullable(),
  appliedRevision: z.number().int().nonnegative().nullable(),
  /** 该设备当前应达到的清单 revision（WP25b 的发布计数；null = 下发模块不可用） */
  desiredRevision: z.number().int().nonnegative().nullable(),
  appliedAt: IsoDateTimeSchema.nullable(),
  applyState: DesktopApplyStateSchema,
  applyErrorCode: DesktopApplyErrorCodeSchema.nullable(),
  /** 上一次应用失败了几项（0–100） */
  errorCount: z.number().int().nonnegative().nullable(),
  presence: DesktopPresenceSchema,
  /** 时间全部是服务端时钟 */
  firstSeenAt: IsoDateTimeSchema,
  registeredAt: IsoDateTimeSchema.nullable(),
  lastReportAt: IsoDateTimeSchema.nullable(),
  lastAuthAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  revokeReason: DesktopRevokeReasonSchema.nullable(),
  createdAt: IsoDateTimeSchema,
})
export type DesktopDevice = z.infer<typeof DesktopDeviceSchema>

/** 读设备种类（WP40a）：老 Hub 的响应没有 `kind` 键 → 按桌面端处理（唯一回退点） */
export function deviceKindOf(device: { kind?: DeviceKind | undefined }): DeviceKind {
  return device.kind ?? 'desktop'
}

/** 设备的最短摘要（错误详情里引导「先吊销一台」用） */
export const DesktopDeviceBriefSchema = z.object({
  deviceId: DeviceIdSchema,
  name: z.string(),
  presence: DesktopPresenceSchema,
  lastReportAt: IsoDateTimeSchema.nullable(),
})
export type DesktopDeviceBrief = z.infer<typeof DesktopDeviceBriefSchema>

// ── 登录：PKCE + 回环 ───────────────────────────────────────────────────────

/** 回环回调地址：只接受 `http://127.0.0.1:<非0端口>/…`、`http://localhost:<非0端口>/…`（含 [::1]） */
export const LOOPBACK_REDIRECT_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:\/[^\s?#]*)?$/u
export const LoopbackRedirectUriSchema = z
  .string()
  .max(512)
  .refine(
    (value) => LOOPBACK_REDIRECT_RE.test(value),
    'redirect_uri 必须是 http://127.0.0.1:<端口>/… 或 http://localhost:<端口>/…',
  )
  .refine((value) => {
    const matched = LOOPBACK_REDIRECT_RE.exec(value)
    const port = matched ? Number(matched[1]) : 0
    return port >= 1 && port <= 65535
  }, 'redirect_uri 的端口必须是 1–65535 之间的非 0 端口')

/**
 * `POST /api/desktop/auth/start`（免登录）：桌面端把 PKCE challenge、state、回环回调地址与设备描述交给 Hub，
 * 换一个 pending 请求 id 与授权页地址（`<hub>/desktop/authorize?req=<requestId>`）。
 * 免登录 + 按 IP 限流（10 次/10 分钟）。
 */
export const DesktopAuthStartRequestSchema = z.strictObject({
  /** base64url(SHA256(verifier))，43 字符 */
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'codeChallenge 必须是 32 字节的 base64url'),
  codeChallengeMethod: z.literal(DESKTOP_PKCE_METHOD),
  /** 32 字节随机 base64url；客户端自己比对回环回调里的 state */
  state: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/u, 'state 必须是 20–64 位 base64url'),
  redirectUri: LoopbackRedirectUriSchema,
  /** 发起时的界面语言（授权页文案） */
  locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  device: DesktopAuthDeviceSchema,
})
export type DesktopAuthStartRequest = z.infer<typeof DesktopAuthStartRequestSchema>

export const DesktopAuthStartResponseSchema = z.object({
  /** pending 请求 id（Hub 内存表主键） */
  requestId: z.string().min(1).max(64),
  /** 要在系统浏览器里打开的授权页：`<hub>/desktop/authorize?req=<requestId>` */
  authorizeUrl: z.string().url(),
  expiresAt: IsoDateTimeSchema,
})
export type DesktopAuthStartResponse = z.infer<typeof DesktopAuthStartResponseSchema>

/**
 * `GET /api/desktop/auth/requests/:id`（网页会话）：授权页要显示的内容 ——
 * 「哪个客户端、哪台设备、以谁的身份、请求什么权限」。
 */
export const DesktopAuthorizeViewSchema = z.object({
  requestId: z.string(),
  deviceName: z.string(),
  platform: DesktopPlatformSchema,
  osMajor: z.string(),
  arch: DesktopArchSchema,
  appVersion: z.string(),
  appChannel: DesktopAppChannelSchema,
  locale: z.enum(['zh-CN', 'en-US']),
  /** 当前网页登录的账号（授权页必须显示，防「我以为在给别的账号授权」） */
  user: z.object({
    username: z.string(),
    displayName: z.string(),
    roleLabel: RoleLabelSchema,
  }),
  expiresAt: IsoDateTimeSchema,
  /** 该账号已授权的桌面端数量（达上限时授权页提示「先吊销一台」） */
  deviceCount: z.number().int().nonnegative(),
  deviceLimit: z.number().int().positive(),
  permissions: z.array(DesktopPermissionSchema),
  /** pending 状态：waiting（还没点）/ allowed / denied */
  status: z.enum(['waiting', 'allowed', 'denied']),
})
export type DesktopAuthorizeView = z.infer<typeof DesktopAuthorizeViewSchema>

/** `POST /api/desktop/auth/requests/:id/approve|deny`（网页会话 + CSRF） */
export const DesktopAuthorizeDecisionSchema = z.strictObject({ allow: z.boolean() })
export type DesktopAuthorizeDecision = z.infer<typeof DesktopAuthorizeDecisionSchema>

export const DesktopAuthorizeDecisionResponseSchema = z.object({
  /** allow=true：`redirectUri?code=…&state=…`；allow=false：Hub 自己的「已拒绝」页 */
  redirectUrl: z.string().url(),
})
export type DesktopAuthorizeDecisionResponse = z.infer<typeof DesktopAuthorizeDecisionResponseSchema>

/** 桌面端用的账号视图（不含任何管理端字段） */
export const DesktopSessionUserSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  role: RoleSchema,
  /** 自定义角色标签；空串 = 普通用户，管理员恒为空串（与 UserAdminView 同口径） */
  roleLabel: RoleLabelSchema,
  status: z.enum(['pending', 'active', 'disabled']),
})
export type DesktopSessionUser = z.infer<typeof DesktopSessionUserSchema>

/**
 * 积分（微积分口径）：`balance` 是整数微积分，`unit` 恒为 `micro-point`。
 * 1 积分 = 1 000 000 微积分（与 `relay_wallets.balance` / `RelayWalletSchema.balanceMicro` 同一口径）。
 */
export const DesktopWalletSchema = z.object({
  balance: z.number().int(),
  unit: z.literal('micro-point'),
})
export type DesktopWallet = z.infer<typeof DesktopWalletSchema>

/** 该设备专属的中转站密钥（明文只此一次；库里只有 sha256） */
export const DesktopRelayCredentialSchema = z.object({
  /** relay_keys.id；设备行 `relay_key_id` 记它，吊销设备时一起吊销 */
  keyId: z.number().int(),
  /** `sk-dsh-…`，只出现在签发响应里；桌面端写进凭据引用 `HUB_MK_HUB` */
  secret: z.string().startsWith('sk-dsh-'),
  /** 写进哪个凭据引用（恒为 `HUB_MK_HUB`） */
  ref: z.string().min(1).max(64),
  /** 模型调用的 base URL（`<hub>/v1`） */
  baseUrl: z.string().url(),
  scope: RelayScopeSchema,
})
export type DesktopRelayCredential = z.infer<typeof DesktopRelayCredentialSchema>

/**
 * `POST /api/desktop/auth/token`（免登录）：code + code_verifier → 设备令牌 + deviceId。
 * 首次登录（或同一 installId 重新登录）在这里建/复用设备行，并检查每用户设备上限。
 */
export const DesktopAuthTokenRequestSchema = z.strictObject({
  /** 一次性授权 code（60 秒、只可用一次） */
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'code 格式不正确'),
  /** PKCE verifier：只在这里出现，绝不进日志/审计 */
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'codeVerifier 必须是 32 字节的 base64url'),
})
export type DesktopAuthTokenRequest = z.infer<typeof DesktopAuthTokenRequestSchema>

export const DesktopAuthTokenResponseSchema = z.object({
  /** 设备令牌 `dsh_dev_…`；客户端存凭据记录（库里只存 sha256） */
  token: z.string().startsWith(DESKTOP_TOKEN_PREFIX),
  /** 到期时间（滑动续期见 refresh；绝对上限 90 天） */
  expiresAt: IsoDateTimeSchema,
  absoluteExpiresAt: IsoDateTimeSchema,
  user: DesktopSessionUserSchema,
  wallet: DesktopWalletSchema.nullable(),
  device: z.object({
    deviceId: DeviceIdSchema,
    name: z.string(),
    createdAt: IsoDateTimeSchema,
  }),
  /** 该设备专属的中转站密钥；Hub 没开通中转站时为 null */
  relay: DesktopRelayCredentialSchema.nullable(),
  hub: z.object({ publicBaseUrl: z.string().url() }),
})
export type DesktopAuthTokenResponse = z.infer<typeof DesktopAuthTokenResponseSchema>

/** `POST /api/desktop/auth/refresh`（Bearer）：续期即轮换，旧令牌立刻失效 */
export const DesktopAuthRefreshResponseSchema = z.object({
  token: z.string().startsWith(DESKTOP_TOKEN_PREFIX),
  expiresAt: IsoDateTimeSchema,
  absoluteExpiresAt: IsoDateTimeSchema,
})
export type DesktopAuthRefreshResponse = z.infer<typeof DesktopAuthRefreshResponseSchema>

/** `POST /api/desktop/auth/logout`（Bearer）：吊销当前令牌，设备行与密钥保留（下次登录复用） */
export const DesktopLogoutResponseSchema = z.object({
  /** 被吊销的令牌条数（正常 1） */
  revoked: z.number().int().nonnegative(),
})
export type DesktopLogoutResponse = z.infer<typeof DesktopLogoutResponseSchema>

// ── 登录阶段的机器可读错误（放在 `details` 里，HTTP 码由全局错误码决定） ─────

/**
 * 登录阶段（token/approve）的细分原因：客户端按它本地化，**不要把中文 message 当协议**。
 * - `code_invalid`：code 不存在 / 已用过 / 已过期 → 400 VALIDATION_FAILED
 * - `pkce_mismatch`：verifier 与 challenge 不匹配 → 400 VALIDATION_FAILED
 * - `access_denied`：用户在浏览器点了拒绝 → 403 FORBIDDEN
 * - `expired`：pending 请求过期 → 410 GONE
 * - `device_limit_reached`：设备数超限 → 409 DEVICE_LIMIT_REACHED（`details.devices` 带列表）
 * - `account_blocked`：账号被停用/待审批 → 403 FORBIDDEN
 * - `password_change_required`：账号被管理员重置过密码，必须先**在网页端**改密才登得上桌面端
 *   → 403 FORBIDDEN（WP25e 从 `account_blocked` 里分出来：两者给用户的下一步完全不同，
 *   客户端要能直接说「请先在网页端修改密码」而不是「账号不可用」）
 */
export const DesktopLoginErrorCodeSchema = z.enum([
  'code_invalid',
  'pkce_mismatch',
  'access_denied',
  'expired',
  'device_limit_reached',
  'account_blocked',
  'password_change_required',
])
export type DesktopLoginErrorCode = z.infer<typeof DesktopLoginErrorCodeSchema>

/** 桌面端错误体里的 `details`（与全局 `ErrorBodySchema.details` 兼容，仅供客户端加分） */
export const DesktopErrorDetailsSchema = z.object({
  loginCode: DesktopLoginErrorCodeSchema.optional(),
  /** 设备数超限时的已占用设备 */
  devices: z.array(DesktopDeviceBriefSchema).optional(),
  retryAfterSec: z.number().int().optional(),
})
export type DesktopErrorDetails = z.infer<typeof DesktopErrorDetailsSchema>

// ── 会话（角色 / 积分 / 设备 / 搜索） ──────────────────────────────────────

/**
 * 搜索池（WP29）：只管「客户端要不要开联网搜索」。每用户的免费额度与单价在 `/api/me/tools`；
 * `baseUrl` 是 DSH 搜索/抓取提供方的 base URL（`<Hub 公开地址>/v1/tools`，DSH 自己在后面拼
 * `/search`、`/fetch`）。
 */
export const DesktopSessionToolsSchema = z.object({
  /** 搜索池总开关开着，**且**「下发到 DSH」也开着 */
  search: z.boolean(),
  /** `search=true` 时的 base URL；否则 null */
  baseUrl: z.string().url().nullable(),
})
export type DesktopSessionTools = z.infer<typeof DesktopSessionToolsSchema>

/** `GET /api/desktop/session`（Bearer）：带 `ETag`，可用 `If-None-Match` 换 304 */
export const DesktopSessionResponseSchema = z.object({
  user: z.object({
    username: z.string(),
    displayName: z.string(),
    role: RoleSchema,
    roleLabel: RoleLabelSchema,
  }),
  wallet: DesktopWalletSchema.nullable(),
  device: z.object({
    deviceId: DeviceIdSchema,
    name: z.string(),
  }),
  /**
   * 联网搜索（WP29，**加法字段**）：老 Hub 不带这个键，客户端必须当成 `search=false`；
   * 新 Hub 总是给出 `{search:false, baseUrl:null}` 或 `{search:true, baseUrl}`。
   */
  tools: DesktopSessionToolsSchema.optional(),
})
export type DesktopSessionResponse = z.infer<typeof DesktopSessionResponseSchema>

// ── 对话模式密钥（裁决 #11） ────────────────────────────────────────────────

/** `POST /api/desktop/agent-mode-key {mode}`：用设备令牌换这台设备自己的模式密钥 */
export const DesktopAgentModeKeyRequestSchema = z.strictObject({ mode: RelayAgentModeSchema })
export type DesktopAgentModeKeyRequest = z.infer<typeof DesktopAgentModeKeyRequestSchema>

export const DesktopAgentModeKeyResponseSchema = z.object({
  mode: RelayAgentModeSchema,
  scope: RelayScopeSchema,
  keyId: z.number().int(),
  /** `sk-dsh-…`：这台设备专属、吊销设备时一起失效 */
  secret: z.string().startsWith('sk-dsh-'),
  /** 写进哪个凭据引用（`HUB_CLAUDE_KEY` / `HUB_CODEX_KEY`） */
  ref: z.string().min(1).max(64),
  /** 模式的中转站地址（`<hub>/v1`） */
  baseUrl: z.string().url(),
})
export type DesktopAgentModeKeyResponse = z.infer<typeof DesktopAgentModeKeyResponseSchema>

// ── 用户：我的设备 ──────────────────────────────────────────────────────────

/** `GET /api/me/desktop-devices`（网页会话）：自己的设备（含已吊销的，带 revokedAt） */
export const DesktopMyDevicesResponseSchema = z.object({
  items: z.array(DesktopDeviceSchema),
  limit: z.object({ max: z.number().int(), used: z.number().int() }),
})
export type DesktopMyDevicesResponse = z.infer<typeof DesktopMyDevicesResponseSchema>

// ── 管理端 ──────────────────────────────────────────────────────────────────

/** 管理端一行 = 用户摘要 + 设备 + 插件数（插件清单在详情里取） */
export const DesktopDeviceAdminItemSchema = z.object({
  user: UserRefSchema,
  device: DesktopDeviceSchema,
  pluginCount: z.number().int().nonnegative(),
})
export type DesktopDeviceAdminItem = z.infer<typeof DesktopDeviceAdminItemSchema>

/** `GET /api/admin/desktop-devices?…` */
export const DesktopDeviceListQuerySchema = PageQuerySchema.extend({
  /** 匹配用户名 / 显示名 / 设备名 / deviceId */
  q: z.string().trim().max(64).optional(),
  presence: DesktopPresenceSchema.optional(),
  /** `active`（默认）| `revoked` | `all` */
  revoked: z.enum(['active', 'revoked', 'all']).default('active'),
  userId: z.coerce.number().int().positive().optional(),
  platform: DesktopPlatformSchema.optional(),
  appVersion: AppVersionSchema.optional(),
  /**
   * 设备种类过滤（WP56e1 追加，**可选**；省略 = 不过滤，老调用方行为不变）。
   * 手机与桌面端共用 `desktop_devices` 一张表，座舱的 `desktop.devices.list` /
   * `mobile.devices.list` 用它在同一条 SQL 里把两类设备分开（分页与 total 才准）。
   */
  kind: DeviceKindSchema.optional(),
})
export type DesktopDeviceListQuery = z.infer<typeof DesktopDeviceListQuerySchema>

export const DesktopDeviceListResponseSchema = pagedOf(DesktopDeviceAdminItemSchema)
export type DesktopDeviceListResponse = z.infer<typeof DesktopDeviceListResponseSchema>

/** `POST /api/admin/desktop-devices/:id/revoke` */
export const DesktopDeviceRevokeResponseSchema = z.object({ device: DesktopDeviceSchema })
export type DesktopDeviceRevokeResponse = z.infer<typeof DesktopDeviceRevokeResponseSchema>

// ── 设备详情（WP25e 交付物 1）：台账 + 插件清单 + 最近审计 ──────────────────

/** 详情里的插件行 = 上报条目 + 最后一次更新时间（**不含**依赖 spec / 模块路径 / 配置） */
export const DesktopDevicePluginSchema = DesktopPluginEntrySchema.extend({
  updatedAt: IsoDateTimeSchema,
})
export type DesktopDevicePlugin = z.infer<typeof DesktopDevicePluginSchema>

/**
 * 详情里的审计行：**故意没有 `actorIp`**（WP25e 隐私边界）。
 *
 * 设备详情是「看这台机器」的抽屉，D6 §4 要求它只回白名单内的字段；操作者 IP 属于
 * 「谁从哪儿点的」，需要时走 `GET /api/admin/audit`（管理员的完整审计视图）。
 */
export const DesktopDeviceAuditItemSchema = z.object({
  id: z.number().int(),
  at: IsoDateTimeSchema,
  action: z.string(),
  actorId: z.number().int().nullable(),
  actorUsername: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
})
export type DesktopDeviceAuditItem = z.infer<typeof DesktopDeviceAuditItemSchema>

/** 设备详情里的审计条数上限（与概览的 `recent.audit` 同一口径） */
export const DESKTOP_DEVICE_AUDIT_LIMIT = 20

/** `GET /api/admin/desktop-devices/:deviceId`（管理端） */
export const DesktopDeviceDetailResponseSchema = z.object({
  user: UserRefSchema,
  device: DesktopDeviceSchema,
  /** 已安装插件（按包名排序；上限 200 = 单次上报上限） */
  plugins: z.array(DesktopDevicePluginSchema),
  pluginCount: z.number().int().nonnegative(),
  /** 最近 `DESKTOP_DEVICE_AUDIT_LIMIT` 条与该设备有关的审计（targetType=desktop.device） */
  audit: z.array(DesktopDeviceAuditItemSchema),
})
export type DesktopDeviceDetailResponse = z.infer<typeof DesktopDeviceDetailResponseSchema>

// ── 用户改自己的设备名（WP25e 交付物 2） ────────────────────────────────────

/** `PATCH /api/me/desktop-devices/:deviceId`：设备名用 `DeviceNameSchema`（禁路径/控制字符） */
export const DesktopRenameDeviceRequestSchema = z.strictObject({ name: DeviceNameSchema })
export type DesktopRenameDeviceRequest = z.infer<typeof DesktopRenameDeviceRequestSchema>

export const DesktopRenameDeviceResponseSchema = z.object({ device: DesktopDeviceSchema })
export type DesktopRenameDeviceResponse = z.infer<typeof DesktopRenameDeviceResponseSchema>

// ── 管理端批量吊销（WP25e 交付物 3） ────────────────────────────────────────

/** 一次最多吊销多少台（与邀请码批量创建同一量级，D6 §5.2） */
export const DESKTOP_BATCH_REVOKE_MAX = 50

export const DesktopBatchRevokeRequestSchema = z.strictObject({
  /** 1–50 个设备标识；重复项由服务端去重 */
  deviceIds: z.array(DeviceIdSchema).min(1).max(DESKTOP_BATCH_REVOKE_MAX),
})
export type DesktopBatchRevokeRequest = z.infer<typeof DesktopBatchRevokeRequestSchema>

/**
 * 逐台结果：
 * - `revoked`：本次吊销成功
 * - `already_revoked`：之前就已经吊销（幂等，不算失败）
 * - `not_found`：设备不存在（不阻断其余设备）
 * - `failed`：单台吊销时服务端出错（原因只在日志里，不向前端回原文）
 */
export const DesktopBatchRevokeOutcomeSchema = z.enum([
  'revoked',
  'already_revoked',
  'not_found',
  'failed',
])
export type DesktopBatchRevokeOutcome = z.infer<typeof DesktopBatchRevokeOutcomeSchema>

export const DesktopBatchRevokeItemSchema = z.object({
  deviceId: DeviceIdSchema,
  outcome: DesktopBatchRevokeOutcomeSchema,
  /** 成功时带最新台账行（前端直接替换表格行）；`not_found` 时为 null */
  device: DesktopDeviceSchema.nullable(),
})
export type DesktopBatchRevokeItem = z.infer<typeof DesktopBatchRevokeItemSchema>

/** `POST /api/admin/desktop-devices/revoke`（需 reauth）：部分失败不影响其余 */
export const DesktopBatchRevokeResponseSchema = z.object({
  items: z.array(DesktopBatchRevokeItemSchema),
  /** 本次真正吊销的台数（恒等于 outcome=revoked 的条数） */
  revoked: z.number().int().nonnegative(),
  /** 没被吊销的台数（already_revoked + not_found + failed）；`revoked + skipped = items.length` */
  skipped: z.number().int().nonnegative(),
})
export type DesktopBatchRevokeResponse = z.infer<typeof DesktopBatchRevokeResponseSchema>

// ── 概览里的桌面设备计数（WP25e 交付物 4，纯加法字段） ──────────────────────

/**
 * `GET /api/admin/overview` 的 `desktop` 字段。
 *
 * 两个口径（04 §4.1 写死，测试也按它断言）：
 * - `online` 与设备台账同一判定：`status='active'` 且 `last_report_at >= now - settings.desktop.offlineAfterSec`
 * - 三者互补：`total = online + stale + revoked`
 *   - `stale` = 还活着但当前不在线（含从没上报过的）
 *   - `revoked` = 已吊销（含被级联吊销的）
 */
export const DesktopOverviewCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  online: z.number().int().nonnegative(),
  revoked: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
})
export type DesktopOverviewCounts = z.infer<typeof DesktopOverviewCountsSchema>

// ── 契约表增量（合并进 contract-map.ts 的「04 §5 桌面端」段） ────────────────

/** `test/contract.test.ts` 会核对这里出现的每个 schema 名都真实导出 */
export const DESKTOP_CONTRACT_MAP: ContractEntry[] = [
  {
    method: 'POST',
    path: '/api/desktop/auth/start',
    request: 'DesktopAuthStartRequestSchema',
    response: 'DesktopAuthStartResponseSchema',
    note: '免登录；按 IP 限流；返回授权页地址',
  },
  {
    method: 'GET',
    path: '/api/desktop/auth/requests/:id',
    response: 'DesktopAuthorizeViewSchema',
    note: '授权页取数；需网页会话',
  },
  {
    method: 'POST',
    path: '/api/desktop/auth/requests/:id/approve',
    request: 'DesktopAuthorizeDecisionSchema',
    response: 'DesktopAuthorizeDecisionResponseSchema',
    note: '需网页会话 + CSRF；返回 302 目标',
  },
  {
    method: 'POST',
    path: '/api/desktop/auth/requests/:id/deny',
    request: 'DesktopAuthorizeDecisionSchema',
    response: 'DesktopAuthorizeDecisionResponseSchema',
    note: '需网页会话 + CSRF',
  },
  {
    method: 'POST',
    path: '/api/desktop/auth/token',
    request: 'DesktopAuthTokenRequestSchema',
    response: 'DesktopAuthTokenResponseSchema',
    note: '免登录；code 一次性、失败 5 次即销毁；超设备上限 409',
  },
  {
    method: 'POST',
    path: '/api/desktop/auth/refresh',
    response: 'DesktopAuthRefreshResponseSchema',
    note: 'Bearer；轮换，旧令牌立即失效',
  },
  {
    method: 'POST',
    path: '/api/desktop/auth/logout',
    response: 'DesktopLogoutResponseSchema',
    note: 'Bearer',
  },
  {
    method: 'GET',
    path: '/api/desktop/session',
    response: 'DesktopSessionResponseSchema',
    note: 'Bearer；ETag/304',
  },
  {
    method: 'POST',
    path: '/api/desktop/devices/report',
    request: 'DesktopDeviceReportRequestSchema',
    response: 'DesktopDeviceReportResponseSchema',
    note: 'Bearer；strictObject，未知字段 400',
  },
  {
    method: 'POST',
    path: '/api/desktop/agent-mode-key',
    request: 'DesktopAgentModeKeyRequestSchema',
    response: 'DesktopAgentModeKeyResponseSchema',
    note: 'Bearer；模式没开通 → 403',
  },
  {
    method: 'GET',
    path: '/api/me/desktop-devices',
    response: 'DesktopMyDevicesResponseSchema',
    note: '网页会话；含已吊销',
  },
  {
    method: 'PATCH',
    path: '/api/me/desktop-devices/:id',
    request: 'DesktopRenameDeviceRequestSchema',
    response: 'DesktopRenameDeviceResponseSchema',
    note: '网页会话；只能改自己的（别人的 404），审计 desktop.rename',
  },
  {
    method: 'DELETE',
    path: '/api/me/desktop-devices/:id',
    note: '204；网页会话；吊销设备（令牌 + 密钥）',
  },
  {
    method: 'GET',
    path: '/api/admin/desktop-devices',
    request: 'DesktopDeviceListQuerySchema',
    response: 'DesktopDeviceListResponseSchema',
    note: '管理端：筛选 + 分页',
  },
  {
    method: 'GET',
    path: '/api/admin/desktop-devices/:id',
    response: 'DesktopDeviceDetailResponseSchema',
    note: '管理端：台账 + 插件清单 + 最近 20 条审计（无 IP / 无原始上报）',
  },
  {
    method: 'POST',
    path: '/api/admin/desktop-devices/revoke',
    request: 'DesktopBatchRevokeRequestSchema',
    response: 'DesktopBatchRevokeResponseSchema',
    note: '管理端：批量吊销 ≤50 台；需 reauth；逐台结果，每台一条审计',
  },
  {
    method: 'POST',
    path: '/api/admin/desktop-devices/:id/revoke',
    response: 'DesktopDeviceRevokeResponseSchema',
    note: '管理端：吊销（令牌 + 密钥）',
  },
]
