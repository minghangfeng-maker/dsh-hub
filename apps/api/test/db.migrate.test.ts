import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { loadMigrations, resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-migrate-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('迁移执行器', () => {
  it('从空库跑出全部迁移并记录 schema_migrations', () => {
    const db = openDb(':memory:')
    // 不断言固定的迁移清单：各任务包往自己的编号段里加文件，这里只要求「全跑且顺序正确」
    const all = loadMigrations()
    const expected = all.map((m) => `${m.version}_${m.name}`)
    const result = runMigrations(db)
    expect(result.applied.map((m) => `${m.version}_${m.name}`)).toEqual(expected)
    expect(result.current).toBe(all[all.length - 1]!.version)
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((r) => r.name)
    for (const table of [
      'audit_logs',
      'schema_migrations',
      'sessions',
      'settings',
      'users',
      'invites',
      'invite_uses',
      'instances',
    ]) {
      expect(tables).toContain(table)
    }
    const rows = db.all<{ version: string; applied_at: string }>(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
    )
    expect(rows).toHaveLength(expected.length)
    expect(rows[0]!.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    db.close()
  })

  it('DDL 与 03 §1.1 一致（关键列存在）', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const userCols = db.all<{ name: string }>('PRAGMA table_info(users)').map((r) => r.name)
    expect(userCols).toEqual(
      expect.arrayContaining([
        'slug',
        'username',
        'display_name',
        'bio',
        'avatar_file',
        'password_hash',
        'role',
        'status',
        'must_change_password',
        'quota_json',
        'runtime_id',
        'model_preset_id',
        'model_policy',
        'username_changed_at',
        'last_login_at',
        'last_login_ip',
        'created_at',
        'updated_at',
        'deleted_at',
      ]),
    )
    const sessionCols = db.all<{ name: string }>('PRAGMA table_info(sessions)').map((r) => r.name)
    expect(sessionCols).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'created_at',
        'last_seen_at',
        'expires_at',
        'reauth_at',
        'ip',
        'user_agent',
        'revoked_at',
      ]),
    )
    // 外键级联：删用户会带走会话
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1)
    db.close()
  })

  it('重复执行是幂等的（第二次全部跳过）', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const second = runMigrations(db)
    expect(second.applied).toEqual([])
    expect(second.skipped).toHaveLength(loadMigrations().length)
    expect(second.current).toBe(loadMigrations().at(-1)!.version)
    db.close()
  })

  it('迁移失败会回滚，且不记录版本', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '000_ok.sql'), 'CREATE TABLE ok (id INTEGER PRIMARY KEY);')
    writeFileSync(
      join(dir, '001_broken.sql'),
      'CREATE TABLE broken (id INTEGER PRIMARY KEY); THIS IS NOT SQL;',
    )
    const db: HubDb = openDb(':memory:')
    expect(() => runMigrations(db, { dir })).toThrow()
    const versions = db
      .all<{ version: string }>('SELECT version FROM schema_migrations')
      .map((r) => r.version)
    expect(versions).toEqual(['000'])
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    expect(tables).not.toContain('broken')
    db.close()
  })

  it('文件名不合规 / 编号重复直接报错', () => {
    const bad = tempDir()
    writeFileSync(join(bad, 'init.sql'), 'SELECT 1;')
    expect(() => loadMigrations(bad)).toThrow(/文件名不合法/)

    const dup = tempDir()
    writeFileSync(join(dup, '000_a.sql'), 'SELECT 1;')
    writeFileSync(join(dup, '000_b.sql'), 'SELECT 1;')
    expect(() => loadMigrations(dup)).toThrow(/编号重复/)

    expect(() => loadMigrations(join(bad, 'not-exist'))).toThrow(/迁移目录不存在/)
  })

  it('默认目录能解析到仓库里的 migrations（源码与 dist 都可用）', () => {
    const dir = resolveMigrationsDir()
    expect(dir.endsWith(join('db', 'migrations'))).toBe(true)
    expect(loadMigrations(dir).length).toBeGreaterThanOrEqual(2)
  })
})
