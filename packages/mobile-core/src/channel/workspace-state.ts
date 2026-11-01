/**
 * 工作区状态的**形状**：UI 直接渲染的那份 `WorkspaceState`，以及它的组成类型。
 *
 * 这里只有类型与常量，没有行为。`WorkspaceController` 是门面，内部按职责拆成
 * `connection` / `requests` / `sessions` / `conversation` / `conversation-stream` /
 * `actions` / `file-service` / `upload-service` 等模块；它们都只依赖本文件里的形状，
 * 互相之间不 import（避免环）。
 *
 * **纪律：`WorkspaceState` 的字段一个都不能改名/删除/改语义**——UI 包一行不改地消费它，
 * 现有测试也只按这个形状断言。
 */

import type { z } from 'zod'
import type { MobileHistoryItem, MobileQuestionSchema } from '@dsh-hub/shared'
import type { AnyServerFrame } from './wire.js'
import type { CreateFrameOptions } from './wire.js'
import type { ChannelLink } from './link.js'
import type {
  MobileNodeCapabilitiesFull,
  MobileSessionUsageStats,
  MobileSessionRowV2,
} from '../contracts/mobile-v2.js'
import type { MobileFileRef } from '../contracts/mobile-v2.js'
import type { MobileOutgoingAttachment } from '../contracts/mobile-v2.js'
import type { DeliverableItem, ToolCard } from './tools.js'
import type { UploadTaskView } from './upload.js'
import type { FileCache } from './files.js'
import type { BackendModelCatalog, ModelSelection } from '../models/catalog.js'
import type { ClientIdentity } from './wire.js'
import type { FileStore } from '../cache/file-store.js'
import type { OutboxProblem, OutboxStore } from '../cache/outbox-store.js'

/** shared 只导出了 schema，没有导出它的 inferred 类型；在这里补一个别名。 */
export type MobileQuestion = z.infer<typeof MobileQuestionSchema>

/** 从 v1+v2 联合里取出某个帧类型（`Extract` 在联合上会保留所有匹配成员）。 */
export type FrameOf<T extends string> = Extract<AnyServerFrame, { type: T }>

/** history 帧里的一行（adapter 的持久消息）。 */
export type HistoryItem = MobileHistoryItem

export type LinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed'

export interface ChatEntry {
  seq: number | null
  /** 本地气泡身份 = clientMessageId（服务端消息为 null） */
  localId: string | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  tools: string[]
  /** 思考过程（history 里的 reasoning，或 live 回合结束后搬过来的增量）。 */
  reasoning?: string
  /** 用户消息的幂等键：服务端持久化的 rpcId。用于把本地附件预览贴回 canonical 气泡。 */
  clientMessageId?: string
  at: number
  pending: boolean
  failed: boolean
  /** 结果未知（断线/超时）：不显示「发送中」，由用户显式重试（沿用同一 id）。 */
  unknown: boolean
}

export interface QuestionPrompt {
  sessionId: string
  agent: string
  callId: string
  questions: MobileQuestion[]
  state: string
}

export interface ApprovalRequest {
  sessionId: string
  approvalId: string
  callId: string | null
  tool: string
  reason?: string
  answerable: boolean
  actions: Array<'approve' | 'reject' | 'cancel'>
  state: 'open' | 'settled' | 'expired'
}

export interface UiError {
  code: string
  message: string
  retryable: boolean
}

/**
 * 待发气泡里的一条（发送队列 `Outbox` 的只读投影）。
 *
 * `id` 同时是这条消息将来的 `clientMessageId`：气泡从「待发」变成「发送中」时身份不变，
 * UI 不需要重新对图（附件缩略图按同一个 id 挂在 `messageAttachments` 上）。
 */
export interface OutboxEntryView {
  id: string
  text: string
  /** 入队时间（毫秒）。 */
  at: number
  /** 排进哪个会话；null = 还没有会话（发送前要先建）。 */
  sessionId: string | null
  /**
   * 附件有问题：**条目停在队列里**，等用户决定（重试 / 去掉附件只发文字 / 删除）。
   *
   * 绝不自动丢附件把文字发出去——用户会以为图发了，其实没发。
   */
  problem?: OutboxProblem
}

/**
 * 附件在 UI 侧的本地状态（Outbox 判定「能不能发了」用）。
 *
 * `missing` = 跨重启后这条附件的字节已经找不到了（队列只存 localId，不存字节）。
 */
export type OutboxAttachmentState =
  | 'local'
  | 'uploading'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'missing'

