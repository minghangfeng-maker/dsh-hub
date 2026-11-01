import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { DeletedUserListResponseSchema, RestoreUserResponseSchema } from '@dsh-hub/shared'
import type { DeletedUserListResponse } from '@dsh-hub/shared'
import { openDb } from '../src/db/index.js'
import { loadMigrations, resolveMigrationsDir, runMigrations } from '../src/db/migrate.js'
import { isoPlusDays } from '../src/lib/clock.js'
import {
  createTestApp,
  createUser,
  json,
  loginAs,
  type TestApp,
  type TestSession,
  type TestUser,
} from './helpers.js'
import { adminSession, deleteJson, errorCode, getJson, postJson } from './wp1-helpers.js'

/**
 * 用户回收站（WP22）：删除后 7 天内可恢复。
 *
 * 口径：软删除保留、删除即释放用户名（墓碑名 `<原名>#del<id>`）、7 天内可恢复、
 * 列表「已删除」筛选、超过 7 天自动彻底删除。
 */

const DAY_MS = 86_400_000

let ctx: TestApp
let app: FastifyInstance
let admin: TestSession
let alice: TestUser

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  admin = await adminSession(app, 'root-admin')
  alice = await createUser(app, { username: 'alice', displayName: '爱丽丝' })
})

afterEach(async () => {
  await ctx.close()
})

// ── 工具 ────────────────────────────────────────────────────────────────────

function userRow(id: number) {
  return app.deps.db.get<{
    username: string
    deleted_username: string | null
    deleted_from_status: string | null
    purged_at: string | null
    trash_dir: string | null
    deleted_at: string | null
    status: string
  }>(
    `SELECT username, deleted_username, deleted_from_status, purged_at, trash_dir, deleted_at, status
       FROM users WHERE id = ?`,
    id,
  )
}

/** 删除用户的接口（默认软删除进回收站；purge=true 直接彻底删除） */
async function removeUser(
  user: TestUser,
  opts: { purge?: boolean; session?: TestSession } = {},
): Promise<void> {
  const session = opts.session ?? admin
  await reauth(session)
  const res = await deleteJson(app, `/api/admin/users/${user.id}${opts.purge ? '?purge=true' : ''}`, {
    headers: session.headers,
  })
  expect(res.statusCode, res.body).toBe(204)
}

async function reauth(session: TestSession = admin): Promise<void> {
  const res = await postJson(
    app,
    '/api/auth/reauth',
    { password: session.user.password },
    {
      headers: session.headers,
    },
  )
  // 04 §2：reauth 成功是 204（无响应体）
  expect(res.statusCode, res.body).toBe(204)
}

async function fetchDeletedList(): Promise<DeletedUserListResponse> {
  const res = await getJson(app, '/api/admin/users/deleted', { headers: admin.headers })
  expect(res.statusCode, res.body).toBe(200)
  // 用契约 schema 校验响应（前端 http 层也会 parse，尽早发现字段漂移）
  return DeletedUserListResponseSchema.parse(json(res))
}

/** 回收站数据目录的绝对路径（`trash_dir` 是相对 HUB_DATA_DIR 的路径） */
function trashAbs(row: { trash_dir: string | null }): string {
  return join(app.deps.paths.root, row.trash_dir!)
}

function latestAudit(
  action: string,
): { actorId: number | null; detail: Record<string, unknown> } | undefined {
  const row = app.deps.db.get<{ actor_id: number | null; detail_json: string | null }>(
    'SELECT actor_id, detail_json FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1',
    action,
  )
  if (!row) return undefined
  return { actorId: row.actor_id, detail: JSON.parse(row.detail_json ?? '{}') as Record<string, unknown> }
}

/** 给用户造点数据，用于验证恢复时目录/文件能跟着搬回来 */
function writeUserMarker(user: TestUser, content: string): string {
  const marker = join(app.deps.paths.userWorkspace(user.slug), 'marker.txt')
  writeFileSync(marker, content)
  return marker
}

// ── §2.1 删除即释放用户名 ────────────────────────────────────────────────────

