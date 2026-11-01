import { createHash, createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../../lib/clock.js'
import { systemClock } from '../../lib/clock.js'
import { HubError } from '../../lib/errors.js'

/**
 * DSH 浏览器会话 cookie 的签发（05 §5）。**必须与 `@deepseek-ai/dsh-client-connection` 的
 * BrowserAuth 逐字节一致**（`test/fixtures/dsh-browser-auth.mjs` 是测试用的第二份实现）：
 *
 *   name  = 'dsh-auth-' + base64url(sha256(authority))
 *   body  = base64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))
 *   value = 'v1.' + body + '.' + base64url(hmacSha256(secret, body))
 *
 * 两条实例侧约束：`payload.authority` 必须等于实例看到的 Host；跨度不得超过
 * `cookieMaxAgeDays`（默认 30 天），所以短签勤签，超过 25 天直接抛错。
 */

/** authority 统一 `127.0.0.1:3000`（05 F4/F14：回环天然受信，插件的 localhost-only 路由可用） */
export const DEFAULT_AUTHORITY = '127.0.0.1:3000'
/** cookie 跨度上限（DSH 默认 30 天，留安全余量） */
export const MAX_COOKIE_TTL_MS = 25 * 86_400_000
/** 默认跨度 1 小时（代理每请求现签，缓存 50 分钟） */
export const DEFAULT_COOKIE_TTL_MS = 3_600_000
/** cookie 缓存时长（05 §5：50 分钟） */
export const DEFAULT_COOKIE_CACHE_MS = 3_000_000

/** base64url（无填充），与 DSH 的实现逐字符一致 */
export function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export interface DshCookie {
  name: string
  value: string
}

/** 纯函数签发：给定密钥与时刻产出 cookie 对（单元测试与 mint-cookie.mjs 逐字节对照） */
export function mintDshCookie(input: {
  authority: string
  secret: Buffer
  /** 签发时刻（毫秒） */
  now: number
  ttlMs?: number
}): DshCookie {
  const { authority, secret, now } = input
  const ttlMs = input.ttlMs ?? DEFAULT_COOKIE_TTL_MS
  if (typeof authority !== 'string' || authority.length === 0) {
    throw new HubError('INTERNAL', 'mintDshCookie: authority 不能为空')
  }
  if (secret.byteLength !== 32) {
    throw new HubError('INTERNAL', 'mintDshCookie: secret 必须是 32 字节')
  }
  if (ttlMs > MAX_COOKIE_TTL_MS) {
    throw new HubError('INTERNAL', `mintDshCookie: ttlMs ${String(ttlMs)} 超过实例 30 天上限`)
  }
  const body = b64url(
    Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + ttlMs }), 'utf8'),
  )
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  return { name, value }
}

/**
 * 从 `$DSH_HOME/.credentials.yaml` 读 browser-session 密钥。
 * 用正则而不是 YAML 解析器：DSH 写这个文件的结构稳定（一条记录 + 43 字符 base64url 密钥），
 * Hub 侧因此不需要引入 YAML 依赖，也不会碰到文件里的其它凭据。
 */
export function readBrowserSessionSecret(dshHome: string): { secret: Buffer; mtimeMs: number } {
  const file = join(dshHome, '.credentials.yaml')
  let text: string
  let mtimeMs: number
  try {
    const stat = statSync(file)
    mtimeMs = stat.mtimeMs
    text = readFileSync(file, 'utf8')
  } catch {
    throw new HubError('INSTANCE_START_FAILED', `DSH 尚未写出 browser-session 密钥：${file}`)
  }
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(text)
  if (!match?.[1]) {
    throw new HubError('INSTANCE_START_FAILED', `browser-session 密钥未出现在 ${file}`)
  }
  const secret = Buffer.from(`${match[1].replaceAll('-', '+').replaceAll('_', '/')}=`, 'base64')
  if (secret.byteLength !== 32) {
    throw new HubError('INSTANCE_START_FAILED', `${file} 里的 browser-session 密钥不是 32 字节`)
  }
  return { secret, mtimeMs }
}

export interface DshCookieMinter {
  /** 现签（带 mtime 缓存 + cookie 缓存）；容器重建后调用 `invalidate()` */
  cookie(authority: string): DshCookie
  invalidate(): void
  /** 密钥是否已可读（就绪判据 ③） */
  secretReady(): boolean
  secret(): Buffer
}

export interface DshCookieMinterOptions {
  /** 宿主上的 `users/<slug>/home/.dsh` */
  dshHome: string
  /**
   * 时间源，默认 `systemClock`（真实时间）。**生产/集成测试不要传可控时钟**：
   * 冻结在过去的时间签出来的 cookie 会被实例判为过期（401）。
   * 只有单测缓存行为时才注入。
   */
  clock?: Clock
  ttlMs?: number
  cacheMs?: number
}

/**
 * 带缓存的签发器：密钥按文件 mtime 缓存，签好的 cookie 缓存 50 分钟（05 §5）。
 * 一个用户一个实例，代理热路径上每请求调用一次也只做一次 HMAC（或直接命中缓存）。
 */
export function createDshCookieMinter(opts: DshCookieMinterOptions): DshCookieMinter {
  const clock = opts.clock ?? systemClock
  const ttlMs = opts.ttlMs ?? DEFAULT_COOKIE_TTL_MS
  const cacheMs = opts.cacheMs ?? DEFAULT_COOKIE_CACHE_MS
  let secretCache: { mtimeMs: number; secret: Buffer | null } = { mtimeMs: -1, secret: null }
  let cookieCache: { authority: string | null; cookie: DshCookie | null; mintedAt: number } = {
    authority: null,
    cookie: null,
    mintedAt: 0,
  }

  function secret(): Buffer {
    const { secret: value, mtimeMs } = readBrowserSessionSecret(opts.dshHome)
    if (mtimeMs !== secretCache.mtimeMs) secretCache = { mtimeMs, secret: value }
    return secretCache.secret ?? value
  }

  return {
    cookie(authority) {
      const nowMs = clock.now().getTime()
      const fresh =
        cookieCache.cookie !== null &&
        cookieCache.authority === authority &&
        nowMs - cookieCache.mintedAt < cacheMs
      if (fresh && cookieCache.cookie) return cookieCache.cookie
      const cookie = mintDshCookie({ authority, secret: secret(), now: nowMs, ttlMs })
      cookieCache = { authority, cookie, mintedAt: nowMs }
      return cookie
    },
    invalidate() {
      secretCache = { mtimeMs: -1, secret: null }
      cookieCache = { authority: null, cookie: null, mintedAt: 0 }
    },
    secretReady() {
      try {
        secret()
        return true
      } catch {
        return false
      }
    },
    secret,
  }
}
