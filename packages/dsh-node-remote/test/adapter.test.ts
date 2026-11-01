import { describe, expect, it, vi } from 'vitest'
import {
  createNodeRemote,
  probeNodeRemote,
  NodeRemoteIncompatibleError,
  type MobileServerFrame,
  type WebSocketLike,
} from '../src/index.js'
import {
  FakeSocket,
  NODE,
  collect,
  defaultRespond,
  fakeHost,
  lastCall,
  type Call,
  type FakeHostOptions,
} from './fake-host.js'

/**
 * 用「假 Host」验证 adapter 的翻译契约：
 * - 能力探测只发空参数请求（无副作用），缺端点必须抛错而不是返回空列表
 * - 历史页的 throughSeq 必须来自 follow 的 snapshot.cursor
 * - assistant-stream.end 只发 delta-end，回合结束只认 turn/end
 * - 审批只给不可批准 + 可取消动作
 */
describe('能力探测 fail-closed', () => {
  it('鉴权失败/网络错误 → probe failure，能力全 false（不伪装 true）', async () => {
    const unauthorized = fakeHost({
      probeShortcut: false,
      respond: (endpoint) => ({ ok: false, code: 'unauthenticated', message: `401 ${endpoint}` }),
    })
    const result = await probeNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: unauthorized.fetch, createWebSocket: async () => new FakeSocket() })
    expect(result.compatible).toBe(false)
    expect(result.failure).toContain('unauthenticated')
    expect(Object.values(result.capabilities).every((value) => value === false)).toBe(true)
  })

  it('headers() 抛错（凭据不可用）→ 全 false，且不发任何网络请求', async () => {
    const host = fakeHost({ respond: defaultRespond() })
    const result = await probeNodeRemote({
      origin: 'http://127.0.0.1:3000',
      node: NODE,
      fetch: host.fetch,
      createWebSocket: async () => new FakeSocket(),
      headers: () => {
        throw new Error('synthetic credential unavailable')
      },
    })
    expect(result.compatible).toBe(false)
    expect(result.failure).toContain('credential unavailable')
    expect(Object.values(result.capabilities).every((value) => value === false)).toBe(true)
    expect(host.calls).toHaveLength(0)
  })

  it('非法载荷被接受 = unsafe-probe：能力全 false 且立即停止探测', async () => {
    const accepted = fakeHost({
      respond: () => ({ ok: true, value: {} }),
      probeShortcut: false,
    })
    const result = await probeNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: accepted.fetch, createWebSocket: async () => new FakeSocket() })
    expect(result.compatible).toBe(false)
    expect(result.failure).toContain('unsafe-probe')
    expect(Object.values(result.capabilities).every((value) => value === false)).toBe(true)
    // 只探测到第一个端点就停，绝不继续试写端点
    expect(accepted.calls).toHaveLength(1)
  })

  it('传输层异常 → probe failure', async () => {
    const broken = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await probeNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: broken, createWebSocket: async () => new FakeSocket() })
    expect(result.compatible).toBe(false)
    expect(result.failure).toBeDefined()
    expect(Object.values(result.capabilities).every((value) => value === false)).toBe(true)
  })
})

describe('能力探测', () => {
  it('全端点存在时兼容，stream 由 list+page 推出', async () => {
    const host = fakeHost({ respond: defaultRespond() })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => host.socket })
    expect(remote.compatible).toBe(true)
    expect(remote.capabilities).toMatchObject({ sessions: true, history: true, send: true, stop: true, stream: true, questions: true, create: true, approvals: false })
    // 探测只用「已知非法载荷」：strict 校验会在业务调用前拒绝（无副作用）
    expect(host.calls.every((call) => JSON.stringify(call.payload) === '{"args":{"__dsh_hub_probe":true}}')).toBe(true)
    await remote.close()
  })

  it('缺 prompt 端点 → 抛 NodeRemoteIncompatibleError，不返回空列表', async () => {
    const host = fakeHost({
      respond: (endpoint, payload) => (endpoint === 'session/prompt' ? undefined : defaultRespond()(endpoint, payload)),
    })
    await expect(
      createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => host.socket }),
    ).rejects.toBeInstanceOf(NodeRemoteIncompatibleError)
  })
})

