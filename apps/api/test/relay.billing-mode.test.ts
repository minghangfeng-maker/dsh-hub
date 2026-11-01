import { describe, expect, it } from 'vitest'
import { computeCostMicro } from '../src/modules/relay/billing.js'

/**
 * 18 §3.3 的模式倍率：`cost = ceil(base × 渠道倍率 × 模式倍率 × 钱包倍率 / (1e6 × 1000 × 1000 × 100))`。
 * 重点：dsh（模式倍率省略或 1000）与改动前逐位相同；×0.5 / ×2 / ×0 与三种倍率相乘的进位。
 */

const PRICE = {
  inputMicro: 1_000_000, // 1 积分 / 百万 token
  outputMicro: 2_000_000,
  cacheReadMicro: null,
  cacheWriteMicro: null,
  perRequestMicro: 0,
}

/** 100 输入 + 40 输出 → base = 100×1e6 + 40×2e6 = 1.8e8（微积分 × 百万） */
const TOKENS = { input: 100, cacheRead: 0, cacheWrite: 0, output: 40 }

describe('computeCostMicro：模式倍率（18 §3.3）', () => {
  it('dsh 口径（省略 / 1000）与原来的公式逐位相同', () => {
    expect(computeCostMicro(PRICE, TOKENS, { walletRatePercent: 100, channelRatePermille: 1000 })).toBe(180)
    expect(
      computeCostMicro(PRICE, TOKENS, {
        walletRatePercent: 100,
        channelRatePermille: 1000,
        modeRatePermille: 1000,
      }),
    ).toBe(180)
  })

  it('×2 / ×0.5 / ×0', () => {
    const base = { walletRatePercent: 100, channelRatePermille: 1000 }
    expect(computeCostMicro(PRICE, TOKENS, { ...base, modeRatePermille: 2000 })).toBe(360)
    expect(computeCostMicro(PRICE, TOKENS, { ...base, modeRatePermille: 500 })).toBe(90)
    expect(computeCostMicro(PRICE, TOKENS, { ...base, modeRatePermille: 0 })).toBe(0)
  })

  it('三种倍率相乘与进位：1 token × 1500‰ × 1500‰ × 33% 向上取整', () => {
    // base = 1×1e6 = 1e6；1e6 × 1500 × 1500 × 33 / (1e6 × 1000 × 1000 × 100) = 0.07425 → ceil = 1
    expect(
      computeCostMicro(
        { ...PRICE, outputMicro: 0 },
        { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
        { walletRatePercent: 33, channelRatePermille: 1500, modeRatePermille: 1500 },
      ),
    ).toBe(1)
    // 刚好 1.5 → 2（不是四舍五入到 1）
    // base = 1e6，渠道 1000，模式 1500，钱包 100 → 1500‰ 正好 1.5 微积分
    expect(
      computeCostMicro(
        { ...PRICE, outputMicro: 0 },
        { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
        { walletRatePercent: 100, channelRatePermille: 1000, modeRatePermille: 1500 },
      ),
    ).toBe(2)
    // 0.5 → 1
    expect(
      computeCostMicro(
        { ...PRICE, outputMicro: 0 },
        { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
        { walletRatePercent: 100, channelRatePermille: 1000, modeRatePermille: 500 },
      ),
    ).toBe(1)
  })

  it('脏数据（NaN / 负数 / 小数）按 0 / 向下取整，不会算坏余额', () => {
    expect(
      computeCostMicro(PRICE, TOKENS, {
        walletRatePercent: 100,
        channelRatePermille: 1000,
        modeRatePermille: Number.NaN,
      }),
    ).toBe(0)
    expect(
      computeCostMicro(PRICE, TOKENS, {
        walletRatePercent: 100,
        channelRatePermille: 1000,
        modeRatePermille: -5,
      }),
    ).toBe(0)
    expect(
      computeCostMicro(PRICE, TOKENS, {
        walletRatePercent: 100,
        channelRatePermille: 1000,
        // 小数向下取整成 1499：ceil(180 × 1499 / 1000) = 270
        modeRatePermille: 1499.9,
      }),
    ).toBe(270)
  })

  it('BigInt：大 token × 高价 × 两种倍率不丢精度', () => {
    const price = { ...PRICE, inputMicro: 123_456_789, outputMicro: 987_654_321 }
    const tokens = { input: 9_999_999, cacheRead: 0, cacheWrite: 0, output: 1_234_567 }
    const rates = { walletRatePercent: 97, channelRatePermille: 1234, modeRatePermille: 2000 }
    const raw = 9_999_999n * 123_456_789n + 1_234_567n * 987_654_321n
    const numerator = raw * 1234n * 2000n * 97n
    const denominator = 1_000_000n * 1000n * 1000n * 100n
    expect(computeCostMicro(price, tokens, rates)).toBe(Number((numerator + denominator - 1n) / denominator))
  })
})
