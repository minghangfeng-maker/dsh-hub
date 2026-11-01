import { z } from 'zod'
import { EXPORT_FORMATS, EXPORT_PARTS } from '../constants.js'
import { IsoDateTimeSchema } from '../common.js'

/** 导出内容分区（04 §3.3） */
export const ExportPartSchema = z.enum(EXPORT_PARTS)
export type ExportPart = z.infer<typeof ExportPartSchema>

export const ExportFormatSchema = z.enum(EXPORT_FORMATS)
export type ExportFormat = z.infer<typeof ExportFormatSchema>

export const ExportStatusSchema = z.enum(['queued', 'running', 'ready', 'failed', 'expired'])
export type ExportStatus = z.infer<typeof ExportStatusSchema>

export const ExportProgressSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
  filesDone: z.number().int().nonnegative(),
  filesTotal: z.number().int().nonnegative(),
})
export type ExportProgress = z.infer<typeof ExportProgressSchema>

export const ExportItemSchema = z.object({
  id: z.number().int(),
  parts: z.array(ExportPartSchema),
  format: ExportFormatSchema,
  status: ExportStatusSchema,
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  /** 导出包整包的 sha256（hex）；未完成/已过期清理后可能为 null（04 §8 补充：E4 校验用） */
  sha256: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  downloaded: z.boolean(),
  error: z.string().nullable(),
  /** 进行中/刚完成时的进度，便于前端直接渲染列表 */
  progress: ExportProgressSchema.nullable(),
})
export type ExportItem = z.infer<typeof ExportItemSchema>

/** `?parts=workspace,sessions` 的解析 */
export function parseExportParts(value: string): ExportPart[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s): s is ExportPart => (EXPORT_PARTS as readonly string[]).includes(s))
}

// ── GET /api/me/exports/estimate ────────────────────────────────────────────

export const ExportEstimateQuerySchema = z.object({
  parts: z.string().default('workspace,sessions'),
})
export type ExportEstimateQuery = z.infer<typeof ExportEstimateQuerySchema>

export const ExportEstimateResponseSchema = z.object({
  parts: z.record(z.string(), z.object({ bytes: z.number().int(), files: z.number().int() })),
  totalBytes: z.number().int(),
})
export type ExportEstimateResponse = z.infer<typeof ExportEstimateResponseSchema>

// ── POST /api/me/exports ────────────────────────────────────────────────────

export const CreateExportRequestSchema = z.object({
  parts: z.array(ExportPartSchema).min(1, '至少选择一项内容'),
  format: ExportFormatSchema.default('zip'),
})
export type CreateExportRequest = z.infer<typeof CreateExportRequestSchema>

export const CreateExportResponseSchema = z.object({ export: ExportItemSchema })
export type CreateExportResponse = z.infer<typeof CreateExportResponseSchema>

// ── GET /api/me/exports ─────────────────────────────────────────────────────

export const ExportListResponseSchema = z.object({ items: z.array(ExportItemSchema) })
export type ExportListResponse = z.infer<typeof ExportListResponseSchema>

// ── GET /api/me/exports/:id/events（SSE） ───────────────────────────────────

export const ExportProgressEventSchema = ExportProgressSchema
export type ExportProgressEvent = z.infer<typeof ExportProgressEventSchema>

export const ExportDoneEventSchema = z.object({ export: ExportItemSchema })
export type ExportDoneEvent = z.infer<typeof ExportDoneEventSchema>

export const ExportFailedEventSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})
export type ExportFailedEvent = z.infer<typeof ExportFailedEventSchema>
