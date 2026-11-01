import { describe, expect, it, vi } from 'vitest'
import { RelayAdmission, ReservationBook } from './admission.js'

describe('R2 设备代际（两个 socket 先 upgrade 再交错 hello）', () => {
  it('第二 socket 在 upgrade 阶段即被拒；旧实例不能夺回登记', () => {
    const admission = new RelayAdmission()
    const timedOut = vi.fn()
    expect(admission.begin('dv_1', 'g1', 10_000, timedOut)).toBe(true)
    // 第二个同设备 socket：upgrade 时就该被拒，而不是等 hello
    expect(admission.begin('dv_1', 'g2', 10_000, timedOut)).toBe(false)
    expect(admission.confirm('dv_1', 'g1')).toBe(true)
    expect(admission.isLive('dv_1', 'g1')).toBe(true)
    // 旧代际再 hello：不能覆盖
    expect(admission.confirm('dv_1', 'g2')).toBe(false)
    expect(admission.isLive('dv_1', 'g1')).toBe(true)
    // 旧代际关闭：不能删掉新登记的代际
    admission.release('dv_1', 'g2')
    expect(admission.isLive('dv_1', 'g1')).toBe(true)
  })

  it('hello 超时回收名额，后续连接可再进来', async () => {
    vi.useFakeTimers()
    try {
      const admission = new RelayAdmission()
      const timedOut = vi.fn()
      expect(admission.begin('dv_2', 'g1', 1_000, timedOut)).toBe(true)
      await vi.advanceTimersByTimeAsync(1_100)
      expect(timedOut).toHaveBeenCalledTimes(1)
      expect(admission.begin('dv_2', 'g2', 1_000, () => undefined)).toBe(true)
      expect(admission.confirm('dv_2', 'g2')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('R9 (user,node) 两级预留', () => {
  it('并行 probe 不会把同一节点顶过 2 条', () => {
    const book = new ReservationBook()
    expect(book.reserve(1, 'cloud:self', 4, 2)).toBe(true)
    expect(book.reserve(1, 'cloud:self', 4, 2)).toBe(true)
    // 第三条同节点并发：即使 user 总量没满也必须拒
    expect(book.reserve(1, 'cloud:self', 4, 2)).toBe(false)
    expect(book.counts(1, 'cloud:self')).toEqual({ user: 2, node: 2 })
    book.release(1, 'cloud:self')
    expect(book.reserve(1, 'cloud:self', 4, 2)).toBe(true)
  })

  it('不同节点共享 user 配额', () => {
    const book = new ReservationBook()
    expect(book.reserve(1, 'a', 2, 2)).toBe(true)
    expect(book.reserve(1, 'b', 2, 2)).toBe(true)
    expect(book.reserve(1, 'c', 2, 2)).toBe(false)
  })
})
