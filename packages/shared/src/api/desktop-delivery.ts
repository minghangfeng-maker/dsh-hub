import { z } from 'zod'
import type { ContractEntry } from '../contract-map.js'
import { IsoDateTimeSchema, RoleSchema } from '../common.js'
import { THINKING_LEVELS } from '../constants.js'
import { PluginPolicySchema } from './plugins.js'

/**
 * 桌面下发与升级（WP25b）：期望状态清单（manifest）、管理端下发配置、插件包、升级 feed、强更地板。
 *
 * 规格来源：
 * - 桌面端设计裁决（未随开源版发布，§1.4 强更逐字格式、§5 清单、§7.2 feed、§9 管理端）
 * - `D3-manifest.schema.json` —— **清单结构不得偏离**；本文件把它 1:1 翻成 zod，
 *   仓库里同时留了一份原样拷贝 `desktop-manifest.schema.json`，`test/desktop-delivery.test.ts`
 *   用 ajv 对同一批样例跑 JSON Schema、再用这里的 zod parse，两者结论必须一致。
 * - 跨任务裁决 #13（单 feed + 匿名地板）、#14（v1 不签名）、#16（claude 二进制不得由 Hub 托管）、
 *   #17（level 复用插件库 policy、通道 nightly|latest、端点名 `/api/desktop/manifest`）。
 *
 * 三条边界（与 D3 §5、§10 一致）：
 * 1. 清单是**声明式期望状态**：客户端按 revision 单调前进，只做整份接受/整份拒绝。
 * 2. 清单里的 `artifact.url` 必须 HTTPS；每个包带 sha256 + 字节数，客户端先下载校验再装。
 * 3. **配置片段只允许白名单里的键**（`DESKTOP_CONFIG_ALLOWLIST`）；其余一律 400 ——
 *    桌面拿到的是 Host 的 `--patch` overlay，写错一个保留 id 就能让 Host 起不来。
 */

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 清单格式版本（schema 里是 `const: 1`；加字段必须升版本） */
export const DESKTOP_MANIFEST_SCHEMA_VERSION = 1

/** 配置片段白名单的版本：客户端只接受自己实现过的值（清单里的 `config.allowlistVersion`） */
export const DESKTOP_CONFIG_ALLOWLIST_VERSION = 1

/** 升级目标（与上游 electron-builder 的 target 命名一致，D3 §7.2） */
export const DESKTOP_RELEASE_TARGETS = ['win-x64', 'mac-x64', 'mac-arm64'] as const
export const DesktopReleaseTargetSchema = z.enum(DESKTOP_RELEASE_TARGETS)
export type DesktopReleaseTarget = z.infer<typeof DesktopReleaseTargetSchema>

/** 通道（裁决 #17：与上游统一为 nightly|latest，界面显示测试/稳定） */
export const DESKTOP_RELEASE_CHANNELS = ['nightly', 'latest'] as const
export const DesktopReleaseChannelSchema = z.enum(DESKTOP_RELEASE_CHANNELS)
export type DesktopReleaseChannel = z.infer<typeof DesktopReleaseChannelSchema>

/** 单个插件 tgz 的上限（清单 schema 的 `bytes.maximum`；也用于上传校验） */
export const DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES = 268_435_456
/** 安装包上传上限（NSIS 安装包实测 100–200 MB，留一倍余量） */
export const DESKTOP_INSTALLER_MAX_BYTES = 512 * 1024 * 1024
/** 每个插件只保留最近几个桌面整包（裁决 #16） */
export const DESKTOP_ARTIFACT_KEEP_VERSIONS = 2
/** 清单里插件条目的上限（schema `maxItems: 64`） */
export const DESKTOP_MANIFEST_PLUGINS_MAX = 64
/** 清单里配置片段的上限（schema `maxItems: 128`） */
export const DESKTOP_MANIFEST_FRAGMENTS_MAX = 128

/**
 * 插件整包取件地址里的**每设备签名**（WP31，只做加法）。
 *
 * 桌面端取整包是「不带任何头」的 `fetch(artifact.url)`，下载接口除了 Bearer 设备令牌，
 * 还接受清单里渲染的签名查询串：`?d=<deviceId>&sig=<HMAC-SHA256 base64url>`。
 * 客户端**原样使用**清单里的 URL 即可（不用自己算签名）；这两个名字给日志脱敏、
 * 管理端「复制取件地址」以及服务端/测试共用，避免两边各写一份字面量。
 */
export const DESKTOP_ARTIFACT_SIGN_DEVICE_PARAM = 'd'
export const DESKTOP_ARTIFACT_SIGN_SIGNATURE_PARAM = 'sig'

/** 插件 level（= 插件库 policy 的映射，裁决 #17；hidden 不下发） */
export const DesktopDeliveryLevelSchema = z.enum(['core', 'default', 'optional'])
export type DesktopDeliveryLevel = z.infer<typeof DesktopDeliveryLevelSchema>

/** Hub 插件库 policy → 清单 level（`hidden` 返回 null = 不下发） */
export function desktopLevelOfPolicy(
  policy: z.infer<typeof PluginPolicySchema>,
): DesktopDeliveryLevel | null {
  if (policy === 'required') return 'core'
  if (policy === 'default') return 'default'
  if (policy === 'optional') return 'optional'
  return null
}

// ── 基础类型（与 D3-manifest.schema.json 的 pattern 逐字一致）─────────────────

