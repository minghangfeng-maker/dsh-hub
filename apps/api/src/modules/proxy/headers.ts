import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { SLUG_REGEX, USERNAME_REGEX } from '@dsh-hub/shared'
import type { DshCookie } from './types.js'

/**
 * 代理的头部改写规则（05 §5、02 §7）。全部做成纯函数，方便单测逐条断言。
 */

/** 逐跳头部：不能透传（RFC 9110 §7.6.1） */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface ProxyTarget {
  username: string
  /** 有斜杠形态区分：`/dsh/<username>` 必须 301（WP0b S2） */
  hasSlash: boolean
  /** 去掉 `/dsh/<username>` 之后的路径（总是以 `/` 开头） */
  path: string
  /** `?a=1`（含 `?`，没有查询串时是空串） */
  search: string
}

/** 旧的 `/u/<slug>` 地址（只用于 301 到规范地址，不再承载代理流量） */
export interface LegacyProxyTarget {
  slug: string
  hasSlash: boolean
  /** 去掉 `/u/<slug>` 之后的路径（保留给跳转地址） */
  path: string
  search: string
}

interface SplitUrl {
  pathname: string
  search: string
}

function splitUrl(url: string): SplitUrl {
  const queryIndex = url.indexOf('?')
  return queryIndex === -1
    ? { pathname: url, search: '' }
    : { pathname: url.slice(0, queryIndex), search: url.slice(queryIndex) }
}

/** 解析 `/dsh/<username>[/...][?query]`；不是代理路径或用户名不合法时返回 null */
export function parseProxyTarget(url: string): ProxyTarget | null {
  const { pathname, search } = splitUrl(url)
  if (!pathname.startsWith('/dsh/')) return null
  const rest = pathname.slice(5)
  const slashIndex = rest.indexOf('/')
  const username = slashIndex === -1 ? rest : rest.slice(0, slashIndex)
  if (!USERNAME_REGEX.test(username)) return null
  const tail = slashIndex === -1 ? '' : rest.slice(slashIndex)
  return { username, hasSlash: slashIndex !== -1, path: tail === '' ? '/' : tail, search }
}

/** 解析旧的 `/u/<slug>[/...][?query]`；slug 不合法时返回 null */
export function parseLegacyProxyTarget(url: string): LegacyProxyTarget | null {
  const { pathname, search } = splitUrl(url)
  if (!pathname.startsWith('/u/')) return null
  const rest = pathname.slice(3)
  const slashIndex = rest.indexOf('/')
  const slug = slashIndex === -1 ? rest : rest.slice(0, slashIndex)
  if (!SLUG_REGEX.test(slug)) return null
  const tail = slashIndex === -1 ? '' : rest.slice(slashIndex)
  return { slug, hasSlash: slashIndex !== -1, path: tail === '' ? '/' : tail, search }
}

/** 浏览器带来的 cookie 里要丢掉的：Hub 自己的会话 + 任何 DSH 认证 cookie（02 §7.2） */
export function shouldDropCookie(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return lower === 'hub_sid' || lower.startsWith('dsh-auth-')
}

/** 删掉 `hub_sid` 与 `dsh-auth-*`，追加现签的 DSH cookie */
export function buildCookieHeader(existing: string | undefined, injected: DshCookie): string {
  const kept: string[] = []
  for (const part of (existing ?? '').split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const equals = trimmed.indexOf('=')
    const name = equals === -1 ? trimmed : trimmed.slice(0, equals)
    if (shouldDropCookie(name)) continue
    kept.push(trimmed)
  }
  kept.push(`${injected.name}=${injected.value}`)
  return kept.join('; ')
}

/** `Origin: https://hub.example` → `http://<authority>`（只保留「是个源」这一点） */
export function rewriteOriginHeader(origin: string | undefined, authority: string): string | undefined {
  if (!origin) return undefined
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `http://${authority}`
  } catch {
    return undefined
  }
}

/** `Referer: https://hub.example/dsh/x/foo` → `http://<authority>/dsh/x/foo`（只改 origin，路径按 05 §5.3 原样保留） */
export function rewriteRefererHeader(referer: string | undefined, authority: string): string | undefined {
  if (!referer) return undefined
  try {
    const url = new URL(referer)
    return `http://${authority}${url.pathname}${url.search}`
  } catch {
    return undefined
  }
}

