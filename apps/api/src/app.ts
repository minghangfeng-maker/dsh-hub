import { createRequire } from 'node:module'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  CSRF_HEADER,
  JSON_BODY_LIMIT_BYTES,
  PLUGIN_UPLOAD_MAX_BYTES,
  REAUTH_WINDOW_MINUTES,
  SESSION_COOKIE_NAME,
  type HealthResponse,
} from '@dsh-hub/shared'
import { HUB_VERSION, loadConfig, type HubConfig } from './config.js'
import type { AppDeps, BaseDeps } from './context.js'
import { openDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { createAuditLogger } from './lib/audit.js'
import { systemClock, type Clock } from './lib/clock.js'
import { HubError, registerErrorHandler } from './lib/errors.js'
import { createEventBus } from './lib/events.js'
import { createPaths } from './lib/paths.js'
import { loadOrCreateMasterKey } from './lib/secrets.js'
import { hasRecentReauth, renewSession, resolveSession, touchSession } from './lib/session.js'
import { createSettingsStore } from './lib/settings.js'
import { isDesktopApiPath, isDeviceRouteAllowed, readDeviceBearer } from './modules/desktop/policy.js'
import { readMobileBearer } from './modules/mobile/auth.js'
import { MOBILE_ASR_PATH } from './modules/mobile/asr.js'
import { MOBILE_TTS_PATH } from './modules/mobile/tts.js'
import { createContainerDriver, createServices, registerModules } from './modules/index.js'
import type { OpsInstanceProbe } from './modules/cockpit/ops-probe.js'
import type { ContainerDriver } from './modules/instances/types.js'
import { applyHstsHeader, isPublicRequest, requestOrigin, type RequestOrigin } from './server/public-request.js'

export interface BuildAppOptions {
  config?: HubConfig
  /** 测试模式：关日志、允许注入时钟/驱动、错误处理不写 5xx 日志 */
  testing?: boolean
  driver?: ContainerDriver
  clock?: Clock
  /** 座舱容器探针（WP56a / WP56b）：缺省用「容器尚未装配」的安全默认 */
  opsProbe?: OpsInstanceProbe
  /** 覆盖 Fastify 日志配置（默认：测试 false，生产 JSON，开发 pino-pretty） */
  logger?: boolean | Record<string, unknown>
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** last_seen_at 刷新节流：每个会话最多 1 分钟写一次库 */
const SESSION_TOUCH_INTERVAL_MS = 60_000
/** 滑动续期节流：`last_seen_at` 距今超过 1 小时才延长 `expires_at`（WP1，02 §5） */
const SESSION_RENEW_INTERVAL_MS = 3_600_000

/**
 * 组装 Fastify 实例（测试与生产共用）。
 * 顺序：配置 → 时钟 → 目录/密钥 → 数据库 + 迁移 → cookie/multipart → 会话/CSRF 钩子 →
 * requireUser/requireAdmin → MUST_CHANGE_PASSWORD → /api/health → 模块注册。
 *
 * `/v1/*`（模型中转站的对外接口）不读 cookie、不受 CSRF/Origin 与强制改密影响（12 §3）。
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const testing = opts.testing ?? false
  const config = opts.config ?? loadConfig()
  const clock = opts.clock ?? systemClock
  const paths = createPaths(config.dataDir)
  paths.ensureBaseDirs()
  loadOrCreateMasterKey(paths.masterKeyFile)

  const app = Fastify({
    logger: opts.logger ?? defaultLogger(config, testing),
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    trustProxy: false,
    disableRequestLogging: testing,
  })

  const db = openDb(paths.dbFile)
  const migrationResult = runMigrations(db, { now: () => clock.nowIso(), log: (line) => app.log.info(line) })
  if (migrationResult.applied.length > 0) {
    app.log.info(`数据库迁移完成，当前版本 ${migrationResult.current}`)
  }

  const base: BaseDeps = {
    config,
    db,
    clock,
    events: createEventBus({ onError: (error) => app.log.warn({ err: error }, '事件订阅者抛错') }),
    settings: createSettingsStore(db, clock, {
      onWarn: (message, detail) => app.log.warn({ detail }, message),
    }),
    audit: createAuditLogger(db, clock),
    paths,
    driver: opts.driver ?? createContainerDriver(config),
    logger: app.log,
    testing,
    ...(opts.opsProbe === undefined ? {} : { opsProbe: opts.opsProbe }),
  }
  const deps: AppDeps = { ...base, services: createServices(base) }

  app.decorate('deps', deps)
  app.decorateRequest('user', null)
  app.decorateRequest('session', null)
  app.decorateRequest('desktop', null)
  app.decorateRequest('mobile', null)

  await app.register(cookie)
  await app.register(multipart, {
    limits: { fileSize: PLUGIN_UPLOAD_MAX_BYTES, files: 1 },
  })

  // 空 body 的 JSON 请求（例如 POST /api/me/instance/start）解析成 undefined 而不是 400：
  // 04 里不少 POST/DELETE 没有请求体，前端统一带 content-type: application/json 更省事
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : ''
    if (text.length === 0) {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(text))
    } catch {
      done(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }), undefined)
    }
  })

  registerErrorHandler(app)
  registerSessionHook(app, deps)
  registerCsrfHook(app, config)
  registerPasswordChangeGate(app)

  // 所有 /api 响应都不缓存（04 §0）；两个例外：
  // - 头像带哈希文件名，按 04 §3 允许一年强缓存；
  // - 朗读音频（WP50）按「(音色, 文字)」内容不变，契约要求 `private, max-age=86400`
  //   （App 重复点朗读 / 自动朗读同一段不再打 Hub）。只放行这一条 POST 路由。
  // 注意：这里是**精确匹配** `/api/mobile/tts`，流式朗读 `/api/mobile/tts/stream`（WP51）
  // 必须继续 no-store（边合成边下发，契约就是这么要求的），所以不能改成 startsWith。
  app.addHook('onSend', async (req, reply, payload) => {
    const cacheableAudio = req.method === 'POST' && (req.url.split('?')[0] ?? '') === MOBILE_TTS_PATH
    if (req.url.startsWith('/api') && !req.url.startsWith('/api/avatars/') && !cacheableAudio) {
      reply.header('Cache-Control', 'no-store')
    }
    // HSTS 只对经 7443 的公网响应发（02 §5）；`/dsh/<username>/` 由代理自己写响应头，那里单独加
    applyHstsHeader(reply, config, isPublicRequest(req))
    return payload
  })

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const dbOk = deps.db.ping()
    let docker: HealthResponse['docker'] = 'disabled'
    if (config.containerDriver !== 'fake') {
      try {
        docker = (await deps.driver.ping()).ok ? 'ok' : 'error'
      } catch {
        docker = 'error'
      }
    }
    return { ok: dbOk, version: HUB_VERSION, db: dbOk ? 'ok' : 'error', docker }
  })

  await registerModules(app, deps)

  app.addHook('onClose', async () => {
    await disposeDriver(deps.driver)
    // 中转站的清理定时器与代理连接池（12 §8；定时器已 unref，这里只是及时释放）
    deps.services.relay?.dispose()
    deps.events.clear()
    db.close()
  })

  return app
}

// ── 钩子 ────────────────────────────────────────────────────────────────────

/**
 * 会话解析（02 §5）：读 `hub_sid` → sha256 → sessions join users → `req.user`。
 * 过期/吊销/停用/软删除一律视为未登录；`last_seen_at` 节流刷新 + 1 小时一次的滑动续期（WP1）。
 */
function registerSessionHook(app: FastifyInstance, deps: AppDeps): void {
  const lastTouch = new Map<string, number>()
  app.addHook('onRequest', async (req) => {
    req.user = null
    req.session = null
    req.desktop = null
    req.mobile = null
    // 中转站对外接口（12 §3）用 sk-dsh-… 密钥鉴权，不读 cookie、不刷新会话
    if (req.url.startsWith('/v1/')) return
    const token = req.cookies[SESSION_COOKIE_NAME]
    // **显式设备令牌优先于 cookie**（WP56e2 修）：座舱嵌入页 `/m/?embed=cockpit` 与 `/admin` 是
    // **同源** iframe（docs/24 §6），浏览器会把管理员的 `hub_sid` 一起带上。如果按「有 cookie 就
    // 只看 cookie」，App 会用管理员身份拿到普通 bootstrap（backends=[cloud:self]），
    // 座舱通道永远连不上 —— J11 端到端就是这样发现问题的。
    // 现在只要请求里**明确**带了 `Authorization: Bearer dshm_at_…`（手机）或 `dsh_dev_…`（桌面），
    // 就按设备令牌解析并就此返回；没带才回落到 cookie 会话。
    const explicitMobile = readMobileBearer(req.headers)
    const explicitDevice = readDeviceBearer(req.headers)
    if (!token || explicitMobile !== null || explicitDevice !== null) {
      // 设备令牌（WP25a / 裁决 #6）：`Authorization: Bearer dsh_dev_…`。
      // 令牌只在 `/api/desktop/*` 与只读的 `/api/me/*` 白名单上有效，其余一律 403 —— 管理端也在 403 之内。
      const deviceToken = explicitDevice
      if (deviceToken) {
        const principal = deps.services.desktop?.resolveDeviceToken(deviceToken) ?? null
        if (!principal) throw new HubError('DEVICE_TOKEN_INVALID')
        if (!isDeviceRouteAllowed(req.method, req.url)) {
          throw new HubError('FORBIDDEN', '设备令牌只能访问桌面端接口与只读的账户信息')
        }
        req.user = principal.user
        req.desktop = principal.device
        return
      }
      // 手机 App 的设备令牌（WP40a）：`Authorization: Bearer dshm_at_…`，只对 `/api/mobile/*` 有效。
      // 失败原因决定 App 的下一步：过期/被轮换 → DEVICE_TOKEN_INVALID（去 refresh），
      // 设备被吊销/账号停用 → DEVICE_REVOKED（回登录页）。
      const mobileToken = explicitMobile
      if (mobileToken) {
        const resolved = deps.services.mobileAuth?.resolveAccessToken(mobileToken) ?? { ok: false, reason: 'invalid' }
        if (!resolved.ok) {
          throw new HubError(
            resolved.reason === 'revoked' || resolved.reason === 'account' ? 'DEVICE_REVOKED' : 'DEVICE_TOKEN_INVALID',
          )
        }
        if (!isMobileApiPath(req.url)) {
          throw new HubError('FORBIDDEN', '手机设备令牌只能访问 /api/mobile/*')
        }
        req.user = resolved.principal.user
        req.mobile = {
          deviceId: resolved.principal.deviceId,
          tokenId: resolved.principal.tokenId,
          scope: resolved.principal.scope,
        }
      }
      return
    }
    const user = resolveSession(deps.db, token, deps.clock.nowIso())
    if (!user) return
    req.user = user
    req.session = user
    const nowMs = deps.clock.now().getTime()
    const previous = lastTouch.get(user.sessionId) ?? 0
    if (nowMs - previous >= SESSION_TOUCH_INTERVAL_MS) {
      if (lastTouch.size > 10_000) lastTouch.clear()
      lastTouch.set(user.sessionId, nowMs)
      touchSession(deps.db, user.sessionId, deps.clock.nowIso())
      // 滑动续期：写库频率与 last_seen_at 刷新解耦，最多每小时一次
      if (nowMs - Date.parse(user.lastSeenAt) >= SESSION_RENEW_INTERVAL_MS) {
        renewSession(deps.db, user, deps.clock.nowIso(), {
          adminSessionHours: deps.settings.get('security').adminSessionHours,
        })
      }
    }
  })
}

/**
 * CSRF / Origin 校验（02 §5）：
 * ①非 GET 必须是 `application/json`（上传走 multipart + `X-Hub-Csrf: 1`）；
 * ②带 `Origin` 时：**公网请求（7443）只认 `HUB_PUBLIC_ORIGIN`**；本机请求（7700）另外放行
 *   localhost/127.0.0.1/[::1] 的调试源。
 * 没有 `Origin` 的请求（curl、服务端调用、WP7a 的健康检查）放行——浏览器发起的跨站请求一定带 Origin。
 */
function registerCsrfHook(app: FastifyInstance, config: HubConfig): void {
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api')) return
    if (SAFE_METHODS.has(req.method)) return
    const contentType = String(req.headers['content-type'] ?? '')
    // 没有请求体的非 GET（例如 DELETE /api/me/sessions/:id）只需要 Origin 校验。
    // 浏览器对无 body 的 POST 也会带 `Content-Length: 0`，不能把它当成「有请求体」（WP5a 联调发现）
    const contentLength = Number(req.headers['content-length'] ?? 0)
    const hasBody =
      contentType.length > 0 ||
      (Number.isFinite(contentLength) && contentLength > 0) ||
      req.headers['transfer-encoding'] !== undefined
    if (hasBody) {
      const isMultipart = contentType.startsWith('multipart/form-data')
      /**
       * WP49：`POST /api/mobile/asr` 的 body 是 WAV（`audio/wav`），不是 JSON。
       * 只对这一条路由放行，而且它仍然要过下面的 Origin 校验（带手机 Bearer 时与
       * `/api/desktop/*` 同理：不读 cookie，CSRF 面为零；cookie 路径只认 App 来源）。
       */
      const isAsrAudio =
        req.method === 'POST' &&
        (req.url.split('?')[0] ?? '') === MOBILE_ASR_PATH &&
        contentType.toLowerCase().startsWith('audio/wav')
      if (!isMultipart && !contentType.startsWith('application/json') && !isAsrAudio) {
        throw new HubError(
          'UNSUPPORTED_MEDIA',
          '非 GET 接口必须使用 application/json（上传用 multipart + X-Hub-Csrf）',
        )
      }
      if (isMultipart) {
        const header = req.headers[CSRF_HEADER]
        if (header !== '1' && header !== 'true') {
          throw new HubError('FORBIDDEN', '上传请求缺少 X-Hub-Csrf 头')
        }
      }
    }
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0) {
      // 裁决 #6：`/api/desktop/*` 只认 Bearer 设备令牌（没有 cookie，CSRF 面为零），
      // 而 Electron 渲染层会带 `Origin: dsh-app://app` —— 不豁免就会 403。
      // 其它 CSRF 要求（非 GET 必须 JSON）照旧。
      if (isDesktopApiPath(req.url)) return
      if (isMobileApiPath(req.url)) {
        // 手机 App（WP40a）：带设备令牌的请求不读 cookie（CSRF 面为零），与裁决 #6 同款；
        // **没有** Bearer 的请求（含 0.2.0 的 cookie 路径）照常走下面的 Origin 校验，
        // 只有配置里的 App 来源（https://localhost / capacitor://localhost）额外放行。
        if (readMobileBearer(req.headers) !== null) return
        if (isMobileAppOrigin(origin, config)) return
      }
      if (!isAllowedOriginForEntry(origin, config, requestOrigin(req, config))) {
        throw new HubError('FORBIDDEN', '请求来源不被信任')
      }
    }
  })
}

