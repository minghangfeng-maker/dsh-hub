/**
 * 「记住账号密码」的纯逻辑层（不 import Capacitor，单测直接跑）。
 *
 * 数据边界（与 storage.ts 的存储边界一致）：
 *  - 用户名是**非敏感**数据，所有环境都存 ordinary preferences（`dsh-hub:last-username:v1`）；
 *  - 密码**只**能进系统安全存储（Android Keystore / iOS Keychain），键 `dsh_hub_login_cred_v1`；
 *    `secure === null`（Web，或原生壳没注册 SecureStorage 插件）时**一次都不碰**安全存储，
 *    退化成「只记用户名」——插件缺失时调用它会让主线程微任务死循环（2026-10-25 真机事故）。
 *  - 勾选状态本身也只是偏好（`dsh-hub:remember-login:v1`），默认勾选。
 *
 * 这里只做字符串的序列化/校验与「什么时候写、什么时候清」的策略，
 * 具体后端由调用方注入（storage.createPreferenceStore / createLoginSecureStore），
 * 所以单测可以用假 KeyValueStore / SecureStringStore，不需要真插件。
 *
 * WP54（契约 C10）：**手机网页版不做「记住密码」**。浏览器没有安全存储，把口令写进
 * localStorage 等于把长期口令交给 XSS；网页版交给浏览器自带的密码管理器（W4 给表单写
 * `autocomplete=username/current-password`）。所以网页构建里 `RememberedLoginStore` 是
 * **空实现**：不读、不写、不自动登录，`canRememberPassword` 恒为 false。登录页据此隐藏
 * 「记住密码」开关 —— 判定用导出的 `REMEMBER_LOGIN_SUPPORTED`（W4 直接 import 它）。
 */

import { HubApiError } from '@dsh-hub/mobile-core'
import type { KeyValueStore, SecureStringStore } from '@dsh-hub/mobile-core'
import { IS_WEB_BUILD } from './app-info'

/**
 * 当前产物是否支持「记住账号密码」（**给 W4 / LoginView 用**）。
 *
 * APK（含 mock/integ 变体）= true；手机网页版（`VITE_TARGET=web`）= false —— 网页版隐藏
 * 「记住密码」开关，交给浏览器自己的密码管理器。构建期常量，可在模板里直接 `v-if`。
 */
export const REMEMBER_LOGIN_SUPPORTED: boolean = !IS_WEB_BUILD

/** 上次成功登录的用户名（所有环境）。 */
export const LAST_USERNAME_KEY = 'dsh-hub:last-username:v1'
/** 「记住账号密码」勾选状态：'1' = 勾选（默认），'0' = 用户主动取消。 */
export const REMEMBER_LOGIN_KEY = 'dsh-hub:remember-login:v1'
/**
 * 安全存储里的登录口令条目（JSON `{username, password}`）。
 */
export const LOGIN_CREDENTIALS_KEY = 'dsh_hub_login_cred_v1'
/**
 * 「这次启动不要自动登录」的偏好（'1' = 抑制）。
 *
 * 只在两种情况下写：用户主动退出登录、设备被吊销/登录过期（forceLogout）。
 * 手动登录成功后清掉。这样「记住账号密码」可以用于下次冷启动免登录，
 * 但不会把用户刚做的「退出/被吊销」立刻又自动登回去。
 */
export const SKIP_AUTO_LOGIN_KEY = 'dsh-hub:skip-auto-login:v1'

/** 长度上限只为挡住垃圾数据；Hub 侧用户名本来就短。 */
const USERNAME_MAX = 64
const PASSWORD_MAX = 256

export interface SavedCredentials {
  username: string
  password: string
}

export interface RememberedLoginSnapshot {
  username: string
  password: string
  remember: boolean
  /** 密码是否来自安全存储（UI 用来区分「自动预填」与「用户自己敲的」）。 */
  passwordRestored: boolean
}

