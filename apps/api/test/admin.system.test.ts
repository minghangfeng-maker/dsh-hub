import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { INVITE_CODE_REGEX } from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp } from './helpers.js'
import { adminSession, deleteJson, errorCode, getJson, patchJson, postJson } from './wp1-helpers.js'

let ctx: TestApp
let app: FastifyInstance
let admin: Awaited<ReturnType<typeof adminSession>>

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  admin = await adminSession(app, 'root-admin')
})

afterEach(async () => {
  await ctx.close()
})

function auditActions(): string[] {
  return app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id').map((r) => r.action)
}

describe('邀请码（04 §4.4）', () => {
  it('生成：12 位去混淆字符集、可批量、写审计', async () => {
    const res = await postJson(
      app,
      '/api/admin/invites',
      { count: 3, maxUses: 2, note: '团建', expiresAt: '2027-01-01T00:00:00.000Z' },
      { headers: admin.headers },
    )
    expect(res.statusCode, res.body).toBe(201)
    const items = json<{
      items: { id: number; code: string; note: string; maxUses: number; usedCount: number; expiresAt: string }[]
    }>(res).items
    expect(items).toHaveLength(3)
    for (const item of items) {
      expect(item.code).toMatch(INVITE_CODE_REGEX)
      expect(item.code).toHaveLength(12)
      expect(item.code).not.toMatch(/[0O1IL]/)
      expect(item.note).toBe('团建')
      expect(item.maxUses).toBe(2)
      expect(item.usedCount).toBe(0)
    }
    expect(new Set(items.map((i) => i.code)).size).toBe(3)
    expect(auditActions()).toContain('invite.create')

    const tooMany = await postJson(app, '/api/admin/invites', { count: 51 }, { headers: admin.headers })
    expect(tooMany.statusCode).toBe(400)
    expect(errorCode(json(tooMany))).toBe('VALIDATION_FAILED')
  })

  it('列表分页；修改（备注/停用/次数/过期）；审计', async () => {
    const created = json<{ items: { id: number }[] }>(
      await postJson(app, '/api/admin/invites', { count: 5, maxUses: 1 }, { headers: admin.headers }),
    ).items
    const list = json<{ items: { id: number }[]; total: number; pageSize: number }>(
      await getJson(app, '/api/admin/invites?page=1&pageSize=2', { headers: admin.headers }),
    )
    expect(list.total).toBe(5)
    expect(list.items).toHaveLength(2)

    const patched = await patchJson(
      app,
      `/api/admin/invites/${created[0]!.id}`,
      { note: '改过', disabled: true, maxUses: 3, expiresAt: null },
      { headers: admin.headers },
    )
    expect(patched.statusCode, patched.body).toBe(200)
    const row = json<{ invite: { note: string; disabled: boolean; maxUses: number; expiresAt: string | null } }>(
      patched,
    ).invite
    expect(row).toMatchObject({ note: '改过', disabled: true, maxUses: 3, expiresAt: null })
    expect(auditActions()).toContain('invite.update')

    const missing = await patchJson(app, '/api/admin/invites/9999', { note: 'x' }, { headers: admin.headers })
    expect(missing.statusCode).toBe(404)
  })

  it('删除：只有没用过的能删；用过的 → CONFLICT；maxUses 不能低于已用次数', async () => {
    const [used, unused] = json<{ items: { id: number; code: string }[] }>(
      await postJson(app, '/api/admin/invites', { count: 2, maxUses: 1 }, { headers: admin.headers }),
    ).items

    // 用一个码注册一个用户
    app.deps.settings.set('registration', { mode: 'invite', requireApproval: false, maxUsers: 50 })
    const registered = await postJson(app, '/api/auth/register', {
      username: 'invited-user',
      password: 'Str0ng-pass-1',
      inviteCode: used!.code,
    })
    expect(registered.statusCode, registered.body).toBe(201)

    const removeUsed = await deleteJson(app, `/api/admin/invites/${used!.id}`, { headers: admin.headers })
    expect(removeUsed.statusCode).toBe(409)
    expect(errorCode(json(removeUsed))).toBe('CONFLICT')

    const lowerMax = await patchJson(
      app,
      `/api/admin/invites/${used!.id}`,
      { maxUses: 0 },
      { headers: admin.headers },
    )
    expect(lowerMax.statusCode).toBe(400) // schema 下限是 1

    const equalMax = await patchJson(
      app,
      `/api/admin/invites/${used!.id}`,
      { maxUses: 1 },
      { headers: admin.headers },
    )
    expect(equalMax.statusCode).toBe(200)

    const removeUnused = await deleteJson(app, `/api/admin/invites/${unused!.id}`, { headers: admin.headers })
    expect(removeUnused.statusCode).toBe(204)
    expect(auditActions()).toContain('invite.delete')
  })
})

