import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 086（16 §2 §3 §6.1，WP20a）：
 * - `relay_channels.slug` + 部分唯一索引；
 * - `relay_routes.dsh_enabled`：老配置按「模型选中 + 路由启用」回填；
 * - `relay_usage.base_model` 回填 = model、`pinned` 默认 0；
 * - `settings.relay_dsh.defaultRouteId` 按渠道优先级/倍率/id 回填。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function oldMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-mig086-'))
  tempDirs.push(dir)
  const source = resolveMigrationsDir()
  for (const file of readdirSync(source)) {
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) < 86) {
      cpSync(join(source, file), join(dir, file))
    }
  }
  return dir
}

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

function upgrade(db: HubDb, dir: string): void {
  cpSync(join(resolveMigrationsDir(), '086_relay_channel_slug.sql'), join(dir, '086_relay_channel_slug.sql'))
  const after = runMigrations(db, { dir })
  expect(after.applied.map((m) => m.version)).toEqual(['086'])
}

function seedOld(db: HubDb): void {
  const at = '2026-10-18T00:00:00.000Z'
  db.run(
    `INSERT INTO users (slug, username, display_name, password_hash, created_at, updated_at)
     VALUES ('u1', 'u1', 'U1', 'x', ?, ?)`,
    at,
    at,
  )
  // c1 优先级高 → 默认路由应选 c1 上的 r1
  db.run(
    `INSERT INTO relay_channels (id, name, base_url, apis_json, priority, rate_permille, created_at, updated_at)
     VALUES (1, 'upstream-c 池', 'https://a.example/v1', '["openai-completions"]', 5, 300, ?, ?),
            (2, 'upstream-b', 'https://b.example/v1', '["openai-completions"]', 0, 100, ?, ?)`,
    at,
    at,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_models (id, name, display_name, enabled, visibility, dsh_enabled,
                               price_input, price_output, created_at, updated_at)
     VALUES (1, 'deepseek-v4.1-flash', 'Flash', 1, 'all', 1, 1, 2, ?, ?),
            (2, 'not-selected', 'N', 1, 'all', 0, 1, 2, ?, ?)`,
    at,
    at,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_routes (id, model_id, channel_id, upstream_model, enabled)
     VALUES (1, 1, 1, 'up-a', 1),
            (2, 1, 2, 'up-b', 1),
            (3, 1, 1, 'up-disabled', 0),
            (4, 2, 2, 'up-c', 1)`,
  )
  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('relay_dsh', ?, ?)`,
    JSON.stringify({ presetId: null, defaultModelId: 1, updatedAt: at, renderHash: null }),
    at,
  )
  db.run(
    `INSERT INTO relay_usage (request_id, created_at, user_id, model, api, stream, source, status)
     VALUES ('req-1', ?, 1, 'deepseek-v4.1-flash', 'openai-completions', 0, 'local', 'ok')`,
    at,
  )
}

describe('迁移 086：渠道标识 / 路由下发 / 用量本名', () => {
  it('老库升级：列与索引出现，数据按 16 §2 §3 §6.1 回填', () => {
    const db = openDb(':memory:')
    const dir = oldMigrationsDir()
    expect(runMigrations(db, { dir }).current).toBe('085')
    expect(columns(db, 'relay_channels')).not.toContain('slug')
    expect(columns(db, 'relay_routes')).not.toContain('dsh_enabled')
    expect(columns(db, 'relay_usage')).not.toContain('base_model')
    seedOld(db)
    upgrade(db, dir)

    expect(columns(db, 'relay_channels')).toContain('slug')
    expect(columns(db, 'relay_routes')).toContain('dsh_enabled')
    expect(columns(db, 'relay_usage')).toEqual(expect.arrayContaining(['base_model', 'pinned']))
    // 老渠道 slug 为空，由启动补齐（迁移不猜生成规则）
    expect(db.all<{ slug: string | null }>('SELECT slug FROM relay_channels ORDER BY id')).toEqual([
      { slug: null },
      { slug: null },
    ])

    expect(
      db.all<{ id: number; dsh_enabled: number }>('SELECT id, dsh_enabled FROM relay_routes ORDER BY id'),
    ).toEqual([
      { id: 1, dsh_enabled: 1 },
      { id: 2, dsh_enabled: 1 },
      { id: 3, dsh_enabled: 0 }, // 路由自己停用
      { id: 4, dsh_enabled: 0 }, // 所属模型没勾选
    ])

    const settings = JSON.parse(
      db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'relay_dsh'")!.value_json,
    ) as { defaultRouteId: number }
    // c1 优先级 5 高于 c2 的 0 → 默认路由 r1
    expect(settings.defaultRouteId).toBe(1)

    expect(
      db.get<{ model: string; base_model: string; pinned: number }>(
        'SELECT model, base_model, pinned FROM relay_usage WHERE request_id = ?',
        'req-1',
      ),
    ).toEqual({ model: 'deepseek-v4.1-flash', base_model: 'deepseek-v4.1-flash', pinned: 0 })
    db.close()
  })

  it('slug 唯一索引生效（NULL 可以有多行）', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const at = '2026-10-18T00:00:00.000Z'
    db.run(
      `INSERT INTO relay_channels (id, name, slug, base_url, apis_json, created_at, updated_at)
       VALUES (1, 'a', NULL, 'https://a/v1', '["openai-completions"]', ?, ?),
              (2, 'b', 'shared', 'https://b/v1', '["openai-completions"]', ?, ?)`,
      at,
      at,
      at,
      at,
    )
    expect(() => db.run("UPDATE relay_channels SET slug = 'shared' WHERE id = 1")).toThrow(/UNIQUE/)
    db.close()
  })
})
