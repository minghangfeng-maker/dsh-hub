import type {
  JobStatus,
  JobSummary,
  JobTaskStatus,
  ModelKeyMode,
  PluginPolicy,
  PluginSourceType,
} from '@dsh-hub/shared'

import type { AdminTone } from '@/components/admin/tone'

/**
 * 管理端的展示元数据与中文文案：任务类型/状态、插件策略与来源、模型密钥模式。
 *
 * 概览页的「正在进行的任务」、任务中心列表/详情、插件与模型页共用一份，避免多处各写一遍；
 * 枚举值的中文覆盖由 `test/admin-enum-texts.test.ts` 守住（不允许把英文枚举直接显示给用户）。
 */
export const JOB_TYPE_TEXT: Record<string, string> = {
  export: '数据导出',
  'runtime.build': '构建 DSH 版本',
  'rollout.plugin': '插件下发',
  'rollout.runtime': 'DSH 升级',
  'rollout.models': '模型配置下发',
  // 18 §4.2：Claude Code / Codex 的开通与开放范围下发
  'rollout.agent-mode': '模式配置下发',
  'instance.recreate': '重建实例',
}

export const JOB_TYPE_ICON: Record<string, string> = {
  export: 'i-ph-export',
  'runtime.build': 'i-ph-hammer',
  'rollout.plugin': 'i-ph-puzzle-piece',
  'rollout.runtime': 'i-ph-git-branch',
  'rollout.models': 'i-ph-cpu',
  'rollout.agent-mode': 'i-ph-robot',
  'instance.recreate': 'i-ph-arrows-clockwise',
}

/**
 * **task** 状态的中文文案（04 §4.8 `JobTaskStatusSchema`）。
 * 注意与 job 状态不是一套：`pending` 是「排队中」、`skipped` 是「已跳过」。
 * （WP6 第二轮修：任务详情里 task 状态原先直接显示英文 `pending`。）
 */
export const JOB_TASK_STATUS_TEXT: Record<JobTaskStatus, string> = {
  pending: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过',
  canceled: '已取消',
}

/** 插件策略的中文文案（06 §2.2 / 07 §7.5 卡片标签）。 */
export const PLUGIN_POLICY_TEXT: Record<PluginPolicy, string> = {
  required: '必装',
  default: '默认装',
  optional: '可选',
  hidden: '下线',
}

/** 插件版本来源的中文文案（07 §7.5 版本列表的「来源」列）。 */
export const PLUGIN_SOURCE_TEXT: Record<PluginSourceType, string> = {
  npm: 'npm 包',
  tarball: 'tarball 包',
  local: '本地目录',
  upload: '上传 tgz',
}

/** 模型密钥模式的中文文案（07 §7.7 提供方列表）。 */
export const KEY_MODE_TEXT: Record<ModelKeyMode, string> = {
  shared: '共用一把',
  'per-user': '每人一把',
  none: '无需密钥',
}

export function jobTaskStatusText(status: string): string {
  return JOB_TASK_STATUS_TEXT[status as JobTaskStatus] ?? status
}

export function pluginPolicyText(policy: string): string {
  return PLUGIN_POLICY_TEXT[policy as PluginPolicy] ?? policy
}

export function pluginSourceText(source: string): string {
  return PLUGIN_SOURCE_TEXT[source as PluginSourceType] ?? source
}

export function keyModeText(mode: string): string {
  return KEY_MODE_TEXT[mode as ModelKeyMode] ?? mode
}

export const JOB_STATUS_TONE: Record<JobStatus, AdminTone> = {
  queued: 'neutral',
  running: 'sky',
  paused: 'butter',
  succeeded: 'success',
  failed: 'danger',
  partial: 'butter',
  canceled: 'neutral',
}

/** 任务可以被暂停/恢复/取消（其余状态只读）。 */
export function isJobActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'paused'
}

export function jobTypeText(type: string): string {
  return JOB_TYPE_TEXT[type] ?? type
}

export function jobTypeIcon(type: string): string {
  return JOB_TYPE_ICON[type] ?? 'i-ph-list-checks'
}

/** 已完成比例（0–100 整数），用于进度条文案。 */
export function jobPercent(job: Pick<JobSummary, 'total' | 'done'>): number {
  if (job.total <= 0) return 0
  return Math.round((job.done / job.total) * 100)
}

/** 任务持续时间文案（未结束的返回 null）。 */
export function jobDuration(job: Pick<JobSummary, 'startedAt' | 'finishedAt'>): number | null {
  if (!job.startedAt || !job.finishedAt) return null
  const span = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
  return Number.isFinite(span) && span >= 0 ? span : null
}
