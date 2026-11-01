import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import archiver from 'archiver'
import type { HubConfig } from '../config.js'
import { openDb } from '../db/index.js'
import { HubError } from '../lib/errors.js'
import { createPaths } from '../lib/paths.js'

/**
 * `cli db:backup`（08 §8 / 08 §10）：SQLite `VACUUM INTO` 出一份一致的库快照 +
 * 把 `secrets/` 打成 0600 的 tar.gz，放同一个备份目录（默认 `<HUB_DATA_DIR>/backups`）。
 *
 * 为什么用 VACUUM INTO 而不是 cp：Hub 运行时库是 WAL 模式，直接复制文件会漏掉 -wal 里的数据；
 * VACUUM INTO 在单个读事务里生成一份已整理的完整副本（SQLite 官方推荐的在线备份方式）。
 */
export interface DbBackupOptions {
  config: HubConfig
  /** 备份输出目录；生产由 `scripts/backup.sh` 传 `--out /mnt/backup/dsh-hub/db` */
  outDir?: string
  /** 保留天数，默认 14（08 §8） */
  keepDays?: number
  /** 注入时间便于测试 */
  now?: Date
  log?: (line: string) => void
}

export interface DbBackupResult {
  dbFile: string
  secretsFile: string | null
  dbBytes: number
  secretsBytes: number
  /** 被清理掉的旧备份文件名 */
  pruned: string[]
}

export async function runDbBackup(options: DbBackupOptions): Promise<DbBackupResult> {
  const { config } = options
  const paths = createPaths(config.dataDir)
  const log = options.log ?? (() => {})
  const keepDays = Math.max(1, Math.trunc(options.keepDays ?? 14))
  const now = options.now ?? new Date()
  const outDir = options.outDir ?? join(paths.root, 'backups')

  if (!existsSync(paths.dbFile)) {
    throw new HubError('NOT_FOUND', `数据库不存在：${paths.dbFile}（先启动一次 Hub 或执行 cli migrate）`)
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 })

  const stamp = localStamp(now)
  const dbFile = uniquePath(join(outDir, `hub-${stamp}.db`))
  const secretsFile = existsSync(paths.secretsDir)
    ? uniquePath(join(outDir, `secrets-${stamp}.tar.gz`))
    : null

  // 1) VACUUM INTO：目标路径是 SQL 字面量，单引号要自己转义
  const db = openDb(paths.dbFile)
  try {
    db.raw.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  chmodSync(dbFile, 0o600)
  const dbBytes = statSync(dbFile).size
  log(`db      → ${dbFile}（${formatBytes(dbBytes)}）`)

  // 2) 立刻验证副本能打开、完整性 ok、有 users 表 —— 备份不可验证等于没有备份
  verifySnapshot(dbFile)

  // 3) secrets/（0600；归档里不带顶层目录名，恢复时直接解到 secrets/ 下）
  let secretsBytes = 0
  if (secretsFile) {
    secretsBytes = await tarDirectory(paths.secretsDir, secretsFile)
    chmodSync(secretsFile, 0o600)
    log(`secrets → ${secretsFile}（${formatBytes(secretsBytes)}）`)
  } else {
    log('secrets → 跳过（还没有 secrets/ 目录）')
  }

  // 4) 保留策略：删掉超过 keepDays 天的旧备份（当天的永远保留）
  const pruned = pruneOldBackups(outDir, keepDays, now, [dbFile, secretsFile])
  if (pruned.length > 0) log(`清理旧备份 ${pruned.length} 个：${pruned.join(', ')}`)

  return { dbFile, secretsFile, dbBytes, secretsBytes, pruned }
}

/** 只做最近一次备份的验证，`cli db:backup` 的输出里带一行结论 */
function verifySnapshot(file: string): void {
  const copy = openDb(file, { readOnly: true })
  try {
    const integrity = copy.get<{ integrity_check: string }>('PRAGMA integrity_check')
    const result = integrity?.integrity_check
    if (result !== 'ok') {
      rmSync(file, { force: true })
      throw new HubError('INTERNAL', `备份副本完整性检查失败：${result ?? '读不出结果'}`)
    }
    const users = copy.get<{ n: number }>('SELECT count(*) AS n FROM users')
    if (users === undefined) {
      rmSync(file, { force: true })
      throw new HubError('INTERNAL', '备份副本里没有 users 表，不像 Hub 的库')
    }
  } finally {
    copy.close()
  }
}

/** 打包一个目录（内容放归档根部），返回字节数 */
async function tarDirectory(sourceDir: string, targetFile: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const output = createWriteStream(targetFile, { mode: 0o600 })
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } })
    const fail = (error: Error): void => {
      output.destroy()
      rmSync(targetFile, { force: true })
      reject(new HubError('INTERNAL', `打包 ${sourceDir} 失败：${error.message}`))
    }
    output.on('close', () => resolve(statSync(targetFile).size))
    output.on('error', fail)
    archive.on('error', fail)
    // archiver 对「遍历后文件消失」只发 warning：必须当失败，否则 secrets 会缺文件
    archive.on('warning', fail)
    archive.pipe(output)
    archive.directory(sourceDir, false)
    void archive.finalize()
  })
}

function pruneOldBackups(
  outDir: string,
  keepDays: number,
  now: Date,
  keepFiles: (string | null)[],
): string[] {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000
  const keep = new Set(keepFiles.filter((f): f is string => f !== null))
  const pruned: string[] = []
  for (const name of readdirSync(outDir)) {
    if (!/^hub-.*\.db$/.test(name) && !/^secrets-.*\.tar\.gz$/.test(name)) continue
    const file = join(outDir, name)
    if (keep.has(file)) continue
    if (statSync(file).mtimeMs < cutoff) {
      rmSync(file, { force: true })
      pruned.push(name)
    }
  }
  return pruned
}

/** 同一秒内跑两次也要能落盘（名字撞了就往后加序号） */
function uniquePath(base: string): string {
  if (!existsSync(base)) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${stem}-${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  throw new HubError('CONFLICT', `备份文件名冲突：${base}`)
}

/** 备份文件名用本地时间（跟 timer 的 03:30 对得上），不用 UTC */
export function localStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
