import { describe, expect, it } from 'vitest'

import {
  createRipple,
  drawRipples,
  isRippleDone,
  rippleProgress,
  ringsOf,
  type Ripple,
} from '@/composables/useWaterRipples'

/**
 * 画布涟漪的动画数学（07 §2.5「水波纹」）。副作用部分（rAF / 事件）依赖真实画布，
 * 在浏览器里走查；这里只测纯函数：进度、每圈半径/透明度/线宽、结束判定、绘制调用。
 */
describe('createRipple / rippleProgress', () => {
  it('三种涟漪：点击最大最强，划过最小最淡，雨滴居中', () => {
    const touch = createRipple('touch', 10, 20, 0)
    const move = createRipple('move', 10, 20, 0)
    const drop = createRipple('drop', 10, 20, 0)

    expect(touch).toMatchObject({ x: 10, y: 20, born: 0 })
    expect(touch.maxRadius).toBeGreaterThan(drop.maxRadius)
    expect(drop.maxRadius).toBeGreaterThan(move.maxRadius)
    expect(touch.strength).toBeGreaterThan(move.strength)
  })

  it('进度从 0 走到 1 并封顶；到时间即结束', () => {
    const ripple = createRipple('drop', 0, 0, 1000)

    expect(rippleProgress(ripple, 1000)).toBe(0)
    expect(rippleProgress(ripple, 1000 + ripple.life / 2)).toBeCloseTo(0.5)
    expect(rippleProgress(ripple, 1000 + ripple.life * 5)).toBe(1)
    expect(rippleProgress(ripple, 500)).toBe(0)

    expect(isRippleDone(ripple, 1000 + ripple.life - 1)).toBe(false)
    expect(isRippleDone(ripple, 1000 + ripple.life)).toBe(true)
  })
})

describe('ringsOf', () => {
  const ripple = createRipple('touch', 0, 0, 0)

  it('刚诞生时第一圈还没出现；开始后半径随时间向外、透明度衰减', () => {
    expect(ringsOf(ripple, 0)).toEqual([])

    const early = ringsOf(ripple, ripple.life * 0.2)
    const late = ringsOf(ripple, ripple.life * 0.8)

    expect(early.length).toBeGreaterThan(0)
    expect(late.length).toBeGreaterThan(0)
    expect(late[0]!.radius).toBeGreaterThan(early[0]!.radius)
    expect(late[0]!.alpha).toBeLessThan(early[0]!.alpha)
    expect(late[0]!.lineWidth).toBeLessThan(early[0]!.lineWidth)
  })

  it('半径不超过 maxRadius，透明度不超过 strength；同心环依次错开', () => {
    for (let step = 1; step < 20; step += 1) {
      for (const ring of ringsOf(ripple, (ripple.life * step) / 20)) {
        expect(ring.radius).toBeLessThanOrEqual(ripple.maxRadius)
        expect(ring.alpha).toBeLessThanOrEqual(ripple.strength)
        expect(ring.alpha).toBeGreaterThan(0)
      }
    }

    // 进度 25% 时：第 0 圈比第 1 圈走得更远
    const mid = ringsOf(ripple, ripple.life * 0.25)
    expect(mid.length).toBeGreaterThanOrEqual(2)
    expect(mid[0]!.radius).toBeGreaterThan(mid[1]!.radius)
  })

  it('结束后没有任何圈', () => {
    expect(ringsOf(ripple, ripple.life)).toEqual([])
  })
})

describe('drawRipples', () => {
  it('每个可见圈画一次圆弧，用传入的颜色，结束后恢复 globalAlpha', () => {
    const calls: string[] = []
    const ctx = {
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 0,
      beginPath: () => calls.push('beginPath'),
      arc: () => calls.push('arc'),
      stroke: () => calls.push('stroke'),
    } as unknown as CanvasRenderingContext2D

    const ripples: Ripple[] = [createRipple('drop', 5, 5, 0), createRipple('move', 9, 9, 0)]
    const now = 700
    const expectedRings = ripples.reduce((sum, ripple) => sum + ringsOf(ripple, now).length, 0)

    drawRipples(ctx, ripples, now, 'var-color')

    expect(expectedRings).toBeGreaterThan(0)
    expect(calls.filter((call) => call === 'arc')).toHaveLength(expectedRings)
    expect(ctx.strokeStyle).toBe('var-color')
    expect(ctx.globalAlpha).toBe(1)
  })
})
