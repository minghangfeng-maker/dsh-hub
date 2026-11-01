import { get, request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ATTACH_COLLABORATORS, type InternalInstanceService } from '../src/modules/instances/service.js'
import { containerNameFor, imageForVersion, FALLBACK_DSH_VERSION } from '../src/modules/instances/spec.js'
import {
  createTestApp,
  createUser,
  json,
  loginAs,
  type TestApp,
  type TestSession,
  type TestUser,
} from './helpers.js'

const IMAGE = imageForVersion(FALLBACK_DSH_VERSION)

interface RoutesSetup {
  ctx: TestApp
  owner: TestUser
  ownerSession: TestSession
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

async function setup(): Promise<RoutesSetup> {
  const ctx = await createTestApp()
  contexts.push(ctx)
  const driver = ctx.driver!
  driver.addImage(IMAGE)
  const owner = await createUser(ctx.app)
  const admin = await createUser(ctx.app, { role: 'admin' })
  const instances = ctx.app.deps.services.instances as InternalInstanceService
  await instances.provision(owner.id)
  return {
    ctx,
    owner,
    ownerSession: loginAs(ctx.app, owner),
    admin,
    adminSession: loginAs(ctx.app, admin),
    instances,
    driver,
    name: containerNameFor(owner.slug),
  }
}

/** 连一个 SSE 流，收满 N 帧就断开（不等待流结束） */
function collectSseFrames(
  url: string,
  headers: Record<string, string>,
  maxFrames = 1,
  timeoutMs = 5000,
): Promise<{ status: number; frames: string[] }> {
  return new Promise((resolve, reject) => {
    const frames: string[] = []
    let buffer = ''
    let status = 0
    const req = get(url, { headers }, (res) => {
      status = res.statusCode ?? 0
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          if (frame.length > 0 && !frame.startsWith(':')) frames.push(frame)
          index = buffer.indexOf('\n\n')
        }
        if (frames.length >= maxFrames) {
          req.destroy()
          resolve({ status, frames })
        }
      })
      res.on('end', () => resolve({ status, frames }))
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      // 主动 destroy 会走到这里：已经收够了就当成功
      if (frames.length >= maxFrames) resolve({ status, frames })
      else reject(error)
    })
    const timer = setTimeout(() => {
      req.destroy()
      resolve({ status, frames })
    }, timeoutMs)
    timer.unref()
  })
}

