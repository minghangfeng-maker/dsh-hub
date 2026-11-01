/**
 * 错误码 → 中文提示（唯一映射表）。
 *
 * 原则（开发文档 §1.4/§6）：界面不出现原始 code、不出现服务器地址；
 * 每个码都要有一句**用户能行动**的话。同一个码在登录页、首页状态条、对话页出错时
 * 用同一句，避免同一故障在不同页面名字不同。
 */

import { MobileErrorCodeSchema, MobileErrorCodeV2ExtraSchema, type MobileErrorCode } from '@dsh-hub/shared'

/** 通道 v2 错误码（含在 `HubErrorCode` 里，文案与 v1 同表）。 */
type MobileErrorCodeV2 = import('zod').infer<typeof MobileErrorCodeV2ExtraSchema>

/** 认证/HTTP 层错误码（与 `AuthErrorCodeSchema` 同源）。 */
export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'USER_DISABLED'
  | 'USER_PENDING'
  | 'MUST_CHANGE_PASSWORD'
  | 'RATE_LIMITED'
  | 'ACCOUNT_LOCKED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_TOKEN_INVALID'
  | 'UNAUTHENTICATED'
  | 'INVALID_REQUEST'
  | 'INTERNAL'

/** 客户端自己产生的错误码（网络、超时、响应不合法）。 */
export type ClientErrorCode = 'network' | 'timeout' | 'protocol' | 'cancelled'

/** 契约草案 §2 的错误码（wake/bootstrap）。 */
export type BootstrapErrorCode =
  | 'CAPACITY_FULL'
  | 'INSUFFICIENT_POINTS'
  | 'INSTANCE_ABSENT'
  | 'INSTANCE_STARTING'
  /** 上线决定 ①：首次 wake 时 Hub 自动开通失败（HTTP 500） */
  | 'INSTANCE_PROVISION_FAILED'

export type HubErrorCode =
  | AuthErrorCode
  | ClientErrorCode
  | BootstrapErrorCode
  | MobileErrorCode
  | MobileErrorCodeV2

