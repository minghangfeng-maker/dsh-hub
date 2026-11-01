import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { DockerDriver } from './docker-driver.js'
import { FakeDriver } from './fake-driver.js'
import { registerInstanceRoutes } from './routes.js'
import {
  ATTACH_COLLABORATORS,
  createInstanceService,
  type InstanceCollaborators,
  type InternalInstanceService,
} from './service.js'
import { DEFAULT_ENV_ID } from './spec.js'
import type { ContainerDriver, InstanceService } from './types.js'

export { FakeDriver } from './fake-driver.js'
export { DockerDriver } from './docker-driver.js'
export * from './types.js'
export {
  ATTACH_COLLABORATORS,
  ATTACH_COMPUTE_HOOKS,
  createInstanceService,
  type InstanceCollaborators,
  type InternalInstanceService,
} from './service.js'
export {
  DEFAULT_AUTHORITY,
  MAX_COOKIE_TTL_MS,
  b64url,
  createDshCookieMinter,
  mintDshCookie,
  readBrowserSessionSecret,
} from './dsh-cookie.js'
export {
  DEFAULT_CONTAINER_PREFIX,
  DEFAULT_ENV_ID,
  LABEL_CONFIG_HASH,
  LABEL_ENV,
  LABEL_RUNTIME,
  LABEL_SLUG,
  LABEL_USER_ID,
  belongsToEnv,
  containerNameFor,
  computeConfigHash,
  imageForVersion,
} from './spec.js'

/**
 * instances 模块（04 §3.1 §4.3、05；WP2 实现）。
 * 路由分散在两个前缀下，所以本模块自己带前缀 `/api`：
 * `/api/me/instance{,/start,/stop,/restart,/events}`、`/api/admin/instances*`。
 */
export function instancesPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const instance = services?.instances as InternalInstanceService | undefined
    if (!instance) {
      // 只有 createServices 装配完成后才会注册模块；到这里说明接线错了
      throw new HubError('INTERNAL', 'instances service 未装配')
    }
    const collaborators = bindCollaborators(services)
    instance[ATTACH_COLLABORATORS](collaborators)

    // 启动时对账 + 每 60 秒对账/空闲回收（05 §6）。测试模式不自动起定时器：
    // 测试用可控时钟直接调 reconcileAll()/reapIdle()，避免真实定时器干扰。
    if (!deps.testing) {
      instance.startSchedulers()
      app.addHook('onClose', async () => {
        instance.stopSchedulers()
      })
    }

    registerInstanceRoutes(app, deps, instance)
  }
}

/**
 * 把 WP3 的 plugins/models 钩子接到实例服务上。
 * 用鸭子类型而不是直接 import：`models.containerEnv` 是 WP2 期望 WP3 提供的扩展方法，
 * 在 ModelService 的类型定稿前先做存在性判断，缺了就降级（bootstrap 跳过、模型 env 为空）。
 */
export function bindCollaborators(services: AppDeps['services'] | undefined): InstanceCollaborators {
  if (!services) return {}
  const models = services.models as typeof services.models & {
    containerEnv?: (userId: number) => Promise<Record<string, string>>
  }
  return {
    bootstrapUser: (userId, opts) =>
      services.plugins.bootstrapUser(userId, { restart: opts?.restart ?? 'next-start' }),
    renderManaged: (userId) => services.models.renderManaged(userId),
    containerEnv: (userId) =>
      typeof models.containerEnv === 'function' ? models.containerEnv(userId) : Promise.resolve({}),
    summaryForUser: (userId) => services.models.summaryForUser(userId),
  }
}

export function createInstanceServiceFactory(deps: BaseDeps): InstanceService {
  return createInstanceService(deps)
}

/**
 * 容器驱动工厂：`HUB_CONTAINER_DRIVER=fake` → `FakeDriver`（测试/无 Docker 开发），
 * 否则走 dockerode 的 `DockerDriver`（Docker Engine，也兼容 podman 的 Docker API 套接字）。
 */
export function createContainerDriver(config: {
  containerDriver: 'docker' | 'fake'
  dockerHost: string
  /** 本环境标识（`HUB_ENV_ID`；旧调用点没传时按 prod，保持向后兼容） */
  envId?: string
}): ContainerDriver {
  const envId = config.envId ?? DEFAULT_ENV_ID
  if (config.containerDriver === 'fake') return new FakeDriver({ envId })
  return new DockerDriver(config.dockerHost, { envId })
}
