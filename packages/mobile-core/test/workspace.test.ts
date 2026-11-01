/**
 * 时序经验回归（M2-实现进度.md §5 的六条，逐条对应 `it`）。
 *
 * 这些都是 0.2.0 在真机/压测中踩出来的坑，重写通道客户端时最容易丢；
 * 每条都写成「先制造时序，再断言状态」，不依赖真实 Hub。
 */

import { describe, expect, it } from 'vitest'
import {
  boot,
  bootWithSessions,
  createHarness,
  deltaFrame,
  helloFrame,
  historyFrame,
  openSession,
  sessionRow,
  sessionsFrame,
  sleep,
} from './helpers/fake-channel.js'

describe('连接与首屏', () => {
  it('hello → sessions；hello 之前不发业务帧', async () => {
    const h = createHarness()
    h.controller.start()
    await sleep(0)
    const channel = h.channels[0]!
    channel.emitOpen()
    expect(channel.count('hello')).toBe(1)
    expect(channel.count('sessions')).toBe(0)
    channel.server(helloFrame({ requestId: channel.last('hello').requestId }))
    expect(h.controller.getState().link).toBe('connected')
    expect(channel.count('sessions')).toBe(1)
    channel.server(sessionsFrame(channel.last('sessions').requestId, [sessionRow('s1')]))
    expect(h.controller.getState().sessions).toHaveLength(1)
  })

  it('重连成功会把 reconnectAttempt 归零，并用 sinceCursor 续看', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    // 已加载过消息的会话：重连立刻带 lastCursor 续看（不等首页）
    openSession(channel, 's1', [{ seq: 1, role: 'user', at: 1, text: 'hi' }])
    channel.server({
      v: 1,
      type: 'replay',
      sessionId: 's1',
      fromCursor: null,
      toCursor: 42,
    })
    channel.drop()
    await sleep(15)
    expect(h.channels.length).toBe(2)
    const second = h.channels[1]!
    second.emitOpen()
    second.server(helloFrame({ requestId: second.last('hello').requestId }))
    expect(h.controller.getState().link).toBe('connected')
    expect(h.controller.getState().reconnectAttempt).toBe(0)
    expect(second.last('subscribe')).toMatchObject({ sessionId: 's1', sinceCursor: 42 })
  })
})

describe('1. history epoch 隔离', () => {
  it('A→B→A 之后，旧 A 的迟到页必须丢弃', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('A')
    const firstA = channel.last('history').requestId
    h.controller.openSession('B')
    h.controller.openSession('A')
    const secondA = channel.last('history').requestId
    expect(secondA).not.toBe(firstA)

    // 旧 A 的页迟到：不能出现在当前 A 页面
    channel.server(
      historyFrame(firstA, 'A', [{ seq: 1, role: 'user', at: 1, text: 'stale' }]),
    )
    expect(h.controller.getState().messages).toHaveLength(0)

    // 当前 A 的页照常生效
    channel.server(
      historyFrame(secondA, 'A', [{ seq: 2, role: 'user', at: 2, text: 'fresh' }]),
    )
    expect(h.controller.getState().messages.map((m) => m.text)).toEqual(['fresh'])
  })

  it('会话对不上（frame.sessionId ≠ 请求的会话）也不合并', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('A')
    const request = channel.last('history').requestId
    channel.server(historyFrame(request, 'B', [{ seq: 1, role: 'user', at: 1, text: 'x' }]))
    expect(h.controller.getState().messages).toHaveLength(0)
  })

  it('history 请求期间新到的 canonical message 不被首页覆盖（按 seq 并集）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('A')
    const request = channel.last('history').requestId
    // 请求发出后、响应之前，实时消息到达
    channel.server({
      v: 1,
      type: 'message',
      sessionId: 'A',
      seq: 9,
      role: 'assistant',
      at: 9,
      text: 'live',
    })
    channel.server(
      historyFrame(request, 'A', [{ seq: 5, role: 'user', at: 5, text: 'history' }]),
    )
    expect(h.controller.getState().messages.map((m) => m.text)).toEqual(['history', 'live'])
  })
})

