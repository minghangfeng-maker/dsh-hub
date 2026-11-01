/**
 * 产出文件持久缓存（0.2.14 真机反馈 ① ②）。
 *
 * 覆盖：命中、LRU 淘汰、账号隔离、按会话/账号清理、单文件超预算不写、
 * IndexedDB 实现的关键路径（建表/复合 key/游标删，用自写 fake 跑）、
 * 以及「退出登录 → sessionCache.clearAccount → 文件缓存一起清」的联动。
 */

import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_FILE_CACHE_MAX_BYTES,
  IndexedDbFileStore,
  MemoryFileStore,
  createFileStore,
  fileCacheKeyOf,
  fileNameOfKey,
  pathOfCacheKey,
  type StoredFile,
} from '../src/cache/file-store.js'
import { IndexedDbSessionCache, MemorySessionCache } from '../src/cache/session-cache.js'
import { registerAccountCachePurger } from '../src/cache/db.js'
import { FakeIndexedDB } from './helpers/fake-indexeddb.js'

function bytesOf(size: number, fill = 7): Uint8Array {
  return new Uint8Array(size).fill(fill)
}

function fileOf(overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    accountKey: 'https://hub.test|alice',
    sessionId: 's1',
    key: 'ref-1',
    name: 'a.png',
    mimeType: 'image/png',
    mediaType: 'image',
    bytes: 4,
    data: bytesOf(4),
    cachedAt: 1_000,
    touchedAt: 1_000,
    ...overrides,
  }
}

describe('缓存键与展示名', () => {
  it('fileRef 优先，只有 path 时用 path: 前缀（避免撞键）', () => {
    expect(fileCacheKeyOf({ fileRef: 'ref-x' })).toBe('ref-x')
    expect(fileCacheKeyOf({ path: '/workspace/a.png' })).toBe('path:/workspace/a.png')
    expect(fileCacheKeyOf({ fileRef: 'ref-x', path: '/workspace/a.png' })).toBe('ref-x')
    expect(fileCacheKeyOf({})).toBeNull()
    expect(fileCacheKeyOf({ fileRef: '', path: '' })).toBeNull()
    expect(pathOfCacheKey('path:/workspace/a.png')).toBe('/workspace/a.png')
    expect(pathOfCacheKey('ref-x')).toBeNull()
    expect(fileNameOfKey('path:/workspace/out/pelican.png')).toBe('pelican.png')
    expect(fileNameOfKey('ref-x', 'file')).toBe('ref-x')
  })
})

describe('MemoryFileStore（Node 单测 / 隐私模式降级）', () => {
  it('写入后命中，并返回字节与元信息', async () => {
    const store = new MemoryFileStore()
    await store.put(fileOf({ data: bytesOf(6, 3), bytes: 6 }))
    const hit = await store.get('https://hub.test|alice', 's1', 'ref-1')
    expect(hit).not.toBeNull()
    expect([...hit!.data]).toEqual([...bytesOf(6, 3)])
    expect(hit!.mimeType).toBe('image/png')
    expect(await store.has('https://hub.test|alice', 's1', 'ref-1')).toBe(true)
    expect(await store.get('https://hub.test|alice', 's1', 'ref-missing')).toBeNull()
  })

  it('按账号 + 会话隔离（同 key 不同账号互不可见）', async () => {
    const store = new MemoryFileStore()
    await store.put(fileOf({ accountKey: 'acc-a', data: bytesOf(3, 1) }))
    await store.put(fileOf({ accountKey: 'acc-b', data: bytesOf(3, 2) }))
    expect([...(await store.get('acc-a', 's1', 'ref-1'))!.data]).toEqual([...bytesOf(3, 1)])
    expect([...(await store.get('acc-b', 's1', 'ref-1'))!.data]).toEqual([...bytesOf(3, 2)])
    await store.clearAccount('acc-a')
    expect(await store.get('acc-a', 's1', 'ref-1')).toBeNull()
    expect(await store.get('acc-b', 's1', 'ref-1')).not.toBeNull()
  })

  it('总字节超上限按 LRU 淘汰（命中会把条目挪到最近）', async () => {
    const store = new MemoryFileStore({ maxBytes: 9 })
    await store.put(fileOf({ key: 'a', data: bytesOf(3, 1) }))
    await store.put(fileOf({ key: 'b', data: bytesOf(3, 2) }))
    await store.put(fileOf({ key: 'c', data: bytesOf(3, 3) }))
    // 命中 a → a 变成最近使用；再写 d 应该淘汰 b（最久未用）
    expect(await store.get('https://hub.test|alice', 's1', 'a')).not.toBeNull()
    await store.put(fileOf({ key: 'd', data: bytesOf(3, 4) }))
    expect(await store.get('https://hub.test|alice', 's1', 'b')).toBeNull()
    expect(await store.get('https://hub.test|alice', 's1', 'a')).not.toBeNull()
    expect((await store.stats()).bytes).toBeLessThanOrEqual(9)
  })

  it('单个文件就超过总预算时不写（写了也会立刻被自己挤掉）', async () => {
    const store = new MemoryFileStore({ maxBytes: 4 })
    await store.put(fileOf({ key: 'big', data: bytesOf(5), bytes: 5 }))
    expect(await store.get('https://hub.test|alice', 's1', 'big')).toBeNull()
  })

  it('clearSession 只清该会话', async () => {
    const store = new MemoryFileStore()
    await store.put(fileOf({ sessionId: 's1', key: 'k1' }))
    await store.put(fileOf({ sessionId: 's2', key: 'k1' }))
    await store.clearSession('https://hub.test|alice', 's1')
    expect(await store.get('https://hub.test|alice', 's1', 'k1')).toBeNull()
    expect(await store.get('https://hub.test|alice', 's2', 'k1')).not.toBeNull()
  })
})

