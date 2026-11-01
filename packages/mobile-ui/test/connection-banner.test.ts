/**
 * 连接横幅的纯函数（0.4.1 §1/§3）。
 *
 * 用户反馈：锁屏解锁回 App，最上方先闪一下「正在连接你的助手…」，1–2 秒后又消失。
 * 这里把「什么时候才该显示」的每个分支都钉住：
 *   宽限期内一律不显示（connecting / reconnecting / 回前台重连 / 唤醒中）→
 *   4–15 秒中性提示（不再有「第 N 次」）→ ≥15 秒 / link failed / 明确原因才警示 + 重试；
 *   连上立即隐藏；切后台不计时（notConnectedSince 为 null）。
 *
 * 队列消息的「与服务器连接中…」也在这里：计时起点是**消息自己**的入队时间。
 */

import { describe, expect, it } from 'vitest'
import {
  CAPACITY_FULL_TEXT,
  CONNECTION_GRACE_MS,
  CONNECTION_WARN_MS,
  CONNECTING_TEXT,
  NOT_CONNECTABLE_TEXT,
  OFFLINE_TEXT,
  QUEUED_CONNECTING_TEXT,
  QUEUED_TIMEOUT_TEXT,
  WAKE_BLOCKED_TEXT,
  WAKING_TEXT,
  connectionBanner,
  queuedLinkState,
  queuedLinkText,
  type ConnectionBannerInput,
} from '../src/lib/connection-banner'

const T0 = 1_730_000_000_000

/** 默认输入：刚断开、正在重连（真正跑起来的用例只覆盖自己关心的字段）。 */
function input(overrides: Partial<ConnectionBannerInput> = {}): ConnectionBannerInput {
  return {
    link: 'reconnecting',
    wakeState: 'ready',
    instanceStatus: 'running',
    connectable: true,
    capacityFull: false,
    reason: null,
    notConnectedSince: T0,
    now: T0,
    ...overrides,
  }
}

const bannerAfter = (ms: number, overrides: Partial<ConnectionBannerInput> = {}) =>
  connectionBanner(input({ now: T0 + ms, ...overrides }))

describe('连接横幅：宽限期内一律不显示', () => {
  it('常量：宽限 4 秒、警示 15 秒', () => {
    expect(CONNECTION_GRACE_MS).toBe(4_000)
    expect(CONNECTION_WARN_MS).toBe(15_000)
  })

  it('刚断开（connecting / reconnecting / closed / idle）都安静', () => {
    for (const link of ['connecting', 'reconnecting', 'closed', 'idle'] as const) {
      for (const ms of [0, 500, 1_500, 3_999]) {
        const banner = connectionBanner(input({ link, now: T0 + ms }))
        expect(banner.show, `${link} +${ms}ms`).toBe(false)
        expect(banner.text).toBe('')
      }
    }
  })

  it('回前台重连：计时从回前台那一刻开始，3 秒内不显示', () => {
    // 切后台时 store 把 notConnectedSince 清空；回前台重新记 now。
    const banner = connectionBanner(input({ link: 'closed', notConnectedSince: T0 + 60_000, now: T0 + 63_000 }))
    expect(banner.show).toBe(false)
  })

  it('唤醒中 4 秒内同样不显示（云容器冷启动 1–11 秒的窗口）', () => {
    for (const ms of [0, 1_200, 3_999]) {
      const banner = connectionBanner(
        input({ link: 'idle', wakeState: 'waking', instanceStatus: 'starting', now: T0 + ms }),
      )
      expect(banner.show, `waking +${ms}ms`).toBe(false)
    }
  })

  it('根本没有计时（切后台期间 / 还没登录）时一律不显示', () => {
    for (const ms of [0, 60_000]) {
      const banner = connectionBanner(input({ notConnectedSince: null, now: T0 + ms }))
      expect(banner.show).toBe(false)
    }
  })
})

