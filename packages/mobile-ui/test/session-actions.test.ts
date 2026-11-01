/**
 * ⋮ 菜单里的动作（0.4.0 §1.2）：重命名、归档、打开两个右侧面板。
 *
 * 这里用假依赖直接调 `createSessionActions`（不 mount 组件、不需要 DOM）：
 * 断言「调了谁、传了什么、成功后关哪一层、失败后不动」。
 * 组件的接线在 `composables/use-session-actions.ts`，由 e2e 覆盖真实点击链路。
 */

import { describe, expect, it, vi } from 'vitest'
import { createSessionActions } from '@/lib/session-actions'
import type { SessionActionsDeps } from '@/lib/session-actions'

interface Harness {
  deps: SessionActionsDeps
  calls: {
    rename: Array<[string, string]>
    archive: Array<[string, boolean]>
    panel: string[]
    closeMenu: number
    closeRename: number
    closeConfirm: number
    goHome: number
  }
  renameResult: { value: boolean }
  archiveResult: { value: boolean }
}

function harness(overrides: Partial<SessionActionsDeps> = {}): Harness {
  const calls = {
    rename: [] as Array<[string, string]>,
    archive: [] as Array<[string, boolean]>,
    panel: [] as string[],
    closeMenu: 0,
    closeRename: 0,
    closeConfirm: 0,
    goHome: 0,
  }
  const renameResult = { value: true }
  const archiveResult = { value: true }
  const deps: SessionActionsDeps = {
    sessionId: () => 's_1',
    canRename: () => true,
    canArchive: () => true,
    rename: vi.fn(async (sessionId: string, title: string) => {
      calls.rename.push([sessionId, title])
      return renameResult.value
    }),
    archive: vi.fn(async (sessionId: string, archived: boolean) => {
      calls.archive.push([sessionId, archived])
      return archiveResult.value
    }),
    openSidePanel: (kind) => calls.panel.push(kind),
    closeSessionMenu: () => {
      calls.closeMenu += 1
    },
    closeRenameDialog: () => {
      calls.closeRename += 1
    },
    closeArchiveConfirm: () => {
      calls.closeConfirm += 1
    },
    goHome: () => {
      calls.goHome += 1
    },
    ...overrides,
  }
  return { deps, calls, renameResult, archiveResult }
}

describe('重命名', () => {
  it('保存时用 trim 后的标题，成功后关掉对话框', async () => {
    const h = harness()
    const actions = createSessionActions(h.deps)
    const ok = await actions.rename('  新的标题  ')
    expect(ok).toBe(true)
    expect(h.calls.rename).toEqual([['s_1', '新的标题']])
    expect(h.calls.closeRename).toBe(1)
  })

  it('失败时对话框留着（用户可以直接改完再存），也不回首页', async () => {
    const h = harness()
    h.renameResult.value = false
    const actions = createSessionActions(h.deps)
    expect(await actions.rename('新的标题')).toBe(false)
    expect(h.calls.closeRename).toBe(0)
    expect(h.calls.goHome).toBe(0)
  })

  it('空标题不发请求', async () => {
    const h = harness()
    const actions = createSessionActions(h.deps)
    expect(await actions.rename('   ')).toBe(false)
    expect(h.calls.rename).toEqual([])
    expect(h.calls.closeRename).toBe(0)
  })

  it('没有会话或后端不支持 rename 时不发请求', async () => {
    const noSession = harness({ sessionId: () => null })
    expect(await createSessionActions(noSession.deps).rename('标题')).toBe(false)
    expect(noSession.calls.rename).toEqual([])

    const noFeature = harness({ canRename: () => false })
    expect(await createSessionActions(noFeature.deps).rename('标题')).toBe(false)
    expect(noFeature.calls.rename).toEqual([])
  })
})

describe('归档', () => {
  it('确认后调 archiveSession(id, true)，成功则关确认框 + 收菜单 + 回首页', async () => {
    const h = harness()
    const actions = createSessionActions(h.deps)
    expect(await actions.archive()).toBe(true)
    expect(h.calls.archive).toEqual([['s_1', true]])
    expect(h.calls.closeConfirm).toBe(1)
    expect(h.calls.closeMenu).toBe(1)
    expect(h.calls.goHome).toBe(1)
  })

  it('归档失败（例如 agent-busy）只关确认框，不导航', async () => {
    const h = harness()
    h.archiveResult.value = false
    const actions = createSessionActions(h.deps)
    expect(await actions.archive()).toBe(false)
    expect(h.calls.closeConfirm).toBe(1)
    expect(h.calls.closeMenu).toBe(0)
    expect(h.calls.goHome).toBe(0)
  })

  it('没有会话或后端不支持归档时不发请求，但要收掉确认框', async () => {
    const noSession = harness({ sessionId: () => null })
    expect(await createSessionActions(noSession.deps).archive()).toBe(false)
    expect(noSession.calls.archive).toEqual([])
    expect(noSession.calls.closeConfirm).toBe(1)

    const noFeature = harness({ canArchive: () => false })
    expect(await createSessionActions(noFeature.deps).archive()).toBe(false)
    expect(noFeature.calls.archive).toEqual([])
  })
})

describe('打开右侧面板', () => {
  it('Token 用量：先收菜单再开面板', async () => {
    const h = harness()
    createSessionActions(h.deps).openUsage()
    expect(h.calls.closeMenu).toBe(1)
    expect(h.calls.panel).toEqual(['usage'])
  })

  it('连接诊断：先收菜单再开面板', async () => {
    const h = harness()
    createSessionActions(h.deps).openDiagnostics()
    expect(h.calls.closeMenu).toBe(1)
    expect(h.calls.panel).toEqual(['diagnostics'])
  })

  it('没有会话时不打开面板', async () => {
    const h = harness({ sessionId: () => null })
    createSessionActions(h.deps).openUsage()
    expect(h.calls.panel).toEqual([])
    expect(h.calls.closeMenu).toBe(0)
  })
})