describe('会话与历史', () => {
  it('列表去掉子代理、不带 cwd，标题从投影取', async () => {
    const host = fakeHost({ respond: defaultRespond() })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => host.socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'sessions', requestId: 'r1' }, await collect(frames))
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    if (frame?.type !== 'sessions') throw new Error('期望 sessions 帧')
    expect(frame.items).toEqual([
      { sessionId: 's_a', title: '会话 A', updatedAt: 10, running: true, blank: false, agentAvailable: true, origin: null },
    ])
    expect(JSON.stringify(frame)).not.toContain('secret')
    await remote.close()
  })

  it('历史页 throughSeq 来自临时 follow 的 snapshot.cursor', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    const done = remote.dispatch({ v: 1, type: 'history', requestId: 'r2', sessionId: 's_a', limit: 10 }, await collect(frames))
    // 等 adapter 发 open，再回 snapshot
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 42, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await done
    const page = frames.find((frame) => frame.type === 'history')
    if (page?.type !== 'history') throw new Error('期望 history 帧')
    expect(page.cursor).toBe(42)
    expect(page.items.map((item) => item.role)).toEqual(['user', 'assistant'])
    expect(page.items[0]?.clientMessageId).toBe('m_hist')
    expect(page.items[1]?.clientMessageId).toBeUndefined()
    expect(page.items[1]?.tools).toEqual(['bash'])
    expect(page.nextBeforeSeq).toBe(12)
    const pageCall = lastCall(host.calls, 'session/page')
    expect((pageCall?.payload as { args?: { request?: { throughSeq?: number } } }).args?.request?.throughSeq).toBe(42)
    await remote.close()
  })

  it('cursor 等待比 probe 宽松：刚重连时 snapshot 晚到也能拿到 history cursor', async () => {
    // 真机 21:01 的成分之一：probeTimeoutMs=3s 时，第一条 mux+follow 建立 + snapshot 可能更久。
    // cursorTimeoutMs 独立放宽后，这种「晚到」不该再成为失败。
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({
      origin: 'http://127.0.0.1:3000',
      node: NODE,
      fetch: host.fetch,
      createWebSocket: async () => socket,
      probeTimeoutMs: 40,
      cursorTimeoutMs: 500,
    })
    const frames: MobileServerFrame[] = []
    const done = remote.dispatch({ v: 1, type: 'history', requestId: 'r2c', sessionId: 's_a', limit: 10 }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    // 晚于 probeTimeout(40ms)、早于 cursorTimeout(500ms)
    await new Promise((resolve) => setTimeout(resolve, 150))
    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/follow'),
      value: { type: 'snapshot', cursor: 42, records: [], hasMore: false, projections: { values: {} }, header: {} },
    })
    await done
    const page = frames.find((frame) => frame.type === 'history')
    if (page?.type !== 'history') throw new Error(`期望 history 帧：${JSON.stringify(frames)}`)
    expect(page.cursor).toBe(42)
    await remote.close()
  })

  it('临时 follow 迟迟不给 snapshot.cursor → upstream-unavailable（可重试），不是 internal', async () => {
    // 容器刚唤醒 / Host 还没把会话 follow 拉起来时的真实场景：cursorFor 等不到 snapshot。
    // 这个错误必须是 retryable 的 upstream-unavailable，客户端才会重试并显示友好文案。
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({
      origin: 'http://127.0.0.1:3000',
      node: NODE,
      fetch: host.fetch,
      createWebSocket: async () => socket,
      probeTimeoutMs: 60,
      cursorTimeoutMs: 60,
    })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'history', requestId: 'r2b', sessionId: 's_a', limit: 10 }, await collect(frames))
    const error = frames.find((frame) => frame.type === 'error')
    if (error?.type !== 'error') throw new Error('期望 error 帧')
    expect(error.code).toBe('upstream-unavailable')
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('无法取得会话游标')
    await remote.close()
  })
})