describe('04 §3.1 我的 DSH', () => {
  it('未登录 → 401 UNAUTHENTICATED', async () => {
    const { ctx } = await setup()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me/instance' })
    expect(res.statusCode).toBe(401)
    expect(json<{ error: { code: string } }>(res).error.code).toBe('UNAUTHENTICATED')
  })

  it('GET /api/me/instance 返回 instance/quota/stats/modelSummary', async () => {
    const { ctx, ownerSession, instances, owner } = await setup()
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/instance',
      headers: ownerSession.headers,
    })
    expect(before.statusCode).toBe(200)
    const idle = json<{
      instance: { status: string; openUrl: string }
      stats: { cpuPercent: number; diskBytes: number | null; diskLimitBytes: number }
      quota: { cpus: number }
    }>(before)
    expect(idle.instance.status).toBe('stopped')
    expect(idle.instance.openUrl).toBe(`/dsh/${owner.username}/`)
    // 已停止时运行时数字是 0；磁盘用量**不阻塞首屏**（WP45）：冷缓存先给 null 并在后台统计，
    // 拿到值之后才是数字（前端 `diskBytes ?? 0` 画 90%/100% 提示，05 §7）
    expect(idle.stats.cpuPercent).toBe(0)
    expect(idle.stats.diskBytes === null || idle.stats.diskBytes >= 0).toBe(true)
    expect(idle.stats.diskLimitBytes).toBe(20 * 1024 * 1024 * 1024)
    expect(idle.quota.cpus).toBe(2)

    await instances.ensureRunning(owner.id)
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/instance',
      headers: ownerSession.headers,
    })
    const running = json<{
      instance: { status: string; runtimeVersion: string; needsRecreate: boolean }
      stats: { cpuPercent: number; diskBytes: number | null; diskLimitBytes: number }
      modelSummary: { preset: string; providers: string[] }
    }>(after)
    expect(running.instance).toMatchObject({ status: 'running', runtimeVersion: FALLBACK_DSH_VERSION })
    expect(running.stats.cpuPercent).toBeGreaterThanOrEqual(0)
    // 启动准入的配额检查已经把磁盘统计打过一轮（同步遍历 + 250ms 预算），这里应当有数字了
    expect(typeof running.stats.diskBytes).toBe('number')
    expect(running.modelSummary).toEqual({
      policy: 'managed',
      preset: '',
      defaultModel: '',
      providers: [],
    })
  })

  it('POST start：首次 202，已在运行 200（04 §3.1）', async () => {
    const { ctx, ownerSession } = await setup()
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: ownerSession.headers,
    })
    expect(first.statusCode).toBe(202)
    expect(json<{ instance: { status: string } }>(first).instance.status).toBe('running')

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/me/instance/start',
      headers: ownerSession.headers,
    })
    expect(second.statusCode).toBe(200)
  })

  it('POST stop / restart 都是 202', async () => {
    const { ctx, ownerSession } = await setup()
    await ctx.app.inject({ method: 'POST', url: '/api/me/instance/start', headers: ownerSession.headers })
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: '/api/me/instance/stop',
      headers: ownerSession.headers,
    })
    expect(stopped.statusCode).toBe(202)
    expect(json<{ instance: { status: string } }>(stopped).instance.status).toBe('stopped')

    const restarted = await ctx.app.inject({
      method: 'POST',
      url: '/api/me/instance/restart',
      headers: ownerSession.headers,
    })
    expect(restarted.statusCode).toBe(202)
    expect(json<{ instance: { status: string } }>(restarted).instance.status).toBe('running')
  })

  it('GET /api/me/instance/events：SSE event: status，先给一份快照', async () => {
    const { ctx, ownerSession } = await setup()
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const sse = await collectSseFrames(`${address}/api/me/instance/events`, {
      cookie: ownerSession.cookie,
      accept: 'text/event-stream',
    })
    expect(sse.status).toBe(200)
    expect(sse.frames[0]).toContain('event: status')
    const payload = JSON.parse(sse.frames[0]!.split('data: ')[1]!) as { instance: { status: string } }
    expect(payload.instance.status).toBe('stopped')
  })

  it('启动阶段事件会推给订阅者（creating/booting/ready）', async () => {
    const { ctx, ownerSession, instances, owner } = await setup()
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const collected: string[] = []
    const off = ctx.app.deps.events.on('instance.status', ({ userId, event }) => {
      if (userId === owner.id) collected.push(event.phase ?? 'status')
    })
    await instances.ensureRunning(owner.id)
    off()
    expect(collected).toContain('creating')
    expect(collected).toContain('booting')
    expect(collected).toContain('ready')
    void address
    void ownerSession
  })
})

