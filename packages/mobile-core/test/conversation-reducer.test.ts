/**
 * 纯 reducer 单测（`src/channel/conversation.ts`）：不建通道、不等定时器、不碰 IO。
 *
 * 覆盖 M2 §5 里最容易被补丁改回去的六条时序：
 *  1. 迟到旧 attempt 的 delta 丢弃（baseline 之后）；
 *  2. 同一 attempt 内 index 去重（revision 不参与连续性判断）；
 *  3. assistant-baseline 续传（**替换**正文、从 nextIndex 继续）；
 *  4. canonical message 落地清流式（并把思考搬进消息）；
 *  5. history epoch 隔离（A→B→A 之后旧 A 的迟到页丢弃）；
 *  6. 重放/断线边界清提问卡（`clearChannelScoped`）。
 *
 * 另外锁定 delta-end ≠ 回合结束、tool 卡按 callId 幂等、state 投影走 effects 等。
 */

import { describe, expect, it } from 'vitest'
import {
  clearChannelScoped,
  initialStreamState,
  reduceConversation,
  syncTurnRunning,
  type ConversationResult,
} from '../src/channel/conversation.js'
import { initialWorkspaceState, type WorkspaceState } from '../src/channel/workspace-state.js'
import type { AnyServerFrame } from '../src/channel/wire.js'

const SID = 's1'

interface Input {
  state: WorkspaceState
  stream: ReturnType<typeof initialStreamState>
}

function base(overrides: Partial<WorkspaceState> = {}): Input {
  return {
    state: { ...initialWorkspaceState('cloud:self'), link: 'connected', openSessionId: SID, ...overrides },
    stream: initialStreamState(),
  }
}

function reduce(input: Input, frame: unknown, options?: { requestEpoch?: number; beforeSeq?: number | null }): ConversationResult {
  return reduceConversation(input, frame as AnyServerFrame, options ?? {})
}

function delta(attemptId: string, index: number, text: string, part: 'text' | 'reasoning' = 'text', revision = 1): unknown {
  return {
    v: 1,
    type: 'delta',
    sessionId: SID,
    attemptId,
    revision,
    index,
    turn: 1,
    step: 1,
    part: { kind: part, text },
  }
}

