import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { startListeners, type ListenerHandle } from './server/listeners.js'
import { registerStatic } from './server/static.js'

/**
 * hub-api 入口：加载配置 → buildApp → 静态托管 → 监听全部监听器。
 *
 * 阶段一只有 `HUB_HTTP_PORT`（127.0.0.1 明文）；阶段二多一个 `HUB_TLS_PORT`（7443 TLS 网关，
 * 要求 PROXY v1、同端口明文 301、证书热更新），`HUB_REDIRECT_PORT` 已废弃（见 08 §3）。
 * WP52 再加 `HUB_EDGE_PORT`（边缘七层入口，明文 + 只认 `X-Real-IP`，08 §3）。
 *
 * 证书热更新两条触发路径：定时器（TLS 网关内部，60 秒看一次 fullchain.pem 的 mtime）与 SIGHUP。
 * **Node 默认收到 SIGHUP 会退出**，所以这里必须注册处理器（任务书 §1.2）。
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const app = await buildApp({ config })
  await registerStatic(app, { config })

  let listeners: ListenerHandle[] = []
  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    app.log.info(`收到 ${signal}，正在退出`)
    try {
      // 先关监听器（TLS 网关 + 静态），再关 Fastify（会依次关 DB / 驱动）
      for (const listener of listeners) {
        if (listener.kind === 'plain') continue
        await listener.close().catch((error: unknown) => {
          app.log.warn({ err: error }, `关闭 ${listener.kind} 监听器失败`)
        })
      }
      await app.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGHUP', () => {
    const relay = listeners.find((listener) => listener.kind === 'relay')
    if (config.relayInternalPort === 0) {
      app.log.info('中转站内部监听器关闭（HUB_RELAY_INTERNAL_PORT=0）')
    } else if (relay) {
      app.log.info(
        `中转站内部监听器：http://${relay.host}:${String(relay.port)}/v1（用户容器经它访问中转站）`,
      )
    } else {
      app.log.warn('中转站内部监听器未启动（拿不到监听地址），用户容器暂时连不上中转站')
    }
    const gateway = listeners.find((listener) => listener.kind === 'tls')
    if (!gateway?.tls) {
      app.log.info('收到 SIGHUP，但 TLS 网关未开启，忽略')
      return
    }
    app.log.info('收到 SIGHUP，重读 TLS 证书')
    const next = gateway.tls.reload('SIGHUP')
    if (!next) app.log.error('SIGHUP 重载证书失败，继续使用旧证书')
  })

  try {
    listeners = await startListeners(app, config, { deps: app.deps })
    // 座舱 DSH（WP56b）：确保系统账号 `hub-ops` 与实例行存在；容器在跑就同步它的 IP。
    // 失败只记日志——座舱不可用不该影响 Hub 自身启动（docs/24 §I6 的思路）。
    void app.deps.services.cockpitOps.bootstrap().catch((error: unknown) => {
      app.log.warn({ err: error }, '座舱 DSH 初始化失败（不影响 Hub 启动）')
    })
    const plain = listeners.find((listener) => listener.kind === 'plain')
    app.log.info(
      `hub-api 已启动：http://127.0.0.1:${String(plain?.port ?? config.httpPort)}` +
        `（数据目录 ${config.dataDir}，容器驱动 ${config.containerDriver}）`,
    )
    const relay = listeners.find((listener) => listener.kind === 'relay')
    if (config.relayInternalPort === 0) {
      app.log.info('中转站内部监听器关闭（HUB_RELAY_INTERNAL_PORT=0）')
    } else if (relay) {
      app.log.info(
        `中转站内部监听器：http://${relay.host}:${String(relay.port)}/v1（用户容器经它访问中转站）`,
      )
    } else {
      app.log.warn('中转站内部监听器未启动（拿不到监听地址），用户容器暂时连不上中转站')
    }
    const edge = listeners.find((listener) => listener.kind === 'edge')
    if (!edge) {
      app.log.info('边缘入口关闭（HUB_EDGE_PORT=0）；七层入口不监听')
    } else {
      app.log.info(
        `边缘入口已启动：http://127.0.0.1:${String(edge.port)}` +
          `（对外 ${config.edgeOrigin ?? '—'}，只认 X-Real-IP，要求 https）`,
      )
    }
    const gateway = listeners.find((listener) => listener.kind === 'tls')
    if (!gateway) {
      app.log.info('TLS 网关关闭（HUB_TLS_PORT=0）；阶段二由 deploy/hub.env 打开 7443')
    } else {
      const material = gateway.tls?.info()
      app.log.info(
        `TLS 网关已启动：https://127.0.0.1:${String(gateway.port)}（公网入口 ${config.publicOrigin}，` +
          `要求 PROXY v1=${String(config.proxyProtocol)}）`,
      )
      app.log.info(
        `TLS 证书来源：${material?.source === 'acme' ? "acme.sh（Let's Encrypt）" : '临时自签'}，` +
          `文件 ${material?.certPath ?? '—'}，到期 ${material?.info.validTo ?? '—'}` +
          `（剩余 ${String(material?.info.daysRemaining ?? '—')} 天）`,
      )
    }
  } catch (error) {
    app.log.error({ err: error }, '启动失败')
    process.exitCode = 1
    await app.close()
  }
}

void main()