/** MUST_CHANGE_PASSWORD 拦截：白名单见 04 §0.2 与任务书（另放行 /api/health、/api/public/*） */
function registerPasswordChangeGate(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    // /v1 没有会话（密钥鉴权），不受强制改密影响（12 §3）
    if (req.url.startsWith('/v1/')) return
    if (!req.user?.mustChangePassword) return
    if (isPasswordChangeAllowed(req.method, req.url)) return
    throw new HubError('MUST_CHANGE_PASSWORD')
  })
}

/** 手机 App 的 API 前缀（Bearer 设备令牌 / CORS / Origin 豁免都只在这块） */
export function isMobileApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  return path.startsWith('/api/mobile/')
}

/** 这个 Origin 是不是配置里的 App 来源（`HUB_MOBILE_ORIGINS`，开发模式含 `http://localhost`） */
export function isMobileAppOrigin(origin: string, config: Pick<HubConfig, 'mobileAppOrigins'>): boolean {
  const normalized = origin.replace(/\/+$/u, '')
  return config.mobileAppOrigins.includes(normalized)
}

/**
 * `HUB_PUBLIC_ORIGIN` 一定放行；本机调试源（localhost/127.0.0.1/[::1]）**只对 7700 的本机请求**放行
 * （04 §0 第 11 条、10 §F8：公网请求带 `Origin: http://localhost:5173` 必须 403）。
 *
 * WP52：这是「按入口」判定的底层函数 —— `publicRequest` 为真时只认 `HUB_PUBLIC_ORIGIN`；
 * 边缘入口不走这里，见 `isAllowedOriginForEntry`。
 */
