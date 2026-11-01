import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOBILE_WEB_BASE_PATH } from '@dsh-hub/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { HubConfig } from '../config.js'
import { HubError } from '../lib/errors.js'
import { isInside, resolveInside } from '../lib/paths.js'
import { isPublicRequest } from './public-request.js'

/**
 * 静态托管（04 §6）：`apps/web/dist` 由 hub-api 自己服务，不引入 @fastify/static。
 * `/assets/*` 带内容哈希 → 一年 immutable；`index.html`/`wake.html` → no-cache；
 * 其余 GET 走 SPA 兜底，但 `/api/*`、`/dsh/*`、`/u/*`、`/ca.crt` 永远不被吞掉。
 *
 * WP54b 在这里加两件事：
 * 1. **手机网页版**（契约 C2/C5/C6/C8）：`/m/` 托管 App 的网页构建。产物不在 Hub 仓库里，
 *    默认直接读单仓构建产物 `packages/mobile-ui/dist-web`（仓库根 `pnpm build` 就会产出）；
 *    生产想「构建与上线分开」时把 `HUB_MOBILE_WEB_DIR` 指到自己的发布目录（可以是符号链接）。
 * 2. **首页手机跳转**（C8）：手机 UA 打开 `GET /` / `GET /index.html` → 302 `/m/`；
 *    `?view=desktop` 记住「要看电脑版」（cookie `hub_view=desktop`，30 天），`?view=mobile` 反向。
 *
 * `src/server/` 与 `dist/server/` 到仓库根都是三层，所以这里的相对路径对两种运行方式都成立。
 */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url))

export interface StaticOptions {
  config: HubConfig
  /** 覆盖前端产物目录（测试用临时目录） */
  webDistDir?: string
  /** 覆盖手机网页版产物目录（默认取 `config.mobileWebDir`） */
  mobileWebDir?: string
  /** 根证书路径，默认 `<HUB_DATA_DIR>/secrets/tls/ca.crt`；阶段一文件不存在 → 404 */
  caCertFile?: string
}

const ASSETS_PREFIX = '/assets/'
/**
 * 交给业务路由/代理的路径前缀：静态兜底绝不接管这些（04 §6）。
 * `/dsh/` 是 DSH 的规范地址前缀（WP16），`/u/` 继续保留（旧地址 301 跳转用），
 * `/v1/` 是模型中转站的对外接口（12 §3）。
 */
const RESERVED_PREFIXES = ['/api/', '/dsh/', '/u/', '/v1/']

/** 手机网页版前缀（契约 C2 冻结为 `/m/`，这里从 shared 常量派生，避免两处写法漂移） */
const MOBILE_WEB_PREFIX = MOBILE_WEB_BASE_PATH.replace(/\/+$/u, '') // '/m'
const MOBILE_WEB_INDEX = 'index.html'
const MOBILE_WEB_VERSION_FILE = 'version.json'
const MOBILE_WEB_ASSETS_DIR = 'assets'

/** 缓存策略字面量（契约 C6） */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
const CACHE_NO_CACHE = 'no-cache'
const CACHE_NO_STORE = 'no-store'

/**
 * Hub 自身页面的 CSP：只允许同源资源；Naive UI 在运行时写 inline style，必须放行 `style-src 'unsafe-inline'`
 * （07 §2 的令牌都是 CSS 变量，不放行 inline script）。代理路径 `/dsh/*`、`/u/*` 不加 CSP —— 那是 DSH 自己的页面。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

/**
 * `/m/` 的专用 CSP（契约 §3 WP54b）：在 Hub 页面那份基础上多放行三件事——
 * `media-src blob:`（语音/录音回放）、`worker-src blob:`（打包器可能用 blob worker）、
 * `manifest-src 'self'`（PWA manifest 不属于 default-src 的覆盖范围）。
 * 其余（脚本/样式/连接）与 Hub 页面同样的收紧策略，允许内联样式是因为构建产物会写 inline style。
 */
export const MOBILE_WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ')

/**
 * 首页「我要看电脑版」的偏好 cookie（契约 C8）。
 * 只有 `desktop` 一个值：存在即表示「这台手机的用户明确选了电脑版」。
 */