describe('2. requestId 归属有界', () => {
  it('旧会话的 history error 不改当前页；通道级错误照常显示', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('A')
    const oldRequest = channel.last('history').requestId
    h.controller.openSession('B')

    channel.server({
      v: 1,
      type: 'error',
      requestId: oldRequest,
      code: 'session-not-found',
      message: '旧会话不在了',
      retryable: false,
    })
    expect(h.controller.getState().error).toBeNull()

    // 通道级瞬态错误（mux 断开/实例启动中）现在会静默退避恢复，不再直接弹错误条
    channel.server({
      v: 1,
      type: 'error',
      code: 'upstream-unavailable',
      message: '上游不可用',
      retryable: true,
    })
    expect(h.controller.getState().error).toBeNull()

    // 不可重试的通道级错误照常显示
    channel.server({
      v: 1,
      type: 'error',
      code: 'internal',
      message: '服务出了点问题',
      retryable: false,
    })
    expect(h.controller.getState().error?.code).toBe('internal')
  })

  it('未知 requestId 的错误不改当前页', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('A')
    channel.server({
      v: 1,
      type: 'error',
      requestId: 'never-issued',
      code: 'internal',
      message: 'x',
      retryable: false,
    })
    expect(h.controller.getState().error).toBeNull()
  })

  it('超过 128 条请求记录会淘汰最旧（有界）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('A')
    const first = channel.last('history').requestId
    // 制造大量 loadOlder/refresh，把表挤出 128
    for (let i = 0; i < 140; i++) {
      h.controller.refreshSessions()
    }
    channel.server({
      v: 1,
      type: 'error',
      requestId: first,
      code: 'session-not-found',
      message: 'x',
      retryable: false,
    })
    expect(h.controller.getState().error).toBeNull()
  })
})

describe('3. 停止中发送的自我保护', () => {
  it('stop 之后、turn 结束之前，send 被拦截且不发帧', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server({ v: 1, type: 'turn', sessionId: 's1', phase: 'start', turn: 1 })

    h.controller.send('第一条')
    expect(channel.count('send')).toBe(1)
    h.controller.stopTurn()
    expect(h.controller.getState().stopRequested).toBe(true)
    const sentBefore = channel.count('send')
    h.controller.send('停止中')
    expect(channel.count('send')).toBe(sentBefore)
    expect(h.controller.getState().error?.code).toBe('stop-requested')

    // stopped.accepted 只是请求被接受，回合仍未结束
    channel.server({
      v: 1,
      type: 'stopped',
      requestId: channel.last('stop').requestId,
      sessionId: 's1',
      accepted: true,
    })
    expect(h.controller.getState().stopRequested).toBe(true)

    channel.server({ v: 1, type: 'turn', sessionId: 's1', phase: 'end', turn: 1, reason: 'cancelled' })
    expect(h.controller.getState().stopRequested).toBe(false)
    h.controller.send('恢复后')
    expect(channel.count('send')).toBe(sentBefore + 1)
  })

  it('节点掉线时 send 入口自拒（不依赖 UI 禁按钮）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server({
      v: 1,
      type: 'node-status',
      node: { id: 'cloud:self', connectable: false, reason: 'desktop-remote-off' },
    })
    h.controller.send('hi')
    expect(channel.count('send')).toBe(0)
    expect(h.controller.getState().error?.code).toBe('node-not-connectable')
    expect(h.controller.getState().error?.message).toContain('远程')
  })
})

describe('4. question-settled', () => {
  it('电脑端先答时按 callId 撤卡；其他会话的 settled 忽略', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    const question = {
      v: 1,
      type: 'question',
      sessionId: 's1',
      agent: 's1',
      callId: 'call_1',
      state: 'open',
      questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }] }],
    }
    channel.server(question)
    expect(h.controller.getState().questions).toHaveLength(1)

    channel.server({
      v: 1,
      type: 'question-settled',
      sessionId: 'other',
      callId: 'call_1',
    })
    expect(h.controller.getState().questions).toHaveLength(1)

    channel.server({
      v: 1,
      type: 'question-settled',
      sessionId: 's1',
      callId: 'call_1',
      answers: [{ id: 'q1', selected: ['A'] }],
    })
    expect(h.controller.getState().questions).toHaveLength(0)
  })
})

