import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { ProxyAgent, fetch, type Dispatcher } from 'undici'
import {
  RELAY_RATE_PERMILLE_DEFAULT,
  type ModelApi,
  type RelayScope,
  type RelaySettings,
  type RelayUsageSource,
  type RelayUsageStatus,
  type RelayTokens,
} from '@dsh-hub/shared'
import type { Clock } from '../../lib/clock.js'
import type { HubDb } from '../../db/index.js'
import { computeCostMicro } from './billing.js'
import { estimateInputTokens, estimateTokensFromText } from './estimate.js'
import { relayClientKindOf, type RelayClientKind } from './keys.js'
import {
  getChannelKeyRow,
  getChannelRow,
  getChannelRowBySlug,
  getModelRowByName,
  listRouteRows,
  parseScope,
  toRelayPrice,
  type RelayChannelRow,
  type RelayModelRow,
  type RelayRouteRow,
} from './repo.js'
import { resolvePinnedModelName } from './pinned.js'
import { planCandidates, type RelayCandidate, type RelayRouterRoute } from './router.js'
import { createStreamUsageParser, parseUsageFromBytes, type RelayUsageTokens } from './usage-parse.js'
import type { RelayAuthResult } from './types.js'
import type { RelaySettingsStore } from './settings-store.js'

/**
 * 转发引擎（12 §5.2–§5.4）：选候选 → 改写请求 → fetch 上游 → 原样透传字节 + 旁路解析 usage →
 * 结束时一个事务里写用量、扣钱包、累加日汇总。
 *
 * 关键约定：
 * - **只在还没向客户端写出任何字节时换候选**（一旦 `reply.hijack()` 并写了响应头就定型）；
 * - 响应体字节原样透传（不重新序列化），旁路解析器只读不写；
 * - 客户端断开 → 中止上游请求；流式中两块数据间隔超过 300 秒 → 中止（upstream_error）。
 */

/** 流式中两块数据的最大间隔（12 §5.4） */
export const STREAM_IDLE_TIMEOUT_MS = 300_000
/** 非流式响应体最多在内存里留一份副本（解析 usage 用；32MB 请求上限下足够） */
const MAX_JSON_CAPTURE_BYTES = 8 * 1024 * 1024
/** 响应头白名单（12 §5.4） */
const RESPONSE_HEADER_ALLOWLIST = ['content-type', 'cache-control']
/** 请求头白名单（12 §5.3）：客户端的鉴权头、cookie、x-forwarded-* 一律不转 */
const REQUEST_HEADER_ALLOWLIST = [
  'content-type',
  'accept',
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
]

/** 一次请求里要落库的用量（12 §8 的 relay_usage 一行） */
export interface RelayRecordInput {
  requestId: string
  createdAt: string
  userId: number
  keyId: number | null
  /** 18 D7：来源（= 密钥作用域） */
  scope: RelayScope
  /** 用户请求里的原始模型名（可能带 `@slug`） */
  model: string
  /** 模型本名（供统计与对账） */
  baseModel: string
  /** 请求是否用 `<模型>@<slug>` 指定了渠道 */
  pinned: boolean
  upstreamModel: string | null
  channelId: number | null
  /** 计费时用的渠道倍率快照（千分比）；没走到渠道 = null */
  channelRatePermille: number | null
  /** 18 §3.3：计费时用的模式整体倍率快照（千分比）；dsh = null */
  modeRatePermille: number | null
  api: ModelApi
  stream: boolean
  source: RelayUsageSource
  status: RelayUsageStatus
  httpStatus: number | null
  /** 来源（= 凭据种类，WP25a / D6 §7.3）：docker | desktop | external | unknown */
  clientKind: RelayClientKind
  tokens: RelayTokens & { reasoningTokens: number }
  cost: number
  estimated: boolean
  attempts: number
  durationMs: number | null
  ttftMs: number | null
  error: string | null
}

/** service 提供给转发引擎的能力（避免 proxy 反向依赖 service 的具体实现） */
export interface RelayProxyHost {
  readonly db: HubDb
  readonly clock: Clock
  readonly log: FastifyBaseLogger
  settings(): RelaySettings
  masterKey(): Buffer | null
  settingsStore(): RelaySettingsStore
  /** 解密渠道密钥；密文坏了返回 null */
  decryptChannelKey(keyEnc: string): string | null
  inFlightUser(userId: number): number
  inFlightChannel(channelId: number): number
  enterUser(userId: number): void
  exitUser(userId: number): void
  enterChannel(channelId: number): void
  exitChannel(channelId: number): void
  /** 一个事务里：INSERT relay_usage + 扣钱包 + upsert 日汇总（12 §6.4） */
  recordUsage(input: RelayRecordInput): void
  /** 渠道成功/失败（熔断计数）与密钥状态变更 */
  noteChannelSuccess(channelId: number): void
  noteChannelFailure(channelId: number, message: string): void
  noteKeyRateLimited(channelId: number, keyId: number, retryAfterSec: number): void
  noteKeyUnauthorized(channelId: number, keyId: number, message: string): void
  touchKeyUsed(keyId: number): void
  /** 18 §3.3：模式当前的整体倍率（千分比）；`dsh` 恒 1000 */
  agentModeRatePermille(scope: RelayScope): number
}

