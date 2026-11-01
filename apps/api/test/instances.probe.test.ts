import { request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_QUOTA_VALUE, type Quota } from '@dsh-hub/shared'
import {
  CPU_SAMPLE_SIZE,
  type InternalInstanceService,
} from '../src/modules/instances/service.js'
import { probeSessions } from '../src/modules/instances/probe.js'
import { FALLBACK_DSH_VERSION, containerNameFor, imageForVersion } from '../src/modules/instances/spec.js'
import {
  createTestApp,
  createUser,
  loginAs,
  type TestApp,
  type TestSession,
  type TestUser,
} from './helpers.js'

/**
 * WP33 会话探针与休眠规则（docs/22 §6）。
 *
 * 关键前提：假驱动**默认不提供** `session/list`（404）→ 探针失败 → 服务端按「未知」走旧的
 * CPU 规则，所以既有测试语义不变；本文件里的用例显式 `driver.setSessions(...)` 打开它。
 */
const IMAGE = imageForVersion(FALLBACK_DSH_VERSION)
const LONG = 24 * 60 * 60_000

interface ProbeSetup {
  ctx: TestApp
  user: TestUser
  admin: TestUser
  adminSession: TestSession
  instances: InternalInstanceService
  driver: NonNullable<TestApp['driver']>
  name: string
}

const contexts: TestApp[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.close()
})

async function setup(quota: Partial<Quota> = {}): Promise<ProbeSetup> {
  const ctx = await createTestApp()
  contexts.push(ctx)
  const driver = ctx.driver!
  driver.addImage(IMAGE)
  const user = await createUser(ctx.app, {
    quotaJson: JSON.stringify({ ...DEFAULT_QUOTA_VALUE, ...quota }),
  })
  const admin = await createUser(ctx.app, { role: 'admin' })
  const instances = ctx.app.deps.services.instances as InternalInstanceService
  await instances.provision(user.id)
  await instances.ensureRunning(user.id)
  return {
    ctx,
    user,
    admin,
    adminSession: loginAs(ctx.app, admin),
    instances,
    driver,
    name: containerNameFor(user.slug),
  }
}

function lastActiveAt(ctx: TestApp, userId: number): string | null {
  const row = ctx.app.deps.db.get<{ last_active_at: string | null }>(
    'SELECT last_active_at FROM instances WHERE user_id = ?',
    userId,
  )
  return row?.last_active_at ?? null
}

function probeRow(ctx: TestApp, userId: number) {
  return ctx.app.deps.db.get<{
    probe_state: string | null
    probe_at: string | null
    running_sessions: number | null
    last_busy_at: string | null
    last_prompt_at: string | null
    last_client_at: string | null
  }>(
    `SELECT probe_state, probe_at, running_sessions, last_busy_at, last_prompt_at, last_client_at
       FROM instances WHERE user_id = ?`,
    userId,
  )
}

