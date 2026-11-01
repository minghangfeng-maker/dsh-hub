import { afterEach, describe, expect, it } from 'vitest'
import { HubApiError } from '@dsh-hub/mobile-core'
import type { KeyValueStore, SecureStringStore } from '@dsh-hub/mobile-core'
import {
  AUTO_LOGIN_WINDOW_MS,
  LAST_USERNAME_KEY,
  LOGIN_CREDENTIALS_KEY,
  REMEMBER_LOGIN_KEY,
  RememberedLoginStore,
  decideSilentLogin,
  isAccountProblemCode,
  shouldClearCredentials,
  shouldSuppressAutoLogin,
  isRetryableLoginError,
  normalizeCredentials,
  normalizeUsername,
  parseCredentials,
  parseRememberFlag,
  runAutoLoginRetries,
  serializeCredentials,
} from '@/lib/remembered-login'
import { isNativePluginRegistered } from '@/lib/storage'

class FakePrefs implements KeyValueStore {
  readonly map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

class FakeSecure implements SecureStringStore {
  readonly map = new Map<string, string>()
  /** 记录所有调用，用来断言「插件缺失时一次都不碰安全存储」。 */
  readonly calls: string[] = []
  async get(key: string): Promise<string | null> {
    this.calls.push(`get:${key}`)
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.calls.push(`set:${key}`)
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.calls.push(`remove:${key}`)
    this.map.delete(key)
  }
}

class ThrowingSecure implements SecureStringStore {
  async get(): Promise<string | null> {
    throw new Error('keystore get failed')
  }
  async set(): Promise<void> {
    throw new Error('keystore set failed')
  }
  async remove(): Promise<void> {
    throw new Error('keystore remove failed')
  }
}

const CREDS = { username: 'demo', password: 'demo1234' }

function setup(secure: SecureStringStore | null = new FakeSecure()): {
  prefs: FakePrefs
  store: RememberedLoginStore
} {
  const prefs = new FakePrefs()
  return { prefs, store: new RememberedLoginStore({ prefs, secure }) }
}

describe('登录口令的序列化 / 校验', () => {
  it('round-trip：用户名去空白，密码原样保留（口令里的空格可能是真的）', () => {
    const raw = serializeCredentials({ username: '  demo  ', password: ' pa ss ' })
    expect(raw).toBe('{"username":"demo","password":" pa ss "}')
    expect(parseCredentials(raw)).toEqual({ username: 'demo', password: ' pa ss ' })
  })

  it('坏数据一律当没有：空串 / 非 JSON / 形状不对 / 字段类型不对', () => {
    const bad = [
      undefined,
      null,
      '',
      'not-json',
      'null',
      '[]',
      '"demo"',
      '{}',
      '{"username":""}',
      '{"username":"demo"}',
      '{"username":"demo","password":""}',
      '{"username":"demo","password":123}',
      '{"username":123,"password":"x"}',
      '{"username":"demo","password":null}',
    ]
    for (const raw of bad) expect(parseCredentials(raw)).toBeNull()
  })

  it('长度上限挡住垃圾数据；用户名只做 trim，不接受的长度直接判无效', () => {
    expect(normalizeUsername('   ')).toBeNull()
    expect(normalizeUsername('x'.repeat(65))).toBeNull()
    expect(normalizeUsername('x'.repeat(64))).toBe('x'.repeat(64))
    expect(normalizeCredentials({ username: 'demo', password: 'x'.repeat(257) })).toBeNull()
    expect(serializeCredentials({ username: 'demo', password: 'x'.repeat(257) })).toBeNull()
  })

  it('勾选状态默认 true，只有明确写下的 0/false 才算取消', () => {
    expect(parseRememberFlag(null)).toBe(true)
    expect(parseRememberFlag(undefined)).toBe(true)
    expect(parseRememberFlag('1')).toBe(true)
    expect(parseRememberFlag('garbage')).toBe(true)
    expect(parseRememberFlag('0')).toBe(false)
    expect(parseRememberFlag('false')).toBe(false)
  })
})

describe('记住账号密码：安全存储可用（原生 + 插件）', () => {
  it('登录成功：用户名进偏好，口令进安全存储（JSON，键固定）', async () => {
    const secure = new FakeSecure()
    const { prefs, store } = setup(secure)
    await store.onLoginSuccess(' demo ', 'demo1234', true)

    expect(prefs.map.get(LAST_USERNAME_KEY)).toBe('demo')
    expect(prefs.map.get(REMEMBER_LOGIN_KEY)).toBe('1')
    expect(secure.map.get(LOGIN_CREDENTIALS_KEY)).toBe(
      '{"username":"demo","password":"demo1234"}',
    )
    expect(store.canRememberPassword).toBe(true)
  })

  it('下次进登录页：用户名 + 密码都预填', async () => {
    const { store } = setup()
    await store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await expect(store.load()).resolves.toEqual({
      username: 'demo',
      password: 'demo1234',
      remember: true,
      passwordRestored: true,
    })
  })

  it('取消勾选：立刻清掉口令、勾选状态落盘，但用户名保留', async () => {
    const secure = new FakeSecure()
    const { prefs, store } = setup(secure)
    await store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await store.setRemember(false)

    expect(prefs.map.get(REMEMBER_LOGIN_KEY)).toBe('0')
    expect(secure.map.has(LOGIN_CREDENTIALS_KEY)).toBe(false)
    await expect(store.load()).resolves.toMatchObject({
      username: 'demo',
      password: '',
      remember: false,
    })
  })

  it('口令错：清掉口令（保留用户名）；再进登录页只有用户名', async () => {
    const secure = new FakeSecure()
    const { prefs, store } = setup(secure)
    await store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await store.onInvalidCredentials()

    expect(secure.map.has(LOGIN_CREDENTIALS_KEY)).toBe(false)
    expect(prefs.map.get(LAST_USERNAME_KEY)).toBe('demo')
    await expect(store.load()).resolves.toMatchObject({ username: 'demo', password: '' })
  })

  it('换账号：存的口令属于旧用户名时不预填（不拿旧口令撞新账号）', async () => {
    const secure = new FakeSecure()
    const { prefs, store } = setup(secure)
    await store.onLoginSuccess('alice', 'alice-pass', true)
    await prefs.set(LAST_USERNAME_KEY, 'bob')

    await expect(store.load()).resolves.toMatchObject({ username: 'bob', password: '' })
  })

  it('安全存储里的 JSON 坏了：当没有并清掉，不抛错', async () => {
    const secure = new FakeSecure()
    const { store } = setup(secure)
    await secure.set(LOGIN_CREDENTIALS_KEY, '{broken')
    await expect(store.load()).resolves.toMatchObject({ password: '' })
    expect(secure.map.has(LOGIN_CREDENTIALS_KEY)).toBe(false)
  })

  it('安全存储抛错（Keystore 坏 / 无权限）：读写都降级，不影响登录', async () => {
    const { prefs, store } = setup(new ThrowingSecure())
    await expect(store.onLoginSuccess(CREDS.username, CREDS.password, true)).resolves.toBeUndefined()
    expect(prefs.map.get(LAST_USERNAME_KEY)).toBe('demo')
    await expect(store.load()).resolves.toMatchObject({ username: 'demo', password: '' })
    await expect(store.setRemember(false)).resolves.toBeUndefined()
    await expect(store.onInvalidCredentials()).resolves.toBeUndefined()
  })

  it('登录成功但取消勾选：只记用户名，并清掉旧口令', async () => {
    const secure = new FakeSecure()
    const { store } = setup(secure)
    await store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await store.onLoginSuccess(CREDS.username, 'new-pass', false)
    expect(secure.map.has(LOGIN_CREDENTIALS_KEY)).toBe(false)
  })
})

describe('记住账号密码：插件缺失 / Web（secure = null，只记用户名）', () => {
  it('一次都不调用 SecureStorage，只写用户名偏好', async () => {
    const { prefs, store } = setup(null)
    expect(store.canRememberPassword).toBe(false)
    await store.onLoginSuccess(CREDS.username, CREDS.password, true)

    expect(prefs.map.get(LAST_USERNAME_KEY)).toBe('demo')
    // secure 为 null 时没有被引用过；这里用「没有抛错 + 密码不在偏好里」来锁死边界
    expect(prefs.map.get(LOGIN_CREDENTIALS_KEY)).toBeUndefined()
    expect([...prefs.map.values()]).not.toContain(CREDS.password)
  })

  it('load 只返回用户名，密码恒为空（Web 绝不预填密码）', async () => {
    const { prefs, store } = setup(null)
    await prefs.set(LAST_USERNAME_KEY, 'demo')
    await prefs.set(LOGIN_CREDENTIALS_KEY, '{"username":"demo","password":"demo1234"}')
    await expect(store.load()).resolves.toEqual({
      username: 'demo',
      password: '',
      remember: true,
      passwordRestored: false,
    })
  })

  it('取消勾选 / 口令错都是空操作，不抛错', async () => {
    const { store } = setup(null)
    await expect(store.setRemember(false)).resolves.toBeUndefined()
    await expect(store.onInvalidCredentials()).resolves.toBeUndefined()
  })
})

describe('SecureStorage 插件守卫（缺插件绝不能调用插件）', () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor
  })

  it('PluginHeaders 里有 SecureStorage 才算注册', () => {
    ;(globalThis as { Capacitor?: unknown }).Capacitor = {
      PluginHeaders: [{ name: 'Preferences' }, { name: 'SecureStorage' }],
    }
    expect(isNativePluginRegistered('SecureStorage')).toBe(true)
    expect(isNativePluginRegistered('Browser')).toBe(false)
  })

  it('没有 PluginHeaders / 不是数组 / 空数组：一律 false 且不抛错', () => {
    expect(isNativePluginRegistered('SecureStorage')).toBe(false)
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { PluginHeaders: null }
    expect(isNativePluginRegistered('SecureStorage')).toBe(false)
    ;(globalThis as { Capacitor?: unknown }).Capacitor = {}
    expect(isNativePluginRegistered('SecureStorage')).toBe(false)
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { PluginHeaders: [] }
    expect(isNativePluginRegistered('SecureStorage')).toBe(false)
  })
})