export interface RelayForwardInput {
  api: ModelApi
  source: RelayUsageSource
  auth: RelayAuthResult
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
  body: Record<string, unknown>
  ip: string | null
  /** 客户端请求路径（区分 `/messages` 与 `/messages/count_tokens`） */
  path?: string
  /** 是否记账：`count_tokens` 透传但不计费、不记用量（12 §4） */
  metered?: boolean
}

// ── 错误响应（两家厂商格式，12 §4）─────────────────────────────────────────

/** OpenAI 兼容错误体 */
export function openAiErrorBody(message: string, type: string, code: string): Record<string, unknown> {
  return { error: { message, type, code } }
}

/** Anthropic 兼容错误体 */
export function anthropicErrorBody(message: string, type: string): Record<string, unknown> {
  return { type: 'error', error: { type, message } }
}

export function isAnthropicApi(api: ModelApi): boolean {
  return api === 'anthropic-messages'
}

export function vendorErrorBody(api: ModelApi, message: string, code: string, type: string): unknown {
  return isAnthropicApi(api) ? anthropicErrorBody(message, type) : openAiErrorBody(message, type, code)
}

/** 上游错误信息脱敏：去掉形如 `sk-…` 的密钥片段，截断到 300 字（12 §5.2） */
export function sanitizeUpstreamError(text: string, limit = 300): string {
  const cleaned = text
    .replace(/\b(sk|pk|api|key|token)[-_][A-Za-z0-9._-]{6,}/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]')
    .replace(/\bx-api-key["'\s:=]+[A-Za-z0-9._-]{8,}/gi, 'x-api-key=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned
}

// ── 请求构造 ────────────────────────────────────────────────────────────────

export interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * 上游路径（12 §5.3）：`{baseUrl}/chat/completions` | `/responses` | `/messages` | `/messages/count_tokens`。
 * `count_tokens` 与 `/messages` 同协议但路径不同，所以按客户端请求路径判定。
 */
export function upstreamPathFor(api: ModelApi, requestPath = ''): string {
  const path = requestPath.split('?')[0] ?? ''
  if (path.endsWith('/count_tokens')) return '/messages/count_tokens'
  if (api === 'anthropic-messages') return '/messages'
  if (api === 'openai-responses') return '/responses'
  return '/chat/completions'
}

/**
 * 客户端请求的查询串（18 §3.2）：路径分类只看 pathname，转发时**原样带上**查询串
 * （`?beta=true` 是 Claude Code 对官方 API 的正常用法）。
 */
export function requestQueryFor(requestPath = ''): string {
  const index = requestPath.indexOf('?')
  if (index < 0) return ''
  const query = requestPath.slice(index)
  // 去掉 hash（HTTP 请求目标里正常不会出现，防御手工构造）
  const hash = query.indexOf('#')
  return hash < 0 ? query : query.slice(0, hash)
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`
}

/**
 * 构造上游请求：只改 `model`（→ 路由的 upstreamModel），`openai-completions` 且渠道开启
 * `streamUsage` 时自动补 `stream_options.include_usage`；请求头按白名单透传后按协议写鉴权。
 */
export function buildUpstreamRequest(opts: {
  api: ModelApi
  channel: RelayChannelRow
  candidate: RelayCandidate
  upstreamKey: string
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
  body: Record<string, unknown>
  /** 客户端请求路径（区分 `/messages` 与 `/messages/count_tokens`） */
  requestPath?: string
}): UpstreamRequest {
  const body: Record<string, unknown> = { ...opts.body, model: opts.candidate.upstreamModel }
  if (opts.api === 'openai-completions' && body.stream === true && opts.channel.stream_usage === 1) {
    const existing = body.stream_options
    const merged =
      typeof existing === 'object' && existing !== null ? { ...(existing as Record<string, unknown>) } : {}
    merged.include_usage = true
    body.stream_options = merged
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    if (name === 'content-type') continue
    const value = opts.headers[name]
    const single = Array.isArray(value) ? value[0] : value
    if (typeof single === 'string' && single.length > 0) headers[name] = single
  }
  const extra = opts.channel.headers_json
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && !isForbiddenHeader(key)) headers[key.toLowerCase()] = value
      }
    } catch {
      // 坏 headers_json 直接忽略（保存时已校验过）
    }
  }
  if (opts.api === 'anthropic-messages') {
    headers['x-api-key'] = opts.upstreamKey
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${opts.upstreamKey}`
  }

  return {
    url: `${joinUrl(opts.channel.base_url, upstreamPathFor(opts.api, opts.requestPath))}${requestQueryFor(
      opts.requestPath ?? '',
    )}`,
    headers,
    body: JSON.stringify(body),
  }
}

/** 渠道自定义头里禁止出现的鉴权头（12 §9） */
export function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'authorization' || lower === 'x-api-key' || lower === 'cookie'
}

