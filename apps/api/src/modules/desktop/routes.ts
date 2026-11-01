import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  DEVICE_BODY_LIMIT_BYTES,
  DesktopAgentModeKeyRequestSchema,
  DesktopAuthStartRequestSchema,
  DesktopAuthTokenRequestSchema,
  DesktopAuthorizeDecisionSchema,
  DesktopBatchRevokeRequestSchema,
  DesktopBatchRevokeResponseSchema,
  DesktopDeviceDetailResponseSchema,
  DesktopDeviceListQuerySchema,
  DesktopDeviceReportRequestSchema,
  DesktopDeviceRevokeResponseSchema,
  DesktopRenameDeviceRequestSchema,
  DesktopRenameDeviceResponseSchema,
  DesktopSessionResponseSchema,
  DeviceIdSchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin, requireReauth, requireUser } from '../../app.js'
import type { AppDeps } from '../../context.js'
import { requestOrigin } from '../../server/public-request.js'
import { HubError } from '../../lib/errors.js'
import type { DesktopPrincipal, DesktopService } from './types.js'

/** 路径参数：设备标识 / 登录请求 id */
const RequestIdParamSchema = z.object({ id: z.string().min(1).max(64) })
const DeviceIdParamSchema = z.object({ id: DeviceIdSchema })

/** 过期设备令牌清理间隔：每小时一次（与回收站、中转站用量清理同频） */
const TOKEN_CLEANUP_INTERVAL_MS = 3_600_000

/**
 * 桌面端点（WP25a）。三个注册前缀，三套鉴权：
 * - `/api/desktop/*`：设备令牌（Bearer `dsh_dev_…`）；`auth/start` 与 `auth/token` 免登录，
 *   `auth/requests/*` 要网页会话（授权页）；不校验 Origin（裁决 #6）。
 * - `/api/me/desktop-devices*`：网页会话（用户看/吊销自己的设备）。
 * - `/api/admin/desktop-devices*`：管理员。
 */
export function desktopPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDesktopService(deps)

    // 过期设备令牌清理（WP25e 交付物 9）：onReady 跑一次 + 每小时一次；
    // 定时器 unref（不拖住进程退出），onClose 清掉（参考 admin-users 的回收站清理）
    const sweepTokens = (): void => {
      try {
        service.cleanupExpiredTokens()
      } catch (error) {
        app.log.warn({ err: error }, '过期桌面设备令牌清理失败')
      }
    }
    const sweepTimer = setInterval(sweepTokens, TOKEN_CLEANUP_INTERVAL_MS)
    sweepTimer.unref?.()
    app.addHook('onReady', () => {
      sweepTokens()
    })
    app.addHook('onClose', () => {
      clearInterval(sweepTimer)
    })

    /** 设备令牌必须存在（app.ts 已解析；这里只做「这条路由确实要用设备身份」的断言） */
    function principalOf(req: FastifyRequest): DesktopPrincipal {
      if (!req.desktop || !req.user) throw new HubError('DEVICE_TOKEN_INVALID')
      return { user: req.user, device: req.desktop }
    }

    // ── 登录：免登录 ───────────────────────────────────────────────────────
    app.post('/auth/start', async (req) =>
      service.start(
        DesktopAuthStartRequestSchema.parse(req.body ?? {}),
        requestMeta(req),
        requestOrigin(req, deps.config),
      ),
    )

    app.post('/auth/token', async (req) =>
      service.exchange(DesktopAuthTokenRequestSchema.parse(req.body ?? {}), requestMeta(req)),
    )

    // ── 授权页（网页会话）：取数 + 允许/拒绝 ────────────────────────────────
    app.get('/auth/requests/:id', { preHandler: requireUser }, async (req) => {
      const { id } = RequestIdParamSchema.parse(req.params ?? {})
      return service.view(id, req.user!)
    })

    for (const [verb, allow] of [
      ['approve', true],
      ['deny', false],
    ] as const) {
      app.post(`/auth/requests/:id/${verb}`, { preHandler: requireUser }, async (req) => {
        const { id } = RequestIdParamSchema.parse(req.params ?? {})
        const input = DesktopAuthorizeDecisionSchema.parse(req.body ?? {})
        // 路径语义优先：approve 一定是允许、deny 一定是拒绝（body 的 allow 只用于校验一致性）
        if (input.allow !== allow) {
          throw new HubError('VALIDATION_FAILED', '请求体与端点语义不一致', {
            fields: { allow: `/${verb} 只接受 allow=${String(allow)}` },
          })
        }
        return service.decide(id, allow, req.user!, requestMeta(req))
      })
    }

    // ── 会话 / 续期 / 登出（Bearer）────────────────────────────────────────
    app.get('/session', async (req, reply) => {
      const { body, etag } = service.session(principalOf(req))
      reply.header('ETag', etag)
      const ifNoneMatch = req.headers['if-none-match']
      const values = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch]
      const matched = values.some(
        (value) =>
          typeof value === 'string' && value.split(',').some((part) => part.trim() === etag),
      )
      if (matched) return reply.code(304).send()
      return DesktopSessionResponseSchema.parse(body)
    })

    app.post('/auth/refresh', async (req) => service.refresh(principalOf(req), requestMeta(req)))

    app.post('/auth/logout', async (req) => service.logout(principalOf(req), requestMeta(req)))

    // ── 设备上报（Bearer；bodyLimit 收紧到 64KB）───────────────────────────
    app.post('/devices/report', { bodyLimit: DEVICE_BODY_LIMIT_BYTES }, async (req) =>
      service.report(
        principalOf(req),
        DesktopDeviceReportRequestSchema.parse(req.body ?? {}),
        requestMeta(req),
      ),
    )

    // ── 每设备模式密钥（Bearer）─────────────────────────────────────────────
    app.post('/agent-mode-key', async (req) => {
      const input = DesktopAgentModeKeyRequestSchema.parse(req.body ?? {})
      return service.agentModeKey(principalOf(req), input.mode, requestMeta(req))
    })
  }
}

