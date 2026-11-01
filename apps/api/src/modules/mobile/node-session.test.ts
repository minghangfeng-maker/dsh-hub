import { describe, expect, it, vi } from 'vitest'
import type {
  MobileClientFrameAll,
  MobileServerFrameAll,
  MobileSessionRowV2,
  MobileV2Feature,
} from '@dsh-hub/shared'
import type { FrameSink, NodeCapabilities, NodeRemote, SessionRuntimeState } from '@dsh-hub/dsh-node-remote'
import type { WsConnection } from '../../lib/ws-upgrade.js'
import { IdempotencyStore, MobileChannel } from './channel.js'
import { NodeSession, NodeSessionRegistry } from './node-session.js'
import type { ChannelNode } from './types.js'

/**
 * WP46 / M6 §1–§2：Hub 侧常驻会话代理与会话快照。
 *
 * 这些用例钉的是**事故链被切断**这件事：手机通道断开（App 切后台）之后
 * - 提问/审批**不被 next**（adapter 的 close 都不该被调用）；
 * - 重连后 `session-state` 能把暂存的提问带回来，并且可以应答；
 * - 只有 linger / park 上限 / 容器停止 / 登出 / Hub 关闭才真关。
 */

const CAPS: NodeCapabilities = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: true,
  create: true,
}

const EMPTY_STATE: SessionRuntimeState = {
  cursor: null,
  running: false,
  attemptId: null,
  questions: [],
  approvals: [],
}

/** 假 adapter：可以被测试直接改状态、直接推帧，并记录被下发的客户端帧。 */
class FakeRemote implements NodeRemote {
  readonly capabilities = CAPS
  readonly compatible = true
  readonly missing: readonly string[] = []
  readonly node = { id: 'cloud:self', kind: 'cloud' as const, name: '云实例', status: 'running' }
  readonly dispatched: MobileClientFrameAll[] = []
  readonly states = new Map<string, SessionRuntimeState>()
  /** 正在跟随的会话（subscribe/unsubscribe 会改它，`isFollowing` 读它）。 */
  readonly followed = new Set<string>()
  /** `catchUpFor` 的注入行为：默认一个都不补（'ok'）。 */
  catchUpMessages: Array<{ sessionId: string; seq: number; text: string }> = []
  catchUpOutcome: 'ok' | 'gap' = 'ok'
  catchUpFrom: number | null = null
  readonly baselines = new Map<string, ReturnType<NonNullable<NodeRemote['sessionBaseline']>>>()
  readonly projections = new Map<string, Array<{ key: string; value: unknown }>>()
  closed: string | null = null
  closeCount = 0
  private sink: FrameSink | null = null

  async dispatch(frame: MobileClientFrameAll, sink: FrameSink): Promise<void> {
    this.sink = sink
    this.dispatched.push(frame)
    if (frame.type === 'subscribe') this.followed.add(frame.sessionId)
    if (frame.type === 'unsubscribe') this.followed.delete(frame.sessionId)
  }

  isFollowing(sessionId: string): boolean {
    return this.followed.has(sessionId)
  }

  sessionBaseline(sessionId: string): ReturnType<NonNullable<NodeRemote['sessionBaseline']>> {
    return this.baselines.get(sessionId) ?? null
  }

  sessionProjections(sessionId: string): ReadonlyArray<{ key: string; value: unknown }> {
    return this.projections.get(sessionId) ?? []
  }

  async catchUpFor(
    sessionId: string,
    sinceCursor: number | null,
    emit: (frame: never) => void | Promise<void>,
  ): Promise<'ok' | 'gap'> {
    this.catchUpFrom = sinceCursor
    if (this.catchUpOutcome === 'gap') return 'gap'
    for (const message of this.catchUpMessages) {
      await emit({
        v: 1,
        type: 'message',
        sessionId,
        seq: message.seq,
        role: 'assistant',
        at: 1,
        text: message.text,
      } as never)
    }
    return 'ok'
  }

  async close(): Promise<void> {
    this.closeCount += 1
    this.closed = 'closed'
  }

  sessionState(sessionId: string): SessionRuntimeState {
    return this.states.get(sessionId) ?? EMPTY_STATE
  }

  pendingInteractions(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>()
    for (const [sessionId, state] of this.states) {
      const total = state.questions.length + state.approvals.length
      if (total > 0) counts.set(sessionId, total)
    }
    return counts
  }

  runningSessions(): readonly string[] {
    return [...this.states].filter(([, state]) => state.running).map(([sessionId]) => sessionId)
  }

  /** 测试用：把一帧推给 NodeSession（模拟 adapter 的异步帧）。 */
  emit(frame: MobileServerFrameAll): void {
    void this.sink?.(frame as never)
  }

  /** 测试用：设置某个会话的快照状态。 */
  setState(sessionId: string, patch: Partial<SessionRuntimeState>): void {
    this.states.set(sessionId, { ...(this.states.get(sessionId) ?? EMPTY_STATE), ...patch })
  }

  /** 测试用：下发的客户端帧里最后一次某类型。 */
  lastOf(type: MobileClientFrameAll['type']): MobileClientFrameAll | undefined {
    return this.dispatched.filter((frame) => frame.type === type).at(-1)
  }