describe('连接横幅：4–15 秒的中性提示', () => {
  it('连不上 4 秒后显示「正在连接服务器…」（info，无按钮）', () => {
    for (const ms of [4_000, 6_000, 14_999]) {
      const banner = bannerAfter(ms)
      expect(banner.show, `+${ms}ms`).toBe(true)
      expect(banner.text).toBe(CONNECTING_TEXT)
      expect(banner.tone).toBe('info')
      expect(banner.action).toBeUndefined()
    }
  })

  it('唤醒中 4 秒后显示「正在唤醒你的助手…」', () => {
    const banner = bannerAfter(5_000, { link: 'idle', wakeState: 'waking', instanceStatus: 'starting' })
    expect(banner.show).toBe(true)
    expect(banner.text).toBe(WAKING_TEXT)
    expect(banner.tone).toBe('info')
  })

  it('不再显示「第 N 次」重连次数（也不带 reconnectAttempt 字样）', () => {
    const banner = bannerAfter(8_000)
    expect(banner.text).not.toMatch(/第|次|重连/)
  })

  it('有排队消息时顶部也不重复「就绪后自动发送」', () => {
    const banner = bannerAfter(6_000, { queued: 2 })
    expect(banner.text).toBe(CONNECTING_TEXT)
    expect(banner.text).not.toContain('自动发送')
  })
})

describe('连接横幅：≥15 秒 / link failed 才警示', () => {
  it('15 秒后警示「暂时连不上服务器」+ 重试', () => {
    for (const ms of [15_000, 18_000, 120_000]) {
      const banner = bannerAfter(ms)
      expect(banner.show, `+${ms}ms`).toBe(true)
      expect(banner.text).toBe(OFFLINE_TEXT)
      expect(banner.tone).toBe('warn')
      expect(banner.action).toBe('重试')
    }
  })

  it('唤醒中超时同样升级成警示', () => {
    const banner = bannerAfter(16_000, { link: 'idle', wakeState: 'waking', instanceStatus: 'starting' })
    expect(banner.text).toBe(OFFLINE_TEXT)
    expect(banner.action).toBe('重试')
  })

  it('link failed 不等宽限，立刻警示 + 重连', () => {
    const banner = connectionBanner(input({ link: 'failed', now: T0 }))
    expect(banner.show).toBe(true)
    expect(banner.text).toBe(OFFLINE_TEXT)
    expect(banner.tone).toBe('warn')
    expect(banner.action).toBe('重连')
  })

  it('自定义阈值（测试注入）生效', () => {
    const slow = connectionBanner(input({ now: T0 + 2_000, graceMs: 1_000, warnMs: 9_000 }))
    expect(slow.text).toBe(CONNECTING_TEXT)
    const warn = connectionBanner(input({ now: T0 + 9_000, graceMs: 1_000, warnMs: 9_000 }))
    expect(warn.text).toBe(OFFLINE_TEXT)
  })
})

