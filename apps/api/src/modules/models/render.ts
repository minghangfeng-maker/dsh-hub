import {
  providerKeyEnvName,
  THINKING_LEVELS,
  type ModelApi,
  type ModelKeyMode,
  type ModelProviderKind,
  type ModelSpec,
  type ThinkingLevel,
} from '@dsh-hub/shared'
import { chatPresetEntries } from './chat-preset.js'
import { stringifyPatchEntries, renderPatchEntryBlocks, type PatchEntry } from './patch-entries.js'

/**
 * `managed.patch.yml` 渲染（06 §4.3）。**纯函数**：输入是普通对象，输出是文本 + 警告，不碰文件系统、
 * 不解密任何密钥（密钥只以 `apiKeyEnv` 的**环境变量名**出现）。
 *
 * 真容器实测（WP3 spike，镜像 `dshhub/runtime:0.2.0-rc.2`）：
 * - `workspace-controller` 的 Config 是 `{ documentsDirectory: string, documentsLookupTimeoutMs: number = 10000 }`，
 *   `--dump-config` 里出厂条目**没有 config 段**（默认值由 schema 给）。因为 patch 的 config 是**整块替换**，
 *   这里把这两个字段都写全。
 * - 默认模型条目 id = `agent-default-model`；pi-ai 条目 id = `llm-pi-ai`（WP0b S5）。
 */

/** Hub 拥有的 patch 条目 id（插件配置里出现同 id 时以 Hub 为准并告警） */
export const RESERVED_ENTRY_IDS = new Set([
  'llm-pi-ai',
  'agent-default-model',
  'workspace-controller',
  'webserver',
  'ui-settings-account',
  'llm-deepseek-account',
  // WP40d：「普通对话」预设由 Hub 生成（preset-chat 行 + 注册表默认值），插件配置不得覆盖
  'preset-chat',
  'agent-preset-registry',
])

/** 默认工作区根（05 §S7 / 06 §4.3：总是输出）；字段取自真容器 `--dump-config` 的 schema */
export const WORKSPACE_CONTROLLER_ENTRY: PatchEntry = {
  id: 'workspace-controller',
  config: {
    documentsDirectory: '/workspace',
    documentsLookupTimeoutMs: 10_000,
  },
}

/**
 * 停用 DSH 自带的 DeepSeek 账号登录（2026-10-18）：它的浏览器登录只支持本机回调，在 Hub 反向代理下用不了，
 * 平台对 Hub 代发起的授权也会拒绝。`ui-settings-account` 是唯一的登录界面（设置里的账号页、登录弹窗、
 * 侧边栏退出）；`llm-deepseek-account` 是「DeepSeek 账号」模型来源，留着会出现一组选了就要求登录的模型。
 * 底层账号服务（`deepseek-account`）不动，搜索插件等可选依赖它的仍正常。条目 id 取自 dsh-base / dsh-web-app 的
 * cordis.patch.yml（0.2.1-rc.2），真容器验证过停用后正常启动、页面不再带账号页。
 */
export const DISABLED_DSH_ENTRIES: PatchEntry[] = [
  { id: 'ui-settings-account', disabled: true },
  { id: 'llm-deepseek-account', disabled: true },
]

/**
 * 渲染进 `providers.<routeKey>.models` 的模型条目：`ModelSpec` + 可选的**模型级 `compat`**。
 * 模型级 compat 是 12 §7.2 给 hub-relay 用的（每个对外模型可以有自己的一套改写规则）；
 * 是否被 llm-pi-ai 接受由 WP10a 的真容器验证结论决定（见进度报告）。
 */
export type RenderModelSpec = ModelSpec & { compat?: Record<string, unknown> | null }

/**
 * hub-relay 提供方统一用这一个 env 名（12 §7.0「密钥 env」，WP13）：
 * 它们共用用户的那把 system 密钥，路由增减就不改变容器 env（不触发重建，只重启）。
 * 名字是固定路由名 `hub` 推导出来的，与 `providerKeyEnvName('hub')` 一致。
 */
export const DSH_HUB_KEY_ENV_NAME = 'HUB_MK_HUB'

export interface RenderProviderInput {
  routeKey: string
  displayName: string
  kind: ModelProviderKind
  api: ModelApi | null
  baseUrl: string | null
  models: RenderModelSpec[]
  compat: Record<string, unknown> | null
  extra: Record<string, unknown> | null
  keyMode: ModelKeyMode
  /**
   * 渲染进 `apiKeyEnv` 的环境变量名；省略 = 按路由名推导（`HUB_MK_<ROUTE>`），null = 不写。
   * hub-relay 提供方显式传 `DSH_HUB_KEY_ENV_NAME`（统一一个 env 名）。
   */
  apiKeyEnv?: string | null
  /**
   * 这条路由的默认思考档位（WP13：系统 hub-relay 路由渲染成 provider 配置的 `reasoning`）。
   * 省略 = 不设（旧的手工 hub-relay 提供方），此时也不给 `agent-default-model` 写 `reasoningEffort`。
   */
  thinking?: ThinkingLevel | null
  enabled: boolean
}

