/**
 * 会话页面的**纯 reducer**：`状态 + 下行帧 → 新状态 + 副作用清单`。
 *
 * 这里装着 M2 §5 里最容易丢的几条时序规则（每条都有真机日期，见下），但它们全部是
 * 「给定输入就该得到这个输出」的纯函数——不碰定时器、不碰通道、不碰缓存，所以可以
 * 直接单测（`test/conversation-reducer.test.ts`）。
 *
 *  - **history epoch 隔离**：每个 history 请求带 `beforeSeq + sessionEpoch`；A→B→A 之后
 *    旧 A 的迟到页必须丢弃（`options.requestEpoch`）。
 *  - **assistant baseline 续传**：重连时用 `assistant-baseline` **替换**正文（不追加），
 *    把 `nextIndex-1` 当作已收索引，旧 attempt 的迟到 delta 一律丢弃。
 *  - **index 去重**：冻结契约 §17 / §7.1 —— `revision` 是会话级计数器，连续性只能比 index；
 *    同一 attempt 内 index 必须严格递增，新 attempt 从 0 开始直接接受。
 *  - **delta-end ≠ 回合结束**：只认 `turn/end`；`delta-end` 只决定「已提交」标志。
 *  - **message 落地清流式**：canonical `assistant/message` 到达时把这一轮的思考搬进消息、
 *    清空流式正文，并按 seq 幂等合并（同一 seq 后到覆盖先到）。
 *  - **断线/重放边界清提问卡**：Hub 的 adapter 在通道关闭时把未决提问回 `next`，
 *    重连也不补撤销帧，所以客户端只能在边界自己作废（真机 2026-10-27 16:07）。
 *  - **回合状态校正**：重连 catch-up 不含 `turn/end`，只能靠会话列表的 `running` 收口
 *    （`syncTurnRunning`）。
 *
 * 副作用（删除 pendingSends、更新游标、改会话标题…）以 `effects` 返回，由门面执行；
 * reducer 自己不产生任何 IO。`WorkspaceState` 的形状在这里**只读不增删**字段。
 */

import type { ModelSelection, BackendModelCatalog } from '../models/catalog.js'
import { selectionFromServer, tierOfDshEffort } from '../models/catalog.js'
import { deliverableFromFrame, toolCardFromFrame } from './tools.js'
import type { AnyServerFrame } from './wire.js'
import type {
  ApprovalRequest,
  ChatEntry,
  FrameOf,
  HistoryItem,
  QuestionPrompt,
  WorkspaceState,
} from './workspace-state.js'

/** 流式 attempt 的记账（不属于 UI 可见状态，所以不放进 `WorkspaceState`）。 */
export interface ConversationStreamState {
  /** 会话代次：每次 openSession/closeSession 自增；旧代次的迟到回包用它识别。 */
  epoch: number
  attemptId: string | null
  revision: number
  lastIndex: number
  /** 已结束的 attempt（有界，最多 32 条）：旧 attempt 的迟到 delta 一律丢弃。 */
  finishedAttempts: string[]
}

export interface ConversationInput {
  state: WorkspaceState
  stream: ConversationStreamState
}

/** reducer 产出的副作用：条数极少、语义单一，门面按 type 分派。 */
export type ConversationEffect =
  /** 用户消息落地/首页归并：可以清掉这条 pendingSend 与 requestId 映射了。 */
  | { type: 'pending-settled'; clientMessageId: string }
  /** 首页已应用：更新游标、按需补订阅、清掉该会话的 history 重试计数。 */
  | { type: 'history-applied'; sessionId: string; beforeSeq: number | null; cursor: number | null }
  /** 重放边界：游标前移、补拉会话列表校正回合状态。 */
  | { type: 'replay'; sessionId: string; toCursor: number; needsTurnSync: boolean }
  /** `state(title)` 投影：改会话列表里的标题。 */
  | { type: 'session-title'; sessionId: string; title: string }
  /** `state(modelSelection)` 投影：更新当前选择并结算等待中的 set-model。 */
  | { type: 'model-selection'; sessionId: string; selection: ModelSelection }

export interface ReduceOptions {
  /** history 请求发出时的会话代次；与当前不同 = 迟到回包，丢弃。 */
  requestEpoch?: number
  /** history 请求的 `beforeSeq`（null/缺省 = 首页）。 */
  beforeSeq?: number | null
}

