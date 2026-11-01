import { describe, expect, it } from 'vitest'
import { createLockRegistry, userLocks, withUserLock } from '../src/lib/locks.js'
import { HubError } from '../src/lib/errors.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('withUserLock（05 §6 每用户一把异步锁）', () => {
  it('同一 key 串行执行', async () => {
    const locks = createLockRegistry()
    const events: string[] = []
    const first = locks.withLock('u1', async () => {
      events.push('a:start')
      await sleep(30)
      events.push('a:end')
    })
    const second = locks.withLock('u1', async () => {
      events.push('b:start')
      events.push('b:end')
    })
    await Promise.all([first, second])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('不同 key 互不阻塞', async () => {
    const locks = createLockRegistry()
    const order: string[] = []
    await Promise.all([
      locks.withLock('u1', async () => {
        await sleep(40)
        order.push('u1')
      }),
      locks.withLock('u2', async () => {
        order.push('u2')
      }),
    ])
    expect(order).toEqual(['u2', 'u1'])
  })

  it('超时抛 CONFLICT(409) 并带上 key', async () => {
    const locks = createLockRegistry()
    const hold = locks.withLock('u1', () => sleep(200))
    await expect(locks.withLock('u1', () => 'never', { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    })
    await hold
    // 超时者没有进入临界区，锁释放后仍可正常使用
    await expect(locks.withLock('u1', () => 'ok')).resolves.toBe('ok')
  })

  it('回调抛错不会死锁，错误原样抛出', async () => {
    const locks = createLockRegistry()
    await expect(
      locks.withLock('u1', () => {
        throw new HubError('VALIDATION_FAILED', '坏了')
      }),
    ).rejects.toThrow('坏了')
    await expect(locks.withLock('u1', () => 42)).resolves.toBe(42)
  })

  it('isLocked / size 反映状态', async () => {
    const locks = createLockRegistry()
    expect(locks.isLocked('u1')).toBe(false)
    const hold = locks.withLock('u1', () => sleep(20))
    expect(locks.isLocked('u1')).toBe(true)
    expect(locks.size()).toBe(1)
    await hold
    expect(locks.isLocked('u1')).toBe(false)
  })

  it('进程级 userLocks 可直接用', async () => {
    await expect(withUserLock(7, () => 'done')).resolves.toBe('done')
    expect(userLocks.size()).toBe(0)
  })
})