export interface RememberedLoginDeps {
  /** 普通偏好：localStorage（Web）/ Capacitor Preferences（原生）。 */
  prefs: KeyValueStore
  /** 安全存储后端；Web 或原生插件缺失时传 null。 */
  secure: SecureStringStore | null
  /**
   * 是否支持「记住账号密码」。默认取构建期常量 `REMEMBER_LOGIN_SUPPORTED`
   * （网页版 false → 整个类退化成空实现）。单测可以显式传 false 覆盖网页行为。
   */
  supported?: boolean
}

/** 用户名归一化：去首尾空白后必须 1..64。 */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > USERNAME_MAX) return null
  return trimmed
}

/**
 * 严格校验一条登录口令。
 * 密码**不做** trim（口令里的空格可能就是密码的一部分），只要求非空字符串。
 */
export function normalizeCredentials(input: unknown): SavedCredentials | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const username = normalizeUsername(record.username)
  if (!username) return null
  const { password } = record
  if (typeof password !== 'string') return null
  if (password.length === 0 || password.length > PASSWORD_MAX) return null
  return { username, password }
}

/** 写入安全存储前统一序列化；数据不合法就返回 null（调用方会清掉旧条目）。 */
export function serializeCredentials(input: unknown): string | null {
  const normalized = normalizeCredentials(input)
  return normalized ? JSON.stringify(normalized) : null
}