/** 从上游响应头里挑出要回给客户端的白名单头 */
export function pickResponseHeaders(headers: Headers, streaming: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = headers.get(name)
    if (value) out[name] = value
  }
  if (streaming) out['x-accel-buffering'] = 'no'
  return out
}

// ── 候选 ────────────────────────────────────────────────────────────────────

/** 把库里的一条路由 + 渠道 + 密钥拼成 router 要的纯数据 */
export function routerRoutesForModel(
  host: RelayProxyHost,
  modelId: number,
  _userId: number,
): RelayRouterRoute[] {
  return routerRoutesForRows(host, listRouteRows(host.db, modelId))
}

/** 把一组路由 + 渠道 + 密钥拼成 router 要的纯数据（指定渠道调用时只传该渠道的路由） */
export function routerRoutesForRows(host: RelayProxyHost, routes: RelayRouteRow[]): RelayRouterRoute[] {
  return routes.map((route) => {
    const channel = getChannelRow(host.db, route.channel_id)
    const keys = channel ? listChannelKeysForRouter(host, channel.id) : []
    return {
      routeId: route.id,
      channelId: route.channel_id,
      channelName: channel?.name ?? `#${String(route.channel_id)}`,
      upstreamModel: route.upstream_model,
      priority: route.priority,
      weight: route.weight,
      routeEnabled: route.enabled === 1,
      channelEnabled: channel?.enabled === 1,
      channelApis: channel ? (JSON.parse(channel.apis_json) as ModelApi[]) : [],
      channelPriority: channel?.priority ?? 0,
      channelWeight: channel?.weight ?? 1,
      channelCooldownUntil: channel?.cooldown_until ?? null,
      channelMaxConcurrency: channel?.max_concurrency ?? 0,
      channelInFlight: host.inFlightChannel(route.channel_id),
      keys,
    }
  })
}

