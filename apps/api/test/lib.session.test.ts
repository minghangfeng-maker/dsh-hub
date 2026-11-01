import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { createTestClock } from '../src/lib/clock.js'
import {
  createSession,
  hasRecentReauth,
  resolveSession,
  revokeSession,
  revokeUserSessions,
  countActiveSessions,
  touchSession,
} from '../src/lib/session.js'

function makeDb() {
  const db = openDb(':memory:')
  runMigrations(db)
  const now = '2026-10-12T13:00:00.000Z'
  db.run(
    `INSERT INTO users (id, slug, username, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (1, 'u7k2m9xz', 'alice', '爱丽丝', 'x', 'user', 'active', ?, ?)`,
    now,
    now,
  )
  db.run(
    `INSERT INTO users (id, slug, username, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (2, 'u8k2m9xy', 'bob', '鲍勃', 'x', 'user', 'disabled', ?, ?)`,
    now,
    now,
  )
  return db
}

describe('会话基础设施（02 §5）', () => {
  it('token → sha256 存库，解析出用户', () => {
    const db = makeDb()
    const { token, id, expiresAt } = createSession(db, {
      userId: 1,
      token: 'plain-token',
      now: '2026-10-12T13:00:00.000Z',
    })
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(expiresAt > '2026-10-12T13:00:00.000Z').toBe(true)
    const row = db.get<{ id: string }>('SELECT id FROM sessions WHERE user_id = 1')
    expect(row?.id).toBe(id)
    expect(JSON.stringify(row)).not.toContain('plain-token')

    const user = resolveSession(db, token, '2026-10-12T13:00:01.000Z')
    expect(user).toMatchObject({
      id: 1,
      username: 'alice',
      slug: 'u7k2m9xz',
      status: 'active',
      sessionId: id,
    })
    db.close()
  })

  it('未知 token / 空 token / 超长 token 返回 null', () => {
    const db = makeDb()
    createSession(db, { userId: 1, token: 'plain-token', now: '2026-10-12T13:00:00.000Z' })
    expect(resolveSession(db, 'other-token', '2026-10-12T13:00:01.000Z')).toBeNull()
    expect(resolveSession(db, '', '2026-10-12T13:00:01.000Z')).toBeNull()
    expect(resolveSession(db, 'x'.repeat(600), '2026-10-12T13:00:01.000Z')).toBeNull()
    db.close()
  })

  it('吊销 / 过期 / 停用 / 软删除都视为未登录', () => {
    const db = makeDb()
    const a = createSession(db, { userId: 1, token: 't1', now: '2026-10-12T13:00:00.000Z', ttlDays: 30 })
    expect(resolveSession(db, 't1', '2026-10-12T13:00:01.000Z')).not.toBeNull()
    revokeSession(db, a.id, '2026-10-12T13:05:00.000Z')
    expect(resolveSession(db, 't1', '2026-10-12T13:05:01.000Z')).toBeNull()

    createSession(db, { userId: 1, token: 't2', now: '2026-10-12T13:00:00.000Z', ttlDays: 1 })
    expect(resolveSession(db, 't2', '2026-10-20T13:00:00.000Z')).toBeNull()

    // 停用用户
    const b = createSession(db, { userId: 2, token: 't3', now: '2026-10-12T13:00:00.000Z' })
    expect(b.id).toMatch(/^[0-9a-f]{64}$/)
    expect(resolveSession(db, 't3', '2026-10-12T13:00:01.000Z')).toBeNull()

    // 软删除用户
    db.run("UPDATE users SET deleted_at = '2026-10-12T14:00:00.000Z' WHERE id = 1")
    createSession(db, { userId: 1, token: 't4', now: '2026-10-12T13:00:00.000Z' })
    expect(resolveSession(db, 't4', '2026-10-12T13:00:01.000Z')).toBeNull()
    db.close()
  })

  it('管理员会话受绝对时长限制', () => {
    const db = makeDb()
    const { expiresAt } = createSession(db, {
      userId: 1,
      token: 'admin-token',
      now: '2026-10-12T13:00:00.000Z',
      ttlDays: 30,
      isAdmin: true,
      adminSessionHours: 12,
    })
    expect(expiresAt).toBe('2026-10-13T01:00:00.000Z')
    db.close()
  })

  it('revokeUserSessions 可保留当前会话，countActiveSessions 只数有效会话', () => {
    const db = makeDb()
    const keep = createSession(db, { userId: 1, token: 'keep', now: '2026-10-12T13:00:00.000Z' })
    createSession(db, { userId: 1, token: 'other1', now: '2026-10-12T13:00:00.000Z' })
    createSession(db, { userId: 1, token: 'other2', now: '2026-10-12T13:00:00.000Z' })
    expect(countActiveSessions(db, 1, '2026-10-12T13:00:01.000Z')).toBe(3)
    const revoked = revokeUserSessions(db, 1, '2026-10-12T13:10:00.000Z', keep.id)
    expect(revoked).toBe(2)
    expect(countActiveSessions(db, 1, '2026-10-12T13:10:01.000Z')).toBe(1)
    expect(revokeUserSessions(db, 1, '2026-10-12T13:11:00.000Z')).toBe(1)
    expect(countActiveSessions(db, 1, '2026-10-12T13:11:01.000Z')).toBe(0)
    db.close()
  })

  it('touchSession 刷新 last_seen_at', () => {
    const db = makeDb()
    const s = createSession(db, { userId: 1, token: 't', now: '2026-10-12T13:00:00.000Z' })
    touchSession(db, s.id, '2026-10-12T13:30:00.000Z')
    const row = db.get<{ last_seen_at: string }>('SELECT last_seen_at FROM sessions WHERE id = ?', s.id)
    expect(row?.last_seen_at).toBe('2026-10-12T13:30:00.000Z')
    db.close()
  })

  it('hasRecentReauth 按窗口判断', () => {
    expect(hasRecentReauth({ reauthAt: null }, '2026-10-12T13:00:00.000Z', 10)).toBe(false)
    expect(hasRecentReauth({ reauthAt: '2026-10-12T12:55:00.000Z' }, '2026-10-12T13:00:00.000Z', 10)).toBe(
      true,
    )
    expect(hasRecentReauth({ reauthAt: '2026-10-12T12:45:00.000Z' }, '2026-10-12T13:00:00.000Z', 10)).toBe(
      false,
    )
  })

  it('时钟工具与可控时钟', () => {
    const clock = createTestClock('2026-10-12T13:00:00.000Z')
    expect(clock.nowIso()).toBe('2026-10-12T13:00:00.000Z')
    clock.advance(60_000)
    expect(clock.nowIso()).toBe('2026-10-12T13:01:00.000Z')
    clock.set('2026-01-01T00:00:00.000Z')
    expect(clock.nowIso()).toBe('2026-01-01T00:00:00.000Z')
  })
})
