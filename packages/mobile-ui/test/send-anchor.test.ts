import { describe, expect, it } from 'vitest'
import { RAIL_JUMP_OFFSET } from '../src/lib/question-rail.js'
import {
  SEND_ANCHOR_OFFSET,
  anchoredMaxScroll,
  planSendAnchor,
  sendAnchorScrollTop,
  sendAnchorSpacer,
} from '../src/lib/send-anchor.js'

/**
 * 发送锚定（0.4.8）的纯计算单测：留白高度、目标 scrollTop、加完留白之后的最大可滚距离。
 *
 * 口径（与 e2e-send-anchor 一致）：留白把内容补到「刚好能把锚点消息顶到对话区顶部 + offset」，
 * 所以留白 > 0 时 `scrollHeight − clientHeight === anchorTop − offset`。
 */
describe('send-anchor：留白与目标位置', () => {
  const OFFSET = RAIL_JUMP_OFFSET

  interface Row {
    name: string
    anchorTop: number
    belowHeight: number
    viewportHeight: number
    offset?: number
    spacer: number
    scrollTop: number
    maxScroll: number
  }

  // 真实量级取自移动端 412×915：对话区可视高约 660（顶栏 + 输入区占掉其余）。
  const ROWS: Row[] = [
    {
      name: '长历史 + 刚发出的短问题（留白补满一屏，最大可滚距离 = 锚点位置）',
      anchorTop: 4982,
      belowHeight: 78,
      viewportHeight: 660,
      spacer: 570,
      scrollTop: 4970,
      maxScroll: 4970,
    },
    {
      name: '内容刚好够高（锚点下方正好一屏减间距）→ 留白 0',
      anchorTop: 4982,
      belowHeight: 648,
      viewportHeight: 660,
      spacer: 0,
      scrollTop: 4970,
      maxScroll: 4970,
    },
    {
      name: '回复已经超过一屏 → 留白 0，绝不补',
      anchorTop: 1200,
      belowHeight: 2800,
      viewportHeight: 660,
      spacer: 0,
      scrollTop: 1188,
      maxScroll: 3340,
    },
    {
      name: '空历史 + 第一条消息（anchorTop 很小）→ 目标 0，仍补满屏',
      anchorTop: 6,
      belowHeight: 80,
      viewportHeight: 660,
      spacer: 568,
      scrollTop: 0,
      maxScroll: 0,
    },
    {
      name: '键盘弹出（视口 660 → 360）留白随之变小',
      anchorTop: 4982,
      belowHeight: 78,
      viewportHeight: 360,
      spacer: 270,
      scrollTop: 4970,
      maxScroll: 4970,
    },
    {
      name: '键盘收起（视口 360 → 660）留白随之变大',
      anchorTop: 4982,
      belowHeight: 78,
      viewportHeight: 660,
      spacer: 570,
      scrollTop: 4970,
      maxScroll: 4970,
    },
    {
      name: 'offset=0（贴死顶部）',
      anchorTop: 500,
      belowHeight: 60,
      viewportHeight: 660,
      offset: 0,
      spacer: 600,
      scrollTop: 500,
      maxScroll: 500,
    },
    {
      name: 'offset=40（更大的顶部间距）',
      anchorTop: 500,
      belowHeight: 60,
      viewportHeight: 660,
      offset: 40,
      spacer: 560,
      scrollTop: 460,
      maxScroll: 460,
    },
    {
      name: 'offset 大于视口 → 留白下限 0（不为负）',
      anchorTop: 500,
      belowHeight: 60,
      viewportHeight: 30,
      spacer: 0,
      scrollTop: 488,
      maxScroll: 530,
    },
    {
      name: '内容比视口还矮、视口又很小 → 留白仍是下限 0',
      anchorTop: 10,
      belowHeight: 10,
      viewportHeight: 10,
      spacer: 0,
      scrollTop: 0,
      maxScroll: 10,
    },
    {
      name: '小数（真机 getBoundingClientRect 会带半像素）',
      anchorTop: 1000.5,
      belowHeight: 99.75,
      viewportHeight: 659.5,
      spacer: 547.75,
      scrollTop: 988.5,
      maxScroll: 988.5,
    },
  ]

  it.each(ROWS)('$name', (row) => {
    const { anchorTop, belowHeight, viewportHeight, offset, spacer, scrollTop, maxScroll } = row
    const input = { anchorTop, belowHeight, viewportHeight, ...(offset === undefined ? {} : { offset }) }
    expect(sendAnchorSpacer(input)).toBeCloseTo(spacer, 6)
    expect(sendAnchorScrollTop(anchorTop, offset)).toBeCloseTo(scrollTop, 6)
    expect(anchoredMaxScroll(input)).toBeCloseTo(maxScroll, 6)
    const plan = planSendAnchor(input)
    expect(plan.spacer).toBeCloseTo(spacer, 6)
    expect(plan.scrollTop).toBeCloseTo(scrollTop, 6)
  })

  it('留白 > 0 时：scrollHeight − clientHeight 恰好等于「锚点位置 − 间距」', () => {
    for (const row of ROWS) {
      if (row.spacer <= 0) continue
      const input = {
        anchorTop: row.anchorTop,
        belowHeight: row.belowHeight,
        viewportHeight: row.viewportHeight,
        ...(row.offset === undefined ? {} : { offset: row.offset }),
      }
      expect(anchoredMaxScroll(input)).toBeCloseTo(sendAnchorScrollTop(input.anchorTop, row.offset), 6)
    }
  })

  it('留白只补足：最大可滚距离不会超过目标位置（够不着目标时例外）', () => {
    for (let belowHeight = 0; belowHeight <= 6000; belowHeight += 137) {
      for (const viewportHeight of [360, 500, 660, 915]) {
        const anchorTop = 900
        const input = { anchorTop, belowHeight, viewportHeight }
        const max = anchoredMaxScroll(input)
        const target = sendAnchorScrollTop(anchorTop)
        const spacer = sendAnchorSpacer(input)
        if (spacer > 0) {
          expect(max).toBeCloseTo(target, 6)
        } else {
          // 不加留白：能滚到内容末尾（内容 + 视口本来就够）
          expect(max).toBeCloseTo(Math.max(0, anchorTop + belowHeight - viewportHeight), 6)
          expect(max).toBeGreaterThanOrEqual(target - 1e-6)
        }
      }
    }
  })

  it('内容长高时留白单调不增，缩到 0 之后一直保持 0（回复往下长）', () => {
    const anchorTop = 1000
    const viewportHeight = 660
    let previous = Number.POSITIVE_INFINITY
    const series: number[] = []
    for (let contentHeight = 1040; contentHeight <= 2400; contentHeight += 100) {
      const spacer = sendAnchorSpacer({ anchorTop, belowHeight: contentHeight - anchorTop, viewportHeight })
      expect(spacer).toBeLessThanOrEqual(previous + 1e-9)
      series.push(Math.round(spacer))
      previous = spacer
    }
    expect(series[0]).toBe(608) // 660 − 40 − 12
    expect(series[series.length - 1]).toBe(0)
    expect(series.filter((value) => value === 0).length).toBeGreaterThan(0)
  })

  it('非法输入不产生 NaN：视口 0/负数、Infinity、NaN 一律 0 留白', () => {
    const bad = [
      { anchorTop: Number.NaN, belowHeight: 100, viewportHeight: 660 },
      { anchorTop: 900, belowHeight: Number.NaN, viewportHeight: 660 },
      { anchorTop: 900, belowHeight: 100, viewportHeight: Number.NaN },
      { anchorTop: 900, belowHeight: 100, viewportHeight: 0 },
      { anchorTop: 900, belowHeight: 100, viewportHeight: -20 },
      { anchorTop: Number.POSITIVE_INFINITY, belowHeight: 100, viewportHeight: 660 },
      { anchorTop: -300, belowHeight: -100, viewportHeight: 660 },
    ]
    for (const input of bad) {
      const plan = planSendAnchor(input)
      expect(Number.isNaN(plan.spacer)).toBe(false)
      expect(Number.isNaN(plan.scrollTop)).toBe(false)
      expect(plan.spacer).toBeGreaterThanOrEqual(0)
      expect(plan.scrollTop).toBeGreaterThanOrEqual(0)
    }
    expect(sendAnchorSpacer(bad[3]!)).toBe(0)
    // 锚点下方高度为负 → 按 0：留白 = 视口 − 间距
    expect(sendAnchorSpacer(bad[6]!)).toBe(660 - SEND_ANCHOR_OFFSET)
    expect(sendAnchorScrollTop(Number.NaN)).toBe(0)
    expect(sendAnchorScrollTop(-50)).toBe(0)
  })

  it('顶部间距复用导航条常量（RAIL_JUMP_OFFSET）', () => {
    expect(SEND_ANCHOR_OFFSET).toBe(OFFSET)
    expect(SEND_ANCHOR_OFFSET).toBe(12)
  })
})