export interface WorkspaceState {
  link: LinkState
  nodeId: string
  capabilities: MobileNodeCapabilitiesFull | null
  /** 服务端回显的 v2 特性（hello.features 的子集）；空数组 = v1 降级。 */
  features: string[]
  /** 模型目录（v2 `models` 帧）；null = 还没拿到，UI 用本地 mock 目录兜底。 */
  models: BackendModelCatalog | null
  /** 当前会话的模型选择（投影/created 给出；不是 App 的本地记忆）。 */
  modelSelection: ModelSelection | null
  /** 当前会话的用量（`usage` 帧结果）；null = 没请求过/已清空。 */
  sessionUsage: MobileSessionUsageStats | null
  /** `sessionUsage` 属于哪个会话（切会话后旧数据不显示）。 */
  sessionUsageSessionId: string | null
  sessionUsageLoading: boolean
  /** 用量请求失败的人话原因（不污染全局 error 条）。 */
  sessionUsageError: string | null
  nodeConnectable: boolean
  /** 服务端给出的不可连接原因（M4 §3.1），发送入口据此给具体提示。 */
  nodeBlockedReason: string | null
  sessions: MobileSessionRowV2[]
  /** 当前列表是否包含已归档会话（§17 D5）。 */
  sessionsIncludeArchived: boolean
  sessionsLoading: boolean
  openSessionId: string | null
  messages: ChatEntry[]
  streamingText: string | null
  streamingReasoning: string | null
  /** 思考块已经收到 `delta.done`（可以立即收起「正在思考」，不靠超时）。 */
  reasoningDone: boolean
  streamingSettled: boolean
  /** 工具卡（同一 callId 只有一张，start 先到 end 覆盖）。 */
  toolCards: ToolCard[]
  /** 交付物（`deliverables/presented`）。 */
  deliverables: DeliverableItem[]
  /** 附件上传任务视图（不含 base64）。 */
  uploads: UploadTaskView[]
  turnRunning: boolean
  stopRequested: boolean
  historyHasMore: boolean
  historyLoading: boolean
  nextBeforeSeq: number | null
  questions: QuestionPrompt[]
  approvals: ApprovalRequest[]
  error: UiError | null
  reconnectAttempt: number
  pendingSendCount: number
  /**
   * 发送队列（还没真正发出去的消息）：唤醒/断线期间打的字、等建会话的首条、等附件上传的。
   *
   * 会话页面把它们画成「待发气泡」（`pending: true` 的本地消息），按会话过滤：
   * `sessionId === null`（待建会话）或等于当前打开的会话。
   */
  outbox: OutboxEntryView[]
}

/** 初始状态（字段顺序与形状即 UI 契约）。 */
export function initialWorkspaceState(nodeId: string): WorkspaceState {
  return {
    link: 'idle',
    nodeId,
    capabilities: null,
    features: [],
    models: null,
    modelSelection: null,
    nodeConnectable: true,
    nodeBlockedReason: null,
    sessions: [],
    sessionsIncludeArchived: false,
    sessionsLoading: false,
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
    stopRequested: false,
    historyHasMore: false,
    historyLoading: false,
    nextBeforeSeq: null,
    questions: [],
    approvals: [],
    error: null,
    sessionUsage: null,
    sessionUsageSessionId: null,
    sessionUsageLoading: false,
    sessionUsageError: null,
    reconnectAttempt: 0,
    pendingSendCount: 0,
    outbox: [],
  }
}

