/**
 * ⋮ 会话菜单里的动作（0.4.0 §1.2）：重命名、归档、打开两个右侧面板。
 *
 * 全部依赖从参数注入（store / router 由调用方接线），所以这里是纯逻辑：
 * 单测用假依赖就能锁住「调了谁、传了什么、成功后关哪一层、失败后不动」。
 * 组件（`SessionMenu.vue` / `RenameDialog.vue`）只做渲染与把 deps 接上。
 */

import type { SidePanelKind } from './side-panel'

export interface SessionActionsDeps {
  /** 当前打开的会话 id；没有会话（首页）时返回 null。 */
  sessionId(): string | null
  /** `models.features` 里有 rename。 */
  canRename(): boolean
  /** `models.features` 里有 archive。 */
  canArchive(): boolean
  /** `chat.renameSession`：store 负责乐观更新、失败回滚与 toast。 */
  rename(sessionId: string, title: string): Promise<boolean>
  /** `chat.archiveSession`：store 负责 toast 与 `newSession()`。 */
  archive(sessionId: string, archived: boolean): Promise<boolean>
  openSidePanel(kind: SidePanelKind): void
  closeSessionMenu(): void
  closeRenameDialog(): void
  closeArchiveConfirm(): void
  /** 归档成功回首页（归档的是当前会话，必须离开这一页）。 */
  goHome(): void
}

export interface SessionActions {
  /** 保存重命名（对话框的「保存」）。返回是否成功。 */
  rename(title: string): Promise<boolean>
  /** 执行归档（二次确认后的「归档」）。返回是否成功。 */
  archive(): Promise<boolean>
  /** 菜单项「Token 用量」。 */
  openUsage(): void
  /** 菜单项「连接诊断」。 */
  openDiagnostics(): void
}

export function createSessionActions(deps: SessionActionsDeps): SessionActions {
  function openPanel(kind: SidePanelKind): void {
    if (!deps.sessionId()) return
    deps.closeSessionMenu()
    deps.openSidePanel(kind)
  }

  return {
    async rename(title: string): Promise<boolean> {
      const sessionId = deps.sessionId()
      // 空标题不发请求：与「保存」按钮的 disabled 同一口径（服务端也会拒）。
      const trimmed = title.trim()
      if (!sessionId || trimmed.length === 0 || !deps.canRename()) return false
      const ok = await deps.rename(sessionId, trimmed)
      // 失败时对话框留着：store 已经 toast，用户可以直接改完再存。
      if (ok) deps.closeRenameDialog()
      return ok
    },

    async archive(): Promise<boolean> {
      const sessionId = deps.sessionId()
      if (!sessionId || !deps.canArchive()) {
        deps.closeArchiveConfirm()
        return false
      }
      const ok = await deps.archive(sessionId, true)
      if (!ok) {
        // 归档失败（例如 agent-busy）：关掉确认框，错误由 store 的 toast 说明。
        deps.closeArchiveConfirm()
        return false
      }
      deps.closeArchiveConfirm()
      deps.closeSessionMenu()
      deps.goHome()
      return true
    },

    openUsage(): void {
      openPanel('usage')
    },

    openDiagnostics(): void {
      openPanel('diagnostics')
    },
  }
}
