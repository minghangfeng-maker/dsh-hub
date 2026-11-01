import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 122 的约束自检（WP25b）。
 *
 * 这里的每一条 CHECK / partial unique index 都在守一个「悄悄下发错东西」的口子：
 * 作用域组合错了会命中不该命中的设备；发布日志能改就会让 desiredRevision 不再单调；
 * 整包的 sha256 形状错了，客户端校验必然失败。
 */

function freshDb() {
  const db = openDb(':memory:')
  runMigrations(db)
  return db
}

const AT = '2026-10-21T12:00:00.000Z'

function seedUser(db: ReturnType<typeof freshDb>, username: string): number {
  const result = db.run(
    `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                        must_change_password, created_at, updated_at)
     VALUES (?, ?, '', '', 'x', 'user', 'active', 0, ?, ?)`,
    `u${username}`,
    username,
    AT,
    AT,
  )
  return result.lastInsertRowid
}

function seedPlugin(
  db: ReturnType<typeof freshDb>,
  packageName = '@local/x',
): { pluginId: number; versionId: number } {
  const plugin = db.run(
    `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                          is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, 'default', 1, 100, '', 1, ?, ?)`,
    packageName,
    packageName,
    AT,
    AT,
  )
  const version = db.run(
    `INSERT INTO plugin_versions (plugin_id, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, '1.0.0', 'upload', 'x', '1.0.0', NULL, NULL, NULL, ?)`,
    plugin.lastInsertRowid,
    AT,
  )
  return { pluginId: plugin.lastInsertRowid, versionId: version.lastInsertRowid }
}