export interface RenderPresetInput {
  id: number
  name: string
  revision: number
  defaultProvider: string
  defaultModel: string
  providers: RenderProviderInput[]
}

export interface RenderUserInput {
  id: number
  slug: string
  modelPolicy: 'managed' | 'free'
  runtimeVersion: string | null
}

export interface RenderPluginInput {
  packageName: string
  version: string | null
  bundleOrder: number
  configYaml: string
}

export interface RenderManagedInput {
  user: RenderUserInput
  preset: RenderPresetInput | null
  plugins: RenderPluginInput[]
  /**
   * Hub 自己管理的额外 patch 条目（搜索 / 抓取池下发，14 §5）。
   * 放在模型条目之后、`workspace-controller` 之前；与插件条目一样受保留 id 去重。
   */
  toolEntries?: PatchEntry[]
  /**
   * 是否下发「普通对话」预设（WP40d；系统设置 container.chatPreset）。
   * true = 在 managed patch 里插入 preset-chat 行并把注册表默认预设改成 chat。
   */
  chatPreset?: boolean
  now: string
}

export interface RenderManagedOutput {
  /** managed.patch.yml 全文（顶层 YAML 数组，永不为空） */
  content: string
  warnings: string[]
}

export interface ManagedManifest {
  userId: number
  slug: string
  presetId: number | null
  presetRevision: number | null
  runtimeVersion: string | null
  plugins: { packageName: string; version: string }[]
  generatedAt: string
}

/** `llm-pi-ai.config.providers.<routeKey>` 的配置对象（字段名照 pi-ai 的 schema：`baseURL`、`apiKeyEnv`） */
export function providerEntryConfig(
  provider: RenderProviderInput,
  warnings: string[],
): Record<string, unknown> {
  const config: Record<string, unknown> = { displayName: provider.displayName }
  if (provider.api) config.api = provider.api
  if (provider.baseUrl) config.baseURL = provider.baseUrl
  const apiKeyEnv =
    provider.apiKeyEnv === undefined
      ? provider.keyMode === 'none'
        ? null
        : providerKeyEnvName(provider.routeKey)
      : provider.apiKeyEnv
  if (apiKeyEnv) config.apiKeyEnv = apiKeyEnv
  if (provider.models.length === 0) {
    warnings.push(`提供方 ${provider.routeKey} 没有配置模型，DSH 会拒绝这条路由`)
  } else {
    config.models = provider.models.map((model) => modelEntryConfig(provider.routeKey, model, warnings))
  }
  if (provider.compat && Object.keys(provider.compat).length > 0) config.compat = provider.compat
  if (provider.extra) Object.assign(config, provider.extra)
  return config
}

function modelEntryConfig(
  routeKey: string,
  model: RenderModelSpec,
  warnings: string[],
): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: model.id, name: model.name }
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow
  if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens
  // 输入类型：pi-ai 的 `input`，取值 text / image；不写 = 由 pi-ai 目录或路由默认值（文字）决定
  if (model.input && model.input.length > 0) entry.input = [...new Set(model.input)]
  if (model.compat && Object.keys(model.compat).length > 0) entry.compat = model.compat
  if (model.reasoningEfforts && model.reasoningEfforts.length > 0) {
    // pi-ai 的 reasoningEfforts 是 `{档位: 线上取值}` 的字典；目录里存的是档位数组，这里映射成同名取值。
    // off 写 null：pi-ai 读作「可以关闭思考，关闭时不发思考参数」（deepseek 格式会发 thinking.type=disabled）；
    // 写成 "off" 会把字符串 off 原样发上线，openai 协议下是非法值。
    // 非法档位、只有 off 的声明都直接丢掉并告警（写进 patch 会让 DSH 启动时校验失败，整台实例起不来）。
    const dict: Record<string, string | null> = {}
    for (const level of model.reasoningEfforts) {
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
        warnings.push(`模型 ${routeKey}/${model.id} 的思考档位 "${level}" 不被 DSH 支持，已忽略`)
      } else {
        dict[level] = level === 'off' ? null : level
      }
    }
    if (Object.keys(dict).some((level) => level !== 'off')) {
      entry.reasoningEfforts = dict
    } else if (Object.keys(dict).length > 0) {
      warnings.push(`模型 ${routeKey}/${model.id} 只声明了 "off"，至少还要一个思考档位，已忽略`)
    }
  }
  return entry
}

