import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProxyAgent, fetch, type Dispatcher } from 'undici'
import {
  TOOL_CHANNEL_DEFAULT_BASE_URL,
  type AddToolChannelKeysRequest,
  type CreateToolChannelRequest,
  type MyToolsResponse,
  type TestToolChannelResponse,
  type ToolChannel,
  type ToolKind,
  type ToolOverviewResponse,
  type ToolSettings,
  type ToolSettingsResponse,
  type ToolUsageListResponse,
  type ToolUsageQuery,
  type UpdateToolChannelKeyRequest,
  type UpdateToolChannelRequest,
} from '@dsh-hub/shared'
import type { BaseDeps, RequestMeta } from '../../../context.js'
import { decryptSecret, encryptSecret, keyLast4, sha256Hex } from '../../../lib/crypto.js'
import { HubError } from '../../../lib/errors.js'
import { createWindowCounter, type WindowCounter } from '../../../lib/rate-limit.js'
import { loadMasterKeyIfExists } from '../../../lib/secrets.js'
import { sanitizeUpstreamError } from '../proxy.js'
import { shanghaiDay } from '../time.js'
import type { RelayAuthResult } from '../types.js'
import {
  ToolRequestError,
  ToolUpstreamError,
  buildUpstreamRequest,
  classifyUpstreamStatus,
  nextMonthFirstUtcIso,
  parseFetchRequest,
  parseSearchRequest,
  usageSummary,
  type ParsedFetchRequest,
  type ParsedSearchRequest,
} from './adapters.js'
import {
  clearExpiredToolKeyCooldowns,
  countFreeToolCalls,
  deleteToolChannelRow,
  deleteToolKeyRow,
  findToolKeyRowByHash,
  getToolChannelRow,
  getToolChannelRowByName,
  getToolKeyRow,
  insertToolChannelRow,
  insertToolKeyRow,
  insertToolUsageRow,
  listToolChannelRows,
  listToolKeyRows,
  listToolKeyRowsByChannels,
  listToolUsageRows,
  parseToolKinds,
  toToolChannel,
  toToolUsageRow,
  toolKeyMonthCalls,
  toolMonthTotals,
  toolOverviewByChannel,
  toolOverviewByTool,
  toolOverviewTotals,
  updateToolChannelRow,
  updateToolKeyRow,
} from './repo.js'
import { createToolSettingsStore } from './settings-store.js'
import { planToolCandidates, type ToolRouterChannel } from './router.js'
import type { ToolChannelRow, ToolForwardOutcome, ToolService, ToolUpstreamResult } from './types.js'

/**
 * 搜索 / 抓取池的 service（14 §2、§3）：进门检查、候选切换、上游转发与适配、按次计费、
 * 管理端与用户端接口、下发渲染。**所有 SQL 在 `tools/repo.ts`**，这里只做业务判定与编排。
 *
 * 钱包、密钥校验、内部监听器地址、渲染同步都通过 `host` 回调复用 relay 的私有实现
 * （`chargeTool` 与 relay 的 token 扣费同源：先作废过期赠送、消费先用赠送、不写 ledger）。
 */
export interface ToolServiceHost {
  deps: BaseDeps
  /** 影响 managed.patch.yml 的设置变化 → 重新同步下发状态（12 §7.0） */
  afterRenderAffectingChange(reason: string): void
  /** 内部监听器地址（含 `/v1`）；未监听 = null */
  internalBaseUrl(): string | null
  /** 公开地址（含 `/v1`） */
  publicBaseUrl(): string
  /** 按次扣费（微积分；不写 ledger，费用记在 relay_tool_usage） */
  chargeTool(userId: number, amountMicro: number): number
}

/** 渠道熔断阈值与时长（14 §3.1：fail_streak ≥ 5 熔断 60 秒） */
const TOOL_CHANNEL_FAILURE_THRESHOLD = 5
const TOOL_CHANNEL_COOLDOWN_MS = 60_000
/** 上游密钥 last_used_at 的落库节流（与 relay 一致） */
const TOOL_KEY_LAST_USED_THROTTLE_MS = 60_000
/** 管理端「测试渠道」的固定 query（契约：query 固定为 "DeepSeek"，count=1） */
const TEST_QUERY = 'DeepSeek'

/** 渠道代理：`proxyUrl` 非空时用 undici 的 ProxyAgent（按 URL 缓存，避免连接泄漏） */
const toolProxyAgents = new Map<string, ProxyAgent>()

function toolDispatcherFor(proxyUrl: string | null): Dispatcher | null {
  if (!proxyUrl) return null
  const url = proxyUrl.trim()
  if (url.length === 0) return null
  let agent = toolProxyAgents.get(url)
  if (!agent) {
    agent = new ProxyAgent(url)
    toolProxyAgents.set(url, agent)
  }
  return agent
}