export interface ConversationResult {
  state: WorkspaceState
  stream: ConversationStreamState
  effects: ConversationEffect[]
}

export function initialStreamState(): ConversationStreamState {
  return { epoch: 0, attemptId: null, revision: -1, lastIndex: -1, finishedAttempts: [] }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 把一条下行帧折进状态。**不认识的帧、别的会话的帧**一律原样返回（不触发重渲染）。
 */
export function reduceConversation(
  input: ConversationInput,
  frame: AnyServerFrame,
  options: ReduceOptions = {},
): ConversationResult {
  switch (frame.type) {
    case 'history':
      return onHistory(input, frame, options)
    case 'delta':
      return onDelta(input, frame)
    case 'delta-end':
      return onDeltaEnd(input, frame)
    case 'assistant-baseline':
      return onAssistantBaseline(input, frame)
    case 'message':
      return onMessage(input, frame)
    case 'turn':
      return onTurn(input, frame)
    case 'state':
      return onState(input, frame)
    case 'tool':
      return onTool(input, frame)
    case 'deliverable':
      return onDeliverable(input, frame)
    case 'question':
      return onQuestion(input, frame)
    case 'question-settled':
      return onQuestionSettled(input, frame)
    case 'approval':
      return onApproval(input, frame)
    case 'approval-settled':
      return onApprovalSettled(input, frame)
    case 'stopped':
      return onStopped(input, frame)
    case 'replay':
      return onReplay(input, frame)
    // WP46 / M6 §2.3：会话快照是**权威快照**，整体替换回合态与未决交互。
    case 'session-state':
      return onSessionState(input, frame)
    default:
      return unchanged(input)
  }
}

// ── 会话生命周期 ────────────────────────────────────────────────────────────

/**
 * 打开会话：清空上一页的一切（消息/流式/工具卡/卡片/游标），会话代次 +1。
 * 调用方负责发 unsubscribe/首页请求（reducer 不碰 IO）。
 */
export function openConversation(state: WorkspaceState, stream: ConversationStreamState, sessionId: string): ConversationResult {
  return {
    state: {
      ...state,
      openSessionId: sessionId,
      messages: [],
      streamingText: null,
      streamingReasoning: null,
      reasoningDone: false,
      streamingSettled: false,
      toolCards: [],
      deliverables: [],
      uploads: [],
      turnRunning: false,
      stopRequested: false,
      questions: [],
      approvals: [],
      sessionUsage: null,
      sessionUsageSessionId: null,
      sessionUsageLoading: false,
      sessionUsageError: null,
      historyHasMore: false,
      historyLoading: false,
      nextBeforeSeq: null,
      error: null,
    },
    stream: { ...initialStreamState(), epoch: stream.epoch + 1 },
    effects: [],
  }
}

/** 关闭会话：清空页面状态，会话代次 +1（旧代次的迟到回包全部作废）。 */
export function closeConversation(state: WorkspaceState, stream: ConversationStreamState): ConversationResult {
  return {
    state: {
      ...state,
      openSessionId: null,
      messages: [],
      streamingText: null,
      streamingReasoning: null,
      reasoningDone: false,
      streamingSettled: false,
      toolCards: [],
      deliverables: [],
      uploads: [],
      turnRunning: false,
      questions: [],
      approvals: [],
    },
    stream: { ...stream, epoch: stream.epoch + 1, attemptId: null, revision: -1, lastIndex: -1 },
    effects: [],
  }
}

/**
 * 用会话列表的 `running` 校正回合状态（重连 catch-up 之后）。
 *
 * 断线期间结束的回合在 catch-up 里只有持久消息、没有 `turn/end`（adapter 不补发控制帧），
 * 不校正的话 `turnRunning` 会永远停在 true：UI 一直显示停止按钮、发不了新消息
 * （真机 2026-10-27 16:07 就是这个状态）。反向也要补：`running === true` 时不能停在「空闲」。
 */
export function syncTurnRunning(
  state: WorkspaceState,
  stream: ConversationStreamState,
  running: boolean,
): ConversationResult {
  if (running) {
    if (state.turnRunning) return unchanged({ state, stream })
    return { state: { ...state, turnRunning: true }, stream, effects: [] }
  }
  const staleStream = state.streamingText !== null || state.streamingReasoning !== null
  if (!state.turnRunning && !staleStream) return unchanged({ state, stream })
  const finished = stream.attemptId !== null ? markAttemptFinished(stream, stream.attemptId) : stream
  return {
    state: {
      ...state,
      turnRunning: false,
      stopRequested: false,
      reasoningDone: true,
      streamingText: null,
      streamingReasoning: null,
      streamingSettled: false,
    },
    stream: { ...finished, attemptId: null, revision: -1, lastIndex: -1 },
    effects: [],
  }
}

/**
 * 清掉只活在一条手机通道里的瞬态交互（提问 / 审批 / 停止中标记）。
 *
 * Hub 的 adapter 在通道关闭时会把未决提问与审批回 `next`（Host 侧失败关闭），
 * 也就是「这张卡片已经不可能再被回答」。重连后 adapter 也不会补发撤销帧——
 * 提问/审批不走 projection（legacy 提问根本不投影），catch-up 只补持久消息。
 */
export function clearChannelScoped(state: WorkspaceState): WorkspaceState {
  if (state.questions.length === 0 && state.approvals.length === 0 && !state.stopRequested) return state
  return { ...state, questions: [], approvals: [], stopRequested: false }
}

// ── 本地气泡（UI 乐观消息）──────────────────────────────────────────────────

/** 追加一条本地待发气泡（已存在同 clientMessageId 就不重复加）。 */
export function appendLocalMessage(state: WorkspaceState, entry: ChatEntry): WorkspaceState {
  // 首页可能已经带回这条消息（history 响应比 send 的本地气泡先被处理）：别再叠一个
  // seq=null 的本地气泡，否则同一句话会出现两次（一条在正确位置、一条排到最后）。
  if (
    state.messages.some(
      (item) => item.clientMessageId === entry.localId || item.localId === entry.localId,
    )
  ) {
    return state
  }
  return { ...state, messages: [...state.messages, entry], error: null }
}

/** 改某条本地气泡的「发送中/失败/结果未知」标记。 */
export function markMessageFlags(
  state: WorkspaceState,
  clientMessageId: string,
  patch: Partial<Pick<ChatEntry, 'pending' | 'failed' | 'unknown'>>,
): WorkspaceState {
  return { ...state, messages: state.messages.map((m) => (m.localId === clientMessageId ? { ...m, ...patch } : m)) }
}

/** 把若干未决的本地气泡标成「结果未知」（不显示发送中，由用户显式重试）。 */
export function markUnknownMessages(state: WorkspaceState, clientMessageIds: Iterable<string>): WorkspaceState {
  const stale = new Set(clientMessageIds)
  if (stale.size === 0) return state
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.localId !== null && stale.has(m.localId) ? { ...m, pending: false, unknown: true } : m,
    ),
  }
}