/** npm 包名（schema `$defs/packageName`） */
export const DesktopDeliveryPackageNameSchema = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u, '插件名必须是 npm 包名（不含路径）')

/** 语义化版本（schema `$defs/semver`，允许预发布与构建元数据） */
export const DesktopDeliverySemverSchema = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    '版本号格式应为 1.2.3 / 1.2.3-rc.1',
  )

/** 小写十六进制 SHA-256（schema `$defs/sha256`） */
export const DesktopSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, '必须是 64 位小写十六进制')

/** 规范化摘要（`sha256:` + 64 位十六进制，只用于配置片段的客户端自校验） */
export const DesktopConfigDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u)

/** Loader 条目 id（patch 条目的目标） */
export const DesktopPatchEntryIdSchema = z.string().min(1).max(120)

/** 一条 Cordis patch 条目（schema `$defs/patchEntry`；顶层 patch 数组的一项） */
export const DesktopPatchEntrySchema = z
  .strictObject({
    id: DesktopPatchEntryIdSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    disabled: z.boolean().optional(),
    insert: z
      .array(
        z
          .strictObject({
            id: DesktopPatchEntryIdSchema,
            name: z.string().min(1).max(300),
            config: z.record(z.string(), z.unknown()).optional(),
          })
          .catchall(z.unknown()),
      )
      .max(64)
      .optional(),
  })
  // schema 的 oneOf：要么有 id（覆盖已有条目），要么有 insert（插入新条目）
  .refine((value) => value.id !== undefined || value.insert !== undefined, {
    message: 'patch 条目必须有 id 或 insert',
  })
export type DesktopPatchEntry = z.infer<typeof DesktopPatchEntrySchema>

/** 插件 tgz 的取件方式（schema `$defs/artifact`） */
export const DesktopArtifactSchema = z.strictObject({
  /** HTTPS 取件地址（客户端先下载、校验 sha256/bytes，再以 file: 绝对路径安装） */
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\//u, '取件地址必须是 https://'),
  sha256: DesktopSha256Schema,
  bytes: z.number().int().min(1).max(DESKTOP_PLUGIN_ARTIFACT_MAX_BYTES),
  /** 缓存文件名（缺省由客户端按「包名-版本.tgz」生成） */
  filename: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u, 'filename 只能是「字母数字._-」+ .tgz')
    .optional(),
  expiresAt: IsoDateTimeSchema.optional(),
})
export type DesktopArtifact = z.infer<typeof DesktopArtifactSchema>

/** 一个受管插件（schema `$defs/plugin`） */
export const DesktopManifestPluginSchema = z.strictObject({
  name: DesktopDeliveryPackageNameSchema,
  version: DesktopDeliverySemverSchema,
  level: DesktopDeliveryLevelSchema,
  enabled: z.boolean().optional(),
  artifact: DesktopArtifactSchema,
  bundleOrder: z.number().int().min(0).max(10_000).optional(),
  needsRestart: z.boolean().optional(),
  minDsh: z.string().max(200).optional(),
  config: z.array(DesktopPatchEntrySchema).max(64).optional(),
  reason: z.string().max(200).optional(),
})
export type DesktopManifestPlugin = z.infer<typeof DesktopManifestPluginSchema>

/** 一条配置覆盖（schema `$defs/configFragment`）；`config` 的键由白名单约束 */
export const DesktopManifestConfigFragmentSchema = z.strictObject({
  id: DesktopPatchEntryIdSchema,
  mode: z.enum(['enforce', 'default']),
  config: z.record(z.string(), z.unknown()),
  note: z.string().max(500).optional(),
})
export type DesktopManifestConfigFragment = z.infer<typeof DesktopManifestConfigFragmentSchema>

/** 配置下发段（schema `$defs/config`） */
export const DesktopManifestConfigSchema = z.strictObject({
  fragments: z.array(DesktopManifestConfigFragmentSchema).max(DESKTOP_MANIFEST_FRAGMENTS_MAX),
  digest: DesktopConfigDigestSchema.optional(),
  allowlistVersion: z.number().int().min(1).optional(),
})
export type DesktopManifestConfig = z.infer<typeof DesktopManifestConfigSchema>

/** app 版本策略（schema `$defs/app`） */
export const DesktopManifestAppSchema = z.strictObject({
  channel: DesktopReleaseChannelSchema,
  minVersion: DesktopDeliverySemverSchema,
  minVersionHard: z.boolean().optional(),
  targetVersion: DesktopDeliverySemverSchema.optional(),
  /** 设备专属 feed 根 URL（generic provider，末尾必须有 `/`，不带查询串） */
  feedUrl: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^?#]+\/$/u, 'feedUrl 必须是 https URL、以 / 结尾、不带查询串')
    .optional(),
})
export type DesktopManifestApp = z.infer<typeof DesktopManifestAppSchema>

/** 设备自检段（schema `$defs/device`） */
export const DesktopManifestDeviceSchema = z.strictObject({
  deviceId: z.string().min(8).max(64),
  userId: z.number().int().min(1).optional(),
})

/** 清单签名（v2；v1 不下发，见裁决 #14） */
export const DesktopManifestSignatureSchema = z.strictObject({
  alg: z.literal('ed25519'),
  keyId: z.string().min(1).max(64),
  value: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  signedAt: IsoDateTimeSchema,
  canonicalization: z.literal('jcs-rfc8785').optional(),
})

