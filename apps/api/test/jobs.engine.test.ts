import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AdminOverviewResponseSchema } from '@dsh-hub/shared'
import { createUser, type TestUser } from './helpers.js'
import {
  TEST_META,
  cleanupDirs,
  createWp4App,
  deferred,
  makeTempDir,
  sleep,
  waitFor,
  type Wp4TestApp,
} from './helpers-wp4.js'

/**
 * jobs 引擎（06 §5.2）：并发上限、每用户串行、金丝雀、失败率暂停、
 * retry-failed、cancel、pause/resume、重启恢复、日志截断。
 */
let ctx: Wp4TestApp
let app: FastifyInstance

const tempDirs: string[] = []

beforeEach(async () => {
  ctx = await createWp4App()
  app = ctx.app
})

afterEach(async () => {
  await ctx.close()
  cleanupDirs(tempDirs)
})

function jobs() {
  return app.deps.services.jobs
}

async function statusOf(jobId: number) {
  return (await jobs().get(jobId)).job.status
}

describe('jobs 引擎 · 调度', () => {
  it('全局并发上限 4，且同一用户的任务不会并行', async () => {
    const users: TestUser[] = []
    for (let i = 0; i < 6; i += 1) users.push(await createUser(app, { username: `conc${i}` }))

    let active = 0
    let maxActive = 0
    const perUser = new Map<number, number>()
    let userOverlap = false

    jobs().registerHandler({
      type: 'instance.recreate',
      async plan() {
        return { title: '并发测试', tasks: users.map((user) => ({ userId: user.id })) }
      },
      async runTask(_taskCtx, task) {
        active += 1
        maxActive = Math.max(maxActive, active)
        const current = (perUser.get(task.userId!) ?? 0) + 1
        perUser.set(task.userId!, current)
        if (current > 1) userOverlap = true
        await sleep(30)
        perUser.set(task.userId!, current - 1)
        active -= 1
        return { ok: true }
      },
    })

    const job = await jobs().create({
      type: 'instance.recreate',
      params: {},
      strategy: { concurrency: 8, canary: 0, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'succeeded', { label: 'job 完成' })

    expect(maxActive).toBe(4)
    expect(userOverlap).toBe(false)
    expect((await jobs().get(job.id)).job.done).toBe(6)
  })

  it('每用户串行：同一用户的多个任务依次执行', async () => {
    const user = await createUser(app, { username: 'serial' })
    const order: number[] = []
    let parallel = false
    let running = 0

    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return {
          title: '串行测试',
          tasks: [1, 2, 3].map(() => ({ userId: user.id })),
        }
      },
      async runTask(_taskCtx, task) {
        running += 1
        if (running > 1) parallel = true
        order.push(task.seq)
        await sleep(10)
        running -= 1
      },
    })

    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { concurrency: 4, canary: 0, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'succeeded', { label: 'job 完成' })
    expect(parallel).toBe(false)
    expect(order).toEqual([1, 2, 3])
  })

  it('plan 产出 0 个任务时直接 succeeded', async () => {
    jobs().registerHandler({
      type: 'rollout.models',
      async plan() {
        return { title: '空任务', tasks: [] }
      },
      async runTask() {
        throw new Error('不应该执行')
      },
    })
    const job = await jobs().create({ type: 'rollout.models', params: {} })
    expect(job.status).toBe('succeeded')
    expect(job.total).toBe(0)
    expect(job.finishedAt).not.toBeNull()
  })

  it('未注册的任务类型直接拒绝（INTERNAL）', async () => {
    await expect(jobs().create({ type: 'nope.unknown', params: {} })).rejects.toThrow(/未注册的任务类型/)
  })
})