function listChannelKeysForRouter(
  host: RelayProxyHost,
  channelId: number,
): { keyId: number; state: 'active' | 'disabled' | 'auto-disabled'; cooldownUntil: string | null }[] {
  return host.db
    .all<{ id: number; state: string; cooldown_until: string | null }>(
      'SELECT id, state, cooldown_until FROM relay_channel_keys WHERE channel_id = ?',
      channelId,
    )
    .map((row) => ({
      keyId: row.id,
      state: row.state === 'active' || row.state === 'disabled' ? row.state : 'auto-disabled',
      cooldownUntil: row.cooldown_until,
    }))
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 转发一次 `/v1` 请求。所有进门检查（总开关、钱包、余额、日上限、并发）都在这里做，
 * 保证「同一份判定逻辑」不因为入口不同而漂移。
 */
export async function forwardV1(
  req: FastifyRequest,
  reply: FastifyReply,
  input: RelayForwardInput,
  host: RelayProxyHost,
): Promise<void> {
  const startedMs = host.clock.now().getTime()
  const requestId = randomUUID()
  const api = input.api
  const settings = host.settings()
  const log = host.log
  const startedAt = host.clock.nowIso()
  const scope = input.auth.key.scope
  // 18 §3.3：模式倍率取「请求开始时」的设置值（改倍率对进行中的请求不生效）
  const modeRatePermille = scope === 'dsh' ? null : host.agentModeRatePermille(scope)

  const fail = (status: number, code: string, type: string, message: string): void => {
    void reply.code(status).send(vendorErrorBody(api, message, code, type))
  }

  if (!settings.enabled) {
    fail(503, 'service_unavailable', 'api_error', '中转站已关闭')
    return
  }

  const modelName = typeof input.body.model === 'string' ? input.body.model.trim() : ''
  if (modelName.length === 0) {
    fail(400, 'invalid_request', 'invalid_request_error', 'model 必须是字符串')
    return
  }
  // 16 §3：先整串精确匹配（兼容本来名字就带 @ 的模型），再按最后一个 @ 解析「模型@渠道标识」
  const pinned = resolvePinnedModelName(modelName, {
    modelExists: (name) => getModelRowByName(host.db, name) !== undefined,
    channelExists: (slug) => getChannelRowBySlug(host.db, slug) !== undefined,
  })
  const model = getModelRowByName(host.db, pinned.baseModel)
  // 18 §3.2：模型只在密钥的作用域里解析；别的作用域的名字一律 404（不泄露它存在）
  const visible =
    model &&
    parseScope(model.scope) === scope &&
    model.enabled === 1 &&
    (model.visibility === 'all' || input.auth.user.role === 'admin')
  if (!model || !visible) {
    fail(404, 'model_not_found', 'not_found_error', `模型 ${modelName} 不存在`)
    return
  }

  // 指定渠道时只用这条渠道上的候选（16 §3）：模型在这条渠道上没有路由 = 404；路由/渠道停用 = 503，
  // 渠道不支持本次协议 = 400。失败也只在这条渠道的密钥之间切换，绝不跨渠道。
  let modelRoutes = listRouteRows(host.db, model.id)
  if (pinned.channelSlug !== null) {
    const channel = getChannelRowBySlug(host.db, pinned.channelSlug)
    const onChannel = modelRoutes.filter((route) => route.channel_id === channel?.id)
    if (!channel || parseScope(channel.scope) !== scope || onChannel.length === 0) {
      fail(404, 'model_not_found', 'not_found_error', `模型 ${modelName} 不存在`)
      return
    }
    modelRoutes = onChannel
  }

  // 进门检查（12 §6.4）；系统账号（座舱）跳过余额/日上限，见 checkWallet
  const check = host.settingsStore() && checkWallet(host, input.auth.user, settings)
  if (check) {
    fail(check.status, check.code, check.type, check.message)
    return
  }

  const stream = input.body.stream === true
  const outcome = planCandidates({
    api,
    routes: routerRoutesForRows(host, modelRoutes),
    // 会合哈希用模型本名（16 §3）：同一用户的密钥选择与老写法保持一致
    stickyKey: `${String(input.auth.user.id)}:${model.name}`,
    now: host.clock.nowIso(),
    maxAttempts: settings.maxAttempts,
  })
  if (outcome.kind === 'unsupported_endpoint') {
    fail(400, 'unsupported_endpoint', 'invalid_request_error', `模型 ${model.name} 不支持该接口`)
    return
  }
  if (outcome.kind === 'no_available_channel') {
    fail(503, 'no_available_channel', 'overloaded_error', '暂无可用上游')
    return
  }

  host.enterUser(input.auth.user.id)
  let attempts = 0
  let upstreamModel: string | null = null
  let channelId: number | null = null
  /** 实际服务这次请求的渠道的倍率快照（失败切换后的最后一个候选；12 §6.2） */
  let channelRatePermille: number | null = null
  let httpStatus: number | null = null
  let ttftMs: number | null = null
  let error: string | null = null
  let status: RelayUsageStatus = 'upstream_error'
  let tokens: RelayUsageTokens | null = null
  let estimated = false
  let outputText = ''
  let sawRateLimited = 0
  let sawAnyFailure = 0

  try {
    for (const candidate of outcome.candidates) {
      attempts += 1
      const channel = getChannelRow(host.db, candidate.channelId)
      const keyRow = getChannelKeyRow(host.db, candidate.keyId)
      if (!channel || !keyRow) continue
      const upstreamKey = host.decryptChannelKey(keyRow.key_enc)
      if (!upstreamKey) {
        error = '渠道密钥不可用'
        continue
      }

      const request = buildUpstreamRequest({
        api,
        channel,
        candidate,
        upstreamKey,
        headers: input.headers,
        body: input.body,
        ...(input.path === undefined ? {} : { requestPath: input.path }),
      })

      const controller = new AbortController()
      let clientGone = false
      const onClientClose = (): void => {
        if (reply.raw.writableEnded) return
        clientGone = true
        controller.abort(new Error('client disconnected'))
      }
      reply.raw.on('close', onClientClose)

      const headersTimer = setTimeout(
        () => {
          controller.abort(new Error('upstream timeout'))
        },
        Math.max(1_000, channel.timeout_ms),
      )

      host.enterChannel(channel.id)
      let releaseChannel = true
      const release = (): void => {
        if (!releaseChannel) return
        releaseChannel = false
        host.exitChannel(channel.id)
      }

      try {
        const dispatcher = dispatcherFor(host, channel)
        const response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        })
        clearTimeout(headersTimer)
        httpStatus = response.status
        upstreamModel = candidate.upstreamModel
        channelId = channel.id
        // 快照与 channelId 同步：费用按「服务这次请求的渠道」算，之后渠道改倍率不影响历史行
        channelRatePermille = channel.rate_permille

        if (!response.ok && response.status >= 400 && !isRetryableStatus(response.status)) {
          // 400 / 404 / 413 / 422 等：不换、原样回、不计费（client_error）
          const raw = Buffer.from(await response.arrayBuffer())
          const message = extractUpstreamMessage(raw)
          if (!clientGone) {
            writeResponse(
              reply,
              response.status,
              pickResponseHeaders(response.headers, false),
              requestId,
              raw,
            )
          }
          status = 'client_error'
          error = message
          tokens = parseUsageFromBytes(api, raw)
          record(host, {
            input,
            requestId,
            startedAt,
            startedMs,
            model,
            scope,
            modeRatePermille,
            requestedModel: modelName,
            pinned: pinned.channelSlug !== null,
            upstreamModel,
            channelId,
            channelRatePermille,
            api,
            stream,
            status,
            httpStatus,
            tokens,
            estimated: false,
            attempts,
            ttftMs,
            error,
          })
          return
        }

        if (isRetryableStatus(response.status)) {
          // 5xx / 429 / 401 / 403：只在还没写字节时换候选
          const raw = Buffer.from(await response.arrayBuffer()).subarray(0, 4_000)
          const message = sanitizeUpstreamError(
            extractUpstreamMessage(raw) || `上游返回 ${String(response.status)}`,
          )
          error = message
          if (response.status === 429) {
            sawRateLimited += 1
            host.noteKeyRateLimited(
              channel.id,
              keyRow.id,
              retryAfterSeconds(response.headers.get('retry-after')),
            )
          } else if (response.status === 401 || response.status === 403) {
            host.noteKeyUnauthorized(channel.id, keyRow.id, message)
          } else {
            host.noteChannelFailure(channel.id, message)
          }
          sawAnyFailure += 1
          continue
        }

        // 2xx：开始回写（此后不能再换候选）
        host.noteChannelSuccess(channel.id)
        host.touchKeyUsed(keyRow.id)
        const headers = pickResponseHeaders(response.headers, stream)
        reply.hijack()
        reply.raw.writeHead(response.status, { ...headers, 'x-dshhub-request-id': requestId })
        // 首字节耗时 = 发出请求 → 上游**第一块响应体**（12 §5.4），不是收到响应头
        let firstChunkAt: number | null = null
        const pump = await pumpBody(response, reply, {
          api,
          stream,
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
          controller,
          onChunk: () => {
            if (firstChunkAt === null) firstChunkAt = host.clock.now().getTime()
          },
        })
        ttftMs = (firstChunkAt ?? host.clock.now().getTime()) - startedMs
        const metered = input.metered !== false
        if (!metered) return
        tokens = pump.tokens
        outputText = pump.outputText
        // 客户端读到收尾标记（[DONE] 等）就会主动断开，它的 FIN 常常赶在上游关闭响应体之前到达；
        // 流已经完整透传的，不能记成「已中断」（否则错误率被这类正常结束的请求撑高）
        if ((pump.clientGone || clientGone) && !pump.completed) {
          status = 'aborted'
          error = '客户端断开'
        } else if (pump.error) {
          status = 'upstream_error'
          error = sanitizeUpstreamError(pump.error)
        } else {
          status = 'ok'
        }
        if (!tokens) {
          estimated = true
          tokens = {
            input: estimateInputTokens(input.body),
            output: estimateTokensFromText(outputText),
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
          }
        }
        record(host, {
          input,
          requestId,
          startedAt,
          startedMs,
          model,
          scope,
          modeRatePermille,
          requestedModel: modelName,
          pinned: pinned.channelSlug !== null,
          upstreamModel,
          channelId,
          channelRatePermille,
          api,
          stream,
          status,
          httpStatus,
          tokens,
          estimated,
          attempts,
          ttftMs,
          error,
        })
        return
      } catch (caught) {
        clearTimeout(headersTimer)
        const message = caught instanceof Error ? caught.message : String(caught)
        error = sanitizeUpstreamError(message)
        if (clientGone) {
          status = 'aborted'
          tokens = null
          record(host, {
            input,
            requestId,
            startedAt,
            startedMs,
            model,
            scope,
            modeRatePermille,
            requestedModel: modelName,
            pinned: pinned.channelSlug !== null,
            upstreamModel,
            channelId,
            channelRatePermille,
            api,
            stream,
            status,
            httpStatus,
            tokens: {
              input: estimateInputTokens(input.body),
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
            },
            estimated: true,
            attempts,
            ttftMs,
            error: '客户端断开',
          })
          return
        }
        sawAnyFailure += 1
        host.noteChannelFailure(channel.id, error)
      } finally {
        clearTimeout(headersTimer)
        reply.raw.removeListener('close', onClientClose)
        release()
      }
    }

    // 换遍候选仍失败：全是 429 时给 429，否则 502（12 §4）
    if (sawAnyFailure > 0 && sawRateLimited === sawAnyFailure) {
      fail(429, 'upstream_error', 'rate_limit_error', '上游暂时不可用（限流）')
    } else {
      fail(502, 'upstream_error', 'api_error', '上游暂时不可用')
    }
    record(host, {
      input,
      requestId,
      startedAt,
      startedMs,
      model,
      scope,
      modeRatePermille,
      requestedModel: modelName,
      pinned: pinned.channelSlug !== null,
      upstreamModel,
      channelId,
      channelRatePermille,
      api,
      stream,
      status: 'upstream_error',
      httpStatus,
      tokens: null,
      estimated: false,
      attempts,
      ttftMs,
      error: error ?? '上游暂时不可用',
    })
  } finally {
    host.exitUser(input.auth.user.id)
  }
  void log
}

