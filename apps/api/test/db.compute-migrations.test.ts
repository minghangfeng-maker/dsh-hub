import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'

/**
 * 迁移 084（13 §2/§5）：钱包两列 + 重建 `relay_ledger`（type 加 daily/expire/compute）。
 * 迁移 100（13 §5）：`compute_leases`（唯一进行中租约）+ `compute_prefs`。
 *
 * 关键回归：老库升级时已有流水的 **行数、Σamount、id、索引** 都不能变；外键仍然指向 users。
 */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 把 `< maxVersion` 的迁移拷进临时目录，用来造一个「老库」 */
function oldMigrationsDir(maxVersion: number): string {
  const dir = mkdtempSync(join(tmpdir(), `dshhub-mig${String(maxVersion)}-`))
  tempDirs.push(dir)
  const source = resolveMigrationsDir()
  for (const file of readdirSync(source)) {
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) < maxVersion) {
      cpSync(join(source, file), join(dir, file))
    }
  }
  return dir
}

function addMigration(dir: string, file: string): void {
  cpSync(join(resolveMigrationsDir(), file), join(dir, file))
}

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

function indexNames(db: HubDb, table: string): string[] {
  return db
    .all<{ name: string }>(`PRAGMA index_list(${table})`)
    .map((row) => row.name)
    .sort()
}

function seedOldLedger(db: HubDb): void {
  const at = '2026-10-15T00:00:00.000Z'
  db.run(
    `INSERT INTO users (slug, username, password_hash, created_at, updated_at)
     VALUES ('uold084', 'old-084', 'x', ?, ?)`,
    at,
    at,
  )
  db.run(
    `INSERT INTO relay_wallets (user_id, balance, created_at, updated_at)
     VALUES (1, 12_345_678, ?, ?)`,
    at,
    at,
  )
  for (const [type, amount, balanceAfter, note] of [
    ['grant', 10_000_000, 10_000_000, '管理员加积分'],
    ['deduct', -1_000_000, 9_000_000, '管理员扣积分'],
    ['signup', 5_000_000, 14_000_000, '注册赠送'],
    ['grant', 345_678, 14_345_678, '再送一点'],
  ] as const) {
    db.run(
      `INSERT INTO relay_ledger (user_id, type, amount, balance_after, note, actor_id, created_at)
       VALUES (1, ?, ?, ?, ?, NULL, ?)`,
      type,
      amount,
      balanceAfter,
      note,
      at,
    )
  }
}

describe('迁移 084：每日赠送两列 + 重建流水表', () => {
  it('老库升级：行数 / Σamount / id / 索引 / 外键都不变，新类型可用', () => {
    const db = openDb(':memory:')
    const dir = oldMigrationsDir(84)
    const before = runMigrations(db, { dir })
    expect(before.current).toBe('083')
    expect(columns(db, 'relay_wallets')).not.toContain('daily_bonus_left')
    seedOldLedger(db)
    const idsBefore = db.all<{ id: number }>('SELECT id FROM relay_ledger ORDER BY id').map((row) => row.id)
    const sumBefore = db.get<{ total: number }>('SELECT SUM(amount) AS total FROM relay_ledger')!.total
    const indexBefore = indexNames(db, 'relay_ledger')

    addMigration(dir, '084_relay_daily_bonus.sql')
    const after = runMigrations(db, { dir })
    expect(after.applied.map((m) => m.version)).toEqual(['084'])

    expect(columns(db, 'relay_wallets')).toEqual(
      expect.arrayContaining(['daily_bonus_left', 'daily_bonus_day']),
    )
    expect(columns(db, 'relay_ledger').sort()).toEqual(
      ['actor_id', 'amount', 'balance_after', 'created_at', 'id', 'note', 'type', 'user_id'].sort(),
    )
    expect(db.all<{ id: number }>('SELECT id FROM relay_ledger ORDER BY id').map((row) => row.id)).toEqual(
      idsBefore,
    )
    expect(db.get<{ total: number }>('SELECT SUM(amount) AS total FROM relay_ledger')!.total).toBe(sumBefore)
    expect(indexNames(db, 'relay_ledger')).toEqual(indexBefore)
    // 钱包旧数据保留，新列走默认值
    expect(
      db.get<{ balance: number; daily_bonus_left: number; daily_bonus_day: string | null }>(
        'SELECT balance, daily_bonus_left, daily_bonus_day FROM relay_wallets WHERE user_id = 1',
      ),
    ).toEqual({ balance: 12_345_678, daily_bonus_left: 0, daily_bonus_day: null })
    // 外键仍然有效（删用户级联删流水）
    expect(db.all<{ table: string }>('PRAGMA foreign_key_list(relay_ledger)')[0]?.table).toBe('users')

    // 新类型都能写；非法类型仍被 CHECK 拒绝
    const at = '2026-10-18T00:00:00.000Z'
    db.run(
      `INSERT INTO relay_ledger (user_id, type, amount, balance_after, note, actor_id, created_at)
       VALUES (1, 'daily', 600000, 12945678, '每日赠送', NULL, ?),
              (1, 'expire', -100000, 12845678, '赠送作废', NULL, ?),
              (1, 'compute', -50000, 12795678, '2 核 4 GB 10 分钟', NULL, ?)`,
      at,
      at,
      at,
    )
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relay_ledger')!.n).toBe(7)
    expect(() => {
      db.run(
        `INSERT INTO relay_ledger (user_id, type, amount, balance_after, note, actor_id, created_at)
         VALUES (1, 'refund', 1, 1, '', NULL, ?)`,
        at,
      )
    }).toThrow()
    db.close()
  })
})

