import { describe, expect, it } from 'vitest'
import {
  RAIL_DOT,
  RAIL_JUMP_OFFSET,
  RAIL_LABEL_MAX,
  RAIL_PAD,
  jumpTop,
  marksInView,
  railLabel,
  railOffset,
  railOffsets,
  railTrackHeight,
  snapIndex,
} from '@/lib/question-rail'

describe('问题导航条：位置映射（§4.1）', () => {
  it('轨道高度 = 可视高度 - 上下各 12px', () => {
    expect(railTrackHeight(915)).toBe(915 - RAIL_PAD * 2)
    expect(railTrackHeight(100)).toBe(76)
    expect(railTrackHeight(0)).toBe(0)
    expect(railTrackHeight(Number.NaN)).toBe(0)
  })

  it('offsetTop / scrollHeight 映射到轨道高度', () => {
    expect(railOffset(0, 1000, 500)).toBe(0)
    expect(railOffset(500, 1000, 500)).toBe(250)
    expect(railOffset(1000, 1000, 500)).toBe(500)
  })

  it('越界与异常输入被夹住，不产生负坐标或越出轨道', () => {
    expect(railOffset(-20, 1000, 500)).toBe(0)
    expect(railOffset(2000, 1000, 500)).toBe(500)
    expect(railOffset(100, 0, 500)).toBe(0)
    expect(railOffset(100, 1000, 0)).toBe(0)
    expect(railOffsets([0, 250, 1000], 1000, 400)).toEqual([0, 100, 400])
  })

  it('跳转目标：消息顶部对齐到对话区顶部下方 12px（不会为负）', () => {
    expect(RAIL_JUMP_OFFSET).toBe(12)
    expect(jumpTop(300)).toBe(288)
    expect(jumpTop(4)).toBe(0)
  })
})

describe('问题导航条：吸附（§4.2）', () => {
  const positions = [0, 40, 80, 120]

  it('取最近的点', () => {
    expect(snapIndex(positions, 0)).toBe(0)
    expect(snapIndex(positions, 21)).toBe(1)
    expect(snapIndex(positions, 61)).toBe(2)
    expect(snapIndex(positions, 999)).toBe(3)
    expect(snapIndex([], 10)).toBe(-1)
  })

  it('正好等距时按拖动方向选（从上往下 → 下一个；从下往上 → 上一个）', () => {
    expect(snapIndex(positions, 20, 0)).toBe(1)
    expect(snapIndex(positions, 20, 1)).toBe(0)
    expect(snapIndex(positions, 20)).toBe(0)
  })

  it('两点挤在一起（< 6px）时仍能逐个吸附', () => {
    // 三条消息在轨道上只差 2px（内容很短/很挤）：视觉上重叠，但拖动仍逐个可达
    const crowded = [100, 102, 104]
    expect(snapIndex(crowded, 100, -1)).toBe(0)
    // 停在当前点上不动 → 不换点
    expect(snapIndex(crowded, 100, 0)).toBe(0)
    expect(snapIndex(crowded, 102, 1)).toBe(1)
    // 越过中点继续往下 → 吸附下一个（挤在一起也能逐个走）
    expect(snapIndex(crowded, 101, 0)).toBe(1)
    expect(snapIndex(crowded, 103, 1)).toBe(2)
    // 往上拖同理
    expect(snapIndex(crowded, 103, 2)).toBe(1)
    expect(snapIndex(crowded, 101, 1)).toBe(0)
  })

  it('当前视口里的提问点（用于放大高亮）', () => {
    const offsets = [0, 700, 1200, 2000]
    const heights = [120, 120, 120, 120]
    expect(marksInView(offsets, heights, 0, 900)).toEqual([0, 1])
    expect(marksInView(offsets, heights, 800, 900)).toEqual([1, 2])
    expect(marksInView(offsets, heights, 1900, 400)).toEqual([3])
    expect(marksInView([], [], 0, 900)).toEqual([])
    // 消息比视口还高时，只要与视口相交就算在视口里
    expect(marksInView([500], [2000], 1000, 900)).toEqual([0])
  })
})

describe('问题导航条：简述截断（§4.2）', () => {
  it('前 20 字、单行（空白压成空格）', () => {
    expect(RAIL_LABEL_MAX).toBe(20)
    expect(railLabel('  帮我\n看一下   这个问题怎么处理？ ')).toBe('帮我 看一下 这个问题怎么处理？')
    expect(railLabel('一二三四五六七八九十一二三四五六七八九十')).toBe(
      '一二三四五六七八九十一二三四五六七八九十',
    )
    expect(railLabel('一二三四五六七八九十一二三四五六七八九十超出')).toBe(
      '一二三四五六七八九十一二三四五六七八九十…',
    )
    expect(railLabel('')).toBe('（无内容）')
    expect(railLabel('短', 1)).toBe('短')
    expect(railLabel('两个字', 1)).toBe('两…')
  })

  it('圆点直径按设计稿 6px', () => {
    expect(RAIL_DOT).toBe(6)
  })
})
