import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { ATTACH_COMPUTE_HOOKS, type InternalInstanceService } from '../instances/index.js'
import { registerComputeRoutes } from './routes.js'

export { createComputeService, COMPUTE_TICK_INTERVAL_MS } from './service.js'
export type { ComputeService } from './types.js'

/**
 * compute 模块（13）。注册前缀 `/api`：同时服务 `/api/me/compute*` 与 `/api/admin/compute/*`。
 *
 * 这里把算力钩子晚绑定到 instances 服务上（13 §4）；`testing` 下不自动跑 30 秒 tick，
 * 测试用可控时钟直接调 `service.tick()`（与 instances 的定时器约定一致）。
 */
export function computePlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const service = services?.compute
    if (!service) throw new HubError('INTERNAL', 'compute service 未装配')
    const instances = services?.instances as InternalInstanceService | undefined
    if (!instances) throw new HubError('INTERNAL', 'instances 服务未装配')
    instances[ATTACH_COMPUTE_HOOKS](service)

    if (!deps.testing) {
      service.startScheduler()
      app.addHook('onClose', async () => {
        service.stopScheduler()
      })
    }

    registerComputeRoutes(app, deps, service)
  }
}
