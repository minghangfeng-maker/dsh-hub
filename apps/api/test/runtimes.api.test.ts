import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createUser, json, loginAs, type TestSession, type TestUser } from './helpers.js'
import {
  cleanupDirs,
  createWp3App,
  makeTempDir,
  startFakeNpmRegistry,
  startInstance,
  waitFor,
  type FakeServer,
  type Wp3TestApp,
} from './helpers-wp3.js'
import { smokeSpec } from '../src/modules/runtimes/build.js'

/**
 * runtimes 模块（04 §4.6、06 §3）：可用版本查询（10 分钟缓存）、runtime.build 任务与冒烟测试、
 * 设默认/下线/删除、upgradeUser（成功、钉版本跳过、新镜像就绪失败 → 回滚旧镜像）。
 */

export const BASE_VERSION = '0.2.0-rc.2'
const NEW_VERSION = '0.3.0'

let ctx: Wp3TestApp
let app: FastifyInstance
let admin: TestUser
let adminSession: TestSession
let registry: FakeServer
const tempDirs: string[] = []

beforeEach(async () => {
  registry = await startFakeNpmRegistry({
    '@deepseek-ai/dsh': {
      versions: {
        '0.1.0': { name: '@deepseek-ai/dsh', version: '0.1.0' },
        [BASE_VERSION]: { name: '@deepseek-ai/dsh', version: BASE_VERSION },
        [NEW_VERSION]: { name: '@deepseek-ai/dsh', version: NEW_VERSION },
      },
      distTags: { latest: NEW_VERSION, next: '0.3.0-rc.1' },
    },
  })
  ctx = await createWp3App({ env: { HUB_NPM_REGISTRY: registry.url } })
  app = ctx.app
  admin = await createUser(app, { username: 'admin1', role: 'admin' })
  adminSession = loginAs(app, admin)
})

afterEach(async () => {
  await ctx.close()
  await registry.close()
  cleanupDirs(tempDirs)
})

interface InjectOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
  headers?: Record<string, string>
}

/** 以某个会话注入请求（带 cookie 与 Origin）；`as never` 只是绕开 Fastify 的 inject 重载 */
function injectAs(session: TestSession, opts: InjectOpts) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    headers: { ...session.headers, ...(opts.headers ?? {}) },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  } as never)
}

async function createRuntime(dshVersion: string): Promise<{ runtimeId: number; jobId: number }> {
  const res = await injectAs(adminSession, {
    method: 'POST',
    url: '/api/admin/runtimes',
    payload: { dshVersion },
  })
  expect(res.statusCode, res.body).toBe(202)
  const body = json<{ runtime: { id: number }; jobId: number }>(res)
  return { runtimeId: body.runtime.id, jobId: body.jobId }
}

async function jobStatus(jobId: number): Promise<string> {
  return (await app.deps.services.jobs.get(jobId)).job.status
}

