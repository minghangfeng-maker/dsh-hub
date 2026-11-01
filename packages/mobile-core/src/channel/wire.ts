/**
 * 手机通道线格式：客户端帧构造 + 服务端帧解析。
 *
 * 契约来源：
 *  - v1：`@dsh-hub/shared` 的 `MobileClientFrameSchema` / `MobileServerFrameSchema`
 *    （vendored tarball，绑定 Hub 提交，见 vendor/PROVENANCE.json）；
 *  - v2：`contracts/mobile-v2.ts` —— 现在只是 `@dsh-hub/shared` 的 re-export（WP40c-2 已落地）。
 *
 * 本文件只做共享包不负责的两件事：
 * 1. 构造上行帧（字段顺序与 fixtures 对齐，便于逐字节对拍）；
 * 2. 解析下行帧的宽容策略：未知 type / 未知字段不能崩，`v` 不符要显式报
 *    `protocol-version-unsupported`（M4 §7），坏帧丢弃但保留诊断信息。
 *
 * v2 帧都用「v1 schema 的超集」解析（hello/sessions/created/delta），这样服务端
 * 即使不带 v2 字段也能过；只有 v2 独有的帧才单独走 v2 schema。
 */

import {
  MOBILE_PROTOCOL_VERSION,
  MobileClientFrameSchema,
  MobileServerFrameAllSchema,
  MobileServerFrameSchema,
  type MobileClientFrame,
  type MobileNodeCapabilities,
  type MobileNodeKind,
  type MobileQuestionAnswer,
  type MobileServerFrame,
} from '@dsh-hub/shared'
import { withCockpitSessionInitiators } from '../cockpit/embed.js'
import {
  MobileArchivedFrameSchema,
  MobileClientArchiveFrameSchema,
  MobileClientCreateV2FrameSchema,
  MobileClientFrameAllSchema,
  MobileClientHelloV2Schema,
  MobileClientModelsFrameSchema,
  MobileClientRenameFrameSchema,
  MobileClientSendV2FrameSchema,
  MobileClientSessionsV2FrameSchema,
  MobileClientSetModelFrameSchema,
  MobileClientFileReadFrameSchema,
  MobileClientFileListFrameSchema,
  MobileClientUploadBeginFrameSchema,
  MobileClientUploadChunkFrameSchema,
  MobileClientUploadAbortFrameSchema,
  MobileCreatedV2FrameSchema,
  MobileDeliverableFrameSchema,
  MobileDeltaV2Schema,
  MobileFileChunkFrameSchema,
  MobileFileFrameSchema,
  MobileFileListFrameSchema,
  MobileHelloV2Schema,
  MobileModelChangedFrameSchema,
  MobileModelsFrameSchema,
  MobileRenamedFrameSchema,
  MobileSessionsV2FrameSchema,
  MobileToolFrameSchema,
  MobileServerUploadStartedFrameSchema,
  MobileServerUploadReceivedFrameSchema,
  MobileServerUploadedFrameSchema,
  type MobileClientFrameV2,
  type MobileHelloV2,
  type MobileServerFrameV2,
  type MobileSessionsV2Frame,
} from '../contracts/mobile-v2.js'

export { MOBILE_PROTOCOL_VERSION, MobileClientFrameSchema, MobileServerFrameSchema }
export type { MobileClientFrame, MobileServerFrame, MobileNodeCapabilities, MobileClientFrameV2 }

export type ClientIdentity = {
  name: string
  version: string
}

/**
 * 所有可能收到的服务端帧。shared 的 `MobileServerFrameAllSchema` 已经是
 * 「v1 其余变体 + v2 超集变体 + v2 独有帧」的判别联合，这里直接用它，
 * 避免同一帧类型出现两个成员导致 `Extract<…, {type}>` 退化成联合。
 */
export type AnyServerFrame = MobileServerFrameV2

// ── 上行帧 ──────────────────────────────────────────────────────────────────

const v = MOBILE_PROTOCOL_VERSION