interface WalletCheck {
  status: number
  code: string
  type: string
  message: string
}

/**
 * 进门检查：账号状态 → 钱包启用 → 余额 → 日上限 → 并发（12 §4、§6.4）。
 *
 * **系统账号（`is_system=1`，座舱 `hub-ops`）不查余额与日上限**（WP56e1 / docs/24 §3.5）：
 * 座舱不扣任何人的积分，钱包恒为 0；如果照普通用户判，座舱的每一个模型请求都会被 402 挡掉，
 * 管理台就永远答不上一句话（I6 的反面）。并发上限与账号状态照旧生效（保护上游）。
 */
function checkWallet(
  host: RelayProxyHost,
  user: { id: number; isSystem?: boolean },
  settings: RelaySettings,
): WalletCheck | null {
  const userId = user.id
  const isSystem = user.isSystem === true
  const row = getWalletRowLazy(host, userId)
  const state = host.db.get<{ status: string; role: string }>(
    'SELECT status, role FROM users WHERE id = ? AND deleted_at IS NULL',
    userId,
  )
  if (!state || state.status === 'disabled') {
    return {
      status: 403,
      code: 'permission_denied',
      type: 'permission_error',
      message: '你的模型使用权限已停用，请联系管理员',
    }
  }
  if (state.status === 'pending') {
    return {
      status: 403,
      code: 'permission_denied',
      type: 'permission_error',
      message: '账号还在等待审批',
    }
  }
  if (row.enabled !== 1 && !isSystem) {
    return {
      status: 403,
      code: 'permission_denied',
      type: 'permission_error',
      message: '你的模型使用权限已停用，请联系管理员',
    }
  }
  if (!isSystem && row.balance <= 0) {
    const points = (row.balance / 1_000_000).toFixed(2)
    return {
      status: 402,
      code: 'insufficient_points',
      type: 'permission_error',
      message: `积分不足（余额 ${points}），请联系管理员充值`,
    }
  }
  if (!isSystem && row.daily_limit !== null) {
    const today = shanghaiToday(host)
    const spent = host.db.get<{ total: number | null }>(
      'SELECT SUM(cost) AS total FROM relay_usage_daily WHERE user_id = ? AND day = ?',
      userId,
      today,
    )?.total
    if (Number(spent ?? 0) >= row.daily_limit) {
      return {
        status: 402,
        code: 'daily_limit_reached',
        type: 'permission_error',
        message: '今日用量已达上限',
      }
    }
  }
  const limit = row.max_concurrency ?? settings.defaultMaxConcurrency
  if (host.inFlightUser(userId) >= limit) {
    return {
      status: 429,
      code: 'concurrency_limit',
      type: 'rate_limit_error',
      message: '同时进行的请求过多',
    }
  }
  return null
}