export interface WorkspaceControllerOptions {
  nodeId: string
  client: ClientIdentity
  /** 每次（重）连都重新申请 ticket 并建一条新通道。 */
  openChannel: (nodeId: string) => Promise<ChannelLink>
  now?: () => number
  /** 25s 客户端心跳；单测关掉。 */
  keepAlive?: boolean
  /** 心跳间隔（默认 25s；单测可注入更短值）。 */
  keepAliveMs?: number
  /**
   * 多久没有收到任何下行帧就判定「链路已死」（默认 55s：25s 心跳连丢两次再多给 5s）。
   *
   * 场景：手机切后台/换网后 TCP 半边开——浏览器没收到 close，看起来还连着，
   * 但发出去的帧都进黑洞（改思考程度/归档因此超时）。靠心跳 + pong 发现后主动重连。
   */
  linkDeadMs?: number
  reconnect?: { baseMs?: number; maxMs?: number; maxAttempts?: number }
  /** 登录/设备失效时回调（UI 回登录页）。 */
  onSessionExpired?: () => void
  /** 诊断回调（不记录正文）。 */
  log?: (event: string, meta?: Record<string, unknown>) => void
  /** 产出文件缓存（UI 可注入共享实例；缺省自己建一个 32MiB 的）。 */
  fileCache?: FileCache
  /**
   * 持久文件缓存（跨重启；IndexedDB）。
   *
   * 不传 = 只有内存缓存（Web 开发/单测默认也可不传）。传了以后 `readFile`：
   * 先查持久缓存 → 命中直接返回（**不发 file-read**，重开会话/杀 App 再开都能秒开）；
   * 未命中才走通道，成功后异步落盘。
   */
  fileStore?: FileStore
  /**
   * 持久缓存的账号隔离键（`HubAccountKey(origin, username)`）。
   *
   * 与 `fileStore` 成对使用：不传就只用内存缓存（没有账号上下文时不能落盘，
   * 否则换账号会看到别人的文件）。
   */
  accountKey?: string
  /**
   * 文件下载失败的重试策略（默认 3 次、700ms 指数退避、单次 30s 超时）。
   *
   * 只对可重试错误生效（超时/链路抖动）；`file-refused`/`file-not-found` 等
   * 明确拒绝立刻失败，UI 显示错误卡片。
   */
  fileRetry?: { attempts?: number; baseDelayMs?: number; timeoutMs?: number }
  /**
   * 发送队列（Outbox）的注入项：建会话参数、建会话失败提示、附件就绪判定、持久化。
   *
   * 全部可选：不传 = 纯 core 行为（队列只在内存里、建会话不带模型/预设、不认附件）。
   */
  outbox?: WorkspaceOutboxOptions
}

/**
 * 发送队列的注入接口（UI 侧实现）。
 *
 * 为什么是注入而不是 core 直接读 UI 状态：模型/预设选择（models store）、附件上传任务
 * （chat store 的 `uploads`）都在 UI 层，core 只认这些回调给出的答案。
 */
export interface WorkspaceOutboxOptions {
  /** 建会话帧的附加参数（provider/model/effort + preset）。 */
  createOptions?(): CreateFrameOptions
  /**
   * 建会话失败（**只按那一次 create 请求的回包**判定，不看全局 error）。
   *
   * UI 在这里丢掉服务端不认的 preset 并提示用户；条目会留在队列里按退避重试。
   */
  onCreateFailed?(input: { code: string; message: string; retryable: boolean }): void
  /** 某条附件的本地状态；缺省视为 `missing`（不可用）。 */
  attachmentState?(localId: string): OutboxAttachmentState
  /** 已就绪附件的 outgoing 引用。 */
  outgoingAttachment?(localId: string): MobileOutgoingAttachment | null
  /** 有会话了：把还没开始的附件上传推起来。 */
  startUploads?(sessionId: string): void
  /** 用户在气泡上点「重试」：把该附件的上传任务重新推起来。 */
  retryAttachment?(localId: string): void
  /** 队列持久化（IndexedDB）；与 `accountKey` 成对使用，缺一不落盘。 */
  store?: OutboxStore
}

/** 服务端回显的模型选择（`created.model` / `model-changed`）。 */
export interface ModelEcho {
  provider: string
  model: string
  effort?: string
}

/** rename / archive / set-model 的结果（UI 据此回滚并提示）。 */
export interface ActionOutcome {
  ok: boolean
  code?: string
  message?: string
}

/** 一次成功下载的文件（字节已校验）。 */
export interface DownloadedFile {
  /** Hub 签发的不透明引用（按 `path` 读取时是 Hub 回的新 fileRef）。 */
  fileRef: string
  /** 按路径读取时的请求路径（展示/诊断用；缓存键见 `cacheKeyOf`）。 */
  path?: string
  name: string
  mimeType: string
  mediaType: 'image' | 'file'
  bytes: Uint8Array
  sha256?: string
  /** 本次结果的缓存键（fileRef 或 `path:<路径>`）：UI 用它共享 object URL。 */
  cacheKey: string
  /** 是否直接命中缓存（没有走网络）——用于诊断与「不要显示加载态」。 */
  fromCache?: boolean
}

/** `readFile` 的入参（fileRef 与 path 二选一）。 */
export interface FileReadTarget {
  fileRef?: string
  path?: string
  /** 分片帧里没有文件名/MIME，用工具卡/交付物给的 `MobileFileRef` 补。 */
  name?: string
  mimeType?: string
  mediaType?: 'image' | 'file'
  /** 已知大小（用于字节数校验；分片帧的 final 也会给）。 */
  bytes?: number
}

/** 附件上传的入参（见 `channel/upload.ts`）。 */
export type { MobileFileRef, MobileOutgoingAttachment }