describe('流式', () => {
  it('chunk→delta、end→delta-end，turn/end 才是回合结束', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    const sink = await collect(frames)
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 'r3', sessionId: 's_a' }, sink)
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBeGreaterThan(0))
    const follow = socket.streamFor('session/follow')
    socket.push({ type: 'item', streamId: follow, value: { type: 'snapshot', cursor: 41, records: [], hasMore: false, projections: { values: { title: '会话 A' } }, header: {} } })
    socket.push({ type: 'item', streamId: follow, value: { type: 'event', event: { type: 'turn/start', seq: 42, time: 1, data: { turn: 3 } } } })
    socket.push({ type: 'item', streamId: follow, value: { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att', revision: 1, index: 0, time: 2, chunk: { type: 'text-delta', index: 0, text: '你' } } } })
    socket.push({ type: 'item', streamId: follow, value: { type: 'assistant-stream', frame: { type: 'end', attemptId: 'att', revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 43 } } } })
    socket.push({ type: 'item', streamId: follow, value: { type: 'event', event: { type: 'turn/end', seq: 44, time: 3, data: { turn: 3, reason: 'completed' } } } })
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'turn')).toHaveLength(2))

    const types = frames.map((frame) => frame.type)
    expect(types).toContain('replay')
    const delta = frames.find((frame) => frame.type === 'delta')
    if (delta?.type !== 'delta') throw new Error('期望 delta')
    expect(delta.part).toEqual({ kind: 'text', text: '你' })
    // reasoning-delta 绝不能当成回答正文；无 type 的 text 字段也不得兜底
    socket.push({ type: 'item', streamId: follow, value: { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att', revision: 1, index: 1, time: 3, chunk: { type: 'reasoning-delta', index: 0, text: '思考中' } } } })
    socket.push({ type: 'item', streamId: follow, value: { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att', revision: 1, index: 2, time: 4, chunk: { type: 'mystery', text: '别当正文' } } } })
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === 'delta')).toHaveLength(3))
    const deltas = frames.filter((frame) => frame.type === 'delta')
    expect(deltas[1]).toMatchObject({ part: { kind: 'reasoning', text: '思考中' } })
    expect(deltas[2]).toMatchObject({ part: { kind: 'unknown' } })
    expect(deltas[2]).not.toHaveProperty('part.text')
    const deltaEnd = frames.find((frame) => frame.type === 'delta-end')
    expect(deltaEnd).toMatchObject({ attemptId: 'att', committed: true })
    const turns = frames.filter((frame) => frame.type === 'turn')
    expect(turns.map((frame) => (frame.type === 'turn' ? frame.phase : ''))).toEqual(['start', 'end'])
    // delta-end 必须早于 turn end，且 delta-end 不是 turn
    expect(types.indexOf('delta-end')).toBeLessThan(types.lastIndexOf('turn'))
    await remote.close()
  })

  it('审批只报不可批准，并给取消动作', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 'r4', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBeGreaterThan(0))
    const follow = socket.streamFor('session/follow')
    socket.push({ type: 'item', streamId: follow, value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    socket.push({ type: 'item', streamId: follow, value: { type: 'event', event: { type: 'approval/asked', seq: 2, time: 1, data: { id: 'ap1', toolName: 'bash', callId: 'c1', reason: '写文件' } } } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'approval')).toBe(true))
    const approval = frames.find((frame) => frame.type === 'approval')
    if (approval?.type !== 'approval') throw new Error('期望 approval')
    expect(approval.approval).toMatchObject({ approvalId: 'ap1', tool: 'bash', answerable: false, actions: ['cancel'] })
    await remote.close()
  })
})

