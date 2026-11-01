/**
 * 会话用量（v2 `usage` 帧）：客户端按需请求 → adapter 只读聚合 → 面板展示。
 *
 * 真机反馈（2026-10-26）要求「对话右上角点开 → 显示该对话的 usage」；协议层在这里锁住：
 * - 请求走 `features.includes('usage')`，没协商就不发（老 Hub 不会收到未知帧）；
 * - 结果只认当前打开会话，切走后迟到的用量不显示；
 * - 失败只写 `sessionUsageError`（面板里重试），不弹全局错误条、不把 loading 卡死。
 */

import { describe, expect, it } from 'vitest'
import { boot, createHarness, helloFrame, historyFrame, sleep } from './helpers/fake-channel.js'

const CAPS_V2 = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
}

const STATS = {
  inputTokens: 12345,
  outputTokens: 678,
  totalTokens: 13023,
  cacheReadTokens: 4096,
  assistantMessages: 3,
  userMessages: 2,
  turns: 2,
  truncated: false,
}

async function bootWithUsage(): Promise<ReturnType<typeof createHarness> & { channel: Awaited<ReturnType<typeof boot>> }> {
  const h = createHarness()
  const channel = await boot(h)
  // 覆盖 hello：带上 usage 特性（真的协商结果）
  channel.server(helloFrame({ requestId: 'hello-usage', capabilities: CAPS_V2, features: ['usage'] }))
  await sleep(10)
  h.controller.openSession('s1')
  channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 10 }))
  await sleep(10)
  return Object.assign(h, { channel })
}

describe('会话用量（usage 帧）', () => {
  it('请求 → 回帧：写入 sessionUsage 并结束 loading', async () => {
    const h = await bootWithUsage()
    expect(h.controller.getState().features).toContain('usage')

    h.controller.requestUsage('s1')
    const sent = h.channel.last('usage')
    expect(sent).toMatchObject({ type: 'usage', sessionId: 's1' })
    expect(h.controller.getState().sessionUsageLoading).toBe(true)

    h.channel.server({ v: 1, type: 'usage', requestId: sent.requestId, sessionId: 's1', stats: STATS })
    const state = h.controller.getState()
    expect(state.sessionUsage).toEqual(STATS)
    expect(state.sessionUsageLoading).toBe(false)
    expect(state.sessionUsageError).toBeNull()
    h.controller.dispose()
  })

  it('切走会话后迟到的用量不写到新会话上', async () => {
    const h = await bootWithUsage()
    h.controller.requestUsage('s1')
    const sent = h.channel.last('usage')
    h.controller.openSession('s2')
    h.channel.server({ v: 1, type: 'usage', requestId: sent.requestId, sessionId: 's1', stats: STATS })
    const state = h.controller.getState()
    expect(state.sessionUsage).toBeNull()
    h.controller.dispose()
  })

  it('错误帧：写 sessionUsageError 并结束 loading（不进全局 error）', async () => {
    const h = await bootWithUsage()
    h.controller.requestUsage('s1')
    const sent = h.channel.last('usage')
    h.channel.server({
      v: 1,
      type: 'error',
      requestId: sent.requestId,
      code: 'upstream-unavailable',
      message: '无法取得会话游标',
      retryable: true,
    })
    const state = h.controller.getState()
    expect(state.sessionUsageLoading).toBe(false)
    // 0.2.10：面板里也用中文兜底文案，不直接展示 adapter 原始技术文案
    expect(state.sessionUsageError).toBe('服务暂时不可用，请稍后重试')
    expect(state.sessionUsageError).not.toContain('无法取得会话游标')
    expect(state.error).toBeNull()
    h.controller.dispose()
  })

  it('未协商 usage：不发帧，直接给可读错误', async () => {
    const h = createHarness()
    const channel = await boot(h)
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 10 }))
    h.controller.requestUsage('s1')
    expect(channel.count('usage')).toBe(0)
    expect(h.controller.getState().sessionUsageError).toContain('不支持')
    h.controller.dispose()
  })

  it('clearUsage 清空数据', async () => {
    const h = await bootWithUsage()
    h.controller.requestUsage('s1')
    const sent = h.channel.last('usage')
    h.channel.server({ v: 1, type: 'usage', requestId: sent.requestId, sessionId: 's1', stats: STATS })
    h.controller.clearUsage()
    expect(h.controller.getState().sessionUsage).toBeNull()
    expect(h.controller.getState().sessionUsageSessionId).toBeNull()
    h.controller.dispose()
  })
})
