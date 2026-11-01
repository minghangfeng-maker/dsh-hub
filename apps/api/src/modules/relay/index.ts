import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { isPublicRequest } from '../../server/public-request.js'
import { registerRelayAdminRoutes, registerRelayMeRoutes } from './routes-api.js'
import { registerRelayV1Routes, relaySourceFor, type RelayV1Options } from './routes-v1.js'
import { registerToolAdminRoutes, registerToolMeRoutes, registerToolV1Routes } from './tools/routes.js'

export { createRelayService, MAX_USER_KEYS, KEY_LAST_USED_THROTTLE_MS } from './service.js'
export { startRelayInternalListener, RELAY_LISTENER_RETRY_MS } from './internal-listener.js'
export type { RelayInternalListenerHandle, RelayInternalListenerOptions } from './internal-listener.js'
export { RELAY_BODY_LIMIT_BYTES, apiForPath, registerRelayV1Routes } from './routes-v1.js'
export type { RelayService, RelayAuthResult, RelayRenderModel } from './types.js'
export type { RelayProxyHost, RelayRecordInput } from './proxy.js'
export type { ToolService } from './tools/types.js'

/**
 * relay 模块的用户端路由（12 §9）。注册前缀 `/api/me/relay`：登录即可，
 * `MUST_CHANGE_PASSWORD` 规则与其它 `/api/me` 一致（app.ts 的钩子统一处理）。
 */
export function relayMePlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const service = (deps as Partial<AppDeps>).services?.relay
    if (!service) throw new HubError('INTERNAL', 'relay service 未装配')
    registerRelayMeRoutes(app, deps, service)
  }
}

/** relay 模块的管理端路由（12 §9）。注册前缀 `/api/admin/relay`：全部要 admin。 */
export function relayAdminPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const service = (deps as Partial<AppDeps>).services?.relay
    if (!service) throw new HubError('INTERNAL', 'relay service 未装配')
    registerRelayAdminRoutes(app, deps, service)
  }
}

/**
 * 主应用上的对外 `/v1`（12 §3）：7700 = local、7443 = public（用现有的「公网请求」标记区分）。
 * 内部监听器用 `registerRelayV1Routes(..., { internal: true })` 单独挂。
 */
export function relayV1Plugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const service = (deps as Partial<AppDeps>).services?.relay
    if (!service) throw new HubError('INTERNAL', 'relay service 未装配')
    const options: RelayV1Options = {
      internal: false,
      source: (req) => relaySourceFor(isPublicRequest(req)),
    }
    registerRelayV1Routes(app, deps, service, options)
  }
}

/** 搜索 / 抓取池的对外接口（14 §3）：`/v1/tools/*`，与 `/v1` 一样用 `sk-dsh-` 密钥鉴权。 */
export function relayToolsV1Plugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const service = (deps as Partial<AppDeps>).services?.relay
    if (!service) throw new HubError('INTERNAL', 'relay service 未装配')
    registerToolV1Routes(app, deps, service, service.tools, { internal: false })
  }
}

/** 搜索池管理端（14 §3.2）。注册前缀 `/api/admin/tools`。 */
export function relayToolsAdminPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const service = (deps as Partial<AppDeps>).services?.relay
    if (!service) throw new HubError('INTERNAL', 'relay service 未装配')
    registerToolAdminRoutes(app, deps, service.tools)
  }
}

/** 搜索池用户端（14 §3.2）。注册前缀 `/api/me/tools`。 */
export function relayToolsMePlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const service = (deps as Partial<AppDeps>).services?.relay
    if (!service) throw new HubError('INTERNAL', 'relay service 未装配')
    registerToolMeRoutes(app, deps, service.tools)
  }
}

/** 内部监听器上的搜索池接口（14 §3；与 `/v1` 同一个监听器）。 */
export function registerRelayToolsInternalRoutes(
  app: FastifyInstance,
  deps: BaseDeps,
  service: AppDeps['services']['relay'],
): void {
  registerToolV1Routes(app, deps, service, service.tools, { internal: true })
}
