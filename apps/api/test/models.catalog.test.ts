import { describe, expect, it } from 'vitest'
import { BUILTIN_CATALOG } from '../src/modules/models/catalog-data.js'
import { createCatalogMatcher, normalizeModelKey, normalizeModelName } from '../src/modules/models/catalog.js'

/** 模型信息库的匹配（纯函数）：规范化、精确匹配、自定义覆盖内置。 */

describe('模型名规范化', () => {
  it('小写、去厂商路径前缀、去 :后缀、. _ 统一成 -', () => {
    expect(normalizeModelKey('DeepSeek/DeepSeek-Chat:free')).toBe('deepseek-chat')
    expect(normalizeModelKey('accounts/fireworks/models/Llama-3.1-70B')).toBe('llama-3-1-70b')
    expect(normalizeModelKey('deepseek-v4.1-flash')).toBe('deepseek-v4-1-flash')
    expect(normalizeModelKey('qwen_max')).toBe('qwen-max')
  })

  it('去掉日期后缀和 -latest，但不动四位的版本号', () => {
    expect(normalizeModelKey('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(normalizeModelKey('gpt-4o-2024-08-06')).toBe('gpt-4o')
    expect(normalizeModelKey('claude-3-5-sonnet-latest')).toBe('claude-3-5-sonnet')
    expect(normalizeModelKey('deepseek-v4-flash-0731')).toBe('deepseek-v4-flash-0731')
  })

  it('显示名：括号和空格也归一，`/` `:` 不当作路径或后缀', () => {
    expect(normalizeModelName('DeepSeek V4.1 Flash')).toBe('deepseek-v4-1-flash')
    expect(normalizeModelName('Claude Sonnet 4.5 (latest)')).toBe('claude-sonnet-4-5')
    expect(normalizeModelName('DeepSeek: DeepSeek V3')).toBe('deepseek-deepseek-v3')
  })

  it('空白 / 纯符号规范化后为空', () => {
    expect(normalizeModelKey('  ')).toBe('')
    expect(normalizeModelKey('///')).toBe('')
  })
})

describe('内置库匹配', () => {
  const matcher = createCatalogMatcher([])

  it('内置库规模合理，每条都有容量', () => {
    expect(BUILTIN_CATALOG.length).toBeGreaterThan(500)
    for (const item of BUILTIN_CATALOG) {
      expect(item.contextWindow).toBeGreaterThan(0)
      expect(item.maxTokens).toBeGreaterThan(0)
    }
  })

  it('deepseek-v4.1-flash：命中并带出容量、图片输入、三档思考', () => {
    const hit = matcher.match('deepseek-v4.1-flash')
    expect(hit).not.toBeNull()
    expect(hit!.source).toBe('builtin')
    expect(hit!.info.contextWindow).toBeGreaterThanOrEqual(1_000_000)
    expect(hit!.info.input).toEqual(['text', 'image'])
    expect(hit!.info.reasoningEfforts).toEqual(expect.arrayContaining(['low', 'high', 'max']))
  })

  it('官方 id 与另一种写法（显示名）都能对上同一个模型', () => {
    // DeepSeek 官方 id 是 deepseek-flash，显示名 "DeepSeek V4.1 Flash"
    const byId = matcher.match('deepseek-flash')
    expect(byId?.info.reasoningEfforts).toEqual(['off', 'low', 'high', 'max'])
    const viaPrefix = matcher.match('deepseek/deepseek-v4.1-flash:free')
    expect(viaPrefix).not.toBeNull()
  })

  it('带厂商前缀和日期后缀的写法也能命中', () => {
    expect(matcher.match('anthropic/claude-sonnet-4-5-20250929')?.matchedId).toBeTruthy()
  })

  it('不做前缀 / 模糊匹配：未知变体不会落到相近的模型头上', () => {
    expect(matcher.match('gpt-4o-mini-totally-made-up')).toBeNull()
    expect(matcher.match('deepseek')).toBeNull()
    expect(matcher.match('')).toBeNull()
  })

  it('非推理模型不带思考档位', () => {
    const hit = matcher.match('gpt-4o')
    if (hit) expect(hit.info.reasoningEfforts).toBeUndefined()
  })
})

describe('自定义条目', () => {
  const custom = [{ id: 'My-Relay/deepseek-v4.1-flash', maxTokens: 64_000, name: '中转 Flash' }]
  const matcher = createCatalogMatcher(custom)

  it('自定义覆盖内置同名字段，没写的字段用内置补', () => {
    const hit = matcher.match('deepseek-v4.1-flash')
    expect(hit?.source).toBe('custom')
    expect(hit?.matchedId).toBe('My-Relay/deepseek-v4.1-flash')
    expect(hit?.info.maxTokens).toBe(64_000)
    expect(hit?.info.name).toBe('中转 Flash')
    expect(hit?.info.contextWindow).toBeGreaterThanOrEqual(1_000_000)
    expect(hit?.info.input).toEqual(['text', 'image'])
  })

  it('只有自定义有的模型也能命中', () => {
    const only = createCatalogMatcher([{ id: 'in-house-llm', contextWindow: 32_768, input: ['text'] }], [])
    expect(only.match('IN_HOUSE_LLM')).toMatchObject({
      source: 'custom',
      info: { contextWindow: 32_768, input: ['text'] },
    })
  })

  it('同键先到先得（列表顺序 = 优先级）', () => {
    const matcherWithDup = createCatalogMatcher(
      [
        { id: 'a/x-model', contextWindow: 1000 },
        { id: 'x-model', contextWindow: 2000 },
      ],
      [],
    )
    expect(matcherWithDup.match('x-model')?.info.contextWindow).toBe(1000)
  })
})
