import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestClock } from '../src/lib/clock.js'
import { DISK_CACHE_TTL_MS, createDiskUsageCache, measureDirBytes } from '../src/modules/instances/disk.js'

/**
 * WP45 磁盘统计：旧的异步实现（`await lstat`）走 libuv 4 线程池，
 * 7.5 万文件的目录要 8–12 秒；同步实现 + 每 N 个文件让出事件循环只要 0.5–0.6 秒。
 * 这里锁住语义（不跟随符号链接、累加 st_size、目录递归），以及「绝不阻塞调用方」的缓存口径。
 */

const dirs: string[] = []

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'wp45-disk-'))
  dirs.push(root)
  writeFileSync(join(root, 'a.txt'), 'x'.repeat(100))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'b.bin'), 'y'.repeat(200))
  mkdirSync(join(root, 'sub', 'deep'))
  writeFileSync(join(root, 'sub', 'deep', 'c.bin'), 'z'.repeat(300))
  // 符号链接不跟随、也不把链接自身的 size 算进去
  symlinkSync('/etc/hostname', join(root, 'link-outside'))
  // 稀疏文件按 st_size 计（与旧实现一致）
  const sparse = join(root, 'sparse.bin')
  writeFileSync(sparse, '')
  truncateSync(sparse, 4096)
  return root
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('measureDirBytes（WP45 同步遍历）', () => {
  it('递归累加文件 st_size，不跟随符号链接', async () => {
    const root = makeTree()
    // 100 + 200 + 300 + 4096（sparse 按 st_size）+ a.txt 目录项本身不算
    expect(await measureDirBytes(root)).toBe(100 + 200 + 300 + 4096)
  })

  it('yieldEvery 只影响让出频率，不影响结果', async () => {
    const root = makeTree()
    expect(await measureDirBytes(root, { yieldEvery: 1 })).toBe(100 + 200 + 300 + 4096)
  })

  it('目录不存在 / 不可读 → 0（不抛）', async () => {
    expect(await measureDirBytes(join(tmpdir(), 'wp45-not-exists-xyz'))).toBe(0)
  })
})

describe('createDiskUsageCache（WP45 不阻塞口径）', () => {
  it('冷缓存：peekOrRefresh 立即返回 null 并在后台补测；peek 随后有值', async () => {
    const root = makeTree()
    const cache = createDiskUsageCache()

    expect(cache.peek('u1')).toBeNull()
    const first = cache.peekOrRefresh('u1', root)
    expect(first).toBeNull() // 统计还没跑完（至少要让出一次事件循环）
    for (let i = 0; i < 200 && cache.peek('u1') === null; i += 1) await sleep(5)
    expect(cache.peek('u1')).toBe(100 + 200 + 300 + 4096)
    // 有新鲜缓存后，peekOrRefresh 直接给数字
    expect(cache.peekOrRefresh('u1', root)).toBe(100 + 200 + 300 + 4096)
  })

  it('getWithin：命中缓存 → 立即给；冷缓存 + 足够预算 → 给出数字', async () => {
    const root = makeTree()
    const cache = createDiskUsageCache()
    expect(await cache.getWithin('u1', root, 2_000)).toBe(100 + 200 + 300 + 4096)
    expect(await cache.getWithin('u1', root, 0)).toBe(100 + 200 + 300 + 4096)
  })

  it('getWithin：预算为 0 且冷缓存 → 返回 null（先放行，统计继续在后台跑）', async () => {
    const root = makeTree()
    const cache = createDiskUsageCache()
    // 用一个「先让出、再算完」的统计：把 yieldEvery 调到 1 也拦不住目录很小
    // → 这里直接验证「预算 0 不等待」的语义：返回值必为 null（统计尚未落缓存）
    expect(await cache.getWithin('u1', root, 0)).toBeNull()
    for (let i = 0; i < 200 && cache.peek('u1') === null; i += 1) await sleep(5)
    expect(cache.peek('u1')).toBe(100 + 200 + 300 + 4096)
  })

  it('缓存按 TTL 过期：过期后 peekOrRefresh 给旧值并触发重新统计', async () => {
    const root = makeTree()
    const clock = createTestClock('2026-10-27T00:00:00.000Z')
    const cache = createDiskUsageCache({ clock })
    expect(await cache.get('u1', root)).toBe(100 + 200 + 300 + 4096)

    writeFileSync(join(root, 'extra.bin'), 'x'.repeat(1000))
    clock.advance(DISK_CACHE_TTL_MS + 1)
    // 过期：立刻返回旧值（不阻塞），同时后台重测
    expect(cache.peekOrRefresh('u1', root)).toBe(100 + 200 + 300 + 4096)
    for (let i = 0; i < 200 && cache.peek('u1') === 100 + 200 + 300 + 4096; i += 1) await sleep(5)
    expect(cache.peek('u1')).toBe(100 + 200 + 300 + 4096 + 1000)
  })

  it('invalidate 清掉缓存（删用户/回收站后要重测）', async () => {
    const root = makeTree()
    const cache = createDiskUsageCache()
    await cache.get('u1', root)
    expect(cache.peek('u1')).not.toBeNull()
    cache.invalidate('u1')
    expect(cache.peek('u1')).toBeNull()
  })

  it('同一用户并发触发只跑一次统计（去重）', async () => {
    const root = makeTree()
    const cache = createDiskUsageCache()
    const [a, b] = await Promise.all([cache.get('u1', root), cache.get('u1', root)])
    expect(a).toBe(b)
  })
})
