import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  AgentModeClientConfigSchema,
  RELAY_MAX_RANGE_DAYS,
  type ModelApi,
  type RelayScope,
  type RelayUsageSource,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps } from '../../context.js'
import { createWindowCounter } from '../../lib/rate-limit.js'
import { extractRelayKey } from './keys.js'
import { isAnthropicApi, vendorErrorBody } from './proxy.js'
import type { RelayService } from './types.js'

/** `/v1` 请求体上限（12 §4：32 MB，图片 base64 用） */
export const RELAY_BODY_LIMIT_BYTES = 32 * 1024 * 1024
/** 同一来源 IP 每分钟允许的无效密钥次数（12 §4） */
export const INVALID_KEY_LIMIT_PER_MINUTE = 20
/** 内部监听器每 IP 每分钟的总请求上限（12 §4） */
export const INTERNAL_LIMIT_PER_MINUTE = 600

export interface RelayV1Options {
  /** 内部监听器实例：只挂 `/v1/*` 与 `/healthz`，并启用每 IP 总量限流 */
  internal: boolean
  /** `source` 判定：内部监听器恒 `internal`；主应用按「公网请求」标记区分 local/public */
  source?: (req: FastifyRequest) => RelayUsageSource
}

const API_BY_PATH: { path: string; api: ModelApi }[] = [
  { path: '/v1/chat/completions', api: 'openai-completions' },
  { path: '/v1/responses', api: 'openai-responses' },
  { path: '/v1/messages', api: 'anthropic-messages' },
  { path: '/v1/messages/count_tokens', api: 'anthropic-messages' },
]

/** 路径 → 入口协议（错误体格式由它决定） */
export function apiForPath(path: string): ModelApi {
  const clean = path.split('?')[0] ?? path
  const hit = API_BY_PATH.find((item) => item.path === clean)
  return hit?.api ?? (clean.startsWith('/v1/messages') ? 'anthropic-messages' : 'openai-completions')
}

/**
 * 对外 `/v1` 路由（12 §4）。挂两处：主应用（7700/7443，`source` = local/public）与内部监听器（`internal`）。
 *
 * 这里是**厂商协议**的入口：鉴权用 `sk-dsh-…` 密钥，错误体按 OpenAI / Anthropic 格式，
 * 不读 cookie、不走会话/CSRF/Origin 钩子（那些钩子只认 `/api`；SPA 兜底也跳过 `/v1/`）。
 */
