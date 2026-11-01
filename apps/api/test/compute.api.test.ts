import { afterEach, describe, expect, it } from 'vitest'
import type { AdminInstanceRow, ComputeLeaseRow, MyComputeResponse } from '@dsh-hub/shared'
import type { ComputeSetup } from './helpers-compute.js'
import { activeLeaseOf, setupCompute, walletOf } from './helpers-compute.js'
import { createUser, json, loginAs, type TestApp } from './helpers.js'

/** 算力租赁接口（13 §6）：用户端、管理端、启动请求体、402/400、每日赠送触发。 */

const META = { ip: '127.0.0.1', userAgent: 'vitest' }
const setups: ComputeSetup[] = []

afterEach(async () => {
  for (const setup of setups.splice(0)) await setup.ctx.close()
})

async function setup(opts: Parameters<typeof setupCompute>[0] = {}): Promise<ComputeSetup> {
  const result = await setupCompute(opts)
  setups.push(result)
  return result
}

function sessionOf(ctx: TestApp, user: { id: number; username: string; role: string }) {
  return loginAs(ctx.app, user as Parameters<typeof loginAs>[1])
}

describe('用户端 /api/me/compute（13 §6）', () => {
  it('GET 返回钱包、规格、已选规格与赠送；会触发每日赠送', async () => {
    const s = await setup()
    s.relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)
    const session = sessionOf(s.ctx, s.user)
    expect(walletOf(s)).toBeUndefined()

    const res = await s.app.inject({ method: 'GET', url: '/api/me/compute', headers: session.headers })
    expect(res.statusCode).toBe(200)
    const body = json<MyComputeResponse>(res)
    expect(body).toMatchObject({
      billingEnabled: false,
      exempt: false,
      selectedPlanId: 'c2m4',
      lease: null,
      balanceMicro: 600_000,
      dailyBonusLeftMicro: 600_000,
      dailyBonusMicro: 600_000,
      blockMinutes: 10,
      graceMinutes: 10,
      contactText: '需要更高配置？请联系管理员定制。',
    })
    expect(body.plans.map((plan) => plan.id)).toEqual(['c2m4', 'c4m8', 'c8m16'])
    expect(body.plans[0]).toMatchObject({ blockPriceMicro: 50_000, custom: false })
    expect(walletOf(s)).toMatchObject({ balance: 600_000, daily_bonus_left: 600_000 })
  })

  it('POST /api/me/instance/start：无请求体 / 带 planId / 不可选 planId；402 details', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    const session = sessionOf(s.ctx, s.user)

    const noBody = await s.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: session.headers,
    })
    expect(noBody.statusCode).toBe(202)
    expect(activeLeaseOf(s)?.plan_id).toBe('c2m4')

    await s.app.inject({ method: 'POST', url: '/api/me/instance/stop', headers: session.headers })
    const withPlan = await s.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: session.headers,
      payload: { planId: 'c4m8' },
    })
    expect(withPlan.statusCode).toBe(202)
    expect(activeLeaseOf(s)?.plan_id).toBe('c4m8')

    await s.app.inject({ method: 'POST', url: '/api/me/instance/stop', headers: session.headers })
    const invalid = await s.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: session.headers,
      payload: { planId: 'nope' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(json<{ error: { code: string; details: { fields: { planId: string } } } }>(invalid)).toMatchObject(
      { error: { code: 'VALIDATION_FAILED', details: { fields: { planId: '该规格不可选' } } } },
    )

    // 另一个没有积分的用户 → 402
    const poor = await createUser(s.app, { username: 'poor' })
    const poorSession = sessionOf(s.ctx, poor)
    const insufficient = await s.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: poorSession.headers,
    })
    expect(insufficient.statusCode).toBe(402)
    expect(json<{ error: { code: string; details: Record<string, number> } }>(insufficient)).toMatchObject({
      error: { code: 'INSUFFICIENT_POINTS', details: { balanceMicro: 0, blockPriceMicro: 50_000 } },
    })
  })

  it('已在运行时带 planId：不可选仍 400；可选则记住（幂等返回 200）', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    const session = sessionOf(s.ctx, s.user)
    await s.app.inject({ method: 'POST', url: '/api/me/instance/start', headers: session.headers })

    const invalid = await s.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: session.headers,
      payload: { planId: 'nope' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(activeLeaseOf(s)?.plan_id).toBe('c2m4')

    const remembered = await s.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: session.headers,
      payload: { planId: 'c4m8' },
    })
    expect(remembered.statusCode).toBe(200)
    expect(s.compute.myCompute(s.user.id).selectedPlanId).toBe('c4m8')
    // 已在运行：不重建、不新开租约
    expect(activeLeaseOf(s)?.plan_id).toBe('c2m4')
  })

  it('PUT /api/me/compute/plan：运行中换规格 restarted=true；同规格 false；停止中只记住', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    const session = sessionOf(s.ctx, s.user)
    await s.app.inject({ method: 'POST', url: '/api/me/instance/start', headers: session.headers })

    const changed = await s.app.inject({
      method: 'PUT',
      url: '/api/me/compute/plan',
      headers: session.headers,
      payload: { planId: 'c4m8' },
    })
    expect(changed.statusCode).toBe(200)
    const changedBody = json<{ compute: MyComputeResponse; restarted: boolean }>(changed)
    expect(changedBody.restarted).toBe(true)
    expect(changedBody.compute.lease).toMatchObject({ planId: 'c4m8', blocks: 1 })

    const same = await s.app.inject({
      method: 'PUT',
      url: '/api/me/compute/plan',
      headers: session.headers,
      payload: { planId: 'c4m8' },
    })
    expect(json<{ restarted: boolean }>(same).restarted).toBe(false)

    await s.app.inject({ method: 'POST', url: '/api/me/instance/stop', headers: session.headers })
    const stopped = await s.app.inject({
      method: 'PUT',
      url: '/api/me/compute/plan',
      headers: session.headers,
      payload: { planId: 'c2m4' },
    })
    expect(json<{ restarted: boolean; compute: MyComputeResponse }>(stopped)).toMatchObject({
      restarted: false,
      compute: { selectedPlanId: 'c2m4', lease: null },
    })
  })

  it('GET /api/me/compute/leases：分页、只看自己（忽略 userId 参数）', async () => {
    const s = await setup({ settings: {}, grantMicro: 1_000_000 })
    const session = sessionOf(s.ctx, s.user)
    await s.app.inject({ method: 'POST', url: '/api/me/instance/start', headers: session.headers })
    await s.app.inject({ method: 'POST', url: '/api/me/instance/stop', headers: session.headers })
    const other = await createUser(s.app, { username: 'other' })
    expect(other.id).not.toBe(s.user.id)

    const res = await s.app.inject({
      method: 'GET',
      url: `/api/me/compute/leases?page=1&pageSize=1&userId=${String(other.id)}`,
      headers: session.headers,
    })
    expect(res.statusCode).toBe(200)
    const body = json<{ items: ComputeLeaseRow[]; total: number; page: number; pageSize: number }>(res)
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 1 })
    expect(body.items[0]).toMatchObject({ userId: s.user.id, endReason: 'user' })
    expect(body.items[0]?.username).toBe(s.user.username)
  })

  it('GET /api/auth/me 也会触发每日赠送（打开 Hub 任何页面）', async () => {
    const s = await setup()
    s.relay.updateSettings({ dailyBonusMicro: 600_000 }, 1, META)
    const session = sessionOf(s.ctx, s.user)
    const res = await s.app.inject({ method: 'GET', url: '/api/auth/me', headers: session.headers })
    expect(res.statusCode).toBe(200)
    expect(walletOf(s)).toMatchObject({ balance: 600_000, daily_bonus_left: 600_000 })
    // 第二次不再发
    await s.app.inject({ method: 'GET', url: '/api/auth/me', headers: session.headers })
    expect(walletOf(s)?.balance).toBe(600_000)
  })
})

