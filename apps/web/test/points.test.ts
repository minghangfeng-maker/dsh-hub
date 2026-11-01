import { describe, expect, it } from 'vitest'

import {
  formatPoints,
  formatPrice,
  formatTokenPair,
  formatTokensZh,
  microToPoints,
  microToPointsInput,
  pointsToMicro,
} from '@/utils/points'

/**
 * 金额与价格工具（WP10b 交付物 1，12 §6.1 §10）：
 * 微积分 ↔ 积分、价格显示、token 中文单位的全部分支。
 */
describe('formatPoints：微积分 → 积分文本（12 §10）', () => {
  it('0 与空值', () => {
    expect(formatPoints(0)).toBe('0')
    expect(formatPoints(null)).toBe('—')
    expect(formatPoints(undefined)).toBe('—')
    expect(formatPoints(Number.NaN)).toBe('—')
  })

  it('≥ 1 积分：两位小数 + zh-CN 千分位', () => {
    expect(formatPoints(1_000_000)).toBe('1.00')
    expect(formatPoints(12_350_000)).toBe('12.35')
    expect(formatPoints(12_345_678)).toBe('12.35')
    expect(formatPoints(1_234_500_000)).toBe('1,234.50')
    expect(formatPoints(100_000_000_000)).toBe('100,000.00')
  })

  it('0 < x < 1 积分：最多 4 位小数、去掉多余的 0', () => {
    expect(formatPoints(500_000)).toBe('0.5')
    expect(formatPoints(50_000)).toBe('0.05')
    expect(formatPoints(12_300)).toBe('0.0123')
    expect(formatPoints(12_345)).toBe('0.0123')
    expect(formatPoints(100)).toBe('0.0001')
  })

  it('极小值与四舍五入到 1 的边界', () => {
    expect(formatPoints(10)).toBe('<0.0001')
    expect(formatPoints(1)).toBe('<0.0001')
    expect(formatPoints(999_999)).toBe('0.999999')
  })

  it('负数带 -（余额可能为负）', () => {
    expect(formatPoints(-120_000)).toBe('-0.12')
    expect(formatPoints(-12_350_000)).toBe('-12.35')
    expect(formatPoints(-1_234_500_000)).toBe('-1,234.50')
    expect(formatPoints(-10)).toBe('-<0.0001')
  })
})

describe('pointsToMicro / microToPoints：积分 ↔ 微积分', () => {
  it('整数与小数（最多 6 位小数）', () => {
    expect(pointsToMicro('12.35')).toBe(12_350_000)
    expect(pointsToMicro('0.000001')).toBe(1)
    expect(pointsToMicro('0')).toBe(0)
    expect(pointsToMicro(' 1,234.5 ')).toBe(1_234_500_000)
    expect(pointsToMicro(-0.12)).toBe(-120_000)
    expect(pointsToMicro(7)).toBe(7_000_000)
    expect(pointsToMicro('.5')).toBe(500_000)
  })

  it('超过 6 位小数：四舍五入到整数微积分', () => {
    expect(pointsToMicro('0.0000004')).toBe(0)
    expect(pointsToMicro('0.0000005')).toBe(1)
    expect(pointsToMicro('12.3456789')).toBe(12_345_679)
  })

  it('非法输入返回 null', () => {
    expect(pointsToMicro('')).toBeNull()
    expect(pointsToMicro('  ')).toBeNull()
    expect(pointsToMicro('abc')).toBeNull()
    expect(pointsToMicro('1.2.3')).toBeNull()
    expect(pointsToMicro('12%')).toBeNull()
    expect(pointsToMicro(Number.POSITIVE_INFINITY)).toBeNull()
    expect(pointsToMicro(Number.NaN)).toBeNull()
    expect(pointsToMicro(null)).toBeNull()
    expect(pointsToMicro(undefined)).toBeNull()
  })

  it('microToPoints / microToPointsInput', () => {
    expect(microToPoints(12_350_000)).toBe(12.35)
    expect(microToPoints(1)).toBe(0.000001)
    expect(microToPoints(null)).toBeNull()
    expect(microToPoints(Number.NaN)).toBeNull()

    expect(microToPointsInput(12_350_000)).toBe('12.35')
    expect(microToPointsInput(1_000_000)).toBe('1')
    expect(microToPointsInput(0)).toBe('0')
    expect(microToPointsInput(-120_000)).toBe('-0.12')
    expect(microToPointsInput(null)).toBe('')
  })
})

describe('formatPrice：微积分 / 百万 token → 积分（去掉多余的 0）', () => {
  it('整数与小数', () => {
    expect(formatPrice(2_000_000)).toBe('2')
    expect(formatPrice(500_000)).toBe('0.5')
    expect(formatPrice(12_800_000)).toBe('12.8')
    expect(formatPrice(100_000)).toBe('0.1')
    expect(formatPrice(1)).toBe('0.000001')
    expect(formatPrice(0)).toBe('0')
  })

  it('空值', () => {
    expect(formatPrice(null)).toBe('—')
    expect(formatPrice(undefined)).toBe('—')
    expect(formatPrice(Number.NaN)).toBe('—')
  })
})

describe('formatTokensZh：中文单位的 token 数', () => {
  it('万 / 亿 与精确值', () => {
    expect(formatTokensZh(0)).toBe('0')
    expect(formatTokensZh(9_876)).toBe('9,876')
    expect(formatTokensZh(12_000)).toBe('1.2万')
    expect(formatTokensZh(10_000)).toBe('1万')
    expect(formatTokensZh(345_000_000)).toBe('3.5亿')
    expect(formatTokensZh(100_000_000)).toBe('1亿')
    expect(formatTokensZh(1_234_567_890)).toBe('12.3亿')
  })

  it('空值与成对展示', () => {
    expect(formatTokensZh(null)).toBe('—')
    expect(formatTokenPair(12_000, 345_000_000)).toBe('1.2万 / 3.5亿')
  })
})
