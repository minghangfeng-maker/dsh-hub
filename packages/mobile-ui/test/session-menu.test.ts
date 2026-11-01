/**
 * ⋮ 会话菜单的纯逻辑（0.4.0 §1.2）：标题、菜单项与能力降级、归档二次确认文案。
 *
 * 锁住三件事：
 *  1) 菜单项顺序与文案（重命名 / Token 用量 / 连接诊断 / 归档）；
 *  2) 后端能力缺失时**置灰而不是隐藏**（用户点得到才知道为什么不行）；
 *  3) 归档确认文案要说清「不是删除、能从已归档找回」。
 */

import { describe, expect, it } from 'vitest'
import {
  archiveConfirmText,
  buildSessionMenuItems,
  sessionMenuHint,
  sessionMenuTitle,
} from '@/lib/session-menu'

const FULL = { hasSession: true, title: '今天的计划', canRename: true, canArchive: true }

describe('会话菜单标题', () => {
  it('空标题显示「新会话」，其它原样（去掉首尾空白）', () => {
    expect(sessionMenuTitle(null)).toBe('新会话')
    expect(sessionMenuTitle(undefined)).toBe('新会话')
    expect(sessionMenuTitle('   ')).toBe('新会话')
    expect(sessionMenuTitle('  今天的计划 ')).toBe('今天的计划')
  })
})

describe('会话菜单项', () => {
  it('从上到下：重命名 / Token 用量 / 连接诊断 / 归档（归档是红色破坏性动作）', () => {
    const items = buildSessionMenuItems(FULL)
    expect(items.map((item) => item.id)).toEqual(['rename', 'usage', 'diagnostics', 'archive'])
    expect(items.map((item) => item.label)).toEqual(['重命名', 'Token 用量', '连接诊断', '归档'])
    expect(items.filter((item) => item.danger).map((item) => item.id)).toEqual(['archive'])
    expect(items.every((item) => item.disabled === false)).toBe(true)
  })

  it('每项左侧都有 20px 图标：铅笔 / 柱状图 / 脉搏 / 归档盒（归档与文字同为红色）', () => {
    const items = buildSessionMenuItems(FULL)
    expect(items.map((item) => item.icon)).toEqual(['pencil', 'chart', 'pulse', 'archive'])
    // 图标是 AppIcon 里真实存在的名字（拼错会渲染成空 SVG）
    for (const item of items) expect(item.icon).toMatch(/^[a-z][A-Za-z]+$/)
    expect(items.every((item) => item.icon !== '')).toBe(true)
    // 归档项的图标跟随 danger（组件用 currentColor 同时染红文字与图标）
    expect(items.find((item) => item.id === 'archive')?.danger).toBe(true)
  })

  it('后端不支持 rename/archive 时置灰（不是隐藏），两个面板仍可点', () => {
    const items = buildSessionMenuItems({ ...FULL, canRename: false, canArchive: false })
    const byId = Object.fromEntries(items.map((item) => [item.id, item]))
    expect(byId.rename?.disabled).toBe(true)
    expect(byId.archive?.disabled).toBe(true)
    expect(byId.usage?.disabled).toBe(false)
    expect(byId.diagnostics?.disabled).toBe(false)
    // 置灰的项仍然在菜单里
    expect(items).toHaveLength(4)
  })

  it('没有打开的会话时全部置灰（防御：首页不显示 ⋮）', () => {
    const items = buildSessionMenuItems({ hasSession: false, title: null, canRename: true, canArchive: true })
    expect(items.every((item) => item.disabled)).toBe(true)
  })
})

describe('会话菜单提示', () => {
  it('能力齐备时没有提示', () => {
    expect(sessionMenuHint(FULL)).toBe('')
  })

  it('缺少能力时说明缺哪几个', () => {
    expect(sessionMenuHint({ ...FULL, canRename: false })).toBe('当前后端不支持重命名')
    expect(sessionMenuHint({ ...FULL, canArchive: false })).toBe('当前后端不支持归档')
    expect(sessionMenuHint({ ...FULL, canRename: false, canArchive: false })).toBe(
      '当前后端不支持重命名、归档',
    )
    expect(sessionMenuHint({ hasSession: false, title: null, canRename: true, canArchive: true })).toBe(
      '先打开一个会话',
    )
  })
})

describe('归档二次确认文案', () => {
  it('带上标题，并说明归档可以从「全部会话 → 已归档」找回', () => {
    const text = archiveConfirmText('今天的计划')
    expect(text).toContain('「今天的计划」')
    expect(text).toContain('全部会话')
    expect(text).toContain('已归档')
    expect(text).toContain('找回')
  })

  it('没有标题时用「新会话」，不会出现空引号', () => {
    expect(archiveConfirmText(null)).toContain('「新会话」')
  })
})
