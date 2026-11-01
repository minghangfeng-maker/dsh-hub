import { request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { Duplex, Readable } from 'node:stream'
import { SESSION_COOKIE_NAME, MAX_WS_PER_USER } from '@dsh-hub/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppDeps, BaseDeps } from '../../context.js'
import type { Clock } from '../../lib/clock.js'
import { HubError } from '../../lib/errors.js'
import { resolveSession, type SessionUser } from '../../lib/session.js'
import { findUserByUsername } from '../../lib/user-view.js'
import { hstsHeaderValue, isPublicRequest, requestOrigin } from '../../server/public-request.js'
import { createDshCookieMinter, type DshCookieMinter } from '../instances/dsh-cookie.js'
import { containerNameFor } from '../instances/spec.js'
import { resolveUpstreamTarget, type InstanceService, type UpstreamTarget } from '../instances/types.js'
import {
  buildResponseHeaders,
  buildUpstreamHeaders,
  parseLegacyProxyTarget,
  parseProxyTarget,
  wantsHtml,
  type LegacyProxyTarget,
  type ProxyTarget,
} from './headers.js'
import { injectIntoHtml } from './inject.js'
import { renderAdminWakePage, renderWakePage } from './wake-page.js'
import type { ProxyService } from './types.js'

/** 浏览器请求上游时固定使用的 authority（05 F4/F14） */
export const PROXY_AUTHORITY = '127.0.0.1:3000'
/** WS 空闲多久断开（05 §5.4：10 分钟无帧） */
export const WS_IDLE_MS = 600_000
/** WS 上更新活跃度的最小间隔 */
export const WS_ACTIVITY_THROTTLE_MS = 5_000
/** 管理员进入同一个用户实例的审计合并窗口（一次浏览会产生成百上千个请求，只记第一条） */
export const ADMIN_OPEN_AUDIT_WINDOW_MS = 10 * 60_000
/** HTML 注入允许缓冲的上限（超过就放弃注入直接丢弃连接，避免打爆内存） */
export const HTML_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024

export interface ProxyServiceOptions {
  /** 覆盖 wake.html 构建产物路径：`null` = 只用兜底页，`undefined` = 自动探测 */
  wakeHtmlPath?: string | null
  wsIdleMs?: number
}

/** 内部方法（不进 `ProxyService` 公共接口）：模块注册阶段补上 services 引用 */
export const ATTACH_SERVICES = Symbol('proxy.attachServices')

/** 代理目标实例的主人；`viaAdmin` = 访问者是管理员、主人是别人 */
interface ProxyOwner {
  id: number
  slug: string
  username: string
  viaAdmin: boolean
}

export interface InternalProxyService extends ProxyService {
  /** 代理层用的 cookie 签发器（与实例服务同一套实现，缓存按 slug） */
  minterFor(slug: string): DshCookieMinter
  /**
   * `createProxyService` 拿到的是 `createServices(base)` 里的 base（没有 `services` 字段），
   * 而 `proxyPlugin` 收到的是完整 `AppDeps`，所以在这里补上引用（延迟解析，避免循环依赖）。
   */
  [ATTACH_SERVICES](services: AppDeps['services'] | undefined): void
}

/**
 * `/dsh/<username>/*` 反向代理（04 §5、05 §5）。
 *
 * 处理顺序：解析 → 会话校验（未登录 302 到 /login，非主人 404）→ 补斜杠 301 →
 * 容器未运行返回唤醒页 → 改写头部（Host/Origin/Referer/cookie/accept-encoding）→ 转发
 * （SSE 不缓冲、HTML 注入 ownsHost、WS 双向 pipe）→ 节流记录活跃度。
 *
 * 旧的 `/u/<slug>/*` 只保留 301：先校验会话属于该 slug 的主人再跳（否则匿名访客可以用
 * slug 枚举用户名）；slug 是内部标识，容器名/数据目录/标签都不变。
 */
export function createProxyService(deps: BaseDeps, options: ProxyServiceOptions = {}): InternalProxyService {
  const minters = new Map<string, DshCookieMinter>()
  const wsCounts = new Map<number, number>()
  /**
   * 在场信息（WP33，docs/22 §6.1）：按**实例主人**记打开的 WS 数与最后断开时刻。
   * 与 `wsCounts` 不同——后者按请求者计，用于单用户上限（管理员看别人的实例时两者不同）。
   */
  const clientCounts = new Map<number, number>()
  const clientLastAt = new Map<number, number>()
  const wsIdleMs = options.wsIdleMs ?? WS_IDLE_MS
  const adminOpenAudited = new Map<string, number>()
  let attachedServices: AppDeps['services'] | undefined

  function instanceService(): InstanceService {
    const resolved = attachedServices ?? (deps as Partial<AppDeps>).services
    if (!resolved) throw new HubError('INTERNAL', 'services 尚未装配')
    return resolved.instances
  }

  function minterFor(slug: string): DshCookieMinter {
    let minter = minters.get(slug)
    if (!minter) {
      // 同 instances：签发用真实时间（可控时钟签出来的 cookie 会被实例判为过期）
      minter = createDshCookieMinter({ dshHome: deps.paths.userDshHome(slug) })
      minters.set(slug, minter)
    }
    return minter
  }

  /** 容器名与 instances 服务保持一致（前缀 = `HUB_CONTAINER_PREFIX`） */
  function nameFor(slug: string): string {
    return containerNameFor(slug, deps.config.containerPrefix)
  }

  /** 转给用户 DSH 的协议：公网请求是 https，本机请求是 http（02 §5 表格） */
  function forwardProto(publicRequest: boolean): string {
    return publicRequest ? 'https' : 'http'
  }

  /**
   * 注入返回链接用的对外 origin（WP52 / 08 §3）：
   * 7443 → `HUB_PUBLIC_ORIGIN`，边缘入口 → `HUB_EDGE_ORIGIN`，本机 7700 → 回环地址。
   */
  function originFor(req: { socket?: unknown }): string {
    return requestOrigin(req, deps.config).origin
  }

  /** 公网响应要带 HSTS；本机响应不带（`HUB_HSTS_MAX_AGE=0` 时也不带） */
  function hstsFor(req: { socket?: unknown }): string | null {
    return hstsHeaderValue(deps.config, isPublicRequest(req))
  }

  function clientIp(req: { ip?: string; socket?: { remoteAddress?: string | undefined } }): string {
    return req.ip ?? req.socket?.remoteAddress ?? '127.0.0.1'
  }

  /**
   * 谁的实例：路径用户名 == 会话用户名 → 本人；会话是管理员 → 任意未删除用户（`viaAdmin`）；
   * 其余（普通用户越权、用户名不存在、已删除）返回 null，调用方统一 404（02 §7.1）。
   */
  function resolveOwner(user: SessionUser, username: string): ProxyOwner | null {
    if (user.username === username) {
      return { id: user.id, slug: user.slug, username: user.username, viaAdmin: false }
    }
    if (user.role !== 'admin') return null
    const row = findUserByUsername(deps.db, username)
    if (!row || row.deleted_at) return null
    return { id: row.id, slug: row.slug, username: row.username, viaAdmin: true }
  }

  /** 管理员进入别人的实例要留痕；同一对（管理员, 用户）在窗口内只记一次，免得每个静态资源都写一行 */
  function auditAdminOpen(admin: SessionUser, owner: ProxyOwner, channel: 'http' | 'ws', ip: string): void {
    const key = `${String(admin.id)}:${String(owner.id)}`
    const now = deps.clock.now().getTime()
    const last = adminOpenAudited.get(key)
    if (last !== undefined && now - last < ADMIN_OPEN_AUDIT_WINDOW_MS) return
    if (adminOpenAudited.size >= 1000) {
      for (const [stale, at] of adminOpenAudited) {
        if (now - at >= ADMIN_OPEN_AUDIT_WINDOW_MS) adminOpenAudited.delete(stale)
      }
    }
    adminOpenAudited.set(key, now)
    deps.audit.log({
      actorId: admin.id,
      actorIp: ip,
      action: 'instance.admin.open',
      targetType: 'user',
      targetId: owner.id,
      detail: { username: owner.username, channel },
    })
  }

  // ── 原始响应 ──────────────────────────────────────────────────────────────

  function sendNotFound(reply: FastifyReply, extra: Record<string, string> = {}): void {
    // 02 §7.1：不是主人一律 404，不暴露 slug 是否存在
    sendJson(reply, 404, 'NOT_FOUND', '资源不存在', extra)
  }

  function sendJson(
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    extra: Record<string, string> = {},
  ): void {
    const body = JSON.stringify({ error: { code, message } })
    reply.raw.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      ...extra,
    })
    reply.raw.end(body)
  }

  function redirectToLogin(req: FastifyRequest, reply: FastifyReply): void {
    const next = encodeURIComponent(req.url)
    reply.raw.writeHead(302, {
      location: `/login?next=${next}`,
      'cache-control': 'no-store',
      ...hstsRecord(hstsFor(req)),
    })
    reply.raw.end()
  }

  function redirectSlash(target: ProxyTarget, reply: FastifyReply, extra: Record<string, string>): void {
    reply.raw.writeHead(301, {
      location: `/dsh/${target.username}/${target.search}`,
      'cache-control': 'no-store',
      ...extra,
    })
    reply.raw.end()
  }

  /**
   * 旧地址 `/u/<slug>` / `/u/<slug>/...` → 301 到 `/dsh/<username>/...`（保留子路径与查询串）。
   * 跳转前先校验会话、不是主人就 404：这样别人不能拿 slug 换用户名；未登录统一 302 登录。
   */
  function handleLegacyRedirect(
    req: FastifyRequest,
    reply: FastifyReply,
    target: LegacyProxyTarget,
    extra: Record<string, string>,
  ): void {
    // 未登录：对任何合法形状的 slug 一律 302 登录（不查库，不暴露 slug 是否存在），登录回来再判主人
    if (!req.user) {
      redirectToLogin(req, reply)
      return
    }
    if (req.user.slug !== target.slug) {
      sendNotFound(reply, extra)
      return
    }
    const tail = target.hasSlash ? target.path : '/'
    reply.raw.writeHead(301, {
      location: `/dsh/${req.user.username}${tail}${target.search}`,
      'cache-control': 'no-store',
      ...extra,
    })
    reply.raw.end()
  }

  /** HSTS 头（公网响应才有），给直接 writeHead 的响应合并用 */
  function hstsRecord(value: string | null): Record<string, string> {
    return value ? { 'strict-transport-security': value } : {}
  }

  function sendWakePage(
    reply: FastifyReply,
    input: {
      username: string
      status: string
      error?: string | null
      extra?: Record<string, string>
      /** 管理员看别人的实例：唤醒页要按目标用户 id 启动/轮询，不能走「我的实例」接口 */
      adminTargetUserId?: number
    },
  ): void {
    const page =
      input.adminTargetUserId === undefined
        ? renderWakePage({
            username: input.username,
            status: input.status as never,
            error: input.error ?? null,
            builtPath: options.wakeHtmlPath,
          })
        : renderAdminWakePage({
            username: input.username,
            status: input.status as never,
            error: input.error ?? null,
            userId: input.adminTargetUserId,
          })
    reply.raw.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(page.html)),
      'cache-control': 'no-store',
      'x-hub-instance': 'waking',
      ...(input.extra ?? {}),
    })
    reply.raw.end(page.html)
  }

  function rejectSocket(socket: Duplex, status: number, code: string): void {
    const text = JSON.stringify({ error: { code, message: code } })
    socket.write(
      `HTTP/1.1 ${String(status)} ${statusText(status)}\r\n` +
        'content-type: application/json; charset=utf-8\r\n' +
        `content-length: ${String(Buffer.byteLength(text))}\r\n` +
        'connection: close\r\n\r\n' +
        text,
    )
    socket.destroy()
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  async function handleHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const hsts = hstsFor(req)
    const hstsHeaders = hstsRecord(hsts)
    const target = parseProxyTarget(req.url)
    if (!target) {
      const legacy = parseLegacyProxyTarget(req.url)
      if (!legacy) {
        sendJson(reply, 404, 'NOT_FOUND', '资源不存在', hstsHeaders)
        return
      }
      handleLegacyRedirect(req, reply, legacy, hstsHeaders)
      return
    }
    if (!req.user) {
      redirectToLogin(req, reply)
      return
    }
    // 用户名不存在与「不是主人」走同一个 404；管理员可以进任何人的实例（resolveOwner）
    const owner = resolveOwner(req.user, target.username)
    if (!owner) {
      sendNotFound(reply, hstsHeaders)
      return
    }
    // WP0b S2：DSH 前端全用相对路径，缺斜杠会把资源解析到 /dsh/assets/…
    if (!target.hasSlash) {
      redirectSlash(target, reply, hstsHeaders)
      return
    }

    const adminTargetUserId = owner.viaAdmin ? owner.id : undefined
    const name = nameFor(owner.slug)
    const info = await deps.driver.inspect(name).catch(() => null)
    if (!info || info.state !== 'running') {
      const summary = await instanceService()
        .getSummary(owner.id)
        .catch(() => null)
      sendWakePage(reply, {
        username: target.username,
        status: summary?.status ?? 'stopped',
        error: summary?.error ?? null,
        extra: hstsHeaders,
        ...(adminTargetUserId === undefined ? {} : { adminTargetUserId }),
      })
      return
    }
    const upstream = resolveUpstreamTarget(deps.driver, info)
    if (!upstream) {
      sendWakePage(reply, {
        username: target.username,
        status: 'stopped',
        error: '容器没有可用地址',
        extra: hstsHeaders,
        ...(adminTargetUserId === undefined ? {} : { adminTargetUserId }),
      })
      return
    }

    if (owner.viaAdmin) auditAdminOpen(req.user, owner, 'http', clientIp(req))
    instanceService().touchActivity(owner.id)
    const htmlRequest = wantsHtml(req.headers)
    const cookie = minterFor(owner.slug).cookie(PROXY_AUTHORITY)
    const headers = buildUpstreamHeaders({
      headers: req.headers,
      authority: PROXY_AUTHORITY,
      cookie,
      clientIp: clientIp(req),
      protocol: forwardProto(isPublicRequest(req)),
      forceIdentity: htmlRequest,
    })

    await new Promise<void>((resolve) => {
      const upstreamReq = httpRequest(
        {
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: `${target.path}${target.search}`,
          headers,
        },
        (res) => {
          void handleUpstreamResponse(res, reply, target, htmlRequest, hsts).finally(resolve)
        },
      )
      upstreamReq.on('error', (error: Error) => {
        deps.logger.warn({ err: error, username: target.username }, '代理：上游请求失败')
        if (!reply.raw.headersSent) {
          sendJson(reply, 502, 'UPSTREAM_ERROR', '上游服务不可用', hstsHeaders)
        } else {
          reply.raw.end()
        }
        resolve()
      })
      writeRequestBody(req, upstreamReq)
    })
  }

  async function handleUpstreamResponse(
    res: IncomingMessage,
    reply: FastifyReply,
    target: ProxyTarget,
    htmlRequest: boolean,
    hsts: string | null,
  ): Promise<void> {
    const status = res.statusCode ?? 502
    const contentType = String(res.headers['content-type'] ?? '')
    const isHtml = contentType.includes('text/html')
    const isSse = contentType.includes('text/event-stream')
    const inject = htmlRequest && isHtml

    if (inject) {
      const body = await collectBody(res, HTML_BUFFER_LIMIT_BYTES)
      if (body === null) {
        deps.logger.warn({ username: target.username }, '代理：HTML 响应超过缓冲上限，放弃注入')
        if (!reply.raw.headersSent) {
          const headers = buildResponseHeaders({
            headers: res.headers,
            username: target.username,
            hsts,
          })
          reply.raw.writeHead(status, headers)
        }
        reply.raw.end()
        return
      }
      const injected = injectIntoHtml(body.toString('utf8'), { backUrl: `${originFor(reply.request)}/` })
      const payload = Buffer.from(injected.html, 'utf8')
      const headers = buildResponseHeaders({
        headers: res.headers,
        username: target.username,
        dropContentLength: injected.injected,
        hsts,
      })
      if (injected.injected) headers['content-length'] = String(payload.byteLength)
      reply.raw.writeHead(status, headers)
      reply.raw.end(payload)
      return
    }

    const headers = buildResponseHeaders({ headers: res.headers, username: target.username, hsts })
    reply.raw.writeHead(status, headers)
    if (isSse) {
      // SSE 不缓冲、不压缩、不碰 content-length（05 §5.5）
      reply.raw.flushHeaders?.()
    }
    res.pipe(reply.raw)
    await new Promise<void>((resolve) => {
      res.on('end', resolve)
      res.on('error', resolve)
      reply.raw.on('close', () => {
        res.destroy()
        resolve()
      })
    })
  }

  /** 请求体：JSON 被 Fastify 解析过就重新序列化，其余情况直接 pipe 原始流 */
  function writeRequestBody(req: FastifyRequest, upstreamReq: ReturnType<typeof httpRequest>): void {
    const body: unknown = req.body
    if (body === undefined || body === null) {
      upstreamReq.end()
      return
    }
    if (typeof body === 'string') {
      upstreamReq.end(body)
      return
    }
    if (Buffer.isBuffer(body)) {
      upstreamReq.end(body)
      return
    }
    if (isReadable(body)) {
      body.pipe(upstreamReq)
      return
    }
    upstreamReq.end(JSON.stringify(body))
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  async function handleRawUpgrade(raw: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const target = parseProxyTarget(raw.url ?? '')
    if (!target) {
      // WebSocket 没有 301 语义：旧 /u/<slug>/... 的升级请求直接拒绝，新地址是唯一入口
      rejectSocket(socket, 404, 'NOT_FOUND')
      return
    }
    const token = cookieValue(raw.headers.cookie, SESSION_COOKIE_NAME)
    const user = token ? resolveSession(deps.db, token, deps.clock.nowIso()) : null
    if (!user) {
      rejectSocket(socket, 401, 'UNAUTHENTICATED')
      return
    }
    const owner = resolveOwner(user, target.username)
    if (!owner) {
      // 越权与不存在的用户名同响应（02 §7.1）
      rejectSocket(socket, 404, 'NOT_FOUND')
      return
    }
    const current = wsCounts.get(user.id) ?? 0
    if (current >= MAX_WS_PER_USER) {
      rejectSocket(socket, 429, 'RATE_LIMITED')
      return
    }
    const name = nameFor(owner.slug)
    const info = await deps.driver.inspect(name).catch(() => null)
    if (!info || info.state !== 'running') {
      rejectSocket(socket, 404, 'INSTANCE_NOT_RUNNING')
      return
    }
    const upstream = resolveUpstreamTarget(deps.driver, info)
    if (!upstream) {
      rejectSocket(socket, 502, 'UPSTREAM_ERROR')
      return
    }

    if (owner.viaAdmin) {
      auditAdminOpen(user, owner, 'ws', clientIp({ ip: raw.socket.remoteAddress ?? undefined }))
    }
    instanceService().touchActivity(owner.id)
    const cookie = minterFor(owner.slug).cookie(PROXY_AUTHORITY)
    const headers = buildUpstreamHeaders({
      headers: raw.headers,
      authority: PROXY_AUTHORITY,
      cookie,
      clientIp: clientIp({ ip: raw.socket.remoteAddress ?? undefined }),
      // WS 也按来源分：公网经 7443 进来时是 https（用户 DSH 据此生成绝对链接）
      protocol: forwardProto(isPublicRequest(raw)),
      forceIdentity: false,
      forUpgrade: true,
    })

    await new Promise<void>((resolve) => {
      const upstreamReq = httpRequest({
        host: upstream.host,
        port: upstream.port,
        method: raw.method ?? 'GET',
        path: `${target.path}${target.search}`,
        headers,
      })
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      upstreamReq.on('upgrade', (res, upstreamSocket, upstreamHead) => {
        wsCounts.set(user.id, (wsCounts.get(user.id) ?? 0) + 1)
        clientCounts.set(owner.id, (clientCounts.get(owner.id) ?? 0) + 1)
        socket.write(upgradeResponse(res))
        if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead)
        if (head && head.length > 0) upstreamSocket.write(head)
        pipeWebSocket(socket, upstreamSocket, owner.id)
        cleanupOnClose(socket, () => {
          wsCounts.set(user.id, Math.max(0, (wsCounts.get(user.id) ?? 1) - 1))
          const remaining = Math.max(0, (clientCounts.get(owner.id) ?? 1) - 1)
          if (remaining === 0) clientCounts.delete(owner.id)
          else clientCounts.set(owner.id, remaining)
          // 最后断开时刻参与「无人状态」的休眠起点（docs/22 §6.2 的 lastClientAt）
          clientLastAt.set(owner.id, deps.clock.now().getTime())
          upstreamSocket.destroy()
        })
        finish()
      })
      upstreamReq.on('response', (res) => {
        // 上游拒绝了升级（例如 401/404）：把状态透传给浏览器
        socket.write(`HTTP/1.1 ${String(res.statusCode ?? 502)} ${statusText(res.statusCode ?? 502)}\r\n`)
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          for (const item of Array.isArray(value) ? value : [value]) socket.write(`${key}: ${item}\r\n`)
        }
        socket.write('\r\n')
        res.pipe(socket)
        res.on('end', () => {
          socket.destroy()
          finish()
        })
      })
      upstreamReq.on('error', (error: Error) => {
        deps.logger.warn({ err: error, username: target.username }, '代理：WS 上游请求失败')
        rejectSocket(socket, 502, 'UPSTREAM_ERROR')
        finish()
      })
      upstreamReq.end()
    })
  }

  /** 双向 pipe + 空闲超时 + 活跃度节流 */
  function pipeWebSocket(client: Duplex, upstream: Duplex, userId: number): void {
    let lastActivityTouch = 0
    let idleTimer: NodeJS.Timeout | null = null
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        deps.logger.info({ userId }, '代理：WS 空闲超时，断开')
        client.destroy()
        upstream.destroy()
      }, wsIdleMs)
      idleTimer.unref?.()
    }
    const touch = (): void => {
      const nowMs = deps.clock.now().getTime()
      if (nowMs - lastActivityTouch < WS_ACTIVITY_THROTTLE_MS) return
      lastActivityTouch = nowMs
      try {
        instanceService().touchActivity(userId)
      } catch {
        // services 还没装配（理论上不会）：忽略
      }
      resetIdle()
    }
    resetIdle()
    client.on('data', touch)
    upstream.on('data', touch)
    client.pipe(upstream)
    upstream.pipe(client)
    const close = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      client.destroy()
      upstream.destroy()
    }
    client.on('close', close)
    client.on('error', close)
    // 客户端半关闭（标签页被关/进程被杀）时 TCP 只给 FIN，不产生 'close'；
    // 不在这里收尾的话本连接会一直算「有人在看」，实例永远到不了「无人」状态（WP33，docs/22 §6.2）
    client.on('end', close)
    upstream.on('close', close)
    upstream.on('error', close)
  }

  return {
    [ATTACH_SERVICES](next) {
      attachedServices = next
    },

    matches(url) {
      return parseProxyTarget(url) !== null || parseLegacyProxyTarget(url) !== null
    },

    handleHttp,

    async handleUpgrade(req, socket, head) {
      await handleRawUpgrade(req.raw, socket, head)
    },

    handleRawUpgrade,

    attachUpgrade(server: Server) {
      server.on('upgrade', (req: IncomingMessage, socket, head) => {
        // `/api/**` 的升级归移动端通道（`/api/mobile/...`）与桌面中继（`/api/desktop/relay`）。
        // 反代只处理 `/dsh/<user>/*` 与 `/u/<slug>/*`；在这里就返回，避免 `rejectSocket(404)` 抢先 destroy。
        const upgradePath = (req.url ?? '').split('?')[0] ?? ''
        if (upgradePath.startsWith('/api/')) return
        void handleRawUpgrade(req, socket as Duplex, head as Buffer).catch((error: unknown) => {
          deps.logger.warn({ err: error }, '代理：WS 升级处理失败')
          rejectSocket(socket as Duplex, 500, 'INTERNAL')
        })
      })
    },

    async mintDshCookie(slug) {
      return minterFor(slug).cookie(PROXY_AUTHORITY)
    },

    async readBrowserSessionSecret(slug) {
      return minterFor(slug)
        .secret()
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '')
    },

    invalidateSecretCache(slug) {
      minters.get(slug)?.invalidate()
      minters.delete(slug)
    },

    openClients(userId) {
      return clientCounts.get(userId) ?? 0
    },

    lastClientAt(userId) {
      return clientLastAt.get(userId) ?? null
    },

    minterFor,
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const equals = trimmed.indexOf('=')
    if (equals === -1) continue
    if (trimmed.slice(0, equals) === name) return trimmed.slice(equals + 1)
  }
  return null
}

function upgradeResponse(res: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${String(res.statusCode ?? 101)} ${statusText(res.statusCode ?? 101)}`]
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

function statusText(status: number): string {
  const map: Record<number, string> = {
    101: 'Switching Protocols',
    200: 'OK',
    301: 'Moved Permanently',
    302: 'Found',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  }
  return map[status] ?? 'Error'
}

function cleanupOnClose(stream: Duplex, fn: () => void): void {
  let called = false
  const once = (): void => {
    if (called) return
    called = true
    fn()
  }
  stream.on('close', once)
  stream.on('error', once)
}

function isReadable(value: unknown): value is Readable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === 'function' &&
    typeof (value as { on?: unknown }).on === 'function'
  )
}

/** 读完上游响应体；超过上限返回 null（调用方放弃注入） */
function collectBody(res: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    res.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        res.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', () => resolve(null))
  })
}

export type { Clock, UpstreamTarget }
