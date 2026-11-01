/**
 * ⋮ 会话菜单的纯逻辑（0.4.0 §1.2）：标题行、菜单项与能力降级、归档二次确认文案。
 *
 * 抽成纯函数是为了能在 node 环境里单测「哪些项出现 / 哪些置灰」——
 * 组件（`SessionMenu.vue`）只负责渲染与焦点，不做判断。
 */

export type SessionMenuItemId = 'rename' | 'usage' | 'diagnostics' | 'archive'

export interface SessionMenuItem {
  id: SessionMenuItemId
  label: string
  /** 左侧 20px 线性图标（`AppIcon` 的名字）：铅笔 / 柱状图 / 脉搏 / 归档盒。 */
  icon: string
  /** 置灰不可点：没有打开的会话，或后端不支持该能力。 */
  disabled: boolean
  /** 破坏性动作（红色文字与图标，参照 Claude 的「删除」）。 */
  danger?: boolean
}

export interface SessionMenuInput {
  /** 有没有打开的会话（首页没有 ⋮，所以正常恒为 true；置灰逻辑仍按它判断）。 */
  hasSession: boolean
  /** 当前会话标题（服务端原始值，可能为空）。 */
  title: string | null | undefined
  /** `models.features` 里有 rename。 */
  canRename: boolean
  /** `models.features` 里有 archive。 */
  canArchive: boolean
}

/** 菜单顶部那行标题：空标题显示「新会话」（与抽屉、会话列表同一口径）。 */
export function sessionMenuTitle(title: string | null | undefined): string {
  const trimmed = (title ?? '').trim()
  return trimmed.length > 0 ? trimmed : '新会话'
}

/**
 * 菜单项（从上到下）：重命名 / Token 用量 / 连接诊断 / 归档。
 *
 * - 每项带一个 20px 线性图标（铅笔 / 柱状图 / 脉搏 / 归档盒），标题行不带图标；
 * - 没有会话时全部置灰（菜单本身不该出现，防御性）；
 * - 后端 features 不含 rename/archive 时对应项置灰（不隐藏：用户点得到才知道为什么不行）；
 * - 「连接诊断」读本地事件 + 链路状态，不依赖后端能力，只要会话在就永远可点。
 */
export function buildSessionMenuItems(input: SessionMenuInput): SessionMenuItem[] {
  const hasSession = input.hasSession
  return [
    { id: 'rename', label: '重命名', icon: 'pencil', disabled: !hasSession || !input.canRename },
    { id: 'usage', label: 'Token 用量', icon: 'chart', disabled: !hasSession },
    { id: 'diagnostics', label: '连接诊断', icon: 'pulse', disabled: !hasSession },
    { id: 'archive', label: '归档', icon: 'archive', disabled: !hasSession || !input.canArchive, danger: true },
  ]
}

/** 置灰项的提示文案（菜单底部小字，避免用户以为是坏了）。 */
export function sessionMenuHint(input: SessionMenuInput): string {
  if (!input.hasSession) return '先打开一个会话'
  const missing: string[] = []
  if (!input.canRename) missing.push('重命名')
  if (!input.canArchive) missing.push('归档')
  if (missing.length === 0) return ''
  return `当前后端不支持${missing.join('、')}`
}

/**
 * 归档二次确认文案（§1.2 第 5 条）：
 * 明确告诉用户「归档 ≠ 删除」，还能在「全部会话 → 已归档」里找回。
 */
export function archiveConfirmText(title: string | null | undefined): string {
  return `「${sessionMenuTitle(title)}」归档后会从列表隐藏，可在「全部会话 → 已归档」里找回。`
}
