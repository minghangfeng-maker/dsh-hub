import { describe, expect, it } from 'vitest'
import type { RelayPrice } from '@dsh-hub/shared'
import { computeCostMicro, type RelayRates } from '../src/modules/relay/billing.js'
import type { BillableTokens } from '../src/modules/relay/billing.js'

/** 基准价：1 微积分 / token（= 1_000_000 微积分 / 百万 token），缓存价缺省、无固定费用 */
const BASE_PRICE: RelayPrice = {
  inputMicro: 1_000_000,
  outputMicro: 2_000_000,
  cacheReadMicro: null,
  cacheWriteMicro: null,
  perRequestMicro: 0,
}

/** 两个倍率的默认值：钱包 100%、渠道 1000‰（= 原价） */
const DEFAULT_RATES: RelayRates = { walletRatePercent: 100, channelRatePermille: 1000 }

function price(partial: Partial<RelayPrice> = {}): RelayPrice {
  return { ...BASE_PRICE, ...partial }
}

function tokens(partial: Partial<BillableTokens> = {}): BillableTokens {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...partial }
}

/** 老签名（只有钱包倍率）→ 新签名：渠道倍率取默认 1000‰，用来钉住「升级前后结果一致」 */
function legacy(price: RelayPrice, tokens: BillableTokens, walletRatePercent: number): number {
  return computeCostMicro(price, tokens, { walletRatePercent, channelRatePermille: 1000 })
}

/**
 * 独立参考实现（12 §6.2 的精确有理数版本）：
 * cost = ceil((raw / 1e6 + perRequest) × channelRate/1000 × walletRate/100)
 *      = ceil((raw + perRequest×1e6) × channelRate × walletRate / 1e11)
 * 用 BigInt 算，能钉住实现不会在大数上丢精度。
 */
function referenceCostMicro(p: RelayPrice, t: BillableTokens, rates: RelayRates): number {
  const pIn = BigInt(p.inputMicro)
  const pCacheRead = p.cacheReadMicro === null ? pIn : BigInt(p.cacheReadMicro)
  const pCacheWrite = p.cacheWriteMicro === null ? pIn : BigInt(p.cacheWriteMicro)
  const raw =
    BigInt(t.input) * pIn +
    BigInt(t.cacheRead) * pCacheRead +
    BigInt(t.cacheWrite) * pCacheWrite +
    BigInt(t.output) * BigInt(p.outputMicro)
  const denominator = 100_000_000_000n
  const numerator =
    (raw + BigInt(p.perRequestMicro) * 1_000_000n) *
    BigInt(rates.channelRatePermille) *
    BigInt(rates.walletRatePercent)
  return Number((numerator + denominator - 1n) / denominator)
}

