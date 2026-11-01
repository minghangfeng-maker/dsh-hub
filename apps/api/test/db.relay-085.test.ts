import { describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 085（14 §4，WP18a）：搜索 / 抓取池的三张表。
 *
 * 关键点：`kind` / `tool` / `status` / `state` / `cooldown_reason` 的 CHECK 约束；
 * 渠道删除级联删密钥；`relay_tool_usage` 不设渠道/密钥外键（删渠道不丢历史用量）。
 */

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

describe('迁移 085：搜索池表', () => {
  it('新库：三张表与索引都在，字段照 14 §4', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    expect(columns(db, 'relay_tool_channels')).toEqual(
      expect.arrayContaining([
        'id',
        'kind',
        'name',
        'base_url',
        'tools_json',
        'priority',
        'weight',
        'timeout_ms',
        'proxy_url',
        'search_cost',
        'fetch_cost',
        'enabled',
        'note',
        'fail_streak',
        'cooldown_until',
        'last_error',
        'last_error_at',
        'created_at',
        'updated_at',
      ]),
    )
    expect(columns(db, 'relay_tool_keys')).toEqual(
      expect.arrayContaining([
        'id',
        'channel_id',
        'label',
        'key_enc',
        'key_hash',
        'last4',
        'state',
        'cooldown_until',
        'cooldown_reason',
        'last_error',
        'last_error_at',
        'last_used_at',
        'created_at',
      ]),
    )
    expect(columns(db, 'relay_tool_usage')).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'key_id',
        'tool',
        'status',
        'free',
        'cost',
        'channel_id',
        'tool_key_id',
        'upstream_cost',
        'attempts',
        'duration_ms',
        'summary',
        'error',
        'month',
        'created_at',
      ]),
    )
    const indexes = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map((row) => row.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'relay_tool_usage_user_month',
        'relay_tool_usage_created',
        'relay_tool_usage_tool_key_month',
      ]),
    )
    db.close()
  })

  it('CHECK 约束：kind / state / cooldown_reason / tool / status', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const at = '2026-10-18T00:00:00.000Z'
    db.run(
      `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                          must_change_password, created_at, updated_at)
       VALUES ('u1', 'u1', 'U1', '', 'x', 'user', 'active', 0, ?, ?)`,
      at,
      at,
    )
    db.run(
      `INSERT INTO relay_tool_channels (kind, name, base_url, tools_json, created_at, updated_at)
       VALUES ('deepseek', 'ds', 'https://api.deepseek.com/v1/tools', '["search"]', ?, ?)`,
      at,
      at,
    )
    expect(() => {
      db.run(
        `INSERT INTO relay_tool_channels (kind, name, base_url, tools_json, created_at, updated_at)
         VALUES ('openai', 'x', 'https://x', '[]', ?, ?)`,
        at,
        at,
      )
    }).toThrow()

    db.run(
      `INSERT INTO relay_tool_keys (channel_id, key_enc, key_hash, last4, created_at)
       VALUES (1, 'enc', 'hash', '1234', ?)`,
      at,
    )
    expect(() => {
      db.run("UPDATE relay_tool_keys SET state = 'bogus' WHERE id = 1")
    }).toThrow()
    db.run("UPDATE relay_tool_keys SET cooldown_reason = 'exhausted' WHERE id = 1")
    expect(() => {
      db.run("UPDATE relay_tool_keys SET cooldown_reason = 'bogus' WHERE id = 1")
    }).toThrow()

    db.run(
      `INSERT INTO relay_tool_usage (user_id, tool, status, month, created_at)
       VALUES (1, 'search', 'ok', '2026-10', ?)`,
      at,
    )
    expect(() => {
      db.run(
        `INSERT INTO relay_tool_usage (user_id, tool, status, month, created_at)
         VALUES (1, 'crawl', 'ok', '2026-10', ?)`,
        at,
      )
    }).toThrow()
    expect(() => {
      db.run(
        `INSERT INTO relay_tool_usage (user_id, tool, status, month, created_at)
         VALUES (1, 'search', 'bogus', '2026-10', ?)`,
        at,
      )
    }).toThrow()
    db.close()
  })

  it('渠道删除级联删密钥；用量行不随渠道删除而丢（没有外键）', () => {
    const db = openDb(':memory:')
    runMigrations(db)
    const at = '2026-10-18T00:00:00.000Z'
    db.run(
      `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                          must_change_password, created_at, updated_at)
       VALUES ('u1', 'u1', 'U1', '', 'x', 'user', 'active', 0, ?, ?)`,
      at,
      at,
    )
    db.run(
      `INSERT INTO relay_tool_channels (kind, name, base_url, tools_json, created_at, updated_at)
       VALUES ('tavily', 'tv', 'https://api.tavily.com', '["search","fetch"]', ?, ?)`,
      at,
      at,
    )
    db.run(
      `INSERT INTO relay_tool_keys (channel_id, key_enc, key_hash, last4, created_at)
       VALUES (1, 'enc', 'hash', '1234', ?)`,
      at,
    )
    db.run(
      `INSERT INTO relay_tool_usage (user_id, tool, status, channel_id, month, created_at)
       VALUES (1, 'search', 'ok', 1, '2026-10', ?)`,
      at,
    )
    db.run('DELETE FROM relay_tool_channels WHERE id = 1')
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relay_tool_keys')!.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relay_tool_usage')!.n).toBe(1)
    db.close()
  })
})