/** 模型条目（llm-pi-ai + agent-default-model）；free 策略或没有可用预设时返回空数组 */
export function modelEntries(preset: RenderPresetInput | null, warnings: string[]): PatchEntry[] {
  if (!preset) return []
  const enabled = preset.providers.filter((provider) => provider.enabled)
  const piAi = enabled.filter((provider) => provider.kind === 'pi-ai')
  const entries: PatchEntry[] = []
  if (piAi.length > 0) {
    const providers: Record<string, unknown> = {}
    for (const provider of piAi) {
      if (!provider.api || !provider.baseUrl) {
        warnings.push(
          `提供方 ${provider.routeKey} 缺少 ${provider.api ? 'baseUrl' : 'api'}，DSH 会拒绝这条路由`,
        )
      }
      providers[provider.routeKey] = providerEntryConfig(provider, warnings)
    }
    entries.push({ id: 'llm-pi-ai', config: { providers } })
  }
  const defaultProvider = enabled.find((provider) => provider.routeKey === preset.defaultProvider)
  if (!defaultProvider) {
    warnings.push(`预设的默认提供方 ${preset.defaultProvider} 不在启用的提供方里，默认模型可能不可用`)
  }
  // WP13：默认模型在这条路由里渲染出来了才写 reasoningEffort（档位就是这条路由的档位）；
  // 对该用户不可见（admin-only / 路由被跳过）时不写，免得 DSH 拿到一个它没有的模型档位
  const defaultModelRendered =
    defaultProvider?.models.some((model) => model.id === preset.defaultModel) === true
  const defaultThinking = defaultProvider?.thinking ?? null
  entries.push({
    id: 'agent-default-model',
    config: {
      provider: preset.defaultProvider,
      model: preset.defaultModel,
      ...(defaultModelRendered && defaultThinking !== null ? { reasoningEffort: defaultThinking } : {}),
    },
  })
  return entries
}

/** 渲染 `managed.patch.yml` 全文（纯函数） */
export function renderManagedPatch(input: RenderManagedInput): RenderManagedOutput {
  const warnings: string[] = []
  const { user, preset, plugins, now } = input
  const managed = user.modelPolicy === 'managed' && preset !== null

  const header: string[] = []
  if (managed && preset) {
    header.push(`# 由 DSH Hub 生成，请勿手改 —— preset "${preset.name}" r${String(preset.revision)} · ${now}`)
  } else if (user.modelPolicy === 'free') {
    header.push(`# 由 DSH Hub 生成，请勿手改 —— 模型由用户在 DSH 里自行配置（model_policy=free）`)
  } else {
    header.push('# 由 DSH Hub 生成，请勿手改 —— 还没有可用的模型预设')
  }
  header.push(`# 用户 ${user.slug} · runtime ${user.runtimeVersion ?? '未知'}`)

  const hubEntries: PatchEntry[] = managed && preset ? modelEntries(preset, warnings) : []
  // 搜索 / 抓取池（14 §5）：与模型策略无关（free 用户也能用 Hub 托管的搜索）
  if (input.toolEntries && input.toolEntries.length > 0) hubEntries.push(...input.toolEntries)
  // 「普通对话」预设（WP40d）：手机 App 的用户实例默认带它；管理员可在系统设置里关掉
  if (input.chatPreset === true) hubEntries.push(...chatPresetEntries())
  hubEntries.push(WORKSPACE_CONTROLLER_ENTRY)
  hubEntries.push(...DISABLED_DSH_ENTRIES)

  const blocks: string[] = [header.join('\n'), stringifyPatchEntries(hubEntries).trimEnd()]

  // 插件配置：逐个插件单独解析，坏配置只跳过它自己（不能让一个插件的 YAML 拖垮整台实例）
  const okSources: { packageName: string; yaml: string }[] = []
  const ordered = [...plugins].sort((a, b) => a.bundleOrder - b.bundleOrder)
  for (const plugin of ordered) {
    if (plugin.configYaml.trim().length === 0) continue
    try {
      const single = renderPatchEntryBlocks(
        [{ packageName: plugin.packageName, yaml: plugin.configYaml }],
        RESERVED_ENTRY_IDS,
      )
      warnings.push(...single.warnings)
      if (single.text.trim().length > 0)
        okSources.push({ packageName: plugin.packageName, yaml: plugin.configYaml })
    } catch (error) {
      warnings.push(
        `插件 ${plugin.packageName} 的 configYaml 无法渲染，已跳过：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (okSources.length > 0) {
    // 合并时再跑一次去重：跨插件的重复 id 也要按「后者覆盖前者」处理
    const merged = renderPatchEntryBlocks(okSources, RESERVED_ENTRY_IDS)
    warnings.push(...merged.warnings)
    if (merged.text.trim().length > 0) blocks.push(merged.text.trimEnd())
  }

  return { content: `${blocks.join('\n')}\n`, warnings: dedupeStrings(warnings) }
}

/** manifest.json 的内容（03 §2：渲染来源与版本） */
export function buildManifest(input: RenderManagedInput): ManagedManifest {
  return {
    userId: input.user.id,
    slug: input.user.slug,
    presetId: input.preset?.id ?? null,
    presetRevision: input.preset?.revision ?? null,
    runtimeVersion: input.user.runtimeVersion,
    plugins: input.plugins
      .map((plugin) => ({ packageName: plugin.packageName, version: plugin.version ?? '' }))
      .filter((plugin) => plugin.version.length > 0)
      .sort((a, b) => (a.packageName < b.packageName ? -1 : 1)),
    generatedAt: input.now,
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}
