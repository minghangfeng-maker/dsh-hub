/**
 * Android 返回键层级（0.4.0 §1.4）。
 *
 * 两段：
 *  1) 纯函数 `nextOverlayToClose` 定顺序：全屏图片 → 右侧面板 → ⋮ 菜单 → 菜单/对话框
 *     → 抽屉 → 底部弹层，都没有则交回路由层；
 *  2) `ui.consumeOverlay()` 在真实 store 上按这个顺序逐层关（含「关了一层再按一次」的连续行为），
 *     以及打开某一层时把其它层收掉的互斥规则。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextOverlayToClose } from '@/lib/overlay-stack'
import type { OverlaySnapshot } from '@/lib/overlay-stack'
import { useUiStore } from '@/stores/ui'

const NONE: OverlaySnapshot = {
  imageViewer: false,
  sidePanel: false,
  sessionMenu: false,
  dialog: false,
  drawer: false,
  bottomSheet: false,
}

describe('返回键顺序（纯函数）', () => {
  it('只有一层时关它，全部关着返回 null（交给路由）', () => {
    expect(nextOverlayToClose({ ...NONE, imageViewer: true })).toBe('imageViewer')
    expect(nextOverlayToClose({ ...NONE, sidePanel: true })).toBe('sidePanel')
    expect(nextOverlayToClose({ ...NONE, sessionMenu: true })).toBe('sessionMenu')
    expect(nextOverlayToClose({ ...NONE, dialog: true })).toBe('dialog')
    expect(nextOverlayToClose({ ...NONE, drawer: true })).toBe('drawer')
    expect(nextOverlayToClose({ ...NONE, bottomSheet: true })).toBe('bottomSheet')
    expect(nextOverlayToClose(NONE)).toBeNull()
  })

  it('全叠在一起时按 §1.4 的顺序：图片 → 面板 → 菜单 → 对话框 → 抽屉 → 弹层', () => {
    const all: OverlaySnapshot = {
      imageViewer: true,
      sidePanel: true,
      sessionMenu: true,
      dialog: true,
      drawer: true,
      bottomSheet: true,
    }
    const order: string[] = []
    const state = { ...all }
    for (;;) {
      const layer = nextOverlayToClose(state)
      if (!layer) break
      order.push(layer)
      state[layer] = false
    }
    expect(order).toEqual([
      'imageViewer',
      'sidePanel',
      'sessionMenu',
      'dialog',
      'drawer',
      'bottomSheet',
    ])
  })

  it('右侧面板压在抽屉/弹层之上，抽屉压在底部弹层之上', () => {
    expect(nextOverlayToClose({ ...NONE, sidePanel: true, drawer: true, bottomSheet: true })).toBe(
      'sidePanel',
    )
    expect(nextOverlayToClose({ ...NONE, drawer: true, bottomSheet: true })).toBe('drawer')
  })
})

describe('返回键层级（ui store 实际关层）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('面板 → 菜单 → 抽屉依次被吃掉，最后返回 false', () => {
    const ui = useUiStore()
    ui.openSidePanel('usage')
    ui.openDrawer() // 抽屉不会盖住面板，但 store 允许手动叠（防御）
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.sidePanelOpen).toBe(false)
    expect(ui.drawerOpen).toBe(true)

    ui.openSessionMenu()
    expect(ui.drawerOpen).toBe(false) // 打开菜单先收抽屉（互斥）
    ui.drawerOpen = true
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.sessionMenuOpen).toBe(false)

    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.drawerOpen).toBe(false)
    expect(ui.consumeOverlay()).toBe(false)
  })

  it('重命名/归档对话框与「会话操作」菜单同属菜单/对话框层，先关最上面的', () => {
    const ui = useUiStore()
    ui.openArchiveConfirm()
    expect(ui.archiveConfirmOpen).toBe(true)
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.archiveConfirmOpen).toBe(false)

    ui.openRenameDialog()
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.renameDialogOpen).toBe(false)

    // 抽屉里长按会话 → 会话操作菜单；返回键必须先收它，而不是收下面的抽屉
    ui.openDrawer()
    ui.openSessionActions('s_1', '今天的计划')
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.sessionAction).toBeNull()
    expect(ui.drawerOpen).toBe(true)
  })

  it('底部弹层最后关（模型 / 强度 / 加号）', () => {
    const ui = useUiStore()
    ui.openModelSheet()
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.modelSheetOpen).toBe(false)

    ui.openEffortSheet()
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.effortSheetOpen).toBe(false)

    ui.openPlusSheet()
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.plusSheetOpen).toBe(false)

    ui.openImageViewer('file-1')
    expect(ui.consumeOverlay()).toBe(true)
    expect(ui.imageViewerRef).toBeNull()
  })

  it('打开面板/菜单时互斥地收掉其它层，永远只留一层', () => {
    const ui = useUiStore()
    ui.openDrawer()
    ui.openModelSheet()
    ui.openSidePanel('diagnostics')
    expect(ui.sidePanelKind).toBe('diagnostics')
    expect(ui.sidePanelOpen).toBe(true)
    expect(ui.drawerOpen).toBe(false)
    expect(ui.modelSheetOpen).toBe(false)

    // 关闭后保留种类：离场动画期间面板内容不会先变空
    ui.closeSidePanel()
    expect(ui.sidePanelOpen).toBe(false)
    expect(ui.sidePanelKind).toBe('diagnostics')
  })

  it('打开菜单会收掉抽屉、弹层与对话框', () => {
    const ui = useUiStore()
    ui.openDrawer()
    ui.openPlusSheet()
    ui.openArchiveConfirm()
    ui.openSessionMenu()
    expect(ui.sessionMenuOpen).toBe(true)
    expect(ui.drawerOpen).toBe(false)
    expect(ui.plusSheetOpen).toBe(false)
    expect(ui.archiveConfirmOpen).toBe(false)
    // 再点一次 ⋮ 收起
    ui.toggleSessionMenu()
    expect(ui.sessionMenuOpen).toBe(false)
  })
})