describe('DSH 版本目录（04 §4.6）', () => {
  it('available：返回版本（倒序）+ latest/next，并缓存 10 分钟', async () => {
    const first = await injectAs(adminSession, { method: 'GET', url: '/api/admin/runtimes/available' })
    expect(first.statusCode, first.body).toBe(200)
    expect(json(first)).toEqual({
      versions: [NEW_VERSION, BASE_VERSION, '0.1.0'],
      latest: NEW_VERSION,
      next: '0.3.0-rc.1',
    })
    const requestsAfterFirst = registry.requests.length
    const second = await injectAs(adminSession, { method: 'GET', url: '/api/admin/runtimes/available' })
    expect(second.statusCode).toBe(200)
    expect(registry.requests.length).toBe(requestsAfterFirst)
  })

  it('构建：runtime.build 任务 → 冒烟 dsh --version → ready', async () => {
    const { runtimeId, jobId } = await createRuntime(BASE_VERSION)
    ctx.driver.setExecHandler((_name, cmd) => {
      if (cmd.join(' ') === 'dsh --version') return { exitCode: 0, output: `${BASE_VERSION}\n` }
      return { exitCode: 0, output: 'ok' }
    })
    await waitFor(async () => (await jobStatus(jobId)) === 'succeeded', { label: '构建任务完成' })

    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/runtimes' })
    const row = json<{ id: number; status: string; image: string; sizeBytes: number; usersOnIt: number }[]>(
      list,
    ).find((item) => item.id === runtimeId)
    expect(row).toMatchObject({
      status: 'ready',
      image: `dshhub/runtime:${BASE_VERSION}`,
      usersOnIt: 0,
    })
    expect(row?.sizeBytes).toBeGreaterThan(0)
    // 构建过程中的日志写进了 task 日志
    const { tasks } = await app.deps.services.jobs.get(jobId)
    expect((await app.deps.services.jobs.taskLog(jobId, tasks[0]!.id)).length).toBeGreaterThan(0)
  })

  it('冒烟测试版本不匹配 → 任务失败、runtime 置 failed', async () => {
    const { runtimeId, jobId } = await createRuntime(BASE_VERSION)
    ctx.driver.setExecHandler(() => ({ exitCode: 0, output: '0.1.0\n' }))
    await waitFor(async () => (await jobStatus(jobId)) === 'failed', { label: '构建任务失败' })
    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/runtimes' })
    expect(json<{ id: number; status: string }[]>(list).find((item) => item.id === runtimeId)?.status).toBe(
      'failed',
    )
  })

  it('设为默认要求镜像 ready；默认版本不能下线也不能删除', async () => {
    // 直接种一行 building：走 API 会和后台构建任务竞态（构建可能在断言前就完成了）
    const buildingId = app.deps.db.run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
       VALUES (?, ?, 'building', 0, '', ?)`,
      NEW_VERSION,
      `dshhub/runtime:${NEW_VERSION}`,
      app.deps.clock.nowIso(),
    ).lastInsertRowid
    const notReady = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/runtimes/${buildingId}`,
      payload: { isDefault: true },
    })
    expect(notReady.statusCode, notReady.body).toBe(409)
    expect(json<{ error: { code: string } }>(notReady).error.code).toBe('RUNTIME_NOT_READY')

    app.deps.db.run("UPDATE runtimes SET status = 'ready' WHERE id = ?", buildingId)
    ctx.driver.addImage(`dshhub/runtime:${NEW_VERSION}`)

    const setDefault = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/runtimes/${buildingId}`,
      payload: { isDefault: true },
    })
    expect(setDefault.statusCode, setDefault.body).toBe(200)
    expect(json<{ isDefault: boolean }>(setDefault).isDefault).toBe(true)

    const retireDefault = await injectAs(adminSession, {
      method: 'PATCH',
      url: `/api/admin/runtimes/${buildingId}`,
      payload: { status: 'retired' },
    })
    expect(retireDefault.statusCode).toBe(409)
    const deleteDefault = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/runtimes/${buildingId}`,
    })
    expect(deleteDefault.statusCode).toBe(409)
  })

  it('删除：钉了用户的不能删；没人用的删掉记录与镜像', async () => {
    ctx.driver.setExecHandler((_name, cmd) =>
      cmd.join(' ') === 'dsh --version'
        ? { exitCode: 0, output: `${BASE_VERSION}\n` }
        : { exitCode: 0, output: 'ok' },
    )
    const first = await createRuntime(BASE_VERSION)
    await waitFor(async () => (await jobStatus(first.jobId)) === 'succeeded', { label: '构建完成' })
    const user = await createUser(app, { username: 'alice' })
    app.deps.db.run('UPDATE users SET runtime_id = ? WHERE id = ?', first.runtimeId, user.id)
    const pinned = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/runtimes/${first.runtimeId}`,
    })
    expect(pinned.statusCode, pinned.body).toBe(409)

    app.deps.db.run('UPDATE users SET runtime_id = NULL WHERE id = ?', user.id)
    const removed = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/runtimes/${first.runtimeId}`,
    })
    expect(removed.statusCode, removed.body).toBe(204)
    expect(await ctx.driver.imageExists(`dshhub/runtime:${BASE_VERSION}`)).toBe(false)
  })
})