/** 撤掉一张提问卡（按 callId）。 */
export function withoutQuestion(state: WorkspaceState, callId: string): WorkspaceState {
  if (!state.questions.some((q) => q.callId === callId)) return state
  return { ...state, questions: state.questions.filter((q) => q.callId !== callId) }
}

/** 首页/上一页请求的加载态（由 `conversation-stream` 驱动）。 */
export function setHistoryLoading(state: WorkspaceState, loading: boolean): WorkspaceState {
  if (state.historyLoading === loading) return state
  return { ...state, historyLoading: loading }
}

/**
 * 会话列表回包把「打开的会话」改成 `resolved`（不在列表里 = null）。
 *
 * 注意：只改 `openSessionId`，**不清消息**——会话行短暂缺失不代表页面要清空。
 */
export function withOpenSessionId(state: WorkspaceState, sessionId: string | null): WorkspaceState {
  if (state.openSessionId === sessionId) return state
  return { ...state, openSessionId: sessionId }
}

// ── 帧处理 ──────────────────────────────────────────────────────────────────

function onHistory(input: ConversationInput, frame: FrameOf<'history'>, options: ReduceOptions): ConversationResult {
  const { state, stream } = input
  // 会话 + epoch 双校验：A→B→A 之后旧 A 的迟到页必须丢弃。
  if (options.requestEpoch !== undefined && options.requestEpoch !== stream.epoch) return unchanged(input)
  if (frame.sessionId !== state.openSessionId) return unchanged(input)

  const mapped: ChatEntry[] = frame.items
    .filter((item: HistoryItem) => {
      if (!isThinkingOnlyStep(item.role, item.text)) return true
      // 只思考/只调工具的中间步骤：有思考就保留。思考块要和工具卡按 seq 交错留在
      // 时间线上（真机 2026-10-27：先思考 → 查网页 → 回答时，思考框整个消失了）；
      // 没有思考的中间步骤仍然丢掉，避免一轮回复里多出一堆空的「思考过程」。
      const reasoning = (item as HistoryItem & { reasoning?: string }).reasoning
      return typeof reasoning === 'string' && reasoning.trim() !== ''
    })
    .map((item: HistoryItem) => {
      const withReasoning = item as HistoryItem & { reasoning?: string }
      return {
        seq: normalizeSeq(item.seq),
        localId: null,
        role: item.role,
        text: item.text,
        tools: item.tools ?? [],
        ...(withReasoning.reasoning ? { reasoning: withReasoning.reasoning } : {}),
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
        at: item.at,
        pending: false,
        failed: false,
        unknown: false,
      }
    })
  const serverIds = new Set(
    frame.items.map((item) => item.clientMessageId).filter((id): id is string => typeof id === 'string'),
  )

  // 保留全部本地气泡（pending/unknown/已 ack 未落库），只剔除服务端已给出 id 的那些；
  // canonical 按 seq 求并集，避免「history 请求期间新到的 message」被首页覆盖。
  const locals = state.messages.filter(
    (entry) => entry.seq == null && entry.localId != null && !serverIds.has(entry.localId),
  )
  const canonical = state.messages.filter((entry): entry is ChatEntry & { seq: number } => entry.seq != null)
  const merged = dedupeBySeq([...canonical, ...mapped])

  const effects: ConversationEffect[] = [...serverIds].map((clientMessageId) => ({
    type: 'pending-settled',
    clientMessageId,
  }))
  effects.push({
    type: 'history-applied',
    sessionId: frame.sessionId,
    beforeSeq: options.beforeSeq ?? null,
    cursor: frame.cursor ?? null,
  })

  return {
    state: {
      ...state,
      messages: [...merged, ...locals],
      historyHasMore: frame.hasMore,
      nextBeforeSeq: frame.nextBeforeSeq,
      historyLoading: false,
    },
    stream,
    effects,
  }
}