  /**
   * 测试用：某类型最后一次收到的**内部** requestId —— 回包必须原样带回它，
   * NodeSession 才能把回包路由回发起通道（真实 adapter 的行为就是这么简单）。
   */
  lastRequestId(type: MobileClientFrameAll['type']): string | undefined {
    for (let index = this.dispatched.length - 1; index >= 0; index -= 1) {
      const frame = this.dispatched[index]
      if (frame === undefined || frame.type !== type) continue
      const value = (frame as { requestId?: unknown }).requestId
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  }
}

function questionState(overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  return {
    cursor: 9,
    running: false,
    attemptId: null,
    questions: [
      {
        agent: 's_a',
        callId: 'call_q',
        questions: [{ id: 'q1', question: '按哪个方案继续？' }],
        state: 'open',
      },
    ],
    approvals: [],
    ...overrides,
  }
}

interface Harness {
  session: NodeSession
  remote: FakeRemote
  frames: MobileServerFrameAll[]
}

function harness(options: { lingerMs?: number; parkMs?: number } = {}): Harness {
  const remote = new FakeRemote()
  const frames: MobileServerFrameAll[] = []
  const session = new NodeSession({
    userId: 1,
    nodeId: 'cloud:self',
    remote,
    lingerMs: options.lingerMs ?? 60_000,
    parkMs: options.parkMs ?? 60_000,
    log: () => undefined,
  })
  session.attach('c1', (frame) => frames.push(frame))
  return { session, remote, frames }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

type HelloFrame = Extract<MobileClientFrameAll, { type: 'hello' }>

const HELLO: HelloFrame = {
  v: 1,
  type: 'hello',
  requestId: 'h1',
  client: { name: 'app', version: '0.3.0' },
  features: ['models', 'files', 'session-state'],
}

async function helloAndSubscribe(
  session: NodeSession,
  remote: FakeRemote,
  channelId = 'c1',
  sinceCursor: number | null = 3,
): Promise<void> {
  await session.dispatch(channelId, HELLO)
  // adapter 的 hello 回显（NodeSession 会按该通道声明的特性过滤 + 换成本通道的 subscribed）
  remote.emit({
    v: 1,
    type: 'hello',
    requestId: String(remote.lastRequestId('hello')),
    node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
    capabilities: CAPS,
    subscribed: [],
    serverTime: 1,
    features: ['models', 'files', 'session-state'],
  })
  await session.dispatch(channelId, { v: 1, type: 'subscribe', requestId: 'sub1', sessionId: 's_a', sinceCursor })
  // adapter 的 replay 边界帧（M6 §2.2.1：它之后立刻发一份 session-state）
  remote.emit({ v: 1, type: 'replay', sessionId: 's_a', fromCursor: sinceCursor, toCursor: 9 })
}

describe('NodeSession：通道断开不再 next（M6 §1）', () => {
  it('detach 不关 adapter；重连后 session-state 带回暂存提问，且可以应答', async () => {
    const { session, remote, frames } = harness()
    remote.setState('s_a', questionState())
    await helloAndSubscribe(session, remote)
    const stateAfterSubscribe = frames.filter((frame) => frame.type === 'session-state')
    expect(stateAfterSubscribe).toHaveLength(1)
    expect(stateAfterSubscribe[0]).toMatchObject({
      sessionId: 's_a',
      cursor: 9,
      questions: [{ agent: 's_a', callId: 'call_q', state: 'open' }],
    })

    // App 切后台：通道断开 → 只是 detach
    session.detach('c1')
    await flush()
    expect(remote.closeCount).toBe(0)
    expect(session.isClosed).toBe(false)

    // 60 秒后重连：新通道 hello + subscribe，replay 之后拿到含该提问的快照
    frames.length = 0
    session.attach('c2', (frame) => frames.push(frame))
    await session.dispatch('c2', { ...HELLO, requestId: 'h2' })
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 2,
      features: ['models', 'files', 'session-state'],
    })
    await session.dispatch('c2', { v: 1, type: 'subscribe', requestId: 'sub2', sessionId: 's_a', sinceCursor: 3 })
    // 这条会话的 follow 还在（有未决提问、NodeSession 没关）→ 重连走「加入」：
    // NodeSession 自己补 replay + session-state，**不再向 adapter 发第二次 subscribe**，
    // 也不会拆掉这条流（否则另一台还连着的设备会跟着哑掉）。
    expect(remote.dispatched.filter((frame) => frame.type === 'subscribe')).toHaveLength(1)
    expect(frames.some((frame) => frame.type === 'replay')).toBe(true)
    const replayed = frames.filter((frame) => frame.type === 'session-state')
    expect(replayed.length).toBeGreaterThanOrEqual(1)
    expect(replayed.at(-1)).toMatchObject({ sessionId: 's_a', questions: [{ callId: 'call_q' }] })

    // 应答：帧被原样下发给 adapter，结算后的快照不再带这个问题
    remote.setState('s_a', questionState({ questions: [] }))
    await session.dispatch('c2', {
      v: 1,
      type: 'answer-question',
      requestId: 'a1',
      sessionId: 's_a',
      agent: 's_a',
      callId: 'call_q',
      answers: [{ id: 'q1', selected: ['方案A'] }],
    })
    expect(remote.lastOf('answer-question')).toMatchObject({ callId: 'call_q' })
    expect(remote.closeCount).toBe(0)
  })

  it('没有未决交互时，最后一条通道断开后 linger 到点才关闭', async () => {
    vi.useRealTimers()
    const { session, remote } = harness({ lingerMs: 40, parkMs: 5_000 })
    await helloAndSubscribe(session, remote)
    session.detach('c1')
    await vi.waitFor(() => expect(session.isClosed).toBe(true), { timeout: 2_000 })
    expect(remote.closeCount).toBe(1)
  })

  it('有未决交互时跨过 linger 也不关，到 park 上限才关（= next 回 Host）', async () => {
    const { session, remote } = harness({ lingerMs: 30, parkMs: 200 })
    remote.setState('s_a', questionState())
    await helloAndSubscribe(session, remote)
    session.detach('c1')
    // 越过 linger 仍然活着
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(session.isClosed).toBe(false)
    expect(remote.closeCount).toBe(0)
    // park 上限到点：关闭（adapter 的 close 会 next）
    await vi.waitFor(() => expect(session.isClosed).toBe(true), { timeout: 2_000 })
    expect(remote.closeCount).toBe(1)
  })
})