describe('jobs 引擎 · 失败策略', () => {
  it('金丝雀任务失败 → 立即暂停，其余任务保持 pending', async () => {
    const canary = await createUser(app, { username: 'canary' })
    const other = await createUser(app, { username: 'other' })

    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return {
          title: '金丝雀',
          tasks: [{ userId: canary.id }, { userId: other.id }],
        }
      },
      async runTask(_taskCtx, task) {
        if (task.seq === 1) throw new Error('金丝雀炸了')
        return { ok: true }
      },
    })

    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { concurrency: 3, canary: 1, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'paused', { label: '暂停' })
    const detail = await jobs().get(job.id)
    expect(detail.job.error).toContain('金丝雀')
    expect(detail.tasks[0]!.status).toBe('failed')
    expect(detail.tasks[0]!.error).toContain('金丝雀炸了')
    expect(detail.tasks[1]!.status).toBe('pending')
  })

  it('失败率超过 maxFailureRatio 才暂停（严格大于）', async () => {
    const users: TestUser[] = []
    for (let i = 0; i < 10; i += 1) users.push(await createUser(app, { username: `ratio${i}` }))

    jobs().registerHandler({
      type: 'rollout.runtime',
      async plan() {
        return { title: '失败率', tasks: users.map((user) => ({ userId: user.id })) }
      },
      async runTask(_taskCtx, task) {
        if (task.seq <= 3) throw new Error(`任务 ${task.seq} 失败`)
        return { ok: true }
      },
    })

    const job = await jobs().create({
      type: 'rollout.runtime',
      params: {},
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 0.2 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'paused', { label: '失败率暂停' })
    const detail = await jobs().get(job.id)
    expect(detail.job.failed).toBe(3)
    expect(detail.job.error).toContain('失败率')
    expect(detail.tasks.filter((t) => t.status === 'pending').length).toBe(7)
  })

  it('单任务失败不会被失败率暂停，直接 failed', async () => {
    const user = await createUser(app, { username: 'single' })
    jobs().registerHandler({
      type: 'runtime.build',
      async plan() {
        return { title: '单任务', tasks: [{ userId: user.id }] }
      },
      async runTask() {
        throw new Error('构建失败')
      },
    })
    const job = await jobs().create({
      type: 'runtime.build',
      params: {},
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 0.2 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'failed', { label: '失败收尾' })
    const detail = await jobs().get(job.id)
    expect(detail.tasks[0]!.status).toBe('failed')
  })

  it('retry-failed 把失败任务重置并重跑，最后 succeeded', async () => {
    const users: TestUser[] = []
    for (let i = 0; i < 2; i += 1) users.push(await createUser(app, { username: `retry${i}` }))
    const attempts = new Map<number, number>()

    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return { title: '重试', tasks: users.map((user) => ({ userId: user.id })) }
      },
      async runTask(_taskCtx, task) {
        const count = (attempts.get(task.seq) ?? 0) + 1
        attempts.set(task.seq, count)
        if (task.seq === 2 && count === 1) throw new Error('第一次失败')
        return { ok: true }
      },
    })

    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { concurrency: 2, canary: 0, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'partial', { label: '部分失败' })

    const retried = await jobs().retryFailed(job.id, TEST_META, null)
    expect(retried.status).toBe('running')
    await waitFor(async () => (await statusOf(job.id)) === 'succeeded', { label: '重试后成功' })
    const detail = await jobs().get(job.id)
    expect(detail.tasks[1]!.attempt).toBe(2)
    expect(detail.tasks[1]!.error).toBeNull()
  })
})

