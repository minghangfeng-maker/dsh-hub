import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  InstanceActionSchema,
  InstanceLogsQuerySchema,
  InstanceStartRequestSchema,
  type AdminInstanceListResponse,
  type AdminInstanceStatsResponse,
  type ComputeLease,
  type InstanceActionResponse,
  type InstanceStats,
  type InstanceStatus,
  type MyInstanceResponse,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { openSse } from '../../lib/sse.js'
import type { InternalInstanceService } from './service.js'

/**
 * 实例接口（04 §3.1 §4.3）。
 *
 * 注册前缀是 `/api`（`MODULE_PREFIXES.instances`），所以这里的路径**不重复写 `/api`**，
 * 即下面每个 url 的完整地址 = `/api` + url：
 *   `GET  /api/me/instance`、`POST /api/me/instance/{start,stop,restart}`、
 *   `GET  /api/me/instance/events`（SSE `event: status`）、
 *   `GET  /api/admin/instances`、`GET /api/admin/instances/stats`（WP33 的 stats 缓存快照）、
 *   `POST /api/admin/instances/:userId/{start,stop,restart,recreate}`、
 *   `GET  /api/admin/instances/:userId/logs`、`GET /api/admin/instances/:userId/logs/stream`（SSE `event: line`）。
 */

/** `req.user` 是 app.ts 的会话钩子放上去的（未登录为 null） */
async function requireUser(req: FastifyRequest): Promise<void> {
  if (!req.user) throw new HubError('UNAUTHENTICATED')
}

async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!req.user) throw new HubError('UNAUTHENTICATED')
  if (req.user.role !== 'admin') throw new HubError('FORBIDDEN')
}

/** `:userId` 路径参数（正整数） */
function parseUserId(req: FastifyRequest): number {
  const raw = (req.params as { userId?: string }).userId ?? ''
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new HubError('VALIDATION_FAILED', 'userId 必须是正整数', { fields: { userId: '必须是正整数' } })
  }
  return value
}

