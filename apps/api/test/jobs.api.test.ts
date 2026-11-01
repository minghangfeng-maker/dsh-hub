import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { JobDetailResponse, JobListResponse, JobTaskLogResponse } from '@dsh-hub/shared'
import { createUser, json, loginAs, type TestSession } from './helpers.js'
import {
  TEST_META,
  cleanupDirs,
  connectSse,
  createWp4App,
  deferred,
  waitFor,
  type Wp4TestApp,
} from './helpers-wp4.js'

/** 04 §4.8：`/api/admin/jobs*` 的权限、列表、详情、日志、动作与 SSE */
let ctx: Wp4TestApp
let app: FastifyInstance
let admin: TestSession
let member: TestSession

beforeEach(async () => {
  ctx = await createWp4App()
  app = ctx.app
  const adminUser = await createUser(app, { username: 'admin1', role: 'admin' })
  const memberUser = await createUser(app, { username: 'member1' })
  admin = loginAs(app, adminUser)
  member = loginAs(app, memberUser)
})

afterEach(async () => {
  await ctx.close()
  cleanupDirs([])
})

function jobs() {
  return app.deps.services.jobs
}

describe('jobs 接口 · 权限与查询', () => {
  it('未登录 401，非管理员 403', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/admin/jobs' })
    expect(anonymous.statusCode).toBe(401)
    expect(json<{ error: { code: string } }>(anonymous).error.code).toBe('UNAUTHENTICATED')

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/jobs',
      headers: member.headers,
    })
    expect(forbidden.statusCode).toBe(403)
    expect(json<{ error: { code: string } }>(forbidden).error.code).toBe('FORBIDDEN')
  })

  it('列表分页 + 类型/状态过滤，详情带 username，日志可读', async () => {
    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return { title: '接口任务', tasks: [{ userId: member.user.id }] }
      },
      async runTask(taskCtx, task) {
        taskCtx.log(`处理用户 ${task.userId}`)
        return { ok: true }
      },
    })
    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { canary: 0 },
      createdBy: admin.user.id,
    })
    await waitFor(async () => (await jobs().get(job.id)).job.status === 'succeeded', {
      label: '任务完成',
    })

    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/jobs?type=rollout.plugin&status=succeeded&page=1&pageSize=10',
      headers: admin.headers,
    })
    expect(list.statusCode).toBe(200)
    const listed = json<JobListResponse>(list)
    expect(listed.total).toBe(1)
    expect(listed.items[0]!.id).toBe(job.id)
    expect(listed.items[0]!.createdByUsername).toBe('admin1')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/jobs/${job.id}`,
      headers: admin.headers,
    })
    expect(detail.statusCode).toBe(200)
    const detailBody = json<JobDetailResponse>(detail)
    expect(detailBody.tasks).toHaveLength(1)
    expect(detailBody.tasks[0]!.username).toBe('member1')
    expect(detailBody.tasks[0]!.status).toBe('succeeded')

    const log = await app.inject({
      method: 'GET',
      url: `/api/admin/jobs/${job.id}/tasks/${detailBody.tasks[0]!.id}/log`,
      headers: admin.headers,
    })
    expect(log.statusCode).toBe(200)
    expect(json<JobTaskLogResponse>(log).text).toContain(`处理用户 ${member.user.id}`)

    const missing = await app.inject({ method: 'GET', url: '/api/admin/jobs/99999', headers: admin.headers })
    expect(missing.statusCode).toBe(404)

    const badQuery = await app.inject({
      method: 'GET',
      url: '/api/admin/jobs?status=nope',
      headers: admin.headers,
    })
    expect(badQuery.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(badQuery).error.code).toBe('VALIDATION_FAILED')
  })
})

describe('jobs 接口 · 动作', () => {
  it('pause / resume / cancel / retry-failed 都走通，未知动作 404', async () => {
    const gate = deferred()
    jobs().registerHandler({
      type: 'instance.recreate',
      async plan() {
        return { title: '动作', tasks: [{ userId: member.user.id }, { userId: null }] }
      },
      async runTask(taskCtx, task) {
        if (task.seq === 1) await gate.promise
        taskCtx.log('done')
      },
    })
    const job = await jobs().create({
      type: 'instance.recreate',
      params: {},
      strategy: { concurrency: 1, canary: 0, maxFailureRatio: 1 },
      createdBy: admin.user.id,
    })
    await waitFor(async () => (await jobs().get(job.id)).tasks[0]!.status === 'running', {
      label: '任务开跑',
    })

    const paused = await app.inject({
      method: 'POST',
      url: `/api/admin/jobs/${job.id}/pause`,
      headers: admin.headers,
    })
    expect(paused.statusCode).toBe(200)
    expect(json<{ job: { status: string } }>(paused).job.status).toBe('paused')

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/admin/jobs/${job.id}/resume`,
      headers: admin.headers,
    })
    expect(resumed.statusCode).toBe(200)
    expect(json<{ job: { status: string } }>(resumed).job.status).toBe('running')

    const canceled = await app.inject({
      method: 'POST',
      url: `/api/admin/jobs/${job.id}/cancel`,
      headers: admin.headers,
    })
    expect(canceled.statusCode).toBe(200)
    expect(json<{ job: { status: string } }>(canceled).job.status).toBe('canceled')
    gate.resolve()

    // 取消后没有失败任务 → retry-failed 409
    await waitFor(async () => (await jobs().get(job.id)).tasks[0]!.status === 'canceled', {
      label: '在飞任务收尾',
    })
    const retry = await app.inject({
      method: 'POST',
      url: `/api/admin/jobs/${job.id}/retry-failed`,
      headers: admin.headers,
    })
    expect(retry.statusCode).toBe(409)
    expect(json<{ error: { code: string } }>(retry).error.code).toBe('CONFLICT')

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/admin/jobs/${job.id}/explode`,
      headers: admin.headers,
    })
    expect(unknown.statusCode).toBe(404)

    const audit = app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id')
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['job.cancel', 'job.pause', 'job.resume']),
    )
    void TEST_META
  })
})

describe('jobs 接口 · SSE', () => {
  it('连接后先推快照，随后推 task / log / job 事件', async () => {
    const gate = deferred()
    jobs().registerHandler({
      type: 'rollout.plugin',
      async plan() {
        return { title: 'SSE', tasks: [{ userId: member.user.id }] }
      },
      async runTask(taskCtx) {
        await gate.promise
        taskCtx.log('来自任务的日志')
      },
    })
    const job = await jobs().create({
      type: 'rollout.plugin',
      params: {},
      strategy: { canary: 0 },
      createdBy: admin.user.id,
    })
    await waitFor(async () => (await jobs().get(job.id)).tasks[0]!.status === 'running', {
      label: '任务开跑',
    })

    const probe = await connectSse(app, `/api/admin/jobs/${job.id}/events`, admin.headers)
    try {
      await probe.waitFor('event: job')
      await probe.waitFor('event: task')
      gate.resolve()
      await probe.waitFor('event: log')
      await probe.waitFor('来自任务的日志')
      await probe.waitFor(/"status":"succeeded"/)
    } finally {
      await probe.close()
    }
  })

  it('不存在的 job 直接 404，不会挂住连接', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/jobs/424242/events',
      headers: admin.headers,
    })
    expect(res.statusCode).toBe(404)
  })
})
