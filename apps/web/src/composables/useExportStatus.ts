import type { ExportPart, ExportStatus } from '@dsh-hub/shared'

/** 导出状态 → 展示元数据（07 §6.2 的「进度卡 + 历史列表」共用）。 */
export interface ExportStatusMeta {
  text: string
  /** 胶囊色调（与实例状态同一套令牌） */
  tone: 'running' | 'progress' | 'idle' | 'error'
  icon: string
}

export const EXPORT_STATUS_META: Record<ExportStatus, ExportStatusMeta> = {
  queued: { text: '排队中', tone: 'progress', icon: 'i-ph-hourglass' },
  running: { text: '打包中', tone: 'progress', icon: 'i-ph-circle-notch' },
  ready: { text: '已完成', tone: 'running', icon: 'i-ph-check-circle' },
  failed: { text: '失败', tone: 'error', icon: 'i-ph-warning-circle' },
  expired: { text: '已过期', tone: 'idle', icon: 'i-ph-clock-countdown' },
}

export function exportStatusMeta(status: string): ExportStatusMeta {
  return EXPORT_STATUS_META[status as ExportStatus] ?? { text: '未知', tone: 'idle', icon: 'i-ph-question' }
}

/** 导出内容分区（04 §3.3）的中文名与说明，用户端与管理端共用。 */
export const EXPORT_PART_META: Record<ExportPart, { label: string; description: string; icon: string }> = {
  workspace: { label: '工作区', description: '/workspace 里的全部文件', icon: 'i-ph-folder' },
  sessions: { label: '会话记录', description: '聊天会话与附件', icon: 'i-ph-chats-circle' },
  settings: { label: 'DSH 设置', description: '插件配置与存储（不含密钥）', icon: 'i-ph-sliders' },
  'profile-plugins': { label: '插件清单', description: '便于在别处复原自装插件', icon: 'i-ph-puzzle-piece' },
}

/** 导出格式（04 §3.3） */
export const EXPORT_FORMAT_META: Record<'zip' | 'tar.gz', { label: string; hint: string }> = {
  zip: { label: 'ZIP（推荐）', hint: 'Windows 资源管理器可直接打开' },
  'tar.gz': { label: 'tar.gz', hint: '体积更小，适合 Linux / macOS' },
}

/** 一份导出包含哪些内容的中文摘要：`工作区、会话记录`。 */
export function describeExportParts(parts: readonly ExportPart[]): string {
  return parts.map((part) => EXPORT_PART_META[part]?.label ?? part).join('、')
}