/** 进程退出时释放搜索池的代理连接池（测试里也会调用） */
export function closeToolProxyAgents(): void {
  for (const agent of toolProxyAgents.values()) void agent.close().catch(() => undefined)
  toolProxyAgents.clear()
}

export function createToolService(host: ToolServiceHost): ToolService {
  const deps = host.deps
  const db = deps.db
  const clock = deps.clock
  const log = deps.logger

  const settingsStore = createToolSettingsStore(db, {
    onWarn: (message, detail) => log.warn({ detail }, message),
  })
  /** 每用户每分钟限流：capacity 变了就换一个计数器（设置可改） */
  const limiters = new Map<number, WindowCounter>()
  const lastKeyTouch = new Map<number, number>()

  function settings(): ToolSettings {
    return settingsStore.get()
  }

  function shanghaiMonth(): string {
    return shanghaiDay(clock.nowIso()).slice(0, 7)
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

  function limiterFor(capacity: number): WindowCounter {
    let limiter = limiters.get(capacity)
    if (!limiter) {
      limiter = createWindowCounter({ capacity, windowMs: 60_000, clock })
      limiters.set(capacity, limiter)
    }
    return limiter
  }

  // ── 地址与设置 ────────────────────────────────────────────────────────────

  function toolsInternalBaseUrl(): string | null {
    const base = host.internalBaseUrl()
    return base === null ? null : `${base.replace(/\/+$/u, '')}/tools`
  }

  function toolsPublicBaseUrl(): string {
    return `${host.publicBaseUrl().replace(/\/+$/u, '')}/tools`
  }

  function settingsResponse(): ToolSettingsResponse {
    return {
      settings: settings(),
      internalBaseUrl: toolsInternalBaseUrl(),
      publicBaseUrl: toolsPublicBaseUrl(),
    }
  }

  /**
   * 渲染指纹：只有这几个值会改变用户 DSH 的 `managed.patch.yml`。
   * 进入 `dshRenderFingerprint`，开关变化 → 预设 revision 变 → 「待下发」。
   */
  function renderFingerprint(): string {
    const s = settings()
    const canonical = {
      enabled: s.enabled && s.deliverToDsh,
      base: toolsInternalBaseUrl(),
      web: 'deepseek-search-api|deepseek-fetch-api',
      apiKeyEnv: 'HUB_MK_HUB',
    }
    return sha256Hex(JSON.stringify(canonical))
  }

  // ── 渠道 DTO ──────────────────────────────────────────────────────────────

  function channelDto(row: ToolChannelRow): ToolChannel {
    const nowIso = clock.nowIso()
    clearExpiredToolKeyCooldowns(db, nowIso)
    const keys = listToolKeyRows(db, row.id)
    return toToolChannel(row, keys, toolKeyMonthCalls(db, row.id, shanghaiMonth()), nowIso)
  }

  function requireChannel(channelId: number): ToolChannelRow {
    const row = getToolChannelRow(db, channelId)
    if (!row) throw new HubError('NOT_FOUND', '渠道不存在')
    return row
  }

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

  function normalizeProxyUrl(raw: string): string {
    const value = raw.trim()
    if (!/^(https?|socks[45]?):\/\//u.test(value)) {
      throw new HubError('VALIDATION_FAILED', 'proxyUrl 必须是 http(s)/socks 代理地址', {
        fields: { proxyUrl: '格式不对' },
      })
    }
    return value
  }

  function listChannels(): ToolChannel[] {
    return listToolChannelRows(db).map(channelDto)
  }

  function createChannel(input: CreateToolChannelRequest, actorId: number, meta: RequestMeta): ToolChannel {
    if (getToolChannelRowByName(db, input.name)) {
      throw new HubError('CONFLICT', `渠道名 ${input.name} 已存在`)
    }
    const at = clock.nowIso()
    const id = db.tx(() => {
      const channelId = insertToolChannelRow(db, {
        kind: input.kind,
        name: input.name,
        baseUrl: normalizeBaseUrl(input.baseUrl ?? TOOL_CHANNEL_DEFAULT_BASE_URL[input.kind]),
        tools: input.tools ?? ['search', 'fetch'],
        priority: input.priority ?? 0,
        weight: input.weight ?? 1,
        timeoutMs: input.timeoutMs ?? 30_000,
        proxyUrl: input.proxyUrl ? normalizeProxyUrl(input.proxyUrl) : null,
        searchCost: input.searchCostMicro ?? 0,
        fetchCost: input.fetchCostMicro ?? 0,
        enabled: input.enabled ?? true,
        note: input.note ?? '',
        at,
      })
      for (const raw of input.keys ?? []) {
        const key = raw.trim()
        if (key.length === 0) continue
        const hash = sha256Hex(key)
        if (findToolKeyRowByHash(db, channelId, hash)) continue
        insertToolKeyRow(db, {
          channelId,
          label: '',
          keyEnc: encrypt(key),
          keyHash: hash,
          last4: keyLast4(key),
          at,
        })
      }
      return channelId
    })
    audit({
      actorId,
      meta,
      action: 'tools.channel.create',
      targetType: 'tools.channel',
      targetId: id,
      detail: {
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl ?? TOOL_CHANNEL_DEFAULT_BASE_URL[input.kind],
        keys: (input.keys ?? []).length,
      },
    })
    if ((input.keys ?? []).length > 0) {
      audit({ actorId, meta, action: 'tools.key.add', targetType: 'tools.channel', targetId: id })
    }
    return channelDto(requireChannel(id))
  }

  function updateChannel(
    channelId: number,
    input: UpdateToolChannelRequest,
    actorId: number,
    meta: RequestMeta,
  ): ToolChannel {
    const row = requireChannel(channelId)
    if (input.name !== undefined && input.name !== row.name && getToolChannelRowByName(db, input.name)) {
      throw new HubError('CONFLICT', `渠道名 ${input.name} 已存在`)
    }
    const at = clock.nowIso()
    updateToolChannelRow(
      db,
      channelId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: normalizeBaseUrl(input.baseUrl) }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.weight === undefined ? {} : { weight: input.weight }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.proxyUrl === undefined
          ? {}
          : { proxyUrl: input.proxyUrl ? normalizeProxyUrl(input.proxyUrl) : null }),
        ...(input.searchCostMicro === undefined ? {} : { searchCost: input.searchCostMicro }),
        ...(input.fetchCostMicro === undefined ? {} : { fetchCost: input.fetchCostMicro }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.note === undefined ? {} : { note: input.note }),
        // 人工重新启用时清掉熔断状态（与 relay 渠道一致）
        ...(input.enabled === true ? { failStreak: 0, cooldownUntil: null } : {}),
      },
      at,
    )
    audit({
      actorId,
      meta,
      action: 'tools.channel.update',
      targetType: 'tools.channel',
      targetId: channelId,
      detail: { fields: Object.keys(input) },
    })
    return channelDto(requireChannel(channelId))
  }

  function deleteChannel(channelId: number, actorId: number, meta: RequestMeta): void {
    const row = requireChannel(channelId)
    db.tx(() => {
      deleteToolChannelRow(db, channelId)
    })
    audit({
      actorId,
      meta,
      action: 'tools.channel.delete',
      targetType: 'tools.channel',
      targetId: channelId,
      detail: { name: row.name },
    })
  }

  function addChannelKeys(
    channelId: number,
    input: AddToolChannelKeysRequest,
    actorId: number,
    meta: RequestMeta,
  ): { channel: ToolChannel; added: number; skipped: number } {
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
        const hash = sha256Hex(key)
        if (findToolKeyRowByHash(db, channelId, hash)) {
          skipped += 1
          continue
        }
        insertToolKeyRow(db, {
          channelId,
          label: input.label ?? '',
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
      action: 'tools.key.add',
      targetType: 'tools.channel',
      targetId: channelId,
      detail: { added, skipped },
    })
    return { channel: channelDto(requireChannel(channelId)), added, skipped }
  }

  function updateChannelKey(
    channelId: number,
    keyId: number,
    input: UpdateToolChannelKeyRequest,
    actorId: number,
    meta: RequestMeta,
  ): ToolChannel {
    requireChannel(channelId)
    const key = getToolKeyRow(db, keyId)
    if (!key || key.channel_id !== channelId) throw new HubError('NOT_FOUND', '渠道密钥不存在')
    const reset = input.resetCooldown === true
    updateToolKeyRow(db, keyId, {
      ...(input.label === undefined ? {} : { label: input.label }),
      // 人工恢复（auto-disabled → active）时把冷却与最近错误一起清掉
      ...(input.state === undefined
        ? {}
        : {
            state: input.state,
            ...(input.state === 'active'
              ? { cooldownUntil: null, cooldownReason: null, lastError: null }
              : {}),
          }),
      ...(reset ? { cooldownUntil: null, cooldownReason: null, lastError: null } : {}),
    })
    audit({
      actorId,
      meta,
      action: 'tools.key.update',
      targetType: 'tools.key',
      targetId: keyId,
      detail: { channelId, fields: Object.keys(input) },
    })
    return channelDto(requireChannel(channelId))
  }

  function deleteChannelKey(
    channelId: number,
    keyId: number,
    actorId: number,
    meta: RequestMeta,
  ): ToolChannel {
    requireChannel(channelId)
    const key = getToolKeyRow(db, keyId)
    if (!key || key.channel_id !== channelId) throw new HubError('NOT_FOUND', '渠道密钥不存在')
    deleteToolKeyRow(db, keyId)
    audit({
      actorId,
      meta,
      action: 'tools.key.delete',
      targetType: 'tools.key',
      targetId: keyId,
      detail: { channelId, last4: key.last4 },
    })
    return channelDto(requireChannel(channelId))
  }

  /** 上游错误体里的可读信息（尽量短、已脱敏） */
  function upstreamMessage(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const error = parsed.error
      if (typeof error === 'string') return error
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message
        if (typeof message === 'string') return message
      }
      if (typeof parsed.message === 'string') return parsed.message
      if (typeof parsed.detail === 'string') return parsed.detail
    } catch {
      // 不是 JSON：截断原文
    }
    return raw.slice(0, 300)
  }

  function retryAfterSeconds(header: string | null): number {
    const parsed = Number(header)
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
  }

  /** 429 / 5xx / 网络错 → 密钥冷却（14 §3.1） */
  function coolDownKey(
    keyId: number,
    reason: 'rate-limit' | 'exhausted' | 'error',
    message: string,
    untilIso: string,
  ): void {
    updateToolKeyRow(db, keyId, {
      cooldownUntil: untilIso,
      cooldownReason: reason,
      lastError: message,
      lastErrorAt: clock.nowIso(),
    })
  }

  /** 5xx / 超时 / 网络错 / 响应格式不对：渠道 fail_streak + 1（≥ 5 熔断 60 秒） */
  function noteChannelFailure(channelId: number, message: string): void {
    const row = getToolChannelRow(db, channelId)
    if (!row) return
    const at = clock.nowIso()
    const streak = row.fail_streak + 1
    const cooldown =
      streak >= TOOL_CHANNEL_FAILURE_THRESHOLD
        ? new Date(clock.now().getTime() + TOOL_CHANNEL_COOLDOWN_MS).toISOString()
        : row.cooldown_until
    updateToolChannelRow(
      db,
      channelId,
      { failStreak: streak, cooldownUntil: cooldown, lastError: message, lastErrorAt: at },
      at,
    )
  }

  function noteChannelSuccess(channelId: number): void {
    const row = getToolChannelRow(db, channelId)
    if (!row) return
    if (row.fail_streak === 0 && row.cooldown_until === null) return
    updateToolChannelRow(db, channelId, { failStreak: 0, cooldownUntil: null }, clock.nowIso())
  }

  function touchKeyUsed(keyId: number): void {
    const nowMs = clock.now().getTime()
    const previous = lastKeyTouch.get(keyId) ?? 0
    if (nowMs - previous < TOOL_KEY_LAST_USED_THROTTLE_MS) return
    lastKeyTouch.set(keyId, nowMs)
    if (lastKeyTouch.size > 10_000) lastKeyTouch.clear()
    updateToolKeyRow(db, keyId, { lastUsedAt: clock.nowIso() })
  }

  function autoDisableKey(channelId: number, keyId: number, message: string): void {
    updateToolKeyRow(db, keyId, {
      state: 'auto-disabled',
      lastError: message,
      lastErrorAt: clock.nowIso(),
    })
    audit({
      actorId: null,
      action: 'tools.key.auto-disable',
      targetType: 'tools.key',
      targetId: keyId,
      detail: { channelId, reason: message },
    })
  }

  // ── 渠道测试（真打一次，不计用户费用）────────────────────────────────────

  async function testChannel(channelId: number): Promise<TestToolChannelResponse> {
    const row = requireChannel(channelId)
    const keys = listToolKeyRows(db, channelId).filter((key) => key.state !== 'disabled')
    const first = keys[0]
    if (!first) throw new HubError('VALIDATION_FAILED', '渠道没有可用密钥，先加一把再测试')
    const plain = decrypt(first.key_enc)
    if (!plain) return { ok: false, durationMs: 0, results: null, error: '密钥无法解密' }
    const started = Date.now()
    try {
      const request = buildUpstreamRequest(row.kind, 'search', {
        search: { query: TEST_QUERY, count: 1, oriQuestion: undefined },
      })
      const response = await fetch(`${row.base_url.replace(/\/+$/u, '')}${request.path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${plain}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(row.timeout_ms),
        ...(toolDispatcherFor(row.proxy_url) ? { dispatcher: toolDispatcherFor(row.proxy_url)! } : {}),
      })
      const cls = classifyUpstreamStatus(row.kind, response.status)
      if (cls !== 'ok') {
        const raw = await response.text().catch(() => '')
        return {
          ok: false,
          durationMs: Date.now() - started,
          results: null,
          error: `HTTP ${String(response.status)}：${sanitizeUpstreamError(upstreamMessage(raw))}`,
        }
      }
      const payload: unknown = await response.json()
      const parsed = request.parse(payload)
      return {
        ok: true,
        durationMs: Date.now() - started,
        results: parsed.tool === 'search' ? parsed.results.length : null,
        error: null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        durationMs: Date.now() - started,
        results: null,
        error: sanitizeUpstreamError(message),
      }
    }
  }

  // ── 概览与用量 ────────────────────────────────────────────────────────────

  function overview(): ToolOverviewResponse {
    const month = shanghaiMonth()
    const totals = toolOverviewTotals(db, month)
    return {
      month,
      totals: {
        calls: totals.calls,
        freeCalls: totals.freeCalls,
        revenueMicro: totals.revenue,
        upstreamCostMicro: totals.upstreamCost,
      },
      byChannel: toolOverviewByChannel(db, month),
      byTool: toolOverviewByTool(db, month),
    }
  }

  function usageList(
    query: ToolUsageQuery,
    opts: { userId?: number; scope: 'user' | 'admin' },
  ): ToolUsageListResponse {
    const userId = opts.scope === 'user' ? opts.userId : query.userId
    const { rows, total } = listToolUsageRows(db, {
      ...(userId === undefined ? {} : { userId }),
      ...(query.tool === undefined ? {} : { tool: query.tool }),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    })
    return {
      items: rows.map((row) => toToolUsageRow(row, { hideChannel: opts.scope === 'user' })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  /** 用户是否已经下发了搜索（managed.patch.yml 里有 `dsh-web-deepseek-api` 条目） */
  function attachedForUser(userId: number): boolean {
    const s = settings()
    if (!s.enabled || !s.deliverToDsh) return false
    const slug = db.get<{ slug: string }>('SELECT slug FROM users WHERE id = ?', userId)?.slug
    if (!slug) return false
    try {
      const content = readFileSync(join(deps.paths.userManaged(slug), 'managed.patch.yml'), 'utf8')
      // 渲染出来的是 patch 条目 `- id: web-deepseek-api`（不是插件包名）
      return content.includes('web-deepseek-api')
    } catch {
      return false
    }
  }

  function myTools(userId: number): MyToolsResponse {
    const s = settings()
    const month = shanghaiMonth()
    const totals = toolMonthTotals(db, userId, month)
    return {
      enabled: s.enabled,
      month,
      freeCallsPerMonth: s.freeCallsPerMonth,
      freeUsed: countFreeToolCalls(db, userId, month),
      searchPriceMicro: s.searchPriceMicro,
      fetchPriceMicro: s.fetchPriceMicro,
      monthCalls: totals.calls,
      monthCostMicro: totals.cost,
      dshAttached: attachedForUser(userId),
    }
  }

  // ── 设置 ──────────────────────────────────────────────────────────────────

  function updateSettings(
    patch: Partial<ToolSettings>,
    actorId: number,
    meta: RequestMeta,
  ): ToolSettingsResponse {
    const before = settings()
    const next = settingsStore.update(patch, clock.nowIso())
    audit({
      actorId,
      meta,
      action: 'tools.settings.update',
      targetType: 'tools.settings',
      targetId: null,
      detail: { fields: Object.keys(patch) },
    })
    // 只有影响 managed.patch.yml 的开关才需要重新同步下发状态
    if (before.enabled !== next.enabled || before.deliverToDsh !== next.deliverToDsh) {
      settingsStore.touchUpdatedAt(clock.nowIso())
      host.afterRenderAffectingChange('tools.settings')
    }
    return settingsResponse()
  }

  // ── 下发渲染（14 §5）──────────────────────────────────────────────────────

  function renderForUser(userId: number): {
    entries: { id?: string; config?: Record<string, unknown> }[]
    warnings: string[]
    needsKey: boolean
  } {
    const s = settings()
    if (!s.enabled || !s.deliverToDsh) return { entries: [], warnings: [], needsKey: false }
    const base = toolsInternalBaseUrl()
    if (base === null) {
      return {
        entries: [],
        warnings: ['搜索/抓取已开启下发，但中转站内部监听器没在监听，本次不渲染'],
        needsKey: false,
      }
    }
    void userId
    return {
      entries: [
        {
          id: 'web',
          config: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
        },
        {
          id: 'web-deepseek-api',
          config: { baseURL: base, apiKeyEnv: 'HUB_MK_HUB' },
        },
      ],
      warnings: [],
      needsKey: true,
    }
  }

  // ── 转发 ──────────────────────────────────────────────────────────────────

  interface WalletGate {
    status: number
    code: string
    message: string
  }

  /** 进门检查（14 §3.1）：用户状态 → 钱包停用 → 免费额度 / 余额 → 限流 */
  function checkWallet(userId: number, s: ToolSettings): WalletGate | null {
    const user = db.get<{ status: string }>(
      'SELECT status FROM users WHERE id = ? AND deleted_at IS NULL',
      userId,
    )
    if (!user || user.status === 'disabled') {
      return { status: 403, code: 'permission_denied', message: '你的搜索与抓取权限已停用，请联系管理员' }
    }
    if (user.status === 'pending') {
      return { status: 403, code: 'permission_denied', message: '账号还在等待审批' }
    }
    const wallet = db.get<{ balance: number; enabled: number }>(
      'SELECT balance, enabled FROM relay_wallets WHERE user_id = ?',
      userId,
    )
    if (wallet && wallet.enabled !== 1) {
      return { status: 403, code: 'permission_denied', message: '你的模型使用权限已停用，请联系管理员' }
    }
    const freeUsed = countFreeToolCalls(db, userId, shanghaiMonth())
    if (freeUsed < s.freeCallsPerMonth) return null
    if ((wallet?.balance ?? 0) > 0) return null
    return {
      status: 402,
      code: 'insufficient_points',
      message: `本月免费 ${String(s.freeCallsPerMonth)} 次已用完，积分不足，请联系管理员充值`,
    }
  }

  function recordUsage(input: {
    userId: number
    keyId: number | null
    tool: ToolKind
    status: 'ok' | 'client_error' | 'upstream_error' | 'rejected'
    free?: boolean
    cost?: number
    channelId?: number | null
    toolKeyId?: number | null
    upstreamCost?: number | null
    attempts: number
    durationMs: number
    summary: string
    error?: string | null
  }): void {
    insertToolUsageRow(db, {
      userId: input.userId,
      keyId: input.keyId,
      tool: input.tool,
      status: input.status,
      free: input.free ?? false,
      cost: input.cost ?? 0,
      channelId: input.channelId ?? null,
      toolKeyId: input.toolKeyId ?? null,
      upstreamCost: input.upstreamCost ?? null,
      attempts: input.attempts,
      durationMs: input.durationMs,
      summary: input.summary,
      error: input.error ?? null,
      month: shanghaiMonth(),
      at: clock.nowIso(),
    })
  }

  /** 钱包倍率：费用按 `rate_percent` 乘，向上取整（14 §3.1） */
  function walletRatePercent(userId: number): number {
    return (
      db.get<{ rate_percent: number }>('SELECT rate_percent FROM relay_wallets WHERE user_id = ?', userId)
        ?.rate_percent ?? 100
    )
  }

  async function forward(
    tool: ToolKind,
    body: Record<string, unknown>,
    auth: RelayAuthResult,
  ): Promise<ToolForwardOutcome> {
    const startedMs = clock.now().getTime()
    const userId = auth.user.id
    const s = settings()

    if (!s.enabled) {
      return { kind: 'error', status: 503, code: 'service_unavailable', message: '搜索与抓取已关闭' }
    }

    // 请求体校验（DeepSeek 格式）
    let parsed: { search?: ParsedSearchRequest; fetch?: ParsedFetchRequest }
    try {
      parsed = tool === 'search' ? { search: parseSearchRequest(body) } : { fetch: parseFetchRequest(body) }
    } catch (error) {
      const message = error instanceof ToolRequestError ? error.message : '请求体不合法'
      const summary = usageSummary(
        tool,
        tool === 'search' ? String(body.query ?? '') : String(body.url ?? ''),
      )
      recordUsage({
        userId,
        keyId: auth.key.id,
        tool,
        status: 'client_error',
        attempts: 0,
        durationMs: clock.now().getTime() - startedMs,
        summary,
        error: message,
      })
      return { kind: 'error', status: 400, code: 'invalid_request', message }
    }

    const gate = checkWallet(userId, s)
    if (gate) {
      const summary = usageSummary(
        tool,
        tool === 'search' ? (parsed.search?.query ?? '') : (parsed.fetch?.url ?? ''),
      )
      recordUsage({
        userId,
        keyId: auth.key.id,
        tool,
        status: 'rejected',
        attempts: 0,
        durationMs: clock.now().getTime() - startedMs,
        summary,
        error: gate.message,
      })
      return { kind: 'error', status: gate.status, code: gate.code, message: gate.message }
    }

    const limit = limiterFor(s.perUserPerMinute).consume(`user:${String(userId)}`)
    if (!limit.allowed) {
      const summary = usageSummary(
        tool,
        tool === 'search' ? (parsed.search?.query ?? '') : (parsed.fetch?.url ?? ''),
      )
      recordUsage({
        userId,
        keyId: auth.key.id,
        tool,
        status: 'rejected',
        attempts: 0,
        durationMs: clock.now().getTime() - startedMs,
        summary,
        error: '调用过于频繁',
      })
      return {
        kind: 'error',
        status: 429,
        code: 'rate_limited',
        message: `调用过于频繁，每分钟最多 ${String(s.perUserPerMinute)} 次`,
      }
    }

    const summary = usageSummary(
      tool,
      tool === 'search' ? (parsed.search?.query ?? '') : (parsed.fetch?.url ?? ''),
    )

    // 候选排序（14 §2）
    const channels = listToolChannelRows(db)
    const keys = listToolKeyRowsByChannels(
      db,
      channels.map((channel) => channel.id),
    )
    const keysByChannel = new Map<number, typeof keys>()
    for (const key of keys) {
      const list = keysByChannel.get(key.channel_id) ?? []
      list.push(key)
      keysByChannel.set(key.channel_id, list)
    }
    const routerChannels: ToolRouterChannel[] = channels.map((row) => ({
      channelId: row.id,
      channelName: row.name,
      kind: row.kind,
      priority: row.priority,
      weight: row.weight,
      channelEnabled: row.enabled === 1,
      channelCooldownUntil: row.cooldown_until,
      tools: parseToolKinds(row.tools_json),
      keys: (keysByChannel.get(row.id) ?? []).map((key) => ({
        keyId: key.id,
        state: key.state,
        cooldownUntil: key.cooldown_until,
      })),
    }))
    const outcome = planToolCandidates({
      tool,
      stickyKey: `tools:${String(userId)}`,
      channels: routerChannels,
      now: clock.nowIso(),
      maxAttempts: s.maxAttempts,
    })
    if (outcome.kind === 'no_available_channel') {
      recordUsage({
        userId,
        keyId: auth.key.id,
        tool,
        status: 'upstream_error',
        attempts: 0,
        durationMs: clock.now().getTime() - startedMs,
        summary,
        error: '暂无可用上游',
      })
      return { kind: 'error', status: 503, code: 'no_available_channel', message: '暂无可用上游' }
    }

    let attempts = 0
    let lastChannelId: number | null = null
    let lastToolKeyId: number | null = null
    let error: string | null = null
    let sawRateLimited = 0
    let sawAnyFailure = 0

    for (const candidate of outcome.candidates) {
      attempts += 1
      const channel = getToolChannelRow(db, candidate.channelId)
      const keyRow = getToolKeyRow(db, candidate.keyId)
      if (!channel || !keyRow) continue
      const plain = decrypt(keyRow.key_enc)
      if (!plain) {
        error = '渠道密钥不可用'
        continue
      }
      lastChannelId = channel.id
      lastToolKeyId = keyRow.id

      let request
      try {
        request = buildUpstreamRequest(channel.kind, tool, parsed)
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        recordUsage({
          userId,
          keyId: auth.key.id,
          tool,
          status: 'client_error',
          channelId: channel.id,
          toolKeyId: keyRow.id,
          attempts,
          durationMs: clock.now().getTime() - startedMs,
          summary,
          error: message,
        })
        return { kind: 'error', status: 400, code: 'invalid_request', message }
      }

      try {
        const dispatcher = toolDispatcherFor(channel.proxy_url)
        const response = await fetch(`${channel.base_url.replace(/\/+$/u, '')}${request.path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${plain}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(request.body),
          redirect: 'manual',
          signal: AbortSignal.timeout(channel.timeout_ms),
          ...(dispatcher ? { dispatcher } : {}),
        })
        const cls = classifyUpstreamStatus(channel.kind, response.status)

        if (cls === 'ok') {
          let payload: unknown
          try {
            payload = await response.json()
          } catch {
            throw new ToolUpstreamError('upstream', '上游响应不是合法 JSON')
          }
          const result = request.parse(payload)
          const upstreamCost = tool === 'search' ? channel.search_cost : channel.fetch_cost
          // 免费额度与扣费都放进同一个事务里再读一次：并发调用不会把免费额度多发出去
          let free = false
          let cost = 0
          db.tx(() => {
            free = countFreeToolCalls(db, userId, shanghaiMonth()) < s.freeCallsPerMonth
            const priceMicro = tool === 'search' ? s.searchPriceMicro : s.fetchPriceMicro
            cost = free ? 0 : Math.ceil((priceMicro * walletRatePercent(userId)) / 100)
            recordUsage({
              userId,
              keyId: auth.key.id,
              tool,
              status: 'ok',
              free,
              cost,
              channelId: channel.id,
              toolKeyId: keyRow.id,
              upstreamCost,
              attempts,
              durationMs: clock.now().getTime() - startedMs,
              summary,
              error: null,
            })
            if (cost > 0) host.chargeTool(userId, cost)
            noteChannelSuccess(channel.id)
          })
          touchKeyUsed(keyRow.id)
          // 一律由 Hub 组装成 DeepSeek 格式（14 §3.1）：不透传上游原始字节
          const body = result.tool === 'search' ? { results: result.results } : { content: result.content }
          return { kind: 'ok', status: 200, body, free, cost }
        }

        const raw = await response.text().catch(() => '')
        const message = sanitizeUpstreamError(upstreamMessage(raw) || `上游返回 ${String(response.status)}`)
        error = message

        if (cls === 'client') {
          recordUsage({
            userId,
            keyId: auth.key.id,
            tool,
            status: 'client_error',
            channelId: channel.id,
            toolKeyId: keyRow.id,
            attempts,
            durationMs: clock.now().getTime() - startedMs,
            summary,
            error: message,
          })
          return { kind: 'error', status: 400, code: 'invalid_request', message: `上游拒绝：${message}` }
        }
        if (cls === 'unauthorized') {
          autoDisableKey(channel.id, keyRow.id, message)
        } else if (cls === 'exhausted') {
          coolDownKey(keyRow.id, 'exhausted', message, nextMonthFirstUtcIso(clock.now()))
        } else if (cls === 'rate-limit') {
          const raise = Math.max(retryAfterSeconds(response.headers.get('retry-after')), s.keyCooldownSeconds)
          coolDownKey(
            keyRow.id,
            'rate-limit',
            message,
            new Date(clock.now().getTime() + raise * 1_000).toISOString(),
          )
          sawRateLimited += 1
        } else {
          coolDownKey(
            keyRow.id,
            'error',
            message,
            new Date(clock.now().getTime() + s.keyCooldownSeconds * 1_000).toISOString(),
          )
          noteChannelFailure(channel.id, message)
        }
        sawAnyFailure += 1
      } catch (caught) {
        const message = sanitizeUpstreamError(caught instanceof Error ? caught.message : String(caught))
        if (caught instanceof ToolUpstreamError && caught.failure === 'client') {
          recordUsage({
            userId,
            keyId: auth.key.id,
            tool,
            status: 'client_error',
            channelId: channel.id,
            toolKeyId: keyRow.id,
            attempts,
            durationMs: clock.now().getTime() - startedMs,
            summary,
            error: message,
          })
          return { kind: 'error', status: 400, code: 'invalid_request', message }
        }
        error = message
        coolDownKey(
          keyRow.id,
          'error',
          message,
          new Date(clock.now().getTime() + s.keyCooldownSeconds * 1_000).toISOString(),
        )
        noteChannelFailure(channel.id, message)
        sawAnyFailure += 1
      }
    }

    // 换遍候选仍失败（14 §3.1）：全是 429 给 429，否则 502；不计费
    if (sawAnyFailure > 0 && sawRateLimited === sawAnyFailure) {
      recordUsage({
        userId,
        keyId: auth.key.id,
        tool,
        status: 'upstream_error',
        channelId: lastChannelId,
        toolKeyId: lastToolKeyId,
        attempts,
        durationMs: clock.now().getTime() - startedMs,
        summary,
        error: error ?? '上游暂时不可用（限流）',
      })
      return { kind: 'error', status: 429, code: 'upstream_error', message: '上游暂时不可用（限流）' }
    }
    recordUsage({
      userId,
      keyId: auth.key.id,
      tool,
      status: 'upstream_error',
      channelId: lastChannelId,
      toolKeyId: lastToolKeyId,
      attempts,
      durationMs: clock.now().getTime() - startedMs,
      summary,
      error: error ?? '上游暂时不可用',
    })
    return { kind: 'error', status: 502, code: 'upstream_error', message: '上游暂时不可用' }
  }

  return {
    getSettings: settings,
    settingsResponse,
    updateSettings,
    listChannels,
    createChannel,
    updateChannel,
    deleteChannel,
    addChannelKeys,
    updateChannelKey,
    deleteChannelKey,
    testChannel,
    overview,
    usageList,
    myTools,
    forward,
    renderForUser,
    renderFingerprint,
    pendingAt: () => settingsStore.meta().updatedAt,
    attachedForUser,
  }
}

/** 供测试与诊断：当前已缓存的代理连接数 */
export function toolProxyAgentCount(): number {
  return toolProxyAgents.size
}

export type { ToolUpstreamResult }
