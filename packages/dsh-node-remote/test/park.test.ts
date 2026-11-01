import { describe, expect, it, vi } from 'vitest'
import { createNodeRemote, type MobileServerFrame, type NodeRemote } from '../src/index.js'
import { FakeSocket, NODE, collect, defaultRespond, fakeHost, lastCall } from './fake-host.js'

/**
 * WP46 / M6 §1：常驻会话代理的 adapter 侧（`parkInteractions`）。
 *
 * 这些用例钉的是**行为差异**：打开 park 之后，未决提问/审批不再绑在「通道订阅」上，
 * 只有 park 上限、回合停止/结束、`close()` 才回 `{kind:'next'}`；审批永远不自动批准。
 * 老行为（不传 `parkInteractions`）的回归在 `adapter.test.ts`。
 */

const PARK_MS = 30 * 60_000

async function parkRemote(socket: FakeSocket, parkMs = PARK_MS) {
  const host = fakeHost({ respond: defaultRespond(), ws: socket })
  const remote = await createNodeRemote({
    origin: 'http://127.0.0.1:3000',
    node: NODE,
    fetch: host.fetch,
    createWebSocket: async () => socket,
    parkInteractions: { parkMs },
  })
  return { host, remote }
}

async function subscribe(
  remote: NodeRemote,
  socket: FakeSocket,
  frames: MobileServerFrame[],
  sessionId = 's_a',
): Promise<string> {
  await remote.dispatch({ v: 1, type: 'subscribe', requestId: `sub-${sessionId}`, sessionId }, await collect(frames))
  await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBeGreaterThan(0))
  socket.push({
    type: 'item',
    streamId: socket.streamFor('session/follow'),
    value: { type: 'snapshot', cursor: 7, records: [], hasMore: false, projections: { values: {} }, header: {} },
  })
  await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === '$events')).toBe(true))
  const events = socket.streamFor('$events')
  socket.push({ type: 'item', streamId: events, value: { type: 'ready', clientId: 'c1', host: { home: '/x' } } })
  return events
}

function pushQuestion(
  socket: FakeSocket,
  events: string,
  options: { sessionId?: string; callId?: string; timed?: boolean; eventId?: string } = {},
) {
  const sessionId = options.sessionId ?? 's_a'
  // timed=true（默认）= 真实 timed 提问（带 wait.callId，手机侧用 attachWait 维持 claim）；
  // timed=false = legacy blocking（没有 wait，只有 park 上限能收尾）。
  const wait =
    options.timed === false ? {} : { wait: { callId: options.callId ?? 'call_q', timed: true } }
  socket.push({
    type: 'item',
    streamId: events,
    value: {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: options.eventId ?? 'qev1',
      agentId: sessionId,
      request: {
        questions: [{ id: 'q1', question: '要按哪个方案继续？', options: [{ label: '方案A' }, { label: '方案B' }] }],
        ...wait,
      },
    },
  })
}

function pushApproval(socket: FakeSocket, events: string, options: { sessionId?: string; eventId?: string } = {}) {
  socket.push({
    type: 'item',
    streamId: events,
    value: {
      type: 'waterfall',
      event: 'approval/request',
      eventId: options.eventId ?? 'ev1',
      agentId: options.sessionId ?? 's_a',
      request: { toolName: 'bash', callId: 'call_1', displayReason: '要写文件' },
    },
  })
}

function nextResults(host: ReturnType<typeof fakeHost>) {
  return host.calls.filter((call) => call.endpoint === '$events/result')
}

