import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  RELAY_MAX_RANGE_DAYS,
  RELAY_RATE_PERMILLE_DEFAULT,
  RelayModelNameSchema,
  effectiveDshThinking,
  type AddRelayChannelKeysRequest,
  type AddRelayChannelKeysResponse,
  type AdjustRelayWalletRequest,
  type CreateRelayChannelRequest,
  type CreateRelayKeyRequest,
  type CreateRelayModelRequest,
  type DiscoverRelayChannelResponse,
  type ImportRelayModelsRequest,
  type ImportRelayModelsResponse,
  type ModelApi,
  type ModelInfo,
  type MyRelayModel,
  type MyRelayResponse,
  type RelayAlert,
  type RelayChannel,
  type RelayChannelHealth,
  type RelayDshModel,
  type RelayDshResponse,
  type RelayKey,
  type RelayKeySecretResponse,
  type RelayLedgerListResponse,
  type RelayLedgerQuery,
  type RelayModel,
  type RelayOverviewResponse,
  type RelayRoute,
  type RelayScope,
  type RelaySettings,
  type RelaySettingsResponse,
  type RelayUsageLogQuery,
  type RelayUsageLogResponse,
  type RelayUsageStatsQuery,
  type RelayUsageStatsResponse,
  type RelayWalletListQuery,
  type RelayWalletListResponse,
  type RelayWalletRow,
  type TestRelayChannelResponse,
  type UpdateRelayChannelKeyRequest,
  type UpdateRelayChannelRequest,
  type UpdateRelayDshRequest,
  type UpdateRelayKeyRequest,
  type UpdateRelayModelRequest,
  type UpdateRelaySettingsRequest,
  type UpdateRelayWalletRequest,
  RelayModelVisibilitySchema,
  RelayChannelSlugSchema,
  AGENT_MODE_API,
  ThinkingLevelSchema,
  THINKING_LEVELS,
  type ThinkingLevel,
  type Platform,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import type { RequestOrigin } from '../../server/public-request.js'
import { decryptSecret, encryptSecret, keyLast4 } from '../../lib/crypto.js'
import { HubError } from '../../lib/errors.js'
import { loadMasterKeyIfExists } from '../../lib/secrets.js'
import { avatarUrlFor } from '../../lib/user-view.js'
import { startRelayCleanup, type RelayCleanupHandle } from './cleanup.js'
import { generateRelayKey, hashRelayKey, relayKeyPreview } from './keys.js'
import { computeCostMicro } from './billing.js'
import {
  channelNamesForModels,
  channelRateRanges,
  clearExpiredKeyCooldowns,
  countManagedRunningInstances,
  countManagedUsers,
  countModelRows,
  countUsageRows,
  dailyBucketsByChannel,
  dailyBucketsByDay,
  dailyBucketsByDayModel,
  dailyBucketsByScope,
  dailyBucketsByModel,
  dailyBucketsByUser,
  deleteChannelKeyRow,
  deleteChannelRow,
  deleteModelRow,
  deleteRoutesForModel,
  ensureWalletRow,
  findChannelKeyRowByHash,
  findKeyRowByHash,
  getActiveSystemKeyRow,
  getChannelKeyRow,
  getChannelRow,
  getChannelRowByName,
  getChannelRowBySlug,
  getKeyRow,
  getModelRow,
  getModelRowByName,
  getUserStatusRow,
  getWalletRow,
  insertChannelKeyRow,
  insertChannelRow,
  insertKeyRow,
  insertLedgerRow,
  insertModelRow,
  insertRouteRow,
  insertUsageRow,
  listChannelKeyRows,
  listChannelModelNames,
  listChannelRows,
  listChannelSlugs,
  countUserCreatedKeyRows,
  listDeviceKeyRows,
  listKeyRows,
  listLedgerRows,
  listModelRows,
  listRouteRows,
  listRouteRowsForModels,
  listUnpricedModelRows,
  listUsageRows,
  listWalletRows,
  parseApis,
  parseHeaders,
  parseInfo,
  parseJsonColumn,
  parseScope,
  revokeKeyRow,
  revokeKeysByDevice,
  sumDailyBuckets,
  sumWalletBalances,
  toRelayChannelKey,
  toRelayKey,
  toRelayLedgerRow,
  toRelayModel,
  toRelayPrice,
  toRelayRoute,
  toRelayUsageRow,
  toRelayWallet,
  toUsageBucket,
  touchKeyLastUsed,
  updateChannelKeyRow,
  updateChannelRow,
  updateKeyRow,
  updateModelRow,
  updateRouteDshEnabledRows,
  updateRouteRow,
  updateWalletRow,
  upsertUsageDaily,
  syncModelDshEnabledFlags,
  deleteRouteRow,
  type DailyDelta,
  type RelayChannelKeyRow,
  type RelayChannelRow,
  type RelayModelRow,
  type RelayRouteRow,
  type RelayWalletRow as RelayWalletDbRow,
} from './repo.js'
import {
  DSH_DESKTOP_SYSTEM_PRESET_NAME,
  DSH_SYSTEM_PRESET_DESCRIPTION,
  DSH_SYSTEM_PRESET_NAME,
  allSystemRouteNames,
  compareDshRoutes,
  deliverApiFor,
  deliverApiForRoute,
  dshRenderFingerprint,
  dshRouteBlockedReason,
  dshRouteDisplayName,
  dshRouteModelId,
  expectedDshState,
  isDshRouteDeliverable,
  type DshRenderModel,
  type DshRouteInput,
} from './dsh.js'
import { RELAY_DSH_DESKTOP_SETTINGS_KEY, createRelayDshStore } from './dsh-store.js'
import { autoChannelSlug } from './slug.js'
import { forwardV1, sanitizeUpstreamError, type RelayProxyHost } from './proxy.js'
import { createRelaySettingsStore } from './settings-store.js'
import { closeToolProxyAgents, createToolService } from './tools/service.js'
import type { ToolService } from './tools/types.js'
import {
  addRelayDays,
  relayDayRange,
  relayDaySpan,
  shanghaiDay,
  shanghaiDayStartIso,
  shanghaiMonthStart,
} from './time.js'
import type {
  MintDeviceKeyInput,
  RelayAuthResult,
  RelayRenderModel,
  RelayScopeModel,
  RelayService,
} from './types.js'

/** 用户自建密钥的上限（12 §9） */
export const MAX_USER_KEYS = 10
/** 上游密钥最后一次使用时间的落库节流（12 §8） */
export const KEY_LAST_USED_THROTTLE_MS = 60_000
/** 管理端「测试」的并发与单把超时（12 §9） */
const TEST_CONCURRENCY = 4
const TEST_TIMEOUT_MS = 15_000

/**
 * relay 模块的 service（12 §2）：渠道 / 对外模型与路由 / 钱包与流水 / 用户密钥 / 用量统计 / 设置，
 * 以及 `/v1` 的鉴权与转发编排。**所有 SQL 在 repo.ts**，这里只做业务判定与 DTO 组装。
 */