export function isAllowedOrigin(
  origin: string,
  config: Pick<HubConfig, 'publicOrigin'>,
  publicRequest = false,
): boolean {
  if (origin === config.publicOrigin) return true
  if (publicRequest) return false
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    )
  } catch {
    return false
  }
}

/**
 * CSRF 的 Origin 判定（WP52 / 08 §3）：**只认本请求入口的对外 origin**。
 *
 * - 7443 公网请求 → 只认 `HUB_PUBLIC_ORIGIN`；
 * - 边缘（边缘入口）请求 → 只认 `HUB_EDGE_ORIGIN`；
 * - 本机 7700 请求 → `HUB_PUBLIC_ORIGIN` + 本机调试源（沿用 `isAllowedOrigin`）。
 *
 * **不要**两个入口都认：跨入口没有合法场景，多认一个只会扩大 CSRF 面。
 */
export function isAllowedOriginForEntry(
  origin: string,
  config: Pick<HubConfig, 'publicOrigin' | 'edgeOrigin'>,
  entry: RequestOrigin,
): boolean {
  if (entry.kind === 'edge') return config.edgeOrigin !== null && origin === config.edgeOrigin
  return isAllowedOrigin(origin, config, entry.kind === 'public')
}

export function isPasswordChangeAllowed(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? ''
  if (path.startsWith('/api/auth/')) return true
  if (path === '/api/health' || path.startsWith('/api/public/')) return true
  // 头像图片：强制改密页/顶栏也要能显示（文件名为哈希，本身不泄漏资料）
  if (method === 'GET' && path.startsWith('/api/avatars/')) return true
  if (method === 'PATCH' && path === '/api/me') return true
  if (method === 'POST' && path === '/api/me/password') return true
  if (method === 'GET' && path.startsWith('/api/me')) return true
  return false
}