describe('NodeSession：会话快照（M6 §2.2）', () => {
  it('running 变化 / 未决集合变化 / session-state-request 都要发快照', async () => {
    const { session, remote, frames } = harness()
    remote.setState('s_a', { cursor: 3, running: true, attemptId: 's_a:1' })
    await helloAndSubscribe(session, remote)
    expect(frames.filter((frame) => frame.type === 'session-state')).toHaveLength(1)
    expect(frames.at(-1)).toMatchObject({ type: 'session-state', running: true, attemptId: 's_a:1' })

    // 回合结束：running 变化 → 再发一份
    remote.setState('s_a', { running: false, attemptId: null })
    remote.emit({ v: 1, type: 'turn', sessionId: 's_a', phase: 'end', turn: 1 })
    await flush()
    expect(frames.at(-1)).toMatchObject({ type: 'session-state', running: false, attemptId: null })

    // 未决提问出现 → 发一份（含该问题）
    remote.setState('s_a', questionState({ cursor: 9 }))
    remote.emit({
      v: 1,
      type: 'question',
      sessionId: 's_a',
      agent: 's_a',
      callId: 'call_q',
      questions: [{ id: 'q1', question: '按哪个方案继续？' }],
      state: 'open',
    })
    await flush()
    expect(frames.at(-1)).toMatchObject({
      type: 'session-state',
      questions: [{ callId: 'call_q' }],
    })

    // 幂等读：带 requestId 回包（M6 §2.2.4）
    frames.length = 0
    await session.dispatch('c1', {
      v: 1,
      type: 'session-state-request',
      requestId: 'r-state',
      sessionId: 's_a',
    })
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'session-state', requestId: 'r-state', sessionId: 's_a' })
  })

  it('老客户端（没声明 features）不发 session-state，帧流与现在一致', async () => {
    const { session, remote, frames } = harness()
    remote.setState('s_a', questionState())
    await session.dispatch('c1', { v: 1, type: 'hello', requestId: 'h1', client: { name: 'app', version: '0.2.16' } })
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 1,
      // 同一节点上还有新客户端时，adapter 可能回显特性；老通道必须拿不到
      features: ['models', 'session-state'],
      capabilitiesV2: { models: true },
    })
    await session.dispatch('c1', { v: 1, type: 'subscribe', requestId: 'sub1', sessionId: 's_a' })
    remote.emit({ v: 1, type: 'replay', sessionId: 's_a', fromCursor: null, toCursor: 9 })
    await flush()
    expect(frames.some((frame) => frame.type === 'session-state')).toBe(false)
    const hello = frames.find((frame) => frame.type === 'hello') as Record<string, unknown>
    expect('features' in hello).toBe(false)
    expect('capabilitiesV2' in hello).toBe(false)
    // 老客户端没声明 features：下发给 adapter 的 hello 也不带 features（不主动开 v2）；
    // requestId 已被改写成内部 id（回包时再改回 h1）
    const toAdapter = remote.lastOf('hello') as unknown as Record<string, unknown>
    expect(toAdapter).toEqual({
      v: 1,
      type: 'hello',
      requestId: toAdapter['requestId'],
      client: { name: 'app', version: '0.2.16' },
    })
    expect(String(toAdapter['requestId']).endsWith(':h1')).toBe(true)
    expect(hello['requestId']).toBe('h1')
  })

  it('hello 的 subscribed 是**本通道**订阅，特性求并集下发给 adapter', async () => {
    const { session, remote, frames } = harness()
    await helloAndSubscribe(session, remote, 'c1')
    session.attach('c2', (frame) => frames.push(frame))
    await session.dispatch('c2', {
      v: 1,
      type: 'hello',
      requestId: 'h2',
      client: { name: 'app', version: '0.3.0' },
      features: ['usage'],
    })
    // 并集：c1 的 models/files/session-state + c2 的 usage
    const helloToAdapter = remote.lastOf('hello') as { requestId: string; features: string[] }
    expect(helloToAdapter.features).toEqual(['models', 'files', 'session-state', 'usage'])
    // 内部 id：通道序号 + 原 id（回包时才还原成 h2）
    expect(helloToAdapter.requestId).not.toBe('h2')
    expect(helloToAdapter.requestId.endsWith(':h2')).toBe(true)
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: ['s_a', 's_other'],
      serverTime: 3,
      features: ['models', 'files', 'session-state', 'usage'],
    })
    await flush()
    const hello = frames.filter((frame) => frame.type === 'hello').at(-1)
    expect(hello).toMatchObject({ requestId: 'h2', subscribed: [], features: ['usage'] })
  })
})

