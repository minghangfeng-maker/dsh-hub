import { afterEach, describe, expect, it } from 'vitest'
import type { MobileBootstrapResponse, MobileWakeResponse } from '@dsh-hub/shared'
import { imageForVersion, FALLBACK_DSH_VERSION } from '../src/modules/instances/spec.js'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { mobileBootstrap, mobileSession, MOBILE_APP_ORIGIN } from './helpers-mobile.js'
import { nextIp } from './wp1-helpers.js'

/** bootstrap 与 wake（WP40a / v2 §4.2）。 */

const IMAGE = imageForVersion(FALLBACK_DSH_VERSION)
const META = { ip: '127.0.0.1', userAgent: 'vitest' }

const contexts: TestApp[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close()
})

interface Setup {
  ctx: TestApp
  alice: TestUser
  headers: Record<string, string>
}

async function setup(): Promise<Setup> {
  const ctx = await createTestApp()
  contexts.push(ctx)
  ctx.driver!.addImage(IMAGE)
  const alice = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
  const { headers } = await mobileSession(ctx.app, alice)
  return { ctx, alice, headers }
}

describe('GET /api/mobile/bootstrap', () => {
  it('字段齐全：user / points / backends / instance / app / serverTime', async () => {
    const { ctx, alice, headers } = await setup()
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({
      user: { id: alice.id, username: 'alice', displayName: 'alice' },
      points: { balance: 0, enabled: true },
      instance: { status: 'absent', capacityFull: false },
      app: { minVersionCode: 1, latestVersionCode: 1, downloadUrl: null },
    })
    expect(res.body.backends[0]).toMatchObject({
      id: 'cloud:self',
      kind: 'cloud',
      status: 'absent',
      connectable: false,
      reason: 'instance-not-running',
    })
    expect(res.body.serverTime).toBe(ctx.clock.nowIso())
    // 契约里没有的字段不许漏出来（尤其是 openUrl / home / cwd）
    expect(JSON.stringify(res.body)).not.toContain('openUrl')
  })

  it('积分：开积分时给余额（微积分 → 积分）；关掉后 enabled=false', async () => {
    const { ctx, alice, headers } = await setup()
    const relay = ctx.app.deps.services.relay
    relay.adjustWallet(alice.id, { amountMicro: 1_500_000, note: '测试' }, 1, META)
    const withPoints = await mobileBootstrap(ctx.app, headers)
    expect(withPoints.body.points).toEqual({ balance: 1.5, enabled: true })

    relay.updateSettings({ enabled: false }, 1, META)
    const off = await mobileBootstrap(ctx.app, headers)
    expect(off.body.points.enabled).toBe(false)
  })

  it('实例已开通并运行：status=running、connectable 由探测决定（FakeDriver 下探测失败但状态对）', async () => {
    const { ctx, alice, headers } = await setup()
    const instances = ctx.app.deps.services.instances
    await instances.provision(alice.id)
    await instances.ensureRunning(alice.id, { reason: 'user' })
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.body.instance.status).toBe('running')
    expect(res.body.backends[0]?.status).toBe('running')
  })

  it('实例从 stopped 变成 running 后，bootstrap 立刻反映（不吃 30 秒探测缓存）', async () => {
    const { ctx, alice, headers } = await setup()
    const instances = ctx.app.deps.services.instances
    await instances.provision(alice.id)
    const before = await mobileBootstrap(ctx.app, headers)
    expect(before.body.instance.status).toBe('stopped')
    expect(before.body.backends[0]?.status).toBe('stopped')

    await instances.ensureRunning(alice.id, { reason: 'user' })
    // 紧接着再取：instance 与 backends 都必须是 running（App 唤醒后每秒轮询的就是它）
    const after = await mobileBootstrap(ctx.app, headers)
    expect(after.body.instance.status).toBe('running')
    expect(after.body.backends[0]?.status).toBe('running')
  })

  it('capacityFull：running 数达到 maxRunning 时为 true', async () => {
    const { ctx, alice, headers } = await setup()
    const instances = ctx.app.deps.services.instances
    ctx.app.deps.settings.set('capacity', {
      ...ctx.app.deps.settings.get('capacity'),
      maxRunning: 1,
    })
    const other = await createUser(ctx.app, { username: 'bob', password: 'Bob-pass-1' })
    await instances.provision(other.id)
    await instances.ensureRunning(other.id, { reason: 'user' })
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.body.instance.capacityFull).toBe(true)
    expect(res.body.instance.status).toBe('absent') // alice 自己还没开通
    void alice
  })

  it('App 版本地板来自管理端设置（settings.mobile.app）', async () => {
    const { ctx, headers } = await setup()
    const admin = await createUser(ctx.app, { username: 'root', password: 'Root-pass-1', role: 'admin' })
    const adminSession = loginAs(ctx.app, admin)
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: adminSession.headers,
      payload: JSON.stringify({
        mobile: {
          app: { minVersionCode: 7, latestVersionCode: 9, downloadUrl: 'https://hub.example.com:8123/app/dsh-hub.apk' },
        },
      }),
    })
    expect(patch.statusCode, patch.body).toBe(200)
    const res = await mobileBootstrap(ctx.app, headers)
    // WP52：`downloadMirrors` 是新增的可选字段（没有发布记录时 []；管理端显式配 downloadUrl 也照发）
    expect(res.body.app).toEqual({
      minVersionCode: 7,
      latestVersionCode: 9,
      downloadUrl: 'https://hub.example.com:8123/app/dsh-hub.apk',
      downloadMirrors: [],
    })
    // 非法值被拒（下载地址必须是 URL）
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: adminSession.headers,
      payload: JSON.stringify({ mobile: { app: { minVersionCode: 2, latestVersionCode: 2, downloadUrl: 'nope' } } }),
    })
    expect(bad.statusCode).toBe(400)
  })

  it('没有令牌 → 401；cookie 会话也能用（过渡期）', async () => {
    const { ctx, alice } = await setup()
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/mobile/bootstrap' })
    expect(anonymous.statusCode).toBe(401)
    const viaCookie = await ctx.app.inject({
      method: 'GET',
      url: '/api/mobile/bootstrap',
      headers: loginAs(ctx.app, alice).headers,
    })
    expect(viaCookie.statusCode).toBe(200)
    expect(json<MobileBootstrapResponse>(viaCookie).user.username).toBe('alice')
  })
})

