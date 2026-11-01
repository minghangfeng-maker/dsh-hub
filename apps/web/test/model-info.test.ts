import { describe, expect, it } from 'vitest'

import {
  fillMissing,
  formatTokens,
  hasModelInfo,
  modelInfoSummary,
  normalizeInputs,
  toCatalogInput,
} from '@/components/admin/model-info'

describe('token 紧凑写法', () => {
  it('整 K / 整 M 用单位，其它保留千分位', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_048_576)).toBe('1M')
    expect(formatTokens(131_072)).toBe('128K')
    expect(formatTokens(384_000)).toBe('384K')
    expect(formatTokens(64_000)).toBe('64K')
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(32_768)).toBe('32K')
    expect(formatTokens(262_144)).toBe('256K')
    expect(formatTokens(4_242)).toBe('4,242')
  })
})

describe('输入类型', () => {
  it('固定顺序、去重、丢掉不认识的；空 → undefined', () => {
    expect(normalizeInputs(['image', 'text', 'image', 'audio'])).toEqual(['text', 'image'])
    expect(normalizeInputs([])).toBeUndefined()
    expect(normalizeInputs(undefined)).toBeUndefined()
    expect(normalizeInputs(['audio'])).toBeUndefined()
  })
})

describe('摘要与判断', () => {
  it('摘要按「上下文 · 输出 · 输入 · 思考」拼，没有的字段跳过', () => {
    expect(
      modelInfoSummary({
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        input: ['text', 'image'],
        reasoningEfforts: ['off', 'low', 'high', 'max'],
      }),
    ).toBe('1M 上下文 · 384K 输出 · 文字+图片 · 思考 off/low/high/max')
    expect(modelInfoSummary({ maxTokens: 8192 })).toBe('8K 输出')
    expect(modelInfoSummary({})).toBe('')
  })

  it('hasModelInfo：任一参数有值就算有', () => {
    expect(hasModelInfo({})).toBe(false)
    expect(hasModelInfo({ input: [] })).toBe(false)
    expect(hasModelInfo({ maxTokens: 1 })).toBe(true)
    expect(hasModelInfo({ input: ['text'] })).toBe(true)
  })
})

describe('按库补全空缺', () => {
  const info = {
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text', 'image'] as ('text' | 'image')[],
    reasoningEfforts: ['off', 'low', 'high', 'max'],
  }

  it('空模型：全部补上，显示名 = id 时换成库里的名字', () => {
    expect(fillMissing({ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }, info)).toEqual({
      id: 'deepseek-v4.1-flash',
      ...info,
    })
  })

  it('已经填过的字段（包括自定义显示名）不会被覆盖', () => {
    const filled = fillMissing(
      { id: 'flash', name: '我的 Flash', maxTokens: 64_000, reasoningEfforts: ['low', 'high', 'max'] },
      info,
    )
    expect(filled).toMatchObject({
      name: '我的 Flash',
      maxTokens: 64_000,
      reasoningEfforts: ['low', 'high', 'max'],
      contextWindow: 1_000_000,
      input: ['text', 'image'],
    })
  })

  it('没有任何变化时返回同一个对象', () => {
    const model = {
      id: 'x',
      name: 'Custom',
      contextWindow: 1,
      maxTokens: 2,
      input: ['text' as const],
      reasoningEfforts: ['low'],
    }
    expect(fillMissing(model, info)).toBe(model)
    expect(fillMissing(model, {})).toBe(model)
    // 显示名 = id 时会换成库里的名字，这算一次变化
    expect(fillMissing({ ...model, name: 'x' }, info)).not.toBe(model)
  })

  it('补进去的数组是拷贝，不会和库共用引用', () => {
    const filled = fillMissing({ id: 'x', name: 'x' }, info)
    expect(filled.input).not.toBe(info.input)
    expect(filled.reasoningEfforts).not.toBe(info.reasoningEfforts)
  })
})

describe('存进模型库的条目', () => {
  it('只带填了的字段；显示名和 id 一样时不存', () => {
    expect(toCatalogInput({ id: ' flash ', name: ' flash '.trim(), maxTokens: 64_000 })).toEqual({
      id: 'flash',
      maxTokens: 64_000,
    })
    expect(
      toCatalogInput({ id: 'flash', name: 'Flash', input: ['text'], reasoningEfforts: ['low', 'high'] }),
    ).toEqual({ id: 'flash', name: 'Flash', input: ['text'], reasoningEfforts: ['low', 'high'] })
  })
})