/**
 * `GET /api/desktop/manifest`（设备令牌）的响应 = 期望状态清单。
 * `additionalProperties: false`（每个对象都是 strictObject），与 JSON Schema 完全同形。
 */
export const DesktopManifestSchema = z.strictObject({
  schemaVersion: z.literal(DESKTOP_MANIFEST_SCHEMA_VERSION),
  revision: z.number().int().min(1),
  issuedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.optional(),
  device: DesktopManifestDeviceSchema.optional(),
  notice: z.string().max(500).optional(),
  plugins: z.array(DesktopManifestPluginSchema).max(DESKTOP_MANIFEST_PLUGINS_MAX),
  uninstall: z.array(DesktopDeliveryPackageNameSchema).max(64).optional(),
  config: DesktopManifestConfigSchema.optional(),
  app: DesktopManifestAppSchema.optional(),
  signature: DesktopManifestSignatureSchema.optional(),
})
export type DesktopManifest = z.infer<typeof DesktopManifestSchema>

// ── 配置片段白名单（第一版）──────────────────────────────────────────────────

/** 白名单里的键路径 → 说明（管理端展示 + 400 文案；也是 WP26a 客户端的实现清单） */
export interface DesktopConfigAllowlistEntry {
  title: string
  /** 允许的顶层键（`hubProxy.http` 这种就写成点号路径） */
  keys: readonly string[]
  note?: string
}

/**
 * 配置片段白名单 v1。**只有**这里列出的 Loader 条目与键能被下发，其余一律 400。
 *
 * 条目与键的选择依据（任务书交付物 2 + D4/D5）：
 * - `llm-pi-ai` / `agent-default-model`：Hub 中转站 provider 与默认模型（复用现有「下发到 DSH」
 *   选好的系统路由与默认模型，密钥引用固定写 `HUB_MK_HUB` = 这台设备自己的密钥）；
 * - `claude-pilot` / `codex-pilot`：两个 pilot 的 Hub 模式开关（`hubMode`）与既有 patch 键；
 * - `hub-connector`：`hubProxy.http|https|noProxy`（裁决 #21 的每渠道覆盖）与 pip 镜像。
 */
export const DESKTOP_CONFIG_ALLOWLIST = {
  version: DESKTOP_CONFIG_ALLOWLIST_VERSION,
  entries: {
    'llm-pi-ai': {
      title: 'Hub 中转站模型提供方',
      keys: ['providers'],
      note: 'providers.<路由>.{displayName,api,baseURL,apiKeyEnv,models,compat,reasoning}；apiKeyEnv 必须是 HUB_MK_HUB',
    },
    'agent-default-model': {
      title: '默认模型',
      keys: ['provider', 'model', 'reasoningEffort'],
    },
    'claude-pilot': {
      title: 'Claude Code 模式',
      keys: [
        'hubMode',
        'permissionMode',
        'defaultModel',
        'defaultEffort',
        'taskPreset',
        'maxToolResultChars',
        'verbose',
      ],
      note: 'hubMode=true 表示这台设备用 Hub 中转站（密钥 = HUB_CLAUDE_KEY）',
    },
    'codex-pilot': {
      title: 'Codex 模式',
      keys: [
        'hubMode',
        'sandbox',
        'approvalPolicy',
        'defaultModel',
        'defaultEffort',
        'taskPreset',
        'maxToolResultChars',
        'verbose',
      ],
      note: 'hubMode=true 表示这台设备用 Hub 中转站（密钥 = HUB_CODEX_KEY）',
    },
    'hub-connector': {
      title: '桌面连接器',
      keys: ['hubProxy.http', 'hubProxy.https', 'hubProxy.noProxy', 'python.mirror'],
      note: '代理与 pip 镜像；只影响桌面 Host 注入的环境变量，不改系统设置',
    },
  } satisfies Record<string, DesktopConfigAllowlistEntry>,
} as const

/** 白名单里允许的 Loader 条目 id（供前端下拉与错误提示） */
export const DESKTOP_CONFIG_ENTRY_IDS = Object.keys(DESKTOP_CONFIG_ALLOWLIST.entries) as readonly string[]

/** 白名单里允许的全部键路径（`<入口>.<键>`，深一层的写成 `hubProxy.http`） */
export const DESKTOP_CONFIG_ALLOWED_KEY_PATHS: readonly string[] = Object.entries(
  DESKTOP_CONFIG_ALLOWLIST.entries,
).flatMap(([entry, config]) => config.keys.map((key) => `${entry}.${key}`))

// ── 配置片段的取值 schema（管理端入参，逐键收窄）────────────────────────────

/** Hub 中转站的一条 provider：字段名照 DSH 的 pi-ai provider（与 models/render.ts 同口径） */
export const DesktopHubProviderSchema = z.strictObject({
  displayName: z.string().min(1).max(100),
  /** 协议：openai-completions / openai-responses / anthropic-messages … */
  api: z.string().min(1).max(64).optional(),
  /** 中转站地址；服务端还会校验它必须落在 Hub 自己的 origin 下 */
  baseURL: z.string().min(1).max(2048),
  /** 桌面端固定写这台设备自己的密钥引用（裁决 #8） */
  apiKeyEnv: z.literal('HUB_MK_HUB'),
  models: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        contextWindow: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        input: z
          .array(z.enum(['text', 'image']))
          .max(8)
          .optional(),
        compat: z.record(z.string(), z.unknown()).optional(),
        /** `{档位: 线上取值}`；off 写 null（与 models/render.ts 的 modelEntryConfig 一致） */
        reasoningEfforts: z.record(z.string(), z.string().nullable()).optional(),
      }),
    )
    .min(1)
    .max(200),
  compat: z.record(z.string(), z.unknown()).optional(),
  /** 这条路由的默认思考档位（系统 hub-relay 路由 hub-max / hub-high … 都带，见 models/render.ts） */
  reasoning: z.enum(THINKING_LEVELS).optional(),
})
export type DesktopHubProvider = z.infer<typeof DesktopHubProviderSchema>

