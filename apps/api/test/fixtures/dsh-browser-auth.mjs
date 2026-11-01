/**
 * DSH 浏览器会话 cookie 的**参考实现**（测试夹具）。
 *
 * Hub 的 `modules/instances/dsh-cookie.ts` 必须与本文件以及
 * `@deepseek-ai/dsh-client-connection` 的 BrowserAuth **逐字节等价**：
 *
 *   name    = "dsh-auth-" + base64url(sha256(authority))
 *   body    = base64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))
 *   value   = "v1." + body + "." + base64url(hmac_sha256(secret, body))
 *   secret  = base64url-decode(records["client-connection/browser-session"].payload.secret)
 *
 * 两条实例侧约束：
 *   * payload.authority 必须等于实例看到的 Host，cookie 名也由同一 authority 推出；
 *   * expiresAt - issuedAt 不得超过实例的 cookieMaxAgeDays（默认 30 天）——所以短签勤签。
 *
 * 这里是独立的第二份实现，故意不复用 src/ 里的任何代码：两份实现算出的字符串一样，
 * 才说明 Hub 侧没写歪（差一个字符实例就会 401，而且是那种「看起来都对」的故障）。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** cookie 跨度上限（DSH 默认 cookieMaxAgeDays=30），留出安全余量。 */
export const MAX_TTL_MS = 25 * 86_400_000
/** 默认跨度：Hub 每个请求现签，1 小时足够且远小于上限。 */
export const DEFAULT_TTL_MS = 3_600_000

/** base64url（无填充），与 DSH 的实现逐字符一致。 */
export function b64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * 从 DSH_HOME 目录读 browser-session 密钥。
 *
 * 用正则而不是 YAML 解析器：DSH 用固定结构写这个文件（`records:` 下一条
 * `client-connection/browser-session:`，其 `payload.secret` 是 43 字符 base64url），
 * 测试因此不需要引入 YAML 依赖。文件缺失/结构变化时抛错。
 *
 * @param dshHome - 容器里 `$DSH_HOME` 在宿主上对应的目录（`users/<slug>/home/.dsh`）
 * @returns 32 字节密钥
 */
export function readBrowserSessionSecret(dshHome) {
  const path = join(dshHome, '.credentials.yaml')
  const text = readFileSync(path, 'utf8')
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(text)
  if (!match) throw new Error(`browser-session secret not found in ${path}`)
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
  if (secret.byteLength !== 32) throw new Error(`browser-session secret in ${path} is not 32 bytes`)
  return secret
}

/**
 * 纯函数签发：给定密钥与时刻，产出 `name=value`。
 * @param options.authority - 上游将看到的 authority（`dshhub-<slug>:3000`）
 * @param options.secret - 32 字节密钥
 * @param options.now - 签发时刻（毫秒）；测试注入用
 * @param options.ttlMs - 跨度，超过 {@link MAX_TTL_MS} 直接抛错（签了也会被实例拒）
 * @returns cookie 对（`dsh-auth-…=v1.…`）
 */
export function mintCookie({ authority, secret, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  if (typeof authority !== 'string' || authority === '') throw new Error('mintCookie: authority is required')
  if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) {
    throw new Error('mintCookie: secret must be a 32-byte Buffer')
  }
  if (ttlMs > MAX_TTL_MS) throw new Error(`mintCookie: ttlMs ${String(ttlMs)} exceeds the 30-day instance limit`)
  const body = b64url(
    Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + ttlMs }), 'utf8'),
  )
  const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  return `${name}=${value}`
}

/**
 * 带 mtime 缓存的签发器（05 §5：密钥按文件 mtime 缓存，cookie 缓存 50 分钟）。
 *
 * @param options.dshHome - 宿主上的 DSH_HOME 目录
 * @param options.ttlMs - cookie 跨度
 * @param options.cacheMs - cookie 复用时长（默认 50 分钟）
 * @returns `{ cookie(authority): string, invalidate(): void }`
 */
export function createCookieMinter({ dshHome, ttlMs = DEFAULT_TTL_MS, cacheMs = 3_000_000 }) {
  let secretCache = { mtimeMs: -1, secret: null }
  let cookieCache = { authority: null, value: null, mintedAt: 0 }

  function secret() {
    const path = join(dshHome, '.credentials.yaml')
    const { mtimeMs } = statSync(path)
    if (mtimeMs !== secretCache.mtimeMs) {
      secretCache = { mtimeMs, secret: readBrowserSessionSecret(dshHome) }
    }
    return secretCache.secret
  }

  return {
    cookie(authority) {
      const fresh =
        cookieCache.authority === authority && Date.now() - cookieCache.mintedAt < cacheMs && cookieCache.value
      if (fresh) return cookieCache.value
      const value = mintCookie({ authority, secret: secret(), ttlMs })
      cookieCache = { authority, value, mintedAt: Date.now() }
      return value
    },
    invalidate() {
      secretCache = { mtimeMs: -1, secret: null }
      cookieCache = { authority: null, value: null, mintedAt: 0 }
    },
  }
}
