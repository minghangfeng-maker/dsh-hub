import { z } from 'zod'
import { AnnouncementLevelSchema, RegistrationModeSchema } from '../common.js'

// ── GET /api/public/site ────────────────────────────────────────────────────

export const PublicSiteResponseSchema = z.object({
  name: z.string(),
  tagline: z.string(),
  announcement: z.string(),
  announcementLevel: AnnouncementLevelSchema,
  registrationMode: RegistrationModeSchema,
  requireApproval: z.boolean(),
  /** 自签根证书下载地址；未启用 TLS 网关（阶段一，`HUB_TLS_PORT=0`）时为 null，前端据此隐藏证书提示 */
  caCertUrl: z.string().nullable(),
})
export type PublicSiteResponse = z.infer<typeof PublicSiteResponseSchema>

// ── GET /api/health ─────────────────────────────────────────────────────────

/**
 * 注意：04 §1 只写了 `{ ok, version, db, docker }`，值的取值在此定稿：
 * `db: 'ok'|'error'`；`docker: 'ok'|'error'|'disabled'`（`HUB_CONTAINER_DRIVER=fake` 时）
 * 网关（7443/7080）上只返回 `{ ok }`，细节只在回环明文监听器返回。
 */
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.enum(['ok', 'error']),
  docker: z.enum(['ok', 'error', 'disabled']),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

/** 网关上的精简版 */
export const HealthLiteResponseSchema = z.object({ ok: z.boolean() })
export type HealthLiteResponse = z.infer<typeof HealthLiteResponseSchema>