describe('发送与问答', () => {
  it('send 用 clientMessageId 当 DSH requestId，并回 ack', async () => {
    const host = fakeHost({ respond: defaultRespond() })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => host.socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch(
      { v: 1, type: 'send', requestId: 'r5', sessionId: 's_a', text: '跑测试', clientMessageId: 'm1' },
      await collect(frames),
    )
    expect(frames[0]).toEqual({ v: 1, type: 'ack', requestId: 'r5', clientMessageId: 'm1' })
    const prompt = lastCall(host.calls, 'session/prompt')
    expect(prompt?.payload).toMatchObject({ args: { request: { requestId: 'm1', sessionId: 's_a', mode: 'queue', content: [{ type: 'text', text: '跑测试' }] } } })
    await remote.close()
  })

  it('answer-question 只接受订阅会话里真实出现过的 callId', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    // 先订阅并收到 control 投影，才允许回答该 callId
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 'r6s', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBeGreaterThan(0))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === 'session/control')).toBe(true))
    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/control'),
      value: {
        type: 'projection', sessionId: 's_a', key: 'userQuestions', seq: 5,
        value: { active: [{ callId: 'call_q', state: 'open', questions: [{ id: 'q1', question: '范围？', options: [{ label: '仅本机' }] }] }], settled: [] },
      },
    })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'question')).toBe(true))
    frames.length = 0
    await remote.dispatch(
      {
        v: 1,
        type: 'answer-question',
        requestId: 'r6',
        sessionId: 's_a',
        agent: 's_a',
        callId: 'call_q',
        answers: [{ id: 'q1', selected: ['仅本机'] }],
      },
      await collect(frames),
    )
    expect(frames[0]).toMatchObject({ type: 'answer-result', accepted: true, continued: true })
    const answer = lastCall(host.calls, 'userQuestions/answer')
    expect(answer?.payload).toEqual({ args: { agentId: 's_a', callId: 'call_q', answer: { answers: [{ id: 'q1', selected: ['仅本机'] }] } } })
    // 未订阅会话的 callId 一律拒绝
    const denied: MobileServerFrame[] = []
    await remote.dispatch(
      { v: 1, type: 'answer-question', requestId: 'r7', sessionId: 's_other', agent: 's_other', callId: 'call_q', answers: [{ id: 'q1', selected: [] }] },
      await collect(denied),
    )
    expect(denied[0]).toMatchObject({ type: 'error', code: 'question-not-answerable' })
    await remote.close()
  })

  it('Host 业务错误映射成稳定错误码', async () => {
    const host = fakeHost({
      respond: (endpoint, payload) =>
        endpoint === 'session/cancel'
          ? { ok: false, code: 'session/not-found', message: '没有这个会话' }
          : defaultRespond()(endpoint, payload),
    })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => host.socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'stop', requestId: 'r7', sessionId: 'nope' }, await collect(frames))
    expect(frames[0]).toMatchObject({ type: 'error', code: 'session-not-found', requestId: 'r7' })
    await remote.close()
  })
})

describe('提问投影结算（settled 只有 callId/answers）', () => {
  it('另一端已答：settled 撤卡、资格移除、不能再答', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === 'session/control')).toBe(true))
    const control = socket.streamFor('session/control')
    // 先 open
    socket.push({ type: 'item', streamId: control, value: { type: 'projection', sessionId: 's_a', key: 'userQuestions', seq: 2, value: { active: [{ callId: 'c1', state: 'open', questions: [{ id: 'q1', question: '范围？' }] }], settled: [] } } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'question')).toBe(true))
    // 另一端回答后：active 空，settled 只有 callId+answers
    socket.push({ type: 'item', streamId: control, value: { type: 'projection', sessionId: 's_a', key: 'userQuestions', seq: 3, value: { active: [], settled: [{ callId: 'c1', answers: [{ id: 'q1', selected: ['仅本机'] }] }] } } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'question-settled')).toBe(true))
    const settledFrame = frames.find((f) => f.type === 'question-settled')
    expect(settledFrame).toMatchObject({ callId: 'c1', answers: [{ id: 'q1', selected: ['仅本机'] }] })
    const after: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'answer-question', requestId: 'a1', sessionId: 's_a', agent: 's_a', callId: 'c1', answers: [{ id: 'q1', selected: [] }] }, await collect(after))
    expect(after[0]).toMatchObject({ type: 'error', code: 'question-not-answerable' })
    await remote.close()
  })
})