// ── preHandler（路由用） ────────────────────────────────────────────────────

/** 必须登录；未登录抛 UNAUTHENTICATED(401) */
export async function requireUser(req: FastifyRequest): Promise<void> {
  if (!req.user) throw new HubError('UNAUTHENTICATED')
}

/** 必须是管理员；未登录 401、非管理员 403 */
export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!req.user) throw new HubError('UNAUTHENTICATED')
  if (req.user.role !== 'admin') throw new HubError('FORBIDDEN')
}

/** 敏感操作要求最近输过密码（删用户、改密钥、下发任务），窗口默认 10 分钟 */
export function requireReauth(windowMinutes = REAUTH_WINDOW_MINUTES) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.user) throw new HubError('UNAUTHENTICATED')
    const nowIso = req.server.deps?.clock?.nowIso() ?? new Date().toISOString()
    if (!hasRecentReauth(req.user, nowIso, windowMinutes)) {
      throw new HubError('REAUTH_REQUIRED')
    }
  }
}

/** 便捷：取请求元信息（审计/限流用）；`publicRequest` 决定按 IP 的限流能不能享受回环豁免（02 §5） */
export function requestMeta(req: FastifyRequest): {
  ip: string | null
  userAgent: string | null
  publicRequest: boolean
} {
  return {
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    publicRequest: isPublicRequest(req),
  }
}

