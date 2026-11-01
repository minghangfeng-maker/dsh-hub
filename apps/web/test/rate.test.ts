import { describe, expect, it } from 'vitest'

import {
  applyRate,
  formatRate,
  formatRatedPrice,
  isRatedRange,
  permilleToRateInput,
  rateToPermille,
} from '@/utils/rate'

/**
 * 渠道倍率工具（WP11b 交付物 2）：界面小数 ↔ 接口千分比、显示格式、实际价格。
 * 这里是纯函数，所有分支都要钉住。
 */

describe('rateToPermille（界面 → 千分比）', () => {
  it('整数与 1–3 位小数', () => {
    expect(rateToPermille('1')).toBe(1000)
    expect(rateToPermille('1.5')).toBe(1500)
    expect(rateToPermille('0.333')).toBe(333)
    expect(rateToPermille('0')).toBe(0)
    expect(rateToPermille('0.001')).toBe(1)
    expect(rateToPermille('100')).toBe(100000)
  })

  it('容忍空格与数字类型', () => {
    expect(rateToPermille('  1.5  ')).toBe(1500)
    expect(rateToPermille(1.5)).toBe(1500)
    expect(rateToPermille(0)).toBe(0)
  })

  it('非法输入一律 null', () => {
    expect(rateToPermille('')).toBeNull()
    expect(rateToPermille('   ')).toBeNull()
    expect(rateToPermille(null)).toBeNull()
    expect(rateToPermille(undefined)).toBeNull()
    expect(rateToPermille('-1')).toBeNull()
    expect(rateToPermille('1.2345')).toBeNull() // 超过 3 位小数
    expect(rateToPermille('100.001')).toBeNull() // 超过 ×100
    expect(rateToPermille('101')).toBeNull()
    expect(rateToPermille('abc')).toBeNull()
    expect(rateToPermille('1e3')).toBeNull()
    expect(rateToPermille('1,5')).toBeNull()
    expect(rateToPermille('.')).toBeNull()
    expect(rateToPermille('.5')).toBeNull() // 必须写 0.5
    expect(rateToPermille(Number.NaN)).toBeNull()
    expect(rateToPermille(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('边界：正好 ×100 可以，再多一点都不行', () => {
    expect(rateToPermille('99.999')).toBe(99999)
    expect(rateToPermille('100.000')).toBe(100000)
    expect(rateToPermille('100.001')).toBeNull()
  })
})

describe('permilleToRateInput（千分比 → 界面文本）', () => {
  it('去掉多余的 0', () => {
    expect(permilleToRateInput(1000)).toBe('1')
    expect(permilleToRateInput(1500)).toBe('1.5')
    expect(permilleToRateInput(333)).toBe('0.333')
    expect(permilleToRateInput(0)).toBe('0')
    expect(permilleToRateInput(50)).toBe('0.05')
    expect(permilleToRateInput(99999)).toBe('99.999')
    expect(permilleToRateInput(100000)).toBe('100')
  })

  it('非法值给空串', () => {
    expect(permilleToRateInput(null)).toBe('')
    expect(permilleToRateInput(undefined)).toBe('')
    expect(permilleToRateInput(-1)).toBe('')
    expect(permilleToRateInput(100001)).toBe('')
    expect(permilleToRateInput(Number.NaN)).toBe('')
  })

  it('与 rateToPermille 互逆（整数千分比）', () => {
    for (const permille of [0, 1, 10, 333, 999, 1000, 1500, 12345, 100000]) {
      expect(rateToPermille(permilleToRateInput(permille))).toBe(permille)
    }
  })
})

describe('formatRate（显示 ×…）', () => {
  it('常见值', () => {
    expect(formatRate(1000)).toBe('×1')
    expect(formatRate(1500)).toBe('×1.5')
    expect(formatRate(333)).toBe('×0.333')
    expect(formatRate(0)).toBe('×0')
  })

  it('null / 非法显示 —', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(undefined)).toBe('—')
    expect(formatRate(-5)).toBe('—')
  })
})

describe('applyRate（实际价格）', () => {
  it('按千分比缩放并四舍五入到整数微积分', () => {
    expect(applyRate(1_000_000, 1000)).toBe(1_000_000)
    expect(applyRate(1_000_000, 1500)).toBe(1_500_000)
    expect(applyRate(100_000, 333)).toBe(33_300)
    expect(applyRate(1, 500)).toBe(1) // 四舍五入
    expect(applyRate(3, 500)).toBe(2)
    expect(applyRate(1_000_000, 0)).toBe(0)
  })

  it('倍率为 null 时不加价', () => {
    expect(applyRate(1_000_000, null)).toBe(1_000_000)
    expect(applyRate(1_000_000, undefined)).toBe(1_000_000)
  })
})

describe('formatRatedPrice（/usage 的价格显示）', () => {
  it('最小 = 最大：直接给乘好的价', () => {
    expect(formatRatedPrice(1_000_000, { minPermille: 1500, maxPermille: 1500 })).toBe('1.5')
    expect(formatRatedPrice(2_000_000, { minPermille: 1000, maxPermille: 1000 })).toBe('2')
  })

  it('不同：显示区间', () => {
    expect(formatRatedPrice(1_000_000, { minPermille: 800, maxPermille: 1200 })).toBe('0.8–1.2')
    expect(formatRatedPrice(500_000, { minPermille: 1000, maxPermille: 1500 })).toBe('0.5–0.75')
  })

  it('没有可用渠道（null）：显示原始价格', () => {
    expect(formatRatedPrice(1_000_000, null)).toBe('1')
  })

  it('isRatedRange 只管是不是区间', () => {
    expect(isRatedRange({ minPermille: 1000, maxPermille: 1000 })).toBe(false)
    expect(isRatedRange({ minPermille: 1000, maxPermille: 1500 })).toBe(true)
    expect(isRatedRange(null)).toBe(false)
  })
})
