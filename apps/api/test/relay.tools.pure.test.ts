import { describe, expect, it } from 'vitest'
import {
  ToolRequestError,
  ToolUpstreamError,
  buildDeepSeekSearchRequest,
  buildTavilyFetchRequest,
  buildTavilySearchRequest,
  classifyUpstreamStatus,
  nextMonthFirstUtcIso,
  parseDeepSeekFetchResponse,
  parseDeepSeekSearchResponse,
  parseFetchRequest,
  parseSearchRequest,
  parseTavilyFetchResponse,
  parseTavilySearchResponse,
  usageSummary,
} from '../src/modules/relay/tools/adapters.js'
import { planToolCandidates, type ToolRouterChannel } from '../src/modules/relay/tools/router.js'

/**
 * 搜索池纯函数单测（WP18a，任务书 §5）：Tavily 适配（缺失字段、failed_results）、
 * DeepSeek 响应校验（字段类型与 DSH 的 `mapSearchResponse` 一致）、上游结果分类、
 * 冷却时刻、候选排序、请求校验、摘要截断。
 */

describe('adapters：Tavily 搜索适配', () => {
  it('请求按 14 §3.1 的字段；count 截到 20', () => {
    expect(buildTavilySearchRequest('你好', 5)).toEqual({
      query: '你好',
      max_results: 5,
      search_depth: 'basic',
      include_answer: false,
    })
    expect(buildTavilySearchRequest('你好', 50).max_results).toBe(20)
  })

  it('响应映射：content 缺失用空串、published_date 缺失用 null', () => {
    const result = parseTavilySearchResponse({
      results: [
        { title: 'A', url: 'https://a.test', score: 0.9 },
        { title: 'B', url: 'https://b.test', content: '内容', published_date: '2026-01-02' },
        { title: 'C', url: 'https://c.test', content: 123, published_date: 5 },
      ],
    })
    expect(result).toEqual({
      tool: 'search',
      results: [
        { url: 'https://a.test', title: 'A', snippet: '', date: null },
        { url: 'https://b.test', title: 'B', snippet: '内容', date: '2026-01-02' },
        { url: 'https://c.test', title: 'C', snippet: '', date: null },
      ],
    })
  })

  it('没有 url 的结果被跳过；没有 results 数组算上游故障', () => {
    const result = parseTavilySearchResponse({
      results: [{ title: 'no url' }, { title: 'ok', url: 'https://a.test', content: 'x' }],
    })
    expect(result.tool === 'search' && result.results.length).toBe(1)
    expect(() => parseTavilySearchResponse({ foo: 1 })).toThrow(ToolUpstreamError)
  })
})

describe('adapters：Tavily 抓取适配', () => {
  it('请求格式', () => {
    expect(buildTavilyFetchRequest('https://a.test')).toEqual({
      urls: ['https://a.test'],
      format: 'markdown',
      extract_depth: 'basic',
    })
  })

  it('failed_results 含目标 URL → client（不换候选、不计费）', () => {
    try {
      parseTavilyFetchResponse(
        { results: [], failed_results: [{ url: 'https://a.test', error: '403' }] },
        'https://a.test',
      )
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ToolUpstreamError)
      expect((error as ToolUpstreamError).failure).toBe('client')
      expect((error as Error).message).toContain('403')
    }
  })

  it('results 为空 → client；raw_content 缺失 → client', () => {
    expect(() => parseTavilyFetchResponse({ results: [], failed_results: [] }, 'https://a.test')).toThrow(
      ToolUpstreamError,
    )
    try {
      parseTavilyFetchResponse({ results: [{ url: 'https://a.test' }] }, 'https://a.test')
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ToolUpstreamError).failure).toBe('client')
    }
  })

  it('成功 → {content}', () => {
    expect(
      parseTavilyFetchResponse(
        { results: [{ url: 'https://a.test', raw_content: '# 标题' }], failed_results: [] },
        'https://a.test',
      ),
    ).toEqual({ tool: 'fetch', content: '# 标题' })
  })
})

