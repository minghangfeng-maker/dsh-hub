import type {
  DeliveryCreatedResponse,
  DeliveryPreviewResponse,
  DeliveryRequest,
  PluginInstallStatsResponse,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'

/**
 * 统一下发模块（WP28a / docs/21）的类型面。
 *
 * 模块边界：本模块**不拥有**任何表 —— 实例侧的期望状态与任务归 `rollouts`/`plugins`/`runtimes`/`models`，
 * 桌面侧的期望状态与发布日志归 `desktop-delivery`；本模块只做「一次请求 → 多平台多内容项」的编排。
 */
export type DeliveryDeps = BaseDeps & { services: Partial<AppDeps['services']> }

export interface DeliveryService {
  /** `POST /api/admin/deliveries/preview`：只读，不建任务、不写期望状态、不产生 revision */
  preview(input: DeliveryRequest, actorId: number | null): Promise<DeliveryPreviewResponse>
  /** `POST /api/admin/deliveries`：实例侧每项一个 job；桌面侧一次提交一个 revision */
  create(input: DeliveryRequest, actorId: number, meta: RequestMeta): Promise<DeliveryCreatedResponse>
  /** `GET /api/admin/plugins/install-stats`：每个插件在实例与桌面端的安装人数（一条 SQL） */
  installStats(): Promise<PluginInstallStatsResponse>
}