describe('审批（$events waterfall）', () => {
  async function subscribedWith(socket: FakeSocket, host: ReturnType<typeof fakeHost>) {
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === '$events')).toBe(true))
    return { remote, frames }
  }

  it('waterfall → answerable 审批卡；approve 回 allowed-once 并结算', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const { remote, frames } = await subscribedWith(socket, host)
    const events = socket.streamFor('$events')
    socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'approval/request', eventId: 'ev1', agentId: 's_a', request: { toolName: 'bash', callId: 'call1', displayReason: '写文件' } } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'approval')).toBe(true))
    const approval = frames.find((frame) => frame.type === 'approval')
    if (approval?.type !== 'approval') throw new Error('期望 approval')
    expect(approval.approval).toMatchObject({ approvalId: 'ev1', answerable: true, actions: ['approve', 'reject', 'cancel'], state: 'open', tool: 'bash' })

    frames.length = 0
    await remote.dispatch({ v: 1, type: 'answer-approval', requestId: 'a1', sessionId: 's_a', approvalId: 'ev1', decision: 'approve' }, await collect(frames))
    expect(frames[0]).toMatchObject({ type: 'approval-settled', approvalId: 'ev1', decision: 'approve' })
    const result = lastCall(host.calls, '$events/result')
    expect(result?.payload).toMatchObject({ args: { clientId: 'c1', eventId: 'ev1', outcome: { kind: 'result', value: 'allowed-once' } } })
    await remote.close()
  })

  it('非订阅会话的 waterfall 立刻 next；cancel 帧 → expired', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const { remote, frames } = await subscribedWith(socket, host)
    const events = socket.streamFor('$events')
    socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'approval/request', eventId: 'ev2', agentId: 's_other', request: { toolName: 'bash' } } })
    await vi.waitFor(() => expect(lastCall(host.calls, '$events/result')).toBeDefined())
    expect(lastCall(host.calls, '$events/result')?.payload).toMatchObject({ args: { eventId: 'ev2', outcome: { kind: 'next' } } })
    expect(frames.some((frame) => frame.type === 'approval')).toBe(false)

    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'approval/request', eventId: 'ev3', agentId: 's_a', request: { toolName: 'bash' } } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'approval')).toBe(true))
    socket.push({ type: 'item', streamId: events, value: { type: 'cancel', eventId: 'ev3' } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'approval-settled' && frame.decision === 'expired')).toBe(true))
    await remote.close()
  })

  it('unsubscribe 立即交还未决审批（next）并撤销问答资格', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const { remote, frames } = await subscribedWith(socket, host)
    const events = socket.streamFor('$events')
    socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'approval/request', eventId: 'ev9', agentId: 's_a', request: { toolName: 'bash' } } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'approval')).toBe(true))
    await remote.dispatch({ v: 1, type: 'unsubscribe', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(lastCall(host.calls, '$events/result')).toBeDefined())
    expect(lastCall(host.calls, '$events/result')?.payload).toMatchObject({ args: { eventId: 'ev9', outcome: { kind: 'next' } } })
    expect(frames.some((f) => f.type === 'approval-settled' && f.decision === 'expired')).toBe(true)
    // 切走后再答：拒绝
    const after: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'answer-question', requestId: 'a9', sessionId: 's_a', agent: 's_a', callId: 'q', answers: [{ id: 'q', selected: [] }] }, await collect(after))
    expect(after[0]).toMatchObject({ type: 'error', code: 'question-not-answerable' })
    await remote.close()
  })

  it('审批答复 HTTP 失败时保留 pending，可重试成功', async () => {
    const socket = new FakeSocket()
    let failNext = true
    const respond = (endpoint: string, payload: unknown) => {
      if (endpoint === '$events/result') {
        if (failNext) { failNext = false; return { ok: false as const, code: 'gateway/internal', message: 'boom' } }
        return { ok: true as const, value: undefined }
      }
      return defaultRespond()(endpoint, payload)
    }
    const host = fakeHost({ respond, ws: socket })
    const { remote, frames } = await subscribedWith(socket, host)
    const events = socket.streamFor('$events')
    socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'approval/request', eventId: 'ev10', agentId: 's_a', request: { toolName: 'bash' } } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'approval')).toBe(true))
    const first: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'answer-approval', requestId: 'x1', sessionId: 's_a', approvalId: 'ev10', decision: 'approve' }, await collect(first))
    expect(first[0]).toMatchObject({ type: 'error' })
    // pending 仍在：再答一次应成功
    const second: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'answer-approval', requestId: 'x2', sessionId: 's_a', approvalId: 'ev10', decision: 'approve' }, await collect(second))
    expect(second[0]).toMatchObject({ type: 'approval-settled', approvalId: 'ev10', decision: 'approve' })
    await remote.close()
  })

  it('120 秒无人应答发 next，绝不自动批准', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const host = fakeHost({ respond: defaultRespond(), ws: socket })
      const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
      const frames: MobileServerFrame[] = []
      await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
      await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
      socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
      await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === '$events')).toBe(true))
      const events = socket.streamFor('$events')
      socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
      socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'approval/request', eventId: 'ev4', agentId: 's_a', request: { toolName: 'bash' } } })
      await vi.advanceTimersByTimeAsync(121_000)
      const result = lastCall(host.calls, '$events/result')
      expect(result?.payload).toMatchObject({ args: { eventId: 'ev4', outcome: { kind: 'next' } } })
      expect(frames.some((frame) => frame.type === 'approval-settled' && frame.decision === 'expired')).toBe(true)
      await remote.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('readiness 探测与 approvals 死锁', () => {
  it('probeNodeRemote 不开 $events，approvals 恒 false', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const result = await probeNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    expect(result.compatible).toBe(true)
    expect(result.capabilities.approvals).toBe(false)
    expect(socket.sent.some((item) => item['endpoint'] === '$events')).toBe(false)
  })

  it('真实通道 hello 后才开 $events，并推 capability(approvals:true)', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'x', version: '1' } }, await collect(frames))
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === '$events')).toBe(true))
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'capability')).toBe(true))
    const capability = frames.find((frame) => frame.type === 'capability')
    if (capability?.type !== 'capability') throw new Error('期望 capability')
    expect(capability.capabilities.approvals).toBe(true)
    expect(remote.capabilities.approvals).toBe(true)
    await remote.close()
  })
})