describe('POST /api/mobile/instance/wake', () => {
  it('没有云实例 → 自动开通（上线决定 ①）→ 202 + running', async () => {
    const { ctx, alice, headers } = await setup()
    const instances = ctx.app.deps.services.instances
    expect(await instances.getSummary(alice.id)).toMatchObject({ status: 'absent' })
    const res = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
    expect(res.statusCode, res.body).toBe(202)
    expect(json<MobileWakeResponse>(res).status).toBe('running')
    // 实例行/目录已按自助注册同一条 provision 路径建好，并已被 ensureRunning 拉起
    expect(await instances.getSummary(alice.id)).toMatchObject({ status: 'running' })
    // 审计里能看到「首次唤醒自动开通」，便于运营核对（不含任何敏感信息）
    const audits = ctx.app.deps.db.all<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'mobile.instance.provision' AND actor_id = ?",
      alice.id,
    )
    expect(audits.length).toBeGreaterThan(0)
    // 再唤醒一次：幂等，不会重复 provision 成 error/absent
    const again = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
    expect(again.statusCode).toBe(202)
    expect(json<MobileWakeResponse>(again).status).toBe('running')
    expect(await instances.getSummary(alice.id)).toMatchObject({ status: 'running' })
  })

  it('自动开通失败 → 500 INSTANCE_PROVISION_FAILED（明确错误码，不是 absent/starting）', async () => {
    const { ctx, alice, headers } = await setup()
    const instances = ctx.app.deps.services.instances as unknown as {
      provision: (userId: number) => Promise<unknown>
    }
    const original = instances.provision
    instances.provision = async () => {
      throw new Error('模拟磁盘错误')
    }
    try {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
      expect(res.statusCode, res.body).toBe(500)
      expect(json<{ error: { code: string } }>(res).error.code).toBe('INSTANCE_PROVISION_FAILED')
    } finally {
      instances.provision = original
    }
    expect(await ctx.app.deps.services.instances.getSummary(alice.id)).toMatchObject({ status: 'absent' })
  })

  it('自动开通拒绝非 active 账号（防御性；正常请求走不到这里）', async () => {
    const { ctx, alice } = await setup()
    // 直接用服务层调：鉴权层会先拦 pending/disabled，HTTP 路径测不到这道防御
    const user = {
      id: alice.id,
      slug: 'alice',
      username: 'alice',
      displayName: 'alice',
      avatarFile: null,
      role: 'user' as const,
      status: 'pending' as const,
      mustChangePassword: false,
      sessionId: 'test',
      createdAt: ctx.clock.nowIso(),
      expiresAt: ctx.clock.nowIso(),
      lastSeenAt: ctx.clock.nowIso(),
      reauthAt: null,
    }
    await expect(ctx.app.deps.services.mobile.wake(user)).rejects.toMatchObject({ code: 'USER_PENDING' })
    await expect(
      ctx.app.deps.services.mobile.wake({ ...user, status: 'disabled' }),
    ).rejects.toMatchObject({ code: 'USER_DISABLED' })
    expect(await ctx.app.deps.services.instances.getSummary(alice.id)).toMatchObject({ status: 'absent' })
  })

  it('已开通：202 + status（FakeDriver 立刻 ready）', async () => {
    const { ctx, alice, headers } = await setup()
    await ctx.app.deps.services.instances.provision(alice.id)
    const res = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
    expect(res.statusCode, res.body).toBe(202)
    expect(json<MobileWakeResponse>(res).status).toBe('running')
    // 幂等：再唤醒一次还是 202 + running
    const again = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
    expect(again.statusCode).toBe(202)
    expect(json<MobileWakeResponse>(again).status).toBe('running')
  })

  it('维护模式 maxRunning=0 → 409 CAPACITY_FULL（只停不起）', async () => {
    const { ctx, alice, headers } = await setup()
    await ctx.app.deps.services.instances.provision(alice.id)
    ctx.app.deps.settings.set('capacity', { ...ctx.app.deps.settings.get('capacity'), maxRunning: 0 })
    const res = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
    expect(res.statusCode, res.body).toBe(409)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('CAPACITY_FULL')
    // bootstrap 也要能把「容量满」报给 App（首屏提示「当前使用人数较多」）
    const boot = await ctx.app.inject({ method: 'GET', url: '/api/mobile/bootstrap', headers })
    expect(json<MobileBootstrapResponse>(boot).instance.capacityFull).toBe(true)
  })

  it('容量满 → 409 CAPACITY_FULL（契约状态码，与网页端的 503 不同）', async () => {
    const { ctx, alice, headers } = await setup()
    const instances = ctx.app.deps.services.instances
    ctx.app.deps.settings.set('capacity', { ...ctx.app.deps.settings.get('capacity'), maxRunning: 1 })
    const other = await createUser(ctx.app, { username: 'bob', password: 'Bob-pass-1' })
    await instances.provision(other.id)
    await instances.ensureRunning(other.id, { reason: 'user' })
    await instances.provision(alice.id)

    const res = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
    expect(res.statusCode, res.body).toBe(409)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('CAPACITY_FULL')

    // 同一个错误码在网页端仍是 503（没有改全局映射表）
    const web = await ctx.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: loginAs(ctx.app, alice).headers,
    })
    expect(web.statusCode).toBe(503)
  })

  it('积分不足 → 402 INSUFFICIENT_POINTS（开计费时）', async () => {
    const { ctx, alice, headers } = await setup()
    const compute = ctx.app.deps.services.compute
    await compute.updateSettings({ billingEnabled: true }, 1, META)
    await ctx.app.deps.services.instances.provision(alice.id)
    const res = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake', headers })
    expect(res.statusCode, res.body).toBe(402)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('INSUFFICIENT_POINTS')
  })

  it('没有令牌 → 401；站外 Origin 带 cookie → 403', async () => {
    const { ctx, alice } = await setup()
    const anonymous = await ctx.app.inject({ method: 'POST', url: '/api/mobile/instance/wake' })
    expect(anonymous.statusCode).toBe(401)
    const cookie = loginAs(ctx.app, alice)
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/instance/wake',
      headers: { cookie: cookie.cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
    })
    expect(blocked.statusCode).toBe(403)
    // 而 App 来源 + cookie 可以（过渡期）
    const allowed = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/instance/wake',
      headers: { cookie: cookie.cookie, origin: MOBILE_APP_ORIGIN, 'content-type': 'application/json' },
    })
    // 没开通实例 → 首次唤醒自动开通（上线决定 ①），不再回 INSTANCE_ABSENT
    expect(allowed.statusCode, allowed.body).toBe(202)
    void nextIp()
  })
})
