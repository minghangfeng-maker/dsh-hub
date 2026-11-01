/**
 * 消息时间线顺序（真机反馈 2026-10-26 第三轮）：
 *  - 真实 DSH 一轮回复有多个 `assistant/message`（先思考+联网搜索、再出答案），中间步骤
 *    没有正文。以前它们也单独成条，手机上看到一轮回复里多个「思考过程」块、夹空行。
 *  - `seq` 缺失/为 0 时会被当成 0 排到最上面，表现为「AI 回复跑到我提问的上面」。
 *
 * 这里锁住：中间步骤**只有在没有思考时**才不落条目（有思考要留成「思考过程」块，
 * 与工具卡交错；见 step-reasoning.test.ts）；seq 缺失归一成 null（排在末尾而不是最上面）。
 */

import { describe, expect, it } from 'vitest'
import { boot, createHarness, helloFrame, historyFrame, sleep } from './helpers/fake-channel.js'
import { mergeThread } from '../src/channel/tools.js'

async function openSessionWith(h: ReturnType<typeof createHarness>, items: unknown[]): Promise<void> {
  const channel = h.channels.length > 0 ? h.channels[h.channels.length - 1]! : (await boot(h))
  h.controller.openSession('s1')
  channel.server(historyFrame(channel.last('history').requestId, 's1', items, { cursor: 40 }))
}

describe('消息时间线顺序', () => {
  it('历史里带思考的中间步骤保留（思考框和工具卡交错），空的中间步骤仍丢弃', async () => {
    const h = createHarness()
    const channel = await boot(h)
    const items = [
      { seq: 1, role: 'user', at: 1, text: '深圳今天天气怎么样' },
      { seq: 2, role: 'assistant', at: 2, text: '', reasoning: '先搜一下天气…', tools: ['web_search'] },
      { seq: 3, role: 'assistant', at: 3, text: '', reasoning: '' },
      { seq: 4, role: 'assistant', at: 4, text: '今天多云 24–30°C（来源：Trip.com）', reasoning: '整理搜索结果' },
    ]
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', items, { cursor: 40 }))
    await sleep(0)

    const messages = h.controller.getState().messages
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.text)).toEqual(['深圳今天天气怎么样', '', '今天多云 24–30°C（来源：Trip.com）'])
    expect(messages[1]?.reasoning).toBe('先搜一下天气…')
    expect(messages[2]?.reasoning).toBe('整理搜索结果')
    h.controller.dispose()
  })

  it('历史里 seq=0 的条目不会排到会话最上面', async () => {
    const h = createHarness()
    const channel = await boot(h)
    const items = [
      { seq: 0, role: 'assistant', at: 1, text: '迟到的回复（seq 缺失）' },
      { seq: 1, role: 'user', at: 2, text: 'hi' },
      { seq: 2, role: 'assistant', at: 3, text: 'hello' },
    ]
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', items, { cursor: 40 }))
    await sleep(0)

    const texts = mergeThread(h.controller.getState().messages, [], []).map((item) =>
      item.kind === 'message' ? item.entry.text : '',
    )
    expect(texts).toEqual(['hi', 'hello', '迟到的回复（seq 缺失）'])
    h.controller.dispose()
  })

  it('实时消息 seq=0 时排在已有消息之后，不会插到提问上面', async () => {
    const h = createHarness()
    const channel = await boot(h)
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 40 }))
    channel.server({ v: 1, type: 'message', sessionId: 's1', seq: 5, role: 'user', at: 5, text: '问题' })
    channel.server({ v: 1, type: 'message', sessionId: 's1', seq: 0, role: 'assistant', at: 6, text: '回答' })

    const texts = mergeThread(h.controller.getState().messages, [], []).map((item) =>
      item.kind === 'message' ? item.entry.text : '',
    )
    expect(texts).toEqual(['问题', '回答'])
    h.controller.dispose()
  })

  it('mergeThread：缓存里带思考的「只思考」条目保留，没有思考的才过滤', () => {
    const items = mergeThread(
      [
        { seq: 1, localId: null, role: 'user', text: 'hi', tools: [], at: 1, pending: false, failed: false, unknown: false },
        { seq: 2, localId: null, role: 'assistant', text: '  ', tools: [], reasoning: '思考一', at: 2, pending: false, failed: false, unknown: false },
        { seq: 3, localId: null, role: 'assistant', text: '  ', tools: [], at: 3, pending: false, failed: false, unknown: false },
        { seq: 4, localId: null, role: 'assistant', text: '答案', tools: [], at: 4, pending: false, failed: false, unknown: false },
      ],
      [],
      [],
    )
    expect(items).toHaveLength(3)
    expect(items.map((item) => (item.kind === 'message' ? item.entry.text : ''))).toEqual(['hi', '  ', '答案'])
    expect(items[1]!.kind === 'message' && items[1]!.entry.reasoning).toBe('思考一')
  })
})
