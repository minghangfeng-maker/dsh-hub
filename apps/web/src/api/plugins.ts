import {
  MyPluginsResponseSchema,
  PluginToggleResponseSchema,
  type MyPluginsResponse,
  type PluginToggleResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/** `GET /api/me/plugins`（04 §3.2，仅 `policy=optional` 且配额允许的可切换）。 */
export function fetchMyPlugins(): Promise<MyPluginsResponse> {
  return http.get('/api/me/plugins', { schema: MyPluginsResponseSchema })
}

/** `POST /api/me/plugins/:pluginId/install`（202 `{ jobId }`）。 */
export function installMyPlugin(pluginId: number): Promise<PluginToggleResponse> {
  return http.post(`/api/me/plugins/${pluginId}/install`, { schema: PluginToggleResponseSchema })
}

/** `POST /api/me/plugins/:pluginId/uninstall`（202 `{ jobId }`）。 */
export function uninstallMyPlugin(pluginId: number): Promise<PluginToggleResponse> {
  return http.post(`/api/me/plugins/${pluginId}/uninstall`, { schema: PluginToggleResponseSchema })
}
