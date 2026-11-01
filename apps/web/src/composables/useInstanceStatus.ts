import type { InstanceStatus } from '@dsh-hub/shared'

/** 状态胶囊的色调分组（决定文字/底色令牌）。 */
export type StatusTone = 'running' | 'progress' | 'idle' | 'error'

export interface InstanceStatusMeta {
  /** 中文文案（07 §2.1 的实例状态） */
  text: string
  tone: StatusTone
  /** Uno 图标类名（Phosphor） */
  icon: string
  /** 运行中：呼吸光点（07 §2.5） */
  breathe: boolean
  /** 启动/停止中：旋转细环 */
  spinner: boolean
}

/**
 * 六种实例状态 → 展示元数据（07 §2.1）。
 * `stopped` / `absent` 共用灰色；`starting` / `stopping` 共用水青蓝。
 */
export const INSTANCE_STATUS_META: Record<InstanceStatus, InstanceStatusMeta> = {
  running: { text: '运行中', tone: 'running', icon: 'i-ph-play-circle', breathe: true, spinner: false },
  starting: { text: '启动中', tone: 'progress', icon: 'i-ph-circle-notch', breathe: false, spinner: true },
  stopping: { text: '停止中', tone: 'progress', icon: 'i-ph-circle-notch', breathe: false, spinner: true },
  stopped: { text: '已停止', tone: 'idle', icon: 'i-ph-stop-circle', breathe: false, spinner: false },
  absent: { text: '未创建', tone: 'idle', icon: 'i-ph-circle-dashed', breathe: false, spinner: false },
  error: { text: '异常', tone: 'error', icon: 'i-ph-warning-circle', breathe: false, spinner: false },
}

const UNKNOWN_META: InstanceStatusMeta = {
  text: '未知',
  tone: 'idle',
  icon: 'i-ph-question',
  breathe: false,
  spinner: false,
}

/** 取状态元数据（后端给了没见过的值时兜底，不抛错）。 */
export function instanceStatusMeta(status: string | null | undefined): InstanceStatusMeta {
  if (!status) return UNKNOWN_META
  return INSTANCE_STATUS_META[status as InstanceStatus] ?? UNKNOWN_META
}

/** 色调 → 前景/背景令牌（禁止写死颜色，CONTRIBUTING.md 的工程约定）。 */
export const STATUS_TONE_VARS: Record<StatusTone, { color: string; soft: string }> = {
  running: { color: 'var(--c-status-running)', soft: 'var(--c-success-soft)' },
  progress: { color: 'var(--c-status-starting)', soft: 'var(--c-sky-soft)' },
  idle: { color: 'var(--c-status-stopped)', soft: 'var(--c-bg)' },
  error: { color: 'var(--c-status-error)', soft: 'var(--c-danger-soft)' },
}

/** 插件期望/实际状态（03 §1.4）的中文文案，用户端与管理端共用。 */
export const USER_PLUGIN_STATE_TEXT: Record<string, string> = {
  synced: '已同步',
  pending: '进行中',
  failed: '失败',
}

/** 任务状态（04 §4.8）的中文文案。 */
export const JOB_STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  partial: '部分成功',
  canceled: '已取消',
}
