/**
 * `session-state` 快照（WP46 / M6 §2.3）。
 *
 * 为什么需要它（真机 2026-10-27 16:07）：0.2.15 的兜底是「断线就清提问卡」「重连后用会话
 * 列表的 running 校正回合」。这两条在 Hub 上线常驻会话代理之后都变成**错的**：
 * 代理会把未决提问/审批暂存住（通道断开不再回 next），重连后一份快照就能把它们带回来看/回答；
 * 而会话列表是「拉的时刻」的快照，拿它当权威位会把已经结束/开始的回合又翻回去。
 *
 * 这里锁住双方的行为：
 * - 协商了 `session-state`：快照整体替换 turnRunning/questions/approvals、running=false 收起
 *   停止按钮并清残留流式、断线**不清**卡片、会话列表 running 不再校正；
 * - 未协商（老 Hub）：0.2.15 的两条兜底原样保留。
 */

import { describe, expect, it } from 'vitest'
import {
  initialStreamState,
  reduceConversation,
  syncTurnRunning,
  type ConversationResult,
} from '../src/channel/conversation.js'
import { initialWorkspaceState, type WorkspaceState } from '../src/channel/workspace-state.js'
import type { AnyServerFrame } from '../src/channel/wire.js'
import {
  bootWithSessions,
  createHarness,
  helloFrame,
  openSession,
  sessionRow,
  sessionsFrame,
  sleep,
} from './helpers/fake-channel.js'

const SID = 's1'

// ── 纯 reducer ──────────────────────────────────────────────────────────────

interface Input {
  state: WorkspaceState
  stream: ReturnType<typeof initialStreamState>
}

function base(overrides: Partial<WorkspaceState> = {}): Input {
  return {
    state: {
      ...initialWorkspaceState('cloud:self'),
      link: 'connected',
      openSessionId: SID,
      features: ['session-state'],
      ...overrides,
    },
    stream: initialStreamState(),
  }
}

function reduce(input: Input, frame: unknown): ConversationResult {
  return reduceConversation(input, frame as AnyServerFrame, {})
}

function question(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'question',
    sessionId: SID,
    agent: SID,
    callId: 'call_1',
    state: 'open',
    questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }] }],
    ...overrides,
  }
}

function snapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'session-state',
    sessionId: SID,
    cursor: 12,
    running: false,
    attemptId: null,
    questions: [],
    approvals: [],
    at: '2026-10-27T21:00:00.000Z',
    ...overrides,
  }
}

function pendingQuestion(callId = 'call_snap', agent = SID): unknown {
  return {
    agent,
    callId,
    questions: [{ id: 'q1', question: '快照里的问题', options: [{ label: 'A' }] }],
    state: 'open',
  }
}

function pendingApproval(approvalId = 'ap_1'): unknown {
  return {
    sessionId: SID,
    callId: 'call_ap',
    approvalId,
    tool: 'bash',
    reason: '想执行命令',
    answerable: true,
    actions: ['approve', 'reject'],
    state: 'open',
  }
}

