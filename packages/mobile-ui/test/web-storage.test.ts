/**
 * 手机网页版的存储边界（WP54 / 契约 C10）。
 *
 * 网页版没有 Keystore/Keychain，令牌只能落 localStorage（`dshm.web.` 前缀）；
 * 「记住密码」直接不做（浏览器密码管理器代劳），`RememberedLoginStore` 是空实现。
 *
 * 这里锁住：
 *  - 令牌存的是同一个 `AuthTokensSchema` 形状，坏数据自愈（清掉 + 当未登录）；
 *  - 键名带前缀、`clear()` 只清自己那一条，不碰同源 Hub 网页的其它条目；
 *  - 网页版 RememberedLoginStore：不读、不写、不自动登录、canRememberPassword=false；
 *  - `REMEMBER_LOGIN_SUPPORTED` 是给 W4 的开关（APK = true）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalStorageTokenStore, WEB_STORAGE_PREFIX, WEB_TOKEN_STORAGE_KEY } from '@/lib/storage'
import { REMEMBER_LOGIN_SUPPORTED, RememberedLoginStore } from '@/lib/remembered-login'

/** 极简 localStorage（node 环境没有真 Storage）。 */
class FakeStorage {
  readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

const scope = globalThis as { localStorage?: unknown }
let storage: FakeStorage

beforeEach(() => {
  storage = new FakeStorage()
  scope.localStorage = storage
})

afterEach(() => {
  delete scope.localStorage
})

const NOW = Date.now()
const TOKENS = {
  accessToken: `dshm_at_${'a'.repeat(32)}`,
  accessExpiresAt: new Date(NOW + 3_600_000).toISOString(),
  refreshToken: `dshm_rt_${'b'.repeat(32)}`,
  refreshExpiresAt: new Date(NOW + 86_400_000).toISOString(),
  deviceId: `dv_${'0'.repeat(32)}`,
  user: { id: 1, username: 'demo', displayName: 'demo' },
}

describe('LocalStorageTokenStore（网页版令牌存储）', () => {
  it('存取清：同一个 AuthTokens 形状，键名带 dshm.web. 前缀', async () => {
    const store = new LocalStorageTokenStore()
    expect(WEB_TOKEN_STORAGE_KEY.startsWith(WEB_STORAGE_PREFIX)).toBe(true)
    expect(await store.load()).toBeNull()
    await store.save(TOKENS as never)
    expect(storage.map.has(WEB_TOKEN_STORAGE_KEY)).toBe(true)
    expect(await store.load()).toEqual(TOKENS)
    await store.clear()
    expect(await store.load()).toBeNull()
    expect(storage.map.size).toBe(0)
  })

  it('坏数据自愈：解析失败就清掉并当作未登录（不让坏条目卡住每次启动）', async () => {
    storage.map.set(WEB_TOKEN_STORAGE_KEY, '{not json')
    const store = new LocalStorageTokenStore()
    expect(await store.load()).toBeNull()
    expect(storage.map.has(WEB_TOKEN_STORAGE_KEY)).toBe(false)

    // 形状不对（缺字段）也一样
    storage.map.set(WEB_TOKEN_STORAGE_KEY, JSON.stringify({ accessToken: 'x' }))
    expect(await store.load()).toBeNull()
    expect(storage.map.has(WEB_TOKEN_STORAGE_KEY)).toBe(false)
  })

  it('只清自己那一条：同源的其它条目（Hub 网页、偏好）原样保留', async () => {
    storage.map.set('dsh-hub:ui:v1', '{"theme":"dark"}')
    storage.map.set('hub.landing.seen', '1')
    const store = new LocalStorageTokenStore()
    await store.save(TOKENS as never)
    await store.clear()
    expect([...storage.map.keys()].sort()).toEqual(['dsh-hub:ui:v1', 'hub.landing.seen'])
  })

  it('localStorage 被禁用（隐私模式）：load 返回 null、save 不抛错', async () => {
    const store = new LocalStorageTokenStore()
    scope.localStorage = {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('SecurityError')
      },
      removeItem() {
        throw new Error('SecurityError')
      },
    }
    expect(await store.load()).toBeNull()
    await expect(store.save(TOKENS as never)).resolves.toBeUndefined()
    await expect(store.clear()).resolves.toBeUndefined()
  })
})

describe('RememberedLoginStore 网页版：空实现（C10）', () => {
  function fakePrefs(): { map: Map<string, string>; store: never } {
    const map = new Map<string, string>()
    const store = {
      get: async (key: string) => map.get(key) ?? null,
      set: async (key: string, value: string) => {
        map.set(key, value)
      },
      remove: async (key: string) => {
        map.delete(key)
      },
    }
    return { map, store: store as never }
  }

  it('REMEMBER_LOGIN_SUPPORTED 在 APK 构建里是 true（网页构建里为 false）', () => {
    // vitest 的 define 把 __DSH_WEB__ 固定成 false：跑的就是 APK 语义
    expect(REMEMBER_LOGIN_SUPPORTED).toBe(true)
  })

  it('supported=false：读返回空、写忽略、不自动登录、canRememberPassword=false', async () => {
    const { map, store } = fakePrefs()
    const secureMap = new Map<string, string>()
    const secure = {
      get: async (key: string) => secureMap.get(key) ?? null,
      set: async (key: string, value: string) => {
        secureMap.set(key, value)
      },
      remove: async (key: string) => {
        secureMap.delete(key)
      },
    }
    const login = new RememberedLoginStore({ prefs: store, secure, supported: false })

    expect(login.canRememberPassword).toBe(false)
    expect(await login.load()).toEqual({
      username: '',
      password: '',
      remember: false,
      passwordRestored: false,
    })
    await login.onLoginSuccess('demo', 'demo1234', true)
    expect(secureMap.size).toBe(0)
    expect(map.size).toBe(0)
    expect(await login.autoLoginCredentials()).toBeNull()
    await login.setRemember(false)
    await login.suppressAutoLogin()
    expect(map.size).toBe(0)
    expect(await login.isAutoLoginSuppressed()).toBe(false)
  })

  it('supported=true（APK）：行为不变，仍然记用户名 + 存口令', async () => {
    const { map, store } = fakePrefs()
    const secureMap = new Map<string, string>()
    const secure = {
      get: async (key: string) => secureMap.get(key) ?? null,
      set: async (key: string, value: string) => {
        secureMap.set(key, value)
      },
      remove: async (key: string) => {
        secureMap.delete(key)
      },
    }
    const login = new RememberedLoginStore({ prefs: store, secure, supported: true })
    await login.onLoginSuccess('demo', 'demo1234', true)
    expect(map.get('dsh-hub:last-username:v1')).toBe('demo')
    expect(secureMap.size).toBe(1)
    expect(await login.load()).toMatchObject({ username: 'demo', password: 'demo1234' })
  })
})
