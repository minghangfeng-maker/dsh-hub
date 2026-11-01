import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { registerRolloutRoutes } from './routes.js'
import { createRolloutService } from './service.js'
import type { RolloutService } from './types.js'

export * from './types.js'
export { createRolloutService } from './service.js'

/**
 * rollouts 模块（04 §4.8；WP3 实现）。前缀 `/api/admin/rollouts`：
 * `POST /preview`（不执行）与 `POST /`（写期望状态 + 建 job，需 reauth）。
 * 三种 kind 的 JobHandler 分别注册在 plugins / runtimes / models 模块里。
 */
export function rolloutsPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const service = services?.rollouts
    if (!service) throw new HubError('INTERNAL', 'rollouts service 未装配')
    registerRolloutRoutes(app, deps, service)
  }
}

export function createRolloutServiceFactory(deps: BaseDeps): RolloutService {
  return createRolloutService(deps)
}
