import type { Clock } from './clock.js'

/**
 * 账号域限流（02 §5）。全部放内存：重启清空是可接受的（任务书明确）。
 *
 * 两种原语：
 * - `createTokenBucket`：令牌桶，适合「每个 IP / 每个用户名 在窗口内最多 N 次」；
 * - `createFailureLock`：连续失败计数 + 锁定期，适合「同用户名 5 次失败锁 15 分钟」。
 *
 * 时间一律从 `deps.clock` 取，测试用可控时钟推进即可验证解锁。
 */

/** 内存表的容量上限：超过就淘汰老键，避免被随机 key 撑爆（攻击者视角的内存放大） */
const MAX_ENTRIES = 10_000

export interface RateLimitDecision {
  allowed: boolean
  /** 被拒时还需要等多少秒（向上取整，至少 1）；放行时为 0 */
  retryAfterSec: number
  /** 本次消费后桶里的剩余可用次数（向下取整，仅用于日志/调试） */
  remaining: number
}

/** 所有限流原语的公共形状（按 IP 的限流豁免逻辑只依赖它） */
export interface RateLimiter {
  /** 消费一次；返回是否放行与重试等待秒数 */
  consume(key: string, cost?: number): RateLimitDecision
}

/**
 * 回环地址判定（02 §5：**回环地址豁免按 IP 的限流**）。
 *
 * 阶段一 Hub 只监听 127.0.0.1，所有请求（开发、验收、CLI 冒烟）都来自本机；
 * 若照 02 §5 的按 IP 数字限流，第 4 个测试账号就会被注册限流挡住。
 * 整个 `127.0.0.0/8` 都是回环段（不可路由，不可能是外部来源），所以按前缀判定；
 * 另外覆盖 IPv6 的 `::1` 与 IPv4 映射形式 `::ffff:127.x.x.x`。
 *
 * **只豁免按 IP 的限流**：按用户名/用户 id 的失败锁定（登录 5 次锁 15 分钟）照旧生效。
 */
export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false
  const value = ip.trim().toLowerCase()
  if (value === '::1' || value === 'localhost') return true
  if (value.startsWith('127.')) return true
  if (value.startsWith('::ffff:127.')) return true
  return false
}

export interface TokenBucket extends RateLimiter {
  /** 清零某个键（成功登录后清理失败计数等）或全部 */
  reset(key?: string): void
  /** 当前跟踪的键数量（测试/诊断） */
  size(): number
}

/**
 * 固定窗口计数：`capacity` 次 / `windowMs`，窗口从**第一次**消费开始算。
 * 与令牌桶的区别：这里保证「一个窗口内绝不超过 N 次」（注册 3 次/小时、10 次/天要的是这个语义），
 * 代价是窗口边界可能出现两次突刺。
 */
export interface WindowCounter extends RateLimiter {
  reset(key?: string): void
  size(): number
}

export function createWindowCounter(opts: TokenBucketOptions): WindowCounter {
  const { capacity, windowMs, clock } = opts
  const entries = new Map<string, { count: number; windowStart: number }>()

  function prune(nowMs: number): void {
    if (entries.size < MAX_ENTRIES) return
    for (const [key, entry] of entries) {
      if (nowMs - entry.windowStart >= windowMs) entries.delete(key)
    }
    if (entries.size < MAX_ENTRIES) return
    const sorted = [...entries.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart)
    for (let i = 0; i < Math.ceil(sorted.length / 2); i += 1) entries.delete(sorted[i]![0])
  }

  return {
    consume(key, cost = 1) {
      const nowMs = clock.now().getTime()
      prune(nowMs)
      const entry = entries.get(key)
      if (!entry || nowMs - entry.windowStart >= windowMs) {
        entries.set(key, { count: cost, windowStart: nowMs })
        return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, capacity - cost) }
      }
      if (entry.count + cost <= capacity) {
        entry.count += cost
        return { allowed: true, retryAfterSec: 0, remaining: capacity - entry.count }
      }
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((entry.windowStart + windowMs - nowMs) / 1000)),
        remaining: Math.max(0, capacity - entry.count),
      }
    },
    reset(key) {
      if (key === undefined) entries.clear()
      else entries.delete(key)
    },
    size() {
      return entries.size
    },
  }
}

export interface TokenBucketOptions {
  /** 窗口内允许的次数 */
  capacity: number
  /** 窗口长度（毫秒） */
  windowMs: number
  clock: Clock
}

interface BucketEntry {
  tokens: number
  /** 上次补充令牌的时间（毫秒） */
  at: number
}