export function createRelayService(deps: BaseDeps): RelayService {
  const db = deps.db
  const clock = deps.clock
  const config = deps.config
  const log = deps.logger

  const settingsStore = createRelaySettingsStore(db, {
    onWarn: (message, detail) => log.warn({ detail }, message),
  })
  const dshStore = createRelayDshStore(db, { onWarn: (message) => log.warn(message) })
  /** 桌面平台的「下发到 DSH」（docs/22 §3）：勾选集合、默认模型、预设 id 与云上各存一份 */
  const desktopDshStore = createRelayDshStore(db, {
    platform: 'desktop',
    onWarn: (message) => log.warn(message),
  })

  function dshStoreOf(platform: Platform): ReturnType<typeof createRelayDshStore> {
    return platform === 'desktop' ? desktopDshStore : dshStore
  }

  function dshPresetNameOf(platform: Platform): string {
    return platform === 'desktop' ? DSH_DESKTOP_SYSTEM_PRESET_NAME : DSH_SYSTEM_PRESET_NAME
  }
  /** 进行中计数只在内存（12 §6.4）：Hub 重启清零 */
  const userInFlight = new Map<number, number>()
  const channelInFlight = new Map<number, number>()
  /** 内部监听器实际地址（由 listeners 在绑定成功后写入） */
  let internalBaseUrl: string | null = null
  let internalListening = false
  /** 「模型有变更但还没下发」的内存标志（概览告警 models-changed） */
  let modelsChanged = false
  const lastKeyTouch = new Map<number, number>()
  /** 搜索池子域（14；在 `attachRelayBridge` 之前装配，渲染指纹会用到） */
  let toolService: ToolService | null = null

  const cleanup: RelayCleanupHandle = startRelayCleanup({
    db,
    clock,
    log: (message, detail) => log.info({ detail }, message),
    retentionDays: () => settingsStore.get().logRetentionDays,
  })

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  function masterKey(): Buffer | null {
    return loadMasterKeyIfExists(deps.paths.masterKeyFile)
  }

  function encrypt(plain: string): string {
    const key = masterKey()
    if (!key) throw new HubError('INTERNAL', '主密钥不可用，无法保存密钥')
    return encryptSecret(plain, key)
  }

  function decrypt(payload: string): string | null {
    const key = masterKey()
    if (!key) return null
    try {
      return decryptSecret(payload, key)
    } catch {
      return null
    }
  }

  function audit(entry: {
    actorId?: number | null
    meta?: RequestMeta
    action: string
    targetType: string
    targetId?: number | null
    detail?: Record<string, unknown>
  }): void {
    deps.audit.log({
      actorId: entry.actorId ?? null,
      actorIp: entry.meta?.ip ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      detail: entry.detail ?? null,
    })
  }

  // ── 设置与地址 ────────────────────────────────────────────────────────────

  function settings(): RelaySettings {
    return settingsStore.get()
  }

  function settingsResponse(entry?: RequestOrigin): RelaySettingsResponse {
    return {
      settings: settings(),
      internalBaseUrl: internalBaseUrl,
      publicBaseUrl: publicBaseUrl(entry),
    }
  }

  /**
   * 告诉用户「拿这把密钥连哪个地址」（WP52 / 08 §3）：边缘入口来的请求给边缘入口基址
   * （主域名在部分机房会被按备案拦截），其余入口沿用 `HUB_PUBLIC_ORIGIN`。
   */
  function publicBaseUrl(entry?: RequestOrigin): string {
    const origin = entry?.kind === 'edge' ? entry.origin : config.publicOrigin
    return `${origin.replace(/\/+$/u, '')}/v1`
  }

  // ── 下发到 DSH：系统提供方 + 系统预设（12 §7.0；WP12a）────────────────────

  /** 渠道标识（16 §2）：老库还没跑启动补齐时用 `ch<id>` 兜底，保证 DTO 与调用名总有值 */
  function channelSlugOf(row: Pick<RelayChannelRow, 'id' | 'slug'>): string {
    return row.slug ?? `ch${String(row.id)}`
  }

  /** 一次读出模型、路由、渠道，按模型分组（避免每个模型各查一遍） */
  function routesByModel(
    rows: RelayModelRow[],
  ): Map<number, { route: RelayRouteRow; channel: RelayChannelRow | undefined }[]> {
    const out = new Map<number, { route: RelayRouteRow; channel: RelayChannelRow | undefined }[]>()
    if (rows.length === 0) return out
    const channels = new Map(listChannelRows(db).map((row) => [row.id, row] as const))
    for (const route of listRouteRowsForModels(
      db,
      rows.map((row) => row.id),
    )) {
      const list = out.get(route.model_id)
      const entry = { route, channel: channels.get(route.channel_id) }
      if (list) list.push(entry)
      else out.set(route.model_id, [entry])
    }
    return out
  }

  /** 模型可用接口 = 启用路由所在启用渠道的 apis 并集（12 §8 的 `apis` 派生字段） */
  function modelApisFrom(
    entries: { route: RelayRouteRow; channel: RelayChannelRow | undefined }[],
  ): ModelApi[] {
    const out = new Set<ModelApi>()
    for (const { route, channel } of entries) {
      if (route.enabled !== 1 || !channel || channel.enabled !== 1) continue
      for (const api of parseApis(channel.apis_json)) out.add(api)
    }
    return [...out]
  }

  /**
   * 「下发到 DSH」的输入（16 §6.1）：每条「模型 × 渠道」路由一条。
   * 兼容老库/老测试里只写 `relay_models.dsh_enabled` 的数据：模型标记为 1 且它的路由一个都没标记时，
   * 当作该模型的全部路由都被选中（迁移 086 会回填，但手工改库/旧测试仍可能这样写）。
   */
  function dshRouteInputsFrom(rows: RelayModelRow[], selectedOverride?: ReadonlySet<number>): DshRouteInput[] {
    // 18 §3.1：「模型」页的下发只看 dsh 作用域
    const dshRows = rows.filter((row) => parseScope(row.scope) === 'dsh')
    const byModel = routesByModel(dshRows)
    const out: DshRouteInput[] = []
    for (const row of dshRows) {
      const entries = byModel.get(row.id) ?? []
      const apis = modelApisFrom(entries)
      const anyRouteSelected = entries.some((entry) => entry.route.dsh_enabled === 1)
      const legacySelected = row.dsh_enabled === 1 && !anyRouteSelected
      for (const { route, channel } of entries) {
        out.push({
          routeId: route.id,
          modelId: row.id,
          modelName: row.name,
          displayName: row.display_name,
          sort: row.sort,
          thinking: effectiveThinkingFor(row),
          channelId: route.channel_id,
          channelName: channel?.name ?? `#${String(route.channel_id)}`,
          channelSlug: channel ? channelSlugOf(channel) : `ch${String(route.channel_id)}`,
          channelPriority: channel?.priority ?? 0,
          ratePermille: channel?.rate_permille ?? RELAY_RATE_PERMILLE_DEFAULT,
          selected: selectedOverride
            ? selectedOverride.has(route.id)
            : route.dsh_enabled === 1 || legacySelected,
          routeEnabled: route.enabled === 1,
          channelEnabled: channel?.enabled === 1,
          modelEnabled: row.enabled === 1,
          modelApis: apis,
          channelApis: channel ? parseApis(channel.apis_json) : [],
          visibility: row.visibility === 'admin' ? 'admin' : 'all',
        })
      }
    }
    return out
  }

  function dshRouteInputs(platform: Platform = 'cloud'): DshRouteInput[] {
    // 云上：选中集合在 relay_routes.dsh_enabled；桌面：在 settings.relay_dsh_desktop.routeIds
    if (platform === 'cloud') return dshRouteInputsFrom(listModelRows(db))
    return dshRouteInputsFrom(listModelRows(db), new Set(desktopDshStore.get().routeIds))
  }

  /** 勾选中**可下发**的路由：渲染指纹用（只含真会进 managed.patch.yml 的字段） */
  function dshRenderModelsFrom(inputs: readonly DshRouteInput[]): DshRenderModel[] {
    const rows = new Map(listModelRows(db).map((row) => [row.id, row] as const))
    return inputs
      .filter(isDshRouteDeliverable)
      .filter((input) => rows.has(input.modelId))
      .map((input) => {
        const row = rows.get(input.modelId)!
        return {
          routeId: input.routeId,
          modelId: input.modelId,
          sort: input.sort,
          modelName: input.modelName,
          channelSlug: input.channelSlug,
          id: dshRouteModelId(input),
          name: dshRouteDisplayName(input),
          api: deliverApiForRoute(input)!,
          thinking: input.thinking,
          visibility: input.visibility,
          info: parseInfo(row.info_json),
          compat: row.compat_json
            ? (parseJsonColumn(row.compat_json, null) as Record<string, unknown> | null)
            : null,
        }
      })
  }

  /** 库里存的默认思考档位（迁移 083；坏值当作没设） */
  function storedDefaultThinking(row: RelayModelRow): ThinkingLevel | null {
    const parsed = ThinkingLevelSchema.safeParse(row.default_thinking)
    return parsed.success ? parsed.data : null
  }

  /** 生效的默认思考档位（12 §7.0：模型声明了它才生效，否则当作没设） */
  function effectiveThinkingFor(row: RelayModelRow): ThinkingLevel | null {
    return effectiveDshThinking(parseInfo(row.info_json), storedDefaultThinking(row))
  }

  /**
   * 写入校验（12 §7.0）：`defaultThinking` 非 null 时必须在**写入后**的 `info.reasoningEfforts` 里，
   * 且模型至少声明了一个 off 之外的档位（等价于 `effectiveDshThinking(info, v) === v`）。
   * 修改时只改 `info` 让现有默认档位失效也走这里报错，**不悄悄清掉**（契约 `UpdateRelayModelRequest.defaultThinking`）。
   */
  function assertDefaultThinking(info: ModelInfo, value: ThinkingLevel | null): void {
    if (value === null || effectiveDshThinking(info, value) === value) return
    const declared = (info.reasoningEfforts ?? []).filter((level) =>
      (THINKING_LEVELS as readonly string[]).includes(level),
    )
    const reason = declared.some((level) => level !== 'off')
      ? `这个模型的思考档位里没有「${value}」（已声明：${declared.join('、')}）`
      : '这个模型没有声明 off 之外的思考档位，不能设默认思考档位'
    throw new HubError('VALIDATION_FAILED', reason, { fields: { defaultThinking: reason } })
  }

  /** 模型级不能下发的原因（12 §7.0 DTO 兼容字段）：「已停用」「没有可用渠道」；能下发 = null */
  function blockedReasonFor(row: RelayModelRow, deliverApi: ModelApi | null): string | null {
    if (row.enabled !== 1) return '已停用'
    if (deliverApi === null) return '没有可用渠道'
    return null
  }

  /** 默认路由候选（16 §6.1）：模型 sort DESC/name，同模型内渠道优先级降序、倍率升序、渠道 id 升序 */
  function firstDeliverableRouteId(inputs: readonly DshRouteInput[], modelId: number | null): number | null {
    const candidates = inputs
      .filter((input) => input.selected && isDshRouteDeliverable(input))
      .filter((input) => modelId === null || input.modelId === modelId)
      .sort(
        (left, right) =>
          right.sort - left.sort ||
          (left.modelName < right.modelName ? -1 : left.modelName > right.modelName ? 1 : 0) ||
          left.modelId - right.modelId ||
          right.channelPriority - left.channelPriority ||
          left.ratePermille - right.ratePermille ||
          left.channelId - right.channelId ||
          left.routeId - right.routeId,
      )
    return candidates[0]?.routeId ?? null
  }

  /**
   * 把「选中的路由 + 默认路由」同步成系统提供方与系统预设（16 §6.1 / §6.2）。
   * 期望状态由纯函数（`dsh.ts`）算出，models 模块负责与库比对：**只有真的有变化才写库、才 revision + 1**，
   * 并把变更时间记进 `settings.relay_dsh.updatedAt`（`pending` 判定用）。
   * 抛错（路由名被非中转站提供方占用 = CONFLICT）交给调用方：PUT 直接失败，后台变更只告警。
   */
  function syncDshPreset(
    reason: string,
    opts: { defaultRouteId?: number | null; platform?: Platform } = {},
  ): { changed: boolean; presetId: number | null; revision: number } {
    const models = services().models
    const platform: Platform = opts.platform ?? 'cloud'
    const store = dshStoreOf(platform)
    const dsh = store.get()
    const requestedDefault = opts.defaultRouteId === undefined ? dsh.defaultRouteId : opts.defaultRouteId
    const inputs = dshRouteInputs(platform)
    const expected = expectedDshState(inputs, requestedDefault)
    if (!models) return { changed: false, presetId: dsh.presetId, revision: 0 }
    // 预设行看不出、但确实会改变 managed.patch.yml 的变化（改名/上下文/compat…）用指纹识别
    const renderHash = dshRenderFingerprint(
      dshRenderModelsFrom(inputs),
      expected,
      toolService?.renderFingerprint() ?? null,
    )
    const renderChanged = expected.preset !== null && renderHash !== dsh.renderHash
    const result = models.syncSystemPreset({
      presetId: dsh.presetId,
      platform,
      name: dshPresetNameOf(platform),
      description: DSH_SYSTEM_PRESET_DESCRIPTION,
      providers: expected.providers,
      defaultProvider: expected.preset?.defaultProvider ?? '',
      defaultModel: expected.preset?.defaultModel ?? '',
      ...(renderChanged ? { renderChanged: true } : {}),
    })
    const changed =
      result.changed ||
      result.presetId !== dsh.presetId ||
      expected.defaultModelId !== dsh.defaultModelId ||
      expected.defaultRouteId !== dsh.defaultRouteId ||
      renderChanged
    if (changed) {
      store.write({
        presetId: result.presetId,
        routeIds: inputs.filter((input) => input.selected).map((input) => input.routeId),
        defaultModelId: expected.defaultModelId,
        defaultRouteId: expected.defaultRouteId,
        updatedAt: clock.nowIso(),
        renderHash,
      })
      log.info({ reason, presetId: result.presetId, revision: result.revision }, '下发给 DSH 的配置已同步')
    }
    if (result.changed) modelsChanged = true
    return { changed, presetId: result.presetId, revision: result.revision }
  }

  /**
   * 桌面平台的「勾选集合」初值（docs/22 §3「桌面基线」的另一半，WP32d 补）。
   *
   * 迁移 124 只复制了预设行（提供方与默认模型）；勾选集合在 `relay_routes.dsh_enabled`（云上）与
   * `settings.relay_dsh_desktop.routeIds`（桌面）两处，SQL 里搬不过来。老库升级后如果管理员
   * 只配过云上，桌面清单里的 `llm-pi-ai` 就是空的 —— 桌面客户端拿不到任何渠道模型。
   *
   * 所以在桌面**第一次要用它之前**（启动补齐 / 第一次渲染桌面模型片段）从云上当前配置带一份初值：
   * 没写过 `settings.relay_dsh_desktop` 这一行就写（勾选集合 + 默认模型 / 默认路由），
   * 写过一次（哪怕被清空）就不再跟随 —— 之后两个平台各自独立。
   *
   * 「默认思考档位」不用复制：它存在 `relay_models.default_thinking`，两个平台共用同一个模型行。
   */
  function ensureDesktopDshSeeded(): { seeded: boolean; routeIds: number[] } {
    const exists = db.get<{ key: string }>(
      'SELECT key FROM settings WHERE key = ?',
      RELAY_DSH_DESKTOP_SETTINGS_KEY,
    )
    if (exists) return { seeded: false, routeIds: desktopDshStore.get().routeIds }

    const cloud = dshStore.get()
    const selected = dshRouteInputs('cloud').filter((input) => input.selected)
    if (selected.length === 0) return { seeded: false, routeIds: [] }
    // 默认路由沿用云上的（失效/没设时在与云上相同的候选顺序里挑第一条）
    const expected = expectedDshState(selected, cloud.defaultRouteId)
    const routeIds = selected.map((input) => input.routeId).sort((left, right) => left - right)
    desktopDshStore.write({
      presetId: null,
      routeIds,
      defaultModelId: expected.defaultModelId,
      defaultRouteId: expected.defaultRouteId,
      // 初值就是「云上那一刻的配置」：时间沿用云上的；云上也没记过时间就用现在
      updatedAt: cloud.updatedAt ?? clock.nowIso(),
      renderHash: null,
    })
    log.info({ routes: routeIds.length }, '桌面平台的勾选集合已从云上当前配置初始化')
    return { seeded: true, routeIds }
  }

  /**
   * 迁移 086 的启动补齐（16 §2 §6.1）：
   * - 空 slug 的渠道按名称生成（`ch<id>` 兜底、冲突加后缀），一条一个审计；
   * - 老配置只有 `defaultModelId` 时补 `defaultRouteId`（默认模型的可下发路由里按渠道优先级/倍率/id 取第一条）；
   * - 最后跑一次系统预设同步，让升级后的 `revision` 与渲染指纹对齐。
   */
  function backfillRelay086(): void {
    const channels = listChannelRows(db).filter((row) => row.slug === null || row.slug.length === 0)
    if (channels.length > 0) {
      const taken = new Set(listChannelSlugs(db))
      const at = clock.nowIso()
      db.tx(() => {
        for (const row of channels) {
          const slug = autoChannelSlug(row.name, row.id, taken)
          taken.add(slug)
          updateChannelRow(db, row.id, { slug }, at)
          audit({
            actorId: null,
            action: 'relay.channel.slug-backfill',
            targetType: 'relay.channel',
            targetId: row.id,
            detail: { name: row.name, slug },
          })
        }
      })
      log.info({ count: channels.length }, '已补齐渠道标识')
    }
    // 维护不变量：relay_models.dsh_enabled = 任一路由被选中
    syncModelDshEnabledFlags(db)
    const dsh = dshStore.get()
    if (dsh.defaultRouteId === null && dsh.defaultModelId !== null) {
      const inputs = dshRouteInputs()
      const selected = inputs.map((input) => ({ ...input, selected: true }))
      const routeId = firstDeliverableRouteId(selected, dsh.defaultModelId)
      if (routeId !== null) {
        dshStore.write({
          ...dsh,
          defaultRouteId: routeId,
          updatedAt: dsh.updatedAt ?? clock.nowIso(),
        })
      }
    }
    try {
      syncDshPreset('startup.backfill')
    } catch (error) {
      log.warn({ err: error }, '启动时同步下发给 DSH 的配置失败')
    }
    // 桌面平台第一次上线（老库升级 / 新装 Hub 只配了云上）：勾选集合从云上带一份初值（WP32d，幂等）
    try {
      ensureDesktopDshSeeded()
    } catch (error) {
      log.warn({ err: error }, '初始化桌面平台的勾选集合失败')
    }
    // 桌面平台也配过（有自己的预设/勾选集合）→ 一起对齐；没配过就等管理员第一次保存（不凭空造清单）
    const desktopDsh = desktopDshStore.get()
    if (desktopDsh.presetId !== null || desktopDsh.routeIds.length > 0) {
      try {
        syncDshPreset('startup.backfill.desktop', { platform: 'desktop' })
      } catch (error) {
        log.warn({ err: error }, '启动时同步桌面平台的下发配置失败')
      }
    }
  }

  /**
   * 影响渲染的模型/渠道变化 → 重新同步系统提供方与系统预设（12 §7.0「同步时机」）。
   * 这里吞掉异常：一次模型改名不该因为路由名被别的提供方占用而让管理员的请求 500，
   * 冲突会出现在「下发到 DSH」页的 warnings 里（PUT 时才会真的报 CONFLICT）。
   */
  function afterRenderAffectingChange(reason: string): void {
    try {
      syncDshPreset(reason)
    } catch (error) {
      log.warn({ err: error, reason }, '同步下发给 DSH 的配置失败')
    }
  }

  // ── 渠道 ──────────────────────────────────────────────────────────────────

  function usableKeys(keys: RelayChannelKeyRow[], nowIso: string): RelayChannelKeyRow[] {
    const nowMs = Date.parse(nowIso)
    return keys.filter((key) => {
      if (key.state !== 'active') return false
      if (!key.cooldown_until) return true
      const until = Date.parse(key.cooldown_until)
      return !Number.isFinite(until) || until <= nowMs
    })
  }

  function channelHealth(
    row: RelayChannelRow,
    keys: RelayChannelKeyRow[],
    nowIso: string,
  ): RelayChannelHealth {
    if (row.enabled !== 1) return 'disabled'
    const until = row.cooldown_until ? Date.parse(row.cooldown_until) : Number.NaN
    if (Number.isFinite(until) && until > Date.parse(nowIso)) return 'cooling'
    if (usableKeys(keys, nowIso).length === 0) return 'no-key'
    return 'ok'
  }

  function channelDto(row: RelayChannelRow, keys: RelayChannelKeyRow[], modelCount: number): RelayChannel {
    const nowIso = clock.nowIso()
    return {
      id: row.id,
      name: row.name,
      slug: channelSlugOf(row),
      scope: parseScope(row.scope),
      baseUrl: row.base_url,
      apis: parseApis(row.apis_json),
      ratePermille: row.rate_permille,
      priority: row.priority,
      weight: row.weight,
      maxConcurrency: row.max_concurrency,
      timeoutMs: row.timeout_ms,
      proxyUrl: row.proxy_url,
      headers: parseHeaders(row.headers_json),
      streamUsage: row.stream_usage === 1,
      enabled: row.enabled === 1,
      note: row.note,
      keys: keys.map(toRelayChannelKey),
      health: channelHealth(row, keys, nowIso),
      failStreak: row.fail_streak,
      cooldownUntil: row.cooldown_until,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      inFlight: channelInFlight.get(row.id) ?? 0,
      modelCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function modelCountMap(): Map<number, number> {
    const out = new Map<number, number>()
    for (const route of db.all<{ channel_id: number; n: number }>(
      'SELECT channel_id, COUNT(DISTINCT model_id) AS n FROM relay_routes GROUP BY channel_id',
    )) {
      out.set(route.channel_id, Number(route.n))
    }
    return out
  }

  function requireChannel(channelId: number): RelayChannelRow {
    const row = getChannelRow(db, channelId)
    if (!row) throw new HubError('NOT_FOUND', '渠道不存在')
    return row
  }

  function channelDtoById(channelId: number): RelayChannel {
    const row = requireChannel(channelId)
    return channelDto(row, listChannelKeyRows(db, channelId), modelCountMap().get(channelId) ?? 0)
  }

  /** `baseUrl` 规范化 + 校验（12 §9：必须 http(s)://，去掉末尾 `/`） */
  function normalizeBaseUrl(raw: string): string {
    const value = raw.trim().replace(/\/+$/u, '')
    if (!/^https?:\/\//u.test(value)) {
      throw new HubError('VALIDATION_FAILED', 'baseUrl 必须是 http(s) 地址', {
        fields: { baseUrl: '必须以 http:// 或 https:// 开头' },
      })
    }
    try {
      new URL(value)
    } catch {
      throw new HubError('VALIDATION_FAILED', 'baseUrl 不是合法 URL', { fields: { baseUrl: '格式不对' } })
    }
    return value
  }

  /** 渠道自定义头里禁止鉴权头（12 §9）：密钥只能走密钥池，不能藏在 headers 里 */
  function assertHeadersAllowed(headers: Record<string, string> | null | undefined): void {
    if (!headers) return
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'cookie') {
        throw new HubError('VALIDATION_FAILED', `headers 里不能有 ${name}，密钥请加到密钥池`, {
          fields: { headers: '不能包含鉴权头' },
        })
      }
    }
  }

  function normalizeApis(apis: ModelApi[]): ModelApi[] {
    return [...new Set(apis)]
  }

  /** 18 §3.1：Claude Code 渠道只能 anthropic-messages、Codex 渠道只能 openai-responses */
  function assertScopeApis(scope: RelayScope, apis: ModelApi[]): void {
    if (scope === 'dsh') return
    const expected = AGENT_MODE_API[scope]
    if (apis.length === 1 && apis[0] === expected) return
    const label = scope === 'claude-code' ? 'Claude Code' : 'Codex'
    const reason = `${label} 渠道只能选 ${expected} 这一个协议`
    throw new HubError('VALIDATION_FAILED', reason, { fields: { apis: reason } })
  }

  function listChannels(scope: RelayScope = 'dsh'): RelayChannel[] {
    const counts = modelCountMap()
    const nowIso = clock.nowIso()
    clearExpiredKeyCooldowns(db, nowIso)
    return listChannelRows(db, scope).map((row) =>
      channelDto(row, listChannelKeyRows(db, row.id), counts.get(row.id) ?? 0),
    )
  }

  /** 管理员手填的标识：格式（schema 已校验，这里兜住直接调 service 的测试）+ 全局唯一（16 §2） */
  function normalizeExplicitSlug(
    slug: string | undefined,
    excludeId: number | null = null,
  ): string | undefined {
    if (slug === undefined) return undefined
    const parsed = RelayChannelSlugSchema.safeParse(slug)
    if (!parsed.success) {
      const reason = '标识只能用小写字母、数字和 -，以字母或数字开头，最长 24 位'
      throw new HubError('VALIDATION_FAILED', reason, { fields: { slug: reason } })
    }
    const existing = getChannelRowBySlug(db, parsed.data)
    if (existing && existing.id !== excludeId) {
      const reason = `标识 ${parsed.data} 已被渠道「${existing.name}」使用`
      throw new HubError('VALIDATION_FAILED', reason, { fields: { slug: reason } })
    }
    return parsed.data
  }

  function createChannel(input: CreateRelayChannelRequest, actorId: number, meta: RequestMeta): RelayChannel {
    if (getChannelRowByName(db, input.name)) {
      throw new HubError('CONFLICT', `渠道名 ${input.name} 已存在`)
    }
    assertHeadersAllowed(input.headers)
    const scope = parseScope(input.scope ?? 'dsh')
    const apis = normalizeApis(input.apis)
    if (apis.length === 0) {
      throw new HubError('VALIDATION_FAILED', '至少选一个协议', { fields: { apis: '必填' } })
    }
    assertScopeApis(scope, apis)
    // 手填的标识先查重；省略的等拿到自增 id 后再按名称生成（结果为空时用 `ch<id>`）
    const explicitSlug = normalizeExplicitSlug(input.slug)
    const at = clock.nowIso()
    const id = db.tx(() => {
      const channelId = insertChannelRow(db, {
        scope,
        name: input.name,
        slug: null,
        baseUrl: normalizeBaseUrl(input.baseUrl),
        apis,
        ratePermille: input.ratePermille,
        priority: input.priority,
        weight: input.weight,
        maxConcurrency: input.maxConcurrency,
        timeoutMs: input.timeoutMs,
        proxyUrl: input.proxyUrl ? normalizeProxyUrl(input.proxyUrl) : null,
        headers: input.headers ?? null,
        streamUsage: input.streamUsage,
        enabled: input.enabled,
        note: input.note,
        at,
      })
      for (const key of input.keys) {
        const trimmed = key.trim()
        if (trimmed.length === 0) continue
        const hash = hashRelayKey(trimmed)
        if (findChannelKeyRowByHash(db, channelId, hash)) continue
        insertChannelKeyRow(db, {
          channelId,
          label: '',
          keyEnc: encrypt(trimmed),
          keyHash: hash,
          last4: keyLast4(trimmed),
          at,
        })
      }
      const slug = explicitSlug ?? autoChannelSlug(input.name, channelId, new Set(listChannelSlugs(db)))
      updateChannelRow(db, channelId, { slug }, at)
      return channelId
    })
    audit({
      actorId,
      meta,
      action: 'relay.channel.create',
      targetType: 'relay.channel',
      targetId: id,
      detail: {
        name: input.name,
        scope,
        slug: channelDtoById(id).slug,
        baseUrl: input.baseUrl,
        apis,
        ratePermille: input.ratePermille,
        keys: input.keys.length,
      },
    })
    if (input.keys.length > 0) {
      audit({ actorId, meta, action: 'relay.channel.key.add', targetType: 'relay.channel', targetId: id })
    }
    if (input.enabled) afterScopeRenderChange(scope, 'channel.create')
    return channelDtoById(id)
  }

  function normalizeProxyUrl(raw: string): string {
    const value = raw.trim()
    if (!/^(https?|socks[45]?):\/\//u.test(value)) {
      throw new HubError('VALIDATION_FAILED', 'proxyUrl 必须是 http(s)/socks 代理地址', {
        fields: { proxyUrl: '格式不对' },
      })
    }
    return value
  }

  function updateChannel(
    channelId: number,
    input: UpdateRelayChannelRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayChannel {
    const row = requireChannel(channelId)
    if (input.name !== undefined && input.name !== row.name && getChannelRowByName(db, input.name)) {
      throw new HubError('CONFLICT', `渠道名 ${input.name} 已存在`)
    }
    assertHeadersAllowed(input.headers)
    const nextSlug = normalizeExplicitSlug(input.slug, channelId)
    if (nextSlug !== undefined && nextSlug === row.slug) {
      // 值没变：不写库、不进审计的 from/to
      input = { ...input, slug: undefined }
    }
    const apis = input.apis === undefined ? undefined : normalizeApis(input.apis)
    if (apis !== undefined && apis.length === 0) {
      throw new HubError('VALIDATION_FAILED', '至少选一个协议', { fields: { apis: '必填' } })
    }
    if (apis !== undefined) assertScopeApis(parseScope(row.scope), apis)
    const at = clock.nowIso()
    updateChannelRow(
      db,
      channelId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: normalizeBaseUrl(input.baseUrl) }),
        ...(apis === undefined ? {} : { apis }),
        ...(input.ratePermille === undefined ? {} : { ratePermille: input.ratePermille }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.weight === undefined ? {} : { weight: input.weight }),
        ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.proxyUrl === undefined
          ? {}
          : { proxyUrl: input.proxyUrl ? normalizeProxyUrl(input.proxyUrl) : null }),
        ...(input.headers === undefined ? {} : { headers: input.headers ?? null }),
        ...(input.streamUsage === undefined ? {} : { streamUsage: input.streamUsage }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.note === undefined ? {} : { note: input.note }),
        // 人工改渠道（尤其是重新启用）时清掉熔断状态，否则「启用了却还在冷却」很反直觉
        ...(input.enabled === true ? { failStreak: 0, cooldownUntil: null } : {}),
      },
      at,
    )
    audit({
      actorId,
      meta,
      action: 'relay.channel.update',
      targetType: 'relay.channel',
      targetId: channelId,
      detail: {
        fields: Object.keys(input),
        // 倍率直接影响计费，审计里留前后值（12 §9）
        ...(input.ratePermille === undefined || input.ratePermille === row.rate_permille
          ? {}
          : { ratePermille: { from: row.rate_permille, to: input.ratePermille } }),
        // 标识改变会影响用户看到的模型名，必须重新下发；审计留前后值
        ...(input.slug === undefined ? {} : { slug: { from: row.slug, to: input.slug } }),
      },
    })
    // 倍率只影响计费，不影响渲染（12 §7.4）
    // 标识修改会改变 `模型@标识`，必须触发重新下发（16 §2）；倍率仍然不影响渲染
    const renderAffecting =
      input.slug !== undefined ||
      apis !== undefined ||
      input.enabled !== undefined ||
      input.baseUrl !== undefined
    if (renderAffecting) afterScopeRenderChange(parseScope(row.scope), 'channel.update')
    return channelDtoById(channelId)
  }

  function deleteChannel(channelId: number, actorId: number, meta: RequestMeta): void {
    const row = requireChannel(channelId)
    const models = listChannelModelNames(db, channelId)
    if (models.length > 0) {
      throw new HubError('CONFLICT', `还有 ${String(models.length)} 个对外模型在用该渠道`, { models })
    }
    db.tx(() => {
      deleteChannelRow(db, channelId)
    })
    audit({
      actorId,
      meta,
      action: 'relay.channel.delete',
      targetType: 'relay.channel',
      targetId: channelId,
      detail: { name: row.name },
    })
  }

  /** 渠道调试用 HTTP 请求（测试连接 / 发现模型），超时与错误都已脱敏 */
  async function channelFetch(
    row: RelayChannelRow,
    apiKey: string,
    path: string,
    timeoutMs = TEST_TIMEOUT_MS,
  ): Promise<{ ok: boolean; status: number | null; latencyMs: number; body: string; error?: string }> {
    const anthropicOnly = parseApis(row.apis_json).every((api) => api === 'anthropic-messages')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (anthropicOnly) {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.authorization = `Bearer ${apiKey}`
    }
    const started = Date.now()
    try {
      const response = await fetch(`${row.base_url.replace(/\/+$/u, '')}${path}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = (await response.text()).slice(0, 4_000)
      return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, body: text }
    } catch (error) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        body: '',
        error: sanitizeUpstreamError(error instanceof Error ? error.message : String(error)),
      }
    }
  }

  async function testChannel(channelId: number): Promise<TestRelayChannelResponse> {
    const row = requireChannel(channelId)
    const keys = listChannelKeyRows(db, channelId).filter((key) => key.state !== 'disabled')
    const results: TestRelayChannelResponse['results'] = []
    for (let index = 0; index < keys.length; index += TEST_CONCURRENCY) {
      const slice = keys.slice(index, index + TEST_CONCURRENCY)
      const settled = await Promise.all(
        slice.map(async (key) => {
          const plain = decrypt(key.key_enc)
          if (!plain) {
            return {
              keyId: key.id,
              last4: key.last4,
              ok: false,
              latencyMs: 0,
              httpStatus: null,
              error: '密钥无法解密',
            }
          }
          const response = await channelFetch(row, plain, '/models')
          return {
            keyId: key.id,
            last4: key.last4,
            ok: response.ok,
            latencyMs: response.latencyMs,
            httpStatus: response.status,
            ...(response.ok ? {} : { error: response.error ?? `HTTP ${String(response.status ?? '—')}` }),
          }
        }),
      )
      results.push(...settled)
    }
    return { ok: results.length > 0 && results.every((item) => item.ok), results }
  }

  async function discoverChannel(channelId: number): Promise<DiscoverRelayChannelResponse> {
    const row = requireChannel(channelId)
    const keys = listChannelKeyRows(db, channelId).filter((key) => key.state === 'active')
    const first = keys[0]
    if (!first) throw new HubError('VALIDATION_FAILED', '渠道没有可用密钥，先加一把再发现模型')
    const plain = decrypt(first.key_enc)
    if (!plain) throw new HubError('INTERNAL', '渠道密钥无法解密')
    const apis = parseApis(row.apis_json)
    const api: ModelApi = apis.includes('openai-completions')
      ? 'openai-completions'
      : (apis[0] ?? 'openai-completions')
    // 复用 models 模块的发现/匹配逻辑（06 §4.1），不另起一套
    const models = services().models
    if (!models) throw new HubError('INTERNAL', 'models 服务未装配')
    const discovered = await models.discover({ api, baseUrl: row.base_url, apiKey: plain })
    // 18 F4：模型名全局唯一；发现页的「已有同名模型」只认渠道所在作用域
    const existing = new Map(listModelRows(db, parseScope(row.scope)).map((item) => [item.name, item.id]))
    return {
      models: discovered.models.map((model) => ({
        ...model,
        existingModelId: existing.get(model.id) ?? null,
      })),
    }
  }

  function addChannelKeys(
    channelId: number,
    input: AddRelayChannelKeysRequest,
    actorId: number,
    meta: RequestMeta,
  ): AddRelayChannelKeysResponse {
    requireChannel(channelId)
    const at = clock.nowIso()
    let added = 0
    let skipped = 0
    db.tx(() => {
      for (const raw of input.keys) {
        const key = raw.trim()
        if (key.length === 0) {
          skipped += 1
          continue
        }
        const hash = hashRelayKey(key)
        if (findChannelKeyRowByHash(db, channelId, hash)) {
          skipped += 1
          continue
        }
        insertChannelKeyRow(db, {
          channelId,
          label: input.label,
          keyEnc: encrypt(key),
          keyHash: hash,
          last4: keyLast4(key),
          at,
        })
        added += 1
      }
    })
    audit({
      actorId,
      meta,
      action: 'relay.channel.key.add',
      targetType: 'relay.channel',
      targetId: channelId,
      detail: { added, skipped },
    })
    return { added, skipped, channel: channelDtoById(channelId) }
  }

  function updateChannelKey(
    channelId: number,
    keyId: number,
    input: UpdateRelayChannelKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayChannel {
    requireChannel(channelId)
    const key = getChannelKeyRow(db, keyId)
    if (!key || key.channel_id !== channelId) throw new HubError('NOT_FOUND', '渠道密钥不存在')
    updateChannelKeyRow(db, keyId, {
      ...(input.label === undefined ? {} : { label: input.label }),
      // 人工恢复（auto-disabled → active）时把冷却与最近错误一起清掉
      ...(input.state === undefined
        ? {}
        : {
            state: input.state,
            ...(input.state === 'active' ? { cooldownUntil: null, lastError: null } : {}),
          }),
    })
    audit({
      actorId,
      meta,
      action: 'relay.channel.key.update',
      targetType: 'relay.channel.key',
      targetId: keyId,
      detail: { channelId, fields: Object.keys(input) },
    })
    return channelDtoById(channelId)
  }

  function deleteChannelKey(
    channelId: number,
    keyId: number,
    actorId: number,
    meta: RequestMeta,
  ): RelayChannel {
    requireChannel(channelId)
    const key = getChannelKeyRow(db, keyId)
    if (!key || key.channel_id !== channelId) throw new HubError('NOT_FOUND', '渠道密钥不存在')
    deleteChannelKeyRow(db, keyId)
    audit({
      actorId,
      meta,
      action: 'relay.channel.key.remove',
      targetType: 'relay.channel.key',
      targetId: keyId,
      detail: { channelId, last4: key.last4 },
    })
    return channelDtoById(channelId)
  }

  // ── 对外模型 ──────────────────────────────────────────────────────────────

  function routeDtos(modelId: number): RelayRoute[] {
    const channels = new Map(listChannelRows(db).map((row) => [row.id, row]))
    return listRouteRows(db, modelId).map((route) => {
      const channel = channels.get(route.channel_id)
      return toRelayRoute(
        route,
        channel?.name ?? `#${String(route.channel_id)}`,
        // 渠道被删掉时（理论上不允许，ON DELETE RESTRICT）回落到默认倍率，不炸列表
        channel?.rate_permille ?? RELAY_RATE_PERMILLE_DEFAULT,
        channel ? channelSlugOf(channel) : `ch${String(route.channel_id)}`,
      )
    })
  }

  /** 模型能用哪些接口 = 启用路由所在启用渠道的 apis 并集（12 §8 的 `apis` 派生字段） */
  function modelApis(modelId: number): ModelApi[] {
    const out = new Set<ModelApi>()
    for (const route of listRouteRows(db, modelId)) {
      if (route.enabled !== 1) continue
      const channel = getChannelRow(db, route.channel_id)
      if (!channel || channel.enabled !== 1) continue
      for (const api of parseApis(channel.apis_json)) out.add(api)
    }
    return [...out]
  }

  function modelDto(row: RelayModelRow): RelayModel {
    return toRelayModel(row, routeDtos(row.id), modelApis(row.id))
  }

  function requireModel(modelId: number): RelayModelRow {
    const row = getModelRow(db, modelId)
    if (!row) throw new HubError('NOT_FOUND', '对外模型不存在')
    return row
  }

  /** 用模型信息库补全缺的字段（06 §4.1；省略的字段才补，管理员填了的不动） */
  async function fillInfo(info: ModelInfo, name: string): Promise<ModelInfo> {
    const missing =
      info.contextWindow === undefined ||
      info.maxTokens === undefined ||
      info.input === undefined ||
      info.reasoningEfforts === undefined
    if (!missing) return info
    const models = services().models
    if (!models) return info
    try {
      const matched = await models.matchModels([name])
      const hit = matched.matches[0]
      if (!hit) return info
      return {
        ...(info.contextWindow === undefined && hit.contextWindow !== undefined
          ? { contextWindow: hit.contextWindow }
          : {}),
        ...(info.maxTokens === undefined && hit.maxTokens !== undefined ? { maxTokens: hit.maxTokens } : {}),
        ...(info.input === undefined && hit.input !== undefined ? { input: hit.input } : {}),
        ...(info.reasoningEfforts === undefined && hit.reasoningEfforts !== undefined
          ? { reasoningEfforts: hit.reasoningEfforts }
          : {}),
        ...info,
        ...(info.name === undefined && hit.name !== undefined ? { name: hit.name } : {}),
      }
    } catch {
      return info
    }
  }

  /** 18 §3.1：路由必须与模型同作用域（「渠道和模型不在同一个页面」） */
  function assertRoutesUsable(routes: { channelId: number }[], scope: RelayScope): void {
    for (const route of routes) {
      const channel = getChannelRow(db, route.channelId)
      if (!channel) {
        throw new HubError('VALIDATION_FAILED', `渠道 ${String(route.channelId)} 不存在`, {
          fields: { routes: '引用了不存在的渠道' },
        })
      }
      if (parseScope(channel.scope) !== scope) {
        const reason = '渠道和模型不在同一个页面'
        throw new HubError('VALIDATION_FAILED', reason, { fields: { routes: reason } })
      }
    }
  }

  /** 作用域对应的页面名（18 F4 的模型名冲突文案） */
  function scopePageLabel(scope: RelayScope): string {
    if (scope === 'claude-code') return 'Claude Code'
    if (scope === 'codex') return 'Codex'
    return '模型'
  }

  /** 模型名全局唯一（18 F4）：别的页面已用时给可读的 VALIDATION_FAILED，不是 CONFLICT */
  function assertModelNameFree(name: string, scope: RelayScope, excludeId: number | null = null): void {
    const existing = getModelRowByName(db, name)
    if (!existing || existing.id === excludeId) return
    const existingScope = parseScope(existing.scope)
    if (existingScope === scope) throw new HubError('CONFLICT', `对外模型 ${name} 已存在`)
    const reason = `这个模型名已被「${scopePageLabel(existingScope)}」页使用`
    throw new HubError('VALIDATION_FAILED', reason, { fields: { name: reason } })
  }

  /** 只有 dsh 作用域的下发到 DSH 需要重新对账；两个模式页不发 managed.patch.yml */
  function afterScopeRenderChange(scope: RelayScope, reason: string): void {
    if (scope === 'dsh') afterRenderAffectingChange(reason)
  }

  function listModels(scope: RelayScope = 'dsh'): RelayModel[] {
    return listModelRows(db, scope).map(modelDto)
  }

  /**
   * 手机端计费用快照：DSH 模型 id（`<对外模型名>@<渠道标识>`）→ 价格 + 渠道倍率。
   *
   * 手机通道的 `models` 帧要显示「X0.3」、`usage` 帧要算积分消耗，但这些请求都发生在
   * 每条消息/每次列目录的路径上，不能每次都逐模型查库；TTL 30s + 一次查全量。
   */
  let mobilePricingCache: {
    at: number
    map: Map<string, { price: ReturnType<typeof toRelayPrice>; channelRatePermille: number }>
  } | null = null

  function mobilePricingMap(): Map<
    string,
    { price: ReturnType<typeof toRelayPrice>; channelRatePermille: number }
  > {
    if (mobilePricingCache !== null && Date.now() - mobilePricingCache.at < 30_000) {
      return mobilePricingCache.map
    }
    const channels = new Map(listChannelRows(db, 'dsh').map((row) => [row.id, row]))
    const map = new Map<string, { price: ReturnType<typeof toRelayPrice>; channelRatePermille: number }>()
    const models = listModelRows(db, 'dsh')
    if (models.length > 0) {
      const routes = listRouteRowsForModels(db, models.map((model) => model.id))
      const routesByModel = new Map<number, typeof routes>()
      for (const route of routes) {
        const list = routesByModel.get(route.model_id) ?? []
        list.push(route)
        routesByModel.set(route.model_id, list)
      }
      for (const model of models) {
        if (model.enabled !== 1) continue
        const price = toRelayPrice(model)
        for (const route of routesByModel.get(model.id) ?? []) {
          if (route.enabled !== 1) continue
          const channel = channels.get(route.channel_id)
          if (channel === undefined || channel.slug === null) continue
          map.set(`${model.name}@${channel.slug}`, {
            price,
            channelRatePermille: channel.rate_permille,
          })
        }
      }
    }
    mobilePricingCache = { at: Date.now(), map }
    return map
  }

  /** DSH 模型 id → 渠道倍率（1 = 原价，0.3 = 三折）；拿不到价格信息返回 null。 */
  function modelMultiplier(dshModelId: string): number | null {
    const entry = mobilePricingMap().get(dshModelId)
    return entry === undefined ? null : entry.channelRatePermille / 1000
  }

  /**
   * 一条 assistant/message 的微积分消耗（手机用量面板），与计费公式完全一致：
   * 模型价格 × 渠道倍率 × 钱包倍率。模型没有价格信息（如 Claude/Codex 渠道）返回 null。
   */
  function quoteCostMicro(input: {
    userId: number
    model: string
    tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  }): number | null {
    const entry = mobilePricingMap().get(input.model)
    if (entry === undefined) return null
    const wallet = getWalletRow(db, input.userId)
    return computeCostMicro(
      entry.price,
      {
        input: input.tokens.inputTokens,
        cacheRead: input.tokens.cacheReadTokens,
        cacheWrite: input.tokens.cacheWriteTokens,
        output: input.tokens.outputTokens,
      },
      {
        walletRatePercent: wallet?.rate_percent ?? 100,
        channelRatePermille: entry.channelRatePermille,
      },
    )
  }

  async function createModel(
    input: CreateRelayModelRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<RelayModel> {
    const scope = parseScope(input.scope ?? 'dsh')
    assertModelNameFree(input.name, scope)
    assertRoutesUsable(input.routes, scope)
    const at = clock.nowIso()
    const info = await fillInfo(input.info, input.name)
    // 校验用补全后的 info（12 §7.0：写在 info.reasoningEfforts 里才有效）
    assertDefaultThinking(info, input.defaultThinking)
    const id = db.tx(() => {
      const modelId = insertModelRow(db, {
        scope,
        name: input.name,
        displayName: input.displayName?.trim() || input.name,
        enabled: input.enabled,
        visibility: input.visibility,
        priceInput: input.price.inputMicro,
        priceOutput: input.price.outputMicro,
        priceCacheRead: input.price.cacheReadMicro,
        priceCacheWrite: input.price.cacheWriteMicro,
        priceRequest: input.price.perRequestMicro,
        info,
        compat: input.compat,
        defaultThinking: input.defaultThinking,
        sort: input.sort,
        at,
      })
      for (const route of input.routes) {
        insertRouteRow(db, {
          modelId,
          channelId: route.channelId,
          upstreamModel: route.upstreamModel?.trim() || input.name,
          priority: route.priority ?? null,
          weight: route.weight ?? null,
          enabled: route.enabled,
        })
      }
      return modelId
    })
    audit({
      actorId,
      meta,
      action: 'relay.model.create',
      targetType: 'relay.model',
      targetId: id,
      detail: { name: input.name, scope, routes: input.routes.length },
    })
    if (input.enabled && input.visibility === 'all') afterScopeRenderChange(scope, 'model.create')
    return modelDto(requireModel(id))
  }

  /**
   * 整体替换模型的路由，但**按「渠道 + 上游模型名」保住已有行的 id 与选中状态**：
   * 直接删了重建会让 `settings.relay_dsh.defaultRouteId` 失效、用户的下发选择丢失（16 §6.1）。
   * 上游模型名改了的算新路由（默认不选中，需要重新勾选）。
   */
  function replaceModelRoutes(
    modelId: number,
    routes: UpdateRelayModelRequest['routes'],
    nextName: string,
  ): void {
    if (routes === undefined) return
    const existing = listRouteRows(db, modelId)
    const byKey = new Map<string, RelayRouteRow>()
    for (const row of existing) byKey.set(`${String(row.channel_id)}\u0000${row.upstream_model}`, row)
    const kept = new Set<number>()
    for (const route of routes) {
      const upstreamModel = route.upstreamModel?.trim() || nextName
      const key = `${String(route.channelId)}\u0000${upstreamModel}`
      const row = byKey.get(key)
      if (row && !kept.has(row.id)) {
        kept.add(row.id)
        updateRouteRow(db, row.id, {
          priority: route.priority ?? null,
          weight: route.weight ?? null,
          enabled: route.enabled,
        })
        continue
      }
      insertRouteRow(db, {
        modelId,
        channelId: route.channelId,
        upstreamModel,
        priority: route.priority ?? null,
        weight: route.weight ?? null,
        enabled: route.enabled,
      })
    }
    for (const row of existing) {
      if (!kept.has(row.id)) deleteRouteRow(db, row.id)
    }
  }

  async function updateModel(
    modelId: number,
    input: UpdateRelayModelRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<RelayModel> {
    const row = requireModel(modelId)
    const scope = parseScope(row.scope)
    if (input.name !== undefined && input.name !== row.name) assertModelNameFree(input.name, scope, modelId)
    if (input.routes !== undefined) assertRoutesUsable(input.routes, scope)
    const at = clock.nowIso()
    const nextName = input.name ?? row.name
    const needsInfoFill =
      input.info !== undefined &&
      (input.info.contextWindow === undefined ||
        input.info.maxTokens === undefined ||
        input.info.input === undefined ||
        input.info.reasoningEfforts === undefined)
    const info =
      input.info === undefined ? undefined : needsInfoFill ? await fillInfo(input.info, nextName) : input.info
    // 默认档位用**更新后**的 info 校验：只改 info 让现有档位失效也报错，不悄悄清掉（12 §7.0）。
    // 只在这次改了 info 或 defaultThinking 时校验：库里已经不生效的旧值（渲染时当作没设、GET /dsh 有 warning）
    // 不能挡住改价格、改名、启停这类无关修改
    if (input.info !== undefined || input.defaultThinking !== undefined) {
      const nextDefaultThinking =
        input.defaultThinking === undefined ? storedDefaultThinking(row) : input.defaultThinking
      assertDefaultThinking(info ?? parseInfo(row.info_json), nextDefaultThinking)
    }
    db.tx(() => {
      updateModelRow(
        db,
        modelId,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() || nextName }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
          ...(input.price === undefined
            ? {}
            : {
                priceInput: input.price.inputMicro,
                priceOutput: input.price.outputMicro,
                priceCacheRead: input.price.cacheReadMicro,
                priceCacheWrite: input.price.cacheWriteMicro,
                priceRequest: input.price.perRequestMicro,
              }),
          ...(info === undefined ? {} : { info }),
          ...(input.compat === undefined ? {} : { compat: input.compat }),
          ...(input.defaultThinking === undefined ? {} : { defaultThinking: input.defaultThinking }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
        },
        at,
      )
      if (input.routes !== undefined) {
        replaceModelRoutes(modelId, input.routes, nextName)
        syncModelDshEnabledFlags(db)
      }
    })
    audit({
      actorId,
      meta,
      action: 'relay.model.update',
      targetType: 'relay.model',
      targetId: modelId,
      detail: { fields: Object.keys(input) },
    })
    // 价格不影响渲染（12 §7.4）；其余变动（含 sort——它决定 patch 里模型的顺序）都要重新对账
    const renderAffecting = Object.keys(input).some((field) => field !== 'price')
    if (renderAffecting) afterScopeRenderChange(scope, 'model.update')
    return modelDto(requireModel(modelId))
  }

  function deleteModel(modelId: number, actorId: number, meta: RequestMeta): void {
    const row = requireModel(modelId)
    db.tx(() => {
      deleteRoutesForModel(db, modelId)
      deleteModelRow(db, modelId)
    })
    audit({
      actorId,
      meta,
      action: 'relay.model.delete',
      targetType: 'relay.model',
      targetId: modelId,
      detail: { name: row.name },
    })
    if (row.enabled === 1) afterScopeRenderChange(parseScope(row.scope), 'model.delete')
  }

  async function importModels(
    input: ImportRelayModelsRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ImportRelayModelsResponse> {
    const channel = getChannelRow(db, input.channelId)
    if (!channel) throw new HubError('VALIDATION_FAILED', '渠道不存在', { fields: { channelId: '不存在' } })
    // 18 §3.1：导入的目标作用域 = 渠道的作用域
    const scope = parseScope(channel.scope)
    const at = clock.nowIso()
    const touched = new Set<number>()
    let created = 0
    let routesAdded = 0
    let skipped = 0
    // 省略 price = 新模型价格全 0（「未定价」，之后在「模型与价格」里逐个定价）；已有模型只加路由、不改价
    const price = input.price ?? {
      inputMicro: 0,
      outputMicro: 0,
      cacheReadMicro: null,
      cacheWriteMicro: null,
      perRequestMicro: 0,
    }

    for (const item of input.models) {
      const name = item.name ?? item.upstreamModel
      const nameCheck = RelayModelNameSchema.safeParse(name)
      if (!nameCheck.success) {
        skipped += 1
        continue
      }
      const existing = getModelRowByName(db, name)
      if (existing && parseScope(existing.scope) !== scope) {
        // 18 F4：模型名三个作用域共用；同名模型在别的页面 → 跳过（别在这里报 500）
        skipped += 1
        continue
      }
      if (existing) {
        const dup = listRouteRows(db, existing.id).some(
          (route) => route.channel_id === input.channelId && route.upstream_model === item.upstreamModel,
        )
        if (dup) {
          skipped += 1
        } else {
          insertRouteRow(db, {
            modelId: existing.id,
            channelId: input.channelId,
            upstreamModel: item.upstreamModel,
            priority: null,
            weight: null,
            enabled: true,
          })
          routesAdded += 1
        }
        touched.add(existing.id)
        continue
      }
      const info = await fillInfo(item.info ?? {}, name)
      const modelId = db.tx(() =>
        insertModelRow(db, {
          scope,
          name,
          displayName: item.displayName?.trim() || name,
          enabled: true,
          visibility: 'all',
          priceInput: price.inputMicro,
          priceOutput: price.outputMicro,
          priceCacheRead: price.cacheReadMicro,
          priceCacheWrite: price.cacheWriteMicro,
          priceRequest: price.perRequestMicro,
          info,
          compat: null,
          sort: 0,
          at,
        }),
      )
      insertRouteRow(db, {
        modelId,
        channelId: input.channelId,
        upstreamModel: item.upstreamModel,
        priority: null,
        weight: null,
        enabled: true,
      })
      created += 1
      touched.add(modelId)
    }

    audit({
      actorId,
      meta,
      action: 'relay.model.import',
      targetType: 'relay.model',
      targetId: input.channelId,
      detail: { channelId: input.channelId, scope, created, routesAdded, skipped },
    })
    if (created > 0 || routesAdded > 0) afterScopeRenderChange(scope, 'model.import')
    const models = [...touched].map((id) => modelDto(requireModel(id)))
    return { created, routesAdded, skipped, models }
  }

  // ── 钱包与流水 ────────────────────────────────────────────────────────────

  /** GET 接口不写库：没有钱包的用户按默认值显示（12 §6.4） */
  function walletOrDefault(userId: number): RelayWalletDbRow {
    const row = getWalletRow(db, userId)
    if (row) return row
    const at = clock.nowIso()
    return {
      user_id: userId,
      balance: 0,
      rate_percent: 100,
      max_concurrency: null,
      daily_limit: null,
      enabled: 1,
      total_spent: 0,
      last_used_at: null,
      daily_bonus_left: 0,
      daily_bonus_day: null,
      created_at: at,
      updated_at: at,
    }
  }

  interface WalletAggregates {
    todayCostMicro: number
    monthCostMicro: number
    monthRequests: number
  }

  /** 扣费后「今日赠送剩余」：消费先用赠送（13 §2.1），扣到 0 为止 */
  function dailyBonusAfter(left: number, amountMicro: number): number {
    if (amountMicro <= 0) return Math.max(left, 0)
    return Math.max(0, left - amountMicro)
  }

  /**
   * 作废昨天的赠送（13 §2.2）。**必须在事务内调用**：所有扣费/发放都要先执行它。
   * 规则：`daily_bonus_day < 今天` 且 `daily_bonus_left > 0` 时，
   * 作废额 = min(left, max(balance, 0))，> 0 写一条 `expire` 负数流水并扣余额；然后 left = 0（day 不动）。
   */
  function expireStaleBonusTx(userId: number, at: string): void {
    const row = getWalletRow(db, userId)
    if (!row || row.daily_bonus_left <= 0) return
    const today = shanghaiDay(at)
    if (row.daily_bonus_day !== null && row.daily_bonus_day >= today) return
    const expireAmount = Math.min(row.daily_bonus_left, Math.max(row.balance, 0))
    if (expireAmount > 0) {
      const balance = row.balance - expireAmount
      updateWalletRow(db, userId, { balance, dailyBonusLeft: 0 }, at)
      insertLedgerRow(db, {
        userId,
        type: 'expire',
        amount: -expireAmount,
        balanceAfter: balance,
        note: '每日赠送过期作废',
        actorId: null,
        at,
      })
      return
    }
    // 余额已经 ≤ 0：没有可扣的，但赠送剩余也不能留到明天再花
    updateWalletRow(db, userId, { dailyBonusLeft: 0 }, at)
  }

  /** 每日赠送（13 §2.3）：先作废昨天的，再按设置给今天的一次。返回本次发放额（未发 = 0）。 */
  function grantDailyBonus(userId: number): number {
    const at = clock.nowIso()
    return db.tx(() => {
      expireStaleBonusTx(userId, at)
      const bonus = settings().dailyBonusMicro
      if (bonus <= 0) return 0
      const user = getUserStatusRow(db, userId)
      // 待审批 / 停用 / 已删除不发；管理员账号同样发放（13 §2.3）
      if (!user || user.deleted_at !== null || user.status !== 'active') return 0
      const row = ensureWalletRow(db, userId, at)
      const today = shanghaiDay(at)
      if (row.daily_bonus_day === today) return 0
      const balance = row.balance + bonus
      updateWalletRow(db, userId, { balance, dailyBonusLeft: bonus, dailyBonusDay: today }, at)
      insertLedgerRow(db, {
        userId,
        type: 'daily',
        amount: bonus,
        balanceAfter: balance,
        note: '每日赠送',
        actorId: null,
        at,
      })
      return bonus
    })
  }

  /** 钱包余额（不写库；没有钱包行 = 0） */
  function getBalance(userId: number): number {
    return getWalletRow(db, userId)?.balance ?? 0
  }

  /**
   * 算力租赁按块扣费（13 §3）：写 `compute` 负数流水，**不动 `total_spent`**（它保持 token 累计消耗口径）。
   * 与所有扣费路径一样，同一事务里先作废过期赠送、再用赠送抵扣。返回扣费后的余额。
   */
  function chargeCompute(userId: number, amountMicro: number, note: string): number {
    if (!Number.isInteger(amountMicro) || amountMicro < 0) {
      throw new HubError('VALIDATION_FAILED', '算力扣费金额必须是非负整数微积分')
    }
    const at = clock.nowIso()
    return db.tx(() => {
      expireStaleBonusTx(userId, at)
      const row = ensureWalletRow(db, userId, at)
      const balance = row.balance - amountMicro
      updateWalletRow(
        db,
        userId,
        {
          balance,
          dailyBonusLeft: dailyBonusAfter(row.daily_bonus_left, amountMicro),
          lastUsedAt: at,
        },
        at,
      )
      if (amountMicro > 0) {
        insertLedgerRow(db, {
          userId,
          type: 'compute',
          amount: -amountMicro,
          balanceAfter: balance,
          note,
          actorId: null,
          at,
        })
      }
      return balance
    })
  }

  function expireStaleBonus(userId: number): void {
    const at = clock.nowIso()
    db.tx(() => expireStaleBonusTx(userId, at))
  }

  /**
   * 搜索池按次扣费（14 §3.1）：与 `chargeCompute` 同源（先作废过期赠送、消费先用赠送、不动 `total_spent`），
   * 但**不写 ledger**：工具费用只记在 `relay_tool_usage.cost`（14 §3.3 的对账不变量按它扣）。
   */
  function chargeTool(userId: number, amountMicro: number): number {
    if (!Number.isInteger(amountMicro) || amountMicro < 0) {
      throw new HubError('VALIDATION_FAILED', '搜索池扣费金额必须是非负整数微积分')
    }
    const at = clock.nowIso()
    return db.tx(() => {
      expireStaleBonusTx(userId, at)
      const row = ensureWalletRow(db, userId, at)
      const balance = row.balance - amountMicro
      updateWalletRow(
        db,
        userId,
        {
          balance,
          dailyBonusLeft: dailyBonusAfter(row.daily_bonus_left, amountMicro),
          lastUsedAt: at,
        },
        at,
      )
      return balance
    })
  }

  function walletAggregates(userId: number): WalletAggregates {
    const today = shanghaiDay(clock.nowIso())
    const monthStart = shanghaiMonthStart(today)
    const row = db.get<{ today: number | null; month: number | null; requests: number | null }>(
      `SELECT
         (SELECT SUM(cost) FROM relay_usage_daily WHERE user_id = ? AND day = ?) AS today,
         (SELECT SUM(cost) FROM relay_usage_daily WHERE user_id = ? AND day >= ?) AS month,
         (SELECT SUM(requests) FROM relay_usage_daily WHERE user_id = ? AND day >= ?) AS requests`,
      userId,
      today,
      userId,
      monthStart,
      userId,
      monthStart,
    )
    return {
      todayCostMicro: Number(row?.today ?? 0),
      monthCostMicro: Number(row?.month ?? 0),
      monthRequests: Number(row?.requests ?? 0),
    }
  }

  function walletRowDto(userId: number): RelayWalletRow {
    const user = db.get<{
      username: string
      display_name: string
      avatar_file: string | null
      deleted_at: string | null
    }>('SELECT username, display_name, avatar_file, deleted_at FROM users WHERE id = ?', userId)
    if (!user || user.deleted_at !== null) throw new HubError('NOT_FOUND', '用户不存在')
    const wallet = walletOrDefault(userId)
    const aggregates = walletAggregates(userId)
    return {
      ...toRelayWallet(wallet),
      username: user.username,
      displayName: user.display_name,
      avatarUrl: avatarUrlFor(user.avatar_file),
      todayCostMicro: aggregates.todayCostMicro,
      monthCostMicro: aggregates.monthCostMicro,
      monthRequests: aggregates.monthRequests,
    }
  }

  function listWallets(query: RelayWalletListQuery): RelayWalletListResponse {
    const today = shanghaiDay(clock.nowIso())
    const monthStart = shanghaiMonthStart(today)
    const { rows, total } = listWalletRows(db, {
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort,
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
      today,
      monthStart,
    })
    return {
      items: rows.map((row) => ({
        ...toRelayWallet(row),
        username: row.username,
        displayName: row.display_name,
        avatarUrl: avatarUrlFor(row.avatar_file),
        todayCostMicro: Number(row.today_cost ?? 0),
        monthCostMicro: Number(row.month_cost ?? 0),
        monthRequests: Number(row.month_requests ?? 0),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  function updateWallet(
    userId: number,
    input: UpdateRelayWalletRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayWalletRow {
    const at = clock.nowIso()
    db.tx(() => {
      ensureWalletRow(db, userId, at)
      updateWalletRow(
        db,
        userId,
        {
          ...(input.ratePercent === undefined ? {} : { ratePercent: input.ratePercent }),
          ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
          ...(input.dailyLimitMicro === undefined ? {} : { dailyLimit: input.dailyLimitMicro }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        },
        at,
      )
    })
    audit({
      actorId,
      meta,
      action: 'relay.wallet.update',
      targetType: 'relay.wallet',
      targetId: userId,
      detail: { fields: Object.keys(input) },
    })
    return walletRowDto(userId)
  }

  function adjustWallet(
    userId: number,
    input: AdjustRelayWalletRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayWalletRow {
    const at = clock.nowIso()
    db.tx(() => {
      // 扣积分是「扣费路径」：先作废过期赠送，再用赠送抵扣（13 §2.1/§2.2）；加积分不改变赠送剩余
      if (input.amountMicro < 0) expireStaleBonusTx(userId, at)
      const row = ensureWalletRow(db, userId, at)
      const balance = row.balance + input.amountMicro
      updateWalletRow(
        db,
        userId,
        {
          balance,
          ...(input.amountMicro < 0
            ? { dailyBonusLeft: dailyBonusAfter(row.daily_bonus_left, -input.amountMicro) }
            : {}),
        },
        at,
      )
      insertLedgerRow(db, {
        userId,
        type: input.amountMicro > 0 ? 'grant' : 'deduct',
        amount: input.amountMicro,
        balanceAfter: balance,
        note: input.note,
        actorId,
        at,
      })
    })
    audit({
      actorId,
      meta,
      action: 'relay.wallet.adjust',
      targetType: 'relay.wallet',
      targetId: userId,
      detail: { amountMicro: input.amountMicro, note: input.note },
    })
    return walletRowDto(userId)
  }

  function listLedger(query: RelayLedgerQuery, opts: { userId?: number }): RelayLedgerListResponse {
    const userId = opts.userId ?? query.userId
    const { rows, total } = listLedgerRows(db, {
      ...(userId === undefined ? {} : { userId }),
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    })
    return { items: rows.map(toRelayLedgerRow), total, page: query.page, pageSize: query.pageSize }
  }

  // ── 用量统计 ──────────────────────────────────────────────────────────────

  interface StatsScope {
    userId?: number
    scope: 'user' | 'admin'
  }

  function resolveRange(query: { from?: string; to?: string }): { from: string; to: string } {
    const today = shanghaiDay(clock.nowIso())
    const from = query.from ?? addRelayDays(today, -29)
    const to = query.to ?? today
    if (relayDaySpan(from, to) <= 0) {
      throw new HubError('VALIDATION_FAILED', '结束日期不能早于开始日期', { fields: { to: '早于 from' } })
    }
    if (relayDaySpan(from, to) > RELAY_MAX_RANGE_DAYS) {
      throw new HubError('VALIDATION_FAILED', `日期跨度不能超过 ${String(RELAY_MAX_RANGE_DAYS)} 天`, {
        fields: { from: '跨度太大' },
      })
    }
    return { from, to }
  }

  function usageStats(query: RelayUsageStatsQuery, opts: StatsScope): RelayUsageStatsResponse {
    const { from, to } = resolveRange(query)
    const userId = opts.scope === 'user' ? opts.userId : query.userId
    // 18 §6：按来源筛选（用户端也生效；管理端省略 = 全部来源）
    // docs/22 §1.3：再按用量来源（client_kind）筛，桌面视图默认带 desktop
    const filter = {
      ...(userId === undefined ? {} : { userId }),
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      ...(query.clientKind === undefined ? {} : { clientKind: query.clientKind }),
      // WP56e1：按 relay_usage.source 筛（cockpit / internal / local / public）
      ...(query.source === undefined ? {} : { source: query.source }),
    }
    const total = toUsageBucket(sumDailyBuckets(db, { ...filter, from, to }))
    const dailyRows = new Map(
      dailyBucketsByDay(db, { ...filter, from, to }).map((row) => [row.day, row] as const),
    )
    const daily = relayDayRange(from, to).map((day) => ({
      day,
      ...toUsageBucket(dailyRows.get(day)),
    }))
    const byModel = dailyBucketsByModel(db, { ...filter, from, to }).map((row) => ({
      model: row.model,
      ...toUsageBucket(row),
    }))
    const byUser =
      opts.scope === 'admin'
        ? // 按用户分组本身不按 userId 筛（要看全部用户），但来源筛选要带上
          dailyBucketsByUser(db, {
            ...(query.scope === undefined ? {} : { scope: query.scope }),
            ...(query.clientKind === undefined ? {} : { clientKind: query.clientKind }),
            ...(query.source === undefined ? {} : { source: query.source }),
            from,
            to,
          }).map((row) => ({
            userId: row.user_id,
            username: row.username,
            ...toUsageBucket(row),
          }))
        : []
    const byChannel =
      opts.scope === 'admin'
        ? dailyBucketsByChannel(db, { ...filter, from, to }).map((row) => ({
            channelId: row.channel_id,
            channelName: row.channel_name ?? '—',
            ...toUsageBucket(row),
          }))
        : []
    const byScope = dailyBucketsByScope(db, { ...filter, from, to }).map((row) => ({
      scope: parseScope(row.scope),
      ...toUsageBucket(row),
    }))
    // 19 §3：按「天 × 模型」的明细（只给有用量的格子，前端按天补 0 画多模型曲线）
    const dailyByModel = dailyBucketsByDayModel(db, { ...filter, from, to }).map((row) => ({
      day: row.day,
      model: row.model,
      ...toUsageBucket(row),
    }))
    return { from, to, total, daily, byModel, byUser, byChannel, byScope, dailyByModel }
  }

  function usageLogs(query: RelayUsageLogQuery, opts: StatsScope): RelayUsageLogResponse {
    const userId = opts.scope === 'user' ? opts.userId : query.userId
    const from = query.from ?? addRelayDays(shanghaiDay(clock.nowIso()), -29)
    const to = query.to ?? shanghaiDay(clock.nowIso())
    const span = relayDaySpan(from, to)
    if (span <= 0 || span > RELAY_MAX_RANGE_DAYS * 4) {
      throw new HubError('VALIDATION_FAILED', '日期区间不合法', { fields: { from: '跨度太大' } })
    }
    const { rows, total } = listUsageRows(db, {
      ...(userId === undefined ? {} : { userId }),
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      ...(query.clientKind === undefined ? {} : { clientKind: query.clientKind }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.model === undefined ? {} : { model: query.model }),
      ...(query.baseModel === undefined || opts.scope === 'user' ? {} : { baseModel: query.baseModel }),
      ...(query.channelId === undefined || opts.scope === 'user' ? {} : { channelId: query.channelId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      fromIso: shanghaiDayStartIso(from),
      toIso: shanghaiDayStartIso(addRelayDays(to, 1)),
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    })
    return {
      items: rows.map((row) => toRelayUsageRow(row, { hideChannel: opts.scope === 'user' })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  // ── 用户端 ────────────────────────────────────────────────────────────────

  /** 用户可见的模型行：启用 && （所有人可见 || 管理员） */
  function isModelVisible(row: RelayModelRow, role: 'user' | 'admin'): boolean {
    return row.enabled === 1 && (row.visibility === 'all' || role === 'admin')
  }

  function visibleModelRows(role: 'user' | 'admin', scope: RelayScope = 'dsh'): RelayModelRow[] {
    return listModelRows(db, scope).filter((row) => isModelVisible(row, role))
  }

  function myModels(role: 'user' | 'admin'): MyRelayModel[] {
    // 18 §3.1：`/api/me/relay.models` 只看 dsh 作用域
    // 一次读出模型、路由、下发选中集合与（自动修正后的）默认路由；两个 DSH 标记不能在每个模型上各查一次
    const allRows = listModelRows(db)
    const rows = allRows.filter((row) => parseScope(row.scope) === 'dsh' && isModelVisible(row, role))
    const inputs = dshRouteInputsFrom(allRows)
    const expected = expectedDshState(inputs, dshStore.get().defaultRouteId)
    // 一次查出所有模型的倍率区间，避免每个模型一条查询
    const rates = channelRateRanges(
      db,
      rows.map((row) => row.id),
    )
    return rows.map((row) => {
      // 16 §4.1：只含启用渠道上的启用路由；模型和渠道没有共同协议的组合调用不了，也不列；
      // 排序按倍率从低到高、再按渠道标识
      const routes = inputs
        .filter(
          (input) =>
            input.modelId === row.id &&
            input.channelEnabled &&
            input.routeEnabled &&
            deliverApiForRoute(input) !== null,
        )
        .sort(
          (left, right) =>
            left.ratePermille - right.ratePermille ||
            (left.channelSlug < right.channelSlug ? -1 : left.channelSlug > right.channelSlug ? 1 : 0) ||
            left.channelId - right.channelId,
        )
        .map((input) => ({
          channelSlug: input.channelSlug,
          ratePermille: input.ratePermille,
          pinnedModel: dshRouteModelId(input),
          // 与 GET /api/admin/relay/dsh 的路由级 blockedReason 复用同一函数（16 §4.1）
          inDsh: input.selected && dshRouteBlockedReason(input) === null,
          dshDefault: input.routeId === expected.defaultRouteId,
        }))
      return {
        name: row.name,
        displayName: row.display_name,
        apis: modelApis(row.id),
        price: toRelayPrice(row),
        channelRate: rates.get(row.id) ?? null,
        info: parseInfo(row.info_json),
        inDsh: routes.some((route) => route.inDsh),
        dshDefault: routes.some((route) => route.dshDefault),
        routes,
      }
    })
  }

  /**
   * 18 §3.1 §3.4：某作用域里的模型摘要。`dsh` 的可用判定是「至少有一条启用路由」，
   * 两个模式还要协议与作用域一致（`AGENT_MODE_API`）。
   */
  function scopeModels(
    scope: RelayScope,
    opts: { userId: number; role: 'user' | 'admin' },
  ): RelayScopeModel[] {
    const rows = listModelRows(db, scope)
    const rates = channelRateRanges(
      db,
      rows.map((row) => row.id),
    )
    const protocol = scope === 'dsh' ? null : AGENT_MODE_API[scope]
    // 18 §3.4：模型列表按 `sort DESC, name ASC`（插件与 /v1/models 同一顺序）
    const ordered = [...rows].sort(
      (left, right) =>
        right.sort - left.sort ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
        left.id - right.id,
    )
    return ordered.map((row) => {
      const apis = modelApis(row.id)
      return {
        id: row.id,
        name: row.name,
        displayName: row.display_name,
        enabled: row.enabled === 1,
        visible: isModelVisible(row, opts.role),
        routable:
          row.enabled === 1 && (protocol === null ? apis.length > 0 : apis.includes(protocol as ModelApi)),
        apis,
        price: toRelayPrice(row),
        info: parseInfo(row.info_json),
        defaultThinking: effectiveThinkingFor(row),
        sort: row.sort,
        channelRate: rates.get(row.id) ?? null,
      }
    })
  }

  function myRelay(userId: number, role: 'user' | 'admin', entry?: RequestOrigin): MyRelayResponse {
    const wallet = walletOrDefault(userId)
    const today = shanghaiDay(clock.nowIso())
    const monthStart = shanghaiMonthStart(today)
    const todayBucket = toUsageBucket(sumDailyBuckets(db, { userId, from: today, to: today }))
    const monthBucket = toUsageBucket(sumDailyBuckets(db, { userId, from: monthStart, to: today }))
    return {
      enabled: settings().enabled && wallet.enabled === 1,
      wallet: toRelayWallet(wallet),
      today: todayBucket,
      month: monthBucket,
      publicBaseUrl: publicBaseUrl(entry),
      dshAttached: services().models?.hasRelayProviderForUser(userId) ?? false,
      models: myModels(role),
      // 18 §7：只含对我开通的模式（没开通的不出现）
      agentModes: services().agentModes?.myModes(userId, role) ?? [],
    }
  }

  function listUserKeys(userId: number): RelayKey[] {
    // 18 §7：模式密钥由 Hub 管理，不给用户看（「API 密钥」列表只有 dsh 作用域）。
    // WP25b（WP25a 遗留 ④）：桌面设备密钥（`device_id` 非空）也**不出现在用户列表里** ——
    // 它属于设备台账（吊销设备时一起吊销），用户在这里删掉它只会让桌面端 401 且没有自愈路径。
    return listKeyRows(db, userId, 'dsh')
      .filter((row) => row.device_id === null)
      .map(toRelayKey)
  }

  function requireOwnKey(userId: number, keyId: number): { row: ReturnType<typeof getKeyRow>; kind: string } {
    const row = getKeyRow(db, keyId)
    if (!row || row.user_id !== userId || row.revoked_at !== null || parseScope(row.scope) !== 'dsh') {
      throw new HubError('NOT_FOUND', '密钥不存在')
    }
    // 桌面设备密钥只能通过「吊销设备」带走（WP25b）：改名/轮换/删除都会让设备端静默失效
    if (row.device_id !== null) {
      throw new HubError('NOT_FOUND', '这是桌面设备专用的密钥，请在「我的设备」里吊销设备')
    }
    return { row, kind: row.kind }
  }

  function createKey(
    userId: number,
    input: CreateRelayKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayKeySecretResponse {
    // 桌面设备密钥有自己的设备维度与吊销路径（WP25a），不占用户自建的 10 把配额
    if (countUserCreatedKeyRows(db, userId) >= MAX_USER_KEYS) {
      throw new HubError('VALIDATION_FAILED', `每人最多 ${String(MAX_USER_KEYS)} 把自建密钥`, {
        fields: { name: '数量已达上限' },
      })
    }
    const secret = generateRelayKey()
    const at = clock.nowIso()
    const id = insertKeyRow(db, {
      userId,
      scope: 'dsh',
      kind: 'user',
      name: input.name,
      keyHash: hashRelayKey(secret),
      keyEnc: null,
      preview: relayKeyPreview(secret),
      at,
    })
    audit({
      actorId,
      meta,
      action: 'relay.key.create',
      targetType: 'relay.key',
      targetId: id,
      detail: { kind: 'user', name: input.name },
    })
    const row = getKeyRow(db, id)
    if (!row) throw new HubError('INTERNAL', '密钥创建失败')
    return { key: toRelayKey(row), secret, needsRecreate: false }
  }

  function updateKey(
    userId: number,
    keyId: number,
    input: UpdateRelayKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): RelayKey {
    const { kind } = requireOwnKey(userId, keyId)
    if (kind === 'system' && input.enabled === false) {
      throw new HubError('VALIDATION_FAILED', 'DSH 内置密钥不能停用（会让自己的 DSH 断掉）', {
        fields: { enabled: 'system 密钥不能停用' },
      })
    }
    updateKeyRow(db, keyId, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    })
    audit({
      actorId,
      meta,
      action: 'relay.key.update',
      targetType: 'relay.key',
      targetId: keyId,
      detail: { fields: Object.keys(input) },
    })
    const updated = getKeyRow(db, keyId)
    if (!updated) throw new HubError('INTERNAL', '密钥更新失败')
    return toRelayKey(updated)
  }

  function deleteKey(userId: number, keyId: number, actorId: number, meta: RequestMeta): void {
    const { row, kind } = requireOwnKey(userId, keyId)
    if (kind === 'system') {
      throw new HubError('VALIDATION_FAILED', 'DSH 内置密钥不能删除，只能重置', { fields: { id: 'system' } })
    }
    revokeKeyRow(db, keyId, clock.nowIso())
    audit({
      actorId,
      meta,
      action: 'relay.key.revoke',
      targetType: 'relay.key',
      targetId: keyId,
      detail: { name: row?.name },
    })
  }

  function rotateSystemKey(userId: number, actorId: number, meta: RequestMeta): RelayKeySecretResponse {
    const secret = generateRelayKey()
    const at = clock.nowIso()
    const id = db.tx(() => {
      const current = getActiveSystemKeyRow(db, userId, 'dsh')
      if (current) revokeKeyRow(db, current.id, at)
      return insertKeyRow(db, {
        userId,
        scope: 'dsh',
        kind: 'system',
        name: 'DSH 内置',
        keyHash: hashRelayKey(secret),
        keyEnc: encrypt(secret),
        preview: relayKeyPreview(secret),
        at,
      })
    })
    audit({
      actorId,
      meta,
      action: 'relay.key.rotate',
      targetType: 'relay.key',
      targetId: id,
      detail: { kind: 'system' },
    })
    const row = getKeyRow(db, id)
    if (!row) throw new HubError('INTERNAL', '密钥重置失败')
    return { key: toRelayKey(row), secret, needsRecreate: true }
  }

  /**
   * system 密钥明文：没有就当场签发并加密存 `key_enc`（12 §7.3）。
   * 18 D5：每个用户每个作用域一把（`scope` 省略 = dsh，老调用方行为不变）。
   */
  function systemKeyPlain(userId: number, scope: RelayScope = 'dsh'): string | null {
    try {
      const existing = getActiveSystemKeyRow(db, userId, scope)
      if (existing?.key_enc) {
        const plain = decrypt(existing.key_enc)
        if (plain) return plain
      }
      const secret = generateRelayKey()
      const at = clock.nowIso()
      const name = scope === 'dsh' ? 'DSH 内置' : scope === 'claude-code' ? 'Claude Code' : 'Codex'
      db.tx(() => {
        const current = getActiveSystemKeyRow(db, userId, scope)
        if (current) revokeKeyRow(db, current.id, at)
        insertKeyRow(db, {
          userId,
          scope,
          kind: 'system',
          name,
          keyHash: hashRelayKey(secret),
          keyEnc: encrypt(secret),
          preview: relayKeyPreview(secret),
          at,
        })
      })
      log.info({ userId, scope }, '为用户签发了新的中转站 system 密钥')
      return secret
    } catch (error) {
      log.warn({ err: error, userId, scope }, '签发 system 密钥失败')
      return null
    }
  }

  // ── 桌面设备密钥（WP25a；裁决 #8 / #11）──────────────────────────────────

  /**
   * 一台设备一把：签发前先吊销同设备同作用域的旧密钥。kind 仍是 'user'（`relay_keys.kind` 只有两种），
   * 但带 `device_id`，所以：(a) 不占用户自建的 10 把配额，(b) 吊销设备时能一次断干净，
   * (c) `/v1` 鉴权能据此把用量标成 `client_kind='desktop'`。
   */
  function mintDeviceKey(input: MintDeviceKeyInput): { keyId: number; secret: string } {
    const secret = generateRelayKey()
    const at = clock.nowIso()
    const keyId = db.tx(() => {
      for (const row of listDeviceKeyRows(db, input.deviceId, input.scope)) revokeKeyRow(db, row.id, at)
      return insertKeyRow(db, {
        userId: input.userId,
        scope: input.scope,
        kind: 'user',
        name: input.name,
        keyHash: hashRelayKey(secret),
        keyEnc: input.remember ? encrypt(secret) : null,
        preview: relayKeyPreview(secret),
        at,
        deviceId: input.deviceId,
      })
    })
    log.info({ userId: input.userId, scope: input.scope }, '为桌面设备签发了新的中转站密钥')
    return { keyId, secret }
  }

  /** 该设备某作用域的有效密钥明文（模式密钥的重复索取）；没有密文时返回 null（调用方重新签发） */
  function deviceKeySecret(deviceId: string, scope: RelayScope): { keyId: number; secret: string } | null {
    const row = listDeviceKeyRows(db, deviceId, scope)[0]
    if (!row || !row.key_enc) return null
    const secret = decrypt(row.key_enc)
    return secret ? { keyId: row.id, secret } : null
  }

  function revokeDeviceKeys(deviceId: string): number {
    return revokeKeysByDevice(db, deviceId, clock.nowIso())
  }

  // ── 概览 ──────────────────────────────────────────────────────────────────

  function overview(): RelayOverviewResponse {
    const nowIso = clock.nowIso()
    const today = shanghaiDay(nowIso)
    const monthStart = shanghaiMonthStart(today)
    // 18 §3.1：概览的渠道/模型计数只看 dsh；告警三个作用域都算，文案带上页面名
    const allChannels = listChannelRows(db)
    const channels = allChannels.filter((row) => parseScope(row.scope) === 'dsh')
    const modelCounts = countModelRows(db, 'dsh')
    const alerts: RelayAlert[] = []

    function pageLabel(scope: RelayScope): string {
      return scope === 'dsh' ? '' : `${scopePageLabel(scope)}：`
    }

    for (const row of allChannels) {
      const keys = listChannelKeyRows(db, row.id)
      const health = channelHealth(row, keys, nowIso)
      if (health === 'cooling') {
        alerts.push({
          level: 'warn',
          kind: 'channel-cooling',
          message: `${pageLabel(parseScope(row.scope))}渠道「${row.name}」熔断中，到 ${row.cooldown_until ?? '—'} 为止`,
          channelId: row.id,
          at: row.last_error_at,
        })
      }
      if (health === 'no-key') {
        alerts.push({
          level: 'error',
          kind: 'channel-no-key',
          message: `${pageLabel(parseScope(row.scope))}渠道「${row.name}」没有可用密钥`,
          channelId: row.id,
          at: row.updated_at,
        })
      }
    }
    const autoDisabled = db.all<{ channel_id: number; last4: string; last_error_at: string | null }>(
      "SELECT channel_id, last4, last_error_at FROM relay_channel_keys WHERE state = 'auto-disabled' ORDER BY id DESC LIMIT 5",
    )
    for (const key of autoDisabled) {
      alerts.push({
        level: 'error',
        kind: 'key-auto-disabled',
        message: `渠道密钥 …${key.last4} 被上游拒绝（401/403），已自动停用`,
        channelId: key.channel_id,
        at: key.last_error_at,
      })
    }
    if (config.relayInternalPort !== 0 && !internalListening) {
      alerts.push({
        level: 'error',
        kind: 'internal-listener-down',
        message: '中转站内部监听器未在监听，用户容器暂时连不上中转站',
        channelId: null,
        at: null,
      })
    }
    const sinceIso = new Date(clock.now().getTime() - 86_400_000).toISOString()
    const recent = countUsageRows(db, { fromIso: sinceIso })
    const estimated = countUsageRows(db, { fromIso: sinceIso, estimated: true })
    if (recent >= 10 && estimated / recent > 0.2) {
      alerts.push({
        level: 'warn',
        kind: 'usage-missing',
        message: `最近 24 小时有 ${String(Math.round((estimated / recent) * 100))}% 的请求拿不到上游 usage，费用是估算的`,
        channelId: null,
        at: null,
      })
    }
    if (modelsChanged) {
      const relayProviders = listRelayProviderCount()
      if (relayProviders > 0) {
        alerts.push({
          level: 'warn',
          kind: 'models-changed',
          message: '中转站模型有变更，去「下发」页重新下发后 DSH 才会看到新模型',
          channelId: null,
          at: null,
        })
      }
    }
    // 新导入的模型还没定价：按 0 计费，提醒管理员（12 §9；18 §3.1 三个作用域都算）
    for (const scope of ['dsh', 'claude-code', 'codex'] as const) {
      const unpriced = listUnpricedModelRows(db).filter((row) => row.scope === scope)
      if (unpriced.length === 0) continue
      const names = unpriced.map((row) => row.name)
      alerts.push({
        level: 'warn',
        kind: 'models-unpriced',
        message: `${pageLabel(scope)}${String(unpriced.length)} 个模型还没定价（按 0 计费）：${names
          .slice(0, 5)
          .join('、')}`,
        channelId: null,
        at: null,
      })
    }

    const unhealthy = channels.filter(
      (row) => channelHealth(row, listChannelKeyRows(db, row.id), nowIso) !== 'ok',
    ).length
    return {
      enabled: settings().enabled,
      internalBaseUrl,
      internalListening,
      today: toUsageBucket(sumDailyBuckets(db, { from: today, to: today })),
      month: toUsageBucket(sumDailyBuckets(db, { from: monthStart, to: today })),
      inFlight: inFlightTotal(),
      totalBalanceMicro: sumWalletBalances(db),
      channels: { total: channels.length, ok: channels.length - unhealthy, unhealthy },
      models: modelCounts,
      alerts,
    }
  }

  function listRelayProviderCount(): number {
    const models = services().models
    if (!models) return 0
    try {
      return models.listRelayProviderCount()
    } catch {
      return 0
    }
  }

  // ── 下发到 DSH：GET / PUT（12 §7.0、§9；WP12a / WP20a 按路由）────────────

  function dshModelDto(
    row: RelayModelRow,
    channelNames: string[],
    inputs: readonly DshRouteInput[],
  ): RelayDshModel {
    const apis = modelApis(row.id)
    const deliverApi = deliverApiFor(apis)
    const price = toRelayPrice(row)
    const visibility = RelayModelVisibilitySchema.safeParse(row.visibility)
    const routes = inputs
      .filter((input) => input.modelId === row.id)
      .sort(compareDshRoutes)
      .map((input) => ({
        routeId: input.routeId,
        channelId: input.channelId,
        channelName: input.channelName,
        channelSlug: input.channelSlug,
        ratePermille: input.ratePermille,
        deliverApi: deliverApiForRoute(input),
        selected: input.selected,
        blockedReason: dshRouteBlockedReason(input),
      }))
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      enabled: row.enabled === 1,
      visibility: visibility.success ? visibility.data : 'all',
      apis,
      deliverApi,
      channelNames,
      price,
      priced:
        price.inputMicro !== 0 ||
        price.outputMicro !== 0 ||
        price.perRequestMicro !== 0 ||
        (price.cacheReadMicro ?? 0) !== 0 ||
        (price.cacheWriteMicro ?? 0) !== 0,
      selected: routes.some((route) => route.selected),
      // 16 §6：按渠道展开的路由（下发页平铺成一行一个「模型@标识」）
      routes,
      blockedReason: blockedReasonFor(row, deliverApi),
      // WP13：设了但不生效的（info 后来变过）= null，并在 GET 的 warnings 里点名
      defaultThinking: effectiveThinkingFor(row),
    }
  }

  /** 最近一次 `rollout.models` 任务（任意状态）；从没下发过 = null */
  async function lastModelsRollout(): Promise<RelayDshResponse['lastRollout']> {
    const jobs = services().jobs
    if (!jobs) return null
    try {
      const page = await jobs.list({ type: 'rollout.models', page: 1, pageSize: 1 })
      const job = page.items[0]
      return job ? { jobId: job.id, status: job.status, createdAt: job.createdAt } : null
    } catch (error) {
      log.warn({ err: error }, '读取最近一次模型下发任务失败')
      return null
    }
  }

  async function dshResponse(platform: Platform = 'cloud'): Promise<RelayDshResponse> {
    const store = dshStoreOf(platform)
    const dsh = store.get()
    // 18 §3.1：「下发到 DSH」只看 dsh 作用域（两个模式页面不发 managed.patch.yml）
    const rows = listModelRows(db, 'dsh')
    const inputs = dshRouteInputs(platform)
    const names = channelNamesForModels(
      db,
      rows.map((row) => row.id),
    )
    const models = rows.map((row) => dshModelDto(row, names.get(row.id) ?? [], inputs))
    // 默认路由可能已经失效（被删/停用/取消勾选/没了路由）：按期望状态给出自动改选后的结果
    const expected = expectedDshState(inputs, dsh.defaultRouteId)
    const presetState =
      services().models?.systemPresetState(
        { presetId: dsh.presetId, name: dshPresetNameOf(platform) },
        platform,
      ) ?? null
    // 桌面侧没有「实例侧的 rollout.models 任务」：pending 比的是最近一次桌面模型配置下发
    const desktop = platform === 'desktop' ? (services().desktopDelivery?.audience() ?? null) : null
    const lastRollout = platform === 'desktop' ? null : await lastModelsRollout()
    const selectedRoutes = inputs.filter((input) => input.selected)
    const rowById = new Map(rows.map((row) => [row.id, row]))

    const warnings: string[] = []
    if (config.relayInternalPort !== 0 && internalBaseUrl === null) {
      warnings.push('中转站内部监听器没在监听，用户 DSH 现在连不上中转站')
    }
    // 搜索池下发（14 §5）：内部监听器没起来时下发不出去；设置改过但还没重新下发也点名
    const toolSettings = toolService?.getSettings() ?? null
    if (toolSettings?.enabled === true && toolSettings.deliverToDsh) {
      if (internalBaseUrl === null) {
        warnings.push('搜索/抓取已开启下发，但中转站内部监听器没在监听，用户 DSH 拿不到搜索')
      } else {
        const pendingAt = toolService?.pendingAt() ?? null
        if (pendingAt !== null && (lastRollout === null || pendingAt > lastRollout.createdAt)) {
          warnings.push('搜索池配置有变更，去「下发」页重新下发后用户 DSH 才会生效')
        }
      }
    }
    // 16 §6.1：选中的路由后来变得不能下发 → 保留选中、不渲染，并点名「模型@标识」
    for (const input of selectedRoutes) {
      const reason = dshRouteBlockedReason(input)
      if (reason) warnings.push(`已选中的「${dshRouteModelId(input)}」${reason}，不会被下发`)
    }
    for (const model of models) {
      const row = rowById.get(model.id)
      const stored = row ? storedDefaultThinking(row) : null
      // 设了档位、但模型的 info 后来变了导致不生效（12 §7.0）：当作没设，提醒管理员
      if (stored !== null && model.defaultThinking === null) {
        warnings.push(`模型「${model.displayName}」的默认思考档位 ${stored} 不在它声明的档位里，没有生效`)
      }
    }
    if (selectedRoutes.length > 0 && expected.defaultRouteId === null) {
      warnings.push('已选中的模型都不能下发，默认模型为空，用户 DSH 里不会有中转站模型')
    }
    // 系统路由名（hub / hub-<档位> / hub-anthropic…）是保留的：被非中转站提供方占住就点名
    const conflict = services().models?.systemPresetRouteConflict(allSystemRouteNames()) ?? null
    if (conflict) warnings.push(conflict)

    return {
      platform,
      ...(platform === 'desktop'
        ? { lastDelivery: services().desktopDelivery?.lastModelDelivery() ?? null }
        : {}),
      models,
      defaultModelId: expected.defaultModelId,
      defaultRouteId: expected.defaultRouteId,
      revision: presetState?.revision ?? 0,
      updatedAt: dsh.updatedAt,
      // 已选了模型，且从没下发过 / 配置在最近一次下发之后又变过（12 §7.0「还没下发」）
      pending:
        selectedRoutes.length > 0 &&
        (platform === 'desktop'
          ? desktop?.lastConfigAt == null || dsh.updatedAt === null || dsh.updatedAt > (desktop.lastConfigAt ?? '')
          : lastRollout === null || dsh.updatedAt === null || dsh.updatedAt > lastRollout.createdAt),
      lastRollout,
      users:
        platform === 'desktop'
          ? { total: desktop?.users ?? 0, running: 0 }
          : { total: countManagedUsers(db), running: countManagedRunningInstances(db) },
      warnings: [...new Set(warnings)],
    }
  }

  /** 整体替换选中集合与默认路由（只保存，不下发；12 §9）。返回最新的 GET 结果。 */
  async function updateDsh(
    input: UpdateRelayDshRequest,
    actorId: number,
    meta: RequestMeta,
    platform: Platform = 'cloud',
  ): Promise<RelayDshResponse> {
    const store = dshStoreOf(platform)
    const rows = listModelRows(db)
    const byModelId = new Map(rows.map((row) => [row.id, row]))
    const inputs = dshRouteInputs(platform)
    const byRouteId = new Map(inputs.map((item) => [item.routeId, item]))
    const byRoute = input.routeIds !== undefined
    const blocked: { id: number; name: string; reason: string }[] = []
    let targetRouteIds: number[] = []
    let requestedDefaultRouteId: number | null = null
    let requestedDefaultModelId: number | null = null

    if (byRoute) {
      // 新写法（16 §6.1）：直接给路由集合；默认路由由 schema 保证在集合里
      targetRouteIds = [...new Set(input.routeIds ?? [])]
      requestedDefaultRouteId = input.defaultRouteId ?? null
      for (const id of targetRouteIds) {
        if (!byRouteId.has(id)) blocked.push({ id, name: `#${String(id)}`, reason: '路由不存在' })
      }
      if (requestedDefaultRouteId !== null) {
        requestedDefaultModelId = byRouteId.get(requestedDefaultRouteId)?.modelId ?? null
      }
    } else {
      // 老写法：选中这些模型的全部路由；默认路由按回填规则在这个模型的可用路由里取第一条
      const modelIds = [...new Set(input.modelIds ?? [])]
      requestedDefaultModelId = input.defaultModelId ?? null
      for (const id of modelIds) {
        if (!byModelId.has(id)) blocked.push({ id, name: `#${String(id)}`, reason: '模型不存在' })
      }
      targetRouteIds = inputs.filter((item) => modelIds.includes(item.modelId)).map((item) => item.routeId)
      const targetSetForDefault = new Set(targetRouteIds)
      const afterSelection = inputs.map((item) =>
        targetSetForDefault.has(item.routeId) ? { ...item, selected: true } : item,
      )
      requestedDefaultRouteId =
        requestedDefaultModelId === null
          ? null
          : firstDeliverableRouteId(afterSelection, requestedDefaultModelId)
    }

    // **新勾上**不能下发的路由 → VALIDATION_FAILED，details 里列出「模型@标识」与原因（16 §6.1）。
    // 本来就选中、后来才被停用/没了路由的照常接受（保持选中、不渲染、GET 的 warnings 提示）：
    // 否则只要有一个已选路由被停用，整页就再也保存不了。
    const targetSet = new Set(targetRouteIds)
    for (const item of inputs) {
      if (!targetSet.has(item.routeId) || item.selected) continue
      const reason = dshRouteBlockedReason(item)
      if (reason) blocked.push({ id: item.routeId, name: dshRouteModelId(item), reason })
    }
    if (blocked.length > 0) {
      throw new HubError('VALIDATION_FAILED', `有 ${String(blocked.length)} 项不能下发`, {
        fields: {
          [byRoute ? 'routeIds' : 'modelIds']: '选中的项里有不能下发的（不存在 / 已停用 / 协议不匹配）',
        },
        routes: blocked,
      })
    }

    const dshBefore = store.get()
    const expectedBefore = expectedDshState(inputs, dshBefore.defaultRouteId)
    const beforeRoutes = inputs
      .filter((item) => item.selected)
      .sort(compareDshRoutes)
      .map((item) => dshRouteModelId(item))
    const beforeModels = [
      ...new Set(
        inputs
          .filter((item) => item.selected)
          .map((item) => byModelId.get(item.modelId)?.name ?? item.modelName),
      ),
    ].sort()
    const beforeDefaultRoute =
      expectedBefore.defaultRouteId === null
        ? null
        : (inputs.find((item) => item.routeId === expectedBefore.defaultRouteId) ?? null)
    const beforeDefaultName =
      expectedBefore.defaultModelId === null
        ? null
        : (byModelId.get(expectedBefore.defaultModelId)?.name ?? null)

    let cleared = 0
    let synced = { changed: false, presetId: dshBefore.presetId, revision: 0 }
    db.tx(() => {
      if (platform === 'cloud') {
        // 云上：选中集合仍落在 relay_routes.dsh_enabled（旧代码与 /v1/models 都读它）
        updateRouteDshEnabledRows(db, targetRouteIds)
        syncModelDshEnabledFlags(db)
        cleared = services().models?.clearUserPresets() ?? 0
      } else {
        // 桌面：只写自己的 settings，不动 relay_routes，也不清用户的钉住预设（那是云上的语义）
        store.write({
          ...dshBefore,
          routeIds: [...targetRouteIds].sort((left, right) => left - right),
          updatedAt: clock.nowIso(),
        })
      }
      synced = syncDshPreset(platform === 'desktop' ? 'dsh.put.desktop' : 'dsh.put', {
        defaultRouteId: requestedDefaultRouteId,
        platform,
      })
    })
    // 有人被从「钉住的预设」拉回默认预设时，渲染结果也变了：即使系统预设本身没变也要提示重新下发
    if (cleared > 0 && !synced.changed) {
      store.write({ ...store.get(), updatedAt: clock.nowIso() })
    }

    // 保存**桌面**配置时顺手补一次桌面模型基线（docs/22 §3）：基线只在 llm-pi-ai / agent-default-model
    // 缺一条时才写，之后是 no-op。
    // WP32d：勾选集合的初值会在启动 / 第一次渲染时就从云上补齐（见 ensureDesktopDshSeeded），
    // 所以「桌面第一次保存」不再等于「桌面第一次配置」——每次保存都幂等地试一下，别让基线漏掉。
    if (platform === 'desktop') {
      try {
        await services().desktopDelivery?.ensureModelBaseline()
      } catch (error) {
        log.warn({ err: error }, '桌面模型基线补齐失败')
      }
    }

    const afterRows = listModelRows(db)
    const afterInputs = dshRouteInputs(platform)
    const afterDefault = store.get()
    const afterExpected = expectedDshState(afterInputs, afterDefault.defaultRouteId)
    const afterDefaultRoute =
      afterExpected.defaultRouteId === null
        ? null
        : (afterInputs.find((item) => item.routeId === afterExpected.defaultRouteId) ?? null)
    audit({
      actorId,
      meta,
      action: 'relay.dsh.update',
      targetType: 'relay.dsh',
      targetId: null,
      detail: {
        models: {
          from: beforeModels,
          to: [
            ...new Set(
              afterInputs
                .filter((item) => item.selected)
                .map((item) => byModelId.get(item.modelId)?.name ?? item.modelName),
            ),
          ].sort(),
        },
        routes: {
          from: beforeRoutes,
          to: afterInputs
            .filter((item) => item.selected)
            .sort(compareDshRoutes)
            .map((item) => dshRouteModelId(item)),
        },
        defaultModel: {
          from: beforeDefaultName,
          to:
            afterExpected.defaultModelId === null
              ? null
              : (afterRows.find((row) => row.id === afterExpected.defaultModelId)?.name ?? null),
        },
        defaultRoute: {
          from: beforeDefaultRoute === null ? null : dshRouteModelId(beforeDefaultRoute),
          to: afterDefaultRoute === null ? null : dshRouteModelId(afterDefaultRoute),
        },
        platform,
        usersCleared: cleared,
      },
    })
    return await dshResponse(platform)
  }

  // ── 转发 ──────────────────────────────────────────────────────────────────

  const host: RelayProxyHost = {
    db,
    clock,
    log,
    settings,
    settingsStore: () => settingsStore,
    masterKey,
    decryptChannelKey: (keyEnc) => decrypt(keyEnc),
    inFlightUser: (userId) => userInFlight.get(userId) ?? 0,
    inFlightChannel: (channelId) => channelInFlight.get(channelId) ?? 0,
    enterUser(userId) {
      userInFlight.set(userId, (userInFlight.get(userId) ?? 0) + 1)
    },
    exitUser(userId) {
      const next = (userInFlight.get(userId) ?? 1) - 1
      if (next <= 0) userInFlight.delete(userId)
      else userInFlight.set(userId, next)
    },
    enterChannel(channelId) {
      channelInFlight.set(channelId, (channelInFlight.get(channelId) ?? 0) + 1)
    },
    exitChannel(channelId) {
      const next = (channelInFlight.get(channelId) ?? 1) - 1
      if (next <= 0) channelInFlight.delete(channelId)
      else channelInFlight.set(channelId, next)
    },
    recordUsage(input) {
      /**
       * 系统账号（座舱 `hub-ops`，WP56e1 / docs/24 §3.5）：**不扣任何人的积分**，用量按来源 `cockpit` 记账。
       * 判据只有一处（`users.is_system`），进门检查也走同一个口径（见 proxy.ts 的 checkWallet）。
       */
      const isSystem =
        Number(
          db.get<{ is_system: number }>('SELECT is_system FROM users WHERE id = ?', input.userId)
            ?.is_system ?? 0,
        ) === 1
      const chargedCost = isSystem ? 0 : input.cost
      const source: typeof input.source = isSystem ? 'cockpit' : input.source
      const day = shanghaiDay(input.createdAt)
      const delta: DailyDelta = {
        day,
        userId: input.userId,
        scope: input.scope,
        model: input.model,
        channelId: input.channelId ?? 0,
        requests: 1,
        errors: input.status === 'ok' ? 0 : 1,
        inputTokens: input.tokens.inputTokens,
        outputTokens: input.tokens.outputTokens,
        cacheReadTokens: input.tokens.cacheReadTokens,
        cacheWriteTokens: input.tokens.cacheWriteTokens,
        cost: chargedCost,
      }
      db.tx(() => {
        // 先用赠送：token 用量也是扣费路径，同一事务里先作废过期赠送（13 §2.1/§2.2）
        expireStaleBonusTx(input.userId, input.createdAt)
        insertUsageRow(db, {
          requestId: input.requestId,
          createdAt: input.createdAt,
          userId: input.userId,
          keyId: input.keyId,
          scope: input.scope,
          model: input.model,
          baseModel: input.baseModel,
          pinned: input.pinned,
          upstreamModel: input.upstreamModel,
          channelId: input.channelId,
          api: input.api,
          stream: input.stream,
          source,
          status: input.status,
          httpStatus: input.httpStatus,
          clientKind: input.clientKind,
          inputTokens: input.tokens.inputTokens,
          outputTokens: input.tokens.outputTokens,
          cacheReadTokens: input.tokens.cacheReadTokens,
          cacheWriteTokens: input.tokens.cacheWriteTokens,
          reasoningTokens: input.tokens.reasoningTokens,
          cost: chargedCost,
          channelRatePermille: input.channelRatePermille,
          modeRatePermille: input.modeRatePermille,
          estimated: input.estimated,
          attempts: input.attempts,
          durationMs: input.durationMs,
          ttftMs: input.ttftMs,
          error: input.error,
        })
        const wallet = ensureWalletRow(db, input.userId, input.createdAt)
        updateWalletRow(
          db,
          input.userId,
          {
            balance: wallet.balance - chargedCost,
            totalSpent: wallet.total_spent + chargedCost,
            lastUsedAt: input.createdAt,
            dailyBonusLeft: dailyBonusAfter(wallet.daily_bonus_left, chargedCost),
          },
          input.createdAt,
        )
        upsertUsageDaily(db, delta)
      })
    },
    noteChannelSuccess(channelId) {
      const row = getChannelRow(db, channelId)
      if (!row) return
      if (row.fail_streak === 0 && row.cooldown_until === null) return
      updateChannelRow(db, channelId, { failStreak: 0, cooldownUntil: null }, clock.nowIso())
    },
    noteChannelFailure(channelId, message) {
      const row = getChannelRow(db, channelId)
      if (!row) return
      const at = clock.nowIso()
      const streak = row.fail_streak + 1
      const threshold = settings().channelFailureThreshold
      const cooldown =
        streak >= threshold
          ? new Date(clock.now().getTime() + settings().channelCooldownSeconds * 1_000).toISOString()
          : row.cooldown_until
      updateChannelRow(
        db,
        channelId,
        { failStreak: streak, cooldownUntil: cooldown, lastError: message, lastErrorAt: at },
        at,
      )
    },
    noteKeyRateLimited(channelId, keyId, retryAfterSec) {
      const raise = Math.max(retryAfterSec, settings().keyCooldownSeconds)
      const at = clock.nowIso()
      updateChannelKeyRow(db, keyId, {
        cooldownUntil: new Date(clock.now().getTime() + raise * 1_000).toISOString(),
        lastError: `上游 429，冷却 ${String(raise)} 秒`,
        lastErrorAt: at,
      })
      void channelId
    },
    noteKeyUnauthorized(channelId, keyId, message) {
      const at = clock.nowIso()
      updateChannelKeyRow(db, keyId, { state: 'auto-disabled', lastError: message, lastErrorAt: at })
      audit({
        actorId: null,
        action: 'relay.channel.key.auto-disable',
        targetType: 'relay.channel.key',
        targetId: keyId,
        detail: { channelId, reason: message },
      })
    },
    agentModeRatePermille(scope) {
      if (scope === 'dsh') return RELAY_RATE_PERMILLE_DEFAULT
      return services().agentModes?.ratePermille(scope) ?? RELAY_RATE_PERMILLE_DEFAULT
    },
    touchKeyUsed(keyId) {
      const nowMs = clock.now().getTime()
      const previous = lastKeyTouch.get(keyId) ?? 0
      if (nowMs - previous < KEY_LAST_USED_THROTTLE_MS) return
      lastKeyTouch.set(keyId, nowMs)
      if (lastKeyTouch.size > 10_000) lastKeyTouch.clear()
      touchKeyLastUsed(db, keyId, clock.nowIso())
    },
  }

  function authenticate(secret: string): RelayAuthResult | null {
    const row = findKeyRowByHash(db, hashRelayKey(secret))
    if (!row || row.enabled !== 1) return null
    return {
      key: {
        id: row.id,
        name: row.name,
        kind: row.kind === 'system' ? 'system' : 'user',
        userId: row.user_id,
        scope: parseScope(row.scope),
        deviceId: row.device_id ?? null,
      },
      user: {
        id: row.user_id,
        username:
          db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', row.user_id)?.username ??
          '',
        status: row.user_status === 'active' || row.user_status === 'disabled' ? row.user_status : 'pending',
        role: row.user_role === 'admin' ? 'admin' : 'user',
        isSystem: Number(row.user_is_system ?? 0) === 1,
      },
    }
  }

  function inFlightTotal(): number {
    let total = 0
    for (const count of userInFlight.values()) total += count
    return total
  }

  function ensureSignupWallet(userId: number): void {
    const at = clock.nowIso()
    const bonus = settings().signupBonusMicro
    db.tx(() => {
      const row = ensureWalletRow(db, userId, at)
      if (bonus <= 0) return
      const balance = row.balance + bonus
      updateWalletRow(db, userId, { balance }, at)
      insertLedgerRow(db, {
        userId,
        type: 'signup',
        amount: bonus,
        balanceAfter: balance,
        note: '注册赠送',
        actorId: null,
        at,
      })
    })
  }

  /**
   * 要渲染进 hub-relay 提供方的模型（16 §6.2）：**每条被选中且可下发的路由一条**。
   * 已启用 + 已选中 + 对该用户可见 + 这条路由的 `deliverApi` = 该提供方协议
   * +（系统路由）生效档位 = 该提供方档位。id = `<模型>@<slug>`、name = `<显示名> · <slug>`，
   * 上下文等参数取模型的 `info`（同一模型的各条渠道相同）。
   * 同时供 REST DTO（admin 口径）与 managed.patch.yml 渲染（按用户口径）使用。
   *
   * `opts.thinking` 省略 = 不按档位筛（WP12 时代手工建的旧 hub-relay 提供方保持原逻辑）。
   */
  function providerModelsImpl(
    api: ModelApi,
    opts: { userId?: number; admin: boolean; thinking?: ThinkingLevel | null; platform?: Platform },
  ): RelayRenderModel[] {
    const rows = visibleModelRows(opts.admin ? 'admin' : 'user')
    const rowById = new Map(rows.map((row) => [row.id, row] as const))
    // 桌面预设：选中集合在 settings.relay_dsh_desktop.routeIds（docs/22 §3），不读 relay_routes.dsh_enabled
    const selectedOverride = opts.platform === 'desktop' ? new Set(desktopDshStore.get().routeIds) : undefined
    return dshRouteInputsFrom(rows, selectedOverride)
      .filter(isDshRouteDeliverable)
      .filter((input) => deliverApiForRoute(input) === api)
      .filter((input) => opts.thinking === undefined || input.thinking === opts.thinking)
      .sort(compareDshRoutes)
      .flatMap((input) => {
        const row = rowById.get(input.modelId)
        if (!row) return []
        const info = parseInfo(row.info_json)
        const model: RelayRenderModel = {
          id: dshRouteModelId(input),
          name: dshRouteDisplayName(input),
          ...(info.contextWindow === undefined ? {} : { contextWindow: info.contextWindow }),
          ...(info.maxTokens === undefined ? {} : { maxTokens: info.maxTokens }),
          ...(info.input === undefined ? {} : { input: info.input }),
          ...(info.reasoningEfforts === undefined ? {} : { reasoningEfforts: info.reasoningEfforts }),
          // 模型级 compat 是否被 pi-ai 接受由真容器验证决定（12 §7.2），render.ts 按结论处理
          ...(row.compat_json
            ? { compat: parseJsonColumn<Record<string, unknown> | null>(row.compat_json, null) ?? undefined }
            : {}),
        }
        return [model]
      })
  }

  // 搜索 / 抓取池（14；WP18a）：钱包扣费、内部地址、渲染同步都复用 relay 的私有实现
  const tools = createToolService({
    deps,
    afterRenderAffectingChange,
    internalBaseUrl: () => internalBaseUrl,
    publicBaseUrl,
    chargeTool,
  })
  toolService = tools

  // 晚绑定：把中转站桥注册进 models（12 §7.7），渲染与 containerEnv 都走它
  services().models?.attachRelayBridge({
    internalBaseUrl: () => internalBaseUrl,
    systemKeyPlain,
    providerModels: providerModelsImpl,
    // 搜索池下发（14 §5）：managed.patch.yml 里的两个 web 条目 + 是否需要注入 HUB_MK_HUB
    toolsRender: (userId) =>
      toolService?.renderForUser(userId) ?? { entries: [], warnings: [], needsKey: false },
    noteRendered: () => {
      modelsChanged = false
    },
    // 预设/提供方被手工改动（含系统预设被删）→ 立刻拉回期望状态（12 §7.0「系统托管」）
    onSystemPresetsMutated: () => {
      afterRenderAffectingChange('models.mutation')
    },
  })

  backfillRelay086()

  return {
    getSettings: settings,
    updateSettings(patch: UpdateRelaySettingsRequest, actorId, meta, entry) {
      const next = settingsStore.update(patch, clock.nowIso())
      audit({
        actorId,
        meta,
        action: 'relay.settings.change',
        targetType: 'relay.settings',
        targetId: null,
        detail: { fields: Object.keys(patch) },
      })
      return { settings: next, internalBaseUrl, publicBaseUrl: publicBaseUrl(entry) }
    },
    settingsResponse,
    ensureDesktopDshSeeded,
    internalBaseUrl: () => internalBaseUrl,
    publicBaseUrl,
    setInternalListening(listening) {
      internalListening = listening
    },
    isInternalListening: () => internalListening,
    setInternalBaseUrl(baseUrl) {
      internalBaseUrl = baseUrl
    },
    overview,
    dshResponse,
    updateDsh,
    listChannels,
    createChannel,
    updateChannel,
    deleteChannel,
    testChannel,
    discoverChannel,
    addChannelKeys,
    updateChannelKey,
    deleteChannelKey,
    listModels,
    modelMultiplier,
    quoteCostMicro,
    scopeModels,
    createModel,
    updateModel,
    deleteModel,
    importModels,
    listWallets,
    getWalletRow: walletRowDto,
    updateWallet,
    adjustWallet,
    listLedger,
    getBalance,
    chargeCompute,
    chargeTool,
    tools,
    grantDailyBonus,
    expireStaleBonus,
    usageStats,
    usageLogs,
    myRelay,
    myModels: (_userId, role) => myModels(role),
    listKeys: listUserKeys,
    createKey,
    updateKey,
    deleteKey,
    rotateSystemKey,
    systemKeyPlain,
    providerModels: providerModelsImpl,
    noteRendered() {
      modelsChanged = false
    },
    ensureSignupWallet,
    dispose() {
      cleanup.stop()
      // 搜索池的代理连接池（与 relay 的 `closeProxyAgents` 分开缓存）
      closeToolProxyAgents()
    },
    authenticate,
    forward(req: FastifyRequest, reply: FastifyReply, ctx) {
      return forwardV1(req, reply, ctx, host)
    },
    inFlightTotal,
    mintDeviceKey,
    deviceKeySecret,
    revokeDeviceKeys,
  }
}

/** 供路由层直接用的最小依赖形状（也便于单测） */
export interface RelayRouteDeps extends BaseDeps {
  services: AppDeps['services']
}