/** 进门检查读钱包但不写库（12 §6.4：GET 与判定都不懒创建，写的时候才建） */
function getWalletRowLazy(
  host: RelayProxyHost,
  userId: number,
): {
  balance: number
  enabled: number
  daily_limit: number | null
  max_concurrency: number | null
} {
  const row = host.db.get<{
    balance: number
    enabled: number
    daily_limit: number | null
    max_concurrency: number | null
  }>('SELECT balance, enabled, daily_limit, max_concurrency FROM relay_wallets WHERE user_id = ?', userId)
  return row ?? { balance: 0, enabled: 1, daily_limit: null, max_concurrency: null }
}

function shanghaiToday(host: RelayProxyHost): string {
  return new Date(host.clock.now().getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 401 || status === 403 || status >= 500
}

function retryAfterSeconds(header: string | null): number {
  const parsed = Number(header)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

/** 上游错误体里的可读信息（尽量短、已脱敏） */
function extractUpstreamMessage(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8')
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string') return message
    }
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    // 不是 JSON：直接截断原文
  }
  return text.slice(0, 300)
}

function writeResponse(
  reply: FastifyReply,
  status: number,
  headers: Record<string, string>,
  requestId: string,
  body: Uint8Array,
): void {
  reply.hijack()
  reply.raw.writeHead(status, { ...headers, 'x-dshhub-request-id': requestId })
  reply.raw.end(Buffer.from(body))
}

