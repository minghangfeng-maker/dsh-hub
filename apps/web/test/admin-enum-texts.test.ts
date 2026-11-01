import {
  AnnouncementLevelSchema,
  InstanceStatusSchema,
  JobStatusSchema,
  JobTaskStatusSchema,
  ModelKeyModeSchema,
  ModelPolicySchema,
  PluginPolicySchema,
  PluginSourceTypeSchema,
  RegistrationModeSchema,
  RoleSchema,
  RuntimeStatusSchema,
  UserPluginDesiredSchema,
  UserPluginStateSchema,
  UserStatusSchema,
} from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  JOB_STATUS_TONE,
  JOB_TASK_STATUS_TEXT,
  JOB_TYPE_TEXT,
  KEY_MODE_TEXT,
  PLUGIN_POLICY_TEXT,
  PLUGIN_SOURCE_TEXT,
  jobTaskStatusText,
  keyModeText,
  pluginPolicyText,
  pluginSourceText,
} from '@/composables/job-meta'
import {
  INSTANCE_STATUS_META,
  JOB_STATUS_TEXT,
  USER_PLUGIN_STATE_TEXT,
} from '@/composables/useInstanceStatus'

/**
 * 枚举中文文案完整性（WP6 第二轮，编排者反馈「task 状态 pending 没中文化」）。
 *
 * 规则：管理端把**状态/策略/来源/角色/模式**这类枚举展示给用户时，必须走中文映射；
 * 这条测试把「映射是否覆盖 shared 里枚举的全部取值」钉死，新增枚举值时会红。
 */
const CJK = /[\u4e00-\u9fff]/

interface Case {
  label: string
  values: readonly string[]
  map: Record<string, string | undefined>
  /** 允许保留英文的技术枚举（协议名、job type 里的技术后缀等） */
  allowAscii?: boolean
}

const CASES: Case[] = [
  { label: 'job 状态', values: JobStatusSchema.options, map: JOB_STATUS_TEXT },
  { label: 'task 状态', values: JobTaskStatusSchema.options, map: JOB_TASK_STATUS_TEXT },
  {
    label: '实例状态',
    values: InstanceStatusSchema.options,
    map: Object.fromEntries(Object.entries(INSTANCE_STATUS_META).map(([key, meta]) => [key, meta.text])),
  },
  { label: '用户插件同步状态', values: UserPluginStateSchema.options, map: USER_PLUGIN_STATE_TEXT },
  {
    label: '用户插件期望状态',
    values: UserPluginDesiredSchema.options,
    map: { installed: '安装', absent: '不安装' },
  },
  { label: '插件策略', values: PluginPolicySchema.options, map: PLUGIN_POLICY_TEXT },
  { label: '插件来源', values: PluginSourceTypeSchema.options, map: PLUGIN_SOURCE_TEXT },
  { label: '模型密钥模式', values: ModelKeyModeSchema.options, map: KEY_MODE_TEXT },
  {
    label: '模型策略',
    values: ModelPolicySchema.options,
    map: { managed: '管理员统一配置', free: '用户自助' },
  },
  {
    label: 'DSH 版本状态',
    values: RuntimeStatusSchema.options,
    map: { building: '构建中', ready: '就绪', failed: '构建失败', retired: '已下线' },
  },
  {
    label: '用户状态',
    values: UserStatusSchema.options,
    map: { pending: '待审批', active: '正常', disabled: '已停用' },
  },
  { label: '角色', values: RoleSchema.options, map: { user: '普通用户', admin: '管理员' } },
  {
    label: '注册模式',
    values: RegistrationModeSchema.options,
    map: { open: '开放注册', invite: '需要邀请码', closed: '关闭注册' },
  },
  {
    label: '公告级别',
    values: AnnouncementLevelSchema.options,
    map: { info: '信息', success: '成功', warning: '警告', error: '错误' },
  },
  { label: '任务类型', values: Object.keys(JOB_TYPE_TEXT), map: JOB_TYPE_TEXT, allowAscii: true },
  // 色调不是给人看的文案（值就是 token 名），只检查覆盖完整
  {
    label: '任务状态色调',
    values: JobStatusSchema.options,
    map: Object.fromEntries(Object.entries(JOB_STATUS_TONE).map(([key, tone]) => [key, tone])),
    allowAscii: true,
  },
]

describe('管理端枚举中文文案', () => {
  it.each(CASES)('$label：每个取值都有中文文案', ({ values, map, allowAscii }) => {
    const missing = values.filter((value) => !map[value])
    expect(missing, `缺少中文文案：${missing.join('、')}`).toEqual([])

    if (!allowAscii) {
      const ascii = values.filter((value) => map[value] && !CJK.test(map[value] as string))
      expect(ascii, `文案里没有中文：${ascii.join('、')}`).toEqual([])
    }
  })

  it('未知取值不崩、原样返回（后端加新枚举时界面不至于空白）', () => {
    expect(jobTaskStatusText('brand-new')).toBe('brand-new')
    expect(pluginPolicyText('brand-new')).toBe('brand-new')
    expect(pluginSourceText('brand-new')).toBe('brand-new')
    expect(keyModeText('brand-new')).toBe('brand-new')
  })

  it('task 状态与 job 状态是两套文案（pending 必须是「排队中」而不是英文）', () => {
    expect(jobTaskStatusText('pending')).toBe('排队中')
    expect(jobTaskStatusText('skipped')).toBe('已跳过')
    expect(JOB_STATUS_TEXT['queued']).toBe('排队中')
  })
})
