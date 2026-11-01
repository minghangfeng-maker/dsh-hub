import { describe, expect, it } from 'vitest'
import { indexFromRatio, nearestAvailableIndex } from '@/lib/effort-slider'

describe('nearestAvailableIndex', () => {
  const all = [true, true, true, true]
  const lowOnly = [true, false, false, false]
  const lowAndMax = [true, false, false, true]

  it('四档全可用时原样返回', () => {
    expect(nearestAvailableIndex(0, all)).toBe(0)
    expect(nearestAvailableIndex(2, all)).toBe(2)
    expect(nearestAvailableIndex(3, all)).toBe(3)
  })

  it('不支持的档位不可拖到：吸附到最近的可用档', () => {
    expect(nearestAvailableIndex(2, lowOnly)).toBe(0)
    expect(nearestAvailableIndex(2, lowAndMax)).toBe(3)
    expect(nearestAvailableIndex(1, lowAndMax)).toBe(0)
  })

  it('等距时取左边（结果稳定）', () => {
    // 下标 1 到 0 与 2 等距，但 2 不可用；下标 2 到 1（不可用）与 3 等距 → 取 3？
    expect(nearestAvailableIndex(1, [true, false, true, false])).toBe(0)
    expect(nearestAvailableIndex(2, [true, false, true, false])).toBe(2)
    // 0 与 3 都距 1.5 等距时取左边 0
    expect(nearestAvailableIndex(1.5, lowAndMax)).toBe(0)
  })

  it('一个都不可用时回退到 fallback', () => {
    expect(nearestAvailableIndex(2, [false, false, false, false])).toBe(0)
    expect(nearestAvailableIndex(2, [false, false, false, false], 2)).toBe(2)
  })

  it('非法输入不抛错', () => {
    expect(nearestAvailableIndex(Number.NaN, all)).toBe(0)
    expect(nearestAvailableIndex(-5, all)).toBe(0)
    expect(nearestAvailableIndex(99, all)).toBe(3)
  })
})

describe('indexFromRatio', () => {
  it('比例 → 档位下标（四舍五入）', () => {
    expect(indexFromRatio(0, 4)).toBe(0)
    expect(indexFromRatio(1 / 3, 4)).toBe(1)
    expect(indexFromRatio(0.5, 4)).toBe(2)
    expect(indexFromRatio(1, 4)).toBe(3)
  })

  it('越界钳制、无档位安全', () => {
    expect(indexFromRatio(-1, 4)).toBe(0)
    expect(indexFromRatio(2, 4)).toBe(3)
    expect(indexFromRatio(0.5, 1)).toBe(0)
    expect(indexFromRatio(Number.NaN, 4)).toBe(0)
  })
})