describe('NodeSession：会话列表的待回答角标（M6 §2.4）', () => {
  const rows: MobileSessionRowV2[] = [
    { sessionId: 's_a', title: 'A', updatedAt: 2, running: false, blank: false, agentAvailable: true },
    { sessionId: 's_b', title: 'B', updatedAt: 1, running: true, blank: false, agentAvailable: true },
  ]

  it('协商了 session-state 才带 pendingInteractions', async () => {
    const { session, remote, frames } = harness()
    remote.setState('s_b', questionState())
    await helloAndSubscribe(session, remote)
    frames.length = 0
    await session.dispatch('c1', { v: 1, type: 'sessions', requestId: 'list1' })
    remote.emit({ v: 1, type: 'sessions', requestId: String(remote.lastRequestId('sessions')), items: rows })
    await flush()
    const list = frames.find((frame) => frame.type === 'sessions')
    expect(list).toMatchObject({ type: 'sessions' })
    if (list?.type !== 'sessions') throw new Error('期望 sessions')
    expect(list.items.find((item) => item.sessionId === 's_b')).toMatchObject({ pendingInteractions: 1 })
    expect(list.items.find((item) => item.sessionId === 's_a')?.pendingInteractions).toBeUndefined()
  })

  it('老客户端（未协商）的列表帧不加字段', async () => {
    const { session, remote, frames } = harness()
    remote.setState('s_b', questionState())
    await session.dispatch('c1', { v: 1, type: 'hello', requestId: 'h1', client: { name: 'app', version: '0.2.16' } })
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 1,
    })
    frames.length = 0
    await session.dispatch('c1', { v: 1, type: 'sessions', requestId: 'list1' })
    remote.emit({ v: 1, type: 'sessions', requestId: String(remote.lastRequestId('sessions')), items: rows })
    await flush()
    const list = frames.find((frame) => frame.type === 'sessions')
    if (list?.type !== 'sessions') throw new Error('期望 sessions')
    expect(list.items.every((item) => item.pendingInteractions === undefined)).toBe(true)
  })
})

describe('NodeSession：多通道共享一个 adapter', () => {
  it('请求回包只回发起者；会话帧发给所有订阅者', async () => {
    const { session, remote, frames } = harness()
    await helloAndSubscribe(session, remote, 'c1')
    const frames2: MobileServerFrameAll[] = []
    session.attach('c2', (frame) => frames2.push(frame))
    await session.dispatch('c2', { ...HELLO, requestId: 'h2' })
    await session.dispatch('c2', { v: 1, type: 'subscribe', requestId: 'sub2', sessionId: 's_a' })
    frames.length = 0
    frames2.length = 0

    // c2 发的 send：ack 只回 c2
    await session.dispatch('c2', {
      v: 1,
      type: 'send',
      requestId: 'send-2',
      sessionId: 's_a',
      text: '你好',
      clientMessageId: 'm2',
    })
    remote.emit({ v: 1, type: 'ack', requestId: String(remote.lastRequestId('send')), clientMessageId: 'm2' })
    await flush()
    expect(frames.some((frame) => frame.type === 'ack')).toBe(false)
    expect(frames2.some((frame) => frame.type === 'ack')).toBe(true)

    // 会话增量帧（delta）：两个订阅者都收到
    remote.emit({
      v: 1,
      type: 'delta',
      sessionId: 's_a',
      attemptId: 's_a:1',
      revision: 1,
      index: 0,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: '嗯' },
    })
    await flush()
    expect(frames.some((frame) => frame.type === 'delta')).toBe(true)
    expect(frames2.some((frame) => frame.type === 'delta')).toBe(true)
    expect(remote.dispatched.filter((frame) => frame.type === 'hello')).toHaveLength(2)
  })

  it('未订阅的通道收不到该会话的增量帧', async () => {
    const { session, remote, frames } = harness()
    await helloAndSubscribe(session, remote, 'c1')
    const frames2: MobileServerFrameAll[] = []
    session.attach('c2', (frame) => frames2.push(frame))
    frames.length = 0
    remote.emit({ v: 1, type: 'replay', sessionId: 's_b', fromCursor: null, toCursor: 1 })
    await flush()
    // s_b 没人订阅 → 谁都不该收到
    expect(frames.some((frame) => frame.type === 'replay')).toBe(false)
    expect(frames2.some((frame) => frame.type === 'replay')).toBe(false)
    // s_a 的订阅者照常收到
    remote.emit({ v: 1, type: 'replay', sessionId: 's_a', fromCursor: null, toCursor: 1 })
    await flush()
    expect(frames.some((frame) => frame.type === 'replay')).toBe(true)
    expect(frames2.some((frame) => frame.type === 'replay')).toBe(false)
  })
})

describe('NodeSession：关闭时通知还挂着的通道', () => {
  it('容器停止 → 先给通道发关闭通知（服务层据此发 bye），再关 adapter', async () => {
    const remote = new FakeRemote()
    const closed: Array<{ channelId: string; reason: string }> = []
    const session = new NodeSession({
      userId: 1,
      nodeId: 'cloud:self',
      remote,
      lingerMs: 60_000,
      parkMs: 60_000,
      log: () => undefined,
      onChannelClosed: (channelId, reason) => closed.push({ channelId, reason }),
    })
    session.attach('c1', () => undefined)
    session.attach('c2', () => undefined)
    await session.close('instance-stopped')
    expect(closed.map((item) => item.reason)).toEqual(['instance-stopped', 'instance-stopped'])
    expect(closed.map((item) => item.channelId).sort()).toEqual(['c1', 'c2'])
    expect(remote.closeCount).toBe(1)
    expect(session.isClosed).toBe(true)
  })
})