/** `/api/me/desktop-devices*`（网页会话）：用户看/吊销自己的设备 */
export function meDesktopDevicesPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDesktopService(deps)

    app.get('/', { preHandler: requireUser }, async (req) => service.listMine(req.user!.id))

    // 改名（WP25e）：只能改自己的设备；别人的 deviceId 一律 404（不给枚举留信号）
    app.patch('/:id', { preHandler: requireUser }, async (req) => {
      const { id } = DeviceIdParamSchema.parse(req.params ?? {})
      const input = DesktopRenameDeviceRequestSchema.parse(req.body ?? {})
      return DesktopRenameDeviceResponseSchema.parse(
        service.rename(req.user!.id, id, input.name, requestMeta(req)),
      )
    })

    app.delete('/:id', { preHandler: requireUser }, async (req, reply) => {
      const { id } = DeviceIdParamSchema.parse(req.params ?? {})
      service.revokeMine(req.user!.id, id, requestMeta(req))
      return reply.code(204).send()
    })
  }
}

/** `/api/admin/desktop-devices*`（管理端） */
export function adminDesktopDevicesPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = requireDesktopService(deps)

    app.get('/', { preHandler: requireAdmin }, async (req) =>
      service.listAdmin(DesktopDeviceListQuerySchema.parse(req.query ?? {})),
    )

    // 批量吊销（WP25e）：与单台一样要最近输过密码，但只在**一次请求**里验证
    app.post(
      '/revoke',
      { preHandler: [requireAdmin, requireReauth(deps.settings.get('security').reauthMinutes)] },
      async (req) => {
        const input = DesktopBatchRevokeRequestSchema.parse(req.body ?? {})
        return DesktopBatchRevokeResponseSchema.parse(
          service.batchRevoke(input.deviceIds, req.user!.id, requestMeta(req)),
        )
      },
    )

    app.post('/:id/revoke', { preHandler: requireAdmin }, async (req) => {
      const { id } = DeviceIdParamSchema.parse(req.params ?? {})
      return DesktopDeviceRevokeResponseSchema.parse(
        service.adminRevoke(id, req.user!.id, requestMeta(req)),
      )
    })

    // 设备详情（WP25e）：台账 + 插件清单 + 最近 20 条审计（只回白名单字段）
    app.get('/:id', { preHandler: requireAdmin }, async (req) => {
      const { id } = DeviceIdParamSchema.parse(req.params ?? {})
      return DesktopDeviceDetailResponseSchema.parse(service.detail(id))
    })
  }
}

function requireDesktopService(deps: AppDeps): DesktopService {
  const service = deps.services.desktop
  if (!service) throw new HubError('INTERNAL', 'desktop service 未装配')
  return service
}