/** 请求头里是否要 HTML（决定要不要把 accept-encoding 改成 identity 才能注入） */
export function wantsHtml(headers: IncomingHttpHeaders): boolean {
  const accept = headers.accept
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '')
  return value.includes('text/html') || value.includes('*/*')
}

export interface UpstreamHeaderInput {
  headers: IncomingHttpHeaders
  authority: string
  cookie: DshCookie
  /** 客户端真实 IP（写 x-forwarded-for） */
  clientIp: string
  /** 客户端协议（写 x-forwarded-proto） */
  protocol: string
  /** 是否把 accept-encoding 固定成 identity（HTML 文档要注入，压缩体没法注入） */
  forceIdentity: boolean
  /** WebSocket 升级：保留 upgrade/connection 与 sec-websocket-* */
  forUpgrade?: boolean
}

/** 构造发往容器的请求头 */
export function buildUpstreamHeaders(input: UpstreamHeaderInput): OutgoingHttpHeaders {
  const source = input.headers
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) && !(input.forUpgrade && (lower === 'connection' || lower === 'upgrade'))) {
      continue
    }
    if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer') continue
    if (lower === 'accept-encoding') continue
    if (lower.startsWith('x-forwarded')) continue
    out[key] = value
  }
  out.host = input.authority
  out.cookie = buildCookieHeader(asString(source.cookie), input.cookie)
  if (input.forceIdentity) out['accept-encoding'] = 'identity'
  else if (source['accept-encoding'] !== undefined) out['accept-encoding'] = source['accept-encoding']
  out['x-forwarded-for'] = input.clientIp
  out['x-forwarded-proto'] = input.protocol
  const origin = rewriteOriginHeader(asString(source.origin), input.authority)
  if (origin) out.origin = origin
  const referer = rewriteRefererHeader(asString(source.referer), input.authority)
  if (referer) out.referer = referer
  return out
}

export interface DownstreamHeaderInput {
  headers: IncomingHttpHeaders
  /** 规范地址里的用户名（cookie Path 用 `/dsh/<username>/`） */
  username: string
  /** HTML 注入后要重算 content-length */
  dropContentLength?: boolean
  /** HSTS 头值（只对经 7443 的公网响应传，见 server/public-request.ts） */
  hsts?: string | null
}

/**
 * 构造回给浏览器的响应头：
 * 去逐跳头、丢弃 `dsh-auth-*` 的 Set-Cookie、其它 cookie 的 `Path` 改写到前缀下并去 `Domain`，
 * 加 `X-Frame-Options: SAMEORIGIN` 与 `Referrer-Policy: same-origin`（02 §7.3/§7.4）。
 */
export function buildResponseHeaders(input: DownstreamHeaderInput): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(input.headers)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'set-cookie') continue
    if (input.dropContentLength && lower === 'content-length') continue
    out[key] = value
  }
  const cookies = rewriteSetCookies(input.headers['set-cookie'], input.username)
  if (cookies.length > 0) out['set-cookie'] = cookies
  out['x-frame-options'] = 'SAMEORIGIN'
  out['referrer-policy'] = 'same-origin'
  // HSTS 要盖过上游可能带来的同名头：公网响应必须带（任务书 §1.4）
  if (input.hsts) out['strict-transport-security'] = input.hsts
  return out
}

/** 上游的 Set-Cookie 处理：`dsh-auth-*` 丢弃；其余把 Path 改到 `/dsh/<username>/` 下、去掉 Domain */
export function rewriteSetCookies(value: string[] | string | undefined, username: string): string[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value]
  const result: string[] = []
  for (const raw of list) {
    const segments = raw.split(';').map((segment) => segment.trim())
    const first = segments[0] ?? ''
    const name = first.slice(0, Math.max(0, first.indexOf('=')))
    if (shouldDropCookie(name)) continue
    const attributes: string[] = []
    let hasPath = false
    for (const segment of segments.slice(1)) {
      const lower = segment.toLowerCase()
      if (lower.startsWith('domain=')) continue
      if (lower.startsWith('path=')) {
        attributes.push(`Path=/dsh/${username}/`)
        hasPath = true
        continue
      }
      if (segment.length > 0) attributes.push(segment)
    }
    if (!hasPath) attributes.push(`Path=/dsh/${username}/`)
    result.push([first, ...attributes].join('; '))
  }
  return result
}

function asString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(', ') : value
}
