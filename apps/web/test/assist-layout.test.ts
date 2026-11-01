import { describe, expect, it } from 'vitest'

import {
  ASSIST_TIERS,
  ASSIST_TIER_QUERIES,
  assistEventsWidthOf,
  assistLayoutOf,
  assistScaleOf,
  assistSessionsModeOf,
  assistTierOf,
  assistTierSpec,
} from '@/utils/assist-layout'

/**
 * AI 助手页的五档布局（WP58，docs/26 §2.1）。
 * 档位是按视口宽度的 CSS px 切的，边界值一个都不能偏：1280 / 1920 / 2560 / 3200。
 */
describe('AI 助手 · 多屏分档（WP58）', () => {
  it('档位边界：S <1280 ≤ M <1920 ≤ L <2560 ≤ XL <3200 ≤ XXL', () => {
    expect(assistTierOf(0)).toBe('S')
    expect(assistTierOf(1024)).toBe('S')
    expect(assistTierOf(1100)).toBe('S')
    expect(assistTierOf(1279)).toBe('S')

    expect(assistTierOf(1280)).toBe('M')
    expect(assistTierOf(1366)).toBe('M')
    expect(assistTierOf(1919)).toBe('M')

    expect(assistTierOf(1920)).toBe('L')
    expect(assistTierOf(2559)).toBe('L')

    expect(assistTierOf(2560)).toBe('XL')
    expect(assistTierOf(3199)).toBe('XL')

    expect(assistTierOf(3200)).toBe('XXL')
    expect(assistTierOf(3440)).toBe('XXL')
    expect(assistTierOf(3840)).toBe('XXL')
  })

  it('非有限数 / 负数按 S 兜底（不抛错、也不落到 XXL）', () => {
    expect(assistTierOf(Number.NaN)).toBe('S')
    expect(assistTierOf(Number.POSITIVE_INFINITY)).toBe('S')
    expect(assistTierOf(-100)).toBe('S')
  })

  it('每档的事件栏宽度、会话列表形态与缩放与设计表一致', () => {
    const table = [
      { tier: 'S', events: 420, sessions: 'menu', scale: 1 },
      { tier: 'M', events: 360, sessions: 'menu', scale: 1 },
      { tier: 'L', events: 400, sessions: 'docked', scale: 1 },
      { tier: 'XL', events: 440, sessions: 'docked', scale: 1.125 },
      { tier: 'XXL', events: 480, sessions: 'docked', scale: 1.25 },
    ] as const

    for (const row of table) {
      expect(assistEventsWidthOf(row.tier)).toBe(row.events)
      expect(assistSessionsModeOf(row.tier)).toBe(row.sessions)
      expect(assistScaleOf(row.tier)).toBe(row.scale)
    }
  })

  it('L 档及以上才把会话列表常驻（cockpit.layout.sessions = docked）', () => {
    expect(assistSessionsModeOf('S')).toBe('menu')
    expect(assistSessionsModeOf('M')).toBe('menu')
    expect(assistSessionsModeOf('L')).toBe('docked')
    expect(assistSessionsModeOf('XL')).toBe('docked')
    expect(assistSessionsModeOf('XXL')).toBe('docked')
  })

  it('cockpit.layout 载荷：scale 夹在 1–1.5，sessions 只出两个值', () => {
    expect(assistLayoutOf('S')).toEqual({ scale: 1, sessions: 'menu' })
    expect(assistLayoutOf('L')).toEqual({ scale: 1, sessions: 'docked' })
    expect(assistLayoutOf('XL')).toEqual({ scale: 1.125, sessions: 'docked' })
    expect(assistLayoutOf('XXL')).toEqual({ scale: 1.25, sessions: 'docked' })
  })

  it('matchMedia 监听的是四条分档线，与规格里的 minWidth 对得上', () => {
    expect(ASSIST_TIER_QUERIES).toEqual([
      '(min-width: 1280px)',
      '(min-width: 1920px)',
      '(min-width: 2560px)',
      '(min-width: 3200px)',
    ])
    expect(ASSIST_TIERS.map((spec) => spec.minWidth)).toEqual([0, 1280, 1920, 2560, 3200])
    // 未知档位按 M 兜底（不至于整页没有宽度）
    expect(assistTierSpec('S').tier).toBe('S')
    expect(assistTierSpec('M').eventsWidth).toBe(360)
  })
})
