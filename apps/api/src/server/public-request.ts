import { isIP } from 'node:net'
import type { HubConfig } from '../config.js'

/**
 * 「公网请求」标记（02 §5、04 §0 第 11 条）。
 *
 * 只有经 7443 TLS 网关（公网入口四层透传）与边缘监听器（WP52 边缘七层入口）进来的连接会被打上
 * 这个标记；7700 明文监听器（本机调试/前端 dev 代理）永远不带。请求侧据此分流：按 IP 限流的
 * 回环豁免、会话 cookie 的 `Secure`、HSTS、转给用户 DSH 的 `x-forwarded-proto` 与注入的返回链接。
 *
 * 标记直接挂在 socket 上（TLS 网关在 `secureConnection` 时对 TLSSocket 再打一次，因为
 * TLSSocket 是包住原始 socket 的另一个对象）。Symbol 不参与 JSON 序列化，日志里也不会多出字段。
 */
export const PUBLIC_REQUEST: unique symbol = Symbol('dshhub.publicRequest')

/**
 * 「边缘入口」标记（WP52）：只有 `HUB_EDGE_PORT` 上的监听器会打。它一定与公网标记同时存在
 * （所以限流、cookie `Secure`、HSTS、`x-forwarded-proto` 全部按公网走），额外这一位只用于
 * **按入口解析对外 origin 与下载基址**（08 §3）。
 */
export const EDGE_REQUEST: unique symbol = Symbol('dshhub.edgeRequest')

/** 给 socket 打公网标记（重复调用无副作用） */
export function markPublicSocket(socket: unknown): void {
  if (!socket || typeof socket !== 'object') return
  Object.defineProperty(socket, PUBLIC_REQUEST, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false,
  })
}

/** socket 是否来自 TLS 网关 */
export function isPublicSocket(socket: unknown): boolean {
  if (!socket || typeof socket !== 'object') return false
  return (socket as Record<symbol, unknown>)[PUBLIC_REQUEST] === true
}

/** 请求是否来自 TLS 网关（Fastify request 与裸 IncomingMessage 都适用） */
export function isPublicRequest(req: { socket?: unknown } | null | undefined): boolean {
  return isPublicSocket(req?.socket)
}

/** 给 socket 打边缘入口标记（重复调用无副作用） */
export function markEdgeSocket(socket: unknown): void {
  if (!socket || typeof socket !== 'object') return
  Object.defineProperty(socket, EDGE_REQUEST, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false,
  })
}

/** socket 是否来自边缘监听器 */
export function isEdgeSocket(socket: unknown): boolean {
  if (!socket || typeof socket !== 'object') return false
  return (socket as Record<symbol, unknown>)[EDGE_REQUEST] === true
}

/** 请求是否来自边缘监听器（Fastify request 与裸 IncomingMessage 都适用） */
export function isEdgeRequest(req: { socket?: unknown } | null | undefined): boolean {
  return isEdgeSocket(req?.socket)
}

/**
 * 把 PROXY 头里的源地址写进 socket 的 `remoteAddress`。
 * `trustProxy: false` 时 Fastify 的 `req.ip` 就是 `socket.remoteAddress`（Fastify 5 request.js），
 * 所以这是「真实 IP 进审计/会话/限流/转发」的唯一入口；任何 `X-Forwarded-*` 都不采信。
 *
 * WP52：边缘监听器在每个 `request` 事件里用它写入 nginx 给的 `X-Real-IP`。
 */
export function applyProxiedRemoteAddress(socket: unknown, address: string): void {
  if (!socket || typeof socket !== 'object') return
  try {
    Object.defineProperty(socket, 'remoteAddress', {
      value: address,
      configurable: true,
      enumerable: true,
      writable: true,
    })
  } catch {
    // 极少数被冻结的 socket：宁可不改，也不要让连接处理崩掉
  }
}

/**
 * 解析边缘入口的 `X-Real-IP`（08 §3）：必须是**恰好一个**合法 IPv4/IPv6。
 *
 * 拒绝（返回 null，调用方回 400）：
 * - 缺失；
 * - 同名头出现多次（Node 会解析成数组）；
 * - 逗号/分号分隔的地址链（那是 `X-Forwarded-For` 的写法，不该出现在 `X-Real-IP`）；
 * - 带端口、带方括号、含空白或任何不是裸 IP 的字符串。
 *
 * 边缘端口只该被本机 nginx 访问，所以「不合规就断开」比「猜一个」安全。
 */
