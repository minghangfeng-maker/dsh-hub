import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AgentModeStateResponseSchema,
  DeliverAgentModeRequestSchema,
  JobRefSchema,
  RelayAgentModeSchema,
  UpdateAgentModeRequestSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireReauth } from '../../app.js'
import type { BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { AgentModesService } from './types.js'

const ModeParamsSchema = z.object({ mode: z.string() })

/** `:mode` 只认 claude-code / codex；其它一律 404（契约注释） */
function parseMode(params: unknown): ReturnType<typeof RelayAgentModeSchema.parse> {
  const { mode } = ModeParamsSchema.parse(params)
  const parsed = RelayAgentModeSchema.safeParse(mode)
  if (!parsed.success) throw new HubError('NOT_FOUND', '未知的对话模式')
  return parsed.data
}

/**
 * Claude Code / Codex 管理端（18 §4.3）。前缀 `/api/admin/agent-modes`：
 * GET/PUT 一个模式的状态、POST deliver 下发（需要二次密码，与其它下发一致）。
 */
export function registerAgentModeRoutes(
  app: FastifyInstance,
  deps: BaseDeps,
  service: AgentModesService,
): void {
  const admin = { preHandler: requireAdmin }

  app.get('/:mode', admin, async (req) => {
    const mode = parseMode(req.params)
    return AgentModeStateResponseSchema.parse(await service.state(mode))
  })

  app.put('/:mode', admin, async (req) => {
    const mode = parseMode(req.params)
    const input = UpdateAgentModeRequestSchema.parse(req.body ?? {})
    return AgentModeStateResponseSchema.parse(
      await service.update(mode, input, req.user!.id, requestMeta(req)),
    )
  })

  // 下发会改用户容器 env / 装插件，按 04 §4.8 需要二次验证
  app.post('/:mode/deliver', { preHandler: [requireAdmin, requireReauth()] }, async (req, reply) => {
    const mode = parseMode(req.params)
    const input = DeliverAgentModeRequestSchema.parse(req.body ?? {})
    const result = await service.deliver(mode, input, req.user!.id, requestMeta(req))
    return reply.code(202).send(JobRefSchema.parse(result))
  })

  void deps
}
