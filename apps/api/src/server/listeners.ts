import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createHttpServer, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { HubConfig } from '../config.js'
import type { AppDeps } from '../context.js'
import { HubError } from '../lib/errors.js'
import { registerCockpitOpsRoutes } from '../modules/cockpit/index.js'
import { startRelayInternalListener } from '../modules/relay/internal-listener.js'
import { ProxyProtocolError, readProxyV1Header } from './proxy-protocol.js'
import {
  applyProxiedRemoteAddress,
  markEdgeSocket,
  markPublicSocket,
  parseEdgeRealIp,
} from './public-request.js'
import { createTlsManager, type TlsManager, type TlsMaterial } from './tls.js'

/**
 * 监听器（01 §2）：**全部只绑回环**。
 *
 * - 明文 `HUB_HTTP_PORT`（默认 7700）：本机调试、Vite 代理、CLI 健康检查；不经隧道暴露；
 * - TLS 网关 `HUB_TLS_PORT`（阶段二 7443）：要求 PROXY v1（公网入口的四层代理 `send-proxy`，反向隧道透传），
 *   同一个端口上还会回应明文 HTTP 请求（301 到 `HUB_PUBLIC_ORIGIN`）；
 * - 边缘入口 `HUB_EDGE_PORT`（WP52，默认 0=关）：前置代理终结 TLS 后经反向隧道明文转发，
 *   真实 IP 只从 `X-Real-IP` 取（08 §3）；
 * - `HUB_REDIRECT_PORT` **不使用**：:80 归 Caddy，明文跳转在 7443 同端口完成（08 §3）。
 *
 * 只有 7443 与边缘入口来的连接带「公网」标记（`public-request.ts`）；7700 永远是本机请求。
 */
export const LOOPBACK_HOST = '127.0.0.1'

/** TLS 握手记录的第一个字节 */
const TLS_HANDSHAKE_BYTE = 0x16
const CRLF = Buffer.from('\r\n')
/** 同端口明文跳转：请求行上限 */
const PLAINTEXT_LINE_MAX_BYTES = 8 * 1024

/** TLS 网关句柄里和证书有关的部分（main.ts 的 SIGHUP 热更新用） */
export interface TlsGatewayControl {
  info(): TlsMaterial
  reload(reason: string): TlsMaterial | null
  stop(): void
}

export interface ListenerHandle {
  kind: 'plain' | 'tls' | 'redirect' | 'relay' | 'edge'
  host: string
  /** 实际监听端口（传 0 时是内核分配的临时端口） */
  port: number
  /** 关闭该监听器；明文监听器的 server 就是 Fastify 自己的 server */
  close(): Promise<void>
  /** 仅 TLS 网关：证书控制 */
  tls?: TlsGatewayControl
}

/**
 * 明文 HTTP 监听器（阶段一唯一入口）：
 * 本机浏览器调试、Vite 代理、CLI 健康检查都走它；**不经隧道暴露**（01 §2）。
 *
 * 绑定地址默认回环；`HUB_HTTP_HOST=0.0.0.0` 只给局域网联调（手机真机直连集成 Hub）用，
 * 生产不设这个变量，行为与之前逐字节一致。
 */
export async function startPlainHttp(app: FastifyInstance, config: HubConfig): Promise<ListenerHandle> {
  const host = config.httpHost ?? LOOPBACK_HOST
  await app.listen({ host, port: config.httpPort })
  return {
    kind: 'plain',
    host,
    port: boundPort(app) ?? config.httpPort,
    close: async () => {
      if (app.server.listening) await app.close()
    },
  }
}

export interface TlsGatewayOptions {
  /** 注入证书管理器（测试用临时目录与更短的检查间隔） */
  tls?: TlsManager
}

/**
 * 阶段二：7443 TLS 网关。
 *
 * 结构是「`net.Server` 前置 + 独立 https server」：
 * 1. `net.Server` 收连接 → （`HUB_PROXY_PROTOCOL=true` 时）读 PROXY v1 头 → 把真实源地址写进
 *    `socket.remoteAddress`（`trustProxy:false` 下 `req.ip` 就是它）；
 * 2. 看首字节：`0x16` → `httpsServer.emit('connection', socket)`（复用同一个 Fastify 实例的
 *    `app.routing` 分发，不能二次 `app.listen()`）；大写字母开头像 HTTP 方法 → 同端口明文跳到 https；
 *    其它 → 断开；
 * 3. https server 的 `upgrade` 事件转发给 `app.server` 上已注册的处理（`/dsh/<username>/api/remote.mux`）。
 */