describe('NodeSessionRegistry：容器停止 / 登出 / Hub 关闭 → 立即关闭', () => {
  function registry(): { registry: NodeSessionRegistry; remotes: FakeRemote[] } {
    const remotes: FakeRemote[] = []
    const registry = new NodeSessionRegistry({
      lingerMs: 60_000,
      parkMs: 60_000,
      log: () => undefined,
    })
    return { registry, remotes }
  }

  it('并发首连只建一个 adapter；同一个 (userId,nodeId) 复用', async () => {
    const { registry: table } = registry()
    let opened = 0
    const remote = new FakeRemote()
    const open = async (): Promise<NodeRemote> => {
      opened += 1
      await new Promise((resolve) => setImmediate(resolve))
      return remote
    }
    const [a, b] = await Promise.all([
      table.ensure(1, 'cloud:self', open),
      table.ensure(1, 'cloud:self', open),
    ])
    expect(opened).toBe(1)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(await table.ensure(1, 'cloud:self', open)).toBe(a)
    // 不同用户是不同的会话
    const other = await table.ensure(2, 'cloud:self', open)
    expect(other).not.toBe(a)
  })

  it('open 返回 null（容器没在跑）→ 不建会话', async () => {
    const { registry: table } = registry()
    expect(await table.ensure(1, 'cloud:self', async () => null)).toBeNull()
    expect(table.list()).toHaveLength(0)
  })

  it('closeUser 把「通道关闭通知」透传给会话（登出/停容器时手机能立刻收到 bye）', async () => {
    const closed: string[] = []
    const table = new NodeSessionRegistry({
      lingerMs: 60_000,
      parkMs: 60_000,
      log: () => undefined,
      onChannelClosed: (channelId, reason) => closed.push(`${channelId}:${reason}`),
    })
    const remote = new FakeRemote()
    const session = await table.ensure(1, 'cloud:self', async () => remote)
    session?.attach('c9', () => undefined)
    await table.closeUser(1, 'device-revoked')
    expect(closed).toEqual(['c9:device-revoked'])
    expect(remote.closeCount).toBe(1)
  })

  it('closeUser 只关这个用户的会话（= next 回 Host），closeAll 全关', async () => {
    const { registry: table } = registry()
    const remoteA = new FakeRemote()
    const remoteB = new FakeRemote()
    await table.ensure(1, 'cloud:self', async () => remoteA)
    await table.ensure(2, 'cloud:self', async () => remoteB)
    await table.closeUser(1, 'instance-stopped')
    expect(remoteA.closeCount).toBe(1)
    expect(remoteB.closeCount).toBe(0)
    await table.closeAll('shutdown')
    expect(remoteB.closeCount).toBe(1)
    expect(table.list()).toHaveLength(0)
  })
})