describe('系统设置与公共站点（04 §1 §4.4）', () => {
  it('GET 返回全量默认值；PATCH 按键整体替换并写审计', async () => {
    const defaults = json<{ registration: { mode: string; maxUsers: number }; capacity: { maxRunning: number } }>(
      await getJson(app, '/api/admin/settings', { headers: admin.headers }),
    )
    expect(defaults.registration.mode).toBe('invite')
    expect(defaults.registration.maxUsers).toBe(50)
    expect(defaults.capacity.maxRunning).toBe(12)

    const res = await patchJson(
      app,
      '/api/admin/settings',
      {
        registration: { mode: 'open', requireApproval: true, maxUsers: 10 },
        site: { name: '示例 Hub', tagline: '云上工作台', announcement: '维护中', announcementLevel: 'warning' },
      },
      { headers: admin.headers },
    )
    expect(res.statusCode, res.body).toBe(200)
    const updated = json<{ registration: { mode: string; requireApproval: boolean }; site: { name: string } }>(res)
    expect(updated.registration).toMatchObject({ mode: 'open', requireApproval: true })
    expect(updated.site.name).toBe('示例 Hub')

    const reread = json<{ registration: { mode: string } }>(
      await getJson(app, '/api/admin/settings', { headers: admin.headers }),
    )
    expect(reread.registration.mode).toBe('open')
    expect(auditActions()).toContain('settings.update')
  })

  it('WP40d：容器设置默认完全放行；可以改回需要审批，非法值被拒', async () => {
    const defaults = json<{ container: { permissionPreset: string; chatPreset: boolean } }>(
      await getJson(app, '/api/admin/settings', { headers: admin.headers }),
    )
    expect(defaults.container).toEqual({ permissionPreset: 'danger-full-access', chatPreset: false })

    const res = await patchJson(
      app,
      '/api/admin/settings',
      { container: { permissionPreset: 'workspace-write', chatPreset: false } },
      { headers: admin.headers },
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(json<{ container: { permissionPreset: string } }>(res).container).toMatchObject({
      permissionPreset: 'workspace-write',
      chatPreset: false,
    })

    const bad = await patchJson(
      app,
      '/api/admin/settings',
      { container: { permissionPreset: 'yolo', chatPreset: true } },
      { headers: admin.headers },
    )
    expect(bad.statusCode).toBe(400)
    expect(errorCode(json(bad))).toBe('VALIDATION_FAILED')
  })

  it('非法设置 → VALIDATION_FAILED + details.fields', async () => {
    const res = await patchJson(
      app,
      '/api/admin/settings',
      { registration: { mode: 'nope', requireApproval: false, maxUsers: 10 } },
      { headers: admin.headers },
    )
    expect(res.statusCode).toBe(400)
    expect(errorCode(json(res))).toBe('VALIDATION_FAILED')
    expect(json<{ error: { details: { fields: Record<string, string> } } }>(res).error.details.fields).toBeTruthy()
  })

  it('GET /api/public/site 未登录可读，反映站点与注册设置', async () => {
    const before = json<{ name: string; registrationMode: string; caCertUrl: string }>(
      await app.inject({ method: 'GET', url: '/api/public/site' }),
    )
    expect(before.name).toBe('DSH Hub')
    expect(before.registrationMode).toBe('invite')
    // 阶段一默认不开 TLS 网关 → 没有根证书可下载（07 §5.1）
    expect(before.caCertUrl).toBeNull()

    await patchJson(
      app,
      '/api/admin/settings',
      { site: { name: '我的 Hub', tagline: 't', announcement: '公告', announcementLevel: 'success' } },
      { headers: admin.headers },
    )
    const after = json<{ name: string; announcement: string; announcementLevel: string }>(
      await app.inject({ method: 'GET', url: '/api/public/site' }),
    )
    expect(after).toMatchObject({ name: '我的 Hub', announcement: '公告', announcementLevel: 'success' })
  })
})

describe('审计查询（04 §4.4）', () => {
  beforeEach(async () => {
    const alice = await createUser(app, { username: 'alice', password: 'Alice-pass-1' })
    // 造几条不同来源的审计：登录失败（匿名）、登录成功（alice）、管理员改设置
    await postJson(app, '/api/auth/login', { username: 'alice', password: 'wrong-password' })
    await postJson(app, '/api/auth/login', { username: 'alice', password: 'Alice-pass-1' })
    // 设置是「按键整体替换」：给了 site 就必须给全字段（04 §4.4）
    await patchJson(
      app,
      '/api/admin/settings',
      { site: { name: 'x', tagline: 'y', announcement: '', announcementLevel: 'info' } },
      { headers: admin.headers },
    )
    void alice
  })

  it('按动作/操作者/目标/时间过滤 + 分页', async () => {
    const all = json<{ items: { action: string; actorUsername: string | null }[]; total: number }>(
      await getJson(app, '/api/admin/audit?pageSize=100', { headers: admin.headers }),
    )
    expect(all.total).toBeGreaterThanOrEqual(3)

    const failures = json<{ items: { action: string }[]; total: number }>(
      await getJson(app, '/api/admin/audit?action=auth.login.failure', { headers: admin.headers }),
    )
    expect(failures.total).toBe(1)
    expect(failures.items[0]!.action).toBe('auth.login.failure')

    const byActor = json<{ items: { actorUsername: string | null }[] }>(
      await getJson(app, `/api/admin/audit?actorId=${admin.user.id}`, { headers: admin.headers }),
    )
    expect(byActor.items.every((i) => i.actorUsername === 'root-admin')).toBe(true)

    const byTarget = json<{ items: { action: string }[] }>(
      await getJson(app, '/api/admin/audit?targetType=settings', { headers: admin.headers }),
    )
    expect(byTarget.items.map((i) => i.action)).toContain('settings.update')

    const wildcard = json<{ items: { action: string }[]; total: number }>(
      await getJson(app, '/api/admin/audit?action=auth.*', { headers: admin.headers }),
    )
    expect(wildcard.total).toBeGreaterThanOrEqual(2)

    const future = await getJson(app, '/api/admin/audit?from=2099-01-01T00:00:00.000Z', {
      headers: admin.headers,
    })
    expect(json<{ total: number }>(future).total).toBe(0)

    const paged = json<{ items: unknown[]; total: number }>(
      await getJson(app, '/api/admin/audit?page=1&pageSize=1', { headers: admin.headers }),
    )
    expect(paged.items).toHaveLength(1)
    expect(paged.total).toBeGreaterThanOrEqual(3)

    const pageSizeTooBig = await getJson(app, '/api/admin/audit?pageSize=1000', { headers: admin.headers })
    expect(pageSizeTooBig.statusCode).toBe(400)
  })

  it('普通用户看不到审计（404 之外的接口一律 403）', async () => {
    const alice = await createUser(app, { username: 'normal', password: 'Normal-pass-1' })
    const session = loginAs(app, alice)
    expect((await getJson(app, '/api/admin/audit', { headers: session.headers })).statusCode).toBe(403)
  })
})

describe('公共站点信息：caCertUrl 恒为 null（阶段二改用 Let\'s Encrypt，WP7b）', () => {
  it('开了 TLS 网关也不再提示安装根证书（04 §1、00 D20）', async () => {
    const tls = await createTestApp({ env: { HUB_TLS_PORT: '7772' } })
    try {
      const site = json<{ caCertUrl: string | null }>(
        await tls.app.inject({ method: 'GET', url: '/api/public/site' }),
      )
      expect(site.caCertUrl).toBeNull()
    } finally {
      await tls.close()
    }
  })
})
