import { z } from 'zod'
import type { ContractEntry } from '../contract-map.js'
import { DeviceIdSchema, DeviceNameSchema } from './desktop.js'
import { InstanceStatusSchema, IsoDateTimeSchema } from '../common.js'

/**
 * 移动端工作区契约（M1，mobile/M1）。
 *
 * 设计事实全部来自 DSH 运行时**真实端点**（本轮用 `TYPERT.invocations` 动态导出核对，见
 * `mobile-plan/M4-冻结契约.md` §2）；不引用 `dsh-plugin-mobile-gateway` 的 `dsh-mobile-v1`
 * 配对协议，也不需要安装任何移动网关插件、扫码或复制配对串。
 *
 * 三条硬约束（写进类型，不靠注释约束）：
 * 1. **节点列表不带路径**：`MobileNodeSchema` 没有 `home`/`cwd`/`openUrl`；
 *    路径只在进入某个工作区、且该功能确实需要时才由会话级接口返回。
 * 2. **心跳不是可连接**：`presence` 与 `connectable` 是两个字段；`connectable` 只有在
 *    Hub 侧 adapter 真正就绪（云：实例 running 且 adapter 探测通过；桌面：relay 在线 +
 *    本机开关 on + 版本兼容）时才为 `true`。
 * 3. **正文不落库**：这些 schema 只描述线上帧，Hub 不把它们写库、不写日志正文；
 *    审计只记事件名、节点 id、字节数与时长。
 *
 * 帧的宽松度分方向：客户端 → Hub 用 `strictObject`（拒绝未知字段，防协议漂移）；
 * Hub → 客户端用 `z.object`（允许以后加字段而不破坏老 APK）。
 */

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 手机 ↔ Hub 的协议版本；不一致时 Hub 回 `protocol-version-unsupported` 并保持连接可读。 */
export const MOBILE_PROTOCOL_VERSION = 1 as const

/** 单用户最多同时开几条手机通道（与反代的 20 条浏览器 WS 分开计数）。 */
export const MOBILE_MAX_CHANNELS_PER_USER = 4
/** 单用户对同一节点的并发通道上限（重连风暴时顶掉旧的）。 */
export const MOBILE_MAX_CHANNELS_PER_NODE = 2

/** 通道空闲断开时间：10 分钟（与 `proxy/service.ts` 的 `WS_IDLE_MS` 对齐）。 */
export const MOBILE_CHANNEL_IDLE_MS = 600_000
/** Hub 主动心跳间隔：25 秒（客户端 45 秒内必须回 pong，否则断开）。 */
export const MOBILE_HEARTBEAT_MS = 25_000

/** 单帧上限：256 KiB（历史页与原始 chunk 都在此之内）。 */
export const MOBILE_MAX_FRAME_BYTES = 262_144
/** 上行速率上限（帧/秒，滑动窗口），防一条手机把 Hub 打满。 */
export const MOBILE_MAX_UPLINK_FPS = 20

/** 移动通道的 HTTP 前缀（WS 升级也在同一前缀下）。 */
export const MOBILE_API_PREFIX = '/api/mobile'
/** 节点列表。 */
export const MOBILE_NODES_PATH = '/api/mobile/nodes'
/** 通道：`GET /api/mobile/nodes/:id/channel`（Upgrade: websocket）。 */
export const MOBILE_CHANNEL_PATH = '/api/mobile/nodes/:id/channel'
/** 桌面出站中继：`GET /api/desktop/relay`（Upgrade: websocket，设备令牌鉴权）。 */
export const DESKTOP_RELAY_PATH = '/api/desktop/relay'

/** 云节点在列表里的固定 id（一人一容器，所以「选云」没有第二个候选）。 */
export const MOBILE_CLOUD_NODE_ID = 'cloud:self' as const
/**
 * 管理座舱的节点 id（WP56b / docs/24 §2）。
 *
 * 座舱 iframe 的令牌（`scope='cockpit'`）只看得见这一个节点：它连的是系统账号 `hub-ops`
 * 的容器 `dshhub-ops`，不是管理员自己的云实例。多个管理员共享同一个容器 = 共享同一份会话列表。
 */
export const MOBILE_COCKPIT_NODE_ID = 'cloud:ops' as const

// ── 节点 ────────────────────────────────────────────────────────────────────

/** 节点种类：云实例 / 用户自己的桌面（Windows）。 */
export const MobileNodeKindSchema = z.enum(['cloud', 'desktop'])
export type MobileNodeKind = z.infer<typeof MobileNodeKindSchema>

/** 云实例运行态直接用 instances 的枚举，不另造一套。 */
export const MobileCloudStatusSchema = InstanceStatusSchema
/** 桌面只有三种可知状态；`host-stopped` 表示 relay 在但 DSH Host 没跑（D5）。 */
export const MobileDesktopStatusSchema = z.enum(['unknown', 'host-running', 'host-stopped'])
export type MobileDesktopStatus = z.infer<typeof MobileDesktopStatusSchema>

/**
 * 不可连接的原因（机器可读，UI 不许自行推断）。
 *
 * - `desktop-remote-off`：本机开关关闭（默认）
 * - `desktop-relay-disconnected`：桌面没连上 Hub
 * - `desktop-host-stopped`：relay 在，但本机 DSH Host 没在跑
 * - `desktop-needs-upgrade`：桌面版本低于本协议要求
 * - `adapter-incompatible`：节点 DSH 版本缺少所需端点（不返回假空列表）
 * - `adapter-probe-failed`：能力探测失败（网络/鉴权/超时）
 * - `instance-not-running`：云实例 absent/stopped/starting/error
 */