/** 通过代理开一条真实的 WebSocket（`openClients` 只有走真实升级路径才会 +1） */
function openProbeSocket(port: number, username: string, session: TestSession): Promise<Socket> {
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/dsh/${username}/api/remote.mux`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        cookie: `hub_sid=${session.token}`,
      },
    })
    req.on('upgrade', (_res, socket: Socket) => resolve(socket))
    req.on('response', (res) => reject(new Error(`WS 未被升级（HTTP ${String(res.statusCode)}）`)))
    req.on('error', reject)
    req.end()
  })
}

describe('会话探针的请求与只读性（docs/22 §6.1）', () => {
  it('POST /api/session/list + client-request 信封；不更新 lastActiveAt；探针结果落库', async () => {
    const { ctx, user, instances, driver } = await setup()
    const promptAt = ctx.clock.now().getTime()
    driver.setSessions({ sessions: [{ running: true, updatedAt: promptAt }] })
    const activeBefore = lastActiveAt(ctx, user.id)

    const result = await instances.probeRunningInstances()
    expect(result).toEqual([{ userId: user.id, state: 'busy' }])

    // 只读：lastActiveAt 一点没变（探针绝不 touchActivity）
    expect(lastActiveAt(ctx, user.id)).toBe(activeBefore)

    // 请求格式：与上游客户端同形（rpc-host.ts:302-334、rpc-schema.ts:38-43）
    const body = driver.lastSessionProbeBody()
    expect(body).toBeTruthy()
    expect(JSON.parse(body!)).toMatchObject({
      type: 'client-request',
      method: 'session/list',
      payload: { args: { _request: {} } },
    })
    const requests = driver.getRequests(containerNameFor(user.slug))
    expect(requests.some((item) => item.method === 'POST' && item.url === '/api/session/list')).toBe(true)

    // 迁移 102 的列
    const row = probeRow(ctx, user.id)
    expect(row?.probe_state).toBe('busy')
    expect(row?.probe_at).toBe(ctx.clock.nowIso())
    expect(row?.running_sessions).toBe(1)
    expect(row?.last_busy_at).toBe(ctx.clock.nowIso())
    expect(row?.last_prompt_at).toBe(new Date(promptAt).toISOString())
  })

  it('没有 running → unattended；有人在看 → watching（真实 WS 升级计数）', async () => {
    const { ctx, user, instances, driver } = await setup()
    driver.setSessions({ sessions: [{ running: false, updatedAt: ctx.clock.now().getTime() }] })

    const idle = await instances.probeRunningInstances()
    expect(idle).toEqual([{ userId: user.id, state: 'unattended' }])

    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    const socket = await openProbeSocket(port, user.username, loginAs(ctx.app, user))
    try {
      const watching = await instances.probeRunningInstances()
      expect(watching).toEqual([{ userId: user.id, state: 'watching' }])
      const proxy = ctx.app.deps.services.proxy
      expect(proxy.openClients(user.id)).toBe(1)
    } finally {
      socket.destroy()
    }
    // 断开后计数归零、记下最后断开时刻（休眠规则要用）
    const proxy = ctx.app.deps.services.proxy
    for (let attempt = 0; attempt < 40 && proxy.openClients(user.id) !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(proxy.openClients(user.id)).toBe(0)
    expect(typeof proxy.lastClientAt(user.id)).toBe('number')
  })

  it('停止的实例不被探测（绝不唤醒）', async () => {
    const { ctx, user, instances, driver } = await setup()
    driver.setSessions({ sessions: [{ running: true, updatedAt: ctx.clock.now().getTime() }] })
    await instances.stop(user.id, { reason: 'admin' })
    const before = driver.sessionProbeHits

    expect(await instances.probeRunningInstances()).toEqual([])
    expect(driver.sessionProbeHits).toBe(before)
    expect(probeRow(ctx, user.id)?.probe_state).toBeNull()
  })

  it('探针失败 / 旧版 DSH（没有布尔 running）→ unknown，不进 busy', async () => {
    const { ctx, user, instances, driver } = await setup()
    expect(await instances.probeRunningInstances()).toEqual([{ userId: user.id, state: 'unknown' }])
    expect(probeRow(ctx, user.id)?.probe_state).toBe('unknown')

    driver.setSessions({
      sessions: [{ running: undefined as unknown as boolean, updatedAt: ctx.clock.now().getTime() }],
    })
    expect(await instances.probeRunningInstances()).toEqual([{ userId: user.id, state: 'unknown' }])
  })

  it('单次探针超时按失败处理（3 s 是常量，单测用短超时直接测 probeSessions）', async () => {
    const { user, instances, driver } = await setup()
    driver.setSessions({ sessions: [], delayMs: 300 })
    const base = new URL(driver.getBaseUrl(containerNameFor(user.slug))!)
    const result = await probeSessions(
      { host: base.hostname, port: Number(base.port) },
      '127.0.0.1:3000',
      instances.cookieMinter(user.id, user.slug),
      50,
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('超时')
  })
})

describe('休眠规则（docs/22 §6.2）', () => {
  it('busy 不停；连续超过 busyMaxMinutes 后才按空闲规则停，审计 detail 有状态与时间点', async () => {
    const { ctx, user, instances, driver } = await setup({
      idleStopMinutes: 1,
      idleNoClientMinutes: 1,
    })
    ctx.app.deps.settings.set('capacity', { maxRunning: 12, maxConcurrentExports: 2, busyMaxMinutes: 3 })
    // 进行中的会话，最后一次用户消息在很久以前（agent 在跑长回合）
    const promptAt = ctx.clock.now().getTime() - 60 * 60_000
    driver.setSessions({ sessions: [{ running: true, updatedAt: promptAt }] })

    for (let round = 0; round < 3; round += 1) {
      expect(await instances.reapIdle()).toBe(0)
      ctx.clock.advance(60_000)
    }
    expect(instances.currentStatus(user.id)).toBe('running')
    // 第 4 轮：连续 busy ≥ 3 分钟 → 按空闲规则（无人，1 分钟）停
    expect(await instances.reapIdle()).toBe(1)
    expect(instances.currentStatus(user.id)).toBe('stopped')
    const audit = ctx.app.deps.audit.recent(10).find((item) => item.action === 'instance.stop')
    expect(audit?.detail).toMatchObject({
      reason: 'idle',
      probeState: 'busy',
      rule: 'unattended',
      busyMinutes: expect.any(Number) as number,
      startedAt: expect.any(String) as string,
      lastPromptAt: new Date(promptAt).toISOString(),
      probeAt: expect.any(String) as string,
    })
  })

  it('watching 到 idleStopMinutes 才停（有人在看时按 120 分钟，而不是 30）', async () => {
    const { ctx, user, instances, driver } = await setup({
      idleStopMinutes: 120,
      idleNoClientMinutes: 30,
    })
    driver.setSessions({ sessions: [{ running: false, updatedAt: ctx.clock.now().getTime() - 10 * 60_000 }] })
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    const socket = await openProbeSocket(port, user.username, loginAs(ctx.app, user))
    try {
      // 空闲起点是 startedAt（比最后提问更晚），走过 100 分钟 < 120：不停
      ctx.clock.advance(100 * 60_000)
      expect(await instances.reapIdle()).toBe(0)
      expect(instances.currentStatus(user.id)).toBe('running')
      // 再过 25 分钟（125 ≥ 120）→ 停
      ctx.clock.advance(25 * 60_000)
      expect(await instances.reapIdle()).toBe(1)
      expect(instances.currentStatus(user.id)).toBe('stopped')
      const audit = ctx.app.deps.audit.recent(10).find((item) => item.action === 'instance.stop')
      expect(audit?.detail).toMatchObject({
        reason: 'idle',
        probeState: 'watching',
        rule: 'watching',
        openClients: 1,
        thresholdMinutes: 120,
        idleMinutes: expect.any(Number) as number,
        probeAt: expect.any(String) as string,
      })
    } finally {
      socket.destroy()
    }
  })

  it('unattended 到 idleNoClientMinutes 就停（没人看时 30 分钟即可）', async () => {
    const { ctx, user, instances, driver } = await setup({
      idleStopMinutes: 120,
      idleNoClientMinutes: 30,
    })
    driver.setSessions({ sessions: [{ running: false, updatedAt: ctx.clock.now().getTime() - 5 * 60_000 }] })

    ctx.clock.advance(20 * 60_000) // 空闲 25 分钟 < 30
    expect(await instances.reapIdle()).toBe(0)
    ctx.clock.advance(10 * 60_000) // 空闲 35 分钟 ≥ 30
    expect(await instances.reapIdle()).toBe(1)
    expect(instances.currentStatus(user.id)).toBe('stopped')
    const audit = ctx.app.deps.audit.recent(10).find((item) => item.action === 'instance.stop')
    expect(audit?.detail).toMatchObject({
      probeState: 'unattended',
      rule: 'unattended',
      thresholdMinutes: 30,
    })
  })

  it('idleNoClientMinutes=0 沿用 idleStopMinutes', async () => {
    const { ctx, instances, driver } = await setup({
      idleStopMinutes: 5,
      idleNoClientMinutes: 0,
    })
    driver.setSessions({ sessions: [] })

    ctx.clock.advance(4 * 60_000)
    expect(await instances.reapIdle()).toBe(0)
    ctx.clock.advance(2 * 60_000)
    expect(await instances.reapIdle()).toBe(1)
    const audit = ctx.app.deps.audit.recent(10).find((item) => item.action === 'instance.stop')
    expect(audit?.detail).toMatchObject({ thresholdMinutes: 5, rule: 'unattended' })
  })

  it('idleStopMinutes=0（不回收）时探针照常记录、但永不停', async () => {
    const { ctx, user, instances, driver } = await setup({ idleStopMinutes: 0 })
    driver.setSessions({ sessions: [{ running: false, updatedAt: ctx.clock.now().getTime() - 600 * 60_000 }] })
    ctx.clock.advance(LONG)
    expect(await instances.reapIdle()).toBe(0)
    expect(instances.currentStatus(user.id)).toBe('running')
    expect(probeRow(ctx, user.id)?.probe_state).toBe('unattended')
  })

  it('边界时间点：unattended 正好到 idleNoClientMinutes 就停，差 1 秒不停', async () => {
    const { ctx, instances, driver } = await setup({ idleStopMinutes: 120, idleNoClientMinutes: 30 })
    driver.setSessions({ sessions: [] })
    // 差 1 ms 到阈值：不停（规则是 now - idleSince >= threshold）
    ctx.clock.advance(30 * 60_000 - 1)
    expect(await instances.reapIdle()).toBe(0)
    ctx.clock.advance(1)
    expect(await instances.reapIdle()).toBe(1)
  })

  it('边界时间点：watching 正好到 idleStopMinutes 就停', async () => {
    const { ctx, user, instances, driver } = await setup({ idleStopMinutes: 120, idleNoClientMinutes: 5 })
    driver.setSessions({ sessions: [{ running: false, updatedAt: ctx.clock.now().getTime() }] })
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    const socket = await openProbeSocket(port, user.username, loginAs(ctx.app, user))
    try {
      ctx.clock.advance(120 * 60_000 - 1)
      expect(await instances.reapIdle()).toBe(0)
      ctx.clock.advance(1)
      expect(await instances.reapIdle()).toBe(1)
      expect(instances.currentStatus(user.id)).toBe('stopped')
    } finally {
      socket.destroy()
    }
  })

  it('边界时间点：连续 busy 正好到 busyMaxMinutes 就转按空闲规则', async () => {
    const { ctx, instances, driver } = await setup({ idleStopMinutes: 120, idleNoClientMinutes: 1 })
    ctx.app.deps.settings.set('capacity', { maxRunning: 12, maxConcurrentExports: 2, busyMaxMinutes: 3 })
    driver.setSessions({
      sessions: [{ running: true, updatedAt: ctx.clock.now().getTime() - 600 * 60_000 }],
    })
    // 第 1 轮建立 busySince；之后每轮 +1 分钟
    expect(await instances.reapIdle()).toBe(0)
    ctx.clock.advance(60_000)
    expect(await instances.reapIdle()).toBe(0)
    ctx.clock.advance(60_000)
    // 连续 busy 正好 2 分钟 < 3：还在保护期
    expect(await instances.reapIdle()).toBe(0)
    ctx.clock.advance(60_000)
    // 连续 busy 正好 3 分钟 = 阈值：按空闲规则（无人 + 1 分钟）停
    expect(await instances.reapIdle()).toBe(1)
  })

  it('探针失败回落旧 CPU 规则（审计 detail 记 rule=cpu）', async () => {
    const { ctx, instances } = await setup({ idleStopMinutes: 1 })
    // 假驱动默认没有 session/list → unknown
    ctx.clock.advance(2 * 60_000)
    let stopped = 0
    for (let round = 0; round < CPU_SAMPLE_SIZE; round += 1) stopped += await instances.reapIdle()
    expect(stopped).toBe(1)
    const audit = ctx.app.deps.audit.recent(10).find((item) => item.action === 'instance.stop')
    expect(audit?.detail).toMatchObject({
      probeState: 'unknown',
      rule: 'cpu',
      cpuPercent: expect.any(Number) as number,
      lastActiveAt: null,
    })
  })
})

describe('列表提速与 stats 缓存（docs/22 §5）', () => {
  it('列表只做一次 listManaged、不逐行 inspect；stats 从缓存来', async () => {
    const { ctx, user, instances } = await setup()
    const driver = ctx.driver!
    let inspects = 0
    let stats = 0
    const rawInspect = driver.inspect.bind(driver)
    driver.inspect = async (name: string) => {
      inspects += 1
      return rawInspect(name)
    }
    const rawStats = driver.stats.bind(driver)
    driver.stats = async (name: string) => {
      stats += 1
      return rawStats(name)
    }

    const before = { inspects, stats }
    // 还没有样本：stats 为 null（前端骨架占位）
    const cold = await instances.listForAdmin()
    expect(cold[0]?.stats).toBeNull()
    expect(cold[0]?.statsAt).toBeNull()
    expect(inspects - before.inspects).toBe(0)
    expect(stats - before.stats).toBe(0)

    expect(await instances.refreshStatsCache()).toBe(1)
    const sampled = { inspects, stats }
    const warm = await instances.listForAdmin()
    expect(warm[0]?.user.id).toBe(user.id)
    expect(warm[0]?.stats?.cpuPercent).toBe(1.5)
    expect(warm[0]?.statsAt).toBe(ctx.clock.nowIso())
    // 列表不再触发 inspect / stats（缓存暖了以后一次都不调）
    expect(inspects - sampled.inspects).toBe(0)
    expect(stats - sampled.stats).toBe(0)
  })

  it('GET /api/admin/instances/stats 返回缓存快照；GET /api/admin/instances 带 statsAt 与 probe', async () => {
    const { ctx, instances, driver, adminSession } = await setup()
    driver.setSessions({ sessions: [{ running: false, updatedAt: ctx.clock.now().getTime() }] })
    await instances.reapIdle() // 探针一轮（不满足休眠条件）
    await instances.refreshStatsCache()

    const stats = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/instances/stats',
      headers: { cookie: `hub_sid=${adminSession.token}` },
    })
    expect(stats.statusCode).toBe(200)
    const statsBody = stats.json() as { userId: number; stats: { cpuPercent: number } | null; statsAt: string }[]
    expect(statsBody).toHaveLength(1)
    expect(statsBody[0]?.stats?.cpuPercent).toBe(1.5)
    expect(statsBody[0]?.statsAt).toBe(ctx.clock.nowIso())

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/instances',
      headers: { cookie: `hub_sid=${adminSession.token}` },
    })
    expect(list.statusCode).toBe(200)
    const rows = list.json() as {
      stats: { cpuPercent: number } | null
      statsAt: string | null
      probe: { state: string; openClients: number } | null
    }[]
    expect(rows[0]?.stats?.cpuPercent).toBe(1.5)
    expect(rows[0]?.statsAt).toBeTruthy()
    expect(rows[0]?.probe?.state).toBe('unattended')
    expect(rows[0]?.probe?.openClients).toBe(0)
  })
})
