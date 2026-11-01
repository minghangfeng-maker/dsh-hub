/**
 * 与 `@dsh-hub/shared` 的 `MobileClientFrame` / `MobileServerFrame` **结构等价**的本地类型。
 *
 * 为什么不在这个包里依赖 `@dsh-hub/shared`：本包要能作为可移植 npm 包交给桌面端（M3），
 * 不能依赖 Hub 仓库的 workspace 包或绝对路径。Hub 侧在收帧时用 zod 再校验一次；
 * 本包只负责翻译，不承担线上校验职责（这也是它零运行时依赖的原因）。
 */

/**
 * v2 能力位（契约 §3）：由**真实调用**探测得出，不是配置声明。
 * 只有云节点在 Hub 进程内探测；桌面节点靠它自己的 adapter 探测后经 hello 回显。
 */
export interface NodeCapabilitiesV2 {
  /** `session/modelCatalog` + `session/selectModel` 都可达 */
  models: boolean
  /** `session/rename` 可达 */
  rename: boolean
  /** `workspace/archiveSession|unarchiveSession` + `workspace/follow` 基线可达 */
  archive: boolean
  /** `workspaceFiles/stat|read|readBytes` 可达 */
  filesRead: boolean
  /** `workspaceFiles/list` 可达 */
  filesList: boolean
  /** `/api/session/uploadFileBinary` 或 `fileUploads/upload` 可达 */
  filesUpload: boolean
  /** `present` 工具在册（事件能力，探测不可靠，恒 true） */
  deliverables: boolean
}

/** 会话用量统计（只读聚合，口径见 `MobileSessionUsageStatsSchema`）。 */
export interface SessionUsageStats {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  assistantMessages: number
  userMessages: number
  turns: number
  truncated: boolean
  /** 会话积分消耗（微积分）；Hub 没有计费钩子/模型没价格信息时省略。 */
  pointsMicro?: number
  /** pointsMicro 里是否只统计了部分消息（有消息没有价格信息）。 */
  pointsEstimated?: boolean
}

/**
 * v2 特性 id（§17 D1）：客户端在 `hello.features` 里声明，adapter 只对
 * 「双方都支持」的特性发新帧，并在 hello 里回显实际启用的集合。
 */
export type MobileV2Feature =
  | 'models'
  | 'tools'
  | 'reasoning'
  | 'files'
  | 'deliverables'
  | 'attachments'
  | 'rename'
  | 'archive'
  | 'usage'
  /** WP46：`session-state` 快照 / `session-state-request`（由 Hub 的 NodeSession 提供）。 */
  | 'session-state'

export const MOBILE_V2_FEATURES: readonly MobileV2Feature[] = [
  'models',
  'tools',
  'reasoning',
  'files',
  'deliverables',
  'attachments',
  'rename',
  'archive',
  'usage',
  'session-state',
]

/** 节点能力：由真实调用探测得出，不是配置声明。 */
export interface NodeCapabilities {
  sessions: boolean
  history: boolean
  send: boolean
  stop: boolean
  stream: boolean
  questions: boolean
  approvals: boolean
  create: boolean
}

export interface NodeInfo {
  id: string
  kind: 'cloud' | 'desktop'
  name: string
  status: string
}

/** 发消息时的附件引用（`uploadId` 由 adapter 在 `uploaded` 帧里签发）。 */
export interface MobileOutgoingAttachment {
  kind: 'image' | 'file'
  uploadId: string
  name: string
  mimeType: string
  bytes: number
}