export const MobileNodeBlockedReasonSchema = z.enum([
  'desktop-remote-off',
  'desktop-relay-disconnected',
  'desktop-host-stopped',
  'desktop-needs-upgrade',
  'adapter-incompatible',
  'adapter-probe-failed',
  'instance-not-running',
])
export type MobileNodeBlockedReason = z.infer<typeof MobileNodeBlockedReasonSchema>

/** 节点能力：由 adapter 探测得出，**不是**配置声明。缺项即视为不支持。 */
export const MobileNodeCapabilitiesSchema = z.object({
  /** 会话列表/历史/发送/停止：v1 必须全有，缺任一即 `adapter-incompatible`。 */
  sessions: z.boolean(),
  history: z.boolean(),
  send: z.boolean(),
  stop: z.boolean(),
  /** 流式：`session/follow` 的 `assistantStream`。 */
  stream: z.boolean(),
  /** 审批问答：`userQuestions/answer`。 */
  questions: z.boolean(),
  /** 审批（工具批准）：v1 恒 false —— 需要 `$events` owner 应答通道，见 M4 §9。 */
  approvals: z.boolean(),
  /** 新建会话：`session/create`。 */
  create: z.boolean(),
})
export type MobileNodeCapabilities = z.infer<typeof MobileNodeCapabilitiesSchema>

/** 节点 DTO：**不含 home/cwd/openUrl**（用户进工作区后才按功能给路径）。 */
export const MobileNodeSchema = z.object({
  id: z.string().min(1).max(128),
  kind: MobileNodeKindSchema,
  name: z.string().min(1).max(120),
  /** 云：实例状态；桌面：host 状态。两者语义不同，不要合并解释。 */
  status: z.union([MobileCloudStatusSchema, MobileDesktopStatusSchema]),
  /** 仅桌面有：最近一次设备心跳（**不是**可连接）。 */
  presence: z.enum(['online', 'offline', 'revoked']).optional(),
  connectable: z.boolean(),
  reason: MobileNodeBlockedReasonSchema.optional(),
  capabilities: MobileNodeCapabilitiesSchema.optional(),
  /** 桌面客户端版本（仅桌面）；用于「需升级」提示。 */
  clientVersion: z.string().max(64).optional(),
})
export type MobileNode = z.infer<typeof MobileNodeSchema>

export const MobileNodesResponseSchema = z.object({
  items: z.array(MobileNodeSchema),
  limits: z.object({
    channelsPerUser: z.number().int().positive(),
    channelsPerNode: z.number().int().positive(),
    idleMs: z.number().int().positive(),
    maxFrameBytes: z.number().int().positive(),
  }),
})
export type MobileNodesResponse = z.infer<typeof MobileNodesResponseSchema>

// ── 手机 ↔ Hub 帧（v1） ─────────────────────────────────────────────────────

const FrameBase = { v: z.literal(MOBILE_PROTOCOL_VERSION) }

/** 请求 id：客户端生成，原样回显；用于幂等与超时配对。 */
export const MobileRequestIdSchema = z.string().min(1).max(64)

/** DSH 会话 id。 */
export const MobileSessionIdSchema = z.string().min(1).max(128)

/** 问答答案：与 `userQuestions/answer` 的 `answer.answers[]` 一致。 */
export const MobileQuestionAnswerSchema = z.strictObject({
  id: z.string().min(1).max(128),
  selected: z.array(z.string().max(512)).max(32),
  custom: z.string().max(4_000).optional(),
})
export type MobileQuestionAnswer = z.infer<typeof MobileQuestionAnswerSchema>