export async function startTlsGateway(
  app: FastifyInstance,
  config: HubConfig,
  options: TlsGatewayOptions = {},
): Promise<ListenerHandle | null> {
  if (config.tlsPort === 0) return null
  // 复用 `app.routing` 前必须 boot 完：avvio 在 preReady 之后才会把路由 context 的
  // 生命周期 hook（preParsing 等）准备好，否则请求会在 preParsing 处抛错、连接挂死
  await app.ready()

  const manager =
    options.tls ??
    createTlsManager({
      dataDir: config.dataDir,
      publicOrigin: config.publicOrigin,
      log: app.log,
    })
  const material = manager.load()
  if (material.source === 'self-signed') {
    app.log.warn(
      `未找到正式证书，正在使用自签证书（${material.certPath}，到期 ${material.info.validTo ?? '—'}）：` +
        '浏览器会提示证书不受信任；用 deploy/tls/issue-cert.sh 签发正式证书',
    )
  }

  const httpsServer = createHttpsServer(
    { key: material.key, cert: material.cert, minVersion: 'TLSv1.2' },
    app.routing,
  )
  // WS 升级：Fastify 不处理 upgrade，proxy 模块把处理挂在 app.server 上（02 §7.5）
  httpsServer.on('upgrade', (req, socket, head) => {
    app.server.emit('upgrade', req, socket, head)
  })
  // TLSSocket 是包住原始 socket 的另一个对象，而且它有自己的 handle：
  // 在原始 socket 上 defineProperty 的 remoteAddress 透不过来，公网标记与真实 IP 都要在这里补一次。
  httpsServer.on('secureConnection', (socket) => {
    markPublicSocket(socket)
    const parent = (socket as { _parent?: { remoteAddress?: string } })._parent
    if (parent?.remoteAddress) applyProxiedRemoteAddress(socket, parent.remoteAddress)
  })
  httpsServer.on('tlsClientError', (error) => {
    app.log.debug({ err: error }, 'TLS 握手失败（可能是明文客户端或证书不匹配）')
  })
  manager.onChange((next) => {
    httpsServer.setSecureContext({ key: next.key, cert: next.cert })
    app.log.info(
      `TLS 证书已热切换（${next.source}，到期 ${next.info.validTo ?? '—'}，` +
        `剩余 ${String(next.info.daysRemaining ?? '—')} 天），未重启进程`,
    )
  })

  // net.Server 没有 closeAllConnections：自己记着连接，关闭时一并断开
  const frontConnections = new Set<Socket>()
  const front = createNetServer((socket) => {
    frontConnections.add(socket)
    socket.once('close', () => frontConnections.delete(socket))
    void handleGatewayConnection(socket, {
      config,
      httpsServer,
      log: app.log,
    })
  })
  front.on('error', (error) => {
    app.log.error({ err: error }, 'TLS 网关监听器出错')
  })
  await listenNet(front, config.tlsPort)
  manager.start()

  return {
    kind: 'tls',
    host: LOOPBACK_HOST,
    port: boundServerPort(front) ?? config.tlsPort,
    tls: {
      info: () => manager.current() ?? material,
      reload: (reason: string) => manager.reload(reason),
      stop: () => manager.stop(),
    },
    close: async () => {
      manager.stop()
      await closeServer(front, frontConnections)
      await closeServer(httpsServer)
    },
  }
}

/**
 * 边缘（边缘入口）七层入口（WP52 / 08 §3）：明文 HTTP、**只绑 127.0.0.1**。
 *
 * TLS 在境外 nginx 终结，本机只收到明文 + `X-Real-IP`。结构与 7443 网关同样的做法：
 * 复用同一个 Fastify 实例的 `app.routing` 分发（不能二次 `app.listen()`），
 * `upgrade` 事件转给 `app.server` 上已注册的处理（`/dsh/<username>/api/remote.mux`、手机通道等）。
 *
 * 每个连接打两个标记：**公网**（限流不豁免、cookie `Secure`、HSTS、`x-forwarded-proto: https`）
 * 与**边缘**（按入口解析对外 origin 与下载基址）。真实 IP **按请求**从 `X-Real-IP` 取并写进
 * `socket.remoteAddress`（`trustProxy:false` 下 `req.ip` 就是它）；缺失 / 多值 / 非法一律 400 断开
 * —— 边缘端口只该被本机 nginx 访问。
 */