/** `llm-pi-ai`：`{ providers: { <路由>: provider } }` */
export const DesktopLlmPiAiConfigSchema = z
  .strictObject({
    providers: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u, '路由名只允许小写字母数字与 -'),
        DesktopHubProviderSchema,
      )
      .refine((value) => Object.keys(value).length > 0, '至少要有一条 provider'),
  })
  .refine(
    (value) => Object.values(value.providers).every((provider) => provider.apiKeyEnv === 'HUB_MK_HUB'),
    'provider.apiKeyEnv 必须是 HUB_MK_HUB（设备自己的密钥引用）',
  )

/** `agent-default-model`：默认模型指向上面某条 provider 里的某个模型 */
export const DesktopDefaultModelConfigSchema = z.strictObject({
  provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u, 'provider 必须是路由名'),
  model: z.string().min(1).max(200),
  reasoningEffort: z.enum(THINKING_LEVELS).optional(),
})

/** `claude-pilot`：Hub 模式开关 + 既有 patch 键（键名照 dsh-claude-pilot 的 cordis.patch.yml） */
export const DesktopClaudePilotConfigSchema = z.strictObject({
  hubMode: z.boolean().optional(),
  permissionMode: z.enum(['bypassPermissions', 'acceptEdits', 'default', 'plan']).optional(),
  defaultModel: z.string().max(200).optional(),
  defaultEffort: z.string().max(32).optional(),
  taskPreset: z.string().min(1).max(64).optional(),
  maxToolResultChars: z.number().int().min(1_000).max(1_000_000).optional(),
  verbose: z.boolean().optional(),
})

/** `codex-pilot`：Hub 模式开关 + 既有 patch 键（键名照 dsh-codex-pilot 的 cordis.patch.yml） */
export const DesktopCodexPilotConfigSchema = z.strictObject({
  hubMode: z.boolean().optional(),
  sandbox: z.enum(['danger-full-access', 'workspace-write', 'read-only']).optional(),
  approvalPolicy: z.enum(['never', 'on-request', 'untrusted']).optional(),
  defaultModel: z.string().max(200).optional(),
  defaultEffort: z.string().max(32).optional(),
  taskPreset: z.string().min(1).max(64).optional(),
  maxToolResultChars: z.number().int().min(1_000).max(1_000_000).optional(),
  verbose: z.boolean().optional(),
})

/** `hub-connector`：代理（裁决 #21）与 pip 镜像（裁决 #20） */
export const DesktopHubConnectorConfigSchema = z
  .strictObject({
    hubProxy: z
      .strictObject({
        http: z.string().max(2048).nullable().optional(),
        https: z.string().max(2048).nullable().optional(),
        noProxy: z.array(z.string().min(1).max(200)).max(64).optional(),
      })
      .optional(),
    python: z
      .strictObject({
        /** pip 镜像（PIP_INDEX_URL）；给了可信主机就一起下发 */
        mirror: z.string().max(2048),
        trustedHost: z.string().max(200).optional(),
      })
      .optional(),
  })
  .refine((value) => value.hubProxy !== undefined || value.python !== undefined, {
    message: '至少要有 hubProxy 或 python 一项',
  })

/**
 * 一条待下发的配置片段：**判别联合**（`id` = Loader 条目 id）。
 * 不在白名单里的 `id`、或白名单条目里的未知键，解析必然失败 → 路由统一 400。
 */
export const DesktopConfigFragmentInputSchema = z.discriminatedUnion('id', [
  z.strictObject({
    id: z.literal('llm-pi-ai'),
    mode: z.enum(['enforce', 'default']),
    config: DesktopLlmPiAiConfigSchema,
    note: z.string().max(500).optional(),
  }),
  z.strictObject({
    id: z.literal('agent-default-model'),
    mode: z.enum(['enforce', 'default']),
    config: DesktopDefaultModelConfigSchema,
    note: z.string().max(500).optional(),
  }),
  z.strictObject({
    id: z.literal('claude-pilot'),
    mode: z.enum(['enforce', 'default']),
    config: DesktopClaudePilotConfigSchema,
    note: z.string().max(500).optional(),
  }),
  z.strictObject({
    id: z.literal('codex-pilot'),
    mode: z.enum(['enforce', 'default']),
    config: DesktopCodexPilotConfigSchema,
    note: z.string().max(500).optional(),
  }),
  z.strictObject({
    id: z.literal('hub-connector'),
    mode: z.enum(['enforce', 'default']),
    config: DesktopHubConnectorConfigSchema,
    note: z.string().max(500).optional(),
  }),
])
export type DesktopConfigFragmentInput = z.infer<typeof DesktopConfigFragmentInputSchema>

// ── 管理端：下发目标与三类下发请求 ──────────────────────────────────────────

