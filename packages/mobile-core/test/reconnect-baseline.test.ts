/**
 * 断线重连的 assistant-baseline（0.2.9）：
 * 真机 2026-10-26 17:05 长回合中途手机通道断开重连，客户端只收到重连之后的思考增量，
 * UI 上「思考过程 26134 字」而服务端这一步实际 76089 字（残缺）。
 * Hub 现在把进行中 attempt 的 reasoning 尾部也放进 baseline；老 Hub 不发时行为不变。
 */

import { describe, expect, it } from 'vitest'
import {
  bootWithSessions,
  createHarness,
  deltaFrame,
  historyFrame,
} from './helpers/fake-channel.js'

async function openSession(): Promise<ReturnType<typeof createHarness>> {
  const h = createHarness()
  const channel = await bootWithSessions(h)
  h.controller.openSession('s1')
  channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 5 }))
  return h
}

function baseline(reasoning?: string): unknown {
  return {
    v: 1,
    type: 'assistant-baseline',
    sessionId: 's1',
    attemptId: 'att_1',
    revision: 1,
    nextIndex: 3,
    text: '',
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

describe('断线重连：思考内容接上', () => {
  it('baseline 带 reasoning：替换成 Hub 带回的已产出思考，后续 delta 继续追加', async () => {
    const h = await openSession()
    const channel = h.channels[0]!
    channel.server(deltaFrame('s1', 'att_1', 0, '前半段', 'reasoning'))
    expect(h.controller.getState().streamingReasoning).toBe('前半段')

    channel.server(baseline('前半段（Hub 恢复）'))
    expect(h.controller.getState().streamingReasoning).toBe('前半段（Hub 恢复）')

    channel.server(deltaFrame('s1', 'att_1', 3, '后半段', 'reasoning'))
    expect(h.controller.getState().streamingReasoning).toBe('前半段（Hub 恢复）后半段')
    h.controller.dispose()
  })

  it('老 Hub 的 baseline 不带 reasoning：同一 attempt 保留现有思考（不清空）', async () => {
    const h = await openSession()
    const channel = h.channels[0]!
    channel.server(deltaFrame('s1', 'att_1', 0, '已有的思考', 'reasoning'))
    channel.server(baseline())
    expect(h.controller.getState().streamingReasoning).toBe('已有的思考')
    h.controller.dispose()
  })
})
