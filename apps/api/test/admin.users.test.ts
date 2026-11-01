import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { adminSession, deleteJson, errorCode, getJson, patchJson, postJson } from './wp1-helpers.js'

let ctx: TestApp
let app: FastifyInstance
let admin: Awaited<ReturnType<typeof adminSession>>
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

function auditActions(): string[] {
  return app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id').map((r) => r.action)
}

function userRow(id: number) {
  return app.deps.db.get<{
    role: string
    status: string
    display_name: string
    quota_json: string | null
    model_policy: string
    runtime_id: number | null
    deleted_at: string | null
  }>('SELECT role, status, display_name, quota_json, model_policy, runtime_id, deleted_at FROM users WHERE id = ?', id)
}

function instanceRow(id: number) {
  return app.deps.db.get<{ user_id: number; status: string }>(
    'SELECT user_id, status FROM instances WHERE user_id = ?',
    id,
  )
}

describe('管理端用户（04 §4.1 §4.2）', () => {
  it('权限：普通用户 403、匿名 401、管理员 200', async () => {
    const userSession = loginAs(app, alice)
    for (const [method, url] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/admin/invites'],
      ['GET', '/api/admin/settings'],
    ] as const) {
      const asUser = await app.inject({ method, url, headers: userSession.headers })
      expect(asUser.statusCode, `${method} ${url}`).toBe(403)
      expect(errorCode(json(asUser))).toBe('FORBIDDEN')
      expect((await app.inject({ method, url })).statusCode, `${method} ${url} 匿名`).toBe(401)
    }
    expect((await getJson(app, '/api/admin/users', { headers: admin.headers })).statusCode).toBe(200)
    expect(
      (await patchJson(app, `/api/admin/users/${alice.id}`, { status: 'disabled' }, { headers: userSession.headers }))
        .statusCode,
    ).toBe(403)
    expect(
      (await deleteJson(app, `/api/admin/users/${alice.id}`, { headers: userSession.headers })).statusCode,
    ).toBe(403)
  })

  it('列表：分页、搜索、状态/角色筛选、排序', async () => {
    await createUser(app, { username: 'bob', displayName: '鲍勃', status: 'pending' })
    await createUser(app, { username: 'carol', status: 'disabled' })
    await createUser(app, { username: 'dave', role: 'admin' })

    const all = json<{ items: { username: string }[]; total: number; page: number; pageSize: number }>(
      await getJson(app, '/api/admin/users?page=1&pageSize=2', { headers: admin.headers }),
    )
    expect(all.items).toHaveLength(2)
    expect(all.total).toBe(5) // admin + alice + bob + carol + dave
    expect(all.page).toBe(1)
    expect(all.pageSize).toBe(2)

    const secondPage = json<{ items: { username: string }[] }>(
      await getJson(app, '/api/admin/users?page=2&pageSize=2', { headers: admin.headers }),
    )
    expect(secondPage.items).toHaveLength(2)

    const searched = json<{ items: { username: string }[]; total: number }>(
      await getJson(app, '/api/admin/users?q=爱丽丝', { headers: admin.headers }),
    )
    expect(searched.total).toBe(1)
    expect(searched.items[0]!.username).toBe('alice')

    const pending = json<{ items: { username: string }[] }>(
      await getJson(app, '/api/admin/users?status=pending', { headers: admin.headers }),
    )
    expect(pending.items.map((i) => i.username)).toEqual(['bob'])

    const admins = json<{ items: { username: string }[] }>(
      await getJson(app, '/api/admin/users?role=admin&sort=username:asc', { headers: admin.headers }),
    )
    expect(admins.items.map((i) => i.username)).toEqual(['dave', 'root-admin'])

    const sorted = json<{ items: { username: string }[] }>(
      await getJson(app, '/api/admin/users?sort=username:desc&pageSize=100', { headers: admin.headers }),
    )
    expect(sorted.items.map((i) => i.username)).toEqual(['root-admin', 'dave', 'carol', 'bob', 'alice'])

    // instance 筛选在 instances 表还不存在（WP2 未合并）时也不能报错
    const withInstance = await getJson(app, '/api/admin/users?instance=running', { headers: admin.headers })
    expect(withInstance.statusCode).toBe(200)
  })

  it('新建用户：给密码 / 不给密码（临时密码 + 强制改密）；重名与保留字被拒', async () => {
    const created = await postJson(
      app,
      '/api/admin/users',
      { username: 'newby', password: 'Fresh-pass-1', displayName: '新同事' },
      { headers: admin.headers },
    )
    expect(created.statusCode, created.body).toBe(201)
    const createdBody = json<{ user: { id: number; status: string; displayName: string }; tempPassword?: string }>(
      created,
    )
    expect(createdBody.tempPassword).toBeUndefined()
    expect(createdBody.user.displayName).toBe('新同事')
    expect(userRow(createdBody.user.id)?.status).toBe('active')
    // 04 §7 的 user.create（管理员建号，与自助注册的 auth.register 区分）
    expect(auditActions()).toContain('user.create')
    const createAudit = app.deps.db.get<{ target_id: string; detail_json: string }>(
      "SELECT target_id, detail_json FROM audit_logs WHERE action = 'user.create' ORDER BY id DESC LIMIT 1",
    )
    expect(createAudit?.target_id).toBe(String(createdBody.user.id))
    expect(createAudit?.detail_json).toContain('newby')

    const withTemp = await postJson(app, '/api/admin/users', { username: 'temp-user' }, { headers: admin.headers })
    expect(withTemp.statusCode).toBe(201)
    const temp = json<{ tempPassword: string; user: { mustChangePassword: boolean } }>(withTemp)
    expect(temp.tempPassword).toHaveLength(14)
    expect(temp.user.mustChangePassword).toBe(true)

    const weak = await postJson(
      app,
      '/api/admin/users',
      { username: 'weak-user', password: 'password123' },
      { headers: admin.headers },
    )
    expect(weak.statusCode).toBe(400)
    expect(errorCode(json(weak))).toBe('WEAK_PASSWORD')

    const duplicate = await postJson(app, '/api/admin/users', { username: 'alice' }, { headers: admin.headers })
    expect(duplicate.statusCode).toBe(409)
    expect(errorCode(json(duplicate))).toBe('USERNAME_TAKEN')

    const reserved = await postJson(app, '/api/admin/users', { username: 'root' }, { headers: admin.headers })
    expect(reserved.statusCode).toBe(400)
    expect(errorCode(json(reserved))).toBe('USERNAME_RESERVED')
  })

  it('角色标签：普通用户可带自定义标签，管理员恒为空；候选列表、筛选与审计', async () => {
    type CreatedUser = { user: { id: number; role: string; roleLabel: string } }
    const create = async (body: Record<string, unknown>) => {
      const res = await postJson(app, '/api/admin/users', body, { headers: admin.headers })
      expect(res.statusCode, res.body).toBe(201)
      return json<CreatedUser>(res).user
    }
    const labelOf = (id: number) =>
      app.deps.db.get<{ role_label: string }>('SELECT role_label FROM users WHERE id = ?', id)?.role_label

    const mom = await create({ username: 'mom', roleLabel: ' 家人 ' })
    expect(mom).toMatchObject({ role: 'user', roleLabel: '家人' })
    await create({ username: 'dad', roleLabel: '家人' })
    const pal = await create({ username: 'pal', roleLabel: '朋友' })
    // 「普通用户」就是空串；管理员带标签也存空串
    expect((await create({ username: 'plain', roleLabel: '普通用户' })).roleLabel).toBe('')
    const boss = await create({ username: 'boss', role: 'admin', roleLabel: '家人' })
    expect(boss).toMatchObject({ role: 'admin', roleLabel: '' })
    expect(labelOf(boss.id)).toBe('')

    // 「管理员」是保留名，不能拿来当普通用户的标签；超长被拒
    const reserved = await postJson(
      app,
      '/api/admin/users',
      { username: 'fake-admin', roleLabel: '管理员' },
      { headers: admin.headers },
    )
    expect(reserved.statusCode).toBe(400)
    expect(errorCode(json(reserved))).toBe('VALIDATION_FAILED')
    const tooLong = await postJson(
      app,
      '/api/admin/users',
      { username: 'long-label', roleLabel: '一二三四五六七八九十一二三四五六七' },
      { headers: admin.headers },
    )
    expect(tooLong.statusCode).toBe(400)

    // 候选列表：按人数倒序，不含管理员与空标签
    const labels = json<{ items: { label: string; count: number }[] }>(
      await getJson(app, '/api/admin/users/role-labels', { headers: admin.headers }),
    )
    expect(labels.items).toEqual([
      { label: '家人', count: 2 },
      { label: '朋友', count: 1 },
    ])
    const asUser = await getJson(app, '/api/admin/users/role-labels', {
      headers: loginAs(app, alice).headers,
    })
    expect(asUser.statusCode).toBe(403)

    const family = json<{ items: { username: string }[] }>(
      await getJson(app, `/api/admin/users?roleLabel=${encodeURIComponent('家人')}&sort=username:asc`, {
        headers: admin.headers,
      }),
    )
    expect(family.items.map((i) => i.username)).toEqual(['dad', 'mom'])

    // 只改标签：记 user.role.change（带 fromLabel/toLabel）
    const relabeled = await patchJson(
      app,
      `/api/admin/users/${pal.id}`,
      { roleLabel: '同事' },
      { headers: admin.headers },
    )
    expect(relabeled.statusCode, relabeled.body).toBe(200)
    expect(json<CreatedUser>(relabeled).user.roleLabel).toBe('同事')
    const roleAudit = app.deps.db.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'user.role.change' ORDER BY id DESC LIMIT 1",
    )
    expect(JSON.parse(roleAudit!.detail_json)).toEqual({
      from: 'user',
      to: 'user',
      fromLabel: '朋友',
      toLabel: '同事',
    })

    // 升为管理员：标签清空；再降回普通用户可以顺手给新标签
    await patchJson(app, `/api/admin/users/${pal.id}`, { role: 'admin' }, { headers: admin.headers })
    expect(labelOf(pal.id)).toBe('')
    await patchJson(
      app,
      `/api/admin/users/${pal.id}`,
      { role: 'user', roleLabel: '朋友' },
      { headers: admin.headers },
    )
    expect(labelOf(pal.id)).toBe('朋友')

    // 没变化不写审计
    const before = auditActions().length
    await patchJson(app, `/api/admin/users/${pal.id}`, { roleLabel: '朋友' }, { headers: admin.headers })
    expect(auditActions()).toHaveLength(before)
  })

  it('详情：user + 会话数 + 相关审计（插件列表留给 WP3）', async () => {
    loginAs(app, alice)
    loginAs(app, alice)
    const res = await getJson(app, `/api/admin/users/${alice.id}`, { headers: admin.headers })
    expect(res.statusCode).toBe(200)
    const body = json<{
      user: { username: string; displayName: string; quotaIsDefault: boolean; quota: { cpus: number } }
      sessions: number
      plugins: unknown[]
      recentAudit: { action: string }[]
    }>(res)
    expect(body.user.username).toBe('alice')
    expect(body.user.quotaIsDefault).toBe(true)
    expect(body.user.quota.cpus).toBe(2) // settings.default_quota
    expect(body.sessions).toBe(2)
    expect(body.plugins).toEqual([])

    const missing = await getJson(app, '/api/admin/users/9999', { headers: admin.headers })
    expect(missing.statusCode).toBe(404)
  })

  it('审批：pending → active（审计 user.approve）；非 pending → CONFLICT', async () => {
    const pending = await createUser(app, { username: 'waiter', status: 'pending' })
    const res = await postJson(app, `/api/admin/users/${pending.id}/approve`, {}, { headers: admin.headers })
    expect(res.statusCode).toBe(200)
    expect(userRow(pending.id)?.status).toBe('active')
    expect(auditActions()).toContain('user.approve')

    const again = await postJson(app, `/api/admin/users/${pending.id}/approve`, {}, { headers: admin.headers })
    expect(again.statusCode).toBe(409)
    expect(errorCode(json(again))).toBe('CONFLICT')
  })

  it('更新用户：昵称/角色/状态/配额/模型策略，并写对应审计', async () => {
    const res = await patchJson(
      app,
      `/api/admin/users/${alice.id}`,
      {
        displayName: '爱丽丝·改',
        role: 'admin',
        status: 'disabled',
        quota: { cpus: 4, memoryMb: 4096 },
        modelPolicy: 'free',
        runtimeId: 7,
        modelPresetId: 3,
      },
      { headers: admin.headers },
    )
    expect(res.statusCode, res.body).toBe(200)
    const row = userRow(alice.id)!
    expect(row.display_name).toBe('爱丽丝·改')
    expect(row.role).toBe('admin')
    expect(row.status).toBe('disabled')
    expect(row.model_policy).toBe('free')
    expect(row.runtime_id).toBe(7)
    const quota = JSON.parse(row.quota_json!) as Record<string, unknown>
    expect(quota.cpus).toBe(4)
    expect(quota.memoryMb).toBe(4096)
    expect(quota.diskGb).toBe(20) // 未给的部分沿用默认
    const actions = auditActions()
    for (const action of ['user.role.change', 'user.disable', 'user.quota.change', 'user.update']) {
      expect(actions).toContain(action)
    }

    // quota=null 恢复全局默认
    const restored = await patchJson(
      app,
      `/api/admin/users/${alice.id}`,
      { quota: null },
      { headers: admin.headers },
    )
    expect(restored.statusCode).toBe(200)
    expect(userRow(alice.id)?.quota_json).toBeNull()

    // 非法配额 → VALIDATION_FAILED
    const invalid = await patchJson(
      app,
      `/api/admin/users/${alice.id}`,
      { quota: { cpus: 99 } },
      { headers: admin.headers },
    )
    expect(invalid.statusCode).toBe(400)
    expect(errorCode(json(invalid))).toBe('VALIDATION_FAILED')
  })

  it('最后一个管理员：不能降级/停用/删除（CONFLICT）', async () => {
    const solo = await createUser(app, { username: 'solo-admin', role: 'admin' })
    const soloSession = loginAs(app, solo)
    // 把 root-admin 降级，之后 solo 就是唯一管理员
    expect(
      (
        await patchJson(
          app,
          `/api/admin/users/${admin.user.id}`,
          { role: 'user' },
          { headers: admin.headers },
        )
      ).statusCode,
    ).toBe(200)

    const demote = await patchJson(
      app,
      `/api/admin/users/${solo.id}`,
      { role: 'user' },
      { headers: soloSession.headers },
    )
    expect(demote.statusCode, demote.body).toBe(409)
    expect(errorCode(json(demote))).toBe('CONFLICT')

    // 此时 root-admin 已被降级，只有 solo 自己是管理员 —— 用 solo 的会话继续验证
    const disable = await patchJson(
      app,
      `/api/admin/users/${solo.id}`,
      { status: 'disabled' },
      { headers: soloSession.headers },
    )
    expect(disable.statusCode, disable.body).toBe(409)
    expect(errorCode(json(disable))).toBe('CONFLICT')

    // 删除需要 reauth（先输密码），再命中「最后一个管理员」保护
    await postJson(app, '/api/auth/reauth', { password: solo.password }, { headers: soloSession.headers })
    const remove = await deleteJson(app, `/api/admin/users/${solo.id}`, { headers: soloSession.headers })
    expect(remove.statusCode, remove.body).toBe(409)
    expect(errorCode(json(remove))).toBe('CONFLICT')
    expect(userRow(solo.id)?.deleted_at).toBeNull()

    // 有第二个管理员时，停用是允许的（保护只针对"最后一个"）
    expect(
      (
        await patchJson(
          app,
          `/api/admin/users/${admin.user.id}`,
          { role: 'admin' },
          { headers: soloSession.headers },
        )
      ).statusCode,
    ).toBe(200)
    const nowAllowed = await patchJson(
      app,
      `/api/admin/users/${admin.user.id}`,
      { status: 'disabled' },
      { headers: soloSession.headers },
    )
    expect(nowAllowed.statusCode, nowAllowed.body).toBe(200)
  })

  it('不能删除自己；删除别人是软删除 + 审计', async () => {
    // 删除需要 reauth：没输密码先 403 REAUTH_REQUIRED
    const needReauth = await deleteJson(app, `/api/admin/users/${alice.id}`, { headers: admin.headers })
    expect(needReauth.statusCode).toBe(403)
    expect(errorCode(json(needReauth))).toBe('REAUTH_REQUIRED')
    await postJson(app, '/api/auth/reauth', { password: admin.user.password }, { headers: admin.headers })

    // 先造第二个管理员，让「不能删自己」单独生效（否则会先命中最后一个管理员保护）
    await createUser(app, { username: 'second-admin', role: 'admin' })
    const self = await deleteJson(app, `/api/admin/users/${admin.user.id}`, { headers: admin.headers })
    expect(self.statusCode, self.body).toBe(403)
    expect(errorCode(json(self))).toBe('FORBIDDEN')

    const bobSession = loginAs(app, alice)
    const res = await deleteJson(app, `/api/admin/users/${alice.id}?purge=true`, { headers: admin.headers })
    expect(res.statusCode).toBe(204)
    const row = userRow(alice.id)
    expect(row?.deleted_at).toBe(ctx.clock.nowIso())
    expect(row?.status).toBe('disabled')
    // 会话被吊销、登录被拒、列表里不再出现
    expect((await getJson(app, '/api/auth/me', { headers: bobSession.headers })).statusCode).toBe(401)
    expect(
      (await postJson(app, '/api/auth/login', { username: 'alice', password: 'test-password-1' })).statusCode,
    ).toBe(401)
    const list = json<{ items: { username: string }[] }>(
      await getJson(app, '/api/admin/users', { headers: admin.headers }),
    )
    expect(list.items.map((i) => i.username)).not.toContain('alice')
    expect(auditActions()).toContain('user.delete')
    // 清理实例数据成功（软删除在前、removeUserData 在后，也不能报「用户不存在」）
    const audit = app.deps.db.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'user.delete' ORDER BY id DESC LIMIT 1",
    )
    expect(JSON.parse(audit?.detail_json ?? '{}')).toMatchObject({ cleanupError: null })
  })

  // 热修回归：删除用户时先软删除再清数据。removeUserData 曾用 requireUser（软删除即「用户不存在」），
  // 异常被 deleteUser 吞进 cleanupError，容器、instances 行、数据目录全部残留。
  it('删除有实例行的用户：实例行与数据目录一并清理，cleanupError 为 null', async () => {
    await app.deps.services.instances.provision(alice.id)
    expect(instanceRow(alice.id)).toBeDefined()
    expect(existsSync(app.deps.paths.userDir(alice.slug))).toBe(true)

    await postJson(app, '/api/auth/reauth', { password: admin.user.password }, { headers: admin.headers })
    const res = await deleteJson(app, `/api/admin/users/${alice.id}?purge=true`, { headers: admin.headers })
    expect(res.statusCode).toBe(204)

    expect(userRow(alice.id)?.deleted_at).toBe(ctx.clock.nowIso())
    expect(instanceRow(alice.id)).toBeUndefined()
    expect(existsSync(app.deps.paths.userDir(alice.slug))).toBe(false)
    const audit = app.deps.db.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'user.delete' ORDER BY id DESC LIMIT 1",
    )
    expect(JSON.parse(audit?.detail_json ?? '{}')).toMatchObject({ cleanupError: null })
  })

  it('重置密码需要 reauth；吊销会话返回数量', async () => {
    const session = loginAs(app, alice)
    expect((await getJson(app, '/api/auth/me', { headers: session.headers })).statusCode).toBe(200)

    const needReauth = await postJson(
      app,
      `/api/admin/users/${alice.id}/revoke-sessions`,
      {},
      { headers: admin.headers },
    )
    // revoke-sessions 不需要 reauth，直接成功
    expect(needReauth.statusCode).toBe(200)
    expect(json<{ revoked: number }>(needReauth).revoked).toBe(1)
    expect((await getJson(app, '/api/auth/me', { headers: session.headers })).statusCode).toBe(401)

    const stillNoReauth = await postJson(
      app,
      `/api/admin/users/${alice.id}/reset-password`,
      {},
      { headers: admin.headers },
    )
    expect(stillNoReauth.statusCode).toBe(403)
    expect(errorCode(json(stillNoReauth))).toBe('REAUTH_REQUIRED')

    await postJson(app, '/api/auth/reauth', { password: admin.user.password }, { headers: admin.headers })
    const reset = await postJson(
      app,
      `/api/admin/users/${alice.id}/reset-password`,
      {},
      { headers: admin.headers },
    )
    expect(reset.statusCode).toBe(200)
    expect(json<{ tempPassword: string }>(reset).tempPassword).toHaveLength(14)
    expect(userRow(alice.id)?.status).toBe('active')
  })

  it('概览：用户统计 + 最近注册/审计；实例/宿主/版本字段先占位', async () => {
    // 造一条审计（概览的 recent.audit 来自 audit_logs）
    await postJson(app, '/api/auth/login', { username: 'alice', password: 'test-password-1' })
    const res = await getJson(app, '/api/admin/overview', { headers: admin.headers })
    expect(res.statusCode).toBe(200)
    const body = json<{
      users: { total: number; active: number; pending: number; disabled: number; newToday: number }
      instances: { running: number; max: number }
      host: { dockerOk: boolean }
      jobs: { running: number; queued: number; failedLast24h: number }
      runtime: { defaultVersion: string | null; versions: number }
      recent: { registrations: { username: string }[]; audit: { action: string }[] }
    }>(res)
    expect(body.users).toEqual({ total: 2, active: 2, pending: 0, disabled: 0, newToday: 2 })
    expect(body.instances.running).toBe(0)
    expect(body.instances.max).toBe(12)
    expect(body.jobs).toEqual({ running: 0, queued: 0, failedLast24h: 0 })
    expect(body.runtime).toEqual({ defaultVersion: null, versions: 0 })
    expect(body.recent.registrations.length).toBeGreaterThan(0)
    expect(body.recent.audit.length).toBeGreaterThan(0)
  })

  it('概览的 jobs 字段来自 services.jobs.overviewCounts()（04 §9 第 6 条口径）', async () => {
    const now = ctx.clock.nowIso()
    const insertJob = (status: string, finishedAt: string | null): void => {
      app.deps.db.run(
        `INSERT INTO jobs (type, title, status, params_json, total, done, failed, created_at, finished_at)
         VALUES ('export', ?, ?, '{}', 0, 0, 0, ?, ?)`,
        `作业 ${status}`,
        status,
        now,
        finishedAt,
      )
    }
    insertJob('running', null)
    insertJob('queued', null)
    insertJob('failed', now) // 24 小时内失败 → 计入
    insertJob('partial', now) // partial 也算失败（WP4 定稿口径）
    insertJob('failed', new Date(Date.parse(now) - 30 * 3_600_000).toISOString()) // 30 小时前 → 不计
    insertJob('succeeded', now)

    const body = json<{ jobs: { running: number; queued: number; failedLast24h: number } }>(
      await getJson(app, '/api/admin/overview', { headers: admin.headers }),
    )
    expect(body.jobs).toEqual({ running: 1, queued: 1, failedLast24h: 2 })

    // 时间推进 25 小时后，之前那两条不再计入（管理员会话有 12 小时绝对过期，重新取一个）
    ctx.clock.advance(25 * 3_600_000)
    const freshAdmin = loginAs(app, admin.user)
    const later = json<{ jobs: { running: number; queued: number; failedLast24h: number } }>(
      await getJson(app, '/api/admin/overview', { headers: freshAdmin.headers }),
    )
    expect(later.jobs).toEqual({ running: 1, queued: 1, failedLast24h: 0 })
  })
})
