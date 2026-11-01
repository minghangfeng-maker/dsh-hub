import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

/** node:sqlite 允许的绑定值 */
export type SqlParam = null | number | bigint | string | Uint8Array

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export interface HubDbOptions {
  /** 只读打开（导出、对账等场景） */
  readOnly?: boolean
  /** 打开后是否自动跑迁移（由 buildApp/CLI 决定，openDb 本身不做） */
  fileMustExist?: boolean
}

/**
 * `node:sqlite` 的薄封装：统一 WAL/foreign_keys/busy_timeout，提供 `tx()` 事务与类型化查询。
 *
 * 为什么同步：`DatabaseSync` 本身是同步 API，SQLite 事务也必须同步提交；
 * 业务层需要异步时用 `withUserLock` 串行化，而不是把事务拉长成异步。
 */
export class HubDb {
  readonly raw: DatabaseSync
  readonly file: string
  #txDepth = 0

  constructor(file: string, opts: HubDbOptions = {}) {
    this.file = file
    if (file !== ':memory:' && !opts.readOnly) mkdirSync(dirname(file), { recursive: true })
    this.raw = new DatabaseSync(file, { readOnly: opts.readOnly ?? false, enableForeignKeyConstraints: true })
    if (!opts.readOnly) {
      // WAL 让读写不互相阻塞；busy_timeout 兜住并发写（03 §1）
      this.raw.exec('PRAGMA journal_mode = WAL')
      this.raw.exec('PRAGMA synchronous = NORMAL')
    }
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql)
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    const res = this.prepare(sql).run(...params)
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) }
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.prepare(sql).all(...params) as T[]
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  /**
   * 事务。嵌套调用使用 SAVEPOINT，内层失败只回滚内层。
   * 回调必须是同步的（见类注释）。
   */
  tx<T>(fn: () => T): T {
    const outer = this.#txDepth === 0
    const name = `hub_sp_${this.#txDepth}`
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`)
    this.#txDepth += 1
    try {
      const result = fn()
      this.#txDepth -= 1
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`)
      return result
    } catch (error) {
      this.#txDepth -= 1
      try {
        this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}`)
      } catch {
        // 回滚失败（例如连接已断）不应掩盖原始错误
      }
      throw error
    }
  }

  /** 简单的连通性检查（`/api/health`） */
  ping(): boolean {
    try {
      this.get<{ ok: number }>('SELECT 1 AS ok')
      return true
    } catch {
      return false
    }
  }

  close(): void {
    try {
      this.raw.close()
    } catch {
      // 已经关闭
    }
  }
}

/** 打开（必要时创建）数据库 */
export function openDb(file: string, opts: HubDbOptions = {}): HubDb {
  return new HubDb(file, opts)
}