export type MobileClientFrame =
  | {
      v: 1
      type: 'hello'
      requestId: string
      client: { name: string; version: string }
      /** 声明客户端认识的 v2 特性；不声明 = 老客户端，adapter 行为与 v1 完全一致。 */
      features?: MobileV2Feature[]
    }
  | { v: 1; type: 'sessions'; requestId: string; refresh?: boolean; includeArchived?: boolean }
  | {
      v: 1
      type: 'history'
      requestId: string
      sessionId: string
      beforeSeq?: number | null
      limit?: number
    }
  | {
      v: 1
      type: 'create'
      requestId: string
      title?: string
      /** v2：实例上真实存在的 agent preset id（下发的「普通对话」预设）。 */
      preset?: string
      /** v2：新建后立刻 selectModel（cwd 由 adapter 写死，客户端不能传）。 */
      provider?: string
      model?: string
      effort?: string
    }
  | {
      v: 1
      type: 'send'
      requestId: string
      sessionId: string
      text: string
      mode?: 'queue' | 'steer'
      clientMessageId: string
      /** v2：先经上传帧拿到 `uploadId`，这里只引用。 */
      attachments?: MobileOutgoingAttachment[]
    }
  | { v: 1; type: 'stop'; requestId: string; sessionId: string }
  | { v: 1; type: 'subscribe'; requestId: string; sessionId: string; sinceCursor?: number | null }
  | { v: 1; type: 'unsubscribe'; sessionId: string }
  | {
      v: 1
      type: 'answer-approval'
      requestId: string
      sessionId: string
      approvalId: string
      decision: 'approve' | 'reject'
    }
  | {
      v: 1
      type: 'answer-question'
      requestId: string
      sessionId: string
      agent: string
      callId: string
      answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }>
    }
  | { v: 1; type: 'ping'; t: number }
  // ── v2 独有帧（都要先协商对应特性） ──
  | { v: 1; type: 'models'; requestId: string; sessionId?: string }
  | {
      v: 1
      type: 'set-model'
      requestId: string
      sessionId: string
      provider: string
      model: string
      effort?: string
    }
  | { v: 1; type: 'rename'; requestId: string; sessionId: string; title: string }
  | { v: 1; type: 'archive'; requestId: string; sessionId: string; archived: boolean }
  | { v: 1; type: 'usage'; requestId: string; sessionId: string }
  /**
   * WP46（M6 §2.2.4）：按会话读一份权威快照。
   *
   * 云节点的这条帧由 Hub 的 NodeSession 直接回包（本地快照，不下发 Host）；
   * 适配器只在「有人把它转给 adapter」时防御性回 `feature-unsupported`。
   */
  | { v: 1; type: 'session-state-request'; requestId: string; sessionId: string }
  | {
      v: 1
      type: 'file-read'
      requestId: string
      sessionId: string
      fileRef?: string
      path?: string
    }
  | { v: 1; type: 'file-list'; requestId: string; sessionId: string; path: string }
  | {
      v: 1
      type: 'upload-begin'
      requestId: string
      sessionId: string
      kind: 'image' | 'file'
      name: string
      mimeType: string
      bytes: number
    }
  | {
      v: 1
      type: 'upload-chunk'
      requestId: string
      uploadId: string
      seq: number
      data: string
      final?: boolean
    }
  | { v: 1; type: 'upload-abort'; uploadId: string }

export interface SessionRow {
  sessionId: string
  title: string | null
  updatedAt: number
  running: boolean
  blank: boolean
  agentAvailable: boolean
  origin?: string | null
}

/** v2 会话行：多一个「已归档」标记（§17 D5：归档页签靠它，列表默认不含归档）。 */
export interface SessionRowV2 extends SessionRow {
  archived?: boolean
}

export interface HistoryItem {
  seq: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  at: number
  text: string
  clientMessageId?: string
  tools?: string[]
  /** v2：思考过程（截断到 16 KiB）；DSH 的 assistant-baseline 不含 reasoning，只有这里能补。 */
  reasoning?: string
}

/** 模型目录条目（手机 `models` 帧的 items[]）。 */
export interface ModelEffortView {
  id: string
  name: string
  description?: string
  /** App 四档；null = 不进四档（别的 provider 起的名字，UI 忽略）。 */
  tier: 'low' | 'medium' | 'high' | 'ultra' | null
}

export interface ModelView {
  provider: string
  model: string
  name: string
  description: string | null
  efforts: ModelEffortView[]
  defaultEffort: string | null
  /** 输入模态：`image` 恒 null（不做图片能力位，Hub 不猜）。 */
  input: { text: true; image: boolean | null }
  /** 渠道倍率（1 = 原价，0.3 = 三折）；Hub 拿不到价格信息时省略。 */
  multiplier?: number
}

export interface ModelSelectionView {
  provider: string
  model: string
  effort?: string
}

/** 一次文件引用：`fileRef` 对 App 不透明，`pathLabel` 永不带绝对路径。 */
export interface FileRefView {
  fileRef: string
  name: string
  pathLabel: string
  mediaType: 'image' | 'file'
  mimeType?: string
  bytes?: number
}

