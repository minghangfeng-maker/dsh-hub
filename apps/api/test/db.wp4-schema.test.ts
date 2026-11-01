import { describe, expect, it } from 'vitest'
import { openDb, type HubDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'

/** 060/061 迁移必须与 03 §1.3 一致（列名/约束/级联） */
function freshDb(): HubDb {
  const db = openDb(':memory:')
  runMigrations(db)
  return db
}

function columns(db: HubDb, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name)
}

describe('060/061 迁移（03 §1.3 任务域与导出）', () => {
  it('jobs / job_tasks / exports 的列齐全', () => {
    const db = freshDb()
    expect(columns(db, 'jobs')).toEqual([
      'id',
      'type',
      'title',
      'status',
      'params_json',
      'strategy_json',
      'total',
      'done',
      'failed',
      'created_by',
      'created_at',
      'started_at',
      'finished_at',
      'error',
    ])
    expect(columns(db, 'job_tasks')).toEqual(
      expect.arrayContaining([
        'id',
        'job_id',
        'seq',
        'user_id',
        'status',
        'attempt',
        'log',
        'result_json',
        'started_at',
        'finished_at',
        'error',
      ]),
    )
    expect(columns(db, 'exports')).toEqual([
      'id',
      'user_id',
      'job_id',
      'parts_json',
      'format',
      'status',
      'file_name',
      'size_bytes',
      'sha256',
      'created_at',
      'expires_at',
      'downloaded',
      'error',
    ])
    db.close()
  })

  it('状态与格式的 CHECK 约束生效', () => {
    const db = freshDb()
    const now = '2026-10-12T13:00:00.000Z'
    db.run(
      `INSERT INTO jobs (type, title, status, params_json, created_at) VALUES ('export', 't', 'queued', '{}', ?)`,
      now,
    )
    expect(() =>
      db.run(
        `INSERT INTO jobs (type, title, status, params_json, created_at) VALUES ('export', 't', 'bogus', '{}', ?)`,
        now,
      ),
    ).toThrow()
    expect(() =>
      db.run(
        `INSERT INTO exports (user_id, parts_json, format, status, created_at) VALUES (1, '[]', 'rar', 'ready', ?)`,
        now,
      ),
    ).toThrow()
    db.close()
  })

  it('job_tasks 随 job 级联删除；exports 随用户级联删除', () => {
    const db = freshDb()
    const now = '2026-10-12T13:00:00.000Z'
    db.run(
      `INSERT INTO users (slug, username, display_name, bio, password_hash, created_at, updated_at)
       VALUES ('uabc1234', 'cascade', '', '', 'x', ?, ?)`,
      now,
      now,
    )
    const jobId = db.run(
      `INSERT INTO jobs (type, title, status, params_json, created_at) VALUES ('export', 't', 'queued', '{}', ?)`,
      now,
    ).lastInsertRowid
    db.run(`INSERT INTO job_tasks (job_id, seq, status) VALUES (?, 1, 'pending')`, jobId)
    db.run(
      `INSERT INTO exports (user_id, job_id, parts_json, format, status, created_at)
       VALUES (1, ?, '["workspace"]', 'zip', 'queued', ?)`,
      jobId,
      now,
    )
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_tasks')?.n).toBe(1)

    // exports.job_id 按 03 §1.3 没有 ON DELETE：job 被引用时删不掉（Hub 不提供删 job 的接口）
    expect(() => db.run('DELETE FROM jobs WHERE id = ?', jobId)).toThrow()
    db.run('DELETE FROM exports WHERE job_id = ?', jobId)

    db.run('DELETE FROM jobs WHERE id = ?', jobId)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_tasks')?.n).toBe(0)

    // 用户删除 → 导出记录级联删除
    db.run(
      `INSERT INTO exports (user_id, parts_json, format, status, created_at)
       VALUES (1, '["workspace"]', 'zip', 'ready', ?)`,
      now,
    )
    db.run('DELETE FROM users WHERE id = 1')
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM exports')?.n).toBe(0)
    db.close()
  })
})
