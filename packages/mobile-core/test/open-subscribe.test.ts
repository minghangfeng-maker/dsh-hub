/**
 * 「history → session/follow 游标缝」回归（真机 2026-10-26）。
 *
 * 现场：新建会话后立刻发第一条消息，屏幕上 5 张「运行了命令」工具卡排到了用户气泡
 * **上面**，思考块在最下面。成因不是渲染排序写错，而是客户端压根没收到自己那条
 * `user/message`：
 *   history 帧带 `cursor`（= Host `session/follow` 的 opening cursor），
 *   旧代码 subscribe 不带 `sinceCursor`，于是 (history cursor, follow snapshot.cursor]
 *   之间落下的 durable 消息两端都收不到。本地气泡 seq=null，`mergeThread` 把它排到最后，
 *   后面到的工具卡（有真实 seq）就跑到它上面去了。
 *
 * 修法：打开会话先拉首页，再用首页 cursor 订阅（adapter 会补发缝里的消息）。
 * 这些用例锁死帧时序，不让 bug 回来。
 */

import { describe, expect, it } from 'vitest'
import {
  bootWithSessions,
  createHarness,
  helloFrame,
  historyFrame,
  sleep,
} from './helpers/fake-channel.js'
import { mergeThread } from '../src/channel/tools.js'

/** 真实 `tool` 帧形状（见 v2-render.test.ts）。 */
function toolStart(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'tool',
    sessionId: 's1',
    callId: 'call_bash_1',
    kind: 'bash',
    name: 'bash',
    phase: 'start',
    seq: 19,
    turn: 1,
    step: 1,
    status: 'running',
    title: '运行了命令',
    inputPreview: 'ls -la',
    inputBytes: 6,
    ...overrides,
  }
}

function toolEnd(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'tool',
    sessionId: 's1',
    callId: 'call_bash_1',
    kind: 'bash',
    name: 'bash',
    phase: 'end',
    seq: 20,
    turn: 1,
    step: 1,
    status: 'ok',
    title: '运行了命令',
    outputPreview: 'total 0',
    outputBytes: 8,
    durationMs: 45,
    ...overrides,
  }
}

const USER_TEXT = '用svg画一个鹈鹕骑自行车，在海边'