describe('迁移 122：桌面下发的表与约束', () => {
  it('种子数据：revision 从 0 开始、两个通道、一条全新的强更地板', () => {
    const db = freshDb()
    expect(
      db.get<{ revision: number }>('SELECT revision FROM desktop_delivery_counter WHERE id = 1')?.revision,
    ).toBe(0)
    const channels = db.all<{ channel: string }>(
      'SELECT channel FROM desktop_channel_policies ORDER BY channel',
    )
    expect(channels.map((row) => row.channel)).toEqual(['latest', 'nightly'])
    const floor = db.get<{ min_version: string | null; title: string }>(
      'SELECT min_version, title FROM desktop_update_floor WHERE id = 1',
    )
    expect(floor?.min_version).toBeNull()
    expect((floor?.title.length ?? 0) > 0).toBe(true)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_deliveries')?.n).toBe(0)
    db.close()
  })

  it('作用域组合由 CHECK 锁死', () => {
    const db = freshDb()
    const { pluginId, versionId } = seedPlugin(db)
    const insert = (scope: string, role: string | null, userId: number | null): void => {
      db.run(
        `INSERT INTO desktop_plugin_targets (plugin_id, version_id, enabled, scope, role, user_id, updated_by, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, NULL, ?)`,
        pluginId,
        versionId,
        scope,
        role ?? '',
        userId,
        AT,
      )
    }
    expect(() => insert('all', 'user', null)).toThrow(/CHECK/i)
    expect(() => insert('role', 'user', 1)).toThrow(/CHECK/i)
    expect(() => insert('role', '', null)).toThrow(/CHECK/i)
    expect(() => insert('user', 'admin', 1)).toThrow(/CHECK/i)
    expect(() => insert('user', '', null)).toThrow(/CHECK/i)
    expect(() => insert('everyone', '', null)).toThrow(/CHECK/i)
    db.close()
  })

  it('同一目标同一插件只能有一行（partial unique index）', () => {
    const db = freshDb()
    const { pluginId, versionId } = seedPlugin(db)
    const insert = (scope: string, role: string, userId: number | null): void => {
      db.run(
        `INSERT INTO desktop_plugin_targets (plugin_id, version_id, enabled, scope, role, user_id, updated_by, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, NULL, ?)`,
        pluginId,
        versionId,
        scope,
        role,
        userId,
        AT,
      )
    }
    const userId1 = seedUser(db, 'wp25b-one')
    const userId2 = seedUser(db, 'wp25b-two')
    insert('all', '', null)
    expect(() => insert('all', '', null)).toThrow(/UNIQUE/i)
    insert('role', 'user', null)
    expect(() => insert('role', 'user', null)).toThrow(/UNIQUE/i)
    // 不同角色/不同用户各自独立
    insert('role', 'admin', null)
    insert('user', '', userId1)
    insert('user', '', userId2)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_plugin_targets')?.n).toBe(5)
    db.close()
  })

  it('发布日志只追加：revision 主键冲突直接拒绝', () => {
    const db = freshDb()
    const insert = (): void => {
      db.run(
        `INSERT INTO desktop_deliveries (revision, scope, role, user_id, kind, actor_id, detail_json, created_at)
         VALUES (1, 'all', '', NULL, 'plugin', NULL, NULL, ?)`,
        AT,
      )
    }
    insert()
    expect(insert).toThrow(/UNIQUE|PRIMARY/i)
    db.close()
  })

  it('插件整包：sha256 形状与大小上限', () => {
    const db = freshDb()
    const { pluginId, versionId } = seedPlugin(db)
    const insert = (sha256: string, bytes: number): void => {
      db.run(
        `INSERT INTO desktop_plugin_artifacts (version_id, plugin_id, file_name, bytes, sha256, uploaded_by, uploaded_at)
         VALUES (?, ?, 'x.tgz', ?, ?, NULL, ?)`,
        versionId,
        pluginId,
        bytes,
        sha256,
        AT,
      )
    }
    expect(() => insert('A'.repeat(64), 100)).toThrow(/CHECK/i)
    expect(() => insert('a'.repeat(10), 100)).toThrow(/CHECK/i)
    expect(() => insert('a'.repeat(64), 0)).toThrow(/CHECK/i)
    expect(() => insert('a'.repeat(64), 268_435_457)).toThrow(/CHECK/i)
    insert('a'.repeat(64), 1024)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_plugin_artifacts')?.n).toBe(1)
    db.close()
  })

  it('安装包：target/channel 枚举、版本号形状、yanked 状态', () => {
    const db = freshDb()
    const insert = (target: string, channel: string, version: string): void => {
      db.run(
        `INSERT INTO desktop_releases
           (target, channel, version, installer_file, installer_bytes, installer_sha512, blockmap_file,
            blockmap_bytes, blockmap_sha512, feed_file, yaml, status, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, 'x.exe', 1, 'sha', NULL, NULL, NULL, 'latest.yml', 'version: 1.0.0', 'published', NULL, ?)`,
        target,
        channel,
        version,
        AT,
      )
    }
    expect(() => insert('linux-x64', 'latest', '1.0.0')).toThrow(/CHECK/i)
    expect(() => insert('win-x64', 'beta', '1.0.0')).toThrow(/CHECK/i)
    expect(() => insert('win-x64', 'latest', 'v1.0.0')).toThrow(/CHECK/i)
    insert('win-x64', 'latest', '1.0.0')
    expect(() => insert('win-x64', 'latest', '1.0.0')).toThrow(/UNIQUE/i)
    db.close()
  })

  it('配置片段：entry_id 长度与 mode 枚举', () => {
    const db = freshDb()
    const insert = (entryId: string, mode: string): void => {
      db.run(
        `INSERT INTO desktop_config_fragments (entry_id, mode, config_json, note, scope, role, user_id, updated_by, updated_at)
         VALUES (?, ?, '{}', '', 'all', '', NULL, NULL, ?)`,
        entryId,
        mode,
        AT,
      )
    }
    insert('llm-pi-ai', 'enforce')
    insert('agent-default-model', 'default')
    expect(() => insert('x'.repeat(121), 'enforce')).toThrow(/CHECK/i)
    expect(() => insert('hub-connector', 'force')).toThrow(/CHECK/i)
    db.close()
  })
})