describe('NodeSession：一条 follow 服务多条通道（WP46 返工）', () => {
  /** c1、c2 都挂到同一个 NodeSession；c2 走「加入已有 follow」路径。 */
  async function twoChannels(): Promise<{
    session: NodeSession
    remote: FakeRemote
    frames: MobileServerFrameAll[]
    frames2: MobileServerFrameAll[]
    hello2Mark: number
  }> {
    const { session, remote, frames } = harness()
    remote.setState('s_a', { cursor: 9 })
    await helloAndSubscribe(session, remote, 'c1', 2)
    await flush()
    frames.length = 0
    const frames2: MobileServerFrameAll[] = []
    session.attach('c2', (frame) => frames2.push(frame))
    await session.dispatch('c2', { ...HELLO, requestId: 'h1' })
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 2,
      features: ['models', 'files', 'session-state'],
    })
    await session.dispatch('c2', { v: 1, type: 'subscribe', requestId: 'a1', sessionId: 's_a', sinceCursor: 2 })
    await flush()
    return { session, remote, frames, frames2, hello2Mark: frames2.length }
  }

  it('两条通道用同一个 requestId 并发 history：各收各的回包，内部 id 互不覆盖', async () => {
    const { session, remote, frames, frames2 } = await twoChannels()
    frames.length = 0
    frames2.length = 0
    // App 的 requestId 是每台设备从 a1 起的：两台设备同时发 a1
    await Promise.all([
      session.dispatch('c1', { v: 1, type: 'history', requestId: 'a1', sessionId: 's_a', limit: 5 }),
      session.dispatch('c2', { v: 1, type: 'history', requestId: 'a1', sessionId: 's_a', limit: 9 }),
    ])
    const wireIds = remote.dispatched
      .filter((frame) => frame.type === 'history')
      .map((frame) => String((frame as { requestId?: unknown }).requestId))
    expect(wireIds).toHaveLength(2)
    // adapter 看到的是两个不同的 id（否则它的回包只能定向到一个通道）
    expect(new Set(wireIds).size).toBe(2)
    // 回包带的是内部 id；NodeSession 必须改回 a1 并各回各家
    remote.emit({
      v: 1,
      type: 'history',
      requestId: wireIds[0]!,
      sessionId: 's_a',
      items: [],
      nextBeforeSeq: null,
      cursor: 1,
      hasMore: false,
    })
    remote.emit({
      v: 1,
      type: 'history',
      requestId: wireIds[1]!,
      sessionId: 's_a',
      items: [],
      nextBeforeSeq: null,
      cursor: 9,
      hasMore: false,
    })
    await flush()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'history', requestId: 'a1', cursor: 1 })
    expect(frames2).toHaveLength(1)
    expect(frames2[0]).toMatchObject({ type: 'history', requestId: 'a1', cursor: 9 })
  })

  it('两条通道用同一个 requestId 并发 file-read：文件帧也只回发起的那条通道', async () => {
    const { session, remote, frames, frames2 } = await twoChannels()
    frames.length = 0
    frames2.length = 0
    await Promise.all([
      session.dispatch('c1', { v: 1, type: 'file-read', requestId: 'a7', sessionId: 's_a', path: 'a.txt' }),
      session.dispatch('c2', { v: 1, type: 'file-read', requestId: 'a7', sessionId: 's_a', path: 'b.txt' }),
    ])
    const wireIds = remote.dispatched
      .filter((frame) => frame.type === 'file-read')
      .map((frame) => String((frame as { requestId?: unknown }).requestId))
    expect(new Set(wireIds).size).toBe(2)
    const fileFrame = (requestId: string, name: string) => ({
      v: 1 as const,
      type: 'file' as const,
      requestId,
      sessionId: 's_a',
      fileRef: `ref:${name}`,
      name,
      mediaType: 'file' as const,
      mimeType: 'text/plain',
      bytes: 3,
      encoding: 'base64' as const,
      data: 'YWJj',
    })
    remote.emit(fileFrame(wireIds[0]!, 'a.txt'))
    remote.emit(fileFrame(wireIds[1]!, 'b.txt'))
    await flush()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'file', requestId: 'a7', name: 'a.txt' })
    expect(frames2).toHaveLength(1)
    expect(frames2[0]).toMatchObject({ type: 'file', requestId: 'a7', name: 'b.txt' })
  })

  it('A unsubscribe 不下发 adapter.unsubscribe，B 继续收增量；最后一个订阅者才拆 follow', async () => {
    const { session, remote, frames, frames2 } = await twoChannels()
    frames.length = 0
    frames2.length = 0
    const before = remote.dispatched.filter((frame) => frame.type === 'unsubscribe').length
    await session.dispatch('c1', { v: 1, type: 'unsubscribe', sessionId: 's_a' })
    await flush()
    expect(remote.dispatched.filter((frame) => frame.type === 'unsubscribe')).toHaveLength(before)
    remote.emit({
      v: 1,
      type: 'delta',
      sessionId: 's_a',
      attemptId: 's_a:1',
      revision: 1,
      index: 0,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: '还在跑' },
    })
    await flush()
    expect(frames.some((frame) => frame.type === 'delta')).toBe(false)
    expect(frames2.some((frame) => frame.type === 'delta')).toBe(true)
    // 最后一个订阅者取消、且会话不忙 → 这时才真的把 follow 交回 adapter
    await session.dispatch('c2', { v: 1, type: 'unsubscribe', sessionId: 's_a' })
    await flush()
    expect(remote.dispatched.filter((frame) => frame.type === 'unsubscribe')).toHaveLength(before + 1)
  })

  it('加入者拿到的补发顺序：catch-up message → replay → 基线 → 投影 → 快照（只发给它）', async () => {
    const { session, remote, frames, frames2, hello2Mark } = await twoChannels()
    // twoChannels 里 c2 已经加入过一次；这里重置，测完整序列
    remote.catchUpMessages = [{ sessionId: 's_a', seq: 5, text: '补一条' }]
    remote.baselines.set('s_a', {
      v: 1,
      type: 'assistant-baseline',
      sessionId: 's_a',
      attemptId: 's_a:1',
      revision: 1,
      nextIndex: 3,
      text: '前半段',
    })
    remote.projections.set('s_a', [{ key: 'title', value: '会话 A' }])
    frames.length = 0
    const mark = frames2.length
    void hello2Mark
    await session.dispatch('c2', { v: 1, type: 'subscribe', requestId: 'a2', sessionId: 's_a', sinceCursor: 2 })
    await flush()
    // 只有最早那次（c1 建 follow）的 subscribe 到达 adapter：加入不重建
    expect(remote.dispatched.filter((frame) => frame.type === 'subscribe')).toHaveLength(1)
    // 已订阅的 c1 一个字节都没收到（它的 onReplay 会清空瞬态状态）
    expect(frames).toHaveLength(0)
    expect(frames2.slice(mark).map((frame) => frame.type)).toEqual([
      'message',
      'replay',
      'assistant-baseline',
      'state',
      'session-state',
    ])
    expect(frames2[mark]).toMatchObject({ type: 'message', seq: 5, sessionId: 's_a' })
    expect(frames2[mark + 1]).toMatchObject({ type: 'replay', fromCursor: 2, toCursor: 9 })
    expect(frames2[mark + 2]).toMatchObject({ type: 'assistant-baseline', attemptId: 's_a:1' })
    expect(frames2[mark + 3]).toMatchObject({ type: 'state', key: 'title', value: '会话 A' })
    expect(frames2[mark + 4]).toMatchObject({ type: 'session-state', sessionId: 's_a', cursor: 9 })
  })

  it('加入者追不上（catch-up gap）：错误只回它、带它自己的 requestId，共享 follow 不拆', async () => {
    const { session, remote, frames, frames2, hello2Mark } = await twoChannels()
    remote.catchUpOutcome = 'gap'
    frames.length = 0
    const mark = frames2.length
    void hello2Mark
    await session.dispatch('c2', { v: 1, type: 'subscribe', requestId: 'a3', sessionId: 's_a', sinceCursor: 2 })
    await flush()
    const errors = frames2.slice(mark).filter((frame) => frame.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'upstream-unavailable', requestId: 'a3' })
    expect(frames).toHaveLength(0)
    expect(remote.dispatched.filter((frame) => frame.type === 'unsubscribe')).toHaveLength(0)
    // 这个加入者被撤掉订阅（没有 replay 边界就不该继续收实时帧），但共享 follow 还在：
    // 已订阅的 c1 照常收增量，c2 不再收到
    remote.emit({
      v: 1,
      type: 'delta',
      sessionId: 's_a',
      attemptId: 's_a:1',
      revision: 1,
      index: 1,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: '继续' },
    })
    await flush()
    expect(frames.some((frame) => frame.type === 'delta')).toBe(true)
    expect(frames2.some((frame) => frame.type === 'delta')).toBe(false)
  })

  it('认不出归属的内部 requestId 绝不下发给客户端', async () => {
    const { session, remote, frames } = harness()
    await helloAndSubscribe(session, remote, 'c1')
    frames.length = 0
    // 模拟「已过期的内部 id」：NodeSession 认不出来，只能当广播帧，并且必须剥掉 id
    remote.emit({ v: 1, type: 'error', requestId: 'c99:stale', code: 'internal', message: 'x', retryable: false })
    await flush()
    const error = frames.find((frame) => frame.type === 'error') as Record<string, unknown> | undefined
    expect(error).toBeDefined()
    expect('requestId' in (error ?? {})).toBe(false)
    void session
  })
})