/** 客户端 → Hub。全部 strictObject。 */
export const MobileClientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...FrameBase,
    type: z.literal('hello'),
    requestId: MobileRequestIdSchema,
    client: z.object({ name: z.string().max(64), version: z.string().max(32) }),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('sessions'),
    requestId: MobileRequestIdSchema,
    refresh: z.boolean().optional(),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('history'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    beforeSeq: z.number().int().nonnegative().nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('create'),
    requestId: MobileRequestIdSchema,
    title: z.string().max(200).optional(),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('send'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    text: z.string().min(1).max(200_000),
    mode: z.enum(['queue', 'steer']).optional(),
    /** 客户端铸造的消息身份：重连重发时 Hub 用它做幂等去重。 */
    clientMessageId: z.string().min(1).max(64),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('stop'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('subscribe'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    /** 断线重连续看：上次收到的 `cursor`；null/缺省表示只跟新事件。 */
    sinceCursor: z.number().int().nonnegative().nullable().optional(),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('unsubscribe'),
    sessionId: MobileSessionIdSchema,
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('answer-question'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    /** `session/control` 投影里给出的 agent id。 */
    agent: z.string().min(1).max(128),
    callId: z.string().min(1).max(128),
    answers: z.array(MobileQuestionAnswerSchema).min(1).max(32),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('answer-approval'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    approvalId: z.string().min(1).max(128),
    decision: z.enum(['approve', 'reject']),
  }),
  z.strictObject({
    ...FrameBase,
    type: z.literal('ping'),
    t: z.number().int().nonnegative(),
  }),
])
export type MobileClientFrame = z.infer<typeof MobileClientFrameSchema>

/** 错误码白名单（v1 冻结；新增要同时改 M4 §5 与 Android）。 */
export const MobileErrorCodeSchema = z.enum([
  'unauthenticated',
  'session-expired',
  'node-not-found',
  'node-offline',
  'node-not-connectable',
  'instance-not-running',
  'adapter-incompatible',
  'adapter-unavailable',
  'session-not-found',
  'agent-busy',
  'question-not-answerable',
  'approval-not-answerable',
  'approval-expired',
  'send-in-flight',
  'protocol-version-unsupported',
  'rate-limited',
  'frame-too-large',
  'upstream-unavailable',
  'relay-disconnected',
  'internal',
])
export type MobileErrorCode = z.infer<typeof MobileErrorCodeSchema>

/** 会话列表行：只放 UI 需要的最小集合。 */
export const MobileSessionRowSchema = z.object({
  sessionId: MobileSessionIdSchema,
  title: z.string().max(300).nullable(),
  updatedAt: z.number().int().nonnegative(),
  running: z.boolean(),
  blank: z.boolean(),
  agentAvailable: z.boolean(),
  /** `subagent` 标记；普通会话缺省。 */
  origin: z.string().max(32).nullable().optional(),
})
export type MobileSessionRow = z.infer<typeof MobileSessionRowSchema>

/** 历史消息：文本是**线上内容**，Hub 不落库。 */
export const MobileHistoryItemSchema = z.object({
  seq: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  at: z.number().int().nonnegative(),
  text: z.string(),
  /** 仅 user/message 且 source.kind==='user' 时存在：Host 持久化的 `source.rpcId`（= 客户端幂等键）。 */
  clientMessageId: z.string().max(64).optional(),
  /** 助手消息里的工具名（仅摘要，不含参数）。 */
  tools: z.array(z.string().max(64)).max(32).optional(),
})
export type MobileHistoryItem = z.infer<typeof MobileHistoryItemSchema>

/** 问答投影（`session/control` 的 `userQuestions`）。 */
export const MobileQuestionSchema = z.object({
  id: z.string().max(128),
  question: z.string().max(4_000),
  detail: z.string().max(8_000).optional(),
  header: z.string().max(200).optional(),
  options: z
    .array(z.object({ label: z.string().max(512), description: z.string().max(1_000).optional() }))
    .max(16)
    .optional(),
  multiSelect: z.boolean().optional(),
})
export const MobileQuestionRequestSchema = z.object({
  sessionId: MobileSessionIdSchema,
  agent: z.string().max(128),
  callId: z.string().max(128),
  questions: z.array(MobileQuestionSchema).min(1).max(32),
  state: z.enum(['open', 'continued']),
})

/**
 * 审批请求。
 *
 * `answerable` 由节点的真实能力决定：真实 Host 的审批应答走 `$events` waterfall
 * （owner peer），在 M3 探针给出证据前恒为 `false`，此时 `actions` 只有 `cancel`，
 * 保证等待不会无声卡死。schema 已预留 approve/reject 与 settled/expired 语义，
 * **不代表**已经支持（见 M4 §9）。
 */
export const MobileApprovalSchema = z.object({
  sessionId: MobileSessionIdSchema,
  callId: z.string().max(128).nullable(),
  approvalId: z.string().max(128),
  tool: z.string().max(120),
  reason: z.string().max(4_000).optional(),
  answerable: z.boolean(),
  actions: z.array(z.enum(['approve', 'reject', 'cancel'])).min(1),
  state: z.enum(['open', 'settled', 'expired']),
  decision: z.enum(['approve', 'reject']).optional(),
})

/** Hub → 客户端。用 z.object（允许加字段，不破坏老客户端）。 */
export const MobileServerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    ...FrameBase,
    type: z.literal('hello'),
    requestId: MobileRequestIdSchema,
    node: z.object({
      id: z.string(),
      kind: MobileNodeKindSchema,
      name: z.string(),
      status: z.string(),
    }),
    capabilities: MobileNodeCapabilitiesSchema,
    /** 当前手机通道上活跃订阅的会话。 */
    subscribed: z.array(MobileSessionIdSchema),
    serverTime: z.number().int().nonnegative(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('sessions'),
    requestId: MobileRequestIdSchema,
    items: z.array(MobileSessionRowSchema),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('history'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    items: z.array(MobileHistoryItemSchema),
    /** 更早一页的游标（`session/page` 的 `beforeSeq`）；null = 到头了。 */
    nextBeforeSeq: z.number().int().nonnegative().nullable(),
    /** 实时跟随起点（`session/follow` 的 `snapshot.cursor`）。 */
    cursor: z.number().int().nonnegative().nullable(),
    hasMore: z.boolean(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('created'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
  }),
  z.object({
    ...FrameBase,
    type: z.literal('ack'),
    requestId: MobileRequestIdSchema,
    /** `clientMessageId` 原样回显，客户端据此清本地待发气泡。 */
    clientMessageId: z.string().optional(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('error'),
    requestId: MobileRequestIdSchema.optional(),
    code: MobileErrorCodeSchema,
    message: z.string().max(2_000),
    retryable: z.boolean(),
  }),
  /** 助手增量：`attemptId/revision/index` 全部来自 DSH 的 assistant-stream 帧。 */
  z.object({
    ...FrameBase,
    type: z.literal('delta'),
    sessionId: MobileSessionIdSchema,
    attemptId: z.string().max(128),
    revision: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative().nullable(),
    step: z.number().int().nonnegative().nullable(),
    part: z.object({
      kind: z.enum(['text', 'reasoning', 'tool', 'unknown']),
      text: z.string().optional(),
    }),
    /** 原始 chunk 是 `JsonValue`（DSH 未承诺形状）；原样带给客户端，Hub 不解释。 */
    raw: z.unknown().optional(),
  }),
  /** 一次助手尝试结束；**不是**回合结束（回合只认 `turn/end`）。 */
  z.object({
    ...FrameBase,
    type: z.literal('delta-end'),
    sessionId: MobileSessionIdSchema,
    attemptId: z.string().max(128),
    revision: z.number().int().nonnegative(),
    committed: z.boolean(),
  }),
  /**
   * 持久消息（canonical）：来自 `user/message` / `assistant/message` 事件，带稳定 `seq`。
   * delta 只是过程；客户端收到同 seq 的 message 后用它替换该回合的增量展示。
   */
  z.object({
    ...FrameBase,
    type: z.literal('message'),
    sessionId: MobileSessionIdSchema,
    seq: z.number().int().nonnegative(),
    role: z.enum(['user', 'assistant', 'system']),
    at: z.number().int().nonnegative(),
    text: z.string(),
    /** 仅 role==='user' 且 source.kind==='user'：来自 `source.rpcId`，不猜、不按 FIFO。 */
    clientMessageId: z.string().max(64).optional(),
    tools: z.array(z.string().max(64)).max(32).optional(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('turn'),
    sessionId: MobileSessionIdSchema,
    phase: z.enum(['start', 'end']),
    turn: z.number().int().nonnegative(),
    reason: z.string().max(120).optional(),
  }),
  /** 会话状态：只放白名单投影键，值由 Host 决定，Hub 不解释。 */
  z.object({
    ...FrameBase,
    type: z.literal('state'),
    sessionId: MobileSessionIdSchema,
    key: z.string().max(64),
    value: z.unknown(),
    seq: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('question'),
    sessionId: MobileSessionIdSchema,
    agent: z.string().max(128),
    callId: z.string().max(128),
    questions: z.array(MobileQuestionSchema).min(1).max(32),
    state: z.enum(['open', 'continued', 'settled']),
  }),
  /**
   * 重连时恢复「进行中的 assistant 输出」：只展开 compact stream 的 text-chunks（不含 reasoning），
   * 客户端用它替换 streamingText、把 nextIndex 设为 nextIndex-1、清掉旧 attempt，后续 delta 连续。
   */
  z.object({
    ...FrameBase,
    type: z.literal('assistant-baseline'),
    sessionId: MobileSessionIdSchema,
    attemptId: z.string().max(128),
    revision: z.number().int().nonnegative(),
    nextIndex: z.number().int().nonnegative(),
    text: z.string(),
    /**
     * 进行中思考的已产出部分（compact stream 的 reasoning-chunks 拼接，最多尾部 8000 字）。
     * 断线重连后客户端用它恢复「深度求索中…」的内容；老 Hub 不发 = 客户端保持现有内容。
     */
    reasoning: z.string().optional(),
  }),
  /** 提问已结算（`settled` 投影只有 {callId, answers}，没有 questions，故单列一帧）。 */
  z.object({
    ...FrameBase,
    type: z.literal('question-settled'),
    sessionId: MobileSessionIdSchema,
    callId: z.string().max(128),
    answers: z
      .array(
        z.object({
          id: z.string().max(128),
          selected: z.array(z.string().max(512)).max(32),
          custom: z.string().max(4_000).optional(),
        }),
      )
      .max(32)
      .optional(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('approval'),
    sessionId: MobileSessionIdSchema,
    approval: MobileApprovalSchema,
  }),
  z.object({
    ...FrameBase,
    type: z.literal('approval-settled'),
    sessionId: MobileSessionIdSchema,
    approvalId: z.string().max(128),
    decision: z.enum(['approve', 'reject', 'expired']),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('stopped'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    accepted: z.boolean(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('answer-result'),
    requestId: MobileRequestIdSchema,
    sessionId: MobileSessionIdSchema,
    accepted: z.boolean(),
    /** Host 语义：true = 问题仍可继续，false = 已结算。 */
    continued: z.boolean(),
  }),
  /** 已订阅会话的补放结束标记（重连时告诉客户端「历史补到这里，后面是实时」）。 */
  z.object({
    ...FrameBase,
    type: z.literal('replay'),
    sessionId: MobileSessionIdSchema,
    fromCursor: z.number().int().nonnegative().nullable(),
    toCursor: z.number().int().nonnegative(),
  }),
  /** 能力更新（典型：真实手机通道 hello 后 `$events` ready，approvals 由 false 变 true）。 */
  z.object({
    ...FrameBase,
    type: z.literal('capability'),
    capabilities: MobileNodeCapabilitiesSchema,
  }),
  z.object({
    ...FrameBase,
    type: z.literal('node-status'),
    node: z.object({
      id: z.string(),
      connectable: z.boolean(),
      reason: MobileNodeBlockedReasonSchema.optional(),
    }),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('pong'),
    t: z.number().int().nonnegative(),
  }),
  z.object({
    ...FrameBase,
    type: z.literal('bye'),
    code: MobileErrorCodeSchema,
    reason: z.string().max(500),
  }),
])
export type MobileServerFrame = z.infer<typeof MobileServerFrameSchema>

// ── 桌面 ↔ Hub 中继外层（双向同一套封装） ───────────────────────────────────

/** 中继 hello：桌面连上 Hub 后的第一帧。 */
export const DesktopRelayHelloSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('hello'),
  deviceId: DeviceIdSchema,
  /** 本机 DSH Host 是否在跑（只报状态，不报内容）。 */
  hostStatus: z.enum(['running', 'stopped', 'starting']),
  /** adapter 探测结果；`null` 表示还没探测完。 */
  capabilities: MobileNodeCapabilitiesSchema.nullable(),
  clientVersion: z.string().max(64),
})
export type DesktopRelayHello = z.infer<typeof DesktopRelayHelloSchema>

/** Hub → 桌面：为一个手机通道开一条逻辑流。 */
export const DesktopRelayOpenSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('open'),
  channelId: z.string().min(1).max(64),
  nodeId: z.string().min(1).max(128),
})
/** Hub ↔ 桌面：帧转发（payload 是 `MobileClientFrame` 或 `MobileServerFrame`）。 */
export const DesktopRelayFrameSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('frame'),
  channelId: z.string().min(1).max(64),
  payload: z.unknown(),
})
export const DesktopRelayCloseSchema = z.strictObject({
  v: z.literal(MOBILE_PROTOCOL_VERSION),
  type: z.literal('close'),
  channelId: z.string().min(1).max(64),
  code: MobileErrorCodeSchema,
  reason: z.string().max(500),
})
export const DesktopRelayFrameEnvelopeSchema = z.discriminatedUnion('type', [
  DesktopRelayHelloSchema,
  DesktopRelayOpenSchema,
  DesktopRelayFrameSchema,
  DesktopRelayCloseSchema,
])
export type DesktopRelayFrameEnvelope = z.infer<typeof DesktopRelayFrameEnvelopeSchema>

// ── 设备令牌认证（v2 §4.1；WP40a） ──────────────────────────────────────────

/**
 * 移动设备的 access / refresh 令牌前缀。
 *
 * 为什么是 `dshm_at_` / `dshm_rt_` 而不是复用 `dsh_dev_`：
 * 桌面设备令牌（D2）只做**控制面**且只有一个方向（滑动 30 天 + 绝对 90 天）；手机要的是
 * 「短命 access（1 小时）+ 长命 refresh（60 天）+ 每次轮换」，两者的语义与生命周期都不同，
 * 前缀分开后 `readDeviceBearer`（桌面白名单）与 `resolveDeviceToken`（桌面）不会互相认领，
 * 同一张 `desktop_device_tokens` 表里也靠前缀把两种令牌区分开（一行只存 sha256）。
 */
export const MOBILE_ACCESS_TOKEN_PREFIX = 'dshm_at_'
export const MOBILE_REFRESH_TOKEN_PREFIX = 'dshm_rt_'
/** 令牌随机部分的长度（base62） */
export const MOBILE_TOKEN_RANDOM_LENGTH = 40

/** access token 有效期：1 小时（过期后 App 用 refresh 换新的） */
export const MOBILE_ACCESS_TTL_MS = 3_600_000
/** refresh token 有效期：60 天；每次 refresh 都轮换新的一对 */
export const MOBILE_REFRESH_TTL_DAYS = 60

/** 通道 ticket 有效期：30 秒（一次性） */
export const MOBILE_TICKET_TTL_MS = 30_000

/**
 * 每个用户最多保留几台有效**手机**设备。
 *
 * 与桌面端的 `settings.desktop.maxDevicesPerUser` 分开计数：手机是主入口，
 * 台账满了不能把人挡在登录页外 —— 达到上限时服务端顶掉最老的一台（记审计）。
 */
export const MOBILE_MAX_DEVICES_PER_USER = 10

/** 认证端点（`/api/mobile/*` 对 App 来源放行 CORS 预检，允许 `Authorization` 头） */
export const MOBILE_LOGIN_PATH = '/api/mobile/auth/login'
export const MOBILE_REFRESH_PATH = '/api/mobile/auth/refresh'
export const MOBILE_LOGOUT_PATH = '/api/mobile/auth/logout'
/**
 * `POST /api/mobile/auth/cockpit-exchange`（WP56b / docs/24 §3.3）：免登录——
 * 座舱 iframe 用父页面 `POST /api/admin/cockpit/handoff` 换来的一次性码换令牌。
 */
export const MOBILE_COCKPIT_EXCHANGE_PATH = '/api/mobile/auth/cockpit-exchange'
/**
 * 座舱令牌的有效期：**12 小时，access 与 refresh 同口径、绝对过期**（docs/24 §3.3）。
 *
 * 手机设备令牌是「access 1 小时 + refresh 60 天」，座舱令牌刻意不给长尾：
 * 它绑定的是某个管理员的会话口令，管理员下班/令牌泄漏的窗口就该在 12 小时内收口。
 */
export const MOBILE_COCKPIT_TOKEN_TTL_MS = 12 * 3_600_000
/** `GET /api/mobile/bootstrap`：用户 + 积分 + 后端列表 + 实例状态 + App 版本地板 */
export const MOBILE_BOOTSTRAP_PATH = '/api/mobile/bootstrap'
/** `POST /api/mobile/instance/wake`：自动唤醒（复用 instances 的 start 与准入） */
export const MOBILE_WAKE_PATH = '/api/mobile/instance/wake'
/** `POST /api/mobile/nodes/:id/ticket`：一次性通道 ticket */
export const MOBILE_TICKET_PATTERN = '/api/mobile/nodes/:id/ticket'

/** 手机网页版的挂载路径（WP54；Hub 同源托管，带结尾斜杠） */
export const MOBILE_WEB_BASE_PATH = '/m/'

/** 拼出某个节点的 ticket 路径（`id` 需要 URL 编码） */
export function mobileTicketPath(nodeId: string): string {
  return `${MOBILE_NODES_PATH}/${encodeURIComponent(nodeId)}/ticket`
}

/**
 * App 平台：只用于设备台账展示；两端都没有安装指纹，不做设备识别。
 *
 * `web`（WP54）：手机浏览器里的「手机网页版」——同一套 App 界面由 Hub 同源托管在
 * `MOBILE_WEB_BASE_PATH`。它没有 APK 更新、没有强更地板（刷新即最新），其余行为与 App 相同。
 */
export const MobileAppPlatformSchema = z.enum(['android', 'ios', 'web'])
export type MobileAppPlatform = z.infer<typeof MobileAppPlatformSchema>

/** access token（线上明文只在签发响应里出现一次；库里只有 sha256） */
export const MobileAccessTokenSchema = z
  .string()
  .regex(/^dshm_at_[0-9A-Za-z]{16,}$/u, 'accessToken 格式不正确')
/** refresh token */
export const MobileRefreshTokenSchema = z
  .string()
  .regex(/^dshm_rt_[0-9A-Za-z]{16,}$/u, 'refreshToken 格式不正确')

/** 契约里的用户摘要（App 只显示这三个字段，不复制 `UserPublic`） */
export const MobileUserRefSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
})
export type MobileUserRef = z.infer<typeof MobileUserRefSchema>