describe('迁移 100：算力租约与偏好', () => {
  it('建表、每个用户最多一条进行中租约、结束原因受 CHECK 约束', () => {
    const db = openDb(':memory:')
    const dir = oldMigrationsDir(100)
    const before = runMigrations(db, { dir })
    // 100 之前的最新迁移：WP23a 加了 087_relay_agent_modes，WP25a 加了 088_relay_usage_client_kind，
    // 这里跟着更新（测试只在「已有一个 >= 100 的迁移」时复制 < 100 的文件）
    expect(before.current).toBe('088')
    addMigration(dir, '100_compute.sql')
    const after = runMigrations(db, { dir })
    expect(after.applied.map((m) => m.version)).toEqual(['100'])

    expect(columns(db, 'compute_leases')).toEqual(
      expect.arrayContaining([
        'plan_id',
        'plan_name',
        'cpus',
        'memory_mb',
        'price_per_hour',
        'block_price',
        'billed',
        'start_reason',
        'started_at',
        'paid_until',
        'grace_until',
        'ended_at',
        'end_reason',
        'blocks',
        'charged',
      ]),
    )
    expect(columns(db, 'compute_prefs')).toEqual(['user_id', 'plan_id', 'updated_at'])
    expect(indexNames(db, 'compute_leases')).toEqual(
      expect.arrayContaining(['compute_leases_one_active', 'compute_leases_user']),
    )

    const at = '2026-10-18T00:00:00.000Z'
    db.run(
      `INSERT INTO users (slug, username, password_hash, created_at, updated_at)
       VALUES ('uold100', 'old-100', 'x', ?, ?)`,
      at,
      at,
    )
    const insertLease = (planId: string, endedAt: string | null = null): void => {
      db.run(
        `INSERT INTO compute_leases (user_id, plan_id, plan_name, cpus, memory_mb, price_per_hour,
                                     block_price, billed, start_reason, started_at, ended_at,
                                     end_reason, created_at, updated_at)
         VALUES (1, ?, '测试规格', 2, 4096, 300000, 50000, 1, 'user', ?, ?, ?, ?, ?)`,
        planId,
        at,
        endedAt,
        endedAt === null ? null : 'user',
        at,
        at,
      )
    }
    insertLease('c2m4')
    // 同一用户第二个进行中租约被唯一部分索引拒绝
    expect(() => insertLease('c4m8')).toThrow()
    db.run("UPDATE compute_leases SET ended_at = ?, end_reason = 'user' WHERE plan_id = 'c2m4'", at)
    insertLease('c4m8')
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM compute_leases')!.n).toBe(2)
    // 非法结束原因被 CHECK 拒绝（CHECK 允许多个 NULL，所以只测非 NULL 的坏值）
    expect(() => db.run("UPDATE compute_leases SET end_reason = 'refund' WHERE plan_id = 'c4m8'")).toThrow()
    // 偏好主键
    db.run('INSERT INTO compute_prefs (user_id, plan_id, updated_at) VALUES (1, ?, ?)', 'c2m4', at)
    expect(() =>
      db.run('INSERT INTO compute_prefs (user_id, plan_id, updated_at) VALUES (1, ?, ?)', 'c4m8', at),
    ).toThrow()
    db.close()
  })
})