function baseline(attemptId: string, nextIndex: number, text: string, reasoning?: string): unknown {
  return {
    v: 1,
    type: 'assistant-baseline',
    sessionId: SID,
    attemptId,
    revision: 1,
    nextIndex,
    text,
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

function message(seq: number | null, role: 'user' | 'assistant', text: string, clientMessageId?: string): unknown {
  return {
    v: 1,
    type: 'message',
    sessionId: SID,
    ...(seq === null ? {} : { seq }),
    role,
    at: 1_730_000_000_000,
    text,
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
  }
}

function history(
  items: unknown[],
  options: { cursor?: number; hasMore?: boolean; nextBeforeSeq?: number | null } = {},
): unknown {
  return {
    v: 1,
    type: 'history',
    requestId: 'h1',
    sessionId: SID,
    items,
    nextBeforeSeq: options.nextBeforeSeq ?? null,
    cursor: options.cursor ?? 10,
    hasMore: options.hasMore ?? false,
  }
}

describe('1. 迟到旧 attempt 的 delta 丢弃', () => {
  it('baseline 换到 att2 之后，att1 的迟到 delta 不再改正文', () => {
    let out = reduce(base(), delta('att1', 0, '旧'))
    out = reduce(out, delta('att1', 1, '文'))
    expect(out.state.streamingText).toBe('旧文')

    out = reduce(out, baseline('att2', 5, '前半'))
    expect(out.state.streamingText).toBe('前半')

    out = reduce(out, delta('att1', 9, '迟到'))
    expect(out.state.streamingText).toBe('前半')
    // 新 attempt 从 nextIndex 继续
    out = reduce(out, delta('att2', 5, '后半'))
    expect(out.state.streamingText).toBe('前半后半')
  })

  it('canonical assistant message 落地后，同一 attempt 的迟到 delta 丢弃', () => {
    let out = reduce(base(), delta('att1', 0, '增量'))
    out = reduce(out, message(5, 'assistant', '完整回答'))
    expect(out.state.streamingText).toBeNull()
    out = reduce(out, delta('att1', 1, '迟到'))
    expect(out.state.streamingText).toBeNull()
  })
})

describe('2. index 去重（revision 不参与连续性）', () => {
  it('同一 attempt 重复 index 不重复追加，index 递增才追加', () => {
    let out = reduce(base(), delta('att1', 3, 'A'))
    out = reduce(out, delta('att1', 3, 'A'))
    out = reduce(out, delta('att1', 4, 'B'))
    expect(out.state.streamingText).toBe('AB')
  })

  it('revision 回退但 index 递增仍然接受（v1 客户端会误判）', () => {
    let out = reduce(base(), delta('att1', 1, 'A', 'text', 5))
    out = reduce(out, delta('att1', 2, 'B', 'text', 4))
    expect(out.state.streamingText).toBe('AB')
  })

  it('reasoning 单独累加，不混进正文；done 帧没有 text 也能收起思考', () => {
    let out = reduce(base(), delta('att1', 0, '想一想', 'reasoning'))
    out = reduce(out, delta('att1', 1, '正文'))
    expect(out.state.streamingReasoning).toBe('想一想')
    expect(out.state.streamingText).toBe('正文')
    // 正文开始输出即认为思考结束
    expect(out.state.reasoningDone).toBe(true)

    let other = reduce(base(), delta('att1', 0, '想', 'reasoning'))
    other = reduce(other, {
      v: 1,
      type: 'delta',
      sessionId: SID,
      attemptId: 'att1',
      revision: 1,
      index: 1,
      turn: 1,
      step: 1,
      done: true,
      part: { kind: 'reasoning' },
    })
    expect(other.state.reasoningDone).toBe(true)
  })
})

describe('3. assistant-baseline 续传', () => {
  it('替换正文（不追加），nextIndex-1 视为已收索引，旧基线之前的 index 丢弃', () => {
    let out = reduce(base(), delta('att1', 0, 'AAAA'))
    out = reduce(out, baseline('att2', 3, 'BBB'))
    expect(out.state.streamingText).toBe('BBB')

    // index 2（< nextIndex-1）与重复的 2 都要丢弃
    out = reduce(out, delta('att2', 2, 'X'))
    expect(out.state.streamingText).toBe('BBB')

    out = reduce(out, delta('att2', 3, 'C'))
    expect(out.state.streamingText).toBe('BBBC')
    expect(out.state.turnRunning).toBe(true)
  })

  it('baseline 带 reasoning 时替换思考；老 Hub 不带时同一 attempt 保留现有思考', () => {
    let out = reduce(base(), delta('att1', 0, '已有思考', 'reasoning'))
    out = reduce(out, baseline('att1', 3, '', 'Hub 恢复的思考'))
    expect(out.state.streamingReasoning).toBe('Hub 恢复的思考')

    let legacy = reduce(base(), delta('att1', 0, '已有思考', 'reasoning'))
    legacy = reduce(legacy, baseline('att1', 3, ''))
    expect(legacy.state.streamingReasoning).toBe('已有思考')
  })

  it('别的会话的 baseline 丢弃', () => {
    const out = reduce(base(), { ...(baseline('att9', 1, '不该出现') as object), sessionId: 'other' })
    expect(out.state.streamingText).toBeNull()
  })
})

describe('4. canonical message 落地清流式', () => {
  it('assistant message 替换增量、按 seq 幂等、把本轮思考搬进消息', () => {
    let out = reduce(base(), delta('att1', 0, '思考中', 'reasoning'))
    out = reduce(out, delta('att1', 1, '增量正文'))
    out = reduce(out, message(5, 'assistant', '完整回答'))
    expect(out.state.streamingText).toBeNull()
    expect(out.state.streamingReasoning).toBeNull()
    expect(out.state.messages).toHaveLength(1)
    expect(out.state.messages[0]).toMatchObject({ seq: 5, text: '完整回答', reasoning: '思考中' })

    // 同 seq 修订：覆盖，不新增
    out = reduce(out, message(5, 'assistant', '完整回答（修订）'))
    expect(out.state.messages).toHaveLength(1)
    expect(out.state.messages[0]!.text).toBe('完整回答（修订）')
  })

  it('用户消息带 clientMessageId：精确归并本地气泡并产出 pending-settled 副作用', () => {
    const local: WorkspaceState = {
      ...initialWorkspaceState('cloud:self'),
      link: 'connected',
      openSessionId: SID,
      messages: [
        {
          seq: null,
          localId: 'm_1',
          role: 'user',
          text: '你好',
          tools: [],
          at: 1,
          pending: true,
          failed: false,
          unknown: false,
        },
      ],
    }
    const out = reduceConversation(
      { state: local, stream: initialStreamState() },
      message(7, 'user', '你好', 'm_1') as AnyServerFrame,
    )
    expect(out.state.messages).toHaveLength(1)
    expect(out.state.messages[0]).toMatchObject({ seq: 7, localId: null })
    expect(out.effects).toContainEqual({ type: 'pending-settled', clientMessageId: 'm_1' })
  })

  it('没有 clientMessageId 的用户消息不吃掉本地气泡（可能是电脑端发的）', () => {
    const local: WorkspaceState = {
      ...initialWorkspaceState('cloud:self'),
      link: 'connected',
      openSessionId: SID,
      messages: [
        {
          seq: null,
          localId: 'm_1',
          role: 'user',
          text: '手机发的',
          tools: [],
          at: 1,
          pending: true,
          failed: false,
          unknown: false,
        },
      ],
    }
    const out = reduceConversation(
      { state: local, stream: initialStreamState() },
      message(3, 'user', '电脑端发的') as AnyServerFrame,
    )
    expect(out.state.messages.map((m) => m.text)).toEqual(['电脑端发的', '手机发的'])
    expect(out.effects).toHaveLength(0)
  })
})

describe('5. history epoch 隔离', () => {
  it('epoch 不匹配的迟到页整页丢弃（不改消息、不产生副作用）', () => {
    const input = base()
    input.stream = { ...initialStreamState(), epoch: 2 }
    const stale = reduce(
      input,
      history([{ seq: 1, role: 'user', at: 1, text: '旧页' }]),
      { requestEpoch: 1, beforeSeq: null },
    )
    expect(stale.state.messages).toHaveLength(0)
    expect(stale.effects).toHaveLength(0)

    const fresh = reduce(
      input,
      history([{ seq: 2, role: 'user', at: 2, text: '新页' }]),
      { requestEpoch: 2, beforeSeq: null },
    )
    expect(fresh.state.messages.map((m) => m.text)).toEqual(['新页'])
    expect(fresh.state.historyLoading).toBe(false)
    expect(fresh.effects).toContainEqual({
      type: 'history-applied',
      sessionId: SID,
      beforeSeq: null,
      cursor: 10,
    })
  })

  it('frame.sessionId 与当前会话不一致也不合并', () => {
    const out = reduce(base(), { ...(history([{ seq: 1, role: 'user', at: 1, text: 'x' }]) as object), sessionId: 'other' })
    expect(out.state.messages).toHaveLength(0)
  })

  it('首页与实时消息按 seq 求并集（请求期间新到的 canonical 不被覆盖）', () => {
    let out = reduce(base(), message(9, 'assistant', 'live'))
    out = reduce(out, history([{ seq: 5, role: 'user', at: 5, text: 'history' }]))
    expect(out.state.messages.map((m) => m.text)).toEqual(['history', 'live'])
  })

  it('history 保留本地未落库气泡，只剔除服务端已给出 clientMessageId 的那些', () => {
    const input = base({
      messages: [
        {
          seq: null,
          localId: 'm_keep',
          role: 'user',
          text: '还没落库',
          tools: [],
          at: 1,
          pending: true,
          failed: false,
          unknown: false,
        },
      ],
    })
    const out = reduce(input, history([{ seq: 4, role: 'user', at: 4, text: '落库了', clientMessageId: 'm_other' }]))
    expect(out.state.messages.map((m) => m.text)).toEqual(['落库了', '还没落库'])
  })
})

describe('6. 断线/重放边界清提问卡', () => {
  it('clearChannelScoped 清掉提问/审批/停止中标记，空的时候返回同一对象', () => {
    const clean = initialWorkspaceState('cloud:self')
    expect(clearChannelScoped(clean)).toBe(clean)

    const dirty: WorkspaceState = {
      ...clean,
      questions: [{ sessionId: SID, agent: SID, callId: 'c1', questions: [], state: 'open' }],
      approvals: [
        {
          sessionId: SID,
          approvalId: 'a1',
          callId: null,
          tool: 'bash',
          answerable: true,
          actions: ['approve', 'reject'],
          state: 'open',
        },
      ],
      stopRequested: true,
    }
    const cleared = clearChannelScoped(dirty)
    expect(cleared.questions).toHaveLength(0)
    expect(cleared.approvals).toHaveLength(0)
    expect(cleared.stopRequested).toBe(false)
  })

  it('replay 帧同样作废上一代通道的卡片，并请求回合状态校正', () => {
    let out = reduce(base(), {
      v: 1,
      type: 'question',
      sessionId: SID,
      agent: SID,
      callId: 'call_1',
      state: 'open',
      questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }] }],
    })
    expect(out.state.questions).toHaveLength(1)
    out = reduce(out, { v: 1, type: 'turn', sessionId: SID, phase: 'start', turn: 1 })
    out = reduce(out, { v: 1, type: 'replay', sessionId: SID, fromCursor: 5, toCursor: 9 })
    expect(out.state.questions).toHaveLength(0)
    expect(out.state.turnRunning).toBe(true)
    expect(out.effects).toContainEqual({ type: 'replay', sessionId: SID, toCursor: 9, needsTurnSync: true })
  })

  it('重连后按会话列表 running=false 收口：清掉半截流式文本与停止按钮', () => {
    const out = reduce(base(), delta('att1', 0, '正在删除前 36'))
    const settled = syncTurnRunning(
      { ...out.state, turnRunning: true },
      out.stream,
      false,
    )
    expect(settled.state.turnRunning).toBe(false)
    expect(settled.state.streamingText).toBeNull()
    // running=true 时不能把回合误收口
    const running = syncTurnRunning({ ...settled.state, turnRunning: false }, settled.stream, true)
    expect(running.state.turnRunning).toBe(true)
  })
})