/** 读安全存储后的反序列化：损坏/被篡改/形状不对一律当没有。 */
export function parseCredentials(raw: string | null | undefined): SavedCredentials | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    return normalizeCredentials(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 勾选状态：只有明确写下的 '0'/'false' 才算取消，其余（含没存过）都是默认勾选。 */
export function parseRememberFlag(raw: string | null | undefined): boolean {
  return raw !== '0' && raw !== 'false'
}

// ── 冷启动静默恢复登录（令牌不可用时的回退策略） ────────────────────────────
//
// 真机问题（0.2.13）：杀掉 App 再开有时停在登录页，必须手点一次「登录」。
// 生产 Hub 日志里能看到两条路径：
//   1) SecureStorage 冷启动没就绪 → 令牌读不到（也读不到记住的口令）→ 直接登录页；
//   2) refresh 返回 DEVICE_TOKEN_INVALID（非吊销）→ 之前直接 forceLogout 回登录页，
//      哪怕「记住账号密码」里明明有口令可以静默登回来。
//
// 0.2.14 于是「除吊销以外都静默登录」——太宽了（0.2.17 收紧）：令牌轮换/重放是泄露信号、
// 账号停用也不是「重新认证就好」，这些都不能拿保存的口令把人自动登回去。
// 现在只有**过期/失效类**（以及本地根本没有令牌）才静默登录，见 decideSilentLogin。
//
// 这里放与 Capacitor 无关的纯策略，auth store 与单测共用：
//   - decideSilentLogin：这次令牌失效到底该静默登录，还是该让用户重新输密码；
//   - shouldSuppressAutoLogin / shouldClearCredentials：回登录页时的收尾动作；
//   - runAutoLoginRetries：自动登录的退避重试（网络类错误 ~15s 窗口）。

/** 自动登录的网络重试窗口：冷启动时网络栈/容器唤醒可能都要几秒。 */
export const AUTO_LOGIN_WINDOW_MS = 15_000
/** 退避序列（毫秒）：0.4 / 0.8 / 1.6 / 3.2 / 5 / 5 …，到窗口为止。 */
export const AUTO_LOGIN_BACKOFF_MS: readonly number[] = [400, 800, 1_600, 3_200, 5_000, 5_000]

/** 这次登录失败是否值得重试：只重试网络/超时/5xx 这类临时故障。 */
export function isRetryableLoginError(error: unknown): boolean {
  if (!(error instanceof HubApiError)) return false
  if (error.code === 'network' || error.code === 'timeout') return true
  // 登录接口的 5xx（INTERNAL 等）也值得再试；401/403/429 不重试。
  return error.status >= 500
}

export interface AutoLoginRetryOptions {
  /** 执行一次登录（失败抛错）。 */
  attempt: () => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
  shouldRetry?: (error: unknown) => boolean
  /** 每次失败后、下一次重试前检查：返回 true 就不再试（比如用户已经手动登录/退出）。 */
  aborted?: () => boolean
  windowMs?: number
  delays?: readonly number[]
}

export interface AutoLoginRetryResult {
  ok: boolean
  attempts: number
  error?: unknown
}

/**
 * 自动登录重试：第一次立刻尝试；失败且可重试就按退避序列重试，直到总窗口用完。
 * 返回最后一次错误，交给调用方决定是否清掉口令（INVALID_CREDENTIALS）。
 */
export async function runAutoLoginRetries(
  options: AutoLoginRetryOptions,
): Promise<AutoLoginRetryResult> {
  const shouldRetry = options.shouldRetry ?? isRetryableLoginError
  const windowMs = Math.max(0, options.windowMs ?? AUTO_LOGIN_WINDOW_MS)
  const delays = options.delays ?? AUTO_LOGIN_BACKOFF_MS
  const started = options.now()
  let attempts = 0
  let lastError: unknown = null

  for (;;) {
    attempts += 1
    try {
      await options.attempt()
      return { ok: true, attempts }
    } catch (error) {
      lastError = error
      if (!shouldRetry(error)) return { ok: false, attempts, error }
      if (options.aborted?.()) return { ok: false, attempts, error }
      const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 0
      const elapsed = Math.max(0, options.now() - started)
      // 这一轮等待会超出窗口：不再重试（不把总时长拖过窗口）。
      if (elapsed + delay > windowMs) return { ok: false, attempts, error }
      await options.sleep(delay)
    }
  }
}

export type SilentLoginAction = 'silent-login' | 'login-page'
export type SilentLoginReason =
  | 'expired'
  | 'no-token'
  | 'revoked'
  | 'rotated'
  | 'account'
  | 'unexpected'
  | 'suppressed'
  | 'no-credentials'

export interface SilentLoginDecision {
  action: SilentLoginAction
  reason: SilentLoginReason
}

/** 这些码语义上就是「设备被移出登录状态」，必须让用户重新登录（不能让自动登录把人登回去）。 */
const REVOKED_CODES = new Set(['DEVICE_REVOKED', 'device-revoked', 'revoked'])

/**
 * 「过期 / 失效」类：**唯一**允许用记住的口令静默登录的一组码（外加「本地根本没有令牌」）。
 *
 * 依据 Hub 端 `apps/api/src/modules/mobile/auth.ts`（`POST /api/mobile/auth/refresh` 与
 * `resolveAccessToken`）：
 *  - refresh token 过期 → 401 `DEVICE_TOKEN_INVALID`（「登录已过期，请重新登录」）；
 *  - 令牌查不到（伪造 / 已被清理）/ 不是手机令牌 → 也是 401 `DEVICE_TOKEN_INVALID`；
 *  - 轮换**宽限期（10s）内**重复用旧 refresh（并发刷新，客户端手里已有新令牌）→ 同样是
 *    401 `DEVICE_TOKEN_INVALID`（「登录状态刚更新过，请用新的令牌重试」）。
 * 这三种都不是泄露信号，用户动作就是「重新认证一次」，所以允许静默登录。
 *
 * `expired` / `refresh-expired` / `session-expired` 是客户端自己的伪码（本地 refresh 过期、
 * 通道报会话过期），语义等价。
 */
const EXPIRED_CODES = new Set([
  'DEVICE_TOKEN_INVALID',
  'expired',
  'refresh-expired',
  'session-expired',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'ACCESS_TOKEN_EXPIRED',
])

/**
 * 「轮换 / 重放」类：旧 refresh 被重放 = 令牌可能已泄露，绝不能拿口令静默登回去。
 *
 * 注意：Hub 现在（WP40a）对「超过宽限期的重放」的做法是**直接吊销整台设备**，所以客户端
 * 实际收到的是 `DEVICE_REVOKED`（见 REVOKED_CODES）；这里额外列出「若 Hub 以后给独立错误
 * 码」的语义，免得那时又被当成普通过期静默登回去。
 */
const ROTATED_CODES = new Set([
  'DEVICE_ROTATED',
  'device-rotated',
  'TOKEN_ROTATED',
  'REFRESH_ROTATED',
  'refresh-replay',
  'REFRESH_REPLAY',
  'token-replay',
])

/** 这个码是否属于「轮换/重放」（疑似令牌泄露）：回登录页 + 清口令 + 抑制自动登录。 */
export function isReplayOrRotatedCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && ROTATED_CODES.has(code)
}

