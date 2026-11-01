/**
 * 布局（WP58 / docs/26 §3.3、§5）的单测：`cockpit.layout` 的解析 + 应用。
 *
 * 三件事：
 *  1. 解析要**校验形状**（scale 必须是数字、sessions 只认 docked/menu），越界夹到 1–1.5；
 *  2. 应用只写 `<html style="zoom">`（scale=1 时删掉，避免出现 zoom:1 的实现差异）;
 *  3. 会话左栏宽度按 1 / 1.125 / 1.25 三个锚点 → 248 / 264 / 280。
 */

import { describe, expect, it, vi } from 'vitest'
import { parseCockpitIncoming } from '../src/lib/cockpit'
import {
  DEFAULT_COCKPIT_LAYOUT,
  applyCockpitZoom,
  cockpitLayoutState,
  dockedRailWidth,
} from '../src/lib/cockpit-layout'

describe('cockpit.layout 的解析（父 → 子）', () => {
  it('正常形状原样收下', () => {
    expect(parseCockpitIncoming({ type: 'cockpit.layout', scale: 1.25, sessions: 'docked' })).toEqual({
      type: 'cockpit.layout',
      scale: 1.25,
      sessions: 'docked',
    })
    expect(parseCockpitIncoming({ type: 'cockpit.layout', scale: 1, sessions: 'menu' })).toEqual({
      type: 'cockpit.layout',
      scale: 1,
      sessions: 'menu',
    })
  })

  it('越界夹到 1–1.5（太小/太大/浮点尾巴）', () => {
    const clamp = (scale: unknown) =>
      parseCockpitIncoming({ type: 'cockpit.layout', scale, sessions: 'docked' })
    expect(clamp(0.5)).toEqual({ type: 'cockpit.layout', scale: 1, sessions: 'docked' })
    expect(clamp(3)).toEqual({ type: 'cockpit.layout', scale: 1.5, sessions: 'docked' })
    expect(clamp(1.3333333)).toEqual({ type: 'cockpit.layout', scale: 1.333, sessions: 'docked' })
    // 数字字符串也认（父页面有时把 scale 塞进 query 再读回来）
    expect(clamp('1.125')).toEqual({ type: 'cockpit.layout', scale: 1.125, sessions: 'docked' })
  })

  it('形状不对就整条丢掉（不缩放也不要半个消息）', () => {
    expect(parseCockpitIncoming({ type: 'cockpit.layout', scale: 1 })).toBeNull()
    expect(
      parseCockpitIncoming({ type: 'cockpit.layout', scale: 1, sessions: 'sideways' }),
    ).toBeNull()
    expect(parseCockpitIncoming({ type: 'cockpit.layout', scale: NaN, sessions: 'menu' })).toBeNull()
    expect(
      parseCockpitIncoming({ type: 'cockpit.layout', scale: { value: 1 }, sessions: 'menu' }),
    ).toBeNull()
    expect(parseCockpitIncoming({ type: 'cockpit.layout', sessions: 'menu' })).toBeNull()
  })

  it('老的三条消息解析不变（不回归）', () => {
    expect(parseCockpitIncoming({ type: 'cockpit.prefill', text: 'hi' })).toEqual({
      type: 'cockpit.prefill',
      text: 'hi',
    })
    expect(parseCockpitIncoming({ type: 'cockpit.focus-session', sessionId: 's1' })).toEqual({
      type: 'cockpit.focus-session',
      sessionId: 's1',
    })
    expect(parseCockpitIncoming({ type: 'cockpit.unknown' })).toBeNull()
  })
})

describe('缩放的应用（applyCockpitZoom）', () => {
  it('写在 documentElement 的 inline zoom 上', () => {
    const root = { style: {} as { zoom?: string } }
    expect(applyCockpitZoom(1.25, root)).toBe(1.25)
    expect(root.style.zoom).toBe('1.25')
  })

  it('scale=1 用 removeProperty 删掉 zoom（delete 对 CSSStyleDeclaration 无效）', () => {
    const style: { zoom?: string; removeProperty?: (name: string) => void } = { zoom: '1.25' }
    style.removeProperty = (name: string) => {
      if (name === 'zoom') delete style.zoom
    }
    applyCockpitZoom(1, { style })
    expect(style.zoom).toBeUndefined()
    expect('zoom' in style).toBe(false)
  })

  it('没有 removeProperty 的老壳上退回 delete', () => {
    const root = { style: { zoom: '1.5' } as { zoom?: string; removeProperty?: (n: string) => void } }
    applyCockpitZoom(1, root)
    expect(root.style.zoom).toBeUndefined()
  })

  it('越界先夹再写；没有根元素时也不抛错', () => {
    const root = { style: {} as { zoom?: string } }
    expect(applyCockpitZoom(9, root)).toBe(1.5)
    expect(root.style.zoom).toBe('1.5')
    expect(() => applyCockpitZoom(1.25, null)).not.toThrow()
  })

  it('真的作用到 document.documentElement（浏览器路径）', () => {
    const style = { zoom: undefined as string | undefined }
    const root = { classList: { add: () => undefined }, dataset: {}, style }
    vi.stubGlobal('document', { documentElement: root })
    applyCockpitZoom(1.125, (globalThis as unknown as { document: typeof document }).document.documentElement)
    expect(style.zoom).toBe('1.125')
    vi.unstubAllGlobals()
  })
})

describe('会话左栏宽度（docs/26 §2.1）', () => {
  it('三个档位锚点：1 → 248、1.125 → 264、1.25 → 280', () => {
    expect(dockedRailWidth(1)).toBe(248)
    expect(dockedRailWidth(1.125)).toBe(264)
    expect(dockedRailWidth(1.25)).toBe(280)
  })

  it('两档之间线性插值、超出范围夹到端点', () => {
    expect(dockedRailWidth(1.0625)).toBe(256) // 248 + (264-248)/2
    expect(dockedRailWidth(0.8)).toBe(248)
    expect(dockedRailWidth(1.5)).toBe(280)
    expect(dockedRailWidth(Number.NaN)).toBe(248)
  })

  it('布局状态是归一化后的组合', () => {
    expect(cockpitLayoutState(1.25, 'docked')).toEqual({
      scale: 1.25,
      sessions: 'docked',
      docked: true,
      railWidth: 280,
    })
    expect(cockpitLayoutState(2, 'menu')).toEqual({
      scale: 1.5,
      sessions: 'menu',
      docked: false,
      railWidth: 280,
    })
  })

  it('默认布局：不缩放、会话列表走下拉（Hub 还没发 cockpit.layout 时）', () => {
    expect(DEFAULT_COCKPIT_LAYOUT).toEqual({
      scale: 1,
      sessions: 'menu',
      docked: false,
      railWidth: 248,
    })
  })
})
