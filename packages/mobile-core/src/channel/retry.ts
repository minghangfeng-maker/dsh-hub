/**
 * 瞬态错误的重试策略（真机 2026-10-26 15:48 / 17:02 两次「切后台回来会话是空的」）。
 *
 * Hub→Host 的 mux 断开时会给**每个流**回 `upstream-unavailable`；mux 的设计是
 * 「断开时给所有流报错，下一次 open 再重连」，所以客户端再发一次就能自己恢复。
 *
 * 两种恢复粒度：
 *   - `TransientRetry`：按 key（`history:<sid>` / `subscribe:<sid>`）静默重试**幂等读**，
 *     0.5s / 1s / 2s / 3s 四档，用尽才把错误交给 UI；
 *   - `ChannelRecovery`：没有 requestId 的通道级错误（容器刚唤醒、mux 还没建好），
 *     退避后重订阅一次，把 adapter 的 follow / `$events` 流重新带起来。
 *
 * 两者都只管计时器，不碰 state / IO（回调由调用方给）。
 */

import { errorMessage } from '../errors.js'

/** 可以静默重试的错误码（`adapter-unavailable` 是 mux 断开后 adapter 的统一映射）。 */
export const TRANSIENT_RETRY_CODES: ReadonlySet<string> = new Set([
  'adapter-unavailable',
  'upstream-unavailable',
  'network',
  'timeout',
])

/**
 * 瞬态错误的自动重试间隔（只用在 `history` / `subscribe` 这种幂等读上）。
 *
 * 4 次重试覆盖「容器刚唤醒 / Host 还在起 follow」的窗口（0.1+1+2+3 秒 ≈ 6.5s）。
 */
export const TRANSIENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 3_000] as const

export function isTransientCode(code: string): boolean {
  return TRANSIENT_RETRY_CODES.has(code)
}

/** 按 key 的静默重试（同一 key 的计时器只有一条）。 */
export class TransientRetry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly counts = new Map<string, number>()

  /**
   * 排一次重试；返回 true = 已排，调用方**不要**弹错误条。
   * 返回 false = 该 key 的重试次数用尽（计数已复位）。
   */
  schedule(key: string, run: () => void): boolean {
    const attempt = this.counts.get(key) ?? 0
    const delay = TRANSIENT_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) {
      this.counts.delete(key)
      return false
    }
    this.counts.set(key, attempt + 1)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      run()
    }, delay)
    timer.unref?.()
    this.timers.set(key, timer)
    return true
  }

  /** 只清计时器（计数保留，限制总重试次数）。 */
  clear(key: string): void {
    const timer = this.timers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(key)
  }

  /** 连计数一起清（成功的回包意味着这条流已经恢复）。 */
  reset(key: string): void {
    this.clear(key)
    this.counts.delete(key)
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.counts.clear()
  }
}

/**
 * 通道级瞬态错误的退避恢复。
 *
 * 每次重订阅都会让 adapter 重新 `open` 一次 mux（mux 的设计就是「断了下次 open 再连」），
 * 所以这条路径能把「实例正在启动 / mux 刚断」这类十几秒的窗口熬过去。
 */
export class ChannelRecovery {
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly maxAttempts = 6) {}

  /** 返回 true = 已排/正在排恢复，先别弹错误条。 */
  schedule(run: () => void): boolean {
    if (this.attempts >= this.maxAttempts) return false
    if (this.timer !== null) return true
    const attempt = this.attempts
    this.attempts += 1
    const delay = Math.min(4_000, 800 * (attempt + 1))
    const timer = setTimeout(() => {
      this.timer = null
      run()
    }, delay)
    timer.unref?.()
    this.timer = timer
    return true
  }

  clear(): void {
    this.attempts = 0
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

/**
 * 给用户看的错误文案：瞬态/技术码用中文兜底，不把 adapter 的
 * 「upstream-unavailable: Host 流连接关闭（1006 ）」原样丢到错误条上。
 */
export function displayErrorText(code: string, message: string | undefined): string {
  if (TRANSIENT_RETRY_CODES.has(code)) return errorMessage(code)
  return message || errorMessage(code)
}