// ── 通道接线（真实 MobileChannel + NodeSession） ────────────────────────────

class FakeWs implements WsConnection {
  readonly sent: string[] = []
  closed = false
  lastActivityAt = Date.now()
  remoteAddress = '127.0.0.1'
  private textListeners: Array<(text: string) => void> = []
  private closeListeners: Array<(code: number, reason: string) => void> = []

  send(text: string): void {
    this.sent.push(text)
  }
  ping(): void {}
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener(code, reason)
  }
  onText(listener: (text: string) => void): void {
    this.textListeners.push(listener)
  }
  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListeners.push(listener)
  }
  receive(frame: unknown): void {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
    for (const listener of this.textListeners) listener(text)
  }
  frames(): MobileServerFrameAll[] {
    return this.sent.map((text) => JSON.parse(text) as MobileServerFrameAll)
  }
}

function channelWith(
  session: NodeSession,
  ws: FakeWs,
  onDispose?: (id: string) => void,
  audits?: Array<{ action: string; detail: Record<string, unknown> }>,
): MobileChannel {
  const node: ChannelNode = { kind: 'session', session }
  return new MobileChannel(
    ws,
    {
      userId: 1,
      nodeId: 'cloud:self',
      node,
      validateSession: () => ({ id: 1 }),
      audit: (action, detail) => {
        audits?.push({ action, detail: detail ?? {} })
      },
    },
    new IdempotencyStore(),
    () => undefined,
    onDispose ?? (() => undefined),
  )
}

describe('通道 + NodeSession：断开只是 detach', () => {
  it('通道 dispose 不会关 adapter；重连的新通道拿到带提问的 session-state 并能回答', async () => {
    const remote = new FakeRemote()
    const session = new NodeSession({
      userId: 1,
      nodeId: 'cloud:self',
      remote,
      lingerMs: 60_000,
      parkMs: 60_000,
      log: () => undefined,
    })
    remote.setState('s_a', questionState())

    const first = new FakeWs()
    const channel1 = channelWith(session, first)
    await channel1.start()
    first.receive(HELLO)
    await flush()
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 1,
      features: ['models', 'files', 'session-state'],
    })
    await flush()
    first.receive({ v: 1, type: 'subscribe', requestId: 'sub1', sessionId: 's_a' })
    await flush()
    remote.emit({ v: 1, type: 'replay', sessionId: 's_a', fromCursor: null, toCursor: 9 })
    await flush()
    expect(first.frames().some((frame) => frame.type === 'session-state')).toBe(true)

    // App 切后台：socket 关闭 → 通道 dispose → 只 detach
    first.close()
    await flush()
    expect(remote.closeCount).toBe(0)
    expect(session.isClosed).toBe(false)

    // 重连：新通道 + 新 socket
    const second = new FakeWs()
    const channel2 = channelWith(session, second)
    await channel2.start()
    second.receive({ ...HELLO, requestId: 'h2' })
    await flush()
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 2,
      features: ['models', 'files', 'session-state'],
    })
    await flush()
    second.receive({ v: 1, type: 'subscribe', requestId: 'sub2', sessionId: 's_a', sinceCursor: 3 })
    await flush()
    remote.emit({ v: 1, type: 'replay', sessionId: 's_a', fromCursor: 3, toCursor: 9 })
    await flush()
    const state = second.frames().find((frame) => frame.type === 'session-state')
    expect(state).toMatchObject({ sessionId: 's_a', questions: [{ callId: 'call_q' }] })

    // 回答：帧经通道 → NodeSession → adapter（requestId 已记账，回包会回到这条通道）
    second.receive({
      v: 1,
      type: 'answer-question',
      requestId: 'ans1',
      sessionId: 's_a',
      agent: 's_a',
      callId: 'call_q',
      answers: [{ id: 'q1', selected: ['方案A'] }],
    })
    await flush()
    const answered = remote.lastOf('answer-question') as { requestId: string; callId: string }
    expect(answered.callId).toBe('call_q')
    expect(answered.requestId).not.toBe('ans1')
    expect(answered.requestId.endsWith(':ans1')).toBe(true)
    remote.setState('s_a', { questions: [] })
    remote.emit({
      v: 1,
      type: 'answer-result',
      requestId: String(remote.lastRequestId('answer-question')),
      sessionId: 's_a',
      accepted: true,
      continued: false,
    })
    await flush()
    expect(second.frames().some((frame) => frame.type === 'answer-result')).toBe(true)
    expect(first.frames().some((frame) => frame.type === 'answer-result')).toBe(false)
    await channel2.dispose('test')
    await session.close('test')
  })
})

