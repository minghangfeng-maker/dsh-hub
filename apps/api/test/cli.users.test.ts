import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdminCommand, resetPasswordCommand, userListCommand, type CliContext } from '../src/cli-users.js'
import { openDb, type HubDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { createTestClock } from '../src/lib/clock.js'
import { createTestApp, json, type TestApp } from './helpers.js'
import { postJson } from './wp1-helpers.js'

/**
 * CLI 用户命令（任务书交付物 4）：命令只依赖 `{db, clock, io}`，所以这里直接注入假 io；
 * 另外用同一个 HUB_DATA_DIR 起一个 app，验证 CLI 建出来的管理员**真的能登录**。
 */
let dir: string
let db: HubDb
let out: string
let err: string
let ctx: CliContext
let app: TestApp | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dshhub-cli-'))
  db = openDb(join(dir, 'hub.db'))
  runMigrations(db)
  out = ''
  err = ''
  ctx = {
    db,
    clock: createTestClock(),
    io: {
      out: (text) => {
        out += text
      },
      err: (text) => {
        err += text
      },
    },
  }
})

afterEach(async () => {
  if (app) {
    await app.close()
    app = null
  }
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('CLI 用户命令（11 §6）', () => {
  it('create-admin：建出 active 管理员，且能用它登录（端到端）', async () => {
    const code = createAdminCommand(ctx, {
      username: 'hubadmin',
      displayName: '运维',
      password: 'Hub-admin-pass-1',
    })
    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('hubadmin')

    const row = db.get<{ role: string; status: string; display_name: string; must_change_password: number }>(
      'SELECT role, status, display_name, must_change_password FROM users WHERE username = ?',
      'hubadmin',
    )
    expect(row).toMatchObject({ role: 'admin', status: 'active', display_name: '运维', must_change_password: 0 })

    // 同一个数据目录起服务，用 CLI 设的密码登录
    app = await createTestApp({ env: { HUB_DATA_DIR: dir } })
    const login = await postJson(app.app, '/api/auth/login', {
      username: 'hubadmin',
      password: 'Hub-admin-pass-1',
    })
    expect(login.statusCode, login.body).toBe(200)
    expect(json<{ user: { role: string } }>(login).user.role).toBe('admin')
    const adminList = await app.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! },
    })
    expect(adminList.statusCode).toBe(200)
  })

  it('create-admin：用户名不合法 / 保留字 / 重名 / 弱口令都拒绝并给出中文原因', async () => {
    expect(createAdminCommand(ctx, { username: 'A', password: 'Hub-admin-pass-1' })).toBe(1)
    expect(err).toContain('用户名不合法')

    err = ''
    expect(createAdminCommand(ctx, { username: 'admin', password: 'Hub-admin-pass-1' })).toBe(1)
    expect(err).toContain('保留字')

    expect(createAdminCommand(ctx, { username: 'boss', password: 'Hub-admin-pass-1' })).toBe(0)
    err = ''
    expect(createAdminCommand(ctx, { username: 'boss', password: 'Hub-admin-pass-2' })).toBe(1)
    expect(err).toContain('已被占用')

    err = ''
    expect(createAdminCommand(ctx, { username: 'weakling', password: 'password123' })).toBe(1)
    expect(err).toContain('密码强度不足')

    err = ''
    expect(createAdminCommand(ctx, { username: 'nopass' })).toBe(1)
    expect(err).toContain('缺少密码')
  })

  it('user:list：列出全部用户与统计', async () => {
    expect(createAdminCommand(ctx, { username: 'boss', password: 'Hub-admin-pass-1' })).toBe(0)
    out = ''
    expect(userListCommand(ctx)).toBe(0)
    expect(out).toContain('boss')
    expect(out).toContain('admin')
    expect(out).toContain('共 1 个用户')

    db.run('DELETE FROM users')
    out = ''
    expect(userListCommand(ctx)).toBe(0)
    expect(out).toContain('还没有任何用户')
  })

  it('user:reset-password：打印一次性临时密码、强制改密、吊销全部会话', async () => {
    expect(createAdminCommand(ctx, { username: 'boss', password: 'Hub-admin-pass-1' })).toBe(0)
    const userId = db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', 'boss')!.id
    db.run(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES ('deadbeef', ?, ?, ?, ?, '127.0.0.1', 'vitest')`,
      userId,
      ctx.clock.nowIso(),
      ctx.clock.nowIso(),
      '2099-01-01T00:00:00.000Z',
    )

    out = ''
    expect(resetPasswordCommand(ctx, 'boss')).toBe(0)
    expect(out).toContain('临时密码：')
    const tempPassword = /临时密码：(\S+)/.exec(out)?.[1]
    expect(tempPassword).toHaveLength(14)

    const row = db.get<{ must_change_password: number }>(
      'SELECT must_change_password FROM users WHERE id = ?',
      userId,
    )
    expect(row?.must_change_password).toBe(1)
    expect(db.get<{ revoked_at: string | null }>('SELECT revoked_at FROM sessions WHERE id = ?', 'deadbeef')
      ?.revoked_at).toBe(ctx.clock.nowIso())

    // 临时密码可用（端到端）
    app = await createTestApp({ env: { HUB_DATA_DIR: dir } })
    const login = await postJson(app.app, '/api/auth/login', {
      username: 'boss',
      password: tempPassword!,
    })
    expect(login.statusCode, login.body).toBe(200)
    expect(json<{ user: { mustChangePassword: boolean } }>(login).user.mustChangePassword).toBe(true)

    err = ''
    expect(resetPasswordCommand(ctx, 'ghost')).toBe(1)
    expect(err).toContain('用户不存在')
  })
})