describe('连接横幅：明确原因立即显示（不等宽限）', () => {
  it('唤醒被拦 + 可重试：立即显示原因 + 重试，琥珀色', () => {
    const banner = connectionBanner(
      input({
        link: 'idle',
        wakeState: 'blocked',
        connectable: false,
        reason: { text: '当前使用人数较多，请稍后再试', retryable: true },
      }),
    )
    expect(banner.show).toBe(true)
    expect(banner.text).toBe('当前使用人数较多，请稍后再试')
    expect(banner.tone).toBe('warn')
    expect(banner.action).toBe('重试')
  })

  it('唤醒被拦 + 不可重试：危险色、不给按钮', () => {
    const banner = connectionBanner(
      input({
        link: 'idle',
        wakeState: 'blocked',
        reason: { text: '积分不足，请充值后再试', retryable: false },
      }),
    )
    expect(banner.tone).toBe('error')
    expect(banner.action).toBeUndefined()
    expect(banner.text).toBe('积分不足，请充值后再试')
  })

  it('唤醒被拦但没有原因：用兜底文案', () => {
    const banner = connectionBanner(input({ link: 'idle', wakeState: 'blocked' }))
    expect(banner.text).toBe(WAKE_BLOCKED_TEXT)
    expect(banner.action).toBeUndefined()
  })

  it('容量满：立即显示现有文案（可重试时给按钮）', () => {
    const banner = connectionBanner(
      input({
        link: 'reconnecting',
        capacityFull: true,
        reason: { text: CAPACITY_FULL_TEXT, retryable: true },
      }),
    )
    expect(banner.show).toBe(true)
    expect(banner.text).toBe(CAPACITY_FULL_TEXT)
    expect(banner.action).toBe('重试')
  })

  it('后端明确不可连接：立即显示「当前后端不可连接」，没有按钮', () => {
    const banner = connectionBanner(input({ link: 'idle', connectable: false }))
    expect(banner.show).toBe(true)
    expect(banner.text).toBe(NOT_CONNECTABLE_TEXT)
    expect(banner.action).toBeUndefined()
  })

  it('还没有选中后端（connectable 为 null）走宽限，不提前报「不可连接」', () => {
    expect(connectionBanner(input({ link: 'idle', connectable: null, now: T0 + 1_000 })).show).toBe(false)
    expect(connectionBanner(input({ link: 'idle', connectable: null, now: T0 + 5_000 })).text).toBe(
      CONNECTING_TEXT,
    )
  })
})

describe('连接横幅：连上立刻隐藏', () => {
  it('link connected 时不显示（即使计时起点还在）', () => {
    const banner = connectionBanner(input({ link: 'connected', notConnectedSince: T0, now: T0 + 60_000 }))
    expect(banner.show).toBe(false)
    expect(banner.text).toBe('')
  })

  it('容量满/不可连接的旧状态在连上后不再显示', () => {
    const banner = connectionBanner(
      input({ link: 'connected', connectable: false, capacityFull: true, now: T0 + 60_000 }),
    )
    expect(banner.show).toBe(false)
  })
})

describe('队列消息的连接状态（气泡下方）', () => {
  it('连上了 / 不在队列里 → 不显示（交给「发送中…」）', () => {
    expect(queuedLinkState({ queued: true, connected: true, queuedAt: T0, now: T0 + 60_000 })).toBeNull()
    expect(queuedLinkState({ queued: false, connected: false, queuedAt: T0, now: T0 })).toBeNull()
  })

  it('没连上：先「与服务器连接中…」，这条自己排队 ≥15 秒才升级', () => {
    for (const ms of [0, 5_000, 14_999]) {
      expect(queuedLinkState({ queued: true, connected: false, queuedAt: T0, now: T0 + ms }), `+${ms}ms`).toBe(
        'connecting',
      )
    }
    for (const ms of [15_000, 17_000]) {
      expect(queuedLinkState({ queued: true, connected: false, queuedAt: T0, now: T0 + ms }), `+${ms}ms`).toBe(
        'timeout',
      )
    }
  })

  it('计时起点是消息自己的入队时间：断线很久后才发的消息不会一出现就报「连不上」', () => {
    // 链路 60 秒前就断了，但这条消息是刚入队的
    const state = queuedLinkState({ queued: true, connected: false, queuedAt: T0 + 60_000, now: T0 + 61_000 })
    expect(state).toBe('connecting')
  })

  it('三种文案：连接中 / 暂时连不上（连上后自动发送）/ 不显示', () => {
    expect(queuedLinkText('connecting')).toBe('与服务器连接中…')
    expect(queuedLinkText('timeout')).toBe('暂时连不上服务器，连上后自动发送')
    expect(queuedLinkText(null)).toBe('')
    expect(QUEUED_CONNECTING_TEXT).toBe('与服务器连接中…')
    expect(QUEUED_TIMEOUT_TEXT).toBe('暂时连不上服务器，连上后自动发送')
  })
})