export async function startEdgeListener(
  app: FastifyInstance,
  config: HubConfig,
): Promise<ListenerHandle | null> {
  if (config.edgePort === 0) return null
  // 复用 `app.routing` 前必须 boot 完（与 TLS 网关同一个原因：avvio 在 preReady 之后才备好 hook）
  await app.ready()
  if (config.edgeOrigin === null) {
    // loadConfig 已经拦过；这里再兜一层，避免带着空 origin 启动（CSRF 会把自己锁死）
    throw new HubError('INTERNAL', 'HUB_EDGE_PORT 已开启但 HUB_EDGE_ORIGIN 为空')
  }

  const edgeServer = createHttpServer((req, res) => {
    const realIp = parseEdgeRealIp(req.headers['x-real-ip'])
    if (realIp === null) {
      answerEdgeReject(res, 'X-Real-IP 缺失或不合法（边缘入口只接受 nginx 转发的单个 IP）')
      app.log.debug({ url: req.url }, '边缘入口：拒绝没有合法 X-Real-IP 的请求')
      return
    }
    applyProxiedRemoteAddress(req.socket, realIp)
    app.routing(req, res)
  })
  edgeServer.on('connection', (socket) => {
    // 两个标记缺一不可：public 决定「按公网对待」，edge 决定「按边缘入口入口取 origin/下载基址」
    markPublicSocket(socket)
    markEdgeSocket(socket)
  })
  // WS 升级：与普通请求一样要先校验 X-Real-IP，再交给 app.server 上的处理器（02 §7.5）
  edgeServer.on('upgrade', (req, socket, head) => {
    const realIp = parseEdgeRealIp(req.headers['x-real-ip'])
    if (realIp === null) {
      answerEdgeUpgradeReject(socket, 'X-Real-IP 缺失或不合法（边缘入口只接受 nginx 转发的单个 IP）')
      app.log.debug({ url: req.url }, '边缘入口：拒绝没有合法 X-Real-IP 的 WS 升级')
      return
    }
    applyProxiedRemoteAddress(req.socket, realIp)
    app.server.emit('upgrade', req, socket, head)
  })
  // 半截请求 / 畸形请求：直接断开，不往进程级抛
  edgeServer.on('clientError', (_error, socket) => {
    socket.destroy()
  })
  edgeServer.on('error', (error) => {
    app.log.error({ err: error }, '边缘入口监听器出错')
  })
  await listenNet(edgeServer, config.edgePort)

  return {
    kind: 'edge',
    host: LOOPBACK_HOST,
    port: boundServerPort(edgeServer) ?? config.edgePort,
    close: () => closeServer(edgeServer),
  }
}

/**
 * 阶段二：`HUB_REDIRECT_PORT`（原 7080 独立跳转监听器）**不使用** ——
 * :80 归 Caddy，明文跳转在 7443 同端口完成（08 §3、01 §6）。
 */
export async function startRedirect(
  _app: FastifyInstance,
  config: HubConfig,
): Promise<ListenerHandle | null> {
  if (config.redirectPort === 0) return null
  throw new HubError(
    'INTERNAL',
    'HUB_REDIRECT_PORT 已废弃：:80 归 Caddy，明文 HTTP 请求在 7443 同端口直接 301 到 https（08 §3）。请设 HUB_REDIRECT_PORT=0',
  )
}

export interface StartListenersOptions {
  tls?: TlsManager
  /** 装配好的依赖（内部监听器要用 relay service 与容器驱动查网络网关）；缺省则不启动 */
  deps?: AppDeps
}

/** 按配置启动全部监听器：阶段一只有明文；阶段二多一个 7443 TLS 网关；WP52 再加边缘入口 */
export async function startListeners(
  app: FastifyInstance,
  config: HubConfig,
  options: StartListenersOptions = {},
): Promise<ListenerHandle[]> {
  const handles: ListenerHandle[] = [await startPlainHttp(app, config)]
  const tls = await startTlsGateway(app, config, options)
  if (tls) handles.push(tls)
  const edge = await startEdgeListener(app, config)
  if (edge) handles.push(edge)
  const redirect = await startRedirect(app, config)
  if (redirect) handles.push(redirect)
  const relay = await startRelayListener(config, options.deps)
  if (relay) handles.push(relay)
  return handles
}