/** `POST /api/mobile/auth/login`（免登录） */
export const MobileLoginRequestSchema = z.strictObject({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
  /** 展示名，与桌面端同一个 `DeviceNameSchema`（≤64、禁控制字符与路径分隔符） */
  deviceName: DeviceNameSchema,
  platform: MobileAppPlatformSchema,
  /**
   * 安装标识（App 首次启动生成、存本地；可选）：Hub 用 `sha256(userId:installId)` 当
   * `install_key`，同一台手机重登/重装前都复用同一条设备记录，不再堆出一堆「离线设备」。
   * 老 App 不传 = 沿用旧行为（按 deviceName+platform 且无有效令牌时复用）。
   */
  installId: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'installId 只能是字母/数字/_/-')
    .optional(),
})
export type MobileLoginRequest = z.infer<typeof MobileLoginRequestSchema>

/**
 * 令牌的作用域（WP56b / docs/24 §3.3）。
 *
 * `mobile`（缺省）= 手机/网页版的设备令牌：节点列表是「云实例 + 我的桌面设备」，所有手机接口都可用；
 * `cockpit` = 管理座舱 iframe 用一次性交接码换来的令牌：只认 `cloud:ops` 一个节点、
 * `bootstrap` 只给通道需要的字段、除语音（TTS/ASR）与退出外其余手机接口 403；
 * **不占手机设备名额**（不进 `mobile_devices` 的 10 台上限）。
 * 老 App / 老网页版不读这个字段，缺省即 `mobile`。
 */
