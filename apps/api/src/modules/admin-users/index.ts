import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import {
  AuditListQuerySchema,
  CreateInvitesRequestSchema,
  CreateUserRequestSchema,
  DeletedUserListQuerySchema,
  DeleteUserQuerySchema,
  InviteListQuerySchema,
  NumericIdParamSchema,
  RestoreUserRequestSchema,
  UpdateInviteRequestSchema,
  UpdateSettingsRequestSchema,
  UpdateUserRequestSchema,
  UserListQuerySchema,
} from '@dsh-hub/shared'
import { requestMeta, requireAdmin } from '../../app.js'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { hasRecentReauth } from '../../lib/session.js'
import type { AdminActor } from './types.js'

/** 回收站过期清理间隔：每小时扫一次（与 exports 的过期清理同频） */
const TRASH_SWEEP_INTERVAL_MS = 3_600_000

/**
 * admin-users 模块（04 §4.1 §4.2 §4.4）。前缀 `/api/admin`：
 * `/overview`、`/users*`、`/invites*`、`/settings`、`/audit`。
 * 实例相关 `/api/admin/instances*` 归 WP2，插件/版本/模型/任务归 WP3/WP4。
 */
export function adminUsersPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const users = deps.services.adminUsers
    const system = deps.services.system

    /** 敏感操作要求最近输过密码（`/api/auth/reauth`），窗口取 settings.security.reauthMinutes */
    const requireReauth = async (req: FastifyRequest): Promise<void> => {
      if (!req.user) throw new HubError('UNAUTHENTICATED')
      const minutes = deps.settings.get('security').reauthMinutes
      if (!hasRecentReauth(req.user, deps.clock.nowIso(), minutes)) throw new HubError('REAUTH_REQUIRED')
    }

    const actorOf = (req: FastifyRequest): AdminActor => ({ actorId: req.user!.id, ...requestMeta(req) })

    // 回收站过期清理：onReady 跑一次 + 每小时一次；定时器 unref，onClose 清理（参考 exports 模块）
    const sweepTrash = (): void => {
      void users
        .sweepExpiredDeletions()
        .catch((error: unknown) => app.log.warn({ err: error }, '回收站过期清理失败'))
    }
    const sweepTimer = setInterval(sweepTrash, TRASH_SWEEP_INTERVAL_MS)
    sweepTimer.unref?.()
    app.addHook('onReady', () => {
      sweepTrash()
    })
    app.addHook('onClose', () => {
      clearInterval(sweepTimer)
    })

    app.addHook('preHandler', requireAdmin)

    // ── 概览 ──
    app.get('/overview', async () => users.overview())

    // ── 用户 ──
    app.get('/users', async (req) => users.listUsers(UserListQuerySchema.parse(req.query ?? {})))

    app.get('/users/role-labels', async () => users.roleLabels())

    // 回收站列表：静态路由先于 `/users/:id`（Fastify 本身也静态优先，这里显式放前面便于阅读）
    app.get('/users/deleted', async (req) =>
      users.listDeletedUsers(DeletedUserListQuerySchema.parse(req.query ?? {})),
    )

    app.post('/users', async (req, reply) => {
      const body = CreateUserRequestSchema.parse(req.body ?? {})
      const result = await users.createUser(body, actorOf(req))
      return reply.code(201).send(result)
    })

    app.get('/users/:id', async (req) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      return users.getUser(id)
    })

    app.patch('/users/:id', async (req) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      const body = UpdateUserRequestSchema.parse(req.body ?? {})
      return users.updateUser(id, body, actorOf(req))
    })

    app.post('/users/:id/approve', async (req) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      return users.approve(id, actorOf(req))
    })

    app.post('/users/:id/reset-password', { preHandler: requireReauth }, async (req) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      return users.resetPassword(id, actorOf(req))
    })

    app.post('/users/:id/revoke-sessions', async (req) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      return users.revokeSessions(id, actorOf(req))
    })

    app.delete('/users/:id', { preHandler: requireReauth }, async (req, reply) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      const query = DeleteUserQuerySchema.parse(req.query ?? {})
      await users.deleteUser(id, query, actorOf(req))
      return reply.code(204).send()
    })

    // 回收站恢复 / 彻底删除：与删除一样是敏感操作，要求最近输过密码
    app.post('/users/:id/restore', { preHandler: requireReauth }, async (req) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      const body = RestoreUserRequestSchema.parse(req.body ?? {})
      return users.restoreUser(id, body, actorOf(req))
    })

    app.post('/users/:id/purge', { preHandler: requireReauth }, async (req, reply) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      await users.purgeUser(id, actorOf(req))
      return reply.code(204).send()
    })

    // ── 邀请码 ──
    app.get('/invites', async (req) => system.listInvites(InviteListQuerySchema.parse(req.query ?? {})))

    app.post('/invites', async (req, reply) => {
      const body = CreateInvitesRequestSchema.parse(req.body ?? {})
      const result = await system.createInvites(body, actorOf(req))
      return reply.code(201).send(result)
    })

    app.patch('/invites/:id', async (req) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      const body = UpdateInviteRequestSchema.parse(req.body ?? {})
      return system.updateInvite(id, body, actorOf(req))
    })

    app.delete('/invites/:id', async (req, reply) => {
      const { id } = NumericIdParamSchema.parse(req.params ?? {})
      await system.deleteInvite(id, actorOf(req))
      return reply.code(204).send()
    })

    // ── 系统设置 ──
    app.get('/settings', async () => system.getSettings())

    app.patch('/settings', async (req) => {
      const body = UpdateSettingsRequestSchema.parse(req.body ?? {})
      return system.updateSettings(body, actorOf(req))
    })

    // ── 审计 ──
    app.get('/audit', async (req) => system.listAudit(AuditListQuerySchema.parse(req.query ?? {})))
  }
}

/** 公共站点信息（04 §1，未登录可访问）。单独挂 `/api/public` 前缀 */
export function publicSitePlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/site', async () => deps.services.system.publicSite())
  }
}

export { createAdminUsersService } from './users-service.js'
export { createSystemService } from './system-service.js'
export type { AdminActor, AdminUsersService, SystemService } from './types.js'
