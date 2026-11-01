import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 083（12 §7.0 / §8，WP13a）：`relay_models.default_thinking`（下发到 DSH 的默认思考档位）。
 *
 * 关键回归：**老库**升级后所有已有模型 `default_thinking = NULL`（升级本身不给任何模型设默认档位）；
 * 取值只能是 THINKING_LEVELS 或 NULL（CHECK 约束兜底）。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 把 `083` 之前的迁移拷进临时目录，用来造一个「老库」（只跑到 082） */
function oldMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-mig083-'))
  tempDirs.push(dir)
  const source = resolveMigrationsDir()
  for (const file of readdirSync(source)) {
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) < 83) {
      cpSync(join(source, file), join(dir, file))
    }
  }
  return dir
}

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

/** 老库里造两个对外模型（一个已勾选下发、一个没有） */
function seedOldModels(db: HubDb): void {
  const at = '2026-10-16T00:00:00.000Z'
  db.run(
    `INSERT INTO relay_models (name, display_name, enabled, visibility, dsh_enabled, price_input,
                               price_output, price_cache_read, price_cache_write, price_request,
                               info_json, compat_json, sort, created_at, updated_at)
     VALUES ('old-a', 'Old A', 1, 'all', 1, 100, 200, NULL, NULL, 0,
             '{"reasoningEfforts":["off","high"]}', NULL, 0, ?, ?),
            ('old-b', 'Old B', 1, 'all', 0, 0, 0, NULL, NULL, 0, '{}', NULL, 5, ?, ?)`,
    at,
    at,
    at,
    at,
  )
}

describe('迁移 083：默认思考档位列', () => {
  it('老库升级：default_thinking 列出现，所有已有模型都是 NULL（升级不改渲染）', () => {
    const db = openDb(':memory:')
    const dir = oldMigrationsDir()
    const before = runMigrations(db, { dir })
    expect(before.current).toBe('082')
    expect(columns(db, 'relay_models')).not.toContain('default_thinking')
    seedOldModels(db)

    // 补上 083 再跑一次 = 老库升级
    cpSync(join(resolveMigrationsDir(), '083_relay_default_thinking.sql'), join(dir, '083_relay_default_thinking.sql'))
    const after = runMigrations(db, { dir })
    expect(after.applied.map((m) => m.version)).toEqual(['083'])
    expect(columns(db, 'relay_models')).toContain('default_thinking')

    const rows = db.all<{ name: string; dsh_enabled: number; default_thinking: string | null }>(
      'SELECT name, dsh_enabled, default_thinking FROM relay_models ORDER BY name ASC',
    )
    expect(rows).toEqual([
      { name: 'old-a', dsh_enabled: 1, default_thinking: null },
      { name: 'old-b', dsh_enabled: 0, default_thinking: null },
    ])
    db.close()
  })

  it('新库：默认 NULL，可以设成合法档位；非法档位被 CHECK 拒绝', () => {
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
      db.get<{ default_thinking: string | null }>(
        "SELECT default_thinking FROM relay_models WHERE name = 'new-a'",
      )!.default_thinking,
    ).toBeNull()
    db.run("UPDATE relay_models SET default_thinking = 'xhigh' WHERE name = 'new-a'")
    expect(
      db.get<{ default_thinking: string | null }>(
        "SELECT default_thinking FROM relay_models WHERE name = 'new-a'",
      )!.default_thinking,
    ).toBe('xhigh')
    expect(() => {
      db.run("UPDATE relay_models SET default_thinking = 'ultra' WHERE name = 'new-a'")
    }).toThrow()
    db.close()
  })
})
