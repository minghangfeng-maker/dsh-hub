import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 128（WP54a：`mobile_platform` 放开到 'web'）的结构与数据自检。
 *
 * 这条迁移**重建了 `desktop_devices`**（SQLite 改 CHECK 只能这么干），而它有两张
 * `ON DELETE CASCADE` 的子表：`desktop_device_tokens`（正在用的手机令牌）与
 * `desktop_device_plugins`（桌面插件清单）。重建顺序错了 / 忘了暂存，这两张表的数据会被
 * DROP TABLE 的隐式 DELETE 级联清空 —— 表现是「升级后所有人都要重新登录」，
 * 而且不会报错。所以这里的每条断言都对着一个具体的翻车方式：
 *
 * 1. 老库（000–127）升级后**设备行与令牌行、插件行一个不少**、字段逐个不变；
 * 2. `web` 能写、android/ios/NULL 照旧能写，非法值仍被拒（CHECK 真的生效）；
 * 3. 5 个索引（含 partial unique `desktop_devices_install_active`）原样回来、触发器数量不变；
 * 4. `foreign_key_check` / `integrity_check` 为空（FK 与页结构都没被重建弄坏）；
 * 5. **文件库（WAL）**上也能升级 —— 这一条不能省：`:memory:` 库的语句级回滚日志在内存里，
 *    而文件库的语句日志是临时文件（SQLite 会先试 `/var/tmp`…）；第一版迁移在内存库里全绿、
 *    在文件库上直接 `unable to open database file`（2026-10-29 实测）。生产库就是文件库。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const AT = '2026-10-29T10:00:00.000Z'
/** 合法 device_id 形状：'dv_' + 32 hex（120 迁移的 CHECK 卡长度 35） */
function deviceId(seed: string): string {
  return `dv_${seed.repeat(32).slice(0, 32)}`
}

function freshDb() {
  const db = openDb(':memory:')
  runMigrations(db)
  return db
}

/** 只跑 000–127 的迁移目录（= WP54a 之前的生产状态） */
function legacyMigrationDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-wp54a-legacy-'))
  tempDirs.push(dir)
  const all = resolveMigrationsDir()
  for (const file of readdirSync(all)) {
    if (file.slice(0, 3) <= '127') cpSync(join(all, file), join(dir, file))
  }
  return dir
}

/** 只跑 000–127 的**内存**库 */
function legacyDb() {
  const db = openDb(':memory:')
  runMigrations(db, { dir: legacyMigrationDir() })
  return db
}

/** 只跑 000–127 的**文件**库（WAL，与生产同一种打开方式） */
function legacyFileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-wp54a-file-'))
  tempDirs.push(dir)
  const db = openDb(join(dir, 'hub.db'))
  runMigrations(db, { dir: legacyMigrationDir() })
  return db
}

type Db = ReturnType<typeof freshDb>

function seedUser(db: Db, username = 'alice'): number {
  return db.run(
    `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                        must_change_password, created_at, updated_at)
     VALUES (?, ?, '', '', 'x', 'user', 'active', 0, ?, ?)`,
    `u-${username}`,
    username,
    AT,
    AT,
  ).lastInsertRowid
}

interface SeedDeviceOptions {
  kind?: string
  mobilePlatform?: string | null
  name?: string
  installKey?: string | null
  status?: string
  platform?: string | null
}