describe('adapters：DeepSeek 原样转发与响应校验', () => {
  it('搜索请求字段（ori_question 省略时不带）', () => {
    expect(buildDeepSeekSearchRequest('q', 3)).toEqual({ query: 'q', count: 3, need_content: false })
    expect(buildDeepSeekSearchRequest('q', 3, 'orig')).toMatchObject({ ori_question: 'orig' })
  })

  it('搜索响应字段类型必须与 DSH 一致', () => {
    expect(
      parseDeepSeekSearchResponse({ results: [{ url: 'https://a', title: 't', snippet: 's', date: null }] }),
    ).toEqual({ tool: 'search', results: [{ url: 'https://a', title: 't', snippet: 's', date: null }] })
    // url 空串 / title 非字符串 / date 非字符串/null 都是上游故障
    for (const bad of [
      { results: [{ url: '', title: 't', snippet: 's', date: null }] },
      { results: [{ url: 'https://a', title: 1, snippet: 's', date: null }] },
      { results: [{ url: 'https://a', title: 't', snippet: 's', date: 5 }] },
      { results: 'x' },
      { nope: true },
    ]) {
      expect(() => parseDeepSeekSearchResponse(bad)).toThrow(ToolUpstreamError)
    }
  })

  it('抓取响应必须是 {content: string}', () => {
    expect(parseDeepSeekFetchResponse({ content: 'x' })).toEqual({ tool: 'fetch', content: 'x' })
    expect(() => parseDeepSeekFetchResponse({ content: 1 })).toThrow(ToolUpstreamError)
    expect(() => parseDeepSeekFetchResponse({})).toThrow(ToolUpstreamError)
  })
})

