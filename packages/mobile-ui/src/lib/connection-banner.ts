/**
 * 连接状态横幅的**纯函数**（0.4.1 连接 UX）。
 *
 * 用户反馈：锁屏解锁回 App，最上方先闪一下「正在连接你的助手…」，1–2 秒后又消失。
 * 现在只有**真的连不上**才显示：
 *
 *   - 未连上 **< 4 秒**（宽限期）：一律不显示 —— 包括 connecting / reconnecting /
 *     回前台重连 / 唤醒中。这一段就是「锁屏回来闪一下」的那 1–2 秒；
 *   - **4–15 秒**：中性提示。唤醒中「正在唤醒你的助手…」，其它「正在连接服务器…」；
 *     **不再显示「第 N 次」重连次数**（用户不关心重试了几次，只觉得吵）；
 *   - **≥ 15 秒 / link 为 failed / 明确原因**：警示「暂时连不上服务器」+ 重试按钮。
 *     容量满、后端不可连接这类**明确原因**保持原文案并立即显示，不等宽限；
 *   - 连上立刻隐藏（计时由 store 在 link 回到 connected 时清零）；
 *   - 切后台期间不计时：store 在切后台时把 `notConnectedSince` 置空，回前台从那一刻
 *     重新开始算，所以锁屏很久回来不会立刻弹警示。
 *
 * 队列里的消息（0.4.1 §3）：因为没连上还没发出去的那条，气泡下面显示
 * 「与服务器连接中…」（带小转圈）；它自己排队超过 15 秒才变成
 * 「暂时连不上服务器，连上后自动发送 · 重试」。**这种情况顶部条不再重复**
 * 「就绪后自动发送」——文案只在消息下方出现一次。
 *
 * 这里只做「输入 → 文案」的纯计算，不读时间、不碰 DOM、不看 store：
 * 单测把每个分支都锁住（test/connection-banner.test.ts），渲染层只负责画。
 */

/** 与 core 的 `LinkState` 同构（单独声明，lib 不反向依赖 store / core 状态机）。 */
export type BannerLinkState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'failed'

/** 与 stores/backend 的 `WakeState` 同构。 */
export type BannerWakeState = 'idle' | 'waking' | 'ready' | 'blocked'

/** bootstrap.instance.status 的取值（null = 还没拿到 bootstrap）。 */
export type BannerInstanceStatus =
  | 'error'
  | 'absent'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | null

/** 状态条语气：中性 / 警示 / 硬失败（不可重试的明确原因）。 */
export type BannerTone = 'info' | 'warn' | 'error'

/** 横幅上的可执行动作：重连链路 / 重试唤醒（或容量满后的重试）。 */
export type BannerAction = '重连' | '重试'

/** 未连上的宽限期：不足这么久不显示任何连接提示。 */
export const CONNECTION_GRACE_MS = 4_000
/** 超过这么久还没连上，才升级成「暂时连不上服务器 + 重试」。 */
export const CONNECTION_WARN_MS = 15_000

/** 中性文案（4–15 秒）。 */
export const CONNECTING_TEXT = '正在连接服务器…'
export const WAKING_TEXT = '正在唤醒你的助手…'
/** 警示文案（≥15 秒 / link failed）。 */
export const OFFLINE_TEXT = '暂时连不上服务器'
/** 明确原因（不等宽限）。 */
export const NOT_CONNECTABLE_TEXT = '当前后端不可连接'
export const CAPACITY_FULL_TEXT = '当前使用人数较多，请稍后再试'
export const WAKE_BLOCKED_TEXT = '助手暂时不可用'

/** 队列消息气泡下的连接状态文案（0.4.1 §3）。 */
export const QUEUED_CONNECTING_TEXT = '与服务器连接中…'
export const QUEUED_TIMEOUT_TEXT = '暂时连不上服务器，连上后自动发送'

/** 一条横幅：`show=false` 时 `text` 为空串，渲染层据此整块不挂载。 */
export interface ConnectionBanner {
  show: boolean
  text: string
  tone: BannerTone
  action?: BannerAction
}

export interface ConnectionBannerInput {
  link: BannerLinkState
  wakeState: BannerWakeState
  /** bootstrap 里的实例状态（starting = 正在唤醒）。 */
  instanceStatus?: BannerInstanceStatus
  /**
   * 选中后端能不能连：
   *  - `true` 可连接；`false` 明确不可连接（立即显示原因）；
   *  - `null` 还没有选中后端 / 后端列表还没回来（按「连接中」处理，走宽限）。
   */
  connectable?: boolean | null
  /** 实例是否容量满（bootstrap.instance.capacityFull）。 */
  capacityFull?: boolean
  /** 明确原因的文案（`auth.issue`：唤醒被拦、容量满）；没有就用固定文案。 */
  reason?: { text: string; retryable: boolean } | null
  /** 未连上的起点（毫秒）；null = 已连接 / 切后台暂停 / 还没登录（都不计时）。 */
  notConnectedSince: number | null
  now: number
  /**
   * 发送队列里还有多少条。
   *
   * 0.4.1 起**不再**用它把「助手就绪后自动发送」塞进顶部条（那句话现在只在
   * 消息气泡下方出现一次）；保留在输入里是为了诊断与后续文案，当前不改变输出。
   */
  queued?: number
  /** 宽限期（测试注入用；默认 4s）。 */
  graceMs?: number
  /** 升级成警示的阈值（测试注入用；默认 15s）。 */
  warnMs?: number
}

