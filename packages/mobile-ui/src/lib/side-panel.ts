/**
 * 右侧全屏面板（0.4.0 §1.3）的面板种类与文案。
 *
 * 面板只有两种：Token 用量 / 连接诊断。类型放在这里（而不是 store 里），
 * 是为了让 `stores/ui.ts`、`lib/session-actions.ts` 与组件共用同一份定义，
 * 且单测不依赖 pinia。
 */

export type SidePanelKind = 'usage' | 'diagnostics'

/** 面板顶部标题（也用作 `aria-label`）。 */
export function sidePanelTitle(kind: SidePanelKind): string {
  return kind === 'usage' ? 'Token 用量' : '连接诊断'
}

/** 返回按钮的无障碍标签：带上面板名，读屏时能听出「关闭的是哪个面板」。 */
export function sidePanelCloseLabel(kind: SidePanelKind): string {
  return `关闭${sidePanelTitle(kind)}`
}

/** 是否是合法的面板种类（URL/事件/持久化恢复时用）。 */
export function isSidePanelKind(value: unknown): value is SidePanelKind {
  return value === 'usage' || value === 'diagnostics'
}