export function registerInstanceRoutes(
  app: FastifyInstance,
  deps: BaseDeps,
  service: InternalInstanceService,
): void {
  // ── 我的 DSH（04 §3.1） ───────────────────────────────────────────────────

  app.get('/me/instance', { preHandler: requireUser }, async (req): Promise<MyInstanceResponse> => {
    const user = req.user!
    const [instance, stats, modelSummary] = await Promise.all([
      service.getSummary(user.id),
      service.getStats(user.id),
      service.modelSummary(user.id),
    ])
    return { instance, quota: service.resolveQuota(user.id), stats, modelSummary }
  })

  app.post(
    '/me/instance/start',
    { preHandler: requireUser },
    async (req, reply): Promise<InstanceActionResponse> => {
      const user = req.user!
      // 请求体可省略（唤醒页就是这样调）；给了 planId 时同时记住（13 §4、§6）
      const body = InstanceStartRequestSchema.parse(req.body ?? {})
      // 先校验/记住规格：已经在运行时 ensureRunning 会幂等返回，不能因此静默忽略不可选的 planId
      const compute = (deps as Partial<AppDeps>).services?.compute
      if (body.planId !== undefined) compute?.rememberPlan(user.id, body.planId)
      const alreadyRunning = service.currentStatus(user.id) === 'running'
      deps.logger.info({ userId: user.id }, '用户请求启动实例')
      const instance = await service.ensureRunning(user.id, {
        reason: 'user',
        ...(body.planId === undefined ? {} : { planId: body.planId }),
      })
      // 04 §3.1：已在运行直接 200，否则 202
      void reply.code(alreadyRunning ? 200 : 202)
      return { instance }
    },
  )

  app.post(
    '/me/instance/stop',
    { preHandler: requireUser },
    async (req, reply): Promise<InstanceActionResponse> => {
      const user = req.user!
      const instance = await service.stop(user.id, { reason: 'user' })
      void reply.code(202)
      return { instance }
    },
  )

  app.post(
    '/me/instance/restart',
    { preHandler: requireUser },
    async (req, reply): Promise<InstanceActionResponse> => {
      const user = req.user!
      const instance = await service.restart(user.id, { reason: 'user' })
      void reply.code(202)
      return { instance }
    },
  )

  /** SSE：`event: status`（04 §3.1） */
  app.get('/me/instance/events', { preHandler: requireUser }, async (req, reply): Promise<FastifyReply> => {
    const user = req.user!
    const stream = openSse(reply)
    const off = deps.events.on('instance.status', ({ userId, event }) => {
      if (userId === user.id) stream.send('status', event)
    })
    reply.raw.on('close', off)
    stream.send('status', { instance: await service.getSummary(user.id) })
    return reply
  })

  // ── 管理端实例（04 §4.3） ─────────────────────────────────────────────────

  app.get('/admin/instances', { preHandler: requireAdmin }, async (): Promise<AdminInstanceListResponse> => {
    const rows = await service.listForAdmin()
    // 每行带进行中的算力租约（13 §6）；compute 未装配时（只测实例模块）为 null
    const compute = (deps as Partial<AppDeps>).services?.compute
    const leases: Map<number, ComputeLease> = compute?.activeLeaseMap() ?? new Map()
    return rows.map((row) => ({
      user: row.user,
      instance: {
        status: row.status,
        runtimeVersion: row.runtimeVersion,
        startedAt: row.startedAt,
        lastActiveAt: row.lastActiveAt,
        needsRecreate: row.needsRecreate,
        error: row.error,
        openUrl: `/dsh/${row.user.username}/`,
      },
      stats: row.stats,
      // WP33：stats 只读后台采样器的缓存，statsAt 说明这份样本有多旧
      statsAt: row.statsAt,
      probe: row.probe,
      lease: leases.get(row.user.id) ?? null,
    }))
  })

  /**
   * stats 缓存快照（docs/22 §5.3；WP33）：前端每 10 s 轮询它填「资源」列，
   * 首屏不等 stats。只读缓存；缺样本时后台补一轮，接口本身不被 docker stats 拖慢。
   */
  app.get(
    '/admin/instances/stats',
    { preHandler: requireAdmin },
    async (): Promise<AdminInstanceStatsResponse> => {
      const rows = service.adminStatsSnapshot()
      if (rows.some((row) => row.stats === null)) service.kickStatsSample()
      return rows
    },
  )

  app.post(
    '/admin/instances/:userId/:action',
    { preHandler: requireAdmin },
    async (req, reply): Promise<InstanceActionResponse> => {
      const userId = parseUserId(req)
      const parsed = InstanceActionSchema.safeParse((req.params as { action?: string }).action)
      if (!parsed.success) {
        throw new HubError('VALIDATION_FAILED', '不支持的操作', {
          fields: { action: '只支持 start / stop / restart / recreate' },
        })
      }
      const action = parsed.data
      deps.logger.info({ actorId: req.user?.id, userId, action }, '管理员操作实例')
      const instance =
        action === 'start'
          ? await service.ensureRunning(userId, { reason: 'admin' })
          : action === 'stop'
            ? await service.stop(userId, { reason: 'admin' })
            : action === 'restart'
              ? await service.restart(userId, { reason: 'admin' })
              : await service.recreate(userId, { reason: 'admin' })
      void reply.code(202)
      return { instance }
    },
  )

  /** 日志（已脱敏：`token=***`，04 §4.3） */
  app.get('/admin/instances/:userId/logs', { preHandler: requireAdmin }, async (req) => {
    const userId = parseUserId(req)
    const query = InstanceLogsQuerySchema.parse(req.query)
    return { text: await service.logsFor(userId, query.tail) }
  })

  /** 日志流 SSE：`event: line`（04 §4.3） */
  app.get(
    '/admin/instances/:userId/logs/stream',
    { preHandler: requireAdmin },
    async (req, reply): Promise<FastifyReply> => {
      const userId = parseUserId(req)
      const stream = openSse(reply)
      const controller = new AbortController()
      reply.raw.on('close', () => controller.abort())
      void service.followLogsFor(userId, (line) => stream.send('line', { line }), controller.signal)
      return reply
    },
  )
}

/** 供其它模块（WP1 的概览）复用的类型别名 */
export type { InstanceStats, InstanceStatus }
export type InstancesRoutes = FastifyPluginAsync