/**
 * 账号本身不可用：停用 / 待审批 / 必须改密码（Hub refresh 的 `assertAccountUsable`）。
 * 这些码在网页端也要先处理账号，静默登录只会再失败一次，还会撞登录限流（10 次 / 10 分钟）。
 * 账号被删除时 Hub 回的是 `DEVICE_REVOKED`（已由吊销分支覆盖）。
 */
const ACCOUNT_CODES = new Set([
  'USER_DISABLED',
  'USER_PENDING',
  'MUST_CHANGE_PASSWORD',
  'ACCOUNT_DISABLED',
  'ACCOUNT_PENDING',
  'ACCOUNT_DELETED',
  'ACCOUNT_LOCKED',
])

/** 这个码是否属于「账号本身不可用」（停用 / 待审批 / 必须改密码）：登录页据此换具体文案。 */
export function isAccountProblemCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && ACCOUNT_CODES.has(code)
}

/**
 * 令牌不可用（缺失 / 过期 / 刷新被拒）时该不该静默登录：
 *
 *  - 设备被吊销（含「重放超过宽限期」被 Hub 吊销）：绝不自动登录，回登录页，清口令 + 抑制；
 *  - 轮换 / 重放（独立的泄露信号码）：同上，一律回登录页；
 *  - 账号停用 / 待审批 / 必须改密码：回登录页（先处理账号）；
 *  - 用户主动退出/刚被吊销（suppressed）：回登录页；
 *  - 本地根本没有令牌 / 「过期、失效」类：有记住的口令就静默登录；
 *  - 无法识别的码：**默认不自动登录**（回登录页），宁可让用户手点一次。
 */
export function decideSilentLogin(input: {
  /** 令牌状态码；null/undefined 表示本地根本没有令牌。 */
  code?: string | null
  hasCredentials: boolean
  suppressed?: boolean
}): SilentLoginDecision {
  const code = input.code ?? ''
  if (code !== '' && REVOKED_CODES.has(code)) return { action: 'login-page', reason: 'revoked' }
  if (code !== '' && ROTATED_CODES.has(code)) return { action: 'login-page', reason: 'rotated' }
  if (code !== '' && ACCOUNT_CODES.has(code)) return { action: 'login-page', reason: 'account' }
  if (input.suppressed === true) return { action: 'login-page', reason: 'suppressed' }
  // 本地没有令牌（冷启动最常见）：有口令就静默登录，没有就回登录页。
  if (code === '') {
    return input.hasCredentials
      ? { action: 'silent-login', reason: 'no-token' }
      : { action: 'login-page', reason: 'no-credentials' }
  }
  // 白名单之外的码一律不静默登录（下面的 login-page 分支由调用方决定是否抑制/清口令）。
  if (!EXPIRED_CODES.has(code)) return { action: 'login-page', reason: 'unexpected' }
  if (!input.hasCredentials) return { action: 'login-page', reason: 'no-credentials' }
  return { action: 'silent-login', reason: 'expired' }
}

/** 这些 reason 是「明确的安全 / 权限信号」：要像吊销一样清掉已存口令。 */
const CREDENTIAL_KILL_REASONS: ReadonlySet<SilentLoginReason> = new Set(['revoked', 'rotated', 'account'])