/** v2 协商：客户端声明自己认识的特性（服务端回显启用的子集才生效）。 */
export function hello(
  requestId: string,
  client: ClientIdentity,
  features?: readonly string[],
): MobileClientFrame {
  return features && features.length > 0
    ? ({ v, type: 'hello', requestId, client, features } as unknown as MobileClientFrame)
    : { v, type: 'hello', requestId, client }
}

export function sessions(
  requestId: string,
  refresh?: boolean,
  includeArchived?: boolean,
): MobileClientFrame {
  return {
    v,
    type: 'sessions',
    requestId,
    ...(refresh === undefined ? {} : { refresh }),
    ...(includeArchived === undefined ? {} : { includeArchived }),
  } as MobileClientFrame
}

export function history(
  requestId: string,
  sessionId: string,
  options: { beforeSeq?: number | null; limit?: number } = {},
): MobileClientFrame {
  return {
    v,
    type: 'history',
    requestId,
    sessionId,
    ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  }
}

export interface CreateFrameOptions {
  title?: string
  /** 「普通对话」预设 id（由 Hub 下发，App 不硬编码语义）。 */
  preset?: string
  /** v2：新建后立即按这个选择执行 selectModel（cwd 永远不传）。 */
  provider?: string
  model?: string
  /** DSH effort id；模型不支持思考时必须缺省。 */
  effort?: string
}