export const MobileTokenScopeSchema = z.enum(['mobile', 'cockpit'])
export type MobileTokenScope = z.infer<typeof MobileTokenScopeSchema>

/** login / refresh 的响应同形（refresh 每次轮换一对新令牌） */
export const MobileAuthTokensSchema = z.object({
  accessToken: MobileAccessTokenSchema,
  accessExpiresAt: IsoDateTimeSchema,
  refreshToken: MobileRefreshTokenSchema,
  refreshExpiresAt: IsoDateTimeSchema,
  deviceId: DeviceIdSchema,
  user: MobileUserRefSchema,
  /** WP56b：座舱令牌带 `scope: 'cockpit'`；普通手机令牌省略（= `mobile`） */
  scope: MobileTokenScopeSchema.optional(),
})
export type MobileAuthTokens = z.infer<typeof MobileAuthTokensSchema>
export const MobileLoginResponseSchema = MobileAuthTokensSchema
export type MobileLoginResponse = MobileAuthTokens

/** `POST /api/mobile/auth/refresh`（免登录：refresh token 本身就是凭据） */
export const MobileRefreshRequestSchema = z.strictObject({
  refreshToken: MobileRefreshTokenSchema,
})
export type MobileRefreshRequest = z.infer<typeof MobileRefreshRequestSchema>
export const MobileRefreshResponseSchema = MobileAuthTokensSchema
export type MobileRefreshResponse = MobileAuthTokens

