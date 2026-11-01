/**
 * Android 返回键层级（0.4.0 §1.4）的纯逻辑。
 *
 * 关闭顺序（自上而下，先关最上层的）：
 *   全屏图片 → 右侧面板 → ⋮ 菜单 → 菜单/对话框（重命名、归档确认、会话长按菜单）
 *            → 抽屉 → 底部弹层（模型 / 强度 / 加号）
 *
 * 都没有打开时返回 null，交给路由层：对话页回首页，首页退到桌面（不杀进程）。
 * 抽成纯函数是为了单测能直接摆出各种「叠了两层」的状态，逐个断言先关哪一层。
 */

/** 一次返回键会关掉哪一层。 */
export type OverlayLayer =
  | 'imageViewer'
  | 'sidePanel'
  | 'sessionMenu'
  | 'dialog'
  | 'drawer'
  | 'bottomSheet'

export interface OverlaySnapshot {
  /** 大图查看（全屏，永远在最上层）。 */
  imageViewer: boolean
  /** 右侧全屏面板（Token 用量 / 连接诊断）。 */
  sidePanel: boolean
  /** ⋮ 会话菜单。 */
  sessionMenu: boolean
  /**
   * 菜单/对话框：重命名、归档二次确认，以及抽屉里长按会话弹出的「会话操作」底部菜单。
   * 会话长按菜单算这一层（而不是底部弹层）：它可以从抽屉上打开，返回键必须先收它。
   */
  dialog: boolean
  /** 左侧抽屉。 */
  drawer: boolean
  /** 底部弹层：模型 / 强度 / 加号。 */
  bottomSheet: boolean
}

/**
 * 下一次返回键该关哪一层；没有可关的返回 null。
 *
 * 注意顺序是产品口径（§1.4），不是 z-index 顺序：
 * 抽屉排在底部弹层之前——虽然视觉上抽屉（41）比底部弹层（51）低，
 * 但真机上「抽屉开着、又从抽屉里点了会话长按菜单」时，用户期望先收起弹层；
 * 反过来叠着的情况（弹层开着再开抽屉）在 UI 上不会发生。
 */
export function nextOverlayToClose(snapshot: OverlaySnapshot): OverlayLayer | null {
  if (snapshot.imageViewer) return 'imageViewer'
  if (snapshot.sidePanel) return 'sidePanel'
  if (snapshot.sessionMenu) return 'sessionMenu'
  if (snapshot.dialog) return 'dialog'
  if (snapshot.drawer) return 'drawer'
  if (snapshot.bottomSheet) return 'bottomSheet'
  return null
}
