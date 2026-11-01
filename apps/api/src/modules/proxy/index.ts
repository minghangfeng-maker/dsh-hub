import type { FastifyPluginAsync } from 'fastify'
import { HubError } from '../../lib/errors.js'
import type { AppDeps, BaseDeps } from '../../context.js'
import {
  ATTACH_SERVICES,
  createProxyService,
  type InternalProxyService,
  type ProxyServiceOptions,
} from './service.js'
import type { ProxyService } from './types.js'

export * from './types.js'
export { ATTACH_SERVICES, createProxyService, PROXY_AUTHORITY, WS_IDLE_MS } from './service.js'
export {
  buildCookieHeader,
  buildResponseHeaders,
  buildUpstreamHeaders,
  parseLegacyProxyTarget,
  parseProxyTarget,
} from './headers.js'
export { injectIntoHtml, OWNS_HOST_SNIPPET } from './inject.js'
export { renderWakePage } from './wake-page.js'

/** 代理请求体上限（DSH 的 API 可能 POST 大 JSON；不能受 04 §0 的 2MB 限制） */
export const PROXY_BODY_LIMIT_BYTES = 64 * 1024 * 1024

const PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/**
 * proxy 模块（04 §5、05 §5；WP2 实现，WP16 改地址）。**不带 `/api` 前缀**：
 * 规范地址 `/dsh/<username>/*`；旧的 `/u/<slug>/*` 只保留 301 跳转。
 *
 * 两个实现要点：
 *   1. 路由用 `reply.hijack()` 交给裸 `reply.raw`：代理要自己写响应头、逐块转发 SSE、
 *      注入 HTML，Fastify 的序列化与缓冲都会碍事；
 *   2. `addContentTypeParser('*')` 只对 `/dsh/` 与 `/u/` 放行原始流（其余路径维持 Fastify 默认的 415），
 *      这样 DSH 的 multipart/未知类型请求体不会被 Fastify 吃掉。
 * WS 升级挂在 `app.server` 的 `upgrade` 事件上（Fastify 不处理 upgrade）。
 */
export function proxyPlugin(deps: BaseDeps): FastifyPluginAsync {
  return async (app) => {
    const services = (deps as Partial<AppDeps>).services
    const proxy = services?.proxy as InternalProxyService | undefined
    if (!proxy) throw new HubError('INTERNAL', 'proxy service 未装配')
    proxy[ATTACH_SERVICES](services)

    try {
      app.addContentTypeParser('*', (req, payload, done) => {
        const url = req.url ?? ''
        if (url.startsWith('/dsh/') || url.startsWith('/u/')) {
          done(null, payload)
          return
        }
        done(Object.assign(new Error('不支持的请求体类型'), { statusCode: 415 }), undefined)
      })
    } catch (error) {
      deps.logger.warn({ err: error }, '代理：注册通配 content-type 解析器失败')
    }

    for (const url of ['/dsh/:username', '/dsh/:username/*', '/u/:slug', '/u/:slug/*']) {
      app.route({
        method: PROXY_METHODS,
        url,
        bodyLimit: PROXY_BODY_LIMIT_BYTES,
        handler: async (req, reply) => {
          // 代理自己写响应（含逐块 SSE、HTML 注入）：交给裸 reply.raw
          reply.hijack()
          try {
            await proxy.handleHttp(req, reply)
          } catch (error) {
            // hijack 之后 Fastify 的错误处理不会再发响应，这里必须自己收尾，否则请求挂死
            deps.logger.error({ err: error, url: req.url }, '代理请求处理失败')
            if (reply.raw.headersSent) {
              reply.raw.end()
              return
            }
            const body = JSON.stringify({ error: { code: 'INTERNAL', message: '代理处理失败' } })
            reply.raw.writeHead(502, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(Buffer.byteLength(body)),
            })
            reply.raw.end(body)
          }
        },
      })
    }

    proxy.attachUpgrade(app.server)
  }
}

export function createProxyServiceFactory(deps: BaseDeps, options: ProxyServiceOptions = {}): ProxyService {
  return createProxyService(deps, options)
}