describe('冷启动自动登录的抑制开关（0.2.9）', () => {
  it('默认不抑制；suppress 后为 true，手动登录成功 allow 后恢复', async () => {
    const { store } = setup()
    expect(await store.isAutoLoginSuppressed()).toBe(false)
    await store.suppressAutoLogin()
    expect(await store.isAutoLoginSuppressed()).toBe(true)
    await store.allowAutoLogin()
    expect(await store.isAutoLoginSuppressed()).toBe(false)
  })

  it('Web（secure=null）：抑制开关照常工作，且不碰安全存储', async () => {
    const { store } = setup(null)
    await store.suppressAutoLogin()
    expect(await store.isAutoLoginSuppressed()).toBe(true)
    await store.clearPassword()
    expect(await store.isAutoLoginSuppressed()).toBe(true)
  })
})

// ── 令牌不可用时的静默恢复策略（0.2.14 引入，0.2.17 收紧） ──────────────────
//
// 0.2.14：refresh 返回 DEVICE_TOKEN_INVALID（非吊销）时旧实现直接 forceLogout 回登录页，
// 哪怕「记住账号密码」里有口令可以静默登回来 —— 那时「除吊销以外都静默登录」，太宽。
//
// 0.2.17：Hub 端的契约（`apps/api/src/modules/mobile/auth.ts`）只有两类可观察结果：
//   refresh token 过期 / 查不到 / 宽限期内重复使用旧 refresh → 401 DEVICE_TOKEN_INVALID；
//   超过宽限期的重放（Hub 直接吊销整台设备）/ 设备被吊销 / 账号被删 → 401 DEVICE_REVOKED；
//   账号停用、待审批、必须改密码 → USER_DISABLED / USER_PENDING / MUST_CHANGE_PASSWORD。
// 只有「过期类 + 本地没有令牌」才允许静默登录，其余（含无法识别的码）一律回登录页。

