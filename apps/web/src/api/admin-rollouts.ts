import {
  RolloutCreatedResponseSchema,
  RolloutPreviewResponseSchema,
  type RolloutCreatedResponse,
  type RolloutPreviewRequest,
  type RolloutPreviewResponse,
  type RolloutRequest,
} from '@dsh-hub/shared'

import { http } from './http'

/** `POST /api/admin/rollouts/preview`：预览「当前 → 之后」与是否重启（不执行）。 */
export function previewRollout(input: RolloutPreviewRequest): Promise<RolloutPreviewResponse> {
  return http.post('/api/admin/rollouts/preview', {
    body: input,
    schema: RolloutPreviewResponseSchema,
  })
}

/** `POST /api/admin/rollouts`（**需 reauth**）→ `202 { jobId }`。 */
export function createRollout(input: RolloutRequest): Promise<RolloutCreatedResponse> {
  return http.post('/api/admin/rollouts', { body: input, schema: RolloutCreatedResponseSchema })
}
