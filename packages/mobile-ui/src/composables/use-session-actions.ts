/**
 * 把 ⋮ 菜单的纯动作逻辑（`lib/session-actions.ts`）接到 store / router 上。
 *
 * 组件里只写 `actions.rename()` / `actions.openUsage()`，不重复接线；
 * 判断逻辑本身在纯函数里，单测不依赖 pinia。
 */

import { useRouter } from 'vue-router'
import { createSessionActions } from '@/lib/session-actions'
import type { SessionActions } from '@/lib/session-actions'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'

export function useSessionActions(): SessionActions {
  const ui = useUiStore()
  const chat = useChatStore()
  const models = useModelsStore()
  const router = useRouter()

  return createSessionActions({
    sessionId: () => chat.activeId,
    canRename: () => models.features.includes('rename'),
    canArchive: () => models.features.includes('archive'),
    rename: (sessionId, title) => chat.renameSession(sessionId, title),
    archive: (sessionId, archived) => chat.archiveSession(sessionId, archived),
    openSidePanel: (kind) => ui.openSidePanel(kind),
    closeSessionMenu: () => ui.closeSessionMenu(),
    closeRenameDialog: () => ui.closeRenameDialog(),
    closeArchiveConfirm: () => ui.closeArchiveConfirm(),
    goHome: () => {
      void router.replace('/')
    },
  })
}
