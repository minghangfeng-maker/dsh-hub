import {
  ROLE_LABEL_MAX_LENGTH,
  ROLE_TEXT_ADMIN,
  ROLE_TEXT_USER,
  type Role,
  type RoleLabelUsage,
} from '@dsh-hub/shared'
import type { SelectOption } from 'naive-ui'

import type { AdminTone } from './tone'

/**
 * 角色 = 权限（admin / user）+ 普通用户的自定义标签（「家人」「朋友」……）。
 * 界面上合成一个「角色」下拉，值就是显示文字：「管理员」→ admin；「普通用户」→ user + 空标签；
 * 其余任意文字 → user + 该标签（tag 模式下新输入的文字直接成为值）。
 */
export interface RoleHolder {
  role: Role
  roleLabel: string
}

export function roleText(user: RoleHolder): string {
  if (user.role === 'admin') return ROLE_TEXT_ADMIN
  return user.roleLabel || ROLE_TEXT_USER
}

/** 管理员紫罗兰、自定义标签天蓝、无标签的普通用户灰 */
export function roleTone(user: RoleHolder): AdminTone {
  if (user.role === 'admin') return 'sakura'
  return user.roleLabel ? 'sky' : 'neutral'
}

export function parseRoleChoice(choice: string): RoleHolder {
  const text = choice.trim()
  if (text === ROLE_TEXT_ADMIN) return { role: 'admin', roleLabel: '' }
  if (text === ROLE_TEXT_USER) return { role: 'user', roleLabel: '' }
  return { role: 'user', roleLabel: text }
}

/** 角色下拉的候选：普通用户 → 在用的自定义标签 → 管理员；`current` 不在列表里时补上（刚输入的新标签） */
export function roleChoiceOptions(
  labels: readonly RoleLabelUsage[],
  current = '',
  options: { allowAdmin?: boolean } = {},
): SelectOption[] {
  const { allowAdmin = true } = options
  const custom = labels.map((item) => item.label)
  if (current && current !== ROLE_TEXT_ADMIN && current !== ROLE_TEXT_USER && !custom.includes(current)) {
    custom.push(current)
  }
  return [
    { label: ROLE_TEXT_USER, value: ROLE_TEXT_USER },
    ...custom.map((label) => ({ label, value: label })),
    // 邀请码只发普通用户：生成/修改邀请码的下拉传 `allowAdmin: false`（07 §7.10）
    ...(allowAdmin ? [{ label: ROLE_TEXT_ADMIN, value: ROLE_TEXT_ADMIN }] : []),
  ]
}

/** tag 模式新建选项：去掉首尾空白并截到长度上限（服务端同样校验） */
export function createRoleOption(input: string): SelectOption {
  const label = input.trim().slice(0, ROLE_LABEL_MAX_LENGTH)
  return { label, value: label }
}

/** 用户列表的角色筛选：`label:<标签>` 只看该标签的普通用户 */
const LABEL_FILTER_PREFIX = 'label:'

export function roleFilterOptions(labels: readonly RoleLabelUsage[]): SelectOption[] {
  return [
    { label: '全部角色', value: '' },
    { label: ROLE_TEXT_ADMIN, value: 'admin' },
    { label: `所有${ROLE_TEXT_USER}`, value: 'user' },
    ...labels.map((item) => ({ label: item.label, value: `${LABEL_FILTER_PREFIX}${item.label}` })),
  ]
}

export function roleFilterQuery(value: string): { role?: Role; roleLabel?: string } {
  if (value.startsWith(LABEL_FILTER_PREFIX)) return { roleLabel: value.slice(LABEL_FILTER_PREFIX.length) }
  if (value === 'admin' || value === 'user') return { role: value }
  return {}
}