describe('computeCostMicro（12 §6.2 公式）', () => {
  it('没有用量也没有固定费用 → 0', () => {
    expect(computeCostMicro(price(), tokens(), DEFAULT_RATES)).toBe(0)
  })

  it('input / output 各按自己的单价计费', () => {
    // 1000 token × 1 微积分/token = 1000 微积分
    expect(computeCostMicro(price(), tokens({ input: 1000 }), DEFAULT_RATES)).toBe(1000)
    // output 用 outputMicro（3 微积分/token）
    expect(computeCostMicro(price({ outputMicro: 3_000_000 }), tokens({ output: 1000 }), DEFAULT_RATES)).toBe(
      3000,
    )
  })

  it('四类 token 相加（raw 单位：微积分 × 百万 token）', () => {
    const p = price({
      inputMicro: 1_000_000,
      outputMicro: 3_000_000,
      cacheReadMicro: 500_000,
      cacheWriteMicro: 2_000_000,
    })
    const t = tokens({ input: 100, cacheRead: 200, cacheWrite: 300, output: 400 })
    // raw = 100×1e6 + 200×5e5 + 300×2e6 + 400×3e6 = 2.0e9 → 2000 微积分
    expect(computeCostMicro(p, t, DEFAULT_RATES)).toBe(2000)
  })

  it('cacheReadMicro / cacheWriteMicro 为 null 时按 inputMicro 计费', () => {
    const t = tokens({ cacheRead: 1000, cacheWrite: 1000 })
    // 两段都按 2 微积分/token → 4000
    expect(computeCostMicro(price({ inputMicro: 2_000_000 }), t, DEFAULT_RATES)).toBe(4000)
    // 只有 cacheRead 给了价，cacheWrite 仍按输入价
    const p = price({ inputMicro: 2_000_000, cacheReadMicro: 500_000 })
    // 1000×5e5 + 1000×2e6 = 2.5e9 → 2500
    expect(computeCostMicro(p, t, DEFAULT_RATES)).toBe(2500)
  })

  it('ratePercent 是百分比：100 原价、50 半价、1000 十倍', () => {
    const p = price()
    const t = tokens({ input: 1001 })
    expect(legacy(p, t, 100)).toBe(1001)
    // 1001 × 50 / 100 = 500.5 → 向上取整 501
    expect(legacy(p, t, 50)).toBe(501)
    expect(legacy(p, t, 1000)).toBe(10_010)
    expect(legacy(p, t, 1)).toBe(11) // 10.01 → 11
  })

  it('ratePercent = 0 → 免费，即使有 perRequest', () => {
    const p = price({ perRequestMicro: 12_345 })
    expect(
      computeCostMicro(p, tokens({ input: 1_000_000, output: 1_000_000 }), {
        walletRatePercent: 0,
        channelRatePermille: 1000,
      }),
    ).toBe(0)
    expect(
      referenceCostMicro(p, tokens({ input: 1_000_000, output: 1_000_000 }), {
        walletRatePercent: 0,
        channelRatePermille: 1000,
      }),
    ).toBe(0)
  })

  it('perRequestMicro 是每次请求的固定费用（同样受倍率与向上取整影响）', () => {
    expect(computeCostMicro(price({ perRequestMicro: 5 }), tokens(), DEFAULT_RATES)).toBe(5)
    expect(legacy(price({ perRequestMicro: 1 }), tokens(), 50)).toBe(1) // 0.5 → 1
    expect(legacy(price({ perRequestMicro: 3 }), tokens(), 33)).toBe(1) // 0.99 → 1
    // 1 token 的 1e-6 微积分 + 1 微积分固定费 = 1.000001 → 2
    expect(
      computeCostMicro(price({ inputMicro: 1, perRequestMicro: 1 }), tokens({ input: 1 }), DEFAULT_RATES),
    ).toBe(2)
  })

  it('向上取整：只要有正费用就至少 1，恰好整数不额外加', () => {
    const p = price({ inputMicro: 1 }) // raw = token 数
    expect(computeCostMicro(p, tokens({ input: 1 }), DEFAULT_RATES)).toBe(1) // 1e-6 → 1
    expect(computeCostMicro(p, tokens({ input: 999_999 }), DEFAULT_RATES)).toBe(1) // 0.999999 → 1
    expect(computeCostMicro(p, tokens({ input: 1_000_000 }), DEFAULT_RATES)).toBe(1) // 恰好 1 → 1
    expect(computeCostMicro(p, tokens({ input: 1_000_001 }), DEFAULT_RATES)).toBe(2) // 1.000001 → 2
    expect(computeCostMicro(p, tokens({ input: 2_000_000 }), DEFAULT_RATES)).toBe(2)
  })

  it('单调性：token 越多、倍率越高，费用不下降', () => {
    const p = price({
      inputMicro: 1_999_999,
      outputMicro: 2_500_001,
      cacheReadMicro: 777_777,
      cacheWriteMicro: 999_999,
      perRequestMicro: 3,
    })
    const counts = [0, 1, 999, 1000, 500_000, 1_000_000, 3_000_000]
    for (const key of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
      let previous = -1
      for (const count of counts) {
        const cost = computeCostMicro(p, tokens({ [key]: count }), DEFAULT_RATES)
        expect(cost).toBeGreaterThanOrEqual(previous)
        previous = cost
      }
    }
    let previous = -1
    for (const rate of [0, 1, 50, 100, 137, 1000]) {
      const cost = computeCostMicro(p, tokens({ input: 123_456, output: 7_890 }), {
        walletRatePercent: rate,
        channelRatePermille: 1000,
      })
      expect(cost).toBeGreaterThanOrEqual(previous)
      previous = cost
    }
  })

  it('巨大数值不丢精度（百万级 token × 百万级价格）', () => {
    const p = price({ inputMicro: 1_000_000, outputMicro: 2_000_000 })
    const t = tokens({ input: 9_000_000, output: 9_000_000 })
    // raw = 9e12 + 1.8e13 = 2.7e13 → 2.7e7 微积分
    expect(computeCostMicro(p, t, DEFAULT_RATES)).toBe(27_000_000)
    expect(computeCostMicro({ ...p, perRequestMicro: 999_999 }, t, DEFAULT_RATES)).toBe(27_999_999)
    expect(legacy(p, t, 1000)).toBe(270_000_000)
  })

  it('与 BigInt 参考实现在一组取值上完全一致', () => {
    const cases: Array<[RelayPrice, BillableTokens, RelayRates]> = [
      [price(), tokens({ input: 1234, output: 5678 }), DEFAULT_RATES],
      [
        price({ cacheReadMicro: 700_001, cacheWriteMicro: 1_300_007, perRequestMicro: 13 }),
        tokens({ input: 555_555, cacheRead: 12_345, cacheWrite: 6_789, output: 98_765 }),
        { walletRatePercent: 37, channelRatePermille: 1000 },
      ],
      [
        price({ inputMicro: 999_983, outputMicro: 1_000_003 }),
        tokens({ input: 8_888_888 }),
        { walletRatePercent: 733, channelRatePermille: 1000 },
      ],
      [
        price({ perRequestMicro: 99_999 }),
        tokens({ output: 1 }),
        { walletRatePercent: 1000, channelRatePermille: 1000 },
      ],
      [
        price({ inputMicro: 0, outputMicro: 0, perRequestMicro: 0 }),
        tokens({ input: 1_000_000 }),
        DEFAULT_RATES,
      ],
      // 两个倍率一起用
      [
        price({ cacheReadMicro: 1_234_567, perRequestMicro: 7 }),
        tokens({ input: 3_333_333, cacheRead: 44_444, output: 55_555 }),
        { walletRatePercent: 85, channelRatePermille: 1500 },
      ],
    ]
    for (const [p, t, rates] of cases) {
      expect(computeCostMicro(p, t, rates)).toBe(referenceCostMicro(p, t, rates))
    }
  })

  it('返回值始终是非负整数', () => {
    const p = price({ inputMicro: 333_333, outputMicro: 666_667, perRequestMicro: 7 })
    const t = tokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 })
    for (const rate of [0, 1, 33, 50, 100, 999, 1000]) {
      const cost = computeCostMicro(p, t, { walletRatePercent: rate, channelRatePermille: 1000 })
      expect(Number.isInteger(cost)).toBe(true)
      expect(cost).toBeGreaterThanOrEqual(0)
    }
  })

  it('脏数据（NaN / 负数 / 小数）不会算出 NaN 或负数', () => {
    // 负数与 NaN 的 token 记 0
    expect(computeCostMicro(price(), tokens({ input: Number.NaN, output: -5 }), DEFAULT_RATES)).toBe(0)
    expect(computeCostMicro(price(), tokens({ input: Number.POSITIVE_INFINITY }), DEFAULT_RATES)).toBe(0)
    // 负价格按 0 处理
    expect(computeCostMicro(price({ inputMicro: -1 }), tokens({ input: 1000 }), DEFAULT_RATES)).toBe(0)
    expect(computeCostMicro(price({ perRequestMicro: -9 }), tokens(), DEFAULT_RATES)).toBe(0)
    // 负倍率 / NaN 倍率按 0 处理
    expect(
      computeCostMicro(price(), tokens({ input: 1000 }), {
        walletRatePercent: -10,
        channelRatePermille: 1000,
      }),
    ).toBe(0)
    expect(
      computeCostMicro(price(), tokens({ input: 1000 }), {
        walletRatePercent: Number.NaN,
        channelRatePermille: 1000,
      }),
    ).toBe(0)
    expect(
      computeCostMicro(price(), tokens({ input: 1000 }), {
        walletRatePercent: 100,
        channelRatePermille: Number.NaN,
      }),
    ).toBe(0)
    // 小数 token 向下取整，不多收
    expect(computeCostMicro(price(), tokens({ input: 10.9 }), DEFAULT_RATES)).toBe(10)
  })

  // ── WP11a 新增：渠道倍率 ──────────────────────────────────────────────────

  it('渠道 ×1.5 / ×0.333：乘上去并向上取整', () => {
    const p = price({ inputMicro: 1_000_000, outputMicro: 2_000_000 })
    const t = tokens({ input: 1001 })
    // 1001 × 1500/1000 = 1501.5 → 1502
    expect(computeCostMicro(p, t, { walletRatePercent: 100, channelRatePermille: 1500 })).toBe(1502)
    // 1001 × 333/1000 = 333.333 → 334
    expect(computeCostMicro(p, t, { walletRatePercent: 100, channelRatePermille: 333 })).toBe(334)
    // 每次固定费也乘渠道倍率：3 × 1.5 = 4.5 → 5
    expect(
      computeCostMicro(price({ perRequestMicro: 3 }), tokens(), {
        walletRatePercent: 100,
        channelRatePermille: 1500,
      }),
    ).toBe(5)
  })

  it('两个倍率相乘：渠道 ×1.5、钱包 85% → 1.275 倍，向上取整', () => {
    const p = price({ inputMicro: 1_000_000 })
    // 1001 × 1.5 × 0.85 = 1276.275 → 1277
    expect(
      computeCostMicro(p, tokens({ input: 1001 }), { walletRatePercent: 85, channelRatePermille: 1500 }),
    ).toBe(1277)
    expect(
      referenceCostMicro(p, tokens({ input: 1001 }), { walletRatePercent: 85, channelRatePermille: 1500 }),
    ).toBe(1277)
  })

  it('任一倍率为 0 → 0（照常记 token）', () => {
    const p = price({ perRequestMicro: 12_345 })
    const t = tokens({ input: 1_000_000, output: 1_000_000 })
    expect(computeCostMicro(p, t, { walletRatePercent: 0, channelRatePermille: 1500 })).toBe(0)
    expect(computeCostMicro(p, t, { walletRatePercent: 100, channelRatePermille: 0 })).toBe(0)
    expect(computeCostMicro(p, t, { walletRatePercent: 0, channelRatePermille: 0 })).toBe(0)
  })

  it('大数：5000 万 token × 1e9 微积分/百万 × 渠道 100000 × 钱包 1000 不丢精度', () => {
    const p = price({ inputMicro: 1_000_000_000, outputMicro: 0 })
    const t = tokens({ input: 50_000_000 })
    const rates: RelayRates = { walletRatePercent: 1000, channelRatePermille: 100_000 }
    // 手算（BigInt）：5e7 × 1e9 = 5e16；× 1e5 × 1e3 = 5e24；÷ 1e11 = 5e13
    expect(computeCostMicro(p, t, rates)).toBe(50_000_000_000_000)
    expect(computeCostMicro(p, t, rates)).toBe(referenceCostMicro(p, t, rates))
    // 浮点中间结果（5e24 无法精确表示）会算错，这里钉住 BigInt 的结果
    expect(computeCostMicro(p, t, rates)).not.toBe(Number(5e16 * 1e5 * 1e3) / 1e11)
  })

  it('只有每次费用（没有 token）', () => {
    expect(computeCostMicro(price({ perRequestMicro: 1_000_000 }), tokens(), DEFAULT_RATES)).toBe(1_000_000)
    expect(
      computeCostMicro(price({ perRequestMicro: 1_000_000 }), tokens(), {
        walletRatePercent: 100,
        channelRatePermille: 1500,
      }),
    ).toBe(1_500_000)
    // 0.5 积分 = 500_000 微积分，× 0.333 → 166_500 微积分（整数，不额外进位）
    expect(
      computeCostMicro(price({ perRequestMicro: 500_000 }), tokens(), {
        walletRatePercent: 100,
        channelRatePermille: 333,
      }),
    ).toBe(166_500)
    // 500_001 × 0.333 = 166_500.333 → 166_501
    expect(
      computeCostMicro(price({ perRequestMicro: 500_001 }), tokens(), {
        walletRatePercent: 100,
        channelRatePermille: 333,
      }),
    ).toBe(166_501)
  })
})
