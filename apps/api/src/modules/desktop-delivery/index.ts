import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import {
  adminDesktopDeliveryPlugin,
  checkClientUpdatePlugin,
  desktopFeedPlugin,
  deviceDeliveryPlugin,
} from './routes.js'
import type { DesktopDeliveryService } from './types.js'

export * from './types.js'
export { createDesktopDeliveryService, compareSemver, matchesEtag } from './service.js'
export {
  adminDesktopDeliveryPlugin,
  checkClientUpdatePlugin,
  desktopFeedPlugin,
  deviceDeliveryPlugin,
  publicDesktopDownloadPlugin,
} from './routes.js'
export {
  artifactSignaturePayload,
  desktopArtifactSigningKey,
  isArtifactSignatureShape,
  signArtifact,
  verifyArtifactSignature,
} from './artifact-sign.js'
export {
  buildManifest,
  configDigestOf,
  effectiveFragments,
  effectivePlugins,
  feedFileOf,
  manifestEtagOf,
  publicizeRelayBaseUrls,
  releaseTargetOf,
  resolveAppPolicy,
  rolloutBucketOf,
} from './manifest.js'

/**
 * 桌面下发与升级模块（WP25b，D3）。四个注册前缀：
 * - `/api/desktop`（设备令牌）：`GET /manifest`、`GET /plugins/*`
 * - `/api/admin/desktop`（管理员）：下发、整包、安装包、强更地板
 * - `/desktop`（匿名）：feed YAML 与安装包（electron-updater 的 generic provider）
 * - `/api/v0`（匿名）：`GET /check_client_update`（上游壳的强更策略）
 *
 * 依赖顺序：`desktop`（设备表/令牌解析）与 `models`（模型预设渲染）必须已建好；
 * 本模块只在请求时读它们，不在构造时调用。
 */
export function desktopDeliveryModulePlugin(deps: BaseDeps): FastifyPluginAsync[] {
  const services = (deps as Partial<AppDeps>).services
  if (!services?.desktopDelivery) throw new HubError('INTERNAL', 'desktopDelivery service 未装配')
  const appDeps = deps as AppDeps
  return [
    deviceDeliveryPlugin(appDeps),
    adminDesktopDeliveryPlugin(appDeps),
    desktopFeedPlugin(appDeps),
    checkClientUpdatePlugin(appDeps),
  ]
}

export type { DesktopDeliveryService }
