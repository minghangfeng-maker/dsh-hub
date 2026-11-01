import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, json, type TestApp } from './helpers.js'
import { adminSession, errorCode, getJson, patchJson, postJson } from './wp1-helpers.js'

/**
 * WP9：邀请码带角色（04 §4.4 §2、03 §1.1 迁移 005）。
 *
 * 安全底线（本文件逐条钉住）：邀请码上只有 `roleLabel`，**没有** `role` —— 用它注册的人
 * 恒为 `role='user'`；请求体里夹带 `role: 'admin'` 一律被 zod 丢弃，不留任何效果。
 */

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

function setRegistration(patch: { mode?: 'open' | 'invite' | 'closed'; requireApproval?: boolean }): void {
  app.deps.settings.set('registration', { mode: 'invite', requireApproval: false, maxUsers: 50, ...patch })
}

/** 从回环地址注册：豁免按 IP 的注册限流（02 §5），一个用例里可以放心连发 */
function register(body: Record<string, unknown>) {
  return postJson(app, '/api/auth/register', { password: 'Str0ng-pass-1', ...body }, { ip: '127.0.0.1' })
}

interface InviteBody {
  items: { id: number; code: string; roleLabel: string; maxUses: number; usedCount: number }[]
}

async function createInvite(body: Record<string, unknown>): Promise<InviteBody['items'][number]> {
  const res = await postJson(
    app,
    '/api/admin/invites',
    { count: 1, maxUses: 1, ...body },
    { headers: admin.headers },
  )
  expect(res.statusCode, res.body).toBe(201)
  return json<InviteBody>(res).items[0]!
}

function userRow(username: string): { role: string; role_label: string } | undefined {
  return app.deps.db.get<{ role: string; role_label: string }>(
    'SELECT role, role_label FROM users WHERE username = ?',
    username,
  )
}

function lastDetail(action: string): Record<string, unknown> {
  const row = app.deps.db.get<{ detail_json: string }>(
    'SELECT detail_json FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1',
    action,
  )
  return row ? (JSON.parse(row.detail_json) as Record<string, unknown>) : {}
}

function auditCount(action: string): number {
  return Number(
    app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?', action)?.n ?? 0,
  )
}

describe('邀请码带角色：生成（04 §4.4）', () => {
  it('roleLabel 规范化入库，响应与 invite.create 审计都带上角色', async () => {
    const family = await createInvite({ roleLabel: ' 家人 ', note: '给同事的码' })
    expect(family.roleLabel).toBe('家人')
    expect(lastDetail('invite.create')).toMatchObject({ roleLabel: '家人', count: 1 })

    // 「普通用户」= 空串；不给字段 = 默认空串（迁移 005 的 DEFAULT）
    expect((await createInvite({ roleLabel: '普通用户' })).roleLabel).toBe('')
    expect((await createInvite({})).roleLabel).toBe('')
    expect(
      app.deps.db.get<{ role_label: string }>('SELECT role_label FROM invites ORDER BY id DESC LIMIT 1')
        ?.role_label,
    ).toBe('')
  })

  it('「管理员」是保留名、超长被拒；夹带的 role 字段没有任何效果', async () => {
    const reserved = await postJson(
      app,
      '/api/admin/invites',
      { count: 1, roleLabel: '管理员' },
      { headers: admin.headers },
    )
    expect(reserved.statusCode).toBe(400)
    expect(errorCode(json(reserved))).toBe('VALIDATION_FAILED')
    expect(
      json<{ error: { details: { fields: Record<string, string> } } }>(reserved).error.details.fields
        .roleLabel,
    ).toBeTruthy()

    const tooLong = await postJson(
      app,
      '/api/admin/invites',
      { count: 1, roleLabel: '一二三四五六七八九十一二三四五六七' },
      { headers: admin.headers },
    )
    expect(tooLong.statusCode).toBe(400)

    // 邀请码没有 role 字段：多传的 role 被 zod 丢掉，入库与响应都只有 roleLabel
    const sneaky = await postJson(
      app,
      '/api/admin/invites',
      { count: 1, role: 'admin', roleLabel: '家人' },
      { headers: admin.headers },
    )
    expect(sneaky.statusCode, sneaky.body).toBe(201)
    const item = json<InviteBody>(sneaky).items[0]!
    expect(item.roleLabel).toBe('家人')
    expect(item).not.toHaveProperty('role')
    expect(
      app.deps.db.get<{ role_label: string }>('SELECT role_label FROM invites WHERE id = ?', item.id)
        ?.role_label,
    ).toBe('家人')
  })
})

