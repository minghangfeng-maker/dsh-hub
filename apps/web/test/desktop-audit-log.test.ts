import type { AuditItem } from '@dsh-hub/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_AUDIT_ACTIONS, listDesktopAuditLog } from '@/api/admin-desktop'

/**
 * 发布日志合并查询（WP25f 交付物 5）：
 * WP25d 是按 5 个动作各查一次（`action=`）再合并；WP25e 有了 `actionPrefix`，
 * 这里必须**只发一次请求**，且按时间倒序截断的结果与原来一致。
 */
function auditItem(id: number, action: string, minutesAgo: number): AuditItem {
  return {
    id,
    at: new Date(Date.UTC(2026, 9, 22, 12, 0, 0) - minutesAgo * 60_000).toISOString(),
    actorId: 1,
    actorIp: '203.0.113.7',
    actorUsername: 'admin',
    action,
    targetType: 'desktop.delivery',
    targetId: String(id),
    detail: { scope: 'all' },
  }
}

/** 服务端按时间倒序返回「最近 100 条桌面动作」，里面混着发布类与台账类动作 */
const ALL_DESKTOP_ACTIONS: AuditItem[] = [
  auditItem(1, 'desktop.deliver', 1),
  auditItem(2, 'desktop.admin-revoke', 2),
  auditItem(3, 'desktop.release.publish', 3),
  auditItem(4, 'desktop.rename', 4),
  auditItem(5, 'desktop.release.rollback', 5),
  auditItem(6, 'desktop.update-floor.set', 6),
  auditItem(7, 'desktop.plugin-package.upload', 7),
  auditItem(8, 'desktop.login', 8),
  auditItem(9, 'desktop.deliver', 9),
]

const calls: string[] = []

function stubFetch(items: AuditItem[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(
        JSON.stringify({ items, total: items.length, page: 1, pageSize: items.length }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  )
}

afterEach(() => {
  calls.length = 0
  vi.unstubAllGlobals()
})

describe('发布日志：一次 actionPrefix 查询', () => {
  it('只发一次请求，且用 actionPrefix=desktop.（不再按 5 个动作并发查）', async () => {
    stubFetch(ALL_DESKTOP_ACTIONS)
    await listDesktopAuditLog(20)

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!, 'http://127.0.0.1:5256')
    expect(url.pathname).toBe('/api/admin/audit')
    expect(url.searchParams.get('actionPrefix')).toBe('desktop.')
    expect(url.searchParams.get('action')).toBeNull()
    expect(url.searchParams.get('pageSize')).toBe('100')
  })

  it('结果与「按 5 个动作合并」一致：只留发布类动作、按时间倒序、截断到 pageSize', async () => {
    stubFetch(ALL_DESKTOP_ACTIONS)
    const first = await listDesktopAuditLog(20)

    // 与旧实现的合并结果逐条对一遍（旧实现 = 5 次精确查询后的合并排序截断）
    const merged = ALL_DESKTOP_ACTIONS.filter((item) =>
      (DESKTOP_AUDIT_ACTIONS as readonly string[]).includes(item.action),
    )
      .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
      .slice(0, 20)
    expect(first.map((item) => item.id)).toEqual(merged.map((item) => item.id))
    // 台账类动作（吊销 / 改名 / 登录）不进发布日志
    expect(first.map((item) => item.action)).not.toContain('desktop.admin-revoke')
    expect(first.map((item) => item.action)).not.toContain('desktop.rename')

    stubFetch(ALL_DESKTOP_ACTIONS)
    const limited = await listDesktopAuditLog(2)
    expect(limited.map((item) => item.id)).toEqual([1, 3])
  })
})
