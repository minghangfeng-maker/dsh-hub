import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 123（插件按平台）与 124（模型预设按平台）的结构与数据迁移自检（WP32a / docs/22 §2.1 §3）。
 *
 * 两条线：
 * 1. 新库：新列/新表/新唯一键/新 CHECK 真的按文档生效（同名版本号可两平台各一条、'bundled' 来源可写、
 *    每平台一个默认预设、预设名只在平台内唯一）；
 * 2. 老库：造一个 122 状态的库（只跑 000–122），塞进插件/版本/整包/目标/用户插件/预设，
 *    再跑 123/124，逐项对账 + `foreign_key_check` / `integrity_check` 为空。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const AT = '2026-10-20T10:00:00.000Z'

function freshDb() {
  const db = openDb(':memory:')
  runMigrations(db)
  return db
}

/** 只跑 000–122 的库（= WP32a 之前的生产状态） */
function legacyDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-wp32a-legacy-'))
  tempDirs.push(dir)
  const all = resolveMigrationsDir()
  for (const file of readdirSync(all)) {
    if (file.slice(0, 3) <= '122') cpSync(join(all, file), join(dir, file))
  }
  const db = openDb(':memory:')
  runMigrations(db, { dir })
  return db
}

function seedPlugin(
  db: ReturnType<typeof freshDb>,
  packageName: string,
  policy: string,
  order = 100,
): number {
  return db.run(
    `INSERT INTO plugins (package_name, display_name, description, icon, homepage, policy,
                          is_bundle, bundle_order, config_yaml, needs_restart, created_at, updated_at)
     VALUES (?, ?, '', NULL, NULL, ?, 1, ?, '', 1, ?, ?)`,
    packageName,
    packageName,
    policy,
    order,
    AT,
    AT,
  ).lastInsertRowid
}

function seedVersion(db: ReturnType<typeof freshDb>, pluginId: number, version: string): number {
  return db.run(
    `INSERT INTO plugin_versions (plugin_id, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
     VALUES (?, ?, 'upload', 'x.tgz', '1.0.0', NULL, NULL, NULL, ?)`,
    pluginId,
    version,
    AT,
  ).lastInsertRowid
}

describe('迁移 123/124 的结构（新库）', () => {
  it('插件平台表与版本平台列：同名版本号可在两平台各有一条', () => {
    const db = freshDb()
    const pluginId = seedPlugin(db, '@local/x', 'required')
    db.run(
      `INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
       VALUES (?, 'cloud', 'required', 100, '', 1, ?, ?)`,
      pluginId,
      AT,
      AT,
    )
    db.run(
      `INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
       VALUES (?, 'desktop', 'default', 20, '', 1, ?, ?)`,
      pluginId,
      AT,
      AT,
    )
    seedVersion(db, pluginId, '1.0.0')
    db.run(
      `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
       VALUES (?, 'desktop', '1.0.0', 'upload', 'x.tgz', '1.0.0', NULL, NULL, NULL, ?)`,
      pluginId,
      AT,
    )
    // 同平台重复 → 撞唯一键
    expect(() =>
      db.run(
        `INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
         VALUES (?, 'cloud', '1.0.0', 'upload', 'x.tgz', '1.0.0', NULL, NULL, NULL, ?)`,
        pluginId,
        AT,
      ),
    ).toThrow()
    expect(
      db.all<{ platform: string }>('SELECT platform FROM plugin_versions ORDER BY platform').map((row) => row.platform),
    ).toEqual(['cloud', 'desktop'])
    // platform 只收两个值
    expect(() => db.run("UPDATE plugin_versions SET platform = 'mobile' WHERE 1")).toThrow()
    // 同一个插件在两个平台各一种 policy
    const policies = db.all<{ platform: string; policy: string }>(
      'SELECT platform, policy FROM plugin_platforms ORDER BY platform',
    )
    expect(policies).toEqual([
      { platform: 'cloud', policy: 'required' },
      { platform: 'desktop', policy: 'default' },
    ])
    db.close()
  })

  it('设备上报来源接受 bundled', () => {
    // 设备 id 的 CHECK：dv_ + 32 位
    const DEVICE = `dv_${'a'.repeat(32)}`
    const db = freshDb()
    const user = db.run(
      `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                          must_change_password, created_at, updated_at)
       VALUES ('u1', 'u1', '', '', 'x', 'user', 'active', 0, ?, ?)`,
      AT,
      AT,
    ).lastInsertRowid
    db.run(
      `INSERT INTO desktop_devices (device_id, user_id, name, platform, arch, app_version, app_channel,
                                    status, first_seen_at, created_at, updated_at, last_report_at)
       VALUES (?, ?, '设备', 'win32', 'x64', '0.2.1', 'latest', 'active', ?, ?, ?, ?)`,
      DEVICE,
      user,
      AT,
      AT,
      AT,
      AT,
    )
    db.run(
      `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
       VALUES (?, '@local/dsh-memory', '0.1.3', 'bundled', 'enabled', NULL, ?)`,
      DEVICE,
      AT,
    )
    expect(() =>
      db.run(
        `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
         VALUES (?, '@local/other', '0.1.3', 'not-a-source', 'enabled', NULL, ?)`,
        DEVICE,
        AT,
      ),
    ).toThrow()
    db.close()
  })

  it('模型预设：每平台一个默认、预设名只在平台内唯一', () => {
    const db = freshDb()
    const insert = (platform: string, name: string, isDefault: number): void => {
      db.run(
        `INSERT INTO model_presets (platform, name, description, provider_ids_json, default_provider,
                                    default_model, is_default, revision, created_at, updated_at)
         VALUES (?, ?, '', '[]', 'hub', 'm', ?, 1, ?, ?)`,
        platform,
        name,
        isDefault,
        AT,
        AT,
      )
    }
    insert('cloud', '同名', 1)
    insert('desktop', '同名', 1) // 名字一样但平台不同 → 允许
    expect(() => insert('cloud', '同名', 0)).toThrow()
    expect(() => insert('cloud', '另一个', 1)).toThrow() // 云上已经有一个默认
    db.run("UPDATE model_presets SET is_default = 0 WHERE platform = 'desktop'")
    insert('desktop', '桌面默认', 1) // 桌面平台空出默认位后可以设另一个
    expect(() => {
      db.run("UPDATE model_presets SET platform = 'mobile' WHERE 1")
    }).toThrow()
    db.close()
  })
})