const VIEW_COOKIE_NAME = 'hub_view'
const VIEW_COOKIE_DESKTOP = 'desktop'
const VIEW_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * 手机 UA（契约 C8 原文）：`/Android.+Mobile|iPhone|iPod|HarmonyOS.+Mobile|Mobile.+Safari/i`。
 * **不含平板**：iPad 的传统 UA 里也有 `Mobile/… Safari`，会被这条正则命中，
 * 所以再用 `TABLET_UA_RE` 排掉 iPad/Tablet/Kindle 这类；Android 平板本身没有 `Mobile` 字样，
 * 不用额外处理。
 */
const MOBILE_UA_RE = /Android.+Mobile|iPhone|iPod|HarmonyOS.+Mobile|Mobile.+Safari/i
const TABLET_UA_RE = /iPad|Tablet|PlayBook|Silk|Kindle/i

/** 扩展名 → Content-Type；未知一律 octet-stream（配合 nosniff） */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.crt': 'application/x-x509-ca-cert',
  '.zip': 'application/zip',
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * `/m/` 下相对路径的缓存策略（契约 C6）：
 * - `index.html`、`version.json` → `no-store`（发版后下一次请求立刻拿到新的）；
 * - `assets/*`（带内容哈希）→ 一年 immutable；
 * - 其它 → `no-cache`（图标、manifest 等：每次协商，别把旧图标钉死一年）。
 */
export function mobileWebCacheControl(rel: string): string {
  const normalized = rel.replace(/^\/+/u, '')
  if (normalized === MOBILE_WEB_INDEX || normalized === MOBILE_WEB_VERSION_FILE) return CACHE_NO_STORE
  if (normalized === MOBILE_WEB_ASSETS_DIR || normalized.startsWith(`${MOBILE_WEB_ASSETS_DIR}/`)) {
    return CACHE_IMMUTABLE
  }
  return CACHE_NO_CACHE
}

/** 手机 UA 判定（契约 C8）：含手机浏览器才算，平板一律按电脑版处理 */
export function isMobileUserAgent(ua: string | string[] | undefined): boolean {
  const value = Array.isArray(ua) ? ua[0] : ua
  if (typeof value !== 'string' || value.length === 0) return false
  if (TABLET_UA_RE.test(value)) return false
  return MOBILE_UA_RE.test(value)
}

/**
 * 注册静态托管与 SPA 兜底。挂载在独立封装作用域里：
 * 安全响应头只作用于 Hub 自己的页面，不会污染 `/api/*` 与代理 `/dsh/*`、`/u/*`。
 */