describe('打开会话：history cursor → subscribe.sinceCursor', () => {
  it('先拉首页，用首页 cursor 订阅（不裸订阅）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')

    // 首页没回来之前不能裸订阅：那会在 history 与 follow 之间留缝
    expect(channel.count('subscribe')).toBe(0)
    const request = channel.last('history')
    expect(request).toBeTruthy()
    channel.server(historyFrame(request.requestId, 's1', [], { cursor: 8 }))

    expect(channel.last('subscribe')).toMatchObject({ sessionId: 's1', sinceCursor: 8 })
  })

  it('首页失败（不可重试）也照样订阅（不带 cursor），实时流不能断', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    const request = channel.last('history')
    channel.server({
      v: 1,
      type: 'error',
      requestId: request.requestId,
      code: 'internal',
      message: '会话页读不出来',
      retryable: false,
    })

    const subscribe = channel.last('subscribe')
    expect(subscribe).toMatchObject({ sessionId: 's1' })
    expect(subscribe.sinceCursor).toBeUndefined()
  })

  it('切后台回来 mux 断开（adapter-unavailable）：首页静默重试并恢复，不弹错误条', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    const first = channel.last('history')
    // Hub 的 mux 断开时会把 adapter 的统一错误丢给每个流（真机看到的原文）
    channel.server({
      v: 1,
      type: 'error',
      requestId: first.requestId,
      code: 'adapter-unavailable',
      message: 'upstream-unavailable: Host 流连接关闭（1006 ）',
      retryable: true,
    })
    expect(h.controller.getState().error).toBeNull()
    expect(h.controller.getState().historyLoading).toBe(true)

    await sleep(700) // 第一次重试间隔 500ms
    const retried = channel.last('history')
    expect(retried.requestId).not.toBe(first.requestId)
    channel.server(
      historyFrame(retried.requestId, 's1', [{ seq: 1, role: 'user', at: 1, text: '回来啦' }], {
        cursor: 5,
      }),
    )

    const state = h.controller.getState()
    expect(state.error).toBeNull()
    expect(state.messages.map((m) => m.text)).toEqual(['回来啦'])
    expect(channel.last('subscribe')).toMatchObject({ sessionId: 's1', sinceCursor: 5 })
  })

  it('重试用尽仍失败：显示中文兜底文案并裸订阅（不再把技术错误原文丢给用户）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')

    const fail = (requestId: string): void => {
      channel.server({
        v: 1,
        type: 'error',
        requestId,
        code: 'adapter-unavailable',
        message: 'upstream-unavailable: Host 流连接关闭（1006 ）',
        retryable: true,
      })
    }
    // 0.2.10：瞬态重试 4 次（间隔 0.5s / 1s / 2s / 3s），覆盖容器唤醒窗口
    fail(channel.last('history').requestId)
    await sleep(700) // 第一次重试
    fail(channel.last('history').requestId)
    await sleep(1_200) // 第二次重试
    fail(channel.last('history').requestId)
    await sleep(2_200) // 第三次重试
    fail(channel.last('history').requestId)
    await sleep(3_200) // 第四次重试
    fail(channel.last('history').requestId)

    const state = h.controller.getState()
    expect(state.error?.code).toBe('adapter-unavailable')
    expect(state.error?.message).toBe('后端暂时不可用，请稍后重试')
    expect(state.historyLoading).toBe(false)
    // 兜底：跟着流还是要订阅（不带 cursor），实时流不能断
    expect(channel.last('subscribe')).toMatchObject({ sessionId: 's1' })
    expect(channel.count('history')).toBe(5)
    // 手动「重试」：再发一次首页
    h.controller.retryOpenSession()
    expect(channel.count('history')).toBe(6)
    expect(h.controller.getState().error).toBeNull()
  })

  it('新建会话后立刻发消息：缝里的 user/message 能补回，用户气泡排在工具卡上面（真机回归）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')

    // 首页：建会话后、发消息前的空页（cursor=8）
    channel.server(historyFrame(channel.last('history').requestId, 's1', [], { cursor: 8 }))
    expect(channel.last('subscribe')).toMatchObject({ sinceCursor: 8 })

    // 本地气泡立刻出现 —— 这正是 bug 发生时的真实状态：seq=null、排在最后
    const clientMessageId = h.controller.send(USER_TEXT)
    expect(clientMessageId).toBeTruthy()
    const local = h.controller.getState().messages
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({ role: 'user', seq: null, localId: clientMessageId })

    // Hub 按 sinceCursor=8 补发 (8, snapshot.cursor=12] 的 durable 消息：
    // seq=9 就是用户自己那条（旧代码永远收不到）。
    channel.server({ v: 1, type: 'replay', sessionId: 's1', fromCursor: 8, toCursor: 12 })
    channel.server({
      v: 1,
      type: 'message',
      sessionId: 's1',
      seq: 9,
      role: 'user',
      at: 3,
      text: USER_TEXT,
      clientMessageId,
    })
    // 之后才是这一轮的工具卡
    channel.server(toolStart())
    channel.server(toolEnd())

    const state = h.controller.getState()
    const users = state.messages.filter((entry) => entry.role === 'user')
    // 本地气泡被 canonical 消息精确替换，不能出现两条
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ seq: 9, localId: null, text: USER_TEXT })

    // 渲染时间线：用户消息在前、工具卡在后（修复前的反例）
    const thread = mergeThread(state.messages, state.toolCards, state.deliverables)
    expect(thread.map((item) => item.kind)).toEqual(['message', 'tool'])
    expect(thread[0]!.kind === 'message' && thread[0]!.entry.text).toBe(USER_TEXT)
  })

  it('冷启动/深链进会话（消息为空）：hello 后先拉首页再带 cursor 订阅', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1') // 首页一直不回来就掉线（模拟切后台/弱网）

    channel.drop()
    await sleep(15)
    const second = h.channels[1]!
    second.emitOpen()
    second.server(helloFrame({ requestId: second.last('hello').requestId }))

    // 没有消息就不在该连接上裸订阅，而是先拉首页
    expect(second.count('subscribe')).toBe(0)
    expect(second.last('history')).toBeTruthy()
    second.server(historyFrame(second.last('history').requestId, 's1', [], { cursor: 5 }))
    expect(second.last('subscribe')).toMatchObject({ sessionId: 's1', sinceCursor: 5 })
  })
})
