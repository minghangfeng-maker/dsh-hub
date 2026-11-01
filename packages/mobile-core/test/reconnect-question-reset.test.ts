/**
 * 重连复位：提问卡 / 回合状态（真机 2026-10-27 16:07 的「会话卡住」）。
 *
 * 现场链路：
 * 1. AI 发起阻塞式提问，手机显示选项卡；用户切后台/锁屏，手机通道断开
 *    （Hub 审计 `mobile.node.disconnect client-closed`）。
 * 2. Hub 的 adapter 关闭时把未决提问回 `next` → Host 的工具收到
 *    `no user-questions answerer accepted the request`，AI 自己决定并跑完回合。
 * 3. 7 分钟后 App 重连：adapter 的 catch-up 只补 `message`，不补 `turn/end`，
 *    也不发 `question-settled`（legacy 提问不进 projection）→ 客户端永远
 *    `turnRunning=true`（停止按钮）+ 底部残留一张点不动的提问卡。
 *
 * 修复：断线/重放边界清掉通道内瞬态交互，并用重连后第一份会话列表的 `running`
 * 校正回合状态（证明不了还在跑的回合就收口；`running === true` 时不能停在空闲）。
 */

import { describe, expect, it } from 'vitest'
import {
  bootWithSessions,
  createHarness,
  helloFrame,
  historyFrame,
  sessionRow,
  sessionsFrame,
  sleep,
} from './helpers/fake-channel.js'

function messageFrame(seq: number, role: 'user' | 'assistant', text: string): unknown {
  return { v: 1, type: 'message', sessionId: 's1', seq, role, at: 1_730_000_000_000, text }
}

function turnFrame(phase: 'start' | 'end'): unknown {
  return { v: 1, type: 'turn', sessionId: 's1', phase, turn: 1, reason: 'completed' }
}

function questionFrame(callId: string, state: 'open' | 'continued' = 'open'): unknown {
  return {
    v: 1,
    type: 'question',
    sessionId: 's1',
    agent: 's1',
    callId,
    state,
    questions: [
      {
        id: 'scope',
        header: '清理范围',
        question: '要删到哪一档？',
        options: [{ label: 'A. 只清归档+缓存' }, { label: 'B. 全清' }],
      },
    ],
  }
}

function replayFrame(fromCursor = 5, toCursor = 9): unknown {
  return { v: 1, type: 'replay', sessionId: 's1', fromCursor, toCursor }
}

/** 打开 s1 并让客户端停在「回合进行中 + 一张提问卡」。 */
async function stuckSession(): Promise<ReturnType<typeof createHarness>> {
  const h = createHarness()
  const channel = await bootWithSessions(h)
  h.controller.openSession('s1')
  channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 5 }))
  channel.server(messageFrame(6, 'user', '看看本地有些什么归档的信息，可以给删除删除'))
  channel.server(turnFrame('start'))
  channel.server(questionFrame('call_ask_1'))
  expect(h.controller.getState().turnRunning).toBe(true)
  expect(h.controller.getState().questions).toHaveLength(1)
  return h
}

/** 掉线 → 等重连建链 → 回 hello 与一份会话列表；返回新通道。 */
async function reconnect(
  h: ReturnType<typeof createHarness>,
  running: boolean,
): Promise<ReturnType<typeof createHarness>['channels'][number]> {
  const dead = h.channels[h.channels.length - 1]!
  dead.drop(1006)
  await sleep(5)
  const next = h.channels[h.channels.length - 1]!
  expect(next).not.toBe(dead)
  next.emitOpen()
  next.server(helloFrame({ requestId: next.last('hello').requestId }))
  next.server(
    sessionsFrame(next.last('sessions').requestId, [{ ...(sessionRow('s1') as object), running }]),
  )
  return next
}

describe('断线重连：提问卡与回合状态复位', () => {
  it('通道断开时立刻作废卡片（Host 已把它们回 next，重连也不会补撤销帧）', async () => {
    const h = await stuckSession()
    h.channels[0]!.drop(1006)
    await sleep(2)
    const state = h.controller.getState()
    expect(state.questions).toHaveLength(0)
    expect(state.approvals).toHaveLength(0)
    expect(state.stopRequested).toBe(false)
    h.controller.dispose()
  })

  it('重连后按会话列表 running=false 收口：不再显示停止按钮、清掉半截流式文本', async () => {
    const h = await stuckSession()
    const channel = h.channels[0]!
    // 断线前还留了半截流式正文（模拟断在输出中间）
    channel.server({
      v: 1,
      type: 'delta',
      sessionId: 's1',
      attemptId: 'att_1',
      revision: 1,
      index: 0,
      turn: 1,
      step: 2,
      part: { kind: 'text', text: '正在删除前 36' },
    })
    expect(h.controller.getState().streamingText).not.toBeNull()

    const next = await reconnect(h, false)
    const state = h.controller.getState()
    expect(state.turnRunning).toBe(false)
    expect(state.streamingText).toBeNull()
    expect(state.streamingReasoning).toBeNull()

    // catch-up 只补持久消息：最终答复照常渲染，但不会再冒出停止按钮
    next.server(replayFrame())
    next.server(messageFrame(9, 'assistant', '清理完成，只动了最安全的一档…'))
    await sleep(2)
    expect(h.controller.getState().turnRunning).toBe(false)
    expect(h.controller.getState().messages.some((m) => m.text.includes('清理完成'))).toBe(true)
    h.controller.dispose()
  })

  it('重连时会话仍在跑（running=true）：不能把回合状态误收口', async () => {
    const h = await stuckSession()
    await reconnect(h, true)
    expect(h.controller.getState().turnRunning).toBe(true)
    h.controller.dispose()
  })

  it('重放后仍然有效的提问（projection 重新下发）要留在界面上', async () => {
    const h = await stuckSession()
    const next = await reconnect(h, true)
    next.server(replayFrame())
    // adapter 在 replay 之后按 projection 重新下发还活着的提问（timed/continued）
    next.server(questionFrame('call_ask_1', 'continued'))
    await sleep(2)
    const questions = h.controller.getState().questions
    expect(questions).toHaveLength(1)
    expect(questions[0]?.state).toBe('continued')
    h.controller.dispose()
  })

  it('hello 快照说还在跑、catch-up 后才结束：重放后的补拉列表能收口', async () => {
    const h = await stuckSession()
    const next = await reconnect(h, true)
    expect(h.controller.getState().turnRunning).toBe(true)
    next.server(replayFrame())
    await sleep(2)
    // 跟随流已接上，客户端补拉一份最新列表：这时 Host 已经收口
    next.server(
      sessionsFrame(next.last('sessions').requestId, [
        { ...(sessionRow('s1') as object), running: false },
      ]),
    )
    await sleep(2)
    expect(h.controller.getState().turnRunning).toBe(false)
    h.controller.dispose()
  })

  it('重放后已失效的提问不会回来（adapter 不再下发 → 保持清空）', async () => {
    const h = await stuckSession()
    const next = await reconnect(h, false)
    next.server(replayFrame())
    next.server(messageFrame(9, 'assistant', '清理完成…'))
    await sleep(2)
    expect(h.controller.getState().questions).toHaveLength(0)
    h.controller.dispose()
  })
})
