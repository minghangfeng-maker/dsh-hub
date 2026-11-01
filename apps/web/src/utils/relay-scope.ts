import type { RelayAgentMode, RelayScope } from '@dsh-hub/shared'

/**
 * 中转站「作用域」的界面文案与地址（18 D3）。
 *
 * `dsh` 是原来的「模型」页；`claude-code` / `codex` 各自一页。渠道、模型、用量记录都按作用域隔离，
 * 界面上显示成「来源」时 dsh 写成「DSH」。
 */
export const RELAY_SCOPE_LABEL: Record<RelayScope, string> = {
  dsh: 'DSH',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** 管理端每页的地址；dsh 回到「模型」页 */
export const RELAY_SCOPE_PAGE: Record<RelayScope, string> = {
  dsh: '/admin/models',
  'claude-code': '/admin/claude-code',
  codex: '/admin/codex',
}

/** 作用域的中文名；缺省（老后端没给）按 dsh 处理 */
export function relayScopeLabel(scope: RelayScope | string | null | undefined): string {
  return scope === 'claude-code' || scope === 'codex' ? RELAY_SCOPE_LABEL[scope] : RELAY_SCOPE_LABEL.dsh
}

/** 是不是两个对话模式之一 */
export function isAgentModeScope(scope: RelayScope | null | undefined): scope is RelayAgentMode {
  return scope === 'claude-code' || scope === 'codex'
}

/** 该作用域的页码地址（「去定价」这类跳转用） */
export function relayScopePage(scope: RelayScope): string {
  return RELAY_SCOPE_PAGE[scope] ?? RELAY_SCOPE_PAGE.dsh
}