describe('jobs 引擎 · 取消与暂停', () => {
  it('cancel 通过 AbortSignal 通知 handler，pending 任务直接 canceled', async () => {
    const users: TestUser[] = []
    for (let i = 0; i < 3; i += 1) users.push(await createUser(app, { username: `cancel${i}` }))

    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return { title: '取消', tasks: users.map((user) => ({ userId: user.id })) }
      },
      runTask(taskCtx) {
        return new Promise((_resolve, reject) => {
          taskCtx.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      },
    })

    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await jobs().get(job.id)).tasks[0]!.status === 'running', {
      label: '第一个任务开跑',
    })
    const canceled = await jobs().cancel(job.id, TEST_META, null)
    expect(canceled.status).toBe('canceled')
    await waitFor(async () => (await jobs().get(job.id)).tasks.every((t) => t.status === 'canceled'), {
      label: '全部取消',
    })
    const detail = await jobs().get(job.id)
    expect(detail.job.finishedAt).not.toBeNull()
    expect(detail.tasks.map((t) => t.status)).toEqual(['canceled', 'canceled', 'canceled'])
  })

  it('pause 后不再派发新任务，resume 继续跑完', async () => {
    const users: TestUser[] = []
    for (let i = 0; i < 3; i += 1) users.push(await createUser(app, { username: `pause${i}` }))
    const gate = deferred()

    jobs().registerHandler({
      type: 'instance.recreate',
      async plan() {
        return { title: '暂停', tasks: users.map((user) => ({ userId: user.id })) }
      },
      async runTask(_taskCtx, task) {
        if (task.seq === 1) await gate.promise
      },
    })

    const job = await jobs().create({
      type: 'instance.recreate',
      params: {},
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await jobs().get(job.id)).tasks[0]!.status === 'running', {
      label: '任务开跑',
    })
    await jobs().pause(job.id, TEST_META, null)
    gate.resolve()
    await waitFor(async () => (await jobs().get(job.id)).tasks[0]!.status === 'succeeded', {
      label: '在飞任务收尾',
    })
    const paused = await jobs().get(job.id)
    expect(paused.job.status).toBe('paused')
    expect(paused.tasks[1]!.status).toBe('pending')

    await jobs().resume(job.id, TEST_META, null)
    await waitFor(async () => (await statusOf(job.id)) === 'succeeded', { label: '恢复后完成' })
  })

  it('cancel 之后不能再 cancel / resume', async () => {
    jobs().registerHandler({
      type: 'rollout.models',
      async plan() {
        return { title: '终态', tasks: [{ userId: null }] }
      },
      async runTask() {
        return null
      },
    })
    const job = await jobs().create({ type: 'rollout.models', params: {}, strategy: { canary: 0 } })
    await waitFor(async () => (await statusOf(job.id)) === 'succeeded', { label: '完成' })
    await expect(jobs().cancel(job.id, TEST_META, null)).rejects.toThrow(/不能取消/)
    await expect(jobs().resume(job.id, TEST_META, null)).rejects.toThrow(/不能恢复/)
    await expect(jobs().retryFailed(job.id, TEST_META, null)).rejects.toThrow(/没有失败的任务项/)
  })
})

