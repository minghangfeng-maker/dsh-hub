/**
 * 冷启动登录链路的集成测试（0.2.14「冷启仍需点登录」修复）。
 *
 * 真机根因（两条，都在这里锁住）：
 *  1) `init()` 曾经用 `inited` 布尔量：路由守卫与 App.onMounted 都调它，第二个调用立刻返回、
 *     此时 phase 还是 'boot' → App 先把用户送到登录页。现在两个调用必须等到**同一个 Promise**。
 *  2) 令牌 restore/refresh 被判无效（DEVICE_TOKEN_INVALID，非吊销）时旧实现直接 forceLogout 回
 *     登录页；现在只要「记住账号密码」还有口令，就静默自动登录回来；只有设备被吊销/没有口令/
 *     用户刚退出才展示登录页。
 *
 * 这里用假的 HubGateway / 存储替换 `@/lib/instance`，真实跑 auth store 的状态机（不连网、
 * 不碰 Capacitor 插件）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { HubApiError } from '@dsh-hub/mobile-core'

const h = vi.hoisted(() => {
  interface FakeStore {
    map: Map<string, string>
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    remove(key: string): Promise<void>
  }
  function makeStore(): FakeStore {
    const map = new Map<string, string>()
    return {
      map,
      get: async (key: string) => map.get(key) ?? null,
      set: async (key: string, value: string) => {
        map.set(key, value)
      },
      remove: async (key: string) => {
        map.delete(key)
      },
    }
  }

  const user = { id: 1, username: 'demo', displayName: 'demo' }
  const now = Date.now()
  const tokens = {
    accessToken: `dshm_at_${'a'.repeat(40)}`,
    accessExpiresAt: new Date(now + 3_600_000).toISOString(),
    refreshToken: `dshm_rt_${'b'.repeat(40)}`,
    refreshExpiresAt: new Date(now + 86_400_000).toISOString(),
    deviceId: `dv_${'0'.repeat(32)}`,
    user,
  }

  const state = {
    /** restore() 的返回值（null = 本地没有令牌）。 */
    restoreResult: null as typeof tokens | null,
    restoreCalls: 0,
    /** 测试用：restore() 先等这个 Promise 再返回（模拟冷启动读 Keystore 的耗时）。 */
    restoreGate: null as Promise<void> | null,
    /** login() 调用记录。 */
    loginRequests: [] as Array<{ username: string; password: string }>,
    /** 前 N 次 login 抛网络错误（模拟冷启动网络栈没起来）。 */
    loginNetworkFailures: 0,
    /** 每次 login 都抛这个错误（null = 成功）。 */
    loginError: null as unknown,
    /** 前 N 次 bootstrap 抛 bootstrapError。 */
    bootstrapFailures: 0,
    bootstrapError: null as unknown,
    bootstrapCalls: 0,
    /** bootstrap.app：默认比本机新号大很多？不——默认不触发更新（老测试不受影响）。 */
    appInfo: {
      minVersionCode: 1,
      latestVersionCode: 10,
      downloadUrl: null as string | null,
    },
    authLostHandlers: [] as Array<(reason: string) => void>,
    tokenStore: {
      current: null as typeof tokens | null,
      clears: 0,
      async load() {
        return state.tokenStore.current
      },
      async save(next: typeof tokens) {
        state.tokenStore.current = next
      },
      async clear() {
        state.tokenStore.clears += 1
        state.tokenStore.current = null
      },
    },
    prefs: makeStore(),
    secure: makeStore(),
    user,
    tokens,
  }
  return { state, makeStore }
})

