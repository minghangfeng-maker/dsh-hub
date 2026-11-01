import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from '../../context.js'
import { registerRelayV1Routes } from './routes-v1.js'
import { registerToolV1Routes } from './tools/routes.js'
import type { RelayService } from './types.js'

/**
 * 中转站的**内部监听器**（12 §3）：绑定在用户网桥网关 IP 上的独立 Fastify 实例，
 * 只挂 `/v1/*`（含搜索池的 `/v1/tools/*`，14 §2）与 `GET /healthz`——不读 cookie、没有 CSRF/会话、
 * 不托管静态文件，其它路径 404。
 *
 * 用户容器出网规则禁止连宿主（02 §4），这是唯一放行的口子（nft 只放行 `10.213.0.1:7710`）。
 * dogfood 与开发会话一律把端口设成 0（关闭）或绑 127.0.0.1 + 自己的端口。
 */

/** 绑定失败后的重试间隔（12 §3） */
export const RELAY_LISTENER_RETRY_MS = 30_000

export interface RelayInternalListenerOptions {
  deps: AppDeps
  /** 监听地址；null = 启动时向驱动查用户网络的网关 IP */
  host: string | null
  /** 监听端口；0 = 让内核分配（测试用；配置层 0 表示「不启动」） */
  port: number
  retryMs?: number
  /** 注入 Fastify 实例（测试用） */
  logger?: boolean
  /**
   * 额外路由（WP56a）：座舱的 `/ops/*` 与 `/v1/*` 共用这一个内部监听器 ——
   * 用户容器出网规则只放行 `10.213.0.1:7710`，不可能为座舱再开一个端口（docs/24 §2）。
   * 回调里自己 `app.register(plugin, { prefix })`，hooks 会被 Fastify 封装在插件内，不影响 `/v1/*`。
   */
  extraRoutes?: (app: FastifyInstance) => void
}

export interface RelayInternalListenerHandle {
  /** 实际监听的 `http://<host>:<port>/v1`；未监听成功时 null */
  baseUrl(): string | null
  address(): { host: string; port: number } | null
  listening(): boolean
  close(): Promise<void>
}

export async function startRelayInternalListener(
  options: RelayInternalListenerOptions,
): Promise<RelayInternalListenerHandle> {
  const { deps } = options
  const service = deps.services?.relay
  if (!service) throw new Error('relay service 未装配，无法启动内部监听器')
  const relay: RelayService = service

  const app: FastifyInstance = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: false,
    disableRequestLogging: true,
  })
  registerRelayV1Routes(app, deps, relay, { internal: true, source: () => 'internal' })
  // 搜索 / 抓取池（14 §2）：用户容器经同一个监听器访问 `/v1/tools/*`
  registerToolV1Routes(app, deps, relay, relay.tools, { internal: true })
  // 座舱 `/ops/*`（WP56a / docs/24 §3.1）：同一个端口上的另一组内部接口
  options.extraRoutes?.(app)

  let host = options.host
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let bound: { host: string; port: number } | null = null

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const scheduleRetry = (): void => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = null
      void bind()
    }, options.retryMs ?? RELAY_LISTENER_RETRY_MS)
    timer.unref?.()
  }

  async function resolveHost(): Promise<string | null> {
    if (host) return host
    try {
      const gateway = await deps.driver.networkGateway(deps.config.usersNetwork)
      if (gateway) {
        host = gateway
        return gateway
      }
    } catch (error) {
      deps.logger.warn({ err: error }, '查询用户网络网关失败，中转站内部监听器稍后重试')
    }
    return null
  }

  async function bind(): Promise<void> {
    if (closed || bound) return
    const target = await resolveHost()
    if (!target) {
      deps.logger.warn(
        `中转站内部监听器：${deps.config.usersNetwork} 还没有网关地址（网络未建？），30 秒后重试`,
      )
      scheduleRetry()
      return
    }
    // 地址一确定就先告诉 relay：渲染 managed.patch 只需要「容器该连哪」，不该因为暂时绑不上
    // （端口被占、启动瞬间）就把 hub-relay 提供方从用户配置里漏掉；绑定状态另由告警体现
    if (options.port !== 0) relay.setInternalBaseUrl(`http://${target}:${String(options.port)}/v1`)
    try {
      await app.listen({ host: target, port: options.port })
      const address = app.server.address()
      const port = address && typeof address === 'object' ? address.port : options.port
      bound = { host: target, port }
      relay.setInternalBaseUrl(`http://${target}:${String(port)}/v1`)
      relay.setInternalListening(true)
      deps.logger.info(
        `中转站内部监听器已启动：http://${target}:${String(port)}/v1（用户容器经它访问中转站）`,
      )
    } catch (error) {
      deps.logger.warn(
        { err: error },
        `中转站内部监听器绑定 ${target}:${String(options.port)} 失败，30 秒后重试`,
      )
      scheduleRetry()
    }
  }

  await bind()

  return {
    baseUrl: () => (bound ? `http://${bound.host}:${String(bound.port)}/v1` : null),
    address: () => bound,
    listening: () => bound !== null && app.server.listening,
    async close() {
      closed = true
      clearTimer()
      relay.setInternalListening(false)
      relay.setInternalBaseUrl(null)
      try {
        await app.close()
      } catch {
        // 没在监听时 close 可能是空操作，忽略
      }
      bound = null
    },
  }
}