// ── WP48：hello 审计记的是「该通道实际回显的集合」 ──────────────────────────

describe('通道 + NodeSession：WP48 的通道级语义', () => {
  /** 起一条通道并走完 hello（adapter 回显 `enabled`），返回它自己的审计记录。 */
  async function helloSide(
    session: NodeSession,
    remote: FakeRemote,
    options: { requestId: string; features?: MobileV2Feature[]; echo: MobileV2Feature[] },
  ): Promise<{ ws: FakeWs; channel: MobileChannel; audits: Array<{ action: string; detail: Record<string, unknown> }> }> {
    const ws = new FakeWs()
    const audits: Array<{ action: string; detail: Record<string, unknown> }> = []
    const channel = channelWith(session, ws, undefined, audits)
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: options.requestId,
      client: { name: 'dsh-hub-app', version: '0.2.17' },
      ...(options.features === undefined ? {} : { features: options.features }),
    })
    await flush()
    remote.emit({
      v: 1,
      type: 'hello',
      requestId: String(remote.lastRequestId('hello')),
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 1,
      features: options.echo,
    } as MobileServerFrameAll)
    await flush()
    return { ws, channel, audits }
  }

  it('同节点两条通道声明不同：审计各记各的 enabled（不是 adapter 的全集）', async () => {
    const remote = new FakeRemote()
    const session = new NodeSession({
      userId: 1,
      nodeId: 'cloud:self',
      remote,
      lingerMs: 60_000,
      parkMs: 60_000,
      log: () => undefined,
    })
    const echo: MobileV2Feature[] = ['models', 'files', 'session-state']
    const first = await helloSide(session, remote, {
      requestId: 'h1',
      features: ['models'],
      echo,
    })
    const second = await helloSide(session, remote, {
      requestId: 'h2',
      features: ['models', 'session-state'],
      echo,
    })
    const detailOf = (audits: Array<{ action: string; detail: Record<string, unknown> }>) =>
      audits.find((item) => item.action === 'mobile.hello')?.detail
    expect(detailOf(first.audits)).toMatchObject({
      declared: ['models'],
      enabled: ['models'],
      v2: true,
    })
    expect(detailOf(second.audits)).toMatchObject({
      declared: ['models', 'session-state'],
      enabled: ['models', 'session-state'],
      v2: true,
    })
    // 回显本身也是按通道过滤的（审计与客户端看到的一致）
    expect(first.ws.frames().find((frame) => frame.type === 'hello')).toMatchObject({
      features: ['models'],
    })
    await first.channel.dispose('test')
    await second.channel.dispose('test')
    await session.close('test')
  })

  it('P2 硬切：老客户端的 hello 不会被派发，NodeSession 上不会留下这条通道', async () => {
    process.env['HUB_MOBILE_REQUIRE_V2'] = '1'
    try {
      const remote = new FakeRemote()
      const session = new NodeSession({
        userId: 1,
        nodeId: 'cloud:self',
        remote,
        lingerMs: 60_000,
        parkMs: 60_000,
        log: () => undefined,
      })
      const ws = new FakeWs()
      const audits: Array<{ action: string; detail: Record<string, unknown> }> = []
      const channel = channelWith(session, ws, undefined, audits)
      await channel.start()
      ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'legacy', version: '0' } })
      await flush()
      expect(remote.dispatched).toHaveLength(0)
      expect(session.attachmentCount).toBe(0)
      expect(ws.frames().find((frame) => frame.type === 'error')).toMatchObject({
        code: 'protocol-version-unsupported',
      })
      expect(audits.some((item) => item.action === 'mobile.hello')).toBe(false)
      // 会话没被这条通道「激活」：它按 linger 自行收掉（下面单独测），这里手动关
      await session.close('test')
    } finally {
      delete process.env['HUB_MOBILE_REQUIRE_V2']
    }
  })

  it('建了会话但一条通道都没挂过：到 linger 就自行关闭，不泄漏 adapter', async () => {
    const remote = new FakeRemote()
    const session = new NodeSession({
      userId: 1,
      nodeId: 'cloud:self',
      remote,
      lingerMs: 40,
      parkMs: 5_000,
      log: () => undefined,
    })
    expect(session.attachmentCount).toBe(0)
    await vi.waitFor(() => expect(session.isClosed).toBe(true), { timeout: 2_000 })
    expect(remote.closeCount).toBe(1)
  })
})
