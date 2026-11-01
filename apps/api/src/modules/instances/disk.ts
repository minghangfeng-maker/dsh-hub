import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../../lib/clock.js'
import { systemClock } from '../../lib/clock.js'

/** 磁盘用量缓存时长（05 §7：每 10 分钟统计一次） */
export const DISK_CACHE_TTL_MS = 600_000
/**
 * 每统计多少个文件把事件循环让出去一次。
 * 512 个 `lstatSync` 在温缓存下约 3–5 ms，代理/接口不会被明显拖慢。
 */
export const DISK_WALK_YIELD_EVERY = 512
/** 同时进行的目录遍历上限（Hub 重启后可能一屏给很多用户触发补测） */
export const MAX_CONCURRENT_MEASURES = 2

/**
 * 递归统计目录占用（含 `node_modules`/`.pnpm-store`，不跟随符号链接）。
 *
 * 为什么用**同步** syscall + 手动让出事件循环，而不是 `await lstat()`：
 * Node 的异步 fs 走 libuv 线程池（默认 4 线程），一个 7.5 万文件的用户目录实测要
 * **8–12 秒**；同一批 syscall 换成同步实现只要 **0.55–0.6 秒**（2026-10-27 本机
 * WSL2/ext4 实测）。异步版本慢在每次调用的线程池往返，不是磁盘。为了不让统计卡住
 * 事件循环，每 `yieldEvery` 个文件 `await` 一次 `setImmediate`——单块只占几毫秒。
 *
 * 不跟随符号链接：统计不会跑出用户目录（02 §T11 的精神）。
 */
export async function measureDirBytes(root: string, opts: { yieldEvery?: number } = {}): Promise<number> {
  const yieldEvery = opts.yieldEvery ?? DISK_WALK_YIELD_EVERY
  let total = 0
  let ops = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      try {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          stack.push(path)
          continue
        }
        if (entry.isFile()) {
          total += lstatSync(path).size
          ops += 1
        } else {
          // d_type 未知（部分文件系统）时补一次 lstat，语义与旧实现一致
          const stat = lstatSync(path)
          if (stat.isSymbolicLink()) continue
          if (stat.isDirectory()) {
            stack.push(path)
            continue
          }
          if (stat.isFile()) {
            total += stat.size
            ops += 1
          }
        }
      } catch {
        // 统计期间被删/权限不足：跳过，不影响其它文件
      }
      if (ops > 0 && ops % yieldEvery === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return total
}

export interface DiskUsageCache {
  /** 缓存里的值（可能过期；没有则 null），**不发 IO** */
  peek(slug: string): number | null
  /**
   * 立刻返回缓存值（可能过期；没测过则 null），同时确保后台有一次统计在跑。
   * **永不阻塞**：给接口/页面用的口径——宁可这一屏少一个数字，也不要让请求等统计。
   */
  peekOrRefresh(slug: string, dir: string): number | null
  /**
   * 最多等 `budgetMs` 拿一个值：命中新鲜缓存立刻返回；否则触发统计并等一小会儿，
   * 超时返回旧值（可能 null），统计继续在后台完成。给「拒绝启动」这种需要硬结论的准入检查用。
   */
  getWithin(slug: string, dir: string, budgetMs: number): Promise<number | null>
  /** 等一次统计（测试与确实需要准确值的调用方） */
  get(slug: string, dir: string): Promise<number>
  /** 触发一次后台统计（去重：同一用户同时只会跑一个统计） */
  refresh(slug: string, dir: string): void
  invalidate(slug?: string): void
}

export function createDiskUsageCache(opts: { clock?: Clock; ttlMs?: number } = {}): DiskUsageCache {
  const clock = opts.clock ?? systemClock
  const ttlMs = opts.ttlMs ?? DISK_CACHE_TTL_MS
  const cache = new Map<string, { bytes: number; at: number }>()
  const inflight = new Map<string, Promise<number>>()
  /** 同时进行的目录遍历上限（见 `start` 的说明） */
  let activeMeasures = 0
  const measureWaiters: (() => void)[] = []

  async function withMeasureSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (activeMeasures >= MAX_CONCURRENT_MEASURES) {
      await new Promise<void>((resolve) => measureWaiters.push(resolve))
    } else {
      activeMeasures += 1
    }
    try {
      return await fn()
    } finally {
      const next = measureWaiters.shift()
      if (next) next()
      else activeMeasures -= 1
    }
  }

  function fresh(slug: string): number | null {
    const hit = cache.get(slug)
    if (!hit) return null
    const nowMs = clock.now().getTime()
    if (nowMs - hit.at < ttlMs) return hit.bytes
    return null
  }

  /**
   * 启动（或复用）一次统计；返回的 Promise 永不 reject（失败保留旧值）。
   *
   * 统计是同步 syscall + 分块让出事件循环，所以**并发上限**很重要：Hub 刚重启时
   * 一屏能给 12 个用户同时触发补测，12 条「每块几毫秒」的遍历交错在一起会把事件循环
   * 拖成一片一片的。这里最多同时跑 2 条，其余排队（不丢，只是稍后测）。
   */
  function start(slug: string, dir: string): Promise<number> {
    const running = inflight.get(slug)
    if (running) return running
    const task = withMeasureSlot(() => measureDirBytes(dir))
      .then((bytes) => {
        cache.set(slug, { bytes, at: clock.now().getTime() })
        return bytes
      })
      .catch(() => cache.get(slug)?.bytes ?? 0)
      .finally(() => inflight.delete(slug))
    inflight.set(slug, task)
    return task
  }

  return {
    peek(slug) {
      return cache.get(slug)?.bytes ?? null
    },
    peekOrRefresh(slug, dir) {
      if (fresh(slug) === null) void start(slug, dir)
      return cache.get(slug)?.bytes ?? null
    },
    async getWithin(slug, dir, budgetMs) {
      const hit = fresh(slug)
      if (hit !== null) return hit
      const task = start(slug, dir)
      if (budgetMs <= 0) return cache.get(slug)?.bytes ?? null
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs)
        timer.unref?.()
      })
      try {
        const bytes = await Promise.race([task, timeout])
        return bytes ?? cache.get(slug)?.bytes ?? null
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    async get(slug, dir) {
      return start(slug, dir)
    },
    refresh(slug, dir) {
      if (fresh(slug) === null) void start(slug, dir)
    },
    invalidate(slug) {
      if (slug === undefined) {
        cache.clear()
        inflight.clear()
        return
      }
      cache.delete(slug)
      inflight.delete(slug)
    },
  }
}