describe('WP22 用户回收站', () => {
  it('1. 删除后普通列表查不到、回收站能查到；同名新用户可立即创建且与原用户完全独立', async () => {
    await app.deps.services.instances.provision(alice.id)
    const oldSession = loginAs(app, alice)
    expect((await getJson(app, '/api/auth/me', { headers: oldSession.headers })).statusCode).toBe(200)

    await removeUser(alice)

    // 普通列表 / 搜索 / 详情都查不到；会话被吊销
    const list = json<{ items: { id: number; username: string }[]; total: number }>(
      await getJson(app, '/api/admin/users?q=alice', { headers: admin.headers }),
    )
    expect(list.total).toBe(0)
    expect((await getJson(app, `/api/admin/users/${alice.id}`, { headers: admin.headers })).statusCode).toBe(
      404,
    )
    expect((await getJson(app, '/api/auth/me', { headers: oldSession.headers })).statusCode).toBe(401)

    // 库里：username 换成墓碑名，原名记进 deleted_username（删除前状态也记下了）
    const row = userRow(alice.id)
    expect(row?.username).toBe(`alice#del${alice.id}`)
    expect(row?.deleted_username).toBe('alice')
    expect(row?.deleted_from_status).toBe('active')
    expect(row?.purged_at).toBeNull()
    expect(row?.trash_dir).toMatch(/^trash\//u)

    // 回收站：username 是原名、daysLeft=7、数据在 trash/
    const trash = await fetchDeletedList()
    expect(trash.total).toBe(1)
    expect(trash.items[0]).toMatchObject({
      id: alice.id,
      slug: alice.slug,
      username: 'alice',
      displayName: '爱丽丝',
      status: 'disabled',
      deletedFromStatus: 'active',
      dataInTrash: true,
      daysLeft: 7,
    })
    expect(trash.items[0]!.restorableUntil).toBe(isoPlusDays(trash.items[0]!.deletedAt, 7))

    // 回收站的搜索 / 分页同样生效
    const searched = DeletedUserListResponseSchema.parse(
      json(await getJson(app, '/api/admin/users/deleted?q=alice', { headers: admin.headers })),
    )
    expect(searched.total).toBe(1)
    const missed = DeletedUserListResponseSchema.parse(
      json(await getJson(app, '/api/admin/users/deleted?q=nobody', { headers: admin.headers })),
    )
    expect(missed.total).toBe(0)
    const paged = DeletedUserListResponseSchema.parse(
      json(await getJson(app, '/api/admin/users/deleted?page=2&pageSize=1', { headers: admin.headers })),
    )
    expect(paged).toMatchObject({ total: 1, page: 2, pageSize: 1, items: [] })

    // 删除即释放用户名：马上能建同名新用户，slug/id 不同
    const created = await postJson(
      app,
      '/api/admin/users',
      { username: 'alice', password: 'New-pass-abc1', displayName: '新爱丽丝' },
      { headers: admin.headers },
    )
    expect(created.statusCode, created.body).toBe(201)
    const newUser = json<{ user: { id: number; slug: string } }>(created).user
    expect(newUser.id).not.toBe(alice.id)
    expect(newUser.slug).not.toBe(alice.slug)

    // 登录互不影响：旧用户凭旧密码 401，新用户可登录
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice', password: 'test-password-1' })).statusCode,
    ).toBe(401)
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice', password: 'New-pass-abc1' })).statusCode,
    ).toBe(200)

    // 数据目录也各走各的：新用户独立目录，旧数据留在 trash/
    await app.deps.services.instances.provision(newUser.id)
    expect(existsSync(app.deps.paths.userDir(newUser.slug))).toBe(true)
    expect(existsSync(trashAbs(userRow(alice.id)!))).toBe(true)
    expect(existsSync(app.deps.paths.userDir(alice.slug))).toBe(false)

    // 历史展示：被删用户作为操作者的审计仍显示删除时原名（不是墓碑名）
    app.deps.db.run(
      "INSERT INTO audit_logs (at, actor_id, action) VALUES (?, ?, 'user.update')",
      ctx.clock.nowIso(),
      alice.id,
    )
    const auditList = json<{ items: { actorUsername: string | null }[] }>(
      await getJson(app, `/api/admin/audit?actorId=${alice.id}`, { headers: admin.headers }),
    )
    expect(auditList.items[0]?.actorUsername).toBe('alice')
  })

  // ── §2.2 7 天内恢复 ────────────────────────────────────────────────────────

  it('2. 恢复：目录搬回、状态回到删除前、密码不变可重新登录、trash 清空', async () => {
    await app.deps.services.instances.provision(alice.id)
    const marker = writeUserMarker(alice, '旧用户数据')
    await removeUser(alice)
    expect(existsSync(app.deps.paths.userDir(alice.slug))).toBe(false)
    const trashDir = trashAbs(userRow(alice.id)!)
    expect(existsSync(trashDir)).toBe(true)

    await reauth()
    const res = await postJson(app, `/api/admin/users/${alice.id}/restore`, {}, { headers: admin.headers })
    expect(res.statusCode, res.body).toBe(200)
    const restored = RestoreUserResponseSchema.parse(json(res)).user
    expect(restored).toMatchObject({ username: 'alice', status: 'active', deletedAt: null })

    // DB 删除标记全部清空；数据目录搬回 users/<slug>，marker 还在；trash/ 清空
    const row = userRow(alice.id)
    expect(row?.deleted_at).toBeNull()
    expect(row?.deleted_username).toBeNull()
    expect(row?.deleted_from_status).toBeNull()
    expect(row?.purged_at).toBeNull()
    expect(row?.trash_dir).toBeNull()
    expect(row?.status).toBe('active')
    expect(existsSync(app.deps.paths.userDir(alice.slug))).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('旧用户数据')
    expect(readdirSync(app.deps.paths.trashDir)).toEqual([])

    // 旧会话仍是吊销状态（不复活会话），但密码没变、可重新登录
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice', password: 'test-password-1' })).statusCode,
    ).toBe(200)
    expect((await fetchDeletedList()).total).toBe(0)

    // 审计 user.restore（detail 带改名与否、数据是否搬回）
    const audit = latestAudit('user.restore')
    expect(audit?.detail).toMatchObject({
      username: 'alice',
      previousUsername: 'alice',
      renamed: false,
      dataRestored: true,
    })

    // 恢复后回到删除前的状态：删一个 disabled 用户再恢复
    const carol = await createUser(app, { username: 'carol', status: 'disabled' })
    await removeUser(carol)
    expect(userRow(carol.id)?.deleted_from_status).toBe('disabled')
    const restoredCarol = await postJson(
      app,
      `/api/admin/users/${carol.id}/restore`,
      {},
      { headers: admin.headers },
    )
    expect(restoredCarol.statusCode, restoredCarol.body).toBe(200)
    expect(RestoreUserResponseSchema.parse(json(restoredCarol)).user.status).toBe('disabled')
    expect(userRow(carol.id)?.status).toBe('disabled')
  })

  // ── §2.3 原名被占用时恢复 ──────────────────────────────────────────────────

  it('3. 原名被占用时恢复：不传 username → 409 USERNAME_TAKEN；传新 username → 成功且旧数据仍在', async () => {
    await app.deps.services.instances.provision(alice.id)
    const marker = writeUserMarker(alice, '要带回来的数据')
    await removeUser(alice)

    // 别人抢注原名
    expect(
      (
        await postJson(
          app,
          '/api/admin/users',
          { username: 'alice', password: 'New-pass-abc1' },
          { headers: admin.headers },
        )
      ).statusCode,
    ).toBe(201)

    // 不传 username = 用原名 → 被占用，409，文案提示可换名；此时仍在回收站
    await reauth()
    const conflict = await postJson(
      app,
      `/api/admin/users/${alice.id}/restore`,
      {},
      { headers: admin.headers },
    )
    expect(conflict.statusCode, conflict.body).toBe(409)
    expect(errorCode(json(conflict))).toBe('USERNAME_TAKEN')
    expect((json<{ error: { message: string } }>(conflict).error.message ?? '').length).toBeGreaterThan(0)
    expect(userRow(alice.id)?.deleted_at).not.toBeNull()

    // 指定新 username → 恢复成功，旧数据跟着回来
    const renamed = await postJson(
      app,
      `/api/admin/users/${alice.id}/restore`,
      { username: 'alice-old' },
      { headers: admin.headers },
    )
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(RestoreUserResponseSchema.parse(json(renamed)).user.username).toBe('alice-old')
    expect(userRow(alice.id)?.username).toBe('alice-old')
    expect(readFileSync(marker, 'utf8')).toBe('要带回来的数据')
    expect(readdirSync(app.deps.paths.trashDir)).toEqual([])

    // 恢复后新名可登录；抢注的 alice 不受影响
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice-old', password: 'test-password-1' }))
        .statusCode,
    ).toBe(200)
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice', password: 'New-pass-abc1' })).statusCode,
    ).toBe(200)
  })

  // ── §2.4 非法输入 ──────────────────────────────────────────────────────────

  it('4. 恢复非法输入：未删除 → CONFLICT；已 purge → CONFLICT；超过 7 天 → CONFLICT', async () => {
    const bob = await createUser(app, { username: 'bob' })
    // 权限：普通用户看不到回收站、也不能恢复/彻底删除
    const bobSession = loginAs(app, bob)
    expect((await getJson(app, '/api/admin/users/deleted', { headers: bobSession.headers })).statusCode).toBe(
      403,
    )
    expect(
      (await postJson(app, `/api/admin/users/${bob.id}/restore`, {}, { headers: bobSession.headers }))
        .statusCode,
    ).toBe(403)
    // 恢复 / 彻底删除与删除一致：必须最近输过密码（新 admin 会话还没有）
    const freshAdmin = loginAs(app, admin.user)
    const needReauth = await postJson(
      app,
      `/api/admin/users/${bob.id}/restore`,
      {},
      { headers: freshAdmin.headers },
    )
    expect(needReauth.statusCode).toBe(403)
    expect(errorCode(json(needReauth))).toBe('REAUTH_REQUIRED')
    const needReauthPurge = await postJson(app, `/api/admin/users/${bob.id}/purge`, undefined, {
      headers: freshAdmin.headers,
    })
    expect(needReauthPurge.statusCode).toBe(403)
    expect(errorCode(json(needReauthPurge))).toBe('REAUTH_REQUIRED')

    await reauth()

    // 没删除的用户不在回收站 → 409 CONFLICT
    const notDeleted = await postJson(
      app,
      `/api/admin/users/${bob.id}/restore`,
      {},
      { headers: admin.headers },
    )
    expect(notDeleted.statusCode, notDeleted.body).toBe(409)
    expect(errorCode(json(notDeleted))).toBe('CONFLICT')

    // 不存在的用户 → 404
    const missing = await postJson(app, '/api/admin/users/99999/restore', {}, { headers: admin.headers })
    expect(missing.statusCode).toBe(404)

    // 已彻底删除（purge=true 删除）→ 409 CONFLICT
    await removeUser(bob, { purge: true })
    const purged = await postJson(app, `/api/admin/users/${bob.id}/restore`, {}, { headers: admin.headers })
    expect(purged.statusCode, purged.body).toBe(409)
    expect(errorCode(json(purged))).toBe('CONFLICT')
    expect(json<{ error: { message: string } }>(purged).error.message).toContain('彻底删除')

    // 超过 7 天保留期 → 409 CONFLICT（推进时钟后原 admin 会话过期，重新建一个）
    await removeUser(alice)
    ctx.clock.advance(8 * DAY_MS)
    admin = loginAs(app, admin.user)
    await reauth()
    const expired = await postJson(
      app,
      `/api/admin/users/${alice.id}/restore`,
      { username: 'alice' },
      { headers: admin.headers },
    )
    expect(expired.statusCode, expired.body).toBe(409)
    expect(errorCode(json(expired))).toBe('CONFLICT')
    expect(json<{ error: { message: string } }>(expired).error.message).toContain('7 天')
  })

  // ── §2.5 彻底删除 ──────────────────────────────────────────────────────────

  it('5. 彻底删除：trash 目录被删、列表消失、purged_at 置位、审计 user.purge', async () => {
    await app.deps.services.instances.provision(alice.id)
    await removeUser(alice)
    const row = userRow(alice.id)!
    const trashDir = trashAbs(row)
    expect(existsSync(trashDir)).toBe(true)

    await reauth()
    const res = await postJson(app, `/api/admin/users/${alice.id}/purge`, undefined, {
      headers: admin.headers,
    })
    expect(res.statusCode, res.body).toBe(204)

    expect(existsSync(trashDir)).toBe(false)
    expect(readdirSync(app.deps.paths.trashDir)).toEqual([])
    const purged = userRow(alice.id)
    expect(purged?.purged_at).toBe(ctx.clock.nowIso())
    expect(purged?.trash_dir).toBeNull()
    // 用户名仍保持墓碑名（不复活），但列表里已经消失
    expect(purged?.username).toBe(`alice#del${alice.id}`)
    expect((await fetchDeletedList()).total).toBe(0)

    const audit = latestAudit('user.purge')
    expect(audit?.detail).toMatchObject({ username: 'alice', reason: 'manual', dataDeleted: true })
    expect(audit?.actorId).toBe(admin.user.id)

    // 再次彻底删除 → 409，不重复审计
    const again = await postJson(app, `/api/admin/users/${alice.id}/purge`, undefined, {
      headers: admin.headers,
    })
    expect(again.statusCode).toBe(409)
    expect(errorCode(json(again))).toBe('CONFLICT')
  })

  // ── §2.6 删除时 purge=true ─────────────────────────────────────────────────

  it('6. 删除时 purge=true：直接 purged_at 置位、不进回收站、不留 trash 数据', async () => {
    await app.deps.services.instances.provision(alice.id)
    await removeUser(alice, { purge: true })

    const row = userRow(alice.id)
    expect(row?.deleted_at).toBe(ctx.clock.nowIso())
    expect(row?.purged_at).toBe(ctx.clock.nowIso())
    expect(row?.deleted_username).toBe('alice')
    expect(row?.username).toBe(`alice#del${alice.id}`)
    expect(row?.trash_dir).toBeNull()
    expect(readdirSync(app.deps.paths.trashDir)).toEqual([])
    expect((await fetchDeletedList()).total).toBe(0)
  })

  // ── §2.7 过期自动清理 ──────────────────────────────────────────────────────

  it('7. sweepExpiredDeletions：超过 7 天的条目被自动彻底删除（trash 删除、purged_at 置位）', async () => {
    await app.deps.services.instances.provision(alice.id)
    await removeUser(alice)
    const row = userRow(alice.id)!
    const trashDir = trashAbs(row)

    // 未过期时 sweep 不动它
    expect(await app.deps.services.adminUsers.sweepExpiredDeletions()).toEqual({ purged: 0, failed: 0 })
    expect(userRow(alice.id)?.purged_at).toBeNull()

    ctx.clock.advance(8 * DAY_MS)
    const result = await app.deps.services.adminUsers.sweepExpiredDeletions()
    expect(result).toEqual({ purged: 1, failed: 0 })

    expect(existsSync(trashDir)).toBe(false)
    expect(userRow(alice.id)?.purged_at).toBe(ctx.clock.nowIso())
    // 推进 8 天后旧 admin 会话已过期，重新建一个再查列表
    admin = loginAs(app, admin.user)
    expect((await fetchDeletedList()).total).toBe(0)
    // 自动清理的审计 actor 为空、detail.reason='expired'
    const audit = latestAudit('user.purge')
    expect(audit?.actorId).toBeNull()
    expect(audit?.detail).toMatchObject({ username: 'alice', reason: 'expired', dataDeleted: true })
  })
})