describe('令牌失效时该不该静默自动登录（decideSilentLogin）', () => {
  it('过期/失效类 + 有记住的口令 → 静默登录', () => {
    for (const code of [
      'DEVICE_TOKEN_INVALID',
      'UNAUTHENTICATED',
      'session-expired',
      'refresh-expired',
      'expired',
    ]) {
      expect(decideSilentLogin({ code, hasCredentials: true })).toEqual({
        action: 'silent-login',
        reason: 'expired',
      })
    }
    // 本地根本没有令牌（冷启动最常见）
    expect(decideSilentLogin({ code: null, hasCredentials: true })).toEqual({
      action: 'silent-login',
      reason: 'no-token',
    })
    expect(decideSilentLogin({ hasCredentials: true })).toEqual({
      action: 'silent-login',
      reason: 'no-token',
    })
  })

  it('设备被吊销 → 一律回登录页（哪怕有口令，这是明确的权限动作）', () => {
    for (const code of ['DEVICE_REVOKED', 'device-revoked', 'revoked']) {
      expect(decideSilentLogin({ code, hasCredentials: true })).toEqual({
        action: 'login-page',
        reason: 'revoked',
      })
    }
  })

  it('轮换/重放（疑似令牌泄露）→ 回登录页，绝不用保存的口令登回去', () => {
    for (const code of [
      'DEVICE_ROTATED',
      'device-rotated',
      'TOKEN_ROTATED',
      'REFRESH_ROTATED',
      'refresh-replay',
      'REFRESH_REPLAY',
      'token-replay',
    ]) {
      expect(decideSilentLogin({ code, hasCredentials: true })).toEqual({
        action: 'login-page',
        reason: 'rotated',
      })
    }
  })

  it('账号停用/待审批/必须改密码 → 回登录页（先处理账号，不是重新认证就好）', () => {
    for (const code of [
      'USER_DISABLED',
      'USER_PENDING',
      'MUST_CHANGE_PASSWORD',
      'ACCOUNT_DISABLED',
      'ACCOUNT_PENDING',
      'ACCOUNT_DELETED',
      'ACCOUNT_LOCKED',
    ]) {
      expect(decideSilentLogin({ code, hasCredentials: true })).toEqual({
        action: 'login-page',
        reason: 'account',
      })
    }
    expect(isAccountProblemCode('USER_DISABLED')).toBe(true)
    expect(isAccountProblemCode('DEVICE_TOKEN_INVALID')).toBe(false)
    expect(isAccountProblemCode(null)).toBe(false)
  })

  it('无法识别的码 → 默认不自动登录（宁可让用户手点一次）', () => {
    for (const code of ['SOMETHING_NEW', 'RATE_LIMITED', 'INTERNAL', 'nonsense']) {
      expect(decideSilentLogin({ code, hasCredentials: true })).toEqual({
        action: 'login-page',
        reason: 'unexpected',
      })
    }
  })

  it('主动退出/被吊销后的抑制开关 → 回登录页', () => {
    expect(
      decideSilentLogin({ code: 'UNAUTHENTICATED', hasCredentials: true, suppressed: true }),
    ).toEqual({ action: 'login-page', reason: 'suppressed' })
  })

  it('没有记住的口令 → 回登录页（登录页只在真的恢复不了时出现）', () => {
    expect(decideSilentLogin({ code: 'DEVICE_TOKEN_INVALID', hasCredentials: false })).toEqual({
      action: 'login-page',
      reason: 'no-credentials',
    })
    expect(decideSilentLogin({ hasCredentials: false })).toEqual({
      action: 'login-page',
      reason: 'no-credentials',
    })
  })

  it('回登录页时的收尾：吊销/轮换/账号停用清口令，无法识别的码只抑制自动登录', () => {
    // 吊销 / 轮换 / 账号停用：像吊销一样抑制 + 清口令
    for (const code of ['DEVICE_REVOKED', 'refresh-replay', 'USER_DISABLED']) {
      const decision = decideSilentLogin({ code, hasCredentials: true })
      expect(shouldSuppressAutoLogin(decision)).toBe(true)
      expect(shouldClearCredentials(decision)).toBe(true)
    }
    // 无法识别的码：抑制（别反复用口令重放），但不销毁口令
    const unexpected = decideSilentLogin({ code: 'SOMETHING_NEW', hasCredentials: true })
    expect(shouldSuppressAutoLogin(unexpected)).toBe(true)
    expect(shouldClearCredentials(unexpected)).toBe(false)
    // 已经是抑制状态 / 本来没有口令：不重复写偏好
    expect(
      shouldSuppressAutoLogin(
        decideSilentLogin({ code: 'UNAUTHENTICATED', hasCredentials: true, suppressed: true }),
      ),
    ).toBe(false)
    expect(
      shouldSuppressAutoLogin(decideSilentLogin({ code: 'DEVICE_TOKEN_INVALID', hasCredentials: false })),
    ).toBe(false)
    // 静默登录的分支不做收尾
    const silent = decideSilentLogin({ code: 'DEVICE_TOKEN_INVALID', hasCredentials: true })
    expect(shouldSuppressAutoLogin(silent)).toBe(false)
    expect(shouldClearCredentials(silent)).toBe(false)
  })
})

