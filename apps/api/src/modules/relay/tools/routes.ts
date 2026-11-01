import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  AddToolChannelKeysRequestSchema,
  AddToolChannelKeysResponseSchema,
  CreateToolChannelRequestSchema,
  MyToolsResponseSchema,
  TestToolChannelResponseSchema,
  ToolChannelListResponseSchema,
  ToolChannelResponseSchema,
  ToolOverviewResponseSchema,
  ToolSettingsResponseSchema,
  ToolUsageListResponseSchema,
  ToolUsageQuerySchema,
  UpdateToolChannelKeyRequestSchema,
  UpdateToolChannelRequestSchema,
  UpdateToolSettingsRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireUser } from '../../../app.js'
import type { BaseDeps } from '../../../context.js'
import { createWindowCounter } from '../../../lib/rate-limit.js'
import { extractRelayKey } from '../keys.js'
import { INVALID_KEY_LIMIT_PER_MINUTE, INTERNAL_LIMIT_PER_MINUTE } from '../routes-v1.js'
import type { RelayService } from '../types.js'
import type { ToolService } from './types.js'

/**
 * 搜索 / 抓取池的路由（14 §3）：`/v1/tools/{search,fetch}` 挂主应用与内部监听器，
 * 管理端 `/api/admin/tools/*`、用户端 `/api/me/tools*`。
 *
 * `/v1/tools/*` 与 `/v1/*` 一样不读 cookie、不受 CSRF/Origin 与强制改密影响（app.ts 的钩子只认 `/api`）。
 */

const IdParamsSchema = z.object({ id: z.coerce.number().int().positive() })
const KeyParamsSchema = IdParamsSchema.extend({ keyId: z.coerce.number().int().positive() })

/** `/v1/tools/*` 的错误体（14 §3.1）：`{"error":{"message","type","code"}}`，DSH 会把 message 拼进错误 */
function toolErrorBody(
  code: string,
  message: string,
): { error: { message: string; type: string; code: string } } {
  return { error: { message, type: errorType(code), code } }
}

function errorType(code: string): string {
  switch (code) {
    case 'invalid_api_key':
      return 'authentication_error'
    case 'permission_denied':
    case 'insufficient_points':
      return 'permission_error'
    case 'rate_limited':
      return 'rate_limit_error'
    case 'invalid_request':
      return 'invalid_request_error'
    case 'no_available_channel':
      return 'overloaded_error'
    default:
      return 'api_error'
  }
}

export interface ToolV1Options {
  /** 内部监听器实例：只挂 `/v1/tools/*`，并启用每 IP 总量限流 */
  internal: boolean
}

export function registerToolV1Routes(
  app: FastifyInstance,
  deps: BaseDeps,
  relay: RelayService,
  tools: ToolService,
  options: ToolV1Options,
): void {
  const invalidKeyLimit = createWindowCounter({
    capacity: INVALID_KEY_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    clock: deps.clock,
  })
  const internalLimit = createWindowCounter({
    capacity: INTERNAL_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    clock: deps.clock,
  })

  function sendError(reply: FastifyReply, status: number, code: string, message: string): void {
    void reply.code(status).send(toolErrorBody(code, message))
  }

  function authenticate(req: FastifyRequest, reply: FastifyReply): ReturnType<RelayService['authenticate']> {
    if (options.internal) {
      const gate = internalLimit.consume(req.ip ?? 'unknown')
      if (!gate.allowed) {
        void reply.header('retry-after', String(gate.retryAfterSec))
        sendError(reply, 429, 'rate_limited', '请求过于频繁')
        return null
      }
    }
    const secret = extractRelayKey(req.headers as Record<string, string | string[] | undefined>)
    if (!secret) {
      sendError(reply, 401, 'invalid_api_key', '密钥无效')
      return null
    }
    const auth = relay.authenticate(secret)
    if (!auth) {
      const decision = invalidKeyLimit.consume(req.ip ?? 'unknown')
      if (!decision.allowed) {
        void reply.header('retry-after', String(decision.retryAfterSec))
        sendError(reply, 429, 'rate_limited', '无效密钥尝试过多，稍后再试')
        return null
      }
      sendError(reply, 401, 'invalid_api_key', '密钥无效')
      return null
    }
    // 18 §3.2：`/v1/tools/*` 只给 dsh 作用域的密钥用；模式密钥用错入口 → 400
    if (auth.key.scope !== 'dsh') {
      const label = auth.key.scope === 'claude-code' ? 'Claude Code' : 'Codex'
      sendError(reply, 400, 'unsupported_endpoint', `这把密钥只能给 ${label} 用`)
      return null
    }
    return auth
  }

  async function handle(tool: 'search' | 'fetch', req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = authenticate(req, reply)
    if (!auth) return
    const body = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(reply, 400, 'invalid_request', '请求体必须是 JSON 对象')
      return
    }
    const outcome = await tools.forward(tool, body as Record<string, unknown>, auth)
    if (outcome.kind === 'error') {
      sendError(reply, outcome.status, outcome.code, outcome.message)
      return
    }
    void reply.code(200).header('content-type', 'application/json; charset=utf-8').send(outcome.body)
  }

  app.post('/v1/tools/search', async (req, reply) => handle('search', req, reply))
  app.post('/v1/tools/fetch', async (req, reply) => handle('fetch', req, reply))
}