// ── §2.8 迁移 006 对存量软删数据的回填 ──────────────────────────────────────

describe('迁移 006：用户回收站（存量软删数据回填）', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('8. 006 已应用；存量软删行补 deleted_username 且 username 加 #del 墓碑', () => {
    // 先只跑到 005，模拟升级前的旧库
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-wp22-mig-'))
    tempDirs.push(dir)
    for (const migration of loadMigrations(resolveMigrationsDir()).filter((m) => m.version <= '005')) {
      writeFileSync(join(dir, migration.file), migration.sql)
    }
    const db = openDb(':memory:')
    try {
      runMigrations(db, { dir })
      const at = '2026-10-01T00:00:00.000Z'
      const insert = (username: string) =>
        db.run(
          `INSERT INTO users (slug, username, display_name, bio, password_hash, role, status,
                              must_change_password, created_at, updated_at, deleted_at)
           VALUES (?, ?, '', '', 'x', 'user', 'disabled', 0, ?, ?, ?)`,
          `u${String(Math.random()).slice(2, 9)}`,
          username,
          at,
          at,
          at,
        ).lastInsertRowid
      const plainId = insert('legacy')
      const alreadyTaggedId = insert('someuser#del5')

      const result = runMigrations(db) // 全量迁移：006 起继续应用
      expect(result.applied.map((m) => m.version)).toContain('006')

      const plain = db.get<{ username: string; deleted_username: string | null }>(
        'SELECT username, deleted_username FROM users WHERE id = ?',
        plainId,
      )
      expect(plain?.deleted_username).toBe('legacy')
      expect(plain?.username).toBe(`legacy#del${plainId}`)

      // 已经带墓碑名的存量行：不重复加后缀，仍能还原原名
      const tagged = db.get<{ username: string; deleted_username: string | null }>(
        'SELECT username, deleted_username FROM users WHERE id = ?',
        alreadyTaggedId,
      )
      expect(tagged?.deleted_username).toBe('someuser')
      expect(tagged?.username).toBe('someuser#del5')

      // 迁移幂等：再跑一次全部跳过
      expect(runMigrations(db).applied).toEqual([])
    } finally {
      db.close()
    }
  })
})
