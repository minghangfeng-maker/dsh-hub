import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import {
  COCKPIT_OPS_RATE_LIMIT_PER_MIN,
  OpsCallRequestSchema,
  OpsCatalogQuerySchema,
  OpsCanvasCreateRequestSchema,
  OpsCanvasPatchRequestSchema,
  OpsSecretRequestCreateSchema,
  OpsWaitQuerySchema,
} from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError, toHttpError } from '../../lib/errors.js'
import type { CockpitService } from './types.js'

/**
 * 座舱 DSH → Hub 的 `/ops/*`（docs/24 §3.1）：**只挂在内部监听器（10.213.0.1:7710）**。
 *
 * 鉴权是两道：`Authorization: Bearer <座舱令牌>` + 请求来源 IP 必须等于当前座舱容器 IP。
 * 两道都由 `OpsInstanceProbe.verify()` 回答（WP56b 的真实现里令牌每次启动重新生成）。
 * 失败一律 401 并记审计 `cockpit.ops-denied`（**不记令牌本身**）。
 *
 * 为什么是 Fastify 插件而不是直接挂在监听器的根实例上：preHandler/限流/错误处理都要
 * **封装**在 `/ops` 里，否则同一实例上的 `/v1/*`（中转站）也会被这套鉴权拦住。
 */
export function cockpitOpsPlugin(deps: AppDeps, service: CockpitService): FastifyPluginAsync {
  return async (app) => {
    // 内部监听器是独立实例，没有主 app 的 registerErrorHandler；这里补一份同形的
    app.setErrorHandler((error, request, reply) => {
      const { status, body } = toHttpError(error)
      if (status >= 500) request.log.error({ err: error }, '座舱 /ops 请求失败')
      void reply.code(status).send(body)
    })

    // 固定窗口限流（每分钟 120 次）：座舱插件是唯一调用方，进程内计数足够
    const window = { startedAt: Date.now(), count: 0 }
    function checkRateLimit(): void {
      const now = Date.now()
      if (now - window.startedAt >= 60_000) {
        window.startedAt = now
        window.count = 0
      }
      window.count += 1
      if (window.count > COCKPIT_OPS_RATE_LIMIT_PER_MIN) {
        throw new HubError(
          'RATE_LIMITED',
          `座舱接口每分钟最多 ${String(COCKPIT_OPS_RATE_LIMIT_PER_MIN)} 次调用`,
        )
      }
    }

    app.addHook('preHandler', async (req) => {
      checkRateLimit()
      const token = readBearer(req)
      const remoteIp = req.ip
      if (token === null || !service.probe.verify(token, remoteIp)) {
        deps.audit.log({
          actorId: null,
          actorIp: remoteIp,
          action: 'cockpit.ops-denied',
          targetType: 'cockpit-ops',
          targetId: pathOf(req),
          detail: { via: 'cockpit', reason: token === null ? 'missing-token' : 'token-or-ip-mismatch' },
        })
        throw new HubError('UNAUTHENTICATED', '座舱令牌无效或来源 IP 不匹配')
      }
    })

    app.get('/context', async () => await service.context())

    app.get('/catalog', async (req) => {
      const query = OpsCatalogQuerySchema.parse(req.query ?? {})
      return service.catalog(query)
    })

    app.post('/call', async (req) => {
      const input = OpsCallRequestSchema.parse(req.body ?? {})
      return await service.call(input, {
        ip: req.ip,
        userAgent: 'dshhub-ops-plugin',
        publicRequest: false,
      })
    })

    app.get('/proposals/:id', async (req) => {
      const { id } = idParams(req)
      const { waitSec } = OpsWaitQuerySchema.parse(req.query ?? {})
      return await service.waitProposal(id, waitSec)
    })

    app.post('/canvas', async (req) => {
      const input = OpsCanvasCreateRequestSchema.parse(req.body ?? {})
      return service.createCanvas(input, 'dsh')
    })

    app.patch('/canvas/:id', async (req) => {
      const id = canvasIdParams(req)
      const input = OpsCanvasPatchRequestSchema.parse(req.body ?? {})
      return service.patchCanvas(id, input)
    })

    app.post('/secret-requests', async (req) => {
      const input = OpsSecretRequestCreateSchema.parse(req.body ?? {})
      return service.createSecretRequest(input)
    })

    app.get('/secret-requests/:id', async (req) => {
      const id = stringIdParams(req)
      const { waitSec } = OpsWaitQuerySchema.parse(req.query ?? {})
      return await service.waitSecretRequest(id, waitSec)
    })
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/** `Authorization: Bearer <token>`；没有/格式不对返回 null */
export function readBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const matched = /^Bearer\s+(\S+)$/u.exec(header.trim())
  return matched?.[1] ?? null
}

function pathOf(req: FastifyRequest): string {
  return req.url.split('?')[0] ?? req.url
}

function idParams(req: FastifyRequest): { id: number } {
  const raw = (req.params as { id?: string }).id ?? ''
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new HubError('VALIDATION_FAILED', '方案 id 不合法')
  return { id }
}

function canvasIdParams(req: FastifyRequest): string {
  const raw = (req.params as { id?: string }).id ?? ''
  if (raw.length === 0 || raw.length > 80) throw new HubError('VALIDATION_FAILED', '画布卡 id 不合法')
  return raw
}

function stringIdParams(req: FastifyRequest): string {
  const raw = (req.params as { id?: string }).id ?? ''
  if (raw.length === 0 || raw.length > 80) throw new HubError('VALIDATION_FAILED', 'id 不合法')
  return raw
}