function onDelta(input: ConversationInput, frame: FrameOf<'delta'>): ConversationResult {
  const { state, stream } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  if (!frame.attemptId) return unchanged(input)
  // 旧 attempt 的迟到 delta 不得把正文/索引拉回旧状态。
  if (frame.attemptId !== stream.attemptId && stream.finishedAttempts.includes(frame.attemptId)) {
    return unchanged(input)
  }
  // 思考块结束帧**没有 text**（真实 adapter 只发 `part:{kind:'reasoning'}, done:true`），
  // 必须在「text 为空就返回」之前处理，否则思考状态永远收不起来。
  if (frame.part.kind === 'reasoning' && frame.done === true) {
    if (frame.attemptId !== stream.attemptId && stream.attemptId !== null) return unchanged(input)
    return {
      state: { ...state, reasoningDone: true, turnRunning: true },
      stream: { ...stream, attemptId: frame.attemptId, revision: frame.revision },
      effects: [],
    }
  }
  const text = frame.part.text
  if (text == null) return unchanged(input)
  const sameAttempt = frame.attemptId === stream.attemptId
  // 冻结契约 §17 / §7.1：`revision` 是会话级计数器，**连续性只能比 index**。
  // 同一 attempt 内 index 必须严格递增；新的 attempt 从 0 开始，直接接受。
  if (sameAttempt && frame.index <= stream.lastIndex) return unchanged(input)

  const kind = frame.part.kind
  if (kind === 'text') {
    const appended = sameAttempt ? (state.streamingText ?? '') + text : text
    return {
      state: {
        ...state,
        streamingText: appended,
        // 正文已经开始输出，思考块一定结束了（不依赖 done 帧，老 Hub 也能收起）。
        reasoningDone: state.streamingReasoning != null ? true : state.reasoningDone,
        streamingSettled: false,
        turnRunning: true,
      },
      stream: { ...stream, attemptId: frame.attemptId, revision: frame.revision, lastIndex: frame.index },
      effects: [],
    }
  }
  // 思考过程不进正文（M2 §5.7 / M5 §7.4）：单独累加，同样只按 index 去重。
  const appended = sameAttempt ? (state.streamingReasoning ?? '') + text : text
  return {
    state: {
      ...state,
      streamingReasoning: appended,
      reasoningDone: frame.done === true,
      streamingSettled: false,
      turnRunning: true,
    },
    stream: { ...stream, attemptId: frame.attemptId, revision: frame.revision, lastIndex: frame.index },
    effects: [],
  }
}