describe('park：通道断开不再 next（提问）', () => {
  it('unsubscribe 后提问仍在，重订阅后 sessionState 带回该提问并可应答', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushQuestion(socket, events)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'question')).toBe(true))

    // 通道断开 = 最后一条通道 unsubscribe：**不回 next**，条目留在暂存里
    await remote.dispatch({ v: 1, type: 'unsubscribe', sessionId: 's_a' }, await collect(frames))
    expect(nextResults(host)).toHaveLength(0)
    const state = remote.sessionState?.('s_a')
    expect(state?.questions).toHaveLength(1)
    expect(state?.questions[0]).toMatchObject({ agent: 's_a', callId: 'call_q', state: 'open' })
    expect(remote.pendingInteractions?.().get('s_a')).toBe(1)

    // 重连后的通道：重新 subscribe 就能从快照里看到它，并且可以直接回答
    const events2 = await subscribe(remote, socket, frames)
    void events2
    const out: MobileServerFrame[] = []
    await remote.dispatch(
      { v: 1, type: 'answer-question', requestId: 'a1', sessionId: 's_a', agent: 's_a', callId: 'call_q', answers: [{ id: 'q1', selected: ['方案A'] }] },
      await collect(out),
    )
    expect(out.find((frame) => frame.type === 'answer-result')).toMatchObject({ accepted: true, continued: false })
    const result = lastCall(host.calls, '$events/result')
    expect(result?.payload).toMatchObject({
      args: { eventId: 'qev1', outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['方案A'] }] } } },
    })
    expect(remote.sessionState?.('s_a').questions).toHaveLength(0)
    await remote.close()
  })

  it('非订阅会话的提问也暂存、计入 pendingInteractions，并可应答', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushQuestion(socket, events, { sessionId: 's_b', callId: 'call_b', eventId: 'qev_b' })
    await vi.waitFor(() => expect(remote.pendingInteractions?.().get('s_b')).toBe(1))
    // 老行为这里立刻 next；park 之后不许 next
    expect(nextResults(host)).toHaveLength(0)
    expect(remote.sessionState?.('s_b')).toMatchObject({ running: false, questions: [{ callId: 'call_b' }] })

    // 任何一条通道都可应答（不需要先订阅 s_b）
    const out: MobileServerFrame[] = []
    await remote.dispatch(
      { v: 1, type: 'answer-question', requestId: 'a2', sessionId: 's_b', agent: 's_b', callId: 'call_b', answers: [{ id: 'q1', selected: ['方案B'] }] },
      await collect(out),
    )
    expect(out.find((frame) => frame.type === 'answer-result')).toMatchObject({ accepted: true })
    expect(lastCall(host.calls, '$events/result')?.payload).toMatchObject({ args: { eventId: 'qev_b' } })
    await remote.close()
  })

  it('park 上限到点：提问 next（绝不替用户回答）', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket, 60)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushQuestion(socket, events)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'question')).toBe(true))
    await vi.waitFor(() => expect(nextResults(host)).toHaveLength(1), { timeout: 2_000 })
    expect(nextResults(host)[0]?.payload).toMatchObject({ args: { eventId: 'qev1', outcome: { kind: 'next' } } })
    expect(frames.some((frame) => frame.type === 'question-settled')).toBe(true)
    expect(remote.sessionState?.('s_a').questions).toHaveLength(0)
    await remote.close()
  })
})

describe('park：审批', () => {
  it('非订阅会话的审批也暂存并计入角标；等待上限 = parkMs；只回 next，绝不自动批准', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket, 80)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushApproval(socket, events, { sessionId: 's_b' })
    await vi.waitFor(() => expect(remote.pendingInteractions?.().get('s_b')).toBe(1))
    const approval = remote.sessionState?.('s_b').approvals[0]
    expect(approval).toMatchObject({ approvalId: 'ev1', tool: 'bash', answerable: true, state: 'open' })
    expect(nextResults(host)).toHaveLength(0)
    await vi.waitFor(() => expect(nextResults(host)).toHaveLength(1), { timeout: 2_000 })
    const outcome = (nextResults(host)[0]?.payload as { args: { outcome: unknown } }).args.outcome
    expect(outcome).toEqual({ kind: 'next' })
    expect(frames.some((frame) => frame.type === 'approval-settled' && frame.decision === 'expired')).toBe(true)
    await remote.close()
  })

  it('通道断开（unsubscribe）后审批仍在 → 重连后可以批准（审批绝不自动批准）', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushApproval(socket, events)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'approval')).toBe(true))
    await remote.dispatch({ v: 1, type: 'unsubscribe', sessionId: 's_a' }, await collect(frames))
    expect(nextResults(host)).toHaveLength(0)
    expect(remote.sessionState?.('s_a').approvals).toHaveLength(1)

    const out: MobileServerFrame[] = []
    await remote.dispatch(
      { v: 1, type: 'answer-approval', requestId: 'x1', sessionId: 's_a', approvalId: 'ev1', decision: 'approve' },
      await collect(out),
    )
    expect(out[0]).toMatchObject({ type: 'approval-settled', decision: 'approve' })
    expect((lastCall(host.calls, '$events/result')?.payload as { args: { outcome: unknown } }).args.outcome).toEqual({
      kind: 'result',
      value: 'allowed-once',
    })
    await remote.close()
  })
})

