import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CockpitSettingsSchema,
  ROUTE_KEY_REGEX,
  THINKING_LEVELS,
  providerKeyEnvName,
  type CatalogEntry,
  type CatalogEntryInput,
  type CatalogResponse,
  type CreatePresetRequest,
  type CreateProviderRequest,
  type DiscoveredModel,
  type DiscoverModelsRequest,
  type DiscoverModelsResponse,
  type MatchModelsResponse,
  type ModelApi,
  type ModelInfo,
  type ModelInput,
  type ModelSpec,
  type ModelKeyInfo,
  type ModelPreset,
  type ModelProvider,
  type Platform,
  type PresetPreviewResponse,
  type TestProviderResponse,
  type ThinkingLevel,
  type UpdatePresetRequest,
  type UpdateProviderRequest,
  type UserProviderKey,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { decryptSecret, encryptSecret, keyLast4 } from '../../lib/crypto.js'
import { HubError } from '../../lib/errors.js'
import { isSystemUserId } from '../../lib/system-account.js'
import { withUserLock } from '../../lib/locks.js'
import { loadMasterKeyIfExists } from '../../lib/secrets.js'
import { listInstalledPluginConfigs } from '../plugins/repo.js'
import { LABEL_CONFIG_HASH, containerNameFor, computeConfigHash } from '../instances/index.js'
import { desktopPresetNameOf, isSystemRouteName } from '../relay/dsh.js'
import { BUILTIN_CATALOG, BUILTIN_CATALOG_SOURCE } from './catalog-data.js'
import { createCatalogMatcher, normalizeModelKey, type CatalogMatcher } from './catalog.js'
import {
  buildManifest,
  modelEntries,
  renderManagedPatch,
  DSH_HUB_KEY_ENV_NAME,
  type RenderManagedOutput,
  type RenderModelSpec,
  type RenderPluginInput,
  type RenderPresetInput,
  type RenderProviderInput,
} from './render.js'
import {
  clearAllUserPresets,
  clearDefaultPresets,
  countEnabledRelayProvidersIn,
  countProviderUserKeys,
  countRelayProviderRows,
  listPerUserProviderRows,
  listRelayProviderRows,
  countUsersOnPreset,
  countUsersOnProvider,
  deletePresetRow,
  deleteCatalogRow,
  deleteProviderRow,
  deleteUserProviderKeyRow,
  getDefaultPresetRow,
  getPresetRow,
  getPresetRowByName,
  getProviderRow,
  getProviderRowByRoute,
  getUserModelTarget,
  getUserProviderKeyRow,
  insertPresetRow,
  insertProviderRow,
  listCatalogRows,
  listPresetRows,
  listProviderRows,
  parseModels,
  parseJsonColumn,
  parseProviderIds,
  setUserPreset,
  toCatalogRecord,
  toModelPreset,
  toModelProvider,
  updatePresetRow,
  updateProviderRow,
  upsertCatalogRow,
  upsertUserProviderKeyRow,
  type ModelPresetRow,
  type ModelProviderRow,
  type UpdateProviderInput,
} from './repo.js'
import type {
  AgentModeEnvProvider,
  ModelService,
  RelayBridge,
  RenderManagedResult,
  SystemPresetSpec,
  SystemPresetSyncResult,
} from './types.js'

/**
 * models 模块（04 §4.7、06 §4；WP3 实现）。
 *
 * 渲染分两层：`render.ts` 是**纯函数**（单元测试覆盖），这里负责取数据、解密密钥、写文件、
 * 决定要不要重启/重建容器。密钥明文只出现在 `containerEnv()` 的返回值里（进容器 env），
 * 永不进 managed.patch.yml、日志或 API 响应。
 */