/** 下发目标：全部 / 角色 / 指定用户（设备维度由服务端展开，不从请求里传） */
export const DesktopDeliveryTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('all') }),
  z.strictObject({ scope: z.literal('role'), role: RoleSchema }),
  z.strictObject({ scope: z.literal('user'), userId: z.number().int().positive() }),
])
export type DesktopDeliveryTarget = z.infer<typeof DesktopDeliveryTargetSchema>

/** `PUT /api/admin/desktop/plugins`：把某插件的某个版本下发给一个目标 */
export const DesktopPluginDeliverRequestSchema = z.strictObject({
  target: DesktopDeliveryTargetSchema,
  pluginId: z.number().int().positive(),
  versionId: z.number().int().positive(),
  /** 装好但禁用（只对 default/optional 有意义；core 恒为启用） */
  enabled: z.boolean().optional(),
})
export type DesktopPluginDeliverRequest = z.infer<typeof DesktopPluginDeliverRequestSchema>

/** `DELETE /api/admin/desktop/plugins`：撤掉某插件在一个目标上的受管条目 */
export const DesktopPluginWithdrawRequestSchema = z.strictObject({
  target: DesktopDeliveryTargetSchema,
  pluginId: z.number().int().positive(),
})
export type DesktopPluginWithdrawRequest = z.infer<typeof DesktopPluginWithdrawRequestSchema>

/**
 * `PUT /api/admin/desktop/config`：**整体替换**某个目标上的配置片段集合。
 * `fragments` 里同 id 只能出现一次；`removeEntryIds` 里的条目必须属于本目标（防止删别人的）。
 */
export const DesktopConfigDeliverRequestSchema = z
  .strictObject({
    target: DesktopDeliveryTargetSchema,
    fragments: z.array(DesktopConfigFragmentInputSchema).max(DESKTOP_MANIFEST_FRAGMENTS_MAX),
  })
  .refine(
    (value) => new Set(value.fragments.map((fragment) => fragment.id)).size === value.fragments.length,
    { message: '同一个条目 id 只能出现一次', path: ['fragments'] },
  )
export type DesktopConfigDeliverRequest = z.infer<typeof DesktopConfigDeliverRequestSchema>

/** `PUT /api/admin/desktop/app`：某渠道（可再按角色/用户覆盖）的版本策略 */
export const DesktopAppDeliverRequestSchema = z.strictObject({
  channel: DesktopReleaseChannelSchema,
  /** 省略 = 渠道级策略；给了 role/user 就是覆盖项 */
  target: DesktopDeliveryTargetSchema.optional(),
  /** null = 清空该字段（覆盖项回到渠道级取值） */
  targetVersion: DesktopDeliverySemverSchema.nullable().optional(),
  minVersion: DesktopDeliverySemverSchema.nullable().optional(),
  minVersionHard: z.boolean().optional(),
  /** 灰度百分比（按 deviceId 哈希稳定分桶；100 = 全部设备看到 targetVersion） */
  rolloutPercent: z.number().int().min(0).max(100).optional(),
})
export type DesktopAppDeliverRequest = z.infer<typeof DesktopAppDeliverRequestSchema>

/** `PUT /api/admin/desktop/uninstall`：明确要求卸载的受管包名（之前由 Hub 下发过） */
export const DesktopUninstallDeliverRequestSchema = z
  .strictObject({
    target: DesktopDeliveryTargetSchema,
    add: z.array(DesktopDeliveryPackageNameSchema).max(64).optional(),
    remove: z.array(DesktopDeliveryPackageNameSchema).max(64).optional(),
  })
  .refine((value) => (value.add?.length ?? 0) > 0 || (value.remove?.length ?? 0) > 0, {
    message: 'add 与 remove 至少要有一项',
  })
export type DesktopUninstallDeliverRequest = z.infer<typeof DesktopUninstallDeliverRequestSchema>

/** 一次「下发」的结果（新 revision 即设备的 desiredRevision 上界） */
export const DesktopDeliverResponseSchema = z.object({
  revision: z.number().int().min(1),
  /** 受影响的（active）设备数 */
  affectedDevices: z.number().int().nonnegative(),
})
export type DesktopDeliverResponse = z.infer<typeof DesktopDeliverResponseSchema>

// ── 管理端：状态视图 ────────────────────────────────────────────────────────

/** 目标的展示形态（请求里是判别联合，视图里拍平，便于表格渲染） */
export const DesktopDeliveryScopeSchema = z.object({
  scope: z.enum(['all', 'role', 'user']),
  role: RoleSchema.nullable(),
  userId: z.number().int().positive().nullable(),
})
/** 目标的展示形态（WP25e 交付物 7：WP25d 之前只能自己 `z.infer` 派生，这里补成正式别名） */
export type DesktopDeliveryScope = z.infer<typeof DesktopDeliveryScopeSchema>

/** 已上传的桌面整包（插件库版本的 Hub 托管件） */
export const DesktopPluginArtifactSchema = z.object({
  pluginId: z.number().int(),
  packageName: z.string(),
  versionId: z.number().int(),
  version: z.string(),
  fileName: z.string(),
  bytes: z.number().int().positive(),
  sha256: DesktopSha256Schema,
  uploadedAt: IsoDateTimeSchema,
})
export type DesktopPluginArtifact = z.infer<typeof DesktopPluginArtifactSchema>