export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
  const { capacity, windowMs, clock } = opts
  const ratePerMs = capacity / windowMs
  const entries = new Map<string, BucketEntry>()

  function prune(nowMs: number): void {
    if (entries.size < MAX_ENTRIES) return
    for (const [key, entry] of entries) {
      if (nowMs - entry.at > windowMs) entries.delete(key)
    }
    if (entries.size < MAX_ENTRIES) return
    // 还是满的：丢掉最旧的一半（限流器本身不能成为内存泄漏点）
    const sorted = [...entries.entries()].sort((a, b) => a[1].at - b[1].at)
    for (let i = 0; i < Math.ceil(sorted.length / 2); i += 1) entries.delete(sorted[i]![0])
  }

  return {
    consume(key, cost = 1) {
      const nowMs = clock.now().getTime()
      prune(nowMs)
      const entry = entries.get(key)
      if (!entry && entries.size >= MAX_ENTRIES) {
        // 淘汰后仍然满：宁可拒绝也不无限增长
        return { allowed: false, retryAfterSec: Math.ceil(windowMs / 1000), remaining: 0 }
      }
      const tokens = entry ? Math.min(capacity, entry.tokens + (nowMs - entry.at) * ratePerMs) : capacity
      if (tokens >= cost) {
        entries.set(key, { tokens: tokens - cost, at: nowMs })
        return { allowed: true, retryAfterSec: 0, remaining: Math.floor(tokens - cost) }
      }
      entries.set(key, { tokens, at: nowMs })
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((cost - tokens) / ratePerMs / 1000)),
        remaining: 0,
      }
    },
    reset(key) {
      if (key === undefined) entries.clear()
      else entries.delete(key)
    },
    size() {
      return entries.size
    },
  }
}

export interface LockState {
  locked: boolean
  /** 锁定剩余秒数（未锁定为 0） */
  retryAfterSec: number
  /** 当前连续失败次数（锁定期内为触发阈值） */
  failures: number
}

export interface FailureLock {
  /** 记一次失败；达到阈值即进入锁定期并返回 locked=true */
  recordFailure(key: string): LockState
  /** 查询是否被锁（锁定期满会惰性清零，用户又有完整 N 次机会） */
  check(key: string): LockState
  /** 成功后清零 */
  reset(key: string): void
  size(): number
}

export interface FailureLockOptions {
  /** 连续失败多少次后锁定 */
  threshold: number
  /** 锁定时长（毫秒） */
  lockMs: number
  clock: Clock
}

interface LockEntry {
  failures: number
  /** 锁定到期时间（毫秒）；0 表示未锁定 */
  lockedUntilMs: number
  /** 最后一次失败时间（淘汰用） */
  at: number
}

export function createFailureLock(opts: FailureLockOptions): FailureLock {
  const { threshold, lockMs, clock } = opts
  const entries = new Map<string, LockEntry>()

  function prune(nowMs: number): void {
    if (entries.size < MAX_ENTRIES) return
    for (const [key, entry] of entries) {
      if (entry.lockedUntilMs <= nowMs && nowMs - entry.at > lockMs) entries.delete(key)
    }
    if (entries.size < MAX_ENTRIES) return
    const sorted = [...entries.entries()].sort((a, b) => a[1].at - b[1].at)
    for (let i = 0; i < Math.ceil(sorted.length / 2); i += 1) entries.delete(sorted[i]![0])
  }

  function stateOf(key: string, nowMs: number): LockState {
    const entry = entries.get(key)
    if (!entry) return { locked: false, retryAfterSec: 0, failures: 0 }
    if (entry.lockedUntilMs > nowMs) {
      return {
        locked: true,
        retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntilMs - nowMs) / 1000)),
        failures: entry.failures,
      }
    }
    if (entry.lockedUntilMs !== 0) {
      // 锁定期已过：清零，重新给满额机会
      entries.delete(key)
      return { locked: false, retryAfterSec: 0, failures: 0 }
    }
    return { locked: false, retryAfterSec: 0, failures: entry.failures }
  }

  return {
    recordFailure(key) {
      const nowMs = clock.now().getTime()
      prune(nowMs)
      const current = stateOf(key, nowMs)
      if (current.locked) return current
      const failures = current.failures + 1
      const lockedUntilMs = failures >= threshold ? nowMs + lockMs : 0
      entries.set(key, { failures, lockedUntilMs, at: nowMs })
      if (lockedUntilMs > 0) {
        return { locked: true, retryAfterSec: Math.ceil(lockMs / 1000), failures }
      }
      return { locked: false, retryAfterSec: 0, failures }
    },
    check(key) {
      return stateOf(key, clock.now().getTime())
    },
    reset(key) {
      entries.delete(key)
    },
    size() {
      return entries.size
    },
  }
}