vi.mock('@/lib/instance', async () => {
  const { RememberedLoginStore } = await import('@/lib/remembered-login')
  const { HubApiError: ErrorClass } = await import('@dsh-hub/mobile-core')
  const { state } = h

  const bootstrapBody = () => ({
    user: state.user,
    points: { balance: 12.5, enabled: true },
    backends: [
      {
        id: 'cloud:self',
        kind: 'cloud',
        name: '云服务器',
        status: 'running',
        connectable: true,
        capabilities: {
          sessions: true,
          history: true,
          send: true,
          stop: true,
          stream: true,
          questions: true,
          approvals: false,
          create: true,
        },
      },
    ],
    instance: { status: 'running', capacityFull: false },
    app: { ...state.appInfo },
    serverTime: new Date().toISOString(),
  })

  const gateway = {
    mode: 'mock' as const,
    origin: 'mock',
    hasSession: async () => state.restoreResult !== null,
    restore: async () => {
      state.restoreCalls += 1
      if (state.restoreGate) await state.restoreGate
      return state.restoreResult
    },
    login: async (input: { username: string; password: string }) => {
      state.loginRequests.push({ username: input.username, password: input.password })
      if (state.loginNetworkFailures > 0) {
        state.loginNetworkFailures -= 1
        throw new ErrorClass('network')
      }
      if (state.loginError) throw state.loginError
      await state.tokenStore.save(state.tokens)
      return state.tokens
    },
    logout: async () => {
      await state.tokenStore.clear()
    },
    consolidateDevices: async () => 0,
    bootstrap: async () => {
      state.bootstrapCalls += 1
      if (state.bootstrapFailures > 0) {
        state.bootstrapFailures -= 1
        throw state.bootstrapError
      }
      return bootstrapBody() as never
    },
    wake: async () => ({ status: 'starting' }) as never,
    openChannel: async () => {
      throw new Error('unused in auth tests')
    },
    onAuthLost: (handler: (reason: string) => void) => {
      state.authLostHandlers.push(handler)
      return () => {
        state.authLostHandlers = state.authLostHandlers.filter((item) => item !== handler)
      }
    },
  }

  return {
    gateway,
    prefs: state.prefs,
    tokenStore: state.tokenStore,
    loginSecureStore: state.secure,
    rememberedLogin: new RememberedLoginStore({ prefs: state.prefs, secure: state.secure }),
    selectionStore: {
      getLastBackend: async () => null,
      setLastBackend: async () => {},
      getSelection: async () => null,
      setSelection: async () => {},
      forgetAccount: async () => {},
    },
    sessionCache: {
      clearAccount: async () => {},
      clearAll: async () => {},
      getSessions: async () => null,
      getConversation: async () => null,
      putSessions: async () => {},
      putConversation: async () => {},
    },
  }
})

const { useAuthStore } = await import('@/stores/auth')
const { useAppUpdateStore } = await import('@/stores/app-update')
const { rememberedLogin } = await import('@/lib/instance')

function resetState(): void {
  const { state } = h
  state.restoreResult = null
  state.restoreCalls = 0
  state.restoreGate = null
  state.loginRequests = []
  state.loginNetworkFailures = 0
  state.loginError = null
  state.bootstrapFailures = 0
  state.bootstrapError = null
  state.bootstrapCalls = 0
  state.appInfo = { minVersionCode: 1, latestVersionCode: 10, downloadUrl: null }
  state.authLostHandlers = []
  state.tokenStore.current = null
  state.tokenStore.clears = 0
  state.prefs.map.clear()
  state.secure.map.clear()
}

/** 预置「记住账号密码」：勾选 + 安全存储里有口令 + 未抑制。 */
async function seedCredentials(): Promise<void> {
  await rememberedLogin.onLoginSuccess('demo', 'demo1234', true)
  await rememberedLogin.allowAutoLogin()
}

function newAuth() {
  setActivePinia(createPinia())
  return useAuthStore()
}

/**
 * App 更新检查已从 auth store 拆到 `stores/app-update.ts`（WP46 C）：
 * 断言内容与拆分前完全一致，只是读的 store 换了。
 */
function newAuthWithUpdate() {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  return { auth, appUpdate: useAppUpdateStore() }
}