export function parseEdgeRealIp(value: string | string[] | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const ip = value.trim()
  if (ip.length === 0 || ip.length > 64) return null
  if (/[\s,;/[\]]/u.test(ip)) return null
  if (isIP(ip) === 0) return null
  return ip
}

/** 请求进入了哪个监听器（决定对外 origin / 下载基址，08 §3） */
export type EntryKind = 'local' | 'public' | 'edge'

/** 「站根 + 可选独立资产基址」，两者都无尾斜杠；`assetsOrigin=null` = 相对站根 */
export interface DownloadBase {
  origin: string
  assetsOrigin: string | null
}

/** 本请求入口的对外地址信息（`requestOrigin()` 的返回值） */
export interface RequestOrigin {
  kind: EntryKind
  /** 是否边缘（边缘入口）入口：等同 `kind === 'edge'`，调用方最常用的判据 */
  edge: boolean
  /** 本请求入口的**对外 origin**（7700 是本机回环地址）：注入返回链接用 */
  origin: string
  /**
   * 给用户看的链接基址：edge → `HUB_EDGE_ORIGIN`，7443/7700 → `HUB_PUBLIC_ORIGIN`。
   * 本机 7700 进来的请求仍按公网入口的公网基址下发（本机地址对别的机器/客户端没有意义）。
   */
  linkOrigin: string
  /** 本入口的下载基址（7700/7443 = 公网入口，edge = 边缘入口） */
  download: DownloadBase
  /** 下载镜像基址：本入口排第一，另一入口排第二；未配置的入口不出现；已去重 */
  downloadMirrors: DownloadBase[]
}

/** 本请求入口的对外地址信息（08 §3 的统一函数） */
export function requestOrigin(
  req: { socket?: unknown } | null | undefined,
  config: Pick<
    HubConfig,
    'httpPort' | 'publicOrigin' | 'publicAssetsOrigin' | 'edgeOrigin' | 'edgeAssetsOrigin'
  >,
): RequestOrigin {
  const guangzhou: DownloadBase = {
    origin: config.publicOrigin,
    assetsOrigin: config.publicAssetsOrigin,
  }
  const singapore: DownloadBase | null =
    config.edgeOrigin === null
      ? null
      : { origin: config.edgeOrigin, assetsOrigin: config.edgeAssetsOrigin }

  if (isEdgeRequest(req)) {
    // `HUB_EDGE_PORT≠0` 时 loadConfig 已保证 edgeOrigin 非 null；这里兜底成公网入口，避免拿到空串
    const own = singapore ?? guangzhou
    return {
      kind: 'edge',
      edge: true,
      origin: own.origin,
      linkOrigin: own.origin,
      download: own,
      downloadMirrors: dedupeBases([own, guangzhou]),
    }
  }
  if (isPublicRequest(req)) {
    return {
      kind: 'public',
      edge: false,
      origin: config.publicOrigin,
      linkOrigin: config.publicOrigin,
      download: guangzhou,
      downloadMirrors: dedupeBases(singapore ? [guangzhou, singapore] : [guangzhou]),
    }
  }
  return {
    kind: 'local',
    edge: false,
    origin: `http://127.0.0.1:${String(config.httpPort)}`,
    linkOrigin: config.publicOrigin,
    download: guangzhou,
    downloadMirrors: dedupeBases(singapore ? [guangzhou, singapore] : [guangzhou]),
  }
}

/** 去重（同一站根 + 同一资产基址算同一个入口），保持入参顺序 */
function dedupeBases(bases: DownloadBase[]): DownloadBase[] {
  const seen = new Set<string>()
  const out: DownloadBase[] = []
  for (const base of bases) {
    const key = `${base.origin}\u0000${base.assetsOrigin ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(base)
  }
  return out
}

/**
 * HSTS 头值：只对公网（7443 TLS 网关 / 边缘入口）响应发，`HUB_HSTS_MAX_AGE=0` 表示不发。
 * 不带 includeSubDomains / preload（02 §5：只有这一个域名，别把风险扩散到别的子域）。
 */
export function hstsHeaderValue(
  config: Pick<HubConfig, 'hstsMaxAge'>,
  publicRequest: boolean,
): string | null {
  if (!publicRequest || config.hstsMaxAge <= 0) return null
  return `max-age=${String(config.hstsMaxAge)}`
}

/** 按需写入 HSTS 头（普通 Fastify reply） */
export function applyHstsHeader(
  reply: { header(name: string, value: string): unknown },
  config: Pick<HubConfig, 'hstsMaxAge'>,
  publicRequest: boolean,
): void {
  const value = hstsHeaderValue(config, publicRequest)
  if (value) reply.header('Strict-Transport-Security', value)
}