const HIDDEN: ConnectionBanner = { show: false, text: '', tone: 'info' }

/** 从 `notConnectedSince` 算未连上多久；没有起点或时间不合法按 0 算。 */
function elapsedMs(since: number | null, now: number): number {
  if (since === null || !Number.isFinite(since) || !Number.isFinite(now)) return 0
  return Math.max(0, now - since)
}

/**
 * 顶部连接横幅。规则顺序即优先级（见文件头）：
 * 连上 → 唤醒被拦 → 唤醒中 → 容量满 → 后端不可连接 → link failed → 超时 → 宽限。
 */
export function connectionBanner(input: ConnectionBannerInput): ConnectionBanner {
  const graceMs = input.graceMs ?? CONNECTION_GRACE_MS
  const warnMs = input.warnMs ?? CONNECTION_WARN_MS
  const elapsed = elapsedMs(input.notConnectedSince, input.now)
  const waking = input.wakeState === 'waking' || input.instanceStatus === 'starting'

  // 1) 连上立刻收起来（计时清零点在 store 里，见 chat.ts）
  if (input.link === 'connected') return HIDDEN

  // 2) 唤醒被拦（容量满 / 开通失败 / 唤醒超时）：这是明确失败，立即显示 + 可重试时给按钮
  if (input.wakeState === 'blocked') {
    const reason = input.reason ?? null
    return {
      show: true,
      text: reason?.text ?? WAKE_BLOCKED_TEXT,
      tone: reason !== null && reason.retryable === false ? 'error' : 'warn',
      ...(reason !== null && reason.retryable ? { action: '重试' as const } : {}),
    }
  }

  // 3) 唤醒中：宽限内什么都不显示（云容器冷启动通常 1–11 秒），超时才升级
  if (waking) {
    if (elapsed < graceMs) return HIDDEN
    if (elapsed >= warnMs) return { show: true, text: OFFLINE_TEXT, tone: 'warn', action: '重试' }
    return { show: true, text: WAKING_TEXT, tone: 'info' }
  }

  // 4) 容量满：明确原因，立即显示（文案沿用 auth.issue 那份）
  if (input.capacityFull === true) {
    const reason = input.reason ?? null
    return {
      show: true,
      text: reason?.text ?? CAPACITY_FULL_TEXT,
      tone: 'warn',
      ...(reason?.retryable ? { action: '重试' as const } : {}),
    }
  }

  // 5) 后端明确不可连接：立即显示原因（旧文案保持不变），没有可执行动作
  if (input.connectable === false) {
    return { show: true, text: NOT_CONNECTABLE_TEXT, tone: 'warn' }
  }

  // 6) 链路彻底失败（建链失败 / 重连放弃）：不等宽限，直接给「重连」
  if (input.link === 'failed') {
    return { show: true, text: OFFLINE_TEXT, tone: 'warn', action: '重连' }
  }

  // 7) 连了很久连不上：警示 + 重试
  if (elapsed >= warnMs) return { show: true, text: OFFLINE_TEXT, tone: 'warn', action: '重试' }

  // 8) 宽限期过了但还在努力：中性提示，不显示重连次数
  if (elapsed >= graceMs) return { show: true, text: CONNECTING_TEXT, tone: 'info' }

  // 9) 宽限期内：安静（锁屏回来闪的那一下就是这里消掉的）
  return HIDDEN
}

/** 队列消息的连接状态：连接中 / 排队太久。 */
export type QueuedLinkState = 'connecting' | 'timeout'

export interface QueuedLinkInput {
  /** 这条消息还在发送队列里（还没发出去）。 */
  queued: boolean
  /** 链路已连上（连上后由「发送中…」接手，不再显示连接状态）。 */
  connected: boolean
  /** 这条消息的入队时间：计时起点是**它自己**排队了多久，不是整条链路断了多久。 */
  queuedAt: number
  now: number
  /** 升级成「暂时连不上」的阈值（默认 15s）。 */
  warnMs?: number
}

/**
 * 一条待发消息现在该显示什么连接状态（null = 不显示，交给「发送中…」）。
 *
 * 计时起点用**消息自己的入队时间**：断线很久之后才发的消息，先显示「与服务器连接中…」，
 * 排队超过 15 秒才变成「暂时连不上服务器，连上后自动发送」。
 */
export function queuedLinkState(input: QueuedLinkInput): QueuedLinkState | null {
  if (!input.queued) return null
  if (input.connected) return null
  const warnMs = input.warnMs ?? CONNECTION_WARN_MS
  return elapsedMs(input.queuedAt, input.now) >= warnMs ? 'timeout' : 'connecting'
}

/** 队列消息的文案（`null` = 不显示）。 */
export function queuedLinkText(state: QueuedLinkState | null): string {
  if (state === 'connecting') return QUEUED_CONNECTING_TEXT
  if (state === 'timeout') return QUEUED_TIMEOUT_TEXT
  return ''
}
