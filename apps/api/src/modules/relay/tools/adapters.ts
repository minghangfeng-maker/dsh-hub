import type { ToolChannelKind, ToolKind } from '@dsh-hub/shared'
import type { ToolUpstreamFailure, ToolUpstreamResult } from './types.js'

/**
 * 上游适配（14 §1、§3.1，**纯函数**）：把 DeepSeek Search/Fetch API 格式与 Tavily 格式互相转换，
 * 并校验上游响应（字段类型不对 = 上游故障，换候选；目标页面抓不到 = 客户端错误，不换不计费）。
 *
 * 为什么 Hub 一律由自己组装 DeepSeek 格式的 JSON 再回给客户端：这样两种上游对 DSH 完全一致，
 * 也不透传上游原始字节（错误体、字段名、计费信息都不会泄漏）。
 */

/** DeepSeek `count` 默认值（DSH 的 `DEEPSEEK_DEFAULT_COUNT`） */
export const TOOL_DEFAULT_COUNT = 10
/** Hub 对客户端的 `count` 上限：Tavily `max_results` 最多 20（14 §3.1） */
export const TOOL_MAX_COUNT = 20
/** DeepSeek API 允许的 count 上限（超过直接 400，不悄悄截断） */
export const TOOL_ACCEPT_COUNT = 50

/** 上游失败（带分类，由调用方决定换候选还是回 400） */
export class ToolUpstreamError extends Error {
  readonly failure: ToolUpstreamFailure

  constructor(failure: ToolUpstreamFailure, message: string) {
    super(message)
    this.name = 'ToolUpstreamError'
    this.failure = failure
  }
}

/** HTTP 状态 → 失败分类（14 §3.1 的表） */
export function classifyUpstreamStatus(kind: ToolChannelKind, status: number): ToolUpstreamFailure | 'ok' {
  if (status >= 200 && status < 300) return 'ok'
  // 3xx：拒绝重定向（fetch 用 redirect: 'manual'），按上游故障换候选
  if (status >= 300 && status < 400) return 'upstream'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limit'
  // Tavily 计划额度用完（432）/ 按量上限（433）：冷却到下个月 1 日 UTC
  if (kind === 'tavily' && (status === 432 || status === 433)) return 'exhausted'
  if (status >= 500) return 'upstream'
  if (status >= 400) return 'client'
  return 'upstream'
}

/** 下个月 1 日 00:00 UTC（Tavily 额度用完后的冷却时刻，14 §3.1） */
export function nextMonthFirstUtcIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// ── DeepSeek（原样转发）────────────────────────────────────────────────────

export function buildDeepSeekSearchRequest(
  query: string,
  count: number,
  oriQuestion?: string | undefined,
): Record<string, unknown> {
  return {
    query,
    count,
    need_content: false,
    ...(oriQuestion === undefined || oriQuestion.length === 0 ? {} : { ori_question: oriQuestion }),
  }
}

/** 校验 DeepSeek Search 响应（字段类型必须与 DSH 的 `mapSearchResponse` 一致，14 §1） */
export function parseDeepSeekSearchResponse(payload: unknown): ToolUpstreamResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new ToolUpstreamError('upstream', '上游响应格式不对（缺少 results 数组）')
  }
  const results: { url: string; title: string; snippet: string; date: string | null }[] = []
  for (const item of payload.results) {
    if (!isRecord(item)) throw new ToolUpstreamError('upstream', '上游响应格式不对（结果项不是对象）')
    const url = asString(item.url)
    const title = asString(item.title)
    const snippet = asString(item.snippet)
    const date = item.date === null || item.date === undefined ? null : asString(item.date)
    if (url === null || url.length === 0 || title === null || snippet === null) {
      throw new ToolUpstreamError('upstream', '上游响应格式不对（url/title/snippet 类型不符）')
    }
    if (item.date !== null && item.date !== undefined && date === null) {
      throw new ToolUpstreamError('upstream', '上游响应格式不对（date 不是字符串）')
    }
    results.push({ url, title, snippet, date })
  }
  return { tool: 'search', results }
}

/** 校验 DeepSeek Fetch 响应（`{content: string}`，14 §1） */
export function parseDeepSeekFetchResponse(payload: unknown): ToolUpstreamResult {
  if (!isRecord(payload) || typeof payload.content !== 'string') {
    throw new ToolUpstreamError('upstream', '上游响应格式不对（缺少 content 字符串）')
  }
  return { tool: 'fetch', content: payload.content }
}

// ── Tavily（请求/响应适配）─────────────────────────────────────────────────

export function buildTavilySearchRequest(query: string, count: number): Record<string, unknown> {
  return {
    query,
    max_results: Math.min(count, TOOL_MAX_COUNT),
    search_depth: 'basic',
    include_answer: false,
  }
}

/**
 * Tavily search → DeepSeek 格式。
 * `content` 缺失用空串、`published_date` 缺失/非字符串用 null（14 §3.1）。
 */
