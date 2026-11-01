/**
 * 本地诊断事件（0.2.10）：启动 / 登录 / 链路事件的小环形缓冲，持久化在 localStorage。
 *
 * 目的：真机出现「用着用着不可用 / 又要重新登录」时，会话信息面板里能直接看到**跨重启**的
 * 事件序列（App 重新启动了没有、这次启动是恢复令牌还是自动登录、链路是 app 切后台还是
 * socket 1006 断开）。只记事件名与极短细节，**不记消息正文、不记令牌/口令**。
 */

export interface DiagEvent {
  at: number
  name: string
  detail: string
}

export const DIAGNOSTICS_KEY = 'dsh-hub:diagnostics:v1'
const LIMIT = 40
const DETAIL_MAX = 80

let cache: DiagEvent[] | null = null
let warned = false

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function parse(raw: string | null): DiagEvent[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const events: DiagEvent[] = []
    for (const item of value) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      const at = typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : 0
      const name = typeof record['name'] === 'string' ? record['name'] : ''
      const detail = typeof record['detail'] === 'string' ? record['detail'] : ''
      if (name.length === 0) continue
      events.push({ at, name: name.slice(0, 40), detail: detail.slice(0, DETAIL_MAX) })
    }
    return events.slice(-LIMIT)
  } catch {
    return []
  }
}

function load(): DiagEvent[] {
  if (cache !== null) return cache
  const store = storage()
  let raw: string | null = null
  try {
    raw = store?.getItem(DIAGNOSTICS_KEY) ?? null
  } catch {
    raw = null
  }
  cache = parse(raw)
  return cache
}

function persist(events: DiagEvent[]): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(DIAGNOSTICS_KEY, JSON.stringify(events))
  } catch {
    if (!warned) {
      warned = true
      console.warn('[dsh-hub] 诊断事件写不进去（localStorage 满/隐私模式），只保留内存')
    }
  }
}

/** 记一条诊断事件（跨重启保留最近 40 条）。 */
export function recordDiag(name: string, detail = ''): void {
  const events = [...load(), { at: Date.now(), name: name.slice(0, 40), detail: detail.slice(0, DETAIL_MAX) }]
  cache = events.slice(-LIMIT)
  persist(cache)
}

/** 读出全部诊断事件（旧→新，最多 40 条）。 */
export function readDiagEvents(): readonly DiagEvent[] {
  return load()
}

/** 清空（排查完/退出登录时可选调用）。 */
export function clearDiagEvents(): void {
  cache = []
  const store = storage()
  try {
    store?.removeItem(DIAGNOSTICS_KEY)
  } catch {
    /* ignore */
  }
}

/** 事件时间（HH:MM:SS，本地时区）。 */
export function formatDiagTime(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 诊断报告里描述的链路状态（`chat.link` 的中文说明）。 */
export function diagLinkText(link: string, reconnectAttempt = 0): string {
  switch (link) {
    case 'connected':
      return '已连接'
    case 'connecting':
    case 'idle':
      return '正在连接'
    case 'reconnecting':
      return `重连中（第 ${reconnectAttempt} 次）`
    case 'failed':
      return '已断开'
    case 'closed':
      return '连接已关闭'
    default:
      return '未连接'
  }
}

export interface DiagReportMeta {
  appVersion: string
  link: string
  reconnectAttempt?: number
  /**
   * 运行环境（0.4.5）：`android · 包名 tech.dshhub.app` 这类调试信息。
   * 设置页不再显示，排查时从这里带走。
   */
  environment?: string
  /** 生成时间（默认 now，测试里传固定值）。 */
  at?: Date
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 「复制诊断信息」用的文本（0.4.0 §1.3）。
 *
 * **只包含**：版本、链路状态、生成时间、事件名与 80 字以内的细节。
 * 绝不包含对话正文、令牌或地址（诊断事件本身就不记这些，见文件头注释）。
 */
export function formatDiagReport(
  events: readonly DiagEvent[],
  meta: DiagReportMeta,
): string {
  const at = meta.at ?? new Date()
  const stamp = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(
    at.getHours(),
  )}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
  const newestFirst = [...events].reverse()
  const lines = [
    'DSH Hub App 诊断信息',
    `版本 ${meta.appVersion} · 链路 ${diagLinkText(meta.link, meta.reconnectAttempt ?? 0)}`,
    ...(meta.environment ? [`运行环境 ${meta.environment}`] : []),
    `生成时间 ${stamp}`,
    `事件 ${newestFirst.length} 条（新→旧）`,
    '',
    ...newestFirst.map(
      (item) => `${formatDiagTime(item.at)}  ${item.name}${item.detail ? `  ${item.detail}` : ''}`,
    ),
  ]
  return lines.join('\n')
}