/**
 * 中转站**内部监听器**（12 §3）：绑在用户网桥网关 IP 上的独立 Fastify 实例，
 * 只有 `/v1/*` 与 `GET /healthz`。`HUB_RELAY_INTERNAL_PORT=0` 时不开。
 *
 * 绑定失败（网络还没建 / 网关地址拿不到）由内部监听器自己记 warn 并每 30 秒重试，
 * 所以这里不把失败当启动错误。
 */
export async function startRelayListener(
  config: HubConfig,
  deps: AppDeps | undefined,
): Promise<ListenerHandle | null> {
  if (config.relayInternalPort === 0) return null
  if (!deps) return null
  const handle = await startRelayInternalListener({
    deps,
    host: config.relayInternalHost,
    port: config.relayInternalPort,
    // 座舱 DSH 调 Hub 的 `/ops/*` 也只能走这个口子（docs/24 §2）
    extraRoutes: (internalApp) => registerCockpitOpsRoutes(internalApp, deps),
  })
  const address = handle.address()
  return {
    kind: 'relay',
    host: address?.host ?? config.relayInternalHost ?? '—',
    port: address?.port ?? config.relayInternalPort,
    close: () => handle.close(),
  }
}

// ── TLS 网关内部 ────────────────────────────────────────────────────────────

interface GatewayDeps {
  config: HubConfig
  httpsServer: HttpsServer
  log: FastifyInstance['log']
}

type ConnectionPrefix = { kind: 'tls'; leftover: Buffer } | { kind: 'http'; requestLine: string }

async function handleGatewayConnection(socket: Socket, deps: GatewayDeps): Promise<void> {
  // 连接级错误（RST/EPIPE）不该变成进程级异常
  socket.on('error', () => undefined)
  markPublicSocket(socket)
  try {
    if (deps.config.proxyProtocol) {
      const header = await readProxyV1Header(socket)
      if (header.sourceAddress) applyProxiedRemoteAddress(socket, header.sourceAddress)
      else deps.log.debug('PROXY UNKNOWN：保留隧道出口地址作为 req.ip')
    }
    const prefix = await readConnectionPrefix(socket)
    if (prefix.kind === 'tls') {
      // 与 TLS ClientHello 粘在同一个 chunk 里的字节已经 unshift 回去，这里直接交给 https server
      deps.httpsServer.emit('connection', socket)
      return
    }
    answerPlaintextRedirect(socket, prefix.requestLine, deps)
  } catch (error) {
    if (!(error instanceof ProxyProtocolError)) {
      deps.log.debug({ err: error }, 'TLS 网关：连接前缀解析失败，断开')
    } else {
      deps.log.warn({ reason: error.reason }, 'TLS 网关：PROXY 头不合法，断开')
    }
    socket.destroy()
  }
}

/**
 * 读连接前缀：首字节 `0x16` → TLS；大写字母开头像 HTTP 方法 → 继续读到请求行结束（CRLF）。
 *
 * 上一环节（PROXY 解析）结束时 socket 处于 paused 且把剩余字节 unshift 回去了，
 * 所以这里 attach 监听后必须显式 `resume()`，否则永远等不到数据。
 */
function readConnectionPrefix(
  socket: Socket,
  options: { timeoutMs?: number } = {},
): Promise<ConnectionPrefix> {
  const timeoutMs = options.timeoutMs ?? 3_000
  return new Promise<ConnectionPrefix>((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0)
    let settled = false

    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      clearTimeout(timer)
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }
    const finish = (result: ConnectionPrefix, pushBack: Buffer): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.pause()
      if (pushBack.length > 0) socket.unshift(pushBack)
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (buffer[0] === TLS_HANDSHAKE_BYTE) {
        finish({ kind: 'tls', leftover: buffer }, buffer)
        return
      }
      if (!looksLikeHttpMethod(buffer)) {
        fail('既不是 TLS 握手也不是 HTTP 请求')
        return
      }
      const end = buffer.indexOf(CRLF)
      if (end !== -1) {
        finish({ kind: 'http', requestLine: buffer.subarray(0, end).toString('latin1') }, Buffer.alloc(0))
        return
      }
      if (buffer.length > PLAINTEXT_LINE_MAX_BYTES) fail('明文跳转：请求行过长')
    }
    const onError = (error: Error): void => {
      fail(error.message)
    }
    const onClose = (): void => {
      fail('连接在读到首包前关闭')
    }
    const timer = setTimeout(() => {
      fail('等待连接首包超时')
    }, timeoutMs)
    timer.unref?.()

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.resume()
  })
}

