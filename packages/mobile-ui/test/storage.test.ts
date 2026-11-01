/**
 * 冷启动令牌恢复的重试窗口（0.2.14「冷启动还要点登录」修复的核心逻辑）。
 *
 * 真机根因：SecureStorage 插件冷启动最初几十/几百毫秒没就绪，`getItem` 抛错被
 * SecureTokenStore 吞成 null；旧实现只重试 3×250ms，插件慢一点就直接判定「没登录」，
 * 用户被丢回登录页。这里用假时钟覆盖：
 *  - 原生：报错一直重试到 ~4.5s 窗口；确实没有条目（absent）只给 ~600ms 宽限；
 *  - 读到了但被判过期（present）：不重试；
 *  - Web/内存令牌：一次就够，不白等。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  restoreTokensWithBackoff,
  secureStoreReadStatus,
  noteSecureStoreRead,
  resetSecureStoreReadStatus,
  type SecureStoreReadStatus,
} from '@/lib/storage'

function makeClock(): {
  sleeps: number[]
  now: () => number
  sleep: (ms: number) => Promise<void>
} {
  let time = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      time += ms
    },
  }
}

function makeEvents(): { names: string[]; onEvent: (name: string, detail: string) => void } {
  const names: string[] = []
  return {
    names,
    onEvent: (name: string, detail: string) => names.push(`${name}=${detail}`),
  }
}

describe('restoreTokensWithBackoff（冷启动读令牌重试）', () => {
  beforeEach(() => resetSecureStoreReadStatus())

  it('读到令牌立刻返回，不等待', async () => {
    const clock = makeClock()
    let calls = 0
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        calls += 1
        noteSecureStoreRead('present')
        return 'tokens'
      },
      status: secureStoreReadStatus,
      secureStorage: true,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result).toBe('tokens')
    expect(calls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('Web/内存令牌（没有原生安全存储）：只读一次，不等待', async () => {
    const clock = makeClock()
    const events = makeEvents()
    let calls = 0
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        calls += 1
        return null
      },
      status: secureStoreReadStatus,
      secureStorage: false,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: events.onEvent,
    })
    expect(result).toBeNull()
    expect(calls).toBe(1)
    expect(clock.sleeps).toEqual([])
    expect(events.names).toEqual(['auth:secure-store=unavailable'])
  })

  it('插件没就绪（读取报错）→ 指数退避，插件起来后读到令牌', async () => {
    const clock = makeClock()
    const statuses: SecureStoreReadStatus[] = ['error', 'error', 'error', 'present']
    let calls = 0
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        const status = statuses[calls] ?? 'error'
        calls += 1
        noteSecureStoreRead(status)
        return status === 'present' ? 'tokens' : null
      },
      status: secureStoreReadStatus,
      secureStorage: true,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result).toBe('tokens')
    expect(calls).toBe(4)
    // 50 → 100 → 200 指数退避
    expect(clock.sleeps).toEqual([50, 100, 200])
  })

  it('插件一直报错 → 到 ~4.5s 窗口才放弃，并留 auth:secure-store=error 诊断', async () => {
    const clock = makeClock()
    const events = makeEvents()
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        noteSecureStoreRead('error')
        return null
      },
      status: secureStoreReadStatus,
      secureStorage: true,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: events.onEvent,
    })
    expect(result).toBeNull()
    const total = clock.sleeps.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBe(4500)
    expect(clock.sleeps[0]).toBe(50)
    expect(events.names).toEqual(['auth:secure-store=error'])
  })

  it('读成功但确实没有令牌（absent）→ 只给 ~1.2s 宽限就放弃（首次安装不白等）', async () => {
    const clock = makeClock()
    const events = makeEvents()
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        noteSecureStoreRead('absent')
        return null
      },
      status: secureStoreReadStatus,
      secureStorage: true,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: events.onEvent,
    })
    expect(result).toBeNull()
    const total = clock.sleeps.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBe(1200)
    // 比 4.5s 的原生窗口短得多
    expect(total).toBeLessThan(2000)
    expect(events.names).toEqual(['auth:secure-store=absent'])
  })

  it('absent 宽限期内插件又读到条目：照样恢复，不误判「没登录」', async () => {
    const clock = makeClock()
    let calls = 0
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        calls += 1
        if (calls === 1) {
          noteSecureStoreRead('absent')
          return null
        }
        noteSecureStoreRead('present')
        return 'tokens'
      },
      status: secureStoreReadStatus,
      secureStorage: true,
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(result).toBe('tokens')
    expect(calls).toBe(2)
    expect(clock.sleeps).toEqual([50])
  })

  it('读到了条目但被判过期/损坏（present）→ 不重试，交给上层自动登录回退', async () => {
    const clock = makeClock()
    const events = makeEvents()
    let calls = 0
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        calls += 1
        noteSecureStoreRead('present')
        return null
      },
      status: secureStoreReadStatus,
      secureStorage: true,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: events.onEvent,
    })
    expect(result).toBeNull()
    expect(calls).toBe(1)
    expect(clock.sleeps).toEqual([])
    expect(events.names).toEqual(['auth:secure-store=expired'])
  })

  it('每次等待都不超过剩余窗口（不会拖过总时长）', async () => {
    const clock = makeClock()
    const result = await restoreTokensWithBackoff<string>({
      restore: async () => {
        noteSecureStoreRead('error')
        return null
      },
      status: secureStoreReadStatus,
      secureStorage: true,
      now: clock.now,
      sleep: clock.sleep,
      windowMs: 500,
      initialDelayMs: 50,
      maxDelayMs: 200,
    })
    expect(result).toBeNull()
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(500)
    // 最后一次等待被截断到剩余窗口
    expect(clock.sleeps.at(-1)).toBe(150)
  })
})

describe('安全存储读取状态探针', () => {
  it('默认 unknown；可记录 / 复位', () => {
    resetSecureStoreReadStatus()
    expect(secureStoreReadStatus()).toBe('unknown')
    noteSecureStoreRead('absent')
    expect(secureStoreReadStatus()).toBe('absent')
    noteSecureStoreRead('present')
    expect(secureStoreReadStatus()).toBe('present')
    noteSecureStoreRead('error')
    expect(secureStoreReadStatus()).toBe('error')
    resetSecureStoreReadStatus()
    expect(secureStoreReadStatus()).toBe('unknown')
  })
})