describe('迁移 123/124 的数据迁移（老库 122 → 124）', () => {
  it('对账：桌面整包版本复制成桌面行、目标与整包改指向它、没有整包的插件不进桌面库', () => {
    const db = legacyDb()
    // P1：云上 required，没有桌面整包（历史 bug：被当 core 推给桌面）
    const p1 = seedPlugin(db, '@local/dsh-mobile', 'required', 10)
    seedVersion(db, p1, '0.3.0')
    // P2：云上 optional + 桌面打过补丁的整包
    const p2 = seedPlugin(db, '@local/ssh-hosts', 'optional', 20)
    seedVersion(db, p2, '1.2.1')
    const p2desk = seedVersion(db, p2, '1.2.2')
    // P3：hidden + 整包
    const p3 = seedPlugin(db, '@local/dsh-memory', 'hidden', 30)
    const p3desk = seedVersion(db, p3, '0.1.3')
    for (const [pluginId, versionId] of [
      [p2, p2desk],
      [p3, p3desk],
    ] as const) {
      db.run(
        `INSERT INTO desktop_plugin_artifacts (version_id, plugin_id, file_name, bytes, sha256, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, 1024, ?, NULL, ?)`,
        versionId,
        pluginId,
        `pkg-${String(versionId)}.tgz`,
        'a'.repeat(64),
        AT,
      )
    }
    db.run(
      `INSERT INTO desktop_plugin_targets (plugin_id, version_id, enabled, scope, role, user_id, updated_by, updated_at)
       VALUES (?, ?, 1, 'all', '', NULL, NULL, ?)`,
      p2,
      p2desk,
      AT,
    )
    const user = db.run(
      `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                          must_change_password, created_at, updated_at)
       VALUES ('u1', 'u1', '', '', 'x', 'user', 'active', 0, ?, ?)`,
      AT,
      AT,
    ).lastInsertRowid
    db.run(
      `INSERT INTO user_plugins (user_id, plugin_id, desired, desired_version_id, actual_version_id, state, source, error, updated_at)
       VALUES (?, ?, 'installed', NULL, NULL, 'synced', 'policy', NULL, ?)`,
      user,
      p1,
      AT,
    )
    db.run("UPDATE desktop_delivery_counter SET revision = 5 WHERE id = 1")
    db.run(
      `INSERT INTO model_presets (name, description, provider_ids_json, default_provider, default_model,
                                  is_default, revision, created_at, updated_at)
       VALUES ('Hub 中转站', '', '[]', 'hub', 'm', 1, 3, ?, ?)`,
      AT,
      AT,
    )

    const before = {
      plugins: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plugins')!.n,
      versions: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plugin_versions')!.n,
      artifacts: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_plugin_artifacts')!.n,
      targets: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_plugin_targets')!.n,
      userPlugins: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM user_plugins')!.n,
    }

    const result = runMigrations(db)
    // 126（WP40a：手机设备列）、127（WP40r：安卓 APK 发布记录表）、128（WP54a：mobile_platform
    // 放开到 web，重建 desktop_devices 但不动插件数据）、129（WP56a：座舱表 + users.is_system）与
    // 130（WP56b：座舱容器凭据与座舱令牌）也在这条链上
    expect(result.applied.map((migration) => migration.version)).toEqual([
      '123',
      '124',
      '125',
      '126',
      '127',
      '128',
      '129',
      '130',
    ])

    // 版本：3 条云上 + 2 条桌面（只有带整包的两个版本复制了桌面行）
    const versions = db.all<{ platform: string; plugin_id: number; version: string; id: number }>(
      'SELECT id, plugin_id, platform, version FROM plugin_versions ORDER BY id',
    )
    expect(versions.filter((row) => row.platform === 'cloud')).toHaveLength(before.versions)
    expect(versions.filter((row) => row.platform === 'desktop')).toHaveLength(2)
    // 云上行 id 一个都没变（user_plugins 的引用继续有效）
    expect(versions.filter((row) => row.platform === 'cloud').map((row) => row.id)).toEqual(
      versions.map((row) => row.id).filter((id) => id <= p3desk),
    )

    // 插件平台行：三个插件都进云上；只有 P2/P3 进桌面
    const platforms = db.all<{ plugin_id: number; platform: string; policy: string }>(
      'SELECT plugin_id, platform, policy FROM plugin_platforms ORDER BY plugin_id, platform',
    )
    expect(platforms.filter((row) => row.platform === 'cloud')).toHaveLength(3)
    expect(platforms.filter((row) => row.platform === 'desktop').map((row) => row.plugin_id).sort()).toEqual(
      [p2, p3].sort(),
    )
    // 桌面行的 policy 照抄原 policy；hidden 仍然是 hidden
    expect(platforms.find((row) => row.plugin_id === p3 && row.platform === 'desktop')!.policy).toBe('hidden')
    expect(platforms.find((row) => row.plugin_id === p1 && row.platform === 'cloud')!.policy).toBe('required')

    // 整包与目标都改指向桌面版本
    const artifacts = db.all<{ version_id: number; file_name: string }>(
      'SELECT version_id, file_name FROM desktop_plugin_artifacts ORDER BY version_id',
    )
    expect(artifacts).toHaveLength(before.artifacts)
    const desktopIds = new Set(versions.filter((row) => row.platform === 'desktop').map((row) => row.id))
    expect(artifacts.every((row) => desktopIds.has(row.version_id))).toBe(true)
    const targets = db.all<{ version_id: number }>('SELECT version_id FROM desktop_plugin_targets')
    expect(targets).toHaveLength(before.targets)
    expect(desktopIds.has(targets[0]!.version_id)).toBe(true)

    // 用户插件、清单 revision 不动
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM user_plugins')!.n).toBe(before.userPlugins)
    expect(
      db.get<{ revision: number }>('SELECT revision FROM desktop_delivery_counter WHERE id = 1')!.revision,
    ).toBe(5)

    // 模型预设：云上那条还是默认；桌面复制出一条默认
    const presets = db.all<{ platform: string; name: string; is_default: number; revision: number }>(
      'SELECT platform, name, is_default, revision FROM model_presets ORDER BY platform',
    )
    expect(presets.filter((row) => row.platform === 'cloud')).toEqual([
      { platform: 'cloud', name: 'Hub 中转站', is_default: 1, revision: 3 },
    ])
    expect(presets.filter((row) => row.platform === 'desktop').map((row) => row.name)).toEqual([
      'Hub 中转站（桌面）',
    ])

    // 外键与完整性
    expect(db.all<Record<string, unknown>>('PRAGMA foreign_key_check')).toEqual([])
    expect(db.all<{ integrity_check: string }>('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ])
    db.close()
  })

  it('没有云上默认预设时不会凭空造桌面预设', () => {
    const db = legacyDb()
    runMigrations(db)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM model_presets WHERE platform = ?', 'desktop')!.n).toBe(0)
    db.close()
  })
})
