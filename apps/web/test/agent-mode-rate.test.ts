import { describe, expect, it } from 'vitest'

import { agentModePriceText } from '@/utils/agent-mode-price'
import { formatModeRate, modeRateInput, parseModeRate } from '@/utils/mode-rate'
import { relayScopeLabel } from '@/utils/relay-scope'

/**
 * 18 的纯函数：整体倍率的录入 / 显示（×1.5 ↔ 1500，×0 允许）、
 * 对话模式模型的实际单价（模型价 × 渠道倍率 × 整体倍率 × 钱包倍率，含渠道倍率区间）。
 */
describe('整体倍率（18 D4）', () => {
  it('输入 ×1.5 / 1.5 都存成 1500；0 合法；超过 3 位小数与 100 非法', () => {
    expect(parseModeRate('1.5')).toBe(1500)
    expect(parseModeRate('×1.5')).toBe(1500)
    expect(parseModeRate('x2')).toBe(2000)
    expect(parseModeRate('1')).toBe(1000)
    expect(parseModeRate('0')).toBe(0)
    expect(parseModeRate(' 0.333 ')).toBe(333)
    expect(parseModeRate('0.1234')).toBeNull()
    expect(parseModeRate('101')).toBeNull()
    expect(parseModeRate('')).toBeNull()
    expect(parseModeRate(null)).toBeNull()
  })

  it('显示去掉多余的 0：1500 → ×1.5、1000 → ×1、0 → ×0', () => {
    expect(modeRateInput(1500)).toBe('1.5')
    expect(modeRateInput(1000)).toBe('1')
    expect(modeRateInput(0)).toBe('0')
    expect(formatModeRate(1500)).toBe('×1.5')
    expect(formatModeRate(1000)).toBe('×1')
    expect(formatModeRate(0)).toBe('×0')
    expect(formatModeRate(null)).toBe('—')
  })
})

describe('对话模式模型的实际单价（18 §7）', () => {
  const base = 2_000_000 // 2 积分 / 百万 token

  it('模型价 × 渠道倍率 × 整体倍率（钱包 100%）', () => {
    const price = agentModePriceText(base, {
      channelRate: { minPermille: 1000, maxPermille: 1000 },
      modeRatePermille: 1500,
    })
    expect(price.text).toBe('3')
    expect(price.title).toContain('模型价格 2')
    expect(price.title).toContain('渠道 ×1')
    expect(price.title).toContain('模式 ×1.5')
  })

  it('渠道倍率是区间时给区间（不同渠道的价格不同）', () => {
    const price = agentModePriceText(base, {
      channelRate: { minPermille: 100, maxPermille: 1000 },
      modeRatePermille: 1500,
    })
    expect(price.text).toBe('0.3–3')
    expect(price.title).toContain('渠道 ×0.1–×1')
  })

  it('再乘钱包倍率；×0 整体倍率 = 免费', () => {
    const wallet = agentModePriceText(base, {
      channelRate: { minPermille: 1000, maxPermille: 1000 },
      modeRatePermille: 1500,
      walletRatePercent: 85,
    })
    expect(wallet.text).toBe('2.55')
    expect(wallet.title).toContain('钱包 85%')

    const free = agentModePriceText(base, {
      channelRate: { minPermille: 1000, maxPermille: 1000 },
      modeRatePermille: 0,
    })
    expect(free.text).toBe('0')
  })

  it('缓存读价格缺省显示「同输入」', () => {
    const price = agentModePriceText(null, {
      channelRate: { minPermille: 1000, maxPermille: 1000 },
      modeRatePermille: 1000,
    })
    expect(price.text).toBe('同输入')
  })
})

describe('来源文案', () => {
  it('缺省 / 未知按 DSH 处理', () => {
    expect(relayScopeLabel('dsh')).toBe('DSH')
    expect(relayScopeLabel('claude-code')).toBe('Claude Code')
    expect(relayScopeLabel('codex')).toBe('Codex')
    expect(relayScopeLabel(undefined)).toBe('DSH')
  })
})