interface PumpResult {
  tokens: RelayUsageTokens | null
  outputText: string
  error: string | null
  clientGone: boolean
  /** 客户端断开之前，流里已经出现过协议的收尾标记（见 StreamUsageParser.sawComplete）：这种断开不算中断 */
  completed: boolean
}

/** 非流式响应体里助手输出的文本（估算输出 token 用；只取文本，不取 base64） */
export function extractOutputText(api: ModelApi, body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const record = body as Record<string, unknown>
  const parts: string[] = []
  if (api === 'openai-completions') {
    for (const choice of Array.isArray(record.choices) ? record.choices : []) {
      const content = (choice as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') parts.push(content)
    }
  } else if (api === 'anthropic-messages') {
    for (const block of Array.isArray(record.content) ? record.content : []) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  } else {
    for (const item of Array.isArray(record.output) ? record.output : []) {
      for (const block of Array.isArray((item as { content?: unknown }).content)
        ? ((item as { content: unknown[] }).content as unknown[])
        : []) {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
  }
  return parts.join('')
}

/** 原样透传响应体，同时喂给旁路解析器；处理客户端断开与流式空闲超时 */
async function pumpBody(
  response: Awaited<ReturnType<typeof fetch>>,
  reply: FastifyReply,
  opts: {
    api: ModelApi
    stream: boolean
    idleTimeoutMs: number
    controller: AbortController
    onChunk?: (chunk: Uint8Array) => void
  },
): Promise<PumpResult> {
  // 上游有时不按请求的 stream 标记返回（例如网关强制 SSE）：以 content-type 为准决定解析方式
  // 反过来也有：请求了 stream 但上游忽略、直接回整段 JSON——这时必须按 JSON 解析，否则拿不到 usage 只能估算
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const streamParsed = contentType.includes('event-stream')
    ? true
    : contentType.includes('json')
      ? false
      : opts.stream
  const parser = streamParsed ? createStreamUsageParser(opts.api) : null
  const jsonChunks: Buffer[] = []
  let jsonBytes = 0
  let outputText = ''
  let clientGone = false
  let error: string | null = null
  let idleTimer: NodeJS.Timeout | null = null

  const resetIdle = (): void => {
    if (!opts.stream) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      error = '流式空闲超时'
      opts.controller.abort(new Error('stream idle timeout'))
    }, opts.idleTimeoutMs)
  }
  resetIdle()

  const onClose = (): void => {
    if (reply.raw.writableEnded) return
    clientGone = true
    opts.controller.abort(new Error('client disconnected'))
  }
  reply.raw.on('close', onClose)

  try {
    const body = response.body
    if (!body) {
      reply.raw.end()
      return { tokens: parser?.usage() ?? null, outputText: '', error, clientGone, completed: false }
    }
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        resetIdle()
        if (parser) parser.push(value)
        else if (jsonBytes < MAX_JSON_CAPTURE_BYTES) {
          const buffer = Buffer.from(value)
          jsonChunks.push(buffer)
          jsonBytes += buffer.byteLength
        }
        if (!clientGone && !reply.raw.writableEnded) {
          reply.raw.write(Buffer.from(value))
        }
        opts.onChunk?.(value)
      }
    }
    if (!reply.raw.writableEnded) reply.raw.end()
    if (!parser) {
      // 非流式：整段响应就是一份 JSON，用非流式解析器取 usage（12 §5.5）
      const raw = Buffer.concat(jsonChunks)
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw.toString('utf8')) as unknown
      } catch {
        parsed = null
      }
      return {
        tokens: parseUsageFromBytes(opts.api, raw),
        outputText: parsed === null ? '' : extractOutputText(opts.api, parsed),
        error,
        clientGone,
        completed: false,
      }
    }
    outputText = parser.outputText()
    return { tokens: parser.usage(), outputText, error, clientGone, completed: parser.sawComplete() }
  } catch (caught) {
    if (!reply.raw.writableEnded) reply.raw.end()
    if (clientGone) {
      return {
        tokens: parser?.usage() ?? null,
        outputText: parser?.outputText() ?? '',
        error: null,
        clientGone: true,
        completed: parser?.sawComplete() ?? false,
      }
    }
    return {
      tokens: parser?.usage() ?? null,
      outputText: parser?.outputText() ?? '',
      error: error ?? (caught instanceof Error ? caught.message : String(caught)),
      clientGone,
      completed: false,
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    reply.raw.removeListener('close', onClose)
  }
}