function onDeltaEnd(input: ConversationInput, frame: FrameOf<'delta-end'>): ConversationResult {
  const { state, stream } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  if (frame.attemptId !== stream.attemptId) return unchanged(input)
  const finished = markAttemptFinished(stream, frame.attemptId)
  if (!frame.committed) {
    return {
      state: { ...state, streamingText: null, streamingReasoning: null, streamingSettled: false },
      stream: { ...finished, attemptId: null },
      effects: [],
    }
  }
  return { state: { ...state, streamingSettled: true }, stream: finished, effects: [] }
}

/**
 * 重连时 Hub 用 `assistant-baseline` 恢复进行中的输出：
 * **替换**（不追加）正文，`streamingLastIndex = nextIndex - 1`，清掉旧 attempt；
 * 后续 delta 从 nextIndex 起连续。baseline 只含 text-chunks，reasoning 不混入正文。
 */
function onAssistantBaseline(input: ConversationInput, frame: FrameOf<'assistant-baseline'>): ConversationResult {
  const { state, stream } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  if (!frame.attemptId) return unchanged(input)
  const previous = stream.attemptId
  const finished =
    previous != null && previous !== frame.attemptId ? markAttemptFinished(stream, previous) : stream
  // 断线重连时 Hub 会把进行中 attempt 的 text / reasoning 一起带回来（reasoning 是尾部一段）：
  // 思考框接着显示，不会出现「只看到 26k 字、实际 76k」的残缺。
  const restoredReasoning =
    typeof frame.reasoning === 'string' && frame.reasoning !== '' ? frame.reasoning : null
  return {
    state: {
      ...state,
      streamingText: frame.text,
      streamingReasoning:
        restoredReasoning ?? (previous === frame.attemptId ? state.streamingReasoning : null),
      streamingSettled: false,
      turnRunning: true,
    },
    stream: {
      ...finished,
      attemptId: frame.attemptId,
      revision: frame.revision,
      lastIndex: frame.nextIndex - 1,
    },
    effects: [],
  }
}

function onMessage(input: ConversationInput, frame: FrameOf<'message'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  let stream = input.stream
  // 只思考/只调工具的中间 assistant 步骤（DSH 一轮回复由多个 assistant/message 组成）。
  const thinkingOnly = isThinkingOnlyStep(frame.role, frame.text)
  // live 回合的思考只存在于增量里（DSH 的 assistant/message 不带 reasoning），
  // canonical 消息到达时把这一轮的思考搬进消息，避免「回复/工具卡一出现思考就消失」。
  // 中间步骤也要搬：这样「思考 → 工具卡 → 思考 → 回答」的思考块能留在时间线上。
  const carriedReasoning =
    frame.role === 'assistant' && state.streamingReasoning ? state.streamingReasoning : undefined
  const entry: ChatEntry = {
    seq: normalizeSeq(frame.seq),
    localId: null,
    role: frame.role,
    text: frame.text,
    tools: frame.tools ?? [],
    ...(carriedReasoning ? { reasoning: carriedReasoning } : {}),
    ...(frame.clientMessageId ? { clientMessageId: frame.clientMessageId } : {}),
    at: frame.at,
    pending: false,
    failed: false,
    unknown: false,
  }
  let current = state.messages
  const effects: ConversationEffect[] = []
  if (frame.role === 'user') {
    // 只有 Hub 透传了 Host 持久化的 source.rpcId 才做精确归并；
    // 没有 id 时保留本地气泡（可能是电脑端发的消息），绝不按顺序/文本猜配对。
    const clientMessageId = frame.clientMessageId
    if (clientMessageId) {
      current = current.filter((m) => m.localId !== clientMessageId)
      effects.push({ type: 'pending-settled', clientMessageId })
    }
  }
  const replaced = dedupeBySeq(
    [...current.filter((m) => m.seq === null), ...current.filter((m) => m.seq !== null), entry],
  ).sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))

  if (frame.role === 'assistant') {
    if (stream.attemptId) stream = markAttemptFinished(stream, stream.attemptId)
    stream = { ...stream, attemptId: null, revision: -1, lastIndex: -1 }
  }
  if (thinkingOnly) {
    // 中间步骤结束：这一步的思考落成消息条目（seq 与工具卡交错排序），再清流式内容。
    // 没有思考的中间步骤不落条目（避免多出一堆空「思考过程」）。
    return {
      state: {
        ...state,
        messages: carriedReasoning?.trim() ? replaced : state.messages,
        streamingText: null,
        streamingReasoning: null,
        reasoningDone: false,
        streamingSettled: false,
      },
      stream,
      effects,
    }
  }
  return {
    state: {
      ...state,
      messages: replaced,
      streamingText: frame.role === 'assistant' ? null : state.streamingText,
      streamingReasoning: frame.role === 'assistant' ? null : state.streamingReasoning,
      reasoningDone: frame.role === 'assistant' ? false : state.reasoningDone,
      streamingSettled: false,
    },
    stream,
    effects,
  }
}

