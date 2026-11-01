import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { JobHandler } from '../jobs/types.js'
import { createRuntimeBuildHandler } from './build.js'
import { registerRuntimeRoutes } from './routes.js'
import { createRuntimeService } from './service.js'
import type { RuntimeService } from './types.js'

export * from './types.js'
export { createRuntimeService } from './service.js'
export { createRuntimeBuildHandler, RUNTIME_BUILD_TYPE, parseDshVersion } from './build.js'
export { fetchAvailableVersions, clearAvailableCache } from './available.js'

/**
 * runtimes 模块（04 §4.6；WP3 实现）。前缀 `/api/admin/runtimes`：
 * `GET /`、`GET /available`、`POST /`、`PATCH /:id`、`DELETE /:id`。
 * 同时注册 `runtime.build` 与 `rollout.runtime` 两个任务处理器（06 §3 §5.1）。
 */
export function runtimesPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const service = services?.runtimes
    if (!service) throw new HubError('INTERNAL', 'runtimes service 未装配')
    registerRuntimeRoutes(app, deps, service)
    // 启动对账（WP8b B2）：放在 onReady —— 那时所有插件（含 jobs 的重启恢复）都已加载完，
    // 才知道哪些构建任务「已经不在跑」。遗留的 building 不能删也不能重建，必须收尾。
    // 对账失败（例如库不可用）不能让 Hub 起不来，只记警告。
    app.addHook('onReady', async () => {
      try {
        const fixed = await service.reconcileStaleBuilds()
        if (fixed.length > 0) {
          app.log.warn({ runtimeIds: fixed }, '发现遗留的 building 版本，已置为 failed')
        }
      } catch (error) {
        app.log.warn({ err: error }, '构建遗留状态对账失败，已跳过')
      }
    })
    if (services?.jobs) {
      services.jobs.registerHandler(createRuntimeBuildHandler(deps as AppDeps))
      services.jobs.registerHandler(createRuntimeRolloutHandler(deps as AppDeps))
    }
  }
}

export function createRuntimeServiceFactory(deps: BaseDeps): RuntimeService {
  return createRuntimeService(deps)
}

// ── rollout.runtime 任务处理器（06 §3 §5.1） ────────────────────────────────

export interface RuntimeRolloutParams {
  runtimeId: number
  userIds: number[]
}

export const RUNTIME_ROLLOUT_TYPE = 'rollout.runtime'

/**
 * 每个用户一个 task：`runtimes.upgradeUser` 重建容器到新镜像，失败自动回滚并抛错
 * （抛错 = task 失败，引擎据此判金丝雀/失败率并暂停 job）。
 */
export function createRuntimeRolloutHandler(deps: AppDeps): JobHandler<RuntimeRolloutParams> {
  return {
    type: RUNTIME_ROLLOUT_TYPE,
    async plan(params) {
      const runtime = await deps.services.runtimes.get(params.runtimeId)
      return {
        title: `统一更新到 DSH ${runtime.dshVersion} · ${String(params.userIds.length)} 个用户`,
        tasks: params.userIds.map((userId) => ({ userId, payload: { userId } })),
      }
    },
    async runTask(ctx, task, params) {
      const userId = task.userId
      if (userId === null) throw new HubError('INTERNAL', '版本下发任务缺少 userId')
      const result = await deps.services.runtimes.upgradeUser(userId, params.runtimeId, { onLog: ctx.log })
      if (result.skipped) {
        ctx.log(result.error ?? '已跳过')
        return { userId, skipped: true }
      }
      if (!result.ok) {
        throw new HubError('UPSTREAM_ERROR', result.error ?? '升级失败', { rolledBack: result.rolledBack })
      }
      return { userId, runtimeId: params.runtimeId }
    },
  }
}
