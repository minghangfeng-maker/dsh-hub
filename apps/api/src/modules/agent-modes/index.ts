import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { createAgentModeRolloutHandler } from './job.js'
import { registerAgentModeRoutes } from './routes.js'
import type { AgentModesService } from './types.js'

export * from './types.js'
export { createAgentModesService } from './service.js'
export { createAgentModeRolloutHandler, AGENT_MODE_ROLLOUT_TYPE } from './job.js'
export type { AgentModeRolloutParams } from './job.js'
export { modeEnv, modesEnv, claudeRootUrl, codexBaseUrl, isTargeted } from './env.js'
export type { ModeEnvInput, ModeEnvResult, ModesEnvInput } from './env.js'
export { containerEnvApplied, applyAgentModeEnv } from './deliver.js'

/**
 * Claude Code / Codex 管理（18）。前缀 `/api/admin/agent-modes`：
 * `GET/PUT /:mode`、`POST /:mode/deliver`；另外注册 `rollout.agent-mode` 任务处理器。
 * 容器 env 通过 `models.attachAgentModeEnv` 晚绑定注入（见 service 尾部）。
 */
export function agentModesPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const service: AgentModesService | undefined = services?.agentModes
    if (!service) throw new HubError('INTERNAL', 'agent-modes service 未装配')
    registerAgentModeRoutes(app, deps, service)
    if (services?.jobs) {
      services.jobs.registerHandler(createAgentModeRolloutHandler(deps as AppDeps))
    }
  }
}
