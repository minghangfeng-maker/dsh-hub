import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { cockpitAdminPlugin } from './admin-routes.js'
import { createUnavailableOpsProbe, type OpsInstanceProbe } from './ops-probe.js'
import { cockpitOpsPlugin } from './ops-routes.js'
import { createCockpitService } from './service.js'
import type { CockpitService } from './types.js'

/**
 * 座舱模块入口（WP56a）。
 *
 * - `createCockpitServiceFactory`：由 `modules/index.ts` 装配（探针从 `deps.opsProbe` 取，
 *   WP56b 注入真实现、测试注入 `FakeOpsInstanceProbe`，都没有时用「容器尚未装配」的安全默认）。
 * - `cockpitAdminRoutes`：`/api/admin/cockpit/*`（cookie 会话）。
 * - `registerCockpitOpsRoutes`：`/ops/*`，由内部监听器挂（见 `modules/relay/internal-listener.ts`）。
 */
export * from './types.js'
export { FakeOpsInstanceProbe, createUnavailableOpsProbe } from './ops-probe.js'
export type { FakeOpsInstanceProbeOptions, OpsInstanceProbe } from './ops-probe.js'
export { createCockpitService } from './service.js'
export { cockpitAdminPlugin } from './admin-routes.js'
export { cockpitOpsPlugin } from './ops-routes.js'
export { createDefaultCapabilityRegistry, defaultCapabilities } from './capabilities/index.js'
export { redact, truncateResult, isSensitiveKey } from './capabilities/index.js'
export type { CapabilityDefinition, CapabilityRegistry } from './capabilities/index.js'

/** 装配 service（`deps.opsProbe` 是注入点：WP56b 的真实现 / 测试的假实现） */
export function createCockpitServiceFactory(deps: BaseDeps): CockpitService {
  const injected = (deps as BaseDeps & { opsProbe?: OpsInstanceProbe }).opsProbe
  return createCockpitService({
    deps,
    // 测试注入的假探针优先；否则用 WP56b 的真实现（座舱容器生命周期）；都没有才是「不可用」
    probe: injected ?? (deps as Partial<AppDeps>).services?.cockpitOps ?? createUnavailableOpsProbe(),
  })
}

/** 管理端路由插件（`/api/admin/cockpit`，前缀由 modules/index.ts 给） */
export function cockpitAdminRoutes(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const service = (deps as Partial<AppDeps>).services?.cockpit
    if (!service) throw new HubError('INTERNAL', 'cockpit service 未装配')
    await app.register(cockpitAdminPlugin(deps as AppDeps, service))
  }
}

/**
 * 把 `/ops/*` 挂到**内部监听器**上（docs/24 §2：只挂在 7710，公网入口没有这些路径）。
 * 内部监听器是独立 Fastify 实例，所以这里的 register 是异步的、不 await（监听器 `ready()` 时生效）。
 */
export function registerCockpitOpsRoutes(app: FastifyInstance, deps: BaseDeps): void {
  const service = (deps as Partial<AppDeps>).services?.cockpit
  if (!service) throw new HubError('INTERNAL', 'cockpit service 未装配')
  void app.register(cockpitOpsPlugin(deps as AppDeps, service), { prefix: '/ops' })
}
