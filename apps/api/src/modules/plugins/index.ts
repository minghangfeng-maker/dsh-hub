import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { runOutsideLocks } from '../../lib/locks.js'
import { createPluginRolloutHandler } from './job.js'
import { registerPluginRoutes } from './routes.js'
import { createPluginService } from './service.js'
import type { PluginService } from './types.js'

export * from './types.js'
export { createPluginService } from './service.js'
export { createPluginRolloutHandler, PLUGIN_ROLLOUT_TYPE, type PluginRolloutParams } from './job.js'
export { applyPackageChanges, FACTORY_BUNDLES, readManaged, orderBundles } from './package-json.js'
export { scanDirectory, scanText } from './secret-scan.js'
export { createPluginInstaller } from './installer.js'

/**
 * plugins 模块（04 §3.2 §4.5；WP3 实现）。前缀 `/api`：
 * `/api/admin/plugins*`（目录、版本、lookup、装机情况）与 `/api/me/plugins*`（用户自助）。
 *
 * 这里额外做一件事：订阅 `instance.status`，在实例**就绪**后排队一次 required 插件对账
 * （06 §2.2「即使在 DSH 自己的插件管理里删掉，下次对账也会装回来」）。订阅用事件总线而不是改
 * WP2 的实例代码（模块边界，11 §4.7）；对账在用户锁里排队执行，不会和启动流程抢 profile。
 */
export function pluginsPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const service = services?.plugins
    if (!service) throw new HubError('INTERNAL', 'plugins service 未装配')

    registerPluginRoutes(app, deps, service)

    const full = deps as AppDeps
    if (services?.jobs) {
      services.jobs.registerHandler(createPluginRolloutHandler(full))
    }
    const off = deps.events.on('instance.status', ({ userId, event }) => {
      // 这个事件是在实例服务**持锁期间**同步发出的；监听器里派生的后台任务必须洗掉持锁令牌，
      // 否则它会「重入」跳过用户锁，与后续任务并发改 profile（见 lib/locks.ts 的 runOutsideLocks）
      if (event.phase === 'ready') runOutsideLocks(async () => service.scheduleReconcile(userId))
    })
    app.addHook('onClose', async () => {
      off()
    })
  }
}

export function createPluginServiceFactory(deps: BaseDeps): PluginService {
  return createPluginService(deps)
}