/** 首字节起是否像一个 HTTP 方法（大写字母 + 空格结尾）；数据不完整时返回 true 继续等 */
function looksLikeHttpMethod(buffer: Buffer): boolean {
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]!
    if (byte === 0x20) return index >= 2
    if (byte < 0x41 || byte > 0x5a) return false
    if (index >= 10) return false
  }
  return buffer.length > 0
}

/**
 * 同端口明文请求 → 301 到 https（02 §5 的 HSTS/Origin 都靠 https 那一条路）。
 * path 必须以 `/` 开头且不含 CR/LF，否则用 `/`（防头注入与开放重定向）。
 */
function answerPlaintextRedirect(socket: Socket, requestLine: string, deps: GatewayDeps): void {
  const [method, target] = requestLine.split(' ')
  if (!method || !target) {
    socket.destroy()
    return
  }
  const location = `${deps.config.publicOrigin}${sanitizeRedirectPath(target)}`
  deps.log.debug({ method, location }, 'TLS 网关：明文请求跳转到 https')
  socket.end(
    'HTTP/1.1 301 Moved Permanently\r\n' +
      `Location: ${location}\r\n` +
      'Content-Length: 0\r\n' +
      'Cache-Control: no-store\r\n' +
      'Connection: close\r\n\r\n',
  )
}

/** 把请求行里的 target 清洗成可以安全拼进 `Location` 的路径 */
export function sanitizeRedirectPath(target: string): string {
  let path = target
  if (!path.startsWith('/')) {
    try {
      const url = new URL(path)
      path = `${url.pathname}${url.search}`
    } catch {
      path = '/'
    }
  }
  // 控制字符（含 CR/LF）一律去掉，避免响应头注入
  path = [...path]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
  if (!path.startsWith('/')) path = '/'
  return path
}

// ── 边缘入口内部 ────────────────────────────────────────────────────────────

/** 边缘入口的 400 响应：与 Hub 错误体同形，客户端/日志都能识别 */
function answerEdgeReject(res: ServerResponse, message: string): void {
  const body = JSON.stringify({ error: { code: 'VALIDATION_FAILED', message } })
  res.writeHead(400, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    connection: 'close',
  })
  res.end(body)
}

/** WS 升级被拒：此时还没有 HTTP 响应对象，直接往 socket 写一个 400 再断开 */
function answerEdgeUpgradeReject(socket: Duplex, message: string): void {
  const body = JSON.stringify({ error: { code: 'VALIDATION_FAILED', message } })
  socket.on('error', () => undefined)
  socket.end(
    'HTTP/1.1 400 Bad Request\r\n' +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${String(Buffer.byteLength(body))}\r\n` +
      'cache-control: no-store\r\n' +
      'connection: close\r\n\r\n' +
      body,
  )
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/** `app.listen` 之后取内核实际绑定的端口（测试里用 0 端口时尤其有用） */
function boundPort(app: FastifyInstance): number | null {
  const address = app.server.address()
  if (address && typeof address === 'object') return address.port
  return null
}

function boundServerPort(server: NetServer | HttpsServer): number | null {
  const address = server.address()
  if (address && typeof address === 'object') return address.port
  return null
}

function listenNet(server: NetServer, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, LOOPBACK_HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

/**
 * 关掉监听器：没在 listen 的 server 会报 ERR_SERVER_NOT_RUNNING（回调参数，忽略即可）。
 * `net.Server` 没有 `closeAllConnections`（那是 http.Server 的方法），靠自己记的集合断开；
 * 另外加一个兜底超时，避免退出流程被半开连接挂住。
 */
async function closeServer(server: NetServer | HttpsServer, tracked?: Set<Socket>): Promise<void> {
  const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 2_000)
    timer.unref?.()
    server.close(() => {
      clearTimeout(timer)
      finish()
    })
    try {
      closeAll?.call(server)
    } catch {
      // 没在监听时 closeAllConnections 可能抛错，忽略
    }
    if (tracked) {
      for (const socket of tracked) socket.destroy()
      tracked.clear()
    }
  })
}