describe('jobs 引擎 · 日志与重启恢复', () => {
  it('ctx.log 落库并推事件，超过 256KB 截断头部', async () => {
    const user = await createUser(app, { username: 'logger' })
    const chunks: string[] = []
    const off = app.deps.events.on('job.log', (payload) => chunks.push(payload.chunk))

    const line = 'x'.repeat(999)
    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return { title: '日志', tasks: [{ userId: user.id }] }
      },
      async runTask(taskCtx) {
        for (let i = 0; i < 300; i += 1) taskCtx.log(`line-${i}-${line}`)
      },
    })

    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { canary: 0 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'succeeded', { label: '完成' })
    off()

    const detail = await jobs().get(job.id)
    const text = await jobs().taskLog(job.id, detail.tasks[0]!.id)
    expect(text.length).toBeLessThanOrEqual(256 * 1024)
    expect(text).toContain('line-299-')
    expect(text).not.toContain('line-0-')
    expect(chunks.join('')).toContain('line-299-')
  })

  // WP8b B3：失败原因不能只躺在 `job_tasks.error` 里——任务日志末尾也要有一行（脱敏后）
  it('任务抛错 → 日志末尾追加「✗ 失败：<原因>」（脱敏），error 照写', async () => {
    const user = await createUser(app, { username: 'failog' })
    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return { title: '失败日志', tasks: [{ userId: user.id }] }
      },
      async runTask(taskCtx) {
        taskCtx.log('开始安装 opt-plugin@2.0.0')
        throw new Error('dsh plugin add 失败：401，token=supersecret123')
      },
    })
    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await statusOf(job.id)) === 'failed', { label: '失败收尾' })

    const detail = await jobs().get(job.id)
    const task = detail.tasks[0]!
    const text = await jobs().taskLog(job.id, task.id)
    expect(text).toContain('开始安装 opt-plugin@2.0.0')
    expect(text.trimEnd().split('\n').at(-1)).toBe('✗ 失败：dsh plugin add 失败：401，token=***')
    // error 字段保持原样（含完整原因，供接口与审计使用）
    expect(task.error).toBe('dsh plugin add 失败：401，token=supersecret123')
  })

  it('重启恢复：running 任务标 failed(hub restarted)，job 置 paused，resume 后按实际结果收尾', async () => {
    const dataDir = makeTempDir('dshhub-test-wp4-restart-')
    tempDirs.push(dataDir)

    const first = await createWp4App({ dataDir })
    const user = await createUser(first.app, { username: 'restart' })
    const now = first.clock.nowIso()
    const jobId = first.app.deps.db.run(
      `INSERT INTO jobs (type, title, status, params_json, strategy_json, total, done, failed, created_at, started_at)
       VALUES ('rollout.plugin', '崩在半路', 'running', '{}', '{"concurrency":1,"canary":0,"maxFailureRatio":1,"restart":"now"}', 2, 0, 0, ?, ?)`,
      now,
      now,
    ).lastInsertRowid
    first.app.deps.db.run(
      `INSERT INTO job_tasks (job_id, seq, user_id, status, attempt, log, started_at)
       VALUES (?, 1, ?, 'running', 1, '正在安装…', ?)`,
      jobId,
      user.id,
      now,
    )
    first.app.deps.db.run(
      "INSERT INTO job_tasks (job_id, seq, user_id, status, attempt, log) VALUES (?, 2, ?, 'pending', 0, '')",
      jobId,
      user.id,
    )
    await first.close()

    const second = await createWp4App({ dataDir })
    try {
      const detail = await second.app.deps.services.jobs.get(jobId)
      expect(detail.job.status).toBe('paused')
      expect(detail.job.error).toBe('hub restarted')
      expect(detail.tasks[0]!.status).toBe('failed')
      expect(detail.tasks[0]!.error).toBe('hub restarted')
      expect(detail.tasks[1]!.status).toBe('pending')

      // resume 后：失败任务不能自动复活，剩下的 pending 跑完 → partial
      second.app.deps.services.jobs.registerHandler({
        type: 'rollout.plugin',
        async plan() {
          return { title: 'x', tasks: [] }
        },
        async runTask() {
          return { ok: true }
        },
      })
      await second.app.deps.services.jobs.resume(jobId, TEST_META, null)
      await waitFor(async () => (await second.app.deps.services.jobs.get(jobId)).job.status === 'partial', {
        label: '恢复收尾',
      })
      const after = await second.app.deps.services.jobs.get(jobId)
      expect(after.job.failed).toBe(1)
      expect(after.job.done).toBe(1)
    } finally {
      await second.close()
    }
  })

  it('概览计数：running / queued / failedLast24h', async () => {
    expect(jobs().overviewCounts()).toEqual({ running: 0, queued: 0, failedLast24h: 0 })

    const gate = deferred()
    const user = await createUser(app, { username: 'overview' })
    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return { title: '概览', tasks: [{ userId: user.id }] }
      },
      async runTask() {
        await gate.promise
      },
    })
    const running = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { canary: 0 },
    })
    await waitFor(async () => (await statusOf(running.id)) === 'running', { label: 'running' })
    expect(jobs().overviewCounts().running).toBe(1)
    expect(jobs().countByStatus('running')).toBe(1)
    gate.resolve()
    await waitFor(async () => (await statusOf(running.id)) === 'succeeded', { label: '完成' })

    jobs().registerHandler({
      type: 'rollout.models',
      async plan() {
        return { title: '失败', tasks: [{ userId: user.id }] }
      },
      async runTask() {
        throw new Error('挂了')
      },
    })
    const failed = await jobs().create({
      type: 'rollout.models',
      params: {},
      strategy: { canary: 0, maxFailureRatio: 1 },
    })
    await waitFor(async () => (await statusOf(failed.id)) === 'failed', { label: '失败' })
    expect(jobs().overviewCounts().failedLast24h).toBe(1)
    // 04 §4.1 概览的 jobs 字段：WP1 的 overview() 直接调 overviewCounts()
    expect(AdminOverviewResponseSchema.shape.jobs.safeParse(jobs().overviewCounts()).success).toBe(true)
  })
})
