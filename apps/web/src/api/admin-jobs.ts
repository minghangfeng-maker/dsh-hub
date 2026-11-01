import {
  JobDetailResponseSchema,
  JobListResponseSchema,
  JobTaskLogResponseSchema,
  type JobAction,
  type JobDetailResponse,
  type JobListQuery,
  type JobListResponse,
  type JobTaskLogResponse,
} from '@dsh-hub/shared'

import { http } from './http'

/** `GET /api/admin/jobs`（任务中心列表）。 */
export function listJobs(query: Partial<JobListQuery> = {}): Promise<JobListResponse> {
  return http.get('/api/admin/jobs', { query, schema: JobListResponseSchema })
}

/** `GET /api/admin/jobs/:id`：任务 + task 表。 */
export function getJob(id: number): Promise<JobDetailResponse> {
  return http.get(`/api/admin/jobs/${id}`, { schema: JobDetailResponseSchema })
}

/** `GET /api/admin/jobs/:id/tasks/:taskId/log`。 */
export function getJobTaskLog(id: number, taskId: number): Promise<JobTaskLogResponse> {
  return http.get(`/api/admin/jobs/${id}/tasks/${taskId}/log`, { schema: JobTaskLogResponseSchema })
}

/** `GET /api/admin/jobs/:id/events`（SSE：job / task / log）。 */
export function jobEventsUrl(id: number): string {
  return `/api/admin/jobs/${id}/events`
}

/** `POST /api/admin/jobs/:id/{pause|resume|cancel|retry-failed}`。 */
export function jobAction(id: number, action: JobAction): Promise<void> {
  return http.post<void>(`/api/admin/jobs/${id}/${action}`)
}