describe('04 §4.3 管理端实例', () => {
  it('普通用户 403、未登录 401、管理员拿到列表', async () => {
    const { ctx, ownerSession, adminSession, instances, owner } = await setup()
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/instances',
      headers: ownerSession.headers,
    })
    expect(forbidden.statusCode).toBe(403)
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/admin/instances' })
    expect(anonymous.statusCode).toBe(401)

    await instances.ensureRunning(owner.id)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/instances',
      headers: adminSession.headers,
    })
    expect(res.statusCode).toBe(200)
    const rows = json<
      {
        user: { slug: string }
        instance: { status: string; openUrl: string }
        stats: { cpuPercent: number } | null
        statsAt: string | null
      }[]
    >(res)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user.slug).toBe(owner.slug)
    expect(rows[0]!.instance.status).toBe('running')
    expect(rows[0]!.instance.openUrl).toBe(`/dsh/${owner.username}/`)
    // WP33：列表不再内联采集 stats（首屏不等 docker stats），采样器填完缓存后才有值
    expect(rows[0]!.stats).toBeNull()
    await instances.refreshStatsCache()
    const warm = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/instances',
      headers: adminSession.headers,
    })
    const warmRows = json<
      { stats: { cpuPercent: number } | null; statsAt: string | null }[]
    >(warm)
    expect(warmRows[0]!.stats?.cpuPercent).toBe(1.5)
    expect(warmRows[0]!.statsAt).toBeTruthy()
  })

  it('POST /api/admin/instances/:userId/:action 支持 start|stop|restart|recreate，参数不合法 400', async () => {
    const { ctx, adminSession, owner, instances } = await setup()
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/instances/${String(owner.id)}/start`,
      headers: adminSession.headers,
    })
    expect(started.statusCode).toBe(202)
    expect(instances.currentStatus(owner.id)).toBe('running')

    const recreated = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/instances/${String(owner.id)}/recreate`,
      headers: adminSession.headers,
    })
    expect(recreated.statusCode).toBe(202)

    const badAction = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/instances/${String(owner.id)}/explode`,
      headers: adminSession.headers,
    })
    expect(badAction.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(badAction).error.code).toBe('VALIDATION_FAILED')

    const badId = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/instances/abc/start',
      headers: adminSession.headers,
    })
    expect(badId.statusCode).toBe(400)

    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/instances/${String(owner.id)}/stop`,
      headers: adminSession.headers,
    })
    expect(stopped.statusCode).toBe(202)
    expect(instances.currentStatus(owner.id)).toBe('stopped')
  })

  it('GET 日志：默认 tail=300、脱敏 token=***', async () => {
    const { ctx, adminSession, owner, instances, driver } = await setup()
    await instances.ensureRunning(owner.id)
    await driver.exec(containerNameFor(owner.slug), ['sh', '-lc', 'echo token=abcdef123456'])
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/instances/${String(owner.id)}/logs?tail=50`,
      headers: adminSession.headers,
    })
    expect(res.statusCode).toBe(200)
    const body = json<{ text: string }>(res)
    expect(body.text).toContain('token=***')
    expect(body.text).not.toContain('abcdef123456')

    const badQuery = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/instances/${String(owner.id)}/logs?tail=0`,
      headers: adminSession.headers,
    })
    expect(badQuery.statusCode).toBe(400)
  })

  it('GET 日志流：SSE event: line（管理员）', async () => {
    const { ctx, adminSession, owner, instances } = await setup()
    await instances.ensureRunning(owner.id)
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const sse = await collectSseFrames(
      `${address}/api/admin/instances/${String(owner.id)}/logs/stream`,
      { cookie: adminSession.cookie, accept: 'text/event-stream' },
      1,
    )
    expect(sse.status).toBe(200)
    expect(sse.frames[0]).toContain('event: line')
  })

  it('日志流：非管理员 403', async () => {
    const { ctx, ownerSession, owner } = await setup()
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/instances/${String(owner.id)}/logs/stream`,
      headers: ownerSession.headers,
    })
    expect(res.statusCode).toBe(403)
  })

  it('详情页的实例摘要可由 instances.getSummary 提供（WP1 的用户详情复用）', async () => {
    const { instances, owner } = await setup()
    await instances.ensureRunning(owner.id)
    const summary = await instances.getSummary(owner.id)
    expect(summary).toMatchObject({ status: 'running', needsRecreate: false })
    expect(summary.openUrl).toBe(`/dsh/${owner.username}/`)
  })

  it('models.summaryForUser 可用时进 modelSummary（WP3 接线点）', async () => {
    const { ctx, ownerSession, instances } = await setup()
    instances[ATTACH_COLLABORATORS]({
      summaryForUser: async () => ({
        policy: 'managed',
        preset: '默认',
        defaultModel: 'deepseek-chat',
        providers: ['hub-relay'],
      }),
    })
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/instance',
      headers: ownerSession.headers,
    })
    expect(json<{ modelSummary: unknown }>(res).modelSummary).toEqual({
      policy: 'managed',
      preset: '默认',
      defaultModel: 'deepseek-chat',
      providers: ['hub-relay'],
    })
  })
})

/** 保留：方便以后加需要原始 socket 的用例 */
export const __rawRequest = request
