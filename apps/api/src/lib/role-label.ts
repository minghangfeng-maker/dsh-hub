import { ROLE_TEXT_ADMIN, ROLE_TEXT_USER } from '@dsh-hub/shared'
import { HubError } from './errors.js'

/**
 * 角色标签规范化（用户与邀请码共用一份，04 §4.2 §4.4）：「普通用户」就是空串；
 * 「管理员」是保留名——拿它当普通用户的标签，会让人以为对方有管理权限，直接拒绝
 * （要给权限就把 role 设成 admin）。空串之外的标签已由 `RoleLabelSchema` 截到长度上限。
 */
export function normalizeRoleLabel(label: string): string {
  const trimmed = label.trim()
  if (trimmed === ROLE_TEXT_USER) return ''
  if (trimmed === ROLE_TEXT_ADMIN) {
    throw new HubError('VALIDATION_FAILED', '「管理员」是保留名称，要给管理权限请把角色设为管理员', {
      fields: { roleLabel: '保留名称' },
    })
  }
  return trimmed
}

/**
 * 角色标签的**展示口径**（04 §0.1 / D2 §5.1）：管理员恒显示「管理员」，
 * 普通用户显示自定义标签，空串显示「普通用户」。桌面端 `GET /api/desktop/session` 用它。
 */
export function roleLabelText(role: 'user' | 'admin', roleLabel: string): string {
  if (role === 'admin') return ROLE_TEXT_ADMIN
  const trimmed = roleLabel.trim()
  return trimmed === '' ? ROLE_TEXT_USER : trimmed
}