describe('冷启动：已登录用户不需要再点登录', () => {
  beforeEach(() => resetState())

  it('本地令牌可用：直接恢复登录态，不调 login', async () => {
    h.state.restoreResult = h.state.tokens
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('authenticated')
    expect(auth.user?.username).toBe('demo')
    expect(h.state.loginRequests).toHaveLength(0)
  })

  it('init 并发调用（路由守卫 + App.onMounted）等的是同一个结果，不会提前判未登录', async () => {
    h.state.restoreResult = h.state.tokens
    let releaseRestore!: () => void
    h.state.restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve
    })
    const auth = newAuth()
    const first = auth.init()
    const second = auth.init()

    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    // 让微任务/宏任务跑一轮：旧实现（inited 布尔量）第二个 init 会立刻 resolve，
    // App 就会看到 phase 还是 boot、把用户先送去登录页。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondSettled).toBe(false)
    expect(auth.phase).toBe('boot')
    // 两个调用共用同一份恢复流程，不会把 SecureStorage 读两次
    expect(h.state.restoreCalls).toBe(1)

    releaseRestore()
    await Promise.all([first, second])
    expect(secondSettled).toBe(true)
    expect(auth.phase).toBe('authenticated')
    expect(h.state.restoreCalls).toBe(1)
  })

  it('没有本地令牌但记住口令：冷启动静默自动登录；网络错误自动重试', async () => {
    await seedCredentials()
    h.state.loginNetworkFailures = 1 // 第一次网络失败（冷启动网络栈没起来）
    const auth = newAuth()
    await auth.init()
    expect(h.state.loginRequests).toHaveLength(2)
    expect(auth.phase).toBe('authenticated')
    expect(auth.user?.username).toBe('demo')
  })

  it('主动退出后（抑制自动登录）：回登录页，不偷偷登回去', async () => {
    await seedCredentials()
    await rememberedLogin.suppressAutoLogin()
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('anonymous')
    expect(h.state.loginRequests).toHaveLength(0)
  })

  it('没有记住口令：回登录页（登录页只在真的恢复不了时出现）', async () => {
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('anonymous')
    expect(h.state.loginRequests).toHaveLength(0)
  })
})

describe('令牌不可用（非吊销）：静默自动登录回退', () => {
  beforeEach(() => resetState())

  it('bootstrap 返回 DEVICE_TOKEN_INVALID：用记住的口令登回来，保持登录态', async () => {
    h.state.restoreResult = h.state.tokens
    h.state.bootstrapFailures = 1
    h.state.bootstrapError = new HubApiError('DEVICE_TOKEN_INVALID', { status: 401 })
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('authenticated')

    // 坏令牌被清掉 → 静默登录一次 → 又恢复成 authenticated（用户看不到登录页）
    await vi.waitFor(() => expect(h.state.loginRequests).toHaveLength(1))
    await vi.waitFor(() => expect(auth.phase).toBe('authenticated'))
    expect(h.state.loginRequests[0]).toEqual({ username: 'demo', password: 'demo1234' })
    expect(h.state.tokenStore.clears).toBeGreaterThan(0)
    expect(auth.issue).toBeNull()
  })

  it('forceLogout(expired)（比如通道报 session-expired）：同样静默登回来', async () => {
    h.state.restoreResult = h.state.tokens
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('authenticated')

    await auth.forceLogout('expired')
    expect(h.state.loginRequests).toHaveLength(1)
    expect(auth.phase).toBe('authenticated')
  })

  it('refresh 被拒但没有记住口令：才回登录页', async () => {
    h.state.restoreResult = h.state.tokens
    h.state.bootstrapFailures = 1
    h.state.bootstrapError = new HubApiError('DEVICE_TOKEN_INVALID', { status: 401 })
    const auth = newAuth()
    await auth.init()
    await vi.waitFor(() => expect(auth.phase).toBe('anonymous'))
    expect(h.state.loginRequests).toHaveLength(0)
  })
})

