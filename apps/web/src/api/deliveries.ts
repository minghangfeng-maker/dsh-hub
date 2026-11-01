import {
  DeliveryCreatedResponseSchema,
  DeliveryPreviewResponseSchema,
  PluginInstallStatsResponseSchema,
  type DeliveryCreatedResponse,
  type DeliveryPreviewResponse,
  type DeliveryRequest,
  type PluginInstallStatsResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 统一下发（docs/21，契约 `packages/shared/src/api/delivery.ts`）。
 *
 * 三个接口：
 * - `POST /api/admin/deliveries/preview`：只读预览，「已安装」在这一步解析成明确的行；
 * - `POST /api/admin/deliveries`（**需 reauth**）：提交，实例侧每个内容项一个 job、桌面侧一个新 revision；
 * - `GET /api/admin/plugins/install-stats`：每个插件在实例 / 桌面端的安装人数（向导第 2 步的目标提示）。
 *
 * 旧接口（`/api/admin/rollouts*`、`/api/admin/desktop/*`）**保持不变**，统一下发是在它们之上的编排层：
 * 桌面端页与「模型 → 下发到 DSH」仍然直接调用旧接口，只有「下发」入口走这里。
 */

/** `POST /api/admin/deliveries/preview`：预览会不会执行、跳过的原因（不改任何状态）。 */
export function previewDelivery(input: DeliveryRequest): Promise<DeliveryPreviewResponse> {
  return http.post('/api/admin/deliveries/preview', {
    body: input,
    schema: DeliveryPreviewResponseSchema,
  })
}

/** `POST /api/admin/deliveries`（**需 reauth**）→ `202 { jobs, desktop, skippedItems }`。 */
export function createDelivery(input: DeliveryRequest): Promise<DeliveryCreatedResponse> {
  return http.post('/api/admin/deliveries', {
    body: input,
    schema: DeliveryCreatedResponseSchema,
  })
}

/** `GET /api/admin/plugins/install-stats`：插件库「已安装」列与向导「已安装用户」的人数。 */
export function getPluginInstallStats(): Promise<PluginInstallStatsResponse> {
  return http.get('/api/admin/plugins/install-stats', { schema: PluginInstallStatsResponseSchema })
}