export function create(requestId: string, options: CreateFrameOptions = {}): MobileClientFrame {
  const { title, preset, provider, model, effort } = options
  return {
    v,
    type: 'create',
    requestId,
    ...(title === undefined ? {} : { title }),
    ...(preset === undefined ? {} : { preset }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  } as MobileClientFrame
}

export function send(
  requestId: string,
  sessionId: string,
  text: string,
  clientMessageId: string,
  mode?: 'queue' | 'steer',
  attachments?: Array<{
    kind: 'image' | 'file'
    uploadId: string
    name: string
    mimeType: string
    bytes: number
  }>,
): MobileClientFrame {
  return {
    v,
    type: 'send',
    requestId,
    sessionId,
    text,
    ...(mode === undefined ? {} : { mode }),
    clientMessageId,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  } as MobileClientFrame
}

export function stop(requestId: string, sessionId: string): MobileClientFrame {
  return { v, type: 'stop', requestId, sessionId }
}

export function subscribe(
  requestId: string,
  sessionId: string,
  sinceCursor?: number | null,
): MobileClientFrame {
  return sinceCursor === undefined || sinceCursor === null
    ? { v, type: 'subscribe', requestId, sessionId }
    : { v, type: 'subscribe', requestId, sessionId, sinceCursor }
}

export function unsubscribe(sessionId: string): MobileClientFrame {
  return { v, type: 'unsubscribe', sessionId }
}

export function answerQuestion(
  requestId: string,
  sessionId: string,
  agent: string,
  callId: string,
  answers: MobileQuestionAnswer[],
): MobileClientFrame {
  return { v, type: 'answer-question', requestId, sessionId, agent, callId, answers }
}

export function answerApproval(
  requestId: string,
  sessionId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
): MobileClientFrame {
  return { v, type: 'answer-approval', requestId, sessionId, approvalId, decision }
}

export function ping(t: number): MobileClientFrame {
  return { v, type: 'ping', t }
}

// ── v2 上行帧 ───────────────────────────────────────────────────────────────

export function models(requestId: string, sessionId?: string): MobileClientFrame {
  return {
    v,
    type: 'models',
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
  } as unknown as MobileClientFrame
}

export function setModel(
  requestId: string,
  sessionId: string,
  input: { provider: string; model: string; effort?: string },
): MobileClientFrame {
  return {
    v,
    type: 'set-model',
    requestId,
    sessionId,
    provider: input.provider,
    model: input.model,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  } as unknown as MobileClientFrame
}

export function rename(requestId: string, sessionId: string, title: string): MobileClientFrame {
  return { v, type: 'rename', requestId, sessionId, title } as unknown as MobileClientFrame
}

export function archive(requestId: string, sessionId: string, archived: boolean): MobileClientFrame {
  return { v, type: 'archive', requestId, sessionId, archived } as unknown as MobileClientFrame
}

/** i) 会话用量请求（只读聚合；adapter 从 session/page 的 usage 累加后回 `usage` 帧）。 */
/**
 * 会话快照请求（幂等读，WP46 / M6 §2.2.4）。
 *
 * App 回前台探活成功后用它校正回合态/未决交互 —— 不需要重新 subscribe，
 * 也就不会扰动别人的跟随流。Hub 回一份 `session-state` 并带上同一个 requestId。
 */
export function sessionStateRequest(requestId: string, sessionId: string): MobileClientFrame {
  return { v, type: 'session-state-request', requestId, sessionId } as unknown as MobileClientFrame
}

export function usage(requestId: string, sessionId: string): MobileClientFrame {
  return { v, type: 'usage', requestId, sessionId } as unknown as MobileClientFrame
}

/** f) 读一个文件：`fileRef` 或相对会话根的 `path` 二选一（adapter 自己做防穿越）。 */
export function fileRead(
  requestId: string,
  sessionId: string,
  target: { fileRef?: string; path?: string },
): MobileClientFrame {
  return {
    v,
    type: 'file-read',
    requestId,
    sessionId,
    ...(target.fileRef === undefined ? {} : { fileRef: target.fileRef }),
    ...(target.path === undefined ? {} : { path: target.path }),
  } as unknown as MobileClientFrame
}

export function fileList(requestId: string, sessionId: string, path = '.'): MobileClientFrame {
  return { v, type: 'file-list', requestId, sessionId, path } as unknown as MobileClientFrame
}

/** g) 上传：声明大小与类型 → Hub 回 `upload-started{uploadId,maxChunkBytes}`。 */
export function uploadBegin(
  requestId: string,
  sessionId: string,
  input: { kind: 'image' | 'file'; name: string; mimeType: string; bytes: number },
): MobileClientFrame {
  return {
    v,
    type: 'upload-begin',
    requestId,
    sessionId,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType,
    bytes: input.bytes,
  } as unknown as MobileClientFrame
}

export function uploadChunk(
  requestId: string,
  uploadId: string,
  seq: number,
  base64: string,
  final = false,
): MobileClientFrame {
  return {
    v,
    type: 'upload-chunk',
    requestId,
    uploadId,
    seq,
    data: base64,
    ...(final ? { final: true } : {}),
  } as unknown as MobileClientFrame
}

export function uploadAbort(uploadId: string): MobileClientFrame {
  return { v, type: 'upload-abort', uploadId } as unknown as MobileClientFrame
}

// ── 序列化与校验 ────────────────────────────────────────────────────────────


/**
 * 反序列化（mock / 测试用）：先按 v1 再按 v2 校验，失败返回 null。
 *
 * v2 都用 strictObject：客户端帧多一个字段就是错（`cwd` 必须被拒、未知字段必须被拒），
 * 所以这里**不能**用 v1 的 `z.object` 兜底放宽。
 */
export function decodeClientFrame(input: unknown): MobileClientFrame | MobileClientFrameV2 | null {
  if (MobileClientFrameAllSchema.safeParse(input).success) {
    return input as MobileClientFrame | MobileClientFrameV2
  }
  return null
}

/**
 * 序列化前跑一遍 schema 校验：宁可本地抛错，也不要等 Hub 断连。
 * v1 strict / v2 strict 都要求「不含未知字段」。
 */
export function encodeClientFrame(frame: MobileClientFrame | MobileClientFrameV2): string {
  if (!MobileClientFrameAllSchema.safeParse(frame).success) {
    throw new Error(`客户端帧不符合 v1/v2 契约：${String((frame as { type?: unknown }).type)}`)
  }
  return JSON.stringify(frame)
}

// ── 下行帧 ──────────────────────────────────────────────────────────────────

/** v1 已知的服务端帧类型（schema 校验失败时用来区分「坏帧」和「新类型」）。 */
const KNOWN_SERVER_TYPES = new Set([
  'hello',
  'sessions',
  'history',
  'created',
  'ack',
  'error',
  'delta',
  'delta-end',
  'message',
  'turn',
  'state',
  'question',
  'question-settled',
  'assistant-baseline',
  'approval',
  'approval-settled',
  'stopped',
  'answer-result',
  'replay',
  'capability',
  'node-status',
  'pong',
  'bye',
  // v2
  'models',
  'model-changed',
  'tool',
  'deliverable',
  'renamed',
  'archived',
  'file',
  'file-chunk',
  'file-list',
  'upload-started',
  'upload-received',
  'uploaded',
  'session-state',
])

const V2_ONLY_SCHEMAS = [
  MobileModelsFrameSchema,
  MobileModelChangedFrameSchema,
  MobileToolFrameSchema,
  MobileDeliverableFrameSchema,
  MobileRenamedFrameSchema,
  MobileArchivedFrameSchema,
  MobileFileFrameSchema,
  MobileFileChunkFrameSchema,
  MobileFileListFrameSchema,
  MobileServerUploadStartedFrameSchema,
  MobileServerUploadReceivedFrameSchema,
  MobileServerUploadedFrameSchema,
]

const V2_ONLY_TYPES = new Set([
  'models',
  'model-changed',
  'tool',
  'deliverable',
  'renamed',
  'archived',
  'file',
  'file-chunk',
  'file-list',
  'upload-started',
  'upload-received',
  'uploaded',
  'session-state',
])

export type ParsedServerFrame =
  | { kind: 'frame'; frame: AnyServerFrame; raw: unknown }
  | { kind: 'protocol-mismatch'; version: unknown; raw: unknown }
  | { kind: 'unknown'; type: string; raw: unknown }
  | { kind: 'malformed'; type: string; reason: string; raw: unknown }

/**
 * 解析一条下行文本。规则（M4 §7 + M2 的宽容策略）：
 * - JSON 坏了 / 不是对象 → malformed（丢弃，不断连）；
 * - `v` 不是 1 → protocol-mismatch（上层停止重连并提示升级）；
 * - 未知 type → unknown（丢弃，允许 Hub 以后加帧）；
 * - 已知 type 但字段不符合 schema → malformed（丢弃并记录原因）。
 */
export function parseServerFrame(input: unknown): ParsedServerFrame {
  let raw: unknown = input
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch {
      return { kind: 'malformed', type: '', reason: 'invalid-json', raw: input }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'malformed', type: '', reason: 'not-an-object', raw }
  }
  const obj = raw as Record<string, unknown>
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (obj.v !== MOBILE_PROTOCOL_VERSION) {
    return { kind: 'protocol-mismatch', version: obj.v, raw }
  }
  if (!type) {
    return { kind: 'malformed', type, reason: 'missing-type', raw }
  }

  // 1) 共享包的 v1+v2 全量联合（v2 变体是 v1 的超集，判别联合里每种 type 只出现一次）。
  const parsed = MobileServerFrameAllSchema.safeParse(raw)
  if (parsed.success) {
    // 座舱（WP56d）：共享 schema 会剥掉未知字段，会话行的「发起人」从原始 JSON 补回来
    // （没有这个字段时原样返回，普通会话列表不受影响）。
    return {
      kind: 'frame',
      frame: withCockpitSessionInitiators(parsed.data as AnyServerFrame, raw),
      raw,
    }
  }

  // 2) 校验失败：区分「Hub 以后新加的帧类型」和「已知帧但字段不合契约」。
  if (!KNOWN_SERVER_TYPES.has(type)) return { kind: 'unknown', type, raw }
  return {
    kind: 'malformed',
    type,
    reason: parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; '),
    raw,
  }
}

/** 便捷判断：这一帧是否属于会话 `sessionId`（通道级帧没有 sessionId 时返回 false）。 */
export function frameSessionId(frame: AnyServerFrame): string | null {
  const value = (frame as { sessionId?: unknown }).sessionId
  return typeof value === 'string' ? value : null
}

export type { MobileNodeKind }

/** 供测试/诊断读取帧里携带的 cursor。 */
export function frameCursor(frame: AnyServerFrame): number | null {
  if (frame.type === 'history') return frame.cursor ?? null
  if (frame.type === 'replay') return frame.toCursor
  return null
}
