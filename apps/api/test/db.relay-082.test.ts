import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 082（12 §7.0 / §8，WP12a）：`relay_models.dsh_enabled`（是否下发到用户 DSH）。
 *
 * 关键回归：**老库**升级后所有已有模型 `dsh_enabled = 0`——用户 DSH 里的模型只来自管理员显式勾选的集合，
 * 不能让升级本身把历史模型全下发出去（默认模型与系统预设也要等管理员在「下发到 DSH」里配置）。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 把 `082` 之前的迁移拷进临时目录，用来造一个「老库」（只跑到 081） */
function oldMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-mig082-'))
  tempDirs.push(dir)
  const source = resolveMigrationsDir()
  for (const file of readdirSync(source)) {
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) < 82) {
      cpSync(join(source, file), join(dir, file))
    }
  }
  return dir
}

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

/** 老库里造两个对外模型（一个启用、一个停用） */
function seedOldModels(db: HubDb): void {
  const at = '2026-10-15T00:00:00.000Z'
  db.run(
    `INSERT INTO relay_models (name, display_name, enabled, visibility, price_input, price_output,
                               price_cache_read, price_cache_write, price_request, info_json, compat_json,
                               sort, created_at, updated_at)
     VALUES ('old-a', 'Old A', 1, 'all', 100, 200, NULL, NULL, 0, '{}', NULL, 0, ?, ?),
            ('old-b', 'Old B', 0, 'admin', 0, 0, NULL, NULL, 0, '{}', NULL, 5, ?, ?)`,
    at,
    at,
    at,
    at,
  )
}

describe('迁移 082：下发到 DSH 的勾选列', () => {
  it('老库升级：dsh_enabled 列出现，所有已有模型都是 0（不下发）', () => {
    const db = openDb(':memory:')
    const dir = oldMigrationsDir()
    const before = runMigrations(db, { dir })
    expect(before.current).toBe('081')
    expect(columns(db, 'relay_models')).not.toContain('dsh_enabled')
    seedOldModels(db)

    // 补上 082 再跑一次 = 老库升级
    cpSync(join(resolveMigrationsDir(), '082_relay_dsh.sql'), join(dir, '082_relay_dsh.sql'))
    const after = runMigrations(db, { dir })
    expect(after.applied.map((m) => m.version)).toEqual(['082'])
    expect(columns(db, 'relay_models')).toContain('dsh_enabled')

    const rows = db.all<{ name: string; dsh_enabled: number }>(
      'SELECT name, dsh_enabled FROM relay_models ORDER BY name ASC',
    )
    expect(rows).toEqual([
      { name: 'old-a', dsh_enabled: 0 },
      { name: 'old-b', dsh_enabled: 0 },
    ])
    db.close()
  })

  it('新库：新建模型默认 dsh_enabled = 0，可以置 1', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const at = '2026-10-16T00:00:00.000Z'
    db.run(
      `INSERT INTO relay_models (name, display_name, price_input, price_output, created_at, updated_at)
       VALUES ('new-a', 'New A', 1, 2, ?, ?)`,
      at,
      at,
    )
    expect(
      db.get<{ dsh_enabled: number }>("SELECT dsh_enabled FROM relay_models WHERE name = 'new-a'")!
        .dsh_enabled,
    ).toBe(0)
    db.run("UPDATE relay_models SET dsh_enabled = 1 WHERE name = 'new-a'")
    expect(
      db.get<{ dsh_enabled: number }>("SELECT dsh_enabled FROM relay_models WHERE name = 'new-a'")!
        .dsh_enabled,
    ).toBe(1)
    db.close()
  })
})