describe('断线追赶（follow snapshot + page 重建）', () => {
  it('有界分页追不到 sinceCursor 时不发 replay 假推进，回 catch-up-incomplete', async () => {
    const socket = new FakeSocket()
    const respond = (endpoint: string, payload: unknown) => {
      if (JSON.stringify(payload).includes('__dsh_hub_probe')) return defaultRespond()(endpoint, payload)
      if (endpoint === 'session/page') {
        // 真实 Host 的 user/message 一定带 source.kind（WP40c 实测）；缺 source 的会被当成注入消息跳过
        return { ok: true as const, value: { hasMore: true, records: [{ type: 'event', event: { type: 'user/message', seq: 50, time: 50, data: { source: { kind: 'user', rpcId: 'm50' }, message: { content: [{ type: 'text', text: 'x' }] } } } }] } }
      }
      return defaultRespond()(endpoint, payload)
    }
    const host = fakeHost({ respond, ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's1', sessionId: 's_a', sinceCursor: 5 }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 100, records: [], hasMore: true, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'error')).toBe(true))
    expect(frames.some((frame) => frame.type === 'replay')).toBe(false)
    expect(frames.find((frame) => frame.type === 'error')).toMatchObject({ code: 'upstream-unavailable' })
    await remote.close()
  })

  it('sinceCursor=5 / snapshot=10：补发 6..10 的 message 后再 replay，不丢不重', async () => {
    const socket = new FakeSocket()
    const respond = (endpoint: string, payload: unknown) => {
      if (JSON.stringify(payload).includes('__dsh_hub_probe')) return defaultRespond()(endpoint, payload)
      if (endpoint === 'session/page') {
        const request = (payload as { args?: { request?: { throughSeq?: number } } }).args?.request
        expect(request?.throughSeq).toBe(10)
        return {
          ok: true as const,
          value: {
            hasMore: false,
            records: [6, 7, 8].map((seq) => ({
              type: 'event',
              event: {
                type: 'user/message',
                seq,
                time: seq,
                data: {
                  source: { kind: 'user', rpcId: `m${String(seq)}` },
                  message: { content: [{ type: 'text', text: `t${String(seq)}` }] },
                },
              },
            })),
          },
        }
      }
      return defaultRespond()(endpoint, payload)
    }
    const host = fakeHost({ respond, ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's1', sessionId: 's_a', sinceCursor: 5 }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    const record = (seq: number) => ({ type: 'event', event: { type: 'user/message', seq, time: seq, data: { source: { kind: 'user', rpcId: `m${String(seq)}` }, message: { content: [{ type: 'text', text: `t${String(seq)}` }] } } } })
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 10, records: [record(9), record(10)], hasMore: true, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'replay')).toBe(true))
    const messages = frames.filter((frame) => frame.type === 'message')
    expect(messages.map((frame) => (frame.type === 'message' ? frame.seq : 0))).toEqual([6, 7, 8, 9, 10])
    expect(messages[0]).toMatchObject({ clientMessageId: 'm6', role: 'user' })
    const replayIndex = frames.findIndex((frame) => frame.type === 'replay')
    expect(frames.slice(0, replayIndex).filter((frame) => frame.type === 'message')).toHaveLength(5)
    await remote.close()
  })
})