/** 渠道代理：`proxyUrl` 非空时用 undici 的 ProxyAgent（12 §5.3）；按 URL 缓存避免连接泄漏 */
const proxyAgents = new Map<string, ProxyAgent>()

function dispatcherFor(host: RelayProxyHost, channel: RelayChannelRow): Dispatcher | null {
  if (!channel.proxy_url) return null
  const url = channel.proxy_url.trim()
  if (url.length === 0) return null
  let agent = proxyAgents.get(url)
  if (!agent) {
    agent = new ProxyAgent(url)
    proxyAgents.set(url, agent)
  }
  void host
  return agent
}

/** 进程退出时释放代理连接池（测试里也会调用） */
export function closeProxyAgents(): void {
  for (const agent of proxyAgents.values()) void agent.close().catch(() => undefined)
  proxyAgents.clear()
}

// ── 落库 ────────────────────────────────────────────────────────────────────

interface RecordOptions {
  input: RelayForwardInput
  requestId: string
  startedAt: string
  startedMs: number
  model: RelayModelRow
  /** 18 D7：来源（= 密钥作用域） */
  scope: RelayScope
  /** 18 §3.3：请求开始时的模式整体倍率（dsh = null） */
  modeRatePermille: number | null
  /** 用户请求里的原始名字（用量 `model`） */
  requestedModel: string
  /** 是否用 `<模型>@<slug>` 指定了渠道 */
  pinned: boolean
  upstreamModel: string | null
  channelId: number | null
  channelRatePermille: number | null
  api: ModelApi
  stream: boolean
  status: RelayUsageStatus
  httpStatus: number | null
  tokens: RelayUsageTokens | null
  estimated: boolean
  attempts: number
  ttftMs: number | null
  error: string | null
}

function record(host: RelayProxyHost, opts: RecordOptions): void {
  const settings = host.settings()
  const tokens = opts.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const billable = opts.status !== 'client_error' && opts.status !== 'upstream_error'
  // aborted 且估算时也计费（12 §5.4）；钱包倍率从钱包取、渠道倍率用本次实际服务的渠道快照
  const wallet = host.db.get<{ rate_percent: number }>(
    'SELECT rate_percent FROM relay_wallets WHERE user_id = ?',
    opts.input.auth.user.id,
  )
  const cost = billable
    ? computeCostMicro(
        toRelayPrice(opts.model),
        {
          input: tokens.input,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          output: tokens.output,
        },
        {
          walletRatePercent: wallet?.rate_percent ?? 100,
          channelRatePermille: opts.channelRatePermille ?? RELAY_RATE_PERMILLE_DEFAULT,
          ...(opts.modeRatePermille === null ? {} : { modeRatePermille: opts.modeRatePermille }),
        },
      )
    : 0
  host.recordUsage({
    requestId: opts.requestId,
    createdAt: opts.startedAt,
    userId: opts.input.auth.user.id,
    keyId: opts.input.auth.key.id,
    scope: opts.scope,
    model: opts.requestedModel,
    baseModel: opts.model.name,
    pinned: opts.pinned,
    upstreamModel: opts.upstreamModel,
    channelId: opts.channelId,
    channelRatePermille: opts.channelRatePermille,
    modeRatePermille: opts.modeRatePermille,
    api: opts.api,
    stream: opts.stream,
    // 系统账号的用量一律记成 `cockpit`（service 的 recordUsage 也按同一个口径覆盖一次）
    source: opts.input.auth.user.isSystem === true ? 'cockpit' : opts.input.source,
    status: opts.status,
    httpStatus: opts.httpStatus,
    clientKind: relayClientKindOf(opts.input.auth.key),
    tokens: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite,
      reasoningTokens: tokens.reasoning,
    },
    cost,
    estimated: opts.estimated,
    attempts: opts.attempts,
    durationMs: host.clock.now().getTime() - opts.startedMs,
    ttftMs: opts.ttftMs,
    error: opts.error,
  })
  void settings
}
