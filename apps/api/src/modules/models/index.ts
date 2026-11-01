import type { FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { JobHandler } from '../jobs/types.js'
import { registerModelRoutes } from './routes.js'
import { createModelService } from './service.js'
import type { ModelService } from './types.js'

export * from './types.js'
export { createModelService } from './service.js'
export {
  RESERVED_ENTRY_IDS,
  WORKSPACE_CONTROLLER_ENTRY,
  buildManifest,
  modelEntries,
  providerEntryConfig,
  renderManagedPatch,
  type RenderManagedInput,
  type RenderManagedOutput,
} from './render.js'
export { parsePatchEntries, renderPatchEntryBlocks, validateConfigYaml } from './patch-entries.js'

/**
 * models 模块（04 §4.7；WP3 实现）。前缀 `/api/admin/models`：
 * `/providers*`（含 `/test`、`/discover`、`/user-keys/:userId`）与 `/presets*`（含 `/preview`）。
 */
export function modelsPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const service = services?.models
    if (!service) throw new HubError('INTERNAL', 'models service 未装配')
    registerModelRoutes(app, deps, service)
    if (services?.jobs) {
      services.jobs.registerHandler(createModelsRolloutHandler(deps as AppDeps))
    }
  }
}

export function createModelServiceFactory(deps: BaseDeps): ModelService {
  return createModelService(deps)
}

// ── rollout.models 任务处理器（06 §5.1） ────────────────────────────────────

export interface ModelsRolloutParams {
  /** `null` = 不改用户预设，只按最新配置重渲染（04 §10.6）；数字 = 钉到该预设 */
  presetId: number | null
  userIds: number[]
  /** 04 §9.5：`next-start` 由执行器落实（只落盘，不立刻重启/重建） */
  restart?: 'now' | 'next-start'
}

export const MODELS_ROLLOUT_TYPE = 'rollout.models'

/**
 * 每个用户一个 task：重渲染 managed.patch.yml，并按 env 是否变化决定重启还是重建容器。
 * 期望状态（`users.model_preset_id`）由 rollouts 服务在创建 job 前写好。
 */
export function createModelsRolloutHandler(deps: AppDeps): JobHandler<ModelsRolloutParams> {
  return {
    type: MODELS_ROLLOUT_TYPE,
    async plan(params) {
      return {
        title: `下发模型配置 · ${String(params.userIds.length)} 个用户`,
        tasks: params.userIds.map((userId) => ({ userId, payload: { userId } })),
      }
    },
    async runTask(ctx, task, params) {
      const userId = task.userId
      if (userId === null) throw new HubError('INTERNAL', '模型下发任务缺少 userId')
      // null = 请求里省略了 presetId（04 §10.6）→ 不改用户预设，只按最新配置重渲染
      await deps.services.models.applyForUser(userId, params.presetId ?? undefined, {
        onLog: ctx.log,
        restart: params.restart ?? 'now',
      })
      return { userId, presetId: params.presetId }
    },
  }
}