describe('open 前台提问（$events user-questions/request）', () => {
  it('waterfall 出题 → 应答走 $events/result，不再用 unary 假 accepted', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === '$events')).toBe(true))
    const events = socket.streamFor('$events')
    socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'user-questions/request', eventId: 'qev1', agentId: 's_a', request: { questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }] }], wait: { callId: 'call_q' } } } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'question')).toBe(true))
    const out: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'answer-question', requestId: 'a1', sessionId: 's_a', agent: 's_a', callId: 'call_q', answers: [{ id: 'q1', selected: ['A'] }] }, await collect(out))
    expect(out.find((f) => f.type === 'answer-result')).toMatchObject({ accepted: true, continued: false })
    const result = lastCall(host.calls, '$events/result')
    expect(result?.payload).toMatchObject({ args: { eventId: 'qev1', outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['A'] }] } } } })
    await remote.close()
  })

  it('unary 返回 false（非 continued）不得假报 accepted', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: (endpoint, payload) => endpoint === 'userQuestions/answer' ? { ok: true as const, value: false } : defaultRespond()(endpoint, payload), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === 'session/control')).toBe(true))
    socket.push({ type: 'item', streamId: socket.streamFor('session/control'), value: { type: 'projection', sessionId: 's_a', key: 'userQuestions', seq: 2, value: { active: [{ callId: 'c9', state: 'continued', questions: [{ id: 'q1', question: 'x' }] }], settled: [] } } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'question')).toBe(true))
    const out: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'answer-question', requestId: 'a2', sessionId: 's_a', agent: 's_a', callId: 'c9', answers: [{ id: 'q1', selected: [] }] }, await collect(out))
    expect(out[0]).toMatchObject({ type: 'error', code: 'question-not-answerable' })
    await remote.close()
  })
})

