import {
  AgentModeStateResponseSchema,
  DeliverAgentModeRequestSchema,
  JobRefSchema,
  type AgentModeStateResponse,
  type DeliverAgentModeRequest,
  type JobRef,
  type RelayAgentMode,
  type UpdateAgentModeRequest,
} from '@dsh-hub/shared'

import { http } from './http'

/**
 * 管理端「Claude Code」「Codex」两页的接口（18 §4.3）。
 *
 * 渠道、模型、用量沿用 `/api/admin/relay/*`（带 `scope`，见 `api/admin-relay.ts`）；
 * 这里只有模式自己的设置、用户表、待下发状态与下发任务。
 */

/** `GET /api/admin/agent-modes/:mode`：设置 + 插件 + 可选模型 + 用户表 + warnings。 */
export function getAgentMode(mode: RelayAgentMode): Promise<AgentModeStateResponse> {
  return http.get(`/api/admin/agent-modes/${mode}`, { schema: AgentModeStateResponseSchema })
}

/** `PUT /api/admin/agent-modes/:mode`：只改改过的字段，返回最新状态。 */
export function updateAgentMode(
  mode: RelayAgentMode,
  input: UpdateAgentModeRequest,
): Promise<AgentModeStateResponse> {
  return http.put(`/api/admin/agent-modes/${mode}`, { body: input, schema: AgentModeStateResponseSchema })
}

/** `POST /api/admin/agent-modes/:mode/deliver`（需要二次密码）：创建 `rollout.agent-mode` 任务。 */
export function deliverAgentMode(mode: RelayAgentMode, input: DeliverAgentModeRequest): Promise<JobRef> {
  return http.post(`/api/admin/agent-modes/${mode}/deliver`, { body: input, schema: JobRefSchema })
}

/** 下发请求的契约（表单侧用同一个 schema 做默认值校验） */
export { DeliverAgentModeRequestSchema }