/** 积分余额：`enabled=false` 表示 Hub 没开积分，App 不显示余额 */
export const MobilePointsSchema = z.object({
  balance: z.number(),
  enabled: z.boolean(),
})
export type MobilePoints = z.infer<typeof MobilePointsSchema>

/** App 版本地板（管理端 settings.mobile.app 可配；`downloadUrl=null` = 不显示下载入口） */
export const MobileAppInfoSchema = z.object({
  minVersionCode: z.number().int().nonnegative(),
  latestVersionCode: z.number().int().nonnegative(),
  downloadUrl: z.string().url().nullable(),
  /**
   * WP52：同一个 APK 的全部可用地址（本入口排第一，另一个入口第二，已去重）。
   * **可选字段** —— 老 Hub 不发、老 App 忽略；没有发布记录时是 `[]`。
   * App 自动更新按顺序尝试，某个地址网络失败 / 超时 / 字节数或 sha256 不符就换下一个。
   */
  downloadMirrors: z.array(z.string().min(1).max(2048)).optional(),
})
export type MobileAppInfo = z.infer<typeof MobileAppInfoSchema>

/** 朗读音色（WP50） */
export const MobileTtsVoiceSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(32),
  /** 一句话介绍（设置页显示） */
  description: z.string().max(120).optional(),
})
export type MobileTtsVoice = z.infer<typeof MobileTtsVoiceSchema>