describe('adapters：上游结果分类（14 §3.1 的表）', () => {
  it('deepseek', () => {
    expect(classifyUpstreamStatus('deepseek', 200)).toBe('ok')
    expect(classifyUpstreamStatus('deepseek', 302)).toBe('upstream')
    expect(classifyUpstreamStatus('deepseek', 401)).toBe('unauthorized')
    expect(classifyUpstreamStatus('deepseek', 403)).toBe('unauthorized')
    expect(classifyUpstreamStatus('deepseek', 429)).toBe('rate-limit')
    expect(classifyUpstreamStatus('deepseek', 432)).toBe('client')
    expect(classifyUpstreamStatus('deepseek', 400)).toBe('client')
    expect(classifyUpstreamStatus('deepseek', 404)).toBe('client')
    expect(classifyUpstreamStatus('deepseek', 500)).toBe('upstream')
    expect(classifyUpstreamStatus('deepseek', 503)).toBe('upstream')
  })

  it('tavily 432/433 是额度用完', () => {
    expect(classifyUpstreamStatus('tavily', 432)).toBe('exhausted')
    expect(classifyUpstreamStatus('tavily', 433)).toBe('exhausted')
    expect(classifyUpstreamStatus('tavily', 429)).toBe('rate-limit')
  })

  it('冷却时刻 = 下个月 1 日 00:00 UTC（跨年也对）', () => {
    expect(nextMonthFirstUtcIso(new Date('2026-10-18T05:00:00.000Z'))).toBe('2026-11-01T00:00:00.000Z')
    expect(nextMonthFirstUtcIso(new Date('2026-12-31T23:59:59.000Z'))).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('adapters：请求体校验与摘要', () => {
  it('搜索请求', () => {
    expect(parseSearchRequest({ query: 'hi' })).toEqual({ query: 'hi', count: 10, oriQuestion: undefined })
    expect(parseSearchRequest({ query: 'hi', count: 50 }).count).toBe(20)
    expect(parseSearchRequest({ query: 'hi', count: 3, ori_question: 'x' }).oriQuestion).toBe('x')
    for (const bad of [
      {},
      { query: '' },
      { query: 'x', count: 0 },
      { query: 'x', count: 51 },
      { query: 'x', count: 1.5 },
    ]) {
      expect(() => parseSearchRequest(bad)).toThrow(ToolRequestError)
    }
  })

  it('抓取请求', () => {
    expect(parseFetchRequest({ url: 'https://a.test/x' })).toEqual({ url: 'https://a.test/x' })
    for (const bad of [{}, { url: '' }, { url: 'ftp://a' }, { url: 3 }]) {
      expect(() => parseFetchRequest(bad)).toThrow(ToolRequestError)
    }
  })

  it('摘要截断：搜索 64 字 / URL 200 字', () => {
    expect(usageSummary('search', 'a'.repeat(100))).toHaveLength(64)
    expect(usageSummary('fetch', 'b'.repeat(300))).toHaveLength(200)
    expect(usageSummary('search', 'short')).toBe('short')
  })
})

describe('router：候选排序（14 §2）', () => {
  function channel(overrides: Partial<ToolRouterChannel> & { channelId: number }): ToolRouterChannel {
    return {
      channelName: `ch${String(overrides.channelId)}`,
      kind: 'deepseek',
      priority: 0,
      weight: 1,
      channelEnabled: true,
      channelCooldownUntil: null,
      tools: ['search', 'fetch'],
      keys: [{ keyId: overrides.channelId * 10, state: 'active', cooldownUntil: null }],
      ...overrides,
    }
  }

  const now = '2026-10-18T00:00:00.000Z'

  it('优先级降序，同级按会合哈希稳定分流', () => {
    const channels = [
      channel({ channelId: 1, priority: 0 }),
      channel({ channelId: 2, priority: 10 }),
      channel({ channelId: 3, priority: 5 }),
    ]
    const first = planToolCandidates({ tool: 'search', stickyKey: 'tools:7', channels, now, maxAttempts: 3 })
    const second = planToolCandidates({ tool: 'search', stickyKey: 'tools:7', channels, now, maxAttempts: 3 })
    expect(first).toEqual(second)
    expect(first.kind === 'ok' && first.candidates.map((c) => c.channelId)).toEqual([2, 3, 1])
  })

  it('不支持该工具 / 停用 / 无可用密钥的渠道被跳过', () => {
    const channels = [
      channel({ channelId: 1, tools: ['fetch'] }),
      channel({ channelId: 2, channelEnabled: false }),
      channel({ channelId: 3, keys: [{ keyId: 30, state: 'disabled', cooldownUntil: null }] }),
      channel({ channelId: 4 }),
    ]
    const outcome = planToolCandidates({
      tool: 'search',
      stickyKey: 'tools:7',
      channels,
      now,
      maxAttempts: 3,
    })
    expect(outcome.kind === 'ok' && outcome.candidates.map((c) => c.channelId)).toEqual([4])
  })

  it('冷却中的渠道沉底但仍作为兜底候选；全部不可用 = no_available_channel', () => {
    const channels = [
      channel({ channelId: 1, priority: 100, channelCooldownUntil: '2026-10-18T00:05:00.000Z' }),
      channel({ channelId: 2, priority: 0 }),
    ]
    const outcome = planToolCandidates({
      tool: 'search',
      stickyKey: 'tools:7',
      channels,
      now,
      maxAttempts: 3,
    })
    expect(outcome.kind === 'ok' && outcome.candidates.map((c) => c.channelId)).toEqual([2, 1])
    expect(
      planToolCandidates({
        tool: 'search',
        stickyKey: 'tools:7',
        channels: [channel({ channelId: 9, keys: [] })],
        now,
        maxAttempts: 3,
      }).kind,
    ).toBe('no_available_channel')
  })

  it('maxAttempts 截断，且展开「渠道 × 密钥」', () => {
    const channels = [
      channel({
        channelId: 1,
        priority: 10,
        keys: [
          { keyId: 11, state: 'active', cooldownUntil: null },
          { keyId: 12, state: 'active', cooldownUntil: null },
        ],
      }),
      channel({ channelId: 2, priority: 5 }),
    ]
    const outcome = planToolCandidates({
      tool: 'search',
      stickyKey: 'tools:7',
      channels,
      now,
      maxAttempts: 2,
    })
    expect(outcome.kind === 'ok' && outcome.candidates).toHaveLength(2)
    expect(outcome.kind === 'ok' && outcome.candidates.every((c) => c.channelId === 1)).toBe(true)
  })

  it('冷却到期的密钥重新可用', () => {
    const channels = [
      channel({
        channelId: 1,
        keys: [{ keyId: 11, state: 'active', cooldownUntil: '2026-10-17T23:00:00.000Z' }],
      }),
    ]
    const outcome = planToolCandidates({
      tool: 'search',
      stickyKey: 'tools:7',
      channels,
      now,
      maxAttempts: 3,
    })
    expect(outcome.kind === 'ok' && outcome.candidates).toHaveLength(1)
  })
})
