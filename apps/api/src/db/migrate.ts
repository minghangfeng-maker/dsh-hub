import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HubError } from '../lib/errors.js'
import type { HubDb } from './index.js'

export interface Migration {
  /** 文件名前缀，如 `000` */
  version: string
  /** 文件名后半段，如 `infra` */
  name: string
  file: string
  sql: string
}

export interface MigrateResult {
  applied: Migration[]
  skipped: Migration[]
  /** 迁移后的最新版本号 */
  current: string | null
}

export interface MigrateOptions {
  dir?: string
  /** 便于测试注入时间 */
  now?: () => string
  log?: (line: string) => void
}

const MIGRATION_FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`

/**
 * 迁移目录：优先用与当前模块同级的 `migrations/`（构建时由 build 脚本拷贝到 dist/db/），
 * 找不到时回退到源码目录（`tsx`/vitest 直接跑 TS 的场景）。
 */
export function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const beside = join(here, 'migrations')
  if (existsSync(beside)) return beside
  const source = join(here, '..', '..', 'src', 'db', 'migrations')
  if (existsSync(source)) return source
  return beside
}

/** 读 `migrations/*.sql` 并按编号排序；文件名不合规或编号重复直接报错（迁移必须确定性） */
export function loadMigrations(dir: string = resolveMigrationsDir()): Migration[] {
  if (!existsSync(dir)) throw new HubError('INTERNAL', `迁移目录不存在：${dir}`)
  const migrations: Migration[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const matched = MIGRATION_FILE_RE.exec(file)
    if (!matched) throw new HubError('INTERNAL', `迁移文件名不合法：${file}（应为 NNN_name.sql）`)
    migrations.push({
      version: matched[1]!,
      name: matched[2]!,
      file,
      sql: readFileSync(join(dir, file), 'utf8'),
    })
  }
  migrations.sort((a, b) => a.version.localeCompare(b.version))
  for (let i = 1; i < migrations.length; i += 1) {
    if (migrations[i]!.version === migrations[i - 1]!.version) {
      throw new HubError('INTERNAL', `迁移编号重复：${migrations[i]!.version}`)
    }
  }
  return migrations
}

/**
 * 迁移执行器：`schema_migrations` 记录已应用版本，每个文件在自己的事务里执行（失败即回滚并抛出）。
 * 启动时自动跑（`buildApp`），CLI 也可以单独跑 `migrate`。
 */
export function runMigrations(db: HubDb, opts: MigrateOptions = {}): MigrateResult {
  const migrations = loadMigrations(opts.dir)
  const nowIso = opts.now ?? (() => new Date().toISOString())
  const log = opts.log ?? (() => {})
  db.exec(SCHEMA_MIGRATIONS_DDL)
  const done = new Set(
    db.all<{ version: string }>('SELECT version FROM schema_migrations').map((r) => r.version),
  )
  const applied: Migration[] = []
  const skipped: Migration[] = []
  for (const migration of migrations) {
    if (done.has(migration.version)) {
      skipped.push(migration)
      continue
    }
    db.tx(() => {
      db.exec(migration.sql)
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        nowIso(),
      )
    })
    applied.push(migration)
    log(`已应用迁移 ${migration.version}_${migration.name}`)
  }
  const current = migrations.length > 0 ? migrations[migrations.length - 1]!.version : null
  return { applied, skipped, current }
}
