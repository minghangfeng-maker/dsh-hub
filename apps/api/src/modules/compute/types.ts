import type {
  ComputeLease,
  ComputeLeaseListResponse,
  ComputeLeaseQuery,
  ComputeSettings,
  ComputeSettingsResponse,
  MyComputeResponse,
  SelectComputePlanResponse,
  UpdateComputeSettingsRequest,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import type { ComputeHooks } from '../instances/types.js'

/**
 * 算力租赁服务（13）。`ComputeHooks` 是 instances 模块晚绑定调用的那组钩子；
 * 本接口在它之上再加用户/管理端查询、设置与 `tick`。
 */
export interface ComputeService extends ComputeHooks {
  // ── 设置（13 §6）─────────────────────────────────────────────────────────
  getSettings(): ComputeSettings
  /** `{ settings, host }`（host.memTotalMb 读 /proc/meminfo；读不到 = 0） */
  settingsResponse(): Promise<ComputeSettingsResponse>
  updateSettings(
    patch: UpdateComputeSettingsRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<ComputeSettingsResponse>

  // ── 用户端 / 管理端（13 §6）───────────────────────────────────────────────
  /** `GET /api/me/compute` 的数据；调用方先触发每日赠送 */
  myCompute(userId: number): MyComputeResponse
  /** 触发每日赠送（GET /api/me/compute；13 §2.3）；返回本次发放额 */
  grantDailyBonus(userId: number): number
  listMyLeases(userId: number, query: ComputeLeaseQuery): ComputeLeaseListResponse
  listAdminLeases(query: ComputeLeaseQuery): ComputeLeaseListResponse
  /** 换规格：停止中只记住；运行中先准入再重建，`restarted` 表示是否真的重启了 */
  selectPlan(userId: number, planId: string): Promise<SelectComputePlanResponse>
  /** 只校验并记住规格（`POST /api/me/instance/start` 带 planId 时用） */
  rememberPlan(userId: number, planId: string): void

  // ── 租约 ──────────────────────────────────────────────────────────────────
  activeLeaseOf(userId: number): ComputeLease | null
  /** 管理端实例列表用：userId → 进行中租约 */
  activeLeaseMap(): Map<number, ComputeLease>

  // ── 定时结算（13 §3）──────────────────────────────────────────────────────
  /** 每 30 秒一轮；串行（上一轮没结束就复用同一个 Promise）。测试里手动调用 */
  tick(): Promise<void>
  startScheduler(): void
  stopScheduler(): void
}