describe('管理端 /api/admin/compute（13 §6）', () => {
  async function adminSetup(opts: Parameters<typeof setupCompute>[0] = {}): Promise<{
    s: ComputeSetup
    adminSession: ReturnType<typeof loginAs>
  }> {
    const s = await setup({ ...opts, user: { role: 'admin', username: 'boss' } })
    return { s, adminSession: loginAs(s.app, s.user) }
  }

  it('GET/PATCH 设置：只改给出的字段、plans 整体替换、host 内存、审计', async () => {
    const { s, adminSession } = await adminSetup()
    const before = await s.app.inject({
      method: 'GET',
      url: '/api/admin/compute/settings',
      headers: adminSession.headers,
    })
    expect(before.statusCode).toBe(200)
    const beforeBody = json<{
      settings: { billingEnabled: boolean; graceMinutes: number }
      host: { memTotalMb: number; committedMemoryMb: number }
    }>(before)
    expect(beforeBody.settings).toMatchObject({ billingEnabled: false, graceMinutes: 10 })
    expect(beforeBody.host.memTotalMb).toBeGreaterThanOrEqual(0)
    expect(beforeBody.host.committedMemoryMb).toBe(0)

    const plans = [
      {
        id: 'small',
        name: '小规格',
        cpus: 1,
        memoryMb: 1024,
        pricePerHourMicro: 100_000,
        enabled: true,
        userIds: null,
        sort: 1,
      },
    ]
    const patched = await s.app.inject({
      method: 'PATCH',
      url: '/api/admin/compute/settings',
      headers: adminSession.headers,
      payload: { billingEnabled: true, plans },
    })
    expect(patched.statusCode).toBe(200)
    const body = json<{
      settings: { billingEnabled: boolean; graceMinutes: number; plans: { id: string }[] }
    }>(patched)
    expect(body.settings).toMatchObject({ billingEnabled: true, graceMinutes: 10 })
    expect(body.settings.plans.map((plan) => plan.id)).toEqual(['small'])
    expect(s.app.deps.audit.recent(10).some((item) => item.action === 'compute.settings.update')).toBe(true)
  })

  it('GET 租约列表：userId/active 过滤、带用户名；实例列表带 lease', async () => {
    const { s, adminSession } = await adminSetup({ settings: {}, grantMicro: 1_000_000 })
    const user = await createUser(s.app, { username: 'worker' })
    s.relay.adjustWallet(user.id, { amountMicro: 1_000_000, note: '测试' }, 1, META)
    await s.instances.provision(user.id)
    await s.instances.ensureRunning(user.id)

    const active = await s.app.inject({
      method: 'GET',
      url: `/api/admin/compute/leases?userId=${String(user.id)}&active=true`,
      headers: adminSession.headers,
    })
    expect(active.statusCode).toBe(200)
    const activeBody = json<{ items: ComputeLeaseRow[]; total: number }>(active)
    expect(activeBody.total).toBe(1)
    expect(activeBody.items[0]).toMatchObject({ userId: user.id, username: user.username, billed: true })

    const instances = await s.app.inject({
      method: 'GET',
      url: '/api/admin/instances',
      headers: adminSession.headers,
    })
    expect(instances.statusCode).toBe(200)
    const rows = json<AdminInstanceRow[]>(instances)
    const row = rows.find((item) => item.user.id === user.id)
    expect(row?.lease).toMatchObject({ planId: 'c2m4', billed: true })

    // host.committedMemoryMb = 运行中实例的内存（有租约用租约）
    const settings = await s.app.inject({
      method: 'GET',
      url: '/api/admin/compute/settings',
      headers: adminSession.headers,
    })
    expect(settings.statusCode).toBe(200)
    expect(json<{ host: { committedMemoryMb: number } }>(settings).host.committedMemoryMb).toBe(4096)

    // 普通用户访问管理端 → 403
    const normalSession = loginAs(s.app, user)
    const denied = await s.app.inject({
      method: 'GET',
      url: '/api/admin/compute/settings',
      headers: normalSession.headers,
    })
    expect(denied.statusCode).toBe(403)
  })

  it('PATCH defaultPlanId：null 可以、格式非法 400、合法但不存在的 ID 接受；审计只在变化时带 from/to', async () => {
    const { s, adminSession } = await adminSetup()
    const initial = json<{ settings: { defaultPlanId: string | null } }>(
      await s.app.inject({
        method: 'GET',
        url: '/api/admin/compute/settings',
        headers: adminSession.headers,
      }),
    )
    expect(initial.settings.defaultPlanId).toBe('c2m4')

    const invalid = await s.app.inject({
      method: 'PATCH',
      url: '/api/admin/compute/settings',
      headers: adminSession.headers,
      payload: { defaultPlanId: 'Bad ID' },
    })
    expect(invalid.statusCode).toBe(400)

    // 不做存在性强校验：合法格式但当前 plans 里没有的 ID 也能保存（15 §3.1 / 契约注释）
    const ghost = await s.app.inject({
      method: 'PATCH',
      url: '/api/admin/compute/settings',
      headers: adminSession.headers,
      payload: { defaultPlanId: 'ghost' },
    })
    expect(ghost.statusCode).toBe(200)
    expect(json<{ settings: { defaultPlanId: string | null } }>(ghost).settings.defaultPlanId).toBe('ghost')
    const changedAudit = s.app.deps.audit.recent(5).find((item) => item.action === 'compute.settings.update')
    expect(changedAudit?.detail).toMatchObject({
      fields: ['defaultPlanId'],
      defaultPlanId: { from: 'c2m4', to: 'ghost' },
    })

    // 值没变 → 审计 detail 不带 defaultPlanId（避免重复提交也记一次「变更」）
    const same = await s.app.inject({
      method: 'PATCH',
      url: '/api/admin/compute/settings',
      headers: adminSession.headers,
      payload: { defaultPlanId: 'ghost' },
    })
    expect(same.statusCode).toBe(200)
    const sameAudit = s.app.deps.audit.recent(5)[0]
    expect(sameAudit?.detail).not.toHaveProperty('defaultPlanId')

    const nulled = await s.app.inject({
      method: 'PATCH',
      url: '/api/admin/compute/settings',
      headers: adminSession.headers,
      payload: { defaultPlanId: null },
    })
    expect(nulled.statusCode).toBe(200)
    expect(json<{ settings: { defaultPlanId: string | null } }>(nulled).settings.defaultPlanId).toBeNull()
    expect(s.app.deps.audit.recent(5)[0]?.detail).toMatchObject({
      defaultPlanId: { from: 'ghost', to: null },
    })
  })
})