describe('WP8b B1：冒烟测试的一次性容器', () => {
  it('不需要网络：network=none，且不带用户网络子网；带本环境标签', () => {
    const spec = smokeSpec(
      { npmRegistry: 'https://registry.npmmirror.com', envId: 'wp8b' },
      'dshhub/runtime:0.2.1-alpha.2',
      '0.2.1-alpha.2',
    )
    expect(spec.network).toBe('none')
    expect(spec.networkSubnet).toBeUndefined()
    expect(spec.labels['dshhub.env']).toBe('wp8b')
    expect(spec.mounts).toEqual([])
  })
})

describe('WP8b B2：构建失败的状态收尾', () => {
  async function runtimeRow(runtimeId: number) {
    const list = await injectAs(adminSession, { method: 'GET', url: '/api/admin/runtimes' })
    return json<{ id: number; status: string; notes: string }[]>(list).find((item) => item.id === runtimeId)
  }

  it('冒烟测试抛错（B1 的真机现象）→ 行置 failed 且记原因，可删除；同版本号可重新构建', async () => {
    const first = await createRuntime(BASE_VERSION)
    // 复刻真机报错：runOnce 建容器时用户网络不存在（修 B1 前，这里会让行永远卡在 building）
    ctx.driver.setExecHandler(() => {
      throw new Error(
        '(HTTP code 404) no such container - failed to set up container networking: network dshhub-users not found',
      )
    })
    await waitFor(async () => (await jobStatus(first.jobId)) === 'failed', { label: '构建任务失败' })

    const failed = await runtimeRow(first.runtimeId)
    expect(failed?.status).toBe('failed')
    expect(failed?.notes).toContain('构建失败')
    expect(failed?.notes).toContain('network dshhub-users not found')

    // 重新构建：同版本号再次 POST → 复用该行并重置为 building → ready（不再 409）
    ctx.driver.setExecHandler((_name, cmd) =>
      cmd.join(' ') === 'dsh --version'
        ? { exitCode: 0, output: `${BASE_VERSION}\n` }
        : { exitCode: 0, output: 'ok' },
    )
    const again = await createRuntime(BASE_VERSION)
    expect(again.runtimeId).toBe(first.runtimeId)
    await waitFor(async () => (await jobStatus(again.jobId)) === 'succeeded', { label: '重新构建完成' })
    expect((await runtimeRow(first.runtimeId))?.status).toBe('ready')

    // 失败态删除：镜像不存在也不报错（这里再失败一次，直接删 failed 行）
    const doomed = await createRuntime(NEW_VERSION)
    ctx.driver.setExecHandler(() => {
      throw new Error('buildx: 构建中断')
    })
    await waitFor(async () => (await jobStatus(doomed.jobId)) === 'failed', { label: '第二次失败' })
    expect((await runtimeRow(doomed.runtimeId))?.status).toBe('failed')
    const removed = await injectAs(adminSession, {
      method: 'DELETE',
      url: `/api/admin/runtimes/${doomed.runtimeId}`,
    })
    expect(removed.statusCode, removed.body).toBe(204)
    expect(await runtimeRow(doomed.runtimeId)).toBeUndefined()
  })

  it('构建上下文不存在（HUB_RUNTIME_DIR 指错）→ 同样回写 failed，不留 building', async () => {
    const local = await createWp3App({ env: { HUB_RUNTIME_DIR: '/nonexistent-wp8b-runtime' } })
    try {
      const admin2 = await createUser(local.app, { username: 'admin-ctx', role: 'admin' })
      const session2 = loginAs(local.app, admin2)
      const res = await local.app.inject({
        method: 'POST',
        url: '/api/admin/runtimes',
        headers: session2.headers,
        payload: { dshVersion: '0.9.7' },
      } as never)
      expect(res.statusCode, res.body).toBe(202)
      const { runtime, jobId } = json<{ runtime: { id: number }; jobId: number }>(res)
      await waitFor(
        async () => (await local.app.deps.services.jobs.get(jobId)).job.status === 'failed',
        { label: '上下文缺失也要失败收尾' },
      )
      const row = local.app.deps.db.get<{ status: string; notes: string }>(
        'SELECT status, notes FROM runtimes WHERE id = ?',
        runtime.id,
      )
      expect(row?.status).toBe('failed')
      expect(row?.notes).toContain('构建上下文不存在')
    } finally {
      await local.close()
    }
  })

  it('启动对账：遗留的 building（构建任务已不在跑）置为 failed 并能删除', async () => {
    const dataDir = makeTempDir('dshhub-test-wp3-stale-build-')
    tempDirs.push(dataDir)

    const first = await createWp3App({ dataDir })
    const now = first.clock.nowIso()
    // 一份「构建已失败、任务已结束」的遗留行，外加一份连 build_job_id 都没有的
    const jobId = first.app.deps.db.run(
      `INSERT INTO jobs (type, title, status, params_json, strategy_json, total, done, failed, created_at, finished_at)
       VALUES ('runtime.build', '构建 DSH 版本 0.9.9', 'failed', '{}', '{"concurrency":1,"canary":0,"maxFailureRatio":0.2,"restart":"now"}', 1, 0, 1, ?, ?)`,
      now,
      now,
    ).lastInsertRowid
    const staleId = first.app.deps.db.run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, build_job_id, notes, created_at)
       VALUES ('0.9.9', 'dshhub/runtime:0.9.9', 'building', 0, ?, '', ?)`,
      jobId,
      now,
    ).lastInsertRowid
    const orphanId = first.app.deps.db.run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, build_job_id, notes, created_at)
       VALUES ('0.9.8', 'dshhub/runtime:0.9.8', 'building', 0, NULL, '', ?)`,
      now,
    ).lastInsertRowid
    await first.close()

    // 「重启」：同一个数据目录再起一个 app，onReady 里跑对账
    const second = await createWp3App({ dataDir })
    try {
      const admin2 = await createUser(second.app, { username: 'admin2', role: 'admin' })
      const session2 = loginAs(second.app, admin2)
      const list = await second.app.inject({
        method: 'GET',
        url: '/api/admin/runtimes',
        headers: session2.headers,
      } as never)
      const rows = json<{ id: number; status: string; notes: string }[]>(list)
      for (const id of [staleId, orphanId]) {
        const row = rows.find((item) => item.id === id)
        expect(row?.status, `runtime #${String(id)}`).toBe('failed')
        expect(row?.notes).toContain('Hub 重启对账')
      }
      // 收尾之后就能删除（旧行为会 409「版本正在构建，不能删除」）
      const removed = await second.app.inject({
        method: 'DELETE',
        url: `/api/admin/runtimes/${staleId}`,
        headers: session2.headers,
      } as never)
      expect(removed.statusCode).toBe(204)
    } finally {
      await second.close()
    }
  })
})

