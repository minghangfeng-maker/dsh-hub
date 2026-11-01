import type { DeliveryCreatedResponse, DeliveryPreviewResponse, DeliveryRequest, PluginInstallStatsResponse } from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { executeDelivery } from './execute.js'
import { buildPreview, type PreviewDeps } from './preview.js'
import { buildInstallStats } from './stats.js'
import type { DeliveryDeps, DeliveryService } from './types.js'

/**
 * 统一下发服务（WP28a / docs/21）。三个入口：
 * - `preview`：只读的「会发生什么」；
 * - `create`：实例侧建 job（复用 rollouts）+ 桌面侧写期望状态（复用 desktop-delivery）；
 * - `installStats`：插件库的「已安装」列。
 *
 * 本模块**不拥有**表：实例期望状态归 plugins/runtimes/models，桌面期望状态与 revision 归
 * desktop-delivery；这里只做编排（CONTRIBUTING.md 的工程约定 的模块边界）。
 */
export function createDeliveryService(deps: DeliveryDeps): DeliveryService {
  const previewDeps: PreviewDeps = {
    ...deps,
    rolloutPreview: async (input, actorId) => {
      const rollouts = deps.services.rollouts
      if (!rollouts) throw new HubError('INTERNAL', 'rollouts service 未装配')
      return rollouts.preview(input, actorId)
    },
  }

  return {
    async preview(input: DeliveryRequest, actorId: number | null): Promise<DeliveryPreviewResponse> {
      void actorId
      return buildPreview(previewDeps, input)
    },
    async create(input: DeliveryRequest, actorId: number, meta: RequestMeta): Promise<DeliveryCreatedResponse> {
      return executeDelivery(previewDeps, input, actorId, meta)
    },
    async installStats(): Promise<PluginInstallStatsResponse> {
      return buildInstallStats(deps)
    },
  }
}
