import type { RolloutPreviewRequest, RolloutPreviewResponse, RolloutRequest } from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'

/**
 * 下发任务（rollout）服务（04 §4.8、06 §5.1；WP3 实现）。
 * 流程：解析 targets（金丝雀在前）→ 写期望状态 → 建 job + tasks → 交给 jobs 引擎。
 */
export interface RolloutService {
  /** 预览：每个目标用户「当前 → 之后」与是否重启（不执行、不落库） */
  preview(input: RolloutPreviewRequest, actorId?: number | null): Promise<RolloutPreviewResponse>
  /** 创建下发任务 → `202 { jobId }`；需 reauth（路由层保证） */
  create(
    input: RolloutRequest,
    actorId: number,
    meta: RequestMeta,
    opts?: { source?: 'admin' | 'user' },
  ): Promise<{ jobId: number }>
  /** 解析 targets → 用户 id 列表（排除已删除；disabled 也执行但不启动实例） */
  resolveTargets(input: RolloutRequest): Promise<number[]>
}
