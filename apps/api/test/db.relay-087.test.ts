import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 087（18 §2，WP23a）：
 * - 渠道 / 对外模型 / 密钥 / 用量加 `scope`，默认 `dsh`（老数据行为不变）；
 * - system 密钥的唯一索引从「每人一把」变成「每人每作用域一把」；
 * - 用量加 `mode_rate_permille` 快照与 `(scope, created_at)` 索引，日汇总加 `scope`；
 * - 各表行数一个都不少。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function oldMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-mig087-'))
  tempDirs.push(dir)
  const source = resolveMigrationsDir()
  for (const file of readdirSync(source)) {
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) < 87) {
      cpSync(join(source, file), join(dir, file))
    }
  }
  return dir
}

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

function count(db: HubDb, table: string): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0)
}

function upgrade(db: HubDb, dir: string): void {
  cpSync(join(resolveMigrationsDir(), '087_relay_agent_modes.sql'), join(dir, '087_relay_agent_modes.sql'))
  const after = runMigrations(db, { dir })
  expect(after.applied.map((m) => m.version)).toEqual(['087'])
}

function seedOld(db: HubDb): void {
  const at = '2026-10-19T00:00:00.000Z'
  db.run(
    `INSERT INTO users (id, slug, username, display_name, password_hash, created_at, updated_at)
     VALUES (1, 'u1', 'u1', 'U1', 'x', ?, ?), (2, 'u2', 'u2', 'U2', 'x', ?, ?)`,
    at,
    at,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_channels (id, name, base_url, apis_json, created_at, updated_at)
     VALUES (1, 'ch', 'https://a.example/v1', '["openai-completions"]', ?, ?)`,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_models (id, name, display_name, enabled, visibility,
                               price_input, price_output, created_at, updated_at)
     VALUES (1, 'm', 'M', 1, 'all', 1, 2, ?, ?)`,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_routes (id, model_id, channel_id, upstream_model, enabled) VALUES (1, 1, 1, 'up', 1)`,
  )
  // 迁移前：每人只有一把 system 密钥
  db.run(
    `INSERT INTO relay_keys (id, user_id, kind, name, key_hash, key_enc, preview, created_at)
     VALUES (1, 1, 'system', 'DSH 内置', 'h1', 'k1', 'p1', ?),
            (2, 2, 'system', 'DSH 内置', 'h2', 'k2', 'p2', ?),
            (3, 1, 'user', '自建', 'h3', NULL, 'p3', ?)`,
    at,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_usage (request_id, created_at, user_id, key_id, model, api, stream, source, status)
     VALUES ('r1', ?, 1, 1, 'm', 'openai-completions', 0, 'local', 'ok')`,
    at,
  )
  db.run(
    `INSERT INTO relay_usage_daily (day, user_id, model, channel_id, requests, cost)
     VALUES ('2026-10-19', 1, 'm', 1, 1, 3)`,
  )
}

describe('迁移 087：作用域', () => {
  it('老库升级：列出现、默认 dsh、行数不变、原 system 密钥沿用', () => {
    const db = openDb(':memory:')
    const dir = oldMigrationsDir()
    expect(runMigrations(db, { dir }).current).toBe('086')
    seedOld(db)
    const before = {
      channels: count(db, 'relay_channels'),
      models: count(db, 'relay_models'),
      keys: count(db, 'relay_keys'),
      usage: count(db, 'relay_usage'),
      daily: count(db, 'relay_usage_daily'),
    }

    expect(columns(db, 'relay_channels')).not.toContain('scope')
    expect(columns(db, 'relay_usage')).not.toContain('mode_rate_permille')
    upgrade(db, dir)

    expect(columns(db, 'relay_channels')).toContain('scope')
    expect(columns(db, 'relay_models')).toContain('scope')
    expect(columns(db, 'relay_keys')).toContain('scope')
    expect(columns(db, 'relay_usage')).toEqual(expect.arrayContaining(['scope', 'mode_rate_permille']))
    expect(columns(db, 'relay_usage_daily')).toContain('scope')

    expect({
      channels: count(db, 'relay_channels'),
      models: count(db, 'relay_models'),
      keys: count(db, 'relay_keys'),
      usage: count(db, 'relay_usage'),
      daily: count(db, 'relay_usage_daily'),
    }).toEqual(before)

    // 老数据全部 = dsh
    for (const table of [
      'relay_channels',
      'relay_models',
      'relay_keys',
      'relay_usage',
      'relay_usage_daily',
    ]) {
      expect(db.all<{ scope: string }>(`SELECT DISTINCT scope FROM ${table}`)).toEqual([{ scope: 'dsh' }])
    }
    expect(
      db.get<{ mode_rate_permille: number | null }>(
        'SELECT mode_rate_permille FROM relay_usage WHERE id = 1',
      ),
    ).toEqual({ mode_rate_permille: null })
    // 原有 dsh system 密钥还是「生效中的 system 密钥」
    expect(
      db.all<{ id: number }>(
        "SELECT id FROM relay_keys WHERE kind = 'system' AND scope = 'dsh' AND revoked_at IS NULL ORDER BY id",
      ),
    ).toEqual([{ id: 1 }, { id: 2 }])
    // 新索引与 scope 索引都在
    const indexes = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining(['relay_keys_one_system', 'relay_usage_scope_time']))
    db.close()
  })

  it('system 密钥唯一索引：同一用户每个作用域一把，同作用域不能有两把', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const at = '2026-10-19T00:00:00.000Z'
    db.run(
      `INSERT INTO users (id, slug, username, display_name, password_hash, created_at, updated_at)
       VALUES (1, 'u1', 'u1', 'U1', 'x', ?, ?)`,
      at,
      at,
    )
    const insert = (hash: string, scope: string): void => {
      db.run(
        `INSERT INTO relay_keys (user_id, scope, kind, name, key_hash, preview, created_at)
         VALUES (1, ?, 'system', 'k', ?, 'p', ?)`,
        scope,
        hash,
        at,
      )
    }
    insert('h-dsh', 'dsh')
    insert('h-claude', 'claude-code')
    insert('h-codex', 'codex')
    // 同作用域第二把 → UNIQUE
    expect(() => insert('h-dsh-2', 'dsh')).toThrow(/UNIQUE/)
    expect(() => insert('h-claude-2', 'claude-code')).toThrow(/UNIQUE/)
    // 作废后可以再签一把（与原逻辑一致）
    db.run("UPDATE relay_keys SET revoked_at = ? WHERE key_hash = 'h-dsh'", at)
    insert('h-dsh-3', 'dsh')
    expect(count(db, 'relay_keys')).toBe(4)
    db.close()
  })
})