export function registerRelayV1Routes(
  app: FastifyInstance,
  deps: BaseDeps,
  service: RelayService,
  options: RelayV1Options,
): void {
  const invalidKeyLimit = createWindowCounter({
    capacity: INVALID_KEY_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    clock: deps.clock,
  })
  const internalLimit = createWindowCounter({
    capacity: INTERNAL_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    clock: deps.clock,
  })

  function sendError(
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: string,
    type: string,
    message: string,
  ): void {
    const api = apiForPath(req.url)
    void reply.code(status).send(vendorErrorBody(api, message, code, type))
  }

  /**
   * 18 §3.2：密钥作用域允许的接口。其它接口回 400（不是 403：这是「用错入口」，
   * 错误信息直接告诉用户这把密钥只能做什么）。
   */
  function endpointAllowed(scope: RelayScope, method: string, url: string): boolean {
    if (scope === 'dsh') return true
    const path = url.split('?')[0] ?? url
    const get = method === 'GET'
    const post = method === 'POST'
    if (get && (path === '/v1/models' || path === '/v1/hub/agent-mode')) return true
    if (scope === 'claude-code') {
      return post && (path === '/v1/messages' || path === '/v1/messages/count_tokens')
    }
    return post && path === '/v1/responses'
  }

  /** 18 §3.2：模式没开通 / 用户不在 targets → 403（中文原因给插件直接显示） */
  function modeDenialMessage(scope: RelayScope, userId: number): string | null {
    if (scope === 'dsh') return null
    const label = scope === 'claude-code' ? 'Claude Code' : 'Codex'
    const agentModes = (deps as Partial<AppDeps>).services?.agentModes
    if (!agentModes || !agentModes.isOpenFor(scope, userId)) {
      return `${label} 没有对你开放，请联系管理员`
    }
    return null
  }

  /** 鉴权 + 限流；失败时已经写好响应，返回 null */
  function authenticateRaw(
    req: FastifyRequest,
    reply: FastifyReply,
  ): ReturnType<RelayService['authenticate']> {
    if (options.internal) {
      const gate = internalLimit.consume(req.ip ?? 'unknown')
      if (!gate.allowed) {
        void reply.header('retry-after', String(gate.retryAfterSec))
        sendError(req, reply, 429, 'rate_limited', 'rate_limit_error', '请求过于频繁')
        return null
      }
    }
    const secret = extractRelayKey(req.headers as Record<string, string | string[] | undefined>)
    if (!secret) {
      sendError(req, reply, 401, 'invalid_api_key', 'authentication_error', '密钥无效')
      return null
    }
    const auth = service.authenticate(secret)
    if (!auth) {
      const decision = invalidKeyLimit.consume(req.ip ?? 'unknown')
      if (!decision.allowed) {
        void reply.header('retry-after', String(decision.retryAfterSec))
        sendError(req, reply, 429, 'rate_limited', 'rate_limit_error', '无效密钥尝试过多，稍后再试')
        return null
      }
      sendError(req, reply, 401, 'invalid_api_key', 'authentication_error', '密钥无效')
      return null
    }
    return auth
  }

  /**
   * 鉴权 + 作用域校验（18 §3.2）：接口是否属于这把密钥、模式是否对我开通。
   * 顺序：401（密钥）→ 400（接口不对）→ 403（没开通）。钱包/余额检查仍在转发引擎里。
   */
  function authenticate(req: FastifyRequest, reply: FastifyReply): ReturnType<RelayService['authenticate']> {
    const auth = authenticateRaw(req, reply)
    if (!auth) return null
    const scope = auth.key.scope
    if (!endpointAllowed(scope, req.method, req.url)) {
      const label = scope === 'claude-code' ? 'Claude Code' : 'Codex'
      sendError(
        req,
        reply,
        400,
        'unsupported_endpoint',
        'invalid_request_error',
        `这把密钥只能给 ${label} 用`,
      )
      return null
    }
    const denial = modeDenialMessage(scope, auth.user.id)
    if (denial !== null) {
      sendError(req, reply, 403, 'permission_denied', 'permission_error', denial)
      return null
    }
    return auth
  }

  /** `/v1/models`：一份数据同时满足 OpenAI 与 Anthropic 的列表格式（12 §4） */
  app.get('/v1/models', async (req, reply) => {
    const auth = authenticate(req, reply)
    if (!auth) return
    const created = Math.floor(deps.clock.now().getTime() / 1000)
    const data =
      auth.key.scope === 'dsh'
        ? // 16 §3：只列「模型 × 启用渠道上的启用路由」，id = `<模型>@<slug>`；不带 @ 的名字仍可调用但不列出
          service.myModels(auth.user.id, auth.user.role).flatMap((model) =>
            (model.routes ?? []).map((route) => ({
              id: route.pinnedModel,
              object: 'model',
              type: 'model',
              display_name: `${model.displayName} · ${route.channelSlug}`,
              created,
              created_at: new Date(created * 1000).toISOString(),
              owned_by: 'dsh-hub',
            })),
          )
        : // 18 §3.2：两个模式只列本名（不展开 @slug，中转站自动选渠道）
          service
            .scopeModels(auth.key.scope, { userId: auth.user.id, role: auth.user.role })
            .filter((model) => model.visible && model.enabled && model.routable)
            .map((model) => ({
              id: model.name,
              object: 'model',
              type: 'model',
              display_name: model.displayName,
              created,
              created_at: new Date(created * 1000).toISOString(),
              owned_by: 'dsh-hub',
            }))
    return {
      object: 'list',
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    }
  })

  for (const entry of API_BY_PATH) {
    app.post(entry.path, { bodyLimit: RELAY_BODY_LIMIT_BYTES }, async (req, reply) => {
      const auth = authenticate(req, reply)
      if (!auth) return
      const body = req.body
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendError(req, reply, 400, 'invalid_request', 'invalid_request_error', '请求体必须是 JSON 对象')
        return
      }
      await service.forward(req, reply, {
        api: entry.api,
        source: options.source ? options.source(req) : options.internal ? 'internal' : 'local',
        auth,
        headers: req.headers,
        body: body as Record<string, unknown>,
        ip: req.ip ?? null,
        path: req.url,
        // count_tokens 只透传：不计费、不记用量（12 §4）
        metered: !entry.path.endsWith('/count_tokens'),
      })
    })
  }

  /**
   * 18 §3.4：插件用的模式配置（模型、默认模型、小模型、显示名）。
   * dsh 密钥 → 404；未开放 / 不在 targets → 403（由上面的 `authenticate` 统一处理）。
   */
  app.get('/v1/hub/agent-mode', async (req, reply) => {
    const auth = authenticate(req, reply)
    if (!auth) return
    if (auth.key.scope === 'dsh') {
      sendError(req, reply, 404, 'not_found', 'not_found_error', '未知接口 /v1/hub/agent-mode')
      return
    }
    const agentModes = (deps as Partial<AppDeps>).services?.agentModes
    if (!agentModes) {
      sendError(req, reply, 403, 'permission_denied', 'permission_error', '对话模式没有开放')
      return
    }
    return AgentModeClientConfigSchema.parse(
      agentModes.clientConfig(auth.key.scope, auth.user.id, auth.user.role),
    )
  })

  /** 未知的 `/v1/*`：按入口协议回 404，不落到 SPA / 全站 404 处理器 */
  app.all('/v1/*', async (req, reply) => {
    sendError(req, reply, 404, 'not_found', 'not_found_error', `未知接口 ${req.url}`)
  })

  if (options.internal) {
    app.get('/healthz', async () => ({ ok: true, service: 'dsh-hub-relay' }))
  }

  void RELAY_MAX_RANGE_DAYS
  void isAnthropicApi
}

/** 主应用的 `source`：7443 是公网、7700 是本机（12 §3） */
export function relaySourceFor(publicRequest: boolean): RelayUsageSource {
  return publicRequest ? 'public' : 'local'
}

export { isAnthropicApi }
