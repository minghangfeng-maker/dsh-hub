import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import {
  CockpitBoardResponseSchema,
  CockpitCanvasListResponseSchema,
  CockpitCanvasPatchRequestSchema,
  CockpitCanvasQuerySchema,
  CockpitHandoffResponseSchema,
  CockpitProposalDecisionResponseSchema,
  CockpitProposalsQuerySchema,
  CockpitProposalsResponseSchema,
  CockpitSecretFillRequestSchema,
  CockpitSettingsRequestSchema,
  CockpitStatusStripResponseSchema,
  CockpitSourceRequestSchema,
  CockpitStateResponseSchema,
} from '@dsh-hub/shared'
import { requireAdmin, requestMeta } from '../../app.js'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { hasRecentReauth } from '../../lib/session.js'
import { openSse, pipeEvents } from '../../lib/sse.js'
import type { CockpitService } from './types.js'

/**
 * 管理员浏览器 → Hub 的 `/api/admin/cockpit/*`（docs/24 §3.2）。前缀由 `modules/index.ts` 给。
 *
 * 与经典管理端同款安全口径：cookie 会话 + `role=admin`（`requireAdmin`）+ 写操作要 `X-Hub-Csrf`
 * （主 app 的 CSRF 钩子已覆盖 `/api/*`）。R3 方案批准与改 `autoExecuteR1` 还要 `reauth`（10 分钟）。
 *
 * **I5**：方案只能从这里批准 —— `/ops/*` 没有、也不会有审批路由。
 */