function onTurn(input: ConversationInput, frame: FrameOf<'turn'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  if (frame.phase === 'start') {
    return {
      state: { ...state, turnRunning: true, stopRequested: false, streamingSettled: false },
      stream: input.stream,
      effects: [],
    }
  }
  let stream = input.stream
  if (stream.attemptId) stream = markAttemptFinished(stream, stream.attemptId)
  const settledText = state.streamingText?.trim() ? state.streamingText : null
  const nextState: WorkspaceState = {
    ...state,
    turnRunning: false,
    stopRequested: false,
    reasoningDone: true,
    streamingSettled: settledText != null,
  }
  if (settledText == null) stream = { ...stream, attemptId: null }
  return { state: nextState, stream, effects: [] }
}

function onState(input: ConversationInput, frame: FrameOf<'state'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  if (frame.key === 'title') {
    const title = typeof frame.value === 'string' ? frame.value : null
    if (!title) return unchanged(input)
    return {
      state,
      stream: input.stream,
      effects: [{ type: 'session-title', sessionId: frame.sessionId, title }],
    }
  }
  if (frame.key === 'modelSelection') {
    // 冻结契约 §5.4：芯片只认这个投影（可能来自电脑端）。
    const value = unwrapModelSelection(frame.value)
    if (!value) return unchanged(input)
    const selection = selectionOf(state.models, value)
    if (!selection) return unchanged(input)
    return {
      state,
      stream: input.stream,
      effects: [{ type: 'model-selection', sessionId: frame.sessionId, selection }],
    }
  }
  return unchanged(input)
}

function onTool(input: ConversationInput, frame: FrameOf<'tool'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  // 工具卡：同一个 `callId` 只有一张（start 建卡、end 覆盖），按 start 的 `seq` 排序。
  // history 重进会话时 adapter 会**再补发**一遍 tool/deliverable 帧，所以这里必须幂等。
  const existing = state.toolCards.find((card) => card.callId === frame.callId)
  const card = toolCardFromFrame(frame, existing)
  const next = [...state.toolCards.filter((item) => item.callId !== frame.callId), card]
  next.sort((a, b) => a.seq - b.seq)
  return { state: { ...state, toolCards: next }, stream: input.stream, effects: [] }
}

function onDeliverable(input: ConversationInput, frame: FrameOf<'deliverable'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  const item = deliverableFromFrame(frame)
  const next = [...state.deliverables.filter((entry) => entry.callId !== frame.callId), item]
  next.sort((a, b) => a.seq - b.seq)
  return { state: { ...state, deliverables: next }, stream: input.stream, effects: [] }
}

function onQuestion(input: ConversationInput, frame: FrameOf<'question'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  if (frame.state === 'settled') {
    return {
      state: { ...state, questions: state.questions.filter((q) => q.callId !== frame.callId) },
      stream: input.stream,
      effects: [],
    }
  }
  const prompt: QuestionPrompt = {
    sessionId: frame.sessionId,
    agent: frame.agent,
    callId: frame.callId,
    questions: frame.questions,
    state: frame.state,
  }
  return {
    state: {
      ...state,
      questions: [...state.questions.filter((q) => q.callId !== frame.callId), prompt],
    },
    stream: input.stream,
    effects: [],
  }
}

function onQuestionSettled(input: ConversationInput, frame: FrameOf<'question-settled'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  return {
    state: { ...state, questions: state.questions.filter((q) => q.callId !== frame.callId) },
    stream: input.stream,
    effects: [],
  }
}

