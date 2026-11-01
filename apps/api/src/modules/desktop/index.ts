import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { adminDesktopDevicesPlugin, desktopPlugin, meDesktopDevicesPlugin } from './routes.js'
import type { DesktopService } from './types.js'

export * from './types.js'
export { createDesktopService, newDeviceId, newDeviceToken, pkceChallengeOf, installKeyOf } from './service.js'
export { createPendingStore, type PendingStore, type PendingAuthRequest } from './pending.js'
export {
  DEVICE_TOKEN_ME_ALLOWLIST,
  isDesktopApiPath,
  isDeviceRouteAllowed,
  readDeviceBearer,
} from './policy.js'
export { desktopPlugin, meDesktopDevicesPlugin, adminDesktopDevicesPlugin } from './routes.js'

/**
 * 桌面端模块（WP25a）。三个注册前缀（见 routes.ts）：
 * `/api/desktop`（设备令牌）、`/api/me/desktop-devices`（用户）、`/api/admin/desktop-devices`（管理端）。
 *
 * 依赖顺序：`relay`（签发/吊销设备密钥）与 `agentModes`（模式是否开通）必须已建好 ——
 * 它们在 `createServices` 里排在本模块之前；本模块只在请求时调用它们。
 */
export function desktopModulePlugin(deps: BaseDeps): FastifyPluginAsync[] {
  const services = (deps as Partial<AppDeps>).services
  if (!services?.desktop) throw new HubError('INTERNAL', 'desktop service 未装配')
  return [desktopPlugin(deps as AppDeps), meDesktopDevicesPlugin(deps as AppDeps), adminDesktopDevicesPlugin(deps as AppDeps)]
}

export type { DesktopService }