const MESSAGES: Record<string, string> = {
  // ── 登录 / 会话 ───────────────────────────────────────────────────────────
  INVALID_CREDENTIALS: '用户名或密码不正确',
  USER_DISABLED: '账号已停用，请联系管理员',
  USER_PENDING: '账号正在等待审批，管理员通过后即可登录',
  MUST_CHANGE_PASSWORD: '为了账号安全，需要先在网页端修改密码',
  RATE_LIMITED: '尝试太频繁了，请稍等一会儿再试',
  ACCOUNT_LOCKED: '尝试太频繁了，请稍等一会儿再试',
  DEVICE_REVOKED: '本设备已被移出登录状态，请重新登录',
  DEVICE_TOKEN_INVALID: '登录状态需要刷新',
  UNAUTHENTICATED: '登录状态已失效，请重新登录',
  'session-expired': '登录状态已过期，请重新登录',
  INVALID_REQUEST: '请求有误，请更新 App 后再试',
  INTERNAL: '服务出了点问题，请稍后重试',

  // ── 网络/客户端 ──────────────────────────────────────────────────────────
  network: '网络连接失败，请检查网络后重试',
  timeout: '请求超时，请重试',
  protocol: '收到无法识别的响应，请更新 App 后再试',
  cancelled: '请求已取消',

  // ── bootstrap / 唤醒 ──────────────────────────────────────────────────────
  CAPACITY_FULL: '当前使用人数较多，请稍后再试',
  INSUFFICIENT_POINTS: '积分不足，请充值后再试',
  INSTANCE_ABSENT: '你的助手还没有开通，正在为你开通',
  INSTANCE_PROVISION_FAILED: '开通失败，请重试；一直失败请联系管理员',
  INSTANCE_STARTING: '助手正在启动，请稍等片刻',
  DISK_QUOTA_EXCEEDED: '磁盘空间不足，请清理后再试',
  RUNTIME_NOT_READY: '助手还在准备运行环境，请稍等',
  INSTANCE_BUSY: '助手正在忙，请稍后再试',
  INSTANCE_START_FAILED: '助手启动失败，请稍后重试',

  // ── 通道（M4 §4.3 + v1.1/v1.2 补充） ─────────────────────────────────────
  'node-not-found': '找不到这个后端，请重新打开 App',
  'node-offline': '这个后端当前离线',
  'node-not-connectable': '这个后端现在不可连接',
  'instance-not-running': '你的助手还没启动，正在尝试唤醒',
  'adapter-incompatible': '后端版本不兼容，请联系管理员升级',
  'adapter-unavailable': '后端暂时不可用，请稍后重试',
  'session-not-found': '这个会话不存在或已被删除',
  'agent-busy': '助手正忙，请稍后再发',
  'question-not-answerable': '这个问题已经不能回答了',
  'approval-not-answerable': '这次操作需要在网页端批准',
  'approval-expired': '审批已过期，本次操作已取消',
  'send-in-flight': '上一条消息还在发送中，请稍候',
  'protocol-version-unsupported': '客户端版本过旧，请升级 App',
  'frame-too-large': '消息太长了，请缩短后再发',
  'upstream-unavailable': '服务暂时不可用，请稍后重试',
  'relay-disconnected': '电脑端已断开连接',
  internal: '服务出了点问题，请重试',

  // 客户端内部状态（不在 Hub 白名单里，但 UI 需要同一套文案）
  'not-connected': '连接还没就绪，消息尚未发送',
  'stop-requested': '正在停止当前回合，请稍候再发送',
  'reconnecting': '连接已断开，正在重连…',
  'reconnect-failed': '与后端的连接已断开，请点击重试',
  'send-failed': '连接已断开，消息尚未发送',
  'wake-timeout': '唤醒超时了，请稍后重试',
  unsupported: '当前后端不支持这个操作',

  // ── 管理座舱（WP56d，docs/24 §3.3）──────────────────────────────────────
  // 交接码失效/过期/用过：嵌入模式里不弹登录页，而是等父页面重新发一个码。
  'cockpit-handoff-invalid': '座舱交接已失效，正在重新连接…',

  // ── 通道 v2（shared 的 MobileErrorCodeV2ExtraSchema）────────────────────
  'model-unavailable': '这个模型现在不可用，请换一个再试',
  'effort-unsupported': '当前模型不支持这个思考程度',
  'preset-not-found': '对话预设不存在，请联系管理员',
  'title-invalid': '标题不合法，请换一个',
  'file-not-found': '文件不存在或已过期',
  'file-refused': '不允许访问这个文件',
  'file-too-large': '文件太大了，请压缩或换一个',
  'file-not-text': '这个文件不是文本，无法预览',
  'archive-unsupported': '当前后端不支持归档',
  'rename-unsupported': '当前后端不支持重命名',
  'feature-unsupported': '当前后端不支持这个功能',

  // ── 服务端语音识别（0.4.2 / WP49：POST /api/mobile/asr）─────────────────
  // 只用于非界面主路径的兜底：语音的最终文案在 lib/voice-input.ts（同一批码，措辞更口语）。
  VALIDATION_FAILED: '请求内容不合法，请更新 App 后再试',
  PAYLOAD_TOO_LARGE: '内容太大了，请缩短后再试',
  UNSUPPORTED_MEDIA: '这个格式不支持，请更新 App 后再试',
  UPSTREAM_ERROR: '服务暂时不可用，请稍后重试',

  // ── 流式朗读（0.4.6 / WP51）───────────────────────────────────────────────
  // 开始下发后 Hub 直接掐断连接（不冒充星汐的声音）：对用户就是「这次读不了」。
  'stream-interrupted': '朗读暂时不可用',
}

/** 未知码统一兜底：不要把它原样显示给用户。 */
export const FALLBACK_MESSAGE = '操作没有完成，请稍后重试'

export function errorMessage(code: string | null | undefined, fallback = FALLBACK_MESSAGE): string {
  if (!code) return fallback
  return MESSAGES[code] ?? fallback
}

/** 是否属于「登录彻底失效」：要清令牌并回登录页。 */
export function isAuthLostCode(code: string): boolean {
  return (
    code === 'UNAUTHENTICATED' ||
    code === 'DEVICE_REVOKED' ||
    code === 'session-expired' ||
    code === 'INVALID_CREDENTIALS'
  )
}

/** 这个 401 是「该刷新了」还是「必须重新登录」。 */
export function isRefreshableCode(code: string): boolean {
  return code === 'DEVICE_TOKEN_INVALID' || code === 'UNAUTHENTICATED'
}

