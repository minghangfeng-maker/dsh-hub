import type { AuditItem } from '@dsh-hub/shared'

/**
 * 审计动作 → 中文文案（04 §7 的全部取值）。
 * 集中一份，概览的「最近审计」、用户详情「审计」Tab 与审计页共用。
 */
export const AUDIT_ACTION_TEXT: Record<string, string> = {
  'auth.register': '注册账号',
  'auth.login.success': '登录成功',
  'auth.login.failure': '登录失败',
  'auth.logout': '退出登录',
  'auth.password.change': '修改密码',
  'user.create': '创建用户',
  'user.update': '更新用户资料',
  'user.username.change': '修改用户名',
  'user.avatar.change': '更换头像',
  'user.approve': '通过审批',
  'user.disable': '停用账号',
  'user.enable': '启用账号',
  'user.role.change': '调整角色',
  'user.quota.change': '调整配额',
  'user.password.reset': '重置密码',
  'user.delete': '删除用户',
  'user.restore': '恢复用户',
  'user.purge': '彻底删除用户',
  'user.sessions.revoke': '强制下线',
  'instance.start': '启动实例',
  'instance.stop': '停止实例',
  'instance.restart': '重启实例',
  'instance.recreate': '重建实例',
  'instance.error': '实例异常',
  'instance.admin.open': '管理员进入实例',
  'invite.create': '生成邀请码',
  'invite.update': '修改邀请码',
  'invite.delete': '删除邀请码',
  'settings.update': '修改系统设置',
  'plugin.create': '添加插件',
  'plugin.update': '修改插件',
  'plugin.delete': '删除插件',
  'plugin.version.add': '新增插件版本',
  'plugin.version.delete': '删除插件版本',
  'runtime.build': '构建 DSH 版本',
  'runtime.default': '设为默认版本',
  'runtime.retire': '下线 DSH 版本',
  'runtime.delete': '删除 DSH 版本',
  'model.provider.create': '添加模型提供方',
  'model.provider.update': '修改模型提供方',
  'model.provider.delete': '删除模型提供方',
  'model.provider.key.change': '更换模型密钥',
  'model.catalog.change': '更新模型信息库',
  'model.preset.create': '添加模型预设',
  'model.preset.update': '修改模型预设',
  'model.preset.delete': '删除模型预设',
  'rollout.create': '创建下发任务',
  'job.cancel': '取消任务',
  'job.retry': '重试失败任务',
  'export.create': '发起数据导出',
  'export.download': '下载导出包',
}

/** 未知动作原样显示（后端新增动作时不至于空白）。 */
export function auditActionText(action: string): string {
  return AUDIT_ACTION_TEXT[action] ?? action
}

/** 动作前缀 → 图标（Uno 的 Phosphor 类名）。 */
export function auditActionIcon(action: string): string {
  if (action.startsWith('auth.')) return 'i-ph-sign-in'
  if (action.startsWith('user.')) return 'i-ph-user'
  if (action.startsWith('instance.')) return 'i-ph-hard-drives'
  if (action.startsWith('invite.')) return 'i-ph-ticket'
  if (action.startsWith('settings.')) return 'i-ph-gear-six'
  if (action.startsWith('plugin.')) return 'i-ph-puzzle-piece'
  if (action.startsWith('runtime.')) return 'i-ph-git-branch'
  if (action.startsWith('model.')) return 'i-ph-cpu'
  if (action.startsWith('rollout.')) return 'i-ph-rocket-launch'
  if (action.startsWith('job.')) return 'i-ph-list-checks'
  if (action.startsWith('export.')) return 'i-ph-export'
  return 'i-ph-dot-outline'
}

/** 审计列表的筛选下拉候选项（按 04 §7 分组后的常用动作）。 */
export const AUDIT_ACTION_OPTIONS: { label: string; value: string }[] = Object.entries(AUDIT_ACTION_TEXT).map(
  ([value, label]) => ({ label: `${label}（${value}）`, value }),
)

/** 「谁 + 做了什么 + 对谁」一行摘要。 */
export function auditSummary(item: AuditItem): string {
  const actor = item.actorUsername ?? (item.actorId ? `#${item.actorId}` : '系统')
  const target = item.targetType ? ` · ${item.targetType}${item.targetId ? ` #${item.targetId}` : ''}` : ''
  return `${actor} ${auditActionText(item.action)}${target}`
}