/** 管理端搜索池路由。前缀 `/api/admin/tools`。 */
export function registerToolAdminRoutes(app: FastifyInstance, deps: BaseDeps, tools: ToolService): void {
  const admin = { preHandler: requireAdmin }

  app.get('/settings', admin, async () => ToolSettingsResponseSchema.parse(tools.settingsResponse()))

  app.patch('/settings', admin, async (req) => {
    const input = UpdateToolSettingsRequestSchema.parse(req.body ?? {})
    return ToolSettingsResponseSchema.parse(tools.updateSettings(input, req.user!.id, requestMeta(req)))
  })

  app.get('/overview', admin, async () => ToolOverviewResponseSchema.parse(tools.overview()))

  app.get('/channels', admin, async () => ToolChannelListResponseSchema.parse(tools.listChannels()))

  app.post('/channels', admin, async (req) => {
    const input = CreateToolChannelRequestSchema.parse(req.body)
    return ToolChannelResponseSchema.parse({
      channel: tools.createChannel(input, req.user!.id, requestMeta(req)),
    })
  })

  app.patch('/channels/:id', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = UpdateToolChannelRequestSchema.parse(req.body ?? {})
    return ToolChannelResponseSchema.parse({
      channel: tools.updateChannel(id, input, req.user!.id, requestMeta(req)),
    })
  })

  app.delete('/channels/:id', admin, async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params)
    tools.deleteChannel(id, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  app.post('/channels/:id/test', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    return TestToolChannelResponseSchema.parse(await tools.testChannel(id))
  })

  app.post('/channels/:id/keys', admin, async (req) => {
    const { id } = IdParamsSchema.parse(req.params)
    const input = AddToolChannelKeysRequestSchema.parse(req.body)
    return AddToolChannelKeysResponseSchema.parse(
      tools.addChannelKeys(id, input, req.user!.id, requestMeta(req)),
    )
  })

  app.patch('/channels/:id/keys/:keyId', admin, async (req) => {
    const { id, keyId } = KeyParamsSchema.parse(req.params)
    const input = UpdateToolChannelKeyRequestSchema.parse(req.body ?? {})
    return ToolChannelResponseSchema.parse({
      channel: tools.updateChannelKey(id, keyId, input, req.user!.id, requestMeta(req)),
    })
  })

  app.delete('/channels/:id/keys/:keyId', admin, async (req, reply) => {
    const { id, keyId } = KeyParamsSchema.parse(req.params)
    tools.deleteChannelKey(id, keyId, req.user!.id, requestMeta(req))
    return reply.code(204).send()
  })

  app.get('/usage', admin, async (req) => {
    const query = ToolUsageQuerySchema.parse(req.query)
    return ToolUsageListResponseSchema.parse(tools.usageList(query, { scope: 'admin' }))
  })

  void deps
}

/** 用户端搜索池路由。前缀 `/api/me/tools`。 */
export function registerToolMeRoutes(app: FastifyInstance, deps: BaseDeps, tools: ToolService): void {
  const user = { preHandler: requireUser }

  app.get('/', user, async (req) => MyToolsResponseSchema.parse(tools.myTools(req.user!.id)))

  app.get('/usage', user, async (req) => {
    const query = ToolUsageQuerySchema.parse(req.query)
    return ToolUsageListResponseSchema.parse(tools.usageList(query, { userId: req.user!.id, scope: 'user' }))
  })

  void deps
}