describe('timed 前台提问：attachWait claim', () => {
  it('timed=true 打开 attachWait(agentId,callId)；流结束→next 并撤卡，不靠 120s 假延长', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === '$events')).toBe(true))
    const events = socket.streamFor('$events')
    socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'user-questions/request', eventId: 'qev2', agentId: 's_a', request: { questions: [{ id: 'q1', question: '快答', options: [{ label: 'A' }] }], wait: { callId: 'call_t', timed: true } } } })
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === 'userQuestions/attachWait')).toBe(true))
    const attach = socket.sent.filter((item) => item['endpoint'] === 'userQuestions/attachWait').at(-1)
    expect((attach?.['payload'] as { args?: Record<string, unknown> }).args).toMatchObject({ callId: 'call_t' })
    expect(Object.keys((attach?.['payload'] as { args?: Record<string, unknown> }).args ?? {})).toContain('agentId')
    // Host deadline 到：attachWait 结束
    socket.push({ type: 'end', streamId: String(attach?.['streamId']) })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'question-settled')).toBe(true))
    expect(lastCall(host.calls, '$events/result')?.payload).toMatchObject({ args: { eventId: 'qev2', outcome: { kind: 'next' } } })
    await remote.close()
  })
})

describe('question 生命周期清理（close/cancel/首帧校验）', () => {
  async function timedQuestion(socket: FakeSocket, host: ReturnType<typeof fakeHost>, remote: any) {
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({ type: 'item', streamId: socket.streamFor('session/follow'), value: { type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { values: {} }, header: {} } })
    await vi.waitFor(() => expect(socket.sent.some((i) => i['endpoint'] === '$events')).toBe(true))
    const events = socket.streamFor('$events')
    socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
    socket.push({ type: 'item', streamId: events, value: { type: 'waterfall', event: 'user-questions/request', eventId: 'qev9', agentId: 's_a', request: { questions: [{ id: 'q1', question: 'x', options: [{ label: 'A' }] }], wait: { callId: 'call_9', timed: true } } } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'question')).toBe(true))
    return { frames, host }
  }

  it('close() 会 next 未决提问并释放 attachWait', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    await timedQuestion(socket, host, remote)
    await remote.close()
    expect(lastCall(host.calls, '$events/result')?.payload).toMatchObject({ args: { eventId: 'qev9', outcome: { kind: 'next' } } })
    const cancels = socket.sent.filter((item) => item['type'] === 'cancel').length
    expect(cancels).toBeGreaterThan(0)
  })

  it('电脑端先答（cancel 事件）→ 撤卡并从 pending 移除', async () => {
    const socket = new FakeSocket()
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    const { frames } = await timedQuestion(socket, host, remote)
    socket.push({ type: 'item', streamId: socket.streamFor('$events'), value: { type: 'cancel', eventId: 'qev9' } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'question-settled')).toBe(true))
    const out: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'answer-question', requestId: 'a', sessionId: 's_a', agent: 's_a', callId: 'call_9', answers: [{ id: 'q1', selected: ['A'] }] }, await collect(out))
    expect(out[0]).toMatchObject({ type: 'error', code: 'question-not-answerable' })
    await remote.close()
  })

  it('attachWait 首帧校验失败 → 回退 agent 参数名并成功', async () => {
    const socket = new FakeSocket()
    socket.attachWaitRejectsAgentId = true
    const host = fakeHost({ respond: defaultRespond(), ws: socket })
    const remote = await createNodeRemote({ origin: 'http://127.0.0.1:3000', node: NODE, fetch: host.fetch, createWebSocket: async () => socket })
    await timedQuestion(socket, host, remote)
    await vi.waitFor(() => expect(socket.sent.filter((item) => item['endpoint'] === 'userQuestions/attachWait').length).toBeGreaterThanOrEqual(2))
    const opens = socket.sent.filter((item) => item['endpoint'] === 'userQuestions/attachWait')
    const first = (opens[0]!['payload'] as { args?: Record<string, unknown> }).args ?? {}
    const second = (opens[1]!['payload'] as { args?: Record<string, unknown> }).args ?? {}
    expect(Object.keys(first)).toContain('agentId')
    expect(Object.keys(second)).toContain('agent')
    await remote.close()
  })

})