describe('park：其余 next 出口', () => {
  it('close()（容器停止 / 登出 / Hub 关闭）立即 next', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushQuestion(socket, events)
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'question')).toBe(true))
    await remote.close()
    expect(nextResults(host).length).toBeGreaterThanOrEqual(1)
    expect(nextResults(host).at(-1)?.payload).toMatchObject({ args: { outcome: { kind: 'next' } } })
  })

  it('回合结束（turn/end）交还未决交互', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushApproval(socket, events)
    await vi.waitFor(() => expect(remote.pendingInteractions?.().get('s_a')).toBe(1))
    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/follow'),
      value: { type: 'event', event: { type: 'turn/end', seq: 9, time: 5, data: { turn: 1, reason: 'completed' } } },
    })
    await vi.waitFor(() => expect(nextResults(host)).toHaveLength(1))
    expect(nextResults(host)[0]?.payload).toMatchObject({ args: { eventId: 'ev1', outcome: { kind: 'next' } } })
    await vi.waitFor(() => expect(remote.pendingInteractions?.().get('s_a')).toBeUndefined())
    await remote.close()
  })

  it('用户点停止（stop accepted）交还未决交互', async () => {
    const socket = new FakeSocket()
    const { host, remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    const events = await subscribe(remote, socket, frames)
    pushQuestion(socket, events)
    await vi.waitFor(() => expect(remote.pendingInteractions?.().get('s_a')).toBe(1))
    const out: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'stop', requestId: 'st1', sessionId: 's_a' }, await collect(out))
    // 先撤卡（question-settled）再回 stopped：Hub 收到 stopped 时快照已经干净
    expect(out.find((frame) => frame.type === 'question-settled')).toBeDefined()
    expect(out.find((frame) => frame.type === 'stopped')).toMatchObject({ accepted: true })
    expect(nextResults(host)).toHaveLength(1)
    expect(remote.sessionState?.('s_a').questions).toHaveLength(0)
    await remote.close()
  })
})

describe('多通道共享一条 follow（WP46 返工）', () => {
  it('isFollowing：subscribe 后为真、unsubscribe 后为假、follow 自然结束也为假', async () => {
    const socket = new FakeSocket()
    const { remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    expect(remote.isFollowing?.('s_a')).toBe(false)
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's1', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    expect(remote.isFollowing?.('s_a')).toBe(true)
    // Host 结束这条跟随流：不再算「在跟随」，下一条 subscribe 应该重建
    socket.push({ type: 'end', streamId: socket.streamFor('session/follow') })
    await vi.waitFor(() => expect(remote.isFollowing?.('s_a')).toBe(false))

    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's2', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(2))
    expect(remote.isFollowing?.('s_a')).toBe(true)
    await remote.dispatch({ v: 1, type: 'unsubscribe', sessionId: 's_a' }, await collect(frames))
    expect(remote.isFollowing?.('s_a')).toBe(false)
    await remote.close()
  })

  it('sessionBaseline：进行中的 attempt 有基线，attempt 结束后清掉', async () => {
    const socket = new FakeSocket()
    const { remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's1', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    const followId = socket.streamFor('session/follow')
    socket.push({
      type: 'item',
      streamId: followId,
      value: {
        type: 'snapshot',
        cursor: 7,
        records: [],
        hasMore: false,
        projections: { values: { title: '会话 A', modelSelection: { next: { provider: 'p', model: 'm' } } } },
        header: {},
        assistantStream: {
          revision: 2,
          activeAttempt: {
            attemptId: 's_a:1',
            nextIndex: 2,
            stream: [
              { type: 'text-chunks', texts: ['前半段', '后半段'], index: 0, time0: 1, dt: [] },
              { type: 'reasoning-chunks', texts: ['想一下'], index: 1, time0: 2, dt: [] },
            ],
          },
        },
      },
    })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'assistant-baseline')).toBe(true))
    const baseline = remote.sessionBaseline?.('s_a')
    expect(baseline).toMatchObject({ attemptId: 's_a:1', revision: 2, nextIndex: 2, text: '前半段后半段', reasoning: '想一下' })
    // 投影也缓存了（加入者补 state 帧用）
    const projections = remote.sessionProjections?.('s_a') ?? []
    expect(projections.find((item) => item.key === 'title')).toMatchObject({ value: '会话 A' })

    // attempt 结束（assistant-stream.end）→ 基线作废
    socket.push({
      type: 'item',
      streamId: followId,
      value: { type: 'assistant-stream', frame: { type: 'end', attemptId: 's_a:1', revision: 3, outcome: { kind: 'committed' } } },
    })
    await vi.waitFor(() => expect(remote.sessionBaseline?.('s_a')).toBeNull())
    await remote.close()
  })

  it('catchUpFor：给加入者补 (sinceCursor, cursor] 的消息；追不到回 gap（不动 follow）', async () => {
    const socket = new FakeSocket()
    const { remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's1', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/follow'),
      value: { type: 'snapshot', cursor: 13, records: [], hasMore: false, projections: { values: {} }, header: {} },
    })
    await vi.waitFor(() => expect(remote.sessionState?.('s_a').cursor).toBe(13))

    const joined: MobileServerFrame[] = []
    const outcome = await remote.catchUpFor?.('s_a', 11, await collect(joined))
    expect(outcome).toBe('ok')
    expect(joined.map((frame) => frame.type)).toEqual(['message', 'message'])
    expect(joined[0]).toMatchObject({ sessionId: 's_a', seq: 12, role: 'user' })
    expect(joined[1]).toMatchObject({ sessionId: 's_a', seq: 13, role: 'assistant' })
    // 补发只回调给调用方：没有别的帧被推到共享 sink
    expect(frames.some((frame) => frame.type === 'message')).toBe(false)

    const gap: MobileServerFrame[] = []
    expect(await remote.catchUpFor?.('s_a', 1, await collect(gap))).toBe('gap')
    expect(gap).toHaveLength(0)
    // follow 没被动过
    expect(remote.isFollowing?.('s_a')).toBe(true)
    await remote.close()
  })

  it('follow 自己追不上：错误带这条 subscribe 的 requestId，且不拆共享 follow', async () => {
    const socket = new FakeSocket()
    const { remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    await remote.dispatch(
      { v: 1, type: 'subscribe', requestId: 'sub-open', sessionId: 's_a', sinceCursor: 1 },
      await collect(frames),
    )
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/follow'),
      value: { type: 'snapshot', cursor: 13, records: [], hasMore: false, projections: { values: {} }, header: {} },
    })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'error')).toBe(true))
    const error = frames.find((frame) => frame.type === 'error')
    expect(error).toMatchObject({ requestId: 'sub-open', code: 'upstream-unavailable', retryable: true })
    expect(String(error && 'message' in error ? error.message : '')).toContain('catch-up-incomplete')
    // 没有 replay（不能假装推进），follow 仍然活着（同节点上别的通道还在看）
    expect(frames.some((frame) => frame.type === 'replay')).toBe(false)
    expect(remote.isFollowing?.('s_a')).toBe(true)
    await remote.close()
  })
})