function onApproval(input: ConversationInput, frame: FrameOf<'approval'>): ConversationResult {
  const { state } = input
  const approval = frame.approval
  if (approval.sessionId !== state.openSessionId) return unchanged(input)
  if (approval.state !== 'open') {
    return {
      state: { ...state, approvals: state.approvals.filter((a) => a.approvalId !== approval.approvalId) },
      stream: input.stream,
      effects: [],
    }
  }
  const entry: ApprovalRequest = {
    sessionId: approval.sessionId,
    approvalId: approval.approvalId,
    callId: approval.callId ?? null,
    tool: approval.tool,
    reason: approval.reason,
    answerable: approval.answerable,
    actions: approval.actions,
    state: approval.state,
  }
  return {
    state: {
      ...state,
      approvals: [...state.approvals.filter((a) => a.approvalId !== entry.approvalId), entry],
    },
    stream: input.stream,
    effects: [],
  }
}

function onApprovalSettled(input: ConversationInput, frame: FrameOf<'approval-settled'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  return {
    state: { ...state, approvals: state.approvals.filter((a) => a.approvalId !== frame.approvalId) },
    stream: input.stream,
    effects: [],
  }
}

/**
 * `session-state`：**权威快照**，整体替换该会话的 turnRunning / questions / approvals。
 *
 * 为什么必须「整体替换」而不是合并（M6 §2.3）：断线期间 Hub 侧仍在跑（WP46 的常驻会话代理），
 * 未决提问/审批被暂存下来；增量帧（`question` / `question-settled` / `approval*` / `turn`）在
 * 断线窗口里可能一条都没发出来。只有快照能把这些「错过的状态」一次校正干净。
 *
 * 语义细节：
 * - 只对**当前打开的会话**生效（别的会话的快照不动当前页）；
 * - `running=false` 时清掉残留的流式状态与 attempt 记账（回合已经结束/被停止）；
 * - `running=true` 时保留本地流式正文（快照只说明「在跑」，不提供增量），
 *   但把 attempt 记账对齐到快照给的 `attemptId`：后续 delta/baseline 的连续性按它判断；
 * - 快照里的审批只保留 `state='open'` 的（settled/expired 不该出现在手机上）。
 */
function onSessionState(
  input: ConversationInput,
  frame: FrameOf<'session-state'>,
): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)

  const questions: QuestionPrompt[] = frame.questions.map((item) => ({
    sessionId: frame.sessionId,
    agent: item.agent,
    callId: item.callId,
    questions: item.questions,
    state: item.state,
  }))
  const approvals: ApprovalRequest[] = frame.approvals
    .filter((item) => item.state === 'open')
    .map((item) => ({
      sessionId: item.sessionId,
      approvalId: item.approvalId,
      callId: item.callId ?? null,
      tool: item.tool,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
      answerable: item.answerable,
      actions: item.actions,
      state: item.state,
    }))

  const running = frame.running
  let stream = input.stream
  // 快照换了 attempt：本地流式正文属于旧 attempt，不能让新 attempt 的增量接在它后面
  // （记账对齐到新 attemptId 之后，onDelta 会把新增量当成「同一 attempt」直接追加）。
  let staleStream = false
  if (running) {
    if (frame.attemptId !== null && frame.attemptId !== stream.attemptId) {
      if (stream.attemptId !== null) {
        stream = markAttemptFinished(stream, stream.attemptId)
        staleStream = true
      }
      stream = { ...stream, attemptId: frame.attemptId, revision: -1, lastIndex: -1 }
    }
  } else {
    if (stream.attemptId) stream = markAttemptFinished(stream, stream.attemptId)
    stream = { ...stream, attemptId: null, revision: -1, lastIndex: -1 }
  }

  const nextState: WorkspaceState = {
    ...state,
    turnRunning: running,
    // 回合结束了就不该再显示「正在停止」；还在跑时保留用户的停止意图。
    stopRequested: running ? state.stopRequested : false,
    questions,
    approvals,
    ...(running && !staleStream
      ? {}
      : {
          streamingText: null,
          streamingReasoning: null,
          reasoningDone: false,
          streamingSettled: false,
        }),
  }
  return { state: nextState, stream, effects: [] }
}

function onStopped(input: ConversationInput, frame: FrameOf<'stopped'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  // `stopped.accepted` 只表示请求被接受；如果 turn/end 已经先到，就不要再把
  // 「正在停止」标志打回去（服务端的帧顺序不构成承诺，客户端要自洽）。
  const stopRequested = frame.accepted && state.turnRunning
  if (state.stopRequested === stopRequested) return unchanged(input)
  return { state: { ...state, stopRequested }, stream: input.stream, effects: [] }
}

