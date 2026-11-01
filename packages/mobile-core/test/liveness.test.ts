/**
 * 链路判活：半边开检测（真机「连接断开又重连 / 改模型超时」的根因修复）。
 *
 * 场景：手机切后台或换网，TCP 半边开 —— 浏览器拿不到 close，界面还显示已连接，
 * 但发出去的帧全进黑洞。靠 25s 心跳 + 「多久没收到任何下行帧」判死，主动断开重连；
 * 回前台时 `probeLink()` 用 3–6s 的短探活提前发现死链。
 */

import { describe, expect, it } from 'vitest'
import { boot, createHarness, sleep } from './helpers/fake-channel.js'

describe('链路判活', () => {
  it('probeLink 等不到任何下行 → 主动断开（4002）并重连', async () => {
    const h = createHarness()
    const channel = await boot(h)
    expect(h.controller.getState().link).toBe('connected')

    h.controller.probeLink(30)
    await sleep(90)

    expect(channel.state).toBe('closed')
    // 断开后状态机进入重连（重连会由 fake openChannel 建第二条通道）
    expect(h.channels.length).toBeGreaterThanOrEqual(2)
    h.controller.dispose()
  })

  it('probeLink 期间收到任何下行帧 → 不算死链', async () => {
    const h = createHarness()
    const channel = await boot(h)

    h.controller.probeLink(80)
    await sleep(10)
    channel.server({ v: 1, type: 'pong', t: Date.now() })
    await sleep(120)

    expect(channel.state).toBe('open')
    expect(h.channels.length).toBe(1)
    h.controller.dispose()
  })

  it('通道级瞬态错误（Host 流断开/实例启动中）静默恢复：不弹错误条，退避后重订阅并补首页', async () => {
    const h = createHarness()
    const channel = await boot(h)
    h.controller.openSession('s1')
    const firstHistory = channel.last('history').requestId
    // Hub 在唤容器时可能推一条没有 requestId 的 adapter-unavailable（真机 2026-10-26 17:02）
    channel.server({
      v: 1,
      type: 'error',
      code: 'adapter-unavailable',
      message: 'upstream-unavailable: Host 流连接关闭（1006 ）',
      retryable: true,
    })
    expect(h.controller.getState().error).toBeNull()
    const subscribeBefore = channel.count('subscribe')
    await sleep(900)
    expect(channel.count('subscribe')).toBe(subscribeBefore + 1)
    expect(channel.last('history').requestId).not.toBe(firstHistory)
    h.controller.dispose()
  })

  it('心跳判死：超过 linkDeadMs 没有任何下行 → 主动断开', async () => {
    const h = createHarness({ keepAlive: true, keepAliveMs: 20, linkDeadMs: 45 })
    const channel = await boot(h)

    await sleep(140)

    expect(channel.state).toBe('closed')
    expect(h.channels.length).toBeGreaterThanOrEqual(2)
    h.controller.dispose()
  })

  it('心跳判活：持续有下行帧时不会误判（pong 每 20ms 一次）', async () => {
    const h = createHarness({ keepAlive: true, keepAliveMs: 20, linkDeadMs: 120 })
    const channel = await boot(h)

    for (let i = 0; i < 8; i += 1) {
      await sleep(20)
      if (channel.state === 'open') channel.server({ v: 1, type: 'pong', t: Date.now() })
    }

    expect(channel.state).toBe('open')
    expect(h.channels.length).toBe(1)
    h.controller.dispose()
  })
})