export async function registerStatic(app: FastifyInstance, opts: StaticOptions): Promise<void> {
  const webDistDir = opts.webDistDir ?? DEFAULT_WEB_DIST_DIR
  const mobileWebDir = opts.mobileWebDir ?? opts.config.mobileWebDir
  const caCertFile = opts.caCertFile ?? join(opts.config.dataDir, 'secrets', 'tls', 'ca.crt')

  await app.register(async (scope) => {
    // 02 §7.4 的同类头部：Hub 自己的页面也不许被嗅探/被外站当 Referer/被嵌套
    scope.addHook('onSend', async (req, reply, payload) => {
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Referrer-Policy', 'same-origin')
      reply.header('X-Frame-Options', 'SAMEORIGIN')
      // `/m/` 的网页版是另一个应用（多了 media/worker/manifest），CSP 单独一份（契约 §3 WP54b）
      reply.header(
        'Content-Security-Policy',
        isMobileWebPath(req.url) ? MOBILE_WEB_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY,
      )
      return payload
    })

    // 阶段一没有 TLS，也就没有根证书；文件一出现（WP7b）这里自动开始提供下载（08 §3）
    scope.get('/ca.crt', async (_req, reply) => {
      const info = await statOrNull(caCertFile)
      if (!info?.isFile()) throw new HubError('NOT_FOUND', '根证书尚未生成')
      return sendFile(reply, caCertFile, CACHE_NO_CACHE)
    })

    // 带内容哈希的构建产物：一年 immutable
    scope.get(`${ASSETS_PREFIX}*`, async (req, reply) => {
      const rel = (req.params as Record<string, string>)['*'] ?? ''
      const file = resolveInside(join(webDistDir, 'assets'), rel)
      const info = await statOrNull(file)
      if (!info?.isFile()) throw new HubError('NOT_FOUND')
      return sendFile(reply, file, CACHE_IMMUTABLE)
    })

    // ── 手机网页版（WP54b / 契约 C2、C5、C6）─────────────────────────────────
    // `/m` → 301 `/m/`：相对路径的 App base 与 cookie/scope 都按带斜杠的目录算
    scope.get(MOBILE_WEB_PREFIX, async (req, reply) => {
      // `/m?x=1` → `/m/?x=1`：查询串原样带过去，别把 `?view=desktop` 这类参数丢掉
      const questionMark = req.url.indexOf('?')
      const query = questionMark === -1 ? '' : req.url.slice(questionMark + 1)
      const location = query === '' ? MOBILE_WEB_BASE_PATH : `${MOBILE_WEB_BASE_PATH}?${query}`
      return reply.header('Cache-Control', CACHE_NO_CACHE).redirect(location, 301)
    })

    scope.get(`${MOBILE_WEB_PREFIX}/*`, async (req, reply) => {
      const rel = (req.params as Record<string, string>)['*'] ?? ''
      return serveMobileWeb(reply, mobileWebDir, rel)
    })

    // ── 首页（契约 C8）：手机 UA 直接进网页版 ─────────────────────────────────
    const home = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
      serveHome(req, reply, { config: opts.config, webDistDir })

    scope.get('/', home)
    scope.get('/index.html', home)

    // `wake.html` 不走首页逻辑：它不是「首页」，手机跳转（C8）不该碰它
    scope.get('/wake.html', async (_req, reply) => {
      const file = join(webDistDir, 'wake.html')
      const info = await statOrNull(file)
      if (!info?.isFile()) throw new HubError('NOT_FOUND')
      return sendFile(reply, file, CACHE_NO_CACHE)
    })

    // 兜底：先看 dist 里有没有这个真实文件，没有就给 SPA 入口（04 §6）
    scope.get('/*', async (req, reply) => {
      // 用路由参数而不是 req.url：find-my-way 已经解过码，也不会带 query（req.url 会）
      const pathname = `/${(req.params as Record<string, string>)['*'] ?? ''}`
      if (isReserved(pathname)) return reply.callNotFound()

      const file = resolveInside(webDistDir, pathname === '/' ? 'index.html' : pathname.slice(1))
      const info = await statOrNull(file)
      if (info?.isFile()) return sendFile(reply, file, CACHE_NO_CACHE)

      const indexHtml = join(webDistDir, 'index.html')
      const indexInfo = await statOrNull(indexHtml)
      if (!indexInfo?.isFile()) {
        throw new HubError('INTERNAL', '前端产物不存在，请先在仓库根执行 pnpm build')
      }
      return sendFile(reply, indexHtml, CACHE_NO_CACHE)
    })
  })
}

/**
 * 首页：`GET /` 与 `GET /index.html`（契约 C8）。
 *
 * - `?view=desktop`：写 `hub_view=desktop`（30 天）后**直接**出电脑版首页，不再 302 到 `/`：
 *   少一次往返，也避免「跳回 `/` 又被 UA 判到 `/m/`」这类自作聪明的环路。
 * - `?view=mobile`：清 cookie 再 302 `/m/`（用户明确要手机版，UA 判不判都去）。
 * - 手机 UA 且没有 `hub_view=desktop`：302 `/m/`，响应 `no-store` + `Vary: User-Agent, Cookie`
 *   （同一个 URL 对不同的 UA/cookie 结果不同，中间缓存必须分开存）。
 * - 其余：电脑版首页，行为与 WP54 之前逐字节一致（`no-cache`）。
 */
async function serveHome(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: { config: HubConfig; webDistDir: string },
): Promise<FastifyReply> {
  const view = readViewParam(req)

  if (view === 'desktop') {
    setViewCookie(reply, req, ctx.config)
    return sendIndexHtml(reply, ctx.webDistDir, CACHE_NO_STORE)
  }
  if (view === 'mobile') {
    clearViewCookie(reply, req, ctx.config)
    return redirectToMobileWeb(reply)
  }
  if (isMobileUserAgent(req.headers['user-agent']) && readViewCookie(req) !== VIEW_COOKIE_DESKTOP) {
    return redirectToMobileWeb(reply)
  }
  return sendIndexHtml(reply, ctx.webDistDir, CACHE_NO_CACHE)
}