/**
 * 回登录页时要不要顺手**抑制下一次冷启动的自动登录**。
 *
 * 除了「本来就是抑制导致的」和「本来就没有口令」，一律抑制：不确定的状态下不要用口令
 * 反复重放（重放本身可能被 Hub 判成令牌泄露），让用户手点一次登录来确认。
 */
export function shouldSuppressAutoLogin(decision: SilentLoginDecision): boolean {
  if (decision.action !== 'login-page') return false
  return decision.reason !== 'suppressed' && decision.reason !== 'no-credentials'
}

/** 回登录页时要不要**清掉安全存储里的口令**（吊销 / 轮换重放 / 账号停用三类）。 */
export function shouldClearCredentials(decision: SilentLoginDecision): boolean {
  return decision.action === 'login-page' && CREDENTIAL_KILL_REASONS.has(decision.reason)
}

async function safeGet(store: KeyValueStore, key: string): Promise<string | null> {
  try {
    return await store.get(key)
  } catch {
    return null
  }
}

async function safeSet(store: KeyValueStore, key: string, value: string): Promise<void> {
  try {
    await store.set(key, value)
  } catch {
    /* 偏好写失败（隐私模式等）不影响登录 */
  }
}

/**
 * 「记住账号密码」的存储策略。
 *
 * 调用顺序：登录页挂载时 `load()`；用户勾/取消时 `setRemember()`；
 * 登录成功时 `onLoginSuccess()`；Hub 回 INVALID_CREDENTIALS 时 `onInvalidCredentials()`。
 *
 * 网页版（`supported === false`，见 `REMEMBER_LOGIN_SUPPORTED`）是**空实现**：所有方法都
 * 立刻返回空结果、不写任何偏好（连用户名都不记，交给浏览器密码管理器），
 * 所以「冷启动自动登录」在网页版永远不会发生（刷新后靠 localStorage 里的令牌恢复登录态）。
 */
export class RememberedLoginStore {
  private readonly supported: boolean

  constructor(private readonly deps: RememberedLoginDeps) {
    this.supported = deps.supported ?? REMEMBER_LOGIN_SUPPORTED
  }

  /** 当前环境是否有能力保存密码（原生 + 插件可用）。网页版恒为 false。 */
  get canRememberPassword(): boolean {
    return this.supported && this.deps.secure !== null
  }

  /**
   * 登录页挂载时读一次：用户名、可预填的密码、勾选状态。
   * 网页版返回空快照（什么都不预填）。
   */
  async load(): Promise<RememberedLoginSnapshot> {
    if (!this.supported) return emptySnapshot()
    const storedUsername = normalizeUsername(await safeGet(this.deps.prefs, LAST_USERNAME_KEY))
    const remember = parseRememberFlag(await safeGet(this.deps.prefs, REMEMBER_LOGIN_KEY))
    const snapshot: RememberedLoginSnapshot = {
      username: storedUsername ?? '',
      password: '',
      remember,
      passwordRestored: false,
    }
    // 用户取消勾选后即使安全存储里还残留旧数据（比如上次卸载没清干净），也不再预填。
    if (!remember) return snapshot
    const saved = await this.loadCredentials()
    if (!saved) return snapshot
    // 只有「同一个用户名」才预填密码：换账号登录时宁可不预填，也不要拿别人的口令去撞。
    if (!storedUsername) {
      snapshot.username = saved.username
    } else if (saved.username !== storedUsername) {
      return snapshot
    }
    snapshot.password = saved.password
    snapshot.passwordRestored = true
    return snapshot
  }

  /** 勾选状态变化：取消时立刻清掉已存密码（保留用户名）。网页版忽略。 */
  async setRemember(remember: boolean): Promise<void> {
    if (!this.supported) return
    await safeSet(this.deps.prefs, REMEMBER_LOGIN_KEY, remember ? '1' : '0')
    if (!remember) await this.clearPassword()
  }