describe('自动登录的网络退避重试（runAutoLoginRetries）', () => {
  function makeClock(): {
    sleeps: number[]
    now: () => number
    sleep: (ms: number) => Promise<void>
  } {
    let time = 0
    const sleeps: number[] = []
    return {
      sleeps,
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        time += ms
      },
    }
  }

  it('第一次就成功：不重试、不等待', async () => {
    const clock = makeClock()
    let attempts = 0
    const result = await runAutoLoginRetries({
      attempt: async () => {
        attempts += 1
      },
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result).toEqual({ ok: true, attempts: 1 })
    expect(clock.sleeps).toEqual([])
    expect(attempts).toBe(1)
  })

  it('网络错误按退避重试，随后成功（冷启动网络栈慢）', async () => {
    const clock = makeClock()
    let attempts = 0
    const result = await runAutoLoginRetries({
      attempt: async () => {
        attempts += 1
        if (attempts < 3) throw new HubApiError('network')
      },
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result).toEqual({ ok: true, attempts: 3 })
    expect(clock.sleeps).toEqual([400, 800])
  })

  it('口令错（INVALID_CREDENTIALS）不重试，直接把错误交回去', async () => {
    const clock = makeClock()
    let attempts = 0
    const error = new HubApiError('INVALID_CREDENTIALS', { status: 401 })
    const result = await runAutoLoginRetries({
      attempt: async () => {
        attempts += 1
        throw error
      },
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.error).toBe(error)
    expect(clock.sleeps).toEqual([])
  })

  it('持续网络错误：到 ~15s 窗口为止，不会无限重试', async () => {
    const clock = makeClock()
    let attempts = 0
    const result = await runAutoLoginRetries({
      attempt: async () => {
        attempts += 1
        throw new HubApiError('network')
      },
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.ok).toBe(false)
    expect(attempts).toBeGreaterThan(1)
    const slept = clock.sleeps.reduce((sum, ms) => sum + ms, 0)
    expect(slept).toBeLessThanOrEqual(AUTO_LOGIN_WINDOW_MS)
    // 退避序列到窗口为止；最后一次等待不越过窗口，所以总时长接近但不超过 15s
    expect(slept).toBeGreaterThanOrEqual(AUTO_LOGIN_WINDOW_MS - 6_000)
    expect(result.error).toBeInstanceOf(HubApiError)
    expect((result.error as HubApiError).code).toBe('network')
  })

  it('aborted()：用户已手动登录/退出时立刻停手', async () => {
    const clock = makeClock()
    let attempts = 0
    const result = await runAutoLoginRetries({
      attempt: async () => {
        attempts += 1
        throw new HubApiError('network')
      },
      sleep: clock.sleep,
      now: clock.now,
      aborted: () => true,
    })
    expect(result.ok).toBe(false)
    expect(attempts).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('非 HubApiError（未知错误）不重试', async () => {
    const clock = makeClock()
    let attempts = 0
    const result = await runAutoLoginRetries({
      attempt: async () => {
        attempts += 1
        throw new Error('boom')
      },
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.ok).toBe(false)
    expect(attempts).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('isRetryableLoginError：只把网络/超时/5xx 当临时故障', () => {
    expect(isRetryableLoginError(new HubApiError('network'))).toBe(true)
    expect(isRetryableLoginError(new HubApiError('timeout'))).toBe(true)
    expect(isRetryableLoginError(new HubApiError('INTERNAL', { status: 500 }))).toBe(true)
    expect(isRetryableLoginError(new HubApiError('INVALID_CREDENTIALS', { status: 401 }))).toBe(false)
    expect(isRetryableLoginError(new HubApiError('RATE_LIMITED', { status: 429 }))).toBe(false)
    expect(isRetryableLoginError(new Error('boom'))).toBe(false)
  })
})

describe('静默登录凭据（autoLoginCredentials）', () => {
  it('勾选 + 安全存储有口令 + 没被抑制 → 返回凭据', async () => {
    const { store } = setup()
    await store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await expect(store.autoLoginCredentials()).resolves.toEqual(CREDS)
  })

  it('取消勾选 / 口令错被清 / 抑制中 → 不返回凭据', async () => {
    const canceled = setup()
    await canceled.store.onLoginSuccess(CREDS.username, CREDS.password, false)
    await expect(canceled.store.autoLoginCredentials()).resolves.toBeNull()

    const invalid = setup()
    await invalid.store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await invalid.store.onInvalidCredentials()
    await expect(invalid.store.autoLoginCredentials()).resolves.toBeNull()

    const suppressed = setup()
    await suppressed.store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await suppressed.store.suppressAutoLogin()
    await expect(suppressed.store.autoLoginCredentials()).resolves.toBeNull()
  })

  it('Web（secure=null）→ 永远没有可静默登录的凭据', async () => {
    const { store } = setup(null)
    await store.onLoginSuccess(CREDS.username, CREDS.password, true)
    await expect(store.autoLoginCredentials()).resolves.toBeNull()
  })
})
