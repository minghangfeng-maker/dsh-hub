/**
 * 令牌存储。
 *
 * 硬要求（任务包 A1 第 3 条 / 开发文档 §6.1）：access 与 refresh 令牌必须放在
 * Android Keystore 加密存储里，**不能**放普通 preferences，也不能放 localStorage。
 *
 * 这一层只定义「存什么、怎么校验」，具体后端由平台注入：
 *   - Android/iOS：`SecureTokenStore` + `@aparajita/capacitor-secure-storage`
 *     （Android 侧是 EncryptedSharedPreferences + Keystore 主密钥）；
 *   - Web 开发 / e2e：内存（`MemoryTokenStore`），刷新页面就要重新登录；
 *   - 单测：内存或可控的假后端。
 *
 * 任何时候都不打印令牌内容；`describeTokens()` 只给出长度与到期时间，方便诊断。
 */

import { AuthTokensSchema, type AuthTokens } from '../contracts/auth-bootstrap.js'

export interface TokenStore {
  load(): Promise<AuthTokens | null>
  save(tokens: AuthTokens): Promise<void>
  clear(): Promise<void>
}

/** 只存在内存里：进程/页面结束就没了。 */
export class MemoryTokenStore implements TokenStore {
  private tokens: AuthTokens | null = null
  async load(): Promise<AuthTokens | null> {
    return this.tokens
  }
  async save(tokens: AuthTokens): Promise<void> {
    this.tokens = tokens
  }
  async clear(): Promise<void> {
    this.tokens = null
  }
}

/**
 * 安全存储后端的最小接口（与 capawesome/aparajita 插件的形状一致）。
 * 单独抽出来，单测不需要真的插件，也便于以后换插件。
 */
export interface SecureStringStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * 用系统安全存储保存 JSON。key 固定，所以「一次登录」只有一个条目；
 * 读到损坏数据时清掉并当作未登录（避免崩溃循环）。
 */
export class SecureTokenStore implements TokenStore {
  static readonly KEY = 'dsh_hub_auth_v1'
  constructor(private readonly backend: SecureStringStore) {}

  async load(): Promise<AuthTokens | null> {
    let raw: string | null = null
    try {
      raw = await this.backend.get(SecureTokenStore.KEY)
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const parsed = AuthTokensSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        await this.clear()
        return null
      }
      return parsed.data
    } catch {
      await this.clear()
      return null
    }
  }

  async save(tokens: AuthTokens): Promise<void> {
    await this.backend.set(SecureTokenStore.KEY, JSON.stringify(tokens))
  }

  async clear(): Promise<void> {
    try {
      await this.backend.remove(SecureTokenStore.KEY)
    } catch {
      /* 已经不存在就算了 */
    }
  }
}

/**
 * `sessionStorage` / 任何「同名接口」的最小形状（WP56d）。
 *
 * 手机网页版的**嵌入座舱**模式（`/m/?embed=cockpit`）拿到的座舱令牌只放 sessionStorage：
 * 关掉 iframe 就没了，刷新页面还在（同一个标签页），而且**绝不**和普通 `/m/` 登录
 * （`localStorage` 的 `dshm.web.auth-v1`）互相覆盖 —— 两者键名不同、存储介质也不同。
 * 抽成接口是为了单测能塞一个内存实现，不在 core 里碰 `globalThis`。
 */
export interface StringStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 存在 `sessionStorage` 里的令牌（WP56d 嵌入座舱）。
 *
 * 与 `LocalStorageTokenStore` 同一份 `AuthTokensSchema`、同一套「读到坏数据就清掉」的规则，
 * 只是介质换成 sessionStorage：**标签页关闭即失效**，也不跨 iframe 之外的页面共享。
 * 没有 sessionStorage 的环境（隐私模式/被禁用）退化成「读过一次就在内存里」，
 * 至少当前这次会话还能用，不会因为存储不可用而把用户挡在门外。
 */
export class SessionStorageTokenStore implements TokenStore {
  private cached: AuthTokens | null = null
  constructor(
    private readonly key: string,
    private readonly storage?: StringStorage,
  ) {}

  private get backend(): StringStorage | null {
    if (this.storage !== undefined) return this.storage
    try {
      return (globalThis as { sessionStorage?: StringStorage }).sessionStorage ?? null
    } catch {
      return null
    }
  }

  async load(): Promise<AuthTokens | null> {
    const backend = this.backend
    if (backend === null) return this.cached
    let raw: string | null = null
    try {
      raw = backend.getItem(this.key)
    } catch {
      return this.cached
    }
    if (!raw) return this.cached
    try {
      const parsed = AuthTokensSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        await this.clear()
        return null
      }
      this.cached = parsed.data
      return parsed.data
    } catch {
      await this.clear()
      return null
    }
  }

  async save(tokens: AuthTokens): Promise<void> {
    this.cached = tokens
    try {
      this.backend?.setItem(this.key, JSON.stringify(tokens))
    } catch {
      /* 配额满 / 隐私模式：本次仍可用（内存里由网关持有），刷新后要重新交接 */
    }
  }

  async clear(): Promise<void> {
    this.cached = null
    try {
      this.backend?.removeItem(this.key)
    } catch {
      /* 已经不存在就算了 */
    }
  }
}

/** 诊断用：不包含任何令牌正文。 */
export function describeTokens(tokens: AuthTokens | null): string {
  if (!tokens) return 'no-tokens'
  return `user=${tokens.user.username} access=${tokens.accessToken.length}b refresh=${tokens.refreshToken.length}b accessExp=${tokens.accessExpiresAt}`
}

/** access 是否已到期（提前 `skewMs` 视为到期，避免刚好卡在边界）。 */
export function isAccessExpired(tokens: AuthTokens, nowMs: number, skewMs = 30_000): boolean {
  const at = Date.parse(tokens.accessExpiresAt)
  if (!Number.isFinite(at)) return true
  return at - skewMs <= nowMs
}

/** refresh 是否已过期（过期就必须重新登录）。 */
export function isRefreshExpired(tokens: AuthTokens, nowMs: number): boolean {
  const at = Date.parse(tokens.refreshExpiresAt)
  if (!Number.isFinite(at)) return true
  return at <= nowMs
}
