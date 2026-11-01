import { describe, expect, it } from 'vitest'

import {
  createRoleOption,
  parseRoleChoice,
  roleChoiceOptions,
  roleFilterOptions,
  roleFilterQuery,
  roleText,
  roleTone,
} from '@/components/admin/role'

/** 角色下拉 = 权限（admin/user）+ 普通用户的自定义标签，值就是显示文字 */
describe('自定义角色标签', () => {
  it('显示文字与色调：管理员 / 自定义标签 / 普通用户', () => {
    expect(roleText({ role: 'admin', roleLabel: '' })).toBe('管理员')
    expect(roleText({ role: 'user', roleLabel: '家人' })).toBe('家人')
    expect(roleText({ role: 'user', roleLabel: '' })).toBe('普通用户')
    expect(roleTone({ role: 'admin', roleLabel: '' })).toBe('sakura')
    expect(roleTone({ role: 'user', roleLabel: '家人' })).toBe('sky')
    expect(roleTone({ role: 'user', roleLabel: '' })).toBe('neutral')
  })

  it('下拉的值拆回 role + roleLabel：只有「管理员」给管理权限', () => {
    expect(parseRoleChoice('管理员')).toEqual({ role: 'admin', roleLabel: '' })
    expect(parseRoleChoice('普通用户')).toEqual({ role: 'user', roleLabel: '' })
    expect(parseRoleChoice(' 朋友 ')).toEqual({ role: 'user', roleLabel: '朋友' })
  })

  it('候选项：普通用户在前、管理员在后，刚输入的新标签补进列表', () => {
    const labels = [{ label: '家人', count: 2 }]
    expect(roleChoiceOptions(labels).map((o) => o.value)).toEqual(['普通用户', '家人', '管理员'])
    expect(roleChoiceOptions(labels, '同事').map((o) => o.value)).toEqual([
      '普通用户',
      '家人',
      '同事',
      '管理员',
    ])
    expect(roleChoiceOptions(labels, '家人')).toHaveLength(3)
    expect(createRoleOption('  一二三四五六七八九十一二三四五六七  ').value).toBe(
      '一二三四五六七八九十一二三四五六',
    )
  })

  it('邀请码的下拉没有「管理员」（allowAdmin: false），当前值也不会把管理员带回来', () => {
    const labels = [
      { label: '家人', count: 2 },
      { label: '同事', count: 0 },
    ]
    expect(roleChoiceOptions(labels, '', { allowAdmin: false }).map((o) => o.value)).toEqual([
      '普通用户',
      '家人',
      '同事',
    ])
    expect(roleChoiceOptions(labels, '只发过码', { allowAdmin: false }).map((o) => o.value)).toEqual([
      '普通用户',
      '家人',
      '同事',
      '只发过码',
    ])
    // 万一当前值是「管理员」（不该出现），也不会把它变成可选项
    expect(roleChoiceOptions(labels, '管理员', { allowAdmin: false }).map((o) => o.value)).toEqual([
      '普通用户',
      '家人',
      '同事',
    ])
  })

  it('列表筛选：label: 前缀只看该标签的普通用户', () => {
    expect(roleFilterOptions([{ label: '家人', count: 2 }]).map((o) => o.value)).toEqual([
      '',
      'admin',
      'user',
      'label:家人',
    ])
    expect(roleFilterQuery('label:家人')).toEqual({ roleLabel: '家人' })
    expect(roleFilterQuery('admin')).toEqual({ role: 'admin' })
    expect(roleFilterQuery('')).toEqual({})
  })
})