describe('邀请码带角色：修改（04 §4.4）', () => {
  it('改角色生效并记 fromLabel/toLabel；没变化不写审计', async () => {
    const invite = await createInvite({ roleLabel: '家人', maxUses: 5 })

    const changed = await patchJson(
      app,
      `/api/admin/invites/${invite.id}`,
      { roleLabel: ' 朋友 ' },
      { headers: admin.headers },
    )
    expect(changed.statusCode, changed.body).toBe(200)
    expect(json<{ invite: { roleLabel: string } }>(changed).invite.roleLabel).toBe('朋友')
    expect(lastDetail('invite.update')).toEqual({ fromLabel: '家人', toLabel: '朋友' })

    // 同一个值再发一次：既不写库也不记审计（前端保存会把整个表单发过来）
    const before = auditCount('invite.update')
    const again = await patchJson(
      app,
      `/api/admin/invites/${invite.id}`,
      { roleLabel: '朋友' },
      { headers: admin.headers },
    )
    expect(again.statusCode).toBe(200)
    expect(auditCount('invite.update')).toBe(before)

    // 其它字段照旧可改，detail 只列真正变化的项
    const disabled = await patchJson(
      app,
      `/api/admin/invites/${invite.id}`,
      { disabled: true, note: '改过', roleLabel: '朋友' },
      { headers: admin.headers },
    )
    expect(disabled.statusCode).toBe(200)
    expect(json<{ invite: { disabled: boolean; note: string } }>(disabled).invite).toMatchObject({
      disabled: true,
      note: '改过',
    })
    expect(lastDetail('invite.update')).toEqual({ disabled: true, note: '改过' })

    // 保留名依旧被拒（PATCH 也走同一份规范化）
    const reserved = await patchJson(
      app,
      `/api/admin/invites/${invite.id}`,
      { roleLabel: '管理员' },
      { headers: admin.headers },
    )
    expect(reserved.statusCode).toBe(400)
    expect(errorCode(json(reserved))).toBe('VALIDATION_FAILED')
  })
})

describe('邀请码带角色：注册（04 §2）', () => {
  it('用带角色的码注册：role 恒为 user、标签取码上的角色；夹带 role:admin 无效', async () => {
    const invite = await createInvite({ roleLabel: '家人' })

    const res = await register({
      username: 'kid',
      displayName: '小朋友',
      inviteCode: invite.code,
      role: 'admin',
    })
    expect(res.statusCode, res.body).toBe(201)
    const body = json<{ user: { id: number; username: string }; sessionStarted: boolean }>(res)
    expect(body.sessionStarted).toBe(true)
    expect(userRow('kid')).toEqual({ role: 'user', role_label: '家人' })
    expect(lastDetail('auth.register')).toMatchObject({
      username: 'kid',
      inviteId: invite.id,
      roleLabel: '家人',
    })
  })

  it('角色是快照：注册后改码只影响之后注册的人', async () => {
    const invite = await createInvite({ roleLabel: '家人', maxUses: 2 })
    expect((await register({ username: 'first-kid', inviteCode: invite.code })).statusCode).toBe(201)
    expect(userRow('first-kid')?.role_label).toBe('家人')

    await patchJson(app, `/api/admin/invites/${invite.id}`, { roleLabel: '朋友' }, { headers: admin.headers })
    expect((await register({ username: 'second-kid', inviteCode: invite.code })).statusCode).toBe(201)

    expect(userRow('second-kid')?.role_label).toBe('朋友')
    // 先注册的人不会被改写
    expect(userRow('first-kid')?.role_label).toBe('家人')
  })

  it('open 模式注册（不消费邀请码）一律空标签，审计里也没有 roleLabel', async () => {
    setRegistration({ mode: 'open' })
    // 即使库里有带角色的邀请码，open 模式也不会读它
    await createInvite({ roleLabel: '家人' })

    const res = await register({ username: 'walk-in' })
    expect(res.statusCode, res.body).toBe(201)
    expect(userRow('walk-in')).toEqual({ role: 'user', role_label: '' })
    expect(lastDetail('auth.register')).not.toHaveProperty('roleLabel')
  })
})

describe('GET /api/admin/users/role-labels：用户标签 ∪ 邀请码标签（04 §4.2）', () => {
  it('只出现在邀请码上的标签 count=0；排序按人数倒序、同数按标签名', async () => {
    const createUser = async (username: string, roleLabel: string) => {
      const res = await postJson(app, '/api/admin/users', { username, roleLabel }, { headers: admin.headers })
      expect(res.statusCode, res.body).toBe(201)
    }
    await createUser('mom', '家人')
    await createUser('dad', '家人')
    await createUser('pal', '同事')

    // 邀请码：一个与用户重叠（count 仍是人数）、两个只在码上（count = 0，按标签名升序）
    await createInvite({ roleLabel: '家人' })
    await createInvite({ roleLabel: '只发过码' })
    await createInvite({ roleLabel: '还没人' })

    const labels = json<{ items: { label: string; count: number }[] }>(
      await getJson(app, '/api/admin/users/role-labels', { headers: admin.headers }),
    )
    expect(labels.items).toEqual([
      { label: '家人', count: 2 },
      { label: '同事', count: 1 },
      { label: '只发过码', count: 0 },
      { label: '还没人', count: 0 },
    ])
  })
})
