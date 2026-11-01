import type { JobHandler } from '../jobs/types.js'
import type { AppDeps } from '../../context.js'
import { getUser } from './repo.js'
import type { ExportJobParams } from './types.js'

/**
 * `export` 类型任务的处理器（06 §5.2 §6）：单 task，真正的打包在
 * `services.exports.run()` 里（那里才有路径/设置/事件总线）。
 *
 * `maxConcurrent` 取 `capacity.maxConcurrentExports`（默认 2）：导出很吃磁盘 IO，
 * 不跟其它任务抢满全局并发 4。
 */
export function createExportJobHandler(deps: AppDeps): JobHandler<ExportJobParams> {
  return {
    type: 'export',
    maxConcurrent: () => Math.max(1, deps.settings.get('capacity').maxConcurrentExports),

    async plan(params) {
      const user = getUser(deps.db, params.userId)
      return {
        title: `导出数据 · ${user?.username ?? params.userId}`,
        tasks: [
          {
            userId: params.userId,
            // 每任务的 payload 里固化 DSH 版本（manifest 用），避免打包时再查
            payload: { ...params, dshVersion: await resolveDshVersion(deps, params.userId) },
          },
        ],
      }
    },

    async runTask(ctx, task, params) {
      const payload = isExportJobParams(task.payload) ? task.payload : params
      return deps.services.exports.run(payload, ctx)
    },
  }
}

/** 尽力而为：DSH 版本来自实例域（WP2），取不到就写 null，不影响导出 */
async function resolveDshVersion(deps: AppDeps, userId: number): Promise<string | null> {
  try {
    const summary = await deps.services.instances.getSummary(userId)
    return summary.runtimeVersion ?? null
  } catch {
    return null
  }
}

function isExportJobParams(value: unknown): value is ExportJobParams {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ExportJobParams>
  return typeof candidate.exportId === 'number' && typeof candidate.userId === 'number'
}