describe('设备被吊销：必须回登录页，不能被自动登录登回去', () => {
  beforeEach(() => resetState())

  it('DEVICE_REVOKED：回匿名 + 抑制自动登录 + 清口令', async () => {
    h.state.restoreResult = h.state.tokens
    h.state.bootstrapFailures = 1
    h.state.bootstrapError = new HubApiError('DEVICE_REVOKED', { status: 401 })
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    await vi.waitFor(() => expect(auth.phase).toBe('anonymous'))
    expect(h.state.loginRequests).toHaveLength(0)
    expect(await rememberedLogin.isAutoLoginSuppressed()).toBe(true)
    expect(await rememberedLogin.autoLoginCredentials()).toBeNull()
  })

  it('通道刷新回调 onAuthLost(device-revoked)：同样回登录页', async () => {
    h.state.restoreResult = h.state.tokens
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('authenticated')

    const handler = h.state.authLostHandlers[0]
    expect(handler).toBeTypeOf('function')
    handler!('device-revoked')
    await vi.waitFor(() => expect(auth.phase).toBe('anonymous'))
    expect(h.state.loginRequests).toHaveLength(0)
  })
})

// ── 0.2.17：只有「过期/失效」类才静默登录 ────────────────────────────────────
//
// Hub 端契约（`apps/api/src/modules/mobile/auth.ts`）：
//   refresh token 过期 / 查不到 / 宽限期内重复用旧 refresh → 401 DEVICE_TOKEN_INVALID；
//   超过宽限期的重放（Hub 直接吊销整台设备）/ 设备被吊销 / 账号被删 → 401 DEVICE_REVOKED；
//   账号停用、待审批、必须改密码 → USER_DISABLED / USER_PENDING / MUST_CHANGE_PASSWORD。
// 0.2.14「除吊销以外都静默登录」把「重放/轮换（疑似泄露）」和「账号停用」也自动登回去了，
// 这里锁住收紧后的行为：一律回登录页，并像吊销一样抑制自动登录、清掉保存的口令。

describe('轮换/重放与账号停用：不许用保存的口令静默登回去（0.2.17）', () => {
  beforeEach(() => resetState())

  it('轮换/重放（假设 Hub/Hub 客户端给独立码）：回登录页 + 抑制自动登录 + 清口令', async () => {
    h.state.restoreResult = h.state.tokens
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('authenticated')
    // 说明：`HubApiError` 会把不认识的码规范化成 `internal`，所以「轮换/重放」这类还没有
    // 官方错误码的信号是经通道/刷新层以 reason 形式报上来的（与设备吊销同一条路径）。
    await auth.forceLogout('expired', 'DEVICE_ROTATED')
    expect(auth.phase).toBe('anonymous')
    expect(h.state.loginRequests).toHaveLength(0)
    expect(await rememberedLogin.isAutoLoginSuppressed()).toBe(true)
    expect(await rememberedLogin.autoLoginCredentials()).toBeNull()
  })

  it('账号被停用（USER_DISABLED）：回登录页、给出账号文案、抑制自动登录 + 清口令', async () => {
    h.state.restoreResult = h.state.tokens
    h.state.bootstrapFailures = 1
    h.state.bootstrapError = new HubApiError('USER_DISABLED', { status: 403 })
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    await vi.waitFor(() => expect(auth.phase).toBe('anonymous'))
    expect(h.state.loginRequests).toHaveLength(0)
    expect(auth.issue?.message).toContain('停用')
    expect(await rememberedLogin.isAutoLoginSuppressed()).toBe(true)
    expect(await rememberedLogin.autoLoginCredentials()).toBeNull()
  })

  it('必须改初始密码（MUST_CHANGE_PASSWORD）：回登录页 + 抑制自动登录', async () => {
    h.state.restoreResult = h.state.tokens
    h.state.bootstrapFailures = 1
    h.state.bootstrapError = new HubApiError('MUST_CHANGE_PASSWORD', { status: 403 })
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    await vi.waitFor(() => expect(auth.phase).toBe('anonymous'))
    expect(h.state.loginRequests).toHaveLength(0)
    expect(auth.issue?.message).toContain('网页端')
    expect(await rememberedLogin.isAutoLoginSuppressed()).toBe(true)
  })

  it('无法识别的码：默认不自动登录（抑制），但不销毁口令', async () => {
    h.state.restoreResult = h.state.tokens
    await seedCredentials()
    const auth = newAuth()
    await auth.init()
    expect(auth.phase).toBe('authenticated')
    await auth.forceLogout('expired', 'SOMETHING_NEW')
    expect(auth.phase).toBe('anonymous')
    expect(h.state.loginRequests).toHaveLength(0)
    // 不是安全事件：抑制下次自动登录，但口令留着（用户手点登录时还能预填）
    expect(await rememberedLogin.isAutoLoginSuppressed()).toBe(true)
    expect(await rememberedLogin.autoLoginCredentials()).toBeNull()
    await rememberedLogin.allowAutoLogin()
    expect(await rememberedLogin.autoLoginCredentials()).not.toBeNull()
  })
})