/** `GET /api/mobile/bootstrap` */
export const MobileBootstrapResponseSchema = z.object({
  user: MobileUserRefSchema,
  points: MobilePointsSchema,
  /** 直接复用节点列表（云 `cloud:self` + 该用户的桌面节点）；未开通云实例时仍在，status 由 Hub 定义 */
  backends: z.array(MobileNodeSchema),
  instance: z.object({
    status: InstanceStatusSchema,
    /** `running+starting >= capacity.maxRunning`：App 显示「当前使用人数较多」 */
    capacityFull: z.boolean(),
  }),
  app: MobileAppInfoSchema,
  /** 语音能力（WP49）；老 Hub 不发 = App 只能用手机系统识别 */
  voice: z
    .object({
      /** Hub 侧语音识别（`POST /api/mobile/asr`）当前可用 */
      asr: z.boolean(),
      /** 单段录音上限（秒） */
      maxSeconds: z.number().int().positive(),
      /** 朗读（WP50）；老 Hub 不发 = App 不显示朗读入口 */
      tts: z
        .object({
          /** 朗读当前可用（合成服务健康 + 管理端开启） */
          enabled: z.boolean(),
          /** 可选音色；当前只有星汐 seki */
          voices: z.array(MobileTtsVoiceSchema).max(16),
          /** 默认音色 id */
          defaultVoice: z.string().max(32).nullable(),
          /** 单次 `POST /api/mobile/tts` 的文字上限（字符） */
          maxChars: z.number().int().positive(),
          /** 支持流式朗读 `POST /api/mobile/tts/stream`（WP51）；老 Hub 不发 = 只能整段 */
          stream: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  serverTime: IsoDateTimeSchema,
})
export type MobileBootstrapResponse = z.infer<typeof MobileBootstrapResponseSchema>

/**
 * `POST /api/mobile/asr`（WP49）：按住说话的服务端识别。
 *
 * - 请求：`Content-Type: audio/wav`，body 为 16kHz、单声道、16bit PCM 的 WAV，
 *   ≤ `MOBILE_ASR_MAX_BYTES`；可选查询参数 `lang`（默认 `zh`，另支持 `auto`/`en`/`yue`/`ja`/`ko`）。
 * - 鉴权：手机设备 Bearer；与其它 `/api/mobile/*` 相同。
 * - 错误（沿用现有错误码）：400 `VALIDATION_FAILED`（不是合法 WAV / 采样率不对 / 空音频）、
 *   413 `PAYLOAD_TOO_LARGE`、415 `UNSUPPORTED_MEDIA`（Content-Type 不是 audio/wav）、
 *   429 `RATE_LIMITED`、502 `UPSTREAM_ERROR`（识别服务没起来或超时）。
 * - Hub 不保存音频，审计只记字节数与时长，不记识别文字。
 */
export const MOBILE_ASR_MAX_SECONDS = 60
export const MOBILE_ASR_MAX_BYTES = 16_000 * 2 * MOBILE_ASR_MAX_SECONDS + 1_024
export const MobileAsrResponseSchema = z.object({
  text: z.string(),
  /** 音频时长（毫秒） */
  durationMs: z.number().int().nonnegative(),
})
export type MobileAsrResponse = z.infer<typeof MobileAsrResponseSchema>

/**
 * `POST /api/mobile/tts`（WP50）：把一段文字合成为语音（朗读 AI 回复）。
 *
 * - 请求：`application/json` `MobileTtsRequestSchema`。App 负责把回复去掉 Markdown/代码/链接、
 *   按句切成 ≤ `maxChars` 的小段逐段请求（边播边合成下一段）。
 * - 响应：200 `audio/wav`（单声道 16bit PCM，采样率见响应头 `x-tts-sample-rate`，当前 24000）；
 *   响应头 `x-tts-voice` 为实际使用的音色 id。
 * - 鉴权：手机设备 Bearer。
 * - 错误（沿用现有错误码）：400 `VALIDATION_FAILED`（空文本 / 超长 / 未知音色）、
 *   429 `RATE_LIMITED`（用户限流或合成队列已满，带 `retryAfterSec`）、
 *   502 `UPSTREAM_ERROR`（合成服务不可用或超时）。
 * - Hub 不保存文字与音频，审计只记字数、耗时与结果。
 */
export const MOBILE_TTS_MAX_CHARS = 200
export const MobileTtsRequestSchema = z.object({
  text: z.string().trim().min(1).max(MOBILE_TTS_MAX_CHARS),
  /** 音色 id；缺省用 bootstrap.voice.tts.defaultVoice */
  voice: z.string().min(1).max(32).optional(),
})
export type MobileTtsRequest = z.infer<typeof MobileTtsRequestSchema>

/**
 * `POST /api/mobile/tts/stream`（WP51）：流式朗读，边合成边返回。
 *
 * - 请求体与 `POST /api/mobile/tts` 相同（`MobileTtsRequestSchema`，text ≤ maxChars）。
 * - 成功：200，`Content-Type: audio/L16; rate=<采样率>; channels=1`，body 是**原始 PCM**
 *   （有符号 16bit 小端、单声道，无 WAV 头），HTTP 分块传输、**边合成边下发**；
 *   响应头 `x-tts-sample-rate`（当前 24000）、`x-tts-voice`、`x-tts-format: pcm16le`、
 *   `x-tts-cached: 1|0`（命中缓存时一次性返回整段）。
 * - 开始下发之前的错误照常用 JSON 错误体：400 `VALIDATION_FAILED`、429 `RATE_LIMITED`
 *   （带 retryAfterSec）、502 `UPSTREAM_ERROR`。
 * - **开始下发之后**合成失败：Hub 直接中断连接（不发分块结束标记）。客户端据此判定这段不完整，
 *   按失败处理；不会把别的声音冒充星汐。
 * - 正常结束：分块传输正常收尾。Hub 把完整音频按 `(音色, 文字)` 存入与 `/tts` 共用的缓存
 *   （两种接口互相命中：缓存的 WAV 去头即流式 PCM）。
 * - 排队、限流、审计与 `/tts` 共用（一次流式请求在整个合成期间占用一个上游槽位）。
 */
export const MOBILE_TTS_STREAM_PATH = '/api/mobile/tts/stream'
export const MOBILE_TTS_STREAM_CONTENT_TYPE_PREFIX = 'audio/L16'

/** `POST /api/mobile/instance/wake`（202；App 随后轮询 bootstrap 直到 connectable） */
export const MobileWakeResponseSchema = z.object({
  status: InstanceStatusSchema,
})
export type MobileWakeResponse = z.infer<typeof MobileWakeResponseSchema>

/** `POST /api/mobile/nodes/:id/ticket`（无请求体） */
export const MobileTicketResponseSchema = z.object({
  ticket: z.string().min(16).max(128),
  expiresAt: IsoDateTimeSchema,
})
export type MobileTicketResponse = z.infer<typeof MobileTicketResponseSchema>

/**
 * App 需要按错误码分支的集合（契约草案 §1–§3）。
 *
 * 这些都是 Hub 的统一错误码（`error.code`），App **按 code 判断，不要按 HTTP 状态**：
 * 同一段语义在网页端与 App 端的措辞不同（例如停用账号：网页端 `ACCOUNT_DISABLED`，
 * App 端按契约叫 `USER_DISABLED`），Hub 在 `/api/mobile/*` 上做一层映射。
 */
export const MOBILE_AUTH_ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'USER_DISABLED',
  'USER_PENDING',
  'MUST_CHANGE_PASSWORD',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'DEVICE_REVOKED',
  'DEVICE_TOKEN_INVALID',
] as const
export const MobileAuthErrorCodeSchema = z.enum(MOBILE_AUTH_ERROR_CODES)
export type MobileAuthErrorCode = z.infer<typeof MobileAuthErrorCodeSchema>

/** bootstrap / wake / ticket 的错误码（在认证错误码之外的那几个） */
export const MOBILE_WAKE_ERROR_CODES = [
  'CAPACITY_FULL',
  'INSUFFICIENT_POINTS',
  'INSTANCE_ABSENT',
  'DISK_QUOTA_EXCEEDED',
  'RUNTIME_NOT_READY',
  'INSTANCE_BUSY',
  'INSTANCE_START_FAILED',
  /**
   * 上线决定 ①（2026-10-25）：没有实例的账号在**首次 wake** 时自动开通；
   * 开通（建目录 / 落实例行 / 渲染 managed）失败回这个码，App 可重试。
   * `INSTANCE_ABSENT` 仍是契约的一部分（例如管理员关闭自助开通、或开通被策略拒绝的将来形态），
   * 但正常流程下 App 不会再看到它。
   */
  'INSTANCE_PROVISION_FAILED',
] as const
export const MobileWakeErrorCodeSchema = z.enum(MOBILE_WAKE_ERROR_CODES)
export type MobileWakeErrorCode = z.infer<typeof MobileWakeErrorCodeSchema>

// ── 契约表（04 文档新增接口时同步） ─────────────────────────────────────────

export const MOBILE_CONTRACT_MAP: ContractEntry[] = [
  {
    method: 'GET',
    path: MOBILE_NODES_PATH,
    response: 'MobileNodesResponseSchema',
    note: '手机节点列表：presence≠connectable，不含 home/cwd',
  },
  {
    method: 'GET',
    path: MOBILE_CHANNEL_PATH,
    note: 'WS 升级（协议帧见 MobileClientFrameSchema / MobileServerFrameSchema）；接受 `?ticket=`',
  },
  {
    method: 'GET',
    path: DESKTOP_RELAY_PATH,
    note: 'WS 升级（设备令牌鉴权；外层见 DesktopRelayFrameEnvelopeSchema）',
  },
  {
    method: 'POST',
    path: MOBILE_LOGIN_PATH,
    request: 'MobileLoginRequestSchema',
    response: 'MobileLoginResponseSchema',
    note: '设备令牌登录（免登录）：access 1h / refresh 60d；错误码见 MOBILE_AUTH_ERROR_CODES',
  },
  {
    method: 'POST',
    path: MOBILE_REFRESH_PATH,
    request: 'MobileRefreshRequestSchema',
    response: 'MobileRefreshResponseSchema',
    note: '轮换：旧 refresh 被重放时吊销整个设备',
  },
  {
    method: 'POST',
    path: MOBILE_LOGOUT_PATH,
    note: '204；吊销本设备（连同全部令牌）',
  },
  {
    method: 'GET',
    path: MOBILE_BOOTSTRAP_PATH,
    response: 'MobileBootstrapResponseSchema',
    note: '用户 / 积分 / 后端列表 / 实例状态 / App 版本地板',
  },
  {
    method: 'POST',
    path: MOBILE_WAKE_PATH,
    response: 'MobileWakeResponseSchema',
    note: '202；错误码见 MOBILE_WAKE_ERROR_CODES',
  },
  {
    method: 'POST',
    path: MOBILE_TICKET_PATTERN,
    response: 'MobileTicketResponseSchema',
    note: '一次性 ticket（30 秒），绑定用户 / 设备（Bearer） / 节点',
  },
]
