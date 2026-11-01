import type { FastifyPluginAsync } from 'fastify'
import type { BaseDeps } from '../../context.js'
import { createDeliveryService } from './service.js'
import { deliveriesPlugin, installStatsPlugin } from './routes.js'
import type { DeliveryService } from './types.js'

export * from './types.js'
export { createDeliveryService } from './service.js'
export { deliveriesPlugin, installStatsPlugin } from './routes.js'
export { buildPreview, DELIVERY_PREVIEW_MAX_ROWS } from './preview.js'
export { buildInstallStats } from './stats.js'
export {
  buildPlan,
  resolveDesktopSide,
  resolveInstanceSide,
  satisfiesMinDsh,
  isParsableVersion,
} from './resolve.js'

/** 统一下发模块（WP28a）：service 工厂 + 两组路由（`/api/admin/deliveries*` 与 `install-stats`） */
export function createDeliveryServiceFactory(deps: BaseDeps): DeliveryService {
  return createDeliveryService(deps as Parameters<typeof createDeliveryService>[0])
}

/** 供 `modules/index.ts` 直接使用的两组插件工厂（路由挂在不同前缀下） */
export function deliveryPlugins(deps: BaseDeps): {
  deliveries: FastifyPluginAsync
  installStats: FastifyPluginAsync
} {
  const typed = deps as Parameters<typeof deliveriesPlugin>[0]
  return { deliveries: deliveriesPlugin(typed), installStats: installStatsPlugin(typed) }
}