/** 电脑版首页 HTML（`no-store`/`no-cache` 由调用方定；缺失时给明确提示而不是空响应） */
async function sendIndexHtml(
  reply: FastifyReply,
  webDistDir: string,
  cacheControl: string,
): Promise<FastifyReply> {
  const indexHtml = join(webDistDir, 'index.html')
  const info = await statOrNull(indexHtml)
  if (!info?.isFile()) {
    throw new HubError('INTERNAL', '前端产物不存在，请先在仓库根执行 pnpm build')
  }
  return sendFile(reply, indexHtml, cacheControl)
}

/** `/` 与 `/index.html` → `/m/`：不缓存，且按 UA + cookie 分桶 */
function redirectToMobileWeb(reply: FastifyReply): FastifyReply {
  return reply
    .header('Vary', 'User-Agent, Cookie')
    .header('Cache-Control', CACHE_NO_STORE)
    .redirect(MOBILE_WEB_BASE_PATH, 302)
}

/**
 * 托管 `/m/` 下的一个 GET（契约 C2/C5/C6）。
 *
 * 顺序很重要：
 * 1. 先判解码后的路径（find-my-way 已经把 `%2e%2e` 解码成 `..`），越界/点文件一律 404——
 *    不能「当作没找到」去回 index.html，那等于把拒绝变成伪装的成功；
 * 2. 再 realpath **托管目录**：`current` 是发布脚本原子切换的符号链接，必须每次请求重新解析，
 *    否则切了 release 要等 Hub 重启才生效；
 * 3. 最后 realpath **目标文件**并确认仍在目录内：目录里也可能有符号链接指到外面（`assets/x -> /etc/passwd`）；
 * 4. 目录不存在 / 没有 index.html → 503 中文小页面（网页版还没部署是正常状态，不是 500）。
 */
async function serveMobileWeb(reply: FastifyReply, mobileWebDir: string, rel: string): Promise<FastifyReply> {
  if (!isSafeMobileWebRel(rel)) throw new HubError('NOT_FOUND')

  const root = await realMobileWebRoot(mobileWebDir)
  if (root === null) return sendMobileWebUnavailable(reply)

  if (rel !== '') {
    const file = await realMobileWebFile(root, rel)
    if (file !== null) return sendFile(reply, file, mobileWebCacheControl(rel))
    // 带扩展名的都是「资源」（assets/*、version.json、图标、manifest）：没有就 404，绝不回 index.html
    if (extname(rel) !== '') throw new HubError('NOT_FOUND')
  }

  // 无扩展名的深链接兜底到 index.html（网页版用 hash 路由，正常请求只有 `/m/`；
  // 万一以后改成 history 路由也不会 404，代价只是多读一次文件）
  const index = await realMobileWebFile(root, MOBILE_WEB_INDEX)
  if (index === null) return sendMobileWebUnavailable(reply)
  return sendFile(reply, index, mobileWebCacheControl(MOBILE_WEB_INDEX))
}

/** 解码后的相对路径是否只指向目录内：拒绝绝对路径、NUL、空段、`.`/`..`、点文件 */
function isSafeMobileWebRel(rel: string): boolean {
  if (rel === '') return true
  if (rel.includes('\0')) return false
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(rel)) return false
  return rel.split('/').every((segment) => segment !== '' && !segment.startsWith('.'))
}

/** 每次请求重新解析托管目录（`current` 原子切换后立刻生效）；不存在/不是目录 → null */
async function realMobileWebRoot(dir: string): Promise<string | null> {
  try {
    const real = await realpath(dir)
    const info = await stat(real)
    return info.isDirectory() ? real : null
  } catch {
    return null
  }
}

/** 解析目录内的一个真实文件：realpath 解析后仍须落在根目录内（防目录内符号链接逃逸） */
async function realMobileWebFile(root: string, rel: string): Promise<string | null> {
  let candidate: string
  try {
    candidate = resolveInside(root, rel)
  } catch {
    return null
  }
  try {
    const real = await realpath(candidate)
    if (!isInside(root, real)) return null
    const info = await stat(real)
    return info.isFile() ? real : null
  } catch {
    return null
  }
}

/**
 * 网页版还没部署时的 503 页：中文说明 + 一个「打开电脑版」的出口。
 * 用内联样式（`/m/` 的 CSP 允许 `style-src 'unsafe-inline'`），不引任何外部资源——
 * 这时候 `/m/` 目录本身可能都不存在，任何相对资源都会再 503 一次。
 */
