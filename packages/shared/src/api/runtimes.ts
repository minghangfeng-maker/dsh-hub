import { z } from 'zod'
import { IsoDateTimeSchema } from '../common.js'

export const RuntimeStatusSchema = z.enum(['building', 'ready', 'failed', 'retired'])
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>

/** 04 §4.6 列表项 */
export const AdminRuntimeRowSchema = z.object({
  id: z.number().int(),
  dshVersion: z.string(),
  image: z.string(),
  status: RuntimeStatusSchema,
  isDefault: z.boolean(),
  sizeBytes: z.number().int().nullable(),
  usersOnIt: z.number().int(),
  createdAt: IsoDateTimeSchema,
  notes: z.string(),
})
export type AdminRuntimeRow = z.infer<typeof AdminRuntimeRowSchema>

export const RuntimeListResponseSchema = z.array(AdminRuntimeRowSchema)
export type RuntimeListResponse = z.infer<typeof RuntimeListResponseSchema>

// ── GET /api/admin/runtimes/available ───────────────────────────────────────

export const AvailableRuntimesResponseSchema = z.object({
  versions: z.array(z.string()),
  latest: z.string().nullable(),
  next: z.string().nullable(),
})
export type AvailableRuntimesResponse = z.infer<typeof AvailableRuntimesResponseSchema>

// ── POST /api/admin/runtimes ────────────────────────────────────────────────

export const CreateRuntimeRequestSchema = z.object({
  dshVersion: z.string().min(1).max(64),
  notes: z.string().max(500).optional(),
})
export type CreateRuntimeRequest = z.infer<typeof CreateRuntimeRequestSchema>

export const CreateRuntimeResponseSchema = z.object({
  runtime: AdminRuntimeRowSchema,
  jobId: z.number().int(),
})
export type CreateRuntimeResponse = z.infer<typeof CreateRuntimeResponseSchema>

// ── PATCH /api/admin/runtimes/:id ───────────────────────────────────────────

export const UpdateRuntimeRequestSchema = z.object({
  isDefault: z.literal(true).optional(),
  notes: z.string().max(500).optional(),
  status: z.literal('retired').optional(),
})
export type UpdateRuntimeRequest = z.infer<typeof UpdateRuntimeRequestSchema>