  /**
   * 冷启动/令牌失效时的「静默登录凭据」：
   * 只有勾选了记住密码、安全存储里确实有口令、且没有被「刚退出 / 被吊销」抑制时才返回。
   * 网页版恒为 null。
   */
  async autoLoginCredentials(): Promise<SavedCredentials | null> {
    if (!this.supported) return null
    if (await this.isAutoLoginSuppressed()) return null
    const snapshot = await this.load()
    if (!snapshot.remember || !snapshot.passwordRestored) return null
    if (!snapshot.username || !snapshot.password) return null
    return { username: snapshot.username, password: snapshot.password }
  }

  /**
   * 登录成功：用户名无条件记住；勾选且安全存储可用时再写密码。
   * 写不了密码（Web / 插件缺失）时，把可能残留的旧口令清掉，避免下次预填过期密码。
   * 网页版什么都不写。
   */
  async onLoginSuccess(rawUsername: string, password: string, remember: boolean): Promise<void> {
    if (!this.supported) return
    const username = normalizeUsername(rawUsername)
    if (!username) return
    await safeSet(this.deps.prefs, LAST_USERNAME_KEY, username)
    // 顺带把勾选状态落盘，避免「改了勾选但还没触发 change」之类的边界。
    await safeSet(this.deps.prefs, REMEMBER_LOGIN_KEY, remember ? '1' : '0')
    if (!remember) {
      await this.clearPassword()
      return
    }
    const serialized = serializeCredentials({ username, password })
    const secure = this.deps.secure
    if (!secure || !serialized) {
      await this.clearPassword()
      return
    }
    try {
      await secure.set(LOGIN_CREDENTIALS_KEY, serialized)
    } catch {
      // 安全存储写失败：清掉旧条目（可能是上一个账号/旧口令），本次退化成只记用户名。
      await this.clearPassword()
    }
  }

  /** 口令错（INVALID_CREDENTIALS）：清掉已存密码，保留用户名。网页版忽略。 */
  async onInvalidCredentials(): Promise<void> {
    if (!this.supported) return
    await this.clearPassword()
  }

  /** 这次启动是否抑制自动登录（主动退出/被吊销后为 true）。网页版恒为 false。 */
  async isAutoLoginSuppressed(): Promise<boolean> {
    if (!this.supported) return false
    const raw = await safeGet(this.deps.prefs, SKIP_AUTO_LOGIN_KEY)
    return raw === '1' || raw === 'true'
  }

  /** 抑制下一次冷启动的自动登录（主动退出 / 设备被吊销时调用）。网页版忽略。 */
  async suppressAutoLogin(): Promise<void> {
    if (!this.supported) return
    await safeSet(this.deps.prefs, SKIP_AUTO_LOGIN_KEY, '1')
  }

  /** 手动登录成功：恢复「下次自动登录」。网页版忽略。 */
  async allowAutoLogin(): Promise<void> {
    if (!this.supported) return
    await safeSet(this.deps.prefs, SKIP_AUTO_LOGIN_KEY, '0')
  }

  /** 清掉安全存储里的口令；Web / 插件缺失 / 网页版时是空操作（绝不触碰插件）。 */
  async clearPassword(): Promise<void> {
    if (!this.supported) return
    const secure = this.deps.secure
    if (!secure) return
    try {
      await secure.remove(LOGIN_CREDENTIALS_KEY)
    } catch {
      /* 条目不存在就算了 */
    }
  }

  private async loadCredentials(): Promise<SavedCredentials | null> {
    if (!this.supported) return null
    const secure = this.deps.secure
    if (!secure) return null
    let raw: string | null = null
    try {
      raw = await secure.get(LOGIN_CREDENTIALS_KEY)
    } catch {
      return null
    }
    if (!raw) return null
    const saved = parseCredentials(raw)
    if (!saved) {
      // 损坏数据清掉，避免每次进登录页都读到垃圾（与 SecureTokenStore 的处理一致）。
      await this.clearPassword()
      return null
    }
    return saved
  }
}

/** 网页版的空快照（每次给新对象，调用方改它也不会污染别人）。 */
function emptySnapshot(): RememberedLoginSnapshot {
  return { username: '', password: '', remember: false, passwordRestored: false }
}