describe('5. assistant baseline 续传', () => {
  it('baseline 替换正文（不追加），后续 delta 从 nextIndex 继续，旧 delta 丢弃', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')

    channel.server(deltaFrame('s1', 'att1', 0, '旧'))
    channel.server(deltaFrame('s1', 'att1', 1, '文'))
    expect(h.controller.getState().streamingText).toBe('旧文')

    channel.server({
      v: 1,
      type: 'assistant-baseline',
      sessionId: 's1',
      attemptId: 'att2',
      revision: 2,
      nextIndex: 5,
      text: '前半',
    })
    expect(h.controller.getState().streamingText).toBe('前半')
    expect(h.controller.getState().turnRunning).toBe(true)

    channel.server(deltaFrame('s1', 'att2', 5, '后半', 'text', 2))
    expect(h.controller.getState().streamingText).toBe('前半后半')

    // 重复索引、旧 attempt 的迟到 delta 都不改变正文
    channel.server(deltaFrame('s1', 'att2', 3, '重复', 'text', 2))
    channel.server(deltaFrame('s1', 'att1', 9, '迟到'))
    expect(h.controller.getState().streamingText).toBe('前半后半')

    // reasoning 单独累加，不混入正文
    channel.server(deltaFrame('s1', 'att2', 6, '想一想', 'reasoning', 2))
    expect(h.controller.getState().streamingText).toBe('前半后半')
    expect(h.controller.getState().streamingReasoning).toBe('想一想')
  })

  it('其他会话的 baseline 丢弃', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server({
      v: 1,
      type: 'assistant-baseline',
      sessionId: 'other',
      attemptId: 'att9',
      revision: 1,
      nextIndex: 1,
      text: '不该出现',
    })
    expect(h.controller.getState().streamingText).toBeNull()
  })
})

describe('6. pending 生命周期', () => {
  it('ack 不清气泡；canonical message 按 clientMessageId 精确归并', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')

    h.controller.send('你好')
    const sent = channel.last('send')
    expect(h.controller.getState().messages).toHaveLength(1)
    expect(h.controller.getState().messages[0]).toMatchObject({ pending: true, localId: sent.clientMessageId })

    channel.server({ v: 1, type: 'ack', requestId: sent.requestId, clientMessageId: sent.clientMessageId })
    expect(h.controller.getState().messages[0]).toMatchObject({ pending: false, unknown: false })

    channel.server({
      v: 1,
      type: 'message',
      sessionId: 's1',
      seq: 7,
      role: 'user',
      at: 7,
      text: '你好',
      clientMessageId: sent.clientMessageId,
    })
    const messages = h.controller.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ seq: 7, localId: null, text: '你好' })
  })

  it('没有 clientMessageId 的用户消息不吃掉本地气泡（可能是电脑端发的）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    h.controller.send('手机发的')
    channel.server({
      v: 1,
      type: 'message',
      sessionId: 's1',
      seq: 3,
      role: 'user',
      at: 3,
      text: '电脑端发的',
    })
    const messages = h.controller.getState().messages
    expect(messages).toHaveLength(2)
    // canonical 按 seq 排序、本地待发气泡保持在末尾（与 0.2.0 一致）
    expect(messages.map((m) => m.text)).toEqual(['电脑端发的', '手机发的'])
  })

  it('跨越一次成功重连 → 未决消息标「结果未知」，重试沿用同一 id', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    h.controller.send('断线前')
    const sent = channel.last('send')
    expect(h.controller.getState().messages[0]!.pending).toBe(true)

    channel.drop()
    await sleep(15)
    const second = h.channels[1]!
    second.emitOpen()
    second.server(helloFrame({ requestId: second.last('hello').requestId }))

    const entry = h.controller.getState().messages[0]!
    expect(entry).toMatchObject({ pending: false, unknown: true, localId: sent.clientMessageId })

    h.controller.retryUnknown(entry.localId!)
    const retried = second.last('send')
    expect(retried.clientMessageId).toBe(sent.clientMessageId)
    expect(h.controller.getState().messages[0]!.pending).toBe(true)
  })

  it('send-in-flight：保留 pending 与身份，不自动重发', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    h.controller.send('在途')
    const sent = channel.last('send')
    channel.server({
      v: 1,
      type: 'error',
      requestId: sent.requestId,
      code: 'send-in-flight',
      message: '还在发送',
      retryable: true,
    })
    const entry = h.controller.getState().messages[0]!
    expect(entry).toMatchObject({ pending: true, unknown: false, failed: false })
    expect(channel.count('send')).toBe(1)
  })

  it('明确失败（不可重试）→ failed，删除幂等身份', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    h.controller.send('太长')
    const sent = channel.last('send')
    channel.server({
      v: 1,
      type: 'error',
      requestId: sent.requestId,
      code: 'frame-too-large',
      message: 'too large',
      retryable: false,
    })
    expect(h.controller.getState().messages[0]).toMatchObject({ pending: false, failed: true })
    expect(h.controller.getState().pendingSendCount).toBe(0)
  })

  it('旧会话的 ack 只清幂等记录，不改当前页', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('A')
    openSession(channel, 'A')
    h.controller.send('A 的消息')
    const sent = channel.last('send')
    h.controller.openSession('B')
    openSession(channel, 'B')
    channel.server({ v: 1, type: 'ack', requestId: sent.requestId, clientMessageId: sent.clientMessageId })
    expect(h.controller.getState().messages).toHaveLength(0)
    expect(h.controller.getState().error).toBeNull()
  })
})