/** 管理端看到的一条「受管插件」 */
export const DesktopPluginTargetSchema = z
  .object({
    id: z.number().int(),
    pluginId: z.number().int(),
    packageName: z.string(),
    displayName: z.string(),
    policy: PluginPolicySchema,
    versionId: z.number().int(),
    version: z.string(),
    /** 由 policy 推导（hidden 行不会存在） */
    level: DesktopDeliveryLevelSchema,
    enabled: z.boolean(),
    needsRestart: z.boolean(),
    minDsh: z.string().nullable(),
    artifact: DesktopPluginArtifactSchema.nullable(),
  })
  .and(DesktopDeliveryScopeSchema)
export type DesktopPluginTarget = z.infer<typeof DesktopPluginTargetSchema>

/** 管理端看到的一条配置片段 */
export const DesktopConfigFragmentViewSchema = z
  .object({
    id: z.number().int(),
    entryId: z.string(),
    mode: z.enum(['enforce', 'default']),
    config: z.record(z.string(), z.unknown()),
    note: z.string(),
  })
  .and(DesktopDeliveryScopeSchema)
export type DesktopConfigFragmentView = z.infer<typeof DesktopConfigFragmentViewSchema>

/** 管理端看到的一条卸载条目 */
export const DesktopUninstallViewSchema = z
  .object({
    id: z.number().int(),
    packageName: DesktopDeliveryPackageNameSchema,
  })
  .and(DesktopDeliveryScopeSchema)
export type DesktopUninstallView = z.infer<typeof DesktopUninstallViewSchema>

/** 渠道级版本策略 */
export const DesktopChannelPolicySchema = z.object({
  channel: DesktopReleaseChannelSchema,
  targetVersion: z.string().nullable(),
  minVersion: z.string().nullable(),
  minVersionHard: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
})
export type DesktopChannelPolicy = z.infer<typeof DesktopChannelPolicySchema>

/** 按角色/用户的版本策略覆盖 */
export const DesktopPolicyOverrideSchema = z
  .object({
    channel: DesktopReleaseChannelSchema,
    targetVersion: z.string().nullable(),
    minVersion: z.string().nullable(),
    minVersionHard: z.boolean().nullable(),
    rolloutPercent: z.number().int().min(0).max(100).nullable(),
  })
  .and(DesktopDeliveryScopeSchema)
export type DesktopPolicyOverride = z.infer<typeof DesktopPolicyOverrideSchema>

/** `GET /api/admin/desktop/delivery`：当前期望状态的全貌 + 渲染告警 */
export const DesktopDeliveryStateSchema = z.object({
  /** 发布计数器（下一条 revision = revision + 1） */
  revision: z.number().int().nonnegative(),
  allowlistVersion: z.number().int().min(1),
  pluginTargets: z.array(DesktopPluginTargetSchema),
  configFragments: z.array(DesktopConfigFragmentViewSchema),
  uninstalls: z.array(DesktopUninstallViewSchema),
  app: z.object({
    channels: z.array(DesktopChannelPolicySchema),
    overrides: z.array(DesktopPolicyOverrideSchema),
  }),
  /** 渲染时会跳过的条目（例如插件版本还没上传桌面整包），逐条给出原因 */
  warnings: z.array(z.string()),
})
export type DesktopDeliveryState = z.infer<typeof DesktopDeliveryStateSchema>

/**
 * `GET /api/admin/desktop/config/model-preset?userId=…`：复用现有「下发到 DSH」选好的
 * 系统路由与默认模型，给管理端一键带入 `llm-pi-ai` + `agent-default-model` 两个片段。
 */
export const DesktopModelPresetFragmentsResponseSchema = z.object({
  /** 按用户渲染时是该用户；`null` = 系统预设（没有指定 userId 时，WP25e） */
  userId: z.number().int().positive().nullable(),
  fragments: z.array(
    z.strictObject({
      id: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
    }),
  ),
  warnings: z.array(z.string()),
})
export type DesktopModelPresetFragmentsResponse = z.infer<typeof DesktopModelPresetFragmentsResponseSchema>

/** `GET /api/admin/desktop/artifacts`：已上传的桌面整包清单（WP25c 的版本下拉用） */
export const DesktopPluginArtifactListResponseSchema = z.object({
  items: z.array(DesktopPluginArtifactSchema),
})
export type DesktopPluginArtifactListResponse = z.infer<typeof DesktopPluginArtifactListResponseSchema>

/** `POST /api/admin/desktop/plugins/:pluginId/versions/:versionId/package` 的响应 */
export const DesktopPluginArtifactResponseSchema = z.object({ artifact: DesktopPluginArtifactSchema })
export type DesktopPluginArtifactResponse = z.infer<typeof DesktopPluginArtifactResponseSchema>

// ── 升级 feed（裁决 #13）────────────────────────────────────────────────────

/** 一条已发布的安装包（feed YAML 的生成依据） */
export const DesktopReleaseSchema = z.object({
  id: z.number().int(),
  target: DesktopReleaseTargetSchema,
  channel: DesktopReleaseChannelSchema,
  version: DesktopDeliverySemverSchema,
  installerFile: z.string(),
  installerBytes: z.number().int().positive(),
  /** base64（写进 feed YAML 的那个值） */
  installerSha512: z.string(),
  blockmapFile: z.string().nullable(),
  /** WP38：免安装 ZIP（不进 feed，只给公开主页）；没挂为 null */
  portableFile: z.string().nullable().default(null),
  portableBytes: z.number().int().positive().nullable().default(null),
  /** feed 文件名（`nightly.yml` / `latest-mac.yml`） */
  feedFile: z.string(),
  status: z.enum(['published', 'yanked']),
  publishedAt: IsoDateTimeSchema,
})
export type DesktopRelease = z.infer<typeof DesktopReleaseSchema>