export function cockpitAdminPlugin(deps: AppDeps, service: CockpitService): FastifyPluginAsync {
  return async (app) => {
    /**
     * 启动清扫（WP56e1）：方案执行是进程内 fire-and-forget，Hub 在两步之间重启会留下 `running` 的死方案。
     * 放在 `onReady`（所有插件装配完、库已迁移）—— 与 runtimes 的 `reconcileStaleBuilds` 同一个时机；
     * 清扫失败不能让 Hub 起不来，只记警告。
     */
    app.addHook('onReady', async () => {
      try {
        const fixed = service.reconcileInterruptedProposals()
        if (fixed.length > 0) {
          app.log.warn(
            { proposalIds: fixed },
            '发现上次进程留下的 running 方案，已标记为 failed（Hub 重启中断）',
          )
        }
      } catch (error) {
        app.log.warn({ err: error }, '座舱方案启动清扫失败，已跳过')
      }
    })
    /** 最近输过密码（窗口取 `settings.security.reauthMinutes`） */
    function assertReauth(req: FastifyRequest): void {
      const nowIso = deps.clock.nowIso()
      const minutes = deps.settings.get('security').reauthMinutes
      if (!req.user || !hasRecentReauth(req.user, nowIso, minutes)) throw new HubError('REAUTH_REQUIRED')
    }

    function actorOf(req: FastifyRequest): { id: number; username: string } {
      if (!req.user) throw new HubError('UNAUTHENTICATED')
      return { id: req.user.id, username: req.user.username }
    }

    // WP57：`?start=0` 只读状态、不自动拉起座舱容器（概览里的 AI 助手由管理员点「启动」）
    app.get('/state', { preHandler: requireAdmin }, async (req) => {
      const query = (req.query ?? {}) as Record<string, unknown>
      return CockpitStateResponseSchema.parse(await service.state({ autoStart: query['start'] !== '0' }))
    })

    // 状态条（§1）：运行实例/总数、今日中转站用量、失败任务、待确认方案
    app.get('/status-strip', { preHandler: requireAdmin }, async () =>
      CockpitStatusStripResponseSchema.parse(service.statusStrip()),
    )

    // SSE：连上先补发一次全量快照（§3.2 + WP56e1），之后只推增量事件
    app.get('/events', { preHandler: requireAdmin }, async (req, reply) => {
      const stream = openSse(reply)
      try {
        stream.send('ops.status', { type: 'ops.status', status: await service.status() })
        stream.send('strip.update', { type: 'strip.update', strip: service.statusStrip() })
        // WP56e1：刷新页面后要能重建「待确认」——方案靠 /proposals 也能拿到，密钥请求**没有列表接口**，
        // 不补发的话密钥卡只剩 requestId（拿不到用途/来源），所以两者都补。
        const snapshot = service.pendingSnapshot()
        for (const proposal of snapshot.proposals) {
          stream.send('proposal.upsert', { type: 'proposal.upsert', proposal })
        }
        for (const request of snapshot.secretRequests) {
          stream.send('secret.request', { type: 'secret.request', request })
        }
      } catch (error) {
        deps.logger.warn({ err: error }, '座舱状态读取失败（SSE 继续推事件）')
      }
      pipeEvents(stream, (send) => service.events.subscribe((event) => send(event.type, event)))
      return reply
    })

    app.post('/ops-instance/start', { preHandler: requireAdmin }, async (req) => {
      const status = await service.startOpsInstance(actorOf(req))
      return { status }
    })

    app.post('/ops-instance/restart', { preHandler: requireAdmin }, async (req) => {
      const status = await service.restartOpsInstance(actorOf(req))
      return { status }
    })

    app.put('/settings', { preHandler: requireAdmin }, async (req) => {
      const input = CockpitSettingsRequestSchema.parse(req.body ?? {})
      // 改「R1 自动执行」等于放开写操作的自动执行面，按敏感设置处理
      if (input.autoExecuteR1 !== undefined) assertReauth(req)
      return await service.updateSettings(input, actorOf(req))
    })

    app.post('/handoff', { preHandler: requireAdmin }, async (req) =>
      CockpitHandoffResponseSchema.parse(service.createHandoff(actorOf(req).id)),
    )

    app.get('/canvas', { preHandler: requireAdmin }, async (req) => {
      const query = CockpitCanvasQuerySchema.parse(req.query ?? {})
      return CockpitCanvasListResponseSchema.parse({ items: service.listCanvas(query.sessionId) })
    })

    app.get('/board', { preHandler: requireAdmin }, async () =>
      CockpitBoardResponseSchema.parse(await service.board()),
    )

    app.patch('/canvas/:id', { preHandler: requireAdmin }, async (req) => {
      const input = CockpitCanvasPatchRequestSchema.parse(req.body ?? {})
      return service.setCanvasFlags(stringIdParam(req), input)
    })

    app.delete('/canvas/:id', { preHandler: requireAdmin }, async (req, reply) => {
      service.removeCanvas(stringIdParam(req))
      return reply.code(204).send()
    })

    app.post('/source', { preHandler: requireAdmin }, async (req) => {
      const input = CockpitSourceRequestSchema.parse(req.body ?? {})
      return await service.source(input, actorOf(req))
    })

    app.get('/proposals', { preHandler: requireAdmin }, async (req) => {
      const query = CockpitProposalsQuerySchema.parse(req.query ?? {})
      return CockpitProposalsResponseSchema.parse({ items: service.listProposals(query) })
    })

    app.post('/proposals/:id/approve', { preHandler: requireAdmin }, async (req) => {
      const id = idParam(req)
      const proposal = service.getProposal(id)
      // R3（删用户、改密钥类…）要求 10 分钟内输过密码，沿用现有 reauth
      if (proposal.risk === 'R3') assertReauth(req)
      const view = await service.approveProposal(id, actorOf(req), requestMeta(req))
      return CockpitProposalDecisionResponseSchema.parse(view)
    })

    app.post('/proposals/:id/reject', { preHandler: requireAdmin }, async (req) =>
      CockpitProposalDecisionResponseSchema.parse(service.rejectProposal(idParam(req), actorOf(req))),
    )

    app.post('/secret-requests/:id', { preHandler: requireAdmin }, async (req, reply) => {
      const input = CockpitSecretFillRequestSchema.parse(req.body ?? {})
      service.fillSecretRequest(stringIdParam(req), input.value, actorOf(req))
      return reply.code(204).send()
    })

    app.delete('/secret-requests/:id', { preHandler: requireAdmin }, async (req, reply) => {
      service.cancelSecretRequest(stringIdParam(req), actorOf(req))
      return reply.code(204).send()
    })
  }
}

function idParam(req: FastifyRequest): number {
  const raw = (req.params as { id?: string }).id ?? ''
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new HubError('VALIDATION_FAILED', '方案 id 不合法')
  return id
}

function stringIdParam(req: FastifyRequest): string {
  const raw = (req.params as { id?: string }).id ?? ''
  if (raw.length === 0 || raw.length > 80) throw new HubError('VALIDATION_FAILED', 'id 不合法')
  return raw
}