describe('delta-end / turn / 工具卡 / 投影', () => {
  it('delta-end 不是回合结束：committed 只决定是否标记已提交', () => {
    let out = reduce(base(), { v: 1, type: 'turn', sessionId: SID, phase: 'start', turn: 1 })
    out = reduce(out, delta('att1', 0, '正在跑'))
    out = reduce(out, { v: 1, type: 'delta-end', sessionId: SID, attemptId: 'att1', revision: 1, committed: true })
    expect(out.state.streamingSettled).toBe(true)
    expect(out.state.turnRunning).toBe(true)
    expect(out.state.streamingText).toBe('正在跑')

    out = reduce(out, { v: 1, type: 'turn', sessionId: SID, phase: 'end', turn: 1, reason: 'completed' })
    expect(out.state.turnRunning).toBe(false)
    expect(out.state.streamingSettled).toBe(true)
  })

  it('delta-end 未提交（committed=false）丢弃半截正文', () => {
    let out = reduce(base(), delta('att1', 0, '半截'))
    out = reduce(out, { v: 1, type: 'delta-end', sessionId: SID, attemptId: 'att1', revision: 1, committed: false })
    expect(out.state.streamingText).toBeNull()
  })

  it('工具卡按 callId 幂等（end 覆盖 start）并按 seq 排序', () => {
    const start = (callId: string, seq: number, phase: 'start' | 'end') => ({
      v: 1,
      type: 'tool',
      sessionId: SID,
      callId,
      kind: 'bash',
      name: 'bash',
      phase,
      seq,
      turn: 1,
      step: 1,
      status: phase === 'end' ? 'ok' : 'running',
      title: '运行了命令',
      inputPreview: 'ls',
      inputBytes: 2,
      ...(phase === 'end' ? { outputPreview: 'ok', outputBytes: 2, durationMs: 10 } : {}),
    })
    let out = reduce(base(), start('call_b', 20, 'start'))
    out = reduce(out, start('call_a', 10, 'start'))
    expect(out.state.toolCards.map((c) => c.callId)).toEqual(['call_a', 'call_b'])
    out = reduce(out, start('call_b', 20, 'end'))
    expect(out.state.toolCards).toHaveLength(2)
    expect(out.state.toolCards.find((c) => c.callId === 'call_b')?.status).toBe('ok')
  })

  it('state(title) 与 state(modelSelection) 走 effects（不改页面的其它字段）', () => {
    const titled = reduce(base(), { v: 1, type: 'state', sessionId: SID, key: 'title', value: '自动标题', seq: 3 })
    expect(titled.effects).toContainEqual({ type: 'session-title', sessionId: SID, title: '自动标题' })

    const projected = reduce(base(), {
      v: 1,
      type: 'state',
      sessionId: SID,
      key: 'modelSelection',
      value: {
        lastUsed: { provider: 'p', model: 'm-old', reasoningEffort: 'off' },
        next: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      },
      seq: 4,
    })
    expect(projected.effects).toContainEqual({
      type: 'model-selection',
      sessionId: SID,
      selection: { provider: 'p', model: 'm', effortTier: 'high' },
    })
  })

  it('stopped.accepted 只在回合还没结束时保留「正在停止」', () => {
    let out = reduce(base(), { v: 1, type: 'turn', sessionId: SID, phase: 'start', turn: 1 })
    out = reduce(out, { v: 1, type: 'stopped', requestId: 'r', sessionId: SID, accepted: true })
    expect(out.state.stopRequested).toBe(true)

    let ended = reduce(base(), { v: 1, type: 'turn', sessionId: SID, phase: 'end', turn: 1, reason: 'completed' })
    ended = reduce(ended, { v: 1, type: 'stopped', requestId: 'r', sessionId: SID, accepted: true })
    expect(ended.state.stopRequested).toBe(false)
  })

  it('别的会话的帧一律原样返回（不触发重渲染）', () => {
    const input = base()
    expect(reduce(input, { ...(delta('att1', 0, 'x') as object), sessionId: 'other' }).state).toBe(input.state)
    expect(reduce(input, { ...(history([]) as object), sessionId: 'other' }).state).toBe(input.state)
  })
})