export const DesktopReleaseListResponseSchema = z.object({
  items: z.array(DesktopReleaseSchema),
})
export type DesktopReleaseListResponse = z.infer<typeof DesktopReleaseListResponseSchema>

/** `POST /api/admin/desktop/releases/rollback`：回滚到该 target+channel 的上一个已发布版本 */
export const DesktopReleaseRollbackRequestSchema = z.strictObject({
  target: DesktopReleaseTargetSchema,
  channel: DesktopReleaseChannelSchema,
})
export type DesktopReleaseRollbackRequest = z.infer<typeof DesktopReleaseRollbackRequestSchema>

export const DesktopReleaseRollbackResponseSchema = z.object({
  /** 置为 published 的那条（回滚目标） */
  release: DesktopReleaseSchema,
  /** 被撤回（yanked）的版本号 */
  yanked: z.array(z.string()),
})
export type DesktopReleaseRollbackResponse = z.infer<typeof DesktopReleaseRollbackResponseSchema>

// ── 公开主页：安装包信息（WP36）─────────────────────────────────────────────

/**
 * 公开主页左卡（Windows 版）要展示的安装包：
 * 取 `desktop_releases` 里 `win-x64` 最新一条已发布记录（优先 `latest`，没有则 `nightly`）。
 * `url` 是现有的匿名下载路径（相对站根），前端直接当直链用。
 */
export const PublicDesktopDownloadItemSchema = z.object({
  version: DesktopDeliverySemverSchema,
  channel: DesktopReleaseChannelSchema,
  /** 版本号带预发布后缀（`0.2.1-rc.2`）；主页用它显示「预览版」标签 */
  prerelease: z.boolean(),
  /** 安装包文件名（与 `/desktop/bin/<target>/<file>` 的最后一段一致） */
  fileName: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  /** `/desktop/bin/win-x64/<file>`：匿名、长缓存，可直接给 `<a href>` */
  url: z.string().min(1).max(2048),
  publishedAt: IsoDateTimeSchema,
  /** WP38：同版本的免安装 ZIP（解压即用、不自动升级）；没发布为 null */
  portable: z
    .object({
      fileName: z.string().min(1).max(200),
      bytes: z.number().int().positive(),
      url: z.string().min(1).max(2048),
    })
    .nullable()
    .default(null),
})
export type PublicDesktopDownloadItem = z.infer<typeof PublicDesktopDownloadItemSchema>

/** `GET /api/public/desktop/download`（匿名）：主页两平台卡片的数据源；安卓尚未发布，恒为 null */
export const PublicDesktopDownloadResponseSchema = z.object({
  windows: PublicDesktopDownloadItemSchema.nullable(),
  android: z.null(),
})
export type PublicDesktopDownloadResponse = z.infer<typeof PublicDesktopDownloadResponseSchema>

/** feed YAML 里的一行文件（字段名照 electron-updater 的 generic provider） */
export const DesktopFeedFileEntrySchema = z.object({
  url: z.string(),
  size: z.number().int().positive(),
  sha512: z.string(),
})
export type DesktopFeedFileEntry = z.infer<typeof DesktopFeedFileEntrySchema>

/** feed YAML 解析后的形状（服务端生成 + 测试回读都用它） */
export const DesktopFeedSchema = z.object({
  version: DesktopDeliverySemverSchema,
  files: z.array(DesktopFeedFileEntrySchema).min(1),
  path: z.string().optional(),
  sha512: z.string().optional(),
  releaseDate: z.string().optional(),
})
export type DesktopFeed = z.infer<typeof DesktopFeedSchema>

// ── 强更地板（裁决 #13 / D3 §1.4 逐字格式）─────────────────────────────────

/** 全局最低版本与提示文案（管理端可改；`minVersion` 为空 = 不强制） */
export const DesktopUpdateFloorSchema = z.object({
  minVersion: DesktopDeliverySemverSchema.nullable(),
  /** 40005 模态的标题（≤256 字符，纯文本） */
  title: z.string().max(256),
  /** 40005 模态的正文（≤16384 字符，纯文本） */
  detail: z.string().max(16_384),
  /** 「打开网页」按钮的目标（https，≤2048；null = 不显示按钮） */
  appLink: z.string().max(2048).nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
})
export type DesktopUpdateFloor = z.infer<typeof DesktopUpdateFloorSchema>

export const DesktopUpdateFloorResponseSchema = z.object({ floor: DesktopUpdateFloorSchema })
export type DesktopUpdateFloorResponse = z.infer<typeof DesktopUpdateFloorResponseSchema>

export const UpdateDesktopFloorRequestSchema = z.strictObject({
  minVersion: DesktopDeliverySemverSchema.nullable().optional(),
  title: z.string().max(256).optional(),
  detail: z.string().max(16_384).optional(),
  appLink: z
    .string()
    .max(2048)
    .refine((value) => value.startsWith('https://'), 'appLink 必须是 https://')
    .nullable()
    .optional(),
})
export type UpdateDesktopFloorRequest = z.infer<typeof UpdateDesktopFloorRequestSchema>

/**
 * `GET /api/v0/check_client_update`（匿名，上游壳的强更策略）。
 * **两种响应逐字照 D3 §1.4**：强制 40005 / 不强制 `{code:0,data:{biz_code:0,biz_data:null}}`。
 */