export function createModelService(deps: BaseDeps): ModelService {
  const db = deps.db
  /** hub-relay 的晚绑定桥（relay 模块启动时注册，12 §7.7） */
  let relayBridge: RelayBridge | null = null
  /** 18 §4.1：Claude Code / Codex 的容器 env（agent-modes 模块晚绑定注册） */
  let agentModeEnv: AgentModeEnvProvider | null = null

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  function masterKey(): Buffer {
    const key = loadMasterKeyIfExists(deps.paths.masterKeyFile)
    if (!key) throw new HubError('INTERNAL', '主密钥不可用，无法读写模型密钥')
    return key
  }

  function encrypt(plain: string): string {
    return encryptSecret(plain, masterKey())
  }

  function decrypt(payload: string): string {
    return decryptSecret(payload, masterKey())
  }

  function audit(entry: {
    actorId?: number | null
    meta?: RequestMeta
    action: string
    targetType: 'provider' | 'preset' | 'catalog'
    targetId: number
    detail?: Record<string, unknown>
  }): void {
    deps.audit.log({
      actorId: entry.actorId ?? null,
      actorIp: entry.meta?.ip ?? null,
      action: entry.action,
      targetType: `model.${entry.targetType}`,
      targetId: entry.targetId,
      detail: entry.detail ?? null,
    })
  }

  // ── 提供方 ────────────────────────────────────────────────────────────────

  function keyInfo(row: ModelProviderRow): ModelKeyInfo {
    if (row.key_mode === 'shared') {
      if (!row.api_key_enc) return { set: false, last4: null }
      try {
        return { set: true, last4: keyLast4(decrypt(row.api_key_enc)) }
      } catch {
        // 主密钥换了/密文坏了：只报「已设置」，不因为一个坏密钥让整个列表 500
        return { set: true, last4: null }
      }
    }
    if (row.key_mode === 'per-user') {
      return { set: countProviderUserKeys(db, row.id) > 0, last4: null }
    }
    return { set: false, last4: null }
  }

  /** `RenderModelSpec` → DTO 的 `ModelSpec`（模型级 compat 只进 patch，不进 REST DTO） */
  function toModelSpec(model: RenderModelSpec): ModelSpec {
    return {
      id: model.id,
      name: model.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.input === undefined ? {} : { input: model.input }),
      ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
    }
  }

  /**
   * hub-relay 渲染进 DSH 的 baseURL：pi-ai 把它原样交给各家 SDK。OpenAI 的 SDK 直接拼 `/chat/completions`、`/responses`，
   * 所以给 `…/v1`；**Anthropic 的 SDK 自己再拼 `/v1/messages`**，给 `…/v1` 会变成 `/v1/v1/messages` → 中转站 404，
   * 所以 anthropic-messages 要去掉末尾的 `/v1`（WP12 联调用 DSH 自带的 pi-ai 实测确认）。
   */
  function relayBaseUrlFor(api: ModelProviderRow['api']): string | null {
    const base = relayBridge?.internalBaseUrl() ?? null
    if (base === null || api !== 'anthropic-messages') return base
    return base.replace(/\/+$/u, '').replace(/\/v1$/u, '')
  }

  function providerDto(row: ModelProviderRow): ModelProvider {
    const dto = toModelProvider(row, keyInfo(row))
    if (dto.kind !== 'hub-relay') return dto
    // hub-relay：baseUrl / models / keyMode / apiKey 全由 Hub 决定（12 §7.2），请求里给了也忽略。
    // WP13：系统路由（hub / hub-<档位> / hub-anthropic…）只显示该路由档位下的模型；
    // 旧的手工 hub-relay 提供方保持 WP12 的「只按协议」口径。
    const systemRoute = isSystemRoute(row)
    const relayModels =
      relayBridge && dto.api
        ? relayBridge
            .providerModels(dto.api, {
              admin: true,
              ...(systemRoute ? { thinking: routeThinking(row) } : {}),
            })
            .map(toModelSpec)
        : []
    return {
      ...dto,
      baseUrl: relayBaseUrlFor(dto.api ?? null),
      models: relayModels,
      keyMode: 'per-user',
      apiKey: { set: true, last4: null },
    }
  }

  /** 系统路由（12 §7.0：路由名 `hub[-anthropic|-responses][-<档位>]`）——只有这些由 Hub 托管 */
  function isSystemRoute(row: ModelProviderRow): boolean {
    return row.is_relay === 1 && isSystemRouteName(row.route_key)
  }

  /** 系统路由的默认思考档位（存在 `extra_json.reasoning`；坏值当作没设） */
  function routeThinking(row: ModelProviderRow): ThinkingLevel | null {
    const extra = parseJsonColumn<Record<string, unknown> | null>(row.extra_json, null)
    const value = extra?.reasoning
    return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
      ? (value as ThinkingLevel)
      : null
  }

  /** 系统提供方要写的 extra：带档位的路由渲染成 provider 配置里的 `reasoning`（12 §7.0） */
  function systemProviderExtra(thinking: ThinkingLevel | null): Record<string, unknown> | null {
    return thinking === null ? null : { reasoning: thinking }
  }

  function requireProvider(providerId: number): ModelProviderRow {
    const row = getProviderRow(db, providerId)
    if (!row) throw new HubError('NOT_FOUND', '模型提供方不存在')
    return row
  }

  function validateProviderInput(
    input: CreateProviderRequest | UpdateProviderRequest,
    partial: boolean,
  ): void {
    if (input.routeKey !== undefined && !ROUTE_KEY_REGEX.test(input.routeKey)) {
      throw new HubError('VALIDATION_FAILED', '路由名不合法', {
        fields: { routeKey: '只能是小写字母、数字和 -，且以字母开头' },
      })
    }
    if (input.kind === 'hub-relay') {
      // hub-relay 只认 routeKey/displayName/api/compat/extra/enabled，baseUrl/models/密钥由 Hub 决定
      if (input.api === undefined && !partial) {
        throw new HubError('VALIDATION_FAILED', 'Hub 中转站提供方必须指定协议', { fields: { api: '必填' } })
      }
      return
    }
    if (input.kind === 'pi-ai') {
      const api = input.api
      const baseUrl = input.baseUrl
      if (api === undefined && !partial) {
        throw new HubError('VALIDATION_FAILED', 'pi-ai 提供方必须指定协议', { fields: { api: '必填' } })
      }
      if (baseUrl === undefined && !partial) {
        throw new HubError('VALIDATION_FAILED', 'pi-ai 提供方必须指定 baseUrl', {
          fields: { baseUrl: '必填' },
        })
      }
      if (baseUrl !== undefined && baseUrl !== '' && !/^https?:\/\//u.test(baseUrl)) {
        throw new HubError('VALIDATION_FAILED', 'baseUrl 必须是 http(s) 地址', {
          fields: { baseUrl: '格式不对' },
        })
      }
    }
  }

  async function listProviders(): Promise<ModelProvider[]> {
    return listProviderRows(db).map(providerDto)
  }

  async function createProvider(
    input: CreateProviderRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ModelProvider> {
    validateProviderInput(input, false)
    if (getProviderRowByRoute(db, input.routeKey)) {
      throw new HubError('CONFLICT', `路由名 ${input.routeKey} 已被占用`)
    }
    const isRelay = input.kind === 'hub-relay'
    if (!isRelay && input.keyMode === 'shared' && !input.apiKey) {
      throw new HubError('VALIDATION_FAILED', '共享密钥模式必须提供 apiKey', { fields: { apiKey: '必填' } })
    }
    const id = insertProviderRow(db, {
      routeKey: input.routeKey,
      displayName: input.displayName,
      // 库里存 pi-ai + is_relay=1（迁移 044；改 kind 的 CHECK 要重建表，风险大）
      kind: isRelay ? 'pi-ai' : input.kind,
      api: input.api ?? null,
      baseUrl: isRelay ? null : (input.baseUrl ?? null),
      models: isRelay ? [] : (input.models ?? []),
      compat: input.compat ?? null,
      extra: input.extra ?? null,
      keyMode: isRelay ? 'per-user' : input.keyMode,
      apiKeyEnc: !isRelay && input.apiKey ? encrypt(input.apiKey) : null,
      enabled: true,
      isRelay,
      at: deps.clock.nowIso(),
    })
    audit({
      actorId,
      meta,
      action: 'model.provider.create',
      targetType: 'provider',
      targetId: id,
      detail: { routeKey: input.routeKey, kind: input.kind, keyMode: input.keyMode },
    })
    if (input.apiKey) {
      audit({ actorId, meta, action: 'model.provider.key.change', targetType: 'provider', targetId: id })
    }
    notifySystemPresetsMutated()
    return providerDto(requireProvider(id))
  }

  async function updateProvider(
    providerId: number,
    input: UpdateProviderRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ModelProvider> {
    const row = requireProvider(providerId)
    validateProviderInput(input, true)
    if (input.routeKey !== undefined && input.routeKey !== row.route_key) {
      if (getProviderRowByRoute(db, input.routeKey)) {
        throw new HubError('CONFLICT', `路由名 ${input.routeKey} 已被占用`)
      }
    }
    // hub-relay 的 baseUrl/models/密钥由 Hub 决定：请求里给了也忽略（12 §7.1）
    const targetRelay = input.kind === undefined ? row.is_relay === 1 : input.kind === 'hub-relay'
    const patch: Parameters<typeof updateProviderRow>[2] = {
      ...(input.routeKey === undefined ? {} : { routeKey: input.routeKey }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.kind === undefined ? {} : { kind: targetRelay ? 'pi-ai' : input.kind }),
      ...(input.api === undefined ? {} : { api: input.api }),
      ...(input.compat === undefined ? {} : { compat: input.compat }),
      ...(input.extra === undefined ? {} : { extra: input.extra }),
      ...(input.kind === undefined ? {} : { isRelay: targetRelay }),
      ...(targetRelay
        ? row.is_relay === 1
          ? {}
          : { baseUrl: null, models: [], keyMode: 'per-user', apiKeyEnc: null }
        : {
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.models === undefined ? {} : { models: input.models }),
            ...(input.keyMode === undefined ? {} : { keyMode: input.keyMode }),
            ...(input.apiKey === undefined ? {} : { apiKeyEnc: input.apiKey ? encrypt(input.apiKey) : null }),
          }),
    }
    updateProviderRow(db, providerId, patch, deps.clock.nowIso())
    audit({
      actorId,
      meta,
      action: 'model.provider.update',
      targetType: 'provider',
      targetId: providerId,
      detail: { fields: Object.keys(patch).filter((field) => field !== 'apiKeyEnc') },
    })
    if (input.apiKey !== undefined) {
      audit({
        actorId,
        meta,
        action: 'model.provider.key.change',
        targetType: 'provider',
        targetId: providerId,
      })
    }
    notifySystemPresetsMutated()
    return providerDto(requireProvider(providerId))
  }

  async function deleteProvider(providerId: number, actorId: number, meta: RequestMeta): Promise<void> {
    const row = requireProvider(providerId)
    const users = countUsersOnProvider(db, providerId)
    if (users > 0) {
      throw new HubError('CONFLICT', `还有 ${String(users)} 个用户的预设引用了该提供方，不能删除`)
    }
    const presets = listPresetRows(db).filter((preset) =>
      parseProviderIds(preset.provider_ids_json).includes(providerId),
    )
    if (presets.length > 0) {
      throw new HubError('CONFLICT', `预设「${presets[0]!.name}」还在引用该提供方，不能删除`)
    }
    deleteProviderRow(db, providerId)
    audit({
      actorId,
      meta,
      action: 'model.provider.delete',
      targetType: 'provider',
      targetId: providerId,
      detail: { routeKey: row.route_key },
    })
    notifySystemPresetsMutated()
  }

  // ── 连接测试 / 发现模型（06 §4.1） ────────────────────────────────────────

  function endpointFor(api: ModelApi, baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/u, '')
    if (api === 'anthropic-messages') {
      return base.endsWith('/v1') ? `${base}/models?limit=1000` : `${base}/v1/models?limit=1000`
    }
    return `${base}/models`
  }

  function headersFor(api: ModelApi, apiKey: string | null): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (!apiKey) return headers
    if (api === 'anthropic-messages') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.authorization = `Bearer ${apiKey}`
    }
    return headers
  }

  /** 端点列表里能读到的模型信息（字段名照 pi-ai 的发现解析：各家网关写法不一，取第一个正整数） */
  interface ProbedModel {
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    input?: ModelInput[]
  }

  interface ProbeResult {
    ok: boolean
    latencyMs: number
    models: ProbedModel[]
    error?: string
  }

  function capacity(...values: unknown[]): number | undefined {
    for (const value of values) {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
    }
    return undefined
  }

  function probedModel(item: object): ProbedModel | null {
    const entry = item as Record<string, unknown> & {
      limit?: { context?: unknown; output?: unknown }
      top_provider?: { max_completion_tokens?: unknown }
      architecture?: { input_modalities?: unknown }
    }
    const id = entry.id ?? entry.name
    if (typeof id !== 'string' || id.length === 0) return null
    const name = entry.name
    const contextWindow = capacity(
      entry.contextWindow,
      entry.context_window,
      entry.context_length,
      entry.max_input_tokens,
      entry.limit?.context,
    )
    const maxTokens = capacity(
      entry.maxOutputTokens,
      entry.max_output_tokens,
      entry.maxTokens,
      entry.max_tokens,
      entry.limit?.output,
      entry.top_provider?.max_completion_tokens,
    )
    const modalities = entry.architecture?.input_modalities
    const input = Array.isArray(modalities)
      ? (['text', 'image'] as const).filter((kind) => modalities.includes(kind))
      : []
    return {
      id,
      name: typeof name === 'string' && name.length > 0 ? name : id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input.length > 0 ? { input } : {}),
    }
  }

  async function probeEndpoint(
    api: ModelApi,
    baseUrl: string,
    apiKey: string | null,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ProbeResult> {
    const url = endpointFor(api, baseUrl)
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    timer.unref?.()
    try {
      const response = await fetchImpl(url, { headers: headersFor(api, apiKey), signal: controller.signal })
      const latencyMs = Date.now() - started
      if (!response.ok) {
        return { ok: false, latencyMs, models: [], error: `HTTP ${String(response.status)}` }
      }
      const body = (await response.json()) as { data?: unknown; models?: unknown }
      const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
      const models: ProbedModel[] = []
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue
        const model = probedModel(item)
        if (model) models.push(model)
      }
      return { ok: true, latencyMs, models }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function testProvider(providerId: number): Promise<TestProviderResponse> {
    const row = requireProvider(providerId)
    const api: ModelApi =
      row.kind === 'deepseek-official' ? 'openai-completions' : (row.api ?? 'openai-completions')
    const baseUrl = row.base_url ?? (row.kind === 'deepseek-official' ? 'https://api.deepseek.com' : '')
    if (!baseUrl) return { ok: false, latencyMs: 0, error: '还没有配置 baseUrl' }
    let apiKey: string | null = null
    if (row.api_key_enc) {
      try {
        apiKey = decrypt(row.api_key_enc)
      } catch {
        return { ok: false, latencyMs: 0, error: '已保存的密钥无法解密（主密钥可能更换过）' }
      }
    }
    const result = await probeEndpoint(api, baseUrl, apiKey)
    return {
      ok: result.ok,
      latencyMs: result.latencyMs,
      ...(result.ok ? { models: result.models.map((model) => model.id) } : {}),
      ...(result.error ? { error: result.error } : {}),
    }
  }

  async function discover(input: DiscoverModelsRequest): Promise<DiscoverModelsResponse> {
    if (!/^https?:\/\//u.test(input.baseUrl)) {
      throw new HubError('VALIDATION_FAILED', 'baseUrl 必须是 http(s) 地址')
    }
    const result = await probeEndpoint(input.api, input.baseUrl, input.apiKey ?? null)
    if (!result.ok) {
      throw new HubError('UPSTREAM_ERROR', `无法从端点发现模型：${result.error ?? '未知错误'}`)
    }
    const matcher = catalogMatcher()
    return { models: result.models.map((model) => enrichDiscovered(model, matcher)) }
  }

  // ── 模型信息库（按模型名补全上下文 / 输出上限 / 输入类型 / 思考档位）──────

  function catalogMatcher(): CatalogMatcher {
    const custom = listCatalogRows(db)
      .map(toCatalogRecord)
      .map((record) => ({ id: record.modelId, ...record.info }))
    return createCatalogMatcher(custom, BUILTIN_CATALOG)
  }

  /** 端点自己报的值最准（它就是这个网关），其次自定义条目，最后内置库 */
  function enrichDiscovered(model: ProbedModel, matcher: CatalogMatcher): DiscoveredModel {
    const hit = matcher.match(model.id)
    const info = hit?.info
    const contextWindow = model.contextWindow ?? info?.contextWindow
    const maxTokens = model.maxTokens ?? info?.maxTokens
    const input = model.input ?? info?.input
    const reasoningEfforts = info?.reasoningEfforts
    // 端点没给显示名时 name 就是 id；库里有更好看的名字就用库里的
    const name = model.name !== model.id ? model.name : (info?.name ?? model.id)
    const fromUpstream = model.contextWindow !== undefined || model.maxTokens !== undefined || model.input
    const infoSource = hit ? hit.source : fromUpstream ? ('upstream' as const) : undefined
    return {
      id: model.id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input ? { input } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(infoSource ? { infoSource } : {}),
      ...(hit ? { matchedId: hit.matchedId } : {}),
    }
  }

  /** 保存前的整理：去空、档位按强度排序去重、非法档位 / 只有 off 直接拒绝（和渲染层、前端同一条规则） */
  function sanitizeCatalogInfo(entry: CatalogEntryInput): ModelInfo {
    const info: ModelInfo = {}
    const name = entry.name?.trim()
    if (name) info.name = name
    if (entry.contextWindow !== undefined) info.contextWindow = entry.contextWindow
    if (entry.maxTokens !== undefined) info.maxTokens = entry.maxTokens
    const input = (['text', 'image'] as const).filter((kind) => entry.input?.includes(kind))
    if (input.length > 0) info.input = input
    if (entry.reasoningEfforts && entry.reasoningEfforts.length > 0) {
      const unknown = entry.reasoningEfforts.find(
        (level) => !(THINKING_LEVELS as readonly string[]).includes(level),
      )
      if (unknown) {
        throw new HubError('VALIDATION_FAILED', `模型 ${entry.id} 的思考档位 "${unknown}" 不被 DSH 支持`, {
          fields: { reasoningEfforts: `不支持的档位 ${unknown}` },
        })
      }
      const levels = THINKING_LEVELS.filter((level) => entry.reasoningEfforts!.includes(level))
      if (!levels.some((level) => level !== 'off')) {
        throw new HubError(
          'VALIDATION_FAILED',
          `模型 ${entry.id} 只勾了 off：至少再选一个思考档位，或者留空表示不支持思考`,
          { fields: { reasoningEfforts: '至少需要一个 off 之外的档位' } },
        )
      }
      info.reasoningEfforts = levels
    }
    return info
  }

  async function getCatalog(): Promise<CatalogResponse> {
    const custom: CatalogEntry[] = listCatalogRows(db)
      .map(toCatalogRecord)
      .map((record) => ({
        ...record.info,
        id: record.modelId,
        key: record.key,
        updatedAt: record.updatedAt,
      }))
    return { custom, builtin: { count: BUILTIN_CATALOG.length, source: BUILTIN_CATALOG_SOURCE } }
  }

  async function saveCatalog(
    entries: CatalogEntryInput[],
    actorId: number,
    meta: RequestMeta,
  ): Promise<CatalogResponse> {
    const prepared = entries.map((entry) => {
      const id = entry.id.trim()
      const key = normalizeModelKey(id)
      if (!key) {
        throw new HubError('VALIDATION_FAILED', `模型名 "${entry.id}" 里没有可用于匹配的字符`, {
          fields: { id: '无效的模型名' },
        })
      }
      const info = sanitizeCatalogInfo({ ...entry, id })
      if (Object.keys(info).length === 0) {
        throw new HubError('VALIDATION_FAILED', `模型 ${id} 没有填任何信息`, {
          fields: { id: '至少填一项信息' },
        })
      }
      return { key, id, info }
    })
    const at = deps.clock.nowIso()
    db.tx(() => {
      for (const item of prepared) upsertCatalogRow(db, item.key, item.id, item.info, at)
    })
    audit({
      actorId,
      meta,
      action: 'model.catalog.change',
      targetType: 'catalog',
      targetId: 0,
      detail: { keys: prepared.map((item) => item.key) },
    })
    return getCatalog()
  }

  async function deleteCatalogEntry(key: string, actorId: number, meta: RequestMeta): Promise<void> {
    if (!deleteCatalogRow(db, key)) throw new HubError('NOT_FOUND', '模型库里没有这一条')
    audit({
      actorId,
      meta,
      action: 'model.catalog.change',
      targetType: 'catalog',
      targetId: 0,
      detail: { removed: key },
    })
  }

  async function matchModels(ids: string[]): Promise<MatchModelsResponse> {
    const matcher = catalogMatcher()
    const matches: MatchModelsResponse['matches'] = []
    for (const id of new Set(ids)) {
      const hit = matcher.match(id)
      if (hit) matches.push({ ...hit.info, id, source: hit.source, matchedId: hit.matchedId })
    }
    return { matches }
  }

  // ── per-user 密钥 ─────────────────────────────────────────────────────────

  async function setUserProviderKey(
    providerId: number,
    userId: number,
    apiKey: string,
    actorId: number,
    meta: RequestMeta,
  ): Promise<void> {
    const row = requireProvider(providerId)
    if (row.key_mode !== 'per-user') {
      throw new HubError('CONFLICT', '该提供方不是「每用户独立密钥」模式')
    }
    const user = getUserModelTarget(db, userId)
    if (!user) throw new HubError('NOT_FOUND', '用户不存在')
    upsertUserProviderKeyRow(db, providerId, userId, encrypt(apiKey), deps.clock.nowIso())
    audit({
      actorId,
      meta,
      action: 'model.provider.key.change',
      targetType: 'provider',
      targetId: providerId,
      detail: { userId },
    })
  }

  async function deleteUserProviderKey(
    providerId: number,
    userId: number,
    actorId: number,
    meta: RequestMeta,
  ): Promise<void> {
    requireProvider(providerId)
    deleteUserProviderKeyRow(db, providerId, userId)
    audit({
      actorId,
      meta,
      action: 'model.provider.key.change',
      targetType: 'provider',
      targetId: providerId,
      detail: { userId, removed: true },
    })
  }

  // ── 预设 ──────────────────────────────────────────────────────────────────

  function presetDto(row: ModelPresetRow): ModelPreset {
    return toModelPreset(row, countUsersOnPreset(db, row.id))
  }

  function requirePreset(presetId: number): ModelPresetRow {
    const row = getPresetRow(db, presetId)
    if (!row) throw new HubError('NOT_FOUND', '模型预设不存在')
    return row
  }

  function assertProvidersExist(providerIds: number[]): void {
    for (const id of providerIds) requireProvider(id)
  }

  function assertDefaultModel(providerIds: number[], defaultProvider: string, defaultModel: string): void {
    const providers = providerIds.map((id) => requireProvider(id))
    const target = providers.find((provider) => provider.route_key === defaultProvider)
    if (!target) {
      throw new HubError('VALIDATION_FAILED', '默认提供方必须在预设的提供方列表里', {
        fields: { defaultProvider: '不在 providerIds 里' },
      })
    }
    if (target.kind === 'pi-ai') {
      const models = parseModels(target.models_json)
      if (models.length > 0 && !models.some((model) => model.id === defaultModel)) {
        throw new HubError('VALIDATION_FAILED', `提供方 ${defaultProvider} 里没有模型 ${defaultModel}`, {
          fields: { defaultModel: '不在该提供方的模型列表里' },
        })
      }
    }
  }

  async function listPresets(platform?: Platform): Promise<ModelPreset[]> {
    return listPresetRows(db, platform).map(presetDto)
  }

  async function createPreset(
    input: CreatePresetRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ModelPreset> {
    // docs/22 §3：预设按平台，名字只在平台内唯一（缺省云上，旧调用行为不变）
    const platform: Platform = input.platform ?? 'cloud'
    if (getPresetRowByName(db, input.name, platform)) {
      throw new HubError('CONFLICT', `预设名 ${input.name} 已存在`)
    }
    assertProvidersExist(input.providerIds)
    assertDefaultModel(input.providerIds, input.defaultProvider, input.defaultModel)
    const at = deps.clock.nowIso()
    const id = db.tx(() => {
      // 第一个预设自动成为默认（否则「设为默认」得手动点一次）
      const isFirst = listPresetRows(db, platform).length === 0
      const isDefault = input.isDefault === true || isFirst
      if (isDefault) clearDefaultPresets(db, undefined, platform)
      return insertPresetRow(db, {
        name: input.name,
        description: input.description ?? '',
        providerIds: input.providerIds,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel,
        isDefault,
        at,
        platform,
      })
    })
    audit({
      actorId,
      meta,
      action: 'model.preset.create',
      targetType: 'preset',
      targetId: id,
      detail: { name: input.name, platform },
    })
    notifySystemPresetsMutated()
    return presetDto(requirePreset(id))
  }

  async function updatePreset(
    presetId: number,
    input: UpdatePresetRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ModelPreset> {
    const row = requirePreset(presetId)
    if (input.name !== undefined && input.name !== row.name) {
      if (getPresetRowByName(db, input.name, row.platform)) {
        throw new HubError('CONFLICT', `预设名 ${input.name} 已存在`)
      }
    }
    const providerIds = input.providerIds ?? parseProviderIds(row.provider_ids_json)
    const defaultProvider = input.defaultProvider ?? row.default_provider
    const defaultModel = input.defaultModel ?? row.default_model
    assertProvidersExist(providerIds)
    assertDefaultModel(providerIds, defaultProvider, defaultModel)
    const at = deps.clock.nowIso()
    db.tx(() => {
      if (input.isDefault === true) clearDefaultPresets(db, presetId, row.platform)
      updatePresetRow(
        db,
        presetId,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.providerIds === undefined ? {} : { providerIds: input.providerIds }),
          ...(input.defaultProvider === undefined ? {} : { defaultProvider: input.defaultProvider }),
          ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
          ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
        },
        at,
      )
    })
    audit({
      actorId,
      meta,
      action: 'model.preset.update',
      targetType: 'preset',
      targetId: presetId,
      detail: { fields: Object.keys(input) },
    })
    notifySystemPresetsMutated()
    return presetDto(requirePreset(presetId))
  }

  async function deletePreset(presetId: number, actorId: number, meta: RequestMeta): Promise<void> {
    const row = requirePreset(presetId)
    if (row.is_default === 1) throw new HubError('CONFLICT', '默认预设不能删除，请先把别的预设设为默认')
    const users = countUsersOnPreset(db, presetId)
    if (users > 0) throw new HubError('CONFLICT', `还有 ${String(users)} 个用户在用该预设，不能删除`)
    deletePresetRow(db, presetId)
    audit({
      actorId,
      meta,
      action: 'model.preset.delete',
      targetType: 'preset',
      targetId: presetId,
      detail: { name: row.name },
    })
    notifySystemPresetsMutated()
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  interface RenderContext {
    userId?: number
    admin: boolean
    /** 本次渲染是否用到了 hub-relay（用于清「模型待下发」告警） */
    relayUsed?: { value: boolean }
  }

  function presetRenderInput(
    preset: ModelPresetRow,
    ctx: RenderContext,
    warnings: string[],
  ): RenderPresetInput {
    const providerIds = parseProviderIds(preset.provider_ids_json)
    const providers: RenderProviderInput[] = []
    for (const id of providerIds) {
      const row = getProviderRow(db, id)
      if (!row) continue
      if (row.is_relay === 1) {
        // hub-relay：地址、模型、密钥模式都由中转站决定（12 §7.2）
        const baseUrl = relayBaseUrlFor(row.api)
        if (!baseUrl) {
          warnings.push(
            `提供方 ${row.route_key} 是 Hub 中转站，但内部监听器没在监听，本次不渲染（设 HUB_RELAY_INTERNAL_PORT 或检查绑定）`,
          )
          if (ctx.relayUsed) ctx.relayUsed.value = true
          continue
        }
        if (!row.api) {
          warnings.push(`提供方 ${row.route_key} 没有选协议，DSH 会拒绝这条路由`)
          continue
        }
        // WP13：系统路由按「协议 × 档位」筛模型（一条路由一个档位）；旧的手工提供方保持 WP12 口径
        const systemRoute = isSystemRoute(row)
        const thinking = systemRoute ? routeThinking(row) : null
        const models = relayBridge
          ? relayBridge.providerModels(row.api, {
              userId: ctx.userId,
              admin: ctx.admin,
              // docs/22 §3：桌面预设只渲染**桌面平台**勾选的路由（两套配置互不影响）
              ...(preset.platform === 'desktop' ? { platform: 'desktop' as const } : {}),
              ...(systemRoute ? { thinking } : {}),
            })
          : []
        if (models.length === 0) {
          // 没有 models 的提供方会被 DSH 拒绝整条路由 → 这个用户不渲染它（12 §7.0「渲染」）
          warnings.push(`中转站提供方 ${row.route_key} 对该用户没有可渲染的模型，本次不渲染这条路由`)
          continue
        }
        if (ctx.relayUsed) ctx.relayUsed.value = true
        providers.push({
          routeKey: row.route_key,
          displayName: row.display_name,
          kind: 'pi-ai',
          api: row.api,
          baseUrl,
          models,
          compat: row.compat_json ? (JSON.parse(row.compat_json) as Record<string, unknown>) : null,
          extra: row.extra_json ? (JSON.parse(row.extra_json) as Record<string, unknown>) : null,
          keyMode: 'per-user',
          // WP13：所有 hub-relay 提供方共用同一个 env 名（同一把 system 密钥），路由增减不改容器 env
          apiKeyEnv: DSH_HUB_KEY_ENV_NAME,
          ...(systemRoute ? { thinking } : {}),
          enabled: row.enabled === 1,
        })
        continue
      }
      providers.push({
        routeKey: row.route_key,
        displayName: row.display_name,
        kind: row.kind,
        api: row.api,
        baseUrl: row.base_url,
        models: parseModels(row.models_json),
        compat: row.compat_json ? (JSON.parse(row.compat_json) as Record<string, unknown>) : null,
        extra: row.extra_json ? (JSON.parse(row.extra_json) as Record<string, unknown>) : null,
        keyMode: row.key_mode,
        enabled: row.enabled === 1,
      })
    }
    const base: RenderPresetInput = {
      id: preset.id,
      name: preset.name,
      revision: preset.revision,
      defaultProvider: preset.default_provider,
      defaultModel: preset.default_model,
      providers,
    }
    // 只有「给某个用户渲染」时才可能命中座舱覆盖（桌面下发 / 预览没有 userId）
    return ctx.userId === undefined ? base : cockpitModelApplied(base, ctx.userId, warnings)
  }

  /**
   * 座舱模型接线（WP56e1 / docs/24 §5）：系统账号（`is_system=1`，座舱 `hub-ops`）的容器模型
   * 取 `settings.cockpit.model`，而不是预设的 `defaultModel`。
   *
   * 为什么在这里：容器里的模型配置只有一条生成路径 —— 把预设渲染成 `managed.patch.yml`
   * （`agent-default-model` 条目）。座舱容器是「普通运行时容器 + 2C2G」（WP56b），所以只要在渲染时
   * 换掉默认模型，就与经典页面下发的模型配置**完全同构**，不需要给 DSH 传额外的 env 或私有开关。
   *
   * 约束：目标模型必须在该用户的启用提供方里（否则 DSH 会拒绝这条路由）—— 找不到就保持预设默认并记警告，
   * 绝不让座舱因为一个填错的模型名而完全不可用（I6 的精神）。
   */
  function cockpitModelApplied(
    input: RenderPresetInput,
    userId: number,
    warnings: string[],
  ): RenderPresetInput {
    if (!isSystemUserId(db, userId)) return input
    const wanted = readCockpitSettings().model
    if (wanted === null || wanted === input.defaultModel) return input
    const provider = input.providers.find(
      (item) => item.enabled !== false && item.models.some((model) => model.id === wanted),
    )
    if (!provider) {
      warnings.push(
        `座舱模型 ${wanted} 不在任何启用的提供方里，座舱仍用预设默认模型 ${input.defaultModel}`,
      )
      return input
    }
    return { ...input, defaultProvider: provider.routeKey, defaultModel: wanted }
  }

  /** `settings.cockpit`（WP56a 加的 key；读不到就是默认：模型 null、R1 自动执行开） */
  function readCockpitSettings(): { model: string | null } {
    try {
      const parsed = CockpitSettingsSchema.safeParse(
        (deps.settings as unknown as { get(key: string): unknown }).get('cockpit'),
      )
      if (parsed.success) return { model: parsed.data.model ?? null }
    } catch {
      // settings store 里还没有这个 key（例如只装配了 models 模块的测试）→ 按默认处理
    }
    return { model: null }
  }

  /** 用户生效的预设行：钉住的优先，否则默认预设；`model_policy=free` 时恒为 null */
  function effectivePresetRow(userId: number): ModelPresetRow | null {
    const user = getUserModelTarget(db, userId)
    if (!user) throw new HubError('NOT_FOUND', '用户不存在')
    if (user.model_policy !== 'managed') return null
    if (user.model_preset_id) {
      const pinned = getPresetRow(db, user.model_preset_id)
      if (pinned) return pinned
    }
    return getDefaultPresetRow(db, 'cloud') ?? null
  }

  async function runtimeVersionFor(userId: number): Promise<string | null> {
    const instances = services().instances
    if (!instances) return null
    try {
      const summary = await instances.getSummary(userId)
      return summary.runtimeVersion ?? null
    } catch {
      return null
    }
  }

  function installedPluginInputs(userId: number): RenderPluginInput[] {
    return listInstalledPluginConfigs(db, userId).map((row) => ({
      packageName: row.package_name,
      version: row.version,
      bundleOrder: row.bundle_order,
      configYaml: row.config_yaml,
    }))
  }

  interface RenderInputs {
    report: RenderManagedOutput
    plugins: RenderPluginInput[]
    relayUsed: boolean
  }

  async function buildRenderInputs(
    userId: number,
    presetOverride?: ModelPresetRow | null,
  ): Promise<RenderInputs> {
    const user = getUserModelTarget(db, userId)
    if (!user) throw new HubError('NOT_FOUND', '用户不存在')
    const presetRow =
      presetOverride === undefined
        ? effectivePresetRow(userId)
        : user.model_policy === 'managed'
          ? (presetOverride ?? null)
          : null
    const plugins = installedPluginInputs(userId)
    const renderContext: RenderContext = {
      userId,
      admin: user.role === 'admin',
      relayUsed: { value: false },
    }
    const presetWarnings: string[] = []
    // 搜索 / 抓取池下发（14 §5）：与模型预设无关，单独取
    const toolsRender = relayBridge?.toolsRender?.(userId) ?? null
    const report = renderManagedPatch({
      user: {
        id: user.id,
        slug: user.slug,
        modelPolicy: user.model_policy === 'free' ? 'free' : 'managed',
        runtimeVersion: await runtimeVersionFor(userId),
      },
      preset: presetRow ? presetRenderInput(presetRow, renderContext, presetWarnings) : null,
      plugins,
      ...(toolsRender && toolsRender.entries.length > 0 ? { toolEntries: toolsRender.entries } : {}),
      // 「普通对话」预设（WP40d）：系统设置 container.chatPreset，默认下发
      chatPreset: deps.settings.get('container').chatPreset,
      now: deps.clock.nowIso(),
    })
    return {
      report: {
        ...report,
        warnings: [...new Set([...presetWarnings, ...(toolsRender?.warnings ?? []), ...report.warnings])],
      },
      plugins,
      relayUsed: renderContext.relayUsed?.value === true,
    }
  }

  /** 原子写 managed/ 下的两个文件（tmp + rename；目录 0700、文件 0600） */
  function writeManagedFiles(slug: string, content: string, manifest: unknown): void {
    const dir = deps.paths.userManaged(slug)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const patchTmp = join(dir, 'managed.patch.yml.tmp')
    writeFileSync(patchTmp, content, { mode: 0o600 })
    renameSync(patchTmp, join(dir, 'managed.patch.yml'))
    const manifestTmp = join(dir, 'manifest.json.tmp')
    writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    renameSync(manifestTmp, join(dir, 'manifest.json'))
  }

  function managedPatchPath(slug: string): string {
    return join(deps.paths.userManaged(slug), 'managed.patch.yml')
  }

  function readManagedPatch(slug: string): string | null {
    try {
      return readFileSync(managedPatchPath(slug), 'utf8')
    } catch {
      return null
    }
  }

  async function renderManaged(
    userId: number,
    opts: { presetId?: number | null } = {},
  ): Promise<RenderManagedResult> {
    const user = getUserModelTarget(db, userId)
    if (!user) throw new HubError('NOT_FOUND', '用户不存在')
    const presetOverride =
      opts.presetId === undefined ? undefined : opts.presetId === null ? null : requirePreset(opts.presetId)
    const { report, plugins, relayUsed } = await buildRenderInputs(userId, presetOverride)
    const presetRow = presetOverride === undefined ? effectivePresetRow(userId) : presetOverride
    const manifest = buildManifest({
      user: {
        id: user.id,
        slug: user.slug,
        modelPolicy: user.model_policy === 'free' ? 'free' : 'managed',
        runtimeVersion: await runtimeVersionFor(userId),
      },
      preset: presetRow ? presetRenderInput(presetRow, { userId, admin: user.role === 'admin' }, []) : null,
      plugins,
      now: deps.clock.nowIso(),
    })
    writeManagedFiles(user.slug, report.content, manifest)
    // 真渲染过一次 = 变更已经落到盘上（概览的「模型待下发」告警据此消掉）
    if (relayUsed) relayBridge?.noteRendered()
    return {
      content: report.content,
      manifest,
      warnings: report.warnings,
    }
  }

  /**
   * 桌面下发用的模型片段（WP25b）：复用现有「下发到 DSH」选好的**系统路由与默认模型**，
   * 只输出两条白名单条目（`llm-pi-ai` / `agent-default-model`）的对象形态。
   *
   * 与容器侧 `renderManaged` 的差别：不写文件、不生成 workspace-controller / 停用条目，
   * 密钥引用恒为 `HUB_MK_HUB`（桌面端把它映射到这台设备自己的中转站密钥，裁决 #8）。
   */
  async function desktopModelFragments(
    userId: number | null,
    opts: { presetId?: number } = {},
  ): Promise<{ fragments: { id: string; config: Record<string, unknown> }[]; warnings: string[] }> {
    // WP28a：统一下发的 `models` 内容项可以指定预设（`presetId`）。渲染口径与系统预设一致
    // （管理员可见性 = 全部可下发模型），不绑定具体用户。
    if (opts.presetId !== undefined) {
      const presetRow = getPresetRow(db, opts.presetId)
      if (!presetRow) throw new HubError('NOT_FOUND', '模型预设不存在')
      if (presetRow.platform !== 'desktop') {
        // docs/22 §3：桌面下发的 presetId 必须是桌面平台的预设（两套预设互不串）
        throw new HubError('VALIDATION_FAILED', '这个预审不属于桌面平台，不能用作桌面模型配置', {
          fields: { presetId: '不是桌面平台的预设' },
        })
      }
      const warnings: string[] = []
      const preset = presetRenderInput(presetRow, { admin: true }, warnings)
      const entries = modelEntries(preset, warnings)
      return {
        fragments: entries.map((entry) => ({
          id: String(entry.id),
          config: (entry.config ?? {}) as Record<string, unknown>,
        })),
        warnings: [...new Set(warnings)],
      }
    }
    // WP25e：不带 userId = 系统预设（默认预设 + 管理员可见性 = 全部可下发模型），不绑定具体用户。
    // WP32a（docs/22 §3）：桌面端取的是**桌面平台**的默认预设，与云上默认预设互不影响
    if (userId === null) {
      // docs/22 §3 / WP32d：桌面第一次渲染前，勾选集合从云上当前配置带一份初值（幂等；
      // 写过 settings.relay_dsh_desktop 之后不再跟随，两个平台各自独立）
      services().relay?.ensureDesktopDshSeeded?.()
      // 桌面默认预设还没建（新装 Hub 先跑迁移、后配模型）→ 从云上默认预设复制一份再渲染
      const presetRow = getDefaultPresetRow(db, 'desktop') ?? (ensureDesktopDefaultPreset() ? getDefaultPresetRow(db, 'desktop') : undefined)
      if (!presetRow) {
        return {
          fragments: [],
          warnings: [
            '桌面平台还没有默认模型预设（「模型配置 → 桌面」里没有设 isDefault 的预设），没有可下发的模型配置',
          ],
        }
      }
      const systemWarnings: string[] = []
      const systemPreset = presetRenderInput(presetRow, { admin: true }, systemWarnings)
      const systemEntries = modelEntries(systemPreset, systemWarnings)
      return {
        fragments: systemEntries.map((entry) => ({
          id: String(entry.id),
          config: (entry.config ?? {}) as Record<string, unknown>,
        })),
        warnings: [...new Set(systemWarnings)],
      }
    }
    const user = getUserModelTarget(db, userId)
    if (!user) throw new HubError('NOT_FOUND', '用户不存在')
    const presetRow = effectivePresetRow(userId)
    if (!presetRow) {
      return {
        fragments: [],
        warnings: ['该用户没有生效的模型预设（model_policy=free 或没有默认预设），没有可下发的模型配置'],
      }
    }
    const warnings: string[] = []
    const preset = presetRenderInput(presetRow, { userId, admin: user.role === 'admin' }, warnings)
    const entries = modelEntries(preset, warnings)
    return {
      fragments: entries.map((entry) => ({
        id: String(entry.id),
        config: (entry.config ?? {}) as Record<string, unknown>,
      })),
      warnings: [...new Set(warnings)],
    }
  }

  async function previewForUser(presetId: number, userId: number): Promise<PresetPreviewResponse> {
    const preset = requirePreset(presetId)
    const user = getUserModelTarget(db, userId)
    if (!user) throw new HubError('NOT_FOUND', '用户不存在')
    const { report } = await buildRenderInputs(userId, preset)
    return { userId, content: report.content, warnings: report.warnings }
  }

  // ── 容器 env / 下发 ──────────────────────────────────────────────────────

  /** 解密后的密钥 env（05 §4）：`HUB_MK_<ROUTE_KEY>`；per-user 优先，其次 shared */
  async function containerEnv(userId: number): Promise<Record<string, string>> {
    const preset = effectivePresetRow(userId)
    const env: Record<string, string> = {}
    for (const providerId of preset ? parseProviderIds(preset.provider_ids_json) : []) {
      const row = getProviderRow(db, providerId)
      if (!row || row.enabled !== 1) continue
      if (row.is_relay === 1) {
        // 本用户的 system 密钥（没有就当场签发并加密存 key_enc；12 §7.3）。
        // WP13：所有 hub-relay 提供方共用 `HUB_MK_HUB` 一个 env 名，这里只注入一次。
        if (env[DSH_HUB_KEY_ENV_NAME] !== undefined) continue
        const relayKey = relayBridge?.systemKeyPlain(userId) ?? null
        if (!relayKey) {
          deps.logger.warn({ userId, routeKey: row.route_key }, 'Hub 中转站密钥不可用，本次不注入')
          continue
        }
        env[DSH_HUB_KEY_ENV_NAME] = relayKey
        continue
      }
      if (row.kind === 'deepseek-official') {
        const key = resolveKey(row, userId)
        if (key) env.DEEPSEEK_API_KEY = key
        else deps.logger.warn({ userId, routeKey: row.route_key }, 'deepseek-official 没有可用密钥')
        continue
      }
      if (row.key_mode === 'none') continue
      const key = resolveKey(row, userId)
      if (!key) {
        deps.logger.warn({ userId, routeKey: row.route_key }, '模型提供方没有可用密钥，本次不注入')
        continue
      }
      env[providerKeyEnvName(row.route_key)] = key
    }
    // 搜索 / 抓取池下发时也要 `HUB_MK_HUB`（14 §5）：用户可能没有 hub-relay 提供方，
    // 但容器里的 `dsh-web-deepseek-api` 一样要拿这把密钥调 Hub 的 `/v1/tools/*`
    if (env[DSH_HUB_KEY_ENV_NAME] === undefined && relayBridge?.toolsRender?.(userId).needsKey === true) {
      const relayKey = relayBridge.systemKeyPlain(userId)
      if (relayKey) env[DSH_HUB_KEY_ENV_NAME] = relayKey
      else deps.logger.warn({ userId }, '搜索池的 system 密钥不可用，本次不注入 HUB_MK_HUB')
    }
    // 18 §4.1：Claude Code / Codex 开通后叠加 HUB_CLAUDE_* / HUB_CODEX_*（模型与价格不进 env）
    if (agentModeEnv) Object.assign(env, agentModeEnv(userId))
    return env
  }

  function resolveKey(row: ModelProviderRow, userId: number): string | null {
    if (row.key_mode === 'per-user') {
      const userKey = getUserProviderKeyRow(db, row.id, userId)
      if (!userKey) return null
      try {
        return decrypt(userKey.api_key_enc)
      } catch {
        return null
      }
    }
    if (row.key_mode === 'shared' && row.api_key_enc) {
      try {
        return decrypt(row.api_key_enc)
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * 下发模型配置（06 §4.3 最后一行）：
   * 写期望状态 → 重渲染 managed → **密钥 env 变了就重建容器**，否则只重启。
   * 实例没在跑时只落盘，配置在下次启动生效（`config_hash` 变化会让状态页提示需要重建）。
   */
  async function applyForUser(
    userId: number,
    presetId: number | null | undefined,
    opts: { onLog?: (line: string) => void; restart?: 'now' | 'next-start' } = {},
  ): Promise<void> {
    await withUserLock(
      userId,
      async () => {
        const log = (line: string): void => opts.onLog?.(line)
        const user = getUserModelTarget(db, userId)
        if (!user) throw new HubError('NOT_FOUND', '用户不存在')
        const envBefore = await containerEnv(userId)
        const contentBefore = readManagedPatch(user.slug)

        if (presetId === undefined) {
          // 04 §10.6：省略 presetId = 不改变用户的预设，只按最新提供方/预设配置重渲染
          log('未指定预设：保持用户当前预设，只按最新配置重渲染')
        } else {
          setUserPreset(db, userId, presetId, deps.clock.nowIso())
          log(
            presetId === null
              ? '已把用户的模型预设设为「跟随默认」'
              : `已把用户的模型预设设为 #${String(presetId)}`,
          )
        }
        const result = await renderManaged(userId)
        for (const warning of result.warnings) log(`渲染警告：${warning}`)
        log(`已写入 managed.patch.yml（preset r${String(result.manifest.presetRevision ?? '-')}）`)

        const envAfter = await containerEnv(userId)
        const envChanged = !sameEnv(envBefore, envAfter)
        const contentChanged = contentBefore !== result.content
        const instances = services().instances
        const status = instances ? instances.currentStatus(userId) : 'absent'
        const wasRunning = status === 'running' || status === 'starting' || status === 'stopping'
        // 容器当前的 config_hash 是否已经与期望规格一致（含模型密钥 env；05 §4 的公式）。
        // 这里自己算而不是用 `getSummary().needsRecreate`：后者有 5 秒缓存，密钥刚改完可能读到旧值。
        const needsRecreate = wasRunning ? await specChanged(user, userId) : false

        if (!contentChanged && !envChanged && !needsRecreate) {
          log('配置没有变化，无需重启')
          return
        }
        if (!wasRunning) {
          log('实例未在运行，配置将在下次启动时生效')
          return
        }
        if ((opts.restart ?? 'now') === 'next-start') {
          // 04 §9.5：next-start 由执行器落实——只落盘，容器下次启动时自然带上新配置
          log('按 restart=next-start，配置将在下次启动 DSH 时生效')
          return
        }
        if (envChanged || needsRecreate) {
          log(envChanged ? '模型密钥发生变化，重建容器' : '容器规格与期望不一致（例如密钥已轮换），重建容器')
          await instances!.recreate(userId, { reason: 'rollout' })
          log('容器已重建并就绪')
        } else {
          log('配置变化但密钥未变，重启 DSH')
          await instances!.restart(userId, { reason: 'rollout' })
          log('DSH 已重启并就绪')
        }
      },
      { timeoutMs: 20 * 60_000 },
    )
  }

  /** 运行中的容器用的规格哈希是否已经过期（对比 label 与按当前期望重算的哈希） */
  async function specChanged(user: { id: number; slug: string }, userId: number): Promise<boolean> {
    const instances = services().instances
    if (!instances) return false
    const info = await deps.driver
      .inspect(containerNameFor(user.slug, deps.config.containerPrefix))
      .catch(() => null)
    if (!info) return true
    const spec = await instances.buildSpec(userId)
    return info.labels[LABEL_CONFIG_HASH] !== computeConfigHash(spec)
  }

  async function summaryForUser(userId: number): Promise<{
    policy: 'managed' | 'free'
    preset: string
    defaultModel: string
    providers: string[]
  }> {
    const user = getUserModelTarget(db, userId)
    const policy: 'managed' | 'free' = user?.model_policy === 'free' ? 'free' : 'managed'
    if (!user || policy === 'free') {
      return { policy, preset: '', defaultModel: '', providers: [] }
    }
    const preset = effectivePresetRow(userId)
    if (!preset) return { policy, preset: '', defaultModel: '', providers: [] }
    const providers: string[] = []
    for (const providerId of parseProviderIds(preset.provider_ids_json)) {
      const row = getProviderRow(db, providerId)
      if (row) providers.push(row.route_key)
    }
    return { policy, preset: preset.name, defaultModel: preset.default_model, providers }
  }

  /** 04 §10.3：per-user 提供方的密钥状态（管理端用户详情） */
  async function providerKeysForUser(userId: number): Promise<UserProviderKey[]> {
    requireUserTarget(userId)
    return listPerUserProviderRows(db).map((row) => {
      const key = getUserProviderKeyRow(db, row.id, userId)
      let last4: string | null = null
      if (key) {
        try {
          last4 = keyLast4(decrypt(key.api_key_enc))
        } catch {
          last4 = null
        }
      }
      return {
        providerId: row.id,
        routeKey: row.route_key,
        displayName: row.display_name,
        keyMode: row.key_mode,
        set: key !== undefined,
        last4,
      }
    })
  }

  function requireUserTarget(userId: number): void {
    if (!getUserModelTarget(db, userId)) throw new HubError('NOT_FOUND', '用户不存在')
  }

  // ── 系统托管的下发预设（12 §7.0；WP12a）───────────────────────────────────

  /**
   * 通知 relay 重新同步系统托管的下发配置。预设 / 提供方被手工改动后调用：
   * 系统预设被删掉要能重建、被改成别的样子要能拉回期望状态（12 §7.0「系统托管」）。
   * 同步失败只告警，不能让管理员这次正常的编辑请求失败。
   */
  function notifySystemPresetsMutated(): void {
    try {
      relayBridge?.onSystemPresetsMutated?.()
    } catch (error) {
      deps.logger.warn({ err: error }, 'models 变更后同步系统托管的下发配置失败')
    }
  }

  /** 系统提供方的路由名被非中转站提供方占用时返回那一行（同步时 CONFLICT、GET 时进 warnings） */
  function occupiedSystemRoute(routeKey: string): ModelProviderRow | null {
    const row = getProviderRowByRoute(db, routeKey)
    return row && row.is_relay !== 1 ? row : null
  }

  function systemPresetRouteConflict(routeKeys: string[]): string | null {
    for (const routeKey of routeKeys) {
      const occupied = occupiedSystemRoute(routeKey)
      if (occupied) {
        return `路由名 ${routeKey} 已被提供方「${occupied.display_name}」占用，Hub 中转站要下发该协议的模型时会失败（请改掉它的路由名）`
      }
    }
    return null
  }

  function systemPresetState(
    spec: { presetId: number | null; name: string },
    platform: Platform = 'cloud',
  ): { presetId: number; revision: number } | null {
    const pinned = spec.presetId === null ? undefined : getPresetRow(db, spec.presetId)
    const row =
      (pinned && (pinned.platform === platform ? pinned : undefined)) ??
      getPresetRowByName(db, spec.name, platform)
    return row ? { presetId: row.id, revision: row.revision } : null
  }

  /**
   * 系统提供方：不存在就建（hub-relay），存在就对齐显示名/协议/档位/启用状态，返回 id 列表。
   * WP13 起系统提供方按「协议 × 档位」分路由。
   */
  function syncSystemProviders(spec: SystemPresetSpec, at: string): { ids: number[]; changed: boolean } {
    const ids: number[] = []
    let changed = false
    for (const provider of spec.providers) {
      const occupied = occupiedSystemRoute(provider.routeKey)
      if (occupied) {
        throw new HubError(
          'CONFLICT',
          `路由名 ${provider.routeKey} 已被提供方「${occupied.display_name}」占用，请先改掉它的路由名`,
          { routeKey: provider.routeKey, providerId: occupied.id },
        )
      }
      const row = getProviderRowByRoute(db, provider.routeKey)
      const extra = systemProviderExtra(provider.thinking)
      const currentExtra = parseJsonColumn<Record<string, unknown> | null>(row?.extra_json ?? null, null)
      const extraChanged = JSON.stringify(currentExtra ?? null) !== JSON.stringify(extra)
      if (!row) {
        ids.push(
          insertProviderRow(db, {
            routeKey: provider.routeKey,
            displayName: provider.displayName,
            // 库里存 pi-ai + is_relay=1（迁移 044），DTO 层映射成 hub-relay
            kind: 'pi-ai',
            api: provider.api,
            baseUrl: null,
            models: [],
            compat: null,
            extra,
            keyMode: 'per-user',
            apiKeyEnc: null,
            enabled: true,
            isRelay: true,
            at,
          }),
        )
        changed = true
        continue
      }
      ids.push(row.id)
      const patch: UpdateProviderInput = {}
      if (row.display_name !== provider.displayName) patch.displayName = provider.displayName
      if (row.api !== provider.api) patch.api = provider.api
      if (row.enabled !== 1) patch.enabled = true
      if (row.kind !== 'pi-ai') patch.kind = 'pi-ai'
      if (row.key_mode !== 'per-user') patch.keyMode = 'per-user'
      if (row.base_url !== null) patch.baseUrl = null
      if (row.api_key_enc !== null) patch.apiKeyEnc = null
      if (extraChanged) patch.extra = extra
      if (Object.keys(patch).length > 0) {
        updateProviderRow(db, row.id, patch, at)
        changed = true
      }
    }
    // 期望集合里没有的系统路由：由 syncSystemPreset 在系统预设对齐**之后**统一停用（见下）
    return { ids, changed }
  }

  /**
   * 不再用到的系统路由：**只停用、不删除**——别的预设可能还按 id 引用它，删掉会留下悬空引用。
   * 必须在系统预设已经对齐之后再调用（12 §7.0：行可删除或停用，选后者）。
   */
  function disableUnusedSystemProviders(expected: Set<string>, at: string): boolean {
    const referenced = new Set<number>()
    for (const preset of listPresetRows(db)) {
      for (const id of parseProviderIds(preset.provider_ids_json)) referenced.add(id)
    }
    let changed = false
    for (const row of listRelayProviderRows(db)) {
      if (row.enabled !== 1 || expected.has(row.route_key) || !isSystemRouteName(row.route_key)) continue
      if (referenced.has(row.id)) continue
      updateProviderRow(db, row.id, { enabled: false }, at)
      changed = true
    }
    return changed
  }

  /**
   * 系统提供方 + 系统预设的期望状态对账（12 §7.0）。**幂等**：与现状一致时不写库、不 bump revision。
   * `providers` 为空（没有勾选任何可下发模型）= 不该有系统预设：有就删掉。
   */
  function syncSystemPreset(spec: SystemPresetSpec): SystemPresetSyncResult {
    const at = deps.clock.nowIso()
    // docs/22 §3：两个平台各有一套系统预设；缺省云上（旧调用不变）
    const platform: Platform = spec.platform ?? 'cloud'
    return db.tx(() => {
      const providers = syncSystemProviders(spec, at)
      let changed = providers.changed
      // 记下的 id 失效时按名字找：预设被人删了/换了名字，同步要能重新接管（而不是建出第二份）
      const pinnedPreset = spec.presetId === null ? undefined : getPresetRow(db, spec.presetId)
      const existing =
        (pinnedPreset && pinnedPreset.platform === platform ? pinnedPreset : undefined) ??
        getPresetRowByName(db, spec.name, platform)

      if (spec.providers.length === 0) {
        if (existing) {
          deletePresetRow(db, existing.id)
          changed = true
        }
        // 预设已经删掉/不再引用它们，这时才判断哪些系统路由没人用了
        if (disableUnusedSystemProviders(new Set(), at)) changed = true
        return { presetId: null, revision: 0, changed, providerIds: [] }
      }

      if (!existing) {
        clearDefaultPresets(db, undefined, platform)
        const id = insertPresetRow(db, {
          name: spec.name,
          description: spec.description ?? '',
          providerIds: providers.ids,
          defaultProvider: spec.defaultProvider,
          defaultModel: spec.defaultModel,
          isDefault: true,
          at,
          platform,
        })
        if (disableUnusedSystemProviders(new Set(spec.providers.map((item) => item.routeKey)), at)) {
          changed = true
        }
        return { presetId: id, revision: 1, changed: true, providerIds: providers.ids }
      }

      const currentIds = parseProviderIds(existing.provider_ids_json)
      const sameProviders =
        currentIds.length === providers.ids.length &&
        currentIds.every((id, index) => id === providers.ids[index])
      const needsUpdate =
        existing.name !== spec.name ||
        !sameProviders ||
        existing.default_provider !== spec.defaultProvider ||
        existing.default_model !== spec.defaultModel ||
        existing.is_default !== 1
      if (!needsUpdate && spec.renderChanged === true) {
        // 预设行没变、但被选模型的渲染内容变了（改显示名/上下文/compat…）：revision 仍要 +1
        updatePresetRow(db, existing.id, {}, at)
        changed = true
      }
      if (needsUpdate) {
        // 系统预设必须是默认预设（其它预设取消默认但不删，12 §7.0；只动本平台）
        clearDefaultPresets(db, existing.id, platform)
        updatePresetRow(
          db,
          existing.id,
          {
            name: spec.name,
            providerIds: providers.ids,
            defaultProvider: spec.defaultProvider,
            defaultModel: spec.defaultModel,
            isDefault: true,
          },
          at,
        )
        changed = true
      }
      const row = getPresetRow(db, existing.id)
      if (disableUnusedSystemProviders(new Set(spec.providers.map((item) => item.routeKey)), at)) {
        changed = true
      }
      return {
        presetId: existing.id,
        revision: row?.revision ?? existing.revision,
        changed,
        providerIds: providers.ids,
      }
    })
  }

  /**
   * 桌面默认预设（docs/22 §3）：没有就从云上默认预设复制一份（幂等）。
   *
   * 为什么需要它：迁移 124 只在「库里有云上默认预设」时才能复制；新装的 Hub 是先跑迁移、后配模型，
   * 那时还没有任何预设。管理员第一次把模型配置保存到桌面平台（或服务启动补齐基线）时调它即可。
   */
  function ensureDesktopDefaultPreset(): { presetId: number; created: boolean } | null {
    const existing = getDefaultPresetRow(db, 'desktop')
    if (existing) return { presetId: existing.id, created: false }
    const cloud = getDefaultPresetRow(db, 'cloud')
    if (!cloud) return null
    const at = deps.clock.nowIso()
    const presetId = db.tx(() => {
      clearDefaultPresets(db, undefined, 'desktop')
      return insertPresetRow(db, {
        name: desktopPresetNameOf(cloud.name),
        description: cloud.description,
        providerIds: parseProviderIds(cloud.provider_ids_json),
        defaultProvider: cloud.default_provider,
        defaultModel: cloud.default_model,
        isDefault: true,
        at,
        platform: 'desktop',
      })
    })
    return { presetId, created: true }
  }

  function clearUserPresets(): number {
    return clearAllUserPresets(db, deps.clock.nowIso())
  }

  return {
    providerKeysForUser,
    listProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    discover,
    getCatalog,
    saveCatalog,
    deleteCatalogEntry,
    matchModels,
    setUserProviderKey,
    deleteUserProviderKey,
    listPresets,
    createPreset,
    updatePreset,
    deletePreset,
    previewForUser,
    desktopModelFragments,
    renderManaged,
    containerEnv,
    applyForUser,
    summaryForUser,
    attachRelayBridge(bridge) {
      relayBridge = bridge
    },
    attachAgentModeEnv(provider) {
      agentModeEnv = provider
    },
    syncSystemPreset,
    systemPresetState,
    ensureDesktopDefaultPreset,
    systemPresetRouteConflict,
    clearUserPresets,
    hasRelayProviderForUser(userId) {
      const preset = effectivePresetRow(userId)
      if (!preset) return false
      return countEnabledRelayProvidersIn(db, parseProviderIds(preset.provider_ids_json)) > 0
    },
    listRelayProviderCount() {
      return countRelayProviderRows(db)
    },
  }
}

/** 两个 env 记录是否等价（键值集合比较） */
export function sameEnv(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index]!
    if (key !== rightKeys[index]) return false
    if (left[key] !== right[key]) return false
  }
  return true
}