describe('park：会话快照（session-state 的数据源）', () => {
  it('running/attemptId/cursor 来自 follow 快照与事件，running 变化随 turn 事件走', async () => {
    const socket = new FakeSocket()
    const { remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.opensFor('session/follow')).toBe(1))
    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/follow'),
      value: {
        type: 'snapshot',
        cursor: 42,
        records: [],
        hasMore: false,
        projections: { values: {} },
        header: {},
        assistantStream: { revision: 2, activeAttempt: { attemptId: 's_a:1', nextIndex: 3, stream: [] } },
      },
    })
    await vi.waitFor(() => expect(remote.sessionState?.('s_a')).toMatchObject({ cursor: 42, running: true, attemptId: 's_a:1' }))
    expect(remote.runningSessions?.()).toContain('s_a')

    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/follow'),
      value: { type: 'event', event: { type: 'turn/end', seq: 43, time: 5, data: { turn: 2 } } },
    })
    await vi.waitFor(() => expect(remote.sessionState?.('s_a')).toMatchObject({ running: false, attemptId: null }))
    expect(remote.runningSessions?.() ?? []).toEqual([])
    await remote.close()
  })

  it('control baseline 给没订阅的会话也记下 continued 提问（列表角标靠它）', async () => {
    const socket = new FakeSocket()
    const { remote } = await parkRemote(socket)
    const frames: MobileServerFrame[] = []
    await remote.dispatch({ v: 1, type: 'subscribe', requestId: 's', sessionId: 's_a' }, await collect(frames))
    await vi.waitFor(() => expect(socket.sent.some((item) => item['endpoint'] === 'session/control')).toBe(true))
    socket.push({
      type: 'item',
      streamId: socket.streamFor('session/control'),
      value: {
        type: 'baseline',
        value: {
          projections: {
            s_b: {
              values: {
                userQuestions: {
                  active: [{ callId: 'call_cont', state: 'continued', questions: [{ id: 'q1', question: '还答吗？' }] }],
                  settled: [],
                },
              },
            },
          },
        },
      },
    })
    await vi.waitFor(() => expect(remote.pendingInteractions?.().get('s_b')).toBe(1))
    expect(remote.sessionState?.('s_b').questions).toMatchObject([{ callId: 'call_cont', state: 'continued' }])
    await remote.close()
  })
})