function onReplay(input: ConversationInput, frame: FrameOf<'replay'>): ConversationResult {
  const { state } = input
  if (frame.sessionId !== state.openSessionId) return unchanged(input)
  // 重放边界 = 上一代通道的瞬态交互作废。adapter 的帧顺序保证：replay 之后紧跟
  // projection 帧，还活着的 timed 提问会立刻重新下发；没下发的就是已经死了。
  const cleared = clearChannelScoped(state)
  // 跟随流已经接上，再要一份最新的会话列表校正回合状态：hello 那一份可能早于
  // catch-up，正好卡在「列表说还在跑、其实刚结束」的窗口里（漏掉 turn/end 就永远停不下来）。
  // 只在客户端还认为在跑时要，避免每次订阅都多一个来回。
  const needsTurnSync = state.turnRunning || state.streamingText !== null
  return {
    state: cleared,
    stream: input.stream,
    effects: [{ type: 'replay', sessionId: frame.sessionId, toCursor: frame.toCursor, needsTurnSync }],
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

const MAX_FINISHED_ATTEMPTS = 32

function markAttemptFinished(stream: ConversationStreamState, attemptId: string): ConversationStreamState {
  if (!attemptId || stream.finishedAttempts.includes(attemptId)) return stream
  const finishedAttempts = [...stream.finishedAttempts, attemptId]
  while (finishedAttempts.length > MAX_FINISHED_ATTEMPTS) finishedAttempts.shift()
  return { ...stream, finishedAttempts }
}

function unchanged(input: ConversationInput): ConversationResult {
  return { state: input.state, stream: input.stream, effects: [] }
}

/**
 * DSH 事件的 seq 归一化：缺失/非正数一律当 null。
 *
 * 不能留 0：`mergeThread` 按 seq 升序排，0 会排到会话最上面 —— 表现就是
 * 「AI 的回复跑到了我提问的上面」。
 */
export function normalizeSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 「只思考 / 只调工具、没有正文」的中间 assistant 步骤。
 *
 * 真实 DSH 的一轮回复由多个 `assistant/message` 组成（先思考+联网搜索，再出答案）。
 * 这些中间步骤如果也单独成条，一轮回复里会出现多个「思考过程」块、中间夹空行，
 * 看起来像消息排列乱了。历史与实时两条路都把它们丢掉，只留真正有正文的消息。
 */
export function isThinkingOnlyStep(role: string, text: string): boolean {
  return role === 'assistant' && text.trim() === ''
}

/** 按 seq 去重（后到的同 seq 覆盖先到的），无 seq 的排在前面。 */
export function dedupeBySeq(entries: ChatEntry[]): ChatEntry[] {
  const bySeq = new Map<number, ChatEntry>()
  const noSeq: ChatEntry[] = []
  for (const entry of entries) {
    if (entry.seq == null) noSeq.push(entry)
    else bySeq.set(entry.seq, entry)
  }
  return [...noSeq, ...[...bySeq.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))]
}

interface RawModelSelection {
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
  next?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  lastUsed?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
}

/** DSH 的 modelSelection 投影是 `{lastUsed, next}`；`next` 才是已选未发的值。 */
export function unwrapModelSelection(
  raw: unknown,
): { provider: string; model: string; effort?: string } | null {
  const value = raw as RawModelSelection | null | undefined
  const picked = value?.next ?? value?.lastUsed ?? value
  if (!picked || typeof picked.provider !== 'string' || typeof picked.model !== 'string') return null
  const effort = typeof picked.reasoningEffort === 'string' ? picked.reasoningEffort : undefined
  return { provider: picked.provider, model: picked.model, ...(effort === undefined ? {} : { effort }) }
}

/** 把 `{provider, model, effort}` 映射成 App 的档位选择（目录在就按目录，缺省按 DSH effort）。 */
export function selectionOf(
  catalog: BackendModelCatalog | null,
  value: { provider: string; model: string; effort?: string },
): ModelSelection | null {
  if (catalog) {
    return selectionFromServer(catalog, {
      provider: value.provider,
      model: value.model,
      ...(value.effort === undefined ? {} : { effort: value.effort }),
    })
  }
  return {
    provider: value.provider,
    model: value.model,
    effortTier: tierOfDshEffort(value.effort),
  }
}