describe('IndexedDbFileStore（手机真机路径）', () => {
  const fake = new FakeIndexedDB()
  let store: IndexedDbFileStore

  beforeAll(() => {
    ;(globalThis as { indexedDB?: unknown }).indexedDB = fake as unknown as IDBFactory
  })
  afterAll(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB
  })
  beforeEach(async () => {
    store = new IndexedDbFileStore({ maxBytes: 30 })
    await store.clearAll()
  })

  it('写入后命中（跨「重启」新建实例也命中：这就是重开会话秒开的关键）', async () => {
    await store.put(fileOf({ data: bytesOf(5, 9), bytes: 5 }))
    const reopened = new IndexedDbFileStore({ maxBytes: 30 })
    const hit = await reopened.get('https://hub.test|alice', 's1', 'ref-1')
    expect(hit).not.toBeNull()
    expect([...hit!.data]).toEqual([...bytesOf(5, 9)])
    expect(hit!.name).toBe('a.png')
    expect(hit!.mediaType).toBe('image')
  })

  it('按 path 键缓存（正文里的云端路径图片）', async () => {
    const key = fileCacheKeyOf({ path: '/workspace/out/pelican.png' })!
    await store.put(
      fileOf({ key, name: 'pelican.png', mimeType: 'image/png', data: bytesOf(2), bytes: 2 }),
    )
    expect(await store.has('https://hub.test|alice', 's1', key)).toBe(true)
    expect((await store.get('https://hub.test|alice', 's1', key))!.name).toBe('pelican.png')
  })

  it('账号隔离 + clearAccount 只清当前账号', async () => {
    await store.put(fileOf({ accountKey: 'acc-a', data: bytesOf(3, 1) }))
    await store.put(fileOf({ accountKey: 'acc-b', data: bytesOf(3, 2) }))
    expect([...(await store.get('acc-a', 's1', 'ref-1'))!.data]).toEqual([...bytesOf(3, 1)])
    expect([...(await store.get('acc-b', 's1', 'ref-1'))!.data]).toEqual([...bytesOf(3, 2)])
    await store.clearAccount('acc-a')
    expect(await store.get('acc-a', 's1', 'ref-1')).toBeNull()
    expect(await store.get('acc-b', 's1', 'ref-1')).not.toBeNull()
  })

  it('clearSession 只清该会话（同账号其它会话保留）', async () => {
    await store.put(fileOf({ sessionId: 's1', key: 'k' }))
    await store.put(fileOf({ sessionId: 's2', key: 'k' }))
    await store.clearSession('https://hub.test|alice', 's1')
    expect(await store.get('https://hub.test|alice', 's1', 'k')).toBeNull()
    expect(await store.get('https://hub.test|alice', 's2', 'k')).not.toBeNull()
  })

  it('超上限按 touchedAt 从旧到新淘汰，stats 与真实占用一致', async () => {
    const base = fileOf({ accountKey: 'acc', sessionId: 's' })
    await store.put({ ...base, key: 'old', data: bytesOf(10, 1), bytes: 10, touchedAt: 100 })
    await store.put({ ...base, key: 'mid', data: bytesOf(10, 2), bytes: 10, touchedAt: 200 })
    await store.put({ ...base, key: 'new', data: bytesOf(10, 3), bytes: 10, touchedAt: 300 })
    expect(await store.stats()).toEqual({ count: 3, bytes: 30 })
    // 再写 10 字节：总 40 > 30，淘汰 touchedAt 最小的 old
    await store.put({ ...base, key: 'newest', data: bytesOf(10, 4), bytes: 10, touchedAt: 400 })
    expect(await store.get('acc', 's', 'old')).toBeNull()
    expect(await store.get('acc', 's', 'newest')).not.toBeNull()
    const stats = await store.stats()
    expect(stats.count).toBe(3)
    expect(stats.bytes).toBeLessThanOrEqual(30)
  })

  it('get 会更新 touchedAt（命中过的条目不会被先淘汰）', async () => {
    const base = fileOf({ accountKey: 'acc', sessionId: 's' })
    await store.put({ ...base, key: 'a', data: bytesOf(10, 1), bytes: 10, touchedAt: 100 })
    await store.put({ ...base, key: 'b', data: bytesOf(10, 2), bytes: 10, touchedAt: 200 })
    await store.put({ ...base, key: 'c', data: bytesOf(10, 3), bytes: 10, touchedAt: 300 })
    // 命中 a：touchedAt 变成现在（>300），此后写 d 应淘汰 b
    expect(await store.get('acc', 's', 'a')).not.toBeNull()
    await store.put({ ...base, key: 'd', data: bytesOf(10, 4), bytes: 10, touchedAt: 400 })
    expect(await store.get('acc', 's', 'b')).toBeNull()
    expect(await store.get('acc', 's', 'a')).not.toBeNull()
  })

  it('单个文件超过总预算不写', async () => {
    await store.put(fileOf({ key: 'big', data: bytesOf(31), bytes: 31 }))
    expect(await store.has('https://hub.test|alice', 's1', 'big')).toBe(false)
  })

  it('默认上限是 128MiB', () => {
    expect(DEFAULT_FILE_CACHE_MAX_BYTES).toBe(128 * 1024 * 1024)
  })

  it('退出登录/换账号：sessionCache.clearAccount → 持久缓存按账号清空（真实 IndexedDB 路径）', async () => {
    const fileCache = new IndexedDbFileStore({ maxBytes: 100 })
    await fileCache.clearAll()
    // 模拟 instance.ts 里的注册关系：文件缓存挂到 sessionCache 的账号清理动作上。
    const unregister = registerAccountCachePurger((accountKey) =>
      accountKey === null ? fileCache.clearAll() : fileCache.clearAccount(accountKey),
    )
    try {
      await fileCache.put(fileOf({ accountKey: 'acc-a', data: bytesOf(3, 1) }))
      await fileCache.put(fileOf({ accountKey: 'acc-b', data: bytesOf(3, 2) }))
      const sessionCache = new IndexedDbSessionCache()
      await sessionCache.clearAccount('acc-a')
      expect(await fileCache.get('acc-a', 's1', 'ref-1')).toBeNull()
      expect(await fileCache.get('acc-b', 's1', 'ref-1')).not.toBeNull()
      // 无账号上下文的兜底清理（clearAll）必须清干净全部账号
      await sessionCache.clearAll()
      expect(await fileCache.get('acc-b', 's1', 'ref-1')).toBeNull()
      expect(await fileCache.stats()).toEqual({ count: 0, bytes: 0 })
    } finally {
      unregister()
    }
  })
})

describe('createFileStore + 退出登录联动清理', () => {
  it('sessionCache.clearAccount 会把该账号的文件缓存一起清掉', async () => {
    const store = createFileStore({ registerAccountPurger: true })
    await store.put(fileOf({ accountKey: 'acc-a', data: bytesOf(4) }))
    await store.put(fileOf({ accountKey: 'acc-b', data: bytesOf(4) }))
    const sessionCache = new MemorySessionCache()
    await sessionCache.clearAccount('acc-a')
    expect(await store.get('acc-a', 's1', 'ref-1')).toBeNull()
    expect(await store.get('acc-b', 's1', 'ref-1')).not.toBeNull()
    // clearAll（无账号上下文）清全部
    await sessionCache.clearAll()
    expect(await store.get('acc-b', 's1', 'ref-1')).toBeNull()
  })
})