const MOBILE_WEB_UNAVAILABLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>手机网页版暂未部署</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
padding:24px;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
background:#f5f6f8;color:#1f2329;line-height:1.6}
@media (prefers-color-scheme:dark){body{background:#15171a;color:#e6e8eb}}
main{max-width:22rem;text-align:center}
h1{margin:0 0 .75rem;font-size:1.25rem}
p{margin:0 0 1.5rem;font-size:.95rem;opacity:.8}
a{display:inline-block;padding:.7rem 1.4rem;border-radius:.6rem;background:#3b6cf0;color:#fff;
text-decoration:none;font-weight:600}
a:active{opacity:.85}
</style>
</head>
<body>
<main>
<h1>手机网页版暂未部署</h1>
<p>这个入口还没有发布手机网页版，请稍后再试，或者先用电脑打开完整版。</p>
<a href="/?view=desktop">打开电脑版</a>
</main>
</body>
</html>
`

async function sendMobileWebUnavailable(reply: FastifyReply): Promise<FastifyReply> {
  return reply
    .code(503)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', CACHE_NO_STORE)
    .header('Retry-After', '300')
    .send(MOBILE_WEB_UNAVAILABLE_HTML)
}

/** 请求路径是否属于 `/m/`（决定用哪份 CSP；`/mobile` 之类不算） */
function isMobileWebPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? ''
  return pathname === MOBILE_WEB_PREFIX || pathname.startsWith(`${MOBILE_WEB_PREFIX}/`)
}

/** `?view=desktop|mobile`；重复参数取最后一个（`?view=mobile&view=desktop` 以 desktop 为准） */
function readViewParam(req: FastifyRequest): 'desktop' | 'mobile' | null {
  const query = req.query as Record<string, unknown> | null | undefined
  if (query === null || typeof query !== 'object') return null
  const raw = query.view
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw
  if (value === 'desktop' || value === 'mobile') return value
  return null
}

function readViewCookie(req: FastifyRequest): string | undefined {
  return req.cookies?.[VIEW_COOKIE_NAME]
}

/** cookie 的 `Secure` 判定与 `setSessionCookie` 一致：显式配置优先，否则只有公网监听器（7443/edge）加 */
function viewCookieSecure(req: FastifyRequest, config: HubConfig): boolean {
  return config.cookieSecureExplicit ? config.cookieSecure : isPublicRequest(req)
}

function setViewCookie(reply: FastifyReply, req: FastifyRequest, config: HubConfig): void {
  reply.setCookie(VIEW_COOKIE_NAME, VIEW_COOKIE_DESKTOP, {
    path: '/',
    maxAge: VIEW_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    httpOnly: true,
    secure: viewCookieSecure(req, config),
  })
}

function clearViewCookie(reply: FastifyReply, req: FastifyRequest, config: HubConfig): void {
  reply.clearCookie(VIEW_COOKIE_NAME, {
    path: '/',
    sameSite: 'lax',
    secure: viewCookieSecure(req, config),
  })
}

function isReserved(pathname: string): boolean {
  if (pathname === '/ca.crt') return true
  // `/dsh`（不带斜杠）也不能落到 SPA：DSH 前端全是相对路径，进 SPA 没有任何意义
  if (pathname === '/dsh') return true
  // `/m` 与 `/m/*` 由上面的手机网页版路由接管；写进保留前缀是「永远不会被 SPA 吞掉」的兜底
  if (pathname === MOBILE_WEB_PREFIX || pathname.startsWith(`${MOBILE_WEB_PREFIX}/`)) return true
  return RESERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/** 读文件失败（不存在/权限/是目录）一律当作「没有」，交给上层决定 404 还是 SPA */
async function statOrNull(file: string): Promise<{ isFile(): boolean } | null> {
  try {
    return await stat(file)
  } catch {
    return null
  }
}

/** 流式回送；`Content-Length` 由 Fastify 从 stream 推断不了，所以显式带上 */
async function sendFile(reply: FastifyReply, file: string, cacheControl: string): Promise<FastifyReply> {
  const info = await stat(file)
  return reply
    .header('Content-Type', contentTypeFor(file))
    .header('Content-Length', String(info.size))
    .header('Cache-Control', cacheControl)
    .send(createReadStream(file))
}