describe('upgradeUser（06 §3 / 10 D7 D8）', () => {
  async function readyRuntime(version: string): Promise<number> {
    ctx.driver.setExecHandler((_name, cmd) =>
      cmd.join(' ') === 'dsh --version'
        ? { exitCode: 0, output: `${version}\n` }
        : { exitCode: 0, output: 'ok' },
    )
    const { runtimeId, jobId } = await createRuntime(version)
    await waitFor(async () => (await jobStatus(jobId)) === 'succeeded', { label: `构建 ${version}` })
    return runtimeId
  }

  it('成功：写期望版本 → 用新镜像 recreate → 容器跑在新镜像上', async () => {
    const user = await createUser(app, { username: 'alice' })
    await startInstance(app, user.id)
    const newRuntime = await readyRuntime(NEW_VERSION)
    ctx.driver.addImage(`dshhub/runtime:${NEW_VERSION}`)

    const result = await app.deps.services.runtimes.upgradeUser(user.id, newRuntime, {
      onLog: () => undefined,
    })
    expect(result).toMatchObject({ ok: true, rolledBack: false })
    const row = app.deps.db.get<{ runtime_id: number | null }>(
      'SELECT runtime_id FROM users WHERE id = ?',
      user.id,
    )
    expect(row?.runtime_id).toBe(newRuntime)
    expect(ctx.driver.getContainer(`dshhub-${user.slug}`)?.spec.image).toBe(`dshhub/runtime:${NEW_VERSION}`)
    expect(app.deps.services.instances.currentStatus(user.id)).toBe('running')
  }, 60_000)

  it('新镜像就绪失败 → 用旧镜像回滚，期望状态恢复', async () => {
    const user = await createUser(app, { username: 'bob' })
    await startInstance(app, user.id)
    expect(ctx.driver.getContainer(`dshhub-${user.slug}`)?.spec.image).toBe(`dshhub/runtime:${BASE_VERSION}`)
    // 目录里登记为 ready，但本机没有这个镜像（等价于「镜像缺命令/构建产物丢了」）
    const brokenVersion = '0.9.9-broken'
    const newRuntime = app.deps.db.run(
      `INSERT INTO runtimes (dsh_version, image, status, is_default, notes, created_at)
       VALUES (?, ?, 'ready', 0, '', ?)`,
      brokenVersion,
      `dshhub/runtime:${brokenVersion}`,
      app.deps.clock.nowIso(),
    ).lastInsertRowid

    const result = await app.deps.services.runtimes.upgradeUser(user.id, newRuntime, {
      onLog: () => undefined,
    })
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    const row = app.deps.db.get<{ runtime_id: number | null }>(
      'SELECT runtime_id FROM users WHERE id = ?',
      user.id,
    )
    expect(row?.runtime_id).toBeNull()
    // 容器回到旧镜像且可用
    expect(ctx.driver.getContainer(`dshhub-${user.slug}`)?.spec.image).toBe(`dshhub/runtime:${BASE_VERSION}`)
    expect(app.deps.services.instances.currentStatus(user.id)).toBe('running')
  }, 60_000)

  it('实例没在跑（stopped/从未启动）→ 只写期望版本，不拉起容器（06 §5.1）', async () => {
    const user = await createUser(app, { username: 'stopped' })
    await startInstance(app, user.id)
    await app.deps.services.instances.stop(user.id, { reason: 'user' })
    const newRuntime = await readyRuntime(NEW_VERSION)
    ctx.driver.addImage(`dshhub/runtime:${NEW_VERSION}`)
    const before = ctx.driver.getContainer(`dshhub-${user.slug}`)?.state

    const result = await app.deps.services.runtimes.upgradeUser(user.id, newRuntime, {
      onLog: () => undefined,
    })
    expect(result).toMatchObject({ ok: true, skipped: true })
    expect(app.deps.services.instances.currentStatus(user.id)).toBe('stopped')
    expect(ctx.driver.getContainer(`dshhub-${user.slug}`)?.state).toBe(before)
    const row = app.deps.db.get<{ runtime_id: number | null }>(
      'SELECT runtime_id FROM users WHERE id = ?',
      user.id,
    )
    expect(row?.runtime_id).toBe(newRuntime)

    // disabled 用户同样只写期望版本
    const disabled = await createUser(app, { username: 'disabled1', status: 'disabled' })
    const skipped = await app.deps.services.runtimes.upgradeUser(disabled.id, newRuntime, {
      onLog: () => undefined,
    })
    expect(skipped).toMatchObject({ ok: true, skipped: true })
    expect(ctx.driver.getContainer(`dshhub-${disabled.slug}`)).toBeUndefined()
  }, 60_000)

  it('钉在别的版本上的用户：跳过，不动容器', async () => {
    const user = await createUser(app, { username: 'carol' })
    await startInstance(app, user.id)
    const newRuntime = await readyRuntime(NEW_VERSION)
    ctx.driver.addImage(`dshhub/runtime:${NEW_VERSION}`)
    app.deps.db.run('UPDATE users SET runtime_id = ? WHERE id = ?', 9999, user.id)

    const result = await app.deps.services.runtimes.upgradeUser(user.id, newRuntime, {
      onLog: () => undefined,
    })
    expect(result).toMatchObject({ ok: true, skipped: true })
    expect(ctx.driver.getContainer(`dshhub-${user.slug}`)?.spec.image).toBe(`dshhub/runtime:${BASE_VERSION}`)
  }, 60_000)
})
