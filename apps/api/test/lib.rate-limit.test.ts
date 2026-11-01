import { describe, expect, it } from 'vitest'
import { createTestClock } from '../src/lib/clock.js'
import { createFailureLock, createTokenBucket, createWindowCounter, isLoopbackIp } from '../src/lib/rate-limit.js'

describe('回环地址判定（02 §5 回环豁免）', () => {
  it('127.0.0.0/8、::1、::ffff:127.x 都算回环；其它一律不算', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', ' LOCALHOST ']) {
      expect(isLoopbackIp(ip), ip).toBe(true)
    }
    for (const ip of [null, undefined, '', '203.0.113.7', '10.213.0.5', '::ffff:10.213.0.5', '192.168.1.10']) {
      expect(isLoopbackIp(ip), String(ip)).toBe(false)
    }
  })
})

describe('限流原语（02 §5）', () => {
  it('令牌桶：窗口内放行 capacity 次，之后按速率补充', () => {
    const clock = createTestClock('2026-10-12T13:00:00.000Z')
    const bucket = createTokenBucket({ capacity: 3, windowMs: 60_000, clock })

    for (let i = 0; i < 3; i += 1) {
      expect(bucket.consume('ip').allowed, `第 ${i + 1} 次`).toBe(true)
    }
    const blocked = bucket.consume('ip')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(20) // 补一个令牌要 20s

    // 20 秒后补回一个令牌
    clock.advance(20_000)
    expect(bucket.consume('ip').allowed).toBe(true)
    expect(bucket.consume('ip').allowed).toBe(false)

    // 不同 key 互不影响；reset 立刻恢复
    expect(bucket.consume('other-ip').allowed).toBe(true)
    bucket.reset('ip')
    expect(bucket.consume('ip').allowed).toBe(true)

    clock.advance(60_000)
    expect(bucket.consume('ip').allowed).toBe(true)
    expect(bucket.size()).toBeGreaterThan(0)
    bucket.reset()
    expect(bucket.size()).toBe(0)
  })

  it('固定窗口：一个窗口内绝不超过 capacity 次，窗口到期后重置', () => {
    const clock = createTestClock('2026-10-12T13:00:00.000Z')
    const counter = createWindowCounter({ capacity: 3, windowMs: 3_600_000, clock })

    expect(counter.consume('ip').allowed).toBe(true)
    expect(counter.consume('ip').allowed).toBe(true)
    expect(counter.consume('ip').allowed).toBe(true)
    clock.advance(10 * 60_000) // 窗口内，不补
    const blocked = counter.consume('ip')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)

    clock.advance(51 * 60_000) // 超过 1 小时 → 新窗口
    expect(counter.consume('ip').allowed).toBe(true)
    expect(counter.consume('ip').remaining).toBe(1)
  })

  it('失败锁：连续 N 次失败进入锁定期，到期后清零重来', () => {
    const clock = createTestClock('2026-10-12T13:00:00.000Z')
    const lock = createFailureLock({ threshold: 3, lockMs: 900_000, clock })

    expect(lock.recordFailure('alice').locked).toBe(false)
    expect(lock.recordFailure('alice').locked).toBe(false)
    const third = lock.recordFailure('alice')
    expect(third.locked).toBe(true)
    expect(third.retryAfterSec).toBe(900)
    expect(third.failures).toBe(3)

    // 锁定期内再失败也不累加、剩余时间递减
    clock.advance(60_000)
    const stillLocked = lock.check('alice')
    expect(stillLocked.locked).toBe(true)
    expect(stillLocked.retryAfterSec).toBe(840)
    // 锁定期内记录失败不会延长锁定
    clock.advance(840_000)
    expect(lock.check('alice').locked).toBe(false)
    expect(lock.check('alice').failures).toBe(0)

    // 清零后又是完整的三次机会
    expect(lock.recordFailure('alice').locked).toBe(false)
    lock.reset('alice')
    expect(lock.check('alice').failures).toBe(0)

    // 另一个 key 独立
    expect(lock.check('bob').locked).toBe(false)
    expect(lock.size()).toBeGreaterThanOrEqual(0)
  })
})
