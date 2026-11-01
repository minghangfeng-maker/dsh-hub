import { PluginInstallStatsResponseSchema, type PluginInstallStatsResponse } from '@dsh-hub/shared'

import { http } from './http'

/**
 * 插件安装统计（WP28c；契约 `packages/shared/src/api/delivery.ts`）：
 * `GET /api/admin/plugins/install-stats` 一次返回全部插件在**实例**（人数）与**桌面端**（设备数）的安装情况，
 * 插件库列表的「已安装」列与统一下发向导的「已安装用户」提示都用它。
 *
 * 一次取全量而不是每插件一个请求：插件库一页几十行，逐个请求会把列表拖慢。
 */
export function getPluginInstallStats(): Promise<PluginInstallStatsResponse> {
  return http.get('/api/admin/plugins/install-stats', { schema: PluginInstallStatsResponseSchema })
}
