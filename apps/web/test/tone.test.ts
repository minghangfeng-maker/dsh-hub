import { describe, expect, it } from 'vitest'

import { TONE_VARS, naiveTypeOf, type AdminTone } from '@/components/admin/tone'
import { instanceStatusMeta, STATUS_TONE_VARS } from '@/composables/useInstanceStatus'
import { JOB_STATUS_TONE } from '@/composables/job-meta'

/**
 * 蓝白换肤后，「主色」不再等于「正向状态」：正常 / 成功 / 运行中走水绿（--c-success），
 * 主色蓝只留给按钮、链接、选中态。这里守住这条语义边界。
 */
describe('管理端语义色调', () => {
  it('success 色调指向水绿令牌，并映射到 Naive 的 success 类型', () => {
    expect(TONE_VARS.success).toEqual({
      color: 'var(--c-success)',
      soft: 'var(--c-success-soft)',
      ink: 'var(--c-success-ink)',
    })
    expect(naiveTypeOf('success')).toBe('success')
  })

  it('每个色调都有 color / soft / ink 三个令牌引用', () => {
    for (const [tone, vars] of Object.entries(TONE_VARS) as [AdminTone, (typeof TONE_VARS)[AdminTone]][]) {
      for (const value of Object.values(vars)) {
        expect(value, `${tone} 缺令牌`).toMatch(/^var\(--c-[a-z0-9-]+\)$/)
      }
    }
  })

  it('任务「已完成」是成功色，而不是主色', () => {
    expect(JOB_STATUS_TONE.succeeded).toBe('success')
  })

  it('实例「运行中」是水绿，「启动中」是水青蓝，两者不会混成同一种蓝', () => {
    expect(instanceStatusMeta('running').tone).toBe('running')
    expect(STATUS_TONE_VARS.running).toEqual({
      color: 'var(--c-status-running)',
      soft: 'var(--c-success-soft)',
    })
    expect(STATUS_TONE_VARS.progress.color).toBe('var(--c-status-starting)')
  })
})
