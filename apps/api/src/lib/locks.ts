import { AsyncLocalStorage } from 'node:async_hooks'
import { HubError } from './errors.js'

export interface LockOptions {
  /** 等待锁的最长时间，超时抛 CONFLICT（默认 30s，0 = 无限等待） */
  timeoutMs?: number
}

export interface LockRegistry {
  withLock<T>(key: string, fn: () => Promise<T> | T, opts?: LockOptions): Promise<T>
  isLocked(key: string): boolean
  /** 当前有排队/持锁的 key 数量（测试与诊断用） */
  size(): number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 当前异步上下文已经持有的锁 key（**重入**用）。
 *
 * 为什么需要：任务引擎（06 §5.2）执行 task 时会先取用户锁，而执行器（06 §2.4 的
 * `installForUser`、06 §3 的 `upgradeUser`、06 §4 的 `applyForUser`）按设计也要取同一把锁，
 * 并且要调实例服务的 `recreate/restart`（它们同样取锁）。非重入的锁会「自己等自己」直到超时
 * （WP3 实测 150s 后 CONFLICT）。用 AsyncLocalStorage 记住本异步上下文已持有哪些 key，重入时
 * 直接执行；语义仍是「同一用户串行」，并发的兄弟调用（不同异步上下文）照旧排队。
 */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * 按 key 的异步互斥（05 §6「每个用户一把异步锁」）。
 * 用 Promise 链而不是队列：后来者等待前一个 tail 完成，超时者不会进入临界区。
 * 同一异步上下文内的嵌套调用可重入（见 `heldLocks`）。
 */
export function createLockRegistry(defaults: LockOptions = {}): LockRegistry {
  const tails = new Map<string, Promise<void>>()

  return {
    async withLock<T>(key: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
      const inherited = heldLocks.getStore()
      if (inherited?.has(key)) return await fn()
      const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const previous = tails.get(key) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const mine = previous.then(() => gate)
      tails.set(key, mine)
      try {
        await waitWithTimeout(previous, timeoutMs, key)
      } catch (error) {
        release()
        if (tails.get(key) === mine) tails.delete(key)
        throw error
      }
      try {
        const next = new Set(inherited ?? [])
        next.add(key)
        return await heldLocks.run(next, () => fn())
      } finally {
        release()
        if (tails.get(key) === mine) tails.delete(key)
      }
    },

    isLocked(key: string): boolean {
      return tails.has(key)
    },

    size(): number {
      return tails.size
    },
  }
}

function waitWithTimeout(previous: Promise<void>, timeoutMs: number, key: string): Promise<void> {
  if (timeoutMs <= 0) return previous
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HubError('CONFLICT', '该用户的操作正在进行中，请稍后重试', { key, timeoutMs }))
    }, timeoutMs)
    timer.unref?.()
    previous.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 在**不继承**当前持锁令牌的上下文里跑后台任务（fire-and-forget）。
 * 场景：实例服务在持锁期间同步 emit `instance.status`，监听器里派生出来的后台对账任务会继承
 * 「已持有 user:<id>」的令牌，于是它的 `withUserLock` 变成空操作 —— 会和后续真正持锁的任务并发改
 * 同一个 profile。派生后台任务时必须经过本函数洗掉令牌（或显式 await 完成）。
 */
export function runOutsideLocks<T>(fn: () => Promise<T>): Promise<T> {
  return heldLocks.run(new Set<string>(), fn)
}

/** 进程级默认锁表：实例操作、插件安装、导出读 profile 都用它（05 §6 / 06 §6） */
export const userLocks: LockRegistry = createLockRegistry()

/** `withUserLock(userId, fn)`：按用户串行化跨模块的写操作 */
export function withUserLock<T>(
  userId: number | string,
  fn: () => Promise<T> | T,
  opts?: LockOptions,
): Promise<T> {
  return userLocks.withLock(`user:${userId}`, fn, opts)
}