function seedDevice(db: Db, userId: number, id: string, opts: SeedDeviceOptions = {}): void {
  db.run(
    `INSERT INTO desktop_devices (device_id, user_id, install_key, name, kind, mobile_platform, platform,
                                  os_major, arch, app_version, app_channel, runtime_version, capabilities_json,
                                  applied_revision, apply_state, status, revoked_at, revoked_by, revoke_reason,
                                  first_seen_at, registered_at, last_report_at, last_auth_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    opts.installKey ?? null,
    opts.name ?? '设备',
    opts.kind ?? 'mobile',
    opts.mobilePlatform === undefined ? null : opts.mobilePlatform,
    opts.platform ?? null,
    opts.platform === 'win32' ? '11' : null,
    opts.platform === 'win32' ? 'x64' : null,
    '0.9.3',
    'latest',
    '0.2.1',
    null,
    null,
    'unknown',
    opts.status ?? 'active',
    null,
    null,
    null,
    AT,
    AT,
    AT,
    AT,
    AT,
    AT,
  )
}

function seedToken(db: Db, userId: number, id: string, tokenHash: string): void {
  db.run(
    `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at,
                                        ip, user_agent, app_version)
     VALUES (?, ?, ?, ?, ?, '2030-01-01T00:00:00.000Z', '127.0.0.1', 'vitest', '0.9.3')`,
    tokenHash,
    id,
    userId,
    AT,
    AT,
  )
}

/** `desktop_devices` 的 5 个显式索引（120 的 4 个 + 126 的 1 个） */
const DEVICE_INDEXES = [
  'desktop_devices_install_active',
  'desktop_devices_last_report',
  'desktop_devices_platform',
  'desktop_devices_user_kind',
  'desktop_devices_user_status',
]

function indexNames(db: Db): string[] {
  return db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'desktop_devices' ORDER BY name",
    )
    .map((row) => row.name)
}

/**
 * 一张表的结构快照：列 / 外键 / 索引（含索引列与 partial/unique 标记）。
 * 子表是**在迁移里按 DDL 重写**的，只有逐结构比对才能保证「重建 == 原来」，
 * 光看行数会漏掉 `ON DELETE CASCADE`、`CHECK` 或唯一索引。
 */
function tableSchema(db: Db, table: string) {
  const indexes = db
    .all<{ name: string; unique: number; partial: number }>(`PRAGMA index_list('${table}')`)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      partial: index.partial,
      columns: db.all(`PRAGMA index_info('${index.name}')`),
    }))
  const foreignKeys = db
    .all<{ id: number; table: string; from: string; to: string; on_delete: string }>(
      `PRAGMA foreign_key_list('${table}')`,
    )
    .map((fk) => ({ ...fk }))
    .sort((a, b) => `${a.table}.${a.from}`.localeCompare(`${b.table}.${b.from}`))
  return {
    columns: db
      .all<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>(`PRAGMA table_info('${table}')`)
      .map((column) => ({ ...column })),
    foreignKeys,
    indexes,
  }
}

/** `desktop_devices` 重建后必须保留的 30 列（顺序也一致：120 的 28 列 + 126 的 2 列） */
const DEVICE_COLUMNS = [
  'id',
  'device_id',
  'user_id',
  'install_key',
  'name',
  'platform',
  'os_major',
  'arch',
  'app_version',
  'app_channel',
  'runtime_version',
  'applied_revision',
  'applied_at',
  'apply_state',
  'apply_error',
  'apply_error_count',
  'capabilities_json',
  'registered_at',
  'first_seen_at',
  'last_report_at',
  'last_auth_at',
  'status',
  'revoked_at',
  'revoked_by',
  'revoke_reason',
  'relay_key_id',
  'created_at',
  'updated_at',
  'kind',
  'mobile_platform',
]

function deviceColumns(db: Db): string[] {
  return db.all<{ name: string }>("PRAGMA table_info('desktop_devices')").map((column) => column.name)
}

describe('迁移 128：mobile_platform 允许 web（新库）', () => {
  it('android / ios / web / NULL 都能写，其它值仍被 CHECK 拒掉', () => {
    const db = freshDb()
    const user = seedUser(db)
    seedDevice(db, user, deviceId('a'), { name: 'Pixel 8', mobilePlatform: 'android' })
    seedDevice(db, user, deviceId('b'), { name: 'iPhone', mobilePlatform: 'ios' })
    seedDevice(db, user, deviceId('c'), { name: '手机网页版 · Chrome · Android', mobilePlatform: 'web' })
    seedDevice(db, user, deviceId('d'), { name: '我的 Windows', kind: 'desktop', platform: 'win32' })

    expect(
      db
        .all<{ mobile_platform: string | null }>('SELECT mobile_platform FROM desktop_devices ORDER BY id')
        .map((row) => row.mobile_platform),
    ).toEqual(['android', 'ios', 'web', null])

    for (const bad of ['windows', 'tablet', 'Web', '']) {
      expect(() =>
        seedDevice(db, user, deviceId(bad.slice(0, 1) || 'z'), { name: 'bad', mobilePlatform: bad }),
      ).toThrow()
    }
    // `kind` 的 CHECK 也原样保留（重建时最容易漏的就是它）
    expect(() =>
      seedDevice(db, user, deviceId('e'), { name: 'tablet', kind: 'tablet', mobilePlatform: 'web' }),
    ).toThrow()
    // 桌面列的 platform 仍然只收 Node 的 process.platform
    expect(() =>
      seedDevice(db, user, deviceId('f'), { name: 'weird', kind: 'desktop', platform: 'android' }),
    ).toThrow()
    db.close()
  })

  it('索引与 partial unique 约束原样在：吊销后可以再建同 install_key，同时存在两条就撞键', () => {
    const db = freshDb()
    const user = seedUser(db)
    const installKey = 'k'.repeat(64)
    seedDevice(db, user, deviceId('a'), { name: 'web', mobilePlatform: 'web', installKey })

    expect(indexNames(db)).toEqual(expect.arrayContaining(DEVICE_INDEXES))
    // partial unique：另一条 active + 同 install_key → 撞唯一键
    expect(() =>
      seedDevice(db, user, deviceId('b'), { name: 'web2', mobilePlatform: 'web', installKey }),
    ).toThrow()
    // 吊销旧行后可以再建（与 120 的语义一致：历史保留、有效行唯一）
    db.run(
      `UPDATE desktop_devices SET status = 'revoked', revoked_at = ?, revoke_reason = 'user' WHERE device_id = ?`,
      AT,
      deviceId('a'),
    )
    seedDevice(db, user, deviceId('b'), { name: 'web2', mobilePlatform: 'web', installKey })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')?.n).toBe(2)
    db.close()
  })
})

describe('迁移 128：从老库（000–127）升级', () => {
  it('设备、令牌、插件行一个不少，字段逐个不变，外键与页结构健康', () => {
    const db = legacyDb()
    const user = seedUser(db)
    // 老库的三种行：android、ios、桌面（mobile_platform = NULL）
    const androidId = deviceId('a')
    const iosId = deviceId('b')
    const desktopId = deviceId('c')
    seedDevice(db, user, androidId, {
      name: 'Android · 7SUN',
      mobilePlatform: 'android',
      installKey: 'a'.repeat(64),
    })
    seedDevice(db, user, iosId, { name: 'iPhone · Safari', mobilePlatform: 'ios', status: 'revoked' })
    seedDevice(db, user, desktopId, { name: '我的 Windows', kind: 'desktop', platform: 'win32' })
    seedToken(db, user, androidId, '1'.repeat(64))
    seedToken(db, user, desktopId, '2'.repeat(64))
    db.run(
      `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
       VALUES (?, '@local/x', '1.0.0', 'user', 'enabled', NULL, ?)`,
      desktopId,
      AT,
    )

    const devicesBefore = db.all('SELECT * FROM desktop_devices ORDER BY id')
    const tokensBefore = db.all('SELECT * FROM desktop_device_tokens ORDER BY id')
    const pluginsBefore = db.all('SELECT * FROM desktop_device_plugins ORDER BY device_id, package_name')
    const triggersBefore = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")

    const result = runMigrations(db)
    // 128 之后新增的迁移会在同一个升级路径上一并跑（WP56a 的 129_cockpit、WP56b 的 130_cockpit_ops）
    expect(result.applied.map((migration) => migration.version)).toEqual(['128', '129', '130'])

    // 1) 逐字段不变（含 install_key / 吊销字段 / 桌面列）
    expect(db.all('SELECT * FROM desktop_devices ORDER BY id')).toEqual(devicesBefore)
    // 2) 令牌与插件清单没被 DROP TABLE 的级联吃掉
    expect(db.all('SELECT * FROM desktop_device_tokens ORDER BY id')).toEqual(tokensBefore)
    expect(db.all('SELECT * FROM desktop_device_plugins ORDER BY device_id, package_name')).toEqual(
      pluginsBefore,
    )
    expect(tokensBefore).toHaveLength(2)
    expect(triggersBefore).toHaveLength(0)
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toHaveLength(0)

    // 3) 索引 / 约束原样
    expect(indexNames(db)).toEqual(expect.arrayContaining(DEVICE_INDEXES))
    const installIndex = db
      .all<{ name: string; unique: number; partial: number }>("PRAGMA index_list('desktop_devices')")
      .find((row) => row.name === 'desktop_devices_install_active')
    expect(installIndex).toMatchObject({ unique: 1, partial: 1 })

    // 4) 健康检查
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])

    // 5) 升级后 web 能写，非法值仍被拒；老数据照旧可读
    seedDevice(db, user, deviceId('d'), { name: '手机网页版 · Chrome · Android', mobilePlatform: 'web' })
    expect(
      db
        .all<{ mobile_platform: string | null }>('SELECT mobile_platform FROM desktop_devices ORDER BY id')
        .map((row) => row.mobile_platform),
    ).toEqual(['android', 'ios', null, 'web'])
    expect(() => seedDevice(db, user, deviceId('e'), { name: 'bad', mobilePlatform: 'windows' })).toThrow()
    db.close()
  })

  it('升级后仍然只有一个写入口径：repair 重复 install_key 的 active 行会撞唯一键', () => {
    const db = legacyDb()
    const user = seedUser(db)
    seedDevice(db, user, deviceId('a'), {
      name: 'web',
      mobilePlatform: 'android',
      installKey: 'b'.repeat(64),
    })
    runMigrations(db)
    // 升级没有顺手清掉合法数据（不该做「智能修复」）：老行还在
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')?.n).toBe(1)
    expect(() =>
      seedDevice(db, user, deviceId('b'), {
        name: 'web2',
        mobilePlatform: 'web',
        installKey: 'b'.repeat(64),
      }),
    ).toThrow()
    db.close()
  })

  it('重建的表结构逐项不变：父表 30 列顺序一致，两张子表的列/外键/索引与升级前一模一样', () => {
    const db = legacyDb()
    const before = {
      tokens: tableSchema(db, 'desktop_device_tokens'),
      plugins: tableSchema(db, 'desktop_device_plugins'),
    }
    expect(deviceColumns(db)).toEqual(DEVICE_COLUMNS)

    runMigrations(db)

    expect(deviceColumns(db)).toEqual(DEVICE_COLUMNS)
    expect(tableSchema(db, 'desktop_device_tokens')).toEqual(before.tokens)
    expect(tableSchema(db, 'desktop_device_plugins')).toEqual(before.plugins)
    // 外键的级联行为也必须是原来那个（重建时漏掉 ON DELETE CASCADE 只有删设备时才暴露）
    expect(before.tokens.foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'desktop_devices', on_delete: 'CASCADE' }),
        expect.objectContaining({ table: 'users', on_delete: 'CASCADE' }),
        expect.objectContaining({ table: 'desktop_device_tokens', on_delete: 'SET NULL' }),
      ]),
    )
    expect(before.plugins.foreignKeys).toEqual([
      expect.objectContaining({ table: 'desktop_devices', on_delete: 'CASCADE' }),
    ])
    db.close()
  })

  it('重建后的外键仍然是级联：删掉设备行，令牌与插件清单跟着消失', () => {
    const db = legacyDb()
    const user = seedUser(db)
    const id = deviceId('a')
    seedDevice(db, user, id, { name: 'Pixel 8', mobilePlatform: 'android' })
    seedToken(db, user, id, '1'.repeat(64))
    db.run(
      `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
       VALUES (?, '@local/x', '1.0.0', 'user', 'enabled', NULL, ?)`,
      id,
      AT,
    )
    runMigrations(db)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_tokens')?.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_plugins')?.n).toBe(1)

    db.run('DELETE FROM desktop_devices WHERE device_id = ?', id)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_tokens')?.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_plugins')?.n).toBe(0)
    db.close()
  })

  it('文件库（WAL，与生产同一种打开方式）上也能升级：数据一个不少、web 能写', () => {
    const db = legacyFileDb()
    // 这条断言是这次迁移的「真实环境」前提：内存库用内存日志，测不出临时文件的问题
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal')

    const user = seedUser(db)
    const androidId = deviceId('a')
    const desktopId = deviceId('c')
    seedDevice(db, user, androidId, { name: 'Android · 7SUN', mobilePlatform: 'android' })
    seedDevice(db, user, desktopId, { name: '我的 Windows', kind: 'desktop', platform: 'win32' })
    seedToken(db, user, androidId, '1'.repeat(64))
    db.run(
      `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
       VALUES (?, '@local/x', '1.0.0', 'user', 'enabled', NULL, ?)`,
      desktopId,
      AT,
    )
    const devicesBefore = db.all('SELECT * FROM desktop_devices ORDER BY id')
    const tokensBefore = db.all('SELECT * FROM desktop_device_tokens ORDER BY id')
    const pluginsBefore = db.all('SELECT * FROM desktop_device_plugins ORDER BY device_id, package_name')

    const result = runMigrations(db)
    // 128 之后新增的迁移会在同一个升级路径上一并跑（WP56a 的 129_cockpit、WP56b 的 130_cockpit_ops）
    expect(result.applied.map((migration) => migration.version)).toEqual(['128', '129', '130'])
    expect(db.all('SELECT * FROM desktop_devices ORDER BY id')).toEqual(devicesBefore)
    expect(db.all('SELECT * FROM desktop_device_tokens ORDER BY id')).toEqual(tokensBefore)
    expect(db.all('SELECT * FROM desktop_device_plugins ORDER BY device_id, package_name')).toEqual(
      pluginsBefore,
    )
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    // 文件库上 web 行也能写进去（写库这条路才是网页版登录的关键）
    seedDevice(db, user, deviceId('d'), { name: '手机网页版 · Chrome · Android', mobilePlatform: 'web' })
    expect(
      db.get<{ mobile_platform: string }>(
        'SELECT mobile_platform FROM desktop_devices WHERE device_id = ?',
        deviceId('d'),
      )?.mobile_platform,
    ).toBe('web')
    db.close()
  })

  it('数据量大（几百台设备 / 上千令牌）时也一个不少：多行插入的语句日志不落盘', () => {
    const db = legacyDb()
    const user = seedUser(db)
    const ids: string[] = []
    for (let i = 0; i < 400; i += 1) {
      const id = deviceId(i.toString(16).padStart(4, '0'))
      ids.push(id)
      const kind = i % 4 === 0 ? 'desktop' : 'mobile'
      seedDevice(db, user, id, {
        name: `设备 ${String(i)}`,
        kind,
        mobilePlatform: kind === 'desktop' ? null : i % 2 === 0 ? 'android' : 'ios',
        platform: kind === 'desktop' ? 'win32' : null,
      })
    }
    for (let t = 0; t < 1200; t += 1) {
      seedToken(db, user, ids[t % ids.length]!, t.toString(16).padStart(8, '0').padEnd(64, '0'))
    }
    for (let p = 0; p < 200; p += 1) {
      db.run(
        `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
         VALUES (?, ?, '1.0.0', 'user', 'enabled', NULL, ?)`,
        ids[p % ids.length]!,
        `@local/p${String(p)}`,
        AT,
      )
    }
    const before = {
      devices: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')?.n,
      tokens: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_tokens')?.n,
      plugins: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_plugins')?.n,
    }

    /**
     * 多行 `INSERT … SELECT` 与 FK 级联同样要**语句级回滚日志**（临时文件）。SQLite 会先试
     * `/var/tmp`，本机 WSL 沙箱拒写那个目录 → 迁移会报 `unable to open database file`。
     * 这是**环境**问题（生产/容器里临时目录可写就没这回事），所以这里把临时存储显式设到内存，
     * 保证这条「数据量」用例在任何机器上测的都是迁移逻辑本身。
     * 必须**在事务之前**设 —— 迁移执行器自己开事务，事务内再设 temp_store 不生效（实测）：
     * 手工演练生产库副本时等价做法是
     * `SQLITE_TMPDIR=<可写目录> node --import tsx scripts/wp32a-migrate-rehearsal.ts <库>`。
     */
    db.raw.exec('PRAGMA temp_store = MEMORY')
    const result = runMigrations(db)
    // 128 之后新增的迁移会在同一个升级路径上一并跑（WP56a 的 129_cockpit、WP56b 的 130_cockpit_ops）
    expect(result.applied.map((migration) => migration.version)).toEqual(['128', '129', '130'])

    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')?.n).toBe(before.devices)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_tokens')?.n).toBe(before.tokens)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_plugins')?.n).toBe(before.plugins)
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    expect(db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    // 每个令牌都还挂在自己的设备上（重建时把 device_id 写错列就会在这里炸）
    expect(
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM desktop_device_tokens t
           JOIN desktop_devices d ON d.device_id = t.device_id`,
      )?.n,
    ).toBe(before.tokens)
    db.close()
  })
})