/**
 * 便捷：给 reply 写会话 cookie（WP1 的登录/注册用）。
 * `Secure` 的判定：`HUB_COOKIE_SECURE` 显式设置时一律以它为准；否则**只对经 7443 的公网请求加**
 * （02 §5：阶段二切到 https 配置后本机 7700 的登录不能被 Secure 打死，10 §F10）。
 */
export function setSessionCookie(
  reply: FastifyReply,
  config: HubConfig,
  token: string,
  opts: { expiresAt: string; remember: boolean; publicRequest?: boolean },
): void {
  const maxAge = opts.remember
    ? Math.max(0, Math.floor((Date.parse(opts.expiresAt) - Date.now()) / 1000))
    : undefined
  const secure = config.cookieSecureExplicit ? config.cookieSecure : opts.publicRequest === true
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    ...(maxAge === undefined ? {} : { maxAge }),
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
}

// ── 内部 ────────────────────────────────────────────────────────────────────

function defaultLogger(config: HubConfig, testing: boolean): boolean | Record<string, unknown> {
  if (testing) return false
  const redact = {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.api_key',
      '*.secret',
    ],
    remove: true,
  }
  const pretty = config.isProduction ? undefined : resolvePrettyTransport()
  return {
    level: config.logLevel,
    redact,
    ...(pretty ? { transport: pretty } : {}),
  }
}

/** 生产环境不装 devDependencies，所以 pino-pretty 要先探测再启用 */
function resolvePrettyTransport(): { target: string; options: Record<string, unknown> } | undefined {
  try {
    createRequire(import.meta.url).resolve('pino-pretty')
    return {
      target: 'pino-pretty',
      options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    }
  } catch {
    return undefined
  }
}

async function disposeDriver(driver: ContainerDriver): Promise<void> {
  const disposable = driver as ContainerDriver & { dispose?: () => Promise<void> }
  if (typeof disposable.dispose === 'function') await disposable.dispose()
}
