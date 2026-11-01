import { describe, expect, it } from 'vitest'
import { createLockRegistry, runOutsideLocks } from '../src/lib/locks.js'

/**
 * 用户锁的**可重入**语义（WP3 补充）：任务引擎已经持锁时，执行器（installForUser / upgradeUser /
 * applyForUser）再取同一把锁不能自锁；不同异步上下文的兄弟调用仍然串行。
 */
describe('withUserLock 可重入', () => {
  it('同一异步上下文里嵌套取同一把锁不会死锁', async () => {
    const locks = createLockRegistry()
    const order: string[] = []
    await locks.withLock(
      'user:1',
      async () => {
        order.push('outer:start')
        await locks.withLock('user:1', () => {
          order.push('inner')
        })
        order.push('outer:end')
      },
      { timeoutMs: 50 },
    )
    expect(order).toEqual(['outer:start', 'inner', 'outer:end'])
  })

  it('嵌套里抛错不会把锁吞掉', async () => {
    const locks = createLockRegistry()
    await expect(
      locks.withLock('user:1', () =>
        locks.withLock('user:1', () => {
          throw new Error('inner boom')
        }),
      ),
    ).rejects.toThrow('inner boom')
    await expect(locks.withLock('user:1', () => 'ok')).resolves.toBe('ok')
  })

  it('不同异步上下文的调用照旧串行（重入不是绕过）', async () => {
    const locks = createLockRegistry()
    const events: string[] = []
    const first = locks.withLock('user:1', async () => {
      events.push('a:start')
      await new Promise((resolve) => setTimeout(resolve, 30))
      events.push('a:end')
    })
    const second = locks.withLock('user:1', () => {
      events.push('b')
    })
    await Promise.all([first, second])
    expect(events).toEqual(['a:start', 'a:end', 'b'])
  })

  it('持锁期间派生的后台任务继承令牌 → 会绕过锁；runOutsideLocks 洗掉令牌后才真正排队', async () => {
    const events: string[] = []
    // A：不洗令牌（错误示范）：后台任务与后续持锁者重叠
    {
      const locks = createLockRegistry()
      events.length = 0
      const background: Promise<void>[] = []
      await locks.withLock('user:1', () => {
        background.push(
          (async () => {
            await locks.withLock('user:1', async () => {
              events.push('bg:start')
              await new Promise((resolve) => setTimeout(resolve, 30))
              events.push('bg:end')
            })
          })(),
        )
      })
      await locks.withLock('user:1', () => {
        events.push('next')
      })
      await Promise.all(background)
      expect(events).toEqual(['bg:start', 'next', 'bg:end']) // 重叠：next 插在后台任务中间
    }
    // B：洗掉令牌（生产用法）：后台任务等锁，后续持锁者先完成
    {
      const locks = createLockRegistry()
      events.length = 0
      const background: Promise<void>[] = []
      await locks.withLock('user:1', () => {
        background.push(
          runOutsideLocks(async () => {
            await locks.withLock('user:1', async () => {
              events.push('bg:start')
              await new Promise((resolve) => setTimeout(resolve, 30))
              events.push('bg:end')
            })
          }),
        )
      })
      await locks.withLock('user:1', () => {
        events.push('next')
      })
      await Promise.all(background)
      // 后台任务先入队（它先调 withLock），但**不会**与 next 重叠
      expect(events).toEqual(['bg:start', 'bg:end', 'next'])
    }
  })

  it('不同 key 的重入互不影响', async () => {
    const locks = createLockRegistry()
    const result = await locks.withLock('user:1', async () => {
      return locks.withLock('user:2', () => 'two')
    })
    expect(result).toBe('two')
  })
})
