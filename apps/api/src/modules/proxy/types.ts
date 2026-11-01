import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** DSH 的认证 cookie（05 §5：名字由 authority 的 sha256 决定） */
export interface DshCookie {
  name: string
  value: string
}

/**
 * 反向代理服务（04 §5、05 §5；WP2 实现，WP16 改地址）。
 * 规范路由：`/dsh/<username>/*`（HTTP + WebSocket 升级），不属于 `/api`；
 * 旧的 `/u/<slug>/*` 只做 301 跳转（WS 升级不跟 301，直接 404）。
 *
 * WP0b 实测补充（05 §5）：`GET /dsh/<username>`（无斜杠）要 301 到 `/dsh/<username>/`；
 * 请求上游时把 `accept-encoding` 改成 `identity`（DSH 开了 gzip，压缩体没法注入 ownsHost）；
 * authority 默认取 `127.0.0.1:3000`（S1：回环天然受信，插件自带的回环路由可用），
 * 此时每实例的 cookie 名相同、但签名密钥仍是每实例一份且从不下发浏览器。
 */
export interface ProxyService {
  /** 是否归代理处理（规范 `^/dsh/<username>(/|$)`，或旧的 `^/u/u[a-z0-9]{7}(/|$)` 跳转） */
  matches(url: string): boolean
  /** 校验会话用户是路径里的用户名 → 改写 Host/Origin → 注入现签 cookie → 转发（含 SSE 不缓冲、HTML 注入 ownsHost） */
  handleHttp(req: FastifyRequest, reply: FastifyReply): Promise<void>
  /** WS 升级：同样做鉴权与 Host/Origin 改写，双向 pipe；单用户上限 20 条 */
  handleUpgrade(req: FastifyRequest, socket: Duplex, head: Buffer): Promise<void>
  /** 现签 DSH cookie（读用户卷里的 browser-session 密钥，缓存 50 分钟） */
  mintDshCookie(slug: string): Promise<DshCookie>
  /** 读 `home/.dsh/.credentials.yaml` 的 `records["client-connection/browser-session"].payload.secret` */
  readBrowserSessionSecret(slug: string): Promise<string>
  /** 容器重建/密钥轮换后清缓存 */
  invalidateSecretCache(slug: string): void

  // ── WP33：在场信息（docs/22 §6.1；实例休眠规则用） ──────────────────────
  /** 该用户实例当前打开的代理 WebSocket 数（按**实例主人**计；0 = 没人看） */
  openClients(userId: number): number
  /** 该用户实例最后一次 WS 断开的时刻（epoch 毫秒；从没连过为 null） */
  lastClientAt(userId: number): number | null

  // ── WP2 扩展（Fastify 不处理 upgrade 事件，需要直接挂到 http.Server 上） ──
  /** 原始 HTTP 升级请求（`server.on('upgrade')` 的回调签名） */
  handleRawUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>
  /** 把 upgrade 监听挂到 http.Server（main.ts / WP7b 的监听器调用） */
  attachUpgrade(server: Server): void
}
