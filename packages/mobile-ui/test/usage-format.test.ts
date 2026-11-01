import { describe, expect, it } from 'vitest'
import { cacheHitRate, cacheHitRateText, formatCacheHitRate, formatPointsMicro } from '../src/lib/usage-format.js'

describe('缓存命中率', () => {
  it('命中 ÷（输入 + 命中）', () => {
    // 真实一条 assistant/message 的 usage：in 5961 + cacheRead 7168 → 55.1%
    expect(cacheHitRate({ inputTokens: 5961, cacheReadTokens: 7168 })).toBeCloseTo(0.546, 3)
    expect(cacheHitRateText({ inputTokens: 5961, cacheReadTokens: 7168 })).toBe('54.6%')
  })

  it('一位小数：123456 / (123456+98765) → 44.4%', () => {
    expect(cacheHitRateText({ inputTokens: 123456, cacheReadTokens: 98765 })).toBe('44.4%')
    expect(cacheHitRateText({ inputTokens: 0, cacheReadTokens: 100 })).toBe('100.0%')
    expect(cacheHitRateText({ inputTokens: 100, cacheReadTokens: 0 })).toBe('0.0%')
  })

  it('空会话 / 无 prompt token → null，文案为 —（不除零、不假装 0%）', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull()
    expect(cacheHitRate(null)).toBeNull()
    expect(cacheHitRate(undefined)).toBeNull()
    expect(formatCacheHitRate(null)).toBe('—')
    expect(cacheHitRateText({ inputTokens: 0, cacheReadTokens: 0 })).toBe('—')
  })

  it('非法数字 → null / —', () => {
    expect(cacheHitRate({ inputTokens: Number.NaN, cacheReadTokens: 10 })).toBeNull()
    expect(cacheHitRate({ inputTokens: -5, cacheReadTokens: 0 })).toBeNull()
    expect(formatCacheHitRate(Number.NaN)).toBe('—')
  })

  it('比率钳制在 0..1（异常数据防御）', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 10 })).toBe(1)
    expect(cacheHitRate({ inputTokens: 10, cacheReadTokens: 0 })).toBe(0)
  })
})

describe('积分消耗（微积分 → 积分）', () => {
  it('1 积分 = 1e6 微积分；≥1 两位小数 + 千分位', () => {
    expect(formatPointsMicro(1_000_000)).toBe('1.00')
    expect(formatPointsMicro(12_345_678)).toBe('12.35')
    expect(formatPointsMicro(1_234_500_000)).toBe('1,234.50')
  })

  it('小于 1 积分：最多 4 位小数去掉多余 0；过小显示 <0.0001', () => {
    expect(formatPointsMicro(250_000)).toBe('0.25')
    expect(formatPointsMicro(123_400)).toBe('0.1234')
    expect(formatPointsMicro(343)).toBe('0.0003')
    expect(formatPointsMicro(100)).toBe('0.0001')
    expect(formatPointsMicro(1)).toBe('<0.0001')
  })

  it('0 / 未知 / 非法数字', () => {
    expect(formatPointsMicro(0)).toBe('0')
    expect(formatPointsMicro(null)).toBe('—')
    expect(formatPointsMicro(undefined)).toBe('—')
    expect(formatPointsMicro(Number.NaN)).toBe('—')
  })
})
