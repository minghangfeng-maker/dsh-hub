import { describe, expect, it } from 'vitest'
import {
  MemoryTokenStore,
  SecureTokenStore,
  describeTokens,
  isAccessExpired,
  isRefreshExpired,
  type SecureStringStore,
} from '../src/auth/token-store.js'
import { NOW, makeTokens } from './helpers/tokens.js'

class FakeSecureBackend implements SecureStringStore {
  data = new Map<string, string>()
  removed: string[] = []
  failGet = false
  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error('keystore unavailable')
    return this.data.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.removed.push(key)
    this.data.delete(key)
  }
}

describe('MemoryTokenStore', () => {
  it('保存/读取/清除', async () => {
    const store = new MemoryTokenStore()
    expect(await store.load()).toBeNull()
    await store.save(makeTokens())
    expect((await store.load())?.accessToken).toBe(`dshm_at_${'a'.repeat(40)}`)
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})

describe('SecureTokenStore（Android Keystore 后端的最小接口）', () => {
  it('只写一个固定 key，读回相等', async () => {
    const backend = new FakeSecureBackend()
    const store = new SecureTokenStore(backend)
    await store.save(makeTokens())
    expect([...backend.data.keys()]).toEqual([SecureTokenStore.KEY])
    expect(await store.load()).toEqual(makeTokens())
  })

  it('损坏的 JSON / 形状不符 → 当作未登录并清掉', async () => {
    const backend = new FakeSecureBackend()
    const store = new SecureTokenStore(backend)
    backend.data.set(SecureTokenStore.KEY, '{not json')
    expect(await store.load()).toBeNull()
    expect(backend.removed).toContain(SecureTokenStore.KEY)

    backend.data.set(SecureTokenStore.KEY, JSON.stringify({ accessToken: 'x' }))
    expect(await store.load()).toBeNull()
  })

  it('后端读失败不抛错（避免登录页崩溃循环）', async () => {
    const backend = new FakeSecureBackend()
    backend.failGet = true
    const store = new SecureTokenStore(backend)
    expect(await store.load()).toBeNull()
  })

  it('诊断信息不含令牌正文', () => {
    const text = describeTokens(makeTokens())
    expect(text).toContain('user=demo')
    expect(text).not.toContain('dshm_at_')
    expect(text).not.toContain('dshm_rt_')
  })
})

describe('过期判断', () => {
  it('access 提前 30s 视为过期', () => {
    const tokens = makeTokens({ accessExpiresAt: new Date(NOW + 10_000).toISOString() })
    expect(isAccessExpired(tokens, NOW)).toBe(true)
    expect(isAccessExpired(makeTokens(), NOW)).toBe(false)
  })

  it('refresh 过期就是必须重新登录', () => {
    const tokens = makeTokens({ refreshExpiresAt: new Date(NOW - 1).toISOString() })
    expect(isRefreshExpired(tokens, NOW)).toBe(true)
  })

  it('非法时间字符串按过期处理', () => {
    const tokens = makeTokens({ accessExpiresAt: 'not-a-date' as never })
    expect(isAccessExpired(tokens, NOW)).toBe(true)
  })
})
