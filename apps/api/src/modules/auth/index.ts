import type { FastifyPluginAsync } from 'fastify'
import {
  CheckUsernameQuerySchema,
  LoginRequestSchema,
  ReauthRequestSchema,
  RegisterRequestSchema,
} from '@dsh-hub/shared'
import { clearSessionCookie, requestMeta, requireUser, setSessionCookie } from '../../app.js'
import { isPublicRequest } from '../../server/public-request.js'
import type { AppDeps } from '../../context.js'

/**
 * auth 模块（04 §2）。前缀 `/api/auth`：
 * `POST /register`、`GET /check-username`、`POST /login`、`POST /logout`、`GET /me`、`POST /reauth`。
 * 本模块只做「解析请求 → 调服务 → 写/清 cookie」，业务规则全在 service.ts。
 */
export function authPlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const service = deps.services.auth

    app.post('/register', async (req, reply) => {
      const body = RegisterRequestSchema.parse(req.body ?? {})
      const result = await service.register(body, requestMeta(req))
      if (result.session) {
        setSessionCookie(reply, deps.config, result.session.token, {
          expiresAt: result.session.expiresAt,
          remember: result.session.remember,
          publicRequest: isPublicRequest(req),
        })
      }
      return reply.code(201).send(result.response)
    })

    app.get('/check-username', async (req) => {
      const query = CheckUsernameQuerySchema.parse(req.query ?? {})
      return service.checkUsername(query.username, requestMeta(req))
    })

    app.post('/login', async (req, reply) => {
      const body = LoginRequestSchema.parse(req.body ?? {})
      const result = await service.login(body, requestMeta(req))
      setSessionCookie(reply, deps.config, result.session.token, {
        expiresAt: result.session.expiresAt,
        remember: result.session.remember,
        publicRequest: isPublicRequest(req),
      })
      return result.response
    })

    app.post('/logout', { preHandler: requireUser }, async (req, reply) => {
      await service.logout(req.user!.id, req.user!.sessionId, requestMeta(req))
      clearSessionCookie(reply)
      return reply.code(204).send()
    })

    app.get('/me', { preHandler: requireUser }, async (req) => service.me(req.user!.id))

    app.post('/reauth', { preHandler: requireUser }, async (req, reply) => {
      const body = ReauthRequestSchema.parse(req.body ?? {})
      await service.reauth(req.user!.id, req.user!.sessionId, body.password)
      return reply.code(204).send()
    })
  }
}

export { createAuthService, AUTH_RATE_LIMITS } from './service.js'
export type { AuthService, LoginResult, RegisterResult, SessionTicket } from './types.js'