/** 是否值得给「重试」按钮。 */
export function isRetryableCode(code: string): boolean {
  return (
    code === 'network' ||
    code === 'timeout' ||
    code === 'CAPACITY_FULL' ||
    code === 'INSTANCE_STARTING' ||
    code === 'upstream-unavailable' ||
    code === 'adapter-unavailable' ||
    code === 'RUNTIME_NOT_READY' ||
    code === 'INSTANCE_BUSY' ||
    code === 'INSTANCE_START_FAILED' ||
    code === 'INSTANCE_PROVISION_FAILED' ||
    code === 'reconnect-failed' ||
    // 0.4.2 语音识别：识别服务临时没起来，重按一次值得重试
    code === 'UPSTREAM_ERROR'
  )
}

/** 通道错误码白名单：判错时用，避免把 Hub 新增的码当成崩溃。 */
export function isMobileErrorCode(code: string): code is MobileErrorCode | MobileErrorCodeV2 {
  return (
    MobileErrorCodeSchema.safeParse(code).success ||
    MobileErrorCodeV2ExtraSchema.safeParse(code).success
  )
}

/**
 * 规范化 code：Hub 可能给大写枚举（认证）或 kebab-case（通道）。
 * 不认识的码一律降级成 `internal`，但保留原始值在 detail 里便于诊断日志。
 */
export function normalizeCode(code: string | null | undefined): string {
  if (!code) return 'internal'
  if (MESSAGES[code]) return code
  const lower = code.toLowerCase()
  if (MESSAGES[lower]) return lower
  return 'internal'
}

/** HTTP 状态 → 认证错误码（Hub 没给 body 时的兜底，见契约草案 §1）。 */
export function codeFromHttpStatus(status: number): string {
  switch (status) {
    case 401:
      return 'INVALID_CREDENTIALS'
    case 402:
      return 'INSUFFICIENT_POINTS'
    case 403:
      return 'USER_DISABLED'
    case 404:
      return 'INSTANCE_ABSENT'
    case 409:
      return 'CAPACITY_FULL'
    case 413:
      // 0.4.2 语音上传：Hub 的 413 会带 body，这里只是没有 body 时的兜底
      return 'PAYLOAD_TOO_LARGE'
    case 415:
      return 'UNSUPPORTED_MEDIA'
    case 429:
      return 'RATE_LIMITED'
    case 502:
      return 'UPSTREAM_ERROR'
    default:
      return status >= 500 ? 'INTERNAL' : 'INVALID_REQUEST'
  }
}

/**
 * HTTP 层错误：`code` 是规范化后的码（见 normalizeCode），`status` 保留原始 HTTP 状态，
 * `detail` 只用于本地诊断（不写正文、不写令牌）。
 */
export class HubApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean
  readonly detail?: string
  /** 限流倒计时（秒）：来自 Hub 的 `details.retryAfterSec`。 */
  readonly retryAfterSec?: number

  constructor(
    code: string,
    init: {
      status?: number
      message?: string
      retryable?: boolean
      detail?: string
      retryAfterSec?: number
    } = {},
  ) {
    const normalized = normalizeCode(code)
    super(init.message ?? errorMessage(normalized))
    this.name = 'HubApiError'
    this.code = normalized
    this.status = init.status ?? 0
    this.retryable = init.retryable ?? isRetryableCode(normalized)
    this.detail = init.detail
    this.retryAfterSec = init.retryAfterSec
  }
}

/** M4 §3.1 的不可连接原因码 → 中文（列表与弹层共用，UI 不许自己编）。 */
const BLOCKED_REASON_MESSAGES: Record<string, string> = {
  'desktop-remote-off': '需要在电脑端打开「允许远程连接」',
  'desktop-relay-disconnected': '电脑端没有连上 Hub',
  'desktop-host-stopped': '电脑上的 DSH 没有运行',
  'desktop-needs-upgrade': '电脑端版本过低，请升级',
  'adapter-incompatible': '后端版本不兼容',
  'adapter-probe-failed': '后端探测失败',
  'instance-not-running': '你的助手还没启动',
}

export function blockedReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null
  return BLOCKED_REASON_MESSAGES[reason] ?? null
}