describe('delta / delta-end / turn / message', () => {
  it('delta-end 不是回合结束；只有 turn/end 结束回合', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server({ v: 1, type: 'turn', sessionId: 's1', phase: 'start', turn: 1 })
    channel.server(deltaFrame('s1', 'att1', 0, '正在跑'))
    channel.server({
      v: 1,
      type: 'delta-end',
      sessionId: 's1',
      attemptId: 'att1',
      revision: 1,
      committed: true,
    })
    expect(h.controller.getState().streamingSettled).toBe(true)
    expect(h.controller.getState().turnRunning).toBe(true)

    channel.server({ v: 1, type: 'turn', sessionId: 's1', phase: 'end', turn: 1, reason: 'completed' })
    expect(h.controller.getState().turnRunning).toBe(false)
  })

  it('重复 index 不重复追加', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server(deltaFrame('s1', 'att1', 3, 'A'))
    channel.server(deltaFrame('s1', 'att1', 3, 'A'))
    channel.server(deltaFrame('s1', 'att1', 4, 'B'))
    expect(h.controller.getState().streamingText).toBe('AB')
  })

  it('canonical assistant message 替换增量并按 seq 去重', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server({ v: 1, type: 'turn', sessionId: 's1', phase: 'start', turn: 1 })
    channel.server(deltaFrame('s1', 'att1', 0, '增量'))
    channel.server({
      v: 1,
      type: 'message',
      sessionId: 's1',
      seq: 5,
      role: 'assistant',
      at: 5,
      text: '完整回答',
    })
    expect(h.controller.getState().streamingText).toBeNull()
    expect(h.controller.getState().messages.map((m) => m.text)).toEqual(['完整回答'])

    channel.server({
      v: 1,
      type: 'message',
      sessionId: 's1',
      seq: 5,
      role: 'assistant',
      at: 5,
      text: '完整回答（修订）',
    })
    expect(h.controller.getState().messages).toHaveLength(1)
    expect(h.controller.getState().messages[0]!.text).toBe('完整回答（修订）')
  })

  it('state(title) 更新会话行', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server({
      v: 1,
      type: 'state',
      sessionId: 's1',
      key: 'title',
      value: '自动标题',
      seq: 3,
    })
    expect(h.controller.getState().sessions[0]!.title).toBe('自动标题')
  })
})

describe('会话与失败', () => {
  it('create 后自动打开新会话', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.createSession()
    const request = channel.last('create').requestId
    channel.server({ v: 1, type: 'created', requestId: request, sessionId: 's_new' })
    expect(h.controller.getState().openSessionId).toBe('s_new')
    expect(channel.last('history')).toMatchObject({ sessionId: 's_new' })
  })

  it('协议版本不符 → failed + 升级提示，不再重连', async () => {
    const h = createHarness()
    h.controller.start()
    await sleep(0)
    const channel = h.channels[0]!
    channel.emitOpen()
    channel.server({ v: 2, type: 'hello', requestId: 'x' })
    expect(h.controller.getState().link).toBe('failed')
    expect(h.controller.getState().error?.code).toBe('protocol-version-unsupported')
  })

  it('bye(session-expired) 触发登录失效回调', async () => {
    let lost = 0
    const h = createHarness({ onSessionExpired: () => (lost += 1) })
    const channel = await boot(h)
    channel.server({ v: 1, type: 'bye', code: 'session-expired', reason: '过期了' })
    expect(h.controller.getState().link).toBe('closed')
    expect(lost).toBe(1)
  })

  it('能力更新（capability）后立即可发送', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')
    channel.server({
      v: 1,
      type: 'capability',
      capabilities: { ...{ sessions: true, history: true, stop: true, stream: true, questions: true, approvals: false, create: true }, send: false },
    })
    h.controller.send('x')
    expect(channel.count('send')).toBe(0)
    channel.server({
      v: 1,
      type: 'capability',
      capabilities: { sessions: true, history: true, send: true, stop: true, stream: true, questions: true, approvals: false, create: true },
    })
    h.controller.send('x')
    expect(channel.count('send')).toBe(1)
  })
})
