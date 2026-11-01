import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 081（12 §8，WP11a）：渠道加 `rate_permille`、用量加 `channel_rate_permille` 快照。
 *
 * 关键回归：**老库**升级后已有渠道倍率必须是 1000（×1.0，计费与升级前一致），老用量行的快照为 NULL
 * （不是 0——0 会被界面显示成「免费」）。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 把 `081` 之前的迁移拷进临时目录，用来造一个「老库」（只跑到 080） */
function oldMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-mig081-'))
  tempDirs.push(dir)
  const source = resolveMigrationsDir()
  for (const file of readdirSync(source)) {
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) < 81) {
      cpSync(join(source, file), join(dir, file))
    }
  }
  return dir
}

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

/** 老库里造一条渠道与一条用量（外键打开，先建一个用户） */
function seedOldRows(db: HubDb): void {
  const at = '2026-10-15T00:00:00.000Z'
  db.run(
    `INSERT INTO users (slug, username, password_hash, created_at, updated_at)
     VALUES ('uold001', 'old-user', 'x', ?, ?)`,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_channels (name, base_url, apis_json, created_at, updated_at)
     VALUES ('old-channel', 'https://old.example/v1', '["openai-completions"]', ?, ?)`,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_usage (request_id, created_at, user_id, model, channel_id, api, stream, source, status, cost)
     VALUES ('old-request', ?, 1, 'old-model', 1, 'openai-completions', 0, 'local', 'ok', 123)`,
    at,
  )
}

describe('迁移 081：渠道倍率与计费快照', () => {
  it('老库升级：已有渠道倍率 = 1000，老用量行 channel_rate_permille = NULL', () => {
    const db = openDb(':memory:')
    const dir = oldMigrationsDir()
    const before = runMigrations(db, { dir })
    expect(before.current).toBe('080')
    expect(columns(db, 'relay_channels')).not.toContain('rate_permille')
    seedOldRows(db)

    // 补上 081 再跑一次 = 老库升级
    cpSync(
      join(resolveMigrationsDir(), '081_relay_channel_rate.sql'),
      join(dir, '081_relay_channel_rate.sql'),
    )
    const after = runMigrations(db, { dir })
    expect(after.applied.map((m) => m.version)).toEqual(['081'])
    expect(columns(db, 'relay_channels')).toContain('rate_permille')
    expect(columns(db, 'relay_usage')).toContain('channel_rate_permille')

    const channel = db.get<{ rate_permille: number }>(
      'SELECT rate_permille FROM relay_channels WHERE name = ?',
      'old-channel',
    )!
    expect(channel.rate_permille).toBe(1000)
    const usage = db.get<{ channel_rate_permille: number | null }>(
      'SELECT channel_rate_permille FROM relay_usage WHERE request_id = ?',
      'old-request',
    )!
    expect(usage.channel_rate_permille).toBeNull()
    db.close()
  })

  it('新库：默认倍率 1000，取值范围 0–100000（越界被 CHECK 拒绝）', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const at = '2026-10-16T00:00:00.000Z'
    db.run(
      `INSERT INTO relay_channels (name, base_url, apis_json, created_at, updated_at)
       VALUES ('new-channel', 'https://new.example/v1', '["openai-completions"]', ?, ?)`,
      at,
      at,
    )
    expect(
      db.get<{ rate_permille: number }>(
        "SELECT rate_permille FROM relay_channels WHERE name = 'new-channel'",
      )!.rate_permille,
    ).toBe(1000)
    db.run("UPDATE relay_channels SET rate_permille = 0 WHERE name = 'new-channel'")
    db.run("UPDATE relay_channels SET rate_permille = 100000 WHERE name = 'new-channel'")
    expect(() =>
      db.run("UPDATE relay_channels SET rate_permille = 100001 WHERE name = 'new-channel'"),
    ).toThrow()
    expect(() => db.run("UPDATE relay_channels SET rate_permille = -1 WHERE name = 'new-channel'")).toThrow()
    db.close()
  })
})