export const CheckClientUpdateResponseSchema = z.object({
  code: z.number().int(),
  data: z.union([
    z.object({
      show_content: z.object({
        title: z.string().max(256).optional(),
        detail: z.string().max(16_384).optional(),
      }),
      desktop_app_link: z.string().max(2048).optional(),
    }),
    z.object({ biz_code: z.literal(0), biz_data: z.null() }),
  ]),
})
export type CheckClientUpdateResponse = z.infer<typeof CheckClientUpdateResponseSchema>

/** 强更的两种响应常量（测试与路由共用同一份形状） */
export const DESKTOP_MANDATORY_UPDATE_CODE = 40005

/** 不强制更新的标准响应体 */
export function checkClientUpdateNotMandatory(): CheckClientUpdateResponse {
  return { code: 0, data: { biz_code: 0, biz_data: null } }
}

// ── 契约表增量 ──────────────────────────────────────────────────────────────

/** `test/contract.test.ts` 会核对这里出现的每个 schema 名都真实导出 */
export const DESKTOP_DELIVERY_CONTRACT_MAP: ContractEntry[] = [
  {
    method: 'GET',
    path: '/api/desktop/manifest',
    response: 'DesktopManifestSchema',
    note: '设备令牌；ETag/304；无副作用',
  },
  {
    method: 'GET',
    path: '/api/desktop/plugins/:name/:version.tgz',
    note: '设备令牌；文件流，响应头带 sha256/bytes（无响应 schema）',
  },
  {
    method: 'PUT',
    path: '/api/admin/desktop/plugins',
    request: 'DesktopPluginDeliverRequestSchema',
    response: 'DesktopDeliverResponseSchema',
    note: '管理端：把插件版本下发给目标并生成新 revision',
  },
  {
    method: 'DELETE',
    path: '/api/admin/desktop/plugins',
    request: 'DesktopPluginWithdrawRequestSchema',
    response: 'DesktopDeliverResponseSchema',
    note: '管理端：撤掉受管插件',
  },
  {
    method: 'PUT',
    path: '/api/admin/desktop/config',
    request: 'DesktopConfigDeliverRequestSchema',
    response: 'DesktopDeliverResponseSchema',
    note: '管理端：整体替换某目标的配置片段（白名单外 400）',
  },
  {
    method: 'PUT',
    path: '/api/admin/desktop/app',
    request: 'DesktopAppDeliverRequestSchema',
    response: 'DesktopDeliverResponseSchema',
    note: '管理端：渠道/角色/用户的版本策略',
  },
  {
    method: 'PUT',
    path: '/api/admin/desktop/uninstall',
    request: 'DesktopUninstallDeliverRequestSchema',
    response: 'DesktopDeliverResponseSchema',
    note: '管理端：明确要求卸载的受管包名',
  },
  {
    method: 'GET',
    path: '/api/admin/desktop/delivery',
    response: 'DesktopDeliveryStateSchema',
    note: '管理端：当前期望状态全貌',
  },
  {
    method: 'POST',
    path: '/api/admin/desktop/plugins/:pluginId/versions/:versionId/package',
    response: 'DesktopPluginArtifactResponseSchema',
    note: 'multipart file；claude 二进制包一律拒绝（裁决 #16）',
  },
  {
    method: 'GET',
    path: '/api/admin/desktop/artifacts',
    response: 'DesktopPluginArtifactListResponseSchema',
    note: '已上传的插件整包（每插件只保留最近 2 版）',
  },
  {
    method: 'GET',
    path: '/api/admin/desktop/config/model-preset',
    response: 'DesktopModelPresetFragmentsResponseSchema',
    note: '复用「下发到 DSH」的系统路由与默认模型，生成两个片段；userId 省略 = 系统预设（响应 userId=null）',
  },
  {
    method: 'POST',
    path: '/api/admin/desktop/releases',
    response: 'DesktopReleaseSchema',
    note: 'multipart installer/blockmap；生成 feed YAML',
  },
  {
    method: 'GET',
    path: '/api/admin/desktop/releases',
    response: 'DesktopReleaseListResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/desktop/releases/rollback',
    request: 'DesktopReleaseRollbackRequestSchema',
    response: 'DesktopReleaseRollbackResponseSchema',
    note: '管理端：回滚到上一版（yank 新版本，不删产物）',
  },
  {
    method: 'GET',
    path: '/api/admin/desktop/update-floor',
    response: 'DesktopUpdateFloorResponseSchema',
  },
  {
    method: 'PUT',
    path: '/api/admin/desktop/update-floor',
    request: 'UpdateDesktopFloorRequestSchema',
    response: 'DesktopUpdateFloorResponseSchema',
    note: '管理端：全局最低版本与提示文案',
  },
  {
    method: 'GET',
    path: '/api/v0/check_client_update',
    response: 'CheckClientUpdateResponseSchema',
    note: '匿名；逐字照 D3 §1.4（40005 / biz_code 0）',
  },
  {
    method: 'GET',
    path: '/api/public/desktop/download',
    response: 'PublicDesktopDownloadResponseSchema',
    note: '匿名；公开主页的 Windows 安装包（latest 优先，否则 nightly）',
  },
  {
    method: 'GET',
    path: '/desktop/feeds/:target/:channel.yml',
    note: '匿名；electron-updater generic provider 的清单（no-store）',
  },
  {
    method: 'GET',
    path: '/desktop/bin/:target/:file',
    note: '匿名；安装包与 blockmap（长缓存）',
  },
]
