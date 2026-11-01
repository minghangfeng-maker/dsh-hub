/**
 * 中间步骤的思考框：保留 + 与工具卡交错（真机 2026-10-27 反馈）。
 *
 * 现场：AI 先思考 → 调 web_search → 再思考 → 回答。旧客户端把「只思考/只调工具」的中间
 * assistant 步骤整条丢掉，于是工具卡一出现，思考框就整个消失，用户只看到
 * 「深度求索中 → 搜索了 5 个网页 → 回答」。
 *
 * 现在的语义：
 *  - 中间步骤**有思考**就落一条 assistant 条目（text 为空、只有 reasoning），
 *    按 seq 与工具卡交错：思考块 → 工具卡 → 思考块 → 回答；
 *  - 没有思考的中间步骤仍然丢掉，避免一轮回复里多出一堆空的「思考过程」；
 *  - history 重进会话时同样保留（否则回来又消失）。
 */

import { describe, expect, it } from 'vitest'
import { bootWithSessions, createHarness, deltaFrame, historyFrame } from './helpers/fake-channel.js'
import { mergeThread } from '../src/channel/tools.js'

function toolFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'tool',
    sessionId: 's1',
    callId: 'call_search_1',
    kind: 'search',
    name: 'web_search',
    phase: 'start',
    seq: 11,
    turn: 1,
    step: 1,
    status: 'running',
    title: '搜索了 1 个网页',
    ...overrides,
  }
}

function assistantMessage(
  seq: number,
  text: string,
  tools: string[] = [],
): unknown {
  return { v: 1, type: 'message', sessionId: 's1', seq, role: 'assistant', at: seq, text, tools }
}

describe('中间步骤的思考框（思考 → 工具 → 思考 → 回答）', () => {
  it('实时：中间步骤的思考落成条目，与工具卡按 seq 交错，最后回答不丢思考', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 5 }))

    // 步骤 1：思考增量 → 只调工具的中间步骤结束
    channel.server(deltaFrame('s1', 'att_1', 0, '先确认上下文', 'reasoning'))
    channel.server(assistantMessage(10, '', ['web_search']))
    let state = h.controller.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      seq: 10,
      role: 'assistant',
      text: '',
      reasoning: '先确认上下文',
    })
    // 这一步的流式思考被搬进条目后清空，下一步重新推
    expect(state.streamingReasoning).toBeNull()

    // 工具卡（seq 11）
    channel.server(toolFrame({ seq: 11 }))

    // 步骤 2：继续思考 → 出正文
    channel.server(deltaFrame('s1', 'att_2', 0, '再查一下契约', 'reasoning'))
    channel.server(assistantMessage(12, '答案正文'))

    state = h.controller.getState()
    expect(state.messages.map((m) => ({ seq: m.seq, text: m.text, reasoning: m.reasoning }))).toEqual([
      { seq: 10, text: '', reasoning: '先确认上下文' },
      { seq: 12, text: '答案正文', reasoning: '再查一下契约' },
    ])
    const thread = mergeThread(state.messages, state.toolCards, state.deliverables)
    expect(thread.map((item) => item.kind)).toEqual(['message', 'tool', 'message'])
    expect(thread[0]!.kind === 'message' && thread[0]!.entry.reasoning).toBe('先确认上下文')
    expect(thread[2]!.kind === 'message' && thread[2]!.entry.text).toBe('答案正文')
  })

  it('没有思考的中间步骤仍然不落条目（不出现空的「思考过程」）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 5 }))

    channel.server(assistantMessage(10, '', ['bash']))
    const state = h.controller.getState()
    expect(state.messages).toHaveLength(0)
  })

  it('history 重进会话：带思考的中间步骤保留、空的仍丢弃', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    channel.server(
      historyFrame(channel.last('history').requestId, 's1', [
        { seq: 1, role: 'user', at: 1, text: '查一下天气' },
        { seq: 2, role: 'assistant', at: 2, text: '', tools: ['web_search'], reasoning: '先查天气' },
        { seq: 3, role: 'assistant', at: 3, text: '', tools: ['bash'], reasoning: '' },
        { seq: 4, role: 'assistant', at: 4, text: '今天多云', reasoning: '整理结论' },
      ]),
    )
    const state = h.controller.getState()
    expect(state.messages.map((m) => ({ seq: m.seq, text: m.text, reasoning: m.reasoning }))).toEqual([
      { seq: 1, text: '查一下天气', reasoning: undefined },
      { seq: 2, text: '', reasoning: '先查天气' },
      { seq: 4, text: '今天多云', reasoning: '整理结论' },
    ])
    const thread = mergeThread(state.messages, state.toolCards, state.deliverables)
    expect(thread.map((item) => item.kind)).toEqual(['message', 'message', 'message'])
  })
})
