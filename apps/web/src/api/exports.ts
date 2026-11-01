import {
  CreateExportResponseSchema,
  ExportEstimateResponseSchema,
  ExportListResponseSchema,
  type CreateExportRequest,
  type CreateExportResponse,
  type ExportEstimateResponse,
  type ExportListResponse,
  type ExportPart,
} from '@dsh-hub/shared'

import { http, withQuery } from './http'

/** `GET /api/me/exports/estimate?parts=workspace,sessions`（04 §3.3，du 估算，缓存 60s）。 */
export function estimateExport(parts: readonly ExportPart[]): Promise<ExportEstimateResponse> {
  return http.get(withQuery('/api/me/exports/estimate', { parts: parts.join(',') }), {
    schema: ExportEstimateResponseSchema,
  })
}

/** `POST /api/me/exports`（202）。 */
export function createExport(input: CreateExportRequest): Promise<CreateExportResponse> {
  return http.post('/api/me/exports', { body: input, schema: CreateExportResponseSchema })
}

/** `GET /api/me/exports`（最近 20 条）。 */
export function listExports(): Promise<ExportListResponse> {
  return http.get('/api/me/exports', { schema: ExportListResponseSchema })
}

/** `GET /api/me/exports/:id/events`（SSE：progress / done / failed）。 */
export function exportEventsUrl(id: number): string {
  return `/api/me/exports/${id}/events`
}

/** `GET /api/me/exports/:id/download`：直接交给 `<a href>` / `location.assign`，支持 Range 续传。 */
export function exportDownloadUrl(id: number): string {
  return `/api/me/exports/${id}/download`
}

/** `DELETE /api/me/exports/:id`（204）。 */
export function removeExport(id: number): Promise<void> {
  return http.delete<void>(`/api/me/exports/${id}`)
}