export interface QuestionOption {
  label: string
  description?: string
}
export interface Question {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

/** 审批视图（`approval` 帧的 `approval` 字段；WP46 抽成命名类型供 session-state 复用）。 */
export interface ApprovalView {
  sessionId: string
  callId: string | null
  approvalId: string
  tool: string
  reason?: string
  answerable: boolean
  actions: Array<'approve' | 'reject' | 'cancel'>
  state: 'open' | 'settled' | 'expired'
  decision?: 'approve' | 'reject'
}

/**
 * 未决提问视图（与 `@dsh-hub/shared` 的 `MobilePendingQuestion` 结构等价）：
 * `session-state` 的 `questions[]` 元素，与 `question` 帧同构但**不带** sessionId。
 */
export interface PendingQuestionView {
  agent: string
  callId: string
  questions: Question[]
  state: 'open' | 'continued'
}

/**
 * 一个会话的回合/未决交互快照（WP46 / M6 §2.1）。
 *
 * Hub 的 NodeSession 把它包成 `session-state` 帧（补 sessionId/at）。
 * 只有 `parkInteractions` 打开时 Hub 才会问它：老调用方与桌面端不需要。
 */
export interface SessionRuntimeState {
  /** 该会话 follow 的 opening cursor（未知 = null）。 */
  cursor: number | null
  /** Host 的 agent 运行态。 */
  running: boolean
  /** 进行中的 attempt（running=false 时为 null）。 */
  attemptId: string | null
  questions: PendingQuestionView[]
  approvals: ApprovalView[]
}

export type MobileNodeBlockedReason =
  | 'desktop-remote-off'
  | 'desktop-relay-disconnected'
  | 'desktop-host-stopped'
  | 'desktop-needs-upgrade'
  | 'adapter-incompatible'
  | 'adapter-probe-failed'
  | 'instance-not-running'

export type MobileErrorCode =
  | 'unauthenticated'
  | 'session-expired'
  | 'node-not-found'
  | 'node-offline'
  | 'node-not-connectable'
  | 'instance-not-running'
  | 'adapter-incompatible'
  | 'adapter-unavailable'
  | 'session-not-found'
  | 'agent-busy'
  | 'question-not-answerable'
  | 'approval-not-answerable'
  | 'approval-expired'
  | 'send-in-flight'
  | 'protocol-version-unsupported'
  | 'rate-limited'
  | 'frame-too-large'
  | 'upstream-unavailable'
  | 'relay-disconnected'
  | 'internal'
  // ── v2 新增（契约 §13） ──
  | 'model-unavailable'
  | 'effort-unsupported'
  | 'preset-not-found'
  | 'title-invalid'
  | 'file-not-found'
  | 'file-refused'
  | 'file-too-large'
  | 'file-not-text'
  | 'archive-unsupported'
  | 'rename-unsupported'
  | 'feature-unsupported'

/** 工具卡的种类白名单（契约 §7.2；未知工具统一 `other`）。 */
export type ToolKind =
  | 'bash'
  | 'python'
  | 'search'
  | 'fetch'
  | 'file-read'
  | 'file-write'
  | 'present'
  | 'question'
  | 'agent'
  | 'other'

export type MobileServerFrame =
  | {
      v: 1
      type: 'hello'
      requestId: string
      node: NodeInfo
      capabilities: NodeCapabilities
      subscribed: string[]
      serverTime: number
      /** v2：**实际启用**的特性（客户端只认回显，不认自己声明的）。 */
      features?: MobileV2Feature[]
      capabilitiesV2?: NodeCapabilitiesV2
    }
  | { v: 1; type: 'sessions'; requestId: string; items: SessionRowV2[] }
  | {
      v: 1
      type: 'history'
      requestId: string
      sessionId: string
      items: HistoryItem[]
      nextBeforeSeq: number | null
      cursor: number | null
      hasMore: boolean
    }
  | {
      v: 1
      type: 'created'
      requestId: string
      sessionId: string
      /** v2：回显真正生效的 preset / model（与请求可能不同）。 */
      preset?: string
      model?: ModelSelectionView
      /** v2：例如 selectModel 失败但会话已建好（不回滚）。 */
      warning?: { code: MobileErrorCode; message: string }
    }
  | { v: 1; type: 'ack'; requestId: string; clientMessageId?: string }
  | {
      v: 1
      type: 'error'
      requestId?: string
      code: MobileErrorCode
      message: string
      retryable: boolean
    }
  | {
      v: 1
      type: 'message'
      sessionId: string
      seq: number
      role: 'user' | 'assistant' | 'system'
      at: number
      text: string
      clientMessageId?: string
      tools?: string[]
    }
  | {
      v: 1
      type: 'delta'
      sessionId: string
      attemptId: string
      revision: number
      index: number
      turn: number | null
      step: number | null
      part: { kind: 'text' | 'reasoning' | 'tool' | 'unknown'; text?: string }
      raw?: unknown
      /** v2：该块结束（`block-end`），App 不用靠超时收起「正在思考」。 */
      done?: true
    }
  | { v: 1; type: 'delta-end'; sessionId: string; attemptId: string; revision: number; committed: boolean }
  | {
      v: 1
      type: 'turn'
      sessionId: string
      phase: 'start' | 'end'
      turn: number
      reason?: string
    }
  | { v: 1; type: 'state'; sessionId: string; key: string; value: unknown; seq: number | null }
  | {
      v: 1
      type: 'question'
      sessionId: string
      agent: string
      callId: string
      questions: Question[]
      state: 'open' | 'continued' | 'settled'
    }
  | {
      v: 1
      type: 'assistant-baseline'
      sessionId: string
      attemptId: string
      revision: number
      nextIndex: number
      text: string
      /** 进行中思考的已有内容（尾部 ≤ 8000 字）；老 Hub 不发。 */
      reasoning?: string
    }
  | {
      v: 1
      type: 'question-settled'
      sessionId: string
      callId: string
      answers?: Array<{ id: string; selected: string[]; custom?: string }>
    }
  | {
      v: 1
      type: 'approval'
      sessionId: string
      approval: ApprovalView
    }
  | {
      v: 1
      type: 'approval-settled'
      sessionId: string
      approvalId: string
      decision: 'approve' | 'reject' | 'expired'
    }
  | { v: 1; type: 'stopped'; requestId: string; sessionId: string; accepted: boolean }
  | {
      v: 1
      type: 'answer-result'
      requestId: string
      sessionId: string
      accepted: boolean
      continued: boolean
    }
  | { v: 1; type: 'replay'; sessionId: string; fromCursor: number | null; toCursor: number }
  | {
      v: 1
      type: 'capability'
      capabilities: NodeCapabilities
    }
  | {
      v: 1
      type: 'node-status'
      node: { id: string; connectable: boolean; reason?: MobileNodeBlockedReason }
    }
  | { v: 1; type: 'pong'; t: number }
  | { v: 1; type: 'bye'; code: MobileErrorCode; reason: string }
  // ── v2 独有帧 ──
  | {
      v: 1
      type: 'models'
      requestId: string
      default: ModelSelectionView
      current?: ModelSelectionView
      items: ModelView[]
      failures: { provider: string; name: string; message: string }[]
    }
  | {
      v: 1
      type: 'model-changed'
      requestId?: string
      sessionId: string
      provider: string
      model: string
      effort?: string
    }
  | {
      v: 1
      type: 'tool'
      sessionId: string
      callId: string
      kind: ToolKind
      name: string
      phase: 'start' | 'end'
      seq: number
      turn: number
      step: number
      status?: 'running' | 'ok' | 'error'
      title: string
      inputPreview?: string
      outputPreview?: string
      inputBytes?: number
      outputBytes?: number
      truncated?: { input?: true; output?: true }
      files?: FileRefView[]
      citations?: { title?: string; url: string }[]
      error?: { name: string; code: string; reason?: string }
      durationMs?: number
    }
  | {
      v: 1
      type: 'deliverable'
      sessionId: string
      seq: number
      turn: number
      callId: string
      files: FileRefView[]
    }
  | {
      v: 1
      type: 'renamed'
      requestId: string
      sessionId: string
      title: string
      seq: number
    }
  | {
      v: 1
      type: 'archived'
      requestId: string
      sessionId: string
      archived: boolean
      sessionIds: string[]
    }
  | {
      v: 1
      type: 'usage'
      requestId: string
      sessionId: string
      stats: SessionUsageStats
    }
  | {
      v: 1
      type: 'file'
      requestId: string
      sessionId: string
      fileRef: string
      name: string
      mediaType: 'image' | 'file'
      mimeType: string
      bytes: number
      encoding: 'base64'
      data: string
      sha256?: string
    }
  | {
      v: 1
      type: 'file-chunk'
      requestId: string
      sessionId: string
      fileRef: string
      seq: number
      final: boolean
      encoding: 'base64'
      data: string
      bytes?: number
      sha256?: string
    }
  | {
      v: 1
      type: 'file-list'
      requestId: string
      sessionId: string
      path: string
      entries: { name: string; kind: 'file' | 'directory' | 'other'; bytes?: number; fileRef?: string }[]
      truncated: boolean
    }
  | {
      v: 1
      type: 'upload-started'
      requestId: string
      uploadId: string
      maxChunkBytes: number
    }
  | {
      v: 1
      type: 'upload-received'
      requestId: string
      uploadId: string
      seq: number
      received: number
    }
  | {
      v: 1
      type: 'uploaded'
      requestId: string
      uploadId: string
      kind: 'image' | 'file'
      name: string
      mimeType: string
      bytes: number
      expiresAt: number
    }

export type FrameSink = (frame: MobileServerFrame) => void | Promise<void>

/** 最小 WebSocket 抽象：默认实现见 `ws.ts`，测试与桌面可注入自己的。 */
export interface WebSocketLike {
  send(text: string): void
  close(code?: number, reason?: string): void
  onText(listener: (text: string) => void): void
  onClose(listener: (code: number, reason: string) => void): void
  onError(listener: (error: Error) => void): void
}

export interface NodeRemoteOptions {
  /** DSH Host origin，例如 `http://127.0.0.1:3000` 或 `http://172.17.0.5:3000`。 */
  origin: string
  /** 每次请求前取 header（云：`{cookie, host:'127.0.0.1:3000'}`；桌面：`{cookie?}`）。 */
  headers?: () => Promise<Record<string, string>> | Record<string, string>
  /** 测试注入；缺省用全局 fetch。 */
  fetch?: typeof fetch
  /** 测试/桌面注入；缺省用内置 WS 客户端（支持自定义 header）。 */
  createWebSocket?: (url: string, headers: Record<string, string>) => Promise<WebSocketLike>
  /** 能力探测超时；默认 5000ms。 */
  probeTimeoutMs?: number
  /**
   * 取「follow opening cursor」的超时（history/usage 用）；默认 8000ms。
   *
   * 比 probe 宽松：容器刚唤醒 / 手机通道刚重连时，第一条 mux 连接 + Host follow
   * 建立可能超过 3s，用 probe 的短超时会把可恢复的临时失败当成 cursor 拿不到
   * （真机 2026-10-26 21:01 的 upstream-unavailable 就有这个成分）。
   */
  cursorTimeoutMs?: number
  /** 节点身份（用于 hello 帧）。 */
  node: NodeInfo
  /**
   * 新建会话的对话目录（v2，§17）。
   *
   * 云节点缺省 `/workspace/chat`（adapter 写死，客户端不能传 cwd）；桌面节点
   * 缺省「不传 cwd」——由桌面自己的 DSH 用 `defaultCwd` 决定（adapter 不猜 Windows 路径）。
   */
  chatDir?: string
  /** 额外允许读取的绝对路径根（缺省只有会话 cwd 与 `<chatDir>/artifacts`）。 */
  fileRoots?: readonly string[]
  /** 单附件上限；缺省云 20 MiB / 桌面 1 MiB（中继帧限制，§17 D4）。 */
  maxUploadBytes?: number
  /**
   * 计费钩子（可选，Hub 注入）：给模型列表带渠道倍率、给用量统计算积分消耗。
   * 缺省 = 老行为（不发 multiplier / pointsMicro），老客户端与其它调用方逐字节不变。
   */
  pricing?: ModelPricingHooks
  /**
   * 常驻会话代理模式（WP46 / M6 §1）—— 打开后未决交互的行为改变：
   *
   * - `user-questions/request` / `approval/request` **无论该会话是否有手机订阅**都接住；
   * - 通道 `unsubscribe`（含最后一条通道断开）**不再**回 `{kind:'next'}`；
   * - 审批不再 120 秒超时 next，改为 `parkMs`（默认 30 分钟）到点才 next；
   * - 只有 park 上限、`close()`（容器停止/登出/Hub 关闭）、回合被停止/结束才 next。
   *
   * 缺省（不传）= 现有行为，桌面端与老调用方**逐字节不变**。
   */
  parkInteractions?: {
    /** 暂存上限（毫秒），到点 next；缺省 `DEFAULT_INTERACTION_PARK_MS`（30 分钟）。 */
    parkMs?: number
  }
  /** 只允许记事件名/计数，**禁止**记正文。 */
  log?: (event: string, meta?: Record<string, unknown>) => void
}

/** 一次 assistant/message 的用量（价格按消息自己的模型算）。 */
export interface UsageTokensForPricing {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Hub 注入的计费钩子：同步、允许返回 null（该模型没有价格信息）。 */
export interface ModelPricingHooks {
  /** DSH 模型 id（例如 `deepseek-v4.1-flash@upstream-b`）→ 渠道倍率（0.1 / 0.3 / 1…）。 */
  multiplierOf?: (modelId: string) => number | null
  /** 一条 assistant/message → 这次请求消耗的微积分（与 Hub 计费同公式）。 */
  costMicroOf?: (input: {
    provider: string
    model: string
    tokens: UsageTokensForPricing
  }) => number | null
}

/** 只读 readiness 探测结果（不打开 answering `$events`）。 */
export interface NodeProbeResult {
  compatible: boolean
  capabilities: NodeCapabilities
  missing: string[]
  /** 探测本身失败（鉴权/网络/内部错误）的诊断原因；存在时 compatible 必须为 false。 */
  failure?: string
}

export interface NodeRemote {
  readonly capabilities: NodeCapabilities
  /** v2 能力位（hello 协商后才有值；探测前是缺省 false）。 */
  readonly capabilitiesV2?: NodeCapabilitiesV2
  /** 已启用的 v2 特性（hello 协商后才有值；老客户端为空）。 */
  readonly features?: readonly MobileV2Feature[]
  readonly compatible: boolean
  readonly missing: readonly string[]
  readonly node: NodeInfo
  /** 处理一个手机帧；流式帧通过 sink 持续推送。 */
  dispatch(frame: MobileClientFrame, sink: FrameSink): Promise<void>
  /** 关闭所有流与连接；幂等。 */
  close(): Promise<void>
  /**
   * 该会话的回合/未决交互快照（WP46 `session-state`）。
   *
   * 可选：只由支持常驻会话代理的实现提供；缺省时 Hub 当作「什么都不知道」。
   */
  sessionState?(sessionId: string): SessionRuntimeState
  /** 每个会话的未决交互数（提问 + 审批，按 callId 去重，只含 >0 的会话）。 */
  pendingInteractions?(): ReadonlyMap<string, number>
  /** 有回合在跑的会话 id（Hub 用它决定 NodeSession 能不能关）。 */
  runningSessions?(): readonly string[]
  /**
   * 该会话是否已有**活着的跟随流**（WP46 返工：一条 follow 服务多条通道）。
   *
   * Hub 的 NodeSession 用它决定：新来的 subscribe 是「加入已有 follow」（补一份自己的
   * catch-up/replay/基线/快照，不动别人的流）还是真的新建一条 follow。
   */
  isFollowing?(sessionId: string): boolean
  /** 最近一次推给客户端的 `assistant-baseline`（加入者补基线；没有进行中的 attempt = null）。 */
  sessionBaseline?(sessionId: string): Extract<MobileServerFrame, { type: 'assistant-baseline' }> | null
  /** 最近一次的白名单投影值（加入者补 `state` 帧）。 */
  sessionProjections?(sessionId: string): ReadonlyArray<{ key: string; value: unknown }>
  /** 给后来加入的通道补一次断线追赶：帧只回调给调用方，不动已有 follow。 */
  catchUpFor?(sessionId: string, sinceCursor: number | null, emit: FrameSink): Promise<'ok' | 'gap'>
}

/** 探测到 Host 缺关键端点：调用方据此给 `adapter-incompatible`，绝不返回空列表。 */
/** 探测过程本身失败（401/网络/内部）：区别于「Host 缺端点」，调用方应报 adapter-probe-failed。 */
export class NodeRemoteProbeError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'NodeRemoteProbeError'
  }
}

export class NodeRemoteIncompatibleError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[]) {
    super(`DSH Host 缺少移动端必需端点：${missing.join(', ')}`)
    this.name = 'NodeRemoteIncompatibleError'
    this.missing = missing
  }
}