export function parseTavilySearchResponse(payload: unknown): ToolUpstreamResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new ToolUpstreamError('upstream', '上游响应格式不对（缺少 results 数组）')
  }
  const results: { url: string; title: string; snippet: string; date: string | null }[] = []
  for (const item of payload.results) {
    if (!isRecord(item)) continue
    const url = asString(item.url)
    // 没有 url 的结果对 DSH 没用（url 必须非空字符串），跳过而不是让整次调用失败
    if (url === null || url.length === 0) continue
    results.push({
      url,
      title: asString(item.title) ?? '',
      snippet: asString(item.content) ?? '',
      date: asString(item.published_date),
    })
  }
  return { tool: 'search', results }
}

export function buildTavilyFetchRequest(url: string): Record<string, unknown> {
  return { urls: [url], format: 'markdown', extract_depth: 'basic' }
}

/**
 * Tavily extract → DeepSeek 格式。
 * `failed_results` 含该 URL 或 `results` 为空 = 目标页面抓不到 → **client**（不换候选、不计费）。
 */
export function parseTavilyFetchResponse(payload: unknown, url: string): ToolUpstreamResult {
  if (!isRecord(payload)) throw new ToolUpstreamError('upstream', '上游响应格式不对（不是对象）')
  const failed = Array.isArray(payload.failed_results) ? payload.failed_results : []
  for (const item of failed) {
    if (isRecord(item) && asString(item.url) === url) {
      const reason = asString(item.error) ?? '目标页面抓不到'
      throw new ToolUpstreamError('client', `目标页面抓不到：${reason}`)
    }
  }
  const results = Array.isArray(payload.results) ? payload.results : null
  if (results === null) throw new ToolUpstreamError('upstream', '上游响应格式不对（缺少 results 数组）')
  const first = results[0]
  if (!isRecord(first)) throw new ToolUpstreamError('client', '目标页面抓不到：上游没有返回内容')
  const content = asString(first.raw_content)
  if (content === null || content.length === 0) {
    throw new ToolUpstreamError('client', '目标页面抓不到：上游没有返回内容')
  }
  return { tool: 'fetch', content }
}

// ── 请求解析（DeepSeek 格式，14 §3.1）──────────────────────────────────────

export interface ParsedSearchRequest {
  query: string
  count: number
  oriQuestion: string | undefined
}

export interface ParsedFetchRequest {
  url: string
}

export class ToolRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolRequestError'
  }
}

/** 校验 `/v1/tools/search` 请求体（DSH 的 DeepSeek 格式） */
export function parseSearchRequest(body: Record<string, unknown>): ParsedSearchRequest {
  const query = body.query
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new ToolRequestError('query 必须是非空字符串')
  }
  const rawCount = body.count
  let count = TOOL_DEFAULT_COUNT
  if (rawCount !== undefined && rawCount !== null) {
    if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 1) {
      throw new ToolRequestError('count 必须是 1 到 50 的整数')
    }
    if (rawCount > TOOL_ACCEPT_COUNT) throw new ToolRequestError('count 必须是 1 到 50 的整数')
    count = Math.min(rawCount, TOOL_MAX_COUNT)
  }
  const oriQuestion = typeof body.ori_question === 'string' ? body.ori_question : undefined
  return { query, count, oriQuestion }
}

/** 校验 `/v1/tools/fetch` 请求体 */
export function parseFetchRequest(body: Record<string, unknown>): ParsedFetchRequest {
  const url = body.url
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new ToolRequestError('url 必须是非空字符串')
  }
  const trimmed = url.trim()
  if (!/^https?:\/\//u.test(trimmed)) throw new ToolRequestError('url 必须是 http(s) 地址')
  return { url: trimmed }
}

/** 记进 `relay_tool_usage.summary` 的摘要（搜索词前 64 字 / URL 前 200 字，14 §4） */
export function usageSummary(tool: ToolKind, value: string): string {
  const limit = tool === 'search' ? 64 : 200
  return value.length <= limit ? value : value.slice(0, limit)
}

/** 一次上游调用的请求（由 service 组装 URL/头，body 由适配器给） */
export interface ToolUpstreamRequest {
  path: string
  body: Record<string, unknown>
  parse: (payload: unknown) => ToolUpstreamResult
}

/** 按渠道类型与工具组装上游请求（纯函数；鉴权头由 service 加） */
export function buildUpstreamRequest(
  kind: ToolChannelKind,
  tool: ToolKind,
  parsed: { search?: ParsedSearchRequest; fetch?: ParsedFetchRequest },
): ToolUpstreamRequest {
  if (tool === 'search') {
    const search = parsed.search
    if (!search) throw new ToolRequestError('缺少搜索参数')
    if (kind === 'tavily') {
      return {
        path: '/search',
        body: buildTavilySearchRequest(search.query, search.count),
        parse: parseTavilySearchResponse,
      }
    }
    return {
      path: '/search',
      body: buildDeepSeekSearchRequest(search.query, search.count, search.oriQuestion),
      parse: parseDeepSeekSearchResponse,
    }
  }
  const fetchRequest = parsed.fetch
  if (!fetchRequest) throw new ToolRequestError('缺少抓取参数')
  if (kind === 'tavily') {
    return {
      path: '/extract',
      body: buildTavilyFetchRequest(fetchRequest.url),
      parse: (payload) => parseTavilyFetchResponse(payload, fetchRequest.url),
    }
  }
  return {
    path: '/fetch',
    body: { url: fetchRequest.url },
    parse: parseDeepSeekFetchResponse,
  }
}