describe('reducer：session-state 是权威快照', () => {
  it('整体替换 questions/approvals（不是合并）：本地多出来的卡片会被清掉', () => {
    let out = reduce(base(), question())
    expect(out.state.questions).toHaveLength(1)
    // 快照里没有这张提问卡 → 必须消失（前端本地状态错了就靠它校正）
    out = reduce(out, snapshot({ questions: [pendingQuestion('call_snap')] }))
    expect(out.state.questions.map((q) => q.callId)).toEqual(['call_snap'])
    expect(out.state.questions[0]!.questions[0]!.question).toBe('快照里的问题')
    expect(out.state.questions[0]!.sessionId).toBe(SID)
  })

  it('审批只保留 open（settled/expired 不该显示在手机上）', () => {
    const out = reduce(
      base(),
      snapshot({
        approvals: [pendingApproval('ap_open'), { ...(pendingApproval('ap_done') as object), state: 'settled' }],
      }),
    )
    expect(out.state.approvals.map((a) => a.approvalId)).toEqual(['ap_open'])
    expect(out.state.approvals[0]).toMatchObject({ tool: 'bash', answerable: true, callId: 'call_ap' })
  })

  it('running=false：收起停止按钮、清残留流式与 attempt 记账', () => {
    let out = reduce(base(), {
      v: 1,
      type: 'delta',
      sessionId: SID,
      attemptId: 'att_1',
      revision: 1,
      index: 0,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: '写到一半' },
    })
    out = reduce(out, { v: 1, type: 'turn', sessionId: SID, phase: 'start', turn: 1 })
    out = { ...out, state: { ...out.state, stopRequested: true } }
    expect(out.state.turnRunning).toBe(true)
    expect(out.state.streamingText).toBe('写到一半')

    out = reduce(out, snapshot({ running: false }))
    expect(out.state.turnRunning).toBe(false)
    // 「正在停止」也要收起来（回合已经结束）
    expect(out.state.stopRequested).toBe(false)
    expect(out.state.streamingText).toBeNull()
    expect(out.state.streamingReasoning).toBeNull()
    expect(out.state.reasoningDone).toBe(false)
    expect(out.stream.attemptId).toBeNull()
  })

  it('running=true：保留流式正文，并把 attempt 记账对齐到快照的 attemptId', () => {
    let out = reduce(base(), {
      v: 1,
      type: 'delta',
      sessionId: SID,
      attemptId: 'att_1',
      revision: 1,
      index: 0,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: '正在跑' },
    })
    out = reduce(out, snapshot({ running: true, attemptId: 'att_1' }))
    expect(out.state.turnRunning).toBe(true)
    expect(out.state.streamingText).toBe('正在跑')
    expect(out.stream.attemptId).toBe('att_1')
  })

  it('running=true 但换了 attempt：清掉旧 attempt 的正文，新增量不接在旧文本后面', () => {
    let out = reduce(base(), {
      v: 1,
      type: 'delta',
      sessionId: SID,
      attemptId: 'att_old',
      revision: 1,
      index: 0,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: '旧的' },
    })
    out = reduce(out, snapshot({ running: true, attemptId: 'att_new' }))
    expect(out.state.turnRunning).toBe(true)
    expect(out.state.streamingText).toBeNull()
    expect(out.stream.attemptId).toBe('att_new')
    out = reduce(out, {
      v: 1,
      type: 'delta',
      sessionId: SID,
      attemptId: 'att_new',
      revision: 2,
      index: 0,
      turn: 2,
      step: 1,
      part: { kind: 'text', text: '新的' },
    })
    expect(out.state.streamingText).toBe('新的')
    // 旧 attempt 的迟到增量不能再把正文拉回去
    out = reduce(out, {
      v: 1,
      type: 'delta',
      sessionId: SID,
      attemptId: 'att_old',
      revision: 1,
      index: 1,
      turn: 1,
      step: 1,
      part: { kind: 'text', text: '迟到' },
    })
    expect(out.state.streamingText).toBe('新的')
  })

  it('别的会话的快照不动当前页（只认当前打开的会话）', () => {
    let out = reduce(base(), question())
    out = reduce(out, snapshot({ sessionId: 'other', questions: [pendingQuestion('call_other')] }))
    expect(out.state.questions.map((q) => q.callId)).toEqual(['call_1'])
    expect(out.state.turnRunning).toBe(false)
  })
})

// ── 门面 + 假通道 ──────────────────────────────────────────────────────────

// 只放契约里真实存在的特性名（hello.features 是 enum 校验，写错整帧会被判 malformed）。
const FEATURES_WITH_STATE = ['session-state']
const FEATURES_WITHOUT_STATE: string[] = []

