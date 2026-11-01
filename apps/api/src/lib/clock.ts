/**
 * 时间来源。业务代码不要直接 `new Date()`，而是从 `deps.clock` 取，
 * 这样测试能控制时间（例如会话过期、空闲回收）。
 */
export interface Clock {
  now(): Date
  nowIso(): string
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
}

export interface TestClock extends Clock {
  /** 往前推 ms 毫秒 */
  advance(ms: number): void
  /** 直接设定时间 */
  set(time: string | Date): void
}

/** 可控时钟（测试用）：默认从给定时间开始 */
export function createTestClock(start: string | Date = '2026-10-12T13:00:00.000Z'): TestClock {
  let current = typeof start === 'string' ? new Date(start) : new Date(start.getTime())
  return {
    now: () => new Date(current.getTime()),
    nowIso: () => current.toISOString(),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
    set: (time: string | Date) => {
      current = typeof time === 'string' ? new Date(time) : new Date(time.getTime())
    },
  }
}

/** 时间工具：`isoPlusMinutes` 等（会话过期、导出 TTL 用） */
export function isoPlusMs(base: string | Date, ms: number): string {
  const date = typeof base === 'string' ? new Date(base) : base
  return new Date(date.getTime() + ms).toISOString()
}

export function isoPlusMinutes(base: string | Date, minutes: number): string {
  return isoPlusMs(base, minutes * 60_000)
}

export function isoPlusHours(base: string | Date, hours: number): string {
  return isoPlusMs(base, hours * 3_600_000)
}

export function isoPlusDays(base: string | Date, days: number): string {
  return isoPlusMs(base, days * 86_400_000)
}

/** ISO 时间字符串是否已过期（相对给定时刻） */
export function isExpired(at: string | null | undefined, now: string | Date): boolean {
  if (!at) return false
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime()
  const atMs = Date.parse(at)
  if (Number.isNaN(atMs)) return true
  return atMs <= nowMs
}