describe('App 更新提示（bootstrap.app，0.2.16）', () => {
  beforeEach(() => resetState())

  it('latestVersionCode 高于本机：可更新，并带出下载地址给「立即更新」', async () => {
    const { APP_VERSION_CODE } = await import('@/lib/app-info')
    h.state.appInfo = {
      minVersionCode: 1,
      latestVersionCode: APP_VERSION_CODE + 1,
      downloadUrl: 'https://cdn.example.com/downloads/mobile-app/dsh-hub-app-9.9.9-abc123.apk',
    }
    h.state.restoreResult = h.state.tokens
    const { auth, appUpdate } = newAuthWithUpdate()
    await auth.init()
    expect(auth.appRelease?.latestVersionCode).toBe(APP_VERSION_CODE + 1)
    expect(appUpdate.updateRequired).toBe(false)
    expect(appUpdate.updateAvailable).toBe(true)
    expect(appUpdate.updateDownloadUrl).toContain('dsh-hub-app-9.9.9')
  })

  it('minVersionCode 高于本机：强更，普通「稍后」不适用', async () => {
    const { APP_VERSION_CODE } = await import('@/lib/app-info')
    h.state.appInfo = {
      minVersionCode: APP_VERSION_CODE + 2,
      latestVersionCode: APP_VERSION_CODE + 2,
      downloadUrl: null,
    }
    h.state.restoreResult = h.state.tokens
    const { auth, appUpdate } = newAuthWithUpdate()
    await auth.init()
    expect(appUpdate.updateRequired).toBe(true)
    expect(appUpdate.updateAvailable).toBe(false)
    expect(appUpdate.updateDownloadUrl).toBeNull()
  })

  it('点「稍后」本次运行不再提示；手动检查更新会重新打开提示', async () => {
    const { APP_VERSION_CODE } = await import('@/lib/app-info')
    h.state.appInfo = {
      minVersionCode: 1,
      latestVersionCode: APP_VERSION_CODE + 1,
      downloadUrl: null,
    }
    h.state.restoreResult = h.state.tokens
    const { auth, appUpdate } = newAuthWithUpdate()
    await auth.init()
    expect(appUpdate.updateAvailable).toBe(true)
    appUpdate.dismissAppUpdate()
    expect(appUpdate.updateAvailable).toBe(false)
    const result = await appUpdate.checkAppUpdate()
    expect(result).toBe('available')
    expect(appUpdate.updateAvailable).toBe(true)
  })

  it('已经是最新版本：手动检查返回 latest，不弹提示', async () => {
    h.state.restoreResult = h.state.tokens
    const { auth, appUpdate } = newAuthWithUpdate()
    await auth.init()
    expect(await appUpdate.checkAppUpdate()).toBe('latest')
    expect(appUpdate.updateAvailable).toBe(false)
    expect(appUpdate.updateRequired).toBe(false)
  })
})