describe('门面：协商 session-state 时的断线/重连', () => {
  it('断线不清提问卡；重连后的快照把提问带回来，并且可以回答', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h, [sessionRow(SID)], FEATURES_WITH_STATE)
    h.controller.openSession(SID)
    await sleep(0)
    openSession(channel, SID)
    await sleep(0)

    // Hub 推一张提问卡（回合也在跑）
    channel.server(question())
    await sleep(0)
    expect(h.controller.getState().questions).toHaveLength(1)

    // 断线（模拟切后台/网络断）：**不清**卡片
    channel.drop(1006)
    await sleep(0)
    expect(h.controller.getState().questions).toHaveLength(1)

    // 重连：Hub 在 replay 之后发一份快照，把未决提问带回来
    await sleep(20)
    const next = h.channels[h.channels.length - 1]!
    next.emitOpen()
    next.server(helloFrame({ requestId: next.last('hello').requestId, features: FEATURES_WITH_STATE }))
    await sleep(0)
    const sessions = next.last('sessions')
    if (sessions) next.server(sessionsFrame(sessions.requestId, [sessionRow(SID)]))
    await sleep(0)
    const subscribe = next.last('subscribe')
    if (subscribe) {
      next.server({ v: 1, type: 'replay', sessionId: SID, fromCursor: 0, toCursor: 12 })
    }
    next.server(
      snapshot({ running: true, attemptId: 'att_live', questions: [pendingQuestion('call_parked')] }),
    )
    await sleep(0)
    const state = h.controller.getState()
    expect(state.questions.map((q) => q.callId)).toEqual(['call_parked'])
    expect(state.turnRunning).toBe(true)

    // 可以回答：answer-question 帧带着快照里的 callId 发出去
    h.controller.answerQuestion(state.questions[0]!, [{ id: 'q1', selected: ['A'] }])
    await sleep(0)
    const answer = next.sent.filter((frame) => frame.type === 'answer-question').at(-1)
    expect(answer?.callId).toBe('call_parked')
  })

  it('快照 running=false 收起停止按钮（turnRunning/stopRequested 都归零）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h, [sessionRow(SID)], FEATURES_WITH_STATE)
    h.controller.openSession(SID)
    await sleep(0)
    openSession(channel, SID)
    await sleep(0)

    channel.server({ v: 1, type: 'turn', sessionId: SID, phase: 'start', turn: 1 })
    await sleep(0)
    expect(h.controller.getState().turnRunning).toBe(true)
    // 回合进行中「停止」按钮可用
    expect(h.controller.canStop).toBe(true)
    h.controller.stopTurn()
    await sleep(0)
    expect(h.controller.getState().stopRequested).toBe(true)

    // 快照说回合已经结束：停止按钮消失、「正在停止」也收起来
    channel.server(snapshot({ running: false }))
    await sleep(0)
    expect(h.controller.getState().turnRunning).toBe(false)
    expect(h.controller.getState().stopRequested).toBe(false)
    expect(h.controller.canStop).toBe(false)
  })

  it('协商时不拿会话列表的 running 校正回合（快照才是权威位）', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h, [sessionRow(SID, '标题', false)], FEATURES_WITH_STATE)
    h.controller.openSession(SID)
    await sleep(0)
    openSession(channel, SID)
    await sleep(0)

    // 快照说在跑
    channel.server(snapshot({ running: true, attemptId: 'att_live' }))
    await sleep(0)
    expect(h.controller.getState().turnRunning).toBe(true)

    // 之后来一份「running=false」的会话列表（hello 触发的那一份）：不许把回合翻回去
    const request = channel.last('sessions')
    channel.server(sessionsFrame(request.requestId, [sessionRow(SID, '标题', false)]))
    await sleep(0)
    expect(h.controller.getState().turnRunning).toBe(true)
  })

  it('探活成功（收到任何下行）后补一次 session-state-request，回包整体替换状态', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h, [sessionRow(SID)], FEATURES_WITH_STATE)
    h.controller.openSession(SID)
    await sleep(0)
    openSession(channel, SID)
    await sleep(0)

    // 回前台：探活（ping）→ 收到 pong → 自动请求快照
    h.controller.probeLink(5_000)
    await sleep(0)
    expect(channel.last('ping')).toBeTruthy()
    const request = channel.last('session-state-request')
    expect(request).toBeUndefined() // 还没收到任何下行
    channel.server({ v: 1, type: 'pong', t: 1 })
    await sleep(0)
    const sent = channel.last('session-state-request')
    expect(sent?.sessionId).toBe(SID)

    channel.server(
      snapshot({ requestId: sent.requestId, running: true, questions: [pendingQuestion('call_after_fg')] }),
    )
    await sleep(0)
    expect(h.controller.getState().questions.map((q) => q.callId)).toEqual(['call_after_fg'])
  })
})

describe('门面：未协商 session-state 时保留 0.2.15 的兜底', () => {
  it('断线清提问卡 + 会话列表 running 仍然校正回合', async () => {
    const h = createHarness()
    const channel = await bootWithSessions(h, [sessionRow(SID, '标题', false)], FEATURES_WITHOUT_STATE)
    h.controller.openSession(SID)
    await sleep(0)
    openSession(channel, SID)
    await sleep(0)

    channel.server(question())
    await sleep(0)
    expect(h.controller.getState().questions).toHaveLength(1)

    // 未协商：断线仍然清掉通道内瞬态的提问卡
    channel.drop(1006)
    await sleep(0)
    expect(h.controller.getState().questions).toHaveLength(0)

    // 重连后会话列表 running=true 仍然能校正回合状态
    await sleep(20)
    const next = h.channels[h.channels.length - 1]!
    next.emitOpen()
    next.server(helloFrame({ requestId: next.last('hello').requestId, features: FEATURES_WITHOUT_STATE }))
    await sleep(0)
    const request = next.last('sessions')
    next.server(sessionsFrame(request.requestId, [sessionRow(SID, '标题', true)]))
    await sleep(0)
    expect(h.controller.getState().turnRunning).toBe(true)
    // 未协商时不发快照请求
    h.controller.requestSessionState()
    await sleep(0)
    expect(next.last('session-state-request')).toBeUndefined()
  })

  it('syncTurnRunning 本身仍是纯函数（老 Hub 用得到）', () => {
    const state: WorkspaceState = { ...initialWorkspaceState('cloud:self'), openSessionId: SID }
    const out = syncTurnRunning(state, initialStreamState(), true)
    expect(out.state.turnRunning).toBe(true)
  })
})
