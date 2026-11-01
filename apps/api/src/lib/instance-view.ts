import type { InstanceSummary } from '@dsh-hub/shared'
import type { AppDeps } from '../context.js'

/**
 * 实例摘要的兜底（04 §0.1 `InstanceSummary`）。
 *
 * `instances` 服务归 WP2，WP1 落地时它还是「调用即抛 INTERNAL」的桩，而且 `instances` 表
 * 也不存在；账号域接口（`/api/auth/me`、管理端用户列表）不能因此挂掉，所以这里统一兜底：
 * 取不到就按「未创建」返回。WP2 合并后自然走真实数据，无需改账号域代码。
 */
export function absentInstanceSummary(username: string): InstanceSummary {
  return {
    status: 'absent',
    runtimeVersion: null,
    startedAt: null,
    lastActiveAt: null,
    needsRecreate: false,
    error: null,
    openUrl: `/dsh/${username}/`,
  }
}

export async function resolveInstanceSummary(
  deps: AppDeps,
  userId: number,
  username: string,
): Promise<InstanceSummary> {
  try {
    return await deps.services.instances.getSummary(userId)
  } catch (error) {
    if (!deps.testing) {
      deps.logger.debug({ err: error, userId }, '实例摘要不可用，按未创建处理')
    }
    return absentInstanceSummary(username)
  }
}
