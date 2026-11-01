import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SidePanelKind } from '@/lib/side-panel'
import { nextOverlayToClose } from '@/lib/overlay-stack'
import type { OverlayLayer, OverlaySnapshot } from '@/lib/overlay-stack'

/**
 * 全局 UI 状态：抽屉、会话菜单、右侧面板、对话框、底部弹层、toast。
 *
 * 返回键分层（0.4.0 §1.4）完全靠这里的 `consumeOverlay()`：
 *   全屏图片 → 右侧面板 → ⋮ 菜单 → 菜单/对话框 → 抽屉 → 底部弹层
 * 顺序的纯函数在 `lib/overlay-stack.ts`（单测锁住），这里只负责改对应的 ref。
 */
export const useUiStore = defineStore('ui', () => {
  const drawerOpen = ref(false)
  const modelSheetOpen = ref(false)
  const effortSheetOpen = ref(false)
  const plusSheetOpen = ref(false)

  /** ⋮ 会话菜单（对话页右上角，从下往上展开的那张卡片）。 */
  const sessionMenuOpen = ref(false)
  /**
   * 右侧全屏面板（Token 用量 / 连接诊断）。
   * 种类与开关分开存：关闭时保留种类，离场动画期间面板内容不会先变空。
   */
  const sidePanelOpen = ref(false)
  const sidePanelKind = ref<SidePanelKind>('usage')
  /** 菜单里的居中对话框：重命名 / 归档二次确认（同一时刻只会有一个）。 */
  const renameDialogOpen = ref(false)
  const archiveConfirmOpen = ref(false)

  /** 大图查看：当前图片的 fileRef（null = 关闭）。 */
  const imageViewerRef = ref<string | null>(null)
  /** 会话长按菜单：会话 id + 标题（null = 关闭）。 */
  const sessionAction = ref<{ sessionId: string; title: string } | null>(null)
  /**
   * 「预填输入框」（WP56d，docs/24 §6 的 `cockpit.prefill`）：画布上的「问 DSH」/「追问这一行」
   * 把上下文塞进来。用 `{text, at}` 而不是裸字符串：同一段文字连续发两次时靠 `at` 触发
   * 视图侧的 watcher（文字没变也算一次新请求）。
   */
  const prefillRequest = ref<{ text: string; at: number } | null>(null)
  const toastText = ref('')
  let toastTimer: ReturnType<typeof setTimeout> | null = null

  /** 关掉所有「覆盖在页面上的层」——打开某个层之前统一清场，永远只有一层遮罩。 */
  function closeSheets(): void {
    modelSheetOpen.value = false
    effortSheetOpen.value = false
    plusSheetOpen.value = false
  }

  function openDrawer(): void {
    closeSheets()
    sessionMenuOpen.value = false
    drawerOpen.value = true
  }
  function closeDrawer(): void {
    drawerOpen.value = false
  }
  function openModelSheet(): void {
    // 两个弹层互斥：芯片两段各自开一层，别叠出两层遮罩。
    effortSheetOpen.value = false
    modelSheetOpen.value = true
  }
  function closeModelSheet(): void {
    modelSheetOpen.value = false
  }
  function openEffortSheet(): void {
    modelSheetOpen.value = false
    effortSheetOpen.value = true
  }
  function closeEffortSheet(): void {
    effortSheetOpen.value = false
  }
  function openPlusSheet(): void {
    plusSheetOpen.value = true
  }
  function closePlusSheet(): void {
    plusSheetOpen.value = false
  }

  // ── ⋮ 会话菜单（0.4.0 §1.2）──────────────────────────────────────────────
  function openSessionMenu(): void {
    // 菜单贴在右上角，底下压着页面：先收掉抽屉/弹层，别叠三层。
    drawerOpen.value = false
    closeSheets()
    renameDialogOpen.value = false
    archiveConfirmOpen.value = false
    sessionMenuOpen.value = true
  }
  function closeSessionMenu(): void {
    sessionMenuOpen.value = false
  }
  function toggleSessionMenu(): void {
    if (sessionMenuOpen.value) closeSessionMenu()
    else openSessionMenu()
  }

  // ── 右侧全屏面板（0.4.0 §1.3）────────────────────────────────────────────
  /** 打开用量/诊断面板：菜单、对话框、抽屉、弹层全部收掉（面板占满全屏）。 */
  function openSidePanel(kind: SidePanelKind): void {
    sessionMenuOpen.value = false
    renameDialogOpen.value = false
    archiveConfirmOpen.value = false
    drawerOpen.value = false
    closeSheets()
    sidePanelKind.value = kind
    sidePanelOpen.value = true
  }
  function closeSidePanel(): void {
    sidePanelOpen.value = false
  }

  // ── 菜单里的对话框 ───────────────────────────────────────────────────────
  function openRenameDialog(): void {
    sessionMenuOpen.value = false
    archiveConfirmOpen.value = false
    renameDialogOpen.value = true
  }
  function closeRenameDialog(): void {
    renameDialogOpen.value = false
  }
  function openArchiveConfirm(): void {
    sessionMenuOpen.value = false
    renameDialogOpen.value = false
    archiveConfirmOpen.value = true
  }
  function closeArchiveConfirm(): void {
    archiveConfirmOpen.value = false
  }

  function openImageViewer(fileRef: string): void {
    imageViewerRef.value = fileRef
  }
  function closeImageViewer(): void {
    imageViewerRef.value = null
  }
  function openSessionActions(sessionId: string, title: string): void {
    sessionAction.value = { sessionId, title }
  }
  function closeSessionActions(): void {
    sessionAction.value = null
  }

  /** 请求把一段文字填进当前页面的输入框（父页面的 `cockpit.prefill`）。 */
  function requestPrefill(text: string): void {
    const value = text.trim()
    if (value === '') return
    prefillRequest.value = { text: value, at: Date.now() }
  }
  /** 视图把预填写进 `draft` 之后调用（同一段文字下次还要能再填一次）。 */
  function consumePrefill(): void {
    prefillRequest.value = null
  }

  function toast(text: string, ms = 2000): void {
    toastText.value = text
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastText.value = ''
      toastTimer = null
    }, ms)
  }

  /** 当前打开的层（给 `lib/overlay-stack` 的纯函数判断顺序）。 */
  function overlaySnapshot(): OverlaySnapshot {
    return {
      imageViewer: imageViewerRef.value !== null,
      sidePanel: sidePanelOpen.value,
      sessionMenu: sessionMenuOpen.value,
      dialog: renameDialogOpen.value || archiveConfirmOpen.value || sessionAction.value !== null,
      drawer: drawerOpen.value,
      bottomSheet: modelSheetOpen.value || effortSheetOpen.value || plusSheetOpen.value,
    }
  }

  function closeLayer(layer: OverlayLayer): void {
    switch (layer) {
      case 'imageViewer':
        imageViewerRef.value = null
        return
      case 'sidePanel':
        sidePanelOpen.value = false
        return
      case 'sessionMenu':
        sessionMenuOpen.value = false
        return
      case 'dialog':
        // 同一层里可能叠了「归档确认 + 会话长按菜单」：先关最上面的那个。
        if (archiveConfirmOpen.value) archiveConfirmOpen.value = false
        else if (renameDialogOpen.value) renameDialogOpen.value = false
        else sessionAction.value = null
        return
      case 'drawer':
        drawerOpen.value = false
        return
      case 'bottomSheet':
        if (plusSheetOpen.value) plusSheetOpen.value = false
        else if (effortSheetOpen.value) effortSheetOpen.value = false
        else modelSheetOpen.value = false
        return
    }
  }

  /** 返回键分层：按 §1.4 的顺序吃掉一层；没有可关的返回 false（交给路由）。 */
  function consumeOverlay(): boolean {
    const layer = nextOverlayToClose(overlaySnapshot())
    if (!layer) return false
    closeLayer(layer)
    return true
  }

  return {
    drawerOpen,
    modelSheetOpen,
    effortSheetOpen,
    plusSheetOpen,
    sessionMenuOpen,
    sidePanelOpen,
    sidePanelKind,
    renameDialogOpen,
    archiveConfirmOpen,
    imageViewerRef,
    sessionAction,
    prefillRequest,
    toastText,
    openDrawer,
    closeDrawer,
    openModelSheet,
    closeModelSheet,
    openEffortSheet,
    closeEffortSheet,
    openPlusSheet,
    closePlusSheet,
    openSessionMenu,
    closeSessionMenu,
    toggleSessionMenu,
    openSidePanel,
    closeSidePanel,
    openRenameDialog,
    closeRenameDialog,
    openArchiveConfirm,
    closeArchiveConfirm,
    openImageViewer,
    closeImageViewer,
    openSessionActions,
    closeSessionActions,
    requestPrefill,
    consumePrefill,
    toast,
    overlaySnapshot,
    consumeOverlay,
  }
})
