import {
  HealthResponseSchema,
  PublicSiteResponseSchema,
  type HealthResponse,
  type PublicSiteResponse,
} from '@dsh-hub/shared'
import { z } from 'zod'

import { http } from './http'

/**
 * 站点信息响应（04 §1）。
 *
 * 07 §5.1 规定：**只有 `caCertUrl` 非空**时才在登录页显示「安装根证书」提示（阶段一本地 http 没有自签证书）。
 * 契约（04/shared）里 `caCertUrl` 是 `string | null`：阶段一未开 TLS 网关时为 null。
 * 前端统一归一成字符串（`null | undefined → ''`），组件里只需判断非空。
 */
const SiteResponseSchema = PublicSiteResponseSchema.extend({
  caCertUrl: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => value ?? ''),
})

/** 前端使用的站点信息：`caCertUrl` 已归一为字符串（空串 = 没有根证书可下载）。 */
export type SiteInfo = Omit<PublicSiteResponse, 'caCertUrl'> & { caCertUrl: string }

/** `GET /api/public/site`（04 §1）：站点信息与注册策略，前端启动时拉一次。 */
export async function fetchPublicSite(): Promise<SiteInfo> {
  const site = await http.get('/api/public/site', { schema: SiteResponseSchema, authRedirect: false })
  return site
}

/** `GET /api/health`（04 §1）。 */
export function fetchHealth(): Promise<HealthResponse> {
  return http.get('/api/health', { schema: HealthResponseSchema, authRedirect: false })
}
